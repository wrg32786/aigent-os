#!/usr/bin/env bash
# Slow smoke test: a REAL install.sh run against this actual repository
# checkout (100+ files across system/, vault/, skills/, hooks/, daemons/,
# scripts/, docs/, memory/, evals/), verified with scripts/doctor.sh. This
# is the one scenario whose wall-clock cost scales with the size of the
# real repo tree rather than a small synthetic fixture, so it is split out
# from tests/test-installer-fast.sh -- a debugging loop or CI gate on the
# fast suite never has to pay this cost to get signal on everything else.
#
# Belt-and-suspenders: proves install.sh works end to end against the real
# tree, not just the synthetic fixture the fast suite uses. Run this async
# / non-blocking; it is not the gate signal, tests/test-installer-fast.sh is.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

printf 'Installing the real repository tree into a fresh target (many mkdir/cp calls against the full checkout -- this is the slow one)...\n'
REAL_TARGET="$WORK/real-target"
bash "$ROOT/install.sh" --target "$REAL_TARGET" --no-deps >/dev/null
printf '[1/2] real-tree install: ok\n'

bash "$REAL_TARGET/scripts/doctor.sh" "$REAL_TARGET" >/dev/null
printf '[2/2] doctor.sh clean: ok\n'

printf 'slow-smoke suite passed (2/2)\n'
