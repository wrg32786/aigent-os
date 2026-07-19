# Skills

Skills are slash commands that trigger predefined workflows. Type the command and the AIgent executes the protocol.

## Built-In Skills

| Command | What It Does |
|---------|-------------|
| `/resume` | Boot the session — load the last capsule, re-ground, act on the next step (auto-fires on `SessionStart(clear)`; `/open` is retired) |
| `/context-capsule` | Bank a resume-ready capsule (a rolling best-effort autosave also runs on every `Stop`; `/close` is retired) |
| `/brief` | Generate a structured delegation brief for any task |
| `/decide` | Run a decision through the 12-lens evaluation framework |
| `/search` | Semantic search over the vault by meaning (local, private) |

## How Skills Work

Each skill is a `SKILL.md` file in `skills/<name>/`. The file contains:
- **Frontmatter** — `name`, `description`, a `triggers` list (plural), and `user-invocable`
- **Protocol** — Step-by-step instructions for what the skill does
- **Rules** — Constraints and guardrails

When you type a skill command, Claude Code loads its `SKILL.md` and follows the protocol.

## Creating Custom Skills

Skills live in two places: `skills/` is the versioned **source** tree in this repo, and `.claude/skills/` is the **runtime** location Claude Code actually reads. Creating a file under `skills/` alone does NOT make the command work — you must also place it in `.claude/skills/` (or re-run the installer, or run `/caddy-enroll`).

Make a new directory in `skills/` with a `SKILL.md` inside for versioning:

```
skills/
  my-skill/
    SKILL.md
```

Then copy it to `.claude/skills/my-skill/SKILL.md` for runtime, or run `/caddy-enroll` to register it. See [Advanced Setup → Skills: source vs runtime](advanced-setup.md#skills-source-vs-runtime).

### SKILL.md Template

```markdown
---
name: my-skill
description: What this skill does in one sentence
triggers:
  - /my-skill
  - natural-language phrase that should fire it
user-invocable: true
---

# Skill Name

[Describe what the skill does]

## Usage

`/my-skill [optional arguments]`

## Protocol

1. [Step one]
2. [Step two]
3. [Step three]

## Rules
- [Constraint or guardrail]
```

### Skill Ideas

Skills that would be useful to build:

- `/review` — Review active priorities, flag what's stale, suggest adjustments
- `/comms` — Check a shared communication channel, process messages, reply or escalate
- `/standup` — Quick status across all active projects in one pass
- `/research [topic]` — Spawn a research agent with structured output format
- `/audit` — Scan the vault for staleness, orphan notes, and broken wikilinks
- `/cost` — Show token spend for current session and cumulative
- `/idea [description]` — Add to the idea queue with automatic 3-gate filter evaluation

### Tips

- Keep skills focused — one skill, one workflow. Don't make Swiss Army knife skills.
- Skills can read from and write to the vault — that's their power.
- Skills can spawn sub-agents for heavy work — the skill defines what model tier to use.
- Test your skill a few times and refine the protocol based on what actually works.
