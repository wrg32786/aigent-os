// effect-receipts.mjs — append-only external-effect receipt ledger.
//
// File: <memRoot>/runtime/effect-receipts-<seatId>.jsonl. This module defines the
// business-OS seam only; it is not wired to any live effect-producing path out of
// the box — a fork wires its own effect producers (payments, deploys, sends...) to
// call appendReceipt() when they resolve.

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { memRoot as resolveMemRoot, seatOf } from './lifecycle-common.mjs';

const RECEIPT_STATES = Object.freeze([
  'requested',
  'accepted',
  'completed',
  'failed',
  'safe-retry',
]);

const RECEIPT_FIELDS = new Set([
  'idempotency_key',
  'system',
  'external_id',
  'state',
  'ts',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Accept UTC ISO-8601 with zero to three fractional-second digits, while
// rejecting Date.parse's rollover of impossible dates (for example Feb 30).
function isStrictIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  if (!match) return false;
  const normalized = match[1] + '.' + (match[2] ?? '').padEnd(3, '0') + 'Z';
  const epoch = Date.parse(normalized);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === normalized;
}

// Validate and project onto the exact ledger shape. external_id is explicit
// null because the reconcile evidence schema always carries that field.
function normalizeReceipt(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('effect-receipts: receipt must be an object');
  }
  const unknown = Object.keys(entry).filter((key) => !RECEIPT_FIELDS.has(key));
  if (unknown.length) {
    throw new Error('effect-receipts: unknown receipt field(s): ' + unknown.sort().join(', '));
  }
  if (!isNonEmptyString(entry.idempotency_key)) {
    throw new Error('effect-receipts: idempotency_key must be a non-empty string');
  }
  if (!isNonEmptyString(entry.system)) {
    throw new Error('effect-receipts: system must be a non-empty string');
  }
  if (entry.external_id !== undefined && entry.external_id !== null
    && !isNonEmptyString(entry.external_id)) {
    throw new Error('effect-receipts: external_id must be a non-empty string or null when present');
  }
  if (!RECEIPT_STATES.includes(entry.state)) {
    throw new Error(
      'effect-receipts: state must be one of [' + RECEIPT_STATES.join('|')
        + '], got: ' + JSON.stringify(entry.state),
    );
  }
  if (!isStrictIsoTimestamp(entry.ts)) {
    throw new Error(
      'effect-receipts: ts must be a valid UTC ISO-8601 timestamp, got: '
        + JSON.stringify(entry.ts),
    );
  }
  return {
    idempotency_key: entry.idempotency_key,
    system: entry.system,
    external_id: entry.external_id ?? null,
    state: entry.state,
    ts: entry.ts,
  };
}

// Canonical JSON sorts object keys recursively and preserves array order.
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('effect-receipts: canonical JSON rejects non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('effect-receipts: canonical JSON accepts plain objects only');
    }
    return '{' + Object.keys(value).sort().map((key) => (
      JSON.stringify(key) + ':' + canonicalJson(value[key])
    )).join(',') + '}';
  }
  throw new Error('effect-receipts: canonical JSON cannot encode ' + typeof value);
}

function resolveScope(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('effect-receipts: scope must be an object when provided');
  }
  const root = String(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const memory = scope.memRoot ?? resolveMemRoot(root);
  const seatId = scope.seatId ?? seatOf(root);
  if (!isNonEmptyString(memory)) throw new Error('effect-receipts: memRoot is required');
  if (!isNonEmptyString(seatId)) throw new Error('effect-receipts: seatId is required');
  // seatId becomes a filename component; forbid traversal and separators.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(seatId)) {
    throw new Error('effect-receipts: unsafe seatId: ' + JSON.stringify(seatId));
  }
  return { memRoot: path.resolve(memory), seatId };
}

function ledgerPath(scope) {
  const resolved = resolveScope(scope);
  return path.join(
    resolved.memRoot,
    'runtime',
    'effect-receipts-' + resolved.seatId + '.jsonl',
  );
}

export function receiptDigest(entry) {
  const normalized = normalizeReceipt(entry);
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

export function appendReceipt(entry, scope) {
  // Validate and serialize before creating or opening the ledger: a refused
  // entry must leave no partial file or line behind.
  const normalized = normalizeReceipt(entry);
  const file = ledgerPath(scope);
  const line = Buffer.from(JSON.stringify(normalized) + '\n', 'utf8');
  mkdirSync(path.dirname(file), { recursive: true });

  let fd;
  let failure = null;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
      0o600,
    );
    // Exactly one append write per receipt. O_APPEND couples end-position
    // selection to this write rather than a racy stat/seek/write sequence.
    const written = writeSync(fd, line, 0, line.length, null);
    if (written !== line.length) {
      throw new Error(
        'short append (' + written + '/' + line.length + ' bytes) to ' + file,
      );
    }
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
  }

  if (failure) {
    throw new Error(
      'effect-receipts: append failed for ' + file + ': '
        + (failure?.message || failure),
    );
  }
  return normalized;
}

export function readReceipts(scope) {
  const file = ledgerPath(scope);
  if (!existsSync(file)) return [];

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      'effect-receipts: read failed for ' + file + ': '
        + (error?.message || error),
    );
  }
  if (raw.length === 0) return [];

  const lines = raw.split('\n');
  // Ignore only the split artifact from one normal terminal newline. Interior
  // blank lines remain malformed ledger records and fail closed below.
  if (lines.at(-1) === '') lines.pop();

  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      throw new Error(
        'effect-receipts: malformed line ' + lineNumber + ' in ' + file
          + ': blank line',
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        'effect-receipts: malformed JSON at line ' + lineNumber + ' in '
          + file + ': ' + (error?.message || error),
      );
    }

    try {
      return normalizeReceipt(parsed);
    } catch (error) {
      throw new Error(
        'effect-receipts: malformed receipt at line ' + lineNumber + ' in '
          + file + ': ' + (error?.message || error),
      );
    }
  });
}
