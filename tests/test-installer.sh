#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

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
{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__","AIGENT_VAULT":"__AIGENT_ROOT__"},"hooks":{"SessionEnd":[]}}
JSON
  printf '[]\n' > "$source/.claude/skill-index.json"
  printf '{"name":"semantic-search","version":"1.0.0"}\n' > "$source/daemons/semantic-search/package.json"
}

FIXTURE="$WORK/source"
make_fixture "$FIXTURE"

# The documented flag-only command must activate the checkout, not create --no-deps/.
(
  cd "$FIXTURE"
  bash install.sh --no-deps >/dev/null
)
test -f "$FIXTURE/.claude/settings.json"
test -f "$FIXTURE/.aigent/state.json"
test ! -d "$FIXTURE/--no-deps"
json_valid "$FIXTURE/.claude/settings.json"

# Flags may precede the target, and paths containing spaces must render valid JSON.
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

# Reruns refresh one managed block rather than appending duplicates.
(
  cd "$FIXTURE"
  bash install.sh "$TARGET" --no-deps >/dev/null
)
test "$(grep -c '<!-- aigent-os:start -->' "$TARGET/CLAUDE.md")" -eq 1
test "$(grep -c '# aigent-os:generated-state:start' "$TARGET/.gitignore")" -eq 1

# Valid existing settings are merged and custom user settings survive.
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

# Invalid settings remain untouched and receive a durable repair candidate.
INVALID_TARGET="$WORK/invalid-target"
mkdir -p "$INVALID_TARGET/.claude"
printf '{invalid\n' > "$INVALID_TARGET/.claude/settings.json"
(
  cd "$FIXTURE"
  bash install.sh --target "$INVALID_TARGET" --no-deps >/dev/null
)
grep -F '{invalid' "$INVALID_TARGET/.claude/settings.json" >/dev/null
json_valid "$INVALID_TARGET/.claude/settings.aigent.json"

# Dry run must not create the target.
DRY_TARGET="$WORK/dry-target"
(
  cd "$FIXTURE"
  bash install.sh --target "$DRY_TARGET" --dry-run --no-deps >/dev/null
)
test ! -e "$DRY_TARGET"

# Smoke-test a real copied installation with the repository doctor.
REAL_TARGET="$WORK/real-target"
bash "$ROOT/install.sh" --target "$REAL_TARGET" --no-deps >/dev/null
bash "$REAL_TARGET/scripts/doctor.sh" "$REAL_TARGET" >/dev/null

printf 'installer regression tests passed\n'
