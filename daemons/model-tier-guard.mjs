#!/usr/bin/env node
// model-tier-guard.mjs -- PreToolUse(Agent) check that makes "aigent-OS routes
// by model tier" true at dispatch time instead of merely documented.
//
// system/09_subagent_manifest.md's "Model: Fast/Mid/Frontier" field and each
// vault/agents/<Name>.md's `model:` frontmatter scalar are a CONVENTION for the
// operating Claude to follow -- nothing upstream reads that field at dispatch
// time today. This hook closes that gap for the one dispatch shape aigent-OS
// can actually see: the Agent tool call itself.
//
// DEFAULT (advisory): a live mismatch prints a specific, named correction to
// stdout and lets the dispatch proceed. This mirrors the repo's own
// suggest-don't-block doctrine (see vault/concepts/Suggestion Credibility.md,
// vault/concepts/Caddy.md -- both argue PreToolUse hooks that block on a guess
// destroy the signal channel with false-positive noise). It is still a real
// enforcement mechanism, not documentation: it fires per-dispatch against the
// ACTUAL agent being invoked, with the ACTUAL model requested, not a static
// rule read once at session start and never checked again.
//
// OPT-IN hard gate (mirrors precompact-flush.mjs's LIFECYCLE_PRECOMPACT_STRICT
// precedent): AIGENT_MODEL_GUARD=enforce turns a mismatch into decision:block
// + exit 2, forcing a corrected redispatch before the agent runs at all.
//
// Only acts on subagent_type values that resolve to an installed aigent-OS
// agent definition (.claude/agents/<name>.md at runtime; vault/agents/<name>.md
// as a dogfood/pre-install fallback for this source tree). Every other Agent
// dispatch -- Claude Code's own built-in types (general-purpose, Explore,
// Plan, ...), a fork's custom agents with no model: frontmatter -- passes
// through untouched: this hook only enforces a promise aigent-OS itself makes.

import { readFileSync, existsSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';
import { readStdin, logErr } from './lifecycle-common.mjs';

function frontmatterScalar(doc, key) {
  const fm = doc.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1];
  if (!fm) return null;
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

// Runtime installs get .claude/agents/; this repo's own source tree (and any
// fork exercising the hook before running install.sh) only has vault/agents/.
// First existing candidate wins -- same precedence rule daemons/caddy.sh uses
// for its repo-index-vs-global-index lookup.
function agentDefDir(root) {
  for (const candidate of ['.claude/agents', 'vault/agents']) {
    const p = path.join(root, ...candidate.split('/'));
    if (existsSync(p)) return p;
  }
  return null;
}

function findAgentDef(root, subagentType) {
  const dir = agentDefDir(root);
  const wanted = String(subagentType || '').trim().toLowerCase();
  if (!dir || !wanted) return null;
  let entries;
  try { entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return null; }
  for (const file of entries) {
    let doc;
    try { doc = readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const name = frontmatterScalar(doc, 'name');
    if (name && name.trim().toLowerCase() === wanted) {
      return { file, name, model: frontmatterScalar(doc, 'model') };
    }
  }
  return null;
}

try {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { /* non-JSON stdin */ }
  const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
  if (!root) process.exit(0);

  const input = (payload.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};
  const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : '';
  const requestedModel = typeof input.model === 'string' ? input.model.trim() : '';

  // Only enforce when the dispatch names one of OUR agents with a declared
  // tier -- a fork's own agents, or Claude Code's built-in types, are never
  // in scope for a promise aigent-OS itself never made about them.
  const def = findAgentDef(root, subagentType);
  if (!def || !def.model) process.exit(0);

  if (requestedModel && requestedModel.toLowerCase() === def.model.toLowerCase()) process.exit(0); // matched -- silent, no noise on the happy path

  const actual = requestedModel || '(none -- silently inherits the caller\'s model)';
  const reason = `[MODEL-TIER] ${def.name} is defined to run on model: "${def.model}" (${def.file}); this dispatch specified ${actual}. `
    + `Add model: "${def.model}" to this Agent call before dispatching ${def.name}.`;

  if (process.env.AIGENT_MODEL_GUARD === 'enforce') {
    // Mirrors precompact-flush.mjs's opt-in strict gate: benign by default,
    // a hard block only for operators who explicitly asked for the guarantee.
    try { writeSync(1, JSON.stringify({ decision: 'block', reason })); } catch { /* exit code still blocks */ }
    try { writeSync(2, reason + '\n'); } catch { /* ditto */ }
    process.exit(2);
  }

  try { writeSync(1, reason + '\n'); } catch { /* advisory only -- never fail the dispatch over a print */ }
} catch (e) {
  logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', 'model-tier-guard', `outer: ${e?.stack || e}`);
}
process.exit(0);
