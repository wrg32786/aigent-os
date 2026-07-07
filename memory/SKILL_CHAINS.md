---
title: Skill Chains Ledger
tags: [memory, skills, chains, sequences]
aliases: [SKILL_CHAINS, skill sequences]
created: 2026-05-08
---

# Skill Chains Ledger

Tracks successful multi-skill sequences discovered during task execution. When `/skill-recall` matches an objective, it checks this ledger first for prior chains that solved similar problems.

See [[concepts/Capability Expansion Doctrine]] for the expansion protocol.
See [[memory/SKILL_LEDGER]] for individual skill taxonomy entries.

## Format

| Date | Objective | Chain | Outcome |
|------|-----------|-------|---------|

**Chain notation:** `skill1 → skill2 → skill3`
Use taxonomy paths (`research.deep.tavily`) or skill names (`/deep-recon`) — taxonomy paths preferred for durability.

---

## Recorded chains

| Date | Objective | Chain | Outcome |
|------|-----------|-------|---------|
