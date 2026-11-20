#!/usr/bin/env node
// Check disk -> index and index -> disk, following one level of linked sub-indexes.
// node daemons/memory-orphan-check.mjs [--root ROOT | --dir MEMORIES] [--index MEMORY.md] [--staged FILE]
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveNightlyPaths } from './nightly-paths.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, dir: { type: 'string' }, index: { type: 'string' }, staged: { type: 'string' },
} });
if (positionals.length > 1 || (positionals.length && values.dir)) throw new Error('expected one memory directory');
const dir = path.resolve(values.dir || positionals[0] || resolveNightlyPaths(values.root).memoryRoot);
const index = path.resolve(values.index || path.join(dir, 'MEMORY.md'));

function memories() {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry =>
    entry.isFile() && entry.name.endsWith('.md') && entry.name !== path.basename(index)
    && !entry.name.startsWith('MEMORY.backup')).map(entry => entry.name).sort();
}

function pointers(text) {
  const result = new Set();
  for (const [, target] of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) result.add(target);
  for (const [slug] of text.matchAll(/\b(?:feedback|reference|project|user|concept|protocol)_[a-z0-9_-]+/g)) {
    result.add(slug.replace(/[-_]+$/, '') + '.md');
  }
  for (const [, target] of text.matchAll(/\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g)) {
    const slug = target.trim();
    if (slug) result.add(slug.endsWith('.md') ? slug : slug + '.md');
  }
  return result;
}

function isFile(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile();
}

function dangling(targets, source) {
  return [...targets].filter(target =>
    !isFile(path.resolve(path.dirname(source), target)) && !isFile(path.resolve(dir, target)));
}

function orphans(files, text) {
  return files.filter(file => {
    const slug = file.slice(0, -3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp('(?<![\\w-])' + slug + '(?![\\w-])').test(text);
  });
}

function run() {
  console.log('memories dir: ' + dir + '\nindex: ' + index);
  const main = fs.readFileSync(values.staged || index, 'utf8');
  const files = memories();
  if (!files.length) throw new Error('zero memories enumerated');
  const sources = new Map([[index, main]]);
  for (const target of pointers(main)) {
    if (!/^index-[\w-]+\.md$/.test(path.basename(target))) continue;
    const file = [path.resolve(path.dirname(index), target), path.resolve(dir, target)]
      .find(candidate => path.dirname(candidate) === dir && fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (file && !sources.has(file)) sources.set(file, fs.readFileSync(file, 'utf8'));
  }
  const text = [...sources.values()].join('\n');
  const probe = 'orphan-check-' + randomUUID() + '.md';
  fs.writeFileSync(path.join(dir, probe), '', { flag: 'wx' });
  try {
    if (!orphans(memories(), text).includes(probe)) throw new Error('blind to planted orphan');
  } finally {
    fs.unlinkSync(path.join(dir, probe));
  }
  const missing = 'dangling-check-' + randomUUID() + '.md';
  const probeTargets = pointers('- [control](' + missing + ')');
  if (!dangling(probeTargets, index).includes(missing)) {
    throw new Error('blind to planted dangling pointer');
  }
  const orphaned = orphans(files, text);
  const unresolved = new Set();
  const distinct = new Set();
  for (const [source, content] of sources) {
    const targets = pointers(content);
    for (const target of targets) distinct.add(path.basename(target));
    for (const target of dangling(targets, source)) unresolved.add(target);
  }
  const reached = files.length - orphaned.length;
  console.log('sub-indexes: ' + (sources.size - 1));
  console.log('on disk ' + files.length + ' reachable ' + reached + ' orphaned ' + orphaned.length);
  console.log('pointers ' + distinct.size + ' dangling ' + unresolved.size);
  console.log('red proofs: planted orphan DETECTED, planted dangling pointer DETECTED');
  for (const name of orphaned) console.log('ORPHAN ' + JSON.stringify(name));
  for (const target of unresolved) console.log('DANGLING ' + JSON.stringify(target));
  if (files.length >= 5 && !reached) throw new Error('layout mismatch: no memories reachable');
  if (distinct.size < reached) throw new Error('extractor blind to index format');
  if (orphaned.length || unresolved.size) return 1;
  console.log('clean');
  return 0;
}

try {
  process.exitCode = run();
} catch (error) {
  console.error('memory-orphan-check: ' + error.message);
  process.exitCode = 2;
}
