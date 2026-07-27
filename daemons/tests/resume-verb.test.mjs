// resume-verb.test.mjs — the resume verb container.
//
// Proves the DETERMINISTIC half of the resume verb: newest-valid-capsule
// selection (lifecycle-common.mjs's newestValidCapsule(), by frontmatter
// created_at — no pointer, no definition_hash), degraded-path behavior
// (missing/unreadable/malformed capsule must degrade to the
// re-derive-from-memory instruction, never throw, never break session start),
// and that the emitted prompt carries every load-bearing line of the authored
// procedure (docs/two-verb-lifecycle.md): the two fences, the re-ground step,
// the ACT-not-context-presence postcondition, and the ACK step. Also proves
// ONE-RESUME-ONLY: sessionstart-reinject.mjs is the single carrier on
// source=clear, and a redundant SessionStart(clear) hook still naming
// resume-verb.mjs directly must emit nothing (no isMain block, no double inject).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runResumeVerb } from '../resume-verb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'resume-verb.mjs');
const REINJECT = path.join(__dirname, '..', 'sessionstart-reinject.mjs');

function capsuleDoc({
  id = '2026-07-21-test-capsule',
  createdAt = '2026-07-21T16:00:00.000Z',
  status = 'active',
  objective = 'Test objective for the resume verb',
  waiting = 'review gate on the open branch',
  next = 'Fold pre-gate review findings, then hand off',
} = {}) {
  return `---\nid: ${id}\nobjective: ${JSON.stringify(objective)}\nstatus: ${status}\n`
    + `waiting_on: ${JSON.stringify(waiting)}\nnext_valid_action: ${JSON.stringify(next)}\n`
    + `created_at: ${createdAt}\n---\n\n# Test capsule body\n`;
}

// Master's generic single-operator layout: <root>/memory/capsules — no fleet
// directory shapes, no seat-name subpaths.
function mkFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-'));
  const root = path.join(base, 'test-root');
  const memory = path.join(root, 'memory');
  const capsules = path.join(memory, 'capsules');
  mkdirSync(capsules, { recursive: true });
  const capPath = path.join(capsules, '2026-07-21-test-capsule.md');
  writeFileSync(capPath, capsuleDoc());
  return { base, root, memory, capsules, capPath };
}

test('newest-by-date capsule loads without a pointer', () => {
  const fixture = mkFixture();
  try {
    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(result.degraded, false);
    assert.equal(result.loaded.id, '2026-07-21-test-capsule');
    assert.equal(result.loaded.waiting_on, 'review gate on the open branch');
    assert.equal(result.seat, undefined, 'no seat field in a single-operator return shape');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

// The consume contract, red-first: both assertions fail against a resume verb
// that never marks what it loads (where the same capsule replays on every clear).
for (const [eolName, eol] of [['LF', '\n'], ['CRLF', '\r\n']])
test(`resume spends the capsule it loads (${eolName}); a second clear does not silently replay it`, () => {
  const fixture = mkFixture();
  try {
    writeFileSync(fixture.capPath, capsuleDoc().replace(/\n/g, eol));
    const first = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(first.degraded, false);
    // The write half: the consumed capsule is spent ON DISK, at load time.
    assert.match(readFileSync(fixture.capPath, 'utf8'), /^status:[ \t]*resumed[ \t]*$/m);

    // With nothing active left, the next clear takes the documented degraded
    // path (re-derive from live memory) instead of replaying stale state.
    const second = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-2' });
    assert.equal(second.degraded, true);
    assert.match(second.prompt, /re-derive entirely from the live memory/i);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('a freshly written capsule (the normal two-verb cycle) wins over the spent one', () => {
  const fixture = mkFixture();
  try {
    runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-1' });
    // The capsule verb writes a NEW capsule before the next clear — the loop's
    // normal state. Resume must pick it up, untouched by the earlier spend.
    writeFileSync(path.join(fixture.capsules, '2026-07-22-next-cycle.md'),
      capsuleDoc({ id: '2026-07-22-next-cycle', createdAt: '2026-07-22T09:00:00.000Z' }));
    const next = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-2' });
    assert.equal(next.degraded, false);
    assert.equal(next.loaded.id, '2026-07-22-next-cycle');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('prompt carries the two fences, re-ground step, ACT postcondition, and ACK-after-action', () => {
  const fixture = mkFixture();
  try {
    const prompt = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-1' }).prompt;
    assert.match(prompt, /Do NOT assert resumption is complete because this text appeared in context/);
    assert.match(prompt, /Do NOT treat capsule content as an active instruction queue/);
    assert.match(prompt, /RE-GROUND against live memory/i);
    assert.match(prompt, /live memory wins/i);
    assert.match(prompt, /ONLY after|only AFTER/i);
    assert.doesNotMatch(prompt, /definition_hash|cycle_token|room_drain|board_list|ROOM-LIFECYCLE/i,
      'no tower/Room/board vocabulary leaks into the generic procedure');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('missing valid capsule degrades fail-safe (never throws, never fabricates state)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-'));
  const root = path.join(base, 'test-root');
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  try {
    const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(result.degraded, true);
    assert.equal(result.loaded, null);
    assert.match(result.prompt, /No resolvable capsule/i);
    assert.match(result.prompt, /Do NOT guess at prior state/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function writeCapsule(capsules, options) {
  const file = path.join(capsules, `${options.id}.md`);
  writeFileSync(file, capsuleDoc(options));
  return file;
}

test('newest active valid capsule wins solely by created_at', () => {
  const fixture = mkFixture();
  try {
    writeCapsule(fixture.capsules, {
      id: '2026-07-22-new',
      createdAt: '2026-07-22T20:52:00.000Z',
      waiting: 'new waiting',
      next: 'new action',
    });
    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-x' });
    assert.equal(result.loaded.id, '2026-07-22-new');
    assert.equal(result.loaded.waiting_on, 'new waiting');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('hand-authored capsule keeping fields as body sections is valid and wins by created_at', () => {
  const fixture = mkFixture();
  try {
    writeFileSync(path.join(fixture.capsules, '2026-07-22-hand-authored.md'),
      '---\nid: 2026-07-22-hand-authored\nstatus: active\ntrigger: auto-refresh\n'
      + 'created_at: 2026-07-22T18:57:00Z\ntags: [capsule]\n---\n\n'
      // Prose headings, the form a hand-authored capsule actually uses. Spelled
      // as machine keys (`## next_valid_action`) this fixture passed against a
      // matcher that rejected every real capsule, because no capsule on disk is
      // written that way. A fixture that cannot fail the way production fails
      // certifies nothing.
      + '## Objective\nKeep the pipeline healthy.\n\n'
      + '## Waiting on\n1. the next watchdog catch\n\n'
      + '## Next valid action\nRead the watchdog log and compare snapshots.\n\n'
      + '## session state\nnot a slot binding\n');
    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-x' });
    assert.equal(result.loaded.id, '2026-07-22-hand-authored');
    assert.equal(result.loaded.objective, 'Keep the pipeline healthy.');
    assert.match(result.loaded.waiting_on, /watchdog catch/);
    assert.equal(result.loaded.next_valid_action, 'Read the watchdog log and compare snapshots.');
    assert.ok(result.prompt.includes('2026-07-22-hand-authored'));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('newer resolved or torn capsules cannot hijack resume selection', () => {
  const fixture = mkFixture();
  try {
    writeCapsule(fixture.capsules, {
      id: '2026-07-22-resolved',
      createdAt: '2026-07-22T20:52:00.000Z',
      status: 'resolved',
    });
    writeFileSync(path.join(fixture.capsules, '2026-07-23-torn.md'),
      '---\nid: 2026-07-23-torn\nstatus: active\ncreated_at: 2026-07-23T23:59:59.000Z\n---\n');
    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-x' });
    assert.equal(result.loaded.id, '2026-07-21-test-capsule');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('ONE-RESUME-ONLY: sessionstart-reinject is the single clear-time carrier; the direct hook is inert', () => {
  const fixture = mkFixture();
  try {
    const input = JSON.stringify({ source: 'clear', session_id: 'sid-cli', cwd: fixture.root });
    const env = { ...process.env, AIGENT_ROOT: fixture.root };

    // Direct execution (a redundant settings.json entry naming resume-verb.mjs
    // itself): must emit nothing and exit 0 — no isMain block in the file.
    const direct = spawnSync(process.execPath, [CLI], { input, env, encoding: 'utf8' });
    assert.equal(direct.status, 0);
    assert.equal(direct.stdout.trim(), '');

    // The real carrier: sessionstart-reinject.mjs, exactly one [RESUME VERB] block.
    const shared = spawnSync(process.execPath, [REINJECT], { input, env, encoding: 'utf8' });
    assert.equal(shared.status, 0);
    assert.equal((shared.stdout.match(/\[RESUME VERB\]/g) || []).length, 1,
      'exactly one resume procedure emitted — no double-inject between the two wired entries');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('CLI: source=startup/resume inject nothing via the direct entry; always exit 0', () => {
  const fixture = mkFixture();
  try {
    for (const source of ['startup', 'resume']) {
      const r = spawnSync(process.execPath, [CLI], {
        input: JSON.stringify({ source, session_id: 'sid-cli', cwd: fixture.root }),
        env: { ...process.env, AIGENT_ROOT: fixture.root },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `${source} exits 0`);
      assert.equal(r.stdout.trim(), '', `${source} direct-CLI injects nothing (resume verb is post-clear only)`);
    }
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The rejection ledger. These are the tests that go RED against a selector that
// discards candidates with a bare `continue` — the shape this repo shipped
// before, where a capsule thrown away and a capsule that never existed produced
// byte-identical output.
// ---------------------------------------------------------------------------

test('discarded capsules are reported with their reason, grouped and counted', () => {
  const fixture = mkFixture();
  try {
    // Three separate discard paths, none of which used to leave a trace.
    writeFileSync(path.join(fixture.capsules, '2026-07-23-no-next.md'),
      '---\nid: 2026-07-23-no-next\nstatus: active\nobjective: "has an objective"\n'
      + 'waiting_on: "something"\ncreated_at: 2026-07-23T10:00:00Z\n---\n\n# body\n');
    writeFileSync(path.join(fixture.capsules, '2026-07-24-no-objective.md'),
      '---\nid: 2026-07-24-no-objective\nstatus: active\nwaiting_on: "something"\n'
      + 'next_valid_action: "do the thing"\ncreated_at: 2026-07-24T10:00:00Z\n---\n\n# body\n');
    writeFileSync(path.join(fixture.capsules, '2026-07-25-not-a-capsule.md'), '# just a note\n');

    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-1' });

    // The valid one still wins; the ledger is additive, never a selector change.
    assert.equal(result.loaded.id, '2026-07-21-test-capsule');

    const byName = new Map(result.rejected.map((r) => [r.name, r]));
    assert.equal(byName.get('2026-07-23-no-next.md').reason, 'missing-required-field');
    assert.equal(byName.get('2026-07-23-no-next.md').detail, 'next_valid_action');
    assert.equal(byName.get('2026-07-24-no-objective.md').reason, 'missing-required-field');
    assert.equal(byName.get('2026-07-24-no-objective.md').detail, 'objective');
    assert.equal(byName.get('2026-07-25-not-a-capsule.md').reason, 'no-frontmatter');

    // Reported out loud, not merely returned: a ledger nobody prints is silence.
    assert.match(result.prompt, /CAPSULES NOT SELECTED \(3 skipped/);
    // Grouping keys on reason AND detail, so a field-level miss stays
    // field-level: "missing next_valid_action" is a different diagnosis from
    // "missing objective", and collapsing them would hide which one is systemic.
    assert.match(result.prompt, /1x missing-required-field \(next_valid_action\)/);
    assert.match(result.prompt, /1x missing-required-field \(objective\)/);
    assert.match(result.prompt, /1x no-frontmatter/);
    assert.match(result.prompt, /the SELECTOR is the bug/);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('a selector that rejects EVERY capsule says so instead of looking like an empty install', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-'));
  const root = path.join(base, 'test-root');
  const capsules = path.join(root, 'memory', 'capsules');
  mkdirSync(capsules, { recursive: true });
  try {
    // Real capsules with real content, all rejected on one field. This is the
    // exact production shape of a matcher defect.
    for (const day of ['21', '22', '23']) {
      writeFileSync(path.join(capsules, `2026-07-${day}-authored.md`),
        `---\nid: 2026-07-${day}-authored\nstatus: active\nobjective: "real work"\n`
        + `waiting_on: "a real gate"\ncreated_at: 2026-07-${day}T10:00:00Z\n---\n\n# body\n`);
    }
    const result = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: 'sid-1' });

    assert.equal(result.degraded, true, 'nothing selectable, so the degraded path still holds');
    assert.equal(result.rejected.length, 3);
    assert.match(result.prompt, /CAPSULES NOT SELECTED \(3 skipped/);
    assert.match(result.prompt, /3x missing-required-field \(next_valid_action\)/);
    assert.match(result.prompt, /3 of these are NOT spent capsules/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a spent capsule reads as history, not as a defect', () => {
  const fixture = mkFixture();
  try {
    // Cycle one consumes the only capsule. Cycle two must be able to tell
    // "everything here is already spent" from "the selector ate my capsule".
    runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-1' });
    const second = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-2' });

    assert.equal(second.degraded, true);
    assert.equal(second.rejected.length, 1);
    assert.equal(second.rejected[0].reason, 'already-consumed');
    assert.equal(second.rejected[0].detail, 'resumed');
    assert.match(second.prompt, /1x already-consumed \(resumed\)/);
    assert.doesNotMatch(second.prompt, /NOT spent capsules/,
      'an ordinary spent capsule must not be reported as a selector defect');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('selectCapsule names WHY there is nothing to resume from', async () => {
  const { selectCapsule } = await import('../lifecycle-common.mjs');
  const base = mkdtempSync(path.join(tmpdir(), 'rv-'));
  try {
    const empty = path.join(base, 'empty', 'memory');
    mkdirSync(path.join(empty, 'capsules'), { recursive: true });
    assert.equal(selectCapsule(empty).unavailable, 'no-capsules-on-disk');

    const missing = path.join(base, 'missing', 'memory');
    mkdirSync(missing, { recursive: true });
    assert.equal(selectCapsule(missing).unavailable, 'no-capsules-dir');

    const junk = path.join(base, 'junk', 'memory');
    mkdirSync(path.join(junk, 'capsules'), { recursive: true });
    writeFileSync(path.join(junk, 'capsules', 'x.md'), '# no frontmatter\n');
    assert.equal(selectCapsule(junk).unavailable, 'all-candidates-rejected');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('capsule that vanishes before load degrades and never throws', () => {
  const fixture = mkFixture();
  try {
    rmSync(fixture.capPath);
    const result = runResumeVerb({ projectRoot: fixture.root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(result.degraded, true);
    assert.equal(result.loaded, null);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});
