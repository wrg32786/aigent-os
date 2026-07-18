#!/usr/bin/env bash
# statusline-ctx.sh — statusline wrapper: context-percentage writer.
#
# The writer half of the ctx-refresh contract. On every statusline refresh it
# persists the session's ground-truth context usage for
# daemons/ctx-refresh-sensor.mjs (the readPct contract:
#   ~/.claude/ctx-refresh/<session_id>.json  {"used_percentage": N, "ts": "..."}),
# then delegates the visible status line unchanged.
#
# Wired via .claude/settings.json:
#   "statusLine": { "type": "command", "command": "bash \"__AIGENT_ROOT__/daemons/statusline-ctx.sh\"" }
#
# Passive telemetry only — writes a number to a JSON file; injects nothing,
# changes no session behavior. Degrades to a no-op without jq, and the sensor
# is silently inert without the file, so nothing here can error the lifecycle.
#
# Display delegation: if ~/.claude/statusline-command.sh exists (the
# conventional home of an operator's own statusline script), the visible line
# is delegated to it unchanged — override the path with
# AIGENT_STATUSLINE_DELEGATE. Otherwise a minimal built-in line is shown
# (model name + ctx %).

INPUT=$(cat)

SENSOR_DIR="$HOME/.claude/ctx-refresh"

if command -v jq >/dev/null 2>&1; then
  SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
  PCT=$(printf '%s' "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)

  # Refuse to build a path from a session id that isn't a plain token, and
  # refuse to splice a non-numeric value into the JSON literal below.
  [[ "$SID" =~ ^[A-Za-z0-9_-]+$ ]] || SID=""
  [[ "$PCT" =~ ^[0-9]+(\.[0-9]+)?$ ]] || PCT=""

  if [ -n "$SID" ] && [ -n "$PCT" ]; then
    mkdir -p "$SENSOR_DIR" 2>/dev/null
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Atomic write: tmp + mv so the sensor never reads a torn file.
    printf '{"used_percentage": %s, "ts": "%s"}\n' "$PCT" "$TS" > "$SENSOR_DIR/$SID.json.tmp" 2>/dev/null \
      && mv -f "$SENSOR_DIR/$SID.json.tmp" "$SENSOR_DIR/$SID.json" 2>/dev/null
    # Housekeeping: drop sensor files idle >7 days (session ids rotate on
    # /clear; old files are dead). Only *.json — the sensor's own *.state
    # files are its business, not ours.
    find "$SENSOR_DIR" -name '*.json' -mtime +7 -delete 2>/dev/null
  fi
fi

# Display: delegate to an existing statusline script unchanged, if one is wired.
DELEGATE="${AIGENT_STATUSLINE_DELEGATE:-$HOME/.claude/statusline-command.sh}"
if [ -f "$DELEGATE" ]; then
  printf '%s' "$INPUT" | bash "$DELEGATE"
elif command -v jq >/dev/null 2>&1; then
  # Minimal built-in fallback: model name + context usage. `|| true` so an
  # unparseable payload shows an empty line rather than a failing statusline.
  printf '%s' "$INPUT" | jq -r '
    [(.model.display_name // "Claude"),
     (if .context_window.used_percentage != null
      then "ctx \(.context_window.used_percentage | floor)%" else empty end)]
    | join(" | ")' 2>/dev/null || true
fi
