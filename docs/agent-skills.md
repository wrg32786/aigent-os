# Agent Skills

The folders under `skills/` follow the [Agent Skills](https://agentskills.io) open standard: each one is a directory with a `SKILL.md` whose frontmatter has a lowercase kebab-case `name` that matches the folder, plus a `description` of what the skill does and when to use it.

Claude Code already gets these skills from a full aigent-OS install. The instructions below are for loading the same skills in Cursor, Codex, OpenCode, or another compatible client, without installing the harness.

Some skills assume an aigent-OS install (a vault, capsules, hooks, or seat layout). Skills that are general procedures still work on their own. The Managed Auto-Refresh loop (capsule, `/clear`, resume) stays a Claude Code install.

## Install

### Skills CLI (Claude Code, Cursor, and other clients that support it)

```bash
npx skills add wrg32786/aigent-os --yes
```

### Claude Code plugin marketplace

A full install already wires the skills. To add only the portable context-capsule plugin:

```text
/plugin marketplace add wrg32786/aigent-os
/plugin install context-capsule@aigent-os
```

### Cursor

If your Cursor build has agent skills turned on, run the skills CLI above in the workspace, or copy the skill folders you need into `.cursor/skills/`.

You can also point a project rule at a skill. For example, in `.cursor/rules/aigent-os.mdc`:

```md
---
description: aigent-OS operator skills (capsules, memory, reviews)
alwaysApply: false
---
When the task matches an aigent-OS skill, read and follow the matching
SKILL.md under path/to/aigent-os/skills/.
```

### Codex

```bash
npx skills add wrg32786/aigent-os --yes
```

Or clone the repo and copy selected folders from `skills/` into `~/.agents/skills/` or the project's skill path. Then mention the skill by name, or add a short pointer in the project's `AGENTS.md`:

```md
## aigent-OS skills
When the task matches a skill in path/to/aigent-os/skills/, read that
SKILL.md and follow it.
```

### OpenCode

Copy the skill folders you need into a discoverable path. Project-local `.opencode/skills/` is a good default. OpenCode also discovers `.claude/skills/` and `.agents/skills/`.

```bash
mkdir -p .opencode/skills
cp -R skills/honesty-check .opencode/skills/honesty-check
# repeat for other folders under skills/
```

Each skill `name` is lowercase kebab-case and matches its directory, which OpenCode requires.

## What is in a skill

```text
skills/<skill-name>/
├── SKILL.md        # required: frontmatter + instructions
├── scripts/        # optional: runnable helpers
├── references/     # optional: deeper docs loaded on demand
└── ...             # templates or other resources
```

See the [specification](https://agentskills.io/specification) for the frontmatter fields. A catalog of the skills in this repo lives in [`skills/skill-index.json`](../skills/skill-index.json).
