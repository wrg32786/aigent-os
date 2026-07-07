#!/bin/bash
# reflex-sweep.sh — Autonomic: surface sweep prompt when Hestia is overdue (>7d)
# UserPromptSubmit hook. Silent when sweep is current.
ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
HESTIA_LOG="$ROOT/memory/HESTIA_SWEEP_LOG.md"
[ -f "$HESTIA_LOG" ] || { echo "[SOMATIC:sweep] Hestia sweep log missing — run /sweep-now"; exit 0; }
LAST_DATE=$(grep -oP '\d{4}-\d{2}-\d{2}' "$HESTIA_LOG" | tail -1)
[ -z "$LAST_DATE" ] && { echo "[SOMATIC:sweep] No sweep dates found — run /sweep-now"; exit 0; }
DAYS=$(python3 -c "from datetime import datetime,timezone; print((datetime.now(timezone.utc)-datetime.strptime('$LAST_DATE','%Y-%m-%d').replace(tzinfo=timezone.utc)).days)" 2>/dev/null)
[ "${DAYS:-0}" -gt 7 ] && echo "[SOMATIC:sweep] Hestia overdue (${DAYS}d) — run /sweep-now"
exit 0
