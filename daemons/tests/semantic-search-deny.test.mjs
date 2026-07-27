// semantic-search-deny.test.mjs -- confidential-class deny-list regression guard.
//
// Proves the contract of daemons/semantic-search/deny-list.mjs, the shared module
// embed-vault.js (index-build time) and search-vault.js (query time) both call
// before touching the vault or the model:
//   - deniedPath() denies a fixture path matching a configured prefix, case- and
//     slash-insensitively
//   - deniedPath() allows a fixture path that does NOT match any prefix (both
//     directions proven -- a deny list that denies everything is not evidence)
//   - loadDenyPrefixes() parses the real shipped index-deny.json (ships with an
//     empty deny_prefixes array, so a fresh install can build an index at all)
//   - loadDenyPrefixes() parses index-deny.example.json and its illustrative
//     prefixes actually deny the paths they claim to (the example isn't decorative)
//   - requireDenyPrefixes() -- the exact fail-closed gate both call sites use --
//     exits(1) when index-deny.json is missing or malformed, and returns the
//     parsed list (no exit) when it is present and valid
//
// Deliberately does NOT spawn embed-vault.js / search-vault.js as child processes:
// both top-level `import '@xenova/transformers'`, which install.sh only installs
// with --ignore-scripts as an OPTIONAL step (not part of this repo's default CI
// install), so a subprocess test would fail on MODULE_NOT_FOUND in CI regardless
// of deny-list behavior. requireDenyPrefixes() was factored out of both files
// specifically so the exact fail-closed code path they run is testable without
// that dependency -- see the wiring check at the bottom, which greps the two
// call sites for the exact call rather than executing them.
//
// Run: node daemons/tests/semantic-search-deny.test.mjs (exit 0 = PASS)

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { deniedPath, loadDenyPrefixes, requireDenyPrefixes } from '../semantic-search/deny-list.mjs';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEM = path.join(DAEMONS, 'semantic-search');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };

// Run a function with process.exit(1) trapped instead of actually killing the
// test process; returns { exited, code, returned }.
function trapExit(fn) {
  const real = process.exit;
  let exited = false, code = null;
  process.exit = (c) => { exited = true; code = c; throw new Error('__trapped_exit__'); };
  try {
    const returned = fn();
    process.exit = real;
    return { exited, code, returned };
  } catch (e) {
    process.exit = real;
    if (e && e.message === '__trapped_exit__') return { exited, code, returned: undefined };
    throw e;
  }
}

// ── 1. deniedPath(): both directions ──────────────────────────────────────────
const fixturePrefixes = ['projects/confidential-client-example', 'concepts/nda-deal-example'];

check(
  'deniedPath: denies a matching fixture (exact case)',
  deniedPath(fixturePrefixes, 'projects/confidential-client-example/deal-notes.md') === true,
);
check(
  'deniedPath: denies a matching fixture case-insensitively',
  deniedPath(fixturePrefixes, 'Projects/Confidential-Client-Example/deal-notes.md') === true,
);
check(
  'deniedPath: denies a matching fixture with backslash separators',
  deniedPath(fixturePrefixes, 'projects\\confidential-client-example\\deal-notes.md') === true,
);
check(
  'deniedPath: allows a fixture path that does not match any prefix',
  deniedPath(fixturePrefixes, 'projects/public-roadmap/notes.md') === false,
);
check(
  'deniedPath: allows a sibling path that only shares a partial prefix (not a folder boundary)',
  deniedPath(fixturePrefixes, 'projects/confidential-client-example-unrelated-file.md') === true,
  'documents the current startsWith semantics: a prefix match, not a path-segment match -- see HONEST BOUNDS',
);

// ── 2. loadDenyPrefixes(): the real shipped file ships empty ──────────────────
const shippedPrefixes = loadDenyPrefixes(SEM);
check('loadDenyPrefixes: real index-deny.json parses', Array.isArray(shippedPrefixes));
check('loadDenyPrefixes: real index-deny.json ships empty (fresh installs are not silently gutted)', shippedPrefixes.length === 0);

// ── 3. loadDenyPrefixes(): the example file's prefixes actually deny what they claim ──
const examplePrefixes = loadDenyPrefixes(SEM, 'index-deny.example.json');
check('loadDenyPrefixes: example file parses and is non-empty', Array.isArray(examplePrefixes) && examplePrefixes.length > 0);
check(
  'example prefix denies its own illustrative path',
  deniedPath(examplePrefixes, 'projects/Client-Confidential-Example/notes.md') === true,
);
check(
  'example prefixes do not deny an unrelated path',
  deniedPath(examplePrefixes, 'projects/aigent-os-launch-plan.md') === false,
);

// ── 4. requireDenyPrefixes(): RED — missing file fails closed ────────────────
const tmpMissing = mkdtempSync(path.join(os.tmpdir(), 'deny-list-test-missing-'));
{
  const { exited, code, returned } = trapExit(() => requireDenyPrefixes(tmpMissing, 'test'));
  check('RED: requireDenyPrefixes exits(1) when index-deny.json is absent', exited === true && code === 1);
  check('RED: requireDenyPrefixes does not return a value when it exits', returned === undefined);
}
rmSync(tmpMissing, { recursive: true, force: true });

// ── 5. requireDenyPrefixes(): RED — malformed file fails closed ──────────────
const tmpMalformed = mkdtempSync(path.join(os.tmpdir(), 'deny-list-test-malformed-'));
writeFileSync(path.join(tmpMalformed, 'index-deny.json'), '{ "deny_prefixes": "not-an-array" }');
{
  const { exited, code } = trapExit(() => requireDenyPrefixes(tmpMalformed, 'test'));
  check('RED: requireDenyPrefixes exits(1) when deny_prefixes is not an array', exited === true && code === 1);
}
writeFileSync(path.join(tmpMalformed, 'index-deny.json'), 'not even json');
{
  const { exited, code } = trapExit(() => requireDenyPrefixes(tmpMalformed, 'test'));
  check('RED: requireDenyPrefixes exits(1) on unparseable JSON', exited === true && code === 1);
}
rmSync(tmpMalformed, { recursive: true, force: true });

// ── 6. requireDenyPrefixes(): GREEN — restore, valid file passes ─────────────
const tmpValid = mkdtempSync(path.join(os.tmpdir(), 'deny-list-test-valid-'));
writeFileSync(path.join(tmpValid, 'index-deny.json'), JSON.stringify({ deny_prefixes: ['projects/x'] }));
{
  const { exited, returned } = trapExit(() => requireDenyPrefixes(tmpValid, 'test'));
  check('GREEN (after restore): requireDenyPrefixes does not exit when the file is valid', exited === false);
  check('GREEN (after restore): requireDenyPrefixes returns the normalized prefix array', Array.isArray(returned) && returned[0] === 'projects/x');
}
rmSync(tmpValid, { recursive: true, force: true });

// ── 7. Wiring check: both call sites actually use the fail-closed gate ───────
// Structural, not behavioral (see file header for why) -- proves embed-vault.js
// and search-vault.js each call requireDenyPrefixes(__dirname, ...) at module
// load time (before main()/args parsing), and each also re-filter their working
// set with deniedPath(). A regression here (e.g. someone inlines a "denyPrefixes
// || []" fallback that silently no-ops the gate) fails this check even though
// requireDenyPrefixes() itself still tests green above.
for (const [file, label] of [['embed-vault.js', 'embed-vault'], ['search-vault.js', 'search-vault']]) {
  const src = readFileSync(path.join(SEM, file), 'utf8');
  check(`${file}: imports requireDenyPrefixes from deny-list.mjs`, /import\s*\{[^}]*requireDenyPrefixes[^}]*\}\s*from\s*['"]\.\/deny-list\.mjs['"]/.test(src));
  check(`${file}: calls requireDenyPrefixes(__dirname, '${label}')`, src.includes(`requireDenyPrefixes(__dirname, '${label}')`));
  check(`${file}: filters its working set with deniedPath(DENY_PREFIXES, ...)`, /deniedPath\(DENY_PREFIXES,/.test(src));
  // The gate must run before main() executes (fail-closed at load, not first-use).
  const gateIdx = src.indexOf('requireDenyPrefixes(__dirname');
  const mainCallIdx = src.lastIndexOf('main()');
  check(`${file}: fail-closed gate runs before main() is invoked`, gateIdx !== -1 && mainCallIdx !== -1 && gateIdx < mainCallIdx);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
