#!/usr/bin/env node
// node daemons/memory-index-compact.mjs [--dir MEMORIES | --root ROOT] [--threshold 50] [--apply]
// Keep the newest N loose entries by target file mtime (UTC), breaking ties by
// original line order. Preview by default. Archives are exclusive and are never
// retired automatically, even after a failed check. Each successful replacement
// leaves a dated hard-link backup of the previous MEMORY.md beside the index.
// An editor that replaces MEMORY.md between the backup link and rename loses that save. The run still exits 0.
// A write through an old file handle after the backup comparison reaches only the dated backup. The run still exits 0.
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
  const backup = path.join(dir, 'MEMORY.backup-compact-' + from + '-to-' + end);
  const pending = path.join(dir, 'MEMORY.compact.tmp');
  const stagedArchive = pending + '.archive';

  fs.writeFileSync(pending, next, { flag: 'wx', mode: fs.statSync(index).mode });
  try {
    fs.writeFileSync(stagedArchive, contents, { flag: 'wx' });
    try {
      fs.linkSync(stagedArchive, archive);
    } finally {
      fs.unlinkSync(stagedArchive);
    }
    const checker = fileURLToPath(new URL('./memory-orphan-check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [checker, '--dir', dir, '--staged', pending], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('orphan check failed');

    fs.linkSync(index, backup);
    fs.renameSync(pending, index);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
  if (!fs.readFileSync(backup).equals(original)) {
    throw new Error('index changed during compaction; kept backup ' + backup + ' and new index ' + index);
  }
}

try {
  compact();
} catch (error) {
  console.error('memory-index-compact: ' + error.message);
  process.exitCode = 1;
}
