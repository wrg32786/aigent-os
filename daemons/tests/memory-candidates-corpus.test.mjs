import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { maskMarkdownFences } from '../nightly-freshness.mjs';

// Label, pinned base count, ledger text. A fourth value marks a known undercount.
const corpus = [
  ['lead 0', 1,
    '| Candidate | Status |\n| --- | --- |\n| proof | staged |'],
  ['lead 1', 1,
    ' | Candidate | Status |\n | --- | --- |\n | proof | staged |'],
  ['lead 2', 1,
    '  | Candidate | Status |\n  | --- | --- |\n  | proof | staged |'],
  ['lead 3', 1,
    '   | Candidate | Status |\n   | --- | --- |\n   | proof | staged |'],
  ['no lead 0', 1,
    'Candidate | Status |\n--- | --- |\nproof | staged |'],
  ['no lead 1', 1,
    ' Candidate | Status |\n --- | --- |\n proof | staged |'],
  ['no lead 2', 1,
    '  Candidate | Status |\n  --- | --- |\n  proof | staged |'],
  ['no lead 3', 1,
    '   Candidate | Status |\n   --- | --- |\n   proof | staged |'],
  ['Status as data', 1,
    'Candidate | Status |\n--- | --- |\nStatus | staged |'],
  ['Status and Source phrase', 1,
    'Candidate | Status | Note |\n--- | --- | --- |\nStatus | staged | Source phrase |'],
  ['escaped pipe in candidate', 1,
    'Candidate | Status |\n--- | --- |\npro\\|of | staged |'],
  ['escaped delimiter in header', 1,
    'Pro\\|of | Status |\n--- | --- |\nproof | staged |'],
  ['isolated row, no separator', 1,
    'proof | staged |', true],
  ['header and row, no separator', 1,
    'Candidate | Status |\nproof | staged |', true],
  ['prose, no separator', 1,
    'Text | status | and more\nWords | staged | here', true],
  ['inside capsule', 1,
    '## 2026-11-18 (capsule cycle)\nCandidate | Status |\n--- | --- |\nproof | staged |'],
  ['outside capsule', 1,
    '## Notes\nCandidate | Status |\n--- | --- |\nproof | staged |'],
  ['open capsule bullet', 0,
    '## 2026-11-18 (capsule cycle)\n- proof'],
  ['banked capsule bullet', 0,
    '## 2026-11-18 (capsule cycle)\n- proof. Banked in [[a]].'],
  ['outside bullet', 0,
    '## Notes\n- proof'],
  ['unscanned status', 0,
    'Candidate | Status |\n--- | --- |\nproof | unscanned |'],
  ['staged only in candidate', 1,
    '| Candidate | Status |\n| --- | --- |\n| staged | promoted |', true],
  ['trailing pipe omitted', 0,
    'Candidate | Status\n--- | ---\nproof | staged'],
  ['aligned separators', 1,
    'Candidate | Status |\n:--- | ---: |\nproof | staged |'],
  ['fenced table', 0,
    '~~~\nCandidate | Status |\n--- | --- |\nproof | staged |\n~~~'],
  ['4-space code block', 1,
    '    Candidate | Status |\n    --- | --- |\n    proof | staged |', true],
  ['8-cell capture without separator', 1,
    '| 2026-11-18 | proof | src | n | n | staged | n | n |'],
  ['mismatched separator width', 1,
    'Candidate | Status |\n--- | --- | --- |\nproof | staged |', true],
  ['mixed 2 real rows, extra staged in note', 2,
    '| Candidate | Status | Note |\n| --- | --- | --- |\n| proof | staged | aside |\n| proof2 | promoted | staged |', true],
  ['1-column no outer pipes on delimiter', 1,
    '| Status |\n---\n| staged |', true],
  ['capsule bullet then table', 1,
    '## 2026-11-18 (capsule cycle)\n- proof\nCandidate | Status |\n--- | --- |\nproof | staged |'],
  ['capsule bullet with token', 1,
    '## 2026-11-18 (capsule cycle)\n- literal | staged |'],
  ['status header in plain prose', 0,
    'One | Status | sentence\nNo | pending | here'],
  ['separator-shaped body row after data', 1,
    'Candidate | Status |\n--- | --- |\nStatus | staged |\n--- | --- |', true],
  ['separator-shaped body row then promoted row', 1,
    '| Candidate | Status |\n| --- | --- |\n| Status | staged |\n| --- | --- |\n| other | promoted |', true],
  ['banked capsule bullet then two-space table', 1,
    '## 2026-11-18 (capsule cycle)\n- proof. Banked in [[a]].\n\n  Candidate | Status |\n  --- | --- |\n  other | staged |'],
  ['canonical capture appended to narrower table', 1,
    'Candidate | Status |\n--- | --- |\nproof | skipped |\n| 2026-11-18 | word | type | confidence | dest | staged | | |', true],
  ['header-like prose inside active table', 1,
    'Candidate | Status |\n--- | --- |\nproof | promoted |\nText | Status |\nproof | staged |'],
];

const script = `
import json
import sys
from memory_candidates import base_count, staged_count, structured_count

print(json.dumps([
    [base_count(text), staged_count(text), structured_count(text)]
    for text in json.load(sys.stdin)
]))
`;
const options = {
  cwd: new URL('../', import.meta.url),
  input: JSON.stringify(corpus.map(([, , text]) => text)),
  encoding: 'utf8',
  windowsHide: true,
};
const args = ['-B', '-c', script];
let result = spawnSync('python3', args, options);
if (result.error?.code === 'ENOENT') result = spawnSync('python', args, options);
assert.equal(result.status, 0, result.error?.message || result.stderr);
const counts = JSON.parse(result.stdout);
assert.equal(counts.length, corpus.length);

for (const [i, [label, pinned, text]] of corpus.entries()) {
  test(label, () => {
    const jsBase = (maskMarkdownFences(text).match(/\|[ \t]*staged[ \t]*\|/gi) || []).length;
    assert.equal(jsBase, pinned, 'JavaScript base count');
    assert.equal(counts[i][0], pinned, 'Python base count');
    assert.ok(counts[i][1] >= pinned, `staged_count returned ${counts[i][1]}, below base ${pinned}`);
  });
}

test('removing the floor exposes each known undercount', () => {
  for (const [i, [label, pinned, , undercount]] of corpus.entries()) {
    if (undercount) assert.ok(counts[i][2] < pinned, label);
  }
});
