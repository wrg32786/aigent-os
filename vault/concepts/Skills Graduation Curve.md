---
title: Skills Graduation Curve
tags:
  - doctrine
  - skills
  - caddy
  - scaling
aliases:
  - The Skills Curve
  - Why Caddy exists
  - Toolbox compounding
created: 2026-04-26
---

# Skills Graduation Curve

The number of skills your the AIgent install ends up with shapes how you interact with it. The relationship is non-linear — there are distinct phases, and the operating model has to evolve at each one.

## The four phases

### Phase 1 — At 5 skills, you remember them

You can list your skills from memory. You type `/open`, `/close`, maybe one or two others. Caddy isn't necessary; you're invoking by name.

This is the onboarding phase. Most users live here for the first week or two. The framework feels like a small toolkit.

### Phase 2 — At 15 skills, you start forgetting

You've added skills as situations came up. Some you use weekly; some you used twice and forgot existed. When a familiar problem comes up, you reach for `Bash`, `Grep`, or just type out the workflow manually — because it's faster than remembering whether you wrote a skill for it.

This is the **dangerous phase.** Skills you wrote start gathering dust. The framework starts feeling like a "I should clean this up" project. Many personal-OS projects die here, when the principal stops trusting their own toolbox.

The fix is not "remember harder" — it's Caddy.

### Phase 3 — At 30 skills, Caddy is essential

You can no longer hold the catalog in your head. Skills exist for problems you forgot you solved.

Caddy fills the gap. Every prompt you submit runs through a non-blocking hook that matches your wording against trigger patterns in the skill index. Matching skills surface as `[CADDY] /name - why` hints in your context. You don't have to remember; the system reminds you.

This is the **inflection point.** Without Caddy, the framework collapses under its own weight. With Caddy, the framework starts compounding — every new skill makes the toolbox more useful without making the principal work harder.

### Phase 4 — At 50+ skills, Caddy is invisible infrastructure

You stop noticing Caddy. You write a prompt; the right skill surfaces; you use it. Sometimes you don't even invoke the slash command — just seeing the hint surface reminds you the skill exists, and you use the doctrine inside without typing it.

The principal stops thinking of the AIgent as a "framework I maintain" and starts thinking of it as "how I work." The toolbox is invisible — like Git is invisible, like a good IDE is invisible. The leverage is real; the friction is gone.

## The compounding mechanism

Three loops combine to make this work:

### Loop 1 — Skills get added easily

Every new pattern the principal notices in their own work is one `/skills-builder` away from being a permanent capability. The cost of writing a skill is low; the value compounds across every session that touches the same domain.

### Loop 2 — Caddy auto-detects new skills

When a new SKILL.md lands in the skills folder, a daemon detects it and prompts the principal to enroll it via `/caddy-enroll`. The enrollment writes the skill's name, description, and trigger keywords into the catalog. The catalog stays fresh without the principal having to remember to update it.

### Loop 3 — Skill audit surfaces dead and missing skills

`/skill-audit` runs periodically. It flags skills that haven't been used in 60+ days for retirement, and detects clusters of repeated manual workflows that should be skills but aren't yet. The catalog stays useful, not just full.

## The exit valve — retirement

The graduation curve has to allow skills to leave, not just enter. Without that, the catalog accumulates forever and Caddy starts surfacing dead options.

Retirement criteria:
- Last invoked >60 days ago AND
- Total invocations <3 over the lifetime of the install
- AND no recent prompts that match its trigger patterns

`/skill-audit` flags candidates. The principal decides: keep, archive (move to a `skills/_archive/` folder, removed from Caddy index), or delete entirely.

The discipline matters because the catalog is finite cognitive surface area. Even with Caddy doing the matching, the principal sees the surfaced hints, evaluates them, decides whether to invoke. Dead skills add noise.

## What this means for new users

If you've just installed the AIgent, you're in Phase 1. Don't try to predict your way to Phase 4 — you don't yet know which skills you'll actually need. Build skills as patterns emerge in your work, not before.

By the time you hit Phase 2 and start forgetting, you'll have ~15 skills you actually use. Add Caddy. Let it surface what you've forgotten.

By Phase 3, the framework is compounding. By Phase 4, it's invisible.

The point of the AIgent isn't to ship with 100 skills out of the box. It's to make the *graduation curve* easy enough that your toolbox can grow with you.

## Connects to

- [[Legibility Thesis]] — why the catalog must be readable, not opaque
- [[The Two Roles]] — principal-as-maintainer is the role that runs `/skill-audit` and decides what retires
- [`/skills-builder`](../../skills/skills-builder/SKILL.md) — author new skills cleanly
- [`/skill-audit`](../../skills/skill-audit/SKILL.md) — find dead skills and capability gaps
- [`/caddy-enroll`](../../skills/caddy-enroll/SKILL.md) — add a new skill to Caddy's index
