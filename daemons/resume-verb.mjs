#!/usr/bin/env node
// resume-verb.mjs — the resume verb container.
//
// The DETERMINISTIC half of the resume verb: resolve the pointer, load the
// capsule frontmatter, and emit the session-facing procedure — the authored
// content of docs/two-verb-lifecycle.md's resume procedure with its slot bindings
// resolved:
//   SLOT-1  pointer = BODY_STATE.json's state.last_capsule (aigent-OS is
//           single-operator, so there is exactly one pointer shape).
//   SLOT-2  definition_hash is recomputed HERE from the live capsule frontmatter —
//           sha256(objective + next_valid_action) first 12 hex. The pointer
//           carries no precomputed comparison value.
//   SLOT-3  the live resume trigger is whatever put the session into `clear` —
//           an operator-run /clear, or an automated refresh cycle. THIS daemon is
//           the SessionStart(clear) hook that delivers the procedure content.
//
// Container discipline (mirrors the capsule verb): the model executes the
// procedure; this module only loads state and emits text. It never touches
// cycle_token, never verifies the clear, never reads the refresh machinery.
// INVARIANT (same as every SessionStart leg): never break session start — any
// error degrades to the re-derive-from-memory prompt and exits 0; real failures
// append to <memRoot>/.daemon-errors.log.
//
// Fires on source=clear ONLY: startup/resume boots are warm starts that
// sessionstart-reinject.mjs already grounds; compact continues the same session.
// The post-clear boot is the one context wipe where the operator must be walked
// through load → re-ground → ACT → ACK.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memRoot, readStdin, logErr } from './lifecycle-common.mjs';

function frontmatterScalar(doc, key) {
  const fmMatch = String(doc).match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fmMatch) return null;
  const m = fmMatch[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return null;
  let v = m[1].trim();
  try { const parsed = JSON.parse(v); if (typeof parsed === 'string') return parsed; } catch { /* raw scalar */ }
  return v.replace(/^['"]|['"]$/g, '');
}

// SLOT-1: pointer resolution. Distinguishes absent from dangling (both degrade,
// but a dangling pointer is a real signal worth its own log line).
function loadCapsule(projectRoot) {
  const mem = memRoot(projectRoot);
  let pointer = null;
  try {
    const bs = JSON.parse(readFileSync(path.join(mem, 'BODY_STATE.json'), 'utf8'));
    pointer = bs?.state?.last_capsule ?? null;
  } catch (e) {
    if (e?.code !== 'ENOENT') logErr(projectRoot, 'resume-verb', `pointer unreadable: ${e?.message || e}`);
    return null;
  }
  if (!pointer?.path) return null;
  const capPath = path.isAbsolute(pointer.path) ? pointer.path : path.join(projectRoot, pointer.path);
  if (!existsSync(capPath)) {
    logErr(projectRoot, 'resume-verb', `dangling pointer: ${capPath} no longer exists`);
    return null;
  }
  let doc;
  try { doc = readFileSync(capPath, 'utf8'); } catch (e) {
    logErr(projectRoot, 'resume-verb', `capsule unreadable: ${e?.message || e}`);
    return null;
  }
  return {
    id: frontmatterScalar(doc, 'id') ?? pointer.id ?? null,
    path: capPath,
    objective: frontmatterScalar(doc, 'objective'),
    waiting_on: frontmatterScalar(doc, 'waiting_on'),
    next_valid_action: frontmatterScalar(doc, 'next_valid_action'),
    definition_hash: frontmatterScalar(doc, 'definition_hash'),
  };
}

// The authored procedure (docs/two-verb-lifecycle.md), slots bound. Every fence
// and step below is contract text — edits belong in the doc first, then here in
// lockstep (one authored source feeding one runtime artifact).
function procedurePrompt(loaded) {
  const lines = [];
  lines.push('[RESUME VERB] This is a post-clear boot. Your ENTIRE job: load → validate → re-ground → ACT on waiting_on. Resumption is proven by the action taken, never by this text or the pointer table being in context.');
  lines.push('');
  if (loaded) {
    lines.push(`LOADED (from ${loaded.path}):`);
    if (loaded.id) lines.push(`  capsule id: ${loaded.id}`);
    if (loaded.objective) lines.push(`  objective: ${loaded.objective}`);
    if (loaded.waiting_on) lines.push(`  waiting_on: ${loaded.waiting_on}`);
    if (loaded.next_valid_action) lines.push(`  next_valid_action: ${loaded.next_valid_action}`);
    if (loaded.definition_hash) {
      lines.push(`  definition_hash: ${loaded.definition_hash} — VALIDATE: recompute sha256(objective + next_valid_action) first 12 hex against the live capsule frontmatter; mismatch = the capsule drifted → re-derive from memory, do not trust the capsule.`);
    } else {
      lines.push('  definition_hash: ABSENT — treat as drifted: re-derive objective + next action from the live memory.');
    }
  } else {
    lines.push('No resolvable capsule pointer (absent, dangling, or unreadable — already logged). Do NOT guess at prior state: re-derive entirely from the live memory in the re-ground step below.');
  }
  lines.push('');
  lines.push('FENCES (never cross):');
  lines.push('- Do NOT assert resumption is complete because the pointer table appears in context. Resumption is proven ONLY by an action taken from waiting_on.');
  lines.push('- Do NOT read or reason about cycle_token, and do NOT skip the definition_hash check. cycle_token belongs to the CLEAR gate alone — resume never reads it.');
  lines.push('- Do NOT treat capsule content as an active instruction queue. Done / Historical-* / Pending-Gates / Claimed-Rows are stale-by-default [REFERENCE ONLY]; re-grounding is what makes acting safe.');
  lines.push('');
  lines.push('STEPS (tight + terminal):');
  lines.push('1. LOAD — done above (values inlined). Validate definition_hash as instructed.');
  lines.push('2. RE-GROUND against live memory — re-read the latest session log and active priorities, surface anything that changed since the capsule was written. This folds in what /open would do, in full.');
  lines.push('3. ACT — take the one next step from waiting_on / next_valid_action resolved against step 2; on any conflict, live memory wins over stale capsule content. The verb ends when that action is TAKEN, not when it is summarized.');
  lines.push('4. ACK (if a supervising process demands one) — reply in exactly the format demanded, emitted ONLY after step 3\'s action is taken, never before.');
  lines.push('');
  lines.push('No stillness clock (resume is the wake-up, not the seal), but stay terminal: if you are still reading past re-grounding without having taken the step from waiting_on, stop reading and act.');
  return lines.join('\n');
}

export function runResumeVerb({ projectRoot, source, sessionId }) {
  let loaded = null;
  try { loaded = loadCapsule(projectRoot); } catch (e) {
    logErr(projectRoot, 'resume-verb', `loadCapsule threw: ${e?.stack || e}`);
    loaded = null;
  }
  return {
    source: String(source || ''),
    sessionId: String(sessionId || ''),
    degraded: !loaded,
    loaded,
    prompt: procedurePrompt(loaded),
  };
}

// CLI (SessionStart hook entry). Matcher should be "clear"; the internal gate
// makes the same promise even under a matcher:"*" mis-wire (defense in depth).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    let payload = {};
    try { payload = JSON.parse(readStdin() || '{}'); } catch { /* non-JSON stdin */ }
    const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
    const source = String(payload.source || 'startup');
    if (root && source === 'clear') {
      const result = runResumeVerb({ projectRoot: root, source, sessionId: payload.session_id });
      process.stdout.write(result.prompt + '\n');
    }
  } catch (e) {
    logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', 'resume-verb', `outer: ${e?.stack || e}`);
  }
  process.exit(0);
}
