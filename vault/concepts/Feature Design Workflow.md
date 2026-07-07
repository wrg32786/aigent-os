---
title: Feature Design Workflow
tags:
  - doctrine
  - engineering
  - process
  - standing-rule
aliases:
  - 5-step ladder
  - feature ladder
  - feature-design-workflow
created: 2026-04-24
source: tinyhumansai/openhuman (CLAUDE.md §Feature design workflow)
---

# Feature Design Workflow

> [!abstract] The 5-step ladder
> A feature is incomplete until it has been specified against the current codebase, implemented in the core, proven over the API boundary, surfaced in the UI, and tested end-to-end. **Skipping a rung is a spec failure, not an execution convenience.** Pattern adapted from [openhuman](https://github.com/tinyhumansai/openhuman).

---

## The Ladder

**For any new capability** — new domain, new endpoint, new user-facing feature, provider integration:

1. **Specify against the current codebase.** Ground the design in existing domains, schemas, routing, and naming conventions. Use existing patterns (e.g., one RPC verb per capability, shared types for cross-domain contracts). **No parallel architectures.** If a capability doesn't fit existing patterns, either the pattern is incomplete (extend it) or the cut is wrong (resize it).
2. **Implement in the core.** Domain logic in a dedicated subdirectory. Schemas, handlers, unit tests until correct in isolation. No UI yet.
3. **Prove over the API / RPC boundary.** Extend integration tests so endpoints match exactly what the UI will call. If the UI can't call it over the wire, the UI layer can't prove it works — which means the feature isn't proven.
4. **Surface in the UI.** React screens, state, API client calls. Keep rules in the server. UI only orchestrates and presents.
5. **Test at both layers.** Unit tests for components/services, end-to-end specs for user-visible flows.

---

## Planning Rule

**Before writing code, define the E2E scenarios that cover the full intended scope:**

- Happy path
- Each failure mode (including the one you don't think can happen)
- Auth / authorization gates
- Regression anchors (what must keep working)
- Acceptance criteria that are specific and measurable — not "works" but something checkable (numeric thresholds, parity bars against a reference, clean e2e with zero hotfix PRs)

**If a feature isn't testable end-to-end, either the spec is incomplete or the cut is too large.** Split it until each piece is E2E-testable.

---

## Anti-Patterns (what this rule is fighting)

- **Implementing in the UI first** and retrofitting the server. Inverts the control-flow direction; business logic ends up scattered across client handlers.
- **Skipping API-layer proof** because "the UI tests cover it." API tests are cheaper, catch contract drift faster, and don't depend on UI rendering.
- **Vague acceptance criteria.** "It should work" is not acceptance. Replace with specific, measurable bars.
- **Parallel architectures** for new features that don't fit existing patterns. Forces future cleanup — the bigger the divergence, the more expensive the reconcile.

---

## When to Apply

- Any new domain capability
- Any new pipeline stage
- Any new provider integration
- Any new user-facing surface
- Any change that adds/removes/renames a user-facing feature

**Not required for:** bug fixes, internal refactors that don't change behavior, mechanical rewrites. Those can go through a lighter tier-tag PR review process.

---

## Related

- [[Self-Improving CLAUDE.md]] — meta pattern for capturing learnings
- [[Memory Decay Doctrine]] — how vault notes stay fresh; parallel discipline for knowledge
