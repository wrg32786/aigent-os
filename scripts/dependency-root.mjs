#!/usr/bin/env node
// dependency-root.mjs -- update one dependency root without risking the tree it
// would replace (issue #138).
//
// `npm ci` deletes node_modules before it installs. Run in place on a seat, a
// DLL held by a live process made it fail halfway: 69 packages became 6. So npm
// never runs in a live root.
//
// Holders sit beside the root, each a directory with its own package.json and
// node_modules, so any tree can be probed where it lies:
//   .deps-stage-<root>    the candidate being built
//   .deps-prev-<root>     the tree the last swap replaced
//   .deps-failed-<root>   a live tree that did not work
//
// THE ONE RULE: a leftover tree is deleted only when a tree in the live position
// was just proven good, by its probe and its lockfile. A verdict about the tree being deleted never decides
// it, because a probe can fail for reasons that have nothing to do with the
// tree. Otherwise a leftover is kept, reported, and moved to a dated name if a
// swap needs its slot, so it blocks nothing.
//
//   on disk at start   probe            exit
//   prev, no live      -                prev moves to live
//   prev, live bad     prev good        live to failed, prev to live
//   prev, live bad     prev bad         both kept, the update table decides
//   live good, matches lock  -          leftovers deleted
//
//   live tree          update           result
//   good, matches lock not attempted    unchanged
//   any other          npm fails        kept-previous / kept-unusable
//   any other          stage bad        kept-previous / kept-unusable
//   any other          rename refused   kept-previous / kept-unusable
//   any other          good in place    updated, leftovers deleted
//   good               bad in place     rolled back: kept-previous
//   bad                bad in place     new tree stays: kept-unusable
//   none               good in place    updated
//   none               bad in place     installed-unverified
//   none               npm fails        failed
//
// Measured on Windows with sharp's DLLs loaded by a live process: the rename
// succeeds, that process keeps running from the mapped files, and only deleting
// the old tree stops partway. A running server is not disturbed and picks up
// the new tree on its next start. What it still holds is reported, and a later
// run removes it.
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

// Null when every declared dependency works from root. Anything else, a crash
// or a timeout included, means it was not proven good, and that is all a caller
// may conclude. Files on disk prove nothing: an unbuilt native binding installs
// cleanly and throws when used.
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
  return reasonFrom(run.stderr || run.error?.message, `probe ended with ${run.signal ?? run.status}`);
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
  } catch { /* the caller reports what is left */ }
}

function holder(root, target, fsImpl) {
  fsImpl.mkdirSync(target, { recursive: true });
  fsImpl.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'));
  return path.join(target, 'node_modules');
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

  const leftovers = () => fsImpl.readdirSync(parent)
    .filter((entry) => entry.startsWith(`.deps-prev-${name}`) || entry.startsWith(`.deps-failed-${name}`))
    .map((entry) => path.join(parent, entry));
  const leftoverNote = () => {
    const left = leftovers();
    return left.length ? `old trees kept in ${left.join(', ')}; a later run removes them` : '';
  };
  const withNote = (reason) => [reason, leftoverNote()].filter(Boolean).join('; ');
  // The only delete of a leftover. Every caller just proved the live tree good.
  const clearLeftovers = () => {
    for (const target of leftovers()) removeTree(target, fsImpl);
    return leftoverNote();
  };
  // Park a tree in a holder, first moving any tree there to a dated name.
  const park = (from, slot) => {
    try {
      if (fsImpl.existsSync(path.join(slot, 'node_modules'))) {
        const freed = moveTree(slot, `${slot}.${Date.now()}`, moveOptions);
        if (freed) return freed;
      }
      const moved = moveTree(from, holder(root, slot, fsImpl), moveOptions);
      if (moved && !fsImpl.existsSync(path.join(slot, 'node_modules'))) removeTree(slot, fsImpl);
      return moved;
    } catch (error) {
      return error;
    }
  };
  const noTree = (error) => ({
    outcome: 'rollback-failed',
    preserved: prevTree,
    reason: `the good tree is in ${prevTree}: ${error.message}`,
  });

  removeTree(stage, fsImpl);

  if (!fsImpl.existsSync(live) && fsImpl.existsSync(prevTree)) {
    const error = moveTree(prevTree, live, moveOptions);
    if (error) return noTree(error);
  }
  let liveGood = fsImpl.existsSync(live) && probe(root) === null;
  if (!liveGood && fsImpl.existsSync(live) && fsImpl.existsSync(prevTree) && probe(prev) === null) {
    const aside = park(live, failed);
    if (aside) {
      return {
        outcome: 'kept-unusable',
        usable: false,
        reason: `the good tree could not be restored (${aside.code || aside.message}); it is in ${prevTree}`,
      };
    }
    const back = moveTree(prevTree, live, moveOptions);
    if (back) return noTree(back);
    liveGood = probe(root) === null;
  }

  const hadTree = fsImpl.existsSync(live);
  const lockProblem = lockedTreeProblem(root, { fsImpl });
  // Imports can pass on a tree missing a locked package, or resolve from an
  // ancestor, so a leftover needs the lockfile to agree too. An older version
  // of everything still works, which is what a pending lockfile bump looks like.
  if (liveGood && lockProblem === null) return { outcome: 'unchanged', reason: clearLeftovers() };
  if (String(lockProblem).endsWith('is missing')) liveGood = false;

  const kept = (reason) => ({
    outcome: liveGood ? 'kept-previous' : 'kept-unusable',
    usable: liveGood,
    reason: withNote(reason),
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
  if (!fsImpl.existsSync(stageTree)) return abandon('npm produced no tree');

  const stageProblem = probe(stage);
  const whyNot = () => [stageProblem, rebuilt.ok ? null : `rebuild ${rebuild}: ${rebuilt.reason}`]
    .filter(Boolean).join('; ');
  if (stageProblem !== null && hadTree) return abandon(`the update does not work: ${whyNot()}`);

  if (hadTree) {
    const parked = park(live, prev);
    if (parked) return abandon(`the tree could not be moved (${parked.code || parked.message})`);
  }
  const placed = moveTree(stageTree, live, moveOptions);
  if (placed) {
    if (hadTree) {
      const restore = moveTree(prevTree, live, moveOptions);
      if (restore) return noTree(restore);
    }
    return abandon(`the new tree could not be placed (${placed.code || placed.message})`);
  }
  removeTree(stage, fsImpl);

  const finalProblem = probe(root);
  if (finalProblem === null) return { outcome: 'updated', reason: clearLeftovers() };
  if (!hadTree) return { outcome: 'installed-unverified', reason: finalProblem };
  if (!liveGood) {
    return {
      outcome: 'kept-unusable',
      usable: false,
      reason: withNote(`the update does not work in place: ${finalProblem}`),
    };
  }

  const aside = park(live, failed);
  if (aside) {
    return {
      outcome: 'kept-unusable',
      usable: false,
      reason: `the bad new tree could not be moved (${aside.code || aside.message}); the good tree is in ${prevTree}`,
    };
  }
  const restore = moveTree(prevTree, live, moveOptions);
  if (restore) return noTree(restore);
  if (probe(root) === null) {
    clearLeftovers();
    return { outcome: 'kept-previous', usable: true, reason: `rolled back: ${finalProblem}` };
  }
  return {
    outcome: 'kept-unusable',
    usable: false,
    reason: withNote(`rolled back, but the old tree no longer works: ${finalProblem}`),
  };
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
