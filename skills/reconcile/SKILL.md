---
title: Reconcile Skill
tags: [skill, cognitive, reconciliation, consistency, aigent-internal]
aliases: [/reconcile, reconcile-skill]
created: 2026-05-08
---

# /reconcile — Cross-System Consistency Check

> [!info] aigent-OS-internal skill. Fires on /open (weekly cadence) or when Caddy detects drift signals. Proposes resolutions — does NOT auto-fix.

## Invocation

```
/reconcile
```

Optional: `/reconcile --full` to skip the 14-day stale threshold and check everything regardless of age.

---

## Step 1 — Load State Files

Read all of the following in parallel. If a file is missing, note it and continue — absence is itself a finding.

| File | Variable |
|------|----------|
| `$AIGENT_VAULT/memory/runtime/ACTIVE_STATE.json` | active objective, mode, focus |
| `$AIGENT_VAULT/memory/runtime/GOAL_STACK.json` | active + queued goals |
| `$AIGENT_VAULT/memory/runtime/BELIEF_STATE.jsonl` | current beliefs with confidence + last-checked |
| `$AIGENT_VAULT/memory/runtime/SELF_MODEL.json` | recurring failure modes, strengths, calibration |
| `$AIGENT_VAULT/memory/ACTIVE_PRIORITIES.md` | Tier 1–3 priorities |
| `$AIGENT_VAULT/memory/runtime/LESSONS.jsonl` | recent lessons learned |
| `$AIGENT_VAULT/memory/facts/facts.jsonl` | verified facts |
| `$AIGENT_VAULT/memory/SKILL_GAPS.md` | open/resolved skill gaps |
| `$AIGENT_VAULT/memory/DELEGATION_TRACKER.md` | active delegations |
| `$AIGENT_VAULT/memory/runtime/BODY_STATE.json` | latest somatic capsule |

---

## Step 2 — Run Consistency Checks

### Check A: Goal/Priority Mismatch
- Extract GOAL_STACK active goals (status: active)
- Extract ACTIVE_PRIORITIES Tier 1 items
- Flag any goal in GOAL_STACK with no corresponding Tier 1/2 priority
- Flag any Tier 1 priority with no corresponding active or queued goal
- **Mismatch = a goal is being tracked in one system but not the other**

### Check B: Stale Objectives
- Compare ACTIVE_STATE `current_objective` field against GOAL_STACK active goals
- If ACTIVE_STATE objective doesn't map to any active GOAL_STACK entry, flag as **orphan objective**
- If the goal it maps to was completed/cancelled in GOAL_STACK, flag as **stale chase**

### Check C: Belief Contradictions
- For each belief in BELIEF_STATE.jsonl, scan facts.jsonl for a fact on the same subject
- If a fact directly contradicts a belief (opposite claim, same entity), flag as **contradiction**
- If a belief has `last_checked` older than 14 days and `confidence < 0.7`, flag as **stale uncertain belief**

### Check D: Orphan Capsules
- Read BODY_STATE.json for capsules with status: active or paused
- For each capsule, check whether its `objective` field matches any active GOAL_STACK entry
- If no match found, flag as **orphan capsule** (work in flight with no goal parent)

### Check E: Unresolved Skill Gaps
- Read SKILL_GAPS.md for entries with `status: open`
- Calculate age from `opened` date
- Flag any open gap older than 7 days as **stale skill gap**

### Check F: Stale Delegation
- Read DELEGATION_TRACKER.md for active items
- Flag any delegation older than 14 days without a status update as **stale delegation**
- Note the responsible agent and last update

### Check G: Self-Model Drift
- Read SELF_MODEL.json `recurring_failure_modes` array
- Read FAILURE_MODES.md for entries in the last 30 days
- Flag any failure mode in SELF_MODEL that hasn't appeared in FAILURE_MODES.md in 30+ days as **possibly resolved** (self-model may be outdated)
- Flag any failure mode appearing in FAILURE_MODES.md 2+ times recently that is NOT in SELF_MODEL as **unregistered pattern**

---

## Step 3 — Output Reconciliation Report

Print this exact format:

```
RECONCILIATION REPORT — {date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Contradictions: {N}
  - {entity}: belief says "{belief_claim}", fact says "{fact_claim}"

Stale items: {N}
  - Skill gap "{gap_name}" open {X} days (threshold: 7)
  - Delegation "{item}" last updated {X} days ago (threshold: 14)
  - Belief "{belief_id}" not checked in {X} days, confidence {C}

Drift detected: {N}
  - Self-model lists "{failure_mode}" but no occurrence in last 30d (possibly resolved)
  - Failure mode "{pattern}" hit 2x recently but not in SELF_MODEL

Orphans: {N}
  - Capsule "{capsule_id}" objective has no matching active goal
  - Objective in ACTIVE_STATE has no GOAL_STACK entry

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status: CLEAN  ← if 0 issues
Status: {N} issues found  ← if >0
```

For each issue, append a **Suggested Action** line:
```
  → Suggested: {concrete action — update X, close Y, promote Z, verify W}
```

---

## Step 4 — Do NOT Auto-Fix

This skill surfaces issues and proposes resolutions. It does not:
- Modify any runtime file
- Close any delegation item
- Update ACTIVE_STATE or GOAL_STACK
- Revise beliefs or facts

Will or the AIgent decides which resolutions to apply. Each fix should be deliberate.

---

## Caddy Enrollment

Caddy fires this skill when:
- `/open` runs and it has been 7+ days since last reconcile (check ACTIVE_STATE `last_reconcile` field)
- A message contains "drift", "out of sync", "stale", "reconcile", or "consistency check"

See [[concepts/Cognitive Architecture Roadmap]] · [[memory/runtime/ACTIVE_STATE.json]] · [[memory/ACTIVE_PRIORITIES]]
