// seat-status.test.cjs — table tests for the adapter's status()/presence leg.
// Run: node pantheon-adapter/seat-status.test.cjs (exit 0 = PASS)
'use strict';

const assert = require('node:assert/strict');
const { deriveSeatState, gatherSeatStatus, isHumanLive } = require('./seat-status.cjs');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok: ${name}`); }
  catch (e) { failed++; console.log(`FAIL: ${name} — ${e.message}`); }
};

// ── deriveSeatState precedence ──────────────────────────────────────────────
check('revoked wins over everything', () =>
  assert.equal(deriveSeatState({ liveSid: 'x', currentRunId: 'r', suspended: true, revoked: true, refreshWindow: true }), 'revoked'));
check('suspended wins over refresh/work', () =>
  assert.equal(deriveSeatState({ liveSid: 'x', currentRunId: 'r', suspended: true, refreshWindow: true }), 'suspended'));
check('refreshWindow is explicit, never inferred', () =>
  assert.equal(deriveSeatState({ liveSid: 'x', currentRunId: 'r', refreshWindow: true }), 'refreshing'));
check('live sid + run = working', () =>
  assert.equal(deriveSeatState({ liveSid: 'x', currentRunId: 'r' }), 'working'));
check('live sid without run = idle', () =>
  assert.equal(deriveSeatState({ liveSid: 'x', currentRunId: null }), 'idle'));
check('no live session = idle (advisory; board leases stay the claim predicate)', () =>
  assert.equal(deriveSeatState({ liveSid: null, currentRunId: null }), 'idle'));

// ── gatherSeatStatus: frozen shape + degradation ────────────────────────────
check('frozen 4-field shape without presence reader (older runtime)', () => {
  const s = gatherSeatStatus({ seatId: 'rev', contextEpoch: 3, deps: {} });
  assert.deepEqual(Object.keys(s).sort(), ['contextEpoch', 'currentRunId', 'seatId', 'state']);
  assert.equal(s.presence, undefined);
});
check('throwing deps degrade safe: null sid, no run, state idle', () => {
  const boom = () => { throw new Error('io'); };
  const s = gatherSeatStatus({ seatId: 'rev', deps: { discoverLiveSid: boom, currentRun: boom, flags: boom } });
  assert.equal(s.state, 'idle');
  assert.equal(s.currentRunId, null);
});
check('presence attaches verbatim from the donor reader', () => {
  const s = gatherSeatStatus({ seatId: 'rev', deps: { readHumanPresence: () => ({ state: 'OCCUPIED', reason: 'recent-input', last_human_input_age_ms: 1200, observed_age_ms: 900 }) } });
  assert.deepEqual(s.presence, { state: 'OCCUPIED', reason: 'recent-input', last_human_input_age_ms: 1200, observed_age_ms: 900 });
});
check('presence reader THROWING surfaces UNKNOWN with the real reason, never vanishes', () => {
  const s = gatherSeatStatus({ seatId: 'rev', deps: { readHumanPresence: () => { throw new Error('EACCES'); } } });
  assert.equal(s.presence.state, 'UNKNOWN');
  assert.match(s.presence.reason, /EACCES/);
});
check('malformed presence state coerces to UNKNOWN, not to a permitting value', () => {
  const s = gatherSeatStatus({ seatId: 'rev', deps: { readHumanPresence: () => ({ state: 'idle' /* wrong case */ }) } });
  assert.equal(s.presence.state, 'UNKNOWN');
});

// ── isHumanLive: fail-closed mapping (true = BLOCK) ─────────────────────────
check('absent presence field blocks', () =>
  assert.equal(isHumanLive({ seatId: 'x', state: 'idle', currentRunId: null, contextEpoch: 0 }), true));
check('UNKNOWN blocks', () =>
  assert.equal(isHumanLive({ presence: { state: 'UNKNOWN', reason: 'no-file' } }), true));
check('OCCUPIED blocks', () =>
  assert.equal(isHumanLive({ presence: { state: 'OCCUPIED', reason: 'recent-input' } }), true));
check('confirmed IDLE alone permits', () =>
  assert.equal(isHumanLive({ presence: { state: 'IDLE', reason: 'observer-fresh-idle' } }), false));
check('null/garbage status blocks', () => {
  assert.equal(isHumanLive(null), true);
  assert.equal(isHumanLive({ presence: 'yes' }), true);
});

console.log(failed ? `SEAT-STATUS.TEST: FAIL (${failed})` : 'SEAT-STATUS.TEST: PASS');
process.exit(failed ? 1 : 0);
