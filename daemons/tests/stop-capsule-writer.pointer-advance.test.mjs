// stop-capsule-writer.pointer-advance.test.mjs — clobber-guard regression.
//
// Integration test for the clobber-guard. Runs the REAL stop-capsule-writer.mjs
// worker (`--worker`) against temp-dir fixtures and asserts the pointer OUTCOME —
// no mocking; it exercises the exact shipped code path (pointerLockedByFinalize +
// thisFinalized). Override the daemon under test with SCW_DAEMON=<abs path>.
'use strict';

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = process.env.SCW_DAEMON || path.resolve(__dirname, '..', 'stop-capsule-writer.mjs');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const BODY = `\n## Done (don't redo)\n<!-- swe:done -->\n\n## Historical-Errors → Resolutions\n<!-- swe:errors -->\n\n## Historical-Rejected-Approaches\n<!-- swe:rejected -->\n\n## Files-Read / Files-Modified\n<!-- swe:files -->\n\n## Operating-Facts\n<!-- swe:facts -->\n\n## Pending-Gates\n<!-- swe:gates -->\n\n## Claimed-Rows\n<!-- swe:rows -->\n`;

// A deliberate (hand/close/context-capsule) capsule: has waiting_on, NO autosave tag.
const cap = (name, waitingOn) =>
  `---\nid: ${name}\nstatus: active\nobjective: "x"\nwaiting_on: ${waitingOn}\nresume_trigger: clear\ndefinition_hash: aaa\nnext_valid_action: "x"\n---\n${BODY}`;

// A DISPOSABLE auto-writer capsule (skeleton()): carries the `autosave` tag and NO
// waiting_on line — exactly what the guard must recognize as clobberable.
const autoCap = (name, kind) =>
  `---\ncapsule_id: ${name}\nobjective: "x"\nstatus: active\ntrigger: ${kind}\ntags: [capsule, autosave, ${kind}]\ncreated_at: 2026-07-07T00:00:00Z\n---\n${BODY}`;

// One scenario = a fresh temp seat root. The pointer always lives at
// memory/BODY_STATE.json's state.last_capsule (single-operator convention).
function runScenario({ sid, capsuleBWaitingOn, capsuleAWaitingOn = '"prior finalize — real"', capsuleAAuto = null, skeletonB = false }) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'scw-'));
  const root = path.join(base, 'test-seat');
  const capsules = path.join(root, 'memory', 'capsules');
  const runtime = path.join(root, 'memory', 'runtime', 'stop-writer');
  mkdirSync(capsules, { recursive: true });
  mkdirSync(runtime, { recursive: true });

  // capsule-A: the capsule the pointer currently aims at. Either a deliberate
  // capsule (cap: has waiting_on, no autosave tag) or a disposable auto-writer
  // capsule (autoCap: autosave tag, no waiting_on) when capsuleAAuto is a kind.
  writeFileSync(
    path.join(capsules, 'capsule-A.md'),
    capsuleAAuto ? autoCap('capsule-A', capsuleAAuto) : cap('capsule-A', capsuleAWaitingOn),
  );
  // capsule-B: THIS session's capsule. Pre-written (ADVANCE/HELD), or left ABSENT
  // so the daemon writes its own real auto-skeleton (trigger:stop-delta) when
  // skeletonB — the true clobber source.
  const capsuleB = path.join(capsules, 'capsule-B.md');
  if (!skeletonB) writeFileSync(capsuleB, cap('capsule-B', capsuleBWaitingOn));

  const bodyStatePath = path.join(root, 'memory', 'BODY_STATE.json');
  writeFileSync(bodyStatePath, JSON.stringify({
    state: { last_capsule: { id: 'capsule-A', path: 'memory/capsules/capsule-A.md', status: 'active' } },
  }));
  writeFileSync(path.join(runtime, `${sid}.json`), JSON.stringify({ offset: 0, capsule_path: capsuleB, last_delta_sha: null }));

  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'integration delta ' + sid }] } }) + '\n');

  const payload = JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript });
  const out = execFileSync(process.execPath, [DAEMON, '--worker', payload], { encoding: 'utf8' });

  const pointerAfter = JSON.parse(readFileSync(bodyStatePath, 'utf8')).state.last_capsule;
  rmSync(base, { recursive: true, force: true });
  return { pointerAfter, out };
}

console.log(`── stop-capsule-writer pointer-advance — daemon: ${DAEMON} ──`);

// ADVANCE: this session's capsule is itself finalized → pointer moves to it.
{
  const { pointerAfter, out } = runScenario({ sid: 'adv-11111111', capsuleBWaitingOn: '"my own finalize — real"' });
  ok(out.includes('SWE_OUTCOME:flushed'), 'ADVANCE: worker flushed (reached the pointer logic)');
  ok(pointerAfter.path === 'memory/capsules/capsule-B.md',
    'ADVANCE: a finalized new capsule advances the pointer off the prior finalized one (finalize-advance, not clobber)');
}

// HELD: this session's capsule is a skeleton (waiting_on:null) → pointer stays on A.
{
  const { pointerAfter, out } = runScenario({ sid: 'held-22222222', capsuleBWaitingOn: 'null' });
  ok(out.includes('SWE_OUTCOME:flushed'), 'HELD: worker flushed (reached the pointer logic)');
  ok(pointerAfter.path === 'memory/capsules/capsule-A.md',
    'HELD: an unfinalized skeleton capsule does NOT clobber the finalized pointer (clobber-guard holds)');
}

// DELIB-NULL (null-gap): pointer aims at a DELIBERATE ready capsule-A with
// waiting_on:null (a /context-capsule resume capsule — nothing blocks its
// resume, NO autosave tag); THIS session writes a real auto-skeleton
// (trigger:stop-delta). The deliberate pointer MUST be HELD.
{
  const { pointerAfter, out } = runScenario({ sid: 'delib-33333333', capsuleAWaitingOn: 'null', skeletonB: true });
  ok(out.includes('SWE_OUTCOME:flushed'), 'DELIB-NULL: worker flushed (reached the pointer logic)');
  ok(pointerAfter.path === 'memory/capsules/capsule-A.md',
    'DELIB-NULL: a deliberate ready capsule (waiting_on:null, no autosave tag) is NOT clobbered (null-gap closed)');
}

// PRECOMPACT-ADVANCE (the reviewer's catch): pointer aims at a DISPOSABLE
// safety-net capsule-A (tags:[capsule,autosave,precompact], NO waiting_on); THIS
// session writes only its own auto-skeleton (skeletonB — NOT finalized, so
// thisFinalized can't mask the guard). The disposable safety-net MUST NOT freeze
// the pointer — it advances to capsule-B. A trigger==='stop-delta' allowlist
// FAILS this (protects the wrong writer and reintroduces the stuck-pointer bug);
// the `autosave`-tag discriminator PASSES it. (capsule-B finalized would advance
// under ALL predicates via thisFinalized and would NOT exercise the guard — must
// be a skeleton.)
{
  const { pointerAfter, out } = runScenario({ sid: 'precmp-44444444', capsuleAAuto: 'precompact', capsuleBWaitingOn: 'null' });
  ok(out.includes('SWE_OUTCOME:flushed'), 'PRECOMPACT-ADVANCE: worker flushed (reached the pointer logic)');
  ok(pointerAfter.path === 'memory/capsules/capsule-B.md',
    'PRECOMPACT-ADVANCE: a disposable autosave safety-net (waiting_on:null) does NOT freeze the pointer — this session\'s capsule advances past it (no stuck-pointer regression)');
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
