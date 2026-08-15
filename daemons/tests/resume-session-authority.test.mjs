// resume-session-authority.test.mjs — the deterministic session-id rule.
//
// THE CURRENT RULE (accepted identity contract 2026-08-10 → 2026-08-11, replacing the
// abandoned PATCH-001O content classification). One authority, one cross-check,
// no fallbacks:
//   - the SessionStart hook's session_id, when it is a non-empty STRING, is the
//     SOLE current identity — hook B is authoritative;
//   - boot-receipt.json is a CROSS-CHECK ONLY, and only when the hook id exists.
//     Agreement is recorded, disagreement is named, and the hook id wins either
//     way: the receipt write at boot is best-effort, so a failed write leaves
//     the PREVIOUS boot's file and a stale receipt must never override B;
//   - the capsule supplies HISTORICAL work state. A stale session id A sitting
//     in capsule text can never override B;
//   - no hook id ⇒ NO supplied session id. Neither capsule text nor the on-disk
//     receipt is promoted to fill the gap; the procedure says so and names
//     CURRENT_SESSION_ID_UNAVAILABLE.
// No parsing of capsule English is involved anywhere — the authoritative value
// simply arrives on the hook, or it does not arrive at all.
//
// The original runnable check, still enforced below:
//   - newest capsule contains stale session ID A;
//   - hook supplies session ID B (receipt agreeing, disagreeing, or absent);
//   - resumed result uses B;
//   - A cannot override B.
//
// Real-glue: drives the REAL runResumeVerb() against a temp seat fixture.
// Run: node daemons/tests/resume-session-authority.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { runResumeVerb } from '../resume-verb.mjs';

// memRoot() honors AIGENT_STATE_HOME_DIR ahead of the passed root, so an
// operator's diversion lever would send every case below at the REAL seat vault
// — where runResumeVerb marks the live newest capsule consumed. Neutralized for
// the whole file and restored on exit, per the sibling suites' convention.
const SAVED_STATE_HOME = process.env.AIGENT_STATE_HOME_DIR;
delete process.env.AIGENT_STATE_HOME_DIR;
const restoreStateHome = () => {
  if (SAVED_STATE_HOME === undefined) delete process.env.AIGENT_STATE_HOME_DIR;
  else process.env.AIGENT_STATE_HOME_DIR = SAVED_STATE_HOME;
};

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const STALE_A = '0adaa477-5b8f-4646-9511-d748900c7891';
const LIVE_B = 'b7e2c9d4-1234-4abc-9def-aaaaaaaaaaaa';

// Seat fixture with vault/memory layout (memRoot resolves vault/memory first).
function seat({ bootReceipt, capsuleAction }) {
  const root = mkdtempSync(path.join(tmpdir(), 'rsa-'));
  const mem = path.join(root, 'vault', 'memory');
  mkdirSync(path.join(mem, 'capsules'), { recursive: true });
  mkdirSync(path.join(mem, 'runtime'), { recursive: true });
  const fm = {
    id: 'stale-uuid-capsule', status: 'active', created_at: '2026-08-07T13:13:02-07:00',
    objective: 'Part 2 of continuity witness (append session_id to witness file)',
    next_valid_action: capsuleAction,
  };
  const body = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(path.join(mem, 'capsules', 'stale-uuid-capsule.md'), `---\n${body}\n---\n\n# body\n`);
  if (bootReceipt !== undefined) {
    writeFileSync(path.join(mem, 'runtime', 'boot-receipt.json'), JSON.stringify(bootReceipt));
  }
  return root;
}

const ACTION_WITH_A =
  `Read session_id from vault/memory/runtime/boot-receipt.json (session_id: ${STALE_A}) `
  + `and append the line 'CONTINUITY 2/2 ${STALE_A}' to vault/memory/notes/continuity-witness-001.md`;

console.log('resume-session-authority');

// The original verbatim check, re-routed: B now arrives on the hook (the sole
// authority) with the receipt agreeing as cross-check. The receipt-only shape
// this case used to drive was deleted by the 2026-08-11 cleanup order.
test('resumed result uses live B; stale A in capsule text cannot override it', () => {
  const root = seat({ bootReceipt: { session_id: LIVE_B }, capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: LIVE_B });
  // Structural: the result carries the live session id as DATA a supervisor can assert on.
  assert.equal(result.bootSession?.session_id, LIVE_B,
    `result.bootSession must carry live B (got ${JSON.stringify(result.bootSession)})`);
  // The procedure supplies B in its CURRENT SESSION block…
  const current = result.prompt.split('\n').filter((l) => /CURRENT SESSION/i.test(l) || /^\s+session_id:/.test(l)).join('\n');
  assert.ok(current.includes(LIVE_B), `CURRENT SESSION block must supply B (block: ${JSON.stringify(current)})`);
  // …and A appears ONLY inside quoted capsule data, never as the supplied value.
  assert.ok(!current.includes(STALE_A), 'stale A leaked into the CURRENT SESSION block');
  // The authority fence names the rule.
  assert.ok(/non-authoritative/i.test(result.prompt), 'the non-authoritative fence line is missing');
  rmSync(root, { recursive: true, force: true });
});

test('capsule still loads and its text is still quoted (selection untouched)', () => {
  const root = seat({ bootReceipt: { session_id: LIVE_B }, capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: '' });
  assert.equal(result.loaded?.id, 'stale-uuid-capsule', 'newest-valid selection regressed');
  assert.ok(result.prompt.includes(STALE_A), 'capsule data (incl. its historical UUID) must still be quoted as data');
  rmSync(root, { recursive: true, force: true });
});

test('boot receipt absent: hook sessionId supplies the value, source named', () => {
  const root = seat({ capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: LIVE_B });
  assert.equal(result.bootSession?.session_id, LIVE_B, 'hook fallback must supply the live id');
  assert.ok(/hook/i.test(result.bootSession?.source || ''), 'fallback source must be named');
  rmSync(root, { recursive: true, force: true });
});

test('neither source available: procedure supplies nothing and names it unavailable', () => {
  const root = seat({ capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: '' });
  assert.equal(result.bootSession, null, 'no fabricated session id');
  assert.ok(/CURRENT_SESSION_ID_UNAVAILABLE/.test(result.prompt),
    'the degrade must name the reportable unavailable token');
  // Split on the SECTION HEADER, not the phrase: the procedure's intro sentence
  // mentions "CAPSULE DATA" long before the section, so the bare phrase cut the
  // slice at 257 chars — before the fences and CURRENT SESSION block — and the
  // assertion could never have failed. Assert the anchor was actually found.
  const halves = result.prompt.split('CAPSULE DATA (read off disk');
  assert.equal(halves.length, 2, 'the CAPSULE DATA section header must be present exactly once');
  const procedureHalf = halves[0];
  assert.ok(/FENCES/.test(procedureHalf) && /CURRENT SESSION/.test(procedureHalf),
    'the procedure half must contain the fences and the CURRENT SESSION block, or this check is vacuous');
  assert.ok(!procedureHalf.includes(STALE_A), 'stale A must not be promoted into the procedure half');
  rmSync(root, { recursive: true, force: true });
});

// REQUIRED REGRESSION (required identity regression 2026-08-11): NO hook id +
// a nonempty on-disk receipt must supply NOTHING. In the shipped flow the
// carrier writes the receipt from the same payload before this read, so the
// only way a receipt-only case carries a value is a FAILED write leaving the
// PREVIOUS boot's receipt on disk — i.e. receipt-only authority can only ever
// serve a stale id.
test('no hook + stale receipt: nothing supplied, loud degrade, stale id never authoritative', () => {
  const root = seat({ bootReceipt: { session_id: STALE_A }, capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: '' });
  assert.equal(result.bootSession, null,
    `a disk receipt alone must never become authoritative (got ${JSON.stringify(result.bootSession)})`);
  const halves = result.prompt.split('CAPSULE DATA (read off disk');
  assert.equal(halves.length, 2, 'the CAPSULE DATA section header must be present exactly once');
  const procedureHalf = halves[0];
  assert.ok(!procedureHalf.includes(STALE_A), 'the stale receipt id must not reach the procedure half');
  assert.ok(/no authoritative hook session ID was supplied/i.test(procedureHalf),
    'the degrade must be loud about having no authority');
  assert.ok(/CURRENT_SESSION_ID_UNAVAILABLE/.test(procedureHalf),
    'the degrade must name the reportable unavailable token, not send the reader to a file');
  rmSync(root, { recursive: true, force: true });
});

// Item 2: a non-string hook value must be refused, never String()-coerced into
// a truthy '[object Object]' and served as the authoritative session id.
test('non-string hook sessionId is invalid: nothing supplied, no [object Object]', () => {
  const root = seat({ capsuleAction: ACTION_WITH_A });
  for (const bad of [{ id: 'x' }, ['x'], 42, true]) {
    const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: bad });
    assert.equal(result.bootSession, null,
      `non-string hook id ${JSON.stringify(bad)} must not supply a session id (got ${JSON.stringify(result.bootSession)})`);
    assert.ok(!result.prompt.includes('[object Object]'), 'String() coercion leaked into the procedure');
  }
  rmSync(root, { recursive: true, force: true });
});

test('malformed boot receipt degrades to the hook value without throwing', () => {
  const root = seat({ capsuleAction: ACTION_WITH_A });
  writeFileSync(path.join(root, 'vault', 'memory', 'runtime', 'boot-receipt.json'), '{not json');
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: LIVE_B });
  assert.equal(result.bootSession?.session_id, LIVE_B, 'malformed receipt must not break session start');
  rmSync(root, { recursive: true, force: true });
});

// REQUIRED REGRESSION (required identity regression 2026-08-10): receipt contains stale
// session A, current hook contains fresh session B → resumed result uses B, A
// cannot override B, and the mismatch is named. This is the ONE case where the
// two sources can disagree in production: writeBootReceipt() failed at boot and
// the PREVIOUS boot's receipt is still on disk.
test('receipt stale A + hook fresh B: B wins, A cannot override, mismatch named', () => {
  const root = seat({ bootReceipt: { session_id: STALE_A }, capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: LIVE_B });
  assert.equal(result.bootSession?.session_id, LIVE_B,
    `hook B must be authoritative over the on-disk receipt (got ${JSON.stringify(result.bootSession)})`);
  assert.ok(/mismatch|disagree/i.test(`${result.bootSession?.source || ''} ${result.bootSession?.receipt_check || ''}`),
    'the receipt disagreement must be named in source/detail');
  assert.equal(result.bootSession?.receipt_session_id, STALE_A,
    'the overridden receipt value must be carried as data, not silently dropped');
  // Split on the data SECTION HEADER, not the phrase 'CAPSULE DATA' — the
  // procedure's intro sentence mentions the phrase long before the section.
  const procedureHalf = result.prompt.split('CAPSULE DATA (read off disk')[0] || '';
  const sessLines = procedureHalf.split('\n').filter((l) => /^\s+session_id:/.test(l)).join('\n');
  assert.ok(sessLines.includes(LIVE_B), 'CURRENT SESSION must supply B');
  assert.ok(!sessLines.includes(STALE_A), 'stale A leaked as the supplied session id');
  assert.ok(/mismatch/i.test(procedureHalf), 'the procedure must name the receipt mismatch');
  rmSync(root, { recursive: true, force: true });
});

test('receipt and hook MATCH: hook id used, cross-check match recorded', () => {
  const root = seat({ bootReceipt: { session_id: LIVE_B }, capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: LIVE_B });
  assert.equal(result.bootSession?.session_id, LIVE_B);
  assert.ok(/hook/i.test(result.bootSession?.source || ''), 'the hook must be named as the authority');
  assert.ok(/match/i.test(`${result.bootSession?.source || ''} ${result.bootSession?.receipt_check || ''}`),
    'the receipt cross-check match must be recorded');
  rmSync(root, { recursive: true, force: true });
});

// F2: the procedure must name the receipt by its RESOLVED path for the active
// layout (this fixture uses vault/memory, which memRoot() resolves first) —
// never the hardcoded memory/... literal, which points at nothing here.
// Re-pointed by the 2026-08-11 order: the no-hook procedure no longer names the
// receipt at all, so this now binds to the case where the path is legitimately
// rendered — the cross-check MISMATCH line. The guarantee is unchanged: when the
// procedure prints the receipt path it must be the RESOLVED one for the active
// layout, never the bare memory/... literal that points at nothing here.
test('mismatch line names the resolved receipt path for the active vault/memory layout', () => {
  const root = seat({ bootReceipt: { session_id: STALE_A }, capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: LIVE_B });
  // Assert on the PROCEDURE half only: the capsule fixture's own quoted text
  // also contains the vault path, so a whole-prompt match cannot fail. Split on
  // the data SECTION HEADER — the intro sentence mentions the phrase earlier.
  const procedureHalf = result.prompt.split('CAPSULE DATA (read off disk')[0] || '';
  assert.ok(procedureHalf.includes('vault/memory/runtime/boot-receipt.json'),
    'procedure must name the resolved path (vault/memory/...), not the bare memory/... literal');
  rmSync(root, { recursive: true, force: true });
});

// REQUIRED CHECK (required identity regression 2026-08-11, final two findings). With no
// authoritative hook id, a READABLE receipt sitting on disk is still stale by
// construction, so the degrade must not point the model at it. Naming the
// receipt here at all is the defect: an instruction to "read it directly"
// turns a cross-check artifact into a fallback identity source, which is the
// one thing the contract forbids.
test('no hook + readable stale receipt: no ID supplied, no receipt instruction, unavailable named', () => {
  const root = seat({ bootReceipt: { session_id: STALE_A }, capsuleAction: ACTION_WITH_A });
  const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: '' });

  assert.equal(result.bootSession, null,
    `a readable disk receipt must never supply identity (got ${JSON.stringify(result.bootSession)})`);

  const halves = result.prompt.split('CAPSULE DATA (read off disk');
  assert.equal(halves.length, 2, 'the CAPSULE DATA section header must be present exactly once');
  const procedureHalf = halves[0];
  assert.ok(/FENCES/.test(procedureHalf) && /CURRENT SESSION/.test(procedureHalf),
    'the procedure half must contain the fences and the CURRENT SESSION block, or this check is vacuous');

  assert.ok(!procedureHalf.includes(STALE_A),
    'the stale receipt id must not enter the procedure');
  assert.ok(!/boot-receipt\.json/.test(procedureHalf),
    'with no hook id the procedure must not name the receipt as a place to get one');
  assert.ok(!/unreadable/i.test(procedureHalf),
    'the degrade must not claim the receipt is unreadable — here it reads fine and is merely stale');
  assert.ok(procedureHalf.includes('CURRENT_SESSION_ID_UNAVAILABLE'),
    'the degrade must name the reportable token CURRENT_SESSION_ID_UNAVAILABLE');
  rmSync(root, { recursive: true, force: true });
});

restoreStateHome();
console.log(failures ? `\n${failures} FAILING` : '\nall green');
process.exit(failures ? 1 : 0);
