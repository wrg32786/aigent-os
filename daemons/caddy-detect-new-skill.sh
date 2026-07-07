#!/bin/bash
# caddy-detect-new-skill.sh - PostToolUse hook for Write/Edit
# When a SKILL.md or skill .md is written in a skills/ directory,
# check if it's in the Caddy index. If not, emit a nudge for /caddy-enroll.
#
# Runs after Write/Edit tool calls. Non-blocking. Silent if already enrolled.

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
INDEX="$ROOT/.claude/skill-index.json"

INPUT=$(cat 2>/dev/null)
[ -z "$INPUT" ] && exit 0

# Pass raw input via env var to avoid quote/injection issues with triple-quote interpolation
CADDY_DETECT_INPUT="$INPUT" CADDY_INDEX_PATH="$INDEX" python3 <<'PYEOF' 2>/dev/null || exit 0
import sys, json, os, re

raw = os.environ.get("CADDY_DETECT_INPUT", "")
try:
    payload = json.loads(raw) if raw.strip().startswith("{") else {}
except Exception:
    payload = {}

tool_name = payload.get("tool_name", "")
if tool_name not in ("Write", "Edit"):
    sys.exit(0)

tool_input = payload.get("tool_input", {})
file_path = tool_input.get("file_path", "")
if not file_path:
    sys.exit(0)

file_path_norm = file_path.replace("\\\\", "/").lower()

if "/skills/" not in file_path_norm:
    sys.exit(0)
if not file_path_norm.endswith(".md"):
    sys.exit(0)

parts = file_path_norm.split("/skills/", 1)[1].split("/")
if parts[-1] == "skill.md" and len(parts) >= 2:
    skill_name = parts[-2]
elif parts[-1].endswith(".md"):
    skill_name = parts[-1][:-3]
else:
    sys.exit(0)

if skill_name in ("readme", "license", "changelog") or skill_name.startswith("_"):
    sys.exit(0)

index_path = os.environ.get("CADDY_INDEX_PATH", "")
try:
    with open(index_path, "r", encoding="utf-8") as f:
        skills = json.load(f)
except Exception:
    sys.exit(0)

existing_names = {s.get("name","").lower() for s in skills}
if skill_name in existing_names:
    sys.exit(0)

print(f"[CADDY] New skill detected: {skill_name} at {file_path} - run /caddy-enroll to add to the golf bag")
PYEOF

exit 0
