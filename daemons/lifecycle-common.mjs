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
// `complete` is here because the retired /close verb stamped it, and a curated
// close is the most finished thing in the directory. Measured before it was
// added: two such capsules sit in the wild, silently rejected every cycle since
// that verb retired, because nothing in either set named the word.
export const CONSUMED_STATUSES = new Set([
  'resumed', 'resolved', 'consumed', 'superseded', 'complete',
]);

// The LIVE set: a capsule nobody has spent yet. It was implicit and its only
// member was `active` (board 03167498), which made the reader's vocabulary one
// word wide while the writers' was wider — a hand-authored `fresh` capsule went
// into the same silent reject bucket as a typo, and the seat resumed off an
// autosave delta instead. Measured across 399 capsules on four seats: `fresh`
// and `complete` were the only two words outside the sets, and they needed
// OPPOSITE homes, which is why this is a named vocabulary and not a widening.
//
// ⚑ THIS IS A CLOSED SET ON PURPOSE. Everything outside LIVE ∪ CONSUMED stays
// unselectable — a draft, a typo, a fork's own vocabulary, an absent status
// line. resume-verb.test.mjs's 'neither active nor consumed cannot be resumed
// from' is the control that proves adding members never became opening a gate;
// it is deliberately unmodified. Add a word here only after measuring that a
// writer really emits it, and only into the set that matches what it MEANS.
export const LIVE_STATUSES = new Set(['active', 'fresh']);

// Rank, not recency. An autosave is a delta snapshot wearing a capsule's schema
// (Stop-hook, `trigger: stop-delta`); a curated capsule is a hand's account of
// where the work stands. The autosave daemon fires AFTER capsule-done and
// before the resume, so on a pure created_at ordering it wins every cycle a
// capsule is actually written — which is the mismatch this row was opened for:
// the supervisor holds the seat to the id it ANNOUNCED at capsule-done, while
// the selector was handing back the newest file. Ranking curated above autosave
// makes the reader agree with the expectation the fleet already enforces.
//
// Read off the capsule's OWN declared markers, never the filename: a curated
// capsule that merely discusses autosaves keeps its rank.
export function isAutosaveCapsule({ trigger, tags }) {
  return trigger === 'stop-delta'
    || /(^|[,[\s])autosave([,\]\s]|$)/.test(tags || '');
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
export function selectCapsule(memoryRoot) {
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
    const trigger = scalar(doc, 'trigger');
    const tags = scalar(doc, 'tags');
    const objective = capsuleValue(doc, 'objective');
    const nextAction = capsuleValue(doc, 'next_valid_action');

    // Spent capsules are labelled apart from junk. The caller must be able to
    // tell "nothing to resume from" (a fresh install, correct) from "everything
    // here is already spent" (the ordinary end of a cycle) from "the selector
    // threw away capsules somebody wrote" (a defect).
    if (status && CONSUMED_STATUSES.has(status)) { note(name, 'already-consumed', status); continue; }
    // ⚑ LOUD, and distinctly so. This is where a hand-authored capsule used to
    // die quietly: one `status-not-active` line in a ledger, indistinguishable
    // from a typo, for as long as nobody looked. A word the writers use and the
    // readers do not is a vocabulary gap that costs a cycle at most IF it is
    // announced — and a month if it is not. The reason string is what the
    // resume verb escalates on, so the NEXT new word surfaces on first contact
    // instead of degrading the seat to an autosave in silence.
    if (!LIVE_STATUSES.has(status)) {
      note(name, 'status-unrecognized', status || '(absent)');
      continue;
    }
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
    // RANK FIRST, RECENCY SECOND. rank 0 = curated, rank 1 = autosave delta.
    // A lower rank always wins; created_at only breaks ties WITHIN a rank, so a
    // curated capsule is never displaced by an autosave written eight minutes
    // later — which was the every-cycle case, not an edge one.
    const rank = isAutosaveCapsule({ trigger, tags }) ? 1 : 0;
    if (!best || rank < best.rank || (rank === best.rank && created > best.created)) {
      best = { path: full, id, created, createdRaw, rank };
    }
  }

  if (best) return { capsule: best, rejected };
  return { capsule: null, rejected, unavailable: entries.length ? 'all-candidates-rejected' : 'no-capsules-on-disk' };
}

// Backward-compatible wrapper for callers that only need the selection. The
// orientation leg (sessionstart-reinject) labels whatever comes back "newest
// active capsule", so null here still means exactly what it always did.
export function newestValidCapsule(memoryRoot) {
  const { capsule, rejected } = selectCapsule(memoryRoot);
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
  // ⚑ EVERY LIVE STATUS, not just `active`. This half is what a vocabulary fix
  // forgets: making a word SELECTABLE without making it SPENDABLE yields a
  // capsule that is chosen on every clear forever, replaying stale state — the
  // exact failure the consume contract exists to prevent, reintroduced through
  // a new word. The two sets are read from one place so they cannot drift.
  let marked = doc;
  for (const live of LIVE_STATUSES) {
    marked = unsafeRawRewriteScalar(
      doc,
      'status',
      live,
      'resumed',
      'consume transition preserves every byte outside the leading status scalar',
    );
    if (marked !== doc) break;
  }
  if (marked === doc) return false; // not live — already spent, nothing to mark
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
