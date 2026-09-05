#!/bin/bash
# reflex-sweep.sh — Autonomic: surface sweep prompt when Hestia is overdue (>7d)
# UserPromptSubmit hook. Silent when sweep is current.
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
HESTIA_LOG="$MEMORY_ROOT/HESTIA_SWEEP_LOG.md"
[ -f "$HESTIA_LOG" ] || { echo "[SOMATIC:sweep] Hestia sweep log missing — run /sweep-now"; exit 0; }
LAST_DATE=$(grep -oP '\d{4}-\d{2}-\d{2}' "$HESTIA_LOG" | tail -1)
[ -z "$LAST_DATE" ] && { echo "[SOMATIC:sweep] No sweep dates found — run /sweep-now"; exit 0; }
DAYS=$(python3 -c "from datetime import datetime,timezone; print((datetime.now(timezone.utc)-datetime.strptime('$LAST_DATE','%Y-%m-%d').replace(tzinfo=timezone.utc)).days)" 2>/dev/null)
[ "${DAYS:-0}" -gt 7 ] && echo "[SOMATIC:sweep] Hestia overdue (${DAYS}d) — run /sweep-now"
exit 0
