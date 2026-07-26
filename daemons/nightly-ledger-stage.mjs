#!/usr/bin/env node
// Sole append-only writer for nightly ledger and decision candidates.

import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validDateKey } from './nightly-freshness.mjs';
import {
  LEDGER_PREDICATE_TYPES, receiptHash, runLedgerPredicate,
} from './nightly-ledger-predicate.mjs';
import {
  defaultNightlyRoot, resolveNightlyPaths,
} from './nightly-paths.mjs';

const LEDGERS = Object.freeze([
  'honesty',
  'trust_decay',
  'failure_modes',
  'decision_outcomes',
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
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function candidatePath(root) {
  return path.join(
    resolveNightlyPaths(root).runtimeRoot,
    'NIGHTLY_CAPTURE_CANDIDATES.jsonl',
  );
}

function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`candidate JSONL line ${index + 1} invalid: ${error?.message || error}`);
    }
  });
}

function validateProposal(proposal) {
  if (proposal === null || proposal === undefined) return null;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('predicate_proposal must be an object or null');
  }
  if (!LEDGER_PREDICATE_TYPES.includes(proposal.type)) {
    throw new Error(`predicate type not allowlisted: ${proposal.type}`);
  }
  if (!proposal.args || typeof proposal.args !== 'object' || Array.isArray(proposal.args)) {
    throw new Error('predicate args must be a data object');
  }
  if (!Object.hasOwn(proposal, 'expected')) {
    throw new Error('predicate expected value is required');
  }
  return stable({
    type: proposal.type,
    args: proposal.args,
    expected: proposal.expected,
  });
}

function validateReceipt(receipt, proposal, root, now) {
  if (receipt === null || receipt === undefined) return null;
  if (!proposal) throw new Error('predicate_receipt requires predicate_proposal');
  if (receipt.type !== proposal.type
      || JSON.stringify(stable(receipt.args)) !== JSON.stringify(stable(proposal.args))
      || JSON.stringify(stable(receipt.expected))
        !== JSON.stringify(stable(proposal.expected))) {
    throw new Error('predicate receipt does not match proposal');
  }
  if (receipt.exit_code !== 0) {
    throw new Error('only a green predicate receipt may support mechanical evidence');
  }
  if (receipt.receipt_hash !== receiptHash(receipt)) {
    throw new Error('predicate receipt hash invalid');
  }
  const rerun = runLedgerPredicate({
    root,
    type: proposal.type,
    args: proposal.args,
    expected: proposal.expected,
    now,
  });
  if (rerun.exit_code !== 0) {
    throw new Error(
      `predicate receipt does not reproduce against current artifact:`
      + ` ${rerun.error || JSON.stringify(rerun.observed)}`,
    );
  }
  return stable(rerun);
}

export function stageLedgerCandidate({
  root = defaultNightlyRoot(),
  date,
  candidate,
  now = new Date(),
} = {}) {
  if (!root || !validDateKey(date)) {
    throw new Error('root and valid YYYY-MM-DD date are required');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('candidate object is required');
  }
  if (!LEDGERS.includes(candidate.ledger)) {
    throw new Error(`invalid candidate ledger: ${candidate.ledger}`);
  }
  const claim = String(candidate.claim || '').replace(/[\r\n]+/g, ' ').trim();
  if (!claim) throw new Error('candidate claim is required');
  if (!Array.isArray(candidate.source_refs)
      || candidate.source_refs.length === 0
      || candidate.source_refs.some((ref) => !String(ref).trim())) {
    throw new Error('candidate needs at least one exact source ref');
  }
  if (!['judgment', 'mechanical'].includes(candidate.evidence_class)) {
    throw new Error('evidence_class must be judgment or mechanical');
  }
  if (candidate.status && candidate.status !== 'staged') {
    throw new Error('nightly candidates can only start staged');
  }
  const proposal = validateProposal(candidate.predicate_proposal);
  const receipt = validateReceipt(candidate.predicate_receipt, proposal, root, now);
  if (candidate.evidence_class === 'mechanical' && !receipt) {
    throw new Error('mechanical evidence requires a green predicate receipt');
  }

  const normalizedSources = [
    ...new Set(candidate.source_refs.map((ref) => String(ref).trim())),
  ].sort();
  const dedupeKey = hash({
    ledger: candidate.ledger,
    normalized_claim: claim.toLowerCase().replace(/\s+/g, ' '),
    source_refs: normalizedSources,
  });
  const file = candidatePath(root);
  const rows = readRows(file);
  const existing = rows.find((row) => row.dedupe_key === dedupeKey);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      appended: false,
      candidate: existing,
      file,
      output: `LEDGER_STAGE SKIP duplicate=${existing.candidate_id}`
        + ` file=memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl`,
    };
  }

  const prefix = `nc-${String(date).replace(/-/g, '')}-`;
  const max = rows.reduce((highest, row) => {
    const match = String(row.candidate_id || '').match(new RegExp(`^${prefix}(\\d+)$`));
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const row = {
    schema_version: 1,
    candidate_id: `${prefix}${String(max + 1).padStart(2, '0')}`,
    ledger: candidate.ledger,
    claim,
    source_refs: normalizedSources,
    evidence_class: candidate.evidence_class,
    predicate_proposal: proposal,
    predicate_receipt: receipt,
    status: 'staged',
    created_at: instant.toISOString(),
    dedupe_key: dedupeKey,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  readRows(file);
  return {
    ok: true,
    duplicate: false,
    appended: true,
    candidate: row,
    file,
    output: `LEDGER_STAGE PASS id=${row.candidate_id}`
      + ` ledger=${row.ledger} status=staged`
      + ` file=memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl`,
  };
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
    const candidateText = cli['candidate-json']
      ? String(cli['candidate-json'])
      : readFileSync(0, 'utf8');
    const result = stageLedgerCandidate({
      root: path.resolve(String(cli.root || defaultNightlyRoot())),
      date: String(cli.date || ''),
      candidate: JSON.parse(candidateText),
      now: cli.now ? new Date(String(cli.now)) : new Date(),
    });
    process.stdout.write(result.output + '\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `LEDGER_STAGE FAIL ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(1);
  }
}
