---
title: remindb
tags:
  - concept
  - reference
  - memory
  - mcp
  - augment-candidate
aliases:
  - remindb memory
  - SQLite agent memory
created: 2026-05-01
updated: 2026-05-02
status: spiked
source: https://github.com/radimsem/remindb
---

# remindb

> [!abstract] What it is
> Agentic memory in a single SQLite file. Parses markdown/JSON/YAML into a typed node tree (`[preamble]`, `[heading]`, `[text]`, `[kv]`, `[list]`, `[table]`, `[code]`) with per-node hot/cold temperature, FTS5 full-text search, and an MCP tool surface (`MemoryTree`, `MemorySearch`, `MemoryFetch`, `MemoryDelta`). One `.db` file, portable across any MCP-compatible agent.

## Verdict: AUGMENT

> [!info] Integrate remindb as the agent-read cache layer on top of the existing vault. Vault stays the human-readable source of truth. remindb is the token-efficient query interface for agents at `/open` time and mid-session lookups.

## The problem it solves

Every `/open` re-reads CLAUDE.md and key vault files from scratch. As the vault grows past 250+ notes that cost compounds. remindb sits between vault and agent: vault stays Obsidian prose, remindb consumes it and serves structured context on demand — at a fraction of the token cost.

## Deployment

Wire as additive MCP layer. No behavior change to existing /open or MEMORY.md auto-load.

**State:**
- Binary: `remindb.exe` (v0.1.2) — install from the GitHub releases page
- Production DB: `<vault-root>/.remindb/vault.db` (~22MB for a 250+ note vault, full compiled)
- MCP server config: in `~/.claude/settings.json` under `mcpServers.remindb`. Auto-rescan every 5min via `--rescan-interval 5m`.
- Caddy hint: `[CADDY] MEMDB` enrolled in `daemons/caddy.sh`, fires on vault-recall intent patterns

**MCP integration verified end-to-end:**
- Server initialize handshake → 200 OK, protocol 2024-11-05
- `tools/list` → 8 tools surface: MemoryCompile, MemoryDelta, MemoryFetch, MemoryHistory, MemorySearch, MemorySummarize, MemoryTree, MemoryWrite
- `MemorySearch` against compiled vault returns ranked hits with `id` (anchor), `score`, `temp`, `tok` (token count), `file`

**How the AIgent uses it:**
- For known-topic vault queries: call `MemorySearch` via MCP instead of `Read` on individual markdown files
- For "what does X say about Y": call `MemorySearch` with budget, then `MemoryFetch` on the highest-scored anchor
- For session resume: call `MemoryDelta since_snapshot=N` to surface only what changed since last session
- Cold-load on /open still works as fallback if MCP fails

## Standing direction — Pantheon defaults (Phase 2, post-validation)

If remindb proves reliable across multiple sessions, it becomes the default query path for Pantheon instruments:

- **Scout agent** — pure read-only. Default to `MemorySearch` / `MemoryTree` for vault traversal. Direct `Read` only for brand-new notes not yet compiled.
- **Research agent** — use remindb for vault context-gathering; external sources (Tavily / WebFetch) unchanged.
- **Memory architect** — remindb is primary substrate. `MemoryWrite` / `MemorySummarize` are canonical surfaces.
- **Adversarial reviewer** — read-only via remindb for context; output stays the same.
- **Custodian** — use remindb's typed-node tree to find orphan-link patterns faster than wikilink-grep.
- **Builder** — hybrid: remindb for context-gathering BEFORE editing; direct `Read` for the file about to be `Edit`-ed (Edit can't take a cached tree slice).

**Sequencing guard:** don't ship Phase 2 until 5+ real session uses confirm remindb stays in sync (auto-rescan working) and produces correct results. Tracker in [[memory/REMINDB_VALIDATION]].

## Spike numbers (concrete)

- **Compile:** 30-note subset → 1,210 nodes → 1.1MB DB → sub-second
- **Full vault compile:** 250+ notes → ~22MB DB
- **Search savings (bench):** 94-98% vs raw vault read
- **Full-session savings (bench):** 74%
- **Delta precision:** 1-file edit → exactly 1 node delta out of 1,210

## Caveats / open uncertainty

- **Hot/cold temperature behavior:** all spike nodes stayed at `temp=0.50` default. Per design, temp only rises through live MCP `tools/call` invocations against `MemorySearch`/`MemoryFetch`. Confirm in real session use.
- **Auto-rescan reliability:** `--rescan-interval 5m` is configured but not yet observed in long-running session.
- **v0.1.2 maturity:** early version. May discover bugs in real session use that didn't surface in spike.

## Related

- [[LLM Wiki Pattern]] — the wiki-as-codebase doctrine remindb implements at the cache layer
- [[SwarmVault]] — REJECTED for the same problem space; remindb does what SwarmVault claimed to do
- [[MOM Memory]] — different solution to similar problem (per-project JSON schemas vs. single-file tree)
- [[HEAT_INDEX]] — the AIgent's existing per-file heat weighting; complementary to remindb's per-node temp
- [[Memory Decay Doctrine]] — the doctrine remindb operationalizes
- [[Lego Arsenal Doctrine]] — remindb is a reusable vault-cache Lego for any agent stack
- [[Pantheon]] — the agent roster getting Phase 2 defaults

## Spike results (v0.1.2)

### CLI surface (what actually exists)

| Command | What it does |
|---------|--------------|
| `compile <path>` | Parse + index directory into SQLite. Incremental — only changed nodes update. |
| `inspect [--tree] [--depth N]` | Show DB stats + optional typed node tree with token counts and temperatures. |
| `bench [--query] [--budget]` | Measure token cost: remindb vs naive raw-file read, per scenario. |
| `serve` | Start MCP server. Exposes `MemoryTree`, `MemorySearch`, `MemoryFetch`, `MemoryDelta` to any MCP client. |

No standalone `init`, `status`, `search`, or `MemorySearch` CLI commands. Those live behind `serve` as MCP tools only.

### Token efficiency numbers (30-note corpus, 1210 nodes)

| Scenario | Naive (tok) | remindb (tok) | Saved |
|----------|-------------|---------------|-------|
| tree (full index) | ~49,388 | ~37,520 | 24% |
| search: pipeline verification | ~26,685 | ~1,486 | **94%** |
| search: comms style | ~34,804 | ~1,187 | **97%** |
| search: model routing | ~41,717 | ~999 | **98%** |
| fetch (single node) | ~8,210 | ~155 | **98%** |
| delta (changed nodes only) | ~667 | ~28 | 96% |
| **total** | **~161,471** | **~41,375** | **74%** |

Search is the money scenario. Targeted queries cost 1-2% of a raw vault read.

### What worked

- **Compile is fast and incremental.** 30-note corpus compiled in under a second. Post-edit recompile detected exactly 1 changed node out of 1210.
- **Typed node tree is real.** `inspect --tree` shows `[preamble]`, `[heading]`, `[text]` nodes with IDs, token counts, and temperatures.
- **bench command is genuinely useful.** Built-in token efficiency measurement — no manual math needed.

### What didn't / limitations

- **Temperature doesn't track reads at CLI level.** Heat only updates through actual MCP tool calls via `serve`.
- **No `MemorySearch` CLI shortcut.** To test FTS5 search results directly you need the MCP server running and a client connected.
- **`[kv]`, `[list]`, `[table]`, `[code]` node types not visible in basic corpus.** Requires TOON-formatted notes or richer markdown tables.

## Token cost framing

MEMORY.md alone is ~230 lines / ~25KB. Raw read: roughly 6,000-8,000 tokens. With remindb, an agent calls `MemorySearch("active priorities sprint")` and gets back ~1,000-1,500 tokens of targeted nodes. 5-6x reduction on a single file. Across the full vault at `/open`, bench numbers suggest 74%+ total savings on a realistic query mix.

## How it fits the current stack

| | Vault (current) | remindb |
|---|---|---|
| **For whom** | Humans reading in Obsidian | Agents querying programmatically |
| **Unit of memory** | File (note) | Node (sub-note granularity) |
| **Temperature** | Per-file via [[Memory Decay Doctrine]] + [[HEAT_INDEX]] | Per-node, more granular |
| **Search** | /lint + vault sweep daemon | FTS5 built-in, MCP-exposed |
| **Agent access** | Read tool + grep | MCP tool call, any MCP-compatible agent |

Vault and remindb are not competing. Vault stays the human-readable source. remindb is the agent-cache layer on top.
