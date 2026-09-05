#!/bin/bash
# reflex-digest.sh — Autonomic: surface digest prompt when candidates are staged
# UserPromptSubmit hook. Silent when nothing to digest.
ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
# Memory root: resolved by daemons/memory-root.cjs, the one resolver every core
# reader and writer shares (declared in .aigent/state.json, default vault/memory).
# A broken declaration is reported on stderr and this best-effort script exits
# without writing anywhere.
SELF_DIR=$(dirname "$0")
SELF_DIR=$(cd "$SELF_DIR/.." && pwd)
. "$SELF_DIR/memory-root.sh"
MEMORY_ROOT="$(aigent_memory_root "${AIGENT_STATE_HOME_DIR:-$ROOT}" 2>&1)" \
  || { printf '%s\n' "$MEMORY_ROOT" >&2; exit 0; }
CANDIDATES="$MEMORY_ROOT/MEMORY_CANDIDATES.md"
[ -f "$CANDIDATES" ] || exit 0
COUNT=$(grep -c "| staged |" "$CANDIDATES" 2>/dev/null || echo 0)
[ "$COUNT" -gt 0 ] && echo "[SOMATIC:digest] $COUNT memory candidates staged — run /digest"
exit 0
