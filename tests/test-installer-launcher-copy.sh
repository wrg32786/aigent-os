#!/usr/bin/env bash
# Copy-mode regression: the installed tree must contain both managed launcher
# front doors, with the POSIX launcher executable on filesystems that record
# executable permission bits.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

FIXTURE="$WORK/source"
mkdir -p "$FIXTURE"/{system,vault/agents,skills/demo,hooks,daemons/semantic-search,scripts,docs,memory,evals,launcher,.claude/rules}
cp "$ROOT/install.sh" "$FIXTURE/install.sh"
printf '# Identity\n' > "$FIXTURE/system/00_identity.md"
printf '# Claude source\n' > "$FIXTURE/CLAUDE.md"
printf '%s\n' '---' 'name: demo' '---' > "$FIXTURE/skills/demo/SKILL.md"
printf '%s\n' '---' 'name: scout' 'tools: [Read]' '---' > "$FIXTURE/vault/agents/scout.md"
printf '# critical\n' > "$FIXTURE/.claude/rules/post-compact-critical.md"
cat > "$FIXTURE/.claude/settings.json.template" <<'JSON'
{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__","AIGENT_VAULT":"__AIGENT_ROOT__"},"statusLine":{"type":"command","command":"bash \"__AIGENT_ROOT__/daemons/statusline-ctx.sh\""},"hooks":{"SessionEnd":[]}}
JSON
printf '[]\n' > "$FIXTURE/.claude/skill-index.json"
printf '{"name":"semantic-search","version":"1.0.0"}\n' > "$FIXTURE/daemons/semantic-search/package.json"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE/daemons/statusline-ctx.sh"
printf '#!/bin/sh\necho "trusted"\n' > "$FIXTURE/hooks/example-hook.sh"
cp "$ROOT/launcher/aigent.sh" "$FIXTURE/launcher/aigent.sh"
cp "$ROOT/launcher/aigent.ps1" "$FIXTURE/launcher/aigent.ps1"

TARGET="$WORK/copy-target"
(
  cd "$FIXTURE"
  bash install.sh --target "$TARGET" --no-deps >/dev/null
)

test -f "$TARGET/launcher/aigent.sh" \
  || fail "copy install omitted launcher/aigent.sh"
test -f "$TARGET/launcher/aigent.ps1" \
  || fail "copy install omitted launcher/aigent.ps1"
test -x "$TARGET/launcher/aigent.sh" \
  || fail "copy-installed launcher/aigent.sh is not executable"

printf '[1/1] copy install ships executable shell and PowerShell launchers\n'
printf 'launcher copy installer suite passed (1/1)\n'
