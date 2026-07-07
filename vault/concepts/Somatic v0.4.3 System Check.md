---
title: Somatic v0.4.3 System Check
tags: [doctrine, somatic, shipped]
aliases: ["v0.4.3", "system-check"]
created: 2026-05-03
status: shipped
---

# Somatic v0.4.3 — System Check

Reflection organ. Smoke-tests every wired path in one shot, surfaces silent failures before they bite.

## Brief

> /system-check fires every wired skill, daemon, and state file. Reports green/red per path. Audits `.daemon-errors.log` for accumulated failures. Ships as a skill + a `daemons/system-check.sh` script.

## What it checks

| Check | Validates |
|---|---|
| Wired skills exist | body-check, digest, context-capsule, caddy-mute, system-check SKILL.md present |
| Daemon scripts exist + parse | caddy.sh, memory-capture.sh, sync-usage.sh, log-token-usage.sh, compute-heat.js — `bash -n` or syntax probe |
| State files valid | BODY_STATE.json (JSON + schema keys), HEAT_INDEX.json (JSON + mtime <7d), CADDY_MUTES.json (JSON if exists), MEMORY_CANDIDATES.md (table present), HESTIA_SWEEP_LOG.md (parseable) |
| Capsules dir healthy | All capsules have valid frontmatter (status enum, valid timestamps) |
| Doubled-write discipline | Public aigent-OS mirror has matching skill + daemon files |
| Daemon error log | Tail of `.daemon-errors.log` — count entries since last sweep, surface top 5 |

## Output

```
=== /system-check report — YYYY-MM-DDTHH:MM:SSZ ===
✓ Skills (5/5 wired)
✓ Daemons (5/5 parse green)
✓ State files (6/6 valid)
✓ Capsules (N healthy)
✗ Mirror discipline — diff in <file>
ℹ Daemon errors: 3 entries since last sweep (showing recent):
   - [caddy:class_muted] parse_failed ...
SUMMARY: 4 PASS / 1 FAIL / 1 INFO
```

Exits 0 if all green, 1 if any FAIL.

## Tests passed

- Synthetic: every wired path probed, report produced
- Forced fail: deliberately broke a daemon, /system-check surfaced the FAIL
- Mirror probe: deleted public aigent-OS mirror file, /system-check flagged drift
- Error log surfacing: pre-seeded 3 entries, /system-check counted + surfaced top entries

## Cross-links

- [[concepts/Somatic Roadmap]] — version queue
- [[feedback/Silent successes hide failures]] — doctrine that motivated this
- [[concepts/Somatic v0.4.1 Wiring]] § Implementation notes — original deferral
