---
name: system-check
agent: none
description: Full-stack smoke-test covering Somatic v0.4/v0.5 layer AND Cognitive v0.7 runtime. Skills, daemons, state files, runtime files, capsules, mirror discipline, evals, daemon error log. Reports green/red per path.
allowed-tools: Bash, Read
user-invocable: true
triggers:
  - system check
  - somatic check
  - smoke test
  - check wiring
  - is everything wired
  - audit somatic
  - cognitive check
  - runtime check
  - /system-check
---

# /system-check

Run `bash daemons/system-check.sh` from the vault root.

Covers the full stack — Somatic v0.4/v0.5 AND Cognitive v0.7.

## Somatic layer (v0.4/v0.5)

- **Skills (8):** body-check, digest, context-capsule, caddy-mute, system-check, sweep-now, capsule-compact, agent-fitness
- **Daemons (8):** caddy.sh, memory-capture.sh, sync-usage.sh, log-token-usage.sh, system-check.sh, compute-heat.js, capsule-compact.py, agent-fitness-extract.py
- **State files (7):** BODY_STATE.json (schema keys), HEAT_INDEX.json (JSON + mtime <7d), CADDY_MUTES.json (if present), MEMORY_CANDIDATES.md (table present), HESTIA_SWEEP_LOG.md, AGENT_FITNESS.md (header row), capsules dir (non-empty)
- **Capsules health:** all capsules have valid frontmatter (status enum, capsule_id)
- **Mirror discipline:** vault `.claude/skills/` and `daemons/` match public aigent-OS

## Cognitive layer (v0.7)

- **Skills (9):** status, reconcile, dream, meta-improve, skill-recall, skill-hunt, context-capsule, pause, resume
- **Runtime daemon:** `daemons/runtime/update-active-state.py` — exists + parses
- **Runtime state files (8):**
  - `ACTIVE_STATE.json` — valid JSON, `mode` in [stabilization, build, expansion, recovery]
  - `SELF_MODEL.json` — `capabilities` and `limitations` arrays non-empty
  - `GOAL_STACK.json` — `active_goals` array exists
  - `BELIEF_STATE.jsonl` — valid JSONL, last entry has `confidence` field
  - `LESSONS.jsonl` — valid JSONL
  - `PROCEDURES.jsonl` — valid JSONL
  - `STATE_EVENTS.jsonl` — valid JSONL
  - `DREAM_LOG.md` — exists; FAIL if last modified > 7 days ago
- **Evals directory:** `evals/` exists and contains at least one file

## Daemon error log

Tail of `memory/.daemon-errors.log` — count + top 5 entries surfaced as INFO.

Exits 0 if all green, 1 if any FAIL.

## When to run

- On demand when something feels off
- After shipping any Somatic or Cognitive version update
- Before closing a session where runtime state was mutated
- After `/dream` or `/reconcile` to confirm state files updated cleanly

## What it does NOT do

- Does not fix anything. Read-only audit.
- Does not validate semantic correctness — only that wired things parse and exist.
- Does not run heavy computation. Should complete in <5 seconds.
