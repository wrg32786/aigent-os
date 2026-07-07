---
title: Suggestion Credibility
tags:
  - doctrine
  - meta
  - advisory
  - constitutional
aliases:
  - Why Advisory Beats Enforcement
  - The Suggestion Trust Resource
  - Hint Doctrine
created: 2026-04-26
---

# Suggestion Credibility

> Agent suggestions are a depleting trust resource. Every false positive degrades the channel. Every silence preserved is credit retained. Once a suggestion channel is broken, it cannot be repaired by improving the suggestions — only by stopping the bad ones long enough for trust to regenerate.

This is the doctrine that justifies Caddy's design — and constrains every advisory system that follows it.

## The core principle

A suggestion is a request for the principal's attention. Unlike commands (which the principal asked for) and errors (which announce a failure that requires action), suggestions exist in a gray zone: they advise but don't compel. The principal can ignore them.

The cost of a suggestion is not the time it takes to read. The cost is the **degradation of attention budget for all future suggestions through the same channel**. A wrong suggestion teaches the principal to skim. A second wrong suggestion teaches them to skip. A third teaches them to filter out the channel entirely.

Once that filter is in place, even a *correct* suggestion through the same channel arrives at a closed gate.

## Why enforcement hooks rot

Enforcement hooks (PreToolUse blocks, validation gates, "this is required") generate error spam when they fire wrong. The user learns the pattern: the hook produces noise; ignore it.

This is observable in real systems:
- Linters with too-strict defaults get disabled
- Pre-commit hooks that block too aggressively get bypassed with `--no-verify`
- Notification systems with too many false positives get muted

The mechanism is the same in each case: the system treats every alert as equally important; the user learns that they aren't, and recalibrates by dropping them all.

## Why advisory hooks survive

Advisory hooks don't compete for the user's compliance — they compete for the user's attention.

The asymmetry is critical:
- **Right suggestion** → real value (principal saves time, finds the right tool, surfaces a forgotten capability)
- **Wrong suggestion** → near-zero cost (text the principal scans and ignores)

As long as the asymmetry holds, the channel stays alive. The channel only dies when the **wrong-suggestion rate × cost-per-wrong-suggestion** exceeds the **right-suggestion rate × value-per-right-suggestion**.

That ratio is what every threshold in an advisory system must protect.

## The four constraints

Any advisory system shaped like Caddy must satisfy all four:

### 1. Non-blocking
The suggestion is text the principal can scroll past. Never an error, never a modal, never an exit code. The moment a suggestion *requires* a response, it's no longer a suggestion — it's a gate, and the rules of enforcement apply.

### 2. Threshold > recall
A miss costs nothing. A false positive costs trust. Tune toward precision: better to surface fewer hints, all correct, than more hints with some wrong.

This is counter to most ML-style metrics work where recall is treated as primary. Suggestions invert it.

### 3. Latency budget
Slow advice is no longer advice — it's interruption. The principal who waits 2 seconds for a hint has already made a decision. The hint arrives as friction, not help.

For Caddy, the budget is `<200ms` p99. Any enhancement that breaks this loses the non-blocking property by accident.

### 4. Inspectability
The principal can ask "why did you suggest this?" and get a deterministic answer. Suggestions from opaque systems are harder to trust because the principal can't tell whether the system is working or hallucinating. Caddy's `/caddy-explain` walks the scoring; pair every advisory system with an equivalent.

## What this rules out

Patterns that violate the suggestion-credibility doctrine:

- **PreToolUse hooks that block** when "the principal might have meant something else." If the principal might have meant something else, *suggest* the alternative; don't block the action.
- **Notification streams that alert on every event** equally. Notifications are suggestions; the same depleting-trust mechanic applies.
- **Confidence-padded suggestions** ("you should consider…", "perhaps you might want to…"). These dilute the signal. A correct suggestion stated plainly is more useful than a hedged one.
- **Suggestions that demand justification** ("here's why I think you should…" before getting to the suggestion itself). The principal can ask `/caddy-explain` if they want the reasoning. Default to brief.
- **Auto-applied suggestions** that the principal has to undo. This is enforcement disguised as advice. If the system is going to act, it should declare itself an enforcer; otherwise it stays advisory.

## What this rules in

Patterns that respect the doctrine:

- **Caddy**, as canonically shipped: deterministic keyword match, score threshold, non-blocking hint emission, max 2 suggestions per prompt
- **Memory decay surfacing**: the heat index ranks notes; cold notes drop off; only hot ones surface at session start. Same advisory shape applied to vault content
- **Honesty ledger**: the AI volunteers what it noticed but didn't fix; the principal can act on it or not. Advisory, not blocking
- **Pipeline-suggest** (potential future skill): action-triggered cousin of Caddy. Same constraints, different trigger surface

## The threshold question

Every advisory system has to choose where to draw the suggest/silent line. The choice has consequences:

- **Too low** (suggest aggressively) → false positives → channel rots
- **Too high** (suggest rarely) → low value → principal stops checking the channel for new suggestions
- **Right** → suggestions earn their existence each time they surface

The right threshold is not a constant. It's a function of:
- The cost of a wrong suggestion (low if the suggestion is text in a margin; high if it's a popup)
- The value of a right suggestion (low if the principal would have figured it out anyway; high if it surfaces something forgotten)
- The frequency of relevant prompts (rare prompts can tolerate broader matches; frequent prompts need narrower)

Caddy's `score >= 2` threshold reflects all three. It's tuned for the case where the suggestion is a one-line `[CADDY] /X - why` hint (low cost), the value is "principal forgot a skill exists" (real but moderate value), and the prompt frequency is high (every user input).

A different advisory system in a different cost-value-frequency context would need a different threshold. The doctrine is the principle; the threshold is calibrated to context.

## Why this generalizes beyond Caddy

The principle applies to any system that emits suggestions to a human or another agent:

- **IDE auto-suggest** that's too noisy gets disabled. Tune for precision.
- **Code review bots** that comment on every diff get muted. Tune for substance.
- **Slack notification rules** that fire too often get filtered. Tune for relevance.
- **Agent recommendations** to a principal ("you should consider…") that miss too often get ignored. Tune for credibility.

The suggestion-credibility doctrine is what makes the difference between a useful advisory system and a noise generator.

## Connects to

- [[Caddy]] — the canonical implementation
- [[The Self-Management Layer]] — the umbrella for framework-maintains-itself patterns, all of which apply this doctrine
- [[Legibility Thesis]] — suggestions must be readable, not opaque
- [[Three Rules]] Rule 3 — "tell the truth about what you don't know" applies here as: don't suggest things you're not confident about
- [[Negative Space Discipline]] — "doesn't ask permission for the obvious" is the agent-side application of the same principle
