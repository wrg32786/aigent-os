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
  --target DIR          Install into DIR instead of the current directory
  --no-deps             Skip optional Node.js dependency installation
  --dry-run             Print the planned changes without modifying files
  --trust-existing      Keep pre-existing files under hooks/, daemons/,
                        .claude/skills/, .claude/agents/, .claude/rules/, and
                        skill-index.json even when they differ from the
                        framework version, instead of quarantining them
                        (see docs/install-security.md)
  -h, --help            Show this help

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
TRUST_EXISTING=0

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
    --trust-existing)
      TRUST_EXISTING=1
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
  local existing suffix leaf parent resolved

  case "$path" in
    "~") path="$HOME" ;;
    "~/"*) path="$HOME/${path#\~/}" ;;
  esac

  if command -v cygpath >/dev/null 2>&1 && [[ "$path" =~ ^[A-Za-z]:[\\/] ]]; then
    path="$(cygpath -u "$path")"
  fi
  [[ "$path" = /* ]] || path="$PWD/$path"

  existing="${path%/}"
  [[ -n "$existing" ]] || existing="/"
  suffix=""
  while [[ ! -e "$existing" ]]; do
    leaf="${existing##*/}"
    suffix="/$leaf$suffix"
    parent="${existing%/*}"
    [[ -n "$parent" ]] || parent="/"
    [[ "$parent" != "$existing" ]] || break
    existing="$parent"
  done

  if [[ -d "$existing" ]]; then
    resolved="$(cd "$existing" && pwd -P)"
  else
    parent="$(dirname "$existing")"
    leaf="$(basename "$existing")"
    resolved="$(cd "$parent" && pwd -P)/$leaf"
  fi
  printf '%s%s\n' "${resolved%/}" "$suffix"
}

SRC="$(abspath "$SRC")"
TARGET="$(abspath "$TARGET")"
MODE="copy"
[[ "$SRC" == "$TARGET" ]] && MODE="in-place"

COPY_DIRS=(system vault hooks skills daemons scripts docs memory evals)

# ── Symlink-escape guard (Codex finding #22) ─────────────────────────────────
# A pre-seeded symlink inside TARGET -- e.g. a file named "CLAUDE.md" that is
# actually a symlink to "~/.bashrc" -- would otherwise let a write we believe
# lands on "$TARGET/CLAUDE.md" actually land wherever the link points, because
# both `cp` and shell redirection (`>`) follow symlinks by default. `mkdir -p`
# has the same problem one level up: if an intermediate directory such as
# "$TARGET/.claude" is itself a symlink to somewhere writable, everything
# nested under it escapes too.
#
# path_is_symlink_safe walks every path component from TARGET down to the
# destination (inclusive) and fails if any of them is already a symlink.
# Every write site below TARGET is expected to pass its destination through
# this check (or the require_symlink_safe / safe_mkdir_p wrappers) before
# touching disk.
path_is_symlink_safe() {
  local dest="$1"
  local rel="${dest#"$TARGET"/}"
  [[ "$rel" != "$dest" ]] || return 0   # dest is TARGET itself; nothing to walk
  local walked="$TARGET" part
  local IFS='/'
  for part in $rel; do
    [[ -n "$part" ]] || continue
    walked="$walked/$part"
    [[ ! -L "$walked" ]] || return 1
  done
  return 0
}

warn_symlink_escape() {
  printf '  [skip] refusing to write through symlink: %s -> %s\n' \
    "$1" "$(readlink "$1" 2>/dev/null || printf '(unresolvable)')"
}

# For single, critical top-level writes (CLAUDE.md, settings.json,
# .gitignore) skipping silently would leave TARGET half-configured anyway --
# so these abort the whole install with actionable guidance instead of
# quietly writing around the problem.
require_symlink_safe() {
  path_is_symlink_safe "$1" || fail "refusing to write through symlink: $1 -> $(readlink "$1" 2>/dev/null || printf '(unresolvable)'). Remove or replace it manually, then re-run."
}

safe_mkdir_p() {
  local dir="$1"
  if path_is_symlink_safe "$dir"; then
    mkdir -p "$dir"
  else
    warn_symlink_escape "$dir"
    return 1
  fi
}

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
safe_mkdir_p "$BACKUP_DIR" || fail "cannot create $BACKUP_DIR (see symlink warning above)"
QUARANTINE_DIR="$TARGET/.aigent/quarantine"
# AIGENT_INSTALL_STAMP override exists only so tests/test-installer.sh can
# predict the exact backup/quarantine filename to pre-plant a symlink at
# (mirrors the AIGENT_SRC / AIGENT_OS_DIR / AIGENT_OS_REPO_URL test seams
# elsewhere in this repo). Same caveat as those: an attacker who already
# controls your environment variables has code execution regardless.
STAMP="${AIGENT_INSTALL_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"

# Single-file counterpart to copy_missing_tree's per-file handling, factored
# out so every standalone sensitive single-file site (.claude/rules,
# skill-index.json, .claude/agents/*.md) shares one implementation with the
# tree walk below instead of a second hand-copy of the quarantine/symlink
# logic that could drift out of sync.
#
# sensitive=1 marks files that become trusted -- read as agent instructions,
# wired as slash commands/subagents, or run as hooks/daemons -- the next
# time Claude Code touches them (Codex finding #19). For those, a
# pre-existing file that differs from the framework's copy is quarantined
# instead of silently kept, unless --trust-existing was passed. Byte-
# identical files (e.g. a prior run's own copy) pass through with no action.
copy_missing_file() {
  local source_file="$1" dest_file="$2" sensitive="${3:-0}"
  if [[ ! -e "$dest_file" ]]; then
    if path_is_symlink_safe "$dest_file"; then
      cp "$source_file" "$dest_file"
    else
      warn_symlink_escape "$dest_file"
    fi
    return 0
  fi
  [[ "$sensitive" -eq 1 && "$TRUST_EXISTING" -eq 0 ]] || return 0
  cmp -s "$source_file" "$dest_file" 2>/dev/null && return 0

  # A file already sits where this installer would otherwise place trusted
  # content, and its content differs from what the framework ships.
  # Silently keeping it (the no-clobber behavior non-sensitive sites use)
  # would let a planted file quietly become trusted the next time it's
  # read/run. Quarantine it and install the framework's version instead.
  if ! path_is_symlink_safe "$dest_file"; then
    warn_symlink_escape "$dest_file"
    return 0
  fi
  local quarantine_rel="${dest_file#"$TARGET"/}"
  local quarantine_dest="$QUARANTINE_DIR/$quarantine_rel.$STAMP"
  safe_mkdir_p "$QUARANTINE_DIR/$(dirname -- "$quarantine_rel")" || return 0
  if ! path_is_symlink_safe "$quarantine_dest"; then
    # The quarantine slot itself is unsafe (Codex finding #22's item-2 case):
    # rather than quarantine into or through a symlink, leave the
    # pre-existing file exactly where it was and say so loudly.
    warn_symlink_escape "$quarantine_dest"
    printf '  [skip] could not quarantine %s -- leaving pre-existing file in place\n' "$dest_file"
    return 0
  fi
  cp "$dest_file" "$quarantine_dest"
  cp "$source_file" "$dest_file"
  printf '  [quarantine] %s differed from the framework copy; original saved to %s\n' \
    "$dest_file" "$quarantine_dest"
}

copy_missing_tree() {
  local source="$1"
  local destination="$2"
  local sensitive="${3:-0}"
  [[ -d "$source" ]] || return 0
  safe_mkdir_p "$destination" || return 0
  # Guard against source and destination canonicalizing to the same directory
  # (e.g. a macOS /var -> /private/var symlink, or a Windows 8.3 short-name
  # alias resolving to the same path as the long form). cp -R onto oneself
  # fails hard on BSD and Windows cp, killing the script under set -e.
  [[ "$(cd "$source" && pwd -P)" != "$(cd "$destination" && pwd -P)" ]] || return 0

  # Copy only what's missing, file by file, instead of `cp -R -n`. cp's exit
  # code for a declined no-clobber overwrite is not portable: GNU cp (Linux,
  # Git-for-Windows) exits 0, BSD cp (macOS) exits 1 -- which kills this
  # script under set -e the first time a destination file already exists.
  # -print0 / read -d '' keep this safe for names containing spaces.
  local rel
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    [[ -n "$rel" ]] || continue
    # `|| true`: this is a many-directory tree copy, so one symlinked
    # directory should skip (safe_mkdir_p already printed the warning) and
    # let the rest of the tree continue -- not abort the whole install via
    # set -e, which a bare failing statement would otherwise trigger.
    safe_mkdir_p "$destination/$rel" || true
  done < <(cd "$source" && find . -type d -print0)

  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    # `|| true`: copy_missing_file's return value is not meaningful success/
    # failure signaling here (it handles and reports its own outcomes), so a
    # non-zero return must never be allowed to trip set -e and abort the
    # whole tree copy over one file.
    copy_missing_file "$source/$rel" "$destination/$rel" "$sensitive" || true
  done < <(cd "$source" && find . -type f -print0)
}

if [[ "$MODE" == "copy" ]]; then
  printf '\n  Copying framework files without overwriting user files...\n'
  for dir in "${COPY_DIRS[@]}"; do
    [[ -d "$SRC/$dir" ]] || continue
    case "$dir" in
      hooks|daemons) copy_missing_tree "$SRC/$dir" "$TARGET/$dir" 1 ;;
      *)             copy_missing_tree "$SRC/$dir" "$TARGET/$dir" 0 ;;
    esac
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
else
  # Guards both branches below: a symlinked CLAUDE.md (dangling, so the
  # create branch would write through it, or pointing at an existing file,
  # so the refresh branch would overwrite through it) is refused up front.
  require_symlink_safe "$TARGET/CLAUDE.md"
  if [[ ! -f "$TARGET/CLAUDE.md" ]]; then
    cp "$MANAGED_BLOCK" "$TARGET/CLAUDE.md"
    printf '  [ok] CLAUDE.md created with managed aigent-OS block\n'
  else
    # Backup leaf write (Codex finding #22 item 2): STAMP's second-precision
    # makes the exact backup filename hard but not impossible to predict, so
    # this gets the same abort-on-symlink treatment as the primary write
    # above rather than assuming a fresh name can't collide with a plant.
    require_symlink_safe "$BACKUP_DIR/CLAUDE.md.$STAMP"
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
fi

safe_mkdir_p "$TARGET/.claude/rules" || fail "cannot create $TARGET/.claude/rules (see symlink warning above)"
safe_mkdir_p "$TARGET/.claude/skills" || fail "cannot create $TARGET/.claude/skills (see symlink warning above)"
safe_mkdir_p "$TARGET/.claude/agents" || fail "cannot create $TARGET/.claude/agents (see symlink warning above)"
# .claude/rules is read as agent instructions on every session -- a planted
# file here that differs from the framework's is as much a trust-surface
# concern as a hook script (Codex finding #19's "same bug class one
# directory over"), so it goes through copy_missing_file(sensitive=1) too.
RULES_SRC="$SRC/.claude/rules/post-compact-critical.md"
RULES_DST="$TARGET/.claude/rules/post-compact-critical.md"
if [[ -f "$RULES_SRC" ]]; then
  # Same-file guard, mirroring the settings.json.template check below: in
  # in-place mode SRC and TARGET canonicalize to the same directory, so a
  # blind cp here would target itself and fail hard on BSD/Windows cp.
  if [[ "$(abspath "$RULES_SRC")" != "$(abspath "$RULES_DST")" ]]; then
    copy_missing_file "$RULES_SRC" "$RULES_DST" 1 || true
  fi
fi

# .claude/skills/<name>/ is a directory tree (SKILL.md plus whatever else
# the skill ships), so it reuses copy_missing_tree(sensitive=1) rather than
# copy_missing_file -- same per-file quarantine/symlink handling, walked
# recursively. This is the runtime location Claude Code actually resolves
# slash commands from; the plain top-level skills/ COPY_DIRS entry above is
# just the inert framework-source mirror and stays non-sensitive.
skills_new=0
skills_existing=0
if [[ -d "$SRC/skills" ]]; then
  shopt -s nullglob
  for skill_dir in "$SRC/skills"/*/; do
    [[ -f "$skill_dir/SKILL.md" ]] || continue
    skill_name="$(basename "$skill_dir")"
    skill_dst="$TARGET/.claude/skills/$skill_name"
    if [[ -d "$skill_dst" ]]; then
      ((skills_existing += 1))
    else
      ((skills_new += 1))
    fi
    copy_missing_tree "$skill_dir" "$skill_dst" 1
  done
  shopt -u nullglob
fi
printf '  [ok] Skills: %d new, %d existing directories processed\n' "$skills_new" "$skills_existing"

# .claude/agents/*.md are the dispatchable subagent definitions Claude Code
# loads directly (vault/agents/ is just the docs source) -- trusted content
# exactly like a hook, so sensitive=1 here too.
agents_new=0
if [[ -d "$SRC/vault/agents" ]]; then
  shopt -s nullglob
  for agent_file in "$SRC/vault/agents"/*.md; do
    [[ -f "$agent_file" ]] || continue
    if head -20 "$agent_file" | grep -q '^name:' && head -20 "$agent_file" | grep -q '^tools:'; then
      destination="$TARGET/.claude/agents/$(basename "$agent_file")"
      [[ -f "$destination" ]] || ((agents_new += 1))
      copy_missing_file "$agent_file" "$destination" 1 || true
    fi
  done
  shopt -u nullglob
fi
printf '  [ok] Agents: %d new, existing definitions processed\n' "$agents_new"

SETTINGS_SRC="$SRC/.claude/settings.json.template"
SETTINGS_DST="$TARGET/.claude/settings.json"
RENDERED_TMPL="$AIGENT_TMP/settings.rendered.json"
[[ -f "$SETTINGS_SRC" ]] || fail "missing settings template: $SETTINGS_SRC"

json_path="${TARGET//\\/\\\\}"
json_path="${json_path//\"/\\\"}"
while IFS= read -r line || [[ -n "$line" ]]; do
  printf '%s\n' "${line//__AIGENT_ROOT__/$json_path}"
done < "$SETTINGS_SRC" > "$RENDERED_TMPL"

require_symlink_safe "$SETTINGS_DST"
if [[ ! -f "$SETTINGS_DST" ]]; then
  cp "$RENDERED_TMPL" "$SETTINGS_DST"
  printf '  [ok] .claude/settings.json created\n'
else
  # Backup leaf write (Codex finding #22 item 2) -- same reasoning as the
  # CLAUDE.md backup above.
  require_symlink_safe "$BACKUP_DIR/settings.json.$STAMP"
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
const normalize = value => Array.isArray(value)
  ? value.map(normalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]))
    : value;
const canonical = value => JSON.stringify(normalize(value));
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
    require_symlink_safe "$TARGET/.claude/settings.aigent.json"
    cp "$RENDERED_TMPL" "$TARGET/.claude/settings.aigent.json"
    printf '  [warn] Existing settings.json was not valid JSON or no JSON runtime was available.\n'
    printf '         It was left untouched. Merge .claude/settings.aigent.json manually.\n'
  fi
fi
# settings.json.template is unconditionally regenerated here (not gated on
# `! -e`, unlike every sensitive site above) -- every install run overwrites
# it with SRC's trusted copy, so unlike hooks/skills/agents/rules it can
# never silently keep a planted or stale template. No quarantine logic
# needed; the existing require_symlink_safe guard is sufficient.
if [[ "$(abspath "$SETTINGS_SRC")" != "$(abspath "$TARGET/.claude/settings.json.template")" ]]; then
  require_symlink_safe "$TARGET/.claude/settings.json.template"
  cp "$SETTINGS_SRC" "$TARGET/.claude/settings.json.template"
fi

# skill-index.json drives Caddy's skill auto-invoke hints (rule 12) --
# trusted routing metadata, same sensitivity class as a hook.
if [[ -f "$SRC/.claude/skill-index.json" ]]; then
  copy_missing_file "$SRC/.claude/skill-index.json" "$TARGET/.claude/skill-index.json" 1 || true
fi

safe_mkdir_p "$TARGET/vault/daily" || fail "cannot create $TARGET/vault/daily (see symlink warning above)"
safe_mkdir_p "$TARGET/vault/projects" || fail "cannot create $TARGET/vault/projects (see symlink warning above)"
safe_mkdir_p "$TARGET/vault/people" || fail "cannot create $TARGET/vault/people (see symlink warning above)"
safe_mkdir_p "$TARGET/vault/concepts" || fail "cannot create $TARGET/vault/concepts (see symlink warning above)"
safe_mkdir_p "$TARGET/vault/memory" || fail "cannot create $TARGET/vault/memory (see symlink warning above)"
safe_mkdir_p "$TARGET/.aigent" || fail "cannot create $TARGET/.aigent (see symlink warning above)"

STATE_FILE="$TARGET/.aigent/state.json"
if [[ ! -f "$STATE_FILE" ]]; then
  require_symlink_safe "$STATE_FILE"
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
require_symlink_safe "$GITIGNORE"
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
    # --ignore-scripts (Codex finding #18): disables lifecycle scripts for
    # this package AND every transitive dependency. Without it, installing
    # into a target that already had its own daemons/semantic-search/
    # package.json (or a compromised transitive dependency) could execute
    # an attacker-controlled preinstall/install/postinstall script. The
    # bundled semantic-search package (see package.json) has no lifecycle
    # scripts of its own, so this is a no-op for the legitimate install path.
    if [[ -f package-lock.json ]]; then
      npm ci --silent --ignore-scripts
    else
      npm install --silent --ignore-scripts
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
