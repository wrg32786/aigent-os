// capsule-compact.walker.test.mjs -- chain walk across _archive/ and over a missing link.
//   - a parent already archived to capsules/_archive/ is a real link and is walked into
//   - a truly missing parent warns and ends the chain; it must not append a phantom
//     entry that the summarizer then crashes on (None frontmatter)
// Run: node --test daemons/tests/capsule-compact.walker.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(DAEMONS, 'capsule-compact.py');
const PYTHON = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0);
const skip = !PYTHON && 'python not available';

const capsule = (id, parent) =>
  `---\ncapsule_id: ${id}\nobjective: "${id}"\nstatus: active\ncreated_at: 2026-09-01T00:00:00Z\nparent_capsule_id: ${parent}\n---\n\nbody\n`;

// c1 (head) -> c2 -> c3; archived ids live in _archive/, ids not listed anywhere are missing.
function fixture({ live, archived = [], missingTail = null }) {
  const base = mkdtempSync(path.join(tmpdir(), 'capsule-walker-'));
  const capsules = path.join(base, 'vault', 'memory', 'capsules');
  mkdirSync(path.join(capsules, '_archive'), { recursive: true });
  const ids = [...live, ...archived];
  ids.forEach((id, i) => {
    const parent = ids[i + 1] ?? missingTail ?? 'null';
    const dir = archived.includes(id) ? path.join(capsules, '_archive') : capsules;
    writeFileSync(path.join(dir, `${id}.md`), capsule(id, parent));
  });
  return base;
}

function run(base, threshold) {
  return spawnSync(PYTHON, [SCRIPT, 'c1', '--vault', base, '--threshold', String(threshold), '--summarize-count', '1'], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8',
  });
}

test('a parent in _archive/ is followed: the chain reaches it', { skip }, () => {
  const base = fixture({ live: ['c1', 'c2'], archived: ['c3'] });
  const r = run(base, 3);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /compacted: 3 -> /, `chain must include the archived link, got ${r.stdout}`);
});

test('a truly missing parent warns and stops without a phantom entry or a crash', { skip }, () => {
  const base = fixture({ live: ['c1', 'c2'], missingTail: 'ghost' });
  const r = run(base, 2);
  assert.equal(r.status, 0, `must not crash, stderr=${r.stderr}`);
  assert.match(r.stderr, /ghost.*not found on disk or in _archive/);
  assert.match(r.stdout, /compacted: 2 -> /, `phantom would make this 3, got ${r.stdout}`);
});
