---
title: Improvement Lifecycle
tags: [runtime, improvements, meta-improve, self-modification]
created: 2026-05-08
---

# Improvement Lifecycle

This directory manages the full lifecycle of proposed system improvements — from dream to merge.

## Flow

```
/dream
  └─ generates candidates → DREAM_LOG.md (status: proposed)
       └─ Will reviews + marks approved
            └─ /meta-improve
                 └─ creates branch
                      └─ implements change
                           └─ runs /system-check
                                └─ writes report → candidates/
                                     └─ surfaces to Will
                                          ├─ APPROVED → merge branch → accepted/
                                          └─ REJECTED → revert → rejected/
```

## Directories

| Directory | Contents |
|-----------|----------|
| `candidates/` | Reports for changes awaiting Will's approval. One file per candidate-id. |
| `accepted/` | Reports for approved and merged improvements. Permanent record. |
| `rejected/` | Reports for rejected improvements, with rejection reason prepended. |

## Report naming

All reports are named `{candidate-id}.md`. The candidate-id originates in DREAM_LOG.

Example: `candidates/dream-2026-05-08-skill-recall-fuzzy.md`

## Hard rules (summary)

- `/meta-improve` may NOT merge without Will's explicit approval.
- `/meta-improve` may NOT modify core system docs (00–15) without per-candidate written approval.
- Every change must pass `/system-check` before being presented.
- Every merge is logged to `STATE_EVENTS.jsonl` and `SELF_MODEL.json`.

See `~/.claude/skills/meta-improve/SKILL.md` for full rules.

## Related

- `../DREAM_LOG.md` — improvement proposals (source)
- `../STATE_EVENTS.jsonl` — event log (merge/rejection events written here)
- `../SELF_MODEL.json` — improvement cycle counter and applied improvements
- [[Meta-aigent-OS Doctrine]] — governing doctrine
