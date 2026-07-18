---
title: Zero-Leak Flush Legs
tags: [doctrine, capsule, lifecycle, session-management, durability]
aliases: [zero-leak, utterance journal, session-end flush, precompact flush]
created: 2026-07-17
---

# Zero-Leak Flush Legs

> [!abstract] Core idea
> The Stop-hook capsule writer makes disk state at most one turn stale — but only on paths where Stop actually fires. Three companion legs close the remaining crash windows: a **write-ahead utterance journal** at `UserPromptSubmit` (nothing counts as "heard" until it is on disk), a **final flush** at `SessionEnd` (Stop does not fire on clear/logout/exit), and a **pre-compaction flush + ToC inject** at `PreCompact` (the compactor summarizes against a current capsule and carries pointers into the vault, not content).

This doc is the design reference for `daemons/userpromptsubmit-journal.mjs`, `daemons/sessionend-flush.mjs`, and `daemons/precompact-flush.mjs`. It extends the two-verb lifecycle (`docs/two-verb-lifecycle.md`) — read that first; these legs assume its capsule schema, its `BODY_STATE.json` pointer, and its `stop-capsule-writer.mjs` worker.

## The three crash windows

| Window | Leg | Hook |
|---|---|---|
| Crash between prompt-submit and Stop loses the operator's words | Write-ahead utterance journal | `UserPromptSubmit` |
| Session ends via clear/logout/exit — Stop never fires, the final delta dies with the process | Final synchronous flush + journaled session boundary | `SessionEnd` |
| Compaction summarizes over a capsule that lags the final turn | Synchronous flush, then a capsule ToC printed for the compactor | `PreCompact` |

## The write-ahead journal

`userpromptsubmit-journal.mjs` appends the RAW prompt to `vault/memory/runtime/utterance-journal.jsonl` before the model sees it — write-ahead-log semantics, capture-at-landing. The capsule carries the tagged/bounded rendering of a turn; the journal carries the truth, unabridged. Structured (non-string) prompts are journaled in JSON form rather than dropped.

Two hard rules:

- **It never prints.** `UserPromptSubmit` stdout is injected into the turn's context.
- **A drop is never silent.** Every path that fails to journal a prompt logs to `<memRoot>/.daemon-errors.log` before exiting 0.

Rotation: past `LIFECYCLE_JOURNAL_MAX_BYTES` (default 16 MiB) the file rolls to a dated sidecar first. Kill-switch: `LIFECYCLE_KILL_JOURNAL=1`.

`sessionend-flush.mjs` appends `session-end` event lines to the same journal — a replay can pair every prompt with its session boundary and the fate (`flushed` / `noop:*` / `error:*`) of that session's final flush.

## The worker contract

Both flush legs run the SAME worker the Stop hook uses — `stop-capsule-writer.mjs --worker` — synchronously, and parse its machine-readable `SWE_OUTCOME:<class>` line. Exit-0 alone is never treated as "flushed": `noop:no-delta`, `noop:lock-defer`, and `noop:no-transcript` all exit 0 and mean different things. The worker's per-session lock serializes these legs against any in-flight Stop write; a lock loss at PreCompact means the Stop side is already carrying the delta, while a lock loss at SessionEnd is logged distinctly (there is no next turn to retry — the concurrent detached Stop worker has to survive process teardown, which is unconfirmed on Windows).

Timeout budgets are layered deliberately: the SessionEnd leg gives the worker 5000ms inside an outer hook timeout of 8000ms; the PreCompact leg gives it 6000ms inside 10000ms. Node cold-start is ~1.6s idle and worse under AV/disk load — an outer timeout that guillotines the inner worker converts healthy-but-slow flushes into false failures.

## Operator sovereignty (fail-soft default)

Per the two-verb doctrine: the capsule is best-effort autosave, **never a gate**. All three legs exit 0 on their own failures, and the PreCompact leg's default posture on an OBSERVED flush failure is warn-loudly-and-proceed — the ToC carries the warning, `.daemon-errors.log` carries the detail, and the utterance journal backstops the window. Compaction is never held hostage to capsule machinery.

Forks that prefer the strict zero-leak posture — never compact over a capsule known to be stale — can set `LIFECYCLE_PRECOMPACT_STRICT=1`, which turns the fail class (worker crashed / timed out / no outcome signal) into `decision:block` + exit 2. Even strict mode never blocks on: healthy outcomes, a lock deferral (the Stop side carries the delta), an unobservable delta (possibly the platform not delivering `transcript_path`), the deliberate `LIFECYCLE_KILL_STOP_WRITER=1` disable, or a failure of the observer script itself — block on observed flush failure, never on observer failure.

## File map

| File | Role |
|---|---|
| `daemons/userpromptsubmit-journal.mjs` | Write-ahead utterance journal — `UserPromptSubmit` hook |
| `daemons/sessionend-flush.mjs` | Final flush + journaled session boundary — `SessionEnd` hook |
| `daemons/precompact-flush.mjs` | Pre-compaction flush + capsule ToC inject — `PreCompact` hook |
| `daemons/tests/userpromptsubmit-journal.test.mjs` | WAL contract: raw capture, silence, rotation, loud drops |
| `daemons/tests/sessionend-flush.test.mjs` | Session-end crash window: real worker flush, event line, benign-vs-alarm |
| `daemons/tests/precompact-flush.test.mjs` | Flush-outcome/ToC matrix, dangling pointer, fail-soft vs strict |
