# BUILD SPEC — Standalone Auto-Clear Transport, RUN 2 (PTY runner half)

You are building inside the aigent-os repository (a public, open-source agent
harness for the Claude Code CLI). RUN 1 landed the PTY-independent core:
`daemons/auto-clear-transport.mjs` (state machine), `daemons/boot-receipt.mjs`,
`daemons/ctx-telemetry.mjs`, and their tests. This run adds the ONE remaining
piece: the interactive managed runner that hosts the Claude CLI inside a PTY,
owns its input, and performs the physical /clear submission the core authorizes.

HARD CONSTRAINTS
- Exactly ONE new dependency: `node-pty@1.1.0`, pinned exact (no range), added
  to package.json + lockfile. Install must work with `--ignore-scripts` — the
  tarball ships prebuilds for win32-x64/win32-arm64/darwin-x64/darwin-arm64, so
  no compile occurs (this is proven; do not add build tooling).
- node-pty must be OPTIONAL at runtime. When it cannot be loaded, the runner
  reports a NAMED loud degraded state (checkpoint + recovery remain available,
  auto-clear unavailable) and falls through to unmanaged behavior. Never a
  crash, never a silent disable.
- No imports from / references to Pantheon, Room, board, bus, or any
  multi-agent concept — this repo is standalone-only.
- REUSE THE RUN-1 CORE. The runner drives `AutoClearTransport`
  (`tick()` / `beginClearSubmission()` / `confirmClearObserved(bootReceipt)` /
  `close()`) plus the exported `acquireRunnerLock` / `releaseRunnerLock` /
  `readKillSwitch`. It never re-implements state logic, freshness predicates,
  intent persistence, or capsule selection. One state machine, one selector.
- Follow the existing code style in `daemons/` (ESM .mjs, heavy WHY header
  comments, injected-IO test seams). Every guard input asserted PRESENT;
  absent fields fail closed with a named reason.
- Do not modify any file except: the new files below, `launcher/aigent.sh`,
  `launcher/aigent.ps1`, `launcher/aigent.cmd`, and package.json + lockfile.
- Every state transition driven by an OBSERVABLE, never elapsed time alone.
  The transcript-freshness observable stays stat/size-based — transcript JSONL
  entry format is documented internal/unstable and must NEVER be parsed.

DELIVERABLE 1 — `daemons/pty-runner.mjs` (the managed runner)
- Spawns the `claude` CLI inside a node-pty pseudo-terminal and passes the
  session through transparently: stdin/stdout bytes, terminal resize, signal
  forwarding (SIGINT to the child), child exit status propagated as the
  runner's own exit code, and ALL manual slash commands — a manual /clear is
  always allowed and is never gated by any transport state.
- INPUT OWNERSHIP (binding, ADR amendment 6): the runner is the only writer to
  the child's stdin and tracks a known-empty state: operator bytes received
  but not yet submitted (no terminating CR) ⇒ NOT empty; an active
  paste/bracketed-paste or control sequence ⇒ NOT empty; anything unknown ⇒
  NOT empty (fail closed). Automatic /clear submission requires ALL of:
  current-session Stop/idle evidence · settled child output (stable observable,
  not a bare timer) · known-empty input · no active paste/control sequence ·
  the exclusive control-input lock held · current boot/session binding.
- SUBMISSION TRANSACTION (amendments 5 + 6): the runner calls
  `beginClearSubmission()` (which persists clear_intent) BEFORE the first byte
  of the control command is written to the PTY. The /clear write is one
  exclusive transaction — from first byte to submission verification no
  operator byte may interleave. The command is written as its own atomic
  control input, never appended behind existing buffered text. At most once:
  after the write, the ONLY path forward is `confirmClearObserved()` against a
  NEW boot receipt (source=clear, higher boot_sequence); on ambiguity the core
  holds and the runner NEVER rewrites the command.
- INPUT-HOLD RELEASE SEMANTICS (amendment 3, binding): while a cycle is
  between checkpoint confirmation and released, operator input is queued, not
  dropped. The hold cannot begin until checkpoint confirmed + clear_intent
  persisted + watchdog armed are ALL true. Every pre-submit abort — operator
  byte arriving, kill switch, failed checkpoint, cancellation — releases the
  hold and aborts the cycle IMMEDIATELY; the watchdog TTL is only the final
  safety fuse, never the normal release. Post-submit, queued input is
  delivered to the fresh context after resume release.
- CHILD TEARDOWN IS OWNED (measured, 6/6 reproducible): `p.kill()` from a
  parent that lingers makes node-pty's spawned conpty helper die with an
  `AttachConsole failed` stack trace. The runner must shut down deliberately —
  dispose data handlers, kill the child, then exit promptly or otherwise
  prevent the helper crash — so a long-lived headless run's log contains ZERO
  spurious stack traces. Log noise indistinguishable from real failure is a
  defect class this repo has already paid for.
- Lifecycle: acquire the single-runner lock at start (second instance refuses
  loudly, exits nonzero; stale lock reclaimed with a logged line); check
  `readKillSwitch` every tick; on kill switch the runner keeps hosting the
  session unmanaged (pass-through continues, automation stops).

DELIVERABLE 2 — launcher wrap (amendments 1 + 7)
`launcher/aigent.sh`, `launcher/aigent.ps1`, `launcher/aigent.cmd` become the
managed front door: by default, when node-pty is loadable, they launch the
session THROUGH the runner; `--no-deps` (and the existing kill-switch surfaces)
launches unmanaged deliberately; missing node-pty prints the named degraded
line and launches unmanaged. No new entrypoint is introduced; raw `claude`
remains a supported unmanaged fallback. Preserve each launcher's existing
behavior and style — this is a wrap, not a rewrite.

DELIVERABLE 3 — transport conformance suite (amendment 8)
`daemons/tests/transport-conformance.mjs`: a reusable suite importable with an
adapter object, asserting the observable transport contract (at-most-once
submission, fail-closed holds, immediate abort release, pass-through
invariants, single-runner refusal). The public runner must pass it via a fake
PTY seam. Downstream wrappers either reuse the public state machine or pass
this same suite — that is the suite's reason to exist as a named, reusable
artifact rather than inline tests.

DELIVERABLE 4 — tests, deterministic, in `daemons/tests/` matching the
existing harness (injected IO, test clock, no wall-clock sleeps). The PTY is a
seam: deterministic tests use a scripted fake; anything requiring real
node-pty is env-gated (skips loudly when unavailable) and not the sole proof
of any guard. Required RED vectors (each must FAIL if its guard is removed):
1. concatenation: operator bytes buffered unsubmitted → automatic /clear
   REFUSED; with the guard removed the command would append behind them;
2. busy seat: child output not settled / no Stop-idle evidence → no submission;
3. submit-accepted-but-no-clear: no new source=clear receipt → cycle stays
   held, and NO code path performs a second PTY write (at-most-once);
4. duplicate clear: second submission attempt while intent active → core
   refuses AND the runner writes zero bytes;
5. interleave-abort: operator byte mid-transaction pre-submit → immediate
   abort + immediate hold release (not TTL);
6. hold-release paths: kill switch, failed checkpoint, and cancellation EACH
   release the hold immediately; the TTL fuse still bounds the worst case;
7. teardown: the kill-then-linger shape produces no helper stack trace; with
   the teardown guard removed the crash reproduces;
8. pass-through: resize, SIGINT forwarding, child exit status, and a manual
   slash command all behave identically managed vs unmanaged (fake-PTY diff);
9. single-runner: live-lock refusal nonzero + stale-lock reclaim;
10. degraded mode: node-pty load failure → named loud state, unmanaged launch
    still works, checkpoint/recovery untouched.

OUT OF SCOPE (do not build, do not claim): the ≥20-cycle unattended live gate
(runs later, non-author, on a clean standalone install), any README/doc claim
changes, and the Pantheon-side input-hold enforcement.

ACCEPTANCE
- The repo's actual test invocation (inspect package.json / CI workflow and
  use that) passes with your additions; all existing tests still pass;
  `node --test daemons/tests/` remains green.
- `npm install --ignore-scripts` (or the repo's documented install) succeeds
  with the pinned dependency; lockfile committed.
- A short `RUN2-REPORT.md` at repo root: files touched, test counts, every
  deviation from this spec with its reason, and the exact commands you ran.

If you hit a genuine ambiguity or missing information that would materially
change what you build, STOP. Do not guess. Emit exactly one line —
CODEX-BLOCKED: <question> — and end your turn.
