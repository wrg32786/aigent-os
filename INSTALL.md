# Install aigent-OS

**One step. The OS sets itself up.**

1. **Unzip** this folder anywhere you like.
2. **Drag the folder into Claude Code** (or open Claude Code in this directory).
3. **Say:** `install this`

That's it. aigent-OS reads its own installer and sets itself up.

---

## What happens next

- aigent-OS copies its kernel files into place and writes a `.claude/settings.json` wired to your actual paths.
- It installs semantic search if Node.js is present (optional — it works fine without it).
- It tells you to start a fresh conversation and run `/open`. From there, just talk.

---

## First run

Start a new Claude Code conversation in this directory and type:

```
/open
```

aigent-OS boots with full context. Work normally — it handles routing, memory, and delegation. When you're done, run `/close` and it saves everything for next time.

**Optional:** open the `vault/` folder in [Obsidian](https://obsidian.md) to see your AI's knowledge graph visually.

---

## Fallback (manual install)

If "install this" doesn't kick off the setup, run the installer directly from this folder:

```bash
bash install.sh
```

It installs into the current directory. That's the same script Claude Code runs for you — nothing hidden.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md) · Advanced config: [docs/advanced-setup.md](docs/advanced-setup.md)
