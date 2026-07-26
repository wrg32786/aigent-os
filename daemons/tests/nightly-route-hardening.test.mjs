// Mutation proofs for the repository-local nightly route.
// Route fixtures are copied to operating system temp directories only.

import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const ROUTE_CLI = path.join(REPO_ROOT, 'daemons', 'nightly-route-check.mjs');
const REQUIRED_SKILLS = [
  'nightly',
  'nightly-close-parity',
  'meta-improve',
  'meta-improve-vault',
  'dream',
  'reconcile',
  'context-hygiene',
  'cognitive-update',
  'nightly-ledger-capture',
];
const tempRoots = [];

function copyFile(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function fixture(label) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'aigent-route-proof-'));
  const root = path.join(base, label);
  for (const skill of REQUIRED_SKILLS) {
    copyFile(
      path.join(REPO_ROOT, 'skills', skill, 'SKILL.md'),
      path.join(root, 'skills', skill, 'SKILL.md'),
    );
  }
  copyFile(
    path.join(REPO_ROOT, 'daemons', 'skill-router.sh'),
    path.join(root, 'daemons', 'skill-router.sh'),
  );
  mkdirSync(path.join(root, 'vault', 'memory', 'runtime'), { recursive: true });
  tempRoots.push(base);
  return { base, root };
}

function isolatedEnv(root) {
  const keep = [
    'ComSpec',
    'Path',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'WINDIR',
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    AIGENT_ROOT: root,
    CLAUDE_PROJECT_DIR: root,
    AIGENT_OS_ROOT: root,
    AIGENT_PROJECT_DIR: root,
    AIGENT_STATE_HOME_DIR: root,
    AIGENT_NIGHTLY_TIME_ZONE: 'America/Los_Angeles',
    AIGENT_NIGHTLY_CUTOFF_HOUR: '4',
    TZ: 'UTC',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function runRoute(root) {
  return spawnSync(process.execPath, [
    ROUTE_CLI,
    '--root', root,
    '--no-alert',
  ], {
    cwd: root,
    env: isolatedEnv(root),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
}

function scrubProof(value) {
  const nativeTemp = os.tmpdir();
  const candidates = [
    nativeTemp.replaceAll('\\', '\\\\'),
    nativeTemp,
    nativeTemp.replaceAll('\\', '/'),
  ];
  return candidates.reduce(
    (output, candidate) => output.split(candidate).join('<temp>'),
    String(value || '').trim().replace(/\s+/g, ' '),
  );
}

function proof(label, result) {
  const stdout = scrubProof(result.stdout);
  const stderr = scrubProof(result.stderr);
  console.log(`${label} status=${result.status} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
}

test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    } catch {
      // Best effort for transient locks.
    }
  }
});

test('mutation proof: the unique alias must pin the canonical local protocol', () => {
  const { root } = fixture('sentinel');
  const nightly = path.join(root, 'skills', 'nightly', 'SKILL.md');
  const original = readFileSync(nightly, 'utf8');
  const mutated = original.replace(
    /^NIGHTLY_LOCAL_PROTOCOL:.*(?:\r?\n)?/m,
    '',
  );
  assert.notEqual(mutated, original, 'fixture mutation must remove the protocol sentinel');
  writeFileSync(nightly, mutated, 'utf8');

  const broken = runRoute(root);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /NIGHTLY_ROUTE FAIL/);
  assert.match(broken.stdout, /sentinel/i);
  proof('BREAK local-route-sentinel', broken);

  writeFileSync(nightly, original, 'utf8');
  const restored = runRoute(root);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /NIGHTLY_ROUTE PASS/);
  assert.match(restored.stdout, /skills[\\/]nightly[\\/]SKILL\.md/i);
  proof('RESTORE local-route-sentinel', restored);
});

test('mutation proof: the prompt router fails closed when the alias mapping is removed', () => {
  const { root } = fixture('router-mapping');
  const router = path.join(root, 'daemons', 'skill-router.sh');
  const original = readFileSync(router, 'utf8');
  const mutated = original.replace(
    '"nightly": "nightly-close-parity"',
    '"nightly": "nightly"',
  );
  assert.notEqual(mutated, original, 'fixture mutation must change the nightly alias mapping');
  writeFileSync(router, mutated, 'utf8');

  const broken = runRoute(root);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /NIGHTLY_ROUTE FAIL/);
  assert.match(broken.stdout, /router|alias/i);
  proof('BREAK router-alias', broken);

  writeFileSync(router, original, 'utf8');
  const restored = runRoute(root);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /NIGHTLY_ROUTE PASS/);
  proof('RESTORE router-alias', restored);
});

test('mutation proof: a user-global same-name skill never substitutes for the local alias', () => {
  const { root } = fixture('global-collision');
  const localAlias = path.join(root, 'skills', 'nightly-close-parity', 'SKILL.md');
  const original = readFileSync(localAlias, 'utf8');
  writeFileSync(
    path.join(root, 'global-nightly-placeholder'),
    'fixture marker\n',
    'utf8',
  );
  const globalSkill = path.join(root, '.claude', 'skills', 'nightly', 'SKILL.md');
  mkdirSync(path.dirname(globalSkill), { recursive: true });
  writeFileSync(globalSkill, '---\nname: nightly\nstatus: PRODUCTION\n---\n', 'utf8');
  rmSync(localAlias);

  const broken = runRoute(root);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /NIGHTLY_ROUTE FAIL/);
  assert.match(broken.stdout, /alias|missing/i);
  proof('BREAK local-alias-missing', broken);

  writeFileSync(localAlias, original, 'utf8');
  const restored = runRoute(root);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /NIGHTLY_ROUTE PASS/);
  assert.doesNotMatch(restored.stdout, /proposed.kill|delete.*global/i);
  proof('RESTORE local-alias-present', restored);
});
