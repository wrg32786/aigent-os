#!/usr/bin/env bash
# aigent-OS installer
# Activates the current checkout in place, or installs into another directory.

set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash install.sh [TARGET] [OPTIONS]
  bash install.sh --target TARGET [OPTIONS]

With no TARGET, the installer activates the current aigent-OS checkout in place.

Options:
  --target DIR   Install into DIR instead of the current directory
  --no-deps      Skip optional Node.js dependency installation
  --dry-run      Print the planned changes without modifying files
  -h, --help     Show this help

Examples:
  bash install.sh
  bash install.sh --no-deps
  bash install.sh --target ~/projects/acme
  bash install.sh ~/projects/acme --no-deps
USAGE
}

fail() {
  printf '\n  ERROR: %s\n\n' "$*" >&2
  exit 1
}

TARGET=""
NO_DEPS=0
DRY_RUN=0

while (($#)); do
  case "$1" in
    --target)
      (($# >= 2)) || fail "--target requires a directory"
      [[ -z "$TARGET" ]] || fail "target specified more than once"
      TARGET="$2"
      shift 2
      ;;
    --no-deps)
      NO_DEPS=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while (($#)); do
        [[ -z "$TARGET" ]] || fail "target specified more than once"
        TARGET="$1"
        shift
      done
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      [[ -z "$TARGET" ]] || fail "target specified more than once"
      TARGET="$1"
      shift
      ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="${AIGENT_SRC:-$SCRIPT_DIR}"
[[ -f "$SRC/system/00_identity.md" ]] || fail "cannot locate source files at $SRC"

TARGET="${TARGET:-$PWD}"

abspath() {
  local path="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$path" <<'PY'
import os, sys
print(os.path.abspath(os.path.expanduser(sys.argv[1])))
PY
  elif command -v node >/dev/null 2>&1; then
    node -e 'console.log(require("path").resolve(process.argv[1].replace(/^~/, require("os").homedir())))' "$path"
  elif [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$PWD" "$path"
  fi
}

SRC="$(abspath "$SRC")"
TARGET="$(abspath "$TARGET")"
MODE="copy"
[[ "$SRC" == "$TARGET" ]] && MODE="in-place"

COPY_DIRS=(system vault hooks skills daemons scripts docs memory evals)

printf '\n'
printf '  +------------------------------------+\n'
printf '  |   aigent-OS installer              |\n'
printf '  +------------------------------------+\n\n'
printf '  Source: %s\n' "$SRC"
printf '  Target: %s\n' "$TARGET"
printf '  Mode:   %s\n' "$MODE"
printf '  Deps:   %s\n' "$([[ "$NO_DEPS" -eq 1 ]] && printf 'skip' || printf 'install when Node.js 18+ is available')"

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '\n  Planned changes:\n'
  if [[ "$MODE" == "copy" ]]; then
    for dir in "${COPY_DIRS[@]}"; do
      [[ -d "$SRC/$dir" ]] && printf '    - copy missing files from %s/\n' "$dir"
    done
    printf '    - create or refresh the managed aigent-OS block in CLAUDE.md\n'
  else
    printf '    - leave source files in place\n'
  fi
  printf '    - install runtime skills and agents under .claude/\n'
  printf '    - create or merge .claude/settings.json\n'
  printf '    - initialize local first-run state under .aigent/\n'
  printf '    - add generated-state entries to .gitignore\n'
  [[ "$NO_DEPS" -eq 0 ]] && printf '    - install optional semantic-search dependencies\n'
  printf '\n  Dry run complete. No files changed.\n\n'
  exit 0
fi

[[ ! -e "$TARGET" || -d "$TARGET" ]] || fail "target exists and is not a directory: $TARGET"
mkdir -p "$TARGET"

AIGENT_TMP="$(mktemp -d)"
cleanup() {
  rm -rf "$AIGENT_TMP"
}
trap cleanup EXIT INT TERM

BACKUP_DIR="$TARGET/.aigent/backups"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

copy_missing_tree() {
  local source="$1"
  local destination="$2"
  [[ -d "$source" ]] || return 0
  mkdir -p "$destination"
  cp -R -n "$source/." "$destination/"
}

if [[ "$MODE" == "copy" ]]; then
  printf '\n  Copying framework files without overwriting user files...\n'
  for dir in "${COPY_DIRS[@]}"; do
    [[ -d "$SRC/$dir" ]] || continue
    copy_missing_tree "$SRC/$dir" "$TARGET/$dir"
    printf '  [ok] %s/\n' "$dir"
  done
else
  printf '\n  Activating this checkout in place; source files already exist.\n'
fi

# Manage the aigent-OS portion of CLAUDE.md with explicit markers so reruns do
# not append duplicate copies forever.
START_MARKER='<!-- aigent-os:start -->'
END_MARKER='<!-- aigent-os:end -->'
MANAGED_BLOCK="$AIGENT_TMP/CLAUDE.managed.md"
{
  printf '%s\n' "$START_MARKER"
  cat "$SRC/CLAUDE.md"
  printf '\n%s\n' "$END_MARKER"
} > "$MANAGED_BLOCK"

if [[ "$MODE" == "in-place" ]]; then
  printf '  [ok] CLAUDE.md is the source copy\n'
elif [[ ! -f "$TARGET/CLAUDE.md" ]]; then
  cp "$MANAGED_BLOCK" "$TARGET/CLAUDE.md"
  printf '  [ok] CLAUDE.md created with managed aigent-OS block\n'
else
  cp "$TARGET/CLAUDE.md" "$BACKUP_DIR/CLAUDE.md.$STAMP"
  CLEAN_CLAUDE="$AIGENT_TMP/CLAUDE.clean.md"
  awk -v start="$START_MARKER" -v end="$END_MARKER" '
    $0 == start { managed = 1; next }
    $0 == end   { managed = 0; next }
    !managed    { print }
  ' "$TARGET/CLAUDE.md" > "$CLEAN_CLAUDE"
  {
    cat "$CLEAN_CLAUDE"
    [[ ! -s "$CLEAN_CLAUDE" ]] || printf '\n'
    cat "$MANAGED_BLOCK"
  } > "$TARGET/CLAUDE.md"
  printf '  [ok] CLAUDE.md managed block refreshed (backup saved)\n'
fi

mkdir -p "$TARGET/.claude/rules" "$TARGET/.claude/skills" "$TARGET/.claude/agents"
if [[ -f "$SRC/.claude/rules/post-compact-critical.md" ]]; then
  cp -n "$SRC/.claude/rules/post-compact-critical.md" "$TARGET/.claude/rules/" || true
fi

skills_new=0
skills_kept=0
if [[ -d "$SRC/skills" ]]; then
  shopt -s nullglob
  for skill_dir in "$SRC/skills"/*/; do
    [[ -f "$skill_dir/SKILL.md" ]] || continue
    skill_name="$(basename "$skill_dir")"
    if [[ ! -d "$TARGET/.claude/skills/$skill_name" ]]; then
      cp -R "$skill_dir" "$TARGET/.claude/skills/$skill_name"
      ((skills_new += 1))
    else
      ((skills_kept += 1))
    fi
  done
  shopt -u nullglob
fi
printf '  [ok] Skills: %d installed, %d existing copies preserved\n' "$skills_new" "$skills_kept"

agents_new=0
if [[ -d "$SRC/vault/agents" ]]; then
  shopt -s nullglob
  for agent_file in "$SRC/vault/agents"/*.md; do
    [[ -f "$agent_file" ]] || continue
    if head -20 "$agent_file" | grep -q '^name:' && head -20 "$agent_file" | grep -q '^tools:'; then
      destination="$TARGET/.claude/agents/$(basename "$agent_file")"
      if [[ ! -f "$destination" ]]; then
        cp "$agent_file" "$destination"
        ((agents_new += 1))
      fi
    fi
  done
  shopt -u nullglob
fi
printf '  [ok] Agents: %d registered, existing definitions preserved\n' "$agents_new"

SETTINGS_SRC="$SRC/.claude/settings.json.template"
SETTINGS_DST="$TARGET/.claude/settings.json"
RENDERED_TMPL="$AIGENT_TMP/settings.rendered.json"
[[ -f "$SETTINGS_SRC" ]] || fail "missing settings template: $SETTINGS_SRC"

json_path="${TARGET//\\/\\\\}"
json_path="${json_path//\"/\\\"}"
while IFS= read -r line || [[ -n "$line" ]]; do
  printf '%s\n' "${line//__AIGENT_ROOT__/$json_path}"
done < "$SETTINGS_SRC" > "$RENDERED_TMPL"

if [[ ! -f "$SETTINGS_DST" ]]; then
  cp "$RENDERED_TMPL" "$SETTINGS_DST"
  printf '  [ok] .claude/settings.json created\n'
else
  cp "$SETTINGS_DST" "$BACKUP_DIR/settings.json.$STAMP"
  MERGED="$AIGENT_TMP/settings.merged.json"
  MERGE_OK=0

  if command -v python3 >/dev/null 2>&1; then
    cat > "$AIGENT_TMP/merge-settings.py" <<'PY'
import json
import sys

base_path, add_path, out_path = sys.argv[1:4]
with open(base_path, encoding="utf-8") as fh:
    base = json.load(fh)
with open(add_path, encoding="utf-8") as fh:
    addition = json.load(fh)

MANAGED_SCALARS = {
    ("env", "AIGENT_ROOT"),
    ("env", "AIGENT_VAULT"),
}

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))

def merge(old, new, path=()):
    if path in MANAGED_SCALARS:
        return new
    if isinstance(old, dict) and isinstance(new, dict):
        result = dict(old)
        for key, value in new.items():
            result[key] = merge(old[key], value, path + (key,)) if key in old else value
        return result
    if isinstance(old, list) and isinstance(new, list):
        result = list(old)
        seen = {canonical(item) for item in result}
        for item in new:
            marker = canonical(item)
            if marker not in seen:
                result.append(item)
                seen.add(marker)
        return result
    return old

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(merge(base, addition), fh, indent=2)
    fh.write("\n")
PY
    if python3 "$AIGENT_TMP/merge-settings.py" "$SETTINGS_DST" "$RENDERED_TMPL" "$MERGED" 2>/dev/null; then
      MERGE_OK=1
    fi
  elif command -v node >/dev/null 2>&1; then
    cat > "$AIGENT_TMP/merge-settings.cjs" <<'JS'
const fs = require('fs');
const [basePath, addPath, outPath] = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const addition = JSON.parse(fs.readFileSync(addPath, 'utf8'));
const managed = new Set(['env.AIGENT_ROOT', 'env.AIGENT_VAULT']);
const canonical = value => JSON.stringify(value, Object.keys(value || {}).sort());
function merge(oldValue, newValue, path = []) {
  if (managed.has(path.join('.'))) return newValue;
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    const result = [...oldValue];
    const seen = new Set(result.map(canonical));
    for (const item of newValue) {
      const marker = canonical(item);
      if (!seen.has(marker)) { result.push(item); seen.add(marker); }
    }
    return result;
  }
  if (oldValue && newValue && typeof oldValue === 'object' && typeof newValue === 'object') {
    const result = { ...oldValue };
    for (const [key, value] of Object.entries(newValue)) {
      result[key] = key in oldValue ? merge(oldValue[key], value, [...path, key]) : value;
    }
    return result;
  }
  return oldValue;
}
fs.writeFileSync(outPath, JSON.stringify(merge(base, addition), null, 2) + '\n');
JS
    if node "$AIGENT_TMP/merge-settings.cjs" "$SETTINGS_DST" "$RENDERED_TMPL" "$MERGED" 2>/dev/null; then
      MERGE_OK=1
    fi
  fi

  if [[ "$MERGE_OK" -eq 1 ]] && [[ -s "$MERGED" ]]; then
    mv "$MERGED" "$SETTINGS_DST"
    printf '  [ok] Existing settings.json merged (backup saved)\n'
  else
    cp "$RENDERED_TMPL" "$TARGET/.claude/settings.aigent.json"
    printf '  [warn] Existing settings.json was not valid JSON or no JSON runtime was available.\n'
    printf '         It was left untouched. Merge .claude/settings.aigent.json manually.\n'
  fi
fi
if [[ "$(abspath "$SETTINGS_SRC")" != "$(abspath "$TARGET/.claude/settings.json.template")" ]]; then
  cp "$SETTINGS_SRC" "$TARGET/.claude/settings.json.template"
fi

if [[ -f "$SRC/.claude/skill-index.json" && ! -f "$TARGET/.claude/skill-index.json" ]]; then
  cp "$SRC/.claude/skill-index.json" "$TARGET/.claude/skill-index.json"
fi

mkdir -p \
  "$TARGET/vault/daily" \
  "$TARGET/vault/projects" \
  "$TARGET/vault/people" \
  "$TARGET/vault/concepts" \
  "$TARGET/vault/memory" \
  "$TARGET/.aigent"

STATE_FILE="$TARGET/.aigent/state.json"
if [[ ! -f "$STATE_FILE" ]]; then
  cat > "$STATE_FILE" <<'JSON'
{
  "schemaVersion": 1,
  "status": "uninitialized",
  "completedAt": null
}
JSON
fi
printf '  [ok] Vault directories and first-run state ready\n'

GITIGNORE="$TARGET/.gitignore"
GI_START='# aigent-os:generated-state:start'
GI_END='# aigent-os:generated-state:end'
GI_BLOCK="$AIGENT_TMP/gitignore.block"
cat > "$GI_BLOCK" <<EOF_GI
$GI_START
.aigent/
vault/memory/embeddings.json
vault/memory/HEAT_INDEX.json
memory/.daemon-errors.log
.claude/settings.aigent.json
$GI_END
EOF_GI
if [[ -f "$GITIGNORE" ]]; then
  GI_CLEAN="$AIGENT_TMP/gitignore.clean"
  awk -v start="$GI_START" -v end="$GI_END" '
    $0 == start { managed = 1; next }
    $0 == end   { managed = 0; next }
    !managed    { print }
  ' "$GITIGNORE" > "$GI_CLEAN"
  {
    cat "$GI_CLEAN"
    [[ ! -s "$GI_CLEAN" ]] || printf '\n'
    cat "$GI_BLOCK"
  } > "$GITIGNORE"
else
  cp "$GI_BLOCK" "$GITIGNORE"
fi
printf '  [ok] Generated local state excluded from git\n'

if [[ "$NO_DEPS" -eq 1 ]]; then
  printf '  [skip] Optional dependencies (--no-deps)\n'
elif [[ ! -f "$TARGET/daemons/semantic-search/package.json" ]]; then
  printf '  [skip] No semantic-search package found\n'
elif ! command -v node >/dev/null 2>&1; then
  printf '  [warn] Node.js not found; semantic search was not installed\n'
else
  NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || ((NODE_MAJOR < 18)); then
    printf '  [warn] Node.js 18+ is required for semantic search; found %s\n' "$(node --version)"
  else
    printf '  Installing optional semantic-search dependencies (network access may occur)...\n'
    pushd "$TARGET/daemons/semantic-search" >/dev/null
    if [[ -f package-lock.json ]]; then
      npm ci --silent
    else
      npm install --silent
    fi
    popd >/dev/null
    printf '  [ok] Semantic search dependencies installed\n'
  fi
fi

printf '\n  ========================================\n'
printf '  [ok] aigent-OS is ready\n'
printf '  ========================================\n\n'
printf '  Next:\n'
printf '    1. Open Claude Code in: %s\n' "$TARGET"
printf '    2. Run /start for first-time setup\n'
printf '    3. Use /open at the start and /close at the end of later sessions\n\n'
