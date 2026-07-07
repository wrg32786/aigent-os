---
title: Modern AI Infrastructure Stack
tags:
  - doctrine
  - reference
  - infrastructure
aliases:
  - The AI Stack
  - Stack Layers
  - Infrastructure Map
created: 2026-04-26
---

# Modern AI Infrastructure Stack

A reference map of where each layer of the modern AI stack sits, the canonical tools at each layer, plausible alternatives, and **when the principal would actually need this layer**. The "when actually needed" column is the load-bearing piece — most principals don't need most layers, and knowing which ones don't apply prevents accidental complexity.

## The layers

### Application layer
**What it does:** Where the user-facing surface lives. The thing the principal (and possibly downstream users) actually interact with.

**Canonical tools:** Next.js, SvelteKit, Remix, Astro, Tauri (desktop), React Native (mobile).

**Alternatives:** Plain HTML/JS, Hugo, Eleventy, server-rendered Rails/Django, Streamlit (data apps), Gradio (ML demos).

**When the principal needs this layer:** Always, if the framework or product has any UI. Skip entirely if the "interface" is exclusively CLI / Claude Code chat / direct file editing.

---

### Persistence layer
**What it does:** Stores state across sessions, requests, restarts.

**Canonical tools:** Postgres (Supabase, Neon, Railway), SQLite, MongoDB, Redis (cached state).

**Alternatives:** Plain files (markdown vault), JSON blobs, key-value stores like LMDB / RocksDB, full-text indexes like SQLite FTS5 (used by some Claude Code extensions).

**When the principal needs this layer:** Whenever state must persist past a single session AND the volume exceeds what's comfortable as flat files. For the AIgent, the markdown vault is the primary persistence layer; secondary indexes (heat index, embeddings) are derived.

---

### Messaging layer
**What it does:** Delivers events, commands, or work items between processes, agents, or services.

**Canonical tools:** Postgres pg_notify, Redis pub/sub, RabbitMQ, NATS, Kafka, AWS SQS/SNS.

**Alternatives:** SQLite-as-message-bus (e.g., honker), file-system polling, direct HTTP, webhook fan-out.

**When the principal needs this layer:** When work fans out across multiple agents or processes that don't share memory. For most personal-tooling cases, in-process sub-agent spawning (Claude Code's `Agent` tool) is enough.

---

### Isolation layer
**What it does:** Sandboxes execution so untrusted code can't touch the host.

**Canonical tools:** Docker containers, Firecracker microvms, gVisor, AWS Lambda (functional isolation), browser sandboxes.

**Alternatives:** smolVM (lightweight microvm), nsjail, bubblewrap, plain user-namespacing.

**When the principal needs this layer:** When sub-agents run untrusted code at scale, OR when generated artifacts need a clean execution environment, OR when compliance demands strict process isolation. For agents that only edit known files within an authority-matrix-defined scope, this layer is overkill.

---

### Compute layer
**What it does:** Runs the actual model inference, training, or other heavy workloads.

**Canonical tools:** OpenAI API, Anthropic API, Google Vertex, Replicate, Together AI, Modal, Beam (managed). Self-hosted: vLLM, TGI, llama.cpp, ollama. GPU substrates: CUDA, ROCm, Metal, TileKernels.

**Alternatives:** CPU-only inference (small models), edge models (Phi, Llama-3-8B locally), browser-based inference (Web LLM, transformers.js).

**When the principal needs this layer:** Always for the model call itself. The choice between managed API and self-hosted depends on (a) latency requirements, (b) data residency requirements, and (c) whether the principal wants to own the compute substrate. For 95%+ of principal-tooling cases, managed API is correct. Self-hosted only makes sense at high volume or strict-residency situations.

---

### Observability layer
**What it does:** Surfaces what's happening across the stack — logs, traces, metrics, error reports.

**Canonical tools:** Datadog, New Relic, Sentry (errors), Grafana + Prometheus (metrics), OpenTelemetry, Honeycomb, Posthog (product analytics).

**Alternatives:** Plain log files + grep, structured JSON logs to S3, the framework's own session log (the AIgent does this — `/close` writes structured outcomes to `vault/daily/`).

**When the principal needs this layer:** When the framework runs unattended for periods, OR when downstream users encounter issues the principal didn't see, OR when measurement matters (it always does eventually). For interactive single-principal use, structured session logs are usually sufficient.

---

### Orchestration layer
**What it does:** Coordinates work across multiple services, manages deployment, scales resources.

**Canonical tools:** Kubernetes, Nomad, Docker Swarm, AWS ECS, Railway, Fly.io, Vercel, Cloudflare Workers.

**Alternatives:** systemd, plain SSH + scripts, GitHub Actions for scheduled workflows, cron + Bash for cadenced tasks.

**When the principal needs this layer:** When the framework runs as a deployed service rather than a local CLI, OR when there are multiple coordinating processes. For the AIgent running locally inside Claude Code, this layer is irrelevant.

---

## How to use this map

The map's purpose isn't to tell you what to use — it's to tell you what you can **skip**.

A principal building a personal AI operating system inside Claude Code needs maybe three of these layers (Application = none, Persistence = markdown vault, Messaging = none, Isolation = authority matrix, Compute = Anthropic API, Observability = session logs, Orchestration = none). Six layers don't apply. Knowing they don't apply prevents the temptation to add them.

The same principal, if they later expand into a multi-tenant SaaS, would need most of the layers. The map is a checklist for that expansion — it's also a reminder that you don't need most of it for most things.

## Connects to

- [[Bio-hacking Posture]] — this map informs the "stacks" category
- [[The Seven Layers]] — the AIgent's own internal seven-layer architecture (kernel, skills, hooks, daemons, vault, doctrine, principal config), distinct from this external infrastructure stack
- [[What I Am Not Building]] — explicit rejection of the layers that don't apply
- [[Legibility Thesis]] — why the persistence layer is markdown, not a database
