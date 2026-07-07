---
title: Agent Fitness Ledger
tags: [memory, somatic, agent-fitness, longitudinal]
aliases: ["agent fitness", "agent calibration"]
created: 2026-05-03
---

# Agent Fitness Ledger

Per-dispatch record of every `Agent` tool call across sessions. Append-only.

Populated by `daemons/agent-fitness-extract.py` from JSONL transcripts. See [[concepts/Somatic v0.5.0 Agent Fitness]] for the doctrine.

## Schema

| Field | Description |
|-------|-------------|
| `date` | YYYY-MM-DD of dispatch |
| `session_id` | JSONL session id (uuid prefix, dedup key) |
| `tool_use_id` | tool_use_id from JSONL (dedup key) |
| `agent_name` | subagent_type (echo, lyra, newton, etc) |
| `model` | sonnet / haiku / opus / default |
| `task` | description, head 80 chars |
| `tool_uses` | total tool_use count by sub-agent |
| `duration_ms` | result_ts − dispatch_ts |
| `outcome` | clean / blocked / errored / partial |
| `notes` | one-line classification reason |

## Outcome classification

- `errored` — tool_result `is_error: true` OR content contains "Error" / "InputValidationError"
- `blocked` — content contains "blocked" / "permission denied" / "sandbox" / "denied"
- `partial` — content contains "stopped short" / "incomplete" / "unable to verify"
- `clean` — none of the above

## Dispatches

| Date | Session | Tool ID | Agent | Model | Task | Tools | Duration | Outcome | Notes |
|------|---------|---------|-------|-------|------|-------|----------|---------|-------|
