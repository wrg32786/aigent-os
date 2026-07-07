---
title: Pantheon
tags:
  - agents
  - roster
  - doctrine
aliases:
  - Agent Pantheon
  - Instrument Roster
  - The Pantheon
created: 2026-07-07
---

# Pantheon

> [!abstract] One-line principle
> The Pantheon is the named roster of sub-agent "instruments" that ship with aigent-OS — each a distinct role, model tier, and scope, dispatched by the composer (the AIgent) for bounded, structured work. This note is the hub: what each instrument does, when to reach for it, and how to add a new one.

---

## Why a named roster, not generic labels

A generic label ("code agent," "review agent") tells you the function but not the *contract* — how much scope it takes, what tools it has, what it never does. Naming each instrument and giving it a fixed lane (read-only vs. write-capable, which model tier, what it refuses to do) makes delegation legible: the composer can dispatch by name and know exactly what comes back, and a reader six months from now can understand the roster from this table alone.

This is the concrete instantiation of [[concepts/Orchestration Lanes]] at the level of individual agents rather than lanes: before reaching for a lane (standing team / fan-out / solo-inline), you still need to know which instrument fits the task.

## The roster

| Instrument | Model | Role | Primary skills | Write access | File |
|---|---|---|---|---|---|
| Lyra | Sonnet | Writer / builder — takes a complete spec, returns a diff or built artifact | `ship-adapter`, `port-spec`, `self-review`, `honesty-check` | Yes (Read/Write/Edit/Bash) | `vault/agents/lyra.md` |
| Echo | Haiku | Scout / reader — read-only reconnaissance, structured findings, never builds | `scout-vault`, `skill-recall`, `semantic-search`, `deep-recon` | No (Read/Grep/Glob only) | `vault/agents/echo.md` |
| Newton | Sonnet | Research synthesist — multi-source deep dives, citation-dense briefings | `deep-recon`, `research-deep`, `tool-evaluation` | Briefing artifact only | `vault/agents/newton.md` |
| Iris | Sonnet | Visual designer / prompt engineer — design specs, image-gen prompts, never implements | `impeccable`, `taste-skill`, `ui-architecture`, `sprite-spec` | Spec/prompt artifacts only | `vault/agents/iris.md` |
| Mnemosyne | Sonnet | Memory architect — active synthesis, supersede semantics, note compaction | `compact-note`, `supersede`, `capsule-compact`, `digest` | Yes (Read/Write/Edit) | `vault/agents/mnemosyne.md` |
| Hypatia | Sonnet | Critic / devil's advocate — pre-decision adversarial review, read-only | `critique-plan`, `find-weakness`, `trust-decay` | No (Read/Grep/Glob/WebFetch) | `vault/agents/hypatia.md` |
| Hestia | Sonnet | Vault custodian — mechanical hygiene sweeps (stale trackers, dormant notes, broken links) | `sweep-now`, `sweep-heat`, `sweep-links`, `sweep-tracker` | Status-field edits only | `vault/agents/hestia.md` |
| Vitruvius | Sonnet | Architecture reviewer — macro structural review, diagnoses shape rather than fixing code | `diagnose`, `find-weakness`, `self-review` | No (Read/Grep/Glob/Bash) | `vault/agents/vitruvius.md` |
| Demosthenes | Sonnet | Prompt engineer — designs, evaluates, and optimizes prompts and system-prompt copy | `humanize-docs`, `honesty-check`, `skill-audit` | Yes (Read/Write/Edit) | `vault/agents/demosthenes.md` |

## Pairing patterns

Some instruments are designed to hand off to each other rather than work in isolation:

- **Iris → Lyra.** Iris designs the visual spec; Lyra ports it into code. Never ask Lyra to design from scratch, and never ask Iris to write implementation code.
- **Hypatia / Vitruvius → composer.** Both are read-only critics (strategy-level and architecture-level respectively) — they hand a structured critique back to the composer, who decides what to act on. Neither builds or merges.
- **Hestia vs. Mnemosyne.** Hestia does mechanical hygiene (no judgment calls: flip a stale status, flag a broken link). Mnemosyne does the judgment calls (what's actually stale vs. load-bearing, what should be compacted vs. preserved). Don't ask Hestia to make a preservation decision, and don't ask Mnemosyne to run a routine sweep she doesn't need to think about.

## Extensibility checklist — adding a new instrument

Before creating a new named instrument, run the criteria in `system/09_subagent_manifest.md` first (specialization creates leverage, recurring need, clear scope boundary, model-routing benefit). If all four hold:

1. **Define the def** — name, one-sentence role, tools list, model tier — in a new `vault/agents/<name>.md` file, following the existing files' structure (frontmatter, skills list, operating rules, strengths, voice, vault-memory cross-ref).
2. **Add a row to the roster table above** — model, role, primary skills, write access, file path.
3. **Cross-reference `[[agents/Pantheon]]`** from the new agent's own file (vault memory section), matching the existing 9.
4. **Register the def with the harness** — `install.sh` copies each agent def from `vault/agents/` into `.claude/agents/` on install; that is the only place Claude Code loads dispatchable subagents from. After adding one to a live install, copy it into `.claude/agents/` (or re-run `install.sh`) before it can be spawned. See `CLAUDE.md`'s Import Wiring Protocol.
5. **Don't hoard.** If an instrument hasn't been dispatched in 30 days, evaluate whether it's still earning its place on the roster (see `system/09_subagent_manifest.md`'s Agent Hygiene section).

## What this roster is NOT

- **Not a hierarchy.** Every instrument reports to the composer (the AIgent), not to each other, except for the explicit pairing patterns above.
- **Not exhaustive of what a fork can build.** This is the roster that ships with aigent-OS by default. A fork is free to rename, remove, or add instruments — the pattern (named role + fixed scope + model tier + skills list) is the reusable part, not these specific nine names.
- **Not a replacement for [[concepts/Orchestration Lanes]].** Knowing which instrument fits a task is a separate question from which lane (standing team, fan-out, solo-inline) the work should run in. Answer both before dispatching.

## Connects to

- [[concepts/MAP]] — orientation hub; Roster section there is the quick-reference version of this table
- [[concepts/Orchestration Lanes]] — the lane a task runs in, once you know which instrument(s) it needs
- [[concepts/Core Operating Ethos]] — the six pillars every instrument operates under regardless of role
- [[concepts/Lego Arsenal Doctrine]] — the Pantheon itself is the core reusable Lego: a fixed set of scoped, documented instruments
- `system/09_subagent_manifest.md` — the criteria for creating a new agent at all, upstream of naming it
- `feedback/Model routing discipline` — why each instrument sits on the model tier it does
