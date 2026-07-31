// stop-capsule-writer.lock-ownership.test.mjs — F005 wiring and invariants.
//
// The primitive owns lock acquisition, stale recovery, and token-checked
// release. These black-box cases pin Stop's separate contract: contention is an
// immediate exit-0 defer with byte-identical state, while the ordinary worker
// still flushes and cleans up its session lock.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { acquireLock, releaseLock, lockPathFor } =
  require('../memory-hygiene/atomic-state.cjs');
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(TEST_DIR, '..', 'stop-capsule-writer.mjs');

function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'stop-lock-ownership-'));
  const root = path.join(base, 'project');
  const memory = path.join(root, 'memory');
  const runtime = path.join(memory, 'runtime', 'stop-writer');
  mkdirSync(path.join(memory, 'capsules'), { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(memory, 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  return { base, root, memory, runtime };
}

function worker(box, sessionId, transcriptText) {
  const transcript = path.join(box.root, `${sessionId}.jsonl`);
  writeFileSync(transcript, transcriptText);
  const payload = {
    __root: box.root,
    session_id: sessionId,
    transcript_path: transcript,
  };
  return {
    transcript,
    run: spawnSync(process.execPath, [DAEMON, '--worker', JSON.stringify(payload)], {
      cwd: box.root,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: {
        ...process.env,
        AIGENT_ROOT: box.root,
        AIGENT_STATE_HOME_DIR: '',
        AIGENT_SEAT_ID: '',
        CLAUDE_PROJECT_DIR: '',
        LIFECYCLE_KILL_STOP_WRITER: '0',
      },
    }),
  };
}

const event = `${JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'F005 ordinary worker sentinel' }] },
})}\n`;

test('Stop writer delegates its session lock to atomic-state instead of hand-rolled stealing', () => {
  const source = readFileSync(DAEMON, 'utf8');
  assert.match(
    source,
    /const\s*\{[\s\S]*?\bacquireLock\b[\s\S]*?\breleaseLock\b[\s\S]*?\batomicUpdateJson\b[\s\S]*?\}\s*=\s*require\('\.\/memory-hygiene\/atomic-state\.cjs'\)/,
    'Stop writer must use the one shared ownership-safe lock primitive',
  );
  assert.doesNotMatch(source, /openSync\(lockPath,\s*'wx'\)/, 'hand-rolled exclusive-create returned');
  assert.doesNotMatch(source, /Date\.now\(\)\s*-\s*statSync\(lockPath\)\.mtimeMs/, 'hand-rolled stale steal returned');
});

test('a fresh lock loser exits 0, reports noop:lock-defer, and leaves state untouched', () => {
  const box = fixture();
  const sessionId = 'f005-lock-defer';
  const stateFile = path.join(box.runtime, `${sessionId}.json`);
  const initialState = '{\n  "offset": 7,\n  "capsule_path": null,\n  "last_delta_sha": "UNCHANGED"\n}\n';
  writeFileSync(stateFile, initialState);
  const held = acquireLock(path.join(box.runtime, sessionId), { timeoutMs: 500 });
  try {
    const { run } = worker(box, sessionId, event);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /SWE_OUTCOME:noop:lock-defer/);
    assert.equal(readFileSync(stateFile, 'utf8'), initialState, 'lock loser advanced or rewrote state');
    assert.equal(
      JSON.parse(readFileSync(lockPathFor(path.join(box.runtime, sessionId)), 'utf8')).token,
      held.token,
      'lock loser replaced the live owner marker',
    );
  } finally {
    releaseLock(held);
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('the normal worker remains exit-0, flushes, and leaves no lock artifacts', () => {
  const box = fixture();
  const sessionId = 'f005-normal-worker';
  try {
    const { run, transcript } = worker(box, sessionId, event);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /SWE_OUTCOME:flushed/);
    const stateFile = path.join(box.runtime, `${sessionId}.json`);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).offset, Buffer.byteLength(event));
    assert.equal(existsSync(lockPathFor(path.join(box.runtime, sessionId))), false);
    assert.deepEqual(
      readdirSync(box.runtime).filter((name) => name.startsWith(`${sessionId}.lock.reap-`)),
      [],
      'worker left a takeover quarantine behind',
    );
    assert.equal(existsSync(transcript), true, 'test control: transcript unexpectedly vanished');
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});
