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
if [ ! -f "$marker" ]; then
  mkdir -p "$(dirname "$marker")"
  claude "/start"
  [ -f "$marker" ] || : > "$marker"
else
  claude --continue "/open"
fi

printf "\n  Tip: next time, say \"close up\" before you quit — your AIgent banks the session so it remembers everything.\n\n"
