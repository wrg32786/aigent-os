---
title: The Two Roles
tags:
  - doctrine
  - editorial
  - framework-rot
aliases:
  - Principal as user vs maintainer
  - Editorial discipline
created: 2026-04-26
---

# The Two Roles

The principal of a the AIgent install plays two roles. Holding both — and refusing to let one corrupt the other — is what prevents this framework from rotting into a bespoke pile that no one else can adopt.

## The split

### As **first user**, you optimize for Friday-end-of-day clarity

You want `/open` and `/close` to work. You want the AI to surface what matters and not surface what doesn't. You want fewer questions, sharper outputs, no surprises.

You're the principal. The framework exists to serve you. When something annoys you on a Friday at 5pm, your instinct is to fix it immediately — adjust a rule, add a skill, edit the kernel until your specific irritation goes away.

### As **maintainer**, you optimize for the framework's coherence

You're focused on the AIgent as a thing other people might one day use. You're willing to add friction to your daily workflow if it improves the framework's legibility for everyone else. You're willing to say no to a skill that solves your problem in a one-off way if it doesn't generalize. You're willing to NOT add a rule that would have prevented yesterday's small annoyance, because the rule wouldn't generalize past your specific situation.

You're the curator. The framework exists for the *category* of user who will install it, not just for you.

## Why the discipline matters

Most personal-OS projects don't separate these roles. They optimize entirely for the principal-as-user. Every annoyance becomes a rule. Every workflow becomes a skill. Every preference becomes a setting.

Three years later, the project is a bespoke pile of one person's preferences. Useful to that person. Adoptable by no one else.

The alternative — optimize entirely for principal-as-maintainer, "design for users you don't have yet" — produces a different failure: an over-abstracted framework with no opinions, no battle-testing, and no real users.

The AIgent tries to hold both. The way you can tell which role is in charge: ask whether the change improves *your* Friday-end-of-day clarity, or whether it improves the system's *coherence* for everyone.

If it improves your clarity but harms coherence — reject it.
If it improves coherence but harms your clarity — usually reject it (you're the user; if it doesn't work for you, it won't work for anyone).
If it improves both — ship.

## How to tell which role you're in

When you're about to make a change to the AIgent, look at what you're solving for:

| You're acting as user | You're acting as maintainer |
|---|---|
| "This irritated me yesterday" | "This irritates a category of user" |
| "I want this to fire when I say X" | "Every user will phrase this differently; build a trigger pattern" |
| "Add this principal-specific reference" | "Generalize before publishing" |
| "Change the AI's behavior for me" | "Document a rule that any principal could opt into" |
| "Capture today's lesson" | "Generalize today's lesson" |

Both modes are valid. The discipline is **knowing which mode you're in** and not letting one corrupt the other.

## The publish boundary

The cleanest enforcement of the discipline is the publish boundary. Every vault note and skill carries a `private: true | false | review` flag in YAML frontmatter:

- `private: true` — never leaves the principal's local install. principal-specific business context, individual people's notes, in-flight project state.
- `private: false` — ships to the public aigent-OS repo at next release. Universal doctrine, well-structured skills, generalized examples.
- `private: review` — pending classification. Default for new files. Forces the principal to make the call explicitly at next publish.

The flag forces the maintainer role to the surface. Every note's `private:` value is a maintainer decision. The principal-as-user can write whatever they want; the principal-as-maintainer decides what graduates.

The generalization test is the second enforcement: *would this skill be useful for at least three radically different principals — say, a SaaS founder, a non-profit director, and a creative production lead?* If only one yes, the skill stays private. If only useful for the principal who built it, the skill stays private.

## The cost of getting this wrong

If the maintainer role is too aggressive — every annoyance shipped as a public rule — the framework becomes prescriptive in ways that don't survive contact with another principal's reality. The next user installs the AIgent and finds it covered in rules that are obviously specific to someone else's situation.

If the user role is too aggressive — every preference baked in as a kernel default — the framework forks silently. The principal's local install drifts from the public repo. Eventually they're maintaining two systems.

The discipline is to keep both populated, both visible, and both legible. Personal preferences live in `private:` notes. Universal doctrine lives in `false` notes. Both are auditable. Neither contaminates the other.

## Connects to

- [[Legibility Thesis]] — the meta-doctrine that requires this editorial discipline
- [[Skills Graduation Curve]] — how skills evolve from private experiments to public infrastructure
- [`README.md`](../../README.md) — public-facing framing
- [`docs/manifesto.md`](../../docs/manifesto.md) — manifesto including the two-roles concept
