---
title: Hestia Sweep Log
tags: [memory, somatic, hestia, custodian]
aliases: [hestia log, sweep log]
created: 2026-05-03
---

# Hestia Sweep Log

Rolling log of [[Hestia]] custodian sweeps. Each sweep entry records: date, what was swept, what was found, what was changed. `/body-check` reads `state.hestia_last_sweep` from the most recent entry below.

## Sweep cadence

7-day default per [[Hestia]] agent definition. On-demand via `/sweep-now`, `/sweep-tracker`, `/sweep-heat`, `/sweep-links` skills.

## Schema

```
### YYYY-MM-DD — <sweep type>
- DELEGATION_TRACKER swept: <N> stale items closed/flagged
- HEAT_INDEX dormant flips: <N>
- Broken wikilinks found/fixed: <N>
- Notes touched: [list]
- Open issues for Will: <list or none>
```

## Recent sweeps

(none yet — Hestia first sweep pending)
