// capsule-verb.mjs — the trusted-writer orchestration for the capsule verb.
//
// The model authors capsule prose; this module is the authority that deterministic
// reconciliation ran. Clear gating, CAS consumption, TTL, and quiescence
// enforcement remain deliberately out of scope (see refresh-cycle.mjs's header).

import {
  existsSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson, collectEvidence, reconcileDigest,
} from './reconcile-collector.mjs';
import {
  cycleRecordPath, readCycleRecord, writeCycleRecord,
} from './refresh-cycle.mjs';
import { memRoot as resolveMemRoot, seatOf } from './lifecycle-common.mjs';
import { contentProblems } from './capsule-content-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CURATED_WRITER = path.join(__dirname, 'curated-close-pointer.mjs');
const HEX_SHA256 = /^[a-f0-9]{64}$/i;
const CHALLENGE_SHA256 = /^sha256:[a-f0-9]{64}$/i;
const EFFECT_STATES = new Set([
  'requested', 'accepted', 'completed', 'failed', 'safe-retry',
]);
const REQUIRED_CAPSULE_FIELDS = Object.freeze([
  'id', 'objective', 'waiting_on', 'next_valid_action',
]);
const CYCLE_FIELDS = Object.freeze([
  'version', 'cycle_id', 'lineage_id', 'runtime_session', 'context_epoch',
  'state', 'issued_at', 'expires_at', 'challenge_digest',
  'captured_through_event_id', 'captured_through_offset', 'capsule_id',
  'capsule_sha256', 'reconcile_digest', 'clear_committed_at', 'cleared_at',
  'resumed_at', 'abort_reason',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const describe = (error) => String(error?.message || error || 'unknown error');
const emptyDigests = () => ({
  capsule_sha256: null,
  reconcile_digest: null,
  challenge_digest: null,
});

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

export class CapsuleVerbRefusal extends Error {
  constructor(refusals, result = {}) {
    const reasons = Array.isArray(refusals) ? refusals : [String(refusals)];
    super(`[capsule-verb] REFUSED: ${reasons.join('; ')}`);
    this.name = 'CapsuleVerbRefusal';
    this.result = {
      stamped: false,
      pointerPath: null,
      digests: emptyDigests(),
      refusals: reasons,
      cycleStates: [],
      ...result,
      refusals: reasons,
    };
  }
}

function refuse(reasons, digests, extra = {}) {
  throw new CapsuleVerbRefusal(reasons, {
    digests: { ...emptyDigests(), ...digests },
    ...extra,
  });
}

// The public API takes a memory root while the landed writers take a project
// root. aigent-OS's memory root is always <root>/vault/memory (or <root>/memory
// for forks that skip the vault/ subdirectory — see lifecycle-common.mjs). Only
// those two shapes are accepted; ambiguity must not stamp.
export function projectRootFromMemRoot(memRoot) {
  if (typeof memRoot !== 'string' || memRoot.trim().length === 0) {
    throw new Error('memRoot must be a non-empty path');
  }
  const memory = path.resolve(memRoot);
  const slash = memory.replace(/\\/g, '/').toLowerCase();
  if (slash.endsWith('/vault/memory')) return path.resolve(memory, '..', '..');
  if (path.basename(memory).toLowerCase() === 'memory') return path.dirname(memory);
  throw new Error(`unsupported memory-root layout: ${memory}`);
}

function frontmatterOf(text) {
  const match = String(text).match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match?.[1] ?? null;
}

function frontmatterScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!match) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
  }
  return value;
}

function hasUnsupportedInlineComment(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!match) return false;
  const raw = match[1];
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && raw[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && index > 0 && /\s/.test(raw[index - 1])) return true;
  }
  return false;
}

function isUnquotedYamlNull(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!match) return false;
  let raw = match[1].trim();
  if (raw.startsWith('"') || raw.startsWith("'")) return false;
  raw = raw.replace(/\s+#.*$/, '').trim();
  return /^(?:null|~)$/i.test(raw);
}

export function validateCapsuleText(text) {
  const frontmatter = frontmatterOf(text);
  if (frontmatter === null) {
    return { fields: {}, problems: ['capsule must begin with a closed YAML frontmatter block'] };
  }
  const fields = {};
  const problems = [];
  for (const field of REQUIRED_CAPSULE_FIELDS) {
    fields[field] = frontmatterScalar(frontmatter, field);
    if (typeof fields[field] !== 'string' || fields[field].length === 0) {
      problems.push(`capsule frontmatter ${field} must be non-empty`);
    }
    if (hasUnsupportedInlineComment(frontmatter, field)) {
      problems.push(`capsule frontmatter ${field} must not use an inline YAML comment`);
    }
  }
  // YAML null is not a non-empty waiting_on value for the trusted receipt, even
  // though older curated capsules used it as a shorthand. A quoted "null" remains
  // an intentional string.
  if (isUnquotedYamlNull(frontmatter, 'waiting_on')) {
    problems.push('capsule frontmatter waiting_on must be non-empty (unquoted YAML null is empty)');
  }
  // non-null ≠ resumable: field MEANING gate. A capsule whose objective is
  // harness-injection echo or whose next_valid_action opens with resume ceremony
  // passed every non-empty check above yet strands a fresh session. Vocabulary
  // lives in capsule-content-gate.mjs, shared with the stop-writer.
  problems.push(...contentProblems(fields));
  return { fields, problems };
}

function validateBoard(board, problems) {
  if (board === null) return;
  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    problems.push('evidence.board must be an object or null');
    return;
  }
  if (typeof board.query !== 'string' || board.query.length === 0) {
    problems.push('evidence.board.query must be a non-empty string');
  }
  if (!Array.isArray(board.rows)) {
    problems.push('evidence.board.rows must be an array');
  } else {
    board.rows.forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        problems.push(`evidence.board.rows[${index}] must be an object`);
        return;
      }
      for (const field of ['id', 'version', 'status', 'claimant', 'updated_at']) {
        if (!own(row, field)) problems.push(`evidence.board.rows[${index}].${field} is required`);
      }
      if (own(row, 'id') && (typeof row.id !== 'string' || row.id.length === 0)) {
        problems.push(`evidence.board.rows[${index}].id must be a non-empty string`);
      }
      if (own(row, 'version')
        && !((typeof row.version === 'string' && row.version.length > 0)
          || (typeof row.version === 'number' && Number.isFinite(row.version)))) {
        problems.push(`evidence.board.rows[${index}].version must be a string or finite number`);
      }
      if (own(row, 'status')
        && (typeof row.status !== 'string' || row.status.length === 0)) {
        problems.push(`evidence.board.rows[${index}].status must be a non-empty string`);
      }
      if (own(row, 'claimant') && row.claimant !== null
        && (typeof row.claimant !== 'string' || row.claimant.length === 0)) {
        problems.push(`evidence.board.rows[${index}].claimant must be a string or null`);
      }
      if (own(row, 'updated_at')
        && (typeof row.updated_at !== 'string'
          || !Number.isFinite(Date.parse(row.updated_at)))) {
        problems.push(`evidence.board.rows[${index}].updated_at must be an ISO8601 string`);
      }
    });
  }
  if (typeof board.digest !== 'string' || !HEX_SHA256.test(board.digest)) {
    problems.push('evidence.board.digest must be a sha256 hex digest');
  } else {
    try {
      const computed = sha256(canonicalJson({ query: board.query, rows: board.rows }));
      if (board.digest !== computed) {
        problems.push('evidence.board.digest does not match its canonical query and rows');
      }
    } catch (error) {
      problems.push(`evidence.board cannot be canonically digested: ${describe(error)}`);
    }
  }
}

function validateGit(git, problems) {
  if (!Array.isArray(git) || git.length === 0) {
    problems.push('evidence.git must contain at least one workspace record');
    return;
  }
  git.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`evidence.git[${index}] must be an object`);
      return;
    }
    for (const field of ['repo', 'branch', 'head']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        problems.push(`evidence.git[${index}].${field} must be a non-empty string`);
      }
    }
    if (typeof entry.index_tree !== 'string' || !HEX_SHA256.test(entry.index_tree)) {
      problems.push(`evidence.git[${index}].index_tree must be a sha256 hex digest`);
    }
    if (typeof entry.working_tree_digest !== 'string'
      || !HEX_SHA256.test(entry.working_tree_digest)) {
      problems.push(`evidence.git[${index}].working_tree_digest must be a sha256 hex digest`);
    }
    if (typeof entry.dirty !== 'boolean') {
      problems.push(`evidence.git[${index}].dirty must be boolean`);
    }
  });
}

function validateExternalEffects(effects, problems) {
  if (!Array.isArray(effects)) {
    problems.push('evidence.external_effects must be an array');
    return;
  }
  effects.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`evidence.external_effects[${index}] must be an object`);
      return;
    }
    for (const field of ['idempotency_key', 'system', 'state']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        problems.push(`evidence.external_effects[${index}].${field} must be a non-empty string`);
      }
    }
    if (typeof entry.state === 'string' && !EFFECT_STATES.has(entry.state)) {
      problems.push(`evidence.external_effects[${index}].state is not a receipt state`);
    }
    if (!own(entry, 'external_id')) {
      problems.push(`evidence.external_effects[${index}].external_id is required (null allowed)`);
    } else if (entry.external_id !== null && typeof entry.external_id !== 'string') {
      problems.push(`evidence.external_effects[${index}].external_id must be a string or null`);
    }
    if (typeof entry.receipt_digest !== 'string' || !HEX_SHA256.test(entry.receipt_digest)) {
      problems.push(`evidence.external_effects[${index}].receipt_digest must be a sha256 hex digest`);
    }
  });
}

export function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['evidence must be an object'];
  }
  const problems = [];
  if (evidence.version !== 1) problems.push('evidence.version must be 1');
  if (!own(evidence, 'board')) problems.push('evidence.board is required');
  else validateBoard(evidence.board, problems);
  validateGit(evidence.git, problems);
  validateExternalEffects(evidence.external_effects, problems);
  return problems;
}

function normalizeCursor(value, problems) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push('capturedThroughEventId must be a non-empty string when supplied');
    return null;
  }
  return value;
}

// Cursor = {event_id, offset}. The offset is the half most easily dropped by
// accident — verify compares the FULL cursor strictly, so an offset-less receipt
// can never pass. Shape errors surface here; the receipt-completeness pairing rule
// (cycle + event id -> offset REQUIRED) is enforced at the cycle block where the
// cycle is known, so plain curated closes stay unaffected.
function normalizeCursorOffset(value, cursor, problems) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    problems.push(`capturedThroughOffset must be a non-negative integer when supplied, got: ${JSON.stringify(value)}`);
    return null;
  }
  if (cursor === null) {
    problems.push('capturedThroughOffset supplied without capturedThroughEventId (cursor fields travel as a pair)');
    return null;
  }
  return value;
}

function cycleParts(cycle, problems) {
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) {
    return { record: null, challenge: undefined };
  }
  if (own(cycle, 'record')) {
    for (const key of Object.keys(cycle)) {
      if (key !== 'record' && key !== 'challenge') {
        problems.push(`cycle wrapper contains unknown field ${key}`);
      }
    }
    return { record: cycle.record, challenge: cycle.challenge };
  }
  return { record: cycle, challenge: undefined };
}

function normalizeCycleRecord(record, challenge, problems) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    problems.push('cycle record must be an object');
    return null;
  }
  // Never spread caller data into the persisted record. In particular, reject
  // likely raw-token properties and rebuild from the schema allowlist below.
  for (const rawField of ['challenge', 'cycle_token', 'raw_challenge', 'token']) {
    if (own(record, rawField)) {
      problems.push(`cycle record must not contain raw token field ${rawField}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!CYCLE_FIELDS.includes(key)) problems.push(`cycle record contains unknown field ${key}`);
  }
  for (const field of CYCLE_FIELDS) {
    if (!own(record, field)) problems.push(`cycle record field ${field} is required`);
  }
  if (record.version !== 1) problems.push('cycle record version must be 1');
  for (const field of ['cycle_id', 'lineage_id', 'runtime_session']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      problems.push(`cycle record ${field} must be a non-empty string`);
    }
  }
  if (typeof record.runtime_session === 'string'
    && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.runtime_session)) {
    problems.push('cycle record runtime_session must be a path-safe identifier');
  }
  if (record.state !== 'requested') {
    problems.push(`cycle record must begin in requested state, got: ${JSON.stringify(record.state)}`);
  }
  if (!Number.isInteger(record.context_epoch) || record.context_epoch < 0) {
    problems.push('cycle record context_epoch must be a non-negative integer');
  }
  if (typeof record.issued_at !== 'string' || !Number.isFinite(Date.parse(record.issued_at))) {
    problems.push('cycle record issued_at must be an ISO8601 string');
  }
  for (const field of ['expires_at', 'clear_committed_at', 'cleared_at', 'resumed_at']) {
    const value = record[field];
    if (value !== null
      && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
      problems.push(`cycle record ${field} must be an ISO8601 string or null`);
    }
  }
  for (const field of ['captured_through_event_id', 'capsule_id', 'abort_reason']) {
    const value = record[field];
    if (value !== null && (typeof value !== 'string' || value.length === 0)) {
      problems.push(`cycle record ${field} must be a non-empty string or null`);
    }
  }
  if (record.captured_through_offset !== null
    && (!Number.isInteger(record.captured_through_offset) || record.captured_through_offset < 0)) {
    problems.push('cycle record captured_through_offset must be a non-negative integer or null');
  }
  for (const field of ['capsule_sha256', 'reconcile_digest']) {
    const value = record[field];
    if (value !== null && (typeof value !== 'string' || !HEX_SHA256.test(value))) {
      problems.push(`cycle record ${field} must be a sha256 hex digest or null`);
    }
  }

  let challengeDigest = record.challenge_digest ?? null;
  if (challenge !== undefined) {
    if (typeof challenge !== 'string' || challenge.length === 0) {
      problems.push('cycle challenge must be a non-empty string when supplied');
    } else {
      const computed = `sha256:${sha256(challenge)}`;
      if (challengeDigest !== null && challengeDigest !== computed) {
        problems.push('cycle challenge does not match the supplied challenge_digest');
      }
      challengeDigest = computed;
    }
  }
  if (typeof challengeDigest !== 'string' || !CHALLENGE_SHA256.test(challengeDigest)) {
    problems.push('cycle challenge_digest must be sha256:<64 hex>');
  }

  const normalized = {};
  for (const field of CYCLE_FIELDS) normalized[field] = record[field] ?? null;
  normalized.version = 1;
  normalized.state = 'requested';
  normalized.issued_at = record.issued_at;
  normalized.challenge_digest = challengeDigest;
  return normalized;
}

function sameCycleIdentity(left, right) {
  return left.cycle_id === right.cycle_id
    && left.lineage_id === right.lineage_id
    && left.runtime_session === right.runtime_session
    && left.context_epoch === right.context_epoch;
}

// aigent-OS is single-operator: the pointer always lives at BODY_STATE.json's
// state.last_capsule (the same convention the context-capsule skill documents).
function pointerPathFor(memoryRoot) {
  return path.join(memoryRoot, 'BODY_STATE.json');
}

function readStampedPointer(pointerPath) {
  const parsed = JSON.parse(readFileSync(pointerPath, 'utf8'));
  return parsed?.state?.last_capsule;
}

function expectedPointerProblems(pointer, expected) {
  if (!pointer || typeof pointer !== 'object') return ['writer produced no pointer object'];
  const problems = [];
  if (pointer.id !== expected.id) problems.push('stamped pointer id does not match capsule id');
  if (pointer.path !== expected.path) problems.push('stamped pointer path does not match capsule target');
  if (pointer.capsule_sha256 !== expected.capsule_sha256) {
    problems.push('stamped pointer capsule_sha256 does not match capsule bytes');
  }
  if (pointer.reconcile_digest !== expected.reconcile_digest) {
    problems.push('stamped pointer reconcile_digest does not match evidence');
  }
  if (pointer.captured_through_event_id !== expected.captured_through_event_id) {
    problems.push('stamped pointer captured_through_event_id does not match capture cursor');
  }
  if ((pointer.captured_through_offset ?? null) !== expected.captured_through_offset) {
    problems.push('stamped pointer captured_through_offset does not match capture cursor');
  }
  if (JSON.stringify(pointer.reconciled) !== JSON.stringify(expected.reconciled)) {
    problems.push('stamped pointer reconciled proof does not match collected evidence');
  }
  if (pointer.cycle_id !== expected.cycle_id) problems.push('stamped pointer cycle_id mismatch');
  if (pointer.context_epoch !== expected.context_epoch) problems.push('stamped pointer context_epoch mismatch');
  if (pointer.cycle_token !== null) problems.push('trusted writer must never persist a raw cycle token');
  return problems;
}

/**
 * Collect deterministic evidence, validate the capsule, and stamp through the
 * existing curated writer. Expected precondition failures throw
 * CapsuleVerbRefusal and expose the normal return shape at `error.result`.
 */
export async function runCapsuleVerb({
  seatId,
  memRoot,
  capsulePath,
  cycle = null,
  capturedThroughEventId = null,
  capturedThroughOffset = null,
  dryRun = false,
} = {}) {
  const digests = emptyDigests();
  const preflight = [];

  let root;
  let memoryRoot;
  try {
    root = projectRootFromMemRoot(memRoot);
    memoryRoot = path.resolve(memRoot);
  } catch (error) {
    refuse([describe(error)], digests);
  }

  const resolvedSeat = seatOf(root);
  const requestedSeat = typeof seatId === 'string' ? seatId.toLowerCase() : null;
  if (!requestedSeat) preflight.push('seatId must be a non-empty string');
  else if (resolvedSeat && requestedSeat !== resolvedSeat.toLowerCase()) {
    preflight.push(`seatId ${seatId} does not match derived identity ${resolvedSeat}`);
  }

  const writerMemoryRoot = path.resolve(resolveMemRoot(root));
  if (comparablePath(writerMemoryRoot) !== comparablePath(memoryRoot)) {
    preflight.push(`memRoot ${memoryRoot} is not the writer-selected memory root ${writerMemoryRoot}`);
  }
  let physicalRoot = null;
  try {
    physicalRoot = realpathSync(root);
  } catch (error) {
    preflight.push(`project root cannot be resolved physically: ${describe(error)}`);
  }

  let absoluteCapsule = null;
  if (typeof capsulePath !== 'string' || capsulePath.trim().length === 0) {
    preflight.push('capsulePath must be a non-empty path');
  } else {
    absoluteCapsule = path.isAbsolute(capsulePath)
      ? path.resolve(capsulePath)
      : path.resolve(root, capsulePath);
    if (!isInside(root, absoluteCapsule)) {
      preflight.push(`capsule must be inside the project root: ${absoluteCapsule}`);
    } else if (!existsSync(absoluteCapsule)) {
      preflight.push(`capsule file does not exist: ${absoluteCapsule}`);
    } else {
      try {
        if (!statSync(absoluteCapsule).isFile()) {
          preflight.push(`capsule path is not a file: ${absoluteCapsule}`);
        } else if (physicalRoot) {
          const physicalCapsule = realpathSync(absoluteCapsule);
          if (!isInside(physicalRoot, physicalCapsule)) {
            preflight.push(`capsule symlink target must be inside the project root: ${physicalCapsule}`);
          }
        }
      } catch (error) {
        preflight.push(`capsule cannot be inspected: ${describe(error)}`);
      }
    }
  }

  const cursor = normalizeCursor(capturedThroughEventId, preflight);
  const cursorOffset = normalizeCursorOffset(capturedThroughOffset, cursor, preflight);
  if (preflight.length) refuse(preflight, digests);

  let capsuleBytes;
  try {
    capsuleBytes = readFileSync(absoluteCapsule);
  } catch (error) {
    refuse([`capsule read failed: ${describe(error)}`], digests);
  }
  digests.capsule_sha256 = sha256(capsuleBytes);
  const capsuleValidation = validateCapsuleText(capsuleBytes.toString('utf8'));
  if (capsuleValidation.problems.length) refuse(capsuleValidation.problems, digests);

  let evidence;
  try {
    evidence = await collectEvidence({ seatId: requestedSeat, memRoot: memoryRoot });
  } catch (error) {
    refuse([`evidence collection failed: ${describe(error)}`], digests);
  }
  const evidenceProblems = validateEvidence(evidence);
  if (evidenceProblems.length) refuse(evidenceProblems, digests);
  try {
    digests.reconcile_digest = reconcileDigest(evidence);
  } catch (error) {
    refuse([`reconcile digest failed: ${describe(error)}`], digests);
  }
  if (typeof digests.reconcile_digest !== 'string'
    || !HEX_SHA256.test(digests.reconcile_digest)) {
    refuse(['reconcileDigest must return a sha256 hex digest'], digests);
  }

  const reconciled = {
    board_rows: evidence.board === null ? [] : evidence.board.rows.map((row) => row.id),
    git_head: evidence.git[0].head,
  };

  let cycleRecord = null;
  if (cycle !== undefined && cycle !== null) {
    const cycleProblems = [];
    const parts = cycleParts(cycle, cycleProblems);
    cycleRecord = normalizeCycleRecord(parts.record, parts.challenge, cycleProblems);
    if (cycleProblems.length) refuse(cycleProblems, digests);

    const existingPath = cycleRecordPath(root, cycleRecord.runtime_session);
    if (existsSync(existingPath)) {
      let existing;
      try {
        existing = readCycleRecord(root, cycleRecord.runtime_session);
      } catch (error) {
        refuse([`cycle record read failed: ${describe(error)}`], digests);
      }
      const existingProblems = [];
      const normalizedExisting = normalizeCycleRecord(existing, parts.challenge, existingProblems);
      if (existingProblems.length) refuse(existingProblems, digests);
      if (!sameCycleIdentity(cycleRecord, normalizedExisting)) {
        refuse(['supplied cycle does not match the persisted cycle identity'], digests);
      }
      if (cycleRecord.challenge_digest !== normalizedExisting.challenge_digest) {
        refuse(['supplied cycle challenge_digest does not match persisted cycle'], digests);
      }
      cycleRecord = normalizedExisting;
    }
    digests.challenge_digest = cycleRecord.challenge_digest;
    // Receipt-completeness pairing: verify compares the FULL cursor strictly, so a
    // cycle receipt stamped with an event id but no offset is guaranteed dead at
    // verify — refuse loudly at the session instead. Enforced HERE (pre-dryRun) so
    // dry canaries refuse exactly like live runs. Cursor-less cycles keep their
    // pre-existing semantics, and plain curated closes (no cycle) never hit this rule.
    if (cursor !== null && cursorOffset === null) {
      refuse(['capturedThroughOffset is required for a cycle receipt (an offset-less receipt can never pass verify)'], digests);
    }
  }

  // A dry run performs every read and validation, including a persisted cycle
  // read, but intentionally makes neither pointer nor cycle writes.
  if (dryRun) {
    return {
      stamped: false,
      pointerPath: null,
      digests,
      refusals: [],
      cycleStates: [],
    };
  }

  const cycleStates = [];
  if (cycleRecord) {
    cycleStates.push('requested');
    const capsuling = {
      ...cycleRecord,
      state: 'capsuling',
      challenge_digest: digests.challenge_digest,
      captured_through_event_id: cursor,
      captured_through_offset: cursorOffset,
      capsule_id: capsuleValidation.fields.id,
      capsule_sha256: digests.capsule_sha256,
      reconcile_digest: digests.reconcile_digest,
    };
    try {
      writeCycleRecord(root, cycleRecord.runtime_session, capsuling);
      const back = readCycleRecord(root, cycleRecord.runtime_session);
      if (back.state !== 'capsuling' || back.cycle_id !== cycleRecord.cycle_id
        || back.captured_through_event_id !== cursor
        || back.captured_through_offset !== cursorOffset
        || back.capsule_id !== capsuleValidation.fields.id
        || back.capsule_sha256 !== digests.capsule_sha256
        || back.reconcile_digest !== digests.reconcile_digest
        || back.challenge_digest !== digests.challenge_digest) {
        refuse(['cycle record did not persist the capsuling transition'], digests, { cycleStates });
      }
    } catch (error) {
      if (error instanceof CapsuleVerbRefusal) throw error;
      refuse([`cycle capsuling write failed: ${describe(error)}`], digests, { cycleStates });
    }
    cycleStates.push('capsuling');
  }

  const writerArgs = [
    CURATED_WRITER,
    absoluteCapsule,
    '--reconciled', JSON.stringify(reconciled),
    '--reconcile-digest', digests.reconcile_digest,
    '--capsule-sha256', digests.capsule_sha256,
  ];
  if (cursor !== null) writerArgs.push('--captured-through-event', cursor);
  if (cursorOffset !== null) writerArgs.push('--captured-through-offset', String(cursorOffset));
  if (cycleRecord) {
    writerArgs.push(
      '--session', cycleRecord.runtime_session,
      '--cycle-id', cycleRecord.cycle_id,
      '--context-epoch', String(cycleRecord.context_epoch),
    );
  }
  // Deliberately no --cycle-token: the raw challenge never enters argv or disk.
  const child = spawnSync(process.execPath, writerArgs, {
    cwd: root,
    env: { ...process.env, AIGENT_ROOT: root, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (child.error || child.status !== 0) {
    const detail = child.error
      ? describe(child.error)
      : String(child.stderr || child.stdout || '').trim();
    refuse([`curated pointer writer failed${detail ? `: ${detail}` : ''}`], digests, {
      cycleStates,
    });
  }

  const pointerPath = pointerPathFor(memoryRoot);
  let pointer;
  try {
    pointer = readStampedPointer(pointerPath);
  } catch (error) {
    refuse([`stamped pointer read-back failed: ${describe(error)}`], digests, {
      pointerPath,
      cycleStates,
    });
  }
  const expectedPath = path.relative(root, absoluteCapsule).replace(/\\/g, '/');
  const pointerProblems = expectedPointerProblems(pointer, {
    id: capsuleValidation.fields.id,
    path: expectedPath,
    capsule_sha256: digests.capsule_sha256,
    reconcile_digest: digests.reconcile_digest,
    captured_through_event_id: cursor,
    captured_through_offset: cursorOffset,
    reconciled,
    cycle_id: cycleRecord?.cycle_id ?? null,
    context_epoch: cycleRecord?.context_epoch ?? null,
  });
  if (pointerProblems.length) {
    refuse(pointerProblems, digests, { pointerPath, cycleStates });
  }

  if (cycleRecord) {
    const prepared = {
      ...cycleRecord,
      state: 'prepared',
      challenge_digest: digests.challenge_digest,
      captured_through_event_id: cursor,
      captured_through_offset: cursorOffset,
      capsule_id: capsuleValidation.fields.id,
      capsule_sha256: digests.capsule_sha256,
      reconcile_digest: digests.reconcile_digest,
    };
    try {
      writeCycleRecord(root, cycleRecord.runtime_session, prepared);
      const back = readCycleRecord(root, cycleRecord.runtime_session);
      if (back.state !== 'prepared' || back.cycle_id !== cycleRecord.cycle_id
        || back.capsule_sha256 !== digests.capsule_sha256
        || back.reconcile_digest !== digests.reconcile_digest
        || back.challenge_digest !== digests.challenge_digest
        || back.captured_through_event_id !== cursor
        || back.captured_through_offset !== cursorOffset
        || back.capsule_id !== capsuleValidation.fields.id) {
        refuse(['cycle record did not persist the prepared receipt'], digests, {
          pointerPath,
          cycleStates,
        });
      }
    } catch (error) {
      if (error instanceof CapsuleVerbRefusal) throw error;
      refuse([`cycle prepared write failed: ${describe(error)}`], digests, {
        pointerPath,
        cycleStates,
      });
    }
    cycleStates.push('prepared');
  }

  return {
    stamped: true,
    pointerPath,
    digests,
    refusals: [],
    cycleStates,
  };
}
