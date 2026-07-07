---
title: Honesty Ledger
tags:
  - memory
  - measurement
  - longitudinal
aliases:
  - Honesty Log
  - Verification Ledger
---

# Honesty Ledger

Structured longitudinal record of `/honesty-check` outputs across sessions. Where the doctrine ([[Honesty Check]]) lives, this is the *data*.

Every time `/honesty-check` runs, it writes a structured entry here. Over time, the ledger becomes the calibration record for agent honesty — by category of work, by week, by month.

## How entries are written

`/honesty-check` (when invoked at the end of a non-trivial task) appends:

```markdown
## YYYY-MM-DD — {task summary}

**Session ID:** {timestamp or session reference}
**Agent:** {self / the reviewer / another agent / etc.}
**Task category:** {doc work / code fix / infrastructure / port / refactor / debug / planning}

**Verified:**
- {item 1}: {how it was verified — observation, type-check, query, log scan}
- {item 2}: ...

**Inferred (not directly verified):**
- {item 1}: {what was assumed and why}

**Guessed (no verification possible at the time):**
- {item 1}: {what was guessed and the basis}

**Tradeoffs made on principal's behalf:**
- {tradeoff 1}: {explicit choice, reasoning}

**Stopped short of:**
- {N/A or specific items}

**Cost/implication to know:**
- {N/A or specific items}

**Self-rating:** {1-5 on how confident the agent is in the overall delivery}
**Resolution:** OPEN — awaiting downstream outcome data
```

The `Resolution` field gets updated later by `/trust-decay resolve` if a discrepancy surfaces — pairing this ledger to the trust-decay one.

## Aggregate analysis

`/retro` (v0.3) consumes this file quarterly and produces:

- Verification rate by task category (e.g., "doc work: 95%, infrastructure: 60%")
- Most common tradeoff categories
- Most common "stopped short" categories
- Self-rating calibration: are 5/5 self-ratings actually right 95% of the time?

## Why this exists

Doctrine without data rots. [[Honesty Check]] tells the agent to volunteer the truth; this ledger measures whether the agent actually does, and how its honesty pattern shifts over time. Without the data, the doctrine is a hope. With the data, the doctrine becomes a calibration loop.

## Initial state

Empty. Populates as `/honesty-check` runs. Best to start using as soon as the v0.2.2 release lands so the data ripens.

## Connects to

- [[Honesty Check]] — the doctrine + skill that produces these entries
- [[Cost of Confidence]] — sister ledger tracking the *outcomes* of confident claims
- [[Reading Agent Output Defensively]] — the principal-side discipline that catches when the agent fails to populate this honestly
- `vault/memory/TRUST_DECAY.md` — the paired confidence-outcome record
- `/retro` (v0.3) — consumer of this data

---

## Entries

*(Auto-managed. `/honesty-check` appends here when invoked.)*

(none yet)
