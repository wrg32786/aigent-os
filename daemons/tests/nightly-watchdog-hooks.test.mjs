// Mutation proofs for terminal pass status and SessionStart alert surfacing.
// Tests never write outside operating system temp fixtures.

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
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NIGHTLY_CHECKPOINTS,
  NIGHTLY_PROTOCOL,
} from '../nightly-pass.mjs';
import { expectedNightlyDate } from '../nightly-freshness.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS = path.resolve(TEST_DIR, '..');
const WATCHDOG_CLI = path.join(DAEMONS, 'nightly-watchdog.mjs');
const PASS_CLI = path.join(DAEMONS, 'nightly-pass.mjs');
const SESSIONSTART = path.join(DAEMONS, 'sessionstart-reinject.mjs');

const PASS_DATE = '2026-03-10';
const PASS_NOW = '2026-03-10T20:00:00.000Z';
const TIME_ZONE = 'America/Los_Angeles';
const CUTOFF_HOUR = '4';
const tempRoots = [];

function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function fixture(label) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'aigent-watchdog-proof-'));
  const root = path.join(base, label);
  mkdirSync(path.join(root, 'vault', 'memory', 'runtime'), { recursive: true });
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
  write(root, 'vault/memory/HONESTY_LEDGER.md', '# Honesty Ledger\n');
  write(root, 'vault/memory/TRUST_DECAY.md', '# Trust Decay\n\n## Open\n');
  write(root, 'vault/memory/FAILURE_MODES.md', '# Failure Modes\n');
  write(root, 'vault/memory/SESSION_LOG.md', '# Session Log\n');
  write(root, 'vault/memory/capsules/fixture.md', [
    '---',
    'id: fixture-capsule',
    'created_at: 2026-03-10T19:00:00.000Z',
    'status: active',
    'objective: "Verify SessionStart survives alert errors"',
    'next_valid_action: "Read the emitted hook payload"',
    'waiting_on: null',
    '---',
    '',
    '# Fixture capsule',
    '',
  ].join('\n'));
  tempRoots.push(base);
  return { base, root };
}

function canonicalDream() {
  return [
    '# Dream Log',
    '',
    `## ${PASS_DATE}: restored synthesis`,
    '- **Sources reviewed:** fixture:daily; fixture:runtime',
    '- **Lessons extracted:** no lessons extracted this pass',
    '- **Improvement candidates proposed:** none',
    '- **Patterns observed:** none',
    '- **Discarded as one-off:** none',
    '- **Calibration miscalls:** none',
    '- **Productive surprises:** none',
    '- **Open trust-decay items to watch:** none',
    '',
  ].join('\n');
}

// `failed` names checkpoints that ran and genuinely failed, so a caller can build a
// STRUCTURALLY COMPLETE block that is honestly red — the "fired and failed" shape, which
// is a different condition from a pass that never ran. Default [] keeps every existing
// call site byte-identical.
function protocolBlock(status, date = PASS_DATE, failed = []) {
  return [
    `## Nightly Pass -- ${date} (terminal-status-proof)`,
    `protocol: ${NIGHTLY_PROTOCOL}`,
    `status: ${status}`,
    `started_at: ${date}T19:00:00.000Z`,
    `completed_at: ${date}T19:05:00.000Z`,
    `time_zone: ${TIME_ZONE}`,
    `cutoff_hour: ${CUTOFF_HOUR}`,
    `framework_legs: 7 | checkpoints: ${NIGHTLY_CHECKPOINTS.length}/${NIGHTLY_CHECKPOINTS.length}`,
    ...NIGHTLY_CHECKPOINTS.map((checkpoint) => {
      const red = failed.includes(checkpoint);
      const exit = red ? 1 : 0;
      return `- ${checkpoint}: status=${red ? 'FAIL' : 'PASS'} exit=${exit}`
        + ` evidence=stdout:${checkpoint}@exit=${exit}`
        + ` alert=${red ? 'raised' : 'none'}`
        + ` validator=FIXTURE_RECEIPT_${red ? 'FAIL' : 'PASS'}`;
    }),
    '',
  ].join('\n');
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

function begin(root, runId) {
  const result = runNode(PASS_CLI, [
    'begin',
    '--root', root,
    '--date', PASS_DATE,
    '--run-id', runId,
    '--now', PASS_NOW,
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
  ], { root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function recordDream(root) {
  return runNode(PASS_CLI, [
    'record',
    '--root', root,
    '--checkpoint', 'dream',
    '--status', 'pass',
    '--exit-code', '0',
    '--detail', 'local-only mutation proof',
    '--artifact', 'file:memory/DREAM_LOG.md',
    '--now', '2026-03-10T20:01:00.000Z',
  ], { root });
}

test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    } catch {
      // Best effort for transient file locks.
    }
  }
});

test('mutation proof: terminal status FAIL is always a red watchdog result', () => {
  const { root } = fixture('terminal-status');
  const log = write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', protocolBlock('FAIL'));

  const args = [
    '--root', root,
    '--now', PASS_NOW,
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
    '--check-only',
  ];
  const broken = runNode(WATCHDOG_CLI, args, { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /NIGHTLY_WATCHDOG RED/);
  assert.match(broken.stdout, /incomplete|FAIL/i);
  assert.match(readFileSync(log, 'utf8'), /^status: FAIL$/m);
  proof('BREAK terminal-status', broken);

  writeFileSync(log, protocolBlock('PASS'), 'utf8');
  const restored = runNode(WATCHDOG_CLI, args, { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /NIGHTLY_WATCHDOG GREEN/);
  proof('RESTORE terminal-status', restored);
});

test('mutation proof: SessionStart persists and surfaces a missing-pass alert exactly once', () => {
  const { root } = fixture('sessionstart-no-fire');
  const ledger = path.join(
    root,
    'vault',
    'memory',
    'runtime',
    'NIGHTLY_ALERTS.jsonl',
  );
  const input = JSON.stringify({ source: 'startup', cwd: root });
  const broken = runNode(SESSIONSTART, [], { root, input });
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(broken.stderr, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  assert.match(broken.stdout, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);

  const firstEvents = readFileSync(ledger, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(
    firstEvents.filter((event) => (
      event.code === 'NIGHTLY:NO_FIRE' && event.event === 'raised'
    )).length,
    1,
  );
  assert.equal(
    firstEvents.filter((event) => (
      event.code === 'NIGHTLY:NO_FIRE'
      && event.event === 'delivery'
      && event.delivery?.local === 'stderr'
    )).length,
    1,
  );
  proof('BREAK sessionstart-no-fire', broken);

  const repeated = runNode(SESSIONSTART, [], { root, input });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.doesNotMatch(repeated.stderr, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  assert.match(repeated.stdout, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  const repeatedEvents = readFileSync(ledger, 'utf8').trim().split(/\r?\n/);
  assert.equal(repeatedEvents.length, firstEvents.length);

  const expected = expectedNightlyDate({
    now: new Date(),
    timeZone: TIME_ZONE,
    cutoffHour: CUTOFF_HOUR,
  });
  write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', protocolBlock('PASS', expected));
  const restored = runNode(SESSIONSTART, [], { root, input });
  assert.equal(restored.status, 0, restored.stderr);
  assert.doesNotMatch(restored.stdout, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  proof('RESTORE sessionstart-no-fire', restored);
});

test('mutation proof: an unreadable alert ledger cannot suppress SessionStart or resume output', () => {
  const { root } = fixture('unreadable-ledger');
  write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', protocolBlock('PASS'));
  const ledger = path.join(root, 'vault', 'memory', 'runtime', 'NIGHTLY_ALERTS.jsonl');
  mkdirSync(ledger, { recursive: true });

  const startupInput = JSON.stringify({ source: 'startup', cwd: root });
  const brokenStartup = runNode(SESSIONSTART, [], { root, input: startupInput });
  assert.equal(brokenStartup.status, 0, brokenStartup.stderr);
  assert.match(brokenStartup.stdout, /\[CLOCK\]|SESSIONSTART/i);
  assert.match(brokenStartup.stdout, /ALERT_SURFACE_FAILED|ALERT_LEDGER_INVALID|ledger/i);

  const clearInput = JSON.stringify({ source: 'clear', cwd: root });
  const brokenClear = runNode(SESSIONSTART, [], { root, input: clearInput });
  assert.equal(brokenClear.status, 0, brokenClear.stderr);
  assert.match(brokenClear.stdout, /\[CLOCK\]|RESUME/i);
  proof('BREAK unreadable-ledger startup', brokenStartup);
  proof('BREAK unreadable-ledger clear', brokenClear);

  rmSync(ledger, { recursive: true, force: true });
  writeFileSync(ledger, `${JSON.stringify({
    schema_version: 1,
    alert_id: 'NIGHTLY:NO_FIRE:fixture',
    code: 'NIGHTLY:NO_FIRE',
    name: 'NIGHTLY:NO_FIRE',
    summary: 'fixture alert',
    detail: 'restored readable ledger',
    evidence: 'memory/runtime/NIGHTLY_LOG.md',
    scope: 'fixture',
    raised_at: PASS_NOW,
    timestamp: PASS_NOW,
    status: 'active',
    event: 'raised',
    delivery: {
      local: 'stderr',
      session_start: 'pending',
    },
  })}\n`, 'utf8');

  const restoredStartup = runNode(SESSIONSTART, [], { root, input: startupInput });
  assert.equal(restoredStartup.status, 0, restoredStartup.stderr);
  assert.match(restoredStartup.stdout, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  assert.match(restoredStartup.stdout, /\[CLOCK\]|SESSIONSTART/i);
  const restoredClear = runNode(SESSIONSTART, [], { root, input: clearInput });
  assert.equal(restoredClear.status, 0, restoredClear.stderr);
  assert.match(restoredClear.stdout, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  assert.match(restoredClear.stdout, /\[CLOCK\]|RESUME/i);
  proof('RESTORE readable-ledger startup', restoredStartup);
  proof('RESTORE readable-ledger clear', restoredClear);
});

test('mutation proof: a failed leg stays visible without optional external transport', () => {
  const brokenFixture = fixture('local-only-break');
  begin(brokenFixture.root, 'local-only-break');
  write(brokenFixture.root, 'vault/memory/DREAM_LOG.md', `# Dream Log\n\n## ${PASS_DATE}: incomplete\n`);
  const broken = recordDream(brokenFixture.root);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /NIGHTLY_CHECKPOINT RED/);
  assert.match(broken.stderr, /\[NIGHTLY-ALERT: NIGHTLY:LEG_FAIL:dream\]/);

  const ledger = path.join(
    brokenFixture.root,
    'vault',
    'memory',
    'runtime',
    'NIGHTLY_ALERTS.jsonl',
  );
  const events = readFileSync(ledger, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(events.some((event) => event.event === 'raised' && event.status === 'active'));
  assert.ok(events.some((event) => event.delivery?.local === 'stderr'));

  const startup = runNode(SESSIONSTART, [], {
    root: brokenFixture.root,
    input: JSON.stringify({ source: 'startup', cwd: brokenFixture.root }),
  });
  assert.equal(startup.status, 0, startup.stderr);
  assert.match(startup.stdout, /\[NIGHTLY-ALERT: NIGHTLY:LEG_FAIL:dream\]/);
  proof('BREAK local-only-leg', broken);
  proof('BREAK local-only-session-start', startup);

  const restoredFixture = fixture('local-only-restore');
  begin(restoredFixture.root, 'local-only-restore');
  write(restoredFixture.root, 'vault/memory/DREAM_LOG.md', canonicalDream());
  const restored = recordDream(restoredFixture.root);
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.match(restored.stdout, /NIGHTLY_CHECKPOINT GREEN/);
  assert.doesNotMatch(restored.stderr, /external transport/i);
  proof('RESTORE local-only-leg', restored);
});

// A nightly that ran every checkpoint and honestly reported failures DID run.
// Scoring that as "incomplete" made honest failure and a silently dead nightly
// emit the same NIGHTLY:NO_FIRE alert, so a real no-fire hid among passes that
// did fire. Completeness is structural; the verdict is separate.
test('mutation proof: an honest FAIL is "fired and failed", never a no-fire', async () => {
  const { assessNightlyCompletion } = await import('../nightly-watchdog.mjs');
  const { base, root } = fixture('failed-vs-nofire');
  try {
    const failedBlock = protocolBlock('FAIL')
      .replace(
        '- reconcile: status=PASS exit=0 evidence=stdout:reconcile@exit=0 alert=none validator=FIXTURE_RECEIPT_PASS',
        '- reconcile: status=FAIL exit=1 evidence=stdout:reconcile@exit=1 alert=none validator=FIXTURE_RECEIPT_FAIL',
      )
      .replace(
        '- system-check: status=PASS exit=0 evidence=stdout:system-check@exit=0 alert=none validator=FIXTURE_RECEIPT_PASS',
        '- system-check: status=FAIL exit=1 evidence=stdout:system-check@exit=1 alert=none validator=FIXTURE_RECEIPT_FAIL',
      );
    const log = write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', failedBlock);

    const failed = assessNightlyCompletion({
      file: log, date: PASS_DATE, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR,
    });
    assert.equal(failed.ok, false, 'a failing nightly must never read green');
    assert.equal(failed.code, 'failed', 'complete-but-failed is not "incomplete"');
    assert.deepEqual(failed.failedCheckpoints, ['reconcile', 'system-check']);
    assert.match(failed.detail, /fired and failed/);
    console.log(`LAW-XV RED: honest FAIL classified '${failed.code}' — ${failed.detail}`);

    // MUTATION: drop a checkpoint. A pass that never finished is a genuinely
    // different condition and must still read as incomplete, not "failed".
    write(
      root,
      'vault/memory/runtime/NIGHTLY_LOG.md',
      failedBlock.split('\n').filter((line) => !line.startsWith('- vault-sync:')).join('\n'),
    );
    const truncated = assessNightlyCompletion({
      file: log, date: PASS_DATE, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR,
    });
    assert.equal(truncated.ok, false);
    assert.equal(truncated.code, 'incomplete', 'a missing checkpoint is still incompleteness');
    console.log(`MUTATION RED: missing checkpoint stayed '${truncated.code}'`);

    // INTEGRITY: a block claiming PASS while carrying failed rows is lying
    // about itself — that must remain incomplete, not be excused as "failed".
    write(
      root,
      'vault/memory/runtime/NIGHTLY_LOG.md',
      protocolBlock('PASS').replace(
        '- dream: status=PASS exit=0 evidence=stdout:dream@exit=0 alert=none validator=FIXTURE_RECEIPT_PASS',
        '- dream: status=FAIL exit=1 evidence=stdout:dream@exit=1 alert=none validator=FIXTURE_RECEIPT_FAIL',
      ),
    );
    const lying = assessNightlyCompletion({
      file: log, date: PASS_DATE, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR,
    });
    assert.equal(lying.code, 'incomplete', 'PASS over failed rows is an integrity defect');
    console.log(`INTEGRITY RED: PASS-over-failed-rows stayed '${lying.code}'`);

    // RESTORE: an all-PASS block is complete and green.
    write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', protocolBlock('PASS'));
    const green = assessNightlyCompletion({
      file: log, date: PASS_DATE, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR,
    });
    assert.equal(green.ok, true);
    assert.equal(green.code, 'complete');
    console.log(`RESTORE GREEN: ${green.detail}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A line that looks like a checkpoint row but misses the strict row regex was
// dropped silently. Paired with a well-formed row for the same checkpoint it
// evaded both `missing` and `duplicates`, so the block read "11/11 checkpoints"
// with a FAIL row in it. Both specimens found by DaVinci in R26 review.
test('mutation proof: an unparseable checkpoint row is loud, never silently dropped', async () => {
  const { assessNightlyCompletion } = await import('../nightly-watchdog.mjs');
  const { base, root } = fixture('unparseable-rows');
  try {
    const log = path.join(root, 'vault/memory/runtime/NIGHTLY_LOG.md');
    for (const loose of [
      '- heat-index: status=FAIL (crashed, no exit recorded)',
      '- heat-index: status=ERROR exit=1 validator=r',
    ]) {
      // The loose row is ADDED alongside the complete set — that pairing is what
      // used to make it invisible to every existing guard.
      write(
        root,
        'vault/memory/runtime/NIGHTLY_LOG.md',
        protocolBlock('PASS').replace(/\n$/, `\n${loose}\n`),
      );
      const leak = assessNightlyCompletion({
        file: log, date: PASS_DATE, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR,
      });
      assert.equal(leak.ok, false, `must not read green: ${loose}`);
      assert.equal(leak.code, 'incomplete');
      assert.match(leak.detail, /unparseable_rows=1/);
      console.log(`LAW-XV RED: '${loose.slice(0, 44)}' -> ${leak.code}`);
    }

    // RESTORE: the honest block has no unparseable rows and stays green — the
    // guard must not simply refuse everything.
    write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', protocolBlock('PASS'));
    const green = assessNightlyCompletion({
      file: log, date: PASS_DATE, timeZone: TIME_ZONE, cutoffHour: CUTOFF_HOUR,
    });
    assert.equal(green.ok, true);
    assert.equal(green.code, 'complete');
    console.log(`RESTORE GREEN: ${green.detail}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// WIRING proof — deliberately NOT another assertion on assessNightlyCompletion.
// The assessor can return code='failed' perfectly while the alert never reaches a human.
// NIGHTLY:PASS_FAILED is emitted at exactly ONE site and, before this test, was asserted
// NOWHERE — every other hook assertion in this file pins NIGHTLY:NO_FIRE. So a code filter
// added to the boot path would leave the unit tests green while Will silently stopped being
// told his nightly failed. This drives the REAL SessionStart entry point end to end and
// asserts on the boot payload a human actually sees.
test('mutation proof: a fired-and-failed nightly reaches SessionStart boot output as PASS_FAILED, never NO_FIRE', () => {
  const { root } = fixture('sessionstart-pass-failed');
  const input = JSON.stringify({ source: 'startup', cwd: root });
  // Dated for the watchdog SessionStart actually runs: it takes no `now` override, so a
  // stale fixture would fail the freshness gate first and mask the condition under test.
  const expected = expectedNightlyDate({
    now: new Date(),
    timeZone: TIME_ZONE,
    cutoffHour: CUTOFF_HOUR,
  });

  // BREAK: a structurally complete evidence block that is honestly red on one checkpoint.
  write(
    root,
    'vault/memory/runtime/NIGHTLY_LOG.md',
    protocolBlock('FAIL', expected, ['heat-index']),
  );
  const failed = runNode(SESSIONSTART, [], { root, input });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /\[NIGHTLY-ALERT: NIGHTLY:PASS_FAILED\]/);
  // Named, not merely coded — an alert that cannot say WHICH leg failed sends a human back
  // to the log to find out, which is the friction the alert exists to remove.
  assert.match(failed.stdout, /heat-index/);
  // The point of separating structure from verdict: a pass that DID fire must never be
  // reported as one that never ran.
  assert.doesNotMatch(failed.stdout, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  proof('BREAK sessionstart-pass-failed', failed);

  // RESTORE: same block, every checkpoint green — the alert must clear from boot output.
  write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', protocolBlock('PASS', expected));
  const restored = runNode(SESSIONSTART, [], { root, input });
  assert.equal(restored.status, 0, restored.stderr);
  assert.doesNotMatch(restored.stdout, /\[NIGHTLY-ALERT: NIGHTLY:PASS_FAILED\]/);
  assert.doesNotMatch(restored.stdout, /\[NIGHTLY-ALERT: NIGHTLY:NO_FIRE\]/);
  proof('RESTORE sessionstart-pass-failed', restored);
});
