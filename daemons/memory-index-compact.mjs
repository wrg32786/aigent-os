#!/usr/bin/env node
// node daemons/memory-index-compact.mjs [--dir MEMORIES | --root ROOT] [--threshold 50] [--apply]
// Keep the newest N loose entries by target file mtime (UTC), breaking ties by
// original line order. Preview by default. Existing sub-indexes are never replaced.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { maskMarkdownFences } from './nightly-freshness.mjs';
import { resolveNightlyPaths } from './nightly-paths.mjs';

function compact() {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, dir: { type: 'string' }, threshold: { type: 'string', default: '50' },
    apply: { type: 'boolean' },
  } });
  if (values.dir !== undefined && !values.dir.trim()) throw new Error('--dir needs a directory');
  const threshold = Number(values.threshold);
  if (!/^\d+$/.test(values.threshold) || !Number.isSafeInteger(threshold)) {
    throw new Error('--threshold must be a nonnegative integer');
  }
  const dir = path.resolve(values.dir || resolveNightlyPaths(values.root).memoryRoot);
  const index = path.join(dir, 'MEMORY.md');
  if (!fs.lstatSync(index).isFile()) throw new Error('expected a regular MEMORY.md');
  const original = fs.readFileSync(index);
  const text = original.toString('utf8');
  if (!Buffer.from(text).equals(original)) throw new Error('MEMORY.md must be UTF-8');
  const lines = text.split(/(?<=\n)/);
  const visible = maskMarkdownFences(text).split(/(?<=\n)/);
  const entries = [];
  for (const [i, line] of visible.entries()) {
    const file = /^- \[[^\]\n]+\]\(([^/\\)\s:]+\.md)\)/.exec(line)?.[1];
    if (file && file !== 'MEMORY.md' && !file.startsWith('index-')) {
      entries.push({ i, file });
    }
  }
  if (entries.length <= threshold) {
    console.log('No compaction needed: ' + entries.length + ' loose entries');
    return;
  }
  for (const entry of entries) entry.time = fs.statSync(path.join(dir, entry.file)).mtimeMs;
  const moved = entries.sort((a, b) => a.time - b.time || a.i - b.i).slice(0, entries.length - threshold);
  const day = entry => new Date(entry.time).toISOString().slice(0, 10);
  const from = day(moved[0]);
  const to = day(moved.at(-1));
  const end = from.slice(0, 4) === to.slice(0, 4) ? to.slice(5) : to;
  const name = 'index-recent-' + from + '-to-' + end + '.md';
  const archive = path.join(dir, name);
  if (fs.existsSync(archive)) throw new Error('archive already exists: ' + archive);
  const label = 'Recent (' + from + ' to ' + to + '): ' + moved.length + ' entries';
  console.log((values.apply ? 'Apply' : 'Dry run') + ': move ' + moved.length + ' entries into ' + name);
  if (!values.apply) return;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  moved.sort((a, b) => a.i - b.i);
  const rows = [];
  for (const entry of moved) {
    let end = entry.i + 1;
    for (let i = end; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (!/^[ \t]/.test(lines[i])) break;
      end = i + 1;
    }
    rows.push(lines.slice(entry.i, end).join('').replace(/\r?\n$/, ''));
    entry.end = end;
  }
  const contents = ['# ' + label, '', 'Sub-index of MEMORY.md. One entry per memory; open the file for the fact.',
    '', ...rows, ''].join(eol);
  const first = moved[0].i;
  const pointer = '- [' + label + '](' + name + ')' + (lines[first].endsWith('\n') ? eol : '');
  for (const entry of moved) lines.fill('', entry.i, entry.end);
  lines[first] = pointer;
  const next = Buffer.from(lines.join(''));
  const backup = path.join(dir, 'MEMORY.backup-compact');
  const work = backup + '.tmp';
  const pending = path.join(work, 'pending');
  const displaced = path.join(work, 'displaced');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const archiveHash = hash(contents);
  const mode = fs.statSync(index).mode;

  let keepWork = false;

  function checkArchive() {
    if (hash(fs.readFileSync(archive)) !== archiveHash) throw new Error('archive changed; kept ' + archive);
  }

  function installIndex(expected, replacement) {
    // Pin the displaced inode so a write through an open handle at rename time
    // can still be detected and recovered after the name switches.
    fs.linkSync(index, displaced);
    if (!fs.readFileSync(index).equals(expected)) throw new Error('index changed before rename');
    fs.renameSync(pending, index);
    if (!fs.readFileSync(displaced).equals(expected)) {
      keepWork = true;
      if (!fs.readFileSync(index).equals(replacement)) {
        throw new Error('index changed again; displaced edit kept at ' + displaced);
      }
      fs.renameSync(displaced, index);
      keepWork = false;
      throw new Error('index changed during rename');
    }
    fs.unlinkSync(displaced);
  }

  fs.mkdirSync(work);
  let wroteBackup = false;
  let wroteArchive = false;
  let installed = false;
  let keepBackup = false;
  try {
    if (fs.existsSync(backup)) throw new Error('recovery backup already exists: ' + backup);
    fs.copyFileSync(index, pending, fs.constants.COPYFILE_EXCL);
    if (!fs.readFileSync(pending).equals(original)) throw new Error('index changed before backup');
    fs.renameSync(pending, backup);
    wroteBackup = true;
    fs.writeFileSync(pending, contents);
    if (fs.existsSync(archive)) throw new Error('archive already exists: ' + archive);
    fs.renameSync(pending, archive);
    wroteArchive = true;
    fs.writeFileSync(pending, next, { mode });
    installIndex(original, next);
    installed = true;
    const checker = fileURLToPath(new URL('./memory-orphan-check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [checker, '--dir', dir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('orphan check failed');
  } catch (error) {
    if (installed) {
      keepBackup = true;
      checkArchive();
      fs.copyFileSync(backup, pending, fs.constants.COPYFILE_EXCL);
      if (!fs.readFileSync(pending).equals(original)) throw new Error('recovery backup changed: ' + backup);
      installIndex(next, original);
      keepBackup = false;
      console.error('Restored MEMORY.md from backup');
    }
    if (wroteArchive) {
      checkArchive();
      fs.unlinkSync(archive);
    }
    throw error;
  } finally {
    if (wroteBackup && !keepBackup) fs.unlinkSync(backup);
    if (!keepWork) fs.rmSync(work, { recursive: true });
  }
}

try {
  compact();
} catch (error) {
  console.error('memory-index-compact: ' + error.message);
  process.exitCode = 1;
}
