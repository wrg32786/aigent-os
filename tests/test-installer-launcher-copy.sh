#!/usr/bin/env bash
# Default-install regression: the ordinary one-command path verifies the managed
# runner and invokes the copied platform front-door installer.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

FIXTURE="$WORK/source"
mkdir -p "$FIXTURE"/{system,vault/agents,skills/demo,hooks,daemons/semantic-search,daemons/transport-deps,scripts,docs,memory,evals,launcher,.claude/rules}
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
printf '{"name":"transport-deps","version":"1.0.0"}\n' > "$FIXTURE/daemons/transport-deps/package.json"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE/daemons/statusline-ctx.sh"
printf '#!/bin/sh\necho "trusted"\n' > "$FIXTURE/hooks/example-hook.sh"
cp "$ROOT/launcher/aigent.sh" "$FIXTURE/launcher/aigent.sh"
cp "$ROOT/launcher/aigent.ps1" "$FIXTURE/launcher/aigent.ps1"

cat > "$FIXTURE/launcher/install.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p "$1/.aigent"
printf '%s\n' "$1" > "$1/.aigent/launcher-wired"
SH
cat > "$FIXTURE/launcher/install.ps1" <<'PS1'
param([string]$AigentHome)
New-Item -ItemType Directory -Force (Join-Path $AigentHome '.aigent') | Out-Null
Set-Content -Encoding ascii (Join-Path $AigentHome '.aigent\launcher-wired') $AigentHome
PS1

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/node" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf 'v20.0.0\n'
fi
exit 0
SH
cat > "$FAKE_BIN/npm" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$FAKE_BIN/node" "$FAKE_BIN/npm"

TARGET="$WORK/copy-target"
(
  cd "$FIXTURE"
  PATH="$FAKE_BIN:$PATH" bash install.sh --target "$TARGET" > "$WORK/install.out"
)

test -f "$TARGET/launcher/aigent.sh" \
  || fail "copy install omitted launcher/aigent.sh"
test -f "$TARGET/launcher/aigent.ps1" \
  || fail "copy install omitted launcher/aigent.ps1"
test -x "$TARGET/launcher/aigent.sh" \
  || fail "copy-installed launcher/aigent.sh is not executable"
test -f "$TARGET/.aigent/launcher-wired" \
  || fail "default installer did not invoke platform launcher wiring"
grep -F 'Managed Auto-Refresh runner verified' "$WORK/install.out" >/dev/null \
  || fail "default installer did not verify the managed runner"
grep -F 'Open a new terminal and run: aigent' "$WORK/install.out" >/dev/null \
  || fail "installer did not finish with the one-command front door"

printf '[1/1] default install verifies managed runner and wires the aigent front door\n'
printf 'launcher copy installer suite passed (1/1)\n'
