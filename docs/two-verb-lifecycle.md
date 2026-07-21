---
title: Two-Verb Lifecycle
tags: [doctrine, capsule, lifecycle, resume, session-management]
aliases: [two-verb, capsule verb, resume verb]
created: 2026-07-17
---

# Two-Verb Lifecycle

> [!warning] Beta (v0.9.0) — known issue, fix in progress
> This lifecycle ships as **v0.9.0, BETA**. Known issue, currently being fixed: capsule/resume selection can, in some cases, resume a stale or already-consumed capsule — the "newest valid capsule" check does not yet reject a spent capsule. Separately, auto-commit of the vault to git is not yet wired safely. A fix is in progress and will be ported here once verified; this doc will be updated when it lands. Until then, treat capsule/resume selection as best-effort, not a hard guarantee.

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

This reflex depends on one integration: something must write `~/.claude/ctx-refresh/<session-id>.json` with a numeric `used_percentage` field. `daemons/statusline-ctx.sh` is that writer — a statusline wrapper wired through the template's `statusLine` entry. On every statusline refresh it persists `{"used_percentage": N, "ts": "..."}` for the current session (atomic tmp+rename, so the sensor never reads a torn file) and prunes sensor files idle more than 7 days (session ids rotate on `/clear`; old files are dead), then delegates the visible status line unchanged to `~/.claude/statusline-command.sh` when that exists (the conventional home of an operator's own statusline script — override the path with `AIGENT_STATUSLINE_DELEGATE`), falling back to a minimal model-name + ctx-% line. The write degrades to a no-op without `jq`, and if the file is absent the sensor is silently inert (checked first, before any other logic runs) — so a missing or unwired statusline can never error the lifecycle. To opt out of the bundled writer, drop the `statusLine` entry from `settings.json`; the sensor then waits for whatever integration the operator wires instead.

Behind an opt-in flag (`CAPSULE_VERB_AUTOFIRE=1`), the sensor can also drive the trusted writer automatically: it waits for the transcript to fall genuinely still (two identical capture-cursor reads separated by an age floor, guarding against reading mid-flush), then calls `runCapsuleVerb()` in dry-run mode by default. A real, request-gated cycle (`daemons/refresh-request.mjs` + `daemons/refresh-cycle.mjs`) exists for a controller that wants to mint a nonce-bound refresh challenge and verify the receipt — none of that fires unless something writes a `RefreshRequest` file, which, like the board adapter, ships as a seam rather than a default behavior.

## Completion signal vs. checkpoint (close_kind)

Two distinct wake-relevant signals exist, and it is easy to conflate them because both eventually touch the same pointer field (`close_kind`, at `state.last_capsule`).

- **Checkpoint (machinery).** The autofire sensor's stillness-seal is a *checkpoint*, never a completion. When it drives the trusted writer (`runCapsuleVerb()` → `curated-close-pointer.mjs`), the writer's own `writerArgs` unconditionally stamp `close_kind: 'checkpoint'` — a cycle-driven capture and a legacy non-cycle capture are both machinery, regardless of the transcript-stillness mechanics that triggered them. A checkpoint stamp never, by itself, wakes anything downstream.
- **Completion (voluntary close).** Finalizing the rolling capsule — the operator (or `/context-capsule`) writes a real `waiting_on` into the file `state.capsule_path` already points at — *is* the completion signal. The very next `Stop` hook's `stop-capsule-writer.mjs` observes that this session's own designated capsule has left skeleton (`capsuleLeftSkeleton()`), advances the pointer to it, and stamps `close_kind: 'completion'` with no `cycle_id` (a voluntary close is not a cycle receipt — the two are kept intentionally distinguishable so a downstream wake discriminator can require `close_kind === 'completion'` without ever matching a checkpoint). This stamp happens automatically, from the trusted stop-writer, not from the skill or the agent — the fence below still holds.
- **One stamp per freeze episode.** Once the stop-writer stamps completion, it also reroutes `state.capsule_path` to a fresh, unfinalized companion capsule (the R2-2 byte-freeze: a finalized capsule's bytes are never touched again). Every subsequent `Stop` hook in the same session merges into that fresh skeleton — never finalized, never advancing the pointer — so the pointer, and its `close_kind: 'completion'` stamp, stay untouched until a genuinely new finalize happens. A session cannot double-fire its own completion signal by continuing to work after closing.
- **Agents still never stamp anything themselves.** None of the above changes `/context-capsule`'s own fence (`Do NOT stamp digests, pointer, or cycle_token — trusted-writer territory`). The skill's whole job is still: reconcile, write the capsule with a real `waiting_on`, then stop. Finalizing the capsule *is* the completion signal — the stop-writer's automatic stamp is what turns that fact into machinery the rest of the system can key on.

## Operator sovereignty (never violate)

- **The capsule is best-effort autosave, never a gate.** An operator `/clear` passes through whether or not a capsule landed. Nothing in this system should ever tell the operator to wait on capsule machinery.
- **A session rotation satisfies any pending refresh cycle** — never re-arm or service a stale cycle against a fresh session.
- **`/context-capsule` goes quiet after writing.** If an automated refresh cycle is active, the seal fires on transcript stillness (the checkpoint path above); every extra tool call after the write resets that clock. Finalizing the capsule is a separate, immediate completion signal (previous section) and does not depend on stillness at all.

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
| `daemons/statusline-ctx.sh` | Context-percentage writer — statusLine wrapper feeding the sensor |
| `skills/context-capsule/SKILL.md` | The capsule verb, explicit invocation |
| `skills/resume/SKILL.md` | The resume verb, explicit invocation |

## A note on the merged SessionStart hook

The source system this was ported from ran two separate SessionStart scripts because it coordinated several concurrent agent identities, each with its own hook-matcher wiring quirks. aigent-OS is single-operator, so `sessionstart-reinject.mjs` handles every source (`startup`, `resume`, `clear`, `compact`) in one file — there's no per-agent matcher split to preserve. If a fork later adds genuine multi-identity support, re-splitting by source is a reasonable place to start, but nothing in the current architecture requires it.
