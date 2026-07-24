// capsule-content-gate.mjs — non-null ≠ resumable.
//
// ONE vocabulary for "this capsule text is ceremony echo, not the operator's real
// content", shared by BOTH enforcement points:
//   - capsule-verb.mjs validateCapsuleText()  — the trusted-receipt gate
//   - stop-capsule-writer.mjs                 — the field-refresh gate
// Zero imports by design: the stop-writer lazy-loads this on the Stop hot path and
// must never drag the reconcile stack with it.
//
// Every pattern here was written against REAL clobbered capsules observed in
// production: an autosave capsule whose `objective` was literally the harness's
// own injected instruction text (verbatim), and a `next_valid_action` that was
// literally "re-read the active turn state" — a resume-verb boot ceremony echoed
// back as if it were the seat's own next step. Patterns are START-ANCHORED on
// purpose: a curated capsule may legitimately REFERENCE the ceremony mid-action
// ("On resume: comply with any supervisor-resume instruction ...") — that is
// content and must pass. Only text that IS the injection/ceremony (leads with it)
// fails.

// Harness/supervisor injection markers. An OBJECTIVE matching any of these is
// injected instruction echo, never the operator's actual objective.
export const INJECTION_TEMPLATES = Object.freeze([
  /^\[supervisor-resume\]/i,
  /^\[refresh-cycle\]/i,
  /^\[auto-pull\]/i,
  /^\[context-refresh\b/i,
  /^\[capsule-request\]/i,
  /^\[room from /i,
  /^\[inbox\b/i,
  /^# Autonomous loop check/i,
  /^Autonomous loop tick/i,
  /^<task-notification>/i,
  /^\[SYSTEM NOTIFICATION/i,
  // Fleet-deployment markers (measured on a live 5-seat fleet, 2026-07-24: of
  // ~360 autosave capsules on one seat, 63 objectives were the launchd wake
  // preamble and 63 were the supervisor's liveness probe — injected traffic
  // outnumbering every real operator objective). A seat-start ritual phrase is
  // gated even when a human types it: it is a trigger, never the work objective.
  /^Reply with the single word: READY\b/i,        // supervisor liveness probe
  /^You are \w+ — read CLAUDE\.md/i,              // legacy kickstart wake preamble
  /^(atlas|socrates|mads|metis|rev) start\b/i,    // restart/wake verb ("Metis start …")
  /^Bank your capsule now and end this turn\b/i,  // auto-clear supervisor order (retiring machinery)
  /^\[Request interrupted by user/i,              // harness interruption marker
]);

// Resume-ceremony openers — the stop-writer's own historical templates plus the
// observed echo shapes. A NEXT_VALID_ACTION that leads with one of these tells a
// fresh session nothing but "you have resumed"; a crash after it strands the
// session in a capsule instructing it to resume.
export const CEREMONY_PATTERNS = Object.freeze([
  /^re-?read the (active )?turn state\b/i,        // writer template (pre-fix)
  /^resume from the latest session log\b/i,       // writer fallback (pre-fix)
  /^resume (is |was )?(now )?complete\b/i,
  /^(the )?receipt (is |was )?written\b/i,
  /^RESUME-ACK\b/,
  /^comply with (any|the) supervisor-resume instruction\b/i, // echo of the resume verb's step text AS the whole action
]);

export function isInjectionEcho(s) {
  const t = String(s || '').trim();
  return !!t && INJECTION_TEMPLATES.some((re) => re.test(t));
}

export function isCeremonyAction(s) {
  const t = String(s || '').trim();
  return !!t && CEREMONY_PATTERNS.some((re) => re.test(t));
}

// Content-side problems for a capsule that will serve as a RESUME SOURCE.
// Complements (never replaces) the non-empty checks in validateCapsuleText —
// field presence stays the verb's concern; field MEANING is gated here.
export function contentProblems(fields) {
  const problems = [];
  if (isInjectionEcho(fields?.objective)) {
    problems.push('capsule objective is harness-injection echo, not the operator\'s own objective (content gate)');
  }
  if (isCeremonyAction(fields?.next_valid_action)) {
    problems.push('capsule next_valid_action opens with resume ceremony — a fresh session cannot act on it (content gate)');
  }
  return problems;
}
