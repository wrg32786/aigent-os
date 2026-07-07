#!/bin/bash
# Track tool calls per session and suggest /clear at threshold
# Use a session-stable key instead of $$ (PID changes every invocation).
# CLAUDE_SESSION_ID is set by Claude Code; fall back to a hash of PWD for shells without it.
SESSION_KEY="${CLAUDE_SESSION_ID:-$(echo "$PWD" | md5sum | cut -c1-8)}"
COUNTER_FILE="/tmp/claude-tool-counter-${SESSION_KEY}"
if [ ! -f "$COUNTER_FILE" ]; then
  echo "0" > "$COUNTER_FILE"
fi

COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

THRESHOLD=${COMPACT_THRESHOLD:-50}
if [ "$COUNT" -eq "$THRESHOLD" ]; then
  echo "[EFFICIENCY] $COUNT tool calls this session. Consider /clear if switching topics to free context."
fi
