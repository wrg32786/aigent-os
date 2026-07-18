#!/usr/bin/env node
// precompact-flush.mjs — zero-leak leg: PreCompact flush + capsule-ToC inject.
//
// Two jobs, right before the compactor runs:
//   1. FLUSH — run the stop-capsule-writer worker synchronously so the active
//      capsule carries this final turn's delta.
//   2. ToC INJECT — print the capsule's table-of-contents (~≤1500 tok) to stdout
//      so the compactor's summary carries POINTERS into the vault, not content.
//
// TIMEOUT BUDGET: the inner flush gets 6000ms. This is NOT slack — node
// cold-start on Windows is ~1.6s idle and worse under AV/disk load, so a
// too-tight inner timeout would spuriously classify a healthy-but-slow worker
// as failed. 6000ms inner + fast ToC read fits inside the ≥10000ms OUTER hook
// timeout (see .claude/settings.json.template and docs/zero-leak-flush.md).
//
// Concurrency: the flush runs the same worker as the Stop hook — the worker's
// per-session lock serializes them; a lock loss just means the Stop side is
// already flushing this turn.
//
// SOVEREIGNTY (fail-soft default): the capsule is best-effort autosave, never a
// gate — nothing here makes the operator wait on capsule machinery, so an
// OBSERVED flush failure WARNS loudly (ToC warning + error log) and compaction
// proceeds; the prompt journal backstops the window. Forks that want the strict
// zero-leak posture instead — compaction refuses to proceed over a capsule
// known to be stale — can opt in with LIFECYCLE_PRECOMPACT_STRICT=1, which
// turns an observed flush failure into decision:block + exit 2. Even in strict
// mode: benign outcomes never block, LIFECYCLE_KILL_STOP_WRITER=1 (the
// 'killed' class) is a deliberate override and does NOT block, and failures of
// this script ITSELF (outer catch) still exit 0 — block on observed flush
// failure, never on observer failure. Real failures append to
// <memRoot>/.daemon-errors.log.

import { readFileSync, existsSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seatOf, memRoot, logErr, readStdin } from './lifecycle-common.mjs';

const STOP_WRITER = join(dirname(fileURLToPath(import.meta.url)), 'stop-capsule-writer.mjs');

// Resolve the operator's active capsule from the ONE pointer at
// BODY_STATE.json's state.last_capsule (the same pointer the stop-capsule
// writer and the trusted writer stamp). Distinguishes "no pointer" from a
// DANGLING pointer (pointer set, file gone) — the latter is a real diagnostic
// signal.
function activeCapsule(root) {
  const MEM = memRoot(root);
  try {
    const cap = JSON.parse(readFileSync(path.join(MEM, 'BODY_STATE.json'), 'utf8'))?.state?.last_capsule ?? null;
    if (!cap?.path) return { path: null, dangling: false };
    const p = path.isAbsolute(cap.path) ? cap.path : path.join(root, cap.path);
    if (existsSync(p)) return { path: p, dangling: false };
    return { path: p, dangling: true };
  } catch {
    return { path: null, dangling: false };
  }
}

function frontmatterField(doc, field) {
  const m = doc.match(new RegExp(`^${field}: (.*)$`, 'm'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return m[1].trim(); }
}

function sectionContent(doc, heading) {
  const idx = doc.indexOf(`## ${heading}`);
  if (idx === -1) return '';
  const start = doc.indexOf('\n', idx) + 1;
  const end = doc.indexOf('\n## ', start);
  return doc.slice(start, end === -1 ? doc.length : end)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

try {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { /* non-JSON stdin */ }
  const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
  if (!root) {
    logErr('', 'precompact-flush', 'no root resolvable (no AIGENT_ROOT / CLAUDE_PROJECT_DIR / payload.cwd) — pre-compact flush skipped');
    process.exit(0);
  }
  const seat = seatOf(root); // single-operator default 'operator'; AIGENT_SEAT_ID override for forks

  // 1. FLUSH — synchronous, bounded well inside the outer hook budget.
  //    spawnSync does NOT throw on timeout/ENOENT — it reports on the result
  //    object. Exit-0 alone is NOT "flushed": no-transcript / no-delta /
  //    lock-defer all exit 0, and treating them as success would print a ToC
  //    that falsely claims the capsule is current. The worker emits a
  //    machine-readable SWE_OUTCOME line — parse it and surface each class
  //    distinctly.
  let flush = 'fail';
  let flushWhy = '';
  try {
    const res = spawnSync(process.execPath, [STOP_WRITER, '--worker', JSON.stringify({ ...payload, __root: root })], {
      timeout: 6000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const outcome = String(res.stdout || '').match(/SWE_OUTCOME:(\S+)/)?.[1] ?? null;
    if (res.error || res.status !== 0) {
      flushWhy = res.error?.code || res.error?.message || `exit=${res.status} signal=${res.signal}`;
      logErr(root, 'precompact-flush', `flush worker failed: ${flushWhy}`);
    } else if (outcome === 'flushed') {
      flush = 'flushed';
    } else if (outcome === 'noop:no-delta') {
      flush = 'current'; // Stop-side writer already carried this turn — good state, not a warning
    } else if (outcome === 'noop:lock-defer') {
      flush = 'deferred';
      logErr(root, 'precompact-flush', 'flush deferred: Stop-side writer held the session lock at compact time — capsule may lag one write');
    } else if (outcome === 'noop:killed') {
      flush = 'killed';
    } else if (outcome === 'noop:no-transcript' || outcome === 'noop:bad-payload') {
      // No delta was OBSERVABLE — possibly a platform quirk (PreCompact not
      // delivering transcript_path/session_id), not a failed write. Treating
      // every unobservable delta as a hard failure would cry wolf on every
      // affected compaction; the prompt journal holds the raw prompts either
      // way. WARN, never treat as fail.
      flush = 'unobserved';
      flushWhy = outcome;
      logErr(root, 'precompact-flush', `flush unobserved (${flushWhy}) — capsule may be stale; the prompt journal is the backstop`);
    } else {
      // error:* / exit 0 with no outcome signal — the worker itself failed.
      flushWhy = outcome ?? 'exit 0 with no outcome signal';
      logErr(root, 'precompact-flush', `flush FAILED (${flushWhy})`);
    }
  } catch (e) {
    flushWhy = e?.message || String(e);
    logErr(root, 'precompact-flush', `flush spawn threw: ${flushWhy}`);
  }

  // KILL-SWITCH ESCAPE: the worker honors the kill-switch, but ONLY if it
  // STARTS. If node can't spawn the worker at all (EMFILE/EAGAIN/AV-quarantine)
  // the outcome is 'fail', not 'killed'. Read the switch in THIS process's env
  // too: with it set, a flush 'fail' becomes 'killed' (the operator has
  // deliberately disabled the writer — never punish the absence of a thing
  // they turned off).
  if (flush === 'fail' && process.env.LIFECYCLE_KILL_STOP_WRITER === '1') flush = 'killed';

  // 1b. STRICT MODE ONLY (opt-in, see the sovereignty note in the header):
  //     only the fail class (worker crashed/timed out/no signal) blocks —
  //     flushed/current are healthy, deferred means the Stop-side writer is
  //     carrying this same delta (a retry lands as 'current'), unobserved is
  //     warn-only, killed is the deliberate override. Emission is writeSync
  //     (sync even on pipes: an async stream write can be truncated by
  //     process.exit on Windows) in its own try so a write failure can NEVER
  //     fall through the outer catch into exit(0) and silently un-block.
  if (flush === 'fail' && process.env.LIFECYCLE_PRECOMPACT_STRICT === '1') {
    // spawnSync surfaces a real timeout as res.error.code==='ETIMEDOUT', so
    // key the hint off it.
    const timeoutHint = /ETIMEDOUT/i.test(flushWhy)
      ? ' (timeout-kill: the capsule write is atomic and may still have landed — a retry that reads "already current" means it did)' : '';
    const reason = `pre-compact capsule flush FAILED (${flushWhy})${timeoutHint} — compaction blocked (strict mode) so it can never `
      + `proceed over an unflushed capsule. Finish the turn and retry /compact; if this persists check `
      + `<memRoot>/.daemon-errors.log. Emergency override: LIFECYCLE_KILL_STOP_WRITER=1, or unset LIFECYCLE_PRECOMPACT_STRICT.`;
    try { writeSync(1, JSON.stringify({ decision: 'block', reason })); } catch { /* exit code still blocks */ }
    try { writeSync(2, reason + '\n'); } catch { /* ditto */ }
    process.exit(2);
  }

  // 2. ToC INJECT.
  const cap = activeCapsule(root);
  const out = [];
  if (flush === 'flushed') {
    out.push(`[PRECOMPACT:capsule-toc] flush OK — the capsule below carries the final pre-compact turn.`);
  } else if (flush === 'current') {
    out.push(`[PRECOMPACT:capsule-toc] no new delta since the last turn write — the capsule below is already current.`);
  } else if (flush === 'deferred') {
    out.push(`[PRECOMPACT:capsule-toc] NOTE: a concurrent Stop-side write held the lock — the capsule below may lag the final turn by one write.`);
  } else if (flush === 'killed') {
    out.push(`[PRECOMPACT:capsule-toc] NOTE: capsule writer disabled (LIFECYCLE_KILL_STOP_WRITER) — staleness unknown; treat the capsule below as last-known-good.`);
  } else if (flush === 'unobserved') {
    out.push(`[PRECOMPACT:capsule-toc] WARNING: pre-compact flush had nothing observable to flush (${flushWhy}) — the capsule below may be stale by one or more turns; the utterance journal holds the raw prompts.`);
  } else if (flush === 'fail') {
    out.push(`[PRECOMPACT:capsule-toc] WARNING: pre-compact capsule flush FAILED (${flushWhy}) — the capsule below may be stale; the utterance journal holds the raw prompts. Check <memRoot>/.daemon-errors.log if this persists.`);
  }
  if (cap.path && !cap.dangling) {
    const doc = readFileSync(cap.path, 'utf8');
    const rel = path.relative(root, cap.path).replace(/\\/g, '/');
    out.push(`[PRECOMPACT:capsule-toc] ${seat} — active capsule survives this compaction at ${rel}`);
    out.push(`> [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.`);
    const obj = frontmatterField(doc, 'objective');
    const next = frontmatterField(doc, 'next_valid_action');
    const waiting = frontmatterField(doc, 'waiting_on');
    if (obj) out.push(`objective: ${obj}`);
    if (next) out.push(`next_valid_action: ${next}`);
    if (waiting && waiting !== 'null') out.push(`waiting_on: ${waiting}`);
    const gates = sectionContent(doc, 'Pending-Gates');
    if (gates) out.push(`Pending-Gates (MUST survive refresh):\n${gates.slice(0, 1200)}`);
    out.push(`Sections on disk (pull on demand, never from memory): ` +
      ['Done (don\'t redo)', 'Historical-Errors → Resolutions', 'Historical-Rejected-Approaches',
        'Files-Read / Files-Modified', 'Operating-Facts', 'Pending-Gates', 'Claimed-Rows']
        .map((s) => `${rel}#${s}`).join(' · '));
  } else if (cap.dangling) {
    logErr(root, 'precompact-flush', `DANGLING capsule pointer: ${cap.path} is gone (something deleted it under an active pointer)`);
    out.push(`[PRECOMPACT:capsule-toc] ${seat} — WARNING: the active-capsule pointer targets ${cap.path} which NO LONGER EXISTS (deleted externally). Resume from the latest session log + live memory after this compaction.`);
  } else {
    out.push(`[PRECOMPACT:capsule-toc] ${seat} — no active capsule on disk; resume from the latest`
      + ` session log + live memory after this compaction. Run /resume if orientation is thin.`);
  }
  // writeSync (not stdout.write): the ToC is the compactor's re-grounding
  // pointer; an async write truncated by the imminent process.exit (the same
  // Windows pitfall the strict-mode block path avoids) would silently drop it.
  try { writeSync(1, out.join('\n').slice(0, 6000) + '\n'); } catch { /* nothing more to do at exit */ }
} catch (e) {
  logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', 'precompact-flush', `outer: ${e?.stack || e}`);
}
process.exit(0);
