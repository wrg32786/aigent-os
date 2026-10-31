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

import { readFileSync, existsSync, appendFileSync, writeSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
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
import { resolveMemoryRoot, describeMemoryRoot, MemoryRootError } from './memory-root.cjs';
const WRITE_VERBS = new Set('send reply forward publish post schedule deploy submit create update delete trigger merge pay charge purchase order push save add complete buy upload write set archive ban apply assign cancel claim renew register edit label trash mark move rename restore duplicate generate execute run start stop kill drain pin unpin approve reject resolve_report invite clear purge reset revoke unsubscribe subscribe remove disconnect connect close reopen retry sync import change rerequest modify toggle enable disable grant deny accept decline activate deactivate promote demote rollback redeploy restart moderate flag dismiss mute unmute lock unlock transfer reassign release upgrade downgrade convert rotate invalidate recalculate'.split(' '));
const READ_VERBS = new Set('get list read search fetch describe query show view count find download peek lookup whoami history preview export snapshot context receipts discover learn extract balance transactions wait crawl map take screenshot review inspect poll ping echo version help'.split(' '));
const NOUNISH = new Set(['post', 'order', 'run', 'label']);
export function classifyMcpEffect(name) {
  if (typeof name !== 'string' || !name.includes('__')) return 'read';
  // Normalize camel suffixes before applying the final-segment vocabulary.
  const tokens = name.slice(name.lastIndexOf('__') + 2).replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[-_]/);
  // A leading read verb owns the name unless a conjunction introduces a write.
  if (READ_VERBS.has(tokens[0])) {
    return tokens.some((token, i) => (token === 'or' || token === 'and')
      && tokens.slice(i + 1).some((word, j, tail) => WRITE_VERBS.has(word)
        || WRITE_VERBS.has(`${word}_${tail[j + 1]}`))) ? 'write' : 'read';
  }
  // resolve_report is the one compound entry in the write vocabulary.
  if (tokens.some((token, i) => (WRITE_VERBS.has(token) && (!NOUNISH.has(token) || i === 0))
    || WRITE_VERBS.has(`${token}_${tokens[i + 1]}`))) return 'write';
  return tokens.some((token) => READ_VERBS.has(token)) ? 'read' : 'default';
}
// Core owns the format. The standalone plugin carries its own parity-tested copy.
export const CAPSULE_SECTIONS = Object.freeze([
  { key: 'done', maxDepth: 2, title: "Done (don't redo)", anchor: '<!-- swe:done -->', headingPattern: '^Done\\b.*redo' },
  { key: 'errors', maxDepth: 2, title: 'Historical-Errors → Resolutions', anchor: '<!-- swe:errors -->', headingPattern: '^Historical-Errors\\s*(?:→|->)\\s*Resolutions' },
  { key: 'rejected', maxDepth: 2, title: 'Historical-Rejected-Approaches', anchor: '<!-- swe:rejected -->', headingPattern: '^Historical-Rejected-Approaches$' },
  { key: 'files', maxDepth: 2, title: 'Files-Read / Files-Modified', anchor: '<!-- swe:files -->', headingPattern: '^Files-Read / Files-Modified$' },
  { key: 'facts', maxDepth: 2, title: 'Operating-Facts', anchor: '<!-- swe:facts -->', headingPattern: '^Operating-Facts$' },
  { key: 'effects', maxDepth: 3, title: 'In-Flight Side Effects', anchor: '<!-- swe:effects -->', headingPattern: '^In-Flight Side Effects' },
  { key: 'gates', maxDepth: 3, title: 'Pending-Gates', anchor: '<!-- swe:gates -->', headingPattern: '^Pending-Gates$' },
  { key: 'rows', maxDepth: 2, title: 'Claimed-Rows', anchor: '<!-- swe:rows -->', headingPattern: '^Claimed-Rows$' },
].map((entry) => Object.freeze({ ...entry, heading: new RegExp(entry.headingPattern, 'i') })));

export const {
  bodySection,
  capsuleValue,
  collapseLineBreaking,
  documentBodyStart,
  frontmatterList,
  hasFrontmatter,
  scalar,
  HEADING_SCAN,
  sectionBounds,
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

// Memory root: resolved by daemons/memory-root.cjs, the ONE place that decides
// where a seat's memory tree is (the documented default is
// <AIGENT_ROOT>/vault/memory; a seat may declare another root in
// .aigent/state.json). Nothing here or in any caller constructs the path by
// hand. A declared root that is missing, malformed or unsafe throws a
// MemoryRootError rather than falling back to a tree that is not this seat's.
// AIGENT_STATE_HOME_DIR is honored before the passed root so tests and probes can
// divert every hook write into a disposable vault-shaped tree; the declaration
// is then read under the diverted base, so a diverted hook never touches the
// real seat. Diversion keeps the real hook behavior under test while protecting
// operational memory; callers can pair it with a before/after memory diff to
// prove the isolation held.
export function memRoot(root) {
  return resolveMemoryRoot(String(process.env.AIGENT_STATE_HOME_DIR || root));
}
export { MemoryRootError, describeMemoryRoot };

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
  // Law XVI clause 4: once a capsule is used for resume it is marked so it is
  // not reused, OR if it is reused on resume that is loudly stated. The
  // marking half (markCapsuleConsumed, below) has always existed; this tracks
  // the newest CONSUMED candidate that is otherwise structurally valid --
  // real content, not junk -- so a re-resume off spent state can be the loud
  // half instead of looking exactly like a fresh install.
  let newestConsumed = null;
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
    if (status && CONSUMED_STATUSES.has(status)) {
      note(name, 'already-consumed', status);
      // Same structural bar an active candidate must clear below (id,
      // finite created_at, non-empty objective/next_valid_action) -- a
      // consumed capsule that fails it is junk, not a reuse candidate.
      if (id && id.trim() && Number.isFinite(created) && objective && objective.trim() && nextAction && nextAction.trim()
        && (!newestConsumed || created > newestConsumed.created)) {
        newestConsumed = { path: full, id, created, createdRaw };
      }
      continue;
    }
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
  // Spent-but-real outranks active-but-empty. A structurally valid consumed
  // capsule is real work someone captured; the placeholder fallback tier is
  // an honest "nothing was captured" report. Between the two, the real one is
  // the more useful thing to hand back, loudly flagged as a reuse rather than
  // silently indistinguishable from a fresh install.
  if (newestConsumed) return { capsule: newestConsumed, rejected, reused: true };
  // Nothing curated survives: the placeholder is better than resuming blind, and
  // resume-verb brands it "*** AUTOSAVE, NOT A CURATED CAPSULE ***" on the way out.
  if (fallback) return { capsule: fallback, rejected, fellBackToPlaceholder: true };
  return { capsule: null, rejected, unavailable: entries.length ? 'all-candidates-rejected' : 'no-capsules-on-disk' };
}

// Only adjacent indented continuations belong to a bullet. Shared by the
// selected-capsule reader and the read-only effects collector.
export function capsuleBulletRows(section) {
  const rows = [];
  let current = -1;
  for (const line of section.split(/\r?\n/)) {
    if (/^[ \t]*(?:[-*+][ \t]+|\d+\.[ \t]+)/.test(line)) {
      current = rows.push(line) - 1;
    } else if (!line.trim() || line.match(HEADING_SCAN) || /^[ \t]*<!--/.test(line)) {
      current = -1;
    } else if (current !== -1 && /^[ \t]/.test(line)) {
      rows[current] += `\n${line}`;
    } else {
      current = -1;
    }
  }
  return rows;
}

// Selection and consumption remain selectCapsule/loadCapsule's responsibility.
// This scan never writes another capsule and never traverses another memory root.
// Structured writer resolutions alone retire carried rows; prose and age do not.
export function collectCapsuleSideEffects(memoryRoot, { selectedPath, selectedDoc, onError }) {
  const rows = [];
  const resolved = new Set();
  let unchecked = 0;
  const failed = (file, error) => {
    unchecked++;
    onError(file, error);
  };
  const identity = (r) => JSON.stringify([r.op, r.kind.replace(/^(?:sidechain:)+/, ''), r.target]);
  const inspect = (doc, file, selected = false) => {
    const id = scalar(doc, 'id');
    const created = Date.parse(scalar(doc, 'created_at'));
    const valid = hasFrontmatter(doc) && id?.trim() && Number.isFinite(created) && scalar(doc, 'status');
    if (!valid) failed(file, new Error('malformed capsule frontmatter'));
    // Match the Stop writer's ownership test, including exact tag tokens.
    const autosaveTag = (scalar(doc, 'tags') || '').replace(/^\[|\]$/g, '').split(',')
      .map((tag) => tag.trim().replace(/^['"]|['"]$/g, '').toLowerCase()).includes('autosave');
    const writerOwned = valid && autosaveTag && (scalar(doc, 'trigger') || '').toLowerCase() === 'stop-delta';
    const section = locateCapsuleSection(doc, 'effects');
    if (!section) return;
    for (const row of capsuleBulletRows(doc.slice(section.start, section.end))) {
      const parsed = parseSideEffectRow(row);
      if (parsed && ['confirmed', 'failed'].includes(parsed.outcome)) {
        if (writerOwned) resolved.add(identity(parsed));
      } else if (!selected) {
        rows.push({ row, source: id || path.basename(file), created: Number.isFinite(created) ? created : 0,
          identity: parsed ? identity(parsed) : null });
      }
    }
  };
  // Selected rows keep their current rendering, but a selected writer-owned
  // resolution can suppress an older copy in another capsule.
  inspect(selectedDoc, selectedPath, true);
  const dir = path.join(memoryRoot, 'capsules');
  let entries, scope;
  try {
    scope = realpathSync(memoryRoot);
    const relative = path.relative(scope, realpathSync(dir));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('capsules directory is outside this memory root');
    }
    entries = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')).sort();
  } catch (error) {
    failed(dir, error);
    return { rows: [], unparseable: 0, unchecked };
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    if (normalizedSelectorPath(file) === normalizedSelectorPath(selectedPath)) continue;
    try {
      const relative = path.relative(scope, realpathSync(file));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('capsule is outside this memory root');
      }
      inspect(unsafeRawCapsuleDocument(file, 'collect unresolved effects as inert claims from this memory root'), file);
    } catch (error) { failed(file, error); }
  }
  const carried = rows.filter((entry) => entry.identity === null || !resolved.has(entry.identity));
  return { rows: carried, unparseable: carried.filter((entry) => entry.identity === null).length, unchecked };
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
//
// A reuse pick is deliberately treated as null here too: this wrapper's
// narrow contract is "the newest FRESH active capsule, or nothing", and a
// reused capsule is not fresh. Only resume-verb.mjs (via selectCapsule
// directly) needs to know a reuse happened and announce it loudly.
export function newestValidCapsule(memoryRoot, options) {
  const { capsule, rejected, reused } = selectCapsule(memoryRoot, options);
  if (!capsule || reused) return null;
  return { ...capsule, rejected };
}

// Shared grouping/dedup key: discard list decoration and the undated clock
// stamp without changing speaker tags or attempting to sort chronology.
export function capsuleRowKey(row) {
  return collapseLineBreaking(row).replace(/[ \t]+/g, ' ').trim().replace(/^(?:[-*+] |\d+\.[ \t]+)/, '').replace(/^\d{2}:\d{2} /, '');
}

// Only the writer's closed speaker vocabulary is metadata; other tags are content.
export const DONE_TAG = /^\[(OPERATOR|ASSISTANT|(?:RELAY|PEER|INJECT):[^\]]+|ATTACHMENT)\]\s*/;

// Bound each Stop delta and each rendered group; stored history stays intact.
export const DONE_LIMITS = Object.freeze({
  delta: 12,
  render: Object.freeze({ operator: Infinity, claims: 12 }),
  bytes: Object.freeze({ operator: 4096, claims: 4096 }),
});

export function doneRowGroup(key) {
  return DONE_TAG.exec(key)?.[1] === 'OPERATOR' ? 'operator' : 'claims';
}

const DONE_SPEAKER_PRIORITY = Object.freeze({ OPERATOR: 3, ASSISTANT: 2, RELAY: 1 });

export function doneRowPriority(key) {
  const speaker = DONE_TAG.exec(capsuleRowKey(key))?.[1].split(':')[0];
  return DONE_SPEAKER_PRIORITY[speaker] ?? 0;
}

// Locate an anchored body section once for readers and writers. Offsets refer
// to the full document; frontmatter anchors and headings never participate.
const ANCHOR_LINE = /(?:^|\r?\n)[ \t]*(<!-- swe:[a-z]+ -->)[ \t]*(?=\r?\n|$)/;
const SECTION_HEADINGS = new RegExp(HEADING_SCAN, 'g');
const SECTION_LINES = /^[^\r\n]+/gm;
const LEGACY_HEADING_PATTERNS = new Map(CAPSULE_SECTIONS.map(({ headingPattern, heading }) => [headingPattern, heading]));
function legacyHeading(pattern) {
  if (typeof pattern !== 'string') return pattern;
  if (!LEGACY_HEADING_PATTERNS.has(pattern)) LEGACY_HEADING_PATTERNS.set(pattern, new RegExp(pattern, 'i'));
  return LEGACY_HEADING_PATTERNS.get(pattern);
}
export function locateCapsuleSection(doc, anchor, fallbackHeading) {
  // Accept a format entry or key; retain arbitrary exact-line legacy anchors.
  const definition = typeof anchor === 'object' ? anchor : CAPSULE_SECTIONS.find((entry) => entry.key === anchor || entry.anchor === anchor);
  if (definition) {
    anchor = definition.anchor;
    fallbackHeading = definition.heading;
  } else fallbackHeading = legacyHeading(fallbackHeading);
  const bodyStart = documentBodyStart(doc);
  const body = doc.slice(bodyStart);
  const anchorLine = [...body.matchAll(SECTION_LINES)].find((match) => match[0].trim() === anchor);
  const anchorIndex = anchorLine ? anchorLine.index + anchorLine[0].indexOf(anchor) : -1;
  const headings = [...body.matchAll(SECTION_HEADINGS)];
  let heading = anchorIndex === -1
    ? headings.find((match) => match[1].length <= (definition?.maxDepth ?? 2) && fallbackHeading?.test(match[2].trim()))
    : headings.filter((match) => match.index < anchorIndex
      && (match[1].length <= (definition?.maxDepth ?? 2) || fallbackHeading?.test(match[2].trim()))).at(-1);
  if (heading && anchorIndex !== -1
    && ANCHOR_LINE.test(body.slice(heading.index + heading[0].length, anchorIndex))) {
    heading = undefined; // A preceding section's anchor already owns that heading.
  }
  if (anchorIndex === -1 && !heading) return null;
  const insertAt = anchorIndex === -1 ? null : anchorIndex + anchor.length;
  const boundaryHeading = heading || { index: insertAt, 0: '', 1: '##' };
  const start = boundaryHeading.index + boundaryHeading[0].length;
  // Nested headings stay inside their opener; explicit sections still own rows.
  const afterAnchor = insertAt ?? start;
  const nextAnchor = ANCHOR_LINE.exec(body.slice(afterAnchor));
  const nextHeading = headings.find((match) => match.index >= start && match[1].length <= boundaryHeading[1].length);
  const headingOffset = (match) => match ? match.index + match[0].indexOf('#') : body.length;
  const end = Math.min(headingOffset(nextHeading), nextAnchor
    ? afterAnchor + nextAnchor.index + (nextAnchor[0].startsWith('\r\n') ? 2 : nextAnchor[0].startsWith('\n') ? 1 : 0)
    : body.length);
  return {
    anchorAt: anchorIndex === -1 ? null : bodyStart + anchorIndex,
    hasHeading: !!heading,
    headingAt: heading ? bodyStart + heading.index + heading[0].indexOf('#') : null,
    start: bodyStart + start,
    end: bodyStart + end,
  };
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

// Decoded, single-line data for storage or further bounded rendering.
export function storedData(value, maximum = 240) {
  return JSON.parse(inert(value, maximum));
}

// Fixed field order keeps pipes inside quoted values from becoming metadata.
const EFFECT_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const EFFECT_ROW = new RegExp(`^- op (${EFFECT_STRING}) \\| kind (${EFFECT_STRING}) \\| target (${EFFECT_STRING}) \\| requested (${EFFECT_STRING}) \\| outcome: (requested|unknown|confirmed|failed) \\| id (${EFFECT_STRING}) \\| check (${EFFECT_STRING})$`);

export function parseSideEffectRow(row) {
  row = row.replace(/\r$/, '');
  const match = EFFECT_ROW.exec(row);
  if (!match || match[0].length !== row.length) return null;
  try {
    const [, op, kind, target, requested, outcome, id, check] = match;
    return { op: JSON.parse(op), kind: JSON.parse(kind), target: JSON.parse(target),
      requested: JSON.parse(requested), outcome, id: JSON.parse(id), check: JSON.parse(check) };
  } catch { return null; }
}

export function formatSideEffectRow(fields) {
  const q = JSON.stringify;
  return `- op ${q(fields.op)} | kind ${q(fields.kind)} | target ${q(fields.target)} | requested ${q(fields.requested)} | outcome: ${fields.outcome} | id ${q(fields.id)} | check ${q(fields.check)}`;
}

export const effectKey = (row) => parseSideEffectRow(row)?.op ?? row;

// Stored rows are chronological. Unresolved outcomes precede resolved outcomes;
// within each tier explicit kinds precede defaults, newest first in each group.
export function orderSideEffectRows(rows) {
  const priority = (row) => {
    // Collected entries retain provenance while using the same ordering as
    // stored string rows. Both inputs are chronological within each tier.
    const parsed = parseSideEffectRow(typeof row === 'string' ? row : row.row);
    const kind = parsed?.kind.replace(/^sidechain:/, '');
    const explicit = kind === 'shell' || kind === 'SendMessage' || classifyMcpEffect(kind) === 'write';
    return (['confirmed', 'failed'].includes(parsed?.outcome) ? 2 : 0) + (explicit ? 0 : 1);
  };
  return rows.map((row, index) => ({ row, index, priority: priority(row) }))
    .sort((a, b) => a.priority - b.priority || b.index - a.index)
    .map(({ row }) => row);
}

// The trust-boundary chokepoint (issue #43): every render of text that was
// PERSISTED rather than typed live this turn -- a vault note chunk, a
// skill-chain row, anything read off disk whose bytes an earlier turn or a
// different actor chose -- routes through this one function instead of a
// per-caller ad hoc render. Persisted text is not the current user's
// instruction, not the current session's identity, and carries no authority
// of its own; inert() above already proves the single-line/quoted/bounded
// render discipline sufficient for P1-P3, this just adds the provenance tag
// and disposition gate those callers were missing.
//
// disposition reuses namespace-registry.mjs's vocabulary directly (a chunk
// that survived that registry's INDEX filter passes its own disposition
// straight through); a caller with no namespace concept of its own (a
// P4-style skill-chain row) passes the generic 'ALLOW' explicitly -- there is
// NO default. Anything NOT in the allowed set refuses closed -- DENY, SKIP,
// an unrecognized string, and a missing/undefined value all refuse
// identically, because a disposition this function cannot positively confirm
// as safe is not safe to render. This is a second, independent gate: even if
// an upstream filter that already excludes DENY/SKIP content regresses (or
// simply never declared the row's namespace, which resolves to undefined,
// not DENY), a caller that still passes the row's real disposition through
// keeps the render itself closed.
const RENDERABLE_DISPOSITIONS = new Set(['ALLOW', 'INDEX']);

export function renderPersisted({
  path: sourcePath,
  text,
  role,
  trust = 'persisted-data',
  disposition,
  max = 500,
  now,
} = {}) {
  if (typeof text !== 'string') return { refused: 'non-string text' };
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) return { refused: 'missing path' };
  if (typeof role !== 'string' || role.trim().length === 0) return { refused: 'missing role' };
  // No default: a disposition this function never received is exactly the
  // "missing value" the allowlist below must refuse, not silently render.
  if (!RENDERABLE_DISPOSITIONS.has(disposition)) {
    return { refused: `disposition-not-allowed:${String(disposition).slice(0, 40)}` };
  }
  if (!Number.isInteger(max) || max < 1) return { refused: 'invalid max' };

  const acquiredAt = typeof now === 'string' && now.trim().length ? now : new Date().toISOString();
  // Date.parse() alone is not enough: it strips leading whitespace, and
  // ECMAScript whitespace includes line terminators, so a leading "\n" still
  // parses and would carry a raw line break into the tag below. The shape
  // check requires the whole string to already look like an ISO timestamp.
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(acquiredAt) || Number.isNaN(Date.parse(acquiredAt))) return { refused: 'invalid now' };
  // The hash covers the ORIGINAL text, not the bounded/quoted render below --
  // it identifies the content, independent of how far any one caller's `max`
  // happens to truncate it.
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  const record = { source: sourcePath, sha256, acquiredAt, trust, role, disposition, authority: 'none' };
  // Every interpolated field except sha256 (fixed hex charset) and acquiredAt
  // (already shape-checked above against /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/)
  // is persisted, caller- or attacker-influenceable data and goes through
  // inert() here -- the tag is the entire security product of this function;
  // an unquoted field in it can forge a second tag and blame it on a
  // different source (trust-boundary #43 review R1, finding F1/F8).
  const line = `[${inert(trust, 40)}:${inert(role, 40)} ${inert(sourcePath, 200)} sha ${sha256} @ ${acquiredAt}] ${inert(text, max)}`;
  return { line, record };
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
