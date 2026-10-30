import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCapsuleText } from '../capsule-verb.mjs';
import * as lifecycle from '../lifecycle-common.mjs';

const daemons = fileURLToPath(new URL('../', import.meta.url));
const user = (text) => ({ type: 'user', message: { content: text } });
const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'capsule-done-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), '{"state":{}}');
  const transcriptDir = path.join(root, 'private-home', '.claude', 'projects');
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, 'session.jsonl');
  const env = { ...process.env, AIGENT_ROOT: root, AIGENT_STATE_HOME_DIR: root,
    CLAUDE_PROJECT_DIR: root, AIGENT_SEAT_ID: '', LIFECYCLE_KILL_STOP_WRITER: '0' };
  let capsulePath;
  return {
    write(events) {
      appendFileSync(transcript, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      const run = spawnSync(process.execPath, [path.join(daemons, 'stop-capsule-writer.mjs'), '--worker',
        JSON.stringify({ __root: root, session_id: 'synthetic-session', transcript_path: transcript })],
      { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /SWE_OUTCOME:flushed/);
      capsulePath = JSON.parse(readFileSync(path.join(root, 'memory', 'runtime', 'stop-writer', 'synthetic-session.json'))).capsule_path;
      const doc = readFileSync(capsulePath, 'utf8');
      assert.deepEqual(validateCapsuleText(doc).problems, []);
      return doc;
    },
    resume() {
      const script = `import { runResumeVerb } from ${JSON.stringify(new URL('../resume-verb.mjs', import.meta.url).href)};
        console.log(runResumeVerb({ projectRoot: process.env.AIGENT_ROOT, source: 'clear', sessionId: 'fresh-session' }).prompt);`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script],
        { env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout;
    },
    done(rows) {
      const doc = readFileSync(capsulePath, 'utf8');
      writeFileSync(capsulePath, doc.replace(/(<!-- swe:done -->)[\s\S]*?(?=\n## )/, `$1\n${rows.join('\n')}\n`));
    },
    edit(transform) {
      writeFileSync(capsulePath, transform(readFileSync(capsulePath, 'utf8')));
    },
    errors() {
      return readFileSync(path.join(root, 'memory', '.daemon-errors.log'), 'utf8');
    },
  };
}

const doneRows = (doc) => lifecycle.unsafeRawBodySection(doc, "Done (don't redo)", 'test section boundary')
  .split('\n').filter((row) => /^- /.test(row));
const renderedRows = (prompt) => prompt.split('\n').filter((line) => line.startsWith('    "'));

test('R17.1: only a whole-line anchor locates a section', () => {
  const anchor = '<!-- swe:files -->';
  for (const newline of ['\n', '\r\n']) {
    const doc = ['## Done', `- [OPERATOR] "fix the ${anchor} anchor"`,
      '## Files', ` \t${anchor}\t `, '- read source.mjs', '## Next'].join(newline);
    const section = lifecycle.locateCapsuleSection(doc, anchor);
    assert.equal(section.anchorAt, doc.lastIndexOf(anchor));
    assert.equal(section.start, doc.indexOf('## Files') + '## Files'.length);
    assert.equal(lifecycle.locateCapsuleSection(doc.replace(` \t${anchor}\t `, ''), anchor), null);
  }
  assert.equal(lifecycle.locateCapsuleSection(anchor, anchor).anchorAt, 0);
});

test('R17.1: writer preserves a Done row quoting the Files anchor', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  const row = '- [OPERATOR] "fix the <!-- swe:files --> anchor"';
  f.done([row]);
  const doc = f.write([{ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Read', input: { file_path: 'source.mjs' } },
  ] } }]);
  assert.ok(doc.split('\n').includes(row), 'quoted row remains intact');
  assert.match(doc, /## Files-Read \/ Files-Modified\n<!-- swe:files -->\n- read source\.mjs/);
});

test('R17.2: anchored and fallback sections ignore unrelated nested headings', () => {
  const anchor = '<!-- swe:done -->';
  for (const level of ['#', '##']) {
    const heading = `${level} Done (don't redo)`;
    for (const marker of [anchor, '']) {
      const doc = ['### Done decoy redo', '- decoy', heading, '### day1', '- first',
        '### day2', '- second', marker, `${level} Next`, '- outside'].join('\n');
      const section = lifecycle.locateCapsuleSection(doc, anchor, /^Done\b.*redo/i);
      assert.equal(section.start, doc.indexOf(heading) + heading.length);
      assert.equal(section.end, doc.indexOf(`${level} Next`));
    }
  }
  const doc = `### day1\n${anchor}\n### day2\n- history\n## Next`;
  const section = lifecycle.locateCapsuleSection(doc, anchor);
  assert.equal(section.hasHeading, false);
  assert.equal(section.end, doc.indexOf('## Next'));
});

test('R17.2: reader includes both dated blocks before the anchor', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.edit((doc) => doc.replace(/<!-- swe:done -->[^]*?(?=\n## )/,
    '### day1\n- [OPERATOR] first dated directive\n### day2\n- [OPERATOR] second dated directive\n<!-- swe:done -->\n## Next\n- [OPERATOR] outside directive\n'));
  const prompt = f.resume();
  assert.match(prompt, /\[OPERATOR\] first dated directive/);
  assert.match(prompt, /\[OPERATOR\] second dated directive/);
  assert.doesNotMatch(prompt, /\[OPERATOR\] outside directive/);
});

test('R17.2: writer deduplicates across dated blocks after a late anchor', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.edit((doc) => doc.replace(/<!-- swe:done -->[^]*?(?=\n## )/,
    '### day1\n- [ASSISTANT] first claim\n### day2\n- [ASSISTANT] second claim\n<!-- swe:done -->\n### day3\n- [OPERATOR] dated directive\n## Next\n- [OPERATOR] outside directive\n'));
  const doc = f.write([user('dated directive'), user('outside directive')]);
  assert.equal((doc.match(/\[OPERATOR\] dated directive/g) || []).length, 1);
  assert.equal((doc.match(/\[OPERATOR\] outside directive/g) || []).length, 2);
});

test('R17.3: curated rows above the anchor deduplicate fresh utterances', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.edit((doc) => doc.replace(/<!-- swe:done -->[^]*?(?=\n## )/,
    '- [OPERATOR] curated directive\n- legacy curated claim\n \t<!-- swe:done -->\t \n'));
  const doc = f.write([user('curated directive'), assistant('legacy curated claim')]);
  const rows = doneRows(doc);
  assert.equal(rows.filter((row) => row.includes('curated directive')).length, 1);
  assert.equal(rows.filter((row) => row.includes('legacy curated claim')).length, 1);
  assert.ok(rows.includes('- [OPERATOR] curated directive'));
  assert.ok(rows.includes('- legacy curated claim'));
});

test('R16.1: thirteen assistant blocks retain the operator and latest assistant row', (t) => {
  const rows = doneRows(fixture(t).write([
    user('Keep the operator directive'),
    ...Array.from({ length: 13 }, (_, i) => assistant(`claim-${i};`)),
  ])).map(lifecycle.capsuleRowKey);
  assert.equal(rows.length, 12);
  assert.ok(rows.includes('[OPERATOR] Keep the operator directive'));
  assert.ok(rows.includes('[ASSISTANT] claim-12;'));
  assert.ok(!rows.includes('[ASSISTANT] claim-0;'));
  assert.ok(!rows.includes('[ASSISTANT] claim-1;'));
});

test('R15.1: only adjacent indented continuations belong to Done bullets', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR] directive', '  attached detail', '', 'Detached paragraph',
    '  Detached indented paragraph', '- [ASSISTANT] claim', 'Unindented prose',
    '  Still detached', '- [OPERATOR] second directive', '  ', '  After whitespace blank']);
  assert.deepEqual(renderedRows(f.resume()).map((row) => JSON.parse(row.trim())), [
    '- [OPERATOR] directive attached detail', '- [OPERATOR] second directive', '- [ASSISTANT] claim',
  ]);
});

test('R15.2: assistant claims from separate turns survive one Stop delta', (t) => {
  const first = assistant('First turn claim');
  first.message.id = 'first-message';
  const second = assistant('Second turn claim');
  second.message.id = 'second-message';
  const rows = doneRows(fixture(t).write([user('First request'), first, user('Second request'), second]));
  assert.ok(rows.some((row) => row.includes('[ASSISTANT] First turn claim')));
  assert.ok(rows.some((row) => row.includes('[ASSISTANT] Second turn claim')));
});

test('R15.2: only the last text block of each assistant message survives', (t) => {
  const first = assistant('Superseded block');
  first.message.id = 'same-message';
  first.message.content.push({ type: 'text', text: 'Interim block' });
  const other = assistant('Other message claim');
  other.message.id = 'other-message';
  const last = assistant('Final block');
  last.message.id = 'same-message';
  const rows = doneRows(fixture(t).write([first, other, last])).join('\n');
  assert.doesNotMatch(rows, /Superseded block|Interim block/);
  assert.match(rows, /\[ASSISTANT\] Final block/);
  assert.match(rows, /\[ASSISTANT\] Other message claim/);
});

test('R15.2: missing message IDs do not merge separate assistant events', (t) => {
  const first = assistant('First idless claim');
  first.message.content.unshift({ type: 'text', text: 'Idless superseded block' });
  const rows = doneRows(fixture(t).write([first, assistant('Second idless claim')])).join('\n');
  assert.doesNotMatch(rows, /Idless superseded block/);
  assert.match(rows, /First idless claim/);
  assert.match(rows, /Second idless claim/);
});

test('R15.3: stored list markers and stamps do not change speaker priority', () => {
  for (const speaker of ['OPERATOR', 'ASSISTANT', 'RELAY:agent', 'PEER:agent']) {
    for (const prefix of ['- 12:00 ', '+ ', '2.\t12:00 ']) {
      assert.equal(lifecycle.doneRowPriority(`${prefix}[${speaker}] x`),
        lifecycle.doneRowPriority(`[${speaker}] x`));
    }
  }
});

test('R14.1: repeated fresh rows cannot evict an earlier operator correction', (t) => {
  const rows = doneRows(fixture(t).write([
    user('Actually use Y'),
    ...Array.from({ length: 12 }, () => user('Repeated directive')),
  ])).map(lifecycle.capsuleRowKey);
  assert.deepEqual(rows, ['[OPERATOR] Repeated directive', '[OPERATOR] Actually use Y']);
});

test('R16.1: shared speaker priority evicts older assistants before operators', () => {
  assert.equal(lifecycle.doneRowPriority('[ASSISTANT] Older reply'), 2);
  assert.equal(lifecycle.doneRowPriority('[OPERATOR] Directive'), 3);
  assert.equal(lifecycle.doneRowPriority('[RELAY:agent] Relay'), 1);
  assert.equal(lifecycle.doneRowPriority('[PEER:agent] Peer'), 0);
});

test('R13.1: writer ignores frontmatter anchors and merges into body Done', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  const decoy = '# <!-- swe:done -->\n';
  f.edit((doc) => doc.replace('---\n', `---\n${decoy}`));
  const doc = f.write([assistant('Body-only reply')]);
  assert.ok(doneRows(doc).some((row) => row.includes('Body-only reply')));
  const frontmatter = doc.slice(0, doc.indexOf('\n---', 4));
  assert.ok(frontmatter.includes(decoy));
  assert.doesNotMatch(frontmatter, /Body-only reply|^- /m);
});

test('R13.2: decimal continuation stays attached to its Done row', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR] budget', '  3.5 GB remaining', '2. [ASSISTANT] next row']);
  assert.deepEqual(renderedRows(f.resume()).map((row) => JSON.parse(row.trim())), [
    '- [OPERATOR] budget 3.5 GB remaining', '2. [ASSISTANT] next row',
  ]);
});

test('R13.2: row keys require whitespace after numbered-list periods', () => {
  assert.equal(lifecycle.capsuleRowKey('3.5 GB'), '3.5 GB');
  assert.equal(lifecycle.capsuleRowKey('3.\t5 GB'), '5 GB');
});

test('R13.3: adjacent speaker tags share stripping, grouping, and priority', (t) => {
  const key = '[OPERATOR]ship it';
  assert.equal(key.replace(lifecycle.DONE_TAG, ''), 'ship it');
  assert.equal(lifecycle.doneRowGroup(key), 'operator');
  assert.equal(lifecycle.doneRowPriority(key), 3);
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done([`- ${key}`, '- [ASSISTANT] a claim']);
  assert.match(f.resume(), /Recorded operator history[^]*\[OPERATOR\]ship it[^]*Done: claims/);
});

test('R13.4: headingless anchor retains rows and logs once', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.edit((doc) => doc.replace("## Done (don't redo)\n", ''));
  const doc = f.write([assistant('Keep this reply')]);
  assert.match(doc, /<!-- swe:done -->\n- [^\n]*Keep this reply/);
  assert.match(doc, /\[OPERATOR\] Initial request/);
  assert.equal((f.errors().match(/has no section heading/g) || []).length, 1);
});

test('R16.3: headingless anchor deduplicates through deeper headings only', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['### Nested history', '- [OPERATOR] nested directive',
    '## Other section', '- [OPERATOR] outside directive']);
  f.edit((doc) => doc.replace("## Done (don't redo)\n", ''));
  const doc = f.write([user('nested directive'), user('outside directive')]);
  assert.equal((doc.match(/\[OPERATOR\] nested directive/g) || []).length, 1);
  assert.equal((doc.match(/\[OPERATOR\] outside directive/g) || []).length, 2);
  assert.equal((f.errors().match(/has no section heading/g) || []).length, 1);
});

test('R13.6: control characters share stored-row keys and replay deduplication', (t) => {
  for (const separator of ['\u2028', '\u2029', '\u0000', '\u0085', '\n']) {
    assert.equal(lifecycle.capsuleRowKey(`- [OPERATOR] keep${separator}this`), '[OPERATOR] keep this');
  }
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR] keep\u2028this']);
  const doc = f.write([user('keep this')]);
  assert.equal((doneRows(doc).join('\n').match(/keep[\u2028 ]this/g) || []).length, 1);
});

test('R11.3: uppercase checkboxes are content for writer deduplication', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [X] shipped']);
  const doc = f.write([assistant('[X] shipped')]);
  assert.equal((doc.match(/\[X\] shipped/g) || []).length, 1);
});

test('R11.3: uppercase checkboxes remain reader content, including checkbox-only rows', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [X] shipped', '- [X]']);
  assert.deepEqual(renderedRows(f.resume()).map((row) => JSON.parse(row.trim())), ['- [X] shipped', '- [X]']);
});

test('R11.4: writer whitespace keys match timestamped and untimestamped rows', (t) => {
  assert.equal(lifecycle.capsuleRowKey('-  [OPERATOR] spaced'), lifecycle.capsuleRowKey('- 12:00 [OPERATOR] spaced'));
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['-  [OPERATOR] spaced', '-\t[OPERATOR]\ttabbed']);
  const doc = f.write([user('spaced'), user('tabbed')]);
  assert.equal((doc.match(/\[OPERATOR\] spaced/g) || []).length, 1);
  assert.equal((doc.match(/^[-*][ \t].*tabbed/gm) || []).length, 1);
});

for (const heading of ["Done this session (don't redo)", "Done today (don't redo)"]) {
  test(`R11.5: curated heading ${heading} renders operator history without a marker`, (t) => {
    const f = fixture(t);
    f.write([user('Initial request')]);
    f.done(['### Date', '- [OPERATOR] curated directive']);
    f.edit((doc) => doc.replace("Done (don't redo)", heading).replace('<!-- swe:done -->', ''));
    assert.match(f.resume(), /Recorded operator history[^]*\[OPERATOR\] curated directive/);
  });
}

test('R16.2: Done anchor owns the section ahead of a matching heading elsewhere', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR] marker directive']);
  f.edit((doc) => doc.replace("## Done (don't redo)", "## Done (don't redo)\n- [OPERATOR] decoy\n## Recorded history"));
  const prompt = f.resume();
  assert.doesNotMatch(prompt, /\[OPERATOR\] decoy/);
  assert.match(prompt, /marker directive/);
});

test('R16.2: dated curated Done heading with an anchor renders operator history', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR] curated directive']);
  f.edit((doc) => doc.replace("Done (don't redo)", 'Done this session (2026-07-20 review)'));
  const doc = f.write([user('curated directive')]);
  assert.equal((doc.match(/\[OPERATOR\] curated directive/g) || []).length, 1);
  assert.match(f.resume(), /Recorded operator history[^]*\[OPERATOR\] curated directive/);
});

test('R12.1: only emitted speaker tags are metadata; bracketed claims render and count', (t) => {
  for (const tag of ['TODO', 'PR-123', 'BLOCKED', 'WIP', 'X', 'RELAY', 'UNKNOWN:x']) {
    assert.equal(lifecycle.DONE_TAG.test(`[${tag}]`), false, tag);
  }
  for (const tag of ['OPERATOR', 'ASSISTANT', 'RELAY:x', 'PEER:x', 'INJECT:x', 'ATTACHMENT']) {
    assert.equal(lifecycle.DONE_TAG.test(`[${tag}]`), true, tag);
  }
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [TODO] write docs', '- [TODO]',
    ...Array.from({ length: 11 }, (_, i) => `- [ASSISTANT] claim-${i}`)]);
  const prompt = f.resume();
  assert.match(prompt, /Done: claims to re-check[^]*\[TODO\] write docs/);
  assert.equal(renderedRows(prompt).length, 12);
  assert.match(prompt, /1 more Done rows in the capsule file/);
});

test('R12.1: legacy WIP content deduplicates a fresh assistant claim', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [WIP] refactor']);
  assert.equal((f.write([assistant('[WIP] refactor')]).match(/\[WIP\] refactor/g) || []).length, 1);
});

for (const hasDone of [false, true]) {
  test(`R12.3: frontmatter Done comment cannot shadow body headings (body=${hasDone})`, (t) => {
    const f = fixture(t);
    f.write([user('Initial request')]);
    f.done(['- [ASSISTANT] body claim']);
    f.edit((doc) => doc.replace('---\n', '---\n# Done decoy redo\n# <!-- swe:done -->\n')
      .replace("## Done (don't redo)", hasDone ? "## Done (don't redo)" : '## Other history')
      .replace('\n<!-- swe:done -->', ''));
    const prompt = f.resume();
    if (hasDone) assert.match(prompt, /body claim/);
    else {
      assert.doesNotMatch(prompt, /body claim/);
      assert.equal((f.errors().match(/Done section not found/g) || []).length, 1);
    }
  });
}

test('R12.4: twelve operators reserve a slot for the latest assistant reply', (t) => {
  const rows = doneRows(fixture(t).write([
    ...Array.from({ length: 12 }, (_, i) => user(`operator-${i};`)),
    assistant('Latest reply'), user('Final operator'),
  ]));
  assert.equal(rows.length, 12);
  assert.ok(rows.some((row) => row.includes('[ASSISTANT] Latest reply')));
  assert.equal(rows.filter((row) => row.includes('[OPERATOR]')).length, 11);
});

test('R12.2: Files-Read subheadings stay within the writer dedup window', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.edit((doc) => doc.replace('<!-- swe:files -->', '<!-- swe:files -->\n### Sources\n- read nested.mjs'));
  const doc = f.write([{ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Read', input: { file_path: 'nested.mjs' } },
  ] } }]);
  assert.equal((doc.match(/read nested\.mjs/g) || []).length, 1);
});

test('R12.5: plus bullets and continuation lines render and count as whole rows', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['+ [OPERATOR] directive', '  continued directive',
    '- [ASSISTANT]', '  continued claim', '  indented continuation',
    ...Array.from({ length: 12 }, (_, i) => `+ [TODO] claim-${i}`)]);
  const prompt = f.resume();
  assert.match(prompt, /Recorded operator history[^]*directive +continued directive/);
  assert.match(prompt, /Done: claims to re-check[^]*\[ASSISTANT\] +continued claim indented continuation/);
  assert.equal(renderedRows(prompt).length, 13);
  assert.match(prompt, /1 more Done rows in the capsule file/);
});

test('R11.5: absent Done section logs one diagnostic', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.edit((doc) => doc.replace("Done (don't redo)", 'Other history').replace('<!-- swe:done -->', ''));
  f.resume();
  assert.equal((f.errors().match(/Done section not found/g) || []).length, 1);
});

test('R10.1: bracketed directives render in operator history', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR] [ship it now]', '- [ASSISTANT] ordinary claim']);
  const prompt = f.resume();
  assert.match(prompt, /Recorded operator history[^]*\[OPERATOR\] \[ship it now\][^]*Done: claims/);
});

test('R10.1: markdown checkboxes key as legacy assistant claims', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [x] shipped', '- [ ] pending']);
  f.write([assistant('[x] shipped')]);
  const doc = f.write([assistant('[ ] pending')]);
  assert.equal((doc.match(/\[x\] shipped/g) || []).length, 1, 'checked claim is deduplicated');
  assert.equal((doc.match(/\[ \] pending/g) || []).length, 1, 'unchecked claim is deduplicated');
});

test('R10.2: an oversized-tag row leaves all twelve rendered claim slots available', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done([`- [RELAY:${'x'.repeat(5000)}] hidden text`,
    ...Array.from({ length: 12 }, (_, i) => `- [ASSISTANT] claim-${i};`)]);
  const prompt = f.resume();
  assert.deepEqual(prompt.match(/claim-\d+;/g), Array.from({ length: 12 }, (_, i) => `claim-${i};`));
});

test('R10.3: dated Done subheadings retain writer dedup and reader counts', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['### 2026-10-29', '- [OPERATOR] dated directive',
    ...Array.from({ length: 13 }, (_, i) => `- [ASSISTANT] dated-claim-${i};`)]);
  const doc = f.write([user('dated directive')]);
  assert.equal((doc.match(/\[OPERATOR\] dated directive/g) || []).length, 1, 'subheading row deduplicates');
  const prompt = f.resume();
  assert.match(prompt, /\[OPERATOR\] dated directive/, 'subheading operator renders');
  assert.equal((prompt.match(/dated-claim-\d+;/g) || []).length, 12, 'subheading claims render');
  assert.match(prompt, /1 more Done rows in the capsule file/, 'subheading overflow is counted');
});

test('R10.4: tag-only rows never produce an elision notice', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR]', '- [ASSISTANT]']);
  const prompt = f.resume();
  assert.equal(renderedRows(prompt).length, 0);
  assert.doesNotMatch(prompt, /more Done rows in the capsule file/);
});

test('R10.4: elision counts classified rows only', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR]', '- [ASSISTANT]',
    ...Array.from({ length: 13 }, (_, i) => `- [ASSISTANT] claim-${i};`)]);
  assert.match(f.resume(), /  1 more Done rows in the capsule file/);
});

test('R9.1: Unicode separators before heading text do not end Done for the reader', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [ASSISTANT] first\u2028# note', '- [OPERATOR] still in Done']);
  const prompt = f.resume();
  assert.match(prompt, /first # note/);
  assert.match(prompt, /\[OPERATOR\] still in Done/);
});

test('R9.1: Unicode separators before heading text do not end Done for writer dedup', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [ASSISTANT] first\u2028# note', '- [OPERATOR] still in Done']);
  const doc = f.write([user('still in Done')]);
  assert.equal((doc.match(/\[OPERATOR\] still in Done/g) || []).length, 1);
  assert.match(doc, /first\u2028# note/);
});

test('R9.2: a stored relay and an assistant quoting its tag both survive', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [RELAY:dv] ship it']);
  const doc = f.write([assistant('[RELAY:dv] ship it')]);
  assert.deepEqual(doneRows(doc).map(lifecycle.capsuleRowKey), [
    '[ASSISTANT] [RELAY:dv] ship it', '[RELAY:dv] ship it',
  ]);
});

test('R9.3: extra list whitespace keeps an operator in operator history', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['-  [OPERATOR] spaced directive', '- [ASSISTANT] ordinary claim']);
  const prompt = f.resume();
  const operatorAt = prompt.indexOf('  Recorded operator history');
  const directiveAt = prompt.indexOf('[OPERATOR] spaced directive');
  const claimsAt = prompt.indexOf('  Done: claims to re-check');
  assert.ok(operatorAt >= 0 && operatorAt < directiveAt && directiveAt < claimsAt);
});

test('R8.1: Done rows are claims and the documented verification gap stays explicit', (t) => {
  const f = fixture(t);
  const doc = f.write([user('Check the sample'), assistant('The sample service is deployed.')]);
  assert.doesNotMatch(doc, /\[UNVERIFIED claim\]/);
  assert.match(f.resume(), /claims to re-check[\s\S]*\[ASSISTANT\] The sample service is deployed/);
  const text = readFileSync(path.join(daemons, '..', 'docs/two-verb-lifecycle.md'), 'utf8');
  assert.match(text, /product source of command exit status/);
  assert.match(text, /transcript does not carry/);
  assert.match(text, /no product source of command exit status for verified tags today/i);
  assert.match(text, /\[UNVERIFIED claim\][^\n]*not emitted[^\n]*untagged rows are claims/i);
});

test('R8.2: all operators render in file order above the first twelve claims', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  const operators = Array.from({ length: 30 }, (_, i) => `- 23:58 [OPERATOR] op-${i};`);
  const claims = Array.from({ length: 15 }, (_, i) => `- 00:05 [ASSISTANT] claim-${i};`);
  f.done(claims.flatMap((row, i) => [row, operators[i], operators[i + 15]]));
  const prompt = f.resume();
  assert.equal((prompt.match(/op-\d+;/g) || []).length, 30);
  assert.deepEqual(prompt.match(/op-\d+;/g), claims.flatMap((_, i) => [`op-${i};`, `op-${i + 15};`]));
  assert.deepEqual(prompt.match(/claim-\d+;/g), Array.from({ length: 12 }, (_, i) => `claim-${i};`));
  assert.ok(prompt.indexOf('op-29;') < prompt.indexOf('claim-0;'));
  assert.match(prompt, /3 more Done rows in the capsule file/);
  assert.doesNotMatch(prompt, /newest.first/i);
});

test('#83: operator correction renders in its group above the claim it corrects', (t) => {
  const f = fixture(t);
  f.write([user('Prepare the configuration'), assistant('Configuration X is deployed; use X.')]);
  f.write([user('Actually use Y; the deployment claim was wrong.'), user('Write the capsule now.')]);
  const prompt = f.resume();
  const operatorAt = prompt.indexOf('Recorded operator history');
  const correctionAt = prompt.indexOf('[OPERATOR] Actually use Y');
  const claimsAt = prompt.indexOf('Done: claims to re-check');
  assert.ok(operatorAt < correctionAt && correctionAt < claimsAt);
  assert.ok(claimsAt < prompt.indexOf('[ASSISTANT] Configuration X'));
});

test('autosaves store accepted speech newest-first within and across Stop deltas', (t) => {
  const f = fixture(t);
  f.write([user('First directive'), assistant('First summary')]);
  const doc = f.write([user('Second directive'), assistant('Second summary'), user('Final correction')]);
  assert.deepEqual(doneRows(doc).map(lifecycle.capsuleRowKey), [
    '[OPERATOR] Final correction', '[ASSISTANT] Second summary', '[OPERATOR] Second directive',
    '[ASSISTANT] First summary', '[OPERATOR] First directive',
  ]);
});

test('R8.3: one operator survives twenty injections within a twelve-row delta', (t) => {
  const rows = doneRows(fixture(t).write([user('Keep the real directive'),
    ...Array.from({ length: 20 }, (_, i) => user(`[supervisor-resume] injection-${i};`)),
    assistant('Keep the assistant summary')]));
  assert.equal(rows.length, 12);
  assert.ok(rows.some((row) => row.includes('[OPERATOR] Keep the real directive')));
  assert.ok(rows.some((row) => row.includes('[ASSISTANT] Keep the assistant summary')));
});

test('R8.3: thirty utterances store at most twelve, retaining the latest operators', (t) => {
  const rows = doneRows(fixture(t).write(Array.from({ length: 30 }, (_, i) => user(`directive-${i};`))));
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.join('\n').match(/directive-\d+;/g), Array.from({ length: 12 }, (_, i) => `directive-${29 - i};`));
});

test('R8.3: operator pressure evicts the oldest relay after injections', (t) => {
  const rows = doneRows(fixture(t).write([
    user('[room from peer] oldest relay'), assistant('Older assistant'),
    ...Array.from({ length: 11 }, (_, i) => user(`operator-${i};`)),
    user('[supervisor-resume] newest injection'),
  ])).join('\n');
  assert.doesNotMatch(rows, /oldest relay|newest injection/);
  assert.match(rows, /Older assistant/);
  assert.equal(rows.split('\n').length, 12);
});

for (let level = 1; level <= 2; level++) {
  test(`R8.4: writer and reader both end Done at heading level ${level}`, (t) => {
    const f = fixture(t);
    f.write([user('Initial request')]);
    f.done(['- [ASSISTANT] visible claim', `${'#'.repeat(level)} Blocked`, '- [OPERATOR] same words']);
    const doc = f.write([user('same words')]);
    assert.ok(doneRows(doc).some((row) => row.includes('[OPERATOR] same words')),
      'a row under Blocked cannot suppress a fresh Done row');
    assert.match(doc, new RegExp(`${'#'.repeat(level)} Blocked\\n- \\[OPERATOR\\] same words`));
    assert.equal((f.resume().match(/same words/g) || []).length, 2, 'objective plus one Done row, not the Blocked row');
  });
}

for (let level = 3; level <= 6; level++) {
  test(`R10.3: heading level ${level} stays inside Done for writer and reader`, (t) => {
    const f = fixture(t);
    f.write([user('Initial request')]);
    f.done([`${'#'.repeat(level)} 2026-10-29`, '- [OPERATOR] nested directive']);
    const doc = f.write([user('nested directive')]);
    assert.equal((doc.match(/\[OPERATOR\] nested directive/g) || []).length, 1);
    assert.match(f.resume(), /\[OPERATOR\] nested directive/);
  });
}

test('R8.5: identical operator lines within one delta land once', (t) => {
  const rows = doneRows(fixture(t).write([user('Keep this directive'), user('Keep this directive')]));
  assert.equal(rows.length, 1);
});

test('R8.6: sidechain speech is skipped while tool metadata survives', (t) => {
  const doc = fixture(t).write([user('Parent directive'), {
    type: 'assistant', isSidechain: true, message: { content: [
      { type: 'text', text: 'Sidechain speech' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'subagent-edit.mjs' } },
      { type: 'tool_use', name: 'Write', input: { file_path: 'subagent-write.mjs' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'subagent-read.mjs' } },
      { type: 'tool_use', name: 'board_claim', input: { task_id: 'sidechain-task' } },
    ] },
  }, { type: 'user', isSidechain: true, message: { content: [
    { type: 'text', text: 'Sidechain request' },
    { type: 'tool_result', is_error: true, content: 'subagent tool error' },
  ] } }]);
  assert.match(doc, /MODIFIED subagent-edit\.mjs/);
  assert.match(doc, /MODIFIED subagent-write\.mjs/);
  assert.match(doc, /read subagent-read\.mjs/);
  assert.match(doc, /sidechain-task/);
  assert.match(doc, /subagent tool error/);
  assert.doesNotMatch(doc, /Sidechain speech|Sidechain request/);
});

test('Done retains stored history and deduplicates tagged and legacy claims on replay', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  const old = Array.from({ length: 30 }, (_, i) => `- [OPERATOR] old-${i};`);
  f.done([...old, '- legacy claim']);
  const doc = f.write([assistant('legacy claim'), user('Fresh directive'), user('Fresh directive')]);
  assert.equal(doneRows(doc).length, 32);
  assert.equal((doc.match(/legacy claim/g) || []).length, 1);
  assert.deepEqual(doneRows(doc).filter((row) => row.includes('old-')), old);
});

test('an assistant quoting OPERATOR stays in claims and cannot suppress the real operator', (t) => {
  const f = fixture(t);
  f.write([assistant('[OPERATOR] pin the scheduler')]);
  f.write([user('pin the scheduler')]);
  const prompt = f.resume();
  assert.match(prompt, /Recorded operator history[\s\S]*\[OPERATOR\] pin the scheduler/);
  assert.match(prompt, /claims to re-check[\s\S]*\[ASSISTANT\] \[OPERATOR\] pin the scheduler/);
});

for (const long of [false, true]) {
  test(`300 Done rows fit 8 KiB with file-order claim prefix (long=${long})`, (t) => {
    const f = fixture(t);
    f.write([user('Initial request')]);
    f.done(['- [OPERATOR] first operator', '- [OPERATOR] second operator',
      ...Array.from({ length: 298 }, (_, i) => `- [ASSISTANT] claim-${i}; ${long ? '界😀"'.repeat(500) : 'short'}`)]);
    const section = f.resume().split('  Recorded operator history')[1];
    assert.ok(Buffer.byteLength('  Recorded operator history' + section) <= 8192);
    const claims = section.match(/claim-\d+;/g) || [];
    assert.ok(claims.length > 0 && claims.length <= 12);
    if (!long) assert.equal(claims.length, 12);
    assert.deepEqual(claims, Array.from({ length: claims.length }, (_, i) => `claim-${i};`));
    assert.match(section, new RegExp(`${298 - claims.length} more Done rows in the capsule file`));
  });
}

test('tag-only and oversized tag rows cannot create empty groups or exhaust usable content', (t) => {
  const f = fixture(t);
  f.write([user('Initial request')]);
  f.done(['- [OPERATOR]', '- [ASSISTANT]']);
  assert.equal(renderedRows(f.resume()).length, 0);
  f.done(['- [OPERATOR] [RELAY:' + 'x'.repeat(5000) + '] hidden text', '- [OPERATOR] [draft] usable text']);
  const prompt = f.resume();
  assert.match(prompt, /usable text/);
  assert.doesNotMatch(prompt, /hidden text/);
  assert.match(prompt, /1 more Done rows in the capsule file/);
});

