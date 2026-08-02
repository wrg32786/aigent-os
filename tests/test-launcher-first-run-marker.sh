#!/usr/bin/env bash
# Regression suite for launcher/aigent.sh first-run marker ownership. The
# launcher must retry /start until the /start skill itself records durable
# completion; it must never infer completion from a zero claude exit alone.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="$ROOT/launcher/aigent.sh"
WORK="$(mktemp -d)"
LAUNCHER_PID=""
STUB_PID=""

cleanup() {
  if [[ -n "$STUB_PID" ]] && kill -0 "$STUB_PID" 2>/dev/null; then
    kill -TERM "$STUB_PID" 2>/dev/null || true
  fi
  if [[ -n "$LAUNCHER_PID" ]] && kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    kill -TERM "$LAUNCHER_PID" 2>/dev/null || true
    wait "$LAUNCHER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

TOTAL=3
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"

cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
set -eu

case "${CLAUDE_STUB_MODE:?}" in
  noop)
    exit 0
    ;;
  sleep)
    : "${CLAUDE_PID_FILE:?}"
    printf '%s\n' "$$" > "$CLAUDE_PID_FILE"
    exec sleep 30
    ;;
  complete)
    : "${CLAUDE_CALL_LOG:?}"
    printf '%s' "$#" >> "$CLAUDE_CALL_LOG"
    for arg in "$@"; do
      printf '\t%s' "$arg" >> "$CLAUDE_CALL_LOG"
    done
    printf '\n' >> "$CLAUDE_CALL_LOG"

    if [[ "$#" -eq 1 && "$1" == "/start" ]]; then
      mkdir -p "$AIGENT_HOME/.aigent"
      printf '{"schemaVersion":1,"status":"ready"}\n' > "$AIGENT_HOME/.aigent/state.json"
      : > "$AIGENT_HOME/.aigent/first-run-done"
    fi
    ;;
  *)
    printf 'unexpected CLAUDE_STUB_MODE: %s\n' "$CLAUDE_STUB_MODE" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$FAKEBIN/claude"

# ── 1. Zero-exit no-op: launcher must not manufacture completion ────────
NOOP_HOME="$WORK/noop-home"
mkdir -p "$NOOP_HOME"
if ! PATH="$FAKEBIN:$PATH" AIGENT_HOME="$NOOP_HOME" CLAUDE_STUB_MODE=noop \
  bash "$LAUNCHER" > "$WORK/noop.log" 2>&1; then
  fail "no-op /start launcher invocation returned nonzero"
fi
[[ ! -e "$NOOP_HOME/.aigent/first-run-done" ]] \
  || fail "no-op /start manufactured first-run-done"
printf '[1/%d] zero-exit no-op: no first-run marker\n' "$TOTAL"

# ── 2. Interrupted stub: killing its exact PID must leave no marker ────────
KILL_HOME="$WORK/kill-home"
PID_FILE="$WORK/claude.pid"
mkdir -p "$KILL_HOME"
PATH="$FAKEBIN:$PATH" AIGENT_HOME="$KILL_HOME" CLAUDE_STUB_MODE=sleep \
  CLAUDE_PID_FILE="$PID_FILE" bash "$LAUNCHER" > "$WORK/kill.log" 2>&1 &
LAUNCHER_PID=$!

for _ in {1..100}; do
  [[ -s "$PID_FILE" ]] && break
  sleep 0.05
done
[[ -s "$PID_FILE" ]] || fail "sleeping claude stub did not publish its PID"
STUB_PID="$(cat "$PID_FILE")"
[[ "$STUB_PID" =~ ^[0-9]+$ ]] || fail "claude stub published an invalid PID"
kill -0 "$STUB_PID" 2>/dev/null || fail "claude stub PID was not running"
kill -TERM "$STUB_PID"

set +e
wait "$LAUNCHER_PID"
KILL_STATUS=$?
set -e
LAUNCHER_PID=""
STUB_PID=""

[[ "$KILL_STATUS" -ne 0 ]] || fail "launcher returned zero after its claude stub was killed"
[[ ! -e "$KILL_HOME/.aigent/first-run-done" ]] \
  || fail "interrupted /start left a first-run marker"
printf '[2/%d] PID-targeted interruption: no first-run marker\n' "$TOTAL"

# ── 3. Skill-owned completion: marker routes the next launch to /open ──────
COMPLETE_HOME="$WORK/complete-home"
CALL_LOG="$WORK/claude-calls.tsv"
EXPECTED_CALL_LOG="$WORK/expected-claude-calls.tsv"
mkdir -p "$COMPLETE_HOME"

PATH="$FAKEBIN:$PATH" AIGENT_HOME="$COMPLETE_HOME" CLAUDE_STUB_MODE=complete \
  CLAUDE_CALL_LOG="$CALL_LOG" bash "$LAUNCHER" > "$WORK/complete-first.log" 2>&1
[[ -f "$COMPLETE_HOME/.aigent/first-run-done" ]] \
  || fail "completed /start did not leave its skill-owned marker"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' "$COMPLETE_HOME/.aigent/state.json" \
  || fail "completed /start did not record ready state"

PATH="$FAKEBIN:$PATH" AIGENT_HOME="$COMPLETE_HOME" CLAUDE_STUB_MODE=complete \
  CLAUDE_CALL_LOG="$CALL_LOG" bash "$LAUNCHER" > "$WORK/complete-second.log" 2>&1
printf '1\t/start\n2\t--continue\t/open\n' > "$EXPECTED_CALL_LOG"
if ! cmp -s "$EXPECTED_CALL_LOG" "$CALL_LOG"; then
  printf 'expected claude calls:\n' >&2
  sed 's/^/  /' "$EXPECTED_CALL_LOG" >&2
  printf 'actual claude calls:\n' >&2
  sed 's/^/  /' "$CALL_LOG" >&2
  fail "completed first run did not route the second launch to --continue /open"
fi
printf '[3/%d] skill-owned completion: second launch receives --continue /open\n' "$TOTAL"

printf 'launcher first-run marker suite passed (%d/%d)\n' "$TOTAL" "$TOTAL"
