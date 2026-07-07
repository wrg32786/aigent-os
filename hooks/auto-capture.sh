#!/bin/bash
# Hook: PostToolUse — auto-capture meaningful tool actions to daily note
# Reads JSON from stdin, filters to write/execute actions, appends to daily note
# Must be FAST — runs on every tool call

VAULT="${AIGENT_ROOT:-.}"
TODAY=$(date +%Y-%m-%d)
DAILY="$VAULT/vault/daily/$TODAY.md"

# Read stdin (Claude Code sends JSON)
INPUT=$(cat)

# Parse and filter via saved script — skip read-only tools, emit one-line capture
# Pipe via stdin (not argv) to avoid Windows Defender ClickFix.MTB heuristic:
# node.exe <script> <large-JSON-argv> matches attacker payload pattern; stdin does not.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE=$(printf '%s' "$INPUT" | node "$SCRIPT_DIR/tool-tracker.js" 2>/dev/null)

# If nothing to capture, exit silently
[ -z "$CAPTURE" ] && exit 0

# Ensure vault/daily/ directory exists
mkdir -p "$(dirname "$DAILY")"

# Append to daily note — create Session Captures section if needed
if [ ! -f "$DAILY" ]; then
  # Create minimal daily note
  cat > "$DAILY" << EOF
---
title: "$TODAY"
tags:
  - daily
date: $TODAY
---

# $TODAY

## Session Captures
$CAPTURE
EOF
else
  # Check if Session Captures section exists
  if grep -q "## Session Captures" "$DAILY" 2>/dev/null; then
    # Append under existing section (before next ## or end of file)
    echo "$CAPTURE" >> "$DAILY"
  else
    # Add section at end of file
    printf "\n## Session Captures\n%s\n" "$CAPTURE" >> "$DAILY"
  fi
fi
