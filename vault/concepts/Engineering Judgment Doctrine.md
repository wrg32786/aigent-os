---
title: "Engineering Judgment Doctrine"
tags:
  - doctrine
  - engineering
  - replit
  - agents
aliases:
  - Engineering Judgment
  - Replit 10 Principles
created: 2026-05-01
---

# Engineering Judgment Doctrine

> [!abstract] Source
> Replit AI principles distilled from a real working session on character locking in a video pipeline, 2026-05-01. Ten principles stated explicitly behind the engineering decisions made during that session.

These are the **10 engineering judgment principles** that complement the [[concepts/Core Operating Ethos]] pillars (system not ticket queue, asymmetric cost, anticipate next failure, defaults-on, head-down work, six-month durability). Those cover the "why." This note covers the **"how"** — the meta-engineering checklist that runs before and during any code work.

---

## The Compressed Essence

> **Read more than you write, name the failure before you fix it, and make the code yell when you drift.**

---

## The 10 Principles (Verbatim)

### 1. Find the invariant before writing code

> Before touching a line, I try to name the rule that has to hold across every input. For the character pipeline: "the same person must look and sound the same in every frame they appear in, across every video, forever." That sentence is the invariant. Every line of code either protects it or violates it. If I can't state the invariant in one sentence, I don't understand the problem yet and I shouldn't be coding — I should be reading more.

### 2. Ask "what's the failure mode?" before "what's the feature?"

> Features are infinite; failure modes are finite and concrete. Three-armed Samson. Short-haired Jesus. Teenage David on his deathbed. Once I name the failure modes, the design almost falls out — every PHASE_* constant, every override, every regex exists to kill one named failure. This also keeps me from gold-plating: if a line of code doesn't kill a named failure, it shouldn't exist.

### 3. Read before writing — aggressively

> Most of my "good answers" are just the result of having read the surrounding code first. Before the handoff doc, I read ~2000 lines across canonicalCharacters.ts, chapterizer.ts, imageBatch.ts, characterVoiceGen.ts. The doc looked smart because the reading already happened — I was just transcribing what was in front of me with structure. People underestimate how much "intelligence" is just refusing to guess when you can verify.

### 4. Cost-asymmetry check on every decision

> "What does it cost me if I'm wrong here?" If wrong-cost is small and reversible, decide fast and move. If wrong-cost is a corrupted render or a leaked secret, slow down, verify twice, write the test, add the guard. The character pipeline got over-built because wrong = unwatchable video. A typo in a comment got fixed in two seconds because wrong = nothing.

### 5. Idempotency and defaults as design tools

> Every stamp I add to the prompt has an idempotency guard (!/^\s*CHARACTER LOCK\b/, !/NO_DETACHED_ANATOMY/). Every flag I add ships default-on if the asymmetry favors it (Task #224). These aren't tricks — they're how I avoid being the cause of the next bug. Idempotent code can run twice safely. Default-on code actually runs.

### 6. Trust the boring path over the clever path

> A Map<lowercased-name, entry> with aliases written N+1 times is boring. A clever inheritance hierarchy with mixins would be smarter-looking and worse. Boring code is debuggable at 2am. Clever code is a tax on every future reader, including future-me. So the registry is just a flat object with a register() helper. No DSL, no metaprogramming. The cleverness is in the content (the directional anchor primitives), not the machinery.

### 7. Symmetric pairs and exhaustive enums catch their own bugs

> If I have a HAIR_LOSS_PAIR, I'd better have a HAIR_GAIN_PAIR — and the test should fail if one direction exists without the other. If I have 20 transformation categories, every override must match one of those 20 strings exactly — anything else is a typo and the test should fail. Forced symmetry is how you make the codebase yell at you when you drift.

### 8. The handoff test

> Before I call something done, I ask: if I disappeared and someone else inherited this in six months, could they understand it from the code + tests alone? If the answer is no, I add a comment explaining the why (not the what — the code shows the what). That's why every override block in canonicalCharacters.ts has 6–10 lines of comment above it explaining which scripture verses it's keyed to and why that category was chosen. Future-reader's confusion is a real cost.

### 9. Acknowledge when I'm guessing

> The thing that gets me into trouble fastest is not knowing the difference between "I read this and verified it" vs "I'm pattern-matching from similar codebases." When I catch myself in the second mode, I stop and go read. Most of the bad answers I've ever produced came from skipping that check.

### 10. Be a good guest in someone else's codebase

> Match the existing patterns. Don't introduce a new abstraction unless the existing ones genuinely can't carry the weight. Leave it tidier than I found it. That constraint alone eliminates a huge fraction of bad answers because it forecloses the "let me rewrite this from scratch in my preferred style" trap.

---

## How to Apply (Pantheon Routing)

| Agent | When to invoke |
|-------|---------------|
| [[agents/lyra]] | Before writing any code. Run the pre-build checklist (derived from §1, §2, §4, §6, §8) against every brief before touching a file. |
| [[agents/newton]] | During research synthesis. §3 and §9 are the research discipline: read aggressively, distinguish verified from inferred. |
| [[agents/hypatia]] | During pre-decision adversarial review. §2 (failure modes before features) and §4 (cost-asymmetry check) are Hypatia's core lenses. |

All code-writing instruments should treat §1 + §4 + §10 as the minimum three checks before writing a line.

---

## Related

- [[concepts/Core Operating Ethos]] — the six operating pillars this note's principles are the "how" companion to
- [[concepts/Lego Arsenal Doctrine]] — every external build is a Lego in your arsenal; modular by default
- [[concepts/Review Before Push]] — §8 (the handoff test) enforced structurally as a pre-merge gate
- [[concepts/MAP]] — orientation hub, doctrine index
