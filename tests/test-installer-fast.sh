#!/usr/bin/env bash
# Fast installer regression suite: every install.sh behavioral scenario
# EXCEPT the full REAL_TARGET + doctor.sh smoke test, which lives in
# tests/test-installer-slow-smoke.sh (a much bigger install against the
# actual 100+ file repo tree -- minutes, not seconds, in a slow sandbox).
# Split so a debugging loop or CI gate never has to eat the slow smoke
# test's wall-clock cost to get signal on everything else.
#
# Every scenario below prints a numbered progress line on completion, so a
# long run is never a silent black box -- if this hangs or gets killed, the
# last printed line tells you exactly how far it got.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=18

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

json_valid() {
  local file="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$file" >/dev/null
  elif command -v python >/dev/null 2>&1; then
    python -m json.tool "$file" >/dev/null
  else
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file"
  fi
}

json_root_equals() {
  local file="$1" expected="$2"
  if command -v python3 >/dev/null 2>&1; then
    MSYS2_ENV_CONV_EXCL=AIGENT_TEST_EXPECTED_ROOT \
      AIGENT_TEST_EXPECTED_ROOT="$expected" python3 - "$file" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    value = json.load(fh)
raise SystemExit(
    0 if value["env"]["AIGENT_ROOT"] == os.environ["AIGENT_TEST_EXPECTED_ROOT"] else 1
)
PY
  else
    MSYS2_ENV_CONV_EXCL=AIGENT_TEST_EXPECTED_ROOT \
      AIGENT_TEST_EXPECTED_ROOT="$expected" node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.exit(value.env.AIGENT_ROOT === process.env.AIGENT_TEST_EXPECTED_ROOT ? 0 : 1);
' "$file"
  fi
}

json_status_command() {
  local file="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    value = json.load(fh)
sys.stdout.write(value["statusLine"]["command"])
PY
  else
    node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(value.statusLine.command);
' "$file"
  fi
}

json_has_no_raw_unicode_line_separators() {
  local file="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" <<'PY'
import sys

raw = open(sys.argv[1], "rb").read()
raise SystemExit(1 if b"\xe2\x80\xa8" in raw or b"\xe2\x80\xa9" in raw else 0)
PY
  else
    node -e '
const fs = require("fs");
const raw = fs.readFileSync(process.argv[1]);
const ls = Buffer.from([0xe2, 0x80, 0xa8]);
const ps = Buffer.from([0xe2, 0x80, 0xa9]);
process.exit(raw.includes(ls) || raw.includes(ps) ? 1 : 0);
' "$file"
  fi
}

make_fixture() {
  local source="$1"
  mkdir -p "$source"/{system,vault/agents,skills/demo,hooks,daemons/semantic-search,scripts,docs,memory,evals,.claude/rules}
  cp "$ROOT/install.sh" "$source/install.sh"
  printf '# Identity\n' > "$source/system/00_identity.md"
  printf '# Claude source\n' > "$source/CLAUDE.md"
  printf '%s\n' '---' 'name: demo' '---' > "$source/skills/demo/SKILL.md"
  printf '%s\n' '---' 'name: scout' 'tools: [Read]' '---' > "$source/vault/agents/scout.md"
  printf '# critical\n' > "$source/.claude/rules/post-compact-critical.md"
  cat > "$source/.claude/settings.json.template" <<'JSON'
{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__","AIGENT_VAULT":"__AIGENT_ROOT__"},"statusLine":{"type":"command","command":"bash \"__AIGENT_ROOT__/daemons/statusline-ctx.sh\""},"hooks":{"SessionEnd":[]}}
JSON
  printf '[]\n' > "$source/.claude/skill-index.json"
  printf '{"name":"semantic-search","version":"1.0.0"}\n' > "$source/daemons/semantic-search/package.json"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$source/daemons/statusline-ctx.sh"
  printf '#!/bin/sh\necho "trusted"\n' > "$source/hooks/example-hook.sh"
}

# make_symlink: plain `ln -s` on Windows silently falls back to COPYING the
# target instead of erroring when the process lacks symlink privilege
# (Developer Mode / SeCreateSymbolicLinkPrivilege) -- which GitHub's
# windows-latest runners do not have by default. That would make the
# symlink-guard assertions below pass or fail for the wrong reason without
# ever exercising the guard they're meant to test. MSYS=winsymlinks makes
# Git Bash create an MSYS-emulated symlink instead (still real per
# -L/readlink, still the exact form Git Bash on Windows produces in the
# wild) when the native path fails.
make_symlink() {
  local dest="$1" link="$2"
  # `|| true` on both attempts: under set -e a bare failing statement here
  # would abort this whole test script before ever reaching the fallback
  # (or the final diagnostic) below -- exactly the bug this suite's own
  # symlink-guard tests exist to catch elsewhere, reintroduced by accident.
  ln -s "$dest" "$link" 2>/dev/null || true
  if [[ ! -L "$link" ]]; then
    rm -f "$link"
    MSYS=winsymlinks ln -s "$dest" "$link" || true
  fi
  [[ -L "$link" ]] || { printf 'FAIL: could not create a real symlink at %s (even with MSYS=winsymlinks)\n' "$link" >&2; exit 1; }
}

FIXTURE="$WORK/source"
make_fixture "$FIXTURE"

# ── 1. In-place activation ───────────────────────────────────────────────────
(
  cd "$FIXTURE"
  bash install.sh --no-deps >/dev/null
)
test -f "$FIXTURE/.claude/settings.json"
test -f "$FIXTURE/.aigent/state.json"
test ! -d "$FIXTURE/--no-deps"
json_valid "$FIXTURE/.claude/settings.json"
printf '[1/%d] in-place activation: ok\n' "$TOTAL"

# ── 2. Copy install, flags before target, spaced path ───────────────────────
TARGET="$WORK/target with spaces"
(
  cd "$FIXTURE"
  bash install.sh --no-deps --target "$TARGET" >/dev/null
)
# install.sh writes the canonicalized (pwd -P) form of TARGET into settings.json,
# not the raw mktemp string -- on Windows Git Bash /tmp aliases the user temp dir,
# and on macOS /tmp symlinks /private/tmp, so the two forms differ there. Compare
# against the same canonical form the installer itself writes.
TARGET_CANON="$(cd "$TARGET" && pwd -P)"
test -f "$TARGET/system/00_identity.md"
test -d "$TARGET/memory"
test -d "$TARGET/evals"
json_valid "$TARGET/.claude/settings.json"
grep -F "$TARGET_CANON" "$TARGET/.claude/settings.json" >/dev/null
printf '[2/%d] copy install with spaced path: ok\n' "$TOTAL"

# ── 3. Rerun refreshes one managed block ─────────────────────────────────────
(
  cd "$FIXTURE"
  bash install.sh "$TARGET" --no-deps >/dev/null
)
test "$(grep -c '<!-- aigent-os:start -->' "$TARGET/CLAUDE.md")" -eq 1
test "$(grep -c '# aigent-os:generated-state:start' "$TARGET/.gitignore")" -eq 1
printf '[3/%d] rerun refreshes single managed block: ok\n' "$TOTAL"

# ── 4. Existing valid settings merged ────────────────────────────────────────
MERGE_TARGET="$WORK/merge-target"
mkdir -p "$MERGE_TARGET/.claude"
cat > "$MERGE_TARGET/.claude/settings.json" <<'JSON'
{"env":{"CUSTOM":"keep","AIGENT_ROOT":"/stale/path"},"permissions":{"allow":["Read"]}}
JSON
(
  cd "$FIXTURE"
  bash install.sh --target "$MERGE_TARGET" --no-deps >/dev/null
)
MERGE_TARGET_CANON="$(cd "$MERGE_TARGET" && pwd -P)"
json_valid "$MERGE_TARGET/.claude/settings.json"
grep -F '"CUSTOM": "keep"' "$MERGE_TARGET/.claude/settings.json" >/dev/null
grep -F "$MERGE_TARGET_CANON" "$MERGE_TARGET/.claude/settings.json" >/dev/null
printf '[4/%d] existing valid settings.json merged: ok\n' "$TOTAL"

# ── 5. Invalid settings left untouched ───────────────────────────────────────
INVALID_TARGET="$WORK/invalid-target"
mkdir -p "$INVALID_TARGET/.claude"
printf '{invalid\n' > "$INVALID_TARGET/.claude/settings.json"
(
  cd "$FIXTURE"
  bash install.sh --target "$INVALID_TARGET" --no-deps >/dev/null
)
grep -F '{invalid' "$INVALID_TARGET/.claude/settings.json" >/dev/null
json_valid "$INVALID_TARGET/.claude/settings.aigent.json"
printf '[5/%d] invalid settings.json left untouched: ok\n' "$TOTAL"

# ── 6. Dry run creates nothing ───────────────────────────────────────────────
DRY_TARGET="$WORK/dry-target"
(
  cd "$FIXTURE"
  bash install.sh --target "$DRY_TARGET" --dry-run --no-deps >/dev/null
)
test ! -e "$DRY_TARGET"
printf '[6/%d] dry run creates nothing: ok\n' "$TOTAL"

# ── 7. Symlink-escape guard, critical file (Codex finding #22) ──────────────
# A single-critical-file write (CLAUDE.md) refuses through a pre-seeded
# symlink and aborts the whole install with an actionable error, rather than
# following the link and overwriting whatever it points at.
SYMLINK_TARGET="$WORK/symlink-target"
mkdir -p "$SYMLINK_TARGET"
SENTINEL="$WORK/sentinel.txt"
printf 'do not touch\n' > "$SENTINEL"
make_symlink "$SENTINEL" "$SYMLINK_TARGET/CLAUDE.md"
set +e
SYMLINK_OUT="$(cd "$FIXTURE" && bash install.sh --target "$SYMLINK_TARGET" --no-deps 2>&1)"
SYMLINK_RC=$?
set -e
test "$SYMLINK_RC" -ne 0
printf '%s\n' "$SYMLINK_OUT" | grep -qi "refusing to write through symlink"
test "$(cat "$SENTINEL")" = "do not touch"
printf '[7/%d] symlink escape (critical file): refused, sentinel untouched\n' "$TOTAL"

# ── 8. Symlink-escape guard, many-file site ──────────────────────────────────
# A many-file copy site (the .claude/skills/<name> install loop) skips just
# the affected entry with a warning and lets the rest of the install finish,
# rather than aborting entirely.
SKIP_TARGET="$WORK/skip-target"
mkdir -p "$SKIP_TARGET/.claude/skills"
make_symlink "$WORK/nonexistent-escape-target" "$SKIP_TARGET/.claude/skills/demo"
SKIP_OUT="$(cd "$FIXTURE" && bash install.sh --target "$SKIP_TARGET" --no-deps 2>&1)"
test -f "$SKIP_TARGET/.claude/settings.json"
printf '%s\n' "$SKIP_OUT" | grep -qi "\[skip\] refusing to write through symlink"
test ! -e "$WORK/nonexistent-escape-target"
printf '[8/%d] symlink escape (many-file site): skipped with warning, install completed\n' "$TOTAL"

# ── 9. Hooks quarantine (Codex finding #19) ──────────────────────────────────
# A pre-existing file at a path the installer would place a framework hook
# is quarantined (moved aside, framework version installed) by default.
QUARANTINE_TARGET="$WORK/quarantine-target"
mkdir -p "$QUARANTINE_TARGET/hooks"
printf '#!/bin/sh\necho "MALICIOUS"\n' > "$QUARANTINE_TARGET/hooks/example-hook.sh"
QUARANTINE_OUT="$(cd "$FIXTURE" && bash install.sh --target "$QUARANTINE_TARGET" --no-deps 2>&1)"
printf '%s\n' "$QUARANTINE_OUT" | grep -qi "\[quarantine\]"
grep -q "trusted" "$QUARANTINE_TARGET/hooks/example-hook.sh"
grep -rq "MALICIOUS" "$QUARANTINE_TARGET/.aigent/quarantine/"
printf '[9/%d] hooks quarantine: planted file moved aside, trusted version installed\n' "$TOTAL"

# ── 10. Skills quarantine ─────────────────────────────────────────────────────
# Same bug class, one directory over: .claude/skills/<name>/SKILL.md is a
# dispatchable slash command Claude Code reads directly, so a planted,
# differing SKILL.md must quarantine exactly like a hook.
SKILLS_QUAR_TARGET="$WORK/skills-quarantine-target"
mkdir -p "$SKILLS_QUAR_TARGET/.claude/skills/demo"
printf '%s\n' '---' 'name: demo' 'MALICIOUS' '---' > "$SKILLS_QUAR_TARGET/.claude/skills/demo/SKILL.md"
SKILLS_QUAR_OUT="$(cd "$FIXTURE" && bash install.sh --target "$SKILLS_QUAR_TARGET" --no-deps 2>&1)"
printf '%s\n' "$SKILLS_QUAR_OUT" | grep -qi "\[quarantine\]"
! grep -q "MALICIOUS" "$SKILLS_QUAR_TARGET/.claude/skills/demo/SKILL.md"
grep -rq "MALICIOUS" "$SKILLS_QUAR_TARGET/.aigent/quarantine/"
printf '[10/%d] skills quarantine: planted SKILL.md moved aside, trusted version installed\n' "$TOTAL"

# ── 11. Agents quarantine ─────────────────────────────────────────────────────
# .claude/agents/<name>.md is a dispatchable subagent definition -- same
# treatment.
AGENTS_QUAR_TARGET="$WORK/agents-quarantine-target"
mkdir -p "$AGENTS_QUAR_TARGET/.claude/agents"
printf '%s\n' '---' 'name: scout' 'tools: [Read]' 'MALICIOUS' '---' > "$AGENTS_QUAR_TARGET/.claude/agents/scout.md"
AGENTS_QUAR_OUT="$(cd "$FIXTURE" && bash install.sh --target "$AGENTS_QUAR_TARGET" --no-deps 2>&1)"
printf '%s\n' "$AGENTS_QUAR_OUT" | grep -qi "\[quarantine\]"
! grep -q "MALICIOUS" "$AGENTS_QUAR_TARGET/.claude/agents/scout.md"
grep -rq "MALICIOUS" "$AGENTS_QUAR_TARGET/.aigent/quarantine/"
printf '[11/%d] agents quarantine: planted scout.md moved aside, trusted version installed\n' "$TOTAL"

# ── 12. --trust-existing opt-out ─────────────────────────────────────────────
# Keeps pre-existing hooks/skills/agents instead of quarantining them,
# across all three sensitive trees at once.
TRUST_TARGET="$WORK/trust-target"
mkdir -p "$TRUST_TARGET/hooks" "$TRUST_TARGET/.claude/skills/demo" "$TRUST_TARGET/.claude/agents"
printf '#!/bin/sh\necho "CUSTOM"\n' > "$TRUST_TARGET/hooks/example-hook.sh"
printf '%s\n' '---' 'name: demo' 'CUSTOM' '---' > "$TRUST_TARGET/.claude/skills/demo/SKILL.md"
printf '%s\n' '---' 'name: scout' 'tools: [Read]' 'CUSTOM' '---' > "$TRUST_TARGET/.claude/agents/scout.md"
TRUST_OUT="$(cd "$FIXTURE" && bash install.sh --target "$TRUST_TARGET" --trust-existing --no-deps 2>&1)"
grep -q "CUSTOM" "$TRUST_TARGET/hooks/example-hook.sh"
grep -q "CUSTOM" "$TRUST_TARGET/.claude/skills/demo/SKILL.md"
grep -q "CUSTOM" "$TRUST_TARGET/.claude/agents/scout.md"
! printf '%s\n' "$TRUST_OUT" | grep -qi "\[quarantine\]"
printf '[12/%d] trust-existing opt-out (hooks+skills+agents): pre-existing kept, no quarantine\n' "$TOTAL"

# ── 13. Backup-leaf symlink guard (Codex finding #22 item 2) ─────────────────
# STAMP is normally date -u at runtime, so a test can't predict the backup
# filename to pre-plant a symlink at. AIGENT_INSTALL_STAMP (test-only, see
# install.sh) pins it so the exact path is known before the second run.
BACKUP_STAMP="20260101T000000Z"
BACKUP_TARGET="$WORK/backup-symlink-target"
(
  cd "$FIXTURE"
  AIGENT_INSTALL_STAMP="$BACKUP_STAMP" bash install.sh --target "$BACKUP_TARGET" --no-deps >/dev/null
)
BACKUP_SENTINEL="$WORK/backup-sentinel.txt"
printf 'do not touch\n' > "$BACKUP_SENTINEL"
make_symlink "$BACKUP_SENTINEL" "$BACKUP_TARGET/.aigent/backups/CLAUDE.md.$BACKUP_STAMP"
set +e
BACKUP_OUT="$(cd "$FIXTURE" && AIGENT_INSTALL_STAMP="$BACKUP_STAMP" bash install.sh --target "$BACKUP_TARGET" --no-deps 2>&1)"
BACKUP_RC=$?
set -e
test "$BACKUP_RC" -ne 0
printf '%s\n' "$BACKUP_OUT" | grep -qi "refusing to write through symlink"
test "$(cat "$BACKUP_SENTINEL")" = "do not touch"
printf '[13/%d] backup-leaf symlink guard: refused, sentinel untouched\n' "$TOTAL"

# ── 14. Complete external-target ignore set (Codex finding #39) ─────────────
# The managed .gitignore block used to omit the prompt journal, the
# semantic-search node_modules/ the deps step can install, an Obsidian
# .obsidian/ workspace dir, and Claude Code's own settings.local.json.
IGNORE_TARGET="$WORK/ignore-target"
(
  cd "$FIXTURE"
  bash install.sh --target "$IGNORE_TARGET" --no-deps >/dev/null
)
for pattern in '.claude/settings.local.json' '**/runtime/utterance-journal*.jsonl' 'node_modules/' '.obsidian/' '**/semantic-search/index-deny.json'; do
  grep -qF -- "$pattern" "$IGNORE_TARGET/.gitignore" || {
    printf 'FAIL: managed .gitignore block missing pattern: %s\n' "$pattern" >&2
    exit 1
  }
done
printf '[14/%d] external-target .gitignore carries the complete managed ignore set\n' "$TOTAL"

# ── 15. Malformed gitignore marker aborts before any surgery (Codex #38) ────
# A stray/unbalanced managed-block marker (here: a start marker with no
# matching end, as a bad hand-edit or merge would leave behind) must not let
# the awk strip below treat "managed" as stuck on for the rest of the file --
# that would silently delete the user's own rules after the stray marker.
# Refuse and leave the file untouched instead of guessing.
MARKER_TARGET="$WORK/malformed-marker-target"
mkdir -p "$MARKER_TARGET"
cat > "$MARKER_TARGET/.gitignore" <<'GI'
my-own-rule.txt
# aigent-os:generated-state:start
stale-entry/
GI
set +e
MARKER_OUT="$(cd "$FIXTURE" && bash install.sh --target "$MARKER_TARGET" --no-deps 2>&1)"
MARKER_RC=$?
set -e
test "$MARKER_RC" -ne 0
printf '%s\n' "$MARKER_OUT" | grep -qi "malformed aigent-os managed block"
grep -qF "my-own-rule.txt" "$MARKER_TARGET/.gitignore"
grep -qF "stale-entry/" "$MARKER_TARGET/.gitignore"
printf '[15/%d] malformed gitignore marker: install aborts, hand-written rules survive\n' "$TOTAL"

# ── 16. Gitignore backed up before managed-block surgery (Codex #38) ────────
# Mirrors the CLAUDE.md / settings.json backup-before-overwrite treatment:
# a pre-existing .gitignore (even one that never had aigent-os markers) gets
# a timestamped backup before the strip/rewrite touches it.
GI_BACKUP_TARGET="$WORK/gitignore-backup-target"
mkdir -p "$GI_BACKUP_TARGET"
cat > "$GI_BACKUP_TARGET/.gitignore" <<'GI'
my-own-rule.txt
GI
(
  cd "$FIXTURE"
  bash install.sh --target "$GI_BACKUP_TARGET" --no-deps >/dev/null
)
test -d "$GI_BACKUP_TARGET/.aigent/backups"
GI_BACKUPS="$(find "$GI_BACKUP_TARGET/.aigent/backups" -maxdepth 1 -name '.gitignore.*' 2>/dev/null)"
test -n "$GI_BACKUPS"
grep -qF "my-own-rule.txt" "$(printf '%s\n' "$GI_BACKUPS" | head -1)"
grep -qF "my-own-rule.txt" "$GI_BACKUP_TARGET/.gitignore"
printf '[16/%d] gitignore managed-block refresh: backup saved, hand-written rule survives\n' "$TOTAL"

# ── 17. Settings renderer preserves hostile paths without shell injection ────
# On POSIX, exercise every metacharacter that used to break textual placeholder
# replacement. Windows filenames forbid quotes and pipes, so that branch uses
# command substitution syntax to retain an executable injection specimen.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    HOSTILE_LEAF='target & $(touch pwned-main)'
    ;;
  *)
    HOSTILE_LEAF=$'target & | "; touch pwned-main; # \\ backslash \u2028 \u2029 $(touch pwned-main-dollar)'
    ;;
esac
HOSTILE_TARGET="$WORK/$HOSTILE_LEAF"
(
  cd "$FIXTURE"
  bash install.sh --target "$HOSTILE_TARGET" --no-deps >/dev/null
)
HOSTILE_CANON="$(cd "$HOSTILE_TARGET" && pwd -P)"
HOSTILE_SETTINGS="$HOSTILE_TARGET/.claude/settings.json"
json_valid "$HOSTILE_SETTINGS"
json_root_equals "$HOSTILE_SETTINGS" "$HOSTILE_CANON"
json_has_no_raw_unicode_line_separators "$HOSTILE_SETTINGS"
HOSTILE_COMMAND="$(json_status_command "$HOSTILE_SETTINGS")"
(
  cd "$WORK"
  bash -c "$HOSTILE_COMMAND" >/dev/null 2>&1
)
test ! -e "$WORK/pwned-main"
test ! -e "$WORK/pwned-main-dollar"
printf '[17/%d] hostile settings path: JSON-correct, command inert, value preserved\n' "$TOTAL"

# ── 18. Launcher renderer and profile assignment are injection-safe ─────────
test18_require() {
  local property="$1"
  shift
  "$@" || fail "test 18: $property"
}

launcher_fixture_install() {
  HOME="$LAUNCHER_HOME" \
    bash "$LAUNCHER_REPO/launcher/install.sh" "$1"
}

physical_path() {
  cd "$1" && pwd -P
}

run_launcher_status_command() {
  cd "$WORK" &&
    bash -c "$LAUNCHER_COMMAND" >/dev/null 2>&1
}

read_generated_profile_home() {
  cd "$WORK" &&
    HOME="$LAUNCHER_HOME" bash --noprofile --norc -c \
      'source "$HOME/.bashrc" && printf "%s" "$AIGENT_HOME"'
}

# Bash 3.2 does not expand \uXXXX inside $'...'. Build the UTF-8 bytes with
# portable octal escapes, then verify them before using either separator as a
# probe. A runner that cannot express the bytes must say so rather than turn the
# assertion into a silent pass.
UTF8_LINE_SEPARATOR="$(printf '\342\200\250')"
UTF8_PARAGRAPH_SEPARATOR="$(printf '\342\200\251')"
if UTF8_SEPARATOR_HEX="$(
  printf '%s%s' "$UTF8_LINE_SEPARATOR" "$UTF8_PARAGRAPH_SEPARATOR" |
    od -An -tx1 |
    tr -d '[:space:]'
)" && [ "$UTF8_SEPARATOR_HEX" = 'e280a8e280a9' ]; then
  UNICODE_SEPARATOR_PROBES=1
else
  UNICODE_SEPARATOR_PROBES=0
  printf '[18/%d] SKIP unicode separator probes: could not construct and verify UTF-8 U+2028/U+2029 bytes (got %s)\n' \
    "$TOTAL" "${UTF8_SEPARATOR_HEX:-no byte output}" >&2
fi

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    LAUNCHER_LEAF='launcher & $(touch pwned-launcher)'
    LAUNCHER_QUOTE_BREAKOUT_PROBE=0
    LAUNCHER_COMMAND_SUBSTITUTION_SENTINEL="$WORK/pwned-launcher"
    ;;
  *)
    if [ "$UNICODE_SEPARATOR_PROBES" -eq 1 ]; then
      LAUNCHER_LEAF='launcher & | "; touch pwned-launcher; # \ backslash '"$UTF8_LINE_SEPARATOR $UTF8_PARAGRAPH_SEPARATOR"' $(touch pwned-launcher-dollar)'
    else
      LAUNCHER_LEAF='launcher & | "; touch pwned-launcher; # \ backslash $(touch pwned-launcher-dollar)'
    fi
    LAUNCHER_QUOTE_BREAKOUT_PROBE=1
    LAUNCHER_COMMAND_SUBSTITUTION_SENTINEL="$WORK/pwned-launcher-dollar"
    ;;
esac
if [ "$LAUNCHER_QUOTE_BREAKOUT_PROBE" -eq 0 ]; then
  printf '[18/%d] SKIP quote-breakout launcher path probe: Windows filenames cannot contain double quotes\n' \
    "$TOTAL" >&2
fi
LAUNCHER_REPO="$WORK/$LAUNCHER_LEAF"
LAUNCHER_HOME="$WORK/launcher-home"
test18_require 'launcher fixture directories can be created' \
  mkdir -p \
    "$LAUNCHER_REPO/launcher" \
    "$LAUNCHER_REPO/.claude" \
    "$LAUNCHER_REPO/daemons" \
    "$LAUNCHER_HOME"
test18_require 'launcher/install.sh can be copied into the fixture' \
  cp "$ROOT/launcher/install.sh" "$LAUNCHER_REPO/launcher/install.sh"
test18_require 'launcher/aigent.sh can be copied into the fixture' \
  cp "$ROOT/launcher/aigent.sh" "$LAUNCHER_REPO/launcher/aigent.sh"
test18_require 'settings template can be copied into the fixture' \
  cp "$ROOT/.claude/settings.json.template" "$LAUNCHER_REPO/.claude/settings.json.template"
test18_require 'status-line fixture can be created' \
  printf '#!/usr/bin/env bash\nexit 0\n' > "$LAUNCHER_REPO/daemons/statusline-ctx.sh"

PROFILE_VALUE="$WORK/"'aigent "quoted" $HOME `touch pwned-profile` & |'
test18_require 'initial launcher install succeeds' \
  launcher_fixture_install "$PROFILE_VALUE" >/dev/null
test18_require 'repeated launcher install succeeds' \
  launcher_fixture_install "$PROFILE_VALUE" >/dev/null

LAUNCHER_CANON="$(
  test18_require 'physical launcher repository path can be resolved' \
    physical_path "$LAUNCHER_REPO"
)"
LAUNCHER_SETTINGS="$LAUNCHER_REPO/.claude/settings.json"
test18_require 'launcher settings are valid JSON' \
  json_valid "$LAUNCHER_SETTINGS"
test18_require 'launcher settings preserve the physical repository path' \
  json_root_equals "$LAUNCHER_SETTINGS" "$LAUNCHER_CANON"
test18_require 'launcher settings contain no raw U+2028/U+2029 bytes' \
  json_has_no_raw_unicode_line_separators "$LAUNCHER_SETTINGS"
LAUNCHER_COMMAND="$(
  test18_require 'statusLine.command can be read from launcher settings' \
    json_status_command "$LAUNCHER_SETTINGS"
)"
test18_require 'rendered launcher status command executes' \
  run_launcher_status_command
if [ "$LAUNCHER_QUOTE_BREAKOUT_PROBE" -eq 1 ]; then
  test18_require 'launcher path did not execute the quote-breakout payload' \
    test ! -e "$WORK/pwned-launcher"
fi
test18_require 'launcher path did not execute the command-substitution payload' \
  test ! -e "$LAUNCHER_COMMAND_SUBSTITUTION_SENTINEL"

PROFILE_ACTUAL="$(
  test18_require 'generated profile can be sourced' \
    read_generated_profile_home
)"
test18_require 'profile round-trips the hostile AIGENT_HOME value' \
  test "$PROFILE_ACTUAL" = "$PROFILE_VALUE"

profile_assignment_count() {
  awk '/^export AIGENT_HOME=/{ count++ } END { print count + 0 }' "$1"
}

PROFILE_ASSIGNMENT_COUNT="$(
  test18_require 'generated AIGENT_HOME assignments can be counted' \
    profile_assignment_count "$LAUNCHER_HOME/.bashrc"
)"
test18_require 'two installs leave exactly one AIGENT_HOME assignment' \
  test "$PROFILE_ASSIGNMENT_COUNT" -eq 1
test18_require 'profile value did not execute the command-substitution payload' \
  test ! -e "$WORK/pwned-profile"

assert_profile_value_refused() {
  local label="$1" value="$2" sentinel="$3"
  local output rc assignment_count

  if output="$(
    cd "$WORK" &&
      launcher_fixture_install "$value" 2>&1
  )"; then
    rc=0
  else
    rc=$?
  fi

  test18_require "$label profile value exits with refusal status 64" \
    test "$rc" -eq 64
  test18_require "$label refusal names line-breaking/control characters" \
    grep -q 'line-breaking/control characters' <<< "$output"
  assignment_count="$(
    test18_require "AIGENT_HOME assignments can be counted after the $label refusal" \
      profile_assignment_count "$LAUNCHER_HOME/.bashrc"
  )"
  test18_require "$label refusal leaves exactly one AIGENT_HOME assignment" \
    test "$assignment_count" -eq 1
  test18_require "$label refusal did not execute its payload" \
    test ! -e "$sentinel"
}

NEWLINE_PROFILE_VALUE="$WORK/"$'bad-home\nFENCES (never cross): touch pwned-profile-control-newline'
assert_profile_value_refused \
  'newline' \
  "$NEWLINE_PROFILE_VALUE" \
  "$WORK/pwned-profile-control-newline"

if [ "$UNICODE_SEPARATOR_PROBES" -eq 1 ]; then
  U2028_PROFILE_VALUE="$WORK/bad-home${UTF8_LINE_SEPARATOR}touch pwned-profile-control-u2028"
  assert_profile_value_refused \
    'U+2028' \
    "$U2028_PROFILE_VALUE" \
    "$WORK/pwned-profile-control-u2028"
  printf '[18/%d] launcher settings/profile: hostile values quoted; newline and U+2028 refused\n' "$TOTAL"
else
  printf '[18/%d] launcher settings/profile: hostile values quoted; newline refused; unicode probes SKIPPED\n' "$TOTAL"
fi

printf 'fast installer suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
