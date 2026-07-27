// stop-capsule-writer.test.mjs — autosave capsule truthfulness + fail-open guard.
//
// Black-box by design: every case spawns the shipped worker against an isolated
// OS-temp memory root and inspects the capsule that actually landed. Validator
// and content-gate failure cases copy the shipped daemon plus its static local
// dependencies, then replace only the dependency whose failure is under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCapsuleText } from '../capsule-verb.mjs';
import { FRAMING_KEYS } from '../memory-hygiene/resume-framing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS = path.join(__dirname, '..');
const DAEMON = process.env.SCW_DAEMON
  || path.join(DAEMONS, 'stop-capsule-writer.mjs');
const CAPSULE_VERB = path.join(DAEMONS, 'capsule-verb.mjs');
const CONTENT_GATE = path.join(DAEMONS, 'capsule-content-gate.mjs');
const LIFECYCLE_COMMON = path.join(DAEMONS, 'lifecycle-common.mjs');
const RESUME_FRAMING = path.join(DAEMONS, 'memory-hygiene', 'resume-framing.mjs');
const ATOMIC_STATE = path.join(DAEMONS, 'memory-hygiene', 'atomic-state.cjs');

const LEGACY_OBJECTIVE = 'In-flight work (auto-captured; see latest session log)';
const LEGACY_NEXT_ACTION = 'Re-derive the next action from live memory; last assistant state: severed mid-work';
const NO_ACTION = 'No concrete next action was captured in this Stop delta.';
const ASSISTANT_SENTINEL = 'RAW_ASSISTANT_SENTINEL should stay in the reference body only';
const FRONTMATTER_FIELDS = [
  'id', 'parent_capsule_id', 'status', 'objective', 'waiting_on',
  'resume_trigger', 'expires', 'trigger', 'next_valid_action',
  'success_criteria', 'tags', 'created_at', 'resolved_at',
  ...FRAMING_KEYS,
];
const ANCHORS = [
  '<!-- swe:done -->',
  '<!-- swe:errors -->',
  '<!-- swe:rejected -->',
  '<!-- swe:files -->',
  '<!-- swe:facts -->',
  '<!-- swe:gates -->',
  '<!-- swe:rows -->',
];
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function makeFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'stop-capsule-writer-'));
  const root = path.join(base, 'test-root');
  const memory = path.join(root, 'memory');
  const capsules = path.join(memory, 'capsules');
  mkdirSync(capsules, { recursive: true });
  writeFileSync(path.join(memory, 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  return { base, root, memory, capsules };
}

function runWorker(fixture, events, {
  daemon = DAEMON,
  sessionId = '01234567-test-session',
  env = {},
} = {}) {
  const transcriptPath = path.join(fixture.root, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const payload = {
    __root: fixture.root,
    session_id: sessionId,
    transcript_path: transcriptPath,
  };
  const run = spawnSync(process.execPath, [daemon, '--worker', JSON.stringify(payload)], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      AIGENT_ROOT: fixture.root,
      AIGENT_STATE_HOME_DIR: '',
      AIGENT_SEAT_ID: '',
      CLAUDE_PROJECT_DIR: '',
      LIFECYCLE_KILL_STOP_WRITER: '0',
      ...env,
    },
  });
  const statePath = path.join(fixture.memory, 'runtime', 'stop-writer', `${sessionId}.json`);
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : null;
  const capsulePath = state?.capsule_path || null;
  const doc = capsulePath && existsSync(capsulePath)
    ? readFileSync(capsulePath, 'utf8')
    : null;
  return { run, state, capsulePath, doc };
}

function expectedCapsulePath(fixture, sessionId) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(fixture.capsules, `${date}-auto-${sessionId.slice(0, 8)}.md`);
}

function assistantEvent(text = ASSISTANT_SENTINEL) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

function userEvent(text) {
  return {
    type: 'user',
    isMeta: false,
    message: { content: text },
  };
}

function claimEvent(rowId, text = ASSISTANT_SENTINEL) {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'mcp__tasks__board_claim',
          input: { task_id: rowId },
        },
        { type: 'text', text },
      ],
    },
  };
}

function fileWriteEvent(filePath, text = ASSISTANT_SENTINEL) {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: filePath },
        },
        { type: 'text', text },
      ],
    },
  };
}

function toolErrorEvent(message) {
  return {
    type: 'user',
    isMeta: false,
    message: {
      content: [{ type: 'tool_result', is_error: true, content: message }],
    },
  };
}

function frontmatterKeys(doc) {
  const frontmatter = doc.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  assert.ok(frontmatter, 'capsule must have closed leading frontmatter');
  return frontmatter.split(/\r?\n/)
    .map((line) => line.match(/^([a-z_]+):/)?.[1])
    .filter(Boolean);
}

function bodyPointer(fixture) {
  return JSON.parse(
    readFileSync(path.join(fixture.memory, 'BODY_STATE.json'), 'utf8'),
  ).state.last_capsule;
}

function errorLog(fixture) {
  const file = path.join(fixture.memory, '.daemon-errors.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function assertWorkerFlushed(result) {
  assert.equal(result.run.status, 0, result.run.stderr);
  assert.match(result.run.stdout || '', /SWE_OUTCOME:flushed/);
  assert.ok(result.doc?.length, 'worker must land a non-empty capsule');
}

function withFixture(run) {
  const fixture = makeFixture();
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

function existingCapsule({
  id,
  objective = LEGACY_OBJECTIVE,
  waitingOn = 'null',
  nextAction = JSON.stringify(LEGACY_NEXT_ACTION),
  tagsLine = 'tags: [capsule, autosave]',
  bodyTail = '',
}) {
  return `---
id: ${id}
parent_capsule_id: null
status: active
objective: ${JSON.stringify(objective)}
waiting_on: ${waitingOn}
resume_trigger: compact
expires: null
trigger: stop-delta
next_valid_action: ${nextAction}
success_criteria: []
${tagsLine ? `${tagsLine}\n` : ''}created_at: 2026-07-27T00:00:00.000Z
resolved_at: null
---

## Done (don't redo)
<!-- swe:done -->

## Historical-Errors → Resolutions
<!-- swe:errors -->

## Historical-Rejected-Approaches
<!-- swe:rejected -->

## Files-Read / Files-Modified
<!-- swe:files -->

## Operating-Facts
<!-- swe:facts -->

## Pending-Gates
<!-- swe:gates -->

## Claimed-Rows
<!-- swe:rows -->
${bodyTail}`;
}

function installExistingCapsule(fixture, sessionId, doc, name = `${sessionId}.md`) {
  const capsulePath = path.join(fixture.capsules, name);
  writeFileSync(capsulePath, doc);
  const runtime = path.join(fixture.memory, 'runtime', 'stop-writer');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, `${sessionId}.json`), JSON.stringify({
    offset: 0,
    capsule_path: capsulePath,
    last_delta_sha: null,
  }));
  return capsulePath;
}

function writeInstrumentedDaemon(fixture, {
  validatorSource = null,
  gateSource = null,
} = {}) {
  const daemonDir = path.join(fixture.base, 'instrumented-daemons');
  const hygieneDir = path.join(daemonDir, 'memory-hygiene');
  mkdirSync(hygieneDir, { recursive: true });

  const daemon = path.join(daemonDir, 'stop-capsule-writer.mjs');
  copyFileSync(DAEMON, daemon);
  copyFileSync(LIFECYCLE_COMMON, path.join(daemonDir, 'lifecycle-common.mjs'));
  copyFileSync(RESUME_FRAMING, path.join(hygieneDir, 'resume-framing.mjs'));
  copyFileSync(ATOMIC_STATE, path.join(hygieneDir, 'atomic-state.cjs'));

  if (gateSource === null) copyFileSync(CONTENT_GATE, path.join(daemonDir, 'capsule-content-gate.mjs'));
  else writeFileSync(path.join(daemonDir, 'capsule-content-gate.mjs'), gateSource);

  if (validatorSource === null) copyFileSync(CAPSULE_VERB, path.join(daemonDir, 'capsule-verb.mjs'));
  else writeFileSync(path.join(daemonDir, 'capsule-verb.mjs'), validatorSource);
  return daemon;
}

test('fresh assistant-only autosave names an unknown objective instead of the legacy placeholder', () => {
  withFixture((fixture) => {
    const result = runWorker(fixture, [assistantEvent()]);
    assertWorkerFlushed(result);
    const checked = validateCapsuleText(result.doc);
    assert.match(checked.fields.objective, /^Unknown:/);
    assert.notEqual(checked.fields.objective, LEGACY_OBJECTIVE);
    assert.deepEqual(frontmatterKeys(result.doc), FRONTMATTER_FIELDS);
    for (const anchor of ANCHORS) {
      assert.equal(result.doc.split(anchor).length - 1, 1, `${anchor} must be preserved exactly once`);
    }
  });
});

test('fresh autosave writes an explicit unknown waiting state and passes the shared validator', () => {
  withFixture((fixture) => {
    const result = runWorker(fixture, [assistantEvent()]);
    assertWorkerFlushed(result);
    const checked = validateCapsuleText(result.doc);
    assert.match(checked.fields.waiting_on, /^Unknown:.*pending/i);
    assert.doesNotMatch(result.doc, /^waiting_on:[ \t]*(?:null|~)[ \t]*$/mi);
    assert.deepEqual(checked.problems, []);
  });
});

test('unstructured assistant prose never becomes next_valid_action', () => {
  withFixture((fixture) => {
    const result = runWorker(fixture, [assistantEvent()]);
    assertWorkerFlushed(result);
    const { next_valid_action: next } = validateCapsuleText(result.doc).fields;
    assert.equal(next, NO_ACTION);
    assert.doesNotMatch(next, /RAW_ASSISTANT_SENTINEL|last assistant state/i);
  });
});

test('a structured board claim yields a row-specific action without a raw assistant tail', () => {
  withFixture((fixture) => {
    const rowId = 'abcdef12-3456-7890-abcd-ef1234567890';
    const result = runWorker(fixture, [claimEvent(rowId)]);
    assertWorkerFlushed(result);
    const { objective, next_valid_action: next } = validateCapsuleText(result.doc).fields;
    assert.match(objective, /^Unknown:.*claimed row id\(s\) abcdef12/i);
    assert.match(next, /claimed row\(s\) abcdef12/i);
    assert.doesNotMatch(next, /RAW_ASSISTANT_SENTINEL|last assistant state/i);
  });
});

test('a real human request becomes the objective while unknown lifecycle fields stay honest', () => {
  withFixture((fixture) => {
    const request = 'Fix the Stop autosave lifecycle artifact';
    const result = runWorker(fixture, [userEvent(request), assistantEvent()]);
    assertWorkerFlushed(result);
    const checked = validateCapsuleText(result.doc);
    assert.equal(checked.fields.objective, request);
    assert.match(checked.fields.waiting_on, /^Unknown:/);
    assert.equal(checked.fields.next_valid_action, NO_ACTION);
    assert.doesNotMatch(checked.fields.next_valid_action, /RAW_ASSISTANT_SENTINEL/);
  });
});

test('captured tool errors mark uncertainty without inventing a next action', () => {
  withFixture((fixture) => {
    const error = 'TOOL_ERROR_SENTINEL connection reset';
    const result = runWorker(fixture, [toolErrorEvent(error), assistantEvent()]);
    assertWorkerFlushed(result);
    const checked = validateCapsuleText(result.doc);
    assert.match(checked.fields.waiting_on, /^Unknown: 1 captured tool error\(s\) may be pending/);
    assert.equal(checked.fields.next_valid_action, NO_ACTION);
    assert.doesNotMatch(checked.fields.next_valid_action, /RAW_ASSISTANT_SENTINEL|TOOL_ERROR_SENTINEL/);
  });
});

test('a file write is historical evidence, not a fabricated next action', () => {
  withFixture((fixture) => {
    const result = runWorker(fixture, [fileWriteEvent('src/example.mjs')]);
    assertWorkerFlushed(result);
    const { next_valid_action: next } = validateCapsuleText(result.doc).fields;
    assert.equal(next, NO_ACTION);
    assert.doesNotMatch(next, /verify the changes|RAW_ASSISTANT_SENTINEL|last assistant state/i);
  });
});

test('malformed-but-parseable transcript records are skipped and a capsule still lands', () => {
  withFixture((fixture) => {
    const result = runWorker(fixture, [
      null,
      {
        type: 'user',
        message: {
          content: [
            null,
            42,
            [],
            { type: 'text', text: 42 },
            {
              type: 'tool_result',
              is_error: true,
              content: [null, 42, [], { type: 'text', text: 99 }],
            },
          ],
        },
      },
      { type: 'assistant', message: { content: { type: 'text', text: 'not an array' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 42 }] } },
      assistantEvent('VALID_EVENT_AFTER_BAD_SHAPES'),
    ]);
    assertWorkerFlushed(result);
    const checked = validateCapsuleText(result.doc);
    assert.match(checked.fields.objective, /^Unknown:/);
    assert.match(checked.fields.waiting_on, /^Unknown:/);
    assert.equal(checked.fields.next_valid_action, NO_ACTION);
    assert.deepEqual(checked.problems, []);
  });
});

test('malformed claim task ids do not fabricate row-specific objectives or actions', () => {
  withFixture((fixture) => {
    const malformedClaims = [42, true, {}, [], '', '   '].map((taskId) => ({
      type: 'tool_use',
      name: 'mcp__tasks__board_claim',
      input: { task_id: taskId },
    }));
    const result = runWorker(fixture, [{
      type: 'assistant',
      message: {
        content: [...malformedClaims, { type: 'text', text: ASSISTANT_SENTINEL }],
      },
    }]);
    assertWorkerFlushed(result);
    const checked = validateCapsuleText(result.doc);
    assert.equal(
      checked.fields.objective,
      'Unknown: no operator objective was captured in this Stop delta.',
    );
    assert.equal(checked.fields.next_valid_action, NO_ACTION);
    const rows = result.doc.split('<!-- swe:rows -->')[1] || '';
    assert.doesNotMatch(rows, /^- .*claimed:/m);
  });
});

test('the shared validator receives the exact final document that lands on disk', () => {
  withFixture((fixture) => {
    const seenPath = path.join(fixture.base, 'validator-seen.txt');
    const sessionId = 'validator-call-session';
    const capsulePath = expectedCapsulePath(fixture, sessionId);
    const daemon = writeInstrumentedDaemon(fixture, {
      validatorSource: `
        import { existsSync, writeFileSync } from 'node:fs';
        export function validateCapsuleText(text) {
          writeFileSync(process.env.STOP_WRITER_VALIDATOR_SEEN, JSON.stringify({
            capsuleExisted: existsSync(process.env.STOP_WRITER_EXPECTED_CAPSULE),
            text,
          }));
          return { fields: {}, problems: [] };
        }
      `,
    });
    const result = runWorker(fixture, [assistantEvent('FINAL_MERGE_SENTINEL')], {
      daemon,
      sessionId,
      env: {
        STOP_WRITER_VALIDATOR_SEEN: seenPath,
        STOP_WRITER_EXPECTED_CAPSULE: capsulePath,
      },
    });
    assertWorkerFlushed(result);
    const seen = JSON.parse(readFileSync(seenPath, 'utf8'));
    assert.equal(seen.capsuleExisted, false, 'validation must run before the capsule commit');
    assert.equal(seen.text, result.doc);
    assert.match(result.doc, /FINAL_MERGE_SENTINEL/);
  });
});

test('a throwing validator is logged but still exits zero and writes the final capsule', () => {
  withFixture((fixture) => {
    const seenPath = path.join(fixture.base, 'validator-threw-seen.txt');
    const daemon = writeInstrumentedDaemon(fixture, {
      validatorSource: `
        import { writeFileSync } from 'node:fs';
        export function validateCapsuleText(text) {
          writeFileSync(process.env.STOP_WRITER_VALIDATOR_SEEN, text);
          throw new Error('FORCED_VALIDATOR_THROW');
        }
      `,
    });
    const result = runWorker(fixture, [assistantEvent('THROW_FINAL_MERGE_SENTINEL')], {
      daemon,
      env: { STOP_WRITER_VALIDATOR_SEEN: seenPath },
    });
    assertWorkerFlushed(result);
    assert.equal(readFileSync(seenPath, 'utf8'), result.doc);
    assert.match(result.doc, /THROW_FINAL_MERGE_SENTINEL/);
    assert.match(errorLog(fixture), /capsule validation threw; write continues fail-open/);
    assert.match(errorLog(fixture), /FORCED_VALIDATOR_THROW/);
  });
});

test('reported validation problems are logged but the capsule still lands', () => {
  withFixture((fixture) => {
    const seenPath = path.join(fixture.base, 'validator-problem-seen.txt');
    const sessionId = 'problem1-final-doc-fallback';
    const finalObjective = 'Preserve "final" objective at C:\\work\\reported-problem.md';
    installExistingCapsule(
      fixture,
      sessionId,
      existingCapsule({
        id: 'problem1-final-doc-fallback',
        objective: finalObjective,
      }),
      'problem1-final-doc-fallback.md',
    );
    const daemon = writeInstrumentedDaemon(fixture, {
      validatorSource: `
        import { writeFileSync } from 'node:fs';
        export function validateCapsuleText(text) {
          writeFileSync(process.env.STOP_WRITER_VALIDATOR_SEEN, text);
          return { fields: null, problems: ['FORCED_UNRESOLVABLE_FIELD'] };
        }
      `,
    });
    const result = runWorker(fixture, [assistantEvent('PROBLEM_FINAL_MERGE_SENTINEL')], {
      daemon,
      sessionId,
      env: { STOP_WRITER_VALIDATOR_SEEN: seenPath },
    });
    assertWorkerFlushed(result);
    assert.equal(readFileSync(seenPath, 'utf8'), result.doc);
    assert.match(result.doc, /PROBLEM_FINAL_MERGE_SENTINEL/);
    assert.equal(validateCapsuleText(result.doc).fields.objective, finalObjective);
    assert.equal(bodyPointer(fixture).objective, finalObjective);
    assert.match(errorLog(fixture), /capsule validation reported 1 problem\(s\); write continues fail-open/);
    assert.match(errorLog(fixture), /FORCED_UNRESOLVABLE_FIELD/);
  });
});

test('an unexpected validator result is logged but the capsule still lands', () => {
  withFixture((fixture) => {
    const seenPath = path.join(fixture.base, 'validator-shape-seen.txt');
    const daemon = writeInstrumentedDaemon(fixture, {
      validatorSource: `
        import { writeFileSync } from 'node:fs';
        export function validateCapsuleText(text) {
          writeFileSync(process.env.STOP_WRITER_VALIDATOR_SEEN, text);
          return { fields: {}, problems: 'not-an-array' };
        }
      `,
    });
    const result = runWorker(fixture, [assistantEvent('SHAPE_FINAL_MERGE_SENTINEL')], {
      daemon,
      env: { STOP_WRITER_VALIDATOR_SEEN: seenPath },
    });
    assertWorkerFlushed(result);
    assert.equal(readFileSync(seenPath, 'utf8'), result.doc);
    assert.match(errorLog(fixture), /validateCapsuleText\(\) returned an unexpected result/);
  });
});

test('a validator import failure is logged but the capsule still lands', () => {
  withFixture((fixture) => {
    const seenPath = path.join(fixture.base, 'validator-import-seen.txt');
    const daemon = writeInstrumentedDaemon(fixture, {
      validatorSource: `
        import { writeFileSync } from 'node:fs';
        writeFileSync(process.env.STOP_WRITER_VALIDATOR_SEEN, 'import attempted');
        throw new Error('FORCED_VALIDATOR_IMPORT_FAILURE');
      `,
    });
    const result = runWorker(fixture, [assistantEvent('IMPORT_FINAL_MERGE_SENTINEL')], {
      daemon,
      env: { STOP_WRITER_VALIDATOR_SEEN: seenPath },
    });
    assertWorkerFlushed(result);
    assert.equal(readFileSync(seenPath, 'utf8'), 'import attempted');
    assert.match(result.doc, /IMPORT_FINAL_MERGE_SENTINEL/);
    assert.match(errorLog(fixture), /capsule validator import failed \(write continues fail-open\)/);
    assert.match(errorLog(fixture), /FORCED_VALIDATOR_IMPORT_FAILURE/);
  });
});

test('a throwing content gate is logged but the capsule still lands', () => {
  withFixture((fixture) => {
    const daemon = writeInstrumentedDaemon(fixture, {
      gateSource: `
        export function isInjectionEcho() {
          throw new Error('FORCED_CONTENT_GATE_THROW');
        }
        export function isCeremonyAction() { return false; }
        export function contentProblems() { return []; }
      `,
    });
    const result = runWorker(
      fixture,
      [userEvent('A real request still needs a Stop snapshot'), assistantEvent('GATE_THROW_SENTINEL')],
      { daemon },
    );
    assertWorkerFlushed(result);
    assert.match(result.doc, /GATE_THROW_SENTINEL/);
    assert.match(errorLog(fixture), /FORCED_CONTENT_GATE_THROW/);
    assert.match(errorLog(fixture), /content-gate/i);
  });
});

test('a failed temporary write falls back to a direct capsule write', () => {
  withFixture((fixture) => {
    const sessionId = 'tmpfail1-direct-fallback';
    const capsulePath = expectedCapsulePath(fixture, sessionId);
    mkdirSync(`${capsulePath}.tmp`);
    const result = runWorker(fixture, [assistantEvent('DIRECT_WRITE_SENTINEL')], {
      sessionId,
    });
    assertWorkerFlushed(result);
    assert.equal(result.capsulePath, capsulePath);
    assert.match(result.doc, /DIRECT_WRITE_SENTINEL/);
    assert.match(errorLog(fixture), /capsule tmp write failed; attempting direct write/);
  });
});

test('the next Stop heals all three defective fields in an existing legacy autosave', () => {
  withFixture((fixture) => {
    const sessionId = '89abcdef-legacy-session';
    installExistingCapsule(
      fixture,
      sessionId,
      existingCapsule({ id: '2026-07-27-auto-89abcdef' }),
      '2026-07-27-auto-89abcdef.md',
    );

    const result = runWorker(fixture, [assistantEvent()], { sessionId });
    assertWorkerFlushed(result);
    const checked = validateCapsuleText(result.doc);
    assert.match(checked.fields.objective, /^Unknown:/);
    assert.notEqual(checked.fields.objective, LEGACY_OBJECTIVE);
    assert.match(checked.fields.waiting_on, /^Unknown:/);
    assert.equal(checked.fields.next_valid_action, NO_ACTION);
    assert.doesNotMatch(checked.fields.next_valid_action, /last assistant state|severed|RAW_ASSISTANT_SENTINEL/i);
    assert.deepEqual(checked.problems, []);
    assert.equal(bodyPointer(fixture).objective, checked.fields.objective);
  });
});

test('a meaningful autosave objective survives healing and the pointer uses its exact parsed value', () => {
  withFixture((fixture) => {
    const sessionId = 'meaning1-preserved-objective';
    const objective = 'Keep "quoted" work at C:\\work\\capsules\\draft.md';
    const encodedObjective = JSON.stringify(objective);
    const parsedObjective = objective;
    installExistingCapsule(
      fixture,
      sessionId,
      existingCapsule({
        id: 'meaningful-existing-autosave',
        objective,
      }),
      'meaningful-existing-autosave.md',
    );

    const result = runWorker(fixture, [assistantEvent()], { sessionId });
    assertWorkerFlushed(result);
    assert.match(result.doc, new RegExp(`^objective: ${escapeRegExp(encodedObjective)}$`, 'm'));
    const checked = validateCapsuleText(result.doc);
    assert.equal(checked.fields.objective, parsedObjective);
    assert.match(checked.fields.waiting_on, /^Unknown:/);
    assert.equal(checked.fields.next_valid_action, NO_ACTION);
    assert.equal(bodyPointer(fixture).objective, parsedObjective);
  });
});

test('an autosave near-match tag cannot authorize contract-field healing', () => {
  withFixture((fixture) => {
    const sessionId = 'near-tag-no-ownership';
    installExistingCapsule(
      fixture,
      sessionId,
      existingCapsule({
        id: 'near-tag-no-ownership',
        tagsLine: 'tags: [capsule, not-autosave]',
      }),
    );

    const result = runWorker(fixture, [assistantEvent()], { sessionId });
    assertWorkerFlushed(result);
    assert.match(result.doc, new RegExp(`^objective: ${escapeRegExp(JSON.stringify(LEGACY_OBJECTIVE))}$`, 'm'));
    assert.match(result.doc, /^waiting_on: null$/m);
    assert.match(result.doc, new RegExp(`^next_valid_action: ${escapeRegExp(JSON.stringify(LEGACY_NEXT_ACTION))}$`, 'm'));
  });
});

test('an autosave-looking body line cannot authorize contract-field healing', () => {
  withFixture((fixture) => {
    const sessionId = 'body-tag-no-ownership';
    installExistingCapsule(
      fixture,
      sessionId,
      existingCapsule({
        id: 'body-tag-no-ownership',
        tagsLine: '',
        bodyTail: '\ntags: [capsule, autosave]\n',
      }),
    );

    const result = runWorker(fixture, [assistantEvent()], { sessionId });
    assertWorkerFlushed(result);
    assert.match(result.doc, new RegExp(`^objective: ${escapeRegExp(JSON.stringify(LEGACY_OBJECTIVE))}$`, 'm'));
    assert.match(result.doc, /^waiting_on: null$/m);
    assert.match(result.doc, new RegExp(`^next_valid_action: ${escapeRegExp(JSON.stringify(LEGACY_NEXT_ACTION))}$`, 'm'));
  });
});
