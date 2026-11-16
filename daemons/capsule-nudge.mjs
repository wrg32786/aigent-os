#!/usr/bin/env node
// capsule-nudge.mjs -- PostToolUse and Stop hook: ask the seat to capsule itself, never by typing.
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
// THE STOP LEG (Titus, 2026-11-15 16:57 PT): the cycle opened 5 s before the seat's turn ended, the
// last key the runner had seen was a Backspace, so it could not prove the prompt box empty and would
// not type the request; the seat then sat idle with no tool call for the PostToolUse leg to ride, and
// the operator had to type /context-capsule. A Stop hook runs at every turn end. When this session's
// cycle has begun (pressure onward) and no typed request has reached the seat, it blocks that stop
// with the same instruction, and Claude Code continues the turn on it.
//
// ONE ASK PER CYCLE, ACROSS BOTH LEGS (review of dfcf696, F1/F2). The legs share one claim: a seat
// that obeyed the PostToolUse ask and ends its capsule turn is not asked again by the Stop leg, and
// a seat the Stop leg asked is not told mid-capsule by the PostToolUse leg. The claim is also the
// loop guard, so stop_hook_active does not silence the Stop leg: another Stop hook (a brevity gate)
// may have blocked first, and the real turn end must still be asked. The marker carries the
// transcript end at the ask, and the runner opens its ack window there instead of typing the
// request (pty-runner.mjs _nudgeDeliveredFor): one capsule per cycle, whoever asked.
//
// Never fails the tool call or the stop: any error, any unexpected shape, prints nothing.
// AIGENT_CAPSULE_NUDGE=0 (or off, false, no) turns it off.
//
// Never nudged (review of 7b3f57b): a SUBAGENT's tool call (agent_id in the payload: it would
// abandon its own work, and spend the cycle's one nudge); a cycle whose typed request the host has
// already recorded (the seat is in its capsule turn, and the text would be false); a cycle file
// older than LIVE_MS (automation off, the runner no longer ticks it). One nudge per cycle is
// claimed with an exclusive create, so parallel hooks print it once.
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
// The transport rewrites the cycle file on every waiting tick; older than this, nobody is ticking.
export const LIVE_MS = 120_000;
// The skill the text names: the runner types the same command (pty-runner.mjs CAPSULE_REQUEST_TEXT).
export const CAPSULE_SKILL = 'context-capsule';
const OFF = new Set(['0', 'off', 'false', 'no']);

const WAITING = (state) => state === 'checkpoint-requested' || (typeof state === 'string' && state.startsWith('HOLD:checkpoint-'));
// At a turn end the cycle may be seconds old, still in `pressure`: that is the moment to ask.
const WAITING_AT_STOP = (state) => state === 'pressure' || WAITING(state);

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
 * Decide and record one nudge. Returns the instruction text, or null. `payload.hook_event_name`
 * 'Stop' takes the Stop leg (see the header); anything else is the PostToolUse leg.
 * Pure over its inputs (payload, env, fs, now) so the suite drives the shipped code.
 */
export function nudgeFor({ payload, env = process.env, fsImpl = fs, now = () => Date.now() } = {}) {
  if (OFF.has(String(env.AIGENT_CAPSULE_NUDGE ?? '').trim().toLowerCase())) return null;
  const sessionId = payload && typeof payload.session_id === 'string' ? payload.session_id : null;
  if (!sessionId) return null;
  const atStop = payload.hook_event_name === 'Stop';
  // The interlock's own subagent predicate: a background agent runs the same hooks.
  if (typeof payload.agent_id === 'string' && payload.agent_id.length > 0) return null;
  const memRoot = hookMemRoot(payload, env);
  if (!memRoot) return null;
  const runtime = path.join(memRoot, 'runtime');
  const cycleFile = path.join(runtime, 'auto-clear-cycle.json');
  let mtime;
  try { mtime = fsImpl.statSync(cycleFile).mtimeMs; } catch { return null; }
  if (now() - mtime > LIVE_MS) return null;
  const cycle = readJson(cycleFile, fsImpl);
  const waiting = atStop ? WAITING_AT_STOP : WAITING;
  if (!cycle || cycle.session_id !== sessionId || typeof cycle.cycle_id !== 'string' || !waiting(cycle.state)) return null;
  if (cycle.checkpoint_request_recorded?.cycle_id === cycle.cycle_id) return null;   // the typed request reached the seat
  const since = Date.parse(cycle.checkpoint_wait_started_at || cycle.entered_at);
  // Mid-turn, give the runner a minute to type the request itself. At a turn end there is no later
  // moment to wait for, so the Stop leg asks at once.
  if (!atStop && (!Number.isFinite(since) || now() - since < NUDGE_AFTER_MS)) return null;
  // Build the text BEFORE anything is recorded, so nothing slow sits between the record and the print.
  const pct = pressurePct(sessionId, env, fsImpl);
  const where = `This session is ${pct === null ? 'past' : `at ${pct}% of`} its context refresh threshold`;
  const text = atStop
    ? `[aigent auto-refresh] ${where}, and the runner cannot type the capsule request into the prompt box. `
      + `Before you stop: run the ${CAPSULE_SKILL} skill now (it writes the capsule and ends with its `
      + 'ready-for-clear line), then end your turn. Start nothing new. If you just asked the operator '
      + "something, put it in the capsule's waiting_on so the resume asks it again. The runner then clears "
      + 'the session and resumes you from that capsule.'
    : `[aigent auto-refresh] ${where}, and the runner has waited `
      + `${Math.max(1, Math.round((now() - (Number.isFinite(since) ? since : now())) / 60_000))} min to ask for a capsule. `
      + `It cannot type the request while you keep working. Finish the step you are on, then run the ${CAPSULE_SKILL} `
      + 'skill now (it writes the capsule and ends with its ready-for-clear line) and end your turn. Start nothing '
      + 'new first. The runner then clears the session and resumes you from that capsule.';
  // ONE nudge per cycle, whichever leg: an exclusive create claims it, so of several parallel hooks one prints.
  const claimName = `capsule-nudge.${cycle.cycle_id.replace(/[^A-Za-z0-9_-]/g, '_')}.claim`;
  const claim = path.join(runtime, claimName);
  try {
    fsImpl.closeSync(fsImpl.openSync(claim, 'wx'));
  } catch {
    return null;   // already claimed (or the runtime is unwritable): say nothing
  }
  try {
    for (const name of fsImpl.readdirSync(runtime)) {
      if (name.startsWith('capsule-nudge.') && name.endsWith('.claim') && name !== claimName) {
        try { fsImpl.unlinkSync(path.join(runtime, name)); } catch { /* another cycle's claim, best effort */ }
      }
    }
  } catch { /* pruning is housekeeping */ }
  const marker = path.join(runtime, NUDGE_FILE);
  const tmp = `${marker}.${process.pid}.tmp`;
  // The transcript end before the seat reads the instruction: the runner's ack window opens here.
  let transcriptOffset = null;
  try { transcriptOffset = fsImpl.statSync(payload.transcript_path).size; } catch { /* the runner then types the request */ }
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify({
      cycle_id: cycle.cycle_id, session_id: sessionId, at: new Date(now()).toISOString(),
      ...(Number.isSafeInteger(transcriptOffset) ? { transcript_offset: transcriptOffset } : {}),
    }));
    fsImpl.renameSync(tmp, marker);
  } catch {
    try { fsImpl.unlinkSync(tmp); } catch { /* nothing to clean */ }
    try { fsImpl.unlinkSync(claim); } catch { /* the claim goes back, so a later call can retry */ }
    return null;   // unrecorded: say nothing, so the transport's bound and the text agree
  }
  return text;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let text = null;
    let payload = null;
    try { payload = JSON.parse(raw); text = nudgeFor({ payload }); } catch { text = null; }
    if (text && payload?.hook_event_name === 'Stop') {
      // A Stop hook's block keeps the turn going with `reason` as the next instruction.
      process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
    } else if (text) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
    }
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('capsule-nudge.mjs')) main();
