// statusline-ctx.test.mjs — the statusline context-percentage writer.
//
// Proves the WRITER half of the ctx-refresh contract that
// ctx-refresh-sensor.mjs reads: a statusline payload on stdin produces
// ~/.claude/ctx-refresh/<session_id>.json with a numeric used_percentage
// (atomic — no .tmp stray left behind), a malformed or hostile payload
// produces nothing (never a path escape, never torn JSON), display
// delegation passes the payload through unchanged, stale sensor files are
// pruned after 7 idle days, and the sensor's own *.state files are never
// touched by the pruning pass.
//
// Every case runs against a throwaway HOME so no real operator state is read
// or written. Skipped entirely when the tooling these cases need is absent —
// jq, or the bash that would answer whether jq is there (the script itself
// degrades to a display-only no-op without jq, by design).
//
// ⚑ A SKIP HERE IS NOT A PASS, and CI now enforces that: the daemons-suite step
// in ci.yml fails the build on any non-zero skip count, because this file
// reported `pass 0 / skipped 4` and exit 0 on a jq-less machine for as long as
// nobody looked (board 85d22ad1). If these are skipping, the runner is missing
// something and the answer is to install it, never to let the gate absorb it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'statusline-ctx.sh');

// Two absences, reported separately (board 85d22ad1, AC-4). The single
// `spawnSync('bash', …).status === 0` this replaces read false when jq was
// missing AND when bash could not be spawned at all, and labelled both
// "jq unavailable" — a correct skip with a possibly-wrong reason. The reason is
// the only thing a reader gets, so it has to name what is actually absent.
//
// `.error` is the spawn failing (no bash); a non-zero `.status` is bash running
// and not finding jq. Distinct facts, distinct sentences.
const bashProbe = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' });
// The happy path MUST be `false`, never `null`. node:test does not treat this
// option as a truthiness test: measured on node v24.15.0, `false` and
// `undefined` RUN, while `null`, `''`, and `true` all SKIP. An earlier revision
// ended this chain in `null`, so on a machine where jq IS present all four tests
// below skipped silently with no reason string, on a runner whose install step
// had just logged "jq already present: jq-1.7" (board 6efdf2dc).
// The refactor that introduced it was making the skip REASON more precise,
// splitting "bash unavailable" from "jq unavailable", which was a real
// improvement, and it changed the happy-path VALUE on the way past. Better
// message, broken mechanism.
const skipReason = bashProbe.error
  ? `bash unavailable (${bashProbe.error.code || 'spawn failed'}) — jq presence unknown`
  : bashProbe.status !== 0
    ? 'jq unavailable'
    : false;

// REGRESSION GUARD for board 6efdf2dc. Runs on every machine, jq or not, and is
// never itself skippable — a guard gated on the condition it protects would be
// dark in exactly the situation that matters.
// It pins the SHAPE of skipReason rather than its value, so it holds on a
// jq-present runner and a jq-less laptop alike: either a non-empty string (a
// real, reportable reason) or strictly `false` (run the tests). `null`, `''`,
// and `undefined` are the three values that silently changed behaviour here, and
// two of them skip while reading as "no reason to skip".
test('skipReason is a non-empty string or strictly false, never a falsy skip', () => {
  if (typeof skipReason === 'string') {
    assert.ok(skipReason.length > 0, 'a string reason must be non-empty; "" SKIPS while reading as no-reason');
    return;
  }
  assert.strictEqual(
    skipReason, false,
    `skipReason must be false when the tests should RUN, got ${JSON.stringify(skipReason)}. `
    + 'node:test skips on null/""/true and runs on false/undefined; this option is not a truthiness test.',
  );
});

function freshHome() {
  return mkdtempSync(path.join(tmpdir(), 'statusline-ctx-test-'));
}

function run(payload, home, extraEnv = {}) {
  return spawnSync('bash', [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
  });
}

const PAYLOAD = JSON.stringify({
  session_id: 'sess-abc123',
  model: { display_name: 'TestModel' },
  context_window: { used_percentage: 42.5 },
});

test('writes the sensor file atomically with a numeric used_percentage', { skip: skipReason }, () => {
  const home = freshHome();
  try {
    const res = run(PAYLOAD, home);
    assert.equal(res.status, 0);
    const dir = path.join(home, '.claude', 'ctx-refresh');
    const file = path.join(dir, 'sess-abc123.json');
    assert.ok(existsSync(file), 'sensor file must exist');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(typeof parsed.used_percentage, 'number'); // the sensor's readPct requirement
    assert.equal(parsed.used_percentage, 42.5);
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no .tmp stray after the rename');
    // Built-in fallback display (no delegate wired in this HOME).
    assert.match(res.stdout, /TestModel/);
    assert.match(res.stdout, /ctx 42%/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('malformed payload and hostile session_id write nothing', { skip: skipReason }, () => {
  const home = freshHome();
  try {
    for (const bad of [
      '{}',
      'not json at all',
      JSON.stringify({ session_id: '../evil', context_window: { used_percentage: 50 } }),
      JSON.stringify({ session_id: 'sess-ok', context_window: { used_percentage: '50; rm -rf' } }),
    ]) {
      const res = run(bad, home);
      assert.equal(res.status, 0, 'always exits 0');
    }
    const dir = path.join(home, '.claude', 'ctx-refresh');
    if (existsSync(dir)) assert.deepEqual(readdirSync(dir), []);
    assert.ok(!existsSync(path.join(home, '.claude', 'evil.json')), 'no path escape');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('delegates the visible line to an existing statusline script unchanged', { skip: skipReason }, () => {
  const home = freshHome();
  try {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'statusline-command.sh'),
      '#!/bin/bash\nINPUT=$(cat)\necho "DELEGATE saw $(printf \'%s\' "$INPUT" | jq -r .model.display_name)"\n',
    );
    const res = run(PAYLOAD, home);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), 'DELEGATE saw TestModel');
    // The sensor write still happened alongside delegation.
    assert.ok(existsSync(path.join(home, '.claude', 'ctx-refresh', 'sess-abc123.json')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prunes >7-day-idle *.json but never the sensor\'s *.state files', { skip: skipReason }, () => {
  const home = freshHome();
  try {
    const dir = path.join(home, '.claude', 'ctx-refresh');
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    for (const f of ['stale-session.json', 'stale-session.state']) {
      writeFileSync(path.join(dir, f), '{}');
      utimesSync(path.join(dir, f), old, old);
    }
    assert.equal(run(PAYLOAD, home).status, 0);
    assert.ok(!existsSync(path.join(dir, 'stale-session.json')), 'stale sensor file pruned');
    assert.ok(existsSync(path.join(dir, 'stale-session.state')), '.state files are the sensor\'s business');
    assert.ok(existsSync(path.join(dir, 'sess-abc123.json')), 'fresh write landed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
