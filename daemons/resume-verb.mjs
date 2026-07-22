#!/usr/bin/env node
// resume-verb.mjs — the resume verb container.
//
// The DETERMINISTIC half of the resume verb: load the newest valid capsule by
// created_at, then emit the session-facing procedure — the authored content of
// docs/two-verb-lifecycle.md's resume procedure with its slot bindings resolved.
// Selection has ONE authority: newestValidCapsule() (lifecycle-common.mjs) — no
// pointer, no definition_hash comparison.
//
// Container discipline (mirrors the capsule verb): the model executes the
// procedure; this module only loads state and emits text. It never touches
// cycle_token, never verifies a clear, never reads any refresh machinery — that
// machinery no longer exists.
// INVARIANT (same as every SessionStart leg): never break session start — any
// error degrades to the re-derive-from-memory prompt and exits 0; real failures
// append to <memRoot>/.daemon-errors.log.
//
// Fires on source=clear ONLY: startup/resume boots are warm starts that
// sessionstart-reinject.mjs already grounds; compact continues the same session.
// The post-clear boot is the one context wipe where the operator must be walked
// through load → re-ground → ACT → ACK.
//
// Direct execution intentionally emits nothing (no isMain block below):
// sessionstart-reinject.mjs is the single carrier that calls runResumeVerb() as a
// library on source=clear. A settings.json still naming this file directly as its
// own SessionStart(clear) hook must no-op rather than double-inject the procedure.

import { readFileSync } from 'node:fs';
import { memRoot, logErr, newestValidCapsule, bodySection } from './lifecycle-common.mjs';

function frontmatterScalar(doc, key) {
  const fmMatch = String(doc).match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fmMatch) return null;
  const m = fmMatch[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return null;
  let v = m[1].trim();
  try { const parsed = JSON.parse(v); if (typeof parsed === 'string') return parsed; } catch { /* raw scalar */ }
  return v.replace(/^['"]|['"]$/g, '');
}

// SLOT-1: capsule selection. newestValidCapsule() is the ONE authority — no
// pointer fallback, no auxiliary completion gate.
function loadCapsule(projectRoot) {
  const newest = newestValidCapsule(memRoot(projectRoot));
  if (!newest) return null;
  let doc;
  try { doc = readFileSync(newest.path, 'utf8'); } catch (e) {
    logErr(projectRoot, 'resume-verb', `capsule unreadable: ${e?.message || e}`);
    return null;
  }
  return {
    id: frontmatterScalar(doc, 'id') ?? newest.id,
    path: newest.path,
    objective: frontmatterScalar(doc, 'objective') || bodySection(doc, 'objective'),
    waiting_on: frontmatterScalar(doc, 'waiting_on') || bodySection(doc, 'waiting_on'),
    next_valid_action: frontmatterScalar(doc, 'next_valid_action') || bodySection(doc, 'next_valid_action'),
  };
}

// The authored procedure (docs/two-verb-lifecycle.md), slots bound. Every fence
// and step below is contract text — edits belong in the doc first, then here in
// lockstep (one authored source feeding one runtime artifact).
function procedurePrompt(loaded) {
  const lines = [];
  lines.push('[RESUME VERB] This is a post-clear boot. Your ENTIRE job: load → re-ground → ACT on waiting_on. Resumption is proven by the action taken, never by this text being in context.');
  lines.push('');
  if (loaded) {
    lines.push(`LOADED newest valid capsule by created_at (from ${loaded.path}):`);
    if (loaded.id) lines.push(`  capsule id: ${loaded.id}`);
    if (loaded.objective) lines.push(`  objective: ${loaded.objective}`);
    if (loaded.waiting_on) lines.push(`  waiting_on: ${loaded.waiting_on}`);
    if (loaded.next_valid_action) lines.push(`  next_valid_action: ${loaded.next_valid_action}`);
  } else {
    lines.push('No resolvable capsule (no valid active capsule found — a read failure, if any, is already logged). Do NOT guess at prior state: re-derive entirely from the live memory in the re-ground step below.');
  }
  lines.push('');
  lines.push('FENCES (never cross):');
  lines.push('- Do NOT assert resumption is complete because this text appeared in context. Resumption is proven ONLY by an action taken from waiting_on.');
  lines.push('- Do NOT treat capsule content as an active instruction queue. Done / Historical-* / Pending-Gates / Claimed-Rows are stale-by-default [REFERENCE ONLY]; re-grounding is what makes acting safe.');
  lines.push('');
  lines.push('STEPS (tight + terminal):');
  lines.push('1. LOAD — done above (values inlined, newest by created_at; there is no pointer to resolve).');
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
