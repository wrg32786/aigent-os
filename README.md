<div align="center">

# aigent-OS

**Claude Code that refreshes its own context instead of compacting.**

Open-source (MIT) harness for one long-running Claude Code session. When context reaches a threshold, it saves a verified capsule, runs /clear, and resumes the work in a fresh session. No summary of a summary, no re-briefing.

[Install](#install) · [Demo](#see-it-resume-itself) · [Evidence and limits](#evidence-and-limits) · [What it changes](#what-this-changes-on-your-machine) · [Uninstall](#uninstall) · [FAQ](#faq) · [Alternatives](#alternatives) · [Docs](docs/getting-started.md)

[![GitHub stars](https://img.shields.io/github/stars/wrg32786/aigent-os?style=flat-square)](https://github.com/wrg32786/aigent-os/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Compatible-blueviolet?style=flat-square)](https://claude.ai/code)
[![Obsidian](https://img.shields.io/badge/Obsidian-Vault_Native-7C3AED?style=flat-square)](https://obsidian.md)
[![CI](https://img.shields.io/github/actions/workflow/status/wrg32786/aigent-os/ci.yml?branch=master&style=flat-square&label=CI)](https://github.com/wrg32786/aigent-os/actions/workflows/ci.yml)
[![Security Policy](https://img.shields.io/badge/Security-Policy-informational?style=flat-square)](SECURITY.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen?style=flat-square)](#-contributing)

**Stop re-briefing your AI every morning.**

From the team behind [The AIgent](https://theaigent.xyz), a free media project for people building with AI.

</div>

---

## What it does, in plain English

Claude Code has a fixed context window. When it fills, the usual options are to let it auto-compact (the model summarizes the conversation and keeps going on the summary) or to `/clear` and re-explain everything yourself. aigent-OS takes a third path. Before the window fills (default 80%, configurable with `AIGENT_PRESSURE_THRESHOLD_PCT`), it asks Claude to write a resume-ready checkpoint file (a "capsule"). It waits for Claude to confirm the capsule is complete, sends exactly one `/clear`, checks that a fresh session started, and tells that new session to load the capsule and carry on. No confirmation, no clear. Your notes, decisions and open threads live in plain markdown files you keep in git (aigent-OS commits and pushes them at each capsule cycle when the install folder has a git remote), so you can read, diff and roll back exactly what your agent remembers. It runs on your machine; aigent-OS has no server of its own.

## Install

Requires [Claude Code](https://claude.ai/code), Node.js 18+ with npm, and bash (on Windows, Git Bash from [Git for Windows](https://git-scm.com)).

```bash
git clone https://github.com/wrg32786/aigent-os.git && cd aigent-os && bash install.sh --dry-run
```

The dry run prints the planned changes and writes nothing. When the plan looks right, run `bash install.sh` in the same folder, open a new terminal, and run `aigent`. The first launch runs guided setup.

To install into an existing project instead of the cloned folder, run `bash install.sh --target <dir>` from the clone (preview it with `--dry-run` first). Before you start working, read [What this changes on your machine](#what-this-changes-on-your-machine), including the note on vault sync and git remotes. More options: [Quick Start](#-quick-start).

## Evidence and limits

- **What has been shown publicly:** 11 of 11 observed Auto-Refresh cycles on one Windows reference seat, in one live run during release testing for v1.1.0-rc.1. Each cycle had one capsule request, one acknowledgement, one `/clear`, and one fresh session, with zero stranded acknowledgements and zero duplicate clears. Write-up: the companion paper, [*governed-agent-organizations*, hypothesis H2](https://github.com/wrg32786/governed-agent-organizations/blob/main/PAPER.md), and its [continuity and Auto-Refresh case study](https://github.com/wrg32786/governed-agent-organizations/blob/main/case-studies/continuity-and-auto-refresh.md). More detail: [Release evidence](#release-evidence).
- **What it is not:** this is single-seat evidence, not a fleet or reliability claim, and not a claim that this approach beats compaction. It is a different trade-off: an explicit, inspectable checkpoint and a clean window instead of a model-written summary.
- **Known limitation (v1.1.0-rc.1):** a long session on a managed install can still stop at the clear step and need a manual `/clear`. Fixes for the three reproduced defects are in review, integrated on [PR #62](https://github.com/wrg32786/aigent-os/pull/62). Until that lands, check that the latest capsule and any work in flight are saved before you clear by hand. See the [v1.1.0-rc.1 release notes](https://github.com/wrg32786/aigent-os/releases/tag/v1.1.0-rc.1).
- **Release status:** Managed Auto-Refresh first shipped in the v1.1.0-rc.1 pre-release. The release GitHub marks as Latest (v1.0.0) predates it.

---

## See it resume itself

<div align="center">
<img src="assets/demo-session-resume.svg" alt="Scripted illustration: at 80% context Managed Auto-Refresh saves a capsule, clears the full context, rebinds the fresh session, and continues the work" width="100%"/>
</div>

The animation is a scripted illustration of the lifecycle, not a screen recording. In the shipped default, Managed Auto-Refresh is designed to run the whole boundary without operator input: at the configured context threshold (default 80%) it requests a capsule, waits for the exact completion acknowledgement, submits one `/clear`, binds the fresh session, and submits one resume wake. The shipped settings also set `"idleCompaction": false`, so Claude Code's own idle compaction (which can summarize a quiet session after about 55 minutes once it holds 200k tokens) cannot replace that boundary. In v1.1.0-rc.1 a long session can still stop at the clear step and need a manual `/clear`; see [Evidence and limits](#evidence-and-limits).

---

## What this changes on your machine

Run `bash install.sh --dry-run` first; it lists the planned changes and writes nothing. Below, `<target>` is the folder you install into: the cloned `aigent-os` folder by default, or the directory you pass with `--target`. The installer does not edit your user-level `~/.claude/settings.json` or `~/.claude/CLAUDE.md`.

| Where | What the installer does | How to undo |
|---|---|---|
| `<target>/.claude/settings.json` | Creates it, or merges into your existing file and saves a backup in `<target>/.aigent/backups/`. Adds hooks on seven Claude Code events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`, `SessionEnd`), a `statusLine` command, and the `AIGENT_ROOT` and `AIGENT_VAULT` env values. If your existing file is not valid JSON, it is left untouched and the new settings are written to `.claude/settings.aigent.json` for you to merge. | Restore the backup, or delete the file if the installer created it |
| `<target>/.claude/skills/`, `.claude/agents/`, `.claude/skill-index.json`, `.claude/rules/post-compact-critical.md`, `.claude/settings.json.template` | Copies the skill folders from `skills/`, the agent definitions from `vault/agents/`, the skill index, a starter rules file (only if you have none), and the settings template | Delete what was added |
| `<target>/CLAUDE.md` | `--target` installs only: creates the file, or appends one block between `<!-- aigent-os:start -->` and `<!-- aigent-os:end -->` and saves a backup. Your text outside the markers is kept. In the cloned folder, `CLAUDE.md` is the repo's own file and is not edited. | Delete the block between the markers |
| `<target>/system/`, `vault/`, `memory/`, `hooks/`, `skills/`, `daemons/`, `scripts/`, `docs/`, `evals/`, `launcher/` | `--target` installs only: copies framework files that are missing and never overwrites yours silently. `vault/` and `memory/` hold your memory as plain markdown. | Delete the folders aigent-OS created. If your project already had a folder with one of these names (`docs/` and `scripts/` are common), remove only the added files; `git status` lists them |
| Files that differ from the framework copy | Under `system/`, `skills/`, `hooks/`, `daemons/`, `scripts/`, `launcher/`, `.claude/skills/` and `.claude/agents/`, an existing file that differs from the framework version is moved to `<target>/.aigent/quarantine/` and replaced, because Claude Code would trust it. `--trust-existing` keeps them instead. | Copy the file back from `.aigent/quarantine/` |
| `<target>/.aigent/` | First-run state (`state.json`), backups and quarantined files | Delete, after restoring anything you need from it |
| `<target>/.gitignore` | Adds a block between `# aigent-os:generated-state:start` and `# aigent-os:generated-state:end` covering local state such as `.aigent/`, `node_modules/`, `.obsidian/` and the prompt journal. Saves a backup if the file existed. | Delete the block |
| `<target>/daemons/semantic-search/node_modules/` and `<target>/daemons/transport-deps/node_modules/` | Runs `npm ci --ignore-scripts` for local semantic search (`@xenova/transformers`) and the refresh runner (`node-pty`, rebuilt for your platform). `--no-deps` skips this and falls back to an unmanaged launch without automatic clear. | Delete the two `node_modules/` folders |
| `~/.local/bin/aigent` (macOS, Linux) | Symlink to `<target>/launcher/aigent.sh`. `--no-launcher` skips all launcher wiring, and a target under the system temp directory skips it automatically. | `rm ~/.local/bin/aigent` |
| `~/.bashrc` (macOS, Linux) | Appends `export AIGENT_HOME=<target>` and `export PATH="$HOME/.local/bin:$PATH"` if they are not already there. The launcher installer runs under bash, so it writes `~/.bashrc` even when your login shell is zsh. | Delete those lines (keep the PATH line if other tools rely on `~/.local/bin`) |
| `~/Applications/AIgent.app` (macOS) | An app bundle that opens Terminal and runs `aigent` | Delete the app |
| Git config of `<target>` (macOS, Linux) | Sets `core.fileMode false` if `<target>` is a git repo, so the launcher's executable bit never blocks a `git pull` | `git -C <target> config --unset core.fileMode` |
| Windows user environment | Sets the `AIGENT_HOME` user variable, writes `%USERPROFILE%\.aigent\bin\aigent.cmd`, adds that folder to your user `Path`, and creates `AIgent` shortcuts on the Desktop and in the Start Menu | See [Uninstall](#uninstall) |
| `~/.claude/ctx-refresh/` (while running) | The status line writes one small JSON file per session with the current context percentage, which the refresh runner reads | Delete the folder |

**Network and data.** aigent-OS has no server of its own. What does use the network:

- `npm` downloads packages during install.
- Semantic search downloads the `all-MiniLM-L6-v2` model files from Hugging Face the first time it runs. Embedding and search then run on your machine.
- **Vault sync:** when a capsule cycle closes and `<target>` is a git repo with a remote, aigent-OS commits the memory folder and pushes it to that remote. No repo or no remote means no push. If you installed in the cloned folder, its `origin` is this public GitHub repo, so point `origin` at your own private repo (`git remote set-url origin <your-private-repo>`) or remove it (`git remote remove origin`) before you start working.
- The optional Hindsight and Jev [memory bridge](docs/memory-bridge.md) does nothing until you configure it in `.aigent/memory-bridge.json`, and then calls only the providers you set.
- The optional [Codex adapter](docs/codex-adapter.md) runs your Codex CLI only when you invoke it.
- Claude Code itself sends your conversation to Anthropic as usual.

## Uninstall

There is no uninstall script. Removal is manual and mirrors what the installer did. Save anything you want to keep from `vault/` and `memory/` first: that is your agent's memory.

1. **Remove the `aigent` command and shortcuts.**
   - macOS and Linux: `rm ~/.local/bin/aigent`, then delete the `export AIGENT_HOME=...` line (and the `~/.local/bin` PATH line, if nothing else needs it) from `~/.bashrc`. On macOS, also delete `~/Applications/AIgent.app`.
   - Windows (PowerShell): delete `%USERPROFILE%\.aigent\bin`, remove that folder from your user `Path` (System Properties, Environment Variables), run `[Environment]::SetEnvironmentVariable('AIGENT_HOME', $null, 'User')`, and delete the `AIgent` shortcut from your Desktop and from `%APPDATA%\Microsoft\Windows\Start Menu\Programs`.
2. **If you installed in the cloned folder:** delete the folder.
3. **If you installed into a project with `--target`:**
   - Restore `.claude/settings.json`, `CLAUDE.md` and `.gitignore` from the timestamped backups in `.aigent/backups/`, or edit them by hand: delete the aigent-OS block between the markers in `CLAUDE.md` and `.gitignore`, and remove the aigent-OS hooks, `statusLine` and `env` entries from `.claude/settings.json` (or delete the file if the installer created it).
   - Delete `.claude/settings.json.template`, `.claude/skill-index.json`, `.claude/rules/post-compact-critical.md`, and the skills and agents aigent-OS added under `.claude/skills/` and `.claude/agents/`.
   - Delete the framework folders it created (`system/`, `hooks/`, `daemons/`, `scripts/`, `docs/`, `evals/`, `launcher/`, `memory/`, `vault/`). Where your project already had a folder of the same name, remove only the files aigent-OS added.
   - Restore anything you need from `.aigent/quarantine/`, then delete `.aigent/`.
   - If `<target>` is a git repo: `git -C <target> config --unset core.fileMode`.
4. **Optional:** delete `~/.claude/ctx-refresh/`.

---

## FAQ

### How do I stop Claude Code from auto-compacting and losing context?

aigent-OS refreshes the session before the window fills, so compaction is not the path it relies on. At a threshold (default 80%) it saves a verified capsule, runs `/clear`, and resumes in a fresh session from that capsule. If a compaction happens anyway, a `PreCompact` hook first flushes the latest state into the capsule and hands the compactor pointers into the vault.

### What happens when Claude Code runs out of context?

Without add-ons, Claude Code compacts the conversation into a summary and continues, or you run `/clear` and start over. Compaction keeps going on a summary; `/clear` loses everything you did not save. aigent-OS automates a third option: save a structured checkpoint, clear, and reload the checkpoint in the new session.

### Should I use /compact or /clear in Claude Code?

Use `/compact` when a summary is good enough and you want to keep going; use `/clear` when you want a clean window. aigent-OS is for people who want the clean window of `/clear` without re-briefing, and it runs the save, clear and resume sequence for you. One caveat for now: in v1.1.0-rc.1 a long session can still stop at the clear step (see [Evidence and limits](#evidence-and-limits)).

### How do I make Claude Code remember things between sessions?

aigent-OS adds a git-tracked markdown vault that every session reads at start and writes at checkpoints. Claude Code's own `CLAUDE.md` files and auto memory already carry instructions and learned notes across sessions. The vault adds daily notes, decisions, open threads and capsules on top of that, plus local semantic search over it, all in files you can open, diff and roll back.

### Can Claude Code work on one task for hours without losing track?

That is the use case aigent-OS is built for: one long-running session that keeps cycling through refreshes. The public evidence so far is 11 of 11 cycles on one machine, which is not a reliability guarantee, and the known limitation above still applies.

### What is Managed Auto-Refresh?

It is the aigent-OS loop that replaces compaction. At the context threshold it requests a capsule, waits for the exact acknowledgement "Capsule Complete, Ready For Clear", submits exactly one `/clear`, checks for a fresh session identity, and submits one resume prompt. No acknowledgement means no clear. Details: [Auto-Refresh](#-auto-refresh-autonomous-memory-and-context-management).

### Is aigent-OS better than compaction?

We do not claim that. It is a different trade-off: an explicit, inspectable checkpoint and a clean window, instead of a model-written summary. Try both on your own work.

### How is it different from claude-mem, context-mode and other memory tools?

aigent-OS manages the context boundary itself (checkpoint, clear, resume) and keeps memory as markdown in git. claude-mem captures what your agent does, compresses it with AI and injects relevant context into later sessions, with its store outside version control. context-mode reduces how much context tool output uses and persists session memory. They solve overlapping problems in different ways; see [Alternatives](#alternatives).

### Does it work on Windows?

Yes, through Git Bash. `install.sh` needs a real bash, so install [Git for Windows](https://git-scm.com) first; PowerShell alone cannot run it. The installer then wires an `aigent` command and Desktop and Start Menu shortcuts. The public 11 of 11 evidence comes from a Windows seat, and CI runs the installer on Windows, macOS and Linux. macOS has the least live mileage with the managed runner.

### How much does it cost?

aigent-OS is free and MIT-licensed. You pay for Claude Code the way you already do. Each refresh cycle uses some tokens, because Claude writes a capsule before the clear and reads it back after. The optional memory bridge and Codex adapter can incur charges from the providers you configure.

### Does it work with Codex or other models?

Claude Code is the host. A Codex adapter routes one bounded task class to `codex exec`, review-gated and never auto-merged. Other CLIs are on the roadmap, not shipped.

### Does my data leave my machine?

aigent-OS has no server; your vault is local files and semantic search runs on your machine. Claude Code still sends your conversation to Anthropic, and vault sync pushes memory commits to your git remote if the install folder has one. See [Network and data](#what-this-changes-on-your-machine).

### What does it change on my machine, and how do I uninstall it?

See [What this changes on your machine](#what-this-changes-on-your-machine) and [Uninstall](#uninstall). `bash install.sh --dry-run` shows the planned changes before anything is written.

### Is it production-ready?

Not yet: Managed Auto-Refresh is in a v1.1 release candidate. See [Evidence and limits](#evidence-and-limits) for what is and is not shown.

---

## Alternatives

A neutral guide to what fits which need (descriptions checked Oct 2026):

| If you want | Consider |
|---|---|
| Built-in, zero setup | Claude Code's own auto-compaction, `/compact`, `/clear`, `CLAUDE.md` and auto memory |
| Automatic capture of what your agent did, compressed and injected into later sessions | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) |
| Less context used by tool output | [mksglu/context-mode](https://github.com/mksglu/context-mode) |
| A memory service that learns across agents | [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) (aigent-OS has an opt-in [bridge](docs/memory-bridge.md)) |
| Persistent teams of Claude Code, Codex and Pi agents | [mvschwarz/openrig](https://github.com/mvschwarz/openrig) |
| One long-running Claude Code session that checkpoints, clears and resumes instead of compacting, with git-auditable memory | aigent-OS |

These can coexist. The detailed comparison follows.

---

## 🧩 What else ships

**aigent-OS is a 16-document kernel (plus extended specs) that turns Claude Code into a persistent operating system**, one operator, one Claude, running on your own machine. No database, no server, no build step: drop the files in, run `bash install.sh`, and the next session already knows who it is and what it's working on. The framework also ships tools for maintaining itself: a nightly self-maintenance routine you can run against your own vault, and a hook that spots a new skill file and prompts you to enroll it. The publish half, deciding what a local install has learned that's worth graduating to this repo, sanitizing it, and opening the pull request, is designed and not built. ([How this repo maintains itself](#-how-this-repo-maintains-itself) · [Manifesto](docs/manifesto.md))

> **Dependency model:** the core kernel is markdown + shell: no database or server. The default installer requires Node.js 18+, installs and verifies the managed Auto-Refresh transport, and wires the `aigent` front door automatically. `--no-deps` is the explicit fallback when you deliberately want to skip Node dependencies. Obsidian is optional, for browsing the vault visually.

Unlike memory add-ons that keep state in an opaque database, every checkpoint here is a real git commit, readable with plain `git log`, not a query against someone else's schema. The table below scores the rest against real rivals, not strawmen.

> **Recent:** managed Auto-Refresh now ships in the public core (first released in the v1.1.0-rc.1 pre-release), alongside the two-verb lifecycle, model-tier dispatch enforcement, and the Codex adapter. See [`CHANGELOG.md`](CHANGELOG.md) for dates and detail.

---

## 🆚 Compared to the field

Every framework claims to be different. Here's exactly where that's true for aigent-OS, and where it isn't, yet.

| | aigent-OS | claude-mem | SuperClaude Framework | Claude-Claw | Native Auto-Memory/Dream |
|---|:---:|:---:|:---:|:---:|:---:|
| Persistent cross-session memory | ✅ | ✅ | ⚠️¹ | ✅ | ✅ (first-party) |
| Git-native, auditable memory store | ✅ | ❌ (SQLite+Chroma, outside version control) | n/a | ⚠️ files trackable, not sync-verified | ❌ |
| Session continuity across context limits | ✅ (Managed Auto-Refresh, no compaction) | partial (Stop-hook based) | ❌ | ✅ (`/handoff`) | ✅ (native) |
| 3-tier memory architecture | ✅ | ❌ (flat) | ❌ | ✅ (same shape) | ❌ (2-tier) |
| Self-testing of its own operating rules | ❌ (Roadmap) | ❌ | partial (pre/post code-quality checks, not self-rules) | ❌ | ❌ |
| Model-tier routing across sub-agents, enforced | ✅ advisory default, opt-in enforce | ❌ | ✅ (behavioral config) | ❌ | n/a |
| Non-Claude execution (Codex, others) | ✅ (single task class) | ❌ | ❌ | ❌ | n/a |

¹ via bundled Serena MCP.

**The honest framing:** session continuity and cross-session memory are populated categories now; several projects do them well. Git-native auditability is where this repo is currently ahead. Routing and non-Claude execution are real, tested mechanisms, scoped in the table to exactly what ships and no more.

---

## 📋 Master capability table

| Capability | Mechanism | Ships today? |
|---|---|---|
| **Auto-Refresh** (autonomous memory + context) | Managed local runner: pressure threshold → one capsule request → exact acknowledgement → one `/clear` → fresh SessionStart identity → one resume wake. Busy output uses Claude Code's native prompt queue instead of blocking the cycle. | ✅ shipped in v1.1.0-rc.1 ([details](#-auto-refresh-autonomous-memory-and-context-management), [known limitation](#evidence-and-limits)) |
| Git-native vault memory | Every closed capsule cycle is a real commit, pushed to your configured remote, auditable with plain `git log`, not an opaque DB | ✅ shipped |
| Somatic layer | Five lazy-computed pressure gauges (context, memory backlog, decision pressure, token usage, drift) read before acting, no daemon polling | ✅ shipped |
| Self-learning engine | Skill recall → skill hunt → solution hunt escalation chain; every failure becomes a durable artifact | ✅ shipped |
| Cognitive architecture | Persistent self-model, goal stack, belief tracking with confidence scores, human-gated `/dream` consolidation, `/reconcile`, `/meta-improve` | ✅ shipped |
| Calibration measurement | `HONESTY_LEDGER`, `TRUST_DECAY`, and `FAILURE_MODES` are paired ledgers: a claim captured, then resolved as held, drifted, or reversed; drift detection runs at `resume`, and a `Stop` hook prompts the capture when a turn's confident claims went unrecorded | ✅ shipped |
| Caddy skill router | Non-blocking prompt-matching hook surfaces the right skill from your own catalog; auto-reindexes on drop-in | ✅ shipped |
| 3-tier memory (napkin → index → deep) | Heat-scored top-20 + staged digest sit above full topic files | ✅ shipped |
| Model-tier dispatch enforcement | A `PreToolUse` hook checks every named agent's `Agent`-tool dispatch against its declared model tier live; advisory by default, `AIGENT_MODEL_GUARD=enforce` opts into a hard block | ✅ shipped ([`docs/model-routing-enforcement.md`](docs/model-routing-enforcement.md)) |
| Non-Claude execution (Codex adapter) | One bounded, mechanical task class routed to the Codex CLI's non-interactive `codex exec`, review-gated, never auto-merged | ✅ shipped (single task class; [`docs/codex-adapter.md`](docs/codex-adapter.md)) |
| Nightly close-parity maintenance | Seven framework legs produce eleven independently validated checkpoints, append-only failure alerts, and a session-start no-fire fallback that needs no external scheduler or transport. Human judgment stays staged for review. | ✅ shipped ([`docs/nightly-self-maintenance.md`](docs/nightly-self-maintenance.md)) |
| Self-testing of one's own operating rules | A portable subset of the probe idea, scoped to one seat's own behavior | ❌ not shipped (Roadmap) |

---

## 🎬 See it happen

<div align="center">
<img src="assets/demo-day-one.svg" alt="Day one: aigent-OS asks three plain questions and hands back a first plan" width="100%"/>
</div>

The first-run onboarding: three plain questions, then a first plan. (The resume/checkpoint side of the loop is the [clip near the top](#see-it-resume-itself) of this README.) Both are the real dialogue from [What a session actually looks like](#-what-a-session-actually-looks-like) below, rendered as self-contained animated SVGs, no video, no external assets. Generator: [`assets/build-terminal-demo.mjs`](assets/build-terminal-demo.mjs).

---

## ⚡ Quick Start

### Already have a coding agent open? Skip the terminal:

```text
Clone or download this repo (https://github.com/wrg32786/aigent-os) into the current
directory, then run `bash install.sh` from inside it. The default installer requires
Node.js 18+, installs and verifies the managed Auto-Refresh runner, and wires the
`aigent` front door. When it finishes, open a new terminal and run `aigent`.
```

Your agent reads its own install script, runs it, and reports back what it found: no shell flags to remember yourself. Pasting this into an agent? Use the block above. Typing in your own terminal? Use the block below.

### From your downloaded folder:

```bash
bash install.sh
```

That's it. aigent-OS installs into whatever directory you're in: your existing project, your home folder, wherever you work. The installer copies the kernel files, creates `.claude/settings.json`, installs and verifies managed Auto-Refresh, and wires the `aigent` command plus the platform launcher where supported.

> **Explicit fallback `--no-deps`:** skips Node dependencies, including semantic search and the managed PTY transport; the launcher then uses its loud unmanaged fallback when the transport is unavailable. **Other flags:** `--target <dir>` installs elsewhere, `--dry-run` previews every change, and `--no-launcher` skips PATH/shortcut wiring (a target under the system temp directory skips it the same way automatically). See [Advanced Setup](docs/advanced-setup.md).

**Open a new terminal and run `aigent`.** The installer has already wired the managed runner. The first launch runs guided setup; later launches warm-resume, track context pressure, checkpoint, clear, rebind, and continue without an operator command. (In v1.1.0-rc.1 a long session can still stop at the clear step and need a manual `/clear`; see [Evidence and limits](#evidence-and-limits).)

**Prefer an app to a terminal?** The same install creates the AIgent app/shortcut where supported. Open it instead of typing `aigent`. See [`launcher/README.md`](launcher/README.md).

**Optional:** open the `vault/` folder in [Obsidian](https://obsidian.md) to see your AI's knowledge graph visually.

Full setup walkthrough: [Getting Started](docs/getting-started.md) · Advanced config: [Advanced Setup](docs/advanced-setup.md)

### If something doesn't boot

- **No Node.js installed:** the default install stops because managed Auto-Refresh is the default. Install Node.js 18+ and rerun `bash install.sh`; use `--no-deps` only when you deliberately want the unmanaged fallback.
- **Windows, and `bash: command not found`:** `install.sh` needs a real bash. Install [Git for Windows](https://git-scm.com) (bundles Git Bash), then reopen your terminal and retry; PowerShell alone can't run it.
- **Anything else:** `bash scripts/doctor.sh` diagnoses hooks, settings, semantic search, and runtime state in one pass. See [Getting Started § Troubleshooting](docs/getting-started.md).

---

## 🗂 Repo Map

```
system/                            The 16-document operating kernel (00_identity → 15_somatic_layer)
vault/                             Persistent memory and knowledge graph (markdown, Obsidian-native)
vault/agents/                      Instrument roster: 9 named sub-agents
skills/                            Claude Code slash-command skills (60+ source templates)
hooks/                             Automation hook scripts (session summary, token tracking, compact nudge)
daemons/                           Background helpers (Auto-Refresh transport, Caddy, semantic search, runtime state)
docs/                              Setup guides, doctrine references, architecture roadmaps
memory/                            Ledger templates (SKILL_LEDGER, SKILL_GAPS, SKILL_CHAINS, facts/)
memory/runtime/                    Cognitive layer (ACTIVE_STATE, SELF_MODEL, GOAL_STACK, BELIEF_STATE)
evals/                             Evaluation test definitions (skill-recall, contradiction, capsule-resume)
install.sh                         Installer (preview first: bash install.sh --dry-run)
```

> **Skills path note:** `skills/` contains source templates; the installer copies them to `.claude/skills/`, where Claude Code looks for slash commands at runtime. Manually added skills go in `.claude/skills/<name>/SKILL.md`.

---

## 🔄 Auto-Refresh: autonomous memory and context management

Auto-Refresh now ships in this repository as a managed local transport. Its user-visible rule is deliberately small:

```text
context pressure rises
→ request one /context-capsule
→ observe exactly one "Capsule Complete, Ready For Clear"
→ submit exactly one /clear
→ observe a fresh source=clear SessionStart identity
→ submit exactly one resume wake
→ load prior work, re-ground, and continue
```

**No acknowledgement means no clear. One acknowledgement buys one clear.** Busy or idle is not a readiness decision: command text and a protected, separately written Enter ride Claude Code's native queued-prompt path and execute when the current turn releases the composer.

### What owns each leg

- `daemons/ctx-telemetry.mjs` records the current context percentage.
- `daemons/auto-clear-transport.mjs` owns the persisted one-cycle authorization and at-most-once clear intent.
- `daemons/pty-runner.mjs` is the sole PTY writer. It queues operator input while automatic command text owns the composer.
- `skills/context-capsule/SKILL.md` writes and verifies the resume-ready capsule, then emits the exact acknowledgement literal.
- `daemons/boot-receipt.mjs` and `daemons/sessionstart-reinject.mjs` provide the fresh SessionStart receipt.
- `daemons/resume-verb.mjs` loads the newest valid capsule as historical work state. The live SessionStart hook ID is the current identity; capsule text and the disk receipt never substitute for it.

The transport writes slash-command text and Enter separately. It also clears stale composer text before `/clear`, protects the wake text/Enter pair, refuses duplicate clear intent, and stops loudly on physical write or identity failures. It does not add an automatic retry after an ambiguous submission.

### Installation and fallback

`bash install.sh` installs the transport's single runtime dependency, `node-pty`, when Node.js 18+ is present. The launchers use the managed runner by default. If the dependency cannot load, Claude still starts, checkpointing and recovery remain available, and the launcher reports that automatic clear is unavailable rather than pretending the managed path is active.

A `--no-deps` install intentionally selects that unmanaged fallback.

### Release evidence

The release candidate completed **11 of 11 observed refresh transport transactions** on one Windows reference seat in one live run: three setup transactions and eight transactions after the test objective began. Every observed transaction produced one capsule request, one acknowledgement, one clear, and one fresh SessionStart identity, with zero stranded acknowledgements and zero duplicate clears.

The accelerated observation harness then failed outside the transport: the model appended several remaining test-witness lines inside one unchanged session and declared the synthetic test complete. That invalidated the harness's proposed 20-cycle bookkeeping claim; it did not produce a failed refresh transaction. The harness used an intentionally low pressure threshold to exercise the mechanism rapidly. Normal users do not run the witness-file protocol.

This is bounded single-seat release evidence, not a fleet-reliability or "20/20" claim. The executable transport files in this public release are the same files used for the successful observed transactions. The companion paper reports the same result as hypothesis H2: [PAPER.md](https://github.com/wrg32786/governed-agent-organizations/blob/main/PAPER.md) and the [continuity and Auto-Refresh case study](https://github.com/wrg32786/governed-agent-organizations/blob/main/case-studies/continuity-and-auto-refresh.md).

**Known limitation (v1.1.0-rc.1):** automatic refresh is not yet proven clean end to end on a managed install. A long session can hold at the clear step and need a human to clear by hand; the repairs are in review on [PR #62](https://github.com/wrg32786/aigent-os/pull/62). Before clearing by hand, check that the latest capsule and any work in flight are preserved.

See [`docs/two-verb-lifecycle.md`](docs/two-verb-lifecycle.md) for the lifecycle and identity contract.


---

## 👀 What a session actually looks like

### Day one: the it-remembers-me moment

```text
[first Claude Code session after install]

AI:  I'm your AIgent operator. Let's get you one real win in the next few minutes.
     In a sentence or two, what's your business, or the work you want help running?

You: I run a bookkeeping practice for trades: electricians, plumbers, HVAC.

AI:  Got it. What's the one outcome that would make this month a win?

You: Five new clients, without working weekends.

AI:  And what do you spend the most time on that you wish just ran itself?

You: Chasing leads. I'm always the one following up.

AI:  Here's what I know about you: you run a bookkeeping practice for trades, you
     want five new clients this month without working weekends, and chasing leads
     eats your time.

     Three things I'd do first:
     1. Draft a week of outreach to local trade businesses, so lead-chasing
        runs without you.
     2. Build a "new client" intake that collects everything you need before
        the first call.
     3. Turn last month's finished jobs into three referral asks.

     Pick one and we'll do it right now.
```

That's `/operator-setup`: three plain questions, on first run only, and the answers are written to memory so every session after opens already oriented around *your* business, not a generic template. Nothing here is invented; it only reflects what you actually said.

### Every session after: resumes itself

```text
[new Claude Code session, nothing typed]

AI:  3 open threads from yesterday.
     - Outreach batch: 12 of 20 trade businesses contacted, 3 replies waiting on you
     - New-client intake form drafted, needs your sign-off before it goes out
     - Referral asks: 2 of 3 sent, the HVAC client still pending

     Active priorities:
     1. Five new clients this month (2 now in the pipeline)
     2. Lead follow-up runs without you (outreach batch in progress)
     3. Month-end close for existing clients (starts Thursday)

     Last session you were drafting the intake form.
     Want to finish that, or handle the 3 outreach replies first?

You: replies first. Quote them the standard monthly rate.

AI:  Locked. Drafting replies to all 3 with the standard rate, and
     logging the pricing call in DECISION_LOG. Reasoning captured:
     one consistent rate beats per-job haggling for trades, and you
     said no weekends. Want the intake form linked in the replies,
     or is it not ready to send?

You: not yet.

AI:  Got it. Replies go out without it. Anything else
     before we move on?

[... 90 minutes of work ...]

[you close the terminal, nothing typed]

[capsule fires automatically: reconciles the session, writes to vault/daily/2026-04-25.md]

     What got decided today:
     - Standard monthly rate quoted to all new trade leads. Logged.
     - Intake form holds until your sign-off.

     Open threads carrying to next session:
     - HVAC referral ask still pending
     - Intake form sign-off

     See you tomorrow.
```

That's the loop, except you never typed either verb. `resume` → work → `capsule`, both automatic, both still callable by hand when you want to force one. The vault remembers everything. Next session picks up exactly where you left off. See [`vault/examples/`](vault/examples/) for what populated content actually looks like.

---

## 🎯 Who this is for

aigent-OS is built for **principals running complex parallel work**, not for developers building agent pipelines.

- **Claude Code users with long-running sessions** who want the work to continue across context limits without compaction or re-briefing.
- **Solo founders** juggling product, hiring, fundraising, and ops simultaneously.
- **Technical leads** managing multiple workstreams across teams.
- **Operators** in any role where the job is to make decisions, route work, and not lose context.

If you've ever closed your laptop on Friday and opened it Monday wondering what the hell you were in the middle of, that's the problem this solves.

If you're building an agent framework for end-users to consume, you probably want LangChain or CrewAI instead. aigent-OS optimizes for **one principal, many threads, persistent context**, and ships a [branded desktop launcher](launcher/README.md) for exactly that: install once, and every session after starts from a double-clicked icon, not a `cd` and a remembered command.

---

## 🔀 Agent Routing and Multi-LLM Execution

### Today

- **Model-tier dispatch enforcement**: `system/09_subagent_manifest.md` names which tier (Fast/Mid/Frontier) each agent should run at; `daemons/model-tier-guard.mjs`, a `PreToolUse` hook, checks every `Agent`-tool dispatch against that declared tier live. Default is advisory (prints a named correction, never blocks, matching this repo's own suggest-don't-block hook doctrine); `AIGENT_MODEL_GUARD=enforce` opts into a hard `decision:block` gate. Scope: Agent-tool dispatches in one session, not the separate-instance or scheduled deployment models in [`docs/creating-agents.md`](docs/creating-agents.md). Design: [`docs/model-routing-enforcement.md`](docs/model-routing-enforcement.md).
- **Codex adapter**: `daemons/codex-adapter.sh` routes one bounded, mechanical task to the [Codex CLI](https://developers.openai.com/codex)'s non-interactive `codex exec` mode: the first working non-Claude executor. Generic config surface (`AIGENT_CODEX_BIN`, no hardcoded paths), never commits or pushes; every run writes a working-tree diff for review under the same gate as any sub-agent's output. Skill: [`skills/codex-adapter/SKILL.md`](skills/codex-adapter/SKILL.md). Design: [`docs/codex-adapter.md`](docs/codex-adapter.md).

### Next

- **Route by task class, not just one class.** The Codex adapter proves the shape for one bounded task type; generalizing to route by task class (and to wire additional CLIs, such as Gemini CLI, opencode, and others, behind the same interface) is the next step.
- Every rival harness surveyed locks you to one vendor's model. This one is built to route across them once that generalization ships.

---

## 🏗 Architecture

<div align="center">
<img src="assets/architecture.gif" alt="aigent-OS Architecture: Principal to the AIgent to Sub-agents to Vault to Hooks" width="100%"/>
</div>

**16 system documents** (`00_identity` → `15_somatic_layer`) are a complete operating manual: how the AI thinks, decides, delegates, remembers, and manages time. Not prompts; a kernel. Full index: [`system/`](system).

**Hooks are the nervous system**: shell/Node scripts on Claude Code's session events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, `SessionEnd`). Auto-capture, session summaries, token tracking, compact nudges, the model-tier guard above, and the [zero-leak flush legs](docs/zero-leak-flush.md) that keep the capsule at most one turn stale across crashes, clears, and compaction all live here.

**Semantic search** runs locally (`all-MiniLM-L6-v2`, no API calls, no data leaves your device): `node daemons/semantic-search/search-vault.js "what did we decide about pricing"` searches your vault by meaning, not keywords.

---

## 🔑 Key Concepts

<div align="center">
<img src="assets/authority-matrix.svg" alt="The Authority Matrix: Level 1 Autonomous, Level 2 Recommend & Confirm, Level 3 Human Only" width="49%"/>
<img src="assets/caddy-router.svg" alt="Caddy: automatic skill routing pipeline" width="49%"/>
<br/>
<img src="assets/somatic-layer.svg" alt="Somatic Layer: 5 pressure gauges for self-awareness" width="49%"/>
<img src="assets/self-learning-loop.svg" alt="Self-Learning Loop: failure to artifact pipeline" width="49%"/>
</div>

**Vault as brain.** Your AI's memory is an Obsidian vault, not a vector database, the same files you can open, read, search, and navigate yourself. Wikilinks (`[[Project Alpha]]`) build the knowledge graph your AI actually navigates. `resume` reads it, `capsule` writes to it, both fire on their own: see [Auto-Refresh](#-auto-refresh-autonomous-memory-and-context-management) above for exactly what gets committed and when. See the [two-verb lifecycle doc](docs/two-verb-lifecycle.md) for the full write-ahead/flush contract.

> **Testing isolation:** scripting `claude` child sessions inside your vault directory means their Stop autosaves write *real* capsules into your *real* vault. Point automated children at a scratch root via `AIGENT_ROOT`.

**Measurement layer.** Most agent frameworks let the AI talk; almost none measure how often it's confidently wrong. `HONESTY_LEDGER.md`, `TRUST_DECAY.md`, and `FAILURE_MODES.md` are paired ledgers (a claim captured, then resolved later as held/drifted/reversed) plus drift detection at `resume` (decision aging, attention reconciliation vs. `ACTIVE_PRIORITIES.md`). The credible claim: the framework measures its own AI's calibration over time, not just its output. A `Stop` hook closes the loop by noticing when a turn made confident claims that no ledger recorded, so the ledgers fill from real work instead of waiting to be remembered: [Closing the Measurement Loop](docs/closing-the-measurement-loop.md). Full doctrine: [`vault/concepts/Cost of Confidence.md`](vault/concepts/Cost%20of%20Confidence.md).

**Caddy: the skill that finds the right skill.** A non-blocking `UserPromptSubmit` hook matches your words against every skill in your catalog and surfaces the one that fits, without ever blocking the turn on a wrong guess. A `PostToolUse` hook detects a newly dropped skill and nudges `/caddy-enroll` to index it; the golf bag stays complete without manual upkeep.

**Self-aware about what it doesn't do yet.** `system/12_authority_matrix.md` bounds what the AI decides alone vs. brings to you; `/dream` proposes improvements but only the operator approves merges: see [`docs/meta-aigent-doctrine.md`](docs/meta-aigent-doctrine.md) for the safety boundary.

---

## 🎨 Make It Yours

aigent-OS is opinionated but built to be forked.

**Start here (10 minutes):**
1. `system/00_identity.md`: tell it who you are
2. `system/14_decision_framework.md`: encode how YOU make decisions
3. `system/12_authority_matrix.md`: set boundaries that match YOUR risk tolerance

**Then build over time:** add your projects to `vault/projects/`, your people to `vault/people/`, drop concepts into `vault/concepts/`. The vault grows with every session; it compounds.

---

## 🔁 How this repo maintains itself

The most differentiating thing about aigent-OS isn't a feature; it's that the framework operates on itself. What ships today is the maintenance half: a nightly self-maintenance routine you can run against your own vault, and a hook that spots a new skill file and prompts you to enroll it. aigent-OS installs no scheduler, so the nightly routine runs when you or your own cron entry runs it. Releases are recorded by hand in [`CHANGELOG.md`](CHANGELOG.md).

The publish half is designed but not built. The intended shape is a skill that classifies each vault file (`private: true | false | review` frontmatter, defaulting new files to `review`), tests it against a genericity bar (useful to at least three radically different principals, or it stays private), secret-scans it, drafts the commit, and opens the PR. **None of that exists yet:** no file carries the flag, no code reads it, and deciding what graduates from a local install into this repo is a manual judgement call today. No plan in this repo schedules the skill itself; the nearest related item is a proposed public-content lint that would keep files marked `private: true` out of release artifacts ([`docs/review-hardening-plan.md`](docs/review-hardening-plan.md)). Full manifesto, including why the recursive layer is the category claim: [`docs/manifesto.md`](docs/manifesto.md).

---

## ❌ What This Isn't

**Not a chatbot skin.** No personality prompts, no "you are a helpful assistant": operational infrastructure.

**Not a code framework.** No database, no server, no build step. The kernel is markdown; the installer needs Node.js 18+ for the refresh runner and local search.

**Not a RAG system.** The vault is human-readable by design: open Obsidian, don't query an embedding store.

**Not another agent framework.** LangChain and CrewAI are for developers building pipelines. aigent-OS is for principals who want an AI that actually operates, one operator, one Claude, at a time.

---

## 🛣 Roadmap

Explicitly non-normative: nothing below is claimed as shipped, and none of it appears in the tables above until it is.

- **Self-testing of one's own operating rules**: a portable subset of the probe idea, scoped to testing one seat's own shipped mechanisms against its own doctrine.
- **A generic recurring-task primitive**: a portable tick/heartbeat structure for "run this on a cadence," session-hook-driven today, wall-clock-driven as the next step. Structure only, no built-in business-specific firers, and no coupling to any multi-agent coordination substrate.
- **Codex adapter generalization**: routing by task class, and additional non-Claude CLIs behind the same interface (see [Agent Routing and Multi-LLM Execution](#-agent-routing-and-multi-llm-execution) above).
- **`vault-sync.mjs` path-scoping polish**: tightening the memoryPaths exists-filter at the edges of what counts as "durable memory" for a sync commit.

One structural note, since it comes up: everything in this repo is scoped to a single operator running a single Claude session at a time. The vault, the capsule lifecycle, Caddy, and the routing/execution primitives above are the kind of building blocks a multi-operator, multi-agent layer would sit on top of; that layer is not part of this repo.

---

## 🤝 Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for what lands well and how to write rules that fit the existing style. Highest-value areas: decision framework lenses for new domains, hook scripts for additional Claude Code events, vault templates, integration guides, sanitized examples for [`vault/examples/`](vault/examples/).

See [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## 🌐 The AIgent

aigent-OS is the free, open-source harness of [The AIgent](https://theaigent.xyz), a media project for people building with AI. The rest of what's free to take lives at the [public tools](https://tools.theaigent.xyz).

---

<div align="center">

### 📄 [MIT License](LICENSE): Use it however you want.

<br/>

Built by **[The AIgent](https://theaigent.xyz)**

*In daily production use since April 2026, running a real media business.*
*This framework emerged from real operational needs, not theory.*

<br/>

**If this saves you time, star the repo. That's all the thanks needed.**

</div>
