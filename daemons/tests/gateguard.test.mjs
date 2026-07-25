// gateguard.test.mjs -- fact-forcing gate regression guard.
//
// Proves the contract of daemons/gateguard.mjs:
//   - OFF by default: with AIGENT_GATEGUARD unset, every tool call passes silently
//   - enabled: the FIRST Edit/Write of a file is denied with a fact checklist,
//     and the retry (same file, same session) passes
//   - a new session id re-arms the gate
//   - destructive Bash is gated per command with a rollback checklist
//   - routine Bash is gated once per session; read-only git never is
//   - .claude/settings*.json is never gated (it is the off switch)
//   - every path exits 0, including unparseable input: this hook fails open
//
// Run: node daemons/tests/gateguard.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isEnabled, isDestructiveBash, isReadOnlyGit, isExemptPath } from '../gateguard.mjs';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(DAEMONS, 'gateguard.mjs');
const TMP = path.join(os.tmpdir(), `gateguard-test-${process.pid}`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` | ${detail}` : ''}`);
  if (!ok) failed++;
};

rmSync(TMP, { recursive: true, force: true });
const ROOT = path.join(TMP, 'vault-root');
mkdirSync(path.join(ROOT, 'vault', 'memory'), { recursive: true });

const run = (payload, env = {}) => spawnSync(process.execPath, [HOOK], {
  encoding: 'utf8', timeout: 5000, windowsHide: true,
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  env: { ...process.env, AIGENT_ROOT: ROOT, CLAUDE_PROJECT_DIR: '', CLAUDE_SESSION_ID: '', AIGENT_GATEGUARD: 'enforce', ...env },
});

const edit = (file, session) => ({ tool_name: 'Edit', tool_input: { file_path: file }, session_id: session });
const write = (file, session) => ({ tool_name: 'Write', tool_input: { file_path: file }, session_id: session });
const bash = (command, session) => ({ tool_name: 'Bash', tool_input: { command }, session_id: session });

const denial = (r) => {
  try { return JSON.parse(r.stdout || '{}')?.hookSpecificOutput ?? null; } catch { return null; }
};
const isDeny = (r) => denial(r)?.permissionDecision === 'deny';
const reason = (r) => denial(r)?.permissionDecisionReason ?? '';

// syntax
{
  const r = spawnSync(process.execPath, ['--check', HOOK], { encoding: 'utf8' });
  check('syntax gateguard.mjs', r.status === 0, r.stderr?.trim().split('\n')[0] ?? '');
}

// pure predicates
{
  check('isEnabled: unset is OFF', isEnabled({}) === false);
  check('isEnabled: off/0/false are OFF',
    !isEnabled({ AIGENT_GATEGUARD: 'off' }) && !isEnabled({ AIGENT_GATEGUARD: '0' }) && !isEnabled({ AIGENT_GATEGUARD: 'false' }));
  check('isEnabled: enforce/on/1/true are ON',
    isEnabled({ AIGENT_GATEGUARD: 'enforce' }) && isEnabled({ AIGENT_GATEGUARD: 'on' })
    && isEnabled({ AIGENT_GATEGUARD: '1' }) && isEnabled({ AIGENT_GATEGUARD: 'TRUE' }));
}
{
  check('destructive: rm -rf', isDestructiveBash('rm -rf build/'));
  check('destructive: rm -fr and long flags', isDestructiveBash('rm -fr tmp') && isDestructiveBash('rm --recursive --force tmp'));
  check('destructive: git reset --hard', isDestructiveBash('git reset --hard origin/main'));
  check('destructive: git push --force', isDestructiveBash('git push --force origin main'));
  check('destructive: --force-with-lease is NOT flagged', !isDestructiveBash('git push --force-with-lease origin main'));
  check('destructive: SQL drop/truncate', isDestructiveBash('psql -c "DROP TABLE users"') && isDestructiveBash('TRUNCATE events'));
  check('destructive: dd if=', isDestructiveBash('dd if=/dev/zero of=/dev/sda'));
  check('routine commands are not destructive', !isDestructiveBash('ls -la') && !isDestructiveBash('rm single-file.txt') && !isDestructiveBash('npm test'));
}
{
  check('read-only git recognized', isReadOnlyGit('git status') && isReadOnlyGit('git diff --name-only') && isReadOnlyGit('git branch --show-current'));
  check('mutating git is not read-only', !isReadOnlyGit('git commit -m x') && !isReadOnlyGit('git status && rm -rf /'));
}
{
  check('settings files are exempt',
    isExemptPath('/home/o/proj/.claude/settings.json') && isExemptPath('C:\\p\\.claude\\settings.local.json'));
  check('ordinary files are not exempt', !isExemptPath('/home/o/proj/src/index.js'));
}

// OFF by default
{
  const r = run(edit('/proj/src/a.js', 's-off'), { AIGENT_GATEGUARD: '' });
  check('disabled by default: silent pass, exit 0', r.status === 0 && (r.stdout || '').trim() === '',
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = run(bash('rm -rf /important', 's-off'), { AIGENT_GATEGUARD: '' });
  check('disabled by default: even destructive bash passes silently', r.status === 0 && (r.stdout || '').trim() === '');
}

// Edit: first touch gated, retry passes
{
  const first = run(edit('/proj/src/parser.js', 's1'));
  check('first Edit of a file is denied', first.status === 0 && isDeny(first), `stdout=${JSON.stringify(first.stdout)}`);
  check('Edit denial asks for importers and a verbatim instruction quote',
    /List the files that import or require this one/.test(reason(first)) && /Quote the instruction you are acting on, verbatim/.test(reason(first)));
  check('Edit denial names the actual target file', reason(first).includes('/proj/src/parser.js'));

  const retry = run(edit('/proj/src/parser.js', 's1'));
  check('retry of the same file in the same session passes', retry.status === 0 && (retry.stdout || '').trim() === '',
    `stdout=${JSON.stringify(retry.stdout)}`);

  const other = run(edit('/proj/src/other.js', 's1'));
  check('a different file in the same session is gated on its own first touch', isDeny(other));

  const newSession = run(edit('/proj/src/parser.js', 's2'));
  check('a new session re-arms the gate for the same file', isDeny(newSession));
}

// Write wording differs from Edit
{
  const r = run(write('/proj/src/brand-new.js', 's3'));
  check('first Write of a file is denied', isDeny(r));
  check('Write denial uses create wording and asks for a caller',
    /Before creating/.test(reason(r)) && /Name the file and line that will call this new file/.test(reason(r)), reason(r));
}

// settings exemption
{
  const r = run(edit('/proj/.claude/settings.json', 's4'));
  check('.claude/settings.json is never gated', r.status === 0 && (r.stdout || '').trim() === '');
}

// Bash
{
  const ro = run(bash('git status', 's5'));
  check('read-only git is never gated', ro.status === 0 && (ro.stdout || '').trim() === '');

  const destructive = run(bash('rm -rf build/', 's5'));
  check('destructive bash is denied', isDeny(destructive));
  check('destructive denial asks for a rollback line',
    /Write the rollback procedure in one line/.test(reason(destructive)), reason(destructive));
  const destructiveRetry = run(bash('rm -rf build/', 's5'));
  check('destructive retry of the same command passes', (destructiveRetry.stdout || '').trim() === '');

  const otherDestructive = run(bash('git reset --hard HEAD~3', 's5'));
  check('a different destructive command is gated on its own', isDeny(otherDestructive));
}
{
  const first = run(bash('npm test', 's6'));
  check('first routine bash of a session is denied', isDeny(first));
  check('routine denial asks what the command produces',
    /What this specific command verifies or produces/.test(reason(first)), reason(first));
  const second = run(bash('ls -la', 's6'));
  check('later routine bash in the same session passes', (second.stdout || '').trim() === '');
}

// fail open
{
  const r = run('not json at all {{{');
  check('unparseable stdin fails open, exit 0, silent', r.status === 0 && (r.stdout || '').trim() === '',
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = run({ tool_name: 'Read', tool_input: { file_path: '/proj/src/parser.js' }, session_id: 's7' });
  check('non-gated tools pass silently', r.status === 0 && (r.stdout || '').trim() === '');
}
{
  const r = run({ tool_name: 'Edit', tool_input: {}, session_id: 's7' });
  check('Edit with no file_path passes silently', r.status === 0 && (r.stdout || '').trim() === '');
}
{
  const r = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, input: JSON.stringify(edit('/x/y.js', 's8')),
    env: { ...process.env, AIGENT_ROOT: '', CLAUDE_PROJECT_DIR: '', AIGENT_GATEGUARD: 'enforce' },
  });
  check('no resolvable root exits 0 without output', r.status === 0 && (r.stdout || '').trim() === '');
}

rmSync(TMP, { recursive: true, force: true });

console.log(failed === 0 ? '\nPASS: gateguard contract holds' : `\nFAIL: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
