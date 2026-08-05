// capsule-ack-trigger.test.mjs — the ack literal substitutes for telemetry
// FRESHNESS and for nothing else. The principal's event-driven design,
// 2026-08-04: the seat's own completion signal fires the cycle at the moment of
// maximal truth, instead of polling until independently-measured freshness
// windows happen to align (measured failure mode: checkpoint-confirmed with
// hold:null for a full 120s telemetry window, ~1,200 ticks, zero submissions).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutoClearTransport,
  CAPSULE_ACK_LITERAL,
  transcriptPathFor,
} from '../auto-clear-transport.mjs';
import { InputOwnershipTracker } from '../pty-runner.mjs';

const SESSION_ID = 'ack-test-session';
const ESC = String.fromCharCode(27);

function makeTransport({ pressure, nowMs }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-trigger-'));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const clock = { ms: nowMs };
  return {
    root,
    clock,
    transport: new AutoClearTransport({
      memRoot: root,
      sessionId: SESSION_ID,
      cwd: root,
      now: () => new Date(clock.ms),
      readPressureFn: () => pressure(),
      acquireLock: false,
    }),
  };
}

test('a stale reading with a number passes — context pressure is monotonic, staleness holds are deleted', () => {
  // The principal's ruling, 2026-08-05: no timers. A stale reading can only
  // UNDERSTATE live pressure (usage only grows within a session; the sensor
  // file is per-session), so it is always safe to act on. The old behavior —
  // stale-holds until the seat happens to speak — only ever DELAYED refreshes
  // that were already due, and on the reference seat it expired the capsule
  // ack mid-cycle, twice, eating operator nudges.
  const stale = makeTransport({
    pressure: () => ({ pct: 85, fresh: false, state: 'stale' }),
    nowMs: 1_000_000,
  });
  const after = stale.transport.tick();
  assert.ok(!String(after.state.state).startsWith('HOLD:telemetry'),
    `a stale reading over threshold starts the cycle — no ack required, no clock consulted (got ${after.state.state})`);
  assert.match(String(after.state.state), /HOLD:boot-receipt-missing/,
    'the tick proceeds to the next genuine gate; only the timer died');
});

test('LAW XV — each bound can independently go red', () => {
  // 1) MISSING telemetry is NOT rescued by an ack: no pct exists to hold the
  //    threshold against. The ack proves liveness, not pressure.
  const missing = makeTransport({
    pressure: () => ({ pct: null, fresh: false, state: 'missing' }),
    nowMs: 1_000_000,
  });
  missing.transport.noteCapsuleAck();
  const missingResult = missing.transport.tick();
  assert.match(String(missingResult.state.state), /HOLD:telemetry-missing/,
    'ack must never substitute for a missing observation');

  // 2) An AGED ack still stands — the principal's ruling (2026-08-05)
  //    deleted the expiry timer: the ack is cycle-scoped news. Past the old
  //    120s window the telemetry gate must still pass, and the tick proceeds
  //    to the NEXT real gate (boot receipt, absent in this fixture) —
  //    proving the timer bound is gone while the other bounds keep their
  //    teeth.
  const aged = makeTransport({
    pressure: () => ({ pct: 85, fresh: false, state: 'stale' }),
    nowMs: 1_000_000,
  });
  aged.transport.noteCapsuleAck();
  aged.clock.ms += 120_000 + 1;
  const agedResult = aged.transport.tick();
  assert.doesNotMatch(String(agedResult.state.state), /HOLD:telemetry/,
    'no clock invalidates the ack — the seat said it was ready, and context pressure only grows');
  assert.match(String(agedResult.state.state), /HOLD:boot-receipt-missing/,
    'the tick marches to the next genuine gate — the timer is the only thing deleted');

  // 3) pct below threshold is NOT rescued by an ack: ack-fresh still resolves
  //    below-pressure toward idle, never toward a clear.
  const below = makeTransport({
    pressure: () => ({ pct: 5, fresh: false, state: 'stale' }),
    nowMs: 1_000_000,
  });
  below.transport.noteCapsuleAck();
  const belowResult = below.transport.tick();
  assert.equal(belowResult.state.state, 'idle',
    'ack-fresh below threshold must resolve to idle, never toward a clear');
});

test('a new cycle discards the previous cycle ack', () => {
  const { transport } = makeTransport({
    pressure: () => ({ pct: 85, fresh: true, state: 'ok' }),
    nowMs: 1_000_000,
  });
  transport.noteCapsuleAck();
  const first = transport.tick();
  assert.ok(first.transitioned, `expected a cycle start, got ${first.state.state}`);
  assert.equal(transport._capsuleAckMs, null,
    'starting a cycle must clear any inherited ack');
});

// ── Input tracker: terminal reports are not operator input ────────────────────
test('focus and mouse reports are benign; arrows and unfinished sequences stay fail-closed', () => {
  const benign = [
    `${ESC}[I`,
    `${ESC}[O`,
    `${ESC}[<64;10;10M`,
    `${ESC}[<65;10;10m`,
    `\r${ESC}[I`,
  ];
  for (const bytes of benign) {
    const t = new InputOwnershipTracker();
    t.observe(bytes);
    const s = t.snapshot();
    assert.equal(s.knownEmpty, true, `benign must stay empty: ${JSON.stringify(bytes)}`);
    assert.equal(s.unknown, false, `benign must not read unknown: ${JSON.stringify(bytes)}`);
  }

  const poison = [
    `${ESC}[A`,
    `\r${ESC}[A`,
    `${ESC}[`,
    `${ESC}[<64;10;10`,
    'draft text',
  ];
  for (const bytes of poison) {
    const t = new InputOwnershipTracker();
    t.observe(bytes);
    assert.equal(t.snapshot().knownEmpty, false,
      `must stay fail-closed: ${JSON.stringify(bytes)}`);
  }

  // a draft typed BEFORE a benign report must remain a draft after it
  const t = new InputOwnershipTracker();
  t.observe(`draft${ESC}[I`);
  assert.equal(t.snapshot().knownEmpty, false,
    'a benign report must RESTORE prior state, not overwrite it with empty');
});

test('the ack literal is what the skill mandates — drift means the trigger never fires', () => {
  assert.equal(CAPSULE_ACK_LITERAL, 'Capsule Complete, Ready For Clear');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const skill = fs.readFileSync(
    path.join(here, '..', '..', 'skills', 'context-capsule', 'SKILL.md'),
    'utf8',
  );
  assert.ok(skill.includes(CAPSULE_ACK_LITERAL),
    'skills/context-capsule/SKILL.md must mandate the exact literal the sentinel watches');
});

// THE PRINCIPAL'S RULING, third telling (2026-08-05 12:47 AM PT, verbatim):
// "2 minutes first off is absurd, u take 5+ minutes to write a capsule
// sometimes longer. why is there a timer anyway, over engineered. ... trigger
// with capsule complete, ready for clear exact wording, ensure capsule exists
// then clear." Measured on the reference seat the same night: the capsule
// turn ran 2m7s — the ENTIRE freshness window — so the ack expired before
// the submit gates finished, twice, eating two operator nudges. Context
// usage is monotonic within a session: a stale reading only understates
// pressure. The ack is cycle-scoped news; no clock invalidates it.

test('the ack does not expire — the trigger has no timer', () => {
  const acked = makeTransport({
    pressure: () => ({ pct: 85, fresh: false, state: 'stale' }),
    nowMs: 1_000_000,
  });
  acked.transport.noteCapsuleAck();
  acked.clock.ms += 10 * 60_000; // a long capsule, a slow night — ten minutes
  const after = acked.transport.tick();
  assert.ok(
    !String(after.state.state).startsWith('HOLD:telemetry'),
    `the ack is cycle-scoped, not a 120s timer; ten minutes later it must still stand (got ${after.state.state})`,
  );
});

test('post-ack, the submission gate consults no telemetry clock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-submit-'));
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  // The capsule EXISTS and binds — the principal's step 2, kept with teeth:
  // running this test without these plants refuses ECLEAR_CHECKPOINT
  // (no-capsules-dir), ack or no ack.
  const capsulePath = path.join(root, 'capsules', 'current.md');
  fs.mkdirSync(path.dirname(capsulePath), { recursive: true });
  fs.writeFileSync(capsulePath, 'checkpoint fixture\n');
  const transcriptPath = transcriptPathFor({ cwd: root, sessionId: SESSION_ID, homeDir });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const transcript = '0123456789';
  fs.writeFileSync(transcriptPath, transcript);
  fs.mkdirSync(path.join(root, 'runtime', 'stop-writer'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'runtime', 'stop-writer', `${SESSION_ID}.json`),
    `${JSON.stringify({
      offset: Buffer.byteLength(transcript),
      capsule_path: capsulePath,
      last_delta_sha: 'fixture',
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'runtime', 'auto-clear-cycle.json'),
    `${JSON.stringify({
      state: 'checkpoint-confirmed',
      cycle_id: 'ack-cycle',
      session_id: SESSION_ID,
      boot_sequence_at_start: 7,
      clear_intent: null,
      entered_at: new Date(1_000_000).toISOString(),
      hold: null,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'runtime', 'boot-receipt.json'),
    `${JSON.stringify({
      boot_sequence: 7,
      session_id: SESSION_ID,
      source: 'startup',
      observed_at: new Date(1_000_000).toISOString(),
    }, null, 2)}\n`,
  );
  const clock = { ms: 1_000_000 };
  const transport = new AutoClearTransport({
    memRoot: root,
    sessionId: SESSION_ID,
    cwd: root,
    homeDir,
    now: () => new Date(clock.ms),
    readPressureFn: () => ({ pct: 85, fresh: false, state: 'stale' }),
    selectCapsuleFn: () => ({
      capsule: {
        path: capsulePath,
        id: 'current',
        created: 1_000_000,
        createdRaw: new Date(1_000_000).toISOString(),
      },
      rejected: [],
    }),
    acquireLock: false,
  });
  transport.noteCapsuleAck();
  clock.ms += 10 * 60_000;
  // At HEAD-before-the-fix this throws ECLEAR_TELEMETRY: the submission-time
  // pressure recheck ignored the ack and re-ran the staleness clock.
  const token = transport.beginClearSubmission();
  assert.ok(token && typeof token.submit === 'function',
    'with the ack standing and the capsule checkpoint confirmed, the clear submits — no telemetry clock applies');
});
