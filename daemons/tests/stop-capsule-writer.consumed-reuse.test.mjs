// stop-capsule-writer.consumed-reuse.test.mjs — a spent capsule stays spent.
//
// THE FAILURE (board 52bf43e2, Codex finding #10): resume-verb marks the capsule
// it loads as consumed, AT LOAD, so the next resume cannot replay it. The Stop
// writer then reuses `state.capsule_path` on an existsSync check alone, never
// reading the capsule's status, and rewrites that same file with `status: active`.
// The consumed-mark is undone by the next turn's Stop, and the selector that
// correctly excluded the capsule starts offering it again.
//
// Root cause in one line: CONSUMED_STATUSES in lifecycle-common.mjs has exactly
// one reader — the selector. The Stop writer imports memRoot from that same
// module and not the predicate, so the one component able to UNDO a consumed-mark
// is the one that never consults what consumed means.
//
// Black-box, matching the sibling suite: spawn the shipped worker against an
// isolated temp root and read the capsule that actually landed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONSUMED_STATUSES } from '../lifecycle-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(__dirname, '..', 'stop-capsule-writer.mjs');

function makeFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'scw-consumed-'));
  const root = path.join(base, 'test-root');
  const memory = path.join(root, 'memory');
  mkdirSync(path.join(memory, 'capsules'), { recursive: true });
  writeFileSync(path.join(memory, 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  return { base, root, memory };
}

function runWorker(fixture, events, sessionId) {
  const transcriptPath = path.join(fixture.root, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const payload = { __root: fixture.root, session_id: sessionId, transcript_path: transcriptPath };
  spawnSync(process.execPath, [DAEMON, '--worker', JSON.stringify(payload)], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      AIGENT_ROOT: fixture.root,
      AIGENT_STATE_HOME_DIR: '',
      AIGENT_SEAT_ID: '',
      CLAUDE_PROJECT_DIR: '',
      LIFECYCLE_KILL_STOP_WRITER: '0',
    },
  });
  const statePath = path.join(fixture.memory, 'runtime', 'stop-writer', `${sessionId}.json`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  return { state, capsulePath: state?.capsule_path || null };
}

const user = (text) => ({ type: 'user', isMeta: false, message: { content: text } });
const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

function statusOf(capsulePath) {
  const m = readFileSync(capsulePath, 'utf8').match(/^status:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

// What resume-verb does when it loads a capsule: spends it, in place.
function markConsumed(capsulePath) {
  const text = readFileSync(capsulePath, 'utf8');
  const next = text.replace(/^status:\s*active\s*$/m, 'status: resumed');
  assert.notEqual(next, text, 'fixture guard: the capsule had no `status: active` line to consume');
  writeFileSync(capsulePath, next);
}

test('a capsule consumed by resume is NOT reactivated by the next Stop', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.base, { recursive: true, force: true }));
  const sid = '0aaaaaaa-consumed-reuse';

  const first = runWorker(fixture, [user('build the thing'), assistant('built the thing')], sid);
  assert.ok(first.capsulePath, 'setup: the first Stop must produce a capsule');
  assert.equal(statusOf(first.capsulePath), 'active', 'setup: a fresh capsule starts active');

  // A resume happens between the two Stops and spends the capsule.
  markConsumed(first.capsulePath);
  assert.ok(
    CONSUMED_STATUSES.has(statusOf(first.capsulePath)),
    'setup: the mark must be a status the selector actually treats as consumed',
  );

  // Next turn's Stop, same session, new delta.
  const second = runWorker(fixture, [
    user('build the thing'), assistant('built the thing'),
    user('now do the next thing'), assistant('did the next thing'),
  ], sid);

  if (second.capsulePath === first.capsulePath) {
    assert.ok(
      !CONSUMED_STATUSES.has(statusOf(first.capsulePath)) === false,
      `the Stop writer reused the consumed capsule at ${first.capsulePath} and rewrote it to status: ${statusOf(first.capsulePath)} — resume's consumed-mark is undone and the selector will offer this capsule again`,
    );
  } else {
    // The acceptable outcome: a fresh capsule, and the spent one left spent.
    assert.ok(
      CONSUMED_STATUSES.has(statusOf(first.capsulePath)),
      'the spent capsule was left behind but no longer reads as consumed',
    );
    assert.equal(statusOf(second.capsulePath), 'active', 'the new capsule should be the active one');
  }
});

// THE CONTROL, and it is not optional: "rebuild from scratch every Stop" would
// satisfy the assertion above while destroying the session's history.
//
// COMPARING PATHS DOES NOT WORK, and the first version of this test made exactly
// that mistake. When state.capsule_path is unavailable the writer falls back to
// `<date>-auto-<sid8>.md`, which is DETERMINISTIC — for one session on one day the
// "new" path is the same string as the reused one. A path equality check passes
// whether or not reuse happened, so it can never fail. Proven: mutating
// `capPath = state.capsule_path` to `capPath = null` left the path assertion
// green.
//
// So assert what reuse actually BUYS: prior turns' content surviving. The writer
// advances a byte offset, so turn 2 only ever processes the new tail — if the doc
// were rebuilt rather than loaded, turn 1's material would be gone with no path
// change to show for it.
test('CONTROL — prior turns survive into the next Stop (reuse is real, not just a matching filename)', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.base, { recursive: true, force: true }));
  const sid = '0bbbbbbb-active-reuse';
  const TURN_ONE_MARK = 'ZZTURNONEMARKERZZ';

  const first = runWorker(fixture, [user(`build the thing ${TURN_ONE_MARK}`), assistant('built it')], sid);
  assert.ok(first.capsulePath, 'setup: the first Stop must produce a capsule');
  assert.equal(statusOf(first.capsulePath), 'active');
  assert.match(
    readFileSync(first.capsulePath, 'utf8'), new RegExp(TURN_ONE_MARK),
    'setup: turn one\'s marker must reach the capsule, or the control proves nothing',
  );

  const second = runWorker(fixture, [
    user(`build the thing ${TURN_ONE_MARK}`), assistant('built it'),
    user('now do the next thing'), assistant('did the next thing'),
  ], sid);

  assert.ok(second.capsulePath, 'the second Stop must still produce a capsule');
  assert.match(
    readFileSync(second.capsulePath, 'utf8'), new RegExp(TURN_ONE_MARK),
    'turn one\'s content is gone after turn two — the capsule was rebuilt rather than continued, and the session\'s history was silently discarded',
  );
});
