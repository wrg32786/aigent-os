// userpromptsubmit-journal.test.mjs — write-ahead utterance journal regression guard.
//
// Proves the WAL contract of daemons/userpromptsubmit-journal.mjs:
//   - a prompt is on disk RAW and FULL before anything counts as "heard"
//   - the hook NEVER prints (UserPromptSubmit stdout is injected into context)
//   - structured (non-string) prompts are captured in JSON form, never dropped
//   - kill-switch + no-prompt hook noise are silent no-ops
//   - unparseable stdin exits 0 but leaves a loud trail in .daemon-errors.log
//   - oversize journals rotate to a dated sidecar; the prompt still lands
//
// Black-box by design — spawns the REAL daemon against a self-contained OS-temp
// vault, so it tests shipped behavior and cannot drift from it.
// Run: node daemons/tests/userpromptsubmit-journal.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `upsj-test-${process.pid}`);
const SANDBOX = path.join(TMP, 'test-vault');
const MEM = path.join(SANDBOX, 'memory');
const JOURNAL = path.join(MEM, 'runtime', 'utterance-journal.jsonl');
const ERRLOG = path.join(MEM, '.daemon-errors.log');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };
const run = (input, env = {}) => spawnSync(process.execPath, [path.join(DAEMONS, 'userpromptsubmit-journal.mjs')], {
  encoding: 'utf8', timeout: 8000, windowsHide: true, input,
  env: {
    ...process.env, AIGENT_ROOT: SANDBOX, CLAUDE_PROJECT_DIR: '', AIGENT_SEAT_ID: '',
    LIFECYCLE_KILL_JOURNAL: '', LIFECYCLE_JOURNAL_MAX_BYTES: '', ...env,
  },
});
const journalLines = () => (existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(path.join(MEM, 'runtime'), { recursive: true });

// ── syntax ────────────────────────────────────────────────────────────────────
for (const f of ['lifecycle-common.mjs', 'userpromptsubmit-journal.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(DAEMONS, f)], { encoding: 'utf8' });
  check(`syntax ${f}`, r.status === 0, r.stderr?.trim().split('\n')[0] ?? '');
}

// ── WAL: raw prompt lands, hook never prints ─────────────────────────────────
{
  const prompt = 'Ship the release notes tomorrow — and keep the "## Fake Section" verbatim';
  const r = run(JSON.stringify({ session_id: 'j1', cwd: SANDBOX, prompt }));
  check('journal: exit 0', r.status === 0, `status=${r.status}`);
  check('journal: NEVER prints (stdout would be injected into context)', (r.stdout || '') === '', JSON.stringify(r.stdout));
  const lines = journalLines();
  check('journal: exactly one line appended', lines.length === 1);
  check('journal: prompt RAW and full (no truncation, no escaping loss)', lines[0]?.prompt === prompt);
  check('journal: line carries sid + source:prompt + operator identity', lines[0]?.sid === 'j1' && lines[0]?.source === 'prompt' && lines[0]?.seat === 'operator');
}

// ── structured (non-string) prompt captured in JSON form ─────────────────────
{
  const r = run(JSON.stringify({ session_id: 'j2', cwd: SANDBOX, prompt: { blocks: [{ type: 'text', text: 'structured' }] } }));
  const last = journalLines().at(-1);
  check('structured prompt: captured as JSON, not dropped', r.status === 0 && typeof last?.prompt === 'string' && last.prompt.includes('"structured"'));
}

// ── benign no-ops: no prompt key, kill-switch ────────────────────────────────
{
  const before = journalLines().length;
  const r1 = run(JSON.stringify({ session_id: 'j3', cwd: SANDBOX }));
  check('no prompt key: silent no-op (hook noise)', r1.status === 0 && (r1.stdout || '') === '' && journalLines().length === before);
  const r2 = run(JSON.stringify({ session_id: 'j4', cwd: SANDBOX, prompt: 'must not land' }), { LIFECYCLE_KILL_JOURNAL: '1' });
  check('kill-switch: nothing journaled, exit 0', r2.status === 0 && journalLines().length === before);
}

// ── unparseable stdin: exit 0 + loud trail ───────────────────────────────────
{
  const r = run('this is not JSON {');
  const errlog = existsSync(ERRLOG) ? readFileSync(ERRLOG, 'utf8') : '';
  check('garbage stdin: exit 0 (fail open), stdout silent', r.status === 0 && (r.stdout || '') === '');
  check('garbage stdin: logged to .daemon-errors.log (fail loud, never silent)', /userpromptsubmit-journal.*parse failed/.test(errlog), errlog.split('\n')[0]);
}

// ── AIGENT_SEAT_ID override (multi-instance forks) ───────────────────────────
{
  run(JSON.stringify({ session_id: 'j5', cwd: SANDBOX, prompt: 'tagged per-identity' }), { AIGENT_SEAT_ID: 'fork-a' });
  check('AIGENT_SEAT_ID override tags the journal line', journalLines().at(-1)?.seat === 'fork-a');
}

// ── rotation: oversize journal rolls to a dated sidecar first ────────────────
{
  writeFileSync(JOURNAL, `${'x'.repeat(300)}\n`); // seed an "oversize" journal against a 100-byte cap
  const r = run(JSON.stringify({ session_id: 'j6', cwd: SANDBOX, prompt: 'first line after rotation' }), { LIFECYCLE_JOURNAL_MAX_BYTES: '100' });
  const sidecars = readdirSync(path.join(MEM, 'runtime')).filter((f) => /^utterance-journal-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/.test(f));
  check('rotation: dated sidecar created', r.status === 0 && sidecars.length === 1, JSON.stringify(sidecars));
  const lines = journalLines();
  check('rotation: fresh journal carries ONLY the new prompt', lines.length === 1 && lines[0]?.prompt === 'first line after rotation');
}

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `USERPROMPTSUBMIT-JOURNAL.TEST: FAIL (${failed})` : 'USERPROMPTSUBMIT-JOURNAL.TEST: PASS');
process.exit(failed ? 1 : 0);
