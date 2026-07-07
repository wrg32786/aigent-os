---
title: Review Before Push
tags:
  - doctrine
  - code-review
  - quality-gate
  - agents
aliases:
  - Review-Before-Push Doctrine
  - Ship Gate
  - Pre-Merge Review
created: 2026-07-07
---

# Review Before Push

> [!abstract] One-line principle
> No agent-written diff reaches the shared branch without a reviewer pass returning a ship / no-ship verdict first. The author does not merge their own work.

---

## The doctrine

Before any agent-authored change reaches the shared branch (main, a shared feature branch, or anything another agent or the principal will build on top of), a reviewer pass runs over the diff and returns an explicit verdict: **ship** or **fix-first**. Only after a ship verdict does a designated pusher — a role, not necessarily a specific agent — merge the change.

This is the [[concepts/Core Operating Ethos]] "anticipate the next failure" pillar applied to code review specifically: the failure this doctrine prevents is not "the code is wrong" (that's just a bug) — it's "wrong code reached a shared branch with nobody else's eyes on it, and now everyone building on top of it inherits the mistake silently."

## Why a self-review isn't enough

An agent (or person) that just wrote code is the worst-positioned party to catch what's wrong with it — not from lack of skill, but from lack of distance. The author's mental model *is* the code; anything the author got wrong is invisible to the author precisely because the wrong assumption is baked into how they're reading their own diff back. A second pass, run by a different reasoning process (a separate reviewer subagent, or a genuinely fresh read after time away), catches a different class of error than the author re-reading their own work.

This mirrors [[concepts/Three Rules]] Rule 1 — verify before you claim. "I wrote it and it looks right to me" is not verification. A reviewer pass that actually exercises the failure modes and asks falsifiable questions is.

## The mechanism

The reviewer pass does not need to be a separate person or a heavyweight process — it needs to be a genuinely separate reasoning pass with a structured verdict:

1. **Set context.** What was the ask, what was the cause, what was the fix — 3-5 lines, not a wall of text.
2. **List the specific changes.** File:line references, not "I updated the auth module."
3. **Ask falsifiable verification questions**, not "does this look good?" — see [`/self-review`](../../skills/self-review/SKILL.md) for the concrete question-quality bar.
4. **Rate findings by severity** and resolve them: high-severity findings block the merge; medium gets fixed unless there's a documented reason not to; low is a judgment call, often deferred to a follow-up note.
5. **Only a designated pusher merges**, and only after the ship verdict. The reviewer's job is to render a verdict, not to merge — keeping those two roles separate is what makes the gate real instead of theater.

`/self-review` (spawning a reviewer subagent with 4-6 specific verification questions) is the concrete skill instantiation of this doctrine already shipped in aigent-OS. This note names the *doctrine* the skill exists to enforce, so the requirement survives even if the specific skill implementation changes.

## What this doctrine is NOT

- **Not a rubber stamp.** A reviewer pass that always says "looks good" is worse than no review — it manufactures false confidence. See [[concepts/Cost of Confidence]].
- **Not a bottleneck for every keystroke.** Trivial, mechanical, single-line changes with an obvious diff can skip the gate explicitly (see `/self-review`'s "when to skip" criteria) — but skipping must be stated out loud, not silently assumed.
- **Not the same role reviewing and merging.** If the same actor both renders the verdict and pushes, the separation of concerns collapses and the gate stops doing its job.
- **Not a substitute for tests.** Review catches what tests don't (design mistakes, missed edge cases, scope creep); tests catch regressions review will miss on the next change. Use both.

## Connects to

- [[concepts/Core Operating Ethos]] — "anticipate the next failure," the pillar this doctrine instantiates for code review
- [[concepts/Three Rules]] — Rule 1 (verify before you claim) is the underlying discipline
- [[concepts/Engineering Judgment Doctrine]] §8 — the handoff test this doctrine enforces structurally rather than leaving to individual discipline
- [`/self-review`](../../skills/self-review/SKILL.md) — the concrete skill mechanism: spawn a reviewer subagent with specific verification questions
- [[concepts/Cost of Confidence]] — why an unverified "ship" claim is a trust-decay event
- [[concepts/Orchestration Lanes]] — the designated-pusher role sits at the seam between lanes: whichever lane produced the diff, the push still routes through one reviewed gate
- [[concepts/MAP]] — orientation hub, doctrine index
