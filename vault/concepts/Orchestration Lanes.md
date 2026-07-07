---
title: Orchestration Lanes
tags:
  - doctrine
  - agents
  - orchestration
  - delegation
aliases:
  - Agent Orchestration Lanes
  - Lane Routing
  - Delegation Lanes
created: 2026-07-07
---

# Orchestration Lanes

> [!abstract] One-line principle
> Three lanes for getting work done with agents. Pick exactly one per task, and say out loud which one you picked before you start.

---

## The three lanes

### 1. Standing collaborative team

A small team of 2-4 agents alive together for the duration of a build, each with a distinct role (e.g. one builds, one designs, one critiques), coordinating in real time rather than handing off in sequence. Use this when a task genuinely benefits from multiple perspectives staying in the loop as the work evolves — a build where design and implementation need to negotiate mid-task, or where a critic catching a bad assumption early saves a full rebuild later.

**Constraints:**
- Keep it small — 2-4 agents. Past that, coordination overhead exceeds the benefit of more eyes.
- **One git worktree per team, always.** Two concurrent teams sharing a working tree will step on each other's uncommitted changes — one team's in-progress edits get swept into the other's commit. This is not a hypothetical risk; it is the single most expensive failure mode this lane produces if skipped.
- The team disbands on task completion. It is not a standing organizational structure — it exists for the duration of the build.

### 2. One-shot fan-out subagents

Independent, parallel dispatches for read-only or verification work: reconnaissance sweeps across a codebase, a wide parallel search for prior art, a panel of verification passes checking the same change from different angles. Each subagent runs independently, returns a structured result, and is done — no peer-to-peer coordination between them.

**Constraints:**
- This lane is for fan-out, not fan-in collaboration. If the subagents need to talk to each other mid-task, you actually want lane 1.
- Cheap, wide, and disposable — this lane can scale to many parallel dispatches (recon sweeps, verify panels) because each one is independent and low-stakes to re-run.
- Route reads to the cheapest model tier that can do the job; escalate model tier only for the dispatches that reason and write, not the ones that just read and summarize.

### 3. Solo-inline

Do the work directly, without spawning any sub-agent at all. Use this for precision work where a second layer of indirection adds risk rather than removing it (delicate, order-sensitive edits), for trivial/mechanical changes where dispatch overhead exceeds the task itself, or for a task that's a straightforward rerun of an already-codified pipeline.

**Constraints:**
- Solo-inline is not "I didn't think about which lane to use" — it's a deliberate choice for a specific class of task (precision, triviality, or a codified rerun). If you're not sure which of the three applies, that uncertainty itself is a signal to slow down and pick deliberately.

## The anti-drift habit: declare the lane before you build

Before starting any substantive build (multi-file work, a new feature, a UI/design pass, a non-trivial pipeline run), **state out loud which lane you're using and why** — "standing up a small team for this" or "solo-inline: precision edit" or "fan-out for the recon sweep." This is not bureaucracy for its own sake; it exists because the choice of lane is easy to make invisibly by default (just start working in whatever mode is already open), and an invisible choice can't be corrected in the moment if it's the wrong one.

Declaring the lane costs one sentence. Not declaring it means the first sign anything went sideways is discovering, after the fact, that the wrong lane was used for the whole task — usually when someone asks "wait, why did three agents touch this file" or "why did this trivial fix take a whole standing team."

## Why exactly one lane, not a blend

Blending lanes — e.g., a standing team where one member also silently fans out sub-dispatches of its own, or solo-inline work that quietly spawns one helper "just this once" — reintroduces the coordination costs of the heavier lane without the discipline (declared roles, one worktree, explicit disband condition) that makes the heavier lane safe. Pick one lane per task. If the task's shape changes mid-flight enough to need a different lane, say so and switch deliberately, rather than layering a second lane on top of the first.

## Connects to

- [[concepts/Core Operating Ethos]] — "system, not a ticket queue": choosing the lane deliberately is part of treating delegation as a system decision, not a reflex
- [[concepts/Review Before Push]] — whichever lane produces a diff, the push still routes through one reviewed gate; the lane doesn't bypass the gate
- [[concepts/Lego Arsenal Doctrine]] — build-for-reuse applies inside any lane, most visibly the standing-team lane where multiple builds share components
- [[concepts/Engineering Judgment Doctrine]] — §10 (be a good guest) applies within a shared worktree especially
- `system/09_subagent_manifest.md` — criteria for when a new specialized agent is worth creating at all, upstream of which lane it runs in
- [[concepts/MAP]] — orientation hub, doctrine index
