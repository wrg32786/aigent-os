// #151: a busy transcript must not close ordinary delivery indefinitely.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import * as core from '../auto-clear-transport.mjs';

const SESSION_ID = 'session-current';
const BASE_TIME = Date.parse('2026-11-02T14:12:00Z');
// Fixed operational expectations also let these tests run against the old core.
const WAIT_MS = 300_000;
const COOLDOWN_MS = 300_000;
const scratch = path.resolve(import.meta.dirname, '../../.scratch');
const writeJson = (target, value) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
};
const disk = (f) => JSON.parse(fs.readFileSync(f.cyclePath, 'utf8'));

function withFixture(body) {
  fs.mkdirSync(scratch, { recursive: true });
  const base = fs.mkdtempSync(path.join(scratch, 'checkpoint-starvation-'));
  let ms = BASE_TIME;
  const clock = () => new Date(ms);
  clock.advance = (amount) => { ms += amount; };
  clock.ms = () => ms;
  const f = {
    base, clock, logs: [], cycles: 0,
    memRoot: path.join(base, 'memory'), homeDir: path.join(base, 'home'),
    cwd: path.join(base, 'work'),
    pressure: { pct: 90, fresh: true, state: 'ok' },
  };
  f.cyclePath = path.join(f.memRoot, 'runtime', 'auto-clear-cycle.json');
  f.capsulePath = path.join(f.memRoot, 'capsules', 'current.md');
  fs.mkdirSync(path.dirname(f.capsulePath), { recursive: true });
  fs.writeFileSync(f.capsulePath, 'checkpoint\n');
  f.transcriptPath = core.transcriptPathFor({ ...f, sessionId: SESSION_ID });
  fs.mkdirSync(path.dirname(f.transcriptPath), { recursive: true });
  fs.writeFileSync(f.transcriptPath, '0123456789');
  f.recordPath = path.join(f.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`);
  f.healthy = () => writeJson(f.recordPath, {
    offset: fs.statSync(f.transcriptPath).size, capsule_path: f.capsulePath,
  });
  f.busy = () => fs.appendFileSync(f.transcriptPath, 'x'.repeat(core.CHECKPOINT_TAIL_TOLERANCE_BYTES + 1));
  f.boot = (sessionId = SESSION_ID, sequence = 10, source = 'startup') => writeJson(
    path.join(f.memRoot, 'runtime', 'boot-receipt.json'),
    { session_id: sessionId, boot_sequence: sequence, source, observed_at: clock().toISOString() },
  );
  f.healthy();
  f.boot();
  f.create = (overrides = {}) => new core.AutoClearTransport({
    ...f, sessionId: SESSION_ID, now: clock, fsImpl: fs, env: {}, acquireLock: false,
    readPressureFn: () => ({ ...f.pressure }),
    selectCapsuleFn: () => ({ capsule: { path: f.capsulePath }, rejected: [] }),
    idFactory: () => `cycle-${++f.cycles}`, log: (line) => f.logs.push(line),
    ...overrides,
  });
  try { body(f); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

function request(t) {
  assert.equal(t.tick().state.state, 'pressure');
  assert.equal(t.tick().action, 'request-checkpoint');
}

function abandon(f, t) {
  request(t);
  f.busy();
  assert.equal(t.tick().state.state, 'HOLD:checkpoint-transcript-short');
  f.clock.advance(WAIT_MS);
  const result = t.tick();
  assert.equal(result.state.state, 'idle');
  assert.equal(result.status, 'cycle-abandoned-checkpoint-timeout');
  return result;
}

test('busy seat abandons at the bound, persists evidence, and logs exactly once', () => withFixture((f) => {
  let t = f.create();
  request(t);
  const cycleId = disk(f).cycle_id;
  for (let i = 0; i < 5; i += 1) {
    f.busy();
    assert.equal(t.tick().state.state, 'HOLD:checkpoint-transcript-short');
    f.clock.advance(WAIT_MS / 5);
    if (i === 2) t = f.create(); // Restart must not reset the deadline or count.
  }
  const result = t.tick();
  assert.equal(result.state.state, 'idle');
  assert.equal(result.abandoned_cycle_id, cycleId);
  const state = disk(f);
  assert.equal(state.abandoned_cycle_id, cycleId);
  assert.equal(state.checkpoint_wait_attempts, 6);
  assert.equal(state.checkpoint_retry_after, new Date(f.clock.ms() + COOLDOWN_MS).toISOString());
  assert.equal(state.cycle_id, null);
  assert.equal(state.clear_intent, null);
  assert.equal(state.ack_boundary, null);
  assert.equal(state.ack_classification, null);
  assert.throws(() => t.beginClearSubmission(), { code: 'ECLEAR_NOT_AUTHORIZED' });
  t.tick();
  const lines = f.logs.filter((line) => line.includes('cycle-abandoned-checkpoint-timeout'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cycle=cycle-1.*hold=checkpoint-transcript-short.*elapsed_ms=300000.*attempts=6/);
}));

test('cooldown survives restart, stays idle with high pressure, and retries at its boundary', () => withFixture((f) => {
  assert.equal(core.CHECKPOINT_WAIT_TIMEOUT_MS, WAIT_MS);
  assert.equal(core.CHECKPOINT_RETRY_COOLDOWN_MS, COOLDOWN_MS);
  let t = f.create();
  abandon(f, t);
  t = f.create();
  for (let i = 0; i < 10; i += 1) assert.equal(t.tick().state.state, 'idle');
  f.clock.advance(COOLDOWN_MS - 1);
  assert.equal(t.tick().state.state, 'idle');
  assert.equal(f.cycles, 1);
  f.clock.advance(1);
  request(t);
  assert.equal(f.cycles, 2);
  f.healthy();
  assert.equal(t.tick().state.state, 'checkpoint-confirmed');
}));

test('healthy checkpoint just inside the bound confirms without abandonment', () => withFixture((f) => {
  const t = f.create();
  request(t);
  f.busy();
  t.tick();
  f.clock.advance(WAIT_MS - 1);
  f.healthy();
  assert.equal(t.tick().state.state, 'checkpoint-confirmed');
  t.beginClearSubmission().submit(() => {});
  assert.equal(disk(f).clear_intent.submitted, true);
  assert.equal(f.logs.some((line) => line.includes('cycle-abandoned-checkpoint-timeout')), false);
}));

test('checkpoint-requested itself expires before any clear intent is issued', () => withFixture((f) => {
  const t = f.create();
  request(t);
  f.clock.advance(WAIT_MS);
  assert.equal(t.tick().state.state, 'idle');
  assert.match(f.logs.join('\n'), /hold=checkpoint-requested/);
}));

test('changing checkpoint holds does not renew the waiting budget', () => withFixture((f) => {
  const t = f.create();
  request(t);
  f.busy();
  t.tick();
  f.clock.advance(WAIT_MS - 1);
  fs.rmSync(f.recordPath);
  assert.equal(t.tick().state.state, 'HOLD:checkpoint-record-missing');
  f.clock.advance(1);
  assert.equal(t.tick().state.state, 'idle');
}));

test('legacy checkpoint hold gets a bounded deadline from its persisted entry time', () => withFixture((f) => {
  const t = f.create();
  request(t);
  f.busy();
  t.tick();
  const legacy = disk(f);
  delete legacy.checkpoint_wait_started_at;
  delete legacy.checkpoint_wait_attempts;
  writeJson(f.cyclePath, legacy);
  f.clock.advance(WAIT_MS);
  assert.equal(f.create().tick().state.state, 'idle');
}));

test('a proven new session ends the cooldown', () => withFixture((f) => {
  abandon(f, f.create());
  f.boot('session-new', 11);
  const rebound = f.create({ sessionId: 'session-new' });
  assert.equal(rebound.tick().status, 'inherited-cycle-superseded');
  assert.equal(disk(f).checkpoint_retry_after, null);
  assert.equal(rebound.tick().state.state, 'pressure');
}));

test('late abandoned-cycle acknowledgement cannot authorize the next cycle', () => withFixture((f) => {
  const t = f.create();
  const old = abandon(f, t).abandoned_cycle_id;
  assert.equal(t._capsuleAckMs, null);
  fs.appendFileSync(f.transcriptPath, `\n${core.CAPSULE_ACK_LITERAL}\n`);
  const oldAnswerEnd = fs.statSync(f.transcriptPath).size;
  t.noteCapsuleAck({ cycleId: old });
  f.clock.advance(COOLDOWN_MS);
  request(t);
  const next = disk(f);
  assert.notEqual(next.cycle_id, old);
  assert.equal(next.ack_boundary.transcript_offset, oldAnswerEnd);
  assert.equal(core.capsuleAckBoundaryProblem(next, { sessionId: SESSION_ID, cycleId: old }).code,
    'ack-boundary-cycle-mismatch');
  // Also reject a late callback arriving AFTER the new cycle opened.
  t.noteCapsuleAck({ cycleId: old });
  assert.equal(t.noteAckClassification({ cycleId: old, classifiedThrough: oldAnswerEnd,
    debtsOutstanding: 0, requestsIssued: 1, answersSettled: 1 }), null);
  assert.equal(t.tick().state.state, 'HOLD:checkpoint-transcript-short');
  assert.equal(disk(f).ack_classification, null);
  assert.throws(() => t.beginClearSubmission(), { code: 'ECLEAR_NOT_AUTHORIZED' });
  // Positive control: the live cycle's own acknowledgement still works.
  t.noteCapsuleAck({ cycleId: next.cycle_id });
  assert.equal(t.tick().state.state, 'checkpoint-confirmed');
}));

test('normal refresh still submits once, verifies a new clear receipt, and releases', () => withFixture((f) => {
  const t = f.create();
  request(t);
  assert.equal(t.tick().state.state, 'checkpoint-confirmed');
  let submissions = 0;
  const token = t.beginClearSubmission();
  token.submit(() => { submissions += 1; });
  f.clock.advance(WAIT_MS * 2);
  assert.equal(t.tick().state.state, 'clear-submitted');
  assert.throws(() => token.submit(() => { submissions += 1; }), { code: 'EDUPLICATE_CLEAR' });
  f.boot('after-clear', 11, 'clear');
  assert.equal(t.tick().state.state, 'clear-verified');
  assert.equal(t.tick().state.state, 'released');
  assert.equal(submissions, 1);
  assert.equal(f.logs.some((line) => line.includes('cycle-abandoned-checkpoint-timeout')), false);
}));

test('an unconsumed clear token remains live after the checkpoint budget', () => withFixture((f) => {
  const t = f.create();
  request(t);
  t.tick();
  const token = t.beginClearSubmission();
  const intent = disk(f).clear_intent;
  f.clock.advance(WAIT_MS * 10);
  assert.equal(t.tick().state.state, 'clear-submitted');
  assert.deepEqual(disk(f).clear_intent, intent);
  let submissions = 0;
  token.submit(() => { submissions += 1; });
  assert.equal(submissions, 1, 'elapsed time was never evidence that the token could not run');
}));

test('an unreadable cycle at the deadline cannot be overwritten by abandonment', () => withFixture((f) => {
  let unreadable = false;
  const t = f.create({ fsImpl: { ...fs, readFileSync(target, ...args) {
    if (unreadable && path.resolve(String(target)) === f.cyclePath) {
      throw Object.assign(new Error('EIO: failed read'), { code: 'EIO' });
    }
    return fs.readFileSync(target, ...args);
  } } });
  request(t);
  f.busy();
  t.tick();
  const before = fs.readFileSync(f.cyclePath, 'utf8');
  f.clock.advance(WAIT_MS);
  unreadable = true;
  assert.equal(t.tick().code, 'cycle-state-unreadable');
  assert.equal(fs.readFileSync(f.cyclePath, 'utf8'), before);
  unreadable = false;
  assert.equal(t.tick().state.state, 'idle');
}));

test('recovery from an idle telemetry hold cannot bypass the cooldown', () => withFixture((f) => {
  const t = f.create();
  abandon(f, t);
  writeJson(f.cyclePath, { ...disk(f), state: 'HOLD:telemetry-missing',
    hold: { code: 'telemetry-missing', detail: { resume_state: 'idle' } },
  });
  assert.equal(t.tick().state.state, 'idle');
  assert.equal(f.cycles, 1);
  assert.equal(t.tick().state.state, 'idle');
}));

for (const state of ['checkpoint-requested', 'HOLD:checkpoint-transcript-short',
  'checkpoint-confirmed', 'clear-submitted', 'HOLD:clear-ambiguous', 'clear-verified', 'released']) {
  for (const submitted of [false, true]) {
    test(`no timeout abandonment with intent: ${state}, submitted=${submitted}`, () => withFixture((f) => {
      const t = f.create();
      request(t);
      const intent = { written_at: f.clock().toISOString(), submitted };
      writeJson(f.cyclePath, { ...disk(f), state, clear_intent: intent,
        hold: state.startsWith('HOLD:')
          ? { code: state.slice(5), detail: { resume_state: 'checkpoint-requested' } } : null,
      });
      f.clock.advance(WAIT_MS * 10);
      const restarted = f.create();
      restarted.tick();
      assert.notEqual(disk(f).state, 'idle');
      assert.equal(disk(f).cycle_id, 'cycle-1');
      assert.deepEqual(disk(f).clear_intent, intent);
      assert.equal(f.logs.some((line) => line.includes('cycle-abandoned-checkpoint-timeout')), false);
      assert.throws(() => restarted.beginClearSubmission(), { code: 'EDUPLICATE_CLEAR' });
    }));
  }
}
