---
title: Learning Index
tags:
  - learning
  - moc
  - index
aliases:
  - Learning MOC
  - Considered Tools Index
---

# Learning Index

The principal's external memory of every considered tool, concept, repo, talk, or technique. Every entry corresponds to a `/learn` capture in this folder.

## How to use

When the principal hits a real problem:
1. Search this index for related categories
2. Read the relevant captures to remember what was decided and why
3. If a capture's "reconsider when" trigger has fired, add a follow-up note explaining the new context and resulting decision

When the principal does a learning sweep:
1. Run `/learn` for each tool/concept evaluated
2. The skill writes a capture file AND appends to this index automatically
3. After the sweep, this index reflects what's been considered

## Format

Each row: `[[capture-slug]] — {category} — {ADOPT|HOLD|REJECT|MONITOR} — {YYYY-MM-DD}`

## Index

*(Empty at install time. `/learn` populates this as the principal evaluates tools.)*

---

## Categories likely to populate over time

- **Application layer** — UI frameworks, app builders
- **Persistence** — databases, file stores, embedding stores
- **Messaging** — pub/sub, queues, event buses
- **Isolation** — sandboxes, containers, microvms
- **Compute** — model providers, GPU substrates, inference runtimes
- **Observability** — logging, tracing, metrics
- **Orchestration** — deployment, scheduling, resource management
- **Agent framework** — LangChain, CrewAI, AutoGen, Mastra
- **Prompt engineering** — patterns, libraries, evaluation tools
- **Doctrine concept** — frameworks, mental models, decision patterns

## Status definitions

- **ADOPT** — currently in use or being integrated
- **HOLD** — not now, but specific trigger condition would flip the decision
- **REJECT** — fundamentally not the right tool; rare reconsideration
- **MONITOR** — interesting, no clear path, re-evaluate next quarter

## Connects to

- [`/learn`](../../../skills/learn/SKILL.md) — the skill that maintains this index
- [[Modern AI Infrastructure Stack]] — the layer map used for categorization
- [[What I Am Not Building]] — where REJECT entries graduate when worth permanent doctrine
- [[Bio-hacking Posture]] — context for why this index exists
