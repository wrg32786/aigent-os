// stop-capsule-writer.pointer-advance.test.mjs — clobber-guard regression.
//
// Integration test for the clobber-guard. Runs the REAL stop-capsule-writer.mjs
// worker (`--worker`) against temp-dir fixtures and asserts the pointer OUTCOME —
// no mocking; it exercises the exact shipped code path (pointerLockedByFinalize +
// thisFinalized). Override the daemon under test with SCW_DAEMON=<abs path>.
'use strict';

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createCycleRecord, writeCycleRecord, readCycleRecord } from '../refresh-cycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = process.env.SCW_DAEMON || path.resolve(__dirname, '..', 'stop-capsule-writer.mjs');
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
// Mirrors the daemon's own sha12(JSON.stringify({...})) EXACTLY for a transcript
// carrying only an assistant-text delta (no user turn, no tool_use) — the
// simplest shape that still produces a real, deterministic deltaSig, so the
// fresh-roll path it will compute can be predicted before running it.
const deltaSigForAssistantOnly = (text) => sha256hex(JSON.stringify({
  r: null, fr: [], fm: [], e: [], c: [], a: text.slice(0, 200), u: [],
})).slice(0, 12);

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
  const capsuleBBefore = skeletonB ? null : cap('capsule-B', capsuleBWaitingOn);
  if (capsuleBBefore !== null) writeFileSync(capsuleB, capsuleBBefore);

  const bodyStatePath = path.join(root, 'memory', 'BODY_STATE.json');
  writeFileSync(bodyStatePath, JSON.stringify({
    state: { last_capsule: { id: 'capsule-A', path: 'memory/capsules/capsule-A.md', status: 'active' } },
  }));
  const stateFile = path.join(runtime, `${sid}.json`);
  writeFileSync(stateFile, JSON.stringify({ offset: 0, capsule_path: capsuleB, last_delta_sha: null }));

  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'integration delta ' + sid }] } }) + '\n');

  const payload = JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript });
  const out = execFileSync(process.execPath, [DAEMON, '--worker', payload], { encoding: 'utf8' });

  const pointerAfter = JSON.parse(readFileSync(bodyStatePath, 'utf8')).state.last_capsule;
  const stateAfter = JSON.parse(readFileSync(stateFile, 'utf8'));
  const capsuleBAfter = existsSync(capsuleB) ? readFileSync(capsuleB, 'utf8') : null;
  rmSync(base, { recursive: true, force: true });
  return { pointerAfter, out, capsuleBBefore, capsuleBAfter, stateAfter, capsuleB };
}

console.log(`── stop-capsule-writer pointer-advance — daemon: ${DAEMON} ──`);

// ADVANCE: this session's capsule is itself finalized → pointer moves to it.
// This is also the REALISTIC shape of R2-2 (finalize-rolling-capsule-in-place):
// capsule-B is pre-written already finalized AND state.capsule_path already
// points at it (exactly what the recovery play produces) — so this scenario
// must satisfy BOTH the pre-existing pointer-advance contract AND the new
// R2-2 byte-freeze + repoint contract simultaneously.
{
  const { pointerAfter, out, capsuleBBefore, capsuleBAfter, stateAfter, capsuleB } =
    runScenario({ sid: 'adv-11111111', capsuleBWaitingOn: '"my own finalize — real"' });
  ok(out.includes('SWE_OUTCOME:flushed'), 'ADVANCE: worker flushed (reached the pointer logic)');
  ok(pointerAfter.path === 'memory/capsules/capsule-B.md',
    'ADVANCE: a finalized new capsule advances the pointer off the prior finalized one (finalize-advance, not clobber)');
  ok(capsuleBAfter === capsuleBBefore,
    'ADVANCE+R2-2: capsule-B is BYTE-FROZEN even though the pointer advances to it (freeze is orthogonal to advance)');
  ok(stateAfter.capsule_path !== capsuleB,
    'ADVANCE+R2-2: the stop-writer state record repoints capsule_path OFF capsule-B onto a fresh rolling file');
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

// R2-2 (gate round-2, board c1f777e9): FINALIZE-IN-PLACE BYTE-FREEZE. The
// documented recovery play "finalize the rolling capsule in place" turns the
// FILE state.capsule_path already points at into a curated close, WITHOUT ever
// repointing capsule_path itself. The next Stop hook's merge block re-opens
// that same file, appends bullets, and mutates bytes the capsule-verb
// write-once sha256 already committed to (capsule-verb.mjs:587) — a re-hash
// mismatch that aborts every future refresh cycle as capsule_invalid, forever.
// FIX: gate the merge on capsuleLeftSkeleton() — a finalized capsule is
// byte-frozen from here on; this turn's delta rolls a FRESH auto-capsule
// instead, and the stop-writer's own state record repoints to it.
{
  const base = mkdtempSync(path.join(os.tmpdir(), 'scw-r22-'));
  const root = path.join(base, 'test-seat');
  const capsules = path.join(root, 'memory', 'capsules');
  const runtime = path.join(root, 'memory', 'runtime', 'stop-writer');
  mkdirSync(capsules, { recursive: true });
  mkdirSync(runtime, { recursive: true });

  const sid = 'r22-55555555';
  const finalizedPath = path.join(capsules, 'capsule-FINALIZED-IN-PLACE.md');
  const finalizedBefore = cap('capsule-FINALIZED-IN-PLACE', '"recovery-play finalize — real waiting_on"');
  writeFileSync(finalizedPath, finalizedBefore);

  // state.capsule_path STILL points at the now-finalized file — exactly the
  // recovery play's shape: no repoint happened, only the file's own
  // frontmatter was hand-edited to leave skeleton.
  writeFileSync(path.join(runtime, `${sid}.json`),
    JSON.stringify({ offset: 0, capsule_path: finalizedPath, last_delta_sha: null }));
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'capsule-FINALIZED-IN-PLACE', path: 'memory/capsules/capsule-FINALIZED-IN-PLACE.md',
        status: 'active', trigger: 'curated-close',
        finalized_at: new Date(Date.now() - 5 * 60e3).toISOString(), session_id: sid,
      },
    },
  }));

  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'post-finalize turn ' + sid }] } }) + '\n');
  const payload = JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript });
  const out = execFileSync(process.execPath, [DAEMON, '--worker', payload], { encoding: 'utf8' });

  const finalizedAfter = readFileSync(finalizedPath, 'utf8');
  const stateAfter = JSON.parse(readFileSync(path.join(runtime, `${sid}.json`), 'utf8'));
  const freshPath = stateAfter.capsule_path;
  const freshDoc = freshPath && existsSync(freshPath) ? readFileSync(freshPath, 'utf8') : '';

  ok(out.includes('SWE_OUTCOME:flushed'), 'R2-2: worker flushed (reached the merge/pointer logic)');
  ok(finalizedAfter === finalizedBefore,
    'R2-2: the finalized-in-place capsule is BYTE-FROZEN — the post-finalize turn never mutates it');
  ok(freshPath !== finalizedPath,
    'R2-2: the stop-writer state record repoints capsule_path OFF the finalized file');
  ok(freshPath !== null && existsSync(freshPath),
    'R2-2: a fresh rolling capsule file was actually created on disk');
  ok(/\bautosave\b/.test(freshDoc) && /^waiting_on:\s*null\s*$/m.test(freshDoc),
    'R2-2: the fresh capsule is a genuine unfinalized skeleton (autosave tag, waiting_on:null)');
  ok(freshDoc.includes('post-finalize turn ' + sid),
    "R2-2: this turn's delta landed in the FRESH capsule, not dropped");

  rmSync(base, { recursive: true, force: true });
}

// R2-2 GUARDRAIL 1 (Titus ruling, gate round-2 fold-in): an IN-FLIGHT refresh
// cycle pins its OWN capsule_id/capsule_sha256 at prepare-time (refresh-cycle.mjs
// — a file the stop-writer never imports or touches). Repointing
// state.capsule_path (the STOP-WRITER's own bookkeeping for where to merge
// ROLLING bullets) must have ZERO effect on that pinned receipt: the cycle
// record must read back byte-identical, and the frozen file's bytes must still
// hash to the record's pinned capsule_sha256 — proving the receipt resolves its
// own pinned identity and never re-reads the repointed stop-writer record.
{
  const base = mkdtempSync(path.join(os.tmpdir(), 'scw-r22-g1-'));
  const root = path.join(base, 'test-seat');
  const capsules = path.join(root, 'memory', 'capsules');
  const runtime = path.join(root, 'memory', 'runtime', 'stop-writer');
  mkdirSync(capsules, { recursive: true });
  mkdirSync(runtime, { recursive: true });

  const sid = 'r22-g1-66666666';
  const finalizedPath = path.join(capsules, 'capsule-CYCLE-PINNED.md');
  const finalizedBefore = cap('capsule-CYCLE-PINNED', '"in-flight cycle finalize — real waiting_on"');
  writeFileSync(finalizedPath, finalizedBefore);
  const pinnedSha256 = createHash('sha256').update(finalizedBefore).digest('hex');

  // The in-flight cycle receipt: prepared by an EARLIER capsule-verb run against
  // this exact file, pinning its id + sha256. This module (refresh-cycle.mjs) is
  // a completely separate file from anything the stop-writer touches.
  const cycleRecord = createCycleRecord({
    cycle_id: 'cyc-g1', lineage_id: 'lineage-g1', runtime_session: sid,
    state: 'prepared', capsule_id: 'capsule-CYCLE-PINNED', capsule_sha256: pinnedSha256,
  });
  writeCycleRecord(root, sid, cycleRecord);

  writeFileSync(path.join(runtime, `${sid}.json`),
    JSON.stringify({ offset: 0, capsule_path: finalizedPath, last_delta_sha: null }));
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'capsule-CYCLE-PINNED', path: 'memory/capsules/capsule-CYCLE-PINNED.md',
        status: 'active', trigger: 'curated-close',
        finalized_at: new Date(Date.now() - 5 * 60e3).toISOString(), session_id: sid,
      },
    },
  }));

  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'post-finalize turn ' + sid }] } }) + '\n');
  const payload = JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript });
  const out = execFileSync(process.execPath, [DAEMON, '--worker', payload], { encoding: 'utf8' });

  const cycleRecordAfter = readCycleRecord(root, sid);
  const rehash = createHash('sha256').update(readFileSync(finalizedPath, 'utf8')).digest('hex');

  ok(out.includes('SWE_OUTCOME:flushed'), 'GUARDRAIL-1: worker flushed (reached the merge/pointer/repoint logic)');
  ok(JSON.stringify(cycleRecordAfter) === JSON.stringify(cycleRecord),
    'GUARDRAIL-1: the in-flight cycle record is byte-identical after the repoint — the stop-writer never touches refresh-cycle-<sid>.json');
  ok(rehash === pinnedSha256,
    'GUARDRAIL-1: the frozen file still hashes to the cycle record\'s pinned capsule_sha256 — the receipt verifies against ITS OWN pinned path/sha, unaffected by state.capsule_path\'s repoint');

  rmSync(base, { recursive: true, force: true });
}

// R2-2 GUARDRAIL 2 (Titus ruling, gate round-2 fold-in): fail-safe ordering.
// deltaSig content-addresses only THIS turn's delta, not every historical
// reroute this session may have made — a recurring delta shape landing on a
// later, non-consecutive turn CAN reproduce the same fresh-roll path. Plant a
// file there ourselves to force the collision deterministically. The only safe
// response is to SKIP the merge entirely (never overwrite the collision target,
// never fall back to writing into the frozen file).
{
  const base = mkdtempSync(path.join(os.tmpdir(), 'scw-r22-g2-'));
  const root = path.join(base, 'test-seat');
  const capsules = path.join(root, 'memory', 'capsules');
  const runtime = path.join(root, 'memory', 'runtime', 'stop-writer');
  mkdirSync(capsules, { recursive: true });
  mkdirSync(runtime, { recursive: true });

  const sid = 'r22-g2-77777777';
  const finalizedPath = path.join(capsules, 'capsule-COLLISION-SRC.md');
  const finalizedBefore = cap('capsule-COLLISION-SRC', '"finalize — real waiting_on"');
  writeFileSync(finalizedPath, finalizedBefore);

  writeFileSync(path.join(runtime, `${sid}.json`),
    JSON.stringify({ offset: 0, capsule_path: finalizedPath, last_delta_sha: null }));
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: 'capsule-COLLISION-SRC', path: 'memory/capsules/capsule-COLLISION-SRC.md',
        status: 'active', trigger: 'curated-close',
        finalized_at: new Date(Date.now() - 5 * 60e3).toISOString(), session_id: sid,
      },
    },
  }));

  const assistantText = 'post-finalize turn ' + sid;
  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } }) + '\n');

  // Predict and plant the EXACT fresh-roll path this turn would compute, with
  // sentinel content standing in for "whatever an earlier reroute committed".
  const dateStr = new Date().toISOString().slice(0, 10);
  const deltaSig = deltaSigForAssistantOnly(assistantText);
  const collisionPath = path.join(capsules, `${dateStr}-auto-${sid.slice(0, 8)}-${deltaSig}.md`);
  const collisionSentinel = '---\nid: pre-existing-collision-target\nstatus: active\nwaiting_on: null\ntags: [capsule, autosave]\n---\nSENTINEL: must never be overwritten\n';
  writeFileSync(collisionPath, collisionSentinel);

  const payload = JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript });
  const out = execFileSync(process.execPath, [DAEMON, '--worker', payload], { encoding: 'utf8' });

  const finalizedAfter = readFileSync(finalizedPath, 'utf8');
  const collisionAfter = readFileSync(collisionPath, 'utf8');
  const stateAfter = JSON.parse(readFileSync(path.join(runtime, `${sid}.json`), 'utf8'));

  ok(!out.includes('SWE_OUTCOME:flushed'), 'GUARDRAIL-2: worker does NOT report flushed on a fresh-roll collision (merge skipped, not silently succeeded)');
  ok(finalizedAfter === finalizedBefore,
    'GUARDRAIL-2: the frozen file is untouched on collision (no fallback to merging into it)');
  ok(collisionAfter === collisionSentinel,
    'GUARDRAIL-2: the pre-existing file at the collision path is NOT silently overwritten');
  ok(stateAfter.capsule_path === finalizedPath,
    'GUARDRAIL-2: state.capsule_path is NOT repointed on a skipped turn — no false advance, next turn retries fresh');

  rmSync(base, { recursive: true, force: true });
}

// COMPLETION STAMP (Titus ruling, gate round-2 fold-in): the R2-2 freeze branch
// additionally stamps close_kind:'completion' (no cycle_id) exactly when it
// advances the pointer to this session's own newly-finalized capsule — a
// voluntary completion close, distinct from a machinery checkpoint (which
// capsule-verb.mjs's writerArgs already stamps unconditionally). ONE stamp per
// freeze episode: Stop 1 finalizes + stamps; Stop 2 and Stop 3 (same session)
// merge into the fresh companion skeleton and must NOT re-stamp — the pointer
// stays byte-identical to what Stop 1 produced, because pointerLockedByFinalize
// holds it on the already-finalized capsule (same guard the ADVANCE/HELD tests
// above already prove; this test asserts close_kind specifically survives it).
{
  const base = mkdtempSync(path.join(os.tmpdir(), 'scw-comp-'));
  const root = path.join(base, 'test-seat');
  const capsules = path.join(root, 'memory', 'capsules');
  const runtime = path.join(root, 'memory', 'runtime', 'stop-writer');
  mkdirSync(capsules, { recursive: true });
  mkdirSync(runtime, { recursive: true });

  const sid = 'comp-88888888';
  const finalizedPath = path.join(capsules, 'capsule-COMPLETION.md');
  writeFileSync(finalizedPath, cap('capsule-COMPLETION', '"finalized for completion stamp — real waiting_on"'));
  writeFileSync(path.join(runtime, `${sid}.json`),
    JSON.stringify({ offset: 0, capsule_path: finalizedPath, last_delta_sha: null }));
  const bodyStatePath = path.join(root, 'memory', 'BODY_STATE.json');
  writeFileSync(bodyStatePath, JSON.stringify({ state: {} }));
  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript, '');

  function runTurn(turnText) {
    appendFileSync(transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: turnText }] } }) + '\n');
    const payload = JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript });
    return execFileSync(process.execPath, [DAEMON, '--worker', payload], { encoding: 'utf8' });
  }
  const readPointer = () => JSON.parse(readFileSync(bodyStatePath, 'utf8')).state.last_capsule;

  // Stop 1: the finalize turn. capsule-COMPLETION already carries real
  // waiting_on — finalize-in-place already happened before this Stop hook fires.
  const out1 = runTurn('completion stop 1 ' + sid);
  const pointerAfter1 = readPointer();

  ok(out1.includes('SWE_OUTCOME:flushed'), 'COMPLETION: Stop 1 flushed');
  ok(pointerAfter1.path === 'memory/capsules/capsule-COMPLETION.md',
    "COMPLETION: Stop 1 advances the pointer to this session's newly-finalized capsule");
  ok(pointerAfter1.close_kind === 'completion',
    'COMPLETION: Stop 1 stamps close_kind:completion on the finalize-advance');
  ok(pointerAfter1.cycle_id === undefined,
    'COMPLETION: the completion stamp carries no cycle_id (voluntary close, not a cycle receipt)');

  // Stop 2, Stop 3: same session, capsule-COMPLETION stays frozen (nothing
  // re-touches it). Each turn's delta lands in a FRESH companion skeleton
  // (R2-2) — the pointer must never be rewritten again.
  const out2 = runTurn('completion stop 2 ' + sid);
  const pointerAfter2 = readPointer();
  const out3 = runTurn('completion stop 3 ' + sid);
  const pointerAfter3 = readPointer();

  ok(out2.includes('SWE_OUTCOME:flushed'), 'COMPLETION: Stop 2 flushed (merges into the fresh companion, not re-finalizing)');
  ok(JSON.stringify(pointerAfter2) === JSON.stringify(pointerAfter1),
    "COMPLETION: Stop 2 does NOT re-stamp the pointer — byte-identical to Stop 1's completion stamp");
  ok(out3.includes('SWE_OUTCOME:flushed'), 'COMPLETION: Stop 3 flushed');
  ok(JSON.stringify(pointerAfter3) === JSON.stringify(pointerAfter1),
    'COMPLETION: Stop 3 STILL does not re-stamp — one completion stamp for the whole freeze episode');

  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
