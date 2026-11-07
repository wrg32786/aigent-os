#!/bin/bash
# prompt-context.sh: the UserPromptSubmit hook (replaces Caddy, 2026-11-05).
#
# Caddy matched every prompt against the skill index with dozens of sequential grep pipelines.
# Measured on a Windows host it took 13 to 22 s per prompt and was cancelled at its limit on nearly
# every prompt, so its hints never reached the agent. Claude Code now matches skills natively from
# each skill's `description`, so this hook keeps only what Caddy did that nothing else does:
#   1. [CLOCK]: sessions know the date but not the time of day.
#   2. Memory capture: daemons/memory-capture.sh stages "remember this" phrases into this
#      install's memory candidates. It runs DETACHED, so it never delays the prompt.
#
# BUILT-INS ONLY until the detached capture. Under Git Bash every $(...), pipe or external command
# is a Windows process start (0.1 to 0.7 s each on the measured host); printf %(...)T and read start
# nothing. tests/test-prompt-context.sh runs the synchronous path with an empty PATH to hold this.
# Never fails the prompt: every branch exits 0.
# printf %(...)T is bash 4.2+. macOS ships /bin/bash 3.2, where process starts are cheap, so one
# date call there is fine (tests/test-prompt-context.sh holds both branches).
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 2) )); then
  printf '[CLOCK] %(%A %Y-%m-%d %I:%M %p %Z)T\n' -1
else
  printf '[CLOCK] %s\n' "$(date +'%A %Y-%m-%d %I:%M %p %Z')"
fi

IFS= read -r -d '' INPUT || true
ROOT="${AIGENT_ROOT:-}"
if [[ -z $ROOT ]]; then
  ROOT="${BASH_SOURCE[0]%/*}/.."
fi
CAPTURE="$ROOT/daemons/memory-capture.sh"
[[ -f $CAPTURE ]] || exit 0
# Detached: the prompt on stdin; stdout and stderr away from the hook so it returns at once.
AIGENT_ROOT="$ROOT" bash "$CAPTURE" <<<"$INPUT" >/dev/null 2>&1 &
disown 2>/dev/null
exit 0
