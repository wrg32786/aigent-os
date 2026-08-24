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
  --no-deps             Skip Node.js dependencies and managed Auto-Refresh
  --no-launcher         Skip PATH and desktop/Start-menu launcher wiring
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
NO_LAUNCHER=0
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
    --no-launcher)
      NO_LAUNCHER=1
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

COPY_DIRS=(system vault hooks skills daemons scripts docs memory evals launcher)

# ── Symlink-escape guard ──────────────────────────────────────────────────────
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
printf '  Deps:   %s\n' "$([[ "$NO_DEPS" -eq 1 ]] && printf 'skip (unmanaged fallback)' || printf 'managed Auto-Refresh (Node.js 18+ required)')"
printf '  Launch: %s\n' "$([[ "$NO_LAUNCHER" -eq 1 ]] && printf 'files only' || printf 'wire the aigent front door')"

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
  if [[ "$NO_DEPS" -eq 0 ]]; then
    printf '    - install and verify semantic search + managed Auto-Refresh dependencies\n'
  fi
  [[ "$NO_LAUNCHER" -eq 0 ]] && printf '    - wire the aigent command and platform launcher\n'
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
# AIGENT_INSTALL_STAMP override exists only so tests/test-installer-fast.sh can
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
# time Claude Code touches them. For those, a
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
    # The quarantine slot itself is unsafe:
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

unsafeRawPromoteProcedureTree() {
  local source="$1" destination="$2" reason="$3"
  [[ -n "$reason" ]] || fail "unsafeRawPromoteProcedureTree requires a reason"
  copy_missing_tree "$source" "$destination" 1
}

seed_nightly_templates() {
  local template_root="$SRC/daemons/templates/nightly"
  if [[ ! -d "$template_root" ]]; then
    # Older/minimal source fixtures do not ship the close-parity controller and
    # have nothing to seed. A package that does ship the controller must include
    # its canonical templates; continuing in that case would create a guaranteed
    # first-run failure.
    [[ ! -f "$SRC/daemons/nightly-pass.mjs" ]] \
      || fail "nightly templates missing: $template_root"
    return 0
  fi

  safe_mkdir_p "$TARGET/vault/memory/runtime" \
    || fail "cannot create $TARGET/vault/memory/runtime"

  local memory_file
  for memory_file in DREAM_LOG.md MEMORY_CANDIDATES.md SWEEP_LOG.md; do
    copy_missing_file \
      "$template_root/$memory_file" \
      "$TARGET/vault/memory/$memory_file" \
      0 || true
  done

  local runtime_file
  for runtime_file in \
    BELIEF_STATE.jsonl GOAL_STACK.json LESSONS.jsonl \
    NIGHTLY_CAPTURE_CANDIDATES.jsonl PROCEDURES.jsonl SELF_MODEL.json; do
    copy_missing_file \
      "$template_root/runtime/$runtime_file" \
      "$TARGET/vault/memory/runtime/$runtime_file" \
      0 || true
  done

  # These framework-wide runtime files predate the nightly controller. Retain
  # their public templates while keeping nightly's own canonical seeds isolated
  # above so an operational ledger is never copied from a development vault.
  for runtime_file in ACTIVE_STATE.json STATE_EVENTS.jsonl; do
    if [[ -f "$SRC/memory/runtime/$runtime_file" ]]; then
      copy_missing_file \
        "$SRC/memory/runtime/$runtime_file" \
        "$TARGET/vault/memory/runtime/$runtime_file" \
        0 || true
    fi
  done
}

if [[ "$MODE" == "copy" ]]; then
  printf '\n  Copying framework files without overwriting user files...\n'
  launcher_shell="$TARGET/launcher/aigent.sh"
  launcher_shell_missing=0
  [[ -e "$launcher_shell" || -L "$launcher_shell" ]] || launcher_shell_missing=1
  # Seed sanitized canonical inputs before the general vault tree. The normal
  # no-clobber copy then preserves these product templates instead of importing
  # development-vault staging content.
  seed_nightly_templates
  for dir in "${COPY_DIRS[@]}"; do
    [[ -d "$SRC/$dir" ]] || continue
    case "$dir" in
      system)
        unsafeRawPromoteProcedureTree \
          "$SRC/$dir" \
          "$TARGET/$dir" \
          "system documents are reviewed multiline procedures loaded by the operating prompt"
        ;;
      skills)
        unsafeRawPromoteProcedureTree \
          "$SRC/$dir" \
          "$TARGET/$dir" \
          "top-level skill trees are reviewed multiline procedures copied into the installed framework"
        ;;
      hooks|daemons) copy_missing_tree "$SRC/$dir" "$TARGET/$dir" 1 ;;
      *)             copy_missing_tree "$SRC/$dir" "$TARGET/$dir" 0 ;;
    esac
    printf '  [ok] %s/\n' "$dir"
  done
  # Git records this front door as 100644; launcher/install.sh makes it
  # executable too. Restore that contract only for a newly copied file.
  if [[ "$launcher_shell_missing" -eq 1 && -f "$launcher_shell" ]] \
    && path_is_symlink_safe "$launcher_shell"; then
    chmod +x "$launcher_shell"
  fi

else
  printf '\n  Activating this checkout in place; source files already exist.\n'
  seed_nightly_templates
fi

# Manage the aigent-OS portion of CLAUDE.md with explicit markers so reruns do
# not append duplicate copies forever.
START_MARKER='<!-- aigent-os:start -->'
END_MARKER='<!-- aigent-os:end -->'
MANAGED_BLOCK="$AIGENT_TMP/CLAUDE.managed.md"

unsafeRawProcedureFile() {
  local source="$1" reason="$2"
  [[ -n "$reason" ]] || fail "unsafeRawProcedureFile requires a reason"
  cat "$source"
}

unsafeRawInstallProcedureFile() {
  local source="$1" destination="$2" reason="$3"
  [[ -n "$reason" ]] || fail "unsafeRawInstallProcedureFile requires a reason"
  cp "$source" "$destination"
}

unsafeRawPromoteProcedureFile() {
  local source="$1" destination="$2" reason="$3"
  [[ -n "$reason" ]] || fail "unsafeRawPromoteProcedureFile requires a reason"
  copy_missing_file "$source" "$destination" 1
}

{
  printf '%s\n' "$START_MARKER"
  unsafeRawProcedureFile \
    "$SRC/CLAUDE.md" \
    "the framework CLAUDE.md is operator-reviewed multiline procedure text installed verbatim"
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
    unsafeRawInstallProcedureFile \
      "$MANAGED_BLOCK" \
      "$TARGET/CLAUDE.md" \
      "the marker-wrapped framework procedure is intentionally installed with its authored structure"
    printf '  [ok] CLAUDE.md created with managed aigent-OS block\n'
  else
    # STAMP's second-precision backup name is hard but not impossible to
    # predict, so the backup leaf gets the same symlink guard as the primary
    # write.
    require_symlink_safe "$BACKUP_DIR/CLAUDE.md.$STAMP"
    cp "$TARGET/CLAUDE.md" "$BACKUP_DIR/CLAUDE.md.$STAMP"
    CLEAN_CLAUDE="$AIGENT_TMP/CLAUDE.clean.md"
    awk -v start="$START_MARKER" -v end="$END_MARKER" '
      $0 == start { managed = 1; next }
      $0 == end   { managed = 0; next }
      !managed    { print }
    ' "$TARGET/CLAUDE.md" > "$CLEAN_CLAUDE"
    {
      unsafeRawProcedureFile \
        "$CLEAN_CLAUDE" \
        "installer refresh preserves operator-authored multiline text outside managed markers"
      [[ ! -s "$CLEAN_CLAUDE" ]] || printf '\n'
      unsafeRawProcedureFile \
        "$MANAGED_BLOCK" \
        "installer refresh appends the reviewed marker-wrapped framework procedure verbatim"
    } > "$TARGET/CLAUDE.md"
    printf '  [ok] CLAUDE.md managed block refreshed (backup saved)\n'
  fi
fi

safe_mkdir_p "$TARGET/.claude/rules" || fail "cannot create $TARGET/.claude/rules (see symlink warning above)"
safe_mkdir_p "$TARGET/.claude/skills" || fail "cannot create $TARGET/.claude/skills (see symlink warning above)"
safe_mkdir_p "$TARGET/.claude/agents" || fail "cannot create $TARGET/.claude/agents (see symlink warning above)"
# .claude/rules/post-compact-critical.md is operator-owned doctrine, the
# same class as CLAUDE.md's operator text: an existing install carries the
# operator's own rules and the installer must not replace them. Seed the
# framework starter only when the file is absent; an existing file is kept
# as-is (symlink-guarded, like every other single-file write). Keeping it
# gives up quarantine protection against a file planted here before the
# first install — the same accepted tradeoff as CLAUDE.md's free-text
# region, and narrower than hooks/skills/agents, which stay quarantined.
RULES_SRC="$SRC/.claude/rules/post-compact-critical.md"
RULES_DST="$TARGET/.claude/rules/post-compact-critical.md"
if [[ -f "$RULES_SRC" ]]; then
  # Same-file guard, mirroring the settings.json.template check below: in
  # in-place mode SRC and TARGET canonicalize to the same directory, so a
  # blind cp here would target itself and fail hard on BSD/Windows cp.
  if [[ "$(abspath "$RULES_SRC")" != "$(abspath "$RULES_DST")" ]]; then
    require_symlink_safe "$RULES_DST"
    if [[ -f "$RULES_DST" ]]; then
      printf '  [keep] operator rules file kept (%s)\n' "$RULES_DST"
    else
      unsafeRawPromoteProcedureFile \
        "$RULES_SRC" \
        "$RULES_DST" \
        "the post-compact rule starter is reviewed multiline procedure text seeded only into a fresh install" \
        || true
    fi
  fi
fi

# .claude/skills/<name>/ is a directory tree (SKILL.md plus whatever else
# the skill ships), so it reuses copy_missing_tree(sensitive=1) rather than
# copy_missing_file -- same per-file quarantine/symlink handling, walked
# recursively. This is the runtime location Claude Code actually resolves
# slash commands from. The top-level skills/ mirror is procedure-bearing too
# and therefore goes through its own reason-gated promotion above.
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
    unsafeRawPromoteProcedureTree \
      "$skill_dir" \
      "$skill_dst" \
      "skill directories contain reviewed multiline procedures promoted into Claude's runtime"
  done
  shopt -u nullglob
fi
printf '  [ok] Skills: %d new, %d existing directories processed\n' "$skills_new" "$skills_existing"

# .claude/agents/*.md are the dispatchable subagent definitions Claude Code
# loads directly (vault/agents/ is just the docs source) -- trusted content
# exactly like a hook, so sensitive=1 here too.
unsafeRawInstallAgentDefinition() {
  local source="$1" destination="$2" reason="$3"
  [[ -n "$reason" ]] || fail "unsafeRawInstallAgentDefinition requires a reason"
  copy_missing_file "$source" "$destination" 1
}

agents_new=0
if [[ -d "$SRC/vault/agents" ]]; then
  shopt -s nullglob
  for agent_file in "$SRC/vault/agents"/*.md; do
    [[ -f "$agent_file" ]] || continue
    if head -20 "$agent_file" | grep -q '^name:' && head -20 "$agent_file" | grep -q '^tools:'; then
      destination="$TARGET/.claude/agents/$(basename "$agent_file")"
      [[ -f "$destination" ]] || ((agents_new += 1))
      unsafeRawInstallAgentDefinition \
        "$agent_file" \
        "$destination" \
        "agent definitions are operator-authored multiline procedure text promoted into Claude's runtime directory" \
        || true
    fi
  done
  shopt -u nullglob
fi
printf '  [ok] Agents: %d new, existing definitions processed\n' "$agents_new"

SETTINGS_SRC="$SRC/.claude/settings.json.template"
SETTINGS_DST="$TARGET/.claude/settings.json"
RENDERED_TMPL="$AIGENT_TMP/settings.rendered.json"
[[ -f "$SETTINGS_SRC" ]] || fail "missing settings template: $SETTINGS_SRC"

render_settings_template() {
  local source="$1" destination="$2" root="$3"

  if command -v python3 >/dev/null 2>&1; then
    MSYS2_ENV_CONV_EXCL=AIGENT_SETTINGS_RENDER_ROOT \
      AIGENT_SETTINGS_RENDER_ROOT="$root" \
      python3 - "$source" "$destination" <<'PY'
import json
import os
import sys

source, destination = sys.argv[1:3]
root = os.environ["AIGENT_SETTINGS_RENDER_ROOT"]
token = "__AIGENT_ROOT__"
replacements = 0

def shell_double_quoted(value):
    return (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("$", "\\$")
        .replace("`", "\\`")
    )

def replace(value):
    global replacements
    if isinstance(value, str):
        count = value.count(token)
        if not count:
            return value
        replacements += count
        if value == token:
            return root
        return value.replace(token, shell_double_quoted(root))
    if isinstance(value, list):
        return [replace(item) for item in value]
    if isinstance(value, dict):
        if any(token in key for key in value):
            raise ValueError("settings placeholder is not allowed in an object key")
        return {key: replace(item) for key, item in value.items()}
    return value

with open(source, encoding="utf-8") as fh:
    rendered = replace(json.load(fh))
if replacements == 0:
    raise ValueError("settings template contains no __AIGENT_ROOT__ placeholder")
with open(destination, "w", encoding="ascii", newline="\n") as fh:
    json.dump(rendered, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PY
  elif command -v node >/dev/null 2>&1; then
    MSYS2_ENV_CONV_EXCL=AIGENT_SETTINGS_RENDER_ROOT \
      AIGENT_SETTINGS_RENDER_ROOT="$root" \
      node - "$source" "$destination" <<'JS'
const fs = require('fs');
const [source, destination] = process.argv.slice(2);
const root = process.env.AIGENT_SETTINGS_RENDER_ROOT;
const token = '__AIGENT_ROOT__';
let replacements = 0;

const shellDoubleQuoted = value => value
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\$/g, '\\$')
  .replace(/`/g, '\\`');

const replace = value => {
  if (typeof value === 'string') {
    const count = value.split(token).length - 1;
    if (!count) return value;
    replacements += count;
    return value === token
      ? root
      : value.split(token).join(shellDoubleQuoted(root));
  }
  if (Array.isArray(value)) return value.map(replace);
  if (value && typeof value === 'object') {
    if (Object.keys(value).some(key => key.includes(token))) {
      throw new Error('settings placeholder is not allowed in an object key');
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
  }
  return value;
};

const rendered = replace(JSON.parse(fs.readFileSync(source, 'utf8')));
if (!replacements) throw new Error('settings template contains no __AIGENT_ROOT__ placeholder');
const output = (JSON.stringify(rendered, null, 2) + '\n')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
fs.writeFileSync(destination, output, 'utf8');
JS
  else
    printf 'rendering settings.json requires python3 or node\n' >&2
    return 69
  fi
}

render_settings_template "$SETTINGS_SRC" "$RENDERED_TMPL" "$TARGET" \
  || fail "could not render a valid settings template"

require_symlink_safe "$SETTINGS_DST"
if [[ ! -f "$SETTINGS_DST" ]]; then
  cp "$RENDERED_TMPL" "$SETTINGS_DST"
  printf '  [ok] .claude/settings.json created\n'
else
  # Guard the backup leaf for the same reason as the CLAUDE.md backup above.
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

# skill-index.json drives Caddy's skill auto-invoke hints. It is trusted routing
# metadata in the same sensitivity class as a hook.
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
# Managed ignore set: every path a fresh install or normal
# session can generate under TARGET needs an entry here, not just the .aigent/
# state directory -- the prompt journal (utterance-journal*.jsonl, rotated
# sidecars included), the semantic-search node_modules/ the deps step below
# can npm-install, an Obsidian .obsidian/ workspace dir once TARGET's vault/
# is opened as a vault, and the settings.local.json Claude Code itself writes
# for machine-local overrides. The semantic-search index-deny.json belongs here
# too: it is hand-written rather than generated, but it names the operator's own
# confidential folders, so it must never be committable from TARGET. Same
# treatment for namespace-registry.local.json (issue #48): the seat-owned
# extension registry, hand-written and never generated.
cat > "$GI_BLOCK" <<EOF_GI
$GI_START
.aigent/
vault/memory/embeddings.json
vault/memory/HEAT_INDEX.json
vault/memory/HEAT_INDEX.json.tmp-*
vault/memory/.daemon-errors.log
memory/.daemon-errors.log
.claude/settings.aigent.json
.claude/settings.local.json
**/runtime/utterance-journal*.jsonl
**/runtime/stop-writer/
**/runtime/NIGHTLY_PASS_STATE.json
**/semantic-search/index-deny.json
**/semantic-search/namespace-registry.local.json
node_modules/
.obsidian/
$GI_END
EOF_GI
require_symlink_safe "$GITIGNORE"
if [[ -f "$GITIGNORE" ]]; then
  # Marker validation: the awk strip below turns "managed"
  # on at the first start marker and off at the first end marker, printing
  # everything else. A malformed marker pair -- a stray extra start/end line
  # from a hand edit or a bad merge, or the two out of order -- makes that
  # toggle land wrong for the rest of the file, silently deleting whatever
  # hand-written rules follow. Refuse to touch the file rather than guess.
  start_count="$(grep -c -F -x "$GI_START" "$GITIGNORE" || true)"
  end_count="$(grep -c -F -x "$GI_END" "$GITIGNORE" || true)"
  if [[ "$start_count" -gt 1 || "$end_count" -gt 1 || "$start_count" != "$end_count" ]]; then
    fail "$GITIGNORE has a malformed aigent-os managed block (found $start_count start marker(s), $end_count end marker(s)) -- refusing to edit it automatically. Remove the stray '$GI_START' / '$GI_END' line(s) by hand, then re-run."
  fi
  if [[ "$start_count" -eq 1 ]]; then
    start_line="$(grep -n -F -x "$GI_START" "$GITIGNORE" | head -1 | cut -d: -f1)"
    end_line="$(grep -n -F -x "$GI_END" "$GITIGNORE" | head -1 | cut -d: -f1)"
    if [[ "$start_line" -gt "$end_line" ]]; then
      fail "$GITIGNORE has an aigent-os managed block with the end marker before the start marker -- refusing to edit it automatically. Fix the marker order by hand, then re-run."
    fi
  fi

  # As with the CLAUDE.md and settings.json backups, a validated block is
  # backed up before strip/rewrite so the edit remains recoverable.
  require_symlink_safe "$BACKUP_DIR/.gitignore.$STAMP"
  cp "$GITIGNORE" "$BACKUP_DIR/.gitignore.$STAMP"

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
  printf '  [skip] Node.js dependencies (--no-deps); managed Auto-Refresh may be unavailable\n'
else
  command -v node >/dev/null 2>&1 \
    || fail "Node.js 18+ is required for the default managed Auto-Refresh install. Install Node.js and rerun, or pass --no-deps for the unmanaged fallback."
  command -v npm >/dev/null 2>&1 \
    || fail "npm is required for the default managed Auto-Refresh install. Install Node.js with npm and rerun, or pass --no-deps."

  NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || ((NODE_MAJOR < 18)); then
    fail "Node.js 18+ is required for managed Auto-Refresh; found $(node --version). Upgrade Node.js or pass --no-deps for the unmanaged fallback."
  fi

  # Two independent dependency roots: semantic search and the managed PTY transport.
  for DEP_DIR in semantic-search transport-deps; do
    if [[ ! -f "$TARGET/daemons/$DEP_DIR/package.json" ]]; then
      printf '  [skip] No %s package found\n' "$DEP_DIR"
      continue
    fi
    printf '  Installing %s dependencies (network access may occur)...\n' "$DEP_DIR"
    pushd "$TARGET/daemons/$DEP_DIR" >/dev/null
    if [[ -f package-lock.json ]]; then
      npm ci --silent --ignore-scripts
    else
      npm install --silent --ignore-scripts
    fi
    if [[ "$DEP_DIR" == "transport-deps" ]]; then
      npm rebuild --silent node-pty \
        || fail "node-pty failed to build. Install platform build tools and rerun, or pass --no-deps for the unmanaged fallback."
    fi
    popd >/dev/null
    printf '  [ok] %s dependencies installed\n' "$DEP_DIR"
  done

  if ! node -e '
const { createRequire } = require("node:module");
createRequire(process.argv[1])("node-pty");
' "$TARGET/daemons/transport-deps/package.json"; then
    fail "node-pty installed but could not load. Fix the reported native dependency error and rerun, or pass --no-deps for the unmanaged fallback."
  fi
  printf '  [ok] Managed Auto-Refresh runner verified\n'
fi

wire_aigent_front_door() {
  # Minimal installer fixtures intentionally omit launcher/. The real product tree ships it.
  [[ -d "$SRC/launcher" ]] || return 0

  [[ -f "$TARGET/launcher/aigent.sh" && -f "$TARGET/launcher/aigent.ps1" ]] \
    || fail "managed launcher files are missing from $TARGET/launcher"

  if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* || -n "${WINDIR:-}" ]]; then
    local powershell=""
    if command -v pwsh >/dev/null 2>&1; then
      powershell="pwsh"
    elif command -v powershell.exe >/dev/null 2>&1; then
      powershell="powershell.exe"
    else
      fail "PowerShell is required to wire the Windows aigent command and shortcuts"
    fi
    [[ -f "$TARGET/launcher/install.ps1" ]] \
      || fail "missing Windows launcher installer: $TARGET/launcher/install.ps1"
    "$powershell" -NoLogo -NoProfile -ExecutionPolicy Bypass \
      -File "$TARGET/launcher/install.ps1" -AigentHome "$TARGET"
  else
    [[ -f "$TARGET/launcher/install.sh" ]] \
      || fail "missing launcher installer: $TARGET/launcher/install.sh"
    bash "$TARGET/launcher/install.sh" "$TARGET"
  fi
  printf '  [ok] aigent command and platform launcher wired\n'
}

if [[ "$NO_LAUNCHER" -eq 1 ]]; then
  printf '  [skip] Launcher wiring (--no-launcher)\n'
else
  wire_aigent_front_door
fi

printf '\n  ========================================\n'
if [[ "$NO_DEPS" -eq 1 ]]; then
  printf '  [ok] aigent-OS is ready (Node dependencies skipped)\n'
else
  printf '  [ok] aigent-OS is ready with managed Auto-Refresh\n'
fi
printf '  ========================================\n\n'
printf '  Next:\n'
if [[ "$NO_LAUNCHER" -eq 1 ]]; then
  printf '    Launcher wiring was skipped. Start through launcher/aigent.sh or launcher/aigent.ps1.\n\n'
else
  printf '    Open a new terminal and run: aigent\n'
  printf '    On Windows or macOS, you can also open the AIgent app/shortcut.\n\n'
fi

# Reached only on a successful install: the script runs under `set -Eeuo pipefail`,
# so any earlier failure aborts before this point.
printf '  If aigent-OS saves you time, a star helps other people find it:\n'
printf '    https://github.com/wrg32786/aigent-os\n\n'
