import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('compaction previews, moves the oldest loose entries, and rolls back a failed gate', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-compact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (script, ...args) => spawnSync(process.execPath, [
    fileURLToPath(new URL('../' + script, import.meta.url)), '--dir', dir, ...args,
  ], { encoding: 'utf8' });
  const compact = (...args) => run('memory-index-compact.mjs', '--threshold', '1', ...args);
  const index = path.join(dir, 'MEMORY.md');
  const notes = ['second', 'newest', 'oldest'];
  const lines = notes.map(name => '- [' + name + '](' + name + '.md) keep this description');
  for (const [i, name] of notes.entries()) {
    const file = path.join(dir, name + '.md');
    writeFileSync(file, '# ' + name);
    const date = new Date('2026-11-' + ['14', '15', '06'][i] + 'T12:00:00Z');
    utimesSync(file, date, date);
  }
  const original = ['# Memory', '', ...lines, ''].join('\r\n');
  writeFileSync(index, original);
  const before = readdirSync(dir);
  const preview = compact();
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(readdirSync(dir), before);
  assert.equal(readFileSync(index, 'utf8'), original);

  writeFileSync(index, original + 'See [[missing]].\r\n');
  const dirty = readFileSync(index);
  const rejected = compact('--apply');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, /DANGLING "missing\.md"/);
  assert.match(rejected.stderr, /Restored MEMORY\.md from backup/);
  assert.deepEqual(readFileSync(index), dirty);
  assert.deepEqual(readdirSync(dir), before);

  writeFileSync(index, original);
  const applied = compact('--apply');
  assert.equal(applied.status, 0, applied.stderr);
  const name = 'index-recent-2026-11-06-to-11-14.md';
  const main = readFileSync(index, 'utf8');
  assert.equal(main.split('](' + name + ')').length, 2);
  assert.ok(main.includes(lines[1]));
  const sub = readFileSync(path.join(dir, name), 'utf8');
  assert.match(sub, /^# Recent \(2026-11-06 to 2026-11-14\): 2 entries/);
  for (const line of [lines[0], lines[2]]) {
    assert.ok(sub.includes(line));
    assert.ok(!main.includes(line));
  }
  const checked = run('memory-orphan-check.mjs');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /orphaned 0/);
  assert.equal(compact('--apply').status, 0);
  assert.equal(readFileSync(index, 'utf8'), main);

  writeFileSync(path.join(dir, 'unlisted.md'), 'unlisted');
  const orphan = run('memory-orphan-check.mjs');
  assert.equal(orphan.status, 1);
  assert.match(orphan.stdout, /ORPHAN "unlisted\.md"/);
});
