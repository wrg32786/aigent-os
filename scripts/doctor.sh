#!/bin/bash
# aigent-OS Doctor
# Diagnoses install health. Exit 0 = no FAILs. Exit 1 = at least one FAIL.
# Usage: bash scripts/doctor.sh [aigent-root-path] [--fix]
#        bash scripts/doctor.sh [aigent-root-path] --attest
#
# By default this script is READ-ONLY -- it reports missing dirs/files as WARN but does not create them.
# Pass --fix to enable mutation (mkdir for missing vault dirs, etc.).
#
# --attest compares this tree against scripts/fleet-baseline-manifest.json and
# prints exactly one terminal class: COMPLIANT, DEGRADED, NONCOMPLIANT, or
# UNKNOWN. It is strictly read-only -- no writes anywhere (not even a temp
# file), no repairs, no network -- and returns before the diagnostic pass
# below, so --fix can never run alongside it. Exit 0 = COMPLIANT or DEGRADED,
# 1 = NONCOMPLIANT, 2 = UNKNOWN (the tree could not be measured, which is not
# the same as measuring it and finding it broken).
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
ATTEST=0
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    --attest) ATTEST=1 ;;
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

# -- Baseline attestation (--attest) -------------------------------------------
# Returns before the diagnostic pass below. Everything here reads; nothing
# writes, so this mode is safe to point at a live seat.
#
# The manifest is read with python3 (the same runtime checks 7b and 11 below
# already depend on) via a stdin heredoc rather than a mktemp scratch file --
# the read-only claim has to hold for /tmp too. python3 being absent is
# "cannot measure", which is UNKNOWN, not a failure of the tree.
if [ "$ATTEST" -eq 1 ]; then
  attest_verdict() {
    echo ""
    echo "  ----------------------------------------"
    echo "  ATTEST: $1"
    echo ""
    case "$1" in
      COMPLIANT|DEGRADED) exit 0 ;;
      NONCOMPLIANT)       exit 1 ;;
      *)                  exit 2 ;;
    esac
  }

  echo ""
  echo "  aigent-OS Baseline Attestation"
  echo "  ----------------------------------------"

  if [ -z "$ROOT" ]; then
    echo "  [detail] aigent-OS root not found -- pass the path as an argument or set AIGENT_ROOT"
    attest_verdict UNKNOWN
  fi
  echo "  root:     $ROOT"

  MANIFEST="$ROOT/scripts/fleet-baseline-manifest.json"
  if [ ! -f "$MANIFEST" ]; then
    echo "  [detail] baseline manifest not found: $MANIFEST"
    attest_verdict UNKNOWN
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "  [detail] python3 not available -- the baseline manifest cannot be read"
    attest_verdict UNKNOWN
  fi

  ATTEST_RC=0
  ATTEST_OUT="$(python3 - "$MANIFEST" "$ROOT" <<'ATTESTPY'
import hashlib
import json
import os
import sys

manifest_path, root = sys.argv[1:3]

with open(manifest_path, encoding="utf-8") as fh:
    manifest = json.load(fh)


def under_root(relative):
    return os.path.join(root, *relative.split("/"))


findings = []

print("info:baseline %s" % manifest["baseline_id"])
print("info:commit %s" % manifest["public_product_commit"])

# Required files, byte for byte. A missing file and a changed file are the
# same terminal but not the same fact, so they stay separate lines.
for relative, expected in manifest["required_files"].items():
    try:
        with open(under_root(relative), "rb") as fh:
            actual = hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        findings.append("required file missing: %s" % relative)
        continue
    if actual != expected:
        findings.append("required file changed: %s" % relative)

# Settings staleness. The installer MERGES into an existing settings.json
# rather than replacing it, so a settings file rendered from an older template
# stays valid JSON with every path resolved and is simply missing the newer
# hook wiring. Checking the placeholder alone would read that as healthy.
settings = manifest["required_settings"]
try:
    with open(under_root(settings["path"]), encoding="utf-8") as fh:
        settings_text = fh.read()
except OSError:
    findings.append("settings missing: %s" % settings["path"])
    settings_text = None

if settings_text is not None:
    if settings["unresolved_placeholder"] in settings_text:
        findings.append(
            "settings placeholder not substituted: %s"
            % settings["unresolved_placeholder"]
        )
    for command in settings["hook_commands"]:
        # The template embeds every hook as "<root>/<relative>" with forward
        # slashes on every platform, so the relative tail is a literal
        # substring of a correctly rendered settings.json.
        if command not in settings_text:
            findings.append("settings hook not wired: %s" % command)

# The managed launcher expectation is enforced through required_files. This
# check guards the manifest itself: a declared launcher path that nothing
# hashes is an expectation with no instrument behind it.
for relative in manifest["managed_launcher"]["paths"]:
    if relative not in manifest["required_files"]:
        findings.append("manifest declares an unhashed launcher path: %s" % relative)

auto_refresh = manifest["auto_refresh"]
if auto_refresh["expected"] == "enabled":
    if os.environ.get(auto_refresh["kill_switch_env"]) == "1":
        findings.append(
            "Auto-Refresh expected enabled but %s=1"
            % auto_refresh["kill_switch_env"]
        )
    # Mirrors memRoot() in daemons/lifecycle-common.mjs: the FIRST existing
    # root wins. Checking both would fail an install that merely still has a
    # stale marker under the root the runtime never reads.
    for candidate in auto_refresh["kill_switch_roots"]:
        if os.path.isdir(under_root(candidate)):
            marker = "%s/%s" % (candidate, auto_refresh["kill_switch_file"])
            if os.path.exists(under_root(marker)):
                findings.append(
                    "Auto-Refresh expected enabled but the kill switch is set: %s"
                    % marker
                )
            break
    print("runner-required:%s" % under_root(manifest["managed_runner"]["dependency_root"]))

for name, spec in manifest["optional_components"].items():
    if not os.path.exists(under_root(spec["path"])):
        findings.append("optional %s absent: %s" % (name, spec["path"]))

for finding in findings:
    print("finding:%s" % finding)
ATTESTPY
  )" || ATTEST_RC=$?

  if [ "$ATTEST_RC" -ne 0 ]; then
    echo "  [detail] baseline manifest could not be read or is malformed: $MANIFEST"
    attest_verdict UNKNOWN
  fi

  ATTEST_FINDINGS=()
  RUNNER_ROOT=""
  while IFS= read -r line; do
    # python3 on Windows writes CRLF, and `read -r` keeps the CR. Without this
    # strip the runner root parsed below ends in a bare CR, the node-pty probe
    # is handed a path that cannot exist, and a healthy managed runner reports
    # as unavailable on every Windows install.
    line="${line%$'\r'}"
    case "$line" in
      info:*)            echo "  ${line#info:}" ;;
      runner-required:*) RUNNER_ROOT="${line#runner-required:}" ;;
      finding:*)         ATTEST_FINDINGS+=("${line#finding:}") ;;
    esac
  done <<< "$ATTEST_OUT"

  # Managed runner. Same load probe install.sh runs after npm rebuild, so
  # "installed but unloadable" is caught here exactly as it is at install time.
  if [ -n "$RUNNER_ROOT" ]; then
    if ! command -v node >/dev/null 2>&1; then
      ATTEST_FINDINGS+=("managed runner unavailable: node not found, so node-pty cannot load")
    elif ! node -e '
const { createRequire } = require("node:module");
createRequire(process.argv[1])("node-pty");
' "$RUNNER_ROOT/package.json" >/dev/null 2>&1; then
      ATTEST_FINDINGS+=("managed runner unavailable: node-pty could not be loaded from $RUNNER_ROOT")
    fi
  fi

  # An optional-component finding must never pull the verdict back UP from
  # NONCOMPLIANT, so DEGRADED is only ever reached from COMPLIANT.
  TERMINAL="COMPLIANT"
  if [ "${#ATTEST_FINDINGS[@]}" -gt 0 ]; then
    for finding in "${ATTEST_FINDINGS[@]}"; do
      echo "  [detail] $finding"
      case "$finding" in
        optional*)
          if [ "$TERMINAL" = "COMPLIANT" ]; then TERMINAL="DEGRADED"; fi
          ;;
        *)
          TERMINAL="NONCOMPLIANT"
          ;;
      esac
    done
  fi

  attest_verdict "$TERMINAL"
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
  fail ".claude/skill-index.json missing -- Caddy hints will not fire on fresh install. Run the installer, or copy .claude/skill-index.json from a repo checkout (no .template variant exists)"
fi

# -- 5b. Pantheon agents (dispatchable subagents) ------------------------------
# Claude Code loads dispatchable subagents ONLY from .claude/agents/. The defs live
# in vault/agents/ as docs; if they were never copied here, the operator reads
# "delegate to Lyra/Iris/Hypatia/Echo" but has nothing to spawn and does it all itself.
unsafeRawRepairAgentDefinition() {
  local source="$1" destination="$2" reason="$3"
  [ -n "$reason" ] || return 1
  cp -n "$source" "$destination" 2>/dev/null
}

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
      unsafeRawRepairAgentDefinition \
        "$agent_file" \
        "$AGENTS_DIR/$(basename "$agent_file")" \
        "doctor --fix promotes operator-authored multiline agent procedure text into Claude's runtime directory" \
        || true
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
