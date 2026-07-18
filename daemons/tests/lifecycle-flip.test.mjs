// lifecycle-flip.test.mjs — resume-flip regression suite for sessionstart-reinject.mjs.
//
// aigent-OS is single-operator, so there is ONE SessionStart hook (unlike the
// private origin of this port, which split warm-start reinject across two
// per-agent scripts — see sessionstart-reinject.mjs's header). This suite proves,
// against that single merged hook:
//   - the flip: status active→resumed, stamps written, dedupe applied
//   - CONFIRMED-1: the pre-seeded null-placeholder pair is DEDUPED, never duplicated
//   - CONFIRMED-3/v3: CRLF capsules keep CRLF line endings — delimiters included
//   - CONFIRMED-5: already-resumed is STEADY-STATE (not drift, not an error)
//   - malformed frontmatter logs, never a silent no-op
//   - compact is NOT a resume — capsule untouched
//   - clear ALWAYS flips (boot-native Case-A consumption); startup/resume flip
//     UNLESS the pointer is a curated close inside its seal window — that close
//     is AWAITING SEAL and the flip DEFERS (the livelock fix: consuming it
//     handed the autofire's consumed-gate the exact close it protects). A
//     stale-window or non-curated pointer flips on rotation boots as before.
//
// FIXTURE SHAPE: field list/order and the null-placeholder pair mirror a real
// autosave capsule's frontmatter shape (see stop-capsule-writer.mjs's skeleton()).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REINJECT = path.join(path.resolve(__dirname, '..'), 'sessionstart-reinject.mjs');

let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`); }
}

const BODY_QUOTE = 'The incident line said "status: active" verbatim — never touch me.';

// `placeholder` controls whether the pre-seeded null pair is present (the real,
// current shape); `resumedStamp` lets a caller pre-seed an ALREADY-flipped
// capsule (steady-state fixtures) instead of the null placeholder.
function realFrontmatter({ status = 'active', eol = '\n', placeholder = true, resumedStamp = null, closed = true } = {}) {
  const lines = [
    '---',
    'id: test-capsule',
    'parent_capsule_id: null',
    `status: ${status}`,
  ];
  if (resumedStamp) {
    lines.push(`resumed_at: ${resumedStamp.at}`, `resumed_by_session: ${resumedStamp.by}`);
  } else if (placeholder) {
    lines.push('resumed_at: null', 'resumed_by_session: null');
  }
  lines.push(
    'waiting_on: "review gate"',
    'resume_trigger: open',
    'expires: 2026-12-31T00:00:00Z',
    'trigger: refresh-cycle',
    'definition_hash: PENDING_HASH',
    'objective: "prove the flip"',
    'next_valid_action: "resume the ladder"',
    'success_criteria: []',
    'tags: [capsule, test]',
    'created_at: 2026-07-17T00:00:00.000Z',
    'resolved_at: null',
  );
  if (closed) lines.push('---');
  lines.push('', BODY_QUOTE, '');
  return lines.join(eol);
}

function fixture(label, opts = {}) {
  const base = path.join(os.tmpdir(), `lifecycle-flip-${label}-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  const root = path.join(base, 'test-seat');
  const capDir = path.join(root, 'memory', 'capsules');
  mkdirSync(path.join(root, 'memory', 'runtime'), { recursive: true });
  mkdirSync(capDir, { recursive: true });
  const capPath = path.join(capDir, 'test-capsule.md');
  writeFileSync(capPath, realFrontmatter(opts));
  // Pointer defaults to the curated-close-in-window shape (a close AWAITING
  // SEAL — the defer path). Flip-mechanics tests override pointerTrigger or
  // pointerFinalizedAgoMs to stay on the flip path.
  const { pointerTrigger = 'curated-close', pointerFinalizedAgoMs = 0 } = opts;
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'test-capsule',
        path: 'memory/capsules/test-capsule.md',
        status: 'active',
        objective: 'prove the flip',
        trigger: pointerTrigger,
        session_id: 'prev-sid',
        finalized_at: new Date(Date.now() - pointerFinalizedAgoMs).toISOString(),
      },
    },
  }));
  return { base, root, capPath };
}

// Pointer references a capsule file that is never written (dangling — the file
// was deleted externally, or never existed).
function danglingFixture(label) {
  const base = path.join(os.tmpdir(), `lifecycle-flip-${label}-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  const root = path.join(base, 'test-seat');
  mkdirSync(path.join(root, 'memory'), { recursive: true });
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'ghost-capsule',
        path: 'memory/capsules/ghost-capsule.md', // never written
        status: 'active',
        objective: 'prove the dangling branch',
        trigger: 'curated-close',
        session_id: 'prev-sid',
        finalized_at: new Date().toISOString(),
      },
    },
  }));
  return { base, root };
}

function errLogPath(root) {
  return path.join(root, 'memory', '.daemon-errors.log');
}

function readErrLog(root) {
  try { return readFileSync(errLogPath(root), 'utf8'); } catch { return ''; }
}

function runReinject(root, source, sid) {
  return spawnSync(process.execPath, [REINJECT], {
    input: JSON.stringify({ source, session_id: sid, cwd: root }),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AIGENT_ROOT: root },
  });
}

// Every resumed_at/resumed_by_session line in a frontmatter block, in order.
function stampLines(doc) {
  const block = doc.split(/^---\s*$/m)[1] || '';
  return block.split(/\r?\n/).filter((l) => /^resumed_at:|^resumed_by_session:/.test(l));
}

console.log('-- lifecycle-flip suite --');

// 1. source=clear anchors AND flips: status resumed, stamps present, body byte-safe,
// and the pre-seeded null placeholder is REPLACED, not duplicated.
{
  const { base, root, capPath } = fixture('clear');
  const r = runReinject(root, 'clear', 'newsid-1111');
  const doc = readFileSync(capPath, 'utf8');
  ok(r.status === 0, 'clear run exits 0', r.stderr || '');
  ok(/ACTIVE CAPSULE/.test(r.stdout), 'pointer table still prints on clear');
  ok(/resume-flip.*finalize-lock released/.test(r.stdout), 'flip announced in output');
  ok(/^status: resumed$/m.test(doc), 'frontmatter status flipped to resumed');
  const stamps = stampLines(doc);
  ok(stamps.length === 2, `exactly one resumed_at + one resumed_by_session line survives (dedupe), got ${stamps.length}: ${JSON.stringify(stamps)}`);
  ok(/^resumed_at: (?!null)/.test(stamps[0] || ''), 'resumed_at carries the REAL stamp, not the null placeholder', JSON.stringify(stamps));
  ok(/^resumed_by_session: newsid-1/.test(stamps[1] || ''), 'resumed_by_session carries the real session prefix', JSON.stringify(stamps));
  ok(doc.includes(BODY_QUOTE), 'body line quoting "status: active" untouched');
  rmSync(base, { recursive: true, force: true });
}

// 2. source=compact is NOT a resume: capsule untouched.
{
  const { base, root, capPath } = fixture('compact');
  const before = readFileSync(capPath, 'utf8');
  runReinject(root, 'compact', 'newsid-2222');
  ok(readFileSync(capPath, 'utf8') === before, 'compact leaves the capsule byte-identical');
  rmSync(base, { recursive: true, force: true });
}

// 3. Non-active capsule (already resolved) is never touched by startup.
{
  const { base, root, capPath } = fixture('resolved', { status: 'resolved', placeholder: false });
  const before = readFileSync(capPath, 'utf8');
  const r = runReinject(root, 'startup', 'newsid-3333');
  ok(readFileSync(capPath, 'utf8') === before, 'resolved capsule untouched');
  ok(!/resume-flip/.test(r.stdout), 'no flip announcement for non-active capsule');
  rmSync(base, { recursive: true, force: true });
}

// 4. Idempotence: a second clear on an already-resumed capsule still anchors, no double-stamp.
{
  const { base, root, capPath } = fixture('twice');
  runReinject(root, 'clear', 'newsid-4444');
  const afterFirst = readFileSync(capPath, 'utf8');
  const r2 = runReinject(root, 'clear', 'newsid-5555');
  ok(/ACTIVE CAPSULE/.test(r2.stdout), 'second clear still anchors from the pointer');
  ok(readFileSync(capPath, 'utf8') === afterFirst, 'second clear does not re-stamp (steady-state)');
  ok(!/resume-flip.*finalize-lock released/.test(r2.stdout), 'second clear does not re-announce the flip (steady-state, silent)');
  rmSync(base, { recursive: true, force: true });
}

// 5. Malformed frontmatter (no closing '---') leaves a trail in .daemon-errors.log.
{
  const { base, root, capPath } = fixture('malformed', { closed: false });
  const before = readFileSync(capPath, 'utf8');
  const r = runReinject(root, 'clear', 'newsid-6666');
  ok(readFileSync(capPath, 'utf8') === before, 'malformed capsule is never written to');
  ok(!/resume-flip.*finalize-lock released/.test(r.stdout), 'no flip announcement for malformed frontmatter');
  const log = readErrLog(root);
  ok(/resume-flip/.test(log) && /no closing delimiter/.test(log), 'the drift is logged to .daemon-errors.log', log);
  rmSync(base, { recursive: true, force: true });
}

// 6. source=startup on a curated-close-in-window pointer DEFERS (the livelock
// fix): the close is awaiting seal — announced as deferred, capsule untouched.
{
  const { base, root, capPath } = fixture('startup');
  const before = readFileSync(capPath, 'utf8');
  const r = runReinject(root, 'startup', 'newsid-7777');
  const doc = readFileSync(capPath, 'utf8');
  ok(r.status === 0, 'startup run exits 0', r.stderr || '');
  ok(/ACTIVE CAPSULE/.test(r.stdout), 'pointer table still prints on startup');
  ok(/resume-flip\] deferred/.test(r.stdout), 'defer announced on startup (curated close awaiting seal)');
  ok(doc === before, 'deferred flip leaves the capsule byte-identical (still status: active)');
  rmSync(base, { recursive: true, force: true });
}

// 6b. source=startup with a NON-curated pointer still flips (mechanics intact).
{
  const { base, root, capPath } = fixture('startup-noncurated', { pointerTrigger: 'refresh-cycle' });
  const r = runReinject(root, 'startup', 'newsid-7777');
  const doc = readFileSync(capPath, 'utf8');
  ok(/resume-flip.*finalize-lock released/.test(r.stdout), 'flip announced on startup (non-curated pointer)');
  ok(/^status: resumed$/m.test(doc), 'frontmatter status flipped to resumed (startup, non-curated)');
  const stamps = stampLines(doc);
  ok(stamps.length === 2, `exactly one resumed_at + one resumed_by_session line survives (startup dedupe), got ${stamps.length}`, JSON.stringify(stamps));
  ok(/^resumed_by_session: newsid-7/.test(stamps[1] || ''), 'resume stamps written', JSON.stringify(stamps));
  ok(doc.includes(BODY_QUOTE), 'body line quoting "status: active" untouched');
  rmSync(base, { recursive: true, force: true });
}

// 6c. source=startup with a curated pointer past its seal window still flips —
// cross-session protection stays window-bounded.
{
  const { base, root, capPath } = fixture('startup-stale', { pointerFinalizedAgoMs: 2 * 3600e3 });
  const r = runReinject(root, 'startup', 'newsid-7777');
  const doc = readFileSync(capPath, 'utf8');
  ok(/resume-flip.*finalize-lock released/.test(r.stdout), 'flip announced on startup (window lapsed)');
  ok(/^status: resumed$/m.test(doc), 'frontmatter status flipped to resumed (startup, stale window)');
  rmSync(base, { recursive: true, force: true });
}

// 7. source=resume defers identically on a curated-close-in-window pointer.
{
  const { base, root, capPath } = fixture('resume');
  const before = readFileSync(capPath, 'utf8');
  const r = runReinject(root, 'resume', 'newsid-8888');
  const doc = readFileSync(capPath, 'utf8');
  ok(r.status === 0, 'resume run exits 0', r.stderr || '');
  ok(/resume-flip\] deferred/.test(r.stdout), 'defer announced on resume (curated close awaiting seal)');
  ok(doc === before, 'deferred flip leaves the capsule byte-identical (source=resume)');
  rmSync(base, { recursive: true, force: true });
}

// ── the null-placeholder pair is DEDUPED, never duplicated ──────────────────
{
  const { base, root, capPath } = fixture('dedupe-explicit');
  const before = readFileSync(capPath, 'utf8');
  ok(/^resumed_at: null$/m.test(before), 'fixture sanity: the null placeholder pair is present before the flip');
  runReinject(root, 'clear', 'newsid-dedupe1');
  const after = readFileSync(capPath, 'utf8');
  const nullCount = (after.match(/^resumed_at: null$/gm) || []).length;
  ok(nullCount === 0, `the null placeholder is GONE after the flip (a last-key-wins reader must never see it again), got ${nullCount} remaining`, after);
  const stamps = stampLines(after);
  ok(stamps.length === 2, `exactly 2 stamp lines total (not 4 — no duplication), got ${stamps.length}`, JSON.stringify(stamps));
  rmSync(base, { recursive: true, force: true });
}

// ── CRLF capsules keep CRLF line endings, no mixed endings ──────────────────
{
  const { base, root, capPath } = fixture('crlf', { eol: '\r\n' });
  const before = readFileSync(capPath, 'utf8');
  ok(before.includes('\r\n'), 'fixture sanity: the capsule is genuinely CRLF before the flip');
  const beforeBlock = before.split(/^---\s*$/m)[1] || '';
  const baselineLoneLf = (beforeBlock.match(/(?<!\r)\n/g) || []).length;
  runReinject(root, 'clear', 'newsid-crlf1');
  const after = readFileSync(capPath, 'utf8');
  const block = after.split(/^---\s*$/m)[1] || '';
  const afterLoneLf = (block.match(/(?<!\r)\n/g) || []).length;
  ok(afterLoneLf === baselineLoneLf, `the flip introduces no NEW bare-LF beyond the pre-existing split-boundary baseline (before=${baselineLoneLf}, after=${afterLoneLf})`, JSON.stringify(block));
  ok(/^status: resumed\r$/m.test(after), 'status line itself is CRLF-terminated');
  const stamps = stampLines(after);
  ok(stamps.length === 2, 'dedupe still holds on a CRLF capsule', JSON.stringify(stamps));
  ok(after.includes(BODY_QUOTE), 'body line quoting "status: active" untouched (CRLF fixture)');
  rmSync(base, { recursive: true, force: true });
}

// ── the '---' DELIMITER lines themselves stay CRLF-terminated (whole-file, not
// just the body) — the strict, byte-for-byte version of the CRLF assertion above.
{
  const { base, root, capPath } = fixture('crlf-delimiters', { eol: '\r\n' });
  runReinject(root, 'clear', 'newsid-crlfdelim1');
  const after = readFileSync(capPath, 'utf8');
  const lines = after.split('\n');
  const badLines = lines
    .map((l, i) => ({ i, l }))
    .slice(0, lines[lines.length - 1] === '' ? -1 : undefined)
    .filter(({ l }) => !l.endsWith('\r'));
  ok(badLines.length === 0,
    `every line in the CRLF output ends with \\r\\n, delimiter lines included -- found ${badLines.length} bare-LF line(s)`,
    JSON.stringify({ badLines, after }));
  ok(/^---\r$/m.test(after), 'the OPENING delimiter line is CRLF-terminated');
  ok((after.match(/^---\r$/gm) || []).length === 2, 'both delimiter lines (open + close) are CRLF-terminated');
  rmSync(base, { recursive: true, force: true });
}

// ── the dangling-pointer branch ──────────────────────────────────────────────
{
  const { base, root } = danglingFixture('dangling');
  const r = runReinject(root, 'clear', 'newsid-dangle1');
  ok(!/ACTIVE CAPSULE/.test(r.stdout), 'no pointer table for a dangling capsule');
  ok(/no longer exists/.test(r.stdout), 'the dangling warning prints');
  const log = readErrLog(root);
  ok(/DANGLING capsule pointer/.test(log), 'dangling is logged', log);
  rmSync(base, { recursive: true, force: true });
}

// ── already-resumed is STEADY-STATE, not drift, not an error ────────────────
{
  const { base, root, capPath } = fixture('steady-state', {
    status: 'resumed',
    placeholder: false,
    resumedStamp: { at: '2026-07-16T12:00:00.000Z', by: 'priorsid' },
  });
  const before = readFileSync(capPath, 'utf8');
  const r = runReinject(root, 'clear', 'newsid-steady1');
  ok(readFileSync(capPath, 'utf8') === before, 'an already-resumed capsule is byte-identical after another clear (steady-state, untouched)');
  ok(!/resume-flip.*finalize-lock released/.test(r.stdout), 'no flip announcement for an already-resumed capsule');
  const log = readErrLog(root);
  ok(!/resume-flip/.test(log), 'steady-state is NOT logged as drift — silently fine', log);
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
