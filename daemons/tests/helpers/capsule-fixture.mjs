import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatSideEffectRow } from '../../lifecycle-common.mjs';

const daemons = fileURLToPath(new URL('../../', import.meta.url));
export const user = (text) => ({ type: 'user', message: { content: text } });
export const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
export const call = (id = 'op-test', name = 'mcp__example__send_message', input = { to: 'ops-channel' }, extra = {}) => ({
  type: 'assistant', timestamp: '2026-10-01T12:00:00.000Z', ...extra,
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
export const result = (id = 'op-test', content = '{"id":"msg_01TEST","ok":true}', is_error = false) => ({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
});
export const effectRows = (doc) => (doc.split('<!-- swe:effects -->')[1] || '').split('\n## ')[0]
  .split('\n').filter((row) => row.startsWith('- op '));
export function row(values = {}) {
  const v = { op: 'x', kind: 'mail', target: 'a', requested: 't', outcome: 'unknown', id: 'none', check: 'c', ...values };
  return formatSideEffectRow(v);
}
// Independent decoding of rendered fields: splitting on pipes would hide B1.
export function fields(line) {
  const strings = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)];
  assert.equal(strings.length, 6, line);
  const [op, kind, target, requested, id, check] = strings.map((m) => JSON.parse(m[0]));
  const between = line.slice(strings[3].index + strings[3][0].length, strings[4].index);
  const outcome = /^ \| outcome: (requested|unknown|confirmed|failed) \| id $/.exec(between)?.[1];
  assert.ok(outcome, line);
  return { op, kind, target, requested, outcome, id, check };
}
export function fixture(t, { writer = path.join(daemons, 'stop-capsule-writer.mjs') } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'capsule-effects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), '{"state":{}}');
  const transcriptDir = path.join(root, 'test-home', '.claude', 'projects');
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, 'session.jsonl');
  const env = { ...process.env, AIGENT_ROOT: root, AIGENT_STATE_HOME_DIR: root,
    CLAUDE_PROJECT_DIR: root, AIGENT_SEAT_ID: '', LIFECYCLE_KILL_STOP_WRITER: '0' };
  let capsulePath;
  let lastOutput;
  const statePath = path.join(root, 'memory', 'runtime', 'stop-writer', 'synthetic-session.json');
  const run = (args, input) => {
    const r = spawnSync(process.execPath, args, { env, input, encoding: 'utf8', windowsHide: true,
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    return r.stdout;
  };
  return {
    output() { return lastOutput; },
    state() { return JSON.parse(readFileSync(statePath, 'utf8')); },
    setSignature(signature) {
      writeFileSync(statePath, JSON.stringify({ ...this.state(), last_delta_sha: signature }));
    },
    errorLog() {
      try { return readFileSync(path.join(root, 'memory', '.daemon-errors.log'), 'utf8'); } catch { return ''; }
    },
    sessionstart() {
      return run([path.join(daemons, 'sessionstart-reinject.mjs')], JSON.stringify({ source: 'startup', session_id: 'synthetic-session', cwd: root }));
    },
    write(events) {
      appendFileSync(transcript, events.map((ev) => JSON.stringify(ev)).join('\n') + '\n');
      const output = run([writer, '--worker',
        JSON.stringify({ __root: root, session_id: 'synthetic-session', transcript_path: transcript })]);
      assert.match(output, /SWE_OUTCOME:(flushed|noop:no-delta)/);
      lastOutput = output;
      capsulePath = JSON.parse(readFileSync(path.join(root, 'memory', 'runtime', 'stop-writer', 'synthetic-session.json'))).capsule_path;
      return readFileSync(capsulePath, 'utf8');
    },
    resume() {
      return run(['--input-type=module', '-e',
        `import { runResumeVerb } from ${JSON.stringify(new URL('../../resume-verb.mjs', import.meta.url).href)};
         console.log(runResumeVerb({projectRoot:process.env.AIGENT_ROOT, source:'clear', sessionId:'fresh-session'}).prompt);`]);
    },
    precompact() { return run([path.join(daemons, 'precompact-flush.mjs')], JSON.stringify({ session_id: 'synthetic-session', cwd: root })); },
    edit(transform) { writeFileSync(capsulePath, transform(readFileSync(capsulePath, 'utf8'))); },
    effects(rows) {
      this.edit((doc) => {
        const section = `## In-Flight Side Effects\n<!-- swe:effects -->\n${rows.join('\n')}\n\n`;
        return doc.includes('## In-Flight Side Effects')
          ? doc.replace(/## In-Flight Side Effects[^]*?(?=## Pending-Gates)/, section)
          : doc.replace('## Pending-Gates', section + '## Pending-Gates');
      });
    },
  };
}
