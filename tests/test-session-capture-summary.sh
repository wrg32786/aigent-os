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

TOTAL=4

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
printf '[1/%d] no string-interpolated $DAILY/$TIME in embedded JS source; node stderr captured, not discarded\n' "$TOTAL"

# ── 2. Apostrophe in AIGENT_ROOT: hook completes and appends a real footer ──
APOS_ROOT="$WORK/o'brien aigent-os"
seed_daily "$APOS_ROOT"
DAILY_FILE="$APOS_ROOT/vault/daily/$(date +%Y-%m-%d).md"
BEFORE_LINES="$(wc -l < "$DAILY_FILE")"
AIGENT_ROOT="$APOS_ROOT" bash "$HOOK"
AFTER_LINES="$(wc -l < "$DAILY_FILE")"
test "$AFTER_LINES" -gt "$BEFORE_LINES"
grep -q '> \[!info\] Session .* actions (Edit, Bash)' "$DAILY_FILE"
printf '[2/%d] apostrophe-in-path fixture: footer appended, no JS syntax error\n' "$TOTAL"

# ── 3. Plain path (no apostrophe): control case, unchanged behavior ─────────
PLAIN_ROOT="$WORK/plain-aigent-os"
seed_daily "$PLAIN_ROOT"
PLAIN_DAILY="$PLAIN_ROOT/vault/daily/$(date +%Y-%m-%d).md"
AIGENT_ROOT="$PLAIN_ROOT" bash "$HOOK"
grep -q '> \[!info\] Session .* actions (Edit, Bash)' "$PLAIN_DAILY"
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

printf 'session-capture-summary suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
