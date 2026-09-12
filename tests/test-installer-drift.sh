#!/usr/bin/env bash
# Installer drift regression suite (board row 9e66f188). Three scenarios the
# fast suite does not cover: a pre-existing non-sensitive framework file
# (scripts/, launcher/) never gets refreshed even when it differs from the
# framework's copy; the settings.json merge appends a duplicate hook entry
# whenever its command is spelled differently from the template's rendered
# copy; and launcher wiring runs unconditionally, repointing the machine's
# real front door at a throwaway scratch/temp target. Kept in its own file so
# tests/test-installer-fast.sh's TOTAL count stays untouched.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=4

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# Where the launcher-wiring stubs (below, finding 3) record their argv.
# Declared once, up top, because make_fixture bakes this path into the
# fixture's own launcher/install.sh so every fixture's stub writes here.
WIRE_LOG="$WORK/wire-log.txt"

json_valid() {
  local file="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$file" >/dev/null
  else
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file"
  fi
}

# Reused by all three scenarios below. scripts/fleet-baseline-manifest.json
# and launcher/install.sh give findings 1 and 3 something to drift against;
# the reduced settings.json.template (two hooks, not the full product set)
# gives finding 2 a small, known-shape merge target.
make_fixture() {
  local source="$1"
  mkdir -p "$source"/{system,vault/agents,skills/demo,hooks,daemons,scripts,docs,memory,evals,launcher,.claude/rules}
  cp "$ROOT/install.sh" "$source/install.sh"
  cp "$ROOT/daemons/memory-root.sh" "$ROOT/daemons/memory-root.cjs" "$source/daemons/"
  printf '# Identity\n' > "$source/system/00_identity.md"
  printf '# Claude source\n' > "$source/CLAUDE.md"
  printf '%s\n' '---' 'name: demo' '---' > "$source/skills/demo/SKILL.md"
  printf '%s\n' '---' 'name: scout' 'tools: [Read]' '---' > "$source/vault/agents/scout.md"
  printf '# critical\n' > "$source/.claude/rules/post-compact-critical.md"
  cat > "$source/.claude/settings.json.template" <<'JSON'
{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__","AIGENT_VAULT":"__AIGENT_ROOT__"},"statusLine":{"type":"command","command":"bash \"__AIGENT_ROOT__/daemons/statusline-ctx.sh\""},"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"node \"__AIGENT_ROOT__/daemons/sessionstart-reinject.mjs\"","timeout":3000}]}],"Stop":[{"matcher":"","hooks":[{"type":"command","command":"node \"__AIGENT_ROOT__/daemons/stop-capsule-writer.mjs\"","timeout":2000}]}]}}
JSON
  printf '[]\n' > "$source/.claude/skill-index.json"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$source/daemons/statusline-ctx.sh"
  printf '{"manifestVersion":"v8","files":{}}\n' > "$source/scripts/fleet-baseline-manifest.json"
  # A recording stub, never the real platform launcher installer (fence:
  # findings 1/2 never execute it, --no-launcher is always passed for them;
  # finding 3 executes it deliberately, on the non-Windows wiring branch, and
  # must never run the real launcher/install.sh on this machine).
  cat > "$source/launcher/install.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WIRE_LOG"
exit 0
EOF
  printf '#!/usr/bin/env bash\nexit 0\n' > "$source/launcher/aigent.sh"
  printf 'framework aigent.ps1\n' > "$source/launcher/aigent.ps1"
  printf 'framework install.ps1\n' > "$source/launcher/install.ps1"
}

# ── 1. Stale non-sensitive files: scripts/ and launcher/ get refreshed ──────
# scripts/fleet-baseline-manifest.json and launcher/install.sh hit install.sh's
# `*)` catch-all (sensitive=0), so a pre-existing file there that differs from
# the framework's copy was kept forever -- doctor.sh --attest then reads a
# dead baseline. --no-launcher throughout: this scenario tests the copy loop,
# never the launcher wiring step (that is finding 3, below).
FIXTURE1="$WORK/source-f1"
make_fixture "$FIXTURE1"

TARGET1="$WORK/target-f1"
mkdir -p "$TARGET1/scripts" "$TARGET1/launcher"
printf '{"manifestVersion":"v1","stale":true}\n' > "$TARGET1/scripts/fleet-baseline-manifest.json"
printf '#!/usr/bin/env bash\necho "STALE LAUNCHER"\n' > "$TARGET1/launcher/install.sh"
(
  cd "$FIXTURE1"
  bash install.sh --target "$TARGET1" --no-deps --no-launcher >/dev/null
)
cmp -s "$FIXTURE1/scripts/fleet-baseline-manifest.json" "$TARGET1/scripts/fleet-baseline-manifest.json" \
  || fail "finding 1: scripts/fleet-baseline-manifest.json was not refreshed to match the framework copy"
cmp -s "$FIXTURE1/launcher/install.sh" "$TARGET1/launcher/install.sh" \
  || fail "finding 1: launcher/install.sh was not refreshed to match the framework copy"

# --trust-existing must keep its existing meaning once scripts/launcher join
# the sensitive set: a differing pre-existing file is kept, not quarantined.
TARGET1B="$WORK/target-f1-trust"
mkdir -p "$TARGET1B/scripts" "$TARGET1B/launcher"
printf '{"manifestVersion":"v1","stale":true}\n' > "$TARGET1B/scripts/fleet-baseline-manifest.json"
printf '#!/usr/bin/env bash\necho "STALE LAUNCHER"\n' > "$TARGET1B/launcher/install.sh"
TRUST_OUT="$(cd "$FIXTURE1" && bash install.sh --target "$TARGET1B" --trust-existing --no-deps --no-launcher 2>&1)"
grep -q "STALE LAUNCHER" "$TARGET1B/launcher/install.sh" \
  || fail "finding 1: --trust-existing did not keep the pre-existing launcher/install.sh"
grep -q '"stale": *true' "$TARGET1B/scripts/fleet-baseline-manifest.json" \
  || fail "finding 1: --trust-existing did not keep the pre-existing scripts/fleet-baseline-manifest.json"
printf '%s\n' "$TRUST_OUT" | grep -qi '\[quarantine\]' \
  && fail "finding 1: --trust-existing quarantined scripts/launcher instead of keeping them"
printf '[1/%d] finding 1: stale scripts/launcher files refreshed; --trust-existing still keeps them\n' "$TOTAL"

# ── 2. Settings merge: dedupe hooks by identity, not whole-object equality ──
# The merge treats each event's hook groups as opaque list items compared by
# canonical JSON equality, so a hook the template already ships gets a SECOND
# copy appended whenever its rendered command is spelled differently (a stale
# path prefix from a prior install, backslash vs forward slash, etc.) -- the
# scratch install this row reports duplicated nearly every hook already in
# pheme's settings.json this way. An already-identical entry was already
# deduped correctly before this fix; that case is included below as a
# regression guard, not because it was red.
#
# extract_heredoc pulls the ACTUAL merge script bodies out of install.sh by
# anchor + closing delimiter (never by line number, which the fix below
# shifts) so this exercises the real shipped code, not a re-implementation of
# it, and both the python3 and node paths get the same two fixture files so
# "kept both mergers behaviorally identical" is something this suite checks
# rather than something the ledger merely asserts.
extract_heredoc() {
  local anchor="$1" delimiter="$2" file="$3" start_line end_line
  start_line="$(grep -n -F "$anchor" "$file" | head -1 | cut -d: -f1)"
  [[ -n "$start_line" ]] || fail "extract_heredoc: anchor not found in $file: $anchor"
  end_line="$(awk -v s="$start_line" -v d="$delimiter" 'NR>s && $0==d{print NR; exit}' "$file")"
  [[ -n "$end_line" ]] || fail "extract_heredoc: delimiter $delimiter not found after line $start_line in $file"
  sed -n "$((start_line+1)),$((end_line-1))p" "$file"
}

FIXTURE2="$WORK/source-f2"
make_fixture "$FIXTURE2"

MERGE2="$WORK/merge2"
mkdir -p "$MERGE2"
extract_heredoc 'AIGENT_TMP/merge-settings.py"' 'PY' "$FIXTURE2/install.sh" > "$MERGE2/merge-settings.py"
extract_heredoc 'AIGENT_TMP/merge-settings.cjs"' 'JS' "$FIXTURE2/install.sh" > "$MERGE2/merge-settings.cjs"

# base = a target's pre-existing settings.json; addition = the freshly
# rendered template for this install. Three cases in one event each:
#  - SessionStart: same hook, spelled differently (stale path prefix) -- RED
#    on unmodified code: the old entry survives alongside the new one.
#  - Stop: an exact duplicate of the template's entry -- already deduped
#    correctly before this fix (canonical JSON equality catches it); kept
#    here as a regression guard.
#  - PreToolUse: a custom hook the template does not ship at all -- must
#    survive the merge untouched either way.
cat > "$MERGE2/base.json" <<'JSON'
{
  "env": {"AIGENT_ROOT": "OLDROOT", "AIGENT_VAULT": "OLDROOT"},
  "hooks": {
    "SessionStart": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"OLDROOT/daemons/sessionstart-reinject.mjs\"", "timeout": 3000}]}
    ],
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"NEWROOT/daemons/stop-capsule-writer.mjs\"", "timeout": 2000}]}
    ],
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash \"/custom/hooks/my-custom-guard.sh\"", "timeout": 1000}]}
    ]
  }
}
JSON
cat > "$MERGE2/addition.json" <<'JSON'
{
  "env": {"AIGENT_ROOT": "NEWROOT", "AIGENT_VAULT": "NEWROOT"},
  "hooks": {
    "SessionStart": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"NEWROOT/daemons/sessionstart-reinject.mjs\"", "timeout": 3000}]}
    ],
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"NEWROOT/daemons/stop-capsule-writer.mjs\"", "timeout": 2000}]}
    ]
  }
}
JSON

check_merge_result() {
  local label="$1" file="$2" expected_root="$3" stale_marker="$4"
  json_valid "$file" || fail "finding 2 ($label): merged output is not valid JSON"
  # expected_root can be a real canonical filesystem path (the end-to-end
  # case below passes $TARGET2_CANON) -- Git Bash's MSYS layer rewrites a
  # POSIX-looking argv into its Windows equivalent before a native python3.exe
  # ever sees it, which would make this string comparison fail for a reason
  # that has nothing to do with the merge logic under test. Route it through
  # an excluded env var instead, the same way install.sh's own
  # render_settings_template avoids the same trap for AIGENT_ROOT.
  MSYS2_ENV_CONV_EXCL=AIGENT_DRIFT_TEST_ \
    AIGENT_DRIFT_TEST_EXPECTED_ROOT="$expected_root" \
    AIGENT_DRIFT_TEST_STALE_MARKER="$stale_marker" \
    python3 - "$file" "$label" <<'PY'
import json
import os
import sys

path, label = sys.argv[1], sys.argv[2]
expected_root = os.environ["AIGENT_DRIFT_TEST_EXPECTED_ROOT"]
stale_marker = os.environ["AIGENT_DRIFT_TEST_STALE_MARKER"]
with open(path, encoding="utf-8") as fh:
    doc = json.load(fh)

session_start = doc["hooks"]["SessionStart"]
if len(session_start) != 1:
    sys.exit(f"finding 2 ({label}): expected exactly one SessionStart group, got {len(session_start)}")
command = session_start[0]["hooks"][0]["command"]
if stale_marker in command:
    sys.exit(f"finding 2 ({label}): SessionStart kept the stale-path duplicate instead of the template's entry")
if expected_root not in command:
    sys.exit(f"finding 2 ({label}): SessionStart lost the template's entry entirely")

stop = doc["hooks"]["Stop"]
if len(stop) != 1:
    sys.exit(f"finding 2 ({label}): expected exactly one Stop group (exact-duplicate case), got {len(stop)}")

pre_tool_use = doc["hooks"].get("PreToolUse", [])
if not any(
    "my-custom-guard.sh" in hook.get("command", "")
    for group in pre_tool_use
    for hook in group.get("hooks", [])
):
    sys.exit(f"finding 2 ({label}): PreToolUse lost the custom hook the template does not ship")
PY
}

python3 "$MERGE2/merge-settings.py" "$MERGE2/base.json" "$MERGE2/addition.json" "$MERGE2/merged.py.json" \
  || fail "finding 2: python merge script exited non-zero"
check_merge_result python "$MERGE2/merged.py.json" "NEWROOT" "OLDROOT"

node "$MERGE2/merge-settings.cjs" "$MERGE2/base.json" "$MERGE2/addition.json" "$MERGE2/merged.cjs.json" \
  || fail "finding 2: node merge script exited non-zero"
check_merge_result node "$MERGE2/merged.cjs.json" "NEWROOT" "OLDROOT"

python3 - "$MERGE2/merged.py.json" "$MERGE2/merged.cjs.json" <<'PY'
import json
import sys

a_path, b_path = sys.argv[1], sys.argv[2]
with open(a_path, encoding="utf-8") as fh:
    a = json.load(fh)
with open(b_path, encoding="utf-8") as fh:
    b = json.load(fh)
if a != b:
    sys.exit("finding 2: python and node mergers produced different results for the same input")
PY

# End-to-end: a real install onto a target with the stale-path duplicate and
# the custom hook, through whichever runtime install.sh picks on this host.
TARGET2="$WORK/target-f2"
mkdir -p "$TARGET2/.claude"
cp "$MERGE2/base.json" "$TARGET2/.claude/settings.json"
TARGET2_CANON="$(cd "$TARGET2" && pwd -P)"
(
  cd "$FIXTURE2"
  bash install.sh --target "$TARGET2" --no-deps --no-launcher >/dev/null
)
check_merge_result "end-to-end" "$TARGET2/.claude/settings.json" "$TARGET2_CANON" "OLDROOT"
printf '[2/%d] finding 2: settings merge dedupes hooks by resolved identity in both mergers\n' "$TOTAL"

# ── 3. Launcher wiring never touches a scratch/temp target ─────────────────
# wire_aigent_front_door ran unconditionally unless --no-launcher was passed
# explicitly, so installing to a target that happens to resolve under the
# system temp directory (a smoke test, a throwaway eval run, anything built
# under mktemp) silently repointed the machine's real `aigent` command and
# desktop/Start Menu shortcuts at that throwaway tree. Stubs on PATH (and the
# fixture's own launcher/install.sh, above) record what actually got invoked
# instead of running a real platform launcher installer -- required even for
# the "normal" case below, since this suite must never wire this machine's
# real front door either.
FIXTURE3="$WORK/source-f3"
make_fixture "$FIXTURE3"

STUB_BIN="$WORK/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/pwsh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WIRE_LOG"
exit 0
EOF
cp "$STUB_BIN/pwsh" "$STUB_BIN/powershell.exe"
chmod +x "$STUB_BIN/pwsh" "$STUB_BIN/powershell.exe"

# $WORK is itself a mktemp directory, so a "normal" (non-scratch) target has
# to live somewhere else -- inside this worktree, cleaned up below alongside
# $WORK.
NORMAL_HOST="$ROOT/.aigent-drift-test-scratch-$$"
trap 'rm -rf "$WORK" "$NORMAL_HOST"' EXIT INT TERM
NORMAL_TARGET="$NORMAL_HOST/normal-target"
mkdir -p "$NORMAL_TARGET"
NORMAL_TARGET_CANON="$(cd "$NORMAL_TARGET" && pwd -P)"

: > "$WIRE_LOG"
NORMAL_OUT="$(cd "$FIXTURE3" && PATH="$STUB_BIN:$PATH" bash install.sh --target "$NORMAL_TARGET" --no-deps 2>&1)"
printf '%s\n' "$NORMAL_OUT" | grep -qi '\[ok\] aigent command and platform launcher wired' \
  || fail "finding 3: normal-target install did not report wiring the launcher ($NORMAL_OUT)"
printf '%s\n' "$NORMAL_OUT" | grep -F -q "$NORMAL_TARGET_CANON" \
  || fail "finding 3: the wired line did not name the target path it wired"
[[ -s "$WIRE_LOG" ]] \
  || fail "finding 3: normal-target install did not actually invoke a platform launcher installer"

# A target resolving under the system temp directory: wiring must be skipped
# loudly, install must still succeed, and no launcher installer gets run.
SCRATCH_TARGET="$WORK/scratch-target"
: > "$WIRE_LOG"
SCRATCH_OUT="$(cd "$FIXTURE3" && PATH="$STUB_BIN:$PATH" bash install.sh --target "$SCRATCH_TARGET" --no-deps 2>&1)"
printf '%s\n' "$SCRATCH_OUT" | grep -qi '\[skip\].*launcher' \
  || fail "finding 3: scratch-target install did not print a launcher skip line ($SCRATCH_OUT)"
printf '%s\n' "$SCRATCH_OUT" | grep -qi 'no-launcher' \
  || fail "finding 3: scratch-target skip line did not name the --no-launcher equivalence"
[[ ! -s "$WIRE_LOG" ]] \
  || fail "finding 3: scratch-target install invoked a platform launcher installer anyway"
test -f "$SCRATCH_TARGET/.claude/settings.json" \
  || fail "finding 3: scratch-target install did not otherwise complete"
printf '[3/%d] finding 3: launcher wiring names its target; scratch/temp targets are skipped, not wired\n' "$TOTAL"

# ── 4. Round-1 review fixes: hook_basename edge cases + merger type parity ──
# R26 review findings C, D, E, F, G on the finding-2 fix above. Reuses the
# merge-settings.py/.cjs already extracted into $MERGE2 by finding 2.
#  - C: the quote regex matched ANY quote character as the closer, so a
#    single quote inside a double-quoted path (an apostrophe in a user's
#    home directory name) ended the match early and corrupted the basename.
#  - D: an unquoted command with no quoted token fell back to the WHOLE
#    command string as the basename, so a trailing flag like `--strict`
#    never matched the template's quoted equivalent.
#  - E: a hook with no `command` at all (prompt-type) hashes to an empty
#    basename; two unrelated commandless hooks must never dedupe against
#    each other just because both are unidentifiable.
#  - F: a hook actually dropped by dedupe must print a `[merge] dropped`
#    notice, not disappear silently.
#  - G: a genuine type mismatch (old array, new object) at a path outside
#    "hooks" must fall through to the unchanged old value in BOTH mergers,
#    not just python's.
cat > "$MERGE2/base-r1.json" <<'JSON'
{
  "permissions": {"allow": ["Read", "Grep"]},
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "node \"/Users/Will O'Brien/aigent/daemons/gateguard.mjs\"", "timeout": 3000}]}
    ],
    "PostToolUse": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node /opt/aigent/daemons/gateguard2.mjs --strict", "timeout": 2000}]}
    ],
    "SessionEnd": [
      {"matcher": "", "hooks": [{"type": "prompt", "prompt": "an old, unrelated commandless hook"}]}
    ]
  }
}
JSON
cat > "$MERGE2/addition-r1.json" <<'JSON'
{
  "permissions": {"allow": {"unexpected": "object-not-array"}},
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "node \"/new/target/daemons/gateguard.mjs\"", "timeout": 3000}]}
    ],
    "PostToolUse": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"/new/target/daemons/gateguard2.mjs\"", "timeout": 2000}]}
    ],
    "SessionEnd": [
      {"matcher": "", "hooks": [{"type": "prompt", "prompt": "a different, unrelated commandless hook from the template"}]}
    ]
  }
}
JSON

check_round1_result() {
  local label="$1" file="$2"
  python3 - "$file" "$label" <<'PY'
import json
import sys

path, label = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    doc = json.load(fh)

pre = doc["hooks"]["PreToolUse"]
if len(pre) != 1:
    sys.exit(f"round1 C ({label}): apostrophe-path hook was not deduped, expected 1 PreToolUse group, got {len(pre)}")

post = doc["hooks"]["PostToolUse"]
if len(post) != 1:
    sys.exit(f"round1 D ({label}): unquoted+flag hook was not deduped, expected 1 PostToolUse group, got {len(post)}")

session_end = doc["hooks"]["SessionEnd"]
if len(session_end) != 2:
    sys.exit(f"round1 E ({label}): commandless hooks wrongly deduped against each other, expected 2 SessionEnd groups, got {len(session_end)}")

allow = doc["permissions"]["allow"]
if allow != ["Read", "Grep"]:
    sys.exit(f"round1 G ({label}): a type mismatch (array vs object) did not fall through to the unchanged old value, got {allow!r}")
PY
}

MERGED_R1_PY_OUT="$(python3 "$MERGE2/merge-settings.py" "$MERGE2/base-r1.json" "$MERGE2/addition-r1.json" "$MERGE2/merged-r1.py.json")" \
  || fail "round1: python merge script exited non-zero"
check_round1_result python "$MERGE2/merged-r1.py.json"
printf '%s\n' "$MERGED_R1_PY_OUT" | grep -q '\[merge\] dropped' \
  || fail "round1 F (python): no [merge] dropped notice printed for a deduped hook"

MERGED_R1_NODE_OUT="$(node "$MERGE2/merge-settings.cjs" "$MERGE2/base-r1.json" "$MERGE2/addition-r1.json" "$MERGE2/merged-r1.cjs.json")" \
  || fail "round1: node merge script exited non-zero"
check_round1_result node "$MERGE2/merged-r1.cjs.json"
printf '%s\n' "$MERGED_R1_NODE_OUT" | grep -q '\[merge\] dropped' \
  || fail "round1 F (node): no [merge] dropped notice printed for a deduped hook"

python3 - "$MERGE2/merged-r1.py.json" "$MERGE2/merged-r1.cjs.json" <<'PY'
import json
import sys

a_path, b_path = sys.argv[1], sys.argv[2]
with open(a_path, encoding="utf-8") as fh:
    a = json.load(fh)
with open(b_path, encoding="utf-8") as fh:
    b = json.load(fh)
if a != b:
    sys.exit("round1 G: python and node mergers produced different results for the type-mismatch case")
PY
printf '[4/%d] round 1: hook_basename quote/unquoted/empty-basename fixes verified; drop is announced; mergers stay identical on a type mismatch\n' "$TOTAL"

printf 'installer drift suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
