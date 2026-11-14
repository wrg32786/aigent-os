// pre-permission-interlock.test.mjs -- the MECHANISM, as opposed to the
// runner's use of it (#104 I vectors in pty-runner.test.mjs).
//
// Everything here is about the three properties the interlock rests on, and
// each one is a thing that has to be true of the FILESYSTEM rather than of the
// code: the gate excludes, a dead holder's gate can be taken without two
// takers both believing they have it, and every wait is bounded with a
// fail-closed fallback.
//
// The primitives were measured on both platforms before being relied on -- see
// docs/dialog-readiness.md, "Platform semantics". A Windows-only run cannot see
// the POSIX branch of an open/stat distinction, which is the lesson #110 paid
// for with a Linux-only regression.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_NAME,
  GATE_STALE_MS,
  HOOK_GATE_BUDGET_MS,
  INTERLOCK_DRAIN_MS,
  PENDING_MAX,
  RECENT_IDS_MAX,
  PROOF_NAME,
  STATE_NAME,
  ALL_PRE_TOOL_USE_DENY_CODES,
  INTERLOCK_EVENTS,
  anyManagedSession,
  RELEASE_LITERAL,
  RELEASE_NAME,
  acquireGate,
  denyReasonFor,
  emptyState,
  interlockEvidence,
  manualRelease,
  pendingProblem,
  readState,
  releaseGate,
  releaseMain,
  runHook,
  sessionDir,
  sweepSessionDirs,
  writeProof,
  writeState,
} from '../pre-permission-interlock.mjs';

// ─── fileURLToPath, NOT `pathname.slice(1)` ────────────────────────────────
// The slice idiom is a WINDOWS-ONLY assumption and it broke Linux CI. A file
// URL's pathname carries a leading slash on both platforms:
//
//   win32  /C:/dev/wt-interlock/daemons/tests/...   slice(1) -> C:/dev/...   ABSOLUTE
//   linux  /home/runner/work/.../daemons/tests/...  slice(1) -> home/...     RELATIVE
//
// so on POSIX `path.resolve` prefixed process.cwd() and produced
// `<repo>/home/runner/work/.../daemons/pre-permission-interlock.mjs` -- the
// doubled root in the CI failure, reproduced character for character. G12 and
// G27 were the two vectors that read this file, which is why only they failed
// and only on ubuntu.
//
// fileURLToPath is correct on both and is what the production code already uses
// (daemons/pty-runner.mjs `_interlockHookFile`, and this module's own `direct`
// check), so this was never a product defect -- only a test that could not run
// where the product can.
const HOOK_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pre-permission-interlock.mjs');
const SESSION = 'session-interlock-test';
const NONCE = 'nonce-for-this-binding';

function scratch(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `interlock-${name}-`));
  const memRoot = path.join(base, 'project', 'vault', 'memory');
  fs.mkdirSync(memRoot, { recursive: true });
  const env = { AIGENT_INTERLOCK_DIR: path.join(memRoot, 'runtime', 'interlock') };
  const dir = sessionDir({ memRoot, sessionId: SESSION, env });
  fs.mkdirSync(dir, { recursive: true });
  return { base, memRoot, env, dir };
}

// `pid` is the RUNNER's pid in the proof, and it has to be a LIVE one: a proof
// whose runner is gone means there is no managed runner, so the hook goes inert
// (that is manual recovery path 1, and G18 is about it). Every vector that is
// NOT about that path therefore binds to this process.
function bind(fixture, { nonce = NONCE, pid = process.pid } = {}) {
  writeProof({
    dir: fixture.dir,
    proof: {
      nonce,
      session_id: SESSION,
      runner_pid: pid,
      hook_path: HOOK_PATH,
      hook_sha256: 'unused-by-the-hook-side',
      created_at: new Date(0).toISOString(),
    },
  });
  return nonce;
}

function hookPayload(extra = {}) {
  return {
    session_id: SESSION,
    transcript_path: path.join(os.tmpdir(), 'no-such-transcript.jsonl'),
    cwd: path.join(os.tmpdir(), 'no-such-cwd'),
    ...extra,
  };
}

function withScratch(name, fn) {
  const fixture = scratch(name);
  try { fn(fixture); } finally {
    try { fs.rmSync(fixture.base, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

// ─── THE GATE EXCLUDES ──────────────────────────────────────────────────────

test('#104 G1 the gate is exclusive: a second acquisition fails rather than succeeding twice', () => {
  withScratch('g1', (fx) => {
    const first = acquireGate({ dir: fx.dir, side: 'runner', nonce: NONCE, pid: 101, processLike: { kill: () => true } });
    assert.equal(first.ok, true, 'the first taker gets it');
    const second = acquireGate({ dir: fx.dir, side: 'hook', nonce: NONCE, pid: 102, processLike: { kill: () => true } });
    assert.equal(second.ok, false,
      'THE WHOLE MECHANISM: if this ever succeeds, the runner and the hook can both '
      + 'believe they own the composer and the interlock is decoration');
    assert.equal(second.code, 'interlock-gate-busy');
    assert.equal(releaseGate(first.handle), true);
    const third = acquireGate({ dir: fx.dir, side: 'hook', nonce: NONCE, pid: 103, processLike: { kill: () => true } });
    assert.equal(third.ok, true, 'and it is a lock, not a latch');
    releaseGate(third.handle);
  });
});

test('#104 G2 a gate is NOT stolen from a live young holder, and IS stolen from a dead one', () => {
  withScratch('g2', (fx) => {
    const held = acquireGate({ dir: fx.dir, side: 'runner', nonce: NONCE, pid: 201, processLike: { kill: () => true } });
    assert.equal(held.ok, true);

    // Alive and young: not stealable. Stealing here would break the exclusion
    // for the process that legitimately holds it.
    const refused = acquireGate({
      dir: fx.dir, side: 'hook', nonce: NONCE, pid: 202,
      processLike: { kill: () => true },
    });
    assert.equal(refused.ok, false, 'a live holder keeps its gate');

    // The holder's process is gone. A gate nobody will ever release is a
    // liveness hazard in the fail-closed direction -- every tool call in the
    // session would be denied -- so it is stealable at once.
    const stolen = acquireGate({
      dir: fx.dir, side: 'hook', nonce: NONCE, pid: 203,
      processLike: { kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } },
    });
    assert.equal(stolen.ok, true, 'a dead holder does not keep it');
    // AND THE ORIGINAL HOLDER CANNOT RELEASE WHAT IT NO LONGER HOLDS. Its
    // unlink would free the new holder's gate, which is the exclusion broken by
    // a different route.
    assert.equal(releaseGate(held.handle), false, 'the stale handle releases nothing');
    assert.ok(fs.existsSync(path.join(fx.dir, GATE_NAME)), 'the new holder still holds it');
    releaseGate(stolen.handle);
  });
});

test('#104 G3 a gate stamped with ANOTHER binding nonce is always stealable', () => {
  withScratch('g3', (fx) => {
    const old = acquireGate({
      dir: fx.dir, side: 'runner', nonce: 'a-previous-binding', pid: 301,
      processLike: { kill: () => true },
    });
    assert.equal(old.ok, true);
    // The session rebound. Whatever that gate was protecting belongs to a
    // conversation that no longer exists, and its holder may well still be
    // alive (the same runner process, now on a new binding).
    const next = acquireGate({
      dir: fx.dir, side: 'runner', nonce: NONCE, pid: 301,
      processLike: { kill: () => true },
    });
    assert.equal(next.ok, true, 'a new binding is not blocked by the old one');
    releaseGate(next.handle);
  });
});

test('#104 G4 a gate path that is a DIRECTORY is named, not read as contention', () => {
  withScratch('g4', (fx) => {
    // #110's lesson, applied before it could bite: an O_EXCL open answers
    // EEXIST for a directory too, so without this branch the gate would read as
    // permanently held and every tool call in the session would be denied
    // forever -- fail-closed, but a wedge, and nameless.
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));
    const verdict = acquireGate({
      dir: fx.dir, side: 'hook', nonce: NONCE, pid: 401,
      budgetMs: 50,
      processLike: { kill: () => true },
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'interlock-gate-path-unusable',
      'named for what it IS, not for whichever error the platform happens to raise');
  });
});

// ─── THE HOOK'S WAITS ARE BOUNDED AND FAIL CLOSED ───────────────────────────

test('#104 G5 PreToolUse: the gate wait is BOUNDED and the fallback is a DENIAL', () => {
  withScratch('g5', (fx) => {
    bind(fx);
    const blocker = acquireGate({
      dir: fx.dir, side: 'runner', nonce: NONCE, pid: 501,
      processLike: { kill: () => true },
    });
    assert.equal(blocker.ok, true, 'setup: the runner is mid-write');

    let clock = 1_000_000;
    const slept = [];
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      pid: 502,
      processLike: { kill: () => true },
      now: () => clock,
      sleep: (ms) => { slept.push(ms); clock += ms; },
      gateBudgetMs: HOOK_GATE_BUDGET_MS,
    });

    // BOUNDED: a hook that blocks forever hangs the agent, so the wait has a
    // budget and the budget is spent in bounded sleeps.
    assert.ok(slept.length > 0, 'it waited');
    const total = slept.reduce((a, b) => a + b, 0);
    assert.ok(total <= HOOK_GATE_BUDGET_MS,
      `the total wait is bounded by HOOK_GATE_BUDGET_MS, got ${total}`);
    assert.ok(total >= HOOK_GATE_BUDGET_MS - 10, 'and it actually used its budget before giving up');
    // BOUNDED EVEN IF THE CLOCK DOES NOT MOVE. An earlier draft bounded the wait
    // only by a deadline, so a constant clock -- injected by the very next
    // assertion -- looped forever instead of denying, which is the agent hanging
    // on a hook. Two independent bounds now: the deadline and an attempt
    // ceiling.
    const frozen = [];
    const frozenVerdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_B', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      pid: 503,
      processLike: { kill: () => true },
      now: () => 7,
      sleep: (ms) => frozen.push(ms),
      gateBudgetMs: HOOK_GATE_BUDGET_MS,
    });
    assert.equal(frozenVerdict.action, 'deny', 'a frozen clock still terminates, fail-closed');
    assert.ok(frozen.length <= Math.ceil(HOOK_GATE_BUDGET_MS / 5) + 2,
      `and the attempt ceiling holds it, got ${frozen.length} attempts`);

    // FAIL CLOSED: the tool call does not reach the permission check, so no
    // dialog appears, so there is nothing for an automatic keystroke to answer.
    // A denial is recoverable; an automatic "Yes, and switch to accept edits
    // for this session" is not.
    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.code, 'interlock-gate-busy');
    // IT RECORDS NO MARKER. A denied call never reaches a dialog, so a marker
    // for it would hold automation for a check that cannot happen.
    const state = readState({ dir: fx.dir });
    assert.deepEqual(Object.keys(state.state?.pending ?? {}), [], 'no marker');
    // AND IT WRITES NOTHING AT ALL on this path. A denial IS an invocation, and
    // leg 4 would like the count -- an earlier attempt took it, with an ungated
    // read-modify-write of the whole state file, and that DESTROYED A MARKER
    // FOR A LIVE DIALOG when the gate holder's own write interleaved between
    // its read and its write. This path exists *because* another party holds
    // the gate, so there is no safe moment to record anything here. Leg 4's
    // forgiveness rule absorbs the dropped increment, which is its stated
    // purpose. The invariant holds without exception: STATE.JSON IS WRITTEN
    // ONLY UNDER THE GATE.
    // No state file at all: this fixture never wrote one, and the denial did
    // not create one either. That is the strongest form of "records nothing".
    assert.equal(state.ok, false, 'a gate-busy denial records nothing');
    assert.equal(state.code, 'interlock-state-missing');
    releaseGate(blocker.handle);
  });
});

test('#104 G6 PostToolUse and Stop ALLOW when they cannot take the gate: failing to CLEAR is already safe', () => {
  withScratch('g6', (fx) => {
    bind(fx);
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1, pending: { toolu_A: { tool: 'Read', ts: 0 } } } });
    const blocker = acquireGate({
      dir: fx.dir, side: 'runner', nonce: NONCE, pid: 601,
      processLike: { kill: () => true },
    });
    for (const event of ['PostToolUse', 'Stop']) {
      const verdict = runHook({
        payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
        event,
        env: fx.env,
        pid: 602,
        processLike: { kill: () => true },
        now: () => 0,
        sleep: () => {},
        gateBudgetMs: 0,
      });
      assert.equal(verdict.action, 'allow',
        `${event} must not deny: its failure mode is that the marker is not cleared, `
        + 'which HOLDS automatic writes -- already the safe direction. Denying there '
        + 'would cost liveness and buy nothing.');
      assert.equal(verdict.code, 'interlock-gate-busy', 'and it says so');
    }
    assert.deepEqual(Object.keys(readState({ dir: fx.dir }).state.pending), ['toolu_A'],
      'the marker is still pending, which is what holds the write');
    releaseGate(blocker.handle);
  });
});

test('#104 G7 NO MANAGED RUNNER MEANS NO OPINION: with no proof the hook is inert, never a denial', () => {
  withScratch('g7', (fx) => {
    // The symmetry that makes this not a fail-open: the RUNNER's side requires
    // the proof it writes itself, so absence holds automatic writes on one side
    // and silences the hook on the other. Two views of one fact.
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(verdict.action, 'inert',
      'an unmanaged seat must not have its tool calls denied by a runner that is not there');
    assert.equal(verdict.code, 'interlock-proof-missing');
    assert.equal(fs.existsSync(path.join(fx.dir, STATE_NAME)), false, 'and nothing is written');

    // The runner's half of the same absence.
    const evidence = interlockEvidence({
      dir: fx.dir,
      nonce: NONCE,
      sessionId: SESSION,
      runnerPid: 701,
      hookPath: HOOK_PATH,
      hookSha256: 'whatever',
    });
    assert.equal(evidence.ok, false, 'the runner refuses on the same file being absent');
    assert.equal(evidence.code, 'interlock-proof-missing');
  });
});

test('#104 G8 a permission check with no usable tool_use_id is RECORDED, never dropped', () => {
  withScratch('g8', (fx) => {
    bind(fx);
    // A call that cannot be named is still a call that raises a dialog. The
    // asymmetry is the safety property: missing an OPEN is a fail-open, so an
    // unnameable one gets a synthetic key that only a Stop sweep clears.
    const verdict = runHook({
      payload: hookPayload({ tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 5,
      sleep: () => {},
    });
    assert.equal(verdict.action, 'allow');
    const ids = Object.keys(readState({ dir: fx.dir }).state.pending);
    assert.equal(ids.length, 1, 'it is pending');
    assert.match(ids[0], /^anon:/, 'under a synthetic key, so it cannot collide with a real id');

    // A PostToolUse for a DIFFERENT id cannot clear it -- pairing is by id.
    runHook({
      payload: hookPayload({ tool_use_id: 'toolu_OTHER' }),
      event: 'PostToolUse',
      env: fx.env,
      now: () => 6,
      sleep: () => {},
    });
    assert.equal(Object.keys(readState({ dir: fx.dir }).state.pending).length, 1,
      'one result settles its own call and no other');

    // The turn ends. THAT is what clears it.
    runHook({ payload: hookPayload(), event: 'Stop', env: fx.env, now: () => 7, sleep: () => {} });
    assert.deepEqual(Object.keys(readState({ dir: fx.dir }).state.pending), []);
  });
});

test('#104 G9 a pending map at its cap DENIES rather than discarding a call or growing without bound', () => {
  withScratch('g9', (fx) => {
    bind(fx);
    const pending = {};
    for (let i = 0; i < PENDING_MAX; i += 1) pending[`toolu_${i}`] = { tool: 'Read', ts: 0 };
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1, pending } });
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_ONE_TOO_MANY', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(verdict.action, 'deny',
      'the two alternatives are discarding a pending call (the fail-open) and an '
      + 'unbounded file; a denial is neither');
    assert.equal(verdict.code, 'interlock-pending-overflow');
  });
});

test('#104 G10 THE DRAIN: a hook arriving just after a runner write waits out the bytes in flight', () => {
  withScratch('g10', (fx) => {
    bind(fx);
    // pty.write() RETURNING is not the child having CONSUMED the byte, so the
    // runner's write is causally before the marker while the byte may still be
    // travelling. The wait belongs in the hook: it is a throwaway process, so a
    // bounded synchronous wait there costs the runner nothing and cannot stall
    // the runner's event loop.
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1, last_write_at: 10_000 } });
    const slept = [];
    runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 10_030,
      sleep: (ms) => slept.push(ms),
    });
    assert.deepEqual(slept, [INTERLOCK_DRAIN_MS - 30], 'exactly the remainder, no more');

    // A write long past: no drain at all.
    const later = [];
    runHook({
      payload: hookPayload({ tool_use_id: 'toolu_B', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      now: () => 10_000 + INTERLOCK_DRAIN_MS + 1,
      sleep: (ms) => later.push(ms),
    });
    assert.deepEqual(later, [], 'and it is not an unconditional delay on every tool call');
  });
});

test('#104 G11 a PreToolUse that cannot RECORD the check denies; a PostToolUse that cannot does not', () => {
  withScratch('g11', (fx) => {
    bind(fx);
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1 } });
    // Everything readable, nothing writable: the one case where the hook has
    // found a managed runner and still cannot do its job.
    const fsImpl = {
      ...fs,
      openSync: (target, flags) => {
        if (String(target).endsWith(`${STATE_NAME}`) || String(target).includes(`${STATE_NAME}.tmp-`)) {
          const e = new Error('read-only'); e.code = 'EROFS'; throw e;
        }
        return fs.openSync(target, flags);
      },
    };
    const denied = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      fsImpl,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(denied.action, 'deny',
      'it could not record the check, so the runner would read an empty pending map '
      + 'and write -- the fail-open. At that instant a denial is the only closed answer.');
    assert.equal(denied.code, 'interlock-state-write-failed');

    const allowed = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A', tool_name: 'Read' }),
      event: 'PostToolUse',
      env: fx.env,
      fsImpl,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(allowed.action, 'allow', 'a failure to CLEAR only holds automation');
  });
});

// ─── THE RUNNER'S EVIDENCE LEGS ─────────────────────────────────────────────

test('#104 G12 the four evidence legs each refuse by their own name, and all four are required', () => {
  withScratch('g12', (fx) => {
    const nonce = bind(fx, { pid: 1201 });
    const good = {
      dir: fx.dir,
      nonce,
      sessionId: SESSION,
      runnerPid: 1201,
      hookPath: HOOK_PATH,
      hookSha256: null,
    };
    // Compute the real digest so leg 2 can pass.
    good.hookSha256 = crypto.createHash('sha256').update(fs.readFileSync(HOOK_PATH)).digest('hex');

    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1 } });
    assert.equal(interlockEvidence(good).ok, true, 'setup: all four legs pass');

    assert.equal(interlockEvidence({ ...good, nonce: 'other' }).code, 'interlock-proof-mismatch');
    assert.equal(interlockEvidence({ ...good, sessionId: 'other' }).code, 'interlock-proof-mismatch');
    assert.equal(interlockEvidence({ ...good, runnerPid: 9 }).code, 'interlock-proof-mismatch');
    assert.equal(interlockEvidence({ ...good, hookPath: path.join(fx.base, 'nope.mjs') }).code, 'interlock-hook-missing');
    assert.equal(interlockEvidence({ ...good, hookSha256: 'f'.repeat(64) }).code, 'interlock-hook-changed');

    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 0 } });
    assert.equal(interlockEvidence(good).code, 'interlock-hook-not-observed',
      'leg 3 is the EMPIRICAL one: the host must actually have run the hook');

    // Leg 4 matches BY ID against the last agreement point. With no agreement
    // point yet, the ids the reader parsed are history (its baseline walk reads
    // up to a megabyte whose calls the hook handled before the state file
    // existed) and are absorbed rather than charged to the hook.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 3 } });
    const first = interlockEvidence({ ...good, toolUsesObserved: 500, toolUseIdsSince: ['toolu_OLD1', 'toolu_OLD2'] });
    assert.equal(first.ok, true,
      'with no checkpoint, history is absorbed rather than charged to the hook');
    assert.deepEqual(first.nextCheckpoint, { preRuns: 3 });

    // A DEAD HOOK: two more tool calls the reader saw, and NO hook activity at
    // all since the agreement point.
    const dead = interlockEvidence({
      ...good, toolUsesObserved: 502, toolUseIdsSince: ['toolu_D1', 'toolu_D2'], checkpoint: first.nextCheckpoint,
    });
    assert.equal(dead.ok, false, 'a hook that stopped running is detected on the next call');
    assert.equal(dead.code, 'interlock-hook-missed-tool-calls');
    assert.deepEqual(dead.detail, { hook_runs_since: 0, tool_uses_since: 2, unpaid: 2 });

    // Every parsed id has a run with that id: a plain pass, nothing forgiven.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 5, recent_ids: ['toolu_P1', 'toolu_P2'] } });
    const paid = interlockEvidence({
      ...good, toolUseIdsSince: ['toolu_P1', 'toolu_P2'], checkpoint: first.nextCheckpoint,
    });
    assert.equal(paid.ok, true);
    assert.equal(paid.forgaveDeficit, undefined, 'paid in full is not a forgiveness');
    assert.deepEqual(paid.nextCheckpoint, { preRuns: 5 });

    // A CALL THE HOOK DID NOT COUNT, which is a different thing and must not
    // be permanent. The hook is ALIVE (it ran for other calls since the
    // agreement point), so an unpaid record is a call it missed, not death.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 6, recent_ids: ['toolu_F1', 'toolu_F2', 'toolu_F3'] } });
    const forgiven = interlockEvidence({
      ...good,
      toolUseIdsSince: ['toolu_F1', 'toolu_X1', 'toolu_F2', 'toolu_X2', 'toolu_F3', 'toolu_X3'],
      checkpoint: first.nextCheckpoint,
    });
    assert.equal(forgiven.ok, true,
      'the hook ran 3 times for 6 observed calls -- it is ALIVE, so the shortfall is a '
      + 'missed call and not death. A rule that only re-anchored on a pass made one lost '
      + 'run end automation for the session.');
    assert.deepEqual(forgiven.forgaveDeficit, { hook_runs_since: 3, tool_uses_since: 6, unpaid: 3 },
      'and the forgiveness is reported, because it resolves permissively');
    assert.deepEqual(forgiven.nextCheckpoint, { preRuns: 6 },
      're-anchored, so the deficit is not re-charged for ever');

    // AND IT IS POSITIVE EVIDENCE, NOT A TOLERANCE. With the hook still dead,
    // more observed calls keep refusing however many arrive.
    const stillDead = interlockEvidence({
      ...good, toolUseIdsSince: Array.from({ length: 50 }, (_, i) => `toolu_Z${i}`), checkpoint: { preRuns: 6 },
    });
    assert.equal(stillDead.ok, false, 'no hook activity, no forgiveness');
    assert.equal(stillDead.code, 'interlock-hook-missed-tool-calls');

    // AN ID PAYS FOR ITS OWN RECORD AND NOTHING ELSE. A run whose record the
    // reader never parses (a line it stepped over) leaves nothing behind that
    // a later record with no run could spend.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 7, recent_ids: ['toolu_BIG'] } });
    const overBig = interlockEvidence({ ...good, toolUseIdsSince: [], checkpoint: { preRuns: 6 } });
    assert.equal(overBig.ok, true, 'setup: the run for the unread record passes');
    const afterBig = interlockEvidence({ ...good, toolUseIdsSince: ['toolu_DEAD'], checkpoint: overBig.nextCheckpoint });
    assert.equal(afterBig.code, 'interlock-hook-missed-tool-calls',
      'a count carried forward would have let the run for toolu_BIG pay for toolu_DEAD');
  });
});

test('#104 G12b a run that lands before its record still pays for it (the 2026-11-13 hold)', () => {
  withScratch('g12b', (fx) => {
    const nonce = bind(fx, { pid: 1202 });
    const good = {
      dir: fx.dir, nonce, sessionId: SESSION, runnerPid: 1202, hookPath: HOOK_PATH,
      hookSha256: crypto.createHash('sha256').update(fs.readFileSync(HOOK_PATH)).digest('hex'),
    };
    // The hook ran for toolu_CAP; its record is still in flush lag. The check
    // in that gap passes and takes its agreement point over the run.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 4, recent_ids: ['toolu_CAP'] } });
    const gap = interlockEvidence({ ...good, toolUseIdsSince: [], checkpoint: { preRuns: 3 } });
    assert.equal(gap.ok, true);
    // The record arrives. The seat is idle: no further run will ever come.
    const arrives = interlockEvidence({ ...good, toolUseIdsSince: ['toolu_CAP'], checkpoint: gap.nextCheckpoint });
    assert.equal(arrives.ok, true,
      'by count this was owed 1, ran 0, and held the clear for eight hours on an idle seat');
    assert.equal(arrives.forgaveDeficit, undefined, 'paid by its own run, not forgiven');

    // The same with the agreement point freshly discarded (a re-baseline): the
    // run is absorbed with the history, and its record is still paid later.
    const rebased = interlockEvidence({ ...good, toolUseIdsSince: ['toolu_HIST'], checkpoint: null });
    assert.equal(rebased.ok, true);
    const late = interlockEvidence({ ...good, toolUseIdsSince: ['toolu_CAP'], checkpoint: rebased.nextCheckpoint });
    assert.equal(late.ok, true, 'recent_ids outlives the agreement point');
    assert.equal(late.forgaveDeficit, undefined);

    // A record with no run in the same span spends nothing: it is unpaid on
    // its own, and the lagging run still pays for its own record.
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 4, recent_ids: [] } });
    const invalid = interlockEvidence({ ...good, toolUseIdsSince: ['toolu_INVALID'], checkpoint: { preRuns: 4 } });
    assert.equal(invalid.code, 'interlock-hook-missed-tool-calls', 'no run since the point: held');
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 5, recent_ids: ['toolu_C'] } });
    const alive = interlockEvidence({ ...good, toolUseIdsSince: ['toolu_INVALID'], checkpoint: { preRuns: 4 } });
    assert.equal(alive.ok, true, 'the hook ran since: alive, the unpaid record is forgiven');
    assert.deepEqual(alive.forgaveDeficit, { hook_runs_since: 1, tool_uses_since: 1, unpaid: 1 });
    const cLands = interlockEvidence({ ...good, toolUseIdsSince: ['toolu_C'], checkpoint: alive.nextCheckpoint });
    assert.equal(cLands.ok, true, 'the run for toolu_C was not spent on toolu_INVALID');
    assert.equal(cLands.forgaveDeficit, undefined);
  });
});

test('#104 G12c the hook remembers the main-loop ids it ran for, bounded, real ids only', () => {
  withScratch('g12c', (fx) => {
    const nonce = bind(fx);
    writeState({ dir: fx.dir, state: emptyState(nonce) });
    const call = (event, id) => runHook({
      payload: hookPayload({ tool_use_id: id, tool_name: 'Read' }),
      event, env: fx.env, pid: 503, processLike: { kill: () => true }, now: () => 0, sleep: () => {},
    });
    call('PreToolUse', 'anon:not-a-record');
    call('PostToolUse', 'anon:not-a-record');
    runHook({
      payload: hookPayload({ tool_use_id: 'toolu_SUBAGENT', tool_name: 'Read', agent_id: 'agent_bg' }),
      event: 'PreToolUse', env: fx.env, pid: 503, processLike: { kill: () => true }, now: () => 0, sleep: () => {},
    });
    call('PostToolUse', 'toolu_SUBAGENT');
    for (let i = 0; i < RECENT_IDS_MAX + 3; i += 1) {
      call('PreToolUse', `toolu_R${i}`);
      call('PostToolUse', `toolu_R${i}`);
    }
    const state = JSON.parse(fs.readFileSync(path.join(fx.dir, STATE_NAME), 'utf8'));
    assert.equal(state.pre_runs, RECENT_IDS_MAX + 5, 'every run counted, anon and subagent too');
    assert.ok(!state.recent_ids.includes('toolu_SUBAGENT'),
      'a subagent call writes to its own transcript: remembered, it only evicts main-loop ids');
    assert.ok(!state.recent_ids.some((id) => id.startsWith('anon:')), 'a synthetic key names no record');
    assert.equal(state.recent_ids.length, RECENT_IDS_MAX, 'bounded');
    assert.equal(state.recent_ids[0], 'toolu_R3', 'oldest dropped first');
    assert.equal(state.recent_ids.at(-1), `toolu_R${RECENT_IDS_MAX + 2}`);
  });
});

test('#104 G13 AGE NEVER RELEASES a pending marker: it renames the hold', () => {
  const state = { ...emptyState(NONCE), pending: { toolu_A: { tool: 'Read', ts: 1000 } } };
  assert.equal(pendingProblem(state, { now: 1500, staleMs: 120000 }).code, 'interlock-permission-pending');
  const old = pendingProblem(state, { now: 1000 + 10 * 60 * 1000, staleMs: 120000 });
  assert.equal(old.code, 'interlock-pending-stale',
    'A HUMAN CAN READ A DIALOG FOR MINUTES. Age cannot tell that from a marker nothing '
    + 'cleared, so it changes the NAME -- which is what lets an operator tell them apart '
    + '-- and both HOLD. An age-based release would be this issue by a timer.');
  assert.equal(pendingProblem({ ...emptyState(NONCE) }), null, 'an empty map is not a problem');
});

test('#104 G14 old binding directories are swept, bounded in age and in count', () => {
  withScratch('g14', (fx) => {
    const root = fx.env.AIGENT_INTERLOCK_DIR;
    const old = path.join(root, 'session-long-gone');
    fs.mkdirSync(old, { recursive: true });
    const ancient = Date.now() - (GATE_STALE_MS + 7 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, ancient / 1000, ancient / 1000);
    const fresh = path.join(root, 'session-recent');
    fs.mkdirSync(fresh, { recursive: true });

    const removed = sweepSessionDirs({
      memRoot: fx.memRoot, keepSessionId: SESSION, env: fx.env, now: Date.now(),
    });
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(old), false, 'the old binding is collected');
    assert.equal(fs.existsSync(fresh), true, 'a recent one is not');
    assert.equal(fs.existsSync(fx.dir), true, 'and never the current binding');
  });
});

test('#104 G15 AN UNREADABLE STATE IS NOT AN EMPTY ONE: a live marker survives it', () => {
  withScratch('g15', (fx) => {
    const nonce = bind(fx, { pid: process.pid });
    // A REAL PERMISSION CHECK IS IN FLIGHT. The previous version of this vector
    // used a fixture whose pending map had nothing to lose, which is why it
    // BLESSED the fail-open instead of catching it: the hook replaced any
    // unsuccessful read with emptyState(), so one transient EBUSY during
    // another call's PreToolUse destroyed this marker WITH ITS DIALOG ON
    // SCREEN, reset the counters, and left all four evidence legs passing and
    // the runner reading ready.
    writeState({
      dir: fx.dir,
      state: {
        ...emptyState(nonce),
        stop_runs: 1,
        pre_runs: 3,
        last_write_at: 500,
        pending: { toolu_A_DIALOG_ON_SCREEN: { tool: 'Read', ts: 100 } },
      },
    });
    let thrown = 0;
    const fsImpl = {
      ...fs,
      readFileSync: (target, ...rest) => {
        if (String(target).endsWith(STATE_NAME) && thrown < 1) {
          thrown += 1;
          const e = new Error('busy'); e.code = 'EBUSY'; throw e;
        }
        return fs.readFileSync(target, ...rest);
      },
    };

    const slept = [];
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_B', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      fsImpl,
      processLike: { kill: () => true },
      now: () => 520,
      sleep: (ms) => slept.push(ms),
      gateBudgetMs: 0,
    });
    assert.equal(verdict.action, 'deny',
      'a state it cannot read is a state it cannot safely add to -- and it must not '
      + 'invent one, because the invented one is empty');
    assert.equal(verdict.code, 'interlock-state-unreadable');

    // THE MARKER SURVIVED, which is the whole point.
    const after = readState({ dir: fx.dir }).state;
    assert.deepEqual(Object.keys(after.pending), ['toolu_A_DIALOG_ON_SCREEN'],
      'the live marker is still there');
    assert.equal(after.pre_runs, 3, 'and the counters were not reset');
    assert.equal(after.last_write_at, 500,
      'including last_write_at -- an invented state carried null, so the same '
      + 'invocation also skipped the drain');

    // A CLEARING EVENT THAT CANNOT READ MUST NOT CLOBBER EITHER. Failing to
    // clear only holds automatic writes, which is already the safe direction.
    thrown = 0;
    const sweep = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A_DIALOG_ON_SCREEN' }),
      event: 'PostToolUse',
      env: fx.env,
      fsImpl,
      processLike: { kill: () => true },
      now: () => 530,
      sleep: () => {},
      gateBudgetMs: 0,
    });
    assert.equal(sweep.action, 'allow', 'it does not deny');
    assert.equal(sweep.code, 'interlock-state-unreadable', 'but it says it could not clear');
    assert.deepEqual(Object.keys(readState({ dir: fx.dir }).state.pending),
      ['toolu_A_DIALOG_ON_SCREEN'], 'and the marker is intact');

    // LIVENESS: a state file that is genuinely MISSING is still initialised,
    // because that is the ordinary first-invocation case.
    fs.rmSync(path.join(fx.dir, STATE_NAME), { force: true });
    const fresh = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_C' }),
      event: 'PreToolUse',
      env: fx.env,
      processLike: { kill: () => true },
      now: () => 540,
      sleep: () => {},
      gateBudgetMs: 0,
    });
    assert.equal(fresh.action, 'allow', 'missing is not unreadable');
    assert.deepEqual(Object.keys(readState({ dir: fx.dir }).state.pending), ['toolu_C']);
  });
});

test('#104 G15b a state whose SHAPE is wrong is unreadable, not empty', () => {
  withScratch('g15b', (fx) => {
    bind(fx, { pid: process.pid });
    // A `pending` that is not an object would enumerate to zero keys, which
    // reads as "no permission check" -- so the shape check matters as much as
    // the parse, and the verdict has to be a refusal, not a replacement.
    fs.writeFileSync(path.join(fx.dir, STATE_NAME), '{"pending": "not an object"}');
    const read = readState({ dir: fx.dir });
    assert.equal(read.ok, false);
    assert.equal(read.code, 'interlock-state-unreadable');
    assert.equal(read.state, null);
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_A' }),
      event: 'PreToolUse',
      env: fx.env,
      processLike: { kill: () => true },
      now: () => 1,
      sleep: () => {},
      gateBudgetMs: 0,
    });
    assert.equal(verdict.action, 'deny', 'refused, not replaced');
    assert.equal(verdict.code, 'interlock-state-unreadable');
  });
});

test('#104 G16 a session id that could escape the interlock root resolves to nothing', () => {
  withScratch('g16', (fx) => {
    for (const hostile of ['../..', 'a/b', 'a\\b', '', '.'.repeat(200)]) {
      const resolved = sessionDir({ memRoot: fx.memRoot, sessionId: hostile, env: fx.env });
      assert.equal(resolved, null, `a session id of ${JSON.stringify(hostile)} names no directory`);
    }
    assert.notEqual(sessionDir({ memRoot: fx.memRoot, sessionId: SESSION, env: fx.env }), null);
  });
});

test('#104 G17 the proof file is written atomically and is readable by the other side', () => {
  withScratch('g17', (fx) => {
    bind(fx, { pid: 1701 });
    const raw = fs.readFileSync(path.join(fx.dir, PROOF_NAME), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),
      ['created_at', 'hook_path', 'hook_sha256', 'nonce', 'runner_pid', 'session_id']);
    assert.deepEqual(fs.readdirSync(fx.dir).filter((f) => f.includes('.tmp-')), [],
      'no temp file is left behind -- the rename is the commit');
  });
});

// ─── NO PERMANENT TOOL OUTAGE ───────────────────────────────────────────────
//
// The interlock denying is correct. A denial no human can lift is a different
// thing: a permanent tool outage, which nobody agreed to. These vectors are
// the proof rather than the assurance -- first the enumeration of every state
// that denies and which of them nothing can clear, then each deliberate path.

const ALIVE = { kill: () => true };
const DEAD = { kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } };
// EXACTLY ONE pid is gone. A blanket DEAD stub is not the shape of a dead GATE
// HOLDER: it also reports the proof's runner_pid dead, which is manual recovery
// path 1 and short-circuits the gate entirely. A holder that died while the
// runner lives on -- a hard kill mid-span, or a stolen-from predecessor -- is
// two different pids, so the stub has to distinguish them.
const deadOnly = (gone) => ({
  kill: (pid) => {
    if (pid === gone) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
    return true;
  },
});

// Plant a gate with chosen contents, bypassing acquireGate, so a vector can
// build states acquireGate would never create for itself.
function plantGate(fx, record) {
  fs.writeFileSync(path.join(fx.dir, GATE_NAME), JSON.stringify(record));
}

// ─── THE BRAND (final review, item 1) ──────────────────────────────────────
// A row may only be built from a verdict THIS SUITE WATCHED HAPPEN. The
// previous guard checked that the value was verdict-SHAPED -- a string `action`
// drawn from the three legal values -- which a fabricated literal satisfies
// perfectly, and the reviewer proved it by adding a synthetic deny code to the
// internal list and satisfying the derived coverage requirement with nothing but
// `note('T99', { action: 'deny', code: 'interlock-brand-new-deny' }, false)`.
// G18 passed. So the hole had narrowed from "one row does it" to "any future row
// can", and a coverage instrument that REPORTS a guarantee it does not have is
// worse than no instrument.
//
// Only the helpers that actually invoke the shipped hook stamp this symbol, so
// a literal cannot carry it and `note()` refuses anything without it. The one
// legitimate way to record a code without observing it stays `declareUnreached`,
// which says so in the row and is counted separately.
const OBSERVED = Symbol('observed-by-running-the-shipped-hook');

// Every call that reaches the real runHook goes through here or brands its own
// result. `brand` is the only writer of the symbol.
function brand(verdict) {
  return Object.assign(verdict, { [OBSERVED]: true });
}

function askPre(fx, options = {}) {
  return brand(runHook({
    payload: {
      session_id: SESSION,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: options.id || 'toolu_ASK',
      cwd: path.join(fx.base, 'project'),
    },
    event: 'PreToolUse',
    env: fx.env,
    pid: 7777,
    processLike: options.processLike || ALIVE,
    now: options.now || (() => 1000000),
    sleep: () => {},
    gateBudgetMs: options.budget === undefined ? 40 : options.budget,
    ...(options.fsImpl ? { fsImpl: options.fsImpl } : {}),
  }));
}

function writeRelease(fx, body) {
  fs.writeFileSync(path.join(fx.dir, RELEASE_NAME),
    typeof body === 'string' ? body : JSON.stringify(body));
}

test('#104 G18 THE ENUMERATION: every state that denies a tool call, and which ones need a human', () => {
  // Enumerated by REACHING each state against the shipped hook, not by reading
  // it. The point of the table is the last column: a state nothing can clear is
  // a permanent outage unless a deliberate path exists for it, so this vector
  // is what makes "no permanent outage" falsifiable.
  const seen = [];
  // ─── A ROW MUST RECORD WHAT IT OBSERVED ──────────────────────────────────
  // `note()` used to take whatever object it was handed, and one row handed it
  // a LITERAL: `note('T12', { action: 'deny', code: 'interlock-hook-threw' },
  // false)` next to an assertion that could not fail (`threw || true`). That
  // row then counted toward the deny total, the no-self-recovery list AND the
  // derived coverage set on the strength of a hand-written string -- which is
  // the exact failure mode the derived check was built to eliminate, reappearing
  // one level up. The guarantee read stronger than it was.
  //
  // So a row now comes from a real verdict object, and the only way to record a
  // code WITHOUT observing it is `declareUnreached`, which says so in the row
  // and is counted separately everywhere.
  const note = (id, verdict, selfClears) => {
    // NOT "is this verdict-shaped" -- that is what a literal satisfies. The
    // question is "did this suite watch the shipped hook produce it", and only
    // brand() can answer yes.
    assert.equal(verdict?.[OBSERVED], true,
      `${id}: note() takes a verdict produced by running the shipped hook. A `
      + 'literal is not a row -- use declareUnreached(id, code, why) if the code '
      + 'genuinely cannot be reached from runHook.');
    assert.ok(['deny', 'allow', 'inert'].includes(verdict.action), `${id}: ${verdict.action}?`);
    seen.push({
      id, action: verdict.action, code: verdict.code, selfClears, observed: true,
    });
  };
  const declareUnreached = (id, code, why) => seen.push({
    id, action: null, code, selfClears: false, observed: false, why,
  });

  // T1 the runner mid-write: a live, young holder. Clears when it releases.
  withScratch('t1', (fx) => {
    bind(fx);
    const held = acquireGate({ dir: fx.dir, side: 'runner', nonce: NONCE, pid: 101, processLike: ALIVE, now: () => 1000000 });
    const denied = askPre(fx);
    assert.equal(denied.action, 'deny');
    assert.equal(denied.code, 'interlock-gate-busy');
    releaseGate(held.handle);
    assert.equal(askPre(fx).action, 'allow', 'T1 clears when the holder releases');
    note('T1', denied, true);
  });

  // T2/T3 a dead holder and a past-binding holder are stolen at once.
  withScratch('t2', (fx) => {
    bind(fx);
    plantGate(fx, { side: 'runner', pid: 999999, ts: 1000000, nonce: NONCE, token: 'x' });
    const v = askPre(fx, { processLike: deadOnly(999999) });
    assert.equal(v.action, 'allow', 'T2 pid-liveness steal is immediate');
    note('T2', v, true);
  });
  withScratch('t3', (fx) => {
    bind(fx);
    plantGate(fx, { side: 'runner', pid: 101, ts: 1000000, nonce: 'a-previous-binding', token: 'x' });
    const v = askPre(fx, { processLike: ALIVE });
    assert.equal(v.action, 'allow', 'T3 nonce steal is immediate');
    note('T3', v, true);
  });

  // T4 a hard kill whose pid was RECYCLED to another live process. Age clears
  // it, which is why the age clause exists at all.
  withScratch('t4', (fx) => {
    bind(fx);
    plantGate(fx, { side: 'runner', pid: 101, ts: 1000000, nonce: NONCE, token: 'x' });
    const young = askPre(fx, { now: () => 1000000 + 10 });
    assert.equal(young.action, 'deny', 'not stolen from a live pid immediately');
    assert.equal(askPre(fx, { now: () => 1000000 + GATE_STALE_MS + 1 }).action, 'allow',
      'T4 clears on age');
    note('T4', young, true);
  });

  // T5 the age clause is guarded on Number.isFinite(ts). Without a usable
  // timestamp there is NO self-recovery -- the mirror image of the age clause
  // deliberately not being a "give up and allow" timer.
  withScratch('t5', (fx) => {
    bind(fx);
    plantGate(fx, { side: 'runner', pid: 101, ts: 'not-a-number', nonce: NONCE, token: 'x' });
    const v = askPre(fx);
    assert.equal(v.action, 'deny');
    assert.equal(askPre(fx, { now: () => 1000000 + 86400000 }).action, 'deny',
      'T5 HAS NO SELF-RECOVERY: a day of waiting changes nothing');
    note('T5', v, false);
  });

  // T6 a clock behind the gate stamp makes now-ts negative for ever.
  withScratch('t6', (fx) => {
    bind(fx);
    plantGate(fx, { side: 'runner', pid: 101, ts: 9000000, nonce: NONCE, token: 'x' });
    const v = askPre(fx, { now: () => 1000000 });
    assert.equal(v.action, 'deny');
    assert.equal(askPre(fx, { now: () => 1000001 }).action, 'deny',
      'T6 HAS NO SELF-RECOVERY while the clock is behind: the age comparison '
      + 'cannot exceed GATE_STALE_MS');
    note('T6', v, false);
  });

  // T7 a directory at the gate path is refused on purpose: not contention, and
  // waiting cannot turn a directory into a lock file.
  withScratch('t7', (fx) => {
    bind(fx);
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));
    const v = askPre(fx);
    assert.equal(v.action, 'deny');
    assert.equal(v.code, 'interlock-gate-path-unusable');
    assert.equal(askPre(fx, { now: () => 1000000 + 86400000 }).code, 'interlock-gate-path-unusable',
      'T7 HAS NO SELF-RECOVERY, by design');
    note('T7', v, false);
  });

  // T8/T9 the filesystem. No code here repairs one.
  withScratch('t8', (fx) => {
    bind(fx);
    const fsImpl = {
      ...fs,
      openSync: (target, flags) => {
        if (String(target).endsWith(GATE_NAME)) { const e = new Error('ro'); e.code = 'EROFS'; throw e; }
        return fs.openSync(target, flags);
      },
    };
    const v = askPre(fx, { fsImpl });
    assert.equal(v.action, 'deny');
    assert.equal(v.code, 'interlock-gate-open-failed');
    note('T8', v, false);
  });
  withScratch('t9', (fx) => {
    bind(fx);
    const fsImpl = {
      ...fs,
      openSync: (target, flags) => {
        if (String(target).includes(STATE_NAME)) { const e = new Error('ro'); e.code = 'EROFS'; throw e; }
        return fs.openSync(target, flags);
      },
    };
    const v = askPre(fx, { fsImpl });
    assert.equal(v.action, 'deny');
    assert.equal(v.code, 'interlock-state-write-failed');
    note('T9', v, false);
  });

  // T10 a full pending map clears at the turn's Stop.
  withScratch('t10', (fx) => {
    bind(fx);
    const pending = {};
    for (let i = 0; i < PENDING_MAX; i += 1) pending[`toolu_${i}`] = { tool: 'Read', ts: 0 };
    writeState({ dir: fx.dir, state: { ...emptyState(NONCE), stop_runs: 1, pending } });
    const v = askPre(fx, { id: 'toolu_ONE_TOO_MANY' });
    assert.equal(v.action, 'deny');
    assert.equal(v.code, 'interlock-pending-overflow');
    runHook({
      payload: { session_id: SESSION, hook_event_name: 'Stop', cwd: path.join(fx.base, 'project') },
      event: 'Stop', env: fx.env, processLike: ALIVE, now: () => 1, sleep: () => {}, gateBudgetMs: 0,
    });
    assert.equal(askPre(fx, { id: 'toolu_AFTER_SWEEP' }).action, 'allow',
      'T10 clears at the Stop sweep');
    // (the Stop above is a fixture action, not a row; only the askPre verdicts
    // in this block are branded, and only `v` becomes the row)
    note('T10', v, true);
  });

  // T11 an UNREADABLE state file. Added by the F3 fix: denying instead of
  // inventing a state is right, and the consequence is that nothing repairs a
  // corrupt state.json -- the clearing events deliberately refuse to clobber
  // it. A no-self-recovery deny, and it was absent from this list for a whole
  // commit, which is why the row set is now derived from the code below.
  withScratch('t11', (fx) => {
    bind(fx);
    fs.writeFileSync(path.join(fx.dir, STATE_NAME), '{not json');
    const v = askPre(fx);
    assert.equal(v.action, 'deny');
    assert.equal(v.code, 'interlock-state-unreadable');
    assert.equal(askPre(fx, { now: () => 1000000 + 86400000 }).code, 'interlock-state-unreadable',
      'T11 HAS NO SELF-RECOVERY: the clearing events refuse to clobber it, by design');
    note('T11', v, false);
  });

  // T12 `interlock-hook-threw` -- DECLARED UNREACHED, not faked. The previous
  // version of this row injected a throwing `statSync`, asserted `threw ||
  // true` (which cannot fail), and handed note() a hard-coded deny. The
  // injection does not actually make runHook throw -- every fsImpl call site in
  // it is wrapped, and the verdict comes back `allow` -- so the row was pure
  // decoration contributing to three different guarantees.
  //
  // The honest position: this code is produced by `hookMain`'s catch, never by
  // runHook, which is asserted below rather than asserted about. It is retained
  // in the enumeration because hookMain maps ANY throw to it, so it is a real
  // deny state of the hook as installed -- just not one reachable through the
  // function this suite can call.
  withScratch('t12', (fx) => {
    bind(fx);
    const fsImpl = { ...fs, statSync: () => { throw new Error('a defect, not an errno'); } };
    const verdict = askPre(fx, { fsImpl });
    assert.notEqual(verdict.code, 'interlock-hook-threw',
      'runHook does not produce this code -- if it ever does, give this row a real '
      + 'observation instead of a declaration');
    declareUnreached('T12', 'interlock-hook-threw',
      'produced only by hookMain catch; runHook wraps every fsImpl call site');
  });

  // T13/T14 a call that cannot be ATTRIBUTED to a session. These deny only on a
  // seat that is demonstrably managed; on an unmanaged one they are inert, which
  // is the N3 fix and is asserted in G24.
  withScratch('t13', (fx) => {
    bind(fx);
    const v = brand(runHook({
      payload: { hook_event_name: 'PreToolUse', cwd: path.join(fx.base, 'project') },
      event: 'PreToolUse', env: fx.env, processLike: ALIVE, now: () => 1, sleep: () => {},
    }));
    assert.equal(v.action, 'deny');
    assert.equal(v.code, 'interlock-no-session-id');
    note('T13', v, false);
  });
  // T15 the interlock DIRECTORY itself cannot be created. Same class as T8/T9 --
  // a filesystem fault no code here repairs -- and it was uncovered until the
  // derived check below pointed at it, which is the instrument working.
  withScratch('t15', (fx) => {
    bind(fx);
    const fsImpl = {
      ...fs,
      mkdirSync: (target, ...rest) => {
        if (String(target).includes('interlock')) { const e = new Error('ro'); e.code = 'EROFS'; throw e; }
        return fs.mkdirSync(target, ...rest);
      },
    };
    const v = askPre(fx, { fsImpl });
    assert.equal(v.action, 'deny');
    assert.equal(v.code, 'interlock-gate-dir-failed');
    note('T15', v, false);
  });

  // T14 WAS ATTEMPTED AND DOES NOT EXIST. `interlock-dir-unresolved` cannot be
  // a denial: denying requires `anyManagedSession` to be true, which requires a
  // resolvable interlock root, and with a resolvable root `sessionDir` returns
  // null only for a session id `SESSION_ID_OK` has already rejected. It is an
  // INERT code, and the derived coverage check below documents that by not
  // listing it.

  // THE CLAIM, asserted rather than narrated -- and counted over OBSERVED rows
  // only, so a declared-unreached row cannot inflate it.
  const observed = seen.filter((r) => r.observed);
  const declared = seen.filter((r) => !r.observed);
  assert.equal(observed.filter((r) => r.action === 'deny').length, 11,
    '11 of the 13 OBSERVED states deny');
  assert.deepEqual(declared.map((r) => r.id), ['T12'],
    'exactly one row is a declaration rather than an observation, and it says why');
  assert.ok(declared.every((r) => typeof r.why === 'string' && r.why.length > 0),
    'and a declaration without a reason is not a row');
  assert.deepEqual(seen.filter((r) => r.selfClears === false).map((r) => r.id),
    ['T5', 'T6', 'T7', 'T8', 'T9', 'T11', 'T12', 'T13', 'T15'],
    'the states nothing can clear are exactly these. If this list GROWS, a new '
    + 'permanent-outage state has been introduced and needs a deliberate path. If it '
    + 'SHRINKS, something started self-clearing, and that has to be a decision rather '
    + 'than a side effect -- a state that quietly began allowing is the fail-open.');

  // ─── AND THE INSTRUMENT ITSELF, which is the real lesson ────────────────
  // The assertion above exists so that the list growing is caught. It grew --
  // `interlock-state-unreadable` was added by the F3 fix -- AND THE VECTOR DID
  // NOT FIRE, because a vector that only builds the rows its author thought of
  // cannot notice a row its author did not. So the coverage requirement is now
  // derived from the SHIPPED deny codes rather than from this table: a new way
  // for PreToolUse to deny, with no row here, is a test failure.
  const covered = new Set(seen.map((r) => r.code));
  const uncovered = ALL_PRE_TOOL_USE_DENY_CODES.filter((code) => !covered.has(code));
  assert.deepEqual(uncovered, [],
    'every way PreToolUse can deny needs a row in this enumeration, with its '
    + 'self-recovery answered. Uncovered codes mean the table has fallen behind the '
    + 'code again -- add the row and its recovery, do not widen this assertion.');
});

test('#104 G19 MANUAL PATH 1: a proof whose runner is gone makes even an unclearable wedge inert', () => {
  withScratch('g19', (fx) => {
    // T7: no self-recovery, and the filesystem may be exactly what is broken,
    // so the recovery that needs NO WRITE is the only one that always applies.
    bind(fx, { pid: 999999 });
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));

    const gone = askPre(fx, { processLike: DEAD });
    assert.equal(gone.action, 'inert',
      'no managed runner means no automatic keystroke, so the denial has no subject');
    assert.equal(gone.code, 'interlock-runner-gone');
    assert.notEqual(gone.action, 'deny', 'the operator can proceed');
    assert.equal(fs.existsSync(path.join(fx.dir, STATE_NAME)), false,
      'and nothing is recorded: there is nothing left to protect');

    // AND IT IS NOT A WAY TO SHAKE THE INTERLOCK OFF. With the runner alive the
    // same wedge still denies -- which is also what pid recycling looks like,
    // and therefore why this is not the guaranteed path (G20 is).
    const alive = askPre(fx, { processLike: ALIVE });
    assert.equal(alive.action, 'deny', 'a LIVE runner keeps the protection armed');
    assert.equal(alive.code, 'interlock-gate-path-unusable');
  });
});

test('#104 G20 MANUAL PATH 2: the release lifts an unclearable wedge, takes no gate, records nothing', () => {
  withScratch('g20', (fx) => {
    bind(fx);
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));          // T7, no self-recovery
    assert.equal(askPre(fx).action, 'deny', 'setup: wedged, and no waiting fixes it');
    // Snapshot AFTER the setup denial, because a denial legitimately records
    // the invocation it was (F4). What this vector is about is that the RELEASE
    // path itself writes nothing.
    const stateAfterDeny = (() => {
      try { return fs.readFileSync(path.join(fx.dir, STATE_NAME), 'utf8'); } catch { return null; }
    })();

    writeRelease(fx, {
      release: RELEASE_LITERAL,
      session_id: SESSION,
      reason: 'gate path became a directory after a disk event',
    });

    const v = askPre(fx);
    assert.equal(v.action, 'allow', '(a) the operator can proceed');
    assert.equal(v.code, 'interlock-released-manually');
    assert.match(String(v.detail?.reason), /disk event/, 'and the operator reason is carried');

    // NO GATE -- the gate is the wedge. NO STATE -- nothing left to protect.
    // NO PERMISSION OPINION -- the host's own check decides the call, so (c)
    // permission prompting is untouched by the recovery.
    const stateNow = (() => {
      try { return fs.readFileSync(path.join(fx.dir, STATE_NAME), 'utf8'); } catch { return null; }
    })();
    assert.equal(stateNow, stateAfterDeny, 'the release itself recorded nothing');
    assert.ok(fs.statSync(path.join(fx.dir, GATE_NAME)).isDirectory(),
      'the wedge is untouched: a release works AROUND it rather than repairing it');

    // The clearing events are released too, so nothing accumulates behind it.
    for (const event of ['PostToolUse', 'Stop']) {
      const other = runHook({
        payload: { session_id: SESSION, hook_event_name: event, tool_use_id: 'toolu_ASK', cwd: path.join(fx.base, 'project') },
        event, env: fx.env, processLike: ALIVE, now: () => 1, sleep: () => {}, gateBudgetMs: 0,
      });
      assert.notEqual(other.action, 'deny', `${event} is not a denial either`);
    }
  });
});

test('#104 G21 WHAT IS NOT A RELEASE: every near-miss keeps denying, and says why', () => {
  const nearMisses = [
    ['an empty file (touch)', ''],
    ['a bare object', '{}'],
    ['unparseable', '{not json'],
    ['the wrong literal', JSON.stringify({ release: 'yes', session_id: SESSION, reason: 'r' })],
    ['no reason', JSON.stringify({ release: RELEASE_LITERAL, session_id: SESSION })],
    ['a blank reason', JSON.stringify({ release: RELEASE_LITERAL, session_id: SESSION, reason: '   ' })],
    ['another seat', JSON.stringify({ release: RELEASE_LITERAL, session_id: 'some-other-seat', reason: 'r' })],
    ['no session', JSON.stringify({ release: RELEASE_LITERAL, reason: 'r' })],
  ];
  for (const [label, content] of nearMisses) {
    withScratch('g21', (fx) => {
      bind(fx);
      fs.mkdirSync(path.join(fx.dir, GATE_NAME));
      writeRelease(fx, content);
      const v = askPre(fx);
      assert.equal(v.action, 'deny',
        `${label}: a near-miss must NOT release -- an accidental release is the `
        + 'fail-open this mechanism would otherwise be');
      // AND IT SAYS SO on the call still being denied. A half-written file that
      // silently did nothing would leave an operator believing they recovered.
      assert.ok(
        v.detail?.release === 'interlock-release-malformed'
        || v.detail?.release === 'interlock-release-foreign-session',
        `${label}: the denial names why it did not take, got ${JSON.stringify(v.detail?.release)}`,
      );
      assert.equal(manualRelease({ dir: fx.dir, sessionId: SESSION }).ok, false, `${label}: not a release`);
    });
  }
  // Liveness: the real shape, under the session it names, does release.
  withScratch('g21-ok', (fx) => {
    bind(fx);
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));
    writeRelease(fx, { release: RELEASE_LITERAL, session_id: SESSION, reason: 'the deliberate one' });
    assert.equal(askPre(fx).code, 'interlock-released-manually');
  });
});

test('#104 G22 the --release subcommand is the deliberate act, and refuses to guess', () => {
  withScratch('g22', (fx) => {
    bind(fx);
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));
    const env = { ...fx.env, AIGENT_ROOT: path.join(fx.base, 'project') };

    // NO DEFAULTS, either side. A release with no reason is not auditable; one
    // with no session id would have to guess which seat to give up on.
    assert.equal(releaseMain([], { env }), 2, 'no arguments: refused');
    assert.equal(releaseMain([SESSION], { env }), 2, 'no reason: refused');
    assert.equal(releaseMain(['', 'a reason'], { env }), 2, 'no session: refused');
    assert.equal(releaseMain(['../escape', 'a reason'], { env }), 2, 'a traversing id: refused');
    assert.equal(fs.existsSync(path.join(fx.dir, RELEASE_NAME)), false, 'and nothing was written');

    assert.equal(releaseMain([SESSION, 'operator', 'gave', 'up', 'on', 'automation'], { env }), 0);
    const written = JSON.parse(fs.readFileSync(path.join(fx.dir, RELEASE_NAME), 'utf8'));
    assert.equal(written.release, RELEASE_LITERAL);
    assert.equal(written.session_id, SESSION);
    assert.equal(written.reason, 'operator gave up on automation');
    assert.ok(typeof written.released_at === 'string' && written.released_at.length > 0,
      'and when, so the file and the log agree');

    // The only thing that writes a release is the only thing that reads one, so
    // the two halves cannot drift.
    assert.equal(askPre(fx).code, 'interlock-released-manually');
  });
});

test('#104 G23 the denial an operator actually reads names both paths and the trade', () => {
  withScratch('g23', (fx) => {
    bind(fx);
    fs.mkdirSync(path.join(fx.dir, GATE_NAME));
    const reason = denyReasonFor(askPre(fx).code, askPre(fx).detail);
    assert.match(reason, /interlock-gate-path-unusable/, 'the state');
    assert.match(reason, /stop the managed runner/, 'the path that needs no write');
    assert.match(reason, /--release/, 'the guaranteed path');
    assert.match(reason, /automatic runner input DISABLED/,
      'what the operator is trading, so a release is an informed act');
    assert.match(reason, /permission prompting intact/, 'and what it is NOT trading');
  });
});

test('#104 G24 F7: "the hook ran and protected nothing" is not an allowed outcome', () => {
  withScratch('g24', (fx) => {
    bind(fx, { pid: process.pid });
    // BOTH of these are reachable with no filesystem fault at all: readStdin()
    // swallows its error and yields {}, and a renamed or absent `session_id`
    // does the same. Both used to be `inert` -> exit 0 -> the tool call
    // proceeds with NO marker, silently. For the event that precedes the
    // dialog that is a fail-open.
    //
    // The event name is what makes the difference, and it comes from the argv
    // the template now passes -- independently of the payload that could not
    // be read.
    const noSession = runHook({
      payload: { hook_event_name: 'PreToolUse', cwd: path.join(fx.base, 'project') },
      event: 'PreToolUse',
      env: fx.env,
      processLike: { kill: () => true },
      now: () => 1,
      sleep: () => {},
    });
    assert.equal(noSession.action, 'deny',
      'a PreToolUse that cannot name its session cannot protect it either');
    assert.equal(noSession.code, 'interlock-no-session-id');

    const noPayload = runHook({
      payload: {},
      event: 'PreToolUse',
      env: fx.env,
      processLike: { kill: () => true },
      now: () => 1,
      sleep: () => {},
    });
    assert.equal(noPayload.action, 'deny', 'an unreadable payload is not an all-clear');

    // THE CLEARING EVENTS STAY INERT. Failing to clear only holds automatic
    // writes, which is already the safe direction, so denying there would cost
    // liveness and buy nothing.
    for (const event of ['PostToolUse', 'Stop']) {
      const verdict = runHook({
        payload: {}, event, env: fx.env, processLike: { kill: () => true },
        now: () => 1, sleep: () => {},
      });
      assert.notEqual(verdict.action, 'deny', `${event} does not deny on a bad payload`);
    }

    // AND AN UNRECOGNISED ARGV DOES NOT MASQUERADE AS AN EVENT.
    assert.equal(INTERLOCK_EVENTS.has('PreToolUse'), true);
    assert.equal(INTERLOCK_EVENTS.has('--release'), false,
      'so the release subcommand can never be mistaken for an event name');
  });
});

test('#104 G24b N3: an UNMANAGED seat is never denied, however little the hook can tell', () => {
  withScratch('g24b', (fx) => {
    // NO proof.json anywhere: nothing on this install is managed. The denials
    // above are right for a managed seat and WRONG for every other one, which
    // is most of them -- and denying before `readProof` broke the rule the
    // whole unit rests on. An unmanaged seat with the hook wired got every tool
    // call refused, was told "A managed runner owns this seat's composer"
    // (false), and had no recovery except editing settings.json from outside
    // Claude Code: the permanent tool outage this feature exists to prevent,
    // inside the feature itself.
    assert.equal(anyManagedSession({ memRoot: fx.memRoot, env: fx.env }), false,
      'setup: nothing here is managed');
    for (const payload of [
      { hook_event_name: 'PreToolUse', cwd: path.join(fx.base, 'project') },
      {},
      { session_id: '../escape', hook_event_name: 'PreToolUse', cwd: path.join(fx.base, 'project') },
    ]) {
      const v = runHook({
        payload, event: 'PreToolUse', env: fx.env,
        processLike: { kill: () => true }, now: () => 1, sleep: () => {},
      });
      assert.equal(v.action, 'inert',
        `FIRST RED: an unmanaged seat must not have its tool calls denied by a runner `
        + `that is not there (payload ${JSON.stringify(payload).slice(0, 60)})`);
      assert.equal(v.detail?.managed, false, 'and it says so, rather than claiming a runner');
    }

    // THE SAME PAYLOADS ON A MANAGED SEAT STILL DENY. The fix narrows the
    // denial to seats that have something to protect; it does not remove it.
    bind(fx, { pid: process.pid });
    assert.equal(anyManagedSession({ memRoot: fx.memRoot, env: fx.env }), true);
    const managed = runHook({
      payload: { hook_event_name: 'PreToolUse', cwd: path.join(fx.base, 'project') },
      event: 'PreToolUse', env: fx.env,
      processLike: { kill: () => true }, now: () => 1, sleep: () => {},
    });
    assert.equal(managed.action, 'deny', 'a managed seat it cannot attribute is still refused');
    assert.equal(managed.detail?.managed, true);
  });
});

test('#104 G25 F8: a settled marker is really deleted, not only discounted', () => {
  withScratch('g25', (fx) => {
    const nonce = bind(fx, { pid: process.pid });
    writeState({
      dir: fx.dir,
      state: {
        ...emptyState(nonce), stop_runs: 1, pre_runs: 1,
        pending: { toolu_SETTLED: { tool: 'Read', ts: 100 }, toolu_LIVE: { tool: 'Read', ts: 100 } },
      },
    });
    // The read-side discount is what makes the VERDICT correct immediately.
    const settled = new Set(['toolu_SETTLED']);
    const problem = pendingProblem(readState({ dir: fx.dir }).state, { now: 200, settled });
    assert.equal(problem.code, 'interlock-permission-pending', 'the live one still holds');
    assert.deepEqual(problem.detail.tool_use_ids, ['toolu_LIVE'],
      'and the settled one is discounted, by id');
    // Both settled -> no problem at all.
    assert.equal(
      pendingProblem(readState({ dir: fx.dir }).state, {
        now: 200, settled: new Set(['toolu_SETTLED', 'toolu_LIVE']),
      }),
      null,
    );
    // The DELETION is the runner's job, under the gate, and is covered by the
    // runner-side vectors; what matters here is that the discount is an id
    // filter and not a count, so it cannot release the wrong marker.
    const wrongId = pendingProblem(readState({ dir: fx.dir }).state, {
      now: 200, settled: new Set(['toolu_SOMETHING_ELSE']),
    });
    assert.equal(wrongId.detail.pending, 2, 'an unrelated settlement discounts nothing');
  });
});

test('#104 G26 N2: a gate-busy denial does not touch state.json AT ALL', () => {
  withScratch('g26', (fx) => {
    const nonce = bind(fx, { pid: process.pid });
    // A LIVE DIALOG'S MARKER and a drain stamp, both recorded by the party that
    // holds the gate. Pre-fix, the denial path ran an UNGATED whole-state
    // read-modify-write to count itself as an invocation -- its comment claimed
    // "the only field it touches is a counter", which was false -- and
    // interleaving the holder's own write between its read and its write
    // DESTROYED THIS MARKER, after which the runner read ready with the dialog
    // on screen. It could also clobber `last_write_at`, losing the drain stamp
    // for a byte in flight, or resurrect a cleared marker.
    writeState({
      dir: fx.dir,
      state: {
        ...emptyState(nonce), stop_runs: 1, pre_runs: 1, last_write_at: 500,
        pending: { toolu_A_LIVE_DIALOG: { tool: 'Read', ts: 100 } },
      },
    });
    const before = fs.readFileSync(path.join(fx.dir, STATE_NAME), 'utf8');
    const blocker = acquireGate({
      dir: fx.dir, side: 'runner', nonce, pid: process.pid, processLike: { kill: () => true },
    });
    assert.equal(blocker.ok, true, 'setup: another party holds the gate');

    // Counted rather than inferred: every open of the state file is recorded,
    // so "did not write" cannot be satisfied by writing the same bytes back.
    let opens = 0;
    const fsImpl = {
      ...fs,
      openSync: (target, ...rest) => {
        if (String(target).includes(STATE_NAME)) opens += 1;
        return fs.openSync(target, ...rest);
      },
    };
    const verdict = runHook({
      payload: hookPayload({ tool_use_id: 'toolu_B', tool_name: 'Read' }),
      event: 'PreToolUse',
      env: fx.env,
      fsImpl,
      pid: 999,
      processLike: { kill: () => true },
      now: () => 600,
      sleep: () => {},
      gateBudgetMs: 20,
    });
    assert.equal(verdict.action, 'deny');
    assert.equal(verdict.code, 'interlock-gate-busy');

    assert.equal(opens, 0,
      'FIRST RED: the denial opened the state file it does not hold the gate for. '
      + 'STATE.JSON IS WRITTEN ONLY UNDER THE GATE, without exception.');
    assert.equal(fs.readFileSync(path.join(fx.dir, STATE_NAME), 'utf8'), before,
      'and the file is byte-identical');
    const after = readState({ dir: fx.dir }).state;
    assert.ok(Object.hasOwn(after.pending, 'toolu_A_LIVE_DIALOG'), 'the live marker survived');
    assert.equal(after.last_write_at, 500, 'and so did the drain stamp');
    releaseGate(blocker.handle);
  });
});

test('#104 G27 F-B: T13 has a manual recovery -- a managed session needs a LIVE runner', () => {
  withScratch('g27', (fx) => {
    const nonce = bind(fx, { pid: process.pid });
    writeState({ dir: fx.dir, state: { ...emptyState(nonce), stop_runs: 1, pre_runs: 1 } });
    const DEAD = 999999;
    const deadOnly = (gone) => ({
      kill: (pid) => {
        if (pid === gone) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
        return true;
      },
    });
    const askUnnameable = (processLike) => runHook({
      payload: { hook_event_name: 'PreToolUse', cwd: path.join(fx.base, 'project') },
      event: 'PreToolUse', env: fx.env, processLike, now: () => 1, sleep: () => {},
    });

    // A managed seat whose call cannot be attributed. Denying is right.
    const denied = askUnnameable({ kill: () => true });
    assert.equal(denied.action, 'deny');
    assert.equal(denied.code, 'interlock-no-session-id');
    assert.equal(denied.detail?.managed, true);

    // PATH 2 CANNOT REACH IT, and that is inherent rather than a defect: the
    // release is scoped to a session directory the hook has just failed to
    // name, so there is nowhere for it to be read from.
    fs.writeFileSync(path.join(fx.dir, RELEASE_NAME), JSON.stringify({
      release: RELEASE_LITERAL, session_id: SESSION, reason: 'try to recover',
    }));
    assert.equal(askUnnameable({ kill: () => true }).action, 'deny',
      'a session-scoped release cannot lift a denial that could not name the session');

    // PATH 1 MUST, and it did not. `anyManagedSession` tested only that a
    // proof FILE existed, never that its runner was alive -- so stopping the
    // runner left the denial standing and T13 had NO manual recovery at all,
    // under a heading promising two. The only way out was deleting proof files
    // or unwiring the hook from outside Claude Code: the outage class this
    // whole feature exists to prevent.
    writeProof({
      dir: fx.dir,
      proof: {
        nonce, session_id: SESSION, runner_pid: DEAD, hook_path: HOOK_PATH,
        hook_sha256: crypto.createHash('sha256').update(fs.readFileSync(HOOK_PATH)).digest('hex'),
        created_at: new Date(0).toISOString(),
      },
    });
    const recovered = askUnnameable(deadOnly(DEAD));
    assert.equal(recovered.action, 'inert',
      'FIRST RED: stopping the runner did not lift it, because a stopped runner '
      + 'leaves its proof behind and the check only looked for the file');
    assert.equal(recovered.detail?.managed, false);

    // AND IT IS STILL NOT A WAY TO SHAKE THE INTERLOCK OFF: a live runner keeps
    // the denial, which is what makes path 1 a deliberate act rather than a
    // weakness.
    assert.equal(askUnnameable({ kill: () => true }).action, 'deny',
      'a live runner still gets its seat protected');
  });
});

test('#104 G29 item 3: an unreadable proof is NOT "nothing there"', () => {
  withScratch('g29', (fx) => {
    bind(fx, { pid: process.pid });
    const ask = (fsImpl) => runHook({
      payload: { hook_event_name: 'PreToolUse', cwd: path.join(fx.base, 'project') },
      event: 'PreToolUse', env: fx.env, fsImpl, processLike: { kill: () => true },
      now: () => 1, sleep: () => {},
    });

    // ONE TRANSIENT EBUSY on a live managed seat. A bare `catch { continue }`
    // turned the unnameable-payload denial into `inert / managed: false` --
    // this document's own substitution, *cannot see therefore nothing there*,
    // in the code written to close that very class.
    let thrown = 0;
    const flaky = {
      ...fs,
      readFileSync: (target, ...rest) => {
        if (String(target).endsWith(PROOF_NAME) && thrown < 1) {
          thrown += 1;
          const e = new Error('busy'); e.code = 'EBUSY'; throw e;
        }
        return fs.readFileSync(target, ...rest);
      },
    };
    const flakyVerdict = ask(flaky);
    assert.equal(flakyVerdict.action, 'deny',
      'FIRST RED: one unreadable proof made a live managed seat read as unmanaged');
    assert.equal(flakyVerdict.detail?.managed, true, 'cannot-say counts as managed');

    // A CORRUPT proof is the same answer: a file is there and we cannot check
    // whose runner it names.
    fs.writeFileSync(path.join(fx.dir, PROOF_NAME), '{not json');
    assert.equal(ask(fs).detail?.managed, true, 'an unparseable proof still counts');

    // A proof that names no usable pid cannot have its liveness checked either.
    writeProof({ dir: fx.dir, proof: { nonce: 'n', session_id: SESSION, created_at: 'x' } });
    assert.equal(ask(fs).detail?.managed, true, 'a proof with no pid still counts');

    // ONLY ENOENT IS EVIDENCE. Absent means absent, and the recovery for a
    // persistently unreadable proof is to remove the file -- the same
    // deliberate act as ending the runner's claim.
    fs.rmSync(path.join(fx.dir, PROOF_NAME));
    const gone = ask(fs);
    assert.equal(gone.action, 'inert', 'an absent proof is genuinely not managed');
    assert.equal(gone.detail?.managed, false);
  });
});
