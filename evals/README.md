---
title: Eval Harness
tags: [evals, testing, quality, cognitive-layer]
aliases: [eval harness, aigent-OS evals]
created: 2026-05-08
---

# Eval Harness

Structured test definitions for the aigent-OS cognitive layer behaviors. Each
file covers a distinct capability. The runner automates skill routing and capsule
resume cases; model-backed contradiction cases remain a declared harness gap.

## Test files

| File | What it tests |
|------|--------------|
| `skill-recall-tests.json` | Skill routing accuracy — does a task prompt map to the right skill and taxonomy path? |
| `contradiction-tests.json` | Belief consistency — does the system correctly detect contradictions in working memory? |
| `capsule-resume-tests.json` | Capsule lifecycle — does the system correctly offer or suppress resume based on capsule status? |

## Manual scoring

For each test in a file:

1. Present the `prompt` (or `fact`/`capsule_status`) to the AIgent in a fresh session.
2. Observe the output.
3. Check whether the output matches the `expected_*` field.
4. Score: PASS / FAIL / PARTIAL.

Record results in `results/YYYY-MM-DD.md` (create `results/` dir when first run).

## Automated runner

Run the executable corpora with:

```bash
node evals/run-evals.mjs
```

Pass `--json` for a machine-readable report. For hermetic runner tests,
`AIGENT_ROOT=/path/to/fixture` selects an alternate install root; its corpora
must live under `$AIGENT_ROOT/evals/`. The runner implementation still comes
from this repository, so a fixture cannot accidentally test a copied scorer.

The F017 integrity self-test is discovered with the rest of `daemons/tests/`
and can also be run directly:

```bash
node daemons/tests/eval-runner-integrity.test.mjs
```

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

## Automation status

`run-evals.mjs` replays executable cases through the real caddy and capsule
selector, then exits nonzero on behavioral drift, undeclared prerequisites,
stale gap declarations, harness errors, or coverage-floor failures. Contradiction
cases stay visible as declared unrunnable rows until a model harness exists.

## Related

- [[Meta-aigent-OS Doctrine]] — evals gate the improvement pipeline
- [[Self-Learning Doctrine]] — failures generate new test cases
- [[Cognitive Architecture Roadmap]] — eval harness is Phase 3 infrastructure
- `~/.claude/skills/meta-improve/SKILL.md` — /system-check + evals are the two gates before approval
