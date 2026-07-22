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
      + '## objective\nKeep the pipeline healthy.\n\n'
      + '## waiting_on\n1. the next watchdog catch\n\n'
      + '## next_valid_action\nRead the watchdog log and compare snapshots.\n\n'
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
