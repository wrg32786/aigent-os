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
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
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
  if (memoryRoot) {
    write(path.join(root, '.aigent', 'state.json'), JSON.stringify({ memory_root: memoryRoot }));
    mkdirSync(path.join(root, ...memoryRoot.split('/')), { recursive: true });
  }
  const base = deep ? path.join(root, deep) : root;
  const seat = { root, sem, base };
  if (memoryRoot === 'memory') declareLocal(seat, []);
  return seat;
}

// What a root-layout seat declares for itself: core does not know its folders.
function declareLocal(seat, rows) {
  const all = rows.some(([name]) => name === '.aigent') ? rows : [['.aigent', 'SKIP'], ...rows];
  write(path.join(seat.sem, 'namespace-registry.local.json'), JSON.stringify({
    schema: 'MemoryNamespaceRegistry/v1',
    namespaces: all.map(([name, disposition]) => ({
      path: name,
      disposition,
      ...(disposition === 'SKIP' ? { reason: 'seat folder' } : {}),
    })),
  }));
}

// Make a directory unreadable to this process; returns the way back.
function denyRead(dir) {
  if (process.platform === 'win32') {
    spawnSync('icacls', [dir, '/deny', `${process.env.USERNAME}:(RX)`], { encoding: 'utf8' });
    return () => spawnSync('icacls', [dir, '/remove:d', process.env.USERNAME], { encoding: 'utf8' });
  }
  chmodSync(dir, 0o000);
  return () => chmodSync(dir, 0o755);
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
  const product = ['docs', 'evals', 'hooks', 'launcher', 'loops', 'scripts', 'skills', 'system', 'handoffs', '.aigent', 'vault'];
  for (const name of product) write(path.join(seat.root, name, 'file.md'), note('product file'));
  declareLocal(seat, product.map((name) => [name, 'SKIP']));

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
  declareLocal(seat, [['docs', 'SKIP']]);
  run(seat, 'embed-vault.js');
  const result = run(seat, 'search-vault.js', ['lesson']);
  assert.equal(result.status, 0, result.all);
  assert.match(result.all, /memory\/lesson\.md/);
}));

test('sis-10. an undeclared folder still refuses, names itself, and leaves the index alone', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  run(seat, 'embed-vault.js');
  const file = path.join(seat.root, 'memory', 'embeddings.json');
  const before = readFileSync(file, 'utf8');
  write(path.join(seat.root, 'docs', 'authored.md'), note('a real authored note'));
  const result = run(seat, 'embed-vault.js');
  assert.notEqual(result.status, 0);
  assert.match(result.all, /undeclared vault namespace.*docs/);
  assert.equal(readFileSync(file, 'utf8'), before);
}));

test('sis-11. a seat can opt its own folder in', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'docs', 'authored.md'), note('a real authored note'));
  declareLocal(seat, [['docs', 'INDEX']]);
  const result = run(seat, 'embed-vault.js');
  assert.equal(result.status, 0, result.all);
  assert.deepEqual(paths(readIndex(path.join(seat.root, 'memory', 'embeddings.json'))), ['docs/authored.md']);
}));

test('sis-12. an incomplete scan keeps every entry: an unreadable folder is not a deleted one', {
  skip: process.getuid?.() === 0 && 'root reads everything',
}, () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  const sub = path.join(seat.root, 'memory', 'sub');
  write(path.join(sub, 'one.md'), note('nested one'));
  write(path.join(sub, 'two.md'), note('nested two'));
  const file = path.join(seat.root, 'memory', 'embeddings.json');
  run(seat, 'embed-vault.js');
  assert.equal(paths(readIndex(file)).length, 3);

  const restore = denyRead(sub);
  try {
    write(path.join(seat.root, 'memory', 'newer.md'), note('a changed note'));
    const result = run(seat, 'embed-vault.js', ['--changed-only']);
    assert.equal(result.status, 0, result.all);
    assert.match(result.all, /scan was incomplete/);
  } finally {
    restore();
  }
  assert.ok(paths(readIndex(file)).includes('memory/sub/one.md'), 'a healthy index was emptied');
}));

test('sis-13. a run from another tree refuses and loses nothing', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  const file = path.join(seat.root, 'memory', 'embeddings.json');
  run(seat, 'embed-vault.js');
  const before = readFileSync(file, 'utf8');
  mkdirSync(path.join(seat.root, 'empty'));
  const result = run(seat, 'embed-vault.js', [], { AIGENT_VAULT_ROOT: path.join(seat.root, 'empty') });
  assert.notEqual(result.status, 0);
  assert.match(result.all, /REFUSING to run: this index was built from/);
  assert.equal(readFileSync(file, 'utf8'), before);
}));

test('sis-14. an index from before vaultRoot keeps everything on its first run, then sheds on the next', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  const file = path.join(seat.root, 'memory', 'embeddings.json');
  run(seat, 'embed-vault.js');
  const index = readIndex(file);
  delete index.vaultRoot;
  index.notes.push({ ...index.notes[0], path: 'concepts/starter.md' });
  writeFileSync(file, JSON.stringify(index));
  assert.equal(run(seat, 'embed-vault.js', ['--changed-only']).status, 0);
  assert.deepEqual(paths(readIndex(file)), ['concepts/starter.md', 'memory/lesson.md']);
  assert.equal(readIndex(file).vaultRoot, '.');
  assert.equal(run(seat, 'embed-vault.js', ['--changed-only']).status, 0);
  assert.deepEqual(paths(readIndex(file)), ['memory/lesson.md']);
}));

test('sis-18. a legacy index sharing one file with a wrong tree is not cut down to that file', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'MEMORY.md'), note('index of notes'));
  const file = path.join(seat.root, 'memory', 'embeddings.json');
  run(seat, 'embed-vault.js');
  const index = readIndex(file);
  delete index.vaultRoot;
  const template = index.notes[0];
  for (let i = 0; i < 20; i += 1) index.notes.push({ ...template, path: `concepts/real-${i}.md` });
  writeFileSync(file, JSON.stringify(index));
  assert.equal(paths(readIndex(file)).length, 21);
  assert.equal(run(seat, 'embed-vault.js').status, 0);
  assert.equal(paths(readIndex(file)).length, 21, 'one shared file must not decide which tree an index belongs to');
}));

test('sis-15. a finished run leaves no partial file behind', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  run(seat, 'embed-vault.js');
  const left = readdirSync(path.join(seat.root, 'memory')).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(left, []);
  assert.ok(existsSync(path.join(seat.root, 'memory', 'embeddings.json')));
}));

test('sis-16. a pre-vaultRoot index from another tree refuses: one local file must not replace it', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  const file = path.join(seat.root, 'memory', 'embeddings.json');
  run(seat, 'embed-vault.js');
  const index = readIndex(file);
  delete index.vaultRoot;
  index.notes = index.notes.map((entry) => ({ ...entry, path: 'concepts/elsewhere.md' }));
  writeFileSync(file, JSON.stringify(index));
  const before = readFileSync(file, 'utf8');

  const result = run(seat, 'embed-vault.js');
  assert.notEqual(result.status, 0);
  assert.match(result.all, /REFUSING to run: none of the/);
  assert.equal(readFileSync(file, 'utf8'), before);
}));

test('sis-17. a save that cannot complete says so and strands no partial file', () => withSeat({ memoryRoot: 'memory' }, (seat) => {
  write(path.join(seat.root, 'memory', 'lesson.md'), note('real lesson'));
  write(path.join(seat.root, 'memory', 'embeddings.json', 'blocks-the-rename'), 'x');
  const result = run(seat, 'embed-vault.js');
  assert.notEqual(result.status, 0);
  assert.match(result.all, /index not saved/);
  const left = readdirSync(path.join(seat.root, 'memory')).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(left, []);
}));
