---
title: What I Am Not Building
tags:
  - doctrine
  - restriction
  - negative-space
aliases:
  - Not Building List
  - The Rejection List
  - Rejected Paths
created: 2026-04-26
---

# What I Am Not Building

> The bio-hacker's no-fly list, applied to a framework. Each entry: the considered path, why rejected, what would make the principal reconsider.

Most personal-OS projects accumulate features. They never document what they *didn't* build. The result: someone six months later argues for adding feature X, the maintainer half-remembers rejecting X for a reason they can't articulate, and the rejection either gets reversed (cluttering the framework) or repeated (without the learning). Either way, the discriminating intelligence is lost.

This note prevents that. Every rejected path lives here with reasoning and reconsideration triggers.

## Format

Each entry is a section with this shape:

```
### {Considered path}

**What it would do:** {one sentence}

**Why rejected:** {1-3 bullets — the actual reason, not "not the right time"}

**Reconsider when:** {specific triggers that would flip the decision}

**Last reviewed:** {date}
```

The "reconsider when" line is the load-bearing piece. Without it, the entry is dead. With it, the entry is a future trigger waiting to fire.

## Categories of rejection

Different kinds of "no" call for different evaluation:

- **Wrong-bottleneck** — the path solves a problem that isn't the principal's bottleneck. Reconsider when the bottleneck shifts.
- **Wrong-category** — the path is in a category the principal doesn't operate in (e.g., training models). Reconsider when category fit changes.
- **Premature** — the path is the right answer eventually, just not now. Reconsider when threshold conditions are met.
- **Fundamental** — the path violates a load-bearing constraint (e.g., the legibility thesis). These rarely flip; reconsideration would mean reframing the whole project.

## Initial entries

The principal of the canonical install populates this with their own rejections. Each install will have different entries because each principal is solving for different bottlenecks. Below is the structure with example entries — replace with your own.

### Voice agent integration

**What it would do:** Add voice as a primary I/O channel — speech-to-text in, text-to-speech out, real-time turn-taking.

**Why rejected:**
- Voice latency adds friction; markdown is already the bottleneck-fast surface
- Voice transcription is lossy compared to typed input
- The legibility thesis demands a readable artifact; transcribed voice is messy

**Reconsider when:** Most of the principal's input becomes ambient (driving, walking, hands busy) rather than at-keyboard, AND voice transcription quality matches typed input quality on technical content.

**Last reviewed:** 2026-04-26

### Microvm sandboxing for sub-agents

**What it would do:** Run sub-agents in isolated microvms (Firecracker, gVisor, smolVM) so destructive code can't touch the host.

**Why rejected:**
- Current Authority Level 1 sub-agents don't write destructive code
- The authority matrix already enforces what sub-agents can do
- Adds operational complexity that the current scale doesn't need

**Reconsider when:** Authority Level 1 sub-agents start writing destructive code at scale (e.g., spawning processes, mutating production systems), AND the authority matrix can no longer enforce safe boundaries before invocation.

**Last reviewed:** 2026-04-26

### Custom GPU kernels / training infrastructure

**What it would do:** Spin up training-grade GPU compute for fine-tuning open models or running custom inference.

**Why rejected:**
- Wrong category of work — the AIgent is principal-tooling, not model R&D
- Costs (capital, attention, ongoing maintenance) are an order of magnitude past the principal's actual needs
- Off-the-shelf models clear the bar for everything the framework currently does

**Reconsider when:** A specific principal-tooling task literally cannot be done with off-the-shelf models due to either privacy constraints (data can't leave premises) or capability gaps that won't close in 6+ months.

**Last reviewed:** 2026-04-26

### Vector database as primary memory

**What it would do:** Replace the markdown-vault memory layer with a vector database (e.g., Pinecone, Weaviate) for semantic retrieval at scale.

**Why rejected:**
- Violates the [[Legibility Thesis]] — primary memory must be human-readable
- Embeddings are derived data; the canonical source must be markdown
- The principal cannot inspect or edit a vector database the way they can inspect markdown

**Reconsider when:** Never (this is a fundamental rejection — would require reframing the project's core thesis).

**Last reviewed:** 2026-04-26

## Why this list compounds

The list does three things over time:

1. **Prevents re-litigation.** When a new tool, library, or pattern shows up that fits a rejected category, the principal doesn't have to re-derive why it was rejected — the reasoning is recorded.

2. **Surfaces real triggers.** When one of the "reconsider when" conditions actually fires, the principal can re-evaluate from a position of remembered context.

3. **Makes editorial discipline visible.** A framework's quality is partly the sum of what it built and partly the sum of what it refused to build. Most projects only show the first half. This shows both.

## How to use

- Add an entry every time a real "no" decision happens (not every tool you skim)
- Re-review entries quarterly during `/retro`
- When a "reconsider when" trigger fires, write a follow-up note explaining the new context and the resulting decision (adopt / re-reject)
- The list grows. Don't worry about pruning — old entries are still useful as historical context

## Connects to

- [[Bio-hacking Posture]] — this list is the "restriction" category made explicit
- [[Negative Space Discipline]] — sister doctrine at the agent-behavior level
- [[The Two Roles]] — adding to this list is the maintainer role, not the user role
- [[Modern AI Infrastructure Stack]] — context for which categories the principal operates in
