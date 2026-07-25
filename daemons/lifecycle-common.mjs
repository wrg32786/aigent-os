// lifecycle-common.mjs — shared identity/vault resolution for the two-verb lifecycle.
//
// aigent-OS is single-operator by default: one vault, one BODY_STATE.json, one
// active-capsule pointer. `seatId` stays a first-class concept (not stripped) so a
// fork that dispatches persistent sub-agents — each with its own vault root — can
// still tag evidence/receipts per-identity; out of the box it resolves to the
// single 'operator' identity via AIGENT_SEAT_ID (or the default). Keep this file
// dependency-free and side-effect-free — everything downstream imports from here.
//
// v0.9.0 minimal model: resume selection has exactly one authority —
// newestValidCapsule() below, by frontmatter created_at. There is no pointer, no
// definition_hash, and no cross-session curated-close bookkeeping to keep in sync
// with it; the refresh-cycle tower that used to live in this file (CLOSE_KINDS,
// flipCapsuleToResumed, stampBootEvidence, crossSessionCuratedAllowed,
// curatedWindowMs, resumeFlipShouldDefer) is retired along with the daemons that
// only existed to drive it.

import { readFileSync, existsSync, appendFileSync, writeSync, readdirSync, writeFileSync } from 'node:fs';
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

// Hand-authored capsules carry objective / waiting_on / next_valid_action as
// `## <key>` body sections instead of frontmatter scalars; both shapes are valid
// capsule fields. Captures until the next heading of any level.
// The key is a machine name (`next_valid_action`) but a hand-authored heading is
// prose (`## Next valid action`), so an underscore in the key must also match a
// space in the heading. Interpolating the key literally defeated the paragraph
// above: `objective` matched (one word, no separator) while `next_valid_action`
// and `waiting_on` never did, so a capsule written with prose headings failed
// newestValidCapsule's `!nextAction` gate and was skipped in silence -- resume
// then fell back to whatever autosave happened to be newest.
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

// Resume has one selector: the valid active capsule with the newest frontmatter
// created_at. Any unreadable or malformed candidate is ignored; hook callers
// degrade without throwing when no valid capsule exists.
export function newestValidCapsule(memoryRoot) {
  let dir;
  try {
    dir = path.join(String(memoryRoot), 'capsules');
    if (!existsSync(dir)) return null;
  } catch { return null; }

  let entries;
  try {
    entries = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md'));
  } catch { return null; }

  let best = null;
  for (const name of entries) {
    const full = path.join(dir, name);
    let doc;
    try { doc = readFileSync(full, 'utf8'); } catch { continue; }
    const frontmatter = doc.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
    if (!frontmatter) continue;
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
    if (status !== 'active' || !id || !Number.isFinite(created)) continue;
    if (!objective || !nextAction) continue;
    if (!best || created > best.created) {
      best = { path: full, id, created, createdRaw };
    }
  }
  return best;
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
  // silently never match — the exact silent-failure class this function ends.
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
