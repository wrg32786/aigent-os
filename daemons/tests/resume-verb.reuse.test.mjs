// resume-verb.reuse.test.mjs: Law XVI clause 4, a resume off spent state says so.
//
// selectCapsule() marks a capsule consumed the moment resume-verb loads it, so
// a second clear with nothing else on disk used to return the SAME shape as a
// genuinely empty install (`{ capsule: null, unavailable: 'all-candidates-rejected' }`).
// A re-resume off spent state was therefore silent: nothing on the prompt or the
// result told the reader that a real, structurally valid capsule was on disk
// and simply already spent.
//
// The fix: when nothing active or fallback survives, the newest CONSUMED
// candidate that is otherwise structurally valid (id, finite created_at,
// non-empty objective and next_valid_action) is returned as the pick, flagged
// `reused: true`, and resume-verb renders a loud three-line block naming the
// status. Spent-but-real outranks active-but-empty (the placeholder fallback
// tier): ordering is (a) valid active wins as always, (b) else newest
// consumed-but-real, flagged reused, (c) else the placeholder fallback as
// always, (d) else the existing unavailable shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectCapsule, newestValidCapsule } from '../lifecycle-common.mjs';
import { runResumeVerb } from '../resume-verb.mjs';

function seat(capsules) {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-reuse-'));
  const root = path.join(base, 'test-root');
  const memory = path.join(root, 'memory');
  mkdirSync(path.join(memory, 'capsules'), { recursive: true });
  for (const [name, fm] of Object.entries(capsules)) {
    const body = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
    writeFileSync(path.join(memory, 'capsules', `${name}.md`), `---\n${body}\n---\n\n# ${name}\n`);
  }
  return { base, root, memory };
}

const REAL = {
  objective: 'Take the pipeline from red to green.',
  next_valid_action: 'Run the suite and fix the first failure.',
};

test('W-B1: two consumed, structurally valid capsules -- selectCapsule reuses the newer one, flagged; newestValidCapsule returns null', () => {
  const fixture = seat({
    older: { id: 'older', status: 'resumed', created_at: '2026-08-01T09:00:00.000Z', ...REAL },
    newer: { id: 'newer', status: 'resolved', created_at: '2026-08-01T11:00:00.000Z', ...REAL },
  });
  try {
    const result = selectCapsule(fixture.memory);
    assert.equal(result.capsule?.id, 'newer', 'the newer consumed-but-real capsule must win the reuse pick');
    assert.equal(result.reused, true, 'the pick must be flagged as a reuse');

    assert.equal(newestValidCapsule(fixture.memory), null,
      'newestValidCapsule keeps its narrow contract: a reuse selection is null to a caller that only wants a fresh active capsule');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('W-B2: runResumeVerb on an all-consumed seat renders the loud reuse block; the status on disk is unchanged', () => {
  const fixture = seat({
    only: { id: 'only', status: 'resumed', created_at: '2026-08-01T09:00:00.000Z', ...REAL },
  });
  try {
    const capsulePath = path.join(fixture.memory, 'capsules', 'only.md');
    const before = readFileSync(capsulePath, 'utf8');

    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-reuse' });
    assert.equal(result.degraded, false, 'a reuse pick is a resolvable capsule, not the degraded no-capsule path');
    assert.equal(result.loaded?.id, 'only');
    assert.match(result.prompt, /\*\*\* REUSING AN ALREADY-USED CAPSULE \*\*\*/);
    assert.match(result.prompt, /resumed/, 'the block must name the on-disk status');

    const after = readFileSync(capsulePath, 'utf8');
    assert.equal(after, before, 'a reuse must not rewrite the capsule it reused -- it is already spent');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

// Fleet restart 2026-11-16: three of five seats booted into day-old capsules. Each seat's newest
// capsule had been marked `resumed` by its last clear, so the selector fell back to the newest
// never-resumed capsule: older work the seat had already moved past.
test('W-B4: an active capsule OLDER than the newest resumed one is stale: the resumed one is reused, flagged', () => {
  const fixture = seat({
    stale: { id: 'stale', status: 'active', created_at: '2026-11-15T11:41:52.000Z', ...REAL },
    newest: { id: 'newest', status: 'resumed', created_at: '2026-11-16T08:14:27.000Z', ...REAL },
  });
  try {
    const result = selectCapsule(fixture.memory);
    assert.equal(result.capsule?.id, 'newest');
    assert.equal(result.reused, true);
    assert.deepEqual(result.rejected.find((r) => r.name === 'stale.md'),
      { name: 'stale.md', reason: 'superseded-by-resumed', detail: 'newest' });
    const verb = runResumeVerb({ projectRoot: fixture.root, source: 'startup', sessionId: 'sid-restart' });
    assert.equal(verb.loaded?.id, 'newest');
    assert.match(verb.prompt ?? '', /REUSING AN ALREADY-USED CAPSULE/);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('W-B5: a newer RESOLVED or SUPERSEDED capsule was retired on purpose: the older active one still wins', () => {
  for (const status of ['resolved', 'superseded', 'consumed']) {
    const fixture = seat({
      live: { id: 'live', status: 'active', created_at: '2026-11-15T11:41:52.000Z', ...REAL },
      retired: { id: 'retired', status, created_at: '2026-11-16T08:14:27.000Z', ...REAL },
    });
    try {
      const result = selectCapsule(fixture.memory);
      assert.equal(result.capsule?.id, 'live', status);
      assert.equal(result.reused, undefined, status);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  }
});

test('W-B6: the session-start pointer names the newest capsule, labelled as already resumed', () => {
  const fixture = seat({
    stale: { id: 'stale', status: 'active', created_at: '2026-11-15T11:41:52.000Z', ...REAL },
    newest: { id: 'newest', status: 'resumed', created_at: '2026-11-16T08:14:27.000Z', ...REAL },
  });
  try {
    const reinject = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'sessionstart-reinject.mjs');
    const r = spawnSync(process.execPath, [reinject], {
      input: JSON.stringify({ source: 'startup', session_id: 'sid-restart', cwd: fixture.root }),
      env: { ...process.env, AIGENT_ROOT: fixture.root }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /NEWEST CAPSULE, ALREADY RESUMED ONCE/);
    assert.match(r.stdout, /newest\.md/);
    assert.doesNotMatch(r.stdout, /stale\.md/);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('W-B3: with one active valid capsule present, reused is false and the block is absent (precedence guard)', () => {
  const fixture = seat({
    spent: { id: 'spent', status: 'resumed', created_at: '2026-08-01T09:00:00.000Z', ...REAL },
    live: { id: 'live', status: 'active', created_at: '2026-08-01T11:00:00.000Z', ...REAL },
  });
  try {
    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-precedence' });
    assert.equal(result.loaded?.id, 'live', 'a valid active capsule must win over a spent one');
    assert.equal(result.reused, false);
    assert.doesNotMatch(result.prompt, /REUSING AN ALREADY-USED CAPSULE/);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});
