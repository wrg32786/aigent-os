// semantic-search-deny.test.mjs -- confidential-class deny-list regression guard.
//
// The property under test is not "the filter is mentioned in the source". It is
// "denied content does not reach the output". embed-vault.js writes note
// excerpts into embeddings.json in PLAINTEXT, so a deny list that is wired up
// but ineffective leaves the confidential text sitting on disk, and a source
// grep would never notice.
//
// So the core of this file runs the two real scripts end to end over a fixture
// vault and asserts on what they actually produce:
//
//   - embed-vault.js: a denied file's text is absent from embeddings.json, and
//     an undenied file's text is present (a filter that drops everything is not
//     evidence either)
//   - embed-vault.js: a denied entry already sitting in a carried-forward index
//     is purged, so adding a prefix after the fact retroactively cleans the file
//   - search-vault.js: a denied entry in a stale hand-built index never reaches
//     stdout, while an undenied entry does
//
// Each of those covers ONE call site independently. Deleting the filter in
// embed-vault.js turns the first two red and leaves the search test green;
// deleting the filter in search-vault.js does the reverse. A fix in one caller
// does not protect a direct call to the other, so neither test stands in for
// the other.
//
// Both scripts top-level `import '@xenova/transformers'`, whose model download
// has no place in CI, and both resolve their deny file relative to their own
// __dirname with no environment override (deliberately: an override would be a
// bypass). So the behavioral tests copy the three real source files into a
// sandbox that has its own index-deny.json and a tiny stub package in
// node_modules. The copies are read from the repo at run time, so any edit to
// the real files is under test; nothing here reads a checked-in duplicate.
//
// Run: node daemons/tests/semantic-search-deny.test.mjs (exit 0 = PASS)

import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

// ── Behavioral harness ───────────────────────────────────────────────────────
// Marker strings that cannot occur anywhere else, so "absent from the output"
// is a real answer rather than a coincidence.
const CONFIDENTIAL = 'CANARY-CONFIDENTIAL-8f21ab-acme-term-sheet-body';
const PUBLIC = 'CANARY-PUBLIC-3c07de-roadmap-body';
const STALE = 'CANARY-STALE-INDEX-5b93cf-already-embedded';
const DENIED_DIR = 'confidential-client-acme';
const DENY_PREFIX = `projects/${DENIED_DIR}`;

// Stand-in for @xenova/transformers: same shape the two scripts use (a pipeline
// factory returning an async embedder whose result has a `data` typed array),
// with a fixed unit vector so scores are deterministic and no model is fetched.
const TRANSFORMERS_STUB = `export async function pipeline() {
  return async () => ({ data: Float32Array.from([1, 0, 0, 0]) });
}
`;

const sandboxes = [];

// Build a sandbox holding verbatim copies of the real scripts, its own deny
// file, a stub transformers package, and a two-note fixture vault.
// denyFileText === null means "no index-deny.json at all" (fresh-install state).
function makeSandbox(name, denyFileText) {
  const root = mkdtempSync(path.join(os.tmpdir(), `deny-behavior-${name}-`));
  sandboxes.push(root);

  const sem = path.join(root, 'daemons', 'semantic-search');
  mkdirSync(sem, { recursive: true });
  for (const file of ['deny-list.mjs', 'embed-vault.js', 'search-vault.js']) {
    copyFileSync(path.join(SEM, file), path.join(sem, file));
  }
  copyFileSync(
    path.join(DAEMONS, 'frontmatter-reader.cjs'),
    path.join(root, 'daemons', 'frontmatter-reader.cjs'),
  );
  if (denyFileText !== null) writeFileSync(path.join(sem, 'index-deny.json'), denyFileText);

  const stub = path.join(root, 'node_modules', '@xenova', 'transformers');
  mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
    name: '@xenova/transformers', version: '0.0.0-test-stub', type: 'module', main: 'index.js',
  }));
  writeFileSync(path.join(stub, 'index.js'), TRANSFORMERS_STUB);

  const vault = path.join(root, 'vault');
  mkdirSync(path.join(vault, 'memory'), { recursive: true });
  mkdirSync(path.join(vault, 'projects', DENIED_DIR), { recursive: true });
  mkdirSync(path.join(vault, 'projects', 'public-roadmap'), { recursive: true });
  writeFileSync(
    path.join(vault, 'projects', DENIED_DIR, 'term-sheet.md'),
    `# Acme term sheet\n\n${CONFIDENTIAL}. Signing bonus, exclusivity window, and the rest of the terms nobody outside the deal should be able to search for.\n`,
  );
  writeFileSync(
    path.join(vault, 'projects', 'public-roadmap', 'roadmap.md'),
    `# Public roadmap\n\n${PUBLIC}. Ordinary planning notes that should stay searchable, so a filter that drops everything fails this fixture too.\n`,
  );

  return { root, sem, vault, embeddings: path.join(vault, 'memory', 'embeddings.json') };
}

function run(sandbox, script, args = []) {
  const r = spawnSync(process.execPath, [path.join(sandbox.sem, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, AIGENT_ROOT: sandbox.root, AIGENT_VAULT_ROOT: sandbox.vault },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', all: `${r.stdout || ''}${r.stderr || ''}` };
}

const validDeny = JSON.stringify({ deny_prefixes: [DENY_PREFIX] });

// A hand-built index standing in for one written before the prefix existed, or
// by an embed-vault.js that never filtered at all.
function staleIndex(deniedChunk) {
  return JSON.stringify({
    model: 'Xenova/all-MiniLM-L6-v2',
    updated: '2020-01-01T00:00:00.000Z',
    entryCount: 2,
    notes: [
      // Scores 1.0 against the stub's query vector, so unfiltered it ranks first.
      { path: `${DENY_PREFIX}/term-sheet.md`, title: 'Acme term sheet', tags: [], chunk: deniedChunk, embedding: [1, 0, 0, 0], mtime: 0 },
      { path: 'projects/public-roadmap/roadmap.md', title: 'Public roadmap', tags: [], chunk: PUBLIC, embedding: [0, 1, 0, 0], mtime: 0 },
    ],
  });
}

// ── 1. BEHAVIOR: embed-vault.js keeps denied text out of embeddings.json ─────
// The index-build call site, proven on the artifact itself. Deleting the
// deniedPath() filter in collectFiles() turns this red.
{
  const box = makeSandbox('embed', validDeny);
  const r = run(box, 'embed-vault.js');
  check('embed-vault: exits 0 over the fixture vault', r.status === 0, r.stderr.slice(0, 300));
  const raw = existsSync(box.embeddings) ? readFileSync(box.embeddings, 'utf8') : '';
  check('embed-vault: wrote an index', raw.length > 0);
  check('embed-vault: denied file text is ABSENT from embeddings.json', !raw.includes(CONFIDENTIAL));
  check('embed-vault: undenied file text IS present (the filter is not just dropping everything)', raw.includes(PUBLIC));
  const notes = raw ? JSON.parse(raw).notes : [];
  check('embed-vault: no indexed entry has a denied path', notes.length > 0 && notes.every((n) => !n.path.toLowerCase().startsWith(DENY_PREFIX)));
}

// ── 2. BEHAVIOR: embed-vault.js purges an already-indexed denied entry ───────
// The second index-build call site: a prefix added after the fact has to clean
// the carried-forward index, not merely skip new files. Deleting the purge
// filter over existing.notes turns this red.
{
  const box = makeSandbox('embed-purge', validDeny);
  writeFileSync(box.embeddings, staleIndex(STALE));
  const r = run(box, 'embed-vault.js');
  check('embed-vault (purge): exits 0 over a carried-forward index', r.status === 0, r.stderr.slice(0, 300));
  const raw = readFileSync(box.embeddings, 'utf8');
  check('embed-vault (purge): previously-indexed denied text is GONE from embeddings.json', !raw.includes(STALE));
  check('embed-vault (purge): undenied content survived the purge', raw.includes(PUBLIC));
}

// ── 3. BEHAVIOR: search-vault.js never returns denied content ───────────────
// The query-time call site, proven against a stale index that still contains the
// denied entry. Deleting the deniedPath() filter over index.notes turns this
// red, and leaves the two embed-vault tests above green.
{
  const box = makeSandbox('search', validDeny);
  writeFileSync(box.embeddings, staleIndex(CONFIDENTIAL));
  const r = run(box, 'search-vault.js', ['acme term sheet']);
  check('search-vault: exits 0 against a stale index', r.status === 0, r.stderr.slice(0, 300));
  check('search-vault: denied chunk text never reaches the output', !r.all.includes(CONFIDENTIAL));
  check('search-vault: denied path never reaches the output', !r.all.toLowerCase().includes(DENIED_DIR));
  check('search-vault: the undenied entry IS returned (results are not simply empty)', r.stdout.includes(PUBLIC));
}

// ── 4. BEHAVIOR: an unusable deny file stops both scripts, fail-closed ──────
// Proven through the real scripts rather than through the gate in isolation:
// no index is written, and no results are printed.
{
  const box = makeSandbox('malformed-embed', 'not even json');
  const r = run(box, 'embed-vault.js');
  check('embed-vault: exits non-zero when index-deny.json is malformed', r.status === 1);
  check('embed-vault: writes no index at all when the deny file is unusable', !existsSync(box.embeddings));
  check('embed-vault: says why it refused', /REFUSING to run/.test(r.stderr));
}
{
  const box = makeSandbox('malformed-search', '{ "deny_prefixes": "not-an-array" }');
  writeFileSync(box.embeddings, staleIndex(CONFIDENTIAL));
  const r = run(box, 'search-vault.js', ['acme term sheet']);
  check('search-vault: exits non-zero when index-deny.json is malformed', r.status === 1);
  check('search-vault: returns nothing at all rather than an unfiltered result set', !r.all.includes(CONFIDENTIAL) && !r.all.includes(PUBLIC));
}

// ── 5. BEHAVIOR: no deny file is the fresh-install state, not a failure ─────
// index-deny.json is gitignored, so a clean clone has none. That has to index
// everything and say so, or the feature is broken out of the box.
{
  const box = makeSandbox('absent', null);
  const r = run(box, 'embed-vault.js');
  check('embed-vault: exits 0 with no index-deny.json present', r.status === 0, r.stderr.slice(0, 300));
  const raw = existsSync(box.embeddings) ? readFileSync(box.embeddings, 'utf8') : '';
  check('embed-vault: indexes everything when no deny list is configured', raw.includes(PUBLIC) && raw.includes(CONFIDENTIAL));
  check('embed-vault: says on stderr that nothing is being filtered', /No index-deny\.json/.test(r.stderr));
}

// ── 6. deniedPath(): matching semantics, both directions ────────────────────
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
  'deniedPath: allows a path that does not match any prefix',
  deniedPath(fixturePrefixes, 'projects/public-roadmap/notes.md') === false,
);
check(
  'deniedPath: DENIES a sibling that only shares a leading substring',
  deniedPath(fixturePrefixes, 'projects/confidential-client-example-unrelated-file.md') === true,
  'deliberate over-denial: a plain prefix match, not a path-segment match, so an adjacent copy of confidential material cannot slip past',
);

// ── 7. The tracked example file is usable as written ────────────────────────
const examplePrefixes = loadDenyPrefixes(SEM, 'index-deny.example.json');
check('example file parses and is non-empty', Array.isArray(examplePrefixes) && examplePrefixes.length > 0);
check(
  'example prefix denies its own illustrative path',
  deniedPath(examplePrefixes, 'projects/Client-Confidential-Example/notes.md') === true,
);
check(
  'example prefixes do not deny an unrelated path',
  deniedPath(examplePrefixes, 'projects/aigent-os-launch-plan.md') === false,
);

// ── 8. requireDenyPrefixes(): the gate's own contract ───────────────────────
const tmpAbsent = mkdtempSync(path.join(os.tmpdir(), 'deny-list-test-absent-'));
{
  const { exited, returned } = trapExit(() => requireDenyPrefixes(tmpAbsent, 'test'));
  check('requireDenyPrefixes: no deny file is not an error', exited === false);
  check('requireDenyPrefixes: no deny file yields an empty prefix list', Array.isArray(returned) && returned.length === 0);
}
rmSync(tmpAbsent, { recursive: true, force: true });

const tmpMalformed = mkdtempSync(path.join(os.tmpdir(), 'deny-list-test-malformed-'));
writeFileSync(path.join(tmpMalformed, 'index-deny.json'), '{ "deny_prefixes": "not-an-array" }');
{
  const { exited, code } = trapExit(() => requireDenyPrefixes(tmpMalformed, 'test'));
  check('requireDenyPrefixes: exits(1) when deny_prefixes is not an array', exited === true && code === 1);
}
writeFileSync(path.join(tmpMalformed, 'index-deny.json'), 'not even json');
{
  const { exited, code, returned } = trapExit(() => requireDenyPrefixes(tmpMalformed, 'test'));
  check('requireDenyPrefixes: exits(1) on unparseable JSON', exited === true && code === 1);
  check('requireDenyPrefixes: returns nothing when it exits', returned === undefined);
}
rmSync(tmpMalformed, { recursive: true, force: true });

const tmpValid = mkdtempSync(path.join(os.tmpdir(), 'deny-list-test-valid-'));
writeFileSync(path.join(tmpValid, 'index-deny.json'), JSON.stringify({ deny_prefixes: ['projects/x'] }));
{
  const { exited, returned } = trapExit(() => requireDenyPrefixes(tmpValid, 'test'));
  check('requireDenyPrefixes: does not exit when the file is valid', exited === false);
  check('requireDenyPrefixes: returns the normalized prefix array', Array.isArray(returned) && returned[0] === 'projects/x');
}
rmSync(tmpValid, { recursive: true, force: true });

// ── 9. Ordering: the gate runs at module load, before any work ──────────────
// The one property the behavioral tests above cannot show. They prove an
// unusable deny file produces no index and no results, but not that the refusal
// happens before the model loads and the vault is walked. This is a source
// check, and it is only ever a supplement to section 4.
for (const [file, label] of [['embed-vault.js', 'embed-vault'], ['search-vault.js', 'search-vault']]) {
  const src = readFileSync(path.join(SEM, file), 'utf8');
  const gateIdx = src.indexOf(`requireDenyPrefixes(__dirname, '${label}')`);
  const mainCallIdx = src.lastIndexOf('main()');
  check(`${file}: gate runs at module load, before main() is invoked`, gateIdx !== -1 && mainCallIdx !== -1 && gateIdx < mainCallIdx);
}

// ── 10. The operator's real deny file is not tracked ────────────────────────
// The names of an operator's confidential folders are confidential. Only the
// template may be committed.
{
  const ls = spawnSync('git', ['ls-files', '--', 'daemons/semantic-search/'], {
    cwd: path.join(DAEMONS, '..'), encoding: 'utf8',
  });
  if (ls.status === 0) {
    const tracked = (ls.stdout || '').split(/\r?\n/).filter(Boolean);
    check('git: index-deny.example.json is tracked', tracked.includes('daemons/semantic-search/index-deny.example.json'));
    check('git: index-deny.json is NOT tracked', !tracked.includes('daemons/semantic-search/index-deny.json'));
  } else {
    check('git: tracked-file check skipped (not a git checkout)', true, 'informational');
  }
}

for (const box of sandboxes) rmSync(box, { recursive: true, force: true });

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
