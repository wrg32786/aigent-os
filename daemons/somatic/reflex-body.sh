#!/bin/bash
# reflex-body.sh — Autonomic: surface pressure alerts from BODY_STATE.json
# UserPromptSubmit hook. Silent when all pressures are nominal.
ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
BODY="$ROOT/memory/BODY_STATE.json"
[ -f "$BODY" ] || exit 0

BODY="$BODY" python3 <<'PYEOF' 2>/dev/null
import json, os, re
LINE_BREAKING = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
def inert(value, maximum=500):
    rendered = re.sub(r"[ \t]+", " ", LINE_BREAKING.sub(" ", str("" if value is None else value))).strip()
    if len(rendered) > maximum:
        rendered = f"{rendered[:maximum]}…[+{len(rendered) - maximum} chars]"
    return json.dumps(rendered, ensure_ascii=True)
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
        alerts.append(f"recommended_reflex={inert(reflex, 160)}")
    if alerts:
        print("[SOMATIC:body] " + " | ".join(alerts))
except:
    pass
PYEOF
exit 0
