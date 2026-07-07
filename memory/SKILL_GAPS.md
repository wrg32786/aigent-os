---
title: Skill Gaps Ledger
tags: [memory, skills, gaps, hunt]
aliases: [SKILL_GAPS, capability gaps]
created: 2026-05-08
---

# Skill Gaps Ledger

Tracks capability gaps discovered when `/skill-recall` finds no taxonomy match for a task. Feed into `/skill-hunt` for resolution.

See [[concepts/Capability Expansion Doctrine]] for the expansion protocol.
See [[memory/SKILL_LEDGER]] for the installed skill taxonomy.

## Format

| Date | Task context | Gap description | Resolution | Status |
|------|-------------|-----------------|------------|--------|

**Status values:**
- `open` — gap identified, not yet hunted
- `hunted` — `/skill-hunt` run, candidate found or in quarantine
- `resolved` — skill installed, enrolled in Caddy, added to SKILL_LEDGER
- `wont-fix` — hunt ran, no suitable candidate found, reason noted in Resolution column

---

## Active gaps

| Date | Task context | Gap description | Resolution | Status |
|------|-------------|-----------------|------------|--------|
