/**
 * namespace-registry.mjs
 * The single MemoryNamespaceRegistry/v1 loader and lookup implementation shared
 * by semantic-search index construction and query-time filtering.
 *
 * The registry is fail-closed: there is no absent-file default, and no caller
 * is allowed to recover a partial population from malformed input.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

const SCHEMA = 'MemoryNamespaceRegistry/v1';
const DISPOSITIONS = new Set(['INDEX', 'SKIP', 'DENY']);
const LOCAL_REGISTRY_FILENAME = 'namespace-registry.local.json';

// These are the pre-existing embed-vault.js SKIP_DIRS entries. They are runtime
// infrastructure rather than authored-memory namespaces, so a physical copy at
// the vault root is ignored by the undeclared-directory audit. No other name is
// implicitly exempt.
export const NAMESPACE_INFRASTRUCTURE_DIRS = Object.freeze([
  'node_modules',
  '.git',
  'daemons',
  '.claude',
  'command-center-v2',
  'graphify-out',
  'recon',
  'prompts',
  'tools',
]);

function namespaceKey(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

function validatePath(value, index) {
  if (typeof value !== 'string') {
    throw new Error(`namespaces[${index}].path must be a string`);
  }
  if (
    value.length === 0
    || value.trim() !== value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
  ) {
    throw new Error(`namespaces[${index}].path must be one normalized top-level segment`);
  }
}

/**
 * Validate one namespaces[] row and fold it into the given accumulators.
 * Shared, byte-identical, between the core loader and the local extension
 * loader below so the two can never drift on what a valid row is.
 */
function validateAndCollectRow(row, index, rows, byPath) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`namespaces[${index}] must be an object`);
  }

  validatePath(row.path, index);
  const key = namespaceKey(row.path);
  if (byPath.has(key)) {
    throw new Error(`duplicate namespace path: ${row.path}`);
  }
  if (!DISPOSITIONS.has(row.disposition)) {
    throw new Error(`namespaces[${index}] has invalid disposition: ${String(row.disposition)}`);
  }
  if (
    (row.disposition === 'SKIP' || row.disposition === 'DENY')
    && (typeof row.reason !== 'string' || row.reason.trim().length === 0)
  ) {
    throw new Error(`namespaces[${index}] ${row.disposition} row requires a non-empty reason`);
  }

  rows.push(row);
  byPath.set(key, row);
}

/**
 * Read and validate <dir>/namespace-registry.json.
 *
 * Missing, unreadable, and malformed files all throw. The returned `rows`
 * preserve registry order; `byPath` is keyed case-insensitively with normalized
 * separators so duplicate detection and runtime lookup share one identity rule.
 */
export function loadNamespaceRegistry(dir) {
  const registryPath = join(dir, 'namespace-registry.json');
  let text;
  try {
    text = readFileSync(registryPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${registryPath}: ${error.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${registryPath}: ${error.message}`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('namespace registry root must be an object');
  }
  if (raw.schema !== SCHEMA) {
    throw new Error(`namespace registry schema must equal exactly ${SCHEMA}`);
  }
  if (!Array.isArray(raw.namespaces)) {
    throw new Error('namespace registry namespaces must be an array');
  }

  const rows = [];
  const byPath = new Map();
  for (let index = 0; index < raw.namespaces.length; index++) {
    validateAndCollectRow(raw.namespaces[index], index, rows, byPath);
  }

  return { rows, byPath };
}

/**
 * Read and validate <dir>/namespace-registry.local.json: the optional,
 * operator-owned extension registry (issue #48). Absent is the fresh-install
 * state and is valid -- returns null, meaning "no local extension configured".
 * Present-but-unusable (unreadable, malformed JSON, wrong schema, invalid row)
 * throws, matching the core loader's fail-closed contract and row-validation
 * rules exactly (same validateAndCollectRow).
 */
export function loadLocalNamespaceRegistry(dir, fileName = LOCAL_REGISTRY_FILENAME) {
  const registryPath = join(dir, fileName);
  let text;
  try {
    text = readFileSync(registryPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`cannot read ${registryPath}: ${error.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${registryPath}: ${error.message}`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`local namespace registry root must be an object: ${registryPath}`);
  }
  if (raw.schema !== SCHEMA) {
    throw new Error(`local namespace registry schema must equal exactly ${SCHEMA}: ${registryPath}`);
  }
  if (!Array.isArray(raw.namespaces)) {
    throw new Error(`local namespace registry namespaces must be an array: ${registryPath}`);
  }

  const rows = [];
  const byPath = new Map();
  for (let index = 0; index < raw.namespaces.length; index++) {
    validateAndCollectRow(raw.namespaces[index], index, rows, byPath);
  }

  return { rows, byPath };
}

/**
 * Compose the pinned core registry with the optional local extension.
 * Local rows may only ADD top-level paths: any local path that already
 * exists in the core registry throws, closed, regardless of whether the
 * disposition matches -- a local row can never override or duplicate a core
 * path. `local === null` (no local file) returns `core` unchanged.
 */
export function composeNamespaceRegistry(core, local) {
  if (!local) return core;

  const rows = core.rows.slice();
  const byPath = new Map(core.byPath);
  for (const row of local.rows) {
    const key = namespaceKey(row.path);
    if (byPath.has(key)) {
      throw new Error(`local namespace registry duplicates a core-registry path: ${row.path}`);
    }
    rows.push(row);
    byPath.set(key, row);
  }
  return { rows, byPath };
}

/** Return INDEX, SKIP, DENY, or undefined for one physical top-level segment. */
export function namespaceDisposition(registry, topLevelSegment) {
  if (typeof topLevelSegment !== 'string' || topLevelSegment.length === 0) return undefined;
  return registry.byPath.get(namespaceKey(topLevelSegment))?.disposition;
}

/** Resolve a vault-relative note path through its normalized top-level segment. */
export function namespaceDispositionForPath(registry, vaultRelativePath) {
  if (typeof vaultRelativePath !== 'string') return undefined;
  const topLevelSegment = vaultRelativePath.replace(/\\/g, '/').split('/')[0];
  return namespaceDisposition(registry, topLevelSegment);
}

/**
 * Return physical top-level directories that have no registry row. Dirent
 * symlinks are intentionally not treated as directories: the contract calls
 * for readdirSync({withFileTypes:true}) and physical directories only.
 */
export function undeclaredNamespaceDirectories(registry, vaultRoot) {
  const infrastructure = new Set(NAMESPACE_INFRASTRUCTURE_DIRS);
  const declaredPaths = new Set(registry.rows.map((row) => row.path));
  return readdirSync(vaultRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !infrastructure.has(name))
    // Physical spelling is exact. Runtime note lookup is deliberately
    // case-insensitive, but accepting `Feedback/` for a `feedback` row would
    // make collectFiles() walk a different path on case-sensitive filesystems.
    .filter((name) => !declaredPaths.has(name))
    .sort((a, b) => a.localeCompare(b));
}

/** Throw, naming every physical directory not declared by the registry. */
export function assertNoUndeclaredNamespaceDirectories(registry, vaultRoot) {
  const undeclared = undeclaredNamespaceDirectories(registry, vaultRoot);
  if (undeclared.length > 0) {
    throw new Error(`undeclared vault namespace director${undeclared.length === 1 ? 'y' : 'ies'}: ${undeclared.join(', ')}`);
  }
}

/**
 * Fail-closed process gate matching deny-list.mjs's require idiom. This is
 * the ONE composed loader: embed-vault.js and search-vault.js both call this
 * (never loadNamespaceRegistry/loadLocalNamespaceRegistry directly), so the
 * core+local composition lives here exactly once for both callers.
 */
export function requireNamespaceRegistry(dir, label) {
  try {
    const core = loadNamespaceRegistry(dir);
    const local = loadLocalNamespaceRegistry(dir);
    return composeNamespaceRegistry(core, local);
  } catch (error) {
    console.error(`[${label}] REFUSING to run: the namespace registry cannot be used (${error.message}). Fix the registry before indexing or searching.`);
    process.exit(1);
  }
}

/** Fail-closed physical-directory gate shared by both runtime callers. */
export function requireDeclaredNamespaceDirectories(registry, vaultRoot, label) {
  try {
    assertNoUndeclaredNamespaceDirectories(registry, vaultRoot);
  } catch (error) {
    console.error(`[${label}] REFUSING to run: ${error.message}. Declare the directory in namespace-registry.json before indexing or searching.`);
    process.exit(1);
  }
}
