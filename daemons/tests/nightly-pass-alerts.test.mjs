// Mutation proofs for pass admission, time-zone consistency, and local alerts.
// All generated runners and ledgers stay inside operating system temp fixtures.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS = path.resolve(TEST_DIR, '..');
const PASS_CLI = path.join(DAEMONS, 'nightly-pass.mjs');
const FRESHNESS_CLI = path.join(DAEMONS, 'nightly-freshness.mjs');
const ALERT_MODULE = path.join(DAEMONS, 'nightly-alerts.mjs');

const PASS_DATE = '2026-03-10';
const BOUNDARY_NOW = '2026-03-11T06:30:00.000Z';
const TIME_ZONE = 'America/Los_Angeles';
const CUTOFF_HOUR = '4';
const tempRoots = [];

function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function fixture(label, { canonicalInputs = true } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'aigent-alert-proof-'));
  const root = path.join(base, label);
  mkdirSync(path.join(root, 'vault', 'memory', 'runtime'), { recursive: true });
  if (canonicalInputs) seedCanonicalInputs(root);
  tempRoots.push(base);
  return { base, root };
}

function seedCanonicalInputs(root) {
  write(root, 'vault/memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl', '');
  write(root, 'vault/memory/MEMORY_CANDIDATES.md', '| Candidate | Status |\n|---|---|\n');
  write(root, 'vault/memory/runtime/LESSONS.jsonl', '');
  write(root, 'vault/memory/runtime/BELIEF_STATE.jsonl', '');
  write(root, 'vault/memory/runtime/PROCEDURES.jsonl', '');
  write(root, 'vault/memory/runtime/GOAL_STACK.json', '{"active_goals":[]}\n');
  write(root, 'vault/memory/runtime/SELF_MODEL.json', JSON.stringify({
    capabilities: [],
    known_capabilities: [],
    limitations: [],
    known_limitations: [],
  }) + '\n');
  write(root, 'vault/memory/DREAM_LOG.md', '# Dream Log\n');
}

function isolatedEnv(root, extra = {}) {
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
    AIGENT_VAULT: root,
    CLAUDE_PROJECT_DIR: root,
    AIGENT_OS_ROOT: root,
    AIGENT_PROJECT_DIR: root,
    AIGENT_STATE_HOME_DIR: root,
    AIGENT_NIGHTLY_TIME_ZONE: TIME_ZONE,
    AIGENT_NIGHTLY_CUTOFF_HOUR: CUTOFF_HOUR,
    TZ: 'UTC',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function runNode(file, args, { root, input, extraEnv } = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    env: isolatedEnv(root, extraEnv),
    input,
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

function writeAlertRunner(root) {
  const moduleUrl = pathToFileURL(ALERT_MODULE).href;
  return write(root, 'runner/emit-alert.mjs', [
    `import { emitNightlyAlert } from ${JSON.stringify(moduleUrl)};`,
    'try {',
    '  const root = process.argv[2];',
    '  const first = await emitNightlyAlert({',
    '    root,',
    "    code: 'NIGHTLY:LOCAL_PROOF',",
    "    summary: 'local alert proof',",
    "    detail: 'no optional coordination service configured',",
    "    evidence: 'memory/runtime/NIGHTLY_LOG.md',",
    "    scope: 'fixture',",
    "    now: new Date('2026-03-10T20:00:00.000Z'),",
    '  });',
    '  const second = await emitNightlyAlert({',
    '    root,',
    "    code: 'NIGHTLY:LOCAL_PROOF',",
    "    summary: 'local alert proof',",
    "    detail: 'no optional coordination service configured',",
    "    evidence: 'memory/runtime/NIGHTLY_LOG.md',",
    "    scope: 'fixture',",
    "    now: new Date('2026-03-10T20:00:01.000Z'),",
    '  });',
    '  process.stdout.write(JSON.stringify({ first, second }) + "\\n");',
    '} catch (error) {',
    '  process.stderr.write(`ALERT_RUNNER FAIL ${error?.message || error}\\n`);',
    '  process.exitCode = 1;',
    '}',
    '',
  ].join('\n'));
}

test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    } catch {
      // Best effort for short-lived file locks.
    }
  }
});

test('mutation proof: missing canonical candidate inputs fail pass admission', () => {
  const { root } = fixture('canonical-inputs', { canonicalInputs: false });
  const args = [
    'begin',
    '--root', root,
    '--date', PASS_DATE,
    '--run-id', 'canonical-inputs',
    '--now', '2026-03-10T20:00:00.000Z',
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
    '--no-deliver',
  ];

  const broken = runNode(PASS_CLI, args, { root });
  assert.notEqual(broken.status, 0);
  assert.match(`${broken.stdout}\n${broken.stderr}`, /required nightly input missing|NIGHTLY_PASS ERROR/i);
  proof('BREAK canonical-inputs', broken);

  seedCanonicalInputs(root);
  const restored = runNode(PASS_CLI, args, { root });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.match(restored.stdout, /NIGHTLY_PASS BEGIN/);
  proof('RESTORE canonical-inputs', restored);
});

test('mutation proof: pass dating and freshness use the same configured time zone', () => {
  const { root } = fixture('time-zone');
  const log = write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', `## Nightly Pass -- ${PASS_DATE} (fixture)\n`);

  const utc = runNode(FRESHNESS_CLI, [
    '--kind', 'nightly',
    '--file', log,
    '--now', BOUNDARY_NOW,
    '--time-zone', 'UTC',
    '--cutoff-hour', CUTOFF_HOUR,
  ], { root });
  assert.equal(utc.status, 1);
  assert.match(utc.stdout, /NIGHTLY_FRESHNESS FAIL/);
  assert.match(utc.stdout, /expected=2026-03-11/);
  proof('BREAK inconsistent-time-zone', utc);

  const local = runNode(FRESHNESS_CLI, [
    '--kind', 'nightly',
    '--file', log,
    '--now', BOUNDARY_NOW,
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
  ], { root });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /NIGHTLY_FRESHNESS PASS/);
  assert.match(local.stdout, /expected=2026-03-10/);
  proof('RESTORE configured-time-zone', local);

  const begin = runNode(PASS_CLI, [
    'begin',
    '--root', root,
    '--run-id', 'time-zone',
    '--now', BOUNDARY_NOW,
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
    '--no-deliver',
  ], { root });
  assert.equal(begin.status, 0, begin.stderr);
  assert.match(begin.stdout, /date=2026-03-10/);
});

test('mutation proof: alert delivery is an append-only local signal and retries after a ledger error', () => {
  const { root } = fixture('local-alert');
  const ledger = path.join(root, 'vault', 'memory', 'runtime', 'NIGHTLY_ALERTS.jsonl');
  mkdirSync(ledger, { recursive: true });
  const runner = writeAlertRunner(root);

  const broken = runNode(runner, [root], { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /ALERT_RUNNER FAIL/);
  proof('BREAK local-alert-ledger', broken);

  rmSync(ledger, { recursive: true, force: true });
  const restored = runNode(runner, [root], { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stderr, /\[NIGHTLY-ALERT: "NIGHTLY:LOCAL_PROOF"\]/);
  const result = JSON.parse(restored.stdout);
  assert.equal(result.first.delivery.local, 'stderr');
  assert.equal(result.first.delivery.session_start, 'pending');
  assert.equal(result.second.deduped, true);

  const events = readFileSync(ledger, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter((event) => event.event === 'raised').length, 1);
  assert.ok(events.every((event) => event.alert_id === 'NIGHTLY:LOCAL_PROOF:fixture'));
  proof('RESTORE local-alert-ledger', restored);
});
