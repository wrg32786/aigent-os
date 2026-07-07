#!/bin/bash
# reflex-digest.sh — Autonomic: surface digest prompt when candidates are staged
# UserPromptSubmit hook. Silent when nothing to digest.
ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
CANDIDATES="$ROOT/memory/MEMORY_CANDIDATES.md"
[ -f "$CANDIDATES" ] || exit 0
COUNT=$(grep -c "| staged |" "$CANDIDATES" 2>/dev/null || echo 0)
[ "$COUNT" -gt 0 ] && echo "[SOMATIC:digest] $COUNT memory candidates staged — run /digest"
exit 0
