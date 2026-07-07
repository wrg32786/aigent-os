---
title: "LLM Wiki Pattern"
tags:
  - concept
  - architecture
  - memory
  - methodology
aliases:
  - Karpathy LLM Wiki
  - Persistent Wiki Pattern
  - Compounding Knowledge Base
---

# LLM Wiki Pattern

> [!abstract] TLDR
> - A pattern where the LLM **incrementally builds and maintains a persistent, interlinked wiki** between you and raw sources — not RAG, not re-derived per query.
> - Three layers: **raw sources** (immutable), **wiki** (LLM-owned markdown), **schema** (`CLAUDE.md` + rules that govern how the wiki is built).
> - Four operations: **ingest** (read source → update wiki pages), **query** (read wiki → synthesize answer), **lint** (health-check), **reflect** (capture reasoning behind structure).
> - The the AIgent vault already implements this pattern. This note documents the pattern, what was adopted, and what was rejected.

## Source

- **Primary:** Karpathy, *LLM Wiki* gist, 2026-04-04 — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- **Signal from comments thread** (234 comments): @laphilosophia #77, @hejiajiudeeyu #110, @Jwcjwc12 #118, @bendetro #122, @xoai #132, @YokoPunk #58

## The Core Idea

Most LLM + document workflows are RAG: upload files, retrieve relevant chunks at query time, generate an answer. The LLM rediscovers knowledge from scratch every query. Nothing compounds.

The wiki pattern inverts this. The LLM **builds and maintains a persistent artifact** that sits between you and raw sources. New source → LLM reads it, extracts key information, integrates it into existing wiki pages, revises topic summaries, flags contradictions. Knowledge is compiled once and kept current.

The human curates sources, asks questions, directs analysis. The LLM does the bookkeeping — summarizing, cross-referencing, filing, maintenance — the work that causes humans to abandon wikis.

## How the AIgent Implements This

| Karpathy Layer | The AIgent Equivalent |
|----------------|------------------|
| Raw sources | Code repos, PR reviews, team messages, session transcripts, external systems |
| Wiki | Obsidian vault — `concepts/`, `people/`, `projects/`, `agents/`, `memory/` |
| Schema | `CLAUDE.md` + system docs + `post-compact-critical.md` + `MEMORY.md` + Session Protocol |
| `index.md` | `MOC.md` + `MEMORY.md` |
| `log.md` | `SESSION_LOG` + `daily/YYYY-MM-DD.md` |
| Ingest | `/close` protocol, PR-review → concept note updates; memory-architect role for supersede/compact |
| Query | `/open` + in-session conversation; `/orient`; scout role for vault recon |
| Lint | `/close` does session-level; `/lint` (2026-05-01) is the on-demand full-pass |

## Insights Adopted from the Comments Thread

### 1. Two-Outputs Rule (from @hejiajiudeeyu #110, @xoai #132)

> Every task produces two outputs. Output one: the answer to the user. Output two: updates to the relevant wiki articles. If you don't make this explicit, knowledge evaporates into chat history.

**Adopted as a standing rule.** Promoted from "sometimes" to "always" for non-trivial work.

### 2. TLDR / Abstract at the Top of Every Note (from @YokoPunk #58)

> Adding a TLDR at the top of your wiki articles helps both humans and LLMs. Agents do an index scan, then read the TLDR first, then decide to dig into an article or not. Saves a lot of tokens.

**Adopted.** Concept template now requires a 3-bullet abstract callout so a sub-agent scanning the vault can make a read/skip decision without loading the full note.

### 3. Source Provenance (from @Jwcjwc12 #118)

> Every proposition records which source files produced it. When you query, it checks whether the files on disk still match.

**Partial adoption.** Hash-checking is overkill at this scale, but every concept note now carries a `## Source` section (URL, session ID, PR #, or "derived from reasoning in session X"). See [[Standing Rules - Operations#Source Provenance]].

### 4. Reflect Step + Decision Records with Reasoning (from @bendetro #122)

> Loop isn't `ingest → compile → query → lint`. It's `ingest → compile → **reflect** → query → lint`. Every knowledge change carries a decision record — not just what the wiki knows, but what decision shaped it and why.

**Adopted.** Decision log format expanded: each entry now captures Alternatives Considered + explicit Reasoning (why the winner won, what the losing options would have cost).

### 5. Lint as a Named Operation (from @skpalan #42, reinforced by the gist)

> The lint pass concept is the actually valuable new thing. Even if the rest is "just well-organized AGENTS.md," lint elevates it.

**Adopted (2026-05-01).** `/lint` skill shipped as on-demand full-pass version. Checks: orphan notes, contradictions between concept notes, stale claims newer sources superseded, concepts mentioned but lacking pages, missing cross-references.

### 6. Epistemic Caveat (from @laphilosophia #77)

> "The LLM owns this layer entirely" is aggressive for anything non-personal. Separate facts, inferences, and open questions. LLM proposes diffs, not silent overwrites.

**Half-adopted.** For a personal/operational vault, LLM-owned is fine — the principal reviews via graph browsing during work. For anything client-facing or compliance-relevant, the editor-in-chief model applies: The AIgent drafts, principal approves.

## Insights Rejected

- **qmd / BM25+vector search tools** — not needed at our scale (~400 notes). Obsidian search + grep + graph view still sufficient. Revisit at 1000+ notes.
- **SQLite-backed knowledge bases** — filesystem + markdown is the right abstraction for a vault the principal browses in Obsidian. Database-backed loses the graph view and the git-friendliness.
- **Content-hash provenance** — structurally elegant, operationally overkill. Simple source citation gets 80% of the value at 5% of the cost.
- **New wiki-CLI tools** shilled in the thread — noise. The existing stack already works.

## Open Questions

- **Pruning cadence** — when does a concept note become stale enough to archive? Monthly `/wiki-lint` should surface candidates, but thresholds haven't been defined.
- **New page vs edit existing** — implicit rule: new page when the idea is durable and has its own identity; update existing when it's a new fact about something already tracked. Worth codifying.

## What the AIgent is Missing (relative to the gist)

- **Candidate-page directory** — a staging area for concepts mentioned enough to warrant a page but not yet curated.
- **Hybrid search** — BM25 + embeddings improves recall on exact-term vs. semantic queries. Low priority unless query quality degrades.
- **Formal /lint pass** — CLOSED (2026-05-01). `/lint` skill shipped.

## Links

- Parent: [[Session Protocol]]
- Related: [[Standing Rules - Operations]], [[Verification Rules]], [[DECISION_LOG]], [[MOC]], [[MAP]], [[Self-Improving CLAUDE.md]]
- External precedent: [[Lego Arsenal Doctrine]], [[Gstack Port]], [[AI Coding Dictionary]]
- Adjacent tools: [[OmegaWiki]], [[SwarmVault]], [[remindb]]
- Memory layer: [[Memory Decay Doctrine]] (heat scoring is the conscious-recall layer on top of the wiki)

updated: 2026-05-02
