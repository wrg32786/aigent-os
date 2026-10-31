#!/usr/bin/env node
// dependency-root.mjs -- update one dependency root without risking the tree it
// would replace (issue #138).
//
// `npm ci` deletes node_modules before it installs. Run in place on a seat, a
// DLL held by a live process made it fail halfway: 69 packages became 6. So npm
// never runs in a live root.
//
// Three holders sit beside the root, each a directory with its own package.json
// and node_modules, so any tree can be probed where it lies:
//   .deps-stage-<root>    the candidate being built
//   .deps-prev-<root>     the tree the last swap replaced
//   .deps-failed-<root>   a live tree proven not to load
//
// THE ONE RULE: a tree is deleted only if it was just probed bad, or a tree in
// the live position was just probed good. Every row below follows from it.
//
//   on disk at start            probe                exit
//   no prev                     -                    the update table
//   prev, no live               -                    prev moves to live
//   prev, live good             live good            prev deleted
//   prev, live bad              prev good            live to failed, prev to live
//   prev, live bad              prev bad             prev deleted, live stays
//   rename refused above        -                    nothing deleted; reason names
//                                                    where the good tree is
//
//   live tree                   update               result
//   matches lock and works      not attempted        unchanged
//   anything else               npm fails            kept-previous / kept-unusable
//   anything else               stage does not work  kept-previous / kept-unusable
//   anything else               rename refused       kept-previous / kept-unusable
//   anything else               fails in final place rolled back, same outcomes
//   anything else               works in both places updated
//   none                        works                updated
//   none                        does not work        installed-unverified
//   none                        npm fails            failed
//
// Measured on Windows with sharp's DLLs loaded by a live process: the rename
// succeeds, that process keeps running from the mapped files, and only deleting
// the old tree stops partway. A running server is not disturbed and picks up
// the new tree on its next start. What it still holds stays in the prev holder;
// a later run moves it aside if it must, and removes it.
//
//   node scripts/dependency-root.mjs <root> [package-to-rebuild]
//
// Prints `<outcome>|<reason>`. Exit 0: node_modules is in place, and
// `kept-unusable` or `installed-unverified` say it does not work. Exit 1:
// nothing was installed. Exit 2: no node_modules is in place; the reason says
// where the good tree is, and rerunning restores it.

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

// The line that says what went wrong: an Error line if there is one, else the
// last line with anything on it. The first line of a stack is a source line.
function reasonFrom(text, fallback) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const named = lines.find((line) => /^(npm error |\w*Error\b)/.test(line));
  return (named || lines.at(-1) || fallback).slice(0, 200);
}

// Importing node-pty on Windows does not load conpty.node, so a tree with its
// binding deleted imports cleanly. Only a spawn touches the binding.
const PROBE_SCRIPT = `
for (const name of process.argv.slice(1)) {
  const loaded = await import(name);
  if (name !== 'node-pty') continue;
  const child = (loaded.default ?? loaded).spawn(process.execPath, ['-e', ''], {});
  await new Promise((resolve) => { child.onExit(resolve); });
}
process.exit(0);
`;

// Null when every declared dependency works from root. Files on disk prove
// nothing: an unbuilt native binding installs cleanly and throws when used.
export function probeImports(root, { fsImpl = fs, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let names;
  try {
    names = Object.keys(readJson(path.join(root, 'package.json'), fsImpl).dependencies ?? {});
  } catch (error) {
    return `no readable package.json: ${error.message}`;
  }
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SCRIPT, '--', ...names], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (run.status === 0) return null;
  return reasonFrom(run.stderr || run.error?.message, 'probe failed');
}

function runNpm(args, cwd) {
  const run = spawnSync('npm', [...args, '--loglevel=error'], {
    cwd,
    encoding: 'utf8',
    timeout: NPM_TIMEOUT_MS,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (run.status === 0) return { ok: true };
  return { ok: false, reason: reasonFrom(run.stderr || run.error?.message, `npm exited ${run.status}`) };
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
  } catch { /* the caller checks what is left */ }
  return !fsImpl.existsSync(target);
}

function holder(root, target, fsImpl) {
  fsImpl.mkdirSync(target, { recursive: true });
  fsImpl.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'));
  return path.join(target, 'node_modules');
}

// Applies the first table. Returns a result only when the run must stop.
function settleLeftovers({ live, prev, prevTree, failed }, { root, probe, fsImpl, moveOptions }) {
  if (!fsImpl.existsSync(prevTree)) return null;
  const noTree = (error) => ({
    outcome: 'rollback-failed',
    preserved: prevTree,
    reason: `the good tree is in ${prevTree}: ${error.message}`,
  });
  if (!fsImpl.existsSync(live)) {
    const error = moveTree(prevTree, live, moveOptions);
    return error ? noTree(error) : null;
  }
  if (probe(root) === null || probe(prev) !== null) return null;
  const aside = moveTree(live, holder(root, failed, fsImpl), moveOptions);
  if (aside) {
    return {
      outcome: 'kept-unusable',
      usable: false,
      reason: `the good tree could not be restored (${aside.code || aside.message}); it is in ${prevTree}`,
    };
  }
  const back = moveTree(prevTree, live, moveOptions);
  return back ? noTree(back) : null;
}

export function updateDependencyRoot({
  root,
  rebuild = '',
  npm = runNpm,
  probe = probeImports,
  fsImpl = fs,
  retryDelayMs = 250,
}) {
  const parent = path.dirname(root);
  const name = path.basename(root);
  const live = path.join(root, 'node_modules');
  const stage = path.join(parent, `.deps-stage-${name}`);
  const prev = path.join(parent, `.deps-prev-${name}`);
  const failed = path.join(parent, `.deps-failed-${name}`);
  const stageTree = path.join(stage, 'node_modules');
  const prevTree = path.join(prev, 'node_modules');
  const moveOptions = { fsImpl, retryDelayMs };

  const settled = settleLeftovers({ live, prev, prevTree, failed }, {
    root, probe, fsImpl, moveOptions,
  });
  if (settled) return settled;
  removeTree(stage, fsImpl);
  removeTree(failed, fsImpl);
  // Past this point the prev holder is proven bad, or a good tree is live. An
  // undeletable leftover must not block the next swap, so it moves aside under
  // a name a later run also clears.
  for (const entry of fsImpl.readdirSync(parent)) {
    if (entry.startsWith(`.deps-prev-${name}.`)) removeTree(path.join(parent, entry), fsImpl);
  }
  let leftover = '';
  if (!removeTree(prev, fsImpl)) {
    leftover = `old files still in use remain in ${prev}; a later run removes them`;
    moveTree(prev, `${prev}.${Date.now()}`, moveOptions);
  }

  const hadTree = fsImpl.existsSync(live);
  const previousProblem = hadTree ? (lockedTreeProblem(root, { fsImpl }) ?? probe(root)) : 'no tree';
  if (previousProblem === null) return { outcome: 'unchanged', reason: leftover };
  const previousUsable = hadTree && probe(root) === null;

  const kept = (reason) => ({
    outcome: previousUsable ? 'kept-previous' : 'kept-unusable',
    usable: previousUsable,
    reason,
  });
  const abandon = (reason) => {
    removeTree(stage, fsImpl);
    return hadTree ? kept(reason) : { outcome: 'failed', reason };
  };

  const hasLock = fsImpl.existsSync(path.join(root, 'package-lock.json'));
  try {
    holder(root, stage, fsImpl);
    if (hasLock) fsImpl.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
  } catch (error) {
    return abandon(`the stage could not be prepared: ${error.message}`);
  }
  const install = npm([hasLock ? 'ci' : 'install', '--ignore-scripts'], stage);
  if (!install.ok) return abandon(install.reason);
  // Only the named package's own build runs. Whether it mattered is the
  // probe's call: a tree that works without it is a good tree.
  const rebuilt = rebuild ? npm(['rebuild', rebuild], stage) : { ok: true };
  if (!fsImpl.existsSync(stageTree)) {
    removeTree(stage, fsImpl);
    return hadTree ? kept('npm produced no tree') : { outcome: 'installed-unverified', reason: 'npm produced no tree' };
  }

  const stageProblem = probe(stage);
  const whyNot = () => [stageProblem, rebuilt.ok ? null : `rebuild ${rebuild}: ${rebuilt.reason}`]
    .filter(Boolean).join('; ');
  if (stageProblem !== null && hadTree) return abandon(`the update does not work: ${whyNot()}`);

  if (hadTree) {
    let prevSlot;
    try {
      prevSlot = holder(root, prev, fsImpl);
    } catch (error) {
      return abandon(`the old tree has nowhere to go: ${error.message}`);
    }
    const error = moveTree(live, prevSlot, moveOptions);
    if (error) {
      removeTree(prev, fsImpl);
      return abandon(`the tree could not be moved (${error.code || error.message})`);
    }
  }
  const placed = moveTree(stageTree, live, moveOptions);
  if (placed) {
    if (hadTree) {
      const restore = moveTree(prevTree, live, moveOptions);
      if (restore) {
        return {
          outcome: 'rollback-failed',
          preserved: prevTree,
          reason: `the good tree is in ${prevTree}: ${restore.message}`,
        };
      }
    }
    return abandon(`the new tree could not be placed (${placed.code || placed.message})`);
  }
  removeTree(stage, fsImpl);
  if (!hadTree) {
    return stageProblem === null
      ? { outcome: 'updated', reason: leftover }
      : { outcome: 'installed-unverified', reason: whyNot() };
  }

  const finalProblem = probe(root);
  if (finalProblem !== null) {
    const aside = moveTree(live, holder(root, failed, fsImpl), moveOptions);
    if (aside) return kept(`rollback refused (${aside.code || aside.message}); the good tree is in ${prevTree}`);
    const restore = moveTree(prevTree, live, moveOptions);
    if (restore) {
      return {
        outcome: 'rollback-failed',
        preserved: prevTree,
        reason: `the good tree is in ${prevTree}: ${restore.message}`,
      };
    }
    removeTree(failed, fsImpl);
    removeTree(prev, fsImpl);
    return kept(`rolled back: ${finalProblem}`);
  }
  if (!removeTree(prev, fsImpl)) {
    leftover = `old files still in use remain in ${prev}; a later run removes them`;
  }
  return { outcome: 'updated', reason: leftover };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , root, rebuild = ''] = process.argv;
  if (!root) {
    console.error('usage: dependency-root.mjs <root> [package-to-rebuild]');
    process.exit(1);
  }
  let result;
  try {
    result = updateDependencyRoot({ root: path.resolve(root), rebuild });
  } catch (error) {
    result = { outcome: 'failed', reason: error.message };
  }
  console.log(`${result.outcome}|${result.reason ?? ''}`);
  if (result.outcome === 'failed') process.exitCode = 1;
  if (result.outcome === 'rollback-failed') process.exitCode = 2;
}
