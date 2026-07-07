---
name: sweep-now
agent: hestia
description: Dispatch Hestia to run all 3 vault sweeps (DELEGATION_TRACKER stale items, HEAT_INDEX dormant flips, broken wikilinks) and append the result to HESTIA_SWEEP_LOG.
allowed-tools: Read, Edit, Bash, Grep, Glob
user-invocable: true
triggers:
  - sweep now
  - run hestia
  - hestia sweep
  - vault sweep
  - /sweep-now
  - clean the vault
  - sweep stale
---

# /sweep-now

Dispatch [[agents/Hestia]] sub-agent (sonnet) to run all 3 sweeps in one shot. Appends the result to `memory/HESTIA_SWEEP_LOG.md`. Surfaces nothing else unless Hestia found genuinely actionable items.

## What Hestia does

1. **DELEGATION_TRACKER stale items** — scan `memory/DELEGATION_TRACKER.md` ACTIVE section. Flag items with `Opened` more than 14 days ago AND `Status: In Progress` (or similar live states). Surface count + IDs of staleness candidates.
2. **HEAT_INDEX dormant flips** — read `memory/HEAT_INDEX.json` `cold_bottom_20`. For each, check mtime — if last touched >60 days, propose dormant flip. Don't actually flip without principal approval; just count + list.
3. **Broken wikilinks** — scan vault for `[[X]]` references whose target file doesn't exist. Use Grep + Glob. Output list of broken links + the source notes that contain them.

## Output format (Hestia appends to HESTIA_SWEEP_LOG.md)

Under `## Recent sweeps` section:

```markdown
### YYYY-MM-DD — full sweep
- DELEGATION_TRACKER swept: <N> stale items flagged (<comma-list of IDs>)
- HEAT_INDEX dormant flips: <N> proposed
- Broken wikilinks found: <N>
- Notes touched: [<wikilink list>]
- Open issues for Will: <list or "none">
```

## When to run

- When body-check surfaces `recommended_reflex: sweep` (overdue >7d)
- After major vault restructure (e.g., new concept folder, mass deletion)
- Before any /lint or /digest expecting a clean baseline

## Cadence doctrine

Default 7-day cadence per [[agents/Hestia]] definition. Body-check enforces — if you skip, body-check keeps surfacing the reflex until you sweep.

## What it does NOT do

- Does not auto-fix broken wikilinks. Surfaces them for principal review.
- Does not auto-flip dormant notes. Proposes flips; principal decides.
- Does not auto-close stale delegations. Flags for status update.
- Does not run sub-sweeps in parallel. Sequential per Hestia agent definition.

## Cross-links

- [[concepts/Somatic v0.4.4 Hestia Wiring]] — spec
- [[agents/Hestia]] — sub-agent definition
- [[memory/HESTIA_SWEEP_LOG]] — output destination
- [[concepts/Somatic Layer]] — base doctrine
