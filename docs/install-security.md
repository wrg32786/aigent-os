# Install Path Security

The install script (`bash install.sh`) runs locally from the folder you downloaded. You are not fetching code from the internet at install time — this document explains the trust model, what `install.sh` actually does, and how to verify the script before running it.

## What `install.sh` does

In one sentence: **copies a curated set of files from the unzipped folder into your current directory, asks before overwriting anything, and creates no symlinks.**

The full sequence:

1. Detects whether you're inside a git repo, a project directory, or your home folder
2. Asks where to install (defaults to current working directory)
3. Confirms before overwriting any existing file
4. Copies `system/`, `vault/templates/`, `skills/`, `hooks/`, `daemons/`, `CLAUDE.md` into the destination; creates `.claude/` with `settings.json` (AIGENT_ROOT substituted), `skill-index.json`, `rules/`, and `skills/` (runtime slash commands)
5. Creates `vault/projects/`, `vault/people/`, `vault/concepts/`, `vault/memory/`, `vault/daily/` if they don't exist
6. Initializes a `.gitignore` if there isn't one
7. Prints a "you're done" message with the next-step instruction

It does **not**:
- Send any data anywhere
- Modify files outside the install directory
- Modify shell rc files or PATH
- Touch your existing git config
- Require sudo

One optional step runs `npm install --silent` inside `daemons/semantic-search/` if `package.json` is present there (installs the local embedding model for semantic search — no network calls at query time). To skip this entirely, pass `--no-deps`:

```bash
bash install.sh /your/target/dir --no-deps
```

## What you're trusting

Running `bash install.sh` from the downloaded folder trusts:

1. **The ZIP you downloaded** — that it matches what was packaged in the repository
2. **Your download channel** — GitHub (or whatever mirror you used) delivers the file over HTTPS

That's it. There is no remote fetch at install time. The script copies files from the folder it lives in.

## How to verify before running

### Option A — read the script first

```bash
less install.sh
```

The script is ~3KB and entirely shell. You can read it end-to-end in 2 minutes. Look for:
- Any URL it fetches
- Any path it writes outside `$INSTALL_DIR`
- Any `eval`, `exec`, `source` of remote content
- Any `sudo` or privilege escalation

If anything in the script surprises you, don't run it.

### Option B — verify the ZIP you downloaded

If you want to confirm the file you received hasn't been tampered with, compute its checksum and compare to the value published in the release notes or repository:

```bash
# macOS
shasum -a 256 aigent-os.zip

# Linux
sha256sum aigent-os.zip

# Windows (PowerShell)
Get-FileHash aigent-os.zip -Algorithm SHA256
```

Compare the output to the published checksum. A match means you have exactly what was packaged.

## Reporting an install-path vulnerability

Any of these counts:

- A path traversal issue in `install.sh` that writes outside `$INSTALL_DIR`
- Behavior that fetches URLs not under the user's control
- Silent overwrite of files without confirmation
- Embedded credentials or telemetry

See [`SECURITY.md`](../SECURITY.md) for how to report privately.
