---
title: Codex Adapter -- Multi-LLM Execution Stub
tags: [doctrine, routing, multi-llm, codex]
aliases: [codex-adapter, multi-llm execution]
created: 2026-07-24
---

# Codex Adapter -- Multi-LLM Execution Stub

> [!abstract] Core idea
> aigent-OS has always been Claude-only for execution. `daemons/codex-adapter.sh` is the first working path for a non-Claude executor: it routes ONE bounded, mechanical task to the [Codex CLI](https://developers.openai.com/codex)'s non-interactive `codex exec` mode, under the same review-before-merge discipline as any sub-agent's diff.

## What "stub" means here

This is a single task class routed to a single executor, not a general multi-LLM router. It proves the shape works end to end -- config surface, non-interactive invocation, review artifact -- for one honest slice of "vendor-agnostic execution." Generalizing to route by task type, or to wire additional CLIs (Gemini CLI, opencode, etc.) behind the same interface, is explicitly future work; see the Roadmap in `README.md`.

## Config surface

- `AIGENT_CODEX_BIN` (env, default `codex`) -- path or name of the Codex CLI binary. No path is ever hardcoded; a fork or CI environment with Codex installed somewhere non-standard sets this one variable.
- `--dir <path>` -- working directory the task runs in.
- `--sandbox <mode>` -- passed through to `codex exec --sandbox` (default `workspace-write`).

## Invocation

```bash
AIGENT_CODEX_BIN=codex bash daemons/codex-adapter.sh \
  "Add a .gitignore entry for *.tmp files" --dir .
```

`codex exec` runs non-interactively -- no human approval prompts, matching CI/scripted use. `--skip-git-repo-check` is passed by default so the adapter also works against a plain directory, not only a git checkout (though the review-diff step only produces output when the target IS a git repo).

## The review gate

Nothing here commits or pushes. Every run writes to `<dir>/.aigent/codex-runs/<UTC-timestamp>/`:

| File | Contents |
|---|---|
| `output.log` | Raw `codex exec` transcript |
| `review.diff` | Working-tree diff -- tracked changes plus a synthetic `--no-index` diff per new untracked file, so a task that adds files still shows up |
| `status.txt` | `git status --porcelain` for the same tree |

`review.diff` is generated without ever staging anything in the real index (`git diff --no-index` against `/dev/null` for untracked files) -- a task run through this adapter can never disturb whatever the operator already had staged.

## Skill wrapper

`skills/codex-adapter/SKILL.md` documents when this is (and isn't) a good fit and walks through the invocation + review steps for the operating Claude. Caddy surfaces it via `.claude/skill-index.json`'s `codex-adapter` entry.

## Testing

`tests/test-codex-adapter.sh` -- missing-binary, missing-task, bad-`--dir`, success path (git repo, verifies both `output.log` and `review.diff` content), non-git target dir, and Codex's own exit code passing through unchanged. Runs against a fake `codex` stub on `PATH`, so it never depends on the real CLI being installed.
