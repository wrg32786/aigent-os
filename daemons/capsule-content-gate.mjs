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

// The writer's OWN "I captured nothing" placeholders. These are deliberate and
// correct output — the writer must never invent an objective the human did not
// say (see the e9253777 contract at stop-capsule-writer's objective assignment).
// The defect is not that the writer emits them; it is that a capsule which
// honestly declares it captured nothing was still treated as RESUMABLE.
//
// Every pattern below is TRANSCRIBED from the emitting source, not recalled:
//   live tree  stop-capsule-writer.mjs:341-342
//   candidate  stop-capsule-writer.mjs:404, :530
// Two trees emit DIFFERENT placeholder strings, so both families are listed;
// covering one tree only would fix one class of seat and leave the other.
export const NOT_CAPTURED_PATTERNS = Object.freeze([
  /^Unknown: no human objective was captured\b/i,   // live :341-342 (both variants)
  /^No concrete next action was captured\b/i,       // both trees
  /^In-flight work \(auto-captured\b/i,             // candidate :530 / live :472
]);

export function isInjectionEcho(s) {
  const t = String(s || '').trim();
  return !!t && INJECTION_TEMPLATES.some((re) => re.test(t));
}

// Start-anchored like the rest of this module, and for the same reason: a real
// capsule may legitimately DISCUSS the placeholder (this fix's own row does).
// Only text that IS the placeholder fails.
export function isNotCaptured(s) {
  const t = String(s || '').trim();
  return !!t && NOT_CAPTURED_PATTERNS.some((re) => re.test(t));
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

// ⚑ WRITABLE IS NOT RESUMABLE — and these must stay two separate questions.
//
// contentProblems() above is the WRITE-side gate: what may be written to disk.
// The writer's "nothing was captured" placeholder is CORRECT to write — that is
// the e9253777 contract (never invent an objective the human did not say), and
// routing it through contentProblems() makes the writer reject its own honest
// output. Measured: doing exactly that turned stop-capsule-writer.test.mjs and
// precompact-flush.test.mjs red, because the writer lazy-imports
// validateCapsuleText(), which calls contentProblems().
//
// resumeBlockers() is the READ-side gate: what may be RESUMED FROM. Same shared
// vocabulary, different enforcement point, opposite answer for the same string.
export function resumeBlockers(fields) {
  const problems = [];
  if (isNotCaptured(fields?.objective)) {
    problems.push('capsule objective is the writer\'s own "nothing was captured" placeholder — honest, but not resumable');
  }
  if (isNotCaptured(fields?.next_valid_action)) {
    problems.push('capsule next_valid_action is the writer\'s own "nothing was captured" placeholder — honest, but not resumable');
  }
  return problems;
}
