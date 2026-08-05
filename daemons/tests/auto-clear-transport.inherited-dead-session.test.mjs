// auto-clear-transport.inherited-dead-session.test.mjs -- the RELAUNCH wedge:
// an inherited cycle bound to a session that no longer exists.
//
// WHY THIS EXISTS (2026-08-04, Ada's reference seat, nine relaunches, repro
// task bi1nr3kvs on a scratch seat at c29807b): a cycle persisted by a
// PREVIOUS runner stays bound to that runner's session_id. After a relaunch
// the new runner binds this.sessionId to the LIVE session, so:
//   1. the cand5 rebind (HOLD:telemetry-* branch) compares the receipt
//      against this.sessionId -- receipt and binding are now EQUAL, so the
//      rebind can never fire. cand5 only covers a session change while the
//      runner stays alive (an operator /clear mid-run).
//   2. the c29807b boot rebase requires the receipt's session to EQUAL the
//      persisted cycle's session -- a relaunch into a new session never
//      matches. Different-session recovery was delegated to cand5, which
//      is structurally dead post-restart (see 1).
//   3. _checkpointObservable() keys the stop-writer record to
//      this.state.session_id -- the DEAD session -- a file that will never
//      be written. On a busy seat (telemetry fresh) the cycle loops
//      checkpoint-requested -> HOLD:checkpoint-record-missing forever; on
//      an idle one it parks in HOLD:telemetry-stale. Typing freshens the
//      LIVE session's telemetry and can never release the DEAD binding --
//      measured live by the principal ("i will type and telemetry still
//      says stale").
//
// The missing invariant: a cycle bound to a dead session, with NO clear
// intent, is SUPERSEDED the moment a valid boot receipt proves this
// runner's live session at a strictly newer boot_sequence than the
// inherited baseline. Reset to idle bound to the live session; live
// pressure starts a fresh cycle. Never resume an inherited checkpoint into
// a submit the live session never confirmed (Rule 30). An inherited
// clear_intent keeps its original binding and resolves through the
// clear-ambiguous path.
//
// Each case asserts on the mechanism's own observable -- the persisted
// state's session_id -- never on a status label alone.
//
// Run: node --test daemons/tests/auto-clear-transport.inherited-dead-session.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoClearTransport, transcriptPathFor } from '../auto-clear-transport.mjs';
import { readPressure } from '../ctx-telemetry.mjs';

const LIVE_SESSION = 'session-live-relaunch';
const DEAD_SESSION = 'session-dead-prior';
const BASE_TIME = Date.parse('2026-08-04T20:00:00.000Z');

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

function writeJson(target, value) {
  return writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

// The fixture models the seat AFTER a relaunch: the LIVE session owns the
// boot receipt, the transcript, and the stop-writer record; the DEAD
// session owns nothing but the inherited cycle state on disk.
function makeFixture(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ids-${name}-`));
  const memRoot = path.join(base, 'memory');
  const homeDir = path.join(base, 'home');
  const cwd = path.join(base, 'work', 'project');
  const clock = controlledClock();
  const logs = [];
  const capsulePath = writeText(
    path.join(memRoot, 'capsules', 'current.md'),
    'checkpoint fixture\n',
  );
  const transcriptPath = transcriptPathFor({ cwd, sessionId: LIVE_SESSION, homeDir });
  const transcript = '0123456789';
  writeText(transcriptPath, transcript);
  writeJson(
    path.join(memRoot, 'runtime', 'stop-writer', `${LIVE_SESSION}.json`),
    {
      offset: Buffer.byteLength(transcript),
      capsule_path: capsulePath,
      last_delta_sha: 'fixture',
    },
  );
  writeJson(path.join(memRoot, 'runtime', 'boot-receipt.json'), {
    boot_sequence: 4,
    session_id: LIVE_SESSION,
    // A RELAUNCH, not an operator clear -- the receipt an operator's restart
    // actually produces.
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
    capsulePath,
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

// The inherited cycle exactly as the repro planted it: born under the dead
// session at boot 1, mid-flight in checkpoint-requested, no clear intent.
function plantInheritedCycle(fixture, overrides = {}) {
  writeJson(path.join(fixture.memRoot, 'runtime', 'auto-clear-cycle.json'), {
    state: 'checkpoint-requested',
    cycle_id: `PLANT:1:${new Date(BASE_TIME - 3_600_000).toISOString()}`,
    session_id: DEAD_SESSION,
    boot_sequence_at_start: 1,
    clear_intent: null,
    entered_at: new Date(BASE_TIME - 3_600_000).toISOString(),
    hold: null,
    ...overrides,
  });
}

function createTransport(fixture) {
  return new AutoClearTransport({
    memRoot: fixture.memRoot,
    sessionId: LIVE_SESSION,
    cwd: fixture.cwd,
    homeDir: fixture.homeDir,
    fsImpl: fs,
    now: fixture.clock,
    env: {},
    pressureThresholdPct: 80,
    pressureFreshnessMs: 120_000,
    selectCapsuleFn: () => fixture.selection,
    readPressureFn: readPressure,
    idFactory: () => `cycle-${fixture.name}`,
    log: (message) => fixture.logs.push(message),
    acquireLock: false,
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

// RED VECTOR ---------------------------------------------------------------
//
// At c29807b this fails for the wedge reason: the first tick lands in
// HOLD:checkpoint-record-missing with state.session_id still the dead
// session, and no number of ticks changes that.

test('ids-1. relaunch wedge: an inherited dead-session cycle is superseded by a valid startup receipt for the live session', () => {
  const fixture = makeFixture('wedge');
  try {
    plantInheritedCycle(fixture);
    writeFreshTelemetry(fixture, LIVE_SESSION, 90);
    const transport = createTransport(fixture);

    assert.equal(transport.state.session_id, DEAD_SESSION, 'wedge precondition: the persisted cycle is bound to the dead session');
    assert.equal(transport.sessionId, LIVE_SESSION, 'wedge precondition: the relaunched runner is bound to the LIVE session, so the cand5 rebind (receipt vs this.sessionId) can never fire');

    const first = transport.tick();
    assert.equal(first.state.session_id, LIVE_SESSION, "mechanism's own observable: the persisted binding must move to the live session -- at c29807b it stays the dead session and the checkpoint record it demands can never be written");
    assert.equal(first.state.state, 'idle', 'the inherited cycle is superseded to idle -- never resumed into a checkpoint the live session did not confirm');
    assert.equal(first.state.cycle_id, null, 'the dead cycle id is gone');
    assert.equal(first.state.boot_sequence_at_start, null, 'the baseline resets so the next cycle re-anchors on the live receipt');
    assert.equal(first.state.clear_intent, null);

    // The live session now runs its OWN full path to checkpoint-confirmed --
    // proof the seat can finish what the dead cycle never could.
    const second = transport.tick();
    assert.equal(second.state.state, 'pressure', "live pressure starts a FRESH cycle from the live session's telemetry");
    assert.equal(second.state.session_id, LIVE_SESSION);
    assert.equal(second.state.boot_sequence_at_start, 4, 'the fresh cycle anchors on the live receipt');
    assert.equal(transport.tick().state.state, 'checkpoint-requested');
    const confirmed = transport.tick();
    assert.equal(confirmed.state.state, 'checkpoint-confirmed', "the LIVE session's stop-writer record satisfies the checkpoint -- the dead session's record was the unfillable demand");
  } finally {
    destroyFixture(fixture);
  }
});

// NEGATIVE CONTROLS --------------------------------------------------------

test('ids-2. inherited clear_intent: ambiguity protection outranks supersede -- the cycle keeps its original binding and goes clear-ambiguous', () => {
  const fixture = makeFixture('intent');
  try {
    plantInheritedCycle(fixture, {
      clear_intent: {
        written_at: new Date(BASE_TIME - 3_500_000).toISOString(),
        submitted: false,
      },
    });
    writeFreshTelemetry(fixture, LIVE_SESSION, 90);
    const transport = createTransport(fixture);

    const after = transport.tick();
    assert.equal(after.state.session_id, DEAD_SESSION, 'an inherited intent keeps its original binding -- superseding it would erase evidence of a possibly-submitted clear');
    assert.equal(after.state.state, 'HOLD:clear-ambiguous', 'the existing ambiguity hold owns this case');
  } finally {
    destroyFixture(fixture);
  }
});

test('ids-3. invalid receipt: a boot receipt failing bootReceiptProblem() never supersedes the inherited cycle', () => {
  const fixture = makeFixture('invalid-receipt');
  try {
    plantInheritedCycle(fixture);
    writeFreshTelemetry(fixture, LIVE_SESSION, 90);
    writeJson(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), {
      boot_sequence: 4,
      session_id: LIVE_SESSION,
      // source deliberately omitted: bootReceiptProblem() must reject this.
      observed_at: new Date(fixture.clock.ms()).toISOString(),
    });
    const transport = createTransport(fixture);

    const after = transport.tick();
    assert.equal(after.state.session_id, DEAD_SESSION, 'an invalid receipt is never news; reuse bootReceiptProblem(), never a second parser');
    assert.notEqual(after.state.state, 'idle', 'no supersede on an invalid receipt');
  } finally {
    destroyFixture(fixture);
  }
});

test('ids-4. replayed receipt: boot_sequence <= the inherited baseline never supersedes, even for the live session', () => {
  const fixture = makeFixture('replayed');
  try {
    plantInheritedCycle(fixture, { boot_sequence_at_start: 4 });
    writeFreshTelemetry(fixture, LIVE_SESSION, 90);
    const transport = createTransport(fixture);

    const after = transport.tick();
    assert.equal(after.state.session_id, DEAD_SESSION, 'receipt boot_sequence equal to the baseline is replayed history, not news');
    assert.notEqual(after.state.state, 'idle', 'no supersede on a replayed receipt');
  } finally {
    destroyFixture(fixture);
  }
});

// POSITIVE CONTROL ---------------------------------------------------------

test('ids-5. same-session inherited cycle: the c29807b boot rebase still owns this case -- the cycle CONTINUES, never superseded', () => {
  const fixture = makeFixture('same-session');
  try {
    plantInheritedCycle(fixture, { session_id: LIVE_SESSION });
    writeFreshTelemetry(fixture, LIVE_SESSION, 90);
    const transport = createTransport(fixture);

    const after = transport.tick();
    assert.equal(after.state.session_id, LIVE_SESSION);
    assert.equal(after.state.boot_sequence_at_start, 4, 'the rebase leg re-anchors the SAME-session cycle to the current receipt');
    assert.equal(after.state.state, 'checkpoint-confirmed', "the same-session cycle keeps going and confirms against the live session's own record -- it is inherited but not dead, so it must NOT be superseded");
    assert.equal(after.state.cycle_id, `PLANT:1:${new Date(BASE_TIME - 3_600_000).toISOString()}`, 'the original cycle id survives -- proof no supersede fired');
  } finally {
    destroyFixture(fixture);
  }
});

// R26 F9: the two state-guards on the supersede leg, each with a control
// that can fail if the guard is deleted.

test('ids-6. released state and third-party receipts stay outside the supersede', () => {
  // (a) A released cycle from the dead session keeps its own
  // new-session-idle path — deleting the released guard would reroute it
  // through the supersede and erase the distinct status.
  const fixture = makeFixture('outside');
  try {
    plantInheritedCycle(fixture, { state: 'released' });
    writeFreshTelemetry(fixture, LIVE_SESSION, 90);
    const transport = createTransport(fixture);
    const result = transport.tick();
    assert.equal(result.status, 'new-session-idle', "released keeps its own path; 'inherited-cycle-superseded' here means the guard is gone");
    assert.equal(result.state.state, 'idle');
    assert.equal(result.state.session_id, LIVE_SESSION);
  } finally {
    destroyFixture(fixture);
  }
});

test('ids-7. a receipt naming a THIRD session (neither persisted nor live) never supersedes', () => {
  const fixture = makeFixture('third-party');
  try {
    plantInheritedCycle(fixture);
    writeJson(path.join(fixture.memRoot, 'runtime', 'boot-receipt.json'), {
      boot_sequence: 9,
      session_id: 'session-third-party',
      source: 'startup',
      observed_at: new Date(fixture.clock.ms()).toISOString(),
    });
    const transport = createTransport(fixture);
    const result = transport.tick();
    assert.equal(result.state.session_id, DEAD_SESSION, "a third-party receipt is not proof of THIS runner's live session");
    assert.notEqual(result.state.state, 'idle', 'no supersede without a receipt for the bound live session');
  } finally {
    destroyFixture(fixture);
  }
});
