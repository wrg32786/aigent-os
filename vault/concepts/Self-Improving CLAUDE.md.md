---
title: Self-Improving CLAUDE.md
tags:
  - concept
  - meta
  - learning
  - framework
aliases:
  - Meta Rules
  - Reflection Loop
created: 2026-04-13
---

# Self-Improving CLAUDE.md

> [!abstract] The `CLAUDE.md` is not static documentation. It is a living system that learns from every mistake and gets smarter each session. Two components make this work: **meta-rules** that teach the AI how to write good rules, and a **one-sentence prompt** that turns corrections into permanent learning.

## The Problem with Static CLAUDE.md

Most `CLAUDE.md` files are write-once documentation. They list rules but never grow. The AI reads them at session start, then makes the same mistakes the next session because nothing was captured.

This wastes the largest unused resource in any Claude Code session: the AI's ability to analyze its own mistakes in real time while full context is still in working memory.

## The Two Ideas

### 1. Meta-Rules (how to write rules)

A META section in [[CLAUDE.md]] that teaches the AI how to add new rules. Without this, every addition to CLAUDE.md degrades the document — verbose, inconsistent, bloated. With this, every addition self-regulates.

Key meta-rules:
- Absolute directives (NEVER / ALWAYS)
- Lead with why (1-3 bullets)
- Concrete commands, not abstract principles
- Anti-bloat guards

See the META section in the root `CLAUDE.md` for the full set.

### 2. The Magic Prompt

> "Reflect on this mistake. Abstract and generalize the learning. Write it to CLAUDE.md."

One sentence. Four instructions:
- **Reflect** — analyze the failure while context is still hot
- **Abstract** — extract the general pattern (not the specific case)
- **Generalize** — produce a decision framework for similar future situations
- **Write** — commit the rule following META format

The user provides the critical thinking ("this is worth capturing"). The AI provides the execution (analyzing, abstracting, writing). Five seconds of human time, permanent improvement.

## Why This Compounds

| Session | What happens |
|---------|--------------|
| 1 | AI makes 3 basic mistakes. User triggers reflection. 3 rules added. |
| 2 | AI reads rules at start. Those 3 mistakes don't happen. 3 new, more sophisticated mistakes. |
| 3 | The basic mistakes have vanished. Conversation is about architecture, not imports. |

The mistakes **evolve upward**. That's the signature of a learning system.

## Integration with [[aigent-OS]]

This framework extends beyond a single `CLAUDE.md` into the full vault-based memory system:

| Rule type | Where it goes |
|-----------|---------------|
| Operational (wrong tool, bad routing) | Root `CLAUDE.md` under relevant section |
| Domain knowledge (project facts, architecture) | `vault/concepts/<Topic>.md` with wikilinks |
| Behavioral (always/never patterns) | `system/02_operating_standards.md` |
| Session-specific decisions | `vault/memory/DECISION_LOG.md` |

The vault graph is what makes this scale past a single project. Each rule becomes a node with backlinks, not just a line in one document.

## The Deeper Pattern

> [!info] **Human cognition is scarce. AI execution is abundant.**
>
> Your time and attention are limited. The AI's analysis capacity is not. Traditional documentation is expensive because it consumes the scarce resource. This framework flips it: the human spots the pattern (5 seconds), the AI does the analysis, abstraction, and documentation (AI time, which is abundant during sessions anyway).

## When NOT to Trigger Reflection

- Trivial corrections with no general pattern ("the file is at X path, not Y")
- Things already captured in existing rules (update the existing rule instead)
- Taste-based preferences that don't generalize
- One-off decisions that don't warrant permanent enforcement

If it's not worth a rule, don't create one. Bloat kills self-improving systems.

## Credit

Pattern adapted from [aviadr1/claude-meta](https://github.com/aviadr1/claude-meta). The core insight — meta-rules + reflection prompt — is his. The vault integration, agent-hierarchy extension, and Obsidian-flavored structure are the [[aigent-OS]] adaptation.

## Links
- [[Session Protocol]] — how /open and /close work
- [[Memory Operating Layer]] — the vault-based memory system
- `CLAUDE.md` (root) — where the META section lives
- `system/02_operating_standards.md` — behavioral rule destination
