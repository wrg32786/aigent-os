// dependency-root.test.mjs -- a failed dependency update must leave the working
// tree it meant to replace (issue #138).
//
// WHY THIS EXISTS: measured live 2026-10-30 at a seat cutover. install.sh ran
// `npm ci` in place in daemons/semantic-search while a long-running shared
// server had sharp's DLL loaded. npm deleted first and failed second: EPERM on
// the DLL, 69 packages down to 6, and only a snapshot restored them.
//
// The fake npm here does what the real one does to a tree: it empties
// node_modules in its working directory before it can fail. Trees and import
// probes are real, so a pass means the files are there and they load.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lockedTreeProblem,
  probeImports,
  updateDependencyRoot,
} from '../../scripts/dependency-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const DEP = 'demo-dep';

function writeTree(root, version, { throws = false } = {}) {
  const dir = path.join(root, 'node_modules', DEP);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: DEP, version, main: 'index.js',
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), throws
    ? "throw new Error('native binding not built');\n"
    : `module.exports = ${JSON.stringify(version)};\n`);
}

function installedVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', DEP, 'package.json'), 'utf8')).version;
}

function makeRoot(lockVersion = '2.0.0') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deproot-'));
  const root = path.join(base, 'daemons', 'semantic-search');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'semantic-search', version: '1.0.0', dependencies: { [DEP]: '*' },
  }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'semantic-search',
    lockfileVersion: 3,
    packages: {
      '': { name: 'semantic-search' },
      [`node_modules/${DEP}`]: { version: lockVersion },
      'node_modules/optional-platform': { version: '1.0.0', optional: true },
    },
  }));
  return { base, root };
}

function fakeNpm(behaviour) {
  const calls = [];
  const npm = (args, cwd) => {
    calls.push({ args, cwd });
    fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true, force: true });
    return behaviour(args, cwd);
  };
  npm.calls = calls;
  return npm;
}

const installs = (version, options) => (args, cwd) => {
  writeTree(cwd, version, options);
  return { ok: true };
};

const fails = (reason) => () => ({ ok: false, reason });

function withRoot(lockVersion, body) {
  const fixture = makeRoot(lockVersion);
  try {
    return body(fixture);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
}

const listing = (root) => fs.readdirSync(root).sort();

test('dr-1. an unchanged tree that loads is left alone: npm never runs', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '2.0.0');
  const npm = fakeNpm(fails('must not be called'));
  const result = updateDependencyRoot({ root, npm });
  assert.equal(result.outcome, 'unchanged');
  assert.equal(npm.calls.length, 0);
}));

test('dr-2. a failed install leaves the previous tree intact, byte for byte', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const npm = fakeNpm(fails('EPERM on a loaded DLL'));
  const result = updateDependencyRoot({ root, npm });
  assert.equal(result.outcome, 'kept-previous');
  assert.equal(result.usable, true);
  assert.match(result.reason, /EPERM/);
  assert.equal(installedVersion(root), '1.0.0');
  assert.equal(probeImports(root), null, 'the kept tree still imports');
  assert.equal(npm.calls[0].cwd.includes('node_modules'), false);
  assert.notEqual(path.resolve(npm.calls[0].cwd), path.resolve(root), 'npm never runs in the live root');
  assert.deepEqual(listing(path.dirname(root)), ['semantic-search'], 'no stage is left behind');
}));

test('dr-3. directory presence is not success: a stage that does not load is never committed', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const result = updateDependencyRoot({ root, npm: fakeNpm(installs('2.0.0', { throws: true })) });
  assert.equal(result.outcome, 'kept-previous');
  assert.equal(installedVersion(root), '1.0.0');
}));

test('dr-4. the swap refused while a native module is loaded changes nothing', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const live = path.join(root, 'node_modules');
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (path.resolve(String(from)) === path.resolve(live)) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return fs.renameSync(from, to);
    },
  };
  const result = updateDependencyRoot({
    root, npm: fakeNpm(installs('2.0.0')), fsImpl, retryDelayMs: 0,
  });
  assert.equal(result.outcome, 'kept-previous');
  assert.match(result.reason, /in use/);
  assert.equal(installedVersion(root), '1.0.0');
  assert.deepEqual(listing(path.dirname(root)), ['semantic-search']);
}));

test('dr-5. a failure after the old tree moved aside puts it back', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (String(from).includes('.deps-stage-')) {
        throw Object.assign(new Error('EBUSY: resource busy, rename'), { code: 'EBUSY' });
      }
      return fs.renameSync(from, to);
    },
  };
  const result = updateDependencyRoot({
    root, npm: fakeNpm(installs('2.0.0')), fsImpl, retryDelayMs: 0,
  });
  assert.equal(result.outcome, 'kept-previous');
  assert.equal(installedVersion(root), '1.0.0');
  assert.equal(fs.existsSync(path.join(root, 'node_modules.prev')), false);
}));

test('dr-6. a tree that stops loading in its final place is rolled back', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const probe = (target) => (
    path.resolve(target) === path.resolve(root) && installedVersion(root) === '2.0.0'
      ? 'addon path baked into the stage'
      : probeImports(target));
  const result = updateDependencyRoot({ root, npm: fakeNpm(installs('2.0.0')), probe });
  assert.equal(result.outcome, 'kept-previous');
  assert.match(result.reason, /rolled back/);
  assert.equal(installedVersion(root), '1.0.0');
  assert.deepEqual(listing(root).filter((name) => name.startsWith('node_modules')), ['node_modules']);
}));

test('dr-7. a rollback that cannot complete says so and keeps the old tree on disk', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const prev = path.join(root, 'node_modules.prev');
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (String(from).includes('.deps-stage-') || path.resolve(String(from)) === path.resolve(prev)) {
        throw Object.assign(new Error('EBUSY: resource busy, rename'), { code: 'EBUSY' });
      }
      return fs.renameSync(from, to);
    },
  };
  const result = updateDependencyRoot({
    root, npm: fakeNpm(installs('2.0.0')), fsImpl, retryDelayMs: 0,
  });
  assert.equal(result.outcome, 'rollback-failed');
  assert.equal(result.preserved, prev);
  assert.equal(fs.existsSync(path.join(prev, DEP, 'package.json')), true);
}));

test('dr-8. a good update lands, loads and leaves nothing behind', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const result = updateDependencyRoot({ root, npm: fakeNpm(installs('2.0.0')) });
  assert.equal(result.outcome, 'updated');
  assert.equal(installedVersion(root), '2.0.0');
  assert.equal(probeImports(root), null);
  assert.deepEqual(listing(root), ['node_modules', 'package-lock.json', 'package.json']);
  assert.deepEqual(listing(path.dirname(root)), ['semantic-search']);
}));

test('dr-8b. old files a live process still holds are reported, not hidden, and the next run removes them', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const previous = path.join(root, 'node_modules.prev');
  const fsImpl = {
    ...fs,
    rmSync(target, options) {
      if (path.resolve(String(target)) === path.resolve(previous)) {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
      }
      return fs.rmSync(target, options);
    },
  };
  const result = updateDependencyRoot({ root, npm: fakeNpm(installs('2.0.0')), fsImpl });
  assert.equal(result.outcome, 'updated');
  assert.match(result.reason, /still in use/);
  assert.equal(installedVersion(root), '2.0.0', 'the update stands');

  assert.equal(updateDependencyRoot({ root, npm: fakeNpm(fails('must not be called')) }).outcome, 'unchanged');
  assert.equal(fs.existsSync(previous), false);
}));

test('dr-9. the Metis shape: right versions, unloadable tree, and an update that cannot do better keeps what is there', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '2.0.0', { throws: true });
  assert.equal(lockedTreeProblem(root), null, 'versions alone would have called this unchanged');
  const npm = fakeNpm(installs('2.0.0', { throws: true }));
  const result = updateDependencyRoot({ root, npm });
  assert.equal(npm.calls.length, 1, 'an unloadable tree is not unchanged');
  assert.equal(result.outcome, 'kept-unusable', 'kept is not the same as working');
  assert.equal(result.usable, false);
}));

test('dr-10. a fresh install has no tree to protect: it lands, and an unloadable one is reported, not hidden', () => {
  withRoot('2.0.0', ({ root }) => {
    assert.equal(updateDependencyRoot({ root, npm: fakeNpm(installs('2.0.0')) }).outcome, 'updated');
    assert.equal(installedVersion(root), '2.0.0');
  });
  withRoot('2.0.0', ({ root }) => {
    const result = updateDependencyRoot({ root, npm: fakeNpm(installs('2.0.0', { throws: true })) });
    assert.equal(result.outcome, 'installed-unverified');
    assert.equal(installedVersion(root), '2.0.0');
  });
  withRoot('2.0.0', ({ root }) => {
    assert.equal(updateDependencyRoot({ root, npm: fakeNpm(fails('offline')) }).outcome, 'failed');
  });
});

test('dr-11. a run killed between the two renames is repaired by the next run', () => withRoot('1.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  fs.renameSync(path.join(root, 'node_modules'), path.join(root, 'node_modules.prev'));
  const npm = fakeNpm(fails('must not be called'));
  assert.equal(updateDependencyRoot({ root, npm }).outcome, 'unchanged');
  assert.equal(npm.calls.length, 0);
  assert.equal(installedVersion(root), '1.0.0');
}));

test('dr-11b. a run killed between the swap and the final probe: the good previous tree is restored, never deleted', () => withRoot('1.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  fs.renameSync(path.join(root, 'node_modules'), path.join(root, 'node_modules.prev'));
  writeTree(root, '1.0.0', { throws: true });

  const npm = fakeNpm(fails('must not be called'));
  assert.equal(updateDependencyRoot({ root, npm }).outcome, 'unchanged');
  assert.equal(npm.calls.length, 0);
  assert.equal(probeImports(root), null, 'the good tree came back');
  assert.deepEqual(listing(root).filter((name) => name.startsWith('node_modules')), ['node_modules']);
}));

test('dr-11c. the same crash when neither tree loads leaves the newer one and a truthful outcome', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0', { throws: true });
  fs.renameSync(path.join(root, 'node_modules'), path.join(root, 'node_modules.prev'));
  writeTree(root, '2.0.0', { throws: true });

  const result = updateDependencyRoot({ root, npm: fakeNpm(fails('offline')) });
  assert.equal(result.outcome, 'kept-unusable');
  assert.equal(installedVersion(root), '2.0.0');
}));

test('dr-11d. a stage that cannot be prepared keeps the tree and states the reason', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const fsImpl = {
    ...fs,
    copyFileSync() {
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    },
  };
  const result = updateDependencyRoot({ root, npm: fakeNpm(installs('2.0.0')), fsImpl });
  assert.equal(result.outcome, 'kept-previous');
  assert.match(result.reason, /ENOSPC/);
  assert.equal(installedVersion(root), '1.0.0');
  assert.deepEqual(listing(path.dirname(root)), ['semantic-search']);
}));

test('dr-12. a native rebuild runs in the stage, never in the live root, and ignore-scripts stays on', () => withRoot('2.0.0', ({ root }) => {
  writeTree(root, '1.0.0');
  const calls = [];
  const npm = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'ci') writeTree(cwd, '2.0.0');
    return { ok: true };
  };
  assert.equal(updateDependencyRoot({ root, npm, rebuild: 'node-pty' }).outcome, 'updated');
  assert.deepEqual(calls.map((call) => call.args[0]), ['ci', 'rebuild']);
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.ok(calls.every((call) => path.resolve(call.cwd) !== path.resolve(root)));
}));

test('dr-13. the installed-root failure path: install.sh with an npm that deletes first keeps the working tree', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deproot-e2e-'));
  try {
    const target = path.join(base, 'seat');
    const root = path.join(target, 'daemons', 'semantic-search');
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(REPO, 'daemons/semantic-search/package.json'), path.join(root, 'package.json'));
    fs.copyFileSync(path.join(REPO, 'daemons/semantic-search/package-lock.json'), path.join(root, 'package-lock.json'));
    writeTree(root, '1.0.0');

    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "--version" ]; then echo 11.0.0; exit 0; fi',
      'rm -rf node_modules',
      'echo "EPERM: operation not permitted, rmdir" >&2',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm.cmd'), [
      '@echo off',
      'if exist node_modules rmdir /s /q node_modules',
      'echo EPERM: operation not permitted, rmdir 1>&2',
      'exit /b 1',
      '',
    ].join('\r\n'));

    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    spawnSync('bash', ['install.sh', '--target', target, '--no-launcher'], {
      cwd: REPO,
      env: { ...process.env, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}` },
      encoding: 'utf8',
      timeout: 120_000,
    });

    assert.equal(fs.existsSync(path.join(root, 'node_modules', DEP, 'index.js')), true, 'the working tree was destroyed');
    assert.equal(installedVersion(root), '1.0.0');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
