---
title: Two-Verb Lifecycle
tags: [doctrine, capsule, lifecycle, resume, session-management]
aliases: [two-verb, capsule verb, resume verb]
created: 2026-07-17
---

# Two-Verb Lifecycle

> [!note] v0.9.0 — minimal model
> v0.9.0 ships the minimal two-verb model: `/resume` selects the **newest capsule by date** — the earlier beta's "stale/spent capsule" bug is designed out, not patched around. The nonce/receipt handshake, pointer bookkeeping, and polling cycle-driver from that beta are removed entirely; newest-by-date selection replaces the guarantee they existed to provide.

> [!abstract] Core idea
> Session continuity collapses to exactly two verbs — `/context-capsule` (write state, then stop) and `/resume` (load state, re-ground, act). `/open` and `/close` are retired: resume absorbs open, the capsule verb absorbs close. Both verbs also fire automatically at the right SessionStart/Stop hook points, so the operator rarely needs to invoke them by name.

This doc is the design reference for `skills/context-capsule/SKILL.md`, `skills/resume/SKILL.md`, and the daemons that implement them. Edit those files in lockstep with this one — this doc is the authored source; the skill files and daemon prompts are its runtime artifacts.

## Why two verbs, not four

The prior generation had four session-lifecycle skills: `/open` (load context), `/close` (commit memory), `/context-capsule` (checkpoint state), `/pause` (mid-session checkpoint). In practice `/open` and `/close` were always paired with a capsule write/read anyway — the capsule *was* the state that made open/close meaningful. Collapsing to two verbs removes the duplication:

- **`/context-capsule`** is the only way state gets written. It absorbs `/close` — there is no separate close ceremony, and no separate `/pause` either (a mid-session checkpoint is just an early capsule).
- **`/resume`** is the only way state gets loaded and acted on. It absorbs `/open` — there is no separate open ceremony.

Both verbs also run automatically, at the two points in a session's lifecycle where they matter most: `/resume`'s procedure fires on `SessionStart(clear)` via `daemons/resume-verb.mjs`, and a rolling, best-effort version of `/context-capsule`'s write runs on every `Stop` event via `daemons/stop-capsule-writer.mjs`. The explicit skill invocations exist for the cases automation doesn't cover: a deliberate mid-session checkpoint, a named-capsule resume, or a handoff.

## The capsule schema

Every capsule is a markdown file with YAML frontmatter. Four fields are REQUIRED and validated by `daemons/capsule-verb.mjs`'s `validateCapsuleText()`:

| Field | Meaning |
|---|---|
| `id` | Stable identifier, non-empty |
| `objective` | What this thread of work is about, non-empty |
| `waiting_on` | The resume contract — what a fresh session needs to act, non-empty, never bare YAML `null` |
| `next_valid_action` | The concrete next step, non-empty |

Plus `parent_capsule_id`, `status` (`active → resumed → resolved`, also `paused`/`abandoned`), `trigger`, `expires`, `tags`, `created_at`, and `resolved_at`. `resume_trigger` and `success_criteria` are optional, additional fields a skill may include when they add real signal.

The body carries seven `[REFERENCE ONLY]` sections behind HTML anchor comments (`<!-- swe:done -->` etc.) that `stop-capsule-writer.mjs` merges bullets into: `Done (don't redo)`, `Historical-Errors → Resolutions`, `Historical-Rejected-Approaches`, `Files-Read / Files-Modified`, `Operating-Facts`, `Pending-Gates`, `Claimed-Rows`. "Historical-" prefixes and latest-wins framing are deliberate — body content is a *reference snapshot*, never an active instruction queue. Treating it as one is exactly the trap `/resume`'s fences exist to prevent.

## The content gate

`daemons/capsule-content-gate.mjs` is a zero-dependency vocabulary shared by both enforcement points (`capsule-verb.mjs`'s validator and `stop-capsule-writer.mjs`'s classifier). It rejects two failure classes that non-empty checks alone miss:

- **Injection echo** — an `objective` that is actually a harness/supervisor instruction verbatim (`[supervisor-resume]`, `[refresh-cycle]`, `[auto-pull]`, an inbox marker, a loop-tick banner...). Non-null, but not the operator's real objective.
- **Ceremony action** — a `next_valid_action` that opens with resume-boot ceremony text ("re-read the active turn state...") instead of real content. Non-null, but tells a fresh session nothing it can act on.

Both patterns are START-ANCHORED: a capsule that legitimately *references* the ceremony mid-action ("On resume: comply with the supervisor-resume instruction, then...") passes — only text that *is* the injection/ceremony fails.

## Validation

`daemons/capsule-verb.mjs` exports `validateCapsuleText()` — the one place required-field presence and the content gate (above) are checked together. It returns `{ fields, problems }`; an empty `problems` array means the four required fields are present and neither `objective` nor `next_valid_action` is injection-echo or ceremony-action. There is no separate trusted-writer process that stamps a pointer or a digest — the operator (or the model, acting on the operator's behalf) writes the capsule file directly, and `validateCapsuleText()` is available as a utility for a skill or a test to self-check.

## Pluggable coordination: multi-agent guard

If a fork wires multiple agents/sessions that need to pause for a conducted, multi-party lifecycle event (a coordinated clear across several concurrent sessions, for example), point `AIGENT_COORDINATION_STATE` at a JSON file carrying a `phase` field. While `phase` is non-terminal (anything other than `done`/`cancelled`/`closed`/`complete`/`aborted`), `sessionstart-reinject.mjs` defers to the external conductor instead of running its own warm-start orientation or resume-verb procedure — this guard is checked before the `source==='clear'` branch, so a live coordinator wins even across a clear. Unset by default — a single-operator install never touches this seam.

## Context-pressure self-refresh (retired in v0.9.0)

`daemons/ctx-refresh-sensor.mjs` is now a compatibility stub (`process.exit(0)`) — the 60%/75% self-refresh reflex, the `CAPSULE_VERB_AUTOFIRE` autofire path, and the request-gated refresh cycle it depended on (`refresh-request.mjs`, `refresh-cycle.mjs`, `refresh-cursor.mjs`) are removed along with the rest of the tower. The file is kept only because an existing `settings.json` may still name it as a `PreToolUse` hook; it does nothing when invoked. `daemons/statusline-ctx.sh` still writes `~/.claude/ctx-refresh/<session-id>.json` — nothing in the box currently reads that file, but a fork is free to re-wire its own sensor against it.

## Operator sovereignty (never violate)

- **The capsule is best-effort autosave, never a gate.** An operator `/clear` passes through whether or not a capsule landed. Nothing in this system should ever tell the operator to wait on capsule machinery.

## Known issue — resolved by removal

The v0.9.0 beta's known issue (an automated refresh cycle could try to stamp a fresh, still-`waiting_on: null` autosave capsule and be refused) no longer applies: v0.9.0 minimal removes the automated stamping path entirely (see "Context-pressure self-refresh" above). `validateCapsuleText()` still treats a bare `waiting_on: null` as not-yet-resumable — that check is correct and unchanged — but nothing calls it against an in-flight autosave capsule anymore. It only matters when a skill or test explicitly validates a capsule that's meant to be a resume source.

## File map

| File | Role |
|---|---|
| `daemons/lifecycle-common.mjs` | Shared identity/vault resolution, `newestValidCapsule()` selection |
| `daemons/capsule-content-gate.mjs` | Injection-echo / ceremony-action vocabulary |
| `daemons/capsule-verb.mjs` | `validateCapsuleText()` — required fields + content gate |
| `daemons/curated-close-pointer.mjs` | Compatibility pointer writer (audit/orientation hint only — resume never reads it) |
| `daemons/resume-verb.mjs` | Resume verb container — SessionStart(clear) hook |
| `daemons/sessionstart-reinject.mjs` | Warm-start reinject + resume-verb carrier — SessionStart(all sources) hook |
| `daemons/stop-capsule-writer.mjs` | Every-turn rolling capsule delta writer — Stop hook |
| `daemons/ctx-refresh-sensor.mjs` | Compatibility stub (PreToolUse) — self-refresh reflex retired |
| `daemons/statusline-ctx.sh` | Context-percentage writer (currently unread by anything in the box) |
| `skills/context-capsule/SKILL.md` | The capsule verb, explicit invocation |
| `skills/resume/SKILL.md` | The resume verb, explicit invocation |

## A note on the merged SessionStart hook

The source system this was ported from ran two separate SessionStart scripts because it coordinated several concurrent agent identities, each with its own hook-matcher wiring quirks. aigent-OS is single-operator, so `sessionstart-reinject.mjs` handles every source (`startup`, `resume`, `clear`, `compact`) in one file — there's no per-agent matcher split to preserve. If a fork later adds genuine multi-identity support, re-splitting by source is a reasonable place to start, but nothing in the current architecture requires it.
