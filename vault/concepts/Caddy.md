---
title: Caddy
tags:
  - doctrine
  - skills
  - meta
  - self-management
aliases:
  - Skill Router
  - Skill Catalog
  - Tool Discovery
  - Caddy Pattern
created: 2026-04-13
status: shipped
provenance: Original aigent-OS contribution. Designed and implemented by Will Gwyn (aigent-OS operator) on 2026-04-13. Not a port; not derived from prior work in the field. The pattern is offered to the broader agent-framework community via this public reference implementation.
---

# Caddy

> [!abstract] The skill caddy. A non-blocking UserPromptSubmit hook that matches the user's prompt against an indexed catalog of skills and surfaces `[CADDY] /X - why` hints for the tools that fit the task. Like a golf caddy — hands you the right club for the shot, never blocks the swing.

## Provenance

Caddy is original work, designed for aigent-OS by Will Gwyn (the operator) on 2026-04-13. It is not a port of an existing community pattern. This note documents both the doctrine and the reference implementation so other agent frameworks can adopt the pattern. See [[The Self-Management Layer]] for how Caddy fits into the broader pattern of a framework that maintains itself.

## The problem it solves

A typical AI framework collects skills faster than anyone uses them. You write a skill for code navigation, another for deep research, another for URL extraction — and three weeks later you're back to using `WebFetch`, `Grep`, and `WebSearch` because you forgot the specialized tools exist. The toolbox is visible but not **routed by intent**.

The standing rule "use `/graphify` for code navigation" exists. The principal forgets it mid-session and greps anyway. Static rules in `CLAUDE.md` rely on the AI reading and remembering them at the moment of task — which is exactly when its attention is elsewhere.

Caddy fixes this by **pushing** the right skill at the moment of task start.

## Architecture

Three components, all legibility-thesis-aligned (markdown + flat JSON, no opaque storage):

### 1. Skill catalog — vault-backed
Each skill carries triggers and a why-line, either in its `SKILL.md` frontmatter or in a vault-backed catalog note. Structured frontmatter:

```yaml
---
title: <skill-name>
triggers:
  - keyword1
  - "multi word phrase"
  - keyword3
why: "One-line value prop — shown in hints"
---
```

### 2. Compiled index
Location: `.claude/skill-index.json`

Flat JSON for fast router lookup:

```json
[
  {"name": "graphify", "triggers": ["my codebase", "navigate code"], "why": "Turn a codebase into a knowledge graph"}
]
```

Regenerated on demand or via the auto-enrollment daemon.

### 3. Router hook
Location: `daemons/caddy.sh`
Trigger: `UserPromptSubmit` in `.claude/settings.json`

On every user prompt:
1. Read the prompt JSON from stdin
2. Match prompt text against each skill's triggers
3. Score deterministically: multi-word trigger match = 3 points, single word boundary match = 1 point
4. If top score >= 2, emit `[CADDY] /<name> - <why>` to stdout
5. Silent if no strong match — never spams

Claude Code surfaces the hint as a system reminder alongside the user's prompt. Maximum 2 hints per prompt to preserve attention.

## Auto-enrollment — the golf bag stays complete

The system self-heals. When a new skill lands in any skills folder, it gets the same treatment the original catalog received:

1. **Inline enrollment** via `/skills-builder` — when the principal creates a skill, the final step is `/caddy-enroll <path>`. The skill reads the SKILL.md, extracts triggers + why, and appends to `.claude/skill-index.json`.

2. **Detection daemon** — `daemons/caddy-detect-new-skill.sh` runs on Write/Edit events. When it sees a `SKILL.md` not yet in the index, it emits a `[CADDY] New skill detected: X — run /caddy-enroll` nudge. Non-blocking.

3. **Manual** `/caddy-enroll <path>` — user-invocable. Reads target, extracts metadata, appends to index, tests with a representative prompt, reports.

The golf bag can't go stale. Every skill — added, copied from another principal, dropped in by a daemon — ends up in the index so Caddy can hand it over when the task arrives.

## Why non-blocking beats enforcement

This is the load-bearing design choice. See [[Suggestion Credibility]] for the full doctrine.

**Enforcement hooks** (PreToolUse blocks) generate error spam when they fire wrong. Users learn to ignore hook output because of false positives. The signal-to-noise ratio degrades over time until the hook is effectively dead.

**Advisory hooks** (Caddy) avoid this trap:
- **No errors** — the hint is text, not a block
- **No false-positive cost** — wrong suggestion = ignored, not frustrating
- **Composable** — two skills can match; both get surfaced
- **Discoverable** — the AI learns about skills it forgot existed

The asymmetry is the whole point: a wrong suggestion costs nothing, a right suggestion saves real time. The cost-benefit only inverts if the hint volume gets high enough to become noise — which is what the score-threshold-of-2 and max-2-suggestions guarantees prevent.

## The latency budget — 200ms

Caddy's `<200ms` latency budget is not aspirational; it's the constraint that makes "non-blocking" actually true. A 2-second router would feel like an interruption no matter how informative. The deterministic keyword matcher exists *because* of the latency budget — embeddings would be more robust but break the budget.

If the matcher ever moves to embeddings, the latency budget moves with it: the new implementation must clear `<200ms` p99 or it's not Caddy anymore.

## Compared to alternatives

| Approach | What it does | Why Caddy wins |
|---|---|---|
| Static routing table in CLAUDE.md | Lists which skill to use for which prompt class | Relies on AI reading and remembering mid-task |
| Embedding-based semantic search | Robust to phrasing variation | Latency cost breaks the non-blocking property |
| Enforcement hooks (PreToolUse blocks) | Forces correct tool use | Error spam destroys signal channel |
| LLM-routed (use a model to pick the skill) | Maximally flexible | Adds inference cost + latency on every prompt |
| Caddy (deterministic keyword match) | Surfaces hint, never blocks | Fast, legible, composable, advisory |

## Place in the seven-layer stack

Caddy lives across multiple layers ([[The Seven Layers]]):

- **Layer 2 (Skills)** — `skill-index.json` is in `.claude/`, individual skills in `skills/`, the enrollment skill is `/caddy-enroll`
- **Layer 3 (Hooks)** — the daemon is wired via UserPromptSubmit in `.claude/settings.json`
- **Layer 4 (Daemons)** — `daemons/caddy.sh` is the router, `daemons/caddy-detect-new-skill.sh` is auto-enrollment
- **Layer 6 (Doctrine)** — this note + [[Suggestion Credibility]] articulate the pattern

This cross-layer footprint is a feature, not a bug. Caddy can't be packaged as a single directory because the pattern only works when the layers cooperate. The index is data; the daemon is automation; the hook is integration; the doctrine is intent.

## Relationship to other patterns

| Pattern | Role | Relationship to Caddy |
|---------|------|------------------------|
| [[Self-Improving CLAUDE.md]] | Captures mistakes as permanent rules | Caddy surfaces those rules at the right moment |
| [[Suggestion Credibility]] | Doctrine: agent suggestions are a depleting trust resource | Why Caddy is non-blocking |
| [[The Self-Management Layer]] | Umbrella for framework-maintains-itself patterns | Caddy is the canonical member |
| [[Memory Decay Doctrine]] | Heat-weights notes for surfacing | Sister pattern at the vault layer |
| [[Skills Graduation Curve]] | The 5 / 15 / 30 / 50+ skill phases | Caddy is what makes phase 3+ tolerable |

## Future enhancements (preserve the non-blocking constraint)

- **`/caddy-explain`** — when a hint fires and the principal is confused why, walks the scoring transparently. Pairs with the legibility thesis. **Shipped in v0.2.1.**
- **`/caddy-mute`** — temporary suppression for flow protection. The principal's right to flow doesn't break the discipline of advisory behavior. **Shipped in v0.2.1.**
- **`/caddy-audit`** — quarterly. Walks the index vs the actual skill files; reports drift. **Shipped in v0.2.1.**
- **Session memory** — suppress already-used skills within a session (the principal who already ran `/graphify` doesn't need another reminder ten minutes later). Planned.
- **Latency monitoring** — weekly hook samples 100 invocations, reports p50/p95/p99, alerts if p99 exceeds 200ms. Planned.
- **Usage tracking** — log hint-followed-vs-ignored. Feeds `/skill-economics` (downstream measurement skill). Auto-tuning of trigger thresholds is *only* an option once the data exists; even then, propose-don't-apply — the index is principal-readable state. Planned for v0.3.

Each enhancement is a candidate for separate doctrine evaluation. None should ship if it breaks the non-blocking guarantee or the latency budget.

## What Caddy is NOT (and never should become)

- **Not enforcement.** The day Caddy starts blocking is the day it dies.
- **Not a chatbot.** Hints are deterministic text, not conversational responses.
- **Not opaque.** The scoring is inspectable; `/caddy-explain` makes it visible on demand.
- **Not autonomous.** Auto-tuning of triggers, if ever shipped, must propose changes for principal review.
- **Not slow.** The 200ms budget is load-bearing.

## Connects to

- [[Suggestion Credibility]] — the doctrine note that justifies the design
- [[The Self-Management Layer]] — the umbrella concept
- [[Self-Improving CLAUDE.md]] — companion pattern at the rules layer
- [[The Seven Layers]] — Caddy's cross-layer footprint
- [[Memory Decay Doctrine]] — sister pattern at the vault layer
- [[Skills Graduation Curve]] — why Caddy becomes essential at scale
- `/caddy-explain`, `/caddy-mute`, `/caddy-audit` — companion skills for inspection, flow protection, and hygiene
