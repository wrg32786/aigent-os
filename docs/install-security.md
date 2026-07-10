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
- Replace same-named files inside copied framework trees.
- Replace an invalid existing `.claude/settings.json`.

## Existing-file behavior

### Framework trees

Files copied from framework directories use no-clobber behavior. Existing destination files remain untouched. This protects user customizations but also means rerunning the installer is not a blind upgrade mechanism for modified framework files.

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
npm ci --silent
```

or:

```bash
npm install --silent
```

inside `daemons/semantic-search/`. npm may contact configured registries and execute package lifecycle behavior according to the dependency lock and npm configuration. Review `package.json` and the lock file before enabling this step in a high-trust environment.

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

When release checksums are published, verify the downloaded archive with the platform's SHA-256 tool before extraction. Tagged releases are not a substitute for signed provenance; consult `SECURITY.md` for the current signing status.

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
