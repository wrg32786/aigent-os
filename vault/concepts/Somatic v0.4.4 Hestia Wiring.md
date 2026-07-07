---
title: Somatic v0.4.4 Hestia Wiring
tags: [doctrine, somatic, shipped]
aliases: ["v0.4.4", "hestia auto", "sweep-now"]
created: 2026-05-03
status: shipped
---

# Somatic v0.4.4 — Hestia Wiring

Activate the dormant custodian. Body-check correctly reports `hestia_last_sweep` from HESTIA_SWEEP_LOG mtime. Overdue (>7d) triggers `recommended_reflex: sweep`. New `/sweep-now` skill dispatches Hestia agent to run all 3 sweeps and appends the result to HESTIA_SWEEP_LOG.

## Brief

> Body-check reads HESTIA_SWEEP_LOG for last sweep date. If null or >7d, sets `recommended_reflex: sweep`. `/sweep-now` dispatches Hestia agent (DELEGATION_TRACKER stale items, HEAT_INDEX dormant flips, broken wikilinks), appends sweep entry to HESTIA_SWEEP_LOG.md.

## Scope (3 deltas)

### 1. body-check reads HESTIA_SWEEP_LOG correctly

Update `.claude/skills/body-check/SKILL.md` reflex rules to:
- Parse HESTIA_SWEEP_LOG.md — find the most recent `### YYYY-MM-DD` entry under "Recent sweeps"
- If no entries, `hestia_last_sweep = null`
- If entry exists, set `hestia_last_sweep = <date>T00:00:00Z`
- New reflex rule: `hestia_last_sweep is null OR > 7d ago → recommended_reflex: sweep`
- Stacks with existing reflex priority — sweep is lower priority than digest/capsule/close

### 2. `/sweep-now` skill

New skill at `.claude/skills/sweep-now/SKILL.md` (mirrored to aigent-OS public).

Dispatches Hestia agent (sonnet) with the standard 3-sweep brief:
- DELEGATION_TRACKER: scan all open items, flag any in-progress >14d, surface stale candidates
- HEAT_INDEX: identify cold-bottom-20 notes that haven't been touched in 60+ days, propose dormant flip
- Broken wikilinks: scan vault for `[[X]]` references whose target doesn't exist, list them

Appends one entry to HESTIA_SWEEP_LOG.md with the format defined in the file's schema section.

### 3. HESTIA_SWEEP_LOG entry writer

Hestia's `/sweep-now` invocation closes by writing:
```markdown
### 2026-05-03 — full sweep
- DELEGATION_TRACKER swept: <N> stale items closed/flagged
- HEAT_INDEX dormant flips: <N>
- Broken wikilinks found/fixed: <N>
- Notes touched: [list]
- Open issues for Will: <list or none>
```

## Tests passed

- Synthetic: HESTIA_SWEEP_LOG has no entries → body-check reports `hestia_last_sweep: null` + recommended_reflex includes "sweep"
- Synthetic: write a recent sweep entry → body-check reports the date + drops "sweep" from reflex
- Synthetic: write a 10-day-old sweep entry → body-check parses date correctly + sets reflex back to "sweep"
- /sweep-now skill instructions parsed without error
- Mirror discipline: skill mirrored to public aigent-OS

## Cross-links

- [[concepts/Somatic Roadmap]] — version queue
- [[agents/Hestia]] — sub-agent definition
- [[memory/HESTIA_SWEEP_LOG]] — the data
- [[concepts/Somatic Layer]] — base doctrine
