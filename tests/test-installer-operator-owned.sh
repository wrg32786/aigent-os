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

TOTAL=16
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

# -- 11. Line injection into the declaration protocol (R1 HIGH-1) ------------
# The declaration reader hands the installer a line-oriented protocol
# (count:/warn:/keep:). An entry carrying a newline splits into TWO protocol
# lines, and the second one is attacker-chosen. This exact payload passes every
# other validator: it is relative, has no .. segment, no empty segment, no **,
# and as a whole string it collides with no manifest entry. Before the fix it
# emitted
#     warn:notes/decoy.md
#     keep:daemons/statusline-ctx.sh
# which preserved a planted core daemon instead of quarantining it.
INJECT_TARGET="$WORK/refuse-inject"
INJECT_SNAPSHOT="$WORK/refuse-inject-snapshot"
rm -rf "$INJECT_TARGET" "$INJECT_SNAPSHOT"
cp -R "$REFUSE_BASE" "$INJECT_TARGET"
printf '#!/usr/bin/env bash\n# PLANTED-STALE-CORE\nexit 0\n' \
  > "$INJECT_TARGET/daemons/statusline-ctx.sh"
# Literal backslash-n in the JSON source; json.load decodes it to a real newline.
printf '%s' '{"schema":"OperatorOwnedPaths/v1","paths":["notes/decoy.md\nkeep:daemons/statusline-ctx.sh"]}' \
  | write_declaration "$INJECT_TARGET"
cp -R "$INJECT_TARGET" "$INJECT_SNAPSHOT"
set +e
INJECT_OUT="$(install_into "$INJECT_TARGET" 2>&1)"
INJECT_RC=$?
set -e
[[ "$INJECT_RC" -ne 0 ]] \
  || fail "injection: install should have refused, exited 0 (the payload was accepted)"
printf '%s\n' "$INJECT_OUT" | grep -qi 'must not contain a line break' \
  || fail "injection: refusal did not name the error; got:
$INJECT_OUT"
if printf '%s\n' "$INJECT_OUT" | grep -q 'keep daemons/statusline-ctx.sh'; then
  fail "injection: the payload still reached the keep set"
fi
diff -r "$INJECT_SNAPSHOT" "$INJECT_TARGET" >/dev/null 2>&1 \
  || fail "injection: refused install still wrote into the target"
printf '[11/%d] protocol line injection: refused by name, payload never reached the keep set\n' "$TOTAL"

# -- 12. Remaining malformed and conflicting declaration shapes (R1 MED-2) ---
assert_refused 'doublestar' 'but not' \
  '{"schema":"OperatorOwnedPaths/v1","paths":[".claude/skills/**/SKILL.md"]}'
assert_refused 'rewritten' 'rewritten by the installer' \
  '{"schema":"OperatorOwnedPaths/v1","paths":["CLAUDE.md"]}'
# R1 LOW-1: a glob that COVERS a rewritten path must refuse too, not just the
# exact string.
assert_refused 'rewritten-glob' 'rewritten by the installer' \
  '{"schema":"OperatorOwnedPaths/v1","paths":["CLAUDE.*"]}'
assert_refused 'empty-path' 'declares an empty path' \
  '{"schema":"OperatorOwnedPaths/v1","paths":[""]}'
assert_refused 'dot-segment' 'empty or . path segment' \
  '{"schema":"OperatorOwnedPaths/v1","paths":[".claude/./agents/scout.md"]}'
assert_refused 'double-slash' 'empty or . path segment' \
  '{"schema":"OperatorOwnedPaths/v1","paths":[".claude//agents/scout.md"]}'
assert_refused 'non-object' 'must be a JSON object' \
  '[".claude/agents/scout.md"]'
assert_refused 'paths-not-array' 'array of relative path strings' \
  '{"schema":"OperatorOwnedPaths/v1","paths":".claude/agents/scout.md"}'
assert_refused 'paths-not-strings' 'array of relative path strings' \
  '{"schema":"OperatorOwnedPaths/v1","paths":[".claude/agents/scout.md",7]}'
printf '[12/%d] malformed shapes: **, rewritten (exact and glob), empty path, . and empty segments, non-object, bad paths type all refused\n' "$TOTAL"

# -- 13. Symlink-resolving declarations (R1 MED-2, LOW-2) -------------------
# Plain `ln -s` on Windows silently COPIES when the process lacks symlink
# privilege, which would make these pass for the wrong reason. Mirror
# tests/test-installer-fast.sh: try the MSYS-emulated form, and declare a
# platform SKIP rather than assert on a link that is not a link.
make_symlink() {
  local dest="$1" link="$2"
  ln -s "$dest" "$link" 2>/dev/null || true
  if [[ ! -L "$link" ]]; then
    rm -f "$link"
    MSYS=winsymlinks ln -s "$dest" "$link" 2>/dev/null || true
  fi
  [[ -L "$link" ]]
}

SYMLINK_PROBE="$WORK/symlink-probe"
mkdir -p "$SYMLINK_PROBE"
printf 'sentinel\n' > "$SYMLINK_PROBE/sentinel.txt"
SYMLINK_BASH=0
SYMLINK_PYTHON=0
if make_symlink "$SYMLINK_PROBE/sentinel.txt" "$SYMLINK_PROBE/link.txt"; then
  SYMLINK_BASH=1
  # Two guards, two instruments, and on Windows they disagree. MSYS
  # winsymlinks produces a link bash reports through -L but that a native
  # python3 sees as an ordinary file, so the reader-side guard below cannot be
  # exercised here even though the bash-side one can. Ask python directly
  # rather than assuming the two views match.
  if python3 -c 'import os, sys; sys.exit(0 if os.path.islink(sys.argv[1]) else 1)' \
    "$SYMLINK_PROBE/link.txt" 2>/dev/null; then
    SYMLINK_PYTHON=1
  fi
fi

# R1 LOW-2: the declaration FILE itself must not be read through a symlink.
# Guarded in bash (path_is_symlink_safe), so a bash-visible link is enough.
if [[ "$SYMLINK_BASH" -eq 1 ]]; then
  DECL_TARGET="$WORK/refuse-decl-symlink"
  rm -rf "$DECL_TARGET"
  cp -R "$REFUSE_BASE" "$DECL_TARGET"
  printf '%s' '{"schema":"OperatorOwnedPaths/v1","paths":[".claude/agents/scout.md"]}' \
    > "$SYMLINK_PROBE/outside-declaration.json"
  mkdir -p "$DECL_TARGET/.aigent"
  rm -f "$DECL_TARGET/.aigent/operator-owned.json"
  make_symlink "$SYMLINK_PROBE/outside-declaration.json" \
    "$DECL_TARGET/.aigent/operator-owned.json" \
    || fail "declaration symlink: could not create the link"
  set +e
  DECL_OUT="$(install_into "$DECL_TARGET" 2>&1)"
  DECL_RC=$?
  set -e
  [[ "$DECL_RC" -ne 0 ]] || fail "declaration symlink: install should have refused, exited 0"
  printf '%s\n' "$DECL_OUT" | grep -qi 'symlink' \
    || fail "declaration symlink: refusal did not name a symlink; got:
$DECL_OUT"
  printf '[13/%d] declaration file behind a symlink: refused before it is read\n' "$TOTAL"
else
  printf '[13/%d] SKIP POSIX symlink probes: this platform cannot create a real symlink\n' "$TOTAL"
fi

# R1 MED-2: a declared PATH that resolves through a symlink. Guarded inside the
# python reader, so it needs a link python3 itself can see.
if [[ "$SYMLINK_PYTHON" -eq 1 ]]; then
  SYM_TARGET="$WORK/refuse-symlink"
  rm -rf "$SYM_TARGET"
  cp -R "$REFUSE_BASE" "$SYM_TARGET"
  make_symlink "$SYMLINK_PROBE/sentinel.txt" "$SYM_TARGET/.claude/agents/linked.md" \
    || fail "symlink: could not create the declared link"
  printf '%s' '{"schema":"OperatorOwnedPaths/v1","paths":[".claude/agents/linked.md"]}' \
    | write_declaration "$SYM_TARGET"
  set +e
  SYM_OUT="$(install_into "$SYM_TARGET" 2>&1)"
  SYM_RC=$?
  set -e
  [[ "$SYM_RC" -ne 0 ]] || fail "symlink: install should have refused, exited 0"
  printf '%s\n' "$SYM_OUT" | grep -qi 'resolves through a symlink' \
    || fail "symlink: refusal did not name the error; got:
$SYM_OUT"
  printf '[13/%d] declared path behind a symlink: refused by the reader\n' "$TOTAL"
else
  printf '[13/%d] SKIP POSIX declared-path symlink probe: python3 does not see this platform link as a symlink\n' "$TOTAL"
fi

# -- 14..16. A python3 that is present but does not work (R1 HIGH-2) --------
# `command -v python3` answers "is there a file named python3 on PATH", which is
# not the question. The question is whether it can run and speak the protocol.
# The shim below breaks ONLY the probe and the declaration read, and delegates
# every other python3 call (the settings renderer) to the real interpreter, so
# these scenarios isolate the declaration path.
REAL_PYTHON3="$(command -v python3 || true)"
if [[ -z "$REAL_PYTHON3" ]]; then
  printf '[14/%d] SKIP POSIX broken-python3 probes: no python3 on PATH to delegate to\n' "$TOTAL"
  printf '[15/%d] SKIP POSIX broken-python3 probes: no python3 on PATH to delegate to\n' "$TOTAL"
  printf '[16/%d] SKIP POSIX broken-python3 probes: no python3 on PATH to delegate to\n' "$TOTAL"
else
  make_python3_shim() {
    # Separate `local` statements on purpose: `local a="$1" b="...$a"` reads $a
    # before this frame's assignment lands, which under `set -u` aborts the
    # function and hands the caller an empty path. An empty PATH prefix then
    # silently runs the REAL interpreter, so the scenario would pass for the
    # wrong reason.
    local name="$1"
    local misbehave="$2"
    local dir="$WORK/shim-$name"
    mkdir -p "$dir"
    {
      printf '#!/bin/sh\n'
      printf 'case "$1" in -c) %s ;; esac\n' "$misbehave"
      printf 'for a in "$@"; do case "$a" in *operator-owned.json) %s ;; esac; done\n' "$misbehave"
      printf 'exec "%s" "$@"\n' "$REAL_PYTHON3"
    } > "$dir/python3"
    chmod +x "$dir/python3"
    printf '%s' "$dir"
  }

  assert_shim_refused() {
    local label="$1" expected="$2" shim_dir="$3"
    local target="$WORK/refuse-$label" snapshot="$WORK/refuse-$label-snapshot"
    local output rc
    rm -rf "$target" "$snapshot"
    cp -R "$REFUSE_BASE" "$target"
    printf '%s' '{"schema":"OperatorOwnedPaths/v1","paths":[".claude/agents/scout.md"]}' \
      | write_declaration "$target"
    cp -R "$target" "$snapshot"
    set +e
    output="$(PATH="$shim_dir:$PATH" install_into "$target" 2>&1)"
    rc=$?
    set -e
    [[ "$rc" -ne 0 ]] || fail "$label: install should have refused, exited 0"
    printf '%s\n' "$output" | grep -qi -- "$expected" \
      || fail "$label: refusal did not name the error ($expected); got:
$output"
    diff -r "$snapshot" "$target" >/dev/null 2>&1 \
      || fail "$label: refused install still wrote into the target"
  }

  assert_shim_refused 'py-broken' 'python3 is not available' \
    "$(make_python3_shim broken 'exit 1')"
  printf '[14/%d] python3 present but unrunnable: named refusal, target untouched\n' "$TOTAL"

  assert_shim_refused 'py-silent' 'produced no output' \
    "$(make_python3_shim silent 'exit 0')"
  printf '[15/%d] python3 exits clean with no output: named refusal, never a silent skip\n' "$TOTAL"

  assert_shim_refused 'py-garbage' 'unrecognized line' \
    "$(make_python3_shim garbage 'echo garbage-line; exit 0')"

  # The counterpart: with NO declaration file the probe never runs, so a broken
  # python3 must not block an install that never needed it.
  NOPY_TARGET="$WORK/nodecl-brokenpy-target"
  NOPY_SHIM="$(make_python3_shim nodecl 'exit 1')"
  set +e
  (PATH="$NOPY_SHIM:$PATH" install_into "$NOPY_TARGET" >/dev/null 2>&1)
  NOPY_RC=$?
  set -e
  [[ "$NOPY_RC" -eq 0 ]] \
    || fail "no declaration + broken python3: install should have succeeded, rc=$NOPY_RC"
  test -f "$NOPY_TARGET/.claude/settings.json" \
    || fail "no declaration + broken python3: install did not complete"
  printf '[16/%d] unrecognized protocol line refused; no declaration + broken python3 still installs\n' "$TOTAL"
fi

printf 'operator-owned installer suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
