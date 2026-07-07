---
title: Runtime State Layer
tags: [runtime, state, consciousness, somatic]
created: 2026-05-09
---

# Runtime State Layer

Computed runtime state that answers: what is the AIgent doing right now, what is blocked, what should happen next, and which reflexes should fire.

## Architecture

```
BODY_STATE.json     = vital signs (5 pressures, lazy-computed)
ACTIVE_STATE.json   = consciousness (mode, objective, blocked, reflexes)
VAULT               = long-term memory (notes, concepts, projects)
CAPSULES            = resumable snapshots (execution state)
FACTS               = temporal truth ledger (provenance, validity)
```

ACTIVE_STATE reads from all the others. It does not duplicate them. It is **computed, never hand-edited.**

## Files

| File | Purpose |
|------|---------|
| `ACTIVE_STATE.json` | Current computed state — mode, objective, pressures, reflexes |
| `STATE_EVENTS.jsonl` | Nervous system log — every state transition appended |
| `../../daemons/runtime/update-active-state.py` | The computer — reads 10+ sources, writes state |

## ACTIVE_STATE Schema

| Field | Type | Source |
|-------|------|--------|
| `mode` | idle / active / blocked / paused | Computed from capsule status + objective |
| `current_objective` | string or null | Latest SESSION_LOG "Next action" or capsule objective |
| `active_capsule` | object or null | From BODY_STATE.last_capsule |
| `active_loop` | object or null | Reserved for future loop harness |
| `pressure.*` | low / medium / high / critical | Imported from BODY_STATE |
| `open_threads` | array | From SESSION_LOG latest entry |
| `pending_decisions` | array | DECISION_LOG entries without DECISION_OUTCOMES match |
| `skill_gaps` | array | SKILL_GAPS rows with status=open |
| `blocked_items` | array | DELEGATION_TRACKER items with status=blocked |
| `last_verified_state` | string or null | From active capsule |
| `next_valid_action` | string or null | From active capsule or SESSION_LOG |
| `reflexes.*` | boolean | Computed from thresholds on other fields |

## Reflex Rules

| Reflex | Fires when |
|--------|-----------|
| `should_capsule` | context pressure >= high |
| `should_digest` | MEMORY_CANDIDATES has >30 staged items |
| `should_skill_hunt` | skill_gaps has items older than 7 days |
| `should_close` | session_age > 120 minutes (from BODY_STATE) |
| `should_escalate` | blocked_items has items older than 3 days |

## STATE_EVENTS Format

Each line is one event:
```json
{"time":"2026-05-09T01:00:00Z","event":"session_open","from":"idle","to":"active"}
{"time":"2026-05-09T01:30:00Z","event":"objective_set","value":"Build runtime state layer"}
{"time":"2026-05-09T02:00:00Z","event":"blocked","reason":"missing skill: repo scanner"}
{"time":"2026-05-09T02:30:00Z","event":"capsule_created","capsule_id":"2026-05-09-session39"}
{"time":"2026-05-09T03:00:00Z","event":"session_close","from":"active","to":"idle"}
```

## Wiring

- `/open` runs `update-active-state.py` then reads ACTIVE_STATE.json
- `/close` runs `update-active-state.py` after all vault writes
- `/status` reads ACTIVE_STATE.json and formats it
- Caddy can read `reflexes.*` for automatic hint surfacing

## Related

- [[Somatic Layer]] — BODY_STATE vital signs
- [[Capsule v2 Doctrine]] — capsule execution state
- [[Capability Expansion Doctrine]] — skill gaps feed reflexes
- [[Self-Learning Doctrine]] — failure pipeline feeds events
