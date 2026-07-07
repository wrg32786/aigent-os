#!/usr/bin/env bash
# install.sh: wire up the `aigent` command on macOS / Linux.
# Run once (the harness installer calls it after cloning). Symlinks the launcher
# into ~/.local/bin and records AIGENT_HOME in the shell profile.
#
# Usage:  bash install.sh "/Users/<you>/aigent"

set -euo pipefail
AIGENT_HOME="${1:-$HOME/aigent}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Harness setup (must run BEFORE symlink/PATH wiring) ──────────────────────
ROOT="$(cd "$here/.." && pwd)"   # repo root = parent of launcher/

# H1. Populate .claude/skills/ from skills/
skills_src="$ROOT/skills"
skills_dst="$ROOT/.claude/skills"
mkdir -p "$skills_dst"
if [ -d "$skills_src" ]; then
  for dir in "$skills_src"/*/; do
    name="$(basename "$dir")"
    if [ -f "$dir/SKILL.md" ] && [ ! -d "$skills_dst/$name" ]; then
      cp -r "$dir" "$skills_dst/$name"
      echo "  [harness] skill copied: $name"
    fi
  done
fi

# H2. Render .claude/settings.json from template
tpl="$ROOT/.claude/settings.json.template"
json="$ROOT/.claude/settings.json"
if [ -f "$tpl" ] && [ ! -f "$json" ]; then
  sed "s|AIGENT_ROOT|$ROOT|g" "$tpl" > "$json"
  echo "  [harness] settings.json rendered ($ROOT)"
fi

# H3. Vault runtime folders
for folder in vault/daily vault/projects vault/people vault/concepts vault/memory; do
  mkdir -p "$ROOT/$folder"
done
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
line_home="export AIGENT_HOME=\"$AIGENT_HOME\""
line_path='export PATH="$HOME/.local/bin:$PATH"'
grep -qsF "$line_home" "$profile" || echo "$line_home" >> "$profile"
grep -qsF "$line_path" "$profile" || echo "$line_path" >> "$profile"

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
    local iconset
    iconset="$(mktemp -d 2>/dev/null).iconset" || return 1
    mkdir -p "$iconset" || { rm -rf "$iconset"; return 1; }
    local sz
    for sz in 16 32 64 128 256 512; do
      sips -z "$sz" "$sz" "$src" --out "$iconset/icon_${sz}x${sz}.png"        2>/dev/null || true
      sips -z "$((sz*2))" "$((sz*2))" "$src" \
           --out "$iconset/icon_${sz}x${sz}@2x.png"                           2>/dev/null || true
    done
    if iconutil -c icns "$iconset" -o "${dst}.icns" 2>/dev/null; then
      rm -rf "$iconset"
      return 0
    fi
    rm -rf "$iconset"

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
