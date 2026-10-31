#!/usr/bin/env node
// dependency-root.mjs -- update one dependency root without risking the tree it
// would replace (issue #138).
//
// `npm ci` deletes node_modules before it installs. Run in place on a seat, a
// DLL held by a live process made it fail halfway: 69 packages became 6. So npm
// never runs in the live root. A tree that matches its lockfile and imports is
// left alone. Anything else is built in a sibling stage, imported there, and
// swapped in by rename. A failure at any step leaves the previous tree.
//
// Measured on Windows with sharp's DLLs loaded by a live process: the rename
// succeeds, that process keeps running from the mapped files, and only deleting
// the old tree stops partway. So a swap does not disturb a running server, it
// picks the new tree up on its next start, and the part it still holds stays in
// node_modules.prev until then; the next run removes it. A refused rename, as
// antivirus can cause, keeps the old tree in place.
//
//   node scripts/dependency-root.mjs <root> [package-to-rebuild]
//
// Prints `<outcome>|<reason>`. Exit 0: a tree is in place, usable or reported
// as not. Exit 1: nothing was installed. Exit 2: rollback failed; the old tree
// is preserved at the path in the reason.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROBE_TIMEOUT_MS = 90_000;
const NPM_TIMEOUT_MS = 15 * 60_000;
const RENAME_ATTEMPTS = 3;

const readJson = (target, fsImpl) => JSON.parse(fsImpl.readFileSync(target, 'utf8'));

// Null when every locked package is installed at its locked version. Optional
// packages may be absent: they are other platforms' binaries.
export function lockedTreeProblem(root, { fsImpl = fs } = {}) {
  let packages;
  try {
    ({ packages } = readJson(path.join(root, 'package-lock.json'), fsImpl));
  } catch {
    return 'no readable lockfile';
  }
  if (!packages || typeof packages !== 'object') return 'lockfile has no packages';
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    let installed;
    try {
      installed = readJson(path.join(root, key, 'package.json'), fsImpl).version;
    } catch {
      if (entry.optional || entry.peer) continue;
      return `${key} is missing`;
    }
    if (installed !== entry.version) return `${key} is ${installed}, locked ${entry.version}`;
  }
  return null;
}

// Null when every declared dependency imports from `root`. Files on disk prove
// nothing: an unbuilt native binding installs cleanly and throws on import.
export function probeImports(root, { fsImpl = fs, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let names;
  try {
    names = Object.keys(readJson(path.join(root, 'package.json'), fsImpl).dependencies ?? {});
  } catch (error) {
    return `no readable package.json: ${error.message}`;
  }
  const script = 'for (const name of process.argv.slice(1)) await import(name);';
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', ...names], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (run.status === 0) return null;
  const line = String(run.stderr || run.error?.message || 'import failed')
    .split(/\r?\n/)
    .find((text) => /error/i.test(text));
  return (line || 'import failed').trim().slice(0, 200);
}

function runNpm(args, cwd) {
  const run = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    timeout: NPM_TIMEOUT_MS,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (run.status === 0) return { ok: true };
  const line = String(run.stderr || run.error?.message || `npm exited ${run.status}`)
    .split(/\r?\n/)
    .find((text) => text.trim());
  return { ok: false, reason: (line || 'npm failed').trim().slice(0, 200) };
}

function sleep(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function moveTree(from, to, { fsImpl, retryDelayMs }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsImpl.renameSync(from, to);
      return null;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS) return error;
      sleep(retryDelayMs);
    }
  }
}

function removeTree(target, fsImpl) {
  try {
    fsImpl.rmSync(target, { recursive: true, force: true });
  } catch { /* a leftover is cleaned by the next run; the tree in place is what matters */ }
}

export function updateDependencyRoot({
  root,
  rebuild = '',
  npm = runNpm,
  probe = probeImports,
  fsImpl = fs,
  retryDelayMs = 250,
}) {
  const live = path.join(root, 'node_modules');
  const previous = path.join(root, 'node_modules.prev');
  const failed = path.join(root, 'node_modules.failed');
  // A sibling, not a child: inside the root, a package missing from the stage
  // would resolve up into the live tree and the probe would pass.
  const stage = path.join(path.dirname(root), `.deps-stage-${path.basename(root)}`);
  const stageTree = path.join(stage, 'node_modules');
  const moveOptions = { fsImpl, retryDelayMs };

  if (!fsImpl.existsSync(live) && fsImpl.existsSync(previous)) {
    const error = moveTree(previous, live, moveOptions);
    if (error) return { outcome: 'rollback-failed', preserved: previous, reason: error.message };
  }
  removeTree(stage, fsImpl);
  removeTree(previous, fsImpl);
  removeTree(failed, fsImpl);

  const hadTree = fsImpl.existsSync(live);
  const previousProblem = hadTree ? (lockedTreeProblem(root, { fsImpl }) ?? probe(root)) : 'no tree';
  if (previousProblem === null) return { outcome: 'unchanged' };
  const previousUsable = hadTree && probe(root) === null;

  const abandon = (reason) => {
    removeTree(stage, fsImpl);
    return hadTree
      ? { outcome: 'kept-previous', usable: previousUsable, reason }
      : { outcome: 'failed', reason };
  };

  fsImpl.mkdirSync(stage, { recursive: true });
  const hasLock = fsImpl.existsSync(path.join(root, 'package-lock.json'));
  for (const name of hasLock ? ['package.json', 'package-lock.json'] : ['package.json']) {
    fsImpl.copyFileSync(path.join(root, name), path.join(stage, name));
  }
  const install = npm([hasLock ? 'ci' : 'install', '--silent', '--ignore-scripts'], stage);
  if (!install.ok) return abandon(install.reason);
  if (rebuild) {
    const rebuilt = npm(['rebuild', '--silent', rebuild], stage);
    if (!rebuilt.ok) return abandon(rebuilt.reason);
  }
  if (!fsImpl.existsSync(stageTree)) {
    removeTree(stage, fsImpl);
    return hadTree
      ? { outcome: 'kept-previous', usable: previousUsable, reason: 'npm produced no tree' }
      : { outcome: 'installed-unverified', reason: 'npm produced no tree' };
  }

  const stageProblem = probe(stage);
  if (stageProblem !== null && hadTree) return abandon(`the update does not load: ${stageProblem}`);

  if (hadTree) {
    const error = moveTree(live, previous, moveOptions);
    if (error) return abandon(`the tree is in use (${error.code || error.message})`);
  }
  const placed = moveTree(stageTree, live, moveOptions);
  if (placed) {
    if (hadTree) {
      const restore = moveTree(previous, live, moveOptions);
      if (restore) return { outcome: 'rollback-failed', preserved: previous, reason: restore.message };
    }
    return abandon(`the new tree could not be placed (${placed.code || placed.message})`);
  }
  removeTree(stage, fsImpl);
  if (!hadTree) {
    return stageProblem === null
      ? { outcome: 'updated' }
      : { outcome: 'installed-unverified', reason: stageProblem };
  }

  const finalProblem = probe(root);
  if (finalProblem !== null) {
    const aside = moveTree(live, failed, moveOptions);
    const restore = aside ?? moveTree(previous, live, moveOptions);
    if (restore) return { outcome: 'rollback-failed', preserved: previous, reason: restore.message };
    removeTree(failed, fsImpl);
    return { outcome: 'kept-previous', usable: previousUsable, reason: `rolled back: ${finalProblem}` };
  }
  removeTree(previous, fsImpl);
  return fsImpl.existsSync(previous)
    ? { outcome: 'updated', reason: `old files still in use remain in ${previous}; the next run removes them` }
    : { outcome: 'updated' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , root, rebuild = ''] = process.argv;
  if (!root) {
    console.error('usage: dependency-root.mjs <root> [package-to-rebuild]');
    process.exit(1);
  }
  const result = updateDependencyRoot({ root: path.resolve(root), rebuild });
  console.log(`${result.outcome}|${result.preserved ?? result.reason ?? ''}`);
  if (result.outcome === 'failed') process.exitCode = 1;
  if (result.outcome === 'rollback-failed') process.exitCode = 2;
}
