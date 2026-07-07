---
title: Caddy Skill Recall Integration
tags: [caddy, skills, taxonomy, integration, doctrine]
aliases: [Caddy skill recall, skill-recall caddy wiring]
created: 2026-05-08
---

# Caddy Skill Recall Integration

How `/skill-recall` and the SKILL_LEDGER taxonomy are wired into Caddy's prompt-matching loop. **SHIPPED in S39** — taxonomy fallback and chain recall are live in `caddy.sh`.

See [[concepts/Caddy]] for Caddy's current architecture.
See [[concepts/Capability Expansion Doctrine]] for the doctrine this serves.
See [[memory/SKILL_LEDGER]] for the taxonomy being queried.

---

## Current architecture

```
UserPromptSubmit
  → caddy.sh reads $INPUT
  → hardcoded regex blocks (routing, comms, memory, context, somatic)
  → Python block: prompt_lower vs trigger strings in skill-index.json
  → prints [CADDY] hints to stdout
```

The Python block scores every skill in `skill-index.json` against the prompt via word-boundary and phrase matching. Top 2 skills scoring ≥ 2 are surfaced.

**Limitation:** The skill-index only captures Caddy-enrolled skills. Skills that exist on disk but lack Caddy enrollment are invisible to the current system.

---

## Upgrade: taxonomy keyword scan

### Goal

On every prompt, do a lightweight scan against SKILL_LEDGER taxonomy entries — not just Caddy-enrolled triggers. This closes the gap between "skills that exist" and "skills Caddy knows about."

### Implementation spec

Add a new Python block to `caddy.sh` after the existing skill-index scoring block. It should:

**1. Load SKILL_LEDGER**

```python
ledger_path = os.path.join(root, "memory", "SKILL_LEDGER.md")
# Parse taxonomy lines: `- \`taxonomy.path\` — description — skill/tool`
# Extract: path, description, skill_reference per entry
```

Use a simple regex against markdown lines rather than a full parser — the ledger format is stable:
```
^- `([^`]+)` — (.+?) — (.+)$
```

**2. Extract intent keywords from prompt**

```python
# Stopword-filter the prompt to 5-10 content words
# Match against both taxonomy path tokens and description tokens
# Score: path token match = 2 pts, description token match = 1 pt
```

**3. Rank and threshold**

Minimum score = 3 to surface a hint (higher bar than the trigger-match system to avoid noise).
Return at most 1 taxonomy hint per prompt (the trigger-match system already returns up to 2).

**4. Output format**

```
[CADDY:taxonomy] /skill-name (taxonomy.path) — description — [LEDGER]
```

The `[LEDGER]` tag distinguishes taxonomy hints from trigger-match hints, so they are visually distinct and can be separately muted via the class system.

**5. Gap detection**

If prompt score = 0 across ALL skill-index triggers AND all SKILL_LEDGER entries:

```
[CADDY:taxonomy] No skill match — consider /skill-recall to log this gap
```

This fires at most once per session (track in a temp file keyed by session start).

---

## Caddy class integration

The mute system (`memory/CADDY_MUTES.json`) uses named classes. Add:

- `taxonomy` — mutes SKILL_LEDGER taxonomy hints but leaves trigger-match hints active
- Existing classes: `memory`, `context`, `body`, `routing`, `all`

Wire `class_muted taxonomy` before the taxonomy block output, same pattern as existing class guards.

---

## SKILL_CHAINS integration

When the taxonomy block finds a match, also check `memory/SKILL_CHAINS.md` for prior chains with matching objectives:

```python
# Read SKILL_CHAINS.md
# For each chain row, tokenize the Objective column
# If overlap with current prompt tokens >= 3: surface chain as secondary hint
```

Output format:
```
[CADDY:chain] Prior chain for similar objective: skill1 → skill2 → skill3 (see SKILL_CHAINS)
```

---

## Implementation checklist

When wiring this in `caddy.sh`:

- [ ] Add `LEDGER="$ROOT/memory/SKILL_LEDGER.md"` near line 14 alongside existing path vars
- [ ] Add `CHAINS="$ROOT/memory/SKILL_CHAINS.md"` similarly
- [ ] Add `class_muted taxonomy` guard before new block
- [ ] New Python block goes AFTER the existing `PYEOF` block (line ~155+)
- [ ] Keep the new block's failure mode identical to existing: `2>/dev/null || exit 0`
- [ ] Test: a prompt with a clear taxonomy match should surface `[CADDY:taxonomy]` hint
- [ ] Test: a prompt with no match should surface the gap suggestion hint

---

## What this does NOT change

- The existing skill-index.json trigger-match system is untouched
- The hardcoded regex blocks (routing, comms, memory, context, somatic) are untouched
- Caddy enrollment via `caddy-enroll` skill is still required for full trigger coverage
- The taxonomy scan is a supplement, not a replacement

---

## Related

- [[concepts/Caddy]] — full Caddy architecture
- [[concepts/Capability Expansion Doctrine]] — doctrine this wiring serves
- [[memory/SKILL_LEDGER]] — the taxonomy file being queried
- [[memory/SKILL_CHAINS]] — the chains file for prior sequence recall
- [[memory/SKILL_GAPS]] — where gap detections should be logged
