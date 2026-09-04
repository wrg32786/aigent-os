#!/usr/bin/env bash
# memory-root.sh -- the shell door to daemons/memory-root.cjs.
#
# Source this file and call aigent_memory_root. It does not decide where the
# memory tree is: whenever node is available it asks daemons/memory-root.cjs,
# the one resolver every core reader and writer shares, and prints exactly
# what the resolver printed. The only rule it carries of its own is the
# no-node fallback for an UNDECLARED install, which must stay byte-for-byte
# the resolver's default rule (first existing of vault/memory, memory; else
# vault/memory) and is pinned to it by daemons/tests/memory-root.test.mjs. A
# DECLARED root with no node to resolve it is refused, never guessed: the
# shell daemons that call this are best-effort, and a wrong tree is worse
# than a skipped hint.
#
#   aigent_memory_root <base> [--relative] [--allow-missing] [--ledgers] [--with-ledgers]
#
# Prints the path on stdout and returns 0, or prints one MEMORY-ROOT: line on
# stderr and returns 1. The node binary is found on PATH like everywhere else
# in core; callers that must keep working with node absent (the capture hook,
# for one) get the undeclared default and refuse only a declaration.

aigent_memory_root() {
  local base="" relative=0 allow_missing=0 ledgers=0 with_ledgers=0 arg
  local here
  here=$(dirname "${BASH_SOURCE[0]}")
  here=$(cd "$here" && pwd)
  # --default: the resolver's default relative root, and nothing else. The
  # no-node spelling below is the one literal this file carries, pinned to
  # the resolver's by test.
  if [ "$#" -eq 1 ] && [ "$1" = "--default" ]; then
    if command -v node >/dev/null 2>&1; then node "$here/memory-root.cjs" --default; return $?; fi
    printf 'vault/memory\n'
    return 0
  fi
  for arg in "$@"; do
    case "$arg" in
      --relative) relative=1 ;;
      --allow-missing) allow_missing=1 ;;
      --ledgers) ledgers=1 ;;
      --with-ledgers) with_ledgers=1 ;;
      --*) printf 'MEMORY-ROOT: unknown argument: %s\n' "$arg" >&2; return 1 ;;
      *) if [ -n "$base" ]; then printf 'MEMORY-ROOT: base given twice\n' >&2; return 1; fi; base="$arg" ;;
    esac
  done
  if [ -z "$base" ]; then
    printf 'MEMORY-ROOT: a base directory is required to resolve the memory root\n' >&2
    return 1
  fi
  if command -v node >/dev/null 2>&1; then
    local args=(--root "$base")
    [ "$relative" -eq 1 ] && args+=(--relative)
    [ "$allow_missing" -eq 1 ] && args+=(--allow-missing)
    [ "$ledgers" -eq 1 ] && args+=(--ledgers)
    [ "$with_ledgers" -eq 1 ] && args+=(--with-ledgers)
    node "$here/memory-root.cjs" "${args[@]}"
    return $?
  fi
  local marker="$base/.aigent/state.json"
  if [ -f "$marker" ] && grep -q '"memory_root"' "$marker" 2>/dev/null; then
    printf 'MEMORY-ROOT: %s declares memory_root but node is not available to resolve it\n' "$marker" >&2
    return 1
  fi
  # Undeclared, no node: the resolver's own default rule, and nothing else.
  # The skill ledgers of an undeclared install live in the <base>/memory seed
  # tree when it exists, exactly as the resolver answers --ledgers.
  local candidate memory_rel="vault/memory" ledgers_rel
  for candidate in vault/memory memory; do
    if [ -d "$base/$candidate" ]; then memory_rel="$candidate"; break; fi
  done
  ledgers_rel="$memory_rel"
  [ -d "$base/memory" ] && ledgers_rel="memory"
  _aigent_mr_print() {
    if [ "$relative" -eq 1 ]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$base" "$1"; fi
  }
  if [ "$with_ledgers" -eq 1 ]; then
    _aigent_mr_print "$memory_rel"
    _aigent_mr_print "$ledgers_rel"
  elif [ "$ledgers" -eq 1 ]; then
    _aigent_mr_print "$ledgers_rel"
  else
    _aigent_mr_print "$memory_rel"
  fi
  unset -f _aigent_mr_print
  return 0
}
