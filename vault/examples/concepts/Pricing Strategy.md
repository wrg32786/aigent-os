---
title: Pricing Strategy
tags:
  - strategy
  - pricing
  - revenue
created: 2026-03-15
---

# Pricing Strategy

> [!abstract]
> Pricing model for the SaaS product. Freemium with usage-based upgrade. Last revised 2026-03-15 after the cohort analysis showed our $29 tier wasn't capturing the value our users were getting.

## Current pricing

| Tier | Price | Limits | Target user |
|---|---|---|---|
| Free | $0 | 100 monthly active users, 1 workspace | Early adopters, hobby projects |
| Pro | $49/mo annual ($59/mo monthly) | 10,000 MAU, unlimited workspaces | Small teams, indie SaaS |
| Team | $199/mo | 100,000 MAU, SSO, team features | Mid-market |
| Enterprise | Custom | Unlimited, SLA, dedicated support | Large orgs |

## Why these numbers

- **$49 baseline:** clears CAC ($35) with positive contribution margin within 90 days at a 6-month average tenure.
- **$59 monthly vs $49 annual:** 17% premium for monthly is the standard SaaS framing. Tested $69 monthly and saw conversion drop materially.
- **Free tier capped at 100 MAU:** our cohort data showed users converted to Pro at ~80 MAU. Cap at 100 forces the decision; lower would create churn before fit; higher leaves money on the table.

## What's been tried (don't re-relitigate)

- **$29 Pro tier (Q4 2025):** captured users but undervalued the product. Migrated existing $29 users to $49 with grandfathered $35 rate. Net: +$8k MRR, -3 customers.
- **Usage-based add-on (Q1 2026):** considered $0.001/MAU above tier limits. Decided against — adds billing complexity and our users prefer predictable bills. Logged in [[DECISION_LOG]] 2026-02-14.

## Open questions

- **Annual pre-pay incentive:** are we leaving money on the table by not offering 2 free months for annual? Cohort data thin so far.
- **Education tier:** universities keep asking. Worth the operational overhead?

## Connects to

- [[DECISION_LOG]] for the live decision history
- [[Onboarding v2]] — pricing page redesign is part of the v2 scope
- [[CAC Analysis Q1 2026]] — supports the $35 CAC assumption
