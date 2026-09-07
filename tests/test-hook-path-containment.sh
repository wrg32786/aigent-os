#!/usr/bin/env bash
# test-hook-path-containment.sh -- doctor.sh 7b flags a hook that runs a script
# outside this install (a sibling vault) while own-seat wiring and a declared
# shared extension pass. Issue #49 G3.
#
# Disposable fixtures only; no live configuration is read or written.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCTOR="$REPO/scripts/doctor.sh"
PASS=0
FAIL=0

# On Windows the doctor's python is native and cygwin/MSYS rewrites the ROOT
# argv to a Windows path while file contents keep their POSIX spelling. Spell
# every fixture path the same way (Windows mixed form) so the fixture exercises
# containment, not a path-dialect mismatch. On Linux CI cygpath is absent and
# the raw POSIX path is already consistent on both sides.
topath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

check() { # name  expect-substring  present|absent  <doctor-output-file>
  local name="$1" needle="$2" mode="$3" out="$4"
  if grep -qF "$needle" "$out"; then found=yes; else found=no; fi
  if { [ "$mode" = present ] && [ "$found" = yes ]; } || { [ "$mode" = absent ] && [ "$found" = no ]; }; then
    echo "  [ok]   $name"; PASS=$((PASS + 1))
  else
    echo "  [FAIL] $name (expected $mode: '$needle'; found=$found)"; echo "    --- 7b output ---"; grep -E "hook|7b" "$out" | sed 's/^/    /'; FAIL=$((FAIL + 1))
  fi
}

# A fixture install root with a manifest that pins one core daemon.
make_root() { # [raw] -- raw keeps mktemp's own spelling so root and hook share one dialect (the Linux CI shape) on Windows too
  local root; root="$(mktemp -d)"; [ "${1:-}" = raw ] || root="$(topath "$root")"
  mkdir -p "$root/.claude" "$root/scripts" "$root/daemons" "$root/.aigent"
  printf '{"required_files":{"daemons/stop-capsule-writer.mjs":"0"}}\n' > "$root/scripts/fleet-baseline-manifest.json"
  : > "$root/daemons/own.mjs"                    # an own-seat script that exists
  : > "$root/daemons/stop-capsule-writer.mjs"    # this install's own core copy
  echo "$root"
}

settings() { # root  command
  cat > "$1/.claude/settings.json" <<JSON
{ "hooks": { "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "$2" } ] } ] } }
JSON
}

run_doctor() { bash "$DOCTOR" "$1" > "$2" 2>&1 || true; }

OK_LINE="all hook command paths resolve inside this install or a declared shared extension"
OTHER="$(topath "$(mktemp -d)")/other-seat/daemons"; mkdir -p "$OTHER"; : > "$OTHER/own.mjs"; : > "$OTHER/stop-capsule-writer.mjs"
SHARED="$(topath "$(mktemp -d)")/shared-ext"; mkdir -p "$SHARED"; : > "$SHARED/ext.mjs"
TMPOUT="$(mktemp)"

# 1. own-seat wiring passes
R="$(make_root)"; settings "$R" "node $R/daemons/own.mjs"; run_doctor "$R" "$TMPOUT"
check "own-seat wiring passes"            "$OK_LINE"                                   present "$TMPOUT"
check "own-seat wiring: no hook fail"     "[fail] hook"                                absent  "$TMPOUT"

# 2. sibling-vault reference FAILS (the offending pattern)
R="$(make_root)"; settings "$R" "node $OTHER/own.mjs"; run_doctor "$R" "$TMPOUT"
check "sibling-vault reference fails"     "hook references a path outside this install" present "$TMPOUT"

# 3. declared shared extension passes
R="$(make_root)"; printf '["%s"]\n' "$SHARED" > "$R/.aigent/shared-extension-roots.json"
settings "$R" "node $SHARED/ext.mjs"; run_doctor "$R" "$TMPOUT"
check "declared shared extension passes"  "$OK_LINE"                                   present "$TMPOUT"

# 4. missing own-seat script is reported
R="$(make_root)"; settings "$R" "node $R/daemons/ghost.mjs"; run_doctor "$R" "$TMPOUT"
check "missing script reported"           "hook script not found"                      present "$TMPOUT"

# 5. a CORE hook resolving outside this install fails even for a real file
R="$(make_root)"; settings "$R" "node $OTHER/stop-capsule-writer.mjs"; run_doctor "$R" "$TMPOUT"
check "core hook outside install fails"   "core hook resolves outside this install"    present "$TMPOUT"

# 6. a core hook pointing at a DECLARED shared root still fails (core must be local)
R="$(make_root)"; printf '["%s"]\n' "$OTHER" > "$R/.aigent/shared-extension-roots.json"
settings "$R" "node $OTHER/stop-capsule-writer.mjs"; run_doctor "$R" "$TMPOUT"
check "core hook in shared root still fails" "core hook resolves outside this install" present "$TMPOUT"

# 7. bash -c body with an embedded sibling script is caught
R="$(make_root)"; settings "$R" "bash -c 'node $OTHER/own.mjs && echo done'"; run_doctor "$R" "$TMPOUT"
check "bash -c embedded sibling caught"   "hook references a path outside this install" present "$TMPOUT"

# 8. malformed declaration is reported, not silently accepted
R="$(make_root)"; printf '{ not an array }\n' > "$R/.aigent/shared-extension-roots.json"
settings "$R" "node $R/daemons/own.mjs"; run_doctor "$R" "$TMPOUT"
check "malformed declaration reported"    "shared-extension-roots.json is present but malformed" present "$TMPOUT"

# 9. a relative parent escape cannot pass as inside (.. is collapsed even though ../escape does not exist;
#    raw root so the fixture reproduces the CI shape where root and hook share one spelling)
R="$(make_root raw)"; settings "$R" "node ../escape/daemons/own.mjs"; run_doctor "$R" "$TMPOUT"
check "relative parent escape fails"      "hook references a path outside this install" present "$TMPOUT"

# 10. an external __pycache__/__tests__-style path is still checked (only __AIGENT_ROOT__-style is skipped)
R="$(make_root)"; settings "$R" "node $OTHER/__pycache__/own.mjs"; run_doctor "$R" "$TMPOUT"
check "external __pycache__ path checked" "hook references a path outside this install" present "$TMPOUT"

echo ""
echo "  hook-path-containment: ${PASS} pass, ${FAIL} fail"
[ "$FAIL" -eq 0 ]
