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
#   - semantic search namespace registry valid and physically complete
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
import re
import sys

manifest_path, root = sys.argv[1:3]

with open(manifest_path, encoding="utf-8") as fh:
    manifest = json.load(fh)


def under_root(relative):
    return os.path.join(root, *relative.split("/"))


findings = []

print("info:baseline %s" % manifest["baseline_id"])
print("info:commit %s" % manifest["public_product_commit"])
# A bare verdict is not self-describing about coverage: COMPLIANT over 31
# files and COMPLIANT over 1 file print identically without this line.
print("info:population %d required files" % len(manifest["required_files"]))

# Operator-owned declarations (install.sh, <root>/.aigent/operator-owned.json).
# A path the operator declares and maintains themselves is not core the
# installer placed, so reporting its divergence as a compliance failure would
# be wrong. Reporting it silently as compliant core would be worse. It gets its
# own line and its own count instead.
#
# An unreadable declaration is deliberately UNKNOWN rather than NONCOMPLIANT:
# it means this instrument cannot tell core-owned from operator-owned, which is
# a failure to measure the tree, not a measurement that the tree is broken.
OPERATOR_OWNED_RELATIVE = ".aigent/operator-owned.json"
operator_owned_patterns = ()
declaration_path = under_root(OPERATOR_OWNED_RELATIVE)
if os.path.exists(declaration_path):
    try:
        with open(declaration_path, encoding="utf-8") as fh:
            declared = json.load(fh)
        entries = declared["paths"]
        if not isinstance(entries, list) or not all(
            isinstance(item, str) for item in entries
        ):
            raise ValueError("paths is not an array of strings")
        operator_owned_patterns = tuple(entries)
    except (OSError, ValueError, UnicodeError, KeyError, TypeError, RecursionError):
        print(
            "unmeasurable:%s is present but unreadable, so core-owned and "
            "operator-owned paths cannot be told apart" % OPERATOR_OWNED_RELATIVE
        )
        raise SystemExit(0)


def operator_owned(relative):
    # Same bounded-glob rule install.sh applies: a single * matches within one
    # path segment and never across a separator.
    for pattern in operator_owned_patterns:
        if re.fullmatch(re.escape(pattern).replace(r"\*", "[^/]*"), relative):
            return True
    return False


# Required files, byte for byte. A missing file and a changed file are the
# same terminal but not the same fact, so they stay separate lines. A declared
# operator-owned path is still required to EXIST: a missing one is a real
# failure, because the installer would have placed the framework copy there.
core_owned = 0
operator_owned_count = 0
missing_count = 0
for relative, expected in manifest["required_files"].items():
    try:
        with open(under_root(relative), "rb") as fh:
            actual = hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        missing_count += 1
        findings.append("required file missing: %s" % relative)
        continue
    if actual == expected:
        core_owned += 1
        continue
    if operator_owned(relative):
        operator_owned_count += 1
        # DEGRADED, not COMPLIANT: install.sh REFUSES to declare a
        # core-required path, so finding one declared here means the
        # declaration was hand-edited after install and a core-required file
        # has drifted. Not NONCOMPLIANT either, because the operator did claim
        # ownership of it. Carried as a finding rather than an info line so the
        # terminal mapping below sees it.
        findings.append(
            "OPERATOR-OWNED %s (declared; hash differs from core)" % relative
        )
        continue
    core_owned += 1
    findings.append("required file changed: %s" % relative)

# Missing is its own bucket so the three numbers add up to the population line
# above. Folding absences into either ownership class would make the summary a
# classification count that silently fails to account for part of what it
# claims to have checked.
print(
    "info:ownership %d core-owned, %d operator-owned, %d missing"
    % (core_owned, operator_owned_count, missing_count)
)

# Settings staleness. The installer MERGES into an existing settings.json
# rather than replacing it, so a settings file rendered from an older template
# stays valid JSON with every path resolved and is simply missing the newer
# hook wiring. Checking the placeholder alone would read that as healthy.
settings = manifest["required_settings"]
MISSING = object()
settings_document = MISSING


def reject_json_constant(value):
    raise ValueError("invalid JSON constant: %s" % value)


try:
    with open(under_root(settings["path"]), encoding="utf-8") as fh:
        settings_text = fh.read()
except OSError:
    findings.append("settings missing: %s" % settings["path"])
    settings_text = None
except UnicodeError:
    findings.append("settings JSON malformed: %s" % settings["path"])
    settings_text = None

if settings_text is not None:
    if settings["unresolved_placeholder"] in settings_text:
        findings.append(
            "settings placeholder not substituted: %s"
            % settings["unresolved_placeholder"]
        )
    try:
        settings_document = json.loads(
            settings_text, parse_constant=reject_json_constant
        )
    except (ValueError, UnicodeError, RecursionError):
        findings.append("settings JSON malformed: %s" % settings["path"])
    if settings_document is MISSING:
        for command in settings["hook_commands"]:
            # When parsing fails, retain the legacy text witness and message:
            # the relative tail is a literal substring of a rendered command.
            if command not in settings_text:
                findings.append("settings hook not wired: %s" % command)

# The pinned template is the structural contract. Only its managed statusLine
# and selected hook entries are required; unrelated operator settings remain
# deliberately outside attestation.
template_document = MISSING
try:
    with open(under_root(settings["template"]), encoding="utf-8") as fh:
        template_document = json.load(fh, parse_constant=reject_json_constant)
except OSError:
    findings.append("settings template missing: %s" % settings["template"])
except (ValueError, UnicodeError, RecursionError):
    findings.append("settings template JSON malformed: %s" % settings["template"])


root_to_resolve = root
if (
    os.name == "nt"
    and len(root) >= 2
    and root[0] == "/"
    and root[1].isalpha()
    and (len(root) == 2 or root[2] == "/")
):
    root_to_resolve = root[1] + ":" + root[2:]
absolute_root = os.path.abspath(root_to_resolve)
canonical_root = os.path.realpath(absolute_root)
root_spellings = []


def add_root_spelling(value):
    if value not in root_spellings:
        root_spellings.append(value)


def add_root_variants(value):
    add_root_spelling(value)
    forward = value.replace("\\", "/")
    add_root_spelling(forward)
    drive, tail = os.path.splitdrive(forward)
    if len(drive) == 2 and drive[1] == ":":
        add_root_spelling("/%s%s" % (drive[0].lower(), tail))
        add_root_spelling("/%s%s" % (drive[0].upper(), tail))


for root_spelling in (canonical_root, absolute_root, root):
    add_root_variants(root_spelling)


def render_commands(command):
    token = settings["unresolved_placeholder"]
    if not isinstance(command, str) or token not in command:
        return (command,)
    if command == token:
        return tuple(root_spellings)
    rendered = []
    for root_spelling in root_spellings:
        escaped_root = (
            root_spelling.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("$", "\\$")
            .replace("`", "\\`")
        )
        rendered.append(command.replace(token, escaped_root))
    return tuple(dict.fromkeys(rendered))


def normalized_matcher(value):
    return "" if value is MISSING or value in ("", "*") else value


def hook_records(document):
    records = []
    hooks = document.get("hooks") if isinstance(document, dict) else None
    if not isinstance(hooks, dict):
        return records
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                continue
            for entry in group["hooks"]:
                if isinstance(entry, dict):
                    records.append(
                        (
                            event,
                            normalized_matcher(group.get("matcher", MISSING)),
                            entry.get("type", MISSING),
                            entry.get("command", MISSING),
                            entry.get("timeout", MISSING),
                        )
                    )
    return records


def same(left, right):
    return type(left) is type(right) and left == right


def shown(value):
    return "missing" if value is MISSING else repr(value)


def normalized_command(command):
    if os.name == "nt" and isinstance(command, str):
        return os.path.normcase(command)
    return command


def command_matches(actual, expected_commands):
    actual = normalized_command(actual)
    return any(
        same(actual, normalized_command(expected)) for expected in expected_commands
    )


def timeout_is_insufficient(actual, required):
    if required is MISSING:
        return False
    if actual is MISSING:
        return True
    if isinstance(required, bool) or not isinstance(required, (int, float)):
        return not same(actual, required)
    if isinstance(actual, bool) or not isinstance(actual, (int, float)):
        return True
    return actual < required


def shown_commands(commands):
    return " or ".join(shown(command) for command in commands)


if template_document is not MISSING:
    required_commands = settings["hook_commands"]
    represented = set()
    expected_status = MISSING
    status_line = (
        template_document.get("statusLine")
        if isinstance(template_document, dict)
        else None
    )
    expected_status_type = MISSING
    if isinstance(status_line, dict) and "command" in status_line:
        template_status = status_line["command"]
        expected_status = render_commands(template_status)
        expected_status_type = status_line.get("type", MISSING)
        if isinstance(template_status, str):
            represented.update(
                command for command in required_commands if command in template_status
            )
    else:
        findings.append(
            "settings template contract missing statusLine command: %s"
            % settings["template"]
        )

    expected_hooks = []
    for event, matcher, hook_type, command, timeout in hook_records(template_document):
        if not isinstance(command, str):
            continue
        for relative in required_commands:
            if relative in command:
                expected_hooks.append(
                    (
                        relative,
                        event,
                        matcher,
                        hook_type,
                        render_commands(command),
                        timeout,
                    )
                )
                represented.add(relative)
    for command in required_commands:
        if command not in represented:
            findings.append(
                "settings template contract missing required command: %s" % command
            )

    if settings_document is not MISSING:
        installed_status = MISSING
        installed_status_type = MISSING
        if isinstance(settings_document, dict):
            status_line = settings_document.get("statusLine")
            if isinstance(status_line, dict):
                installed_status = status_line.get("command", MISSING)
                installed_status_type = status_line.get("type", MISSING)
        if (
            expected_status is not MISSING
            and not command_matches(installed_status, expected_status)
        ):
            findings.append(
                "settings statusLine command differs: expected %s, got %s"
                % (shown_commands(expected_status), shown(installed_status))
            )
        if expected_status_type is not MISSING and not same(
            installed_status_type, expected_status_type
        ):
            findings.append(
                "settings statusLine type differs: expected %s, got %s"
                % (shown(expected_status_type), shown(installed_status_type))
            )

        installed_hooks = hook_records(settings_document)
        for relative, event, matcher, hook_type, commands, timeout in expected_hooks:
            candidates = [
                actual
                for actual in installed_hooks
                if isinstance(actual[3], str)
                and normalized_command(relative) in normalized_command(actual[3])
            ]
            if not candidates:
                findings.append(
                    "settings hook %s not wired under event %s matcher %s"
                    % (relative, shown(event), shown(matcher))
                )
                continue

            compared = []
            for candidate in candidates:
                differences = []
                for name, actual, required in (
                    ("event", candidate[0], event),
                    ("matcher", candidate[1], matcher),
                    ("type", candidate[2], hook_type),
                ):
                    if not same(actual, required):
                        differences.append(
                            "%s expected %s, got %s"
                            % (name, shown(required), shown(actual))
                        )
                if timeout_is_insufficient(candidate[4], timeout):
                    differences.append(
                        "timeout expected %s, got %s"
                        % (shown(timeout), shown(candidate[4]))
                    )
                if not command_matches(candidate[3], commands):
                    differences.append(
                        "command expected %s, got %s"
                        % (shown_commands(commands), shown(candidate[3]))
                    )
                if not differences:
                    break
                compared.append(differences)
            if not differences:
                continue

            differences = min(compared, key=len)
            findings.append(
                "settings hook %s differs: %s"
                % (relative, "; ".join(differences))
            )

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
  ATTEST_UNMEASURABLE=""
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
      unmeasurable:*)    ATTEST_UNMEASURABLE="${line#unmeasurable:}" ;;
    esac
  done <<< "$ATTEST_OUT"

  # "Cannot tell what this tree is" is not the same as "this tree is broken".
  # It returns before the runner probe so a single verdict is still printed.
  if [ -n "$ATTEST_UNMEASURABLE" ]; then
    echo "  [detail] $ATTEST_UNMEASURABLE"
    attest_verdict UNKNOWN
  fi

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

  # A DEGRADED-class finding must never pull the verdict back UP from
  # NONCOMPLIANT, so DEGRADED is only ever reached from COMPLIANT. Two classes
  # map here: an absent optional component, and a core-required path the
  # operator declared and then let drift (see the attest python above).
  TERMINAL="COMPLIANT"
  if [ "${#ATTEST_FINDINGS[@]}" -gt 0 ]; then
    for finding in "${ATTEST_FINDINGS[@]}"; do
      echo "  [detail] $finding"
      case "$finding" in
        optional*|OPERATOR-OWNED*)
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

# -- 9b. Semantic search namespace registry -----------------------------------
# Validate the whole document before emitting any records. The extractor lives
# in a temp file, matching check 7b's set -euo pipefail-safe pattern; capturing
# its status directly (rather than through process substitution) ensures a
# parser failure cannot be mistaken for an empty, healthy registry.
#
# namespace-registry.local.json (issue #48) is the optional, operator-owned
# extension registry: same schema and row rules as the core file, composed
# in below rather than reimplemented, so doctor can never drift from what
# embed-vault.js/search-vault.js's shared namespace-registry.mjs accepts.
NAMESPACE_REGISTRY="$ROOT/daemons/semantic-search/namespace-registry.json"
NAMESPACE_LOCAL_REGISTRY="$ROOT/daemons/semantic-search/namespace-registry.local.json"
if command -v python3 >/dev/null 2>&1; then
  _NAMESPACE_PY=$(mktemp /tmp/doctor_namespace_registry.XXXXXX.py)
  cat > "$_NAMESPACE_PY" << 'NAMESPACEPY'
import json
import ntpath
import os
import posixpath
import sys

SCHEMA = "MemoryNamespaceRegistry/v1"
DISPOSITIONS = {"INDEX", "SKIP", "DENY"}
INFRASTRUCTURE = {
    "node_modules",
    ".git",
    "daemons",
    ".claude",
    "command-center-v2",
    "graphify-out",
    "recon",
    "prompts",
    "tools",
}


def stop(message):
    print(message)
    raise SystemExit(1)


def reject_json_constant(value):
    raise ValueError("invalid JSON constant: %s" % value)


def validate_rows(namespaces, seen, source_label):
    rows = []
    for index, row in enumerate(namespaces):
        if type(row) is not dict:
            stop("%s[%d] must be an object" % (source_label, index))

        namespace_path = row.get("path")
        if type(namespace_path) is not str:
            stop("%s[%d].path must be a string" % (source_label, index))
        if (
            not namespace_path
            or namespace_path.strip() != namespace_path
            or namespace_path in (".", "..")
            or "/" in namespace_path
            or "\\" in namespace_path
            or posixpath.isabs(namespace_path)
            or ntpath.isabs(namespace_path)
        ):
            stop("%s[%d].path must be one normalized top-level segment" % (source_label, index))

        key = namespace_path.replace("\\", "/").lower()
        if key in seen:
            stop("duplicate namespace path: %s" % namespace_path)
        seen.add(key)

        disposition = row.get("disposition")
        if type(disposition) is not str or disposition not in DISPOSITIONS:
            stop("%s[%d] has invalid disposition: %s" % (source_label, index, disposition))
        if disposition in ("SKIP", "DENY"):
            reason = row.get("reason")
            if type(reason) is not str or not reason.strip():
                stop("%s[%d] %s row requires a non-empty reason" % (source_label, index, disposition))

        rows.append((namespace_path, disposition, key))
    return rows


registry_path, vault_root = sys.argv[1:3]
local_registry_path = sys.argv[3] if len(sys.argv) > 3 else None

try:
    with open(registry_path, encoding="utf-8") as registry_file:
        registry_text = registry_file.read()
except (OSError, UnicodeError) as error:
    stop("namespace registry missing or unreadable: %s (%s)" % (registry_path, error))

try:
    document = json.loads(registry_text, parse_constant=reject_json_constant)
except (ValueError, UnicodeError, RecursionError) as error:
    stop("namespace registry malformed JSON: %s" % error)

if type(document) is not dict:
    stop("namespace registry root must be an object")
if document.get("schema") != SCHEMA:
    stop("namespace registry schema must equal exactly %s" % SCHEMA)

namespaces = document.get("namespaces")
if type(namespaces) is not list:
    stop("namespace registry namespaces must be an array")

seen = set()
rows = validate_rows(namespaces, seen, "namespaces")

# namespace-registry.local.json: optional, operator-owned. Absent (ENOENT) is
# valid -- no local rows. Present-but-unusable fails closed exactly like the
# core file. A local path colliding with a core path (already in `seen`)
# fails closed via the same duplicate-path check validate_rows uses
# internally: local rows may add top-level paths only, never override or
# duplicate a core one.
if local_registry_path:
    try:
        with open(local_registry_path, encoding="utf-8") as local_file:
            local_text = local_file.read()
    except FileNotFoundError:
        local_text = None
    except (OSError, UnicodeError) as error:
        stop("local namespace registry missing or unreadable: %s (%s)" % (local_registry_path, error))

    if local_text is not None:
        try:
            local_document = json.loads(local_text, parse_constant=reject_json_constant)
        except (ValueError, UnicodeError, RecursionError) as error:
            stop("local namespace registry malformed JSON: %s" % error)

        if type(local_document) is not dict:
            stop("local namespace registry root must be an object")
        if local_document.get("schema") != SCHEMA:
            stop("local namespace registry schema must equal exactly %s" % SCHEMA)

        local_namespaces = local_document.get("namespaces")
        if type(local_namespaces) is not list:
            stop("local namespace registry namespaces must be an array")

        rows += validate_rows(local_namespaces, seen, "local namespaces")

physical = []
if os.path.exists(vault_root):
    if not os.path.isdir(vault_root):
        stop("vault root is not a directory: %s" % vault_root)
    try:
        with os.scandir(vault_root) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        physical.append(entry.name)
                except OSError as error:
                    stop("cannot inspect vault namespace %s: %s" % (entry.name, error))
    except OSError as error:
        stop("cannot enumerate vault root %s: %s" % (vault_root, error))

memory_directories = [name for name in physical if name not in INFRASTRUCTURE]
physical_names = set(physical)
declared_names = {namespace_path for namespace_path, _, _ in rows}

records = []
for namespace_path, disposition, key in rows:
    presence = "PRESENT" if namespace_path in physical_names else "ABSENT"
    records.append(("NAMESPACE_%s_%s" % (disposition, presence), namespace_path))

for name in sorted(
    (name for name in memory_directories if name not in declared_names),
    key=lambda value: (value.lower(), value),
):
    records.append(("NAMESPACE_UNDECLARED", name))

for label, namespace_path in records:
    print("%s\t%s" % (label, namespace_path))
NAMESPACEPY

  NAMESPACE_OUTPUT=""
  NAMESPACE_RC=0
  NAMESPACE_OUTPUT="$(python3 "$_NAMESPACE_PY" "$NAMESPACE_REGISTRY" "$ROOT/vault" "$NAMESPACE_LOCAL_REGISTRY" 2>&1)" || NAMESPACE_RC=$?
  rm -f "$_NAMESPACE_PY"

  if [ "$NAMESPACE_RC" -ne 0 ]; then
    fail "namespace registry check failed: ${NAMESPACE_OUTPUT:-unknown validation error}"
  else
    while IFS=$'\t' read -r namespace_label namespace_path; do
      [ -z "$namespace_label" ] && continue
      namespace_path="${namespace_path%$'\r'}"
      case "$namespace_label" in
        NAMESPACE_INDEX_PRESENT|NAMESPACE_INDEX_ABSENT|NAMESPACE_SKIP_PRESENT|NAMESPACE_SKIP_ABSENT|NAMESPACE_DENY_PRESENT|NAMESPACE_DENY_ABSENT)
          pass "$namespace_label $namespace_path"
          ;;
        NAMESPACE_UNDECLARED)
          fail "$namespace_label $namespace_path"
          ;;
        *)
          fail "namespace registry check failed: unexpected extractor record: $namespace_label $namespace_path"
          ;;
      esac
    done <<< "$NAMESPACE_OUTPUT"
  fi
else
  fail "namespace registry check failed: python3 not available"
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
