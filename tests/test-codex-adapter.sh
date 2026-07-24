#!/usr/bin/env bash
# Regression suite for daemons/codex-adapter.sh -- the Codex CLI multi-LLM
# adapter stub. Uses a fake `codex` binary on PATH so the suite never depends
# on the real Codex CLI being installed.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADAPTER="$ROOT/daemons/codex-adapter.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; }

# ── 1. Codex binary missing: exit 127, actionable message, no crash ──────────
set +e
OUT="$(AIGENT_CODEX_BIN="definitely-not-a-real-binary-xyz" bash "$ADAPTER" "do a thing" --dir "$WORK" 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 127 ]] || fail "missing binary: expected exit 127, got $STATUS"
printf '%s' "$OUT" | grep -qF "Codex CLI not found" || fail "missing binary: no actionable message ($OUT)"
ok "missing Codex binary: exit 127 + actionable message"

# ── 2. No task prompt: exit 2, usage ─────────────────────────────────────────
set +e
OUT="$(bash "$ADAPTER" --dir "$WORK" 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 2 ]] || fail "no task: expected exit 2, got $STATUS"
printf '%s' "$OUT" | grep -qF "task prompt is required" || fail "no task: missing usage message"
ok "missing task prompt: exit 2 + usage"

# ── 3. --dir does not exist: exit 2 ──────────────────────────────────────────
set +e
OUT="$(bash "$ADAPTER" "do a thing" --dir "$WORK/nope" 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 2 ]] || fail "bad dir: expected exit 2, got $STATUS"
ok "nonexistent --dir: exit 2"

# ── Fake codex CLI on PATH for the remaining cases ───────────────────────────
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/fake-codex" <<'FAKE'
#!/usr/bin/env bash
# Minimal stand-in for `codex exec` -- echoes what it was asked to do and,
# for the success-path test, writes a file to prove it actually ran.
mode=""
task=""
for a in "$@"; do
  case "$a" in
    exec) : ;;
    --sandbox) expect_sandbox=1 ;;
    --skip-git-repo-check) : ;;
    *)
      if [[ "${expect_sandbox:-0}" == "1" ]]; then mode="$a"; expect_sandbox=0; else task="$a"; fi
      ;;
  esac
done
echo "fake-codex ran: sandbox=$mode task=$task"
echo "fake codex change" > ./codex-wrote-this.txt
if [[ "$task" == "FAIL_ME" ]]; then exit 9; fi
exit 0
FAKE
chmod +x "$FAKEBIN/fake-codex"

# ── 4. Success path, git repo: exit 0, output.log + review.diff populated ────
REPO="$WORK/repo"
mkdir -p "$REPO"
git init -q "$REPO"
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name test
printf 'seed\n' > "$REPO/seed.txt"
git -C "$REPO" add -- seed.txt
git -C "$REPO" commit -q -m seed

set +e
OUT="$(AIGENT_CODEX_BIN="$FAKEBIN/fake-codex" bash "$ADAPTER" "add a gitignore entry" --dir "$REPO" 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 0 ]] || fail "success path: expected exit 0, got $STATUS ($OUT)"
RUN_DIR="$(find "$REPO/.aigent/codex-runs" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -n "$RUN_DIR" ]] || fail "success path: no run directory created"
grep -qF "fake-codex ran: sandbox=workspace-write task=add a gitignore entry" "$RUN_DIR/output.log" \
  || fail "success path: output.log missing expected content"
[[ -f "$REPO/codex-wrote-this.txt" ]] || fail "success path: fake codex's file change is missing"
grep -qF "codex-wrote-this.txt" "$RUN_DIR/review.diff" \
  || fail "success path: review.diff did not capture the working-tree change"
printf '%s' "$OUT" | grep -qF "NOT committed or pushed automatically" \
  || fail "success path: missing review-gate reminder in stdout"
ok "success path (git repo): exit 0, output.log + review.diff populated, review-gate reminder printed"

# ── 5. Non-git target dir: no diff captured, clear note instead ─────────────
PLAIN="$WORK/plain"
mkdir -p "$PLAIN"
set +e
OUT="$(AIGENT_CODEX_BIN="$FAKEBIN/fake-codex" bash "$ADAPTER" "do a thing" --dir "$PLAIN" 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 0 ]] || fail "non-git dir: expected exit 0, got $STATUS"
printf '%s' "$OUT" | grep -qF "is not a git repository -- no diff captured" \
  || fail "non-git dir: missing the no-diff note"
ok "non-git target dir: no diff captured, honest note printed instead"

# ── 6. Codex's own exit code passes through ──────────────────────────────────
FAILREPO="$WORK/failrepo"
mkdir -p "$FAILREPO"
git init -q "$FAILREPO"
git -C "$FAILREPO" config user.email test@example.invalid
git -C "$FAILREPO" config user.name test
printf 'seed\n' > "$FAILREPO/seed.txt"
git -C "$FAILREPO" add -- seed.txt
git -C "$FAILREPO" commit -q -m seed
set +e
AIGENT_CODEX_BIN="$FAKEBIN/fake-codex" bash "$ADAPTER" "FAIL_ME" --dir "$FAILREPO" >/dev/null 2>&1
STATUS=$?
set -e
[[ "$STATUS" -eq 9 ]] || fail "codex exit passthrough: expected 9, got $STATUS"
ok "Codex's own non-zero exit code passes through unchanged"

printf 'codex-adapter regression tests passed\n'
