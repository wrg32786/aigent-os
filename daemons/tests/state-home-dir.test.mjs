// state-home-dir.test.mjs — the AIGENT_STATE_HOME_DIR diversion lever, pinned.
//
// Real-glue: calls the REAL memRoot from lifecycle-common.mjs against real temp
// trees. No mocks. Run: node daemons/tests/state-home-dir.test.mjs
//
// Why this must exist as a test and not a one-time manual probe: the lever is a
// safety valve (divert hook writes away from a real vault during isolation
// probes). A silent regression here means adversarial test capsules land in the
// real vault again — the exact class the lever was built to end. Both directions
// are asserted, so deleting the env check in memRoot turns this file red.
'use strict';

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asUrl = (p) => pathToFileURL(path.resolve(p)).href;
const { memRoot } = await import(asUrl(path.resolve(__dirname, '..', 'lifecycle-common.mjs')));

const savedEnv = process.env.AIGENT_STATE_HOME_DIR;
const root = mkdtempSync(path.join(os.tmpdir(), 'aigent-root-'));
const divert = mkdtempSync(path.join(os.tmpdir(), 'aigent-divert-'));
mkdirSync(path.join(root, 'vault', 'memory'), { recursive: true });
mkdirSync(path.join(divert, 'vault', 'memory'), { recursive: true });

try {
  // Direction 1 — lever UNSET: resolves under the passed root, untouched behavior.
  delete process.env.AIGENT_STATE_HOME_DIR;
  const unset = memRoot(root);
  assert.equal(unset, path.join(root, 'vault', 'memory'),
    'with the lever unset, memRoot must resolve under the passed root');
  console.log('PASS unset: memRoot resolves under root');

  // Direction 2 — lever SET: diverts even though the root's own memory dir exists.
  // This is the discriminating case: a broken lever silently falls through to the
  // real root and every hook write lands in the real vault.
  process.env.AIGENT_STATE_HOME_DIR = divert;
  const diverted = memRoot(root);
  assert.equal(diverted, path.join(divert, 'vault', 'memory'),
    'with the lever set, memRoot must resolve under the diversion dir, never the root');
  assert.ok(!diverted.startsWith(root), 'diverted path must not live under the real root');
  console.log('PASS set: memRoot diverts away from root');

  // Direction 3 — lever set to a bare (vault-less) dir: still diverts, using the
  // documented default shape rather than falling back to the root.
  const bare = mkdtempSync(path.join(os.tmpdir(), 'aigent-bare-'));
  try {
    process.env.AIGENT_STATE_HOME_DIR = bare;
    const bareResolved = memRoot(root);
    assert.ok(bareResolved.startsWith(bare),
      'a bare diversion dir still wins over the root (default vault/memory shape)');
    console.log('PASS bare: default shape created under the diversion dir, not the root');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  console.log('state-home-dir: 3/3 pass');
} finally {
  if (savedEnv === undefined) delete process.env.AIGENT_STATE_HOME_DIR;
  else process.env.AIGENT_STATE_HOME_DIR = savedEnv;
  rmSync(root, { recursive: true, force: true });
  rmSync(divert, { recursive: true, force: true });
}
