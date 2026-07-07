---
title: Context Mode
tags:
  - concept
  - reference
  - mcp
  - context-management
  - installed
aliases:
  - context-mode
  - ctx_execute
  - context-mode MCP
created: 2026-05-02
source: https://github.com/mksglu/context-mode
---

# Context Mode

> [!abstract] TLDR
> - MCP server that keeps raw data out of the AIgent's context window. 315KB input → 5.4KB summary (~98% reduction).
> - **Install via Claude Code plugin marketplace.** Tools available every session once configured.
> - Standing rule: route heavy ops through ctx_execute — see [[feedback/Use ctx_execute for heavy ops]].

## What it does

Four parts:

**1. Sandbox execution** — `ctx_execute`, `ctx_batch_execute`, `ctx_execute_file` run shell/JS/Python in a sandbox. Raw output stays there. Only your `console.log` summary enters context.

**2. Session continuity** — every file edit, git op, task, and error tracked in SQLite with FTS5 indexing. Survives compaction. Query past ops with `ctx_search`.

**3. Think in code** — agent writes a script that computes/filters/aggregates, logs only the result. One script replaces N sequential tool calls.

**4. Output compression** — terse caveman style. ~65-75% output token reduction.

## Available skills

`context-mode:ctx-doctor`, `ctx-stats`, `ctx-purge`, `ctx-upgrade`, `ctx-insight`, `context-mode-ops`

## Common failure pattern

Running large data pulls, log scans, and JSON processing through raw Bash + `head`/`cat` instead of `ctx_execute`. The PreToolUse hook fires every time this happens. Those raw outputs go straight into context window.

Standing discipline rule banked separately: [[feedback/Use ctx_execute for heavy ops]].

## Relationship to other tools

- **[[remindb]]** — complementary, not competing. remindb is a structured vault cache (semantic retrieval of vault notes). context-mode is an execution sandbox (keeps large outputs out of context). Use both.
- **Defuddle** — for single-URL reads, route through `ctx_fetch_and_index` instead of Defuddle skill directly. Defuddle parses; ctx_fetch_and_index parses + indexes for later `ctx_search`.

## Links

- Standing rule: [[feedback/Use ctx_execute for heavy ops]]
- Complementary MCP: [[remindb]]
- Operationalizes concepts from: [[AI Coding Dictionary]] (smart-zone / attention-budget)
