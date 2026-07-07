---
title: Memory Engine Spec
tags: [concept, architecture, memory, refactor, aigent-os, doctrine]
aliases: ["memory engine", "memory module", "Phase 4 memory"]
created: 2026-05-11
status: active
phase: 4
---

# Memory Engine Spec

> [!abstract] What this is
> The formal interface definition for the Memory Engine module — one of six modules in the [[concepts/aigent-OS Refactor Spec|aigent-OS modular architecture]]. This spec defines the six canonical operations, their current implementations, known failure modes, and the upgrade path to LLM-classified staging. The vault is the source of truth; [[concepts/remindb|remindb]] is the agent-consumable cache layer on top.

## Design invariant

**Nothing promotes to vault without Will's explicit decision.** Every operation either stages (tentative), surfaces for curation, writes to vault with principal approval, queries without modifying, or manages metadata. Auto-promotion is not a feature — it is a failure mode.

---

## The Six Operations

### 1. `stage(candidate)` — Candidate Capture

**What it does:** Intercepts memory-authoring phrases from Will's input and appends a candidate row to `memory/MEMORY_CANDIDATES.md` for later review.

**Current implementation:** `daemons/memory-capture.sh` — a Python script invoked from `daemons/caddy.sh` on every UserPromptSubmit hook. Uses two-tier regex matching.

| Tier | Patterns | Confidence | Status |
|------|----------|------------|--------|
| Tier 1 | `remember that X`, `from now on X`, `new rule: X`, `rule: X`, `we decided X`, `going forward X` | high | Stable — high precision |
| Tier 2 | AI-tell corrections, `never use X`, placement rules (`shouldn't live in X`), calibration corrections (`divide X by N`), explicit disagreements | medium | Calibrated — `correction_actually` and `correction_drop` removed after 100% false-positive rate |

**Input sanitizer (added this session):** strips XML/HTML tags, fenced code blocks, inline code, JSON fragments, and markdown table rows before pattern matching. These are agent output, not Will's words. Without this, Tier 2 fired on agent responses and tool results.

**Operational constraints:**
- Hard cap: 50 staged rows. At cap, skip new captures and emit `[CADDY:memory] CAP` hint. Forces a `/digest` before more accumulate.
- 24h dedupe: same normalized phrase captured within 24h → skip silently.
- Best-effort: capture failure MUST NOT block Caddy hint output. Errors route to `memory/.daemon-errors.log`.
- Excluded phrases: `/digest`, `review candidates`, `stage memory`, `promote candidate` — these are skill invocations, not memory-authoring.

**Known failure mode (fixed):** Tier 2 `correction_actually` matched any sentence containing "actually" followed by 10+ characters. Same problem with `correction_drop`. Both removed. The insight: real corrections from Will are short imperative sentences that Tier 1 patterns already catch. Tier 2 should only add recall for signals Tier 1 structurally can't reach (e.g., AI-tell language without a trigger keyword).

> [!info] Upgrade path (Phase 5+)
> Replace regex with LLM classification: send the sanitized input to a haiku sub-call with the prompt "Is this a real directive from Will that should be remembered? Return YES/NO + extracted content." This eliminates false positives structurally rather than through pattern pruning. Threshold: only implement when false-positive rate from Tier 2 proves unacceptable in production. Current Tier 2 observability log (`memory/.tier2-observations.log`) accumulates signal for this decision.

**Candidate row schema:**

```
| date | "source_phrase" | type | confidence | suggested_destination | status | digested_on | note |
```

`suggested_destination` is rule-based by type: `doctrine` → `concepts/Standing Rules - Operations.md`; `preference` → `feedback/<slug>.md`; `decision` → `memory/DECISION_LOG.md`.

---

### 2. `digest()` — Candidate Review

**What it does:** Surfaces each staged candidate to Will one at a time with three choices: promote, skip, or supersede an existing rule.

**Current implementation:** `/digest` skill. As of Phase 3 work, wired into `/close` — it runs automatically at session close rather than only on explicit invocation.

**Invariant:** Never auto-promotes. Will makes every call. The skill presents the candidate, suggests a destination, and waits for a decision. This is non-negotiable — see [[concepts/Somatic v0.4.2 Memory Capture]] for why staged-with-curation beats auto-promote.

**Decision options per candidate:**

| Choice | Effect |
|--------|--------|
| Promote | Updates status to `promoted`, triggers `promote(candidate, destination)` |
| Skip | Updates status to `skipped`, candidate archived in-place |
| Supersede | Marks which existing rule this replaces, triggers update to that note |

**When it runs:** Automatically at `/close` if staged candidates exist. Also available on-demand via `/digest`. The on-demand path is the escape hatch for heavy memory-authoring sessions where Will wants to curate before the session ends.

---

### 3. `promote(candidate, destination)` — Write to Vault

**What it does:** Takes a promoted candidate and writes it as a proper Obsidian vault note, then adds a pointer to the MEMORY.md index.

**Current state:** Partially manual. `/digest` surfaces the candidate and destination suggestion; the actual vault write relies on the main session executing it correctly. No dedicated automation script exists yet.

**Required output format for every promoted note:**

```yaml
---
title: <title>
tags: [feedback|doctrine|decision|...]
aliases: [...]
created: <ISO date>
---
```

Plus:
- At least one outbound `[[wikilink]]` to a related vault note
- Backlink added to the related note (or flagged for Hestia to wire on next sweep)
- MEMORY.md index entry: single line, under 200 chars, with absolute vault path

**Destination routing by type:**

| Type | Default destination |
|------|---------------------|
| doctrine | `concepts/Standing Rules - Operations.md` or `-Engineering.md` |
| preference | `feedback/<slug>.md` (new note) |
| decision | `memory/DECISION_LOG.md` (append entry) |
| project fact | Relevant project note in `projects/` or `memory/` |

> [!danger] Quality gate
> A promoted note with no wikilinks is an orphan. Orphaned notes don't surface through the graph — they exist but never activate. Every promote must wire at least one backlink. Hestia's sweep catches orphans; the /lint skill audits them on-demand.

---

### 4. `query(intent)` — Memory Search

**What it does:** Returns relevant vault content given a query intent. Used at `/open`, during session mid-points, and whenever the agent needs to load context before acting.

**Three layers, different use cases:**

| Layer | Tool | Use when |
|-------|------|----------|
| remindb FTS5 | `MemorySearch`, `MemoryFetch` | Known-topic lookup: "what does the vault say about X?" Returns 1-2% of naive token cost for targeted queries. Default for most mid-session lookups. |
| HEAT_INDEX.json | Read `memory/HEAT_INDEX.json` | Session start context prioritization: load `hot_top_20` instead of trying to cover the full vault. Complements remindb — heat is per-file, remindb is per-node. |
| Direct vault reads | `Read` tool + wikilink traversal | When the file is not yet in remindb (brand-new note), when you need the full note for editing (Edit tool requires file content in context), or when remindb returns no results. |

**Decision tree:**

```
query(intent)
  ├─ intent is specific topic?
  │    └─ MemorySearch(intent, budget=2000) → MemoryFetch on top-scored anchor
  ├─ intent is "what's live right now"?
  │    └─ Load HEAT_INDEX.json → hot_top_20 + pin:critical notes
  ├─ remindb returns nothing?
  │    └─ fallback: Read vault file directly
  └─ file about to be edited?
       └─ Read file directly (Edit cannot work from a cached tree slice)
```

**remindb operational details:**
- Binary: `~/.local/bin/remindb` (or platform equivalent) v0.1.2
- Production DB: `<vault>/.remindb/vault.db`
- Auto-rescan: every 5 minutes via `--rescan-interval 5m`
- MCP tools available: `MemorySearch`, `MemoryFetch`, `MemoryTree`, `MemoryDelta`, `MemoryCompile`, `MemorySummarize`, `MemoryHistory`, `MemoryWrite`
- Token efficiency: 94-98% savings vs raw vault reads on targeted searches; 74% on realistic full-session query mix

**When NOT to use remindb:** Immediately after creating a new note. The 5-minute rescan means new content isn't indexed yet. Use `Read` for fresh files.

---

### 5. `decay()` — Staleness Management

**What it does:** Manages the "heat" of vault notes and the staleness of staged candidates and delegation items. Keeps the active context fresh and prevents accumulation of dead weight.

**Three sub-components:**

#### 5a. HEAT_INDEX.json — Note-level decay

Per [[concepts/Memory Decay Doctrine]]:
- Heat score (0-100) per note computed from: session reads (40%), backlink count (25%), git modification recency (20%), explicit pin (15%)
- Exponential half-life: 60 days. Untouched note at 60d → 50% score; at 120d → 25%
- Floor: `pin: critical` notes never drop below 50 — constitutional notes stay warm
- Regeneration: weekly cron via `daemons/memory-heat/compute-heat.js`; lightweight `reinforce_queue` update at `/close`
- Notes in `hot_top_20` load at `/open`. Notes in `cold_bottom_20` are skipped unless directly relevant to current objective.

#### 5b. MEMORY_CANDIDATES.md — Candidate expiry

- Hard cap at 50 staged rows forces curation before new candidates accumulate
- No automatic expiry of individual rows — `/digest` is the drain
- When cap is hit, capture stops and Caddy emits the cap hint. This is by design: the backlog signals a missed `/close`.

#### 5c. Delegation tracker staleness

Per [[memory/DELEGATION_TRACKER.md]]: items older than defined thresholds surface as stale during `/open`. Hestia's sweep (via `/sweep-now`) handles delegation item cleanup. See [[concepts/Somatic v0.4.4 Hestia Wiring]] for the body-check integration.

> [!info] remindb temperature vs. HEAT_INDEX
> remindb tracks per-node heat through actual MCP tool call invocations (`MemorySearch`/`MemoryFetch`). HEAT_INDEX tracks per-file heat through session reads + git history. They're complementary: remindb heat answers "which node within a note is referenced", HEAT_INDEX answers "which file matters right now." Run both in parallel until remindb temperature proves reliable across 5+ sessions. See [[memory/REMINDB_VALIDATION.md]].

---

### 6. `index()` — MEMORY.md Management

**What it does:** Maintains the MEMORY.md index as the agent-facing pointer layer to all vault memory. Prevents the index from becoming the bloat problem it was designed to solve.

**Current state of MEMORY.md:** 289 lines, 45.4KB, partially truncating on load. Mixes active projects, shipped somatic versions, killed projects, and health data at the same weight.

**Constraints (standing rules):**

- **Hard line limit:** MEMORY.md MUST stay under 200 lines. The index is a pointer layer, not a content layer. Content lives in vault notes — MEMORY.md points to them with one-line entries.
- **Entry format:** Single line, under 200 chars, with absolute vault path in markdown link format. Never prose paragraphs in the index.
- **No inline content:** If an index entry needs more than one sentence, the content belongs in a vault note. The entry becomes a link to that note.
- **Deduplication:** One entry per topic. If a topic has multiple related notes, the index points to the primary one; that note cross-links the rest.
- **Section organization:** Four sections only — `Active Projects`, `People & Agents`, `Reference`, `Archive`. Shipped/killed items move to Archive, not permanent deletion (history matters, but it shouldn't dominate the hot path).

**What triggers an index update:**
- `promote()` succeeds → append new entry
- Sprint closes → move completed sprint entries to Archive
- Project killed → move to Archive with kill date
- Shipped somatic/doctrine versions → consolidate to single "shipped as of X" entry pointing to the canonical version note

**Pruning candidates (Phase 4 cleanup):**

| Category | Action |
|----------|--------|
| "ALL SHIPPED" Somatic v0.4.3-v0.5.0 entries | Consolidate to single entry pointing to [[concepts/Somatic Roadmap]] |
| Upwork Hunter entry | Remove (project killed S40) |
| Completed sprint items | Move to Archive section |
| Health bloodwork entries | Keep — active reference |
| remindb validation tracker | Keep — active gate condition |

---

## Vault / remindb Architecture

The Memory Engine sits on two complementary substrates. They serve different audiences and must not be conflated.

```
Will (human)
  └─ Obsidian vault (<vault>/)
       └─ Human-readable markdown notes, wikilinks, Obsidian graph
       └─ Source of truth. Edited by Write/Edit tools.

Agents (programmatic)
  └─ remindb (.remindb/vault.db)
       └─ SQLite cache of vault content as typed node tree
       └─ FTS5 search, per-node temperature, MCP tool surface
       └─ Read-only from agents. Written by remindb compile (auto-rescan).
```

> [!danger] Never write to remindb directly
> `MemoryWrite` exists in the MCP tool surface but agents must not use it to bypass vault. All authoritative content lives as vault markdown files. remindb is a cache — it reflects the vault, it does not replace it. Write vault → remindb resyncs. Never write remindb → "update vault later."

**Sync guarantee:** auto-rescan every 5 minutes means remindb is at most 5 minutes stale. For freshly created notes, use `Read` directly until the next rescan cycle.

---

## Failure Modes to Prevent

| Failure | Prevention |
|---------|------------|
| Auto-promote without Will's decision | `digest()` is the only promotion path; staging never writes to vault |
| Orphan vault notes (no wikilinks) | Every `promote()` must wire at least one backlink; Hestia catches stragglers |
| MEMORY.md index bloat | 200-line hard cap; Archive section for shipped/killed items |
| remindb cache drift | 5-min auto-rescan; fallback to `Read` when freshness required |
| False-positive candidate staging | Input sanitizer strips agent output; Tier 2 patterns restricted to structurally distinct signals; `.tier2-observations.log` accumulates calibration data |
| Candidate backlog rot | 50-row hard cap forces `/digest` before accumulation becomes unmanageable |
| Stale delegation items | Hestia sweep + body-check integration flags items overdue by threshold |

---

## Implementation Status

| Operation | Status | Location |
|-----------|--------|----------|
| `stage()` | Shipped (v0.4.2) | `daemons/memory-capture.sh` |
| `digest()` | Shipped, wired to `/close` (Phase 3) | `~/.claude/skills/digest/SKILL.md` |
| `promote()` | Partial — manual write, no automation | Main session execution |
| `query()` | Shipped — remindb live, HEAT_INDEX active | MCP tools + `memory/HEAT_INDEX.json` |
| `decay()` | Shipped (heat index) + partial (Hestia delegation) | `daemons/memory-heat/compute-heat.js` + Hestia |
| `index()` | Defined here — MEMORY.md pruning is Phase 4 cleanup work | `~/.claude/projects/.../memory/MEMORY.md` |

**Phase 5 gate:** LLM classification for `stage()` — only after `.tier2-observations.log` shows false-positive volume that justifies the cost of a haiku sub-call per prompt.

---

## Related

- [[concepts/aigent-OS Refactor Spec]] — parent architecture; Memory Engine is Module 3
- [[concepts/Somatic v0.4.2 Memory Capture]] — detailed spec for `stage()` implementation
- [[concepts/Somatic Layer]] — base doctrine; Memory Engine is the memory organ
- [[concepts/remindb]] — cache layer; full deployment status, token benchmarks, MCP tool surface
- [[concepts/Memory Decay Doctrine]] — heat score formula, HEAT_INDEX.json spec, decay math
- [[concepts/Self-Improving CLAUDE.md]] — how learnings route into the memory system
- [[memory/MEMORY_CANDIDATES.md]] — staging surface for `stage()` output
- [[memory/REMINDB_VALIDATION.md]] — session ledger gating Phase 2 remindb-first defaults
- [[concepts/Somatic v0.4.4 Hestia Wiring]] — `decay()` integration for delegation staleness
- [[concepts/Pipeline Verification Doctrine]] — same "trace every field" discipline applied to memory ops
