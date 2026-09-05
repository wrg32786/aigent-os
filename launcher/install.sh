#!/usr/bin/env bash
# install.sh: wire up the `aigent` command on macOS / Linux.
# Run once (the harness installer calls it after cloning). Symlinks the launcher
# into ~/.local/bin and records AIGENT_HOME in the shell profile.
#
# Usage:  bash install.sh "/Users/<you>/aigent"

set -euo pipefail
AIGENT_HOME="${1:-$HOME/aigent}"
# Keep the launcher and rendered settings on the same physical root spelling
# across aliases such as macOS /var and Git Bash /tmp.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

validate_profile_home() {
  local value="$1"
  [ -n "$value" ] || return 1

  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$value" | PYTHONIOENCODING=utf-8 python3 -c '
import re
import sys

value = sys.stdin.read()
raise SystemExit(1 if re.search(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", value) else 0)
'
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$value" | node -e '
const fs = require("fs");
const value = fs.readFileSync(0, "utf8");
process.exit(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ? 1 : 0);
'
  else
    # The settings renderer below also requires Python or Node. Keep this
    # fallback conservative so profile safety never depends on a missing
    # runtime.
    printf '%s' "$value" | LC_ALL=C grep -q '[^ -~]' && return 1
  fi
}

if ! validate_profile_home "$AIGENT_HOME"; then
  printf 'refusing AIGENT_HOME with an empty value or line-breaking/control characters\n' >&2
  exit 64
fi

# ── Harness setup (must run BEFORE symlink/PATH wiring) ──────────────────────
ROOT="$(cd "$here/.." && pwd -P)"   # repo root = parent of launcher/

# H1. Populate .claude/skills/ from skills/
skills_src="$ROOT/skills"
skills_dst="$ROOT/.claude/skills"
mkdir -p "$skills_dst"

unsafeRawInstallSkillTree() {
  local source="$1" destination="$2" reason="$3"
  [ -n "$reason" ] || {
    printf 'unsafeRawInstallSkillTree requires a reason\n' >&2
    return 64
  }
  cp -r "$source" "$destination"
}

if [ -d "$skills_src" ]; then
  for dir in "$skills_src"/*/; do
    name="$(basename "$dir")"
    if [ -f "$dir/SKILL.md" ] && [ ! -d "$skills_dst/$name" ]; then
      unsafeRawInstallSkillTree \
        "$dir" \
        "$skills_dst/$name" \
        "launcher installation promotes reviewed multiline skill procedures into Claude's runtime"
      echo "  [harness] skill copied: $name"
    fi
  done
fi

# H2. Render .claude/settings.json from template
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

tpl="$ROOT/.claude/settings.json.template"
json="$ROOT/.claude/settings.json"
if [ -L "$json" ]; then
  printf 'refusing to replace symlinked settings file: %s\n' "$json" >&2
  exit 1
fi
if [ -e "$json" ] && [ ! -f "$json" ]; then
  printf 'refusing non-file settings destination: %s\n' "$json" >&2
  exit 1
fi
if [ -f "$tpl" ] && [ ! -e "$json" ]; then
  rendered="$(mktemp "$ROOT/.claude/.settings.json.XXXXXX")"
  if ! render_settings_template "$tpl" "$rendered" "$ROOT"; then
    rm -f "$rendered"
    printf 'failed to render a valid .claude/settings.json\n' >&2
    exit 1
  fi
  mv "$rendered" "$json"
  echo "  [harness] settings.json rendered ($ROOT)"
fi

# H3. Vault runtime folders. The memory folder is wherever the seat declares
# it (daemons/memory-root.cjs, default vault/memory), so a seat with a declared
# root never grows a dead default tree beside its live one.
for folder in vault/daily vault/projects vault/people vault/concepts; do
  mkdir -p "$ROOT/$folder"
done
if [ -f "$here/../daemons/memory-root.sh" ]; then
  . "$here/../daemons/memory-root.sh"
  if ! MEMORY_REL="$(aigent_memory_root "$ROOT" --relative --allow-missing 2>&1)"; then
    printf '%s\n' "$MEMORY_REL" >&2
    exit 1
  fi
elif grep -q '"memory_root"' "$ROOT/.aigent/state.json" 2>/dev/null; then
  printf 'MEMORY-ROOT: %s declares memory_root but this tree has no daemons/memory-root.sh to resolve it\n' "$ROOT/.aigent/state.json" >&2
  exit 1
else
  MEMORY_REL="vault/memory" # memory-root: no-node default
fi
mkdir -p "$ROOT/$MEMORY_REL"
echo "  [harness] vault folders ensured"
# ─────────────────────────────────────────────────────────────────────────────

chmod +x "$here/aigent.sh"

# Mode-bit diffs from the chmod above must never block the operator's `git pull`.
git -C "$ROOT" config core.fileMode false 2>/dev/null || true

bin="$HOME/.local/bin"
mkdir -p "$bin"
ln -sf "$here/aigent.sh" "$bin/aigent"

# Record AIGENT_HOME + ensure ~/.local/bin is on PATH, idempotently.
profile="$HOME/.zshrc"; [ -n "${BASH_VERSION:-}" ] && profile="$HOME/.bashrc"
printf -v quoted_home '%q' "$AIGENT_HOME"
line_home="export AIGENT_HOME=$quoted_home"
line_path='export PATH="$HOME/.local/bin:$PATH"'
grep -qsF "$line_home" "$profile" || printf '%s\n' "$line_home" >> "$profile"
grep -qsF "$line_path" "$profile" || printf '%s\n' "$line_path" >> "$profile"

# ── macOS: create a clickable, Spotlight-searchable AIgent.app ───────────────
if [[ "$OSTYPE" == darwin* ]]; then

  APP="$HOME/Applications/AIgent.app"
  MACOS_DIR="$APP/Contents/MacOS"
  RES_DIR="$APP/Contents/Resources"

  # Idempotent: always rebuild the bundle from scratch.
  rm -rf "$APP"
  mkdir -p "$HOME/Applications" "$MACOS_DIR" "$RES_DIR"

  # -- Info.plist ---------------------------------------------------------------
  cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>             <string>AIgent</string>
  <key>CFBundleDisplayName</key>      <string>AIgent</string>
  <key>CFBundleExecutable</key>       <string>AIgent</string>
  <key>CFBundleIdentifier</key>       <string>com.theaigent.launcher</string>
  <key>CFBundlePackageType</key>      <string>APPL</string>
  <key>CFBundleVersion</key>          <string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleIconFile</key>         <string>AIgent</string>
  <key>LSMinimumSystemVersion</key>   <string>11.0</string>
</dict>
</plist>
PLIST

  # -- Executable ---------------------------------------------------------------
  # Opens a fresh Terminal window and runs `aigent`. The osascript approach
  # loads the user's full login shell (PATH / .zshrc) so `aigent` is always found.
  cat > "$MACOS_DIR/AIgent" << 'EXEC'
#!/bin/bash
osascript \
  -e 'tell application "Terminal" to do script "aigent"' \
  -e 'tell application "Terminal" to activate'
EXEC
  chmod +x "$MACOS_DIR/AIgent"

  # -- Icon (best-effort; NEVER fatal) -----------------------------------------
  # Produces an .icns from the best square-ish PNG we can find in the repo.
  # Every step is wrapped so failure is silent and the install continues.
  _make_icns() {
    local src="$1"   # path to a source PNG
    local dst="$2"   # destination path WITHOUT .icns extension

    # Approach A: iconutil iconset (highest fidelity; sips is always present).
    # The iconset lives INSIDE the mktemp-reserved directory: appending
    # ".iconset" to the reserved name would create an unreserved sibling and
    # leak the reserved dir itself.
    local tmpdir iconset
    tmpdir="$(mktemp -d 2>/dev/null)" || return 1
    iconset="$tmpdir/AIgent.iconset"
    mkdir -p "$iconset" || { rm -rf "$tmpdir"; return 1; }
    local sz
    for sz in 16 32 64 128 256 512; do
      sips -z "$sz" "$sz" "$src" --out "$iconset/icon_${sz}x${sz}.png"        2>/dev/null || true
      sips -z "$((sz*2))" "$((sz*2))" "$src" \
           --out "$iconset/icon_${sz}x${sz}@2x.png"                           2>/dev/null || true
    done
    if iconutil -c icns "$iconset" -o "${dst}.icns" 2>/dev/null; then
      rm -rf "$tmpdir"
      return 0
    fi
    rm -rf "$tmpdir"

    # Approach B: sips direct-to-icns (works on most macOS versions).
    sips -s format icns "$src" --out "${dst}.icns" 2>/dev/null && return 0

    return 1
  }

  # Candidate search: prefer files likely to be square (logo / touch-icon).
  # Checked in order; first hit wins.
  _icns_src=""
  for _candidate in \
      "$here/aigent-icon.png" \
      "$here/icon.png" \
      "$ROOT/assets/apple-touch-icon.png" \
      "$ROOT/assets/icon.png" \
      "$ROOT/assets/logo.png" \
      "$ROOT/assets/social-preview.png" \
      "$ROOT/assets/banner.png"; do
    if [[ -f "$_candidate" ]]; then
      _icns_src="$_candidate"
      break
    fi
  done

  if [[ -n "$_icns_src" ]]; then
    _make_icns "$_icns_src" "$RES_DIR/AIgent" 2>/dev/null || true
    if [[ -f "$RES_DIR/AIgent.icns" ]]; then
      echo "  [app] icon built from: $_icns_src"
    else
      echo "  [app] icon conversion skipped — using macOS generic icon (non-fatal)"
    fi
  else
    echo "  [app] no icon source found — using macOS generic icon (non-fatal)"
  fi

  # -- Spotlight indexing -------------------------------------------------------
  # touch updates mtime so fseventsd picks up the new bundle quickly.
  # mdimport forces an immediate metadata import; guard in case path varies.
  touch "$APP" 2>/dev/null || true
  /usr/bin/mdimport "$APP" 2>/dev/null || true

  echo "AIgent installed. Open it 3 ways:"
  echo "  (1) Spotlight  — press Cmd+Space, type \"AIgent\", press Enter"
  echo "  (2) Finder     — double-click AIgent in your ~/Applications folder"
  echo "  (3) Terminal   — type: aigent"

else
  # Linux / other POSIX
  echo "AIgent installed. Open a new terminal and type: aigent"
fi
# ─────────────────────────────────────────────────────────────────────────────
