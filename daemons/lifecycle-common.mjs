// lifecycle-common.mjs — shared identity/vault resolution for the two-verb lifecycle.
//
// aigent-OS is single-operator by default: one vault, one BODY_STATE.json, one
// active-capsule pointer. `seatId` stays a first-class concept (not stripped) so a
// fork that dispatches persistent sub-agents — each with its own vault root — can
// still tag evidence/receipts per-identity; out of the box it resolves to the
// single 'operator' identity via AIGENT_SEAT_ID (or the default). Keep this file
// dependency-free and side-effect-free — everything downstream imports from here.

import { readFileSync, writeFileSync, existsSync, appendFileSync, writeSync } from 'node:fs';
import path from 'node:path';

// seatId resolution: env override first (multi-instance forks), else the fixed
// single-operator default. No path-based regex table — a single vault has nothing
// to disambiguate.
export function seatOf(root) {
  const override = process.env.AIGENT_SEAT_ID;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return 'operator';
}

// Memory root: aigent-OS's documented convention is <AIGENT_ROOT>/vault/memory
// (see daemons/memory-heat/compute-heat.js). 'memory' at the root is kept as a
// fallback for forks that skip the vault/ subdirectory.
export function memRoot(root) {
  for (const candidate of ['vault/memory', 'memory']) {
    const p = path.join(String(root), ...candidate.split('/'));
    if (existsSync(p)) return p;
  }
  return path.join(String(root), 'vault', 'memory');
}

// null = the read itself THREW (a real failure, log it); '' = genuinely empty.
// The lifecycle legs need the distinction — an unreadable stdin must not read the
// same as "no input".
export function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return null; }
}

export function logErr(root, tag, msg) {
  const line = `${new Date().toISOString()} [${tag}] ${msg}\n`;
  try {
    appendFileSync(path.join(memRoot(String(root || process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || ''))
      , '.daemon-errors.log'), line);
  } catch {
    // Last resort: stderr is visible to an operator tailing hook output and is NOT
    // injected into model context on exit 0 — better than truly silent. writeSync
    // is synchronous even on pipes.
    try { writeSync(2, line); } catch { /* truly nowhere to log */ }
  }
}

// flipCapsuleToResumed — the ONE shared implementation the SessionStart hook calls
// so a bug in the flip is fixed once, not per-caller.
//
// What this guards against: the capsule template pre-seeds a `resumed_at: null` /
// `resumed_by_session: null` PLACEHOLDER PAIR in the frontmatter. A naive flip that
// just replaces `status: active` -> `status: resumed\nresumed_at: <ts>\n...` never
// removes that pre-existing placeholder pair sitting a few lines later in the SAME
// frontmatter block — duplicate YAML keys, and a last-key-wins reader sees the NULL
// placeholder, silently erasing the flip's own work on next read. This function
// DEDUPES: any existing resumed_at/resumed_by_session line (placeholder or stale
// real value) is stripped before the fresh pair is inserted, so exactly one of each
// survives.
//
// Also closes two adjacent CRLF hazards:
//   - a naive `doc.split(/^---\s*$/m)` + `join('---')` round-trip on a CRLF file
//     consumes each delimiter line's own \r into the match (\s spans \r; the regex
//     backtracks to let the multiline $ land right before the \n) and re-inserts a
//     bare '---' with no terminator of its own — mixed line endings on write.
//   - a trailing greedy `\s*$` on an inserted VALUE line has the same failure mode.
// Fixed by detecting the file's dominant EOL once (before any mutation) and never
// reconstructing the delimiter lines at all: a single regex captures the OPENING
// delimiter LINE (bytes, terminator included), the frontmatter BODY, and the
// CLOSING delimiter LINE (bytes, terminator included) as three groups; only the
// body group is ever rewritten, and the delimiter bytes are spliced back verbatim.
//
// An already-'resumed' status is STEADY-STATE (a zero-turn restart observing its
// own earlier flip is not drift and not an error) — silently a no-op.
//
// TOCTOU-safe: the read is wrapped in try/catch; a read failure (including ENOENT)
// classifies as 'dangling' rather than throwing, so a pointer whose target file
// vanished between the caller's own existence check and this call is not an
// uncaught exception. NEVER throws and NEVER logs itself — callers decide what is
// user-visible for each outcome.
//
// Returns { outcome, detail }:
//   'flipped'      — status was active; now resumed, stamps written, dedupe applied.
//   'steady_state' — status was already 'resumed'; untouched, not an error.
//   'dangling'     — the capsule file could not be read (gone, permissions, etc).
//   'drift'        — frontmatter malformed (no closing delimiter) or status is
//                     neither active nor resumed when the caller expected active
//                     (leave a trail instead of a silent no-op).
//   'error'        — the write itself failed after a successful flip computation.
//
// Captures (1) the OPENING delimiter LINE with its own terminator, (2) the
// frontmatter BODY (lazy — stops at the first line that is bare '---'), (3) the
// CLOSING delimiter LINE with its own terminator (or no terminator, if the file
// ends exactly there). Only group 2 is ever rewritten; groups 1 and 3 are spliced
// back byte-for-byte, so there is no reconstruction step that could lose or alter
// a delimiter line's line ending.
const FRONTMATTER_RE = /^(---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m;

export function flipCapsuleToResumed(capsulePath, sessionId, { readFile = readFileSync, writeFile = writeFileSync } = {}) {
  let doc;
  try {
    doc = readFile(capsulePath, 'utf8');
  } catch (e) {
    return { outcome: 'dangling', detail: `capsule unreadable: ${e?.message || e}` };
  }
  // Detect the file's dominant line-ending style ONCE, before any mutation, so
  // every newly inserted line matches it — CRLF files never end up with bare-LF
  // lines mixed in.
  const eol = doc.includes('\r\n') ? '\r\n' : '\n';
  const match = doc.match(FRONTMATTER_RE);
  if (!match) {
    return { outcome: 'drift', detail: 'frontmatter has no closing delimiter (block not found)' };
  }
  const [whole, openDelim, block, closeDelim] = match;
  // [ \t]* NOT \s* at the trailing edge: \s spans \r AND \n, so a greedy \s*$ on a
  // CRLF line consumes the line's OWN \r into the match (backtracking to let $ land
  // right before the \n) — the replace below would then swap in text with no
  // trailing terminator of its own, orphaning that \n with no \r partner. A
  // trailing value can only legitimately carry spaces/tabs, never a line
  // terminator, so [ \t]* can never consume across the CRLF boundary.
  if (/^status:[ \t]*['"]?resumed['"]?[ \t]*$/m.test(block)) {
    return { outcome: 'steady_state', detail: 'capsule frontmatter already reads status: resumed' };
  }
  if (!/^status:[ \t]*['"]?active['"]?[ \t]*$/m.test(block)) {
    return { outcome: 'drift', detail: 'frontmatter status is neither active nor resumed (regex miss)' };
  }
  // Dedupe FIRST (strip any pre-existing resumed_at/resumed_by_session line —
  // placeholder null or stale real value), THEN insert the fresh pair. Order
  // matters: inserting first would just recreate the duplicate-key bug this
  // function exists to fix.
  const deduped = block
    .replace(/^resumed_at:.*(?:\r?\n|$)/gm, '')
    .replace(/^resumed_by_session:.*(?:\r?\n|$)/gm, '');
  const stamped = deduped.replace(
    /^status:[ \t]*['"]?active['"]?[ \t]*$/m,
    `status: resumed${eol}resumed_at: ${new Date().toISOString()}${eol}resumed_by_session: ${String(sessionId || '').slice(0, 8)}`,
  );
  // Splice the rewritten body back between the VERBATIM delimiter bytes — no
  // join('---') step exists to reconstruct (and potentially corrupt) the
  // delimiter lines.
  const newDoc = doc.slice(0, match.index) + openDelim + stamped + closeDelim + doc.slice(match.index + whole.length);
  try {
    writeFile(capsulePath, newDoc);
  } catch (e) {
    return { outcome: 'error', detail: `write failed: ${e?.message || e}` };
  }
  return { outcome: 'flipped', detail: 'status flipped active -> resumed, stamps written, any duplicate placeholder removed' };
}
