---
title: MOM Memory
tags:
  - concept
  - skip-rationale
  - agent-memory
  - external-tool
aliases:
  - MOM agent memory
  - mom HQ
created: 2026-05-01
source: https://github.com/momhq/mom
---

# MOM Memory

> [!info] Verdict: skip the tool, bookmark one pattern.

Go CLI for harness-agnostic AI agent memory. Per-project `.mom/` directory, JSON schemas for structured memory, auto-generated boot files (CLAUDE.md / AGENTS.md). A watcher process ingests session transcripts automatically and writes structured memory from them.

## Why we skip it

MOM's model is per-project JSON schemas with auto-generated boot files. The AIgent runs a cross-project markdown vault with 200+ notes and deep wikilink graphs. Migrating would mean rewriting every note into JSON schema, losing the backlink graph, and running a separate Go process alongside Claude Code. The migration cost exceeds the benefit at this scale, and the vault graph is a feature MOM doesn't replicate.

## Pattern bookmarked — session-transcript watcher

MOM watches session transcripts and auto-ingests them as structured memory. The AIgent's equivalent is manual — `/close` end-of-session capture requires intentional action. An auto-watcher on JSONL transcripts would reduce the friction of `/close` and catch things that don't make it to the session-end step.

This is additive but not urgent. The `/close` discipline is the right forcing function for now. If the system starts missing important context consistently, the watcher pattern is worth revisiting.

> [!abstract] If this becomes urgent
> Look at MOM's watcher implementation as the reference. The output format would need translation from MOM's JSON schema to Obsidian OFM. A lightweight Node watcher on `~/.claude/projects/` JSONL files writing daily notes automatically is the natural shape.

## Related

- [[LLM Wiki Pattern]] — the broader three-layer pattern
- [[Self-Improving CLAUDE.md.md]] — how the system currently captures learnings
- [[Lego Arsenal Doctrine]] — external tool evaluation doctrine
