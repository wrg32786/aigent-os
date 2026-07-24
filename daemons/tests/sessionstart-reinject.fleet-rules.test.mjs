// sessionstart-reinject.fleet-rules.test.mjs — EVER-623 port regression guard.
//
// Proves the env-gated fleet-rules injection contract of
// daemons/sessionstart-reinject.mjs:
//   - gate CLOSED (unset or '0') → zero doctrine bytes in output, on both the
//     warm-start path and the source=clear resume path (byte-parity with
//     pre-port output is the kill-switch's whole promise)
//   - gate OPEN ('1') + readable source file → doctrine block present verbatim
//     on BOTH paths (a post-clear boot is exactly when doctrine must be there)
//   - oversize doctrine → the POINTER line naming the source path, and NOT a
//     truncated copy (no doctrine tail bytes anywhere in output)
//   - gate OPEN + path unset → boot still succeeds (exit 0, normal output),
//     no doctrine block, and a LOUD [EVER-623] line in .daemon-errors.log —
//     an armed gate never skips silently
// Black-box against the shipped daemon in place.
// Run: node daemons/tests/sessionstart-reinject.fleet-rules.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `ssr-fr-test-${process.pid}`);
const SANDBOX = path.join(TMP, 'test-vault');
const MEM = path.join(SANDBOX, 'memory');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };
const run = (source, env = {}) => spawnSync(process.execPath, [path.join(DAEMONS, 'sessionstart-reinject.mjs')], {
  encoding: 'utf8', timeout: 15000, windowsHide: true,
  input: JSON.stringify({ source, cwd: SANDBOX, session_id: 'test-sid' }),
  env: {
    ...process.env, AIGENT_ROOT: SANDBOX, CLAUDE_PROJECT_DIR: '', AIGENT_SEAT_ID: '',
    AIGENT_COORDINATION_STATE: '', AIGENT_FLEET_RULES_INJECT: '', AIGENT_FLEET_RULES_PATH: '', ...env,
  },
});

rmSync(TMP, { recursive: true, force: true });
mkdirSync(path.join(MEM, 'capsules'), { recursive: true });

// A distinctive doctrine fixture — the sentinel strings appear nowhere else in
// any daemon output, so presence/absence assertions can't false-positive.
const DOCTRINE = '# FLEET_RULES fixture\n\n**FR-SENTINEL-ALPHA** one door, one file.\n\nFR-SENTINEL-OMEGA-TAIL';
const FR_PATH = path.join(TMP, 'FLEET_RULES.md');
writeFileSync(FR_PATH, DOCTRINE);

// ── syntax ────────────────────────────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, ['--check', path.join(DAEMONS, 'sessionstart-reinject.mjs')], { encoding: 'utf8' });
  check('syntax: sessionstart-reinject.mjs parses', r.status === 0, r.stderr);
}

// ── gate closed ───────────────────────────────────────────────────────────────
for (const gate of ['', '0']) {
  const r = run('startup', { AIGENT_FLEET_RULES_INJECT: gate, AIGENT_FLEET_RULES_PATH: FR_PATH });
  check(`gate ${gate === '' ? 'unset' : `'0'`}: warm-start output carries zero doctrine bytes`,
    r.status === 0 && !r.stdout.includes('FR-SENTINEL'), r.stdout.slice(0, 200));
}
{
  const r = run('clear', { AIGENT_FLEET_RULES_INJECT: '', AIGENT_FLEET_RULES_PATH: FR_PATH });
  check('gate unset: source=clear output carries zero doctrine bytes',
    r.status === 0 && !r.stdout.includes('FR-SENTINEL'), r.stdout.slice(0, 200));
}

// ── gate open, both paths ─────────────────────────────────────────────────────
{
  const r = run('startup', { AIGENT_FLEET_RULES_INJECT: '1', AIGENT_FLEET_RULES_PATH: FR_PATH });
  check('gate open: warm-start injects the doctrine block verbatim',
    r.status === 0 && r.stdout.includes('FR-SENTINEL-ALPHA') && r.stdout.includes('FR-SENTINEL-OMEGA-TAIL'), r.stdout.slice(-300));
}
{
  const r = run('clear', { AIGENT_FLEET_RULES_INJECT: '1', AIGENT_FLEET_RULES_PATH: FR_PATH });
  check('gate open: source=clear (resume-verb path) injects the doctrine block too',
    r.status === 0 && r.stdout.includes('FR-SENTINEL-ALPHA') && r.stdout.includes('FR-SENTINEL-OMEGA-TAIL'), r.stdout.slice(-300));
}

// ── truncation guard: pointer, never a truncated copy ─────────────────────────
{
  const BIG_PATH = path.join(TMP, 'FLEET_RULES_BIG.md');
  writeFileSync(BIG_PATH, '# big doctrine\n' + 'FR-BIG-LINE filler doctrine text.\n'.repeat(400) + 'FR-BIG-TAIL-SENTINEL');
  const r = run('startup', { AIGENT_FLEET_RULES_INJECT: '1', AIGENT_FLEET_RULES_PATH: BIG_PATH });
  const pointer = r.stdout.includes('too large to inject this fire') && r.stdout.includes(BIG_PATH);
  const noCopy = !r.stdout.includes('FR-BIG-LINE') && !r.stdout.includes('FR-BIG-TAIL-SENTINEL');
  check('oversize doctrine: POINTER line naming the source path, zero doctrine bytes', r.status === 0 && pointer && noCopy,
    `pointer=${pointer} noCopy=${noCopy}`);
}

// ── armed gate, no path: loud, never silent ───────────────────────────────────
{
  const r = run('startup', { AIGENT_FLEET_RULES_INJECT: '1', AIGENT_FLEET_RULES_PATH: '' });
  const log = existsSync(path.join(MEM, '.daemon-errors.log')) ? readFileSync(path.join(MEM, '.daemon-errors.log'), 'utf8') : '';
  check('armed gate + unset path: boot succeeds, no block, LOUD [EVER-623] log line',
    r.status === 0 && !r.stdout.includes('FR-SENTINEL') && /\[EVER-623\].*AIGENT_FLEET_RULES_PATH is unset/.test(log),
    log.split('\n').filter(l => l.includes('EVER-623')).slice(-1).join(''));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
