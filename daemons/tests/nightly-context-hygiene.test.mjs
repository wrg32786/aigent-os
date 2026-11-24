import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectSessionLog } from '../nightly-context-hygiene.mjs';

const cli = fileURLToPath(new URL('../nightly-context-hygiene.mjs', import.meta.url));
const skill = new URL('../../skills/context-capsule/SKILL.md', import.meta.url);
const priorities = '## Operating Mode: Focused\nLast reviewed: 2026-03-06\n## Tier 1\n- Review changes\n';
const lines = ['06', '05', '04', '03', '02', '01'].map(
  (day) => `- 2026-03-${day} notes: Reviewed changes.`,
);

function block(day) {
  return [
    `## 2026-03-${day} - Notes`,
    '**Objective:** Review.',
    '**Completed:** Read.',
    '**Decisions:** Keep.',
    '**Open threads:** None.',
    '**Next action:** Close.',
  ].join('\n');
}

function check(t, log, { count, ok = true, errors = [], ordered = true }) {
  const root = mkdtempSync(path.join(tmpdir(), 'session-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, 'vault', 'memory');
  mkdirSync(memory, { recursive: true });
  const sessionFile = path.join(memory, 'SESSION_LOG.md');
  const prioritiesFile = path.join(memory, 'ACTIVE_PRIORITIES.md');
  writeFileSync(sessionFile, log);
  writeFileSync(prioritiesFile, priorities);

  const session = inspectSessionLog(log);
  const run = spawnSync(process.execPath, [cli, '--root', root], {
    encoding: 'utf8', env: { ...process.env, AIGENT_STATE_HOME_DIR: root },
  });
  if (run.error) throw run.error;
  t.diagnostic(`exit=${run.status} ${run.stdout.trimEnd()}`);
  t.diagnostic(`${session.detail} | lines=${JSON.stringify(session.unfamiliarLines)}`);
  assert.equal(run.stderr, '');
  assert.equal(run.status, ok ? 0 : 1);
  assert.equal(run.stdout, `CONTEXT_HYGIENE ${ok ? 'PASS' : 'FAIL'} session_entries=${count}`
    + ` retention_limit=5 block_errors=${errors.length} newest_first=${ordered ? 'yes' : 'no'}`
    + ' operating_modes=1 live_priorities=1 placeholders=0 last_reviewed=yes embedded_archive=no\n');
  assert.equal(session.ok, ok);
  assert.equal(session.total, count);
  assert.deepEqual(session.unfamiliarLines, errors);
  const entryCount = `${count} session ${count === 1 ? 'entry' : 'entries'}`;
  assert.equal(session.detail, ok
    ? `${entryCount}, newest first (limit 5)`
    : `${entryCount}; limit=5; malformed=${errors.length}; newest_first=${ordered ? 'yes' : 'no'}`);
  assert.equal(readFileSync(sessionFile, 'utf8'), log);
  assert.equal(readFileSync(prioritiesFile, 'utf8'), priorities);
}

test('five one-line entries pass', (t) => {
  check(t, lines.slice(0, 5).join('\n'), { count: 5 });
});

test('six one-line entries exceed the limit', (t) => {
  check(t, lines.join('\n'), { count: 6, ok: false });
});

test('one-line entries must be newest first', (t) => {
  check(t, [lines[1], lines[0]].join('\n'), { count: 2, ok: false, ordered: false });
});

for (const [reason, line] of [
  ['missing colon', '- 2026-03-05 notes'],
  ['empty summary', '- 2026-03-05 notes:   '],
  ['impossible date', '- 2026-02-30 notes: Reviewed changes.'],
  ['three identifier tokens', '- 2026-03-05 morning review notes: Reviewed changes.'],
]) {
  test(`a dated bullet with ${reason} reports its line`, (t) => {
    check(t, [lines[0], '', line, 'Guidance follows.'].join('\r\n'),
      { count: 1, ok: false, errors: [3] });
  });
}

test('three one-line entries and two blocks share the five places', (t) => {
  check(t, [...lines.slice(0, 3), block('03'), block('02')].join('\n'), { count: 5 });
});

test('six mixed entries exceed the limit', (t) => {
  check(t, [...lines.slice(0, 4), block('02'), block('01')].join('\n'),
    { count: 6, ok: false });
});

test('date order crosses from a one-line entry to a block', (t) => {
  check(t, [lines[4], block('03')].join('\n'), { count: 2, ok: false, ordered: false });
});

test('a dated bullet can supply the text of a block field', (t) => {
  check(t, [block('06').replace(' Close.', ''), lines[1]].join('\n'),
    { count: 1 });
});

test('a valid block keeps its receipt', (t) => {
  check(t, block('06') + '\n', { count: 1 });
});

function blockWithBullet(day, bullet = '- 2026-03-05 shipped: the thing') {
  return block(day).replace('**Decisions:**', bullet + '\n**Decisions:**');
}

test('a dated bullet with a colon between fields belongs to the block', (t) => {
  check(t, blockWithBullet('06'), { count: 1 });
});

test('a dated bullet without a colon between fields belongs to the block', (t) => {
  check(t, blockWithBullet('06', '- 2026-03-05 shipped the thing'), { count: 1 });
});

test('five blocks with dated bullets count as five entries', (t) => {
  const blocks = ['06', '05', '04', '03', '02'].map((day) => blockWithBullet(day));
  check(t, blocks.join('\n'), { count: 5 });
});

test('a capsule line below a complete block belongs to that block', (t) => {
  check(t, [block('03'), lines[0]].join('\n'), { count: 1 });
});

test('three capsule lines above two blocks with dated bullets count as five entries', (t) => {
  check(t, [...lines.slice(0, 3), blockWithBullet('03'), blockWithBullet('02')].join('\n'),
    { count: 5 });
});

for (const [name, gap] of [['two spaces', '  '], ['a tab', '\t']]) {
  test(`a capsule line with ${name} after the dash counts above a block`, (t) => {
    check(t, [`-${gap}2026-03-05 notes: Reviewed changes.`, block('04')].join('\n'),
      { count: 2 });
  });

  test(`a malformed capsule line with ${name} after the dash reports its line`, (t) => {
    check(t, ['---', 'title: Notes', '---', `-${gap}2026-03-05 notes`, block('04')].join('\n'),
      { count: 1, ok: false, errors: [4] });
  });
}

test('frontmatter, title, guidance, fenced examples and archive links are ignored', (t) => {
  check(t, [
    '---', 'examples:', lines[5], '---', '# Session Log', 'Record the newest entry first.',
    '- [Older entries](SESSION_LOG_ARCHIVE_2026-03-01.md)', lines[0],
    '```text', lines[1], '```', '- 2026-03-06 morning notes: Reviewed: all changes.',
    'See [[SESSION_LOG_ARCHIVE_2026-03-01]].',
  ].join('\n'), { count: 2 });
});

test('the capsule skill writes a valid session entry', (t) => {
  const definition = readFileSync(skill, 'utf8').split(/\r?\n/).find(
    (line) => line.includes('vault/memory/SESSION_LOG.md') && line.includes('<capsule-id>'),
  );
  assert.ok(definition, 'expected the session log format in the capsule skill');
  const template = definition.match(/`([^`]*<capsule-id>[^`]*)`/)?.[1];
  assert.ok(template, 'expected a session entry example');
  const entry = template.replace('<YYYY-MM-DD>', '2026-03-06')
    .replace('<capsule-id>', '2026-03-06-notes').replace('<one-line summary>', 'Reviewed changes.');
  assert.doesNotMatch(entry, /[<>]/);
  check(t, entry, { count: 1 });
});

const fieldBullet = block('06').replace('**Completed:** Read.', '**Completed:**\n' + lines[1]);
const metadata = [
  '---', 'dates:', '- 2026-03-06', '- 2026-03-05', '# A comment',
  'example: |', '  <!--', '  ```', '---',
].join('\n');
for (const [name, log, ok, count, errors] of [
  ['byte order mark before the title', '\uFEFF# Session Log\n' + block('06'), true, 1, []],
  ['byte order mark before frontmatter', '\uFEFF---\ndates:\n- 2026-03-05\n---\n' + block('06'), true, 1, []],
  ['byte order mark before the first dated header', '\uFEFF' + block('06'), false, 0, []],
  ['dated field continuation', fieldBullet, true, 1, []],
  ['dated field continuation with a byte order mark', '\uFEFF' + fieldBullet, false, 0, []],
  ['fence marker, comments and bare dates in frontmatter',
    [metadata, '<!--', '```', '-->', block('06')].join('\n'), true, 1, []],
  ['CRLF line endings', [block('06'), '## 2026-02-30 - Notes'].join('\n').replaceAll('\n', '\r\n'), false, 1, [7]],
  ['missing field', block('06').replace('**Completed:** Read.\n', ''), false, 1, [1]],
  ['empty field', block('06').replace('**Completed:** Read.', '**Completed:**'), false, 1, [1]],
  ['duplicate field', block('06') + '\n**Completed:** Reviewed.', false, 1, [1]],
]) {
  test(`block parity with master: ${name}`, (t) => {
    check(t, log, { ok, count, errors });
  });
}

for (const count of [5, 6]) {
  test(`a byte order mark before ${count} capsule lines keeps the full count`, (t) => {
    check(t, '\uFEFF' + lines.slice(0, count).join('\n'), { count, ok: count === 5 });
  });
}

test('five capsule lines follow frontmatter with a fence marker and bare dates', (t) => {
  check(t, [metadata, ...lines.slice(0, 5)].join('\n'), { count: 5 });
});

test('a summary can start with a nonbreaking space', (t) => {
  check(t, '- 2026-03-06 notes:\u00a0Reviewed.', { count: 1 });
});

test('a nonbreaking space alone leaves the summary empty', (t) => {
  check(t, [lines[0], '- 2026-03-05 notes:\u00a0', 'Reviewed.'].join('\n'),
    { count: 1, ok: false, errors: [2] });
});

for (const [name, gap] of [['a tab', '\t'], ['two spaces', '  ']]) {
  test(`${name} between the date and identifier reports the capsule line`, (t) => {
    check(t, [lines[0], `- 2026-03-05${gap}notes: Reviewed.`].join('\n'),
      { count: 1, ok: false, errors: [2] });
  });
}

test('an impossible dated header ends the capsule region', (t) => {
  check(t, [lines[0], '## 2026-02-30 - Notes', lines[1]].join('\n'),
    { count: 1, ok: false, errors: [2] });
});

test('a dated header without a title ends the capsule region', (t) => {
  check(t, [lines[0], '##\t2026-03-05', lines[1]].join('\n'), { count: 1 });
});

test('a dotted frontmatter closer preserves original CRLF line numbers', (t) => {
  check(t, ['\uFEFF---\t', 'example: |', '  ```', '...', lines[0], '- 2026-03-05'].join('\r\n'),
    { count: 1, ok: false, errors: [6] });
});

test('an opening delimiter without a closer leaves capsule lines visible', (t) => {
  check(t, ['---', lines[0]].join('\n'), { count: 1 });
});
