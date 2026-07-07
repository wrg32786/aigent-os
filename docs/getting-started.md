# Getting Started with aigent-OS

## Prerequisites

1. **Claude Code** — CLI, desktop app, or IDE extension. [Get it here](https://claude.ai/code)
2. **Node.js 18+** — Optional. Required for semantic search and hook automation. The installer detects Node and installs these automatically if present.
3. **Obsidian** — Optional. Free app for visual vault navigation. [Download](https://obsidian.md/)

---

## Install

You already have the aigent-OS folder — you downloaded and unzipped it. Open a terminal in that folder and run:

```bash
bash install.sh
```

Run from the directory where you work — your existing project root, your home folder, anywhere — or pass a target path as the first argument:

```bash
bash install.sh /path/to/your/project
```

The installer:
- Copies `system/`, `vault/`, `skills/`, `hooks/`, `daemons/` into your working directory
- Creates or appends `CLAUDE.md`
- Creates `.claude/settings.json` with all paths resolved to your actual location (no manual `AIGENT_ROOT` export needed)
- Installs semantic search via `npm install` if Node.js is available
- Copies skills to `.claude/skills/` so Claude Code's slash-command resolver can find them

If you already have a `CLAUDE.md`, the installer appends the aigent-OS config block rather than overwriting.

To skip the Node.js dependency step entirely: `bash install.sh --no-deps`

---

## First session

Open Claude Code in the same directory and start a conversation. aigent-OS is live — CLAUDE.md loads automatically.

**Recommended first steps (takes ~10 minutes):**

1. Edit `system/00_identity.md` — fill in the "Your Principal" section with who you are
2. Edit `system/14_decision_framework.md` — encode how YOU make decisions
3. Edit `system/12_authority_matrix.md` — set boundaries that match your risk tolerance
4. Edit `vault/memory/ACTIVE_PRIORITIES.md` — add your current priorities

Then say `/open`. aigent-OS will boot with whatever context exists and walk you through anything missing.

---

## Session flow

Every session follows the same loop:

1. **`/open`** — aigent-OS loads vault context, surfaces open threads, active priorities, and last-session state
2. **Work** — Talk normally. aigent-OS routes tasks, tracks decisions, manages delegation.
3. **`/close`** — aigent-OS commits memory, writes the daily note, logs decisions, sets up next session pickup

The vault grows with every `/close`. After a week of daily use it becomes genuinely useful. After a month it's indispensable.

**Context management:** Every Claude Code session has a finite context window. Run `/statusline` in Claude Code (once, on your first session) and enable the context usage display -- this adds a live counter so you can see the window filling. When context gets heavy, the aigent-OS rhythm is: run `/close` to bank the session, start a fresh conversation, then `/open` to resume at full context. Claude Code's built-in `/compact` and `/clear` commands exist too, but `/close` then fresh session then `/open` is preferred because it also commits your memory to the vault.

---

## Where memory lives

```
vault/
  memory/
    ACTIVE_PRIORITIES.md   — current priority stack
    DECISION_LOG.md        — append-only decision history
    DELEGATION_TRACKER.md  — active handoffs
    SESSION_LOG.md         — rolling 5-session log
    BUSINESS_CONTEXT.md    — portfolio overview
    PRODUCT_STATE.md       — build state
    PEOPLE_AND_ROLES.md    — people + agents
  concepts/   — standing rules, doctrine, architectural decisions
  projects/   — one note per project
  people/     — one note per person
  daily/      — date-stamped session notes (written by /close)
```

Every file is plain Obsidian-flavored markdown. You can read, edit, and search it directly. No hidden database, no embeddings required for basic recall.

---

## Vault structure conventions

All vault notes use YAML frontmatter:

```yaml
---
title: Note Title
tags: [concept, memory]
aliases: []
created: 2026-04-27
---
```

Cross-references use wikilinks: `[[Project Alpha]]`, `[[people/Jane]]`. The link graph IS the knowledge graph — navigable in Obsidian or greppable from the command line.

---

## Customization guide

### Essential (do first)
- `system/00_identity.md` — Who you are, what you need
- `system/14_decision_framework.md` — Your personal decision logic
- `system/12_authority_matrix.md` — What the AI can decide alone

### Important (do soon)
- `system/03_roles_and_scope.md` — Your agent hierarchy
- `vault/memory/ACTIVE_PRIORITIES.md` — Current priorities
- Add your people to `vault/people/`
- Add your projects to `vault/projects/`

### Optional (customize over time)
- `system/04_decision_frameworks.md` — Add or remove evaluation lenses
- `system/08_financial_thinking.md` — Adjust financial thresholds
- `vault/templates/` — Modify note templates to match your style

---

## Self-improvement loop

When aigent-OS makes a mistake, trigger the learning cycle with one sentence:

> **"Reflect on this mistake. Abstract and generalize the learning. Write it to CLAUDE.md."**

The AI analyzes the failure, extracts the general pattern, and writes a rule. Over time the framework gets smarter — basic mistakes disappear, conversations elevate to higher-level concerns.

**Where rules go:**
- Operational mistakes → root `CLAUDE.md`
- Domain knowledge → new concept note in `vault/concepts/`
- Behavioral patterns → `system/02_operating_standards.md`

---

## Skills

Skills are slash commands. Included out of the box:

| Command | What it does |
|---------|-------------|
| `/open` | Boot session with full vault context |
| `/close` | Commit memory, write daily note, set next-session pickup |
| `/statusline` | Claude Code built-in: run once to enable live context usage display |
| `/brief` | Generate a structured delegation brief |
| `/decide` | Run a decision through your decision framework |
| `/deep-recon` | Extended multi-agent research on complex questions |
| `/semantic-search` | Vector search across the vault (requires Node) |

Source templates live in `skills/`. Runtime copies live in `.claude/skills/`. See [Advanced Setup](advanced-setup.md) for adding new skills and managing the Caddy index.

---

## Troubleshooting

**Hooks not firing:** Run `bash scripts/doctor.sh` — it checks whether `.claude/settings.json` has resolved paths. If `AIGENT_ROOT` literal appears in the file, re-run the installer or manually replace it.

**Semantic search not working:** Run `node daemons/semantic-search/embed-vault.js` to rebuild the index. Requires Node.js 18+.

**Vault feels empty:** Expected. The vault grows with use. Every `/close` adds to the knowledge graph.

**Something broken?** Run `bash scripts/doctor.sh` for a full health check. See [Advanced Setup](advanced-setup.md) for per-component debugging.
