#!/usr/bin/env node
// sessionstart-reinject.mjs — warm-start reinject + resume-verb carrier (SessionStart hook).
//
// Fires on every SessionStart source (startup | resume | clear | compact).
// One carrier keeps warm orientation and post-clear resume ordering consistent.
//
// On source=clear, this is the SINGLE carrier for the resume verb: it calls
// runResumeVerb() (resume-verb.mjs) directly and prints its procedure text, then
// exits. Any settings.json that still names resume-verb.mjs itself as a redundant
// SessionStart(clear) hook gets a no-op from that file — see resume-verb.mjs's
// header for why direct execution intentionally emits nothing.
//
// On every other source, prints:
//   1. CLOCK line — ground the waking session in real day/time before any orientation.
//   2. identity line — <vault root>/identity-core.md if present, else a fallback.
//   3. NEWEST ACTIVE CAPSULE — the valid capsule with the newest frontmatter
//      created_at, via lifecycle-common.mjs's newestValidCapsule(). NEVER full
//      content, and never a pointer — resume selection has exactly one authority.
//   4. top-N heat-ranked wikilinks from HEAT_INDEX.json (token-budgeted)
//   5. the latest SESSION_LOG.md heading, as a cold-start seed
//
// COORDINATION GUARD (pluggable, optional): if a fork wires a multi-agent
// coordination layer, point AIGENT_COORDINATION_STATE at a JSON file carrying a
// `phase` field; a non-terminal phase means a conducted cycle is live and this
// hook defers to it (including on a clear — the conductor owns that lifecycle
// too), injecting only a pointer at the conductor. Unset by default — no
// coordination layer ships in the box.
//
// INVARIANT: never break session start — any error exits 0; real failures append
// to <memRoot>/.daemon-errors.log.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import {
  capsuleValue,
  inert,
  memRoot as resolveMemRoot,
  newestValidCapsule,
  unsafeRawCapsuleDocument,
  unsafeRawMemoryDocument,
} from './lifecycle-common.mjs';
import { formatNightlyBootAlerts } from './nightly-alerts.mjs';
import { runNightlyWatchdog } from './nightly-watchdog.mjs';
import { runResumeVerb } from './resume-verb.mjs';
import { FRAMING_LINES } from './memory-hygiene/resume-framing.mjs';

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
      `${new Date().toISOString()} tag="sessionstart-reinject" message=${inert(msg, 1000)}\n`);
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

try {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { /* non-JSON */ }
  const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
  if (!root) process.exit(0);
  const source = String(payload.source || 'startup');
  const renderedSource = inert(source, 80);

  // CLOCK — ground the waking session in real day/time BEFORE any orientation. A
  // bare wake fires no UserPromptSubmit, so a prompt-time clock injection can't
  // cover it — this is the SessionStart half of "the session always knows the
  // date." Unconditional, first, before the coordination-guard branch.
  process.stdout.write(`[CLOCK] ${new Date().toString()}\n`);

  // SessionStart is the durable fallback when no scheduler is installed: it
  // re-derives watchdog status, persists a named alert, delivers it on stderr,
  // and then surfaces active alerts in the hook payload. Alert deduplication
  // prevents repeated starts from flooding the ledger. Keep the entire path
  // isolated so a missing, malformed, or unreadable ledger can never suppress
  // post-clear recovery.
  try {
    await runNightlyWatchdog({
      root,
      deliver: true,
      persist: true,
    });
    const nightlyAlerts = formatNightlyBootAlerts(root);
    if (nightlyAlerts.length) process.stdout.write(nightlyAlerts.join('\n') + '\n');
  } catch (error) {
    const detail = inert(error?.message || error, 300);
    logErr(root, `nightly watchdog/alert read failed: ${detail}`);
    process.stderr.write(`[NIGHTLY-ALERT: ALERT_SURFACE_FAILED] ${detail}\n`);
    process.stdout.write(
      '[NIGHTLY-ALERT: ALERT_SURFACE_FAILED] Nightly alert ledger/watchdog state '
      + 'could not be read; '
      + 'see vault/memory/.daemon-errors.log.\n',
    );
  }

  // A live coordination cycle (if a fork wires one) owns the lifecycle — including
  // across a clear, so this check runs before the source==='clear' branch below.
  if (coordinationActive()) {
    process.stdout.write(`[SESSIONSTART:reinject] session (${renderedSource}) — a coordinated multi-agent cycle is LIVE. `
      + `Follow its conductor; control legs run FULLY. Warm-start orientation deferred until the cycle closes.\n`);
    process.exit(0);
  }

  // Post-clear boot: the resume verb is the entire payload. runResumeVerb() loads
  // the newest valid capsule and emits the full load → re-ground → ACT → ACK
  // procedure; nothing else in this file runs for this source.
  if (source === 'clear') {
    const result = runResumeVerb({ projectRoot: root, source, sessionId: payload.session_id });
    process.stdout.write(result.prompt + '\n');
    process.exit(0);
  }

  const out = [];
  const MEM = memRoot(root);

  // Identity line — an optional <vault root>/identity-core.md, else a fallback.
  const corePath = [path.join(path.dirname(MEM), 'identity-core.md'), path.join(root, 'identity-core.md')]
    .find((p) => existsSync(p));
  if (corePath) {
    // AUDIT: identity-core is operator-authored instruction text by design, not
    // a data field. Its complete authored structure is the feature being loaded.
    out.push(unsafeRawMemoryDocument(
      corePath,
      'identity-core is operator-authored procedure text whose multiline structure is intentional',
    ).trim());
  } else {
    out.push(`[SESSIONSTART:reinject] session (${renderedSource}).`);
  }

  // NEWEST ACTIVE CAPSULE — the same selector resume-verb.mjs uses; no pointer.
  const newest = newestValidCapsule(MEM);
  if (newest) {
    try {
      const doc = unsafeRawCapsuleDocument(
        newest.path,
        'warm orientation reads the selected capsule before returning only shared-reader values',
      );
      const rel = path.relative(root, newest.path).replace(/\\/g, '/');
      const obj = capsuleValue(doc, 'objective');
      const next = capsuleValue(doc, 'next_valid_action');
      const waiting = capsuleValue(doc, 'waiting_on');
      out.push('');
      out.push(`🔁 NEWEST ACTIVE CAPSULE (created_at) — pull sections on demand, never assume: ${inert(rel)}`);
      out.push(`> [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.`);
      // Per-field budget: this is a POINTER, not the capsule body — bound each
      // field so a verbose capsule can't bloat every session-start payload; the
      // full text stays on disk.
      if (obj) out.push(`   objective: ${inert(obj, 240)}`);
      if (next) out.push(`   next_valid_action: ${inert(next, 400)}`);
      if (waiting && waiting !== 'null') out.push(`   waiting_on: ${inert(waiting, 200)}`);
      out.push(`   sections: Done (don't redo) · Historical-Errors → Resolutions · Historical-Rejected-Approaches · Files-Read / Files-Modified · Operating-Facts · Pending-Gates · Claimed-Rows`);
      out.push(`   Pending-Gates + Claimed-Rows are LIVE classes — re-verify each against memory before resuming them.`);
      // Named rulings, not a mood. "Reference only" tells a reader what the
      // document is; these tell it what to DO when the document and the live
      // state disagree, which is the moment the framing actually gets tested.
      for (const line of FRAMING_LINES) out.push(`   ${line}`);
    } catch (e) {
      logErr(root, `newest capsule unreadable: ${e?.message || e}`);
      out.push('');
      out.push(`⚠ Newest capsule became unreadable (logged). Orient from the latest session log; run /open for full orientation.`);
    }
  } else {
    out.push('');
    out.push(`No valid active capsule. Run /open to orient.`);
  }

  // Heat-ranked wikilinks (token-budgeted: names only).
  try {
    const heat = JSON.parse(readFileSync(path.join(MEM, 'HEAT_INDEX.json'), 'utf8'));
    const top = (heat.hot_top_20 ?? heat.hot ?? []).slice(0, TOP_LINKS)
      .map((e) => (typeof e === 'string' ? e : e.name ?? e.note ?? e.path)).filter(Boolean);
    if (top.length) out.push(`Hot notes (quoted paths): ${top.map((n) => inert(n, 160)).join(' · ')}`);
  } catch { /* no heat index yet — fine */ }

  // Latest session-log hint: first meaningful heading after the title.
  try {
    const lines = unsafeRawMemoryDocument(
      path.join(MEM, 'SESSION_LOG.md'),
      'session-log orientation selects one heading and renders it through inert',
    ).split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith('## ') || t.startsWith('### ')) {
        out.push(`Last session-log entry: ${inert(t.replace(/^#+\s*/, ''), 160)}`);
        break;
      }
    }
  } catch { /* no session log yet — fine */ }

  process.stdout.write(out.join('\n').slice(0, 8000) + '\n');
} catch (e) {
  logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', `outer: ${e?.stack || e}`);
}
process.exit(0);
