---
title: Auto-skill from recurring task
tags:
  - concept
  - feature-spec
  - skills
  - self-evolving
  - queued
aliases:
  - auto-skill
  - recurring-task crystallization
  - skill auto-promotion
created: 2026-05-02
status: queued
---

# Auto-skill from recurring task

> [!abstract] What it is
> When the AIgent executes a multi-step task pattern more than N times, auto-promote the pattern into a reusable skill. First time: figure it out. Subsequent times: one-line invoke. Inspired by [[GenericAgent]]'s self-evolution mechanism + gstack's learnings system.

## Why

Concrete observation from a single session — recurring task shapes that fired 3+ times in one session:

| Task pattern | Fires per session |
|---|---|
| Defuddle a GitHub README → categorize port/spike/skip | ~10 |
| Bank an external tool as concept note + MEMORY index + queue update | ~6 |
| Spike-test (install + run + verdict + concept note) | ~3 |
| Caddy enrollment (edit caddy.sh + test fire + add to feedback note) | ~3 |
| Dispatch a builder agent with detailed multi-artifact brief | ~5 |

Each pattern has a recipe the AIgent re-derived from scratch each time. With auto-skill, the second invocation costs a fraction of the first.

## Three implementation options

### Option A — manual save after success

After a successful multi-step execution, the AIgent prompts: "save this as a skill?" User says yes, captures the recipe. Lowest friction, highest curation quality, requires user-in-loop.

### Option B — pattern detection at /close (recommended MVP)

At session /close, scan the transcript for command/tool-call sequences that fired ≥3 times. Surface candidates: "pattern X fired N times across N sessions — promote to skill?" User says promote / skip. Promoted skills land in `~/.claude/skills/auto/<name>/SKILL.md`. Lower friction than A (batched at /close, not interrupting work). Human-in-loop for promotion = no skill-library pollution from bad recipes.

### Option C — full auto (GenericAgent pattern)

Every multi-step task auto-saves to `~/.claude/skills/auto/`. Next invocation checks auto-skills first before re-deriving. Most powerful, highest risk — bad recipes accumulate without curation.

**Recommendation: ship Option B as MVP.** Option A is too manual; Option C is too risky for a vault that compounds over months.

## What the MVP actually needs

1. **Pattern detector** — scans session transcript at /close. Looks for repeated tool-call sequences (3+ fires) with similar inputs. Builds a candidate list with: pattern signature, fire count, exemplar inputs/outputs.
2. **Promotion UI** — surfaces candidates in /close output. User picks promote / skip / archive.
3. **Skill writer** — for promoted candidates, writes `~/.claude/skills/auto/<name>/SKILL.md` with a templated body: trigger description, recipe, expected inputs, sample invocation. Auto-enrolls in `.claude/skill-index.json` for Caddy.
4. **Cross-session counter** — patterns that fire ≥3 times in ONE session = obvious candidate. Patterns that fire ≥5 times across multiple sessions = also surface (long-tail recurring work). Counter lives in `memory/AUTO_SKILL_TRACKER.md` similar to [[memory/REMINDB_VALIDATION]].

## Sequencing

This benefits hugely from a **session-transcript watcher** (already banked from [[MOM Memory]]). Without auto-capture of session transcripts, pattern detection at /close has to scan in-context, which is fragile.

Right sequence:
1. **Phase 1 (prereq):** session-transcript watcher (MOM-pattern). Auto-captures every tool call to a queryable log.
2. **Phase 2:** pattern detector that runs against the watcher output (not in-session).
3. **Phase 3:** promotion UI in /close.
4. **Phase 4:** skill writer + auto-enrollment.

Skip ahead to phase 3 only is possible (in-session scan), but loses cross-session counter.

## Cross-references with existing the AIgent systems

- **[[GenericAgent]]** — prior art for the self-evolution mechanism. Their skill-tree pattern is the Option C version.
- **[[Gstack Port]]** — gstack's "learnings" system was stripped during port. Worth revisiting if auto-skill ships.
- **[[Pantheon]]** — auto-skills should be tagged by which Pantheon agent owns them. Scout recurring patterns ≠ builder recurring patterns.
- **[[MOM Memory]]** — session-transcript watcher = the prereq.
- **[[remindb]]** — could store auto-skill metadata in the MCP tree alongside vault content.
- **[[Lego Arsenal Doctrine]]** — every successful auto-skill is another Lego in the arsenal. Reusable across clients.

## Risks

- **Skill library pollution** — Option C without curation accumulates bad recipes. Option B mitigates via human-in-loop.
- **Pattern over-fitting** — a sequence that fires 3 times in one session might be situational, not durable. Cross-session counter (≥5 across multiple sessions) catches this.
- **Skill name collisions** — auto-named skills could clash with manually-curated ones. Solution: prefix with `auto/` in skill-index.json.
- **Stale skills** — auto-skills go stale faster than manually-curated. /lint extension: flag auto-skills not invoked in 90+ days.

## Adoptions from prior art

- **L4 archive layer** (from [[GenericAgent]]) — auto-skills that haven't fired in 90+ days don't disappear; they decay into a `memory/SKILL_ARCHIVE/` layer that remains queryable via [[remindb]] FTS5. Same pattern as [[Memory Decay Doctrine]] applied to procedural memory.
- **Procedural-memory framing** (from [[Hermes Agent]]) — auto-skills are explicitly procedural memory ("knowing HOW"), distinct from vault declarative memory ("knowing THAT"). The detector at /close looks for procedural recurring patterns (tool-call sequences), not declarative content (concept-note creation, which is captured by [[LLM Wiki Pattern]] ingest already).

## Status

**QUEUED.** No prereqs done yet. Sequenced after MOM-style watcher (currently bookmarked, no spike). Honest read: this is a multi-week build, not a session task. Bookmark it; revisit when:

- The vault has been running long enough that recurring-pattern fatigue is concrete
- Session-transcript watcher prereq is built
- A specific recurring task is painful enough to motivate the work

## Related

- [[GenericAgent]] — crystallization loop prior art + L4 archive layer
- [[Hermes Agent]] — procedural-memory framing
- [[MOM Memory]]
- [[Gstack Port]]
- [[Pantheon]]
- [[remindb]]
- [[Lego Arsenal Doctrine]]
- [[LLM Wiki Pattern]]
- [[Memory Decay Doctrine]]
- [[memory/REMINDB_VALIDATION]] (model for the AUTO_SKILL_TRACKER ledger)
