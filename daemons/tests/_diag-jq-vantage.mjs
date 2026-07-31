#!/usr/bin/env node
/**
 * ONE-SHOT DIAGNOSTIC for board 6efdf2dc. Not a test. Delete once the row lands.
 *
 * THE QUESTION. In CI, `command -v jq` succeeds in a workflow step, and one step
 * later daemons/tests/statusline-ctx.test.mjs probes the same thing via
 * spawnSync('bash', ['-c', 'command -v jq']) and gets non-zero, so all four
 * tests skip on a runner where the install step logged "jq already present:
 * jq-1.7" (run 30621532801).
 *
 * WHY THIS PRINTS RAW VALUES AND DRAWS NO CONCLUSION. Twice on this lane a
 * confident explanation was wrong: "jq is absent from the image" (falsified by
 * the install log) and a PATH-length difference that is an artifact of win32.
 * The row's own brief says: do not fix from a candidate, measure first. So this
 * emits values and labels them as values. Whoever reads the run does the
 * inferring, with the numbers in front of them.
 *
 * SURVIVING CANDIDATES this is built to separate:
 *   1. PATH not inherited into the spawn
 *   2. bash resolved differently by node than by the step shell
 *   (3. invocation shape — already eliminated locally with controls)
 *
 * PRIOR, stated as a prior and not a finding: on 2026-07-31 the F001 gate work
 * measured a node->bash spawn failing to reproduce its parent shell's
 * environment on win32 (board a42d5e2f). Different OS, different binary, same
 * SHAPE, so candidate 1 is where I would look first. That is a reason to
 * measure it, never a reason to report it.
 *
 * EXITS 0 UNCONDITIONALLY. A failing step skips every later step in its job
 * (board c0981f24), and a diagnostic must never dark the thing it is diagnosing.
 */

import { spawnSync } from 'node:child_process';

const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
const show = (label, r) => {
  console.log(`\n[${label}]`);
  line('error', r.error ? `${r.error.code || ''} ${String(r.error.message).split('\n')[0]}` : 'none');
  line('status', String(r.status));
  line('signal', String(r.signal));
  line('stdout', JSON.stringify((r.stdout || '').trim()));
  line('stderr', JSON.stringify((r.stderr || '').trim()));
};
const bash = (script) => spawnSync('bash', ['-c', script], { encoding: 'utf8' });

console.log('='.repeat(70));
console.log('6efdf2dc DIAGNOSTIC — node-spawn vantage vs step-shell vantage');
console.log('='.repeat(70));

console.log('\n[NODE PROCESS]');
line('node version', process.version);
line('platform/arch', `${process.platform}-${process.arch}`);
line('cwd', process.cwd());
line('uid/gid', `${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}/${typeof process.getgid === 'function' ? process.getgid() : 'n/a'}`);

// ---- THE EXACT PROBE UNDER TEST -------------------------------------------
show('TARGET — the probe statusline-ctx.test.mjs actually runs', bash('command -v jq'));

// ---- CONTROLS: answers known by construction -------------------------------
// Without these, a non-zero on jq cannot be told apart from a broken spawn.
show('CONTROL present (node)', bash('command -v node'));
show('CONTROL present (git)', bash('command -v git'));
show('CONTROL absent (xyzzy)', bash('command -v definitely-not-a-real-binary-xyzzy'));

// ---- CANDIDATE 1: is PATH inherited into the spawn? ------------------------
console.log('\n[CANDIDATE 1 — PATH inheritance]');
const nodePath = process.env.PATH || '';
const bashPathR = bash('printf %s "$PATH"');
const bashPath = bashPathR.stdout || '';
line('node PATH len/entries', `${nodePath.length} / ${nodePath.split(':').length}`);
line('bash PATH len/entries', `${bashPath.length} / ${bashPath.split(':').length}`);
line('IDENTICAL?', String(nodePath === bashPath));
if (nodePath !== bashPath) {
  const nodeSet = new Set(nodePath.split(':'));
  const bashSet = new Set(bashPath.split(':'));
  line('in node NOT in bash', JSON.stringify([...nodeSet].filter((d) => !bashSet.has(d))));
  line('in bash NOT in node', JSON.stringify([...bashSet].filter((d) => !nodeSet.has(d))));
}

// ---- WHERE IS JQ, INDEPENDENT OF PATH -------------------------------------
// If jq exists on disk but PATH cannot reach it, candidate 1 is the answer and
// this prints the proof. If it is absent from disk too, the install-step log
// and this disagree, which is a different and bigger finding.
console.log('\n[JQ ON DISK — PATH-independent]');
for (const p of ['/usr/bin/jq', '/usr/local/bin/jq', '/bin/jq', '/snap/bin/jq']) {
  const r = bash(`test -x ${p} && echo yes || echo no`);
  line(p, (r.stdout || '').trim());
}
show('find jq anywhere on PATH dirs', bash('ls -la $(printf %s "$PATH" | tr ":" " ")/jq 2>/dev/null || echo "not in any PATH dir"'));
show('jq --version (direct)', bash('jq --version'));

// ---- CANDIDATE 2: which bash, and is it the step's bash? -------------------
console.log('\n[CANDIDATE 2 — bash resolution]');
show('which bash (from node spawn)', bash('command -v bash; bash --version | head -1'));
line('env.SHELL', JSON.stringify(process.env.SHELL || '<unset>'));
line('env.BASH_ENV', JSON.stringify(process.env.BASH_ENV || '<unset>'));

// ---- IS THE SPAWNED SHELL LOGIN/INTERACTIVE? -------------------------------
// A non-login, non-interactive shell skips /etc/profile.d, which is exactly how
// a PATH entry present in the step can be missing one spawn later.
console.log('\n[SHELL MODE — does it read profile?]');
show('shopt login_shell', bash('shopt -q login_shell && echo login || echo non-login'));
show('does /etc/profile.d add anything?', bash('ls /etc/profile.d/ 2>/dev/null | head -20'));
show('PATH after sourcing profile', bash('. /etc/profile >/dev/null 2>&1; command -v jq && echo "JQ VISIBLE AFTER PROFILE" || echo "still not visible"'));

console.log(`\n${'='.repeat(70)}`);
console.log('END DIAGNOSTIC — values only. No conclusion is asserted here.');
console.log('='.repeat(70));
process.exit(0);
