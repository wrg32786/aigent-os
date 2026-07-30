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
for arg in "$@"; do
  [ "$arg" = "--no-deps" ] && unmanaged=1
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
  launch_claude "/start" || claude_status=$?
  [ -f "$marker" ] || : > "$marker"
else
  launch_claude --continue "/open" || claude_status=$?
fi

printf "\n  Tip: next time, say \"close up\" before you quit — your AIgent banks the session so it remembers everything.\n\n"
exit "$claude_status"
