// precompact-flush.test.mjs — PreCompact flush + ToC-inject regression guard.
//
// Proves the compaction contract of daemons/precompact-flush.mjs:
//   - flush OK → the ToC printed to stdout carries pointers into the capsule
//     (objective / next_valid_action / section anchors), not content dumps
//   - a no-delta rerun reads "already current", never a false "flush OK"
//   - an UNOBSERVABLE delta (no transcript delivered) warns, never fails
//   - kill-switch reads as the deliberate 'killed' note
//   - a DANGLING pointer (file deleted under an active pointer) is called out
//   - no pointer at all → the /resume re-grounding fallback
//   - fail-soft sovereignty DEFAULT: an observed flush FAILURE warns + exits 0
//     (compaction is never gated); LIFECYCLE_PRECOMPACT_STRICT=1 opts back in
//     to decision:block + exit 2
//
// Mostly black-box against the shipped daemon in place. The fail-class matrix
// copies the SHIPPED bytes of precompact-flush.mjs + lifecycle-common.mjs into
// a temp dir WITHOUT stop-capsule-writer.mjs — the only way to make the worker
// spawn genuinely fail without touching the repo tree; the bytes under test are
// still exactly what ships.
// Run: node daemons/tests/precompact-flush.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `pcf-test-${process.pid}`);
const SANDBOX = path.join(TMP, 'test-vault');
const MEM = path.join(SANDBOX, 'memory');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };
const run = (input, env = {}, daemonDir = DAEMONS) => spawnSync(process.execPath, [path.join(daemonDir, 'precompact-flush.mjs')], {
  encoding: 'utf8', timeout: 15000, windowsHide: true, input,
  env: {
    ...process.env, AIGENT_ROOT: SANDBOX, CLAUDE_PROJECT_DIR: '', AIGENT_SEAT_ID: '',
    LIFECYCLE_KILL_STOP_WRITER: '', LIFECYCLE_PRECOMPACT_STRICT: '', ...env,
  },
});

rmSync(TMP, { recursive: true, force: true });
mkdirSync(path.join(MEM, 'capsules'), { recursive: true });
mkdirSync(path.join(MEM, 'runtime', 'stop-writer'), { recursive: true });
writeFileSync(path.join(MEM, 'BODY_STATE.json'), JSON.stringify({ state: {} }));

// ── syntax ────────────────────────────────────────────────────────────────────
for (const f of ['lifecycle-common.mjs', 'precompact-flush.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(DAEMONS, f)], { encoding: 'utf8' });
  check(`syntax ${f}`, r.status === 0, r.stderr?.trim().split('\n')[0] ?? '');
}

// ── flush OK → ToC with pointers, not content ────────────────────────────────
const transcript = path.join(SANDBOX, 'pc1.jsonl');
writeFileSync(transcript, [
  JSON.stringify({ type: 'user', message: { content: 'Compact-eve directive: carry this across' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'carrying' }] } }),
].join('\n') + '\n');
{
  const r = run(JSON.stringify({ session_id: 'pc1', cwd: SANDBOX, transcript_path: transcript }));
  check('flush OK: exit 0', r.status === 0, `status=${r.status} stderr=${JSON.stringify(r.stderr?.slice(0, 120))}`);
  check('flush OK: ToC header printed', /\[PRECOMPACT:capsule-toc\] flush OK/.test(r.stdout || ''), JSON.stringify(r.stdout?.slice(0, 120)));
  check('flush OK: capsule survival pointer + REFERENCE ONLY fence', /active capsule survives this compaction at memory\/capsules\//.test(r.stdout) && /\[REFERENCE ONLY\]/.test(r.stdout));
  check('flush OK: objective + next_valid_action surfaced', /objective: .*Compact-eve directive/.test(r.stdout) && /next_valid_action: /.test(r.stdout));
  check('flush OK: section anchors are POINTERS on disk, not content', /Sections on disk \(pull on demand, never from memory\)/.test(r.stdout) && /#Pending-Gates/.test(r.stdout));
}

// ── no-delta rerun: "already current", never a false flush OK ────────────────
{
  const r = run(JSON.stringify({ session_id: 'pc1', cwd: SANDBOX, transcript_path: transcript }));
  check('no-delta rerun: reads already-current', r.status === 0 && /already current/.test(r.stdout) && !/flush OK/.test(r.stdout));
}

// ── unobservable delta: WARN, never fail ─────────────────────────────────────
{
  const r = run(JSON.stringify({ session_id: 'pc1', cwd: SANDBOX }));
  check('no transcript delivered: warn-not-fail, journal named as backstop', r.status === 0 && /WARNING: pre-compact flush had nothing observable/.test(r.stdout) && /utterance journal/.test(r.stdout));
}

// ── kill-switch: deliberate override note ────────────────────────────────────
{
  const r = run(JSON.stringify({ session_id: 'pc1', cwd: SANDBOX, transcript_path: transcript }), { LIFECYCLE_KILL_STOP_WRITER: '1' });
  check('kill-switch: last-known-good note, exit 0', r.status === 0 && /capsule writer disabled/.test(r.stdout));
}

// ── dangling pointer: called out loudly ──────────────────────────────────────
{
  writeFileSync(path.join(MEM, 'BODY_STATE.json'), JSON.stringify({ state: { last_capsule: { path: 'memory/capsules/gone.md' } } }));
  const r = run(JSON.stringify({ session_id: 'pc1', cwd: SANDBOX }));
  check('dangling pointer: NO LONGER EXISTS warning, exit 0', r.status === 0 && /NO LONGER EXISTS/.test(r.stdout));
}

// ── no pointer: /resume re-grounding fallback ────────────────────────────────
{
  writeFileSync(path.join(MEM, 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  const r = run(JSON.stringify({ session_id: 'pc1', cwd: SANDBOX }));
  check('no pointer: no-active-capsule fallback names /resume', r.status === 0 && /no active capsule on disk/.test(r.stdout) && /\/resume/.test(r.stdout));
}

// ── fail class: fail-soft DEFAULT vs opt-in strict block ─────────────────────
{
  const BROKEN = path.join(TMP, 'daemons-no-worker');
  mkdirSync(BROKEN, { recursive: true });
  for (const f of ['precompact-flush.mjs', 'lifecycle-common.mjs']) copyFileSync(path.join(DAEMONS, f), path.join(BROKEN, f));
  // stop-capsule-writer.mjs deliberately absent → the worker spawn genuinely fails.
  const soft = run(JSON.stringify({ session_id: 'pcx', cwd: SANDBOX, transcript_path: transcript }), {}, BROKEN);
  check('observed flush failure, DEFAULT: warns + exit 0 (compaction never gated)', soft.status === 0 && /WARNING: pre-compact capsule flush FAILED/.test(soft.stdout) && !/"decision"/.test(soft.stdout), `status=${soft.status}`);
  const strict = run(JSON.stringify({ session_id: 'pcx', cwd: SANDBOX, transcript_path: transcript }), { LIFECYCLE_PRECOMPACT_STRICT: '1' }, BROKEN);
  check('observed flush failure, STRICT=1: decision:block + exit 2', strict.status === 2 && /"decision":"block"/.test(strict.stdout), `status=${strict.status} stdout=${JSON.stringify(strict.stdout?.slice(0, 120))}`);
  const strictKilled = run(JSON.stringify({ session_id: 'pcx', cwd: SANDBOX, transcript_path: transcript }), { LIFECYCLE_PRECOMPACT_STRICT: '1', LIFECYCLE_KILL_STOP_WRITER: '1' }, BROKEN);
  check('strict + kill-switch: deliberate disable NEVER blocks', strictKilled.status === 0 && /capsule writer disabled/.test(strictKilled.stdout));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `PRECOMPACT-FLUSH.TEST: FAIL (${failed})` : 'PRECOMPACT-FLUSH.TEST: PASS');
process.exit(failed ? 1 : 0);
