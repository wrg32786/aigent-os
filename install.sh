#!/bin/bash
# aigent-OS Installer
# Installs into the current directory. Run from wherever you work.

set -e

AIGENT_TMP=$(mktemp -d)
TARGET="${1:-.}"
NO_DEPS=0
for arg in "$@"; do
  [ "$arg" = "--no-deps" ] && NO_DEPS=1
done

echo ""
echo "  +------------------------------------+"
echo "  |   aigent-OS -- AI Operating System  |"
echo "  +------------------------------------+"
echo ""

# Check if already installed
if [ -d "$TARGET/system" ] && [ -f "$TARGET/system/00_identity.md" ]; then
  echo "  aigent-OS is already installed in this directory."
  echo "  To reinstall, remove the system/ directory first."
  exit 0
fi

echo "  Installing into: $(cd "$TARGET" && pwd)"
echo ""

# Locate source files. Run this script from inside the unzipped aigent-OS folder
# (the folder that contains system/, vault/, skills/, etc.). If AIGENT_SRC is set
# to a valid checkout path, that takes priority (useful for dev/CI installs).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "$AIGENT_SRC" ] && [ -f "$AIGENT_SRC/system/00_identity.md" ]; then
  echo "  Using source: $AIGENT_SRC"
  SRC="$AIGENT_SRC"
elif [ -f "$SCRIPT_DIR/system/00_identity.md" ]; then
  echo "  Using source: $SCRIPT_DIR"
  SRC="$SCRIPT_DIR"
else
  echo ""
  echo "  ERROR: Cannot locate aigent-OS source files."
  echo "  Run this script from inside the unzipped aigent-OS folder."
  echo "  Example: cd ~/aigent-os && bash install.sh"
  exit 1
fi

# Copy framework files (no-clobber: never force-overwrite a user's existing files)
echo "  Copying framework..."
for d in system vault hooks skills daemons scripts docs; do
  cp -rn "$SRC/$d" "$TARGET/" 2>/dev/null || true
done

# Handle CLAUDE.md -- append if exists, create if not
if [ -f "$TARGET/CLAUDE.md" ]; then
  echo ""
  echo "  Found existing CLAUDE.md -- appending aigent-OS config."
  echo "" >> "$TARGET/CLAUDE.md"
  echo "---" >> "$TARGET/CLAUDE.md"
  echo "" >> "$TARGET/CLAUDE.md"
  cat "$SRC/CLAUDE.md" >> "$TARGET/CLAUDE.md"
else
  cp "$SRC/CLAUDE.md" "$TARGET/"
fi
echo "  [ok] CLAUDE.md configured"

# Handle .claude directory -- including skills runtime path (Claude Code reads from .claude/skills/)
mkdir -p "$TARGET/.claude/rules"
mkdir -p "$TARGET/.claude/skills"
cp -n "$SRC/.claude/rules/post-compact-critical.md" "$TARGET/.claude/rules/" 2>/dev/null || true

# Copy skills into .claude/skills/ so Claude Code can resolve slash commands at runtime
# skills/ in the repo are source templates; .claude/skills/ is where they fire
# No-clobber: a user's same-named skill is kept (and reported), never overwritten.
skills_new=0; skills_kept=0
for skill_dir in "$SRC/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  [ -f "$skill_dir/SKILL.md" ] || continue
  if [ ! -d "$TARGET/.claude/skills/$skill_name" ]; then
    cp -r "$skill_dir" "$TARGET/.claude/skills/$skill_name"; skills_new=$((skills_new + 1))
  else
    skills_kept=$((skills_kept + 1))
  fi
done
if [ "$skills_kept" -gt 0 ]; then
  echo "  [ok] Skills: $skills_new installed, $skills_kept kept (you already had same-named skills)"
else
  echo "  [ok] Skills installed to .claude/skills/ ($skills_new) -- slash commands ready"
fi

# Register the Pantheon as dispatchable Claude Code subagents.
# vault/agents/ holds them as Obsidian docs for the knowledge graph; Claude Code only
# loads dispatchable agents from .claude/agents/. Without this step the operator reads
# "delegate to Lyra / Iris / Hypatia / Echo" in CLAUDE.md but has no agents to spawn,
# so it does every task itself instead of routing to the team. Copy only files that
# carry real agent frontmatter (name: + tools:) so roster/index docs are never mistaken
# for agents.
mkdir -p "$TARGET/.claude/agents"
for agent_file in "$SRC/vault/agents/"*.md; do
  [ -f "$agent_file" ] || continue
  if head -20 "$agent_file" | grep -q '^name:' && head -20 "$agent_file" | grep -q '^tools:'; then
    cp -n "$agent_file" "$TARGET/.claude/agents/$(basename "$agent_file")" 2>/dev/null || true
  fi
done
echo "  [ok] Pantheon agents registered to .claude/agents/ (delegation ready)"

# Create or MERGE settings.json. AIGENT_ROOT placeholder -> actual install path.
# Brownfield: an existing settings.json is DEEP-MERGED, never skipped -- skipping means the
# operator's hooks/caddy/somatic layer silently never wire for anyone who already runs Claude.
INSTALL_PATH="$(cd "$TARGET" && pwd)"
SETTINGS_SRC="$SRC/.claude/settings.json.template"
SETTINGS_DST="$TARGET/.claude/settings.json"
RENDERED_TMPL="$AIGENT_TMP/settings.rendered.json"
sed "s|__AIGENT_ROOT__|$INSTALL_PATH|g" "$SETTINGS_SRC" > "$RENDERED_TMPL"

if [ ! -f "$SETTINGS_DST" ]; then
  cp "$RENDERED_TMPL" "$SETTINGS_DST"
  echo "  [ok] settings.json created (AIGENT_ROOT -> $INSTALL_PATH)"
else
  BACKUP="$SETTINGS_DST.aigent-bak.$(date +%Y%m%d%H%M%S)"
  cp "$SETTINGS_DST" "$BACKUP"
  MERGED="$AIGENT_TMP/settings.merged.json"
  cat > "$AIGENT_TMP/merge-settings.cjs" <<'MERGE_EOF'
const fs = require('fs');
const [,, basePath, addPath, outPath] = process.argv;
const read = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return undefined; } };
const base = read(basePath), add = read(addPath);
if (add === undefined) process.exit(3);
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const uniq = (a, b) => { const o = a.slice(); for (const it of b) { const s = JSON.stringify(it); if (!o.some(x => JSON.stringify(x) === s)) o.push(it); } return o; };
const merge = (b, a) => {
  if (Array.isArray(b) && Array.isArray(a)) return uniq(b, a);
  if (isObj(b) && isObj(a)) { const o = { ...b }; for (const k of Object.keys(a)) o[k] = (k in b) ? merge(b[k], a[k]) : a[k]; return o; }
  return b === undefined ? a : b;
};
const result = (base === undefined) ? add : merge(base, add);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
MERGE_EOF
  if command -v node >/dev/null 2>&1 && node "$AIGENT_TMP/merge-settings.cjs" "$SETTINGS_DST" "$RENDERED_TMPL" "$MERGED" 2>/dev/null && [ -s "$MERGED" ]; then
    mv "$MERGED" "$SETTINGS_DST"
    echo "  [ok] settings.json MERGED with your existing config (backup: $(basename "$BACKUP"))"
  else
    echo "  [!] Could not auto-merge settings.json (node missing or invalid JSON)."
    echo "      Your file is untouched. Merge aigent-OS's hooks/permissions/env in from:"
    echo "      $RENDERED_TMPL"
  fi
fi
cp -n "$SETTINGS_SRC" "$TARGET/.claude/" 2>/dev/null || true

# Copy skill-index.json so Caddy enrollment works on fresh install
if [ ! -f "$TARGET/.claude/skill-index.json" ]; then
  cp "$SRC/.claude/skill-index.json" "$TARGET/.claude/skill-index.json"
fi
echo "  [ok] Claude Code config ready"

# Create required vault runtime folders (empty dirs for daily notes, projects, people, concepts, memory)
mkdir -p "$TARGET/vault/daily"
mkdir -p "$TARGET/vault/projects"
mkdir -p "$TARGET/vault/people"
mkdir -p "$TARGET/vault/concepts"
mkdir -p "$TARGET/vault/memory"
echo "  [ok] Vault runtime folders created"

# Install semantic search (skip with --no-deps)
if [ "$NO_DEPS" -eq 0 ] && [ -f "$TARGET/daemons/semantic-search/package.json" ]; then
  echo "  Installing semantic search (local embeddings)..."
  cd "$TARGET/daemons/semantic-search" && npm install --silent 2>/dev/null && cd - > /dev/null
  echo "  [ok] Semantic search ready"
elif [ "$NO_DEPS" -eq 1 ]; then
  echo "  Skipping npm install (--no-deps)"
fi

# Cleanup
rm -rf "$AIGENT_TMP"

echo ""
echo "  ========================================"
echo "  [ok] aigent-OS installed!"
echo "  ========================================"
echo ""
echo "  What happens next:"
echo ""
echo "  1. Open Claude Code in this directory."
echo "  2. Type /open -- your operator boots, loads your context,"
echo "     and tells you exactly what to do. Run this every session."
echo "  3. When you're done, type /close -- it saves everything"
echo "     so next time /open resumes clean."
echo ""
echo "  RECOMMENDED (first session):"
echo "  Run /statusline in Claude Code and enable context usage."
echo "  That adds a live token counter so you can see your context"
echo "  filling. When it gets heavy, /close + start fresh + /open."
echo ""
echo "  Optional: Open the vault/ folder in Obsidian"
echo "  to see your AI's knowledge graph."
echo ""
