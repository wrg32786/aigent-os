// capsule-nudge.mjs: a seat that never stops working is asked, in its own context, to capsule.
// Specimen: Titus 2026-11-15 04:20-05:12Z, one continuous run of tool calls past the refresh
// threshold; every cycle's capsule request held (a tool call was always open), and Claude Code
// compacted natively at 05:12Z.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nudgeFor, NUDGE_AFTER_MS, NUDGE_FILE } from '../capsule-nudge.mjs';
import * as core from '../auto-clear-transport.mjs';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'capsule-nudge.mjs');
const SESSION = 'sess-nudge';
const T0 = Date.parse('2026-11-15T04:20:03.896Z');

function fixture(cycle) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'capsule-nudge-'));
  const root = path.join(base, 'project');
  const runtime = path.join(root, 'vault', 'memory', 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'ctx-refresh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'ctx-refresh', `${SESSION}.json`), JSON.stringify({ used_percentage: 86.4 }));
  const writeCycle = (c) => fs.writeFileSync(path.join(runtime, 'auto-clear-cycle.json'), JSON.stringify(c));
  if (cycle) writeCycle(cycle);
  const env = { AIGENT_ROOT: root, HOME: home, USERPROFILE: home };
  return { base, root, runtime, env, writeCycle, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const waiting = (over = {}) => ({
  state: 'HOLD:checkpoint-transcript-short', cycle_id: 'cyc-157', session_id: SESSION,
  entered_at: new Date(T0).toISOString(), checkpoint_wait_started_at: new Date(T0).toISOString(), ...over,
});
const payload = { session_id: SESSION, tool_name: 'Bash', cwd: os.tmpdir() };

test('a cycle waiting past the bound gets ONE nudge, recorded for the transport', () => {
  const f = fixture(waiting());
  try {
    assert.equal(nudgeFor({ payload, env: f.env, now: () => T0 + NUDGE_AFTER_MS - 1 }), null, 'not before a minute of waiting');
    const text = nudgeFor({ payload, env: f.env, now: () => T0 + 5 * 60_000 });
    assert.match(text, /at 86% of its context refresh threshold/);
    assert.match(text, /run the context-capsule skill now/);
    assert.match(text, /end your turn/);
    const marker = JSON.parse(fs.readFileSync(path.join(f.runtime, NUDGE_FILE), 'utf8'));
    assert.equal(marker.cycle_id, 'cyc-157');
    assert.equal(marker.at, new Date(T0 + 5 * 60_000).toISOString());
    assert.equal(nudgeFor({ payload, env: f.env, now: () => T0 + 6 * 60_000 }), null, 'once per cycle');
    f.writeCycle(waiting({ cycle_id: 'cyc-158' }));
    assert.ok(nudgeFor({ payload, env: f.env, now: () => T0 + 16 * 60_000 }), 'a new cycle is nudged again');
  } finally { f.done(); }
});

test('no nudge: another session, a cycle not waiting for a capsule, no cycle, the kill switch', () => {
  const f = fixture(waiting());
  try {
    const late = () => T0 + 10 * 60_000;
    assert.equal(nudgeFor({ payload: { ...payload, session_id: 'other' }, env: f.env, now: late }), null);
    assert.equal(nudgeFor({ payload, env: { ...f.env, AIGENT_CAPSULE_NUDGE: '0' }, now: late }), null);
    for (const state of ['idle', 'pressure', 'checkpoint-confirmed', 'clear-submitted', 'HOLD:boot-receipt-missing']) {
      f.writeCycle(waiting({ state }));
      assert.equal(nudgeFor({ payload, env: f.env, now: late }), null, state);
    }
    f.writeCycle(waiting({ cycle_id: null }));
    assert.equal(nudgeFor({ payload, env: f.env, now: late }), null);
    fs.unlinkSync(path.join(f.runtime, 'auto-clear-cycle.json'));
    assert.equal(nudgeFor({ payload, env: f.env, now: late }), null);
    assert.equal(fs.existsSync(path.join(f.runtime, NUDGE_FILE)), false, 'nothing recorded when nothing was said');
  } finally { f.done(); }
});

test('the hook process prints the PostToolUse shape, and exits 0 silently on anything else', () => {
  const f = fixture(waiting({ checkpoint_wait_started_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  try {
    const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, ...f.env } });
    const shown = run(JSON.stringify(payload));
    assert.equal(shown.status, 0, shown.stderr);
    const out = JSON.parse(shown.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /context-capsule skill/);
    for (const junk of ['', 'not json', JSON.stringify(payload)]) {
      const quiet = run(junk);
      assert.equal(quiet.status, 0);
      assert.equal(quiet.stdout, '', `nothing printed for ${JSON.stringify(junk).slice(0, 30)} (the last one: already nudged)`);
    }
  } finally { f.done(); }
});

test('the template wires the hook on every PostToolUse, within the hook budget', () => {
  const template = JSON.parse(fs.readFileSync(path.resolve(path.dirname(HOOK), '..', '.claude', 'settings.json.template'), 'utf8'));
  const entries = template.hooks.PostToolUse.filter((e) => e.matcher === '').flatMap((e) => e.hooks);
  const hook = entries.find((h) => /daemons\/capsule-nudge\.mjs/.test(h.command));
  assert.ok(hook, 'wired');
  assert.ok(hook.timeout <= 10, 'inside the 10 s hook budget');
});

// ── the transport reads the nudge as the request having reached the seat ──────────────
function transportFixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-transport-'));
  let ms = Date.parse('2026-11-15T04:20:00Z');
  const clock = () => new Date(ms);
  clock.advance = (n) => { ms += n; };
  const f = { base, clock, logs: [], cycles: 0, memRoot: path.join(base, 'memory'), homeDir: path.join(base, 'home'), cwd: path.join(base, 'work') };
  const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
  f.capsulePath = path.join(f.memRoot, 'capsules', 'current.md');
  writeJson(f.capsulePath, 'checkpoint');
  f.transcriptPath = core.transcriptPathFor({ ...f, sessionId: SESSION });
  fs.mkdirSync(path.dirname(f.transcriptPath), { recursive: true });
  fs.writeFileSync(f.transcriptPath, '0123456789');
  writeJson(path.join(f.memRoot, 'runtime', 'stop-writer', `${SESSION}.json`), { offset: 10, capsule_path: f.capsulePath });
  writeJson(path.join(f.memRoot, 'runtime', 'boot-receipt.json'), { session_id: SESSION, boot_sequence: 10, source: 'startup', observed_at: clock().toISOString() });
  f.busy = () => fs.appendFileSync(f.transcriptPath, 'x'.repeat(core.CHECKPOINT_TAIL_TOLERANCE_BYTES + 1));
  f.nudge = (cycleId) => writeJson(path.join(f.memRoot, 'runtime', NUDGE_FILE), { cycle_id: cycleId, at: clock().toISOString() });
  f.t = new core.AutoClearTransport({
    ...f, sessionId: SESSION, now: clock, fsImpl: fs, env: {}, acquireLock: false,
    readPressureFn: () => ({ pct: 90, fresh: true, state: 'ok' }),
    selectCapsuleFn: () => ({ capsule: { path: f.capsulePath }, rejected: [] }),
    idFactory: () => `cycle-${++f.cycles}`, log: (line) => f.logs.push(line),
  });
  try { body(f); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}
const start = (t) => { assert.equal(t.tick().state.state, 'pressure'); assert.equal(t.tick().action, 'request-checkpoint'); };

test('a nudge for the live cycle starts the answer bound: the nudged capsule is not abandoned at 5 min', () => transportFixture((f) => {
  start(f.t);
  f.busy();
  f.t.tick();
  f.clock.advance(60_000);
  f.nudge(f.t.state.cycle_id);
  for (let i = 0; i < 9; i += 1) { f.clock.advance(60_000); f.busy(); f.t.tick(); }
  assert.equal(f.logs.some((l) => l.includes('cycle-abandoned-checkpoint-timeout')), false, '10 min in, still waiting for the capsule');
  f.clock.advance(core.CHECKPOINT_ANSWER_TIMEOUT_MS - 9 * 60_000);
  f.busy();
  assert.equal(f.t.tick().status, 'cycle-abandoned-checkpoint-timeout', 'and abandoned at the answer bound from the nudge');
}));

test('a nudge recorded for another cycle is no delivery: the #151 bound holds', () => transportFixture((f) => {
  start(f.t);
  f.busy();
  f.t.tick();
  f.nudge('some-earlier-cycle');
  f.clock.advance(core.CHECKPOINT_WAIT_TIMEOUT_MS);
  f.busy();
  assert.equal(f.t.tick().status, 'cycle-abandoned-checkpoint-timeout');
}));

// ── review of 7b3f57b ──────────────────────────────────────────────────────────────────
test('P1: a subagent tool call is never nudged, and does not spend the main loop\'s nudge', () => {
  const f = fixture(waiting());
  try {
    const late = () => T0 + 5 * 60_000;
    assert.equal(nudgeFor({ payload: { ...payload, agent_id: 'a1b2c3' }, env: f.env, now: late }), null);
    assert.equal(fs.existsSync(path.join(f.runtime, NUDGE_FILE)), false, 'no marker credited for a subagent');
    assert.ok(nudgeFor({ payload, env: f.env, now: late }), 'the main loop is still nudged');
  } finally { f.done(); }
});

test('P2: a cycle whose typed request the host recorded is in its capsule turn: no nudge', () => {
  const f = fixture(waiting({ checkpoint_request_recorded: { cycle_id: 'cyc-157', at: new Date(T0 + 5000).toISOString() } }));
  try {
    assert.equal(nudgeFor({ payload, env: f.env, now: () => T0 + 65_000 }), null);
    f.writeCycle(waiting({ checkpoint_request_recorded: { cycle_id: 'an-older-cycle', at: new Date(T0).toISOString() } }));
    assert.ok(nudgeFor({ payload, env: f.env, now: () => T0 + 65_000 }), 'another cycle\'s record is not this one\'s');
  } finally { f.done(); }
});

test('P3: a claimed cycle prints once; a cycle file nobody ticks is not nudged; the kill switch takes off/false/no', () => {
  const f = fixture(waiting());
  try {
    fs.writeFileSync(path.join(f.runtime, 'capsule-nudge.cyc-157.claim'), '');
    assert.equal(nudgeFor({ payload, env: f.env, now: () => T0 + 5 * 60_000 }), null, 'a parallel hook already claimed the cycle');
    f.writeCycle(waiting({ cycle_id: 'cyc-159' }));
    const cycleFile = path.join(f.runtime, 'auto-clear-cycle.json');
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(cycleFile, old, old);
    assert.equal(nudgeFor({ payload, env: f.env }), null, 'a 3-hour-stale cycle file: automation is not ticking');
    for (const off of ['off', 'FALSE', ' no ']) {
      f.writeCycle(waiting({ cycle_id: `cyc-off-${off.trim()}` }));
      assert.equal(nudgeFor({ payload, env: { ...f.env, AIGENT_CAPSULE_NUDGE: off }, now: () => T0 + 5 * 60_000 }), null, off);
    }
  } finally { f.done(); }
});

test('the skill the text names is the command the runner types (drift guard)', async () => {
  const { CAPSULE_SKILL } = await import('../capsule-nudge.mjs');
  const { CAPSULE_REQUEST_TEXT } = await import('../pty-runner.mjs');
  assert.equal(`/${CAPSULE_SKILL}`, CAPSULE_REQUEST_TEXT);
});

test('a delivery dated in the future is no delivery: marker and record keep the #151 bound', () => transportFixture((f) => {
  start(f.t);
  f.busy();
  f.t.tick();
  const cycleId = f.t.state.cycle_id;
  fs.writeFileSync(path.join(f.memRoot, 'runtime', NUDGE_FILE), JSON.stringify({ cycle_id: cycleId, at: new Date(f.clock().getTime() + 86400000).toISOString() }));
  f.clock.advance(core.CHECKPOINT_WAIT_TIMEOUT_MS);
  f.busy();
  assert.equal(f.t.tick().status, 'cycle-abandoned-checkpoint-timeout', 'a marker a day ahead does not hold the cycle');
}));

test('an unreadable marker (not just a missing one) is logged once, and the #151 bound applies', () => transportFixture((f) => {
  start(f.t);
  f.busy();
  f.t.tick();
  fs.writeFileSync(path.join(f.memRoot, 'runtime', NUDGE_FILE), '{not json');
  for (let i = 0; i < 3; i += 1) { f.clock.advance(60_000); f.busy(); f.t.tick(); }
  assert.equal(f.logs.filter((l) => l.includes('capsule nudge marker unreadable')).length, 1);
}));
