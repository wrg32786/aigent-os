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
//
// FAIL-CLOSED, and this is the part worth reading twice. Rows are staged as
// `unscanned` and ONLY a clean pass here promotes one to `staged`. The promotable
// set therefore means "a scan ran over this and found nothing", by construction,
// rather than "a scan may or may not have run". The alternative -- staging as
// `staged` and demoting on failure -- reads identically whether the scan came
// back clean or never executed at all, which makes the guard indistinguishable
// from its own absence exactly when it has stopped working.
//
// `unscanned` is a recoverable state, not a quarantine: this guard scans those
// rows too, so a run that failed because node was missing costs nothing once
// node is back. Only a real hit is sticky.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scanText, blockedMarker } from './memory-hygiene/injection-scan.mjs';
import { memRoot as resolveMemRoot } from './lifecycle-common.mjs';

const require = createRequire(import.meta.url);
const { atomicUpdate } = require('./memory-hygiene/atomic-state.cjs');

// | date | "phrase" | type | confidence | destination | status | digested | note |
const ROW = /^\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|[ \t]*$/;

// Both are "not yet judged". `unscanned` is where the capture path puts a new
// row; `staged` is also scanned so that rows written before this guard existed,
// or added by hand, still get read.
export const SCANNABLE = Object.freeze(['unscanned', 'staged']);
export const UNSCANNED_STATUS = 'unscanned';
export const CLEAN_STATUS = 'staged';

export function guardCandidatesText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocked = [];
  const promoted = [];
  let scanned = 0;

  const out = lines.map((line) => {
    const match = line.match(ROW);
    if (!match) return line;
    const cells = match.slice(1);
    const status = cells[5].trim();
    if (!SCANNABLE.includes(status)) return line;
    const phrase = cells[1].trim().replace(/^"|"$/g, '');
    if (!phrase) return line;
    scanned += 1;
    const hits = scanText(phrase);

    if (hits.length) {
      const marker = blockedMarker(hits);
      cells[5] = ' blocked ';
      const note = cells[7].trim();
      cells[7] = ` ${marker}${note ? ` ${note}` : ''} `;
      blocked.push({ phrase: phrase.slice(0, 80), ids: hits.map((hit) => hit.id) });
      return `|${cells.join('|')}|`;
    }

    // Clean. Promoting it here is the whole fail-closed property: `staged` is a
    // statement that this scan ran and found nothing, and only this line is
    // allowed to make it.
    if (status === UNSCANNED_STATUS) {
      cells[5] = ` ${CLEAN_STATUS} `;
      promoted.push(phrase.slice(0, 80));
      return `|${cells.join('|')}|`;
    }
    return line;
  });

  return { text: out.join('\n'), blocked, promoted, scanned };
}

export function guardCandidatesFile(file, options = {}) {
  // The atomic layer maps EVERY read error to "absent", which is the right call
  // for a pointer file that may legitimately not exist yet and the wrong one
  // here. A candidates file that exists but cannot be read is a scan that cannot
  // run; falling through would report CLEAN over zero rows, which is the precise
  // shape this guard exists to stop producing. A genuinely absent file is still
  // fine: there are no rows, so there is nothing a scan could have missed.
  if (existsSync(file)) readFileSync(file, 'utf8');

  let result = {
    blocked: [], promoted: [], scanned: 0, text: '',
  };
  const update = atomicUpdate(file, (current) => {
    if (current === null) return null;
    result = guardCandidatesText(current);
    return (result.blocked.length || result.promoted.length) ? result.text : null;
  }, options);
  return {
    blocked: result.blocked,
    promoted: result.promoted,
    scanned: result.scanned,
    changed: update.changed,
    file,
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
        + ` scanned=${result.scanned} promoted=${result.promoted.length} ids=${ids}\n`,
      );
      process.exit(strict ? 2 : 0);
    }
    process.stdout.write(
      `MEMORY_CANDIDATES_GUARD CLEAN blocked=0 scanned=${result.scanned}`
      + ` promoted=${result.promoted.length}\n`,
    );
    process.exit(0);
  } catch (error) {
    // A scan that could not run reports FAILED and exits nonzero, ALWAYS, strict
    // or not. The best-effort contract belongs to the caller: memory-capture.sh
    // is what must not abort a session over this, and it handles that by not
    // propagating our exit code. It cannot handle it if we hide the failure,
    // because then the only difference between a crashed scan and a clean one is
    // a stderr line nobody diffs.
    process.stderr.write(
      `MEMORY_CANDIDATES_GUARD FAILED file=${file}`
      + ` reason=${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(1);
  }
}
