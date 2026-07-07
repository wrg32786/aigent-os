---
title: SwarmVault
aliases: [SwarmVault Spike, swarmvaultai]
tags: [reference, knowledge-platform, evaluation, spike-result]
created: 2026-05-01
status: evaluated
verdict: REJECT
---

# SwarmVault

> [!abstract] Verdict: REJECT
> Duplicates the AIgent's existing stack with weaker execution. No real new signal — contradiction detection doesn't work, candidate queue produced nothing, graph is a source manifest not a topology. The one interesting capability (MCP server) is useful in principle but not worth the overhead.

**Spike date:** 2026-05-01
**Version tested:** 3.2.0 (NPM `@swarmvaultai/cli`)
**Corpus:** 160 vault notes (concepts + feedback + agents)

---

## What Ran Successfully

- Install: clean, 367 packages, ~38s
- `swarmvault scan ./raw` — initialized workspace, ingested all 160 notes, compiled 160 sources into 1313 pages
- `swarmvault compile` — ran without errors
- `swarmvault lint --conflicts` — returned "No findings"
- `swarmvault query "what are the main contradictions in the vault?"` — returned output (see below)

## What Failed or Didn't Work

- `swarmvault graph open` — not tested (no browser env in this context; the `--no-serve` flag was used for scan)
- `wiki/candidates/` — **empty**. Zero new concept candidates surfaced across 160 notes
- Contradiction detection — **"No findings"** on `lint --conflicts`. This is a false negative. The vault has known tensions (e.g., `memory/DELEGATION_TRACKER` vs OpenChronicle supersede semantics, `Karpathy LLM Wiki` vs `LLM Wiki Pattern` are near-duplicates). SwarmVault found none of them.
- Query output — dumped raw source text instead of synthesized answers. "What are the main contradictions?" returned three source passages verbatim with no analysis. It's a keyword search with a nice wrapper, not semantic reasoning.

---

## Decision Matrix

| Capability | The AIgent today | SwarmVault | Verdict |
|---|---|---|---|
| Knowledge graph viz | Obsidian native + [[graphify]] | Source-list manifest, no edge topology, SVG share card | **Worse** — Obsidian's graph shows actual link structure; SwarmVault's "graph" is a flat list of source IDs grouped into communities |
| Contradiction detection | None | Returns "No findings" on a vault with known near-duplicates | **No value** — broken or heuristic-only without provider API keys |
| Candidate-concept queue | None (manual) | Empty after 160 notes | **No value** — produced nothing |
| Query / search | semantic-search skill | Raw source dump, no synthesis | **Worse** — semantic-search uses embeddings; SwarmVault query without a provider key is keyword retrieval |
| Code-aware (tree-sitter) | Partial via graphify | `wiki/code/` dir present but empty | **Not demonstrated** |
| Provenance edge tagging | No | Page IDs + source_ids in YAML | **Additive in principle**, but no edge graph means provenance is just a list |
| MCP server | No | `swarmvault mcp` available | **Potentially useful**, but gated behind provider keys for real value |

---

## Root Cause: Offline Mode Gutted

SwarmVault's "heuristic provider" (offline mode) skips the LLM calls that power contradiction detection, candidate surfacing, and query synthesis. All three marquee features require a live provider (OpenAI, Anthropic, Ollama). Without keys, you get:

- A well-structured file index (1313 pages of YAML + stub markdown)
- A `wiki/concepts/` directory of single-word token stubs (`agent.md`, `always.md`, `affiliate.md`) — not concept pages
- A `share-card.svg` with graph stats
- Keyword search dressed up as a query interface

This is not a bug — the README markets it as "offline-capable" but the value is in the provider-backed features.

---

## What SwarmVault Got Right (Architecturally)

1. **Page ID system** — content-addressed IDs per source (`model-routing-discipline-96fd652b`) are cleaner than Obsidian's filename-based wikilinks for programmatic access
2. **Tiered memory model** — working / episodic / semantic / procedural tiers maps well to [[OpenChronicle]] supersede semantics. The AIgent already has this pattern
3. **MCP server** — `swarmvault mcp` exposes the vault to any MCP-compatible agent. Worth revisiting if the AIgent ever needs vault queries from non-Claude tooling

---

## Verdict: REJECT

Three reasons:

1. **Contradiction detection is broken offline.** The only feature the AIgent doesn't have requires provider keys to work, and even then it's unproven against a well-structured vault.
2. **Candidate surfacing produced nothing.** 160 curated notes and zero new concept candidates. Either the heuristics are weak or the vault is already well-covered (probably both).
3. **Graph is worse than Obsidian.** SwarmVault's graph output is a flat source manifest. Obsidian's native graph + graphify shows actual wikilink topology and cluster structure.

**What to watch:** If SwarmVault ships a meaningful offline contradiction engine or the MCP server becomes useful for cross-tool vault queries, re-evaluate. Set a calendar note for Q3 2026.

---

## See Also

- [[LLM Wiki Pattern]] — the pattern SwarmVault implements
- [[Memory Decay Doctrine]] — HEAT_INDEX decay, already live
- [[WeKnora]] — similar evaluation, similar outcome
