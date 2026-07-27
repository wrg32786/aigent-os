/**
 * deny-list.mjs
 * Shared confidential-class deny-list logic for embed-vault.js (index-build time)
 * and search-vault.js (query time). Split into its own module so the two call
 * sites can't drift out of sync on what "denied" means.
 *
 * Contract, in two halves:
 *
 *   - index-deny.json ABSENT is the fresh-install state. The file is gitignored
 *     (it holds the operator's real folder names, which must never reach a
 *     commit), so a clean clone does not have one. Absent means "no prefixes
 *     configured": index and search proceed over everything, with a notice on
 *     stderr pointing at index-deny.example.json. This is the same behavior the
 *     shipped empty deny_prefixes array used to give.
 *
 *   - index-deny.json PRESENT but unusable (unreadable, malformed JSON,
 *     deny_prefixes not an array) is a THROW, and both call sites turn that into
 *     process.exit(1). An operator who wrote a deny list must never get an
 *     unfiltered index because a typo made it unparseable.
 *
 * Matching is a case-insensitive, separator-normalized startsWith. That
 * deliberately over-denies: prefix 'projects/acme-deal' also denies the sibling
 * 'projects/acme-deal-backup.md'. Over-denial costs a search result; the
 * path-segment-aware alternative would let an adjacent copy of confidential
 * material through, which costs the whole point of the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load and normalize deny_prefixes from <dir>/<denyFileName>.
 * Returns null if the file does not exist (no list configured), an array of
 * normalized prefixes if it parses, and throws on anything in between: an
 * unreadable file, unparseable JSON, or a non-array deny_prefixes.
 */
export function loadDenyPrefixes(dir, denyFileName = 'index-deny.json') {
  const denyPath = join(dir, denyFileName);
  let text;
  try {
    text = readFileSync(denyPath, 'utf8');
  } catch (e) {
    // Absent is the fresh-install state. Every other read failure (permissions,
    // a directory in its place, I/O error) means a list may exist and we cannot
    // see it, which has to fail closed.
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const raw = JSON.parse(text);
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
 * loadDenyPrefixes(dir), resolved to an array the callers can always use:
 * exits(1) if a deny file exists but cannot be used, returns [] with a notice if
 * none is configured. This is the single gate embed-vault.js and search-vault.js
 * both call before doing anything else. The notice goes to stderr so it can
 * never corrupt search-vault.js's --json output on stdout.
 */
export function requireDenyPrefixes(dir, label) {
  let prefixes;
  try {
    prefixes = loadDenyPrefixes(dir);
  } catch (e) {
    console.error(`[${label}] REFUSING to run: ${join(dir, 'index-deny.json')} exists but cannot be used (${e.message}). An unfiltered index or search would expose confidential-class notes to anyone who can reach it. Fix the file, or delete it to index everything deliberately. See index-deny.example.json.`);
    process.exit(1);
  }
  if (prefixes === null) {
    console.error(`[${label}] No index-deny.json in ${dir}: indexing and searching everything. To keep client work, deal notes, or anything under NDA out of the index, copy index-deny.example.json to index-deny.json and list your vault-relative path prefixes. That file is gitignored and stays on this machine.`);
    return [];
  }
  return prefixes;
}
