#!/usr/bin/env bash
# Issue #147, the docs half: docs/ stayed at older copies after an upgrade with no word,
# because the installer only adds missing files. Policy (Recovery 2026-11-05): the installer
# never overwrites docs/, which an operator may have edited, but it names every installed doc
# that differs from this source, so a stale copy is visible instead of silent.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=4
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

make_fixture() {
  local source="$1"
  mkdir -p "$source"/{system,vault,hooks,daemons,scripts,docs/guides,memory,evals,.claude}
  cp "$ROOT/install.sh" "$source/install.sh"
  cp "$ROOT/daemons/memory-root.sh" "$ROOT/daemons/memory-root.cjs" "$source/daemons/"
  printf '# Identity\n' > "$source/system/00_identity.md"
  printf '# Claude source\n' > "$source/CLAUDE.md"
  printf '# guide v1\n' > "$source/docs/guide.md"
  printf '# deep v1\n' > "$source/docs/guides/deep.md"
  printf '# same\n' > "$source/docs/unchanged.md"
  printf '{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__"},"hooks":{}}\n' > "$source/.claude/settings.json.template"
  cp "$ROOT/scripts/fleet-baseline-manifest.json" "$source/scripts/fleet-baseline-manifest.json"
}

install_into() {
  (cd "$FIXTURE" && bash install.sh --target "$1" --no-deps --no-launcher 2>&1) || fail "install into $1 failed"
}

FIXTURE="$WORK/src"
make_fixture "$FIXTURE"
TARGET="$WORK/target"

# 1. A fresh install has nothing stale to report.
OUT="$(install_into "$TARGET")"
grep -q '\[stale-doc\]' <<<"$OUT" && fail "a fresh install reported stale docs: $OUT"
printf '[1/%d] fresh install reports no stale docs\n' "$TOTAL"

# 2. An upgrade whose docs changed names each stale doc and keeps the installed copy.
printf '# guide v2\n' > "$FIXTURE/docs/guide.md"
printf '# deep v2\n' > "$FIXTURE/docs/guides/deep.md"
OUT="$(install_into "$TARGET")"
grep -q '\[stale-doc\] docs/guide.md' <<<"$OUT" || fail "docs/guide.md not reported: $OUT"
grep -q '\[stale-doc\] docs/guides/deep.md' <<<"$OUT" || fail "a nested doc is not reported: $OUT"
grep -q '\[stale-doc\] docs/unchanged.md' <<<"$OUT" && fail "an identical doc was reported: $OUT"
grep -q '# guide v1' "$TARGET/docs/guide.md" || fail "the installed doc was overwritten"
printf '[2/%d] changed docs are named, identical ones are not, nothing is overwritten\n' "$TOTAL"

# 3. The report says how many and how to refresh by hand.
grep -qE '2 installed doc\(s\) differ from this source' <<<"$OUT" || fail "no stale-docs summary: $OUT"
printf '[3/%d] the summary counts the stale docs\n' "$TOTAL"

# 4. An operator-owned doc is kept and not reported as stale.
mkdir -p "$TARGET/.aigent"
printf '{"schema": "OperatorOwnedPaths/v1", "paths": ["docs/guide.md"]}\n' > "$TARGET/.aigent/operator-owned.json"
OUT="$(install_into "$TARGET")"
grep -q '\[stale-doc\] docs/guide.md' <<<"$OUT" && fail "an operator-owned doc was reported stale: $OUT"
grep -q '\[stale-doc\] docs/guides/deep.md' <<<"$OUT" || fail "the undeclared stale doc went quiet: $OUT"
printf '[4/%d] an operator-owned doc is not reported\n' "$TOTAL"

printf 'PASS: %d/%d stale-docs scenarios\n' "$TOTAL" "$TOTAL"
