---
title: Somatic Layer
tags: [doctrine, architecture, memory, body-state]
aliases: ["body state", "somatic awareness", "Somatic Body", "v0.4 somatic"]
created: 2026-05-02
---

# Somatic Layer

> [!info] Doctrine canonical at `system/15_somatic_layer.md`. This note is the wikilink-friendly summary.

The somatic layer is the AIgent's capacity to read his own internal state — context pressure, memory pressure, decision pressure, token pressure, attention drift — before acting. Without it, instincts are vibes. With it, instincts are thresholds.

Designed with Codex collaboration, refined via [[Newton]]'s prior-art evaluation, shipped 2026-05-02.

## North Star

**More legible, not more reckless.** the AIgent does not become more autonomous by adding organs. He becomes more autonomous by becoming legible to himself first.

## What it adds (v0.4)

| Artifact | Role |
|---|---|
| `system/15_somatic_layer.md` | Doctrine — the five pressures, lazy-compute discipline, block schema, hot-path/background, distillation triggers |
| `memory/BODY_STATE.json` | Computed summary (typed/bounded/read-only fields per [[Letta]] block pattern). Empty at ship; populated lazily by `/body-check`. |
| `memory/MEMORY_CANDIDATES.md` | Staging buffer. Hot-path/background discipline (write free, curate later) per [[LangMem]] pattern. |
| `/body-check` | Lazy aggregation reader. Composes state from existing signals (HEAT_INDEX, usage_log, DECISION_LOG, ACTIVE_PRIORITIES, DELEGATION_TRACKER). Never duplicates. |
| `/digest` | Background curation tier. Reviews staged candidates, surfaces promote/skip/supersede choices. Never auto-promotes. |
| `/context-capsule` | Structured state preservation. Fires on context pressure OR task completion ([[Acontext]] distillation triggers). Resume-ready output. |

## What it explicitly does NOT add

- No polling daemon. The AIgent is session-bounded.
- No agent fitness tracking. Premature without failure volume.
- No /sleep skill. [[Hestia]] already owns 7-day sweep cadence.
- No autonomous promotion. /digest acts on principal's word only.
- No duplicate state. Body state READS from existing files, doesn't restate them.

## Patterns lifted from prior art

- **Letta** — block schema (typed/bounded/read_only metadata per BODY_STATE field). Prevents drift into freeform blobs.
- **LangMem** — hot-path/background memory split. Writes to MEMORY_CANDIDATES are free during sessions; curation happens at /digest.
- **Acontext** — distillation triggers. /context-capsule fires on context pressure AND task completion, not just token count.

## v0.4.1 — wiring release (banked, not dispatched)

See [[Somatic v0.4.1 Wiring]] for the full spec. Highlights:
- /open offers resume-from-capsule via BODY_STATE.last_capsule (id/path/objective only — resume_prompt lives in capsule file).
- /close digests staged candidates + creates capsule at completion + updates last_capsule.
- Caddy adds class-tagged hints (memory/context/body) with `/caddy-mute --class memory` 4h auto-expiry default.
- Capsule lifecycle: active → resumed → resolved with explicit + 30-day auto-resolve.
- Capsule chains via `parent_capsule_id` frontmatter for narrative reconstruction.

**Gate:** v0.4.1 doesn't dispatch until v0.4 sits through 1-2 real sessions. Plan-on-paper looks clean; plan-in-the-wild always reveals an assumption that didn't hold.

## Cross-links

- [[Memory Decay Doctrine]] — HEAT_INDEX 60-day decay; /body-check reads from this.
- [[Pipeline Verification Doctrine]] — same "trust output? no, trace the data" discipline applied to the AIgent's own state.
- [[Hestia]] — /digest invokes during her 7-day sweep cadence.
- [[Karpathy LLM Wiki]] / [[LLM Wiki Pattern]] — somatic layer is the lint+query+ingest meta-loop applied to internal state.
- [[concepts/Self-Improving CLAUDE.md]] — measurement substrate that v0.4 enables.

## Status

**v0.4: SHIPPED 2026-05-02.** Commit `766f5d9`. Vault carries identical artifacts at vault-relative paths.

First /close after v0.4 (this one) is the first real-use validation — proves model-aware token logging fires + stable session counter + lazy-compute body state has signals to read.
