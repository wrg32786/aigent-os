---
title: Dream Skill
tags: [skill, cognitive, consolidation, improvement, aigent-internal]
aliases: [/dream, dream-skill, offline-consolidation]
created: 2026-05-08
---

# /dream — Offline Consolidation

> [!danger] CRITICAL SAFETY RULE: /dream PROPOSES. It does NOT auto-apply. Every candidate requires Will's explicit approval before becoming a real change. This boundary is non-negotiable.

The frontier piece of the cognitive architecture. Simulates the consolidation function of sleep — scanning recent experience for patterns, extracting durable improvements, surfacing them for review.

## Invocation

```
/dream
/dream --days 14       # scan last 14 daily notes instead of 7
/dream --since 2026-04-01  # scan from a specific date
```

---

## Step 1 — Load Source Material

Read all of the following. Run parallel reads where possible.

**Daily notes** — read last N from `$AIGENT_VAULT/daily/` (default N=7, most recent by filename date):
- Extract: failures, decisions, delegations, patterns noted, tools used

**Runtime state files:**
| File | What to extract |
|------|----------------|
| `$AIGENT_VAULT/memory/FAILURE_MODES.md` | recent entries (last 30 days) |
| `$AIGENT_VAULT/memory/runtime/BELIEF_STATE.jsonl` | beliefs with `confidence < 0.7` or `last_checked` > 14 days |
| `$AIGENT_VAULT/memory/SKILL_GAPS.md` | all open entries |
| `$AIGENT_VAULT/memory/runtime/LESSONS.jsonl` | all entries from last N days |
| `$AIGENT_VAULT/memory/runtime/STATE_EVENTS.jsonl` | mode transitions, escalations, context switches |

---

## Step 2 — Analysis Passes

Run each pass independently, then consolidate. Low confidence = skip, don't hallucinate patterns.

### Pass A: Repeated Failure Patterns
- Count occurrences of each failure mode across FAILURE_MODES.md + daily notes
- Flag any pattern appearing 2+ times as a **consolidation candidate**
- Check whether it already has a standing rule in CLAUDE.md or `concepts/Standing Rules - Operations.md`
- If it does: no candidate needed (rule exists, enforcement may be the gap)
- If it doesn't: produce a rule/caddy candidate

### Pass B: Stale Beliefs
- Flag beliefs with `last_checked` > 14 days AND `confidence < 0.8`
- Especially flag beliefs tagged `assumes` or `unverified`
- Candidate type: **verification task** (not a rule, just a check needed)

### Pass C: Missing Procedures
- Scan daily notes for tasks performed manually that follow the same pattern across 2+ sessions
- Signal: same verb + same noun across multiple days ("manually updated X", "copied Y to Z", "checked W before doing V")
- If the pattern is repeatable and deterministic: candidate type = **procedure**
- Do not flag one-off tasks

### Pass D: Doctrine Gaps
- Scan daily notes and LESSONS.jsonl for recurring decisions that had to be reasoned from scratch
- Signal: "decided to...", "chose to...", "went with..." appearing on similar topics across sessions
- If a standing rule would have made the decision automatic: candidate type = **doctrine**
- Check that no existing rule already covers it before proposing

### Pass E: Unused Skills
- Read `$AIGENT_VAULT/memory/SKILL_LEDGER.md` (if present) for registered skills
- Scan daily notes for invoked skills (any `/skill-name` pattern)
- Flag skills in SKILL_LEDGER not invoked in any of the last N sessions as **possibly unused**
- Note: absence from daily notes is weak signal — flag as low confidence

### Pass F: Better Workflows
- Read STATE_EVENTS.jsonl for context switch patterns (frequent mode switches, repeated escalations)
- Flag sequences that appear to be inefficient (e.g., same escalation pattern 3+ times)
- Candidate type = **workflow optimization**

---

## Step 3 — Format Candidates

For each finding with confidence >= 0.5, produce:

```markdown
## Candidate: {title}
Type: skill | rule | procedure | doctrine | caddy-trigger | memory | verification
Confidence: {0.0–1.0}
Evidence: {specific sessions, file references, occurrence count}
Proposed change: {concrete and specific — what to write, where to write it}
Expected gain: {what improves if this is adopted}
Risk: {what could go wrong if applied carelessly}
```

Confidence guidance:
- `>= 0.9` — strong pattern, multiple independent evidence sources
- `0.7–0.89` — probable pattern, worth reviewing
- `0.5–0.69` — weak signal, flag but mark low priority
- `< 0.5` — skip entirely

---

## Step 4 — Write to DREAM_LOG.md

Append to `$AIGENT_VAULT/memory/runtime/DREAM_LOG.md`:

```markdown
## Dream Run — {YYYY-MM-DD}
Sessions reviewed: {N} | Date range: {start} to {end}
Candidates: {total count}

{all formatted candidates}

---
```

Do NOT overwrite — always append with a new date header.

---

## Step 5 — Output Summary

Print to console:

```
/dream complete — {N} improvement candidates from {M} sessions reviewed.
Types: {skill: X, rule: Y, procedure: Z, doctrine: W, other: V}
Confidence distribution: high(>=0.9): A | mid(0.7-0.89): B | low(0.5-0.69): C
See DREAM_LOG.md for full candidates. No changes applied — Will's approval required.
```

---

## What /dream Never Does

- Does not modify CLAUDE.md
- Does not create new vault notes
- Does not update SKILL_GAPS.md, LESSONS.jsonl, or any runtime file (except appending to DREAM_LOG.md)
- Does not close or resolve any tracker item
- Does not invoke other skills
- Does not send comms

The dream log is a proposal queue, not an execution queue.

---

## Caddy Enrollment

Caddy fires this skill when:
- User types `/dream`
- Weekly on /close (if last run > 7 days — check DREAM_LOG.md last entry date)
- Message contains "consolidation run", "pattern review", "offline learning"

See [[concepts/Cognitive Architecture Roadmap]] · [[memory/runtime/DREAM_LOG]] · [[memory/runtime/LEARNING_SCORECARD]]
