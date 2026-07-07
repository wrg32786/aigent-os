---
title: Legibility Thesis
tags:
  - doctrine
  - meta
  - constitutional
aliases:
  - The Legibility Thesis
  - Why everything is markdown
created: 2026-04-26
---

# Legibility Thesis

> AI works for the principal, so its memory belongs to the principal — in a format the principal can read.

This is the design constraint behind every choice in the AIgent. Reading this note is reading the *why* underneath every other note.

## The constraint

Every piece of the system must be inspectable by both human and machine. The system must be able to operate on itself, transparently, in a format the principal can audit.

That's it. One sentence. The rest of this note unpacks why it's load-bearing.

## What it rules out

- **Vector databases as the primary memory layer.** Embeddings are fast but opaque. The principal cannot read them. The day the embedding model changes is the day the principal's memory shifts beneath them without notification.
- **Cloud-hosted "context" services.** If the principal cannot run their AI offline, against their own files, on their own machine, then they don't actually own the operating layer.
- **Magical recall.** "The AI just knows" is a failure mode. If it knows, the principal must be able to find where it knows it.
- **Compression that loses provenance.** Summaries are fine. Summaries that drop the source link are not — the principal must always be able to trace back.
- **Opaque agent loops.** A chain-of-thought the principal cannot read after the fact is a chain the principal can't audit.

## What it forces in

- **Markdown as the primary memory format.** Every priority, every decision, every doctrine note, every skill — markdown files in folders the principal owns.
- **Wikilinks as the connection layer.** A graph of linked documents. The graph IS the intelligence. The principal can navigate it visually in Obsidian or programmatically with `grep`.
- **Explicit authority matrix.** What the AI can do alone, what it must ask, what it can never touch — written down, in markdown, where the principal can edit it.
- **Hooks and daemons that the principal can read.** Shell scripts and small programs, not opaque binaries. If a hook fires, the principal can grep the script to understand why.
- **Publishing protocols that announce themselves.** When the principal's local the AIgent learns something new and graduates it to a public release, the protocol records what shipped, what was held back, what the sanitizer caught — in markdown, in the repo, where everyone can read it.

## Three claims that follow

### Claim 1 — Memory belongs to the principal, in their format

If your AI's memory lives in a vendor's vector database, the vendor controls your continuity. If it lives in a folder of markdown files on your disk, you do.

This sounds obvious. In practice almost no AI tool ships this. Agent frameworks store memory in opaque embeddings. Chat tools store it in cloud accounts you don't fully control. "Context" tools index everything but expose nothing. The AIgent inverts the default: **the memory layer is the most legible layer, not the most magical one.**

The vault is your AI's brain. You should be able to walk into Obsidian and read every thought your AI has ever had about your work. Not because you'll do it often — you won't. Because you *can*. That's what ownership looks like.

### Claim 2 — The system operates on itself, and you can read how

A static framework drifts. The principal carries it forward by hand, makes a hundred small decisions a year about what to keep and what to throw away, and eventually the framework either calcifies (no changes) or sprawls (every change kept). Both are failure modes.

A framework that **operates on itself** doesn't have this problem. When the principal learns a new rule, captures a new doctrine note, codifies a new workflow into a skill — the framework itself decides what graduates from local to public, sanitizes private references, runs a secret scanner, drafts the commit message, opens the pull request. The release log writes itself.

The principal stays in the loop at authority gates — but the maintenance cycle is itself an artifact of the system. And because every piece of that cycle is markdown, the principal can read exactly what happened, when, and why.

This is the deepest expression of the thesis: not only is your memory in a format you can read, the system's *evolution* is also in a format you can read.

### Claim 3 — Skill compounding > prompt cleverness

Most AI productivity advice optimizes the wrong layer. People spend hours hand-crafting the perfect prompt. The AIgent spends those hours building skills that surface the right context automatically.

You don't get good at prompts. You get good at building a system that gets better while you sleep.

The Caddy pattern is the canonical example: every skill registers itself with a small index of trigger patterns. A non-blocking hook runs on every prompt and surfaces the matching skill — like a golf caddy handing you the right club. You stop forgetting your own toolbox. You stop falling back to grep when you've written a code-navigation skill. The system gets smarter the more skills you add, and the user effort stays flat.

Compounding > cleverness. Always.

## The acid test

Whenever you consider a change to the AIgent — a new skill, a new doctrine, a refactor, a feature — ask:

> Does this make the system *more readable*, by humans and by the next generation of agent? Or does it add a layer of magic that someone else will have to dig past?

If it adds magic, it loses. Even if it would be more useful in the short term.

This is the editorial discipline that prevents framework rot. See [[The Two Roles]] for why the discipline is hard to hold and why it matters.

## Connects to

- [[The Two Roles]] — the principal's split role (user vs maintainer) that holds the legibility line
- [[Skills Graduation Curve]] — how the toolbox compounds without becoming illegible
- [[Three Rules]] — agent discipline that operates within the legibility frame
- [`docs/manifesto.md`](../../docs/manifesto.md) — the public-facing version of this thesis
- [`README.md`](../../README.md) — the AIgent framed for adoption rather than first principles
