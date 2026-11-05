#!/usr/bin/env bash
# daemons/prompt-context.sh: the UserPromptSubmit hook that replaces Caddy (2026-11-05).
# Caddy took 13 to 22 s per prompt on a Windows host (dozens of sequential grep forks) and was
# cancelled at its limit on nearly every prompt. Skill matching is native in Claude Code. What
# remains: the [CLOCK] line, and memory capture run detached so it never blocks a prompt.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
HOOK="$ROOT/daemons/prompt-context.sh"
TOTAL=5
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[[ -f "$HOOK" ]] || fail "no hook at $HOOK"
bash -n "$HOOK" || fail "hook does not parse"

# 1. It prints the clock line first, and nothing else when there is nothing to capture.
OUT="$(printf '{"prompt":"hello","session_id":"s1","cwd":"%s"}' "$WORK" | AIGENT_ROOT="$WORK/none" bash "$HOOK")"
[[ "$OUT" =~ ^\[CLOCK\]\ [A-Z][a-z]+day\ [0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}\ (AM|PM) ]] || fail "no clock line: $OUT"
[[ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" == "1" ]] || fail "printed more than the clock: $OUT"
printf '[1/%d] prints the clock line only\n' "$TOTAL"

# 2. Built-ins only before the capture: no external command may run on the synchronous path.
#    A PATH with nothing on it makes any external command fail; the hook must still print the clock.
OUT="$(printf '{"prompt":"hello"}' | PATH=/nonexistent AIGENT_ROOT="$WORK/none" "$BASH" "$HOOK" 2>&1)"
[[ "$OUT" == \[CLOCK\]* ]] || fail "the synchronous path needed an external command: $OUT"
printf '[2/%d] the synchronous path uses bash built-ins only\n' "$TOTAL"

# 3. It runs the install's memory capture, detached, with the prompt on stdin.
FAKE="$WORK/install"
mkdir -p "$FAKE/daemons" "$FAKE/memory"
cat > "$FAKE/daemons/memory-capture.sh" <<'EOF'
#!/bin/bash
sleep 2
cat > "$AIGENT_ROOT/memory/captured.json"
EOF
t0=$(date +%s)
printf '{"prompt":"remember that the gate is X"}' | AIGENT_ROOT="$FAKE" bash "$HOOK" >/dev/null
t1=$(date +%s)
(( t1 - t0 < 2 )) || fail "the hook waited for the capture ($((t1 - t0)) s)"
for _ in $(seq 1 30); do [[ -s "$FAKE/memory/captured.json" ]] && break; sleep 0.5; done
grep -q 'remember that the gate is X' "$FAKE/memory/captured.json" || fail "the capture did not receive the prompt"
printf '[3/%d] memory capture runs detached and receives the prompt\n' "$TOTAL"

# 4. A capture that fails never fails the prompt.
printf '#!/bin/bash\nexit 7\n' > "$FAKE/daemons/memory-capture.sh"
printf '{"prompt":"x"}' | AIGENT_ROOT="$FAKE" bash "$HOOK" >/dev/null || fail "a failing capture failed the hook"
printf '[4/%d] a failing capture never fails the prompt\n' "$TOTAL"

# 5. The settings template wires this hook and no longer wires Caddy.
TEMPLATE="$ROOT/.claude/settings.json.template"
grep -q 'daemons/prompt-context.sh' "$TEMPLATE" || fail "template does not wire prompt-context.sh"
grep -qE 'daemons/caddy(-detect-new-skill)?\.sh' "$TEMPLATE" && fail "template still wires a Caddy hook"
printf '[5/%d] the template wires prompt-context.sh and no Caddy hook\n' "$TOTAL"

printf 'PASS: %d/%d prompt-context scenarios\n' "$TOTAL" "$TOTAL"
