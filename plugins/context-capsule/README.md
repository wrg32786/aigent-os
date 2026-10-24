# context-capsule

Write a resume-ready capsule of your Claude Code session, then `/clear` (or let auto-compact run) and pick up exactly where you left off. Plain Node scripts, zero npm dependencies, no network.

This is the portable half of aigent-os "Auto-Refresh": capsule, clear, automatic resume pointer. It is manual-trigger. A plugin is loaded by Claude Code, so it cannot type `/clear` for you; you run `/clear`, the plugin does the rest. Fully hands-off refresh at a context threshold stays an aigent-os feature (see `/autorefresh-setup`).

## Install

```
/plugin marketplace add wrg32786/aigent-os
/plugin install context-capsule@aigent-os
```

No build step, no `npm install`. Needs Node 18+ on your PATH. `${CLAUDE_PLUGIN_DATA}` is not used; capsules live in the project.

## What you get

| Piece | What it does |
|---|---|
| `/capsule` | Writes a capsule now: objective, `waiting_on`, `next_valid_action`, plus reference sections. |
| `/refresh` | Writes a capsule and tells you to run `/clear`. |
| `/resume` | Loads the newest valid capsule, re-grounds against the live repo, takes the next step. |
| `/autorefresh-setup` | Prints how hands-off refresh works and where it lives. Installs nothing. |
| `PreCompact` hook | Side effect only; it prints nothing, because Claude Code does not add PreCompact output to the context. If no valid capsule exists it writes a small marker file (`.precompact-marker.json`) in the capsule directory. With a valid capsule it just removes any stale marker. |
| `SessionStart` hook (`clear` and `compact` only) | Injects one small block (at most 1800 characters): capsule id, path, age, `objective`, `waiting_on`, `next_valid_action`, all quoted as data. On `clear` it marks the capsule `resumed` so the next clear does not replay it. On `compact` the capsule stays active; if the PreCompact marker is present and no valid capsule exists, the block says compaction ran without a capsule and nudges `/capsule`. The marker is deleted either way. |

Typical flow: `/refresh`, then `/clear`; the new session's first turn names the capsule and continues the `waiting_on` item.

## Where capsules live

`<project>/.claude/capsules/` by default. Set the `capsuleDir` option (plugin config) to use another folder; a relative path resolves against the project. The plugin never uses an aigent-os vault path unless you point `capsuleDir` at one. The capsule format is the aigent-os format, so a later full install reads the same files.

Add `.claude/capsules/` to your `.gitignore`: capsules are working state, not source. Capsules older than 14 days are refused at resume, not loaded (plugin option `maxAgeDays`; the `CONTEXT_CAPSULE_MAX_AGE_DAYS` env var overrides it). So are capsules with no frontmatter, empty required fields, or text that is an injected-instruction echo. A refusal names each rejected file and the reason.

## Using it next to a full aigent-os install

If aigent-os is installed in the project, this plugin's hooks exit 0 and print nothing, so you never get a second capsule or a second resume injection. Detection (either is enough):

- `.aigent/state.json` with a `schemaVersion` key in the project root (or in `$AIGENT_ROOT`). `install.sh` writes this file on every install.
- A `SessionStart` or `PreCompact` hook in the project's `.claude/settings.json` or `settings.local.json` (or in the user-scope `~/.claude/settings.json` or `settings.local.json`) that runs aigent-os's `sessionstart-reinject.mjs`, `resume-verb.mjs` or `precompact-flush.mjs`.

The commands and skills still work in that case; only the automatic hooks defer.

## What it touches

- Reads: the capsule directory, `.claude/settings.json` and `.claude/settings.local.json` in the project and in `~/.claude` (aigent-os detection only), `.aigent/state.json`.
- Writes: capsule files in the capsule directory (`/capsule`), the PreCompact marker there, and the `status:` line of a capsule it just resumed on `clear`. Nothing else. No plugin data directory is used. Nothing is written to your home directory.
- Network: none. No telemetry. The scripts import only `node:` built-ins, and a test fails if that changes.
- Hooks never block: any error exits 0 and session start or compaction proceeds.

## Platforms

Pure Node ESM with `node:` built-ins and `path` handling, written for Windows, macOS and Linux. Tested on Windows 11 with Node 24. macOS and Linux runs are not yet verified. Hook commands are `node "${CLAUDE_PLUGIN_ROOT}/scripts/..."`, which needs no shell features.

## Tests

```
node --test plugins/context-capsule/tests/*.test.mjs
```

Runs under a temp HOME and temp projects; covers the writer, SessionStart on clear and compact, corrupt and stale refusal, PreCompact marker and nudge, standalone firing, coexistence with aigent-os, containment of writes, no-network checks, and compatibility with the aigent-os capsule selector when run inside the monorepo.

## License

MIT, same as aigent-os. See `LICENSE`. Issues: https://github.com/wrg32786/aigent-os/issues
