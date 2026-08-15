// lifecycle-common.mjs — shared identity and vault resolution for the two-verb lifecycle.
//
// aigent-OS is single-operator by default: one vault and one BODY_STATE.json.
// An optional identity override remains available for compatible multi-instance
// installations. Keep this file dependency-free and side-effect-free because
// lifecycle hooks import it directly.
//
// Resume selection has one authority: newestValidCapsule(), ordered by the
// frontmatter created_at value. No secondary pointer or cross-session close
// bookkeeping competes with that selection.

import { readFileSync, existsSync, appendFileSync, writeSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import frontmatterReader from './frontmatter-reader.cjs';
// NAMESPACE import, not a named one, and the call site below is guarded. The
// content gate is OPTIONAL infrastructure: the stop-writer lazy-imports it inside
// try/catch so a broken gate never takes down a turn, and the suites substitute a
// stub or throwing gate to prove that. A static NAMED import is a hard dependency
// — it fails at module load with "does not provide an export named resumeBlockers"
// against any instrumented tree, which is exactly what stop-capsule-writer.test
// ("a throwing content gate is logged but the capsule still lands") and
// precompact-flush.test caught. Fail-open applies to this consumer too.
import * as capsuleGate from './capsule-content-gate.mjs';

export const {
  bodySection,
  capsuleValue,
  collapseLineBreaking,
  frontmatterList,
  hasFrontmatter,
  scalar,
  scalarHasUnsupportedInlineComment,
  scalarIsUnquotedYamlNull,
  unsafeRawBodySection,
  unsafeRawCapsuleValue,
  unsafeRawDocumentBody,
  unsafeRawRewriteScalar,
  unsafeRawScalar,
} = frontmatterReader;

function requireRawReason(reason, accessor) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError(`${accessor} requires a non-empty reason string`);
  }
}

export function unsafeRawCapsuleDocument(capsulePath, reason) {
  requireRawReason(reason, 'unsafeRawCapsuleDocument');
  return readFileSync(capsulePath, 'utf8');
}

export function unsafeRawMemoryDocument(memoryPath, reason) {
  requireRawReason(reason, 'unsafeRawMemoryDocument');
  return readFileSync(memoryPath, 'utf8');
}

// Resolve an explicit identity override first, then use the single-operator
// default. A single vault needs no path-based identity table.
export function seatOf(root) {
  const override = process.env.AIGENT_SEAT_ID;
  if (typeof override === 'string' && override.trim().length > 0) {
    const value = collapseLineBreaking(override).replace(/[ \t]+/g, ' ').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value)) return value;
    return `seat-${createHash('sha256').update(override).digest('hex').slice(0, 12)}`;
  }
  return 'operator';
}

// Memory root: aigent-OS's documented convention is <AIGENT_ROOT>/vault/memory
// (see daemons/memory-heat/compute-heat.js). 'memory' at the root is kept as a
// fallback for forks that skip the vault/ subdirectory.
// AIGENT_STATE_HOME_DIR is honored before the passed root so tests and probes can
// divert every hook write into a disposable vault-shaped tree. Diversion keeps
// the real hook behavior under test while protecting operational memory; callers
// can pair it with a before/after memory diff to prove the isolation held.
export function memRoot(root) {
  const base = process.env.AIGENT_STATE_HOME_DIR || root;
  for (const candidate of ['vault/memory', 'memory']) {
    const p = path.join(String(base), ...candidate.split('/'));
    if (existsSync(p)) return p;
  }
  return path.join(String(base), 'vault', 'memory');
}

// A capsule a previous resume already spent. `active` is the only selectable
// state; every status here marks a capsule kept for the record, not for replay.
// It is tracked as its own rejection reason so the ledger below can separate
// ordinary history from a capsule that was authored and then thrown away.
export const CONSUMED_STATUSES = new Set(['resumed', 'resolved', 'consumed', 'superseded']);

// Same comparison auto-clear-transport.mjs's normalizedPath() uses for its own
// checkpoint-identity check. Duplicated rather than imported: that module
// imports FROM this one, and a path string is the entire shared surface, not
// worth a circular dependency.
function normalizedSelectorPath(candidate) {
  const resolved = path.resolve(String(candidate));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Resume has one selector: the valid active capsule with the newest frontmatter
// created_at. Any unreadable or malformed candidate is ignored; hook callers
// degrade without throwing when no valid capsule exists.
//
// selectCapsule returns the FULL result: { capsule, rejected, unavailable }.
// The rejection ledger is why this exists alongside the thin wrapper below.
// Every discard used to be a bare `continue` — six separate silent paths, no
// record of any of them. A capsule silently discarded and a capsule that never
// existed look identical to the session resuming, so a selector defect can
// reject every capsule on disk indefinitely and still look completely normal
// from the outside. Recording the reason is what makes that state auditable.
//
// The return shape is EXTENDED, never narrowed: .path/.id/.created/.createdRaw
// are unchanged and null still means "nothing to resume from", so the existing
// callers keep working untouched.
//
// sessionCapsulePath (OPTIONAL, added 2026-08-03): identity binding for the ONE
// caller that needs it — auto-clear-transport.mjs's checkpoint-freshness check,
// which asks "does my own just-written checkpoint capsule still exist and
// still hold?", never "is it also the objectively best capsule on the seat."
// The 2026-08-01 placeholder-demotion fix below answers a DIFFERENT question
// (resume quality) and, left unqualified, outranks a session's own honest
// "nothing was captured" checkpoint with an unrelated curated capsule every
// time both exist — the exact deadlock that stopped every F001 cycle from
// counting (measured cycle 5: HOLD:checkpoint-session-mismatch on every tick,
// permanently, because a reference install always has a curated capsule on
// disk). When the caller names its own capsule by path and that file is
// present and passes every structural check above (readable, frontmatter,
// active, id, created_at, non-empty objective/next_valid_action), it is the
// pick — placeholder or not, newer curated capsule or not. Omit the option and
// this function is BYTE-IDENTICAL to before this parameter existed; every
// caller that never heard of session binding never triggers this branch.
export function selectCapsule(memoryRoot, { sessionCapsulePath } = {}) {
  const sessionTarget = typeof sessionCapsulePath === 'string' && sessionCapsulePath.trim().length
    ? normalizedSelectorPath(sessionCapsulePath)
    : null;
  let sessionMatch = null;
  const rejected = [];
  const note = (name, reason, detail) => rejected.push({ name, reason, ...(detail ? { detail } : {}) });
  const none = (reason) => ({ capsule: null, rejected, unavailable: reason });

  let dir;
  try {
    dir = path.join(String(memoryRoot), 'capsules');
    if (!existsSync(dir)) return none('no-capsules-dir');
  } catch { return none('bad-memory-root'); }

  let entries;
  try {
    entries = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md'));
  } catch { return none('capsules-dir-unreadable'); }

  let best = null;
  let fallback = null;
  for (const name of entries) {
    const full = path.join(dir, name);
    let doc;
    try {
      doc = unsafeRawCapsuleDocument(full, 'capsule selection needs the complete document for shared field readers');
    } catch { note(name, 'unreadable'); continue; }
    if (!hasFrontmatter(doc)) { note(name, 'no-frontmatter'); continue; }
    const id = scalar(doc, 'id');
    const createdRaw = scalar(doc, 'created_at');
    const created = Date.parse(String(createdRaw));
    const status = scalar(doc, 'status');
    const objective = capsuleValue(doc, 'objective');
    const nextAction = capsuleValue(doc, 'next_valid_action');

    // Spent capsules are labelled apart from junk. The caller must be able to
    // tell "nothing to resume from" (a fresh install, correct) from "everything
    // here is already spent" (the ordinary end of a cycle) from "the selector
    // threw away capsules somebody wrote" (a defect).
    if (status && CONSUMED_STATUSES.has(status)) { note(name, 'already-consumed', status); continue; }
    if (status !== 'active') { note(name, 'status-not-active', status || '(absent)'); continue; }
    if (!id || !id.trim()) { note(name, 'no-id'); continue; }
    if (!Number.isFinite(created)) { note(name, 'bad-created_at', createdRaw || '(absent)'); continue; }
    // The field-level reason matters most here: "missing next_valid_action" on a
    // capsule that plainly has one is the signal that surfaces a matcher defect
    // in a day instead of never.
    if (!objective || !objective.trim() || !nextAction || !nextAction.trim()) {
      note(
        name,
        'missing-required-field',
        (!objective || !objective.trim()) ? 'objective' : 'next_valid_action',
      );
      continue;
    }

    // IDENTITY BINDING wins here, before the placeholder check ever runs, for
    // exactly the capsule the caller named — see the option's doc comment
    // above selectCapsule. Structural validity is proven by every check this
    // candidate already passed to reach this line; placeholder-ness is not
    // re-checked because it must not matter for this one candidate.
    if (sessionTarget && normalizedSelectorPath(full) === sessionTarget) {
      sessionMatch = { path: full, id, created, createdRaw };
    }

    // Presence is not resumability. The stop-writer honestly reports when a Stop
    // delta captured no objective and no next action; that report is correct
    // output and its contract is deliberate (never invent an objective the human
    // did not say). Such a capsule is still a legitimate LAST RESORT — resume-verb
    // brands it loudly and explains how to read it — but being newest it was
    // OUTRANKING every curated capsule on the seat, measured 2026-08-01 on three
    // of four live seats.
    //
    // So this DEMOTES rather than rejects: fallback tier, never the preferred
    // pick. Rejecting outright would have deleted the loud-autosave path that
    // resume-verb:87 and its tests already ship — the safety feature this change
    // exists to serve.
    let placeholders = [];
    try {
      placeholders = typeof capsuleGate.resumeBlockers === 'function'
        ? capsuleGate.resumeBlockers({ objective, next_valid_action: nextAction })
        : [];
    } catch { placeholders = []; }   // broken gate → behave exactly as before the gate existed
    if (placeholders.length) {
      if (!fallback || created > fallback.created) {
        fallback = { path: full, id, created, createdRaw, why: placeholders[0] };
      }
      continue;
    }
    if (!best || created > best.created) {
      best = { path: full, id, created, createdRaw };
    }
  }

  // The named session capsule wins THIS selection outright — see the option's
  // doc comment above selectCapsule. Checked after the loop completes (not by
  // returning early inside it) so `rejected` still carries every OTHER
  // candidate's real disposition; only the winning pick changes.
  if (sessionMatch) {
    return { capsule: sessionMatch, rejected, sessionBound: true };
  }

  // A curated capsule always wins. Record the demotion so the ledger shows the
  // placeholder was seen and passed over — a silent demotion reads exactly like
  // the placeholder never existing.
  if (best) {
    if (fallback) note(path.basename(fallback.path), 'placeholder-demoted', fallback.why);
    return { capsule: best, rejected };
  }
  // Nothing curated survives: the placeholder is better than resuming blind, and
  // resume-verb brands it "*** AUTOSAVE, NOT A CURATED CAPSULE ***" on the way out.
  if (fallback) return { capsule: fallback, rejected, fellBackToPlaceholder: true };
  return { capsule: null, rejected, unavailable: entries.length ? 'all-candidates-rejected' : 'no-capsules-on-disk' };
}

// Backward-compatible wrapper for callers that only need the selection. The
// orientation leg (sessionstart-reinject) labels whatever comes back "newest
// active capsule", so null here still means exactly what it always did.
//
// `options` threads straight to selectCapsule (sessionCapsulePath and any
// future addition); the return shape is intentionally kept as narrow as
// before (.path/.id/.created/.createdRaw + .rejected only) so a caller that
// never passes options gets a BYTE-IDENTICAL object to pre-2026-08-03 — no
// existing caller reads .sessionBound or .fellBackToPlaceholder off this
// wrapper today, and none starts implicitly by this change.
export function newestValidCapsule(memoryRoot, options) {
  const { capsule, rejected } = selectCapsule(memoryRoot, options);
  if (!capsule) return null;
  return { ...capsule, rejected };
}

// The rendering boundary between capsule content and prompt structure.
//
// Values read off a capsule are DATA. They are attacker-controllable in the
// scenario this design already assumes — a capsules directory is just files, and
// anything that can write one can choose every byte of its frontmatter — so a
// value must never be able to contribute STRUCTURE to a generated procedure.
// Historically, rendering a decoded frontmatter scalar carrying "\n" raw began
// its own line, and a line of its own is all a forged instruction needs to look
// like one of ours. Safe readers now collapse that structure too; inert remains
// the required quoting and bounding boundary.
//
// Three properties, each load-bearing:
//   1. Single line. Every line-breaking character becomes a space, so the value
//      is always a fragment of a line that OUR code started, never a line.
//   2. Quoted. The reader can see where the datum begins and ends, so text
//      shaped like a heading is visibly inside a value.
//   3. Bounded. An unbounded field can otherwise flood the procedure and push
//      the fences out of the reader's attention entirely.
// Truncation is announced, not silent: a value trimmed here is still evidence.
export function inert(value, max = 500) {
  let s = collapseLineBreaking(value ?? '').replace(/[ \t]+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max)}…[+${s.length - max} chars]`;
  return JSON.stringify(s);
}

// Human-readable account of what the selector discarded. Grouped by reason so a
// systemic defect reads as ONE line ("47x missing-required-field
// (next_valid_action)") rather than 47 unrelated ones, which is the shape that
// makes a matcher bug obvious on sight.
//
// Reasons are this module's own vocabulary; details and file names come off
// disk, so they go through inert() HERE rather than at the call site — the
// summary is the unit that must be safe to print, whoever prints it.
export function rejectionSummary(rejected) {
  if (!Array.isArray(rejected) || !rejected.length) return null;
  const maximumGroups = 12;
  const byReason = new Map();
  for (const r of rejected) {
    const key = r.detail ? `${r.reason} (${inert(r.detail, 120)})` : String(r.reason);
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(inert(r.name, 120));
  }
  const groups = [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([reason, names]) => `${names.length}x ${reason}: ${names.length <= 3 ? names.join(', ') : `e.g. ${names[0]}`}`);
  const rendered = groups.slice(0, maximumGroups);
  if (groups.length > maximumGroups) {
    rendered.push(`[TRUNCATED: +${groups.length - maximumGroups} rejection groups omitted]`);
  }
  return rendered;
}

// The write half of the consume contract. The selector above only ever picks
// `status: active` capsules; without this, nothing ever LEAVES that state on the
// automatic path, so the newest capsule would be silently re-resumed on every
// subsequent clear — stale state presented as fresh. The resume verb calls this
// at load time, and only the resume verb: orientation reads are not a resume and
// must not spend the capsule. If the session dies between the mark and the acted
// step, the next boot takes the documented degraded path (re-derive from live
// memory) — a loud fresh start, never a silent replay.
export function markCapsuleConsumed(capsulePath) {
  const doc = unsafeRawCapsuleDocument(
    capsulePath,
    'status mutation preserves the complete capsule outside the active frontmatter token',
  );
  const marked = unsafeRawRewriteScalar(
    doc,
    'status',
    'active',
    'resumed',
    'consume transition preserves every byte outside the leading status scalar',
  );
  if (marked === doc) return false; // not active — already spent, nothing to mark
  writeFileSync(capsulePath, marked);
  return true;
}

// null = the read itself THREW (a real failure, log it); '' = genuinely empty.
// The lifecycle legs need the distinction — an unreadable stdin must not read the
// same as "no input".
export function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return null; }
}

export function logErr(root, tag, msg) {
  const line = `${new Date().toISOString()} tag=${inert(tag, 80)} message=${inert(msg, 1000)}\n`;
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
