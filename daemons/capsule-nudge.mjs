#!/usr/bin/env node
// capsule-nudge.mjs -- PostToolUse hook: ask a seat that never stops working to capsule itself.
//
// Titus, 2026-11-15 04:20-05:12Z: the session crossed the refresh threshold in the middle of one
// long run of tool calls. The runner may not TYPE the capsule request while a tool call is open (a
// permission dialog would take its Enter), and that run kept a tool call open the whole time, so
// every cycle held, abandoned at its bound and reopened, until Claude Code compacted natively.
// Typing cannot reach a seat that never yields; the seat's own context can. A PostToolUse hook
// runs between tool calls, mid-turn, and its additionalContext reaches the model there.
//
// When this session's auto-refresh cycle has been waiting for a capsule for NUDGE_AFTER_MS, this
// hook tells the agent once per cycle: finish the step, run the context-capsule skill, end the
// turn. A capsule the agent runs itself inside the cycle is the cycle's answer (pty-runner.mjs:
// the ack belongs to the capsule verb, not to whoever asked), and the runner clears once the turn
// has ended. The hook writes <memRoot>/runtime/capsule-nudge.json {cycle_id, at}, which the
// transport reads as the request having reached the seat, so the answer bound applies.
//
// Never blocks and never fails the tool call: any error, any unexpected shape, prints nothing.
// AIGENT_CAPSULE_NUDGE=0 turns it off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// The one memory-root resolver, without the interlock module's weight: this hook runs on every tool
// call. Same candidates, in the same order, as the interlock's hookMemRoot.
const { resolveMemoryRoot } = createRequire(import.meta.url)('./memory-root.cjs');
function hookMemRoot(payload, env) {
  for (const candidate of [env.AIGENT_STATE_HOME_DIR, env.AIGENT_ROOT, env.CLAUDE_PROJECT_DIR, payload?.cwd]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    try {
      const resolved = resolveMemoryRoot(candidate);
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export const NUDGE_AFTER_MS = 60_000;
export const NUDGE_FILE = 'capsule-nudge.json';

const WAITING = (state) => state === 'checkpoint-requested' || (typeof state === 'string' && state.startsWith('HOLD:checkpoint-'));

function readJson(file, fsImpl) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; }
}

function pressurePct(sessionId, env, fsImpl) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const file = path.join(home, '.claude', 'ctx-refresh', `${sessionId}.json`);
  const v = readJson(file, fsImpl)?.used_percentage;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Decide and record one nudge. Returns the additionalContext text, or null.
 * Pure over its inputs (payload, env, fs, now) so the suite drives the shipped code.
 */
export function nudgeFor({ payload, env = process.env, fsImpl = fs, now = () => Date.now() } = {}) {
  if (env.AIGENT_CAPSULE_NUDGE === '0') return null;
  const sessionId = payload && typeof payload.session_id === 'string' ? payload.session_id : null;
  if (!sessionId) return null;
  const memRoot = hookMemRoot(payload, env);
  if (!memRoot) return null;
  const runtime = path.join(memRoot, 'runtime');
  const cycle = readJson(path.join(runtime, 'auto-clear-cycle.json'), fsImpl);
  if (!cycle || cycle.session_id !== sessionId || typeof cycle.cycle_id !== 'string' || !WAITING(cycle.state)) return null;
  const since = Date.parse(cycle.checkpoint_wait_started_at || cycle.entered_at);
  if (!Number.isFinite(since) || now() - since < NUDGE_AFTER_MS) return null;
  const marker = path.join(runtime, NUDGE_FILE);
  if (readJson(marker, fsImpl)?.cycle_id === cycle.cycle_id) return null;   // once per cycle
  const tmp = `${marker}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify({ cycle_id: cycle.cycle_id, session_id: sessionId, at: new Date(now()).toISOString() }));
    fsImpl.renameSync(tmp, marker);
  } catch {
    try { fsImpl.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return null;   // unrecorded: say nothing, so the transport's bound and the text agree
  }
  const pct = pressurePct(sessionId, env, fsImpl);
  const waited = Math.max(1, Math.round((now() - since) / 60_000));
  return `[aigent auto-refresh] This session is ${pct === null ? 'past' : `at ${pct}% of`} its context `
    + `refresh threshold, and the runner has waited ${waited} min to ask for a capsule. It cannot type the `
    + 'request while you keep working. Finish the step you are on, then run the context-capsule skill now '
    + '(it writes the capsule and ends with its ready-for-clear line) and end your turn. Start nothing new '
    + 'first. The runner then clears the session and resumes you from that capsule.';
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let text = null;
    try { text = nudgeFor({ payload: JSON.parse(raw) }); } catch { text = null; }
    if (text) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
    }
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('capsule-nudge.mjs')) main();
