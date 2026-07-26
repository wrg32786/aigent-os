#!/usr/bin/env node
// Safe mechanical predicates for nightly ledger capture. Arguments are parsed
// as data and dispatched to a fixed allowlist; no shell text is executed.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultNightlyRoot,
  pathInside,
  pathInsideOperationalRoots,
  resolveNightlyPaths,
  resolveRepositoryOrMemoryPath,
} from './nightly-paths.mjs';

export const LEDGER_PREDICATE_TYPES = Object.freeze([
  'file_sha256_equals',
  'json_field_equals',
  'git_commit_present',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(
    typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(stable(value)),
  ).digest('hex');
}

function targetInside(paths, requested) {
  const target = resolveRepositoryOrMemoryPath(paths, requested);
  if (!requested || !target || !pathInsideOperationalRoots(paths, target)) {
    throw new Error(`predicate target escapes operational roots: ${requested}`);
  }
  if (existsSync(target)) {
    const resolvedTarget = realpathSync(target);
    const allowedRoots = [paths.repositoryRoot, paths.stateRoot]
      .filter(existsSync)
      .map((root) => realpathSync(root));
    if (!allowedRoots.some((root) => pathInside(root, resolvedTarget))) {
      throw new Error(`predicate target resolves outside operational roots: ${requested}`);
    }
  }
  return target;
}

function jsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (!String(pointer).startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  return String(pointer).slice(1).split('/').reduce((cursor, token) => {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object' || !(key in cursor)) {
      throw new Error(`JSON pointer not found: ${pointer}`);
    }
    return cursor[key];
  }, value);
}

export function receiptHash(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receipt_hash;
  return hash(unsigned);
}

export function runLedgerPredicate({
  root = defaultNightlyRoot(),
  type,
  args = {},
  expected,
  now = new Date(),
} = {}) {
  if (!root) throw new Error('root is required');
  if (!LEDGER_PREDICATE_TYPES.includes(type)) {
    throw new Error(`predicate type not allowlisted: ${type}`);
  }
  const paths = resolveNightlyPaths(root);
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const observedAt = instant.toISOString();
  let observed;
  let ok = false;
  let artifactRef;
  let error = null;

  try {
    if (type === 'file_sha256_equals') {
      if (!/^[0-9a-f]{64}$/i.test(String(expected))) {
        throw new Error('expected SHA-256 must be 64 hexadecimal characters');
      }
      const target = targetInside(paths, args.path);
      observed = existsSync(target) ? hash(readFileSync(target)) : 'missing';
      artifactRef = `file:${String(args.path).replace(/\\/g, '/')}#sha256=${observed}`;
      ok = observed.toLowerCase() === String(expected).toLowerCase();
    } else if (type === 'json_field_equals') {
      const target = targetInside(paths, args.path);
      const document = JSON.parse(readFileSync(target, 'utf8'));
      observed = jsonPointer(document, args.pointer);
      artifactRef = `file:${String(args.path).replace(/\\/g, '/')}#${args.pointer || ''}`;
      ok = JSON.stringify(stable(observed)) === JSON.stringify(stable(expected));
    } else {
      if (!/^[0-9a-f]{7,40}$/i.test(String(args.sha || ''))) {
        throw new Error('git sha must be 7-40 hexadecimal characters');
      }
      const repo = targetInside(paths, args.repo || '.');
      execFileSync('git', ['-C', repo, 'cat-file', '-e', `${args.sha}^{commit}`], {
        stdio: 'ignore',
        windowsHide: true,
      });
      observed = true;
      artifactRef = `git:${args.sha}`;
      ok = expected === true;
    }
  } catch (caught) {
    observed = observed ?? 'error';
    error = String(caught?.message || caught).replace(/[\r\n]+/g, ' ').slice(0, 300);
    ok = false;
    artifactRef = artifactRef || 'none:predicate-error';
  }

  const receipt = {
    schema_version: 1,
    type,
    args: stable(args),
    expected: stable(expected),
    observed: stable(observed),
    exit_code: ok ? 0 : 1,
    observed_at: observedAt,
    artifact_ref: artifactRef,
    error,
  };
  receipt.receipt_hash = receiptHash(receipt);
  return receipt;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    out[token.slice(2)] = hasValue ? next : true;
    if (hasValue) index += 1;
  }
  return out;
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  try {
    const cli = parseArgs(process.argv.slice(2));
    const type = String(cli.type || '');
    const args = type === 'git_commit_present'
      ? { repo: String(cli.repo || '.'), sha: String(cli.sha || '') }
      : type === 'json_field_equals'
        ? { path: String(cli.path || ''), pointer: String(cli.pointer || '') }
        : { path: String(cli.path || '') };
    const expected = type === 'git_commit_present'
      ? true
      : type === 'json_field_equals'
        ? JSON.parse(String(cli['expected-json']))
        : String(cli.expected || '');
    const result = runLedgerPredicate({
      root: path.resolve(String(cli.root || defaultNightlyRoot())),
      type,
      args,
      expected,
      now: cli.now ? new Date(String(cli.now)) : new Date(),
    });
    process.stdout.write(
      `LEDGER_PREDICATE ${result.exit_code === 0 ? 'PASS' : 'FAIL'}`
      + ` ${JSON.stringify(result)}\n`,
    );
    process.exit(result.exit_code);
  } catch (error) {
    process.stderr.write(
      `LEDGER_PREDICATE ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(2);
  }
}
