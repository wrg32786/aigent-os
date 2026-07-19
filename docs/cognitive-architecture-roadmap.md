---
title: Cognitive Architecture Roadmap
tags: [aigent-os, cognitive-layer, self-improvement, roadmap, session-40]
aliases: [cognitive-layer, S40-roadmap, aigent-consciousness]
created: 2026-05-08
---

# Cognitive Architecture Roadmap

> [!abstract]
> Three-session plan (S40–S42) to give the AIgent a functional cognitive layer: persistent self-model, structured beliefs, lesson capture, and a /dream improvement loop. Not a metaphor — runtime files that compute and update across sessions.

## What Was Built in S39

S39 shipped the infrastructure layer that S40 builds on top of:

- **[[concepts/Skill Taxonomy]]** — 64 skills indexed with multi-word triggers, categories, and fallback chains
- **[[concepts/Self-Learning Doctrine]]** — classify → artifact → prevent recurrence pipeline; /learn-from-failure skill
- **[[concepts/Temporal Fact Ledger]]** — facts.jsonl with provenance + supersede chains; 10 seed facts
- **Caddy upgrade** — trigger-phrase matching + taxonomy fallback, catches skills missed by either alone
- **Capsule v2** — resumable execution state across sessions
- **aigent-OS sanitization** — vault synced to public repo with zero personal path leakage
- **SVG README** — visual identity for public repo, 14px+ font floor locked in after iteration

## S40 Deliverables (This Session)

The cognitive data layer — files that encode what the AIgent knows about itself:

| File | Purpose |
|------|---------|
| `memory/runtime/SELF_MODEL.json` | Capabilities, limitations, failure modes, authority boundaries |
| `memory/runtime/GOAL_STACK.json` | Active/paused/blocked goals with success criteria and blockers |
| `memory/runtime/BELIEF_STATE.jsonl` | Uncertain assumptions with confidence scores and source provenance |
| `memory/runtime/LESSONS.jsonl` | Positive learnings — what worked and when to apply it |
| `memory/runtime/PROCEDURES.jsonl` | Reusable step-by-step workflows crystallized from experience |

These files are **computed, not hand-authored** going forward. `/resume` reads them; `/context-capsule` updates them (both usually fire automatically — see [[docs/two-verb-lifecycle]]). Manual pre-population provides the seed state — battle testing fills them out.

## S41 Deliverables (Next Session)

The active reconciliation and dreaming layer:

- **`/reconcile` skill** — diff GOAL_STACK against SESSION_LOG + ACTIVE_PRIORITIES. Surface stale goals, completed goals not yet closed, new goals implied by recent sessions. Output: suggested edits to GOAL_STACK.
- **`/dream` skill** — reads SELF_MODEL + LESSONS + FAILURE_MODES + BELIEF_STATE, generates 3–5 ranked improvement candidates. Each candidate: what to improve, how confident, what evidence, proposed experiment. Feeds into the operator's review queue before any action.
- **Learning scorecard** — `/agent-fitness`-style ledger but for the AIgent's own self-improvement loop. Tracks: beliefs updated, lessons added, procedures crystallized, failures captured, skill recalls fired. Rolling 30-day window.

> [!info] Design constraint
> /dream is generative, not executive. It proposes; the operator approves. No self-modification without human gate. This is the Level 2 authority boundary applied to the AIgent's own capability surface.

## S42 Deliverables (Two Sessions Out)

The meta layer — the AIgent reflecting on its own improvement process:

- **Meta-aigent-OS review** — quarterly (or triggered) audit of the self-improvement loop itself. Is /dream generating good candidates? Are LESSONS actually reducing failure recurrence? Is BELIEF_STATE converging or drifting?
- **Improvement candidate eval harness** — lightweight framework to run proposed improvements as experiments and measure outcome. Based on [[concepts/Self-Learning Doctrine]] failure/success classification.
- **SELF_MODEL auto-update** — on `/context-capsule`, diff recent session for new capabilities demonstrated, new failure modes encountered, authority boundary tests. Append to SELF_MODEL with session provenance.

## The 4-Level Learning Stack

The AIgent's cognition is layered by abstraction:

```
Level 1: Facts          — facts.jsonl           What is true about the world
Level 2: Procedures     — PROCEDURES.jsonl       How to do recurring tasks
Level 3: Strategies     — SELF_MODEL + LESSONS   When to apply which approach
Level 4: Self-mod       — /dream + /reconcile    How to improve the system itself
```

Each level feeds up. Repeated facts become procedure candidates. Repeated procedures become strategies. Strategies that work become self-model entries. Strategies that fail go to FAILURE_MODES.

The `/learn-from-failure` skill operates at Level 1–2. `/dream` operates at Level 3–4. Manual `/context-capsule` captures are the primary input to Level 1.

## Banked Concepts (Not Building Yet)

These are architecturally interesting but don't have a clear forcing function yet:

- **Global Workspace Theory** (Baars) — broadcast model where attended information becomes globally available to specialized modules. The AIgent analog: ACTIVE_STATE as broadcast layer, skills as modules. Deferred until module count justifies the overhead.
- **Predictive Processing** (Friston) — belief updating via prediction error minimization. The BELIEF_STATE confidence scores are a crude analog. A full implementation would track prediction accuracy over time and decay stale beliefs automatically. Queued for S43+.
- **Working memory capacity model** — The AIgent's context window IS its working memory. The capsule system is an external memory extension. The interesting question is what to pre-load vs. lazy-load on demand. Queued for capsule v3 design.
- **Metacognitive monitoring** — knowing what you don't know. The BELIEF_STATE uncertain flags are a start. A fuller implementation would track "I said I'd check X and never did" loops. Queued.

## Research Queue (For Newton)

Topics that need investigation before building:

1. **Belief revision algorithms** — what's the best lightweight approach to updating confidence scores based on new evidence? Bayesian update vs. decay function vs. manual override? Find prior art in agent memory systems.
2. **Goal hierarchy literature** — how do production agent systems (AutoGPT, etc.) handle goal decomposition, suspension, and reactivation? What failure modes have they hit?
3. **Procedure extraction from transcripts** — is there a reliable pattern for auto-extracting reusable procedures from session transcripts? Any Claude-native approaches?
4. **Self-model accuracy** — how do you validate that an AI's self-model is accurate? What's the experimental design for testing "the AIgent thinks it can do X, can it actually do X reliably?"

## Related Doctrine

- [[concepts/Self-Learning Doctrine]] — failure capture pipeline, /learn-from-failure skill
- [[concepts/Temporal Fact Ledger]] — facts.jsonl schema, provenance model, supersede chains
- [[concepts/Skill Taxonomy]] — 130+ skill index, multi-word trigger routing
- [[concepts/Somatic Layer]] — body-check, capsule, digest organs; v0.4.x track
- [[concepts/Somatic v0.5.0 Agent Fitness]] — per-dispatch ledger, calibration ratios
- [[agents/Pantheon]] — full instrument roster, routing rules
- [[feedback/Model routing discipline]] — haiku/sonnet/opus routing matrix
- [[feedback/Silent successes hide failures]] — daemon error logging discipline
- [[aigent_authority_matrix]] — Level 1/2/3 authority boundaries
