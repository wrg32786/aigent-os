---
title: The Self-Management Layer
tags:
  - doctrine
  - meta
  - architecture
  - self-improvement
aliases:
  - Self-Management
  - The Maintenance Layer
  - Framework Maintains Itself
created: 2026-04-26
---

# The Self-Management Layer

> The set of patterns inside aigent-OS that exist for one purpose: keeping the framework coherent without the principal having to manually maintain it. They share a design pattern. This note names the layer and lists its members.

## The question they all answer

Every member of the self-management layer answers the same operational question:

> *How does this framework stay useful, accurate, and lean as it grows — without the principal spending hours per week maintaining it?*

Static frameworks don't answer this. They drift, calcify, or sprawl. The principal eventually stops trusting the framework or stops adding to it; either way, the compound effect dies.

The self-management layer's answer: **build maintenance into the framework itself.** Each member automates a specific maintenance task — surfacing forgotten skills, decaying stale memory, capturing learning from mistakes, evaluating decision outcomes, sanitizing private content from public releases. The principal stays in the loop at authority gates, but the maintenance cycle runs continuously.

## The members

### Caddy
**Maintains:** the principal's awareness of their own toolbox.
**Mechanism:** non-blocking advisory hook that surfaces matching skills on every user prompt.
**Failure mode prevented:** skills written, then forgotten; toolbox accumulates without compounding.
**See:** [[Caddy]], [[Suggestion Credibility]]

### Self-Improving CLAUDE.md
**Maintains:** the framework's accumulated lessons.
**Mechanism:** four-step loop (reflect → abstract → generalize → write) that converts every correction into a permanent rule at the right layer.
**Failure mode prevented:** same mistakes repeating across sessions; principal correcting at the conversation layer instead of the framework layer.
**See:** [[Self-Improving CLAUDE.md]]

### Memory Decay Doctrine
**Maintains:** the relevance of vault content surfaced at session start.
**Mechanism:** exponential heat decay weighted by reads, backlinks, and edits. Cold notes drop off; hot notes surface at `/open`.
**Failure mode prevented:** vault grows linearly; signal-to-noise ratio degrades; AI loads stale context.
**See:** [[Memory Decay Doctrine]]

### Publish skill (planned)
**Maintains:** the public aigent-OS repo's coherence with the principal's local install.
**Mechanism:** sanitization protocol with per-file privacy classification, secret scanning, generalization test, RELEASE_LOG entries.
**Failure mode prevented:** public repo drifts from local; private references leak into public; releases happen without institutional memory of what shipped and what was held back.
**See:** [`README.md`](../../README.md) section "🔁 How this repo maintains itself"

### `/diagnose`
**Maintains:** the principal's ability to debug the framework when something feels off.
**Mechanism:** structured walk through the seven-layer stack ([[The Seven Layers]]) to identify which layer is responsible for a symptom.
**Failure mode prevented:** broken installs go un-diagnosed; users file uninformed issues or give up; small failures escalate to "the framework doesn't work."
**See:** [`/diagnose`](../../skills/diagnose/SKILL.md)

### `/system-check`
**Maintains:** install integrity over time.
**Mechanism:** layer-by-layer audit of kernel, skills, hooks, daemons, vault, and principal config. Reports green/yellow/red.
**Failure mode prevented:** silently broken installs; orphan skill folders; stale embeddings; broken wikilinks rotting for months.
**See:** [`/system-check`](../../skills/system-check/SKILL.md)

### `/skill-audit`
**Maintains:** the skill catalog's usefulness as it grows.
**Mechanism:** identifies dead skills (low usage, no recent invocations) for retirement, detects Caddy trigger mismatches, surfaces capability gaps from repeated manual workflows.
**Failure mode prevented:** the toolbox accumulates faster than it's pruned; Caddy starts surfacing dead options; the principal forgets which skills they have.
**See:** [`/skill-audit`](../../skills/skill-audit/SKILL.md)

### Decision aging (DECISION_OUTCOMES)
**Maintains:** the principal's longitudinal track of which decisions held up.
**Mechanism:** `/open` checks DECISION_LOG entries that are 30/60/90 days old without an outcome captured; surfaces them as one-line prompts.
**Failure mode prevented:** decisions tracked at the moment-of-decision but never closed-the-loop on outcomes; the principal accumulates decisions without learning which ones worked.
**See:** `vault/memory/DECISION_OUTCOMES.md`

## What unites them

All seven members share four properties:

### 1. They run continuously, not on-demand
The principal doesn't have to remember to use them. Caddy fires on every prompt; memory decay runs nightly; `/open` checks decision aging; `/diagnose` is available the moment the principal asks "what's broken?". The maintenance happens whether the principal thinks about it or not.

### 2. They're advisory, not enforcing
None of them block the principal's flow. Caddy suggests; doesn't compel. `/diagnose` reports; doesn't fix. Decision aging asks; doesn't decide. They follow the [[Suggestion Credibility]] doctrine: depleting trust is the failure mode they all guard against.

### 3. They produce legible artifacts
Every output of every member is markdown — the principal can read it, edit it, search it, version-control it. The maintenance layer doesn't add opacity to the framework; it adds *legibility* to the maintenance process itself.

### 4. They keep the principal in the loop at authority gates
None of them autonomously make decisions that change framework state. Caddy proposes; the principal invokes. `/skill-audit` flags candidates for retirement; the principal removes. Decision aging prompts; the principal answers. The principal-as-maintainer ([[The Two Roles]]) stays in command of every meaningful change.

## What this layer is NOT

- **Not the kernel.** The kernel is the constitutional framework. Self-management is what keeps the constitutional framework from rotting.
- **Not skills the principal invokes.** Self-management members run on schedules or events, not on principal request. (Some are also invocable, but their primary value is automatic.)
- **Not infrastructure-as-code.** The self-management layer is markdown + small shell scripts + flat JSON. Legibility thesis applies.

## The bet

A framework with a strong self-management layer compounds. A framework without one decays.

If the bet is right, aigent-OS is what AI productivity infrastructure looks like in five years — not because of any specific tool, but because the maintenance pattern stops being a manual chore and becomes a continuous background process the principal can read at any time.

If the bet is wrong, the principal still has a folder of markdown files they can navigate. That's the legibility insurance underneath the bet.

## Connects to

- [[Legibility Thesis]] — the meta-doctrine the self-management layer protects
- [[The Two Roles]] — the principal-as-maintainer is who deploys this layer
- [[Caddy]], [[Suggestion Credibility]], [[Self-Improving CLAUDE.md]], [[Memory Decay Doctrine]] — current members
- [[Bio-hacking Posture]] — the broader frame in which self-management is the "stack tracking + sleep optimization" piece
- [[The Seven Layers]] — self-management members live across layers 2, 3, 4, and 6
