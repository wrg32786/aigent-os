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

test('ack substitutes for STALENESS only — stale+ack passes, stale alone holds', () => {
  const stale = makeTransport({
    pressure: () => ({ pct: 85, fresh: false, state: 'stale' }),
    nowMs: 1_000_000,
  });
  const held = stale.transport.tick();
  assert.match(String(held.state.state), /HOLD:telemetry-stale/,
    'without an ack, stale telemetry must hold exactly as before');

  const acked = makeTransport({
    pressure: () => ({ pct: 85, fresh: false, state: 'stale' }),
    nowMs: 1_000_000,
  });
  acked.transport.noteCapsuleAck();
  const after = acked.transport.tick();
  assert.ok(!String(after.state.state).startsWith('HOLD:telemetry'),
    `ack-fresh must clear the staleness hold, got ${after.state.state}`);
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

  // 2) An EXPIRED ack is no ack: past the freshness window the hold returns.
  const expired = makeTransport({
    pressure: () => ({ pct: 85, fresh: false, state: 'stale' }),
    nowMs: 1_000_000,
  });
  expired.transport.noteCapsuleAck();
  expired.clock.ms += 120_000 + 1;
  const expiredResult = expired.transport.tick();
  assert.match(String(expiredResult.state.state), /HOLD:telemetry-stale/,
    'an ack older than the freshness window must not read as fresh');

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
