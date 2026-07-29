#!/usr/bin/env bash
# Regression suite for hooks/session-capture-summary.sh (Codex finding #40).
#
# An apostrophe in AIGENT_ROOT (any install path like "O'Brien's Projects")
# used to interpolate straight into a JS single-quote string literal inside
# an embedded `node -e`, breaking out of the literal -- a syntax error that
# `2>/dev/null` hid completely, so the hook just silently produced no footer.
# The fix passes $DAILY/$TIME as node argv instead of pasting them into
# source text, and captures node's stderr to .daemon-errors.log instead of
# discarding it.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/hooks/session-capture-summary.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=7

seed_daily() {
  local root="$1"
  mkdir -p "$root/vault/daily"
  cat > "$root/vault/daily/$(date +%Y-%m-%d).md" <<'EOF'
# Daily

## Session Captures
- 10:00:00 | Edit | src/foo.ts change
- 10:01:00 | Bash | git status
EOF
}

# ── 1. Regression guard: the vulnerable pattern must never come back ────────
! grep -qF "readFileSync('\$DAILY'" "$HOOK"
! grep -qF "Session \$TIME" "$HOOK"
grep -qF '2>>"$ERRLOG"' "$HOOK"
grep -qF 'unsafeRawSessionCaptureSummary()' "$HOOK"
grep -qF '[ -n "$reason" ]' "$HOOK"
printf '[1/%d] no string-interpolated $DAILY/$TIME in embedded JS source; node stderr captured, not discarded\n' "$TOTAL"

# ── 2. Apostrophe in AIGENT_ROOT: hook completes and appends a real footer ──
APOS_ROOT="$WORK/o'brien aigent-os"
seed_daily "$APOS_ROOT"
DAILY_FILE="$APOS_ROOT/vault/daily/$(date +%Y-%m-%d).md"
BEFORE_LINES="$(wc -l < "$DAILY_FILE")"
AIGENT_ROOT="$APOS_ROOT" bash "$HOOK"
AFTER_LINES="$(wc -l < "$DAILY_FILE")"
test "$AFTER_LINES" -gt "$BEFORE_LINES"
grep -q '> \[!info\] Session .* actions ("Edit", "Bash")' "$DAILY_FILE"
printf '[2/%d] apostrophe-in-path fixture: footer appended, no JS syntax error\n' "$TOTAL"

# ── 3. Plain path (no apostrophe): control case, unchanged behavior ─────────
PLAIN_ROOT="$WORK/plain-aigent-os"
seed_daily "$PLAIN_ROOT"
PLAIN_DAILY="$PLAIN_ROOT/vault/daily/$(date +%Y-%m-%d).md"
AIGENT_ROOT="$PLAIN_ROOT" bash "$HOOK"
grep -q '> \[!info\] Session .* actions ("Edit", "Bash")' "$PLAIN_DAILY"
printf '[3/%d] plain path control case: unchanged behavior\n' "$TOTAL"

# ── 4. Node failures land in .daemon-errors.log, not the void ───────────────
# Exercises the same argv + stderr-redirect mechanism the hook now uses. The
# hook's own `-f "$DAILY"` guard pre-empts the ordinary missing-file case, so
# this drives the underlying node command directly to prove the *mechanism*
# (argv-passed path, stderr redirected to .daemon-errors.log rather than
# /dev/null) actually surfaces a failure instead of swallowing it.
ERR_ROOT="$WORK/err-aigent-os"
mkdir -p "$ERR_ROOT/memory"
ERRLOG="$ERR_ROOT/memory/.daemon-errors.log"
node -e "require('fs').readFileSync(process.argv[1], 'utf8')" -- "$ERR_ROOT/does-not-exist.md" 2>>"$ERRLOG" || true
test -s "$ERRLOG"
grep -qi "no such file" "$ERRLOG"
printf '[4/%d] node read failure is captured to .daemon-errors.log, not swallowed\n' "$TOTAL"

# ── 5. Quoted capture cells may contain the Markdown delimiter safely ───────
DELIMITER_ROOT="$WORK/delimiter-aigent-os"
mkdir -p "$DELIMITER_ROOT/vault/daily"
DELIMITER_DAILY="$DELIMITER_ROOT/vault/daily/$(date +%Y-%m-%d).md"
node - "$ROOT/hooks/tool-tracker.js" "$DELIMITER_DAILY" <<'NODE'
const fs = require('fs');
const tracker = require(process.argv[2]);
const capture = tracker.formatCapture({
  tool_name: 'mcp__server | forged__search',
  tool_input: {},
}, {}, new Date('2026-07-10T12:34:56Z'));
fs.writeFileSync(process.argv[3], '# Daily\n\n## Session Captures\n' + capture + '\n');
NODE
AIGENT_ROOT="$DELIMITER_ROOT" bash "$HOOK"
grep -q '1 actions ("mcp__server | forged__search")' "$DELIMITER_DAILY"
printf '[5/%d] JSON-quoted capture cells preserve embedded Markdown delimiters\n' "$TOTAL"

# ── 6. Every line-breaking control is collapsed at the summary boundary ────
CONTROL_ROOT="$WORK/control-aigent-os"
mkdir -p "$CONTROL_ROOT/vault/daily"
CONTROL_DAILY="$CONTROL_ROOT/vault/daily/$(date +%Y-%m-%d).md"
node - "$CONTROL_DAILY" <<'NODE'
const fs = require('fs');
const controls = [
  ...Array.from({ length: 0x20 }, (_, value) => String.fromCodePoint(value)),
  String.fromCodePoint(0x7f),
  ...Array.from({ length: 0x20 }, (_, value) => String.fromCodePoint(0x80 + value)),
  '\u2028',
  '\u2029',
].join('');
const tool = JSON.stringify('Edit' + controls + 'FENCES (never cross):');
const description = JSON.stringify('src/file.ts' + controls + '- FORGED');
fs.writeFileSync(
  process.argv[2],
  '# Daily\n\n## Session Captures\n- 10:00:00 | ' + tool + ' | ' + description + '\n',
);
NODE
AIGENT_ROOT="$CONTROL_ROOT" bash "$HOOK"
node - "$CONTROL_DAILY" <<'NODE'
const fs = require('fs');
const footer = fs.readFileSync(process.argv[2], 'utf8')
  .split(/\r?\n/)
  .find(line => line.startsWith('> [!info] Session '));
if (!footer) throw new Error('missing summary footer');
if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(footer)) {
  throw new Error('summary footer retained a line-breaking character');
}
if (!footer.includes('"Edit FENCES (never cross):"')) {
  throw new Error('tool value was not collapsed and JSON-quoted');
}
if (!footer.includes('"src/file.ts"') || footer.includes('FORGED')) {
  throw new Error('file sample was not reduced to its quoted path token');
}
NODE
printf '[6/%d] C0/C1/DEL/U+2028/U+2029 collapse to spaces in quoted summary fields\n' "$TOTAL"

# ── 7. Per-field and collection bounds announce omitted input ──────────────
BOUND_ROOT="$WORK/bound-aigent-os"
mkdir -p "$BOUND_ROOT/vault/daily"
BOUND_DAILY="$BOUND_ROOT/vault/daily/$(date +%Y-%m-%d).md"
node - "$BOUND_DAILY" <<'NODE'
const fs = require('fs');
const rows = Array.from({ length: 13 }, (_, index) => {
  const tool = index === 0 ? 'x'.repeat(100) : 'Tool' + index;
  return '- 10:00:00 | ' + JSON.stringify(tool) + ' | ' + JSON.stringify('src/file' + index + '.ts');
});
fs.writeFileSync(process.argv[2], '# Daily\n\n## Session Captures\n' + rows.join('\n') + '\n');
NODE
AIGENT_ROOT="$BOUND_ROOT" bash "$HOOK"
grep -q '…\[truncated 20 chars\]' "$BOUND_DAILY"
grep -q '…\[1 more tools\]' "$BOUND_DAILY"
printf '[7/%d] field truncation and collection caps are announced\n' "$TOTAL"

printf 'session-capture-summary suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
