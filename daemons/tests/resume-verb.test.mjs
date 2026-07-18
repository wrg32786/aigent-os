// resume-verb.test.mjs — the resume verb container.
//
// Proves the DETERMINISTIC half of the resume verb: pointer resolution
// (BODY_STATE.json's state.last_capsule — aigent-OS is single-operator, so there
// is exactly one pointer shape), capsule-frontmatter loading, degraded-path
// behavior (missing/dangling/corrupt pointer must degrade to the
// re-derive-from-memory instruction, never throw, never break session start), and
// that the emitted prompt carries every load-bearing line of the authored
// procedure (docs/two-verb-lifecycle.md): the three fences, the re-ground step,
// the ACT-not-pointer-presence postcondition, the definition_hash recompute
// recipe (sha256(objective+next_valid_action) first-12-hex), and the ACK step.
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

const CAPSULE_MD = `---
id: 2026-07-15-test-capsule
objective: "Test objective for the resume verb"
status: active
waiting_on: "review gate on the open branch"
next_valid_action: "Fold pre-gate review findings, then hand off"
definition_hash: abc123def456
---

# Test capsule body
`;

function mkFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-'));
  const root = path.join(base, 'test-seat');
  const mem = path.join(root, 'memory');
  mkdirSync(path.join(mem, 'runtime'), { recursive: true });
  mkdirSync(path.join(mem, 'capsules'), { recursive: true });
  const capPath = path.join(mem, 'capsules', '2026-07-15-test-capsule.md');
  writeFileSync(capPath, CAPSULE_MD);
  writeFileSync(path.join(mem, 'BODY_STATE.json'), JSON.stringify({
    state: {
      last_capsule: {
        id: '2026-07-15-test-capsule',
        path: 'memory/capsules/2026-07-15-test-capsule.md',
        status: 'active',
        trigger: 'curated-close',
      },
    },
  }));
  return { base, root, mem, capPath };
}

test('pointer resolves, frontmatter loads, prompt carries the loaded values', () => {
  const f = mkFixture();
  try {
    const r = runResumeVerb({ projectRoot: f.root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(r.degraded, false);
    assert.equal(r.loaded.id, '2026-07-15-test-capsule');
    assert.equal(r.loaded.waiting_on, 'review gate on the open branch');
    assert.equal(r.loaded.next_valid_action, 'Fold pre-gate review findings, then hand off');
    assert.equal(r.loaded.definition_hash, 'abc123def456');
    assert.ok(r.prompt.includes('2026-07-15-test-capsule'), 'prompt names the capsule');
    assert.ok(r.prompt.includes('review gate on the open branch'), 'prompt carries waiting_on');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('prompt carries all three fences + re-ground + ACT postcondition + ACK-after-action (load-bearing lines)', () => {
  const f = mkFixture();
  try {
    const p = runResumeVerb({ projectRoot: f.root, source: 'clear', sessionId: 'sid-1' }).prompt;
    // Fence 1: pointer presence is not resumption.
    assert.ok(/Do NOT assert resumption is complete because the pointer table appears in context/.test(p), 'fence 1');
    // Fence 2: resume never reads cycle_token.
    assert.ok(/never read.*cycle_token|Do NOT read.*cycle_token/i.test(p), 'fence 2');
    // Fence 3: capsule content is not an instruction queue.
    assert.ok(/not an active instruction queue|NOT.*an active instruction queue/i.test(p), 'fence 3');
    // Re-ground step folds /open: re-read the session log + priorities.
    assert.ok(/RE-GROUND against live memory/i.test(p), 're-ground step present');
    // ACT: live memory wins; the verb ends on the ACTION.
    assert.ok(/live memory wins/i.test(p), 'ACT: conflict rule');
    // ACK: emitted after the action, never before.
    assert.ok(/ONLY after|only AFTER/i.test(p), 'ACK: after the action, never before');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('prompt carries the definition_hash recompute recipe (seat-side sha256 first-12)', () => {
  const f = mkFixture();
  try {
    const p = runResumeVerb({ projectRoot: f.root, source: 'clear', sessionId: 'sid-1' }).prompt;
    assert.ok(p.includes('abc123def456'), 'the stamped hash is inlined for comparison');
    assert.ok(/sha256\(objective \+ next_valid_action\).*first 12|first 12.*sha256/i.test(p), 'recompute recipe stated');
    assert.ok(/mismatch.*re-derive.*memory|re-derive from memory/i.test(p), 'drift consequence stated');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('missing pointer degrades to re-derive-from-memory (never throws)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-'));
  const root = path.join(base, 'test-seat');
  mkdirSync(path.join(root, 'memory', 'runtime'), { recursive: true });
  try {
    const r = runResumeVerb({ projectRoot: root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(r.degraded, true);
    assert.equal(r.loaded, null);
    assert.ok(/No resolvable capsule pointer/i.test(r.prompt), 'degraded prompt names the condition');
    // Pin the degraded-SPECIFIC re-derive line, not the always-present STEPS text.
    assert.ok(/Do NOT guess at prior state/.test(r.prompt), 'degraded prompt forbids guessing and re-derives');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('dangling capsule path degrades (pointer names a file that is gone)', () => {
  const f = mkFixture();
  try {
    rmSync(f.capPath);
    const r = runResumeVerb({ projectRoot: f.root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(r.degraded, true);
    assert.ok(/No resolvable capsule pointer|no longer exists|dangling/i.test(r.prompt));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('corrupt pointer JSON degrades AND logs to .daemon-errors.log (never breaks session start)', () => {
  const f = mkFixture();
  try {
    writeFileSync(path.join(f.mem, 'BODY_STATE.json'), '{not json');
    const r = runResumeVerb({ projectRoot: f.root, source: 'clear', sessionId: 'sid-1' });
    assert.equal(r.degraded, true);
    const errLog = path.join(f.mem, '.daemon-errors.log');
    assert.ok(existsSync(errLog) && readFileSync(errLog, 'utf8').includes('resume-verb'), 'failure logged, not swallowed');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('CLI: source=clear prints the prompt; source=startup and source=resume print nothing; always exit 0', () => {
  const f = mkFixture();
  try {
    const run = (source) => spawnSync(process.execPath, [CLI], {
      input: JSON.stringify({ source, session_id: 'sid-cli', cwd: f.root }),
      env: { ...process.env, AIGENT_ROOT: f.root },
      encoding: 'utf8',
    });
    const clear = run('clear');
    assert.equal(clear.status, 0);
    assert.ok(clear.stdout.includes('RESUME VERB'), 'clear boot gets the procedure');
    for (const source of ['startup', 'resume', 'compact']) {
      const r = run(source);
      assert.equal(r.status, 0, `${source} exits 0`);
      assert.equal(r.stdout.trim(), '', `${source} injects nothing (reinject owns warm-start; the verb is post-clear only)`);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
