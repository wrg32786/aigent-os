/**
 * deny-list.mjs
 * Shared fail-closed confidential-class deny-list logic for embed-vault.js
 * (index-build time) and search-vault.js (query time). Split into its own module
 * so it can be unit-tested without pulling in @xenova/transformers, and so the two
 * call sites can't drift out of sync on what "denied" means.
 *
 * Contract: no deny list (missing file, unreadable, malformed JSON, or
 * deny_prefixes not an array) is a THROW, not a silent empty list. Both call
 * sites treat the throw as fatal (process.exit(1)) -- an unfiltered index or
 * an unfiltered search is worse than refusing to run at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load and normalize deny_prefixes from <dir>/<denyFileName>.
 * Throws on missing/unreadable/malformed input -- callers must fail closed.
 */
export function loadDenyPrefixes(dir, denyFileName = 'index-deny.json') {
  const denyPath = join(dir, denyFileName);
  const raw = JSON.parse(readFileSync(denyPath, 'utf8'));
  if (!Array.isArray(raw.deny_prefixes)) throw new Error('deny_prefixes missing or not an array');
  return raw.deny_prefixes.map((p) => String(p).replace(/\\/g, '/').toLowerCase());
}

/**
 * True if `p` (a vault-relative path) starts with any denied prefix.
 * Case-insensitive; normalizes '\\' to '/' on both sides so Windows and
 * POSIX-built indexes agree.
 */
export function deniedPath(prefixes, p) {
  const s = String(p).replace(/\\/g, '/').toLowerCase();
  return prefixes.some((d) => s.startsWith(d));
}

/**
 * loadDenyPrefixes(dir), but fail-closed at the process level: on any load
 * error, prints a labeled explanation and calls process.exit(1) instead of
 * returning. This is the single fail-closed gate embed-vault.js (index-build
 * time) and search-vault.js (query time) both call before doing anything else --
 * factored out so the exact fail-closed behavior is unit-testable without
 * either caller's own heavy @xenova/transformers import.
 */
export function requireDenyPrefixes(dir, label) {
  try {
    return loadDenyPrefixes(dir);
  } catch (e) {
    console.error(`[${label}] REFUSING to run: cannot load ${join(dir, 'index-deny.json')} (${e.message}). An unfiltered index/search would expose confidential-class notes to anyone who can reach it. See index-deny.example.json.`);
    process.exit(1);
  }
}
