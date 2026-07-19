// curated-cross-session-rotation.test.mjs — the two-verb refresh livelock fix
// (upstream board c1f777e9).
//
// The livelock: a valid finalized curated-close pointer became INVISIBLE to both
// the stop-writer's clobber protection (curatedPointerWins) and the autofire's
// curated preference (readCuratedPointer) the moment the session id rotated away
// from the stamping session — both sites gated on raw session_id equality. The
// rolling skeleton then won the pointer every turn, the skeleton gate deferred
// every autofire poll, and the seal never ran.
//
// Post-fix, a curated-close pointer stamped by a DIFFERENT session stays
// authoritative iff ALL of:
//   (1) trigger curated-close + finalized_at real + within SCW_CURATED_WIN_MS;
//   (2) boot-evidence.json proves the LIVE session was not born from a clear
//       (sid === live sid AND source !== 'clear'); stale/absent evidence fails
//       CLOSED (the old cross-session behavior);
//   (3) the pointed-at capsule is not status:resumed (a consumed close must never
//       be re-protected or re-sealed).
// boot-evidence.json is stamped by sessionstart-reinject.mjs on EVERY source —
// the S0 tests prove that wiring through the real daemon.
//
// Runs the REAL daemons against temp-dir fixtures — no mocking. Override under
// test with SCW_DAEMON / SENSOR_DAEMON / SSR_DAEMON env vars.
'use strict';

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCW = process.env.SCW_DAEMON || path.resolve(__dirname, '..', 'stop-capsule-writer.mjs');
const SENSOR = process.env.SENSOR_DAEMON || path.resolve(__dirname, '..', 'ctx-refresh-sensor.mjs');
const SSR = process.env.SSR_DAEMON || path.resolve(__dirname, '..', 'sessionstart-reinject.mjs');

let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`); }
}

const LIVE_SID = 'sess-live-2222';
const OLD_SID = 'sess-old-1111';

const BODY = `\n## Done (don't redo)\n<!-- swe:done -->\n\n## Pending-Gates\n<!-- swe:gates -->\n`;

// A curated close capsule. status 'active' + real waiting_on = finalized
// open-thread close (the exact livelock shape: valid, sealable, waiting on a gate).
const curatedCap = (id, status, waitingOn) =>
  `---\nid: ${id}\nstatus: ${status}\nobjective: "curated close of the session"\nwaiting_on: ${waitingOn}\nresume_trigger: none\nnext_valid_action: "act on waiting_on"\n---\n${BODY}`;

// The stop-writer's own skeleton shape (waiting_on null — finalize never ran).
const skeletonCap = (id) =>
  `---\nid: ${id}\nparent_capsule_id: null\nstatus: active\nobjective: "Auto-captured working state"\nwaiting_on: null\nresume_trigger: compact\ntrigger: stop-delta\nnext_valid_action: "Re-ground and continue"\ntags: [capsule, autosave]\n---\n${BODY}`;

function mkSeat(label) {
  const base = path.join(os.tmpdir(), `ccsr-${label}-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  const root = path.join(base, 'aigent-root');
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  mkdirSync(path.join(root, 'memory', 'runtime', 'stop-writer'), { recursive: true });
  return { base, root };
}

function writeBootEvidence(root, sid, source) {
  writeFileSync(
    path.join(root, 'memory', 'runtime', 'boot-evidence.json'),
    JSON.stringify({ sid, source, ts: Date.now() }, null, 1),
  );
}

// Single-operator pointer convention: memory/BODY_STATE.json state.last_capsule.
function writeCuratedPointer(root, { sessionId = OLD_SID, finalizedAgoMs = 5 * 60e3, capRel = 'memory/capsules/capsule-CUR.md' } = {}) {
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'capsule-CUR', path: capRel, objective: 'closed clean', status: 'complete',
        created_at: new Date().toISOString(), trigger: 'curated-close',
        finalized_at: new Date(Date.now() - finalizedAgoMs).toISOString(), session_id: sessionId,
      },
    },
  }));
}

function readPointer(root) {
  return JSON.parse(readFileSync(path.join(root, 'memory', 'BODY_STATE.json'), 'utf8')).state.last_capsule;
}

// Drive the REAL stop-writer worker one turn for the LIVE session.
function runStopWriter(root, base) {
  const capsuleB = path.join(root, 'memory', 'capsules', 'capsule-B.md');
  writeFileSync(
    path.join(root, 'memory', 'runtime', 'stop-writer', `${LIVE_SID}.json`),
    JSON.stringify({ offset: 0, capsule_path: capsuleB, last_delta_sha: null }),
  );
  const transcript = path.join(base, `transcript-${LIVE_SID}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'delta ' + LIVE_SID }] } }) + '\n');
  const payload = JSON.stringify({ __root: root, session_id: LIVE_SID, transcript_path: transcript });
  return execFileSync(process.execPath, [SCW, '--worker', payload], { encoding: 'utf8', env: { ...process.env } });
}

// Drive the REAL autofire worker for the LIVE session (legacy mode). The rolling
// stop-writer capsule for LIVE_SID is a skeleton, so any outcome OTHER than
// skipped_skeleton proves the worker resolved the curated capsule instead.
function runAutofire(root) {
  const rolling = path.join(root, 'memory', 'capsules', 'capsule-ROLL.md');
  writeFileSync(rolling, skeletonCap('capsule-ROLL'));
  writeFileSync(
    path.join(root, 'memory', 'runtime', 'stop-writer', `${LIVE_SID}.json`),
    JSON.stringify({ capsule_path: rolling }),
  );
  const payload = Buffer.from(JSON.stringify({ root, sid: LIVE_SID, eventId: null, transcriptPath: null }), 'utf8')
    .toString('base64url');
  const r = spawnSync(process.execPath, [SENSOR, '--autofire-worker', payload], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: root },
  });
  return { r, rolling };
}

function lastAutofireEntry(root) {
  const p = path.join(root, 'memory', 'runtime', 'capsule-verb-autofire.jsonl');
  try {
    const entries = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return entries[entries.length - 1] ?? null;
  } catch { return null; }
}

// Drive the REAL sessionstart-reinject for a given boot source.
function runReinject(root, sid, source) {
  return execFileSync(process.execPath, [SSR], {
    encoding: 'utf8',
    input: JSON.stringify({ source, session_id: sid, cwd: root }),
    env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: root },
  });
}

console.log(`── curated cross-session rotation (livelock fix) — scw: ${SCW} ──`);

// ─── S0: boot-evidence stamping through the REAL reinject (every source) ───

// S0-A: a resume boot stamps {sid, source:'resume'}.
{
  const { base, root } = mkSeat('s0a');
  runReinject(root, LIVE_SID, 'resume');
  const p = path.join(root, 'memory', 'runtime', 'boot-evidence.json');
  ok(existsSync(p), 'S0-A stamp: boot-evidence.json written on a resume boot');
  const boot = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  ok(boot.sid === LIVE_SID && boot.source === 'resume',
    'S0-A stamp: records the live sid + source verbatim', JSON.stringify(boot));
  rmSync(base, { recursive: true, force: true });
}

// S0-B: a clear boot stamps source:'clear' (the Case-A record).
{
  const { base, root } = mkSeat('s0b');
  runReinject(root, LIVE_SID, 'clear');
  const p = path.join(root, 'memory', 'runtime', 'boot-evidence.json');
  const boot = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  ok(boot.sid === LIVE_SID && boot.source === 'clear',
    'S0-B stamp: a clear boot is recorded as source=clear', JSON.stringify(boot));
  rmSync(base, { recursive: true, force: true });
}

// S0-C: SEAT_BOOT_EVIDENCE_SKIP=1 children never overwrite the seat's record.
{
  const { base, root } = mkSeat('s0c');
  writeBootEvidence(root, LIVE_SID, 'resume');
  execFileSync(process.execPath, [SSR], {
    encoding: 'utf8',
    input: JSON.stringify({ source: 'startup', session_id: 'sess-child-9999', cwd: root }),
    env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: root, SEAT_BOOT_EVIDENCE_SKIP: '1' },
  });
  const boot = JSON.parse(readFileSync(path.join(root, 'memory', 'runtime', 'boot-evidence.json'), 'utf8'));
  ok(boot.sid === LIVE_SID && boot.source === 'resume',
    'S0-C skip: a SEAT_BOOT_EVIDENCE_SKIP child leaves the seat record untouched', JSON.stringify(boot));
  rmSync(base, { recursive: true, force: true });
}

// ─── SITE 1: stop-capsule-writer curatedPointerWins() ───

// S1-A ROTATION WITHOUT CLEAR (the livelock, RED pre-fix): curated pointer stamped
// by OLD_SID; live session booted source=resume. Stop-delta must NOT clobber it.
{
  const { base, root } = mkSeat('s1a');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'complete', 'null'));
  writeCuratedPointer(root);
  writeBootEvidence(root, LIVE_SID, 'resume');
  const out = runStopWriter(root, base);
  const after = readPointer(root);
  ok(out.includes('SWE_OUTCOME:flushed'), 'S1-A rotation-no-clear: worker flushed');
  ok(after.id === 'capsule-CUR' && after.trigger === 'curated-close',
    'S1-A rotation-no-clear: rotated-but-not-cleared curated close survives the stop-delta tail',
    JSON.stringify(after));
  rmSync(base, { recursive: true, force: true });
}

// S1-B CLEAR-BORN SESSION (Case-A guard): live session booted source=clear —
// the rotation crossed a clear; clobber is CORRECT.
{
  const { base, root } = mkSeat('s1b');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'complete', 'null'));
  writeCuratedPointer(root);
  writeBootEvidence(root, LIVE_SID, 'clear');
  runStopWriter(root, base);
  const after = readPointer(root);
  ok(after.id !== 'capsule-CUR' && after.trigger === 'stop-delta',
    'S1-B clear-born: a post-clear session repoints past the pre-clear curated close (Case-A preserved)',
    JSON.stringify(after));
  rmSync(base, { recursive: true, force: true });
}

// S1-C CONSUMED CAPSULE: rotation without clear, but the capsule is status:resumed.
{
  const { base, root } = mkSeat('s1c');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'resumed', '"still open"'));
  writeCuratedPointer(root);
  writeBootEvidence(root, LIVE_SID, 'resume');
  runStopWriter(root, base);
  const after = readPointer(root);
  ok(after.id !== 'capsule-CUR' && after.trigger === 'stop-delta',
    'S1-C consumed: a status:resumed capsule is never re-protected cross-session',
    JSON.stringify(after));
  rmSync(base, { recursive: true, force: true });
}

// S1-D NO BOOT EVIDENCE (fail-closed): cross-session clobber stays allowed.
{
  const { base, root } = mkSeat('s1d');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'complete', 'null'));
  writeCuratedPointer(root);
  runStopWriter(root, base);
  const after = readPointer(root);
  ok(after.id !== 'capsule-CUR' && after.trigger === 'stop-delta',
    'S1-D no-evidence: absent boot-evidence fails closed (old cross-session behavior)',
    JSON.stringify(after));
  rmSync(base, { recursive: true, force: true });
}

// S1-E STALE BOOT EVIDENCE: record belongs to some OTHER session → fail closed.
{
  const { base, root } = mkSeat('s1e');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'complete', 'null'));
  writeCuratedPointer(root);
  writeBootEvidence(root, 'sess-somebody-else', 'resume');
  runStopWriter(root, base);
  const after = readPointer(root);
  ok(after.id !== 'capsule-CUR' && after.trigger === 'stop-delta',
    'S1-E stale-evidence: boot-evidence for a different sid fails closed',
    JSON.stringify(after));
  rmSync(base, { recursive: true, force: true });
}

// S1-F WINDOW LAPSE: rotation without clear but finalized 2h ago — still bounded.
{
  const { base, root } = mkSeat('s1f');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'complete', 'null'));
  writeCuratedPointer(root, { finalizedAgoMs: 2 * 3600e3 });
  writeBootEvidence(root, LIVE_SID, 'resume');
  runStopWriter(root, base);
  const after = readPointer(root);
  ok(after.id !== 'capsule-CUR' && after.trigger === 'stop-delta',
    'S1-F window-lapse: cross-session protection stays window-bounded',
    JSON.stringify(after));
  rmSync(base, { recursive: true, force: true });
}

// ─── SITE 2: ctx-refresh-sensor readCuratedPointer() / the autofire seal ───

// S2-A THE LIVELOCK REPRO (RED pre-fix): finalized curated close stamped by
// OLD_SID; session rotated WITHOUT a clear; rolling capsule is a skeleton. The
// autofire must resolve the CURATED capsule — not defer on the skeleton forever.
{
  const { base, root } = mkSeat('s2a');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'),
    curatedCap('capsule-CUR', 'active', '"review gate on the staged package"'));
  writeCuratedPointer(root);
  writeBootEvidence(root, LIVE_SID, 'resume');
  const { r } = runAutofire(root);
  ok(r.status === 0, 'S2-A rotation-no-clear: worker exits 0', r.stderr || '');
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome !== 'skipped_skeleton',
    `S2-A rotation-no-clear: autofire seals the curated close instead of deferring on the rolling skeleton (outcome ${last?.outcome})`,
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S2-B CLEAR-BORN SESSION (Case-A guard): source=clear → excluded → skeleton defer.
{
  const { base, root } = mkSeat('s2b');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'),
    curatedCap('capsule-CUR', 'active', '"review gate on the staged package"'));
  writeCuratedPointer(root);
  writeBootEvidence(root, LIVE_SID, 'clear');
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S2-B clear-born: pre-clear curated close stays excluded; falls back to the rolling anchor',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S2-C CONSUMED CAPSULE: rotation without clear, capsule status:resumed → excluded.
{
  const { base, root } = mkSeat('s2c');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'),
    curatedCap('capsule-CUR', 'resumed', '"still open"'));
  writeCuratedPointer(root);
  writeBootEvidence(root, LIVE_SID, 'resume');
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S2-C consumed: a status:resumed capsule is never re-sealed cross-session',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S2-D NO BOOT EVIDENCE: fail closed → rolling skeleton → defer.
{
  const { base, root } = mkSeat('s2d');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'),
    curatedCap('capsule-CUR', 'active', '"review gate on the staged package"'));
  writeCuratedPointer(root);
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S2-D no-evidence: absent boot-evidence fails closed at the autofire too',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S2-E SAME-SESSION FAST PATH UNTOUCHED: pointer stamped by the LIVE session —
// accepted with no boot-evidence at all (pre-fix behavior, must not regress).
{
  const { base, root } = mkSeat('s2e');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'),
    curatedCap('capsule-CUR', 'active', '"review gate on the staged package"'));
  writeCuratedPointer(root, { sessionId: LIVE_SID });
  const { r } = runAutofire(root);
  ok(r.status === 0, 'S2-E same-session: worker exits 0', r.stderr || '');
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome !== 'skipped_skeleton',
    `S2-E same-session: live-session curated pointer accepted without boot-evidence (outcome ${last?.outcome})`,
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// ─── F2: null-session pointers stay HARD-REJECTED ───
// curated-close-pointer.mjs deliberately stamps session_id:null when no --session
// and no stop-writer record exists (fresh install / wiped runtime). Raw !==
// accidentally hard-rejected these; the cross-session branch must never
// conditionally accept them, even with qualifying boot-evidence.

// S1-G (site 1): null-sid pointer + qualifying evidence → clobber still allowed.
{
  const { base, root } = mkSeat('s1g');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'complete', 'null'));
  writeCuratedPointer(root, { sessionId: null });
  writeBootEvidence(root, LIVE_SID, 'resume');
  runStopWriter(root, base);
  const after = readPointer(root);
  ok(after.id !== 'capsule-CUR' && after.trigger === 'stop-delta',
    'S1-G null-sid: a session_id:null pointer is never cross-session protected',
    JSON.stringify(after));
  rmSync(base, { recursive: true, force: true });
}

// S2-F (site 2): null-sid pointer + qualifying evidence → skeleton defer.
{
  const { base, root } = mkSeat('s2f');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), curatedCap('capsule-CUR', 'complete', 'null'));
  writeCuratedPointer(root, { sessionId: null });
  writeBootEvidence(root, LIVE_SID, 'resume');
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S2-F null-sid: a session_id:null pointer is never cross-session sealed',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// ─── S3: THE SHIP-BAR REPRO — real stamper + real SessionStart flip ───
// Drives the REAL curated-close-pointer.mjs stamping, the REAL merged
// sessionstart-reinject (which stamps boot-evidence AND owns the resume-flip),
// then the REAL autofire — proving the seal fires within one cycle. The
// structural gap this closes: fixtures that write pointers directly and never
// run the real SessionStart cannot see the flip consuming the close before the
// first poll.

const CCP = process.env.CCP_DAEMON || path.resolve(__dirname, '..', 'curated-close-pointer.mjs');

function capsuleStatus(root, rel) {
  const doc = readFileSync(path.join(root, rel), 'utf8');
  return (doc.match(/^status:[ \t]*['"]?(\S+?)['"]?[ \t]*$/m) || [])[1] || '';
}

function runRealStamp(root, capRel, sid) {
  // The single-operator stamper spread-merges into BODY_STATE.json — seed it.
  const bs = path.join(root, 'memory', 'BODY_STATE.json');
  if (!existsSync(bs)) writeFileSync(bs, JSON.stringify({ state: {} }));
  return execFileSync(process.execPath, [CCP, capRel, '--session', sid],
    { encoding: 'utf8', cwd: root, env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: root } });
}

// S3-A: the livelock end to end through the REAL machinery. Session OLD stamps a
// curated close (real stamper, real status:active capsule) → rotation to LIVE via
// a non-clear boot (real reinject: boot-evidence stamp + flip decision) →
// autofire polls once → MUST seal the close, not skip.
{
  const { base, root } = mkSeat('s3a');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-REAL.md'),
    curatedCap('capsule-REAL', 'active', '"review gate on the staged package"'));
  runRealStamp(root, 'memory/capsules/capsule-REAL.md', OLD_SID);
  const ptr = JSON.parse(readFileSync(path.join(root, 'memory', 'BODY_STATE.json'), 'utf8')).state.last_capsule;
  ok(ptr.trigger === 'curated-close' && ptr.session_id === OLD_SID && ptr.status === 'active',
    'S3-A real-stamp: pointer carries the REAL schema (trigger, sid, status:active)', JSON.stringify(ptr));

  runReinject(root, LIVE_SID, 'resume');
  ok(capsuleStatus(root, 'memory/capsules/capsule-REAL.md') === 'active',
    'S3-A real-flip: a curated close awaiting seal is NOT consumed by a rotation boot',
    capsuleStatus(root, 'memory/capsules/capsule-REAL.md'));

  const { r } = runAutofire(root);
  ok(r.status === 0, 'S3-A: autofire worker exits 0', r.stderr || '');
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome !== 'skipped_skeleton',
    `S3-A SHIP BAR: seal fires within ONE cycle through the real stamp+flip (outcome ${last?.outcome})`,
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S3-B: Case-A stays closed end to end — a CLEAR boot consumes the close (real
// reinject flip on the clear path) and the autofire correctly falls back.
{
  const { base, root } = mkSeat('s3b');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-REAL.md'),
    curatedCap('capsule-REAL', 'active', '"review gate on the staged package"'));
  runRealStamp(root, 'memory/capsules/capsule-REAL.md', OLD_SID);
  // stop-writer record for OLD (the session being cleared) so the clear-barrier resolves it
  writeFileSync(path.join(root, 'memory', 'runtime', 'stop-writer', `${OLD_SID}.json`),
    JSON.stringify({ capsule_path: path.join(root, 'memory', 'capsules', 'capsule-REAL.md') }));

  runReinject(root, LIVE_SID, 'clear');
  ok(capsuleStatus(root, 'memory/capsules/capsule-REAL.md') === 'resumed',
    'S3-B clear-boot: the clear-path flip still consumes the close (Case-A trace intact)',
    capsuleStatus(root, 'memory/capsules/capsule-REAL.md'));

  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S3-B Case-A: post-clear session never seals the pre-clear close',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// ─── S4: CLASS SIX — freeze-branch completion pointers (board c1f777e9) ───
// The stop-writer's finalize-freeze branch stamps the pointer DIRECTLY:
// trigger:'stop-delta' + close_kind:'completion' + created_at only — no finalized_at.
// The staged-close WAKE gate discriminates on close_kind alone, but this worker's
// readCuratedPointer kept the stale trigger predicate — every REAL completion stamp
// was invisible, the worker fell back to the fresh skeleton, and the seat livelocked
// (mint → skipped_skeleton → hold-starve → abort → re-arm). close_kind is the
// authoritative discriminator (closed enum, trusted writers only); freshness falls
// back to created_at for completion stamps only. Case-A / consumed / window guards
// must NOT move.

const frozenCap = (id, status = 'active') =>
  curatedCap(id, status, '"Titus Rule-26 gate on the staged package"');

// EXACTLY the freeze branch's stamp shape: no finalized_at, trigger stays
// stop-delta, close_kind carries the intent.
function writeFreezePointer(root, { sessionId = LIVE_SID, createdAgoMs = 5 * 60e3, capRel = 'memory/capsules/capsule-FROZEN.md', closeKind = 'completion' } = {}) {
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'capsule-FROZEN', path: capRel,
        objective: 'In-flight work (auto-captured; see latest session log)', status: 'active',
        created_at: new Date(Date.now() - createdAgoMs).toISOString(), trigger: 'stop-delta',
        session_id: sessionId, close_kind: closeKind,
      },
    },
  }));
}

// S4-A THE CLASS-SIX REPRO (RED pre-fix): same-session freeze pointer targeting a
// finalized frozen capsule; rolling record is a fresh skeleton. The worker must seal
// the POINTER capsule, not defer on the skeleton.
{
  const { base, root } = mkSeat('s4a');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-FROZEN.md'), frozenCap('capsule-FROZEN'));
  writeFreezePointer(root);
  const { r } = runAutofire(root);
  ok(r.status === 0, 'S4-A freeze-pointer: worker exits 0', r.stderr || '');
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome !== 'skipped_skeleton',
    `S4-A CLASS SIX: a stop-delta + close_kind:completion pointer is sealable — no skeleton defer (outcome ${last?.outcome})`,
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-B CHECKPOINT STAMPS STAY INVISIBLE to the worker.
{
  const { base, root } = mkSeat('s4b');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-FROZEN.md'), frozenCap('capsule-FROZEN'));
  writeFreezePointer(root, { closeKind: 'checkpoint' });
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S4-B checkpoint: a close_kind:checkpoint stop-delta pointer stays invisible to the worker',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-C NULL close_kind — every ORDINARY rolling stop-delta stamp stays invisible.
{
  const { base, root } = mkSeat('s4c');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-FROZEN.md'), frozenCap('capsule-FROZEN'));
  writeFreezePointer(root, { closeKind: null });
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S4-C null close_kind: an ordinary rolling stop-delta pointer stays invisible to the worker',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-D CROSS-SESSION completion pointer, rotation WITHOUT clear, inside the window
// (created_at freshness): still THE close to seal.
{
  const { base, root } = mkSeat('s4d');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-FROZEN.md'), frozenCap('capsule-FROZEN'));
  writeFreezePointer(root, { sessionId: OLD_SID });
  writeBootEvidence(root, LIVE_SID, 'resume');
  const { r } = runAutofire(root);
  ok(r.status === 0, 'S4-D cross-session: worker exits 0', r.stderr || '');
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome !== 'skipped_skeleton',
    `S4-D cross-session completion pointer seals on rotation-no-clear (outcome ${last?.outcome})`,
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-E CROSS-SESSION, WINDOW LAPSED via created_at.
{
  const { base, root } = mkSeat('s4e');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-FROZEN.md'), frozenCap('capsule-FROZEN'));
  writeFreezePointer(root, { sessionId: OLD_SID, createdAgoMs: 2 * 3600e3 });
  writeBootEvidence(root, LIVE_SID, 'resume');
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S4-E window-lapse: cross-session completion protection stays window-bounded on created_at',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-F CLEAR-BORN SESSION: Case-A holds for completion pointers too.
{
  const { base, root } = mkSeat('s4f');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-FROZEN.md'), frozenCap('capsule-FROZEN'));
  writeFreezePointer(root, { sessionId: OLD_SID });
  writeBootEvidence(root, LIVE_SID, 'clear');
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S4-F clear-born: a post-clear session never seals the pre-clear completion stamp (Case-A)',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-G CONSUMED: a status:resumed frozen capsule is never re-sealed cross-session.
{
  const { base, root } = mkSeat('s4g');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-FROZEN.md'), frozenCap('capsule-FROZEN', 'resumed'));
  writeFreezePointer(root, { sessionId: OLD_SID });
  writeBootEvidence(root, LIVE_SID, 'resume');
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S4-G consumed: a status:resumed frozen capsule is never re-sealed cross-session',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-H strictness kept at the worker: curated trigger + created_at only (no
// finalized_at, no completion stamp) stays invisible, exactly as pre-fix.
{
  const { base, root } = mkSeat('s4h');
  writeFileSync(path.join(root, 'memory', 'capsules', 'capsule-CUR.md'), frozenCap('capsule-CUR'));
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'capsule-CUR', path: 'memory/capsules/capsule-CUR.md', objective: 'no finalized_at',
        status: 'active', created_at: new Date().toISOString(), trigger: 'curated-close',
        session_id: LIVE_SID,
      },
    },
  }));
  const { rolling } = runAutofire(root);
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome === 'skipped_skeleton' && last.capsule_path === rolling,
    'S4-H a curated-trigger pointer without finalized_at stays invisible to the worker (pre-fix strictness)',
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// S4-R SHIP BAR — the REAL race: the seat finalizes its rolling capsule (the proven
// F2 recovery play), the very next Stop freezes it and repoints the record to a
// fresh skeleton BEFORE the worker's poll — the worker must seal the frozen capsule
// via the pointer. Drives the REAL stop-writer freeze branch, no hand-written
// pointers.
function runStopWriterAt(root, base, capsulePath) {
  writeFileSync(path.join(root, 'memory', 'runtime', 'stop-writer', `${LIVE_SID}.json`),
    JSON.stringify({ offset: 0, capsule_path: capsulePath, last_delta_sha: null }));
  const transcript = path.join(base, `transcript-${LIVE_SID}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'delta ' + LIVE_SID }] } }) + '\n');
  const payload = JSON.stringify({ __root: root, session_id: LIVE_SID, transcript_path: transcript });
  return execFileSync(process.execPath, [SCW, '--worker', payload], { encoding: 'utf8', env: { ...process.env } });
}
{
  const { base, root } = mkSeat('s4r');
  // The single-operator stamper spread-merges into BODY_STATE.json — seed the shell
  // (same fixture convention as the fleet suite's Titus-seat S3 tests).
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  const rolling = path.join(root, 'memory', 'capsules', 'capsule-ROLL.md');
  writeFileSync(rolling, frozenCap('capsule-ROLL'));
  runStopWriterAt(root, base, rolling);
  const ptr = readPointer(root);
  ok(!!ptr && ptr.trigger === 'stop-delta' && ptr.close_kind === 'completion',
    'S4-R real freeze: the next Stop freezes the finalized rolling capsule and stamps the completion pointer',
    JSON.stringify(ptr));
  const record = JSON.parse(readFileSync(path.join(root, 'memory', 'runtime', 'stop-writer', `${LIVE_SID}.json`), 'utf8'));
  ok(typeof record.capsule_path === 'string' && path.resolve(record.capsule_path) !== path.resolve(rolling),
    'S4-R real freeze: the rolling record repoints to a fresh skeleton (the race is armed)',
    String(record.capsule_path));
  const payload = Buffer.from(JSON.stringify({ root, sid: LIVE_SID, eventId: null, transcriptPath: null }), 'utf8')
    .toString('base64url');
  const r = spawnSync(process.execPath, [SENSOR, '--autofire-worker', payload], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: root },
  });
  ok(r.status === 0, 'S4-R: worker exits 0', r.stderr || '');
  const last = lastAutofireEntry(root);
  ok(!!last && last.outcome !== 'skipped_skeleton',
    `S4-R SHIP BAR: after a REAL finalize→freeze, the worker seals the frozen capsule via the pointer (outcome ${last?.outcome})`,
    JSON.stringify(last));
  rmSync(base, { recursive: true, force: true });
}

// ─── S5: the SAME discriminator at the boot-flip defer (third reader) ───
const lifecycleHref = (await import('node:url')).pathToFileURL(path.join(path.dirname(SENSOR), 'lifecycle-common.mjs')).href;
const { resumeFlipShouldDefer } = await import(lifecycleHref);
const freezePtr = (agoMs, closeKind = 'completion') => ({
  trigger: 'stop-delta', close_kind: closeKind,
  created_at: new Date(Date.now() - agoMs).toISOString(),
});
ok(resumeFlipShouldDefer(freezePtr(5 * 60e3), 'resume') === true,
  'S5-A a fresh completion stamp defers the rotation-boot flip (RED pre-fix)');
ok(resumeFlipShouldDefer(freezePtr(5 * 60e3), 'clear') === false,
  'S5-B a clear boot always flips — Case-A consumption preserved');
ok(resumeFlipShouldDefer(freezePtr(5 * 60e3, 'checkpoint'), 'resume') === false
  && resumeFlipShouldDefer(freezePtr(5 * 60e3, null), 'resume') === false,
  'S5-C checkpoint / ordinary rolling stamps never defer (unchanged)');
ok(resumeFlipShouldDefer(freezePtr(2 * 3600e3), 'resume') === false,
  'S5-D a lapsed completion stamp does not defer (window on created_at)');
ok(resumeFlipShouldDefer({ trigger: 'curated-close', finalized_at: new Date(Date.now() - 5 * 60e3).toISOString() }, 'resume') === true,
  'S5-E curated-trigger defer behavior unchanged');
ok(resumeFlipShouldDefer({ trigger: 'curated-close', created_at: new Date().toISOString() }, 'resume') === false,
  'S5-F a curated-trigger pointer without finalized_at never defers (orient flip contract)');

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
