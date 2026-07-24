#!/usr/bin/env bash
# Regression + drift guard for assets/build-terminal-demo.mjs and the two
# committed demo SVGs it produces. The generator is a pure function of its
# JSON input (no timestamps, no randomness) -- regenerating into a temp
# directory must byte-for-byte match what's committed, or someone hand-edited
# the SVG (or the script) and the two have drifted apart.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$ROOT/assets/build-terminal-demo.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; }

node --check "$GEN" || fail "syntax error in $GEN"
ok "syntax: build-terminal-demo.mjs"

for name in demo-day-one demo-session-resume; do
  SRC_SVG="$ROOT/assets/$name.svg"
  [[ -f "$SRC_SVG" ]] || fail "$SRC_SVG is not committed -- run: node assets/build-terminal-demo.mjs assets/$name.script.json"

  node "$GEN" "$ROOT/assets/$name.script.json" --out "$WORK/$name.svg" >/dev/null

  if ! diff -q "$SRC_SVG" "$WORK/$name.svg" >/dev/null; then
    fail "$name.svg is out of date -- regenerate with: node assets/build-terminal-demo.mjs assets/$name.script.json"
  fi
  ok "$name.svg matches a fresh regeneration from its .script.json (no drift)"

  python3 - "$SRC_SVG" <<'PY' || fail "$name.svg is not well-formed XML"
import sys
import xml.etree.ElementTree as ET
ET.parse(sys.argv[1])
PY
  ok "$name.svg is well-formed XML"

  # SMIL keyTimes must be strictly increasing and match values length, or
  # renderers may silently ignore (or error on) the animation.
  python3 - "$SRC_SVG" <<'PY' || fail "$name.svg has malformed SMIL keyTimes"
import re
import sys
s = open(sys.argv[1], encoding="utf-8").read()
for m in re.finditer(r'keyTimes="([^"]+)"\s+values="([^"]+)"', s):
    kt = [float(x) for x in m.group(1).split(";")]
    vv = m.group(2).split(";")
    assert len(kt) == len(vv), f"length mismatch: {len(kt)} keyTimes vs {len(vv)} values"
    assert all(kt[i] < kt[i + 1] for i in range(len(kt) - 1)), f"non-monotonic keyTimes: {kt}"
PY
  ok "$name.svg SMIL keyTimes are well-formed and strictly increasing"
done

printf 'build-terminal-demo regression tests passed\n'
