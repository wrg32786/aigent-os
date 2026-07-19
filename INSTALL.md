# Install aigent-OS

**One step. The OS sets itself up.**

## From a downloaded folder

1. **Unzip** this folder anywhere you like.
2. **Drag the folder into Claude Code** (or open Claude Code in this directory).
3. **Say:** `install this`

That's it. aigent-OS reads its own installer and sets itself up.

## From a URL, no download

Paste `https://github.com/wrg32786/aigent-os` into any Claude Code session and say `install this`. Claude clones the repo and follows this file.

## Fastest: one-line bootstrap

```bash
curl -fsSL https://tools.theaigent.xyz/os/install | sh
```

```powershell
irm https://tools.theaigent.xyz/os/install.ps1 | iex
```

This clones aigent-OS to `~/aigent-os` and prints the next steps: `cd` into it, run `bash install.sh`, then open Claude Code there.

---

## What happens next

- aigent-OS copies its kernel files into place and writes a `.claude/settings.json` wired to your actual paths.
- It installs semantic search if Node.js is present (optional — it works fine without it).
- It tells you to start a fresh conversation and run `/start`.

---

## First run

Start a new Claude Code conversation in this directory and type:

```
/start
```

`/start` completes first-run setup and learns your context. After that, sessions resume themselves — no `/open`, no `/close`, ever. `/context-capsule` and `/resume` still exist if you want to force a checkpoint or reload on demand.

**Optional:** open the `vault/` folder in [Obsidian](https://obsidian.md) to see your AI's knowledge graph visually.

---

## Fallback (manual install)

If "install this" doesn't kick off the setup, run the installer directly from this folder:

```bash
bash install.sh
```

It installs into the current directory. That's the same script Claude Code runs for you — nothing hidden.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md) · Advanced config: [docs/advanced-setup.md](docs/advanced-setup.md)
