import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  emitNightlyAlert, formatNightlyBootAlerts, nightlyAlertPath, readActiveNightlyAlerts,
  resolveNightlyAlerts,
} from '../nightly-alerts.mjs';
import {
  beginNightlyPass, finishNightlyPass, NIGHTLY_CHECKPOINTS, recordNightlyCheckpoint,
} from '../nightly-pass.mjs';
import { runNightlyWatchdog } from '../nightly-watchdog.mjs';

const leg = 'ledger-capture';
const legCode = `NIGHTLY:LEG_FAIL:${leg}`;
const passCode = 'NIGHTLY:PASS_FAILED';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-alert-ledger-'));
  const stateHome = process.env.AIGENT_STATE_HOME_DIR;
  process.env.AIGENT_STATE_HOME_DIR = root;
  t.after(() => {
    if (stateHome === undefined) delete process.env.AIGENT_STATE_HOME_DIR;
    else process.env.AIGENT_STATE_HOME_DIR = stateHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const memory = path.join(root, 'vault', 'memory');
  fs.mkdirSync(path.join(memory, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(memory, 'runtime', 'NIGHTLY_CAPTURE_CANDIDATES.jsonl'), '');
  fs.writeFileSync(path.join(memory, 'MEMORY_CANDIDATES.md'), '');
  return root;
}

function night(root, day, second = 0) {
  const now = new Date(Date.UTC(2026, 2, day, 20, 0, second)).toISOString();
  return { root, date: now.slice(0, 10), now, runId: `run-${day}`, timeZone: 'UTC', cutoffHour: 4, deliver: false };
}

function record(options, checkpoint, status, overrides = {}) {
  const artifact = checkpoint === 'digest' ? 'none:no-staged-candidates' : 'none:no-ledger-candidates';
  return recordNightlyCheckpoint({
    ...options, checkpoint, status, exitCode: status === 'fail' ? 1 : 0, artifact, ...overrides,
  });
}

function ledger(root, code) {
  const { alerts, events, errors } = readActiveNightlyAlerts(root);
  assert.deepEqual(errors, []);
  return {
    active: alerts.filter(row => row.code === code),
    events: events.filter(row => row.code === code),
  };
}

function raise(options, code, scope) {
  return emitNightlyAlert({ ...options, code, scope, summary: 'failed', evidence: 'log' });
}

test('three failing nights update one leg ID and keep the first raise', async t => {
  const root = fixture(t);
  let last;
  for (const day of [1, 2, 3]) {
    await beginNightlyPass(night(root, day));
    last = await record(night(root, day, 1), leg, 'fail', { detail: `failure ${day}` });
    await finishNightlyPass(night(root, day, 2));
  }
  const { active, events } = ledger(root, legCode);
  assert.equal(active.length, 1);
  const id = `${legCode}:standing`;
  assert.deepEqual([...new Set(events.map(row => row.alert_id))], [id]);
  assert.equal(last.alert, `memory/runtime/NIGHTLY_ALERTS.jsonl#${id}`);
  assert.equal(active[0].raised_at, night(root, 1, 1).now);
  assert.equal(active[0].timestamp, last.recorded_at);
  assert.equal(active[0].detail, 'failure 3');
  assert.deepEqual(events.filter(row => row.event === 'raised').map(row => row.timestamp),
    [1, 2, 3].map(day => night(root, day, 1).now));
});

test('a leg passes and clears before finish while the other leg keeps failing', async t => {
  const root = fixture(t);
  for (const day of [1, 2]) {
    await beginNightlyPass(night(root, day));
    await record(night(root, day, 1), 'dream', 'fail');
    await record(night(root, day, 2), leg, day === 1 ? 'fail' : 'pass');
    assert.equal(ledger(root, legCode).active.length, day === 1 ? 1 : 0);
    assert.equal(ledger(root, 'NIGHTLY:LEG_FAIL:dream').active.length, 1);
    assert.equal((await finishNightlyPass(night(root, day, 3))).status, 'fail');
  }
});

test('a skipped checkpoint leaves its previous alert active', async t => {
  const root = fixture(t);
  const code = 'NIGHTLY:LEG_FAIL:digest';
  await beginNightlyPass(night(root, 1));
  await record(night(root, 1, 1), 'digest', 'fail');
  await finishNightlyPass(night(root, 1, 2));
  const before = ledger(root, code);
  assert.equal(before.active.length, 1);
  await beginNightlyPass(night(root, 2));
  assert.equal((await record(night(root, 2, 1), 'digest', 'skipped')).status, 'skipped');
  assert.deepEqual(ledger(root, code), before);
});

test('a reused run and identical long artifact still write the new failure detail', async t => {
  const root = fixture(t);
  const artifact = 'none:' + 'x'.repeat(400);
  for (const day of [1, 2]) {
    await beginNightlyPass({ ...night(root, day), runId: 'repeat' });
    await record(night(root, day, 1), leg, 'fail', { artifact, detail: `attempt ${day}` });
    await finishNightlyPass(night(root, day, 2));
  }
  const { events, active } = ledger(root, legCode);
  const raises = events.filter(row => row.event === 'raised');
  assert.equal(raises.length, 2);
  assert.equal(active.length, 1);
  assert.match(active[0].detail, /attempt 2/);
  for (const row of raises) {
    assert.ok(row.evidence.includes(row.timestamp));
  }
});

test('a passing record clears through its instant and preserves later and undatable writes', async t => {
  const root = fixture(t);
  await beginNightlyPass(night(root, 2));
  const pass = night(root, 2, 1);
  const first = night(root, 1).now;
  const rows = [
    { alert_id: 'rewritten', raised_at: first, timestamp: night(root, 3).now },
    { alert_id: 'undated', raised_at: 'unknown', timestamp: { toString: null } },
    { alert_id: 'at-cutoff', raised_at: first, timestamp: pass.now },
    { alert_id: 'fallback', raised_at: first, timestamp: 'unknown' },
  ].map(row => ({ ...row, code: legCode, status: 'active' }));
  fs.writeFileSync(nightlyAlertPath(root), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal((await record(pass, leg, 'pass')).status, 'pass');
  assert.deepEqual(ledger(root, legCode).active.map(row => row.alert_id).sort(), ['rewritten', 'undated']);
});

test('ten legacy leg alerts collapse on failure, then a pass clears only the exact code', async t => {
  const root = fixture(t);
  for (let day = 1; day <= 10; day++) await raise(night(root, day), legCode, `run-${day}`);
  const longer = await raise(night(root, 10, 1), legCode + ':extra', 'legacy');
  assert.equal(ledger(root, legCode).active.length, 10);
  await beginNightlyPass(night(root, 11));
  await record(night(root, 11, 1), leg, 'fail');
  const { active, events } = ledger(root, legCode);
  assert.deepEqual(active.map(row => row.alert_id), [`${legCode}:standing`]);
  const closed = events.filter(row => row.event === 'resolved');
  assert.equal(closed.length, 10);
  assert.ok(closed.every(row => /replaced by the standing alert/.test(row.resolution)));
  assert.ok(events.indexOf(closed[0]) > events.findIndex(row => row.alert_id === active[0].alert_id));
  const other = () => ledger(root, longer.code).active.map(row => row.alert_id);
  assert.deepEqual(other(), [longer.alert_id]);
  await finishNightlyPass(night(root, 11, 2));
  await beginNightlyPass(night(root, 12));
  await record(night(root, 12, 1), leg, 'pass');
  assert.equal(ledger(root, legCode).active.length, 0);
  assert.deepEqual(other(), [longer.alert_id]);
});

test('three failed watchdog nights share one ID, retire old dates and replay silently', async t => {
  const root = fixture(t);
  for (const day of [1, 2]) await raise(night(root, day), passCode, night(root, day).date);
  const messages = [];
  for (const day of [3, 4, 5]) {
    await beginNightlyPass(night(root, day));
    for (const [i, checkpoint] of NIGHTLY_CHECKPOINTS.entries()) {
      await record(night(root, day, i + 1), checkpoint, 'fail');
    }
    assert.equal((await finishNightlyPass(night(root, day, 12))).status, 'fail');
    const delivery = { deliver: true, stderr: line => messages.push(line) };
    const result = await runNightlyWatchdog({ ...night(root, day, 13), ...delivery });
    assert.equal(result.alert.code, passCode);
    const file = nightlyAlertPath(root);
    const before = fs.readFileSync(file);
    await runNightlyWatchdog({ ...night(root, day, 14), ...delivery });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(messages.length, day - 2);
    assert.deepEqual(ledger(root, passCode).active.map(row => row.alert_id), [`${passCode}:standing`]);
  }
  const { active, events } = ledger(root, passCode);
  assert.deepEqual(events.filter(row => row.event === 'resolved').map(row => row.scope),
    [night(root, 1).date, night(root, 2).date]);
  assert.equal(events.filter(row => row.event === 'raised' && row.alert_id === active[0].alert_id).length, 3);
  assert.equal(active[0].raised_at, night(root, 3, 13).now);
  assert.equal(active[0].timestamp, night(root, 5, 13).now);
});

test('NO_FIRE and UNVERIFIED keep their date scopes', async t => {
  const root = fixture(t);
  const absent = await runNightlyWatchdog(night(root, 0));
  assert.equal(absent.alert.alert_id, 'NIGHTLY:NO_FIRE:missing');
  const log = path.join(path.dirname(nightlyAlertPath(root)), 'NIGHTLY_LOG.md');
  fs.writeFileSync(log, '## Nightly Pass -- 2026-02-28\n');
  for (const day of [1, 2]) {
    const options = night(root, day);
    const missing = await runNightlyWatchdog(options);
    assert.equal(missing.alert.alert_id, `NIGHTLY:NO_FIRE:${options.date}`);
    fs.appendFileSync(log, `## Nightly Pass -- ${options.date}\nJournal only\n`);
    const unverified = await runNightlyWatchdog(night(root, day, 1));
    assert.equal(unverified.alert.alert_id, `NIGHTLY:UNVERIFIED:${options.date}`);
    assert.equal(ledger(root, 'NIGHTLY:NO_FIRE').active.length, 0);
  }
  assert.equal(ledger(root, 'NIGHTLY:UNVERIFIED').active.length, 2);
});

test('SessionStart groups and orders by last write', async t => {
  const root = fixture(t);
  await raise(night(root, 1), legCode, 'standing');
  await raise(night(root, 11), 'NIGHTLY:OLD', 'old');
  await raise(night(root, 19), 'NIGHTLY:RECENT', 'recent');
  await emitNightlyAlert({ ...night(root, 20), code: legCode, scope: 'standing', summary: 'failed again', evidence: 'new log' });
  const lines = formatNightlyBootAlerts(root, { now: night(root, 21).now });
  assert.match(lines[0], /LEG_FAIL:ledger-capture.*failed again/);
  assert.match(lines[1], /NIGHTLY:RECENT/);
  assert.match(lines[2], /OLDER\] 1 active alert\(s\).*\("NIGHTLY:OLD" 1\)/);
  assert.equal(lines.length, 3);
});

for (const shortRead of [false, true]) {
  test(`append preserves an unterminated last row (${shortRead ? 'zero bytes' : 'one byte'} read)`, async t => {
    const root = fixture(t);
    await raise(night(root, 1), legCode, 'legacy');
    const route = await raise(night(root, 1, 1), 'NIGHTLY:ROUTE_FAIL', 'route');
    const file = nightlyAlertPath(root);
    const size = fs.statSync(file).size;
    if (!shortRead) fs.truncateSync(file, size - 1);
    const before = readActiveNightlyAlerts(root).events;
    const read = fs.readSync;
    let count = 0;
    const hook = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
      if (length === 1 && position != null) {
        count++;
        assert.equal(position, size - (shortRead ? 1 : 2));
        if (shortRead) fs.truncateSync(file, size - 1);
      }
      const bytes = read(fd, buffer, offset, length, position);
      if (length === 1 && position != null) assert.equal(bytes, shortRead ? 0 : 1);
      return bytes;
    });
    syncBuiltinESMExports();
    try {
      resolveNightlyAlerts({ root, code: legCode, now: night(root, 2).now });
    } finally {
      hook.mock.restore();
      syncBuiltinESMExports();
    }
    const { events, alerts, errors } = readActiveNightlyAlerts(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(events.slice(0, -1), before);
    assert.equal(events.at(-1).event, 'resolved');
    assert.deepEqual(alerts.map(row => row.alert_id), [route.alert_id]);
    assert.equal(count, 1);
  });
}

test('begin reports a delivery error and still starts the pass', async t => {
  const root = fixture(t);
  const messages = [];
  const state = await beginNightlyPass({
    ...night(root, 1), deliver: true,
    stderr(line) {
      if (line.startsWith('[NIGHTLY-ALERT:')) throw new Error('alert write failed');
      messages.push(line);
    },
  });
  assert.equal(state.status, 'running');
  const { events } = ledger(root, 'NIGHTLY:NO_FIRE');
  assert.deepEqual(events.map(row => row.event), ['raised', 'delivery']);
  assert.equal(events[1].delivery.local, 'failed');
  assert.deepEqual(messages, ['NIGHTLY_WATCHDOG ERROR "alert write failed"\n']);
});

test('an unreadable ledger leaves a passing record green with one diagnostic', async t => {
  const root = fixture(t);
  await beginNightlyPass(night(root, 1));
  const file = nightlyAlertPath(root);
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  const messages = [];
  const result = await record(night(root, 1, 1), leg, 'pass', { stderr: line => messages.push(line) });
  assert.equal(result.status, 'pass');
  const state = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'NIGHTLY_PASS_STATE.json')));
  assert.deepEqual(state.checkpoints[leg], result);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^ledger-capture passed but its alert could not be cleared: [^\r\n]+\n$/);
});

test('an unreadable ledger propagates a failing record error', async t => {
  const root = fixture(t);
  await beginNightlyPass(night(root, 1));
  const file = nightlyAlertPath(root);
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  await assert.rejects(record(night(root, 1, 1), leg, 'fail'), { code: 'EISDIR' });
});

async function plainSequence(root, stderr) {
  const options = { ...night(root, 1), code: 'NIGHTLY:PLAIN', summary: 'failed', evidence: 'log', stderr };
  for (const [i, change] of [
    {}, {}, { deliver: true }, { deliver: true },
    { deliver: true, summary: 'changed' }, { deliver: true, summary: 'changed' },
  ].entries()) {
    await emitNightlyAlert({ ...options, now: night(root, 1, i).now, ...change });
  }
}

test('the plain emitter retries delivery and dedupes fixed-clock replays', async t => {
  const root = fixture(t);
  const messages = [];
  await plainSequence(root, line => messages.push(line));
  assert.deepEqual(ledger(root, 'NIGHTLY:PLAIN').events.map(row => row.event),
    ['raised', 'delivery', 'delivery', 'raised', 'delivery']);
  assert.equal(messages.length, 2);
  assert.equal(fs.statSync(nightlyAlertPath(root)).size, 2184);
  assert.equal(Buffer.byteLength(messages.join('')), 139);
});
