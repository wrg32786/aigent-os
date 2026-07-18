---
title: Two-Verb Lifecycle
tags: [doctrine, capsule, lifecycle, resume, session-management]
aliases: [two-verb, capsule verb, resume verb]
created: 2026-07-17
---

# Two-Verb Lifecycle

> [!abstract] Core idea
> Session continuity collapses to exactly two verbs — `/context-capsule` (write state, then stop) and `/resume` (load state, re-ground, act). `/open` and `/close` are retired: resume absorbs open, the capsule verb absorbs close. Both verbs also fire automatically at the right SessionStart/Stop hook points, so the operator rarely needs to invoke them by name.

This doc is the design reference for `skills/context-capsule/SKILL.md`, `skills/resume/SKILL.md`, and the daemons that implement them. Edit those files in lockstep with this one — this doc is the authored source; the skill files and daemon prompts are its runtime artifacts.

## Why two verbs, not four

The prior generation had four session-lifecycle skills: `/open` (load context), `/close` (commit memory), `/context-capsule` (checkpoint state), `/pause` (mid-session checkpoint). In practice `/open` and `/close` were always paired with a capsule write/read anyway — the capsule *was* the state that made open/close meaningful. Collapsing to two verbs removes the duplication:

- **`/context-capsule`** is the only way state gets written. It absorbs `/close` — there is no separate close ceremony, and no separate `/pause` either (a mid-session checkpoint is just an early capsule).
- **`/resume`** is the only way state gets loaded and acted on. It absorbs `/open` — there is no separate open ceremony.

Both verbs also run automatically, at the two points in a session's lifecycle where they matter most: `/resume`'s procedure fires on `SessionStart(clear)` via `daemons/resume-verb.mjs`, and a rolling, best-effort version of `/context-capsule`'s write runs on every `Stop` event via `daemons/stop-capsule-writer.mjs`. The explicit skill invocations exist for the cases automation doesn't cover: a deliberate mid-session checkpoint, a named-capsule resume, or a handoff.

## The capsule schema

Every capsule is a markdown file with YAML frontmatter. Four fields are REQUIRED and validated by the trusted writer (`daemons/capsule-verb.mjs`'s `validateCapsuleText()`):

| Field | Meaning |
|---|---|
| `id` | Stable identifier, non-empty |
| `objective` | What this thread of work is about, non-empty |
| `waiting_on` | The resume contract — what a fresh session needs to act, non-empty, never bare YAML `null` |
| `next_valid_action` | The concrete next step, non-empty |

Plus `parent_capsule_id`, `status` (`active → resumed → resolved`, also `paused`/`abandoned`), `trigger`, `expires`, `tags`, `created_at`, `resolved_at`, and `definition_hash` — the first 12 hex characters of `sha256(objective + next_valid_action)`, a cheap drift detector: `/resume` recomputes it against the live frontmatter and refuses to trust a capsule whose hash no longer matches its own content.

The body carries seven `[REFERENCE ONLY]` sections behind HTML anchor comments (`<!-- swe:done -->` etc.) that `stop-capsule-writer.mjs` merges bullets into: `Done (don't redo)`, `Historical-Errors → Resolutions`, `Historical-Rejected-Approaches`, `Files-Read / Files-Modified`, `Operating-Facts`, `Pending-Gates`, `Claimed-Rows`. "Historical-" prefixes and latest-wins framing are deliberate — body content is a *reference snapshot*, never an active instruction queue. Treating it as one is exactly the trap `/resume`'s fences exist to prevent.

## The content gate

`daemons/capsule-content-gate.mjs` is a zero-dependency vocabulary shared by both enforcement points (`capsule-verb.mjs`'s validator and `stop-capsule-writer.mjs`'s classifier). It rejects two failure classes that non-empty checks alone miss:

- **Injection echo** — an `objective` that is actually a harness/supervisor instruction verbatim (`[supervisor-resume]`, `[refresh-cycle]`, `[auto-pull]`, an inbox marker, a loop-tick banner...). Non-null, but not the operator's real objective.
- **Ceremony action** — a `next_valid_action` that opens with resume-boot ceremony text ("re-read the active turn state...") instead of real content. Non-null, but tells a fresh session nothing it can act on.

Both patterns are START-ANCHORED: a capsule that legitimately *references* the ceremony mid-action ("On resume: comply with the supervisor-resume instruction, then...") passes — only text that *is* the injection/ceremony fails.

## The trusted writer

`daemons/capsule-verb.mjs`'s `runCapsuleVerb()` is the one path that stamps a capsule pointer. The model authors capsule prose; this module is the authority that deterministic reconciliation ran:

1. Validates the capsule text (content gate + required fields).
2. Collects evidence — `daemons/reconcile-collector.mjs` gathers read-only git state (index tree + working tree digests, branch, HEAD) always, and pluggable board evidence (see below) if an adapter is configured.
3. Computes `reconcile_digest` — a canonical SHA-256 over the evidence object, so two runs against unchanged state produce an identical digest.
4. Shells out to `daemons/curated-close-pointer.mjs`, which alone writes the pointer at `vault/memory/BODY_STATE.json`'s `state.last_capsule`.
5. Reads the pointer back and verifies every stamped field matches what was computed — a mismatch refuses loudly rather than trusting the write blindly.

A refusal (`CapsuleVerbRefusal`) never stamps anything and always names the specific problem, so a caller (human or automated) knows exactly what to fix.

## Pluggable evidence: the board adapter

aigent-OS ships no task-board integration by default — `evidence.board` degrades honestly to `null`, a valid, documented state. To wire a real task-board (Linear, a Postgres-backed board, anything), point `AIGENT_BOARD_ADAPTER` at a module exporting:

```js
export async function collectBoardEvidence({ seatId, boardRowIds }) {
  // boardRowIds is null for "everything this identity created or claimed",
  // else an explicit array of row ids. Return { query, rows } or null.
}
```

`reconcile-collector.mjs` computes the canonical digest itself — adapters never compute or trust their own digest, which keeps the evidence class reproducible regardless of the adapter's own bugs.

## Pluggable coordination: multi-agent guard

If a fork wires multiple agents/sessions that need to pause for a conducted, multi-party lifecycle event (a coordinated clear across several concurrent sessions, for example), point `AIGENT_COORDINATION_STATE` at a JSON file carrying a `phase` field. While `phase` is non-terminal (anything other than `done`/`cancelled`/`closed`/`complete`/`aborted`), both `sessionstart-reinject.mjs` and `ctx-refresh-sensor.mjs` defer to the external conductor instead of running their own lifecycle logic. Unset by default — a single-operator install never touches this seam.

## The supervisor cycle (context-pressure self-refresh)

`daemons/ctx-refresh-sensor.mjs` is a `PreToolUse` hook implementing a single-session self-refresh reflex: at 60% context usage it nudges a capsule-then-clear/compact; at 75% it escalates to mandatory `/clear`; it re-arms below 50%, and re-nudges every +5 points while armed to avoid going silent between 60% and 90%.

This reflex depends on an **optional** integration: something must write `~/.claude/ctx-refresh/<session-id>.json` with a `used_percentage` field (a statusline script is the natural place). Nothing in this port writes that file — if it's absent, the sensor is silently inert (checked first, before any other logic runs). Wiring a percentage-tracking statusline is a documented but unbundled integration point.

Behind an opt-in flag (`CAPSULE_VERB_AUTOFIRE=1`), the sensor can also drive the trusted writer automatically: it waits for the transcript to fall genuinely still (two identical capture-cursor reads separated by an age floor, guarding against reading mid-flush), then calls `runCapsuleVerb()` in dry-run mode by default. A real, request-gated cycle (`daemons/refresh-request.mjs` + `daemons/refresh-cycle.mjs`) exists for a controller that wants to mint a nonce-bound refresh challenge and verify the receipt — none of that fires unless something writes a `RefreshRequest` file, which, like the board adapter, ships as a seam rather than a default behavior.

## Operator sovereignty (never violate)

- **The capsule is best-effort autosave, never a gate.** An operator `/clear` passes through whether or not a capsule landed. Nothing in this system should ever tell the operator to wait on capsule machinery.
- **A session rotation satisfies any pending refresh cycle** — never re-arm or service a stale cycle against a fresh session.
- **`/context-capsule` goes quiet after writing.** If an automated refresh cycle is active, the seal fires on transcript stillness; every extra tool call after the write resets that clock.

## Known issue (documented, not fixed here)

`stop-capsule-writer.mjs`'s `skeleton()` template seeds a fresh autosave capsule with `waiting_on: null`. The content gate correctly treats a bare YAML `null` as empty (not a resumable receipt), which means a fresh autosave capsule can never pass `validateCapsuleText()` as-is — an automated refresh cycle that tries to stamp a freshly-created autosave capsule mid-session will be refused until the operator (or a later turn's delta merge) fills in a real `waiting_on`. This is a real architectural gap carried over from the source system, not a design choice, and it ships as-is in this port. The fix — most likely deferring the trusted-writer stamp until a capsule has left skeleton state, or seeding a non-null placeholder that the content gate treats distinctly from a deliberate empty value — is planned as a follow-up commit on this branch, not bundled into the port itself.

## File map

| File | Role |
|---|---|
| `daemons/lifecycle-common.mjs` | Shared identity/vault resolution, the `flipCapsuleToResumed` CRLF-safe frontmatter flip |
| `daemons/capsule-content-gate.mjs` | Injection-echo / ceremony-action vocabulary |
| `daemons/capsule-verb.mjs` | Trusted-writer orchestration for the capsule verb |
| `daemons/curated-close-pointer.mjs` | The one write path for the pointer stamp |
| `daemons/resume-verb.mjs` | Resume verb container — SessionStart(clear) hook |
| `daemons/sessionstart-reinject.mjs` | Warm-start pointer-table reinject — SessionStart(all sources) hook |
| `daemons/stop-capsule-writer.mjs` | Every-turn rolling capsule delta writer — Stop hook |
| `daemons/reconcile-collector.mjs` | Deterministic evidence collection (git always, board pluggable) |
| `daemons/effect-receipts.mjs` | Append-only external-effect receipt ledger (business-OS seam) |
| `daemons/refresh-cycle.mjs` | The transactional cycle-record data shape |
| `daemons/refresh-request.mjs` | The controller→session challenge-crossing request |
| `daemons/refresh-cursor.mjs` | The capture-cursor primitive (byte-exact transcript position) |
| `daemons/ctx-refresh-sensor.mjs` | Context-pressure self-refresh reflex — PreToolUse hook |
| `skills/context-capsule/SKILL.md` | The capsule verb, explicit invocation |
| `skills/resume/SKILL.md` | The resume verb, explicit invocation |

## A note on the merged SessionStart hook

The source system this was ported from ran two separate SessionStart scripts because it coordinated several concurrent agent identities, each with its own hook-matcher wiring quirks. aigent-OS is single-operator, so `sessionstart-reinject.mjs` handles every source (`startup`, `resume`, `clear`, `compact`) in one file — there's no per-agent matcher split to preserve. If a fork later adds genuine multi-identity support, re-splitting by source is a reasonable place to start, but nothing in the current architecture requires it.
