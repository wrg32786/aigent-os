// checkpoint-session-binding.test.mjs -- the F001 gate deadlock, reproduced
// and closed against the REAL production selector.
//
// WHY THIS EXISTS (2026-08-03, cycle 5, zero F001 cycles ever counted):
// Two guards, each correct in isolation, deadlocked each other.
//   1. lifecycle-common.mjs's selectCapsule() demotes any capsule whose
//      objective/next_valid_action is the stop-writer's own "nothing was
//      captured" placeholder (2026-08-01 fix, capsule-sentinel-selection.
//      test.mjs) -- a curated capsule always outranks it.
//   2. auto-clear-transport.mjs's evaluateCheckpointFreshness() refuses to
//      authorize a clear unless the selector's pick is byte-identical (by
//      path) to the capsule THIS session's own stop-writer just recorded.
// On a reference install a curated capsule always sits on disk. A session
// whose own Stop delta captured nothing writes a placeholder checkpoint; the
// selector (no identity awareness) demotes it and returns the curated
// capsule instead; the transport compares the two paths, sees a mismatch,
// and holds -- on EVERY tick, forever. Measured live: reference-install
// capsule 2026-08-02-auto-b89d594b.md (next_valid_action: "No concrete next
// action was captured in this Stop delta.") lost to
// 2026-08-02-system-check-baseline.md every cycle.
//
// This file drives the REAL selectCapsule via evaluateCheckpointFreshness's
// DEFAULT wiring (no selectCapsuleFn stub) against real capsule files on
// disk -- Law XV real-glue: a test that reimplements the matcher cannot fail
// when the matcher is wrong. Real-selector coverage already exists for the
// HAPPY path (auto-clear-transport.run1.test.mjs test 14); this file covers
// the DEADLOCK path that test never touches.
//
// Run: node daemons/tests/checkpoint-session-binding.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCheckpointFreshness, transcriptPathFor } from '../auto-clear-transport.mjs';
import { selectCapsule } from '../lifecycle-common.mjs';

const SESSION_ID = 'session-cycle5';

// The writer's own placeholder strings, TRANSCRIBED from the live specimen
// (2026-08-02-auto-b89d594b.md), not recalled.
const PLACEHOLDER_OBJECTIVE = 'Unknown: no human objective was captured in this Stop delta.';
const PLACEHOLDER_ACTION = 'No concrete next action was captured in this Stop delta.';

function writeText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

function writeJson(target, value) {
  return writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCapsule(target, fm) {
  const body = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  return writeText(target, `---\n${body}\n---\n\n# fixture\n`);
}

function makeFixture(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `sessbind-${name}-`));
  const memRoot = path.join(base, 'memory');
  const homeDir = path.join(base, 'home');
  const cwd = path.join(base, 'work', 'project');
  const transcriptPath = transcriptPathFor({ cwd, sessionId: SESSION_ID, homeDir });
  const transcript = '0123456789';
  writeText(transcriptPath, transcript);
  return {
    base, memRoot, homeDir, cwd, transcriptPath,
    transcriptSize: Buffer.byteLength(transcript),
  };
}

function destroyFixture(fixture) {
  fs.rmSync(fixture.base, { recursive: true, force: true });
}

function evaluate(fixture) {
  return evaluateCheckpointFreshness({
    memRoot: fixture.memRoot,
    sessionId: SESSION_ID,
    cwd: fixture.cwd,
    homeDir: fixture.homeDir,
    fsImpl: fs,
    // selectCapsuleFn deliberately NOT overridden -- this is the point: the
    // production default (lifecycle-common's real selectCapsule) is what
    // deadlocked, so it is what must be proven fixed.
  });
}

// RED VECTOR ---------------------------------------------------------------
//
// Reproduces cycle 5 exactly: this session's own checkpoint is a contentless
// placeholder; an unrelated curated capsule also exists on disk. Before the
// fix, the plain selector call demotes the placeholder and returns curated,
// which never matches this session's stop-writer record -> HOLD forever.

test('cycle-5 deadlock: a session\'s own placeholder checkpoint authorizes despite a curated capsule on disk', () => {
  const fixture = makeFixture('deadlock');
  try {
    const curatedPath = writeCapsule(path.join(fixture.memRoot, 'capsules', 'system-check-baseline.md'), {
      id: 'system-check-baseline', status: 'active', created_at: '2026-08-01T10:00:00.000Z',
      objective: 'Run the F001 gate to a counted cycle.',
      next_valid_action: 'Run M-LIVE-1..8 before cycle 1 counts.',
    });
    const placeholderPath = writeCapsule(path.join(fixture.memRoot, 'capsules', 'auto-b89d594b.md'), {
      id: 'auto-b89d594b', status: 'active', created_at: '2026-08-02T09:00:00.000Z',
      objective: PLACEHOLDER_OBJECTIVE, next_valid_action: PLACEHOLDER_ACTION,
    });
    writeJson(path.join(fixture.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`), {
      offset: fixture.transcriptSize,
      capsule_path: placeholderPath,
      last_delta_sha: 'cycle5-fixture',
    });

    // Fixture invariant: prove the curated capsule really is what the plain
    // (option-absent) selector picks -- otherwise this test would not be
    // exercising the reported deadlock at all.
    const plain = selectCapsule(fixture.memRoot);
    assert.equal(plain.capsule?.path, curatedPath,
      'fixture invariant broken: the plain selector must pick curated over the placeholder for this test to mean anything');

    const result = evaluate(fixture);
    assert.equal(result.ok, true,
      `expected the checkpoint to authorize; got HOLD:${result.code} detail=${JSON.stringify(result.detail)}`);
    assert.equal(result.capsule.path, placeholderPath,
      'authorization must bind to the SESSION\'S OWN checkpoint capsule, not the curated one');
    assert.equal(result.capsule.id, 'auto-b89d594b');
    assert.equal(result.sessionBound, true, 'the win must be recorded as session binding, not silent');
    assert.equal(result.record.capsule_path, placeholderPath);
  } finally {
    destroyFixture(fixture);
  }
});

// NEGATIVE CONTROLS ---------------------------------------------------------
//
// The fix must not blanket-disable the mismatch guard. It only resolves the
// exact placeholder-vs-own-checkpoint case; a GENUINE mismatch -- the
// session's own recorded capsule is truly gone or truly broken -- must still
// hold, because that really is unrecoverable staleness, not a quality-vs-
// identity disagreement about the SAME file.

test('NEG: session\'s own capsule_path genuinely missing from disk still holds checkpoint-session-mismatch', () => {
  const fixture = makeFixture('missing-own-capsule');
  try {
    writeCapsule(path.join(fixture.memRoot, 'capsules', 'system-check-baseline.md'), {
      id: 'system-check-baseline', status: 'active', created_at: '2026-08-01T10:00:00.000Z',
      objective: 'Run the F001 gate to a counted cycle.',
      next_valid_action: 'Run M-LIVE-1..8 before cycle 1 counts.',
    });
    // The stop-writer's record points at a capsule that was never written to
    // disk in this fixture at all (deleted / never landed) -- there is
    // nothing for identity binding to find.
    const vanishedPath = path.join(fixture.memRoot, 'capsules', 'vanished.md');
    writeJson(path.join(fixture.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`), {
      offset: fixture.transcriptSize,
      capsule_path: vanishedPath,
      last_delta_sha: 'missing-own-fixture',
    });

    const result = evaluate(fixture);
    assert.equal(result.ok, false, 'a genuinely absent session capsule must not silently authorize');
    assert.equal(result.code, 'checkpoint-session-mismatch');
    assert.equal(result.detail.stop_writer_capsule, vanishedPath);
  } finally {
    destroyFixture(fixture);
  }
});

test('NEG: session\'s own capsule_path exists but is structurally broken (no frontmatter) still holds', () => {
  const fixture = makeFixture('broken-own-capsule');
  try {
    writeCapsule(path.join(fixture.memRoot, 'capsules', 'system-check-baseline.md'), {
      id: 'system-check-baseline', status: 'active', created_at: '2026-08-01T10:00:00.000Z',
      objective: 'Run the F001 gate to a counted cycle.',
      next_valid_action: 'Run M-LIVE-1..8 before cycle 1 counts.',
    });
    // A file sits at the recorded path, but it never parsed as a capsule at
    // all -- structural validity (the option's stated precondition) fails,
    // so identity binding must not override anything here.
    const brokenPath = writeText(
      path.join(fixture.memRoot, 'capsules', 'broken.md'),
      'not a capsule -- no frontmatter block\n',
    );
    writeJson(path.join(fixture.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`), {
      offset: fixture.transcriptSize,
      capsule_path: brokenPath,
      last_delta_sha: 'broken-own-fixture',
    });

    const result = evaluate(fixture);
    assert.equal(result.ok, false, 'a structurally broken session capsule must not silently authorize');
    assert.equal(result.code, 'checkpoint-session-mismatch');
  } finally {
    destroyFixture(fixture);
  }
});

test('POSITIVE CONTROL: no placeholder involved -- ordinary curated checkpoint authorizes exactly as before', () => {
  const fixture = makeFixture('ordinary-curated');
  try {
    const capsulePath = writeCapsule(path.join(fixture.memRoot, 'capsules', 'ordinary.md'), {
      id: 'ordinary', status: 'active', created_at: '2026-08-02T09:00:00.000Z',
      objective: 'Ship the ordinary case.',
      next_valid_action: 'Confirm the ordinary case still authorizes.',
    });
    writeJson(path.join(fixture.memRoot, 'runtime', 'stop-writer', `${SESSION_ID}.json`), {
      offset: fixture.transcriptSize,
      capsule_path: capsulePath,
      last_delta_sha: 'ordinary-fixture',
    });

    const result = evaluate(fixture);
    assert.equal(result.ok, true);
    assert.equal(result.capsule.path, capsulePath);
    assert.equal(result.sessionBound, false,
      'the plain call already matched -- the retry path must never even engage, let alone claim credit');
  } finally {
    destroyFixture(fixture);
  }
});
