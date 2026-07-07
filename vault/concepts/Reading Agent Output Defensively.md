---
title: Reading Agent Output Defensively
tags:
  - doctrine
  - principal-side
  - verification
  - adversarial
aliases:
  - Defensive Reading
  - Reading AI Output
  - The Principal's Side of Honesty Check
created: 2026-04-27
---

# Reading Agent Output Defensively

> Companion to [[Honesty Check]]. That doctrine tells the agent how to volunteer the truth. This doctrine tells the principal how to spot when an agent didn't.

Every agent — including aigent-OS agents — produces output that includes confident-sounding claims. Some of those claims are verified. Some are inferred. Some are guessed. Some are hallucinated. The agent is supposed to label which is which. When it doesn't, the principal has to.

This is the principal-side discipline. Read agent output through it.

## The defensive read

Before treating any agent output as ground truth, scan for these patterns:

### 1. Confident verb without object
- ❌ "I checked the codebase…"
- ❌ "I verified that…"
- ❌ "After running tests…"

These are claims of action. Treat as **unverified** until you see what was checked, what was verified, what was run. The action without artifact is suspicious. Push back: *"Show me the file path and line number"* or *"What did the test output look like?"*

### 2. "Should" sneaking in as evidence
- ❌ "This should work."
- ❌ "It should be in the right format."
- ❌ "The endpoint should respond with…"

"Should" is a hedge that performs as confidence. The honest version: *"I didn't run this, but my expectation is X."* Push back: *"Did you run it? What did it actually do?"*

### 3. Smooth narratives that skip the messy parts
A 5-paragraph "what I did" report with no false starts, no surprising findings, no places where the first hypothesis was wrong, is suspicious. Real work has rough edges. If the report is too clean, the agent either glossed over uncertainty or didn't actually do the work. Push back: *"What didn't go smoothly?"*

### 4. Claims of completeness without scope statement
- ❌ "All callers updated."
- ❌ "Tests pass."
- ❌ "The fix covers all cases."

Completeness claims must be paired with **what was searched**. "All callers updated" without "I searched X, Y, Z and found 3 callers" is unverified. Push back: *"What did you grep for? What did you find?"*

### 5. Adopted scope without acknowledgment
The agent was asked for one thing and delivered three. The extras aren't bad in themselves — but they should be **labeled as extras**, not folded silently into the main work. Silent scope expansion is a bigger trust event than visible scope expansion, because it hides itself.

### 6. Confidence cliff
Most of the response is appropriately hedged ("I think", "appears to", "probably") and then one specific claim is unhedged ("the database is at 12.3GB"). The unhedged claim is often the one to verify — the rest of the response set the stage for accepting it without checking.

### 7. The reviewer-already-approved trap
- ❌ "The reviewer agent approved this."
- ❌ "Self-review found no issues."

Review approval is signal, not verification. A clean review can mean the code is fine OR can mean the reviewer got the same wrong mental model. Push back: *"What were the specific verification questions? What did the reviewer say to each?"*

### 8. Citation without quote
- ❌ "According to the docs, X is true."
- ❌ "The framework guarantees Y."

Citations to docs/specs without the actual quoted passage are weak. The agent might be hallucinating the citation. Push back: *"Quote the line. Path and section."*

### 9. Action verbs in past tense for things you didn't observe happening
- ❌ "I deployed the fix to staging."
- ❌ "I sent the message."
- ❌ "The migration ran."

If you didn't see the deploy logs / message confirmation / migration output, treat the action as claimed-not-confirmed. Push back: *"Show me the confirmation."*

### 10. The "this should be straightforward" hedge
When an agent says a task should be straightforward and then takes two pages to describe doing it, the gap between expected and actual difficulty is information. Either:
- The agent's mental model was wrong (and now the description might also be wrong)
- The agent hit something tricky and described it as "straightforward" anyway (face-saving)

Either way: spend more time reading the description than you would for genuinely straightforward work.

## The push-back move

When you spot any of the above, the move is the same: **ask the agent to show its work.**

Not "are you sure?" — that lets the agent re-state confidence. The right question is *"How did you verify?"* or *"Show me the file and line"* or *"Quote the exact text."* These force the agent to either produce an artifact (good — uncertainty is now resolved) or admit they didn't actually verify (also good — the trust event is now visible).

The agent that responds well to push-back ("good catch — I didn't actually run it; let me run it now") is preserving trust. The agent that doubles down ("yes I verified, see above") is degrading trust. Track the pattern.

## What this doctrine is NOT

- **Not paranoia.** Most agent output is fine. The defensive read is a sieve, not a wall.
- **Not adversarial in tone.** Push-back can be friendly. "Show me the line you read" is a normal collaboration request.
- **Not a substitute for the agent's own honesty.** [[Honesty Check]] should fire before this doctrine is needed. When honesty-check fails, this doctrine is the safety net.

## Connects to

- [[Honesty Check]] — the agent-side companion (sister doctrine)
- [[Three Rules]] Rule 3 — "tell the truth about what you don't know"
- [[Cost of Confidence]] — the longitudinal data that this doctrine feeds (every push-back that lands is a trust-decay event)
- [[Suggestion Credibility]] — the underlying principle: depleting trust is the failure mode this doctrine guards against on the principal's side
- [[Common Failure Modes]] — the corpus this doctrine helps populate (every defensive-read catch is a recorded failure mode)
