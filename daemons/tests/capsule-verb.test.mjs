'use strict';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalJson,
  collectEvidence,
  reconcileDigest,
} from '../reconcile-collector.mjs';
import {
  appendReceipt,
  readReceipts,
  receiptDigest,
} from '../effect-receipts.mjs';
import {
  CapsuleVerbRefusal,
  runCapsuleVerb,
} from '../capsule-verb.mjs';
import {
  createCycleRecord,
  cycleRecordPath,
  readCycleRecord,
} from '../refresh-cycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CCP = path.resolve(__dirname, '..', 'curated-close-pointer.mjs');
const SENSOR = path.resolve(__dirname, '..', 'ctx-refresh-sensor.mjs');
const SHA256 = /^[0-9a-f]{64}$/;
const SEAT_ID = 'operator';

// The board evidence class is pluggable (AIGENT_BOARD_ADAPTER). Leaving it unset
// exercises the real "no adapter configured" path — board:null, honest degrade,
// no live board touched from this isolated test.
const BOARD_ENV_KEYS = ['AIGENT_BOARD_ADAPTER'];
const savedBoardEnv = Object.fromEntries(
  BOARD_ENV_KEYS.map((key) => [key, process.env[key]]),
);
for (const key of BOARD_ENV_KEYS) delete process.env[key];
after(() => {
  for (const key of BOARD_ENV_KEYS) {
    if (savedBoardEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedBoardEnv[key];
  }
});

function mkSeat(parent = os.tmpdir(), { git = false } = {}) {
  const base = mkdtempSync(path.join(parent, '.cv-test-'));
  const root = path.join(base, 'test-seat');
  const memory = path.join(root, 'memory');
  mkdirSync(path.join(memory, 'capsules'), { recursive: true });
  mkdirSync(path.join(memory, 'runtime', 'stop-writer'), { recursive: true });
  writeFileSync(path.join(memory, 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  if (git) {
    const gitCfg = ['-c', 'user.name=cv-fixture', '-c', 'user.email=cv-fixture@test.local'];
    execFileSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
    writeFileSync(path.join(root, 'seed.txt'), 'capsule-verb fixture seed\n');
    execFileSync('git', ['-C', root, ...gitCfg, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', root, ...gitCfg, 'commit', '-q', '-m', 'fixture seed'], { encoding: 'utf8' });
  }
  return {
    base,
    root,
    memory,
    cleanup() { rmSync(base, { recursive: true, force: true }); },
  };
}

function validCapsule(id = 'capsule-cv') {
  return [
    '---',
    'id: ' + id,
    'status: active',
    'objective: "Finish the trusted writer"',
    'waiting_on: "verification"',
    'next_valid_action: "Run the daemon test suite"',
    '---',
    '',
    '> [!info] [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.',
    '',
  ].join('\n');
}

function writeCapsule(seat, text = validCapsule()) {
  const file = path.join(seat.memory, 'capsules', 'capsule-CV.md');
  writeFileSync(file, text);
  return file;
}

async function expectRefusal(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CapsuleVerbRefusal);
    assert.match(error.message, pattern);
    assert.equal(error.result.stamped, false);
    assert.equal(error.result.pointerPath, null);
    assert.ok(error.result.refusals.length > 0);
    return true;
  });
}

test('collector is deterministic and returns canonical git/effect evidence', async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cv-collector-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const memory = path.join(scratch, 'memory');
  mkdirSync(path.join(memory, 'runtime'), { recursive: true });

  const args = {
    seatId: SEAT_ID,
    memRoot: memory,
    workspaces: [{ path: REPO_ROOT, repo: 'aigent-os-cv' }],
  };
  const first = await collectEvidence(args);
  const second = await collectEvidence(args);

  assert.deepEqual(second, first);
  assert.equal(reconcileDigest(second), reconcileDigest(first));
  assert.equal(first.version, 1);
  assert.equal(first.git.length, 1);
  assert.equal(first.git[0].repo, 'aigent-os-cv');
  assert.match(first.git[0].index_tree, SHA256);
  assert.match(first.git[0].working_tree_digest, SHA256);
  assert.equal(typeof first.git[0].dirty, 'boolean');
  assert.deepEqual(first.external_effects, []);
});

test('canonical reconcile digest is independent of object key insertion order', () => {
  const left = {
    version: 1,
    board: null,
    git: [{
      repo: 'r', branch: 'main', head: 'abc', index_tree: '1'.repeat(64),
      working_tree_digest: '2'.repeat(64), dirty: false,
    }],
    external_effects: [],
  };
  const right = {
    external_effects: [],
    git: [{
      dirty: false, working_tree_digest: '2'.repeat(64),
      index_tree: '1'.repeat(64), head: 'abc', branch: 'main', repo: 'r',
    }],
    board: null,
    version: 1,
  };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(reconcileDigest(left), reconcileDigest(right));
});

test('no board adapter configured degrades honestly to board:null', async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cv-board-null-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const memory = path.join(scratch, 'memory');
  mkdirSync(path.join(memory, 'runtime'), { recursive: true });
  const evidence = await collectEvidence({
    seatId: SEAT_ID,
    memRoot: memory,
    workspaces: [{ path: REPO_ROOT, repo: 'aigent-os-cv' }],
  });
  assert.equal(evidence.board, null);
  assert.ok(!canonicalJson(evidence).includes('fabricated'));
});

test('effect ledger append/read round-trip and digest stability', (t) => {
  const memory = mkdtempSync(path.join(os.tmpdir(), 'cv-receipts-'));
  t.after(() => rmSync(memory, { recursive: true, force: true }));
  const scope = { memRoot: memory, seatId: SEAT_ID };
  const requested = {
    idempotency_key: 'mail:42',
    system: 'email',
    state: 'requested',
    ts: '2026-07-12T12:00:00.000Z',
  };
  const completed = {
    system: 'email',
    external_id: 'provider-42',
    ts: '2026-07-12T12:00:01.000Z',
    state: 'completed',
    idempotency_key: 'mail:42',
  };
  assert.deepEqual(readReceipts(scope), []);
  appendReceipt(requested, scope);
  appendReceipt(completed, scope);
  const receipts = readReceipts(scope);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].external_id, null);
  assert.equal(receipts[1].external_id, 'provider-42');
  assert.match(receiptDigest(requested), SHA256);
  assert.equal(receiptDigest(completed), receiptDigest({
    idempotency_key: 'mail:42',
    state: 'completed',
    external_id: 'provider-42',
    system: 'email',
    ts: '2026-07-12T12:00:01.000Z',
  }));
});

test('effect ledger fails closed on a malformed line', (t) => {
  const memory = mkdtempSync(path.join(os.tmpdir(), 'cv-receipts-bad-'));
  t.after(() => rmSync(memory, { recursive: true, force: true }));
  const scope = { memRoot: memory, seatId: SEAT_ID };
  appendReceipt({
    idempotency_key: 'deploy:1',
    system: 'deploy',
    state: 'accepted',
    ts: '2026-07-12T12:00:00.000Z',
  }, scope);
  const ledger = path.join(memory, 'runtime', `effect-receipts-${SEAT_ID}.jsonl`);
  appendFileSync(ledger, '{not-json\n');
  assert.throws(() => readReceipts(scope), /malformed JSON at line 2/);
});

test('trusted writer refuses invalid capsules and evidence gaps without stamping', async (t) => {
  await t.test('missing capsule id', async (st) => {
    const seat = mkSeat(os.tmpdir());
    st.after(seat.cleanup);
    const capsule = writeCapsule(seat, validCapsule().replace('id: capsule-cv\n', ''));
    await expectRefusal(runCapsuleVerb({
      seatId: SEAT_ID, memRoot: seat.memory, capsulePath: capsule,
    }), /frontmatter id must be non-empty/);
    assert.equal(JSON.parse(readFileSync(path.join(seat.memory, 'BODY_STATE.json'), 'utf8')).state.last_capsule, undefined);
  });

  await t.test('empty waiting_on', async (st) => {
    const seat = mkSeat(os.tmpdir());
    st.after(seat.cleanup);
    const capsule = writeCapsule(
      seat,
      validCapsule().replace('waiting_on: "verification"', 'waiting_on: ""'),
    );
    await expectRefusal(runCapsuleVerb({
      seatId: SEAT_ID, memRoot: seat.memory, capsulePath: capsule,
    }), /frontmatter waiting_on must be non-empty/);
  });

  await t.test('git evidence gap', async (st) => {
    const seat = mkSeat(os.tmpdir());
    st.after(seat.cleanup);
    const capsule = writeCapsule(seat);
    await expectRefusal(runCapsuleVerb({
      seatId: SEAT_ID, memRoot: seat.memory, capsulePath: capsule,
    }), /evidence collection failed/);
  });
});

test('full trusted stamp round-trips proofs and later no-flag stamp clears them', async (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const capsule = writeCapsule(seat, validCapsule('capsule-round-trip'));
  const result = await runCapsuleVerb({
    seatId: SEAT_ID,
    memRoot: seat.memory,
    capsulePath: capsule,
    capturedThroughEventId: 'evt-73',
  });

  assert.equal(result.stamped, true);
  assert.deepEqual(result.refusals, []);
  assert.match(result.digests.capsule_sha256, SHA256);
  assert.match(result.digests.reconcile_digest, SHA256);
  const pointer = JSON.parse(readFileSync(result.pointerPath, 'utf8')).state.last_capsule;
  assert.equal(pointer.id, 'capsule-round-trip');
  assert.deepEqual(pointer.reconciled.board_rows, []);
  assert.ok(typeof pointer.reconciled.git_head === 'string' && pointer.reconciled.git_head.length > 0);
  assert.equal(pointer.capsule_sha256, result.digests.capsule_sha256);
  assert.equal(pointer.reconcile_digest, result.digests.reconcile_digest);
  assert.equal(pointer.captured_through_event_id, 'evt-73');
  assert.equal(pointer.captured_through_offset, null, 'non-cycle stamp: lone event id keeps legacy semantics, offset stays null');
  assert.equal(pointer.cycle_token, null);

  execFileSync(process.execPath, [CCP, capsule], {
    cwd: seat.root,
    env: { ...process.env, AIGENT_ROOT: seat.root },
    encoding: 'utf8',
  });
  const restamped = JSON.parse(readFileSync(result.pointerPath, 'utf8')).state.last_capsule;
  assert.equal(restamped.reconciled, null);
  assert.equal(restamped.cycle_token, null);
  assert.equal(restamped.cycle_id, null);
  assert.equal(restamped.context_epoch, null);
  assert.equal(restamped.captured_through_event_id, null);
  assert.equal(restamped.captured_through_offset, null);
  assert.equal(restamped.capsule_sha256, null);
  assert.equal(restamped.reconcile_digest, null);
});

test('cycle stores only challenge digest and walks requested→capsuling→prepared', async (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const capsule = writeCapsule(seat, validCapsule('capsule-cycle'));
  const sid = 'session-cycle-cv';
  const challenge = 'raw-challenge-must-never-land';
  const record = createCycleRecord({
    cycle_id: 'cycle-cv',
    lineage_id: 'lineage-cv',
    runtime_session: sid,
    context_epoch: 7,
  });
  const result = await runCapsuleVerb({
    seatId: SEAT_ID,
    memRoot: seat.memory,
    capsulePath: capsule,
    capturedThroughEventId: 'evt-99',
    capturedThroughOffset: 4425,
    cycle: { record, challenge },
  });

  assert.deepEqual(result.cycleStates, ['requested', 'capsuling', 'prepared']);
  const stored = readCycleRecord(seat.root, sid);
  const expectedDigest = 'sha256:' + createHash('sha256').update(challenge).digest('hex');
  assert.equal(stored.state, 'prepared');
  assert.equal(stored.challenge_digest, expectedDigest);
  assert.equal(stored.captured_through_event_id, 'evt-99');
  assert.equal(stored.captured_through_offset, 4425, 'full cursor round-trips into the prepared record');
  assert.equal(stored.capsule_id, 'capsule-cycle');
  assert.equal(stored.capsule_sha256, result.digests.capsule_sha256);
  assert.equal(stored.reconcile_digest, result.digests.reconcile_digest);
  const rawRecord = readFileSync(cycleRecordPath(seat.root, sid), 'utf8');
  assert.equal(rawRecord.includes(challenge), false);
  const pointer = JSON.parse(readFileSync(result.pointerPath, 'utf8')).state.last_capsule;
  assert.equal(pointer.cycle_token, null);
  assert.equal(pointer.cycle_id, 'cycle-cv');
  assert.equal(pointer.context_epoch, 7);
  assert.equal(pointer.captured_through_offset, 4425, 'full cursor round-trips into the stamped pointer — an offset-less stamp could never verify');
});

test('cycle receipt with an event id but no offset refuses loudly (offset-less receipts can never verify)', async (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const capsule = writeCapsule(seat, validCapsule('capsule-halfcursor'));
  const record = createCycleRecord({
    cycle_id: 'cycle-halfcursor',
    lineage_id: 'lineage-halfcursor',
    runtime_session: 'session-halfcursor',
    context_epoch: 0,
  });
  await expectRefusal(
    runCapsuleVerb({
      seatId: SEAT_ID,
      memRoot: seat.memory,
      capsulePath: capsule,
      capturedThroughEventId: 'evt-half',
      cycle: { record, challenge: 'half-cursor-challenge' },
    }),
    /capturedThroughOffset is required for a cycle receipt/,
  );
});

test('malformed persisted cycle fails closed before pointer stamp', async (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const capsule = writeCapsule(seat, validCapsule('capsule-bad-cycle'));
  const sid = 'session-bad-cycle-cv';
  const record = createCycleRecord({
    cycle_id: 'cycle-bad-cv',
    lineage_id: 'lineage-bad-cv',
    runtime_session: sid,
    context_epoch: 1,
  });
  writeFileSync(cycleRecordPath(seat.root, sid), '{malformed-json');
  await expectRefusal(runCapsuleVerb({
    seatId: SEAT_ID,
    memRoot: seat.memory,
    capsulePath: capsule,
    cycle: { record, challenge: 'transient-only' },
  }), /cycle record read failed/);
});

function runSensor(root, home, sid, flagValue) {
  const ctxDir = path.join(home, '.claude', 'ctx-refresh');
  mkdirSync(ctxDir, { recursive: true });
  writeFileSync(path.join(ctxDir, sid + '.json'), JSON.stringify({ used_percentage: 60 }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AIGENT_ROOT: root,
  };
  delete env.CAPSULE_VERB_AUTOFIRE_DRY_RUN;
  if (flagValue === undefined) delete env.CAPSULE_VERB_AUTOFIRE;
  else env.CAPSULE_VERB_AUTOFIRE = flagValue;
  const result = spawnSync(process.execPath, [SENSOR], {
    input: JSON.stringify({ session_id: sid, cwd: root, tool_name: 'Read' }),
    encoding: 'utf8',
    env,
    cwd: root,
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  return {
    result,
    state: readFileSync(path.join(ctxDir, sid + '.state'), 'utf8'),
  };
}

test('autofire is observationally inert when flag is absent', (t) => {
  const seat = mkSeat(os.tmpdir());
  t.after(seat.cleanup);
  const homeA = mkdtempSync(path.join(os.tmpdir(), 'cv-sensor-home-a-'));
  const homeB = mkdtempSync(path.join(os.tmpdir(), 'cv-sensor-home-b-'));
  t.after(() => rmSync(homeA, { recursive: true, force: true }));
  t.after(() => rmSync(homeB, { recursive: true, force: true }));

  const absent = runSensor(seat.root, homeA, 'sensor-inert', undefined);
  const explicitOff = runSensor(seat.root, homeB, 'sensor-inert', '0');
  assert.equal(absent.result.stdout, explicitOff.result.stdout);
  assert.equal(absent.result.stderr, explicitOff.result.stderr);
  assert.equal(absent.result.stderr, '');
  assert.equal(absent.state, explicitOff.state);
  const output = JSON.parse(absent.result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /CONTEXT-REFRESH/);
  assert.deepEqual(JSON.parse(absent.state), {
    fired: true,
    fires: 1,
    last_pct: 60,
    last_emit_pct: 60,
    pct_read_failed: false,
  });
  assert.equal(existsSync(path.join(seat.memory, '.daemon-errors.log')), false);
  assert.equal(existsSync(path.join(seat.memory, 'runtime', 'capsule-verb-autofire.jsonl')), false);
  assert.equal(JSON.parse(readFileSync(path.join(seat.memory, 'BODY_STATE.json'), 'utf8')).state.last_capsule, undefined);
});

test('autofire worker invokes the trusted verb in dry-run mode and logs outcome', (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const sid = 'sensor-worker-cv';
  const capsule = writeCapsule(seat, validCapsule('capsule-sensor-worker'));
  writeFileSync(
    path.join(seat.memory, 'runtime', 'stop-writer', sid + '.json'),
    JSON.stringify({ capsule_path: capsule }),
  );
  const payload = Buffer.from(JSON.stringify({
    root: seat.root,
    sid,
    eventId: 'evt-sensor',
  }), 'utf8').toString('base64url');
  const env = { ...process.env, AIGENT_ROOT: seat.root };
  delete env.CAPSULE_VERB_AUTOFIRE_DRY_RUN;
  const result = spawnSync(process.execPath, [SENSOR, '--autofire-worker', payload], {
    encoding: 'utf8',
    env,
    cwd: seat.root,
    timeout: 40_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const logPath = path.join(seat.memory, 'runtime', 'capsule-verb-autofire.jsonl');
  const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.at(-1).outcome, 'completed');
  assert.equal(entries.at(-1).dry_run, true);
  assert.equal(entries.at(-1).stamped, false);
  assert.equal(JSON.parse(readFileSync(path.join(seat.memory, 'BODY_STATE.json'), 'utf8')).state.last_capsule, undefined);
});

// ── Option-1 skeleton gate (PR #2 known issue; ruling: gate readiness, never ──
// ── seed a placeholder — a writer-producible waiting_on would destroy the   ──
// ── proof that the agent's own finalize ran).                               ──

function skeletonCapsule(id, waitingOnRaw) {
  // Mirrors stop-capsule-writer's skeleton(): status active, autosave tag,
  // waiting_on still in the null family — the finalize step has not run.
  return [
    '---',
    'id: ' + id,
    'parent_capsule_id: null',
    'status: active',
    'objective: "Auto-captured working state"',
    'waiting_on: ' + waitingOnRaw,
    'resume_trigger: compact',
    'trigger: stop-delta',
    'next_valid_action: "Re-ground against live state and continue"',
    'tags: [capsule, autosave]',
    '---',
    '',
    '> [!info] [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.',
    '',
  ].join('\n');
}

function runAutofireWorker(seat, sid) {
  const payload = Buffer.from(JSON.stringify({
    root: seat.root,
    sid,
    eventId: 'evt-skeleton-gate',
  }), 'utf8').toString('base64url');
  const env = { ...process.env, AIGENT_ROOT: seat.root };
  delete env.CAPSULE_VERB_AUTOFIRE_DRY_RUN;
  const result = spawnSync(process.execPath, [SENSOR, '--autofire-worker', payload], {
    encoding: 'utf8',
    env,
    cwd: seat.root,
    timeout: 40_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const logPath = path.join(seat.memory, 'runtime', 'capsule-verb-autofire.jsonl');
  return readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
}

test('autofire worker DEFERS on a skeleton capsule — every null-family waiting_on spelling', (t) => {
  const spellings = [
    ['unquoted-null', 'null'],
    ['tilde', '~'],
    ['capitalized-Null', 'Null'],
    ['empty-double-quoted', '""'],
    ['empty-single-quoted', "''"],
    ['empty-bare', ''],
  ];
  for (const [label, raw] of spellings) {
    const seat = mkSeat(os.tmpdir());
    t.after(seat.cleanup);
    const sid = 'sensor-skel-' + label;
    const capsule = writeCapsule(seat, skeletonCapsule('capsule-skel-' + label, raw));
    writeFileSync(
      path.join(seat.memory, 'runtime', 'stop-writer', sid + '.json'),
      JSON.stringify({ capsule_path: capsule }),
    );
    const entries = runAutofireWorker(seat, sid);
    const last = entries.at(-1);
    assert.equal(last.outcome, 'skipped_skeleton',
      label + ': a not-yet-finalized capsule must DEFER the cycle, never surface as a refusal');
    assert.equal(last.capsule_path, capsule, label + ': defer entry names the capsule it deferred on');
    assert.equal(existsSync(path.join(seat.memory, '.daemon-errors.log')), false,
      label + ': deferring readiness is not an error');
  }
});

test('autofire worker runs the verb once the capsule has left skeleton state (contrast pin)', (t) => {
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const sid = 'sensor-skel-left';
  const capsule = writeCapsule(seat, validCapsule('capsule-left-skeleton'));
  writeFileSync(
    path.join(seat.memory, 'runtime', 'stop-writer', sid + '.json'),
    JSON.stringify({ capsule_path: capsule }),
  );
  const entries = runAutofireWorker(seat, sid);
  assert.equal(entries.at(-1).outcome, 'completed',
    'a finalized capsule must still flow to the verb — the gate only filters skeletons');
});

test('quoted "null" waiting_on is an intentional string — the gate lets the verb see it', (t) => {
  // Consistency pin with validateCapsuleText: a QUOTED "null" is deliberate
  // content, not the writer skeleton. The gate must not widen past the
  // validator's own null family, or gate and verb would disagree about the
  // same bytes.
  const seat = mkSeat(os.tmpdir(), { git: true });
  t.after(seat.cleanup);
  const sid = 'sensor-skel-quoted-null';
  const capsule = writeCapsule(seat, skeletonCapsule('capsule-quoted-null', '"null"'));
  writeFileSync(
    path.join(seat.memory, 'runtime', 'stop-writer', sid + '.json'),
    JSON.stringify({ capsule_path: capsule }),
  );
  const entries = runAutofireWorker(seat, sid);
  assert.notEqual(entries.at(-1).outcome, 'skipped_skeleton',
    'quoted "null" left skeleton state — the verb owns judging it, not the gate');
});
