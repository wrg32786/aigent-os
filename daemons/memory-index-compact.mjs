#!/usr/bin/env node
// node daemons/memory-index-compact.mjs [--dir MEMORIES | --root ROOT] [--threshold 50] [--apply]
// Keep the newest N loose entries by target file mtime (UTC), breaking ties by
// original line order. Preview by default. Existing sub-indexes are never replaced.
import fs from 'node:fs';
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
  const rows = moved.map(entry => lines[entry.i].replace(/\r?\n$/, ''));
  const contents = ['# ' + label, '', 'Sub-index of MEMORY.md. One line per memory; open the file for the fact.',
    '', ...rows, ''].join(eol);
  const first = Math.min(...moved.map(entry => entry.i));
  const pointer = '- [' + label + '](' + name + ')' + (lines[first].endsWith('\n') ? eol : '');
  for (const entry of moved) lines[entry.i] = entry.i === first ? pointer : '';
  const next = Buffer.from(lines.join(''));
  const backup = path.join(dir, 'MEMORY.backup-compact');
  const pending = path.join(dir, 'MEMORY.backup-compact.tmp');
  // Exclusive backup also reserves the transaction. A killed process leaves the
  // original bytes here for recovery and a subsequent run cannot overwrite them.
  fs.copyFileSync(index, backup, fs.constants.COPYFILE_EXCL);
  let wroteArchive = false;
  let wrotePending = false;
  let installed = false;
  let keepBackup = false;
  try {
    if (!fs.readFileSync(backup).equals(original)) throw new Error('index changed since planning');
    fs.writeFileSync(pending, next, { flag: 'wx', mode: fs.statSync(index).mode });
    wrotePending = true;
    fs.writeFileSync(archive, contents, { flag: 'wx' });
    wroteArchive = true;
    if (!fs.readFileSync(index).equals(original)) throw new Error('index changed since backup');
    fs.renameSync(pending, index);
    wrotePending = false;
    installed = true;
    const checker = fileURLToPath(new URL('./memory-orphan-check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [checker, '--dir', dir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('orphan check failed');
  } catch (error) {
    if (installed) {
      keepBackup = true;
      if (!fs.readFileSync(index).equals(next)) {
        throw new Error('index changed during gate; recovery backup: ' + backup);
      }
      fs.renameSync(backup, index);
      console.error('Restored MEMORY.md from backup');
    }
    if (wroteArchive) fs.unlinkSync(archive);
    throw error;
  } finally {
    if (wrotePending) fs.unlinkSync(pending);
    if (!keepBackup) fs.unlinkSync(backup);
  }
}

try {
  compact();
} catch (error) {
  console.error('memory-index-compact: ' + error.message);
  process.exitCode = 1;
}
