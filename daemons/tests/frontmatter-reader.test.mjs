// frontmatter-reader.test.mjs: YAML block scalars (`>` / `|`) fold correctly.
//
// THE DEFECT (measured on the unmodified tree): scalar() and capsuleValue()
// return the literal block indicator ("\>" or "|") for a block scalar instead
// of its folded content. `objective: >` followed by two indented lines
// returns the one-character string ">". Because ">" is truthy,
// capsuleValue's body-section fallback never fires, so a hand-authored
// capsule with a folded field loads with a one-character objective instead
// of its real content -- the s237-class defect.
//
// unsafeRawScalar keeps returning the literal marker deliberately (raw means
// raw); only the safe readers scalar() and capsuleValue() fold. Every other
// exported reader (unsafeRawRewriteScalar, frontmatterList,
// scalarIsUnquotedYamlNull, scalarHasUnsupportedInlineComment) must be
// unaffected by a block-scalar key sitting elsewhere in the same document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import frontmatterReader from '../frontmatter-reader.cjs';
import { selectCapsule } from '../lifecycle-common.mjs';

const {
  scalar, capsuleValue, unsafeRawScalar, unsafeRawRewriteScalar,
  frontmatterList, scalarIsUnquotedYamlNull, scalarHasUnsupportedInlineComment,
} = frontmatterReader;

// One frontmatter document per block-style variant, each with a two-line
// indented block under `objective`. Trailing `-`/`+` are chomping indicators;
// the fold result must be identical regardless of style or chomping.
function blockDoc(marker) {
  return `---\nid: block-${marker.replace(/[>|+-]/g, '')}\nobjective: ${marker}\n  line one\n  line two\nstatus: active\n---\n\n# body\n`;
}

test('W-C1: scalar() folds a block scalar to one line, for >, |, >-, and |+ alike', () => {
  for (const marker of ['>', '|', '>-', '|+']) {
    const doc = blockDoc(marker);
    assert.equal(scalar(doc, 'objective'), 'line one line two', `marker ${marker} must fold to one line`);
  }
});

test('W-C2: capsuleValue() returns the folded text, not the body section fallback', () => {
  const doc = `---\nid: block-capval\nobjective: >\n  from frontmatter\n  line two\nstatus: active\n---\n\n## Objective\nfrom body section, must not be used\n`;
  assert.equal(scalar(doc, 'objective'), 'from frontmatter line two');
  assert.equal(capsuleValue(doc, 'objective'), 'from frontmatter line two',
    'capsuleValue must prefer the folded scalar over the body-section fallback, exactly like a plain scalar');
});

test('W-C3: selectCapsule selects a capsule with a folded YAML block objective, and it reads correctly (s237-class defect witness)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'fm-reader-'));
  const memory = path.join(base, 'memory');
  mkdirSync(path.join(memory, 'capsules'), { recursive: true });
  const capsulePath = path.join(memory, 'capsules', 'folded-obj.md');
  writeFileSync(capsulePath,
    '---\nid: folded-obj\nstatus: active\nobjective: >\n  Take the pipeline\n  from red to green.\n'
    + 'next_valid_action: "Run the suite and fix the first failure."\ncreated_at: 2026-08-01T10:00:00.000Z\n---\n\n# fixture\n');
  try {
    const { capsule } = selectCapsule(memory);
    assert.equal(capsule?.id, 'folded-obj',
      'a hand-authored capsule with a folded objective must not be silently rejected or lost');
    const doc = readFileSync(capsule.path, 'utf8');
    assert.equal(capsuleValue(doc, 'objective'), 'Take the pipeline from red to green.',
      'the folded objective must read as its real content, not a one-character marker');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('W-C4: unsafeRawScalar keeps returning the literal marker (raw means raw)', () => {
  for (const marker of ['>', '|', '>-', '|+']) {
    const doc = blockDoc(marker);
    assert.equal(
      unsafeRawScalar(doc, 'objective', 'regression guard: raw stays raw even after the fold fix'),
      marker,
    );
  }
});

// ── Guard tests: a block-scalar key elsewhere in the document must not
// disturb the four remaining shared readers. ─────────────────────────────

test('guard: unsafeRawRewriteScalar rewrites its own target key untouched by a block-scalar objective', () => {
  const doc = '---\nid: guard-rewrite\nobjective: >\n  folded content\n  stays put\nstatus: active\n---\n\n# body\n';
  const rewritten = unsafeRawRewriteScalar(doc, 'status', 'active', 'resumed', 'guard test');
  assert.match(rewritten, /^status:[ \t]*resumed[ \t]*$/m);
  assert.equal(scalar(rewritten, 'objective'), 'folded content stays put',
    'the block-scalar field must survive an unrelated rewrite untouched');
});

test('guard: frontmatterList reads a list field unaffected by a block-scalar objective', () => {
  const doc = '---\nid: guard-list\nobjective: >\n  folded content\n  stays put\ntags: [capsule, autosave]\nstatus: active\n---\n\n# body\n';
  assert.deepEqual(frontmatterList(doc, 'tags'), ['capsule', 'autosave']);
});

test('guard: scalarIsUnquotedYamlNull reads a bare null field unaffected by a block-scalar objective', () => {
  const doc = '---\nid: guard-null\nobjective: >\n  folded content\n  stays put\nwaiting_on: null\nstatus: active\n---\n\n# body\n';
  assert.equal(scalarIsUnquotedYamlNull(doc, 'waiting_on'), true);
});

test('guard: scalarHasUnsupportedInlineComment reads an inline-comment field unaffected by a block-scalar objective', () => {
  const doc = '---\nid: guard-comment\nobjective: >\n  folded content\n  stays put\nnext_valid_action: "do the thing" # trailing comment\nstatus: active\n---\n\n# body\n';
  assert.equal(scalarHasUnsupportedInlineComment(doc, 'next_valid_action'), true);
});
