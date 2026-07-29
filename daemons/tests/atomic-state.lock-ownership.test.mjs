// atomic-state.lock-ownership.test.mjs — releasing a lock you no longer hold.
//
// THE FAILURE: acquireLock breaks a lock older than staleMs, on the assumption
// that its holder crashed. A holder that is merely SLOW has not crashed. When it
// finishes and runs its `finally { releaseLock(handle) }`, a blind unlink deletes
// the lock belonging to whoever broke it — while that writer is inside its own
// read-modify-write window. A third caller then acquires cleanly and two writers
// are in the window at once, which is the exact condition the lock exists to
// prevent, reached through the recovery path meant to preserve it.
//
// The drift check behind the lock still refuses the lost update, so this is a
// mutual-exclusion and refusal-rate defect rather than a corruption one. It is
// tested anyway: a lock that silently stops excluding is worse than no lock,
// because callers reason about the guarantee rather than the implementation.
//
// Staleness is produced by BACKDATING THE LOCK'S MTIME, not by sleeping. A test
// that sleeps 15s to reach DEFAULT_STALE_MS would be slow enough that someone
// eventually deletes it, and the thing under test is the age comparison, not the
// passage of time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acquireLock, releaseLock, lockPathFor, atomicUpdateJson } =
  require('../memory-hygiene/atomic-state.cjs');

function freshTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-'));
  const target = path.join(dir, 'BODY_STATE.json');
  fs.writeFileSync(target, `${JSON.stringify({ state: { last_capsule: null } }, null, 2)}\n`);
  return { dir, target };
}

function backdate(lockFile, ms) {
  const when = (Date.now() - ms) / 1000;
  fs.utimesSync(lockFile, when, when);
}

describe('atomic-state lock ownership', () => {
  it('a slow holder does NOT delete the lock of the writer that broke it', () => {
    const { dir, target } = freshTarget();
    try {
      const slow = acquireLock(target, { timeoutMs: 500 });
      backdate(lockPathFor(target), 20_000);

      const breaker = acquireLock(target, { timeoutMs: 500 });
      assert.equal(breaker.brokeStale, true, 'setup: the second acquire should have broken a stale lock');
      assert.notEqual(breaker.token, slow.token, 'setup: each acquisition must stamp a distinct token');

      // The slow holder finally reaches its finally-block.
      releaseLock(slow);

      assert.equal(
        fs.existsSync(lockPathFor(target)),
        true,
        'the breaker\'s lock was deleted by the previous holder — mutual exclusion is lost while the breaker is still inside its write window',
      );

      // And the guarantee that follows from it: nobody else can walk in.
      assert.throws(
        () => acquireLock(target, { timeoutMs: 50, staleMs: 60_000 }),
        (e) => e.code === 'ELOCKTIMEOUT',
        'a third caller acquired while the breaker still held the lock',
      );

      releaseLock(breaker);
      assert.equal(fs.existsSync(lockPathFor(target)), false, 'the real owner must still be able to release');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The control. A release that never releases anything would pass the test
  // above and wedge every state file in the vault for staleMs. Ownership has to
  // be checked in BOTH directions or the fix is just a different outage.
  it('the ordinary holder still releases its own lock', () => {
    const { dir, target } = freshTarget();
    try {
      const handle = acquireLock(target, { timeoutMs: 500 });
      assert.equal(fs.existsSync(lockPathFor(target)), true);
      releaseLock(handle);
      assert.equal(fs.existsSync(lockPathFor(target)), false, 'a lock the caller does own was not released');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // End-to-end through the public entry point, so the property is pinned at the
  // level callers actually use rather than only on the primitives.
  it('atomicUpdateJson leaves no lock behind and commits the mutation', () => {
    const { dir, target } = freshTarget();
    try {
      const result = atomicUpdateJson(target, (body) => {
        body.state.last_capsule = { id: 'cap-1' };
        return body;
      });
      assert.equal(result.changed, true);
      assert.equal(fs.existsSync(lockPathFor(target)), false, 'lock leaked after a successful update');
      assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).state.last_capsule.id, 'cap-1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A tokenless marker (the write inside acquireLock is best-effort) must not
  // wedge the file. This pins the deliberate fall-through in releaseLock so a
  // later tightening cannot turn an unresolvable case into a permanent lock.
  it('a marker with no token still releases, rather than wedging the state file', () => {
    const { dir, target } = freshTarget();
    try {
      const handle = acquireLock(target, { timeoutMs: 500 });
      fs.writeFileSync(lockPathFor(target), '');
      releaseLock(handle);
      assert.equal(
        fs.existsSync(lockPathFor(target)),
        false,
        'an unreadable marker must fall through to release, not hold the lock for staleMs',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
