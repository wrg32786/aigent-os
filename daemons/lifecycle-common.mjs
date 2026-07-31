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

import { readFileSync, existsSync, appendFileSync, writeSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
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

function unsafeRawContainedCapsuleDocument(capsulePath, fsImpl, reason) {
  requireRawReason(reason, 'unsafeRawContainedCapsuleDocument');
  return fsImpl.readFileSync(capsulePath, 'utf8');
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

// A path refusal is data, not just an exception.  The lifecycle containers are
// fail-open by contract, so callers catch this class and put its stable `reason`
// into the rejection/error stream before degrading.  Keeping the reason outside
// free-form error prose lets tests and operators distinguish containment,
// symlink, and file-type failures without scraping platform-specific messages.
export class CapsulePathRefusal extends Error {
  constructor(reason, stage, capsulePath, detail = '') {
    super(`CAPSULE_PATH_REFUSAL reason=${reason} stage=${stage} path=${capsulePath}${detail ? ` detail=${detail}` : ''}`);
    this.name = 'CapsulePathRefusal';
    this.code = 'ECAPSULEPATH';
    this.reason = reason;
    this.stage = stage;
    this.capsulePath = capsulePath;
    this.detail = detail;
  }
}

function comparablePath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function canonicalPath(fsImpl, target) {
  const native = fsImpl.realpathSync && fsImpl.realpathSync.native;
  return typeof native === 'function' ? native(target) : fsImpl.realpathSync(target);
}

function refuse(reason, stage, candidate, detail) {
  throw new CapsulePathRefusal(reason, stage, candidate, detail);
}

// Resolve and classify a candidate without following any path component below
// the capsules root.  realpath containment and lstat component checks are both
// required: containment alone accepts a link whose target happens to stay in
// the root, while lstat alone misses a reparse alias a platform reports as an
// ordinary directory.  Comparing the canonical result with the path expected
// beneath the canonical root closes that second case (including junctions).
//
// `allowMissingLeaf` exists only for an exclusive-create staging name.  Its
// parent chain is still fully checked and canonicalised; only the final ENOENT
// is accepted.
export function assertCapsulePathContained(
  capsulesRoot,
  candidatePath,
  stage,
  { fsImpl = nodeFs, allowMissingLeaf = false } = {},
) {
  const root = path.resolve(String(capsulesRoot));
  const candidate = path.resolve(String(candidatePath));
  if (!isInside(root, candidate)) {
    refuse('capsule-path-outside-root', stage, candidate, `root=${root}`);
  }

  let canonicalRoot;
  try {
    canonicalRoot = canonicalPath(fsImpl, root);
  } catch (error) {
    refuse('capsules-root-unresolvable', stage, candidate, error?.code || error?.message || String(error));
  }

  const relative = path.relative(root, candidate);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  let leafMissing = false;
  let leafStat = null;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const leaf = index === parts.length - 1;
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch (error) {
      if (leaf && allowMissingLeaf && error?.code === 'ENOENT') {
        leafMissing = true;
        break;
      }
      refuse('capsule-path-unresolvable', stage, candidate, `${error?.code || error?.message || error}`);
    }
    if (stat.isSymbolicLink()) {
      refuse('capsule-path-symlink', stage, candidate, `component=${current}`);
    }
    if (!leaf && !stat.isDirectory()) {
      refuse('capsule-path-parent-not-directory', stage, candidate, `component=${current}`);
    }
    if (leaf && !stat.isFile()) {
      refuse('capsule-path-not-regular', stage, candidate, `component=${current}`);
    }
    if (leaf) leafStat = stat;
  }

  const canonicalTarget = leafMissing ? path.dirname(candidate) : candidate;
  let actual;
  try {
    actual = canonicalPath(fsImpl, canonicalTarget);
  } catch (error) {
    refuse('capsule-path-unresolvable', stage, candidate, `${error?.code || error?.message || error}`);
  }
  if (!isInside(canonicalRoot, actual, { allowRoot: leafMissing && parts.length === 1 })) {
    refuse('capsule-path-outside-root', stage, candidate, `canonical=${actual} root=${canonicalRoot}`);
  }

  const expected = leafMissing
    ? path.resolve(canonicalRoot, path.dirname(relative))
    : path.resolve(canonicalRoot, relative);
  if (comparablePath(actual) !== comparablePath(expected)) {
    refuse('capsule-path-alias', stage, candidate, `canonical=${actual} expected=${expected}`);
  }

  return { candidate, canonicalRoot, canonicalPath: leafMissing ? null : actual, stat: leafStat };
}

export function readContainedCapsuleDocument(
  capsulesRoot,
  capsulePath,
  stage,
  { fsImpl = nodeFs } = {},
) {
  assertCapsulePathContained(capsulesRoot, capsulePath, stage, { fsImpl });
  // Keep the guard adjacent to the touch.  Callers must not validate at
  // selection and then reuse that stale verdict for this read.
  return unsafeRawContainedCapsuleDocument(
    capsulePath,
    fsImpl,
    'contained capsule touch needs the complete document after its adjacent path check',
  );
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
export function selectCapsule(memoryRoot, { fsImpl = nodeFs } = {}) {
  const rejected = [];
  const note = (name, reason, detail) => rejected.push({ name, reason, ...(detail ? { detail } : {}) });
  const none = (reason) => ({ capsule: null, rejected, unavailable: reason });

  let dir;
  try {
    dir = path.join(String(memoryRoot), 'capsules');
    if (!fsImpl.existsSync(dir)) return none('no-capsules-dir');
  } catch { return none('bad-memory-root'); }

  let entries;
  try {
    entries = fsImpl.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md'));
  } catch { return none('capsules-dir-unreadable'); }

  let best = null;
  for (const name of entries) {
    const full = path.join(dir, name);
    let doc;
    try {
      doc = readContainedCapsuleDocument(dir, full, 'selector-read', { fsImpl });
    } catch (error) {
      if (error?.code === 'ECAPSULEPATH') note(name, error.reason, error.stage);
      else note(name, 'unreadable');
      continue;
    }
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
export function markCapsuleConsumed(
  capsulePath,
  memoryRoot,
  { fsImpl = nodeFs } = {},
) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim().length === 0) {
    refuse(
      'capsules-root-required',
      'consume-authority',
      path.resolve(String(capsulePath)),
      'markCapsuleConsumed requires the authoritative memory root',
    );
  }
  const capsulesRoot = path.join(String(memoryRoot), 'capsules');
  const doc = readContainedCapsuleDocument(capsulesRoot, capsulePath, 'consume-final-read', { fsImpl });
  const marked = unsafeRawRewriteScalar(
    doc,
    'status',
    'active',
    'resumed',
    'consume transition preserves every byte outside the leading status scalar',
  );
  if (marked === doc) return false; // not active — already spent, nothing to mark

  const temporaryPath = `${capsulePath}.consume-${process.pid}-${randomBytes(6).toString('hex')}`;
  let staged = false;
  try {
    // Recheck BOTH names at the first write boundary.  The final path may have
    // changed since the read above, and a pre-planted temporary name must not be
    // followed.  `wx` makes the missing-leaf verdict an exclusive creation.
    const finalBeforeStage = assertCapsulePathContained(
      capsulesRoot,
      capsulePath,
      'consume-final-stage',
      { fsImpl },
    );
    assertCapsulePathContained(
      capsulesRoot,
      temporaryPath,
      'consume-temporary-write',
      { fsImpl, allowMissingLeaf: true },
    );
    fsImpl.writeFileSync(temporaryPath, marked, {
      encoding: 'utf8',
      flag: 'wx',
      ...(Number.isInteger(finalBeforeStage.stat?.mode)
        ? { mode: finalBeforeStage.stat.mode & 0o777 }
        : {}),
    });
    staged = true;

    // The staging write itself is another scheduling point.  Recheck the final
    // and temporary names immediately before rename performs the commit; a
    // stale verdict from before writeFileSync is not reusable here.
    assertCapsulePathContained(
      capsulesRoot,
      capsulePath,
      'consume-final-commit',
      { fsImpl },
    );
    assertCapsulePathContained(
      capsulesRoot,
      temporaryPath,
      'consume-temporary-commit',
      { fsImpl },
    );
    fsImpl.renameSync(temporaryPath, capsulePath);
    staged = false;
    return true;
  } finally {
    if (staged) {
      // Cleanup must obey the same boundary.  If the staging name drifted to a
      // link/junction, leaving an orphan is safer than unlinking through a path
      // we just refused to trust.
      try {
        assertCapsulePathContained(
          capsulesRoot,
          temporaryPath,
          'consume-temporary-cleanup',
          { fsImpl },
        );
        fsImpl.unlinkSync(temporaryPath);
      } catch { /* refused or already gone: never cross-delete */ }
    }
  }
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
