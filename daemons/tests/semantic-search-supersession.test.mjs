// semantic-search-supersession.test.mjs -- validity-window demotion guard.
//
// search-vault.js demotes a chunk whose frozen body line `Valid from <date> to
// <date>` names a window that has ENDED below every chunk whose window has not.
// This suite is the CI-runnable witness for that behaviour. It runs against a
// hand-built index and the transformers STUB, so it needs no model download and
// is safe under the CI glob at .github/workflows/ci.yml:71 (CI installs
// daemons/transport-deps only, never daemons/semantic-search/node_modules).
//
// The real-model, real-corpus witness for the same behaviour is
// evals/recollection/witness-temporal.mjs, which asserts the eight frozen
// temporal cases of PREREG-001 3.4 and cannot run in CI for that reason.
//
// Mutation witness (runs on every invocation): AIGENT_SEARCH_DISABLE_SUPERSESSION=1
// turns the demotion off, and the expired row returns to rank 1 ahead of the
// current one. Without that leg, a demotion that silently stopped firing would
// be indistinguishable from one that never fired.
//
// Run: node daemons/tests/semantic-search-supersession.test.mjs

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  { path: 'templates', disposition: 'SKIP', reason: 'boilerplate scaffolding, not authored memory' },
];

// The stub embeds every query as [1,0,0,0]; a note embedded as
// [s, sqrt(1-s^2), 0, 0] therefore scores cosine exactly s, which makes the
// ranking in this suite arithmetic rather than a model's opinion.
const TRANSFORMERS_STUB = `export async function pipeline() {
  return async () => ({ data: Float32Array.from([1, 0, 0, 0]) });
}
`;
const vec = (s) => [s, Math.sqrt(1 - s * s), 0, 0];

const sandboxes = [];
process.on('exit', () => { for (const s of sandboxes) rmSync(s, { recursive: true, force: true }); });

function makeSandbox(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `supersession-${name}-`));
  sandboxes.push(root);
  const sem = path.join(root, 'daemons', 'semantic-search');
  const hygiene = path.join(root, 'daemons', 'memory-hygiene');
  mkdirSync(sem, { recursive: true });
  mkdirSync(hygiene, { recursive: true });
  for (const f of ['deny-list.mjs', 'namespace-registry.mjs', 'search-vault.js']) {
    copyFileSync(path.join(SEM, f), path.join(sem, f));
  }
  // memory-root.cjs joined the sandbox when the product base moved from 6c2d16f to
  // 349d181: search-vault.js and embed-vault.js now resolve the memory tree
  // through it (master fe1349c), and a sandbox without it fails at import, not
  // at a check. Same copy list precompact-flush.test.mjs uses.
  for (const f of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'memory-root.cjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, f), path.join(root, 'daemons', f));
  }
  copyFileSync(path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'), path.join(hygiene, 'resume-framing.mjs'));
  writeFileSync(path.join(sem, 'namespace-registry.json'), JSON.stringify({ schema: SCHEMA, namespaces: ROWS }, null, 2));
  writeFileSync(path.join(sem, 'index-deny.json'), '{"deny_prefixes":[]}');

  const stub = path.join(root, 'node_modules', '@xenova', 'transformers');
  mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
    name: '@xenova/transformers', version: '0.0.0-test-stub', type: 'module', main: 'index.js',
  }));
  writeFileSync(path.join(stub, 'index.js'), TRANSFORMERS_STUB);

  const vault = path.join(root, 'vault');
  mkdirSync(path.join(vault, 'memory'), { recursive: true });
  return { root, sem, vault, embeddings: path.join(vault, 'memory', 'embeddings.json') };
}

const body = (title, line) => `# ${title}\n\n${line ? `${line}\n\n` : ''}`
  + 'This authored paragraph exists so the stored chunk is a realistic length and the '
  + 'validity line is not the whole of the note body.';

// path, cosine score, validity line. Ordered by score descending, which is the
// order the product produces before any demotion.
const NOTES = [
  ['memory/rule-superseded.md', 0.99, 'Valid from 2020-01-01 to 2021-12-31'],
  ['memory/rule.md', 0.90, 'Valid from 2022-01-01'],
  ['memory/filler-a.md', 0.80, null],
  ['memory/filler-b.md', 0.70, null],
  ['memory/filler-c.md', 0.60, null],
  ['memory/filler-d.md', 0.50, null],
  ['memory/open-window.md', 0.40, 'Valid from 2019-05-05'],
  ['memory/future-window.md', 0.30, 'Valid from 2020-01-01 to 2999-12-31'],
  ['memory/malformed-window.md', 0.20, 'Valid from 2020-01-01 to not-a-date'],
];

const EXPIRED = 'memory/rule-superseded.md';
const CURRENT = 'memory/rule.md';
const MALFORMED = 'memory/malformed-window.md';
const COSINE_ORDER = NOTES.map(([p]) => p);
// Every path except the one expired row, in cosine order, then the expired row.
const DEMOTED_ORDER = [...COSINE_ORDER.filter((p) => p !== EXPIRED), EXPIRED];

function indexText(rows) {
  const notes = rows.map(([p, s, line]) => ({
    path: p,
    title: path.basename(p, '.md'),
    tags: [],
    chunk: body(path.basename(p, '.md'), line).slice(0, 500),
    embedding: vec(s),
    mtime: 0,
  }));
  return JSON.stringify({
    model: 'Xenova/all-MiniLM-L6-v2', updated: '2020-01-01T00:00:00.000Z',
    noteCount: notes.length, entryCount: notes.length, notes,
  });
}

function search(box, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(box.sem, 'search-vault.js'), ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, AIGENT_ROOT: box.root, AIGENT_VAULT_ROOT: box.vault, ...env },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const marker = stdout.lastIndexOf('\nJSON:\n');
  let rows = null;
  if (marker !== -1) {
    try { rows = JSON.parse(stdout.slice(marker + '\nJSON:\n'.length).trim()); } catch { rows = null; }
  }
  // search-vault.js renders each result's path through inert(), i.e. JSON.stringify
  // of the bounded single-line value (lifecycle-common.mjs:283-287).
  const head = marker === -1 ? stdout : stdout.slice(0, marker);
  const humanPaths = [...head.matchAll(/^ {3}Path: (.+)$/gm)].map((m) => {
    try { return JSON.parse(m[1].trim()); } catch { return m[1].trim(); }
  });
  return { status: r.status, stdout, stderr, rows, humanPaths, paths: (rows || []).map((x) => x.path) };
}

const box = makeSandbox('main');
writeFileSync(box.embeddings, indexText(NOTES));

// ── the demotion, on by default ──────────────────────────────────────────────
{
  const res = search(box, ['what is the rule']);
  check('default: search exits 0', res.status === 0, res.stderr.slice(0, 300));
  check('default: five rows returned', res.paths.length === 5, JSON.stringify(res.paths));
  check('default: the ENDED window is absent from the top 5', !res.paths.includes(EXPIRED), JSON.stringify(res.paths));
  check('default: the current note is rank 1', res.paths[0] === CURRENT, JSON.stringify(res.paths));
  check('default: the non-expired rows keep their cosine order',
    JSON.stringify(res.paths) === JSON.stringify(DEMOTED_ORDER.slice(0, 5)), JSON.stringify(res.paths));
  check('default: human render and JSON block agree, so both output paths come from one decision',
    JSON.stringify(res.humanPaths) === JSON.stringify(res.paths),
    `${JSON.stringify(res.humanPaths)} vs ${JSON.stringify(res.paths)}`);
}

// ── demoted, never dropped ───────────────────────────────────────────────────
{
  const res = search(box, ['what is the rule', '--top', '10']);
  check('--top 10: every row is still returned, nothing is dropped',
    res.paths.length === NOTES.length, JSON.stringify(res.paths));
  check('--top 10: the ENDED window is demoted to last, below every non-expired row',
    JSON.stringify(res.paths) === JSON.stringify(DEMOTED_ORDER), JSON.stringify(res.paths));
  check('--top 10: an OPEN window is never demoted',
    res.paths.indexOf('memory/open-window.md') === DEMOTED_ORDER.indexOf('memory/open-window.md'));
  check('--top 10: a closed window that has NOT yet ended is never demoted',
    res.paths.indexOf('memory/future-window.md') === DEMOTED_ORDER.indexOf('memory/future-window.md'));
  check('--top 10: rows with no validity line are untouched',
    res.paths.slice(1, 5).join('|') === 'memory/filler-a.md|memory/filler-b.md|memory/filler-c.md|memory/filler-d.md',
    JSON.stringify(res.paths));
}

// ── a date it cannot read is loud, and never acted on ────────────────────────
{
  const res = search(box, ['what is the rule', '--top', '10']);
  check('malformed date: named on stderr', res.stderr.includes(MALFORMED), res.stderr.slice(0, 300));
  check('malformed date: reported as unreadable rather than treated as expired',
    /unreadable validity/i.test(res.stderr), res.stderr.slice(0, 300));
  check('malformed date: the row keeps its cosine rank, no silent demotion',
    res.paths.indexOf(MALFORMED) === DEMOTED_ORDER.indexOf(MALFORMED), JSON.stringify(res.paths));
  check('malformed date: exactly one row is reported',
    (res.stderr.match(/unreadable validity/gi) || []).length === 1, res.stderr.slice(0, 300));
}

// ── stderr stays quiet when every date is readable ───────────────────────────
{
  const clean = makeSandbox('clean');
  const readable = NOTES.filter(([p]) => p !== MALFORMED);
  // Every indexed row gets its source file: search-vault names a missing source
  // on stderr at load, and this check is about a healthy, readable corpus.
  for (const [p] of readable) writeFileSync(path.join(clean.vault, p), body(path.basename(p, '.md'), null));
  writeFileSync(clean.embeddings, indexText(readable));
  const res = search(clean, ['what is the rule']);
  check('readable corpus: nothing is written to stderr', res.stderr === '', res.stderr.slice(0, 300));
  check('readable corpus: the ENDED window is still demoted out of the top 5', !res.paths.includes(EXPIRED));
}

// ── MUTATION WITNESS: turn the demotion off and watch the stale note return ──
{
  const off = search(box, ['what is the rule', '--top', '10'], { AIGENT_SEARCH_DISABLE_SUPERSESSION: '1' });
  check('WITNESS: with the demotion disabled the ENDED window is rank 1 again',
    off.paths[0] === EXPIRED, JSON.stringify(off.paths));
  check('WITNESS: with the demotion disabled the order is pure cosine',
    JSON.stringify(off.paths) === JSON.stringify(COSINE_ORDER), JSON.stringify(off.paths));
  const offTop5 = search(box, ['what is the rule'], { AIGENT_SEARCH_DISABLE_SUPERSESSION: '1' });
  check('WITNESS: with the demotion disabled the ENDED window is inside the top 5',
    offTop5.paths.includes(EXPIRED), JSON.stringify(offTop5.paths));

  const back = search(box, ['what is the rule', '--top', '10']);
  check('WITNESS: restoring the default demotes it again',
    JSON.stringify(back.paths) === JSON.stringify(DEMOTED_ORDER), JSON.stringify(back.paths));
  console.log(off.paths[0] === EXPIRED && back.paths[back.paths.length - 1] === EXPIRED
    ? 'WITNESS GREEN: disabling the demotion restores the ended window to rank 1, and the default demotes it to last'
    : 'WITNESS RED: the demotion is not what moved the ended window');
}

// ── EDGE: the boundary, the clock, the calendar, and per-note expiry ─────────
// Round-4 review (F1 to F3): three mutations survived the rows above because
// every fixture date sat years from the boundary and no note had two chunks.
// AIGENT_SEARCH_NOW pins the clock so these rows assert fixed instants.
{
  const EDGE_NOTES = [
    ['memory/ends-today.md', 0.99, 'Valid from 2026-01-01 to 2026-09-29'],
    ['memory/long-note.md', 0.94, 'Valid from 2020-01-01 to 2021-12-31'],
    ['memory/impossible-day.md', 0.90, 'Valid from 2020-01-01 to 2021-02-30'],
    ['memory/filler-a.md', 0.80, null],
    ['memory/filler-b.md', 0.70, null],
    ['memory/filler-c.md', 0.60, null],
    ['memory/filler-d.md', 0.50, null],
  ];
  const edge = makeSandbox('edge');
  // The long note's second chunk carries no validity line and OUTSCORES the
  // chunk that does. search-vault keeps one row per path (its best chunk), so
  // the row that survives is the line-less one: only path-level expiry can
  // demote it. Per-chunk expiry would leave it at rank 2.
  const parsed = JSON.parse(indexText(EDGE_NOTES));
  parsed.notes.splice(1, 0, {
    path: 'memory/long-note.md', title: 'long-note', tags: [], mtime: 0,
    chunk: body('long-note (continued)', null).slice(0, 500), embedding: vec(0.95),
  });
  parsed.noteCount = parsed.entryCount = parsed.notes.length;
  writeFileSync(edge.embeddings, JSON.stringify(parsed));
  const at = (iso, extra = {}) => search(edge, ['what is the rule', '--top', '10'], { AIGENT_SEARCH_NOW: iso, ...extra });

  const early = at('2026-09-29T00:00:00.000Z');
  check('boundary: at the first instant of the end date the window has NOT ended',
    early.paths[0] === 'memory/ends-today.md', JSON.stringify(early.paths));
  const last = at('2026-09-29T23:59:59.999Z');
  check('boundary: at the last instant of the end date the window has NOT ended',
    last.paths[0] === 'memory/ends-today.md', JSON.stringify(last.paths));
  const after = at('2026-09-30T00:00:00.000Z');
  check('boundary: one millisecond into the next day the window HAS ended',
    after.paths[0] !== 'memory/ends-today.md' && after.paths.includes('memory/ends-today.md'), JSON.stringify(after.paths));
  const tz = at('2026-09-29T23:59:59.999Z', { TZ: 'Etc/GMT-14' });
  check('boundary: the end is anchored to UTC, not the reader\'s timezone (TZ=UTC+14 does not end it early)',
    tz.paths[0] === 'memory/ends-today.md', JSON.stringify(tz.paths));

  check('per-note expiry: the surviving line-less chunk of the long note is demoted to last (expiry keyed by path, not chunk)',
    early.paths.filter((p) => p === 'memory/long-note.md').length === 1
      && early.paths[early.paths.length - 1] === 'memory/long-note.md',
    JSON.stringify(early.paths));

  check('impossible day: 2021-02-30 is reported as unreadable, not parsed as March 2',
    /unreadable validity/i.test(early.stderr) && early.stderr.includes('memory/impossible-day.md'), early.stderr.slice(0, 300));
  check('impossible day: the row keeps its cosine rank',
    early.paths.indexOf('memory/impossible-day.md') === 1, JSON.stringify(early.paths));

  const bad = search(edge, ['what is the rule'], { AIGENT_SEARCH_NOW: 'yesterday' });
  check('clock override: an unreadable AIGENT_SEARCH_NOW is refused loudly (exit 1), never ignored',
    bad.status === 1 && /AIGENT_SEARCH_NOW/.test(bad.stderr), `${bad.status} ${bad.stderr.slice(0, 200)}`);
}

console.log(`${failed === 0 ? 'All' : `${failed} of`} ${checked} supersession checks ${failed === 0 ? 'passed' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
