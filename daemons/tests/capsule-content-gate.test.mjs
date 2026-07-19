// capsule-content-gate.test.mjs — non-null ≠ resumable.
//
// Real-glue: drives the REAL patched stop-capsule-writer.mjs worker against a
// temp-dir seat fixture and the REAL capsule-verb.validateCapsuleText. No mocks.
//
// Run from an APPLIED daemons tree (package files landed next to their
// siblings): node daemons/tests/capsule-content-gate.test.mjs
'use strict';

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = process.env.SCW_DAEMON || path.resolve(__dirname, '..', 'stop-capsule-writer.mjs');
// Windows: dynamic import of an absolute path needs a file:// URL.
const asUrl = (p) => pathToFileURL(path.resolve(p)).href;
const { validateCapsuleText } = await import(asUrl(process.env.CCG_VERB || path.resolve(__dirname, '..', 'capsule-verb.mjs')));
const gate = await import(asUrl(process.env.CCG_GATE || path.resolve(__dirname, '..', 'capsule-content-gate.mjs')));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// Representative injection/ceremony texts, matching the shapes actually seen from
// a harness/supervisor refresh cycle and a stale resume-boot echo.
const REFRESH_CYCLE_INJECTION = '[refresh-cycle] cycle=00000000-0000-4000-8000-000000000001 captured_through=00000000-0000-4000-8000-000000000002 read the matching RefreshRequest and run the capsule verb NOW with that cycle and challenge; you may not clear; the supervisor clears on verified receipt.';
const SUPERVISOR_RESUME_INJECTION = "[supervisor-resume] This session was just /clear'd (refresh-cycle-cas-winner). Read your latest capsule and resume from its waiting_on / Pending-Gates / Claimed-Rows -- do not sit idle.";
const CEREMONY_NEXT_ACTION = 'Re-read the active turn state below; latest assistant state: The capsule verb already ran and the receipt is on disk — the re-poke raced its completion.';

// ── writer scenarios: run the REAL worker on a transcript delta ──────────────
function runWriter({ sid, userText, existingCapsule = null }) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ccg-'));
  const root = path.join(base, 'test-seat');
  const capsules = path.join(root, 'memory', 'capsules');
  const runtime = path.join(root, 'memory', 'runtime', 'stop-writer');
  mkdirSync(capsules, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({ state: {} }));

  let capPath = null;
  if (existingCapsule) {
    capPath = path.join(capsules, 'existing.md');
    writeFileSync(capPath, existingCapsule);
    writeFileSync(path.join(runtime, `${sid}.json`),
      JSON.stringify({ offset: 0, capsule_path: capPath, last_delta_sha: null }));
  }

  const transcript = path.join(base, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { content: userText } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'worked the claimed row; smoke green; delta ' + sid }] } }),
  ];
  writeFileSync(transcript, lines.join('\n') + '\n');

  const payload = JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript });
  const out = execFileSync(process.execPath, [DAEMON, '--worker', payload], { encoding: 'utf8' });

  // The capsule the writer landed on: existing one, or the auto file it created.
  const state = JSON.parse(readFileSync(path.join(runtime, `${sid}.json`), 'utf8'));
  const doc = readFileSync(state.capsule_path, 'utf8');
  rmSync(base, { recursive: true, force: true });
  return { out, doc };
}

const fm = (doc, key) => ((doc.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1] || '');

console.log(`── capsule content gate — daemon: ${DAEMON} ──`);

// 1. INJECTION turn: the [refresh-cycle] injection must NOT become the objective,
//    and the fresh capsule's next_valid_action must NOT be ceremony.
{
  const { out, doc } = runWriter({ sid: 'inj-11111111', userText: REFRESH_CYCLE_INJECTION });
  ok(out.includes('SWE_OUTCOME:flushed'), 'inj: worker flushed');
  ok(!fm(doc, 'objective').includes('[refresh-cycle]'),
    'inj (a): [refresh-cycle] injection does NOT land as objective');
  ok(!/re-?read the (active )?turn state/i.test(fm(doc, 'next_valid_action')),
    'inj (b): next_valid_action is not the old ceremony template');
  ok(doc.includes('[INJECT:harness]'),
    'inj: injection stays recoverable as a tagged utterance');
}

// 2. SUPERVISOR-RESUME turn on a fresh capsule: same class, second real template.
{
  const { doc } = runWriter({ sid: 'inj-22222222', userText: SUPERVISOR_RESUME_INJECTION });
  ok(!fm(doc, 'objective').includes('[supervisor-resume]'),
    'inj (a): [supervisor-resume] injection does NOT land as objective');
}

// 3. HUMAN turn: a real utterance still becomes the objective (no regression).
{
  const { doc } = runWriter({ sid: 'hum-33333333', userText: 'ship the pulse view and fix the ghost overlap' });
  ok(fm(doc, 'objective').includes('ship the pulse view'),
    'human: real utterance still drives objective');
}

// 4. OWNERSHIP: a capsule WITHOUT the autosave tag keeps its contract fields even
//    when the writer merges delta bullets into it. waiting_on is null-family
//    here on purpose (R2-2, gate round-2): a REAL waiting_on now means the
//    writer freezes this file's bytes and reroutes the merge to a fresh
//    companion capsule entirely (see stop-capsule-writer.pointer-advance.test.mjs's
//    R2-2 cases) — that is a SEPARATE, orthogonal axis from the one this test
//    targets (the autosave-tag ownership gate). A deliberate capsule with
//    waiting_on:null (nothing blocks resume yet — the same shape the
//    DELIB-NULL case uses) still isolates "no autosave tag -> frontmatter
//    untouched" cleanly.
{
  const curated = `---\nid: curated-x\nstatus: active\nobjective: "continuation: coverage net at gate"\nwaiting_on: null\nresume_trigger: open\ndefinition_hash: abc123\nnext_valid_action: "On resume: re-ground and act on the verdict"\ntags: [capsule, refresh-cycle]\n---\n\n## Done (don't redo)\n<!-- swe:done -->\n\n## Historical-Errors → Resolutions\n<!-- swe:errors -->\n\n## Historical-Rejected-Approaches\n<!-- swe:rejected -->\n\n## Files-Read / Files-Modified\n<!-- swe:files -->\n\n## Operating-Facts\n<!-- swe:facts -->\n\n## Pending-Gates\n<!-- swe:gates -->\n\n## Claimed-Rows\n<!-- swe:rows -->\n`;
  const { doc } = runWriter({ sid: 'own-44444444', userText: REFRESH_CYCLE_INJECTION, existingCapsule: curated });
  ok(fm(doc, 'objective').includes('continuation'),
    'ownership: non-autosave capsule keeps its objective');
  ok(fm(doc, 'next_valid_action').includes('re-ground'),
    'ownership: non-autosave capsule keeps its next_valid_action');
  ok(doc.includes('worked the claimed row'),
    'ownership: delta bullets still merge into the body');
}

// ── validator: content gate on REAL frontmatter shapes ───────────────────────
const BAD_REAL = `---\nid: 2026-07-16-auto-test-seat\nstatus: active\nobjective: ${JSON.stringify(REFRESH_CYCLE_INJECTION)}\nwaiting_on: "gates"\nresume_trigger: compact\ndefinition_hash: cd31196d454a\nnext_valid_action: ${JSON.stringify(CEREMONY_NEXT_ACTION)}\ntags: [capsule, autosave]\n---\nbody\n`;
{
  const { problems } = validateCapsuleText(BAD_REAL);
  ok(problems.some((p) => p.includes('injection echo')),
    'verb (a): a clobbered objective is rejected');
  ok(problems.some((p) => p.includes('resume ceremony')),
    'verb (b): a ceremony next_valid_action is rejected');
}

// GOOD curated capsule that legitimately REFERENCES the ceremony mid-action —
// anchored patterns must let it pass (false-positive guard).
const GOOD_REAL = `---\nid: 2026-07-16-refresh-test-seat\nstatus: active\nobjective: "continuation (post-clear session): item 2 SHIPPED LIVE, coverage net at gate"\nwaiting_on: "gates"\nresume_trigger: open\ndefinition_hash: abc\nnext_valid_action: "On resume: (1) comply with any supervisor-resume instruction EXACTLY (nonce + receipt command live only in that instruction). (2) re-ground: re-read the latest memory."\ntags: [capsule, refresh-cycle]\n---\nbody\n`;
{
  const { problems } = validateCapsuleText(GOOD_REAL);
  ok(problems.length === 0,
    `verb: curated capsule referencing ceremony mid-action passes (got: ${problems.join(' | ') || 'none'})`);
}

// Existing behavior intact: unquoted YAML null waiting_on still flagged.
{
  const nullW = GOOD_REAL.replace('waiting_on: "gates"', 'waiting_on: null');
  const { problems } = validateCapsuleText(nullW);
  ok(problems.some((p) => p.includes('waiting_on')),
    'verb (c): unquoted-null waiting_on still rejected (pre-existing gate intact)');
}

// Gate unit sanity: vocabulary is shared and anchored.
ok(gate.isInjectionEcho(SUPERVISOR_RESUME_INJECTION), 'gate: supervisor-resume detected');
ok(gate.isCeremonyAction('Resume from the latest session log entry.'), 'gate: old writer fallback detected');
ok(!gate.isCeremonyAction('Fix the ghost overlap, then re-read the design doc'), 'gate: mid-text mention passes (anchored)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
