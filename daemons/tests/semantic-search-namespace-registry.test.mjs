// semantic-search-namespace-registry.test.mjs -- MemoryNamespaceRegistry/v1
// end-to-end regression guard.
//
// This is a sibling of semantic-search-deny.test.mjs because the registry adds
// three independently spawned programs (embed, search, and doctor), nine
// falsifier groups, and a mutation witness. Folding those into the already
// focused deny-list suite would obscure the fact that index-deny.json remains a
// separate composing layer.
//
// Mutation witness transcript (the witness runs on every invocation):
//
//   $ node daemons/tests/semantic-search-namespace-registry.test.mjs
//   WITNESS GREEN: stale DENY content blocked and healthy INDEX content returned
//   WITNESS GREEN (defense in depth): removing the upstream namespace filter
//   alone no longer leaks CANARY-NAMESPACE-DENY-4f61c8-private-body -- caught
//   by search-vault.js's render-step disposition gate (trust-boundary #43,
//   renderPersisted() in lifecycle-common.mjs). Before #43 this same mutation
//   leaked the DENY content; defeating BOTH layers (this filter and the
//   render-step gate) is covered by persisted-render.test.mjs's own
//   "DENY defense-in-depth" case, not duplicated here.
//   WITNESS GREEN: restoring the original search source blocked stale DENY again
//   All 201 namespace registry checks passed
//
// The mutation is made only in a temporary sandbox copy of search-vault.js. The
// original bytes are restored before the final GREEN run and the sandbox is
// removed at process exit.
//
// Run: node daemons/tests/semantic-search-namespace-registry.test.mjs

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadNamespaceRegistry,
  namespaceDisposition,
  namespaceDispositionForPath,
} from '../semantic-search/namespace-registry.mjs';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(DAEMONS, '..');
const SEM = path.join(DAEMONS, 'semantic-search');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.sh');

let failed = 0;
let checked = 0;
const check = (name, ok, detail = '') => {
  checked++;
  console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const SCHEMA = 'MemoryNamespaceRegistry/v1';
const STOCK_ROWS = [
  { path: 'daily', disposition: 'INDEX' },
  { path: 'memory', disposition: 'INDEX' },
  { path: 'concepts', disposition: 'INDEX' },
  { path: 'projects', disposition: 'INDEX' },
  { path: 'people', disposition: 'INDEX' },
  { path: 'agents', disposition: 'INDEX' },
  { path: 'research', disposition: 'INDEX' },
  { path: 'feedback', disposition: 'INDEX' },
  { path: 'reference', disposition: 'INDEX' },
  { path: 'templates', disposition: 'SKIP', reason: 'boilerplate scaffolding, not authored memory' },
  { path: 'examples', disposition: 'SKIP', reason: 'illustrative starter content, not operator signal' },
];

const HEALTHY = 'CANARY-NAMESPACE-INDEX-a27c91-feedback-body';
const STABLE = 'CANARY-NAMESPACE-STABLE-INDEX-5e83bd-reference-body';
const SKIPPED = 'CANARY-NAMESPACE-SKIP-d21e70-template-body';
const DENIED = 'CANARY-NAMESPACE-DENY-4f61c8-private-body';
const ROGUE = 'CANARY-NAMESPACE-UNDECLARED-8b72aa-rogue-body';
const FLIPPED = HEALTHY;
const PRIVATE_DIR = 'private';
const ROGUE_DIR = 'rogue';

const TRANSFORMERS_STUB = `export async function pipeline() {
  return async () => ({ data: Float32Array.from([1, 0, 0, 0]) });
}
`;

const sandboxes = [];

function cloneRows(rows = STOCK_ROWS) {
  return JSON.parse(JSON.stringify(rows));
}

function registryText(rows = STOCK_ROWS) {
  return JSON.stringify({ schema: SCHEMA, namespaces: rows }, null, 2);
}

function writeRegistry(box, text) {
  const target = path.join(box.sem, 'namespace-registry.json');
  rmSync(target, { recursive: true, force: true });
  if (text !== null) writeFileSync(target, text);
}

// The optional, operator-owned extension registry (issue #48). Same shape as
// writeRegistry above; absent (never called) is the default valid state.
function writeLocalRegistry(box, text) {
  const target = path.join(box.sem, 'namespace-registry.local.json');
  rmSync(target, { recursive: true, force: true });
  if (text !== null) writeFileSync(target, text);
}

function addNote(box, relativePath, canary) {
  const target = path.join(box.vault, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    `# Namespace fixture\n\n${canary}. This authored memory paragraph is deliberately long enough to pass the semantic chunker's near-empty note guard.\n`,
  );
  return target;
}

function makeSandbox(name, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `namespace-registry-${name}-`));
  sandboxes.push(root);

  const sem = path.join(root, 'daemons', 'semantic-search');
  const hygiene = path.join(root, 'daemons', 'memory-hygiene');
  mkdirSync(sem, { recursive: true });
  mkdirSync(hygiene, { recursive: true });
  for (const file of ['deny-list.mjs', 'namespace-registry.mjs', 'embed-vault.js', 'search-vault.js']) {
    copyFileSync(path.join(SEM, file), path.join(sem, file));
  }
  // search-vault.js now routes chunk rendering through the trust-boundary #43
  // chokepoint (renderPersisted() + FRAMING_LINES) -- its dependency chain
  // grew, so the sandbox must carry it too.
  for (const file of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, file), path.join(root, 'daemons', file));
  }
  copyFileSync(
    path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'),
    path.join(hygiene, 'resume-framing.mjs'),
  );

  const registry = Object.hasOwn(options, 'registryText')
    ? options.registryText
    : registryText();
  if (registry !== null) writeFileSync(path.join(sem, 'namespace-registry.json'), registry);
  writeFileSync(path.join(sem, 'index-deny.json'), options.denyText || '{"deny_prefixes":[]}');

  const stub = path.join(root, 'node_modules', '@xenova', 'transformers');
  mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
    name: '@xenova/transformers',
    version: '0.0.0-test-stub',
    type: 'module',
    main: 'index.js',
  }));
  writeFileSync(path.join(stub, 'index.js'), TRANSFORMERS_STUB);

  // Ordinary-doctor prerequisites: warnings are fine, but a valid registry
  // fixture must have zero unrelated FAILs so negative statuses are meaningful.
  mkdirSync(path.join(root, 'system'), { recursive: true });
  writeFileSync(path.join(root, 'system', '00_identity.md'), '# fixture identity\n');
  writeFileSync(path.join(root, 'CLAUDE.md'), '# fixture instructions\n');
  mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'skill-index.json'), '{}');
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  writeFileSync(path.join(root, '.claude', 'agents', 'fixture.md'), '# fixture agent\n');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(DOCTOR, path.join(root, 'scripts', 'doctor.sh'));

  const vault = path.join(root, 'vault');
  mkdirSync(path.join(vault, 'daily'), { recursive: true });
  mkdirSync(path.join(vault, 'memory'), { recursive: true });
  // Existing SKIP_DIRS infrastructure names are deliberately physical: they
  // must not be mistaken for undeclared memory namespaces.
  mkdirSync(path.join(vault, '.git'), { recursive: true });
  mkdirSync(path.join(vault, 'node_modules'), { recursive: true });

  const box = {
    root,
    sem,
    vault,
    embeddings: path.join(vault, 'memory', 'embeddings.json'),
  };
  addNote(box, 'feedback/healthy.md', HEALTHY);
  return box;
}

function runNode(box, script, args = []) {
  const result = spawnSync(process.execPath, [path.join(box.sem, script), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AIGENT_ROOT: box.root,
      AIGENT_VAULT_ROOT: box.vault,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    all: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function runDoctor(box) {
  const result = spawnSync('bash', [path.join(box.root, 'scripts', 'doctor.sh'), box.root], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    all: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function indexNote(notePath, chunk, embedding = [1, 0, 0, 0]) {
  return {
    path: notePath,
    title: path.basename(notePath, '.md'),
    tags: [],
    chunk,
    embedding,
    mtime: 0,
  };
}

function writeIndex(box, notes) {
  const text = JSON.stringify({
    model: 'Xenova/all-MiniLM-L6-v2',
    updated: '2020-01-01T00:00:00.000Z',
    noteCount: notes.length,
    entryCount: notes.length,
    notes,
  });
  writeFileSync(box.embeddings, text);
  return text;
}

function readIndexText(box) {
  return existsSync(box.embeddings) ? readFileSync(box.embeddings, 'utf8') : '';
}

function rowsWithPrivateDeny() {
  return [
    ...cloneRows(),
    { path: PRIVATE_DIR, disposition: 'DENY', reason: 'test-only confidential namespace' },
    { path: 'private-absent', disposition: 'DENY', reason: 'test-only absent confidential namespace' },
  ];
}

function assertSearchIsolation(label, result, hidden, shown = HEALTHY) {
  check(`${label}: exits 0`, result.status === 0, result.stderr.slice(0, 300));
  check(`${label}: excluded canary is absent`, !result.all.includes(hidden));
  check(`${label}: healthy INDEX canary is present`, result.stdout.includes(shown));
}

function establishHealthyControl(box, label) {
  const embed = runNode(box, 'embed-vault.js');
  check(`${label}: healthy control embed exits 0 before the negative mutation`, embed.status === 0, embed.stderr.slice(0, 300));
  const raw = readIndexText(box);
  check(`${label}: healthy INDEX canary is present before the negative mutation`, raw.includes(HEALTHY));
  const search = runNode(box, 'search-vault.js', ['healthy namespace', '--top', '10']);
  check(`${label}: healthy control search returns the INDEX canary`, search.status === 0 && search.stdout.includes(HEALTHY), search.stderr.slice(0, 300));
  const doctor = runDoctor(box);
  check(`${label}: healthy control doctor exits 0 before the negative mutation`, doctor.status === 0, doctor.all.slice(-500));
}

function assertInvalidRegistryMutation(name, mutate, detailPattern) {
  assertInvalidRegistryMutation.sequence = (assertInvalidRegistryMutation.sequence || 0) + 1;
  const box = makeSandbox(`invalid-${assertInvalidRegistryMutation.sequence}`);
  establishHealthyControl(box, name);
  const before = readIndexText(box);
  mutate(box);

  const embed = runNode(box, 'embed-vault.js');
  check(`${name}: embed fails closed`, embed.status === 1, embed.all.slice(0, 300));
  check(`${name}: embed names the registry problem`, detailPattern.test(embed.all), embed.all.slice(0, 300));
  check(`${name}: failed embed leaves the healthy carried-forward index byte-for-byte unchanged`, readIndexText(box) === before);

  const search = runNode(box, 'search-vault.js', ['healthy namespace', '--top', '10']);
  check(`${name}: search fails closed`, search.status === 1, search.all.slice(0, 300));
  check(`${name}: failed search returns no healthy result from the seeded index`, !search.stdout.includes(HEALTHY));
  check(`${name}: search names the registry problem`, detailPattern.test(search.all), search.all.slice(0, 300));

  const doctor = runDoctor(box);
  check(`${name}: doctor fails closed`, doctor.status === 1, doctor.all.slice(-500));
  check(`${name}: doctor reports a namespace-registry-specific failure`, /namespace registry check failed/i.test(doctor.all), doctor.all.slice(-500));
  check(`${name}: doctor names the registry problem`, detailPattern.test(doctor.all), doctor.all.slice(-500));
}

// ── Loader validation and exact shipped population ──────────────────────────
{
  const shipped = JSON.parse(readFileSync(path.join(SEM, 'namespace-registry.json'), 'utf8'));
  check(
    'stock registry schema and ordered population are exact',
    JSON.stringify(shipped) === JSON.stringify({ schema: SCHEMA, namespaces: STOCK_ROWS }),
  );
  check('stock registry contains 9 INDEX rows', shipped.namespaces.filter((row) => row.disposition === 'INDEX').length === 9);
  check('stock registry contains 2 SKIP rows', shipped.namespaces.filter((row) => row.disposition === 'SKIP').length === 2);
  check('stock registry contains 0 DENY rows', shipped.namespaces.filter((row) => row.disposition === 'DENY').length === 0);

  const loaded = loadNamespaceRegistry(SEM);
  check('loader returns all stock rows', loaded.rows.length === 11);
  check('loader builds a case-insensitive byPath map', loaded.byPath.get('feedback')?.path === 'feedback');
  check('namespaceDisposition is case-insensitive', namespaceDisposition(loaded, 'FEEDBACK') === 'INDEX');
  check('namespaceDispositionForPath normalizes backslash separators', namespaceDispositionForPath(loaded, 'Templates\\starter.md') === 'SKIP');
  check('namespaceDispositionForPath returns undefined for undeclared paths', namespaceDispositionForPath(loaded, 'not-declared/note.md') === undefined);
}

function loaderRejects(name, raw, setupAsDirectory = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'namespace-loader-invalid-'));
  try {
    const target = path.join(dir, 'namespace-registry.json');
    const healthyPath = path.join(dir, 'feedback', 'healthy.md');
    mkdirSync(path.dirname(healthyPath), { recursive: true });
    writeFileSync(healthyPath, HEALTHY);
    writeFileSync(target, registryText());
    const control = loadNamespaceRegistry(dir);
    check(
      `${name}: healthy INDEX canary is present before the loader-negative mutation`,
      namespaceDisposition(control, 'feedback') === 'INDEX' && readFileSync(healthyPath, 'utf8').includes(HEALTHY),
    );

    rmSync(target, { force: true });
    if (setupAsDirectory) mkdirSync(target);
    else if (raw !== null) writeFileSync(target, raw);
    let threw = false;
    try {
      loadNamespaceRegistry(dir);
    } catch {
      threw = true;
    }
    check(`loader rejects ${name}`, threw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const invalidDocuments = [
  ['missing registry', null],
  ['malformed JSON', '{'],
  ['non-object root', 'null'],
  ['wrong schema', JSON.stringify({ schema: 'MemoryNamespaceRegistry/v0', namespaces: [] })],
  ['namespaces missing', JSON.stringify({ schema: SCHEMA })],
  ['namespaces not an array', JSON.stringify({ schema: SCHEMA, namespaces: {} })],
  ['non-object row', registryText([null])],
  ['non-string path', registryText([{ path: 7, disposition: 'INDEX' }])],
  ['empty path', registryText([{ path: '', disposition: 'INDEX' }])],
  ['whitespace-padded path', registryText([{ path: ' feedback', disposition: 'INDEX' }])],
  ['dot path', registryText([{ path: '.', disposition: 'INDEX' }])],
  ['dot-dot path', registryText([{ path: '..', disposition: 'INDEX' }])],
  ['slash path', registryText([{ path: 'feedback/private', disposition: 'INDEX' }])],
  ['backslash path', registryText([{ path: 'feedback\\private', disposition: 'INDEX' }])],
  ['POSIX absolute path', registryText([{ path: '/feedback', disposition: 'INDEX' }])],
  ['Windows absolute path', registryText([{ path: 'C:\\feedback', disposition: 'INDEX' }])],
  ['case-insensitive duplicate path', registryText([
    { path: 'feedback', disposition: 'INDEX' },
    { path: 'Feedback', disposition: 'INDEX' },
  ])],
  ['missing disposition', registryText([{ path: 'feedback' }])],
  ['lowercase disposition', registryText([{ path: 'feedback', disposition: 'index' }])],
  ['SKIP without reason', registryText([{ path: 'templates', disposition: 'SKIP' }])],
  ['SKIP with blank reason', registryText([{ path: 'templates', disposition: 'SKIP', reason: '   ' }])],
  ['DENY with non-string reason', registryText([{ path: 'private', disposition: 'DENY', reason: 7 }])],
];
for (const [name, raw] of invalidDocuments) loaderRejects(name, raw);
loaderRejects('unreadable registry path', null, true);

// ── 1. Valid INDEX content reaches both the artifact and search output ───────
// feedback/ is intentional: the old hardcoded SCAN_DIRS omitted it, so this is
// a falsifier for accidentally retaining the pre-registry scan population.
{
  const box = makeSandbox('valid-index');
  const embed = runNode(box, 'embed-vault.js');
  check('valid INDEX: embed exits 0', embed.status === 0, embed.stderr.slice(0, 300));
  const raw = readIndexText(box);
  check('valid INDEX: feedback canary is present in embeddings.json', raw.includes(HEALTHY));
  const search = runNode(box, 'search-vault.js', ['healthy namespace', '--top', '10']);
  check('valid INDEX: search exits 0', search.status === 0, search.stderr.slice(0, 300));
  check('valid INDEX: feedback canary is present in search stdout', search.stdout.includes(HEALTHY));
  const doctor = runDoctor(box);
  check('valid INDEX: doctor exits 0', doctor.status === 0, doctor.all.slice(-500));
  check('valid INDEX: doctor emits NAMESPACE_INDEX_PRESENT', /NAMESPACE_INDEX_PRESENT\s+feedback(?:\s|$)/.test(doctor.stdout));
  check('declared absent research is informational', /NAMESPACE_INDEX_ABSENT\s+research(?:\s|$)/.test(doctor.stdout));
  const declaredLines = doctor.stdout.match(/NAMESPACE_(?:INDEX|SKIP|DENY)_(?:PRESENT|ABSENT)/g) || [];
  check('doctor emits exactly one line per stock namespace', declaredLines.length === STOCK_ROWS.length, `${declaredLines.length} lines`);
}

// ── 2. SKIP content is absent at build and query time; doctor reports it ─────
{
  const box = makeSandbox('skip');
  addNote(box, 'templates/starter.md', SKIPPED);
  const embed = runNode(box, 'embed-vault.js');
  check('SKIP: embed exits 0', embed.status === 0, embed.stderr.slice(0, 300));
  const raw = readIndexText(box);
  check('SKIP: template canary is absent from embeddings.json', !raw.includes(SKIPPED));
  check('SKIP: healthy INDEX canary is present in the same artifact', raw.includes(HEALTHY));

  // Seed a stale SKIP entry so query-time behavior is observable independently
  // of the build-time exclusion.
  writeIndex(box, [
    indexNote('templates/starter.md', SKIPPED, [1, 0, 0, 0]),
    indexNote('feedback/healthy.md', HEALTHY, [0, 1, 0, 0]),
  ]);
  const search = runNode(box, 'search-vault.js', ['starter template', '--top', '10']);
  assertSearchIsolation('SKIP search', search, SKIPPED);

  const doctor = runDoctor(box);
  check('SKIP: doctor exits 0', doctor.status === 0, doctor.all.slice(-500));
  check('SKIP: doctor emits NAMESPACE_SKIP_PRESENT', /NAMESPACE_SKIP_PRESENT\s+templates(?:\s|$)/.test(doctor.stdout));
  check('SKIP: doctor emits NAMESPACE_SKIP_ABSENT', /NAMESPACE_SKIP_ABSENT\s+examples(?:\s|$)/.test(doctor.stdout));
}

// ── 3. Fixture DENY content is absent from build/search and reported ─────────
{
  const box = makeSandbox('deny', { registryText: registryText(rowsWithPrivateDeny()) });
  addNote(box, `${PRIVATE_DIR}/secret.md`, DENIED);
  const embed = runNode(box, 'embed-vault.js');
  check('DENY: embed exits 0', embed.status === 0, embed.stderr.slice(0, 300));
  const raw = readIndexText(box);
  check('DENY: private canary is absent from embeddings.json', !raw.includes(DENIED));
  check('DENY: healthy INDEX canary is present in the same artifact', raw.includes(HEALTHY));
  const search = runNode(box, 'search-vault.js', ['private secret', '--top', '10']);
  assertSearchIsolation('DENY search over built index', search, DENIED);
  const doctor = runDoctor(box);
  check('DENY: doctor exits 0', doctor.status === 0, doctor.all.slice(-500));
  check('DENY: doctor emits NAMESPACE_DENY_PRESENT', /NAMESPACE_DENY_PRESENT\s+private(?:\s|$)/.test(doctor.stdout));
  check('DENY: doctor emits NAMESPACE_DENY_ABSENT', /NAMESPACE_DENY_ABSENT\s+private-absent(?:\s|$)/.test(doctor.stdout));
}

// ── 4. Stale hand-built DENY entry is blocked at the query chokepoint ────────
{
  const box = makeSandbox('stale-deny', { registryText: registryText(rowsWithPrivateDeny()) });
  mkdirSync(path.join(box.vault, PRIVATE_DIR), { recursive: true });
  writeIndex(box, [
    indexNote(`${PRIVATE_DIR}/secret.md`, DENIED, [1, 0, 0, 0]),
    indexNote('feedback/healthy.md', HEALTHY, [0, 1, 0, 0]),
  ]);
  check('stale DENY: healthy INDEX canary is present in the seeded artifact', readIndexText(box).includes(HEALTHY));
  const search = runNode(box, 'search-vault.js', ['private secret', '--top', '10']);
  assertSearchIsolation('stale DENY query-time chokepoint', search, DENIED);
  check('stale DENY: denied namespace path is absent from all output', !search.all.includes(`${PRIVATE_DIR}/secret.md`));
}

// A stale undeclared path with no corresponding physical directory is also
// removed at query time, while a physical undeclared directory is fatal below.
{
  const box = makeSandbox('stale-undeclared');
  writeIndex(box, [
    indexNote(`${ROGUE_DIR}/secret.md`, ROGUE, [1, 0, 0, 0]),
    indexNote('feedback/healthy.md', HEALTHY, [0, 1, 0, 0]),
  ]);
  const search = runNode(box, 'search-vault.js', ['rogue secret', '--top', '10']);
  assertSearchIsolation('stale undeclared query-time chokepoint', search, ROGUE);
}

// ── 5. INDEX -> SKIP plus --changed-only purges carried-forward chunks ───────
{
  const box = makeSandbox('flip');
  addNote(box, 'reference/stable.md', STABLE);
  const first = runNode(box, 'embed-vault.js');
  check('INDEX -> SKIP: initial embed exits 0', first.status === 0, first.stderr.slice(0, 300));
  const initial = readIndexText(box);
  check('INDEX -> SKIP: soon-to-be-flipped canary starts indexed', initial.includes(FLIPPED));
  check('INDEX -> SKIP: stable healthy INDEX canary starts indexed', initial.includes(STABLE));

  const flippedRows = cloneRows();
  const feedback = flippedRows.find((row) => row.path === 'feedback');
  feedback.disposition = 'SKIP';
  feedback.reason = 'test-only namespace flip';
  writeRegistry(box, registryText(flippedRows));

  const changed = runNode(box, 'embed-vault.js', ['--changed-only']);
  check('INDEX -> SKIP: changed-only embed exits 0', changed.status === 0, changed.stderr.slice(0, 300));
  check('INDEX -> SKIP: changed-only run reaches the zero-files path', /--changed-only: 0 files modified/.test(changed.stdout), changed.stdout.slice(-500));
  const after = readIndexText(box);
  check('INDEX -> SKIP: previously indexed chunk is purged from carried-forward embeddings.json', !after.includes(FLIPPED));
  check('INDEX -> SKIP: stable INDEX content survives the carried-forward purge', after.includes(STABLE));
}

// ── 6. A physical undeclared directory fails all three programs closed ──────
{
  const box = makeSandbox('undeclared');
  establishHealthyControl(box, 'undeclared physical directory');
  addNote(box, `${ROGUE_DIR}/secret.md`, ROGUE);
  const before = readIndexText(box);

  const embed = runNode(box, 'embed-vault.js');
  check('undeclared: embed exits nonzero', embed.status === 1, embed.all.slice(0, 300));
  check('undeclared: embed names the physical directory', embed.all.includes(ROGUE_DIR));
  check('undeclared: embed refuses before loading the model', !embed.stdout.includes('Loading model'));
  check('undeclared: embed leaves the healthy index byte-for-byte unchanged', readIndexText(box) === before && before.includes(HEALTHY));

  writeIndex(box, [
    indexNote(`${ROGUE_DIR}/secret.md`, ROGUE, [1, 0, 0, 0]),
    indexNote('feedback/healthy.md', HEALTHY, [0, 1, 0, 0]),
  ]);
  const search = runNode(box, 'search-vault.js', ['rogue secret', '--top', '10']);
  check('undeclared: search exits nonzero', search.status === 1, search.all.slice(0, 300));
  check('undeclared: search names the physical directory', search.all.includes(ROGUE_DIR));
  check('undeclared: search returns neither rogue nor healthy results', !search.stdout.includes(ROGUE) && !search.stdout.includes(HEALTHY));

  const doctor = runDoctor(box);
  check('undeclared: doctor exits nonzero', doctor.status === 1, doctor.all.slice(-500));
  check('undeclared: doctor emits NAMESPACE_UNDECLARED', /NAMESPACE_UNDECLARED\s+rogue(?:\s|$)/.test(doctor.stdout));
}

// A declared path's physical spelling must match exactly. Runtime lookups stay
// case-insensitive for stale index paths, but accepting a differently-cased
// physical directory would silently omit it on a case-sensitive filesystem
// because embedding walks the literal registry spelling.
{
  const box = makeSandbox('physical-case-mismatch');
  establishHealthyControl(box, 'physical namespace case mismatch');
  const mismatchedRows = cloneRows();
  mismatchedRows.find((row) => row.path === 'feedback').path = 'Feedback';
  writeRegistry(box, registryText(mismatchedRows));
  const before = readIndexText(box);

  const embed = runNode(box, 'embed-vault.js');
  check('physical case mismatch: embed fails closed', embed.status === 1 && embed.all.includes('feedback'), embed.all.slice(0, 300));
  check('physical case mismatch: failed embed leaves the healthy index unchanged', readIndexText(box) === before && before.includes(HEALTHY));

  const search = runNode(box, 'search-vault.js', ['healthy namespace', '--top', '10']);
  check('physical case mismatch: search fails closed with no result', search.status === 1 && !search.stdout.includes(HEALTHY), search.all.slice(0, 300));

  const doctor = runDoctor(box);
  check('physical case mismatch: doctor fails closed', doctor.status === 1, doctor.all.slice(-500));
  check('physical case mismatch: declared spelling is reported absent', /NAMESPACE_INDEX_ABSENT\s+Feedback(?:\s|$)/.test(doctor.stdout));
  check('physical case mismatch: physical spelling is reported undeclared', /NAMESPACE_UNDECLARED\s+feedback(?:\s|$)/.test(doctor.stdout));
}

// ── 7-9. Invalid registry states fail embed, search, and doctor closed ────────
assertInvalidRegistryMutation(
  'duplicate registry path',
  (box) => writeRegistry(box, registryText([
    ...cloneRows(),
    { path: 'Feedback', disposition: 'INDEX' },
  ])),
  /duplicate namespace path/i,
);

assertInvalidRegistryMutation(
  'invalid disposition',
  (box) => writeRegistry(box, registryText([
    ...cloneRows(),
    { path: PRIVATE_DIR, disposition: 'ALLOW' },
  ])),
  /has invalid disposition/i,
);

assertInvalidRegistryMutation(
  'missing registry',
  (box) => writeRegistry(box, null),
  /cannot read|missing or unreadable/i,
);

assertInvalidRegistryMutation(
  'malformed registry JSON',
  (box) => writeRegistry(box, '{'),
  /cannot parse|malformed JSON/i,
);

// Representative structural/reason failures prove doctor mirrors the shared
// loader's validation rather than treating merely parseable JSON as healthy.
assertInvalidRegistryMutation(
  'wrong registry schema',
  (box) => writeRegistry(box, JSON.stringify({ schema: 'MemoryNamespaceRegistry/v0', namespaces: cloneRows() })),
  /schema must equal exactly/i,
);

assertInvalidRegistryMutation(
  'missing SKIP reason',
  (box) => writeRegistry(box, registryText([
    ...cloneRows().filter((row) => row.path !== 'templates'),
    { path: 'templates', disposition: 'SKIP' },
  ])),
  /requires a non-empty reason/i,
);

// ── Local extension registry (issue #48) ─────────────────────────────────────
// namespace-registry.local.json is the optional, operator-owned extension: a
// local row may ADD a new declared top-level path, but never override or
// duplicate a core path. This is the fix for the measured contradiction --
// FleetBaselineManifest pins namespace-registry.json, so a legitimate new
// vault directory could previously only be declared by editing the pinned
// core file, which made a properly customized seat permanently NONCOMPLIANT.

// 10. A new physical namespace declared ONLY in the local registry is
// accepted (INDEX content built and returned, doctor reports it PRESENT
// rather than UNDECLARED) under its declared disposition. Before this fix
// (loadLocalNamespaceRegistry/composeNamespaceRegistry did not exist and
// namespace-registry.local.json was never read), this exact fixture is the
// master-branch red case: the directory is undeclared everywhere.
{
  const box = makeSandbox('local-index');
  const LOCAL_PATH = 'operator-extension';
  const LOCAL_CANARY = 'CANARY-NAMESPACE-LOCAL-INDEX-7c19ab-extension-body';
  addNote(box, `${LOCAL_PATH}/note.md`, LOCAL_CANARY);
  writeLocalRegistry(box, registryText([{ path: LOCAL_PATH, disposition: 'INDEX' }]));

  const embed = runNode(box, 'embed-vault.js');
  check('local INDEX: embed exits 0', embed.status === 0, embed.stderr.slice(0, 300));
  const raw = readIndexText(box);
  check('local INDEX: local-namespace canary is present in embeddings.json', raw.includes(LOCAL_CANARY));
  check('local INDEX: core healthy canary is also present in the same artifact', raw.includes(HEALTHY));

  const search = runNode(box, 'search-vault.js', ['extension namespace', '--top', '10']);
  check('local INDEX: search exits 0', search.status === 0, search.stderr.slice(0, 300));
  check('local INDEX: search returns the local-namespace canary', search.stdout.includes(LOCAL_CANARY));

  const doctor = runDoctor(box);
  check('local INDEX: doctor exits 0', doctor.status === 0, doctor.all.slice(-500));
  check(
    'local INDEX: doctor emits NAMESPACE_INDEX_PRESENT for the locally declared path',
    new RegExp(`NAMESPACE_INDEX_PRESENT\\s+${LOCAL_PATH}(?:\\s|$)`).test(doctor.stdout),
  );
  check('local INDEX: doctor does not report the locally declared path as undeclared', !new RegExp(`NAMESPACE_UNDECLARED\\s+${LOCAL_PATH}(?:\\s|$)`).test(doctor.stdout));
}

// 11. The local extension is additive, not a blanket bypass: a physical
// namespace declared in NEITHER registry stays red even while a local
// registry is present and valid (declaring an unrelated path).
{
  const box = makeSandbox('local-present-but-undeclared');
  writeLocalRegistry(box, registryText([{ path: 'operator-extension', disposition: 'INDEX' }]));
  establishHealthyControl(box, 'local present but sibling still undeclared');
  addNote(box, `${ROGUE_DIR}/secret.md`, ROGUE);
  const before = readIndexText(box);

  const embed = runNode(box, 'embed-vault.js');
  check('local present but sibling still undeclared: embed exits nonzero', embed.status === 1, embed.all.slice(0, 300));
  check('local present but sibling still undeclared: embed names the physical directory', embed.all.includes(ROGUE_DIR));
  check('local present but sibling still undeclared: healthy index unchanged', readIndexText(box) === before && before.includes(HEALTHY));

  const doctor = runDoctor(box);
  check('local present but sibling still undeclared: doctor exits nonzero', doctor.status === 1, doctor.all.slice(-500));
  check('local present but sibling still undeclared: doctor emits NAMESPACE_UNDECLARED', /NAMESPACE_UNDECLARED\s+rogue(?:\s|$)/.test(doctor.stdout));
}

// 12. Duplicate core/local path fails closed everywhere, even when the local
// disposition matches the core disposition exactly.
assertInvalidRegistryMutation(
  'duplicate core/local path',
  (box) => writeLocalRegistry(box, registryText([{ path: 'feedback', disposition: 'INDEX' }])),
  /duplicate/i,
);

// 13. A local row cannot override a core disposition either -- same
// duplicate-path guard, exercised with a mismatched disposition so an
// "override" attempt is falsified as its own fixture per the issue's bullet.
assertInvalidRegistryMutation(
  'override of a core disposition',
  (box) => writeLocalRegistry(box, registryText([{ path: 'templates', disposition: 'INDEX' }])),
  /duplicate/i,
);

// 14. Invalid/malformed local registry fails closed everywhere, same as a
// malformed core registry.
assertInvalidRegistryMutation(
  'malformed local registry JSON',
  (box) => writeLocalRegistry(box, '{'),
  /cannot parse|malformed JSON/i,
);

// 15. A stale hand-built DENY entry declared ONLY in the local registry is
// blocked at the query-time chokepoint, exactly like a core DENY row (test 4
// above) -- proving the composed registry, not just the core one, reaches
// search-vault.js's existing namespaceDispositionForPath() filter.
{
  const box = makeSandbox('local-stale-deny');
  writeLocalRegistry(box, registryText([
    { path: PRIVATE_DIR, disposition: 'DENY', reason: 'test-only local confidential namespace' },
  ]));
  mkdirSync(path.join(box.vault, PRIVATE_DIR), { recursive: true });
  writeIndex(box, [
    indexNote(`${PRIVATE_DIR}/secret.md`, DENIED, [1, 0, 0, 0]),
    indexNote('feedback/healthy.md', HEALTHY, [0, 1, 0, 0]),
  ]);
  check('local stale DENY: healthy INDEX canary is present in the seeded artifact', readIndexText(box).includes(HEALTHY));
  const search = runNode(box, 'search-vault.js', ['private secret', '--top', '10']);
  assertSearchIsolation('local stale DENY query-time chokepoint', search, DENIED);
  check('local stale DENY: denied namespace path is absent from all output', !search.all.includes(`${PRIVATE_DIR}/secret.md`));
}

// ── Mutation witness: weaken only search's query-time namespace predicate ───
{
  const box = makeSandbox('mutation-witness', { registryText: registryText(rowsWithPrivateDeny()) });
  mkdirSync(path.join(box.vault, PRIVATE_DIR), { recursive: true });
  writeIndex(box, [
    indexNote(`${PRIVATE_DIR}/secret.md`, DENIED, [1, 0, 0, 0]),
    indexNote('feedback/healthy.md', HEALTHY, [0, 1, 0, 0]),
  ]);
  const searchPath = path.join(box.sem, 'search-vault.js');
  const original = readFileSync(searchPath, 'utf8');
  const enforcement = "  index.notes = index.notes.filter((note) => namespaceDispositionForPath(NAMESPACE_REGISTRY, note.path) === 'INDEX');";
  const occurrences = original.split(enforcement).length - 1;
  check('mutation witness: query-time namespace enforcement has one scriptable chokepoint', occurrences === 1, `${occurrences} occurrences`);

  const baseline = runNode(box, 'search-vault.js', ['private secret', '--top', '10']);
  const baselineGreen = baseline.status === 0 && !baseline.all.includes(DENIED) && baseline.stdout.includes(HEALTHY);
  check('mutation witness: stale-DENY contract is GREEN before mutation', baselineGreen, baseline.all.slice(-500));
  if (baselineGreen) console.log('WITNESS GREEN: stale DENY content blocked and healthy INDEX content returned');

  let mutant = null;
  let restored = null;
  try {
    if (occurrences === 1) {
      writeFileSync(searchPath, original.replace(
        enforcement,
        '  index.notes = index.notes.filter(() => true); // MUTATION: namespace enforcement removed',
      ));
      mutant = runNode(box, 'search-vault.js', ['private secret', '--top', '10']);
    }
  } finally {
    writeFileSync(searchPath, original);
    restored = runNode(box, 'search-vault.js', ['private secret', '--top', '10']);
  }

  // trust-boundary #43 added a second, independent gate: search-vault.js
  // re-derives each chunk's disposition at render time and refuses to render
  // anything not INDEX. Defeating ONLY this upstream filter no longer leaks
  // DENIED content -- it is caught downstream instead. Defeating BOTH layers
  // is persisted-render.test.mjs's own "DENY defense-in-depth" case.
  const mutantStillSafe = mutant && mutant.status === 0 && !mutant.all.includes(DENIED) && mutant.all.includes('[REFUSED:');
  check('mutation witness: removing the upstream predicate alone no longer leaks (render-step gate catches it)', mutantStillSafe, mutant?.all.slice(-500) || 'mutation did not run');
  if (mutantStillSafe) console.log(`WITNESS GREEN (defense in depth): removing the upstream namespace filter alone no longer leaks ${DENIED} -- caught by search-vault.js's render-step disposition gate (trust-boundary #43)`);

  const restoredGreen = restored.status === 0 && !restored.all.includes(DENIED) && restored.stdout.includes(HEALTHY);
  check('mutation witness: restoring the source makes the contract GREEN again', restoredGreen, restored.all.slice(-500));
  if (restoredGreen) console.log('WITNESS GREEN: restoring the original search source blocked stale DENY again');
}

for (const box of sandboxes) rmSync(box, { recursive: true, force: true });

console.log(failed ? `\n${failed} of ${checked} namespace registry check(s) FAILED` : `\nAll ${checked} namespace registry checks passed`);
process.exit(failed ? 1 : 0);
