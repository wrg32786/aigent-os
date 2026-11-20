import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The capture cap counts real pending rows. The old-matcher floor in staged_count()
// guards nightly's digest skip only: a stray "| staged |" in prose must not cost a
// real candidate its row.
const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = path.join(DAEMONS, 'memory-capture.sh');
const HEADER = '| date | phrase | type | confidence | dest | status | digested_on | note |\n|---|---|---|---|---|---|---|---|\n';
const PROSE = 'A note that mentions the word | staged | inline.\n\n';
const rows = (n) => Array.from({ length: n },
  (_, i) => `| 2026-11-01 | "real candidate ${i}" | rule | high | CLAUDE.md | staged | | |\n`).join('');

function ledgerRoot(t, text) {
  const root = mkdtempSync(path.join(tmpdir(), 'capture-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'vault', 'memory'), { recursive: true });
  const file = path.join(root, 'vault', 'memory', 'MEMORY_CANDIDATES.md');
  writeFileSync(file, text);
  return { root, file };
}

function capture(root, prompt) {
  return spawnSync('bash', [CAPTURE], {
    input: prompt, encoding: 'utf8', env: { ...process.env, AIGENT_ROOT: root },
  });
}

function counts(text) {
  const args = ['-B', '-c', 'import json,sys;sys.path.insert(0,sys.argv[1]);'
    + 'from memory_candidates import staged_count,structured_count;t=sys.stdin.read();'
    + 'print(json.dumps([staged_count(t),structured_count(t)]))', DAEMONS];
  const options = { input: text, encoding: 'utf8' };
  let result = spawnSync('python3', args, options);
  if (result.error?.code === 'ENOENT') result = spawnSync('python', args, options);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('49 real rows and one prose "| staged |": capture still appends, nightly still sees 50', (t) => {
  const text = '# Memory Candidates\n\n' + PROSE + '## Candidates\n\n' + HEADER + rows(49);
  const { root, file } = ledgerRoot(t, text);
  assert.deepEqual(counts(text), [50, 49], 'floor for nightly, real rows for the cap');
  const run = capture(root, 'remember that the fiftieth rule is real');
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /CAP:/);
  const after = readFileSync(file, 'utf8');
  assert.match(after, /the fiftieth rule is real/);
  assert.equal(counts(after)[1], 50);
});

test('50 real rows: the cap still holds and nothing is appended', (t) => {
  const text = '# Memory Candidates\n\n## Candidates\n\n' + HEADER + rows(50);
  const { root, file } = ledgerRoot(t, text);
  const run = capture(root, 'remember that the fifty-first rule is real');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /CAP: MEMORY_CANDIDATES backlog at 50/);
  assert.equal(readFileSync(file, 'utf8'), text);
});
