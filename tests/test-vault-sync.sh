#!/usr/bin/env bash
# Fast vault-sync regressions against real local Git repositories and remotes.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

TOTAL=4

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

make_symlink() {
  local destination="$1" link="$2"
  ln -s "$destination" "$link" 2>/dev/null || true
  if [[ ! -L "$link" ]]; then
    rm -f "$link"
    MSYS=winsymlinks ln -s "$destination" "$link" 2>/dev/null || true
  fi
  [[ -L "$link" ]] || fail "could not create a real symlink at $link"
}

make_vault() {
  local work="$1"
  mkdir -p "$work/.aigent" "$work/vault/memory/capsules" "$work/memory"
  printf '{"schemaVersion":1,"status":"ready","completedAt":null}\n' \
    > "$work/.aigent/state.json"
  if ! git init -q -b main "$work" 2>/dev/null; then
    git init -q "$work"
    git -C "$work" checkout -q -b main
  fi
  git -C "$work" config user.email 'vault-sync-test@example.invalid'
  git -C "$work" config user.name 'vault sync test'
  git -C "$work" config core.autocrlf false
  printf 'seed\n' > "$work/vault/memory/seed.md"
  git -C "$work" add -- vault/memory/seed.md
  git -C "$work" commit -q -m seed
}

add_remote() {
  local work="$1" remote="$2"
  git init -q --bare "$remote"
  git -C "$work" remote add origin "$remote"
  git -C "$work" push -q -u origin main
}

run_cycle() {
  local work="$1" reason="$2"
  (
    cd "$work"
    node "$ROOT/daemons/vault-sync.mjs" --reason "$reason"
  )
}

# ── 1. Configured remote: close creates and pushes a verified commit ──────────
REMOTE_WORK="$WORK/remote-cycle"
REMOTE_BARE="$WORK/remote-cycle.git"
make_vault "$REMOTE_WORK"
add_remote "$REMOTE_WORK" "$REMOTE_BARE"
REMOTE_BEFORE="$(git --git-dir="$REMOTE_BARE" rev-parse refs/heads/main)"
printf 'must stay staged, never enter the memory commit\n' > "$REMOTE_WORK/project-code.txt"
git -C "$REMOTE_WORK" add -- project-code.txt
printf 'durable root memory\n' > "$REMOTE_WORK/memory/SKILL_LEDGER.md"
HOOK_SENTINEL="$REMOTE_WORK/disabled-hook-ran.txt"
mkdir -p "$REMOTE_WORK/.git/aigent-disabled-hooks" "$REMOTE_WORK/.git/hooks"
printf '#!/usr/bin/env bash\nprintf "ran\\n" > "%s"\n' "$HOOK_SENTINEL" \
  > "$REMOTE_WORK/.git/aigent-disabled-hooks/post-index-change"
printf '#!/usr/bin/env bash\nprintf "ran\\n" > "%s"\n' "$HOOK_SENTINEL" \
  > "$REMOTE_WORK/.git/hooks/post-index-change"
chmod +x \
  "$REMOTE_WORK/.git/aigent-disabled-hooks/post-index-change" \
  "$REMOTE_WORK/.git/hooks/post-index-change"
mkdir -p \
  "$REMOTE_WORK/vault/memory/runtime/stop-writer" \
  "$REMOTE_WORK/memory/runtime/stop-writer"
printf '{"offset":12}\n' > "$REMOTE_WORK/vault/memory/runtime/stop-writer/session.json"
printf '{"offset":34}\n' > "$REMOTE_WORK/memory/runtime/stop-writer/session.json"
printf '%s\n' '---' 'id: test-remote-cycle' '---' 'durable memory' \
  > "$REMOTE_WORK/vault/memory/capsules/remote-cycle.md"
REMOTE_OUT="$(run_cycle "$REMOTE_WORK" 'test capsule-cycle close' 2>&1)"
[[ -z "$REMOTE_OUT" ]] || fail "successful cycle produced output: $REMOTE_OUT"
LOCAL_AFTER="$(git -C "$REMOTE_WORK" rev-parse HEAD)"
REMOTE_AFTER="$(git --git-dir="$REMOTE_BARE" rev-parse refs/heads/main)"
[[ "$REMOTE_AFTER" != "$REMOTE_BEFORE" ]] || fail 'remote HEAD did not advance'
[[ "$REMOTE_AFTER" == "$LOCAL_AFTER" ]] || fail 'remote HEAD does not match local HEAD'
git -C "$REMOTE_WORK" log -1 --format=%s | grep -q '^vault sync: test capsule-cycle close ' \
  || fail 'sync commit subject is missing'
git --git-dir="$REMOTE_BARE" show \
  "$REMOTE_AFTER:vault/memory/capsules/remote-cycle.md" | grep -q 'durable memory' \
  || fail 'capsule did not reach remote'
git --git-dir="$REMOTE_BARE" show \
  "$REMOTE_AFTER:memory/SKILL_LEDGER.md" | grep -q 'durable root memory' \
  || fail 'fallback/root memory did not reach remote'
if git --git-dir="$REMOTE_BARE" ls-tree -r --name-only "$REMOTE_AFTER" \
    | grep -q '/runtime/stop-writer/'; then
  fail 'generated stop-writer state entered the memory commit'
fi
if git --git-dir="$REMOTE_BARE" cat-file -e "$REMOTE_AFTER:project-code.txt" 2>/dev/null; then
  fail 'ambient staged project code entered the memory-only commit'
fi
[[ "$(git -C "$REMOTE_WORK" diff --cached --name-only)" == 'project-code.txt' ]] \
  || fail 'ambient staged project code was not preserved in the index'
[[ ! -e "$HOOK_SENTINEL" ]] || fail 'repository hook executed during vault sync'
grep -F 'node daemons/vault-sync.mjs' "$ROOT/skills/context-capsule/SKILL.md" >/dev/null \
  || fail 'explicit capsule close is not wired to vault sync'
printf '[1/%d] configured capsule cycle: committed, pushed, verified\n' "$TOTAL"

# ── 2. No remote: completely silent no-op, no local commit ───────────────────
NO_REMOTE_WORK="$WORK/no-remote"
make_vault "$NO_REMOTE_WORK"
NO_REMOTE_BEFORE="$(git -C "$NO_REMOTE_WORK" rev-parse HEAD)"
printf 'local only\n' > "$NO_REMOTE_WORK/vault/memory/capsules/no-remote.md"
NO_REMOTE_OUTSIDE="$WORK/no-remote-outside.md"
printf 'outside local-only target\n' > "$NO_REMOTE_OUTSIDE"
NO_REMOTE_OUTSIDE_BEFORE="$(git hash-object "$NO_REMOTE_OUTSIDE")"
make_symlink "$NO_REMOTE_OUTSIDE" \
  "$NO_REMOTE_WORK/vault/memory/capsules/no-remote-outside.md"
NO_REMOTE_OUT="$(run_cycle "$NO_REMOTE_WORK" 'no remote' 2>&1)"
[[ -z "$NO_REMOTE_OUT" ]] || fail "no-remote cycle produced output: $NO_REMOTE_OUT"
[[ "$(git -C "$NO_REMOTE_WORK" rev-parse HEAD)" == "$NO_REMOTE_BEFORE" ]] \
  || fail 'no-remote cycle created a commit'
[[ -z "$(git -C "$NO_REMOTE_WORK" diff --cached --name-only)" ]] \
  || fail 'no-remote cycle staged changes'
[[ -f "$NO_REMOTE_WORK/vault/memory/capsules/no-remote.md" ]] \
  || fail 'no-remote cycle lost the local capsule'
[[ "$(git hash-object "$NO_REMOTE_OUTSIDE")" == "$NO_REMOTE_OUTSIDE_BEFORE" ]] \
  || fail 'no-remote cycle touched an outside symlink target'
[[ ! -e "$NO_REMOTE_WORK/vault/memory/.daemon-errors.log" ]] \
  || fail 'no-remote cycle wrote an error log'
printf '[2/%d] no remote: clean silent no-op\n' "$TOTAL"

# ── 3. Push failure: local commit remains, one log line, lifecycle exits 0 ───
FAIL_WORK="$WORK/push-failure"
FAIL_BARE="$WORK/push-failure.git"
make_vault "$FAIL_WORK"
add_remote "$FAIL_WORK" "$FAIL_BARE"
FAIL_REMOTE_BEFORE="$(git --git-dir="$FAIL_BARE" rev-parse refs/heads/main)"
git -C "$FAIL_WORK" remote set-url --push origin "$WORK/missing/push-failure.git"
printf 'retry me\n' > "$FAIL_WORK/vault/memory/capsules/push-failure.md"
FAIL_OUT="$(run_cycle "$FAIL_WORK" 'push failure' 2>&1)"
[[ -z "$FAIL_OUT" ]] || fail "push failure escaped to lifecycle output: $FAIL_OUT"
git -C "$FAIL_WORK" log -1 --format=%s | grep -q '^vault sync: push failure ' \
  || fail "push failure did not leave a local sync commit: $(git -C "$FAIL_WORK" log -1 --format=%s); $(sed -n '1p' "$FAIL_WORK/vault/memory/.daemon-errors.log" 2>/dev/null || true)"
[[ "$(git --git-dir="$FAIL_BARE" rev-parse refs/heads/main)" == "$FAIL_REMOTE_BEFORE" ]] \
  || fail 'rejecting remote unexpectedly advanced'
ERROR_LOG="$FAIL_WORK/vault/memory/.daemon-errors.log"
[[ -f "$ERROR_LOG" ]] || fail 'push failure did not create daemon error log'
[[ "$(wc -l < "$ERROR_LOG" | tr -d ' ')" == '1' ]] \
  || fail 'push failure did not produce exactly one log line'
grep -q '\[vault-sync\] git push failed:' "$ERROR_LOG" \
  || fail 'push failure log line is missing or malformed'

# An explicit but unavailable pushRemote is authoritative. Never fall back to
# origin and silently ship memory to the wrong destination.
ROUTE_WORK="$WORK/invalid-push-remote"
ROUTE_BARE="$WORK/invalid-push-remote.git"
make_vault "$ROUTE_WORK"
add_remote "$ROUTE_WORK" "$ROUTE_BARE"
ROUTE_LOCAL_BEFORE="$(git -C "$ROUTE_WORK" rev-parse HEAD)"
ROUTE_REMOTE_BEFORE="$(git --git-dir="$ROUTE_BARE" rev-parse refs/heads/main)"
git -C "$ROUTE_WORK" config branch.main.pushRemote unavailable
printf 'wrong remote guard\n' > "$ROUTE_WORK/vault/memory/capsules/wrong-remote.md"
ROUTE_OUT="$(run_cycle "$ROUTE_WORK" 'wrong remote' 2>&1)"
[[ -z "$ROUTE_OUT" ]] || fail "invalid pushRemote escaped to lifecycle output: $ROUTE_OUT"
[[ "$(git -C "$ROUTE_WORK" rev-parse HEAD)" == "$ROUTE_LOCAL_BEFORE" ]] \
  || fail 'invalid pushRemote created a local commit'
[[ "$(git --git-dir="$ROUTE_BARE" rev-parse refs/heads/main)" == "$ROUTE_REMOTE_BEFORE" ]] \
  || fail 'invalid pushRemote fell back to origin'
grep -q '\[vault-sync\].*selects unavailable push remote unavailable' \
  "$ROUTE_WORK/vault/memory/.daemon-errors.log" \
  || fail 'invalid pushRemote refusal was not logged'
printf '[3/%d] push failure: logged once, never threw, local commit retained\n' "$TOTAL"

# ── 4. Symlink escape: refuse before stage/commit/push ────────────────────────
LINK_WORK="$WORK/symlink-boundary"
LINK_BARE="$WORK/symlink-boundary.git"
make_vault "$LINK_WORK"
add_remote "$LINK_WORK" "$LINK_BARE"
LINK_LOCAL_BEFORE="$(git -C "$LINK_WORK" rev-parse HEAD)"
LINK_REMOTE_BEFORE="$(git --git-dir="$LINK_BARE" rev-parse refs/heads/main)"
OUTSIDE_FILE="$WORK/outside-memory.md"
printf 'must remain outside\n' > "$OUTSIDE_FILE"
OUTSIDE_BEFORE="$(git hash-object "$OUTSIDE_FILE")"
make_symlink "$OUTSIDE_FILE" "$LINK_WORK/vault/memory/capsules/outside.md"
LINK_OUT="$(run_cycle "$LINK_WORK" 'symlink refusal' 2>&1)"
[[ -z "$LINK_OUT" ]] || fail "symlink refusal escaped to lifecycle output: $LINK_OUT"
[[ "$(git -C "$LINK_WORK" rev-parse HEAD)" == "$LINK_LOCAL_BEFORE" ]] \
  || fail 'symlink refusal created a local commit'
[[ "$(git --git-dir="$LINK_BARE" rev-parse refs/heads/main)" == "$LINK_REMOTE_BEFORE" ]] \
  || fail 'symlink refusal changed the remote'
[[ "$(git hash-object "$OUTSIDE_FILE")" == "$OUTSIDE_BEFORE" ]] \
  || fail 'symlink refusal touched the outside target'
grep -qi '\[vault-sync\].*refusing to write through symlink' \
  "$LINK_WORK/vault/memory/.daemon-errors.log" \
  || fail 'symlink refusal was not logged'

# The Git control tree is part of the same boundary: a pre-seeded descendant
# directory link must not redirect object/ref/log writes outside the install.
GIT_LINK_WORK="$WORK/git-symlink-boundary"
GIT_LINK_BARE="$WORK/git-symlink-boundary.git"
make_vault "$GIT_LINK_WORK"
add_remote "$GIT_LINK_WORK" "$GIT_LINK_BARE"
GIT_LINK_LOCAL_BEFORE="$(git -C "$GIT_LINK_WORK" rev-parse HEAD)"
GIT_LINK_REMOTE_BEFORE="$(git --git-dir="$GIT_LINK_BARE" rev-parse refs/heads/main)"
GIT_OUTSIDE_DIR="$WORK/outside-git-objects"
mkdir -p "$GIT_OUTSIDE_DIR"
cp "$GIT_LINK_WORK/.git/logs/HEAD" "$GIT_OUTSIDE_DIR/sentinel"
GIT_OUTSIDE_BEFORE="$(git hash-object "$GIT_OUTSIDE_DIR/sentinel")"
rm "$GIT_LINK_WORK/.git/logs/HEAD"
make_symlink "$GIT_OUTSIDE_DIR/sentinel" "$GIT_LINK_WORK/.git/logs/HEAD"
printf 'must not commit\n' > "$GIT_LINK_WORK/vault/memory/capsules/git-link.md"
GIT_LINK_OUT="$(run_cycle "$GIT_LINK_WORK" 'git symlink refusal' 2>&1)"
[[ -z "$GIT_LINK_OUT" ]] || fail "git symlink refusal escaped to lifecycle output: $GIT_LINK_OUT"
[[ "$(git -C "$GIT_LINK_WORK" rev-parse HEAD)" == "$GIT_LINK_LOCAL_BEFORE" ]] \
  || fail 'git-control symlink refusal created a local commit'
[[ "$(git --git-dir="$GIT_LINK_BARE" rev-parse refs/heads/main)" == "$GIT_LINK_REMOTE_BEFORE" ]] \
  || fail 'git-control symlink refusal changed the remote'
[[ "$(git hash-object "$GIT_OUTSIDE_DIR/sentinel")" == "$GIT_OUTSIDE_BEFORE" ]] \
  || fail 'git-control symlink refusal touched the outside target'
grep -qi '\[vault-sync\].*refusing to write through symlink' \
  "$GIT_LINK_WORK/vault/memory/.daemon-errors.log" \
  || fail 'git-control symlink refusal was not logged'
printf '[4/%d] symlink outside root: refused, outside target untouched\n' "$TOTAL"

printf 'vault-sync tests: all %d passed\n' "$TOTAL"
