// auto-clear-transport.cand5-rebind.test.mjs -- candidate-5 transport fix.
//
// WHY THIS EXISTS: a measured, permanent wedge across an
// operator /clear.  sessionId binds once at session-bind (pty-runner.mjs); an
// idle session goes HOLD:telemetry-stale/-missing by design (the 120s
// freshness window on ~/.claude/ctx-refresh/<sid>.json).  When that happens
// with no pressure cycle ever anchored (boot_sequence_at_start is null), the
// HOLD:telemetry-* branch re-evaluates only _pressureObservable() at the
// dead sessionId forever: the old session's telemetry can never freshen, the
// new session's telemetry is never read.  A boot receipt proving a later,
// different session cleared is real news regardless of telemetry state and
// must un-wedge the transport.
//
// Each case below asserts on the mechanism's own observable (transport's
// live sessionId, and the persisted cycle state's session_id /
// boot_sequence_at_start) -- never on a status label alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoClearTransport, transcriptPathFor } from '../auto-clear-transport.mjs';
import { readPressure } from '../ctx-telemetry.mjs';

const SESSION_ID = 'session-current';
const NEW_SESSION = 'session-after-clear';
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

function makeFixture(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `cand5-${name}-`));
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
  const transcriptPath = transcriptPathFor({ cwd, sessionId: SESSION_ID, homeDir });
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

function writeClearReceipt(fixture, { sessionId, bootSequence }) {
  fixture.clock.advance(1000);
  writeJson(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), {
    boot_sequence: bootSequence,
    session_id: sessionId,
    source: 'clear',
    observed_at: new Date(fixture.clock.ms()).toISOString(),
  });
}

function writeFreshTelemetry(fixture, sessionId, pct) {
  const target = writeJson(
    path.join(fixture.homeDir, '.claude', 'ctx-refresh', `${sessionId}.json`),
    { used_percentage: pct, ts: new Date(fixture.clock.ms()).toISOString() },
  );
  const stamp = new Date(fixture.clock.ms());
  fs.utimesSync(target, stamp, stamp);
  return target;
}

function primeCheckpointConfirmed(transport) {
  assert.equal(transport.tick().state.state, 'pressure');
  const requested = transport.tick();
  assert.equal(requested.state.state, 'checkpoint-requested');
  assert.equal(transport.tick().state.state, 'checkpoint-confirmed');
}

// RED VECTOR -----------------------------------------------------------
//
// At 53885b4 this must fail for the wedge reason: transport.sessionId stays
// the dead session and the cycle state never leaves HOLD:telemetry-missing.

test('cand5-1. telemetry wedge: a fresh operator clear rebinds sessionId and un-wedges from HOLD:telemetry-*', () => {
  const fixture = makeFixture('wedge');
  try {
    const transport = createTransport(fixture, { readPressureFn: readPressure });

    const held = transport.tick();
    assert.equal(held.state.state, 'HOLD:telemetry-missing', 'wedge precondition: idle telemetry-missing');
    assert.equal(held.state.boot_sequence_at_start, null, 'wedge precondition: no pressure cycle ever anchored a baseline');
    assert.equal(transport.sessionId, SESSION_ID, 'still bound to the dead session before the clear receipt arrives');

    writeClearReceipt(fixture, { sessionId: NEW_SESSION, bootSequence: 11 });

    const recovered = transport.tick();
    assert.notEqual(recovered.state.state, 'HOLD:telemetry-missing', 'the operator clear must un-wedge the transport');
    assert.equal(recovered.state.state, 'idle', 'un-wedge resolves to idle so ordinary machinery resumes');
    assert.equal(transport.sessionId, NEW_SESSION, "mechanism's own observable: sessionId itself must rebind -- a status label alone does not prove this");
    assert.equal(recovered.state.session_id, NEW_SESSION, 'persisted cycle state carries the new session');
    assert.equal(recovered.state.boot_sequence_at_start, null, 'baseline resets so the next pressure cycle re-anchors fresh');

    // Prove the NEW session's telemetry is what actually becomes observable,
    // not just that a transition/status label fired.
    writeFreshTelemetry(fixture, NEW_SESSION, 90);
    const afterRebind = transport.tick();
    assert.equal(afterRebind.state.state, 'pressure', "ticking again must read the NEW session's telemetry and proceed normally");
    assert.equal(afterRebind.state.session_id, NEW_SESSION);
    assert.equal(afterRebind.state.boot_sequence_at_start, 11, 'the pressure cycle anchors against the receipt that triggered the rebind');
  } finally {
    destroyFixture(fixture);
  }
});

// NEGATIVE CONTROLS ------------------------------------------------------

test('cand5-2. same session_id: a receipt for the currently bound session is not news and must not rebind', () => {
  const fixture = makeFixture('same-session');
  try {
    const transport = createTransport(fixture, { readPressureFn: readPressure });
    assert.equal(transport.tick().state.state, 'HOLD:telemetry-missing');

    writeClearReceipt(fixture, { sessionId: SESSION_ID, bootSequence: 11 });

    const after = transport.tick();
    assert.equal(after.state.state, 'HOLD:telemetry-missing', 'no session change means no news; telemetry hold is a defence, not a duplicate');
    assert.equal(after.transitioned, false, 'a repeated identical hold must not write a transition');
    assert.equal(transport.sessionId, SESSION_ID);
  } finally {
    destroyFixture(fixture);
  }
});

test('cand5-3. invalid receipt: a boot receipt failing bootReceiptProblem() must never trigger a rebind', () => {
  const fixture = makeFixture('invalid-receipt');
  try {
    const transport = createTransport(fixture, { readPressureFn: readPressure });
    assert.equal(transport.tick().state.state, 'HOLD:telemetry-missing');

    fixture.clock.advance(1000);
    writeJson(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), {
      boot_sequence: 11,
      session_id: NEW_SESSION,
      // source deliberately omitted: bootReceiptProblem() must reject this.
      observed_at: new Date(fixture.clock.ms()).toISOString(),
    });

    const after = transport.tick();
    assert.equal(after.state.state, 'HOLD:telemetry-missing', 'an invalid receipt is never news; reuse bootReceiptProblem(), never a second parser');
    assert.equal(transport.sessionId, SESSION_ID, 'no rebind on an invalid receipt');
  } finally {
    destroyFixture(fixture);
  }
});

test('cand5-4. replayed receipt: boot_sequence <= the recorded baseline must not rebind', () => {
  const fixture = makeFixture('old-receipt');
  try {
    const transport = createTransport(fixture);
    assert.equal(transport.tick().state.state, 'pressure');
    assert.equal(transport.tick().state.state, 'checkpoint-requested');
    assert.equal(transport.state.boot_sequence_at_start, 10, 'anchored from the initial boot receipt');

    fixture.pressure = { pct: null, fresh: false, state: 'missing' };
    const held = transport.tick();
    assert.equal(held.state.state, 'HOLD:telemetry-missing');
    assert.equal(held.state.hold.detail.resume_state, 'checkpoint-requested');
    assert.equal(held.state.boot_sequence_at_start, 10, 'the baseline survives the hold');

    // A different session's receipt arrives, but AT the baseline: replayed,
    // not real news.
    writeClearReceipt(fixture, { sessionId: NEW_SESSION, bootSequence: 10 });

    const after = transport.tick();
    assert.equal(after.state.state, 'HOLD:telemetry-missing', 'boot_sequence <= baseline must not rebind, even with a different session_id');
    assert.equal(transport.sessionId, SESSION_ID);
  } finally {
    destroyFixture(fixture);
  }
});

// POSITIVE CONTROL --------------------------------------------------------

test('cand5-5. no-clear path: the ordinary checkpoint -> clear-submitted -> released cycle is unaffected', () => {
  const fixture = makeFixture('happy-path');
  try {
    const transport = createTransport(fixture);
    primeCheckpointConfirmed(transport);
    const token = transport.beginClearSubmission();
    token.submit(() => 'submitted');

    writeClearReceipt(fixture, { sessionId: NEW_SESSION, bootSequence: 11 });

    const first = transport.tick();
    assert.equal(first.state.state, 'clear-verified');
    const second = transport.tick();
    assert.equal(second.state.state, 'released');
    assert.equal(
      transport.sessionId,
      SESSION_ID,
      'this core does not rebind sessionId on the automated clear-submitted path; that stays the caller\'s job',
    );
  } finally {
    destroyFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// cand5-5 — THE DEADLOCK IN THE cand5-1 FIX ITSELF.
//
// Found live on a reference seat 2026-08-04. cand5-1 un-wedges only on
// `boot.receipt.source === 'clear'`. But the transport IS the thing that
// initiates clears, so a transport wedged in HOLD:telemetry-* can never
// produce the one event its own recovery requires. Any operator who RESTARTS
// a wedged seat instead of clearing it stays wedged forever — and a restart is
// what a real user does when a seat looks stuck.
//
// The receipt is the authority on which session is live. A different session
// with a strictly later boot_sequence is real news whether it arrived by
// 'clear', 'startup', or 'resume'. The three negative controls above
// (same-session, invalid-receipt, replayed-boot_sequence) are what keep this
// honest, and they must all stay green.

function writeRestartReceipt(fixture, { sessionId, bootSequence, source = 'startup' }) {
  fixture.clock.advance(1000);
  writeJson(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), {
    boot_sequence: bootSequence,
    session_id: sessionId,
    source,
    observed_at: new Date(fixture.clock.ms()).toISOString(),
  });
}

test('cand5-6. RESTART wedge: a later, different session must rebind even when the receipt is not a clear', () => {
  const fixture = makeFixture('restart-wedge');
  try {
    const transport = createTransport(fixture, { readPressureFn: readPressure });

    const held = transport.tick();
    assert.equal(held.state.state, 'HOLD:telemetry-missing', 'wedge precondition: idle telemetry-missing');
    assert.equal(held.state.boot_sequence_at_start, null, 'wedge precondition: no pressure cycle ever anchored');
    assert.equal(transport.sessionId, SESSION_ID, 'still bound to the dead session');

    // The operator did NOT clear — they exited and relaunched, which is what a
    // real user does with a seat that looks stuck.
    writeRestartReceipt(fixture, { sessionId: NEW_SESSION, bootSequence: 11, source: 'startup' });

    const recovered = transport.tick();
    assert.equal(transport.sessionId, NEW_SESSION, "mechanism's own observable: a restart into a NEW session must rebind sessionId, or a wedged seat can never recover without the clear it cannot issue");
    assert.equal(recovered.state.session_id, NEW_SESSION, 'persisted state carries the new session');
    assert.notEqual(recovered.state.state, 'HOLD:telemetry-missing', 'the restart must un-wedge the transport');
    assert.equal(recovered.state.state, 'idle', 'un-wedge resolves to idle so ordinary machinery resumes');

    // Prove the NEW session's telemetry is what becomes observable.
    writeFreshTelemetry(fixture, NEW_SESSION, 90);
    const afterRebind = transport.tick();
    assert.equal(afterRebind.state.state, 'pressure', "the NEW session's telemetry must drive the next cycle");
    assert.equal(afterRebind.state.boot_sequence_at_start, 11, 'the cycle anchors on the receipt that triggered the rebind');
  } finally {
    destroyFixture(fixture);
  }
});
