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

**Checksum-verified (recommended):** downloads the bootstrap script from GitHub at a commit you pick and verifies it against a checksum recorded in this repo's git history -- over a different domain/TLS chain than the convenience URL below -- before running anything.

First, get a commit SHA that contains `scripts/web-install.sh.sha256`: use the latest commit from [the commit history](https://github.com/wrg32786/aigent-os/commits/master), or a tagged release from [the tags page](https://github.com/wrg32786/aigent-os/tags) -- check the tag actually includes that file, since older tags predate it.

```bash
COMMIT=<paste-a-commit-sha-here>
curl -fsSL "https://raw.githubusercontent.com/wrg32786/aigent-os/$COMMIT/scripts/web-install.sh" -o /tmp/aigent-os-install.sh
curl -fsSL "https://raw.githubusercontent.com/wrg32786/aigent-os/$COMMIT/scripts/web-install.sh.sha256" -o /tmp/aigent-os-install.sh.sha256
(cd /tmp && sha256sum -c aigent-os-install.sh.sha256) && sh /tmp/aigent-os-install.sh
```

```powershell
$commit = "<paste-a-commit-sha-here>"
Invoke-WebRequest "https://raw.githubusercontent.com/wrg32786/aigent-os/$commit/scripts/web-install.ps1" -OutFile "$env:TEMP\aigent-os-install.ps1"
Invoke-WebRequest "https://raw.githubusercontent.com/wrg32786/aigent-os/$commit/scripts/web-install.ps1.sha256" -OutFile "$env:TEMP\aigent-os-install.ps1.sha256"
$expected = (Get-Content "$env:TEMP\aigent-os-install.ps1.sha256").Split(' ')[0]
$actual = (Get-FileHash "$env:TEMP\aigent-os-install.ps1" -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "checksum mismatch -- do not run this script" }
& "$env:TEMP\aigent-os-install.ps1"
```

See [`docs/install-security.md`](docs/install-security.md#checksum-pinned-install) for exactly what this does and does not protect against.

**Quick (convenience, unverified):** always runs whatever `tools.theaigent.xyz` currently serves, piped straight into your shell -- no checksum, no pin. Faster to type, but a compromise of that domain, its DNS, or a MITM position would run arbitrary code before any of the script's own checks fire.

```bash
curl -fsSL https://tools.theaigent.xyz/os/install | sh
```

```powershell
irm https://tools.theaigent.xyz/os/install.ps1 | iex
```

Either variant clones aigent-OS to `~/aigent-os` and prints the next steps: `cd` into it, run `bash install.sh`, then open Claude Code there.

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
