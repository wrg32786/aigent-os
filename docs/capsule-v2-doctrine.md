---
title: Capsule v2 Doctrine
tags: [doctrine, capsule, state, somatic, phase2]
aliases: [Capsule v2, resumable capsules]
created: 2026-05-08
---

# Capsule v2 Doctrine

> [!info] Superseded by the two-verb lifecycle
> `/open` and `/close` are retired — see [[../docs/two-verb-lifecycle.md|Two-Verb Lifecycle]]. `/resume` absorbs `/open`, `/context-capsule` absorbs `/close`. **The field contract narrowed:** the trusted writer (`daemons/capsule-verb.mjs`, `validateCapsuleText`) requires and validates only four fields — `id`, `objective`, `waiting_on`, `next_valid_action`. The extended v2 fields tabled below (`resume_trigger`, `success_criteria`, `open_questions`, `last_verified_state`, etc.) are optional, advisory prose the writer neither requires nor enforces. Treat [[../docs/two-verb-lifecycle.md|Two-Verb Lifecycle]] — not this historical note — as the current contract.

> [!abstract] Key insight
> Capsules are resumable execution state, not summaries. (12-Factor Agents: unify execution state and business state.)

## Why capsules evolved

v1 capsules captured *what happened* and a resume prompt. But they lacked:
- **What we're waiting on** — is this blocked on the operator, an agent, a deploy, or an external person?
- **How to resume** — should `/resume` (or the SessionStart auto-resume) act on it, or wait for a manual trigger?
- **Success criteria** — how do we know when this work is done?
- **Verified state** — what was confirmed working, so we can detect drift on resume?

Without these fields, resuming a capsule required re-reading the full context and making judgment calls that the closing session already made.

## v1 to v2 schema diff

| Field | v1 | v2 | Enforced by the writer? |
|-------|----|----|----|
| `id` | - | stable identifier | **Required, validated** |
| `objective` | - | what this thread is about | **Required, validated** |
| `status` | active / resumed / resolved | (`paused` / `abandoned` were proposed but are unenforced — see note) | recorded, not validated |
| `waiting_on` | - | free-text resume contract | **Required, non-empty, never bare `null`** |
| `next_valid_action` | implicit in resume_prompt | explicit field | **Required, validated** |
| `resume_trigger` | - | file_change / manual / webhook | advisory only |
| `success_criteria` | - | list of criteria | advisory only |
| `open_questions` | - | list of unresolved questions | advisory only |
| `files_touched` | - | list of file paths | advisory only |
| `skills_used` | - | list of skill names | advisory only |
| `agents_used` | - | list of agent names | advisory only |
| `last_verified_state` | - | what was confirmed working | advisory only |

> [!warning] Only four fields are a contract
> `daemons/capsule-verb.mjs`'s `validateCapsuleText` requires exactly `id`, `objective`, `waiting_on`, `next_valid_action` and rejects an empty or bare-`null` `waiting_on` (`isUnquotedYamlNull` matches `null`/`Null`/`NULL`/`~`; a quoted `"null"` passes). `waiting_on` is **free text**, not an enum. Everything else in this table is optional prose kept for authoring guidance. `status` only ever takes `active` → `resumed` → `resolved` in shipped code — `paused` is read only by the retired `/pause` skill and rejected by `daemons/system-check.sh`; `abandoned` is written and read by nothing.

## How it connects

- `/context-capsule` — reconciles, writes a capsule with the four required fields (plus any advisory prose), then stops. It stamps nothing itself; the trusted writer (`daemons/capsule-verb.mjs`) validates and the pointer machinery records it.
- `/resume` — reads the capsule, recomputes `definition_hash` to detect drift, re-grounds, and executes `next_valid_action`. It does NOT write the status flip: the `active → resumed` transition is performed by `daemons/sessionstart-reinject.mjs` (via `flipCapsuleToResumed`), not by `/resume`.
- **Auto-fire** — a rolling, best-effort capsule write runs on every `Stop` (`daemons/stop-capsule-writer.mjs`); resume runs on `SessionStart(clear)` (`daemons/resume-verb.mjs`). The explicit verbs exist for deliberate mid-session checkpoints and named-capsule resumes.
- The retired `/open`, `/close`, and `/pause` skills still exist on disk but are deprecated — do not document them as live paths.

## Design sources

- **12-Factor Agents** — execution state and business state unified in the capsule itself. Recovery, serialization, and observability become trivial.
- **Memoir time-travel** — `last_verified_state` enables reproducing prior agent state. If state drifted, we know before acting on stale assumptions.

## Related

- [[Somatic Layer]] — capsules are one of five somatic organs
- [[Somatic v0.4.1 Wiring]] — v1 capsule resume offering (now via `/resume` / SessionStart auto-resume)
- [[concepts/Session Protocol]] — how sessions use capsules
- [[memory/BODY_STATE.json]] — where `last_capsule` is stored
