// sessionstart-capsule-block.mjs — the "NEWEST ACTIVE CAPSULE" render for
// sessionstart-reinject.mjs's warm-orientation SessionStart leg.
//
// Split out of sessionstart-reinject.mjs (a bare top-level script with no
// main-module guard, invoked by spawning it as a subprocess) into its own
// side-effect-free module so this one read can be exercised directly by a
// test with an injected fsImpl — importing sessionstart-reinject.mjs itself
// would run its whole top-level body, including a synchronous stdin read
// that blocks forever outside its real hook invocation.
import path from 'node:path';
import {
  capsuleValue,
  inert,
  readContainedCapsuleDocument,
  selectCapsule,
} from './lifecycle-common.mjs';
import { FRAMING_LINES } from './memory-hygiene/resume-framing.mjs';

// fsImpl is exposed only so a test can inject a delegating proxy and model a
// path swapped between selection and this read; real execution always omits
// it and gets the live filesystem (selectCapsule/readContainedCapsuleDocument
// both default to node:fs).
export function newestCapsuleBlock(root, MEM, { fsImpl, logErr } = {}) {
  const filesystem = fsImpl ? { fsImpl } : undefined;
  const capsulesRoot = path.join(MEM, 'capsules');
  const { capsule: newest } = selectCapsule(MEM, filesystem);
  if (!newest) {
    return ['', `No valid active capsule. Run /open to orient.`];
  }
  try {
    // Selection above already validated newest.path, but that verdict is not
    // reused here — readContainedCapsuleDocument re-checks containment
    // immediately adjacent to this touch, so a path swapped in the gap
    // (symlink/junction/out-of-root) is refused instead of read.
    const doc = readContainedCapsuleDocument(
      capsulesRoot,
      newest.path,
      'warm-orientation-reread',
      filesystem,
    );
    const rel = path.relative(root, newest.path).replace(/\\/g, '/');
    const obj = capsuleValue(doc, 'objective');
    const next = capsuleValue(doc, 'next_valid_action');
    const waiting = capsuleValue(doc, 'waiting_on');
    const out = [];
    out.push('');
    out.push(`🔁 NEWEST ACTIVE CAPSULE (created_at) — pull sections on demand, never assume: ${inert(rel)}`);
    out.push(`> [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.`);
    // Per-field budget: this is a POINTER, not the capsule body — bound each
    // field so a verbose capsule can't bloat every session-start payload; the
    // full text stays on disk.
    if (obj) out.push(`   objective: ${inert(obj, 240)}`);
    if (next) out.push(`   next_valid_action: ${inert(next, 400)}`);
    if (waiting && waiting !== 'null') out.push(`   waiting_on: ${inert(waiting, 200)}`);
    out.push(`   sections: Done (don't redo) · Historical-Errors → Resolutions · Historical-Rejected-Approaches · Files-Read / Files-Modified · Operating-Facts · Pending-Gates · Claimed-Rows`);
    out.push(`   Pending-Gates + Claimed-Rows are LIVE classes — re-verify each against memory before resuming them.`);
    // Named rulings, not a mood. "Reference only" tells a reader what the
    // document is; these tell it what to DO when the document and the live
    // state disagree, which is the moment the framing actually gets tested.
    for (const line of FRAMING_LINES) out.push(`   ${line}`);
    return out;
  } catch (e) {
    if (typeof logErr === 'function') logErr(root, `newest capsule unreadable: ${e?.message || e}`);
    return ['', `⚠ Newest capsule became unreadable (logged). Orient from the latest session log; run /open for full orientation.`];
  }
}
