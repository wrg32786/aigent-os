---
title: OmegaWiki
tags:
  - concept
  - skip-rationale
  - knowledge-base
  - external-tool
aliases:
  - OmegaWiki skip
created: 2026-05-01
source: https://github.com/skyllwt/OmegaWiki
---

# OmegaWiki

> [!info] Verdict: mostly skip. Two patterns bookmarked.

PKU DAIR Lab built OmegaWiki as a research platform — papers, experiments, peer review workflows, multi-agent knowledge construction pipelines. The architecture assumes you're producing citable academic output and iterating through formal review cycles.

The overhead of that model (structured research workflows, peer-review queues, citation management) adds friction without payoff for a founder-operated vault.

## What we skip

The full OmegaWiki stack. Multi-agent pipeline, peer-review workflow, citation infrastructure — all of it. Not the right shape for how the AIgent operates.

## Pattern 1 — Failed experiments as first-class anti-repetition memory

OmegaWiki tracks failed experiments explicitly as a distinct entity type. The reasoning: if you only record what worked, you repeat expensive mistakes because the "don't try this" signal lives nowhere durable. This pattern is the right call. It's additive to TRUST_DECAY but distinct — TRUST_DECAY tracks confident claims awaiting verification; failed experiments are closed loops where we already know the outcome.

Implement as a FAILED_EXPERIMENTS ledger in `vault/memory/`.

## Pattern 2 — 9 typed entities with relationships

OmegaWiki uses 9 typed entity classes and tracks relationships between them explicitly. The AIgent independently converged on the same pattern: `people / projects / agents / concepts / feedback / memory / reference / analytics / health` = typed directories. The convergence is a signal that typed-entity organization is the right shape for a personal knowledge graph at this scale. No action needed — the pattern is already in place.

## Related

- [[LLM Wiki Pattern]] — the broader pattern context
- [[Lego Arsenal Doctrine]] — external tool evaluation doctrine
- [[SwarmVault]] — similar evaluation same session
