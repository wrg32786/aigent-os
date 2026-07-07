#!/bin/bash
# aigent-OS Doctor
# Diagnoses install health. Exit 0 = no FAILs. Exit 1 = at least one FAIL.
# Usage: bash scripts/doctor.sh [aigent-root-path] [--fix]
#
# By default this script is READ-ONLY -- it reports missing dirs/files as WARN but does not create them.
# Pass --fix to enable mutation (mkdir for missing vault dirs, etc.).
#
# Checks:
#   - aigent-OS root detected
#   - system kernel present
#   - vault present
#   - CLAUDE.md present
#   - skills present
#   - hooks present
#   - .claude/settings.json present and AIGENT_ROOT placeholder resolved
#   - Node.js available (optional)
#   - semantic search node_modules present (if Node available)
#   - all shell scripts pass bash -n syntax check
#   - all JSON files parse cleanly

set -euo pipefail

# -- Parse args ----------------------------------------------------------------
ROOT=""
FIX=0
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    -*) ;;  # ignore unknown flags
    *) [ -z "$ROOT" ] && ROOT="$arg" ;;
  esac
done
if [ -z "$ROOT" ]; then
  # Try env var, then try to find markers in cwd / parent
  if [ -n "${AIGENT_ROOT:-}" ] && [ -d "$AIGENT_ROOT" ]; then
    ROOT="$AIGENT_ROOT"
  elif [ -f "$(pwd)/system/00_identity.md" ]; then
    ROOT="$(pwd)"
  elif [ -f "$(pwd)/../system/00_identity.md" ]; then
    ROOT="$(cd "$(pwd)/.." && pwd)"
  fi
fi

# -- Counters ------------------------------------------------------------------
PASS=0
WARN=0
FAIL=0

pass()  { echo "  [ok]   $1"; PASS=$((PASS + 1)); }
warn()  { echo "  [warn] $1"; WARN=$((WARN + 1)); }
fail()  { echo "  [fail] $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "  aigent-OS Doctor"
echo "  ----------------------------------------"

# -- 1. Root detection ---------------------------------------------------------
if [ -z "$ROOT" ]; then
  fail "aigent-OS root not found -- run from install dir, pass path as arg, or set AIGENT_ROOT"
  echo ""
  echo "  Summary: ${PASS} PASS, ${WARN} WARN, ${FAIL} FAIL"
  exit 1
fi

pass "aigent-OS root: $ROOT"

# -- 2. System kernel ----------------------------------------------------------
if [ -f "$ROOT/system/00_identity.md" ]; then
  pass "system kernel found (system/00_identity.md)"
else
  fail "system/00_identity.md missing -- kernel not installed"
fi

# -- 3. Vault ------------------------------------------------------------------
if [ -d "$ROOT/vault" ]; then
  pass "vault found"
else
  warn "vault/ directory missing -- memory layer not installed (may be intentional for fresh setup)"
fi

if [ -d "$ROOT/vault/daily" ]; then
  pass "vault/daily/ found"
elif [ "$FIX" -eq 1 ]; then
  mkdir -p "$ROOT/vault/daily"
  if [ -d "$ROOT/vault/daily" ]; then
    pass "vault/daily/ created (--fix)"
  else
    fail "vault/daily/ could not be created"
  fi
else
  warn "vault/daily/ missing -- auto-capture hook will fail to write daily notes. Run with --fix to create."
fi

if [ -f "$ROOT/vault/memory/ACTIVE_PRIORITIES.md" ]; then
  pass "vault/memory/ACTIVE_PRIORITIES.md found"
else
  warn "vault/memory/ACTIVE_PRIORITIES.md missing -- expected after first /close (per-user, may be empty on fresh install)"
fi

# -- 4. CLAUDE.md --------------------------------------------------------------
if [ -f "$ROOT/CLAUDE.md" ]; then
  pass "CLAUDE.md found"
else
  fail "CLAUDE.md missing -- aigent-OS will not load without it"
fi

# -- 5. Skills -----------------------------------------------------------------
if [ -d "$ROOT/skills" ]; then
  pass "skills/ source templates found"
else
  warn "skills/ missing -- slash commands not available"
fi

if [ -d "$ROOT/.claude/skills" ]; then
  pass ".claude/skills/ runtime directory found"
else
  fail ".claude/skills/ missing -- Claude Code cannot resolve slash commands. Run installer or: mkdir -p .claude/skills && cp -r skills/*/ .claude/skills/"
fi

if [ -f "$ROOT/.claude/skill-index.json" ]; then
  pass ".claude/skill-index.json found -- Caddy enrollment works"
else
  fail ".claude/skill-index.json missing -- Caddy hints will not fire on fresh install. Run installer or: cp .claude/skill-index.json.template .claude/skill-index.json (or copy from repo)"
fi

# -- 5b. Pantheon agents (dispatchable subagents) ------------------------------
# Claude Code loads dispatchable subagents ONLY from .claude/agents/. The defs live
# in vault/agents/ as docs; if they were never copied here, the operator reads
# "delegate to Lyra/Iris/Hypatia/Echo" but has nothing to spawn and does it all itself.
AGENTS_DIR="$ROOT/.claude/agents"
AGENTS_SRC="$ROOT/vault/agents"
agent_count=0
[ -d "$AGENTS_DIR" ] && agent_count=$(find "$AGENTS_DIR" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$agent_count" -gt 0 ]; then
  pass ".claude/agents/ found ($agent_count dispatchable agents) -- delegation ready"
elif [ "$FIX" -eq 1 ] && [ -d "$AGENTS_SRC" ]; then
  mkdir -p "$AGENTS_DIR"
  for agent_file in "$AGENTS_SRC"/*.md; do
    [ -f "$agent_file" ] || continue
    if head -20 "$agent_file" | grep -q '^name:' && head -20 "$agent_file" | grep -q '^tools:'; then
      cp -n "$agent_file" "$AGENTS_DIR/$(basename "$agent_file")" 2>/dev/null || true
    fi
  done
  agent_count=$(find "$AGENTS_DIR" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$agent_count" -gt 0 ]; then
    pass ".claude/agents/ created with $agent_count agents (--fix) -- delegation ready"
  else
    fail ".claude/agents/ could not be populated -- vault/agents/ has no defs with name:+tools: frontmatter"
  fi
else
  fail ".claude/agents/ missing -- no subagents to delegate to, so the operator does everything itself. Run: bash scripts/doctor.sh --fix (or re-run install.sh)"
fi

# -- 6. Hooks ------------------------------------------------------------------
if [ -d "$ROOT/hooks" ]; then
  pass "hooks/ found"
else
  warn "hooks/ missing -- background automation not installed"
fi

# -- 7. .claude/settings.json + AIGENT_ROOT placeholder check ------------------
SETTINGS="$ROOT/.claude/settings.json"
SETTINGS_TEMPLATE="$ROOT/.claude/settings.json.template"
if [ -f "$SETTINGS" ]; then
  if grep -q "__AIGENT_ROOT__" "$SETTINGS" 2>/dev/null; then
    fail ".claude/settings.json contains literal __AIGENT_ROOT__ -- placeholder not substituted. Run: sed -i \"s|__AIGENT_ROOT__|\$(pwd)|g\" .claude/settings.json"
  else
    pass ".claude/settings.json -- paths resolved (no __AIGENT_ROOT__ literal)"
  fi
elif [ -f "$SETTINGS_TEMPLATE" ]; then
  warn ".claude/settings.json missing but template found -- run installer to generate it, or: sed \"s|__AIGENT_ROOT__|\$(pwd)|g\" .claude/settings.json.template > .claude/settings.json"
else
  fail ".claude/settings.json and settings.json.template both missing -- hooks will not fire"
fi

# -- 7b. Hook command path resolution ------------------------------------------
if [ -f "$SETTINGS" ] && command -v python3 >/dev/null 2>&1; then
  # Write extractor to a temp file to avoid heredoc+process-substitution issues under set -euo pipefail
  _HOOK_PY=$(mktemp /tmp/doctor_hook_extract.XXXXXX.py)
  cat > "$_HOOK_PY" << 'HOOKPY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    def walk(obj):
        if isinstance(obj, dict):
            if obj.get("type") == "command" and "command" in obj:
                parts = obj["command"].strip().split()
                if len(parts) >= 2 and parts[0] == "bash":
                    print(parts[1])
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for i in obj:
                walk(i)
    walk(data)
except Exception:
    pass
HOOKPY
  HOOK_FAIL=0
  # Use bash test -f (not python os.path.isfile) -- python may be native Windows and
  # can't resolve Git Bash /tmp/ or Unix-style paths on Windows hosts
  while IFS= read -r script_path; do
    [ -z "$script_path" ] && continue
    if ! bash -c "test -f \"$script_path\"" 2>/dev/null; then
      fail "hook script not found: $script_path"
      HOOK_FAIL=$((HOOK_FAIL + 1))
    fi
  done < <(python3 "$_HOOK_PY" "$SETTINGS" 2>/dev/null)
  rm -f "$_HOOK_PY"
  if [ "$HOOK_FAIL" -eq 0 ]; then
    pass "all hook command paths in settings.json resolve to existing files"
  fi
else
  warn "hook path resolution check skipped (settings.json or python3 not available)"
fi

# -- 8. Node.js ----------------------------------------------------------------
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version 2>/dev/null | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    pass "Node.js $NODE_VER found (>=18 -- semantic search supported)"
    NODE_OK=1
  else
    warn "Node.js $NODE_VER found but <18 -- semantic search requires Node 18+. Upgrade: nvm install 18"
  fi
else
  warn "Node.js not found -- semantic search and hook automation will be skipped (optional)"
fi

# -- 9. Semantic search node_modules -------------------------------------------
if [ "$NODE_OK" -eq 1 ]; then
  if [ -d "$ROOT/daemons/semantic-search/node_modules" ]; then
    pass "daemons/semantic-search/node_modules found -- semantic search ready"
  else
    warn "daemons/semantic-search/node_modules missing -- run: cd daemons/semantic-search && npm install"
  fi
else
  warn "semantic search install check skipped (Node not available)"
fi

# -- 10. Shell script syntax check ---------------------------------------------
SH_FAIL=0
SH_COUNT=0
while IFS= read -r -d '' script; do
  SH_COUNT=$((SH_COUNT + 1))
  if ! bash -n "$script" 2>/dev/null; then
    fail "shell syntax error: $script"
    SH_FAIL=$((SH_FAIL + 1))
  fi
done < <(find "$ROOT" -name "*.sh" -not -path "*/node_modules/*" -print0 2>/dev/null)

if [ "$SH_FAIL" -eq 0 ] && [ "$SH_COUNT" -gt 0 ]; then
  pass "all ${SH_COUNT} shell scripts pass bash -n syntax check"
elif [ "$SH_COUNT" -eq 0 ]; then
  warn "no .sh files found to check"
fi

# -- 11. JSON syntax check -----------------------------------------------------
JSON_FAIL=0
JSON_COUNT=0
if command -v python3 >/dev/null 2>&1; then
  while IFS= read -r -d '' jfile; do
    JSON_COUNT=$((JSON_COUNT + 1))
    if ! python3 -m json.tool "$jfile" >/dev/null 2>&1; then
      fail "JSON parse error: $jfile"
      JSON_FAIL=$((JSON_FAIL + 1))
    fi
  done < <(find "$ROOT" -name "*.json" -not -path "*/node_modules/*" -print0 2>/dev/null)

  if [ "$JSON_FAIL" -eq 0 ] && [ "$JSON_COUNT" -gt 0 ]; then
    pass "all ${JSON_COUNT} JSON files parse cleanly"
  elif [ "$JSON_COUNT" -eq 0 ]; then
    warn "no .json files found to check"
  fi
else
  warn "python3 not found -- JSON syntax check skipped"
fi

# -- Summary -------------------------------------------------------------------
echo ""
echo "  ----------------------------------------"
echo "  Summary: ${PASS} PASS, ${WARN} WARN, ${FAIL} FAIL"

if [ "$FAIL" -eq 0 ]; then
  echo "  aigent-OS is operational."
  echo ""
  exit 0
else
  echo "  Fix the above FAILs before using aigent-OS."
  echo ""
  exit 1
fi
