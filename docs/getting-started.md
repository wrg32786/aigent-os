# Getting Started with aigent-OS

## Prerequisites

Required:

1. **Claude Code** in the CLI, desktop app, or an IDE integration.
2. **Bash** for installation and hook scripts.

Optional:

- **Node.js 18 or newer** for semantic search and Node-based hooks.
- **Python 3** for runtime-state computation and selected daemons.
- **Obsidian** for visual navigation of the vault.

The Markdown kernel and normal vault workflow do not require a database or server.

## Installation modes

The installer supports two explicit modes.

### Activate the downloaded checkout in place

Open a terminal in the downloaded `aigent-os` directory and run:

```bash
bash install.sh
```

This leaves the source tree in place and configures `.claude/`, local state, runtime skills, agents, and optional dependencies.

To skip optional dependencies:

```bash
bash install.sh --no-deps
```

### Install into another working directory

```bash
bash install.sh --target /path/to/your/project
```

A positional target remains supported:

```bash
bash install.sh /path/to/your/project
```

Flags may appear before or after the target:

```bash
bash install.sh --no-deps --target /path/to/your/project
bash install.sh /path/to/your/project --no-deps
```

Preview the installation without changing anything:

```bash
bash install.sh --target /path/to/your/project --dry-run
```

Run `bash install.sh --help` for the complete command reference.

## What the installer changes

For an external target, the installer:

- Copies missing files from `system/`, `vault/`, `skills/`, `hooks/`, `daemons/`, `scripts/`, `docs/`, `memory/`, and `evals/` without overwriting existing files in those trees.
- Creates or refreshes a marked aigent-OS block in `CLAUDE.md` and backs up the previous file under `.aigent/backups/`.
- Installs runtime skills under `.claude/skills/` and dispatchable agents under `.claude/agents/` without replacing same-named user definitions.
- Creates or deep-merges `.claude/settings.json`. Existing scalar settings are preserved except the managed aigent-OS root variables, which are refreshed to the current target path.
- Preserves invalid existing settings and writes the proposed aigent configuration to `.claude/settings.aigent.json` for manual repair.
- Creates `.aigent/state.json` for machine-readable first-run state.
- Adds a marked generated-state block to `.gitignore`.
- Runs `npm ci` or `npm install` inside `daemons/semantic-search/` when Node.js 18 or newer is available, unless `--no-deps` was supplied.

The optional npm step can use the network. The rest of the installer reads from the local checkout and writes only inside the target directory.

Rerunning the installer is safe and idempotent for managed configuration. It refreshes the marked `CLAUDE.md` and `.gitignore` blocks, merges settings, and preserves existing framework and user files. It is deliberately conservative rather than pretending every customized installation can be upgraded by blindly overwriting files.

## First session

Open Claude Code in the installed directory and run:

```text
/start
```

`/start` owns first-run detection and onboarding. It records setup progress in `.aigent/state.json`, learns the operator's context, produces a first usable artifact, and marks setup ready only after durable writes succeed.

Use `/setup` later for deeper configuration or to revise identity, priorities, authority boundaries, decision logic, projects, people, or agent definitions.

## Normal session flow

The lifecycle is two verbs, and both fire automatically at their hook points — you rarely invoke them by name. See [`two-verb-lifecycle.md`](two-verb-lifecycle.md).

1. **`/resume`** loads the newest valid capsule by `created_at`, re-grounds on recent context and open threads, and acts on `next_valid_action`. It auto-fires on `SessionStart(clear)` via `daemons/resume-verb.mjs`; a warm reinject (showing the newest active capsule) runs on every other SessionStart source.
2. **Work normally.** Skills and hooks route tasks, capture privacy-safe action metadata, and update durable notes when appropriate. A rolling, best-effort capsule autosave runs on every `Stop` (`daemons/stop-capsule-writer.mjs`).
3. **`/context-capsule`** reconciles and writes a resume-ready capsule, then stops — invoke it for a deliberate mid-session checkpoint or a clean end-of-thread finalize. The autosave already covers the case where you just walk away.

`/open` and `/close` are **retired** (the skill files remain but are deprecated). Run `/statusline` once in Claude Code and enable context usage — the context-pressure sensor nudges a capsule-then-clear as the window fills.

## State layout

There are two memory trees, and both are actively written across sessions. They are not a clean "operator vs framework" split (an earlier version of this doc claimed root `memory/` was framework-index-only — that was inaccurate).

### `vault/memory/` — the operator's flat ledgers

```text
vault/
  daily/                         Date-stamped session notes
  projects/                      Project notes
  people/                        People and role context
  concepts/                      Durable doctrine and reusable knowledge
  agents/                        Human-readable agent definitions
  memory/                        Flat Markdown/JSON ledgers — no subdirectories:
    ACTIVE_PRIORITIES.md  DECISION_LOG.md  DECISION_OUTCOMES.md
    DELEGATION_TRACKER.md  SESSION_LOG.md  HONESTY_LEDGER.md
    MEMORY_CANDIDATES.md  BODY_STATE.json  AGENT_FITNESS.md  …
    capsules/                    Resume-ready capsules (created at runtime)
```

### root `memory/` — framework indexes + the cognitive/runtime layer

```text
memory/
  SKILL_LEDGER.md  SKILL_GAPS.md  SKILL_CHAINS.md    Caddy + capability-expansion indexes
  facts/                                             Temporal fact ledger (facts.jsonl)
  runtime/                                           Cognitive layer, written every session:
    ACTIVE_STATE.json  SELF_MODEL.json  GOAL_STACK.json  BELIEF_STATE.jsonl
    LESSONS.jsonl  PROCEDURES.jsonl  DREAM_LOG.md  STATE_EVENTS.jsonl
    improvements/                                    /meta-improve candidate reports
```

Root `memory/` is not a passive index area: daemons plus the `/dream`, `/meta-improve`, `/status`, and `/reconcile` skills all read and write `memory/runtime/` every session.

> [!warning] Known path inconsistency (code issue, not a doc issue)
> `daemons/runtime/update-active-state.py` writes `ACTIVE_STATE.json` to `vault/memory/runtime/`, but every reader (`/status`, `/reconcile`) reads it from root `memory/runtime/` — which is the only populated copy on disk. This split should be reconciled to one canonical path; it is tracked separately from this docs pass.

### Generated local state

`.aigent/` contains installation state, close markers, caches, and backups. It is excluded from version control by default.

## Customization

Start with:

- `system/00_identity.md` for role and operating posture.
- `system/12_authority_matrix.md` for autonomy and escalation boundaries.
- `system/14_decision_framework.md` for personal decision logic.
- `vault/memory/ACTIVE_PRIORITIES.md` for current focus.

Use the setup skills rather than editing every file manually unless direct editing is preferable. Every important state remains readable Markdown or JSON.

## Diagnostics

Run:

```bash
bash scripts/doctor.sh
```

To inspect another installation:

```bash
bash scripts/doctor.sh /path/to/install
```

Common checks:

- **Hooks are missing:** inspect `.claude/settings.json`, then restart Claude Code because hook configuration loads at session start.
- **Settings are invalid:** repair the existing file using `.claude/settings.aigent.json` as the proposed aigent block.
- **Semantic search is unavailable:** verify Node.js 18 or newer, then run `npm install` in `daemons/semantic-search/` and rebuild the index.
- **Runtime state appears empty:** run `python3 daemons/runtime/update-active-state.py --print-vault` and confirm it resolves to the project's `vault/` directory.
- **Setup repeats:** inspect `.aigent/state.json`, `.aigent/first-run-done`, and `memory/about-you.md` for an interrupted first-run write.

## Security

Read [`install-security.md`](install-security.md) before installing into a sensitive project. Hooks run with the user's permissions, and the vault can contain private operational context. Use full-disk encryption when the threat model requires encryption at rest, and never commit `.aigent/` or generated embedding indexes.
