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
// or written. Skipped entirely when jq is unavailable (the script itself
// degrades to a display-only no-op in that case, by design).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'statusline-ctx.sh');

const hasJq = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

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

test('writes the sensor file atomically with a numeric used_percentage', { skip: !hasJq && 'jq unavailable' }, () => {
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

test('malformed payload and hostile session_id write nothing', { skip: !hasJq && 'jq unavailable' }, () => {
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

test('delegates the visible line to an existing statusline script unchanged', { skip: !hasJq && 'jq unavailable' }, () => {
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

test('prunes >7-day-idle *.json but never the sensor\'s *.state files', { skip: !hasJq && 'jq unavailable' }, () => {
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
