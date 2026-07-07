---
title: Somatic v0.5.1-v0.5.3 Polish
tags: [doctrine, somatic, shipped, v0.5]
aliases: ["v0.5.1", "v0.5.2", "v0.5.3", "polish releases"]
created: 2026-05-03
status: shipped
---

# Somatic v0.5.1 – v0.5.3 — Polish releases

Three small wiring releases that close the v0.5 arc. Shipped together because each is too small to warrant its own spec doc but they cluster naturally.

## v0.5.1 — Working `/agent-fitness` report + heuristic refinement

**Files:**
- `daemons/agent-fitness-report.py` — new. Reads `AGENT_FITNESS.md`, prints per-agent calibration table + recent trend + repeat-blocker callouts + top failing pairs. Optional `--days N` window filter.
- `.claude/skills/agent-fitness/SKILL.md` — updated to document 3 modes: extract / report / report-windowed
- `daemons/agent-fitness-extract.py` — heuristic refined. Added 11 blocked/partial keywords ("BLOCKED:", "are denied", "blocker-found", "stopped short of", etc). The Lyra dispatch from S30d now correctly classifies `blocked` after the keyword expansion. Also fixed `SystemExit` swallow in the catch-all (was masking argparse errors).
- `daemons/memory-capture.sh` — `rule:` regex tightened from `\brule:?\s*(.+)` to `(?:^|[.\n])\s*rule:\s+(.+)` to avoid false-positives on "what's the rule for X" / "the rule is broken".

## v0.5.2 — `/close` runs `/system-check`

**Files:**
- `.claude/commands/close.md` — new Step 7.5 inserted between REMINDB validation and the commit summary.

Behavior:
- exit 0 (all PASS) → one-line `✓ /system-check: 6/6 PASS` in commit summary
- exit 1 (any FAIL) → FAIL lines surfaced in commit summary under `⚠ /system-check FAIL` block, principal sees but /close does NOT block
- INFO lines (daemon error log entries) → one-line summary, offer to surface details on request

Makes /close the natural smoke-test trigger. Catches silent breaks before next /open relies on them.

## v0.5.3 — Stop hooks for vault-write daemons

**Files:**
- `.claude/settings.json` — added 2 Stop hook entries to the existing `*` matcher

Hooks now firing on session end:
1. `discipline-check.sh` (existed)
2. `log-token-usage.sh` — appends a row to `memory/usage_log.md`. Was self-declared as a Stop hook in its comment but was NEVER actually wired in settings.json. Silent-success caught and fixed.
3. `agent-fitness-extract.py` — scans current session JSONL for Agent dispatches, appends new rows to `AGENT_FITNESS.md`. Idempotent.

**Bug found and fixed:** the original Stop hook command used `/c/Users/...` path style. Python on Windows native can't open that path (interprets as `C:\c\Users\...`). Same Git-Bash trap that bit caddy.sh in v0.4.1. Fixed by switching to `C:/...` form for python invocations. bash invocations (log-token-usage.sh, discipline-check.sh) keep `/c/...` form because bash on Git-Bash handles it natively.

## Tests passed

- v0.5.1: report renders correctly on real S30d ledger (11 dispatches, 4 agents, 100% calibration). Heuristic re-test on synthetic Lyra-block text classifies `blocked` correctly. `rule:` regex passes 6/6 boundary tests.
- v0.5.2: close.md edit lands correctly; /system-check call from inside /close traced through expected flow.
- v0.5.3: settings.json valid JSON; both new hooks fire green when run synthetically; daemon error log unchanged after extract run (no errors logged).

## Cross-links

- [[concepts/Somatic Roadmap]]
- [[concepts/Somatic v0.5.0 Agent Fitness]] — direct predecessor
- [[feedback/Silent successes hide failures]] — log-token-usage.sh wire-gap was exactly this pattern
- [[memory/AGENT_FITNESS]] — the data
