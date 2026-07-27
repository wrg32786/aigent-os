#!/usr/bin/env node
// memory-budget-guard.mjs -- PreToolUse(Write|Edit) size gate on the memory
// surfaces that are injected into every session.
//
// The budget itself, and the reasoning for having one, live in
// memory-hygiene/budget.mjs. This file is only the wiring: reconstruct what the
// file would contain after the pending edit, and refuse the edit if that puts a
// governed surface over its ceiling.
//
// ONE RULE MAKES THIS USABLE RATHER THAN A TRAP: a write that SHRINKS an
// over-budget file is always allowed. Without that, the first edit to cross the
// line would lock the file permanently, including the consolidating edit that
// would bring it back under. The gate has to leave the exit open, otherwise the
// only way out is to disable the gate, and a gate everyone disables protects
// nothing.
//
// ON by default, unlike the first-touch gate next to it. Justified by how narrow
// it is: three named files, and only when they are both over budget and growing.
// A session can run for days without this ever having an opinion.
//   AIGENT_MEMORY_BUDGET=off (or 0/false)  disable
//
// INVARIANT: FAIL OPEN. Unreadable payload, missing file, unexpected shape, any
// throw at all -- exit 0 and allow. A size gate must never be why a session
// cannot record what it just learned.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudget, consolidationPrompt, budgetFor } from './memory-hygiene/budget.mjs';
import { readStdin, logErr } from './lifecycle-common.mjs';

export function isEnabled(env = process.env) {
  const value = String(env.AIGENT_MEMORY_BUDGET ?? '').trim().toLowerCase();
  return !(value === 'off' || value === '0' || value === 'false' || value === 'no');
}

function currentText(filePath) {
  try { return readFileSync(filePath, 'utf8'); } catch { return ''; }
}

// What the file will hold if this tool call succeeds. For Write that is the
// payload; for Edit it is the current file with the replacement applied. An Edit
// whose old_string is absent would fail on its own, so we leave it alone.
export function prospectiveText(tool, input, readFile = currentText) {
  if (tool === 'write') return typeof input.content === 'string' ? input.content : null;
  if (tool !== 'edit') return null;
  const oldString = typeof input.old_string === 'string' ? input.old_string : null;
  const newString = typeof input.new_string === 'string' ? input.new_string : null;
  if (oldString === null || newString === null) return null;
  const before = readFile(input.file_path);
  if (!before.includes(oldString)) return null;
  return input.replace_all
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString);
}

// The verdict a caller can test without a hook payload: null means allow.
export function evaluate(filePath, nextText, beforeText) {
  if (!budgetFor(filePath)) return null;
  const verdict = checkBudget(filePath, nextText);
  if (verdict.ok) return null;
  const shrinking = String(nextText).length < String(beforeText ?? '').length;
  if (shrinking) return null;
  return verdict;
}

function deny(reason) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch { /* nothing printable means the call proceeds -- fail open */ }
}

function main() {
  try {
    if (!isEnabled()) return;
    let payload = {};
    try { payload = JSON.parse(readStdin() || '{}'); } catch { return; }

    const tool = String(payload.tool_name || '').toLowerCase();
    if (tool !== 'write' && tool !== 'edit') return;
    const input = (payload.tool_input && typeof payload.tool_input === 'object')
      ? payload.tool_input
      : {};
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (!filePath || !budgetFor(filePath)) return;

    const next = prospectiveText(tool, input);
    if (next === null) return;

    const verdict = evaluate(filePath, next, currentText(filePath));
    if (verdict) deny(consolidationPrompt(verdict));
  } catch (error) {
    logErr(
      process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '',
      'memory-budget-guard',
      `outer: ${error?.stack || error}`,
    );
  }
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (direct) {
  main();
  process.exit(0);
}
