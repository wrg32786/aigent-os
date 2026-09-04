'use strict';
// memory-root.cjs -- the ONE resolver for a seat's memory root.
//
// Every core reader and writer of memory (capsule selection, the resume verb,
// the Stop-hook capsule writer, the prompt journal, Auto-Refresh's runner and
// transport, the nightly pass, vault sync, semantic search, the heat index,
// doctor and the installer) reaches the memory tree through this module, and
// nothing else decides where that tree is. Before it, five places each carried
// their own copy of the rule ("vault/memory, else memory"), and a seat whose
// live tree sat beside a dead default tree could be read by one component and
// written by another.
//
// Configuration lives where the rest of the seat's local state already lives:
// <root>/.aigent/state.json, the install marker the installer writes once and
// never rewrites, in the optional field "memory_root". It is a path RELATIVE to
// the root, forward slashes, no ".." and no absolute forms. A stock install
// declares nothing and keeps the documented default, vault/memory.
//
//   stock            (absent)                 -> <root>/vault/memory
//   a seat           "memory"                 -> <root>/memory
//   a nested layout  ".seat/vault/memory"     -> <root>/.seat/vault/memory
//
// FAIL LOUD, never sideways. A declared root that is missing, malformed, unsafe
// (absolute, escaping the root, through a symlink) or unreadable throws a
// MemoryRootError whose message starts with the greppable token MEMORY-ROOT:.
// The alternative, falling back to the default tree, is exactly the failure
// this module exists to end: the seat would silently read or write a tree that
// is not its memory. When a root IS configured, the default candidates are not
// consulted at all, so a dead default tree beside the live one can never become
// active again.
//
// CommonJS on purpose: the ESM daemons import it as a named export and the
// CommonJS heat writer requires it, so there is one implementation, not two.
//
// CLI, for the shell consumers (installer, doctor, system-check, shell hooks):
//   node daemons/memory-root.cjs --root <base> [--relative] [--allow-missing]
// prints the resolved path on stdout, or one MEMORY-ROOT: line on stderr with
// exit 1. --allow-missing is for the installer, which resolves the root in
// order to CREATE it; every runtime caller requires it to exist.

const fs = require('node:fs');
const path = require('node:path');

const STATE_MARKER_REL = ['.aigent', 'state.json'];
const MEMORY_ROOT_FIELD = 'memory_root';
const DEFAULT_MEMORY_ROOT = 'vault/memory';
// Kept for UNCONFIGURED roots only, unchanged from the rule every daemon used
// before this module: the first existing of the two wins, else the default.
const UNCONFIGURED_CANDIDATES = [DEFAULT_MEMORY_ROOT, 'memory'];
const ERROR_TOKEN = 'MEMORY-ROOT:';
const MAX_RELATIVE_CHARS = 240;

class MemoryRootError extends Error {
  constructor(message) {
    super(`${ERROR_TOKEN} ${message}`);
    this.name = 'MemoryRootError';
    this.code = 'EMEMORYROOT';
  }
}

function markerPath(base) {
  return path.join(base, ...STATE_MARKER_REL);
}

// The declared value is data an operator typed. Everything that could make it
// name a tree outside the root, or a different tree than the one they read
// back, is refused by name.
function validateRelative(value, marker) {
  if (typeof value !== 'string') {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must be a string`);
  }
  const relative = value.trim();
  if (relative.length === 0) {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must not be empty`);
  }
  if (relative.length > MAX_RELATIVE_CHARS) {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must be at most ${MAX_RELATIVE_CHARS} characters`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(relative)) {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must not contain control characters`);
  }
  if (relative.includes('\\')) {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must use forward slashes`);
  }
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || path.isAbsolute(relative)) {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must be relative to the install root, not absolute`);
  }
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.')) {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must not contain an empty or . path segment`);
  }
  if (segments.includes('..')) {
    throw new MemoryRootError(`${marker}: ${MEMORY_ROOT_FIELD} must not contain a .. segment`);
  }
  return { relative: segments.join('/'), segments };
}

// Returns null when the marker is absent or declares nothing. Throws on a
// marker that exists but cannot be trusted: the presence of a declaration
// cannot be known, so neither tree may be assumed.
function readDeclaration(base) {
  const marker = markerPath(base);
  let text;
  try {
    text = fs.readFileSync(marker, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new MemoryRootError(`${marker}: cannot be read (${error?.code || error?.message || error})`);
  }
  let state;
  try {
    state = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new MemoryRootError(`${marker}: is not valid JSON (${error.message})`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new MemoryRootError(`${marker}: root must be an object`);
  }
  if (!Object.prototype.hasOwnProperty.call(state, MEMORY_ROOT_FIELD)) return null;
  if (state[MEMORY_ROOT_FIELD] === null) return null;
  return validateRelative(state[MEMORY_ROOT_FIELD], marker);
}

// A configured root is walked segment by segment and refused if any segment is
// a symlink: a link could point the whole memory tree outside the root, and
// the vault-sync writer already refuses to write through one.
function refuseSymlinks(base, segments) {
  let walked = base;
  for (const segment of segments) {
    walked = path.join(walked, segment);
    let stat;
    try {
      stat = fs.lstatSync(walked);
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw new MemoryRootError(`${walked}: cannot be inspected (${error?.code || error?.message || error})`);
    }
    if (stat.isSymbolicLink()) {
      throw new MemoryRootError(`${walked}: configured memory root passes through a symlink`);
    }
  }
}

/**
 * Describe the memory root under `base`.
 *
 * Returns {root, relative, source} where source is 'configured' or 'default'.
 * `root` is path.join(base, relative), never realpath-resolved, so a caller
 * that compares it to its own join sees the same string.
 */
function describeMemoryRoot(base, { allowMissing = false } = {}) {
  if (typeof base !== 'string' || base.trim().length === 0) {
    throw new MemoryRootError('a base directory is required to resolve the memory root');
  }
  const declared = readDeclaration(base);
  if (declared) {
    refuseSymlinks(base, declared.segments);
    const root = path.join(base, ...declared.segments);
    let stat = null;
    try {
      stat = fs.statSync(root);
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) {
        throw new MemoryRootError(`${root}: configured memory root cannot be inspected (${error?.code || error?.message || error})`);
      }
    }
    if (stat && !stat.isDirectory()) {
      throw new MemoryRootError(`${root}: configured memory root is not a directory`);
    }
    if (!stat && !allowMissing) {
      throw new MemoryRootError(`${root}: configured memory root does not exist (declared in ${markerPath(base)})`);
    }
    return { root, relative: declared.relative, source: 'configured' };
  }
  for (const candidate of UNCONFIGURED_CANDIDATES) {
    const root = path.join(base, ...candidate.split('/'));
    if (fs.existsSync(root)) return { root, relative: candidate, source: 'default' };
  }
  return {
    root: path.join(base, ...DEFAULT_MEMORY_ROOT.split('/')),
    relative: DEFAULT_MEMORY_ROOT,
    source: 'default',
  };
}

function resolveMemoryRoot(base, options) {
  return describeMemoryRoot(base, options).root;
}

// --default prints the resolver's default relative root and nothing else, so a
// shell consumer can ask "is this seat's root the default?" without carrying
// the literal itself.
const CLI_FLAGS = new Set(['--root', '--relative', '--allow-missing', '--json', '--default']);

function cli(argv, out = process.stdout, err = process.stderr) {
  const opts = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!CLI_FLAGS.has(flag)) {
      err.write(`${ERROR_TOKEN} unknown argument: ${JSON.stringify(String(flag))}\n`);
      return 1;
    }
    if (flag === '--root') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        err.write(`${ERROR_TOKEN} --root needs a value\n`);
        return 1;
      }
      if (opts.has('--root')) {
        err.write(`${ERROR_TOKEN} --root given twice\n`);
        return 1;
      }
      opts.set('--root', value);
      i += 1;
    } else {
      opts.set(flag, true);
    }
  }
  if (opts.has('--default')) {
    if (opts.size !== 1) {
      err.write(`${ERROR_TOKEN} --default takes no other argument\n`);
      return 1;
    }
    out.write(`${DEFAULT_MEMORY_ROOT}\n`);
    return 0;
  }
  if (!opts.has('--root')) {
    err.write(`${ERROR_TOKEN} --root is required\n`);
    return 1;
  }
  try {
    const described = describeMemoryRoot(opts.get('--root'), { allowMissing: opts.has('--allow-missing') });
    if (opts.has('--json')) {
      out.write(`${JSON.stringify(described)}\n`);
    } else {
      out.write(`${opts.has('--relative') ? described.relative : described.root}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof MemoryRootError
      ? error.message
      : `${ERROR_TOKEN} resolver failed: ${String(error?.message || error).replace(/\s+/g, ' ')}`;
    err.write(`${message}\n`);
    return 1;
  }
}

module.exports = {
  DEFAULT_MEMORY_ROOT,
  MEMORY_ROOT_FIELD,
  MEMORY_ROOT_ERROR_TOKEN: ERROR_TOKEN,
  MemoryRootError,
  describeMemoryRoot,
  resolveMemoryRoot,
  cli,
};

if (require.main === module) {
  process.exitCode = cli(process.argv.slice(2));
}
