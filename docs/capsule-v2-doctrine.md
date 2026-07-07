---
title: Capsule v2 Doctrine
tags: [doctrine, capsule, state, somatic, phase2]
aliases: [Capsule v2, resumable capsules]
created: 2026-05-08
---

# Capsule v2 Doctrine

> [!abstract] Key insight
> Capsules are resumable execution state, not summaries. (12-Factor Agents: unify execution state and business state.)

## Why capsules evolved

v1 capsules captured *what happened* and a resume prompt. But they lacked:
- **What we're waiting on** — is this blocked on Will, an agent, a deploy, or an external person?
- **How to resume** — should /open offer it, or wait for a manual trigger?
- **Success criteria** — how do we know when this work is done?
- **Verified state** — what was confirmed working, so we can detect drift on resume?

Without these fields, resuming a capsule required re-reading the full context and making judgment calls that the closing session already made.

## v1 to v2 schema diff

| Field | v1 | v2 |
|-------|----|----|
| `status` | active / resumed / resolved | + `paused` / `abandoned` |
| `waiting_on` | - | will / agent / tool / external / null |
| `resume_trigger` | - | open / file_change / manual / webhook |
| `next_valid_action` | implicit in resume_prompt | explicit field |
| `success_criteria` | - | list of criteria |
| `open_questions` | - | list of unresolved questions |
| `files_touched` | - | list of file paths |
| `skills_used` | - | list of skill names |
| `agents_used` | - | list of agent names |
| `last_verified_state` | - | what was confirmed working |

## How it connects

- `/context-capsule` — creates capsules with full v2 schema
- `/pause` — creates a `paused` capsule mid-session with `waiting_on` set
- `/resume` — reads capsule, verifies state hasn't drifted, marks `resumed`, executes `next_valid_action`
- `/open` — offers resume if `last_capsule.status` is `active` or `paused`
- `/close` — creates an `active` capsule with session summary

## Design sources

- **12-Factor Agents** — execution state and business state unified in the capsule itself. Recovery, serialization, and observability become trivial.
- **Memoir time-travel** — `last_verified_state` enables reproducing prior agent state. If state drifted, we know before acting on stale assumptions.

## Related

- [[Somatic Layer]] — capsules are one of five somatic organs
- [[Somatic v0.4.1 Wiring]] — v1 capsule resume offering on /open
- [[concepts/Session Protocol]] — how sessions use capsules
- [[memory/BODY_STATE.json]] — where `last_capsule` is stored
