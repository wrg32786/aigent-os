#!/usr/bin/env node
// Proves the public invocation alias resolves to the repository-local hardened
// specification and that every required supporting skill is production-ready.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitNightlyAlert, resolveNightlyAlerts } from './nightly-alerts.mjs';
import {
  NIGHTLY_CHECKPOINTS, NIGHTLY_PROTOCOL,
} from './nightly-pass.mjs';
import { defaultNightlyRoot } from './nightly-paths.mjs';

export const NIGHTLY_ROUTE_ALIAS = 'nightly-close-parity';
export const NIGHTLY_ROUTE_SENTINEL = `NIGHTLY_LOCAL_PROTOCOL: ${NIGHTLY_PROTOCOL}`;

function fileText(file, failures, label) {
  if (!existsSync(file)) {
    failures.push(`${label} missing: ${file.replace(/\\/g, '/')}`);
    return '';
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    failures.push(`${label} unreadable: ${error?.message || error}`);
    return '';
  }
}

function requireProduction(text, failures, label, required = []) {
  if (!text) return;
  const production = /^status:[^\n]*\bPRODUCTION\b/im.test(text);
  const invalid = /^status:[^\n]*\b(?:FAIL|STUB)\b/im.test(text);
  if (!production || invalid) failures.push(`${label} is not PRODUCTION`);
  for (const token of required) {
    if (!text.includes(token)) failures.push(`${label} missing contract token ${token}`);
  }
}

export function checkNightlyRoute(root = defaultNightlyRoot()) {
  const repositoryRoot = path.resolve(root);
  const failures = [];
  const warnings = [];
  const skill = (...parts) => path.join(repositoryRoot, 'skills', ...parts, 'SKILL.md');
  const canonicalPath = skill('nightly');
  const aliasPath = skill(NIGHTLY_ROUTE_ALIAS);
  const metaPath = skill('meta-improve');
  const metaAliasPath = skill('meta-improve-vault');
  const dreamPath = skill('dream');
  const reconcilePath = skill('reconcile');
  const contextPath = skill('context-hygiene');
  const cognitivePath = skill('cognitive-update');
  const ledgerPath = skill('nightly-ledger-capture');
  const routerPath = path.join(repositoryRoot, 'daemons', 'skill-router.sh');

  const canonical = fileText(canonicalPath, failures, 'canonical nightly');
  const alias = fileText(aliasPath, failures, 'nightly invocation alias');
  const meta = fileText(metaPath, failures, 'meta-improve');
  const metaAlias = fileText(metaAliasPath, failures, 'meta-improve invocation alias');
  const dream = fileText(dreamPath, failures, 'dream');
  const reconcile = fileText(reconcilePath, failures, 'reconcile');
  const context = fileText(contextPath, failures, 'context-hygiene');
  const cognitive = fileText(cognitivePath, failures, 'cognitive-update');
  const ledger = fileText(ledgerPath, failures, 'nightly-ledger-capture');
  const router = fileText(routerPath, failures, 'skill-router');

  if (canonical && !canonical.includes(NIGHTLY_ROUTE_SENTINEL)) {
    failures.push('canonical nightly sentinel missing');
  }
  if (canonical && !/seven-leg[\s\S]{0,100}framework/i.test(canonical)) {
    failures.push('canonical nightly is not the seven-leg framework');
  }
  for (const checkpoint of NIGHTLY_CHECKPOINTS) {
    if (canonical && !canonical.includes(`\`${checkpoint}\``)) {
      failures.push(`canonical nightly missing checkpoint ${checkpoint}`);
    }
  }

  requireProduction(alias, failures, 'nightly invocation alias', ['../nightly/SKILL.md']);
  requireProduction(
    metaAlias,
    failures,
    'meta-improve invocation alias',
    ['../meta-improve/SKILL.md'],
  );
  requireProduction(meta, failures, 'meta-improve', [
    'memory/DREAM_LOG.md',
    'memory/runtime/LESSONS.jsonl',
    'memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl',
    'operator evidence',
    'nightly-contracts.mjs meta',
  ]);
  requireProduction(dream, failures, 'dream', [
    'memory/DREAM_LOG.md',
    'Lesson admission predicate',
    'status: proposed',
    'operator gate',
    'nightly-contracts.mjs dream',
  ]);
  requireProduction(reconcile, failures, 'reconcile', [
    'intended-share-input-absent',
    'as_of-6d .. as_of',
    'nightly-reconcile.mjs',
  ]);
  requireProduction(context, failures, 'context-hygiene', [
    'memory/SESSION_LOG.md',
    'nightly-context-hygiene.mjs',
  ]);
  requireProduction(cognitive, failures, 'cognitive-update', [
    'GOAL_STACK.json',
    'BELIEF_STATE.jsonl',
    'SELF_MODEL.json',
    'PROCEDURES.jsonl',
    'nightly-contracts.mjs cognitive',
  ]);
  requireProduction(ledger, failures, 'nightly-ledger-capture', [
    'NIGHTLY_CAPTURE_CANDIDATES.jsonl',
    'nightly-ledger-predicate.mjs',
    'nightly-ledger-stage.mjs',
    'nightly-decision-outcome.mjs',
    'FRIDAY_MEASUREMENT',
  ]);
  for (const token of [
    '"nightly": "nightly-close-parity"',
    '"meta-improve": "meta-improve-vault"',
    'os.path.join(root, "skills", alias, "SKILL.md")',
  ]) {
    if (router && !router.includes(token)) {
      failures.push(`skill-router missing fail-closed alias token ${token}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    alias: NIGHTLY_ROUTE_ALIAS,
    canonicalPath,
    aliasPath,
    proposedKills: [],
  };
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0
    ? path.resolve(process.argv[rootIndex + 1])
    : defaultNightlyRoot();
  const noAlert = process.argv.includes('--no-alert');
  const noDeliver = process.argv.includes('--no-deliver');
  const result = checkNightlyRoute(root);
  if (!result.ok && !noAlert) {
    await emitNightlyAlert({
      root,
      code: 'NIGHTLY:ROUTE_FAIL',
      summary: 'repository-local nightly route check failed',
      detail: result.failures.join('; '),
      evidence: 'skills/nightly-close-parity/SKILL.md -> ../nightly/SKILL.md',
      deliver: !noDeliver,
    });
  } else if (result.ok && !noAlert) {
    result.resolved = resolveNightlyAlerts({
      root,
      code: 'NIGHTLY:ROUTE_FAIL',
      reason: `repository-local route restored: /${result.alias}`,
    });
  }
  process.stdout.write(
    `NIGHTLY_ROUTE ${result.ok ? 'PASS' : 'FAIL'}`
    + ` alias=/${result.alias}`
    + ` canonical=${result.canonicalPath.replace(/\\/g, '/')}`
    + ` failures=${result.failures.length ? result.failures.join(' | ') : 'none'}`
    + ` warnings=${result.warnings.length ? result.warnings.join(' | ') : 'none'}`
    + ` resolved=${result.resolved || 0}\n`,
  );
  process.exit(result.ok ? 0 : 1);
}
