---
title: WeKnora
tags:
  - reference
  - knowledge-platform
  - rag
  - observability
  - skip-rationale
aliases:
  - Tencent WeKnora
created: 2026-05-01
source: https://github.com/Tencent/WeKnora
---

# WeKnora

> [!info] Status: pattern-bookmark, not installed
> Tencent's open-source RAG / agent / auto-wiki / IM-bot knowledge platform. Heavy stack, audience unclear, mostly skip. Two patterns worth lifting for future use.

## What it is

Open-source LLM-powered knowledge framework. RAG Q&A + ReAct agent + "Wiki Mode" that distills raw documents into interlinked markdown + interactive knowledge graph. 20+ LLM providers, multi-source ingestion (Feishu / Notion / Yuque), IM bot front-ends (WeCom / Feishu / Slack / Telegram / DingTalk / Mattermost). MIT license, self-hostable, Docker deploy.

## Why mostly skip

- **Auto-wiki = vault.** WeKnora's headline feature is "agents distill raw documents into a self-maintaining, interlinked markdown knowledge base with an interactive knowledge graph." That IS the aigent-OS vault. Obsidian + frontmatter + wikilinks + [[graphify]] already do this, manually curated per [[Self-Improving CLAUDE.md.md]].
- **Audience unclear.** WeKnora's IM-bot-querying-the-vault flow needs an audience that isn't already in the agent loop. No clear user today.
- **Heavy deploy.** Docker + vector DB choice (Milvus / Weaviate / etc.) + Langfuse + IM channel configs. Days, not hours.
- **Tencent-skewed stack.** WeChat Mini Program, Feishu, Yuque, Hunyuan LLM, Volcengine TOS, Alibaba Cloud OSS. Most connectors don't apply to a typical stack.
- **ReAct overlap.** WeKnora's agent orchestration is what a Pantheon-style setup already does — scout agents for read-only recon, synthesis agents, adversarial review agents, Caddy for routing.

## Two patterns worth lifting

### 1. Auto-wiki document ingest

WeKnora parses 10+ document formats (PDF, Word, images, Excel, Yuque) and distills them into interlinked markdown. Tencent built the parsers; the AIgent has nothing equivalent for ingesting external doc dumps into the vault.

**Lift when:** you ever need to ingest a large external document corpus (competitor docs, regulatory filings, a deal data room) into the vault as wikilinked notes. WeKnora's ingest pipeline is the prior art.

**Don't lift now:** no current document-corpus need. [[Lego Arsenal Doctrine]] says park the pattern, don't build speculatively.

### 2. Langfuse observability layer

WeKnora integrates Langfuse for agent ReAct loop tracing, LLM token tracking, tool call observability, and pipeline tracing. The AIgent has HEAT_INDEX + TRUST_DECAY + HONESTY_LEDGER but those are markdown ledgers, not a queryable dashboard.

**Lift when:** the trust-decay + honesty-ledger discipline gets serious enough to need cross-session calibration metrics, calibration trend graphs, or cost-attribution by agent. Today, markdown ledgers are sufficient for weekly review. If discipline scales to a team or a longer time horizon, Langfuse becomes the dashboard.

**Don't lift now:** ledgers are still being populated. Premature dashboards on thin data are theatre.

## Skip-list (not worth lifting)

- IM bot adapters (WeCom, Feishu, Slack, Telegram, DingTalk, Mattermost) — any team comms hub handles this better.
- Multi-source connectors (Notion, Feishu, Yuque) — not on those platforms.
- Vector DB management UI (Milvus, Weaviate, etc.) — not relevant until the AIgent ever needs vector search beyond a semantic-search skill.
- WeChat Mini Program — not applicable.
- Knowledge graph viewer — graphify already does this for the vault.
- Wiki Mode auto-distillation — vault + manual curation + memory-architect instrument cover this.

## Related

- [[Lego Arsenal Doctrine]] — every external build is a reusable Lego; bookmark patterns even when not installing
- [[Gstack Port]] — worked example of porting external skill bundle where porting was the right call
- [[Self-Improving CLAUDE.md.md]] — the vault-as-knowledge-base doctrine
- [[Memory Decay Doctrine]] — heat-weighted memory, current observability primitive
