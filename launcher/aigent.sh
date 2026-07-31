#!/usr/bin/env bash
# aigent.sh: The AIgent harness launcher (macOS / Linux front door).
# Type `aigent` (after install adds it to PATH) and your operator wakes up,
# warm-resumed, in a branded session. No flags, no commands to memorize.

set -euo pipefail
CYAN=$'\033[38;2;94;230;208m'; DIM=$'\033[2m'; RESET=$'\033[0m'

AIGENT_HOME="${AIGENT_HOME:-$HOME/aigent}"
if [ ! -d "$AIGENT_HOME" ]; then
  printf "\n  %sTHE AIGENT%s\n  Harness not found at %s.\n  Re-run the installer (or set AIGENT_HOME), then run aigent again.\n" "$CYAN" "$RESET" "$AIGENT_HOME"
  exit 1
fi
cd "$AIGENT_HOME"

printf "\n  %sTHE AIGENT%s\n  %syour operator is waking up...%s\n\n" "$CYAN" "$RESET" "$DIM" "$RESET"

marker="$AIGENT_HOME/.aigent/first-run-done"
claude_status=0

unmanaged=0
forward_operator_args=0
# V5 no-dash-dash unchanged: without the literal separator this stays empty,
# so the fixed /start and --continue /open command shapes do not move.
operator_args=()
for arg in "$@"; do
  # V4 pass-through: --no-deps is the launcher-owned exception and is never
  # handed to Claude, even when it appears after the separator.
  if [ "$arg" = "--no-deps" ]; then
    unmanaged=1
  # V4 pass-through: after the first literal separator, preserve every other
  # argument as one ordered array element.
  elif [ "$forward_operator_args" -eq 1 ]; then
    operator_args+=("$arg")
  # V4 pass-through: only a literal -- opens the forwarded suffix.
  elif [ "$arg" = "--" ]; then
    forward_operator_args=1
  fi
done

launch_claude() {
  if [ "$unmanaged" -eq 1 ]; then
    claude "$@"
  elif ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'DEGRADED:auto-clear-node-unavailable checkpoint/recovery available; auto-clear unavailable; launching unmanaged' >&2
    claude "$@"
  else
    node "$AIGENT_HOME/daemons/pty-runner.mjs" -- "$@"
  fi
}

if [ ! -f "$marker" ]; then
  mkdir -p "$(dirname "$marker")"
  # V5 no-dash-dash unchanged: the [0]+ guard expands to zero words safely
  # under stock macOS Bash 3 + nounset, while preserving a present empty arg.
  launch_claude "/start" ${operator_args[0]+"${operator_args[@]}"} || claude_status=$?
  [ -f "$marker" ] || : > "$marker"
else
  # V5 no-dash-dash unchanged: use the same old-Bash-safe zero-word guard.
  launch_claude --continue "/open" ${operator_args[0]+"${operator_args[@]}"} || claude_status=$?
fi

printf "\n  Tip: next time, say \"close up\" before you quit — your AIgent banks the session so it remembers everything.\n\n"
exit "$claude_status"
