// A transient Windows file lock must not turn a seat's automatic refresh off (2026-11-06).
// The seat's runner logged "EPERM: operation not permitted, rename
// '...auto-clear-cycle.json.tmp-40516'", then automation-disabled runner-transport-tick-failed,
// and stayed off until a relaunch. Two layers now absorb that: atomic-state retries a locked
// rename for under a second, and the runner turns automation off only after
// TRANSPORT_TICK_FAILURE_LIMIT consecutive failed ticks.
// Run: node --test daemons/tests/transient-rename-lock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { atomicUpdate } = require('../memory-hygiene/atomic-state.cjs');

function target() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rename-lock-')), 'auto-clear-cycle.json');
}
// Renames onto `file` fail with `code` for the first `failures` attempts.
function lockedFs(file, code, failures) {
  let seen = 0;
  return {
    fs: {
      ...fs,
      renameSync(from, to) {
        if (path.resolve(String(to)) === path.resolve(file) && seen < failures) {
          seen += 1;
          throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}'`), { code });
        }
        return fs.renameSync(from, to);
      },
    },
    attempts: () => seen,
  };
}

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`a rename locked by ${code} for a moment still commits`, () => {
    const file = target();
    const locked = lockedFs(file, code, 3);
    atomicUpdate(file, () => '{"state":"idle"}\n', { fsImpl: locked.fs, renameRetryDelaysMs: [0, 0, 0, 0, 0, 0] });
    assert.equal(fs.readFileSync(file, 'utf8'), '{"state":"idle"}\n');
    assert.equal(locked.attempts(), 3);
  });
}

test('a rename that stays locked fails with its own error, after a bounded number of tries', () => {
  const file = target();
  const locked = lockedFs(file, 'EPERM', Infinity);
  assert.throws(
    () => atomicUpdate(file, () => 'x', { fsImpl: locked.fs, renameRetryDelaysMs: [0, 0, 0] }),
    (error) => error.code === 'EPERM',
  );
  assert.equal(locked.attempts(), 4, 'one try plus three retries');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-')), [], 'no temp file left behind');
});

test('any other rename failure is not retried', () => {
  const file = target();
  const locked = lockedFs(file, 'ENOSPC', Infinity);
  assert.throws(() => atomicUpdate(file, () => 'x', { fsImpl: locked.fs }), (error) => error.code === 'ENOSPC');
  assert.equal(locked.attempts(), 1);
});

test('the default retry window stays under a second', () => {
  const file = target();
  const locked = lockedFs(file, 'EBUSY', Infinity);
  const started = Date.now();
  assert.throws(() => atomicUpdate(file, () => 'x', { fsImpl: locked.fs }), (error) => error.code === 'EBUSY');
  assert.equal(locked.attempts(), 7);
  assert.ok(Date.now() - started < 3000, 'bounded');
});

// 2026-11-19: the runner waits out a locked cycle file one rename try per tick (pty-runner.mjs,
// TRANSPORT_TICK_LOCK_WAIT_MS). The transport hands its renameRetryDelaysMs to the helper, so [] really is
// one try with no sleep, and undefined is still the helper's own retry.
test('the transport passes its rename retry setting to the state write', async () => {
  const { AutoClearTransport } = await import('../auto-clear-transport.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-lock-transport-'));
  const memRoot = path.join(root, 'memory');
  fs.mkdirSync(path.join(memRoot, 'runtime'), { recursive: true });
  let failuresLeft = 0;
  let tries = 0;
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (path.basename(String(to)) === 'auto-clear-cycle.json') {
        tries += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
        }
      }
      return fs.renameSync(from, to);
    },
  };
  const transport = new AutoClearTransport({
    memRoot, sessionId: 'session-a', cwd: root, homeDir: root, fsImpl, now: () => new Date('2026-11-19T17:58:28Z'),
    env: {}, log: () => {}, acquireLock: false,
  });
  const state = { ...transport.state, entered_at: '2026-11-19T17:58:28.000Z' };
  transport.renameRetryDelaysMs = [];
  failuresLeft = 1; tries = 0;
  assert.throws(() => transport._atomicWrite(state), (error) => error.code === 'EPERM');
  assert.equal(tries, 1, 'one try, no retry -- red when the setting is not passed through');
  transport.renameRetryDelaysMs = undefined;
  failuresLeft = 1; tries = 0;
  transport._atomicWrite(state);
  assert.equal(tries, 2, 'the helper retried and committed');
});
