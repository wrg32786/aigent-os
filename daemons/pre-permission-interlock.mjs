#!/usr/bin/env node
// pre-permission-interlock.mjs -- the bounded pre-permission interlock (#104).
//
// ONE FILE, TWO CALLERS, ONE IMPLEMENTATION. Run directly it is the
// PreToolUse / PostToolUse / Stop hook; imported it is the library the managed
// runner (daemons/pty-runner.mjs) uses for the same gate and the same state
// file. That is deliberate rather than tidy: a mutual-exclusion protocol with
// two implementations has two chances to disagree about what "held" means, and
// the whole point of this unit is that the two sides cannot both think the
// composer is theirs.
//
// ─── WHY A HOOK AT ALL, WHEN #110 ALREADY READ THE TRANSCRIPT ───────────────
//
// #110 gated every automatic write on "the bound transcript holds a tool_use
// with no matching tool_result". MEASURED on binary 2.1.310 (run 2026-10-24
// 21:07Z, session 529aa897) that signal WAS NOT READABLE while the dialog was
// on screen: the tool_use record occupied bytes 286521-288638 while the file
// was 283263 bytes at all three samples taken during the dialog -- not
// partially written, NOT FLUSHED AT ALL. Readiness answered `ready: true` with
// a real permission prompt up. The 163,968-byte flush carrying both the call
// and its answer landed only after the cancellation. Creation to readability
// was >= 2.44 s (interval 2.436-4.641 s; both ends fenced by the driver's
// 400 ms screen poll). One run in four.
//
// The host's transcript writes are buffered and the flush is unannounced. No
// amount of care in a reader produces a signal that is not on disk. So the
// evidence has to come from somewhere CAUSAL instead of somewhere concurrent,
// and `PreToolUse` is the smallest supported host mechanism that is causal:
// Claude Code runs it, synchronously, BEFORE the permission check, and waits
// for it. A marker written there precedes the dialog rather than racing it.
//
// ─── WHY THIS IS NOT ANOTHER FILE TO POLL ───────────────────────────────────
//
// A second file the runner polls would have the identical defect, one layer
// over: the runner reads "nothing pending", the hook then writes the marker,
// and the runner writes its Enter into the dialog that follows. A check
// followed by a write is not exclusion.
//
// So this is a MUTEX, not a flag. Both sides take the same gate:
//
//   runner:  acquire gate -> read pending -> pty.write(...) -> release gate
//   hook:    acquire gate -> (drain) -> record pending -> release gate -> the
//            host's permission check proceeds
//
// Whichever side holds it first, the other cannot interleave:
//   * hook first  -> the marker is on disk and fsynced before it releases, so
//                    the runner's read inside its own critical section sees it
//                    and the write never happens;
//   * runner first -> pty.write has already RETURNED before the hook can
//                    acquire, and the hook then waits out INTERLOCK_DRAIN_MS
//                    (see below) before letting the permission check start.
//
// There is no interval in which the runner can observe "nothing pending" and
// then have a marker appear before its own write, because the observation and
// the write are inside the same critical section the marker creation needs.
//
// ─── THE DRAIN, AND WHY THE WAIT BELONGS IN THE HOOK ────────────────────────
//
// `pty.write()` returning is not the child having CONSUMED the byte. So the
// runner's write is causally before the marker while the byte may still be in
// flight. The hook is a throwaway process, so a bounded synchronous wait costs
// nothing there and costs the runner nothing at all: holding the gate, the
// hook sleeps out the remainder of INTERLOCK_DRAIN_MS since the runner's last
// write before it records the pending call and returns. The runner cannot
// write during that sleep -- the hook holds the gate.
//
// ─── BOUNDED, AND WHICH WAY THE FALLBACK FAILS ──────────────────────────────
//
// An unbounded hook wait hangs the agent, so every wait here has a budget:
//   * HOOK_GATE_BUDGET_MS to acquire the gate,
//   * INTERLOCK_DRAIN_MS for the drain,
// and the configured hook `timeout` in .claude/settings.json is set well above
// their sum, because a hook the HOST times out is a fail-open (the tool call
// proceeds) and this unit must never rely on that.
//
// THE FALLBACK FAILS CLOSED: if the gate cannot be taken inside the budget,
// PreToolUse returns `permissionDecision: "deny"` with a named reason. The
// tool call does not run, so no dialog appears, so there is nothing for an
// automatic Enter to answer. A denial is recoverable -- the model is told why
// and can retry -- whereas an automatic "Yes, and switch to accept edits ...
// for this session" is not. The same choice is made for an internal error
// AFTER a managed runner has been proven present: at that instant the hook
// cannot mark, so it must not let the check proceed.
//
// A gate nobody released is a liveness hazard in exactly that direction, so it
// is STEALABLE: a holder whose pid is gone, or whose nonce belongs to a
// previous binding, or that is older than GATE_STALE_MS, is renamed away
// (rename(2) / MoveFile -- atomic, measured on both platforms: exactly one of
// four racing stealers wins, the losers get ENOENT) and the gate re-created.
// A legitimate holder never holds for GATE_STALE_MS: the runner's critical
// section is a stat, a small read and a pty write.
//
// ─── NO MANAGED RUNNER MEANS NO OPINION ─────────────────────────────────────
//
// If there is no `proof.json` for this session, no runner is managing this
// seat's composer, so the hook exits 0 and marks nothing. That is not a
// fail-open: the runner's side REQUIRES the proof it writes itself, so absence
// holds automatic writes on one side and silences the hook on the other. The
// two refusals are the same fact seen from both ends.
//
// ─── THE LIVENESS PROOF IS THE WHOLE POINT ──────────────────────────────────
//
// Keying readiness on a marker is only sound if the runner can prove the hook
// is live FOR THE BOUND SESSION. Otherwise "no marker" means both "no tool
// call" and "the hook is not installed", and the second reading is a worse,
// silent fail-open than the gap being closed. `interlockEvidence()` below is
// that proof and it is all-or-nothing: see its header for the four legs and
// the named refusal each one produces.
//
// AIGENT_INTERLOCK=off disables the hook AND makes the runner's side report
// NOT READY (`interlock-disabled`). The switch therefore cannot create a
// fail-open in either direction -- turning it off stops automatic writes, it
// does not permit them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { memRoot as resolveMemoryRoot, readStdin, logErr, inert } from './lifecycle-common.mjs';

// ─── BOUNDS ─────────────────────────────────────────────────────────────────
// Every one of these is a bound on a WAIT or on a FILE SIZE. None of them is a
// timeout after which something unsafe is permitted.
export const INTERLOCK_DIR_NAME = 'interlock';
export const GATE_NAME = 'gate';
export const STATE_NAME = 'state.json';
export const PROOF_NAME = 'proof.json';
// THE DELIBERATE MANUAL RECOVERY. See "No permanent tool outage" below and
// docs/dialog-readiness.md. Not a timer, not an environment default, not
// reachable by `touch`: a file whose content a human has to mean.
// The events this hook handles. Used to validate the argv the template passes,
// so a stray argument cannot masquerade as an event name.
export const INTERLOCK_EVENTS = Object.freeze(new Set(['PreToolUse', 'PostToolUse', 'Stop']));
// ─── EVERY WAY `PreToolUse` CAN DENY ────────────────────────────────────────
// Exported so the enumeration vector derives its rows from the CODE rather than
// from a hand-written table, which is the lesson of its own near-miss: the
// vector asserts a fixed list of no-self-recovery states precisely so that the
// list growing is caught, and the list grew in the same commit that added
// `interlock-state-unreadable` WITHOUT THE VECTOR FIRING -- because a vector
// that only builds the rows its author thought of cannot notice a row its
// author did not. The guarantee it was built to provide was the thing that
// failed. Deriving from here closes that: a new deny code with no row is now a
// test failure.
//
// Grouped by where the denial comes from, because the recovery differs:
//   gate      the mutex could not be taken
//   state     the state file could not be read or written
//   session   the call could not be attributed to a managed session
//   internal  the hook itself threw
export const PRE_TOOL_USE_DENY_CODES = Object.freeze({
  gate: Object.freeze([
    // `interlock-gate-no-dir` is deliberately absent: `dir` is validated before
    // acquireGate is ever called, so acquireGate cannot return it from here.
    'interlock-gate-dir-failed',
    'interlock-gate-open-failed',
    'interlock-gate-path-unusable',
    'interlock-gate-busy',
  ]),
  state: Object.freeze([
    'interlock-state-unreadable',
    'interlock-state-write-failed',
    'interlock-pending-overflow',
  ]),
  session: Object.freeze([
    'interlock-no-session-id',
    // `interlock-dir-unresolved` is deliberately absent, and working that out
    // was worth the vector that tried to build it: to DENY, `anyManagedSession`
    // has to be true, which requires a resolvable interlock root -- and with a
    // resolvable root `sessionDir` returns null only for a session id that
    // `SESSION_ID_OK` has already rejected one line earlier. So that code is
    // reachable as INERT and never as a denial.
  ]),
  internal: Object.freeze([
    'interlock-hook-threw',
  ]),
});
export const ALL_PRE_TOOL_USE_DENY_CODES = Object.freeze(
  Object.values(PRE_TOOL_USE_DENY_CODES).flat(),
);
export const RELEASE_NAME = 'interlock-release.json';
export const RELEASE_LITERAL = 'manual';
// Named in EVERY denial, so the deliberate path is in front of the operator on
// the call they are being denied rather than only in a document they would
// have to know to go and read.
export const RECOVERY_HINT = 'stop the managed runner, or run: '
  + 'node <AIGENT_ROOT>/daemons/pre-permission-interlock.mjs --release <session-id> "<reason>" '
  + '-- which keeps automatic runner input DISABLED and permission prompting intact';
// How long the HOOK may wait for the gate before denying the tool call. The
// runner's critical section is a stat, a bounded small read and one pty write,
// so this is three orders of magnitude of headroom over the contended case; it
// is sized for a loaded host (this seat carries ~130 node processes at steady
// state), not for the mechanism.
export const HOOK_GATE_BUDGET_MS = 1200;
// Sleep between gate attempts. Atomics.wait, not a spin: a busy loop in a hook
// competes with the very child process it is blocking.
export const GATE_SLEEP_MS = 5;
// When a gate may be STOLEN on age alone. A legitimate holder cannot reach it.
export const GATE_STALE_MS = 5000;
// How long the hook waits out a pty write that may still be in flight to the
// child. See "THE DRAIN" above.
export const INTERLOCK_DRAIN_MS = 120;
// The runner never WAITS on the gate -- a gate held by a hook means a
// permission check is starting, and deferring is the right answer, not
// blocking the runner's event loop. It does take two attempts, because the
// first may be spent stealing a dead holder's gate.
export const RUNNER_GATE_ATTEMPTS = 2;
// A cap on the pending map so a pathological session cannot grow the state
// file without bound. Hitting it is itself a named refusal, never a discard:
// dropping a pending call is the fail-open this file exists to prevent.
export const PENDING_MAX = 64;
// Leg 4 matches by id: the ids of the most recent PreToolUse runs, main loop
// and subagents alike, oldest dropped first. An id can only ever pay for the
// record with the same id. A record whose run fell off the end is unpaid and
// is forgiven only on positive evidence (see interlockEvidence).
export const RECENT_IDS_MAX = 512;
// Session directories older than this are swept when a new one is created.
export const SESSION_DIR_TTL_MS = 6 * 60 * 60 * 1000;
export const SESSION_DIR_SWEEP_MAX = 32;
// Session ids are uuids. Anything else does not get to name a directory.
const SESSION_ID_OK = /^[A-Za-z0-9._-]{1,128}$/;
const TOOL_USE_ID_OK = /^[A-Za-z0-9._:-]{1,200}$/;

export function interlockEnabled(env = process.env) {
  const value = String(env.AIGENT_INTERLOCK ?? '').trim().toLowerCase();
  return !(value === 'off' || value === '0' || value === 'false' || value === 'no');
}

// ─── WHERE THE STATE LIVES ──────────────────────────────────────────────────
// Under the memory root both sides already resolve the same way, beside the
// boot receipt the runner reads every tick. AIGENT_INTERLOCK_DIR is an
// explicit override honoured by BOTH sides, so a test or an operator can pin
// the path rather than depend on two independent root resolutions agreeing.
export function interlockRoot({ memRoot, env = process.env } = {}) {
  const pinned = typeof env.AIGENT_INTERLOCK_DIR === 'string' && env.AIGENT_INTERLOCK_DIR.length > 0
    ? env.AIGENT_INTERLOCK_DIR
    : null;
  if (pinned) return path.resolve(pinned);
  if (typeof memRoot !== 'string' || memRoot.length === 0) return null;
  return path.join(memRoot, 'runtime', INTERLOCK_DIR_NAME);
}

export function sessionDir({ memRoot, sessionId, env = process.env } = {}) {
  const root = interlockRoot({ memRoot, env });
  if (root === null) return null;
  if (typeof sessionId !== 'string' || !SESSION_ID_OK.test(sessionId)) return null;
  return path.join(root, sessionId);
}

function sleepMs(milliseconds) {
  if (!(milliseconds > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // SharedArrayBuffer unavailable: a bounded busy wait is still bounded.
    const until = Date.now() + milliseconds;
    while (Date.now() < until) { /* bounded */ }
  }
}

function pidAlive(pid, processLike = process) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { processLike.kill(pid, 0); return true; } catch (error) {
    // EPERM means a live process this user may not signal -- alive, not gone.
    return error?.code === 'EPERM';
  }
}

// ─── THE GATE ───────────────────────────────────────────────────────────────
// O_CREAT|O_EXCL on a plain file. Measured exclusive on win32 (second open
// EEXIST) and it is POSIX-guaranteed; the file's EXISTENCE is the lock, so the
// descriptor is closed immediately and nothing depends on holding it open.
//
// A path that is a DIRECTORY also answers EEXIST, which would read as "held"
// for ever. #110 lost a day to `statSync(dir).size` differing by platform, so
// that case is named here rather than left to look like contention.
function gateHolder(gatePath, fsImpl) {
  let raw;
  try { raw = fsImpl.readFileSync(gatePath, 'utf8'); } catch (error) {
    if (error?.code === 'EISDIR' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      return { kind: 'unusable', code: error.code };
    }
    if (error?.code === 'ENOENT') return { kind: 'gone' };
    // ANY OTHER ERRNO IS "CANNOT SAY", NOT "NOBODY HOLDS IT". This was the
    // document's own substitution -- cannot see, therefore nothing there --
    // applied to the gate instead of the transcript: a single EMFILE on a host
    // carrying 150 node processes stole a LIVE gate, so both sides then believed
    // they owned the composer. Measured, not theorised.
    return { kind: 'unreadable', code: error?.code ?? null };
  }
  let record;
  try { record = JSON.parse(raw); } catch { record = null; }
  if (!record || typeof record !== 'object') {
    // NOT "unheld". `openSync(..., 'wx')` creates the file and the stamp is
    // written immediately after, so an empty or half-written gate is the
    // ordinary state of a gate somebody has JUST taken. Treating it as free is
    // how two acquirers both succeeded. It is only stealable on the file's own
    // mtime (see stealable), which is a timestamp that does not depend on the
    // content being readable.
    let mtimeMs = null;
    try { mtimeMs = fsImpl.statSync(gatePath).mtimeMs; } catch { mtimeMs = null; }
    return { kind: 'unstamped', mtimeMs };
  }
  return { kind: 'held', record };
}

function stealable(holder, { nonce, now, processLike }) {
  if (holder.kind === 'gone') return true;
  // CANNOT SAY: never stealable. A transient read error is not evidence that
  // the holder is gone, and acting on it breaks the exclusion for a process
  // that is legitimately mid-write. The caller's bounded budget then expires
  // and PreToolUse denies, which is the safe direction.
  if (holder.kind === 'unreadable') return false;
  if (holder.kind === 'unusable') return false;
  // A gate taken but not yet stamped. Stealable only once its own mtime is
  // older than any acquisition could take -- the window between `openSync` and
  // `writeFileSync` is microseconds, so GATE_STALE_MS is enormous headroom,
  // and a genuinely corrupt gate still becomes recoverable rather than wedging
  // the session for ever.
  if (holder.kind === 'unstamped') {
    return Number.isFinite(holder.mtimeMs) && (now - holder.mtimeMs) > GATE_STALE_MS;
  }
  const record = holder.record;
  // A gate stamped with a DIFFERENT binding's nonce cannot be protecting
  // anything in this one: its session is over.
  if (typeof nonce === 'string' && nonce.length > 0
    && typeof record.nonce === 'string' && record.nonce !== nonce) return true;
  if (!pidAlive(record.pid, processLike)) return true;
  const ts = Number(record.ts);
  return Number.isFinite(ts) && (now - ts) > GATE_STALE_MS;
}

// Rename-away, then re-create. The rename is the atomic step: exactly one of N
// concurrent stealers can move the same source (measured 20/20 rounds with 4
// racers on win32, losers ENOENT), so two stealers cannot both believe they
// took it.
function stealGate(gatePath, fsImpl, pid, now) {
  const aside = `${gatePath}.stolen-${pid}-${now}-${Math.floor(Math.random() * 1e6)}`;
  try { fsImpl.renameSync(gatePath, aside); } catch { return false; }
  try { fsImpl.unlinkSync(aside); } catch { /* the steal already succeeded */ }
  return true;
}

/**
 * Take the gate, or say exactly why not.
 *
 * `budgetMs: 0` (the runner) never sleeps: one attempt, one steal, one more
 * attempt. A hook passes HOOK_GATE_BUDGET_MS and waits.
 *
 * Returns {ok:true, handle} or {ok:false, code, detail}. `handle` must be
 * passed to releaseGate on EVERY exit path -- a leaked gate denies this
 * session's tool calls until it goes stale.
 */
export function acquireGate({
  dir,
  side,
  nonce = null,
  budgetMs = 0,
  fsImpl = fs,
  now = () => Date.now(),
  processLike = process,
  pid = process.pid,
  sleep = sleepMs,
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-gate-no-dir', detail: null };
  }
  const gatePath = path.join(dir, GATE_NAME);
  try { fsImpl.mkdirSync(dir, { recursive: true }); } catch (error) {
    return { ok: false, code: 'interlock-gate-dir-failed', detail: error?.code ?? String(error) };
  }
  const deadline = now() + Math.max(0, budgetMs);
  // TWO INDEPENDENT BOUNDS, and the second one is not belt-and-braces. "No
  // unbounded hook wait" must not be contingent on the clock advancing: a
  // frozen or non-monotonic clock would make the deadline unreachable and the
  // loop infinite, which is the agent hanging on a hook. An attempt ceiling
  // holds whatever the clock does. (Found by a vector that injected a constant
  // clock -- it looped instead of denying.)
  const attemptCeiling = Math.max(
    RUNNER_GATE_ATTEMPTS,
    Math.ceil(Math.max(0, budgetMs) / GATE_SLEEP_MS) + 2,
  );
  let stole = false;
  let attempts = 0;
  let lastCode = null;
  for (;;) {
    attempts += 1;
    const stamp = {
      side: String(side ?? 'unknown'),
      pid,
      ts: now(),
      nonce: nonce ?? null,
      token: crypto.randomUUID(),
    };
    let fd = null;
    try {
      fd = fsImpl.openSync(gatePath, 'wx');
      fsImpl.writeFileSync(fd, JSON.stringify(stamp));
      try { fsImpl.fsyncSync(fd); } catch { /* content is advisory; existence is the lock */ }
      fsImpl.closeSync(fd);
      return { ok: true, handle: { gatePath, token: stamp.token, fsImpl, dir }, attempts };
    } catch (error) {
      if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
      if (error?.code !== 'EEXIST') {
        return { ok: false, code: 'interlock-gate-open-failed', detail: error?.code ?? String(error) };
      }
    }
    const holder = gateHolder(gatePath, fsImpl);
    if (holder.kind === 'unusable') {
      // The gate path is a directory, or unreadable by this user. This is NOT
      // contention and waiting cannot fix it.
      return { ok: false, code: 'interlock-gate-path-unusable', detail: holder.code ?? null };
    }
    if (!stole && stealable(holder, { nonce, now: now(), processLike })) {
      stole = true;
      if (stealGate(gatePath, fsImpl, pid, now())) continue;
    }
    lastCode = holder.kind === 'held' ? 'held' : holder.kind;
    if (attempts >= RUNNER_GATE_ATTEMPTS && budgetMs <= 0) break;
    if (attempts >= attemptCeiling) break;
    if (now() >= deadline) break;
    sleep(Math.min(GATE_SLEEP_MS, Math.max(1, deadline - now())));
  }
  return {
    ok: false,
    code: 'interlock-gate-busy',
    detail: { attempts, holder: lastCode, budget_ms: budgetMs },
  };
}

/**
 * Release the gate, and SAY whether it was still ours.
 *
 * ONLY A POSITIVELY CONFIRMED OWN TOKEN IS UNLINKED. The previous rule
 * protected only the `held` kind, so every other kind -- a gate another party
 * had just created and not yet stamped, or one that momentarily would not read
 * -- fell through to the unlink and A RELEASE DELETED SOMEBODY ELSE'S GATE,
 * which is the exclusion broken from the other end. Measured.
 *
 * The return value is the one signal available for "I lost ownership", and the
 * runner acts on it: see _releaseInterlockGate.
 */
export function releaseGate(handle) {
  if (!handle || typeof handle.gatePath !== 'string') return false;
  const fsImpl = handle.fsImpl ?? fs;
  const holder = gateHolder(handle.gatePath, fsImpl);
  if (holder.kind !== 'held' || holder.record?.token !== handle.token) return false;
  try { fsImpl.unlinkSync(handle.gatePath); return true; } catch { return false; }
}

/**
 * Is the gate on disk still the one this handle took?
 *
 * The in-memory handle is not the invariant -- the invariant is a file another
 * process can steal, and it CAN be stolen from a live, legitimate holder (a
 * forward wall-clock step defeats every age bound there is). So any span that
 * assumed "nothing can have changed because I hold the gate" has to ask the
 * disk instead. Re-verifying is not a second chance to be wrong when the thing
 * being verified belongs to somebody else.
 */
export function gateStillHeld(handle) {
  if (!handle || typeof handle.gatePath !== 'string') return false;
  const holder = gateHolder(handle.gatePath, handle.fsImpl ?? fs);
  return holder.kind === 'held' && holder.record?.token === handle.token;
}

// ─── THE STATE FILE ─────────────────────────────────────────────────────────
// Written only under the gate, by either side. Shape:
//   { nonce, pre_runs, post_runs, stop_runs, recent_ids, last_event,
//     last_event_at, last_write_at, pending: { <tool_use_id>: {tool, ts, transcript_size} } }
//
// recent_ids: the ids of the last RECENT_IDS_MAX PreToolUse runs, oldest first
// (leg 4 matches records to runs by id).
//
// Replaced through a temp file plus rename so a torn file is impossible; a
// state file that will not parse is a NAMED refusal on the runner's side, not
// an empty pending map.
export function emptyState(nonce) {
  return {
    nonce: nonce ?? null,
    pre_runs: 0,
    post_runs: 0,
    stop_runs: 0,
    recent_ids: [],
    last_event: null,
    last_event_at: null,
    last_write_at: null,
    pending: {},
  };
}

export function readState({ dir, fsImpl = fs } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-state-no-dir', state: null };
  }
  let raw;
  try { raw = fsImpl.readFileSync(path.join(dir, STATE_NAME), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'interlock-state-missing', state: null };
    return { ok: false, code: 'interlock-state-unreadable', state: null, detail: error?.code ?? null };
  }
  let record;
  try { record = JSON.parse(raw); } catch {
    return { ok: false, code: 'interlock-state-unreadable', state: null, detail: 'parse' };
  }
  if (!record || typeof record !== 'object' || record.pending === null
    || typeof record.pending !== 'object' || Array.isArray(record.pending)) {
    return { ok: false, code: 'interlock-state-unreadable', state: null, detail: 'shape' };
  }
  return { ok: true, code: null, state: record };
}

export function writeState({ dir, state, fsImpl = fs, pid = process.pid } = {}) {
  const target = path.join(dir, STATE_NAME);
  const temp = `${target}.tmp-${pid}-${Math.floor(Math.random() * 1e9)}`;
  try {
    const fd = fsImpl.openSync(temp, 'w');
    fsImpl.writeFileSync(fd, JSON.stringify(state));
    try { fsImpl.fsyncSync(fd); } catch { /* best effort */ }
    fsImpl.closeSync(fd);
    fsImpl.renameSync(temp, target);
    return { ok: true, code: null };
  } catch (error) {
    try { fsImpl.unlinkSync(temp); } catch { /* ignore */ }
    return { ok: false, code: 'interlock-state-write-failed', detail: error?.code ?? String(error) };
  }
}

export function readProof({ dir, fsImpl = fs } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-proof-no-dir', proof: null };
  }
  let raw;
  try { raw = fsImpl.readFileSync(path.join(dir, PROOF_NAME), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'interlock-proof-missing', proof: null };
    return { ok: false, code: 'interlock-proof-unreadable', proof: null, detail: error?.code ?? null };
  }
  let record;
  try { record = JSON.parse(raw); } catch {
    return { ok: false, code: 'interlock-proof-unreadable', proof: null, detail: 'parse' };
  }
  if (!record || typeof record !== 'object' || typeof record.nonce !== 'string'
    || record.nonce.length === 0) {
    return { ok: false, code: 'interlock-proof-unreadable', proof: null, detail: 'shape' };
  }
  return { ok: true, code: null, proof: record };
}

export function writeProof({ dir, proof, fsImpl = fs, pid = process.pid } = {}) {
  try { fsImpl.mkdirSync(dir, { recursive: true }); } catch (error) {
    return { ok: false, code: 'interlock-proof-dir-failed', detail: error?.code ?? String(error) };
  }
  const target = path.join(dir, PROOF_NAME);
  const temp = `${target}.tmp-${pid}-${Math.floor(Math.random() * 1e9)}`;
  try {
    const fd = fsImpl.openSync(temp, 'w');
    fsImpl.writeFileSync(fd, JSON.stringify(proof));
    try { fsImpl.fsyncSync(fd); } catch { /* best effort */ }
    fsImpl.closeSync(fd);
    fsImpl.renameSync(temp, target);
    return { ok: true, code: null };
  } catch (error) {
    try { fsImpl.unlinkSync(temp); } catch { /* ignore */ }
    return { ok: false, code: 'interlock-proof-write-failed', detail: error?.code ?? String(error) };
  }
}

// Old bindings' directories. Bounded both in age and in how many one pass may
// remove, so a sweep can never become the expensive thing on a tick.
export function sweepSessionDirs({ memRoot, keepSessionId, fsImpl = fs, env = process.env, now = Date.now() } = {}) {
  const root = interlockRoot({ memRoot, env });
  if (root === null) return 0;
  let entries;
  try { entries = fsImpl.readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const name of entries) {
    if (removed >= SESSION_DIR_SWEEP_MAX) break;
    if (name === keepSessionId) continue;
    const dir = path.join(root, name);
    let stat;
    try { stat = fsImpl.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if ((now - stat.mtimeMs) <= SESSION_DIR_TTL_MS) continue;
    try { fsImpl.rmSync(dir, { recursive: true, force: true }); removed += 1; } catch { /* next pass */ }
  }
  return removed;
}

// ─── NO PERMANENT TOOL OUTAGE ───────────────────────────────────────────────
//
// The interlock DENIES tool calls when it cannot establish safe ownership, and
// that is the correct direction -- but a denial that no human can lift is a
// permanent tool outage, which is not a trade anyone agreed to. The reachable
// deny states were ENUMERATED against this file rather than reasoned about,
// and five of them had no recovery at all:
//
//   state                                              self-clears?
//   T1  gate busy, live holder, young (runner mid-write) yes, the holder releases (microseconds)
//   T2  gate busy, holder pid dead                       yes, pid-liveness steal, immediate
//   T3  gate busy, holder nonce from a past binding       yes, nonce steal, immediate
//   T4  gate busy, pid recycled to a live process         yes, age steal after GATE_STALE_MS
//   T5  gate busy, live holder, `ts` not a number         NO -- the age clause needs a finite ts
//   T6  gate busy, clock behind the gate stamp            NO -- now-ts is negative for ever
//   T7  gate path is a DIRECTORY                          NO -- stealable() refuses it by design
//   T8  gate not creatable (EROFS/EACCES)                 NO -- no code fixes a filesystem
//   T9  state not writable (EROFS/EACCES)                 NO -- same
//   T10 pending map at PENDING_MAX                        yes, the turn's Stop sweeps
//
// T5/T6 are the mirror of the age clause doing its job: it is deliberately not
// a "give up and allow" timer, so anything that puts the age comparison out of
// action removes the only self-recovery the gate has. T7 is refused on purpose
// -- a directory at the gate path is not contention and waiting cannot fix it.
// T8/T9 are the filesystem, which this code does not get to repair.
//
// TWO MANUAL PATHS, and each covers what the other cannot:
//
// (1) STOP THE MANAGED RUNNER. A proof whose `runner_pid` is no longer alive
//     means there is no managed runner, so the hook goes INERT and tool calls
//     proceed. This is the only recovery that needs NO WRITE AT ALL, which is
//     what makes it the answer to T8 and T9 -- a human cannot write a release
//     file onto a read-only filesystem.
//
//     IS THAT AN AUTOMATIC SELF-CLEAR? No, and the distinction is the whole
//     point. It is not time-based, and its trigger is not "the protection has
//     been inconvenient for long enough" -- it is "the writer this protects
//     against does not exist". The interlock exists to stop the RUNNER putting
//     an automatic keystroke into a permission dialog. A runner that is gone
//     writes nothing, so there is nothing left to protect and the denial has no
//     subject. Permission checking is untouched either way: the host prompts
//     exactly as it would with no interlock installed.
//
//     ITS HONEST LIMIT: pid recycling. If the runner's pid has been reissued to
//     another live process, this reads "alive" and the hook stays armed. So
//     this is not the guaranteed path -- (2) is.
//
// (2) THE MANUAL RELEASE. A human writes RELEASE_NAME into the session's
//     interlock directory, with content they have to mean (see
//     `manualRelease`). From then on, for that binding:
//
//       * the HOOK stops denying and stops marking. It takes no gate, writes
//         nothing, and expresses NO permission opinion -- the call goes to the
//         host's own permission check and the dialog appears and is answered by
//         the human, exactly as without the interlock;
//       * the RUNNER refuses every automatic write, by name, and that refusal
//         is LATCHED: deleting the release file does not re-enable automation,
//         because a release is a decision about the binding and not a toggle.
//         Only a new binding (a restart or a post-clear rebind, both deliberate
//         human acts, each with a new session id and so a new directory) starts
//         over.
//
//     WHY THIS IS NOT THE SILENT FALLBACK THE OWNER REFUSED. The protection is
//     not disabled, it is made UNNECESSARY: the hazard is an automatic
//     keystroke, and after a release there are no automatic keystrokes. The
//     release trades automation for availability, explicitly, in writing, with
//     the operator's own reason recorded. It cannot be reached by accident (a
//     bare `touch` is not a release, nor is a file from another session), it
//     cannot be an environment default (it is a file in a session-scoped
//     directory, not a variable), and both sides name it in the log.
//
// A malformed release is NOT a release. It keeps denying -- the safe direction
// -- and says `interlock-release-malformed` rather than being ignored, because
// a half-written file that silently did nothing would leave an operator
// believing they had recovered.

/**
 * The operator's deliberate release for this session, or null.
 *
 * Every field is required and checked, so none of these is a release: an empty
 * file; `touch`; a file copied from another seat (the session id is bound);
 * a file with no reason (the reason is the record of WHY automation was given
 * up, and a release without one is not auditable).
 *
 * Returns {ok:true, release} | {ok:false, code} | null when there is no file.
 */
export function manualRelease({ dir, sessionId, fsImpl = fs } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  let raw;
  try { raw = fsImpl.readFileSync(path.join(dir, RELEASE_NAME), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // A release file that exists and cannot be read is NOT a release, and not
    // nothing either: an operator who wrote one needs to know it did not take.
    return { ok: false, code: 'interlock-release-unreadable', detail: error?.code ?? null };
  }
  let record;
  try { record = JSON.parse(raw); } catch {
    return { ok: false, code: 'interlock-release-malformed', detail: 'parse' };
  }
  if (!record || typeof record !== 'object') {
    return { ok: false, code: 'interlock-release-malformed', detail: 'shape' };
  }
  if (record.release !== RELEASE_LITERAL) {
    return { ok: false, code: 'interlock-release-malformed', detail: 'release' };
  }
  if (typeof record.session_id !== 'string' || record.session_id !== sessionId) {
    // A release is scoped to the binding it was written for. One left behind by
    // a previous session, or copied from another seat, releases nothing.
    return { ok: false, code: 'interlock-release-foreign-session', detail: null };
  }
  if (typeof record.reason !== 'string' || record.reason.trim().length === 0) {
    return { ok: false, code: 'interlock-release-malformed', detail: 'reason' };
  }
  return { ok: true, code: null, release: record };
}

// ─── THE LIVENESS PROOF ─────────────────────────────────────────────────────
// FOUR LEGS, ALL REQUIRED. Each one answers a different way the interlock
// could be absent while looking like "no tool call is pending", and each has
// its own refusal name so the log says which:
//
//   1. BOUND      proof.json exists for THIS session dir and its nonce, session
//                 id and runner pid match the binding in memory. A proof from a
//                 previous binding is stale, not evidence.
//                 -> interlock-proof-missing / -unreadable / -mismatch
//   2. INSTALLED  the hook file is where the proof recorded it and its sha256
//                 still matches. An edited or replaced hook voids the proof.
//                 -> interlock-hook-missing / -changed
//   3. OBSERVED   the HOST has run the hook at least once for this nonce. This
//                 is the strong leg and the only one that is empirical: it is
//                 direct evidence that this binary, with this configuration,
//                 invokes this file for this session. Any of PreToolUse,
//                 PostToolUse or Stop counts -- Stop fires at the end of every
//                 assistant turn, measured, so a session that has had a turn
//                 satisfies it even with no tool call in it.
//                 -> interlock-hook-not-observed
//   4. CURRENT    the hook has seen every tool call the transcript reader has,
//                 BY ID. Every tool_use the reader parsed since the last
//                 agreement point must be in the hook's recent_ids: the hook ran
//                 for THAT call. This is POSITIVE DETECTION OF A DEAD HOOK rather
//                 than a timeout: if the configuration is changed mid-session, or
//                 the hook starts failing, the next tool call has no run with its
//                 id and the gate closes. Idle time proves nothing and is
//                 deliberately NOT used -- a quiet session makes no tool calls, so
//                 an idle-staleness rule would hold automation on a healthy seat
//                 and would be a liveness bug dressed as a safety check.
//                 -> interlock-hook-missed-tool-calls
//
//                 BY ID, NOT BY COUNT (2026-11-13). Counts let one call's run
//                 stand for another call's record. The hook runs BEFORE its
//                 record reaches the transcript (flush lag >= 2.44 s), so an
//                 agreement point taken in that gap swallowed the run, and the
//                 record arrived owed with nothing to pay it: a seat idle after
//                 its capsule held its clear for eight hours (measured). A count
//                 carried forward instead fails open (a run whose record the
//                 reader never counts pays for a later call with no run), and a
//                 record with no run at all spends another call's run. Matching
//                 on the id closes all three: a run pays for its own record and
//                 nothing else, whenever that record is read.
//
//                 The ids are those parsed since the agreement point. The point
//                 is discarded on every re-baseline (see the runner's
//                 _noteToolCallWatch): after a re-baseline the reader has re-read
//                 history whose calls the hook may have handled before the state
//                 file existed, so those ids are absorbed rather than charged.
//                 That is not a hole: a re-baseline also raises `unknownOpen`,
//                 which holds every automatic write until an anchor discharges
//                 it, so the two legs cover each other. A run made before the
//                 re-baseline still pays for its record if that record is read
//                 afterwards, because recent_ids outlives the agreement point.
//
// WHAT IS NOT A LEG, AND WHY. A runner-side probe (spawn the hook with a
// synthetic payload and check it stamps) was considered and dropped: it proves
// the FILE works when the RUNNER runs it, which leg 3 already subsumes with
// better evidence (the HOST ran it), and it would cost a subprocess per bind on
// a host that carries ~130 node processes at steady state. Earlier diagnosis
// was the only thing it bought.
//
// Then, and only then, the pending map must be empty. An expired pending entry
// is NOT released on age: a human may be looking at that dialog for minutes,
// and age cannot tell that from an orphan. See `pendingProblem`.
export function interlockEvidence({
  dir,
  nonce,
  sessionId,
  runnerPid,
  hookPath,
  hookSha256,
  toolUsesObserved = 0,
  // The ids of the tool_use records the reader has parsed since `checkpoint`.
  toolUseIdsSince = [],
  checkpoint = null,
  fsImpl = fs,
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, code: 'interlock-dir-unresolved', detail: null };
  }
  const proofRead = readProof({ dir, fsImpl });
  if (!proofRead.ok) {
    return { ok: false, code: proofRead.code, detail: proofRead.detail ?? null };
  }
  const proof = proofRead.proof;
  const mismatch = [];
  if (proof.nonce !== nonce) mismatch.push('nonce');
  if (proof.session_id !== sessionId) mismatch.push('session_id');
  if (proof.runner_pid !== runnerPid) mismatch.push('runner_pid');
  if (mismatch.length > 0) {
    return { ok: false, code: 'interlock-proof-mismatch', detail: { fields: mismatch } };
  }
  // Leg 2. The hook the proof was written about must still be that file.
  let digest = null;
  try {
    digest = crypto.createHash('sha256').update(fsImpl.readFileSync(hookPath)).digest('hex');
  } catch (error) {
    return {
      ok: false,
      code: 'interlock-hook-missing',
      detail: { path: hookPath, error: error?.code ?? null },
    };
  }
  if (digest !== hookSha256) {
    return { ok: false, code: 'interlock-hook-changed', detail: { path: hookPath } };
  }
  const stateRead = readState({ dir, fsImpl });
  if (!stateRead.ok) {
    return { ok: false, code: stateRead.code, detail: stateRead.detail ?? null };
  }
  const state = stateRead.state;
  if (state.nonce !== nonce) {
    return { ok: false, code: 'interlock-state-stale', detail: { nonce: inert(String(state.nonce), 80) } };
  }
  const pre = Number(state.pre_runs) || 0;
  const post = Number(state.post_runs) || 0;
  const stop = Number(state.stop_runs) || 0;
  // ─── LEG 3 ────────────────────────────────────────────────────────────────
  // `pre + post + stop >= 1` was too weak, and the weakness was the exact
  // shape this unit exists to prevent: `stop_runs` alone proves the FILE runs,
  // not that `PreToolUse` is wired -- and PreToolUse is the only invocation
  // that protects anything. Combined with a settings file edited mid-session,
  // legs 1/2/3 would all still pass on a Stop from before the unwiring, and
  // leg 4's detector reads from transcript BYTES whose flush lag was measured
  // at >= 2.44 s with the record absent for an entire dialog -- so for the
  // first dialog after a PreToolUse outage both mechanisms would be blind at
  // once, which is the one combination the two-mechanism design exists to
  // exclude.
  //
  // So PreToolUse must have been seen -- UNLESS the session has provably made
  // no tool calls at all, in which case there was nothing for it to be invoked
  // for and a Stop is the only evidence obtainable. `toolUsesObserved === 0` is
  // that proof, and it is the reader's own count rather than an assumption.
  // Without the exception a seat that reached pressure on one pasted document
  // would hold automation for ever, which is the liveness bug the old rule was
  // avoiding.
  const observedNoToolCalls = (Number(toolUsesObserved) || 0) === 0;
  if (pre < 1 && !(observedNoToolCalls && post + stop >= 1)) {
    return {
      ok: false,
      code: 'interlock-hook-not-observed',
      detail: { pre_runs: pre, post_runs: post, stop_runs: stop, tool_uses_observed: Number(toolUsesObserved) || 0 },
    };
  }
  // Leg 4, by id; see the header. With no agreement point yet (a fresh binding,
  // a re-baseline) the parsed ids are history and are absorbed, not charged.
  const parsed = checkpoint === null || !Array.isArray(toolUseIdsSince) ? [] : toolUseIdsSince;
  const ran = Math.max(0, pre - (checkpoint === null ? pre : Number(checkpoint.preRuns) || 0));
  const recent = new Set(Array.isArray(state.recent_ids) ? state.recent_ids : []);
  const owed = parsed.length;
  const unpaid = parsed.filter((id) => !recent.has(id)).length;
  if (unpaid > 0) {
    // ─── THE DEFICIT MUST NOT BE PERMANENT ────────────────────────────────
    // A cumulative delta that only ever re-anchors on a PASS made one missed
    // increment unforgivable: five consecutive healthy calls still refused, so
    // the seat never auto-cleared at pressure again -- a permanent automation
    // outage recoverable only by restart. Measured. Counting denials as
    // invocations removes most causes; a host timeout on the hook, or a crash
    // mid-invocation, can still drop one.
    //
    // THE FORGIVENESS IS POSITIVE EVIDENCE, NOT A TIMER. Leg 4 exists to catch
    // a DEAD hook. If `pre_runs` has advanced since the agreement point, the
    // hook is demonstrably alive, so an unpaid record is a call it did not
    // count (a host timeout on the hook, a crash mid-invocation, a call that
    // failed validation before PreToolUse, a gate-busy denial), not death:
    // re-anchor and pass, loudly. If `pre_runs` has NOT advanced while the
    // reader keeps parsing calls with no run behind them, the hook is dead and
    // this refuses for as long as that stays true. Nothing here is time-based
    // and nothing gives up and allows. A forgiven record is forgiven alone: the
    // run that proved the hook alive still pays only for its own record.
    if (ran > 0) {
      return {
        ok: true,
        code: null,
        detail: null,
        state,
        nextCheckpoint: { preRuns: pre },
        // The caller logs this: a forgiven deficit is a real event and must not
        // be silent, even though it resolves in the permissive direction.
        forgaveDeficit: { hook_runs_since: ran, tool_uses_since: owed, unpaid },
      };
    }
    return {
      ok: false,
      code: 'interlock-hook-missed-tool-calls',
      detail: { hook_runs_since: ran, tool_uses_since: owed, unpaid },
    };
  }
  return {
    ok: true,
    code: null,
    detail: null,
    state,
    // The caller stores this and passes it back, and clears its parsed ids, so
    // the next comparison starts from the fact that these two agreed here.
    nextCheckpoint: { preRuns: pre },
  };
}

// A pending map that is not empty, or that cannot be trusted to be complete.
// AGE NEVER RELEASES. A marker older than any bound still means a permission
// check was started and not seen to finish; a human may be reading that dialog.
// The honest answer is a differently NAMED hold, so the operator can tell "a
// dialog is up" from "something was never cleared", and both hold.
//
// ─── `settled` AND WHY IT WAS ADDED AFTER A HOST RUN ────────────────────────
// The clearing paths started as PostToolUse (an allowed call) plus the turn's
// Stop sweep (everything else). MEASURED on binary 2.1.310 (2026-10-25 run 3,
// session ee986519) that was not enough: an ESC-CANCELLED turn produced NO
// Stop hook invocation at all. `stop_runs` stayed at 1 from before the dialog,
// through the cancellation, and through the whole of the NEXT turn's tool call,
// reaching 2 only when that later turn ended -- so the marker was held for 48 s
// (17:09:50 to 17:10:38) with no dialog on screen, and an operator who simply
// walked away would have held automation indefinitely. Fail-closed, but a real
// liveness cost and the exact recovery case this work has to get right.
//
// The fix reuses the evidence the runner already has. The marker is keyed by
// the host's own `tool_use_id`, and the #110 reader pairs on that same id; a
// `tool_result` is written whichever way the dialog is answered -- approval,
// cancellation or error (measured in #110). So an id the reader has seen
// SETTLED is positive evidence that its permission check is over, and the
// marker for it is discounted.
//
// The direction is the safe one. Buffered transcript writes only make this
// clear LATER, never earlier, so the failure mode of the thing that bit #110 is
// a longer hold here rather than a release. And it is still the ID that
// releases: one result settles its own call and no other, exactly as in the
// transcript reader.
//
// An `anon:` marker (a call the host gave no usable id for) can never be
// settled this way, so only a Stop sweep clears it. That is deliberate -- a
// call that cannot be named is a call that cannot be paired.
export function pendingProblem(state, { now = Date.now(), staleMs = 120000, settled = null } = {}) {
  const all = Object.keys(state?.pending ?? {});
  const ids = settled === null ? all : all.filter((id) => !settled.has(id));
  if (ids.length === 0) return null;
  // NOTE on the discount vs a real clearing: the discount below is a READ-side
  // filter, and the runner also DELETES these ids from the file whenever it
  // holds the gate (see _pruneSettledMarkers). The filter is what makes the
  // verdict correct immediately; the deletion is what stops the verdict
  // depending on a bounded FIFO that empties on re-baseline.
  // `> PENDING_MAX` was unreachable: the hook denies a NEW marker at
  // `>= PENDING_MAX`, so the map never exceeds the cap and this branch was dead
  // code standing in for a state the runner could not see.
  if (ids.length >= PENDING_MAX) {
    return { code: 'interlock-pending-overflow', detail: { pending: ids.length, max: PENDING_MAX } };
  }
  let oldest = null;
  for (const id of ids) {
    const ts = Number(state.pending[id]?.ts);
    if (Number.isFinite(ts) && (oldest === null || ts < oldest)) oldest = ts;
  }
  const ageMs = oldest === null ? null : now - oldest;
  if (ageMs !== null && ageMs > staleMs) {
    return {
      code: 'interlock-pending-stale',
      detail: { pending: ids.length, oldest_age_ms: ageMs, tool_use_ids: ids.slice(0, 8) },
    };
  }
  return {
    code: 'interlock-permission-pending',
    detail: { pending: ids.length, tool_use_ids: ids.slice(0, 8) },
  };
}

// ─── WHY THERE IS NO UNGATED COUNTER HELPER ────────────────────────────────
// There was one, and it was a defect. It existed to make a denial count as an
// invocation (leg 4), and its comment claimed "it takes no gate: the only field
// it touches is a counter". THAT WAS FALSE: it re-read state.json, mutated, and
// wrote the WHOLE object back -- `pending` and `last_write_at` with it -- and it
// ran on the gate-busy path, which exists precisely because ANOTHER PARTY HOLDS
// THE GATE. Interleaving the holder's marker write between its read and its
// write DESTROYED A MARKER FOR A LIVE DIALOG, after which the runner read
// ready. It could also clobber `last_write_at`, losing the drain stamp for a
// byte in flight, or resurrect a cleared marker.
//
// So the rule in this file's state-file header holds again without exception:
// STATE.JSON IS WRITTEN ONLY UNDER THE GATE. Where a denial happens with the
// gate held (the overflow path) the count is folded into that path's own single
// write. Where it happens because the gate could NOT be had, the increment is
// simply not made -- and that is sound rather than a compromise, because
// absorbing a dropped increment is the stated purpose of leg 4's forgiveness
// rule, which forgives a shortfall whenever the hook is demonstrably alive.

// Is ANY session on this install managed? Used only when the session cannot be
// named, to decide whether a refusal is owed to somebody. Bounded: one readdir
// of the interlock root and at most SESSION_DIR_SWEEP_MAX stats.
export function anyManagedSession({
  memRoot, env = process.env, fsImpl = fs, processLike = process,
} = {}) {
  const root = interlockRoot({ memRoot, env });
  if (root === null) return false;
  let entries;
  try { entries = fsImpl.readdirSync(root); } catch { return false; }
  let looked = 0;
  for (const name of entries) {
    if (looked >= SESSION_DIR_SWEEP_MAX) break;
    looked += 1;
    // A LIVE RUNNER, not merely a proof FILE. Testing for the file alone left
    // `interlock-no-session-id` on a managed seat with NO MANUAL RECOVERY AT
    // ALL, under a heading promising two paths: the release is scoped to a
    // session directory the hook has just failed to name, so path 2 cannot
    // reach it, and path 1 -- stopping the runner -- did not lift it either,
    // because a stopped runner leaves its proof behind. The only way out was
    // deleting proof files or unwiring the hook from outside Claude Code, which
    // is the outage class this whole feature exists to prevent.
    //
    // Reading the proof and checking its pid costs one more read and a
    // kill(pid, 0) per candidate, bounded by the same sweep cap, and it makes
    // the promise true: stopping the runner now lifts every denial, including
    // the ones that cannot name their session.
    // ─── CANNOT SEE IS NOT "NOTHING THERE" ────────────────────────────────
    // This was the document's own substitution, in the new code: a bare
    // `catch { continue; }` meant one EBUSY on a live seat's proof.json turned
    // the unnameable-payload denial into `inert / managed: false`. Narrow -- it
    // needs an unnameable payload AND a transient read error together -- but it
    // is the same mistake this whole unit exists to stop making.
    //
    // Only ENOENT is evidence: that candidate has no proof, so move on.
    // Anything else means a proof may well be there and we could not read it,
    // which must count as MANAGED. The recovery for a persistently unreadable
    // or corrupt proof is to remove the file, which is the same deliberate act
    // as stopping the runner's claim -- see "Two manual paths" in the doc.
    let raw;
    try { raw = fsImpl.readFileSync(path.join(root, name, PROOF_NAME), 'utf8'); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      return true;
    }
    let proof;
    try { proof = JSON.parse(raw); } catch { return true; }
    const pid = proof?.runner_pid;
    // A proof that exists but names no usable pid is a proof we cannot check
    // the liveness of. Same rule: it counts.
    if (!Number.isInteger(pid) || pid <= 0) return true;
    if (pidAlive(pid, processLike)) return true;
  }
  return false;
}

// ─── THE HOOK ───────────────────────────────────────────────────────────────

function deny(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch { /* the call would then proceed -- see hookMain's last resort */ }
}

// The root the hook resolves state from. AIGENT_ROOT is what the installed
// .claude/settings.json sets; CLAUDE_PROJECT_DIR is the host's own; the
// payload's cwd is the runner's cwd and the last resort. memRoot() itself
// honours AIGENT_STATE_HOME_DIR, so a relocated state home follows both sides.
export function hookMemRoot(payload, env = process.env) {
  for (const candidate of [env.AIGENT_ROOT, env.CLAUDE_PROJECT_DIR, payload?.cwd]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    try {
      const resolved = resolveMemoryRoot(candidate);
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * One hook invocation, as a function so the suite can drive the SHIPPED code
 * without a subprocess per vector.
 *
 * Returns {action:'allow'|'deny'|'inert', code, detail}. 'inert' means no
 * managed runner is present for this session, which is not a decision about
 * the tool call at all.
 */
export function runHook({
  payload,
  event,
  env = process.env,
  fsImpl = fs,
  now = () => Date.now(),
  processLike = process,
  pid = process.pid,
  sleep = sleepMs,
  gateBudgetMs = HOOK_GATE_BUDGET_MS,
} = {}) {
  if (!interlockEnabled(env)) return { action: 'inert', code: 'interlock-disabled', detail: null };
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null;
  // ─── "THE HOOK RAN AND PROTECTED NOTHING" IS NOT AN ACCEPTABLE OUTCOME ────
  // These two exits used to be `inert` -> exit 0 -> the tool call proceeds with
  // no marker, silently. Both are reachable without any filesystem fault: a
  // `readStdin()` that swallows its error yields `{}`, and a renamed or absent
  // `session_id` does the same. For the event that precedes the dialog that is
  // a fail-open, so when the EVENT is known to be PreToolUse -- which the argv
  // in the template now states independently of the payload -- it denies.
  //
  // For the clearing events it stays inert: failing to clear only holds
  // automatic writes, which is already the safe direction.
  // ─── STILL "NO MANAGED RUNNER MEANS NO OPINION" ──────────────────────────
  // These two denials are RIGHT for a managed seat -- a PreToolUse that cannot
  // name its session cannot protect it -- and WRONG for every other seat, which
  // is most of them. Denying before `readProof` broke the rule the whole unit
  // rests on: an unmanaged seat with the hook wired got every tool call refused,
  // told "A managed runner owns this seat's composer" (false), and had no
  // recovery except editing settings.json from outside Claude Code. A release
  // could not help either, because the release is read later. That is the
  // permanent tool outage this feature exists to prevent, inside the feature.
  //
  // So before denying, establish that SOME managed runner exists: one bounded
  // readdir for any proof.json under the interlock root. It cannot tell us
  // WHICH session (that is the information we just lost), but "no proof
  // anywhere" is conclusive that nothing here is managed.
  const memRoot = hookMemRoot(payload, env);
  const preToolUse = event === 'PreToolUse';
  const unnameable = (code) => {
    if (!preToolUse) return { action: 'inert', code, detail: null };
    if (!anyManagedSession({ memRoot, env, fsImpl, processLike })) {
      return { action: 'inert', code, detail: { managed: false } };
    }
    return { action: 'deny', code, detail: { managed: true } };
  };
  if (sessionId === null || !SESSION_ID_OK.test(sessionId)) {
    return unnameable('interlock-no-session-id');
  }
  const dir = sessionDir({ memRoot, sessionId, env });
  if (dir === null) return unnameable('interlock-dir-unresolved');
  // NO MANAGED RUNNER MEANS NO OPINION. The runner writes this file; without it
  // nothing is writing to this composer automatically, and the runner's own
  // side refuses for the same reason.
  const proofRead = readProof({ dir, fsImpl });
  if (!proofRead.ok) {
    return { action: 'inert', code: proofRead.code, detail: null };
  }
  const nonce = proofRead.proof.nonce;

  // ─── MANUAL PATH (1): THE RUNNER IS GONE ──────────────────────────────────
  // No managed runner, no automatic keystroke, so nothing for this hook to
  // protect and no subject for a denial. This is the recovery that needs no
  // write, which is what makes it the answer to a read-only filesystem. Its
  // limit is pid recycling; see the header.
  const runnerPid = proofRead.proof.runner_pid;
  if (Number.isInteger(runnerPid) && runnerPid > 0 && !pidAlive(runnerPid, processLike)) {
    return { action: 'inert', code: 'interlock-runner-gone', detail: { runner_pid: runnerPid } };
  }

  // ─── MANUAL PATH (2): THE OPERATOR'S RELEASE ──────────────────────────────
  // CHECKED BEFORE THE GATE, because the gate is the thing that may be wedged.
  // A release takes no gate, writes nothing and expresses no permission
  // opinion: the call goes straight to the host's own check. The runner's side
  // latches automation off for the binding, which is what makes this a trade
  // rather than a hole.
  const release = manualRelease({ dir, sessionId, fsImpl });
  if (release !== null && release.ok) {
    return { action: 'allow', code: 'interlock-released-manually', detail: { reason: inert(release.release.reason, 200) } };
  }
  // A release that did not take is reported, never ignored -- an operator who
  // wrote one has to find out it was malformed rather than conclude the
  // mechanism does not work. It keeps denying, which is the safe direction.
  const releaseProblem = release !== null && !release.ok ? release.code : null;

  const gate = acquireGate({
    dir,
    side: `hook:${event}`,
    nonce,
    budgetMs: event === 'PreToolUse' ? gateBudgetMs : Math.min(gateBudgetMs, 300),
    fsImpl,
    now,
    processLike,
    pid,
    sleep,
  });
  if (!gate.ok) {
    // FAIL CLOSED, and only for the event that precedes the dialog. A
    // PostToolUse or Stop that cannot take the gate merely fails to CLEAR,
    // which holds automatic writes -- already the safe direction -- so denying
    // there would cost liveness and buy nothing.
    if (event !== 'PreToolUse') {
      return { action: 'allow', code: gate.code, detail: gate.detail ?? null };
    }
    // NOT COUNTED HERE, deliberately. A denial IS an invocation and leg 4 would
    // like to know, but this path runs with the gate held BY SOMEBODY ELSE, and
    // the only way to record it would be an ungated read-modify-write of the
    // whole state file -- which destroyed a live dialog's marker when it was
    // tried. Leg 4's forgiveness exists to absorb exactly this dropped
    // increment: a hook that is alive pays it off on its next successful call.
    return {
      action: 'deny',
      code: gate.code,
      detail: {
        ...(gate.detail === null || typeof gate.detail !== 'object' ? { gate: gate.detail ?? null } : gate.detail),
        // A release that did NOT take is named here, so an operator who wrote
        // one learns it was malformed on the very call still being denied
        // rather than concluding the mechanism does not work. The recovery
        // instruction itself lives in denyReasonFor's prose, because this
        // object is length-bounded.
        ...(releaseProblem === null ? {} : { release: releaseProblem }),
      },
    };
  }
  try {
    const stateRead = readState({ dir, fsImpl });
    // ─── AN UNREADABLE STATE IS NOT AN EMPTY ONE ──────────────────────────
    // This branch used to fall back to emptyState() for ANY unsuccessful read,
    // which meant one transient EBUSY while a dialog was on screen DESTROYED
    // that dialog's marker and reset the counters -- after which all four
    // evidence legs passed and the runner read `ready: true`. Measured. The
    // invented state also carried `last_write_at: null`, so the same
    // invocation skipped the drain as well.
    //
    // readState already distinguishes MISSING from UNREADABLE, and the runner
    // treats both as refusals; only `missing` may be initialised here. The
    // asymmetry that gave this away was already in the file: a state WRITE
    // failure denied while a read failure invented a state.
    if (!stateRead.ok && stateRead.code !== 'interlock-state-missing') {
      if (event === 'PreToolUse') {
        return { action: 'deny', code: stateRead.code, detail: { ...(releaseProblem === null ? {} : { release: releaseProblem }) } };
      }
      // A clearing event that cannot read the state must not overwrite it
      // either: failing to clear only holds automatic writes, which is already
      // the safe direction, whereas clobbering would erase live markers.
      return { action: 'allow', code: stateRead.code, detail: null };
    }
    const state = stateRead.ok && stateRead.state?.nonce === nonce
      ? stateRead.state
      : emptyState(nonce);
    if (!state.pending || typeof state.pending !== 'object') state.pending = {};

    if (event === 'PreToolUse') {
      // THE DRAIN. A pty write may still be travelling to the child; hold the
      // gate until it cannot be, then let the permission check start.
      const since = Number(state.last_write_at);
      if (Number.isFinite(since)) {
        // CLAMPED, because a clock that moved is the ordinary case on a laptop
        // or a resumed VM. A BACKWARD step made `now - since` negative and the
        // drain was skipped as "already elapsed"; a negative elapsed is not
        // evidence of anything, so it drains in full.
        //
        // A FORWARD step is NOT fixable here and is not claimed to be: with one
        // wall clock, "5 s have passed" and "the clock jumped 5 s" are the same
        // observation. It is named in docs/dialog-readiness.md as a residual of
        // the drain rather than papered over.
        const elapsed = now() - since;
        const effective = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
        const remaining = INTERLOCK_DRAIN_MS - effective;
        if (remaining > 0) sleep(Math.min(remaining, INTERLOCK_DRAIN_MS));
      }
      const toolUseId = typeof payload.tool_use_id === 'string' && TOOL_USE_ID_OK.test(payload.tool_use_id)
        ? payload.tool_use_id
        // A call with no usable id still raises a dialog, so it is still
        // recorded -- under a synthetic key, which only a Stop sweep clears.
        // Never dropped: an unnameable call is a call that cannot be paired.
        : `anon:${crypto.randomUUID()}`;
      if (Object.keys(state.pending).length >= PENDING_MAX
        && !Object.hasOwn(state.pending, toolUseId)) {
        // The map is full. Denying is the only answer that does not either
        // discard a pending call or grow the file without bound.
        // Counted INSIDE the gate we hold, folded into one write, so the
        // whole-state write is safe here in a way it is not on the gate-busy
        // path above.
        state.nonce = nonce;
        countPreRun(state, toolUseId);
        state.last_event = 'PreToolUse:denied';
        state.last_event_at = now();
        writeState({ dir, state, fsImpl, pid });
        return { action: 'deny', code: 'interlock-pending-overflow', detail: { max: PENDING_MAX } };
      }
      let transcriptSize = null;
      try {
        transcriptSize = typeof payload.transcript_path === 'string'
          ? fsImpl.statSync(payload.transcript_path).size
          : null;
      } catch { transcriptSize = null; }
      state.pending[toolUseId] = {
        tool: typeof payload.tool_name === 'string' ? inert(payload.tool_name, 80) : null,
        ts: now(),
        transcript_size: transcriptSize,
      };
      countPreRun(state, toolUseId);
    } else if (event === 'PostToolUse') {
      const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null;
      if (toolUseId !== null) delete state.pending[toolUseId];
      state.post_runs = (Number(state.post_runs) || 0) + 1;
    } else if (event === 'Stop') {
      // THE SWEEP, and the reason it is sound: Stop fires when the assistant
      // has finished responding. A permission dialog cannot be on screen then
      // -- the turn it belongs to has ended. This is what bounds an orphaned
      // marker (a cancelled call gets no PostToolUse: measured) to the turn it
      // was raised in.
      state.pending = {};
      state.stop_runs = (Number(state.stop_runs) || 0) + 1;
    } else {
      // An event this hook does not handle. Not a denial: the template wires
      // only the three, so reaching here means the event name itself could not
      // be established -- and the PreToolUse case was already denied above,
      // before the gate, on the argv the template supplies.
      return { action: 'inert', code: 'interlock-unknown-event', detail: { event: inert(String(event), 40) } };
    }
    state.nonce = nonce;
    state.last_event = String(event);
    state.last_event_at = now();
    const written = writeState({ dir, state, fsImpl, pid });
    if (!written.ok) {
      // Could not record. For PreToolUse that is the fail-open case: the
      // runner would see an empty pending map and write.
      if (event === 'PreToolUse') {
        // No countInvocation here: the state is what could not be written, so
        // there is nowhere to count it. Leg 4's forgiveness rule (see
        // interlockEvidence) is what keeps this from being permanent.
        return { action: 'deny', code: written.code, detail: written.detail ?? null };
      }
      return { action: 'allow', code: written.code, detail: written.detail ?? null };
    }
    return { action: 'allow', code: null, detail: null };
  } finally {
    releaseGate(gate.handle);
  }
}

// One PreToolUse run: counted (leg 3 and the forgiveness evidence) and, when the
// call has a real id, remembered (leg 4). A synthetic anon: key names no record,
// so it is counted and not remembered.
function countPreRun(state, toolUseId) {
  state.pre_runs = (Number(state.pre_runs) || 0) + 1;
  if (typeof toolUseId !== 'string' || toolUseId.startsWith('anon:')) return;
  const ids = Array.isArray(state.recent_ids) ? state.recent_ids.filter((id) => typeof id === 'string') : [];
  ids.push(toolUseId);
  state.recent_ids = ids.length > RECENT_IDS_MAX ? ids.slice(ids.length - RECENT_IDS_MAX) : ids;
}

const DENY_PREFIX = '[PRE-PERMISSION INTERLOCK]';

export function denyReasonFor(code, detail) {
  return `${DENY_PREFIX} refused to let this tool call reach the permission check: `
    + `${inert(String(code), 80)}${detail === null || detail === undefined ? '' : ` ${inert(JSON.stringify(detail), 200)}`}. `
    + 'A managed runner owns this seat\'s composer and the interlock could not record that a '
    + 'permission check is starting, so allowing it could let an automatic keystroke answer the '
    + 'dialog. Retry the tool call; if this repeats, this seat needs a human. '
    // THE RECOVERY IS IN THE PROSE, not in the detail. The detail is bounded at
    // 200 characters because it is a diagnostic, and a TRUNCATED recovery
    // instruction is worse than none -- it would read as though a path existed
    // and then fail to say what it is. This text is what the operator sees on
    // the very call being denied, which is the moment they need it.
    + `RECOVERY (deliberate, manual): ${RECOVERY_HINT}`;
}

// ─── `--release <session-id> "<reason>"` ────────────────────────────────────
// The deliberate act, as a subcommand, so an operator in a wedged seat does not
// have to hand-write JSON with the right session id while tool calls are being
// denied. It is still entirely manual: nothing invokes this, it takes no
// default for either argument, and it refuses rather than guessing.
//
// It does NOT need the gate (the gate may be the wedge) and it does NOT touch
// the state file, the proof, the settings, or any permission rule.
export function releaseMain(argv, { env = process.env, fsImpl = fs, now = () => Date.now() } = {}) {
  const sessionId = argv[0];
  const reason = argv.slice(1).join(' ').trim();
  const say = (m) => { try { process.stderr.write(`${m}
`); } catch { /* nothing printable */ } };
  if (typeof sessionId !== 'string' || !SESSION_ID_OK.test(sessionId) || reason.length === 0) {
    say('usage: node pre-permission-interlock.mjs --release <session-id> "<reason>"');
    say('  Both arguments are required. The reason is the durable record of why');
    say('  automatic input was given up for this session, so there is no default.');
    return 2;
  }
  const memRoot = hookMemRoot({ cwd: env.CLAUDE_PROJECT_DIR || process.cwd() }, env);
  const dir = sessionDir({ memRoot, sessionId, env });
  if (dir === null) {
    say('could not resolve the interlock directory. Set AIGENT_ROOT (or '
      + 'AIGENT_INTERLOCK_DIR) to the install this session belongs to.');
    return 2;
  }
  // REFUSE TO WRITE INTO THE WRONG TREE. The root is resolved from AIGENT_ROOT,
  // CLAUDE_PROJECT_DIR or the CWD, so an operator who runs this from the wrong
  // directory would otherwise get a cheerful success having written a release
  // into some other install -- while the seat they meant to recover carried on
  // denying. The proof is the evidence that this directory belongs to that
  // session, so its absence is a refusal with the reason spelled out.
  if (!readProof({ dir, fsImpl }).ok) {
    say(`no interlock proof for session ${inert(sessionId, 80)} under ${dir}`);
    say('  Either this is the wrong install (set AIGENT_ROOT to the one the session');
    say('  belongs to) or the wrong session id (the runner names it in every refusal');
    say('  it logs). Nothing was written.');
    say('  NOTE: with no proof there is nothing to release -- the hook is already');
    say('  inert for that session, so tool calls are not being denied by it.');
    return 2;
  }
  const record = {
    release: RELEASE_LITERAL,
    session_id: sessionId,
    reason,
    released_at: new Date(now()).toISOString(),
  };
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    const fd = fsImpl.openSync(path.join(dir, RELEASE_NAME), 'w');
    fsImpl.writeFileSync(fd, JSON.stringify(record, null, 2));
    try { fsImpl.fsyncSync(fd); } catch { /* best effort */ }
    fsImpl.closeSync(fd);
  } catch (error) {
    say(`could not write the release: ${error?.code ?? error}`);
    say('If the interlock directory is not writable, this is the case the OTHER '
      + 'manual path covers: stop the managed runner, which needs no write.');
    return 1;
  }
  logErr(env.AIGENT_ROOT || env.CLAUDE_PROJECT_DIR || '', 'pre-permission-interlock',
    `MANUAL RELEASE written for session ${inert(sessionId, 80)}: ${inert(reason, 400)}`);
  say(`${DENY_PREFIX} manual release written: ${path.join(dir, RELEASE_NAME)}`);
  say('  Tool calls in this session will now reach the permission check normally.');
  say('  Automatic runner input stays DISABLED for this binding, and the runner');
  say('  will say so by name on every tick. Deleting this file does not undo it:');
  say('  only a new session (restart, or a post-clear rebind) starts over.');
  return 0;
}

function hookMain() {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }
  // ARGV FIRST, PAYLOAD SECOND. The template passes the event name as an
  // argument precisely so that a payload which cannot be read or whose field
  // has been renamed cannot turn a PreToolUse into "no opinion". The payload
  // field remains the fallback, for an install whose wiring predates the argv.
  const argvEvent = typeof process.argv[2] === 'string' && INTERLOCK_EVENTS.has(process.argv[2])
    ? process.argv[2]
    : null;
  const event = argvEvent
    ?? (typeof payload.hook_event_name === 'string' && payload.hook_event_name.length > 0
      ? payload.hook_event_name
      : '');
  let verdict;
  try {
    verdict = runHook({ payload, event });
  } catch (error) {
    logErr(
      process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload?.cwd || '',
      'pre-permission-interlock',
      `outer: ${error?.stack || error}`,
    );
    // AN INTERNAL ERROR IS NOT AN ALL-CLEAR. Unlike every other PreToolUse hook
    // in this repo, this one cannot fail open: its whole job is to be the reason
    // an automatic keystroke is held, and a throw means it did not do it. Only
    // the event that precedes the dialog denies -- and only when a managed
    // runner was proven present, which is why the proof lookup is inside
    // runHook's own try and an inert verdict never reaches here.
    verdict = { action: event === 'PreToolUse' ? 'deny' : 'allow', code: 'interlock-hook-threw', detail: null };
  }
  // ─── LOUD, NOT SILENT (the owner's fourth constraint) ────────────────────
  // A release and a gone-runner both stop this hook protecting anything, so
  // neither may be quiet. Written to the same durable sink every other daemon
  // diagnostic uses, on every invocation it applies to: on a released seat that
  // is one line per tool call, which is the honest record of a seat running
  // without the protection.
  if (verdict.code === 'interlock-released-manually' || verdict.code === 'interlock-runner-gone') {
    logErr(
      process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload?.cwd || '',
      'pre-permission-interlock',
      `${verdict.code} -- this tool call reached the permission check with the `
      + `interlock not protecting it; automatic runner input must stay disabled. `
      + `${inert(JSON.stringify(verdict.detail ?? null), 300)}`,
    );
  }
  if (verdict.action === 'deny') {
    const reason = denyReasonFor(verdict.code, verdict.detail);
    deny(reason);
    try { process.stderr.write(`${reason}\n`); } catch { /* stdout carried it */ }
    // Exit 2 as well as the JSON decision: if stdout could not be written, the
    // exit code is what still blocks. gateguard.mjs and model-tier-guard.mjs
    // use the same belt-and-braces pair.
    process.exit(2);
  }
  process.exit(0);
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  if (process.argv[2] === '--release') process.exit(releaseMain(process.argv.slice(3)));
  hookMain();
}
