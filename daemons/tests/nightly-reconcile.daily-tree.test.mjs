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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reconcileAttention } from '../nightly-reconcile.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'nightly-reconcile.mjs');
const AS_OF = '2026-11-18';

function write(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function reconcile(layout, { asOf = AS_OF, stateHome = null, cleanup = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'reconcile-daily-'));
  try {
    layout(root);
    return spawnSync(process.execPath, [CLI, '--root', root, '--as-of', asOf], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
      env: { ...process.env, AIGENT_STATE_HOME_DIR: stateHome ? path.join(root, stateHome) : '', AIGENT_ROOT: '' },
    });
  } finally {
    if (cleanup) cleanup(root);
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
  let foldsCase = false;
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: 'Vault/memory' }));
    write(root, 'Vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n- Beta\n');
    foldsCase = existsSync(path.join(root, 'VAULT', 'daily'));
  });
  if (!foldsCase) { t.skip('Windows and macOS case-insensitive volumes only'); return; }
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

// Second review of 6ca42d44 (titus, 2026-11-19): six findings, one test each.

const aliasNote = (alias) => `---\naliases:\n  - ${alias}\n---\n# note\n`;

test('each note resolves links against its own vault, so an alias in both vaults is not merged', () => {
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: '.seat/vault/memory' }));
    write(root, '.seat/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, '.seat/vault/projects/Alpha.md', aliasNote('Shared'));
    write(root, 'vault/projects/Gamma.md', aliasNote('Shared'));
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha and [[Shared]]\n');
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /project=Alpha points=1 /, r.stdout);
  assert.match(r.stdout, /non_tier_1 points=[1-9]/, r.stdout);
});

test('an in-window note that is a symlink to a regular file is read', (t) => {
  let linked = true;
  const r = reconcile((root) => {
    write(root, 'vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, 'elsewhere/note.md', '- Alpha\n');
    mkdirSync(path.join(root, 'vault', 'daily'), { recursive: true });
    try {
      symlinkSync(path.join(root, 'elsewhere', 'note.md'), path.join(root, 'vault', 'daily', `${AS_OF}.md`), 'file');
    } catch { linked = false; }
  });
  if (!linked) { t.skip('POSIX accounts with symlink rights only'); return; }
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /project=Alpha points=1 /);
});

test('a vault with no selected daily note never has its project notes opened', (t) => {
  let locked = false;
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: '.seat/vault/memory' }));
    write(root, '.seat/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `.seat/vault/daily/${AS_OF}.md`, '- Alpha\n');
    write(root, 'vault/projects/Gamma.md', '# Gamma\n');
    const gamma = path.join(root, 'vault', 'projects', 'Gamma.md');
    chmodSync(gamma, 0o000);
    try { readFileSync(gamma); } catch { locked = true; }
  });
  if (!locked) { t.skip('POSIX non-root accounts only'); return; }
  assert.equal(r.status, 0, r.stderr);
});

test('reconcileAttention still scores an array of plain note strings for one date', () => {
  const result = reconcileAttention({ prioritiesText: PRIORITIES, dailyNotes: { [AS_OF]: ['- Alpha', '- Alpha'] }, asOf: AS_OF });
  assert.match(result.output, /project=Alpha points=2 /);
  assert.match(result.output, /notes=2\b/);
});

test('a receipt keeps a literal backslash in a POSIX directory name', (t) => {
  if (process.platform === 'win32') { t.skip('POSIX directory names with a backslash only'); return; }
  const r = reconcile((root) => {
    write(root, 'seat\\archive/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `seat\\archive/vault/daily/${AS_OF}.md`, '- Alpha\n');
  }, { stateHome: 'seat\\archive' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sources=.*seat\\archive\/vault\/daily\//, r.stdout);
});

test('an invalid --as-of fails with the established error before any tree is scanned', () => {
  for (const asOf of ['2026-13-01', 'bad']) {
    const r = reconcile((root) => {
      write(root, 'vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
      write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n');
    }, { asOf });
    assert.equal(r.status, 1, asOf);
    assert.match(r.stderr, /RECONCILE FAIL reason=invalid-as-of/, `${asOf}: ${r.stderr}`);
  }
});

// Third review of 96577e1c (titus, 2026-11-19).

test('a null daily value is scored as an empty note, not a crash', () => {
  const result = reconcileAttention({ prioritiesText: PRIORITIES, dailyNotes: { [AS_OF]: '- Alpha', '2026-11-17': null }, asOf: AS_OF });
  assert.match(result.output, /project=Alpha points=1 /);
});

test('an in-window daily note that cannot be read fails the run loudly', (t) => {
  let locked = false;
  const r = reconcile((root) => {
    write(root, 'vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `vault/daily/${AS_OF}.md`, '- Alpha\n');
    write(root, 'vault/daily/2026-11-17.md', '- Beta\n');
    const sealed = path.join(root, 'vault', 'daily', '2026-11-17.md');
    chmodSync(sealed, 0o000);
    try { readFileSync(sealed); } catch { locked = true; }
  });
  if (!locked) { t.skip('POSIX non-root accounts only'); return; }
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /RECONCILE FAIL reason=daily-/, r.stderr);
});

// Fourth review of cdc451fe (titus, 2026-11-19).

test('a hook vault the run cannot traverse fails loudly instead of reading as absent', (t) => {
  let sealed = false;
  const r = reconcile((root) => {
    write(root, '.aigent/state.json', JSON.stringify({ memory_root: '.seat/vault/memory' }));
    write(root, '.seat/vault/memory/ACTIVE_PRIORITIES.md', PRIORITIES);
    write(root, `.seat/vault/daily/${AS_OF}.md`, '- Alpha\n');
    write(root, `vault/daily/${AS_OF}.md`, '- Beta\n');
    chmodSync(path.join(root, 'vault'), 0o000);
    try { readdirSync(path.join(root, 'vault', 'daily')); } catch { sealed = true; }
  }, { cleanup: (root) => chmodSync(path.join(root, 'vault'), 0o700) });
  if (!sealed) { t.skip('POSIX non-root accounts only'); return; }
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /RECONCILE FAIL reason=daily-tree-unreadable path=vault\/daily/, r.stderr);
});
