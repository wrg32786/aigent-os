// discipline-check.test.mjs -- measurement-loop trigger regression guard.
//
// Proves the contract of daemons/discipline-check.mjs:
//   - counts confident-verb claims, case-insensitively, ignoring code
//   - reads both Stop-payload message shapes (plain string, content-block array)
//   - stays silent below the claim threshold, or when a ledger was just written
//   - nudges when claims cross the threshold AND the ledgers are stale
//   - treats "no ledger has ever been written" as maximally stale
//   - never echoes the scanned message (the nudge carries a count, not content)
//   - AIGENT_DISCIPLINE_CHECK=off disables it; bad input fails open, exit 0
//
// Run: node daemons/tests/discipline-check.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { claimCount, extractMessage, ledgerAgeSeconds, evaluate, LEDGERS } from '../discipline-check.mjs';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(DAEMONS, 'discipline-check.mjs');
const TMP = path.join(os.tmpdir(), `discipline-test-${process.pid}`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` | ${detail}` : ''}`);
  if (!ok) failed++;
};

rmSync(TMP, { recursive: true, force: true });

// Build a vault fixture whose ledgers were last written `ageSeconds` ago.
function vault(name, ageSeconds) {
  const root = path.join(TMP, name);
  const mem = path.join(root, 'vault', 'memory');
  mkdirSync(mem, { recursive: true });
  const when = new Date(Date.now() - ageSeconds * 1000);
  for (const ledger of LEDGERS) {
    const file = path.join(mem, ledger);
    writeFileSync(file, `# ${ledger}\n`);
    utimesSync(file, when, when);
  }
  return { root, mem };
}

const run = (input, root, env = {}) => spawnSync(process.execPath, [HOOK], {
  encoding: 'utf8', timeout: 5000, windowsHide: true, input,
  env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: '', AIGENT_DISCIPLINE_CHECK: '', AIGENT_DISCIPLINE_THRESHOLD: '', AIGENT_DISCIPLINE_QUIET: '', ...env },
});

const stopPayload = (text) => JSON.stringify({ last_assistant_message: text });

// syntax
{
  const r = spawnSync(process.execPath, ['--check', HOOK], { encoding: 'utf8' });
  check('syntax discipline-check.mjs', r.status === 0, r.stderr?.trim().split('\n')[0] ?? '');
}

// claimCount
{
  check('counts confident verbs', claimCount('I fixed the parser, verified the output, and shipped it.') === 3);
  check('is case-insensitive', claimCount('FIXED. Verified. SHIPPED.') === 3);
  check('counts repeats of one verb', claimCount('fixed, fixed, fixed') === 3);
  check('hedged prose without the verbs scores zero', claimCount('I believe this might address the parser issue.') === 0);
  check('empty input scores zero', claimCount('') === 0 && claimCount(null) === 0);
}

// code is exempt
{
  const withFence = 'Here is the diff:\n```\nfixed = verified && shipped;\n```\nStill investigating.';
  check('fenced code is exempt from the count', claimCount(withFence) === 0, `got ${claimCount(withFence)}`);
  check('inline code spans are exempt', claimCount('the `fixed` flag and the `shipped` column') === 0);
  check('prose around exempt code still counts', claimCount('I fixed it. `shipped` is a column. Tested and verified.') === 3,
    `got ${claimCount('I fixed it. `shipped` is a column. Tested and verified.')}`);
}

// extractMessage
{
  check('reads the plain-string payload shape', extractMessage({ last_assistant_message: 'hello' }) === 'hello');
  check('reads the content-block array shape',
    extractMessage({ message: { content: [{ text: 'alpha' }, { text: 'beta' }] } }) === 'alpha beta');
  check('reads a plain message.content string', extractMessage({ message: { content: 'gamma' } }) === 'gamma');
  check('absent message reads as empty', extractMessage({}) === '' && extractMessage(null) === '');
  check('non-string message never throws', extractMessage({ last_assistant_message: 42 }) === '');
}

// ledgerAgeSeconds
{
  const fresh = vault('fresh', 5);
  const age = ledgerAgeSeconds(fresh.mem);
  check('a just-written ledger reads as fresh', age >= 0 && age < 60, `age=${age}`);

  const stale = vault('stale', 3600);
  const staleAge = ledgerAgeSeconds(stale.mem);
  check('an old ledger reads as stale', staleAge > 3000, `age=${staleAge}`);

  const empty = path.join(TMP, 'no-ledgers');
  mkdirSync(empty, { recursive: true });
  check('no ledger at all reads as maximally stale', ledgerAgeSeconds(empty) === Infinity);
}

// evaluate
{
  const claims = 'fixed verified shipped tested';
  check('below threshold: silent', evaluate({ text: 'fixed it', ageSeconds: Infinity }) === '');
  check('above threshold but ledger fresh: silent', evaluate({ text: claims, ageSeconds: 10 }) === '');
  check('above threshold and ledger stale: nudges', evaluate({ text: claims, ageSeconds: 4000 }).startsWith('[DISCIPLINE]'));
  check('nudge names the capture skills',
    /\/trust-decay capture/.test(evaluate({ text: claims, ageSeconds: 4000 }))
    && /\/honesty-check/.test(evaluate({ text: claims, ageSeconds: 4000 })));
  check('threshold is configurable', evaluate({ text: 'fixed it', ageSeconds: Infinity, threshold: 1 }).startsWith('[DISCIPLINE]'));
  check('quiet window is configurable', evaluate({ text: claims, ageSeconds: 10, quietSeconds: 5 }).startsWith('[DISCIPLINE]'));
}

// privacy: the nudge reports a count, never the message it scanned
{
  const secret = 'I fixed the auth bug in tenant acme-corp, verified the token rotation, and shipped it.';
  const line = evaluate({ text: secret, ageSeconds: Infinity });
  check('nudge fires on the sensitive fixture', line.startsWith('[DISCIPLINE]'));
  check('nudge never echoes the scanned message',
    !line.includes('acme-corp') && !line.includes('auth bug') && !line.includes('token rotation'), line);
}

// CLI
{
  const stale = vault('cli-stale', 4000);
  const r = run(stopPayload('I fixed the parser, verified the output, and shipped it.'), stale.root);
  check('CLI: stale ledgers + claims prints the nudge, exit 0',
    r.status === 0 && /^\[DISCIPLINE\] 3 confident claims/.test((r.stdout || '').trim()),
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const fresh = vault('cli-fresh', 5);
  const r = run(stopPayload('I fixed the parser, verified the output, and shipped it.'), fresh.root);
  check('CLI: a just-written ledger silences the nudge', r.status === 0 && (r.stdout || '').trim() === '',
    `stdout=${JSON.stringify(r.stdout)}`);
}
{
  const stale = vault('cli-off', 4000);
  const r = run(stopPayload('fixed verified shipped'), stale.root, { AIGENT_DISCIPLINE_CHECK: 'off' });
  check('CLI: AIGENT_DISCIPLINE_CHECK=off disables it', r.status === 0 && (r.stdout || '').trim() === '');
}
{
  const stale = vault('cli-threshold', 4000);
  const r = run(stopPayload('I fixed it.'), stale.root, { AIGENT_DISCIPLINE_THRESHOLD: '1' });
  check('CLI: threshold env var is honored, and a lone claim reads as singular',
    r.status === 0 && /\[DISCIPLINE\] 1 confident claim this turn/.test(r.stdout || ''),
    `stdout=${JSON.stringify(r.stdout)}`);
}
{
  const stale = vault('cli-quiet', 4000);
  const r = run(stopPayload('a quiet turn with no claims at all'), stale.root);
  check('CLI: a turn with no claims is silent', r.status === 0 && (r.stdout || '').trim() === '');
}

// fail open
{
  const stale = vault('cli-garbage', 4000);
  const r = run('not json at all {{{', stale.root);
  check('CLI: unparseable stdin fails open, exit 0, silent', r.status === 0 && (r.stdout || '').trim() === '',
    `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
}
{
  const r = run(stopPayload('fixed verified shipped'), '');
  check('CLI: no resolvable root exits 0 without output', r.status === 0 && (r.stdout || '').trim() === '');
}
{
  const stale = vault('cli-empty', 4000);
  const r = run('', stale.root);
  check('CLI: empty stdin exits 0 without output', r.status === 0 && (r.stdout || '').trim() === '');
}

rmSync(TMP, { recursive: true, force: true });

console.log(failed === 0 ? '\nPASS: discipline-check contract holds' : `\nFAIL: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
