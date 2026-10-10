// semantic-search-abstain.test.mjs -- honest-abstention gate in search-vault.js.
//
// When nothing the deny and namespace filters left reaches the 0.30 floor, the
// product prints `[]` as its results block, writes exactly one stderr line
//   AIGENT_ABSTAIN {"schema":"abstain/1","invocation":"<token>","outcome":"abstain","reason":"<r>"}
// and exits 0 (recollection-44 PREREG-002 3.2 (b) and its sidecar wire contract).
// Hard errors (missing / malformed index, undeclared directory) keep their own
// non-zero exit and never emit the line (PREREG-002 section 8, ordering).
//
// Stub transformers, hand-built index, no model: CI-safe like the supersession
// suite. The stub embeds every query as [1,0,0,0], so a note embedded as
// [s, sqrt(1-s^2), 0, 0] scores cosine exactly s.
//
// Mutation witnesses (run every time, against sandbox copies of the product):
//   abstain-on-everything turns the POSITIVE checks red;
//   removing the sidecar emission turns the NEGATIVE checks red;
//   emitting the sidecar inside the results array is caught.
//
// Run: node daemons/tests/semantic-search-abstain.test.mjs

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

const SCHEMA = 'MemoryNamespaceRegistry/v1';
const ROWS = [
  { path: 'memory', disposition: 'INDEX' },
  { path: 'secret', disposition: 'INDEX' },
  { path: 'templates', disposition: 'SKIP', reason: 'boilerplate scaffolding, not authored memory' },
];
const DENY = 'secret/deals';
const TRANSFORMERS_STUB = `export async function pipeline() {
  return async () => ({ data: Float32Array.from([1, 0, 0, 0]) });
}
`;
const vec = (s) => [s, Math.sqrt(1 - s * s), 0, 0];

const sandboxes = [];
process.on('exit', () => { for (const s of sandboxes) rmSync(s, { recursive: true, force: true }); });

function makeSandbox(name, mutate = null) {
  const root = mkdtempSync(path.join(os.tmpdir(), `abstain-${name}-`));
  sandboxes.push(root);
  const sem = path.join(root, 'daemons', 'semantic-search');
  const hygiene = path.join(root, 'daemons', 'memory-hygiene');
  mkdirSync(sem, { recursive: true });
  mkdirSync(hygiene, { recursive: true });
  for (const f of ['deny-list.mjs', 'namespace-registry.mjs', 'search-vault.js']) copyFileSync(path.join(SEM, f), path.join(sem, f));
  for (const f of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'memory-root.cjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, f), path.join(root, 'daemons', f));
  }
  copyFileSync(path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'), path.join(hygiene, 'resume-framing.mjs'));
  writeFileSync(path.join(sem, 'namespace-registry.json'), JSON.stringify({ schema: SCHEMA, namespaces: ROWS }, null, 2));
  writeFileSync(path.join(sem, 'index-deny.json'), JSON.stringify({ deny_prefixes: [DENY] }));
  if (mutate) {
    const f = path.join(sem, 'search-vault.js');
    writeFileSync(f, mutate(readFileSync(f, 'utf8')));
  }
  const stub = path.join(root, 'node_modules', '@xenova', 'transformers');
  mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: '@xenova/transformers', version: '0.0.0-test-stub', type: 'module', main: 'index.js' }));
  writeFileSync(path.join(stub, 'index.js'), TRANSFORMERS_STUB);
  const vault = path.join(root, 'vault');
  mkdirSync(path.join(vault, 'memory'), { recursive: true });
  return { root, sem, vault, embeddings: path.join(vault, 'memory', 'embeddings.json') };
}

const writeIndex = (box, notes) => writeFileSync(box.embeddings, JSON.stringify({
  model: 'Xenova/all-MiniLM-L6-v2', updated: '2020-01-01T00:00:00.000Z', entryCount: notes.length,
  notes: notes.map(([p, s]) => ({ path: p, title: path.basename(p, '.md'), tags: [], chunk: `body of ${p}`, embedding: vec(s), mtime: 0 })),
}));

const PREFIX = 'AIGENT_ABSTAIN ';
function search(box, args, env = {}) {
  const base = { ...process.env };
  delete base.AIGENT_SEARCH_INVOCATION;
  const r = spawnSync(process.execPath, [path.join(box.sem, 'search-vault.js'), ...args], {
    encoding: 'utf8', env: { ...base, AIGENT_ROOT: box.root, AIGENT_VAULT_ROOT: box.vault, ...env },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const json = args.includes('--json');
  const marker = stdout.lastIndexOf('\nJSON:\n');
  const block = json ? stdout.trim() : marker === -1 ? null : stdout.slice(marker + '\nJSON:\n'.length).trim();
  let rows = null;
  try { rows = block === null ? null : JSON.parse(block); } catch { rows = null; }
  const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith('AIGENT_ABSTAIN'));
  let side = null;
  try { side = lines.length === 1 ? JSON.parse(lines[0].slice(PREFIX.length)) : null; } catch { side = null; }
  return { status: r.status, stdout, stderr, block, rows, lines, side };
}

// The two halves of the contract, as predicates the mutation witnesses reuse.
const TOKEN = 'tok-abcdef12';
function honestAbstention(res, reason) {
  return res.status === 0 && res.block === '[]' && Array.isArray(res.rows) && res.rows.length === 0
    && res.lines.length === 1 && res.lines[0].startsWith(PREFIX) && !!res.side
    && Object.keys(res.side).sort().join() === 'invocation,outcome,reason,schema'
    && res.side.schema === 'abstain/1' && res.side.outcome === 'abstain'
    && res.side.invocation === TOKEN && res.side.reason === reason
    && !res.stdout.includes('AIGENT_ABSTAIN');
}
function answered(res, paths) {
  return res.status === 0 && Array.isArray(res.rows) && JSON.stringify(res.rows.map((r) => r.path)) === JSON.stringify(paths)
    && res.lines.length === 0 && !res.stderr.includes('AIGENT_ABSTAIN');
}

const BELOW = [['memory/a.md', 0.29], ['memory/b.md', 0.10]];
const ABOVE = [['memory/hit.md', 0.31], ['memory/weak-a.md', 0.29], ['memory/weak-b.md', 0.05]];
const FILTERED_ALL = [[`${DENY}/term-sheet.md`, 0.95], ['templates/outline.md', 0.90]];
const FILTER_FIRST = [[`${DENY}/term-sheet.md`, 0.95], ['templates/outline.md', 0.90], ['memory/low.md', 0.20]];
const env = { AIGENT_SEARCH_INVOCATION: TOKEN };

function negativeLegs(box) {
  writeIndex(box, BELOW);
  const human = search(box, ['an off-topic question'], env);
  const json = search(box, ['an off-topic question', '--json'], env);
  writeIndex(box, FILTERED_ALL);
  const none = search(box, ['an off-topic question'], env);
  return { human, json, none };
}
function positiveLeg(box) {
  writeIndex(box, ABOVE);
  return search(box, ['what is the hit'], env);
}

// ── the gate on the product as shipped ───────────────────────────────────────
const box = makeSandbox('main');
{
  const { human, json, none } = negativeLegs(box);
  check('below-tau: exit 0, results block exactly [], one bound sidecar, reason below-tau', honestAbstention(human, 'below-tau'),
    `${human.status} ${JSON.stringify(human.block)} ${JSON.stringify(human.lines)}`);
  check('below-tau: the line is a single line carrying exactly the four keys, exact literals',
    human.lines.length === 1 && human.lines[0] === `${PREFIX}{"schema":"abstain/1","invocation":"${TOKEN}","outcome":"abstain","reason":"below-tau"}`, JSON.stringify(human.lines));
  check('below-tau: the sidecar is on stderr only, never in stdout or the results array', human.stdout !== '' && !human.stdout.includes('AIGENT_ABSTAIN'));
  check('below-tau --json: stdout is exactly [] and the sidecar is still emitted', honestAbstention(json, 'below-tau'), `${JSON.stringify(json.block)} ${JSON.stringify(json.lines)}`);
  check('no-eligible-candidates: the filters removed every row (the 0.95 and 0.90 rows never count), reason no-eligible-candidates',
    honestAbstention(none, 'no-eligible-candidates'), `${JSON.stringify(none.block)} ${JSON.stringify(none.lines)}`);
  check('no-eligible-candidates: no filtered path reaches the output', none.stdout !== '' && !none.stdout.includes('term-sheet') && !none.stdout.includes('outline'));
}
{
  writeIndex(box, FILTER_FIRST);
  const r = search(box, ['an off-topic question'], env);
  check('filters run before the gate: a denied 0.95 row and a SKIP 0.90 row do not stop a below-tau abstention on the 0.20 survivor',
    honestAbstention(r, 'below-tau'), `${JSON.stringify(r.block)} ${JSON.stringify(r.lines)}`);
}
{
  const r = positiveLeg(box);
  check('positive untouched: top-1 0.31 returns every row, including the two under the floor, and no sidecar',
    answered(r, ['memory/hit.md', 'memory/weak-a.md', 'memory/weak-b.md']), `${JSON.stringify(r.rows && r.rows.map((x) => x.path))} ${JSON.stringify(r.lines)}`);
  writeIndex(box, [['memory/edge.md', 0.30], ['memory/low.md', 0.01]]);
  const edge = search(box, ['edge'], env);
  check('positive untouched: a top-1 of exactly 0.30 reaches the floor and is answered', answered(edge, ['memory/edge.md', 'memory/low.md']), JSON.stringify(edge.lines));
}
{
  writeIndex(box, BELOW);
  const unset = search(box, ['an off-topic question']);
  check('invocation unset: the token is echoed as given (empty), never invented', unset.lines.length === 1 && !!unset.side && unset.side.invocation === '', JSON.stringify(unset.lines));
  const odd = search(box, ['an off-topic question'], { AIGENT_SEARCH_INVOCATION: 'x' });
  check('invocation outside 8-64 [A-Za-z0-9-]: still echoed verbatim, so a binding check fails it honestly', !!odd.side && odd.side.invocation === 'x', JSON.stringify(odd.lines));
}

// ── hard errors stay hard errors ─────────────────────────────────────────────
{
  const missing = makeSandbox('missing');
  const r = search(missing, ['anything'], env);
  check('missing index: non-zero exit, the existing message, no sidecar', r.status === 1 && /Embeddings index not found/.test(r.stderr) && r.lines.length === 0, `${r.status} ${r.stderr.slice(0, 160)}`);
  const bad = makeSandbox('malformed');
  writeFileSync(bad.embeddings, '{ not json');
  const m = search(bad, ['anything'], env);
  check('malformed index: non-zero exit, no sidecar', m.status === 1 && m.lines.length === 0, `${m.status} ${m.stderr.slice(0, 160)}`);
  const und = makeSandbox('undeclared');
  writeIndex(und, BELOW);
  mkdirSync(path.join(und.vault, 'rogue'), { recursive: true });
  const u = search(und, ['anything'], env);
  check('undeclared directory: namespace refusal keeps its non-zero exit, no sidecar', u.status !== 0 && /REFUSING to run/.test(u.stderr) && u.lines.length === 0, `${u.status} ${u.stderr.slice(0, 160)}`);
}

// ── MUTATION WITNESSES ───────────────────────────────────────────────────────
// Each mutation must land exactly once; a witness whose anchor vanished fails
// loudly, never passes vacuously.
const once = (src, from, to) => {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`mutation anchor found ${n} time(s): ${from.trim().slice(0, 80)}`);
  return src.replace(from, () => to);
};
const GATE_LINE = '  const abstention = abstentionReason(scored);';
const EMIT_LINE = "    console.error(`AIGENT_ABSTAIN ${JSON.stringify({ schema: 'abstain/1', invocation: process.env.AIGENT_SEARCH_INVOCATION ?? '', outcome: 'abstain', reason: abstention })}`);";
const witness = (name, mutate, run, expectRed) => {
  let ok;
  try { ok = run(makeSandbox(name, mutate)); } catch (e) { check(`WITNESS ${name}: mutation applies`, false, e.message); return; }
  check(`WITNESS ${name}: ${expectRed}`, ok === false);
};
witness('abstain-on-everything', (s) => once(s, GATE_LINE, "  const abstention = 'below-tau';"),
  (b) => answered(positiveLeg(b), ['memory/hit.md', 'memory/weak-a.md', 'memory/weak-b.md']),
  'the positive check goes red (a gate that always abstains cannot pass it)');
witness('no-sidecar', (s) => once(s, EMIT_LINE, ''),
  (b) => honestAbstention(negativeLegs(b).human, 'below-tau'),
  'the negative check goes red (silent zero rows are not an honest abstention)');
witness('sidecar-in-array', (s) => once(s, '  if (abstention) results.length = 0;',
  "  if (abstention) { results.length = 0; results.push({ path: 'AIGENT_ABSTAIN', title: '', chunk: '', score: 0 }); }"),
  (b) => honestAbstention(negativeLegs(b).human, 'below-tau'),
  'a sidecar row inside the results array is caught (the block is no longer [])');

console.log(`${failed === 0 ? 'All' : `${failed} of`} ${checked} abstention checks ${failed === 0 ? 'passed' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
