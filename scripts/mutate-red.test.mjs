// node --test scripts/mutate-red.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mutate-red.mjs');

function fixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mutate-red-test-'));
  const target = path.join(dir, 'target.txt');
  const check = path.join(dir, 'check.mjs');
  writeFileSync(target, 'value = 1 // note\n');
  writeFileSync(check, `import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync(${JSON.stringify(target)}, 'utf8').includes('value = 1') ? 0 : 1);\n`);
  const helper = (...args) => spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8', env: { ...process.env, MUTATE_RED_STORE: path.join(dir, 'store') },
  });
  try { return run({ dir, target, check, helper }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a mutation the check sees: exit 0 and the file is restored byte for byte', () => fixture(({ target, check, helper }) => {
  const before = readFileSync(target);
  const r = helper('--file', target, '--find', 'value = 1', '--replace', 'value = 2', '--', process.execPath, check);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS/);
  assert.deepEqual(readFileSync(target), before);
}));

test('a mutation the check cannot see: exit 1, STILL GREEN, file restored', () => fixture(({ target, check, helper }) => {
  const before = readFileSync(target);
  const r = helper('--file', target, '--find', 'note', '--replace', 'nope', '--', process.execPath, check);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /STILL GREEN/);
  assert.deepEqual(readFileSync(target), before);
}));

test('find text that is missing or repeated refuses before touching the file', () => fixture(({ target, check, helper }) => {
  const before = readFileSync(target);
  const r = helper('--file', target, '--find', 'absent', '--replace', 'x', '--', process.execPath, check);
  assert.equal(r.status, 2);
  assert.deepEqual(readFileSync(target), before);
}));

test('a run killed mid-test is recovered by --restore, and blocks new runs until then', () => fixture(({ dir, target, check, helper }) => {
  const before = readFileSync(target);
  // Kill only this fixture's helper, once the check has observed the mutation.
  const killHelper = path.join(dir, 'kill-helper.mjs');
  writeFileSync(killHelper, `import { readFileSync } from 'node:fs';
if (readFileSync(${JSON.stringify(target)}, 'utf8').includes('value = 9')) {
  process.kill(process.ppid, 'SIGKILL');
}
`);
  const killed = helper('--file', target, '--find', 'value = 1', '--replace', 'value = 9',
    '--', process.execPath, killHelper);
  assert.notEqual(killed.status, 0, 'the interrupted helper must not complete');
  assert.match(readFileSync(target, 'utf8'), /value = 9/, 'the mutation is still on disk after the kill');
  const blocked = helper('--file', target, '--find', 'value = 9', '--replace', 'value = 1', '--', process.execPath, check);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /--restore first/);
  const restored = helper('--restore');
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(readFileSync(target), before);
  assert.equal(existsSync(path.join(dir, 'store')) && helper('--restore').stdout.includes('nothing pending'), true);
}));
