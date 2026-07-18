#!/usr/bin/env node
// sessionstart-reinject.mjs — warm-start pointer-table reinject (SessionStart hook).
//
// Fires on every SessionStart source (startup | resume | clear | compact) — a
// single hook for a single operator. (The private origin of this port ran two
// separate scripts because its multi-agent SessionStart matchers were wired
// per-agent; that split doesn't apply to a single-operator install, so it is
// merged into this one file — see docs/two-verb-lifecycle.md for the note.)
// Prints, in order:
//   1. CLOCK line — ground the waking session in real day/time before any orientation.
//   2. identity line — <vault root>/identity-core.md if present, else a fallback.
//   3. active-capsule POINTER TABLE — id / objective / next_valid_action /
//      waiting_on + exact section pointers. NEVER full content.
//   4. top-N heat-ranked wikilinks from HEAT_INDEX.json (token-budgeted)
//   5. the latest SESSION_LOG.md heading, as a cold-start seed
//
// CLEAR-BARRIER: on source=clear, verify the JUST-CLEARED session ended with a
// curated close. /clear itself cannot be pre-blocked at the hook layer
// (SessionStart fires after; SessionEnd cannot block), so this makes the failure
// DETERMINISTIC instead of recoverable-by-luck: it names the violated precondition
// and pins the mandatory recovery (the rolling auto-capsule the stop-writer
// guarantees) as the REQUIRED first action.
//
// COORDINATION GUARD (pluggable, optional): if a fork wires a multi-agent
// coordination layer, point AIGENT_COORDINATION_STATE at a JSON file carrying a
// `phase` field; a non-terminal phase means a conducted cycle is live and this
// hook defers to it, injecting only a pointer at the conductor. Unset by default —
// no coordination layer ships in the box.
//
// STALE-FINALIZE-LOCK RELEASE: anchoring on startup/resume/clear IS the resume —
// flip the capsule's frontmatter status active→resumed so the stop-writer's
// finalize-guard actually releases and rolling repoints re-arm for this session.
// Compact is NOT a resume (mid-cycle flip would disarm an auto-refresh watcher's
// capsule-ready gate, if one is wired) — excluded.
//
// INVARIANT: never break session start — any error exits 0; real failures append
// to <memRoot>/.daemon-errors.log.

import { readFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { memRoot as resolveMemRoot, flipCapsuleToResumed } from './lifecycle-common.mjs';

const TOP_LINKS = 5;

function memRoot(root) {
  return resolveMemRoot(root);
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function logErr(root, msg) {
  try {
    appendFileSync(path.join(memRoot(String(root)), '.daemon-errors.log'),
      `${new Date().toISOString()} [sessionstart-reinject] ${msg}\n`);
  } catch { /* truly nowhere to log */ }
}

// Pluggable coordination guard — see header. Absence of the env var (the default)
// means no coordination layer is wired, so this always returns false.
function coordinationActive() {
  const statePath = process.env.AIGENT_COORDINATION_STATE;
  if (!statePath) return false;
  try {
    const raw = readFileSync(statePath, 'utf8');
    // Regex on raw text (never JSON.parse): a mid-write partial file must not
    // throw, and an ambiguous read defaults to "live" — the safe direction.
    return !/"phase"\s*:\s*"(done|cancelled|canceled|closed|complete|aborted)"/i.test(raw);
  } catch {
    return false;
  }
}

// Distinguishes "no pointer" from a DANGLING pointer.
function activeCapsule(root) {
  const MEM = memRoot(root);
  try {
    const bs = JSON.parse(readFileSync(path.join(MEM, 'BODY_STATE.json'), 'utf8'));
    const c = bs?.state?.last_capsule;
    const cap = c && c.status === 'active' ? c : null;
    if (!cap?.path) return { path: null, dangling: false };
    const p = path.isAbsolute(cap.path) ? cap.path : path.join(root, cap.path);
    if (existsSync(p)) return { path: p, dangling: false };
    return { path: p, dangling: true };
  } catch {
    return { path: null, dangling: false };
  }
}

function fm(doc, field) {
  const m = doc.match(new RegExp(`^${field}: (.*)$`, 'm'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return m[1].trim(); }
}

// CLEAR-BARRIER (enforcement-of-last-resort layer): on source=clear, verify the
// JUST-CLEARED session ended with a curated close — pointer trigger=curated-close
// (manual-close = legacy spelling), session_id = the cleared session, finalized_at
// present. Cleared-session id = newest stop-writer state file that is NOT the new
// session (the stop-writer touches <sid>.json every turn, so mtime order is
// reliable). Returns null when the invariant holds or nothing is resolvable
// (fresh install).
function clearBarrier(root, newSid) {
  const MEM = memRoot(root);

  let prevSid = null;
  let rollingCapsule = null;
  try {
    const dir = path.join(MEM, 'runtime', 'stop-writer');
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && path.basename(f, '.json') !== newSid)
      .map((f) => ({ sid: path.basename(f, '.json'), full: path.join(dir, f), m: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (newest) {
      prevSid = newest.sid;
      try { rollingCapsule = JSON.parse(readFileSync(newest.full, 'utf8'))?.capsule_path || null; } catch { /* state torn */ }
    }
  } catch { /* no stop-writer dir — nothing to guard */ }
  if (!prevSid) return null; // fresh install / no prior session: invariant vacuously holds

  let cur = null;
  try {
    cur = JSON.parse(readFileSync(path.join(MEM, 'BODY_STATE.json'), 'utf8'))?.state?.last_capsule ?? null;
  } catch { /* unreadable pointer = violation, reported below */ }

  const missing = [];
  if (!cur) missing.push('pointer unreadable/absent');
  else {
    if (cur.trigger !== 'curated-close' && cur.trigger !== 'manual-close') missing.push(`pointer trigger is '${cur.trigger ?? 'unset'}' (need curated-close)`);
    if (String(cur.session_id || '') !== prevSid) missing.push(`pointer session_id '${cur.session_id ?? 'unset'}' != cleared session '${prevSid.slice(0, 8)}…'`);
    if (!Number.isFinite(Date.parse(String(cur.finalized_at || '')))) missing.push('finalized_at absent/unparseable');
  }
  if (missing.length === 0) return { ok: true, id: cur.id };

  logErr(root, `CLEAR-BARRIER VIOLATED: session ${prevSid} cleared without curated close — ${missing.join('; ')}`);
  return { ok: false, prevSid, missing, rollingCapsule: rollingCapsule ? path.relative(root, rollingCapsule).replace(/\\/g, '/') : null };
}

try {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { /* non-JSON */ }
  const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
  if (!root) process.exit(0);
  const source = String(payload.source || 'startup');

  // CLOCK — ground the waking session in real day/time BEFORE any orientation. A
  // bare wake fires no UserPromptSubmit, so a prompt-time clock injection can't
  // cover it — this is the SessionStart half of "the session always knows the
  // date." Unconditional, first, before the coordination-guard branch.
  process.stdout.write(`[CLOCK] ${new Date().toString()}\n`);

  // CLEAR-BARRIER: fires on every clear, INCLUDING during a live coordination
  // cycle (a conducted clear-without-close is exactly the no-capsule-no-clear
  // violation — surface it, never swallow it).
  if (source === 'clear') {
    const barrier = clearBarrier(root, String(payload.session_id || ''));
    if (barrier && !barrier.ok) {
      process.stdout.write(
        `⛔ CLEAR-BARRIER VIOLATED: session ${barrier.prevSid.slice(0, 8)}… was cleared WITHOUT a curated close.\n`
        + `   Missing precondition(s): ${barrier.missing.join('; ')}.\n`
        + `   REQUIRED FIRST ACTION (deterministic recovery, not optional): its rolling auto-capsule is intact`
        + (barrier.rollingCapsule ? ` at ${barrier.rollingCapsule}` : ' (path in memory/runtime/stop-writer/)')
        + ` — reconstruct from it + git, write the curated close capsule, stamp the pointer via`
        + ` daemons/curated-close-pointer.mjs, THEN start new work.\n`
        + `   Do NOT trust the pointer table below as a resume anchor — it may be stale or rolling.\n`,
      );
    } else if (barrier && barrier.ok) {
      process.stdout.write(`[clear-barrier] PASS — curated close '${barrier.id}' anchors the cleared session.\n`);
    }
  }

  // A live coordination cycle (if a fork wires one) owns the lifecycle → drill
  // pointer only.
  if (coordinationActive()) {
    process.stdout.write(`[SESSIONSTART:reinject] session (${source}) — a coordinated multi-agent cycle is LIVE. `
      + `Follow its conductor; control legs run FULLY. Warm-start orientation deferred until the cycle closes.\n`);
    process.exit(0);
  }

  const out = [];
  const MEM = memRoot(root);

  // Identity line — an optional <vault root>/identity-core.md, else a fallback.
  const corePath = [path.join(path.dirname(MEM), 'identity-core.md'), path.join(root, 'identity-core.md')]
    .find((p) => existsSync(p));
  if (corePath) {
    out.push(readFileSync(corePath, 'utf8').trim());
  } else {
    out.push(`[SESSIONSTART:reinject] session (${source}).`);
  }

  // Active-capsule pointer table + early constraints.
  const cap = activeCapsule(root);
  if (cap.path && !cap.dangling) {
    const doc = readFileSync(cap.path, 'utf8');
    const rel = path.relative(root, cap.path).replace(/\\/g, '/');
    const obj = fm(doc, 'objective');
    const next = fm(doc, 'next_valid_action');
    const waiting = fm(doc, 'waiting_on');
    const hash = fm(doc, 'definition_hash');
    out.push('');
    out.push(`🔁 ACTIVE CAPSULE (pointer table — pull sections on demand, never assume): ${rel}`);
    out.push(`> [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.`);
    // Per-field budget: the pointer table is a POINTER — "pull sections on
    // demand" — not the capsule body. Bound each field so a verbose capsule
    // can't bloat every session-start payload; the full text stays on disk.
    const budget = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + '… [full in capsule]' : s; };
    if (obj) out.push(`   objective: ${budget(obj, 240)}`);
    if (next) out.push(`   next_valid_action: ${budget(next, 400)}`);
    if (waiting && waiting !== 'null') out.push(`   waiting_on: ${budget(waiting, 200)}`);
    if (hash) out.push(`   definition_hash: ${hash} — re-validate against the live capsule frontmatter before acting; mismatch = drifted, re-derive from memory.`);
    out.push(`   sections: Done (don't redo) · Historical-Errors → Resolutions · Historical-Rejected-Approaches · Files-Read / Files-Modified · Operating-Facts · Pending-Gates · Claimed-Rows`);
    out.push(`   Pending-Gates + Claimed-Rows are LIVE classes — re-verify each against memory before resuming them.`);

    // STALE-FINALIZE-LOCK RELEASE: anchoring IS the resume — flip the capsule's
    // frontmatter status active→resumed so the stop-writer's finalize-guard
    // releases and rolling repoints resume for this session. A capsule never
    // marked resumed would suppress repoints across every subsequent session.
    // Compact is NOT a resume — the same session continues, and flipping
    // mid-cycle would disarm an auto-refresh watcher's capsule-ready gate — so
    // startup/resume/clear only.
    if (source !== 'compact') {
      const result = flipCapsuleToResumed(cap.path, payload.session_id);
      if (result.outcome === 'flipped') {
        out.push(`   [resume-flip] capsule marked resumed — finalize-lock released, rolling repoints re-armed.`);
      } else if (result.outcome === 'steady_state') {
        // Already resumed (e.g. a zero-turn restart observing its own earlier
        // flip) — not drift, not an error, nothing to say.
      } else if (result.outcome === 'dangling') {
        // Should be unreachable here (activeCapsule() already gated on
        // !cap.dangling above), but a TOCTOU window between that check and this
        // call is real.
        logErr(root, `resume-flip: capsule unreadable at ${cap.path}: ${result.detail}`);
      } else if (result.outcome === 'drift') {
        logErr(root, `resume-flip skipped for ${cap.path}: ${result.detail}`);
      } else {
        logErr(root, `resume-flip failed for ${cap.path}: ${result.detail}`);
      }
    }
  } else if (cap.dangling) {
    logErr(root, `DANGLING capsule pointer: ${cap.path} is gone (deleted under an active pointer)`);
    out.push('');
    out.push(`⚠ Active-capsule pointer targets ${cap.path} which no longer exists (deleted externally — a real signal, logged). Orient from the latest session log; run /open for full orientation.`);
  } else {
    out.push('');
    out.push(`No active capsule. Run /open to orient.`);
  }

  // Heat-ranked wikilinks (token-budgeted: names only).
  try {
    const heat = JSON.parse(readFileSync(path.join(MEM, 'HEAT_INDEX.json'), 'utf8'));
    const top = (heat.hot_top_20 ?? heat.hot ?? []).slice(0, TOP_LINKS)
      .map((e) => (typeof e === 'string' ? e : e.name ?? e.note ?? e.path)).filter(Boolean);
    if (top.length) out.push(`Hot notes: ${top.map((n) => `[[${n}]]`).join(' · ')}`);
  } catch { /* no heat index yet — fine */ }

  // Latest session-log hint (folds in the private origin's separate cold-start
  // seed): first meaningful heading in SESSION_LOG.md after the title.
  try {
    const lines = readFileSync(path.join(MEM, 'SESSION_LOG.md'), 'utf8').split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith('## ') || t.startsWith('### ')) {
        out.push(`Last session-log entry: ${t.replace(/^#+\s*/, '').slice(0, 160)}`);
        break;
      }
    }
  } catch { /* no session log yet — fine */ }

  process.stdout.write(out.join('\n').slice(0, 8000) + '\n');
} catch (e) {
  logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', `outer: ${e?.stack || e}`);
}
process.exit(0);
