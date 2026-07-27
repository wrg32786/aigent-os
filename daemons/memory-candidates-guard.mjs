#!/usr/bin/env node
// memory-candidates-guard.mjs -- injection gate on the staging queue that feeds
// durable memory.
//
// Runs at two moments, on purpose:
//   CAPTURE  -- called at the tail of memory-capture.sh, so a hostile line is
//               marked the moment it is staged. Nothing has to remember to run
//               this; it is on the path that does the staging.
//   PROMOTE  -- called again by the digest verb before anything is written into
//               the vault, because a row can also arrive by hand.
// The capture-time call is the one that matters. A gate that only runs when an
// agent chooses to run it is a suggestion, and the point of this mechanism is to
// not depend on being remembered.
//
// A hit never deletes and never edits the captured phrase. It flips the row's
// status to blocked and prefixes its note with a marker, which takes the row out
// of the promotable set and puts it in front of a person. Destroying evidence of
// an injection attempt would also destroy the only record that one happened.
//
// Idempotent: a row already marked blocked is left exactly as it is, so running
// this twice, or at both moments, changes nothing the second time.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scanText, blockedMarker } from './memory-hygiene/injection-scan.mjs';
import { memRoot as resolveMemRoot } from './lifecycle-common.mjs';

const require = createRequire(import.meta.url);
const { atomicUpdate } = require('./memory-hygiene/atomic-state.cjs');

// | date | "phrase" | type | confidence | destination | status | digested | note |
const ROW = /^\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|[ \t]*$/;

export function guardCandidatesText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocked = [];
  let scanned = 0;

  const out = lines.map((line) => {
    const match = line.match(ROW);
    if (!match) return line;
    const cells = match.slice(1);
    const status = cells[5].trim();
    if (status !== 'staged') return line;
    const phrase = cells[1].trim().replace(/^"|"$/g, '');
    if (!phrase) return line;
    scanned += 1;
    const hits = scanText(phrase);
    if (!hits.length) return line;

    const marker = blockedMarker(hits);
    cells[5] = ' blocked ';
    const note = cells[7].trim();
    cells[7] = ` ${marker}${note ? ` ${note}` : ''} `;
    blocked.push({ phrase: phrase.slice(0, 80), ids: hits.map((hit) => hit.id) });
    return `|${cells.join('|')}|`;
  });

  return { text: out.join('\n'), blocked, scanned };
}

export function guardCandidatesFile(file, options = {}) {
  let result = { blocked: [], scanned: 0, text: '' };
  const update = atomicUpdate(file, (current) => {
    if (current === null) return null;
    result = guardCandidatesText(current);
    return result.blocked.length ? result.text : null;
  }, options);
  return {
    blocked: result.blocked, scanned: result.scanned, changed: update.changed, file,
  };
}

export function candidatesPath(root) {
  return path.join(resolveMemRoot(root), 'MEMORY_CANDIDATES.md');
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (direct) {
  const strict = process.argv.includes('--strict');
  const fileIndex = process.argv.indexOf('--file');
  const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = fileIndex >= 0 ? path.resolve(process.argv[fileIndex + 1]) : candidatesPath(root);
  try {
    const result = guardCandidatesFile(file);
    const ids = [...new Set(result.blocked.flatMap((entry) => entry.ids))].join(',');
    if (result.blocked.length) {
      process.stdout.write(
        `MEMORY_CANDIDATES_GUARD BLOCKED blocked=${result.blocked.length}`
        + ` scanned=${result.scanned} ids=${ids}\n`,
      );
      process.exit(strict ? 2 : 0);
    }
    process.stdout.write(`MEMORY_CANDIDATES_GUARD CLEAN blocked=0 scanned=${result.scanned}\n`);
    process.exit(0);
  } catch (error) {
    // Best effort by design: this runs on the capture path, and a staging queue
    // that cannot be scanned must not stop the session from staging.
    process.stderr.write(
      `MEMORY_CANDIDATES_GUARD ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(strict ? 1 : 0);
  }
}
