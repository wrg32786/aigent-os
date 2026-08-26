#!/usr/bin/env bash
# Installer regression suite for per-path operator-owned preservation.
#
# Companion to tests/test-installer-fast.sh, same shape (temp fixture, numbered
# progress lines, no network). Split into its own file because it needs a
# multi-skill source fixture the fast suite does not build, and because the
# scenario it protects is a distinct failure: a reinstall quarantining and
# replacing an operator's own extension files.
#
# The measured failure this file pins: install.sh treats hooks/, daemons/,
# .claude/skills/, .claude/agents/*.md and .claude/skill-index.json as trusted
# trees, so any pre-existing file there that differs from the framework copy is
# moved to .aigent/quarantine/ and overwritten. On a real install that replaced
# 15 legitimate operator extension files at once. The only escape was the global
# --trust-existing flag, which also freezes real core fixes, so it is not a fix.
#
# Every scenario below prints a numbered progress line on completion, so a long
# run is never a silent black box.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=10
SKILL_COUNT=13

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

make_fixture() {
  local source="$1" index name
  mkdir -p "$source"/{system,vault/agents,hooks,daemons/semantic-search,scripts,docs,memory,evals,.claude/rules}
  cp "$ROOT/install.sh" "$source/install.sh"
  printf '# Identity\n' > "$source/system/00_identity.md"
  printf '# Claude source\n' > "$source/CLAUDE.md"
  for ((index = 1; index <= SKILL_COUNT; index += 1)); do
    name="$(printf 'skill-%02d' "$index")"
    mkdir -p "$source/skills/$name"
    printf '%s\n' '---' "name: $name" '---' 'FRAMEWORK-BODY' > "$source/skills/$name/SKILL.md"
  done
  printf '%s\n' '---' 'name: scout' 'tools: [Read]' '---' 'FRAMEWORK-BODY' \
    > "$source/vault/agents/scout.md"
  printf '# critical\n' > "$source/.claude/rules/post-compact-critical.md"
  cat > "$source/.claude/settings.json.template" <<'JSON'
{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__","AIGENT_VAULT":"__AIGENT_ROOT__"},"statusLine":{"type":"command","command":"bash \"__AIGENT_ROOT__/daemons/statusline-ctx.sh\""},"hooks":{"SessionEnd":[]}}
JSON
  printf '{"framework":true}\n' > "$source/.claude/skill-index.json"
  printf '{"name":"semantic-search","version":"1.0.0"}\n' \
    > "$source/daemons/semantic-search/package.json"
  printf '#!/usr/bin/env bash\n# FRAMEWORK-CURRENT\nexit 0\n' > "$source/daemons/statusline-ctx.sh"
  printf '#!/bin/sh\necho "trusted"\n' > "$source/hooks/example-hook.sh"
  # A minimal manifest so the conflict case has a real core-required population
  # to collide with. install.sh reads only the keys of required_files.
  cat > "$source/scripts/fleet-baseline-manifest.json" <<'JSON'
{
  "schema": "FleetBaselineManifest/vTest",
  "required_files": {
    "daemons/statusline-ctx.sh": "0000000000000000000000000000000000000000000000000000000000000000",
    "hooks/example-hook.sh": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
JSON
}

install_into() {
  (cd "$FIXTURE" && bash install.sh --target "$1" --no-deps "${@:2}")
}

# The 15 files the real incident quarantined, in the same three classes:
# 13 diverged skill SKILL.md files, one agent definition, and skill-index.json.
plant_operator_files() {
  local target="$1" index name
  mkdir -p "$target/.claude/skills" "$target/.claude/agents"
  for ((index = 1; index <= SKILL_COUNT; index += 1)); do
    name="$(printf 'skill-%02d' "$index")"
    mkdir -p "$target/.claude/skills/$name"
    printf '%s\n' '---' "name: $name" '---' "OPERATOR-EXTENSION-$name" \
      > "$target/.claude/skills/$name/SKILL.md"
  done
  printf '%s\n' '---' 'name: scout' 'tools: [Read]' '---' 'OPERATOR-EXTENSION-scout' \
    > "$target/.claude/agents/scout.md"
  printf '{"operator":true,"entries":["OPERATOR-EXTENSION-index"]}\n' \
    > "$target/.claude/skill-index.json"
}

operator_owned_relpaths() {
  local index
  for ((index = 1; index <= SKILL_COUNT; index += 1)); do
    printf '.claude/skills/skill-%02d/SKILL.md\n' "$index"
  done
  printf '%s\n' '.claude/agents/scout.md' '.claude/skill-index.json'
}

# Snapshot the planted bytes so the survival assertion is byte-for-byte (cmp),
# not a grep for a sentinel substring.
snapshot_operator_files() {
  local target="$1" snapshot="$2" relative
  rm -rf "$snapshot"
  while IFS= read -r relative; do
    mkdir -p "$snapshot/$(dirname "$relative")"
    cp "$target/$relative" "$snapshot/$relative"
  done < <(operator_owned_relpaths)
}

assert_operator_files_survived() {
  local target="$1" snapshot="$2" relative
  while IFS= read -r relative; do
    cmp -s "$snapshot/$relative" "$target/$relative" \
      || fail "operator-owned file was not preserved byte for byte: $relative"
  done < <(operator_owned_relpaths)
}

write_declaration() {
  local target="$1"
  mkdir -p "$target/.aigent"
  cat > "$target/.aigent/operator-owned.json"
}

declaration_from_relpaths() {
  local target="$1" relative first=1
  {
    printf '{\n  "schema": "OperatorOwnedPaths/v1",\n  "paths": [\n'
    while IFS= read -r relative; do
      [[ "$first" -eq 1 ]] || printf ',\n'
      first=0
      printf '    "%s"' "$relative"
    done < <(operator_owned_relpaths)
    printf '\n  ]\n}\n'
  } | write_declaration "$target"
}

quarantine_file_count() {
  local directory="$1/.aigent/quarantine"
  if [[ ! -d "$directory" ]]; then
    printf '0'
    return 0
  fi
  find "$directory" -type f | wc -l | tr -d '[:space:]'
}

quarantine_lines() {
  printf '%s\n' "$1" | grep -i '\[quarantine\]' || true
}

FIXTURE="$WORK/source"
make_fixture "$FIXTURE"

# -- 1. Declared operator extension files survive a reinstall ----------------
# THE REGRESSION. A prior install, then 15 diverged operator files across the
# three trusted classes, declared operator-owned. A reinstall must keep every
# one of them byte for byte and quarantine nothing.
KEEP_TARGET="$WORK/keep-target"
install_into "$KEEP_TARGET" >/dev/null
plant_operator_files "$KEEP_TARGET"
declaration_from_relpaths "$KEEP_TARGET"
snapshot_operator_files "$KEEP_TARGET" "$WORK/keep-snapshot"
KEEP_OUT="$(install_into "$KEEP_TARGET" 2>&1)"
assert_operator_files_survived "$KEEP_TARGET" "$WORK/keep-snapshot"
KEEP_QUARANTINED="$(quarantine_file_count "$KEEP_TARGET")"
[[ "$KEEP_QUARANTINED" -eq 0 ]] \
  || fail "expected no quarantine entries, found $KEEP_QUARANTINED:
$(quarantine_lines "$KEEP_OUT")"
KEEP_LINES="$(printf '%s\n' "$KEEP_OUT" | grep -c '\[operator-owned\] keep ' || true)"
[[ "$KEEP_LINES" -eq 15 ]] \
  || fail "expected 15 [operator-owned] keep lines, got $KEEP_LINES:
$(printf '%s\n' "$KEEP_OUT" | grep '\[operator-owned\]' || true)"
printf '[1/%d] declared operator files: all 15 preserved byte for byte, nothing quarantined\n' "$TOTAL"

# -- 2. A real core fix still upgrades beside preserved operator files -------
# The positive witness. Same target, still declaring only the 15, plus a stale
# byte-different copy of a manifest-pinned core daemon that is NOT declared.
# The core file must be upgraded to the framework copy while the 15 survive.
printf '#!/usr/bin/env bash\n# STALE-CORE-COPY\nexit 0\n' \
  > "$KEEP_TARGET/daemons/statusline-ctx.sh"
snapshot_operator_files "$KEEP_TARGET" "$WORK/upgrade-snapshot"
UPGRADE_OUT="$(install_into "$KEEP_TARGET" 2>&1)"
cmp -s "$FIXTURE/daemons/statusline-ctx.sh" "$KEEP_TARGET/daemons/statusline-ctx.sh" \
  || fail "undeclared core daemon was not upgraded to the framework copy"
grep -q 'FRAMEWORK-CURRENT' "$KEEP_TARGET/daemons/statusline-ctx.sh" \
  || fail "undeclared core daemon does not carry the framework body"
assert_operator_files_survived "$KEEP_TARGET" "$WORK/upgrade-snapshot"
printf '%s\n' "$UPGRADE_OUT" | grep -qi '\[quarantine\].*statusline-ctx\.sh' \
  || fail "expected the stale undeclared core daemon to be quarantined and replaced"
printf '[2/%d] positive witness: undeclared core daemon upgraded, declared files untouched\n' "$TOTAL"

# -- 3. Undeclared files in the same trees still quarantine ------------------
# Presence of a declaration must not soften anything it does not name.
UNDECLARED_TARGET="$WORK/undeclared-target"
install_into "$UNDECLARED_TARGET" >/dev/null
plant_operator_files "$UNDECLARED_TARGET"
printf '%s\n' '{' '  "schema": "OperatorOwnedPaths/v1",' \
  '  "paths": [".claude/skills/skill-01/SKILL.md"]' '}' \
  | write_declaration "$UNDECLARED_TARGET"
UNDECLARED_OUT="$(install_into "$UNDECLARED_TARGET" 2>&1)"
grep -q 'OPERATOR-EXTENSION-skill-01' "$UNDECLARED_TARGET/.claude/skills/skill-01/SKILL.md" \
  || fail "the one declared skill was not preserved"
grep -q 'FRAMEWORK-BODY' "$UNDECLARED_TARGET/.claude/skills/skill-02/SKILL.md" \
  || fail "an undeclared diverged skill was not replaced by the framework copy"
printf '%s\n' "$UNDECLARED_OUT" | grep -qi '\[quarantine\]' \
  || fail "expected undeclared diverged files to still quarantine"
printf '[3/%d] undeclared paths keep todays behaviour: still quarantined and replaced\n' "$TOTAL"

# -- 4. A declared path that does not exist yet gets the framework copy ------
# Fresh installs still receive canonical core, declaration or not.
FRESH_TARGET="$WORK/fresh-target"
mkdir -p "$FRESH_TARGET"
declaration_from_relpaths "$FRESH_TARGET"
install_into "$FRESH_TARGET" >/dev/null
grep -q 'FRAMEWORK-BODY' "$FRESH_TARGET/.claude/skills/skill-01/SKILL.md" \
  || fail "a declared but absent path did not receive the framework copy"
grep -q 'FRAMEWORK-BODY' "$FRESH_TARGET/.claude/agents/scout.md" \
  || fail "a declared but absent agent did not receive the framework copy"
grep -q 'framework' "$FRESH_TARGET/.claude/skill-index.json" \
  || fail "a declared but absent skill-index.json did not receive the framework copy"
printf '[4/%d] fresh install: declared but absent paths receive canonical core\n' "$TOTAL"

# -- 5. Bounded glob form covers a whole class in one entry ------------------
GLOB_TARGET="$WORK/glob-target"
install_into "$GLOB_TARGET" >/dev/null
plant_operator_files "$GLOB_TARGET"
printf '%s\n' '{' '  "schema": "OperatorOwnedPaths/v1",' \
  '  "paths": [".claude/skills/*/SKILL.md"]' '}' \
  | write_declaration "$GLOB_TARGET"
snapshot_operator_files "$GLOB_TARGET" "$WORK/glob-snapshot"
GLOB_OUT="$(install_into "$GLOB_TARGET" 2>&1)"
for ((INDEX = 1; INDEX <= SKILL_COUNT; INDEX += 1)); do
  GLOB_NAME="$(printf 'skill-%02d' "$INDEX")"
  cmp -s "$WORK/glob-snapshot/.claude/skills/$GLOB_NAME/SKILL.md" \
    "$GLOB_TARGET/.claude/skills/$GLOB_NAME/SKILL.md" \
    || fail "glob-declared skill not preserved: $GLOB_NAME"
done
if printf '%s\n' "$GLOB_OUT" | grep -qi '\[quarantine\].*SKILL\.md'; then
  fail "glob-declared skills were quarantined"
fi
# The glob is bounded to one path segment, so the undeclared agent still moves.
printf '%s\n' "$GLOB_OUT" | grep -qi '\[quarantine\].*agents' \
  || fail "the undeclared agent should still quarantine under a skills-only glob"
printf '[5/%d] bounded glob: one entry preserves all %d skills, agent still quarantined\n' \
  "$TOTAL" "$SKILL_COUNT"

# -- 6..10. Malformed and conflicting declarations refuse the install --------
# Each must abort with a named error and leave the target byte-identical.
# diff -r is the untouched assertion: it catches changed, added and removed
# files, so a partial write anywhere under the target fails the case.
REFUSE_BASE="$WORK/refuse-base"
install_into "$REFUSE_BASE" >/dev/null
plant_operator_files "$REFUSE_BASE"

assert_refused() {
  local label="$1" expected="$2" body="$3"
  local target="$WORK/refuse-$label" snapshot="$WORK/refuse-$label-snapshot"
  local output rc
  rm -rf "$target" "$snapshot"
  cp -R "$REFUSE_BASE" "$target"
  printf '%s' "$body" | write_declaration "$target"
  cp -R "$target" "$snapshot"

  set +e
  output="$(install_into "$target" 2>&1)"
  rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail "$label: install should have refused, exited 0"
  printf '%s\n' "$output" | grep -qi -- "$expected" \
    || fail "$label: refusal did not name the error ($expected); got:
$output"
  diff -r "$snapshot" "$target" >/dev/null 2>&1 \
    || fail "$label: refused install still wrote into the target:
$(diff -r "$snapshot" "$target" 2>&1 | head -20)"
}

assert_refused 'unparseable' 'could not be parsed' '{ this is not json'
printf '[6/%d] unparseable declaration: install refused, target untouched\n' "$TOTAL"

assert_refused 'parent' 'must not contain a .. segment' \
  '{"schema":"OperatorOwnedPaths/v1","paths":["../outside.md"]}'
printf '[7/%d] parent-escape declaration: install refused, target untouched\n' "$TOTAL"

assert_refused 'absolute' 'must be relative' \
  '{"schema":"OperatorOwnedPaths/v1","paths":["/etc/passwd"]}'
printf '[8/%d] absolute-path declaration: install refused, target untouched\n' "$TOTAL"

assert_refused 'duplicate' 'declared more than once' \
  '{"schema":"OperatorOwnedPaths/v1","paths":[".claude/agents/scout.md",".claude/agents/scout.md"]}'
printf '[9/%d] duplicate declaration: install refused, target untouched\n' "$TOTAL"

assert_refused 'core-required' 'pinned as core-required' \
  '{"schema":"OperatorOwnedPaths/v1","paths":["daemons/statusline-ctx.sh"]}'
printf '[10/%d] core-required declaration: install refused, target untouched\n' "$TOTAL"

printf 'operator-owned installer suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
