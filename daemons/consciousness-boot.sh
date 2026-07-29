#!/bin/bash
# consciousness-boot.sh — aigent-OS capability manifest loader
# Single responsibility: output a compact summary of what the AIgent IS right now.
# Called by /open. Not a monolith — reads state files, reports, exits.
#
# Output: structured text block that gets included in /open orientation.
# Spec: [[concepts/aigent-OS Refactor Spec]] Phase 3

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DAEMON_ERR_LOG="${ROOT}/memory/.daemon-errors.log"

_GLOBAL_INDEX="$HOME/.claude/skills/skill-index.json"
_REPO_INDEX="$ROOT/.claude/skill-index.json"
[ -f "$_GLOBAL_INDEX" ] && INDEX="$_GLOBAL_INDEX" || INDEX="$_REPO_INDEX"

BODY_STATE="$ROOT/memory/BODY_STATE.json"
HEAT_INDEX="$ROOT/memory/HEAT_INDEX.json"
CANDIDATES="$ROOT/memory/MEMORY_CANDIDATES.md"
HESTIA_LOG="$ROOT/memory/HESTIA_SWEEP_LOG.md"

# ── Skill index health ──────────────────────────────────────────────────────
if [ -f "$INDEX" ]; then
  SKILL_SUMMARY=$(INDEX="$INDEX" python3 <<'PYEOF' 2>>"$DAEMON_ERR_LOG"
import json, os, re
idx = os.environ.get("INDEX","")
if os.name == "nt" and len(idx) > 2 and idx[0] == "/" and idx[2] == "/" and idx[1].isalpha():
    idx = idx[1].upper() + ":" + idx[2:]
try:
    with open(idx) as f:
        data = json.load(f)
    cards = data if isinstance(data, list) else data.get("cards", [])
    active = [c for c in cards if c.get("active", True)]
    print(f"Skills: {len(active)} active / {len(cards)} total")
except Exception as e:
    rendered = re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", " ", str(e))
    if len(rendered) > 500:
        rendered = f"{rendered[:500]}…[+{len(rendered) - 500} chars]"
    print(f"Skills: INDEX ERROR detail={json.dumps(rendered, ensure_ascii=True)}")
PYEOF
  )
else
  SKILL_SUMMARY="Skills: INDEX MISSING — router is blind"
fi

# ── Daemon health ────────────────────────────────────────────────────────────
DAEMON_DIR="$ROOT/daemons"
DAEMONS_WIRED=0
DAEMONS_TOTAL=0
# Check which daemons are referenced in settings.json hooks
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  for daemon in caddy.sh check-comms.sh skill-router.sh; do
    DAEMONS_TOTAL=$((DAEMONS_TOTAL + 1))
    grep -q "$daemon" "$SETTINGS" 2>/dev/null && DAEMONS_WIRED=$((DAEMONS_WIRED + 1))
  done
fi
DAEMON_SUMMARY="Daemons: ${DAEMONS_WIRED}/${DAEMONS_TOTAL} wired in hooks"

# ── Somatic state ────────────────────────────────────────────────────────────
SOMATIC_SUMMARY=$(BODY_STATE="$BODY_STATE" python3 <<'PYEOF' 2>>"$DAEMON_ERR_LOG"
import json, os, re
from datetime import datetime, timezone

LINE_BREAKING = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
def inert(value, maximum=500):
    rendered = re.sub(r"[ \t]+", " ", LINE_BREAKING.sub(" ", str("" if value is None else value))).strip()
    if len(rendered) > maximum:
        rendered = f"{rendered[:maximum]}…[+{len(rendered) - maximum} chars]"
    return json.dumps(rendered, ensure_ascii=True)

body_path = os.environ.get("BODY_STATE", "")
if os.name == "nt" and len(body_path) > 2 and body_path[0] == "/" and body_path[2] == "/" and body_path[1].isalpha():
    body_path = body_path[1].upper() + ":" + body_path[2:]

parts = []
try:
    with open(body_path) as f:
        data = json.load(f)
    state = data.get("state", {})

    # Capsule
    cap = state.get("last_capsule")
    if cap and cap.get("status") == "active":
        parts.append(f"capsule=ACTIVE objective={inert(cap.get('objective', ''))}")

    # Delegation backlog
    deleg = state.get("delegation_open_count", 0)
    if deleg > 5:
        parts.append(f"delegations={deleg} OPEN")

    # Memory candidates
    cand = state.get("memory_candidate_backlog", 0)
    if cand > 0:
        parts.append(f"candidates={cand} STAGED")

    # Recommended reflex
    reflex = state.get("recommended_reflex", "none")
    if reflex != "none":
        parts.append(f"reflex={inert(reflex, 160)}")

    # Comms
    comms = state.get("comms_unread_count", 0)
    if comms > 0:
        parts.append(f"comms={comms} unread")

    if not parts:
        parts.append("nominal")
except FileNotFoundError:
    parts.append("BODY_STATE.json missing")
except Exception as e:
    parts.append(f"error={inert(e)}")

print("Somatic: " + " | ".join(parts))
PYEOF
)

# ── Hestia sweep age ────────────────────────────────────────────────────────
SWEEP_AGE="unknown"
if [ -f "$HESTIA_LOG" ]; then
  LAST_DATE=$(grep -oP '\d{4}-\d{2}-\d{2}' "$HESTIA_LOG" | tail -1)
  if [ -n "$LAST_DATE" ]; then
    DAYS_AGO=$(python3 -c "
from datetime import datetime, timezone
d = datetime.strptime('$LAST_DATE', '%Y-%m-%d').replace(tzinfo=timezone.utc)
print((datetime.now(timezone.utc) - d).days)
" 2>/dev/null)
    SWEEP_AGE="${DAYS_AGO}d ago"
    [ "$DAYS_AGO" -gt 7 ] 2>/dev/null && SWEEP_AGE="${DAYS_AGO}d ago — OVERDUE"
  fi
fi
SWEEP_SUMMARY="Hestia: last sweep $SWEEP_AGE"

# ── Router status ────────────────────────────────────────────────────────────
if grep -q "caddy.sh" "$SETTINGS" 2>/dev/null; then
  ROUTER_STATUS="Router: WIRED (caddy.sh → skill-index.json)"
else
  ROUTER_STATUS="Router: NOT WIRED — skills won't auto-match"
fi

# ── Output manifest ─────────────────────────────────────────────────────────
cat <<EOF
[BOOT] Consciousness manifest loaded.
$SKILL_SUMMARY
$ROUTER_STATUS
$DAEMON_SUMMARY
$SOMATIC_SUMMARY
$SWEEP_SUMMARY
Auto-invoke: ON — when [CADDY:skill] MATCH fires, invoke the skill immediately.
EOF

exit 0
