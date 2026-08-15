// capsule-sentinel-selection.test.mjs — an honest "I captured nothing" is not resumable.
//
// Real-glue: drives the REAL selectCapsule() from lifecycle-common.mjs against
// real capsule files in a temp-dir seat fixture. No mocks, no reimplementation
// of the matcher — a test that mirrors the code it checks cannot fail when the
// code is wrong (Law XV; the identity-guard specimen).
//
// WHY THIS EXISTS (measured 2026-08-01, four live seat vaults, the REAL selector
// the seats load):
//   davinci -> auto-davinci-73a1c54e   objective "Unknown: no human objective..."
//   titus   -> auto-titus-c9cc7d65     objective "C:\dev\cockpit\pasted\...png"
//   metis   -> auto-metis-03dc0248     objective "Login successful. ...</local-command-stdout>"
//   pheme   -> curated (protected only by a hand-authored containment capsule)
// THREE OF FOUR SEATS would have resumed into a capsule with no actionable
// content. All three share ONE field:
//   next_valid_action: "No concrete next action was captured in this Stop delta."
// That field is the discriminator this test defends. The objective junk varies and
// is deliberately NOT the predicate (see RESIDUE at the bottom).
//
// Run: node daemons/tests/capsule-sentinel-selection.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { selectCapsule, newestValidCapsule } from '../lifecycle-common.mjs';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

function seat(capsules) {
  const root = mkdtempSync(path.join(tmpdir(), 'capsel-'));
  mkdirSync(path.join(root, 'capsules'), { recursive: true });
  for (const [name, fm] of Object.entries(capsules)) {
    const body = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
    writeFileSync(path.join(root, 'capsules', `${name}.md`), `---\n${body}\n---\n\n# ${name}\n`);
  }
  return root;
}

// The writer's own placeholder families, TRANSCRIBED from source, not recalled:
//   live stop-capsule-writer.mjs:341-342 · candidate :404, :530
const SENTINEL_ACTION = 'No concrete next action was captured in this Stop delta.';
const SENTINEL_OBJECTIVE = 'Unknown: no human objective was captured in this Stop delta.';
const CANDIDATE_OBJECTIVE = 'In-flight work (auto-captured; see latest session log)';

const CURATED = {
  id: 'curated-real', status: 'active', created_at: '2026-08-01T10:00:00.000Z',
  objective: 'Take F001 from two unwritten deliverables to design ship-complete.',
  next_valid_action: 'Run M-LIVE-1..8 before cycle 1 counts.',
};

console.log('capsule-sentinel-selection');

test('a NEWER sentinel autosave does not beat an older curated capsule', () => {
  const root = seat({
    curated: CURATED,
    'auto-seat-abcd1234': {
      id: 'auto-seat-abcd1234', status: 'active',
      created_at: '2026-08-01T22:20:34.089Z',        // newer than curated
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const { capsule } = selectCapsule(root);
  assert.ok(capsule, 'expected a selection');
  assert.equal(capsule.id, 'curated-real',
    `sentinel autosave won the resume (picked ${capsule.id})`);
  rmSync(root, { recursive: true, force: true });
});

test('the rejection NAMES the sentinel rather than dropping it silently', () => {
  const root = seat({
    curated: CURATED,
    'auto-seat-abcd1234': {
      id: 'auto-seat-abcd1234', status: 'active', created_at: '2026-08-01T22:20:34.089Z',
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const { rejected } = selectCapsule(root);
  const hit = rejected.find((r) => r.name.startsWith('auto-seat-abcd1234'));
  assert.ok(hit, 'sentinel capsule was not recorded in rejected[] at all');
  // A reason of its OWN, never reused from the empty-field case: two different
  // defects that print the same string are indistinguishable in the ledger.
  assert.equal(hit.reason, 'placeholder-demoted', `wrong reason: ${JSON.stringify(hit)}`);
  assert.ok(String(hit.detail || '').length > 0, 'demotion recorded without saying why');
  rmSync(root, { recursive: true, force: true });
});

test("the CANDIDATE tree's different placeholder is caught too", () => {
  const root = seat({
    curated: CURATED,
    'auto-ada-9999': {
      id: 'auto-ada-9999', status: 'active', created_at: '2026-08-01T23:00:00.000Z',
      objective: CANDIDATE_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const { capsule } = selectCapsule(root);
  assert.equal(capsule?.id, 'curated-real',
    'the In-flight-work placeholder family is not covered');
  rmSync(root, { recursive: true, force: true });
});

// ⚑ THIS ASSERTION WAS WRONG WHEN I FIRST WROTE IT, AND THE FIX IT DESCRIBED WOULD
// HAVE DELETED A SHIPPED SAFETY FEATURE. My first version asserted a sentinel-only
// seat selects NOTHING. Running it turned resume-verb.test.mjs red at
// "an autosave is named and both current and legacy field shapes are explained":
// resume-verb:87 already detects an autosave from its frontmatter and brands it
// "*** AUTOSAVE, NOT A CURATED CAPSULE ***" with a full explainer. Rejecting the
// placeholder outright starved that path (loaded === null) and removed the loud
// handling this row exists to strengthen. The defect was only ever RANKING.
// So: demote to fallback tier, never reject. The pre-existing test was defending a
// contract, and it is the authority over an assertion I had written minutes earlier.
test('a seat with ONLY a sentinel falls back to it, flagged (loud path preserved)', () => {
  const root = seat({
    'auto-seat-1': {
      id: 'auto-seat-1', status: 'active', created_at: '2026-08-01T22:20:34.089Z',
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const { capsule, fellBackToPlaceholder } = selectCapsule(root);
  assert.equal(capsule?.id, 'auto-seat-1', 'last-resort fallback was starved');
  assert.equal(fellBackToPlaceholder, true, 'fallback was not flagged as such');
  rmSync(root, { recursive: true, force: true });
});

test('when a curated capsule wins, the demoted placeholder is still RECORDED', () => {
  const root = seat({
    curated: CURATED,
    'auto-seat-abcd1234': {
      id: 'auto-seat-abcd1234', status: 'active', created_at: '2026-08-01T22:20:34.089Z',
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const { capsule, rejected } = selectCapsule(root);
  assert.equal(capsule.id, 'curated-real');
  assert.ok(rejected.some((r) => r.reason === 'placeholder-demoted'),
    'the demotion was silent — indistinguishable from the placeholder not existing');
  rmSync(root, { recursive: true, force: true });
});

// ── NEGATIVE CONTROLS — these must pass BEFORE and AFTER the fix. If a fix makes
// any of them fail, it is over-matching and eating real capsules. ──────────────

test('NEG: an ordinary curated capsule is still selected', () => {
  const root = seat({ curated: CURATED });
  assert.equal(selectCapsule(root).capsule?.id, 'curated-real');
  rmSync(root, { recursive: true, force: true });
});

test('NEG: curated text that MENTIONS the sentinel mid-sentence still passes', () => {
  // Anchoring guard. The gate's patterns are start-anchored on purpose: a real
  // capsule may legitimately discuss the placeholder (this row's own notes do).
  const root = seat({
    curated: {
      id: 'curated-mentions', status: 'active', created_at: '2026-08-01T10:00:00.000Z',
      objective: 'Fix the selector so that "No concrete next action was captured" is rejected.',
      next_valid_action: 'Extend the vocabulary; the string "Unknown: no human objective" is the target.',
    },
  });
  assert.equal(selectCapsule(root).capsule?.id, 'curated-mentions',
    'over-matched: a curated capsule discussing the sentinel was thrown away');
  rmSync(root, { recursive: true, force: true });
});

test('NEG: newest-wins still holds between two valid curated capsules', () => {
  const root = seat({
    older: { ...CURATED, id: 'older', created_at: '2026-08-01T09:00:00.000Z' },
    newer: { ...CURATED, id: 'newer', created_at: '2026-08-01T11:00:00.000Z' },
  });
  assert.equal(selectCapsule(root).capsule?.id, 'newer', 'recency ordering regressed');
  rmSync(root, { recursive: true, force: true });
});

// ── sessionCapsulePath — identity binding for the transport's checkpoint
// check (2026-08-03 fix). WHY THIS EXISTS: the 08-01 demotion above is a
// RESUME-QUALITY heuristic — right for choosing what a fresh session should
// resume INTO, wrong for a DIFFERENT question auto-clear-transport.mjs asks:
// "does the checkpoint capsule THIS session just wrote still exist and still
// hold?" On a reference install a curated capsule always sits on disk, so a
// session whose own Stop delta captured nothing had its placeholder demoted
// in favor of that curated capsule on every tick — the selector's pick then
// never matched what the session's own stop-writer recorded, and the
// transport held checkpoint-session-mismatch forever (measured cycle 5,
// zero F001 cycles ever counted). The fix: name the session's own capsule by
// path and it wins THIS selection outright, placeholder or not. ───────────

test('sessionCapsulePath: the session\'s OWN sentinel wins over a curated capsule', () => {
  const root = seat({
    curated: CURATED,
    'auto-seat-abcd1234': {
      id: 'auto-seat-abcd1234', status: 'active',
      created_at: '2026-08-01T22:20:34.089Z',
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const sessionPath = path.join(root, 'capsules', 'auto-seat-abcd1234.md');
  const { capsule, sessionBound } = selectCapsule(root, { sessionCapsulePath: sessionPath });
  assert.equal(capsule?.id, 'auto-seat-abcd1234',
    `session's own placeholder lost to the curated capsule (picked ${capsule?.id})`);
  assert.equal(sessionBound, true, 'the win was not recorded as session binding');
  rmSync(root, { recursive: true, force: true });
});

test('sessionCapsulePath: identity binding beats RECENCY too, not just the placeholder heuristic', () => {
  // Same shape, but curated is now the NEWER capsule. If session binding only
  // worked when the session capsule happened to be newest, it would not have
  // fixed the reported defect (a curated capsule can postdate the checkpoint).
  const root = seat({
    'auto-seat-abcd1234': {
      id: 'auto-seat-abcd1234', status: 'active',
      created_at: '2026-08-01T09:00:00.000Z',
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
    curated: { ...CURATED, created_at: '2026-08-01T23:00:00.000Z' },
  });
  const sessionPath = path.join(root, 'capsules', 'auto-seat-abcd1234.md');
  const { capsule } = selectCapsule(root, { sessionCapsulePath: sessionPath });
  assert.equal(capsule?.id, 'auto-seat-abcd1234',
    'a curated capsule newer than the session checkpoint still stole the pick');
  rmSync(root, { recursive: true, force: true });
});

test('NEG: sessionCapsulePath ABSENT on the identical seat — the 08-01 demotion is unchanged', () => {
  const root = seat({
    curated: CURATED,
    'auto-seat-abcd1234': {
      id: 'auto-seat-abcd1234', status: 'active',
      created_at: '2026-08-01T22:20:34.089Z',
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const { capsule, sessionBound } = selectCapsule(root);
  assert.equal(capsule?.id, 'curated-real', 'default (option-absent) selection regressed');
  assert.ok(!sessionBound, 'sessionBound must not appear when the option was never supplied');
  rmSync(root, { recursive: true, force: true });
});

test('NEG: sessionCapsulePath naming a file NOT on disk is inert — standard selection still applies', () => {
  const root = seat({ curated: CURATED });
  const { capsule, sessionBound } = selectCapsule(root, {
    sessionCapsulePath: path.join(root, 'capsules', 'never-written.md'),
  });
  assert.equal(capsule?.id, 'curated-real', 'a dangling session path must not disturb ordinary selection');
  assert.ok(!sessionBound);
  rmSync(root, { recursive: true, force: true });
});

test('newestValidCapsule threads sessionCapsulePath through, and stays narrow when absent', () => {
  const root = seat({
    curated: CURATED,
    'auto-seat-abcd1234': {
      id: 'auto-seat-abcd1234', status: 'active',
      created_at: '2026-08-01T22:20:34.089Z',
      objective: SENTINEL_OBJECTIVE, next_valid_action: SENTINEL_ACTION,
    },
  });
  const sessionPath = path.join(root, 'capsules', 'auto-seat-abcd1234.md');

  const bound = newestValidCapsule(root, { sessionCapsulePath: sessionPath });
  assert.equal(bound?.id, 'auto-seat-abcd1234', 'wrapper did not thread the option through');

  const plain = newestValidCapsule(root);
  assert.equal(plain?.id, 'curated-real', 'wrapper default behavior regressed');
  assert.deepEqual(
    Object.keys(plain).sort(),
    ['createdRaw', 'created', 'id', 'path', 'rejected'].sort(),
    'option-absent return shape must stay BYTE-IDENTICAL to before this fix — no leaked sessionBound key',
  );
  rmSync(root, { recursive: true, force: true });
});

console.log(failures ? `\n${failures} FAILING` : '\nall green');
process.exit(failures ? 1 : 0);

// RESIDUE, named rather than discovered later (Law XX — do not claim broader
// coverage than measured):
//   This fix keys on the writer's own PLACEHOLDER strings. It does NOT classify
//   arbitrary junk captured into `objective` — titus's specimen was a pasted image
//   path, metis's was command stdout ending in a literal </local-command-stdout>.
//   Both are caught here ONLY because their next_valid_action is the sentinel. A
//   capsule with a junk objective AND a genuine next action would still pass.
//   That is a defect in the writer's CAPTURE logic, not in selection, and it needs
//   its own row. Note also that metis's trailing </local-command-stdout> is exactly
//   an INJECTION_TEMPLATES shape that the START-anchored patterns miss.
