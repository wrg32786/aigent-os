---
title: "Ponytail Doctrine"
tags:
  - doctrine
  - engineering
  - minimalism
  - agents
aliases:
  - Ponytail
  - The Rung Ladder
  - Anti-Over-Engineering
created: 2026-07-26
---

# Ponytail Doctrine

> [!abstract] Source
> Adapted from [ponytail](https://github.com/DietrichGebert/ponytail). Adopted as a standing operating rule after a night lost to patching scaffolding that should have been deleted.

[[concepts/Engineering Judgment Doctrine]] tells you **how to build well**. This note tells you **whether to build at all, and how little**. They are companions: run this ladder first, then apply engineering judgment to whatever survives it.

---

## The Compressed Essence

> **Stop at the first rung that holds. Write only what the task needs.**

---

## The Ladder

Before writing any code, walk these in order and **stop at the first rung that holds**:

1. **Does this need to exist?** → skip it
2. **Already in this codebase?** → reuse it
3. **Does the standard library do it?** → use it
4. **Is it a native platform feature?** → use it
5. **Is it in an already-installed dependency?** → use it
6. **Is it one line?** → write the one line
7. **Only then:** write the minimum that works

Most agent over-engineering happens because rungs 1 and 2 get skipped. An agent that starts at rung 7 will always produce something that works and is three times larger than it needed to be.

---

## The Rule Is Not "Fewest Tokens"

It is **write only what the task needs**. Code ends up small because it is necessary, not because it was golfed. Do not compress a clear ten-line function into an unreadable three-line one and call that Ponytail — that is rung 7 done badly, and it fails the handoff test in [[concepts/Engineering Judgment Doctrine]] §8.

## Lazy, Not Negligent

Never on the chopping block, at any rung:

- Trust-boundary validation
- Data-loss handling
- Security controls
- Accessibility
- Error propagation — a swallowed error is not minimalism, it is a hidden defect

**Minimalism is the means. Safety is not negotiable.** An agent that removes a guard to hit a smaller diff has misunderstood this doctrine completely.

---

## Delete Scaffolding, Do Not Patch It

When something is broken, the instinct is to add a layer that compensates for the breakage. That layer then needs its own compensating layer. This is how a tower gets built on top of a bug.

**Ask: is this structure defending a defect I could simply fix?** If yes, fix the defect and delete the structure. Do not add a rung to the tower.

The cautionary case this doctrine exists to prevent: a session lifecycle grew a nonce, a receipt, a landing-watch, a pointer, and a definition-hash — five mechanisms, every one of them scaffolding erected to defend a single broken message channel. The correct move was one fix to the channel and deletion of all five. Instead a full night went into patching the tower: a reordering fix regressed six invariants, which produced a deduplication state machine, which failed eight tests, which sent the coding agent into a loop. The eventual resolution was delete-and-replace with a simple handshake.

Rung 1 would have caught it before the first line.

---

## It Applies to Process, Not Just Code

The ladder governs how work is organised, not only what gets written:

- Do not spin up a fleet of agents for a deletion-heavy fix.
- Do not build a monitoring tower for a channel you could repair.
- Do not add a review stage to catch a class of error you could make structurally impossible.
- Do not escalate a decision you are equipped to make. Solve it.

An orchestration layer is code too, and it obeys the same rungs.

---

## How to Apply

**Every build, fix, refactor, and dispatch starts at rung 1.** State which rung you stopped at and why, in the brief or the commit body. "Stopped at rung 2 — the retry helper already exists in `lib/http`" is a complete justification. Silence about the ladder means it was not run.

For any agent that writes code, rungs **1, 2, and 6** are the minimum three checks before touching a file.

When a task looks like it needs new infrastructure, the burden is on the new infrastructure. Argue it past rung 1 explicitly, or do not build it.

---

## Related

- [[concepts/Engineering Judgment Doctrine]] — how to build well, once the ladder says build
- [[concepts/Core Operating Ethos]] — the operating pillars this ladder serves
- [[concepts/Common Anti-Patterns]] — scope creep and survey-instead-of-action, the behavioural cousins
- [[concepts/Lego Arsenal Doctrine]] — reuse over rebuild, rung 2 at the ecosystem level
- [[concepts/MAP]] — orientation hub, doctrine index
