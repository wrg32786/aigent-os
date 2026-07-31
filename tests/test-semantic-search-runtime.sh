#!/usr/bin/env bash
# Clean-install RUNTIME test for the optional semantic-search feature.
#
# ── WHY A RUNTIME TEST AND NOT AN INSTALL TEST ────────────────────────────────
# The defect this exists to catch: `npm ci/install --ignore-scripts` EXITS 0
# while sharp's native binary is never built, and @xenova/transformers imports
# sharp at module top level -- so the dependency install "succeeds", install.sh
# prints "[ok] Semantic search dependencies installed", and the advertised
# feature cannot load at all. Measured 2026-07-30 on win32-x64 / node 24.15.0:
#   npm install --silent --ignore-scripts   -> exit 0
#   import('@xenova/transformers')          -> Cannot find module
#                                              '../build/Release/sharp-win32-x64.node'
# An installer that checks npm's exit code learns NOTHING about this. The only
# check that can see it is running the feature.
#
# ⚑ AND IT ASSERTS AN EMBEDDING, NOT AN IMPORT. A successful import proves the
# module graph resolves; it does not prove the pipeline runs. "It loads" and
# "it works" are different claims and this file makes the stronger one, because
# the whole row is about a green signal that outran what it measured.
#
# NETWORK: this test installs from the npm registry and downloads the MiniLM
# model from the HF CDN. It is deliberately NOT in tests/test-installer-fast.sh
# (the CI gate, which must stay hermetic and fast) -- same split as
# tests/test-installer-slow-smoke.sh.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

PKG_DIR="$ROOT/daemons/semantic-search"
[[ -f "$PKG_DIR/package.json" ]] || fail "no daemons/semantic-search/package.json at $ROOT"

# A SKIP here is LOUD and distinguishable from a pass. The failure mode this row
# documents is a green that meant "never looked"; a silent skip would recreate it.
if ! command -v node >/dev/null 2>&1; then
  printf 'SKIP: node not found -- semantic search is optional and was not exercised.\n'
  printf '      This is NOT a pass. Nothing about the feature was measured.\n'
  exit 0
fi
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || ((NODE_MAJOR < 18)); then
  printf 'SKIP: node 18+ required, found %s -- nothing measured.\n' "$(node --version)"
  exit 0
fi

# Reproduce the installer's own steps exactly: copy the package manifest, then
# run THE SAME command install.sh runs. Copying rather than installing in-tree
# keeps a developer's working node_modules out of the result -- otherwise this
# test would pass on a machine where the feature was installed WITH scripts and
# prove nothing about a clean install.
cp "$PKG_DIR/package.json" "$WORK/package.json"
[[ -f "$PKG_DIR/package-lock.json" ]] && cp "$PKG_DIR/package-lock.json" "$WORK/package-lock.json"

printf '  Installing with the installer\x27s own flags (--ignore-scripts)...\n'
(
  cd "$WORK"
  if [[ -f package-lock.json ]]; then
    npm ci --silent --ignore-scripts
  else
    npm install --silent --ignore-scripts
  fi
) || fail "dependency install itself failed (a different defect than this test targets)"

# THE ASSERTION. Runs the feature end to end and prints the embedding width, so
# a pass carries evidence rather than just a zero exit.
printf '  Running a real embedding on the clean install...\n'
cat > "$WORK/probe.mjs" <<'PROBE'
const { pipeline, env } = await import('@xenova/transformers');
env.allowLocalModels = false;
const extract = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const out = await extract('semantic search works', { pooling: 'mean', normalize: true });
if (!out?.data?.length) throw new Error('pipeline returned no embedding data');
console.log(`EMBED_OK dims=${out.data.length}`);
PROBE

if ! OUT="$(cd "$WORK" && node probe.mjs 2>&1)"; then
  printf '%s\n' "$OUT" >&2
  fail "semantic search cannot RUN on a clean --ignore-scripts install.
      npm exited 0, so install.sh reports
      '[ok] Semantic search dependencies installed', while the advertised
      feature is dead. Fix the install (see daemons/semantic-search/package.json
      overrides) or make install.sh degrade loudly -- never report it installed."
fi

printf '%s\n' "$OUT" | grep -q 'EMBED_OK dims=[0-9]' \
  || fail "probe did not produce an embedding; got: $OUT"

printf '  [ok] %s\n' "$(printf '%s\n' "$OUT" | grep 'EMBED_OK')"
printf 'PASS: semantic search installs AND runs under --ignore-scripts.\n'
printf 'VANTAGE: %s / node %s / npm %s\n' \
  "$(node -p 'process.platform + "-" + process.arch')" "$(node --version)" "$(npm --version)"
