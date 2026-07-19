#!/usr/bin/env node
// ctx-refresh-sensor.mjs — PreToolUse hook: context-pressure sensor.
//
// A SINGLE-SEAT self-refresh reflex — finalize capsule → self-probe QA →
// /compact. No broadcast, no conductor, no multi-agent coordination: every
// session self-refreshes independently (a live coordination layer, if a fork
// wires one, remains a separate, explicit, conductor-owned system).
//
// State machine (panel-hardened):
//   pct < 50            → full re-arm: fired=false, fires=0 (a compact that bought
//                         real headroom resets the escalation counter — the next
//                         crossing is an ordinary refresh, not a false "2nd fire").
//   drop ≥20 while fired, still >50 → compaction ran but didn't buy headroom:
//                         escalate /clear immediately.
//   crossing 60 unarmed → fire: route-by-state refresh first time (day-end pause →
//                         /close + /clear; mid-day pause → /clear; mid-flight →
//                         /compact), /clear if fires≥2 without a full re-arm in
//                         between (compact demonstrably not enough).
//   ≥60 while fired     → re-nudge every +5 points (the dead-zone fix: a partial
//                         compact that lands at 55 and creeps back up re-alerts at
//                         the next 5-point step instead of going silent to 90%).
//
// The percentage is the ground-truth used_percentage an operator's statusline (or
// other integration) persists per session to ~/.claude/ctx-refresh/<sid>.json —
// NOT a token estimate. If nothing writes that file, this sensor is silent by
// construction (see the pctFile existence check below) — it degrades to a no-op,
// it does not error.
//
// COORDINATION GUARD (pluggable, optional, same seam as sessionstart-reinject.mjs):
// while AIGENT_COORDINATION_STATE names a file with a non-terminal `phase`, the
// sensor stays SILENT — a wired conductor owns the lifecycle.
//
// INVARIANT: FAIL OPEN — any error exits 0; real failures log to the operator's
// <memRoot>/.daemon-errors.log, pct-read failures deduped to once per session via
// the state file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crossSessionCuratedAllowed, curatedWindowMs } from './lifecycle-common.mjs';

const FIRE_AT = 60;       // raise to 75-80 ONLY after reinject is proven on one
                          // live compaction — this is an early-warning threshold.
const HARD_AT = 75;       // at/above this line the sensor stops advising and
                          // directs /clear. The 60% reflex stays the early warning
                          // — this does NOT raise FIRE_AT.
const REARM_BELOW = 50;   // drop back below this = full re-arm (fired + fires reset)
const COMPACT_DROP = 20;  // a fall of this many points while fired = a compaction happened
const RENUDGE_STEP = 5;   // while fired and ≥ FIRE_AT, re-alert every +N points
const DEFAULT_STILL_POLL_MS = 1500;
const DEFAULT_STILL_DEADLINE_MS = 60000;
const DEFAULT_STILL_AGE_FLOOR_MS = 12000; // > the observed harness flush gap

const AUTOFIRE_LOCK_STALE_MS = 30_000;
const AUTOFIRE_COMPLETION_GRACE_MS = AUTOFIRE_LOCK_STALE_MS + 5_000;

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function memoryRoot(root) {
  for (const candidate of ['vault/memory', 'memory']) {
    const p = path.join(root, ...candidate.split('/'));
    if (fs.existsSync(p)) return p;
  }
  return path.join(root, 'vault', 'memory');
}

function logErr(msg) {
  try {
    const root = String(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '');
    if (!root) return;
    fs.appendFileSync(path.join(memoryRoot(root), '.daemon-errors.log'),
      `${new Date().toISOString()} [ctx-refresh-sensor] ${msg}\n`);
  } catch { /* truly nowhere to log */ }
}

// aigent-OS is single-operator, so the pointer is always BODY_STATE.json's
// state.last_capsule — the same convention the context-capsule skill documents.
function readCuratedPointer(root, memory, sid) {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(memory, 'BODY_STATE.json'), 'utf8'))
      ?.state?.last_capsule ?? null;
    // CLASS SIX (board c1f777e9): close_kind is the authoritative close discriminator
    // (closed enum, trusted writers only — the same formula as the staged-close wake
    // gate). trigger varies by writer: curated-close-pointer.mjs stamps
    // trigger:'curated-close' + finalized_at, while the stop-writer's finalize-freeze
    // branch stamps trigger:'stop-delta' + close_kind:'completion' with created_at
    // only. Gating on trigger alone made every real completion stamp invisible to
    // this worker while the wake kept minting cycles at it — mint→skip→abort→re-arm
    // livelock. Freshness: finalized_at as before; the created_at fallback applies to
    // COMPLETION STAMPS ONLY — a curated-trigger pointer without finalized_at stays
    // rejected exactly as pre-fix. checkpoint / null close_kind pointers (every
    // ordinary rolling stamp) are UNCHANGED: invisible unless curated-trigger.
    let finalizedAtMs = Date.parse(pointer?.finalized_at);
    if (!Number.isFinite(finalizedAtMs) && pointer?.close_kind === 'completion') {
      finalizedAtMs = Date.parse(pointer?.created_at);
    }
    if ((pointer?.trigger !== 'curated-close' && pointer?.close_kind !== 'completion')
      || !Number.isFinite(finalizedAtMs)
      || typeof pointer.path !== 'string'
      || pointer.path.trim() === '') return null;
    const capsulePath = path.isAbsolute(pointer.path)
      ? pointer.path
      : path.resolve(root, pointer.path);
    if (!fs.existsSync(capsulePath)) return null;
    if (pointer.session_id !== sid) {
      // A curated close whose stamping session rotated away WITHOUT a clear is
      // still THE close to seal — raw equality sent the autofire to the rolling
      // skeleton instead, which defers forever. The cross-session path is
      // window-bounded (curatedWindowMs — a curated close is a fresh close
      // awaiting seal, not an ancient anchor) and fails closed on clear-born
      // sessions, stale/absent boot evidence, consumed (status:resumed) capsules,
      // and falsy pointer sids (the stamper's no-sid branch — never cross-session
      // eligible). The same-session fast path above is untouched.
      if (!pointer.session_id) return null;
      if ((Date.now() - finalizedAtMs) >= curatedWindowMs()) return null;
      if (!crossSessionCuratedAllowed(memory, sid, capsulePath)) return null;
    }
    return { capsulePath, finalizedAtMs };
  } catch {
    return null;
  }
}

function durationFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

// Transcript age: ms since the harness last WROTE the transcript file (mtime). Unreadable
// stat counts as age 0 (not yet still): fail toward waiting, bounded by the deadline refusal.
function transcriptAgeMs(transcriptPath) {
  try {
    const mtime = fs.statSync(transcriptPath).mtimeMs;
    if (!Number.isFinite(mtime)) return 0;
    return Math.max(0, Date.now() - mtime);
  } catch {
    return 0;
  }
}

// FRESH-SEAT DISCRIMINATOR: a missing stop-writer record means one of two very
// different things — "genuinely fresh, no Stop event has fired yet" (skip
// quietly, nothing to capsule) or "this session has had real turns and the
// stop-writer is BROKEN, its record is never coming" (a real failure that must
// escalate loudly, not vanish into a quiet skip forever). The transcript jsonl is
// already in the worker payload as the capture-cursor source; its own event count
// is the cheapest real signal for "how much has this session actually done."
// Counts up to `cap` parseable lines (capped: this only needs to distinguish
// near-zero from substantial, never the exact total on a long session).
function transcriptEventCount(transcriptPath, cap = 50) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      count += 1;
      if (count >= cap) break;
    }
    return count;
  } catch {
    return 0;
  }
}
// Below this many transcript events, "no Stop event has fired yet" is the honest
// read — stop-writer only ever writes on a Stop, so a session with essentially no
// turns yet cannot have one, by construction. At or above it, absence is anomalous.
const FRESH_SEAT_EVENT_FLOOR = 6;

async function waitForStillCursor(transcriptPath, readCursor, cursorEqual) {
  const pollMs = durationFromEnv('CAPSULE_VERB_STILL_POLL_MS', DEFAULT_STILL_POLL_MS);
  const deadlineMs = durationFromEnv(
    'CAPSULE_VERB_STILL_DEADLINE_MS', DEFAULT_STILL_DEADLINE_MS,
  );
  // AGE FLOOR: the Stop hook fires BEFORE Claude Code flushes the turn's final
  // assistant text + trailing metadata to the transcript jsonl. Two consecutive
  // equal reads can fit inside that flush gap, so capture would land pre-flush
  // and the flush then moves the cursor — a false quiescence violation. The floor
  // requires the FILE to have been untouched for AGE_FLOOR ms before a still
  // cursor counts: adaptive (waits exactly until quiet-for-N, wherever the flush
  // lands), contract-free (mtime only, no record-timestamp parsing), and composed
  // ON TOP of the consecutive-equal reads (which still guard torn writes and
  // coarse-mtime filesystems).
  const ageFloorMs = durationFromEnv(
    'CAPSULE_VERB_STILL_AGE_FLOOR_MS', DEFAULT_STILL_AGE_FLOOR_MS,
  );
  const startedAt = Date.now();
  const deps = { readFile: fs.readFileSync, stat: fs.statSync };
  let previous = readCursor(transcriptPath, deps);

  while (Date.now() - startedAt < deadlineMs) {
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    if (remainingMs < pollMs) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = readCursor(transcriptPath, deps);
    if (cursorEqual(previous, current) && transcriptAgeMs(transcriptPath) >= ageFloorMs) {
      return current;
    }
    previous = current;
  }

  throw new Error(`transcript never went quiet within ${deadlineMs}ms; cycle refused`);
}

// Pluggable coordination guard — same seam as sessionstart-reinject.mjs. Absence
// of the env var (the default) means no coordination layer is wired.
function coordinationActive() {
  const statePath = process.env.AIGENT_COORDINATION_STATE;
  if (!statePath) return false;
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return !/"phase"\s*:\s*"(done|cancelled|canceled|closed|complete|aborted)"/i.test(raw);
  } catch {
    return false;
  }
}

// Route-by-state: compaction cost scales with transcript length — minutes on a
// heavy day, progress invisible — while capsule+/clear is constant-time. The
// right route depends on WHERE the fire lands, and only the operator at the
// keystroke moment knows that, so the routing lives in the message text.
function msgRefresh(pct) {
  return `[CONTEXT-REFRESH] You are at ${Math.round(pct)}% context — past the 60% mark. `
    + `Self-refresh, single session, NO announce. First, at your next CLEAN pause point (finish `
    + `the current action — never mid-tool-call): FINALIZE your active capsule — fill `
    + `waiting_on, resume_trigger, expires, and any early-constraints — then run the `
    + `self-probe QA: "could a fresh instance execute next_valid_action from this file `
    + `alone?" — fix the capsule until yes. ACK-VERIFY: after writing, `
    + `RE-READ the capsule file and confirm waiting_on is actually non-null on disk — the `
    + `finalize is NOT done until you have SEEN it landed (a silent edit-miss can leave a `
    + `session believing it capsuled while waiting_on stayed null, stranding it). Then ROUTE BY STATE: `
    + `[DAY-END pause: day closing, lanes blocked] run the full /close ritual, then request `
    + `/clear — the close IS the day-end memory commit; skip /compact entirely. `
    + `[MID-DAY pause: lanes blocked, day continuing] request /clear only — no close `
    + `ceremony; the capsule + SessionStart reinject re-ground the fresh session. `
    + `[MID-FLIGHT: task in motion] request /compact — it preserves the live working `
    + `thread. WARN the operator first: compaction time scales with transcript length, `
    + `minutes on a heavy day with NO progress indicator — it is not hung, do not cancel. `
    + `Capsule contract: docs/two-verb-lifecycle.md.`;
}

function msgClear(pct, why) {
  return `[CONTEXT-REFRESH] ${why} (${Math.round(pct)}% now). ESCALATE: finalize your active `
    + `capsule (same steps incl. the ACK-verify re-read), then run /clear instead of /compact — state is on disk, `
    + `and the SessionStart reinject re-grounds the fresh session from the capsule pointer `
    + `table. Single session, NO announce.`;
}

// Optional capsule-verb integration point. This path is deliberately absent from
// the default sensor behavior: no module is loaded and no extra I/O occurs unless
// the exact opt-in flag is present. The first armed threshold crossing calls the
// trusted verb in dry-run mode by default, records the capture cursor when the
// hook payload supplies one, and logs only (it never clears, injects, or gates).
function logAutofire(root, entry) {
  try {
    const memory = memoryRoot(root);
    const runtime = path.join(memory, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.appendFileSync(path.join(runtime, 'capsule-verb-autofire.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    logErr(`autofire outcome log failed: ${e?.message || e}`);
  }
}

async function runAutofireWorker(payload) {
  const root = String(payload?.root || '');
  const sid = payload?.sid;
  const transcriptPath = typeof payload?.transcriptPath === 'string' && payload.transcriptPath
    ? payload.transcriptPath
    : null;
  let capsulePath = null;
  let capsuleSource = null;
  try {
    if (!root || typeof sid !== 'string' || sid.length === 0) {
      throw new Error('worker payload lacks root/session id');
    }
    const [{ runCapsuleVerb, capsuleLeftSkeleton }, lifecycle, { readRequest }, { readCursor, cursorEqual },
      { createCycleRecord, readCycleRecord, cycleRecordPath }] =
      await Promise.all([
        import('./capsule-verb.mjs'),
        import('./lifecycle-common.mjs'),
        import('./refresh-request.mjs'),
        import('./refresh-cursor.mjs'),
        import('./refresh-cycle.mjs'),
      ]);
    const seatId = lifecycle.seatOf(root);
    const memory = lifecycle.memRoot(root);

    const curatedPointer = readCuratedPointer(root, memory, sid);
    if (curatedPointer !== null) {
      capsulePath = curatedPointer.capsulePath;
      capsuleSource = 'curated-pointer';
    }
    if (capsulePath === null) {
      capsuleSource = 'stop-writer';
      const stopStatePath = path.join(memory, 'runtime', 'stop-writer', `${sid}.json`);
      // FRESH-SEAT FIX: a brand-new session's first turn(s) have not produced a
      // Stop event yet, so this file genuinely does not exist -- not a
      // torn/corrupt state, a structurally EXPECTED one. The curated-pointer
      // branch above already correctly excludes the PRIOR session's stale close
      // (readCuratedPointer requires pointer.session_id === sid), so there is no
      // other legitimate capsule source at this moment when the session is
      // GENUINELY fresh.
      //
      // But "missing" alone conflated two very different situations: a session
      // with ZERO turns yet (nothing to capsule, quiet skip is correct) and a
      // session with MANY turns whose stop-writer is simply broken and will
      // NEVER produce a record (a real, ongoing failure that a quiet skip would
      // mask forever). The transcript's own event count discriminates: below the
      // floor, genuinely fresh; at or above it, the absence is anomalous and must
      // escalate loudly (logErr, not just an autofire log line) rather than
      // silently re-skip on every future poll.
      if (!fs.existsSync(stopStatePath)) {
        const eventCount = transcriptPath ? transcriptEventCount(transcriptPath) : 0;
        if (eventCount < FRESH_SEAT_EVENT_FLOOR) {
          logAutofire(root, {
            sid,
            outcome: 'skipped_fresh_seat',
            mode: transcriptPath ? 'cycle' : 'legacy',
            reason: `no stop-writer record yet at ${stopStatePath} (transcript_events=${eventCount} < floor ${FRESH_SEAT_EVENT_FLOOR}; pre-first-Stop, nothing to capsule)`,
          });
          return;
        }
        logErr(`stop-writer record missing for a NON-fresh session: sid=${sid} transcript_events=${eventCount} `
          + `(>= floor ${FRESH_SEAT_EVENT_FLOOR}) path=${stopStatePath} -- the stop-writer may be broken, `
          + `this is NOT a fresh-seat skip`);
        throw new Error(`stop-writer record missing for a non-fresh session (${eventCount} transcript events, `
          + `floor ${FRESH_SEAT_EVENT_FLOOR}) at ${stopStatePath}`);
      }
      const stopState = JSON.parse(fs.readFileSync(stopStatePath, 'utf8'));
      if (typeof stopState?.capsule_path !== 'string' || stopState.capsule_path.trim() === '') {
        throw new Error(`active capsule path missing from ${stopStatePath}`);
      }
      capsulePath = path.isAbsolute(stopState.capsule_path)
        ? stopState.capsule_path
        : path.resolve(root, stopState.capsule_path);
    }
    // SKELETON GATE (readiness, before every validity check below): a fresh
    // autosave capsule still carries the writer skeleton's null-family
    // waiting_on — the agent's finalize step has not run yet. Handing it to the
    // verb can only produce a refusal, and that refusal reads like a failure
    // (the exact known-issue this gate closes: refresh cycles refused against
    // brand-new capsules until real state lands). Defer QUIETLY instead; a
    // later poll fires once the capsule has left skeleton state. Never seed a
    // placeholder — a writer-producible waiting_on would destroy the proof
    // that the agent's own finalize ran. Read failures fall THROUGH to the
    // verb: an unreadable capsule is not "still skeleton", it is the verb's
    // loud refusal to make.
    let leftSkeleton = true;
    try {
      leftSkeleton = capsuleLeftSkeleton(fs.readFileSync(capsulePath, 'utf8'));
    } catch { /* fall through to the verb's own refusal machinery */ }
    if (!leftSkeleton) {
      logAutofire(root, {
        sid,
        outcome: 'skipped_skeleton',
        mode: transcriptPath ? 'cycle' : 'legacy',
        capsule_source: capsuleSource,
        capsule_path: capsulePath,
        reason: 'capsule has not left skeleton state (waiting_on is null-family; finalize has not run) — deferred, not refused',
      });
      return;
    }
    const dryRun = process.env.CAPSULE_VERB_AUTOFIRE_DRY_RUN !== '0';

    // CHALLENGE CROSSING. A transcript path in the worker payload is the
    // controller's request-gated cycle signal: the controller has dropped a
    // RefreshRequest carrying the nonce, and the raw transcript is what the
    // capture cursor is read from. In this mode a valid, UNEXPIRED request is
    // MANDATORY — an absent / expired / torn request is a fail-closed refusal,
    // never a bare stamp. Without a transcript path the legacy no-cycle autofire
    // runs unchanged, preserving that path's behavior byte-for-byte.
    if (transcriptPath) {
      const req = readRequest(memory, sid);
      if (!req) throw new Error('refresh request absent, torn, or unreadable — cycle refused');
      const expiresMs = Date.parse(req.expires_at);
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
        throw new Error(`refresh request expired at ${req.expires_at}; cycle refused`);
      }
      // SUPERSEDE: a controller abort + re-mint leaves the persisted seat record
      // on the DEAD cycle (e.g. state=prepared), and the verb's begin-in-requested
      // guard would then refuse every NEW cycle forever; the session never hears
      // about controller aborts directly. The controller's supersede signal is
      // IMPLICIT in the request file it already writes: a valid, unexpired
      // request bearing a DIFFERENT cycle_id than the persisted record is the
      // controller's current intent, and the stale record yields to it. Fail
      // closed on everything else: same cycle_id (the verb owns its own cycle's
      // progression), or a request NOT strictly newer than the record
      // (replay/clock corner): refuse loudly, delete nothing. Absent record =
      // normal first cycle, nothing to supersede. A PRESENT but torn/unreadable
      // record makes readCycleRecord throw -> the catch refuses the cycle loudly
      // (never blind-delete a record we could not verify).
      const staleRecord = fs.existsSync(cycleRecordPath(root, sid))
        ? readCycleRecord(root, sid)
        : null;
      if (staleRecord && staleRecord.cycle_id !== req.cycle_id) {
        const staleIssuedMs = Date.parse(staleRecord.issued_at);
        const reqIssuedMs = Date.parse(req.issued_at);
        const strictlyNewer = Number.isFinite(reqIssuedMs)
          && (!Number.isFinite(staleIssuedMs) || reqIssuedMs > staleIssuedMs);
        if (!strictlyNewer) {
          throw new Error(`stale seat cycle ${staleRecord.cycle_id} (state=${staleRecord.state}) `
            + `not superseded: request ${req.cycle_id} issued_at ${req.issued_at} is not strictly `
            + `newer than record issued_at ${staleRecord.issued_at}; cycle refused`);
        }
        fs.rmSync(cycleRecordPath(root, sid), { force: true });
        logAutofire(root, {
          sid,
          outcome: 'superseded_stale_seat_record',
          mode: 'cycle',
          superseded_cycle: staleRecord.cycle_id,
          superseded_state: staleRecord.state,
          by_cycle: req.cycle_id,
        });
      }
      // Wait for two identical cursor reads before handing the capture boundary to
      // the verb. The request hint remains the fallback for a quiet null cursor.
      const cursor = await waitForStillCursor(transcriptPath, readCursor, cursorEqual);
      if (expiresMs <= Date.now()) {
        throw new Error(`refresh request expired at ${req.expires_at}; cycle refused`);
      }
      // The capture anchor travels as a PAIR — event id AND offset from the SAME
      // source (still cursor, else the request hint). Taking event_id alone here
      // is the drop point that would kill every still-seat verify: the pointer
      // stamps @undefined and strict cursorEqual can never pass on a half cursor.
      const captureAnchor = cursor ?? req.captured_through_hint ?? null;
      const capturedThroughEventId = captureAnchor?.event_id ?? null;
      const capturedThroughOffset = captureAnchor?.offset ?? null;
      // The session authors NO nonce: the raw challenge from the request is
      // handed to runCapsuleVerb, which alone computes the sha256:<hex> digest.
      // lineage_id and context_epoch are session-side defaults here (a real
      // controller owns lineage); this unit only proves the crossing lands a
      // well-formed cycle.
      const record = createCycleRecord({
        cycle_id: req.cycle_id,
        lineage_id: req.cycle_id,
        runtime_session: sid,
        context_epoch: 0,
        issued_at: req.issued_at,
        expires_at: req.expires_at,
      });
      const result = await runCapsuleVerb({
        seatId,
        memRoot: memory,
        capsulePath,
        cycle: { record, challenge: req.challenge },
        capturedThroughEventId,
        capturedThroughOffset,
        dryRun,
      });
      // A successful live worker stamps the pointer after the pre-spawn claim.
      // Advance the same claim past that self-stamp so only a later stamp re-arms.
      const completedPointer = readCuratedPointer(root, memory, sid);
      await recordCompletedAutofire(sid, req.cycle_id, completedPointer?.finalizedAtMs);
      logAutofire(root, {
        sid,
        outcome: 'completed',
        mode: 'cycle',
        dry_run: dryRun,
        stamped: result.stamped === true,
        cycle_states: result.cycleStates ?? [],
        refusal_count: result.refusals?.length ?? 0,
        capsule_source: capsuleSource,
        capsule_path: capsulePath,
      });
      return;
    }

    const result = await runCapsuleVerb({
      seatId,
      memRoot: memory,
      capsulePath,
      capturedThroughEventId: payload?.eventId ?? null,
      capturedThroughOffset: payload?.offset ?? null,
      dryRun,
    });
    logAutofire(root, {
      sid,
      outcome: 'completed',
      dry_run: dryRun,
      stamped: result.stamped === true,
      refusal_count: result.refusals?.length ?? 0,
    });
  } catch (e) {
    logAutofire(root, {
      sid: typeof sid === 'string' ? sid : null,
      outcome: 'refused',
      error: String(e?.message || e),
      ...(transcriptPath ? {
        mode: 'cycle',
        capsule_source: capsuleSource,
        capsule_path: capsulePath,
      } : {}),
    });
  }
}

function launchAutofire(payload, sid) {
  if (process.env.CAPSULE_VERB_AUTOFIRE !== '1') return false;
  try {
    const root = String(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload?.cwd || '');
    if (!root) throw new Error('project root unavailable');
    const workerPayload = Buffer.from(JSON.stringify({
      root,
      sid,
      eventId: payload?.event_id ?? null,
      // The raw transcript path is the request-gated cycle signal + the
      // capture-cursor source. Absent in older payloads -> null -> the worker
      // keeps the legacy no-cycle path.
      transcriptPath: payload?.transcript_path ?? null,
    }), 'utf8').toString('base64url');
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url), '--autofire-worker', workerPayload,
    ], {
      detached: true,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    // spawn() reports many launch failures asynchronously. A missing pid is the
    // synchronous refusal signal available before this short-lived hook exits.
    if (!child.pid) throw new Error('autofire worker did not receive a process id');
    child.once('error', (error) => {
      logErr(`autofire worker error sid=${sid}: ${error?.message || error}`);
    });
    child.unref();
    return true;
  } catch (e) {
    logErr(`autofire launch failed sid=${sid}: ${e?.message || e}`);
    return false;
  }
}

// Atomic-ish state write — a torn state file re-fires spurious alerts.
function writeState(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    try { fs.renameSync(tmp, file); } catch {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    }
    return true;
  } catch (e) {
    // A state write that never lands re-fires the same alert next call — visible
    // spam beats invisible breakage, and the log names the cause.
    logErr(`state write failed for ${file}: ${e?.message || e}`);
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

function acquireAutofireLock(stateFile) {
  const file = `${stateFile}.autofire.lock`;
  try {
    return { fd: fs.openSync(file, 'wx'), file };
  } catch {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs <= AUTOFIRE_LOCK_STALE_MS) return null;
      fs.rmSync(file, { force: true });
      return { fd: fs.openSync(file, 'wx'), file };
    } catch {
      return null;
    }
  }
}

function releaseAutofireLock(lock) {
  if (lock === null) return;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.rmSync(lock.file, { force: true }); } catch {}
}

function writeSensorState(stateFile, state) {
  if (process.env.CAPSULE_VERB_AUTOFIRE !== '1') return writeState(stateFile, state);
  const lock = acquireAutofireLock(stateFile);
  if (lock === null) return false;
  try {
    if (fs.existsSync(stateFile)) {
      let current;
      try {
        current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (e) {
        logErr(`state merge failed for ${stateFile}: ${e?.message || e}`);
        return false;
      }
      const hasCycle = Object.hasOwn(current, 'last_autofire_cycle_id');
      const hasLaunchedAt = Object.hasOwn(current, 'last_autofire_launched_at');
      if (hasCycle || hasLaunchedAt) {
        if (typeof current.last_autofire_cycle_id !== 'string'
          || current.last_autofire_cycle_id.length === 0
          || typeof current.last_autofire_launched_at !== 'number'
          || !Number.isFinite(current.last_autofire_launched_at)) {
          logErr(`state merge refused malformed launch claim in ${stateFile}`);
          return false;
        }
        state.last_autofire_cycle_id = current.last_autofire_cycle_id;
        state.last_autofire_launched_at = current.last_autofire_launched_at;
      }
    }
    return writeState(stateFile, state);
  } finally {
    releaseAutofireLock(lock);
  }
}

async function waitForAutofireLock(
  stateFile,
  timeoutMs = AUTOFIRE_LOCK_STALE_MS + 1_000,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const lock = acquireAutofireLock(stateFile);
    if (lock !== null) return lock;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return null;
}

async function recordCompletedAutofire(sid, cycleId, finalizedAtMs) {
  if (process.env.CAPSULE_VERB_AUTOFIRE !== '1') return;
  const stateFile = path.join(os.homedir(), '.claude', 'ctx-refresh', `${sid}.state`);
  const lock = await waitForAutofireLock(stateFile);
  if (lock === null) {
    logErr(`completed launch claim timed out waiting for state lock sid=${sid}`);
    return;
  }
  try {
    let state = {};
    if (fs.existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('launch state is not an object');
        }
        state = parsed;
      } catch (e) {
        logErr(`completed launch claim rebuilding unreadable state sid=${sid}: ${e?.message || e}`);
        state = {};
      }
    }
    if (state?.last_autofire_cycle_id
      && state.last_autofire_cycle_id !== cycleId) return;
    state.last_autofire_cycle_id = cycleId;
    state.last_autofire_launched_at = Math.max(
      Date.now(),
      Number.isFinite(finalizedAtMs) ? finalizedAtMs : 0,
    );
    if (!writeState(stateFile, state)) {
      logErr(`completed launch claim write failed sid=${sid}`);
    }
  } catch (e) {
    logErr(`completed launch claim failed sid=${sid}: ${e?.message || e}`);
  } finally {
    releaseAutofireLock(lock);
  }
}

async function launchRequestedAutofire(payload, sid, state, stateFile) {
  if (process.env.CAPSULE_VERB_AUTOFIRE !== '1') return;
  const root = String(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload?.cwd || '');
  if (!root) {
    logErr(`request intake failed sid=${sid}: project root unavailable`);
    return;
  }
  const memory = memoryRoot(root);
  const requestFile = path.join(memory, 'runtime', `refresh-request-${sid}.json`);
  if (!fs.existsSync(requestFile)) return;

  let readRequest;
  let lifecycle;
  try {
    [{ readRequest }, lifecycle] = await Promise.all([
      import('./refresh-request.mjs'),
      import('./lifecycle-common.mjs'),
    ]);
  } catch (e) {
    logErr(`request intake failed sid=${sid}: ${e?.message || e}`);
    return;
  }
  const request = readRequest(memory, sid);
  if (!request) return;
  const expiresMs = Date.parse(request.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return;
  const seatId = lifecycle.seatOf(root);

  const lock = acquireAutofireLock(stateFile);
  if (lock === null) return;
  try {
    let launchState = { ...state };
    if (fs.existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('launch state is not an object');
        }
        launchState = { ...launchState, ...parsed };
      } catch (e) {
        logErr(`request intake failed sid=${sid}: launch state unreadable: ${e?.message || e}`);
        return;
      }
    }

    if (request.cycle_id === launchState.last_autofire_cycle_id) {
      const curatedPointer = readCuratedPointer(root, memory, sid);
      const launchedAt = launchState.last_autofire_launched_at;
      if (curatedPointer === null
        || typeof launchedAt !== 'number'
        || !Number.isFinite(launchedAt)
        || curatedPointer.finalizedAtMs <= launchedAt) return;
    }

    launchState.last_autofire_cycle_id = request.cycle_id;
    launchState.last_autofire_launched_at = Date.now();
    if (!writeState(stateFile, launchState)) return;
    Object.assign(state, launchState);
    launchAutofire(payload, sid);
  } finally {
    releaseAutofireLock(lock);
  }
}

if (process.argv[2] === '--autofire-worker') {
  let deadline = null;
  try {
    const encoded = process.argv[3];
    if (!encoded) throw new Error('missing encoded worker payload');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    // The worker is detached from the 3s hook budget, but it is not immortal:
    // a wedged optional adapter must not accumulate orphan processes.
    const configuredStillDeadline = Number(process.env.CAPSULE_VERB_STILL_DEADLINE_MS);
    const stillDeadlineMs = Number.isInteger(configuredStillDeadline)
      && configuredStillDeadline > 0
      ? configuredStillDeadline
      : DEFAULT_STILL_DEADLINE_MS;
    const timeoutMs = payload?.transcriptPath
      ? Math.max(
        AUTOFIRE_COMPLETION_GRACE_MS,
        stillDeadlineMs + AUTOFIRE_COMPLETION_GRACE_MS,
      )
      : 30_000;
    deadline = setTimeout(() => {
      logAutofire(String(payload?.root || ''), {
        sid: typeof payload?.sid === 'string' ? payload.sid : null,
        outcome: 'timed_out',
        timeout_ms: timeoutMs,
      });
      process.exit(0);
    }, timeoutMs);
    await runAutofireWorker(payload);
  } catch (e) {
    logErr(`autofire worker bootstrap failed: ${e?.message || e}`);
  } finally {
    if (deadline !== null) clearTimeout(deadline);
  }
  process.exit(0);
}

try {
  const raw = readStdin();
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const sid = payload && payload.session_id;
  if (!sid) process.exit(0);

  const dir = path.join(os.homedir(), '.claude', 'ctx-refresh');
  const pctFile = path.join(dir, sid + '.json');
  const stateFile = path.join(dir, sid + '.state');

  let state = { fired: false, fires: 0, last_pct: null, last_emit_pct: 0, pct_read_failed: false };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state = { ...state, ...s, fired: s.fired === true, fires: Number(s.fires) || 0 };
  } catch { /* fresh session */ }

  let pct;
  if (!fs.existsSync(pctFile)) {
    // Normal when nothing writes a per-session percentage file (no statusline
    // integration wired), and also normal at session start before the first
    // render of one that is — silent either way.
    process.exit(0);
  }
  try {
    pct = JSON.parse(fs.readFileSync(pctFile, 'utf8')).used_percentage;
    if (typeof pct !== 'number' || Number.isNaN(pct)) throw new Error('used_percentage missing/NaN');
  } catch (e) {
    // The file EXISTS but is unreadable/malformed — the integration writing it
    // broke, which silently kills the whole 60% reflex. Log ONCE per session
    // (deduped via state) — this fires on every tool call otherwise.
    if (!state.pct_read_failed) {
      state.pct_read_failed = true;
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      await writeSensorState(stateFile, state);
      logErr(`pct file exists but unreadable for ${sid}: ${e?.message || e} — 60% reflex is BLIND this session`);
    }
    process.exit(0);
  }
  if (state.pct_read_failed) {
    state.pct_read_failed = false; // recovered — re-arm the one-shot logger
  }

  // A live coordination cycle (if a fork wires one) owns the lifecycle.
  if (coordinationActive()) process.exit(0);

  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  await launchRequestedAutofire(payload, sid, state, stateFile);
  const emit = (msg) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg },
    }));
  };
  const prevPct = typeof state.last_pct === 'number' ? state.last_pct : pct;
  state.last_pct = pct;

  // 1. Full re-arm: real headroom recovered → escalation counter resets too.
  if (pct < REARM_BELOW) {
    state.fired = false;
    state.fires = 0;
    state.last_emit_pct = 0;
    await writeSensorState(stateFile, state);
    process.exit(0);
  }

  // 2. Compaction detected (big single-step drop while fired) but still >50 —
  //    the compact didn't buy enough headroom. Escalate to /clear immediately.
  if (state.fired && pct <= prevPct - COMPACT_DROP) {
    state.fires += 1;
    state.last_emit_pct = pct;
    await writeSensorState(stateFile, state);
    emit(msgClear(pct, 'Compaction just ran but context is still above 50%'));
    process.exit(0);
  }

  // 3. Upward crossing while unarmed. fires≥2 means a prior crossing this
  //    session never fully re-armed — compact wasn't enough, go /clear.
  if (!state.fired && pct >= FIRE_AT) {
    state.fired = true;
    state.fires += 1;
    state.last_emit_pct = pct;
    await writeSensorState(stateFile, state);
    emit(pct >= HARD_AT
      ? msgClear(pct, `Past the ${HARD_AT}% hard line — refresh is mandatory now`)
      : state.fires >= 2
        ? msgClear(pct, 'Second 60% crossing without a full re-arm — /compact was not enough')
        : msgRefresh(pct));
    await launchRequestedAutofire(payload, sid, state, stateFile);
    process.exit(0);
  }

  // 4. Dead-zone re-nudge: fired, still ≥60, climbing — re-alert every +5
  //    points instead of going silent to 90%.
  if (state.fired && pct >= FIRE_AT && pct >= state.last_emit_pct + RENUDGE_STEP) {
    state.last_emit_pct = pct;
    await writeSensorState(stateFile, state);
    emit(pct >= HARD_AT
      ? msgClear(pct, `Past the ${HARD_AT}% hard line — refresh is mandatory now`)
      : state.fires >= 2
        ? msgClear(pct, 'Context still climbing after escalation')
        : msgRefresh(pct));
    process.exit(0);
  }

  await writeSensorState(stateFile, state);
  process.exit(0);
} catch (e) {
  logErr(`outer: ${e?.stack || e}`);
  process.exit(0);
}
