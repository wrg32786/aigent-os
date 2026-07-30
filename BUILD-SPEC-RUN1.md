# BUILD SPEC — Standalone Auto-Clear Transport, RUN 1 (PTY-independent half)

You are building inside the aigent-os repository (a public, open-source agent
harness for the Claude Code CLI). This run implements ONLY the PTY-independent
components of a new "auto-clear transport." A later run adds the interactive
runner; nothing in this run may depend on node-pty or any new dependency.

HARD CONSTRAINTS
- No new dependencies of any kind. Node core modules only.
- No imports from / references to Pantheon, Room, board, bus, or any multi-agent
  concept — this repo is standalone-only.
- Follow the existing code style in `daemons/` (ESM .mjs, heavy explanatory
  header comments explaining WHY, injected-IO test seams).
- Reuse, never duplicate: `daemons/memory-hygiene/atomic-state.cjs` for atomic
  writes; `daemons/lifecycle-common.mjs` `selectCapsule()` for capsule selection
  (it stays the ONLY selector — you may wrap it, never re-implement it).
- Do not modify any file except: the new files below, the minimal wiring edit in
  `daemons/sessionstart-reinject.mjs`, and the telemetry fallback wiring.
- Every state transition must be driven by an OBSERVABLE (file content/mtime the
  CLI wrote), never by elapsed time alone. No sleep-as-proof anywhere.

DELIVERABLE 1 — `daemons/boot-receipt.mjs`
An atomic SessionStart boot receipt. Exported `writeBootReceipt({payload, memRoot})`
called as a LIBRARY from sessionstart-reinject.mjs (single-carrier pattern — the
same way resume-verb.mjs is carried; direct execution must no-op).
- Persists to `<memRoot>/runtime/boot-receipt.json` via atomic-state:
  `{ boot_sequence: <monotonic int>, session_id, source, observed_at: ISO }`.
- boot_sequence increments from the previous receipt (0-start when absent);
  corrupt/missing previous receipt → start fresh + append one line to the
  existing daemon error log pattern (see how other daemons use logErr).
- WIRING ORDER (this closes an F010 ordering dependency): in
  sessionstart-reinject.mjs, on EVERY boot the receipt writes FIRST; on
  source=clear the order is receipt → resume verb → anything nightly-related.
  Never break session start: any receipt error degrades to a no-op with a
  logged error, exit path unchanged.

DELIVERABLE 2 — context-pressure telemetry Node fallback
Find the current context-telemetry writer (the statusline script that persists
`~/.claude/ctx-refresh/<session_id>.json` with `used_percentage`; it currently
depends on `jq` and silently no-ops when jq is absent). Provide:
- `daemons/ctx-telemetry.mjs`: a Node implementation producing the identical
  file (same path, same fields), usable as the statusline command or fallback.
- Wire the existing shell path so missing jq falls back to the Node
  implementation instead of silently doing nothing.
- A reader helper `readPressure({sessionId, homeDir})` returning
  `{ pct, fresh, state }` where state ∈ 'ok' | 'stale' | 'missing' — stale =
  file mtime older than a configurable window (default 120s). Missing/stale is
  a NAMED state the transport surfaces loudly; it never silently disables.

DELIVERABLE 3 — `daemons/auto-clear-transport.mjs` (state machine CORE only)
The cycle state machine, PTY-free, every IO injected for tests. States:
`idle → pressure → checkpoint-requested → checkpoint-confirmed →
clear-submitted → clear-verified → released`, plus named HOLD states.
- Persisted cycle state at `<memRoot>/runtime/auto-clear-cycle.json` via
  atomic-state (single writer). Fields: `{ state, cycle_id, session_id,
  boot_sequence_at_start, clear_intent: {written_at, submitted: bool}|null,
  entered_at, hold: {code, detail}|null }`.
- CHECKPOINT FRESHNESS PREDICATE (three conjuncts, all required before any
  clear authorization):
  1. `selectCapsule()` returns a capsule;
  2. that capsule matches the current session's stop-writer state (compare the
     capsule's session binding against the current session id / stop-writer
     record — inspect `daemons/stop-capsule-writer.mjs` for what it persists
     and use its own fields, do not invent a parallel record);
  3. captured transcript offset reaches the current stable transcript size
     (transcript path shape: `~/.claude/projects/<slugified-cwd>/<session_id>.jsonl`;
     slug rule: every non-alphanumeric char of the cwd becomes '-').
  A stale active capsule must NEVER authorize a clear — a red test proves it.
- CLEAR INTENT (at-most-once): `clear_intent` persists BEFORE any submission
  would occur. The core exposes `beginClearSubmission()` (persists intent,
  returns a one-shot token) and `confirmClearObserved(bootReceipt)` (verifies a
  NEW boot receipt with source=clear and boot_sequence > start). On restart
  with intent present, `submitted` unknown/true, and NO new boot receipt →
  enter `HOLD:clear-ambiguous` LOUDLY; never auto-resubmit. A manual /clear
  (new receipt appearing while held) resolves the hold → released.
- SINGLE-RUNNER LOCK: `<memRoot>/runtime/auto-clear-transport.lock` with pid +
  start time; a second instance detecting a LIVE holder refuses loudly and
  exits nonzero; a stale lock (dead pid) is reclaimed with a logged line.
- KILL SWITCH: env `AUTO_CLEAR_OFF=1` or presence file
  `<memRoot>/runtime/auto-clear-off`; checked every tick; manual /clear is
  never gated by anything here.
- Guard-field discipline: every field a predicate filters on is asserted
  PRESENT in the object it receives; absent fields fail closed (held/refused)
  with a named reason — never treated as permissive.

DELIVERABLE 4 — tests, deterministic, in the repo's existing test layout
Inspect how `daemons/tests/*.test.mjs` are written and match that harness.
Every IO injected; a test-controlled clock; no wall-clock sleeps. Required RED
vectors (each must FAIL if its guard is removed — write them to discriminate):
1. checkpoint failure: selector rejects → HOLD + the selector's rejection
   ledger surfaced in the hold detail;
2. stale-capsule: selector returns a capsule bound to a PREVIOUS session /
   short transcript offset → clear authorization REFUSED;
3. duplicate clear: second beginClearSubmission() while intent active →
   refused by state machine;
4. crash between submit and verify: restart replay with intent present + no
   new receipt → HOLD:clear-ambiguous, no resubmission path exists;
5. restart with in-flight cycle at every persisted state → position re-derived
   from observables, completed steps recognized never repeated;
6. boot receipt: monotonic sequence, atomicity (tmp+rename), source=clear
   ordering ahead of resume in sessionstart-reinject;
7. telemetry: missing jq path produces the Node-written file; stale/missing
   telemetry returns the named degraded state and the state machine HOLDS
   rather than proceeding;
8. payload-integrity: a predicate input missing a filtered field fails closed
   with the named reason;
9. single-runner: live-lock refusal + stale-lock reclaim;
10. kill switch: env and presence file each stop cycle initiation same-tick.

ACCEPTANCE
- `node --test daemons/tests/` (or the repo's actual test invocation — inspect
  package.json / CI workflow and use that) passes with your additions;
- all existing tests still pass;
- a short `RUN1-REPORT.md` at repo root: files touched, test counts, every
  deviation from this spec with its reason, and the exact commands you ran.

If you hit a genuine ambiguity or missing information that would materially
change what you build, STOP. Do not guess. Emit exactly one line —
CODEX-BLOCKED: <question> — and end your turn.
