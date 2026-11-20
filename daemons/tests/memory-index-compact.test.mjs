import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('compaction previews, moves the oldest loose entries, and detects orphans', (t) => {
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

test('archive is published with complete contents', t => {
  const expected = [
    '# Recent (1970-01-01 to 1970-01-01): 2 entries', '',
    'Sub-index of MEMORY.md. One entry per memory; open the file for the fact.', '',
    '- [second](second.md)', '  second detail', '', '  second paragraph',
    '- [first](first.md)', '\tfirst detail', '',
  ].join('\r\n');
  const hook = `
    const link = fs.linkSync;
    fs.linkSync = (src, dest) => {
      if (path.basename(dest).startsWith('index-')) {
        if (fs.existsSync(dest)) throw Error('destination visible before publication');
        link(src, dest);
        require('node:assert/strict').deepEqual(fs.readFileSync(dest), Buffer.from(${JSON.stringify(expected)}));
        console.log('observed complete file');
        return;
      }
      return link(src, dest);
    };`;
  const { result } = scenario(t, hook);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /observed complete file/);
});

test('one rename replaces the live index with its staged sibling', t => {
  const hook = `
    const rename = fs.renameSync;
    fs.renameSync = (src, dest) => {
      if (path.basename(src) === 'MEMORY.md') throw Error('moved the live index aside');
      if (path.basename(dest) === 'MEMORY.md') {
        const dir = path.dirname(dest);
        const backups = fs.readdirSync(dir).filter(name => name.startsWith('MEMORY.backup-compact')
          && fs.statSync(path.join(dir, name), { bigint: true }).ino === fs.statSync(dest, { bigint: true }).ino);
        require('node:assert/strict').deepEqual(backups, ['MEMORY.backup-compact-1970-01-01-to-01-01']);
        if (path.dirname(src) !== dir) throw Error('temp file is not beside live index');
        console.log('replacing live index');
      }
      return rename(src, dest);
    };`;
  const { result, index, archive } = scenario(t, hook);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('replacing live index').length - 1, 1);
  assert.ok(readFileSync(index, 'utf8').includes('](' + path.basename(archive) + ')'));
});

test('a backup edit at publication keeps both versions and reports their paths', t => {
  const hook = `
    for (const op of ['renameSync', 'linkSync']) {
      const publish = fs[op];
      fs[op] = (src, dest) => {
        publish(src, dest);
        if (path.basename(dest) === 'MEMORY.md') {
          const dir = path.dirname(dest);
          const backup = fs.readdirSync(dir).find(name => name.startsWith('MEMORY.backup-compact')
            && fs.statSync(path.join(dir, name)).isFile());
          fs.writeFileSync(path.join(dir, backup), 'edited original');
          console.log('edited original');
        }
      };
    }`;
  const { result, index, archive } = scenario(t, hook);
  assert.match(result.stdout, /edited original/);
  assert.equal(result.status, 1, 'compaction accepted a changed backup');
  const dir = path.dirname(index);
  const backup = readdirSync(dir).find(name => name.startsWith('MEMORY.backup-compact'));
  assert.equal(readFileSync(path.join(dir, backup), 'utf8'), 'edited original');
  assert.ok(readFileSync(index, 'utf8').includes('](' + path.basename(archive) + ')'));
  for (const file of [path.join(dir, backup), index]) assert.ok(result.stderr.includes(file), result.stderr);
});

test('a failed orphan check leaves the original index and keeps the new archive', t => {
  const { result, main, index, archive, bullet } = scenario(t, '', true);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /DANGLING "missing\.md"/);
  assert.equal(readFileSync(index, 'utf8'), main);
  assert.ok(archive, 'failed gate deleted the new archive');
  assert.ok(readFileSync(archive, 'utf8').includes(bullet('second')));
});

test('failed install preserves the archive named by the live index', t => {
  const hook = `
    for (const op of ['renameSync', 'linkSync']) {
      const publish = fs[op];
      fs[op] = (src, dest) => {
        publish(src, dest);
        if (path.basename(dest) === 'MEMORY.md') {
          fs.appendFileSync(dest, 'later edit');
          throw Error('injected install failure');
        }
      };
    }`;
  const { result, index, archive } = scenario(t, hook);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /injected install failure/);
  const live = readFileSync(index, 'utf8');
  assert.match(live, /later edit$/);
  assert.ok(archive, 'cleanup deleted the archive named by MEMORY.md');
  assert.ok(live.includes('](' + path.basename(archive) + ')'));
  assert.match(readFileSync(archive, 'utf8'), /second detail/);
});

test('exclusive archive creation refuses a competing file at publication', t => {
  const hook = `
    const open = fs.openSync;
    const plant = file => {
      if (path.basename(file).startsWith('index-') && !fs.existsSync(file)) {
        const fd = open(file, 'wx');
        fs.writeSync(fd, 'competing archive');
        fs.closeSync(fd);
      }
    };
    fs.openSync = (file, flags, ...rest) => {
      if (flags === 'wx') plant(file);
      return open(file, flags, ...rest);
    };
    for (const op of ['renameSync', 'linkSync']) {
      const publish = fs[op];
      fs[op] = (src, dest) => {
        plant(dest);
        return publish(src, dest);
      };
    }`;
  const { result, main, index, archive } = scenario(t, hook);
  assert.equal(readFileSync(archive, 'utf8'), 'competing archive', 'publication replaced a competing archive');
  assert.equal(result.status, 1);
  assert.equal(readFileSync(index, 'utf8'), main);
});
