#!/usr/bin/env bash
# The installer retires hooks the template no longer ships (2026-11-05: Caddy).
# The settings merge only ever ADDED template hooks and replaced ones with the same identity, so a
# hook removed from the template stayed wired in every existing install forever. Caddy's two hooks
# (daemons/caddy.sh on every prompt, daemons/caddy-detect-new-skill.sh after every Write/Edit) are
# named in a retired set and dropped on merge. An operator's own hooks are never touched.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
TOTAL=7
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

FIXTURE="$WORK/src"
mkdir -p "$FIXTURE"/{system,vault,hooks,daemons,scripts,docs,memory,evals,.claude}
cp "$ROOT/install.sh" "$FIXTURE/install.sh"
cp "$ROOT/daemons/memory-root.sh" "$ROOT/daemons/memory-root.cjs" "$FIXTURE/daemons/"
cp "$ROOT/.claude/settings.json.template" "$FIXTURE/.claude/settings.json.template"
cp "$ROOT/scripts/fleet-baseline-manifest.json" "$FIXTURE/scripts/"
printf '# Identity\n' > "$FIXTURE/system/00_identity.md"
printf '# Claude source\n' > "$FIXTURE/CLAUDE.md"

# The mergers resolve the settings path to a native path, so on Git Bash the fixture must use one
# too: a /tmp/... spelling is not this install's path, and the hook would rightly be kept.
TARGET="$WORK/target"
mkdir -p "$TARGET/.claude"
if command -v cygpath >/dev/null 2>&1; then TARGET="$(cygpath -m "$TARGET")"; fi
# An install from before the retirement: both Caddy hooks wired, plus the operator's own hook.
cat > "$TARGET/.claude/settings.json" <<JSON
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "bash \"$TARGET/daemons/caddy.sh\"", "timeout": 10 },
        { "type": "command", "command": "bash \"$TARGET/hooks/operator-own.sh\"", "timeout": 5 }
      ] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [
        { "type": "command", "command": "bash \"$TARGET/daemons/caddy-detect-new-skill.sh\"", "timeout": 5 }
      ] }
    ]
  }
}
JSON

OUT="$( (cd "$FIXTURE" && bash install.sh --target "$TARGET" --no-deps --no-launcher) 2>&1 )" || fail "install failed: $OUT"
SETTINGS="$TARGET/.claude/settings.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$SETTINGS" || fail "settings.json is not valid JSON"

grep -qE 'daemons/caddy\.sh' "$SETTINGS" && fail "caddy.sh is still wired: $(cat "$SETTINGS")"
grep -qE 'caddy-detect-new-skill\.sh' "$SETTINGS" && fail "caddy-detect-new-skill.sh is still wired"
printf '[1/%d] both Caddy hooks are removed from an existing install\n' "$TOTAL"

grep -q 'hooks/operator-own.sh' "$SETTINGS" || fail "the operator's own hook was dropped"
printf '[2/%d] the operator'"'"'s own hook is kept\n' "$TOTAL"

grep -q 'daemons/prompt-context.sh' "$SETTINGS" || fail "prompt-context.sh is not wired"
printf '[3/%d] the replacement hook is wired\n' "$TOTAL"

grep -q '\[merge\] retired' <<<"$OUT" || fail "the retirement was silent: $OUT"
printf '[4/%d] the retirement is reported\n' "$TOTAL"

# 5. The node merger (the fallback when python3 is absent) retires the same hooks. It is run
#    directly: extracted from install.sh's heredoc and fed the same old settings.
sed -n "/merge-settings.cjs\" <<'JS'/,/^JS$/p" "$ROOT/install.sh" | sed '1d;$d' > "$WORK/merge-settings.cjs"
[[ -s "$WORK/merge-settings.cjs" ]] || fail "could not extract the node merger"
mkdir -p "$WORK/old/.claude"
OLD="$WORK/old/.claude/settings.json"
NEW="$WORK/new-settings.json"
printf '{"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"bash \\"$CLAUDE_PROJECT_DIR/daemons/caddy.sh\\""},{"type":"command","command":"bash \\"/x/hooks/operator-own.sh\\""}]}]}}' > "$OLD"
printf '{"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"bash \\"/x/daemons/prompt-context.sh\\""}]}]}}' > "$NEW"
NODE_OUT="$(node "$WORK/merge-settings.cjs" "$OLD" "$NEW" "$WORK/merged.json")"
grep -q 'daemons/caddy.sh' "$WORK/merged.json" && fail "node merger kept caddy.sh: $(cat "$WORK/merged.json")"
grep -q 'hooks/operator-own.sh' "$WORK/merged.json" || fail "node merger dropped the operator hook"
grep -q '\[merge\] retired' <<<"$NODE_OUT" || fail "node merger retired silently"
printf '[5/%d] the node merger retires the same hooks\n' "$TOTAL"

# 6 to 9. Narrow retirement, on both mergers, run directly. The settings file sits at
#    <root>/.claude/settings.json, which is how the mergers find the install's root.
sed -n "/merge-settings.py\" <<'PY'/,/^PY$/p" "$ROOT/install.sh" | sed '1d;$d' > "$WORK/merge-settings.py"
[[ -s "$WORK/merge-settings.py" ]] || fail "could not extract the python merger"
INST="$WORK/inst"
mkdir -p "$INST/.claude"
if command -v cygpath >/dev/null 2>&1; then INST_ABS="$(cygpath -m "$INST")"; else INST_ABS="$INST"; fi
node -e '
const [out, root] = process.argv.slice(1);
const h = (command) => ({ type: "command", command });
const settings = { hooks: {
  UserPromptSubmit: [{ hooks: [
    h(`bash "${root}/daemons/caddy.sh"`),
    h("bash \"$CLAUDE_PROJECT_DIR/daemons/caddy.sh\""),
    h("bash /mine/daemons/caddy.sh"),
    h("bash -c \"cd /x && bash /h/daemons/caddy.sh && echo chained-work\""),
    h("bash -c \"echo chained-work-2 && bash /h/daemons/caddy.sh\""),
  ] }],
  Stop: [{ hooks: [h(`bash "${root}/daemons/caddy.sh"`)] }],
} };
require("fs").writeFileSync(out, JSON.stringify(settings));
' "$INST/.claude/settings.json" "$INST_ABS"
printf '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"bash \\"/x/daemons/prompt-context.sh\\""}]}]}}\n' > "$WORK/new2.json"
check_merger() {
  local name="$1" merged="$2" output="$3"
  grep -q '/mine/daemons/caddy.sh' "$merged" || fail "$name retired an operator's own script of the same name"
  grep -q 'not this install' <<<"$output" || fail "$name kept the operator's script without saying so"
  grep -q 'by hand' <<<"$output" || fail "$name did not say what to do about a kept hook"
  grep -q 'chained-work' "$merged" || fail "$name dropped a compound command and its chained work"
  grep -q 'chained-work-2' "$merged" || fail "$name dropped a compound command that ends in the retired script"
  grep -q 'compound command' <<<"$output" || fail "$name kept the compound command without a warning"
  grep -q "$INST_ABS/daemons/caddy.sh" "$merged" && fail "$name kept this install's own copy"
  grep -q 'CLAUDE_PROJECT_DIR/daemons/caddy.sh' "$merged" && fail "$name kept the project-variable copy"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (s.hooks.Stop) process.exit(1)' "$merged" \
    || fail "$name did not sweep an event the template lacks"
}
OUT_NODE="$(node "$WORK/merge-settings.cjs" "$INST/.claude/settings.json" "$WORK/new2.json" "$WORK/merged-n.json")"
check_merger "the node merger" "$WORK/merged-n.json" "$OUT_NODE"
printf '[6/%d] node merger: own copies retired, in every event; an operator script and a compound are kept with a warning\n' "$TOTAL"
if command -v python3 >/dev/null 2>&1; then
  OUT_PY="$(python3 "$WORK/merge-settings.py" "$INST/.claude/settings.json" "$WORK/new2.json" "$WORK/merged-p.json")"
  check_merger "the python merger" "$WORK/merged-p.json" "$OUT_PY"
  printf '[7/%d] python merger: the same\n' "$TOTAL"
else
  printf '[7/%d] skipped: no python3\n' "$TOTAL"
fi

printf 'PASS: %d/%d retired-hook scenarios\n' "$TOTAL" "$TOTAL"
