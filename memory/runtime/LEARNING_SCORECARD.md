---
title: Learning Process Scorecard
tags: [runtime, learning, metrics, meta-cognition, scorecard]
aliases: [learning-scorecard, LEARNING_SCORECARD]
created: 2026-05-08
---

# Learning Process Scorecard

Tracks whether the AIgent's learning systems actually work. Meta-layer over the cognitive architecture — not what the AIgent learned, but whether the learning mechanisms are functioning.

Updated monthly. Data sources listed per metric. See [[concepts/Cognitive Architecture Roadmap]] for the full system context.

---

## Metrics

| Metric | Current | Target | Trend |
|--------|---------|--------|-------|
| Skill recall hit rate | — | >80% | — |
| Failure recurrence rate | — | <10% | — |
| Belief revision accuracy | — | >70% | — |
| Capsule resume success | — | >90% | — |
| Fact capture coverage | — | >5 facts/session | — |
| Procedure reuse rate | — | >50% | — |
| Dream candidate adoption rate | — | >40% | — |
| Reconcile clean rate | — | >60% | — |

---

## How to Measure Each Metric

### Skill recall hit rate
**Question:** When the AIgent needs a skill, does it reach for the right one on the first try?
**Source:** SESSION_LOG.md — count sessions where a skill was invoked correctly vs. sessions where the wrong skill was tried first or the skill was overlooked entirely.
**Calculation:** `correct first-reach invocations / total skill invocations`
**Baseline:** Start counting from 2026-05-08. Review at 10 sessions minimum before drawing conclusions.

### Failure recurrence rate
**Question:** Are failures in FAILURE_MODES.md appearing more than once?
**Source:** FAILURE_MODES.md — count unique failure types vs. repeat occurrences in a rolling 30-day window.
**Calculation:** `repeat failures / total failure entries` in the window
**Good signal:** A failure mode that appeared once and never again = learning worked. Same failure twice = learning didn't stick.

### Belief revision accuracy
**Question:** When a belief is revised, was the revision correct?
**Source:** BELIEF_STATE.jsonl — track beliefs with `status: revised`. Compare prior claim vs. current claim vs. any corroborating fact in facts.jsonl.
**Calculation:** Subjective review — count revisions that moved toward a more accurate/verified claim vs. those that were neutral or regressive.
**Note:** Requires human review. Can't be fully automated.

### Capsule resume success
**Question:** When a capsule is resumed, does context load cleanly without re-establishing basics?
**Source:** BODY_STATE.json + SESSION_LOG.md — when a capsule is resumed, note whether the session opened productively or required re-orientation.
**Calculation:** `clean resumes / total resume events`
**Proxy signal:** If a resumed session starts with "wait, where were we?" — that's a miss.

### Fact capture coverage
**Question:** Is the AIgent capturing verifiable facts consistently?
**Source:** facts.jsonl — count entries per session (use `created` timestamp in entries, cross-ref SESSION_LOG.md dates).
**Calculation:** `total facts / total sessions in period`
**Target rationale:** 5 facts/session is a low bar. Most sessions touch multiple verifiable claims. If coverage is below 5, fact-capture discipline has slipped.

### Procedure reuse rate
**Question:** When a repeatable workflow exists as a procedure, is it used instead of reinvented?
**Source:** SESSION_LOG.md — scan for any task description that matches a known procedure. Count procedure-followed vs. task-reinvented.
**Calculation:** `procedure invocations / (procedure invocations + manual re-inventions of same task)`
**Note:** Requires knowing which procedures exist. Maintain a list in [[memory/SKILL_LEDGER]] or a `procedures/` directory.

### Dream candidate adoption rate
**Question:** Are /dream proposals actually being adopted?
**Source:** DREAM_LOG.md — count candidates with a resolution note (approved / rejected / deferred). Of approved+rejected, what fraction were approved?
**Calculation:** `approved candidates / (approved + rejected)`
**Deferred candidates don't count either direction — only resolved.**
**Target rationale:** 40% adoption means the proposals are high-signal, not noisy. Below 20% = /dream is generating low-quality candidates. Above 70% = possibly not being critical enough.

### Reconcile clean rate
**Question:** How often does /reconcile return CLEAN?
**Source:** Track /reconcile runs manually or via a log line in SESSION_LOG.md.
**Calculation:** `CLEAN runs / total runs`
**Trend matters more than absolute:** Increasing clean rate = cognitive hygiene improving. Declining = more drift accumulating than is being cleared.

---

## Review Cadence

- **Monthly:** Update Current column, recalculate all metrics, assess Trend (up/down/flat).
- **Quarterly:** Revisit targets. If consistently hitting a target for 3 months, raise it.
- **When a metric drops sharply:** Treat as a signal worth investigating — don't average it away.

---

## Connections

- [[memory/runtime/DREAM_LOG]] — dream candidate adoption tracked here
- [[memory/runtime/BELIEF_STATE.jsonl]] — belief revision accuracy source
- [[memory/runtime/LESSONS.jsonl]] — learning input
- [[memory/FAILURE_MODES.md]] — failure recurrence source
- [[memory/runtime/BODY_STATE.json]] — capsule resume source
- [[concepts/Cognitive Architecture Roadmap]] — full system context
- [[skills/reconcile]] — reconcile clean rate source
- [[skills/dream]] — dream candidate adoption source
