#!/usr/bin/env node
// Inventory the dated inputs used by Dream, including the hook writer's tree.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validDateKey } from './nightly-freshness.mjs';
import { resolveNightlyPaths } from './nightly-paths.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const { repositoryRoot, vaultRoot } = resolveNightlyPaths(values.root);
const trees = new Set([path.join(repositoryRoot, 'vault/daily'), path.join(vaultRoot, 'daily')]);
for (const tree of trees) {
  let files;
  try {
    files = readdirSync(tree, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    files = [];
  }
  const dated = files.filter(file => file.isFile() && file.name.endsWith('.md')
    && validDateKey(file.name.slice(0, -3))).map(file => file.name).sort();
  console.log(JSON.stringify(tree.split(path.sep).join('/')) + ' newest=' + (dated.at(-1) || 'none'));
}
