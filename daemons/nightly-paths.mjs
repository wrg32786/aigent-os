import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(DAEMON_DIR, '..');

export const DEFAULT_NIGHTLY_TIME_ZONE = 'America/Los_Angeles';
export const DEFAULT_NIGHTLY_CUTOFF_HOUR = 4;

function firstEnvironmentValue(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function normalizeFilesystemPath(value) {
  const raw = String(value || '').trim();
  if (process.platform !== 'win32') return raw;
  if (/^\/[A-Za-z]:\//.test(raw)) return raw.slice(1);
  const gitBash = raw.match(/^\/([A-Za-z])(?:\/|$)(.*)$/);
  if (gitBash) return `${gitBash[1].toUpperCase()}:/${gitBash[2]}`;
  return raw;
}

export function defaultNightlyRoot(env = process.env) {
  return path.resolve(
    normalizeFilesystemPath(
      firstEnvironmentValue(
        env,
        ['AIGENT_ROOT', 'AIGENT_OS_ROOT', 'AIGENT_PROJECT_DIR', 'CLAUDE_PROJECT_DIR'],
      )
      || REPOSITORY_ROOT,
    ),
  );
}

export function normalizeTimeZone(value = DEFAULT_NIGHTLY_TIME_ZONE) {
  const timeZone = String(value || DEFAULT_NIGHTLY_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`invalid nightly time zone: ${timeZone}`);
  }
  return timeZone;
}

export function normalizeCutoffHour(value = DEFAULT_NIGHTLY_CUTOFF_HOUR) {
  const cutoffHour = Number(value);
  if (!Number.isInteger(cutoffHour) || cutoffHour < 0 || cutoffHour > 23) {
    throw new Error(`nightly cutoff hour must be an integer from 0 through 23: ${value}`);
  }
  return cutoffHour;
}

export function resolveNightlyConfig({
  timeZone,
  cutoffHour,
  env = process.env,
} = {}) {
  return {
    timeZone: normalizeTimeZone(
      timeZone
        ?? firstEnvironmentValue(env, ['AIGENT_NIGHTLY_TIME_ZONE'])
        ?? DEFAULT_NIGHTLY_TIME_ZONE,
    ),
    cutoffHour: normalizeCutoffHour(
      cutoffHour
        ?? firstEnvironmentValue(env, ['AIGENT_NIGHTLY_CUTOFF_HOUR'])
        ?? DEFAULT_NIGHTLY_CUTOFF_HOUR,
    ),
  };
}

export function resolveNightlyPaths(root = defaultNightlyRoot(), {
  stateHome,
  env = process.env,
} = {}) {
  const repositoryRoot = path.resolve(
    normalizeFilesystemPath(root || defaultNightlyRoot(env)),
  );
  const selectedStateHome = stateHome
    ?? firstEnvironmentValue(env, ['AIGENT_STATE_HOME_DIR'])
    ?? repositoryRoot;
  const stateRoot = path.resolve(normalizeFilesystemPath(selectedStateHome));
  const vaultMemory = path.join(stateRoot, 'vault', 'memory');
  const directMemory = path.join(stateRoot, 'memory');
  const memoryRoot = existsSync(vaultMemory)
    ? vaultMemory
    : existsSync(directMemory)
      ? directMemory
      : vaultMemory;
  return {
    repositoryRoot,
    stateRoot,
    vaultRoot: path.dirname(memoryRoot),
    memoryRoot,
    runtimeRoot: path.join(memoryRoot, 'runtime'),
    layout: memoryRoot === directMemory ? 'memory' : 'vault/memory',
  };
}

export function resolveMemoryRelative(paths, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const withoutPrefix = normalized.startsWith('memory/')
    ? normalized.slice('memory/'.length)
    : normalized;
  return path.resolve(paths.memoryRoot, ...withoutPrefix.split('/').filter(Boolean));
}

export function resolveRepositoryOrMemoryPath(paths, requested) {
  const value = String(requested || '').trim();
  if (!value) return '';
  if (path.isAbsolute(value)) return path.resolve(value);
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (normalized === 'memory' || normalized.startsWith('memory/')) {
    return resolveMemoryRelative(paths, normalized === 'memory' ? '' : normalized);
  }
  return path.resolve(paths.repositoryRoot, ...normalized.split('/').filter(Boolean));
}

export function pathInside(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

export function pathInsideOperationalRoots(paths, target) {
  return pathInside(paths.repositoryRoot, target) || pathInside(paths.stateRoot, target);
}

export function portablePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

const CHILD_ENV_NAMES = Object.freeze([
  'ALLUSERSPROFILE',
  'APPDATA',
  'BASH_EXE',
  'COLORTERM',
  'ComSpec',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'Path',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'ProgramFiles',
  'PROGRAMFILES',
  'ProgramW6432',
  'PSModulePath',
  'SHELL',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

export function buildNightlyChildEnv({
  paths,
  timeZone,
  cutoffHour,
  parentEnv = process.env,
} = {}) {
  if (!paths) throw new Error('nightly child environment requires resolved paths');
  const env = {};
  const available = new Map(
    Object.keys(parentEnv || {}).map((key) => [key.toUpperCase(), key]),
  );
  for (const requested of CHILD_ENV_NAMES) {
    const actual = available.get(requested.toUpperCase());
    if (actual && parentEnv[actual] !== undefined) env[actual] = parentEnv[actual];
  }
  env.AIGENT_OS_ROOT = paths.repositoryRoot;
  env.AIGENT_ROOT = paths.repositoryRoot;
  env.AIGENT_PROJECT_DIR = paths.repositoryRoot;
  env.CLAUDE_PROJECT_DIR = paths.repositoryRoot;
  env.AIGENT_STATE_HOME_DIR = paths.stateRoot;
  env.AIGENT_NIGHTLY_TIME_ZONE = normalizeTimeZone(timeZone);
  env.AIGENT_NIGHTLY_CUTOFF_HOUR = String(normalizeCutoffHour(cutoffHour));
  return env;
}
