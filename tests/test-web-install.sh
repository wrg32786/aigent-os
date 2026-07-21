#!/usr/bin/env bash
# Regression test for scripts/web-install.sh (Codex finding #21).
#
# Exercises the update path against a local fixture "origin" so the test
# never touches the network or the real GitHub repo. AIGENT_OS_REPO_URL and
# AIGENT_OS_DIR are test-only override seams (see the comments in
# web-install.sh / web-install.ps1) that let this point the script at a
# local bare repo instead of https://github.com/wrg32786/aigent-os.git.
#
# The core assertion: even when the checked-out branch's tracking config
# points at a DIFFERENT remote ("rogue"), re-running web-install.sh must
# still fast-forward from the canonical origin's content, not the rogue
# remote's -- proving the explicit "fetch origin <branch>; merge --ff-only
# origin/<branch>" fix actually closes the ambient-tracking-config gap a
# bare "git pull --ff-only" left open.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

git config --global user.email "test@example.invalid" >/dev/null 2>&1 || true
git config --global user.name "test" >/dev/null 2>&1 || true
git config --global init.defaultBranch main >/dev/null 2>&1 || true

# ── Test shim: web-install.sh requires `claude` on PATH (a real, user-facing
# precondition unrelated to the git-plumbing this test exercises). CI runners
# have git but not Claude Code, so stub a no-op `claude` on PATH for the test.
# This does NOT weaken the shipped precondition -- it only satisfies it here so
# the fresh-clone / update / detached-HEAD assertions below can actually run.
SHIM_BIN="$WORK/shim-bin"
mkdir -p "$SHIM_BIN"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SHIM_BIN/claude"
chmod +x "$SHIM_BIN/claude"
PATH="$SHIM_BIN:$PATH"
export PATH

# ── Fixture: canonical "origin" and a "rogue" remote with different content ──
UPSTREAM="$WORK/upstream.git"
git init -q --bare "$UPSTREAM"

SEED="$WORK/seed"
git init -q "$SEED"
(
  cd "$SEED"
  git checkout -q -b main
  printf 'v1\n' > marker.txt
  git add marker.txt
  git commit -q -m "v1"
  git remote add origin "$UPSTREAM"
  git push -q origin main
)
# On Windows, git normalizes a local filesystem path used as a remote URL
# (e.g. "/tmp/xyz/upstream.git" -> "C:/Users/.../upstream.git"). Both the
# script's own is_our_repo() comparison and this test's assertions compare a
# REPO_URL string against a stored (already-normalized) remote URL, so this
# fixture passes git's OWN normalized form as AIGENT_OS_REPO_URL throughout
# instead of the raw $UPSTREAM path -- avoiding a raw-vs-normalized mismatch
# that would never occur in production, where REPO_URL is always an
# https:// URL and git never rewrites it.
CANONICAL_ORIGIN="$(git -C "$SEED" remote get-url origin)"

ROGUE="$WORK/rogue.git"
git init -q --bare "$ROGUE"
SEED_ROGUE="$WORK/seed-rogue"
git clone -q "$UPSTREAM" "$SEED_ROGUE"
(
  cd "$SEED_ROGUE"
  printf 'ROGUE PAYLOAD\n' > rogue.txt
  git add rogue.txt
  git commit -q -m "rogue commit"
  git remote set-url origin "$ROGUE"
  git push -q origin main
)

# ── 1. Fresh clone pulls from the pinned canonical origin ───────────────────
TARGET1="$WORK/target1"
AIGENT_OS_REPO_URL="$CANONICAL_ORIGIN" AIGENT_OS_DIR="$TARGET1" \
  bash "$ROOT/scripts/web-install.sh" >/dev/null
test -f "$TARGET1/marker.txt"
test "$(git -C "$TARGET1" remote get-url origin)" = "$CANONICAL_ORIGIN"
printf 'fresh clone: pulled from pinned origin -- ok\n'

# ── 2. Update path ignores a rogue tracking-branch remote ───────────────────
# Simulate the exact gap finding #21 describes: the current branch's
# tracking config points at a DIFFERENT remote than "origin". A bare
# `git pull --ff-only` would follow that config and fetch the rogue commit.
(
  cd "$TARGET1"
  git remote add rogue "$ROGUE"
  git fetch -q rogue
  git config branch.main.remote rogue
  git config branch.main.merge refs/heads/main
)

# Advance the real upstream with a legitimate v2 commit.
(
  cd "$SEED"
  printf 'v2\n' > marker.txt
  git add marker.txt
  git commit -q -m "v2"
  git push -q origin main
)

AIGENT_OS_REPO_URL="$CANONICAL_ORIGIN" AIGENT_OS_DIR="$TARGET1" \
  bash "$ROOT/scripts/web-install.sh" >/dev/null

test "$(cat "$TARGET1/marker.txt")" = "v2"
test ! -e "$TARGET1/rogue.txt"
test "$(git -C "$TARGET1" remote get-url origin)" = "$CANONICAL_ORIGIN"
printf 'update path: pulled v2 from canonical origin, rogue remote ignored -- ok\n'

# ── 3. Detached HEAD refuses rather than guessing a branch ──────────────────
TARGET2="$WORK/target2"
AIGENT_OS_REPO_URL="$CANONICAL_ORIGIN" AIGENT_OS_DIR="$TARGET2" \
  bash "$ROOT/scripts/web-install.sh" >/dev/null
(cd "$TARGET2" && git checkout -q --detach)

set +e
OUTPUT="$(AIGENT_OS_REPO_URL="$CANONICAL_ORIGIN" AIGENT_OS_DIR="$TARGET2" \
  bash "$ROOT/scripts/web-install.sh" 2>&1)"
RC=$?
set -e
test "$RC" -ne 0
printf '%s\n' "$OUTPUT" | grep -qi "detached HEAD"
printf 'detached HEAD: refused with actionable error -- ok\n'

# ── 4. Checksum sidecars match current script content (Codex finding #20) ───
# Catches a forgotten `bash scripts/gen-web-install-checksums.sh` before it
# ships a stale checksum that would make legitimate re-verification fail (or
# worse, get silently skipped by an operator used to it "just failing").
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
for name in web-install.sh web-install.ps1; do
  expected="$(sha256_of "$ROOT/scripts/$name")"
  recorded="$(cut -d' ' -f1 "$ROOT/scripts/$name.sha256")"
  if [[ "$expected" != "$recorded" ]]; then
    printf 'FAIL: %s.sha256 is stale (recorded %s, actual %s). Run: bash scripts/gen-web-install-checksums.sh\n' \
      "$name" "$recorded" "$expected" >&2
    exit 1
  fi
done
printf 'checksum sidecars: match current script content -- ok\n'

printf 'web-install regression tests passed\n'
