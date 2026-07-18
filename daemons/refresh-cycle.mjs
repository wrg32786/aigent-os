// refresh-cycle.mjs — the CYCLE RECORD: a passive data-shape landing.
//
// Two objects, not one: the capsule POINTER (daemons/curated-close-pointer.mjs)
// stays a concise audit echo; the transactional state of ONE refresh attempt lives
// here, in its own ephemeral file, SEPARATE from the pointer.
//
// THIS MODULE DOES NOT IMPLEMENT (deliberately out of scope for this port):
//   - CAS (compare-and-swap) consume on `state`
//   - clear-gating (no gate reads this file to authorize a clear)
//   - TTL/expiry enforcement (expires_at is a plain field, unchecked)
//   - quiescence-barrier enforcement of captured_through_event_id
// It only creates a well-formed record, writes it atomically (tmp+rename, same
// pattern as curated-close-pointer.mjs's writeState), and reads it back with a
// LOUD fail-closed on a malformed file — never a silent null/undefined.
//
// File location: <memRoot>/runtime/refresh-cycle-<sid>.json (one per session/cycle).
//
// Reuses lifecycle-common.mjs for memRoot/seatOf/logErr — no re-copied identity table.

import {
  readFileSync, writeFileSync, renameSync, rmSync, mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { memRoot, seatOf, logErr } from './lifecycle-common.mjs';

// State machine for the expanded lifecycle. This module lands the enum as a value
// set only — no transition enforcement.
export const CYCLE_STATES = Object.freeze([
  'requested', 'capsuling', 'prepared', 'clear_committed', 'cleared', 'resumed', 'aborted',
]);

const REQUIRED_STRING_FIELDS = ['cycle_id', 'lineage_id', 'runtime_session'];

export function cycleRecordPath(root, sid) {
  if (!sid) throw new Error('refresh-cycle: session id (sid) is required to locate the record path');
  return path.join(memRoot(String(root)), 'runtime', `refresh-cycle-${sid}.json`);
}

// Loud, specific problems — never a bare "invalid". Empty array = valid.
function validateRecord(record) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['record is not an object'];
  if (record.version !== 1) problems.push(`version must be 1, got: ${JSON.stringify(record.version)}`);
  for (const f of REQUIRED_STRING_FIELDS) {
    if (typeof record[f] !== 'string' || record[f].length === 0) {
      problems.push(`${f} must be a non-empty string, got: ${JSON.stringify(record[f])}`);
    }
  }
  if (!CYCLE_STATES.includes(record.state)) {
    problems.push(`state must be one of [${CYCLE_STATES.join('|')}], got: ${JSON.stringify(record.state)}`);
  }
  if (record.captured_through_offset !== undefined && record.captured_through_offset !== null
    && (!Number.isInteger(record.captured_through_offset) || record.captured_through_offset < 0)) {
    problems.push(`captured_through_offset must be a non-negative integer or null, got: ${JSON.stringify(record.captured_through_offset)}`);
  }
  return problems;
}

// Pure constructor — no disk I/O. Fills defaults (all optional fields null, version
// 1, state 'requested', issued_at now) then validates. Throws loud on a malformed
// input (e.g. missing cycle_id) rather than returning a half-built record.
export function createCycleRecord(fields = {}) {
  const now = new Date().toISOString();
  const record = {
    version: 1,
    cycle_id: fields.cycle_id ?? null,
    lineage_id: fields.lineage_id ?? null,
    runtime_session: fields.runtime_session ?? null,
    context_epoch: fields.context_epoch ?? null,
    state: fields.state ?? 'requested',
    issued_at: fields.issued_at ?? now,
    expires_at: fields.expires_at ?? null,
    challenge_digest: fields.challenge_digest ?? null,
    captured_through_event_id: fields.captured_through_event_id ?? null,
    // Cursor fields travel as a PAIR ({event_id, offset}) — offset is the half most
    // easily dropped by accident, and a receipt missing it can never verify.
    captured_through_offset: fields.captured_through_offset ?? null,
    capsule_id: fields.capsule_id ?? null,
    capsule_sha256: fields.capsule_sha256 ?? null,
    reconcile_digest: fields.reconcile_digest ?? null,
    clear_committed_at: fields.clear_committed_at ?? null,
    cleared_at: fields.cleared_at ?? null,
    resumed_at: fields.resumed_at ?? null,
    abort_reason: fields.abort_reason ?? null,
  };
  const problems = validateRecord(record);
  if (problems.length) {
    throw new Error(`refresh-cycle: cannot create malformed record: ${problems.join('; ')}`);
  }
  return record;
}

// Atomic tmp+rename write (mirrors curated-close-pointer.mjs's writeState). Refuses
// to persist a malformed record rather than writing a bad file that reads back ugly.
export function writeCycleRecord(root, sid, record) {
  const problems = validateRecord(record);
  if (problems.length) {
    const msg = `refresh-cycle: refusing to write malformed record for sid=${sid}: ${problems.join('; ')}`;
    logErr(root, 'refresh-cycle', msg);
    throw new Error(msg);
  }
  const file = cycleRecordPath(root, sid);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 1));
  try {
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(file, { force: true });
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(record, null, 1));
      try { rmSync(tmp, { force: true }); } catch { /* tmp orphan is harmless */ }
    }
  }
  return file;
}

// Loud fail-closed read: an unreadable file, unparsable JSON, or a record missing
// required fields / carrying an invalid `state` all THROW with a specific message —
// never a silent null. Callers that want "no cycle yet" must check existence
// themselves before calling read (this module has no existsCycleRecord — deliberately
// minimal; add one when a real caller needs it).
export function readCycleRecord(root, sid) {
  const file = cycleRecordPath(root, sid);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    const msg = `refresh-cycle: read failed for ${file}: ${e?.message || e}`;
    logErr(root, 'refresh-cycle', msg);
    throw new Error(msg);
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    const msg = `refresh-cycle: malformed JSON in ${file}: ${e?.message || e}`;
    logErr(root, 'refresh-cycle', msg);
    throw new Error(msg);
  }
  const problems = validateRecord(record);
  if (problems.length) {
    const msg = `refresh-cycle: malformed record in ${file} (seat ${seatOf(root) ?? 'unknown'}): ${problems.join('; ')}`;
    logErr(root, 'refresh-cycle', msg);
    throw new Error(msg);
  }
  return record;
}
