---
title: Gstack Port
tags:
  - skills
  - gstack
  - port
  - security
  - debugging
  - product
aliases:
  - gstack skills port
created: 2026-05-01
---

# Gstack Port

> [!info] Source
> Skills ported from [garrytan/gstack](https://github.com/garrytan/gstack) on 2026-05-01. Ported 5 skill sets (9 skill files total).

## What was ported

| The AIgent skill | gstack source | Description |
|-------------|---------------|-------------|
| `/office-hours` | `office-hours/` | YC product interrogation, 6 forcing questions, builder mode |
| `/autoplan` | `autoplan/` | Full plan review gauntlet with auto-decisions |
| `/investigate` | `investigate/` | 4-phase root cause debugging |
| `/security-audit` | `cso/` | OWASP + STRIDE security audit (renamed from `/cso`) |
| `/careful` | `careful/` | Destructive command warnings (hook) |
| `/freeze` | `freeze/` | Edit scope lock to directory (hook) |
| `/guard` | `guard/` | Combined careful + freeze |
| `/unfreeze` | `unfreeze/` | Clear freeze boundary |

Hook scripts go in `.claude/hooks/careful/check-careful.sh` and `.claude/hooks/freeze/check-freeze.sh`.

> [!danger] Hooks are NOT enabled by default
> Enable hooks per session via settings.json PreToolUse config or `/hookify`. Do not enable globally without explicit decision.

## What was adapted

- **`/security-audit`** renamed from `/cso` (Chief Security Officer) — plainer English.
- **`/autoplan`** gstack uses Codex CLI for dual-voice review. The AIgent equivalent: an adversarial critic instrument for the adversarial pass, `/pr-audit` or `/self-review` for the engineering pass. Codex-specific preamble, telemetry, gstack binary calls stripped.
- **`/office-hours`** gstack preamble (100+ lines of update-check, telemetry, session tracking) stripped entirely. Core methodology (6 questions, phases 1-5, design doc templates) preserved verbatim.
- **`/investigate`** gstack preamble stripped. Iron law, 4 phases, pattern table, 3-strike rule preserved verbatim.
- **`/careful` / `/freeze` / `/guard` / `/unfreeze`** hook scripts ported verbatim (gstack analytics logging removed).

## What was skipped / not applicable

- **gstack preamble boilerplate** (all skills): gstack-update-check, telemetry, GBrain sync, session tracking, AskUserQuestion format, Completeness Principle, Continuous Checkpoint Mode, Context Health, Question Tuning, gstack-learnings system. All gstack-internal infrastructure.
- **`/autoplan` Codex CLI dual-voice** (`codex exec`, `codex review` bash blocks): Codex CLI not installed. Substitute your own review instruments.
- **`/office-hours` Phase 6 tier-based relationship closing**: builder profile system, tier detection, profile append. Gstack-internal CRM pattern.
- **`/investigate` freeze hook dependency**: gstack's investigate references freeze via a relative path. The AIgent version uses local hook paths if freeze is active.
- **`/cso` Phase 8 skill supply chain Snyk ToxicSkills reference**: preserved methodology, dropped gstack-specific stat.

## Residual gaps

- `/autoplan` phases reference gstack plan review skills (`plan-ceo-review/SKILL.md`, `plan-eng-review/SKILL.md`) that don't exist here. Inline the methodology from your decision frameworks instead.
- Hooks require manual settings.json wiring per session.

## Related

- [[Engineering Judgment Doctrine]] — cross-referenced from `/autoplan`
- [[Lego Arsenal Doctrine]] — why porting was the right call over forking
