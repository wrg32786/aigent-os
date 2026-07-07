---
title: Somatic v0.4.5 Chain Compaction
tags: [doctrine, somatic, shipped]
aliases: ["v0.4.5", "capsule compaction"]
created: 2026-05-03
status: shipped
---

# Somatic v0.4.5 — Capsule Chain Compaction

When `parent_capsule_id` chains grow long, the oldest entries are summarized into a single chain-summary capsule. Keeps `/open` Step 2.5 fast and the chain readable. Manual invocation; /close surfaces a hint when chain hits threshold.

## Brief

> `/capsule-compact <head_id>` walks the chain backward from the head capsule, and if length >= 5, summarizes the oldest 3 into a single summary capsule. Updates pointers so the chain remains intact but compressed.

## Algorithm

Given chain F → E → D → C → B → A (6 capsules, F is head/active):

1. Walk `parent_capsule_id` from F. Collect [F, E, D, C, B, A] in order.
2. If length < 5: do nothing, exit.
3. Take oldest 3 (A, B, C). Write a new summary capsule S with:
   - frontmatter: `capsule_id: chain-summary-<F.id>-<timestamp>`, `status: resolved`, `compacted_summary: true`, `compacted_count: 3`, `compacted_ids: [A, B, C]`, `parent_capsule_id: A.parent_capsule_id` (null in this example)
   - body: concatenated `objective`s + key `open_threads` (still-open) + key `decisions_made_this_session` (status=held only)
4. Update D's frontmatter: `parent_capsule_id: S.capsule_id` (was C before)
5. Mark each compacted capsule (A, B, C) with `compacted_into: <S.capsule_id>` field. They stay on disk for archeology.

After: chain F → E → D → S (length 4). Older 3 collapsed but still readable.

## Trigger

- Manual: principal invokes `/capsule-compact <head_id>`
- Surfaced: /close Step 0.5 PART E (new in v0.4.5) — if active capsule's chain length >= 5, emit `[CADDY:context] CHAIN — capsule chain length N, /capsule-compact recommended`. Don't auto-compact.

## Files

- `daemons/capsule-compact.py` — does the work, takes head_id arg, prints summary id + new chain length
- `.claude/skills/capsule-compact/SKILL.md` — invokes the script

## Tests passed

- Synthetic 6-chain → run compact → verify chain length 4, summary capsule on disk, compacted_into markers on A/B/C, D.parent points at summary
- Short chain (3 capsules) → no-op, chain unchanged
- Multiple compactions: 6-chain → compact → 4-chain; grow to 8 → compact again → 4-chain (with parent_capsule_id chain via summaries)
- Idempotency: re-running compact on already-compacted chain produces same result

## What it does NOT do

- Does not auto-compact at /close. Surfaces hint, principal decides.
- Does not delete the 3 old capsules. They stay marked `compacted_into:`.
- Does not summarize capsule content via LLM. Just concatenates structured fields.
- Does not walk forward across forks (parent_capsule_id chains are linear).

## Cross-links

- [[concepts/Somatic Roadmap]]
- [[concepts/Somatic Layer]]
- [[concepts/context-capsule]] — base capsule schema
