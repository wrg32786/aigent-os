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

// The capsule verb's mandated closing line (skills/context-capsule step 6).
// The seat emits EXACTLY this when its capsule is written and confirmed. It is
// the seat's own completion signal — the event-driven trigger the principal
// designed 2026-08-04: fire at the moment of maximal truth instead of polling
// until independently-measured freshness windows happen to align.
export const CAPSULE_ACK_LITERAL = 'Capsule Complete, Ready For Clear';

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
// ACK BOUNDARY (#90) — the one persisted fact the acknowledgement lifecycle
// needs and did not have: WHERE in the transcript this cycle opened.
//
// The runner scans the transcript FORWARD for the capsule ack literal. Across
// a relaunch it had no boundary of its own, so it borrowed the stop-writer
// record's offset -- which stop-capsule-writer.mjs captures at Stop-hook time,
// i.e. AFTER the ack it was being used to find. The ack was invisible and the
// request was re-injected (#90 shape 1). Scanning BACKWARD or sweeping the
// whole transcript instead would have revived exactly the stale ack #91 must
// reject, so the fix is a boundary that is bound to the cycle it belongs to:
// written once by _startPressure, nulled by every transition that ends or
// replaces the cycle, and carrying its own session_id and cycle_id so a reader
// can prove the evidence window is its own before reading a byte.
//
// NOT in REQUIRED_STATE_FIELDS, deliberately: a seat upgrading from a build
// without this field has a persisted cycle with no boundary, and requiring it
// would hold that cycle closed at cycle-state-field-missing with no recovery
// branch -- an indefinite park on upgrade. Absent is the LEGACY case and the
// reader names it (ack-boundary-legacy) and takes the re-request path.
const ACK_BOUNDARY_FIELDS = Object.freeze([
  'cycle_id',
  'session_id',
  'transcript_offset',
  'opened_at',
]);

/**
 * The shared contract for one cycle's acknowledgement boundary. Returns null
 * when `state.ack_boundary` is a usable evidence window for exactly
 * `sessionId` + `cycleId`, otherwise a named problem. Every rejection reason
 * is greppable: ack-boundary-legacy (field absent, pre-upgrade cycle),
 * ack-boundary-absent (the transport could not capture one), ack-boundary-
 * malformed, ack-boundary-session-mismatch, ack-boundary-cycle-mismatch.
 */
export function capsuleAckBoundaryProblem(state, { sessionId, cycleId } = {}) {
  if (!hasOwn(state, 'ack_boundary')) {
    return { code: 'ack-boundary-legacy', detail: { cycle_id: cycleId ?? null } };
  }
  const boundary = state.ack_boundary;
  if (boundary === null) {
    return { code: 'ack-boundary-absent', detail: { cycle_id: cycleId ?? null } };
  }
  if (typeof boundary !== 'object' || Array.isArray(boundary)) {
    return { code: 'ack-boundary-malformed', detail: 'root object missing' };
  }
  const absent = ACK_BOUNDARY_FIELDS.filter((field) => !hasOwn(boundary, field));
  if (absent.length) {
    return { code: 'ack-boundary-malformed', detail: { fields: absent } };
  }
  for (const field of ['cycle_id', 'session_id']) {
    if (typeof boundary[field] !== 'string' || boundary[field].length === 0) {
      return { code: 'ack-boundary-malformed', detail: { field } };
    }
  }
  // STRICTLY POSITIVE, not merely non-negative (review of 78a2577, F2). Offset
  // 0 opens the window on the WHOLE transcript, which is the stale-evidence
  // shape #91 exists to reject: demonstrated by rewriting a persisted boundary
  // to 0 with an ack line sitting before the cycle's start -- the pre-cycle ack
  // was observed and a clear was written. _captureAckBoundary never emits a 0
  // (it returns null for a zero-length transcript, so the reader names
  // ack-boundary-absent and the capsule is re-requested), so the only way a 0
  // reaches here is a write to the seat's own auto-clear-cycle.json. Refusing
  // it is what makes "null, never 0" true on BOTH sides of the contract rather
  // than only in the writer. The cost of the strictness is one re-requested
  // capsule in the corner where a cycle genuinely opens on an empty transcript
  // -- where, by definition, no ack can precede it anyway.
  if (!Number.isSafeInteger(boundary.transcript_offset)
    || boundary.transcript_offset <= 0) {
    return { code: 'ack-boundary-malformed', detail: { field: 'transcript_offset' } };
  }
  if (typeof boundary.opened_at !== 'string'
    || !Number.isFinite(Date.parse(boundary.opened_at))) {
    return { code: 'ack-boundary-malformed', detail: { field: 'opened_at' } };
  }
  // Provenance, both halves. A boundary written by another session cannot
  // locate anything in THIS session's transcript, and a boundary left over
  // from an earlier cycle is the stale-evidence window #91 is about.
  if (typeof sessionId !== 'string' || boundary.session_id !== sessionId) {
    return {
      code: 'ack-boundary-session-mismatch',
      detail: { expected: sessionId ?? null, observed: boundary.session_id },
    };
  }
  if (typeof cycleId !== 'string' || boundary.cycle_id !== cycleId) {
    return {
      code: 'ack-boundary-cycle-mismatch',
      detail: { expected: cycleId ?? null, observed: boundary.cycle_id },
    };
  }
  return null;
}

// ── ACK CLASSIFICATION (#90/#91 re-review 5556245936, S1) ────────────────────
// THE DEFECT THIS CLOSES, and the false assumption it rested on. The first
// repair for R1 kept the retired-request ledger in memory only, justified by
// the claim that a pre-relaunch answer is excluded anyway by "the next cycle's
// forward-only EOF boundary". THAT CLAIM IS FALSE, and the non-author reviewer
// isolated it with a matched control: #90 restores an EXISTING cycle, not
// necessarily a new one at EOF. A genuinely new cycle does capture its boundary
// at the transcript's end (_captureAckBoundary, and the control confirms such a
// cycle rejects the old answer), but a RESTORE reopens the cycle's ORIGINAL
// persisted boundary -- which predates an answer that arrived later in that
// cycle's life.
//
// So the measured sequence needs no SIGKILL, no orphan, no post-relaunch write
// and no change of session identity: A requested, A abandoned, B opened and
// requested, A completed and was CORRECTLY consumed as retired (authorized(B)
// false), then an ORDERLY relaunch. The new process loses the ledger and the
// cursor progress, reopens B's original boundary from before A's answer, reads
// A again and labels it B -- authorized(B) true, from 317, requests 0.
//
// THE PRINCIPLE: evidence that was rejected before an orderly shutdown must not
// become authorization afterward. Two facts are enough to keep it, and both
// live in the EXISTING durable cycle record rather than in a new file:
//
//   `classified_through`  a MONOTONE transcript offset. Bytes below it have
//                         already been classified as NOT this cycle's own
//                         answer -- a retired request's late answer that was
//                         consumed, or a literal refused as already spent. A
//                         restore reopens the window at
//                         max(boundary.transcript_offset, classified_through),
//                         so a rejected record is never re-read as evidence.
//   `debts_outstanding`   how many retired requests were still owed an answer.
//                         A restore REBUILDS the ledger with that many debts,
//                         so an answer landing after the relaunch still
//                         discharges the oldest outstanding request instead of
//                         authorizing the restored cycle.
//
// Neither is the whole ledger: no cycle ids, no cursors, no per-request state.
// Two numbers, cycle-bound and session-bound, nulled with the cycle like the
// boundary beside them. ABSENT is the honest legacy / nothing-classified case
// and means "use the boundary alone". MALFORMED is refused: it is a record that
// claims to carry an exclusion and cannot, so the reader treats it as an
// ambiguity and takes the existing safe re-request path rather than silently
// dropping the exclusion it was supposed to carry.
const ACK_CLASSIFICATION_FIELDS = Object.freeze([
  'cycle_id',
  'session_id',
  'classified_through',
  'debts_outstanding',
  // ARITHMETIC, NOT A BOOLEAN (re-review 5558958106, T1). `hadAck` -- "an
  // answer was seen" -- was treated as "every possible answer was discharged",
  // and it is not: the per-process request latch lets a RESTORED cycle issue a
  // SECOND request, so one observed answer can leave another still coming.
  // These two counters make the question arithmetic: a cycle's outstanding
  // answers are `requests_issued - answers_settled`, and that is exactly how
  // many debts its abandonment must carry forward. Durable because the second
  // request is issued by a different process from the first.
  'requests_issued',
  'answers_settled',
  'updated_at',
]);

/**
 * Returns null when `state.ack_classification` is absent (nothing classified
 * for this cycle -- use the boundary alone), `{ ok: true, record }` when it is
 * usable for exactly `sessionId` + `cycleId`, or `{ ok: false, code, detail }`
 * naming why it cannot be used. Reasons are greppable:
 * ack-classification-malformed, ack-classification-session-mismatch,
 * ack-classification-cycle-mismatch.
 */
export function capsuleAckClassification(state, { sessionId, cycleId } = {}) {
  if (!hasOwn(state, 'ack_classification') || state.ack_classification === null) {
    return null;
  }
  const record = state.ack_classification;
  if (typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, code: 'ack-classification-malformed', detail: 'root object missing' };
  }
  const absent = ACK_CLASSIFICATION_FIELDS.filter((field) => !hasOwn(record, field));
  if (absent.length) {
    return { ok: false, code: 'ack-classification-malformed', detail: { fields: absent } };
  }
  for (const field of ['cycle_id', 'session_id']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      return { ok: false, code: 'ack-classification-malformed', detail: { field } };
    }
  }
  // Zero IS valid here, unlike the boundary: "nothing classified yet, and this
  // many debts outstanding" is a meaningful thing for the runner to record.
  if (!Number.isSafeInteger(record.classified_through) || record.classified_through < 0) {
    return { ok: false, code: 'ack-classification-malformed', detail: { field: 'classified_through' } };
  }
  if (!Number.isSafeInteger(record.debts_outstanding) || record.debts_outstanding < 0) {
    return { ok: false, code: 'ack-classification-malformed', detail: { field: 'debts_outstanding' } };
  }
  for (const field of ['requests_issued', 'answers_settled']) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
      return { ok: false, code: 'ack-classification-malformed', detail: { field } };
    }
  }
  if (typeof record.updated_at !== 'string' || !Number.isFinite(Date.parse(record.updated_at))) {
    return { ok: false, code: 'ack-classification-malformed', detail: { field: 'updated_at' } };
  }
  if (typeof sessionId !== 'string' || record.session_id !== sessionId) {
    return {
      ok: false,
      code: 'ack-classification-session-mismatch',
      detail: { expected: sessionId ?? null, observed: record.session_id },
    };
  }
  if (typeof cycleId !== 'string' || record.cycle_id !== cycleId) {
    return {
      ok: false,
      code: 'ack-classification-cycle-mismatch',
      detail: { expected: cycleId ?? null, observed: record.cycle_id },
    };
  }
  return { ok: true, record: clone(record) };
}

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

// Where Claude Code keeps its configuration, and therefore its transcripts:
// CLAUDE_CONFIG_DIR when the session was launched with it (a seat that
// isolates its Claude state sets it to a directory of its own), otherwise
// <home>/.claude. A blank value counts as unset: a directory named by
// whitespace is never what a launcher meant.
export function claudeConfigDir({ env = process.env, homeDir = os.homedir() } = {}) {
  const configured = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return configured.length > 0 ? configured : path.join(String(homeDir), '.claude');
}

export function slugifyCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// The transcript lives where Claude Code put it: <config dir>/projects/
// <slug>/<session>.jsonl. Before this the path was built from the home
// directory alone, so a seat launched with CLAUDE_CONFIG_DIR was judged
// against a phantom under ~/.claude, the checkpoint reported the transcript
// missing on every automatic clear, and the cycle held until a human cleared
// by hand. Callers that pass no env keep the process environment, and with
// the variable unset the path is exactly what it always was.
export function transcriptPathFor({
  cwd,
  sessionId,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return null;
  return path.join(
    claudeConfigDir({ env, homeDir }),
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
  ackFresh = false,
  homeDir = os.homedir(),
  env = process.env,
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

  const transcriptPath = transcriptPathFor({ cwd, sessionId, homeDir, env });
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
  if (ackFresh !== true
    && transcript.size - record.offset > CHECKPOINT_TAIL_TOLERANCE_BYTES) {
    // ACK SUPERSEDES the byte arithmetic (principal's design, 2026-08-04,
    // carried to its end): with a live ack, the bytes past the capture are the
    // verb's own machinery by construction — every relaunch re-injected the
    // request (~14-20k) and re-failed the very check the injection existed to
    // satisfy. Binding + existence checks above still gate; only this
    // arithmetic yields to the seat's own completion signal.
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
    // No cycle, so no acknowledgement window belongs to anything (#90/#91).
    ack_boundary: null,
    ack_classification: null,
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
    // Set by the runner when the seat has emitted CAPSULE_ACK_LITERAL for the
    // current cycle. Substitutes for telemetry FRESHNESS (the seat just spoke;
    // it is provably alive) — never for pct, threshold, or checkpoint binding.
    this._capsuleAckMs = null;
    // The cycle that ack belongs to. An ack is evidence about one cycle; a
    // bare timestamp was evidence about nothing in particular (#91).
    this._capsuleAckCycleId = null;
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
      // A transition normally clears the hold — but a caller rewriting
      // bookkeeping WITHIN a hold (the boot rebase) must pass the hold
      // through explicitly, or it publishes state HOLD:* with hold:null:
      // exactly the record invalidStateReason rejects (defect 5, measured
      // live 2026-08-05).
      hold: hasOwn(changes, 'hold') ? changes.hold : null,
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

  // IDENTITY-BOUND (#91). The ack substitutes for telemetry freshness for the
  // cycle that earned it and for no other. The caller may name the cycle it
  // observed the ack for; omitting it binds to the cycle the core is in right
  // now (the only cycle a caller without an opinion can mean).
  noteCapsuleAck(detail = {}) {
    // Tolerant of the pre-fix call shape (no argument) and of anything that is
    // not an options object: a caller with no opinion means the live cycle.
    const cycleId = detail && typeof detail === 'object' && !Array.isArray(detail)
      ? detail.cycleId
      : undefined;
    const bound = typeof cycleId === 'string' ? cycleId : this.state?.cycle_id ?? null;
    if (typeof cycleId === 'string' && cycleId !== this.state?.cycle_id) {
      // A late ack from an abandoned or replaced request. Recorded as the
      // caller's cycle, never as the live one: _ackFreshForCycle then refuses
      // it, and a transition into a NEW cycle cannot adopt it either.
      this.log(`capsule ack ignored for freshness: cycle ${cycleId} is not the live cycle ${this.state?.cycle_id ?? 'null'}`);
    }
    this._capsuleAckCycleId = bound;
    this._capsuleAckMs = clockMs(this.now);
  }

  /**
   * Record, in the cycle's own durable record, how far the runner has
   * classified its acknowledgement evidence and how many retired requests are
   * still owed an answer (#90/#91 re-review 5556245936, S1). See the
   * ACK CLASSIFICATION note above for why these two numbers and no more.
   *
   * CYCLE-BOUND and MONOTONE, enforced here rather than trusted from the
   * caller: a record for a cycle the transport is no longer in is refused, and
   * `classified_through` can only ever move forward. A caller that tries to
   * rewind it -- a stale tick, a re-entrant write, a confused restore -- cannot
   * un-exclude evidence that was already rejected, which is the whole point of
   * persisting it. Returns the stored record, or null when nothing was written.
   */
  noteAckClassification(detail = {}) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
    const {
      cycleId, classifiedThrough, debtsOutstanding, requestsIssued, answersSettled,
    } = detail;
    if (typeof cycleId !== 'string' || cycleId.length === 0) return null;
    if (this.state?.cycle_id !== cycleId) {
      this.log(`ack classification ignored: cycle ${cycleId} is not the live cycle ${this.state?.cycle_id ?? 'null'}`);
      return null;
    }
    for (const value of [classifiedThrough, debtsOutstanding, requestsIssued, answersSettled]) {
      if (!Number.isSafeInteger(value) || value < 0) return null;
    }
    const current = hasOwn(this.state, 'ack_classification')
      && this.state.ack_classification !== null
      && typeof this.state.ack_classification === 'object'
      && !Array.isArray(this.state.ack_classification)
      && this.state.ack_classification.cycle_id === cycleId
      && Number.isSafeInteger(this.state.ack_classification.classified_through)
      ? this.state.ack_classification
      : null;
    // All three of these are MONOTONE counters. The frontier may not rewind
    // (that would un-exclude rejected evidence) and neither may the request or
    // answer tallies: a stale tick, a re-entrant write or a confused restore
    // must not be able to lower the number of answers a cycle is still owed.
    const monotone = (field, next) => (
      current === null || !Number.isSafeInteger(current[field])
        ? next
        : Math.max(current[field], next));
    const through = monotone('classified_through', classifiedThrough);
    const issued = monotone('requests_issued', requestsIssued);
    const settled = monotone('answers_settled', answersSettled);
    // Nothing to say: same frontier, same debt, same tallies. This keeps the
    // record off the per-tick write path -- only a real state change reaches
    // the disk.
    if (current !== null
      && current.classified_through === through
      && current.debts_outstanding === debtsOutstanding
      && current.requests_issued === issued
      && current.answers_settled === settled) {
      return clone(current);
    }
    const record = {
      cycle_id: cycleId,
      session_id: this.sessionId,
      classified_through: through,
      debts_outstanding: debtsOutstanding,
      requests_issued: issued,
      answers_settled: settled,
      updated_at: clockIso(this.now),
    };
    this._atomicWrite({ ...this.state, ack_classification: record });
    return clone(record);
  }

  // The ack relaxes checkpoint freshness only while it still belongs to the
  // cycle being judged. Clearing a timestamp was never enough: every path that
  // ends a cycle had to remember to clear it, and _gatePressure did not.
  _ackFreshForCycle() {
    return this._capsuleAckMs !== null
      && this._capsuleAckCycleId !== null
      && this._capsuleAckCycleId === this.state?.cycle_id;
  }

  // The transcript offset at which THIS cycle opened: the forward-only
  // acknowledgement window for the cycle, persisted so a relaunch recovers it
  // instead of borrowing the stop-writer offset that sits past the ack (#90).
  // Unresolvable, unreadable OR ZERO-LENGTH transcript -> null, never 0: offset
  // 0 would open the window on the whole transcript and could revive an ack
  // from an earlier cycle, which is the defect on the other side of this pair
  // (#91). A zero-length transcript is the only case that can produce a
  // genuine 0, and nothing can precede byte 0 anyway, so refusing to persist it
  // costs one re-requested capsule and makes "null, never 0" a property of the
  // WRITER as well as of the reader (capsuleAckBoundaryProblem refuses a 0 it
  // is handed; review of 78a2577, F2).
  // Null is the visible, safe case: the reader names ack-boundary-absent and
  // the runner re-requests the capsule.
  _captureAckBoundary(cycleId) {
    let offset = null;
    try {
      const transcript = transcriptPathFor({
        cwd: this.cwd,
        sessionId: this.sessionId,
        homeDir: this.homeDir,
        env: this.env,
      });
      if (transcript) {
        const size = this.fs.statSync(transcript).size;
        if (Number.isSafeInteger(size) && size > 0) offset = size;
      }
    } catch { offset = null; }
    if (offset === null) {
      this.log(`ack-boundary-absent: cycle ${cycleId} opened with no readable transcript offset; the capsule will be re-requested`);
      return null;
    }
    return {
      cycle_id: cycleId,
      session_id: this.sessionId,
      transcript_offset: offset,
      opened_at: clockIso(this.now),
    };
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
    if (observation.state === 'stale'
      && typeof observation.pct === 'number'
      && Number.isFinite(observation.pct)) {
      // MONOTONIC-STALE (the accepted transport rule, 2026-08-05: "why is there a
      // timer anyway, over engineered"): context usage only grows within a
      // session, and the sensor file is per-session, so a stale reading can
      // only UNDERSTATE the live pressure — acting on it can never
      // over-fire. Staleness holds protected nothing session-binding does
      // not already cover, and on the reference seat they expired the
      // capsule ack mid-cycle and ate operator nudges, twice measured live.
      // 'missing' still fails below: no reading means no pct to hold against
      // the threshold, and the ack never substitutes for that.
      return { ok: true, observation: { ...observation, fresh: true } };
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
      ackFresh: this._ackFreshForCycle(),
      homeDir: this.homeDir,
      // The runner's environment, so a seat launched with CLAUDE_CONFIG_DIR
      // is judged against the transcript Claude Code actually writes.
      env: this.env,
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
    this._abandonCycleAck('new-cycle'); // a new cycle needs its own ack
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
      // The cycle's own acknowledgement window opens HERE, at this cycle's
      // start -- the one place a boundary can be captured that is provably
      // before any ack the cycle can earn and provably after every ack an
      // earlier cycle earned.
      ack_boundary: this._captureAckBoundary(cycleId),
      // A NEW cycle has classified nothing yet. The runner writes this record
      // itself, through noteAckClassification, as it classifies (#90/#91
      // re-review 5556245936, S1).
      ack_classification: null,
    });
    return resultFor(next, {
      transitioned: true,
      status: 'pressure',
      observable: clone(observation),
    });
  }

  // THE SHARED ABANDONMENT POINT (#91). Every transition that ends or replaces
  // a cycle calls this, so neither half of the acknowledgement evidence -- the
  // transport's freshness substitute nor the persisted window -- can outlive
  // the cycle it was collected for. The persisted half is nulled by the caller
  // (it rides the same atomic state write); this clears the in-memory half.
  _abandonCycleAck(reason) {
    if (this._capsuleAckMs !== null) {
      this.log(`capsule ack discarded (${reason}): it belonged to cycle ${this._capsuleAckCycleId ?? 'null'}`);
    }
    this._capsuleAckMs = null;
    this._capsuleAckCycleId = null;
  }

  // Cycle-terminal bookkeeping for the transitions that KEEP the cycle_id
  // (clear-verified, released): the cycle is over, so its acknowledgement
  // window closes with it and cannot be re-opened by a later reader.
  _endCycleAck(reason) {
    this._abandonCycleAck(reason);
    return { ack_boundary: null, ack_classification: null };
  }

  _resumeStateFromHold() {
    const candidate = this.state?.hold?.detail?.resume_state;
    if (CYCLE_STATES.includes(candidate)) return candidate;
    return 'idle';
  }

  _gateKillSwitch() {
    return readKillSwitch({ memRoot: this.memRoot, env: this.env, fsImpl: this.fs });
  }

  // THE WIDE ABANDONMENT (#91). Reached from `pressure`, `checkpoint-requested`
  // AND `checkpoint-confirmed`: any below-threshold reading drops the cycle
  // back to idle. It used to log nothing and tell nobody, so an acknowledgement
  // already collected for the dropped cycle stayed latched in the runner and
  // authorized the NEXT cycle's clear with no capsule in between (measured: one
  // capsule request across two distinct cycles, then a /clear on the first
  // cycle's ack). The abandonment is now named and both halves of the evidence
  // die with the cycle.
  //
  // A HOLD is NOT an abandonment: `!pressure.ok` returns a hold that keeps the
  // same cycle_id, so same-cycle evidence survives it untouched.
  _gatePressure(resumeState) {
    const pressure = this._pressureObservable();
    if (!pressure.ok) return this._holdResult(pressure.code, pressure.detail, resumeState);
    if (pressure.observation.pct < this.pressureThresholdPct) {
      const abandoned = this.state.cycle_id;
      this._abandonCycleAck(`below-pressure from ${resumeState}`);
      const next = this._transition('idle', {
        cycle_id: null,
        session_id: this.sessionId,
        boot_sequence_at_start: null,
        clear_intent: null,
        ack_boundary: null,
        ack_classification: null,
      });
      this.log(`cycle-abandoned-below-pressure cycle=${abandoned ?? 'null'} from=${resumeState} pct=${pressure.observation.pct} threshold=${this.pressureThresholdPct}`);
      return resultFor(next, {
        transitioned: true,
        status: 'below-pressure',
        // Named so the runner (and an operator reading the events) can see
        // WHICH cycle was abandoned, not merely that the state is idle again.
        abandoned_cycle_id: abandoned ?? null,
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

    // INHERITED-CYCLE BOOT REBASE (the principal's bitcoin, 2026-08-04): a
    // cycle born at boot N, carried across relaunches to boot N+k of the SAME
    // session, can never satisfy the boot-binding guard — it refuses forever
    // against a baseline that no longer exists. Rebase the baseline to the
    // current receipt IFF: same session, receipt strictly newer, and NO clear
    // intent (an intent must keep its original binding — ambiguity protection).
    if (this.state.clear_intent === null
      && Number.isSafeInteger(this.state.boot_sequence_at_start)) {
      const bootNow = this._readBootReceipt();
      if (bootNow.ok
        && bootNow.receipt.session_id === this.state.session_id
        && Number.isSafeInteger(bootNow.receipt.boot_sequence)
        && bootNow.receipt.boot_sequence > this.state.boot_sequence_at_start) {
        this._transition(this.state.state, {
          boot_sequence_at_start: bootNow.receipt.boot_sequence,
          // Preserve the hold: this rewrite keeps the CURRENT state name,
          // which may be a HOLD — nulling the hold here corrupts the record
          // (defect 5).
          hold: this.state.hold,
        });
      }
    }

    // INHERITED DEAD-SESSION SUPERSEDE (the relaunch wedge, 2026-08-04): a
    // cycle persisted by a PREVIOUS runner stays bound to that runner's
    // session_id. After a relaunch this.sessionId IS the live session, so the
    // cand5 rebind (receipt vs this.sessionId) can never fire, the rebase
    // above requires the SAME session, and the checkpoint observable keys the
    // stop-writer record to state.session_id — a file that will never be
    // written. The receipt is the authority: when it proves THIS runner's
    // live session at a strictly newer boot than the inherited baseline, the
    // inherited cycle is superseded — reset to idle bound to the live session
    // and let live pressure start a fresh cycle. Never resume an inherited
    // checkpoint into a submit the live session never confirmed. An inherited
    // clear_intent keeps its original binding (ambiguity protection below);
    // 'released' keeps its own new-session-idle path.
    if (this.state.clear_intent === null
      && typeof this.state.session_id === 'string'
      && this.state.session_id !== this.sessionId
      && this.state.state !== 'released'
      && this.state.state !== 'HOLD:clear-ambiguous') {
      const bootNow = this._readBootReceipt();
      if (bootNow.ok
        && bootNow.receipt.session_id === this.sessionId
        && (!Number.isSafeInteger(this.state.boot_sequence_at_start)
          || bootNow.receipt.boot_sequence > this.state.boot_sequence_at_start)) {
        this._abandonCycleAck('inherited-cycle-superseded');
        const next = this._transition('idle', {
          cycle_id: null,
          session_id: this.sessionId,
          boot_sequence_at_start: null,
          clear_intent: null,
          ack_boundary: null,
          ack_classification: null,
        });
        return resultFor(next, { transitioned: true, status: 'inherited-cycle-superseded' });
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
      const next = this._transition('released', this._endCycleAck('clear-verified-released'));
      return resultFor(next, { transitioned: true, status: 'released' });
    }

    if (this.state.state === 'released') {
      if (this.state.session_id !== this.sessionId) {
        const boot = this._readBootReceipt();
        if (boot.ok && boot.receipt.session_id === this.sessionId) {
          this._abandonCycleAck('new-session-idle');
          const next = this._transition('idle', {
            cycle_id: null,
            session_id: this.sessionId,
            boot_sequence_at_start: null,
            clear_intent: null,
            ack_boundary: null,
            ack_classification: null,
          });
          return resultFor(next, { transitioned: true, status: 'new-session-idle' });
        }
      }
      return resultFor(this.state, { status: 'released' });
    }

    if (this.state.state === 'HOLD:clear-ambiguous') {
      // The hold exists because a submitted clear MIGHT have landed. For a
      // SAME-SESSION cycle that is answerable, not ambiguous: a clear always
      // mints a new session, so the same session id at a LATER boot proves the
      // clear never took. Evidence, not a guess -- so release instead of
      // holding forever. Measured live 2026-08-05: a seat killed mid-clear
      // re-entered this hold on every relaunch and could never lap again.
      // Cross-session inheritance is untouched (ids-2): there the sessions
      // differ, no receipt can speak for the dead one, and the hold still owns it.
      const boot = this._readBootReceipt();
      if (boot.ok
        && boot.receipt.session_id === this.state.session_id
        && boot.receipt.source !== 'clear'
        && Number.isSafeInteger(this.state.boot_sequence_at_start)
        && boot.receipt.boot_sequence > this.state.boot_sequence_at_start) {
        this.log(`clear-ambiguous released: same session at boot ${boot.receipt.boot_sequence} proves the clear never landed`);
        this._abandonCycleAck('clear-ambiguous-released');
        const next = this._atomicWrite({
          ...initialState(this.sessionId, clockIso(this.now)),
          boot_sequence_at_start: boot.receipt.boot_sequence,
        });
        return resultFor(next, { transitioned: true, status: 'new-session-idle' });
      }
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
        this._abandonCycleAck('telemetry-recovered-session-rebound');
        const next = this._transition('idle', {
          cycle_id: null,
          boot_sequence_at_start: null,
          clear_intent: null,
          session_id: this.sessionId,
          ack_boundary: null,
          ack_classification: null,
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
          this._abandonCycleAck('telemetry-recovered-below-pressure');
          const next = this._transition('idle', {
            cycle_id: null,
            boot_sequence_at_start: null,
            clear_intent: null,
            session_id: this.sessionId,
            ack_boundary: null,
            ack_classification: null,
          });
          return resultFor(next, { transitioned: true, status: 'telemetry-recovered' });
        }
        return this._startPressure(pressure.observation);
      }
      const next = this._transition(resumeState);
      return resultFor(next, { transitioned: true, status: 'telemetry-recovered' });
    }

    if (this.state.state.startsWith('HOLD:boot-receipt-')
      && this.state.cycle_id === null
      && this._resumeStateFromHold() === 'idle') {
      // BOOT-RECEIPT HOLD RECOVERY (the headless-probe overwrite, measured
      // live 2026-09-24): a headless `claude` job launched from the vault ran
      // the SessionStart hook against the LIVE seat's memory root and
      // overwrote boot-receipt.json with its own session_id. _startPressure
      // then held boot-receipt-session-mismatch from idle -- correctly: the
      // receipt no longer proved the bound session. But nothing re-checked
      // that evidence afterwards, so restoring the correct receipt did not
      // un-wedge the seat, and a relaunch into the SAME session cannot reach
      // the inherited-cycle supersede above. Re-run the exact evidence check
      // _startPressure makes: the hold lifts ONLY when a valid receipt for
      // the bound session is back. A receipt that is missing, invalid, or for
      // any other session keeps the hold -- this never rebinds sessionId (the
      // telemetry branch owns that, on its own controls) and never weakens
      // the mismatch check. Only holds raised from idle qualify (cycle_id
      // null, resume_state idle); confirmClearObserved()'s receipt holds keep
      // their clear-submitted binding and stay with the generic branch.
      const boot = this._readBootReceipt();
      const problem = !boot.ok
        ? { code: boot.code, detail: boot.detail }
        : boot.receipt.session_id !== this.sessionId
          ? {
            code: 'boot-receipt-session-mismatch',
            detail: { expected: this.sessionId, observed: boot.receipt.session_id },
          }
          : null;
      if (problem) {
        if (this.state.hold.code === problem.code) {
          return resultFor(this.state, {
            status: 'hold',
            code: problem.code,
            detail: clone(this.state.hold.detail),
          });
        }
        return this._holdResult(problem.code, problem.detail, 'idle');
      }
      this.log(`${this.state.state} released: receipt for bound session ${this.sessionId} restored at boot ${boot.receipt.boot_sequence}`);
      const pressure = this._pressureObservable();
      if (!pressure.ok) return this._holdResult(pressure.code, pressure.detail, 'idle');
      if (pressure.observation.pct < this.pressureThresholdPct) {
        this._abandonCycleAck('boot-receipt-recovered-below-pressure');
        const next = this._transition('idle', {
          cycle_id: null,
          session_id: this.sessionId,
          boot_sequence_at_start: null,
          clear_intent: null,
          ack_boundary: null,
          ack_classification: null,
        });
        return resultFor(next, {
          transitioned: true,
          status: 'boot-receipt-recovered',
          observable: clone(pressure.observation),
        });
      }
      return this._startPressure(pressure.observation);
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
      // THE NARROW ABANDONMENT (#91): the authorization the runner was holding
      // is withdrawn and the cycle is dropped, inside the call the runner made
      // to claim it. Both halves of the acknowledgement evidence die here too;
      // the runner's half is invalidated by cycle identity at its own
      // lifecycle boundary, not by this catch site.
      const abandoned = this.state.cycle_id;
      this._abandonCycleAck('below-pressure at clear submission');
      this._transition('idle', {
        cycle_id: null,
        session_id: this.sessionId,
        boot_sequence_at_start: null,
        clear_intent: null,
        ack_boundary: null,
        ack_classification: null,
      });
      this.log(`cycle-abandoned-below-pressure cycle=${abandoned ?? 'null'} from=clear-submission pct=${pressure.observation.pct} threshold=${this.pressureThresholdPct}`);
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
      const next = this._transition('released', this._endCycleAck('clear-observed'));
      this._inheritedIntent = false;
      return resultFor(next, {
        transitioned: true,
        status: 'released',
        observable: clone(bootReceipt),
      });
    }
    if (this.state.state === 'clear-verified') {
      const next = this._transition('released', this._endCycleAck('clear-observed'));
      this._inheritedIntent = false;
      return resultFor(next, {
        transitioned: true,
        status: 'released',
        observable: clone(bootReceipt),
      });
    }

    const next = this._transition('clear-verified', this._endCycleAck('clear-verified'));
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
