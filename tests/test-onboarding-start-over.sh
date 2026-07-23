#!/usr/bin/env bash
# Regression test for the "I want to start over" instructions in
# docs/onboarding-guide.html (Codex finding #37).
#
# The old instruction was `rm -rf ~/aigent` while Step 4 installs to
# ~/aigent-os -- a directory the installer never creates, so the command did
# nothing useful for a real install and would delete an unrelated ~/aigent
# directory if the user happened to have one. The fix resolves the SAME
# ~/aigent-os path Step 4 used, checks for the install marker (.aigent/
# state.json -- the same marker install.sh itself writes on every install)
# before touching anything, and refuses if it's absent.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTML="$ROOT/docs/onboarding-guide.html"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=2

# Extract the shipped copy-paste command straight from the doc rather than
# hand-duplicating it here, so this test tracks whatever the doc actually
# ships instead of a copy that could silently drift from it.
CMD="$(grep -o 'data-copy="test -f ~/aigent-os/.aigent/state.json[^"]*"' "$HTML" | head -1 | sed -e 's/^data-copy="//' -e 's/"$//')"
[ -n "$CMD" ] || { printf 'FAIL: could not find the start-over command in %s\n' "$HTML" >&2; exit 1; }

# ── 1. Wrong dir / no install marker: refuses, deletes nothing ──────────────
NO_MARKER_HOME="$WORK/no-marker-home"
mkdir -p "$NO_MARKER_HOME/aigent-os"
printf 'unrelated user data -- must survive\n' > "$NO_MARKER_HOME/aigent-os/some-unrelated-file.txt"
OUT="$(HOME="$NO_MARKER_HOME" bash -c "$CMD")"
printf '%s\n' "$OUT" | grep -qi "no aigent-os install found"
test -f "$NO_MARKER_HOME/aigent-os/some-unrelated-file.txt"
test "$(cat "$NO_MARKER_HOME/aigent-os/some-unrelated-file.txt")" = "unrelated user data -- must survive"
printf '[1/%d] no install marker: refuses, unrelated file untouched\n' "$TOTAL"

# ── 2. Real install root: clears only .aigent/, leaves the checkout ─────────
REAL_HOME="$WORK/real-home"
mkdir -p "$REAL_HOME/aigent-os/.aigent"
printf '{"schemaVersion":1,"status":"initialized"}\n' > "$REAL_HOME/aigent-os/.aigent/state.json"
printf '#!/usr/bin/env bash\n' > "$REAL_HOME/aigent-os/install.sh"
OUT="$(HOME="$REAL_HOME" bash -c "$CMD")"
printf '%s\n' "$OUT" | grep -qi "cleared"
test ! -e "$REAL_HOME/aigent-os/.aigent"
test -f "$REAL_HOME/aigent-os/install.sh"
printf '[2/%d] real install marker present: .aigent cleared, checkout survives\n' "$TOTAL"

printf 'onboarding start-over suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
