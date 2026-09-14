#!/usr/bin/env bash
# Regression suite for the installer drift findings. Three scenarios the
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

TOTAL=6

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# Precondition, stated up front rather than checked per call site: finding 2
# below extracts install.sh's actual python AND node merger heredocs and runs
# both (that is the point -- proving they stay behaviorally identical), so
# this suite needs both runtimes on PATH, unlike install.sh itself, which
# only ever needs one of the two.
command -v python3 >/dev/null 2>&1 || fail "tests/test-installer-drift.sh requires python3 on PATH"
command -v node >/dev/null 2>&1 || fail "tests/test-installer-drift.sh requires node on PATH"

# Where the launcher-wiring stubs (below, finding 3) record their argv.
# Declared once, up top, because make_fixture bakes this path into the
# fixture's own launcher/install.sh so every fixture's stub writes here.
WIRE_LOG="$WORK/wire-log.txt"

json_valid() {
  python3 -m json.tool "$1" >/dev/null
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
# a real operator settings.json this way. An already-identical entry was already
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

# ── 5. Round-2 review fixes: no-separator fallback and quoted decoys ────────
# R26 review findings J, K on the finding-2 fix (reopened after round 1's own
# fix): both mergers' unquoted fallback picked the LAST word, so a trailing
# flag like `--strict` became the basename instead of the real script name,
# and the FIRST quoted substring was trusted as the path even when it was
# just a decoy earlier in the command with the real, unquoted path following.
#  - J-1: `node foo.mjs --strict` vs `node foo.mjs` -- flipped in round 3:
#    neither command's script carries a directory, so identity is now
#    ambiguous for both (ownership needs the last TWO path components, not
#    a bare basename) and the hook is KEPT rather than deduped. The
#    template never ships a bare filename, so nothing the product installs
#    can actually duplicate through this path.
#  - J-2: a module invocation vs an unrelated script, both ending in the same
#    flag -- must NOT collide just because the fallback used to grab that
#    flag as if it were the basename.
#  - J-3: a command that is nothing but flags -- basename must stay empty,
#    never "whatever word came last", so it never wrongly matches anything.
#  - K: a quoted decoy before the real, unquoted path -- the real path must
#    still be found and correctly deduped against the template's copy.
cat > "$MERGE2/base-r2.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node foo.mjs --strict", "timeout": 1000}]}
    ],
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "python -m aigent.daemon.gateguard --strict", "timeout": 1000}]}
    ],
    "PreCompact": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node --strict", "timeout": 1000}]}
    ],
    "Notification": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"echo 'hi'\" /opt/aigent/daemons/gateguard.mjs", "timeout": 1000}]}
    ]
  }
}
JSON
cat > "$MERGE2/addition-r2.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node foo.mjs", "timeout": 1000}]}
    ],
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node bar.mjs --strict", "timeout": 1000}]}
    ],
    "PreCompact": [
      {"matcher": "", "hooks": [{"type": "command", "command": "python --strict", "timeout": 1000}]}
    ],
    "Notification": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"/new/target/daemons/gateguard.mjs\"", "timeout": 1000}]}
    ]
  }
}
JSON

check_round2_result() {
  local label="$1" file="$2"
  python3 - "$file" "$label" <<'PY'
import json
import sys

path, label = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    doc = json.load(fh)

session_start = doc["hooks"]["SessionStart"]
if len(session_start) != 2:
    sys.exit(f"round2 J-1 ({label}): 'node foo.mjs --strict' vs 'node foo.mjs' (neither has a directory, so identity is ambiguous) expected 2 SessionStart groups (KEPT), got {len(session_start)}")

stop = doc["hooks"]["Stop"]
if len(stop) != 2:
    sys.exit(f"round2 J-2 ({label}): different basenames should both survive, expected 2 Stop groups, got {len(stop)}")

pre_compact = doc["hooks"]["PreCompact"]
if len(pre_compact) != 2:
    sys.exit(f"round2 J-3 ({label}): all-flags commands (empty basename) must never dedupe, expected 2 PreCompact groups, got {len(pre_compact)}")

notification = doc["hooks"]["Notification"]
if len(notification) != 1:
    sys.exit(f"round2 K ({label}): quoted decoy before the real path, expected 1 Notification group (deduped), got {len(notification)}")
command = notification[0]["hooks"][0]["command"]
if "/new/target" not in command:
    sys.exit(f"round2 K ({label}): the surviving Notification entry is not the template's copy: {command!r}")
PY
}

MERGED_R2_PY_OUT="$(python3 "$MERGE2/merge-settings.py" "$MERGE2/base-r2.json" "$MERGE2/addition-r2.json" "$MERGE2/merged-r2.py.json")" \
  || fail "round2: python merge script exited non-zero"
check_round2_result python "$MERGE2/merged-r2.py.json"

MERGED_R2_NODE_OUT="$(node "$MERGE2/merge-settings.cjs" "$MERGE2/base-r2.json" "$MERGE2/addition-r2.json" "$MERGE2/merged-r2.cjs.json")" \
  || fail "round2: node merge script exited non-zero"
check_round2_result node "$MERGE2/merged-r2.cjs.json"

python3 - "$MERGE2/merged-r2.py.json" "$MERGE2/merged-r2.cjs.json" <<'PY'
import json
import sys

a_path, b_path = sys.argv[1], sys.argv[2]
with open(a_path, encoding="utf-8") as fh:
    a = json.load(fh)
with open(b_path, encoding="utf-8") as fh:
    b = json.load(fh)
if a != b:
    sys.exit("round2: python and node mergers produced different results for the no-separator/quoted-decoy fixtures")
PY
printf '[5/%d] round 2: no-separator fallback skips flags and the interpreter; a quoted decoy no longer hides the real path\n' "$TOTAL"

# ── 6. Round-3 fix order 9e66f188: ownership is dir/basename, not basename ──
# Basename-only ownership (rounds 1-2) collided two DIFFERENT scripts that
# happen to share a filename, and let a stale hook survive when its
# interpreter was invoked by an absolute path.
#  - Case A: an operator's own extension hook (extensions/gateguard.mjs)
#    must survive a template hook shipping a DIFFERENT script that happens
#    to share the same basename (daemons/gateguard.mjs) -- basename-only
#    matching wrongly dropped the extension; last-two-components ownership
#    tells them apart and keeps both, each with its own matcher/options.
#  - Case B: a stale core hook invoked via an absolute interpreter path
#    (`/usr/bin/node /old/daemons/gateguard.mjs`) must still be recognized
#    as the SAME script as the template's `node "/new/target/daemons/gateguard.mjs"`
#    and dropped -- the old basename lookup mistook the interpreter path
#    itself ("node") for the identity and never matched.
cat > "$MERGE2/base-r3.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "node \"/opt/aigent/extensions/gateguard.mjs\" --policy local", "timeout": 1000}]}
    ],
    "PostToolUse": [
      {"matcher": "", "hooks": [{"type": "command", "command": "/usr/bin/node /old/daemons/gateguard.mjs", "timeout": 2000}]}
    ],
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node C:\\old\\daemons\\gateguard.mjs", "timeout": 2000}]}
    ],
    "PreCompact": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node /opt/proj#2/daemons/gateguard.mjs", "timeout": 2000}]}
    ]
  }
}
JSON
cat > "$MERGE2/addition-r3.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {"matcher": "Edit|Write|Bash", "hooks": [{"type": "command", "command": "node \"/new/target/daemons/gateguard.mjs\"", "timeout": 1000}]}
    ],
    "PostToolUse": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"/new/target/daemons/gateguard.mjs\"", "timeout": 2000}]}
    ],
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"C:/new/target/daemons/gateguard.mjs\"", "timeout": 2000}]}
    ],
    "PreCompact": [
      {"matcher": "", "hooks": [{"type": "command", "command": "node \"/new/target/daemons/gateguard.mjs\"", "timeout": 2000}]}
    ]
  }
}
JSON

check_round3_result() {
  local label="$1" file="$2"
  python3 - "$file" "$label" <<'PY'
import json
import sys

path, label = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    doc = json.load(fh)

pre = doc["hooks"]["PreToolUse"]
if len(pre) != 2:
    sys.exit(f"round3 Case A ({label}): extension hook and template hook must both survive as 2 PreToolUse groups, got {len(pre)}")
extension_kept = any(
    group.get("matcher") == "Bash"
    and any("extensions/gateguard.mjs" in h.get("command", "") for h in group.get("hooks", []))
    for group in pre
)
if not extension_kept:
    sys.exit(f"round3 Case A ({label}): the operator's extensions/gateguard.mjs hook was dropped (basename collided with daemons/gateguard.mjs)")
core_installed = any(
    "daemons/gateguard.mjs" in h.get("command", "")
    for group in pre
    for h in group.get("hooks", [])
)
if not core_installed:
    sys.exit(f"round3 Case A ({label}): the template's daemons/gateguard.mjs core hook is missing")

post = doc["hooks"]["PostToolUse"]
if len(post) != 1:
    sys.exit(f"round3 Case B ({label}): stale absolute-interpreter-path hook was not deduped, expected 1 PostToolUse group, got {len(post)}")
command = post[0]["hooks"][0]["command"]
if "/new/target/daemons/gateguard.mjs" not in command:
    sys.exit(f"round3 Case B ({label}): the surviving PostToolUse entry is not the template's copy: {command!r}")
if "/old/daemons" in command:
    sys.exit(f"round3 Case B ({label}): the stale entry survived instead of the template's: {command!r}")

# Case C: an UNQUOTED Windows backslash path must resolve to the same
# dir/basename identity as the template's forward-slash copy in BOTH
# runtimes. A tokenizer that treats backslash as an escape (python's
# shlex.split default) would read C:olddaemonsgateguard.mjs, see no path,
# and KEEP the stale hook while the node merger drops it.
stop = doc["hooks"]["Stop"]
if len(stop) != 1:
    sys.exit(f"round3 Case C ({label}): stale unquoted backslash-path hook was not deduped, expected 1 Stop group, got {len(stop)}")
command = stop[0]["hooks"][0]["command"]
if "C:/new/target/daemons/gateguard.mjs" not in command or "old" in command:
    sys.exit(f"round3 Case C ({label}): the surviving Stop entry is not the template's copy: {command!r}")

# Case D: a "#" inside a directory name is path text, not a comment. A
# tokenizer with shell comment syntax (python's shlex default) would cut
# the command at the "#", read the wrong tail, and KEEP the stale hook
# while the node merger drops it.
pre_compact = doc["hooks"]["PreCompact"]
if len(pre_compact) != 1:
    sys.exit(f"round3 Case D ({label}): stale hook with a '#' in its directory was not deduped, expected 1 PreCompact group, got {len(pre_compact)}")
command = pre_compact[0]["hooks"][0]["command"]
if "/new/target/daemons/gateguard.mjs" not in command or "#" in command:
    sys.exit(f"round3 Case D ({label}): the surviving PreCompact entry is not the template's copy: {command!r}")
PY
}

MERGED_R3_PY_OUT="$(python3 "$MERGE2/merge-settings.py" "$MERGE2/base-r3.json" "$MERGE2/addition-r3.json" "$MERGE2/merged-r3.py.json")" \
  || fail "round3: python merge script exited non-zero"
check_round3_result python "$MERGE2/merged-r3.py.json"
printf '%s\n' "$MERGED_R3_PY_OUT" | grep -q '\[merge\] dropped' \
  || fail "round3 Case B (python): no [merge] dropped notice printed for the stale absolute-interpreter-path hook"

MERGED_R3_NODE_OUT="$(node "$MERGE2/merge-settings.cjs" "$MERGE2/base-r3.json" "$MERGE2/addition-r3.json" "$MERGE2/merged-r3.cjs.json")" \
  || fail "round3: node merge script exited non-zero"
check_round3_result node "$MERGE2/merged-r3.cjs.json"
printf '%s\n' "$MERGED_R3_NODE_OUT" | grep -q '\[merge\] dropped' \
  || fail "round3 Case B (node): no [merge] dropped notice printed for the stale absolute-interpreter-path hook"

python3 - "$MERGE2/merged-r3.py.json" "$MERGE2/merged-r3.cjs.json" <<'PY'
import json
import sys

a_path, b_path = sys.argv[1], sys.argv[2]
with open(a_path, encoding="utf-8") as fh:
    a = json.load(fh)
with open(b_path, encoding="utf-8") as fh:
    b = json.load(fh)
if a != b:
    sys.exit("round3: python and node mergers produced different results for the dir/basename identity fixtures")
PY
printf '[6/%d] round 3: ownership is the last two path components; extension hooks survive, stale interpreter-path, unquoted backslash-path and hash-in-path hooks are dropped\n' "$TOTAL"

printf 'installer drift suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
