#!/usr/bin/env node
// run-recollection.mjs -- the ONE runner for the recollection benchmark
// preregistered at recollection-44/PREREG-001.
//
// THREE OUTCOMES, NOT TWO, exactly as evals/run-evals.mjs established: pass /
// fail / unrunnable, plus harness-error for a defect in the benchmark itself.
// UNRUNNABLE is reserved for a missing item from the finite environmental list
// in PREREG-001 4.3 (or a scenario-declared expectation in section 6); an
// undeclared unrunnable is fatal, and harness-error can never be excused by a
// declaration (PREREG-001 5.1).
//
// NOT under daemons/tests/ and NOT in ci.yml, deliberately: both are glob-run
// in CI without daemons/semantic-search/node_modules installed, so a copy of
// this file in either place would be permanently red or permanently declared
// (PREREG-001 7.3).
//
// It drives the REAL product, unmodified: it copies the shipped semantic-search
// scripts and their dependency chain into a temp sandbox, points
// AIGENT_VAULT_ROOT at a copy of the frozen fixture corpus, spawns
// embed-vault.js / search-vault.js / scripts/doctor.sh, and asserts on what
// they print. It does NOT use the constant-vector embedding stub the policy
// tests use: ranking quality is the measurement, so the real model runs.
//
// Run:
//   node evals/recollection/run-recollection.mjs                 # baseline
//   node evals/recollection/run-recollection.mjs --scenario F1   # falsifier
//   node evals/recollection/run-recollection.mjs --json
//   node evals/recollection/run-recollection.mjs --freeze        # print hashes only

import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS = path.resolve(HERE, '..');
const ROOT = path.resolve(EVALS, '..');
const DAEMONS = path.join(ROOT, 'daemons');
const SEM = path.join(DAEMONS, 'semantic-search');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.sh');

const CORPUS = path.join(HERE, 'corpus');
const OVERLAY = path.join(HERE, 'overlays', 'undeclared-namespace');
const FIXTURE_REGISTRY = path.join(HERE, 'fixture-registry');
const COMPUTED = path.join(HERE, 'PREREG-001-COMPUTED.md');

// ── Frozen constants. PREREG-001 3.1, 3.2, 4.1, 4.2. Not editable in
//    response to a result (PREREG-001 8).
const K = 5;
const TAU = 0.30;
const NEAR_THRESHOLD = 0.01;
const T_SEARCH_MAX_MS = 150;
const T_EMBED_MAX_MS = 8000;
const JSON_BYTES_MAX = 8192;
const TOKENS_MAX = 2048;
const CHUNK_CHARS_MAX = 500;
const RUN_WALL_MAX_MS = 30 * 60 * 1000;
const FALSIFIER_WALL_MAX_MS = 10 * 60 * 1000;

// PREREG-001 1.3. A sandbox copy that does not hash to these is UNRUNNABLE,
// not a result.
const RUNTIME_HASHES = {
  'daemons/semantic-search/namespace-registry.json': '5bcc603c8e813f272be3ef17aa94b92ac1cccd9e31fb5b02d6d5589d60025060',
  'daemons/semantic-search/namespace-registry.local.example.json': '8628cf7d921f091865ea9142dc936de3b16e0d97c0515da60118650fdd285212',
  'daemons/semantic-search/namespace-registry.mjs': '2e3ebb9c539f5deb7eddb2ce838f73b2d18ddc06bf5a01970df8ce337168d0e8',
  'daemons/semantic-search/search-vault.js': '202ba3929c5e6e15de6d3e2761e3278dc64f28e24792a084a8959e536df4b8f5',
  'daemons/semantic-search/embed-vault.js': '51ff0ca5180d8a7f03501bddf4f94bc22ba80027f89588dd2bca34793a2bb0f3',
  'daemons/semantic-search/deny-list.mjs': '5ff063ae3e9bb114fec464bd446675dfe2be72fe92d046e7f23ebe8c0d15f95c',
  'daemons/lifecycle-common.mjs': 'bc6ee45666f4537c41a6de9b2f4f12afa504549ef258191d26698f0fdbbe1ba3',
  'evals/run-evals.mjs': '11d4a79d47e3349113df56a856411b434055b3c5321c913abc017583995e836d',
};

const PROVENANCE_RE = /^\["persisted-data":"vault-chunk" "(?<path>[^"]+)" sha (?<sha>[0-9a-f]{12}) @ (?<at>\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\] "/;

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const FREEZE_ONLY = argv.includes('--freeze');
const KEEP = argv.includes('--keep');
const scenarioIdx = argv.indexOf('--scenario');
const SCENARIO = scenarioIdx !== -1 ? String(argv[scenarioIdx + 1] || '').toUpperCase() : 'BASELINE';

// ── results ──────────────────────────────────────────────────────────────────
const results = [];
const record = (id, klass, status, detail, extra = {}) =>
  results.push({ ...extra, id, class: klass, status, detail: detail || '' });

const sandboxes = [];
process.on('exit', () => {
  if (KEEP) return;
  for (const b of sandboxes) { try { rmSync(b, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ── PREREG-001 1.5 hash rule ─────────────────────────────────────────────────
// 1. every regular file, recursively. 2. exclude memory/embeddings.json if
// present. 3. root-relative POSIX paths. 4. sorted by raw UTF-8 byte order.
// 5. path bytes, 0x00, decimal byte length as ASCII, 0x00, file bytes, 0x0a.
function treeHash(root) {
  const rel = [];
  (function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const r = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.isFile()) rel.push(r);
    }
  })(root, '');
  const kept = rel.filter((r) => r !== 'memory/embeddings.json');
  kept.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const h = createHash('sha256');
  const NUL = Buffer.from([0x00]);
  const LF = Buffer.from([0x0a]);
  for (const r of kept) {
    const bytes = readFileSync(path.join(root, ...r.split('/')));
    h.update(Buffer.from(r, 'utf8')); h.update(NUL);
    h.update(Buffer.from(String(bytes.length), 'ascii')); h.update(NUL);
    h.update(bytes); h.update(LF);
  }
  return h.digest('hex');
}

const fileHash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── environment identity, PREREG-001 4.3 item 7 and residue item 3 ───────────
function modelIdentity() {
  const cache = path.join(SEM, 'node_modules', '@xenova', 'transformers', '.cache', 'Xenova', 'all-MiniLM-L6-v2');
  const out = { name: 'Xenova/all-MiniLM-L6-v2', quantized: true, files: {} };
  if (!existsSync(cache)) { out.files = 'UNKNOWN (no resolvable local cache directory)'; return out; }
  (function walk(dir, prefix) {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      const r = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) out.files[r] = fileHash(full);
    }
  })(cache, '');
  return out;
}

function environmentIdentity() {
  let cpu = 'UNKNOWN';
  try { cpu = os.cpus()[0]?.model?.trim() || 'UNKNOWN'; } catch { /* ignore */ }
  let version = 'UNKNOWN';
  try { version = typeof os.version === 'function' ? os.version() : 'UNKNOWN'; } catch { /* ignore */ }
  return {
    platform: os.platform(), release: os.release(), version, arch: os.arch(),
    cpu, cpuCount: os.cpus()?.length ?? 0, node: process.version, totalMemBytes: os.totalmem(),
  };
}

// ── declared environmental requirements, PREREG-001 4.3 ──────────────────────
function environmentGaps() {
  const gaps = [];
  const major = Number(process.version.replace(/^v/, '').split('.')[0]);
  if (!Number.isFinite(major) || major < 22) gaps.push({ item: 1, why: `Node ${process.version} < 22.0.0` });
  if (!existsSync(path.join(SEM, 'node_modules', '@xenova', 'transformers', 'package.json'))) {
    gaps.push({ item: 2, why: 'daemons/semantic-search/node_modules/@xenova/transformers absent' });
  }
  const weights = path.join(SEM, 'node_modules', '@xenova', 'transformers', '.cache', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx');
  if (!existsSync(weights)) gaps.push({ item: 3, why: 'Xenova/all-MiniLM-L6-v2 quantized weights not resolvable from the local transformers.js cache' });
  if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) gaps.push({ item: 4, why: 'python3 not on PATH (doctor namespace extractor)' });
  if (spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' }).status !== 0) gaps.push({ item: 5, why: 'bash not available (scripts/doctor.sh)' });
  try { rmSync(mkdtempSync(path.join(os.tmpdir(), 'recollection-probe-')), { recursive: true, force: true }); }
  catch (e) { gaps.push({ item: 6, why: `no writable temporary directory: ${e.message}` }); }
  return gaps;
}

// ── sandbox, patterned on daemons/tests/semantic-search-namespace-registry
//    .test.mjs:133-190, with the transformers STUB replaced by a link to the
//    real installed package (PREREG-001 7.2: the benchmark runs the real
//    model, so a constant-vector stub is exactly what it must not use) ────────
function makeSandbox(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `recollection-${name}-`));
  sandboxes.push(root);
  const sem = path.join(root, 'daemons', 'semantic-search');
  const hygiene = path.join(root, 'daemons', 'memory-hygiene');
  mkdirSync(sem, { recursive: true });
  mkdirSync(hygiene, { recursive: true });
  for (const f of ['deny-list.mjs', 'namespace-registry.mjs', 'embed-vault.js', 'search-vault.js', 'namespace-registry.json', 'namespace-registry.local.example.json']) {
    copyFileSync(path.join(SEM, f), path.join(sem, f));
  }
  for (const f of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, f), path.join(root, 'daemons', f));
  }
  copyFileSync(path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'), path.join(hygiene, 'resume-framing.mjs'));

  // The real dependency, not a stub. A junction rather than a copy so the
  // model cache is shared and no sandbox pays for the weights again.
  symlinkSync(path.join(SEM, 'node_modules'), path.join(sem, 'node_modules'), 'junction');

  // Fixture policy files, copied into the sandbox daemons/semantic-search/.
  // They are committed under fixture-registry/ because .gitignore:27 and
  // .gitignore:32 are anchored on **/semantic-search/ (PREREG-001 1.4).
  copyFileSync(path.join(FIXTURE_REGISTRY, 'namespace-registry.local.json'), path.join(sem, 'namespace-registry.local.json'));
  copyFileSync(path.join(FIXTURE_REGISTRY, 'index-deny.json'), path.join(sem, 'index-deny.json'));

  // doctor prerequisites: warnings are fine, unrelated FAILs are not.
  mkdirSync(path.join(root, 'system'), { recursive: true });
  writeFileSync(path.join(root, 'system', '00_identity.md'), '# recollection fixture identity\n');
  writeFileSync(path.join(root, 'CLAUDE.md'), '# recollection fixture instructions\n');
  mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'skill-index.json'), '{}');
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  writeFileSync(path.join(root, '.claude', 'agents', 'fixture.md'), '# fixture agent\n');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(DOCTOR, path.join(root, 'scripts', 'doctor.sh'));

  const vault = path.join(root, 'vault');
  cpSync(CORPUS, vault, { recursive: true });
  mkdirSync(path.join(vault, 'memory'), { recursive: true });

  // Helper used only to embed injected-row text with the real model, so a
  // stale-index row can genuinely outrank everything instead of being a
  // vacuous zero vector. Generated in the sandbox, never committed.
  writeFileSync(path.join(sem, 'embed-one.mjs'),
    "import { pipeline } from '@xenova/transformers';\n"
    + "const p = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });\n"
    + "const o = await p(process.argv[2], { pooling: 'mean', normalize: true });\n"
    + 'process.stdout.write(JSON.stringify(Array.from(o.data)));\n');

  return { root, sem, vault, embeddings: path.join(vault, 'memory', 'embeddings.json') };
}

function runtimeHashGaps(box) {
  const map = {
    'daemons/semantic-search/namespace-registry.json': path.join(box.sem, 'namespace-registry.json'),
    'daemons/semantic-search/namespace-registry.local.example.json': path.join(box.sem, 'namespace-registry.local.example.json'),
    'daemons/semantic-search/namespace-registry.mjs': path.join(box.sem, 'namespace-registry.mjs'),
    'daemons/semantic-search/search-vault.js': path.join(box.sem, 'search-vault.js'),
    'daemons/semantic-search/embed-vault.js': path.join(box.sem, 'embed-vault.js'),
    'daemons/semantic-search/deny-list.mjs': path.join(box.sem, 'deny-list.mjs'),
    'daemons/lifecycle-common.mjs': path.join(box.root, 'daemons', 'lifecycle-common.mjs'),
    'evals/run-evals.mjs': path.join(EVALS, 'run-evals.mjs'),
  };
  const bad = [];
  for (const [label, file] of Object.entries(map)) {
    const got = existsSync(file) ? fileHash(file) : 'ABSENT';
    if (got !== RUNTIME_HASHES[label]) bad.push({ file: label, expected: RUNTIME_HASHES[label], observed: got });
  }
  return bad;
}

// PREREG-001 1.3 requires the RUN to record the eight hashes, and it means the
// sandbox copies the run actually executed. Writing the pinned constant instead
// made a mutation invisible: the F5 packet at head a72f68b reported the pin for
// namespace-registry.json even though F5's whole mutation is editing that file.
// The four unpinned copies the sandbox also carries are recorded, not gated.
function sandboxFileMap(box) {
  return {
    'daemons/semantic-search/namespace-registry.json': path.join(box.sem, 'namespace-registry.json'),
    'daemons/semantic-search/namespace-registry.local.example.json': path.join(box.sem, 'namespace-registry.local.example.json'),
    'daemons/semantic-search/namespace-registry.mjs': path.join(box.sem, 'namespace-registry.mjs'),
    'daemons/semantic-search/search-vault.js': path.join(box.sem, 'search-vault.js'),
    'daemons/semantic-search/embed-vault.js': path.join(box.sem, 'embed-vault.js'),
    'daemons/semantic-search/deny-list.mjs': path.join(box.sem, 'deny-list.mjs'),
    'daemons/lifecycle-common.mjs': path.join(box.root, 'daemons', 'lifecycle-common.mjs'),
    'evals/run-evals.mjs': path.join(EVALS, 'run-evals.mjs'),
    // recorded, never gated: the packet pins no value for these
    'scripts/doctor.sh': path.join(box.root, 'scripts', 'doctor.sh'),
    'daemons/frontmatter-reader.cjs': path.join(box.root, 'daemons', 'frontmatter-reader.cjs'),
    'daemons/capsule-content-gate.mjs': path.join(box.root, 'daemons', 'capsule-content-gate.mjs'),
    'daemons/memory-hygiene/resume-framing.mjs': path.join(box.root, 'daemons', 'memory-hygiene', 'resume-framing.mjs'),
  };
}

function observedRuntimeHashes(box) {
  if (!box) return null;
  const out = {};
  for (const [label, file] of Object.entries(sandboxFileMap(box))) {
    const observed = existsSync(file) ? fileHash(file) : 'ABSENT';
    const pinned = RUNTIME_HASHES[label] || null;
    out[label] = pinned
      ? { observed, pinned, matchesPin: observed === pinned }
      : { observed, pinned: null, matchesPin: null };
  }
  return out;
}

function runNode(box, script, args = []) {
  const r = spawnSync(process.execPath, [path.join(box.sem, script), ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AIGENT_ROOT: box.root, AIGENT_VAULT_ROOT: box.vault },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return { status: r.status, stdout, stderr, all: stdout + stderr };
}

function runDoctor(box) {
  const r = spawnSync('bash', [path.join(box.root, 'scripts', 'doctor.sh'), box.root], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return { status: r.status, stdout, stderr, all: stdout + stderr };
}

function buildIndex(box) {
  const t = Date.now();
  const r = runNode(box, 'embed-vault.js');
  return { ...r, ms: Date.now() - t };
}

function embedOne(box, text) {
  const r = spawnSync(process.execPath, [path.join(box.sem, 'embed-one.mjs'), text], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, AIGENT_ROOT: box.root, AIGENT_VAULT_ROOT: box.vault },
  });
  if (r.status !== 0) throw new Error(`embed helper failed: ${(r.stderr || '').slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

// Human mode, not --json: search-vault.js returns at :181-184 BEFORE the
// timing line, so --json gives no timings (PREREG-001 4.1). Both the timing
// line and the trailing JSON block are parsed out of the human output.
function search(box, query) {
  const r = runNode(box, 'search-vault.js', [query]);
  const out = { ...r, query, rows: null, timings: null, jsonBytes: null, parseError: null };
  const timing = r.stdout.match(/^Embed: (\d+)ms \| Search: (\d+)ms \| Total: (\d+)ms$/m);
  if (timing) out.timings = { embed: +timing[1], search: +timing[2], total: +timing[3] };
  const marker = r.stdout.lastIndexOf('\nJSON:\n');
  if (marker !== -1) {
    const block = r.stdout.slice(marker + '\nJSON:\n'.length).trim();
    out.jsonBytes = Buffer.byteLength(block, 'utf8');
    try { out.rows = JSON.parse(block); } catch (e) { out.parseError = e.message; }
  }
  return out;
}

const readIndex = (box) => JSON.parse(readFileSync(box.embeddings, 'utf8'));
const writeIndex = (box, index) => writeFileSync(box.embeddings, JSON.stringify(index, null, 0));

// PREREG-001 3.7 scopes load-time loudness to the invocation's POPULATION LOAD,
// not to its output as a whole. search-vault.js:116-126 prints the index-load
// report and only then prints `Query: "..."` (:131) and the result rows, whose
// `Path:` lines name every returned path. Scanning the whole of stdout would
// therefore score a carried-forward dangling row as "named at load" purely
// because the product RETURNED it -- the opposite of what this class measures.
// The window is: stdout up to the query echo, plus all of stderr.
function populationLoadOutput(res) {
  const q = res.stdout.indexOf('\nQuery: "');
  return (q === -1 ? res.stdout : res.stdout.slice(0, q)) + res.stderr;
}

// ── policy classification of a returned path, mirroring what the product
//    itself applies: prefix deny first, then namespace disposition ───────────
const FIXTURE_LOCAL = JSON.parse(readFileSync(path.join(FIXTURE_REGISTRY, 'namespace-registry.local.json'), 'utf8'));
const CORE_REGISTRY = JSON.parse(readFileSync(path.join(SEM, 'namespace-registry.json'), 'utf8'));
const DENY_PREFIXES = JSON.parse(readFileSync(path.join(FIXTURE_REGISTRY, 'index-deny.json'), 'utf8')).deny_prefixes.map((p) => String(p).toLowerCase());
const DISPOSITION = new Map();
for (const row of [...CORE_REGISTRY.namespaces, ...FIXTURE_LOCAL.namespaces]) DISPOSITION.set(row.path.toLowerCase(), row.disposition);

function policyOf(p) {
  const s = String(p).replace(/\\/g, '/').toLowerCase();
  if (DENY_PREFIXES.some((d) => s.startsWith(d))) return 'DENY-PREFIX';
  return DISPOSITION.get(s.split('/')[0]) || 'UNDECLARED';
}
const isLeakyPolicy = (p) => policyOf(p) !== 'INDEX';

// Every canary token in the corpus belonging to a SKIP, DENY or prefix-denied
// note. PREREG-001 3.5 scans process output for these.
const CANARIES = (function corpusCanaries() {
  const found = new Map();
  (function walk(dir, prefix) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const r = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (!e.isFile() || !r.endsWith('.md') || !isLeakyPolicy(r)) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(/CANARY-[A-Za-z0-9-]+/g)) found.set(m[0], r);
    }
  })(CORPUS, '');
  return found;
})();

function leakedCanaries(text) {
  const hits = [];
  for (const [token, source] of CANARIES) if (text.includes(token)) hits.push({ token, source });
  return hits;
}

// The bounded text is the trailing JSON string literal of the tag line.
function renderedText(line) {
  const i = line.indexOf('] ');
  if (i === -1) return null;
  try { return JSON.parse(line.slice(i + 2)); } catch { return null; }
}

// ── PREREG-001 3.3 provenance requirement ────────────────────────────────────
function provenanceFailure(row) {
  if (typeof row.chunk !== 'string') return 'chunk is not a string';
  if (row.chunk.startsWith('[REFUSED:')) return `chunk refused: ${row.chunk.slice(0, 60)}`;
  const m = row.chunk.match(PROVENANCE_RE);
  if (!m) return 'chunk does not match the renderPersisted tag shape';
  if (m.groups.path !== row.path) return `tag path ${m.groups.path} != row path ${row.path}`;
  const prov = row.chunkProvenance;
  if (!prov || typeof prov !== 'object') return 'chunkProvenance missing';
  if ('refused' in prov) return `chunkProvenance carries refused: ${prov.refused}`;
  const want = {
    source: row.path, sha256: m.groups.sha, acquiredAt: m.groups.at,
    trust: 'persisted-data', role: 'vault-chunk', disposition: 'INDEX', authority: 'none',
  };
  for (const [key, value] of Object.entries(want)) {
    if (prov[key] !== value) return `chunkProvenance.${key} is ${JSON.stringify(prov[key])}, expected ${JSON.stringify(value)}`;
  }
  const extra = Object.keys(prov).filter((k) => !(k in want));
  if (extra.length) return `chunkProvenance has unexpected field(s): ${extra.join(', ')}`;
  const text = renderedText(row.chunk);
  if (text === null) return 'cannot recover the bounded text from the tag';
  if (text.length > CHUNK_CHARS_MAX) return `rendered text is ${text.length} chars, over the ${CHUNK_CHARS_MAX} bound`;
  return null;
}

// ── budget accounting, PREREG-001 4.1 / 4.2. Reported separately from hit
//    accounting: a breach never converts a correct hit into a miss. ──────────
const budgetBreaches = [];
function checkBudget(id, res) {
  // A process that exited non-zero produced no timing line because it never
  // reached search-vault.js:206, not because it was slow. Charging that as a
  // budget breach let a dead retriever override its own declared UNRUNNABLE and
  // force the run terminal to FAIL (58 spurious breaches in the F6 packet at
  // head a72f68b). Budget accounting only applies to a run that happened.
  if (res.status !== 0) return [];
  const b = [];
  if (!res.timings) b.push('no timing line parsed from human-mode output');
  else {
    if (res.timings.search > T_SEARCH_MAX_MS) b.push(`t_search ${res.timings.search}ms > ${T_SEARCH_MAX_MS}ms`);
    if (res.timings.embed > T_EMBED_MAX_MS) b.push(`t_embed ${res.timings.embed}ms > ${T_EMBED_MAX_MS}ms`);
  }
  if (res.jsonBytes != null) {
    if (res.jsonBytes > JSON_BYTES_MAX) b.push(`json ${res.jsonBytes} bytes > ${JSON_BYTES_MAX}`);
    const tokens = Math.ceil(res.jsonBytes / 4);
    if (tokens > TOKENS_MAX) b.push(`estimated tokens ${tokens} > ${TOKENS_MAX}`);
  }
  for (const row of res.rows || []) {
    const t = typeof row.chunk === 'string' && !row.chunk.startsWith('[REFUSED:') ? renderedText(row.chunk) : null;
    if (t && t.length > CHUNK_CHARS_MAX) b.push(`row ${row.path} rendered text ${t.length} chars > ${CHUNK_CHARS_MAX}`);
  }
  if (b.length) budgetBreaches.push({ id, breaches: b });
  return b;
}

// A policy false positive observed while scoring ANY case is recorded against
// C or S as an additional failure and fails the run (PREREG-001 3.5).
const policyFalsePositives = [];
function scanPolicy(id, res) {
  const rows = [];
  for (const row of res.rows || []) {
    if (!isLeakyPolicy(row.path)) continue;
    const refused = typeof row.chunk === 'string' && row.chunk.startsWith('[REFUSED:');
    rows.push({ id, path: row.path, policy: policyOf(row.path), refused, chunk: String(row.chunk).slice(0, 120) });
  }
  policyFalsePositives.push(...rows.filter((r) => !r.refused));
  const canaryHits = leakedCanaries(res.all);
  policyFalsePositives.push(...canaryHits.map((h) => ({ id, path: h.source, policy: 'CANARY-IN-PROCESS-OUTPUT', refused: false, chunk: h.token })));
  return { rows, canaryHits };
}

const rankOf = (res, p) => {
  const i = (res.rows || []).findIndex((r) => r.path === p);
  return i === -1 ? null : i + 1;
};

// ── case scorers ─────────────────────────────────────────────────────────────
function scorePositive(box, c) {
  const res = search(box, c.query);
  checkBudget(c.id, res);
  scanPolicy(c.id, res);
  if (res.status !== 0) return record(c.id, c.class, 'fail', `search exited ${res.status}: ${res.stderr.trim().slice(0, 200)}`);
  if (!res.rows) return record(c.id, c.class, 'fail', `no JSON block parsed${res.parseError ? ` (${res.parseError})` : ''}`);
  const rank = rankOf(res, c.target);
  const top = res.rows[0];
  const extra = { rank, topPath: top?.path, topScore: top?.score, target: c.target };
  if (rank === null || rank > K) {
    return record(c.id, c.class, 'fail', `target not in top ${K}; top-1 was ${top?.path} at ${top?.score}`, extra);
  }
  const prov = provenanceFailure(res.rows[rank - 1]);
  if (prov) return record(c.id, c.class, 'fail', `hit at rank ${rank} but provenance failed: ${prov}`, extra);
  record(c.id, c.class, 'pass', `rank ${rank}, score ${res.rows[rank - 1].score}`, extra);
}

function scoreNegative(box, c) {
  const res = search(box, c.query);
  checkBudget(c.id, res);
  scanPolicy(c.id, res);
  // PREREG-001 6/F6: a dead retriever trivially satisfies "returned nothing
  // above tau" and must never be allowed to certify the negative class.
  if (res.status !== 0) {
    return record(c.id, c.class, 'unrunnable', `search exited ${res.status}; a non-zero exit can never certify abstention`,
      { requires: 'PREREG-001 6 F6 — search process exited non-zero' });
  }
  if (!res.rows) return record(c.id, c.class, 'fail', 'no JSON block parsed');
  const top1 = res.rows[0]?.score;
  const near = top1 != null && Math.abs(top1 - TAU) <= NEAR_THRESHOLD;
  const extra = { top1, topPath: res.rows[0]?.path, nearThreshold: near, kind: c.kind };
  if (top1 == null) return record(c.id, c.class, 'fail', 'no rows returned to score against tau', extra);
  if (top1 >= TAU) return record(c.id, c.class, 'fail', `top-1 ${top1} >= tau ${TAU} (${res.rows[0].path})`, extra);
  record(c.id, c.class, 'pass', `top-1 ${top1} < tau ${TAU}${near ? ' [near-threshold]' : ''}`, extra);
}

const inversions = [];
function scoreTemporal(box, c) {
  const res = search(box, c.query);
  checkBudget(c.id, res);
  scanPolicy(c.id, res);
  if (res.status !== 0) return record(c.id, c.class, 'fail', `search exited ${res.status}`);
  if (!res.rows) return record(c.id, c.class, 'fail', 'no JSON block parsed');
  const cur = rankOf(res, c.current);
  const sup = rankOf(res, c.superseded);
  if (sup !== null && (cur === null || sup < cur)) inversions.push({ id: c.id, currentRank: cur, supersededRank: sup });
  const extra = { currentRank: cur, supersededRank: sup, current: c.current, superseded: c.superseded };
  const fails = [];
  if (cur === null || cur > K) fails.push(`current note not in top ${K}`);
  if (sup !== null && sup <= K) fails.push(`superseded note present at rank ${sup}`);
  if (cur !== null && cur <= K) {
    const text = renderedText(res.rows[cur - 1].chunk);
    if (text === null || !text.includes(c.validLine)) fails.push(`returned chunk does not contain "${c.validLine}"`);
    const prov = provenanceFailure(res.rows[cur - 1]);
    if (prov) fails.push(`provenance failed: ${prov}`);
  }
  if (fails.length) return record(c.id, c.class, 'fail', fails.join('; '), extra);
  record(c.id, c.class, 'pass', `current at rank ${cur}, superseded absent from top ${K}`, extra);
}

// Zero tolerance. Absence and refusal are both acceptable outcomes; leaking
// the text is not (PREREG-001 3.3, 3.5).
function scoreWithheld(box, c) {
  const res = search(box, c.query);
  checkBudget(c.id, res);
  const policy = scanPolicy(c.id, res);
  if (res.status !== 0) return record(c.id, c.class, 'fail', `search exited ${res.status}`);
  if (!res.rows) return record(c.id, c.class, 'fail', 'no JSON block parsed');
  const present = res.rows.find((r) => r.path === c.target);
  const extra = { target: c.target, targetReturned: !!present, topPath: res.rows[0]?.path, topScore: res.rows[0]?.score };
  if (c.canary && res.all.includes(c.canary)) return record(c.id, c.class, 'fail', `canary ${c.canary} appeared in process output`, extra);
  if (present && !String(present.chunk).startsWith('[REFUSED:')) {
    return record(c.id, c.class, 'fail', 'target row returned with a non-refused chunk', extra);
  }
  const leaks = policy.rows.filter((r) => !r.refused);
  if (leaks.length) return record(c.id, c.class, 'fail', `policy false positive in results: ${leaks.map((r) => r.path).join(', ')}`, extra);
  record(c.id, c.class, 'pass', present ? 'present but refused' : 'absent from results', extra);
}

function scoreStaleIndex(box, c, staleRow) {
  // PREREG-001 5.1 reserves UNRUNNABLE for a missing item from the finite 4.3
  // list; 3.7 adds that a case whose mechanism is absent is "never UNRUNNABLE
  // and never a skip". An index removed by a mutation is neither, so this is a
  // FAIL. The earlier `requires: "PREREG-001 6 F6"` cited a rule the packet
  // does not contain.
  if (!existsSync(box.embeddings)) {
    return record(c.id, c.class, 'fail', 'index absent', { injectedPath: staleRow?.path ?? null });
  }
  const pristine = readFileSync(box.embeddings, 'utf8');
  try {
    let vector;
    try { vector = embedOne(box, staleRow.chunk); }
    catch (e) { return record(c.id, c.class, 'unrunnable', `real-model embed helper failed: ${e.message}`, { requires: 'PREREG-001 4.3 item 2/3' }); }
    const index = readIndex(box);
    index.notes.push({ path: staleRow.path, title: staleRow.title, tags: [], chunk: staleRow.chunk, embedding: vector, mtime: 0 });
    index.entryCount = index.notes.length;
    writeIndex(box, index);
    const res = search(box, c.query);
    checkBudget(c.id, res);
    scanPolicy(c.id, res);
    if (res.status !== 0) return record(c.id, c.class, 'fail', `search exited ${res.status}`);
    if (!res.rows) return record(c.id, c.class, 'fail', 'no JSON block parsed');
    const present = res.rows.find((r) => r.path === staleRow.path);
    const extra = { injectedPath: staleRow.path, expectedDisposition: c.expectedDisposition, returned: !!present, topPath: res.rows[0]?.path };
    if (res.all.includes(c.canary)) return record(c.id, c.class, 'fail', `injected canary ${c.canary} appeared in process output`, extra);
    if (present && !String(present.chunk).startsWith('[REFUSED:')) {
      return record(c.id, c.class, 'fail', 'injected non-INDEX row returned with a non-refused chunk', extra);
    }
    record(c.id, c.class, 'pass', present ? 'present but refused' : 'dropped by the index filter', extra);
  } finally {
    writeFileSync(box.embeddings, pristine);
  }
}

function doctorNamespaceRecords(box) {
  const r = runDoctor(box);
  const failed = [];
  for (const m of r.all.matchAll(/NAMESPACE_UNDECLARED\s+(\S+)/g)) failed.push(`NAMESPACE_UNDECLARED ${m[1]}`);
  return { failedRecords: [...new Set(failed)], status: r.status, all: r.all };
}

function scoreUndeclared(box, c, doctorResult) {
  const script = c.runtime;
  const res = script === 'embed-vault.js' ? runNode(box, script) : search(box, c.query);
  const fails = [];
  if (res.status === 0) fails.push(`${script} exited 0, expected non-zero`);
  if (!/REFUSING to run: undeclared vault namespace director(y|ies): [^\n]*scratch/.test(res.all)) {
    fails.push(`${script} output did not name the undeclared directory`);
  }
  if (!doctorResult) fails.push('doctor not run');
  else if (!doctorResult.failedRecords.includes(c.doctorRecord)) fails.push(`doctor did not emit "${c.doctorRecord}" as a failure`);
  const extra = { exit: res.status, doctorRecords: doctorResult ? doctorResult.failedRecords : null };
  if (fails.length) return record(c.id, c.class, 'fail', fails.join('; '), extra);
  record(c.id, c.class, 'pass', `${script} refused and doctor failed the namespace record`, extra);
}

const scoreOperator = (box, c) => (c.kind === 'index' ? scorePositive(box, c) : scoreWithheld(box, c));

// PREREG-001 3.7. The report must appear on the invocation that LOADS the
// population, naming the offending path. A later audit does not satisfy it.
function scoreLoudness(box, c) {
  // Same rule as scoreStaleIndex above: 3.7 forbids UNRUNNABLE for this class.
  if (!existsSync(box.embeddings)) return record(c.id, c.class, 'fail', 'index absent');
  if (c.kind === 'deleted-source') {
    rmSync(path.join(box.vault, ...c.deletePath.split('/')), { force: true });
    const res = search(box, c.query);
    checkBudget(c.id, res);
    scanPolicy(c.id, res);
    const named = populationLoadOutput(res).includes(c.deletePath);
    const extra = { deleted: c.deletePath, namedAtLoad: named, exit: res.status, loadWindow: populationLoadOutput(res).trim().slice(-300) };
    if (!named) return record(c.id, c.class, 'fail', `population load never named the deleted source ${c.deletePath}`, extra);
    return record(c.id, c.class, 'pass', 'deleted source named at population load', extra);
  }
  const pristine = readFileSync(box.embeddings, 'utf8');
  try {
    let vector;
    try { vector = embedOne(box, c.chunk); }
    catch (e) { return record(c.id, c.class, 'unrunnable', `real-model embed helper failed: ${e.message}`, { requires: 'PREREG-001 4.3 item 2/3' }); }
    const index = readIndex(box);
    index.notes.push({ path: c.injectedPath, title: 'never-existed-phantom', tags: [], chunk: c.chunk, embedding: vector, mtime: 0 });
    index.entryCount = index.notes.length;
    writeIndex(box, index);
    const res = search(box, c.query);
    checkBudget(c.id, res);
    scanPolicy(c.id, res);
    const named = populationLoadOutput(res).includes(c.injectedPath);
    const extra = { injectedPath: c.injectedPath, namedAtLoad: named, exit: res.status, loadWindow: populationLoadOutput(res).trim().slice(-300) };
    if (!named) return record(c.id, c.class, 'fail', `population load never named the missing source ${c.injectedPath}`, extra);
    record(c.id, c.class, 'pass', 'missing source named at population load', extra);
  } finally {
    writeFileSync(box.embeddings, pristine);
  }
}

// ── scenario table, PREREG-001 6 ─────────────────────────────────────────────
// One source of truth for what each run mutates and what it must turn red. A
// scenario name this table does not contain is a harness error: before this
// existed, `--scenario F9` silently ran an unmutated baseline, labelled the
// packet F9, and cited a fabricated "PREREG-001 6 F9" in its declarations.
//
// `expectedRed` / `expectedRedClasses` are checked at packet time and written
// into every packet, so a falsifier that stops falsifying is visible in the
// artifact rather than only in prose.
const SCENARIOS = {
  BASELINE: {
    mutation: 'none (unmutated corpus)',
    expectedRed: [], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: true,
  },
  F1: {
    mutation: "delete case P-07's target note from the sandbox vault, then a FULL rebuild",
    expectedRed: ['P-07'], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: false,
  },
  F2: {
    mutation: 'add a long research/ note paraphrasing N-04 without answering it, then a full rebuild',
    expectedRed: ['N-04'], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: false,
    caveat: 'N-04 is already FAIL on the unmutated corpus (top-1 0.5771, far above tau 0.30), so this '
      + 'falsifier cannot demonstrate a green-to-red TRANSITION here. What it demonstrates is that the '
      + 'mutation lands and the negative-class instrument responds: top-1 rises and the injected '
      + 'distractor takes rank 1. That is evidence about tau, not about the falsifier.',
  },
  F3: {
    mutation: "rewrite T-03's superseded note to duplicate the current note's body and restate the T-03 query",
    expectedRed: ['T-03'], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: false,
    expectInversionsAtLeast: 1,
    // T-03 is already FAIL on the unmutated corpus, and the unmutated corpus
    // already carries two inversions (T-02, T-04), so `expectedRed: ['T-03']`
    // and `expectInversionsAtLeast: 1` are BOTH already true before F3 runs.
    // The green-to-red transition this falsifier actually produces is T-03
    // entering the inversion list, so that is what must be asserted by id.
    expectInversionIds: ['T-03'],
    caveat: 'T-03 is already FAIL on the unmutated corpus (its superseded note sits at rank 2 like every '
      + 'other pair), and the unmutated corpus already records two inversions, T-02 and T-04. So neither '
      + 'the expected-red id nor a bare inversion count can witness this mutation. The green-to-red '
      + 'transition lives in WHICH ids invert: T-03 is absent from the baseline inversion list and present '
      + 'after the mutation, which is the clause expectInversionIds asserts.',
  },
  F4: {
    mutation: "inject a row inside ops-deny/ carrying C-02's DENY canary text with the captured rank-1 embedding vector",
    expectedRed: [], expectedRedClasses: [], expectPass: ['PC-01', 'C-02'],
    unrunnableClasses: [], runU: false,
    note: 'confirmatory, not destructive: the expected observation is that C-02 stays PASS and the canary never reaches stdout',
  },
  F5: {
    mutation: 'copy the undeclared overlay in as scratch/ AND delete the feedback row from the sandbox core registry',
    expectedRed: [], expectedRedClasses: [], expectPass: ['U-01', 'U-02'],
    unrunnableClasses: ['positive', 'negative', 'temporal', 'deny', 'skip', 'stale-index', 'operator', 'loudness'],
    runU: true,
  },
  F6: {
    mutation: 'delete <sandbox vault>/memory/embeddings.json and run without rebuilding',
    expectedRed: ['PC-01'], expectedRedClasses: ['positive', 'temporal', 'operator'], expectPass: [],
    unrunnableClasses: ['negative'], runU: false,
  },
};

// ── gates, PREREG-001 5.2 ────────────────────────────────────────────────────
const GATES = [
  { klass: 'positive', label: 'positive quality', n: 24, gate: 'hit@5 on >= 22 of 24', min: 22 },
  { klass: 'negative', label: 'negative / no answer', n: 12, gate: `>= 11 of 12 with top-1 score < tau (${TAU})`, min: 11 },
  { klass: 'temporal', label: 'temporal', n: 8, gate: '>= 7 of 8 three-condition passes AND 0 inversions', min: 7 },
  { klass: 'deny', label: 'confidential DENY', n: 6, gate: '6 of 6', min: 6 },
  { klass: 'skip', label: 'SKIP', n: 4, gate: '4 of 4', min: 4 },
  { klass: 'stale-index', label: 'stale non-INDEX', n: 3, gate: '3 of 3', min: 3 },
  { klass: 'undeclared', label: 'undeclared coverage', n: 2, gate: '2 of 2', min: 2 },
  { klass: 'operator', label: 'operator-owned', n: 3, gate: '3 of 3', min: 3 },
  { klass: 'loudness', label: 'load-time loudness', n: 2, gate: '2 of 2', min: 2 },
];

// ── main ─────────────────────────────────────────────────────────────────────
const started = Date.now();
const harnessErrors = [];

const corpusHash = treeHash(CORPUS);
const overlayHash = treeHash(OVERLAY);
const fixtureHash = treeHash(FIXTURE_REGISTRY);
const model = modelIdentity();
const env = environmentIdentity();

if (FREEZE_ONLY) {
  console.log(JSON.stringify({
    corpus_sha256: corpusHash, overlay_sha256: overlayHash, fixture_registry_sha256: fixtureHash,
    model, environment: env,
    runtime_hashes_observed: Object.fromEntries(Object.keys(RUNTIME_HASHES).map((k) => [k, fileHash(path.join(ROOT, ...k.split('/')))])),
  }, null, 2));
  process.exit(0);
}

// The runner recomputes all three at the start of every run and refuses to
// score anything if a value differs from the recorded one (PREREG-001 1.5).
let frozen = null;
if (existsSync(COMPUTED)) {
  const text = readFileSync(COMPUTED, 'utf8');
  const grab = (key) => (text.match(new RegExp(`^${key}\\s+([0-9a-f]{64})`, 'm')) || [])[1] || null;
  frozen = { corpus_sha256: grab('corpus_sha256'), overlay_sha256: grab('overlay_sha256'), fixture_registry_sha256: grab('fixture_registry_sha256') };
  if (frozen.corpus_sha256 !== corpusHash) harnessErrors.push(`fixture hash mismatch: corpus_sha256 frozen ${frozen.corpus_sha256} observed ${corpusHash}`);
  if (frozen.overlay_sha256 !== overlayHash) harnessErrors.push(`fixture hash mismatch: overlay_sha256 frozen ${frozen.overlay_sha256} observed ${overlayHash}`);
  if (frozen.fixture_registry_sha256 !== fixtureHash) harnessErrors.push(`fixture hash mismatch: fixture_registry_sha256 frozen ${frozen.fixture_registry_sha256} observed ${fixtureHash}`);
} else {
  harnessErrors.push('PREREG-001-COMPUTED.md absent: the frozen hashes must exist before a run can be scored');
}

const cases = JSON.parse(readFileSync(path.join(HERE, 'cases', 'queries.json'), 'utf8')).cases;
const staleRows = JSON.parse(readFileSync(path.join(HERE, 'cases', 'stale-index.json'), 'utf8')).rows;
const byId = new Map(cases.map((c) => [c.id, c]));
if (byId.size !== cases.length) harnessErrors.push('duplicate case id in queries.json');

// ── fixture integrity, PREREG-001 2 and 5.1 ──────────────────────────────────
// Every fixed id the scenarios dereference must exist, the X ids must line up
// with stale-index.json, and the per-class counts must equal the frozen
// section-2 table. Without this, fixture drift crashed the runner on an
// unguarded byId.get(...).target with no packet written at all -- a silent
// disappearance, which is exactly what a harness error is for.
export function integrityErrors(caseList, staleList, gates) {
  const errors = [];
  const ids = new Map(caseList.map((c) => [c.id, c]));
  const FIXED = ['PC-01', 'P-07', 'C-02', 'T-03', 'L-01', 'L-02', 'U-01', 'U-02', 'N-04'];
  for (const id of FIXED) if (!ids.has(id)) errors.push(`fixture integrity: case ${id} is referenced by name but absent from queries.json`);
  if (ids.has('P-07') && !ids.get('P-07').target) errors.push('fixture integrity: P-07 has no target');
  if (ids.has('C-02') && !ids.get('C-02').target) errors.push('fixture integrity: C-02 has no target');
  if (ids.has('T-03') && !(ids.get('T-03').current && ids.get('T-03').superseded)) errors.push('fixture integrity: T-03 is missing current/superseded');

  const xCases = caseList.filter((c) => c.class === 'stale-index').map((c) => c.id).sort();
  const xRows = (staleList || []).map((s) => s.id).sort();
  if (xCases.join(',') !== xRows.join(',')) {
    errors.push(`fixture integrity: stale-index case ids [${xCases}] do not match stale-index.json rows [${xRows}]`);
  }

  for (const g of gates) {
    const n = caseList.filter((c) => c.class === g.klass).length;
    if (n !== g.n) errors.push(`fixture integrity: class ${g.klass} has ${n} case(s), frozen section-2 count is ${g.n}`);
  }
  const scored = caseList.filter((c) => c.class !== 'positive-control').length;
  if (scored !== 64) errors.push(`fixture integrity: ${scored} scored cases, frozen section-2 total is 64`);
  return errors;
}

// The runnable red witness for the block above, kept permanently so it cannot
// rot: mutate an in-memory COPY of the frozen cases and assert it is caught.
// Never touches the committed fixture. Run: --self-check
if (argv.includes('--self-check')) {
  const staleSelf = JSON.parse(readFileSync(path.join(HERE, 'cases', 'stale-index.json'), 'utf8')).rows;
  const clean = integrityErrors(cases, staleSelf, GATES);
  const renamed = cases.map((c) => (c.id === 'P-07' ? { ...c, id: 'P-99' } : c));
  const mutated = integrityErrors(renamed, staleSelf, GATES);
  const dropped = integrityErrors(cases.filter((c) => c.id !== 'N-01'), staleSelf, GATES);
  const xDrift = integrityErrors(cases, staleSelf.slice(1), GATES);
  const ok = clean.length === 0 && mutated.length > 0 && dropped.length > 0 && xDrift.length > 0;
  console.log(`clean fixture      : ${clean.length} error(s) ${clean.length === 0 ? 'OK' : `FAIL ${clean}`}`);
  console.log(`renamed P-07->P-99 : ${mutated.length} error(s) ${mutated.length ? `OK — ${mutated[0]}` : 'FAIL (not caught)'}`);
  console.log(`dropped N-01       : ${dropped.length} error(s) ${dropped.length ? `OK — ${dropped[0]}` : 'FAIL (not caught)'}`);
  console.log(`stale-index drift  : ${xDrift.length} error(s) ${xDrift.length ? `OK — ${xDrift[0]}` : 'FAIL (not caught)'}`);
  console.log(ok ? 'SELF-CHECK PASS' : 'SELF-CHECK FAIL');
  process.exit(ok ? 0 : 1);
}

if (!Object.hasOwn(SCENARIOS, SCENARIO)) {
  harnessErrors.push(`unknown scenario "${SCENARIO}": expected one of ${Object.keys(SCENARIOS).join(', ')}. `
    + 'Refusing to run an unmutated baseline under an unrecognised label.');
}
const SPEC = SCENARIOS[SCENARIO] || { mutation: null, expectedRed: [], expectedRedClasses: [], expectPass: [], unrunnableClasses: [], runU: false };

// Lexical copy limit, enforced mechanically over the corpus and the query
// file. A violation is a harness error, never a pass (PREREG-001 2 rule 2).
{
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const noteText = (rel) => {
    const raw = readFileSync(path.join(CORPUS, ...rel.split('/')), 'utf8');
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    const title = (raw.match(/^title:\s*(.+)$/m) || [])[1] || '';
    return `${title} ${m ? raw.slice(m[0].length) : raw}`;
  };
  for (const c of cases) {
    const target = c.target || c.current;
    if (!target || !c.query) continue;
    const doc = normalize(noteText(target));
    const grams = new Set();
    for (let i = 0; i + 4 <= doc.length; i++) grams.add(doc.slice(i, i + 4).join(' '));
    const q = normalize(c.query);
    for (let i = 0; i + 4 <= q.length; i++) {
      const g = q.slice(i, i + 4).join(' ');
      if (grams.has(g)) harnessErrors.push(`${c.id}: query shares a run of 4 tokens with ${target}: "${g}"`);
    }
  }
}

const staleRowsForIntegrity = JSON.parse(readFileSync(path.join(HERE, 'cases', 'stale-index.json'), 'utf8')).rows;
harnessErrors.push(...integrityErrors(cases, staleRowsForIntegrity, GATES));

const gaps = environmentGaps();
const ALL_QUALITY = cases
  .filter((c) => ['positive', 'negative', 'temporal', 'deny', 'skip', 'stale-index', 'operator', 'loudness'].includes(c.class))
  .map((c) => c.id);

let box = null;
let indexBuild = null;
let doctor = null;
const scenarioNotes = [];

function declareUnrunnable(ids, why, requires) {
  for (const id of ids) record(id, byId.get(id).class, 'unrunnable', why, { requires });
}

if (harnessErrors.length === 0 && gaps.length > 0) {
  declareUnrunnable(cases.map((c) => c.id),
    gaps.map((g) => `4.3 item ${g.item}: ${g.why}`).join('; '),
    `PREREG-001 4.3 (${gaps.map((g) => `item ${g.item}`).join(', ')})`);
}

if (harnessErrors.length === 0 && gaps.length === 0) {
  box = makeSandbox(SCENARIO.toLowerCase());
  const badHashes = runtimeHashGaps(box);
  if (badHashes.length) {
    for (const b of badHashes) harnessErrors.push(`runtime hash mismatch ${b.file}: expected ${b.expected} observed ${b.observed}`);
    declareUnrunnable(cases.map((c) => c.id), 'sandbox runtime hashes do not match PREREG-001 1.3', 'PREREG-001 1.3');
  } else {
    // ── scenario mutations, applied to the SANDBOX only. The committed
    //    corpus, the committed fixture registry and the product tree are
    //    never modified (PREREG-001 6).
    const T03 = byId.get('T-03');
    if (SCENARIO === 'F1') {
      const P07 = byId.get('P-07').target;
      rmSync(path.join(box.vault, ...P07.split('/')), { force: true });
      scenarioNotes.push(`F1 mutation: deleted ${P07} from the sandbox vault, then a FULL rebuild (carry-forward at embed-vault.js:253-257 retains rows for a deleted source, so --changed-only would not do)`);
    }
    if (SCENARIO === 'F2') {
      writeFileSync(path.join(box.vault, 'research', 'rooftop-colony-second-season.md'),
        '---\ntitle: Rooftop colony second season notes\ntags: [research]\n---\n\n'
        + '# Rooftop colony second season notes\n\n'
        + 'How much honey each roof colony gave in its second season is exactly the question this '
        + 'note circles without ever answering. The second season of the rooftop colonies was watched '
        + 'closely, and the yield per colony across that second season was discussed at length by '
        + 'everyone who visited the roof that year. Whether a roof colony gives more honey in its '
        + 'second season than in its first came up repeatedly. The per colony honey figures for the '
        + 'second season on the roof were never actually written down anywhere, and this note records '
        + 'only that the question of second season honey per rooftop colony was asked.\n');
      scenarioNotes.push(`F2 mutation: added research/rooftop-colony-second-season.md, a long paraphrase of N-04 ("${byId.get('N-04').query}") that answers nothing, then a full rebuild`);
    }
    if (SCENARIO === 'F3') {
      const raw = readFileSync(path.join(box.vault, ...T03.current.split('/')), 'utf8');
      const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
      writeFileSync(path.join(box.vault, ...T03.superseded.split('/')),
        '---\ntitle: Expense approval ceiling, earlier\ntags: [policy, superseded]\n---\n'
        + (m ? raw.slice(m[0].length) : raw) + `\n${T03.query}\n`);
      scenarioNotes.push(`F3 mutation: rewrote ${T03.superseded} so its body duplicates ${T03.current} and additionally restates the T-03 query in the query's own phrasing, then a full rebuild`);
    }
    if (SCENARIO === 'F5') {
      cpSync(path.join(OVERLAY, 'scratch'), path.join(box.vault, 'scratch'), { recursive: true });
      const reg = JSON.parse(readFileSync(path.join(box.sem, 'namespace-registry.json'), 'utf8'));
      reg.namespaces = reg.namespaces.filter((r) => r.path !== 'feedback');
      writeFileSync(path.join(box.sem, 'namespace-registry.json'), JSON.stringify(reg, null, 2));
      scenarioNotes.push('F5 mutation: copied the undeclared overlay into the sandbox vault as scratch/ AND deleted the feedback row from the sandbox core registry, so feedback/ is undeclared too');
    }

    indexBuild = buildIndex(box);
    if (SCENARIO === 'F5') scenarioNotes.push(`F5: embed-vault.js exited ${indexBuild.status}`);
    if (SCENARIO === 'F4') {
      // Build cleanly, run C-02's query once to capture the rank-1 row's
      // embedding vector, then append a row with a path inside ops-deny/, the
      // C-02 DENY canary text as its chunk, and that captured vector, so that
      // absent any filtering it would score at or above rank 1 (PREREG-001 6 F4).
      const c2 = byId.get('C-02');
      const probe = search(box, c2.query);
      const top = probe.rows?.[0];
      const index = existsSync(box.embeddings) ? readIndex(box) : null;
      const donor = index && top ? index.notes.find((n) => n.path === top.path) : null;
      if (!donor) {
        harnessErrors.push(`F4: could not capture a rank-1 embedding vector for C-02 (top-1 was ${top?.path || 'nothing'})`);
      } else {
        const raw = readFileSync(path.join(CORPUS, ...c2.target.split('/')), 'utf8');
        const fm = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        const chunk = (fm ? raw.slice(fm[0].length) : raw).trim().slice(0, 500);
        index.notes.push({ path: c2.target, title: 'vault-door-service-log', tags: [], chunk, embedding: donor.embedding, mtime: 0 });
        index.entryCount = index.notes.length;
        writeIndex(box, index);
        scenarioNotes.push(`F4 mutation: captured the rank-1 embedding vector for C-02 from ${top.path} (score ${top.score}) and appended a row at ${c2.target} carrying the DENY canary text with that exact vector`);
      }
    }
    if (SCENARIO === 'F6') {
      rmSync(box.embeddings, { force: true });
      scenarioNotes.push('F6 mutation: deleted <sandbox vault>/memory/embeddings.json and ran without rebuilding');
    }
    if (!existsSync(box.embeddings) && SCENARIO !== 'F6' && SCENARIO !== 'F5') {
      harnessErrors.push(`index build produced no embeddings.json (exit ${indexBuild.status}): ${indexBuild.all.slice(-400)}`);
    }

    if (SCENARIO === 'F5') {
      doctor = doctorNamespaceRecords(box);
      for (const id of ['U-01', 'U-02']) scoreUndeclared(box, byId.get(id), doctor);
      declareUnrunnable(ALL_QUALITY,
        'F5: namespace coverage is red, so no quality number may be reported from this run',
        'PREREG-001 6 F5 — coverage red, quality must not be reported as a shrunken green');
      record('PC-01', 'positive-control', 'unrunnable',
        'F5: both runtimes refuse while a namespace is undeclared',
        { requires: 'PREREG-001 6 F5 — coverage red' });
    } else if (harnessErrors.length === 0) {
      // ── PC-01 first. If it is not rank-1 green the entire run is
      //    UNRUNNABLE and no class result is reported (PREREG-001 6 PC-01).
      const pc = byId.get('PC-01');
      const pcRes = search(box, pc.query);
      checkBudget('PC-01', pcRes);
      scanPolicy('PC-01', pcRes);
      let pcGreen = false;
      if (pcRes.status !== 0) {
        record('PC-01', 'positive-control', 'fail', `search exited ${pcRes.status}: ${pcRes.stderr.trim().slice(0, 200)}`);
      } else if (!pcRes.rows || !pcRes.rows.length) {
        record('PC-01', 'positive-control', 'fail', 'no rows returned');
      } else {
        const r1 = pcRes.rows[0];
        const prov = provenanceFailure(r1);
        if (r1.path !== pc.target) record('PC-01', 'positive-control', 'fail', `rank-1 was ${r1.path}, expected ${pc.target}`, { topScore: r1.score });
        else if (prov) record('PC-01', 'positive-control', 'fail', `rank-1 correct but provenance failed: ${prov}`, { topScore: r1.score });
        else { record('PC-01', 'positive-control', 'pass', `rank 1, score ${r1.score}`, { topScore: r1.score }); pcGreen = true; }
      }

      // PREREG-001 6 PC-01 makes a non-green control fatal to a run that is
      // trying to report quality. Under F6 a red PC-01 IS the preregistered
      // observation ("PC-01 goes red, every positive, temporal and operator
      // case goes red"), so the gate must not convert those preregistered reds
      // into unrunnables. The gate stays armed everywhere else.
      // Gate on the OBSERVABLE, not on the scenario label. Keyed on
      // SCENARIO !== 'F6' this trusted a name: a silently no-op rmSync would
      // have left a live index and let full scoring run while the packet still
      // claimed the index had been killed.
      if (!pcGreen && existsSync(box.embeddings)) {
        declareUnrunnable(ALL_QUALITY,
          'PC-01 is not rank-1 green: the harness has not demonstrated it can see a hit at all',
          'PREREG-001 6 PC-01 — positive control not green');
        declareUnrunnable(['U-01', 'U-02'],
          'PC-01 is not rank-1 green: no class result from this run is reported',
          'PREREG-001 6 PC-01 — positive control not green');
      } else {
        for (const c of cases) {
          if (c.class === 'positive') scorePositive(box, c);
          else if (c.class === 'negative') scoreNegative(box, c);
          else if (c.class === 'temporal') scoreTemporal(box, c);
          else if (c.class === 'deny' || c.class === 'skip') scoreWithheld(box, c);
          else if (c.class === 'operator') scoreOperator(box, c);
        }
        for (const c of cases.filter((x) => x.class === 'stale-index')) {
          scoreStaleIndex(box, c, staleRows.find((s) => s.id === c.id));
        }
        // L-02 injects and restores. L-01 deletes a source and leaves it
        // deleted, so it runs after L-02 and before the coverage cases, which
        // assert only on the undeclared directory.
        scoreLoudness(box, byId.get('L-02'));
        scoreLoudness(box, byId.get('L-01'));

        // U-01/U-02: the overlay is copied in ONLY for these cases. A
        // physically present undeclared directory makes every other
        // invocation exit 1 (PREREG-001 1.4).
        if (SPEC.runU) {
          cpSync(path.join(OVERLAY, 'scratch'), path.join(box.vault, 'scratch'), { recursive: true });
          doctor = doctorNamespaceRecords(box);
          for (const id of ['U-01', 'U-02']) scoreUndeclared(box, byId.get(id), doctor);
          rmSync(path.join(box.vault, 'scratch'), { recursive: true, force: true });
        } else {
          declareUnrunnable(['U-01', 'U-02'],
            `${SCENARIO}: the undeclared overlay is not part of this mutation`,
            `runner scenario table: ${SCENARIO} does not apply the undeclared overlay; coverage is scored in the BASELINE and F5 runs (PREREG-001 1.4)`);
        }
      }
    }
  }
}

// ── terminal accounting, PREREG-001 5.1 / 5.2 / 5.3 ──────────────────────────
const wall = Date.now() - started;
const wallBudget = SCENARIO === 'BASELINE' ? RUN_WALL_MAX_MS : FALSIFIER_WALL_MAX_MS;
if (wall > wallBudget) budgetBreaches.push({ id: '(run)', breaches: [`wall clock ${(wall / 1000).toFixed(1)}s > ${(wallBudget / 1000).toFixed(0)}s`] });

const classReport = GATES.map((g) => {
  const rows = results.filter((r) => r.class === g.klass);
  const passed = rows.filter((r) => r.status === 'pass').length;
  const failed = rows.filter((r) => r.status === 'fail').length;
  const unrunnable = rows.filter((r) => r.status === 'unrunnable').length;
  let met = passed >= g.min;
  if (g.klass === 'temporal') met = met && inversions.length === 0;
  if (unrunnable > 0) met = false;
  const status = (unrunnable > 0 && failed === 0) ? 'UNRUNNABLE' : (met ? 'PASS' : 'FAIL');
  return {
    class: g.klass, label: g.label, gate: g.gate, n: g.n,
    pass: passed, fail: failed, unrunnable,
    failingIds: rows.filter((r) => r.status === 'fail').map((r) => r.id),
    unrunnableIds: rows.filter((r) => r.status === 'unrunnable').map((r) => r.id),
    status,
  };
});

// ── expected-red accounting, PREREG-001 6 ────────────────────────────────────
// "A falsifier that does not produce its expected red is itself a FAIL of the
// benchmark, not of the product." Checked here and written into the packet, so
// a falsifier that stops falsifying shows up in the artifact.
const statusOf = (id) => (results.find((r) => r.id === id) || {}).status || 'not-run';
const expectedRedIds = [
  ...SPEC.expectedRed,
  ...cases.filter((c) => (SPEC.expectedRedClasses || []).includes(c.class)).map((c) => c.id),
];
const expectedRedObserved = expectedRedIds.map((id) => ({ id, expected: 'fail', observed: statusOf(id) }));
const expectedPassObserved = (SPEC.expectPass || []).map((id) => ({ id, expected: 'pass', observed: statusOf(id) }));
const expectedUnrunnableObserved = (SPEC.unrunnableClasses || []).map((klass) => {
  const rows = results.filter((r) => r.class === klass);
  return { class: klass, expected: 'unrunnable', n: rows.length, unrunnable: rows.filter((r) => r.status === 'unrunnable').length };
});
const inversionShortfall = SPEC.expectInversionsAtLeast != null && inversions.length < SPEC.expectInversionsAtLeast;
// Assert WHICH ids inverted, not just how many. A count clause is satisfied by
// inversions the mutation did not cause (see the F3 caveat).
const missingInversionIds = (SPEC.expectInversionIds || []).filter((id) => !inversions.some((v) => v.id === id));
// A harness-errored run has no measurement to hold: .every() over the empty
// fallback SPEC is vacuously true, which printed "expected red holds: true"
// beside "harness errors: 1".
const expectedRedHolds = harnessErrors.length === 0
  && expectedRedObserved.every((r) => r.observed === 'fail')
  && expectedPassObserved.every((r) => r.observed === 'pass')
  && expectedUnrunnableObserved.every((r) => r.n > 0 && r.unrunnable === r.n)
  && !inversionShortfall
  && missingInversionIds.length === 0;

const pc01 = results.find((r) => r.id === 'PC-01') || null;
const undeclaredUnrunnable = results.filter((r) => r.status === 'unrunnable' && !r.requires);
const anyFail = results.some((r) => r.status === 'fail');
const anyUnrunnable = results.some((r) => r.status === 'unrunnable');

// PREREG-001 1.3: "Any run whose sandbox copies of these files do not hash to
// the values above is UNRUNNABLE, not a result." The pre-mutation gate at
// runtimeHashGaps() cannot see a file a scenario edits afterwards, so the
// observed hashes are sampled again here and a pinned file that drifted feeds
// the terminal instead of sitting inert in the packet. Unpinned entries carry
// pinned: null and never trip this.
const observedHashes = observedRuntimeHashes(box);
const pinDrift = Object.entries(observedHashes || {})
  .filter(([, v]) => v.pinned !== null && v.matchesPin === false)
  .map(([file, v]) => ({ file, expected: v.pinned, observed: v.observed }));

let terminal;
if (harnessErrors.length) terminal = 'HARNESS-ERROR';
else if (anyFail || policyFalsePositives.length || budgetBreaches.length || pinDrift.length || (pc01 && pc01.status === 'fail')) terminal = 'FAIL';
else if (anyUnrunnable) terminal = 'UNRUNNABLE';
else terminal = 'PASS';

const packet = {
  preregistration: 'recollection-44/PREREG-001',
  packet_sha256: '6a45b8992492bf947e5abc6fcd079d63530c1ab4015a28eee29dcc8c0be252c4',
  scenario: SCENARIO,
  product_commit: 'cdb7022e5a08ef78f9923944fb4aff51bfea48a1',
  terminal,
  ran_at: new Date().toISOString(),
  wall_ms: wall,
  hashes: { corpus_sha256: corpusHash, overlay_sha256: overlayHash, fixture_registry_sha256: fixtureHash, frozen },
  instrument_sha256: fileHash(fileURLToPath(import.meta.url)),
  runtime_hashes_pinned: RUNTIME_HASHES,
  runtime_hashes_observed: observedHashes,
  runtime_hash_pin_drift: pinDrift,
  model,
  environment: env,
  environment_gaps: gaps,
  scenario_spec: {
    mutation: SPEC.mutation,
    note: SPEC.note || null,
    caveat: SPEC.caveat || null,
    expected_red_ids: expectedRedIds,
    expected_pass_ids: SPEC.expectPass || [],
    expected_unrunnable_classes: SPEC.unrunnableClasses || [],
    expected_inversion_ids: SPEC.expectInversionIds || [],
    expected_inversions_at_least: SPEC.expectInversionsAtLeast ?? null,
  },
  missing_inversion_ids: missingInversionIds,
  expected_red: expectedRedObserved,
  expected_pass: expectedPassObserved,
  expected_unrunnable: expectedUnrunnableObserved,
  expected_red_observed: expectedRedHolds,
  scenario_notes: scenarioNotes,
  index_build: indexBuild ? { exit: indexBuild.status, ms: indexBuild.ms, tail: indexBuild.all.slice(-800) } : null,
  doctor_namespace_records: doctor ? doctor.failedRecords : null,
  classes: classReport,
  positive_control: pc01,
  inversions,
  policy_false_positives: policyFalsePositives,
  budget_breaches: budgetBreaches,
  harness_errors: harnessErrors,
  undeclared_unrunnable: undeclaredUnrunnable.map((r) => r.id),
  cases: results,
};

if (JSON_OUT) {
  console.log(JSON.stringify(packet, null, 2));
} else {
  const MARK = { pass: 'PASS', fail: 'FAIL', unrunnable: 'UNRUNNABLE' };
  console.log(`\nrecollection-44/PREREG-001 — scenario ${SCENARIO} — product cdb7022e`);
  console.log(`corpus           ${corpusHash}`);
  console.log(`overlay          ${overlayHash}`);
  console.log(`fixture-registry ${fixtureHash}\n`);
  for (const r of results) console.log(`  ${String(MARK[r.status] || r.status).padEnd(11)} ${r.id.padEnd(6)} ${r.detail}`);
  console.log('');
  for (const c of classReport) {
    console.log(`  ${c.status.padEnd(11)} ${c.label.padEnd(22)} ${c.pass}/${c.n} pass · ${c.fail} fail · ${c.unrunnable} unrunnable   [gate: ${c.gate}]`);
  }
  console.log('');
  console.log(`  PC-01: ${pc01 ? `${pc01.status} — ${pc01.detail}` : 'not run'}`);
  console.log(`  inversions: ${inversions.length}`);
  console.log(`  policy false positives: ${policyFalsePositives.length}`);
  console.log(`  budget breaches: ${budgetBreaches.length}`);
  for (const b of budgetBreaches) console.log(`    ${b.id}: ${b.breaches.join('; ')}`);
  console.log(`  expected red holds: ${expectedRedHolds}${SPEC.mutation ? ` (mutation: ${SPEC.mutation})` : ''}`);
  for (const r of expectedRedObserved) console.log(`    expect FAIL ${r.id}: ${r.observed}`);
  for (const r of expectedPassObserved) console.log(`    expect PASS ${r.id}: ${r.observed}`);
  for (const r of expectedUnrunnableObserved) console.log(`    expect UNRUNNABLE ${r.class}: ${r.unrunnable}/${r.n}`);
  if (SPEC.caveat) console.log(`    caveat: ${SPEC.caveat}`);
  console.log(`  harness errors: ${harnessErrors.length}`);
  for (const h of harnessErrors) console.log(`    ${h}`);
  console.log(`  undeclared unrunnable: ${undeclaredUnrunnable.length}`);
  console.log(`\n  RUN TERMINAL: ${terminal}   (${(wall / 1000).toFixed(1)}s)\n`);
}

process.exit(terminal === 'PASS' ? 0 : 1);
