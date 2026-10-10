// semantic-search-loudness.test.mjs -- load-time loudness in search-vault.js.
//
// An indexed row whose source file is gone (deleted after the build, or never
// existed) must be named on stderr while the population loads, before any
// query runs (recollection-44 PREREG-001 3.7, adopted by PREREG-002 3.7). Only
// rows that survived the deny and namespace filters are checked, so a DENY or
// SKIP path is never named. Exit codes, results and the abstention sidecar are
// unchanged.
//
// Stub transformers, hand-built index, no model: CI-safe. The stub embeds every
// query as [1,0,0,0]; a note embedded as [s, sqrt(1-s^2), 0, 0] scores exactly s.
//
// Mutation witnesses (run every time, against sandbox copies of the product):
//   alarm on every row      -> the clean-corpus silence check goes red;
//   announcement removed    -> the deleted-source check goes red;
//   checked before filters  -> the filtered-path-never-named check goes red.
//
// Run: node daemons/tests/semantic-search-loudness.test.mjs

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEM = path.join(DAEMONS, 'semantic-search');

let failed = 0;
let checked = 0;
const check = (name, ok, detail = '') => {
  checked++;
  console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? `, ${detail}` : ''}`);
  if (!ok) failed++;
};

const ROWS = [
  { path: 'memory', disposition: 'INDEX' },
  { path: 'secret', disposition: 'INDEX' },
  { path: 'templates', disposition: 'SKIP', reason: 'boilerplate scaffolding, not authored memory' },
];
const DENY = 'secret/deals';
const vec = (s) => [s, Math.sqrt(1 - s * s), 0, 0];
const sandboxes = [];
process.on('exit', () => { for (const s of sandboxes) rmSync(s, { recursive: true, force: true }); });

function makeSandbox(name, mutate = null) {
  const root = mkdtempSync(path.join(os.tmpdir(), `loud-${name}-`));
  sandboxes.push(root);
  const sem = path.join(root, 'daemons', 'semantic-search');
  mkdirSync(path.join(root, 'daemons', 'memory-hygiene'), { recursive: true });
  mkdirSync(sem, { recursive: true });
  for (const f of ['deny-list.mjs', 'namespace-registry.mjs', 'search-vault.js']) copyFileSync(path.join(SEM, f), path.join(sem, f));
  for (const f of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'memory-root.cjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, f), path.join(root, 'daemons', f));
  }
  copyFileSync(path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'), path.join(root, 'daemons', 'memory-hygiene', 'resume-framing.mjs'));
  writeFileSync(path.join(sem, 'namespace-registry.json'), JSON.stringify({ schema: 'MemoryNamespaceRegistry/v1', namespaces: ROWS }, null, 2));
  writeFileSync(path.join(sem, 'index-deny.json'), JSON.stringify({ deny_prefixes: [DENY] }));
  if (mutate) {
    const f = path.join(sem, 'search-vault.js');
    writeFileSync(f, mutate(readFileSync(f, 'utf8')));
  }
  const stub = path.join(root, 'node_modules', '@xenova', 'transformers');
  mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: '@xenova/transformers', version: '0.0.0-test-stub', type: 'module', main: 'index.js' }));
  writeFileSync(path.join(stub, 'index.js'), 'export async function pipeline() { return async () => ({ data: Float32Array.from([1, 0, 0, 0]) }); }\n');
  const vault = path.join(root, 'vault');
  mkdirSync(path.join(vault, 'memory'), { recursive: true });
  return { root, sem, vault, embeddings: path.join(vault, 'memory', 'embeddings.json') };
}

// rows: [path, score, onDisk]. A row whose source is on disk gets a real note
// file; the other rows' sources are removed, so each seed is self-contained.
function seed(box, rows) {
  for (const [p, , onDisk] of rows) {
    const f = path.join(box.vault, p);
    if (!onDisk) { rmSync(f, { force: true }); continue; }
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, `# ${p}\n\nbody\n`);
  }
  writeFileSync(box.embeddings, JSON.stringify({
    model: 'Xenova/all-MiniLM-L6-v2', updated: '2020-01-01T00:00:00.000Z', entryCount: rows.length,
    notes: rows.map(([p, s]) => ({ path: p, title: path.basename(p, '.md'), tags: [], chunk: `body of ${p}`, embedding: vec(s), mtime: 0 })),
  }));
}

function search(box, args) {
  const r = spawnSync(process.execPath, [path.join(box.sem, 'search-vault.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, AIGENT_ROOT: box.root, AIGENT_VAULT_ROOT: box.vault, AIGENT_SEARCH_INVOCATION: 'tok-loud0001' },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const json = args.includes('--json');
  const marker = stdout.lastIndexOf('\nJSON:\n');
  const block = json ? stdout.trim() : marker === -1 ? null : stdout.slice(marker + '\nJSON:\n'.length).trim();
  let rows = null;
  try { rows = block === null ? null : JSON.parse(block); } catch { rows = null; }
  // The scorer's window (run-recollection.mjs populationLoadOutput): stdout up to the query echo, plus all of stderr.
  const q = stdout.indexOf('\nQuery: "');
  const window = (q === -1 ? stdout : stdout.slice(0, q)) + stderr;
  const loud = stderr.split(/\r?\n/).filter((l) => /indexed source missing/.test(l));
  return { status: r.status, stdout, stderr, rows, window, loud, paths: (rows || []).map((x) => x.path) };
}

const CLEAN = [['memory/kept-a.md', 0.9, true], ['memory/kept-b.md', 0.8, true], ['memory/kept-c.md', 0.4, true]];
const GONE = 'memory/gone.md';
const WITH_GONE = [...CLEAN, [GONE, 0.85, false], [GONE, 0.70, false]];
const FILTERED = [...CLEAN, [`${DENY}/term-sheet.md`, 0.95, false], ['templates/outline.md', 0.9, false]];

const quiet = (box) => { seed(box, CLEAN); const r = search(box, ['what is kept']); return r.status === 0 && r.loud.length === 0 && r.paths.length === 3; };
const namesGone = (box) => { seed(box, WITH_GONE); const r = search(box, ['what is kept']); return r.status === 0 && r.loud.length === 1 && r.window.includes(GONE); };
const filteredUnnamed = (box) => { seed(box, FILTERED); const r = search(box, ['what is kept']); return r.status === 0 && !r.stderr.includes('term-sheet') && !r.stderr.includes('outline') && r.loud.length === 0; };

const box = makeSandbox('main');
check('clean corpus: every source present, nothing announced, results unchanged', quiet(box));
{
  seed(box, CLEAN);
  const before = search(box, ['what is kept']).paths;
  seed(box, WITH_GONE);
  const r = search(box, ['what is kept']);
  check('deleted source: named once on stderr (two rows, one path), exit 0', namesGone(box), JSON.stringify(r.loud));
  check('deleted source: the name is inside the population-load window, before the query echo on stdout', r.window.includes(GONE) && !r.stdout.slice(0, r.stdout.indexOf('\nQuery: "')).includes('indexed source missing'));
  check('deleted source: results are what the index holds, unchanged by the announcement (the dangling row still ranks)',
    JSON.stringify(r.paths) === JSON.stringify(['memory/kept-a.md', GONE, 'memory/kept-b.md', 'memory/kept-c.md']), JSON.stringify(r.paths));
  check('clean corpus results were the three kept notes', JSON.stringify(before) === JSON.stringify(['memory/kept-a.md', 'memory/kept-b.md', 'memory/kept-c.md']), JSON.stringify(before));
  const j = search(box, ['what is kept', '--json']);
  check('--json: stdout is still a parseable array and stderr still names the source', Array.isArray(j.rows) && j.loud.length === 1 && j.stderr.includes(GONE));
}
check('filtered rows are never named: a DENY-prefix and a SKIP row without sources stay silent', filteredUnnamed(box));
{
  seed(box, [['memory/kept-a.md', 0.2, true], [GONE, 0.1, false]]);
  const r = search(box, ['off topic']);
  const side = r.stderr.split(/\r?\n/).filter((l) => l.startsWith('AIGENT_ABSTAIN'));
  check('abstention unchanged: one sidecar line, results [], and the missing source is still named', r.status === 0 && Array.isArray(r.rows) && r.rows.length === 0 && side.length === 1 && r.loud.length === 1, JSON.stringify(side));
}
{
  const missing = makeSandbox('missing');
  const r = search(missing, ['anything']);
  check('missing index: exit 1, the existing message, nothing announced', r.status === 1 && /Embeddings index not found/.test(r.stderr) && r.loud.length === 0, `${r.status}`);
  const und = makeSandbox('undeclared');
  seed(und, WITH_GONE);
  mkdirSync(path.join(und.vault, 'rogue'), { recursive: true });
  const u = search(und, ['anything']);
  check('undeclared directory: refusal exit unchanged, nothing announced', u.status !== 0 && /REFUSING to run/.test(u.stderr) && u.loud.length === 0, `${u.status}`);
}

// ── MUTATION WITNESSES ───────────────────────────────────────────────────────
const once = (src, from, to) => {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`mutation anchor found ${n} time(s): ${from.trim().slice(0, 80)}`);
  return src.replace(from, () => to);
};
const MISSING_LINE = '  const missingSources = [...new Set(index.notes.map((n) => n.path))].filter((p) => !isFile(join(VAULT_ROOT, p)));';
const ANNOUNCE_LINE = '  for (const p of missingSources) console.error(`search-vault: indexed source missing at load: ${inert(p, 200)} (stale index rows; re-run embed-vault.js)`);';
const witness = (name, mutate, run, expectRed) => {
  let ok;
  try { ok = run(makeSandbox(name, mutate)); } catch (e) { check(`WITNESS ${name}: mutation applies`, false, e.message); return; }
  check(`WITNESS ${name}: ${expectRed}`, ok === false);
};
witness('alarm-on-everything', (s) => once(s, MISSING_LINE, '  const missingSources = [...new Set(index.notes.map((n) => n.path))];'),
  quiet, 'the clean-corpus silence check goes red');
witness('announcement-removed', (s) => once(s, ANNOUNCE_LINE, ''), namesGone, 'the deleted-source check goes red');
witness('checked-before-filters', (s) => once(s, '  const beforeDeny = index.notes.length;',
  `${MISSING_LINE.replace('missingSources', 'early')}\n  for (const p of early) console.error(\`search-vault: indexed source missing at load: \${inert(p, 200)}\`);\n  const beforeDeny = index.notes.length;`),
  filteredUnnamed, 'the filtered-path-never-named check goes red');

console.log(`${failed === 0 ? 'All' : `${failed} of`} ${checked} loudness checks ${failed === 0 ? 'passed' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
