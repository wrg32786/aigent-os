# Spec for Titus: Managed Auto-Refresh as a standalone Claude Code plugin

Owner: Will Gwyn (wrg32786). Builder: Titus. Status: draft, research done 2026-10-16.

## Goal

Ship the useful, portable part of aigent-os Managed Auto-Refresh as its own Claude Code plugin that someone can install with `/plugin install`, without running the full aigent-os install.sh. Then submit it to Anthropic's official directory (anthropics/claude-plugins-official, external plugins, via https://clau.de/plugin-directory-submission).

## The honest part: what can and can't be a plugin

Auto-Refresh today has two halves:

1. **Capsule + resume** (skills/context-capsule, skills/resume, daemons/resume-verb.mjs, precompact-flush.mjs, the SessionStart and PreCompact hooks in .claude/settings.json.template). These are plain skills, hooks, and node scripts. All of that fits a plugin.
2. **The managed clear** (daemons/pty-runner.mjs, about 4300 lines, plus auto-clear-transport.mjs). The runner *wraps the claude process*: it owns the PTY so it can be the only thing typing `/clear` after the capsule ack. It needs node-pty, a native module that install.sh builds with `npm rebuild node-pty`. A plugin is loaded *by* Claude Code, so it can't launch the process that hosts it. Plugins also have no install step to compile native deps.

So the runner can't really "move into" the plugin. Also, `idleCompaction: false` (and similar) lives in user settings; a plugin can't safely flip a user's settings, it can only tell them to.

## Recommendation: the smallest viable plugin

Plugin name (permanent slug, pick carefully): `context-capsule` (or `auto-refresh`, see open questions).

It ships:
- **Skills:** `context-capsule` (write a resume-ready capsule) and `resume` (load the newest valid capsule and act on waiting_on). Copied from aigent-os skills/, stripped of aigent-os-specific paths.
- **Hooks** (`hooks/hooks.json`, using `${CLAUDE_PLUGIN_ROOT}` for script paths):
  - `PreCompact`: flush or nudge a capsule before auto-compact eats the context (port of precompact-flush.mjs).
  - `SessionStart` (matcher `clear` and `compact`): inject the newest capsule pointer so the fresh session picks up where it left off (port of resume-verb.mjs boot path).
- **Commands:** `/capsule` (write one now), `/refresh` (write capsule, then tell the user to run `/clear`; the SessionStart hook does the rest), `/autorefresh-setup` (checks settings, explains `idleCompaction: false`, and prints how to install and run the aigent-os pty runner for fully hands-off refresh).
- **Node scripts** in `scripts/`, plain ESM, zero npm deps. No node-pty.
- README, LICENSE (match aigent-os), CHANGELOG.

In short: the plugin gives "manual-trigger Auto-Refresh" (capsule, clear, auto resume) to anyone. Fully automatic refresh at 80% stays an aigent-os feature, and the plugin points to it.

## File layout

```
context-capsule/
  .claude-plugin/plugin.json     # name, version, description, author, homepage, repository, license, userConfig (capsule dir)
  hooks/hooks.json               # PreCompact + SessionStart
  scripts/precompact-flush.mjs
  scripts/session-start-resume.mjs
  scripts/capsule-lib.mjs        # shared: capsule dir, newest-valid selection, frontmatter
  skills/context-capsule/SKILL.md
  skills/resume/SKILL.md
  commands/capsule.md
  commands/refresh.md
  commands/autorefresh-setup.md
  tests/                         # node --test, no network
  README.md  LICENSE  CHANGELOG.md
```

Where it lives: `aigent-os/plugins/context-capsule/`, added to the existing `.claude-plugin/marketplace.json` next to fleet-band and fleet-delivery. The official directory can then point at it with a `git-subdir` source pinned to a sha.

Capsule location: default `${CLAUDE_PLUGIN_DATA}` or `<project>/.claude/capsules/` (userConfig `capsuleDir`), never the aigent-os vault path unless the user sets it. Capsule format stays compatible with aigent-os so a later full install reads the same files.

## What stays in the main aigent-os install

- daemons/pty-runner.mjs, auto-clear-transport.mjs, daemons/transport-deps (node-pty), launcher
- ctx-refresh-sensor / statusline-ctx (the 80% pressure trigger), kill switch, runner lock, receipts
- Managed settings template (idleCompaction=false, statusLine, the full hook set)
- Memory vault, nightly jobs, everything else
- Rule: the plugin must never require these. When aigent-os is detected, the plugin's hooks should no-op or defer so the two don't double-fire (check for the aigent-os hooks in settings, or a marker file).

## Sequencing

1. Land PR #97 first (identity-bound capsule-ack lifecycle, fixes #90 and #91). Merge with a **merge commit**, not squash or rebase.
2. Tag v1.1.0 (currently only v1.1.0-rc.1 exists; v1.0.0 is the last final tag).
3. Cut the plugin from post-#97 code so the capsule format and ack semantics are final.
4. Plugin starts at 0.1.0 in the aigent-os marketplace, dogfood, then submit.

## Acceptance criteria / tests

- `claude plugin validate` (or `/plugin validate`) passes on the plugin dir and on marketplace.json.
- Fresh machine, no aigent-os: `/plugin marketplace add wrg32786/aigent-os` then `/plugin install context-capsule@aigent-os` works with no npm install and no build step.
- `/capsule` writes a capsule with the expected frontmatter to the configured dir.
- `/refresh` then `/clear`: the new session's first turn names the capsule and continues the waiting_on item, no user re-explaining.
- Auto-compact path: PreCompact fires, a capsule exists before compaction, and the post-compact SessionStart points to it.
- Corrupt or stale capsule: resume refuses it with a clear message instead of loading garbage.
- With full aigent-os installed: no double capsules, no double resume injection.
- Scripts run on macOS and Linux with Node 18+; Windows behavior documented (works or clearly unsupported).
- No network calls, no telemetry, nothing written outside the capsule dir and plugin data dir.
- node --test suite green in CI; ported tests from aigent-os for capsule selection and freshness.

## Official directory checklist

From the anthropics/claude-plugins-official README:
- [ ] `.claude-plugin/plugin.json` present (required); README.md present
- [ ] Standard layout (commands/, skills/, agents/, hooks, optional .mcp.json)
- [ ] Plugin `name` is final: slugs are immutable after publishing (use `displayName` for label changes; renames need a `renames` map)
- [ ] Submit through the form, external plugins land in `/external_plugins` and "must meet quality and security standards"
- [ ] Source pinned (git-subdir with path + ref + sha works for a monorepo like aigent-os)
- [ ] Our own bar for "quality and security": clear README with what hooks do and when, no hidden network, LICENSE, homepage/repository fields, versioned CHANGELOG, tests, issue tracker link
- [ ] Re-read CONTRIBUTING and the form fields right before submitting; the README is thin on specifics and requirements may have changed.

## Open questions

1. **Biggest one:** is "manual-trigger" refresh valuable enough to stand alone, or should the plugin also try a no-PTY automatic path (e.g. a hook that detects high context and asks the model to write a capsule and tell the user to /clear)? Plugins can't type `/clear` themselves, so true hands-off needs the runner.
2. Slug: `context-capsule` vs `auto-refresh`. Calling it auto-refresh oversells it if it doesn't auto clear.
3. Ship from the aigent-os monorepo (git-subdir) or a separate repo? Separate repo is cleaner for reviewers.
4. Should `/autorefresh-setup` offer to run the aigent-os runner install, or only print instructions? (Printing is safer for directory review.)
5. Does Anthropic accept plugins whose SessionStart hook injects context on every clear/compact? Keep the injection small and documented.
6. Capsule dir default: per-project or per-user?
