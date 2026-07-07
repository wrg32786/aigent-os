#!/bin/bash
# reflex-body.sh — Autonomic: surface pressure alerts from BODY_STATE.json
# UserPromptSubmit hook. Silent when all pressures are nominal.
ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
BODY="$ROOT/memory/BODY_STATE.json"
[ -f "$BODY" ] || exit 0

python3 <<'PYEOF' 2>/dev/null
import json, os
path = os.environ.get("BODY", "")
if os.name == "nt" and len(path) > 2 and path[0] == "/" and path[2] == "/" and path[1].isalpha():
    path = path[1].upper() + ":" + path[2:]
try:
    with open(path) as f:
        state = json.load(f).get("state", {})
    alerts = []
    if state.get("context_pressure") in ("high", "critical"):
        alerts.append(f"context_pressure={state['context_pressure']} — consider /context-capsule")
    if state.get("token_pressure") == "high":
        alerts.append("token_pressure=high — route aggressively to haiku")
    reflex = state.get("recommended_reflex", "none")
    if reflex != "none":
        alerts.append(f"recommended_reflex={reflex}")
    if alerts:
        print("[SOMATIC:body] " + " | ".join(alerts))
except:
    pass
PYEOF
exit 0
