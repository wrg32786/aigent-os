---
title: Somatic v0.5.0 Agent Fitness
tags: [doctrine, somatic, shipped, v0.5]
aliases: ["v0.5.0", "agent fitness", "agent calibration"]
created: 2026-05-03
status: shipped
---

# Somatic v0.5.0 — Agent Fitness

Track which sub-agents work, fail, or get blocked. Per-agent calibration ratios across sessions. The big one. Closes the Somatic 0.4.x → 0.5 arc.

## Brief

> Post-session JSONL transcript scanner extracts every `Agent` tool dispatch, classifies outcome (clean/blocked/errored/partial), appends a row to `AGENT_FITNESS.md`. New `/agent-fitness` skill surfaces calibration ratios and trends.

## Why this is the v0.5 anchor (not v0.4.x)

- Needs failure VOLUME to be useful — calibration on 3 dispatches is noise, on 100+ is signal
- The data has to accumulate over many sessions before insights surface
- v0.4.3 + v0.4.4 generate that data: /system-check + Hestia sweep both spawn agents, and `/sweep-now` will dispatch Hestia repeatedly going forward
- Crosses the threshold from "wiring releases" to "first measurement organ"

## Scope

### 1. AGENT_FITNESS.md ledger

Append-only, table-format. Schema:

| Field | Description |
|---|---|
| `date` | YYYY-MM-DD of dispatch |
| `session_id` | JSONL session id (uuid prefix, dedup key) |
| `tool_use_id` | tool_use_id from JSONL (dedup key) |
| `agent_name` | subagent_type (echo, lyra, newton, etc) or "general-purpose" |
| `model` | sonnet, haiku, opus, default |
| `task` | description field, head 80 chars |
| `tool_uses` | total tool_use count by sub-agent |
| `duration_ms` | result_ts − dispatch_ts |
| `outcome` | clean / blocked / errored / partial |
| `notes` | one-line auto-classification reason |

### 2. `daemons/agent-fitness-extract.py`

Scans the most recent JSONL transcript (or specific session via `--session`), finds all Agent tool_use + matching tool_result pairs, classifies outcome, appends new rows to AGENT_FITNESS.md.

Outcome classification heuristic:
- `errored` — tool_result has `is_error: true` OR result content contains "Error" / "ERROR" / "InputValidationError"
- `blocked` — result contains "blocked" / "permission denied" / "cannot" / "sandbox" / "Edit and Write are being denied"
- `partial` — result contains "stopped short" / "incomplete" / "unable to verify" / "BLOCKED"
- `clean` — none of the above

Dedup: skip if `(session_id, tool_use_id)` already in ledger.

### 3. `.claude/skills/agent-fitness/SKILL.md`

Reads AGENT_FITNESS.md, surfaces:
- Total dispatches in last 30 days
- Per-agent calibration ratio (clean / total)
- Per-agent recent outcome trend (last 10 dispatches)
- Top 3 failing agent/task pairs

### 4. Wiring

Initial wire: invoked manually via `/agent-fitness extract` for now. Future polish: Stop hook (same pattern as `log-token-usage.sh`).

## Tests passed

- Synthetic JSONL with 5 mock Agent calls (mix of outcomes) → extract produces 5 rows in correct format
- Dedup: re-run on same transcript → no new rows added
- Outcome classification: synthetic results for clean/blocked/errored/partial all classified correctly
- /agent-fitness skill spec parses cleanly + describes calibration math correctly
- Mirror to public aigent-OS: skill + daemon both present

## What v0.5.0 does NOT add

- No auto-dispatch reroute based on calibration (e.g., "Lyra failing on .claude/, route to main session"). Surfaces data; principal decides.
- No LLM analysis of failure patterns — heuristic classification only.
- No Stop-hook wiring yet (manual extract for v1; hook is v0.5.1 polish).
- No per-task-type calibration (all tasks pooled). Future: cluster by task description embeddings.

## Cross-links

- [[concepts/Somatic Roadmap]]
- [[concepts/Somatic Layer]]
- [[memory/AGENT_FITNESS]] — the data
- [[memory/TRUST_DECAY]] — sibling ledger (claim → outcome)
- [[memory/HONESTY_LEDGER]] — sibling ledger (work → calibration)
