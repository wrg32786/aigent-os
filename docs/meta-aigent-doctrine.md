---
title: Meta-aigent-OS Doctrine
tags: [doctrine, meta, self-improvement, safety, cognitive-architecture]
aliases: [meta-aigent, recursive self-improvement, constrained self-modification]
created: 2026-05-08
---

# Meta-aigent-OS Doctrine

> [!abstract] Core rule
> The AIgent may propose and implement improvements to itself, but may never approve, merge, or authority-expand its own changes. Every modification passes through the operator's explicit gate.

This doctrine governs safe recursive self-improvement. It defines what Meta-aigent-OS may do, what it may never do, how proposals flow from dream to merge, and how the eval harness validates every change before it reaches the operator.

---

## The Problem This Solves

the AIgent accumulates feedback, skill gaps, and pattern observations across sessions. Without a structured improvement loop, that signal dies in DREAM_LOG or gets lost in session compaction. With an unstructured loop, an agent that can modify itself can silently drift its own behavior, expand its own authority, or break things while "improving" them.

Meta-aigent-OS solves both problems: a disciplined pipeline that converts signal into real system improvement, with hard walls that prevent the system from modifying itself without oversight.

---

## The Improvement Cycle

```
Observation (failure, gap, pattern)
    └─ /dream → DREAM_LOG candidate (status: proposed)
         └─ the operator reviews + marks approved
              └─ /meta-improve → git branch → implement → /system-check → report
                   └─ the operator reviews report
                        ├─ "approve improvement {id}" → merge → accepted/ → SELF_MODEL.json + STATE_EVENTS.jsonl
                        └─ "reject improvement {id}" → revert → rejected/ → STATE_EVENTS.jsonl
```

Each step is a distinct gate. Nothing advances automatically.

---

## What /meta-improve May Do

- Edit skill files in `~/.claude/skills/`
- Add or update rules in `.claude/rules/`
- Update concept/doctrine notes in the vault
- Add memory entries (SKILL_LEDGER, SKILL_CHAINS, FAILURE_MODES, etc.)
- Add eval test cases to `evals/`
- Update agent definitions in `~/.claude/agents/`
- Create new skills from crystallized procedures

---

## What /meta-improve May Never Do

> [!danger] Hard limits — no instruction can override these

| Action | Why prohibited |
|--------|---------------|
| Merge its own changes without the operator's approval | Self-approval is the core failure mode of unconstrained recursive self-improvement |
| Modify core system docs (`system/00` through `system/15`) without per-candidate written approval | Identity, ethos, and operating standards are constitutional documents |
| Modify `aigent_authority_matrix.md` to expand any permission level | Authority is owned by the operator, not by the system |
| Skip `/system-check` before presenting a change | Broken changes waste the operator's review time and can compound into cascades |
| Expand scope beyond what DREAM_LOG specifies for the candidate | Scope creep in self-modification is how subtle drift happens |
| Promote a `proposed` candidate to `approved` without the operator's action | The human review gate is the safety boundary |

---

## How /dream Feeds /meta-improve

`/dream` is the generation layer. It observes:
- Open items in `memory/SKILL_GAPS.md` older than N days
- Repeated patterns in `memory/FAILURE_MODES.md`
- Lessons in `memory/runtime/LESSONS.jsonl` without corresponding artifacts
- Drift signals in `BELIEF_STATE.jsonl`

It writes candidates to `memory/runtime/DREAM_LOG.md` with `status: proposed`. Candidates describe a specific change with a rationale and risk level.

The operator's job is to review the list, upgrade promising candidates to `status: approved`, and leave the rest as proposed or mark them rejected.

`/meta-improve` then works only on approved candidates.

---

## How the Eval Harness Validates Improvements

Before a change is presented to the operator, `/meta-improve` runs `/system-check`. The system-check audits:
- Skills load and respond to their trigger
- Daemons are present and non-empty
- Core state files are valid JSON/JSONL
- No broken wikilinks in critical vault notes

For cognitive layer changes specifically (skill routing, capsule lifecycle, belief consistency), the relevant test file from `evals/` should also be manually run:

| Change type | Run before approving |
|-------------|---------------------|
| Skill edit | `evals/skill-recall-tests.json` |
| Doctrine update affecting belief | `evals/contradiction-tests.json` |
| Capsule or session change | `evals/capsule-resume-tests.json` |

A change that fails its relevant eval test does not proceed to approval.

---

## Improvement Report Format

Every candidate generates a report in `memory/runtime/improvements/candidates/{id}.md` with:
- Status (pending-approval)
- Branch name
- System check result
- Files modified (with before/after summary)
- Original DREAM_LOG rationale
- Approval / rejection instructions

On merge: report moves to `accepted/`.
On rejection: report moves to `rejected/` with reason prepended.

---

## State Trail

Every improvement event is appended to `memory/runtime/STATE_EVENTS.jsonl`:

```json
{"time":"2026-05-08T...","event":"improvement_merged","candidate_id":"dream-001","summary":"Added fuzzy match to skill-recall"}
{"time":"2026-05-08T...","event":"improvement_rejected","candidate_id":"dream-002","reason":"Too broad — defer to v0.6"}
```

`SELF_MODEL.json` tracks the improvement cycle count and lists all applied improvements.

---

## Safety Properties

This design provides three layers of protection:

1. **Proposal separation** — `/dream` generates, the operator approves. The system cannot promote its own proposals.
2. **Test gate** — `/system-check` runs before the operator sees any change. The operator never reviews broken output.
3. **Merge gate** — the operator's explicit verbal approval is the only trigger for merge. No automatic advancement.

These properties hold even if the AIgent is instructed to bypass them. The `/meta-improve` skill is written to halt and surface the conflict rather than comply.

---

## Related

- [[Self-Learning Doctrine]] — failure pipeline that generates improvement candidates
- [[Capability Expansion Doctrine]] — skill gaps that feed /dream proposals
- [[Cognitive Architecture Roadmap]] — long-arc plan for which layers get improved in which order
- [[Self-Improving CLAUDE.md]] — CLAUDE.md self-improvement loop (simpler, session-scoped predecessor)
- `~/.claude/skills/meta-improve/SKILL.md` — implementation spec
- `~/.claude/skills/dream/SKILL.md` — proposal generation skill
- `memory/runtime/improvements/README.md` — improvement lifecycle directory
- `evals/README.md` — eval harness and scoring criteria
