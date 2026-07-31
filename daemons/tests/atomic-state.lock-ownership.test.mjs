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
  it('a committed successor is not deleted by a contender that observed the prior stale marker', () => {
    const { dir, target } = freshTarget();
    const lockFile = lockPathFor(target);
    const successorToken = 'committed-successor-token';
    try {
      const expired = acquireLock(target, { timeoutMs: 500 });
      backdate(lockFile, 20_000);

      // Commit the exact bad interleaving at the old mechanism's boundary:
      // A has obtained the stale marker's stat; before A acts on that decision,
      // B removes it and commits a fresh successor marker at the same pathname.
      // Returning A's already-observed stat makes this deterministic rather
      // than asking a scheduler to hit a nanosecond-wide production race.
      let committed = false;
      const fsImpl = new Proxy(fs, {
        get(base, property) {
          if (property === 'statSync') {
            return (candidate, ...args) => {
              const observed = base.statSync(candidate, ...args);
              if (!committed && candidate === lockFile) {
                committed = true;
                base.unlinkSync(lockFile);
                base.writeFileSync(lockFile, JSON.stringify({
                  pid: process.pid,
                  token: successorToken,
                  at: new Date().toISOString(),
                }));
              }
              return observed;
            };
          }
          const value = Reflect.get(base, property);
          return typeof value === 'function' ? value.bind(base) : value;
        },
      });

      let acquired = null;
      let refused = null;
      try {
        acquired = acquireLock(target, {
          fsImpl, timeoutMs: 40, staleMs: 1_000, pollMs: 5,
        });
      } catch (error) {
        refused = error;
      }

      assert.equal(committed, true, 'setup: the successor interleaving must have committed');
      assert.equal(
        refused?.code,
        'ELOCKTIMEOUT',
        `the stale contender acquired after deleting the committed successor (${acquired?.token || 'no token'})`,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(lockFile, 'utf8')).token,
        successorToken,
        'the stale contender replaced or deleted the committed successor marker',
      );

      // The expired handle is now a non-owner; its release must be a loud,
      // typed refusal and must leave the successor untouched.
      assert.throws(
        () => releaseLock(expired),
        (error) => error.code === 'ELOCKOWNERSHIP' && /refus/i.test(error.message),
        'the expired owner release did not report its ownership refusal',
      );
      assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, successorToken);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a slow holder does NOT delete the lock of the writer that broke it', () => {
    const { dir, target } = freshTarget();
    try {
      const slow = acquireLock(target, { timeoutMs: 500 });
      backdate(lockPathFor(target), 20_000);

      const breaker = acquireLock(target, { timeoutMs: 500 });
      assert.equal(breaker.brokeStale, true, 'setup: the second acquire should have broken a stale lock');
      assert.notEqual(breaker.token, slow.token, 'setup: each acquisition must stamp a distinct token');

      // The slow holder finally reaches its finally-block.
      assert.throws(
        () => releaseLock(slow),
        (error) => error.code === 'ELOCKOWNERSHIP' && /refus/i.test(error.message),
        'the expired holder must report that it no longer owns the marker',
      );

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
      assert.match(
        handle.token,
        new RegExp(`^${process.pid}-[0-9a-f]{24}$`),
        'owner token must contain the acquiring pid plus fresh random bytes',
      );
      const marker = JSON.parse(fs.readFileSync(lockPathFor(target), 'utf8'));
      assert.equal(marker.pid, process.pid);
      assert.equal(marker.token, handle.token);
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

  // Ownership must be proved before deletion. A damaged marker is not proof of
  // ownership, so release refuses; once genuinely stale, the guarded recovery
  // path can still reclaim it without weakening release into a blind unlink.
  it('an unverifiable release refuses loudly, then stale recovery reclaims the dead marker', () => {
    const { dir, target } = freshTarget();
    try {
      const handle = acquireLock(target, { timeoutMs: 500 });
      fs.writeFileSync(lockPathFor(target), '');
      assert.throws(
        () => releaseLock(handle),
        (error) => error.code === 'ELOCKOWNERSHIP' && /unverifiable|refus/i.test(error.message),
        'release must name the ownership refusal when the marker cannot prove its token',
      );
      assert.equal(
        fs.existsSync(lockPathFor(target)),
        true,
        'an unverifiable marker must not be blindly deleted',
      );
      backdate(lockPathFor(target), 20_000);
      const recovered = acquireLock(target, { staleMs: 1_000, timeoutMs: 500 });
      assert.equal(recovered.brokeStale, true, 'a genuinely dead damaged marker must be recoverable');
      releaseLock(recovered);
      assert.equal(fs.existsSync(lockPathFor(target)), false, 'recovered lock must release normally');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
