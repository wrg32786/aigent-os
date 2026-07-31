# BUILD-SPEC RUN 3 — gate-entry config surface (threshold + launcher pass-through)

Baseline: committed `3a1d66a` on `titus/f001-standalone-transport`, this
worktree. Tree must be clean before you start; refuse if not.

WHY (measured, GATE-HARNESS-BUILD-REPORT.md in the Titus vault): the live
gate's population line requires model haiku and ~15% bulk threshold through
the managed launcher front door. At 3a1d66a: `AutoClearTransport` defaults
`pressureThresholdPct` to 80 and the production `runPtySession` wiring never
passes an override — no env, no CLI, no settings surface; `aigent.sh` only
consumes `--no-deps` and forwards nothing. "Configurable context pressure"
(completion criterion 1) exists at the constructor and not for an operator.

## Scope — exactly two production behaviors, nothing else

1. **Threshold env surface at the PRODUCTION WIRING SITE** (pty-runner.mjs,
   where the transport is constructed — the core stays pure):
   - `AIGENT_PRESSURE_THRESHOLD_PCT` unset → production default (80),
     byte-for-byte current behavior.
   - Set and valid (integer 5–95 inclusive) → passed to the transport as
     `pressureThresholdPct`.
   - Set and INVALID (non-integer, out of range, empty) → automation does
     NOT arm; a loud named line `DEGRADED:auto-clear-threshold-invalid <raw>`
     is emitted through the same channel as the existing degraded lines, and
     the session continues unmanaged. Never silently fall back to the
     default: a mistyped threshold that quietly becomes 80 is a gate run
     against the wrong population (criterion 9: fail loud).
2. **Launcher pass-through of operator args** (aigent.sh, aigent.ps1,
   aigent.cmd): arguments after a literal `--` are forwarded verbatim to the
   managed claude invocation, AFTER the launcher's own fixed args
   (`/start` / `--continue /open` behavior unchanged when no `--` present;
   `--no-deps` still consumed by the launcher, never forwarded). This makes
   `aigent.sh -- --model haiku` the managed-front-door way to select the
   session model. No model logic in the launcher itself — it forwards, the
   CLI decides.

## Red-first vectors (each RED at 3a1d66a before its behavior lands)

- V1 threshold-applied: env=15 → transport constructed with 15 (bind at the
  real construction site via the existing injectable seams; not a fake-only
  assertion).
- V2 threshold-invalid-refuses: env=abc → named degraded line emitted AND
  automation disarmed (assert both halves; the line without the disarm is
  the lying half).
- V3 threshold-unset-default: env absent → 80 reaches the constructor (the
  no-regression twin; RED against a mutation that hardcodes the env path).
- V4 pass-through: `--` args appear verbatim, in order, after the fixed
  args in the spawned command for the sh launcher (extend the existing
  launcher command-shape tests); ps1 asserted to the same contract; cmd
  delegates to ps1 (existing test already binds delegation — do not
  duplicate it).
- V5 no-dash-dash unchanged: absent `--`, the spawned command is
  byte-identical to 3a1d66a's shape (RED against the pass-through change
  itself if it perturbs the default path).

## Constraints

- Files allowed: daemons/pty-runner.mjs · launcher/aigent.sh ·
  launcher/aigent.ps1 · launcher/aigent.cmd · daemons/tests/
  pty-runner.test.mjs. NOTHING else; auto-clear-transport.mjs untouched.
- Six-step runtime contract untouched; no new state, no new persisted
  fields; every added guard names its committed red vector (Ponytail gate
  applies to this delta at review).
- Suites stay hermetic: env-var tests set/unset within the test, never
  depend on ambient env.
- Do NOT commit. Leave the tree with your changes + RUN3-REPORT.md at the
  worktree root: what changed, every vector's red evidence (verbatim
  failure lines) then green, deviations named or "zero deviations, stated."
  The commit rides the titus review chain.

If blocked, write CODEX-BLOCKED with the exact blocker into RUN3-REPORT.md
and stop — never substitute scope.
