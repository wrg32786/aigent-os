#!/usr/bin/env node
// curated-close-pointer.mjs — the ONE write path for a curated-close pointer
// stamp. The capsule verb calls this instead of hand-writing the pointer, so
// every curated close carries the schema the clear-barrier verifies and the
// stop-writer's precedence check respects: trigger=curated-close + finalized_at +
// session_id.
//
//   node curated-close-pointer.mjs <capsule-path> [--session <sid>] \
//        [--cycle-token <tok>] [--reconciled <json>] \
//        [--cycle-id <uuid>] [--context-epoch <n>] [--captured-through-event <id>] \
//        [--capsule-sha256 <hex>] [--reconcile-digest <hex>] \
//        [--close-kind <checkpoint|completion|handoff>]
//   (capsule-path is POSITIONAL and must come FIRST; flags follow.)
//
// Pointer schema (v3): additive, default-null fields — no behavior change when
// unset.
//   --cycle-token <tok>  → cycle_token: per-refresh nonce; the CLEAR gate reads
//                          this. null outside a supervisor refresh (a fresh stamp
//                          with null OVERWRITES any prior token — no lingering replay).
//   --reconciled <json>  → reconciled: {board_rows:[], git_head} proof the reconcile
//                          ran (populated by the capsule verb). null until then.
//   --cycle-id <uuid>             → cycle_id: echoes the refresh-cycle record.
//   --context-epoch <n>           → context_epoch: integer, increments per clear.
//   --captured-through-event <id> → captured_through_event_id: monotonic capture
//                                    cursor for the quiescence barrier.
//   --capsule-sha256 <hex>        → capsule_sha256: evidence integrity.
//   --reconcile-digest <hex>      → reconcile_digest: canonical evidence-object digest.
// Nothing gates on any of these fields yet — this module only stamps schema.
//
// close_kind (board c1f777e9 gate round-1 F1 fix direction): an additional additive,
// default-null field, but UNLIKE the fields above it is a CLOSED enum, not a
// free-form value — an unrecognized --close-kind is refused loudly (fail()) rather
// than silently accepted. Same freshness-overwrite invariant: a fresh stamp without
// the flag OVERWRITES any prior close_kind. Absent/null close_kind is the fail-safe
// default downstream (non-waking) — shipping this field alone changes no behavior.
//   --close-kind <checkpoint|completion|handoff> → close_kind: the caller's stated
//                                    intent for THIS close. Nothing gates on it yet.
//
// Pointer shape: aigent-OS is single-operator, so the pointer always lives at
// <memRoot>/BODY_STATE.json's state.last_capsule — the same convention the
// context-capsule skill already documents. Session id: --session wins; else the
// newest <memRoot>/runtime/stop-writer/<sid>.json by mtime (the live session's
// state file — the stop-writer touches it every turn). No session resolvable ->
// stamps session_id:null and says so loudly (the barrier treats a null-session
// curated pointer as NOT satisfying the invariant).
//
// INVARIANT: fail LOUD, exit non-zero on a bad stamp — unlike the fire-and-forget
// Stop hook, this runs in a deliberate close sequence where the operator must see
// a failed precondition, not proceed-and-hope.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { memRoot, seatOf, CLOSE_KINDS } from './lifecycle-common.mjs';

function fail(msg) {
  console.error(`[curated-close-pointer] REFUSED: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const capArg = args.find((a) => !a.startsWith('--'));
const sessFlag = args.indexOf('--session');
const sessArg = sessFlag !== -1 ? args[sessFlag + 1] : null;

// Additive flags (default null). flagVal returns the value only when it is a real
// value (not another flag / not missing), so `--cycle-token` alone stays null.
const flagVal = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : null;
};
const cycleToken = flagVal('--cycle-token');
let reconciled = null;
const recRaw = flagVal('--reconciled');
if (recRaw) {
  try { reconciled = JSON.parse(recRaw); }
  catch { fail('--reconciled must be valid JSON, e.g. \'{"board_rows":["<id>"],"git_head":"<sha>"}\''); }
}

const cycleId = flagVal('--cycle-id');
const capturedThroughEventId = flagVal('--captured-through-event');
const capsuleSha256 = flagVal('--capsule-sha256');
const reconcileDigest = flagVal('--reconcile-digest');
let contextEpoch = null;
const epochRaw = flagVal('--context-epoch');
if (epochRaw !== null) {
  const n = Number(epochRaw);
  if (!Number.isInteger(n)) fail(`--context-epoch must be an integer, got: ${epochRaw}`);
  contextEpoch = n;
}
// Cursor fields travel as a PAIR ({event_id, offset}). The offset is the half most
// easily dropped by accident, and a receipt stamped without it can never verify.
// Additive, default null.
let capturedThroughOffset = null;
const ctoRaw = flagVal('--captured-through-offset');
if (ctoRaw !== null) {
  const n = Number(ctoRaw);
  if (!Number.isInteger(n) || n < 0) fail(`--captured-through-offset must be a non-negative integer, got: ${ctoRaw}`);
  capturedThroughOffset = n;
}

// close_kind is a CLOSED enum (unlike the free-form fields above) — refuse loudly on
// an unrecognized value rather than stamping something no downstream reader expects.
// CLOSE_KINDS is single-sourced in lifecycle-common.mjs (gate round-2 advisory: three
// unconnected literals across two repos) so this validation can never drift from
// whatever set every production caller was written against.
const closeKind = flagVal('--close-kind');
if (closeKind !== null && !CLOSE_KINDS.has(closeKind)) {
  fail(`--close-kind must be one of ${[...CLOSE_KINDS].join('|')}, got: ${closeKind}`);
}

if (!capArg) fail('usage: curated-close-pointer.mjs <capsule-path> [--session <sid>] [--cycle-token <tok>] [--reconciled <json>] [--cycle-id <uuid>] [--context-epoch <n>] [--captured-through-event <id>] [--captured-through-offset <n>] [--capsule-sha256 <hex>] [--reconcile-digest <hex>] [--close-kind <checkpoint|completion|handoff>]');

const root = String(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const seat = seatOf(root);
const MEM = memRoot(root);

const capPath = path.resolve(root, capArg);
if (!existsSync(capPath)) fail(`capsule not found: ${capPath}`);

// Frontmatter: id + objective + status. A curated capsule without an id is a
// malformed close — refuse rather than stamp a pointer at an unaddressable anchor.
const fm = readFileSync(capPath, 'utf8').split(/^---\s*$/m)[1] || '';
const fmField = (k) => ((fm.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm')) || [])[1] || '').replace(/^["']|["']$/g, '');
const id = fmField('id') || path.basename(capPath, '.md');
const objective = fmField('objective') || '(curated close)';
const status = fmField('status') || 'complete';

// Session id: explicit flag, else the newest stop-writer state file (the live session).
let sid = sessArg || null;
if (!sid) {
  try {
    const dir = path.join(MEM, 'runtime', 'stop-writer');
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (newest) sid = path.basename(newest.f, '.json');
  } catch { /* falls through to the loud null warning */ }
}
if (!sid) console.error('[curated-close-pointer] WARN: no session id resolvable — stamping session_id:null; the clear-barrier will NOT accept this pointer as a curated close for any session');

const pointer = {
  id,
  path: path.relative(root, capPath).replace(/\\/g, '/'),
  objective: objective.slice(0, 300),
  status,
  created_at: new Date().toISOString(),
  trigger: 'curated-close',
  finalized_at: new Date().toISOString(),
  session_id: sid,
  // Additive, default null. Explicit null on a fresh stamp OVERWRITES any prior
  // token (freshness-overwrite invariant). No gate reads these yet — cycle_token
  // gating and reconciled population are follow-on work.
  cycle_token: cycleToken,
  reconciled,
  cycle_id: cycleId,
  context_epoch: contextEpoch,
  captured_through_event_id: capturedThroughEventId,
  captured_through_offset: capturedThroughOffset,
  capsule_sha256: capsuleSha256,
  reconcile_digest: reconcileDigest,
  // close_kind (board c1f777e9 F1): additive, default null, freshness-overwrite —
  // same discipline as the fields above, but CLOSED enum (validated pre-write).
  close_kind: closeKind,
};

const bsPath = path.join(MEM, 'BODY_STATE.json');
let bs;
try { bs = JSON.parse(readFileSync(bsPath, 'utf8')); } catch (e) { fail(`BODY_STATE.json unreadable: ${e?.message || e}`); }
if (!bs?.state) fail('BODY_STATE.json has no .state — pointer not stamped');
bs.state.last_capsule = { ...bs.state.last_capsule, ...pointer };
writeFileSync(bsPath, JSON.stringify(bs, null, 2));

console.log(`[curated-close-pointer] STAMPED ${seat}: ${id} (session ${sid ?? 'null'}, finalized ${pointer.finalized_at}, cycle_token ${cycleToken ?? 'null'}, cycle_id ${cycleId ?? 'null'}, context_epoch ${contextEpoch ?? 'null'}, captured_through_event_id ${capturedThroughEventId ?? 'null'}, captured_through_offset ${capturedThroughOffset ?? 'null'}, capsule_sha256 ${capsuleSha256 ?? 'null'}, reconcile_digest ${reconcileDigest ?? 'null'}, close_kind ${closeKind ?? 'null'})`);
