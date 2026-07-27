#!/usr/bin/env bash
# Regression test for daemons/caddy-detect-new-skill.sh.
#
# The hook normalizes a written file's path before testing whether it lands
# under skills/. That normalization once looked for two consecutive
# backslashes, which a decoded hook payload never contains, so on Windows the
# hook matched nothing and exited silently. It had never fired there. This
# test exists so that failure cannot return unnoticed.
#
# The two silent cases are the important half. Without them a hook that never
# printed anything would pass a nudge-only test by accident, which is exactly
# how the original bug survived: silence looked like "no new skills today".
#
# Paths are built from chr(92) inside Python rather than written as literals,
# and the payload is produced by json.dumps, so no shell or heredoc escaping
# sits between the intended path and the bytes the hook receives. Getting that
# wrong is what hid the bug in the first place.
#
# CAVEAT for whoever touches this next: nobody has captured a real Write-tool
# payload on Windows and confirmed its separator. The single-backslash shape
# tested here is inferred from JSON decoding plus the observation that the
# hook had never once fired on a Windows machine. If the harness actually
# hands over forward slashes, the original code was never broken and the
# silence needs a different explanation. Logging one real payload settles it
# and is worth doing before trusting either story.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir -p "$WORK/.claude"

cat > "$WORK/.claude/skill-index.json" <<'JSON'
[
  {
    "name": "alreadyenrolled",
    "triggers": ["already enrolled"],
    "why": "Fixture: a skill the index already knows about"
  }
]
JSON

fail=0

# mkpayload <style> <segment>... -> one JSON hook payload on stdout
# style: win (single backslash), windouble (two), posix (forward slash)
mkpayload () {
  python3 - "$@" <<'PY'
import json, sys
style = sys.argv[1]
parts = sys.argv[2:]
if style == "win":
    sep, prefix = chr(92), "C:"
elif style == "windouble":
    sep, prefix = chr(92) * 2, "C:"
else:
    sep, prefix = "/", ""
print(json.dumps({"tool_name": "Write",
                  "tool_input": {"file_path": prefix + sep + sep.join(parts)}}))
PY
}

check () {
  local label="$1" expect="$2" style="$3"; shift 3
  local out got
  out="$(mkpayload "$style" "$@" | AIGENT_ROOT="$WORK" bash "$ROOT/daemons/caddy-detect-new-skill.sh")"
  if [ -n "$out" ]; then got="nudge"; else got="silent"; fi
  if [ "$got" = "$expect" ]; then
    printf 'ok: %-44s %s\n' "$label" "$got"
  else
    printf 'FAIL: %-42s expected %s, got %s\n' "$label" "$expect" "$got" >&2
    [ -n "$out" ] && printf '      output: %s\n' "$out" >&2
    fail=1
  fi
}

# A new, un-enrolled skill must be announced on every path style.
check "windows path, new skill"        nudge  win       dev aigent-os skills brandnew SKILL.md
check "posix path, new skill"          nudge  posix     c dev aigent-os skills brandnew SKILL.md

# Silent controls: these prove silence is a real outcome and not a dead hook.
check "windows path, already enrolled" silent win       dev aigent-os skills alreadyenrolled SKILL.md
check "posix path, already enrolled"   silent posix     c dev aigent-os skills alreadyenrolled SKILL.md
check "windows path, not a skill file" silent win       dev aigent-os docs security.md

# A path whose separators are genuinely doubled must still be detected: each
# backslash becomes a slash, leaving "//skills//", which still contains
# "/skills/". The skill name parsed out of such a path comes back empty, which
# only affects the wording of the message, so this asserts detection alone.
check "doubled separators, new skill"  nudge  windouble dev aigent-os skills brandnew SKILL.md

test "$fail" -eq 0
printf 'caddy-detect-new-skill regression tests passed\n'
