'use strict';

// refresh-request.test.mjs — seat request-intake (challenge crossing).
// Run: node --test daemons/tests/refresh-request.test.mjs
//
// Proves: RefreshRequest round-trips; a present, unexpired request drives the
// autofire worker to stamp a 'prepared' seat cycle whose challenge_digest is
// 'sha256:'+sha256(challenge) (the seat authors NO nonce); absent / expired /
// malformed requests fail CLOSED (refuse, no stamp); and the dryRun default stamps
// nothing live.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import {
  createRequest, writeRequest, readRequest, requestPath,
} from '../refresh-request.mjs';
import { readCycleRecord, cycleRecordPath } from '../refresh-cycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SENSOR = path.resolve(__dirname, '..', 'ctx-refresh-sensor.mjs');
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SEAT_ID = 'operator';

function mkSeat(parent = os.tmpdir(), { git = false } = {}) {
  const base = mkdtempSync(path.join(parent, '.rr-seat-'));
  const root = path.join(base, 'test-seat');
  const memory = path.join(root, 'memory');
  mkdirSync(path.join(memory, 'capsules'), { recursive: true });
  mkdirSync(path.join(memory, 'runtime', 'stop-writer'), { recursive: true });
  writeFileSync(path.join(memory, 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  if (git) {
    const cfg = ['-c', 'user.name=rr-fixture', '-c', 'user.email=rr-fixture@test.local'];
    execFileSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
    writeFileSync(path.join(root, 'seed.txt'), 'refresh-request fixture seed\n');
    execFileSync('git', ['-C', root, ...cfg, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', root, ...cfg, 'commit', '-q', '-m', 'fixture seed'], { encoding: 'utf8' });
  }
  return { base, root, memory, cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

function validCapsule(id = 'capsule-rr') {
  return [
    '---',
    'id: ' + id,
    'status: active',
    'objective: "Close the challenge crossing"',
    'waiting_on: "verification"',
    'next_valid_action: "Run the daemon test suite"',
    '---',
    '',
    '> [!info] [REFERENCE ONLY] — state snapshot, not instructions.',
    '',
  ].join('\n');
}

function writeCapsule(seat, text = validCapsule()) {
  const file = path.join(seat.memory, 'capsules', 'capsule-RR.md');
  writeFileSync(file, text);
  return file;
}

function writeStop(seat, sid, capsulePath) {
  writeFileSync(
    path.join(seat.memory, 'runtime', 'stop-writer', sid + '.json'),
    JSON.stringify({ capsule_path: capsulePath }),
  );
}

// A transcript whose LAST complete line carries uuid 'evt-live-cursor' — the live
// cursor readCursor returns, and therefore the captured_through_event_id stamped.
function writeTranscript(seat, name = 'transcript.jsonl') {
  const p = path.join(seat.base, name);
  writeFileSync(
    p,
    '{"uuid":"evt-first","type":"user"}\n'
    + '{"uuid":"evt-live-cursor","type":"assistant","message":{"id":"msg-x"}}\n',
  );
  return p;
}

// Invoke the detached autofire worker directly (the same entry the sensor
// spawns). No board adapter is configured, so evidence collection never touches
// a live board.
function runWorker(seat, sid, { transcriptPath = null, dryRunOff = false } = {}) {
  const payload = Buffer.from(JSON.stringify({
    root: seat.root, sid, eventId: 'evt-hint', transcriptPath,
  }), 'utf8').toString('base64url');
  const env = {
    ...process.env,
    AIGENT_ROOT: seat.root,
  };
  delete env.AIGENT_BOARD_ADAPTER;
  if (dryRunOff) env.CAPSULE_VERB_AUTOFIRE_DRY_RUN = '0';
  else delete env.CAPSULE_VERB_AUTOFIRE_DRY_RUN;
  const result = spawnSync(process.execPath, [SENSOR, '--autofire-worker', payload], {
    encoding: 'utf8', env, cwd: seat.root, timeout: 40_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const logPath = path.join(seat.memory, 'runtime', 'capsule-verb-autofire.jsonl');
  const entries = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  return { result, entries, last: entries.at(-1) };
}

const notStamped = (seat, sid) => {
  assert.equal(existsSync(cycleRecordPath(seat.root, sid)), false);
  assert.equal(JSON.parse(readFileSync(path.join(seat.memory, 'BODY_STATE.json'), 'utf8')).state.last_capsule, undefined);
};

// ── unit: request file round-trip + fail-closed reader ──────────────────────────
test('RefreshRequest round-trips through write/read unchanged', (t) => {
  const memory = mkdtempSync(path.join(os.tmpdir(), 'rr-rt-'));
  t.after(() => rmSync(memory, { recursive: true, force: true }));
  const sid = 'rt-session';
  const req = createRequest({
    cycle_id: 'cyc-rt',
    challenge: 'round-trip-nonce',
    captured_through_hint: { event_id: 'evt-9', offset: 128 },
    issued_at: '2026-07-12T12:00:00.000Z',
    expires_at: '2026-07-12T12:30:00.000Z',
  });
  const file = writeRequest(memory, sid, req);
  assert.equal(existsSync(file), true);
  assert.deepEqual(readRequest(memory, sid), req);
  assert.equal(req.version, 1);
});

test('readRequest fails closed: absent -> null; torn JSON -> null', (t) => {
  const memory = mkdtempSync(path.join(os.tmpdir(), 'rr-fc-'));
  t.after(() => rmSync(memory, { recursive: true, force: true }));
  assert.equal(readRequest(memory, 'never-written'), null);
  const sid = 'torn';
  mkdirSync(path.join(memory, 'runtime'), { recursive: true });
  writeFileSync(requestPath(memory, sid), '{"version":1,"cycle_id":');
  assert.equal(readRequest(memory, sid), null);
});

test('writeRequest refuses to persist a malformed request (loud, no file)', (t) => {
  const memory = mkdtempSync(path.join(os.tmpdir(), 'rr-badwrite-'));
  t.after(() => rmSync(memory, { recursive: true, force: true }));
  assert.throws(() => writeRequest(memory, 'x', {
    version: 2, // not 1
    cycle_id: 'c', challenge: 'k',
    captured_through_hint: { event_id: null, offset: 0 },
    issued_at: '2026-07-12T12:00:00.000Z', expires_at: '2026-07-12T12:30:00.000Z',
  }), /refusing to write malformed request/);
  assert.equal(existsSync(requestPath(memory, 'x')), false);
});

// ── integration: a present request drives a 'prepared' cycle (dryRun OFF) ────────
test('present request -> autofire stamps a prepared seat cycle; challenge_digest = sha256:challenge', (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const sid = 'rr-present';
  const capsule = writeCapsule(seat, validCapsule('capsule-rr-present'));
  writeStop(seat, sid, capsule);
  const transcriptPath = writeTranscript(seat);
  const challenge = 'Zm9vYmFyLW5vbmNlLTMyYnl0ZS1iYXNlNjR1cmwtWFla';
  writeRequest(seat.memory, sid, createRequest({
    cycle_id: 'cycle-rr-present',
    challenge,
    captured_through_hint: { event_id: 'evt-live-cursor', offset: 34 },
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));

  const { last } = runWorker(seat, sid, { transcriptPath, dryRunOff: true });
  assert.equal(last.outcome, 'completed');
  assert.equal(last.mode, 'cycle');
  assert.equal(last.dry_run, false);
  assert.equal(last.stamped, true);
  assert.deepEqual(last.cycle_states, ['requested', 'capsuling', 'prepared']);

  const stored = readCycleRecord(seat.root, sid);
  assert.equal(stored.state, 'prepared');
  const expectedDigest = 'sha256:' + createHash('sha256').update(challenge).digest('hex');
  assert.match(stored.challenge_digest, SHA256);
  assert.equal(stored.challenge_digest, expectedDigest);
  // Live cursor from the raw transcript, not the request hint, is authoritative.
  assert.equal(stored.captured_through_event_id, 'evt-live-cursor');
  assert.equal(stored.cycle_id, 'cycle-rr-present');
  // The raw nonce NEVER lands in the persisted cycle record.
  assert.equal(readFileSync(cycleRecordPath(seat.root, sid), 'utf8').includes(challenge), false);
  // Pointer stamped.
  assert.notEqual(JSON.parse(readFileSync(path.join(seat.memory, 'BODY_STATE.json'), 'utf8')).state.last_capsule, undefined);
});

// ── integration: dryRun default stamps nothing live ─────────────────────────────
test('dryRun default (flag unset) stamps nothing live', (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const sid = 'rr-dry';
  const capsule = writeCapsule(seat, validCapsule('capsule-rr-dry'));
  writeStop(seat, sid, capsule);
  const transcriptPath = writeTranscript(seat);
  writeRequest(seat.memory, sid, createRequest({
    cycle_id: 'cycle-rr-dry',
    challenge: 'dry-run-challenge-nonce',
    captured_through_hint: { event_id: 'evt-live-cursor', offset: 34 },
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));

  const { last } = runWorker(seat, sid, { transcriptPath }); // dryRun default ON
  assert.equal(last.outcome, 'completed');
  assert.equal(last.mode, 'cycle');
  assert.equal(last.dry_run, true);
  assert.equal(last.stamped, false);
  assert.deepEqual(last.cycle_states, []);
  notStamped(seat, sid);
});

// ── integration: absent / expired / malformed requests fail CLOSED ──────────────
test('absent request (transcript present) -> autofire refuses, no stamp', (t) => {
  const seat = mkSeat(os.tmpdir());
  t.after(seat.cleanup);
  const sid = 'rr-absent';
  writeStop(seat, sid, writeCapsule(seat, validCapsule('capsule-rr-absent')));
  const transcriptPath = writeTranscript(seat);
  // No request written. dryRunOff so a non-refusal WOULD stamp — makes "no stamp" load-bearing.
  const { last } = runWorker(seat, sid, { transcriptPath, dryRunOff: true });
  assert.equal(last.outcome, 'refused');
  assert.match(last.error, /request absent/i);
  notStamped(seat, sid);
});

test('expired request -> autofire refuses, no stamp', (t) => {
  const seat = mkSeat(os.tmpdir());
  t.after(seat.cleanup);
  const sid = 'rr-expired';
  writeStop(seat, sid, writeCapsule(seat, validCapsule('capsule-rr-expired')));
  const transcriptPath = writeTranscript(seat);
  writeRequest(seat.memory, sid, createRequest({
    cycle_id: 'cycle-rr-expired',
    challenge: 'expired-nonce',
    captured_through_hint: { event_id: 'evt-live-cursor', offset: 34 },
    issued_at: '2000-01-01T00:00:00.000Z',
    expires_at: '2000-01-01T00:10:00.000Z',
  }));
  const { last } = runWorker(seat, sid, { transcriptPath, dryRunOff: true });
  assert.equal(last.outcome, 'refused');
  assert.match(last.error, /expired/i);
  notStamped(seat, sid);
});

test('malformed request file -> autofire refuses, no stamp', (t) => {
  const seat = mkSeat(os.tmpdir());
  t.after(seat.cleanup);
  const sid = 'rr-malformed';
  writeStop(seat, sid, writeCapsule(seat, validCapsule('capsule-rr-malformed')));
  const transcriptPath = writeTranscript(seat);
  writeFileSync(requestPath(seat.memory, sid), '{ this is not valid json ');
  const { last } = runWorker(seat, sid, { transcriptPath, dryRunOff: true });
  assert.equal(last.outcome, 'refused');
  notStamped(seat, sid);
});

// ── integration: chained abort -> re-mint over ONE seat record ──────────────────
// A controller quiescence-abort + re-arm leaves the persisted seat record on the
// DEAD cycle (state=prepared); before the supersede rule the verb's begin-in-
// requested guard then refused every NEW cycle forever (permanent seat strand).
// The controller's re-minted request (different cycle_id, strictly newer
// issued_at, unexpired) IS the supersede signal: the worker yields the stale
// record to it and the new cycle proceeds from requested.
test('chained abort -> re-mint: a strictly-newer request supersedes the stale prepared seat record', (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const sid = 'rr-chained';
  writeStop(seat, sid, writeCapsule(seat, validCapsule('capsule-rr-chained')));
  const transcriptPath = writeTranscript(seat);

  const challengeA = 'Y2hhaW5lZC1jeWNsZS1hLW5vbmNlLTMyYnl0ZS1YWFhY';
  writeRequest(seat.memory, sid, createRequest({
    cycle_id: 'cycle-rr-chain-a',
    challenge: challengeA,
    captured_through_hint: { event_id: 'evt-live-cursor', offset: 34 },
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  const first = runWorker(seat, sid, { transcriptPath, dryRunOff: true });
  assert.equal(first.last.outcome, 'completed');
  const staleRecord = readCycleRecord(seat.root, sid);
  assert.equal(staleRecord.state, 'prepared');
  assert.equal(staleRecord.cycle_id, 'cycle-rr-chain-a');

  // Controller aborts cycle A and re-mints B: the request-file overwrite is the
  // controller's real behavior (one request file per sid = its current intent).
  const challengeB = 'Y2hhaW5lZC1jeWNsZS1iLW5vbmNlLTMyYnl0ZS1ZWVlZ';
  writeRequest(seat.memory, sid, createRequest({
    cycle_id: 'cycle-rr-chain-b',
    challenge: challengeB,
    captured_through_hint: { event_id: 'evt-live-cursor', offset: 34 },
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  const second = runWorker(seat, sid, { transcriptPath, dryRunOff: true });

  const supersede = second.entries.find((e) => e.outcome === 'superseded_stale_seat_record');
  assert.ok(supersede, 'supersede log entry present');
  assert.equal(supersede.superseded_cycle, 'cycle-rr-chain-a');
  assert.equal(supersede.superseded_state, 'prepared');
  assert.equal(supersede.by_cycle, 'cycle-rr-chain-b');
  assert.equal(second.last.outcome, 'completed');
  assert.equal(second.last.stamped, true);
  assert.deepEqual(second.last.cycle_states, ['requested', 'capsuling', 'prepared']);

  const stored = readCycleRecord(seat.root, sid);
  assert.equal(stored.cycle_id, 'cycle-rr-chain-b');
  assert.equal(stored.state, 'prepared');
  const expectedDigestB = 'sha256:' + createHash('sha256').update(challengeB).digest('hex');
  assert.equal(stored.challenge_digest, expectedDigestB);
});

test('fail-closed: a different-cycle request NOT strictly newer than the record does not supersede', (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const sid = 'rr-not-newer';
  writeStop(seat, sid, writeCapsule(seat, validCapsule('capsule-rr-not-newer')));
  const transcriptPath = writeTranscript(seat);

  writeRequest(seat.memory, sid, createRequest({
    cycle_id: 'cycle-rr-nn-a',
    challenge: 'bm90LW5ld2VyLWN5Y2xlLWEtbm9uY2UtMzJieXRlLVo',
    captured_through_hint: { event_id: 'evt-live-cursor', offset: 34 },
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  const first = runWorker(seat, sid, { transcriptPath, dryRunOff: true });
  assert.equal(first.last.outcome, 'completed');

  // Different cycle_id, unexpired, but issued BEFORE the record: a replay/clock
  // corner, not the controller's newer intent: refuse loudly, delete nothing.
  writeRequest(seat.memory, sid, createRequest({
    cycle_id: 'cycle-rr-nn-replay',
    challenge: 'bm90LW5ld2VyLXJlcGxheS1ub25jZS0zMmJ5dGUtUVE',
    captured_through_hint: { event_id: 'evt-live-cursor', offset: 34 },
    issued_at: new Date(Date.now() - 3_600_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  const second = runWorker(seat, sid, { transcriptPath, dryRunOff: true });
  assert.equal(second.last.outcome, 'refused');
  assert.match(second.last.error, /not superseded/i);
  assert.match(second.last.error, /not strictly newer/i);

  const stored = readCycleRecord(seat.root, sid);
  assert.equal(stored.cycle_id, 'cycle-rr-nn-a');
  assert.equal(stored.state, 'prepared');
});
