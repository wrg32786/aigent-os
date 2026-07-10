#!/usr/bin/env bash
# Hook: PostToolUse — capture privacy-safe action metadata in the daily note.
# hooks/tool-tracker.js intentionally omits raw commands, content, and queries.

set -u
umask 077

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TODAY="$(date +%Y-%m-%d)"
DAILY="$ROOT/vault/daily/$TODAY.md"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER="$SCRIPT_DIR/tool-tracker.js"

INPUT="$(cat 2>/dev/null)"
[[ -n "$INPUT" ]] || exit 0
[[ -f "$TRACKER" ]] || exit 0
command -v node >/dev/null 2>&1 || exit 0

CAPTURE="$(printf '%s' "$INPUT" | node "$TRACKER" 2>/dev/null)"
[[ -n "$CAPTURE" ]] || exit 0

mkdir -p "$(dirname "$DAILY")"

if [[ ! -f "$DAILY" ]]; then
  cat > "$DAILY" <<EOF_NOTE
---
title: "$TODAY"
tags:
  - daily
date: $TODAY
---

# $TODAY

## Session Captures
$CAPTURE
EOF_NOTE
elif grep -q '^## Session Captures$' "$DAILY" 2>/dev/null; then
  printf '%s\n' "$CAPTURE" >> "$DAILY"
else
  printf '\n## Session Captures\n%s\n' "$CAPTURE" >> "$DAILY"
fi
