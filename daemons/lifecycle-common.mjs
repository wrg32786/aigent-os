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
import path from 'node:path';

// Resolve an explicit identity override first, then use the single-operator
// default. A single vault needs no path-based identity table.
export function seatOf(root) {
  const override = process.env.AIGENT_SEAT_ID;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
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

// Hand-authored capsules carry objective / waiting_on / next_valid_action as
// `## <key>` body sections instead of frontmatter scalars; both shapes are valid
// capsule fields. Captures until the next heading of any level.
// The key is a machine name (`next_valid_action`) but a hand-authored heading is
// prose (`## Next valid action`), so an underscore in the key must also match a
// space in the heading. Normalizing that separator keeps prose-heading capsules
// eligible for the same validation as frontmatter-backed capsules.
export function bodySection(doc, key) {
  const heading = String(key)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/_/g, '[ _]');
  const match = String(doc).match(
    new RegExp(`^#{1,6}[ \\t]+${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,6}[ \\t]|(?![\\s\\S]))`, 'mi'),
  );
  const value = match?.[1]?.trim();
  return value || null;
}

// A capsule a previous resume already spent. `active` is the only selectable
// state; every status here marks a capsule kept for the record, not for replay.
// It is tracked as its own rejection reason so the ledger below can separate
// ordinary history from a capsule that was authored and then thrown away.
export const CONSUMED_STATUSES = new Set(['resumed', 'resolved', 'consumed', 'superseded']);

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
    try { doc = readFileSync(full, 'utf8'); } catch { note(name, 'unreadable'); continue; }
    const frontmatter = doc.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
    if (!frontmatter) { note(name, 'no-frontmatter'); continue; }
    const scalar = (key) => {
      const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
      if (!match) return null;
      const raw = match[1].trim();
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return parsed;
      } catch { /* raw scalar */ }
      return raw.replace(/^['"]|['"]$/g, '');
    };
    const id = scalar('id');
    const createdRaw = scalar('created_at');
    const created = Date.parse(String(createdRaw));
    const status = scalar('status');
    const objective = scalar('objective') || bodySection(doc, 'objective');
    const nextAction = scalar('next_valid_action') || bodySection(doc, 'next_valid_action');

    // Spent capsules are labelled apart from junk. The caller must be able to
    // tell "nothing to resume from" (a fresh install, correct) from "everything
    // here is already spent" (the ordinary end of a cycle) from "the selector
    // threw away capsules somebody wrote" (a defect).
    if (status && CONSUMED_STATUSES.has(status)) { note(name, 'already-consumed', status); continue; }
    if (status !== 'active') { note(name, 'status-not-active', status || '(absent)'); continue; }
    if (!id) { note(name, 'no-id'); continue; }
    if (!Number.isFinite(created)) { note(name, 'bad-created_at', createdRaw || '(absent)'); continue; }
    // The field-level reason matters most here: "missing next_valid_action" on a
    // capsule that plainly has one is the signal that surfaces a matcher defect
    // in a day instead of never.
    if (!objective || !nextAction) {
      note(name, 'missing-required-field', !objective ? 'objective' : 'next_valid_action');
      continue;
    }
    if (!best || created > best.created) {
      best = { path: full, id, created, createdRaw };
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

// Human-readable account of what the selector discarded. Grouped by reason so a
// systemic defect reads as ONE line ("47x missing-required-field
// (next_valid_action)") rather than 47 unrelated ones, which is the shape that
// makes a matcher bug obvious on sight.
export function rejectionSummary(rejected) {
  if (!Array.isArray(rejected) || !rejected.length) return null;
  const byReason = new Map();
  for (const r of rejected) {
    const key = r.detail ? `${r.reason} (${r.detail})` : r.reason;
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(r.name);
  }
  return [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([reason, names]) => `${names.length}x ${reason}: ${names.length <= 3 ? names.join(', ') : `e.g. ${names[0]}`}`);
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
  const doc = readFileSync(capsulePath, 'utf8');
  // Operate on the frontmatter block ONLY — a body line quoting "status: active"
  // must never be rewritten.
  const fm = doc.match(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fm) return false;
  // (\r?) keeps CRLF capsules markable: multiline $ matches before \n only, so
  // without capturing the \r a capsule saved with Windows line endings would
  // not match.
  const marked = fm[0].replace(/^(status:[ \t]*)(['"]?)active\2[ \t]*(\r?)$/m, '$1resumed$3');
  if (marked === fm[0]) return false; // not active — already spent, nothing to mark
  writeFileSync(capsulePath, marked + doc.slice(fm[0].length));
  return true;
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
