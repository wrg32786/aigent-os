---
title: Failure Modes Corpus
tags:
  - memory
  - corpus
  - debugging
  - longitudinal
aliases:
  - Failure Corpus
  - Diagnose Outcomes
---

# Failure Modes Corpus

Auto-built record of every confirmed `/diagnose` outcome. Phase 1 entries (single occurrences) accumulate here. Phase 2 entries (recurring patterns) graduate to [[Common Failure Modes]] doctrine.

See [[Common Failure Modes]] for the doctrine; this file is the data.

## How entries are written

`/diagnose` writes here automatically when it identifies a verified cause for a symptom. Format:

```markdown
## YYYY-MM-DD — {short symptom name}

**Symptom (verbatim from principal):** "{their own words}"
**Layer responsible:** L{N} ({layer name})
**Specific cause:** {file/line/config that was the actual issue}
**Fix applied:** {what the principal or agent did}
**Time to diagnose:** {minutes from /diagnose start to verified cause}
**Pattern (one line):** {what category of failure this was}
```

The "Pattern" line is the load-bearing piece. When the same Pattern line appears 3+ times across entries, the failure mode graduates from Phase 1 (here) to Phase 2 ([[Common Failure Modes]] doctrine note).

## Pattern detection

`/skill-audit` (or `/retro` in v0.3) periodically walks this file and identifies repeated Pattern lines. When a count reaches 3+:

1. The principal is notified: "Pattern X has occurred 3 times. Promote to doctrine?"
2. If yes, an entry is added to [[Common Failure Modes]] in the "Recurring patterns" section
3. The relevant skill (often `/diagnose` itself) is updated to surface the pattern proactively when matching symptoms appear
4. If structural, propose a kernel patch via `system/CHANGELOG.md`

## Initial state

Empty. Populates from v0.2.2 release forward.

---

## Phase 1 entries

*(Auto-managed by `/diagnose`. Each verified diagnosis appends here.)*

(none yet)

---

## Pattern frequency tracker

*(Computed periodically by /skill-audit or /retro. Lists each unique Pattern line and how many times it has appeared. Patterns at count 3+ are candidates for graduation.)*

(none yet)

## Connects to

- [[Common Failure Modes]] — the doctrine note this corpus feeds
- `/diagnose` skill — the writer
- [[The Seven Layers]] — entries are tagged by layer
- [[Cost of Confidence]] — sister corpus (confidence failures vs layer failures)
- `/retro` (forthcoming) — periodic analyzer
