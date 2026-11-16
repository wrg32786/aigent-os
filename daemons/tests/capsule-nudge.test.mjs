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

for (const [offsetMs, abandoned] of [[86400000, true], [0, false]]) {
  test(`N3: a host record dated ${offsetMs ? 'in the future is no delivery' : 'now is a delivery (control)'}`, () => transportFixture((f) => {
    start(f.t);
    f.busy();
    f.t.tick();
    const cycleFile = path.join(f.memRoot, 'runtime', 'auto-clear-cycle.json');
    const cycle = JSON.parse(fs.readFileSync(cycleFile, 'utf8'));
    fs.writeFileSync(cycleFile, JSON.stringify({ ...cycle, checkpoint_request_recorded: { cycle_id: cycle.cycle_id, at: new Date(f.clock().getTime() + offsetMs).toISOString() } }));
    f.clock.advance(core.CHECKPOINT_WAIT_TIMEOUT_MS);
    f.busy();
    assert.equal(f.t.tick().status === 'cycle-abandoned-checkpoint-timeout', abandoned);
  }));
}

test('N3: a missing marker is the ordinary case: nothing is logged', () => transportFixture((f) => {
  start(f.t);
  for (let i = 0; i < 3; i += 1) { f.clock.advance(60_000); f.busy(); f.t.tick(); }
  assert.equal(f.logs.some((l) => l.includes('capsule nudge marker unreadable')), false);
}));

test('N3: a claim prunes every other claim, an older build\'s .stop claim too', () => {
  const f = fixture(waiting());
  try {
    fs.writeFileSync(path.join(f.runtime, 'capsule-nudge.cyc-100.claim'), '');
    fs.writeFileSync(path.join(f.runtime, 'capsule-nudge.cyc-100.stop.claim'), '');
    fs.writeFileSync(path.join(f.runtime, 'capsule-nudge.cyc-157.stop.claim'), '');
    assert.ok(nudgeFor({ payload, env: f.env, now: () => T0 + 5 * 60_000 }));
    assert.deepEqual(fs.readdirSync(f.runtime).filter((n) => n.endsWith('.claim')), ['capsule-nudge.cyc-157.claim']);
  } finally { f.done(); }
});

test('N1: a failed marker write gives the claim back, so a later call can retry', () => {
  const f = fixture(waiting());
  try {
    const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
    assert.equal(nudgeFor({ payload, env: f.env, fsImpl: failing, now: () => T0 + 5 * 60_000 }), null);
    assert.equal(fs.existsSync(path.join(f.runtime, 'capsule-nudge.cyc-157.claim')), false, 'claim returned');
    assert.equal(fs.readdirSync(f.runtime).some((n) => n.endsWith('.tmp')), false, 'no temp left');
    assert.ok(nudgeFor({ payload, env: f.env, now: () => T0 + 5 * 60_000 }), 'the retry nudges');
  } finally { f.done(); }
});

// ── the Stop leg (Titus 2026-11-15 16:57 PT: an idle seat had no tool call to ride) ───────
const stopPayload = { session_id: SESSION, hook_event_name: 'Stop', stop_hook_active: false, cwd: os.tmpdir() };

test('Stop: a cycle in pressure is asked at once, before the PostToolUse minute', () => {
  const f = fixture(waiting({ state: 'pressure', checkpoint_wait_started_at: undefined }));
  try {
    const text = nudgeFor({ payload: stopPayload, env: f.env, now: () => T0 + 5000 });
    assert.match(text, /Before you stop: run the context-capsule skill now/);
    assert.match(text, /at 86% of its context refresh threshold/);
    assert.match(text, /put it in the capsule's waiting_on/, 'F4: an open question survives the clear');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime, NUDGE_FILE), 'utf8')).cycle_id, 'cyc-157');
    assert.equal(nudgeFor({ payload: stopPayload, env: f.env, now: () => T0 + 6000 }), null, 'once per cycle');
    for (const state of ['idle', 'checkpoint-confirmed', 'clear-submitted']) {
      f.writeCycle(waiting({ state, cycle_id: `cyc-${state}` }));
      assert.equal(nudgeFor({ payload: stopPayload, env: f.env, now: () => T0 + 5000 }), null, state);
    }
  } finally { f.done(); }
});

test('F2: a stop another hook already blocked (stop_hook_active) is still asked, once', () => {
  const f = fixture(waiting());
  try {
    const late = () => T0 + 5 * 60_000;
    const active = { ...stopPayload, stop_hook_active: true };
    assert.ok(nudgeFor({ payload: active, env: f.env, now: late }), 'a brevity gate blocked first: still asked');
    assert.equal(nudgeFor({ payload: active, env: f.env, now: late }), null, 'the claim is the loop guard');
  } finally { f.done(); }
});

test('Stop: never a subagent, or a cycle whose request was recorded', () => {
  const f = fixture(waiting());
  try {
    const late = () => T0 + 5 * 60_000;
    assert.equal(nudgeFor({ payload: { ...stopPayload, agent_id: 'a1b2c3' }, env: f.env, now: late }), null, 'subagent');
    f.writeCycle(waiting({ checkpoint_request_recorded: { cycle_id: 'cyc-157', at: new Date(T0).toISOString() } }));
    assert.equal(nudgeFor({ payload: stopPayload, env: f.env, now: late }), null, 'recorded');
    assert.equal(fs.existsSync(path.join(f.runtime, NUDGE_FILE)), false, 'nothing recorded when nothing was said');
  } finally { f.done(); }
});

test('F1: one ask per cycle across both legs, in either order', () => {
  for (const [first, second] of [[payload, stopPayload], [stopPayload, payload]]) {
    const f = fixture(waiting());
    try {
      const late = () => T0 + 5 * 60_000;
      assert.ok(nudgeFor({ payload: first, env: f.env, now: late }), first.hook_event_name ?? 'PostToolUse');
      assert.equal(nudgeFor({ payload: second, env: f.env, now: late }), null, 'the seat already asked is not asked again');
    } finally { f.done(); }
  }
});

test('F3: the marker carries the transcript end at the ask, for the runner\'s ack window', () => {
  const f = fixture(waiting());
  try {
    const transcript = path.join(f.base, 'transcript.jsonl');
    fs.writeFileSync(transcript, 'x'.repeat(1234));
    assert.ok(nudgeFor({ payload: { ...stopPayload, transcript_path: transcript }, env: f.env, now: () => T0 + 5000 }));
    const marker = JSON.parse(fs.readFileSync(path.join(f.runtime, NUDGE_FILE), 'utf8'));
    assert.equal(marker.transcript_offset, 1234);
    assert.equal(marker.session_id, SESSION);
    f.writeCycle(waiting({ cycle_id: 'cyc-160' }));
    assert.ok(nudgeFor({ payload: stopPayload, env: f.env, now: () => T0 + 5000 }), 'no transcript: still asked');
    assert.equal('transcript_offset' in JSON.parse(fs.readFileSync(path.join(f.runtime, NUDGE_FILE), 'utf8')), false,
      'and no offset, so the runner types the request as before');
  } finally { f.done(); }
});

test('the hook process prints the Stop block shape', () => {
  const f = fixture(waiting({ state: 'pressure' }));
  try {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(stopPayload), encoding: 'utf8', env: { ...process.env, ...f.env } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ['decision', 'reason']);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /context-capsule skill/);
    const again = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...stopPayload, stop_hook_active: true }), encoding: 'utf8', env: { ...process.env, ...f.env } });
    assert.equal(again.stdout, '', 'the continuation is not blocked again: the cycle is claimed');
  } finally { f.done(); }
});

test('the template wires the hook on Stop, within the hook budget', () => {
  const template = JSON.parse(fs.readFileSync(path.resolve(path.dirname(HOOK), '..', '.claude', 'settings.json.template'), 'utf8'));
  const hook = template.hooks.Stop.flatMap((e) => e.hooks).find((h) => /daemons\/capsule-nudge\.mjs/.test(h.command));
  assert.ok(hook, 'wired');
  assert.ok(hook.timeout <= 10, 'inside the 10 s hook budget');
});

test('an unreadable marker (not just a missing one) is logged once, and the #151 bound applies', () => transportFixture((f) => {
  start(f.t);
  f.busy();
  f.t.tick();
  fs.writeFileSync(path.join(f.memRoot, 'runtime', NUDGE_FILE), '{not json');
  for (let i = 0; i < 3; i += 1) { f.clock.advance(60_000); f.busy(); f.t.tick(); }
  assert.equal(f.logs.filter((l) => l.includes('capsule nudge marker unreadable')).length, 1);
}));
