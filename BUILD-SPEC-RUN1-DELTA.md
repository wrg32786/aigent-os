# RUN 1 DELTA — close the independent review's test-coverage findings

Scope: TESTS ONLY. No production-behavior change of any kind. All new vectors go
in `daemons/tests/auto-clear-transport.run1.test.mjs` (append; keep the existing
10 untouched). Same IO-injection style as the existing vectors. Same rules as
BUILD-SPEC-RUN1.md: no new dependencies, atomic-state for any fixture writes,
never re-implement selectCapsule.

Background: an independent reviewer mutation-tested the suite. Deleting
`beginClearSubmission()`'s own checkpoint re-verification
(auto-clear-transport.mjs:1088-1096) leaves ALL 10 vectors green while the
spec's central claim ("a stale capsule must NEVER authorize a clear") silently
loses its proof at the one site that mints authorization. Each vector below
must be RED-FIRST: prove it fails against the named mutation before shipping it
green, and record the mutation → red evidence in the report section.

VECTOR 11 (HIGH — the blocker). Authorization-site checkpoint decay:
drive a fixture to `checkpoint-confirmed` with a valid checkpoint, THEN decay it
(grow the transcript so the stop-writer offset falls behind — new activity after
capture), THEN call `beginClearSubmission()`. It must throw
`ECLEAR_CHECKPOINT` with the transport holding `HOLD:checkpoint-transcript-short`
(resume_state checkpoint-requested), and no clear_intent may be persisted.
RED-FIRST mutation: delete lines 1088-1096 in a sandbox copy → this vector must
fail against the mutant. (The reviewer's probe
`mutation-probe-checkpoint-decay.mjs` in the session scratchpad demonstrates the
exact scenario; reuse its shape, not its file.)

VECTOR 12. Submission-site kill-switch + pressure-drop re-checks
(auto-clear-transport.mjs:1054-1087): from `checkpoint-confirmed`, (a) arm the
kill-switch file, call `beginClearSubmission()` → `ECLEAR_KILLED`, state
`HOLD:kill-switch-file` with resume_state checkpoint-confirmed; (b) separate
fixture, drop telemetry below threshold → `ECLEAR_PRESSURE_DROPPED`, state reset
toward idle with no clear_intent. Assert the CODES, not just any throw.
RED-FIRST: delete each re-check in a sandbox copy → its half must fail.

VECTOR 13. Ambiguous-hold resolution across restart: persist a
`HOLD:clear-ambiguous` state (inherited intent), construct a NEW transport over
the same memRoot (restart), then present a fresh `source=clear` boot receipt
with a newer boot_sequence via tick()'s manual-clear observation path. Must
transition to `released` with no resubmission and `_inheritedIntent` consumed.
RED-FIRST: mutate `confirmClearObserved`'s released transition in a sandbox copy
→ must fail.

VECTOR 14. Real-selector integration: ONE vector that does NOT override
`selectCapsuleFn` — build a real fixture vault (memory/capsules with one valid
capsule file in the repo's frontmatter format, runtime/stop-writer record bound
to it) and drive checkpoint evaluation through the REAL `selectCapsule` from
lifecycle-common.mjs. Proves the production default wiring end-to-end so drift
between lifecycle-common.mjs and evaluateCheckpointFreshness cannot ship silent.

VECTOR 15 (cheap drift guard). Session-id regex consistency: import/read both
`SAFE_SESSION_ID` (auto-clear-transport.mjs:47) and the regex inside
stop-capsule-writer.mjs's `sidIsConstrained` (line ~119) and assert they are
IDENTICAL (compare source strings). No production refactor — the test IS the
guard against drift.

REPORT: append a `## RUN 1 DELTA` section to RUN1-REPORT.md: vectors added,
each mutation→red evidence line, final counts. Do NOT edit the original report
text above it — corrections to the original's claims are the checker's to
append, not yours to rewrite.

Validation: run the new vectors + the full daemons discovery loop (per-file
`node <file>`, NOT `node --test <dir>` — Node24/win32 breaks on directory args).
All 27+ files green, `git diff --check` clean.
