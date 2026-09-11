// capsule-compact.encoding.test.mjs -- capsule-compact.py write encoding
// regression guard.
//
// Two defects fixed together in daemons/capsule-compact.py:
//   - frontmatter rewrites (write_frontmatter -> path.write_text) go through
//     the platform default encoding instead of utf-8, so non-ASCII text in a
//     capsule mangles on a Windows console whose default codepage is not
//     utf-8 (round-trip byte identity, W-A1)
//   - the status print on a successful compaction carries an arrow outside
//     that codepage's range, so the script raises and exits 1 AFTER every
//     write already landed, turning a successful compaction into a reported
//     failure (W-A2)
//
// Run: node --test daemons/tests/capsule-compact.encoding.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(DAEMONS, 'capsule-compact.py');
const PYTHON = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0);

// The legacy path under test: PYTHONIOENCODING unset, PYTHONUTF8=0. On this
// codepage, Path.write_text() with no explicit encoding falls back to
// locale.getpreferredencoding(), never utf-8.
function legacyEnv(extra = {}) {
  const env = { ...process.env, PYTHONUTF8: '0', ...extra };
  delete env.PYTHONIOENCODING;
  return env;
}

function capsule(id, { objectiveLine, parent = 'null' }) {
  return `---\ncapsule_id: ${id}\n${objectiveLine}\nstatus: active\ncreated_at: 2026-09-01T00:00:00Z\nparent_capsule_id: ${parent}\n---\n\nbody\n`;
}

// A minimal two-capsule chain, threshold 2 / summarize-count 1: head is kept
// (the boundary capsule, rewritten to point at the new summary) and tail is
// folded into the summary. Both rewrite paths in the script go through
// write_frontmatter, so the head fixture alone proves W-A1.
function fixture(objectiveLine) {
  const base = mkdtempSync(path.join(tmpdir(), 'capsule-compact-'));
  const capsules = path.join(base, 'vault', 'memory', 'capsules');
  mkdirSync(capsules, { recursive: true });
  writeFileSync(path.join(capsules, 'head.md'), capsule('head', { objectiveLine, parent: 'tail' }));
  writeFileSync(path.join(capsules, 'tail.md'), capsule('tail', { objectiveLine: 'objective: "root"' }));
  return { base, capsules };
}

function run(headId, base, env) {
  return spawnSync(PYTHON, [SCRIPT, headId, '--vault', base, '--threshold', '2', '--summarize-count', '1'], {
    env, encoding: 'utf8',
  });
}

test('W-A1: a non-ASCII frontmatter field round-trips byte-identical after a compaction write', { skip: !PYTHON && 'python not available' }, () => {
  const objective = 'café — résumé';
  const objectiveLine = `objective: "${objective}"`;
  const { base, capsules } = fixture(objectiveLine);
  const r = run('head', base, legacyEnv());
  assert.equal(r.status, 0, `compaction must exit 0, stderr=${r.stderr}`);
  // Read raw bytes and split on the physical newline byte (0x0A never occurs
  // inside a multi-byte utf-8 sequence, so this is safe under any encoding).
  // latin1 is a lossless byte<->codepoint mapping, so re-encoding a latin1
  // line recovers the exact original bytes -- the comparison is on bytes,
  // not on a decoded string that could round-trip through node's own utf-8
  // reader and hide a codepage mismatch.
  const rewritten = readFileSync(path.join(capsules, 'head.md'));
  const line = rewritten.toString('latin1').split(/\r?\n/).find((l) => l.startsWith('objective:'));
  assert.ok(line, `no objective line found in rewritten head.md, stdout=${r.stdout}`);
  const actualBytes = Buffer.from(line, 'latin1');
  const expectedBytes = Buffer.from(objectiveLine, 'utf8');
  assert.equal(actualBytes.toString('hex'), expectedBytes.toString('hex'),
    'the rewritten frontmatter line must be byte-identical utf-8, not the platform default codepage');
});

test('W-A2: a successful compaction under a legacy console codepage still exits 0 and reports compacted', { skip: !PYTHON && 'python not available' }, () => {
  const { base } = fixture('objective: "plain"');
  const r = run('head', base, legacyEnv({ PYTHONIOENCODING: 'cp1252' }));
  assert.equal(r.status, 0, `successful compaction must exit 0, stderr=${r.stderr}`);
  assert.match(r.stdout, /compacted:/, `stdout must report the compaction, got ${JSON.stringify(r.stdout)}`);
});
