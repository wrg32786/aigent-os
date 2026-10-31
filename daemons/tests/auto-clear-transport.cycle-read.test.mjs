// auto-clear-transport.cycle-read.test.mjs -- a failed read of the cycle file
// says nothing about what the file contains (issue #139).
//
// WHY THIS EXISTS: measured live 2026-10-30 07:17:50Z on the Titus seat. One
// readFileSync of a valid auto-clear-cycle.json threw "UNKNOWN: unknown error,
// read". _refreshState took that for corrupt content and persisted
// HOLD:cycle-state-invalid, which no branch of tick() exits and a relaunch
// loads as valid. Room delivery and automatic refresh stayed off for 32 hours,
// until the file was moved aside by hand. _loadState had the opposite fault:
// the same error at startup looked like a missing file and overwrote the
// durable state with a fresh idle.
//
// Each case asserts on the bytes on disk and on the actions taken, never on a
// status label alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoClearTransport, transcriptPathFor } from '../auto-clear-transport.mjs';

const CYCLE_FILE = 'auto-clear-cycle.json';
const SESSION_ID = 'session-current';
const BASE_TIME = Date.parse('2026-10-30T07:00:00.000Z');
const READ_ERROR = 'UNKNOWN: unknown error, read';

function controlledClock(start = BASE_TIME) {
  let milliseconds = start;
  const now = () => new Date(milliseconds);
  now.advance = (amount) => { milliseconds += amount; };
  now.ms = () => milliseconds;
  return now;
}

function writeText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

const writeJson = (target, value) => writeText(target, `${JSON.stringify(value, null, 2)}\n`);
const cyclePath = (fixture) => path.join(fixture.memRoot, 'runtime', CYCLE_FILE);
const diskText = (fixture) => fs.readFileSync(cyclePath(fixture), 'utf8');
const disk = (fixture) => JSON.parse(diskText(fixture));

function readFailure(code = 'UNKNOWN') {
  return Object.assign(new Error(`${code}: unknown error, read`), { code });
}

function makeFixture(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ccr-${name}-`));
  const memRoot = path.join(base, 'memory');
  const homeDir = path.join(base, 'home');
  const cwd = path.join(base, 'work', 'project');
  const clock = controlledClock();
  const capsulePath = writeText(path.join(memRoot, 'capsules', 'current.md'), 'checkpoint\n');
  const transcriptPath = transcriptPathFor({ cwd, sessionId: SESSION_ID, homeDir });
  const transcript = '0123456789';
  writeText(transcriptPath, transcript);
  writeJson(path.join(memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`), {
    offset: Buffer.byteLength(transcript),
    capsule_path: capsulePath,
    last_delta_sha: 'fixture',
  });
  writeJson(path.join(memRoot, 'runtime', 'boot-receipt.json'), {
    boot_sequence: 10,
    session_id: SESSION_ID,
    source: 'startup',
    observed_at: new Date(clock.ms()).toISOString(),
  });
  const fixture = {
    name,
    base,
    memRoot,
    homeDir,
    cwd,
    clock,
    logs: [],
    env: {},
    capsulePath,
    pressure: { pct: 90, fresh: true, state: 'ok' },
    unreadable: null,
    cycles: 0,
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
  // A real file that this process briefly cannot read. Only the cycle file
  // fails, and only reads: writes go through, so a wrong write is visible.
  fixture.fs = {
    ...fs,
    readFileSync(target, ...rest) {
      if (fixture.unreadable && path.resolve(String(target)) === path.resolve(cyclePath(fixture))) {
        throw readFailure(fixture.unreadable);
      }
      return fs.readFileSync(target, ...rest);
    },
  };
  return fixture;
}

function createTransport(fixture, overrides = {}) {
  return new AutoClearTransport({
    memRoot: fixture.memRoot,
    sessionId: SESSION_ID,
    cwd: fixture.cwd,
    homeDir: fixture.homeDir,
    fsImpl: fixture.fs,
    now: fixture.clock,
    env: fixture.env,
    pressureThresholdPct: 80,
    pressureFreshnessMs: 120_000,
    selectCapsuleFn: () => fixture.selection,
    readPressureFn: () => ({ ...fixture.pressure }),
    idFactory: () => {
      fixture.cycles += 1;
      return `cycle-${fixture.name}-${fixture.cycles}`;
    },
    log: (message) => fixture.logs.push(message),
    acquireLock: false,
    ...overrides,
  });
}

function withFixture(name, body) {
  const fixture = makeFixture(name);
  try {
    return body(fixture);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
}

function primeCheckpointConfirmed(transport) {
  assert.equal(transport.tick().state.state, 'pressure');
  assert.equal(transport.tick().state.state, 'checkpoint-requested');
  assert.equal(transport.tick().state.state, 'checkpoint-confirmed');
}

function legacyHold(fixture, {
  cycleId = null, clearIntent = null, bootAtStart = null, ackBoundary = null,
} = {}) {
  writeJson(cyclePath(fixture), {
    state: 'HOLD:cycle-state-invalid',
    cycle_id: cycleId,
    session_id: SESSION_ID,
    boot_sequence_at_start: bootAtStart,
    clear_intent: clearIntent,
    entered_at: new Date(fixture.clock.ms()).toISOString(),
    hold: { code: 'cycle-state-invalid', detail: { value: READ_ERROR, resume_state: 'idle' } },
    ack_boundary: ackBoundary,
    ack_classification: null,
  });
}

function assertUnreadable(result) {
  assert.equal(result.status, 'hold');
  assert.equal(result.code, 'cycle-state-unreadable');
  assert.equal(result.state.state, 'HOLD:cycle-state-unreadable');
  assert.equal(result.action, undefined, 'an unreadable state must not ask the runner to act');
}

test('ccr-1. the measured specimen: one failed read leaves the durable state exactly as it was and the seat recovers alone', () => withFixture('c1', (fixture) => {
  const transport = createTransport(fixture);
  assert.equal(transport.tick().state.state, 'pressure');
  const cycleId = disk(fixture).cycle_id;
  const before = diskText(fixture);

  fixture.unreadable = 'UNKNOWN';
  const deferred = transport.tick();
  assertUnreadable(deferred);
  assert.equal(deferred.state.cycle_id, cycleId, 'the runner keeps its evidence: same cycle');
  assert.equal(diskText(fixture), before, 'no byte of the durable state moved');

  fixture.unreadable = null;
  const resumed = transport.tick();
  assert.equal(resumed.state.state, 'checkpoint-requested');
  assert.equal(resumed.state.cycle_id, cycleId, 'the same cycle continues');
  assert.equal(disk(fixture).hold, null);
}));

for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EIO', 'EMFILE']) {
  test(`ccr-1b. ${code} is a failed read too, never evidence about content`, () => withFixture(`c1b${code}`, (fixture) => {
    const transport = createTransport(fixture);
    assert.equal(transport.tick().state.state, 'pressure');
    const before = diskText(fixture);
    fixture.unreadable = code;
    assertUnreadable(transport.tick());
    assert.equal(diskText(fixture), before);
  }));
}

test('ccr-2. startup: a failed read never overwrites the durable state with a fresh idle', () => withFixture('c2', (fixture) => {
  primeCheckpointConfirmed(createTransport(fixture));
  const before = diskText(fixture);
  const cycleId = disk(fixture).cycle_id;

  fixture.unreadable = 'UNKNOWN';
  const transport = createTransport(fixture);
  assert.equal(diskText(fixture), before, 'the constructor wrote over a file it could not read');
  assertUnreadable(transport.tick());
  assert.throws(() => transport.beginClearSubmission(), { code: 'ECYCLE_STATE_UNREADABLE' });
  assert.equal(diskText(fixture), before);

  fixture.unreadable = null;
  const resumed = transport.tick();
  assert.equal(resumed.state.cycle_id, cycleId, 'the cycle survived the relaunch');
  assert.equal(disk(fixture).cycle_id, cycleId);
}));

test('ccr-3. startup: an intent in a briefly unreadable file is still inherited, so no second clear is possible', () => withFixture('c3', (fixture) => {
  const first = createTransport(fixture);
  primeCheckpointConfirmed(first);
  first.beginClearSubmission().consume(() => ({ submitted: true }));
  const persisted = disk(fixture);
  assert.equal(persisted.clear_intent.submitted, true);

  fixture.unreadable = 'UNKNOWN';
  const relaunched = createTransport(fixture);
  fixture.unreadable = null;
  relaunched.tick();
  assert.deepEqual(disk(fixture).clear_intent, persisted.clear_intent);
  assert.throws(() => relaunched.beginClearSubmission(), { code: 'EDUPLICATE_CLEAR' });
  // Inherited, so a stale receipt lands in the ambiguity hold, not a silent refusal.
  const observed = relaunched.confirmClearObserved({
    boot_sequence: 10,
    session_id: SESSION_ID,
    source: 'startup',
    observed_at: new Date(fixture.clock.ms()).toISOString(),
  });
  assert.equal(observed.state.state, 'HOLD:clear-ambiguous');
}));

test('ccr-4. no clear can begin against an unreadable state, and the refusal writes no intent', () => withFixture('c4', (fixture) => {
  const transport = createTransport(fixture);
  primeCheckpointConfirmed(transport);
  const before = diskText(fixture);
  fixture.unreadable = 'UNKNOWN';
  assert.throws(() => transport.beginClearSubmission(), { code: 'ECYCLE_STATE_UNREADABLE' });
  assert.equal(diskText(fixture), before);
  fixture.unreadable = null;
  const token = transport.beginClearSubmission();
  assert.equal(disk(fixture).clear_intent.submitted, false, 'the clear proceeds once the state is verified');
  assert.ok(token.id);
}));

test('ccr-5. a token cannot submit against an unreadable state: nothing reaches the seat', () => withFixture('c5', (fixture) => {
  const transport = createTransport(fixture);
  primeCheckpointConfirmed(transport);
  const token = transport.beginClearSubmission();
  const before = diskText(fixture);
  let submitted = 0;
  fixture.unreadable = 'UNKNOWN';
  assert.throws(() => token.consume(() => { submitted += 1; }), { code: 'ECYCLE_STATE_UNREADABLE' });
  assert.equal(submitted, 0);
  assert.equal(diskText(fixture), before, 'submitted must stay false: nothing was submitted');
  assert.throws(() => token.consume(() => { submitted += 1; }), { code: 'EDUPLICATE_CLEAR' });
  assert.equal(submitted, 0);

  // No token is left to spend that intent, so it cannot be allowed to wait
  // for a relaunch: nothing was written, so the clear is simply decided again.
  fixture.unreadable = null;
  const withdrawn = transport.tick();
  assert.equal(withdrawn.status, 'clear-intent-withdrawn');
  assert.equal(disk(fixture).state, 'checkpoint-confirmed');
  assert.equal(disk(fixture).clear_intent, null);
  transport.beginClearSubmission().consume(() => { submitted += 1; });
  assert.equal(submitted, 1, 'exactly one clear, through the ordinary gates');
}));

test('ccr-5b. the refusal tells the runner no byte left, so it is never reported as a write that may have happened', () => withFixture('c5b', (fixture) => {
  const transport = createTransport(fixture);
  primeCheckpointConfirmed(transport);
  const token = transport.beginClearSubmission();
  fixture.unreadable = 'UNKNOWN';
  assert.throws(() => token.submit(() => {}), (error) => error.provableNoWrite === true);
}));

test('ccr-6. a clear receipt met during an unreadable read is not consumed; the same receipt verifies afterwards', () => withFixture('c6', (fixture) => {
  const transport = createTransport(fixture);
  primeCheckpointConfirmed(transport);
  transport.beginClearSubmission().consume(() => ({ submitted: true }));
  const before = diskText(fixture);
  const receipt = {
    boot_sequence: 11,
    session_id: 'session-after-clear',
    source: 'clear',
    observed_at: new Date(fixture.clock.ms() + 1000).toISOString(),
  };
  fixture.unreadable = 'UNKNOWN';
  assertUnreadable(transport.confirmClearObserved(receipt));
  assert.equal(diskText(fixture), before);
  fixture.unreadable = null;
  assert.equal(transport.confirmClearObserved(receipt).state.state, 'clear-verified');
}));

test('ccr-7. acknowledgement bookkeeping writes nothing while the state is unreadable', () => withFixture('c7', (fixture) => {
  const transport = createTransport(fixture);
  assert.equal(transport.tick().state.state, 'pressure');
  const cycleId = disk(fixture).cycle_id;
  transport.tick();
  const before = diskText(fixture);
  fixture.unreadable = 'UNKNOWN';
  assertUnreadable(transport.tick());
  transport.noteAckClassification({
    cycleId,
    classifiedThrough: 5,
    debtsOutstanding: 0,
    requestsIssued: 1,
    answersSettled: 0,
    pending: [],
    accepted: [],
  });
  assert.equal(diskText(fixture), before);
}));

test('ccr-8. a read that keeps failing stays deferred, logs a bounded number of lines, and never becomes a hold on disk', () => withFixture('c8', (fixture) => {
  const transport = createTransport(fixture);
  assert.equal(transport.tick().state.state, 'pressure');
  const before = diskText(fixture);
  fixture.unreadable = 'UNKNOWN';
  fixture.logs.length = 0;
  let last;
  for (let i = 0; i < 20_000; i += 1) {
    fixture.clock.advance(100);
    last = transport.tick();
  }
  assertUnreadable(last);
  assert.equal(last.detail.attempts, 20_000);
  assert.equal(last.detail.escalated, true, 'the persistent case must read differently from a blip');
  assert.equal(last.detail.error, 'UNKNOWN');
  assert.ok(fixture.logs.length <= 3, `log lines: ${fixture.logs.length}`);
  assert.equal(diskText(fixture), before);
  fixture.unreadable = null;
  assert.equal(transport.tick().state.state, 'checkpoint-requested');
  assert.ok(fixture.logs.some((line) => /cycle state readable again/.test(line)));
}));

test('ccr-9. the wedge already on disk: a persisted read-error hold with nothing pending recovers, in process and at startup', () => {
  withFixture('c9a', (fixture) => {
    legacyHold(fixture);
    fixture.pressure.pct = 10;
    const recovered = createTransport(fixture).tick();
    assert.equal(recovered.status, 'cycle-hold-recovered');
    assert.equal(disk(fixture).state, 'idle');
    assert.equal(disk(fixture).hold, null);
  });
  withFixture('c9b', (fixture) => {
    const transport = createTransport(fixture);
    fixture.pressure.pct = 10;
    transport.tick();
    legacyHold(fixture);
    assert.equal(transport.tick().status, 'cycle-hold-recovered');
    assert.equal(disk(fixture).state, 'idle');
  });
});

test('ccr-10. a persisted hold that carries an intent never goes to idle: the clear-ambiguous hold owns it and no second clear runs', () => withFixture('c10', (fixture) => {
  legacyHold(fixture, {
    cycleId: 'cycle-inflight',
    bootAtStart: 10,
    clearIntent: { written_at: new Date(fixture.clock.ms()).toISOString(), submitted: true },
  });
  const transport = createTransport(fixture);
  const held = transport.tick();
  assert.equal(held.state.state, 'HOLD:clear-ambiguous');
  assert.equal(disk(fixture).clear_intent.submitted, true);
  assert.equal(disk(fixture).cycle_id, 'cycle-inflight');
  assert.throws(() => transport.beginClearSubmission());

  // The evidence the ambiguity hold already accepts: same session, later boot.
  writeJson(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), {
    boot_sequence: 11,
    session_id: SESSION_ID,
    source: 'resume',
    observed_at: new Date(fixture.clock.ms() + 1000).toISOString(),
  });
  assert.equal(createTransport(fixture).tick().state.state, 'idle');
}));

test('ccr-11. recovering a held cycle spends no old acknowledgement: the next cycle needs its own', () => withFixture('c11', (fixture) => {
  const transport = createTransport(fixture);
  assert.equal(transport.tick().state.state, 'pressure');
  const oldCycle = disk(fixture).cycle_id;
  transport.noteCapsuleAck({ cycleId: oldCycle });
  legacyHold(fixture, { cycleId: oldCycle, bootAtStart: 10, ackBoundary: { offset: 3 } });

  const recovered = transport.tick();
  assert.equal(recovered.status, 'cycle-hold-recovered');
  assert.equal(disk(fixture).state, 'idle');
  assert.equal(disk(fixture).cycle_id, null);
  assert.equal(disk(fixture).ack_boundary, null);
  assert.equal(transport._capsuleAckMs, null, 'the old ack was retired, not carried');
  const next = transport.tick();
  assert.equal(next.state.state, 'pressure');
  assert.notEqual(next.state.cycle_id, oldCycle);
}));

test('ccr-12. corrupt content stays held in the process that met it and is revalidated by the next one', () => withFixture('c12', (fixture) => {
  const transport = createTransport(fixture);
  assert.equal(transport.tick().state.state, 'pressure');
  fs.writeFileSync(cyclePath(fixture), '{"state": "press');
  const held = transport.tick();
  assert.equal(held.state.state, 'HOLD:cycle-state-invalid');
  for (let i = 0; i < 3; i += 1) {
    assert.equal(transport.tick().state.state, 'HOLD:cycle-state-invalid', 'content is not a blip');
  }
  fixture.pressure.pct = 10;
  const next = createTransport(fixture);
  assert.equal(next.tick().status, 'cycle-hold-recovered');
  assert.equal(disk(fixture).state, 'idle');
}));

test('ccr-13. corrupt content at startup holds closed in that process; only a later process revalidates it', () => withFixture('c13', (fixture) => {
  writeText(cyclePath(fixture), 'not json');
  fixture.pressure.pct = 10;
  const transport = createTransport(fixture);
  assert.equal(transport.state.state, 'HOLD:cycle-state-invalid');
  assert.equal(transport.tick().state.state, 'HOLD:cycle-state-invalid');
  assert.equal(createTransport(fixture).tick().state.state, 'idle');
}));

test('ccr-14. a recovered hold under the kill switch starts nothing', () => withFixture('c14', (fixture) => {
  legacyHold(fixture);
  writeText(path.join(fixture.memRoot, 'runtime', 'auto-clear-off'), 'off\n');
  const transport = createTransport(fixture);
  transport.tick();
  const result = transport.tick();
  assert.equal(result.status, 'refused');
  assert.equal(disk(fixture).cycle_id, null);
}));
