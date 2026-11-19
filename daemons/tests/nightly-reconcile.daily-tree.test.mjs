// nightly-reconcile.daily-tree.test.mjs: reconcile reads the daily notes the hooks write.
//
// hooks/auto-capture.sh and hooks/session-capture-summary.sh write
// <root>/vault/daily/<date>.md. Reconcile read <vaultRoot>/daily, where
// vaultRoot is the parent of the memory root. With the default memory root
// (vault/memory) those are the same folder; with a declared memory root
// (.aigent/state.json memory_root, e.g. a seat's .seat/vault/memory) reconcile
// read a folder nothing writes, and reported no attention at all. Measured on
// the davinci seat 2026-11-19: hooks in vault/daily through that day, reconcile
// reading .davinci/vault/daily, last written 2026-11-10.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'nightly-reconcile.mjs');
const AS_OF = '2026-11-18';

function write(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function reconcile(layout) {
  const root = mkdtempSync(path.join(tmpdir(), 'reconcile-daily-'));
  try {
    layout(root);
    return spawnSync(process.execPath, [CLI, '--root', root, '--as-of', AS_OF], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
      env: { ...process.env, AIGENT_STATE_HOME_DIR: '', AIGENT_ROOT: '' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PRIORITIES = [
  '# Active Priorities', '',
  '| Tier | Project | Intended share |',
  '|---|---|---|',
  '| 1 | [[Alpha]] | 60% |',
  '| 1 | [[Beta]] | 40% |', '',
].join('\n');

test('a declared memory root still reads the hook-written <root>/vault/daily notes', () => {
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: '.seat/vault/memory' }));
    write(root, '.seat/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '# day\n\n- worked on Alpha all morning\n- Alpha again\n- Beta review\n');
  });
  assert.equal(r.status, 0, `reconcile must find the hook notes: ${r.stderr}`);
  assert.match(r.stdout, /project=Alpha points=[1-9]/);
});

test('notes in both trees for one date are both counted, and the default layout is unchanged', () => {
  const both = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: '.seat/vault/memory' }));
    write(root, '.seat/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n');
    write(root, `.seat/vault/daily/${AS_OF}.md`, '- Beta\n');
  });
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /project=Alpha points=1 /);
  assert.match(both.stdout, /project=Beta points=1 /);
  const plain = reconcile((root) => {
    write(root, 'vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n- Beta\n');
  });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /notes=1\b/, 'the default layout reads its one tree once');
  assert.match(plain.stdout, /project=Alpha points=1 .*\n.*project=Beta points=1 /);
});

test('the receipt counts and lists every file it scored', () => {
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: '.seat/vault/memory' }));
    write(root, '.seat/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n');
    write(root, `.seat/vault/daily/${AS_OF}.md`, '- Beta\n');
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /notes=2\b/);
  const sources = r.stdout.match(/^sources=(.*)$/m)[1].split(',');
  assert.equal(sources.length, 2, r.stdout);
  assert.ok(sources.some((s) => s.startsWith('vault/daily/')) && sources.some((s) => s.startsWith('.seat/vault/daily/')), r.stdout);
});

test('one folder reached by two spellings is read once (case-insensitive volume)', (t) => {
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: 'Vault/memory' }));
    write(root, 'Vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n- Beta\n');
    if (!existsSync(path.join(root, 'VAULT', 'daily'))) t.skip('case-sensitive volume: the two spellings are two folders');
  });
  if (r.status === null) return;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /notes=1\b/, r.stdout);
  assert.match(r.stdout, /project=Alpha points=1 /, r.stdout);
});

test('a hook-tree note resolves links against the project notes of its own tree', () => {
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: '.seat/vault/memory' }));
    write(root, '.seat/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, 'vault/projects/Gamma.md', '# Gamma\n');
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha and [[Gamma]]\n');
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /non_tier_1 points=[1-9]/, r.stdout);
});

test('a date-shaped directory or an out-of-window note is never opened', () => {
  const r = reconcile((root) => {
    write(root, 'vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n');
    mkdirSync(path.join(root, 'vault', 'daily', '2020-01-01.md'), { recursive: true });
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /notes=1\b/);
});
