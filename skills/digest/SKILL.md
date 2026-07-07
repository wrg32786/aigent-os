---
name: digest
agent: none
description: Review staged memory candidates from MEMORY_CANDIDATES.md. Surface each with promote/skip/supersede options. Does not auto-promote.
allowed-tools: Read, Edit, Grep
user-invocable: true
triggers:
  - digest
  - digest candidates
  - review memory candidates
  - process candidates
  - promote candidates
  - clean memory backlog
  - memory candidates
---

# /digest

Background curation tier. Reviews staged candidates and asks the principal to:
- **promote** → write to suggested destination (concepts/, decisions/, etc.)
- **skip** → mark `status: skipped`, leave in ledger
- **supersede** → strike + replace an existing vault entry

## When to run

- At `/close` (auto, surface candidates)
- When `/body-check` reports `memory_candidate_backlog > 10`
- Manually when the principal asks
- On Hestia's 7-day cadence (Hestia invokes `/digest` as part of her sweep)

## Behavior

1. Read `memory/MEMORY_CANDIDATES.md`. Filter `status: staged`.
2. Group by `type` (decision / preference / doctrine / project / person / skill).
3. Surface each group to the principal: source phrase, suggested destination, confidence.
4. For each, principal answers in one word: promote / skip / supersede / defer.
5. Apply the action. Update `status` and `digested_on` fields.

NEVER auto-promote. Only act on principal's word.
