#!/usr/bin/env node
/**
 * witness-temporal.mjs: red/green witness for temporal supersession.
 *
 * This is NOT a second benchmark runner (PREREG-001 8 forbids one). It scores
 * no class, applies no gate, computes no fixture hash and writes no result
 * packet. It asserts ONE product property, over the frozen corpus and the eight
 * frozen temporal queries, and exits non-zero when that property does not hold.
 *
 * The property, taken verbatim from PREREG-001 3.4:
 *   1. the CURRENT note's path is in the top 5;
 *   2. the SUPERSEDED note's path is NOT in the top 5;
 *   3. the current note's returned chunk contains its exact `Valid from ...` line.
 * plus the separate inversion record: any case where the superseded path
 * outranks the current path.
 *
 * Condition 2 is the load-bearing assertion. At the base commit the current
 * note is already rank 1 in six of the eight cases, so a witness that asserted
 * only the current note's rank would read GREEN against the unfixed product in
 * six of eight cases and prove nothing. That is the same vacuity the round-2
 * review of Phase B caught in the F3 inversion clause.
 *
 * It also asserts that the human render (search-vault.js:190-204) and the JSON
 * block (search-vault.js:172-179) list the same paths in the same order, so a
 * ranking decision applied to one output path and not the other is caught.
 *
 * Requires the real model, exactly as PREREG-001 4.3 items 2 and 3 require of
 * the benchmark, which is why this file lives here and NOT under daemons/tests/
 * (that directory is auto-discovered by CI, which does not install
 * daemons/semantic-search/node_modules, PREREG-001 7.3).
 *
 * Usage:
 *   node evals/recollection/witness-temporal.mjs [--keep]
 *
 * Mutation witness: AIGENT_SEARCH_DISABLE_SUPERSESSION=1 disables the product's
 * demotion, and this witness must go RED when it is set.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DAEMONS = path.join(ROOT, 'daemons');
const SEM = path.join(DAEMONS, 'semantic-search');
const CORPUS = path.join(HERE, 'corpus');
const FIXTURE_REGISTRY = path.join(HERE, 'fixture-registry');

// K = 5, matching DEFAULT_TOP_K at search-vault.js:48 and PREREG-001 3.1.
const K = 5;
const KEEP = process.argv.includes('--keep');

// ── sandbox, same recipe as the benchmark's makeSandbox (run-recollection.mjs
//    :177-228) minus the doctor prerequisites and the embed helper, which no
//    assertion here uses ──────────────────────────────────────────────────────
function makeSandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'witness-temporal-'));
  const sem = path.join(root, 'daemons', 'semantic-search');
  const hygiene = path.join(root, 'daemons', 'memory-hygiene');
  mkdirSync(sem, { recursive: true });
  mkdirSync(hygiene, { recursive: true });
  for (const f of ['deny-list.mjs', 'namespace-registry.mjs', 'embed-vault.js', 'search-vault.js', 'namespace-registry.json']) {
    copyFileSync(path.join(SEM, f), path.join(sem, f));
  }
  // memory-root.cjs joined the sandbox when the product base moved from 6c2d16f to
  // 349d181 (master fe1349c): embed-vault.js and search-vault.js import it.
  for (const f of ['frontmatter-reader.cjs', 'lifecycle-common.mjs', 'memory-root.cjs', 'capsule-content-gate.mjs']) {
    copyFileSync(path.join(DAEMONS, f), path.join(root, 'daemons', f));
  }
  copyFileSync(path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs'), path.join(hygiene, 'resume-framing.mjs'));
  // The real dependency, not a stub: a constant-vector stub cannot rank.
  symlinkSync(path.join(SEM, 'node_modules'), path.join(sem, 'node_modules'), 'junction');
  copyFileSync(path.join(FIXTURE_REGISTRY, 'namespace-registry.local.json'), path.join(sem, 'namespace-registry.local.json'));
  copyFileSync(path.join(FIXTURE_REGISTRY, 'index-deny.json'), path.join(sem, 'index-deny.json'));

  const vault = path.join(root, 'vault');
  cpSync(CORPUS, vault, { recursive: true });
  mkdirSync(path.join(vault, 'memory'), { recursive: true });
  return { root, sem, vault };
}

function runNode(box, script, args = []) {
  const r = spawnSync(process.execPath, [path.join(box.sem, script), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AIGENT_ROOT: box.root, AIGENT_VAULT_ROOT: box.vault },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// The bounded text is the trailing JSON string literal of the provenance tag
// line, same extraction as run-recollection.mjs:389-393.
function renderedText(line) {
  if (typeof line !== 'string') return null;
  const i = line.indexOf('] ');
  if (i === -1) return null;
  try { return JSON.parse(line.slice(i + 2)); } catch { return null; }
}

function search(box, query) {
  const r = runNode(box, 'search-vault.js', [query]);
  const marker = r.stdout.lastIndexOf('\nJSON:\n');
  let rows = null;
  if (marker !== -1) {
    try { rows = JSON.parse(r.stdout.slice(marker + '\nJSON:\n'.length).trim()); } catch { rows = null; }
  }
  // The human render's own path list, for the two-output-paths cross-check.
  // search-vault.js:198 renders the path through inert(), which is
  // JSON.stringify of the single-line bounded value (lifecycle-common.mjs:283-287),
  // so the printed token is a JSON string literal and is parsed back here.
  const head = marker === -1 ? r.stdout : r.stdout.slice(0, marker);
  const humanPaths = [...head.matchAll(/^ {3}Path: (.+)$/gm)].map((m) => {
    const raw = m[1].trim();
    try { return JSON.parse(raw); } catch { return raw; }
  });
  return { ...r, rows, humanPaths };
}

const rankOf = (rows, p) => {
  const i = (rows || []).findIndex((r) => r.path === p);
  return i === -1 ? null : i + 1;
};

// ── run ──────────────────────────────────────────────────────────────────────
const cases = JSON.parse(readFileSync(path.join(HERE, 'cases', 'queries.json'), 'utf8'))
  .cases.filter((c) => c.class === 'temporal');
if (cases.length !== 8) {
  console.error(`witness integrity: expected 8 temporal cases, found ${cases.length}`);
  process.exit(2);
}

const box = makeSandbox();
const build = runNode(box, 'embed-vault.js');
if (build.status !== 0) {
  console.error(`index build exited ${build.status}\n${build.stdout.slice(-2000)}${build.stderr.slice(-2000)}`);
  process.exit(2);
}

const rowsOut = [];
const inversions = [];
let failures = 0;

for (const c of cases) {
  const res = search(box, c.query);
  const fails = [];
  if (res.status !== 0) fails.push(`search exited ${res.status}`);
  if (!res.rows) fails.push('no JSON block parsed');

  const cur = rankOf(res.rows, c.current);
  const sup = rankOf(res.rows, c.superseded);
  if (sup !== null && (cur === null || sup < cur)) inversions.push(c.id);

  if (cur === null || cur > K) fails.push(`current note not in top ${K}`);
  if (sup !== null && sup <= K) fails.push(`superseded note present at rank ${sup}`);
  if (cur !== null && cur <= K) {
    const text = renderedText(res.rows[cur - 1].chunk);
    if (text === null || !text.includes(c.validLine)) fails.push(`returned chunk does not contain "${c.validLine}"`);
  }
  if (res.rows && res.humanPaths.join('|') !== res.rows.map((r) => r.path).join('|')) {
    fails.push(`human render and JSON block disagree: [${res.humanPaths}] vs [${res.rows.map((r) => r.path)}]`);
  }

  if (fails.length) failures++;
  rowsOut.push({ id: c.id, cur, sup, verdict: fails.length ? 'FAIL' : 'PASS', detail: fails.join('; ') });
}

if (!KEEP) rmSync(box.root, { recursive: true, force: true });
else console.log(`sandbox retained: ${box.root}`);

console.log('id     currentRank  supersededRank  verdict  detail');
for (const r of rowsOut) {
  console.log(`${r.id}   ${String(r.cur ?? '-').padStart(11)}  ${String(r.sup ?? '-').padStart(14)}  ${r.verdict.padEnd(7)}  ${r.detail}`);
}
const passed = rowsOut.length - failures;
console.log(`\ntemporal ${passed}/${rowsOut.length} · inversions ${inversions.length}${inversions.length ? ` [${inversions.join(', ')}]` : ''}`);
console.log(failures === 0 && inversions.length === 0 ? 'WITNESS GREEN' : 'WITNESS RED');
process.exit(failures === 0 && inversions.length === 0 ? 0 : 1);
