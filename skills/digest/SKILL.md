---
name: digest
agent: none
description: "Review MEMORY_CANDIDATES.md with promote, skip, or supersede choices. Use when digesting staged memory or clearing its backlog. No automatic promotion."
allowed-tools: Read, Edit, Grep, Bash
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

Background curation tier. Reviews staged candidates and asks the operator to:
- **promote** → write to suggested destination (concepts/, decisions/, etc.)
- **skip** → mark `status: skipped`, leave in ledger
- **supersede** → strike + replace an existing vault entry

## When to run

- At `/close` (auto, surface candidates)
- When `/body-check` reports `memory_candidate_backlog > 10`
- Manually when the operator asks
- On the documented seven-day vault-maintenance cadence

## Behavior

1. Resolve the memory root with `node daemons/memory-root.cjs --root <root>`.
   Use the state-home as the base when `AIGENT_STATE_HOME_DIR` is set. The resolver
   honors `.aigent/state.json` field `memory_root` and defaults to `vault/memory`.
   Read `<memory-root>/MEMORY_CANDIDATES.md`. A table row is pending when its
   Status column is `staged` or `unscanned`. Scan unscanned rows before promotion.
   Under dated capsule-cycle headings, a bullet is staged unless marked banked
   (e.g. `Banked in [[note]]` or `banked as a decision`), ruled, discharged,
   skipped, or superseded.
2. Group by `type` when present (decision / preference / doctrine / project / person / skill).
3. Surface each group to the operator: source phrase, suggested destination, confidence.
4. For each, the operator answers in one word: promote / skip / supersede / defer.
5. Apply the action. Update the row's `status` and `digested_on`. On a bullet,
   record `Banked in [[destination]]`, `[skipped]`, or `[superseded]` as appropriate.
   Defer leaves the entry staged.

NEVER auto-promote. Only act on the operator's word.
