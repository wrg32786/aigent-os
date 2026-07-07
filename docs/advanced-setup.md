# Advanced Setup

For users who want manual control, optional features, or deeper configuration beyond the one-line installer.

---

## Hook configuration

Hooks run silently in the background on every Claude Code event. The installer creates `.claude/settings.json` with paths pre-resolved. If you installed manually or need to reconfigure:

1. Copy `.claude/settings.json.template` to `.claude/settings.json`
2. Replace every occurrence of `AIGENT_ROOT` with your actual install path:

```bash
# From your aigent-OS directory:
sed -i "s|AIGENT_ROOT|$(pwd)|g" .claude/settings.json
```

3. Verify no literal `AIGENT_ROOT` remains:

```bash
grep -c "AIGENT_ROOT" .claude/settings.json  # should print 0
```

### What each hook does

| Hook | Event | Purpose |
|------|-------|---------|
| `daemons/caddy.sh` | UserPromptSubmit | Matches prompt to skills, surfaces `[CADDY] /skill` hints |
| `hooks/suggest-compact.sh` | PostToolUse | Nudges context management before hitting limits |
| `hooks/auto-capture.sh` | PostToolUse | Logs actions to daily note automatically |
| `daemons/caddy-detect-new-skill.sh` | PostToolUse (Write/Edit) | Detects new skill files, prompts `/caddy-enroll` |
| `hooks/session-capture-summary.sh` | Stop | Writes session summary at conversation end |
| `hooks/session-end-check.sh` | Stop | Reminds to `/close` if not yet run |
| `hooks/log-token-usage.sh` | Stop | Logs token cost to vault |

---

## Semantic search setup

Semantic search lets you query the vault by meaning, not keywords. Requires Node.js 18+.

**Install:**
```bash
cd daemons/semantic-search
npm install
node embed-vault.js   # builds initial index (~30s for a full vault)
```

**Search from the command line:**
```bash
node daemons/semantic-search/search-vault.js "what did we decide about pricing"
```

**From Claude Code:**
```
/semantic-search what did we decide about pricing
```

**Rebuild the index** after adding significant new vault content:
```bash
node daemons/semantic-search/embed-vault.js
```

The model used is `all-MiniLM-L6-v2` (local). No API calls. No data leaves your machine.

---

## Obsidian vault setup

Obsidian gives you a visual graph of the vault's knowledge connections. Optional — the vault works without it.

1. [Download Obsidian](https://obsidian.md/) (free)
2. Open Obsidian → "Open folder as vault"
3. Select the `vault/` directory inside your aigent-OS install

You'll see the knowledge graph: memory files, concept notes, project notes, and daily session logs connected by wikilinks.

**Recommended Obsidian plugins (optional):**
- Graph View — visualize the link graph
- Dataview — query vault notes like a database
- Templater — faster note creation with templates

---

## Skills: source vs runtime

There are two locations for skills:

| Location | Purpose |
|----------|---------|
| `skills/` | Source templates in this repo. Versioned, shareable. |
| `.claude/skills/` | Runtime location. Claude Code reads from here for slash commands. |

The installer copies `skills/` to `.claude/skills/` during setup. If you add a new skill manually:

1. Create `skills/<name>/SKILL.md` (for versioning)
2. Also create `.claude/skills/<name>/SKILL.md` (for runtime)

Or run `/caddy-enroll` after placing the file — it reads the SKILL.md and adds the skill to Caddy's index.

---

## Caddy skill index management

Caddy is a non-blocking hook that matches your prompts to skills. Its index lives at `.claude/skill-index.json` — installed automatically by the installer and read by `daemons/caddy.sh` at runtime.

**Manually enroll a skill:**
```
/caddy-enroll
```

**Reindex all skills from scratch:**
```bash
bash daemons/caddy-reindex.sh
```

**Check current index:**
```bash
cat .claude/skill-index.json | python3 -m json.tool | grep '"name"'
```

---

## Memory-heat daemon

The memory-heat daemon ranks vault notes by recency + frequency of access, so `/open` knows what to surface. Output lives at `vault/memory/HEAT_INDEX.json`.

**Run manually:**
```bash
node daemons/memory-heat/compute-heat.js
```

**Schedule weekly** (optional) — add to cron or use the `/schedule` skill to set a recurring trigger.

---

## Troubleshooting

### Doctor script

Run this from your aigent-OS directory for a full health check:

```bash
bash scripts/doctor.sh
```

Checks: kernel files, vault, CLAUDE.md, skills, hooks, settings.json path resolution, Node availability, semantic search install, shell syntax, JSON validity.

### Common issues

**`AIGENT_ROOT` literal in settings.json:**
The installer didn't run path substitution. Fix:
```bash
sed -i "s|AIGENT_ROOT|$(pwd)|g" .claude/settings.json
```

**Skills not showing as slash commands:**
Confirm the skill is in `.claude/skills/<name>/SKILL.md` (not just `skills/`). Claude Code only reads from `.claude/skills/`.

**Hook permission errors on Linux/Mac:**
```bash
chmod +x hooks/*.sh daemons/*.sh scripts/*.sh
```

**Semantic search `embed-vault.js` fails:**
Node version must be 18+. Check: `node --version`. If behind: `nvm install 18 && nvm use 18`.
