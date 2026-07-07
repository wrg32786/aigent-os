---
title: Trust Decay Ledger
tags:
  - memory
  - measurement
  - longitudinal
  - confidence
aliases:
  - Confidence Ledger
  - Cost of Confidence Log
---

# Trust Decay Ledger

The longitudinal record of confident agent claims and their eventual outcomes. See [[Cost of Confidence]] for the doctrine.

`/trust-decay capture` writes Phase 1 (confident claim made).
`/trust-decay resolve` writes Phase 2 (claim confirmed or disproven).

The pairing is the whole point. Calibration = (confirmed correct) / (total claims captured), measured over time, by category.

## Why this matters

Most agent frameworks let the agent talk and don't measure how often it lies (in the sense of confident-but-wrong). aigent-OS does — because the [[Bio-hacking Posture]] demands measurement, and because [[Suggestion Credibility]] proves trust is the most depleting resource an agent can spend.

If the trust trajectory improves over months, the framework is working. If it degrades, something is rotting and the principal should investigate which layer is responsible.

## Structure

Two sections:

1. **Open** — Phase 1 captures awaiting Phase 2 resolution
2. **Resolved** — fully-paired entries with outcome data

Entries graduate from Open → Resolved when `/trust-decay resolve` is invoked.

## Initial state

Empty. Best to start populating from v0.2.2 release forward. Pre-existing claims aren't backfilled.

---

## Open (awaiting outcome)

*(Phase 1 entries land here. Format:)*

```
## YYYY-MM-DD — {short claim summary}
**Claim:** "{verbatim}"
**Source:** {agent name or self}
**Context:** {task / session / what was being worked on}
**Verification stated:** {what the claimant said they verified}
**Status:** OPEN
```

(none yet)

---

## Resolved (paired)

*(Entries graduate here when `/trust-decay resolve` is invoked. Format:)*

```
## YYYY-MM-DD — {short claim summary}
**Claim:** "{verbatim}"
**Source:** {agent or self}
**Context:** {task / session}
**Verification stated:** {what the claimant said they verified}

**Resolution (YYYY-MM-DD):** WRONG | PARTIALLY WRONG | CONFIRMED CORRECT
**Evidence:** {what surfaced the discrepancy or confirmation}
**Time-to-discovery:** {duration}
**Trust-decay event:** YES | NO
**Pattern:** {one line — category of mistake/correctness}
```

(none yet)

---

## Aggregate (computed on demand by `/retro`)

This section is left empty until `/retro` (v0.3) ships and starts producing rollup tables. At that point, `/retro` writes (and rewrites) computed aggregates here:

- Trust trajectory over time
- Hit rate by category
- Recurring patterns flagged for promotion to [[Common Failure Modes]] doctrine

## Connects to

- [[Cost of Confidence]] — the doctrine
- `/trust-decay` skill — the capture + resolve mechanism
- [[Honesty Check]] — should reduce Phase 1 frequency over time
- [[Reading Agent Output Defensively]] — the principal-side trigger for many Phase 1 captures
- [[Common Failure Modes]] — sister corpus (layer failures vs confidence failures)
- `/retro` (forthcoming) — quarterly analyzer
