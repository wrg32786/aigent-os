#!/usr/bin/env node
// sessionstart-reinject.mjs — warm-start reinject + resume-verb carrier (SessionStart hook).
//
// Fires on every SessionStart source (startup | resume | clear | compact) — a
// single hook for a single operator. (The private origin of this port ran two
// separate scripts because its multi-agent SessionStart matchers were wired
// per-agent; that split doesn't apply to a single-operator install, so it is
// merged into this one file — see docs/two-verb-lifecycle.md for the note.)
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
import { memRoot as resolveMemRoot, newestValidCapsule } from './lifecycle-common.mjs';
import { runResumeVerb } from './resume-verb.mjs';

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

function frontmatterScalar(doc, field) {
  const fm = String(doc).match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
  if (!fm) return null;
  const match = fm.match(new RegExp(`^${field}:[ \\t]*(.*)$`, 'm'));
  if (!match) return null;
  const value = match[1].trim();
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') return parsed;
  } catch { /* raw scalar */ }
  return value.replace(/^['"]|['"]$/g, '');
}

// ── EVER-623 port: canonical fleet-rules injection (env-gated) ────────────────
// Gate is byte-identical to the fleet-port original: AIGENT_FLEET_RULES_INJECT
// must be EXACTLY '1' (explicit opt-in); unset/'0'/anything else skips the block
// entirely — output byte-identical to pre-EVER-623. KILL-SWITCH: flip the env to
// 0/unset OR revert this commit; next SessionStart picks either up.
// SOURCE FILE: AIGENT_FLEET_RULES_PATH — this repo ships no doctrine of its own,
// so the install's hook command names the canonical file (a fleet install points
// it at its committed doctrine copy). Armed gate + unset/unreadable path is a
// LOUD logErr, never a silent skip: the operator armed a gate that would
// otherwise inject nothing — exactly the silently-dark failure the gate exists
// to prevent.
// TRUNCATION GUARD: a doctrine block ending mid-sentence still reads as complete
// (the artifact-asserting-an-unearned-state class) — if the full text won't fit
// the budget this fire, inject the POINTER line instead, never a truncated copy.
function fleetRulesBlock(root, soFar, cap = 7800) {
  if (process.env.AIGENT_FLEET_RULES_INJECT !== '1') return null;
  const src = process.env.AIGENT_FLEET_RULES_PATH || '';
  try {
    if (!src) throw new Error('AIGENT_FLEET_RULES_INJECT=1 but AIGENT_FLEET_RULES_PATH is unset');
    const frText = readFileSync(src, 'utf8').trim();
    if (soFar + frText.length + 2 <= cap) return { text: frText, ref: 'full' };
    return {
      text: `📜 FLEET_RULES (canonical cross-seat doctrine — too large to inject this fire): read ${src} before acting on any clear/save/restart/T1/escalation question.`,
      ref: 'pointer',
    };
  } catch (e) {
    logErr(root, `[EVER-623] FLEET_RULES injection failed (non-fatal): ${e?.message || e}`);
    return null;
  }
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

  // A live coordination cycle (if a fork wires one) owns the lifecycle — including
  // across a clear, so this check runs before the source==='clear' branch below.
  if (coordinationActive()) {
    process.stdout.write(`[SESSIONSTART:reinject] session (${source}) — a coordinated multi-agent cycle is LIVE. `
      + `Follow its conductor; control legs run FULLY. Warm-start orientation deferred until the cycle closes.\n`);
    process.exit(0);
  }

  // Post-clear boot: the resume verb is the entire payload. runResumeVerb() loads
  // the newest valid capsule and emits the full load → re-ground → ACT → ACK
  // procedure; nothing else in this file runs for this source.
  if (source === 'clear') {
    const result = runResumeVerb({ projectRoot: root, source, sessionId: payload.session_id });
    // EVER-623: doctrine rides post-clear boots too — a fresh context is exactly
    // when the fleet rules must be present, so the block appends to the resume
    // procedure under the same gate/budget as the warm-start path.
    let prompt = result.prompt;
    const frClear = fleetRulesBlock(root, prompt.length);
    if (frClear) prompt += '\n\n' + frClear.text;
    process.stdout.write(prompt + '\n');
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

  // NEWEST ACTIVE CAPSULE — the same selector resume-verb.mjs uses; no pointer.
  const newest = newestValidCapsule(MEM);
  if (newest) {
    try {
      const doc = readFileSync(newest.path, 'utf8');
      const rel = path.relative(root, newest.path).replace(/\\/g, '/');
      const obj = frontmatterScalar(doc, 'objective');
      const next = frontmatterScalar(doc, 'next_valid_action');
      const waiting = frontmatterScalar(doc, 'waiting_on');
      out.push('');
      out.push(`🔁 NEWEST ACTIVE CAPSULE (created_at) — pull sections on demand, never assume: ${rel}`);
      out.push(`> [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.`);
      // Per-field budget: this is a POINTER, not the capsule body — bound each
      // field so a verbose capsule can't bloat every session-start payload; the
      // full text stays on disk.
      const budget = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + '… [full in capsule]' : s; };
      if (obj) out.push(`   objective: ${budget(obj, 240)}`);
      if (next) out.push(`   next_valid_action: ${budget(next, 400)}`);
      if (waiting && waiting !== 'null') out.push(`   waiting_on: ${budget(waiting, 200)}`);
      out.push(`   sections: Done (don't redo) · Historical-Errors → Resolutions · Historical-Rejected-Approaches · Files-Read / Files-Modified · Operating-Facts · Pending-Gates · Claimed-Rows`);
      out.push(`   Pending-Gates + Claimed-Rows are LIVE classes — re-verify each against memory before resuming them.`);
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

  // EVER-623: fleet-rules block last, under the same 8000-char final cap — the
  // 7800 budget inside fleetRulesBlock keeps the full-text branch clear of the
  // slice below, so a truncated doctrine copy is unrepresentable here.
  const fr = fleetRulesBlock(root, out.join('\n').length);
  if (fr) { out.push(''); out.push(fr.text); }

  process.stdout.write(out.join('\n').slice(0, 8000) + '\n');
} catch (e) {
  logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', `outer: ${e?.stack || e}`);
}
process.exit(0);
