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
TOTAL=11
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
#    Bash 3.2 (macOS /bin/bash) has no printf %(...)T, so the hook uses one date call there by
#    design, where process starts are cheap; this scenario applies to bash 4.2+ only.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 2) )); then
  OUT="$(printf '{"prompt":"hello"}' | PATH=/nonexistent AIGENT_ROOT="$WORK/none" "$BASH" "$HOOK" 2>&1)"
  [[ "$OUT" == \[CLOCK\]* ]] || fail "the synchronous path needed an external command: $OUT"
  printf '[2/%d] the synchronous path uses bash built-ins only\n' "$TOTAL"
else
  printf '[2/%d] skipped on bash %s: no printf %%(...)T, the clock uses one date call\n' "$TOTAL" "$BASH_VERSION"
fi

# 3. It runs the install's memory capture, detached, with the prompt on stdin.
FAKE="$WORK/install"
mkdir -p "$FAKE/daemons" "$FAKE/memory"
# Deterministic, not timed: the fake capture blocks until the test creates a release file, which
# it does only AFTER the hook has returned. A hook that waited for its capture would never return,
# and the 30 s bound fails it. (A wall-clock bound failed under load: process starts alone took 7 s.)
# The bound is a portable poll, not timeout(1), which macOS does not ship.
cat > "$FAKE/daemons/memory-capture.sh" <<'EOF'
#!/bin/bash
input=$(cat)
while [ ! -f "$AIGENT_ROOT/memory/release" ]; do sleep 0.2; done
printf '%s' "$input" > "$AIGENT_ROOT/memory/captured.json"
EOF
printf '{"prompt":"remember that the gate is X"}' > "$WORK/prompt.json"
AIGENT_ROOT="$FAKE" bash "$HOOK" < "$WORK/prompt.json" > /dev/null &
HOOK_PID=$!
for _ in $(seq 1 150); do kill -0 "$HOOK_PID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$HOOK_PID" 2>/dev/null; then
  kill "$HOOK_PID" 2>/dev/null; : > "$FAKE/memory/release"
  fail "the hook did not return while its capture was still running (it waited for the capture)"
fi
wait "$HOOK_PID" || fail "the hook exited non-zero"
[[ -e "$FAKE/memory/captured.json" ]] && fail "the capture finished before release: it did not run detached"
: > "$FAKE/memory/release"
for _ in $(seq 1 60); do [[ -s "$FAKE/memory/captured.json" ]] && break; sleep 0.5; done
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

# 6. A notice from the capture reaches the session on the next prompt, once.
FAKE2="$WORK/install2"
mkdir -p "$FAKE2/daemons" "$FAKE2/memory"
cat > "$FAKE2/daemons/memory-capture.sh" <<'EOF'
#!/bin/bash
cat >/dev/null
echo '[memory] CAP: test notice'
: > "$AIGENT_ROOT/memory/ran"
EOF
printf '{"prompt":"x"}' | AIGENT_ROOT="$FAKE2" bash "$HOOK" >/dev/null
for _ in $(seq 1 60); do [[ -e "$FAKE2/memory/ran" && -s "$FAKE2/.aigent/capture-notices" ]] && break; sleep 0.5; done
printf '#!/bin/bash\ncat >/dev/null\n' > "$FAKE2/daemons/memory-capture.sh"
OUT="$(printf '{"prompt":"y"}' | AIGENT_ROOT="$FAKE2" bash "$HOOK")"
grep -q '^\[memory\] CAP: test notice$' <<<"$OUT" || fail "the notice did not reach the next prompt: $OUT"
OUT="$(printf '{"prompt":"z"}' | AIGENT_ROOT="$FAKE2" bash "$HOOK")"
grep -q 'test notice' <<<"$OUT" && fail "the notice was shown twice: $OUT"
printf '[6/%d] a capture notice is shown on the next prompt, once\n' "$TOTAL"

# 7. A capture that crashes leaves a trace.
printf '#!/bin/bash\necho capture-crash-marker >&2\nexit 3\n' > "$FAKE2/daemons/memory-capture.sh"
printf '{"prompt":"x"}' | AIGENT_ROOT="$FAKE2" bash "$HOOK" >/dev/null
for _ in $(seq 1 60); do grep -q capture-crash-marker "$FAKE2/.aigent/capture-errors.log" 2>/dev/null && break; sleep 0.5; done
grep -q capture-crash-marker "$FAKE2/.aigent/capture-errors.log" || fail "a capture crash left no trace"
printf '[7/%d] a capture crash reaches the error log\n' "$TOTAL"

# 8. A bare invocation from inside daemons/, with no AIGENT_ROOT, still captures.
FAKE3="$WORK/install3"
mkdir -p "$FAKE3/daemons" "$FAKE3/memory"
cp "$HOOK" "$FAKE3/daemons/prompt-context.sh"
printf '#!/bin/bash\ncat > "$AIGENT_ROOT/memory/bare.json"\n' > "$FAKE3/daemons/memory-capture.sh"
(cd "$FAKE3/daemons" && printf '{"prompt":"bare"}' | env -u AIGENT_ROOT bash prompt-context.sh >/dev/null)
for _ in $(seq 1 60); do [[ -s "$FAKE3/memory/bare.json" ]] && break; sleep 0.5; done
grep -q bare "$FAKE3/memory/bare.json" 2>/dev/null || fail "a bare invocation never captured"
printf '[8/%d] a bare invocation with no AIGENT_ROOT captures\n' "$TOTAL"

# 9. What Caddy left behind stays gone: every core skill system-check requires exists, and nothing
#    the install runs still emits a Caddy tag or banner.
CORE="$(sed -n '/^CORE_SKILLS=(/,/^)/p' "$ROOT/daemons/system-check.sh" | sed '1d;$d')"
for skill in $CORE; do
  [[ -f "$ROOT/skills/$skill/SKILL.md" ]] || fail "system-check requires a skill that does not ship: $skill"
done
grep -rlE '\[CADDY|Router: NOT WIRED|CADDY_MUTES' "$ROOT/daemons" --include='*.sh' --include='*.py' --include='*.mjs' --include='*.cjs' --exclude-dir=tests --exclude-dir=node_modules > "$WORK/caddy-left" || true
[[ ! -s "$WORK/caddy-left" ]] || fail "Caddy output is still emitted by: $(cat "$WORK/caddy-left")"
printf '[9/%d] system-check requires only shipped skills, and no daemon emits Caddy output\n' "$TOTAL"

# 10. A notice is rendered inert: control and line-separator characters go, lines and length are capped.
FAKE4="$WORK/install4"
mkdir -p "$FAKE4/.aigent"
{
  printf 'esc\033[31mred sep\xe2\x80\xa8tail\n'
  printf 'L%.0s' $(seq 1 700); printf '\n'
  for n in 3 4 5 6 7; do printf 'line%s\n' "$n"; done
} > "$FAKE4/.aigent/capture-notices"
OUT="$(printf '{}' | AIGENT_ROOT="$FAKE4" bash "$HOOK")"
[[ "$OUT" != *$'\033'* ]] || fail "an escape character reached the session"
[[ "$OUT" != *$'\xe2\x80\xa8'* ]] || fail "a line separator reached the session"
grep -q 'sep tail' <<<"$OUT" || fail "the notice text was lost: $OUT"
grep -qE '^L{500}$' <<<"$OUT" || fail "a long line was not cut to 500 characters"
grep -q 'line5' <<<"$OUT" || fail "the fifth line was lost"
grep -q 'line6' <<<"$OUT" && fail "more than 5 lines were shown"
[[ ! -s "$FAKE4/.aigent/capture-notices" ]] || fail "shown notices were kept"
printf '[10/%d] notices are inert and capped\n' "$TOTAL"

# 11. The capture error log stays bounded.
FAKE5="$WORK/install5"
mkdir -p "$FAKE5/daemons" "$FAKE5/.aigent" "$FAKE5/memory"
head -c 1100000 /dev/zero | tr '\0' 'x' > "$FAKE5/.aigent/capture-errors.log"
printf '#!/bin/bash\necho newest-error >&2\n' > "$FAKE5/daemons/memory-capture.sh"
printf '{}' | AIGENT_ROOT="$FAKE5" bash "$HOOK" >/dev/null
for _ in $(seq 1 60); do (( $(wc -c <"$FAKE5/.aigent/capture-errors.log") <= 1048576 )) && break; sleep 0.5; done
(( $(wc -c <"$FAKE5/.aigent/capture-errors.log") <= 1048576 )) || fail "the error log was not capped"
grep -q newest-error "$FAKE5/.aigent/capture-errors.log" || fail "capping lost the newest error"
printf '[11/%d] the capture error log stays under its cap\n' "$TOTAL"

printf 'PASS: %d/%d prompt-context scenarios\n' "$TOTAL" "$TOTAL"
