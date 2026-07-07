---
title: Onboarding v2
tags:
  - project
  - active
  - tier-1
---

# Onboarding v2

> [!info]
> Project to redesign the new-user onboarding flow. Current flow has 32% completion rate; target is 60%+. In flight, ~70% complete, shipping Friday.

## Why

Cohort analysis showed users who completed onboarding had 4x retention vs users who dropped during onboarding. The current 32% completion rate is the single biggest leverage point on retention. Anything we ship that lifts onboarding completion has more impact than any other product work.

## Scope

**In:**
- Redesigned welcome screen (clearer value prop, 1 fewer click to first action)
- Sample-data seeding (new accounts get a populated example workspace)
- Progress tracker (3-step visible progress bar)
- "First win" celebration animation when user completes their first real action
- Pricing page redesign (was scoped here because the pricing decision affected what we showed)

**Out:**
- Mobile onboarding (separate project, not committed)
- Email drip sequence (handled by lifecycle, not v2)
- Tooltip system (revisit Q3)

## Status

| Component | State |
|---|---|
| Welcome screen | ✅ Live in staging |
| Sample data seeding | ✅ Live in staging |
| Progress tracker | 🟡 In review, ships tomorrow |
| First-win animation | 🟡 In design, ships Thursday |
| Pricing page | 🟡 In dev, ships Friday |

**Ship target:** Friday 2026-04-29

## Risks

- **Sample-data seeding edge cases:** what if the user creates content that conflicts with the sample data? Engineering flagged; testing covers the obvious cases but we should watch the first 100 users on prod.
- **Pricing page change is part of the same release:** if the pricing redesign breaks something, the whole onboarding ship slips. Should we de-couple? Decision logged in [[DECISION_LOG]] 2026-04-22 to keep coupled — atomic landing of the new experience matters more than ship-velocity insurance.

## Connects to

- [[Pricing Strategy]] — pricing page is part of v2 scope
- [[DECISION_LOG]] 2026-04-22 — atomic-vs-decoupled-ship decision
- [[ACTIVE_PRIORITIES]] — Tier 1 #2
