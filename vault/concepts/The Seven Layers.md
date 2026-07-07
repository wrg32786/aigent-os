---
title: The Seven Layers
tags:
  - doctrine
  - architecture
  - stack
aliases:
  - aigent-OS Architecture
  - The Stack
  - Seven-Layer Architecture
created: 2026-04-26
---

# The Seven Layers

The AIgent's internal architecture has been implicitly seven-layered since v0.1. This note makes it explicit so debugging, contributing, and tuning have a shared vocabulary.

Pairs with [`/diagnose`](../../skills/diagnose/SKILL.md), which walks these layers when something feels off.

## The stack

```
   Layer 7 — Principal Configuration
         ↑
   Layer 6 — Doctrine (vault/concepts/)
         ↑
   Layer 5 — Vault Content
         ↑
   Layer 4 — Daemons
         ↑
   Layer 3 — Hooks
         ↑
   Layer 2 — Skills
         ↑
   Layer 1 — Kernel
```

Each layer sits on top of the one below it. The bottom layer is the most stable; the top is the most personal.

---

## Layer 1 — Kernel

**What it is:** The 15 numbered system documents (`system/00_identity.md` through `system/14_decision_framework.md`) plus extended specs.

**What belongs here:** The constitutional framework. How the AI thinks, decides, delegates, remembers. Authority matrix. Decision frameworks.

**What doesn't:** Project-specific facts. People. Tools. Anything that varies between principals.

**Failure signature:** AI's behavior is fundamentally wrong (off-mission, ignores authority gates, gives advice when it should ask). Kernel issues are rare but high-blast-radius — they affect every session.

**How to debug:** Read `system/00_identity.md` and `CLAUDE.md`. Did they load? Are they still consistent with what you've authorized?

---

## Layer 2 — Skills

**What it is:** Slash-commandable workflows in `skills/<name>/SKILL.md`. Plus the `.claude/skill-index.json` that powers Caddy.

**What belongs here:** Repeatable workflows the principal would otherwise re-derive each time. Recon procedures. Decision frameworks applied to specific contexts. Communication protocols.

**What doesn't:** One-off scripts (use a hook). Doctrine that isn't actionable (use Layer 6). Anything that's just "the AI doing its job" (don't codify it).

**Failure signature:** Wrong skill firing, no skill firing when one should, dead skills surfacing as Caddy hints. Symptoms tend to be "the AI didn't use the right tool."

**How to debug:** Run `/skill-audit`. Check if trigger keywords match the principal's actual phrasing. Check if skill description still matches what the skill does.

---

## Layer 3 — Hooks

**What it is:** Shell scripts in `hooks/` that fire on Claude Code events (PreToolUse, PostToolUse, UserPromptSubmit, Stop). Configured in `.claude/settings.json`.

**What belongs here:** Automated behavior that must happen on every relevant event. Auto-capture, security scanning, prompt-injection defense, Caddy hint surfacing.

**What doesn't:** Anything user-invokable (use a skill). Anything that runs once or rarely (use a daemon).

**Failure signature:** Automated behavior stopped happening. Caddy stopped surfacing hints. Auto-capture stopped writing to daily notes.

**How to debug:** Check `.claude/settings.json` is wired. Check hook scripts exist and are executable. Check the principal didn't disable hooks via flag or env var.

---

## Layer 4 — Daemons

**What it is:** Long-running or scheduled processes in `daemons/`. Heat-index compute. Semantic-search embedding. Caddy reindex on new skill detection.

**What belongs here:** Maintenance work that runs without principal involvement on a cadence. Index rebuilds. Background sync. Periodic computation.

**What doesn't:** Anything that needs to happen synchronously with a user action (use a hook). One-time tasks (use a skill or a script).

**Failure signature:** Stale data — search returns old results, heat index doesn't reflect recent reads, Caddy doesn't see a new skill.

**How to debug:** Check daemon last-run timestamp. Run the daemon manually. Check the daemon's output log for errors.

---

## Layer 5 — Vault Content

**What it is:** The markdown brain. `vault/projects/`, `vault/people/`, `vault/concepts/`, `vault/memory/`, `vault/daily/`. Everything the AI knows about the principal's current work.

**What belongs here:** Project state, people facts, decisions made, daily session notes, captured learnings, memory MOCs.

**What doesn't:** Doctrine notes (those go in `concepts/` but conceptually they're Layer 6 — the rules, not the facts). Skills (Layer 2). System prompt (Layer 1).

**Failure signature:** "AI doesn't know about X." `/open` missed Y. Wikilinks resolve to non-existent notes.

**How to debug:** Run `/system-check` Tier 4. Search the vault for the missing fact. Check the heat index — was the relevant note cold and not surfaced at `/open`?

---

## Layer 6 — Doctrine

**What it is:** The rules of how the AI should behave, captured in `vault/concepts/`. Standing rules. Verification doctrine. Negative space discipline. The bio-hacking posture itself.

**What belongs here:** Principles that should fire across many sessions and many projects. Things that emerged from corrections and got generalized.

**What doesn't:** Project-specific rules (Layer 5 vault content). System-prompt-level constitutional framing (Layer 1 kernel).

**Failure signature:** AI behavior changed without you having edited the kernel. A standing rule that should be firing isn't. New doctrine note isn't being applied.

**How to debug:** Check `vault/concepts/` for recently edited notes. Check whether the doctrine note is wikilinked from places the AI loads (CLAUDE.md, MOC files, frequently-read concept notes).

---

## Layer 7 — Principal Configuration

**What it is:** The principal-specific facts and preferences. `system/00_identity.md` customized. `system/14_decision_framework.md` reflecting how this principal makes decisions. The contents of `vault/projects/` and `vault/people/`.

**What belongs here:** Anything that varies between principals using the same kernel. Your projects. Your people. Your priorities. Your decision style.

**What doesn't:** The framework's behavior (Layers 1-4). The doctrine the framework applies (Layer 6).

**Failure signature:** AI gives generic advice instead of context-aware advice. Misses your specific situation. Surfaces things that aren't priorities.

**How to debug:** Check `system/00_identity.md` is customized (no "Replace this section…"). Check `system/14_decision_framework.md` reflects current priorities. Check `vault/projects/` and `vault/people/` are populated.

---

## Caddy as a cross-layer member

[[Caddy]] is the canonical example of a system that lives across multiple layers — not contained to one. Specifically:

- **Layer 2 (Skills)** — `.claude/skill-index.json` and `/caddy-enroll` skill
- **Layer 3 (Hooks)** — UserPromptSubmit hook wired in `.claude/settings.json`
- **Layer 4 (Daemons)** — `daemons/caddy.sh` (the router) and `daemons/caddy-detect-new-skill.sh` (auto-enrollment)
- **Layer 6 (Doctrine)** — [[Caddy]], [[Suggestion Credibility]], [[The Self-Management Layer]]

This cross-layer footprint is a *feature*. Caddy can't be packaged as a single directory because the pattern only works when the layers cooperate: the index is data (L2), the daemon is automation (L4), the hook is integration (L3), the doctrine is intent (L6). Future contributors should expect cross-layer systems and not try to flatten them.

When debugging anything Caddy-related (use `/diagnose` + `/caddy-explain` + `/caddy-audit`), check all four layers Caddy touches, not just one.

---

## How layers interact

The lower layers serve the higher ones. The kernel (L1) defines the framework's identity; skills (L2) execute on top of that identity; hooks (L3) automate skill invocation; daemons (L4) maintain the data skills operate on; vault (L5) is the data; doctrine (L6) is the rules the data is interpreted under; principal config (L7) is what makes the framework yours.

When something fails, the failing layer is usually higher than the one you'd guess. New users blame the kernel ("the AIgent is broken!"); experienced users start at the principal config and work down ("did I forget to populate my projects?"). Most failures sit in Layers 5-7.

## Connects to

- [`/diagnose`](../../skills/diagnose/SKILL.md) — walks these layers when symptoms surface
- [`/system-check`](../../skills/system-check/SKILL.md) — verifies install integrity layer-by-layer
- [[Bio-hacking Posture]] — the "stacks" category in the bio-hacking categorization
- [[Modern AI Infrastructure Stack]] — the AIgent's seven layers are distinct from external infrastructure layers; that note covers the latter
