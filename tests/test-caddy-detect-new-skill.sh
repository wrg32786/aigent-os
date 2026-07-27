#!/usr/bin/env bash
# Regression test for daemons/caddy-detect-new-skill.sh.
#
# The hook normalizes a written file's path before testing whether it lands
# under skills/. That normalization once looked for two consecutive
# backslashes. A JSON-decoded path carries single ones, so on a
# backslash-separated path the replace matched nothing, the "/skills/" test
# failed, and the hook exited silently. This test exists so that failure
# cannot return unnoticed.
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
# WHAT IS ESTABLISHED AND WHAT IS NOT, for whoever touches this next:
#
#   Established, and demonstrated by this suite: JSON decoding turns an
#   escaped backslash into a single one, and the old two-character pattern
#   cannot match a path carrying single backslashes.
#
#   Not established: that the Write tool on Windows delivers backslash-
#   separated paths at all. No real payload has ever been captured.
#
#   Not evidence, despite being cited as such while this was written: a grep
#   of one install's runtime logs for the nudge string, which found nothing.
#   The hook turned out not to be registered in that install, and an unwired
#   hook emits nothing whatever its path handling does, so the silence has an
#   ordinary explanation and separates none of the possibilities. Even setting
#   registration aside, absence from a log only means something once you have
#   shown the log would have captured the event, which was never shown here.
#   Treat the single-backslash reading as inference, not as history.
#
#   Settling it is cheap: log one real payload from a Windows Write and read
#   its separator. Do that before treating either reading as fact.
#
# Nothing rides on the answer. The fix is correct either way: if the harness
# delivers forward slashes, replacing a backslash is a no-op on a path that
# contains none, and the hook fires as it always did. That is why this suite
# asserts the behaviour on both path styles instead of choosing one.

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
