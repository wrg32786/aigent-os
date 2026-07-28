// curated-close-pointer containment: the stamped capsule must live under the
// memory root.
//
// Before this guard the argument was bounded by nothing but existsSync, so a
// path climbing out of the vault resolved, existed, and got stamped -- and the
// pointer stores its `path` relative to the project root, so the stored value
// came out `../..`-prefixed and every later reader would follow it out.
//
// The sibling-prefix case is the one a naive fix fails: `memory-backup` starts
// with `memory`, so a startsWith test would let it through. Containment is
// therefore asserted on a normalised relative path.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'curated-close-pointer.mjs');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ccp-containment-'));
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  mkdirSync(path.join(root, 'memory-backup'), { recursive: true });
  mkdirSync(path.join(root, 'outside'), { recursive: true });

  const capsule = (id) => `---\nid: ${id}\nstatus: active\ncreated_at: 2026-07-28T00:00:00Z\n---\nbody\n`;
  writeFileSync(path.join(root, 'memory', 'capsules', 'inside.md'), capsule('inside'));
  writeFileSync(path.join(root, 'memory-backup', 'sibling.md'), capsule('sibling'));
  writeFileSync(path.join(root, 'outside', 'outside.md'), capsule('outside'));
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), '{"state":{}}');
  return root;
}

const run = (root, capsulePath) =>
  spawnSync(process.execPath, [SCRIPT, capsulePath], {
    env: { ...process.env, AIGENT_ROOT: root, AIGENT_STATE_HOME_DIR: '' },
    encoding: 'utf8',
  });

test('accepts a capsule inside the memory root', () => {
  const root = fixture();
  const r = run(root, path.join(root, 'memory', 'capsules', 'inside.md'));
  // Stated so a future reader knows this is the half that proves the guard is
  // not simply refusing everything. A check that can only go red is not a check.
  assert.strictEqual(r.status, 0, `expected stamp, got status=${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /STAMPED/);
});

test('refuses a capsule outside the memory root', () => {
  const root = fixture();
  const r = run(root, path.join(root, 'outside', 'outside.md'));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /outside the memory root/);
});

test('refuses a traversal that climbs out and back down', () => {
  const root = fixture();
  const r = run(root, path.join(root, 'memory', '..', 'outside', 'outside.md'));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /outside the memory root/);
});

test('refuses a sibling whose name merely prefixes the memory root', () => {
  const root = fixture();
  const r = run(root, path.join(root, 'memory-backup', 'sibling.md'));
  assert.strictEqual(r.status, 1, 'a startsWith-based containment check would pass this');
  assert.match(r.stderr, /outside the memory root/);
});
