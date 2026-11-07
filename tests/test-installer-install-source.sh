#!/usr/bin/env bash
# Issue #147: a seat must be able to say which commit it was installed from.
# The baseline manifest names the commit its pins were cut from
# (public_product_commit), so two installs that share a baseline but differ in
# unpinned files looked identical. install.sh now stamps the source commit in
# <target>/.aigent/install-source.json and doctor --attest reports it beside
# the baseline commit.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=6
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# The fixture is its own throwaway git repository; its commits carry a fixed
# fixture identity and no hooks of any real repository.
fgit() {
  git -C "$FIXTURE" -c user.name=fixture -c user.email=fixture@example.invalid \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false -c core.autocrlf=false "$@"
}

make_fixture() {
  local source="$1"
  mkdir -p "$source"/{system,vault,hooks,daemons,scripts,docs,memory,evals,.claude}
  cp "$ROOT/install.sh" "$source/install.sh"
  cp "$ROOT/daemons/memory-root.sh" "$ROOT/daemons/memory-root.cjs" "$source/daemons/" 2>/dev/null || true
  printf '# Identity\n' > "$source/system/00_identity.md"
  printf '# Claude source\n' > "$source/CLAUDE.md"
  printf '# doc v1\n' > "$source/docs/guide.md"
  printf '{"env":{"AIGENT_ROOT":"__AIGENT_ROOT__"},"hooks":{}}\n' > "$source/.claude/settings.json.template"
  # The real manifest: doctor --attest needs its full shape. The fixture has
  # none of the pinned files, so the verdict is not COMPLIANT; only the info
  # lines are under test here.
  cp "$ROOT/scripts/fleet-baseline-manifest.json" "$source/scripts/fleet-baseline-manifest.json"
}
BASE_CUT="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).public_product_commit)' "$ROOT/scripts/fleet-baseline-manifest.json")"

record_field() {
  node -e '
const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const f = v[process.argv[2]];
process.stdout.write(f === null ? "null" : String(f));
' "$1" "$2"
}

install_into() {
  (cd "$FIXTURE" && bash install.sh --target "$1" --no-deps --no-launcher >/dev/null 2>&1) \
    || fail "install into $1 failed"
}

FIXTURE="$WORK/src"
make_fixture "$FIXTURE"
fgit init -q
fgit add -A
fgit commit -q -m 'fixture v1'
V1="$(fgit rev-parse HEAD)"

# 1. A clean git source stamps its commit.
TARGET="$WORK/target"
install_into "$TARGET"
REC="$TARGET/.aigent/install-source.json"
[[ -f "$REC" ]] || fail "no install record at $REC"
[[ "$(record_field "$REC" source_commit)" == "$V1" ]] || fail "source_commit is not $V1: $(cat "$REC")"
[[ "$(record_field "$REC" source_dirty)" == "false" ]] || fail "a clean source reads dirty: $(cat "$REC")"
printf '[1/%d] clean git source stamps its commit\n' "$TOTAL"

# 2. Reinstalling from a newer commit updates the record, not just missing files.
printf '# doc v2\n' > "$FIXTURE/docs/guide.md"
fgit commit -q -am 'fixture v2'
V2="$(fgit rev-parse HEAD)"
install_into "$TARGET"
[[ "$(record_field "$REC" source_commit)" == "$V2" ]] || fail "reinstall kept the old commit: $(cat "$REC")"
printf '[2/%d] reinstall from a newer commit updates the record\n' "$TOTAL"

# 3. Uncommitted changes in the source are recorded as dirty.
printf 'local edit\n' >> "$FIXTURE/CLAUDE.md"
install_into "$TARGET"
[[ "$(record_field "$REC" source_commit)" == "$V2" ]] || fail "dirty install lost its base commit"
[[ "$(record_field "$REC" source_dirty)" == "true" ]] || fail "a dirty source reads clean: $(cat "$REC")"
fgit checkout -q -- CLAUDE.md
printf '[3/%d] a dirty source is recorded as dirty\n' "$TOTAL"

# 4. A source that is not a git checkout says so instead of guessing.
ARCHIVE="$WORK/archive"
make_fixture "$ARCHIVE"
(cd "$ARCHIVE" && bash install.sh --target "$WORK/target-archive" --no-deps --no-launcher >/dev/null 2>&1) \
  || fail "archive install failed"
AREC="$WORK/target-archive/.aigent/install-source.json"
[[ "$(record_field "$AREC" source_commit)" == "null" ]] || fail "an archive source invented a commit: $(cat "$AREC")"
[[ "$(record_field "$AREC" source_kind)" == "archive" ]] || fail "an archive source is not named archive: $(cat "$AREC")"
printf '[4/%d] a non-git source records no commit\n' "$TOTAL"

# 5. doctor --attest reports the install commit beside the baseline commit.
OUT="$(bash "$ROOT/scripts/doctor.sh" --attest "$TARGET" 2>&1 || true)"
grep -q "installed from $V2" <<<"$OUT" || fail "doctor does not report the install commit: $OUT"
grep -q "baseline cut from $BASE_CUT" <<<"$OUT" \
  || fail "doctor does not label the baseline commit as the cut commit: $OUT"
printf '[5/%d] doctor --attest reports both commits, labelled\n' "$TOTAL"

# 6. A target with no record (installed before #147) is reported, not guessed.
rm -f "$REC"
OUT="$(bash "$ROOT/scripts/doctor.sh" --attest "$TARGET" 2>&1 || true)"
grep -q "installed from unknown" <<<"$OUT" || fail "doctor does not report a missing record: $OUT"
printf '[6/%d] a missing record reads unknown\n' "$TOTAL"

printf 'PASS: %d/%d install-source scenarios\n' "$TOTAL" "$TOTAL"
