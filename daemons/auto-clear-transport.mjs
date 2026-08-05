// auto-clear-transport.mjs -- PTY-independent auto-clear cycle core.
//
// WHY THIS EXISTS: context pressure, checkpoint completion, and a successful
// clear are three different facts written by three different CLI paths.  Treating
// any attempted action as if it proved the next fact creates the dangerous
// failure mode this module is designed to remove: a stale checkpoint can appear
// to authorize a clear, or a crash can cause the same clear to be submitted
// twice.  This core advances only when the corresponding file observable says
// the fact occurred.
//
// There are deliberately no timers and no "wait, then assume" branches here.
// tick() reads current telemetry, checkpoint records, transcript size, and boot
// receipts.  The later interactive runner may perform actions returned by this
// core, but it may not manufacture transitions.
//
// Persistence uses the repository's atomic-state helper.  Every mutable IO
// boundary is injectable so deterministic tests can supply a clock, filesystem,
// selector result, pressure reader, pid liveness probe, and cycle-id factory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { selectCapsule } from './lifecycle-common.mjs';
import {
  DEFAULT_PRESSURE_FRESHNESS_MS,
  readPressure,
} from './ctx-telemetry.mjs';

const require = createRequire(import.meta.url);
const { atomicUpdate } = require('./memory-hygiene/atomic-state.cjs');

export const DEFAULT_PRESSURE_THRESHOLD_PCT = 80;

// ── CAPSULE ANNOUNCEMENT BUDGET ────────────────────────────────────────────────
// The capsule verb ends with a short acknowledgement (skills/context-capsule,
// step 6). That acknowledgement is a NEW assistant turn, appended to the
// transcript AFTER the stop-writer captured its offset — so the checkpoint used
// to read the capsule as stale and hold on `checkpoint-transcript-short`. The
// seat could not clear BECAUSE it had said it was ready to. Measured on a live
// standalone seat 2026-08-04: three separate holds at 1,295 / 1,293 / 1,295
// bytes. A constant, not a race.
//
// The fix is a BOUNDED budget, not an open tolerance: cap the announcement at a
// known length, and the maximum bytes that can legitimately land after the
// capture becomes arithmetic instead of a guess.
//
//   ANNOUNCEMENT_MAX_CHARS  the cap the skill enforces on its own closing line.
//   ENTRY_ENVELOPE_MAX      what a transcript entry costs BEFORE its text. This
//                           is measured, not assumed: 72 short assistant entries
//                           sampled from a real transcript gave envelope
//                           overhead min 1,249 / median 1,279 / MAX 1,361. The
//                           max is used deliberately.
//   +5%                     the principal's margin, on his instruction.
//
// Anything larger than this budget is NOT one capped acknowledgement — it is a
// second turn, or real work the capsule does not know about, and it must still
// hold. That is the property this preserves: the check keeps failing for the
// reason it was written, and stops failing for the reason it was not.
export const CAPSULE_ANNOUNCEMENT_MAX_CHARS = 120;
export const TRANSCRIPT_ENTRY_ENVELOPE_MAX = 1361;
// The announcement is not the only thing that lands after the capture. The
// harness appends ATTACHMENT records (injected context: ctx telemetry etc.)
// behind a turn — measured at rest on a live seat 2026-08-04: 1,295 bytes
// (a 670 + 457 pair plus newlines), three separate observations. The first
// budget covered the announcement alone and the live seat held at lag 2,612 =
// announcement entry (~1,317) + attachment pair (~1,295). Allowance is the
// measured pair with headroom.
export const TRAILING_ATTACHMENT_ALLOWANCE = 1400;
export const CHECKPOINT_TAIL_TOLERANCE_BYTES = Math.ceil(
  (TRANSCRIPT_ENTRY_ENVELOPE_MAX
    + CAPSULE_ANNOUNCEMENT_MAX_CHARS
    + TRAILING_ATTACHMENT_ALLOWANCE) * 1.05,
);
// Discrimination, kept where it cannot rot: tolerance is 3,026. The live
// legitimate case (2,612) passes; two real turns plus attachments (~3,900)
// still hold. A second SUBSTANTIVE turn — any turn carrying actual work —
// blows past the budget on envelope alone the moment attachments trail it.
// The check keeps failing for the reason it was written.
export const CYCLE_STATES = Object.freeze([
  'idle',
  'pressure',
  'checkpoint-requested',
  'checkpoint-confirmed',
  'clear-submitted',
  'clear-verified',
  'released',
]);

const CYCLE_FILE = 'auto-clear-cycle.json';
const RUNNER_LOCK_FILE = 'auto-clear-transport.lock';
const OFF_FILE = 'auto-clear-off';
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUIRED_STATE_FIELDS = Object.freeze([
  'state',
  'cycle_id',
  'session_id',
  'boot_sequence_at_start',
  'clear_intent',
  'entered_at',
  'hold',
]);

function hasOwn(value, field) {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, field);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dateFromClock(now) {
  const raw = typeof now === 'function' ? now() : now;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError('transport clock returned an invalid date');
  return date;
}

function clockMs(now) {
  return dateFromClock(now).getTime();
}

function clockIso(now) {
  return dateFromClock(now).toISOString();
}

function oneLine(value, maximum = 1200) {
  return JSON.stringify(
    String(value ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, maximum),
  );
}

function defaultLog({ memRoot, fsImpl, now }, message) {
  const line = `${clockIso(now)} tag="auto-clear-transport" message=${oneLine(message)}\n`;
  try {
    fsImpl.appendFileSync(path.join(memRoot, '.daemon-errors.log'), line);
  } catch {
    try { fsImpl.writeSync(2, line); } catch { /* truly nowhere to log */ }
  }
}

function makeLogger(options) {
  const target = typeof options.log === 'function'
    ? options.log
    : (message) => defaultLog(options, message);
  return (message) => {
    try { target(message); } catch { /* diagnostics never own a transition */ }
  };
}

function statePath(memRoot) {
  return path.join(String(memRoot), 'runtime', CYCLE_FILE);
}

function runnerLockPath(memRoot) {
  return path.join(String(memRoot), 'runtime', RUNNER_LOCK_FILE);
}

function offPath(memRoot) {
  return path.join(String(memRoot), 'runtime', OFF_FILE);
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export class RunnerLockError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'RunnerLockError';
    this.code = 'ERUNNERLIVE';
    this.exitCode = 1;
    this.detail = detail;
  }
}

export class TransitionRefusedError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'TransitionRefusedError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Exclusive process-liveness lock for the future runner.
 *
 * The marker intentionally carries both pid and start time.  A live marker is
 * a loud nonzero refusal; a dead or malformed marker is reclaimed once and
 * recorded in the daemon error log.
 */
export function acquireRunnerLock({
  memRoot,
  fsImpl = fs,
  now = () => new Date(),
  pid = process.pid,
  isPidAlive = defaultPidAlive,
  log,
} = {}) {
  const memoryRoot = String(memRoot || '');
  if (!memoryRoot) throw new TypeError('memRoot is required for the runner lock');
  const logger = makeLogger({ memRoot: memoryRoot, fsImpl, now, log });
  const lockFile = runnerLockPath(memoryRoot);
  fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = clockIso(now);
    let fd;
    try {
      fd = fsImpl.openSync(lockFile, 'wx');
      const marker = { pid, started_at: startedAt };
      try {
        fsImpl.writeFileSync(fd, `${JSON.stringify(marker)}\n`);
      } finally {
        fsImpl.closeSync(fd);
      }
      return { path: lockFile, pid, started_at: startedAt };
    } catch (error) {
      if (fd !== undefined) {
        try { fsImpl.closeSync(fd); } catch { /* already closed */ }
      }
      if (error?.code !== 'EEXIST') throw error;

      let holder = null;
      try { holder = JSON.parse(fsImpl.readFileSync(lockFile, 'utf8')); } catch { /* malformed is stale */ }
      const holderHasGuards = hasOwn(holder, 'pid')
        && Number.isInteger(holder.pid)
        && hasOwn(holder, 'started_at')
        && typeof holder.started_at === 'string';
      if (holderHasGuards && isPidAlive(holder.pid)) {
        const detail = { pid: holder.pid, started_at: holder.started_at, path: lockFile };
        logger(`live runner lock refused pid=${holder.pid} started_at=${holder.started_at}`);
        throw new RunnerLockError(
          `HOLD:runner-live pid=${holder.pid} started_at=${holder.started_at}`,
          detail,
        );
      }

      try {
        fsImpl.unlinkSync(lockFile);
        logger(
          holderHasGuards
            ? `stale runner lock reclaimed pid=${holder.pid} started_at=${holder.started_at}`
            : 'stale runner lock reclaimed because required marker fields were absent',
        );
      } catch (unlinkError) {
        if (attempt === 1) throw unlinkError;
      }
    }
  }
  throw new RunnerLockError('HOLD:runner-lock-race', { path: lockFile });
}

export function releaseRunnerLock(handle, { fsImpl = fs } = {}) {
  if (!handle?.path) return false;
  let marker;
  try { marker = JSON.parse(fsImpl.readFileSync(handle.path, 'utf8')); } catch { return false; }
  if (!hasOwn(marker, 'pid') || !hasOwn(marker, 'started_at')) return false;
  if (marker.pid !== handle.pid || marker.started_at !== handle.started_at) return false;
  try {
    fsImpl.unlinkSync(handle.path);
    return true;
  } catch {
    return false;
  }
}

export function readKillSwitch({
  memRoot,
  env = process.env,
  fsImpl = fs,
} = {}) {
  if (env?.AUTO_CLEAR_OFF === '1') {
    return { active: true, code: 'kill-switch-env', detail: 'AUTO_CLEAR_OFF=1' };
  }
  const marker = offPath(memRoot);
  try {
    if (fsImpl.existsSync(marker)) {
      return { active: true, code: 'kill-switch-file', detail: marker };
    }
  } catch (error) {
    return {
      active: true,
      code: 'kill-switch-read-failed',
      detail: error?.message || String(error),
    };
  }
  return { active: false, code: null, detail: null };
}

export function slugifyCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptPathFor({
  cwd,
  sessionId,
  homeDir = os.homedir(),
} = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return null;
  return path.join(
    String(homeDir),
    '.claude',
    'projects',
    slugifyCwd(cwd),
    `${sessionId}.jsonl`,
  );
}

function normalizedPath(candidate) {
  const resolved = path.resolve(String(candidate));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function checkpointFailure(code, detail) {
  return { ok: false, code, detail };
}

/**
 * Evaluate all three checkpoint conjuncts against current disk observables.
 */
export function evaluateCheckpointFreshness({
  memRoot,
  sessionId,
  cwd,
  homeDir = os.homedir(),
  fsImpl = fs,
  selectCapsuleFn = selectCapsule,
} = {}) {
  let selection;
  try {
    selection = selectCapsuleFn(memRoot);
  } catch (error) {
    return checkpointFailure('checkpoint-selector-error', error?.message || String(error));
  }
  if (!selection || typeof selection !== 'object' || !hasOwn(selection, 'capsule')) {
    return checkpointFailure(
      'checkpoint-selector-field-missing',
      { field: 'capsule' },
    );
  }
  if (selection.capsule === null) {
    if (!hasOwn(selection, 'rejected')) {
      return checkpointFailure(
        'checkpoint-selector-field-missing',
        { field: 'rejected' },
      );
    }
    if (!Array.isArray(selection.rejected)) {
      return checkpointFailure(
        'checkpoint-selector-field-invalid',
        { field: 'rejected' },
      );
    }
    return checkpointFailure('checkpoint-rejected', {
      unavailable: hasOwn(selection, 'unavailable') ? selection.unavailable : 'selector-unavailable-field-missing',
      rejected: selection.rejected,
    });
  }
  if (!selection.capsule || typeof selection.capsule !== 'object' || !hasOwn(selection.capsule, 'path')) {
    return checkpointFailure(
      'checkpoint-capsule-field-missing',
      { field: 'path' },
    );
  }
  if (typeof selection.capsule.path !== 'string' || selection.capsule.path.length === 0) {
    return checkpointFailure('checkpoint-capsule-path-invalid', selection.capsule.path);
  }

  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) {
    return checkpointFailure('checkpoint-session-id-invalid', sessionId);
  }
  const recordPath = path.join(memRoot, 'runtime', 'stop-writer', `${sessionId}.json`);
  let record;
  try { record = JSON.parse(fsImpl.readFileSync(recordPath, 'utf8')); } catch (error) {
    return checkpointFailure(
      error?.code === 'ENOENT' ? 'checkpoint-record-missing' : 'checkpoint-record-invalid',
      { path: recordPath, error: error?.message || String(error) },
    );
  }
  if (!record || typeof record !== 'object') {
    return checkpointFailure('checkpoint-record-invalid', { path: recordPath });
  }
  for (const field of ['capsule_path', 'offset']) {
    if (!hasOwn(record, field)) {
      return checkpointFailure('checkpoint-record-field-missing', { field, path: recordPath });
    }
  }
  if (typeof record.capsule_path !== 'string' || record.capsule_path.length === 0) {
    return checkpointFailure('checkpoint-record-capsule-path-invalid', record.capsule_path);
  }
  if (!Number.isSafeInteger(record.offset) || record.offset < 0) {
    return checkpointFailure('checkpoint-record-offset-invalid', record.offset);
  }

  // The stop-writer filename is the current session binding; capsule_path is
  // the writer's own link to the capsule it captured.  Requiring both avoids
  // inventing a second binding record or inferring identity from capsule names.
  if (normalizedPath(selection.capsule.path) !== normalizedPath(record.capsule_path)) {
    // The plain call above picks by RESUME QUALITY: lifecycle-common's
    // 2026-08-01 fix demotes a placeholder capsule below any curated capsule
    // on disk, because for RESUME that heuristic is right.  It is wrong for
    // THIS check, which only ever asks "does the checkpoint I just wrote
    // still exist and still hold" -- never "is it also the best capsule on
    // the seat".  Left unresolved, an honest contentless checkpoint on a
    // reference install (which always has a curated capsule sitting on disk)
    // held here on EVERY tick -- measured cycle 5, zero cycles ever counted.
    // Retry naming the session's OWN capsule by path before concluding a real
    // mismatch: identity binding beats the quality heuristic for this one
    // selection (2026-08-03 fix; see selectCapsule's sessionCapsulePath).
    let boundSelection = null;
    try {
      boundSelection = selectCapsuleFn(memRoot, { sessionCapsulePath: record.capsule_path });
    } catch {
      boundSelection = null; // selector rejected the retry -- fall through to the real mismatch below
    }
    const boundPath = boundSelection
      && typeof boundSelection === 'object'
      && boundSelection.capsule
      && typeof boundSelection.capsule === 'object'
      && typeof boundSelection.capsule.path === 'string'
      ? boundSelection.capsule.path
      : null;
    if (boundPath && normalizedPath(boundPath) === normalizedPath(record.capsule_path)) {
      selection = boundSelection;
    } else {
      return checkpointFailure('checkpoint-session-mismatch', {
        selected_capsule: selection.capsule.path,
        stop_writer_capsule: record.capsule_path,
        session_id: sessionId,
      });
    }
  }

  const transcriptPath = transcriptPathFor({ cwd, sessionId, homeDir });
  if (!transcriptPath) {
    return checkpointFailure('checkpoint-transcript-path-invalid', { cwd, session_id: sessionId });
  }
  let transcript;
  try { transcript = fsImpl.statSync(transcriptPath); } catch (error) {
    return checkpointFailure(
      error?.code === 'ENOENT' ? 'checkpoint-transcript-missing' : 'checkpoint-transcript-unreadable',
      { path: transcriptPath, error: error?.message || String(error) },
    );
  }
  if (!hasOwn(transcript, 'size') || !Number.isSafeInteger(transcript.size) || transcript.size < 0) {
    return checkpointFailure('checkpoint-transcript-size-missing', { path: transcriptPath });
  }
  // A lag up to the announcement budget is EXPECTED — see
  // CHECKPOINT_TAIL_TOLERANCE_BYTES. Beyond it, the capsule genuinely does not
  // cover the conversation and the hold is correct.
  if (transcript.size - record.offset > CHECKPOINT_TAIL_TOLERANCE_BYTES) {
    return checkpointFailure('checkpoint-transcript-short', {
      captured_offset: record.offset,
      stable_size: transcript.size,
      lag_bytes: transcript.size - record.offset,
      tolerance_bytes: CHECKPOINT_TAIL_TOLERANCE_BYTES,
      path: transcriptPath,
    });
  }
  if (record.offset > transcript.size) {
    return checkpointFailure('checkpoint-transcript-ahead', {
      captured_offset: record.offset,
      stable_size: transcript.size,
      path: transcriptPath,
    });
  }

  return {
    ok: true,
    capsule: clone(selection.capsule),
    rejected: hasOwn(selection, 'rejected') ? clone(selection.rejected) : [],
    // Additive-only field: true exactly when the mismatch retry above resolved
    // by session binding rather than the plain call already agreeing. Absent
    // (undefined) on every path that existed before this fix, so no existing
    // equality assertion on this shape changes.
    sessionBound: Boolean(selection.sessionBound),
    record: clone(record),
    transcript: { path: transcriptPath, size: transcript.size },
  };
}

function initialState(sessionId, enteredAt) {
  return {
    state: 'idle',
    cycle_id: null,
    session_id: String(sessionId),
    boot_sequence_at_start: null,
    clear_intent: null,
    entered_at: enteredAt,
    hold: null,
  };
}

function invalidStateReason(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { code: 'cycle-state-invalid', detail: 'root object missing' };
  }
  const absent = REQUIRED_STATE_FIELDS.filter((field) => !hasOwn(value, field));
  if (absent.length) {
    return { code: 'cycle-state-field-missing', detail: { fields: absent } };
  }
  if (typeof value.state !== 'string') {
    return { code: 'cycle-state-field-invalid', detail: { field: 'state' } };
  }
  if (value.cycle_id !== null && typeof value.cycle_id !== 'string') {
    return { code: 'cycle-state-field-invalid', detail: { field: 'cycle_id' } };
  }
  if (typeof value.session_id !== 'string') {
    return { code: 'cycle-state-field-invalid', detail: { field: 'session_id' } };
  }
  if (value.boot_sequence_at_start !== null
    && (!Number.isSafeInteger(value.boot_sequence_at_start) || value.boot_sequence_at_start < 0)) {
    return { code: 'cycle-state-field-invalid', detail: { field: 'boot_sequence_at_start' } };
  }
  if (typeof value.entered_at !== 'string' || !Number.isFinite(Date.parse(value.entered_at))) {
    return { code: 'cycle-state-field-invalid', detail: { field: 'entered_at' } };
  }
  if (value.clear_intent !== null) {
    if (!value.clear_intent || typeof value.clear_intent !== 'object') {
      return { code: 'cycle-state-field-invalid', detail: { field: 'clear_intent' } };
    }
    for (const field of ['written_at', 'submitted']) {
      if (!hasOwn(value.clear_intent, field)) {
        return { code: 'cycle-state-field-missing', detail: { fields: [`clear_intent.${field}`] } };
      }
    }
    if (typeof value.clear_intent.written_at !== 'string'
      || !Number.isFinite(Date.parse(value.clear_intent.written_at))
      || typeof value.clear_intent.submitted !== 'boolean') {
      return { code: 'cycle-state-field-invalid', detail: { field: 'clear_intent' } };
    }
  }
  if (value.hold !== null) {
    if (!value.hold || typeof value.hold !== 'object') {
      return { code: 'cycle-state-field-invalid', detail: { field: 'hold' } };
    }
    for (const field of ['code', 'detail']) {
      if (!hasOwn(value.hold, field)) {
        return { code: 'cycle-state-field-missing', detail: { fields: [`hold.${field}`] } };
      }
    }
    if (typeof value.hold.code !== 'string') {
      return { code: 'cycle-state-field-invalid', detail: { field: 'hold.code' } };
    }
  }
  if (!CYCLE_STATES.includes(value.state) && !value.state.startsWith('HOLD:')) {
    return { code: 'cycle-state-name-invalid', detail: value.state };
  }
  if (value.state.startsWith('HOLD:') && value.hold === null) {
    return { code: 'cycle-state-field-missing', detail: { fields: ['hold'] } };
  }
  if (value.state.startsWith('HOLD:')
    && value.hold?.code !== value.state.slice('HOLD:'.length)) {
    return {
      code: 'cycle-state-hold-mismatch',
      detail: { state: value.state, hold_code: value.hold?.code },
    };
  }
  if (!value.state.startsWith('HOLD:') && value.hold !== null) {
    return { code: 'cycle-state-field-invalid', detail: { field: 'hold' } };
  }
  if (value.state === 'clear-submitted' && value.clear_intent === null) {
    return { code: 'cycle-state-field-missing', detail: { fields: ['clear_intent'] } };
  }
  return null;
}

function bootReceiptProblem(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { code: 'boot-receipt-invalid', detail: 'root object missing' };
  }
  const absent = ['boot_sequence', 'session_id', 'source', 'observed_at']
    .filter((field) => !hasOwn(receipt, field));
  if (absent.length) return { code: 'boot-receipt-field-missing', detail: { fields: absent } };
  if (!Number.isSafeInteger(receipt.boot_sequence) || receipt.boot_sequence < 0) {
    return { code: 'boot-receipt-field-invalid', detail: { field: 'boot_sequence' } };
  }
  for (const field of ['session_id', 'source', 'observed_at']) {
    if (typeof receipt[field] !== 'string') {
      return { code: 'boot-receipt-field-invalid', detail: { field } };
    }
  }
  if (!Number.isFinite(Date.parse(receipt.observed_at))) {
    return { code: 'boot-receipt-field-invalid', detail: { field: 'observed_at' } };
  }
  return null;
}

function holdState(current, code, detail, enteredAt, resumeState) {
  let renderedDetail = detail;
  if (renderedDetail && typeof renderedDetail === 'object' && !Array.isArray(renderedDetail)) {
    renderedDetail = { ...renderedDetail, resume_state: resumeState };
  } else {
    renderedDetail = { value: renderedDetail, resume_state: resumeState };
  }
  return {
    ...current,
    state: `HOLD:${code}`,
    entered_at: enteredAt,
    hold: { code, detail: renderedDetail },
  };
}

function resultFor(state, extras = {}) {
  return {
    state: clone(state),
    transitioned: Boolean(extras.transitioned),
    ...extras,
  };
}

export class AutoClearTransport {
  constructor({
    memRoot,
    sessionId,
    cwd,
    homeDir = os.homedir(),
    fsImpl = fs,
    now = () => new Date(),
    env = process.env,
    pressureThresholdPct = DEFAULT_PRESSURE_THRESHOLD_PCT,
    pressureFreshnessMs = DEFAULT_PRESSURE_FRESHNESS_MS,
    selectCapsuleFn = selectCapsule,
    readPressureFn = readPressure,
    idFactory,
    log,
    acquireLock = true,
    pid = process.pid,
    isPidAlive = defaultPidAlive,
  } = {}) {
    if (!memRoot) throw new TypeError('memRoot is required');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('sessionId is required');
    }
    if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('cwd is required');
    if (!Number.isFinite(pressureThresholdPct) || pressureThresholdPct < 0) {
      throw new TypeError('pressureThresholdPct must be a non-negative number');
    }

    this.memRoot = String(memRoot);
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.homeDir = String(homeDir);
    this.fs = fsImpl;
    this.now = now;
    this.env = env;
    this.pressureThresholdPct = pressureThresholdPct;
    this.pressureFreshnessMs = pressureFreshnessMs;
    this.selectCapsuleFn = selectCapsuleFn;
    this.readPressureFn = readPressureFn;
    this.idFactory = typeof idFactory === 'function'
      ? idFactory
      : ({ sessionId: sid, bootSequence, enteredAt }) => `${sid}:${bootSequence}:${enteredAt}`;
    this.log = makeLogger({ memRoot: this.memRoot, fsImpl: this.fs, now: this.now, log });
    this.cyclePath = statePath(this.memRoot);
    this.lockHandle = acquireLock
      ? acquireRunnerLock({
        memRoot: this.memRoot,
        fsImpl: this.fs,
        now: this.now,
        pid,
        isPidAlive,
        log: this.log,
      })
      : null;
    this._activeToken = null;
    try {
      this.state = this._loadState();
      this._inheritedIntent = this.state.clear_intent !== null;
    } catch (error) {
      releaseRunnerLock(this.lockHandle, { fsImpl: this.fs });
      this.lockHandle = null;
      throw error;
    }
  }

  _atomicWrite(next) {
    atomicUpdate(
      this.cyclePath,
      () => `${JSON.stringify(next, null, 2)}\n`,
      { fsImpl: this.fs, now: () => clockMs(this.now) },
    );
    this.state = next;
    return next;
  }

  _loadState() {
    let text = null;
    try { text = this.fs.readFileSync(this.cyclePath, 'utf8'); } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`cycle state read failed: ${error?.message || error}`);
    }
    if (text === null) {
      return this._atomicWrite(initialState(this.sessionId, clockIso(this.now)));
    }

    let parsed;
    try { parsed = JSON.parse(text); } catch (error) {
      const base = initialState(this.sessionId, clockIso(this.now));
      const held = holdState(
        base,
        'cycle-state-invalid',
        error?.message || String(error),
        clockIso(this.now),
        'idle',
      );
      this.log(`cycle state invalid; held closed: ${error?.message || error}`);
      return this._atomicWrite(held);
    }
    const problem = invalidStateReason(parsed);
    if (!problem) return parsed;
    const base = {
      ...initialState(this.sessionId, clockIso(this.now)),
      cycle_id: typeof parsed?.cycle_id === 'string' ? parsed.cycle_id : null,
      boot_sequence_at_start: Number.isSafeInteger(parsed?.boot_sequence_at_start)
        ? parsed.boot_sequence_at_start
        : null,
    };
    const held = holdState(base, problem.code, problem.detail, clockIso(this.now), 'idle');
    this.log(`${problem.code}; held closed: ${JSON.stringify(problem.detail)}`);
    return this._atomicWrite(held);
  }

  _refreshState() {
    let parsed;
    try { parsed = JSON.parse(this.fs.readFileSync(this.cyclePath, 'utf8')); } catch (error) {
      return this._hold('cycle-state-invalid', error?.message || String(error), 'idle');
    }
    const problem = invalidStateReason(parsed);
    if (problem) return this._hold(problem.code, problem.detail, 'idle');
    this.state = parsed;
    return this.state;
  }

  _transition(nextState, changes = {}) {
    const next = {
      ...this.state,
      ...changes,
      state: nextState,
      entered_at: clockIso(this.now),
      hold: null,
    };
    return this._atomicWrite(next);
  }

  _hold(code, detail, resumeState = this.state.state) {
    const next = holdState(this.state, code, detail, clockIso(this.now), resumeState);
    this.log(`HOLD:${code} ${JSON.stringify(next.hold.detail)}`);
    return this._atomicWrite(next);
  }

  _holdResult(code, detail, resumeState = this.state.state) {
    const next = this._hold(code, detail, resumeState);
    return resultFor(next, {
      transitioned: true,
      status: 'hold',
      code,
      detail: clone(next.hold.detail),
    });
  }

  _readBootReceipt() {
    const target = path.join(this.memRoot, 'runtime', 'boot-receipt.json');
    let receipt;
    try { receipt = JSON.parse(this.fs.readFileSync(target, 'utf8')); } catch (error) {
      return {
        ok: false,
        code: error?.code === 'ENOENT' ? 'boot-receipt-missing' : 'boot-receipt-invalid',
        detail: { path: target, error: error?.message || String(error) },
      };
    }
    const problem = bootReceiptProblem(receipt);
    if (problem) return { ok: false, ...problem };
    return { ok: true, receipt };
  }

  _pressureObservable() {
    let observation;
    try {
      observation = this.readPressureFn({
        sessionId: this.sessionId,
        homeDir: this.homeDir,
        staleAfterMs: this.pressureFreshnessMs,
        fsImpl: this.fs,
        now: this.now,
      });
    } catch (error) {
      return { ok: false, code: 'telemetry-read-failed', detail: error?.message || String(error) };
    }
    if (!observation || typeof observation !== 'object') {
      return { ok: false, code: 'telemetry-invalid', detail: 'root object missing' };
    }
    const absent = ['pct', 'fresh', 'state'].filter((field) => !hasOwn(observation, field));
    if (absent.length) {
      return { ok: false, code: 'telemetry-field-missing', detail: { fields: absent } };
    }
    if (!['ok', 'stale', 'missing'].includes(observation.state)) {
      return { ok: false, code: 'telemetry-state-invalid', detail: observation.state };
    }
    if (observation.state !== 'ok') {
      return {
        ok: false,
        code: `telemetry-${observation.state}`,
        detail: { pct: observation.pct, fresh: observation.fresh, state: observation.state },
      };
    }
    if (observation.fresh !== true) {
      return {
        ok: false,
        code: 'telemetry-fresh-invalid',
        detail: { pct: observation.pct, fresh: observation.fresh, state: observation.state },
      };
    }
    if (typeof observation.pct !== 'number' || !Number.isFinite(observation.pct)) {
      return { ok: false, code: 'telemetry-pct-invalid', detail: observation.pct };
    }
    return { ok: true, observation };
  }

  _checkpointObservable() {
    return evaluateCheckpointFreshness({
      memRoot: this.memRoot,
      sessionId: this.state.session_id,
      cwd: this.cwd,
      homeDir: this.homeDir,
      fsImpl: this.fs,
      selectCapsuleFn: this.selectCapsuleFn,
    });
  }

  _newClearReceipt(receipt) {
    return Number.isSafeInteger(this.state.boot_sequence_at_start)
      && receipt.source === 'clear'
      && receipt.boot_sequence > this.state.boot_sequence_at_start;
  }

  _startPressure(observation) {
    const boot = this._readBootReceipt();
    if (!boot.ok) return this._holdResult(boot.code, boot.detail, 'idle');
    if (boot.receipt.session_id !== this.sessionId) {
      return this._holdResult('boot-receipt-session-mismatch', {
        expected: this.sessionId,
        observed: boot.receipt.session_id,
      }, 'idle');
    }
    const enteredAt = clockIso(this.now);
    const rawCycleId = this.idFactory({
      sessionId: this.sessionId,
      bootSequence: boot.receipt.boot_sequence,
      enteredAt,
      pressure: observation.pct,
    });
    if (typeof rawCycleId !== 'string' || rawCycleId.length === 0) {
      return this._holdResult('cycle-id-invalid', rawCycleId, 'idle');
    }
    const cycleId = rawCycleId;
    const next = this._transition('pressure', {
      cycle_id: cycleId,
      session_id: this.sessionId,
      boot_sequence_at_start: boot.receipt.boot_sequence,
      clear_intent: null,
    });
    return resultFor(next, {
      transitioned: true,
      status: 'pressure',
      observable: clone(observation),
    });
  }

  _resumeStateFromHold() {
    const candidate = this.state?.hold?.detail?.resume_state;
    if (CYCLE_STATES.includes(candidate)) return candidate;
    return 'idle';
  }

  _gateKillSwitch() {
    return readKillSwitch({ memRoot: this.memRoot, env: this.env, fsImpl: this.fs });
  }

  _gatePressure(resumeState) {
    const pressure = this._pressureObservable();
    if (!pressure.ok) return this._holdResult(pressure.code, pressure.detail, resumeState);
    if (pressure.observation.pct < this.pressureThresholdPct) {
      const next = this._transition('idle', {
        cycle_id: null,
        session_id: this.sessionId,
        boot_sequence_at_start: null,
        clear_intent: null,
      });
      return resultFor(next, {
        transitioned: true,
        status: 'below-pressure',
        observable: clone(pressure.observation),
      });
    }
    return { ok: true, pressure: pressure.observation };
  }

  /**
   * Re-derive one persisted position from current observables.
   */
  tick() {
    this._refreshState();
    const killed = this._gateKillSwitch();

    // A manually issued clear is only observed here; this core neither submits
    // nor blocks it.  Check it before the kill switch so an operator's clear can
    // resolve an ambiguous hold even while automatic initiation is disabled.
    if (this.state.state !== 'released'
      && Number.isSafeInteger(this.state.boot_sequence_at_start)) {
      const boot = this._readBootReceipt();
      if (boot.ok && this._newClearReceipt(boot.receipt)) {
        return this.confirmClearObserved(boot.receipt);
      }
    }

    if (this._inheritedIntent
      && this.state.clear_intent !== null
      && !['clear-submitted', 'clear-verified', 'released', 'HOLD:clear-ambiguous']
        .includes(this.state.state)) {
      return this._holdResult('clear-ambiguous', {
        submitted: this.state.clear_intent.submitted,
        written_at: this.state.clear_intent.written_at,
        cycle_id: this.state.cycle_id,
        persisted_state: this.state.state,
      }, this.state.state);
    }

    if (this.state.state === 'clear-verified') {
      const next = this._transition('released');
      return resultFor(next, { transitioned: true, status: 'released' });
    }

    if (this.state.state === 'released') {
      if (this.state.session_id !== this.sessionId) {
        const boot = this._readBootReceipt();
        if (boot.ok && boot.receipt.session_id === this.sessionId) {
          const next = this._transition('idle', {
            cycle_id: null,
            session_id: this.sessionId,
            boot_sequence_at_start: null,
            clear_intent: null,
          });
          return resultFor(next, { transitioned: true, status: 'new-session-idle' });
        }
      }
      return resultFor(this.state, { status: 'released' });
    }

    if (this.state.state === 'HOLD:clear-ambiguous') {
      return resultFor(this.state, {
        status: 'hold',
        code: 'clear-ambiguous',
        detail: clone(this.state.hold.detail),
      });
    }

    if (killed.active) {
      if (this.state.state === 'idle') {
        return resultFor(this.state, {
          status: 'refused',
          code: killed.code,
          detail: killed.detail,
        });
      }
      if (this.state.state === `HOLD:${killed.code}`) {
        return resultFor(this.state, {
          status: 'hold',
          code: killed.code,
          detail: clone(this.state.hold.detail),
        });
      }
      return this._holdResult(killed.code, killed.detail, this.state.state);
    }

    if (this.state.state.startsWith('HOLD:kill-switch')) {
      const resumeState = this._resumeStateFromHold();
      const next = this._transition(resumeState);
      return resultFor(next, { transitioned: true, status: 'kill-switch-cleared' });
    }

    if (this.state.state === 'idle') {
      const pressure = this._pressureObservable();
      if (!pressure.ok) return this._holdResult(pressure.code, pressure.detail, 'idle');
      if (pressure.observation.pct < this.pressureThresholdPct) {
        return resultFor(this.state, {
          status: 'idle',
          observable: clone(pressure.observation),
        });
      }
      return this._startPressure(pressure.observation);
    }

    if (this.state.state.startsWith('HOLD:telemetry-')) {
      // sessionId binds once at session-bind and idle sessions go stale/missing
      // by design, so once wedged here the dead session's telemetry can never
      // freshen and the pressure re-check below can never see a new one. A
      // receipt proving a later, different session cleared is real news
      // regardless of telemetry state: rebind so the next observable is its
      // own, rather than waiting forever on a session that will never post again.
      // NOT gated on source === 'clear'. Requiring a clear here is a deadlock:
      // this transport is the thing that initiates clears, so a transport
      // already wedged in HOLD:telemetry-* can never emit the one event its own
      // recovery depends on. An operator who RESTARTS a stuck seat — the
      // ordinary human response to one — would stay wedged forever. The receipt
      // is the authority on which session is live, and a DIFFERENT session at a
      // strictly LATER boot_sequence is real news however it booted. The
      // same-session / invalid-receipt / replayed-boot_sequence controls below
      // are what keep this honest (cand5-2, -3, -4).
      const boot = this._readBootReceipt();
      if (boot.ok
        && boot.receipt.session_id !== this.sessionId
        && (this.state.boot_sequence_at_start === null
          || boot.receipt.boot_sequence > this.state.boot_sequence_at_start)) {
        this.sessionId = boot.receipt.session_id;
        const next = this._transition('idle', {
          cycle_id: null,
          boot_sequence_at_start: null,
          clear_intent: null,
          session_id: this.sessionId,
        });
        return resultFor(next, { transitioned: true, status: 'telemetry-recovered' });
      }

      const resumeState = this._resumeStateFromHold();
      const pressure = this._pressureObservable();
      if (!pressure.ok) {
        if (this.state.hold.code === pressure.code) {
          return resultFor(this.state, {
            status: 'hold',
            code: pressure.code,
            detail: clone(this.state.hold.detail),
          });
        }
        return this._holdResult(pressure.code, pressure.detail, resumeState);
      }
      if (resumeState === 'idle') {
        if (pressure.observation.pct < this.pressureThresholdPct) {
          const next = this._transition('idle', {
            cycle_id: null,
            boot_sequence_at_start: null,
            clear_intent: null,
            session_id: this.sessionId,
          });
          return resultFor(next, { transitioned: true, status: 'telemetry-recovered' });
        }
        return this._startPressure(pressure.observation);
      }
      const next = this._transition(resumeState);
      return resultFor(next, { transitioned: true, status: 'telemetry-recovered' });
    }

    if (this.state.state === 'pressure') {
      const gate = this._gatePressure('pressure');
      if (!gate.ok) return gate;
      const next = this._transition('checkpoint-requested');
      return resultFor(next, {
        transitioned: true,
        status: 'checkpoint-requested',
        action: 'request-checkpoint',
      });
    }

    if (this.state.state === 'checkpoint-requested') {
      const gate = this._gatePressure('checkpoint-requested');
      if (!gate.ok) return gate;
      const checkpoint = this._checkpointObservable();
      if (!checkpoint.ok) {
        return this._holdResult(checkpoint.code, checkpoint.detail, 'checkpoint-requested');
      }
      const next = this._transition('checkpoint-confirmed');
      return resultFor(next, {
        transitioned: true,
        status: 'checkpoint-confirmed',
        observable: checkpoint,
      });
    }

    if (this.state.state.startsWith('HOLD:checkpoint-')) {
      const gate = this._gatePressure('checkpoint-requested');
      if (!gate.ok) return gate;
      const checkpoint = this._checkpointObservable();
      if (!checkpoint.ok) {
        if (checkpoint.code === this.state.hold.code) {
          return resultFor(this.state, {
            status: 'hold',
            code: checkpoint.code,
            detail: clone(this.state.hold.detail),
          });
        }
        return this._holdResult(checkpoint.code, checkpoint.detail, 'checkpoint-requested');
      }
      const next = this._transition('checkpoint-confirmed');
      return resultFor(next, {
        transitioned: true,
        status: 'checkpoint-confirmed',
        observable: checkpoint,
      });
    }

    if (this.state.state === 'checkpoint-confirmed') {
      const gate = this._gatePressure('checkpoint-confirmed');
      if (!gate.ok) return gate;
      const checkpoint = this._checkpointObservable();
      if (!checkpoint.ok) {
        return this._holdResult(checkpoint.code, checkpoint.detail, 'checkpoint-requested');
      }
      return resultFor(this.state, {
        status: 'checkpoint-confirmed',
        observable: checkpoint,
      });
    }

    if (this.state.state === 'clear-submitted') {
      if (this._inheritedIntent) {
        return this._holdResult('clear-ambiguous', {
          submitted: this.state.clear_intent?.submitted,
          written_at: this.state.clear_intent?.written_at,
          cycle_id: this.state.cycle_id,
        }, 'clear-submitted');
      }
      return resultFor(this.state, {
        status: this.state.clear_intent?.submitted ? 'awaiting-clear-observation' : 'awaiting-submission',
      });
    }

    if (this.state.state.startsWith('HOLD:')) {
      return resultFor(this.state, {
        status: 'hold',
        code: this.state.hold.code,
        detail: clone(this.state.hold.detail),
      });
    }

    return this._holdResult('cycle-state-name-invalid', this.state.state, 'idle');
  }

  /**
   * Persist intent before exposing the only token capable of submission.
   */
  beginClearSubmission() {
    this._refreshState();
    if (this.state.clear_intent !== null || this.state.state === 'clear-submitted') {
      throw new TransitionRefusedError(
        'EDUPLICATE_CLEAR',
        'duplicate clear refused: an intent already exists for this cycle',
        { cycle_id: this.state.cycle_id, clear_intent: clone(this.state.clear_intent) },
      );
    }
    if (this.state.state !== 'checkpoint-confirmed') {
      throw new TransitionRefusedError(
        'ECLEAR_NOT_AUTHORIZED',
        `clear refused from state ${this.state.state}`,
        { state: this.state.state },
      );
    }

    const killed = this._gateKillSwitch();
    if (killed.active) {
      this._hold(killed.code, killed.detail, 'checkpoint-confirmed');
      throw new TransitionRefusedError(
        'ECLEAR_KILLED',
        `clear refused by ${killed.code}`,
        killed.detail,
      );
    }
    const pressure = this._pressureObservable();
    if (!pressure.ok) {
      this._hold(pressure.code, pressure.detail, 'checkpoint-confirmed');
      throw new TransitionRefusedError(
        'ECLEAR_TELEMETRY',
        `clear refused by ${pressure.code}`,
        pressure.detail,
      );
    }
    if (pressure.observation.pct < this.pressureThresholdPct) {
      this._transition('idle', {
        cycle_id: null,
        session_id: this.sessionId,
        boot_sequence_at_start: null,
        clear_intent: null,
      });
      throw new TransitionRefusedError(
        'ECLEAR_PRESSURE_DROPPED',
        'clear refused because the current pressure observable is below threshold',
        {
          pct: pressure.observation.pct,
          threshold: this.pressureThresholdPct,
        },
      );
    }
    const checkpoint = this._checkpointObservable();
    if (!checkpoint.ok) {
      this._hold(checkpoint.code, checkpoint.detail, 'checkpoint-requested');
      throw new TransitionRefusedError(
        'ECLEAR_CHECKPOINT',
        `clear refused by ${checkpoint.code}`,
        checkpoint.detail,
      );
    }

    const writtenAt = clockIso(this.now);
    const next = this._transition('clear-submitted', {
      clear_intent: { written_at: writtenAt, submitted: false },
    });
    this._inheritedIntent = false;

    let consumed = false;
    const tokenId = `${next.cycle_id}:${writtenAt}`;
    const consume = (submitter) => {
      if (consumed) {
        throw new TransitionRefusedError(
          'EDUPLICATE_CLEAR',
          'clear submission token was already consumed',
          { token_id: tokenId },
        );
      }
      consumed = true;
      this._markClearSubmitted(tokenId);
      return typeof submitter === 'function' ? submitter() : { submitted: true };
    };
    const token = Object.freeze({
      id: tokenId,
      cycle_id: next.cycle_id,
      written_at: writtenAt,
      submit: consume,
      consume,
    });
    this._activeToken = token;
    return token;
  }

  _markClearSubmitted(tokenId) {
    this._refreshState();
    if (this.state.state !== 'clear-submitted' || this.state.clear_intent === null) {
      throw new TransitionRefusedError(
        'ECLEAR_TOKEN_STALE',
        'clear submission token no longer matches an active intent',
        { token_id: tokenId, state: this.state.state },
      );
    }
    if (this.state.clear_intent.submitted) {
      throw new TransitionRefusedError(
        'EDUPLICATE_CLEAR',
        'clear intent is already marked submitted',
        { token_id: tokenId },
      );
    }
    this._transition('clear-submitted', {
      clear_intent: { ...this.state.clear_intent, submitted: true },
    });
    return true;
  }

  /**
   * Accept only a newer source=clear SessionStart receipt.
   */
  confirmClearObserved(bootReceipt) {
    this._refreshState();
    const problem = bootReceiptProblem(bootReceipt);
    if (problem) {
      const resumeState = this.state.state === 'clear-submitted'
        ? 'clear-submitted'
        : this.state.state;
      const next = this._hold(problem.code, problem.detail, resumeState);
      return resultFor(next, {
        transitioned: true,
        status: 'hold',
        code: problem.code,
      });
    }
    if (!Number.isSafeInteger(this.state.boot_sequence_at_start)) {
      const next = this._hold(
        'boot-sequence-at-start-missing',
        { value: this.state.boot_sequence_at_start },
        this.state.state,
      );
      return resultFor(next, {
        transitioned: true,
        status: 'hold',
        code: 'boot-sequence-at-start-missing',
      });
    }
    if (!this._newClearReceipt(bootReceipt)) {
      if (this._inheritedIntent && this.state.clear_intent !== null) {
        const next = this._hold('clear-ambiguous', {
          observed_source: bootReceipt.source,
          observed_sequence: bootReceipt.boot_sequence,
          required_after: this.state.boot_sequence_at_start,
        }, 'clear-submitted');
        return resultFor(next, {
          transitioned: true,
          status: 'hold',
          code: 'clear-ambiguous',
        });
      }
      return resultFor(this.state, {
        status: 'refused',
        code: bootReceipt.source !== 'clear' ? 'clear-source-not-observed' : 'clear-sequence-not-new',
      });
    }

    if (this.state.state === 'HOLD:clear-ambiguous'
      || !['clear-submitted', 'clear-verified'].includes(this.state.state)) {
      const next = this._transition('released');
      this._inheritedIntent = false;
      return resultFor(next, {
        transitioned: true,
        status: 'released',
        observable: clone(bootReceipt),
      });
    }
    if (this.state.state === 'clear-verified') {
      const next = this._transition('released');
      this._inheritedIntent = false;
      return resultFor(next, {
        transitioned: true,
        status: 'released',
        observable: clone(bootReceipt),
      });
    }

    const next = this._transition('clear-verified');
    this._inheritedIntent = false;
    return resultFor(next, {
      transitioned: true,
      status: 'clear-verified',
      observable: clone(bootReceipt),
    });
  }

  close() {
    const released = releaseRunnerLock(this.lockHandle, { fsImpl: this.fs });
    this.lockHandle = null;
    return released;
  }
}

export function createAutoClearTransport(options) {
  return new AutoClearTransport(options);
}

export function beginClearSubmission(transport) {
  if (!transport || typeof transport.beginClearSubmission !== 'function') {
    throw new TypeError('transport with beginClearSubmission() is required');
  }
  return transport.beginClearSubmission();
}

export function confirmClearObserved(transport, bootReceipt) {
  if (!transport || typeof transport.confirmClearObserved !== 'function') {
    throw new TypeError('transport with confirmClearObserved() is required');
  }
  return transport.confirmClearObserved(bootReceipt);
}
