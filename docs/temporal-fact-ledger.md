---
title: Temporal Fact Ledger
tags: [doctrine, memory, temporal, facts, phase2]
aliases: [Fact Ledger, temporal facts, facts.jsonl]
created: 2026-05-08
---

# Temporal Fact Ledger

> [!abstract] Core principle
> Facts have provenance, validity windows, and temporal relationships. They are not just overwritten. (Graphiti/Memoir pattern: time as first-class memory infrastructure.)

## Why temporal facts

Memory notes go stale. When a fact changes, the old note gets edited and the prior state is lost. The temporal fact ledger preserves:

- **What was true then?** — `valid_from` / `valid_until` window
- **What changed?** — `superseded_by` links old fact to new
- **Where did this belief come from?** — `source` field (vault note, daily note, session)
- **Is this still valid?** — `valid_until: null` means currently believed true
- **Who asserted it?** — `created_by` (aigent, will, agent name)

## Schema

Each fact is one line in `memory/facts/facts.jsonl`:

```json
{
  "fact_id": "f001",
  "subject": "ProjectX",
  "predicate": "uses",
  "object": "Runway API",
  "valid_from": "2026-05-08",
  "valid_until": null,
  "source": "daily/2026-05-08.md",
  "confidence": 0.86,
  "created_by": "aigent",
  "superseded_by": null
}
```

## Operations

### Assert (new fact)
Append a new line to facts.jsonl with a unique `fact_id`, `valid_from` = today, `valid_until` = null.

### Supersede (fact replaced)
1. Edit old fact: set `superseded_by` = new fact_id, set `valid_until` = today
2. Append new fact with updated object/predicate

### Expire (no longer true)
Edit fact: set `valid_until` = today. No new fact created.

### Query (what was true at time T?)
Filter facts.jsonl where `valid_from <= T` AND (`valid_until is null` OR `valid_until > T`).

## Rules

1. Every fact needs a `source`. No sourceless assertions.
2. Superseding writes `superseded_by` on the old fact AND creates a new fact.
3. `confidence` is 0.0-1.0. Direct observation = 1.0. Inference = lower.
4. Facts are append-mostly. Edits only to set `superseded_by` or `valid_until`.
5. Fact IDs are sequential: f001, f002, etc.

## Related

- [[Self-Improving CLAUDE.md]] — the broader learning loop
- [[concepts/remindb]] — SQLite augment candidate for agent-consumable fact queries
- [[Memory Decay Doctrine]] — how facts age and lose relevance
- [[memory/facts/facts.jsonl]] — the ledger file
