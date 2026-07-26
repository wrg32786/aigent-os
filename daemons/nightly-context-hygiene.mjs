#!/usr/bin/env node
// Read-only postcondition checker for the context-hygiene leg. The skill owns
// judged archive edits; this checker validates the resulting live documents.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskMarkdownFences, validDateKey,
} from './nightly-freshness.mjs';
import {
  defaultNightlyRoot, resolveNightlyPaths,
} from './nightly-paths.mjs';

const SESSION_RETENTION_LIMIT = 5;
const SESSION_FIELDS = Object.freeze([
  'Objective',
  'Completed',
  'Decisions',
  'Open threads',
  'Next action',
]);

function lineNumberAt(text, index) {
  return String(text).slice(0, index).split(/\r?\n/).length;
}

function sessionFieldBodies(block) {
  const markers = [];
  for (const label of SESSION_FIELDS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of block.matchAll(
      new RegExp(`^\\*\\*${escaped}:\\*\\*[ \\t]*(.*)$`, 'gmi'),
    )) {
      markers.push({
        label,
        index: match.index,
        end: match.index + match[0].length,
        inline: match[1].trim(),
      });
    }
  }
  markers.sort((left, right) => left.index - right.index);
  const bodies = new Map();
  const duplicates = [];
  for (const [position, marker] of markers.entries()) {
    if (bodies.has(marker.label)) {
      duplicates.push(marker.label);
      continue;
    }
    const continuation = block
      .slice(marker.end, markers[position + 1]?.index ?? block.length)
      .replace(/^##[ \t]+[\s\S]*$/m, '')
      .trim();
    bodies.set(
      marker.label,
      [marker.inline, continuation].filter(Boolean).join('\n').trim(),
    );
  }
  return { bodies, duplicates };
}

export function inspectSessionLog(text, {
  retentionLimit = SESSION_RETENTION_LIMIT,
} = {}) {
  const source = String(text ?? '');
  const searchable = maskMarkdownFences(source);
  const validHeaders = [
    ...searchable.matchAll(
      /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+[—-][ \t]+(.+?)[ \t]*$/gm,
    ),
  ].filter((header) => validDateKey(header[1]));
  const malformedDateHeaders = [
    ...searchable.matchAll(/^##[ \t]+(\d{4}-\d{2}-\d{2})\b.*$/gm),
  ].filter((header) => !validDateKey(header[1]));

  const entries = validHeaders.map((header, index) => {
    const block = source.slice(
      header.index,
      validHeaders[index + 1]?.index ?? source.length,
    );
    const fields = sessionFieldBodies(block);
    const missingFields = SESSION_FIELDS.filter(
      (label) => !fields.bodies.has(label) || !fields.bodies.get(label),
    );
    return {
      date: header[1],
      title: header[2].trim(),
      line: lineNumberAt(source, header.index),
      missingFields,
      duplicateFields: fields.duplicates,
      ok: Boolean(header[2].trim())
        && missingFields.length === 0
        && fields.duplicates.length === 0,
    };
  });
  const newestFirst = entries.every(
    (entry, index) => index === 0 || entry.date <= entries[index - 1].date,
  );
  const invalidEntries = entries.filter((entry) => !entry.ok);
  const unfamiliarLines = [
    ...malformedDateHeaders.map((header) => lineNumberAt(source, header.index)),
    ...invalidEntries.map((entry) => entry.line),
  ];
  const total = entries.length;
  const unfamiliar = unfamiliarLines.length;
  const ok = total >= 1
    && total <= retentionLimit
    && unfamiliar === 0
    && newestFirst;
  return {
    ok,
    canonical: total,
    legacy: 0,
    unfamiliar,
    unfamiliarLines,
    newestFirst,
    total,
    retentionLimit,
    entries,
    detail: ok
      ? `${total} detailed session block(s), newest first (limit ${retentionLimit})`
      : `${total} detailed session block(s); limit=${retentionLimit};`
        + ` malformed=${unfamiliar}; newest_first=${newestFirst ? 'yes' : 'no'}`,
  };
}

function livePriorityRows(text) {
  const source = maskMarkdownFences(String(text ?? ''));
  const headings = [...source.matchAll(/^##[ \t]+Tier[ \t]+[1-3]\b.*$/gmi)];
  const rows = [];
  for (const [index, heading] of headings.entries()) {
    const nextH2 = source.slice(heading.index + heading[0].length)
      .match(/^##[ \t]+/m);
    const end = nextH2
      ? heading.index + heading[0].length + nextH2.index
      : source.length;
    const block = source.slice(heading.index, end);
    for (const match of block.matchAll(
      /^[ \t]*[-*][ \t]+(?:\[[ xX]\][ \t]+)?(.+\S)[ \t]*$/gm,
    )) {
      rows.push(match[1].trim());
    }
  }
  return rows;
}

export function inspectActivePriorities(text) {
  const source = maskMarkdownFences(String(text ?? ''));
  const modes = [
    ...source.matchAll(/^##[ \t]+Operating Mode:[ \t]*(\S.+?)[ \t]*$/gmi),
  ];
  const priorities = livePriorityRows(source);
  const placeholderRows = priorities.filter(
    (row) => /^\[(?:your|optional|list|describe|add)\b/i.test(row)
      || /\[(?:your|optional)[^\]]*\]/i.test(row),
  );
  const reviewedValue = source.match(
    /^(?:\*\*)?Last reviewed(?::\*\*|\*\*:|:)[ \t]*(\d{4}-\d{2}-\d{2})\b/im,
  )?.[1] || null;
  const lastReviewed = validDateKey(reviewedValue);
  const embeddedArchive = /^##[ \t]+Archived\b/im.test(source);
  const ok = modes.length === 1
    && priorities.length >= 1
    && priorities.length <= 5
    && placeholderRows.length === 0
    && lastReviewed
    && !embeddedArchive;
  return {
    ok,
    operatingModes: modes.length,
    operatingMode: modes[0]?.[1]?.trim() || null,
    liveFronts: modes.length,
    livePriorities: priorities.length,
    priorities,
    placeholderRows: placeholderRows.length,
    lastReviewed,
    reviewedDate: reviewedValue,
    embeddedArchive,
    archiveLink: false,
    detail: ok
      ? `one operating mode; priorities=${priorities.length}; review stamp present`
      : `operating_modes=${modes.length}; priorities=${priorities.length};`
        + ` placeholders=${placeholderRows.length};`
        + ` last_reviewed=${lastReviewed ? 'yes' : 'no'};`
        + ` embedded_archive=${embeddedArchive ? 'yes' : 'no'}`,
  };
}

export function checkContextHygiene({
  root = defaultNightlyRoot(),
  sessionLog,
  activePriorities,
  retentionLimit = SESSION_RETENTION_LIMIT,
} = {}) {
  const paths = resolveNightlyPaths(root);
  const sessionFile = sessionLog || path.join(paths.memoryRoot, 'SESSION_LOG.md');
  const prioritiesFile = activePriorities
    || path.join(paths.memoryRoot, 'ACTIVE_PRIORITIES.md');
  const session = inspectSessionLog(
    readFileSync(sessionFile, 'utf8'),
    { retentionLimit },
  );
  const priorities = inspectActivePriorities(readFileSync(prioritiesFile, 'utf8'));
  return {
    ok: session.ok && priorities.ok,
    session,
    priorities,
    sessionLog: sessionFile,
    activePriorities: prioritiesFile,
  };
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0
    ? path.resolve(process.argv[rootIndex + 1])
    : defaultNightlyRoot();
  try {
    const result = checkContextHygiene({ root });
    process.stdout.write(
      `CONTEXT_HYGIENE ${result.ok ? 'PASS' : 'FAIL'}`
      + ` session_entries=${result.session.total}`
      + ` retention_limit=${result.session.retentionLimit}`
      + ` block_errors=${result.session.unfamiliar}`
      + ` newest_first=${result.session.newestFirst ? 'yes' : 'no'}`
      + ` operating_modes=${result.priorities.operatingModes}`
      + ` live_priorities=${result.priorities.livePriorities}`
      + ` placeholders=${result.priorities.placeholderRows}`
      + ` last_reviewed=${result.priorities.lastReviewed ? 'yes' : 'no'}`
      + ` embedded_archive=${result.priorities.embeddedArchive ? 'yes' : 'no'}\n`,
    );
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(
      `CONTEXT_HYGIENE FAIL unreadable_input=`
      + `${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(1);
  }
}
