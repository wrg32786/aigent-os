---
title: Memory Candidates
tags: [memory, somatic, staging]
aliases: ["candidates", "memory staging"]
created: 2026-05-02
---

# Memory Candidates

> [!info] Hot-path / background discipline
> Writes here are FREE and UNCURATED. Auto-capture (v0.4.2) appends candidates with low friction. **Curation does not happen at write-time.** Curation happens at `/digest`, where the principal reviews and either promotes, skips, or supersedes.

## Schema

| Field | Description |
|-------|-------------|
| `date` | When the candidate was captured |
| `source_phrase` | The phrase that triggered capture |
| `type` | decision / preference / doctrine / project / person / skill / unknown |
| `confidence` | low / medium / high |
| `suggested_destination` | proposed vault path if promoted |
| `status` | staged / promoted / skipped / superseded |
| `digested_on` | When `/digest` last reviewed it (null if pending) |
| `note` | Free-form context |

## Candidates

| Date | Source Phrase | Type | Confidence | Suggested Destination | Status | Digested On | Note |
|------|--------------|------|------------|----------------------|--------|-------------|------|
