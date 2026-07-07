---
title: GenericAgent
tags:
  - concept
  - reference
  - agent-framework
  - self-evolving
  - bookmark
aliases:
  - generic-agent
  - self-crystallizing agent
created: 2026-05-02
source: https://github.com/lsdefine/GenericAgent
---

# GenericAgent

> [!abstract] TLDR
> - Minimal self-evolving autonomous agent framework. ~3K lines, 9 atomic tools, ~100-line agent loop.
> - Differentiator: every completed task auto-crystallizes into a reusable skill. First-time exploration → save execution path → one-line invoke next time.
> - **BOOKMARK.** Interesting prior art for a "crystallize recurring tasks into skills" feature. Don't adopt now — the AIgent already covers this ground with /open + /close + caddy + skills.

## What it is

~3K lines total. 9 atomic tools. Agent loop is ~100 lines. Multi-LLM: Claude, Gemini, Kimi, MiniMax. Token-efficient — stays under 30K context.

The differentiator is self-evolution: each task run is observed, and if successful the execution path is distilled into a named skill the agent can invoke on future similar tasks. No human prompt engineering required to accumulate capabilities — the agent builds its own toolbox.

## Why it's interesting

This is the same pattern that was stripped out of gstack during the port — gstack had a "learnings" system that the AIgent didn't adopt. GenericAgent is the purest public expression of that idea.

The "first-time exploration → save path → one-line invoke" loop is real value if there are clearly recurring multi-step tasks worth automating. Conceptually close to what Caddy does (surface the right skill), but GenericAgent auto-generates the skill rather than routing to an existing one.

## Verdict: BOOKMARK + 2 patterns ripped

The AIgent already covers the same ground for most of GenericAgent's surface:
- /open + /close = session-level crystallization into vault notes
- Caddy = skill routing
- Skills directory = the accumulated toolbox
- memory-architect role = compaction and supersede

Don't adopt the platform wholesale. Two specific patterns ARE lifted into the AIgent — see below.

## When to revisit

If the principal says "we keep doing X manually every session, can the AIgent learn to do it automatically" — that's the trigger. Pull this note, read the GenericAgent skill-crystallization loop, design a aigent-OS-native version.

## Patterns ripped into the AIgent

### 1. Auto-skill crystallization

GenericAgent's core mechanism: first time you ask it to do X, it figures out the recipe; that recipe gets saved as a skill; second time = one-line invoke. Banked as the AIgent future feature at [[Auto-skill from recurring task]]. Sequenced after [[MOM Memory]] session-transcript watcher prereq.

### 2. L4 session archive memory layer

GenericAgent's 2026-04-11 release introduced "L4 session archive memory" — a layered memory model where old sessions get compacted into a queryable archive rather than deleted. Complements the AIgent's existing [[HEAT_INDEX]] (per-file heat) and [[Memory Decay Doctrine]] (60-day exponential decay).

Adoption shape: `memory/SESSION_ARCHIVE/` directory for `daily/` notes older than 90 days. The memory architect agent compacts them into archive entries; [[remindb]] still indexes them for FTS5 search. The vault graph becomes lighter without losing recall.

Banked as the next logical extension of [[Memory Decay Doctrine]] — captured in that note's future layers thinking.

## Links

- Related patterns: [[Lego Arsenal Doctrine]], [[Gstack Port]], [[Pantheon]]
- Patterns ripped: [[Auto-skill from recurring task]], [[Memory Decay Doctrine]]
- Cross-reference: [[Hermes Agent]] (same self-evolving territory, more mature ecosystem)
