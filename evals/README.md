---
title: Eval Harness
tags: [evals, testing, quality, cognitive-layer]
aliases: [eval harness, aigent-OS evals]
created: 2026-05-08
---

# Eval Harness

Structured test definitions for the aigent-OS cognitive layer behaviors. Each file covers a distinct capability. Tests are run manually today; a future eval daemon will automate scoring.

## Test files

| File | What it tests |
|------|--------------|
| `skill-recall-tests.json` | Skill routing accuracy — does a task prompt map to the right skill and taxonomy path? |
| `contradiction-tests.json` | Belief consistency — does the system correctly detect contradictions in working memory? |
| `capsule-resume-tests.json` | Capsule lifecycle — does the system correctly offer or suppress resume based on capsule status? |

## How to run (manual)

For each test in a file:

1. Present the `prompt` (or `fact`/`capsule_status`) to the AIgent in a fresh session.
2. Observe the output.
3. Check whether the output matches the `expected_*` field.
4. Score: PASS / FAIL / PARTIAL.

Record results in `results/YYYY-MM-DD.md` (create `results/` dir when first run).

## Scoring criteria

### skill-recall-tests.json

- **PASS:** the AIgent invokes the expected skill OR correctly identifies the expected taxonomy path.
- **PARTIAL:** the AIgent surfaces the right domain but wrong specific skill.
- **FAIL:** the AIgent picks an unrelated skill, halts without skill suggestion, or invents a non-existent skill.

### contradiction-tests.json

- **PASS:** `expected_detection: true` — the AIgent flags a contradiction. `expected_detection: false` — the AIgent does not flag a false positive.
- **FAIL:** True contradiction missed, or false positive raised on a consistent fact.

### capsule-resume-tests.json

- **PASS:** `expected_offer_resume: true` — the AIgent offers to resume the capsule at session open. `expected_offer_resume: false` — the AIgent does not offer resume (capsule is resolved/abandoned/null).
- **FAIL:** Resume offered on a dead capsule, or not offered on an active/paused one.

## Acceptance threshold

Before a cognitive layer change is merged via `/meta-improve`, run all affected test files. Required:

- skill-recall: 4/5 PASS (one PARTIAL acceptable)
- contradiction: 3/3 PASS (zero false positives tolerated)
- capsule-resume: 5/5 PASS (lifecycle correctness is binary)

## Future: eval daemon

A `/run-evals` skill will automate scoring by replaying test inputs through sub-agents and comparing outputs to expected values. Scorecard written to `results/`. Caddy reflex fires if regression score drops below threshold after a `/meta-improve` merge.

## Related

- [[Meta-aigent-OS Doctrine]] — evals gate the improvement pipeline
- [[Self-Learning Doctrine]] — failures generate new test cases
- [[Cognitive Architecture Roadmap]] — eval harness is Phase 3 infrastructure
- `~/.claude/skills/meta-improve/SKILL.md` — /system-check + evals are the two gates before approval
