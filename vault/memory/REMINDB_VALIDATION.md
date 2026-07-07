---
title: REMINDB Validation
tags:
  - memory
  - measurement
  - remindb
  - phase-gate
aliases:
  - remindb phase gate
  - remindb session tracker
created: 2026-05-02
---

# REMINDB Validation

Structural enforcement of the phase-2 gate. Not memory — a ledger that auto-increments via /close and triggers /open to surface the prompt at threshold. See [[concepts/remindb]] for the full phase-2 scope.

## Status

- **Sessions logged:** 0
- **Failures observed:** 0
- **Phase 2 ready:** NO (need 5+ clean sessions)
- **Last clean reset:** (set on first use)

## Phase 2 trigger

When `Sessions logged >= 5` AND `Failures observed since last clean reset == 0`, /open surfaces:

> remindb validated 5 sessions clean — phase 2 ready. update pantheon defaults to remindb-first?

If the principal answers yes, dispatch the builder agent for the pantheon-update work per [[concepts/remindb]] § Standing direction.

## Failure definitions

Any of the following resets the session streak to 0 and increments `Failures observed`:

- MCP handshake fails — remindb server doesn't spawn or initialize handshake errors
- `MemorySearch` returns stale data — vault file edited >5min ago, query returns pre-edit content
- `MemorySearch` returns empty for content known to exist in the vault
- Auto-rescan stopped — 5+ min elapsed since a vault edit, no new node hash recorded
- Server crashes mid-session — MCP connection drops after a successful start

If the session had zero remindb activity (the AIgent never called a remindb tool), do NOT increment sessions logged. Log as "not used" in notes.

## Per-session log

| Session date | remindb fired? | Failures? | Notes |
|---|---|---|---|
| (auto-appended by /close) | | | |
