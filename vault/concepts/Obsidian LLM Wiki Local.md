---
title: Obsidian LLM Wiki Local
tags:
  - concept
  - reference
  - karpathy-impl
  - fallback
aliases:
  - obsidian-llm-wiki
  - olw
  - LLM Wiki Local
created: 2026-05-01
source: https://github.com/kytmanov/obsidian-llm-wiki-local
---

# Obsidian LLM Wiki Local

> [!abstract] What it is
> Python, pip-installable (`pip install obsidian-llm-wiki`). Third Karpathy LLM Wiki implementation evaluated. Writes compiled wiki articles natively to a `wiki/` directory inside the Obsidian vault.

## What it does

Karpathy-faithful implementation with additions:

- **Rejection feedback loop** — reject a compiled draft with a reason, and the next compile addresses the feedback. Not just "skip this article," but "here's what's wrong with it."
- **Hand-edit preservation** — compiler detects manually edited articles and skips them on next compile. Human curation survives automation.
- **Alias repair** — updates wikilinks when notes are renamed.
- **`olw lint`** — health-check for orphans and stale articles.
- **Multi-language auto-detect** — handles non-English vault content.
- **Git-aware** — auto-commits compiled articles with `[olw]` prefix so you can see what the LLM touched vs. what you touched.

## Honest assessment

Of the 3 Karpathy impls evaluated (SwarmVault, OmegaWiki, this one), this is the most directly Obsidian-relevant because it writes natively to vault dirs. But the overlap with SwarmVault is high — both compile wiki articles from raw sources into the vault.

The **rejection feedback loop** is unique and interesting. SwarmVault has approval queues; this has rejection feedback that informs the *next* compile. Different mental model — closer to how a vault curator already works. If this ever becomes the pick, that's the feature worth keeping.

The `olw lint` command overlaps with a `/lint` skill. Not a blocker, just redundancy to be aware of.

## Status

**FALLBACK to SwarmVault.**

Only spike-test if SwarmVault is rejected. Don't run two parallel Karpathy-impl spikes — pick one champion at a time. If SwarmVault passes, this note is a bookmark, not an action item.

## Related

- [[LLM Wiki Pattern]] — doctrinal anchor; all three impls trace back here
- [[SwarmVault]] — current primary spike candidate; evaluate this only if SwarmVault rejects
- [[OmegaWiki]] — second impl evaluated same session; mostly skip, two patterns bookmarked
- [[Memory Decay Doctrine]] — heat weighting layer; olw lint would overlap with vault sweep cadence
