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

// Interpose at the filesystem boundary so edits land on a specific operation.
function scenario(t, hook = '', dangling = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-compact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const index = path.join(dir, 'MEMORY.md');
  const bullet = name => '- [' + name + '](' + name + '.md)';
  const notes = ['second', 'first', 'last'];
  const main = [bullet('second'), '  second detail', '', '  second paragraph', bullet('first'),
    '\tfirst detail', bullet('last'), '  last detail', dangling ? '[[missing]]' : '', ''].join('\r\n');
  writeFileSync(index, main);
  for (const [i, name] of notes.entries()) {
    const file = path.join(dir, name + '.md');
    writeFileSync(file, name);
    utimesSync(file, [2, 1, 3][i], [2, 1, 3][i]);
  }
  const preload = path.join(dir, 'hook.cjs');
  writeFileSync(preload, "const fs = require('node:fs');\nconst path = require('node:path');\n" + hook);
  const result = spawnSync(process.execPath, ['--require', preload,
    fileURLToPath(new URL('../memory-index-compact.mjs', import.meta.url)),
    '--dir', dir, '--threshold', '1', '--apply'], { encoding: 'utf8' });
  const archive = readdirSync(dir).find(name => name.startsWith('index-') && name.endsWith('.md'));
  return { result, main, index, archive: archive && path.join(dir, archive), bullet };
}

test('archive retains source order when mtimes disagree', t => {
  const { result, archive, bullet } = scenario(t);
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(archive, 'utf8');
  const bullets = text.split(/\r?\n/).filter(line => line.startsWith('- '));
  assert.deepEqual(bullets, [bullet('second'), bullet('first')], 'archive reordered the bullets');
});

test('indented continuations move with their bullet', t => {
  const { result, archive, index, bullet } = scenario(t);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(archive, 'utf8').includes(bullet('second') + '\r\n  second detail\r\n\r\n  second paragraph'));
  assert.match(readFileSync(archive, 'utf8'), /\r\n\tfirst detail/);
  assert.doesNotMatch(readFileSync(index, 'utf8'), /second detail|second paragraph|first detail/);
  assert.match(readFileSync(index, 'utf8'), /\r\n  last detail/);
});

for (const target of ['backup', 'archive']) {
  test(target + ' is published by rename with complete contents', t => {
    const hook = `
      const rename = fs.renameSync;
      fs.renameSync = (src, dest) => {
        if (${target === 'backup' ? "path.basename(dest) === 'MEMORY.backup-compact'" : "/^index-.*\\.md$/.test(path.basename(dest))"}) {
          if (fs.existsSync(dest)) throw Error('destination visible before rename');
          if (!fs.readFileSync(src, 'utf8').includes('second detail')) throw Error('incomplete temp file');
          console.log('observed complete rename');
        }
        return rename(src, dest);
      };`;
    const { result } = scenario(t, hook);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /observed complete rename/, target + ' was not published by rename');
  });
}

for (const phase of ['compaction', 'rollback']) {
  test(phase + ' refuses an edit at the index rename boundary', t => {
    const hook = `
      const rename = fs.renameSync;
      let installs = 0;
      fs.renameSync = (src, dest) => {
        if (path.basename(dest) === 'MEMORY.md' && ++installs === ${phase === 'rollback' ? 2 : 1}) {
          fs.writeFileSync(dest, 'concurrent edit');
        }
        return rename(src, dest);
      };`;
    const { result, index } = scenario(t, hook, phase === 'rollback');
    assert.equal(readFileSync(index, 'utf8'), 'concurrent edit', 'rename erased the concurrent edit');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /index changed/);
  });
}

test('failed gate preserves an edited archive', t => {
  const hook = `
    const rename = fs.renameSync;
    fs.renameSync = (src, dest) => {
      rename(src, dest);
      if (path.basename(dest) === 'MEMORY.md') {
        const dir = path.dirname(dest);
        const archive = fs.readdirSync(dir).find(name => /^index-.*\\.md$/.test(name));
        if (archive) fs.writeFileSync(path.join(dir, archive), 'edited archive');
      }
    };`;
  const { result, archive } = scenario(t, hook, true);
  assert.notEqual(result.status, 0);
  assert.ok(archive, 'rollback deleted the edited archive');
  assert.equal(readFileSync(archive, 'utf8'), 'edited archive');
  assert.match(result.stderr, /archive changed/);
});
