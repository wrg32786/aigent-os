#!/usr/bin/env node
// run-recollection.mjs -- the ONE runner for the recollection benchmark
// preregistered at recollection-44/PREREG-001 and re-pinned, for the C2 temporal
// and abstention slices, at recollection-44/PREREG-002 (frozen packet_sha256
// a4d23198...; section 7 lists the instrument requirements implemented here).
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
//   node evals/recollection/run-recollection.mjs --self-check    # no product run
//
// PREREG-002 options:
//   --product-tree <path>   checkout whose files are copied into the sandbox and
//                           whose HEAD is observed (default: this repo root)
//   --candidates <path>     PREREG-002-CANDIDATES.md (absent = baseline only)
//   --reference <packet>    unmutated FULL packet of this identity, instrument, protocol and
//                           clock that F9 compares BUILD and U results with
//   --reference-development  the reference may be a narrower subset: a labelled
//                           development comparison, never a full same-method reference
//   --only <ids>            development subset; the packet says it is not a
//                           scored-run candidate
// Scenarios: BASELINE, F1..F9. F7 and the F9 forced-abstention arm are NOT executable
// here (see CLAIM_LIMITS): only F9's filter-removal arm and F1-F6, F8 run.

import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const FREEZE_ONLY = argv.includes('--freeze');
const KEEP = argv.includes('--keep');
const optValue = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; };
const scenarioIdx = argv.indexOf('--scenario');
const SCENARIO = scenarioIdx !== -1 ? String(argv[scenarioIdx + 1] || '').toUpperCase() : 'BASELINE';
// PREREG-002 1.3: the instrument may live on a different commit than the product
// identity it measures, so the product tree is a named input, never inferred.
const PRODUCT_TREE = path.resolve(optValue('--product-tree') || ROOT);
const CANDIDATES_FILE = optValue('--candidates');
// F9 compares BUILD-stage and U-class results with an unmutated run of the same
// identity ("unchanged" is relative); the packet of that run is passed here.
const REFERENCE_FILE = optValue('--reference');
const REFERENCE_DEV = argv.includes('--reference-development');
const ONLY = optValue('--only') ? new Set(optValue('--only').split(',').map((x) => x.trim().toUpperCase())) : null;
const want = (id) => !ONLY || ONLY.has(String(id).toUpperCase());

const DAEMONS = path.join(PRODUCT_TREE, 'daemons');
const SEM = path.join(DAEMONS, 'semantic-search');
const DOCTOR = path.join(PRODUCT_TREE, 'scripts', 'doctor.sh');
const PRODUCT_RUN_EVALS = path.join(PRODUCT_TREE, 'evals', 'run-evals.mjs');

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

// ── PREREG-002 identity (frozen packet_sha256 below) ─────────────────────────
const PREREG = 'recollection-44/PREREG-002';
const PACKET_SHA256 = 'a4d23198bdaed689d75d3198e8fdb6b2eec890b3a9b7f2d0990a07df9c310c2f';
const BASELINE_COMMIT = 'd3dd339612f9254af87ec3afffb546cd36063741';

// PREREG-002 1.6: one evaluation instant for every run under this packet.
const FROZEN_NOW = '2026-09-30T00:00:00Z';

// PREREG-002 1.3: ten pins, `git show <commit>:<path> | sha256sum`, computed
// against BASELINE_COMMIT. A sandbox copy that does not hash to the pins of the
// identity being run is UNRUNNABLE, naming the mismatch, never a result. A
// registered candidate (1.7) brings its own ten.
const PINNED_PATHS = [
  'daemons/semantic-search/namespace-registry.json',
  'daemons/semantic-search/namespace-registry.local.example.json',
  'daemons/semantic-search/namespace-registry.mjs',
  'daemons/semantic-search/search-vault.js',
  'daemons/semantic-search/embed-vault.js',
  'daemons/semantic-search/deny-list.mjs',
  'daemons/lifecycle-common.mjs',
  'evals/run-evals.mjs',
  'daemons/memory-root.cjs',
  'daemons/memory-root.sh',
];
const BASELINE_PINS = {
  'daemons/semantic-search/namespace-registry.json': '5bcc603c8e813f272be3ef17aa94b92ac1cccd9e31fb5b02d6d5589d60025060',
  'daemons/semantic-search/namespace-registry.local.example.json': '8628cf7d921f091865ea9142dc936de3b16e0d97c0515da60118650fdd285212',
  'daemons/semantic-search/namespace-registry.mjs': '2e3ebb9c539f5deb7eddb2ce838f73b2d18ddc06bf5a01970df8ce337168d0e8',
  'daemons/semantic-search/search-vault.js': 'ef9896fcf89421397dbd197171b14ff8186807f8090469167a781965aee5f4cf',
  'daemons/semantic-search/embed-vault.js': 'c011e4709c1704eaec9346bc3f47c0bb83d0dd514556a182de516bdcf2eb38ae',
  'daemons/semantic-search/deny-list.mjs': '5ff063ae3e9bb114fec464bd446675dfe2be72fe92d046e7f23ebe8c0d15f95c',
  'daemons/lifecycle-common.mjs': 'a7922c600ac6aa42bb62fa30fa013758492e4d87ee7ff2a2a0cd3fcc6da66c12',
  'evals/run-evals.mjs': '11d4a79d47e3349113df56a856411b434055b3c5321c913abc017583995e836d',
  'daemons/memory-root.cjs': '082335e97ebbe14969b1a1881013bb8b901fed8a6a803eeab6a8eba0f7fcb56c',
  'daemons/memory-root.sh': '8bca14d0dc739a2fb6847219f71dd8d3f0b319f38185e742ec45b424368c7fad',
};

const PROVENANCE_RE = /^\["persisted-data":"vault-chunk" "(?<path>[^"]+)" sha (?<sha>[0-9a-f]{12}) @ (?<at>\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\] "/;

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
let BASH = null;
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
  BASH = bashProbe();
  if (!BASH.ok) gaps.push({ item: 5, why: BASH.why });
  try { rmSync(mkdtempSync(path.join(os.tmpdir(), 'recollection-probe-')), { recursive: true, force: true }); }
  catch (e) { gaps.push({ item: 6, why: `no writable temporary directory: ${e.message}` }); }
  return gaps;
}

// ── sandbox, patterned on daemons/tests/semantic-search-namespace-registry
//    .test.mjs:133-190, with the transformers STUB replaced by a link to the
//    real installed package (PREREG-001 7.2: the benchmark runs the real
//    model, so a constant-vector stub is exactly what it must not use) ────────
const SANDBOX_DAEMON_FILES = [
  'frontmatter-reader.cjs', 'lifecycle-common.mjs', 'capsule-content-gate.mjs', 'memory-root.cjs', 'memory-root.sh',
];

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
  // memory-root.cjs / memory-root.sh: embed-vault.js and search-vault.js import
  // the resolver, so a sandbox without them fails at import before any case runs
  // (PREREG-002 1.2, BUILD-LEDGER 18.2).
  for (const f of SANDBOX_DAEMON_FILES) {
    copyFileSync(path.join(DAEMONS, f), path.join(root, 'daemons', f));
  }
  // evals/run-evals.mjs is a pinned file (PREREG-002 1.3); the sandbox carries
  // its own copy so the hash gate reads the file this run actually uses.
  mkdirSync(path.join(root, 'evals'), { recursive: true });
  copyFileSync(PRODUCT_RUN_EVALS, path.join(root, 'evals', 'run-evals.mjs'));
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

// PREREG-001 1.3 requires the RUN to record the pinned hashes, and it means the
// sandbox copies the run actually executed. Writing the pinned constant instead
// made a mutation invisible: the F5 packet at head a72f68b reported the pin for
// namespace-registry.json even though F5's whole mutation is editing that file.
// The unpinned copies the sandbox also carries are recorded, not gated.
function sandboxFileMap(box) {
  const sem = (f) => path.join(box.sem, f);
  const dm = (f) => path.join(box.root, 'daemons', f);
  return {
    'daemons/semantic-search/namespace-registry.json': sem('namespace-registry.json'),
    'daemons/semantic-search/namespace-registry.local.example.json': sem('namespace-registry.local.example.json'),
    'daemons/semantic-search/namespace-registry.mjs': sem('namespace-registry.mjs'),
    'daemons/semantic-search/search-vault.js': sem('search-vault.js'),
    'daemons/semantic-search/embed-vault.js': sem('embed-vault.js'),
    'daemons/semantic-search/deny-list.mjs': sem('deny-list.mjs'),
    'daemons/lifecycle-common.mjs': dm('lifecycle-common.mjs'),
    'evals/run-evals.mjs': path.join(box.root, 'evals', 'run-evals.mjs'),
    'daemons/memory-root.cjs': dm('memory-root.cjs'),
    'daemons/memory-root.sh': dm('memory-root.sh'),
    // recorded, never gated: the packet pins no value for these
    'scripts/doctor.sh': path.join(box.root, 'scripts', 'doctor.sh'),
    'daemons/frontmatter-reader.cjs': dm('frontmatter-reader.cjs'),
    'daemons/capsule-content-gate.mjs': dm('capsule-content-gate.mjs'),
    'daemons/memory-hygiene/resume-framing.mjs': path.join(box.root, 'daemons', 'memory-hygiene', 'resume-framing.mjs'),
  };
}

// Every pinned path, compared on the file as it sits in the sandbox. Pure over
// (label -> file) so the self-check can feed it synthetic files.
function verifyPins(fileMap, pins) {
  const bad = [];
  for (const label of Object.keys(pins)) {
    const file = fileMap[label];
    const got = file && existsSync(file) ? fileHash(file) : 'ABSENT';
    if (got !== pins[label]) bad.push({ file: label, expected: pins[label], observed: got });
  }
  return bad;
}

const runtimeHashGaps = (box, pins) => verifyPins(sandboxFileMap(box), pins);

function observedRuntimeHashes(box, pins) {
  if (!box) return null;
  const out = {};
  for (const [label, file] of Object.entries(sandboxFileMap(box))) {
    const observed = existsSync(file) ? fileHash(file) : 'ABSENT';
    const pinned = pins[label] || null;
    out[label] = pinned
      ? { observed, pinned, matchesPin: observed === pinned }
      : { observed, pinned: null, matchesPin: null };
  }
  return out;
}

// ── product identity, PREREG-002 1.3 / 1.7 ───────────────────────────────────
// product_commit is an OBSERVATION: `git rev-parse HEAD` in the tree the run
// executes against. BUILD-LEDGER 13 names the defect this closes: a constant
// labels a fixed-tree packet with a commit whose product it is NOT running.
function observeProductCommit(tree) {
  const r = spawnSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = (r.stdout || '').trim();
  return r.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// PREREG-002-CANDIDATES.md is append-only. One record per `candidate_id:` line,
// `C-nnn` for a candidate and `B-nnn` for a baseline instrument registration, each
// carrying ALL of frozen 1.7 items 1-7 as `key: value` lines, then ten
// `<64 hex>  <path>` pin lines:
//   candidate_id  product_commit  repository  branch                      (1, 2)
//   instrument_sha256  instrument_commit                                  (4)
//   environment_os  environment_node  environment_bash  environment_model (5)
//   protocol  packet_sha256                                               (6)
//   registered_at  registered_by                                          (7)
//   <64 hex>  daemons/semantic-search/search-vault.js   (x10)             (3)
// A later `withdraws: <id>` line revokes an earlier record (1.7: never edited).
function parseCandidates(text) {
  const parts = String(text || '').split(/^(?=\s*(?:[-*]\s*)?candidate_id\s*:)/m).filter((b) => /candidate_id\s*:/.test(b));
  return parts.map((block) => {
    const grab = (key, re) => (block.match(new RegExp(`^\\s*(?:[-*]\\s*)?${key}\\s*:\\s*\`?(${re})\`?\\s*$`, 'im')) || [])[1] || null;
    const pins = {};
    for (const m of block.matchAll(/^\s*(?:[-*]\s*)?`?([0-9a-f]{64})`?\s+`?(\S+?)`?\s*$/gm)) pins[m[2]] = m[1];
    const free = '\\S.*?';
    return {
      candidate_id: grab('candidate_id', '[CB]-\\d+'),
      product_commit: grab('product_commit', '[0-9a-f]{40}'),
      repository: grab('repository', free),
      branch: grab('branch', free),
      instrument_sha256: grab('instrument_sha256', '[0-9a-f]{64}'),
      instrument_commit: grab('instrument_commit', '[0-9a-f]{40}'),
      environment_os: grab('environment_os', free),
      environment_node: grab('environment_node', free),
      environment_bash: grab('environment_bash', free),
      environment_model: grab('environment_model', free),
      protocol: grab('protocol', free),
      packet_sha256: grab('packet_sha256', '[0-9a-f]{64}'),
      registered_at: grab('registered_at', free),
      registered_by: grab('registered_by', free),
      withdraws: [...block.matchAll(/^\s*(?:[-*]\s*)?withdraws\s*:\s*`?([CB]-\d+)`?/gim)].map((m) => m[1]),
      pins,
    };
  });
}

// The registered instrument_commit must CONTAIN this exact instrument: the blob
// git holds at that commit hashes to this run's instrument_sha256. No signature or
// authorship proof is claimed (registered_by is a stated label, not an identity).
const INSTRUMENT_REL = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
function instrumentCommitVerifier(repo, rel, sha) {
  return (commit) => {
    const r = spawnSync('git', ['-C', repo, 'show', `${commit}:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 && createHash('sha256').update(r.stdout).digest('hex') === sha;
  };
}

// PREREG-002 1.7: a record missing any of items 1-7, or not bound to the observed
// instrument, product and environment, is NOT a registration. Returns the list of
// named problems; empty means registered.
function registrationProblems(rec, { kind, instrumentSha, environment, verifyInstrumentCommit, now = Date.now() }) {
  const p = [];
  const need = (key, ok, why) => { if (!rec[key]) p.push(`${key} missing`); else if (!ok) p.push(`${key} ${why}`); };
  need('candidate_id', new RegExp(kind === 'baseline' ? '^B-' : '^C-').test(rec.candidate_id || ''), `is not a ${kind === 'baseline' ? 'B' : 'C'}-nnn id`);
  need('product_commit', true, '');
  need('repository', true, '');
  need('branch', true, '');
  const missingPins = PINNED_PATHS.filter((f) => !rec.pins[f]);
  if (missingPins.length) p.push(`does not carry pin(s) for: ${missingPins.join(', ')}`);
  else if (kind === 'baseline') {
    const off = PINNED_PATHS.filter((f) => rec.pins[f] !== BASELINE_PINS[f]);
    if (off.length) p.push(`pin(s) differ from the frozen baseline pins: ${off.join(', ')}`);
  }
  need('instrument_sha256', rec.instrument_sha256 === instrumentSha, `${rec.instrument_sha256} is not this instrument ${instrumentSha}`);
  need('instrument_commit', !!verifyInstrumentCommit && verifyInstrumentCommit(rec.instrument_commit), `${rec.instrument_commit} does not contain this instrument (git blob there does not hash to ${instrumentSha})`);
  for (const [key, field] of [['environment_os', 'os'], ['environment_node', 'node'], ['environment_bash', 'bash'], ['environment_model', 'model']]) {
    need(key, !!environment && rec[key] === environment[field], `${rec[key]} is not the observed ${environment ? environment[field] : 'environment'}`);
  }
  need('protocol', rec.protocol === PREREG, `${rec.protocol} is not ${PREREG}`);
  need('packet_sha256', rec.packet_sha256 === PACKET_SHA256, `carries packet_sha256 ${rec.packet_sha256}, expected ${PACKET_SHA256}`);
  need('registered_at', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(rec.registered_at || '') && Date.parse(rec.registered_at) <= now, `${rec.registered_at} is not a UTC Z instant that has already passed`);
  need('registered_by', true, '');
  return p;
}

// PREREG-002 1.1 / 1.7 / 5.4 / section 7 item 9: the only identities that can
// produce a result are the baseline and a registered candidate whose record
// carries all ten pins and THIS instrument's sha256. Anything else is refused,
// naming why. The baseline's INSTRUMENT registration is a full 1.7 record too
// (`B-nnn`); `registration.state` keeps registered / incomplete / withdrawn /
// absent apart, and carries the record's own identity into the packet. Pure: the
// caller supplies the observation.
function resolveIdentity({ observed, candidatesText, candidatesSource, instrumentSha, environment, verifyInstrumentCommit }) {
  if (!observed) {
    return { ok: false, why: 'git rev-parse HEAD failed in the product tree: product_commit cannot be observed', requires: 'PREREG-002 1.3 — product_commit must be observed in a git checkout' };
  }
  const records = parseCandidates(candidatesText);
  // 1.7: a mistake is corrected by a LATER record naming the earlier one as withdrawn.
  const isWithdrawn = (rec) => records.some((later, j) => j > records.indexOf(rec) && later.withdraws.includes(rec.candidate_id));
  const ctx = { instrumentSha, environment, verifyInstrumentCommit };
  const reg = (state, rec, problems = []) => ({ state, record_id: rec ? rec.candidate_id : null, problems, record: rec ? { ...rec, withdraws: undefined } : null });
  if (observed === BASELINE_COMMIT) {
    // A record naming ANOTHER instrument is not about this one; one naming none is incomplete.
    const mine = records.filter((r) => /^B-/.test(r.candidate_id || '') && r.product_commit === BASELINE_COMMIT && (!r.instrument_sha256 || r.instrument_sha256 === instrumentSha));
    const live = mine.filter((r) => !isWithdrawn(r));
    let registration = reg('absent', null);
    if (mine.length && !live.length) registration = reg('withdrawn', mine[mine.length - 1]);
    else if (live.length) {
      const rec = live[live.length - 1];
      const problems = registrationProblems(rec, { ...ctx, kind: 'baseline' });
      registration = reg(problems.length ? 'incomplete' : 'registered', rec, problems);
    }
    return { ok: true, kind: 'baseline', candidate_id: null, pins: BASELINE_PINS, instrumentRegistered: registration.state === 'registered', registration };
  }
  const hit = records.find((r) => /^C-/.test(r.candidate_id || '') && r.product_commit === observed && !isWithdrawn(r));
  const requires = 'PREREG-002 1.7 — identity is neither the baseline nor a registered candidate';
  if (!hit) {
    const wd = records.find((r) => r.product_commit === observed && isWithdrawn(r));
    return { ok: false, requires, why: wd
      ? `product ${observed} matches ${wd.candidate_id}, which a later record withdrew`
      : `product ${observed} is neither the baseline ${BASELINE_COMMIT} nor registered in ${candidatesSource || 'a candidates file (none given; absent file = baseline only)'}`,
    registration: wd ? reg('withdrawn', wd) : reg('absent', null) };
  }
  const problems = registrationProblems(hit, { ...ctx, kind: 'candidate' });
  if (problems.length) {
    return { ok: false, requires, why: `${hit.candidate_id} is not a complete registration bound to this instrument, product and environment: ${problems.join('; ')}`, registration: reg('incomplete', hit, problems) };
  }
  return { ok: true, kind: 'candidate', candidate_id: hit.candidate_id, instrumentRegistered: true, pins: Object.fromEntries(PINNED_PATHS.map((f) => [f, hit.pins[f]])), registration: reg('registered', hit) };
}

// MED-1: the product tree must BE the identity commit. The sandbox is copied from
// working files, so (a) the COMMITTED content of every pinned path must hash to
// the pins, and (b) nothing under daemons/, evals/run-evals.mjs or
// scripts/doctor.sh may be modified or untracked: an unpinned import the runtime
// loads (frontmatter-reader, resume-framing, ...) is code too.
function gitShowText(tree, sha, rel) {
  const r = spawnSync('git', ['-C', tree, 'show', `${sha}:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function treeIdentityProblems(tree, sha, pins) {
  const problems = [];
  for (const [label, pin] of Object.entries(pins)) {
    const r = spawnSync('git', ['-C', tree, 'show', `${sha}:${label}`], { maxBuffer: 64 * 1024 * 1024 });
    const got = r.status === 0 ? createHash('sha256').update(r.stdout).digest('hex') : 'ABSENT-IN-COMMIT';
    if (got !== pin) problems.push(`committed ${label} hashes ${got.slice(0, 12)}, pin ${pin.slice(0, 12)}`);
  }
  const st = spawnSync('git', ['-C', tree, 'status', '--porcelain', '--', 'daemons', 'evals/run-evals.mjs', 'scripts/doctor.sh'], { encoding: 'utf8' });
  if (st.status !== 0) problems.push('git status failed in the product tree');
  const dirty = (st.stdout || '').split('\n').filter(Boolean);
  if (dirty.length) problems.push(`dirty tree: ${dirty.slice(0, 5).join('; ')}`);
  return problems;
}

// MED-2 / I5: F9's "unchanged" is relative to an unmutated, FULL run of THIS
// identity by THIS instrument: the same protocol and packet, the same frozen
// clock, the same fixture and runtime identity, and the whole expected case
// population (every id once, none missing, none extra). A red baseline is fine:
// admissibility is about WHAT was run, never how it scored. `want.development`
// selects the distinct, labelled narrower comparison (a subset of the population,
// everything else still checked); it is never a full same-method reference.
function validateReference(ref, want) {
  if (!ref || typeof ref !== 'object') return 'reference packet unreadable';
  if (ref.scenario !== 'BASELINE') return `reference is scenario ${ref.scenario}, not an unmutated BASELINE run`;
  if (ref.development_subset != null && !want.development) return 'reference is a development subset (a narrower comparison needs --reference-development and is never a full reference)';
  if (!Array.isArray(ref.cases) || ref.cases.length === 0) return 'reference has no cases';
  if (Array.isArray(ref.harness_errors) && ref.harness_errors.length) return 'reference packet carries harness errors';
  if (ref.preregistration !== PREREG) return `reference protocol ${ref.preregistration} is not ${PREREG}`;
  if (ref.packet_sha256 !== PACKET_SHA256) return `reference packet_sha256 ${ref.packet_sha256} is not ${PACKET_SHA256}`;
  if (ref.product_commit !== want.commit) return `reference product_commit ${ref.product_commit} is not ${want.commit}`;
  if ((ref.identity || {}).kind !== want.kind) return `reference identity kind ${(ref.identity || {}).kind} is not ${want.kind}`;
  if (ref.instrument_sha256 !== want.instrumentSha) return `reference was produced by instrument ${ref.instrument_sha256}, not ${want.instrumentSha}`;
  const clock = ref.search_now || {};
  if (clock.frozen !== FROZEN_NOW || clock.temporal_class !== FROZEN_NOW) return `reference clock ${clock.frozen}/${clock.temporal_class} is not the frozen instant ${FROZEN_NOW}`;
  for (const k of ['corpus_sha256', 'overlay_sha256', 'fixture_registry_sha256']) {
    if ((ref.hashes || {})[k] !== want.hashes[k]) return `reference ${k} ${(ref.hashes || {})[k]} is not this run's ${want.hashes[k]}`;
  }
  if (!Array.isArray(ref.runtime_hash_mismatch) || ref.runtime_hash_mismatch.length) return 'reference reports a runtime pin mismatch (or does not report it)';
  if (!Array.isArray(ref.runtime_hash_pin_drift) || ref.runtime_hash_pin_drift.length) return 'reference reports runtime pin drift (or does not report it)';
  const refPins = ref.runtime_hashes_pinned || {};
  const offPins = PINNED_PATHS.filter((f) => refPins[f] !== want.pins[f]);
  if (offPins.length) return `reference was pinned to other runtime hashes: ${offPins.join(', ')}`;
  const ids = ref.cases.map((c) => (c && typeof c.id === 'string' ? c.id : null));
  if (ids.includes(null)) return 'reference population carries a case without an id';
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) return `reference population has duplicate case id(s): ${[...new Set(dup)].join(', ')}`;
  const expected = new Set(want.expectedIds);
  const extra = ids.filter((id) => !expected.has(id));
  if (extra.length) return `reference population has id(s) outside the case population: ${extra.join(', ')}`;
  const missing = want.expectedIds.filter((id) => !ids.includes(id));
  if (missing.length && !want.development) return `reference population is missing ${missing.length} of ${want.expectedIds.length} expected case id(s): ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', ...' : ''}`;
  return null;
}

// ── invocation environment, PREREG-002 3.2 / 1.6 ─────────────────────────────
// A fresh opaque token per search invocation, unique within the run. The
// inherited environment is scrubbed of every variable that moves the index, the
// clock, the supersession switch or the token, so only the runner sets them.
const usedTokens = new Set();
function freshToken() {
  for (;;) {
    const t = `rec-${randomBytes(8).toString('hex')}`;
    if (!usedTokens.has(t)) { usedTokens.add(t); return t; }
  }
}
const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;
const SCRUBBED_ENV = ['AIGENT_STATE_HOME_DIR', 'AIGENT_SEARCH_NOW', 'AIGENT_SEARCH_INVOCATION', 'AIGENT_SEARCH_DISABLE_SUPERSESSION'];
function invocationEnv(box, extra = {}) {
  const base = { ...process.env };
  for (const k of SCRUBBED_ENV) delete base[k];
  return { ...base, AIGENT_ROOT: box.root, AIGENT_VAULT_ROOT: box.vault, ...extra };
}

// ── abstention sidecar, PREREG-002 3.2 ───────────────────────────────────────
// The wire contract is one stderr line, `AIGENT_ABSTAIN {json}`, four keys,
// closed reason vocabulary, bound to this invocation's token. The results block
// stays an array and is parsed elsewhere, unchanged; nothing here reads it
// except to count rows. Rules apply in the order the packet lists them.
const ABSTAIN_PREFIX = 'AIGENT_ABSTAIN';
const ABSTAIN_KEYS = ['invocation', 'outcome', 'reason', 'schema'];
const ABSTAIN_REASONS = ['below-tau', 'no-eligible-candidates'];

// state: 'n/a'      a non-zero exit is a hard error, never an abstention (section 8)
//        'none'     no sidecar line; `silentZero` says whether the array was empty
//        'honest'   exit 0, results [], one well-formed bound line
//        'rejected' `detail` carries the named rejection
function classifyAbstention({ status, rows, stderr, token }) {
  if (status !== 0) return { state: 'n/a', lines: 0, nonEmptyRows: false };
  const nonEmptyRows = Array.isArray(rows) && rows.length > 0;
  const lines = String(stderr || '').split(/\r?\n/).filter((l) => l.startsWith(ABSTAIN_PREFIX));
  const reject = (detail) => ({ state: 'rejected', detail, lines: lines.length, nonEmptyRows });
  if (lines.length === 0) {
    return { state: 'none', lines: 0, nonEmptyRows, detail: Array.isArray(rows) && rows.length === 0 ? 'silent-zero-rows' : null };
  }
  if (lines.length > 1) return reject('abstention-sidecar-duplicated');
  let obj = null;
  if (lines[0].startsWith(`${ABSTAIN_PREFIX} `)) {
    const payload = lines[0].slice(ABSTAIN_PREFIX.length + 1);
    try { obj = JSON.parse(payload); } catch { obj = null; }
    // Single-line JSON of any spacing is fine (3.2 does not require compact form).
    // A doubled prefix space is not the literal prefix; a duplicated key is not
    // "exactly four keys" (JSON.parse would silently keep the last one). Every key
    // token is DECODED before comparing, so an escaped spelling ("\u0069nvocation")
    // of a name already present is a duplicate too. A string token followed by a
    // colon is a key; the values here are strings, so none nests.
    if (/^\s/.test(payload)) obj = null;
    if (obj) {
      const names = [...payload.matchAll(/"((?:[^"\\]|\\.)*)"(\s*:)?/g)].filter((m) => m[2]).map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return null; } });
      if (names.length !== 4 || new Set(names).size !== 4) obj = null;
    }
  }
  const wellFormed = obj && typeof obj === 'object' && !Array.isArray(obj)
    && Object.keys(obj).sort().join() === ABSTAIN_KEYS.join()
    && obj.schema === 'abstain/1' && obj.outcome === 'abstain'
    && typeof obj.invocation === 'string' && typeof obj.reason === 'string';
  if (!wellFormed) return reject('abstention-sidecar-malformed');
  if (!ABSTAIN_REASONS.includes(obj.reason)) return reject('abstention-reason-unknown');
  if (obj.invocation !== token) return reject('abstention-sidecar-unbound');
  if (nonEmptyRows) return reject('abstention-contradicted');
  // (b)(2): the block must be present and exactly [].
  if (!Array.isArray(rows)) return reject('abstention-without-results-block');
  return { state: 'honest', reason: obj.reason, lines: 1, nonEmptyRows: false };
}

// Any sidecar line beside a non-empty results array is a contradiction on every
// class, whatever else is wrong with the line (3.2 final rejection rule). Every
// other REJECTED sidecar (malformed, duplicated, unknown reason, unbound) is a
// case FAIL with the classifier's own detail (3.2): the scorers all route here, so
// an empty-result invocation with a bad line cannot reach a proof. A non-abstaining
// query (state 'none', no line) is never asked for a sidecar.
const abstainGate = (res) => {
  if (!res.abstain) return null;
  if (res.abstain.lines > 0 && res.abstain.nonEmptyRows) return 'abstention-contradicted';
  return res.abstain.state === 'rejected' ? res.abstain.detail : null;
};

// The negative-class decision, pure over what the invocation produced so the
// self-check can feed it synthetic process output. PREREG-002 3.2.
function negativeVerdict({ status, rows, abstain, indexPresent }) {
  // F6 exception (3.2, section 6): a dead retriever must never certify the
  // class. Gated on the observable (index absent), not on the scenario label.
  // Any other non-zero exit is a behavioral FAIL, never an environmental gap.
  if (status !== 0) {
    if (!indexPresent) {
      return { status: 'unrunnable', detail: `search exited ${status}; a non-zero exit can never certify abstention`, requires: 'PREREG-002 3.2 / PREREG-001 6 F6 — index deleted, search process exited non-zero' };
    }
    return { status: 'fail', detail: `search exited ${status}` };
  }
  if (!rows) return { status: 'fail', detail: abstain.lines > 0 ? 'abstention-without-results-block' : 'no JSON block parsed' };
  if (rows.length === 0) {
    if (abstain.state === 'honest') return { status: 'pass', detail: `honest abstention (${abstain.reason}): exit 0, results [], bound sidecar`, extra: { abstained: true, abstainReason: abstain.reason } };
    return { status: 'fail', detail: abstain.detail || 'silent-zero-rows', extra: { abstained: false } };
  }
  if (abstain.lines > 0) return { status: 'fail', detail: 'abstention-contradicted' };
  const top1 = rows[0].score;
  const near = top1 != null && Math.abs(top1 - TAU) <= NEAR_THRESHOLD;
  const extra = { top1, topPath: rows[0].path, nearThreshold: near };
  if (top1 == null) return { status: 'fail', detail: 'no score on the top row to compare against tau', extra };
  if (top1 >= TAU) return { status: 'fail', detail: `top-1 ${top1} >= tau ${TAU} (${rows[0].path})`, extra };
  return { status: 'pass', detail: `top-1 ${top1} < tau ${TAU}${near ? ' [near-threshold]' : ''}`, extra };
}

// ── bash probe, PREREG-002 4.3 item 5 ────────────────────────────────────────
// A bare `bash -c true` passes on the WSL shim that then mangles the Windows
// path handed to scripts/doctor.sh (BUILD-LEDGER 13: doctor exit 127). So the
// probe runs a real script, named by a Windows path, with a Windows-path
// argument, exactly the shape runDoctor() uses, and demands it read both.
// `run` is injectable so the self-check can stand a shim in for it.
function bashProbe(run = spawnSync) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recollection-bashprobe-'));
  try {
    const script = path.join(dir, 'probe.sh');
    writeFileSync(script, '#!/usr/bin/env bash\n[ -f "$0" ] && cd "$1" && printf BASH-PROBE-OK\n');
    const r = run('bash', [script, dir], { encoding: 'utf8' });
    const ok = r.status === 0 && String(r.stdout || '').includes('BASH-PROBE-OK');
    const where = run(process.platform === 'win32' ? 'where' : 'which', ['bash'], { encoding: 'utf8' });
    const resolved = String(where.stdout || '').split(/\r?\n/).find(Boolean) || null;
    return ok
      ? { ok: true, resolved }
      : { ok: false, resolved, why: `resolved bash ${resolved || '(not found)'} cannot run a Windows-path-bearing script the way scripts/doctor.sh is invoked (exit ${r.status}: ${String(r.stderr || '').trim().slice(0, 160)})` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// F8's pre-window instant: one day before the earliest closing date in the
// corpus, so no window has ended (PREREG-002 F8).
function preWindowInstant(corpusRoot) {
  let earliest = null;
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(/^Valid from \d{4}-\d{2}-\d{2} to (\d{4}-\d{2}-\d{2})\s*$/gm)) {
        if (earliest === null || m[1] < earliest) earliest = m[1];
      }
    }
  })(corpusRoot);
  if (earliest === null) return null;
  return `${new Date(Date.parse(`${earliest}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)}T00:00:00Z`;
}

function runNode(box, script, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(box.sem, script), ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: invocationEnv(box, extraEnv),
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return { status: r.status, stdout, stderr, all: stdout + stderr };
}

function runDoctor(box) {
  const r = spawnSync('bash', [path.join(box.root, 'scripts', 'doctor.sh'), box.root], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: invocationEnv(box),
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
    env: invocationEnv(box),
  });
  if (r.status !== 0) throw new Error(`embed helper failed: ${(r.stderr || '').slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

// Human mode, not --json: search-vault.js returns at :181-184 BEFORE the
// timing line, so --json gives no timings (PREREG-001 4.1). Both the timing
// line and the trailing JSON block are parsed out of the human output.
const searchEnv = (invocation, now) => ({ AIGENT_SEARCH_NOW: now, AIGENT_SEARCH_INVOCATION: invocation });
function search(box, query, { now = FROZEN_NOW } = {}) {
  const invocation = freshToken();
  return interpretSearch(runNode(box, 'search-vault.js', [query], searchEnv(invocation, now)), query, invocation, now);
}

function interpretSearch(r, query, invocation, now) {
  const out = { ...r, query, invocation, now, rows: null, timings: null, jsonBytes: null, parseError: null, filterCounts: null };
  // deniedCount / namespaceCount are printed only in human-form output, inside
  // the population-load line, so they are read from the same window 3.7 uses.
  const q0 = r.stdout.indexOf('\nQuery: "');
  const load = q0 === -1 ? r.stdout : r.stdout.slice(0, q0);
  if (/\d+ entries loaded\./.test(load)) {
    const d = load.match(/\((\d+) confidential-class chunk\(s\) filtered by index-deny\.json\)/);
    const n = load.match(/\((\d+) non-INDEX namespace chunk\(s\) filtered by namespace-registry\.json\)/);
    out.filterCounts = { denied: d ? +d[1] : 0, namespace: n ? +n[1] : 0 };
  }
  const timing = r.stdout.match(/^Embed: (\d+)ms \| Search: (\d+)ms \| Total: (\d+)ms$/m);
  if (timing) out.timings = { embed: +timing[1], search: +timing[2], total: +timing[3] };
  const marker = r.stdout.lastIndexOf('\nJSON:\n');
  if (marker !== -1) {
    const block = r.stdout.slice(marker + '\nJSON:\n'.length).trim();
    out.jsonBytes = Buffer.byteLength(block, 'utf8');
    try {
      const v = JSON.parse(block);
      if (Array.isArray(v)) out.rows = v;
      else out.parseError = 'results block is not an array';
    } catch (e) { out.parseError = e.message; }
  }
  out.abstain = classifyAbstention({ status: r.status, rows: out.rows, stderr: r.stderr, token: invocation });
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
  if (abstainGate(res)) return record(c.id, c.class, 'fail', abstainGate(res));
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
  const v = negativeVerdict({ status: res.status, rows: res.rows, abstain: res.abstain, indexPresent: existsSync(box.embeddings) });
  const extra = { kind: c.kind, ...(v.extra || {}) };
  if (v.requires) extra.requires = v.requires;
  record(c.id, c.class, v.status, v.detail, extra);
}

const inversions = [];
function scoreTemporal(box, c) {
  // PREREG-002 F8 re-invokes the temporal class with a pre-window instant.
  const res = search(box, c.query, { now: SPEC.temporalNow || FROZEN_NOW });
  checkBudget(c.id, res);
  scanPolicy(c.id, res);
  if (res.status !== 0) return record(c.id, c.class, 'fail', `search exited ${res.status}`);
  if (!res.rows) return record(c.id, c.class, 'fail', 'no JSON block parsed');
  if (abstainGate(res)) return record(c.id, c.class, 'fail', abstainGate(res));
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

// Zero tolerance first: leaking the text is fatal whatever the proof says
// (PREREG-001 3.3, 3.5). Then the stage-aware proof (PREREG-002 3.2a): absence
// alone is not a PASS.
function scoreWithheld(box, c) {
  const q = stageOf(c) === 'QUERY' ? runQueryStage(box, c, F4_SEED) : null;
  const res = q ? q.res : search(box, c.query);
  checkBudget(c.id, res);
  const policy = scanPolicy(c.id, res);
  if (res.status !== 0) return record(c.id, c.class, 'fail', `search exited ${res.status}`);
  if (!res.rows) return record(c.id, c.class, 'fail', 'no JSON block parsed');
  if (abstainGate(res)) return record(c.id, c.class, 'fail', abstainGate(res));
  const present = res.rows.find((r) => r.path === c.target);
  const extra = { target: c.target, targetReturned: !!present, topPath: res.rows[0]?.path, topScore: res.rows[0]?.score };
  if (c.canary && res.all.includes(c.canary)) return record(c.id, c.class, 'fail', `canary ${c.canary} appeared in process output`, extra);
  if (present && !String(present.chunk).startsWith('[REFUSED:')) {
    return record(c.id, c.class, 'fail', 'target row returned with a non-refused chunk', extra);
  }
  const leaks = policy.rows.filter((r) => !r.refused);
  if (leaks.length) return record(c.id, c.class, 'fail', `policy false positive in results: ${leaks.map((r) => r.path).join(', ')}`, extra);
  return q ? finishQueryStage(c, q, extra) : finishBuildStage(box, c, res, extra);
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
  const pristineText = readFileSync(box.embeddings, 'utf8');
  try {
    let vector;
    try { vector = embedOne(box, staleRow.chunk); }
    catch (e) { harnessErrors.push(`${c.id}: the runner's own embed helper failed: ${e.message}`); return; }
    const index = JSON.parse(pristineText);
    index.notes.push({ path: staleRow.path, title: staleRow.title, tags: [], chunk: staleRow.chunk, embedding: vector, mtime: 0 });
    index.entryCount = index.notes.length;
    writeIndex(box, index);
    const seed = { path: staleRow.path, title: staleRow.title, chunk: staleRow.chunk, vector, pristineText, seededText: readFileSync(box.embeddings, 'utf8') };
    const q = runQueryStage(box, c, seed);
    const res = q.res;
    checkBudget(c.id, res);
    scanPolicy(c.id, res);
    if (res.status !== 0) return record(c.id, c.class, 'fail', `search exited ${res.status}`);
    if (!res.rows) return record(c.id, c.class, 'fail', 'no JSON block parsed');
    if (abstainGate(res)) return record(c.id, c.class, 'fail', abstainGate(res));
    const present = res.rows.find((r) => r.path === staleRow.path);
    const extra = { injectedPath: staleRow.path, expectedDisposition: c.expectedDisposition, returned: !!present, topPath: res.rows[0]?.path };
    if (res.all.includes(c.canary)) return record(c.id, c.class, 'fail', `injected canary ${c.canary} appeared in process output`, extra);
    if (present && !String(present.chunk).startsWith('[REFUSED:')) {
      return record(c.id, c.class, 'fail', 'injected non-INDEX row returned with a non-refused chunk', extra);
    }
    finishQueryStage(c, q, extra);
  } finally {
    writeFileSync(box.embeddings, pristineText);
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

// PC-01, the harness's proof that it can see a hit at all. PREREG-002 section 6:
// a RUNNABLE PC-01 whose answer is wrong, or that exits non-zero while every 4.3
// prerequisite is present, is a behavioral FAIL; UNRUNNABLE needs a named 4.3 gap
// and is decided before any sandbox exists.
function scorePC01(box) {
  const pc = byId.get('PC-01');
  const pcRes = search(box, pc.query);
  checkBudget('PC-01', pcRes);
  scanPolicy('PC-01', pcRes);
  if (pcRes.status !== 0) {
    record('PC-01', 'positive-control', 'fail', `search exited ${pcRes.status}: ${pcRes.stderr.trim().slice(0, 200)}`);
  } else if (abstainGate(pcRes)) {
    record('PC-01', 'positive-control', 'fail', abstainGate(pcRes));
  } else if (!pcRes.rows || !pcRes.rows.length) {
    record('PC-01', 'positive-control', 'fail', 'no rows returned');
  } else {
    const r1 = pcRes.rows[0];
    const prov = provenanceFailure(r1);
    if (r1.path !== pc.target) record('PC-01', 'positive-control', 'fail', `rank-1 was ${r1.path}, expected ${pc.target}`, { topScore: r1.score });
    else if (prov) record('PC-01', 'positive-control', 'fail', `rank-1 correct but provenance failed: ${prov}`, { topScore: r1.score });
    else record('PC-01', 'positive-control', 'pass', `rank 1, score ${r1.score}`, { topScore: r1.score });
  }
}

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
    catch (e) { harnessErrors.push(`${c.id}: the runner's own embed helper failed: ${e.message}`); return; }
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

// A complete PREREG-002 1.7 record (items 1-7), baseline (`B-nnn`) or candidate
// (`C-nnn`). `omit` drops one key to build the incomplete shapes the gate must refuse.
function registrationText({ id, commit, pins, instrumentSha, instrumentCommit, env, omit = [], over = {}, extra = '' }) {
  const f = {
    candidate_id: id, product_commit: commit, repository: 'wrg32786/aigent-os', branch: 'titus/fixture',
    instrument_sha256: instrumentSha, instrument_commit: instrumentCommit,
    environment_os: env.os, environment_node: env.node, environment_bash: env.bash, environment_model: env.model,
    protocol: PREREG, packet_sha256: PACKET_SHA256, registered_at: '2026-10-02T00:00:00Z', registered_by: 'titus',
    ...over,
  };
  const head = Object.entries(f).filter(([k]) => !omit.includes(k)).map(([k, v]) => `${k}: ${v}`).join('\n');
  const pinLines = Object.entries(pins).map(([f2, h]) => `${h}  ${f2}`).join('\n');
  return `${head}\n${pinLines}\n${extra}\n`;
}

// ── self-check: identity, pins, copy list, clock (PREREG-002 section 7 items
//    1, 2, 3, 7, 9). Synthetic inputs only; no model, no product run. ─────────
function selfCheckIdentity(check) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'recollection-selfcheck-'));
  sandboxes.push(tmp);
  try {
    // 1. product_commit is observed, never a literal.
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const repo = path.join(tmp, 'repo');
    mkdirSync(repo);
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: gitEnv });
    git('init', '-q');
    writeFileSync(path.join(repo, 'f.txt'), 'x');
    git('add', 'f.txt');
    git('commit', '-q', '--no-verify', '-m', 'x');
    const truth = git('rev-parse', 'HEAD').stdout.trim();
    const seen = observeProductCommit(repo);
    check('1 product_commit observed from the tree', seen === truth && /^[0-9a-f]{40}$/.test(seen) && seen !== BASELINE_COMMIT, `${seen} vs ${truth}`);
    const notRepo = path.join(tmp, 'plain');
    mkdirSync(notRepo);
    check('1 no checkout -> null, never a constant', observeProductCommit(notRepo) === null);
    const verify = (c, sha) => instrumentCommitVerifier(repo, 'f.txt', sha)(c);
    const xSha = createHash('sha256').update('x').digest('hex');
    check('4 I4 instrument_commit verifier: the commit whose blob hashes to the instrument -> true; wrong sha, missing path or unknown commit -> false',
      verify(truth, xSha) === true && verify(truth, 'f'.repeat(64)) === false && instrumentCommitVerifier(repo, 'nope.txt', xSha)(truth) === false && verify('c'.repeat(40), xSha) === false);

    // 2. all ten sandbox copies verified against the pins.
    check('2 baseline pins are the ten frozen paths', PINNED_PATHS.length === 10
      && Object.keys(BASELINE_PINS).sort().join() === [...PINNED_PATHS].sort().join()
      && Object.values(BASELINE_PINS).every((h) => /^[0-9a-f]{64}$/.test(h)));
    const files = {};
    const pins = {};
    PINNED_PATHS.forEach((label, i) => {
      files[label] = path.join(tmp, `pin-${i}`);
      writeFileSync(files[label], `content ${i}`);
      pins[label] = fileHash(files[label]);
    });
    check('2 ten matching copies -> no mismatch', verifyPins(files, pins).length === 0);
    writeFileSync(files['daemons/memory-root.sh'], 'edited');
    const drift = verifyPins(files, pins);
    check('2 one edited copy -> that file named', drift.length === 1 && drift[0].file === 'daemons/memory-root.sh', JSON.stringify(drift.map((d) => d.file)));
    rmSync(files['daemons/memory-root.cjs']);
    const gone = verifyPins(files, pins);
    check('2 one absent copy -> ABSENT named', gone.some((d) => d.file === 'daemons/memory-root.cjs' && d.observed === 'ABSENT'));
    check('2 a pin with no file in the map is a mismatch, not a skip', verifyPins({}, { 'daemons/memory-root.cjs': 'a'.repeat(64) }).length === 1);

    // 3. both memory-root files in the sandbox copy list; the real sandbox has them.
    check('3 copy list carries memory-root.cjs and .sh', SANDBOX_DAEMON_FILES.includes('memory-root.cjs') && SANDBOX_DAEMON_FILES.includes('memory-root.sh'));
    const box0 = makeSandbox('selfcheck');
    const map = sandboxFileMap(box0);
    check('3 every pinned file exists in a built sandbox', PINNED_PATHS.every((l) => existsSync(map[l])), PINNED_PATHS.filter((l) => !existsSync(map[l])).join());

    // 7. the clock and token are the runner's, whatever the caller inherited.
    const keep = Object.fromEntries(SCRUBBED_ENV.map((k) => [k, process.env[k]]));
    process.env.AIGENT_SEARCH_NOW = '1999-01-01T00:00:00Z';
    process.env.AIGENT_STATE_HOME_DIR = '/elsewhere';
    process.env.AIGENT_SEARCH_DISABLE_SUPERSESSION = '1';
    const env = invocationEnv(box0, { AIGENT_SEARCH_NOW: FROZEN_NOW, AIGENT_SEARCH_INVOCATION: 'tok-12345678' });
    for (const k of SCRUBBED_ENV) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
    check('7 search env pins AIGENT_SEARCH_NOW over an inherited value', env.AIGENT_SEARCH_NOW === FROZEN_NOW && FROZEN_NOW === '2026-09-30T00:00:00Z');
    check('7 inherited state-home and supersession switch are scrubbed', env.AIGENT_STATE_HOME_DIR === undefined && env.AIGENT_SEARCH_DISABLE_SUPERSESSION === undefined);
    const toks = Array.from({ length: 300 }, freshToken);
    check('4 invocation tokens: unique, 8-64 chars of [A-Za-z0-9-]', new Set(toks).size === 300 && toks.every((t) => TOKEN_RE.test(t)));
    const pre = preWindowInstant(CORPUS);
    check('7 F8 instant: Z form, one day before the earliest window end, earlier than the frozen instant',
      /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(pre || '') && Date.parse(pre) < Date.parse(FROZEN_NOW), String(pre));

    // 9. identity gate. Registration records carry ALL of frozen 1.7 items 1-7.
    const SHA = 'a'.repeat(64);
    const CAND = 'b'.repeat(40);
    const IC = 'd'.repeat(40);
    const ENV = { os: 'testos', node: 'v22.0.0', bash: '/usr/bin/bash', model: 'Xenova/all-MiniLM-L6-v2' };
    const fakePins = Object.fromEntries(PINNED_PATHS.map((f, i) => [f, String(i).repeat(64).slice(0, 64)]));
    const gate = (observed, text, sha = SHA, env = ENV) => resolveIdentity({ observed, candidatesText: text, candidatesSource: 'CANDS.md', instrumentSha: sha, environment: env, verifyInstrumentCommit: (c) => c === IC });
    const rec = (id, commit, o = {}) => registrationText({ id, commit, pins: fakePins, instrumentSha: SHA, instrumentCommit: IC, env: ENV, ...o });
    const baseline = gate(BASELINE_COMMIT, '');
    check('9 baseline commit -> baseline identity', baseline.kind === 'baseline');
    const unknown = gate(CAND, '');
    check('9 unknown commit, no file -> refused, names the identity', !unknown.ok && unknown.why.includes(CAND) && !!unknown.requires, unknown.why);
    const reg = gate(CAND, rec('C-001', CAND));
    check('9 registered candidate -> its own pins', reg.ok && reg.kind === 'candidate' && reg.candidate_id === 'C-001' && Object.keys(reg.pins).length === 10, reg.why);
    check('9 candidate registered for another instrument -> refused', !gate(CAND, rec('C-001', CAND), 'c'.repeat(64)).ok);
    check('9 candidate record missing a pin -> refused naming it', (() => { const r = gate(CAND, rec('C-001', CAND).replace(/^.*memory-root\.sh.*$/m, '')); return !r.ok && r.why.includes('memory-root.sh'); })());
    check('9 withdrawn candidate -> refused', !gate(CAND, rec('C-001', CAND) + rec('C-002', 'c'.repeat(40), { extra: 'withdraws: C-001' })).ok);
    check('9 unobservable commit -> refused, never a guess', !gate(null, '').ok);

    // I4: a record missing any of 1.7 items 1-7 is NOT registered; the record's own
    // identity is preserved for the packet.
    check('9 I4 the full record is registered and its identity is preserved', reg.ok && reg.registration && reg.registration?.state === 'registered' && reg.registration?.record?.instrument_commit === IC && reg.registration?.record?.registered_by === 'titus' && reg.registration?.record?.registered_at === '2026-10-02T00:00:00Z', JSON.stringify(reg.registration));
    const minimal = `candidate_id: C-001\nproduct_commit: ${CAND}\ninstrument_sha256: ${SHA}\npacket_sha256: ${PACKET_SHA256}\n${Object.entries(fakePins).map(([f, h]) => `${h}  ${f}`).join('\n')}\n`;
    check("9 I4 the review's minimal record (id, commit, instrument hash, packet hash, ten pins) is NOT registered", !gate(CAND, minimal).ok);
    for (const key of ['repository', 'branch', 'instrument_commit', 'environment_os', 'environment_node', 'environment_bash', 'environment_model', 'protocol', 'packet_sha256', 'registered_at', 'registered_by']) {
      check(`9 I4 candidate record without ${key} -> NOT registered, ${key} named`, (() => { const r = gate(CAND, rec('C-001', CAND, { omit: [key] })); return !r.ok && r.why.includes(key); })());
    }
    check('9 I4 an instrument_commit that does not contain this instrument -> NOT registered', !gate(CAND, rec('C-001', CAND, { over: { instrument_commit: 'e'.repeat(40) } })).ok);
    check('9 I4 a record from another host environment -> NOT registered (node)', !gate(CAND, rec('C-001', CAND), SHA, { ...ENV, node: 'v21.0.0' }).ok);
    check('9 I4 a record from another host environment -> NOT registered (model)', !gate(CAND, rec('C-001', CAND), SHA, { ...ENV, model: 'other/model' }).ok);
    check('9 I4 registered_at that is not a Z instant -> NOT registered', !gate(CAND, rec('C-001', CAND, { over: { registered_at: 'yesterday' } })).ok);
    check('9 I4 registered_at in the future -> NOT registered', !gate(CAND, rec('C-001', CAND, { over: { registered_at: '2999-01-01T00:00:00Z' } })).ok);
    check('9 I4 a protocol string other than recollection-44/PREREG-002 -> NOT registered', !gate(CAND, rec('C-001', CAND, { over: { protocol: 'recollection-44/PREREG-001' } })).ok);
    const brec = (o = {}) => rec('B-001', BASELINE_COMMIT, { pins: BASELINE_PINS, ...o });
    const bGate = (text, o) => gate(BASELINE_COMMIT, text, SHA, o);
    check('9 I4 baseline: the full record registers the instrument', bGate(brec()).instrumentRegistered === true && bGate(brec()).registration?.state === 'registered', JSON.stringify(bGate(brec()).registration));
    check('9 I4 baseline: the old one-line baseline_instrument_sha256 registers nothing', bGate(`baseline_instrument_sha256: ${SHA}\n`).instrumentRegistered === false);
    check('9 I4 baseline: the minimal record is incomplete, NOT registered', (() => { const r = bGate(`candidate_id: B-001\nproduct_commit: ${BASELINE_COMMIT}\ninstrument_sha256: ${SHA}\npacket_sha256: ${PACKET_SHA256}\n`); return r.instrumentRegistered === false && r.registration?.state === 'incomplete'; })());
    check('9 I4 baseline: a record whose pins are not the frozen baseline pins -> incomplete', bGate(brec({ pins: fakePins })).registration?.state === 'incomplete');
    check('9 I4 baseline: a record missing an item -> incomplete, item named', (() => { const r = bGate(brec({ omit: ['environment_bash'] })); return r.instrumentRegistered === false && r.registration?.problems.join(';').includes('environment_bash'); })());
    // R4-LOW-4: the packet_sha256 binding, and a withdrawal only from a LATER record (1.7).
    check('9 R4-LOW-4 candidate record carrying another packet_sha256 value -> NOT registered', !gate(CAND, rec('C-001', CAND, { over: { packet_sha256: 'e'.repeat(64) } })).ok);
    check('9 R4-LOW-4 baseline record carrying another packet_sha256 value -> incomplete', bGate(brec({ over: { packet_sha256: 'e'.repeat(64) } })).registration?.state === 'incomplete');
    check('9 R4-LOW-4 a withdraws: line that PRECEDES the record it names does not withdraw it', bGate(`candidate_id: B-000\nwithdraws: B-001\n${brec()}`).registration?.state === 'registered');
    check('9 R4-LOW-4 ... nor a candidate', gate(CAND, `candidate_id: C-000\nwithdraws: C-001\n${rec('C-001', CAND)}`).ok);
    // R2: withdrawn is distinguishable from absent.
    check('9 R2 baseline: no record at all -> absent', bGate('').registration?.state === 'absent');
    check('9 R2 baseline: a record for ANOTHER instrument -> absent', bGate(brec({ over: { instrument_sha256: 'c'.repeat(64) } })).registration?.state === 'absent');
    check('9 R2 baseline: a later record withdrawing it -> withdrawn, not registered, not absent', (() => { const r = bGate(`${brec()}candidate_id: B-002\nwithdraws: B-001\n`); return r.instrumentRegistered === false && r.registration?.state === 'withdrawn' && r.registration?.record_id === 'B-001'; })());
  } finally {
    // sandboxes are removed by the exit hook
  }
}

// ── self-check: sidecar rules and bash probe (PREREG-002 section 7 items 4, 6) ──
function selfCheckSidecar(check) {
  const T = 'rec-0123456789abcdef';
  const line = (o) => `${ABSTAIN_PREFIX} ${JSON.stringify(o)}`;
  const good = { schema: 'abstain/1', invocation: T, outcome: 'abstain', reason: 'below-tau' };
  const cls = (stderr, rows = [], status = 0) => classifyAbstention({ status, rows, stderr, token: T });
  const detail = (stderr, rows) => { const r = cls(stderr, rows); return r.state === 'rejected' || r.state === 'none' ? r.detail : r.state; };

  check('4 honest abstention: exit 0, [], bound line, vocabulary reason', cls(line(good)).state === 'honest');
  check('4 honest abstention, second vocabulary reason', cls(line({ ...good, reason: 'no-eligible-candidates' })).state === 'honest');
  check('4 honest abstention amid CRLF stderr noise', cls(`warn: x\r\n${line(good)}\r\nmore\r\n`).state === 'honest');
  check('4 silent-zero-rows: [] and no line', detail('', []) === 'silent-zero-rows');
  check('4 free text "abstained" without the prefix is not evidence', detail('retriever abstained: below tau\n', []) === 'silent-zero-rows');
  check('4 duplicated line', detail(`${line(good)}\n${line(good)}`, []) === 'abstention-sidecar-duplicated');
  const bad = {
    'not JSON': `${ABSTAIN_PREFIX} {nope`,
    'missing key': line({ schema: 'abstain/1', invocation: T, outcome: 'abstain' }),
    'extra key': line({ ...good, extra: 1 }),
    'wrong schema': line({ ...good, schema: 'abstain/2' }),
    'wrong outcome': line({ ...good, outcome: 'declined' }),
    'array payload': `${ABSTAIN_PREFIX} [1]`,
    'no space after prefix': `${ABSTAIN_PREFIX}${JSON.stringify(good)}`,
  };
  for (const [name, text] of Object.entries(bad)) check(`4 malformed: ${name}`, detail(text, []) === 'abstention-sidecar-malformed', detail(text, []));
  check('4 reason outside the closed vocabulary', detail(line({ ...good, reason: 'because' }), []) === 'abstention-reason-unknown');
  check('4 invocation replayed from another query', detail(line({ ...good, invocation: 'rec-ffffffffffffffff' }), []) === 'abstention-sidecar-unbound');
  const row = [{ path: 'a.md', score: 0.1 }];
  check('4 valid line beside non-empty rows is contradicted', detail(line(good), row) === 'abstention-contradicted');
  check('4 garbled line beside non-empty rows is a contradiction on every class', abstainGate({ abstain: cls(`${ABSTAIN_PREFIX} {nope`, row) }) === 'abstention-contradicted');
  check('4 no line and rows -> no gate', abstainGate({ abstain: cls('', row) }) === null);
  check('4 non-zero exit with a valid line is never an abstention', cls(line(good), [], 1).state === 'n/a');
  check('4 line with no results block is rejected', cls(line(good), null).state === 'rejected');

  // The negative-class decision on synthetic process output.
  const verdict = (o) => negativeVerdict({ status: 0, indexPresent: true, rows: [], abstain: cls(''), ...o });
  check('4 negative: honest abstention is PASS', verdict({ abstain: cls(line(good)) }).status === 'pass');
  check('4 negative: silence is FAIL silent-zero-rows', (() => { const v = verdict({}); return v.status === 'fail' && v.detail === 'silent-zero-rows'; })());
  check('4 negative: rejected sidecar is FAIL with its detail', verdict({ abstain: cls(line({ ...good, reason: 'x' })) }).detail === 'abstention-reason-unknown');
  check('4 negative: rows with top-1 >= tau is FAIL', verdict({ rows: [{ path: 'a.md', score: 0.31 }], abstain: cls('', [{}]) }).status === 'fail');
  check('4 negative: rows with top-1 < tau is PASS', verdict({ rows: [{ path: 'a.md', score: 0.29 }], abstain: cls('', [{}]) }).status === 'pass');
  check('4 negative: sidecar beside rows is FAIL abstention-contradicted', verdict({ rows: row, abstain: cls(line(good), row) }).detail === 'abstention-contradicted');
  check('4 negative: non-zero exit with the index present is a behavioral FAIL', verdict({ status: 1, rows: null }).status === 'fail');
  const dead = verdict({ status: 1, rows: null, indexPresent: false });
  check('4 negative: F6 exception, dead retriever is UNRUNNABLE naming the gap', dead.status === 'unrunnable' && !!dead.requires);

  // 6. The bash probe, against synthetic shims.
  const shim = (probeResult) => (cmd, args) => (cmd === 'bash' && args[0] === '-c' ? { status: 0, stdout: '', stderr: '' } : cmd === 'bash' ? probeResult : { status: 0, stdout: 'C:\\shim\\bash.exe\n', stderr: '' });
  const wsl = shim({ status: 127, stdout: '', stderr: '/bin/bash: C:UserswillAppDataLocalTemp: No such file or directory' });
  check('6 the old check ("bash -c true") passes the WSL-style shim', wsl('bash', ['-c', 'true']).status === 0);
  const g = bashProbe(wsl);
  check('6 the functional probe rejects it, naming the interpreter', !g.ok && g.why.includes('doctor.sh') && g.why.includes('127'), g.why);
  check('6 a bash that runs the script but reads no argument is rejected', !bashProbe(shim({ status: 0, stdout: '', stderr: '' })).ok);
  check('6 a bash that reads the Windows-path script and argument passes', bashProbe(shim({ status: 0, stdout: 'BASH-PROBE-OK', stderr: '' })).ok);
  const here = bashProbe();
  check('6 this host: resolved bash passes the functional probe', here.ok, here.why || here.resolved);
}

// ── stage-aware policy proof, PREREG-002 3.2a ────────────────────────────────
// "Absent from the returned rows" is not a policy PASS. The runner must say
// WHICH stage withheld the target and prove it from that stage's own evidence:
//   BUILD-WITHHELD     the indexer never indexed the target (clean build)
//   QUERY-WITHHELD     the index held the target and the query filters removed it
//   RENDER-REFUSED     the row survived to the output and the chokepoint refused it
//   DECLINED-BY-RETRIEVER  the index held it, no filter removed it, and it is
//                      absent for ranking/abstention reasons: NOT a policy PASS
// An undemonstrated proof is FAIL `policy-withholding-not-demonstrated`. That is
// not a leak: no zero-tolerance trigger, not a policy false positive, but it
// still counts toward the class gate. Auxiliary controls live in their own
// packet block and never enter totals, scanPolicy or leakedCanaries.
const NOT_DEMONSTRATED = 'policy-withholding-not-demonstrated';
const auxiliaryControls = [];
let buildInputPresence = {};
let builtRowCounts = null;
let F4_SEED = null;
let indexBuild = null;
let POLICY = null;

// The product's own predicates, imported from the SANDBOX copies and applied in
// the product's order (deniedPath, then namespaceDispositionForPath). This is
// what the policy SHOULD do; it is never, alone, the label.
async function loadPolicy(box) {
  const url = (f) => pathToFileURL(path.join(box.sem, f)).href;
  const deny = await import(url('deny-list.mjs'));
  const reg = await import(url('namespace-registry.mjs'));
  return {
    deniedPath: deny.deniedPath,
    prefixes: deny.requireDenyPrefixes(box.sem, 'recollection'),
    registry: reg.requireNamespaceRegistry(box.sem, 'recollection'),
    dispositionForPath: reg.namespaceDispositionForPath,
  };
}

function expectedEligibility(policy, target) {
  if (policy.deniedPath(policy.prefixes, target)) return { eligible: false, filter: 'denied', disposition: 'DENY-PREFIX' };
  const disposition = policy.dispositionForPath(policy.registry, target);
  if (disposition === 'INDEX') return { eligible: true, filter: null, disposition };
  return { eligible: false, filter: 'namespace', disposition: disposition || 'undeclared' };
}

// 3.2a population. BUILD: every deny and skip case and the withheld-kind
// operator cases, against a clean-built index. QUERY: the stale-index cases and
// F4's injected row. U-01/U-02, O-01 and everything else: not in the population.
function stageOf(c) {
  if (c.class === 'stale-index') return 'QUERY';
  if (SCENARIO === 'F4' && c.id === 'C-02') return 'QUERY';
  if (c.class === 'deny' || c.class === 'skip') return 'BUILD';
  if (c.class === 'operator' && (c.kind === 'skip' || c.kind === 'deny')) return 'BUILD';
  return null;
}

// A permitted control is a witness only if its invocation SUCCEEDED and its
// evidence is coherent: exit 0, a parsed results block, no rejected sidecar. A
// control that prints its row and then exits non-zero has not demonstrated that
// the content is retrievable; "not demonstrated" is accounted, not "returned".
function controlCoherence(res) {
  if (res.status !== 0) return `control-invocation-failed (exit ${res.status})`;
  if (!Array.isArray(res.rows)) return 'control-results-block-unparsed';
  if (res.abstain && res.abstain.state === 'rejected') return `control-sidecar-rejected (${res.abstain.detail})`;
  return null;
}

// BUILD-stage label. All four conditions of 3.2a or no label.
function labelBuildStage(ev) {
  const gaps = [];
  if (ev.expected.eligible) gaps.push('expected-eligible: the target path is INDEX-eligible, so there is nothing for a build to withhold');
  if (!ev.sourcePresentAtBuild) gaps.push('source-not-present-at-build');
  if (ev.indexRowsAtTarget !== 0) gaps.push(`index-holds-target-rows (${ev.indexRowsAtTarget})`);
  if (!ev.control || !(ev.control.indexedRows >= 1 && ev.control.returned)) gaps.push(`matched-permitted-control-failed${ev.control && ev.control.failure ? ` (${ev.control.failure})` : ''}`);
  return gaps.length ? { label: null, demonstrated: false, gaps } : { label: 'BUILD-WITHHELD', demonstrated: true, gaps };
}

// QUERY-stage label. `delta` is the target-attributable filter-count delta
// against the pristine index; `seededChunks` is how many rows were seeded.
function labelQueryStage(ev) {
  const gaps = [];
  if (ev.expected.eligible) gaps.push('expected-eligible: the target path is INDEX-eligible');
  if (!ev.readBack || !ev.readBack.present) gaps.push('seeded-row-not-read-back-from-the-input-index');
  if (gaps.length) return { label: null, demonstrated: false, gaps };
  if (ev.targetReturned && ev.targetRefused) return { label: 'RENDER-REFUSED', demonstrated: true, gaps };
  if (ev.targetReturned) return { label: null, demonstrated: false, gaps: ['target row returned unrefused (leak, scored elsewhere)'] };
  if (!ev.control || !ev.control.returned) {
    const why = ev.control && ev.control.failure ? `; ${ev.control.failure}` : '';
    return { label: null, demonstrated: false, gaps: [`matched-seeded-control-not-returned: a gate that also suppresses its own permitted control is not a causal witness${why}`] };
  }
  if (ev.delta === ev.seededChunks) return { label: 'QUERY-WITHHELD', demonstrated: true, gaps };
  if (ev.delta === 0) return { label: 'DECLINED-BY-RETRIEVER', demonstrated: false, gaps: ['no target-attributable filter removal: the retriever declined, the policy layer never acted'] };
  return { label: null, demonstrated: false, gaps: [`filter-delta-mismatch (delta ${ev.delta}, seeded ${ev.seededChunks})`] };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const controlPathFor = (id) => `research/recollection-control-${String(id).toLowerCase()}.md`;

function withIndexText(box, text, fn) {
  const keep = readFileSync(box.embeddings, 'utf8');
  writeFileSync(box.embeddings, text);
  try { return fn(); } finally { writeFileSync(box.embeddings, keep); }
}

// The seeded row, read back from the INPUT index before any search (3.2a step 2).
function readBackSeed(box, seed) {
  const rows = readIndex(box).notes.filter((n) => n.path === seed.path);
  const same = (v) => Array.isArray(v) && v.length === seed.vector.length && v.every((x, i) => x === seed.vector[i]);
  return { present: rows.length > 0 && rows.every((r) => same(r.embedding) && r.chunk === seed.chunk), count: rows.length };
}

// QUERY-stage invocations around one seeded index (the index file currently IS
// seed.seededText): read-back first, the pristine paired search, the forbidden
// run itself, then the matched seeded control (same chunk, same vector, an INDEX
// path) in a separate invocation. Filter counts are printed only in human-form
// output: the seeded count is taken from the forbidden run's own invocation, the
// pristine count from the paired invocation on the pristine index.
function runQueryStage(box, c, seed) {
  const readBack = readBackSeed(box, seed);
  const pristineRes = withIndexText(box, seed.pristineText, () => search(box, c.query));
  const res = search(box, c.query);
  const controlPath = controlPathFor(c.id);
  const ctl = JSON.parse(seed.pristineText);
  ctl.notes.push({ path: controlPath, title: seed.title, tags: [], chunk: seed.chunk, embedding: seed.vector, mtime: 0 });
  ctl.entryCount = ctl.notes.length;
  const controlRes = withIndexText(box, JSON.stringify(ctl, null, 0), () => search(box, c.query));
  return { readBack, pristineRes, res, controlRes, controlPath, seed };
}

function finishQueryStage(c, q, extra) {
  const target = q.seed.path;
  const expected = expectedEligibility(POLICY, target);
  const present = (q.res.rows || []).find((r) => r.path === target);
  const refused = !!present && String(present.chunk).startsWith('[REFUSED:');
  const controlRow = (q.controlRes.rows || []).findIndex((r) => r.path === q.controlPath);
  const controlFailure = controlCoherence(q.controlRes);
  const returned = controlRow !== -1 && controlFailure === null;
  const control = { path: q.controlPath, returned, rank: returned ? controlRow + 1 : null, exit: q.controlRes.status, failure: controlFailure };
  const seededCount = expected.filter ? (q.res.filterCounts || {})[expected.filter] : null;
  const pristineCount = expected.filter ? (q.pristineRes.filterCounts || {})[expected.filter] : null;
  const delta = seededCount == null || pristineCount == null ? null : seededCount - pristineCount;
  const ev = { expected, readBack: q.readBack, targetReturned: !!present, targetRefused: refused, control, delta, seededChunks: q.readBack.count };
  const verdict = labelQueryStage(ev);
  const proof = {
    stage: 'QUERY', expected, readBack: q.readBack, control, filter: expected.filter, delta, seededChunks: q.readBack.count,
    counts: { seeded: seededCount, pristine: pristineCount, seededSource: 'same invocation (the forbidden run)', pristineSource: 'paired invocation on the pristine index, same query' },
    gaps: verdict.gaps,
  };
  auxiliaryControls.push({ case: c.id, stage: 'QUERY', kind: 'matched-seeded-control', controlPath: q.controlPath, chunkSha256: sha256(q.seed.chunk), vectorSha256: sha256(JSON.stringify(q.seed.vector)), returned: control.returned, rank: control.rank, exit: control.exit, failure: control.failure, invocation: q.controlRes.invocation, topPaths: (q.controlRes.rows || []).map((x) => x.path) });
  const out = { ...extra, stage: 'QUERY', label: verdict.label, proof };
  if (verdict.demonstrated) return record(c.id, c.class, 'pass', verdict.label === 'RENDER-REFUSED' ? 'RENDER-REFUSED: present but refused' : `QUERY-WITHHELD: filter delta ${delta} == ${q.readBack.count} seeded chunk(s), control returned`, out);
  return record(c.id, c.class, 'fail', `${NOT_DEMONSTRATED}${verdict.label ? ` [${verdict.label}]` : ''}: ${verdict.gaps.join('; ')}`, { ...out, undemonstrated: true });
}

// The auxiliary sandbox for BUILD-stage controls: one sandbox, reused. For each
// case its vault is a fresh copy of the scored vault (same mutations) plus ONE
// byte-identical copy of the target note under an INDEX path; the index is built
// from scratch by the same indexer, then the same query runs against it.
let auxBox = null;
function auxBuildControl(box, c) {
  if (!auxBox) {
    auxBox = makeSandbox(`aux-${SCENARIO.toLowerCase()}`);
    SPEC.applyCode?.(auxBox);
  }
  const aux = auxBox;
  const sameCode = PINNED_PATHS.every((l) => {
    const a = sandboxFileMap(aux)[l];
    const b = sandboxFileMap(box)[l];
    return existsSync(a) && existsSync(b) && fileHash(a) === fileHash(b);
  });
  const controlPath = controlPathFor(c.id);
  const src = path.join(box.vault, ...c.target.split('/'));
  const out = { case: c.id, stage: 'BUILD', kind: 'matched-permitted-copy', controlPath, sandboxSameCodeAsScored: sameCode, targetSha256: null, copySha256: null, indexedRows: 0, returned: false, rank: null, buildExit: null, searchExit: null, failure: null };
  if (!existsSync(src)) { auxiliaryControls.push({ ...out, error: 'target source absent in the scored vault' }); return out; }
  rmSync(aux.vault, { recursive: true, force: true });
  cpSync(box.vault, aux.vault, { recursive: true, filter: (s) => path.basename(s) !== 'embeddings.json' });
  mkdirSync(path.join(aux.vault, 'memory'), { recursive: true });
  const bytes = readFileSync(src);
  writeFileSync(path.join(aux.vault, ...controlPath.split('/')), bytes);
  out.targetSha256 = sha256(bytes);
  out.copySha256 = sha256(readFileSync(path.join(aux.vault, ...controlPath.split('/'))));
  const eligible = expectedEligibility(POLICY, controlPath).eligible;
  const build = buildIndex(aux);
  out.buildExit = build.status;
  if (build.status === 0 && existsSync(aux.embeddings) && sameCode && eligible) {
    out.indexedRows = readIndex(aux).notes.filter((n) => n.path === controlPath).length;
    const r = search(aux, c.query);
    out.searchExit = r.status;
    const i = (r.rows || []).findIndex((x) => x.path === controlPath);
    out.failure = controlCoherence(r);
    out.returned = i !== -1 && out.failure === null && out.buildExit === 0;
    out.rank = out.returned ? i + 1 : null;
    out.invocation = r.invocation;
    out.topPaths = (r.rows || []).map((x) => x.path);
  }
  auxiliaryControls.push(out);
  return out;
}

function finishBuildStage(box, c, res, extra) {
  const expected = expectedEligibility(POLICY, c.target);
  const control = auxBuildControl(box, c);
  const ev = {
    expected, sourcePresentAtBuild: buildInputPresence[c.target] === true,
    indexRowsAtTarget: builtRowCounts ? (builtRowCounts.get(c.target) || 0) : null, control,
  };
  const verdict = labelBuildStage(ev);
  const proof = {
    stage: 'BUILD', expected, sourcePresentAtBuild: ev.sourcePresentAtBuild, indexRowsAtTarget: ev.indexRowsAtTarget,
    // corroboration only: an aggregate count that unrelated files can supply is never the evidence
    indexerDenyLine: (indexBuild?.all.match(/\[deny\] \d+ file\(s\) excluded by index-deny\.json/) || [null])[0],
    queryStageCounts: res.filterCounts, control: { path: control.controlPath, indexedRows: control.indexedRows, returned: control.returned, rank: control.rank, failure: control.failure, searchExit: control.searchExit, buildExit: control.buildExit, targetSha256: control.targetSha256, copySha256: control.copySha256 },
    gaps: verdict.gaps,
  };
  const out = { ...extra, stage: 'BUILD', label: verdict.label, proof };
  if (verdict.demonstrated) return record(c.id, c.class, 'pass', `BUILD-WITHHELD: source present, 0 index rows at the target, matched copy indexed and returned (rank ${control.rank})`, out);
  return record(c.id, c.class, 'fail', `${NOT_DEMONSTRATED}: ${verdict.gaps.join('; ')}`, { ...out, undemonstrated: true });
}

// ── named mutations (PREREG-002 section 6 F7, F9), applied to the SANDBOX copy ──
const F9_FILTERS = [
  'index.notes = index.notes.filter((n) => !deniedPath(DENY_PREFIXES, n.path));',
  "index.notes = index.notes.filter((note) => namespaceDispositionForPath(NAMESPACE_REGISTRY, note.path) === 'INDEX');",
];
// F9: delete ONLY the two query-stage filter calls. The render chokepoint, the
// physical-directory guard, deny-list.mjs, namespace-registry.mjs and the
// indexer stay as they are. An anchor that is not found exactly once throws:
// a mutation that cannot land must never run as an unmutated baseline.
function f9Mutate(source) {
  let out = source;
  for (const stmt of F9_FILTERS) {
    const n = out.split(stmt).length - 1;
    if (n !== 1) throw new Error(`F9 anchor found ${n} time(s), expected exactly 1: ${stmt.slice(0, 70)}`);
    out = out.replace(stmt, () => '');
  }
  return out;
}

// F7: abstain on everything, with a VALID bound sidecar, after index validation
// and both filters. NOT EXECUTABLE (CLAIM_LIMITS): no gate exists at the baseline,
// and the hook refuses a source that already emits the sidecar, which is exactly
// what a candidate's gate source would contain. The hook is exercised only on
// synthetic output; the candidate-specific hook is owed with that candidate.
const F7_ANCHOR = 'const searchTime = Date.now() - t1;';
function f7Mutate(source) {
  if (source.includes(ABSTAIN_PREFIX)) throw new Error('F7: the source already emits AIGENT_ABSTAIN; the hook has no anchor for that gate (owed to the candidate that carries it)');
  if (source.split(F7_ANCHOR).length - 1 !== 1) throw new Error('F7 anchor not found exactly once');
  return source.replace(F7_ANCHOR, () => `${F7_ANCHOR}\n  results.length = 0;\n  console.error(\`${ABSTAIN_PREFIX} \${JSON.stringify({ schema: 'abstain/1', invocation: process.env.AIGENT_SEARCH_INVOCATION, outcome: 'abstain', reason: 'below-tau' })}\`);`);
}

function mutateSandboxSearch(box, fn) {
  const file = path.join(box.sem, 'search-vault.js');
  writeFileSync(file, fn(readFileSync(file, 'utf8')));
}

// Assert per-case labels and control outcomes, not a printed count (7 item 8).
// Under F9: no QUERY-stage case may read QUERY-WITHHELD; RENDER-REFUSED or a
// DECLINED-BY-RETRIEVER FAIL may stand; each QUERY case must have exercised the
// matched control and shown a zero removal delta; BUILD-stage and U-class
// results must be UNCHANGED, which is relative to an unmutated run of the same
// identity (reference rows). Without a reference the check is narrower and says
// so: the build-side evidence must be intact and any BUILD-stage FAIL must be
// explained by its matched control alone (a control never touches the filters).
function f9Assertions(rows, reference = null, development = false) {
  const queryRows = rows.filter((r) => r.stage === 'QUERY');
  const buildRows = rows.filter((r) => r.stage === 'BUILD');
  const a = [];
  // `needs` names a class whose unrunnable cases make THIS assertion unjudgeable (a missing prerequisite,
  // not a failed expectation); `notEvaluated` marks an expectation that cannot be judged at all here.
  const add = (name, ok, detail, needs = null) => a.push({ name, ok: !!ok, detail: detail || '', needs });
  const notEvaluated = (name, detail) => a.push({ name, ok: false, notEvaluated: true, detail, needs: null });
  add('F9: QUERY-stage population present', queryRows.length >= 3, `${queryRows.length} case(s)`);
  add('F9: no QUERY-stage case reads QUERY-WITHHELD', queryRows.every((r) => r.label !== 'QUERY-WITHHELD'), queryRows.map((r) => `${r.id}=${r.label}`).join(', '));
  add('F9: every QUERY-stage case exercised the seeded read-back and a returned matched control',
    queryRows.every((r) => r.proof && r.proof.readBack && r.proof.readBack.present && r.proof.control && r.proof.control.returned),
    queryRows.map((r) => `${r.id}: readBack=${r.proof?.readBack?.present} control=${r.proof?.control?.returned}`).join('; '));
  add('F9: every QUERY-stage case shows a zero target-attributable removal delta', queryRows.every((r) => r.proof && r.proof.delta === 0), queryRows.map((r) => `${r.id}: delta=${r.proof?.delta}`).join('; '));
  add('F9: QUERY-stage labels are RENDER-REFUSED or DECLINED-BY-RETRIEVER only', queryRows.every((r) => r.label === 'RENDER-REFUSED' || r.label === 'DECLINED-BY-RETRIEVER'));
  const u = rows.filter((r) => r.class === 'undeclared');
  if (reference) {
    const ref = new Map(reference.map((r) => [r.id, r]));
    const same = (r) => ref.has(r.id) && ref.get(r.id).status === r.status && (ref.get(r.id).label ?? null) === (r.label ?? null);
    // A development comparison covers only the ids its reference carries and says so.
    const show = (rs) => {
      const moved = rs.filter((r) => !same(r));
      return { moved, text: moved.length ? `changed: ${moved.map((r) => `${r.id} ${ref.get(r.id)?.status}/${ref.get(r.id)?.label ?? null} -> ${r.status}/${r.label ?? null}`).join('; ')}` : `${rs.length} result(s) compared` };
    };
    // Two expectations (PREREG-002 F9): BUILD-stage unchanged, U-class unchanged. Only the second
    // reads U, so a BUILD case turning red is judged even when U-01/U-02 could not run.
    const bc = development ? buildRows.filter((r) => ref.has(r.id)) : buildRows;
    const uc = development ? u.filter((r) => ref.has(r.id)) : u;
    const bs = show(bc);
    const us = show(uc);
    if (development) {
      add('F9: BUILD-stage results equal the DEVELOPMENT comparison (narrower than a full same-method reference; not certifying)', bc.length > 0 && bs.moved.length === 0, bs.text);
      add('F9: U-class results equal the DEVELOPMENT comparison (narrower than a full same-method reference; not certifying)', us.moved.length === 0, us.text, 'undeclared');
      notEvaluated('F9: "BUILD-stage and U-class results unchanged" is NOT-EVALUATED: a development comparison is not a full same-method reference', 'the frozen expectation needs the full reference');
    } else {
      add('F9: BUILD-stage results equal the unmutated reference run', buildRows.length > 0 && bs.moved.length === 0, bs.text);
      add('F9: U-class results equal the unmutated reference run', u.length === 2 && us.moved.length === 0, us.text, 'undeclared');
    }
  } else {
    const intact = (r) => r.proof && r.proof.sourcePresentAtBuild === true && r.proof.indexRowsAtTarget === 0 && (r.status === 'pass' ? r.label === 'BUILD-WITHHELD' : r.proof.control && r.proof.control.returned === false);
    add('F9: BUILD-stage build-side evidence intact, every FAIL explained by its control alone (no --reference given: narrower check)',
      buildRows.length > 0 && buildRows.every(intact), `${buildRows.filter(intact).length}/${buildRows.length}`);
    add('F9: U-01/U-02 PASS (no --reference given)', u.length === 2 && u.every((r) => r.status === 'pass'), u.map((r) => `${r.id}=${r.status}`).join(', '), 'undeclared');
    notEvaluated('F9: "BUILD-stage and U-class results unchanged" is NOT-EVALUATED: no full same-method --reference was given', 'the narrower checks above are not the frozen expectation');
  }
  return a;
}

// ── self-check: stage-aware proof, mutations, F9 assertions, and a real child
//    process standing in for search-vault.js (PREREG-002 section 7 items 4, 5, 7, 8) ──
const MUTATION_CHECK_NAMES = [
  '8 F9 removes exactly the two query-stage filter calls',
  '8 F9 leaves the render chokepoint and the directory guard in place',
  '8 F9 is not an identity run: the mutated file no longer hashes to the pin',
  '8 F9 on a source without the anchor throws',
  '8 F7 hook: unconditional zero rows plus a bound sidecar, after the results are final',
  '8 F7 hook refuses a source that already carries a gate',
];
async function selfCheckPolicy(check) {
  const box = makeSandbox('selfcheck-policy');

  // The real child-process path: env scrub, clock, token, stderr capture, parse.
  writeFileSync(path.join(box.sem, 'env-probe.mjs'), [
    "const t = process.env.AIGENT_SEARCH_INVOCATION;",
    "console.log('Loading index... 5 entries loaded. (1 confidential-class chunk(s) filtered by index-deny.json) (2 non-INDEX namespace chunk(s) filtered by namespace-registry.json)');",
    "console.log('\\nQuery: \"q\"\\n');",
    "console.log(JSON.stringify({ now: process.env.AIGENT_SEARCH_NOW, state: process.env.AIGENT_STATE_HOME_DIR ?? null, sup: process.env.AIGENT_SEARCH_DISABLE_SUPERSESSION ?? null }));",
    "console.log('\\nJSON:');",
    "console.log('[]');",
    "console.error('AIGENT_ABSTAIN ' + JSON.stringify({ schema: 'abstain/1', invocation: t, outcome: 'abstain', reason: 'below-tau' }));",
  ].join('\n'));
  const keep = Object.fromEntries(SCRUBBED_ENV.map((k) => [k, process.env[k]]));
  process.env.AIGENT_SEARCH_NOW = '1999-01-01T00:00:00Z';
  process.env.AIGENT_STATE_HOME_DIR = '/elsewhere';
  process.env.AIGENT_SEARCH_DISABLE_SUPERSESSION = '1';
  const tok = freshToken();
  const probed = interpretSearch(runNode(box, 'env-probe.mjs', [], searchEnv(tok, FROZEN_NOW)), 'q', tok, FROZEN_NOW);
  for (const k of SCRUBBED_ENV) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  const seenEnv = (probed.stdout.match(/^\{"now".*$/m) || ['{}'])[0];
  check('7 a real child sees the frozen clock and no inherited state-home / supersession switch',
    seenEnv === JSON.stringify({ now: FROZEN_NOW, state: null, sup: null }), seenEnv);
  check('4 a real child: stderr sidecar bound to the token the runner issued -> honest abstention', probed.abstain.state === 'honest' && Array.isArray(probed.rows) && probed.rows.length === 0, JSON.stringify(probed.abstain));
  check('5 filter counts parsed from the population-load line (denied 1, namespace 2)', probed.filterCounts && probed.filterCounts.denied === 1 && probed.filterCounts.namespace === 2, JSON.stringify(probed.filterCounts));
  check('5 no "entries loaded" line -> counts unknown, not zero', interpretSearch({ status: 1, stdout: '', stderr: 'boom' }, 'q', tok, FROZEN_NOW).filterCounts === null);

  // expected eligibility: the product's own predicates, in the product's order.
  const policy = await loadPolicy(box);
  const el = (p) => expectedEligibility(policy, p);
  check('5 eligibility: ops-deny/ is namespace DENY', (() => { const e = el('ops-deny/x.md'); return !e.eligible && e.filter === 'namespace' && e.disposition === 'DENY'; })());
  check('5 eligibility: projects/confidential-client/ is prefix-denied', (() => { const e = el('projects/confidential-client/x.md'); return !e.eligible && e.filter === 'denied'; })());
  check('5 eligibility: templates/ is SKIP, scratch/ is undeclared, research/ is eligible', !el('templates/x.md').eligible && el('scratch/x.md').disposition === 'undeclared' && el('research/x.md').eligible);

  // stage population
  const pop = (id) => stageOf(byId.get(id));
  check('5 population: C, S, O-02, O-03 BUILD; X QUERY; O-01, U, P not in it',
    ['C-01', 'C-06', 'S-01', 'S-04', 'O-02', 'O-03'].every((i) => pop(i) === 'BUILD')
    && ['X-01', 'X-02', 'X-03'].every((i) => pop(i) === 'QUERY')
    && ['O-01', 'U-01', 'U-02', 'P-01', 'N-01'].every((i) => pop(i) === null));

  // BUILD-stage label
  const bExp = { eligible: false, filter: 'namespace', disposition: 'DENY' };
  const bOk = { expected: bExp, sourcePresentAtBuild: true, indexRowsAtTarget: 0, control: { indexedRows: 1, returned: true } };
  check('5 BUILD-WITHHELD needs all four conditions', labelBuildStage(bOk).label === 'BUILD-WITHHELD');
  for (const [name, patch] of Object.entries({
    'source absent at build': { sourcePresentAtBuild: false }, 'index holds target rows': { indexRowsAtTarget: 2 },
    'control not indexed': { control: { indexedRows: 0, returned: true } }, 'control not returned': { control: { indexedRows: 1, returned: false } },
    'target eligible': { expected: { eligible: true } },
  })) check(`5 BUILD: ${name} -> no label, not demonstrated`, (() => { const v = labelBuildStage({ ...bOk, ...patch }); return v.label === null && !v.demonstrated; })());

  // QUERY-stage label, including the freeze review's counterexample.
  const qOk = { expected: bExp, readBack: { present: true, count: 1 }, targetReturned: false, targetRefused: false, control: { returned: true }, delta: 1, seededChunks: 1 };
  check('5 QUERY-WITHHELD: seeded, control returned, absent, delta == seeded', labelQueryStage(qOk).label === 'QUERY-WITHHELD');
  check('5 QUERY: row returned and refused -> RENDER-REFUSED (demonstrated)', (() => { const v = labelQueryStage({ ...qOk, targetReturned: true, targetRefused: true, delta: 0 }); return v.label === 'RENDER-REFUSED' && v.demonstrated; })());
  check('5 QUERY: absent, control returned, delta 0 -> DECLINED-BY-RETRIEVER, not demonstrated', (() => { const v = labelQueryStage({ ...qOk, delta: 0 }); return v.label === 'DECLINED-BY-RETRIEVER' && !v.demonstrated; })());
  check('5 QUERY: an abstention arm that also suppresses its control is not a witness', (() => { const v = labelQueryStage({ ...qOk, delta: 0, control: { returned: false } }); return v.label === null && !v.demonstrated; })());
  check('5 QUERY: seeded row not read back from the input index -> no label', labelQueryStage({ ...qOk, readBack: { present: false, count: 0 } }).label === null);
  check('5 QUERY: delta that is not the seeded count -> no label', labelQueryStage({ ...qOk, delta: 3 }).label === null);

  // mutations
  // MED-3: from git, so the same checks run wherever the self-check is started; if the
  // baseline objects are unavailable the SAME checks fail by name, never vanish.
  const baselineSrc = gitShowText(PRODUCT_TREE, BASELINE_COMMIT, SEARCH_FILE);
  if (baselineSrc === null) {
    for (const n of MUTATION_CHECK_NAMES) check(n, false, 'baseline search-vault.js unavailable: check could not run');
  } else {
    const m = f9Mutate(baselineSrc);
    check('8 F9 removes exactly the two query-stage filter calls', F9_FILTERS.every((f) => baselineSrc.includes(f) && !m.includes(f)) && baselineSrc.length - m.length === F9_FILTERS.reduce((n, f) => n + f.length, 0));
    check('8 F9 leaves the render chokepoint and the directory guard in place', m.includes('namespaceDispositionForPath(NAMESPACE_REGISTRY, r.path)') && m.includes('requireDeclaredNamespaceDirectories(NAMESPACE_REGISTRY, VAULT_ROOT'));
    check('8 F9 is not an identity run: the mutated file no longer hashes to the pin', sha256(m) !== BASELINE_PINS['daemons/semantic-search/search-vault.js']);
    check('8 F9 on a source without the anchor throws', (() => { try { f9Mutate(baselineSrc.replace(F9_FILTERS[0], '')); return false; } catch (e) { return /anchor/.test(e.message); } })());
    const f7 = f7Mutate(baselineSrc);
    check('8 F7 hook: unconditional zero rows plus a bound sidecar, after the results are final', f7.includes('results.length = 0') && f7.includes("invocation: process.env.AIGENT_SEARCH_INVOCATION") && f7.indexOf('results.length = 0') > f7.indexOf(F7_ANCHOR));
    check('8 F7 hook refuses a source that already carries a gate', (() => { try { f7Mutate(f7); return false; } catch (e) { return /already emits/.test(e.message); } })());
  }

  // F7 expected observations, scored on synthetic process output: every positive
  // fails (no rows), every negative is an honest abstention PASS, PC-01 fails.
  const T = 'rec-0123456789abcdef';
  const sidecar = `${ABSTAIN_PREFIX} ${JSON.stringify({ schema: 'abstain/1', invocation: T, outcome: 'abstain', reason: 'below-tau' })}`;
  const absRes = { status: 0, rows: [], abstain: classifyAbstention({ status: 0, rows: [], stderr: sidecar, token: T }) };
  check('8 F7 on synthetic output: negatives PASS as honest abstentions', negativeVerdict({ ...absRes, indexPresent: true }).status === 'pass');
  check('8 F7 on synthetic output: a positive finds no target in zero rows', rankOf({ rows: absRes.rows }, 'x.md') === null);

  // F9 assertions: red on an unmutated-looking run, green on a mutated-looking one.
  const q = (id, label, extra = {}) => ({ id, class: 'stale-index', stage: 'QUERY', status: label === 'DECLINED-BY-RETRIEVER' ? 'fail' : 'pass', label, proof: { readBack: { present: true }, control: { returned: true }, delta: label === 'QUERY-WITHHELD' ? 1 : 0, ...extra } });
  const b = (id, extra = {}) => ({ id, class: 'deny', stage: 'BUILD', status: 'pass', label: 'BUILD-WITHHELD', ...extra });
  const u = [{ id: 'U-01', class: 'undeclared', status: 'pass' }, { id: 'U-02', class: 'undeclared', status: 'pass' }];
  const bp = (id, extra = {}) => b(id, { proof: { sourcePresentAtBuild: true, indexRowsAtTarget: 0, control: { returned: true } }, ...extra });
  const mutatedRun = [q('X-01', 'RENDER-REFUSED'), q('X-02', 'RENDER-REFUSED'), q('X-03', 'RENDER-REFUSED'), bp('C-01'), ...u];
  const allOk = (rows, ref) => f9Assertions(rows, ref).filter((x) => !x.notEvaluated).every((x) => x.ok);
  check('8 F9 assertions: QUERY-WITHHELD present (unmutated) -> RED', !allOk([q('X-01', 'QUERY-WITHHELD'), q('X-02', 'RENDER-REFUSED'), q('X-03', 'RENDER-REFUSED'), bp('C-01'), ...u]));
  check('8 F9 assertions: QUERY-WITHHELD absent, RENDER-REFUSED stands, BUILD and U unchanged -> GREEN', allOk(mutatedRun));
  check('8 F9 assertions: abstention arm (DECLINED-BY-RETRIEVER with control returned) -> GREEN', allOk([q('X-01', 'DECLINED-BY-RETRIEVER'), q('X-02', 'DECLINED-BY-RETRIEVER'), q('X-03', 'DECLINED-BY-RETRIEVER'), bp('C-01'), ...u]));
  check('8 F9 assertions: a QUERY case whose control was suppressed is not a witness -> RED', !allOk([q('X-01', 'RENDER-REFUSED', { control: { returned: false } }), q('X-02', 'RENDER-REFUSED'), q('X-03', 'RENDER-REFUSED'), bp('C-01'), ...u]));
  check('8 F9 assertions: a BUILD case forced red with its control fine -> RED', !allOk([...mutatedRun.slice(0, 3), bp('C-01', { status: 'fail', label: null }), ...u]));
  check('8 F9 assertions: a BUILD case already red unmutated because its control never returned -> GREEN', allOk([...mutatedRun.slice(0, 3), bp('S-01', { status: 'fail', label: null, proof: { sourcePresentAtBuild: true, indexRowsAtTarget: 0, control: { returned: false } } }), ...u]));
  check('8 F9 assertions: U-class forced red -> RED', !allOk([...mutatedRun.slice(0, 4), { ...u[0], status: 'fail' }, u[1]]));
  const refRows = [bp('C-01'), ...u];
  check('8 F9 assertions with a reference: identical BUILD/U -> GREEN, any change -> RED',
    allOk(mutatedRun, refRows) && !allOk([...mutatedRun.slice(0, 3), bp('C-01', { label: null, status: 'fail' }), ...u], refRows) && !allOk([...mutatedRun.slice(0, 4), { ...u[0], status: 'fail' }, u[1]], refRows));
}

// ── self-check: review fixes (MED-1, 2, 4, 5, 6 and LOW-2, 4) ─────────────────
const gitIdentityEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function selfCheckReview(check) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'recollection-selfcheck-tree-'));
  sandboxes.push(tmp);
  // MED-1: the product tree must BE the identity commit: clean, and its committed
  // files hash to the pins, not just the working copies.
  const repo = path.join(tmp, 'repo');
  mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: gitIdentityEnv });
  git('init', '-q');
  const pins = {};
  const labels = [...PINNED_PATHS, 'daemons/memory-hygiene/resume-framing.mjs'];
  for (const l of labels) {
    mkdirSync(path.dirname(path.join(repo, l)), { recursive: true });
    writeFileSync(path.join(repo, l), `content of ${l}\n`);
    if (PINNED_PATHS.includes(l)) pins[l] = fileHash(path.join(repo, l));
  }
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'x');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  check('1b clean tree whose committed files hash to the pins -> no problem', treeIdentityProblems(repo, sha, pins).length === 0, treeIdentityProblems(repo, sha, pins).join('; '));
  writeFileSync(path.join(repo, 'daemons', 'memory-hygiene', 'resume-framing.mjs'), 'edited\n');
  check('1b a dirty UNPINNED import the runtime loads -> refused as dirty', treeIdentityProblems(repo, sha, pins).some((p) => p.includes('dirty')));
  git('checkout', '--', 'daemons/memory-hygiene/resume-framing.mjs');
  writeFileSync(path.join(repo, 'daemons', 'memory-root.sh'), 'edited\n');
  check('1b a dirty PINNED file -> refused as dirty', treeIdentityProblems(repo, sha, pins).some((p) => p.includes('dirty')));
  git('checkout', '--', 'daemons/memory-root.sh');
  check('1b registered pins that the commit does not hold -> refused naming the file',
    treeIdentityProblems(repo, sha, { ...pins, 'daemons/memory-root.cjs': 'f'.repeat(64) }).some((p) => p.includes('committed daemons/memory-root.cjs')));
  check('1b a commit the tree does not have -> refused, never skipped', treeIdentityProblems(repo, 'c'.repeat(40), pins).length > 0);

  // MED-3: the baseline objects come from git, wherever the self-check is run.
  const base = gitShowText(PRODUCT_TREE, BASELINE_COMMIT, SEARCH_FILE);
  check('0 baseline commit objects are available to the self-check (else the F7/F9/pin checks cannot run)', base !== null, `not in ${PRODUCT_TREE}`);
  check('2 committed baseline files hash to the ten pins', treeIdentityProblems(PRODUCT_TREE, BASELINE_COMMIT, BASELINE_PINS).filter((p) => !p.startsWith('dirty')).length === 0,
    treeIdentityProblems(PRODUCT_TREE, BASELINE_COMMIT, BASELINE_PINS).join('; '));

  // MED-2 / I5: a reference is an unmutated, FULL run of THIS identity by THIS instrument,
  // over the whole expected case population, protocol, clock, fixture and runtime identity.
  const H = { corpus_sha256: '1'.repeat(64), overlay_sha256: '2'.repeat(64), fixture_registry_sha256: '3'.repeat(64) };
  const PINS = Object.fromEntries(PINNED_PATHS.map((f, i) => [f, String(i).repeat(64).slice(0, 64)]));
  const ids = ['PC-01', 'P-01', 'P-02', 'N-01'];
  const want = { commit: 'a'.repeat(40), kind: 'baseline', instrumentSha: 'b'.repeat(64), expectedIds: ids, hashes: H, pins: PINS, development: false };
  const good = {
    preregistration: PREREG, packet_sha256: PACKET_SHA256, scenario: 'BASELINE', development_subset: null,
    product_commit: want.commit, identity: { kind: 'baseline' }, instrument_sha256: want.instrumentSha,
    search_now: { frozen: FROZEN_NOW, temporal_class: FROZEN_NOW }, hashes: { ...H },
    runtime_hashes_pinned: PINS, runtime_hash_mismatch: [], runtime_hash_pin_drift: [], harness_errors: [],
    cases: ids.map((id) => ({ id, status: 'fail', class: 'x' })),
  };
  check('2b a full unmutated same-identity same-instrument reference is accepted, red cases and all', validateReference(good, want) === null, String(validateReference(good, want)));
  for (const [name, patch] of Object.entries({
    'an F-scenario packet': { scenario: 'F9' }, 'a development subset': { development_subset: ['P-01'] },
    'another product commit': { product_commit: 'c'.repeat(40) }, 'another identity kind': { identity: { kind: 'candidate' } },
    'another instrument': { instrument_sha256: 'd'.repeat(64) }, 'no cases': { cases: undefined },
    'a TRUNCATED population (the one-case packet the review reproduced)': { cases: [{ id: 'P-01' }] },
    'a population missing one expected id': { cases: good.cases.slice(0, 3) },
    'a DUPLICATE case id (right length, wrong population)': { cases: [...good.cases.slice(0, 3), good.cases[0]] },
    'every expected id PLUS one repeat (only the duplicate check can refuse it)': { cases: [...good.cases, good.cases[1]] },
    'an id outside the population': { cases: [...good.cases.slice(0, 3), { id: 'Z-99' }] },
    'a wrong frozen clock': { search_now: { frozen: '2026-01-01T00:00:00Z', temporal_class: FROZEN_NOW } },
    'a wrong temporal-class clock': { search_now: { frozen: FROZEN_NOW, temporal_class: '2026-05-01T00:00:00Z' } },
    'no clock at all': { search_now: undefined },
    'a wrong packet_sha256': { packet_sha256: 'e'.repeat(64) },
    'a wrong protocol': { preregistration: 'recollection-44/PREREG-001' },
    'another corpus hash': { hashes: { ...H, corpus_sha256: '9'.repeat(64) } },
    'another fixture-registry hash': { hashes: { ...H, fixture_registry_sha256: '9'.repeat(64) } },
    'a reported runtime pin mismatch': { runtime_hash_mismatch: [{ file: 'x' }] },
    'reported pin drift': { runtime_hash_pin_drift: [{ file: 'x' }] },
    'other pins than this identity': { runtime_hashes_pinned: { ...PINS, 'daemons/memory-root.sh': 'f'.repeat(64) } },
  })) check(`2b reference refused: ${name}`, validateReference({ ...good, ...patch }, want) !== null);
  check('2b an unreadable reference is refused', validateReference(null, want) !== null);
  check('2b a reference packet carrying harness errors is refused', validateReference({ ...good, harness_errors: ['x'] }, want) !== null);
  // The narrower comparison is its own labelled mode and never a full reference.
  const dev = { ...want, development: true };
  const devRef = { ...good, development_subset: ['P-01', 'N-01'], cases: [{ id: 'P-01', status: 'pass' }, { id: 'N-01', status: 'fail' }] };
  check('2b development comparison: a subset packet is accepted ONLY in the labelled development mode', validateReference(devRef, dev) === null && validateReference(devRef, want) !== null, String(validateReference(devRef, dev)));
  check('2b development comparison still refuses duplicates, unknown ids, a wrong clock and a wrong packet',
    validateReference({ ...devRef, cases: [devRef.cases[0], devRef.cases[0]] }, dev) !== null
    && validateReference({ ...devRef, cases: [{ id: 'Z-99' }] }, dev) !== null
    && validateReference({ ...devRef, search_now: { frozen: 'x', temporal_class: 'x' } }, dev) !== null
    && validateReference({ ...devRef, packet_sha256: 'e'.repeat(64) }, dev) !== null);
  check('2b the development comparison reads as narrower in the F9 assertions, never as a full reference', (() => {
    const named = f9Assertions([{ id: 'C-01', class: 'deny', stage: 'BUILD', status: 'pass', label: 'BUILD-WITHHELD' }], [{ id: 'C-01', status: 'pass', label: 'BUILD-WITHHELD' }], true);
    return named.some((x) => /development comparison/i.test(x.name) && /narrower/i.test(x.name)) && !named.some((x) => /equal the unmutated reference run/.test(x.name));
  })());
  writeFileSync(path.join(repo, 'daemons', 'zz-untracked.txt'), 'x\n');
  check('1b an UNTRACKED file under daemons/ -> refused as dirty', treeIdentityProblems(repo, sha, pins).some((p) => p.includes('dirty') && p.includes('zz-untracked')));
  rmSync(path.join(repo, 'daemons', 'zz-untracked.txt'));

  // MED-5 / LOW-4 / I4 / R2: registration of the instrument and of the protocol
  // packet is exercised in selfCheckIdentity (full 1.7 record, withdrawn vs absent).

  // MED-6: a results block that parses but is not an array is a FAIL, not a crash.
  const nonArray = interpretSearch({ status: 0, stdout: 'Loading index... 1 entries loaded.\n\nQuery: "q"\n\nJSON:\n{}\n', stderr: '' }, 'q', 'rec-0123456789abcdef', FROZEN_NOW);
  check('6 non-array results block -> rows null with a parse error', nonArray.rows === null && /not an array/.test(nonArray.parseError || ''));
  check('6 ... and the negative verdict FAILs instead of throwing', (() => { try { return negativeVerdict({ status: 0, rows: nonArray.rows, abstain: nonArray.abstain, indexPresent: true }).status === 'fail'; } catch { return false; } })());

  // LOW-2: the sidecar framing is exact.
  const T = 'rec-0123456789abcdef';
  const ok = { schema: 'abstain/1', invocation: T, outcome: 'abstain', reason: 'below-tau' };
  const framed = (text) => classifyAbstention({ status: 0, rows: [], stderr: text, token: T }).state;
  check('4c exact compact framing is honest', framed(`${ABSTAIN_PREFIX} ${JSON.stringify(ok)}`) === 'honest');
  const compact = JSON.stringify(ok);
  check('4c valid non-compact single-line JSON (spaces after : and ,) is honest', framed(`${ABSTAIN_PREFIX} ${JSON.stringify(ok, null, 1).replace(/\n\s*/g, ' ')}`) === 'honest');
  check('4c a doubled-key line stays rejected even when non-compact', framed(`${ABSTAIN_PREFIX} {"schema": "abstain/1", "invocation": "x", "outcome": "abstain", "reason": "below-tau", "invocation": "${T}"}`) === 'rejected');
  check('4c a multi-line JSON object is rejected', framed(`${ABSTAIN_PREFIX} {\n"schema":"abstain/1",\n"invocation":"${T}",\n"outcome":"abstain",\n"reason":"below-tau"}`) === 'rejected');
  check('4c an extra key is rejected', framed(`${ABSTAIN_PREFIX} ${JSON.stringify({ ...ok, extra: 1 })}`) === 'rejected');
  check('4c a double space after the prefix is malformed', framed(`${ABSTAIN_PREFIX}  ${JSON.stringify(ok)}`) === 'rejected');
  // R1: an ESCAPED duplicate key decodes to a name already present.
  const escDup = `${ABSTAIN_PREFIX} {"schema":"abstain/1","invocation":"rec-other000000","outcome":"abstain","reason":"below-tau","\\u0069nvocation":"${T}"}`;
  check('4c R1 an escaped duplicate key ("\\u0069nvocation" carrying the bound token) is malformed, not honest', framed(escDup) === 'rejected' && classifyAbstention({ status: 0, rows: [], stderr: escDup, token: T }).detail === 'abstention-sidecar-malformed', framed(escDup));
  check('4c R1 an escaped duplicate of another key (schema) is malformed too', framed(`${ABSTAIN_PREFIX} {"schema":"abstain/1","invocation":"${T}","outcome":"abstain","reason":"below-tau","\\u0073chema":"abstain/1"}`) === 'rejected');
  check('4c R1 four distinct keys written with escapes are still honest', framed(`${ABSTAIN_PREFIX} {"\\u0073chema":"abstain/1","invocation":"${T}","outcome":"abstain","reason":"below-tau"}`) === 'honest');
  check('4c a duplicate key (replayed token then bound token) is malformed', framed(`${ABSTAIN_PREFIX} {"schema":"abstain/1","invocation":"rec-other000000","outcome":"abstain","reason":"below-tau","invocation":"${T}"}`) === 'rejected');
}

// ── self-check: the REAL finalization (I1), driven with synthetic case records ─
// finalizeRun() is what main calls; exitCodeFor() is what main exits with.
function selfCheckFinalizer(check) {
  const green = () => cases.map((c) => ({ id: c.id, class: c.class, status: 'pass', detail: '' }));
  const set = (rs, id, patch) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r));
  const failOn = (rs, ids) => ids.reduce((acc, id) => set(acc, id, { status: 'fail' }), rs);
  const idsOf = (klass) => cases.filter((c) => c.class === klass).map((c) => c.id);
  const fin = (o = {}) => finalizeRun({
    results: green(), cases, spec: SCENARIOS.BASELINE, scenario: 'BASELINE', inversions: [], harnessErrors: [],
    policyFalsePositives: [], budgetBreaches: [], pinDrift: [], referenceRows: null, referenceDev: false, ran: true, only: null, ...o,
  });
  const term = (o) => { const f = fin(o); return `${f.terminal}/${exitCodeFor(f.terminal)}`; };

  check('3f exit code: PASS is 0, every other terminal is non-zero', exitCodeFor('PASS') === 0 && ['FAIL', 'UNRUNNABLE', 'HARNESS-ERROR', 'PASS (development subset, not a result)'].every((t) => exitCodeFor(t) === 1));
  check('3f all classes green, PC-01 pass -> PASS, exit 0', term() === 'PASS/0', term());
  // I1a: a permitted case miss inside a met class gate is NOT a run FAIL.
  check('3f I1a positive 23/24 (gate >= 22) with every other gate met -> PASS, not a silent 100 percent', term({ results: failOn(green(), [idsOf('positive')[0]]) }) === 'PASS/0', term({ results: failOn(green(), [idsOf('positive')[0]]) }));
  check('3f I1a positive 22/24 (the gate exactly) -> PASS', term({ results: failOn(green(), idsOf('positive').slice(0, 2)) }) === 'PASS/0');
  check('3f I1a negative 11/12, temporal 7/8 (inversion-free) are also inside their gates -> PASS', term({ results: failOn(green(), [idsOf('negative')[0], idsOf('temporal')[0]]) }) === 'PASS/0');
  check('3f positive 21/24 misses its gate -> FAIL naming the class', (() => { const f = fin({ results: failOn(green(), idsOf('positive').slice(0, 3)) }); return f.terminal === 'FAIL' && f.terminalBasis.some((b) => b.includes('positive')); })());
  check('3f negative 10/12 misses its gate -> FAIL', term({ results: failOn(green(), idsOf('negative').slice(0, 2)) }) === 'FAIL/1');
  check('3f a zero-tolerance class (DENY 5/6) misses its gate -> FAIL', term({ results: failOn(green(), [idsOf('deny')[0]]) }) === 'FAIL/1');
  check('3f temporal 8/8 with one inversion misses the zero-inversion gate -> FAIL', term({ inversions: [{ id: 'T-02' }] }) === 'FAIL/1');
  check('3f a leak (policy false positive) is fatal whatever the gates say -> FAIL', term({ policyFalsePositives: [{ id: 'C-01' }] }) === 'FAIL/1');
  check('3f a budget breach is fatal -> FAIL', term({ budgetBreaches: [{ id: 'P-01', breaches: ['x'] }] }) === 'FAIL/1');
  check('3f PC-01 red is fatal even with every class gate met -> FAIL', term({ results: failOn(green(), ['PC-01']) }) === 'FAIL/1');
  check('3f harness errors -> HARNESS-ERROR', term({ harnessErrors: ['x'] }) === 'HARNESS-ERROR/1');
  check('3f pin drift on an otherwise green run -> UNRUNNABLE', term({ pinDrift: [{ file: 'x' }] }) === 'UNRUNNABLE/1');
  check('3f a FAIL is never masked by pin drift (5.3)', term({ pinDrift: [{ file: 'x' }], results: failOn(green(), idsOf('deny').slice(0, 1)) }) === 'FAIL/1');
  check('3f an unrunnable class with no failure -> UNRUNNABLE, not FAIL', term({ results: green().map((r) => (r.class === 'negative' ? { ...r, status: 'unrunnable', requires: 'x' } : r)) }) === 'UNRUNNABLE/1');
  check('3f a development subset is never a result', fin({ only: new Set(['P-01']) }).terminal.endsWith('(development subset, not a result)'));

  // I1b: a failed expectation in an actually EXECUTED falsifier invalidates the run.
  const f9rows = (label, delta) => green().map((r) => {
    if (r.class === 'stale-index') return { ...r, stage: 'QUERY', label, proof: { readBack: { present: true }, control: { returned: true }, delta } };
    if (r.class === 'deny' || r.class === 'skip' || (r.class === 'operator' && ['skip', 'deny'].includes((byId.get(r.id) || {}).kind))) {
      return { ...r, stage: 'BUILD', label: 'BUILD-WITHHELD', proof: { sourcePresentAtBuild: true, indexRowsAtTarget: 0, control: { returned: true } } };
    }
    return r;
  });
  const f9 = (rows, o = {}) => fin({ results: rows, spec: SCENARIOS.F9, scenario: 'F9', ...o });
  const fullRef = f9rows('RENDER-REFUSED', 0).filter((r) => r.stage === 'BUILD' || r.class === 'undeclared').map((r) => ({ id: r.id, status: r.status, label: r.label ?? null }));
  const survived = f9(f9rows('QUERY-WITHHELD', 1), { referenceRows: fullRef });
  check('3f I1b F9 with a surviving QUERY-WITHHELD label (everything else green) -> expectation false, terminal NOT PASS, non-zero exit',
    survived.expectedRedHolds === false && survived.falsifierInvalid === true && survived.terminal !== 'PASS' && exitCodeFor(survived.terminal) === 1 && survived.terminalBasis.some((b) => /falsifier/.test(b)), JSON.stringify([survived.terminal, survived.expectedRedHolds, survived.terminalBasis]));
  const held = f9(f9rows('RENDER-REFUSED', 0), { referenceRows: fullRef });
  check('3f I1b F9 with its expected observation, judged against a FULL reference, holds and is not punished -> PASS, exit 0', held.expectedRedHolds === true && held.falsifierInvalid === false && held.terminal === 'PASS', JSON.stringify([held.terminal, held.expectedRedHolds, held.scenarioAssertions.filter((a) => !a.ok)]));
  // R4-LOW-3: without a full same-method reference, "BUILD and U unchanged" is NOT-EVALUATED.
  for (const [name, o] of [['no reference', {}], ['a development reference', { referenceRows: fullRef, referenceDev: true }]]) {
    const r = f9(f9rows('RENDER-REFUSED', 0), o);
    check(`3f R4-LOW-3 F9 with ${name}: the BUILD/U-unchanged expectation is NOT-EVALUATED, the falsifier does not read as passed (terminal not PASS, not held)`,
      r.expectedRedHolds === false && r.falsifierInvalid === false && r.terminal === 'UNRUNNABLE' && r.scenarioAssertions.some((a) => a.notEvaluated) && r.terminalBasis.some((b) => /not-evaluated/.test(b)), JSON.stringify([r.terminal, r.expectedRedHolds, r.terminalBasis]));
  }
  // Missing preconditions and unexecuted mutations are accounted separately.
  const unexec = fin({ spec: SCENARIOS.F7, scenario: 'F7', ran: false, results: green().map((r) => ({ ...r, status: 'unrunnable', requires: 'PREREG-002 F7 — abstention gate absent' })) });
  check('3f I1b an UNEXECUTED mutation (F7, no gate) is UNRUNNABLE, never a falsifier-invalid FAIL', unexec.terminal === 'UNRUNNABLE' && unexec.falsifierInvalid === false, JSON.stringify([unexec.terminal, unexec.falsifierInvalid]));
  const noDoctor = f9(f9rows('RENDER-REFUSED', 0).map((r) => (r.class === 'undeclared' ? { ...r, status: 'unrunnable', requires: 'PREREG-002 4.3 (item 4)' } : r)), { referenceRows: fullRef });
  check('3f I1b F9 whose U-class could not run (missing prerequisite), its other expectations held -> UNRUNNABLE, not a failed expectation', noDoctor.terminal === 'UNRUNNABLE' && noDoctor.falsifierInvalid === false && noDoctor.expectedRedHolds === false, JSON.stringify([noDoctor.terminal, noDoctor.falsifierInvalid]));
  const noDoctorBlind = f9(f9rows('QUERY-WITHHELD', 1).map((r) => (r.class === 'undeclared' ? { ...r, status: 'unrunnable', requires: 'PREREG-002 4.3 (item 4)' } : r)), { referenceRows: fullRef });
  check('3f R4-MED-1 F9 with U unrunnable AND a surviving QUERY-WITHHELD: the missing U does not hide the blind falsifier -> FAIL, invalid', noDoctorBlind.falsifierInvalid === true && noDoctorBlind.terminal === 'FAIL', JSON.stringify([noDoctorBlind.terminal, noDoctorBlind.falsifierInvalid]));

  // R4-MED-1: a case deliberately NOT PART OF a scenario is not-applicable, not UNRUNNABLE.
  const naU = (rs) => rs.map((r) => (r.class === 'undeclared' ? { ...r, status: 'not-applicable', detail: 'not part of this mutation' } : r));
  const blindF1 = fin({ spec: SCENARIOS.F1, scenario: 'F1', results: naU(green()) });
  check('3f R4-MED-1 F1 executed, U not-applicable, P-07 NOT red (blind falsifier) -> benchmark FAIL naming the missing red, never UNRUNNABLE',
    blindF1.terminal === 'FAIL' && blindF1.falsifierInvalid === true && exitCodeFor(blindF1.terminal) === 1 && blindF1.terminalBasis.some((b) => /falsifier-expectation-failed/.test(b)) && !blindF1.terminalBasis.some((b) => /unrunnable/.test(b)) && blindF1.expectedRedObserved.some((r) => r.id === 'P-07' && r.observed === 'pass'), JSON.stringify([blindF1.terminal, blindF1.terminalBasis]));
  const goodF1 = fin({ spec: SCENARIOS.F1, scenario: 'F1', results: naU(failOn(green(), ['P-07'])) });
  check('3f R4-MED-1 F1 with P-07 red: expectation holds, not-applicable U is recorded as such and is neither a gate miss nor unrunnable',
    goodF1.expectedRedHolds === true && goodF1.falsifierInvalid === false && goodF1.classReport.find((c) => c.class === 'undeclared').status === 'NOT-APPLICABLE' && goodF1.terminal === 'PASS', JSON.stringify([goodF1.terminal, goodF1.classReport.find((c) => c.class === 'undeclared')]));
  const blindF3 = fin({ spec: SCENARIOS.F3, scenario: 'F3', results: naU(green()) });
  check('3f R4-MED-1 F3 executed, T-03 not inverted -> invalid', blindF3.falsifierInvalid === true && blindF3.terminal === 'FAIL');
  const blindF8 = fin({ spec: SCENARIOS.F8, scenario: 'F8', results: naU(green()) });
  check('3f R4-MED-1 F8 executed, temporal NOT red -> invalid', blindF8.falsifierInvalid === true && blindF8.terminal === 'FAIL');
  const blindF6 = fin({ spec: SCENARIOS.F6, scenario: 'F6', results: naU(green().map((r) => (r.class === 'negative' ? { ...r, status: 'unrunnable', requires: 'x' } : r))) });
  check('3f R4-MED-1 F6 executed, PC-01 passing (index not really dead) -> invalid', blindF6.falsifierInvalid === true && blindF6.terminal === 'FAIL');
  const blindF2 = fin({ spec: SCENARIOS.F2, scenario: 'F2', results: naU(green()) });
  const blindF4 = fin({ spec: SCENARIOS.F4, scenario: 'F4', results: naU(failOn(green(), ['C-02'])) });
  check('3f R4-MED-1 F2 blind (N-04 not red) -> invalid; F4 whose C-02 stays NOT pass -> invalid', blindF2.falsifierInvalid === true && blindF4.falsifierInvalid === true);

  // R4-MED-2: F5 runs PC-01 and scores it behaviorally; the quality cases are UNRUNNABLE; U reports its refusal.
  const f5res = (pc) => green().map((r) => {
    if (r.id === 'PC-01') return { ...r, ...pc };
    return r.class === 'undeclared' ? r : { ...r, status: 'unrunnable', requires: 'PREREG-001 6 F5' };
  });
  const f5 = fin({ spec: SCENARIOS.F5, scenario: 'F5', results: f5res({ status: 'fail', detail: 'search exited 1' }) });
  check('3f R4-MED-2 F5: PC-01 executed and a non-zero exit is a behavioral FAIL (terminal FAIL), quality UNRUNNABLE, U pass -> its expectations hold', f5.expectedRedHolds === true && f5.falsifierInvalid === false && f5.terminal === 'FAIL' && !SCENARIOS.F5.unrunnableClasses.includes('positive-control'), JSON.stringify([f5.terminal, f5.expectedRedHolds, f5.expectedRedObserved]));
  const f5old = fin({ spec: SCENARIOS.F5, scenario: 'F5', results: f5res({ status: 'unrunnable', requires: 'PREREG-001 6 F5 — coverage red' }) });
  check('3f R4-MED-2 F5: a PC-01 recorded UNRUNNABLE without being run does not satisfy the F5 expectation', f5old.expectedRedHolds === false);
  const f5ran = fin({ spec: SCENARIOS.F5, scenario: 'F5', results: f5res({ status: 'pass' }) });
  check('3f R4-MED-2 F5: PC-01 passing under a dirty registry (the mutation did not bite) -> invalid', f5ran.falsifierInvalid === true);

  // R4-LOW-1: the finalizer validates the population against the frozen case list.
  const popTerm = (rs) => { const he = []; const f = fin({ results: rs, harnessErrors: he }); return `${f.terminal}/${he.length}`; };
  check('3f R4-LOW-1 two positive cases missing from the results -> HARNESS-ERROR, never PASS', popTerm(green().filter((r) => !idsOf('positive').slice(0, 2).includes(r.id))) === 'HARNESS-ERROR/1');
  check('3f R4-LOW-1 PC-01 missing from the results -> HARNESS-ERROR', popTerm(green().filter((r) => r.id !== 'PC-01')) === 'HARNESS-ERROR/1');
  check('3f R4-LOW-1 a duplicate pass record padding a class -> HARNESS-ERROR', popTerm([...green().filter((r) => r.id !== idsOf('positive')[0]), { ...green().find((r) => r.id === idsOf('positive')[1]) }]) === 'HARNESS-ERROR/1');
  // R5-LOW-1: not-applicable (or any unknown status) only where the scenario spec declares it.
  const naTerm = (o, mapper) => { const he = []; const f = fin({ results: mapper(green()), harnessErrors: he, ...o }); return `${f.terminal}/${he.length}`; };
  const mark = (pred, status = 'not-applicable') => (rs) => rs.map((r) => (pred(r) ? { ...r, status } : r));
  check('3f R5-LOW-1 BASELINE: DENY 6/6 not-applicable -> HARNESS-ERROR, never PASS', naTerm({}, mark((r) => r.class === 'deny')) === 'HARNESS-ERROR/1');
  check('3f R5-LOW-1 BASELINE: PC-01 not-applicable -> HARNESS-ERROR', naTerm({}, mark((r) => r.id === 'PC-01')) === 'HARNESS-ERROR/1');
  check('3f R5-LOW-1 BASELINE: U-01/U-02 not-applicable (a baseline or candidate identity run declares none) -> HARNESS-ERROR', naTerm({}, mark((r) => r.class === 'undeclared')) === 'HARNESS-ERROR/1');
  check('3f R5-LOW-1 BASELINE: positive 22 pass + 2 not-applicable -> HARNESS-ERROR', naTerm({}, mark((r) => idsOf('positive').slice(0, 2).includes(r.id))) === 'HARNESS-ERROR/1');
  check('3f R5-LOW-1 an unknown status ("skipped") on a class member -> HARNESS-ERROR', naTerm({}, mark((r) => r.id === idsOf('positive')[0], 'skipped')) === 'HARNESS-ERROR/1');
  check('3f R5-LOW-1 F1 declares U-01/U-02 not-applicable: that is accepted; any other id is not', naTerm({ spec: SCENARIOS.F1, scenario: 'F1' }, (rs) => mark((r) => r.class === 'undeclared')(failOn(rs, ['P-07']))) === 'PASS/0'
    && naTerm({ spec: SCENARIOS.F1, scenario: 'F1' }, (rs) => mark((r) => r.class === 'deny')(failOn(rs, ['P-07']))) === 'HARNESS-ERROR/1');
  check('3f R5-LOW-1 F9 declares no not-applicable ids: U-01/U-02 not-applicable -> HARNESS-ERROR', naTerm({ spec: SCENARIOS.F9, scenario: 'F9' }, mark((r) => r.class === 'undeclared')) === 'HARNESS-ERROR/1');
  check('3f R5-LOW-1 the scenario table declares the not-applicable set for exactly the runU:false scenarios', Object.entries(SCENARIOS).every(([, sp]) => (sp.runU ? !(sp.notApplicable || []).length : (sp.notApplicable || []).join() === 'U-01,U-02')));
  // R5-LOW-2: BUILD-stage unchanged and U-class unchanged are two expectations.
  const buildRed = f9(f9rows('RENDER-REFUSED', 0).map((r) => (r.id === 'C-01' ? { ...r, status: 'fail', label: null } : r.class === 'undeclared' ? { ...r, status: 'unrunnable', requires: 'PREREG-002 4.3 (item 4)' } : r)), { referenceRows: fullRef });
  check('3f R5-LOW-2 F9 with a full reference, U unrunnable and a BUILD case turned red -> the BUILD expectation is judged: invalid', buildRed.falsifierInvalid === true && buildRed.terminalBasis.some((b) => /BUILD-stage results equal/.test(b)), JSON.stringify([buildRed.terminal, buildRed.falsifierInvalid]));
  check('3f R5-LOW-1 an id outside the frozen list -> HARNESS-ERROR; the exact population -> PASS', popTerm([...green(), { id: 'Z-99', class: 'positive', status: 'pass' }]) === 'HARNESS-ERROR/1' && popTerm(green()) === 'PASS/0');
  check('3f a BASELINE is never a falsifier: its own PC-01 miss is the PC-01 rule, not an expectation failure', fin({ results: failOn(green(), ['PC-01']) }).falsifierInvalid === false);
}

// ── self-check: QUERY-delta computation and control accounting (MED-4) ──────
// A stub stands in for search-vault.js / embed-vault.js so the REAL runQueryStage,
// finishQueryStage and auxBuildControl run against a controlled index: a stub
// prints the load line with the namespace-filtered count, returns the kept rows
// with their chunk text, and logs a hash of every embedding it was handed.
const STUB_SEARCH = [
  "const fs = require('fs'), path = require('path'), crypto = require('crypto');",
  "const idx = JSON.parse(fs.readFileSync(path.join(process.env.AIGENT_VAULT_ROOT, 'memory', 'embeddings.json'), 'utf8'));",
  "const keep = idx.notes.filter((n) => !n.path.startsWith('ops-deny/'));",
  "const dropped = idx.notes.length - keep.length;",
  "keep.sort((a, b) => (b.path.includes('recollection-control') ? 1 : 0) - (a.path.includes('recollection-control') ? 1 : 0));",
  "fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify({ rows: idx.notes.map((n) => ({ path: n.path, emb: crypto.createHash('sha256').update(JSON.stringify(n.embedding)).digest('hex') })) }) + '\\n');",
  "console.log('Loading index... ' + keep.length + ' entries loaded.' + (dropped ? ' (' + dropped + ' non-INDEX namespace chunk(s) filtered by namespace-registry.json)' : ''));",
  "console.log('\\nQuery: \"q\"\\n');",
  "console.log('\\nJSON:');",
  // STUB_SIDECAR: an empty results block plus the named sidecar defect on stderr.
  "const mode = process.env.STUB_SIDECAR || '';",
  "const side = (o) => console.error('AIGENT_ABSTAIN ' + JSON.stringify({ schema: 'abstain/1', invocation: process.env.AIGENT_SEARCH_INVOCATION, outcome: 'abstain', reason: 'below-tau', ...o }));",
  "console.log(JSON.stringify(mode ? [] : keep.slice(0, 5).map((n) => ({ path: n.path, title: n.title, score: 0.9, chunk: n.chunk })), null, 2));",
  "if (mode === 'malformed') console.error('AIGENT_ABSTAIN {nope');",
  "else if (mode === 'duplicate') { side({}); side({}); }",
  "else if (mode === 'unknown') side({ reason: 'because' });",
  "else if (mode === 'unbound') side({ invocation: 'rec-ffffffffffffffff' });",
  // STUB_CTL_FAIL: a permitted control prints its row and THEN exits non-zero.
  "if (process.env.STUB_CTL_FAIL && idx.notes.some((n) => n.path.includes('recollection-control'))) process.exitCode = 1;",
].join('\n');
const STUB_EMBED = [
  "const fs = require('fs'), path = require('path');",
  "const vault = process.env.AIGENT_VAULT_ROOT, notes = [];",
  "(function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) { if (r !== 'memory') walk(path.join(d, e.name), r); } else if (e.name.endsWith('.md') && !r.startsWith('ops-deny/')) notes.push({ path: r, title: e.name, tags: [], chunk: fs.readFileSync(path.join(d, e.name), 'utf8').slice(0, 500), embedding: [1, 2, 3], mtime: 0 }); } })(vault, '');",
  "fs.mkdirSync(path.join(vault, 'memory'), { recursive: true });",
  "fs.writeFileSync(path.join(vault, 'memory', 'embeddings.json'), JSON.stringify({ notes, entryCount: notes.length }));",
].join('\n');

// R2-LOW-2: the main path calls the functions above; spawn the runner against a
// local clone of the product at the baseline (no model: every one of these runs
// stops before a sandbox, on a refusal, a harness error or an environment gap).
function selfCheckWiring(check) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'recollection-selfcheck-wire-'));
  sandboxes.push(tmp);
  const clone = path.join(tmp, 'clone');
  const cl = spawnSync('git', ['clone', '-q', '--no-checkout', PRODUCT_TREE, clone], { encoding: 'utf8', env: gitIdentityEnv });
  const co = spawnSync('git', ['-C', clone, 'checkout', '-q', BASELINE_COMMIT], { encoding: 'utf8', env: gitIdentityEnv });
  // The instrument under test, copied into its OWN repo and committed, so the
  // registered instrument_commit is verified by git, not assumed.
  const instRepo = path.join(tmp, 'inst');
  cpSync(HERE, path.join(instRepo, 'evals', 'recollection'), { recursive: true, filter: (src) => path.basename(src) !== 'results' });
  const ig = (...a) => spawnSync('git', ['-C', instRepo, ...a], { encoding: 'utf8', env: gitIdentityEnv });
  ig('init', '-q');
  ig('add', '-A');
  ig('commit', '-q', '--no-verify', '-m', 'instrument');
  const instCommit = ig('rev-parse', 'HEAD').stdout.trim();
  const instFile = path.join(instRepo, 'evals', 'recollection', 'run-recollection.mjs');
  const ready = cl.status === 0 && co.status === 0 && /^[0-9a-f]{40}$/.test(instCommit);
  check('0 wiring: a local clone at the baseline commit and a committed instrument copy could be made', ready, `${cl.stderr || ''}${co.stderr || ''}`.slice(0, 160));
  const names = ['wiring: a dirty product tree reaches the identity refusal', 'wiring: an invalid --reference reaches a harness error',
    'wiring: identity_run is true only with the full 1.7 record', 'wiring: an unregistered instrument is not an identity run',
    'wiring: an incomplete record is incomplete in the packet, not registered', 'wiring: a withdrawn record reads withdrawn in the packet, not absent',
    'wiring: the finalizer reaches the exit code (refused run is non-zero) and the packet states the claim limits', 'wiring: a truncated --reference is refused through the real call site'];
  if (!ready) { for (const n of names) check(n, false, 'no clone'); return; }
  const run = (args) => {
    const r = spawnSync(process.execPath, [instFile, '--product-tree', clone, '--json', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try { return { ...JSON.parse(r.stdout), _exit: r.status }; } catch { return { parseFailure: (r.stderr || '').slice(0, 200), _exit: r.status }; }
  };
  const env = { os: os.platform(), node: process.version, bash: bashProbe().resolved, model: 'Xenova/all-MiniLM-L6-v2' };
  const instSha = fileHash(instFile);
  const record = (o = {}) => registrationText({ id: 'B-001', commit: BASELINE_COMMIT, pins: BASELINE_PINS, instrumentSha: instSha, instrumentCommit: instCommit, env, ...o });
  const file = (name, text) => { const f = path.join(tmp, name); writeFileSync(f, text); return f; };
  const reg = file('reg.md', record());
  const none = file('none.md', 'nothing registered\n');
  const incomplete = file('incomplete.md', record({ omit: ['instrument_commit', 'environment_os'] }));
  const withdrawn = file('withdrawn.md', `${record()}candidate_id: B-002\nwithdraws: B-001\n`);
  const refFile = file('ref.json', JSON.stringify({ scenario: 'F9', cases: [{ id: 'x' }] }));
  // Everything valid except the population: only the truncation can refuse it.
  const truncated = file('truncated.json', JSON.stringify({
    preregistration: PREREG, packet_sha256: PACKET_SHA256, scenario: 'BASELINE', development_subset: null, product_commit: BASELINE_COMMIT,
    identity: { kind: 'baseline' }, instrument_sha256: instSha, search_now: { frozen: FROZEN_NOW, temporal_class: FROZEN_NOW },
    hashes: { corpus_sha256: corpusHash, overlay_sha256: overlayHash, fixture_registry_sha256: fixtureHash },
    runtime_hashes_pinned: BASELINE_PINS, runtime_hash_mismatch: [], runtime_hash_pin_drift: [], harness_errors: [], cases: [{ id: 'P-01' }],
  }));
  const clean = run(['--candidates', reg]);
  const withRef = run(['--candidates', reg, '--reference', refFile]);
  const withTrunc = run(['--candidates', reg, '--reference', truncated]);
  const unreg = run(['--candidates', none]);
  const inc = run(['--candidates', incomplete]);
  const wd = run(['--candidates', withdrawn]);
  writeFileSync(path.join(clone, 'daemons', 'zz-untracked.txt'), 'x\n');
  const dirty = run(['--candidates', reg]);
  check(names[0], dirty.identity && dirty.identity.kind === 'REFUSED' && /dirty/.test(dirty.identity.refused || ''), JSON.stringify(dirty.identity || dirty));
  check(names[1], (withRef.harness_errors || []).some((e) => e.includes('--reference refused')), JSON.stringify(withRef.harness_errors || withRef));
  check(names[2], clean.identity_run === true && clean.instrument_registered === true && clean.registration && clean.registration?.state === 'registered' && clean.registration?.record?.instrument_commit === instCommit, JSON.stringify([clean.identity_run, clean.instrument_registered, clean.registration, clean.parseFailure]));
  check(names[3], unreg.identity_run === false && unreg.instrument_registered === false && unreg.registration && unreg.registration?.state === 'absent', JSON.stringify([unreg.identity_run, unreg.instrument_registered, unreg.registration, unreg.parseFailure]));
  check(names[4], inc.identity_run === false && inc.instrument_registered === false && inc.registration && inc.registration?.state === 'incomplete' && inc.registration?.problems.join(';').includes('instrument_commit'), JSON.stringify([inc.registration, inc.parseFailure]));
  check(names[5], wd.identity_run === false && wd.registration && wd.registration?.state === 'withdrawn', JSON.stringify([wd.registration, wd.parseFailure]));
  check(names[6], dirty._exit === 1 && dirty.terminal === 'UNRUNNABLE' && Array.isArray(dirty.terminal_basis) && Array.isArray(dirty.claims_limits) && dirty.claims_limits.length === CLAIM_LIMITS.length && dirty.claims_limits.some((l) => /F7/.test(l) && /NOT executable/.test(l)), JSON.stringify([dirty._exit, dirty.terminal, dirty.terminal_basis, dirty.claims_limits]));
  check(names[7], (withTrunc.harness_errors || []).some((e) => e.includes('--reference refused') && /population|missing/i.test(e)), JSON.stringify(withTrunc.harness_errors || withTrunc));
  // The dirty file was only for the refusal check; the stubbed candidate needs a clean tree.
  rmSync(path.join(clone, 'daemons', 'zz-untracked.txt'), { force: true });
  selfCheckWiringScored(check, { tmp, clone, instFile, instCommit, run, file });
}

// R5-LOW-3: the round-4 fixes live in main, which only a spawned runner reaches.
// A stubbed CANDIDATE product (search/embed stubs, a fake transformers package, a
// registered record with its own pins) lets the real runner score F1, F5, the
// BASELINE and F9 end to end with no model. Runs below assert main's own wiring:
// U not-applicable (never UNRUNNABLE) where a scenario excludes it, F5 running
// PC-01, and the F9 reference mode.
function selfCheckWiringScored(check, ctx) {
  const { tmp, clone, instFile, instCommit, run, file } = ctx;
  const names = ['wiring: F1 records U-01/U-02 not-applicable (not UNRUNNABLE) and the blind-falsifier verdict can fire',
    'wiring: F5 RUNS PC-01 (a behavioral FAIL on the observed non-zero exit), quality UNRUNNABLE, U scored',
    'wiring: F9 reference mode is none / full / development as the flags say'];
  const sem = path.join(clone, 'daemons', 'semantic-search');
  const stubHead = [
    "const fsx = require('fs'), pathx = require('path');",
    "if (fsx.existsSync(pathx.join(process.env.AIGENT_VAULT_ROOT, 'scratch'))) { console.error('[stub] REFUSING to run: undeclared vault namespace directories: scratch'); process.exit(1); }",
    "console.log('Embed: 1ms | Search: 1ms | Total: 2ms');",
    "const deniedPath = () => false, DENY_PREFIXES = [], namespaceDispositionForPath = () => 'INDEX', NAMESPACE_REGISTRY = {};",
    "const index = { notes: [] };",
    ...F9_FILTERS,
  ].join('\n');
  writeFileSync(path.join(sem, 'search-vault.js'), `${stubHead}\n${STUB_SEARCH}`);
  writeFileSync(path.join(sem, 'embed-vault.js'), `${stubHead.split('\n').slice(0, 2).join('\n')}\n${STUB_EMBED}`);
  const pkg = path.join(sem, 'node_modules', '@xenova', 'transformers');
  mkdirSync(path.join(pkg, '.cache', 'Xenova', 'all-MiniLM-L6-v2', 'onnx'), { recursive: true });
  writeFileSync(path.join(pkg, '.cache', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx'), 'stub');
  writeFileSync(path.join(pkg, 'package.json'), '{"name":"@xenova/transformers","version":"0.0.0","type":"module","main":"index.js"}');
  writeFileSync(path.join(pkg, 'index.js'), 'export const pipeline = async () => async () => ({ data: new Float32Array([0.1, 0.2, 0.3]) });\n');
  const cg = (...a) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8', env: gitIdentityEnv });
  cg('add', '-A');
  cg('commit', '-q', '--no-verify', '-m', 'stub candidate');
  const candCommit = cg('rev-parse', 'HEAD').stdout.trim();
  const pins = Object.fromEntries(PINNED_PATHS.map((f) => [f, fileHash(path.join(clone, ...f.split('/')))]));
  const env = { os: os.platform(), node: process.version, bash: bashProbe().resolved, model: 'Xenova/all-MiniLM-L6-v2' };
  const reg = file('cand.md', registrationText({ id: 'C-001', commit: candCommit, pins, instrumentSha: fileHash(instFile), instrumentCommit: instCommit, env }));
  const go = (args) => run(['--candidates', reg, ...args]);
  const out = (name) => path.join(tmp, name);
  const f1 = go(['--scenario', 'F1']);
  const u = (p, id) => (p.cases || []).find((c) => c.id === id);
  check(names[0], f1.identity && f1.identity.kind === 'candidate' && !(f1.harness_errors || []).length && u(f1, 'U-01')?.status === 'not-applicable' && u(f1, 'U-02')?.status === 'not-applicable'
    && !(f1.classes || []).some((c) => c.class === 'undeclared' && c.unrunnable > 0) && !(f1.terminal_basis || []).some((b) => /unrunnable/.test(b)),
    JSON.stringify([f1.identity, f1.harness_errors, u(f1, 'U-01'), f1.terminal_basis, f1.parseFailure]).slice(0, 400));
  const f5 = go(['--scenario', 'F5']);
  const pc = u(f5, 'PC-01');
  check(names[1], pc?.status === 'fail' && /search exited 1/.test(pc.detail) && u(f5, 'P-01')?.status === 'unrunnable' && ['U-01', 'U-02'].every((id) => u(f5, id)?.status === 'pass') && f5.expected_red_observed === true,
    JSON.stringify([pc, u(f5, 'P-01')?.status, u(f5, 'U-01')?.status, f5.expected_red_observed, f5.harness_errors, f5.parseFailure]).slice(0, 400));
  const base = go([]);
  writeFileSync(out('base.json'), JSON.stringify(base));
  const none = go(['--scenario', 'F9']);
  const full = go(['--scenario', 'F9', '--reference', out('base.json')]);
  const dev = go(['--scenario', 'F9', '--reference', out('base.json'), '--reference-development']);
  check(names[2], none.f9_reference_mode === 'none' && full.f9_reference_mode === 'full' && dev.f9_reference_mode === 'development' && full.reference_packet?.mode === 'full-same-method-reference',
    JSON.stringify([none.f9_reference_mode, full.f9_reference_mode, dev.f9_reference_mode, full.harness_errors, base.harness_errors, base.parseFailure]).slice(0, 400));
}

async function selfCheckAccounting(check) {
  const stubbed = (name) => {
    const b = makeSandbox(name);
    writeFileSync(path.join(b.sem, 'search-vault.js'), STUB_SEARCH);
    writeFileSync(path.join(b.sem, 'embed-vault.js'), STUB_EMBED);
    writeFileSync(path.join(b.sem, 'embed-one.mjs'), "process.stdout.write('[0.1,0.2,0.3]');\n");
    return b;
  };
  const box = stubbed('selfcheck-acct');
  auxBox = stubbed('selfcheck-acct-aux');
  POLICY = await loadPolicy(box);
  const CAN = [...CANARIES.keys()][0];
  const vecSha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const snap = () => ({ res: results.length, pfp: policyFalsePositives.length, aux: auxiliaryControls.length });
  const seedVec = [0.1, 0.2, 0.3];
  const row = (p, chunk, emb) => ({ path: p, title: p, tags: [], chunk, embedding: emb, mtime: 0 });
  const pre = { notes: [row('ops-deny/pre.md', 'p', [9]), row('research/a.md', 'a', [8])], entryCount: 2 };
  const seedFor = (p) => {
    const seeded = { notes: [...pre.notes, row(p, `${CAN} seeded`, seedVec)], entryCount: 3 };
    return { path: p, title: p, chunk: `${CAN} seeded`, vector: seedVec, pristineText: JSON.stringify(pre), seededText: JSON.stringify(seeded) };
  };

  // QUERY stage, with a NON-ZERO pristine count (the F4 shape): pre.md is already filtered.
  const seed = seedFor('ops-deny/seed-x.md');
  writeFileSync(box.embeddings, seed.seededText);
  const c = { id: 'X-99', class: 'stale-index', query: 'q' };
  let s0 = snap();
  const q = runQueryStage(box, c, seed);
  finishQueryStage(c, q, {});
  let s1 = snap();
  const r = results[results.length - 1];
  check('5c delta is seeded minus pristine (2 - 1), not the aggregate count', r.proof.counts.seeded === 2 && r.proof.counts.pristine === 1 && r.proof.delta === 1 && r.label === 'QUERY-WITHHELD', JSON.stringify(r.proof.counts));
  check('5c the delta reads the filter the target disposition names (namespace)', r.proof.filter === 'namespace');
  check('5c the control and pristine invocations never reach the scored record, scanPolicy or the leak list',
    s1.res === s0.res + 1 && s1.pfp === s0.pfp && s1.aux === s0.aux + 1, JSON.stringify({ s0, s1 }));
  check('5c the control output (which carries a corpus canary) is not in the forbidden run accounting', q.controlRes.all.includes(CAN) && leakedCanaries(q.res.all).length === 0);
  const calls = readFileSync(path.join(box.sem, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ctlPath = controlPathFor(c.id);
  check('5c three invocations: pristine index, seeded index, control index', calls.length === 3 && !calls[0].rows.some((x) => x.path === seed.path) && calls[1].rows.some((x) => x.path === seed.path) && calls[2].rows.some((x) => x.path === ctlPath));
  check('5c the control carries the SAME embedding as the seeded row', calls[1].rows.find((x) => x.path === seed.path).emb === vecSha(seedVec) && calls[2].rows.find((x) => x.path === ctlPath).emb === vecSha(seedVec));
  check('5c the auxiliary record carries the control vector hash', auxiliaryControls[auxiliaryControls.length - 1].vectorSha256 === vecSha(seedVec));
  writeFileSync(box.embeddings, JSON.stringify({ notes: [row(seed.path, seed.chunk, [0.1, 0.2, 0.4])] }));
  check('5c read-back refuses a seeded row whose vector differs', readBackSeed(box, seed).present === false);

  // An undemonstrated QUERY proof is a FAIL record but never a leak.
  const seedY = seedFor('research/seed-y.md');
  writeFileSync(box.embeddings, seedY.seededText);
  s0 = snap();
  const cy = { id: 'X-98', class: 'stale-index', query: 'q' };
  finishQueryStage(cy, runQueryStage(box, cy, seedY), {});
  s1 = snap();
  const ry = results[results.length - 1];
  check('5c undemonstrated -> FAIL policy-withholding-not-demonstrated, not a policy false positive',
    ry.status === 'fail' && ry.undemonstrated === true && ry.detail.startsWith(NOT_DEMONSTRATED) && s1.pfp === s0.pfp);

  // BUILD stage: the control is built and searched in the AUXILIARY sandbox.
  const cb = { id: 'C-99', class: 'deny', target: 'ops-deny/alarm-bypass-codes.md', query: 'q' };
  s0 = snap();
  const out = auxBuildControl(box, cb);
  s1 = snap();
  check('5c BUILD control: built and returned in the auxiliary sandbox, byte-identical copy, same code', out.indexedRows === 1 && out.returned === true && out.targetSha256 === out.copySha256 && out.sandboxSameCodeAsScored === true, JSON.stringify(out));
  check('5c BUILD control output never reaches the scored record, scanPolicy or the leak list', s1.res === s0.res && s1.pfp === s0.pfp && s1.aux === s0.aux + 1, JSON.stringify({ s0, s1 }));

  // ── I2 / I3: through scoreWithheld and scoreStaleIndex, the real scored-case callers.
  const withEnv = (vars, fn) => {
    const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try { return fn(); } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  const target = 'ops-deny/alarm-bypass-codes.md';
  buildInputPresence = { [target]: true };
  builtRowCounts = new Map();
  const rebuild = () => { writeFileSync(box.embeddings, JSON.stringify(pre)); };
  const last = () => results[results.length - 1];
  const sidecarModes = { malformed: 'abstention-sidecar-malformed', duplicate: 'abstention-sidecar-duplicated', unknown: 'abstention-reason-unknown', unbound: 'abstention-sidecar-unbound' };
  let n = 0;
  for (const [mode, detail] of Object.entries(sidecarModes)) {
    n += 1;
    rebuild();
    const before = results.length;
    withEnv({ STUB_SIDECAR: mode }, () => scoreWithheld(box, { id: `C-7${n}`, class: 'deny', target, query: 'q' }));
    check(`2c I2 scoreWithheld: a REJECTED sidecar (${mode}) on an empty-result invocation FAILs the case as ${detail}`, results.length === before + 1 && last().status === 'fail' && last().detail === detail, `${last().status} ${last().detail}`);
    rebuild();
    const seedStale = { id: `X-7${n}`, path: 'ops-deny/seed-stale.md', title: 't', chunk: `${CAN} stale` };
    const beforeX = results.length;
    withEnv({ STUB_SIDECAR: mode }, () => scoreStaleIndex(box, { id: `X-7${n}`, class: 'stale-index', query: 'q', canary: CAN, expectedDisposition: 'DENY' }, seedStale));
    check(`2c I2 scoreStaleIndex: a REJECTED sidecar (${mode}) FAILs the case as ${detail}`, results.length === beforeX + 1 && last().status === 'fail' && last().detail === detail, `${last().status} ${last().detail}`);
  }
  rebuild();
  withEnv({}, () => scoreWithheld(box, { id: 'C-70', class: 'deny', target, query: 'q' }));
  check('2c I2 an ordinary non-abstaining query is NOT asked for a sidecar (BUILD-WITHHELD still PASSes)', last().status === 'pass' && last().label === 'BUILD-WITHHELD', `${last().status} ${last().detail}`);
  rebuild();
  withEnv({}, () => scoreStaleIndex(box, { id: 'X-70', class: 'stale-index', query: 'q', canary: CAN, expectedDisposition: 'DENY' }, { id: 'X-70', path: 'ops-deny/seed-stale.md', title: 't', chunk: `${CAN} stale` }));
  check('2c I2 ... and the QUERY-stage case with no sidecar still reaches its proof (QUERY-WITHHELD)', last().status === 'pass' && last().label === 'QUERY-WITHHELD', `${last().status} ${last().detail}`);

  // I3: a permitted control that prints its row and then exits non-zero is not a witness.
  rebuild();
  let p0 = snap();
  withEnv({ STUB_CTL_FAIL: '1' }, () => scoreStaleIndex(box, { id: 'X-71', class: 'stale-index', query: 'q', canary: CAN, expectedDisposition: 'DENY' }, { id: 'X-71', path: 'ops-deny/seed-stale.md', title: 't', chunk: `${CAN} stale` }));
  let p1 = snap();
  const rq = last();
  check('3c I3 QUERY: control prints its row, then exits 1 -> not returned, exit recorded, FAIL policy-withholding-not-demonstrated',
    rq.status === 'fail' && rq.detail.startsWith(NOT_DEMONSTRATED) && rq.proof.control.returned === false && rq.proof.control.exit === 1 && rq.undemonstrated === true, `${rq.status} ${rq.detail} ${JSON.stringify(rq.proof && rq.proof.control)}`);
  check('3c I3 QUERY: the failed control is recorded in its own block, returned=false, and never reaches the leak accounting', auxiliaryControls[auxiliaryControls.length - 1].returned === false && auxiliaryControls[auxiliaryControls.length - 1].exit === 1 && p1.pfp === p0.pfp, JSON.stringify([p0, p1]));
  rebuild();
  const ctlBuild = withEnv({ STUB_CTL_FAIL: '1' }, () => auxBuildControl(box, { id: 'C-72', class: 'deny', target, query: 'q' }));
  check('3c I3 BUILD: control row printed then exit 1 -> indexed but NOT returned (searchExit 1 recorded)', ctlBuild.indexedRows === 1 && ctlBuild.searchExit === 1 && ctlBuild.returned === false, JSON.stringify(ctlBuild));
  rebuild();
  p0 = snap();
  withEnv({ STUB_CTL_FAIL: '1' }, () => scoreWithheld(box, { id: 'C-73', class: 'deny', target, query: 'q' }));
  p1 = snap();
  check('3c I3 BUILD through scoreWithheld: FAIL policy-withholding-not-demonstrated, one scored record, no leak from the control canary',
    last().status === 'fail' && last().detail.startsWith(NOT_DEMONSTRATED) && p1.res === p0.res + 1 && p1.pfp === p0.pfp, `${last().status} ${last().detail}`);
  rebuild();
  const healthy = auxBuildControl(box, { id: 'C-74', class: 'deny', target, query: 'q' });
  check('3c I3 a healthy control (exit 0, row returned) is still returned', healthy.returned === true && healthy.searchExit === 0 && healthy.buildExit === 0, JSON.stringify(healthy));
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
const SEARCH_FILE = 'daemons/semantic-search/search-vault.js';
// The ids a scenario that does not apply the undeclared overlay declares NOT-APPLICABLE (excluded from its
// population, recorded as such). BASELINE and every identity run declare none. Enforced in finalizeRun.
const NA_U = ['U-01', 'U-02'];
const PRE_WINDOW_NOW = preWindowInstant(CORPUS);
const SCENARIOS = {
  BASELINE: {
    mutation: 'none (unmutated corpus)',
    expectedRed: [], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: true,
  },
  F1: {
    mutation: "delete case P-07's target note from the sandbox vault, then a FULL rebuild",
    expectedRed: ['P-07'], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: false, notApplicable: NA_U,
  },
  F2: {
    mutation: 'add a long research/ note paraphrasing N-04 without answering it, then a full rebuild',
    expectedRed: ['N-04'], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: false, notApplicable: NA_U,
    caveat: 'N-04 is already FAIL on the unmutated corpus (top-1 0.5771, far above tau 0.30), so this '
      + 'falsifier cannot demonstrate a green-to-red TRANSITION here. What it demonstrates is that the '
      + 'mutation lands and the negative-class instrument responds: top-1 rises and the injected '
      + 'distractor takes rank 1. That is evidence about tau, not about the falsifier.',
  },
  F3: {
    mutation: "rewrite T-03's superseded note to duplicate the current note's body and restate the T-03 query",
    expectedRed: ['T-03'], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: false, notApplicable: NA_U,
    expectInversionsAtLeast: 1,
    // At this baseline (d3dd339, clock pinned) the unmutated corpus has temporal 8/8 and ZERO inversions, so T-03
    // entering the inversion list is a green-to-red transition. Asserted by id, not by a bare count.
    expectInversionIds: ['T-03'],
    caveat: 'Measured at this baseline (d3dd339, AIGENT_SEARCH_NOW pinned): temporal 8/8 and zero inversions before the mutation, '
      + 'so T-03 going red and entering the inversion list is a real green-to-red transition. (Under the earlier cdb7022 identity and an '
      + 'unpinned clock, T-03 was already red with T-02 and T-04 inverted; that history is why the clause names WHICH ids invert.)',
  },
  F4: {
    mutation: "inject a row inside ops-deny/ carrying C-02's DENY canary text with the captured rank-1 embedding vector",
    expectedRed: [], expectedRedClasses: [], expectPass: ['PC-01', 'C-02'],
    unrunnableClasses: [], runU: false, notApplicable: NA_U,
    note: 'confirmatory, not destructive: the expected observation is that C-02 stays PASS and the canary never reaches stdout',
  },
  F5: {
    mutation: 'copy the undeclared overlay in as scratch/ AND delete the feedback row from the sandbox core registry',
    // Each expectation and the sentence it comes from:
    //  quality classes UNRUNNABLE   PREREG-001 6 F5: "every quality case in that mutation run reports UNRUNNABLE rather than a shrunken green"
    //  U-01 / U-02 PASS             PREREG-001 6 F5: "U-01 and U-02 report their expected refusal"
    //  PC-01 FAIL (executed)        PREREG-001 6 F5: "search-vault.js exit non-zero" (the runtime refuses), scored per PREREG-002 section 6:
    //                               a non-zero exit with every 4.3 prerequisite verified present is a behavioral FAIL, not UNRUNNABLE
    expectedRed: ['PC-01'], expectedRedClasses: [], expectPass: ['U-01', 'U-02'],
    unrunnableClasses: ['positive', 'negative', 'temporal', 'deny', 'skip', 'stale-index', 'operator', 'loudness'],
    runU: true, mutates: ['daemons/semantic-search/namespace-registry.json'],
  },
  F6: {
    mutation: 'delete <sandbox vault>/memory/embeddings.json and run without rebuilding',
    expectedRed: ['PC-01'], expectedRedClasses: ['positive', 'temporal', 'operator'], expectPass: [],
    unrunnableClasses: ['negative'], runU: false, notApplicable: NA_U,
  },
  // F7, F8, F9 are named MUTATION RUNS (PREREG-002 section 6): reported under
  // their falsifier name, never as an identity run, a new baseline or a candidate.
  F7: {
    mutation: 'replace the abstention gate with one that returns zero rows unconditionally and still emits a valid bound sidecar (after index validation and both filters)',
    expectedRed: ['PC-01'], expectedRedClasses: ['positive'], expectPass: [], expectPassClasses: ['negative'],
    unrunnableClasses: [], runU: false, notApplicable: NA_U, needsGate: true, mutates: [SEARCH_FILE], applyCode: (b) => mutateSandboxSearch(b, f7Mutate),
    caveat: 'F7 is NOT executable at the baseline (no abstention gate exists: UNRUNNABLE, naming that), and it is NOT executable at a candidate '
      + 'either as the hook stands: the entry check requires an AIGENT_ABSTAIN emission in search-vault.js and f7Mutate refuses a source that contains one. '
      + 'The hook and the observations it predicts are exercised only on synthetic process output by --self-check. Candidate-era F7 support is incomplete '
      + 'and is owed, with a real sandbox witness, before F7 may be used to certify a candidate.',
  },
  F8: {
    mutation: `run the temporal class with AIGENT_SEARCH_NOW set to ${PRE_WINDOW_NOW}, one day before the earliest corpus window end`,
    expectedRed: [], expectedRedClasses: ['temporal'], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: false, notApplicable: NA_U, temporalNow: PRE_WINDOW_NOW,
    expectInversionIds: ['T-02', 'T-04'], expectInversionCount: 2,
  },
  F9: {
    mutation: 'delete the two query-stage filter calls from the sandbox search-vault.js (the render chokepoint, the directory guard, the helper modules and the indexer stay)',
    expectedRed: [], expectedRedClasses: [], expectPass: ['PC-01'],
    unrunnableClasses: [], runU: true, mutates: [SEARCH_FILE], applyCode: (b) => mutateSandboxSearch(b, f9Mutate), assert: f9Assertions,
    note: 'asserted per case: no QUERY-stage case may read QUERY-WITHHELD; BUILD-stage and U-class results must stand. '
      + 'Only the filter-removal arm is executed: the forced-abstention second arm is NOT executable here (no abstention gate), and synthetic label tests are not its execution.',
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

// ── finalization, PREREG-001 5.1 / 5.2 / 5.3 ─────────────────────────────────
// Pure over the scored records so --self-check drives the REAL finalization with
// synthetic cases (main calls exactly this). The run terminal is decided by the
// declared CLASS GATES, PC-01, the fatal leak / budget / integrity / pin rules,
// and, for a mutation run that actually executed, its expected red. A permitted
// case miss inside a met class gate is not a run FAIL (positive >= 22 of 24).
function finalizeRun({ results, cases, spec, scenario, inversions, harnessErrors, policyFalsePositives, budgetBreaches, pinDrift, referenceRows, referenceDev, ran, only }) {
  // The population must equal the frozen case list, each id exactly once (5.4: N =
  // 64 + PC-01). A missing, duplicated or foreign record is a defect in the
  // benchmark, never a PASS. A development subset scores some cases by design.
  // Statuses are pass / fail / unrunnable / not-applicable, and not-applicable exists
  // only for ids the scenario spec declares: a BASELINE or candidate identity run
  // declares none, so a class member or PC-01 recorded as such is an integrity
  // error, never a PASS. Enforced here, not left to the caller.
  if (harnessErrors.length === 0) {
    const naAllowed = new Set(scenario === 'BASELINE' ? [] : (spec.notApplicable || []));
    const unknown = results.filter((r) => !['pass', 'fail', 'unrunnable', 'not-applicable'].includes(r.status)).map((r) => `${r.id}=${r.status}`);
    const foreignNA = results.filter((r) => r.status === 'not-applicable' && !naAllowed.has(r.id)).map((r) => r.id);
    if (unknown.length || foreignNA.length) {
      harnessErrors.push(`result statuses outside the scenario's declared set: unknown status [${unknown}], not-applicable not declared by ${scenario} [${foreignNA}]`);
    }
  }
  if (!only && harnessErrors.length === 0) {
    const want = cases.map((c) => c.id);
    const got = results.map((r) => r.id);
    const missing = want.filter((id) => !got.includes(id));
    const dup = [...new Set(got.filter((id, i) => got.indexOf(id) !== i))];
    const extra = got.filter((id) => !want.includes(id));
    if (missing.length || dup.length || extra.length) {
      harnessErrors.push(`result population does not match the frozen case list: missing [${missing}], duplicate [${dup}], foreign [${extra}]`);
    }
  }
  const pcRed = results.some((r) => r.id === 'PC-01' && r.status === 'fail');
  const classReport = GATES.map((g) => {
    const rows = results.filter((r) => r.class === g.klass);
    const notApplicable = rows.filter((r) => r.status === 'not-applicable').length;
    const passed = rows.filter((r) => r.status === 'pass').length;
    const failed = rows.filter((r) => r.status === 'fail').length;
    const unrunnable = rows.filter((r) => r.status === 'unrunnable').length;
    // The gate counts PASSES. A case miss inside a met gate is permitted, never a
    // silent 100 percent; an unrunnable case means the class cannot be certified.
    const gateMet = passed >= g.min && (g.klass !== 'temporal' || inversions.length === 0);
    let status = unrunnable > 0 ? (gateMet || failed === 0 ? 'UNRUNNABLE' : 'FAIL') : (gateMet ? 'PASS' : 'FAIL');
    // A class every case of which is deliberately not part of this scenario has no gate here.
    if (rows.length > 0 && notApplicable === rows.length) status = 'NOT-APPLICABLE';
    // PREREG-002 section 6: with PC-01 red no class can be certified PASS.
    if (status === 'PASS' && pcRed) status = 'NOT-CERTIFIED';
    return {
      class: g.klass, label: g.label, gate: g.gate, n: g.n, gateMet: status === 'NOT-APPLICABLE' ? null : gateMet,
      pass: passed, fail: failed, unrunnable, notApplicable,
      failingIds: rows.filter((r) => r.status === 'fail').map((r) => r.id),
      unrunnableIds: rows.filter((r) => r.status === 'unrunnable').map((r) => r.id),
      status,
    };
  });

  // Expected-red accounting, PREREG-001 6: "A falsifier that does not produce its
  // expected red is itself a FAIL of the benchmark, not of the product." Every
  // expectation is judged separately; one that READS a case that could not run (a
  // missing prerequisite) is blocked, never failed, and nothing else is excused by it.
  const statusOf = (id) => (results.find((r) => r.id === id) || {}).status || 'not-run';
  const expectedRedIds = [
    ...spec.expectedRed,
    ...cases.filter((c) => (spec.expectedRedClasses || []).includes(c.class)).map((c) => c.id),
  ];
  const expectedRedObserved = expectedRedIds.map((id) => ({ id, expected: 'fail', observed: statusOf(id) }));
  const expectedPassIds = [
    ...(spec.expectPass || []),
    ...cases.filter((c) => (spec.expectPassClasses || []).includes(c.class)).map((c) => c.id),
  ];
  const expectedPassObserved = expectedPassIds.map((id) => ({ id, expected: 'pass', observed: statusOf(id) }));
  const scenarioAssertions = spec.assert && ran ? spec.assert(results, referenceRows, referenceDev) : [];
  const expectedUnrunnableObserved = (spec.unrunnableClasses || []).map((klass) => {
    const rows = results.filter((r) => r.class === klass);
    return { class: klass, expected: 'unrunnable', n: rows.length, unrunnable: rows.filter((r) => r.status === 'unrunnable').length };
  });
  const inversionShortfall = spec.expectInversionsAtLeast != null && inversions.length < spec.expectInversionsAtLeast;
  // Assert WHICH ids inverted, not just how many (see the F3 caveat).
  const missingInversionIds = (spec.expectInversionIds || []).filter((id) => !inversions.some((v) => v.id === id));
  const unrunnableClass = (klass) => results.some((r) => r.class === klass && r.status === 'unrunnable');
  const failures = [
    ...expectedRedObserved.filter((r) => r.observed !== 'fail').map((r) => ({ name: `expect FAIL ${r.id}: ${r.observed}`, blocked: r.observed === 'unrunnable' })),
    ...expectedPassObserved.filter((r) => r.observed !== 'pass').map((r) => ({ name: `expect PASS ${r.id}: ${r.observed}`, blocked: r.observed === 'unrunnable' })),
    ...expectedUnrunnableObserved.filter((r) => !(r.n > 0 && r.unrunnable === r.n)).map((r) => ({ name: `expect UNRUNNABLE ${r.class}: ${r.unrunnable}/${r.n}`, blocked: false })),
    ...(inversionShortfall ? [{ name: 'inversion shortfall', blocked: false }] : []),
    ...missingInversionIds.map((id) => ({ name: `expected inversion ${id} absent`, blocked: false })),
    ...(spec.expectInversionCount != null && inversions.length !== spec.expectInversionCount ? [{ name: `inversion count ${inversions.length} != ${spec.expectInversionCount}`, blocked: false }] : []),
    ...scenarioAssertions.filter((a) => !a.ok).map((a) => ({ name: a.name, blocked: !!a.notEvaluated || (!!a.needs && unrunnableClass(a.needs)), notEvaluated: !!a.notEvaluated })),
  ];
  // A harness-errored run has no measurement to hold: an empty fallback spec is vacuously true.
  const expectedRedHolds = harnessErrors.length === 0 && failures.length === 0;

  const pc01 = results.find((r) => r.id === 'PC-01') || null;
  const anyUnrunnable = results.some((r) => r.status === 'unrunnable');
  // A failed expectation in a falsifier that EXECUTED invalidates the benchmark run
  // (PREREG-001 5.4 / 6: "a benchmark FAIL"), whatever not-applicable cases it has.
  // A missing precondition is different: an expectation blocked by an unrunnable
  // case it reads, or one that cannot be evaluated here, is reported and keeps
  // the run from reading as a passed falsifier, but it is not a failed expectation.
  const falsifierInvalid = scenario !== 'BASELINE' && ran && failures.some((f) => !f.blocked);
  const notEvaluated = failures.filter((f) => f.notEvaluated);

  const failBasis = [
    ...classReport.filter((c) => c.status === 'FAIL').map((c) => `class-gate-missed: ${c.class} ${c.pass}/${c.n} (${c.gate})`),
    ...(policyFalsePositives.length ? [`policy-false-positives: ${policyFalsePositives.length}`] : []),
    ...(budgetBreaches.length ? [`budget-breaches: ${budgetBreaches.length}`] : []),
    ...(pc01 && pc01.status === 'fail' ? ['pc-01-failed'] : []),
    ...(falsifierInvalid ? [`falsifier-expectation-failed: ${scenario} executed and did not produce its expected red: ${failures.filter((f) => !f.blocked).map((f) => f.name).join('; ')}`] : []),
  ];
  const unrunnableBasis = [
    ...(pinDrift.length ? [`pin-drift: ${pinDrift.length} file(s)`] : []),
    ...(anyUnrunnable ? [`unrunnable-cases: ${results.filter((r) => r.status === 'unrunnable').length}`] : []),
    ...(notEvaluated.length ? [`expectation-not-evaluated: ${notEvaluated.map((f) => f.name).join('; ')}`] : []),
  ];
  // 5.3: a FAIL beside unrunnable cases is a FAIL, with the unrunnable listed in full.
  const terminalBasis = [...failBasis, ...unrunnableBasis];

  let terminal;
  if (harnessErrors.length) terminal = 'HARNESS-ERROR';
  else if (failBasis.length) terminal = 'FAIL';
  else if (unrunnableBasis.length) terminal = 'UNRUNNABLE';
  else terminal = 'PASS';
  // A development subset scores some cases; its gates cannot be met and it is not a result.
  if (only) terminal = `${terminal} (development subset, not a result)`;
  return {
    classReport, expectedRedIds, expectedPassIds, expectedRedObserved, expectedPassObserved, expectedUnrunnableObserved,
    missingInversionIds, expectedRedHolds, scenarioAssertions, pc01, terminal, terminalBasis, falsifierInvalid,
  };
}
const exitCodeFor = (terminal) => (terminal === 'PASS' ? 0 : 1);

// What this instrument can and cannot execute, stated in the packet and in the
// self-check output (review of b73de78). The F7 entry check below requires an
// AIGENT_ABSTAIN emission in search-vault.js; f7Mutate refuses a source that
// contains one. Both are true at once, so F7 has no executable path today.
const CLAIM_LIMITS = [
  'F7 is NOT executable at the baseline (no abstention gate exists), and it is NOT executable at a candidate either as the hook stands: its entry check requires an AIGENT_ABSTAIN emission in search-vault.js while f7Mutate refuses a source that contains one. Only synthetic-output checks exist for it.',
  'The F9 forced-abstention second arm is NOT executable here: only the filter-removal arm runs. Synthetic label tests do not constitute that arm\'s execution.',
  'Candidate-era section-7 mutation support is INCOMPLETE: the F7 hook and the F9 abstention arm are owed to the candidate that carries a gate, with real sandbox witnesses, before they may be used to certify it.',
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
    instrument_sha256: fileHash(fileURLToPath(import.meta.url)),
    product_commit: observeProductCommit(PRODUCT_TREE),
    runtime_hashes_observed: Object.fromEntries(PINNED_PATHS.map((k) => [k, fileHash(path.join(PRODUCT_TREE, ...k.split('/')))])),
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
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const staleSelf = JSON.parse(readFileSync(path.join(HERE, 'cases', 'stale-index.json'), 'utf8')).rows;
  const clean = integrityErrors(cases, staleSelf, GATES);
  const renamed = cases.map((c) => (c.id === 'P-07' ? { ...c, id: 'P-99' } : c));
  const mutated = integrityErrors(renamed, staleSelf, GATES);
  const dropped = integrityErrors(cases.filter((c) => c.id !== 'N-01'), staleSelf, GATES);
  const xDrift = integrityErrors(cases, staleSelf.slice(1), GATES);
  check('clean fixture', clean.length === 0, `${clean.length} error(s) ${clean}`);
  check('renamed P-07->P-99 caught', mutated.length > 0, mutated[0]);
  check('dropped N-01 caught', dropped.length > 0, dropped[0]);
  check('stale-index drift caught', xDrift.length > 0, xDrift[0]);
  selfCheckIdentity(check);
  selfCheckSidecar(check);
  await selfCheckPolicy(check);
  selfCheckReview(check);
  selfCheckWiring(check);
  selfCheckFinalizer(check);
  await selfCheckAccounting(check);
  check('8 claims: F7 and the F9 abstention arm are stated as NOT executable here, and candidate-era mutation support as incomplete', CLAIM_LIMITS.length === 3 && /F7/.test(CLAIM_LIMITS[0]) && /NOT executable/.test(CLAIM_LIMITS[0]) && /F9/.test(CLAIM_LIMITS[1]) && /NOT executable/.test(CLAIM_LIMITS[1]) && /INCOMPLETE/.test(CLAIM_LIMITS[2]));
  check('8 claims: the stated F7 conflict is real (f7Mutate refuses a source carrying the emission the entry check demands)', (() => { try { f7Mutate(`x ${ABSTAIN_PREFIX}`); return false; } catch (e) { return /already emits/.test(e.message); } })());
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? ` -- ${c.detail}` : ''}`);
  console.log('NOT EXECUTABLE AT THIS IDENTITY, STATED PLAINLY:');
  for (const l of CLAIM_LIMITS) console.log(`  - ${l}`);
  console.log(failed.length === 0 ? 'SELF-CHECK PASS' : `SELF-CHECK FAIL (${failed.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (!Object.hasOwn(SCENARIOS, SCENARIO)) {
  harnessErrors.push(`unknown scenario "${SCENARIO}": expected one of ${Object.keys(SCENARIOS).join(', ')}. `
    + 'Refusing to run an unmutated baseline under an unrecognised label.');
}
if (SCENARIO === 'F8' && !PRE_WINDOW_NOW) harnessErrors.push('F8: no corpus window end date found to derive the pre-window instant');
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
// PREREG-001 4.3 table: python3 / bash missing makes the doctor assertions inside
// U-01 and U-02 UNRUNNABLE, not the whole run.
const doctorGaps = gaps.filter((g) => g.item === 4 || g.item === 5);
const blockingGaps = gaps.filter((g) => g.item !== 4 && g.item !== 5);

// PREREG-002 section 7 items 1, 2, 9: observe the product identity, then refuse
// to score anything that is neither the baseline nor a registered candidate.
const INSTRUMENT_SHA = fileHash(fileURLToPath(import.meta.url));
const observedCommit = observeProductCommit(PRODUCT_TREE);
const candidatesPresent = !!CANDIDATES_FILE && existsSync(CANDIDATES_FILE);
let identity = resolveIdentity({
  observed: observedCommit,
  candidatesText: candidatesPresent ? readFileSync(CANDIDATES_FILE, 'utf8') : '',
  candidatesSource: CANDIDATES_FILE ? `${CANDIDATES_FILE}${candidatesPresent ? '' : ' (file absent)'}` : null,
  instrumentSha: INSTRUMENT_SHA,
  // 1.7 item 5: the record is bound to the environment this run observes.
  environment: { os: env.platform, node: env.node, bash: BASH ? BASH.resolved : null, model: model.name },
  verifyInstrumentCommit: instrumentCommitVerifier(ROOT, INSTRUMENT_REL, INSTRUMENT_SHA),
});
if (identity.ok) {
  const treeProblems = treeIdentityProblems(PRODUCT_TREE, observedCommit, identity.pins);
  if (treeProblems.length) {
    identity = { ok: false, requires: 'PREREG-002 1.3 / 1.7 — the product tree must equal the identity commit (clean, committed files hash to the pins)',
      why: `product tree does not match commit ${observedCommit}: ${treeProblems.join('; ')}` };
  }
}
const ACTIVE_PINS = identity.ok ? identity.pins : BASELINE_PINS;
let referenceRows = null;
if (REFERENCE_FILE) {
  let ref = null;
  try { ref = JSON.parse(readFileSync(REFERENCE_FILE, 'utf8')); } catch { ref = null; }
  const problem = validateReference(ref, {
    commit: observedCommit, kind: identity.kind, instrumentSha: INSTRUMENT_SHA, expectedIds: cases.map((c) => c.id),
    hashes: { corpus_sha256: corpusHash, overlay_sha256: overlayHash, fixture_registry_sha256: fixtureHash }, pins: ACTIVE_PINS, development: REFERENCE_DEV,
  });
  if (problem) harnessErrors.push(`--reference refused: ${problem}`);
  else referenceRows = ref.cases;
}
const ALL_QUALITY = cases
  .filter((c) => ['positive', 'negative', 'temporal', 'deny', 'skip', 'stale-index', 'operator', 'loudness'].includes(c.class))
  .map((c) => c.id);

let box = null;
const declareDoctorUnrunnable = () => declareUnrunnable(['U-01', 'U-02'],
  doctorGaps.map((g) => `4.3 item ${g.item}: ${g.why}`).join('; '),
  `PREREG-002 4.3 (${doctorGaps.map((g) => `item ${g.item}`).join(', ')})`);
let doctor = null;
const scenarioNotes = [];

function declareUnrunnable(ids, why, requires) {
  for (const id of ids) record(id, byId.get(id).class, 'unrunnable', why, { requires });
}

if (harnessErrors.length === 0 && !identity.ok) {
  declareUnrunnable(cases.map((c) => c.id), `PREREG-002 refuses to score: ${identity.why}`, identity.requires);
} else if (harnessErrors.length === 0 && SPEC.needsGate && !readFileSync(path.join(SEM, 'search-vault.js'), 'utf8').includes(ABSTAIN_PREFIX)) {
  // F7's entry check demands an emission site that f7Mutate then refuses (CLAIM_LIMITS): F7 never reaches a mutated run.
  declareUnrunnable(cases.map((c) => c.id),
    `${SCENARIO} mutates an abstention gate and this product's search-vault.js has no ${ABSTAIN_PREFIX} emission site, so there is no gate to replace`,
    `PREREG-002 ${SCENARIO} — abstention gate absent at this identity; the F7 hook is also not executable against a candidate as written (CLAIM_LIMITS)`);
} else if (harnessErrors.length === 0 && blockingGaps.length > 0) {
  declareUnrunnable(cases.map((c) => c.id),
    blockingGaps.map((g) => `4.3 item ${g.item}: ${g.why}`).join('; '),
    `PREREG-001 4.3 (${blockingGaps.map((g) => `item ${g.item}`).join(', ')})`);
}

let hashMismatch = [];
const gateBlocked = !!SPEC.needsGate && !readFileSync(path.join(SEM, 'search-vault.js'), 'utf8').includes(ABSTAIN_PREFIX);
if (harnessErrors.length === 0 && identity.ok && blockingGaps.length === 0 && !gateBlocked) {
  box = makeSandbox(SCENARIO.toLowerCase());
  hashMismatch = runtimeHashGaps(box, ACTIVE_PINS);
  if (hashMismatch.length) {
    // PREREG-002 1.3: UNRUNNABLE, naming the mismatch. Not a harness error.
    declareUnrunnable(cases.map((c) => c.id),
      `sandbox copies disagree with the ${identity.kind} pins: ${hashMismatch.map((b) => `${b.file} (expected ${b.expected.slice(0, 12)}, observed ${b.observed.slice(0, 12)})`).join('; ')}`,
      'PREREG-002 1.3 — sandbox pin mismatch');
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

    if (SPEC.applyCode) {
      try {
        SPEC.applyCode(box);
        const drifted = fileHash(sandboxFileMap(box)[SEARCH_FILE]) !== ACTIVE_PINS[SEARCH_FILE];
        if (!drifted) harnessErrors.push(`${SCENARIO}: the mutation did not land (the sandbox search-vault.js still hashes to its pin)`);
        else scenarioNotes.push(`${SCENARIO} mutation applied to the sandbox search-vault.js: ${SPEC.mutation}`);
      } catch (e) { harnessErrors.push(`${SCENARIO}: ${e.message}`); }
    }

    // 3.2a BUILD proof, conditions 2 and 3: what the build was handed, and what
    // it wrote. Snapshotted around the build, before any scenario touches the index.
    buildInputPresence = Object.fromEntries(cases.filter((c) => c.target).map((c) => [c.target, existsSync(path.join(box.vault, ...c.target.split('/')))]));
    indexBuild = buildIndex(box);
    builtRowCounts = existsSync(box.embeddings)
      ? readIndex(box).notes.reduce((m, n) => m.set(n.path, (m.get(n.path) || 0) + 1), new Map())
      : null;
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
        const pristineText = readFileSync(box.embeddings, 'utf8');
        index.notes.push({ path: c2.target, title: 'vault-door-service-log', tags: [], chunk, embedding: donor.embedding, mtime: 0 });
        index.entryCount = index.notes.length;
        writeIndex(box, index);
        // F4's injected row is a QUERY-stage case (3.2a): keep what the proof needs.
        F4_SEED = { path: c2.target, title: 'vault-door-service-log', chunk, vector: donor.embedding, pristineText, seededText: readFileSync(box.embeddings, 'utf8') };
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
      if (doctorGaps.length) declareDoctorUnrunnable();
      else {
        doctor = doctorNamespaceRecords(box);
        for (const id of ['U-01', 'U-02']) scoreUndeclared(box, byId.get(id), doctor);
      }
      declareUnrunnable(ALL_QUALITY,
        'F5: namespace coverage is red, so no quality number may be reported from this run',
        'PREREG-001 6 F5 — coverage red, quality must not be reported as a shrunken green');
      // PREREG-002 section 6: PC-01 is RUN. Every 4.3 prerequisite is verified present
      // here, so the expected non-zero exit is a behavioral FAIL, never UNRUNNABLE.
      scorePC01(box);
    } else if (harnessErrors.length === 0) {
      POLICY = await loadPolicy(box);

      // ── PC-01 first, as the harness's proof that it can see a hit at all.
      scorePC01(box);

      // PREREG-002 section 6 (PC-01 accounting): a RUNNABLE PC-01 whose answer is
      // wrong is a behavioral FAIL of the run. Every class is still scored in
      // full (no early stop) and the terminal is FAIL via pc01.status; UNRUNNABLE
      // needs a named missing 4.3 prerequisite and is decided above, not here.
      {
        for (const c of cases) {
          if (!want(c.id)) continue;
          if (c.class === 'positive') scorePositive(box, c);
          else if (c.class === 'negative') scoreNegative(box, c);
          else if (c.class === 'temporal') scoreTemporal(box, c);
          else if (c.class === 'deny' || c.class === 'skip') scoreWithheld(box, c);
          else if (c.class === 'operator') scoreOperator(box, c);
        }
        for (const c of cases.filter((x) => x.class === 'stale-index' && want(x.id))) {
          scoreStaleIndex(box, c, staleRows.find((s) => s.id === c.id));
        }
        // L-02 injects and restores. L-01 deletes a source and leaves it
        // deleted, so it runs after L-02 and before the coverage cases, which
        // assert only on the undeclared directory.
        if (want('L-02')) scoreLoudness(box, byId.get('L-02'));
        if (want('L-01')) scoreLoudness(box, byId.get('L-01'));

        // U-01/U-02: the overlay is copied in ONLY for these cases. A
        // physically present undeclared directory makes every other
        // invocation exit 1 (PREREG-001 1.4).
        if (!want('U-01') && !want('U-02')) {
          // development subset: coverage cases not requested
        } else if (SPEC.runU) {
          if (doctorGaps.length) declareDoctorUnrunnable();
          else {
            cpSync(path.join(OVERLAY, 'scratch'), path.join(box.vault, 'scratch'), { recursive: true });
            doctor = doctorNamespaceRecords(box);
            for (const id of ['U-01', 'U-02']) scoreUndeclared(box, byId.get(id), doctor);
            rmSync(path.join(box.vault, 'scratch'), { recursive: true, force: true });
          }
        } else {
          // NOT PART OF this scenario: excluded from its population and recorded as
          // such. It is not a missing prerequisite, so it can never mask a verdict.
          for (const id of SPEC.notApplicable || []) {
            record(id, byId.get(id).class, 'not-applicable', `${SCENARIO}: the undeclared overlay is not part of this mutation; coverage is scored in the BASELINE and F5 runs (PREREG-001 1.4)`);
          }
        }
      }
    }
  }
}

// ── terminal accounting: finalizeRun() above, PREREG-001 5.1 / 5.2 / 5.3 ─────
const wall = Date.now() - started;
const wallBudget = SCENARIO === 'BASELINE' ? RUN_WALL_MAX_MS : FALSIFIER_WALL_MAX_MS;
if (wall > wallBudget) budgetBreaches.push({ id: '(run)', breaches: [`wall clock ${(wall / 1000).toFixed(1)}s > ${(wallBudget / 1000).toFixed(0)}s`] });

// PREREG-001 1.3: "Any run whose sandbox copies of these files do not hash to
// the values above is UNRUNNABLE, not a result." The pre-mutation gate at
// runtimeHashGaps() cannot see a file a scenario edits afterwards, so the
// observed hashes are sampled again here and a pinned file that drifted feeds
// the terminal instead of sitting inert in the packet. Unpinned entries carry
// pinned: null and never trip this. A file the scenario declares it mutates is
// expected to differ from its pin.
const observedHashes = observedRuntimeHashes(box, ACTIVE_PINS);
const pinDrift = Object.entries(observedHashes || {})
  .filter(([file, v]) => v.pinned !== null && v.matchesPin === false && !(SPEC.mutates || []).includes(file))
  .map(([file, v]) => ({ file, expected: v.pinned, observed: v.observed }));

// A mutation run EXECUTED only if a sandbox was built, nothing was harness-errored
// and no pin mismatch declared every case unrunnable. Anything else is a missing
// precondition, accounted separately from a failed expectation.
const ran = !!box && harnessErrors.length === 0 && hashMismatch.length === 0;
const {
  classReport, expectedRedIds, expectedPassIds, expectedRedObserved, expectedPassObserved, expectedUnrunnableObserved,
  missingInversionIds, expectedRedHolds, scenarioAssertions, pc01, terminal, terminalBasis, falsifierInvalid,
} = finalizeRun({
  results, cases, spec: SPEC, scenario: SCENARIO, inversions, harnessErrors, policyFalsePositives, budgetBreaches,
  pinDrift, referenceRows, referenceDev: REFERENCE_DEV, ran, only: ONLY,
});

const packet = {
  preregistration: PREREG,
  packet_sha256: PACKET_SHA256,
  scenario: SCENARIO,
  // Named mutation runs are never identity runs (PREREG-002 section 6).
  identity_run: SCENARIO === 'BASELINE' && !ONLY && identity.ok && identity.instrumentRegistered === true,
  instrument_registered: identity.ok ? identity.instrumentRegistered === true : false,
  // The registration record's own identity (1.7 items 1-7) and its state: registered / incomplete / withdrawn / absent.
  registration: identity.registration || null,
  development_subset: ONLY ? [...ONLY] : null,
  product_commit: observedCommit,
  product_tree: PRODUCT_TREE,
  identity: { kind: identity.ok ? identity.kind : 'REFUSED', candidate_id: identity.candidate_id || null, refused: identity.ok ? null : identity.why },
  search_now: { frozen: FROZEN_NOW, temporal_class: SPEC.temporalNow || FROZEN_NOW },
  runtime_hash_mismatch: hashMismatch,
  terminal,
  // Why the terminal reads as it does: missed class gates, fatal rules, a failed falsifier expectation, unrunnable cases.
  terminal_basis: terminalBasis,
  falsifier_invalid: falsifierInvalid,
  // Stated plainly: what this instrument cannot execute (F7, the F9 abstention arm) and what is still owed.
  claims_limits: CLAIM_LIMITS,
  ran_at: new Date().toISOString(),
  wall_ms: wall,
  hashes: { corpus_sha256: corpusHash, overlay_sha256: overlayHash, fixture_registry_sha256: fixtureHash, frozen },
  instrument_sha256: INSTRUMENT_SHA,
  runtime_hashes_pinned: ACTIVE_PINS,
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
    expected_pass_ids: expectedPassIds,
    expected_inversion_count: SPEC.expectInversionCount ?? null,
    mutates: SPEC.mutates || [],
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
  scenario_assertions: scenarioAssertions,
  reference_packet: REFERENCE_FILE ? {
    file: REFERENCE_FILE, sha256: existsSync(REFERENCE_FILE) ? fileHash(REFERENCE_FILE) : 'ABSENT',
    mode: !referenceRows ? 'refused' : REFERENCE_DEV ? 'development-comparison (narrower; NOT a full same-method reference)' : 'full-same-method-reference',
  } : null,
  // 3.2a: one row per policy case, by stage and label. The auxiliary controls
  // are their own block and never enter scored totals, scanPolicy or leaks.
  policy_proof: results.filter((r) => r.stage).map((r) => ({ id: r.id, stage: r.stage, label: r.label, status: r.status, undemonstrated: !!r.undemonstrated })),
  auxiliary_controls: auxiliaryControls,
  index_build: indexBuild ? { exit: indexBuild.status, ms: indexBuild.ms, tail: indexBuild.all.slice(-800) } : null,
  doctor_namespace_records: doctor ? doctor.failedRecords : null,
  classes: classReport,
  positive_control: pc01,
  inversions,
  policy_false_positives: policyFalsePositives,
  budget_breaches: budgetBreaches,
  harness_errors: harnessErrors,
  // No `undeclared_unrunnable`: PREREG-001 5.1 means an UNRUNNABLE not preregistered on its case, but this
  // runner writes every UNRUNNABLE's reason at run time, so such a field is always empty and says nothing.
  // Any UNRUNNABLE still blocks PASS (unrunnable_cases in terminal_basis).
  f9_reference_mode: SCENARIO === 'F9' ? (REFERENCE_FILE ? (referenceRows ? (REFERENCE_DEV ? 'development' : 'full') : 'refused') : 'none') : null,
  cases: results,
};

if (JSON_OUT) {
  console.log(JSON.stringify(packet, null, 2));
} else {
  const MARK = { pass: 'PASS', fail: 'FAIL', unrunnable: 'UNRUNNABLE', 'not-applicable': 'N/A' };
  console.log(`\n${PREREG} — scenario ${SCENARIO} — product ${(observedCommit || 'UNOBSERVED').slice(0, 8)} (${identity.ok ? identity.kind + (identity.candidate_id ? ' ' + identity.candidate_id : '') : 'REFUSED'})`);
  console.log(`instrument_sha256 ${INSTRUMENT_SHA}  (register this before any scored run)${identity.ok && !identity.instrumentRegistered ? `\n  NOT an identity run: this instrument is not registered for the baseline (registration: ${identity.registration.state}${identity.registration.problems.length ? ` -- ${identity.registration.problems.join('; ')}` : ''})` : ''}`);
  console.log(`corpus           ${corpusHash}`);
  console.log(`overlay          ${overlayHash}`);
  console.log(`fixture-registry ${fixtureHash}\n`);
  for (const r of results) console.log(`  ${String(MARK[r.status] || r.status).padEnd(11)} ${r.id.padEnd(6)} ${r.detail}`);
  for (const a of scenarioAssertions) console.log(`    assert ${a.ok ? 'OK  ' : 'FAIL'} ${a.name}${a.detail ? ` -- ${a.detail}` : ''}`);
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
  console.log(`  terminal basis: ${terminalBasis.length ? terminalBasis.join(' | ') : 'every class gate met, no fatal rule tripped'}`);
  for (const l of CLAIM_LIMITS) console.log(`  limit: ${l}`);
  console.log(`\n  RUN TERMINAL: ${terminal}   (${(wall / 1000).toFixed(1)}s)\n`);
}

process.exit(exitCodeFor(terminal));
