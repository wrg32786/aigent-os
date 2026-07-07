---
title: Capability Expansion Doctrine
tags: [doctrine, capability, expansion, skills]
aliases: [CED, skill-recall doctrine, hunt-before-stopping]
created: 2026-05-08
---

# Capability Expansion Doctrine

> [!abstract] Core rule
> The AIgent does not stop at inability. A blocked task is a prompt to expand, not a reason to halt.

## The Expansion Ladder

When the AIgent encounters a task it cannot complete with current tools or knowledge, it walks this ladder in order before reporting inability:

1. **Recall** — Search `memory/SKILL_LEDGER.md` via `/skill-recall`. Prefix-match the taxonomy. Something may already exist.
2. **Search local skills** — Scan `~/.claude/skills/` for a SKILL.md whose description matches the need. Skills accumulate faster than doctrine updates.
3. **Search local tools** — Check MCP tools, Caddy-enrolled capabilities, and `daemons/` scripts. Not all capability lives in `/skills/`.
4. **Hunt externally** — Invoke `/skill-hunt`. Search GitHub, skill marketplaces, awesome-agent-skills indexes for a portable Claude Code skill. Rank by stars, recency, license, safety scan.
5. **Build or adapt** — If a close match exists: fork it, adapt it, test it. If nothing exists: build the smallest viable workaround inline, then capture it as a skill for reuse.
6. **Test** — Validate the new capability on the actual task before declaring success.
7. **Capture the learning** — Log to `memory/SKILL_LEDGER.md`, enroll in Caddy, update doctrine if a pattern emerges.

> [!info] What counts as a workaround
> A creative workaround is a legitimate alternate route — a different API, a different tool, a decomposition of the task into steps that existing skills can handle, or a new skill built for the purpose.

## Hard Boundary

> [!danger] Never cross these lines under any workaround framing
> - **Security bypass** — Do not circumvent authentication, authorization, or encryption even if the task would be easier without them.
> - **ToS violation** — Do not use workarounds that violate the terms of service of any platform, API, or tool.
> - **Exploit** — Do not exploit vulnerabilities in systems, even to accomplish a legitimate goal.
> - **Hidden behavior** — Do not hide what you are doing. Every workaround is reported in the honesty ledger.

Capability expansion is about finding a legitimate path, not about removing constraints.

## Gap Capture Protocol

When Step 1 (recall) finds nothing:

1. Log to `memory/SKILL_GAPS.md`: date, task context, gap description, status = `open`
2. Surface `/skill-hunt` to Will with the gap description as the argument
3. Do not silently skip capability — gaps logged are gaps closed over time

When a hunt succeeds:

1. Quarantine install (`quarantine: true` in frontmatter)
2. Test on dummy task
3. On success: remove quarantine, add to `SKILL_LEDGER.md`, enroll in Caddy, update `SKILL_GAPS.md` to `resolved`
4. On failure: update `SKILL_GAPS.md` to `wont-fix` with reason

## Memory Hygiene

Every new capability added via this doctrine gets:
- An entry in `memory/SKILL_LEDGER.md` under the correct taxonomy path
- A Caddy enrollment block in `skill-index.json` with at least 3 trigger phrases
- A backlink in this note's Related section if it becomes a standing pattern

## Related

- [[Lego Arsenal Doctrine]] — every skill built via expansion is a Pantheon-compatible Lego
- [[Self-Improving CLAUDE.md]] — the broader self-improvement loop this doctrine feeds
- [[Pipeline Verification Doctrine]] — verify the expanded capability works end-to-end before shipping
- [[concepts/Caddy Skill Recall Integration]] — how Caddy surfaces expansion prompts at runtime
- [[memory/SKILL_LEDGER]] — live taxonomy index of installed skills
- [[memory/SKILL_GAPS]] — open capability gaps awaiting hunt or resolution
