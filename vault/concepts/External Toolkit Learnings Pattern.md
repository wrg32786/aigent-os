---
title: External Toolkit Learnings Pattern
tags:
  - doctrine
  - process
  - research
aliases:
  - toolkit learnings
  - rip pattern
created: 2026-04-24
---

# External Toolkit Learnings Pattern

> [!abstract] How to rip from external projects without forking
> When you encounter a well-built external system that overlaps your domain, **don't fork — distill**. Create a dedicated "Learnings" note per source, capture the adoptable patterns with attribution, mark each adoption status. The external source becomes a reference point, not a dependency.

---

## When to Use

- You find an open-source project that solves a problem adjacent to yours
- You want to adopt discipline, patterns, or structure from it
- Forking or importing is too heavy (different stack, too much surface)
- You want an auditable record of what you borrowed and why

---

## Structure

Create a note: `vault/concepts/External Toolkit Learnings - <source>.md`

**Required sections:**

1. **Frontmatter** with `source:` URL and `created:` date
2. **What it is** — 2-4 sentences disambiguating the project
3. **Executive Summary** — top 3-5 adoptable patterns with outcome
4. **Per-Pattern Findings** — each pattern with:
   - Quote/excerpt from the source
   - Why it matters for us
   - Translation / port (how we adapt it to our stack)
5. **What's NOT Rippable** — be explicit about what you rejected and why
6. **Adoption Status table** — which patterns landed, which are proposed, which are reference-only
7. **Related** — wikilinks to doctrine notes where each pattern was integrated

---

## Example Sources Worth Rip-Surveying

(General guidance, not prescriptive):

- Other open-source agent frameworks (architectural discipline, event bus patterns, memory models)
- Mature CLI tools in adjacent domains (process discipline, configuration patterns)
- Well-written CLAUDE.md files in popular repos (rule-writing patterns, tone, density)
- AI-first product repos from teams with clear opinions (testing discipline, prompt engineering patterns)

---

## Anti-Patterns

- **Don't port code you haven't understood.** A pattern is a rule; without the reasoning behind it, you can't judge edge cases or evolve it.
- **Don't adopt wholesale.** Every external system has assumptions that may not apply to yours. Explicitly mark what you rejected and why.
- **Don't treat the source as authoritative forever.** Capture the state at the time you read it; check back periodically but don't chase every update.

---

## Examples (Optional Starter Notes)

When you rip from a specific source, create a sibling note: `External Toolkit Learnings - <name>.md`. The sibling follows the structure above with specifics.

---

## Related

- [[Self-Improving CLAUDE.md]] — meta rule-writing pattern that pairs with this
- [[Memory Decay Doctrine]] — one pattern ripped from tinyhumansai/neocortex
- [[Feature Design Workflow]] — one pattern ripped from tinyhumansai/openhuman
