// seat-status.cjs — the Pantheon seat-runtime adapter's status() leg (WS2).
//
// V2 HOME: pantheon-v2/packages/seat-runtime/aigent-os-adapter.cjs — kept here
// frame-portable (zero monorepo imports, plain .cjs) until the WS1 frame stands;
// the CONTRACTS_APPENDIX §3.1 shapes are data, not imports.
//
// Produces the FROZEN SeatStatus shape plus the OPTIONAL `presence` field per
// rider 2026-07-24_WS2_seatstatus-presence-field.md: presence carries the
// ever529 donor's tri-state (OCCUPIED/IDLE/UNKNOWN) verbatim — an ABSENT or
// UNKNOWN presence must read as "block the restart" at the WS5b guard, so this
// module never fabricates IDLE: any read failure degrades to UNKNOWN with a
// named reason, and the field is omitted entirely only when no reader was
// injected at all (older runtime — the guard's absence rule covers it).
//
// Dependency-injected throughout (the dispatch-brake/evaluateMerge testability
// pattern): no fs/env reads in the decision path; callers wire the readers.
'use strict';

const SEAT_STATES = Object.freeze(['idle', 'working', 'refreshing', 'suspended', 'revoked']);

// deriveSeatState({liveSid, currentRunId, suspended, revoked})
// Minimal, honest mapping for the v1-interim wiring:
//   revoked/suspended are explicit operator states and win outright;
//   a live session with a run in flight is 'working'; a live session without
//   one is 'idle'; no live session at all is also 'idle' (the seat exists but
//   nothing runs — dispatch's idle scan still consults board leases, §4.1, so
//   this value is advisory, never the claim-predicate).
// 'refreshing' is set by the lifecycle verbs during a bank/resume window and
// arrives via the injected refreshWindow flag rather than being inferred —
// inferring it from file activity was considered and rejected: a wrong
// 'refreshing' read could park dispatch on a healthy seat indefinitely.
function deriveSeatState({ liveSid, currentRunId, suspended, revoked, refreshWindow }) {
  if (revoked) return 'revoked';
  if (suspended) return 'suspended';
  if (refreshWindow) return 'refreshing';
  if (liveSid && currentRunId) return 'working';
  return 'idle';
}

// gatherSeatStatus({seatId, contextEpoch, deps})
//   deps.discoverLiveSid()   -> string|null      (same instrument family as the
//                                                 consent gate — instrument symmetry)
//   deps.currentRun()        -> {runId}|null
//   deps.flags()             -> {suspended?, revoked?, refreshWindow?}
//   deps.readHumanPresence() -> donor shape {state, reason,
//                                 last_human_input_age_ms, observed_age_ms}
// Every dep is optional; a missing/throwing dep degrades toward the SAFE value
// (null sid, no run, UNKNOWN presence) — never toward IDLE-the-permissive.
function gatherSeatStatus({ seatId, contextEpoch = 0, deps = {} }) {
  const tryDep = (fn, fallback) => {
    if (typeof fn !== 'function') return fallback;
    try { return fn(); } catch { return fallback; }
  };

  const liveSid = tryDep(deps.discoverLiveSid, null);
  const run = tryDep(deps.currentRun, null);
  const flags = tryDep(deps.flags, {}) || {};

  const status = {
    seatId: String(seatId),
    state: deriveSeatState({
      liveSid,
      currentRunId: run && run.runId ? String(run.runId) : null,
      suspended: !!flags.suspended,
      revoked: !!flags.revoked,
      refreshWindow: !!flags.refreshWindow,
    }),
    currentRunId: run && run.runId ? String(run.runId) : null,
    contextEpoch: Number(contextEpoch) || 0,
  };

  // presence: only attach when a reader exists — absence-of-field is the
  // documented older-runtime signal (guard blocks). A reader that exists but
  // fails NEVER vanishes silently: it must surface as UNKNOWN so the guard's
  // refusal names the real reason instead of the generic absence rule.
  if (typeof deps.readHumanPresence === 'function') {
    let p;
    try { p = deps.readHumanPresence(); } catch (e) {
      p = { state: 'UNKNOWN', reason: `presence-reader-threw: ${e && e.message ? e.message : e}`, last_human_input_age_ms: null, observed_age_ms: null };
    }
    const state = p && ['OCCUPIED', 'IDLE', 'UNKNOWN'].includes(p.state) ? p.state : 'UNKNOWN';
    status.presence = {
      state,
      reason: p && p.reason ? String(p.reason) : (state === 'UNKNOWN' ? 'malformed-presence-read' : ''),
      last_human_input_age_ms: p && Number.isFinite(p.last_human_input_age_ms) ? p.last_human_input_age_ms : null,
      observed_age_ms: p && Number.isFinite(p.observed_age_ms) ? p.observed_age_ms : null,
    };
  }

  return status;
}

// isHumanLive(status) — the WS5b guard-side mapping (CONTRACTS §4.3 verbatim
// surface): true = BLOCK the restart. Only a well-formed presence with
// state === 'IDLE' permits; absent field, UNKNOWN, OCCUPIED, malformed — all block.
function isHumanLive(status) {
  const p = status && status.presence;
  if (!p || typeof p !== 'object') return true;   // absence blocks (older runtime)
  return p.state !== 'IDLE';
}

module.exports = { SEAT_STATES, deriveSeatState, gatherSeatStatus, isHumanLive };
