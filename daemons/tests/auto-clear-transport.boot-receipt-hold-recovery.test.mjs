// auto-clear-transport.boot-receipt-hold-recovery.test.mjs -- the headless
// probe overwrite and its recovery.
//
// WHY THIS EXISTS: measured live 2026-09-24 on a reference seat. A nightly
// probes job spawned headless `claude` sessions from the vault. Their
// SessionStart hook (sessionstart-reinject.mjs -> boot-receipt.mjs) resolved
// the LIVE seat's memory root and overwrote runtime/boot-receipt.json with a
// foreign session_id. When the managed runner next reached the pressure
// threshold, _startPressure() held boot-receipt-session-mismatch from idle --
// correctly -- but only HOLD:kill-switch / HOLD:telemetry-* /
// HOLD:checkpoint-* / HOLD:clear-ambiguous had recovery branches. Every
// boot-receipt hold fell into the generic re-report branch forever, survived
// a relaunch into the same session (the inherited-cycle reset needs a
// DIFFERENT session_id), and restoring the correct receipt changed nothing.
// The operator had to reset auto-clear-cycle.json by hand.
//
// Each case asserts on the mechanism's own observables (persisted state,
// cycle_id, boot_sequence_at_start, the transport's bound sessionId, and the
// files on disk) -- never on a status label alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AutoClearTransport, transcriptPathFor } from '../auto-clear-transport.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONSTART = path.join(__dirname, '..', 'sessionstart-reinject.mjs');
const CYCLE_FILE = 'auto-clear-cycle.json';
const SESSION_ID = 'session-current';
const PROBE_SESSION = 'headless-probe-session';
const OTHER_SESSION = 'yet-another-session';
const BASE_TIME = Date.parse('2026-09-24T02:00:00.000Z');

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

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function receiptPath(fixture) {
  return path.join(fixture.memRoot, 'runtime', 'boot-receipt.json');
}

function cyclePath(fixture) {
  return path.join(fixture.memRoot, 'runtime', CYCLE_FILE);
}

function makeFixture(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `brh-${name}-`));
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

function writeReceipt(fixture, { sessionId, bootSequence, source = 'startup' }) {
  fixture.clock.advance(1000);
  writeJson(receiptPath(fixture), {
    boot_sequence: bootSequence,
    session_id: sessionId,
    source,
    observed_at: new Date(fixture.clock.ms()).toISOString(),
  });
}

// The live sequence: the runner bound to SESSION_ID at boot 10, then a
// headless probe's SessionStart hook overwrote the receipt before pressure
// crossed the threshold.
function primeProbeOverwriteHold(fixture, transport) {
  writeReceipt(fixture, { sessionId: PROBE_SESSION, bootSequence: 11 });
  const held = transport.tick();
  assert.equal(held.state.state, 'HOLD:boot-receipt-session-mismatch');
  assert.equal(held.state.hold.detail.expected, SESSION_ID);
  assert.equal(held.state.hold.detail.observed, PROBE_SESSION);
  assert.equal(held.state.hold.detail.resume_state, 'idle');
  assert.equal(held.state.cycle_id, null, 'no cycle may start on foreign evidence');
  assert.equal(held.state.boot_sequence_at_start, null);
  assert.equal(held.state.session_id, SESSION_ID);
  return held;
}

function primeCheckpointConfirmed(transport) {
  assert.equal(transport.tick().state.state, 'pressure');
  assert.equal(transport.tick().state.state, 'checkpoint-requested');
  assert.equal(transport.tick().state.state, 'checkpoint-confirmed');
}

// (a) THE WEDGE ------------------------------------------------------------

test('brh-1. a foreign receipt written while the runner is bound holds pressure start, starts no cycle, and survives a same-session relaunch', () => {
  const fixture = makeFixture('wedge');
  try {
    const transport = createTransport(fixture);
    primeProbeOverwriteHold(fixture, transport);

    const again = transport.tick();
    assert.equal(again.state.state, 'HOLD:boot-receipt-session-mismatch', 'the same evidence keeps the same hold');
    assert.equal(again.transitioned, false, 'a repeated identical hold must not write a transition');
    assert.equal(again.state.cycle_id, null);
    assert.equal(transport.sessionId, SESSION_ID, 'the bound session never rebinds to the probe');

    // The observed defect: a relaunch into the SAME session inherits the hold
    // and, with the receipt still foreign, must stay held -- the relaunch is
    // not evidence, the receipt is.
    const relaunched = createTransport(fixture);
    const inherited = relaunched.tick();
    assert.equal(inherited.state.state, 'HOLD:boot-receipt-session-mismatch');
    assert.equal(inherited.state.cycle_id, null);
    assert.equal(readJson(cyclePath(fixture)).state, 'HOLD:boot-receipt-session-mismatch');
  } finally {
    destroyFixture(fixture);
  }
});

// (b) THE RECOVERY GATE ----------------------------------------------------

test('brh-2. the hold lifts ONLY on a valid receipt for the bound session; another session or a malformed receipt keeps it', () => {
  const fixture = makeFixture('gate');
  try {
    const transport = createTransport(fixture);
    primeProbeOverwriteHold(fixture, transport);

    // Yet another foreign session, newer boot: still not the bound session.
    writeReceipt(fixture, { sessionId: OTHER_SESSION, bootSequence: 12 });
    const stillForeign = transport.tick();
    assert.equal(stillForeign.state.state, 'HOLD:boot-receipt-session-mismatch');
    assert.equal(stillForeign.state.cycle_id, null);
    assert.equal(transport.sessionId, SESSION_ID, 'a later foreign session must not rebind from this hold');

    // Malformed: the bound session_id but no source field.
    fixture.clock.advance(1000);
    writeJson(receiptPath(fixture), {
      boot_sequence: 13,
      session_id: SESSION_ID,
      observed_at: new Date(fixture.clock.ms()).toISOString(),
    });
    const malformed = transport.tick();
    assert.equal(malformed.state.state, 'HOLD:boot-receipt-field-missing', 'the hold tracks the receipt problem it sees, and stays a hold');
    assert.deepEqual(malformed.state.hold.detail.fields, ['source']);
    assert.equal(malformed.state.hold.detail.resume_state, 'idle');
    assert.equal(malformed.state.cycle_id, null);

    // Corrupt text, then no file at all: both stay held.
    fs.writeFileSync(receiptPath(fixture), '{corrupt\n');
    assert.equal(transport.tick().state.state, 'HOLD:boot-receipt-invalid');
    fs.rmSync(receiptPath(fixture));
    assert.equal(transport.tick().state.state, 'HOLD:boot-receipt-missing');
    assert.equal(readJson(cyclePath(fixture)).cycle_id, null);

    // The correct evidence returns: a valid receipt for the bound session.
    writeReceipt(fixture, { sessionId: SESSION_ID, bootSequence: 14 });
    const recovered = transport.tick();
    assert.equal(recovered.state.state, 'pressure', 'pressure is still above threshold, so the cycle starts naturally');
    assert.equal(recovered.transitioned, true);
    assert.equal(recovered.state.hold, null);
    assert.equal(recovered.state.cycle_id, `cycle-${fixture.name}`);
    assert.equal(recovered.state.session_id, SESSION_ID);
    assert.equal(recovered.state.boot_sequence_at_start, 14, 'the cycle anchors on the restored receipt');
    assert.equal(transport.sessionId, SESSION_ID);
    assert.match(fixture.logs.join('\n'), /HOLD:boot-receipt-missing released: receipt for bound session/);

    const next = transport.tick();
    assert.equal(next.state.state, 'checkpoint-requested', 'the recovered cycle proceeds through the ordinary machinery');
    assert.equal(next.action, 'request-checkpoint');
  } finally {
    destroyFixture(fixture);
  }
});

test('brh-3. recovery with pressure gone returns to idle and starts nothing until pressure returns', () => {
  const fixture = makeFixture('below');
  try {
    const transport = createTransport(fixture);
    primeProbeOverwriteHold(fixture, transport);

    fixture.pressure = { pct: 40, fresh: true, state: 'ok' };
    writeReceipt(fixture, { sessionId: SESSION_ID, bootSequence: 12 });
    const recovered = transport.tick();
    assert.equal(recovered.state.state, 'idle');
    assert.equal(recovered.status, 'boot-receipt-recovered');
    assert.equal(recovered.transitioned, true);
    assert.equal(recovered.state.hold, null);
    assert.equal(recovered.state.cycle_id, null);
    assert.equal(recovered.state.boot_sequence_at_start, null);
    assert.equal(recovered.observable.pct, 40);

    const steady = transport.tick();
    assert.equal(steady.state.state, 'idle');
    assert.equal(steady.transitioned, false);

    fixture.pressure = { pct: 90, fresh: true, state: 'ok' };
    const started = transport.tick();
    assert.equal(started.state.state, 'pressure');
    assert.equal(started.state.boot_sequence_at_start, 12);
  } finally {
    destroyFixture(fixture);
  }
});

test('brh-4. same-session relaunch after the operator restores the receipt recovers without touching the cycle file by hand', () => {
  const fixture = makeFixture('relaunch');
  try {
    const first = createTransport(fixture);
    primeProbeOverwriteHold(fixture, first);
    first.close?.();

    // The operator restores the live session's receipt, then relaunches the
    // runner into the SAME session. Before the fix this stayed held forever:
    // the inherited-cycle reset needs a different session_id and no other
    // branch re-read the receipt.
    writeReceipt(fixture, { sessionId: SESSION_ID, bootSequence: 12 });
    const relaunched = createTransport(fixture);
    assert.equal(relaunched.state.state, 'HOLD:boot-receipt-session-mismatch', 'the hold is inherited from disk');
    const recovered = relaunched.tick();
    assert.equal(recovered.state.state, 'pressure');
    assert.equal(recovered.state.session_id, SESSION_ID);
    assert.equal(recovered.state.boot_sequence_at_start, 12);
    assert.equal(readJson(cyclePath(fixture)).state, 'pressure');
  } finally {
    destroyFixture(fixture);
  }
});

// (c) OPERATOR CLEAR UNCHANGED ---------------------------------------------

test('brh-5. an operator clear still verifies and releases as before, and a clear for a foreign session does not lift the receipt hold', () => {
  const ordinary = makeFixture('operator-clear');
  const held = makeFixture('foreign-clear');
  try {
    const transport = createTransport(ordinary);
    primeCheckpointConfirmed(transport);
    assert.equal(transport.state.boot_sequence_at_start, 10);
    transport.beginClearSubmission().submit(() => 'automatic submission attempted');
    assert.equal(readJson(cyclePath(ordinary)).state, 'clear-submitted');

    writeReceipt(ordinary, { sessionId: 'session-after-clear', bootSequence: 11, source: 'clear' });
    const verified = transport.tick();
    assert.equal(verified.state.state, 'clear-verified');
    assert.equal(verified.observable.boot_sequence, 11);
    assert.equal(transport.tick().state.state, 'released');
    assert.equal(transport.sessionId, SESSION_ID, 'this core does not rebind on the automated clear path; the runner does');

    // From the receipt hold, a clear that minted a different session is not
    // evidence for the bound session: the hold stays, the runner's own
    // rebind (a new transport) is the path out -- exactly as before.
    const heldTransport = createTransport(held);
    primeProbeOverwriteHold(held, heldTransport);
    writeReceipt(held, { sessionId: 'session-after-clear', bootSequence: 12, source: 'clear' });
    const after = heldTransport.tick();
    assert.equal(after.state.state, 'HOLD:boot-receipt-session-mismatch');
    assert.equal(after.state.cycle_id, null);
    assert.equal(heldTransport.sessionId, SESSION_ID);
  } finally {
    destroyFixture(ordinary);
    destroyFixture(held);
  }
});

// (3) HOOK-LEVEL ISOLATION --------------------------------------------------
//
// The supported lever for a headless job launched from a live seat:
// AIGENT_STATE_HOME_DIR diverts lifecycle-common.memRoot() before the passed
// root is considered, so the hook's boot receipt (and every other hook write)
// lands in a disposable tree. The control run below reproduces the defect
// mechanism itself: without the lever the hook overwrites the live receipt.

function snapshotTree(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else entries.set(path.relative(root, target), fs.readFileSync(target, 'utf8'));
    }
  };
  walk(root);
  return entries;
}

function makeLiveSeat(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `brh-hook-${name}-`));
  const liveRoot = path.join(base, 'live-seat');
  const liveMem = path.join(liveRoot, 'vault', 'memory');
  writeJson(path.join(liveMem, 'runtime', 'boot-receipt.json'), {
    boot_sequence: 10,
    session_id: SESSION_ID,
    source: 'startup',
    observed_at: new Date(BASE_TIME).toISOString(),
  });
  writeText(path.join(liveMem, 'SESSION_LOG.md'), '# log\n\n## live seat entry\n');
  const divertRoot = path.join(base, 'disposable-state');
  fs.mkdirSync(divertRoot, { recursive: true });
  return { base, liveRoot, liveMem, divertRoot };
}

function runSessionStart(liveRoot, extraEnv) {
  const env = { ...process.env, AIGENT_ROOT: liveRoot };
  delete env.AIGENT_STATE_HOME_DIR;
  delete env.AIGENT_COORDINATION_STATE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SESSIONSTART], {
    input: JSON.stringify({ source: 'startup', session_id: PROBE_SESSION, cwd: liveRoot }),
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 30_000,
  });
}

test('brh-6. a headless run with AIGENT_STATE_HOME_DIR writes its boot receipt to the diverted tree and leaves the live root byte-identical', () => {
  const seat = makeLiveSeat('diverted');
  try {
    const before = snapshotTree(seat.liveRoot);
    const run = runSessionStart(seat.liveRoot, { AIGENT_STATE_HOME_DIR: seat.divertRoot });
    assert.equal(run.status, 0, run.stderr);

    const after = snapshotTree(seat.liveRoot);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file appears or disappears under the live root');
    for (const [relative, content] of before) {
      assert.equal(after.get(relative), content, `${relative} must be untouched`);
    }
    const live = readJson(path.join(seat.liveMem, 'runtime', 'boot-receipt.json'));
    assert.equal(live.session_id, SESSION_ID);
    assert.equal(live.boot_sequence, 10);

    const diverted = readJson(path.join(seat.divertRoot, 'vault', 'memory', 'runtime', 'boot-receipt.json'));
    assert.equal(diverted.session_id, PROBE_SESSION, 'the probe receipt lands in the diverted tree');
    assert.equal(diverted.source, 'startup');
  } finally {
    fs.rmSync(seat.base, { recursive: true, force: true });
  }
});

test('brh-6 control. without the lever the same headless run overwrites the live receipt -- the measured defect mechanism', () => {
  const seat = makeLiveSeat('control');
  try {
    const run = runSessionStart(seat.liveRoot, {});
    assert.equal(run.status, 0, run.stderr);
    const live = readJson(path.join(seat.liveMem, 'runtime', 'boot-receipt.json'));
    assert.equal(live.session_id, PROBE_SESSION, 'the live receipt now names the probe session');
    assert.equal(live.boot_sequence, 11);
    assert.equal(fs.existsSync(path.join(seat.divertRoot, 'vault')), false);
  } finally {
    fs.rmSync(seat.base, { recursive: true, force: true });
  }
});
