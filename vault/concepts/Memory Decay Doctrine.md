---
title: Memory Decay Doctrine
tags:
  - doctrine
  - memory
  - vault-hygiene
  - standing-rule
aliases:
  - Heat Index
  - Conscious Recall
  - Memory Weighting
created: 2026-04-24
source: https://github.com/tinyhumansai/neocortex (pattern, not code)
---

# Memory Decay Doctrine

> [!abstract] Core principle
> A growing vault that treats every note as equally load-bearing forever scales poorly — stale concepts accumulate and drown out hot ones. Borrowed from [Neocortex](https://github.com/tinyhumansai/neocortex): **notes decay if unused, reinforce if touched**. A computed `heat_score` per note lets `/open` and the session agent prioritize what's actually live right now.

---

## Why

Pain this solves:
- The vault index has many pointers, all weighted equally
- `/open` surfaces "what's new" but not "what's hot"
- Concept notes from months ago that nobody has touched sit next to concept notes referenced every session
- No mechanism for graceful decay — stale notes never get de-prioritized without manual archival

Neocortex insight: **noise decays naturally, signal reinforces naturally**. The brain doesn't remember every sentence you've ever read; low-value memories fade, high-value ones get reinforced through use. Port the pattern (not the cloud service).

---

## The Heat Score

Every vault note gets a computed `heat_score` — a single number (0–100) representing **how live this note is right now**.

**Inputs (weighted sum):**

| Signal | Weight | Source |
|---|---|---|
| **Session reads (last 30 days)** | 40% | Claude Code JSONL logs — count `Read` tool calls per vault path |
| **Backlink count** | 25% | grep vault for `[[note name]]` — how many notes point to this one |
| **Git modification recency** | 20% | file mtime — recent edits reinforce |
| **Explicit pin** | 15% | YAML frontmatter `pin: critical` OR entry in `daemons/memory-heat/pinlist.json` — overrides decay for constitutional notes |

**Decay:** exponential half-life of 60 days. A note with high base score that hasn't been touched for 60 days drops to 50% of baseline; at 120 days, 25%; at 180 days, 12.5%.

**Floor:** notes with `pin: critical` or in the pin list cannot drop below 50. They stay warm regardless of access — for constitutional notes like `CLAUDE.md`, identity docs, authority matrices, standing rules.

---

## The Index

Heat scores live in `vault/memory/HEAT_INDEX.json` — a computed artifact, not hand-maintained. Regenerate weekly or after significant vault changes.

**Structure:**

```json
{
  "generated_at": "2026-04-24T05:30:00Z",
  "half_life_days": 60,
  "notes": [
    {
      "path": "concepts/Pipeline Verification Doctrine.md",
      "heat_score": 92.4,
      "session_reads_30d": 18,
      "backlinks": 6,
      "last_modified": "2026-04-22",
      "pinned": false
    }
  ],
  "hot_top_20": ["...", "..."],
  "cold_bottom_20": ["...", "..."]
}
```

---

## How `/open` Uses It

On session start:
1. Load top 20 hot notes from `HEAT_INDEX.json` → surface as "currently live"
2. Load `pin: critical` notes unconditionally (CLAUDE.md, identity, standing rules)
3. Skip cold notes unless the current objective explicitly requires them

**Result:** `/open` loads ~25 notes that matter *right now* instead of trying to cover the whole vault.

---

## How `/close` Uses It

On session close:
1. Run the compute-heat script to regenerate the index
2. Every session's reads automatically become the next session's signal — no separate cron required

---

## Regeneration Cadence

- **Every /close:** full recomputation via `daemons/memory-heat/compute-heat.js` (cheap, ~2 seconds for 300 notes)
- **On demand:** when vault structure changes significantly (bulk reorg, new cluster)

Manual run:
```bash
node daemons/memory-heat/compute-heat.js
```

Environment variables:
- `AIGENT_VAULT_ROOT` — override vault root (default: repo root)
- `AIGENT_JSONL_ROOT` — Claude Code project logs dir (default: skip session signal)

Output: `vault/memory/HEAT_INDEX.json` overwritten.

---

## Pinning Rules

Notes with `pin: critical` in frontmatter OR listed in `daemons/memory-heat/pinlist.json` never decay below 50. Use sparingly — these are **constitutional** notes:

- `CLAUDE.md` — agent operating instructions
- `system/00_identity.md` — who the principal is
- `system/12_authority_matrix.md`
- Standing rules for engineering + operations
- Session protocol
- Verification rules

Everything else is earned through use. Pinning is the escape hatch, not the default.

---

## Anti-Patterns

- **Don't pin every MOC.** MOCs are naturally hot because lots of notes link to them (backlink weighting handles it). Pinning them too defeats the decay signal.
- **Don't read `HEAT_INDEX.json` as a must-read list.** It's a prioritization signal, not a worklist. Cold doesn't mean "delete" — it means "skip during /open unless directly relevant."
- **Don't regenerate mid-session.** The signal should be stable within a session. Regenerate on /close, not on every tool call.

---

## Related

- [[Self-Improving CLAUDE.md]] — meta pattern for capturing learnings into the system
- [[Caddy]] — skill routing pattern (sister concept — both surface "what's relevant now")
