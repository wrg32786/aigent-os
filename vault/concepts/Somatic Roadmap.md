---
title: Somatic Roadmap
tags: [doctrine, architecture, somatic, roadmap]
aliases: ["Somatic queue", "Somatic versions"]
created: 2026-05-03
---

# Somatic Roadmap

The forward queue for the Somatic layer. Each version is a small wiring release that earns the next. Versions ship only after 1-2 clean cycles of the predecessor in real-world use — the "plan-on-paper vs plan-in-the-wild" gate codified after the v0.4.1 same-session test surfaced a real Caddy bug (Git-Bash path translation).

## Shipped

| Version | Title | Shipped | Notes |
|---|---|---|---|
| v0.4 | Sense — body-check + capsule + digest organs | 2026-05-02 | First real fire 2026-05-03 (S30d). Wiring gap caught: skills shipped to public aigent-OS but never copied to local `.claude/skills/`. Fixed via `cp -r` + doubled-write doctrine banked. |
| v0.4.1 | Rhythm — /open Step 2.5 resume + /close Step 0.5 auto-integrations + Caddy class system + /caddy-mute | 2026-05-03 (S30d) | One bug found and fixed in test (Git-Bash path translation). End-to-end test 31/32 green; Step 0.5 fired correctly on real /close. |
| v0.4.2 | Input — auto-capture from high-confidence trigger phrases | 2026-05-03 (S30d) | Same-session ship after silent-success fix pass cleaned up `2>/dev/null` patterns across 3 daemons. Lyra-built, 6/6 tests passed including best-effort failure path. |
| v0.4.3 | Reflection — /system-check smoke test | 2026-05-03 (S30d) | Will overrode the 1-2-cycle gate; everything tested synthetically in-session. Skill + daemons/system-check.sh. Audits 8 skills, 8 daemons, 7 state files, capsules, mirror, daemon error log. Caught one false-alarm "v0.4.2 bug" that turned out to be Lyra's deliberate failure-test residue. |
| v0.4.4 | Hestia wiring — body-check reads HESTIA_SWEEP_LOG, /sweep-now skill | 2026-05-03 (S30d) | 4/4 synthetic tests passed (empty log → null + sweep reflex; recent → null reflex; 10d old → sweep reflex; multiple → picks newest). |
| v0.4.5 | Capsule chain compaction — `/capsule-compact <head>` | 2026-05-03 (S30d) | 5/5 synthetic tests passed (6→4 compaction; idempotency; short-chain no-op). daemons/capsule-compact.py + skill. Marks compacted capsules with `compacted_into:` for archeology. |
| v0.5.0 | Agent fitness — extract from JSONL + ledger + skill | 2026-05-03 (S30d) | 3/3 synthetic + real tests passed. AGENT_FITNESS.md ledger initialized + populated with 11 real dispatches from S30d. Heuristic classification has known limits — Lyra's actual block today classified `clean` because tool_result summary text didn't hit keywords precisely. v0.5.1 will refine. |
| v0.5.1 | Polish + working /agent-fitness report | 2026-05-03 (S30d) | `daemons/agent-fitness-report.py` reads ledger, prints per-agent calibration table + recent trend + repeat-blocker callouts + top failing pairs. Heuristic refined: 11 keywords added to blocked/partial. `rule:` regex tightened (sentence boundary required). Verified by re-classifying a synthetic Lyra block — now correctly catches "BLOCKED:" / "are denied" / "blocker-found" patterns. |
| v0.5.2 | /close runs /system-check | 2026-05-03 (S30d) | Step 7.5 added to `.claude/commands/close.md`. Every /close audits 8 skills + 8 daemons + 7 state files + capsule frontmatter + mirror discipline + daemon error log. PASS → one-line summary. FAIL → surface details, do NOT block close. |
| v0.5.3 | Stop hooks for vault-write daemons | 2026-05-03 (S30d) | settings.json gains 2 new Stop hooks: `log-token-usage.sh` (was self-declared as Stop hook in its comment but never actually wired — silent-fail caught) + `agent-fitness-extract.py`. Found another Git-Bash path bug while wiring: Python on Windows native can't open `/c/...` paths in Stop hook commands. Fixed by using `C:/...` form. |

## Explicitly NOT on the roadmap

These were considered + rejected:
- **Polling daemon** — violates Somatic doctrine (lazy compute only). Never ship.
- **Autonomous promotion** — violates principal-curates rule. Never ship.
- **Auto doctrine edits** — needs safety/rollback guards that don't exist. Premature.
- **External repo research loop** — new integration surface, scope-creeps the somatic layer beyond personal the AIgent.
- **Adaptive authority matrix** — needs decision pattern history. v0.5+ if ever.
- **Dream log** — the AIgent doesn't run between sessions; the gap is fictional.

## Doctrine that shapes the queue

- **The 1-2 cycle gate.** Every version waits for predecessor to run clean in real-world use before shipping. See v0.4.1 same-session test that caught the Caddy path bug.
- **Doubled-write discipline.** Every skill / daemon change writes to BOTH local `.claude/` AND public aigent-OS. See [[memory/FAILED_EXPERIMENTS]] ship-to-public-without-local-mirror entry.
- **Silent-success guard.** Every daemon path that swallows errors must route stderr to `<vault>/memory/.daemon-errors.log`. No `2>/dev/null` without recovery. See [[feedback/Silent successes hide failures]].
- **Lazy compute, no daemon.** /body-check and friends run on invocation. No background polling. Doctrine source: [[system/15_somatic_layer.md]] § What this is NOT.
- **Principal curates.** /digest surfaces options, never auto-promotes. Memory capture stages, doesn't promote.

## Cross-links

- [[concepts/Somatic Layer]] — base doctrine
- [[system/15_somatic_layer.md]] — canonical doctrine
- [[concepts/Somatic v0.4.1 Wiring]] — shipped 2026-05-03
- [[concepts/Somatic v0.4.2 Memory Capture]] — shipped 2026-05-03
- [[memory/FAILED_EXPERIMENTS]] — doubled-write rule
- [[feedback/Silent successes hide failures]] — silent-success guard rule
