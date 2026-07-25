#!/usr/bin/env node
// discipline-check.mjs -- Stop hook: the trigger that feeds the measurement ledgers.
//
// aigent-OS ships three measurement ledgers (vault/memory/HONESTY_LEDGER.md,
// TRUST_DECAY.md, FAILURE_MODES.md) and three skills that write them on demand
// (/honesty-check, /trust-decay, /diagnose). Nothing ever ASKS for a write, so on
// a fresh install all three stay empty forever. A measurement layer with no writer
// is worse than no measurement layer: the files exist, so it looks like it works.
//
// This hook is the missing writer trigger. At the end of a turn it counts unhedged
// confident-verb claims ("fixed", "verified", "shipped", ...) in the assistant's own
// last message. Past a threshold, with no ledger written recently, it prints ONE
// advisory line naming the skills that would capture them. The claim is measured
// where it is actually made -- in the turn's own words -- instead of relying on the
// operator to remember to run a skill after the fact.
//
// ADVISORY, and deliberately so (same suggest-don't-block doctrine as
// model-tier-guard.mjs, see vault/concepts/Suggestion Credibility.md): it never
// blocks the turn and never writes a ledger itself -- the skills own their entry
// formats, and a hook that guessed at an entry would poison the record it exists
// to protect.
//
// PRIVACY: the nudge carries a COUNT, never content. The scanned message is never
// echoed, logged, or persisted -- same discipline as hooks/tool-tracker.js.
//
// Tuning (all optional):
//   AIGENT_DISCIPLINE_CHECK=off   disable entirely
//   AIGENT_DISCIPLINE_THRESHOLD   claims needed to nudge (default 3)
//   AIGENT_DISCIPLINE_QUIET       seconds since the newest ledger write (default 300)
// INVARIANT: fail open -- any error exits 0, never breaks a turn. Real failures
// append to <memRoot>/.daemon-errors.log.

import { statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { memRoot as resolveMemRoot, readStdin, logErr } from './lifecycle-common.mjs';

// The three ledgers a confident claim could belong in. Any write to any of them
// counts as "the record was tended recently".
export const LEDGERS = ['HONESTY_LEDGER.md', 'TRUST_DECAY.md', 'FAILURE_MODES.md'];

// The verbs a claim is made WITH. Unhedged and consequential when they appear about
// one's own work: each asserts a verified end state the operator will act on.
const CONFIDENT_VERBS = /\b(?:fixed|verified|tested|deployed|complete|shipped|ready|merged|passing|works)\b/gi;

const DEFAULT_THRESHOLD = 3;
const DEFAULT_QUIET_SECONDS = 300;
const SCAN_LIMIT = 8000;

// Code is exempt, for the same reason the repo's own em-dash guard exempts it: a
// `works` inside a pasted snippet or a test name is not a claim about the work.
function stripCode(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

export function claimCount(text) {
  if (!text) return 0;
  const matches = stripCode(text).match(CONFIDENT_VERBS);
  return matches ? matches.length : 0;
}

// Stop-hook payloads differ by Claude Code version: some carry the assistant's last
// message as a plain string, some as a content-block array. Accept both shapes and
// treat anything else as "nothing to scan" rather than guessing.
export function extractMessage(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  let msg = p.last_assistant_message;
  if (!msg && p.message && typeof p.message === 'object') msg = p.message.content;
  if (Array.isArray(msg)) {
    msg = msg.map((block) => (block && typeof block === 'object' ? block.text ?? '' : String(block ?? ''))).join(' ');
  }
  return typeof msg === 'string' ? msg.slice(0, SCAN_LIMIT) : '';
}

// Seconds since the newest ledger write. No ledger present at all reads as
// Infinity: nothing has ever been captured, which is exactly when the nudge is
// most warranted.
export function ledgerAgeSeconds(memoryRoot, now = Date.now()) {
  let newest = 0;
  for (const name of LEDGERS) {
    try {
      const { mtimeMs } = statSync(path.join(String(memoryRoot), name));
      if (mtimeMs > newest) newest = mtimeMs;
    } catch { /* absent or unreadable ledger simply does not count as a write */ }
  }
  if (!newest) return Infinity;
  return (now - newest) / 1000;
}

export function nudge(count) {
  return `[DISCIPLINE] ${count} confident ${count === 1 ? 'claim' : 'claims'} this turn (verbs like "fixed", "verified", "shipped") `
    + 'and no measurement ledger written recently. Capture the most consequential one with '
    + '/trust-decay capture, or run /honesty-check if this was end-of-task work. '
    + 'Uncaptured, this turn leaves no trace in the calibration record.';
}

// The whole decision, pure and testable: returns the nudge line, or '' for silence.
export function evaluate({ text, ageSeconds, threshold = DEFAULT_THRESHOLD, quietSeconds = DEFAULT_QUIET_SECONDS }) {
  const count = claimCount(text);
  if (count < threshold) return '';
  if (ageSeconds <= quietSeconds) return '';
  return nudge(count);
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function main() {
  try {
    if (String(process.env.AIGENT_DISCIPLINE_CHECK || '').toLowerCase() === 'off') return;

    let payload = {};
    try { payload = JSON.parse(readStdin() || '{}'); } catch { /* non-JSON stdin */ }
    const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
    if (!root) return;

    const text = extractMessage(payload);
    if (!text) return;

    const line = evaluate({
      text,
      ageSeconds: ledgerAgeSeconds(resolveMemRoot(root)),
      threshold: positiveInt(process.env.AIGENT_DISCIPLINE_THRESHOLD, DEFAULT_THRESHOLD),
      quietSeconds: positiveInt(process.env.AIGENT_DISCIPLINE_QUIET, DEFAULT_QUIET_SECONDS),
    });
    if (!line) return;

    try { writeSync(1, line + '\n'); } catch { /* advisory only -- never fail a turn over a print */ }
  } catch (e) {
    logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', 'discipline-check', `outer: ${e?.stack || e}`);
  }
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  main();
  process.exit(0);
}
