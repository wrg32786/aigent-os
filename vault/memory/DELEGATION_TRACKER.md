---
title: Delegation Tracker
tags:
  - memory
  - delegation
---

# Delegation Tracker

Active handoffs. Every delegated item stays here until closed.

| ID | Task | Delegated To | Status | Priority | Created | Updated |
|----|------|-------------|--------|----------|---------|---------|
| 1 | [Example task] | [Agent] | pending | P1 | YYYY-MM-DD | YYYY-MM-DD |

## Status Types
- `pending` — Briefed, not started
- `in-progress` — Agent working on it
- `blocked` — Stuck, needs input
- `review` — Done, needs verification
- `closed` — Completed and verified

## Rules
- Review daily: anything `in-progress` for >48h gets a check-in
- Review weekly: anything `pending` for >7d gets re-evaluated
- Stale items (>14d without update) get escalated to principal
