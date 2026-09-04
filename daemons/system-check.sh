#!/usr/bin/env bash
# Full-stack read-only smoke test for an aigent-OS installation.
# Reports PASS, FAIL, and INFO lines. Any FAIL produces exit 1.

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="${AIGENT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_BASE="${AIGENT_STATE_HOME_DIR:-$ROOT}"
# One resolver for the whole core (daemons/memory-root.cjs): declared in
# .aigent/state.json, default vault/memory. A broken declaration is a FAIL
# here, never a silent fallback to a tree that is not this seat's.
. "$ROOT/daemons/memory-root.sh"
if ! MEMORY_ROOT="$(aigent_memory_root "$STATE_BASE" 2>&1)"; then
  printf 'FAIL memory root: %s\n' "$MEMORY_ROOT"
  exit 1
fi

SKILLS_ROOT="$ROOT/skills"
DAEMONS_ROOT="$ROOT/daemons"
RUNTIME_ROOT="$MEMORY_ROOT/runtime"
DAEMON_ERR_LOG="$MEMORY_ROOT/.daemon-errors.log"
TIME_ZONE="${AIGENT_NIGHTLY_TIME_ZONE:-America/Los_Angeles}"
CUTOFF_HOUR="${AIGENT_NIGHTLY_CUTOFF_HOUR:-4}"
CHECK_NOW="${AIGENT_SYSTEM_CHECK_NOW:-}"
ROUTE_HOME="${AIGENT_ROUTE_CHECK_HOME:-$ROOT}"

PASS=0
FAIL=0
INFO=0
REPORT=""

render_inert() {
  local value="${1-}"
  local limit="${2:-500}"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$value" | python3 -c '
import json
import re
import sys

limit = int(sys.argv[1])
value = re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", " ", sys.stdin.read())
value = re.sub(r"[ \t]+", " ", value).strip()
if len(value) > limit:
    value = f"{value[:limit]}…[+{len(value) - limit} chars]"
sys.stdout.write(json.dumps(value, ensure_ascii=True))
' "$limit"
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$value" | node -e '
const limit = Number(process.argv[1]);
let value = require("node:fs").readFileSync(0, "utf8")
  .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
  .replace(/[ \t]+/g, " ")
  .trim();
if (value.length > limit) {
  value = `${value.slice(0, limit)}…[+${value.length - limit} chars]`;
}
process.stdout.write(JSON.stringify(value));
' "$limit"
  else
    # Both runtimes are required by this installation. Never echo unreviewed
    # bytes merely to explain that the renderers themselves are unavailable.
    printf '"[unrenderable: Python 3 and Node.js unavailable]"'
  fi
}

UNSAFE_RAW_CAPSULE_RESULT=""
UNSAFE_RAW_CAPSULE_EXIT=1
unsafeRawValidateCapsules() {
  local directory="$1"
  local reason="$2"
  [[ -n "$reason" ]] || {
    printf 'unsafeRawValidateCapsules requires a reason\n' >&2
    return 64
  }
  UNSAFE_RAW_CAPSULE_RESULT=$(CAPSULE_DIR="$directory" python3 -c '
import os, re
directory = os.environ["CAPSULE_DIR"]
if not os.path.isdir(directory):
    raise SystemExit("capsules directory missing")
files = [name for name in os.listdir(directory) if name.endswith(".md")]
if not files:
    raise SystemExit("no capsules")
bad = []
for name in files:
    with open(os.path.join(directory, name), encoding="utf-8") as handle:
        text = handle.read()
    match = re.match(r"^\ufeff?---\r?\n(.*?)\r?\n---", text, re.DOTALL)
    if not match:
        bad.append(name + ":no_frontmatter")
        continue
    frontmatter = match.group(1)
    status = re.search(r"^status:\s*(\w+)", frontmatter, re.MULTILINE)
    has_id = re.search(r"^(?:capsule_)?id:", frontmatter, re.MULTILINE)
    spent = status and status.group(1) in ("resumed", "resolved")
    if not status or status.group(1) not in ("active", "resumed", "resolved"):
        bad.append(name + ":bad_status")
    elif not has_id and not spent:
        bad.append(name + ":missing_id")
if bad:
    raise SystemExit(",".join(bad))
print(len(files))
' 2>&1)
  UNSAFE_RAW_CAPSULE_EXIT=$?
}

UNSAFE_RAW_DAEMON_ERRORS=""
unsafeRawRecentDaemonErrors() {
  local error_file="$1"
  local reason="$2"
  [[ -n "$reason" ]] || {
    printf 'unsafeRawRecentDaemonErrors requires a reason\n' >&2
    return 64
  }
  UNSAFE_RAW_DAEMON_ERRORS="$(tail -5 "$error_file" | sed 's/^/    /')"
}

ck() {
  local label="$1"
  local status="$2"
  local detail="${3:-}"
  local rendered_label
  local rendered_detail=""
  rendered_label="$(render_inert "$label" 240)"
  if [[ -n "$detail" ]]; then
    rendered_detail="$(render_inert "$detail" 800)"
  fi
  if [[ "$status" == "PASS" ]]; then
    REPORT+="✓ $rendered_label"$'\n'
    PASS=$((PASS + 1))
  elif [[ "$status" == "FAIL" ]]; then
    REPORT+="✗ $rendered_label${rendered_detail:+ - $rendered_detail}"$'\n'
    FAIL=$((FAIL + 1))
  else
    REPORT+="ℹ $rendered_label${rendered_detail:+ - $rendered_detail}"$'\n'
    INFO=$((INFO + 1))
  fi
}

printf '=== /system-check report - %s ===\n' "$(render_inert "$(date -Iseconds)" 80)"
printf 'vantage: root=%s memory=%s time_zone=%s cutoff_hour=%s\n' \
  "$(render_inert "$ROOT" 500)" \
  "$(render_inert "$MEMORY_ROOT" 500)" \
  "$(render_inert "$TIME_ZONE" 120)" \
  "$(render_inert "$CUTOFF_HOUR" 40)"

# Runtime prerequisites.
command -v node >/dev/null 2>&1 \
  && ck "Node.js available" PASS \
  || ck "Node.js available" FAIL "node is required for nightly checks"
command -v python3 >/dev/null 2>&1 \
  && ck "Python 3 available" PASS \
  || ck "Python 3 available" FAIL "python3 is required for state validation"

# Source skills. Top-level skills/ is the repository source of truth; install.sh
# mirrors each skill into .claude/skills for Claude Code at install time.
CORE_SKILLS=(
  body-check digest context-capsule caddy-mute system-check sweep-now
  capsule-compact agent-fitness status reconcile dream meta-improve
  skill-recall skill-hunt pause resume
)
NIGHTLY_SKILLS=(
  nightly nightly-close-parity cognitive-update context-hygiene
  nightly-ledger-capture meta-improve-vault
)

CORE_SKILL_MISSING=""
for skill in "${CORE_SKILLS[@]}"; do
  [[ -f "$SKILLS_ROOT/$skill/SKILL.md" ]] || CORE_SKILL_MISSING+="$skill "
done
if [[ -z "$CORE_SKILL_MISSING" ]]; then
  ck "Core skills (${#CORE_SKILLS[@]}/${#CORE_SKILLS[@]} present)" PASS
else
  ck "Core skills" FAIL "missing: $CORE_SKILL_MISSING"
fi

NIGHTLY_SKILL_MISSING=""
for skill in "${NIGHTLY_SKILLS[@]}"; do
  [[ -f "$SKILLS_ROOT/$skill/SKILL.md" ]] || NIGHTLY_SKILL_MISSING+="$skill "
done
if [[ -z "$NIGHTLY_SKILL_MISSING" ]]; then
  ck "Nightly skills (${#NIGHTLY_SKILLS[@]}/${#NIGHTLY_SKILLS[@]} present)" PASS
else
  ck "Nightly skills" FAIL "missing: $NIGHTLY_SKILL_MISSING"
fi

# Shell and Python daemons.
SHELL_DAEMONS=(caddy.sh memory-capture.sh sync-usage.sh system-check.sh skill-router.sh)
SHELL_MISSING=""
for daemon in "${SHELL_DAEMONS[@]}"; do
  if [[ ! -f "$DAEMONS_ROOT/$daemon" ]] || ! bash -n "$DAEMONS_ROOT/$daemon" 2>/dev/null; then
    SHELL_MISSING+="$daemon "
  fi
done
if [[ -z "$SHELL_MISSING" ]]; then
  ck "Shell daemons (${#SHELL_DAEMONS[@]}/${#SHELL_DAEMONS[@]} parse)" PASS
else
  ck "Shell daemons" FAIL "missing or invalid: $SHELL_MISSING"
fi

PYTHON_DAEMONS=(capsule-compact.py agent-fitness-extract.py runtime/update-active-state.py)
PYTHON_MISSING=""
for daemon in "${PYTHON_DAEMONS[@]}"; do
  if [[ ! -f "$DAEMONS_ROOT/$daemon" ]] \
    || ! PYTHON_FILE="$DAEMONS_ROOT/$daemon" python3 -c \
      'import ast, os; ast.parse(open(os.environ["PYTHON_FILE"], encoding="utf-8").read())' 2>/dev/null; then
    PYTHON_MISSING+="$daemon "
  fi
done
if [[ -z "$PYTHON_MISSING" ]]; then
  ck "Python daemons (${#PYTHON_DAEMONS[@]}/${#PYTHON_DAEMONS[@]} parse)" PASS
else
  ck "Python daemons" FAIL "missing or invalid: $PYTHON_MISSING"
fi

# Every nightly daemon must exist and parse. A missing checker cannot certify
# the pass it is meant to validate.
NIGHTLY_DAEMONS=(
  nightly-alerts.mjs
  nightly-context-hygiene.mjs
  nightly-contracts.mjs
  nightly-decision-outcome.mjs
  nightly-freshness.mjs
  nightly-ledger-predicate.mjs
  nightly-ledger-review.mjs
  nightly-ledger-stage.mjs
  nightly-pass.mjs
  nightly-paths.mjs
  nightly-reconcile.mjs
  nightly-route-check.mjs
  nightly-watchdog.mjs
)
NIGHTLY_DAEMON_MISSING=""
for daemon in "${NIGHTLY_DAEMONS[@]}"; do
  if [[ ! -f "$DAEMONS_ROOT/$daemon" ]] || ! node --check "$DAEMONS_ROOT/$daemon" 2>/dev/null; then
    NIGHTLY_DAEMON_MISSING+="$daemon "
  fi
done
if [[ -z "$NIGHTLY_DAEMON_MISSING" ]]; then
  ck "Nightly daemons (${#NIGHTLY_DAEMONS[@]}/${#NIGHTLY_DAEMONS[@]} parse)" PASS
else
  ck "Nightly daemons" FAIL "missing or invalid: $NIGHTLY_DAEMON_MISSING"
fi

if [[ -f "$DAEMONS_ROOT/memory-heat/compute-heat.js" ]] \
  && node --check "$DAEMONS_ROOT/memory-heat/compute-heat.js" 2>/dev/null; then
  ck "Memory heat daemon parses" PASS
else
  ck "Memory heat daemon parses" FAIL "daemons/memory-heat/compute-heat.js missing or invalid"
fi

# Operational memory.
if BODY_FILE="$MEMORY_ROOT/BODY_STATE.json" python3 -c \
  'import json, os; d=json.load(open(os.environ["BODY_FILE"], encoding="utf-8")); assert "_schema" in d and "state" in d' \
  2>/dev/null; then
  ck "BODY_STATE.json schema" PASS
else
  ck "BODY_STATE.json schema" FAIL "missing or invalid"
fi

if HEAT_FILE="$MEMORY_ROOT/HEAT_INDEX.json" python3 -c \
  'import json, os; d=json.load(open(os.environ["HEAT_FILE"], encoding="utf-8")); assert isinstance(d.get("hot_top_20"), list); assert d.get("generated_at")' \
  2>/dev/null; then
  ck "HEAT_INDEX.json schema" PASS
else
  ck "HEAT_INDEX.json schema" FAIL "missing or invalid"
fi

if [[ -f "$MEMORY_ROOT/CADDY_MUTES.json" ]]; then
  if CADDY_FILE="$MEMORY_ROOT/CADDY_MUTES.json" python3 -c \
    'import json, os; json.load(open(os.environ["CADDY_FILE"], encoding="utf-8"))' 2>/dev/null; then
    ck "CADDY_MUTES.json parses" PASS
  else
    ck "CADDY_MUTES.json parses" FAIL "optional file exists but is invalid"
  fi
else
  ck "CADDY_MUTES.json absent" INFO "optional file not configured"
fi

if [[ -f "$MEMORY_ROOT/MEMORY_CANDIDATES.md" ]] \
  && grep -q "## Candidates" "$MEMORY_ROOT/MEMORY_CANDIDATES.md"; then
  ck "MEMORY_CANDIDATES.md structure" PASS
else
  ck "MEMORY_CANDIDATES.md structure" FAIL "missing canonical candidates section"
fi

if [[ -f "$MEMORY_ROOT/SWEEP_LOG.md" ]]; then
  ck "SWEEP_LOG.md present" PASS
else
  ck "SWEEP_LOG.md present" FAIL "canonical generic sweep log missing"
fi

if [[ -f "$MEMORY_ROOT/AGENT_FITNESS.md" ]] \
  && grep -q "^| Date | Session" "$MEMORY_ROOT/AGENT_FITNESS.md"; then
  ck "AGENT_FITNESS.md structure" PASS
else
  ck "AGENT_FITNESS.md structure" FAIL "dispatch table missing"
fi

CAPSULE_DIR="$MEMORY_ROOT/capsules"
unsafeRawValidateCapsules \
  "$CAPSULE_DIR" \
  "system-check validates complete capsule documents before rendering only inert schema results"
CAPSULE_RESULT="$UNSAFE_RAW_CAPSULE_RESULT"
CAPSULE_EXIT="$UNSAFE_RAW_CAPSULE_EXIT"
if [[ "$CAPSULE_EXIT" == "0" ]]; then
  ck "Capsules ($CAPSULE_RESULT healthy)" PASS
else
  ck "Capsules" FAIL "$CAPSULE_RESULT"
fi

# Canonical cognitive runtime. Missing inputs are failures: a check cannot
# describe absent state as "nothing to do."
RUNTIME_RESULT=$(RUNTIME_ROOT="$RUNTIME_ROOT" python3 -c '
import json, os
root = os.environ["RUNTIME_ROOT"]
failures = []
def read_json(name):
    path = os.path.join(root, name)
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as error:
        failures.append(f"{name}:{error.__class__.__name__}")
        return None
active = read_json("ACTIVE_STATE.json")
if active is not None and active.get("mode") not in ("idle", "active", "blocked", "paused"):
    failures.append("ACTIVE_STATE.json:mode")
self_model = read_json("SELF_MODEL.json")
if self_model is not None:
    for key in ("capabilities", "limitations"):
        if not isinstance(self_model.get(key), list) or not self_model[key]:
            failures.append(f"SELF_MODEL.json:{key}")
goals = read_json("GOAL_STACK.json")
if goals is not None and not isinstance(goals.get("active_goals"), list):
    failures.append("GOAL_STACK.json:active_goals")
for name in ("BELIEF_STATE.jsonl", "LESSONS.jsonl", "PROCEDURES.jsonl", "STATE_EVENTS.jsonl"):
    path = os.path.join(root, name)
    try:
        with open(path, encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle if line.strip()]
        if name == "BELIEF_STATE.jsonl" and (not rows or "confidence" not in rows[-1]):
            failures.append(name + ":confidence")
    except Exception as error:
        failures.append(f"{name}:{error.__class__.__name__}")
print(" ".join(failures))
raise SystemExit(1 if failures else 0)
' 2>&1)
RUNTIME_EXIT=$?
if [[ "$RUNTIME_EXIT" == "0" ]]; then
  ck "Cognitive runtime files parse" PASS
else
  ck "Cognitive runtime files parse" FAIL "$RUNTIME_RESULT"
fi

# Freshness reads real dated headers, never mtimes. The same configured timezone
# and cutoff are passed to every date-sensitive check.
FRESHNESS_ENV=(
  "AIGENT_ROOT=$ROOT"
  "AIGENT_OS_ROOT=$ROOT"
  "AIGENT_PROJECT_DIR=$ROOT"
  "AIGENT_NIGHTLY_TIME_ZONE=$TIME_ZONE"
  "AIGENT_NIGHTLY_CUTOFF_HOUR=$CUTOFF_HOUR"
)
if [[ -n "${AIGENT_STATE_HOME_DIR:-}" ]]; then
  FRESHNESS_ENV+=("AIGENT_STATE_HOME_DIR=$AIGENT_STATE_HOME_DIR")
fi
NOW_ARGS=()
[[ -n "$CHECK_NOW" ]] && NOW_ARGS=(--now "$CHECK_NOW")

DREAM_RESULT=$(env "${FRESHNESS_ENV[@]}" node "$DAEMONS_ROOT/nightly-freshness.mjs" \
  --kind dream \
  --file "$MEMORY_ROOT/DREAM_LOG.md" \
  --max-days 7 \
  --time-zone "$TIME_ZONE" \
  "${NOW_ARGS[@]}" 2>&1)
DREAM_EXIT=$?
if [[ "$DREAM_EXIT" == "0" ]]; then
  ck "DREAM_LOG.md newest dated header" PASS
else
  ck "DREAM_LOG.md newest dated header" FAIL "$DREAM_RESULT"
fi

WATCHDOG_RESULT=$(env "${FRESHNESS_ENV[@]}" node "$DAEMONS_ROOT/nightly-watchdog.mjs" \
  --root "$ROOT" \
  --check-only \
  --no-deliver \
  "${NOW_ARGS[@]}" 2>&1)
WATCHDOG_EXIT=$?
if [[ "$WATCHDOG_EXIT" == "0" ]]; then
  ck "Nightly fire freshness and terminal evidence" PASS
else
  ck "Nightly fire freshness and terminal evidence" FAIL "$WATCHDOG_RESULT"
fi

# Route validation is read-only here. The route checker owns alert persistence
# when run normally; /system-check must not mutate the alert ledger.
ROUTE_RESULT=$(env \
  AIGENT_ROOT="$ROOT" \
  AIGENT_OS_ROOT="$ROOT" \
  AIGENT_PROJECT_DIR="$ROOT" \
  AIGENT_NIGHTLY_TIME_ZONE="$TIME_ZONE" \
  AIGENT_NIGHTLY_CUTOFF_HOUR="$CUTOFF_HOUR" \
  node "$DAEMONS_ROOT/nightly-route-check.mjs" \
  --root "$ROOT" \
  --home "$ROUTE_HOME" \
  --no-alert \
  --no-deliver 2>&1)
ROUTE_EXIT=$?
if [[ "$ROUTE_EXIT" == "0" ]]; then
  ck "Nightly route resolves to unique close-parity skill" PASS
else
  ck "Nightly route resolves to unique close-parity skill" FAIL "$ROUTE_RESULT"
fi

if [[ -d "$ROOT/evals" ]]; then
  EVAL_COUNT=$(find "$ROOT/evals" -maxdepth 1 -type f \
    \( -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | wc -l)
  if [[ "$EVAL_COUNT" -gt 0 ]]; then
    ck "Evals ($EVAL_COUNT files)" PASS
  else
    ck "Evals" FAIL "directory exists but has no supported eval files"
  fi
else
  ck "Evals" FAIL "evals directory missing"
fi

if [[ -f "$DAEMON_ERR_LOG" ]]; then
  ERROR_COUNT=$(wc -l < "$DAEMON_ERR_LOG")
  if [[ "$ERROR_COUNT" -gt 0 ]]; then
    unsafeRawRecentDaemonErrors \
      "$DAEMON_ERR_LOG" \
      "system-check preserves recent multiline diagnostics until ck renders them as one inert value"
    RECENT="$UNSAFE_RAW_DAEMON_ERRORS"
    ck "Daemon errors: $ERROR_COUNT entries" INFO "$RECENT"
  else
    ck "Daemon errors: 0 entries" PASS
  fi
else
  ck "Daemon error log absent" INFO "expected before the first logged error"
fi

printf '\n%s\n' "$REPORT"
printf 'SUMMARY: %d PASS / %d FAIL / %d INFO\n' "$PASS" "$FAIL" "$INFO"

[[ "$FAIL" == "0" ]] && exit 0 || exit 1
