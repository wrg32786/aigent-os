#!/usr/bin/env node
// Compare-and-swap protected writer for an operator-authored decision outcome.
// Ambiguous evidence is refused and remains a staged nightly candidate.

import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskMarkdownFences, validDateKey,
} from './nightly-freshness.mjs';
import {
  defaultNightlyRoot, resolveNightlyPaths,
} from './nightly-paths.mjs';

const DAY_MS = 86_400_000;
const OUTCOMES = new Set(['HELD', 'DRIFTED', 'REVERSED', 'STILL UNCLEAR']);
const INTERVALS = new Set([30, 60, 90]);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decisionEntries(text) {
  const source = String(text);
  const searchable = maskMarkdownFences(source);
  const headers = [
    ...searchable.matchAll(
      /^###[ \t]+(\d{4}-\d{2}-\d{2})(?:[ \t]+\([^)]*\))?[ \t]+[—-][ \t]+(.+)$/gm,
    ),
  ];
  return headers.map((header, index) => ({
    date: header[1],
    title: clean(header[2]),
    body: source.slice(header.index, headers[index + 1]?.index ?? source.length),
  }));
}

function outcomeBlocks(text) {
  const source = String(text);
  const searchable = maskMarkdownFences(source);
  const headers = [
    ...searchable.matchAll(
      /^##(?!#)[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+[—-][ \t]+(.+?)(?:[ \t]+\([^)]+\))?[ \t]*$/gm,
    ),
  ];
  return headers.map((header, index) => ({
    date: header[1],
    title: clean(header[2].replace(/[ \t]+\(logged in DECISION_LOG\)$/i, '')),
    start: header.index,
    end: headers[index + 1]?.index ?? source.length,
    body: source.slice(header.index, headers[index + 1]?.index ?? source.length),
  }));
}

function matchingChecks(text, interval, operatorSource) {
  const escapedSource = operatorSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^\\*\\*${interval}-day check[ \\t]*\\(\\d{4}-\\d{2}-\\d{2}\\):\\*\\*`
      + `[ \\t]*(HELD|DRIFTED|REVERSED|STILL UNCLEAR)\\b[\\s\\S]*?`
      + `^Operator source:[ \\t]*${escapedSource}[ \\t]*$`,
    'gmi',
  );
  return [...String(text).matchAll(pattern)];
}

export function appendDecisionOutcome({
  root = defaultNightlyRoot(),
  asOf,
  decisionDate,
  decisionTitle,
  interval,
  outcome,
  operatorText,
  operatorSource,
  expectedFileSha,
} = {}) {
  if (!root) throw new Error('root is required');
  if (!validDateKey(asOf) || !validDateKey(decisionDate)) {
    throw new Error('valid as-of and decision dates are required');
  }
  const normalizedInterval = Number(interval);
  if (!INTERVALS.has(normalizedInterval)) {
    throw new Error(`interval must be 30, 60, or 90: ${interval}`);
  }
  const normalizedOutcome = clean(outcome).toUpperCase();
  if (!OUTCOMES.has(normalizedOutcome)) {
    throw new Error(`invalid operator outcome: ${outcome}`);
  }
  if (clean(operatorText).toUpperCase() !== normalizedOutcome) {
    throw new Error('operator text must be the exact outcome enum, not a generated summary');
  }
  const source = clean(operatorSource);
  if (source.length < 8
      || !/(?:operator|user|turn|message|transcript|conversation|source|#[a-z0-9_-]+)/i
        .test(source)) {
    throw new Error('durable direct operator source ref is required');
  }
  if (!/^[0-9a-f]{64}$/i.test(String(expectedFileSha || ''))) {
    throw new Error('expected DECISION_OUTCOMES SHA-256 is required');
  }
  const age = Math.round(
    (
      Date.parse(`${asOf}T00:00:00Z`)
      - Date.parse(`${decisionDate}T00:00:00Z`)
    ) / DAY_MS,
  );
  if (Math.abs(age - normalizedInterval) > 3) {
    throw new Error(
      `decision is not due at ${normalizedInterval} days: observed_age=${age}`,
    );
  }

  const paths = resolveNightlyPaths(root);
  const logFile = path.join(paths.memoryRoot, 'DECISION_LOG.md');
  const outcomeFile = path.join(paths.memoryRoot, 'DECISION_OUTCOMES.md');
  if (!existsSync(logFile) || !existsSync(outcomeFile)) {
    throw new Error('decision ledger files are required');
  }
  const decisionLog = readFileSync(logFile, 'utf8');
  const wantedTitle = clean(decisionTitle);
  const matches = decisionEntries(decisionLog).filter((entry) => (
    entry.date === decisionDate
    && (!wantedTitle || entry.title.toLowerCase() === wantedTitle.toLowerCase())
  ));
  if (matches.length !== 1) {
    throw new Error(
      `decision match is ambiguous: matches=${matches.length}`
      + ` date=${decisionDate} title=${wantedTitle || 'none'}`,
    );
  }
  const decision = matches[0];
  const before = readFileSync(outcomeFile, 'utf8');
  const blocks = outcomeBlocks(before).filter((block) => (
    block.date === decisionDate
    && block.title.toLowerCase() === decision.title.toLowerCase()
  ));
  if (blocks.length > 1) {
    throw new Error(`outcome entry is ambiguous: matches=${blocks.length}`);
  }
  const existingBlock = blocks[0];
  const existingCheck = existingBlock?.body.match(
    new RegExp(
      `^\\*\\*${normalizedInterval}-day check[ \\t]*\\([^)]+\\):\\*\\*`
        + '[ \\t]*(HELD|DRIFTED|REVERSED|STILL UNCLEAR)\\b',
      'mi',
    ),
  );
  if (existingCheck) {
    if (existingCheck[1].toUpperCase() !== normalizedOutcome
        || !existingBlock.body.includes(`Operator source: ${source}`)) {
      throw new Error(
        `${normalizedInterval}-day outcome already exists with different evidence`,
      );
    }
    return {
      ok: true,
      appended: false,
      duplicate: true,
      output: `DECISION_OUTCOME SKIP duplicate=yes`
        + ` decision=${decisionDate} interval=${normalizedInterval}`
        + ` outcome=${normalizedOutcome}`,
    };
  }
  if (sha256(before) !== String(expectedFileSha).toLowerCase()) {
    throw new Error('DECISION_OUTCOMES compare-and-swap hash changed');
  }
  const entry = [
    `**${normalizedInterval}-day check (${asOf}):** ${normalizedOutcome}`,
    `Operator source: ${source}`,
  ].join('\n');
  let after;
  if (existingBlock) {
    const body = before.slice(existingBlock.start, existingBlock.end).trimEnd();
    after = `${before.slice(0, existingBlock.start)}${body}\n\n${entry}\n`
      + before.slice(existingBlock.end);
  } else {
    after = `${before.trimEnd()}\n\n## ${decisionDate} — ${decision.title}`
      + ` (logged in DECISION_LOG)\n\n${entry}\n`;
  }
  if (sha256(readFileSync(outcomeFile, 'utf8'))
      !== String(expectedFileSha).toLowerCase()) {
    throw new Error('DECISION_OUTCOMES compare-and-swap hash changed immediately before write');
  }
  const temp = `${outcomeFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, after, 'utf8');
  renameSync(temp, outcomeFile);
  const verified = readFileSync(outcomeFile, 'utf8');
  const verifiedBlock = outcomeBlocks(verified).find((block) => (
    block.date === decisionDate
    && block.title.toLowerCase() === decision.title.toLowerCase()
  ));
  if (!verifiedBlock
      || matchingChecks(verifiedBlock.body, normalizedInterval, source).length !== 1) {
    throw new Error('post-write outcome verification did not find exactly one new check');
  }
  return {
    ok: true,
    appended: true,
    duplicate: false,
    output: `DECISION_OUTCOME PASS appended=1`
      + ` decision=${decisionDate} interval=${normalizedInterval}`
      + ` outcome=${normalizedOutcome} source=${source}`,
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
    const result = appendDecisionOutcome({
      root: path.resolve(String(cli.root || defaultNightlyRoot())),
      asOf: String(cli['as-of'] || ''),
      decisionDate: String(cli['decision-date'] || ''),
      decisionTitle: String(cli['decision-title'] || ''),
      interval: Number(cli.interval),
      outcome: String(cli.outcome || ''),
      operatorText: String(cli['operator-text'] || ''),
      operatorSource: String(cli['operator-source'] || ''),
      expectedFileSha: String(cli['expected-file-sha'] || ''),
    });
    process.stdout.write(result.output + '\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `DECISION_OUTCOME FAIL ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(1);
  }
}
