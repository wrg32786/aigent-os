---
title: Lego Arsenal Doctrine
tags:
  - doctrine
  - agency
  - architecture
  - agents
  - reusability
aliases:
  - Lego Doctrine
  - Arsenal Doctrine
created: 2026-05-01
---

# Lego Arsenal Doctrine

> [!abstract] One-line principle
> Every external build is a Lego in your agency arsenal. Build modular by default. The arsenal compounds.

---

## The Principle

Every external build (freelance gig, agency client, partner project) is built modular by default and scoped for reuse from day one. The arsenal compounds: each gig adds reusable skills, components, prompts, integrations, and architectural patterns to your permanent capability inventory. Future clients pay for the polished assembly of pre-built Legos, not bespoke construction from scratch. The gig pays for the build. The arsenal pays forever.

---

## Why It Matters

**Compounding economics.** Gig N pays for itself AND lowers the cost of gigs N+1, N+2, etc. The second client in the same vertical costs 60% less to deliver. The tenth client costs almost nothing new.

**Strategic positioning.** An operator running this doctrine is not a freelance shop. It is an agency with a growing arsenal of productized capabilities. The arsenal IS the moat. A freelancer bids time. An agency bids a system.

**Pricing power.** Future clients can be quoted faster, more confidently, and at higher rates because the work is "configure pre-built Legos" not "build from scratch." Speed-to-quote and confidence-in-delivery both go up. Margins follow.

---

## The Rule

> **ALWAYS build for reuse from day one.** When taking on any external build, structure the deliverable as one or more Pantheon-compatible SKILL.md modules with clear trigger surfaces, isolated state, and documented inputs/outputs. Custom client logic goes in config files, not in the Lego itself. The Lego must be portable to the next client.

---

## Example: Lead Generation Agent System

A typical "build me an AI lead-gen system" gig produces approximately five reusable Legos:

| # | Lego | What it is | Next-use portability |
|---|---|---|---|
| 1 | Lead scoring agent | Domain-agnostic signal ranker | Retune prompt + signals for any vertical |
| 2 | Multi-source scraper | Web + API orchestration pattern | Any data-collection job |
| 3 | CRM router | CRM adapter (config-driven) | Swap config across CRMs (HubSpot, Salesforce, FUB, Pipedrive) |
| 4 | Trigger-event detector | Signal filter (life events, behavior changes, etc.) | Apply to any vertical with relevant trigger events |
| 5 | Outreach orchestrator | Cadence + multi-channel send | Vertical-agnostic, swap copy + timing config |

These five become arsenal components. The next lead-gen client (whatever vertical) gets a 40-60% discount in time-to-deliver. The gig that produced them has already paid back 1.5x within the next two clients.

---

## Anti-Patterns

- **Hardcoding client-specific values into Lego logic.** Always use config files. The Lego must not know the client's name.
- **Naming things in a vertical-specific way.** "RealEstateLeadScorer" ties the Lego to one industry. "LeadScorer" is portable.
- **Skipping documentation because "this client paid for this build."** Every Lego needs a SKILL.md or it is not in the arsenal. Undocumented Legos get rebuilt from scratch next time.
- **One-off scripts without trigger surfaces.** If there is no clean entry point, the Lego cannot be loaded by an instrument. It is dead weight.

---

## Arsenal Inventory

As Legos accumulate, log them here: name, source gig, reuse count, current state.

| Lego | Source | Reuse count | State |
|---|---|---|---|
| [[agents/Pantheon]] (core agent layer) | Internal | N/A | Active |
| _(client Legos ship here as they land)_ | | | |

---

## How to Apply at Brief Time

Before accepting any external build, the routing agent and the building agent answer three questions:

1. **What Legos does this gig produce?** Name them specifically. If you cannot name them, the scope is not modular enough yet.
2. **Are any of them already in the arsenal?** Check the inventory above before building. Reuse first, rebuild never.
3. **How does this build extend the arsenal?** Which new client verticals or capability gaps does it unlock?

These answers go into the delegation brief. If the answers are thin, the build plan needs a second pass before work starts.

---

## Cross-refs

- [[concepts/MAP]] — orientation hub, doctrine index
- [[concepts/Engineering Judgment Doctrine]] — boring path, invariant-first, handoff test
- [[concepts/Self-Improving CLAUDE.md]] — how new learning becomes permanent doctrine
- [[agents/Pantheon]] — instrument roster + SKILL.md extensibility checklist
