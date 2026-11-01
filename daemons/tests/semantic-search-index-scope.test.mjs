// semantic-search-index-scope.test.mjs -- what the indexer reads, and what stays
// in the file it writes (issue #148).
//
// Measured on a seat whose notes sit at the vault root, 2026-11-01. The indexer
// defaulted to <root>/vault, so it read 69 starter files and reported success.
// Rebuilt at the right root, one 15.6 MB archive took 12,072 of 15,054 entries
// and a title-exact query ranked its note fifth, and 64 paths from the wrong
// build were still in the file.
//
// The real scripts run end to end over fixture vaults with a stub model, as the
// deny-list suite does. Assertions read the index they wrote.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEM = path.join(DAEMONS, 'semantic-search');
const LONG = 'A sentence of ordinary note text with enough length to survive the chunker. ';

function write(target, text) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function makeSeat({ memoryRoot = null, deep = '' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'index-scope-'));
  const sem = path.join(root, 'daemons', 'semantic-search');
  mkdirSync(sem, { recursive: true });
  mkdirSync(path.join(root, 'daemons', 'memory-hygiene'), { recursive: true });
  for (const file of ['deny-list.mjs', 'namespace-registry.mjs', 'namespace-registry.json', 'embed-vault.js', 'search-vault.js']) {
    copyFileSync(path.join(SEM, file), path.join(sem, file));
  }
  for (const file of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'memory-root.cjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, file), path.join(root, 'daemons', file));
  }
  copyFileSync(
    path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'),
    path.join(root, 'daemons', 'memory-hygiene', 'resume-framing.mjs'),
  );
  write(path.join(root, 'node_modules', '@xenova', 'transformers', 'package.json'), JSON.stringify({
    name: '@xenova/transformers', version: '0.0.0-test-stub', type: 'module', main: 'index.js',
  }));
  write(path.join(root, 'node_modules', '@xenova', 'transformers', 'index.js'),
    'export async function pipeline() { return async () => ({ data: Float32Array.from([1, 0, 0, 0]) }); }\n');
  if (memoryRoot) write(path.join(root, '.aigent', 'state.json'), JSON.stringify({ memory_root: memoryRoot }));
  const base = deep ? path.join(root, deep) : root;
  return { root, sem, base };
}

function run(seat, script, args = [], env = {}) {
  const { AIGENT_VAULT_ROOT: _drop, ...clean } = process.env;
  const result = spawnSync(process.execPath, [path.join(seat.sem, script), ...args], {
    encoding: 'utf8',
    env: { ...clean, AIGENT_ROOT: seat.root, ...env },
  });
  return { status: result.status, all: `${result.stdout || ''}${result.stderr || ''}` };
}

const readIndex = (file) => JSON.parse(readFileSync(file, 'utf8'));
const paths = (index) => [...new Set(index.notes.map((note) => note.path))].sort();

function withSeat(options, body) {
  const seat = makeSeat(options);
  try {
    return body(seat);
  } finally {
    rmSync(seat.root, { recursive: true, force: true });
  }
}

const note = (text) => `# Note\n\n${LONG.repeat(4)}${text}\n`;

test('sis-1. a root-layout seat indexes its own notes with no override, not the starter tree', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  write(path.join(seat.root, 'concepts', 'own.md'), note('own concept'));
  write(path.join(seat.root, 'vault', 'concepts', 'starter.md'), note('starter text'));
  for (const product of ['docs', 'evals', 'hooks', 'launcher', 'loops', 'scripts', 'skills', 'system', 'handoffs', '.aigent']) {
    write(path.join(seat.root, product, 'file.md'), note('product file'));
  }

  const result = run(seat, 'embed-vault.js');
  assert.equal(result.status, 0, result.all);
  const index = readIndex(path.join(seat.root, 'memory', 'embeddings.json'));
  assert.deepEqual(paths(index), ['concepts/own.md', 'memory/lesson.md']);
}));

test('sis-2. the standard layout reads the tree it always read', () => withSeat({}, (seat) => {
  write(path.join(seat.root, 'vault', 'memory', 'lesson.md'), note('real lesson'));
  write(path.join(seat.root, 'vault', 'concepts', 'own.md'), note('own concept'));
  assert.equal(run(seat, 'embed-vault.js').status, 0);
  const index = readIndex(path.join(seat.root, 'vault', 'memory', 'embeddings.json'));
  assert.deepEqual(paths(index), ['concepts/own.md', 'memory/lesson.md']);
}));

test('sis-3. a nested memory root reads beside itself', () => withSeat({ memoryRoot: '.seat/vault/memory' }, (seat) => {
  write(path.join(seat.root, '.seat', 'vault', 'memory', 'lesson.md'), note('real lesson'));
  assert.equal(run(seat, 'embed-vault.js').status, 0);
  const index = readIndex(path.join(seat.root, '.seat', 'vault', 'memory', 'embeddings.json'));
  assert.deepEqual(paths(index), ['memory/lesson.md']);
}));

test('sis-4. an explicit AIGENT_VAULT_ROOT still wins', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'elsewhere', 'memory', 'there.md'), note('other tree'));
  write(path.join(seat.root, 'memory', 'here.md'), note('this tree'));
  const result = run(seat, 'embed-vault.js', [], { AIGENT_VAULT_ROOT: path.join(seat.root, 'elsewhere') });
  assert.equal(result.status, 0, result.all);
  assert.deepEqual(paths(readIndex(path.join(seat.root, 'memory', 'embeddings.json'))), ['memory/there.md']);
}));

test('sis-5. the index records the tree it came from', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  run(seat, 'embed-vault.js');
  assert.equal(readIndex(path.join(seat.root, 'memory', 'embeddings.json')).vaultRoot, '.');
}));

test('sis-6. one file cannot take over the corpus, and the cap samples the whole file, not its head', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'archive.md'), `# Archive\n\n${'\n\n'.concat(LONG.repeat(30)).repeat(800)}`);
  write(path.join(seat.root, 'memory', 'small.md'), note('a small note'));
  const result = run(seat, 'embed-vault.js');
  assert.equal(result.status, 0, result.all);
  assert.match(result.all, /capped memory\/archive\.md/);
  const index = readIndex(path.join(seat.root, 'memory', 'embeddings.json'));
  const archive = index.notes.filter((entry) => entry.path === 'memory/archive.md');
  assert.equal(archive.length, 400);
  const last = archive[0].chunkCount - 1;
  assert.ok(last > 400, 'the fixture must exceed the cap');
  assert.equal(archive[0].chunkIndex, 0);
  assert.equal(archive.at(-1).chunkIndex, last, 'the end of the file stays reachable');
  assert.equal(index.notes.filter((entry) => entry.path === 'memory/small.md').length, 1, 'a small note is untouched');
}));

test('sis-7. entries for a file no longer in scope are dropped, even on an incremental run with nothing new', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  const file = path.join(seat.root, 'memory', 'embeddings.json');
  run(seat, 'embed-vault.js');
  const index = readIndex(file);
  index.notes.push({ ...index.notes[0], path: 'concepts/gone.md' });
  writeFileSync(file, JSON.stringify(index));

  const result = run(seat, 'embed-vault.js', ['--changed-only']);
  assert.equal(result.status, 0, result.all);
  assert.deepEqual(paths(readIndex(file)), ['memory/lesson.md']);
}));

test('sis-8. noteCount counts what is in the index', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  write(path.join(seat.root, 'memory', 'empty.md'), '# x\n');
  run(seat, 'embed-vault.js');
  const index = readIndex(path.join(seat.root, 'memory', 'embeddings.json'));
  assert.equal(index.noteCount, paths(index).length);
}));

test('sis-9. search reads the same tree with no override', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  write(path.join(seat.root, 'docs', 'file.md'), note('product file'));
  run(seat, 'embed-vault.js');
  const result = run(seat, 'search-vault.js', ['lesson']);
  assert.equal(result.status, 0, result.all);
  assert.match(result.all, /memory\/lesson\.md/);
}));
