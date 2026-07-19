#!/usr/bin/env bash
# Regenerates the sha256 sidecar files for the remote bootstrap scripts
# (Codex finding #20). Run this whenever scripts/web-install.sh or
# scripts/web-install.ps1 change, before committing.
#
# tests/test-web-install.sh asserts these files match their scripts' current
# content, so a forgotten regeneration fails CI instead of shipping a stale
# checksum silently.
#
# Usage: bash scripts/gen-web-install-checksums.sh

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | cut -d' ' -f1
  else
    printf 'ERROR: neither sha256sum nor shasum found on PATH\n' >&2
    exit 1
  fi
}

for name in web-install.sh web-install.ps1; do
  src="$ROOT/scripts/$name"
  [[ -f "$src" ]] || { printf 'ERROR: %s not found\n' "$src" >&2; exit 1; }
  hash="$(sha256_of "$src")"
  # sha256sum-compatible "<hash>  <filename>" format so `sha256sum -c` works
  # directly against a sidecar downloaded next to the script it verifies.
  printf '%s  %s\n' "$hash" "$name" > "$src.sha256"
  printf '  [ok] %s.sha256 -> %s\n' "$name" "$hash"
done
