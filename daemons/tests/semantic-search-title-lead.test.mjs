// semantic-search-title-lead.test.mjs -- issue #150.
//
// Measured after #149 on a real vault (2026-11-01): a title-exact query ranked
// its note 7th, below six plausible neighbours, so the default top 5 never
// showed it. search-vault.js now leads with an exact title or filename match,
// ahead of the vector order. The pass runs AFTER the deny and namespace
// filters, so a denied or SKIP note never leads, and BEFORE the supersession
// demotion, so an ended validity window still sinks.
//
// Same harness as semantic-search-supersession.test.mjs: a hand-built index and
// a transformers stub that embeds every query as [1,0,0,0], so a note embedded
// as [s, sqrt(1-s^2), 0, 0] scores cosine exactly s.
//
// Mutation witness: AIGENT_SEARCH_DISABLE_TITLE_LEAD=1 turns the pass off and
// the exact note falls back to rank 7.
//
// Run: node daemons/tests/semantic-search-title-lead.test.mjs

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
  { path: 'private', disposition: 'INDEX' },
  { path: 'templates', disposition: 'SKIP', reason: 'boilerplate scaffolding, not authored memory' },
];
const TRANSFORMERS_STUB = `export async function pipeline() {
  return async () => ({ data: Float32Array.from([1, 0, 0, 0]) });
}
`;
const vec = (s) => [s, Math.sqrt(1 - s * s), 0, 0];

const sandboxes = [];
process.on('exit', () => { for (const s of sandboxes) rmSync(s, { recursive: true, force: true }); });

function makeSandbox(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `title-lead-${name}-`));
  sandboxes.push(root);
  const sem = path.join(root, 'daemons', 'semantic-search');
  const hygiene = path.join(root, 'daemons', 'memory-hygiene');
  mkdirSync(sem, { recursive: true });
  mkdirSync(hygiene, { recursive: true });
  for (const f of ['deny-list.mjs', 'namespace-registry.mjs', 'search-vault.js']) {
    copyFileSync(path.join(SEM, f), path.join(sem, f));
  }
  for (const f of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'memory-root.cjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, f), path.join(root, 'daemons', f));
  }
  copyFileSync(path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'), path.join(hygiene, 'resume-framing.mjs'));
  writeFileSync(path.join(sem, 'namespace-registry.json'), JSON.stringify({ schema: SCHEMA, namespaces: ROWS }, null, 2));
  writeFileSync(path.join(sem, 'index-deny.json'), '{"deny_prefixes":["private/"]}');

  const stub = path.join(root, 'node_modules', '@xenova', 'transformers');
  mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
    name: '@xenova/transformers', version: '0.0.0-test-stub', type: 'module', main: 'index.js',
  }));
  writeFileSync(path.join(stub, 'index.js'), TRANSFORMERS_STUB);

  const vault = path.join(root, 'vault');
  for (const d of ['memory', 'private', 'templates']) mkdirSync(path.join(vault, d), { recursive: true });
  return { root, sem, vault, embeddings: path.join(vault, 'memory', 'embeddings.json') };
}

const body = (title, line) => `# ${title}\n\n${line ? `${line}\n\n` : ''}`
  + 'This authored paragraph exists so the stored chunk is a realistic length.';

// [path, title, cosine score, validity line]. The neighbours outscore the
// exact note, as measured: six of them sit above it.
const NOTES = [
  ['memory/family-index.md', 'Family index', 0.42, null],
  ['memory/related-a.md', 'Related A', 0.41, null],
  ['memory/related-b.md', 'Related B', 0.40, null],
  ['memory/related-c.md', 'Related C', 0.39, null],
  ['memory/related-d.md', 'Related D', 0.38, null],
  ['memory/related-e.md', 'Related E', 0.37, null],
  ['memory/fleet-reliability-mission.md', 'Fleet reliability mission', 0.34, null],
  ['memory/old-runbook.md', 'Old runbook', 0.33, 'Valid from 2020-01-01 to 2021-12-31'],
  ['memory/slug-only-note.md', 'A different display title', 0.32, null],
  ['private/secret-plan.md', 'Secret plan', 0.31, null],
  ['templates/daily-template.md', 'Daily template', 0.30, null],
];
const TARGET = 'memory/fleet-reliability-mission.md';

function indexText(rows) {
  const notes = rows.map(([p, title, s, line]) => ({
    path: p, title, tags: [], chunk: body(title, line).slice(0, 500), embedding: vec(s), mtime: 0,
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
  const marker = stdout.lastIndexOf('\nJSON:\n');
  let rows = null;
  if (marker !== -1) {
    try { rows = JSON.parse(stdout.slice(marker + '\nJSON:\n'.length).trim()); } catch { rows = null; }
  }
  return { status: r.status, stderr: r.stderr || '', paths: (rows || []).map((x) => x.path) };
}

const box = makeSandbox('main');
writeFileSync(box.embeddings, indexText(NOTES));

{
  const res = search(box, ['Fleet reliability mission']);
  check('exact title: search exits 0', res.status === 0, res.stderr.slice(0, 300));
  check('exact title: the note is rank 1 in the default top 5', res.paths[0] === TARGET, JSON.stringify(res.paths));
  check('exact title: the rest keep their cosine order',
    JSON.stringify(res.paths.slice(1)) === JSON.stringify(NOTES.slice(0, 4).map(([p]) => p)), JSON.stringify(res.paths));
}
{
  const res = search(box, ['  FLEET   Reliability   mission ']);
  check('normalized: case and whitespace do not matter', res.paths[0] === TARGET, JSON.stringify(res.paths));
}
{
  const res = search(box, ['slug only note']);
  check('filename: a query equal to the file name leads, with separators read as spaces',
    res.paths[0] === 'memory/slug-only-note.md', JSON.stringify(res.paths));
}
{
  const res = search(box, ['fleet reliability']);
  check('substring: a partial title does not lead (exact match only)', res.paths[0] === 'memory/family-index.md', JSON.stringify(res.paths));
  check('substring: and the order is pure cosine', !res.paths.includes(TARGET), JSON.stringify(res.paths));
}
{
  const res = search(box, ['Secret plan', '--top', '20']);
  check('DENY: an exact title under a denied prefix is never returned', !res.paths.includes('private/secret-plan.md'), JSON.stringify(res.paths));
}
{
  const res = search(box, ['Daily template', '--top', '20']);
  check('SKIP: an exact title in a SKIP namespace is never returned', !res.paths.includes('templates/daily-template.md'), JSON.stringify(res.paths));
}
{
  const res = search(box, ['Old runbook', '--top', '20']);
  check('supersession: an exact title whose window has ended is still demoted below current notes',
    res.paths[res.paths.length - 1] === 'memory/old-runbook.md', JSON.stringify(res.paths));
}
{
  const off = search(box, ['Fleet reliability mission', '--top', '10'], { AIGENT_SEARCH_DISABLE_TITLE_LEAD: '1' });
  check('WITNESS: with the pass disabled the exact note falls back to rank 7',
    off.paths.indexOf(TARGET) === 6, JSON.stringify(off.paths));
  const top5 = search(box, ['Fleet reliability mission'], { AIGENT_SEARCH_DISABLE_TITLE_LEAD: '1' });
  check('WITNESS: and outside the default top 5', !top5.paths.includes(TARGET), JSON.stringify(top5.paths));
}

console.log(`${failed === 0 ? 'All' : `${failed} of`} ${checked} title-lead checks ${failed === 0 ? 'passed' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
