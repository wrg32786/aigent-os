---
title: Attention Reconciliation
tags:
  - doctrine
  - measurement
  - drift
  - cadence
aliases:
  - Drift Detection
  - Attention vs Priority
  - The Reconciliation Step
created: 2026-04-27
---

# Attention Reconciliation

> Where you said you'd spend your attention vs where you actually did. The framework can see both. Most don't bother to compare them. aigent-OS does, at every `/open`.

## The pattern this catches

The principal sets `ACTIVE_PRIORITIES.md` saying Project B is Tier 1. Across the next week, the daily notes show 3 sessions on Project A and 1 session on Project C. Project B got zero direct work.

This is **attention drift**. It happens to every principal. Most don't notice it for months because the data is split across files that nobody cross-references.

The reconciliation step makes it visible at session start. Every `/open` runs a quick comparison and flags drift if it exceeds a threshold.

## How it works

### Inputs
- `vault/memory/ACTIVE_PRIORITIES.md` — what the principal said matters (Tier 1, blockers, current mode)
- `vault/daily/YYYY-MM-DD.md` files — what actually happened over the last 7 days

### The check
For the last 7 days of daily notes:
1. Extract project mentions, tags, or wikilinks pointing to `vault/projects/*`
2. Count weighted occurrences (a project mentioned in headers > a project mentioned in passing)
3. Compute "attention share" per Tier 1 project
4. Compare to "intended share" (Tier 1 should be most of the attention)

### The output
Append to the `/open` orientation if drift is detected:

```
🎯 Attention drift (7-day window):
   ACTIVE_PRIORITIES says Tier 1: Project B (60% intended), Project C (30% intended)
   Last 7 days: Project A (45%), Project D (25%), Project B (15%), Project C (5%)
   Project B is at 15% / 60% intended — drift detected.
   Project A is at 45% / 0% intended (not on Tier 1) — drift detected.

   Reconcile: re-prioritize ACTIVE_PRIORITIES, OR refocus this session toward Tier 1.
```

If no drift > 20% from intended, the section is omitted. No noise on weeks where attention matched intention.

## What "drift" means

Drift isn't the same as "wrong." There are legitimate reasons attention diverges from priority:

- A blocker on a Tier 1 project forced work elsewhere
- A non-priority opportunity surfaced and was worth a session
- The priority list was stale; reality reshaped what mattered
- An unrelated emergency consumed time

The reconciliation step doesn't moralize. It surfaces the gap and asks the principal to choose:

1. **Update ACTIVE_PRIORITIES** — reality reshaped priorities; the doc is what's stale
2. **Refocus this session** — the doc is right; the drift is what should be corrected
3. **Note the legitimate reason** — capture the why; both stay as-is

The principal makes the call. The framework just refuses to let drift accumulate invisibly.

## Why this matters

Without reconciliation, three failure modes accumulate:

### 1. The shadow priority
A project quietly absorbs more attention than its priority suggests. By the time the principal notices, three weeks have gone. Either the priority should have been updated (the principal was working on the right thing but the doc was stale) or the attention should have been redirected (the principal drifted). Either way, three weeks is too late to know.

### 2. The starved priority
A Tier 1 project gets repeatedly deprioritized in favor of urgent-but-not-important work. ACTIVE_PRIORITIES still calls it Tier 1; the daily notes show no sessions on it. Without reconciliation, this can go on for months.

### 3. The stale priority list
ACTIVE_PRIORITIES is a doc the principal updates intermittently. The longer the gap between updates, the more it diverges from reality. Without a forcing function, the list becomes wishful thinking.

The reconciliation step is a forcing function. It makes the divergence concrete every session.

## Tuning the threshold

The 20% drift threshold is a starting point. Different principals will have different tolerances:

- **Maker mode** (deep focus on one thing for weeks) → lower threshold, want stronger signal
- **Manager mode** (juggling many things, attention naturally fragments) → higher threshold to avoid noise
- **Operator mode** (responding to whatever surfaces) → may want the reconciliation gone entirely; in that case, set threshold to 100%

The threshold lives in the `/open` skill's config. Principals can tune it.

## What this is NOT

- **Not surveillance.** The principal owns their own attention; the framework just measures.
- **Not blame.** Drift happens. The reconciliation just surfaces it for conscious choice.
- **Not a substitute for ACTIVE_PRIORITIES updates.** The priority list still has to be maintained; reconciliation just keeps it from rotting silently.

## What it requires

- Daily notes that mention projects (already standard in aigent-OS)
- ACTIVE_PRIORITIES.md kept reasonably current
- A `/open` skill that can read both and do the math (shipped in v0.2.2)

## Connects to

- [[Bio-hacking Posture]] — this is the "stack tracking" intervention applied to attention
- [[The Two Roles]] — the principal-as-maintainer maintains ACTIVE_PRIORITIES; the principal-as-user does the actual work; reconciliation is the loop between them
- `vault/memory/ACTIVE_PRIORITIES.md` — input
- `vault/daily/` — input
- `/open` skill — the cadenced check
- [[Cost of Confidence]] — sister measurement (this one tracks attention vs intention; that one tracks claims vs outcomes)
