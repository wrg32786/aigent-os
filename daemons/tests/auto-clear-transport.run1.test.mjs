// auto-clear-transport.run1.test.mjs -- RUN 1 deterministic RED vectors.
//
// Each top-level case corresponds to one named build-spec vector.  Clocks and
// lifecycle observables are controlled directly; no assertion waits for wall
// time to pass, and no attempted action is accepted as proof of its result.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AutoClearTransport,
  CHECKPOINT_TAIL_TOLERANCE_BYTES,
  RunnerLockError,
  acquireRunnerLock,
  releaseRunnerLock,
  transcriptPathFor,
} from '../auto-clear-transport.mjs';
import { writeBootReceipt } from '../boot-receipt.mjs';
import { readPressure } from '../ctx-telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS = path.join(__dirname, '..');
const STATUSLINE = path.join(DAEMONS, 'statusline-ctx.sh');
const CTX_TELEMETRY = path.join(DAEMONS, 'ctx-telemetry.mjs');
const BOOT_RECEIPT = path.join(DAEMONS, 'boot-receipt.mjs');
const SESSIONSTART = path.join(DAEMONS, 'sessionstart-reinject.mjs');
const CYCLE_FILE = 'auto-clear-cycle.json';
const SESSION_ID = 'session-current';
const BASE_TIME = Date.parse('2026-07-30T18:00:00.000Z');

function controlledClock(start = BASE_TIME) {
  let milliseconds = start;
  const now = () => new Date(milliseconds);
  now.advance = (amount) => { milliseconds += amount; };
  now.set = (value) => { milliseconds = Number(value); };
  now.ms = () => milliseconds;
  return now;
}

function writeText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

function writeJson(target, value) {
  return writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function cyclePath(fixture) {
  return path.join(fixture.memRoot, 'runtime', CYCLE_FILE);
}

function makeFixture(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `run1-${name}-`));
  const memRoot = path.join(base, 'memory');
  const homeDir = path.join(base, 'home');
  const cwd = path.join(base, 'work', 'project');
  const clock = controlledClock();
  const logs = [];
  const env = {};
  const capsulePath = writeText(
    path.join(memRoot, 'capsules', 'current.md'),
    'checkpoint fixture\n',
  );
  const transcriptPath = transcriptPathFor({
    cwd,
    sessionId: SESSION_ID,
    homeDir,
  });
  const transcript = '0123456789';
  writeText(transcriptPath, transcript);
  writeJson(
    path.join(memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`),
    {
      offset: Buffer.byteLength(transcript),
      capsule_path: capsulePath,
      last_delta_sha: 'fixture',
    },
  );
  writeJson(path.join(memRoot, 'runtime', 'boot-receipt.json'), {
    boot_sequence: 10,
    session_id: SESSION_ID,
    source: 'startup',
    observed_at: new Date(clock.ms()).toISOString(),
  });
  return {
    name,
    base,
    memRoot,
    homeDir,
    cwd,
    clock,
    logs,
    env,
    capsulePath,
    transcriptPath,
    transcriptSize: Buffer.byteLength(transcript),
    pressure: { pct: 90, fresh: true, state: 'ok' },
    selection: {
      capsule: {
        path: capsulePath,
        id: 'current',
        created: BASE_TIME,
        createdRaw: new Date(BASE_TIME).toISOString(),
      },
      rejected: [],
    },
  };
}

function destroyFixture(fixture) {
  fs.rmSync(fixture.base, { recursive: true, force: true });
}

function createTransport(fixture, overrides = {}) {
  return new AutoClearTransport({
    memRoot: fixture.memRoot,
    sessionId: SESSION_ID,
    cwd: fixture.cwd,
    homeDir: fixture.homeDir,
    fsImpl: fs,
    now: fixture.clock,
    env: fixture.env,
    pressureThresholdPct: 80,
    pressureFreshnessMs: 120_000,
    selectCapsuleFn: () => fixture.selection,
    readPressureFn: () => ({ ...fixture.pressure }),
    idFactory: () => `cycle-${fixture.name}`,
    log: (message) => fixture.logs.push(message),
    acquireLock: false,
    ...overrides,
  });
}

function primeCheckpointConfirmed(transport) {
  assert.equal(transport.tick().state.state, 'pressure');
  const requested = transport.tick();
  assert.equal(requested.state.state, 'checkpoint-requested');
  assert.equal(requested.action, 'request-checkpoint');
  assert.equal(transport.tick().state.state, 'checkpoint-confirmed');
}

function persistedState(fixture, state, overrides = {}) {
  const active = state !== 'idle';
  const hasIntent = ['clear-submitted', 'clear-verified', 'released'].includes(state);
  return {
    state,
    cycle_id: active ? `cycle-${fixture.name}` : null,
    session_id: SESSION_ID,
    boot_sequence_at_start: active ? 10 : null,
    clear_intent: hasIntent
      ? { written_at: new Date(BASE_TIME + 1000).toISOString(), submitted: true }
      : null,
    entered_at: new Date(BASE_TIME).toISOString(),
    hold: null,
    ...overrides,
  };
}

test('1. checkpoint failure: selector rejection holds and surfaces its rejection ledger', () => {
  const fixture = makeFixture('selector-reject');
  try {
    const rejected = [
      { name: 'torn.md', reason: 'missing-required-field', detail: 'next_valid_action' },
      { name: 'spent.md', reason: 'already-consumed', detail: 'resumed' },
    ];
    fixture.selection = {
      capsule: null,
      rejected,
      unavailable: 'all-candidates-rejected',
    };
    const transport = createTransport(fixture);
    assert.equal(transport.tick().state.state, 'pressure');
    assert.equal(transport.tick().state.state, 'checkpoint-requested');
    const held = transport.tick();
    assert.equal(held.state.state, 'HOLD:checkpoint-rejected');
    assert.equal(held.state.hold.code, 'checkpoint-rejected');
    assert.equal(held.state.hold.detail.unavailable, 'all-candidates-rejected');
    assert.deepEqual(held.state.hold.detail.rejected, rejected);
    assert.equal(held.state.clear_intent, null);
  } finally {
    destroyFixture(fixture);
  }
});

test('2. stale-capsule: previous-session binding and short transcript offset both refuse authorization', () => {
  const mismatch = makeFixture('stale-binding');
  const short = makeFixture('short-offset');
  try {
    const previousCapsule = writeText(
      path.join(mismatch.memRoot, 'capsules', 'previous.md'),
      'previous checkpoint\n',
    );
    mismatch.selection = {
      capsule: { ...mismatch.selection.capsule, path: previousCapsule, id: 'previous' },
      rejected: [],
    };
    const mismatchTransport = createTransport(mismatch);
    assert.equal(mismatchTransport.tick().state.state, 'pressure');
    assert.equal(mismatchTransport.tick().state.state, 'checkpoint-requested');
    const mismatchHeld = mismatchTransport.tick();
    assert.equal(mismatchHeld.state.state, 'HOLD:checkpoint-session-mismatch');
    assert.equal(mismatchHeld.state.clear_intent, null);

    writeJson(
      path.join(short.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`),
      {
        // The lag must EXCEED the announcement budget to be a real staleness
        // signal. A 1-byte gap used to sit here, asserting the old byte-exact
        // rule; under the derived budget that is legitimately tolerated (less
        // than one capped acknowledgement). The base fixture transcript is only
        // 10 bytes, so the gap is made by GROWING the transcript rather than
        // subtracting from the offset — subtracting drove it negative and the
        // transport correctly refused with checkpoint-record-offset-invalid,
        // which would have passed this test for the wrong reason.
        offset: 0,
        capsule_path: short.capsulePath,
        last_delta_sha: 'short',
      },
    );
    fs.appendFileSync(
      short.transcriptPath,
      `\n{"type":"attachment","pad":"${'x'.repeat(CHECKPOINT_TAIL_TOLERANCE_BYTES + 1)}"}\n`,
    );
    const shortStaleSize = fs.statSync(short.transcriptPath).size;
    assert.ok(
      shortStaleSize > CHECKPOINT_TAIL_TOLERANCE_BYTES,
      'vector is only meaningful if the lag exceeds the tolerated budget',
    );
    const shortTransport = createTransport(short);
    assert.equal(shortTransport.tick().state.state, 'pressure');
    assert.equal(shortTransport.tick().state.state, 'checkpoint-requested');
    const shortHeld = shortTransport.tick();
    assert.equal(shortHeld.state.state, 'HOLD:checkpoint-transcript-short');
    assert.equal(shortHeld.state.hold.detail.captured_offset, 0);
    assert.equal(shortHeld.state.hold.detail.stable_size, shortStaleSize);
    assert.equal(shortHeld.state.clear_intent, null);
  } finally {
    destroyFixture(mismatch);
    destroyFixture(short);
  }
});

test('3. duplicate clear: intent and one-shot token refuse every second submission path', () => {
  const fixture = makeFixture('duplicate-clear');
  try {
    const transport = createTransport(fixture);
    primeCheckpointConfirmed(transport);

    const token = transport.beginClearSubmission();
    const intentBeforeSubmit = readJson(cyclePath(fixture));
    assert.equal(intentBeforeSubmit.state, 'clear-submitted');
    assert.deepEqual(intentBeforeSubmit.clear_intent, {
      written_at: token.written_at,
      submitted: false,
    });
    assert.throws(
      () => transport.beginClearSubmission(),
      (error) => error?.code === 'EDUPLICATE_CLEAR',
    );

    let submissions = 0;
    const result = token.submit(() => {
      submissions += 1;
      assert.equal(
        readJson(cyclePath(fixture)).clear_intent.submitted,
        true,
        'submitted=true must persist before caller IO runs',
      );
      return 'submitted-once';
    });
    assert.equal(result, 'submitted-once');
    assert.equal(submissions, 1);
    assert.throws(
      () => token.submit(() => { submissions += 1; }),
      (error) => error?.code === 'EDUPLICATE_CLEAR',
    );
    assert.equal(submissions, 1);
  } finally {
    destroyFixture(fixture);
  }
});

test('4. crash between submit and verify: restart holds clear-ambiguous and exposes no resubmission', () => {
  const fixture = makeFixture('crash-ambiguous');
  try {
    const first = createTransport(fixture);
    primeCheckpointConfirmed(first);
    const token = first.beginClearSubmission();
    token.submit(() => 'submission attempted');
    assert.equal(readJson(cyclePath(fixture)).clear_intent.submitted, true);

    const restarted = createTransport(fixture);
    const replay = restarted.tick();
    assert.equal(replay.state.state, 'HOLD:clear-ambiguous');
    assert.equal(replay.state.hold.code, 'clear-ambiguous');
    assert.equal(replay.state.clear_intent.submitted, true);
    assert.equal(replay.action, undefined);
    assert.throws(
      () => restarted.beginClearSubmission(),
      (error) => error?.code === 'EDUPLICATE_CLEAR',
    );
  } finally {
    destroyFixture(fixture);
  }
});

test('5. restart replay: every persisted state re-derives position and never repeats completed steps', () => {
  const cases = [
    ['idle', 'pressure', undefined],
    ['pressure', 'checkpoint-requested', 'request-checkpoint'],
    ['checkpoint-requested', 'checkpoint-confirmed', undefined],
    ['checkpoint-confirmed', 'checkpoint-confirmed', undefined],
    ['clear-submitted', 'clear-verified', undefined],
    ['clear-verified', 'released', undefined],
    ['released', 'released', undefined],
  ];

  for (const [from, expected, expectedAction] of cases) {
    const fixture = makeFixture(`restart-${from}`);
    try {
      writeJson(cyclePath(fixture), persistedState(fixture, from));
      if (['clear-submitted', 'clear-verified', 'released'].includes(from)) {
        writeJson(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), {
          boot_sequence: 11,
          session_id: 'session-after-clear',
          source: 'clear',
          observed_at: new Date(BASE_TIME + 5000).toISOString(),
        });
      }
      const transport = createTransport(fixture);
      const derived = transport.tick();
      assert.equal(derived.state.state, expected, `${from} must derive ${expected}`);
      assert.equal(derived.action, expectedAction, `${from} action replay`);
      if (from === 'released') assert.equal(derived.transitioned, false);
    } finally {
      destroyFixture(fixture);
    }
  }
});

test('6. boot receipt: monotonic atomic writes and clear ordering precede resume and nightly work', () => {
  const fixture = makeFixture('boot-receipt');
  const operations = [];
  const tracedFs = Object.create(fs);
  tracedFs.writeFileSync = (target, ...args) => {
    if (typeof target === 'string') operations.push({ operation: 'write', target });
    return fs.writeFileSync(target, ...args);
  };
  tracedFs.renameSync = (from, to) => {
    operations.push({ operation: 'rename', from, to });
    return fs.renameSync(from, to);
  };
  try {
    fs.rmSync(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), { force: true });
    const errors = [];
    const first = writeBootReceipt({
      payload: { session_id: 'boot-a', source: 'startup' },
      memRoot: fixture.memRoot,
      fsImpl: tracedFs,
      now: fixture.clock,
      logError: (message) => errors.push(message),
    });
    fixture.clock.advance(1000);
    const second = writeBootReceipt({
      payload: { session_id: 'boot-b', source: 'clear' },
      memRoot: fixture.memRoot,
      fsImpl: tracedFs,
      now: fixture.clock,
      logError: (message) => errors.push(message),
    });
    assert.equal(first.boot_sequence, 0);
    assert.equal(second.boot_sequence, 1);
    assert.equal(second.source, 'clear');
    assert.equal(errors.length, 1, 'missing prior receipt logs exactly one line');
    const receiptTarget = path.join(fixture.memRoot, 'runtime', 'boot-receipt.json');
    fs.writeFileSync(receiptTarget, '{corrupt\n');
    fixture.clock.advance(1000);
    const afterCorruption = writeBootReceipt({
      payload: { session_id: 'boot-c', source: 'resume' },
      memRoot: fixture.memRoot,
      fsImpl: tracedFs,
      now: fixture.clock,
      logError: (message) => errors.push(message),
    });
    assert.equal(afterCorruption.boot_sequence, 0);
    assert.match(errors[1], /previous receipt corrupt/);
    assert.equal(errors.length, 2, 'corrupt prior receipt logs exactly one line');
    assert.ok(
      operations.some((entry) => entry.operation === 'write'
        && entry.target.startsWith(`${receiptTarget}.tmp-`)),
      'atomic-state writes a unique tmp file',
    );
    assert.ok(
      operations.some((entry) => entry.operation === 'rename'
        && entry.to === receiptTarget
        && entry.from.startsWith(`${receiptTarget}.tmp-`)),
      'atomic-state commits with rename',
    );

    const directRoot = path.join(fixture.base, 'direct-noop');
    fs.mkdirSync(directRoot, { recursive: true });
    const direct = spawnSync(process.execPath, [BOOT_RECEIPT], {
      input: JSON.stringify({ source: 'clear', session_id: 'must-not-write' }),
      encoding: 'utf8',
      env: { ...process.env, AIGENT_ROOT: directRoot },
    });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout, '');
    assert.equal(
      fs.existsSync(path.join(directRoot, 'runtime', 'boot-receipt.json')),
      false,
      'direct execution is inert',
    );

    const root = path.join(fixture.base, 'sessionstart-root');
    const memory = path.join(root, 'memory');
    const capsule = writeText(
      path.join(memory, 'capsules', 'clear-order.md'),
      '---\n'
        + 'id: clear-order\n'
        + 'status: active\n'
        + 'objective: "prove boot order"\n'
        + 'next_valid_action: "resume after receipt"\n'
        + 'created_at: 2026-07-30T17:00:00.000Z\n'
        + '---\n\n# fixture\n',
    );
    const input = JSON.stringify({
      source: 'clear',
      session_id: 'clear-session',
      cwd: root,
    });
    const env = { ...process.env, AIGENT_ROOT: root };
    delete env.AIGENT_STATE_HOME_DIR;
    const sessionstart = spawnSync(process.execPath, [SESSIONSTART], {
      input,
      encoding: 'utf8',
      env,
    });
    assert.equal(sessionstart.status, 0, sessionstart.stderr);
    assert.match(sessionstart.stdout, /\[RESUME VERB\]/);
    assert.equal(readJson(path.join(memory, 'runtime', 'boot-receipt.json')).source, 'clear');
    assert.match(fs.readFileSync(capsule, 'utf8'), /^status:\s*resumed\s*$/m);

    const source = fs.readFileSync(SESSIONSTART, 'utf8');
    const receiptCall = source.indexOf('writeBootReceipt({');
    const clearBranch = source.indexOf("if (source === 'clear')");
    const resumeCall = source.indexOf('runResumeVerb({', clearBranch);
    const nightlyCall = source.indexOf('await runNightlyBoot(root)', clearBranch);
    assert.ok(receiptCall >= 0 && receiptCall < clearBranch);
    assert.ok(clearBranch < resumeCall && resumeCall < nightlyCall);
  } finally {
    destroyFixture(fixture);
  }
});

test('7. telemetry: missing jq uses Node, stale and missing are named, and the machine holds', () => {
  const fixture = makeFixture('telemetry-fallback');
  const missingFixture = makeFixture('telemetry-missing');
  const staleFixture = makeFixture('telemetry-stale');
  try {
    const payload = JSON.stringify({
      session_id: 'fallback-session',
      model: { display_name: 'FallbackModel' },
      context_window: { used_percentage: 84.5 },
    });
    const delegate = path.join(fixture.base, 'no-delegate.sh');
    const fallback = spawnSync('bash', [STATUSLINE], {
      input: payload,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        CTX_TELEMETRY_FORCE_NODE: '1',
        AIGENT_STATUSLINE_DELEGATE: delegate,
      },
    });
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackFile = path.join(
      fixture.homeDir,
      '.claude',
      'ctx-refresh',
      'fallback-session.json',
    );
    assert.equal(readJson(fallbackFile).used_percentage, 84.5);

    const directPayload = JSON.stringify({
      session_id: 'direct-session',
      model: { display_name: 'DirectModel' },
      context_window: { used_percentage: 73.2 },
    });
    const direct = spawnSync(process.execPath, [CTX_TELEMETRY], {
      input: directPayload,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        AIGENT_STATUSLINE_DELEGATE: delegate,
      },
    });
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stdout, /DirectModel \| ctx 73%/);
    assert.equal(readJson(path.join(
      fixture.homeDir,
      '.claude',
      'ctx-refresh',
      'direct-session.json',
    )).used_percentage, 73.2);

    const observedAt = new Date(fixture.clock.ms());
    fs.utimesSync(fallbackFile, observedAt, observedAt);
    assert.deepEqual(readPressure({
      sessionId: 'fallback-session',
      homeDir: fixture.homeDir,
      fsImpl: fs,
      now: fixture.clock,
    }), { pct: 84.5, fresh: true, state: 'ok' });
    fixture.clock.advance(120_001);
    assert.deepEqual(readPressure({
      sessionId: 'fallback-session',
      homeDir: fixture.homeDir,
      fsImpl: fs,
      now: fixture.clock,
    }), { pct: 84.5, fresh: false, state: 'stale' });
    assert.deepEqual(readPressure({
      sessionId: 'absent-session',
      homeDir: fixture.homeDir,
      fsImpl: fs,
      now: fixture.clock,
    }), { pct: null, fresh: false, state: 'missing' });

    const missing = createTransport(missingFixture, { readPressureFn: readPressure });
    assert.equal(missing.tick().state.state, 'HOLD:telemetry-missing');

    const staleFile = writeJson(
      path.join(staleFixture.homeDir, '.claude', 'ctx-refresh', `${SESSION_ID}.json`),
      { used_percentage: 91, ts: '2026-07-30T17:00:00Z' },
    );
    const old = new Date(staleFixture.clock.ms() - 120_001);
    fs.utimesSync(staleFile, old, old);
    const stale = createTransport(staleFixture, { readPressureFn: readPressure });
    assert.equal(stale.tick().state.state, 'HOLD:telemetry-stale');
  } finally {
    destroyFixture(fixture);
    destroyFixture(missingFixture);
    destroyFixture(staleFixture);
  }
});

test('8. payload-integrity: every missing predicate field fails closed with a named reason', () => {
  const telemetryFixture = makeFixture('missing-pressure-field');
  const checkpointFixture = makeFixture('missing-record-field');
  const receiptFixture = makeFixture('missing-receipt-field');
  const stateFixture = makeFixture('missing-state-field');
  try {
    const telemetry = createTransport(telemetryFixture, {
      readPressureFn: () => ({ fresh: true, state: 'ok' }),
    });
    assert.equal(telemetry.tick().state.state, 'HOLD:telemetry-field-missing');
    assert.deepEqual(telemetry.state.hold.detail.fields, ['pct']);

    writeJson(
      path.join(checkpointFixture.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`),
      { capsule_path: checkpointFixture.capsulePath },
    );
    const checkpoint = createTransport(checkpointFixture);
    assert.equal(checkpoint.tick().state.state, 'pressure');
    assert.equal(checkpoint.tick().state.state, 'checkpoint-requested');
    const checkpointHeld = checkpoint.tick();
    assert.equal(checkpointHeld.state.state, 'HOLD:checkpoint-record-field-missing');
    assert.equal(checkpointHeld.state.hold.detail.field, 'offset');

    const receipt = createTransport(receiptFixture);
    primeCheckpointConfirmed(receipt);
    receipt.beginClearSubmission();
    const receiptHeld = receipt.confirmClearObserved({
      boot_sequence: 11,
      session_id: 'after-clear',
      observed_at: '2026-07-30T18:01:00.000Z',
    });
    assert.equal(receiptHeld.state.state, 'HOLD:boot-receipt-field-missing');
    assert.deepEqual(receiptHeld.state.hold.detail.fields, ['source']);

    const missingHold = persistedState(stateFixture, 'pressure');
    delete missingHold.hold;
    writeJson(cyclePath(stateFixture), missingHold);
    const invalidState = createTransport(stateFixture);
    assert.equal(invalidState.state.state, 'HOLD:cycle-state-field-missing');
    assert.deepEqual(invalidState.state.hold.detail.fields, ['hold']);
  } finally {
    destroyFixture(telemetryFixture);
    destroyFixture(checkpointFixture);
    destroyFixture(receiptFixture);
    destroyFixture(stateFixture);
  }
});

test('9. single-runner: live holder refuses nonzero and a dead holder is reclaimed with a log line', () => {
  const fixture = makeFixture('runner-lock');
  const messages = [];
  try {
    const first = acquireRunnerLock({
      memRoot: fixture.memRoot,
      fsImpl: fs,
      now: fixture.clock,
      pid: 101,
      isPidAlive: (pid) => pid === 101,
      log: (message) => messages.push(message),
    });
    assert.throws(
      () => acquireRunnerLock({
        memRoot: fixture.memRoot,
        fsImpl: fs,
        now: fixture.clock,
        pid: 202,
        isPidAlive: (pid) => pid === 101,
        log: (message) => messages.push(message),
      }),
      (error) => error instanceof RunnerLockError
        && error.code === 'ERUNNERLIVE'
        && error.exitCode === 1,
    );
    assert.match(messages.join('\n'), /live runner lock refused/);
    assert.equal(releaseRunnerLock(first, { fsImpl: fs }), true);

    const lockFile = path.join(
      fixture.memRoot,
      'runtime',
      'auto-clear-transport.lock',
    );
    writeJson(lockFile, { pid: 303, started_at: '2026-07-30T17:00:00.000Z' });
    const reclaimed = acquireRunnerLock({
      memRoot: fixture.memRoot,
      fsImpl: fs,
      now: fixture.clock,
      pid: 404,
      isPidAlive: () => false,
      log: (message) => messages.push(message),
    });
    assert.equal(readJson(lockFile).pid, 404);
    assert.match(messages.join('\n'), /stale runner lock reclaimed pid=303/);
    assert.equal(releaseRunnerLock(reclaimed, { fsImpl: fs }), true);
  } finally {
    destroyFixture(fixture);
  }
});

test('10. kill switch: env and presence file stop initiation same-tick while manual clear still resolves', () => {
  const fixture = makeFixture('kill-switch');
  const manualFixture = makeFixture('kill-manual-clear');
  try {
    fixture.env.AUTO_CLEAR_OFF = '1';
    const transport = createTransport(fixture);
    const envKilled = transport.tick();
    assert.equal(envKilled.state.state, 'idle');
    assert.equal(envKilled.code, 'kill-switch-env');
    assert.equal(readJson(cyclePath(fixture)).cycle_id, null);

    delete fixture.env.AUTO_CLEAR_OFF;
    writeText(path.join(fixture.memRoot, 'runtime', 'auto-clear-off'), 'off\n');
    const fileKilled = transport.tick();
    assert.equal(fileKilled.state.state, 'idle');
    assert.equal(fileKilled.code, 'kill-switch-file');
    assert.equal(readJson(cyclePath(fixture)).cycle_id, null);

    fs.rmSync(path.join(fixture.memRoot, 'runtime', 'auto-clear-off'));
    assert.equal(transport.tick().state.state, 'pressure');

    const manual = createTransport(manualFixture);
    primeCheckpointConfirmed(manual);
    manual.beginClearSubmission().submit(() => 'automatic submission attempted');
    manualFixture.env.AUTO_CLEAR_OFF = '1';
    writeJson(path.join(manualFixture.memRoot, 'runtime', 'boot-receipt.json'), {
      boot_sequence: 11,
      session_id: 'manual-clear-session',
      source: 'clear',
      observed_at: new Date(BASE_TIME + 1000).toISOString(),
    });
    const observed = manual.tick();
    assert.equal(observed.state.state, 'clear-verified');
    assert.notEqual(observed.state.state, 'HOLD:kill-switch-env');
  } finally {
    destroyFixture(fixture);
    destroyFixture(manualFixture);
  }
});

import { createRequire as createDeltaRequire } from 'node:module';

const deltaRequire = createDeltaRequire(import.meta.url);
const { atomicUpdate: atomicFixtureUpdate } = deltaRequire(
  '../memory-hygiene/atomic-state.cjs',
);

function writeAtomicFixtureText(target, text, fixture) {
  atomicFixtureUpdate(target, () => text, {
    fsImpl: fs,
    now: () => fixture.clock.ms(),
  });
  return target;
}

function writeAtomicFixtureJson(target, value, fixture) {
  return writeAtomicFixtureText(
    target,
    `${JSON.stringify(value, null, 2)}\n`,
    fixture,
  );
}

test('11. authorization-site checkpoint decay refuses clear and persists no intent', () => {
  const fixture = makeFixture('authorization-checkpoint-decay');
  try {
    const transport = createTransport(fixture);
    primeCheckpointConfirmed(transport);

    // Must exceed the announcement budget to represent REAL post-checkpoint
    // activity. A ~60-byte line used to sit here; under the derived budget that
    // is one capped acknowledgement's worth and is correctly tolerated. Padding
    // from the constant keeps the vector discriminating if the budget moves.
    const activity = `\n{"type":"assistant","message":"activity after checkpoint","pad":"${
      'x'.repeat(CHECKPOINT_TAIL_TOLERANCE_BYTES + 1)
    }"}\n`;
    atomicFixtureUpdate(
      fixture.transcriptPath,
      (current) => `${current ?? ''}${activity}`,
      {
        fsImpl: fs,
        now: () => fixture.clock.ms(),
        allowDrift: true,
      },
    );
    const grownSize = fs.statSync(fixture.transcriptPath).size;
    assert.ok(grownSize > fixture.transcriptSize);

    assert.throws(
      () => transport.beginClearSubmission(),
      (error) => error?.code === 'ECLEAR_CHECKPOINT',
    );

    const held = readJson(cyclePath(fixture));
    assert.equal(transport.state.state, 'HOLD:checkpoint-transcript-short');
    assert.equal(held.state, 'HOLD:checkpoint-transcript-short');
    assert.equal(held.hold.code, 'checkpoint-transcript-short');
    assert.equal(held.hold.detail.captured_offset, fixture.transcriptSize);
    assert.equal(held.hold.detail.stable_size, grownSize);
    assert.equal(held.hold.detail.resume_state, 'checkpoint-requested');
    assert.equal(held.clear_intent, null);
  } finally {
    destroyFixture(fixture);
  }
});

test('12. submission site re-checks kill switch and dropped pressure with exact refusal codes', () => {
  const killedFixture = makeFixture('submission-kill-switch');
  const pressureFixture = makeFixture('submission-pressure-drop');
  try {
    const killed = createTransport(killedFixture);
    primeCheckpointConfirmed(killed);
    const marker = writeAtomicFixtureText(
      path.join(killedFixture.memRoot, 'runtime', 'auto-clear-off'),
      'off\n',
      killedFixture,
    );

    assert.throws(
      () => killed.beginClearSubmission(),
      (error) => error?.code === 'ECLEAR_KILLED',
    );

    const killedState = readJson(cyclePath(killedFixture));
    assert.equal(killedState.state, 'HOLD:kill-switch-file');
    assert.equal(killedState.hold.code, 'kill-switch-file');
    assert.equal(killedState.hold.detail.value, marker);
    assert.equal(killedState.hold.detail.resume_state, 'checkpoint-confirmed');
    assert.equal(killedState.clear_intent, null);

    const pressure = createTransport(pressureFixture);
    primeCheckpointConfirmed(pressure);
    pressureFixture.pressure = { pct: 79, fresh: true, state: 'ok' };

    assert.throws(
      () => pressure.beginClearSubmission(),
      (error) => error?.code === 'ECLEAR_PRESSURE_DROPPED',
    );

    const reset = readJson(cyclePath(pressureFixture));
    assert.equal(reset.state, 'idle');
    assert.equal(reset.cycle_id, null);
    assert.equal(reset.boot_sequence_at_start, null);
    assert.equal(reset.clear_intent, null);
    assert.equal(reset.hold, null);
  } finally {
    destroyFixture(killedFixture);
    destroyFixture(pressureFixture);
  }
});

test('13. ambiguous hold resolves across restart from a fresh manual-clear receipt without resubmission', () => {
  const fixture = makeFixture('ambiguous-restart-resolution');
  let submissions = 0;
  try {
    const first = createTransport(fixture);
    primeCheckpointConfirmed(first);
    first.beginClearSubmission().submit(() => {
      submissions += 1;
      return 'automatic submission attempted';
    });
    assert.equal(readJson(cyclePath(fixture)).clear_intent.submitted, true);
    assert.equal(submissions, 1);

    const holding = createTransport(fixture);
    const ambiguous = holding.tick();
    assert.equal(ambiguous.state.state, 'HOLD:clear-ambiguous');
    assert.equal(ambiguous.state.hold.code, 'clear-ambiguous');
    assert.equal(ambiguous.state.hold.detail.resume_state, 'clear-submitted');
    assert.equal(ambiguous.action, undefined);

    const restarted = createTransport(fixture);
    assert.equal(restarted.state.state, 'HOLD:clear-ambiguous');
    assert.equal(restarted._inheritedIntent, true);
    assert.equal(restarted._activeToken, null);

    const receipt = {
      boot_sequence: 11,
      session_id: 'session-after-manual-clear',
      source: 'clear',
      observed_at: new Date(BASE_TIME + 5000).toISOString(),
    };
    writeAtomicFixtureJson(
      path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'),
      receipt,
      fixture,
    );

    const observed = restarted.tick();
    assert.equal(observed.state.state, 'released');
    assert.equal(observed.status, 'released');
    assert.equal(observed.transitioned, true);
    assert.equal(observed.action, undefined);
    assert.deepEqual(observed.observable, receipt);
    assert.equal(restarted._inheritedIntent, false);
    assert.equal(restarted._activeToken, null);
    assert.equal(submissions, 1);

    const persisted = readJson(cyclePath(fixture));
    assert.equal(persisted.state, 'released');
    assert.equal(persisted.hold, null);
    assert.equal(persisted.clear_intent.submitted, true);
    const steady = restarted.tick();
    assert.equal(steady.state.state, 'released');
    assert.equal(steady.transitioned, false);
    assert.equal(steady.action, undefined);
    assert.equal(submissions, 1);
    assert.throws(
      () => restarted.beginClearSubmission(),
      (error) => error?.code === 'EDUPLICATE_CLEAR',
    );
  } finally {
    destroyFixture(fixture);
  }
});

test('14. real selector default wiring authorizes a bound frontmatter capsule end to end', () => {
  const fixture = makeFixture('real-selector');
  try {
    writeAtomicFixtureText(
      fixture.capsulePath,
      '---\n'
        + 'id: real-selector\n'
        + 'status: active\n'
        + 'objective: "exercise the production selector"\n'
        + 'next_valid_action: "confirm checkpoint freshness"\n'
        + 'created_at: 2026-07-30T18:00:00.000Z\n'
        + '---\n\n'
        + '# Real selector fixture\n',
      fixture,
    );
    writeAtomicFixtureJson(
      path.join(fixture.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`),
      {
        offset: fixture.transcriptSize,
        capsule_path: fixture.capsulePath,
        last_delta_sha: 'real-selector-fixture',
      },
      fixture,
    );

    const transport = new AutoClearTransport({
      memRoot: fixture.memRoot,
      sessionId: SESSION_ID,
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      fsImpl: fs,
      now: fixture.clock,
      env: fixture.env,
      pressureThresholdPct: 80,
      pressureFreshnessMs: 120_000,
      readPressureFn: () => ({ ...fixture.pressure }),
      idFactory: () => `cycle-${fixture.name}`,
      log: (message) => fixture.logs.push(message),
      acquireLock: false,
    });

    assert.equal(transport.tick().state.state, 'pressure');
    const requested = transport.tick();
    assert.equal(requested.state.state, 'checkpoint-requested');
    assert.equal(requested.action, 'request-checkpoint');
    const confirmed = transport.tick();
    assert.equal(confirmed.state.state, 'checkpoint-confirmed');
    assert.equal(confirmed.status, 'checkpoint-confirmed');
    assert.equal(confirmed.observable.ok, true);
    assert.equal(confirmed.observable.capsule.path, fixture.capsulePath);
    assert.equal(confirmed.observable.capsule.id, 'real-selector');
    assert.equal(
      confirmed.observable.capsule.createdRaw,
      '2026-07-30T18:00:00.000Z',
    );
    assert.deepEqual(confirmed.observable.rejected, []);
    assert.equal(confirmed.observable.record.capsule_path, fixture.capsulePath);
    assert.equal(confirmed.observable.record.offset, fixture.transcriptSize);
    assert.equal(confirmed.observable.transcript.path, fixture.transcriptPath);
    assert.equal(confirmed.observable.transcript.size, fixture.transcriptSize);

    const token = transport.beginClearSubmission();
    assert.equal(token.cycle_id, `cycle-${fixture.name}`);
    const authorized = readJson(cyclePath(fixture));
    assert.equal(authorized.state, 'clear-submitted');
    assert.equal(authorized.clear_intent.submitted, false);
  } finally {
    destroyFixture(fixture);
  }
});

test('15. session-id regex source stays identical between transport and stop writer', () => {
  const transportSource = fs.readFileSync(
    path.join(DAEMONS, 'auto-clear-transport.mjs'),
    'utf8',
  );
  const writerSource = fs.readFileSync(
    path.join(DAEMONS, 'stop-capsule-writer.mjs'),
    'utf8',
  );
  const safeSessionId = transportSource.match(
    /\bconst\s+SAFE_SESSION_ID\s*=\s*\/(?<source>(?:\\.|[^/\r\n])+?)\/[dgimsuvy]*\s*;/,
  );
  const sidIsConstrained = writerSource.match(
    /\bconst\s+sidIsConstrained\s*=\s*\/(?<source>(?:\\.|[^/\r\n])+?)\/[dgimsuvy]*\.test\(rawSid\)\s*;/,
  );

  assert.ok(safeSessionId?.groups?.source, 'SAFE_SESSION_ID regex not found');
  assert.ok(
    sidIsConstrained?.groups?.source,
    'sidIsConstrained regex not found',
  );
  assert.equal(
    sidIsConstrained.groups.source,
    safeSessionId.groups.source,
  );
});
