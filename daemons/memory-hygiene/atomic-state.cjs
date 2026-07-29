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

// Exclusive create is the whole mechanism: 'wx' succeeds for exactly one caller
// and throws EEXIST for every other. A lock older than staleMs is treated as
// abandoned (the holder crashed) and broken once -- without that, a single crash
// would wedge the state file until someone deleted the lock by hand.
//
// Every acquisition stamps a fresh random TOKEN into the marker, and that token
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
    try {
      fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });
      const token = crypto.randomBytes(8).toString('hex');
      const fd = fsImpl.openSync(lockFile, 'wx');
      let stamped = true;
      try {
        fsImpl.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      } catch { stamped = false; /* the marker content is an aid, not the lock */ }
      fsImpl.closeSync(fd);
      // `stamped` is carried so release can tell "my token is not on disk because
      // someone replaced it" from "my token was never written at all".
      return { lockFile, brokeStale, token, stamped };
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = now() - fsImpl.statSync(lockFile).mtimeMs; } catch { age = 0; }
      if (age > staleMs) {
        try {
          fsImpl.unlinkSync(lockFile);
          brokeStale = true;
          continue;
        } catch { /* another waiter broke it first */ }
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
// So compare tokens. If the marker on disk carries a different token, the lock
// is someone else's now and we leave it alone.
function releaseLock(handle, options = {}) {
  const { fsImpl = fs } = options;
  if (!handle || !handle.lockFile) return;
  if (handle.token && handle.stamped) {
    let onDisk = null;
    try { onDisk = JSON.parse(fsImpl.readFileSync(handle.lockFile, 'utf8')); } catch { onDisk = null; }
    // An unreadable or tokenless marker falls through to the unlink. That keeps
    // the old behaviour for the one case we cannot resolve, and it is the safer
    // direction: releasing a lock we might still own beats wedging the state
    // file for staleMs on every caller that follows.
    if (onDisk && typeof onDisk.token === 'string' && onDisk.token !== handle.token) return;
  }
  try { fsImpl.unlinkSync(handle.lockFile); } catch { /* already gone */ }
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
