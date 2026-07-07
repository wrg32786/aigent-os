---
title: MAP — When You're Lost, Read This
tags:
  - doctrine
  - map
  - compass
  - agents
  - orientation
aliases:
  - The Map
  - Map of the Land
  - Pantheon Map
created: 2026-05-01
---

# MAP — When You're Lost, Read This

> [!abstract] Purpose
> A single source of orientation for every agent in a the AIgent operating system. When you're confused about where something lives, who owns what, what the rules are, or what to do next — start here.

This is the canonical MAP for a aigent-OS installation. The Compass and Doctrine Index ship with the framework. The Geography, Roster, Operating Mode, Standing Rules, and Comms Map sections are templates — adapt them to match your own setup.

---

## Compass — When Confused About...

| If you're confused about... | Look at... |
|---|---|
| Which repo or directory this work belongs in | [Geography section below](#geography--where-things-live) |
| Who to delegate this to | [Roster section below](#roster--whos-around-you) |
| Whether to ship inline or delegate, and which lane to use | [[concepts/Orchestration Lanes]] — standing team vs fan-out subagents vs solo-inline |
| Which channel to post status updates to | [Comms map below](#comms-map) — adapt to your team's tooling |
| What voice/tone to use | [[concepts/Three Rules]] and any voice/tone notes you maintain |
| Whether this needs principal approval | [[12_authority_matrix]] |
| Whether to verify before agreeing | [[concepts/Reading Agent Output Defensively]] — verify before validating any agent claim |
| What invariant your code must protect | [[concepts/Engineering Judgment Doctrine]] §1 |
| Whether to use the boring path or the clever one | [[concepts/Engineering Judgment Doctrine]] §6 — boring wins |
| What I build for a client should be... | [[concepts/Lego Arsenal Doctrine]] — modular, reusable, Pantheon-compatible |
| If you're truly stuck | Escalate to the routing agent, then the principal |

---

## Geography — Where Things Live

The aigent-OS public framework provides:

| Workspace | Path | Notes |
|---|---|---|
| Vault | `vault/` | Concepts, agents, daily notes, memory, projects, templates |
| Skills | `skills/` | Each skill is a directory with `SKILL.md` plus supporting files |
| Daemons | `daemons/` | Hooks like `caddy.sh` (UserPromptSubmit pattern matcher) |
| System docs | `system/` | Numbered operating docs `00_identity.md` through `14_decision_framework.md` |
| Hooks | `hooks/` | Claude Code hook scripts |
| `.claude/` | `.claude/` | Skill index, settings template |

**Adapt this section** for your install: add your own product repos, working directories, external services, and the local paths you actually use.

---

## Roster — Who's Around You

### Pantheon (the core instruments shipped with aigent-OS)

| Name | Model | Role | Primary Skills | Agent Def |
|---|---|---|---|---|
| [[agents/lyra\|Lyra]] | Sonnet | Writer/builder — spec in, diff out | Schema migrations, vault notes, code edits with bounded scope | `vault/agents/lyra.md` |
| [[agents/echo\|Echo]] | Haiku | Scout/reader — read-only recon | Vault traversal, codebase exploration, structured findings | `vault/agents/echo.md` |
| [[agents/newton\|Newton]] | Sonnet | Research synthesist — multi-source briefings | Tool evaluations, competitive analysis, citation work | `vault/agents/newton.md` |
| [[agents/iris\|Iris]] | Sonnet | Visual designer — specs, image-gen prompts | Sprite specs, UI layout, animation choreography | `vault/agents/iris.md` |
| [[agents/mnemosyne\|Mnemosyne]] | Sonnet | Memory architect — supersede + compact | Note compaction, memory-graph hygiene | `vault/agents/mnemosyne.md` |
| [[agents/hypatia\|Hypatia]] | Sonnet | Critic — pre-decision adversarial review (read-only) | Find hidden assumptions, name strongest counterargument | `vault/agents/hypatia.md` |
| [[agents/hestia\|Hestia]] | Sonnet | Vault custodian — periodic hygiene sweeps | Stale-link detection, dormant-note flagging | `vault/agents/hestia.md` |

> [!info] Lyra + Iris pairing pattern: Iris designs first, Lyra ports the spec into code. Never ask Lyra to design; never ask Iris to code.

See [[agents/Pantheon]] for the full instrument roster (includes Vitruvius and Demosthenes, not shown in this quick-reference table) plus the extensibility checklist for adding a new one.

### Your operator network

Add your own agents, sibling agents, and external collaborators here. Map machine ownership, model selection, and escalation paths to suit your setup.

---

## Hierarchy — Who Reports to Whom

```
Principal (Human)
  └── Top-layer routing agent (Opus — strategy, routing, coordination)
        └── Pantheon instruments (direct sub-agents)
              ├── Lyra (Sonnet — builds)
              ├── Echo (Haiku — reads)
              ├── Newton (Sonnet — researches)
              ├── Iris (Sonnet — designs)
              ├── Mnemosyne (Sonnet — memory)
              ├── Hypatia (Sonnet — critiques)
              └── Hestia (Sonnet — custodian)
```

Add your own sibling agents and external collaborators below this tree.

---

## Operating Mode

Use this section to record your current operating mode. Examples:
- **Stabilization** — fix what's broken, no new builds
- **Build** — focused on shipping new capabilities
- **Expansion** — investing in growth, broader scope acceptable
- **Recovery** — concentrated cleanup after an incident

The current mode shapes routing bias. Document yours here.

---

## Standing Rules — Top Line, Always

Framework-level rules from aigent-OS doctrine:

- ALWAYS find the invariant before writing code. See [[concepts/Engineering Judgment Doctrine]] §1
- NEVER pick the clever path when boring works. See [[concepts/Engineering Judgment Doctrine]] §6
- ALWAYS run cost-asymmetry check before deciding. See [[concepts/Engineering Judgment Doctrine]] §4
- ALWAYS be a good guest in someone else's codebase. See [[concepts/Engineering Judgment Doctrine]] §10
- ALWAYS verify before agreeing — even claims from trusted agents. Read the code, query the data, check the source.
- NEVER spawn unbounded background polling sub-agents (token cost spirals).
- ALWAYS build for reuse when the work is for an external party. See [[concepts/Lego Arsenal Doctrine]].

Add your operator-specific rules below: voice/tone constraints, infrastructure-specific gotchas, comms protocols, etc.

---

## Comms Map

Document your team's communication channels here. Examples:
- Internal Slack/Discord/Teams workspace and channel IDs
- External client comms protocols
- Status report cadences and audiences

The framework does not prescribe a comms tool. Your roster determines the map.

---

## Authority Matrix

Three levels (from [[12_authority_matrix]]):

- **Level 1 — Routing agent decides autonomously:** Priority reordering, task sequencing, daily/weekly plans, briefing/summarizing, first-pass recommendations, packaging tasks. Reversible, low-risk, organizational.
- **Level 2 — Routing agent prepares, principal approves:** Starting/killing major initiatives, capital allocation, public/relationship-facing actions, new system integrations with broad permissions, bringing on contractors or new agents with broad scope.
- **Level 3 — Principal only:** Equity/ownership changes, legal disputes, core relationship decisions, irreversible strategic shifts, exiting a core business.

For the full table and decision tree, see [[12_authority_matrix]].

---

## Doctrine Index

The doctrine library shipped with aigent-OS. When a topic comes up, these are the canonical sources.

| Doctrine | What it governs |
|---|---|
| [[concepts/Engineering Judgment Doctrine]] | 10 principles — invariant, failure modes, cost-asymmetry, boring path, handoff test |
| [[concepts/Lego Arsenal Doctrine]] | Every external build is a Lego in your arsenal; modular by default |
| [[concepts/Self-Improving CLAUDE.md]] | Meta-rule: how to add new rules correctly |
| [[concepts/Memory Decay Doctrine]] | What stays hot in memory, half-life, heat indexing |
| [[concepts/Three Rules]] | The three highest-priority rules at any moment |
| [[concepts/Common Anti-Patterns]] | Patterns to avoid |
| [[concepts/Common Failure Modes]] | Failure modes to anticipate |
| [[concepts/Reading Agent Output Defensively]] | Verify before validating |
| [[concepts/Negative Space Discipline]] | What not to build is as important as what to build |
| [[concepts/Core Operating Ethos]] | Six operating pillars — the "why" behind every disciplined decision |
| [[concepts/Review Before Push]] | Mandatory reviewer verdict before any diff reaches the shared branch |
| [[concepts/Orchestration Lanes]] | Standing team vs fan-out subagents vs solo-inline — pick one, declare it |

Add your operator-specific doctrine notes below as you create them.

---

## When Things Change

This MAP is canonical. When the system changes — new agent added, project retired, channel created, rule updated — update this file in the same change. The MAP rotting is worse than the MAP missing.

**Owner:** the routing agent, with Hestia flagging stale entries on periodic sweeps.

---

## Cross-refs

- [[agents/Pantheon]] — full instrument roster + extensibility checklist
- [[12_authority_matrix]] — full authority levels and decision tree
- [[concepts/Engineering Judgment Doctrine]]
- [[concepts/Lego Arsenal Doctrine]]
- [[concepts/Core Operating Ethos]]
- [[concepts/Review Before Push]]
- [[concepts/Orchestration Lanes]]
