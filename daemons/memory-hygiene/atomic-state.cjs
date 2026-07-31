// atomic-state.cjs -- serialized read-modify-write for shared state files.
//
// THE FAILURE THIS EXISTS FOR: two processes both read a JSON state file, both
// mutate their own copy, both write. The second write silently erases the first
// one's change. Nothing errors. Nothing logs. The only symptom is a field that
// "reverted on its own" hours later. A tmp-file-plus-rename commit does NOT fix
// this: rename makes the write atomic, but the LOST UPDATE happens between the
// read and the write, which rename never sees.
//
// So this module supplies the missing half:
//   1. an exclusive-create lock file, so only one writer is inside the
//      read-modify-write window at a time;
//   2. a DRIFT CHECK -- re-read the file just before committing and compare it
//      against what was read at the start. If it changed, some writer that did
//      not take the lock got in, and we refuse rather than clobber. A refusal
//      that names the drift is worth more than a silent overwrite.
//   3. a tmp-plus-rename commit, so a crash mid-write cannot leave a torn file.
//
// CommonJS on purpose. The consumers are split across module systems (the
// lifecycle daemons are ESM, the heat computer is CJS), and one implementation
// that both can load beats two implementations that drift apart. ESM callers
// load it with createRequire.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_STALE_MS = 15000;
const DEFAULT_POLL_MS = 15;

// Synchronous sleep with no busy-spin. Every consumer here is a synchronous
// hook on a hot path, so an async wait would mean restructuring callers that
// must not be restructured.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* SharedArrayBuffer unavailable */ }
  }
}

function sha(text) {
  return crypto.createHash('sha256')
    .update(text === null ? '\u0000absent' : String(text))
    .digest('hex');
}

function lockPathFor(target) {
  return `${target}.lock`;
}

function readMarker(file, fsImpl) {
  let raw = null;
  let marker = null;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
    try { marker = JSON.parse(raw); } catch { marker = null; }
  } catch { /* absent/unreadable */ }
  return {
    raw,
    marker,
    token: marker && typeof marker.token === 'string' ? marker.token : null,
  };
}

function ownershipFailure(lockFile, detail) {
  const failure = new Error(`ATOMIC_STATE ownership refusal on ${lockFile}: ${detail}`);
  failure.code = 'ELOCKOWNERSHIP';
  return failure;
}

function markerFingerprint(marker) {
  const identity = marker.token
    ? ['token', marker.token]
    : ['raw', marker.raw];
  return sha(JSON.stringify(identity)).slice(0, 24);
}

function reapPrefixForLock(lockFile) {
  return `${lockFile}.reap-`;
}

function newReapPath(lockFile, expected) {
  const operationToken = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  return `${reapPrefixForLock(lockFile)}${operationToken}-${markerFingerprint(expected)}`;
}

function reapEntries(lockFile, fsImpl) {
  const directory = path.dirname(lockFile);
  const basenamePrefix = path.basename(reapPrefixForLock(lockFile));
  let names = [];
  try { names = fsImpl.readdirSync(directory); } catch { return []; }
  return names.flatMap((name) => {
    if (!name.startsWith(basenamePrefix)) return [];
    const suffix = name.slice(basenamePrefix.length);
    const match = suffix.match(/^\d+-[0-9a-f]{24}-([0-9a-f]{24})$/);
    return match ? [{ file: path.join(directory, name), expectedFingerprint: match[1] }] : [];
  });
}

// A rename moves one exact directory entry to an operation-unique quarantine.
// From that point onward the actor touches only its own quarantine pathname,
// never the canonical lock pathname. If it moved the expected generation it
// deletes the quarantine; if a successor won the race, it restores it. The
// expected fingerprint in the quarantine name lets any later acquirer finish
// either action after a crash, without guessing ownership or deleting a newer
// canonical marker.
function recoverReaps(lockFile, fsImpl) {
  let changed = false;
  for (const entry of reapEntries(lockFile, fsImpl)) {
    const moved = readMarker(entry.file, fsImpl);
    if (markerFingerprint(moved) === entry.expectedFingerprint) {
      try { fsImpl.unlinkSync(entry.file); changed = true; } catch { /* another helper finished */ }
      continue;
    }
    if (!fsImpl.existsSync(lockFile)) {
      try { fsImpl.renameSync(entry.file, lockFile); changed = true; } catch { /* canonical won */ }
    }
  }
  return { changed, remaining: reapEntries(lockFile, fsImpl).length };
}

function guardedDelete(lockFile, expected, fsImpl) {
  const reapFile = newReapPath(lockFile, expected);
  try {
    fsImpl.renameSync(lockFile, reapFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }

  const moved = readMarker(reapFile, fsImpl);
  const matches = expected.token
    ? moved.token === expected.token
    : moved.raw === expected.raw;
  if (matches) {
    try { fsImpl.unlinkSync(reapFile); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    return true;
  }
  recoverReaps(lockFile, fsImpl);
  return false;
}

// Exclusive create is the acquisition mechanism: 'wx' succeeds for exactly one
// caller and throws EEXIST for every other. A lock older than staleMs is treated
// as abandoned (the holder crashed) and broken through guardedDelete -- without
// recovery, a single crash would wedge the state file until manual cleanup.
//
// Every acquisition stamps a fresh pid+random TOKEN into the marker, and that token
// is what makes release safe -- see releaseLock. A pid would not do: pids are
// reused, and one process can legitimately hold the same lock twice in sequence,
// so a pid comparison would match in exactly the case that has to fail.
function acquireLock(target, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    pollMs = DEFAULT_POLL_MS,
    fsImpl = fs,
    now = () => Date.now(),
  } = options;
  const lockFile = lockPathFor(target);
  const deadline = now() + timeoutMs;
  let brokeStale = false;

  for (;;) {
    fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });
    const recovered = recoverReaps(lockFile, fsImpl);
    if (recovered.remaining) {
      if (now() >= deadline) {
        const failure = new Error(`ATOMIC_STATE lock timeout after ${timeoutMs}ms on ${lockFile}`);
        failure.code = 'ELOCKTIMEOUT';
        throw failure;
      }
      sleepSync(pollMs);
      continue;
    }
    try {
      const token = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
      const fd = fsImpl.openSync(lockFile, 'wx');
      try {
        fsImpl.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      } finally {
        fsImpl.closeSync(fd);
      }
      // A reaper can move the prior generation after our pre-check but before
      // this exclusive create. Never commit while any such quarantine remains:
      // roll our speculative marker back through the same token-owned boundary,
      // help finish restore/delete, and honor the caller's deadline.
      if (recoverReaps(lockFile, fsImpl).remaining) {
        guardedDelete(lockFile, { token }, fsImpl);
        recoverReaps(lockFile, fsImpl);
        if (now() >= deadline) {
          const failure = new Error(`ATOMIC_STATE lock timeout after ${timeoutMs}ms on ${lockFile}`);
          failure.code = 'ELOCKTIMEOUT';
          throw failure;
        }
        sleepSync(pollMs);
        continue;
      }
      if (readMarker(lockFile, fsImpl).token !== token) {
        continue;
      }
      return { lockFile, brokeStale, token, stamped: true };
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      if (recoverReaps(lockFile, fsImpl).remaining) {
        if (now() >= deadline) {
          const failure = new Error(`ATOMIC_STATE lock timeout after ${timeoutMs}ms on ${lockFile}`);
          failure.code = 'ELOCKTIMEOUT';
          throw failure;
        }
        sleepSync(pollMs);
        continue;
      }
      let observed = null;
      let age = 0;
      try {
        // Read BEFORE stat. A successor committed after stat returns is exactly
        // the interleaving guardedDelete's rename quarantine must catch.
        observed = readMarker(lockFile, fsImpl);
        observed.stat = fsImpl.statSync(lockFile);
        age = now() - observed.stat.mtimeMs;
      } catch { age = 0; }
      if (age > staleMs) {
        if (!guardedDelete(lockFile, observed, fsImpl)) continue;
        brokeStale = true;
        continue;
      }
      if (now() >= deadline) {
        const failure = new Error(`ATOMIC_STATE lock timeout after ${timeoutMs}ms on ${lockFile}`);
        failure.code = 'ELOCKTIMEOUT';
        throw failure;
      }
      sleepSync(pollMs);
    }
  }
}

// Release ONLY the lock we still hold.
//
// THE FAILURE THIS EXISTS FOR: a holder that runs longer than staleMs gets its
// lock broken by the next arrival, which then stamps its own marker. When the
// original holder finally reaches its `finally { releaseLock(...) }`, a blind
// unlink deletes the NEW holder's lock -- and the new holder is at that moment
// inside its read-modify-write window. A third writer can then acquire cleanly,
// and mutual exclusion is gone precisely in the path the stale break exists to
// handle. The drift check still prevents a lost update, so this is a liveness
// and refusal-rate defect rather than a corruption one, but a lock that quietly
// stops excluding is worse than one that never claimed to.
//
// So compare tokens through the same rename-quarantine boundary used by stale
// takeover. A mismatch/unreadable marker is a typed, loud refusal; it is never a
// reason to fall through to unlink.
function releaseLock(handle, options = {}) {
  const { fsImpl = fs } = options;
  if (!handle || !handle.lockFile || !handle.token) {
    throw ownershipFailure(handle?.lockFile || '<unknown>', 'unverifiable owner handle; refusing delete');
  }
  recoverReaps(handle.lockFile, fsImpl);
  const onDisk = readMarker(handle.lockFile, fsImpl);
  if (onDisk.token !== handle.token) {
    const detail = onDisk.token
      ? `token changed to ${onDisk.token}; refusing non-owner delete`
      : 'marker missing or unverifiable; refusing delete';
    throw ownershipFailure(handle.lockFile, detail);
  }
  const deleted = guardedDelete(handle.lockFile, { token: handle.token }, fsImpl);
  if (!deleted) {
    throw ownershipFailure(handle.lockFile, 'ownership drifted at delete boundary; refusing delete');
  }
  return { released: true, code: 'RELEASED' };
}

function readOrNull(target, fsImpl) {
  try { return fsImpl.readFileSync(target, 'utf8'); } catch { return null; }
}

function commit(target, text, fsImpl) {
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(tmp, text);
    fsImpl.renameSync(tmp, target);
  } catch (error) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

// mutate(currentText) -> next text, or null/undefined to commit nothing.
// Returns { changed, drift, brokeStale, bytes }. Throws on lock timeout and on
// drift (unless allowDrift, which re-runs the mutation against the newer text --
// correct for append-shaped edits, wrong for anything computed from the old
// value, which is why it is off by default).
function atomicUpdate(target, mutate, options = {}) {
  const { fsImpl = fs, allowDrift = false } = options;
  const handle = acquireLock(target, options);
  try {
    let before = readOrNull(target, fsImpl);
    let beforeSha = sha(before);
    let next = mutate(before);

    let verify = readOrNull(target, fsImpl);
    if (sha(verify) !== beforeSha) {
      if (!allowDrift) {
        const failure = new Error(
          `ATOMIC_STATE drift on ${target}: file changed under the lock, refusing to overwrite`,
        );
        failure.code = 'EDRIFT';
        throw failure;
      }
      before = verify;
      beforeSha = sha(before);
      next = mutate(before);
      verify = readOrNull(target, fsImpl);
      if (sha(verify) !== beforeSha) {
        const failure = new Error(`ATOMIC_STATE drift on ${target}: still moving after a retry`);
        failure.code = 'EDRIFT';
        throw failure;
      }
    }

    if (next === null || next === undefined) {
      return {
        changed: false, drift: false, brokeStale: handle.brokeStale, bytes: 0,
      };
    }
    const text = String(next);
    commit(target, text, fsImpl);
    return {
      changed: text !== before,
      drift: false,
      brokeStale: handle.brokeStale,
      bytes: Buffer.byteLength(text),
    };
  } finally {
    releaseLock(handle, options);
  }
}

// JSON convenience. mutate(object) may return a new object, or mutate in place
// and return undefined. A file that does not parse is never silently replaced:
// the caller gets the parse error and decides.
function atomicUpdateJson(target, mutate, options = {}) {
  const { indent = 2, createWith } = options;
  return atomicUpdate(target, (text) => {
    let value;
    if (text === null) {
      if (createWith === undefined) {
        const failure = new Error(`ATOMIC_STATE missing file ${target} and no createWith default`);
        failure.code = 'ENOENT';
        throw failure;
      }
      value = typeof createWith === 'function'
        ? createWith()
        : JSON.parse(JSON.stringify(createWith));
    } else {
      value = JSON.parse(text);
    }
    const result = mutate(value);
    const out = result === undefined ? value : result;
    if (out === null) return null;
    return `${JSON.stringify(out, null, indent)}\n`;
  }, options);
}

module.exports = {
  acquireLock,
  releaseLock,
  atomicUpdate,
  atomicUpdateJson,
  lockPathFor,
  sleepSync,
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
};
