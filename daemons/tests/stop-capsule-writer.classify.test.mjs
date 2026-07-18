// stop-capsule-writer.classify.test.mjs — speaker-tag classifier regression guard.
//
// Extracted from a broader private regression suite that also covered a journal
// WAL, a session-end flush, and a PreCompact block-matrix — none of which are
// part of this two-verb-lifecycle port (they belonged to a separate zero-leak
// subsystem). This file keeps ONLY the piece that IS in scope: the
// stop-capsule-writer.mjs speaker-tag classifier (classify()) — OPERATOR / RELAY /
// PEER / INJECT tagging, including the anchor regression where a human message
// merely quoting teammate_id="x" must stay tagged OPERATOR, not PEER.
//
// Black-box by design — spawns the REAL daemon against a self-contained OS-temp
// seat, so it tests shipped behavior and cannot drift from it.
// Run: node daemons/tests/stop-capsule-writer.classify.test.mjs (exit 0 = PASS)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DAEMONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), `classify-test-${process.pid}`);
const SANDBOX = path.join(TMP, 'test-seat');
const MEM = path.join(SANDBOX, 'memory');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; };
const run = (file, args, opts = {}) => spawnSync(process.execPath, [path.join(DAEMONS, file), ...args], {
  encoding: 'utf8', timeout: 8000, windowsHide: true,
  ...opts,
  env: { ...process.env, LIFECYCLE_KILL_STOP_WRITER: '', AIGENT_ROOT: SANDBOX, ...(opts.env || {}) },
});

rmSync(TMP, { recursive: true, force: true });
mkdirSync(path.join(MEM, 'capsules'), { recursive: true });
mkdirSync(path.join(MEM, 'runtime', 'stop-writer'), { recursive: true });
writeFileSync(path.join(MEM, 'BODY_STATE.json'), JSON.stringify({ state: {} }));

// ── syntax ────────────────────────────────────────────────────────────────────
for (const f of ['lifecycle-common.mjs', 'stop-capsule-writer.mjs', 'capsule-content-gate.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(DAEMONS, f)], { encoding: 'utf8' });
  check(`syntax ${f}`, r.status === 0, r.stderr?.trim().split('\n')[0] ?? '');
}

// ── speaker-tag: [OPERATOR] + [RELAY:agent] bullets, dedup ──────────────────
const readPointer = () => JSON.parse(readFileSync(path.join(MEM, 'BODY_STATE.json'), 'utf8')).state.last_capsule;

const transcript = path.join(SANDBOX, 'zl2.jsonl');
writeFileSync(transcript, [
  JSON.stringify({ type: 'user', message: { content: 'Do the thing tomorrow at nine' } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[room from agent-a] relay: stand back up' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Standing up now.' }] } }),
].join('\n') + '\n');
{
  const r = run('stop-capsule-writer.mjs', ['--worker', JSON.stringify({ __root: SANDBOX, session_id: 'zl2', transcript_path: transcript })]);
  check('speaker-tag: worker flushed', (r.stdout || '').includes('SWE_OUTCOME:flushed'), JSON.stringify(r.stdout));
  const ptr = readPointer();
  const cap = readFileSync(path.join(SANDBOX, ptr.path), 'utf8');
  check('speaker-tag: [OPERATOR] bullet in Done', /- \d{2}:\d{2} \[OPERATOR\] Do the thing tomorrow at nine/.test(cap));
  check('speaker-tag: [RELAY:agent-a] bullet, prefix normalized on bullet lines', /- \d{2}:\d{2} \[RELAY:agent-a\] relay: stand back up/.test(cap) && !/^- .*\[room from/m.test(cap));
  const r2 = run('stop-capsule-writer.mjs', ['--worker', JSON.stringify({ __root: SANDBOX, session_id: 'zl2', transcript_path: transcript })]);
  check('speaker-tag: rerun dedups (no-delta)', (r2.stdout || '').includes('SWE_OUTCOME:noop:no-delta'));
  const capAfter = readFileSync(path.join(SANDBOX, ptr.path), 'utf8');
  check('speaker-tag: no duplicate bullets after rerun', (capAfter.match(/\[OPERATOR\] Do the thing/g) || []).length === 1);
}

// ── real relay/peer/injection formats must not mis-tag as [OPERATOR] ────────
{
  const tF1 = path.join(SANDBOX, 'zlf1.jsonl');
  writeFileSync(tF1, [
    JSON.stringify({ type: 'user', message: { content: 'Genuine operator directive: ship it' } }),
    JSON.stringify({ type: 'user', message: { content: '[room from agent-a @ Thu 7/2 23:14 PT] STAND BACK UP — build now' } }),
    JSON.stringify({ type: 'user', message: { content: '[inbox: 2 unread · latest agent-a: "USAGE DOCTRINE" · pull: room_drain]' } }),
    JSON.stringify({ type: 'user', message: { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="zl-reviewer" color="yellow">\nfindings\n</teammate-message>' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ack' }] } }),
  ].join('\n') + '\n');
  run('stop-capsule-writer.mjs', ['--worker', JSON.stringify({ __root: SANDBOX, session_id: 'zlf1', transcript_path: tF1 })]);
  const cap = readFileSync(path.join(SANDBOX, readPointer().path), 'utf8');
  check('genuine human utterance tagged [OPERATOR]', /\[OPERATOR\] Genuine operator directive: ship it/.test(cap));
  check('"[room from agent-a @ ts]" relay tagged [RELAY:agent-a] NOT [OPERATOR]', /\[RELAY:agent-a\] STAND BACK UP/.test(cap) && !/\[OPERATOR\][^\n]*STAND BACK UP/.test(cap));
  check('"[inbox: ...]" marker tagged [RELAY:inbox] NOT [OPERATOR]', /\[RELAY:inbox\]/.test(cap) && !/\[OPERATOR\][^\n]*inbox/.test(cap));
  check('teammate-message peer tagged [PEER:zl-reviewer] NOT [OPERATOR]', /\[PEER:zl-reviewer\]/.test(cap) && !/\[OPERATOR\][^\n]*teammate_id/.test(cap));
  check('objective is the human utterance, not a peer envelope', /^objective: "Genuine operator directive/m.test(cap), JSON.stringify(cap.match(/^objective: .*/m)?.[0]?.slice(0, 60)));
}

// ── a human message quoting teammate_id="x" stays [OPERATOR] (anchored) ─────
{
  const tHuman = path.join(SANDBOX, 'zlhuman.jsonl');
  writeFileSync(tHuman, [
    JSON.stringify({ type: 'user', message: { content: 'Anchor the classifier: a human quoting teammate_id="zztop" must stay OPERATOR' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  run('stop-capsule-writer.mjs', ['--worker', JSON.stringify({ __root: SANDBOX, session_id: 'zlhuman', transcript_path: tHuman })]);
  const cap = readFileSync(path.join(SANDBOX, readPointer().path), 'utf8');
  check('human quoting teammate_id stays [OPERATOR] (not PEER)', /\[OPERATOR\][^\n]*teammate_id="zztop"/.test(cap) && !/\[PEER:zztop\]/.test(cap), JSON.stringify(cap.match(/- \d{2}:\d{2} \[(OPERATOR|PEER:[^\]]+)\][^\n]*zztop[^\n]*/)?.[0]?.slice(0, 70)));
  check('that human msg still sets the objective', /^objective: "Anchor the classifier/m.test(cap));
}

// ── injection tagged, never [OPERATOR] ───────────────────────────────────────
{
  const tInj = path.join(SANDBOX, 'zlinj.jsonl');
  writeFileSync(tInj, [
    JSON.stringify({ type: 'user', message: { content: '[refresh-cycle] cycle=abc read the matching RefreshRequest and run the capsule verb NOW' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  run('stop-capsule-writer.mjs', ['--worker', JSON.stringify({ __root: SANDBOX, session_id: 'zlinj', transcript_path: tInj })]);
  const cap = readFileSync(path.join(SANDBOX, readPointer().path), 'utf8');
  check('harness injection tagged [INJECT:harness] NOT [OPERATOR]', /\[INJECT:harness\]/.test(cap) && !/\[OPERATOR\][^\n]*refresh-cycle/.test(cap));
  check('injection does not become the objective', !/^objective: "\[refresh-cycle\]/m.test(cap));
}

// ── embedded newlines collapsed (no section corruption) ─────────────────────
{
  const t5 = path.join(SANDBOX, 'zl6.jsonl');
  writeFileSync(t5, [
    JSON.stringify({ type: 'user', message: { content: 'line one\n## Fake Section\nline two' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  const r5 = run('stop-capsule-writer.mjs', ['--worker', JSON.stringify({ __root: SANDBOX, session_id: 'zl6', transcript_path: t5 })]);
  const cap5 = readFileSync(path.join(SANDBOX, readPointer().path), 'utf8');
  check('embedded newlines collapsed in [OPERATOR] bullet (no section corruption)', (r5.stdout || '').includes('flushed') && /\[OPERATOR\] line one ## Fake Section line two/.test(cap5) && !cap5.includes('\n## Fake Section'));
}

rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `STOP-CAPSULE-WRITER.CLASSIFY.TEST: FAIL (${failed})` : 'STOP-CAPSULE-WRITER.CLASSIFY.TEST: PASS');
process.exit(failed ? 1 : 0);
