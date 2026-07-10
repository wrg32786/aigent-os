#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir -p "$WORK"/{.claude,.aigent/cache,memory,daemons}

cat > "$WORK/.claude/skill-index.json" <<'JSON'
[
  {
    "name": "review",
    "triggers": ["review repo", "repository"],
    "why": "Review a repository"
  }
]
JSON
cat > "$WORK/memory/SKILL_LEDGER.md" <<'LEDGER'
- `research.code.review` — repository architecture and quality review — `/review`
LEDGER

printf '%s' '{"session_id":"abc","prompt":"please review repo architecture"}' \
  | AIGENT_ROOT="$WORK" bash "$ROOT/daemons/caddy.sh" > "$WORK/match.out"
grep -F '[CADDY] /review' "$WORK/match.out" >/dev/null
! grep -F 'ROUTE' "$WORK/match.out" >/dev/null

printf '%s' '{"session_id":"abc","prompt":"utterly unmatched qzxv"}' \
  | AIGENT_ROOT="$WORK" bash "$ROOT/daemons/caddy.sh" > "$WORK/gap-one.out"
printf '%s' '{"session_id":"abc","prompt":"another unmatched plmokn"}' \
  | AIGENT_ROOT="$WORK" bash "$ROOT/daemons/caddy.sh" > "$WORK/gap-two.out"
grep -F 'No skill match' "$WORK/gap-one.out" >/dev/null
test ! -s "$WORK/gap-two.out"
test -f "$WORK/.aigent/cache/caddy-gap-abc"

printf '%s' '{"session_id":"routing","prompt":"hello"}' \
  | AIGENT_ROOT="$WORK" AIGENT_ROUTING_REMINDER=1 bash "$ROOT/daemons/caddy.sh" > "$WORK/routing.out"
grep -F '[CADDY:routing] ROUTE' "$WORK/routing.out" >/dev/null

printf 'caddy regression tests passed\n'
