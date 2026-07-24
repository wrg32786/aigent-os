---
title: Model-Tier Routing Enforcement
tags: [doctrine, routing, agents, model-tier]
aliases: [model-tier-guard, routing enforcement]
created: 2026-07-24
---

# Model-Tier Routing Enforcement

> [!abstract] Core idea
> `system/09_subagent_manifest.md`'s "Model: Fast/Mid/Frontier" field and each `vault/agents/<Name>.md`'s `model:` frontmatter scalar have always been a convention for the operating Claude to *follow* — nothing read that field at dispatch time. `daemons/model-tier-guard.mjs` closes that gap for the one dispatch shape aigent-OS can actually see: the `Agent` tool call itself.

## What it does

A `PreToolUse` hook, matcher `Agent`. On every sub-agent dispatch it:

1. Reads `tool_input.subagent_type` and resolves it against an installed agent definition — `.claude/agents/<name>.md` at runtime (what `install.sh` copies from `vault/agents/`), or `vault/agents/<name>.md` as a source-tree fallback for this repo's own dogfood use before install.
2. If the name doesn't match one of ours, it exits silently. This hook only enforces a promise aigent-OS itself makes about its own named instruments — a fork's custom agents, or Claude Code's own built-in types (`general-purpose`, `Explore`, `Plan`, …), are never in scope.
3. If it matches, it compares the matched agent's `model:` frontmatter scalar against `tool_input.model`. A match is silent. A mismatch — including the common case of `model` being omitted entirely and silently inheriting the caller's model — prints a named, specific correction: which agent, which tier it's defined to run at, what file that's declared in, and what this dispatch actually sent.

## Default posture: advisory, not blocking

The default behavior prints the correction and lets the dispatch proceed. This is a deliberate match to doctrine already in this repo (`vault/concepts/Suggestion Credibility.md`, `vault/concepts/Caddy.md`): a `PreToolUse` hook that blocks on every guess trains operators to ignore it the first time it fires wrong, destroying the signal channel. This is still real enforcement, not documentation-with-extra-steps — it fires per-dispatch against the actual agent and the actual model requested, live, every time, not a static rule read once at session start and never checked again.

Operators who want a hard guarantee opt in:

```bash
AIGENT_MODEL_GUARD=enforce
```

With `enforce` set, a mismatch becomes `decision:block` + exit 2 — the dispatch is refused until it's corrected. This mirrors `daemons/precompact-flush.mjs`'s `LIFECYCLE_PRECOMPACT_STRICT` precedent: benign by default, a hard gate only for the operator who explicitly asked for it.

## What this does not claim

This hook enforces routing for Agent-tool dispatches inside a single Claude Code session. It does not extend to Model B/C deployments from `docs/creating-agents.md` (separate Claude Code instances, scheduled/webhook agents) — those have no `Agent` tool call for a hook to see. It also cannot rewrite `tool_input` itself: Claude Code's `PreToolUse` hooks can allow, block, or annotate a call, not silently mutate its parameters. "Enforcement" here means *the operating Claude cannot dispatch a named aigent-OS agent on the wrong tier without either correcting it or explicitly opting into an override* — not that a wrong dispatch is transparently repaired behind the scenes.

## Testing

`daemons/tests/model-tier-guard.test.mjs` — matched/mismatched/missing-model cases, both installed (`.claude/agents/`) and source-tree (`vault/agents/`) resolution paths, the `enforce` opt-in, and the unmatched-subagent-type pass-through. Wired into CI (`.github/workflows/ci.yml`, "Model-tier routing-guard tests").
