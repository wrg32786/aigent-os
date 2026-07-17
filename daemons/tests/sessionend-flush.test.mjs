// sessionend-flush.test.mjs — session-end final-flush regression guard.
//
// Proves the SessionEnd crash-window contract of daemons/sessionend-flush.mjs:
//   - the REAL stop-capsule-writer worker runs synchronously and the final
//     delta lands in the capsule before the process dies
//   - a `session-end` event line is journaled with the reason + the flush fate
//   - the hook NEVER prints and ALWAYS exits 0 (nobody reads SessionEnd stdout)
//   - benign outcomes (no-delta, killed) leave no false alarms in the error log
//   - a non-benign outcome leaves a loud "did not land" trail
//   - an unresolvable root is a logged skip, never a crash
//
// Black-box by design — spawns the REAL daemon (which spawns the REAL worker)
// against a self-contained OS-temp vault.
// Run: node daemons/tests/sessionend-flush.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `sef-test-${process.pid}`);
const SANDBOX = path.join(TMP, 'test-vault');
const MEM = path.join(SANDBOX, 'memory');
const JOURNAL = path.join(MEM, 'runtime', 'utterance-journal.jsonl');
const ERRLOG = path.join(MEM, '.daemon-errors.log');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };
const run = (input, env = {}, opts = {}) => spawnSync(process.execPath, [path.join(DAEMONS, 'sessionend-flush.mjs')], {
  encoding: 'utf8', timeout: 15000, windowsHide: true, input,
  ...opts,
  env: {
    ...process.env, AIGENT_ROOT: SANDBOX, CLAUDE_PROJECT_DIR: '', AIGENT_SEAT_ID: '',
    LIFECYCLE_KILL_STOP_WRITER: '', ...env,
  },
});
const eventLines = () => (existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  .filter((l) => l.source === 'session-end');
const errlog = () => (existsSync(ERRLOG) ? readFileSync(ERRLOG, 'utf8') : '');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(path.join(MEM, 'capsules'), { recursive: true });
mkdirSync(path.join(MEM, 'runtime', 'stop-writer'), { recursive: true });
writeFileSync(path.join(MEM, 'BODY_STATE.json'), JSON.stringify({ state: {} }));

// ── syntax ────────────────────────────────────────────────────────────────────
for (const f of ['lifecycle-common.mjs', 'sessionend-flush.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(DAEMONS, f)], { encoding: 'utf8' });
  check(`syntax ${f}`, r.status === 0, r.stderr?.trim().split('\n')[0] ?? '');
}

// ── the crash window: final delta lands at session end ───────────────────────
const transcript = path.join(SANDBOX, 'se1.jsonl');
writeFileSync(transcript, [
  JSON.stringify({ type: 'user', message: { content: 'Final directive before the session dies' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Banking it now.' }] } }),
].join('\n') + '\n');
{
  const r = run(JSON.stringify({ session_id: 'se1', cwd: SANDBOX, transcript_path: transcript, reason: 'clear' }));
  check('session-end: exit 0, never prints', r.status === 0 && (r.stdout || '') === '', `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  const ptr = JSON.parse(readFileSync(path.join(MEM, 'BODY_STATE.json'), 'utf8')).state.last_capsule;
  check('session-end: final delta LANDED in the capsule (worker really ran)', !!ptr?.path && /Final directive before the session dies/.test(readFileSync(path.join(SANDBOX, ptr.path), 'utf8')));
  const ev = eventLines().at(-1);
  check('session-end: event line journaled with reason + flush fate', ev?.reason === 'clear' && ev?.flush === 'flushed' && ev?.sid === 'se1' && ev?.seat === 'operator', JSON.stringify(ev));
  check('session-end: benign outcome leaves no "did not land" alarm', !/did not land/.test(errlog()));
}

// ── rerun with no new delta: benign, still journaled ─────────────────────────
{
  const r = run(JSON.stringify({ session_id: 'se1', cwd: SANDBOX, transcript_path: transcript, reason: 'logout' }));
  const ev = eventLines().at(-1);
  check('no-delta rerun: benign noop journaled, no alarm', r.status === 0 && ev?.flush === 'noop:no-delta' && ev?.reason === 'logout' && !/did not land/.test(errlog()));
}

// ── kill-switch: deliberate, benign, still journaled ─────────────────────────
{
  const r = run(JSON.stringify({ session_id: 'se1', cwd: SANDBOX, transcript_path: transcript, reason: 'clear' }), { LIFECYCLE_KILL_STOP_WRITER: '1' });
  const ev = eventLines().at(-1);
  check('kill-switch: flush=noop:killed journaled, no alarm', r.status === 0 && ev?.flush === 'noop:killed' && !/did not land/.test(errlog()));
}

// ── non-benign outcome: loud trail ───────────────────────────────────────────
{
  // Garbage stdin degrades to env-root; the worker then sees no session_id →
  // noop:bad-payload — a non-benign fate that must be BOTH journaled and logged.
  const r = run('not json {');
  const ev = eventLines().at(-1);
  check('degraded payload: event line still written (sid empty, fate recorded)', r.status === 0 && ev?.sid === '' && ev?.flush === 'noop:bad-payload', JSON.stringify(ev));
  check('degraded payload: "did not land" alarm in .daemon-errors.log', /sessionend-flush.*did not land \(noop:bad-payload\)/.test(errlog()));
}

// ── no root resolvable: logged skip, never a crash ───────────────────────────
{
  const r = run(JSON.stringify({ session_id: 'se9', reason: 'other' }), { AIGENT_ROOT: '', CLAUDE_PROJECT_DIR: '' }, { cwd: TMP });
  check('no root: exit 0, stdout silent (skip is unrecorded but safe)', r.status === 0 && (r.stdout || '') === '', `status=${r.status}`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `SESSIONEND-FLUSH.TEST: FAIL (${failed})` : 'SESSIONEND-FLUSH.TEST: PASS');
process.exit(failed ? 1 : 0);
