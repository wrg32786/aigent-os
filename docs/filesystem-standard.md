# Filesystem Standard

## Why

Leaked scratch files and accumulated renders filled a disk. Each install needs one filing standard, enforced mechanically by cleanup jobs and disk guards.

## Tiers

| Tier | Where | What belongs | What never belongs |
|---|---|---|---|
| HOT | The install root (`$AIGENT_HOME`) and active project storage | Repos, vaults, worktrees with open PRs, launched assets for 30 days, the last two backups per install | Render scratch, downloads, expired assets, older backups, archives |
| SCRATCH | `<scratch root>/<run-id>/` | Temporary inputs, render intermediates, and other files used by one run | Anything that must survive the run |
| ARCHIVE | `<archive root>/<year>/<project>/`, such as storage on an external SSD | Launched assets after their hot period, older backups, old vault snapshots, all with manifests | Live work or the only copy of an active project |
| HUMAN | The human-documents root, optionally in a cloud drive using stream mode | Documents, photos, and exports intended for people | Repos, vaults, renders, dependency trees such as `node_modules` |
| MIRROR | An offsite `archive-mirror` folder, optionally in a cloud drive using stream mode | A second copy of ARCHIVE, including its manifests | Files that are not already in ARCHIVE |

## Scratch rule

Each run creates its own folder under the scratch root. Before starting tools or child processes, it sets `TEMP`, `TMP`, and `TMPDIR` to that folder. It deletes the folder at run end, on both success and failure. Cleanup belongs in an exit handler or a `finally` block.

The global temp directory is off limits to agents and pipelines. A tool must use the run's scratch folder, including when it needs an explicit temporary-directory option.

## Retention

- Scratch older than 24 h is a leak. The run owns immediate cleanup; the weekly sweep catches leaks.
- Keep launched assets hot for 30 days. Then move them to ARCHIVE with their manifest.
- Keep the last two backups per install hot. Move older backups to ARCHIVE with a manifest.
- Rotate logs and ledgers at 50 MB.
- Fold capsules with terminal status older than 7 days into a summary. Move those capsules to an archive folder such as `capsules/_archive/`, with a manifest.
- Delete worktrees when their PR merges or closes.
- Clear caches quarterly or when free space drops under 100 GB.

## Enforcement

These are requirements for a conforming install. This document defines the contract; it does not add enforcement code.

- **Low-disk guard:** Before a render or install starts, check free space on the volumes it will write to. Refuse to start if any has less than 40 GB free. Send an alert for the refusal.
- **Weekly hygiene sweep:** Report every tier violation by path and size. Delete only scratch older than 24 h and files matching explicitly named scratch prefixes. Configure those prefixes with their allowed scratch locations so a matching name elsewhere cannot authorize deletion. Move nothing to an archive folder without its manifest.
- **Logon recovery:** Daemons must restart at logon, including the scheduler and semantic-search server.

## Configuration

Name the install, scratch, archive, and human-documents roots once per install. Use absolute paths appropriate to the host. Keep scratch separate from durable files. The archive root can be on an external SSD mounted as a drive; the mirror is a separate offsite copy.

The following names distinguish existing configuration from proposed additions:

| Variable | Status | Meaning |
|---|---|---|
| `AIGENT_HOME` | Exists today | Installed harness root. `install.sh` passes its target to the platform launcher installer, which records this variable. The launchers and `daemons/pty-runner.mjs` read it. |
| `AIGENT_STATE_HOME_DIR` | Exists today | Override for the base used to resolve memory and state in supporting daemons. `daemons/lifecycle-common.mjs` and `daemons/nightly-paths.mjs` honor it. It is not a scratch or archive root. |
| `AIGENT_SCRATCH_ROOT` | Proposed | Parent of all per-run scratch folders for this install. |
| `AIGENT_ARCHIVE_ROOT` | Proposed | Durable archive storage, organized by year and project. |
| `AIGENT_HUMAN_DOCUMENTS_ROOT` | Proposed | Documents, photos, and exports for human use. |

The three proposed variables are not read by `install.sh` or `daemons/` today. Setting them alone does not redirect files or enable the guards and sweep. Integrations must explicitly adopt them and pass each run's scratch folder through `TEMP`, `TMP`, and `TMPDIR`. `AIGENT_STATE_HOME_DIR` remains an existing state-resolution override, not a replacement for these tier roots.
