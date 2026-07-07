---
title: Failed Experiments Ledger
tags:
  - memory
  - measurement
  - longitudinal
  - failure-mode
aliases:
  - FAILED_EXPERIMENTS
  - Failed Experiments
created: 2026-05-01
---

# Failed Experiments Ledger

Distinct from [[TRUST_DECAY]]. TRUST_DECAY tracks confident claims awaiting verification — open loops with uncertain outcomes. This ledger is for closed loops where we know the result: we tried something, it didn't work, and we want the "don't repeat this" signal to be durable.

Pattern from [[OmegaWiki]]: failed experiments as first-class anti-repetition memory. If you only record what worked, expensive mistakes repeat because the failure signal lives nowhere. See also [[LLM Wiki Pattern]] (lint operation — contradictions + stale claims) and [[Memory Decay Doctrine]] (heat scoring; failed experiments don't decay just because we stopped looking at them).

## Entry format

```
### YYYY-MM-DD — <experiment name>

**What we tried:** <1-2 lines>
**Why it failed:** <root cause, not symptom>
**What we lost:** <time / cost / opportunity>
**Conditions for retry:** <what would need to change — be specific>
**Status:** Closed (don't retry) / Conditional (retry if X)
```

## Entries

Empty. Populating from first use forward. No backfill — start clean, let it build.

---

*When adding entries: root cause, not symptom. "It was slow" is a symptom. "The API rate limit at N req/min made the pipeline unviable at production volume" is a root cause. Conditions for retry should be concrete enough that a future session can evaluate them without re-reading the whole history.*
