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
//   --only <ids>            development subset; the packet says it is not a
//                           scored-run candidate
// Scenarios: BASELINE, F1..F9 (F7 needs an abstention gate no baseline carries).

import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// PREREG-002-CANDIDATES.md is append-only; one record per `candidate_id: C-nnn`
// line, with `key: value` lines and `<64 hex>  <path>` pin lines under it:
//   candidate_id: C-001        product_commit: <40 hex>
//   instrument_sha256: <64 hex>   withdraws: C-000   (optional)
//   <64 hex>  daemons/semantic-search/search-vault.js   (x10)
function parseCandidates(text) {
  const parts = String(text || '').split(/^(?=\s*(?:[-*]\s*)?candidate_id\s*:)/m).filter((b) => /candidate_id\s*:/.test(b));
  return parts.map((block) => {
    const grab = (key, re) => (block.match(new RegExp(`^\\s*(?:[-*]\\s*)?${key}\\s*:\\s*\`?(${re})\`?`, 'im')) || [])[1] || null;
    const pins = {};
    for (const m of block.matchAll(/^\s*(?:[-*]\s*)?`?([0-9a-f]{64})`?\s+`?(\S+?)`?\s*$/gm)) pins[m[2]] = m[1];
    return {
      candidate_id: grab('candidate_id', 'C-\\d+'),
      product_commit: grab('product_commit', '[0-9a-f]{40}'),
      instrument_sha256: grab('instrument_sha256', '[0-9a-f]{64}'),
      withdraws: [...block.matchAll(/^\s*(?:[-*]\s*)?withdraws\s*:\s*`?(C-\d+)`?/gim)].map((m) => m[1]),
      pins,
    };
  });
}

// PREREG-002 1.1 / 1.7 / 5.4 / section 7 item 9: the only identities that can
// produce a result are the baseline and a registered candidate whose record
// carries all ten pins and THIS instrument's sha256. Anything else is refused,
// naming why. Pure: the caller supplies the observation.
function resolveIdentity({ observed, candidatesText, candidatesSource, instrumentSha }) {
  if (!observed) {
    return { ok: false, why: 'git rev-parse HEAD failed in the product tree: product_commit cannot be observed', requires: 'PREREG-002 1.3 — product_commit must be observed in a git checkout' };
  }
  if (observed === BASELINE_COMMIT) return { ok: true, kind: 'baseline', candidate_id: null, pins: BASELINE_PINS };
  const records = parseCandidates(candidatesText);
  const withdrawn = new Set(records.flatMap((r) => r.withdraws));
  const hit = records.find((r) => r.product_commit === observed && !withdrawn.has(r.candidate_id));
  const requires = 'PREREG-002 1.7 — identity is neither the baseline nor a registered candidate';
  if (!hit) {
    const wd = records.find((r) => r.product_commit === observed && withdrawn.has(r.candidate_id));
    return { ok: false, requires, why: wd
      ? `product ${observed} matches ${wd.candidate_id}, which a later record withdrew`
      : `product ${observed} is neither the baseline ${BASELINE_COMMIT} nor registered in ${candidatesSource || 'a candidates file (none given; absent file = baseline only)'}` };
  }
  const missing = PINNED_PATHS.filter((f) => !hit.pins[f]);
  if (missing.length) return { ok: false, requires, why: `${hit.candidate_id} does not carry pin(s) for: ${missing.join(', ')}` };
  if (hit.instrument_sha256 !== instrumentSha) {
    return { ok: false, requires, why: `${hit.candidate_id} registers instrument_sha256 ${hit.instrument_sha256 || 'NONE'} but this instrument is ${instrumentSha}` };
  }
  return { ok: true, kind: 'candidate', candidate_id: hit.candidate_id, pins: Object.fromEntries(PINNED_PATHS.map((f) => [f, hit.pins[f]])) };
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
    try { obj = JSON.parse(lines[0].slice(ABSTAIN_PREFIX.length + 1)); } catch { obj = null; }
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
// class, whatever else is wrong with the line (3.2 final rejection rule).
const abstainGate = (res) => (res.abstain && res.abstain.lines > 0 && res.abstain.nonEmptyRows ? 'abstention-contradicted' : null);

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
    env: invocationEnv(box),
  });
  if (r.status !== 0) throw new Error(`embed helper failed: ${(r.stderr || '').slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

// Human mode, not --json: search-vault.js returns at :181-184 BEFORE the
// timing line, so --json gives no timings (PREREG-001 4.1). Both the timing
// line and the trailing JSON block are parsed out of the human output.
function search(box, query, { now = FROZEN_NOW } = {}) {
  const invocation = freshToken();
  const r = runNode(box, 'search-vault.js', [query], { AIGENT_SEARCH_NOW: now, AIGENT_SEARCH_INVOCATION: invocation });
  const out = { ...r, query, invocation, now, rows: null, timings: null, jsonBytes: null, parseError: null };
  const timing = r.stdout.match(/^Embed: (\d+)ms \| Search: (\d+)ms \| Total: (\d+)ms$/m);
  if (timing) out.timings = { embed: +timing[1], search: +timing[2], total: +timing[3] };
  const marker = r.stdout.lastIndexOf('\nJSON:\n');
  if (marker !== -1) {
    const block = r.stdout.slice(marker + '\nJSON:\n'.length).trim();
    out.jsonBytes = Buffer.byteLength(block, 'utf8');
    try { out.rows = JSON.parse(block); } catch (e) { out.parseError = e.message; }
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
  const res = search(box, c.query);
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
    if (observeProductCommit(PRODUCT_TREE) === BASELINE_COMMIT) {
      const bad = runtimeHashGaps(box0, BASELINE_PINS);
      check('2 baseline tree: sandbox copies hash to the ten pins', bad.length === 0, JSON.stringify(bad.map((b) => b.file)));
    }

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

    // 9. identity gate.
    const SHA = 'a'.repeat(64);
    const CAND = 'b'.repeat(40);
    const pinLines = PINNED_PATHS.map((f, i) => `${String(i).repeat(64).slice(0, 64)}  ${f}`).join('\n');
    const rec = (id, commit, extra = '') => `candidate_id: ${id}\nproduct_commit: ${commit}\ninstrument_sha256: ${SHA}\n${pinLines}\n${extra}\n`;
    const gate = (observed, text, sha = SHA) => resolveIdentity({ observed, candidatesText: text, candidatesSource: 'CANDS.md', instrumentSha: sha });
    check('9 baseline commit -> baseline identity', gate(BASELINE_COMMIT, '').kind === 'baseline');
    const unknown = gate(CAND, '');
    check('9 unknown commit, no file -> refused, names the identity', !unknown.ok && unknown.why.includes(CAND) && !!unknown.requires, unknown.why);
    const reg = gate(CAND, rec('C-001', CAND));
    check('9 registered candidate -> its own pins', reg.ok && reg.kind === 'candidate' && reg.candidate_id === 'C-001' && Object.keys(reg.pins).length === 10);
    check('9 candidate registered for another instrument -> refused', !gate(CAND, rec('C-001', CAND), 'c'.repeat(64)).ok);
    check('9 candidate record missing a pin -> refused naming it', (() => { const r = gate(CAND, rec('C-001', CAND).replace(/^.*memory-root\.sh.*$/m, '')); return !r.ok && r.why.includes('memory-root.sh'); })());
    check('9 withdrawn candidate -> refused', !gate(CAND, rec('C-001', CAND) + rec('C-002', 'c'.repeat(40), 'withdraws: C-001')).ok);
    check('9 unobservable commit -> refused, never a guess', !gate(null, '').ok);
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
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? ` -- ${c.detail}` : ''}`);
  console.log(failed.length === 0 ? 'SELF-CHECK PASS' : `SELF-CHECK FAIL (${failed.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
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
// PREREG-001 4.3 table: python3 / bash missing makes the doctor assertions inside
// U-01 and U-02 UNRUNNABLE, not the whole run.
const doctorGaps = gaps.filter((g) => g.item === 4 || g.item === 5);
const blockingGaps = gaps.filter((g) => g.item !== 4 && g.item !== 5);

// PREREG-002 section 7 items 1, 2, 9: observe the product identity, then refuse
// to score anything that is neither the baseline nor a registered candidate.
const INSTRUMENT_SHA = fileHash(fileURLToPath(import.meta.url));
const observedCommit = observeProductCommit(PRODUCT_TREE);
const candidatesPresent = !!CANDIDATES_FILE && existsSync(CANDIDATES_FILE);
const identity = resolveIdentity({
  observed: observedCommit,
  candidatesText: candidatesPresent ? readFileSync(CANDIDATES_FILE, 'utf8') : '',
  candidatesSource: CANDIDATES_FILE ? `${CANDIDATES_FILE}${candidatesPresent ? '' : ' (file absent)'}` : null,
  instrumentSha: INSTRUMENT_SHA,
});
const ACTIVE_PINS = identity.ok ? identity.pins : BASELINE_PINS;
const ALL_QUALITY = cases
  .filter((c) => ['positive', 'negative', 'temporal', 'deny', 'skip', 'stale-index', 'operator', 'loudness'].includes(c.class))
  .map((c) => c.id);

let box = null;
const declareDoctorUnrunnable = () => declareUnrunnable(['U-01', 'U-02'],
  doctorGaps.map((g) => `4.3 item ${g.item}: ${g.why}`).join('; '),
  `PREREG-002 4.3 (${doctorGaps.map((g) => `item ${g.item}`).join(', ')})`);
let indexBuild = null;
let doctor = null;
const scenarioNotes = [];

function declareUnrunnable(ids, why, requires) {
  for (const id of ids) record(id, byId.get(id).class, 'unrunnable', why, { requires });
}

if (harnessErrors.length === 0 && !identity.ok) {
  declareUnrunnable(cases.map((c) => c.id), `PREREG-002 refuses to score: ${identity.why}`, identity.requires);
} else if (harnessErrors.length === 0 && blockingGaps.length > 0) {
  declareUnrunnable(cases.map((c) => c.id),
    blockingGaps.map((g) => `4.3 item ${g.item}: ${g.why}`).join('; '),
    `PREREG-001 4.3 (${blockingGaps.map((g) => `item ${g.item}`).join(', ')})`);
}

let hashMismatch = [];
if (harnessErrors.length === 0 && identity.ok && blockingGaps.length === 0) {
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
      if (doctorGaps.length) declareDoctorUnrunnable();
      else {
        doctor = doctorNamespaceRecords(box);
        for (const id of ['U-01', 'U-02']) scoreUndeclared(box, byId.get(id), doctor);
      }
      declareUnrunnable(ALL_QUALITY,
        'F5: namespace coverage is red, so no quality number may be reported from this run',
        'PREREG-001 6 F5 — coverage red, quality must not be reported as a shrunken green');
      record('PC-01', 'positive-control', 'unrunnable',
        'F5: both runtimes refuse while a namespace is undeclared',
        { requires: 'PREREG-001 6 F5 — coverage red' });
    } else if (harnessErrors.length === 0) {
      // ── PC-01 first, as the harness's proof that it can see a hit at all.
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
        else { record('PC-01', 'positive-control', 'pass', `rank 1, score ${r1.score}`, { topScore: r1.score }); }
      }

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
  let status = (unrunnable > 0 && failed === 0) ? 'UNRUNNABLE' : (met ? 'PASS' : 'FAIL');
  // PREREG-002 section 6: with PC-01 red no class can be certified PASS.
  const pcRed = results.some((r) => r.id === 'PC-01' && r.status === 'fail');
  if (status === 'PASS' && pcRed) status = 'NOT-CERTIFIED';
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
const observedHashes = observedRuntimeHashes(box, ACTIVE_PINS);
const pinDrift = Object.entries(observedHashes || {})
  .filter(([, v]) => v.pinned !== null && v.matchesPin === false)
  .map(([file, v]) => ({ file, expected: v.pinned, observed: v.observed }));

// R2-5 asked for the pin-drift clause in the FAIL branch. PREREG-001 1.3 says
// the opposite in as many words: "Any run whose sandbox copies of these files
// do not hash to the values above is UNRUNNABLE, not a result." The packet wins
// over the order, so drift lands on UNRUNNABLE. It is still consequential --
// a drifted run can never report PASS -- and it is placed AFTER the FAIL branch
// so a genuine FAIL is never masked by it, matching 5.3's rule that a run with
// both a FAIL and an unrunnable is a FAIL.
// Measured: implementing it literally in the FAIL branch flipped F5 from
// UNRUNNABLE to FAIL, because F5's own mutation edits the pinned
// namespace-registry.json. Reported in the ledger, not reconciled silently.
let terminal;
if (harnessErrors.length) terminal = 'HARNESS-ERROR';
else if (anyFail || policyFalsePositives.length || budgetBreaches.length || (pc01 && pc01.status === 'fail')) terminal = 'FAIL';
else if (pinDrift.length || anyUnrunnable) terminal = 'UNRUNNABLE';
else terminal = 'PASS';

const packet = {
  preregistration: PREREG,
  packet_sha256: PACKET_SHA256,
  scenario: SCENARIO,
  // Named mutation runs are never identity runs (PREREG-002 section 6).
  identity_run: SCENARIO === 'BASELINE',
  development_subset: ONLY ? [...ONLY] : null,
  product_commit: observedCommit,
  product_tree: PRODUCT_TREE,
  identity: { kind: identity.ok ? identity.kind : 'REFUSED', candidate_id: identity.candidate_id || null, refused: identity.ok ? null : identity.why },
  search_now: { frozen: FROZEN_NOW },
  runtime_hash_mismatch: hashMismatch,
  terminal,
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
  console.log(`\n${PREREG} — scenario ${SCENARIO} — product ${(observedCommit || 'UNOBSERVED').slice(0, 8)} (${identity.ok ? identity.kind + (identity.candidate_id ? ' ' + identity.candidate_id : '') : 'REFUSED'})`);
  console.log(`instrument_sha256 ${INSTRUMENT_SHA}  (register this before any scored run)`);
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
