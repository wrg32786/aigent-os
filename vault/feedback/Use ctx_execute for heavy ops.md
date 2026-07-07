---
title: Use ctx_execute for heavy ops
tags:
  - feedback
  - discipline
  - context-management
  - mcp
aliases:
  - ctx_execute discipline
  - context-mode routing rule
created: 2026-05-02
---

# Use ctx_execute for heavy ops

> [!info] Source
> The AIgent ignored context-mode PreToolUse hints repeatedly — defuddle pulls, log scans, JSON processing all ran through raw Bash. Every raw output went into context window. The hook was right; the AIgent didn't listen.

## The rule

When a Bash command is likely to produce >20 lines OR involves processing JSON / parsing logs / fetching URLs, route through `ctx_execute` or `ctx_fetch_and_index` instead of raw Bash.

## Why

Every raw Bash output goes into the AIgent's context window. context-mode's `ctx_execute` runs in a sandbox — only your printed summary enters context. The PreToolUse hook has been configured to fire on heavy ops. Ignoring it burns tokens for no reason.

## When to use ctx_execute

- Defuddle URL pulls — use `ctx_fetch_and_index` instead. Auto-indexes for later `ctx_search`.
- JSON/log processing — `ctx_execute language=javascript` or `language=python`
- Multi-file scans / counts
- Any command where raw output >20 lines AND you only need a summary

## When raw Bash is fine

- `git status`, `git log`, `git diff` (short outputs)
- `mkdir`, `mv`, `rm`, navigation
- Single-line outputs
- Anything where you need the full output in context to make an edit decision

## Caddy hook

**Trigger pattern:**
```
defuddle parse|cat .*\.log|cat .*\.output|head -|tail -|grep -A|grep -B|find .* -exec
```

**Surface:** `[CADDY] CTX — heavy bash op detected. Route through ctx_execute / ctx_fetch_and_index instead of raw Bash to keep output out of context window.`

**Status: ENROLLED.** Wired into `daemons/caddy.sh`. Standing rule, not suggestion.

## Links

- Tool: [[Context Mode]]
- Reinforces: [[Model routing discipline]] (token efficiency)
