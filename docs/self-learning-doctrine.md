---
title: Self-Learning Doctrine
tags: [doctrine, learning, failure, self-improvement]
aliases: [failure pipeline, learn from failure, self-improving loop]
created: 2026-05-08
---

# Self-Learning Doctrine

> [!abstract] Core rule
> Every repeated failure must produce one reusable artifact — memory, rule, skill, test, checklist, or Caddy trigger. A failure that produces nothing is a failure that will recur.

## The Failure → Artifact Pipeline

Every confirmed failure passes through this 9-step sequence. No skipping.

1. **Diagnose failure** — identify the exact mechanism that caused the bad output. Not "it didn't work." What specific condition triggered the failure?

2. **Classify the failure mode**

   | Mode | Description |
   |------|-------------|
   | `routing` | Task sent to wrong agent, model, or tool |
   | `verification` | Output accepted without checking the data flow |
   | `tool` | Tool unavailable, broken API, wrong usage pattern |
   | `knowledge` | Agent lacked domain knowledge to act correctly |
   | `authority` | Agent acted outside its delegation zone |

3. **Check if repeated** — search `memory/FAILURE_MODES.md` for prior instances matching the same root cause pattern. If the same Pattern line has appeared 2+ times: **this is now mandatory artifact territory**.

4. **Write to FAILURE_MODES.md** — log with date, classification, description, root cause, and one-line Pattern. Format follows existing ledger entries.

5. **Add memory candidate** — does this failure point to a fact, rule, or architectural property that should persist across sessions? If yes, surface it for vault encoding.

6. **If actionable → create skill candidate** — if the fix requires a repeatable procedure, draft a skill spec. Route to Lyra for implementation if the skill doesn't exist.

7. **If routing failure → update Caddy** — add a trigger-pattern entry to `.claude/hooks/` or `.claude/skill-index.json` so the right skill fires automatically next time.

8. **If verification failure → add test/check** — append a concrete check to the relevant doctrine note (usually [[Pipeline Verification Doctrine]] or [[concepts/Verification Rules]]). The check must be runnable, not aspirational.

9. **If knowledge gap → log to SKILL_GAPS.md** — record the exact knowledge boundary that was missing. This feeds Newton's research queue and Demosthenes's prompt review queue.

## Failure Modes by Type — Artifact Map

| Failure mode | Required artifact | Owner | Target file |
|---|---|---|---|
| `routing` | Caddy trigger or Caddy hook | Lyra | `.claude/hooks/` or `.claude/skill-index.json` |
| `verification` | Checklist item in doctrine | Lyra / Mnemosyne | Relevant doctrine note |
| `tool` | SKILL_GAPS.md entry + skill spec | Newton + Lyra | `memory/SKILL_GAPS.md` |
| `knowledge` | Vault note or memory candidate | Mnemosyne | `concepts/` or `memory/` |
| `authority` | Flag to the operator + authority matrix update | the AIgent | `aigent_authority_matrix.md` |

## Escalation rules

- **First occurrence:** log, classify, monitor.
- **Second occurrence:** mandatory artifact. Log is not enough.
- **Third occurrence:** the artifact didn't prevent recurrence. The artifact itself failed — diagnose why and fix it or replace it.

> [!danger] Anti-pattern
> Logging a failure without an artifact is a false resolution. The ledger grows, the failure recurs, and the system learns nothing. A log entry is not an artifact — it is the precondition for one.

## Invariant

A failure mode that has appeared more than once without a durable artifact in place is a systemic gap, not bad luck.

## Caddy hook

**Trigger pattern:** "same issue", "happened again", "recurring", "third time", "we've seen this before", "this keeps happening"
**Surface:** [[Self-Learning Doctrine]] + [[concepts/Self-Improving CLAUDE.md]]
**Action:** invoke `/learn-from-failure` before doing anything else

## Connects to

- [[Self-Improving CLAUDE.md]] — session-level learning protocol, where rules go
- [[Capability Expansion Doctrine]] — how the system grows new skills
- [[Pipeline Verification Doctrine]] — verification failures → this pipeline
- [[Somatic Layer]] — body-check surfaces unresolved failure patterns
- [[memory/FAILURE_MODES.md]] — the live ledger this doctrine feeds
- [[agents/Pantheon]] — agent skill loadouts include `/learn-from-failure`
