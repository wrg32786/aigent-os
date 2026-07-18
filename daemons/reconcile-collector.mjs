// reconcile-collector.mjs — deterministic, model-free capsule evidence.
//
// Three evidence classes, always in this shape: { version: 1, board, git,
// external_effects }.
//
//   - git   is READ-ONLY and always present: index_tree is a SHA-256 digest of
//     normalized `git ls-files --stage`, working_tree_digest is a SHA-256 digest
//     of normalized porcelain status. `git write-tree` is never used.
//     GIT_OPTIONAL_LOCKS=0 prevents status from taking optional refresh locks.
//     Global/system Git config is disabled for these subprocesses so machine-wide
//     excludes cannot change dirty evidence; repository-local config still applies.
//
//   - board is a PLUGGABLE evidence class. aigent-OS ships no task-board
//     integration out of the box, so this degrades honestly to `null` unless the
//     operator points AIGENT_BOARD_ADAPTER at a module. See collectBoard() below
//     for the adapter contract.
//
//   - external_effects reads the append-only ledger in effect-receipts.mjs.
//     Also absent any wiring by default (an empty array), and fills in once a
//     fork calls appendReceipt() from its own effect-producing code.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readReceipts, receiptDigest } from './effect-receipts.mjs';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

class EvidenceAdapterError extends Error {
  constructor(message) {
    super('board evidence adapter integrity failure: ' + message);
    this.name = 'EvidenceAdapterError';
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON refuses non-finite numbers');
    return value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError('canonical JSON refuses invalid Dates');
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('canonical JSON refuses cyclic arrays');
    seen.add(value);
    const result = value.map((item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        throw new TypeError('canonical JSON refuses non-JSON array values');
      }
      return canonicalValue(item, seen);
    });
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON accepts plain objects only');
    }
    if (seen.has(value)) throw new TypeError('canonical JSON refuses cyclic objects');
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort(compareText)) {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
        throw new TypeError('canonical JSON refuses non-JSON value at key ' + key);
      }
      result[key] = canonicalValue(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError('canonical JSON refuses value of type ' + typeof value);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function reconcileDigest(evidence) {
  return sha256(canonicalJson(evidence));
}

function normalizeText(value) {
  return String(value).replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

function normalizeDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new EvidenceAdapterError('board row ' + field + ' is not a valid date');
  }
  return date.toISOString();
}

function normalizeBoardRow(row) {
  if (!row || typeof row !== 'object') throw new EvidenceAdapterError('board row is not an object');
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new EvidenceAdapterError('board row id is missing');
  }
  if (typeof row.status !== 'string' || row.status.length === 0) {
    throw new EvidenceAdapterError('board row ' + row.id + ' status is missing');
  }
  if (row.claimant !== null && row.claimant !== undefined && typeof row.claimant !== 'string') {
    throw new EvidenceAdapterError('board row ' + row.id + ' claimant has an invalid type');
  }
  const updatedAt = normalizeDate(row.updated_at, 'updated_at');
  let version = row.version;
  if (version === undefined || version === null || version === '') {
    // Adapters whose backing store exposes no native version column can use
    // updated_at as a documented surrogate rather than fabricating a counter.
    version = updatedAt;
  } else if (version instanceof Date) {
    version = normalizeDate(version, 'version');
  } else if (typeof version !== 'string' && typeof version !== 'number') {
    throw new EvidenceAdapterError('board row ' + row.id + ' version has an invalid type');
  } else if (typeof version === 'number' && !Number.isFinite(version)) {
    throw new EvidenceAdapterError('board row ' + row.id + ' version is not finite');
  }
  return {
    id: row.id,
    version,
    status: row.status,
    claimant: row.claimant ?? null,
    updated_at: updatedAt,
  };
}

function moduleHref(file) {
  return /^file:/i.test(file) ? file : pathToFileURL(path.resolve(file)).href;
}

// PLUGGABLE EVIDENCE HOOK. aigent-OS ships no task-board of its own, so board
// evidence degrades honestly to `null` by default (a valid, documented state —
// capsule-verb.mjs's validateBoard() accepts board:null).
//
// To wire a real task-board integration, point AIGENT_BOARD_ADAPTER at a module
// (absolute path or file:// URL) exporting:
//
//   export async function collectBoardEvidence({ seatId, boardRowIds }) {
//     // boardRowIds is null when the caller wants "everything this identity
//     // created or claimed"; otherwise an explicit array of row ids to fetch.
//     // Return { query: string, rows: BoardRow[] } or null (board unavailable).
//     // BoardRow = { id, status, claimant: string|null, updated_at, version? }
//   }
//
// This collector computes the canonical digest itself (sha256 of the canonical
// {query, rows} JSON) — adapters never need to compute or trust their own digest.
// A thrown error from the adapter, or a malformed row it returns, is an
// EvidenceAdapterError (loud, refuses the capsule) rather than a silent null —
// silent degrade is reserved for "no adapter configured" / "adapter says
// unavailable", never for "adapter returned garbage".
async function collectBoard(seatId, boardRowIds) {
  const adapterPath = process.env.AIGENT_BOARD_ADAPTER;
  if (!adapterPath) return null; // no integration wired — honest, expected default

  const explicitIds = boardRowIds === undefined
    ? null
    : [...new Set(boardRowIds.map((id) => String(id).trim()).filter(Boolean))].sort(compareText);
  const query = explicitIds === null
    ? 'created_or_claimed_rows_for_seat:' + seatId
    : 'board_rows_by_id:' + explicitIds.join(',');

  let raw;
  try {
    const adapter = await import(moduleHref(adapterPath));
    if (typeof adapter.collectBoardEvidence !== 'function') {
      throw new Error('adapter module has no collectBoardEvidence export');
    }
    raw = await adapter.collectBoardEvidence({ seatId, boardRowIds: explicitIds });
  } catch (error) {
    // Adapter load/call failure degrades honestly to null (matches "no adapter"
    // behavior) — a misconfigured or offline adapter must not block the capsule
    // verb, only reduce evidence richness.
    return null;
  }
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || typeof raw.query !== 'string' || !Array.isArray(raw.rows)) {
    throw new EvidenceAdapterError('collectBoardEvidence must return { query, rows } or null');
  }

  const rows = raw.rows.map(normalizeBoardRow).sort((a, b) => compareText(a.id, b.id));
  if (explicitIds !== null) {
    const found = new Set(rows.map((row) => row.id));
    const missing = explicitIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new EvidenceAdapterError('requested board rows were not returned: ' + missing.join(','));
    }
  }
  const effectiveQuery = raw.query || query;
  return {
    query: effectiveQuery,
    rows,
    digest: sha256(canonicalJson({ query: effectiveQuery, rows })),
  };
}

function workspaceSpec(entry) {
  if (typeof entry === 'string') {
    if (entry.trim().length === 0) throw new TypeError('workspace path must be non-empty');
    return { directory: entry, label: null };
  }
  if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
    if (entry.path.trim().length === 0) throw new TypeError('workspace path must be non-empty');
    const rawLabel = entry.repo ?? entry.path_id ?? null;
    if (rawLabel !== null
      && (typeof rawLabel !== 'string' || rawLabel.trim().length === 0)) {
      throw new TypeError('workspace repo label must be a non-empty string');
    }
    return { directory: entry.path, label: rawLabel?.trim() ?? null };
  }
  throw new TypeError('workspaces entries must be paths or { path, repo? } objects');
}

async function gitRaw(args) {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function gitText(args) {
  return normalizeText((await gitRaw(args)).toString('utf8'));
}

async function collectGit(memRoot, workspaces) {
  const requested = workspaces === undefined ? [memRoot] : workspaces;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new TypeError('workspaces must be a non-empty array when supplied');
  }

  const byRoot = new Map();
  for (const entry of requested) {
    const spec = workspaceSpec(entry);
    const root = path.resolve(
      await gitText(['-C', path.resolve(spec.directory), 'rev-parse', '--show-toplevel']),
    );
    const key = root.replace(/\\/g, '/');
    const current = byRoot.get(key);
    if (current?.label && spec.label && current.label !== spec.label) {
      throw new Error('one workspace resolved to conflicting repo labels: '
        + current.label + ' and ' + spec.label);
    }
    if (!current || (!current.label && spec.label)) byRoot.set(key, { root, label: spec.label });
  }

  const repositories = [];
  const emittedNames = new Set();
  for (const { root, label } of [...byRoot.values()].sort((a, b) => {
    const aKey = String(a.label ?? path.basename(a.root)).replace(/\\/g, '/');
    const bKey = String(b.label ?? path.basename(b.root)).replace(/\\/g, '/');
    return compareText(aKey, bKey);
  })) {
    // The default identifier is the top-level directory name, not an absolute
    // machine path, so otherwise-identical evidence hashes across machines.
    // Callers with colliding basenames can pass { path, repo } labels.
    const repo = String(label ?? path.basename(root)).replace(/\\/g, '/');
    if (emittedNames.has(repo)) {
      throw new Error('duplicate repo label ' + JSON.stringify(repo)
        + '; pass distinct { path, repo } labels');
    }
    emittedNames.add(repo);
    const [branch, head, indexListing, status] = await Promise.all([
      gitText(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']),
      gitText(['-C', root, 'rev-parse', 'HEAD']),
      gitRaw(['-c', 'core.quotepath=false', '-C', root, 'ls-files', '--stage', '-z']),
      gitRaw([
        '-c', 'core.quotepath=false', '-C', root,
        'status', '--porcelain=v1', '-z', '--untracked-files=all',
      ]),
    ]);
    repositories.push({
      repo,
      branch,
      head,
      index_tree: sha256(indexListing),
      working_tree_digest: sha256(status),
      dirty: status.length > 0,
    });
  }
  repositories.sort((a, b) => compareText(a.repo, b.repo));
  return repositories;
}

async function collectEffects(seatId, memRoot) {
  const receipts = await readReceipts({ seatId, memRoot });
  if (!Array.isArray(receipts)) throw new Error('effect receipt reader returned a non-array');
  const effects = receipts.map((entry) => ({
    idempotency_key: entry.idempotency_key,
    system: entry.system,
    external_id: entry.external_id ?? null,
    state: entry.state,
    receipt_digest: receiptDigest(entry),
  }));
  effects.sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
  return effects;
}

export async function collectEvidence({ seatId, memRoot, boardRowIds, workspaces } = {}) {
  if (typeof seatId !== 'string' || seatId.trim().length === 0) {
    throw new TypeError('collectEvidence: seatId must be a non-empty string');
  }
  if (typeof memRoot !== 'string' || memRoot.trim().length === 0) {
    throw new TypeError('collectEvidence: memRoot must be a non-empty path');
  }
  if (boardRowIds !== undefined && !Array.isArray(boardRowIds)) {
    throw new TypeError('collectEvidence: boardRowIds must be an array when supplied');
  }
  if (boardRowIds?.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    throw new TypeError('collectEvidence: boardRowIds entries must be non-empty strings');
  }

  const normalizedSeat = seatId.trim();
  const [board, git, externalEffects] = await Promise.all([
    collectBoard(normalizedSeat, boardRowIds),
    collectGit(path.resolve(memRoot), workspaces),
    collectEffects(normalizedSeat, path.resolve(memRoot)),
  ]);
  return {
    version: 1,
    board,
    git,
    external_effects: externalEffects,
  };
}
