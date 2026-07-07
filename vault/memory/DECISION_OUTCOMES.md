---
title: Decision Outcomes
tags:
  - memory
  - measurement
  - longitudinal
aliases:
  - Outcome Tracker
  - Decision Aging Log
---

# Decision Outcomes

A measurement layer for the framework. Every meaningful decision the principal makes (logged in `DECISION_LOG.md`) gets a follow-up entry here at 30, 60, and 90 days asking one question: **did this decision hold up?**

The data feeds `/retro` (quarterly skill) which surfaces patterns over time.

## How to use

When `/open` runs, it should check this file for entries due (30/60/90 days from a logged decision) and surface them as one-line prompts:

> "Decision aged 30 days: chose Option A on 2026-03-26. Did it hold up?"

The principal answers in one of:
- **HELD** — the decision is still right; no follow-up needed
- **DRIFTED** — the decision was right at the time but circumstances changed; capture what changed
- **REVERSED** — the decision was wrong; capture why and what the right one would have been
- **STILL UNCLEAR** — not enough data yet; defer to next aging interval

Append the outcome to the entry. Over time, the file becomes longitudinal data on decision quality.

## Format

Each entry:

```
## YYYY-MM-DD — {Decision summary} (logged in DECISION_LOG)

**30-day check (YYYY-MM-DD):** HELD | DRIFTED | REVERSED | STILL UNCLEAR
{One-line note}

**60-day check (YYYY-MM-DD):** HELD | DRIFTED | REVERSED | STILL UNCLEAR
{One-line note}

**90-day check (YYYY-MM-DD):** HELD | DRIFTED | REVERSED | STILL UNCLEAR
{One-line note — final verdict}
```

## Why this exists

Decisions are easy to track at the moment they're made (`DECISION_LOG.md` does that). What's hard is tracking whether they were *right*. Without an aging mechanism, the principal accumulates decisions without ever closing the loop on which ones worked.

This file is the loop. Every decision gets three follow-up moments. Patterns surface over the long run — "I consistently make the wrong call on X type of decision" or "my Option A choices hold up 80% of the time, my Option B choices only 50%."

The `/retro` skill (quarterly) reads this file and produces a structured analysis: what categories of decision held up, what categories drifted, what reversed, and what to adjust in the principal's decision framework as a result.

## Initial state

Empty. Populates as decisions are logged in `DECISION_LOG.md` and then aged.

## Connects to

- `vault/memory/DECISION_LOG.md` — the source of decisions
- [[Bio-hacking Posture]] — this file is the "stack tracking" category for the decision dimension
- `/retro` (forthcoming v0.3 skill) — consumes this file for quarterly analysis
- [[Three Rules]] Rule 1 — verify before claim. Tracking outcomes IS the long-form verification.

---

## Decisions awaiting outcome checks

*(This section is auto-managed. `/open` populates it from DECISION_LOG entries that have hit aging thresholds.)*

(none yet)
