---
title: Common Failure Modes
tags:
  - doctrine
  - corpus
  - debugging
  - longitudinal
aliases:
  - Failure Mode Corpus
  - Known Failure Patterns
created: 2026-04-27
---

# Common Failure Modes

> A growing corpus of how aigent-OS installs actually fail in the wild. Every confirmed failure caught by `/diagnose` becomes a Phase 1 entry. Every failure that recurs across sessions or principals becomes a Phase 2 pattern, which graduates to a permanent doctrine update.

The corpus lives at `vault/memory/FAILURE_MODES.md`. This note explains the doctrine.

## Why this exists

Most frameworks document **what should work**. aigent-OS does too — the system docs, the doctrine notes, the skills all describe intended behavior. What's usually missing is the inverse: **what actually breaks, by layer, with what symptom, with what fix.**

Without that data, every new failure looks novel. Every debugging session starts from zero. The framework can't harden against the failures it's actually had because there's no record of what they were.

The Common Failure Modes corpus closes that loop. Every time `/diagnose` produces a verified hypothesis (the layer + symptom matched the actual cause), the result is captured. Over months, the corpus becomes the framework's institutional memory of its own failure surface.

## The two phases

### Phase 1 — Single occurrence (auto-captured by `/diagnose`)

When `/diagnose` walks the seven-layer stack and identifies a verified cause, append to `FAILURE_MODES.md`:

```markdown
## YYYY-MM-DD — {short symptom name}

**Symptom (verbatim from principal):** "{their own words}"
**Layer responsible:** L{N} ({layer name})
**Specific cause:** {file/line/config that was the actual issue}
**Fix applied:** {what the principal or agent did}
**Time to diagnose:** {minutes from /diagnose start to verified cause}
**Pattern (one line):** {what category of failure this was}
```

Phase 1 entries are individual data points. Useful but not yet doctrine.

### Phase 2 — Recurring pattern (manual graduation)

When `/skill-audit` or `/retro` (v0.3) detects that the same Pattern line has appeared 3+ times, the failure mode graduates from Phase 1 (data) to Phase 2 (doctrine). At that point:

1. Promote the pattern to a named entry in this note (the doctrine note, not just the corpus)
2. Update the relevant skill's SKILL.md to surface the pattern proactively (e.g., `/diagnose` adds a "common patterns to check first" section)
3. If the pattern indicates a kernel-level fragility, propose a kernel patch via `system/CHANGELOG.md`

## Recurring patterns (graduated from corpus)

This section is empty at v0.2.2 release. As the corpus accumulates and patterns repeat, they get promoted here with full descriptions.

The format for each graduated pattern:

```markdown
### {Pattern name}

**First observed:** YYYY-MM-DD
**Times observed:** N
**Layers involved:** L{N}, L{M}
**Typical symptom:** {how it usually presents}
**Diagnostic shortcut:** {what to check first when this pattern is suspected}
**Permanent fix or hardening:** {if there's a structural fix that prevents recurrence}
**Related doctrine:** {wikilinks}
```

## What this corpus is NOT

- **Not a bug tracker.** Bugs are reported and closed; failure modes accumulate as institutional memory. A bug fix doesn't delete the failure mode entry; it adds a "permanently fixed at vN.M" annotation.
- **Not a substitute for /diagnose.** /diagnose runs in real-time; the corpus runs longitudinally. Both are needed.
- **Not adversarial.** This is debugging data, not a list of complaints about the framework.

## Why this is novel

Most agent frameworks have:
- Documentation of intended behavior ✓
- Issue trackers for individual bugs ✓
- Test suites that exercise expected behavior ✓

Almost none have:
- A structured corpus of how the framework actually fails ✗
- Pattern detection that surfaces recurring failures ✗
- Doctrine updates triggered by accumulated failure data ✗

aigent-OS does this because the [[Bio-hacking Posture]] demands measurement. The framework can't get sharper if it doesn't know how it dulls.

## How this corpus matures

Three milestones:

**Month 1-3:** Phase 1 entries accumulate. No patterns yet visible. Corpus is just data.

**Month 3-6:** First Phase 2 graduations. The most common failure modes get named. `/diagnose` starts surfacing them as candidates earlier in the layer walk.

**Month 6+:** The corpus becomes institutional memory. New principals reading aigent-OS see not just "how it works" but "how it commonly fails and how to recognize each pattern in 30 seconds."

## Connects to

- [[The Seven Layers]] — every Phase 1 entry is tagged by layer
- `/diagnose` skill — the auto-capture mechanism
- [[Cost of Confidence]] — sister corpus tracking confident-but-wrong claims (different failure surface)
- [[Bio-hacking Posture]] — the meta-doctrine that demands measurement
- `/system-check` — should eventually surface "your install has hit Pattern X 3 times; here's the proactive hardening"
- `vault/memory/FAILURE_MODES.md` — the corpus file itself
