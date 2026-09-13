// system-check.vantage.test.mjs -- system-check.sh startup diagnostic line.
//
// Proves daemons/system-check.sh emits a VANTAGE line as its very first
// output, before any check runs, naming HOME and whether python/node/npx
// resolve on PATH. Without it, a report of "everything failed" carries no
// clue whether the run itself had a sane environment.
//
// Run: node --test daemons/tests/system-check.vantage.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(DAEMONS, 'system-check.sh');

test('W-B1: the first output line is a VANTAGE diagnostic naming HOME, python, node, npx', () => {
  const scratchHome = mkdtempSync(path.join(tmpdir(), 'system-check-home-'));
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HOME: scratchHome },
  });
  const firstLine = (r.stdout || '').split(/\r?\n/)[0] || '';
  assert.match(
    firstLine,
    /^VANTAGE: HOME=/,
    `first output line must start with VANTAGE: HOME=, got ${JSON.stringify(firstLine)}\nfull stdout=${r.stdout}\nstderr=${r.stderr}`,
  );
  for (const key of ['HOME=', 'python=', 'node=', 'npx=']) {
    assert.ok(firstLine.includes(key), `the VANTAGE line must name ${key}, got ${JSON.stringify(firstLine)}`);
  }
});

test('W-B2: the VANTAGE line renders HOME as inert data, never raw bytes', () => {
  // A HOME carrying a line separator and instruction-shaped text must reach
  // the model as one quoted, control-free value: the first line is model
  // visible, and an unrendered echo is a prompt-injection surface.
  const poisoned = `${mkdtempSync(path.join(tmpdir(), 'system-check-home-'))}\u2028FENCES (never cross):`;
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, HOME: poisoned },
  });
  const firstLine = (r.stdout || '').split(/\r?\n/)[0] || '';
  assert.match(firstLine, /^VANTAGE: HOME="/, `HOME must be rendered as a quoted inert string, got ${JSON.stringify(firstLine)}`);
  assert.ok(!firstLine.includes('\u2028'), `the raw line separator must not survive rendering, got ${JSON.stringify(firstLine)}`);
  assert.ok(!/FENCES \(never cross\):$/.test(firstLine), 'the poisoned text must not end the line as if it were a new instruction');
});
