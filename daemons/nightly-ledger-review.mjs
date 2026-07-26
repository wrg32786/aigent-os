#!/usr/bin/env node
// Read-only mechanical counts for nightly ledger review. Judgment-bearing
// resolutions remain staged for the operator.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskMarkdownFences, validDateKey, zonedParts,
} from './nightly-freshness.mjs';
import { LEDGER_PREDICATE_TYPES } from './nightly-ledger-predicate.mjs';
import {
  defaultNightlyRoot, resolveNightlyConfig, resolveNightlyPaths,
} from './nightly-paths.mjs';

const DAY_MS = 86_400_000;

function read(paths, relative, { required = false } = {}) {
  const file = path.join(paths.memoryRoot, ...relative.split('/'));
  if (!existsSync(file)) {
    if (required) throw new Error(`required ledger missing: memory/${relative}`);
    return '';
  }
  return readFileSync(file, 'utf8');
}

function datedBlocks(text, pattern) {
  const source = maskMarkdownFences(String(text));
  const headers = [...source.matchAll(pattern)];
  return headers.map((header, index) => ({
    date: header[1],
    body: source.slice(header.index, headers[index + 1]?.index ?? source.length),
  }));
}

function inWindow(date, today, days = 6) {
  if (!validDateKey(date) || !validDateKey(today)) return false;
  const end = Date.parse(`${today}T00:00:00Z`);
  const start = end - days * DAY_MS;
  const value = Date.parse(`${date}T00:00:00Z`);
  return value >= start && value <= end;
}

function honestyEntries(text) {
  return datedBlocks(
    text,
    /^(?:#{2,3}[ \t]+|\*\*)(\d{4}-\d{2}-\d{2})\b.*$/gm,
  ).map((block) => ({
    ...block,
    open: /\bResolution(?:\s*:\s*|\s+)OPEN\b/i.test(block.body.replace(/\*/g, '')),
  }));
}

function trustCaptures(text) {
  const lines = maskMarkdownFences(String(text)).split(/\r?\n/);
  const captures = [];
  let inOpen = false;
  let date = null;
  for (const line of lines) {
    const h2 = line.match(/^##(?!#)[ \t]+(.+)$/);
    if (h2) {
      inOpen = /^Open\b/i.test(h2[1]) || /^Open captures\b/i.test(h2[1]);
      date = h2[1].match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || null;
      continue;
    }
    const h3 = line.match(/^###[ \t]+(.+)$/);
    if (h3) {
      date = h3[1].match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || date;
      continue;
    }
    if (inOpen
        && /^-[ \t]+\*\*CLAIM(?::|\*\*:)/i.test(line)
        && !/\bRESOLVED\b/i.test(line)
        && validDateKey(date)) {
      captures.push({ date, body: line, open: true });
    }
  }
  return captures;
}

function failureEntries(text) {
  return datedBlocks(
    text,
    /^#{2,3}[ \t]+(\d{4}-\d{2}-\d{2})\b.*$/gm,
  );
}

function decisionOutcomeEvents(text) {
  const lines = maskMarkdownFences(String(text)).split(/\r?\n/);
  const events = [];
  let sectionDate = null;
  for (const line of lines) {
    const heading = line.match(/^##[ \t]+(.+)$/);
    if (heading) {
      sectionDate = heading[1].match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || null;
    }
    const check = line.match(
      /^\*\*(?:30|60|90)-day check[ \t]*\((\d{4}-\d{2}-\d{2})\):\*\*[ \t]*(HELD|DRIFTED|REVERSED|STILL UNCLEAR)\b/i,
    );
    if (check) {
      events.push({ date: check[1], outcome: check[2].toUpperCase(), body: line });
      continue;
    }
    const cleared = line.match(
      /^-[ \t]+\*\*.+?\*\*:[ \t]*(HELD|DRIFTED|REVERSED|STILL UNCLEAR)\b/i,
    );
    if (cleared && validDateKey(sectionDate)) {
      events.push({ date: sectionDate, outcome: cleared[1].toUpperCase(), body: line });
    }
  }
  return events;
}

function countOpenOlderThan(entries, today, days) {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - days * DAY_MS;
  return entries.filter((entry) => (
    entry.open
    && validDateKey(entry.date)
    && Date.parse(`${entry.date}T00:00:00Z`) < cutoff
  )).length;
}

function repeatedFailureClasses(text) {
  const counts = new Map();
  const source = maskMarkdownFences(String(text));
  const patterns = [
    /^(?:-[ \t]+)?(?:\*\*)?Pattern(?:[ \t]+\([^)]*\)|[ \t]+category)?(?::\*\*|\*\*:|:)[ \t]*(.+)$/gmi,
    /\bClass[ \t]*=[ \t]*(?:\*\*)?(.+?)(?:\*\*)?[ \t]*$/gmi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const normalized = match[1]
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized) counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  for (const match of source.matchAll(
    /^#{2,3}[ \t]+\d{4}-\d{2}-\d{2}.*?[—-][ \t]+(.+?(?:recurr(?:ing|ed)?|repeat).*)$/gmi,
  )) {
    const multiplier = match[1].match(/\b([2-9]\d*)[x×]/i)?.[1]
      || match[1].match(/\b(?:recurred|repeated)[ \t]+([2-9]\d*)\b/i)?.[1];
    if (!multiplier) continue;
    const normalized = match[1]
      .replace(/\([^)]*(?:recurr|repeat)[^)]*\)/gi, '')
      .replace(/\b(?:recurred|repeated)[ \t]+\d+[x×]?\b.*$/i, '')
      .toLowerCase()
      .replace(/[`*_]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized) {
      counts.set(normalized, Math.max(counts.get(normalized) || 0, Number(multiplier)));
    }
  }
  return [...counts.entries()].filter(([, count]) => count >= 2);
}

function stagedRows(paths) {
  const relative = 'runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl';
  const text = read(paths, relative);
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`memory/${relative} line ${index + 1}: ${error?.message || error}`);
    }
  });
}

function executableResolutionCandidate(row) {
  const proposal = row?.predicate_proposal;
  return row?.status === 'staged'
    && proposal
    && typeof proposal === 'object'
    && LEDGER_PREDICATE_TYPES.includes(proposal.type)
    && proposal.args
    && typeof proposal.args === 'object'
    && !Array.isArray(proposal.args)
    && Object.hasOwn(proposal, 'expected');
}

export function reviewNightlyLedgers({
  root = defaultNightlyRoot(),
  now = new Date(),
  timeZone,
} = {}) {
  if (!root) throw new Error('root is required');
  const config = resolveNightlyConfig({ timeZone });
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const local = zonedParts(instant, config.timeZone);
  const paths = resolveNightlyPaths(root);
  const honesty = read(paths, 'HONESTY_LEDGER.md', { required: true });
  const trust = read(paths, 'TRUST_DECAY.md', { required: true });
  const failures = read(paths, 'FAILURE_MODES.md', { required: true });
  const outcomes = read(paths, 'DECISION_OUTCOMES.md', { required: true });
  const candidates = stagedRows(paths);
  const honestyRows = honestyEntries(honesty);
  const trustRows = trustCaptures(trust);
  const failureRows = failureEntries(failures);
  const outcomeRows = decisionOutcomeEvents(outcomes);
  const repeated = repeatedFailureClasses(failures);
  const result = {
    ok: true,
    date: local.date,
    timeZone: config.timeZone,
    friday: local.weekday === 'Fri',
    honesty_entries: honestyRows.filter((entry) => inWindow(entry.date, local.date)).length,
    trust_decay_entries: trustRows.filter((entry) => inWindow(entry.date, local.date)).length,
    failure_mode_entries: failureRows.filter((entry) => inWindow(entry.date, local.date)).length,
    decision_outcomes: outcomeRows.filter((entry) => inWindow(entry.date, local.date)).length,
    open_gt_7d: countOpenOlderThan(honestyRows, local.date, 7)
      + countOpenOlderThan(trustRows, local.date, 7),
    repeated_classes: repeated.length,
    staged_candidates: candidates.filter((row) => row.status === 'staged').length,
    resolution_candidates: candidates.filter(executableResolutionCandidate).length,
  };
  const fields = [
    'LEDGER_REVIEW PASS',
    `date=${result.date}`,
    `time_zone=${result.timeZone}`,
    `open_gt_7d=${result.open_gt_7d}`,
    `repeated_classes=${result.repeated_classes}`,
    `staged_candidates=${result.staged_candidates}`,
    `resolution_candidates=${result.resolution_candidates}`,
  ];
  if (result.friday) {
    fields.push(
      `FRIDAY_MEASUREMENT honesty=${result.honesty_entries}`
      + ` trust_decay=${result.trust_decay_entries}`
      + ` failure_modes=${result.failure_mode_entries}`
      + ` decision_outcomes=${result.decision_outcomes}`,
    );
  }
  result.output = fields.join(' ');
  return result;
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  const rootIndex = process.argv.indexOf('--root');
  const nowIndex = process.argv.indexOf('--now');
  const zoneIndex = process.argv.indexOf('--time-zone');
  try {
    const result = reviewNightlyLedgers({
      root: path.resolve(
        rootIndex >= 0 ? process.argv[rootIndex + 1] : defaultNightlyRoot(),
      ),
      now: nowIndex >= 0 ? new Date(process.argv[nowIndex + 1]) : new Date(),
      timeZone: zoneIndex >= 0 ? process.argv[zoneIndex + 1] : undefined,
    });
    process.stdout.write(result.output + '\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `LEDGER_REVIEW FAIL ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(1);
  }
}
