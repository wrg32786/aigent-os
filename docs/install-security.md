# Install Path Security

`install.sh` is a local installer. It activates the downloaded checkout in place or copies the framework into a target selected by the user. This document describes the current behavior, including file mutations, network access, trust boundaries, and rollback paths.

## Inspect before running

```bash
less install.sh
bash install.sh --help
bash install.sh --target /path/to/project --dry-run
```

The dry run reports the source, target, mode, copied directories, configuration changes, and whether optional dependencies would be installed. It does not create the target directory or modify files.

## Files and directories written

The installer writes only inside the resolved target directory.

For an external target it may:

1. Copy missing files from the local checkout's `system/`, `vault/`, `skills/`, `hooks/`, `daemons/`, `scripts/`, `docs/`, `memory/`, and `evals/` directories.
2. Create or refresh a marked aigent-OS block in `CLAUDE.md`.
3. Create `.claude/rules/`, `.claude/skills/`, and `.claude/agents/`.
4. Create or merge `.claude/settings.json`.
5. Create vault runtime directories.
6. Create `.aigent/state.json` and `.aigent/backups/`.
7. Refresh a marked generated-state block in `.gitignore`.
8. Optionally run npm inside `daemons/semantic-search/`.

The installer does not:

- Use `sudo`.
- Modify shell startup files, `PATH`, global Git configuration, or files outside the target.
- Fetch and execute an installer script from a remote URL.
- Replace same-named files inside copied framework trees, with one exception: `hooks/` and `daemons/` quarantine a differing pre-existing file instead of silently keeping it (see below).
- Replace an invalid existing `.claude/settings.json`.
- Write through a symlink anywhere inside the target (see "Symlinks" below).

## Existing-file behavior

### Framework trees

Files copied from framework directories use no-clobber behavior. Existing destination files remain untouched. This protects user customizations but also means rerunning the installer is not a blind upgrade mechanism for modified framework files.

### Hooks and daemons

`hooks/` and `daemons/` are treated differently from every other framework tree, because files there become trusted executables that Claude Code runs on the next matching lifecycle event, per `.claude/settings.json`'s hook wiring. If a file already exists at a path the installer would otherwise place a framework hook/daemon at, and its content differs from the framework's version, the installer quarantines the existing file (moves it to `.aigent/quarantine/<path>.<timestamp>`) and installs the trusted framework copy instead, printing a `[quarantine]` line naming both paths. A pre-existing file whose content is byte-identical to the framework's is left alone (no-op, same as any rerun).

This exists so that installing into an existing project directory -- one that might already contain a planted file at, say, `hooks/security-scan.sh` -- cannot silently leave that planted file in place to be wired up as a trusted hook. If you intentionally maintain your own customized hooks or daemons at these paths, pass `--trust-existing-hooks` to keep them instead of quarantining:

```bash
bash install.sh --target /path/to/project --trust-existing-hooks
```

### Symlinks

Every write inside the target -- creating a directory, copying a framework file, writing `CLAUDE.md`/`settings.json`/`.gitignore`/`.aigent/state.json` -- is checked first: if any path component from the target root down to (and including) the destination is already a symlink, the write is refused rather than followed. Without this, a pre-seeded symlink such as a file named `CLAUDE.md` that actually points at `~/.bashrc` would let a write we believe lands on `$TARGET/CLAUDE.md` land wherever the link points instead, since both `cp` and shell redirection follow symlinks by default. Single critical writes (`CLAUDE.md`, `.gitignore`, `.claude/settings.json`) abort the whole install with an actionable error; copies of many files (framework trees, skills, agents) skip just the affected file with a `[skip]` warning and continue.

### CLAUDE.md

External installations use these markers:

```text
<!-- aigent-os:start -->
<!-- aigent-os:end -->
```

On rerun, only the marked block is replaced. The previous `CLAUDE.md` is copied into `.aigent/backups/` first. Older installations that contain an unmarked appended copy cannot be safely identified automatically and may require one manual cleanup.

### settings.json

A valid existing `.claude/settings.json` is backed up and deep-merged. Existing user values are preserved except the managed `AIGENT_ROOT` and `AIGENT_VAULT` entries, which are refreshed to the target path. Hook arrays are extended without adding byte-identical duplicates.

If the existing file is invalid JSON, it is left untouched and the rendered aigent settings are saved as `.claude/settings.aigent.json`.

### .gitignore

Only the marked aigent generated-state block is refreshed. Existing ignore rules remain.

## Network behavior

The core copy and configuration steps use local files only.

Unless `--no-deps` is supplied, the installer may run:

```bash
npm ci --silent --ignore-scripts
```

or:

```bash
npm install --silent --ignore-scripts
```

inside `daemons/semantic-search/`. npm may contact configured registries and resolve the dependency lock. `--ignore-scripts` disables lifecycle scripts (`preinstall`/`install`/`postinstall`) for this package and every transitive dependency, so a compromised transitive dependency -- or a `daemons/semantic-search/package.json` that already existed in the target before this install ran -- cannot execute arbitrary code as a side effect of dependency resolution. The bundled semantic-search package has no lifecycle scripts of its own, so this changes nothing for a normal install. Review `package.json` and the lock file before enabling this step in a high-trust environment regardless.

Skip it with:

```bash
bash install.sh --no-deps
```

## Trust boundaries

Running the installer trusts:

1. The local checkout and its Git history.
2. The channel used to obtain that checkout.
3. The shell, Python, Node.js, and npm executables selected through the current `PATH`.
4. npm dependencies when optional installation is enabled.

After installation, Claude Code hooks run with the user's operating-system permissions. Review `.claude/settings.json` and every command hook before using the system with sensitive files.

## Verify the source

Prefer a tagged release or pinned commit:

```bash
git rev-parse HEAD
git status --short
```

Tagged releases are not a substitute for signed provenance; consult `SECURITY.md` for the current signing status.

### Checksum-pinned install

`INSTALL.md`'s one-line bootstrap (`curl | sh` / `irm | iex`) always fetches whatever `tools.theaigent.xyz` currently serves and executes it immediately -- convenient, but a compromise of that domain, its DNS, or a MITM position between you and it would run arbitrary code before any check in the fetched script itself has a chance to fire.

The checksum-pinned variant instead fetches both the bootstrap script AND its checksum from `raw.githubusercontent.com` at a commit you pick -- a different domain and TLS chain than `tools.theaigent.xyz` -- and verifies the download before running anything.

Pick a commit that contains `scripts/web-install.sh.sha256`: the latest commit from [the commit history](https://github.com/wrg32786/aigent-os/commits/master), or a tagged release from [the tags page](https://github.com/wrg32786/aigent-os/tags) -- older tags predate this file, so confirm the tag you pick actually includes it (`git ls-tree -r <tag> --name-only | grep web-install.sh.sha256` against a local clone, or browse the tag on GitHub).

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

What this does and does not protect against:

- **Protects against**: a compromise of `tools.theaigent.xyz`, its DNS, or a MITM position targeting that CDN specifically -- the executed bytes are verified against a checksum recorded in this repo's git history at a commit you chose, over a completely separate domain and trust chain.
- **Does not protect against**: a compromise of the maintainer's GitHub account or of GitHub itself (the checksum and the script both ultimately come from this repo), or trusting a stale/malicious commit if you pin one you haven't reviewed. Cryptographic release signing is on the roadmap (see `SECURITY.md`); until then, pinning to a commit you can read the diff of is the strongest guarantee available.

`scripts/web-install.sh.sha256` and `scripts/web-install.ps1.sha256` are regenerated with `bash scripts/gen-web-install-checksums.sh` whenever the corresponding script changes; `tests/test-web-install.sh` fails CI if they ever drift out of sync with the scripts they checksum.

Search the installer for unexpected capabilities:

```bash
grep -nE 'curl|wget|sudo|eval|exec|source |npm |pip |ssh |scp ' install.sh
```

Expected results should correspond only to documented optional dependency handling or explanatory text.

## Sensitive data

The installer does not ask for or transmit credentials. Hook activity capture stores metadata only and deliberately omits raw Bash commands, MCP queries, arbitrary tool input, and file contents. The tracker also redacts common credential formats before writing.

This is defense in depth, not a guarantee that every secret format is recognizable. Keep secrets out of command lines when possible, restrict vault permissions, use disk encryption where appropriate, and review generated daily notes before sharing them.

## Failure and rollback

Temporary installer files are removed through an exit trap. Backups of managed configuration are kept under `.aigent/backups/`.

To inspect a failed installation:

```bash
bash scripts/doctor.sh /path/to/install
```

Do not delete backups until the installation and hooks have been exercised in a fresh Claude Code session.

## Reporting a vulnerability

Report installer path traversal, command injection, secret logging, unsafe overwrite, dependency confusion, or writes outside the target through the private process in [`../SECURITY.md`](../SECURITY.md). Include the tested commit, operating system, exact command, and minimal reproduction.
