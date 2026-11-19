// stop-capsule-writer.fidelity.test.mjs: what a Done row keeps.
//
// Three defects measured on a live fleet autosave (davinci seat, 2026-11-18,
// 169 Done rows): long rows cut mid-word, bullets stamped with a bare UTC
// HH:MM that no reader can date, and teammate idle_notification envelopes
// stored as Done rows (10 of the 169). Black-box like the main suite: each
// case spawns the shipped worker against an OS-temp memory root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capsuleRowKey } from '../lifecycle-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = process.env.SCW_DAEMON || path.join(__dirname, '..', 'stop-capsule-writer.mjs');

const SESSION = '89abcdef-fidelity-session';

function makeRoot() {
  const base = mkdtempSync(path.join(tmpdir(), 'scw-fidelity-'));
  const root = path.join(base, 'test-root');
  const memory = path.join(root, 'memory');
  mkdirSync(path.join(memory, 'capsules'), { recursive: true });
  writeFileSync(path.join(memory, 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  return { base, root, memory, statePath: path.join(memory, 'runtime', 'stop-writer', `${SESSION}.json`) };
}

function flush({ root, statePath }, events) {
  const transcriptPath = path.join(root, `${SESSION}.jsonl`);
  writeFileSync(transcriptPath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const run = spawnSync(process.execPath, [DAEMON, '--worker', JSON.stringify({
    __root: root, session_id: SESSION, transcript_path: transcriptPath,
  })], {
    cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: {
      ...process.env, AIGENT_ROOT: root, AIGENT_STATE_HOME_DIR: '', AIGENT_SEAT_ID: '',
      CLAUDE_PROJECT_DIR: '', LIFECYCLE_KILL_STOP_WRITER: '0',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  assert.ok(state?.capsule_path && existsSync(state.capsule_path), 'worker must land a capsule');
  return state.capsule_path;
}

const doneRows = (doc) => doc.split('<!-- swe:done -->')[1].split(/\r?\n## /)[0]
  .split(/\r?\n/).filter((line) => line.startsWith('- '));

function runWorker(events) {
  const fixture = makeRoot();
  try {
    return doneRows(readFileSync(flush(fixture, events), 'utf8'));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

// Flush `first`, rewrite its assistant row into the pre-fix rendering an older
// writer stored (240-char raw cut, bare HH:MM stamp), keep the saved offset,
// then flush `first` plus `more` so only the new events are read.
function runAfterLegacyRow(first, more, text) {
  const fixture = makeRoot();
  try {
    const capsule = flush(fixture, first);
    const legacy = `- 07:49 [ASSISTANT] ${text.slice(0, 240)}…[+${text.length - 240} chars]`;
    const doc = readFileSync(capsule, 'utf8').split(/\r?\n/)
      .map((line) => (line.startsWith('- ') && line.includes('[ASSISTANT]') ? legacy : line)).join('\n');
    writeFileSync(capsule, doc);
    flush(fixture, [...first, ...more]);
    return doneRows(readFileSync(capsule, 'utf8'));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const user = (text) => ({ type: 'user', isMeta: false, message: { content: text } });

test('a long Done row is cut at a sentence end, never mid-word, and counts what it dropped', () => {
  const first = 'The dream log holds 189 improvement candidates from 65 nightly runs since July 25, and only one was ever formally adopted.';
  const second = 'A read-only agent is now sorting all 189 into done in code, done as a note, superseded, stale and open, with a ranked shortlist on top for Will to read in the morning.';
  const text = `${first} ${second}`;
  const rows = runWorker([assistant(text)]);
  const row = rows.find((r) => r.includes('[ASSISTANT]'));
  assert.ok(row, `assistant row missing: ${rows.join('\n')}`);
  const m = row.match(/\[ASSISTANT\] (.*)…\[\+(\d+) chars #[0-9a-f]{64}\]$/);
  assert.ok(m, `row must carry the truncation marker: ${row}`);
  assert.equal(m[1].trimEnd(), first, 'kept text must end at the sentence boundary');
  assert.equal(Number(m[2]), text.length - m[1].length, 'marker must count the dropped characters');
});

test('a Done row with no sentence end in reach is cut at a word boundary', () => {
  // 22-char unit: a raw 240-char cut lands inside "kitchen" (240 = 10 * 22 + 20).
  const text = `${'alphabet soup kitchen '.repeat(14)}omega`;
  const rows = runWorker([assistant(text)]);
  const row = rows.find((r) => r.includes('[ASSISTANT]'));
  const m = row.match(/\[ASSISTANT\] (.*)…\[\+(\d+) chars #[0-9a-f]{64}\]$/);
  assert.ok(m, `row must carry the truncation marker: ${row}`);
  assert.match(m[1], /(alphabet|soup|kitchen)$/, `cut must land after a whole word: ${m[1].slice(-30)}`);
  assert.equal(Number(m[2]), text.length - m[1].length);
});

test('Done bullets carry a full UTC date and time, not a bare HH:MM', () => {
  const rows = runWorker([user('please ship the triage page tonight'), assistant('Shipped.')]);
  assert.ok(rows.length >= 2, rows.join('\n'));
  for (const row of rows) {
    assert.match(row, /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \[/, `undated stamp: ${row}`);
  }
});

test('teammate idle_notification envelopes are not stored as Done rows; other peer messages are', () => {
  const idle = 'Another Claude session sent a message:\n<teammate-message teammate_id="dream-triage" color="blue">\n'
    + '{"type":"idle_notification","from":"dream-triage","timestamp":"2026-11-19T07:52:58.241Z","idleReason":"available","result":"done"}\n'
    + '</teammate-message>';
  const real = 'Another Claude session sent a message:\n<teammate-message teammate_id="builder-x" color="green">\n'
    + 'BUILD COMPLETE at abc1234 : 0 open\n</teammate-message>';
  const rows = runWorker([user(idle), user(real), assistant('Read both.')]);
  assert.equal(rows.filter((r) => r.includes('idle_notification')).length, 0, rows.join('\n'));
  assert.ok(rows.some((r) => r.includes('[PEER:builder-x]') && r.includes('BUILD COMPLETE')), rows.join('\n'));
});

test('row keys ignore both the new dated stamp and the legacy HH:MM stamp', () => {
  const body = '[ASSISTANT] Capsule confirmed.';
  assert.equal(capsuleRowKey(`- 2026-11-19T07:49Z ${body}`), body);
  assert.equal(capsuleRowKey(`- 07:49 ${body}`), body);
});

// Review of 86a21a8a (titus, 2026-11-19): five regressions, one test each.

test('a peer report that only quotes idle_notification is kept', () => {
  const report = 'Another Claude session sent a message:\n<teammate-message teammate_id="builder-q" color="green">\n'
    + 'I fixed the {"type":"idle_notification"} parser.\n</teammate-message>';
  const rows = runWorker([user(report), assistant('Noted.')]);
  assert.ok(rows.some((r) => r.includes('[PEER:builder-q]') && r.includes('parser')), rows.join('\n'));
});

test('two long reports sharing their first sentence stay two Done rows', () => {
  const opening = 'The release checklist passed every gate tonight and the build artifacts are signed, verified and staged for the morning window as planned.';
  const filler = ' Smoke tests ran against the staging copy with no errors and the rollback plan is written down in the runbook for anyone on call.';
  const east = `${opening}${filler} Deploy east.`;
  const west = `${opening}${filler} Deploy west.`;
  assert.equal(east.length, west.length);
  const rows = runWorker([assistant(east), user('next'), assistant(west)]);
  assert.equal(rows.filter((r) => r.includes('[ASSISTANT]') && r.includes('release checklist')).length, 2, rows.join('\n'));
});

test('a long operator message reports the true number of dropped characters', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `word${i % 10}`).join(' ');
  const rows = runWorker([user(words), assistant('ok')]);
  const row = rows.find((r) => r.includes('[OPERATOR]'));
  const m = row.match(/\[OPERATOR\] (.*)…\[\+(\d+) chars #[0-9a-f]{64}\]$/);
  assert.ok(m, row);
  assert.equal(Number(m[2]), words.length - m[1].length);
});

test('a sentence of exactly half the cap is kept whole', () => {
  const half = `${'b'.repeat(119)}.`; // 120 chars: exactly half of the 240 cap
  const text = `${half} ${'c'.repeat(60)} ${'d'.repeat(60)} ${'e'.repeat(60)}`;
  const rows = runWorker([assistant(text)]);
  const m = rows.find((r) => r.includes('[ASSISTANT]')).match(/\[ASSISTANT\] (.*)…\[\+(\d+) chars #[0-9a-f]{64}\]$/);
  assert.ok(m);
  assert.equal(m[1], half);
});

// Third review of bbbd1724 (titus, 2026-11-19). Ruling taken with it: no
// legacy-rendering alias. An older row cannot tell a replay from new speech
// that shares its first 240 characters, and dropping speech is worse than
// one repeated row when a pre-fix capsule's span is replayed.

const sharedOpening = 'The release checklist passed every gate tonight and the build artifacts are signed, verified and staged for the morning window as planned.'
  + ' Smoke tests ran against the staging copy with no errors and the rollback plan is written down in the runbook for anyone on call.';

test('a legacy row sharing the first 240 characters never suppresses new speech', () => {
  const east = `${sharedOpening} Deploy east.`;
  const west = `${sharedOpening} Deploy west.`;
  const rows = runAfterLegacyRow([assistant(east)], [user('next'), assistant(west)], east);
  assert.equal(rows.filter((r) => r.includes('release checklist')).length, 2, rows.join('\n'));
});

test('two long reports whose short hashes collide stay two rows', () => {
  const a = `${'x'.repeat(250)}009753`;
  const b = `${'x'.repeat(250)}017528`;
  const rows = runWorker([assistant(a), user('next'), assistant(b)]);
  assert.equal(rows.filter((r) => r.includes('[ASSISTANT] xxxx')).length, 2, rows.join('\n'));
});

test('a peer report whose body is not valid JSON as sent is kept, even if flattening would make it parse', () => {
  const report = 'Another Claude session sent a message:\n<teammate-message teammate_id="builder-n" color="green">\n'
    + '{"type":"idle_notification","note":"line one\nline two"}\n</teammate-message>';
  const rows = runWorker([user(report), assistant('Noted.')]);
  assert.ok(rows.some((r) => r.includes('[PEER:builder-n]')), rows.join('\n'));
});

test('an idle envelope with a > inside a quoted attribute is still dropped', () => {
  const idle = 'Another Claude session sent a message:\n<teammate-message teammate_id="builder-w" summary="wait > budget">\n'
    + '{"type":"idle_notification","from":"builder-w","idleReason":"available"}\n</teammate-message>';
  const rows = runWorker([user(idle), assistant('Read it.')]);
  assert.equal(rows.filter((r) => r.includes('[PEER:builder-w]')).length, 0, rows.join('\n'));
});

// Fourth review of ec80f561 (titus, 2026-11-19): idle is judged on the raw event.

test('a report whose quoted newline sits inside a system-reminder span is kept', () => {
  const report = 'Another Claude session sent a message:\n<teammate-message teammate_id="builder-r" color="green">\n'
    + '{"type":"idle_notification","note":"start<system-reminder>a\nb</system-reminder>end"}\n</teammate-message>';
  const rows = runWorker([user(report), assistant('Noted.')]);
  assert.ok(rows.some((r) => r.includes('[PEER:builder-r]')), rows.join('\n'));
});

test('an idle envelope followed by a harness system-reminder is still dropped', () => {
  const idle = 'Another Claude session sent a message:\n<teammate-message teammate_id="builder-s" color="blue">\n'
    + '{"type":"idle_notification","from":"builder-s","idleReason":"available"}\n</teammate-message>\n'
    + '<system-reminder>\nTodo list is empty.\n</system-reminder>';
  const rows = runWorker([user(idle), assistant('Read it.')]);
  assert.equal(rows.filter((r) => r.includes('[PEER:builder-s]')).length, 0, rows.join('\n'));
});
