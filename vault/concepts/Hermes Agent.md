---
title: Hermes Agent
tags:
  - concept
  - reference
  - agent-framework
  - procedural-memory
  - bookmark
aliases:
  - hermes-agent
  - NousResearch hermes
created: 2026-05-01
source: https://github.com/NousResearch/hermes-agent
---

# Hermes Agent

> [!abstract] TLDR
> - NousResearch's "agent that grows with you." 129K stars. Built by the Hermes-3 LLM team.
> - Same self-evolving territory as [[GenericAgent]] but more mature ecosystem: 40+ tools, messaging gateway (Telegram/Discord/Slack/WhatsApp/Signal/Home Assistant), container isolation, MCP integration, cron scheduling, Skills Hub for community skill sharing.
> - **BOOKMARK + 2 patterns ripped + 1 deferred.** Wholesale adoption = sideways migration, not upgrade. The AIgent already covers most of the feature surface.

## What it is

Open-source agent framework from the team that built the Hermes-3 LLMs. Designed to be self-improving: agents gain new capabilities through a Skills system that functions as procedural memory. Ships with a Skills Hub for community-shared skill discovery. Supports multi-modal messaging across every major platform and has a container-sandboxed execution model for risky commands.

Native Linux/Mac/WSL2/Android (Termux). Not native Windows — extra friction on Windows setups.

## Why mostly skip it

- Native Windows NOT supported — friction on Windows environments
- 40+ tools, MCP, cron, persistent memory, user profiles are already covered by the AIgent + claude code + Pantheon + remindb
- Messaging gateway covers a use case (text the AIgent from phone) that doesn't currently exist in most the AIgent deployments
- Adopting hermes wholesale would be a sideways migration, not an upgrade

## Patterns ripped into the AIgent

### 1. Skills as procedural memory (framing adoption)

Hermes explicitly classifies skills as "procedural memory" alongside declarative memory (facts, vault notes). The AIgent has both but hadn't named the distinction. Adopting the framing sharpens the Pantheon mental model:

- **Procedural memory (knowing HOW):** `~/.claude/skills/` — `/lint`, `/office-hours`, `/investigate`, `/comms`, `/open`, `/close`, etc. Recipes for executing recurring tasks.
- **Declarative memory (knowing THAT):** the Obsidian vault — `concepts/`, `feedback/`, `agents/`, `people/`, `projects/`, `memory/`. Facts, doctrines, relationships.
- **Both layers feed each other:** procedural skills read declarative vault content (via [[remindb]] MCP) to make decisions; declarative notes capture lessons that become future procedural skills (via [[Auto-skill from recurring task]]).

This framing is now the AIgent doctrine. When the [[agents/Pantheon]] note gets an intro section, it belongs there.

### 2. Container isolation as escalation path for /careful

Hermes uses sandboxed container execution for risky commands. The AIgent's [[Gstack Port]] gave us `/careful` (warns on destructive bash), `/freeze` (restricts edit dir), `/guard` (combined). If `/careful` warnings prove insufficient — e.g., agent gets compromised and starts running destructive ops — the upgrade path is container isolation in the hermes mold. Bookmark, not active.

## Patterns deferred (defer until trigger)

### Messaging gateway (Telegram / Discord / Slack / WhatsApp / Signal / Home Assistant)

If you ever want "text the AIgent from my phone" or "ask the AIgent in Discord," hermes is the cleanest off-the-shelf path. Different use case from claude-code-in-vault. No current need.

### Skills Hub (community-shared skill discovery)

Hermes ships a skills hub for community-shared skills. The aigent-OS repo has the Pantheon agents but no formal skills-hub discovery layer. When aigent-OS matures and accumulates more public skills, mirror this pattern: a discoverable index in the public repo README. See [[Lego Arsenal Doctrine]] for the framing.

## Cross-references

- [[GenericAgent]] — same self-evolving territory, simpler/lighter
- [[Auto-skill from recurring task]] — where the procedural-memory framing lands mechanically
- [[agents/Pantheon]] — agent definitions that bridge procedural + declarative layers
- [[Gstack Port]] — `/careful`, `/freeze`, `/guard` are the AIgent's current safety layer (pre-container)
- [[Lego Arsenal Doctrine]] — Skills Hub = future public-arsenal discovery mechanism
- [[remindb]] — MCP layer that lets procedural skills query declarative vault
- [[Context Mode]] — sandbox execution (weaker than container isolation but already live)
