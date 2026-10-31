// pty-runner.test.mjs -- deterministic public-runner conformance carrier.
//
// WHY THIS EXISTS: the transport core already proves lifecycle authorization,
// but the PTY carrier owns the last dangerous boundary: operator and control
// bytes share one child input stream.  These tests run the reusable observable
// contract against ManagedPtyRunner with a scripted PTY and schedulers.  The
// real AutoClearTransport persists intent and validates checkpoint/receipt
// observables; only explicitly runner-owned guards are shaped by the adapter.
//
// No callback below advances from wall time.  A scheduled commit, watchdog, or
// control-loop turn runs only when the test invokes its corresponding method.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  AutoClearTransport,
  CAPSULE_ACK_LITERAL,
  CHECKPOINT_TAIL_TOLERANCE_BYTES,
  acquireRunnerLock,
  evaluateCheckpointFreshness,
  releaseRunnerLock,
  transcriptPathFor,
} from '../auto-clear-transport.mjs';
import {
  CAPSULE_REQUEST_TEXT,
  CLEAR_CONTROL_INPUT,
  automaticTextLiteralProblem,
  CLEAR_CONTROL_TEXT,
  COMPOSER_KILL_LINE,
  CONTROL_ENTER,
  DEFAULT_INPUT_HOLD_TTL_MS,
  HOLD_CLEAR_STALLED_AFTER_ACK,
  DEGRADED_NODE_PTY,
  InputOwnershipTracker,
  ManagedPtyRunner,
  WAKE_ENTER_RETRY_LIMIT,
  WAKE_MESSAGE,
  WAKE_SUBMIT_SETTLE_TICKS,
  WAKE_SUBMIT_WATCH_TICKS,
  WAKE_TRANSCRIPT_LITERAL,
  loadNodePty,
  resolvePtyCommand,
  runUnmanaged,
  runPtySession, childEnvironment } from '../pty-runner.mjs';
import {
  GATE_NAME,
  GATE_STALE_MS,
  INTERLOCK_DRAIN_MS,
  PROOF_NAME,
  RELEASE_NAME,
  STATE_NAME,
  acquireGate as acquireInterlockGate,
  readState as readInterlockState,
  releaseGate as releaseInterlockGate,
  releaseMain as interlockReleaseMain,
  runHook as runInterlockHook,
  writeProof as writeInterlockProof,
  sessionDir as interlockSessionDir,
  writeState as writeInterlockState,
} from '../pre-permission-interlock.mjs';
import { defineTransportConformanceSuite } from './transport-conformance.mjs';

// The daemons/ directory, so a fixture can wire the hook by its real path.
const DAEMONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTERLOCK_HOOK_PATH = path.join(DAEMONS_DIR, 'pre-permission-interlock.mjs');
// ─── THE SPELLING install.sh ACTUALLY RENDERS (N1) ──────────────────────────
// Every vector used to wire the hook with a NATIVE path, which is a shape the
// installer does not produce: install.sh renders through `abspath` ->
// `cygpath -u`, so a real Windows `.claude/settings.json` carries
// `node "/c/dev/.../daemons/pre-permission-interlock.mjs"`. The anchored match
// added for F5 rejected exactly that, so a correctly installed Windows seat
// read as `interlock-hook-not-wired` and held every automatic write for ever --
// and the suite could not see it, because the fixture tested the other shape.
// Worse, the anchoring vector's own counterexample (`/some/other/install/...`)
// had the SAME FORM as a real install, so the vector proving "another install's
// copy does not count" would also have rejected this install's own copy.
//
// The fixture therefore renders the MSYS form by DEFAULT. A seat whose settings
// were written by hand in native form is the variant, and I20 pins both.
function msysPath(native) {
  const unified = String(native).split(BACKSLASH_IN_TESTS).join('/');
  return /^[A-Za-z]:\//.test(unified)
    ? `/${unified[0].toLowerCase()}${unified.slice(2)}`
    : unified;
}
const BACKSLASH_IN_TESTS = String.fromCharCode(92);
const INTERLOCK_HOOK_PATH_MSYS = msysPath(INTERLOCK_HOOK_PATH);
// ─── SYNTHETIC ROOTS FOR THE SPELLING VECTORS ──────────────────────────────
// comparablePath is pure string work, so the spellings it has to understand can
// be tested with FIXED strings instead of with whatever shape this host's own
// path happens to have. That matters because the earlier versions of these
// vectors did drive-letter arithmetic on the real path -- `slice(3)` to drop
// `C:/` -- which silently mangles a POSIX path (`/home/...` -> `me/...`) and
// made the assertions pass or fail for the wrong reasons on Linux. Overriding
// the runner's `_interlockHookFile` with a synthetic root makes every case
// deterministic on both platforms, and lets the POSIX root shape be covered on
// Windows and vice versa.
const SYNTHETIC_WIN_HOOK = `C:/synthetic-install/daemons/${'pre-permission-interlock.mjs'}`;
const SYNTHETIC_POSIX_HOOK = `/synthetic-install/daemons/${'pre-permission-interlock.mjs'}`;
// The path minus its root, platform-correctly -- never `slice(3)`.
function withoutRoot(p) {
  const unified = String(p).split(BACKSLASH_IN_TESTS).join('/');
  return unified.replace(/^([A-Za-z]:)?\//, '');
}

const SESSION_ID = 'session-current';
const NEXT_SESSION_ID = 'session-after-clear';
const BASE_TIME = Date.parse('2026-07-30T18:00:00.000Z');
const CHILD_EXIT_CODE = 23;
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function controlledClock(start = BASE_TIME) {
  let milliseconds = start;
  const now = () => new Date(milliseconds);
  now.advance = (amount) => { milliseconds += amount; };
  now.ms = () => milliseconds;
  return now;
}

function writeText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

function writeJson(target, value) {
  return writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

// composer-channel leg 1: every diagnostic this suite reroutes off stderr
// lands here instead — read it back the same way the production sink writes
// it (memRoot/.daemon-errors.log), never via the stderr stream.
function readDaemonErrorLog(memRoot) {
  const file = path.join(memRoot, '.daemon-errors.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(String(value ?? ''), 'utf8');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class ScriptedStream {
  constructor({ columns = 80, rows = 24 } = {}) {
    this.columns = columns;
    this.rows = rows;
    this.isTTY = false;
    this.isRaw = false;
    this.writes = [];
    this.handlers = new Map();
  }

  on(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(callback);
    return this;
  }

  off(name, callback) {
    this.handlers.get(name)?.delete(callback);
    return this;
  }

  emit(name, value) {
    for (const callback of [...(this.handlers.get(name) || [])]) callback(value);
  }

  write(value) {
    this.writes.push(asBuffer(value));
    return true;
  }

  setRawMode(value) {
    this.isRaw = Boolean(value);
  }

  resume() {}
}

class ManualScheduler {
  constructor() {
    this.nextId = 1;
    this.ticks = new Map();
    this.commits = new Map();
    this.watchdogs = new Map();
    // Armed-TTL record, keyed by handle id. The runner passes the ttl as the
    // second argument; dropping it here is what made a fuse sized to the
    // wrong window untestable — the ttl IS the mechanism's observable.
    this.watchdogArms = new Map();
    // Deferred-Enter timers for the two-phase control write, with their
    // recorded delays — the delay IS the mechanism's observable.
    this.enters = new Map();
    this.enterArms = new Map();
  }

  _schedule(collection, callback) {
    const handle = { id: this.nextId, collection };
    this.nextId += 1;
    collection.set(handle.id, callback);
    return handle;
  }

  _clear(handle) {
    handle?.collection?.delete(handle.id);
  }

  scheduleTick(callback) {
    return this._schedule(this.ticks, callback);
  }

  clearTick(handle) {
    this._clear(handle);
  }

  scheduleCommit(callback) {
    return this._schedule(this.commits, callback);
  }

  clearCommit(handle) {
    this._clear(handle);
  }

  scheduleWatchdog(callback, ttl) {
    const handle = this._schedule(this.watchdogs, callback);
    this.watchdogArms.set(handle.id, ttl);
    return handle;
  }

  clearWatchdog(handle) {
    this._clear(handle);
  }

  scheduleEnter(callback, delay) {
    const handle = this._schedule(this.enters, callback);
    this.enterArms.set(handle.id, delay);
    return handle;
  }

  clearEnter(handle) {
    this._clear(handle);
  }

  runOne(collection) {
    const entry = collection.entries().next();
    if (entry.done) return false;
    const [id, callback] = entry.value;
    collection.delete(id);
    callback();
    return true;
  }

  flushCommit() {
    return this.runOne(this.commits);
  }

  fireWatchdog() {
    return this.runOne(this.watchdogs);
  }

  fireEnter() {
    return this.runOne(this.enters);
  }
}

class ScriptedPty {
  constructor({ teardownShape = 'normal' } = {}) {
    this.teardownShape = teardownShape;
    this.writes = [];
    this.resizes = [];
    this.signals = [];
    this.helperNoise = [];
    this.automaticWrites = [];
    this.dataHandlers = new Set();
    this.exitHandlers = new Set();
    this.killed = false;
    this.parentExited = false;
    this.operatorWriteDepth = 0;
    this.pendingManualClears = 0;
    this.failWritesRemaining = 0;
    this.failNextWriteChunk = null;
    this.lastWriteWasControlText = false;
  }

  onData(callback) {
    this.dataHandlers.add(callback);
    return {
      dispose: () => this.dataHandlers.delete(callback),
    };
  }

  onExit(callback) {
    this.exitHandlers.add(callback);
    return {
      dispose: () => this.exitHandlers.delete(callback),
    };
  }

  write(value) {
    const rendered = asBuffer(value);
    if (this.failWritesRemaining > 0) {
      this.failWritesRemaining -= 1;
      throw new Error('scripted PTY write failure');
    }
    if (this.failNextWriteChunk?.equals(rendered)) {
      this.failNextWriteChunk = null;
      throw new Error('scripted targeted PTY write failure');
    }
    this.writes.push(rendered);
    // Control chunks include the automatic kill-line plus three clear shapes:
    // the legacy combined '/clear\r' (operator manual clears), the split text
    // '/clear', and its separately written Enter '\r'. A bare CR counts as
    // control ONLY when it immediately follows the control text — a queued
    // operator Enter flushed later must never consume a control classification
    // (R26 F6).
    const isControlChunk = rendered.equals(Buffer.from(COMPOSER_KILL_LINE))
      || rendered.equals(Buffer.from(CLEAR_CONTROL_INPUT))
      || rendered.equals(Buffer.from(CLEAR_CONTROL_TEXT))
      || (rendered.equals(Buffer.from(CONTROL_ENTER))
        && this.lastWriteWasControlText === true);
    this.lastWriteWasControlText = rendered.equals(Buffer.from(CLEAR_CONTROL_TEXT));
    if (isControlChunk) {
      const isImmediateManual = this.operatorWriteDepth > 0;
      const isDeferredManual = !isImmediateManual && this.pendingManualClears > 0;
      if (isDeferredManual) this.pendingManualClears -= 1;
      // This is a record of the physical fake-PTY call, not a semantic event
      // emitted by the runner.  A second raw write is therefore observable even
      // if a buggy implementation forgets to emit a matching trace event.
      if (!isImmediateManual && !isDeferredManual) {
        this.automaticWrites.push(Buffer.from(rendered));
      }
    }
    return true;
  }

  resize(columns, rows) {
    this.resizes.push({ cols: columns, rows });
  }

  kill(signal) {
    if (signal) {
      this.signals.push(signal);
      return;
    }
    // No handler-conditioned noise here: measured on real node-pty (93b9d2a
    // review, F1), the helper crash follows kill-then-linger regardless of
    // handler disposal. flushHelper() below models the true mechanism —
    // noise iff the parent has not exited promptly after the kill.
    this.killed = true;
  }

  flushHelper() {
    if (this.teardownShape === 'kill-then-linger'
      && this.killed
      && !this.parentExited) {
      this.helperNoise.push(
        'AttachConsole failed\n    at conpty-helper.js:1:1',
      );
    }
  }

  emitData(value) {
    for (const callback of [...this.dataHandlers]) callback(value);
  }

  emitExit(exitCode) {
    for (const callback of [...this.exitHandlers]) {
      callback({ exitCode, signal: 0 });
    }
  }
}

function makeFixture(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `run2-${name}-`));
  const root = path.join(base, 'project');
  const memRoot = path.join(root, 'vault', 'memory');
  const homeDir = path.join(base, 'home');
  const cwd = root;
  const clock = controlledClock();
  const env = {};
  const logs = [];
  const capsulePath = writeText(
    path.join(memRoot, 'capsules', 'current.md'),
    'checkpoint fixture\n',
  );
  const transcriptPath = transcriptPathFor({
    cwd,
    sessionId: SESSION_ID,
    homeDir,
  });
  // NEWLINE-TERMINATED, like every real transcript at rest (verified on the
  // #104 capture: 464897 bytes, last byte 0x0a). The outstanding-tool-call
  // reader treats an unterminated tail as a record that is STILL BEING
  // WRITTEN -- which, on a live seat, is what it is -- and therefore as
  // "cannot say yet". A fixture whose last line never terminates would hold
  // every vector in that transient state forever and test nothing.
  const transcript = '0123456789\n';
  writeText(transcriptPath, transcript);
  const stopPath = path.join(
    memRoot,
    'runtime',
    'stop-writer',
    `${SESSION_ID}.json`,
  );
  writeJson(stopPath, {
    offset: Buffer.byteLength(transcript),
    capsule_path: capsulePath,
    last_delta_sha: 'fixture',
  });
  const bootPath = path.join(memRoot, 'runtime', 'boot-receipt.json');
  writeJson(bootPath, {
    boot_sequence: 10,
    session_id: SESSION_ID,
    source: 'startup',
    observed_at: new Date(clock.ms()).toISOString(),
  });
  const recoverySentinelPath = writeText(
    path.join(memRoot, 'runtime', 'recovery-sentinel.txt'),
    'checkpoint/recovery remains available\n',
  );
  // ─── THE INTERLOCK'S WIRING (#104) ───────────────────────────────────────
  // install.sh renders .claude/settings.json from .claude/settings.json.template
  // and the runner's wiring leg reads exactly that file. A fixture without it is
  // an UNWIRED install, which holds every automatic write by name -- correct
  // behaviour, and the subject of its own vector, but it would turn every OTHER
  // vector into a test of the unwired case. Writing the real shape here is what
  // makes the rest of the suite exercise a LIVE interlock.
  const settingsPath = path.join(root, '.claude', 'settings.json');
  writeJson(settingsPath, {
    hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
      event,
      [{
        matcher: '',
        hooks: [{
          type: 'command',
          // THE RENDERED SHAPE: the MSYS path spelling install.sh produces,
          // and the event name as an ARGV (F7). Both are what a real seat
          // carries, and testing anything else is how N1 got through.
          command: `node "${INTERLOCK_HOOK_PATH_MSYS}" ${event}`,
          timeout: 8000,
        }],
      }],
    ])),
  });
  const selection = {
    capsule: {
      path: capsulePath,
      id: 'current',
      created: BASE_TIME,
      createdRaw: new Date(BASE_TIME).toISOString(),
    },
    rejected: [],
  };

  return {
    base,
    root,
    memRoot,
    homeDir,
    cwd,
    clock,
    env,
    logs,
    capsulePath,
    transcriptPath,
    transcriptSize: Buffer.byteLength(transcript),
    stopPath,
    bootPath,
    recoverySentinelPath,
    settingsPath,
    selection,
    pressure: { pct: 90, fresh: true, state: 'ok' },
  };
}

function makeThresholdWiringProbe(name, env) {
  const fixture = makeFixture(name);
  const pty = new ScriptedPty();
  const stdin = new ScriptedStream();
  const stdout = new ScriptedStream();
  const stderr = new ScriptedStream();
  const processLike = new ScriptedStream();
  const constructed = [];
  let managedSpawnCount = 0;
  let unmanagedSpawnCount = 0;
  // V2 ordering spies: the refusal path's "before any PTY, runner lock, or
  // transport exists" claim is only falsifiable if moving the invalid-check
  // below either call site produces a nonzero count here.
  let nodePtyLoadCount = 0;
  let runnerLockAcquireCount = 0;
  let runnerLockReleaseCount = 0;
  // The environment each managed spawn was given (#98).
  const spawnEnvs = [];

  const result = runPtySession({
    childArgs: ['--continue', '/open'],
    command: 'claude',
    root: fixture.root,
    cwd: fixture.cwd,
    env,
    fsImpl: fs,
    stdin,
    stdout,
    stderr,
    processLike,
    platform: 'linux',
    homeDir: fixture.homeDir,
    loadNodePtyFn: () => {
      nodePtyLoadCount += 1;
      return {
        ok: true,
        module: {
          spawn(command, args, options) {
            managedSpawnCount += 1;
            spawnEnvs.push(options?.env);
            return pty;
          },
        },
      };
    },
    runUnmanagedFn: () => {
      unmanagedSpawnCount += 1;
      return CHILD_EXIT_CODE;
    },
    acquireRunnerLockFn: () => {
      runnerLockAcquireCount += 1;
      return { path: 'run3-threshold-wiring-lock' };
    },
    releaseRunnerLockFn: () => { runnerLockReleaseCount += 1; },
    readKillSwitchFn: () => ({ active: false, code: null, detail: null }),
    readBootReceiptFn: () => ({
      ok: true,
      receipt: readJson(fixture.bootPath),
    }),
    createTransportFn: (options) => {
      constructed.push({ ...options });
      return new AutoClearTransport({
        ...options,
        now: fixture.clock,
        pressureFreshnessMs: 120_000,
        selectCapsuleFn: () => fixture.selection,
        readPressureFn: () => ({ ...fixture.pressure }),
        idFactory: ({ sessionId, bootSequence }) => (
          `run3-${sessionId}-${bootSequence}`
        ),
      });
    },
    exitFn: () => {},
    runnerOptions: {
      scheduleTick: () => null,
      clearTick: () => {},
      scheduleCommit: () => null,
      clearCommit: () => {},
      scheduleWatchdog: () => null,
      clearWatchdog: () => {},
      exitFn: () => {},
    },
  });

  return {
    fixture,
    result,
    stderr,
    constructed,
    spawnEnvs,
    bindTransport() {
      writeJson(fixture.bootPath, {
        boot_sequence: 11,
        session_id: SESSION_ID,
        source: 'startup',
        observed_at: new Date(fixture.clock.ms()).toISOString(),
      });
      return result.runner.tick();
    },
    observed() {
      return {
        // composer-channel leg 1: the threshold-invalid diagnostic must never
        // paint the operator's stderr; it is a byte count here (not text) so
        // this assertion can't be satisfied by moving the words elsewhere.
        stderrBytes: Buffer.concat(stderr.writes).length,
        mode: result.mode,
        runnerPresent: Boolean(result.runner),
        managedSpawnCount,
        transportConstructionCount: constructed.length,
        unmanagedSpawnCount,
        nodePtyLoadCount,
        runnerLockAcquireCount,
        runnerLockReleaseCount,
      };
    },
    loggedLine() {
      return readDaemonErrorLog(fixture.memRoot);
    },
    orderingSpyCounts() {
      return { nodePtyLoadCount, runnerLockAcquireCount };
    },
    close() {
      result.runner?.shutdown({ exitCode: 0, killChild: true });
      fs.rmSync(fixture.base, { recursive: true, force: true });
    },
  };
}

function resolveBashForLauncherVector() {
  const probe = spawnSync(
    'bash',
    ['-c', 'cygpath -w "$(command -v bash)" 2>/dev/null || command -v bash'],
    { encoding: 'utf8' },
  );
  assert.equal(
    probe.status,
    0,
    `RUN3 launcher vectors require bash: ${probe.stderr || probe.error || ''}`,
  );
  const resolved = (probe.stdout || '').trim();
  assert.notEqual(resolved, '', 'RUN3 launcher vectors require a resolved bash path');
  return resolved;
}

function pathForBashLauncherVector(bashPath, target) {
  const probe = spawnSync(
    bashPath,
    [
      '-c',
      'cygpath -u "$1" 2>/dev/null || printf "%s" "$1"',
      'run3-path',
      target,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(
    probe.status,
    0,
    `RUN3 launcher path conversion failed: ${probe.stderr || probe.error || ''}`,
  );
  return (probe.stdout || '').trim();
}

function resolvePowerShellForLauncherVector() {
  const candidates = process.platform === 'win32'
    ? ['pwsh', 'powershell.exe']
    : ['pwsh', 'powershell'];
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      ['-NoLogo', '-NoProfile', '-Command', 'exit 0'],
      { encoding: 'utf8' },
    );
    // V4 pass-through: execute the ps1 contract when this host exposes a
    // PowerShell vantage; the source assertion remains mandatory everywhere.
    if (probe.status === 0) return candidate;
  }
  return null;
}

function runLauncherCapture({
  frontDoor,
  operatorArgs,
  returning,
  powerShellCommand = null,
}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `run3-${frontDoor}-launcher-`));
  const daemonDirectory = path.join(home, 'daemons');
  const binDirectory = path.join(home, 'bin');
  const marker = path.join(home, '.aigent', 'first-run-done');
  const capturePrefix = 'RUN3_LAUNCH_ARGV:';
  try {
    fs.mkdirSync(daemonDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(daemonDirectory, 'pty-runner.mjs'),
      `process.stdout.write('${capturePrefix}' + Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64') + '\\n');\n`,
    );
    // A `claude` shim shadows any real claude on PATH: the unmanaged branch
    // (--no-deps, or a node-less host) is captured instead of live-firing a
    // real CLI from inside the test suite.
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(binDirectory, 'claude-argv.mjs'),
      `process.stdout.write('${capturePrefix}' + Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64') + '\\n');\n`,
    );
    fs.writeFileSync(
      path.join(binDirectory, 'claude'),
      '#!/usr/bin/env bash\nexec node "$(dirname "$0")/claude-argv.mjs" "$@"\n',
    );
    fs.chmodSync(path.join(binDirectory, 'claude'), 0o755);
    fs.writeFileSync(
      path.join(binDirectory, 'claude.cmd'),
      '@node "%~dp0claude-argv.mjs" %*\r\n',
    );
    // V4/V5 launcher shape: select the committed returning or first-run fixed
    // prefix before comparing the complete spawned argv.
    if (returning) {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, '');
    }

    let executable;
    let invocation;
    let launcherHome = home;
    if (frontDoor === 'sh') {
      executable = resolveBashForLauncherVector();
      launcherHome = pathForBashLauncherVector(executable, home);
      invocation = [
        pathForBashLauncherVector(
          executable,
          path.join(REPOSITORY_ROOT, 'launcher', 'aigent.sh'),
        ),
        ...operatorArgs,
      ];
    } else {
      executable = powerShellCommand;
      invocation = [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(REPOSITORY_ROOT, 'launcher', 'aigent.ps1'),
        ...operatorArgs,
      ];
    }

    const run = spawnSync(executable, invocation, {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AIGENT_HOME: launcherHome,
        HOME: launcherHome,
        // V4/V5 compare launcher argv, not Git-for-Windows' POSIX-path
        // translation of the literal fixed slash commands.
        MSYS2_ARG_CONV_EXCL: '/start;/open',
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        USERPROFILE: home,
      },
    });
    assert.equal(
      run.status,
      0,
      `${frontDoor} launcher failed: ${run.stderr || run.error || run.stdout}`,
    );
    const match = (run.stdout || '').match(
      new RegExp(`${capturePrefix}([A-Za-z0-9+/=]+)`),
    );
    assert.ok(
      match,
      `${frontDoor} launcher did not expose captured argv: ${run.stdout}`,
    );
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function persistentProjection(fixture) {
  return {
    capsule: fs.readFileSync(fixture.capsulePath, 'utf8'),
    stopWriter: fs.readFileSync(fixture.stopPath, 'utf8'),
    recovery: fs.readFileSync(fixture.recoverySentinelPath, 'utf8'),
  };
}

function makeCore(fixture, sessionId = SESSION_ID) {
  return new AutoClearTransport({
    memRoot: fixture.memRoot,
    sessionId,
    cwd: fixture.cwd,
    homeDir: fixture.homeDir,
    fsImpl: fs,
    now: fixture.clock,
    env: fixture.env,
    pressureThresholdPct: 80,
    pressureFreshnessMs: 120_000,
    selectCapsuleFn: () => fixture.selection,
    readPressureFn: () => ({ ...fixture.pressure }),
    // `enteredAt` is part of the identity, as it is in the production default
    // (`${sid}:${bootSequence}:${enteredAt}`). Without it two cycles of the
    // same session at the same boot share one cycle_id, and a suite about
    // evidence being bound to ITS OWN cycle could not tell them apart.
    idFactory: ({ sessionId: sid, bootSequence, enteredAt }) => (
      `cycle-${sid}-${bootSequence}-${Date.parse(enteredAt)}`
    ),
    log: (message) => fixture.logs.push(message),
    acquireLock: false,
  });
}

function wrapCore(core, guards) {
  return {
    get state() {
      return core.state;
    },
    get sessionId() {
      return core.sessionId;
    },
    tick() {
      const result = core.tick();
      if (guards.stopIdle === 'missing'
        && result?.state?.state === 'checkpoint-confirmed') {
        const shaped = clone(result);
        delete shaped.observable;
        return shaped;
      }
      return result;
    },
    // Forwarded, because the production runner calls it on the real transport:
    // without it the core's own freshness substitute could never be bound to
    // the cycle that earned the ack, and the ack-supersedes-tail-arithmetic
    // path (the one that lifts HOLD:checkpoint-transcript-short) would be
    // unreachable from this carrier.
    noteCapsuleAck(detail) {
      return core.noteCapsuleAck?.(detail);
    },
    // Forwarded for the same reason: the production runner calls it on the real
    // transport, and without it here the durable classification that carries a
    // rejection across a relaunch (re-review 5556245936, S1) would be
    // unreachable from this carrier -- the exact shape of the F1 defect, where
    // a feature hid from every vector because the harness never wired it.
    noteAckClassification(detail) {
      return core.noteAckClassification?.(detail);
    },
    beginClearSubmission() {
      return core.beginClearSubmission();
    },
    confirmClearObserved(receipt) {
      return core.confirmClearObserved(receipt);
    },
    close() {
      return core.close();
    },
  };
}

function eventText(event) {
  if (event?.detail === null || event?.detail === undefined) return event?.name;
  let detail;
  try { detail = JSON.stringify(event.detail); } catch { detail = String(event.detail); }
  return `${event?.name}:${detail}`;
}

function queuedByteLength(runner) {
  return runner
    ? runner.queuedInput.reduce(
      (total, value) => total + Buffer.byteLength(String(value), 'utf8'),
      0,
    )
    : 0;
}

function decisionFrom(runner) {
  if (!runner) return null;
  if (runner.lastReason?.code) return clone(runner.lastReason);
  if (runner.lastCoreResult?.code) {
    return {
      code: runner.lastCoreResult.code,
      detail: clone(runner.lastCoreResult.detail),
    };
  }
  const held = runner.lastCoreResult?.state?.hold;
  return held?.code ? { code: held.code, detail: clone(held.detail) } : null;
}

class RunnerHarness {
  constructor(options) {
    this.options = {
      mode: 'managed',
      ptyLoad: 'ok',
      lockState: 'free',
      pauseBeforeControlWrite: false,
      teardownShape: 'normal',
      stdinTty: false,
      ...options,
    };
    this.fixture = makeFixture(
      `${this.options.mode}-${this.options.ptyLoad}-${this.options.lockState}`,
    );
    this.scheduler = new ManualScheduler();
    this.stdin = new ScriptedStream();
    // start() takes input ownership only on a TTY (pty-runner.mjs isTTY guard),
    // so raw-mode vectors must opt in — the fake defaults to isTTY=false and
    // every pre-existing test runs with the raw-mode path dormant.
    if (this.options.stdinTty) this.stdin.isTTY = true;
    this.stdout = new ScriptedStream({ columns: 100, rows: 30 });
    this.stderr = new ScriptedStream();
    this.processLike = new ScriptedStream();
    this.pty = new ScriptedPty({
      teardownShape: this.options.teardownShape,
    });
    this.guards = {
      stopIdle: 'present',
      controlLock: true,
      checkpoint: 'ok',
      killSwitch: false,
    };
    this.runner = null;
    this.core = null;
    this.transport = null;
    this.result = null;
    this.managedSpawnCount = 0;
    this.unmanagedSpawnCount = 0;
    this.semanticWrites = [];
    this.checkpointCalls = [];
    this.semanticParentWrites = [];
    this.semanticResizes = [];
    this.semanticSignals = [];
    this.sigintWriteIndexes = new Set();
    this.semanticExitCode = null;
    this.degradedState = null;
    this.closed = false;
    this.baselinePersistence = persistentProjection(this.fixture);
    this._start();
  }

  _readKillSwitch() {
    return this.guards.killSwitch
      ? { active: true, code: 'kill-switch-test', detail: 'fixture' }
      : { active: false, code: null, detail: null };
  }

  // ─── DRIVING THE SHIPPED INTERLOCK HOOK (#104) ───────────────────────────
  // runHook is the function the hook's own main() calls, so these vectors
  // exercise the code that ships rather than a model of it. The payload shape
  // is MEASURED from a real host run (2026-10-25, binary 2.1.310, disposable
  // profile): PreToolUse and PostToolUse carry session_id, transcript_path,
  // cwd, hook_event_name, tool_name, tool_input AND tool_use_id; Stop carries
  // the first four plus stop_hook_active. The one fact that decided the design
  // is also from that run: the DENIED Read produced PreToolUse and NO
  // PostToolUse, while the allowed Glob produced both -- so a cancelled dialog
  // is cleared by the Stop sweep, never by PostToolUse.
  //
  // gateBudgetMs defaults to 0 and sleep to a no-op, because nothing in this
  // suite may advance from wall time. The vectors that are ABOUT the bounded
  // wait pass their own.
  interlockHook(event, extra = {}, options = {}) {
    return runInterlockHook({
      payload: {
        session_id: this.runner?.sessionId ?? SESSION_ID,
        transcript_path: this.fixture.transcriptPath,
        cwd: this.fixture.cwd,
        hook_event_name: event,
        ...extra,
      },
      event,
      env: this.fixture.env,
      now: () => this.fixture.clock.ms(),
      pid: 909,
      processLike: { kill: () => true },
      gateBudgetMs: 0,
      sleep: () => {},
      ...options,
    });
  }

  // The host has had a turn. That is the ONLY liveness evidence a session with
  // no tool calls can produce, and it is why the observed leg counts Stop at
  // all -- see leg 3's `toolUsesObserved === 0` exception.
  interlockObserved() {
    return this.interlockHook('Stop', { stop_hook_active: false });
  }

  // THE SHAPE OF A SEAT THAT HAS USED A TOOL. Leg 3 requires `pre_runs >= 1`
  // once the reader has parsed any tool_use, because `stop_runs` alone proves
  // the file runs and not that PreToolUse is wired -- and PreToolUse is the
  // only invocation that protects anything. Any seat that reaches context
  // pressure has made tool calls, so priming with a Stop alone was modelling a
  // seat that cannot exist. One marked-and-cleared call is the faithful
  // minimum; a vector that wants the hook to have missed calls uses
  // `openToolCall(..., { hook: false })` on top of it.
  interlockUsedATool(id = 'toolu_PRIMED') {
    this.interlockPermissionCheck(id);
    return this.interlockToolFinished(id);
  }

  // A permission check is starting for `id`.
  interlockPermissionCheck(id = 'toolu_TEST', tool = 'Read') {
    return this.interlockHook('PreToolUse', { tool_use_id: id, tool_name: tool, tool_input: {} });
  }

  interlockToolFinished(id = 'toolu_TEST', tool = 'Read') {
    return this.interlockHook('PostToolUse', {
      tool_use_id: id, tool_name: tool, tool_input: {}, tool_response: {},
    });
  }

  interlockDir() {
    return interlockSessionDir({
      memRoot: this.fixture.memRoot,
      sessionId: this.runner?.sessionId ?? SESSION_ID,
      env: this.fixture.env,
    });
  }

  interlockState() {
    const read = readInterlockState({ dir: this.interlockDir() });
    return read.ok ? read.state : null;
  }

  // THE OPERATOR'S DELIBERATE ACT, through the SHIPPED subcommand rather than
  // by writing the file by hand, so no vector can pass against a shape an
  // operator could not actually produce. Returns the exit code.
  interlockRelease(reason) {
    // AIGENT_ROOT is what the installed .claude/settings.json sets, and it is
    // how an operator points the subcommand at the right install. Without it
    // releaseMain resolves from the CWD -- which is the footgun its own proof
    // check now refuses rather than writing somewhere harmless and claiming
    // success.
    return interlockReleaseMain([this.runner?.sessionId ?? SESSION, reason], {
      env: { ...this.fixture.env, AIGENT_ROOT: this.fixture.cwd },
      now: () => this.fixture.clock.ms(),
    });
  }

  _runnerOptions() {
    return {
      scheduleTick: (callback) => this.scheduler.scheduleTick(callback),
      clearTick: (handle) => this.scheduler.clearTick(handle),
      scheduleCommit: (callback) => this.scheduler.scheduleCommit(callback),
      clearCommit: (handle) => this.scheduler.clearCommit(handle),
      scheduleWatchdog: (callback, ttl) => this.scheduler.scheduleWatchdog(callback, ttl),
      clearWatchdog: (handle) => this.scheduler.clearWatchdog(handle),
      scheduleEnter: (callback, delay) => this.scheduler.scheduleEnter(callback, delay),
      clearEnter: (handle) => this.scheduler.clearEnter(handle),
      exitFn: (code) => {
        this.semanticExitCode = code;
        this.pty.parentExited = true;
      },
    };
  }

  _startDirectManaged() {
    // PRODUCTION FIRST-BIND SHAPE. runPtySession builds the runner with a
    // transportFactory and NO transport (pty-runner.mjs, the runPtySession
    // construction site), so every real seat's first tick goes through
    // _bindCurrentSession. Every vector in this suite injected `transport`
    // instead, which is why a defect on that path could hide from 198 of them
    // (review of 78a2577, F1). `bindOnFirstTick` reproduces the real shape.
    const bindOnFirstTick = this.options.bindOnFirstTick === true;
    this.core = bindOnFirstTick ? null : makeCore(this.fixture);
    this.transport = this.core === null ? null : wrapCore(this.core, this.guards);
    this.managedSpawnCount = 1;
    this.runner = new ManagedPtyRunner({
      ptyProcess: this.pty,
      memRoot: this.fixture.memRoot,
      sessionId: bindOnFirstTick ? null : SESSION_ID,
      transport: this.transport,
      transportFactory: (receipt) => {
        const core = makeCore(this.fixture, receipt.session_id);
        // Keep the bound core reachable for the vectors that then drive it.
        if (this.core === null) this.core = core;
        return wrapCore(core, this.guards);
      },
      baselineBootSequence: 10,
      fsImpl: fs,
      env: this.fixture.env,
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      terminal: this.stdout,
      processLike: this.processLike,
      cwd: this.fixture.cwd,
      homeDir: this.fixture.homeDir,
      now: this.fixture.clock,
      readBootReceiptFn: () => ({
        ok: true,
        receipt: readJson(this.fixture.bootPath),
      }),
      readKillSwitchFn: () => this._readKillSwitch(),
      readCheckpointObservableFn: (args) => {
        // Record the runner's actual argument object — the ackFresh flag it
        // does (or does not) hand over IS the mechanism under test.
        this.checkpointCalls.push(args);
        return evaluateCheckpointFreshness({
          memRoot: this.fixture.memRoot,
          sessionId: this.runner?.sessionId || SESSION_ID,
          cwd: this.fixture.cwd,
          homeDir: this.fixture.homeDir,
          fsImpl: fs,
          selectCapsuleFn: () => this.fixture.selection,
          ackFresh: args?.ackFresh === true,
        });
      },
      log: (message) => this.fixture.logs.push(message),
      ...this._runnerOptions(),
    });
    this.runner.start();
    this.result = { mode: 'managed', runner: this.runner, exitCode: null };
  }

  _startPublicFrontDoor() {
    const lockPath = path.join(
      this.fixture.memRoot,
      'runtime',
      'auto-clear-transport.lock',
    );
    if (this.options.lockState === 'live'
      || this.options.lockState === 'stale') {
      writeJson(lockPath, {
        pid: 303,
        started_at: '2026-07-30T17:00:00.000Z',
      });
    }

    const acquire = ({ memRoot, fsImpl, log }) => acquireRunnerLock({
      memRoot,
      fsImpl,
      now: this.fixture.clock,
      pid: 404,
      isPidAlive: (pid) => (
        this.options.lockState === 'live' && pid === 303
      ),
      log,
    });
    const loadNodePtyFn = () => {
      if (this.options.ptyLoad === 'fail') {
        return {
          ok: false,
          code: 'node-pty-load-failed',
          detail: 'scripted missing module',
        };
      }
      return {
        ok: true,
        module: {
          spawn: () => {
            this.managedSpawnCount += 1;
            return this.pty;
          },
        },
      };
    };
    const runUnmanagedFn = () => {
      this.unmanagedSpawnCount += 1;
      return CHILD_EXIT_CODE;
    };
    this.result = runPtySession({
      childArgs: ['--continue', '/open'],
      root: this.fixture.root,
      cwd: this.fixture.cwd,
      env: this.fixture.env,
      fsImpl: fs,
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      processLike: this.processLike,
      platform: process.platform,
      homeDir: this.fixture.homeDir,
      forceUnmanaged: this.options.mode === 'unmanaged',
      loadNodePtyFn,
      runUnmanagedFn,
      acquireRunnerLockFn: acquire,
      releaseRunnerLockFn: releaseRunnerLock,
      readKillSwitchFn: () => this._readKillSwitch(),
      log: (message) => this.fixture.logs.push(message),
      exitFn: (code) => { this.semanticExitCode = code; },
      runnerOptions: this._runnerOptions(),
    });
    this.runner = this.result.runner || null;
    if (this.result.mode === 'degraded') this.degradedState = this.result.code;
    if (this.result.exitCode !== null && this.result.exitCode !== undefined) {
      this.semanticExitCode = this.result.exitCode;
    }
  }

  _start() {
    const needsFrontDoor = this.options.mode === 'unmanaged'
      || this.options.ptyLoad === 'fail'
      || this.options.lockState !== 'free';
    if (needsFrontDoor) this._startPublicFrontDoor();
    else this._startDirectManaged();
    this.interlockPrime();
  }

  // ─── A LIVE INTERLOCK IS THE DEFAULT FIXTURE STATE (#104) ────────────────
  // Every gated boundary now requires the interlock's four evidence legs, and
  // one of them is EMPIRICAL: the host must have invoked the hook for this
  // session. A fixture that never does is an unproven interlock, which holds
  // every automatic write by name -- so without this the whole suite would be
  // a test of the held case.
  //
  // What it models is the real sequence: the runner writes its proof, and then
  // the host's Stop hook fires at the end of a turn. `interlockAutoPrime:
  // false` opts a vector out, which is how the missing/stale/rebind vectors
  // get at the unproven states.
  //
  // RE-PRIMED ON REBIND, deliberately and for the same reason. A rebind rotates
  // the session id and voids the binding (that is the restart story), so the new
  // session's first turn is what re-establishes evidence -- and on a real seat
  // that turn is the wake prompt, which happens before the retry window
  // matters. A vector that wants to see the UNPROVEN post-rebind state opts out.
  interlockPrime() {
    if (this.options.interlockAutoPrime === false) return false;
    const sessionId = this.runner?.sessionId ?? null;
    if (sessionId === null) return false;
    if (this.interlockPrimedFor === sessionId) return false;
    this.interlockPrimedFor = sessionId;
    if (typeof this.runner._ensureInterlockProof === 'function') {
      this.runner._ensureInterlockProof();
    } else {
      // THE FAIL-FIRST SHIM, and it exists so the red run is honest. Against a
      // PRE-FIX runner there is no _ensureInterlockProof, so nothing would write
      // the proof the hook keys on, the hook would be inert, and every I vector
      // would fail on its own SETUP rather than on the defect. Writing the proof
      // here puts the evidence on disk exactly as the fix does -- so the red
      // result is "the runner could not see a permission check that was recorded
      // for it", which is the actual fail-open, rather than "the test could not
      // arrange its fixture".
      writeInterlockProof({
        dir: this.interlockDir(),
        proof: {
          nonce: `fail-first-${sessionId}`,
          session_id: sessionId,
          runner_pid: process.pid,
          hook_path: INTERLOCK_HOOK_PATH,
          hook_sha256: 'fail-first-shim',
          created_at: new Date(this.fixture.clock.ms()).toISOString(),
        },
      });
    }
    this.interlockObserved();
    this.interlockUsedATool();
    return true;
  }

  primeAuthorized() {
    assert.ok(this.core, 'managed core is required');
    if (this.core.state.state === 'checkpoint-confirmed') return;
    assert.equal(this.core.tick().state.state, 'pressure');
    assert.equal(this.core.tick().state.state, 'checkpoint-requested');
    assert.equal(this.core.tick().state.state, 'checkpoint-confirmed');
    // The clear now requires the capsule ack for the cycle (capsule -> ack ->
    // clear). Tests that exercise OTHER guards prime it here so each keeps
    // testing its own thing; the ack gate itself has its own test.
    // Through the runner's only evidence writer, BOUND to the cycle the core
    // is in: ack evidence is identity-bound (#91), so there is no longer a
    // flag a test can flip to mint an authorization out of nothing.
    this.grantAck();
    this.runner.output.observe();
    this.runner.output.observe();
  }

  // The cycle the runner is currently reasoning about.
  cycleId() {
    return this.runner?.lastCoreResult?.state?.cycle_id
      ?? this.core?.state?.cycle_id
      ?? null;
  }

  grantAck(cycleId = this.cycleId()) {
    assert.ok(cycleId, 'an ack must name the cycle it belongs to');
    assert.equal(
      this.runner._latchCapsuleAck({ cycleId, source: 'test-prime' }), true,
      'the runner must accept ack evidence for the live cycle',
    );
    return cycleId;
  }

  revokeAck(reason = 'test-revoke') {
    this.runner._invalidateCapsuleAck(reason);
  }

  armAckWatch(cycleId = this.cycleId()) {
    assert.ok(cycleId, 'an ack window must name the cycle it belongs to');
    return this.runner._armCapsuleAckWatch(cycleId);
  }

  // VERSION-TOLERANT READERS. These exist so every #90/#91 vector's SETUP is
  // expressible against the pre-fix build as well, and the first assertion that
  // goes red there is a behavioural one rather than "that field does not exist".
  // Pre-fix the ack was a boolean plus a bare offset; post-fix it is an
  // identity-bound record plus an identity-bound window.
  ackHeld() {
    return this.runner.capsuleAck !== undefined
      ? this.runner.capsuleAck !== null
      : this.runner.capsuleAckSeen === true;
  }

  ackWindowOpen() {
    return this.runner.capsuleAckWatch !== undefined
      ? this.runner.capsuleAckWatch !== null
      : this.runner.capsuleAckSearchFrom !== null;
  }

  ackWindowFrom() {
    if (this.runner.capsuleAckWatch !== undefined) {
      return this.runner.capsuleAckWatch === null ? null : this.runner.capsuleAckWatch.from;
    }
    return this.runner.capsuleAckSearchFrom;
  }

  // A deliberately hostile window: opened at `from` on `cycleId`, bypassing the
  // production opener. Nothing in production can do this -- it exists so the
  // single-spend property can be tested on the SPEND RECORD rather than on the
  // opener happening never to point at the old literal again.
  forceAckWindow(cycleId, from) {
    if (this.runner.capsuleAckWatch !== undefined) {
      this.runner.capsuleAckWatch = {
        session_id: this.runner.sessionId,
        cycle_id: cycleId,
        from,
        drained: false,
      };
    } else {
      this.runner.capsuleAckSeen = false;
      this.runner.capsuleAckSearchFrom = from;
    }
  }

  setGuard(name, value) {
    switch (name) {
      case 'outputSettled':
        if (value === false) this.runner.output.note('busy-output-guard');
        break;
      case 'stopIdle':
        this.guards.stopIdle = value;
        break;
      case 'sessionBinding':
        if (value === 'stale') {
          writeJson(this.fixture.bootPath, {
            boot_sequence: 10,
            session_id: 'stale-other-session',
            source: 'startup',
            observed_at: new Date(this.fixture.clock.ms()).toISOString(),
          });
        }
        break;
      case 'controlLock':
        this.guards.controlLock = value;
        break;
      case 'inputState':
        if (value === 'unknown') {
          this.runner.input.knownEmpty = false;
          this.runner.input.unknown = true;
        } else if ([
          'active-paste-only',
          'active-control-only',
          'unknown-only',
        ].includes(value)) {
          const baseSnapshot = this.runner.input.snapshot.bind(this.runner.input);
          this.runner.input.snapshot = () => ({
            ...baseSnapshot(),
            knownEmpty: true,
            activePaste: value === 'active-paste-only',
            activeControl: value === 'active-control-only',
            unknown: value === 'unknown-only',
          });
        }
        break;
      case 'checkpoint':
        this.guards.checkpoint = value;
        if (value === 'failed') {
          // Must EXCEED the announcement budget to be real post-checkpoint
          // activity. A ~26-byte line used to sit here; under the derived
          // budget that is inside one capped acknowledgement and is correctly
          // tolerated, so the checkpoint no longer failed and this guard
          // silently stopped guarding.
          fs.appendFileSync(
            this.fixture.transcriptPath,
            `\nactivity after checkpoint ${'x'.repeat(CHECKPOINT_TAIL_TOLERANCE_BYTES + 1)}\n`,
          );
          // A live ack SUPERSEDES the byte arithmetic, so leaving it set here
          // would make this guard stop guarding again -- the exact failure its
          // comment above records. Real conversation past the capture means the
          // capsule no longer covers the conversation: that cycle's ack is void.
          this.revokeAck('test-checkpoint-failed');
        }
        break;
      case 'killSwitch':
        this.guards.killSwitch = Boolean(value);
        break;
      default:
        throw new Error(`unknown scripted guard ${name}`);
    }
  }

  attemptAutomaticClear() {
    const result = this.runner.tick();
    if (this.guards.controlLock === false
      && this.runner.phase === 'prepared') {
      this.runner.controlLockHeld = false;
    }
    return result;
  }

  forceDuplicateAttempt() {
    // The first clear SPENT the ack, which now refuses ahead of the core.
    // This helper exists to reach the core's duplicate-intent guard, so give
    // it a fresh ack -- the ack gate has its own test. The spend record is
    // identity-bound and refuses a second latch for the same cycle (single
    // spending, #91), so clear it first: this helper is simulating a second
    // ack, not a second spend of the first one.
    this.runner.capsuleAckSpent = null;
    this.grantAck();
    const output = this.runner.output.observe();
    const result = this.runner._prepareSubmission(
      this.runner.lastCoreResult,
      output,
    );
    return { code: result?.code || null };
  }

  drive() {
    const result = this.runner?.tick?.();
    // A tick may have rebound the session (post-clear wake). Re-prime AFTER it,
    // so the vector under test sees the tick's own verdict unprimed and the
    // NEXT one sees a proven interlock.
    this.interlockPrime();
    return result;
  }

  flushControl() {
    return this.scheduler.flushCommit();
  }

  operator(value) {
    if (this.runner) {
      const rendered = asBuffer(value);
      if ((this.runner.inputHold || this.runner.wakeEnterHandle !== null)
        && rendered.equals(Buffer.from(CLEAR_CONTROL_INPUT))) {
        this.pty.pendingManualClears += 1;
      }
      this.pty.operatorWriteDepth += 1;
      try {
        this.stdin.emit('data', value);
      } finally {
        this.pty.operatorWriteDepth -= 1;
      }
    } else {
      this.semanticWrites.push(asBuffer(value));
    }
  }

  childOutput(value) {
    if (this.runner) {
      this.pty.emitData(value);
    } else {
      this.semanticParentWrites.push(asBuffer(value));
    }
  }

  resize(columns, rows) {
    if (this.runner) {
      this.stdout.columns = columns;
      this.stdout.rows = rows;
      this.stdout.emit('resize');
      return true;
    }
    this.semanticResizes.push({ cols: columns, rows });
    return true;
  }

  sigint() {
    if (this.runner) {
      const before = this.pty.writes.length;
      this.processLike.emit('SIGINT');
      if (process.platform === 'win32'
        && this.pty.writes.length === before + 1
        && this.pty.writes[before].equals(Buffer.from([0x03]))) {
        this.sigintWriteIndexes.add(before);
      }
      return true;
    }
    this.semanticSignals.push('SIGINT');
    return true;
  }

  childExit(exitCode) {
    if (this.runner) {
      this.pty.emitExit(exitCode);
    } else {
      this.semanticExitCode = exitCode;
    }
  }

  observeClearReceipt(kind) {
    const current = readJson(this.fixture.bootPath);
    const receipt = {
      boot_sequence: kind === 'stale' ? 10 : 11,
      session_id: kind === 'fresh' ? NEXT_SESSION_ID : SESSION_ID,
      source: kind === 'wrong-source' ? 'resume' : 'clear',
      observed_at: new Date(this.fixture.clock.ms() + 1000).toISOString(),
    };
    writeJson(this.fixture.bootPath, receipt);
    this.pty.emitData(`${kind}-receipt-context-output\r\n`);
    return { previous: current, current: receipt };
  }

  cancel() {
    return this.runner.cancel('runner-test-cancelled');
  }

  fireWatchdog() {
    return this.scheduler.fireWatchdog();
  }

  fireEnter() {
    return this.scheduler.fireEnter();
  }

  shutdown() {
    return this.runner?.shutdown?.({
      exitCode: 0,
      killChild: true,
    });
  }

  flushHelper() {
    this.pty.flushHelper();
  }

  persistentState(which) {
    if (which === 'baseline') return clone(this.baselinePersistence);
    return persistentProjection(this.fixture);
  }

  snapshot() {
    const runnerSnapshot = this.runner?.snapshot?.();
    const automaticWrites = this.runner
      ? this.pty.automaticWrites.map(asBuffer)
      : [];
    const childWrites = this.runner
      ? this.pty.writes
        .filter((_entry, index) => !this.sigintWriteIndexes.has(index))
        .map(asBuffer)
      : this.semanticWrites.map(asBuffer);
    const parentWrites = this.runner
      ? this.stdout.writes.map(asBuffer)
      : this.semanticParentWrites.map(asBuffer);
    const resizes = this.runner
      ? this.pty.resizes.map((entry) => ({ ...entry }))
      : this.semanticResizes.map((entry) => ({ ...entry }));
    const signals = this.runner
      ? [
        ...this.pty.signals,
        ...Array.from(this.sigintWriteIndexes, () => 'SIGINT'),
      ]
      : [...this.semanticSignals];
    const coreState = this.core?.state?.state
      ?? this.runner?.transport?.state?.state
      ?? 'unmanaged';
    const clearIntent = clone(
      this.core?.state?.clear_intent
        ?? this.runner?.transport?.state?.clear_intent
        ?? null,
    );
    // composer-channel leg 1: the four pre-handoff diagnostics in
    // runPtySession now write the memRoot file directly (the same
    // "file is the record" pattern as _noteSubmissionRefusal), bypassing
    // both the injected `log` spy and stderr on purpose. Read that file back
    // too, or this harness's front-door scenarios go blind to them.
    const logs = [
      ...this.fixture.logs.map((entry) => asBuffer(entry)),
      ...this.stderr.writes.map(asBuffer),
      asBuffer(readDaemonErrorLog(this.fixture.memRoot)),
    ];
    return {
      automaticWrites,
      childWrites,
      parentWrites,
      holdActive: Boolean(runnerSnapshot?.inputHold),
      queuedInputBytes: queuedByteLength(this.runner),
      watchdogArmed: Boolean(runnerSnapshot?.watchdogArmed),
      lastDecision: decisionFrom(this.runner),
      coreState,
      clearIntent,
      resizes,
      signals,
      runnerExitCode: this.semanticExitCode,
      managed: this.result?.mode === 'managed',
      managedSpawnCount: this.managedSpawnCount,
      unmanagedSpawnCount: this.unmanagedSpawnCount,
      degradedState: this.degradedState,
      logs,
      helperNoise: this.pty.helperNoise.map(asBuffer),
      childKilled: this.pty.killed,
      events: this.runner?.events?.map(eventText) || [],
    };
  }

  // RELAUNCH: a new process over the SAME seat. Everything in-memory is
  // discarded (runner, transport core, PTY, schedulers, trackers); everything
  // on disk -- the persisted cycle, the transcript, the stop-writer record,
  // the boot receipt -- survives exactly as the previous process left it. This
  // is the shape both #90 restore defects live in, and it cannot be
  // reproduced by poking fields on a live runner.
  relaunch() {
    if (this.runner && !this.runner.closed) {
      this.runner.shutdown({ exitCode: 0, killChild: true });
    }
    this.scheduler = new ManualScheduler();
    this.stdin = new ScriptedStream();
    if (this.options.stdinTty) this.stdin.isTTY = true;
    this.stdout = new ScriptedStream({ columns: 100, rows: 30 });
    this.stderr = new ScriptedStream();
    this.processLike = new ScriptedStream();
    this.pty = new ScriptedPty({ teardownShape: this.options.teardownShape });
    this.checkpointCalls = [];
    this.sigintWriteIndexes = new Set();
    // A RELAUNCH CANNOT INHERIT THE OLD PROCESS'S INTERLOCK EVIDENCE (#104),
    // and that is the point rather than an inconvenience: the new runner writes
    // a new proof with a NEW nonce, so the state file the previous binding left
    // behind reads as `interlock-state-stale` and every automatic write is held
    // until the host invokes the hook again. On a real seat that is the next
    // Stop, seconds away; here it is this re-prime. The vector that asserts the
    // UNPROVEN relaunch state opts out with `interlockAutoPrime: false`.
    this.interlockPrimedFor = null;
    this._startDirectManaged();
    this.interlockPrime();
    return this.runner;
  }

  // The persisted cycle record, as the next process would read it.
  cycleState() {
    return readJson(path.join(this.fixture.memRoot, 'runtime', 'auto-clear-cycle.json'));
  }

  writeCycleState(value) {
    return writeJson(
      path.join(this.fixture.memRoot, 'runtime', 'auto-clear-cycle.json'),
      value,
    );
  }

  // The Stop hook's record, whose `offset` is the transcript size at Stop time
  // -- i.e. PAST any ack the turn produced. Borrowing it as an ack search
  // boundary is #90 shape 1.
  writeStopRecordAtTranscriptEnd() {
    const size = fs.statSync(this.fixture.transcriptPath).size;
    writeJson(this.fixture.stopPath, {
      offset: size,
      capsule_path: this.fixture.capsulePath,
      last_delta_sha: 'fixture',
    });
    return size;
  }

  events(name) {
    return (this.runner?.events ?? []).filter((event) => event.name === name);
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    if (this.runner && !this.runner.closed) {
      this.runner.shutdown({ exitCode: 0, killChild: true });
    }
    fs.rmSync(this.fixture.base, { recursive: true, force: true });
  }
}

const adapter = {
  name: 'public ManagedPtyRunner',
  createHarness: (options) => new RunnerHarness(options),
};

defineTransportConformanceSuite(adapter, {
  automaticControl: [
    Buffer.from(COMPOSER_KILL_LINE),
    Buffer.from(CLEAR_CONTROL_TEXT),
    Buffer.from(CONTROL_ENTER),
  ],
  childExitCode: CHILD_EXIT_CODE,
  degradedPattern: /DEGRADED:auto-clear-node-pty-unavailable/,
});

test('input ownership parser remains fail-closed across fragmented controls and paste', () => {
  const tracker = new InputOwnershipTracker();
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001b[');
  assert.equal(tracker.snapshot().activeControl, true);
  assert.equal(tracker.snapshot().knownEmpty, false);
  tracker.observe('A');
  assert.equal(tracker.snapshot().unknown, true);
  assert.equal(tracker.snapshot().knownEmpty, false);
  // Review of 436c1dd: a CR on a tainted line is UNCERTAIN, never a
  // submission on its own; the runner's transcript evidence resolves it.
  // confirmSubmission() stands in for that evidence throughout this test.
  tracker.observe('\r');
  assert.equal(tracker.snapshot().knownEmpty, false, 'CR after a completed arrow is not proof of submission');
  assert.equal(tracker.snapshot().pendingSubmission, true);
  assert.equal(tracker.confirmSubmission(), true);
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001b[200~pasted\rtext');
  assert.equal(tracker.snapshot().activePaste, true);
  assert.equal(tracker.snapshot().knownEmpty, false);
  tracker.observe('\u001b[201~');
  assert.equal(tracker.snapshot().activePaste, false);
  assert.equal(tracker.snapshot().knownEmpty, false);
  assert.equal(tracker.snapshot().unknown, false, 'a completed paste is observed byte-for-byte: no taint survives it');
  tracker.observe('\r');
  assert.equal(tracker.snapshot().knownEmpty, true, 'the Enter after a paste is a clean boundary');

  tracker.observe('\u001b[');
  tracker.observe('\r');
  assert.equal(
    tracker.snapshot().activeControl,
    true,
    'CR inside an incomplete CSI must not fabricate an empty prompt',
  );
  tracker.observe('A\r');
  assert.equal(tracker.snapshot().knownEmpty, false, 'the CR after the completed control is uncertain');
  assert.equal(tracker.snapshot().pendingSubmission, true);
  assert.equal(tracker.confirmSubmission(), true);
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001b]0;title\r');
  assert.equal(
    tracker.snapshot().activeControl,
    true,
    'CR inside OSC must remain fail-closed until its terminator',
  );
  tracker.observe('\u0007\r');
  assert.equal(tracker.snapshot().knownEmpty, false, 'the CR after the OSC is uncertain');
  assert.equal(tracker.snapshot().pendingSubmission, true);
  assert.equal(tracker.confirmSubmission(), true);
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001bPpayload\r');
  assert.equal(
    tracker.snapshot().activeControl,
    true,
    'DCS payloads are active controls until ST',
  );
  tracker.observe('\u001b\\\r');
  assert.equal(tracker.snapshot().knownEmpty, false, 'the CR after the DCS is uncertain');
  assert.equal(tracker.snapshot().pendingSubmission, true);
  assert.equal(tracker.confirmSubmission(), true);
  assert.equal(tracker.snapshot().knownEmpty, true);
});

// Built via fromCharCode rather than a literal escape so the source carries
// no raw control byte -- same reasoning as InputOwnershipTracker's own \e
// substitution in lastTaint.
const ESC = String.fromCharCode(27);

test('input ownership parser whitelists terminal query RESPONSES, not just focus/mouse reports', () => {
  // Live seat measured 2026-08-05: snapshot {knownEmpty:false, activePaste:
  // false, activeControl:false, unknown:true} blocked auto-clear with an
  // empty composer. The terminal ANSWERS queries on stdin (cursor position,
  // device attributes, status, mode reports) and none of those responses can
  // place text in the composer any more than the existing focus/mouse
  // whitelist can — DEFECT A / FIX A.
  const reportClasses = [
    ['CPR (cursor position report)', `${ESC}[24;80R`],
    ['DECXCPR (extended CPR)', `${ESC}[?24;80;1R`],
    ['DA1 device attributes response', `${ESC}[?64;1;2;6;9;15;22c`],
    ['DA2 device attributes response', `${ESC}[>0;276;0c`],
    ['DSR status report', `${ESC}[0n`],
    ['DECRPM mode report', `${ESC}[?2026;1$y`],
  ];
  for (const [label, bytes] of reportClasses) {
    const tracker = new InputOwnershipTracker();
    tracker.observe(bytes);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.unknown, false, `${label} must not taint unknown`);
    assert.equal(snapshot.knownEmpty, true, `${label} must not mark the composer dirty`);
  }
});

test('input ownership parser regression guards: arrows and OSC still taint; a report class cannot launder an existing taint', () => {
  const arrowTracker = new InputOwnershipTracker();
  arrowTracker.observe(`${ESC}[A`);
  assert.equal(arrowTracker.snapshot().unknown, true, 'arrow-up genuinely recalls history and must stay fail-closed');

  const oscTracker = new InputOwnershipTracker();
  oscTracker.observe(`${ESC}]0;title`);
  assert.equal(oscTracker.snapshot().unknown, true, 'an OSC title write must still taint');

  // preSequence restore semantics: a report class arriving while the tracker
  // was ALREADY unknown (from a preceding unrelated ESC) restores to the
  // PRIOR (tainted) state, not to false — the whitelist branch is a restore,
  // never an unconditional clear.
  const alreadyTainted = new InputOwnershipTracker();
  alreadyTainted.observe(`${ESC}[A`); // taints unknown=true
  assert.equal(alreadyTainted.snapshot().unknown, true);
  alreadyTainted.observe(`${ESC}[24;80R`); // a CPR response arrives next
  assert.equal(
    alreadyTainted.snapshot().unknown,
    true,
    'a terminal report must not clean a taint that predates it',
  );
});

test('input ownership tracker records a bounded, printable lastTaint at every taint site', () => {
  const tracker = new InputOwnershipTracker();
  assert.equal(tracker.snapshot().lastTaint, null);

  tracker.observe(`${ESC}[A`);
  const afterArrow = tracker.snapshot().lastTaint;
  assert.ok(
    afterArrow && afterArrow.includes('[A'),
    `lastTaint must name the completed sequence that tainted, got ${afterArrow}`,
  );
  assert.ok(
    afterArrow && !afterArrow.includes(ESC),
    'lastTaint must never carry a raw ESC byte -- \\e substitution keeps refusal logs printable',
  );

  tracker.observe('\r');
  assert.equal(tracker.snapshot().lastTaint, afterArrow, 'a CR on the tainted line is uncertain: the cause stays named while the evidence is awaited');
  assert.equal(tracker.snapshot().pendingSubmission, true);
  assert.equal(tracker.confirmSubmission(), true);
  assert.equal(tracker.snapshot().lastTaint, null, 'the confirmed submission clears lastTaint along with the rest of the state');

  const longTracker = new InputOwnershipTracker();
  longTracker.observe(`${ESC}]0;${'x'.repeat(200)}`);
  assert.ok(
    longTracker.snapshot().lastTaint.length <= 80,
    `lastTaint must be bounded to 80 chars, got length ${longTracker.snapshot().lastTaint.length}`,
  );

  // R26 FIX finding 3 (NIT): ESC taints lastTaint unconditionally on
  // ARRIVAL (fail-closed for unfinished sequences), but a whitelisted report
  // completing the sequence restores unknown/knownEmpty from the
  // pre-sequence snapshot -- lastTaint must be restored the same way, or a
  // clean tracker reads the contradictory {unknown:false, lastTaint:"\e"}.
  const cprOnlyTracker = new InputOwnershipTracker();
  cprOnlyTracker.observe(`${ESC}[24;80R`);
  assert.equal(
    cprOnlyTracker.snapshot().lastTaint,
    null,
    'a whitelisted report on an already-clean tracker must not fabricate a taint record -- MUST be red on unmodified code (ESC-arrival taint is never restored by either whitelist branch)',
  );
});

// win32-input-mode (DECSET 9001, CLI-toggled): once armed, ConPTY encodes
// EVERY keystroke as ESC[Vk;Sc;Uc;Kd;Cs;Rc_ instead of legacy VT keycodes --
// including Enter, which stops arriving as a raw CR entirely. Live specimen
// measured on a live seat 2026-08-05 22:55:05Z: lastTaint "\e[13;28;13;0;0;1_"
// blocked the composer from ever reading empty again. Field order/defaults
// verified against the published spec (microsoft/terminal doc/specs/#4999),
// not an earlier field-order reading (itself explicitly flagged as
// unverified): Vk;Sc;Uc;Kd;Cs;Rc, Kd=1 keydown/0 keyup. Under that reading
// the RECORDED specimen (Kd=0) is the KEYUP half of the Enter press, not
// the keydown -- inert by design, not a red flag on its own. The keydown
// sibling of that same press is what must submit.
test('win32-input-mode: VK_RETURN keydown submits exactly like a raw CR', () => {
  const tracker = new InputOwnershipTracker();
  tracker.observe('dirty-composer-text');
  assert.equal(tracker.snapshot().knownEmpty, false, 'setup: composer must be dirty first');

  tracker.observe(`${ESC}[13;28;13;1;0;1_`); // VK_RETURN=13, Kd=1 (keydown)
  const snapshot = tracker.snapshot();
  assert.equal(
    snapshot.knownEmpty,
    true,
    'a win32-input-mode VK_RETURN keydown must submit exactly like a raw CR -- MUST be red on unmodified code',
  );
  assert.equal(snapshot.unknown, false);
  assert.equal(snapshot.lastTaint, null);
});

test('win32-input-mode: the exact live specimen (Enter keyup, the trailing half of the press) is inert, not a taint', () => {
  // The literal bytes recorded in lastTaint on a live seat. Kd=0 here
  // is the KEY-UP half of the same Enter press whose keydown sibling
  // submits (previous test) -- a keyup places nothing in the composer.
  const tracker = new InputOwnershipTracker();
  tracker.observe(`${ESC}[13;28;13;0;0;1_`);
  const snapshot = tracker.snapshot();
  assert.equal(
    snapshot.unknown,
    false,
    'MUST be red on unmodified code -- the exact field specimen currently taints unknown=true forever',
  );
  assert.equal(snapshot.knownEmpty, true);
  assert.equal(snapshot.lastTaint, null);
});

test('win32-input-mode: Kd outside {0,1} falls through to fail-closed taint', () => {
  // The decode branches are gated on Kd being exactly 0 or 1; any other
  // value is a shape we have no reading for and must taint, never be
  // swallowed as an inert keyup. Guards against the branch broadening to
  // `kd !== 1`, which passes every other test in this file.
  for (const kd of [2, 3]) {
    const tracker = new InputOwnershipTracker();
    tracker.observe(`${ESC}[65;30;97;${kd};0;1_`); // syntactically valid, Kd unrecognized
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.unknown, true, `Kd=${kd} must fall through to the fail-closed taint branch`);
    assert.notEqual(snapshot.lastTaint, null, `Kd=${kd} must record the tainting bytes in lastTaint`);
  }
});

test('win32-input-mode: a printable keydown marks the composer dirty without tainting, and a following Enter still clears it', () => {
  const tracker = new InputOwnershipTracker();
  assert.equal(tracker.snapshot().knownEmpty, true);

  // 'a' keydown: Vk=65 (VK_A), Sc=30, Uc=97 ('a'), Kd=1, Cs=0, Rc=1
  tracker.observe(`${ESC}[65;30;97;1;0;1_`);
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.knownEmpty, false, 'a decoded printable keydown must mark the composer dirty -- MUST be red on unmodified code');
  assert.equal(snapshot.unknown, false, 'we KNOW what was typed -- must not taint');

  // keyup sibling of the same 'a' press must not erase the dirty state
  tracker.observe(`${ESC}[65;30;97;0;0;1_`);
  snapshot = tracker.snapshot();
  assert.equal(snapshot.knownEmpty, false, 'the keyup restore must not erase the dirty content the keydown just placed');

  // Enter keydown still submits/clears from here
  tracker.observe(`${ESC}[13;28;13;1;0;1_`);
  assert.equal(tracker.snapshot().knownEmpty, true, 'a win32 Enter must still clear a composer dirtied by win32 printable keys');
});

test('win32-input-mode: keyup-only traffic on a clean tracker stays clean, lastTaint null', () => {
  const tracker = new InputOwnershipTracker();
  tracker.observe(`${ESC}[65;30;97;0;0;1_`); // 'a' keyup, no matching keydown in this trace
  tracker.observe(`${ESC}[13;28;13;0;0;1_`); // Enter keyup
  tracker.observe(`${ESC}[16;42;0;0;0;1_`); // Shift keyup (modifier alone, Uc=0)
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.knownEmpty, true, 'MUST be red on unmodified code -- every one of these currently taints');
  assert.equal(snapshot.unknown, false);
  assert.equal(snapshot.lastTaint, null);
});

test('win32-input-mode: a malformed underscore-terminated sequence stays fail-closed (regression guard)', () => {
  // NEVER blanket-whitelist the final byte -- a decoded keystroke IS
  // composer content, so anything that doesn't parse cleanly must stay
  // exactly as fail-closed as today. Must stay green through the fix.
  const tracker = new InputOwnershipTracker();
  tracker.observe(`${ESC}[garbage_`); // not digits/semicolons at all
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.unknown, true, 'malformed CSI-underscore must stay fail-closed, never silently pass through');
  assert.ok(snapshot.lastTaint, 'the taint must still be recorded');

  const tracker2 = new InputOwnershipTracker();
  tracker2.observe(`${ESC}[1;2;3;4;5;6;7_`); // shape matches but exceeds the 6-param contract
  assert.equal(tracker2.snapshot().unknown, true, 'more than 6 params must stay fail-closed, never guessed at');
});

test('win32-input-mode: mixed raw and win32-encoded traffic interleave correctly', () => {
  const tracker = new InputOwnershipTracker();
  tracker.observe('raw-typed-text');
  assert.equal(tracker.snapshot().knownEmpty, false);

  tracker.observe(`${ESC}[65;30;97;1;0;1_`); // win32 'a' keydown -- dirty stays dirty, no taint
  assert.equal(tracker.snapshot().knownEmpty, false);
  assert.equal(tracker.snapshot().unknown, false);

  tracker.observe(`${ESC}[A`); // raw arrow -- still fail-closed
  assert.equal(tracker.snapshot().unknown, true, 'a raw arrow between win32 events must still taint');

  // win32 Enter keydown has exactly raw-CR semantics, including on an
  // unknown-tainted line (review of 436c1dd): uncertain, not a submission,
  // resolved by the runner's transcript evidence.
  tracker.observe(`${ESC}[13;28;13;1;0;1_`);
  assert.equal(tracker.snapshot().knownEmpty, false, 'win32 plain Enter keydown on a tainted line is uncertain, same as a raw CR');
  assert.equal(tracker.snapshot().pendingSubmission, true);
  assert.equal(tracker.confirmSubmission(), true);
  assert.equal(tracker.snapshot().knownEmpty, true);

  // On a CLEAN line it is the zero-latency boundary, same as a raw CR.
  const clean = new InputOwnershipTracker();
  clean.observe('raw-typed-text');
  clean.observe(`${ESC}[13;28;13;1;0;1_`);
  assert.equal(clean.snapshot().knownEmpty, true, 'win32 plain Enter keydown on a clean line submits outright');
  assert.equal(clean.snapshot().pendingSubmission, false);
});

// MULTILINE INPUT IS NOT SUBMISSION (PR #59 review 5356605916, P1). Claude
// Code's documented newline keys arrive on the same wire as a submission:
// backslash+Enter ("\" then Return -- "works in all terminals"), Ctrl+J
// (chat:newline, a raw LF), Option/Alt+Enter (ESC CR), and under
// win32-input-mode a VK_RETURN keydown with SHIFT_PRESSED (0x10) in Cs. On
// 08a3c62 the raw-CR branch and the win32 Enter branch both promoted these
// to _submitted(): knownEmpty read true while the operator was still
// composing, and the capsule-request guard fired into their draft. Every
// assertion tagged "MUST be red on 08a3c62" fails there; the rest are
// regression guards that must stay green through the fix.
test('ML1 multiline: backslash + CR is a composer newline, not a submission -- one chunk and split across chunks', () => {
  // Reviewer's reproduction: ['first line', '\\', '\r'] as separate chunks.
  const split = new InputOwnershipTracker();
  for (const chunk of ['first line', '\\', '\r']) split.observe(chunk);
  let snapshot = split.snapshot();
  assert.equal(snapshot.knownEmpty, false, 'backslash+CR split across chunks is a newline: the composer still holds the draft -- MUST be red on 08a3c62');
  assert.equal(snapshot.unknown, false, 'a known newline edit taints nothing');
  assert.equal(snapshot.lastTaint, null);

  // The same bytes in one chunk.
  const joined = new InputOwnershipTracker();
  joined.observe('first line\\\r');
  assert.equal(joined.snapshot().knownEmpty, false, 'backslash+CR in one chunk is a newline -- MUST be red on 08a3c62');

  // Continuing the draft on the second line, then a PLAIN Enter: that CR is
  // not preceded by a backslash, so it is the submission boundary.
  split.observe('second line');
  assert.equal(split.snapshot().knownEmpty, false);
  split.observe('\r');
  snapshot = split.snapshot();
  assert.equal(snapshot.knownEmpty, true, 'the next plain Enter after a multiline draft submits');
  assert.equal(snapshot.unknown, false);
  assert.equal(snapshot.lastTaint, null);

  // A backslash that is NOT immediately before the CR is ordinary text.
  const notAdjacent = new InputOwnershipTracker();
  notAdjacent.observe('C:\\dev\\wt\r');
  assert.equal(notAdjacent.snapshot().knownEmpty, true, 'a backslash elsewhere in the line does not turn the CR into a newline');

  // Two Enters straight after the backslash: the first is the newline, the
  // second (now preceded by that newline, not the backslash) submits.
  const doubleEnter = new InputOwnershipTracker();
  doubleEnter.observe('first line\\');
  doubleEnter.observe('\r');
  assert.equal(doubleEnter.snapshot().knownEmpty, false);
  doubleEnter.observe('\r');
  assert.equal(doubleEnter.snapshot().knownEmpty, true, 'the second CR is a plain Enter and submits');
});

test('ML2 multiline: win32-input-mode Shift+Enter keydown is a newline, not a submission; the plain Enter keydown still submits', () => {
  // Reviewer's reproduction: ESC[13;28;13;1;16;1_ -- VK_RETURN, Kd=1, Cs=SHIFT_PRESSED.
  const tracker = new InputOwnershipTracker();
  tracker.observe('first line');
  tracker.observe(`${ESC}[13;28;13;1;16;1_`);
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.knownEmpty, false, 'a Shift+Enter keydown must not read as submitted -- MUST be red on 08a3c62');
  assert.equal(snapshot.unknown, false, 'a decoded Shift+Enter is a known newline, not a taint');
  assert.equal(snapshot.activeControl, false, 'the sequence is complete');
  // Its keyup half is inert, as before.
  tracker.observe(`${ESC}[13;28;13;0;16;1_`);
  assert.equal(tracker.snapshot().knownEmpty, false, 'the keyup must not erase the dirty draft');
  // Second line, then the PLAIN Enter keydown submits -- the existing
  // VK_RETURN contract, now with the modifier check in its path.
  tracker.observe(`${ESC}[65;30;97;1;0;1_`);
  tracker.observe(`${ESC}[13;28;13;1;0;1_`);
  snapshot = tracker.snapshot();
  assert.equal(snapshot.knownEmpty, true, 'a plain Enter keydown after a multiline draft submits');
  assert.equal(snapshot.unknown, false);
  assert.equal(snapshot.lastTaint, null);
});

test('ML3 multiline: win32 Cs bits -- any held Shift/Ctrl/Alt makes Enter non-submitting; lock and enhanced bits do not veto a plain Enter', () => {
  // Held modifiers: RIGHT_ALT 0x01, LEFT_ALT 0x02, RIGHT_CTRL 0x04,
  // LEFT_CTRL 0x08, SHIFT 0x10, and Ctrl+Shift together. Shift and Alt are
  // Claude Code's documented newline chords; Ctrl+Enter is documented as
  // chat:sendNow (v2.1.275+) but the runner cannot see the child's version
  // or key decoding, so it is deliberately not PROOF of submission either --
  // being wrong there costs one deferral, never a mangled prompt.
  for (const cs of [0x01, 0x02, 0x04, 0x08, 0x10, 0x18]) {
    const tracker = new InputOwnershipTracker();
    tracker.observe('draft');
    tracker.observe(`${ESC}[13;28;13;1;${cs};1_`);
    assert.equal(tracker.snapshot().knownEmpty, false,
      `VK_RETURN keydown with Cs=0x${cs.toString(16)} is not proof of submission -- MUST be red on 08a3c62`);
    tracker.observe(`${ESC}[13;28;13;1;0;1_`);
    assert.equal(tracker.snapshot().knownEmpty, true, `the following plain Enter submits (after Cs=0x${cs.toString(16)})`);
  }
  // Not modifiers: NUMLOCK_ON 0x20, CAPSLOCK_ON 0x80, ENHANCED_KEY 0x100
  // (the numpad Enter carries this), and NumLock+Enhanced together. A plain
  // Enter with these set MUST still submit -- guards the mask at 0x1F.
  for (const cs of [0x20, 0x80, 0x100, 0x120]) {
    const tracker = new InputOwnershipTracker();
    tracker.observe('draft');
    tracker.observe(`${ESC}[13;28;13;1;${cs};1_`);
    assert.equal(tracker.snapshot().knownEmpty, true,
      `Cs=0x${cs.toString(16)} holds no modifier: a plain Enter, submits (regression guard)`);
  }
});

test('ML4 multiline: win32 backslash keydown + plain Enter keydown is a newline, mirroring the raw-byte rule', () => {
  const tracker = new InputOwnershipTracker();
  tracker.observe(`${ESC}[220;43;92;1;0;1_`); // VK_OEM_5, Uc=92 '\'
  assert.equal(tracker.snapshot().knownEmpty, false);
  tracker.observe(`${ESC}[220;43;92;0;0;1_`); // its keyup: inert, the backslash still sits before the cursor
  tracker.observe(`${ESC}[13;28;13;1;0;1_`);
  assert.equal(tracker.snapshot().knownEmpty, false,
    'backslash + Enter under win32-input-mode is the same documented newline -- MUST be red on 08a3c62');
  assert.equal(tracker.snapshot().unknown, false);
  tracker.observe(`${ESC}[13;28;13;1;0;1_`);
  assert.equal(tracker.snapshot().knownEmpty, true, 'the next plain Enter submits');
});

test('ML5 multiline: Ctrl+J (LF) and Alt+Enter (ESC CR) never submit, raw or win32-encoded (regression guards)', () => {
  // Raw LF: a control byte -- taints, dirty. The CR that follows is on a
  // tainted line and therefore uncertain (review of 436c1dd); the runner's
  // transcript evidence (confirmSubmission here) is what clears it.
  const lf = new InputOwnershipTracker();
  lf.observe('first line');
  lf.observe('\n');
  assert.equal(lf.snapshot().knownEmpty, false, 'Ctrl+J is chat:newline, never a submission');
  lf.observe('second line\r');
  assert.equal(lf.snapshot().knownEmpty, false, 'the CR after a taint is uncertain, not a submission');
  assert.equal(lf.snapshot().pendingSubmission, true);
  assert.equal(lf.confirmSubmission(), true);
  assert.equal(lf.snapshot().knownEmpty, true);

  // Raw Alt/Option+Enter: ESC then CR -- the escape branch taints, no submission.
  const meta = new InputOwnershipTracker();
  meta.observe('first line');
  meta.observe(`${ESC}\r`);
  assert.equal(meta.snapshot().knownEmpty, false, 'Meta+Enter is a newline chord, never a submission');
  meta.observe('\r');
  assert.equal(meta.snapshot().knownEmpty, false, 'the CR after a taint is uncertain, not a submission');
  assert.equal(meta.snapshot().pendingSubmission, true);
  assert.equal(meta.confirmSubmission(), true);
  assert.equal(meta.snapshot().knownEmpty, true);

  // win32 Ctrl+J: VK_J=74, Uc=10, Cs=LEFT_CTRL -- a non-printable keydown, fail-closed.
  const win32 = new InputOwnershipTracker();
  win32.observe('first line');
  win32.observe(`${ESC}[74;36;10;1;8;1_`);
  assert.equal(win32.snapshot().knownEmpty, false, 'win32 Ctrl+J never submits');
  win32.observe(`${ESC}[13;28;13;1;0;1_`);
  assert.equal(win32.snapshot().knownEmpty, false, 'the plain Enter keydown after a taint is uncertain, not a submission');
  assert.equal(win32.snapshot().pendingSubmission, true);
  assert.equal(win32.confirmSubmission(), true);
  assert.equal(win32.snapshot().knownEmpty, true);
});

test('ML6 multiline: bracketed paste with embedded newlines stays non-submitting, and a paste ending in a backslash makes the next CR a newline', () => {
  // Existing behavior, verified: CRs inside the paste are payload.
  const paste = new InputOwnershipTracker();
  paste.observe(`${ESC}[200~line one\rline two\r${ESC}[201~`);
  const snapshot = paste.snapshot();
  assert.equal(snapshot.knownEmpty, false, 'a paste with embedded CRs leaves the composer dirty');
  assert.equal(snapshot.activePaste, false);
  paste.observe('\r');
  assert.equal(paste.snapshot().knownEmpty, true, 'the operator Enter after the paste submits');

  // The paste's last payload byte now sits before the cursor: a trailing
  // backslash turns the operator's next Enter into a newline.
  const trailing = new InputOwnershipTracker();
  trailing.observe(`${ESC}[200~echo \\${ESC}[201~`);
  trailing.observe('\r');
  assert.equal(trailing.snapshot().knownEmpty, false, 'a paste ending in a backslash + Enter is a newline -- MUST be red on 08a3c62');
  trailing.observe('\r');
  assert.equal(trailing.snapshot().knownEmpty, true);

  // The end marker torn at every byte across chunks: the seven-byte probe
  // must still recover the payload byte before it.
  const torn = new InputOwnershipTracker();
  for (const chunk of [`${ESC}[200~`, 'a', '\\', ESC, '[', '2', '0', '1', '~']) torn.observe(chunk);
  assert.equal(torn.snapshot().activePaste, false);
  torn.observe('\r');
  assert.equal(torn.snapshot().knownEmpty, false, 'torn end marker: the byte before it is still the last payload byte');
});

test('ML7 multiline: an unknown control between backslash and CR makes the CR uncertain; inert reports do not launder it', () => {
  // An arrow between them may have moved the cursor: the tracker cannot say
  // where the backslash is, so the CR is neither a submission nor a newline
  // -- it is recorded as an uncertain submission for the runner to prove.
  const arrow = new InputOwnershipTracker();
  arrow.observe('first line\\');
  arrow.observe(`${ESC}[D`);
  assert.equal(arrow.snapshot().unknown, true);
  arrow.observe('\r');
  assert.equal(arrow.snapshot().knownEmpty, false, 'CR after an unknown control is not proof of submission -- MUST be red on 436c1dd');
  assert.equal(arrow.snapshot().pendingSubmission, true, 'the snapshot names the wait');

  // A focus report, a CPR, or a modifier keyup places nothing and moves
  // nothing: the backslash is still before the cursor, so the CR is a newline.
  for (const [label, inert] of [
    ['focus-in', `${ESC}[I`],
    ['CPR', `${ESC}[24;80R`],
    ['win32 Shift keyup', `${ESC}[16;42;0;0;0;1_`],
  ]) {
    const tracker = new InputOwnershipTracker();
    tracker.observe('first line\\');
    tracker.observe(inert);
    tracker.observe('\r');
    assert.equal(tracker.snapshot().knownEmpty, false,
      `${label} between backslash and CR must not launder the newline into a submission -- MUST be red on 08a3c62`);
  }
});

test('ML8 multiline: snapshot names the newline mechanism, and the Ctrl+Enter-only operator stays deferred until a plain Enter (fail-closed, stated)', () => {
  // Review of 8d4a8b4 (MEDIUM): after a newline chord the snapshot read
  // {knownEmpty:false, unknown:false, lastTaint:null} -- the same as typed
  // text -- so a composer-busy refusal named no mechanism. lastByte (JSON-
  // escaped, printable) and lastNewline now do.
  const fresh = new InputOwnershipTracker();
  assert.equal(fresh.snapshot().lastByte, null);
  assert.equal(fresh.snapshot().lastNewline, false);
  fresh.observe('abc\\');
  assert.equal(fresh.snapshot().lastByte, '\\\\', 'a backslash renders JSON-escaped, never raw');
  assert.equal(fresh.snapshot().lastNewline, false);
  fresh.observe('\r');
  assert.equal(fresh.snapshot().lastByte, '\\r', 'a newline CR renders as \\r, printable');
  assert.equal(fresh.snapshot().lastNewline, true, 'the mechanism is named: the last composer event was a newline chord');
  fresh.observe('x');
  assert.equal(fresh.snapshot().lastNewline, false, 'typed text after the newline clears the flag');
  fresh.observe('\r');
  assert.equal(fresh.snapshot().lastByte, null, 'submission resets it');
  assert.equal(fresh.snapshot().lastNewline, false);

  // The Ctrl+Enter-only operator under win32-input-mode: two consecutive
  // modified Enters (LEFT_CTRL 0x08) with no plain Enter. Claude Code
  // documents Ctrl+Enter as chat:sendNow (v2.1.275+), so this operator MAY
  // have submitted twice -- but the runner cannot verify the child's version
  // or its decoding of the win32 event, and a wrong "submitted" is the
  // mangled prompt. Deliberately fail-closed: deferred until a plain Enter,
  // INDEFINITELY if none comes, with the snapshot naming why. Do NOT flip
  // this to submission without evidence the child treats it as one.
  const ctrlOnly = new InputOwnershipTracker();
  ctrlOnly.observe('first send');
  ctrlOnly.observe(`${ESC}[13;28;13;1;8;1_`);
  ctrlOnly.observe(`${ESC}[13;28;13;0;8;1_`);
  ctrlOnly.observe('second send');
  ctrlOnly.observe(`${ESC}[13;28;13;1;8;1_`);
  ctrlOnly.observe(`${ESC}[13;28;13;0;8;1_`);
  let snapshot = ctrlOnly.snapshot();
  assert.equal(snapshot.knownEmpty, false, 'two consecutive Ctrl+Enters and no plain Enter: still deferred (fail-closed)');
  assert.equal(snapshot.unknown, false, 'not a taint -- a decoded, known event');
  assert.equal(snapshot.lastTaint, null);
  assert.equal(snapshot.lastNewline, true, 'the snapshot names the mechanism: waiting on a plain Enter after a modified one');
  assert.equal(snapshot.lastByte, '\\r');
  // The only release is a plain Enter.
  ctrlOnly.observe(`${ESC}[13;28;13;1;0;1_`);
  snapshot = ctrlOnly.snapshot();
  assert.equal(snapshot.knownEmpty, true);
  assert.equal(snapshot.lastNewline, false);
});

test('ML9 multiline: REGRESSION GUARD -- a CR after a tainting control is an UNCERTAIN submission, resolved only by evidence, never by the CR itself', () => {
  // Review of 8d4a8b4 (LOW, residual) pinned the OLD behaviour: after any
  // tainting control (DEL, backspace, arrows, CSI-u, unfinished ESC) the
  // next CR submitted and cleared the taint even if the byte before the
  // cursor was a backslash. Review of 436c1dd (MED) rejected that: the
  // backslash case makes the CR a NEWLINE and the request was typed into the
  // draft. The CONTRACT now: the CR is recorded as pendingSubmission, the
  // line stays dirty and tainted, and only confirmSubmission() (runner-side
  // transcript evidence) clears it. Nobody turns this back into "CR clears
  // unknown", and nobody turns it into a permanent defer either: the
  // confirmation path below is the liveness control.
  const cases = [
    ['DEL after two backslashes', ['abc\\\\', '\u007f', '\r']],
    ['backspace (0x08) after a backslash', ['abc\\', '\u0008', '\r']],
    ['Left then Right around a backslash', ['abc\\', `${ESC}[D`, `${ESC}[C`, '\r']],
    ['CSI-u Shift+Enter then CR', ['abc\\', `${ESC}[13;2u`, '\r']],
    ['unfinished ESC completed by a letter', ['abc\\', ESC, 'x', '\r']],
  ];
  for (const [label, chunks] of cases) {
    const tracker = new InputOwnershipTracker();
    for (const chunk of chunks.slice(0, -1)) tracker.observe(chunk);
    assert.equal(tracker.snapshot().unknown, true, `${label}: setup, the control taints`);
    assert.equal(tracker.snapshot().lastByte === '\\\\', false, `${label}: the taint nulls or replaces lastByte`);
    const before = tracker.snapshot();
    tracker.observe(chunks[chunks.length - 1]);
    let snapshot = tracker.snapshot();
    assert.equal(snapshot.knownEmpty, false, `${label}: the CR after a tainting control is NOT proof of submission -- MUST be red on 436c1dd`);
    assert.equal(before.pendingSubmission, false, `${label}: nothing was pending before the CR`);
    assert.equal(snapshot.unknown, true, `${label}: the CR does not clear unknown`);
    assert.equal(snapshot.pendingSubmission, true, `${label}: the snapshot names the mechanism`);
    assert.equal(snapshot.lastNewline, false, `${label}: not claimed as a newline either -- uncertain`);
    // Liveness: evidence resolves it, exactly as a clean CR would have.
    assert.equal(tracker.confirmSubmission(), true, `${label}: a pending record is resolved`);
    snapshot = tracker.snapshot();
    assert.equal(snapshot.knownEmpty, true, `${label}: confirmed -> empty`);
    assert.equal(snapshot.unknown, false);
    assert.equal(snapshot.pendingSubmission, false);
    assert.equal(snapshot.lastTaint, null);
    assert.equal(tracker.confirmSubmission(), false, `${label}: nothing left to confirm`);
  }
});

test('ML10 multiline: an EMPTY bracketed paste places nothing, so a backslash before it still makes the next CR a newline', () => {
  // Review of 8d4a8b4 (LOW): the paste-end branch nulled lastByte for a
  // payload shorter than one byte, dropping the pre-paste backslash and
  // promoting the following CR to a submission.
  const empty = new InputOwnershipTracker();
  empty.observe('first line\\');
  empty.observe(`${ESC}[200~${ESC}[201~`);
  assert.equal(empty.snapshot().activePaste, false);
  empty.observe('\r');
  assert.equal(empty.snapshot().knownEmpty, false, 'backslash, empty paste, CR: still the newline chord -- MUST be red on 8d4a8b4');
  assert.equal(empty.snapshot().lastNewline, true);
  empty.observe('\r');
  assert.equal(empty.snapshot().knownEmpty, true, 'the next plain Enter submits');

  // A non-empty paste still replaces the pre-paste byte with its own last
  // payload byte.
  const nonEmpty = new InputOwnershipTracker();
  nonEmpty.observe('first line\\');
  nonEmpty.observe(`${ESC}[200~x${ESC}[201~`);
  nonEmpty.observe('\r');
  assert.equal(nonEmpty.snapshot().knownEmpty, true, 'a one-byte paste ending in x: the CR is a plain Enter');
});

// Review of 436c1dd (MED): the reviewer's two specimens, raw and under
// win32-input-mode. In both the editable prompt ends in a backslash the
// tracker lost sight of, so the Enter is Claude Code's backslash+Enter
// NEWLINE -- and the tracker used to read it as a submission.
const SPECIMEN_1_RAW = ['abc\\x', '\u007f', '\r'];
const SPECIMEN_2_RAW = ['abc\\', `${ESC}[D`, `${ESC}[C`, '\r'];
// VK_BACK=8 (uc=8, below 0x20: the non-printable keydown branch), VK_LEFT=37,
// VK_RIGHT=39, then a PLAIN VK_RETURN keydown (Cs=0). The live wire sends a
// keyup after every keydown (review of 7b3a728, F1) -- the Enter keyup is
// the exact byte string measured on the live seat 2026-08-05 22:55:05Z --
// so the win32 specimens carry them, and the keyups must change nothing.
const WIN32_BACKSPACE = `${ESC}[8;14;8;1;0;1_`;
const WIN32_BACKSPACE_UP = `${ESC}[8;14;8;0;0;1_`;
const WIN32_LEFT = `${ESC}[37;75;0;1;0;1_`;
const WIN32_LEFT_UP = `${ESC}[37;75;0;0;0;1_`;
const WIN32_RIGHT = `${ESC}[39;77;0;1;0;1_`;
const WIN32_RIGHT_UP = `${ESC}[39;77;0;0;0;1_`;
const WIN32_PLAIN_ENTER = `${ESC}[13;28;13;1;0;1_`;
const WIN32_PLAIN_ENTER_UP = `${ESC}[13;28;13;0;0;1_`;
const SPECIMEN_1_WIN32 = ['abc\\x', WIN32_BACKSPACE, WIN32_BACKSPACE_UP, WIN32_PLAIN_ENTER, WIN32_PLAIN_ENTER_UP];
const SPECIMEN_2_WIN32 = ['abc\\', WIN32_LEFT, WIN32_LEFT_UP, WIN32_RIGHT, WIN32_RIGHT_UP, WIN32_PLAIN_ENTER, WIN32_PLAIN_ENTER_UP];

test('ML11 specimens: an edited line ending in a lost backslash + Enter is UNCERTAIN, not a submission (raw and win32); evidence confirms it', () => {
  for (const [label, chunks] of [
    ['specimen 1 raw: abc\\x DEL CR', SPECIMEN_1_RAW],
    ['specimen 2 raw: abc\\ Left Right CR', SPECIMEN_2_RAW],
    ['specimen 1 win32: abc\\x VK_BACK VK_RETURN', SPECIMEN_1_WIN32],
    ['specimen 2 win32: abc\\ VK_LEFT VK_RIGHT VK_RETURN', SPECIMEN_2_WIN32],
  ]) {
    const tracker = new InputOwnershipTracker();
    for (const chunk of chunks) tracker.observe(chunk);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.knownEmpty, false, `${label}: knownEmpty must stay false after the CR -- MUST be red on 436c1dd`);
    assert.equal(snapshot.unknown, true, `${label}: the edit taint is not cleared by the CR`);
    assert.equal(snapshot.pendingSubmission, true, `${label}: the snapshot names the uncertain submission`);
    assert.equal(snapshot.lastNewline, false, `${label}: not claimed as a newline either`);
    // The record counts everything up to and including the CR itself -- not
    // the Enter keyup that follows it on the win32 wire.
    const enterIndex = chunks.findIndex((chunk) => chunk === '\r' || chunk === WIN32_PLAIN_ENTER);
    assert.equal(tracker.pendingSubmission.units, chunks.slice(0, enterIndex + 1).join('').length,
      `${label}: the record counts everything up to and including the CR`);
    assert.equal(tracker.pendingSubmission.taintedAfter, false);
    assert.equal(tracker.pendingSubmission.dirtyAfter, false, `${label}: a trailing keyup places nothing`);
    // No timer: ticks of nothing change nothing.
    assert.equal(tracker.snapshot().pendingSubmission, true);
    // Liveness: the runner's evidence resolves it.
    assert.equal(tracker.confirmSubmission(), true, `${label}: confirmed`);
    assert.equal(tracker.snapshot().knownEmpty, true, `${label}: confirmed -> known empty`);
    assert.equal(tracker.snapshot().pendingSubmission, false);
  }

  // The record counts up to the CR ITSELF, not the chunk's tail: '\rxyz' in
  // one chunk leaves xyz typed after the uncertain CR, and confirmation of
  // that CR must not declare xyz gone.
  const tail = new InputOwnershipTracker();
  tail.observe('abc\\x');
  tail.observe('\u007f');
  tail.observe('\rxyz');
  assert.equal(tail.pendingSubmission.units, tail.receivedUnits - 3, 'units stop at the CR');
  assert.equal(tail.confirmSubmission(), true);
  assert.equal(tail.snapshot().knownEmpty, false, 'xyz was typed after the confirmed CR: the composer holds it');
  assert.equal(tail.snapshot().unknown, false, 'the pre-CR taint is spent; xyz was observed byte-for-byte');
  assert.equal(tail.snapshot().pendingSubmission, false);
  tail.observe('\r');
  assert.equal(tail.snapshot().knownEmpty, true, 'xyz is a clean line: its plain Enter submits outright');

  // A taint that lands AFTER the uncertain CR survives confirmation: the
  // fresh line is itself unknown and its next CR is uncertain again.
  const tainted = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_2_RAW) tainted.observe(chunk);
  tainted.observe('more');
  tainted.observe(`${ESC}[A`);
  assert.equal(tainted.pendingSubmission.taintedAfter, true);
  assert.equal(tainted.confirmSubmission(), true);
  assert.equal(tainted.snapshot().unknown, true, 'the post-CR arrow still taints');
  assert.equal(tainted.snapshot().pendingSubmission, false);
  tainted.observe('\r');
  assert.equal(tainted.snapshot().pendingSubmission, true, 'uncertain again: evidence needed again');

  // A second uncertain CR replaces the record (evidence is attributed to the
  // latest CR), and a clean _submitted() path never leaves one behind.
  const twice = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_1_RAW) twice.observe(chunk);
  const first = twice.pendingSubmission.units;
  twice.observe('second line\r');
  assert.equal(twice.pendingSubmission.units, first + 'second line\r'.length, 'the latest CR owns the record');
  assert.equal(twice.snapshot().pendingSubmission, true);

  // A known printable typed AFTER an edit: the CR still waits for a record
  // (the taint stands until evidence), but the tracker saw the byte before
  // the cursor, so the CR is `certain` -- any record after it confirms it
  // (review of c011881c, F3; ML14).
  const edited = new InputOwnershipTracker();
  edited.observe('abc');
  edited.observe(`${ESC}[D`);
  edited.observe('d\r');
  assert.equal(edited.snapshot().pendingSubmission, true);
  assert.equal(edited.pendingSubmission.certain, true);

  // A clean line is untouched by any of this: zero-latency boundary as before.
  const clean = new InputOwnershipTracker();
  clean.observe('abc\\x');
  clean.observe('\r');
  assert.equal(clean.snapshot().knownEmpty, true, 'no edit, no uncertainty');
  assert.equal(clean.snapshot().pendingSubmission, false);
});

// Review of 7b3a728 (F1, BLOCK): inert sequences after the uncertain CR --
// above all the Enter's OWN win32 keyup, which always precedes the transcript
// record on the live seat -- marked the record taintedAfter through the
// ESC-arrival taint. confirmSubmission() then left unknown=true on an EMPTY
// composer, every later clean prompt kept it unknown, and the capsule
// request deferred for the rest of the session: no ack, no clear, pressure
// unbounded, only a relaunch recovered.
test('ML12 F1: inert sequences after the uncertain CR (Enter keyup, focus/mouse reports, empty paste) do not spoil its confirmation; real controls still do', () => {
  // (a) The reviewer's probe: abcd, VK_BACK down/up, VK_RETURN down/up, then
  // the record. Confirmed EMPTY and clean -- and it stays that way through
  // five further clean prompts with keydown+keyup each.
  const probe = new InputOwnershipTracker();
  for (const chunk of ['abcd', WIN32_BACKSPACE, WIN32_BACKSPACE_UP, WIN32_PLAIN_ENTER, WIN32_PLAIN_ENTER_UP]) probe.observe(chunk);
  assert.equal(probe.snapshot().pendingSubmission, true);
  assert.equal(probe.pendingSubmission.taintedAfter, false, 'the Enter keyup is inert: it must not mark the record -- MUST be red on 7b3a728');
  assert.equal(probe.pendingSubmission.dirtyAfter, false, 'nor does it place content');
  assert.equal(probe.confirmSubmission(), true);
  let snapshot = probe.snapshot();
  assert.equal(snapshot.knownEmpty, true, 'confirmed with only a keyup after the CR: the composer is EMPTY -- MUST be red on 7b3a728');
  assert.equal(snapshot.unknown, false, 'and clean');
  assert.equal(snapshot.lastTaint, null);
  for (let i = 0; i < 5; i += 1) {
    probe.observe(`prompt ${i}`);
    assert.equal(probe.snapshot().knownEmpty, false);
    probe.observe(WIN32_PLAIN_ENTER);
    assert.equal(probe.snapshot().knownEmpty, true, `clean prompt ${i}: the plain Enter keydown on a clean line submits outright`);
    assert.equal(probe.snapshot().pendingSubmission, false, `clean prompt ${i}: nothing uncertain about it`);
    probe.observe(WIN32_PLAIN_ENTER_UP);
    snapshot = probe.snapshot();
    assert.equal(snapshot.knownEmpty, true, `clean prompt ${i}: the keyup changes nothing`);
    assert.equal(snapshot.unknown, false, `clean prompt ${i}: still clean -- the F1 session-long defer is closed`);
  }

  // (b) Raw mode: a mouse-wheel report, a focus-out, a CPR, a modifier keyup
  // or an EMPTY paste between the CR and the tick that reads the record.
  for (const [label, inert] of [
    ['mouse wheel', `${ESC}[<64;10;10M`],
    ['focus-out', `${ESC}[O`],
    ['CPR', `${ESC}[24;80R`],
    ['win32 Shift keyup', `${ESC}[16;42;0;0;0;1_`],
    ['empty paste', `${ESC}[200~${ESC}[201~`],
  ]) {
    const tracker = new InputOwnershipTracker();
    for (const chunk of SPECIMEN_1_RAW) tracker.observe(chunk);
    tracker.observe(inert);
    assert.equal(tracker.snapshot().pendingSubmission, true, `${label}: the record survives an inert sequence`);
    assert.equal(tracker.pendingSubmission.taintedAfter, false, `${label}: an inert sequence does not mark it -- MUST be red on 7b3a728`);
    assert.equal(tracker.confirmSubmission(), true);
    assert.equal(tracker.snapshot().knownEmpty, true, `${label}: confirmed EMPTY -- MUST be red on 7b3a728`);
    assert.equal(tracker.snapshot().unknown, false, `${label}: and clean`);
  }

  // (c) A genuinely tainting control after the CR (arrow, DEL, backspace
  // keydown) still leaves the line dirty and unknown after confirmation --
  // the existing contract. And known content after the CR (a printable, a
  // non-empty paste) leaves it dirty but clean.
  for (const [label, control] of [
    ['arrow-up', `${ESC}[A`],
    ['DEL', '\u007f'],
    ['win32 backspace keydown', WIN32_BACKSPACE],
  ]) {
    const tracker = new InputOwnershipTracker();
    for (const chunk of SPECIMEN_2_RAW) tracker.observe(chunk);
    tracker.observe(control);
    assert.equal(tracker.pendingSubmission.taintedAfter, true, `${label}: a real control after the CR marks the record`);
    assert.equal(tracker.confirmSubmission(), true);
    assert.equal(tracker.snapshot().knownEmpty, false, `${label}: confirmed, but the line after it is dirty`);
    assert.equal(tracker.snapshot().unknown, true, `${label}: and unknown -- existing contract preserved`);
  }
  for (const [label, content] of [
    ['printable', 'x'],
    ['win32 printable keydown', `${ESC}[88;45;120;1;0;1_`],
    ['non-empty paste', `${ESC}[200~pasted${ESC}[201~`],
  ]) {
    const tracker = new InputOwnershipTracker();
    for (const chunk of SPECIMEN_2_RAW) tracker.observe(chunk);
    tracker.observe(content);
    assert.equal(tracker.pendingSubmission.dirtyAfter, true, `${label}: content after the CR marks the record dirty`);
    assert.equal(tracker.pendingSubmission.taintedAfter, false, `${label}: but not tainted`);
    assert.equal(tracker.confirmSubmission(), true);
    assert.equal(tracker.snapshot().knownEmpty, false, `${label}: the composer holds the new content`);
    assert.equal(tracker.snapshot().unknown, false, `${label}: seen byte-for-byte, clean`);
  }

  // An inert sequence sandwiched between real content keeps the content's
  // mark: the restore is a snapshot of the record as it was at ESC arrival,
  // not a reset.
  const sandwich = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_1_RAW) sandwich.observe(chunk);
  sandwich.observe('y');
  sandwich.observe(`${ESC}[O`);
  assert.equal(sandwich.pendingSubmission.dirtyAfter, true, 'the focus-out restores the record WITH its dirty mark');
  assert.equal(sandwich.confirmSubmission(), true);
  assert.equal(sandwich.snapshot().knownEmpty, false);

  // Review of 4e71bb3 (F3, LOW): a paste IS content from its START. A
  // confirmation landing between a completed ESC[200~ chunk and its payload
  // chunk must not read "nothing placed since" and _submitted() the tracker
  // mid-paste (the request would fire into a composer the payload then lands
  // on, and the payload would be parsed in normal mode).
  const midPaste = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_1_RAW) midPaste.observe(chunk);
  midPaste.observe(`${ESC}[200~`);
  assert.equal(midPaste.snapshot().activePaste, true);
  assert.equal(midPaste.pendingSubmission.dirtyAfter, true, 'a completed paste start marks the record as content -- MUST be red on 4e71bb3');
  assert.equal(midPaste.confirmSubmission(), true);
  let mid = midPaste.snapshot();
  assert.equal(mid.knownEmpty, false, 'confirmed mid-paste: the composer is about to hold the payload -- MUST be red on 4e71bb3');
  assert.equal(mid.activePaste, true, 'the paste is still in flight');
  assert.equal(mid.pendingSubmission, false);
  assert.equal(mid.unknown, false, 'the pre-CR taint is spent; the paste is observed byte-for-byte');
  // The payload, its end marker and the operator's Enter then behave exactly
  // as a paste on a clean line does.
  midPaste.observe('pasted text');
  midPaste.observe(`${ESC}[201~`);
  mid = midPaste.snapshot();
  assert.equal(mid.activePaste, false);
  assert.equal(mid.knownEmpty, false, 'the payload is in the composer');
  midPaste.observe('\r');
  assert.equal(midPaste.snapshot().knownEmpty, true, 'the Enter after the paste is a clean boundary');
  // The EMPTY paste still confirms EMPTY: its end marker restores the
  // unmarked snapshot (case (b) above), so nothing else changes.
  const emptyPaste = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_1_RAW) emptyPaste.observe(chunk);
  emptyPaste.observe(`${ESC}[200~`);
  emptyPaste.observe(`${ESC}[201~`);
  assert.equal(emptyPaste.pendingSubmission.dirtyAfter, false, 'an empty paste placed nothing');
  assert.equal(emptyPaste.confirmSubmission(), true);
  assert.equal(emptyPaste.snapshot().knownEmpty, true);
});

// Review 5480136713 (MED): a prompt record is evidence that SOME submission
// was recorded, not that the latest uncertain CR was. The tracker now keeps
// every CR that may still be owed a record, in order, and a record settles
// the OLDEST one. Tracker-level contract; the end-to-end cases are R1-R3,
// P1-P4 below.
test('ML13 ordered receipts: a record settles the oldest outstanding CR; a newer uncertain draft is confirmed only by its own entry or when it is provably a submission', () => {
  // A clean non-empty Enter owes one record; an Enter on an empty composer
  // owes none. Neither waits: the composer is known empty at once.
  const clean = new InputOwnershipTracker();
  clean.observe('one\r');
  assert.equal(clean.snapshot().knownEmpty, true, 'zero-latency boundary, unchanged');
  assert.equal(clean.outstanding.length, 1, 'a non-empty prompt owes one record');
  clean.observe('\r');
  assert.equal(clean.outstanding.length, 1, 'an Enter on an empty composer owes none');
  assert.equal(clean.snapshot().outstanding, 1, 'the snapshot names the depth');

  // THE REVIEWER'S CASE at the tracker: A clean (record late), then B =
  // abc\x, Backspace, Enter. A's record must settle A, not confirm B.
  const late = new InputOwnershipTracker();
  late.observe('run the suite\r');
  for (const chunk of SPECIMEN_1_RAW) late.observe(chunk);
  assert.equal(late.outstanding.length, 2);
  assert.equal(late.pendingSubmission.certain, false, 'B follows a taint: not provably a submission');
  assert.equal(late.noteOperatorPromptRecord(), 'consumed', 'A\'s record settles A -- MUST be red on b3335c54');
  assert.equal(late.snapshot().pendingSubmission, true, 'B still waits');
  assert.equal(late.snapshot().knownEmpty, false, 'B\'s draft is not declared empty');
  assert.equal(late.outstanding.length, 1);
  assert.equal(late.noteOperatorPromptRecord(), 'confirmed', 'the next record is B\'s own entry');
  assert.equal(late.snapshot().knownEmpty, true);
  assert.equal(late.noteOperatorPromptRecord(), 'unmatched', 'nothing outstanding: no entry, no evidence, no confirmation');
  assert.equal(late.snapshot().knownEmpty, true);

  // Two uncertain CRs: A's record settles A only.
  const twoUncertain = new InputOwnershipTracker();
  twoUncertain.observe('xyzq');
  twoUncertain.observe('\u007f');
  twoUncertain.observe('\r');
  for (const chunk of SPECIMEN_1_RAW) twoUncertain.observe(chunk);
  assert.equal(twoUncertain.outstanding.length, 2, 'a taint landed between them: B is its own entry');
  assert.equal(twoUncertain.noteOperatorPromptRecord(), 'consumed');
  assert.equal(twoUncertain.snapshot().pendingSubmission, true);
  assert.equal(twoUncertain.snapshot().knownEmpty, false);

  // CERTAIN: content placed since the previous uncertain CR with no taint
  // between -- the byte before the cursor was a seen non-backslash, so this
  // Enter submitted whatever the draft was. The first record after it
  // confirms it even while an older entry is outstanding (C8's second Enter).
  const certain = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_1_RAW) certain.observe(chunk);
  certain.observe('second line\r');
  assert.equal(certain.outstanding.length, 2);
  assert.equal(certain.pendingSubmission.certain, true);
  assert.equal(certain.noteOperatorPromptRecord(), 'confirmed', 'a certain CR is confirmed by the first record after it');
  assert.equal(certain.snapshot().knownEmpty, true);
  assert.equal(certain.outstanding.length, 1, 'its own entry stays owed: a later uncertain CR must wait behind it');
  assert.equal(certain.noteOperatorPromptRecord(), 'consumed');
  assert.equal(certain.outstanding.length, 0);

  // A taint between the two CRs makes the second one a MAYBE again, even
  // with content typed.
  const retainted = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_1_RAW) retainted.observe(chunk);
  retainted.observe('more');
  retainted.observe(`${ESC}[A`);
  retainted.observe('\r');
  assert.equal(retainted.outstanding.length, 2);
  assert.equal(retainted.pendingSubmission.certain, false);

  // IDLE MERGE: nothing placed and no taint since the previous uncertain CR
  // -- a second Enter either submits the draft (the first was a newline) or
  // does nothing (the first submitted). At most one record between them, so
  // the second takes over the first's slot instead of adding one.
  const idle = new InputOwnershipTracker();
  for (const chunk of SPECIMEN_1_RAW) idle.observe(chunk);
  const firstUnits = idle.pendingSubmission.units;
  idle.observe('\r');
  assert.equal(idle.outstanding.length, 1, 'no second entry');
  assert.equal(idle.pendingSubmission.units, firstUnits + 1, 'the latest CR owns the record');
  assert.equal(idle.outstanding[0].units, firstUnits + 1, 'and the slot');
  idle.observe('\r');
  assert.equal(idle.outstanding.length, 1);
  assert.equal(idle.noteOperatorPromptRecord(), 'confirmed');
  assert.equal(idle.snapshot().knownEmpty, true);

  // win32: a plain Enter keydown on a typed line owes one record (the
  // emptiness that counts is the one before the event's own ESC arrival);
  // on an empty composer it owes none. Its keyup restores the record intact.
  const win32 = new InputOwnershipTracker();
  win32.observe('run');
  win32.observe(WIN32_PLAIN_ENTER);
  win32.observe(WIN32_PLAIN_ENTER_UP);
  assert.equal(win32.outstanding.length, 1);
  assert.equal(win32.snapshot().knownEmpty, true);
  win32.observe(WIN32_PLAIN_ENTER);
  win32.observe(WIN32_PLAIN_ENTER_UP);
  assert.equal(win32.outstanding.length, 1, 'an empty-composer Enter is not queued');
  for (const chunk of SPECIMEN_1_WIN32) win32.observe(chunk);
  assert.equal(win32.outstanding.length, 2);
  assert.equal(win32.pendingSubmission.certain, false);
  win32.observe('second line');
  win32.observe(WIN32_PLAIN_ENTER);
  win32.observe(WIN32_PLAIN_ENTER_UP);
  assert.equal(win32.pendingSubmission.certain, true, 'the pre-sequence record decides, not the one this event\'s ESC marked');
  assert.equal(win32.pendingSubmission.dirtyAfter, false, 'the keyup restored the fresh record with its flag');

  // Rebind: the old session's records cannot land in the new transcript, so
  // everything is forgotten except the pending CR's own slot.
  const rebound = new InputOwnershipTracker();
  rebound.observe('one\r');
  for (const chunk of SPECIMEN_1_RAW) rebound.observe(chunk);
  rebound.forgetOutstanding();
  assert.equal(rebound.outstanding.length, 1);
  assert.equal(rebound.outstanding[0].units, rebound.pendingSubmission.units);
  assert.equal(rebound.noteOperatorPromptRecord(), 'confirmed', 'today\'s rebind behaviour: the next record in the new transcript confirms it');
  const drained = new InputOwnershipTracker();
  drained.observe('one\r');
  drained.forgetOutstanding();
  assert.equal(drained.outstanding.length, 0);
});

// Review of c011881c (F3): `certain` was computed only relative to a PREVIOUS
// pending CR, so with one stale slot at the head (a dialog answered with an
// arrow + Enter) a backspace-heavy operator was deferred for the rest of the
// session: every edited prompt's own record settled the slot ahead of it and
// confirmed nothing. The evidence the tracker already has: the byte before
// the cursor. When the last thing placed after the last taint was a seen
// printable (or a paste's final byte, or a newline chord), the CR submitted.
test('ML14 F3: a CR after a seen non-backslash printable is certain even right after an edit; Backspace/arrow/backslash straight before Enter are not', () => {
  // T3: abcx, Backspace, y, Enter -- the tracker saw `y` land before the cursor.
  const t3 = new InputOwnershipTracker();
  t3.observe('abcx');
  t3.observe('\u007f');
  t3.observe('y');
  t3.observe('\r');
  assert.equal(t3.snapshot().pendingSubmission, true, 'still waits for a record (the taint stands)');
  assert.equal(t3.pendingSubmission.certain, true, 'but the Enter provably submitted -- MUST be red on c011881c');

  // Backspace immediately followed by Enter: the byte before the cursor is
  // whatever the Backspace exposed -- unseen. Maybe.
  const del = new InputOwnershipTracker();
  del.observe('abc\\x');
  del.observe('\u007f');
  del.observe('\r');
  assert.equal(del.snapshot().pendingSubmission, true);
  assert.equal(del.pendingSubmission.certain, false, 'Backspace then Enter stays a maybe');

  // Arrow immediately followed by Enter: maybe.
  const arrow = new InputOwnershipTracker();
  arrow.observe('abc');
  arrow.observe(`${ESC}[D`);
  arrow.observe('\r');
  assert.equal(arrow.pendingSubmission.certain, false, 'an arrow then Enter stays a maybe');

  // A backslash typed after the taint, then Enter: a NEWLINE, not a CR
  // boundary of any kind -- unchanged.
  const backslash = new InputOwnershipTracker();
  backslash.observe('abc');
  backslash.observe('\u007f');
  backslash.observe('\\');
  backslash.observe('\r');
  assert.equal(backslash.snapshot().pendingSubmission, false, 'backslash + Enter is the newline');
  assert.equal(backslash.snapshot().lastNewline, true);
  assert.equal(backslash.outstanding.length, 0, 'a newline owes no record');

  // win32 variant of T3: the pre-sequence lastByte decides, since the Enter
  // keydown's own ESC arrival nulls the live one.
  const win32 = new InputOwnershipTracker();
  win32.observe('abcx');
  win32.observe(WIN32_BACKSPACE);
  win32.observe(WIN32_BACKSPACE_UP);
  win32.observe('y');
  win32.observe(WIN32_PLAIN_ENTER);
  win32.observe(WIN32_PLAIN_ENTER_UP);
  assert.equal(win32.snapshot().pendingSubmission, true);
  assert.equal(win32.pendingSubmission.certain, true, 'win32: a seen printable before the keydown makes it certain');

  // A paste ending in a printable, after an edit: its final byte was seen.
  const pasted = new InputOwnershipTracker();
  pasted.observe('abc');
  pasted.observe('\u007f');
  pasted.observe(`${ESC}[200~pasted text${ESC}[201~`);
  pasted.observe('\r');
  assert.equal(pasted.pendingSubmission.certain, true, 'the paste\'s final byte sits before the cursor');

  // THE PROBE: one stale slot at the head (an arrow + Enter dialog answer,
  // never recorded), then edited-and-retyped prompts. Each is certain and
  // confirms at its own record, which settles the slot ahead of it; on
  // c011881c all three were 'consumed' and nothing was ever confirmed.
  const stale = new InputOwnershipTracker();
  stale.observe(`${ESC}[B`);
  stale.observe('\r');
  assert.equal(stale.outstanding.length, 1);
  for (let i = 0; i < 3; i += 1) {
    stale.observe('helo');
    stale.observe('\u007f');
    stale.observe('lo\r');
    assert.equal(stale.pendingSubmission.certain, true, `prompt ${i}: certain`);
    assert.equal(stale.noteOperatorPromptRecord(), 'confirmed', `prompt ${i}: confirmed at its first record -- MUST be red on c011881c`);
    assert.equal(stale.snapshot().knownEmpty, true, `prompt ${i}: known empty`);
    assert.equal(stale.snapshot().unknown, false, `prompt ${i}: the taint is spent`);
    assert.equal(stale.outstanding.length, 1, `prompt ${i}: one slot carried forward, never more`);
  }
});

test('post-submit kill and cancellation retain queued input when they cancel the wake Enter', async (t) => {
  for (const kind of ['kill-switch', 'cancellation']) {
    await t.test(kind, () => {
      const harness = new RunnerHarness({
        mode: 'managed',
        ptyLoad: 'ok',
        lockState: 'free',
      });
      try {
        harness.primeAuthorized();
        harness.attemptAutomaticClear();
        harness.flushControl();
        harness.fireEnter();
        harness.operator('queued-for-fresh-context\r');

        if (kind === 'kill-switch') {
          harness.setGuard('killSwitch', true);
          harness.drive();
        } else {
          harness.cancel();
        }

        let observed = harness.snapshot();
        assert.equal(observed.holdActive, true);
        assert.ok(observed.queuedInputBytes > 0);
        assert.deepEqual(
          observed.childWrites,
          [
            Buffer.from(COMPOSER_KILL_LINE),
            Buffer.from(CLEAR_CONTROL_TEXT),
            Buffer.from(CONTROL_ENTER),
          ],
          'post-submit disable must not flush bytes before resume verification',
        );

        harness.observeClearReceipt('fresh');
        for (let turn = 0; turn < 3; turn += 1) harness.drive();
        observed = harness.snapshot();
        assert.equal(observed.holdActive, true, 'terminal wake cancellation stays fail-closed');
        assert.ok(observed.queuedInputBytes > 0, 'queued input remains held without a wake Enter');
        assert.equal(observed.lastDecision?.code, 'runner-wake-enter-cancelled');
        assert.equal(
          observed.automaticWrites.filter(
            (chunk) => chunk.equals(Buffer.from(CLEAR_CONTROL_TEXT)),
          ).length,
          1,
          'disable/cancel after submit must never retry the clear text',
        );
        assert.equal(
          Buffer.concat(observed.childWrites)
            .includes(Buffer.from('queued-for-fresh-context\r')),
          false,
          'queued bytes cannot follow wake text when cancellation prevents its Enter',
        );
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('output that predates the clear receipt cannot prove a fresh context', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    harness.fireEnter();

    harness.childOutput('late-old-context-output\r\n');
    harness.drive();
    harness.drive();
    writeJson(harness.fixture.bootPath, {
      boot_sequence: 11,
      session_id: NEXT_SESSION_ID,
      source: 'clear',
      observed_at: new Date(harness.fixture.clock.ms() + 1000).toISOString(),
    });
    for (let turn = 0; turn < 3; turn += 1) harness.drive();
    let observed = harness.snapshot();
    assert.equal(
      observed.holdActive,
      true,
      'a receipt without causally later child output must retain the hold',
    );

    harness.childOutput('fresh-context-output\r\n');
    for (let turn = 0; turn < 3; turn += 1) harness.drive();
    harness.fireEnter();
    observed = harness.snapshot();
    assert.equal(observed.holdActive, false);
    assert.deepEqual(
      observed.automaticWrites,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
      ],
    );
  } finally {
    harness.cleanup();
  }
});

test('an undrained operator queue blocks every later automatic submission', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.runner.input.observe('retained-operator-command\r');
    harness.runner.queuedInput.push(Buffer.from('retained-operator-command\r'));
    harness.pty.failWritesRemaining = 2;

    harness.attemptAutomaticClear();
    harness.drive();
    const observed = harness.snapshot();
    assert.equal(observed.queuedInputBytes > 0, true);
    assert.deepEqual(observed.automaticWrites, []);
    assert.deepEqual(observed.childWrites, []);
    assert.match(
      observed.lastDecision.code,
      /queued-input.*write-failed|queue.*not-drained/i,
    );
  } finally {
    harness.cleanup();
  }
});

function primeForTranscriptAck(harness) {
  harness.primeAuthorized();
  const cycleId = harness.cycleId();
  harness.revokeAck('test-prime-for-scan');
  harness.armAckWatch(cycleId);
}

function appendExactCapsuleAck(harness) {
  fs.appendFileSync(
    harness.fixture.transcriptPath,
    `\n{"type":"assistant","message":{"content":[{"type":"text","text":"${CAPSULE_ACK_LITERAL}"}]}}\n`,
  );
}

function clearIntentEventCount(harness) {
  return harness.runner.events.filter((event) => event.name === 'clear-intent-persisted').length;
}

// RED FIRST (2026-08-14). A seat said the ack literal and the clear never
// came; the runner stayed alive and ticking for 3.5h with the cycle parked at
// checkpoint-confirmed, clear_intent null, hold null.
//
// The transcript was not the problem: the literal was on disk, on one line,
// carrying the top-level "type":"assistant" the predicate requires. The
// SHAPE of that line is what matters. In the measured specimen the ack text
// sits early, inside message.content, and the top-level "type":"assistant"
// closes the line about 1.3k bytes later.
//
// A tick that observes such a line half-written sees the literal and no
// assistant tag, correctly declines, and then advances the search offset to
// (size - literal length). That advance lands PAST the literal, so when the
// rest of the line arrives the next read begins mid-line and the fragment it
// splits out carries the assistant tag without the literal. Neither half ever
// matches, and the ack is stranded for the life of the cycle.
//
// The offset may only advance to a COMPLETE line.
test('a transcript line observed half-written still acks once it completes', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    primeForTranscriptAck(harness);

    // Measured layout: literal early, assistant tag ~1.3k later, one line.
    const filler = 'x'.repeat(1300);
    const head = `\n{"parentUuid":"p","isSidechain":false,"message":{"model":"claude-haiku-4-5-20251001",`
      + `"role":"assistant","content":[{"type":"text","text":"${CAPSULE_ACK_LITERAL}"}],"filler":"${filler}"}`;
    const tail = ',"type":"assistant","uuid":"u"}\n';

    fs.appendFileSync(harness.fixture.transcriptPath, head);
    assert.equal(
      harness.runner._checkCapsuleAck(), false,
      'half a line carries no assistant tag yet, so it must not ack',
    );

    fs.appendFileSync(harness.fixture.transcriptPath, tail);
    assert.equal(
      harness.runner._checkCapsuleAck(), true,
      'the completed line carries both tokens and must ack',
    );
    assert.equal(harness.ackHeld(), true, 'the ack must latch for the cycle');
  } finally {
    harness.cleanup();
  }
});

// M1 WITNESS (program issue #49, G1 review round 1). What gates the clear, and
// what does NOT.
//
// The G1 seam runs a declared extension step on the capsule surface BEFORE the
// terminal literal. The reason first written for that ordering was the
// transcript-tail byte budget, and that reason is FALSE: the only enforcement
// site is `ackFresh !== true && ...` (auto-clear-transport.mjs:470), and the
// literal is precisely what sets ackFresh, so post-literal bytes can never
// produce checkpoint-transcript-short.
//
// The real reason is this: the clear is gated on the ack and on NOTHING after
// it. The checkpoint record the gate reads is written by the Stop hook on every
// turn end, so it can already be satisfied from an EARLIER turn; once the
// literal is observed mid-turn, no further condition stands between the seat
// and a minted clear. A step placed after the literal therefore runs in a
// window the core already considers closed.
test('the clear is gated on the capsule ack, and transcript growth after the ack does not gate it', () => {
  // Arm 1, control. Everything else satisfied, ack absent: refused BY NAME, so
  // the ack is demonstrably the thing standing between the seat and a clear.
  const noAck = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(noAck);
    noAck.attemptAutomaticClear();
    assert.equal(noAck.runner.lastReason?.code, 'runner-capsule-not-acked',
      'without the ack the clear must refuse, and the ack must be what is missing');
  } finally {
    noAck.cleanup();
  }

  // Arm 2. The seat prints the terminal literal and the runner observes it live
  // off the transcript, mid-turn. Then an extension step running AFTER the
  // literal lands a tool call and its result in the transcript, well past
  // CHECKPOINT_TAIL_TOLERANCE_BYTES. The clear must still go through: neither
  // the ack gate nor the byte budget holds it, and nothing waits for the turn
  // to end. That is the window a post-literal step would run in.
  const acked = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(acked);
    appendExactCapsuleAck(acked);
    assert.equal(acked.runner._checkCapsuleAck(), true, 'the literal must ack');
    assert.equal(acked.ackHeld(), true, 'the ack must latch');

    // A COMPLETED step, which is what this vector's own description says it is
    // ("lands a tool call AND ITS RESULT"). The record used to carry the
    // tool_use alone, and with no `id` on it -- an extension step frozen
    // mid-call, which is not the scenario and which #104's readiness guard
    // correctly refuses to write past (D8: a call that cannot be named is a
    // call that cannot be paired). The pair below is the step as described; the
    // assertions this vector exists for -- the ack gate and the byte budget --
    // are unchanged.
    const extensionCallId = 'toolu_post_literal_extension_01';
    fs.appendFileSync(
      acked.fixture.transcriptPath,
      `\n{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${extensionCallId}",`
      + `"name":"post_literal_extension",`
      + `"input":{"body":"${'x'.repeat(CHECKPOINT_TAIL_TOLERANCE_BYTES + 1)}"}}]}}\n`
      + `{"type":"user","message":{"content":[{"type":"tool_result",`
      + `"tool_use_id":"${extensionCallId}","is_error":false,"content":"done"}]}}\n`,
    );

    acked.attemptAutomaticClear();
    const code = acked.runner.lastReason?.code ?? null;
    assert.notEqual(code, 'runner-capsule-not-acked',
      'the ack is latched, so the ack gate must no longer refuse');
    assert.notEqual(code, 'checkpoint-transcript-short',
      'the byte budget must not fire either: the live ack supersedes it, which is exactly why '
      + 'the byte budget was never the mechanism protecting the capsule-side ordering');
    assert.ok(acked.runner.phase === 'prepared' || acked.runner.phase === 'submitted'
      || acked.runner.phase === 'cleared' || code === null,
      `the clear must proceed past the gates; phase=${acked.runner.phase} code=${code}`);
  } finally {
    acked.cleanup();
  }
});

// The second half of the same invariant: no cursor may advance past bytes
// that were never examined. The scan reads at most 262144 bytes from `from`,
// but the old cursor advanced to (size - literal length), computed from the
// FILE SIZE rather than from what was actually read. Whenever the transcript
// grew by more than the window in one interval, the bytes between the end of
// the read and the end of the file were skipped by every tick that followed.
// An ACK landing in that gap is never examined by anything.
test('a transcript that outgrows the scan window in one interval still acks', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    primeForTranscriptAck(harness);

    // One append larger than the 262144-byte window, with the ACK record last.
    const bulk = `${'{"type":"assistant","message":{"content":[{"type":"text","text":"filler"}]}}\n'.repeat(4200)}`;
    fs.appendFileSync(harness.fixture.transcriptPath, `\n${bulk}`);
    appendExactCapsuleAck(harness);
    assert.ok(
      fs.statSync(harness.fixture.transcriptPath).size > 262144,
      'fixture must exceed the scan window or it proves nothing',
    );

    // Bounded sweep: each tick may only advance by one window, so the ACK is
    // allowed to take several ticks. It may never be skipped entirely.
    let acked = false;
    for (let tick = 0; tick < 20 && !acked; tick += 1) {
      acked = harness.runner._checkCapsuleAck();
    }
    assert.equal(acked, true, 'an ACK past the first scan window must still be examined');
  } finally {
    harness.cleanup();
  }
});

// The record shape measured from the preserved session, rebuilt rather than
// pasted. Same key order, same nesting, and the same span between the ACK text
// and the top-level assistant tag; the identifying values (seat path, session
// and request ids) are fixture values, because a real seat's cwd must not be
// committed to a tree headed for publication.
//
// MEASURED, and the ordering matters: the ACK text sits at offset 227 of the
// line and the top-level "type":"assistant" at 1034, so the ACK comes FIRST
// and the tag closes the record 807 bytes later. The two nested "type" fields
// ("message", "text") both precede the ACK and neither satisfies the match.
const MEASURED_ACK_GAP = 807;

function liveShapeAckRecord(sessionId) {
  const head = `{"parentUuid":"69a1d73b-a5f8-4ff1-99bb-e20902d78fed","isSidechain":false,`
    + `"message":{"model":"claude-haiku-4-5-20251001","id":"msg_fixture","type":"message",`
    + `"role":"assistant","content":[{"type":"text","text":"${CAPSULE_ACK_LITERAL}"}]`;
  const tail = `,"type":"assistant","uuid":"fixture-uuid","timestamp":"2026-08-15T01:49:39.000Z",`
    + `"session_id":"${sessionId}","userType":"external","entrypoint":"cli",`
    + `"cwd":"/fixture/seat","sessionId":"${sessionId}","version":"2.1.232","gitBranch":"HEAD"}`;
  // Pad the span between the ACK and the tag out to the measured distance.
  const ackAt = head.indexOf(CAPSULE_ACK_LITERAL);
  const filler = 'x'.repeat(Math.max(0, MEASURED_ACK_GAP - (head.length - ackAt)));
  const line = `${head},"requestId":"req_${filler}"}${tail}`;
  const gap = line.indexOf('"type":"assistant"') - line.indexOf(CAPSULE_ACK_LITERAL);
  assert.ok(
    gap >= MEASURED_ACK_GAP,
    `fixture must keep the measured ACK-to-tag span (got ${gap}, need >= ${MEASURED_ACK_GAP})`,
  );
  assert.ok(!line.includes('\n'), 'the record is one line, as it is on disk');
  return line;
}

// §3 direct vector. The transport is already checkpoint-confirmed before the
// ACK exists (that is the state the parked seat was in), the record arrives
// after a span larger than the old scan could carry across, and the ACK must
// produce exactly one clear: one text write, one Enter, and no second clear
// however many ticks follow.
test('the live-record ACK produces exactly one clear from checkpoint-confirmed', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    assert.equal(
      harness.runner.lastCoreResult?.state?.state ?? 'checkpoint-confirmed',
      'checkpoint-confirmed',
      'the seat is confirmed before it has acked, which is the parked shape',
    );

    // The record itself, split so the scan must survive seeing it half-written.
    // Growth beyond the scan window is covered by its own vector above; piling
    // it on here would only trip the transport's own checkpoint arithmetic and
    // stop the test measuring what it is for.
    const record = liveShapeAckRecord(harness.runner.sessionId);
    const split = record.indexOf('"type":"assistant"');
    // Put the offset on a line boundary, as a real transcript is, then tear the record.
    fs.appendFileSync(harness.fixture.transcriptPath, '\n');
    harness.armAckWatch();
    const boundary = harness.runner.capsuleAckWatch.from;
    fs.appendFileSync(harness.fixture.transcriptPath, record.slice(0, split));
    // The scan MUST run here, on the half-written record. Appending both
    // halves before looking would never reproduce the tear that stranded the
    // live ack, and the vector would pass against the defect it exists for.
    assert.equal(harness.runner._checkCapsuleAck(), false, 'half a record is not an ack');
    assert.equal(harness.runner.capsuleAckWatch.from, boundary, 'a torn record shorter than the window never moves the offset');
    fs.appendFileSync(harness.fixture.transcriptPath, `${record.slice(split)}\n`);

    let acked = false;
    for (let i = 0; i < 20 && !acked; i += 1) acked = harness.runner._checkCapsuleAck();
    assert.equal(acked, true, 'the live-record ACK must be observed');

    harness.attemptAutomaticClear();
    harness.flushControl();
    const writes = harness.snapshot().automaticWrites.map(String);
    assert.equal(
      writes.filter((w) => w.includes(CLEAR_CONTROL_TEXT)).length, 1,
      `exactly one clear text write (got ${JSON.stringify(writes)})`,
    );
    assert.equal(clearIntentEventCount(harness), 1, 'exactly one clear intent');

    // Repeated ticks must not produce a second clear.
    harness.drive();
    harness.drive();
    harness.attemptAutomaticClear();
    assert.equal(clearIntentEventCount(harness), 1, 'the ack is spent; no second clear');
  } finally {
    harness.cleanup();
  }
});

// Negative controls for the scanner. Each is a way the literal can appear on
// disk without the seat having said it this cycle, and none may ack.
test('NEG: the literal inside a user record is a mention, not an ack', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    // The capsule SKILL quotes the literal in its own instructions, and that
    // text lands in the transcript as a user record the moment the verb runs.
    fs.appendFileSync(
      harness.fixture.transcriptPath,
      `\n{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say ${CAPSULE_ACK_LITERAL} when done"}]}}\n`,
    );
    assert.equal(harness.runner._checkCapsuleAck(), false, 'a mention must never ack');
    assert.equal(harness.ackHeld(), false);
  } finally {
    harness.cleanup();
  }
});

// Issue #79: the ack is an exact trimmed LINE of an assistant text block, never
// a substring of the raw JSONL line. Each case runs _checkCapsuleAck on a fresh
// armed harness.
// Re-open the cycle's ack window at the transcript's current end, through the
// runner's own writers. Ack evidence is identity-bound (#91), so a test cannot
// hand-build it and a window must name the cycle it belongs to.
function reopenAckWindow(harness) {
  const cycleId = harness.cycleId();
  harness.revokeAck('test-reopen-window');
  harness.armAckWatch(cycleId);
}

function ackCase(name, fn) {
  test(`#79 ${name}`, () => {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try { primeForTranscriptAck(harness); fn(harness); } finally { harness.cleanup(); }
  });
}
const appendRecord = (h, rec) => fs.appendFileSync(h.fixture.transcriptPath, `\n${typeof rec === 'string' ? rec : JSON.stringify(rec)}\n`);
const assistantOf = (...content) => ({ type: 'assistant', message: { content } });

ackCase('exact line with surrounding whitespace acks', (h) => {
  appendRecord(h, assistantOf({ type: 'text', text: `Done.\n  ${CAPSULE_ACK_LITERAL}  \n` }));
  assert.equal(h.runner._checkCapsuleAck(), true);
});
ackCase('the literal inside a sentence does not ack', (h) => {
  appendRecord(h, assistantOf({ type: 'text', text: 'I would say Capsule Complete, Ready For Clear once tests pass' }));
  assert.equal(h.runner._checkCapsuleAck(), false);
});
ackCase('wrong case does not ack', (h) => {
  appendRecord(h, assistantOf({ type: 'text', text: CAPSULE_ACK_LITERAL.toLowerCase() }));
  assert.equal(h.runner._checkCapsuleAck(), false);
});
ackCase('the literal in a user/meta record does not ack', (h) => {
  appendRecord(h, { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: CAPSULE_ACK_LITERAL }] } });
  assert.equal(h.runner._checkCapsuleAck(), false);
});
ackCase('the literal in a thinking block does not ack', (h) => {
  appendRecord(h, assistantOf({ type: 'thinking', thinking: CAPSULE_ACK_LITERAL }));
  assert.equal(h.runner._checkCapsuleAck(), false);
});
ackCase('the literal in a tool_use input does not ack', (h) => {
  appendRecord(h, assistantOf({ type: 'tool_use', name: 'Bash', input: { command: `echo "${CAPSULE_ACK_LITERAL}"`, note: CAPSULE_ACK_LITERAL } }));
  assert.equal(h.runner._checkCapsuleAck(), false);
});
ackCase('a literal split across a partial line does not ack until the line completes', (h) => {
  const line = JSON.stringify(assistantOf({ type: 'text', text: CAPSULE_ACK_LITERAL }));
  const cut = line.indexOf('Ready');
  fs.appendFileSync(h.fixture.transcriptPath, '\n');
  h.armAckWatch();
  const boundary = h.runner.capsuleAckWatch.from;
  fs.appendFileSync(h.fixture.transcriptPath, line.slice(0, cut));
  assert.equal(h.runner._checkCapsuleAck(), false, 'half a line is not an ack');
  assert.equal(h.runner.capsuleAckWatch.from, boundary, 'the offset stays on the boundary');
  fs.appendFileSync(h.fixture.transcriptPath, `${line.slice(cut)}\n`);
  assert.equal(h.runner._checkCapsuleAck(), true, 'the completed line acks');
});
ackCase('a thin wrapper around the literal acks', (h) => {
  const wraps = ['`L`', '**L**', '__L__', 'L.', '**L.**', '`L.`', '**L**.', '`L`.', '__L__.', 'Done:@```@L@```', 'Done:@```@L@```@'];
  for (const w of wraps) {
    reopenAckWindow(h);
    appendRecord(h, assistantOf({ type: 'text', text: w.replace('L', CAPSULE_ACK_LITERAL).replace(/@/g, '\n') }));
    assert.equal(h.runner._checkCapsuleAck(), true, `wrapper ${JSON.stringify(w)} must ack`);
  }
});
ackCase('a bullet, a single-character wrapper or a mid-text quote does not ack', (h) => {
  const texts = ['* L', '*L', '- L', '_L', '> L', '*L*', '_L_',
    'I will print:@@L@@Writing now', 'L@and then more', 'First L@then ```@L@```@tail'];
  for (const t of texts) {
    reopenAckWindow(h);
    appendRecord(h, assistantOf({ type: 'text', text: t.replace(/L/g, CAPSULE_ACK_LITERAL).replace(/@/g, '\n') }));
    assert.equal(h.runner._checkCapsuleAck(), false, `${JSON.stringify(t)} must not ack`);
  }
});
ackCase('only the last text block counts', (h) => {
  appendRecord(h, assistantOf({ type: 'text', text: CAPSULE_ACK_LITERAL }, { type: 'text', text: 'and one more thing' }));
  assert.equal(h.runner._checkCapsuleAck(), false);
});
ackCase('a sidechain assistant record with the bare literal does not ack', (h) => {
  appendRecord(h, { ...assistantOf({ type: 'text', text: CAPSULE_ACK_LITERAL }), isSidechain: true });
  assert.equal(h.runner._checkCapsuleAck(), false);
});
ackCase('a record longer than the read window does not pin the offset; a later ack line acks', (h) => {
  appendRecord(h, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(600000) }] } });
  assert.equal(h.runner._checkCapsuleAck(), false); // consumes the record's leading newline
  const before = h.runner.capsuleAckWatch.from;
  assert.equal(h.runner._checkCapsuleAck(), false);
  assert.equal(h.runner.capsuleAckWatch.from, before + 262144, 'the skip tick advances by exactly one window');
  assert.equal(h.runner.events.filter((e) => e.name === 'capsule-ack-window-skip').length, 1);
  assert.equal(h.runner._checkCapsuleAck(), false); // second window of the same run: no second event
  assert.equal(h.runner.events.filter((e) => e.name === 'capsule-ack-window-skip').length, 1, 'one event per skip run');
  appendRecord(h, assistantOf({ type: 'text', text: CAPSULE_ACK_LITERAL }));
  let acked = false;
  for (let i = 0; i < 6 && !acked; i += 1) acked = h.runner._checkCapsuleAck();
  assert.equal(acked, true);
});
ackCase('a malformed JSON line containing the literal does not ack', (h) => {
  appendRecord(h, `{"type":"assistant","message":{"content":[{"type":"text","text":"${CAPSULE_ACK_LITERAL}"}]}`);
  assert.equal(h.runner._checkCapsuleAck(), false);
});

test('NEG: an ack written before the request boundary belongs to an earlier cycle', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.primeAuthorized();
    const cycleId = harness.cycleId();
    harness.revokeAck();
    appendExactCapsuleAck(harness);   // lands FIRST
    harness.armAckWatch(cycleId); // boundary moves past it
    assert.equal(harness.runner._checkCapsuleAck(), false, 'an ack behind the boundary belongs to an earlier cycle');
    assert.equal(harness.ackHeld(), false);
  } finally {
    harness.cleanup();
  }
});

test('NEG: an ack bound to another session is not this session ack', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    appendExactCapsuleAck(harness);
    // The scan resolves the transcript from the bound session id, so a
    // different session cannot be acked by this one's file.
    harness.runner.sessionId = '00000000-0000-4000-8000-00000000dead';
    assert.equal(harness.runner._checkCapsuleAck(), false, 'the ack must bind to the current session');
    assert.equal(harness.ackHeld(), false);
  } finally {
    harness.cleanup();
  }
});

test('T1 measured shape: the first valid ACK commits one clear despite later printable win32 input', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    primeForTranscriptAck(harness);

    harness.operator('measured objective');
    harness.operator('\r');
    harness.operator(`${ESC}[I`); // benign focus-in report
    harness.operator(`${ESC}[<0;12;6M`); // benign SGR mouse report
    harness.operator(`${ESC}[49;2;49;1;0;1_`); // printable '1' keydown: Vk;Sc;Uc;Kd;Cs;Rc
    harness.operator(`${ESC}[49;2;49;0;0;1_`); // printable '1' keyup

    assert.equal(
      harness.runner.input.snapshot().knownEmpty,
      false,
      'red-specimen precondition: printable 1 remains tracked with no later Return',
    );
    appendExactCapsuleAck(harness);
    harness.drive();

    assert.equal(
      clearIntentEventCount(harness),
      1,
      'RED on unmodified af673de: runner-input-not-empty prevents the ACK from persisting its one clear intent',
    );
    assert.doesNotMatch(
      readDaemonErrorLog(harness.fixture.memRoot),
      /runner-input-not-empty/,
      'an acknowledged clear must not be vetoed by composer/input ownership',
    );
  } finally {
    harness.cleanup();
  }
});

test('T2 arbitrary printable operator input before the ACK does not veto its clear', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    primeForTranscriptAck(harness);
    harness.operator('zebra-42?');
    const tracked = harness.runner.snapshot().input;
    assert.equal(tracked.knownEmpty, false, 'setup: arbitrary printable bytes remain observable');
    for (const field of ['knownEmpty', 'activePaste', 'activeControl', 'unknown', 'receivedUnits', 'lastTaint', 'lastByte', 'lastNewline']) {
      assert.equal(Object.hasOwn(tracked, field), true, `status snapshot must retain ${field}`);
    }

    appendExactCapsuleAck(harness);
    harness.drive();

    assert.equal(clearIntentEventCount(harness), 1);
    assert.doesNotMatch(
      readDaemonErrorLog(harness.fixture.memRoot),
      /runner-input-not-empty|runner-input-sequence-active/,
    );
  } finally {
    harness.cleanup();
  }
});

test('scripted adapter classifies only runner control writes as automatic', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.setGuard('killSwitch', true);
    harness.drive();
    harness.operator(Buffer.from(CLEAR_CONTROL_INPUT));
    const observed = harness.snapshot();
    assert.deepEqual(observed.automaticWrites, []);
    assert.deepEqual(
      Buffer.concat(observed.childWrites),
      Buffer.from(CLEAR_CONTROL_INPUT),
    );
    assert.equal(DEGRADED_NODE_PTY, 'DEGRADED:auto-clear-node-pty-unavailable');
  } finally {
    harness.cleanup();
  }
});

test('an idle manual clear rebinds lifecycle decisions to the new session', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.operator(Buffer.from(CLEAR_CONTROL_INPUT));
    writeJson(harness.fixture.bootPath, {
      boot_sequence: 11,
      session_id: NEXT_SESSION_ID,
      source: 'clear',
      observed_at: new Date(harness.fixture.clock.ms() + 1000).toISOString(),
    });
    harness.drive();

    assert.equal(harness.runner.sessionId, NEXT_SESSION_ID);
    assert.equal(harness.runner.baselineBootSequence, 11);
    assert.deepEqual(harness.snapshot().automaticWrites, []);
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(CLEAR_CONTROL_INPUT), Buffer.from(WAKE_MESSAGE)],
      'the operator-issued /clear is followed by exactly one wake for the verified fresh rebound',
    );
  } finally {
    harness.cleanup();
  }
});

test('L4b manual-clear rebound: operator bytes during the pending wake Enter queue behind it, not through it', () => {
  // The clear-submission inputHold never armed on this path, so the queue
  // gate's pending-wake-Enter clause is the ONLY thing standing between
  // operator bytes and the composer holding an unsubmitted wake text
  // (mutation m3: dropping that clause must turn THIS test red).
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const duringWake = Buffer.from('typed-during-pending-wake\r');
    harness.operator(Buffer.from(CLEAR_CONTROL_INPUT));
    writeJson(harness.fixture.bootPath, {
      boot_sequence: 11,
      session_id: NEXT_SESSION_ID,
      source: 'clear',
      observed_at: new Date(harness.fixture.clock.ms() + 1000).toISOString(),
    });
    harness.drive();
    assert.equal(harness.scheduler.enters.size >= 1, true, 'setup: the wake Enter is pending');

    harness.operator(duringWake);
    assert.deepEqual(
      harness.runner.queuedInput.map(asBuffer),
      [duringWake],
      'operator bytes during the pending wake Enter must queue, never write through',
    );
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(CLEAR_CONTROL_INPUT), Buffer.from(WAKE_MESSAGE)],
      'no operator bytes reach the child before the wake Enter lands',
    );

    assert.equal(harness.fireEnter(), true, 'the wake Enter physically writes');
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(CLEAR_CONTROL_INPUT),
        Buffer.from(WAKE_MESSAGE),
        Buffer.from(CONTROL_ENTER),
        duringWake,
      ],
      'queued bytes release in order only after the wake Enter',
    );
  } finally {
    harness.cleanup();
  }
});

test('M1 manual-clear rebind ends its tick: no checkpoint control text can precede the wake Enter', () => {
  // PATCH-001M binary-resume guard. The rebound transport demands a checkpoint
  // on its very first tick; without the same-tick return after a successful
  // _rebindAfterClear, tick() continues into transport.tick() and writes
  // /context-capsule onto the composer that holds the unsubmitted wake text.
  // Red at 50aae705 (guard absent), green with the guard. Mutation: deleting
  // the immediate return turns the capsule-count assertion red.
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transportFactory = (receipt) => {
      const core = new StillCapsuleTransport(receipt.session_id, 'post-clear-cycle-1');
      core.beginClearSubmission = () => { throw new Error('unused in this specimen'); };
      core.confirmClearObserved = () => { throw new Error('unused in this specimen'); };
      core.close = () => {};
      return core;
    };
    harness.operator(Buffer.from(CLEAR_CONTROL_INPUT));
    writeJson(harness.fixture.bootPath, {
      boot_sequence: 11,
      session_id: NEXT_SESSION_ID,
      source: 'clear',
      observed_at: new Date(harness.fixture.clock.ms() + 1000).toISOString(),
    });
    harness.drive();

    assert.equal(harness.runner.sessionId, NEXT_SESSION_ID, 'setup: the rebind happened');
    assert.equal(harness.scheduler.enters.size >= 1, true, 'setup: the wake Enter is pending');
    assert.equal(
      capsuleTextWriteCount(harness), 0,
      'no checkpoint control text may be written before the wake Enter lands',
    );
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(CLEAR_CONTROL_INPUT), Buffer.from(WAKE_MESSAGE)],
      'child-visible bytes are exactly the manual /clear then the wake text',
    );

    assert.equal(harness.fireEnter(), true, 'the wake Enter physically writes');
    // #104: the rebound session needs a transcript for the capsule request's
    // readiness gate to be able to see it. A real session that is being asked
    // for a capsule has one -- the request only fires for a session at
    // pressure -- and an ABSENT transcript at that boundary now means the path
    // mis-resolved rather than "no records yet" (D40-D44). Writing one here
    // keeps this vector about its own subject, which is the pre-wake ordering
    // asserted above, not about transcript resolution.
    const reboundTranscript = transcriptPathFor({
      cwd: harness.fixture.cwd, sessionId: NEXT_SESSION_ID, homeDir: harness.fixture.homeDir,
    });
    fs.mkdirSync(path.dirname(reboundTranscript), { recursive: true });
    fs.writeFileSync(reboundTranscript, `{"type":"summary"}${'\n'}`);
    harness.drive();
    // PATCH-001S-r3: once the wake Enter has landed, checkpoint-requested
    // buys the capsule request again (busy-turn submission rides the native
    // queued-prompt path). The rebind guard M1 exists for is proven by the
    // pre-wake assertions above -- no checkpoint text before the wake landed.
    assert.equal(
      capsuleTextWriteCount(harness), 1,
      'later lifecycle work proceeds normally once the wake Enter has landed',
    );
  } finally {
    harness.cleanup();
  }
});

test('a higher same-session clear receipt releases safely and disables re-arming by name', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    harness.fireEnter();
    harness.operator('queued-after-same-session-clear\r');
    harness.observeClearReceipt('same-session-fresh');
    for (let turn = 0; turn < 3; turn += 1) harness.drive();

    const observed = harness.snapshot();
    assert.equal(observed.holdActive, false);
    assert.equal(observed.queuedInputBytes, 0);
    assert.equal(harness.runner.automationEnabled, false);
    assert.equal(
      observed.lastDecision.code,
      'runner-clear-session-not-rotated',
    );
    assert.deepEqual(
      observed.automaticWrites,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
      ],
    );
  } finally {
    harness.cleanup();
  }
});

test(
  'Windows SIGINT forwarding writes one ETX through the sole PTY writer',
  { skip: process.platform === 'win32' ? false : 'Windows ConPTY behavior only' },
  () => {
    const harness = new RunnerHarness({
      mode: 'managed',
      ptyLoad: 'ok',
      lockState: 'free',
    });
    try {
      harness.setGuard('killSwitch', true);
      harness.drive();
      assert.equal(harness.sigint(), true);
      assert.deepEqual(harness.pty.writes, [Buffer.from([0x03])]);
      assert.deepEqual(harness.snapshot().signals, ['SIGINT']);
    } finally {
      harness.cleanup();
    }
  },
);

test('Windows npm-style command shims use node-pty pre-escaped cmd hosting', () => {
  const shim = 'C:\\Program Files\\nodejs\\claude.CMD';
  const result = resolvePtyCommand({
    command: 'claude',
    args: ['--continue', '/open', '100%', '%PATH%'],
    platform: 'win32',
    env: {
      Path: 'C:\\Program Files\\nodejs',
      PATHEXT: '.EXE;.CMD',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    fsImpl: {
      statSync(candidate) {
        if (candidate.toLowerCase() !== shim.toLowerCase()) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return { isFile: () => true };
      },
    },
  });

  assert.equal(result.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(typeof result.args, 'string');
  assert.match(result.args, /^\/d \/v:off \/s \/c /);
  assert.match(result.args, /%__AIGENT_PTY_SHIM_COMMAND%/);
  assert.match(result.args, /%__AIGENT_PTY_SHIM_ARG_0%/);
  assert.equal(
    result.env.__AIGENT_PTY_SHIM_COMMAND,
    '"C:\\Program Files\\nodejs\\claude.CMD"',
  );
  assert.equal(result.env.__AIGENT_PTY_SHIM_ARG_0, '"--continue"');
  assert.equal(result.env.__AIGENT_PTY_SHIM_ARG_1, '"/open"');
  assert.equal(result.env.__AIGENT_PTY_SHIM_ARG_2, '"100%"');
  assert.equal(result.env.__AIGENT_PTY_SHIM_ARG_3, '"%PATH%"');
});

test('standard npm node shims unwrap to direct argv without cmd expansion', () => {
  const shim = 'C:\\Tools\\claude.cmd';
  const node = 'C:\\Tools\\node.exe';
  const target = 'C:\\Tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const files = new Set([shim, node, target].map((value) => value.toLowerCase()));
  const result = resolvePtyCommand({
    command: shim,
    args: ['100%', '%PATH%', 'quote"inside', 'space value'],
    platform: 'win32',
    env: {},
    fsImpl: {
      statSync(candidate) {
        if (!files.has(candidate.toLowerCase())) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return { isFile: () => true };
      },
      readFileSync(candidate) {
        assert.equal(candidate.toLowerCase(), shim.toLowerCase());
        return [
          '@SETLOCAL',
          '@IF EXIST "%~dp0\\node.exe" (',
          '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
          ')',
        ].join('\r\n');
      },
    },
  });
  assert.equal(result.command, node);
  assert.deepEqual(result.args, [
    target,
    '100%',
    '%PATH%',
    'quote"inside',
    'space value',
  ]);
  assert.equal(result.env, undefined);
});

test(
  'Windows unmanaged shim hosting preserves percent and metacharacter argv',
  { skip: process.platform === 'win32' ? false : 'Windows cmd shim behavior only' },
  () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'run2-win-argv-'));
    const probe = path.join(temporary, 'probe.mjs');
    const shim = path.join(temporary, 'probe.cmd');
    const output = path.join(temporary, 'argv.json');
    writeText(
      probe,
      "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n",
    );
    writeText(shim, '@echo off\r\nnode "%~dp0probe.mjs" %*\r\n');
    const expected = [
      '100%',
      '%PATH%',
      'bang!',
      'a&b',
      'space value',
      'quote"inside',
      'trailing\\',
      '',
    ];
    try {
      const status = runUnmanaged({
        command: shim,
        args: [output, ...expected],
        platform: 'win32',
        env: process.env,
      });
      assert.equal(status, 0);
      assert.deepEqual(readJson(output), expected);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test('unmanaged fallback preserves signals and avoids the Windows shell wrapper', () => {
  assert.equal(
    runUnmanaged({
      command: 'ignored',
      platform: 'linux',
      spawnSyncFn: () => ({ status: null, signal: 'SIGTERM' }),
    }),
    143,
  );

  const executable = 'C:\\Program Files\\nodejs\\node.exe';
  let directCall = null;
  const directStatus = runUnmanaged({
    command: executable,
    args: ['-e', 'process.exit(7)'],
    platform: 'win32',
    env: {
      Path: 'C:\\Program Files\\nodejs',
      PATHEXT: '.EXE;.CMD',
    },
    fsImpl: {
      statSync(candidate) {
        if (candidate !== executable) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isFile: () => true };
      },
    },
    spawnSyncFn(command, args, options) {
      directCall = { command, args, options };
      return { status: 7, signal: null };
    },
  });
  assert.equal(directStatus, 7);
  assert.equal(directCall.command, executable);
  assert.deepEqual(directCall.args, ['-e', 'process.exit(7)']);
  assert.equal(directCall.options.shell, false);
  assert.equal(directCall.options.windowsVerbatimArguments, undefined);

  const shim = 'C:\\Program Files\\nodejs\\claude.CMD';
  let shimCall = null;
  runUnmanaged({
    command: 'claude',
    args: ['--continue', '/open', '100%', '%PATH%'],
    platform: 'win32',
    env: {
      Path: 'C:\\Program Files\\nodejs',
      PATHEXT: '.EXE;.CMD',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    fsImpl: {
      statSync(candidate) {
        if (candidate.toLowerCase() !== shim.toLowerCase()) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return { isFile: () => true };
      },
    },
    spawnSyncFn(command, args, options) {
      shimCall = { command, args, options };
      return { status: 0, signal: null };
    },
  });
  assert.equal(shimCall.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(shimCall.args.length, 1);
  assert.match(shimCall.args[0], /^\/d \/v:off \/s \/c /);
  assert.equal(shimCall.options.shell, false);
  assert.equal(shimCall.options.windowsVerbatimArguments, true);
  assert.equal(shimCall.options.env.__AIGENT_PTY_SHIM_ARG_2, '"100%"');
  assert.equal(shimCall.options.env.__AIGENT_PTY_SHIM_ARG_3, '"%PATH%"');
});

test('public managed start failure kills the spawned carrier and releases its lock', () => {
  const fixture = makeFixture('start-unwind');
  let killed = false;
  let released = 0;
  let promptExitCode = null;
  const invalidPty = {
    write() {},
    kill() { killed = true; },
  };
  try {
    const result = runPtySession({
      root: fixture.root,
      cwd: fixture.cwd,
      env: fixture.env,
      fsImpl: fs,
      stdin: new ScriptedStream(),
      stdout: new ScriptedStream(),
      stderr: new ScriptedStream(),
      processLike: new ScriptedStream(),
      homeDir: fixture.homeDir,
      loadNodePtyFn: () => ({
        ok: true,
        module: { spawn: () => invalidPty },
      }),
      acquireRunnerLockFn: () => ({ path: 'scripted-lock' }),
      releaseRunnerLockFn: () => { released += 1; },
      readKillSwitchFn: () => ({ active: false, code: null, detail: null }),
      readBootReceiptFn: () => ({
        ok: true,
        receipt: readJson(fixture.bootPath),
      }),
      exitFn: (code) => { promptExitCode = code; },
    });
    assert.equal(result.mode, 'failed');
    assert.equal(result.code, 'runner-start-failed');
    assert.equal(result.exitCode, 1);
    assert.equal(released, 1);
    assert.equal(killed, true);
    assert.equal(promptExitCode, 1);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('a throwing boot-baseline seam fails named and releases the pre-spawn lock', () => {
  const fixture = makeFixture('baseline-unwind');
  let released = 0;
  let spawned = 0;
  try {
    const result = runPtySession({
      root: fixture.root,
      cwd: fixture.cwd,
      env: fixture.env,
      fsImpl: fs,
      stdin: new ScriptedStream(),
      stdout: new ScriptedStream(),
      stderr: new ScriptedStream(),
      processLike: new ScriptedStream(),
      homeDir: fixture.homeDir,
      loadNodePtyFn: () => ({
        ok: true,
        module: {
          spawn() {
            spawned += 1;
            return new ScriptedPty();
          },
        },
      }),
      acquireRunnerLockFn: () => ({ path: 'scripted-lock' }),
      releaseRunnerLockFn: () => { released += 1; },
      readKillSwitchFn: () => ({ active: false, code: null, detail: null }),
      readBootReceiptFn: () => { throw new Error('scripted baseline failure'); },
    });
    assert.equal(result.mode, 'failed');
    assert.equal(result.code, 'runner-boot-baseline-failed');
    assert.equal(result.exitCode, 1);
    assert.equal(released, 1);
    assert.equal(spawned, 0);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('a malformed boot baseline fails closed before the PTY spawn', () => {
  const fixture = makeFixture('baseline-shape');
  let released = 0;
  let spawned = 0;
  try {
    const result = runPtySession({
      root: fixture.root,
      cwd: fixture.cwd,
      env: fixture.env,
      fsImpl: fs,
      stdin: new ScriptedStream(),
      stdout: new ScriptedStream(),
      stderr: new ScriptedStream(),
      processLike: new ScriptedStream(),
      homeDir: fixture.homeDir,
      loadNodePtyFn: () => ({
        ok: true,
        module: {
          spawn() {
            spawned += 1;
            return new ScriptedPty();
          },
        },
      }),
      acquireRunnerLockFn: () => ({ path: 'scripted-lock' }),
      releaseRunnerLockFn: () => { released += 1; },
      readKillSwitchFn: () => ({ active: false, code: null, detail: null }),
      readBootReceiptFn: () => ({ ok: true, receipt: {} }),
    });
    assert.equal(result.mode, 'failed');
    assert.match(result.code, /boot-receipt-field-missing|boot-baseline/i);
    assert.equal(result.exitCode, 1);
    assert.equal(released, 1);
    assert.equal(spawned, 0);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('V1 threshold-applied: env=15 reaches the production transport constructor', () => {
  const env = {};
  env.AIGENT_PRESSURE_THRESHOLD_PCT = '15';
  const probe = makeThresholdWiringProbe('run3-v1-threshold-applied', env);
  try {
    probe.bindTransport();
    assert.equal(probe.constructed.length, 1);
    assert.equal(probe.constructed[0].pressureThresholdPct, 15);
    // Positive control for the V2 ordering spies: the managed path must
    // provably route through both spied call sites, or V2's zero-count
    // assertions could go green with miswired spies.
    assert.deepEqual(probe.orderingSpyCounts(), {
      nodePtyLoadCount: 1,
      runnerLockAcquireCount: 1,
    });
  } finally {
    probe.close();
  }

  for (const [raw, expected] of [['5', 5], ['95', 95]]) {
    const boundaryEnv = {};
    boundaryEnv.AIGENT_PRESSURE_THRESHOLD_PCT = raw;
    const boundaryProbe = makeThresholdWiringProbe(
      `run3-v1-threshold-boundary-${raw}`,
      boundaryEnv,
    );
    try {
      boundaryProbe.bindTransport();
      assert.equal(boundaryProbe.constructed.length, 1);
      assert.equal(boundaryProbe.constructed[0].pressureThresholdPct, expected);
    } finally {
      boundaryProbe.close();
    }
  }
});

test('#98 the child never inherits CLAUDE_CODE_CHILD_SESSION: the managed spawn and the unmanaged fallback both get a scrubbed copy that asks for persistence; the runner\'s own env is untouched', () => {
  // Contaminated parent: a maintenance Claude session started this runner.
  const env = { CLAUDE_CODE_CHILD_SESSION: '1', TERM: 'xterm-256color', KEEP: 'me' };
  const probe = makeThresholdWiringProbe('issue-98-contaminated-parent', env);
  try {
    assert.equal(probe.result.mode, 'managed');
    assert.equal(probe.spawnEnvs.length, 1, 'one managed spawn');
    const child = probe.spawnEnvs[0];
    assert.equal(Object.hasOwn(child, 'CLAUDE_CODE_CHILD_SESSION'), false,
      'the marker that turns transcript persistence off must not reach the seat');
    assert.equal(child.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '1',
      'and persistence is asked for through the host\'s own opt-in');
    assert.equal(child.KEEP, 'me', 'everything else is inherited');
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, '1',
      'the runner\'s own environment is left as the parent set it: no global scrub');
    assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE'), false);
  } finally {
    probe.close();
  }

  // Clean control: nothing to remove, the opt-in still set, nothing else changes.
  const clean = makeThresholdWiringProbe('issue-98-clean-parent', { TERM: 'xterm-256color', KEEP: 'me' });
  try {
    assert.deepEqual(clean.spawnEnvs[0], { TERM: 'xterm-256color', KEEP: 'me', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' });
  } finally {
    clean.close();
  }

  // The unmanaged fallback (no node-pty) spawns through the same boundary.
  const seen = [];
  const code = runUnmanaged({
    command: 'claude',
    args: ['--continue'],
    cwd: os.tmpdir(),
    env: { CLAUDE_CODE_CHILD_SESSION: '1', KEEP: 'me' },
    platform: 'linux',
    spawnSyncFn: (command, args, options) => { seen.push({ command, args, env: options.env }); return { status: 0 }; },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.equal(Object.hasOwn(seen[0].env, 'CLAUDE_CODE_CHILD_SESSION'), false);
  assert.equal(seen[0].env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '1');
  assert.equal(seen[0].env.KEEP, 'me');
  // The pure function, for the launcher scripts' sake: same answer, same shape.
  assert.deepEqual(childEnvironment({ CLAUDE_CODE_CHILD_SESSION: '1', A: 'b' }), { A: 'b', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' });
  // An operator's explicit opt-in value is a word kept, never overridden.
  assert.equal(childEnvironment({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '0' }).CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '0');
});

test('V2 threshold-invalid-refuses: env=abc is loud and automation stays disarmed', () => {
  const env = {};
  env.AIGENT_PRESSURE_THRESHOLD_PCT = 'abc';
  const probe = makeThresholdWiringProbe('run3-v2-threshold-invalid', env);
  try {
    assert.deepEqual(probe.observed(), {
      stderrBytes: 0,
      mode: 'degraded',
      runnerPresent: false,
      managedSpawnCount: 0,
      transportConstructionCount: 0,
      unmanagedSpawnCount: 1,
      nodePtyLoadCount: 0,
      runnerLockAcquireCount: 0,
      runnerLockReleaseCount: 0,
    });
    assert.ok(
      probe.loggedLine().includes('tag="pty-runner" message="DEGRADED:auto-clear-threshold-invalid abc"'),
      `expected the threshold-invalid line in .daemon-errors.log, got: ${probe.loggedLine()}`,
    );
  } finally {
    probe.close();
  }

  const otherInvalidValues = ['', '4', '96', '15.5', '1e1', 15];
  for (const [index, raw] of otherInvalidValues.entries()) {
    const invalidEnv = {};
    invalidEnv.AIGENT_PRESSURE_THRESHOLD_PCT = raw;
    const invalidProbe = makeThresholdWiringProbe(
      `run3-v2-threshold-invalid-${index}`,
      invalidEnv,
    );
    try {
      assert.deepEqual(invalidProbe.observed(), {
        stderrBytes: 0,
        mode: 'degraded',
        runnerPresent: false,
        managedSpawnCount: 0,
        transportConstructionCount: 0,
        unmanagedSpawnCount: 1,
        nodePtyLoadCount: 0,
        runnerLockAcquireCount: 0,
        runnerLockReleaseCount: 0,
      });
      // The log sink's own oneLine() trims the composed message, so an empty
      // raw value (index 0, '') collapses the trailing space away — trim the
      // expectation the same way rather than assume raw concatenation.
      const expectedMessage = `DEGRADED:auto-clear-threshold-invalid ${String(raw)}`.trim();
      assert.ok(
        invalidProbe.loggedLine().includes(`tag="pty-runner" message="${expectedMessage}"`),
        `expected the threshold-invalid line in .daemon-errors.log, got: ${invalidProbe.loggedLine()}`,
      );
    } finally {
      invalidProbe.close();
    }
  }
});

test('V3 threshold-unset-default: absent env passes 80 to the production constructor', () => {
  const env = {};
  delete env.AIGENT_PRESSURE_THRESHOLD_PCT;
  const probe = makeThresholdWiringProbe('run3-v3-threshold-default', env);
  try {
    probe.bindTransport();
    assert.equal(probe.constructed.length, 1);
    assert.equal(probe.constructed[0].pressureThresholdPct, 80);
  } finally {
    probe.close();
  }
});

// composer-channel leg 1: the diagnostic channel shares the operator's
// console. The kill-switch-disabled and node-pty-unavailable branches below
// hand stdio off to an unmanaged child (stdio: 'inherit') moments after
// writing their diagnostic line — painting that text at the top of what
// becomes the operator's live composer, matching the threshold-invalid case
// above. Their lines land in the file now; stderr gets zero bytes for those
// two. runner-lock-failed does NOT belong on that list (R26 correction,
// 2026-08-05): it returns mode:'refused' and never calls runUnmanagedFn —
// no composer ever exists on that path, so its stderr.write is legitimate
// and stays, matching the later boot-failure block's reasoning exactly.
function runSessionCaptureNoLog(name, overrides = {}) {
  const fixture = makeFixture(name);
  const stdin = new ScriptedStream();
  const stdout = new ScriptedStream();
  const stderr = new ScriptedStream();
  const processLike = new ScriptedStream();
  const result = runPtySession({
    childArgs: ['--continue', '/open'],
    command: 'claude',
    root: fixture.root,
    cwd: fixture.cwd,
    env: fixture.env,
    fsImpl: fs,
    stdin,
    stdout,
    stderr,
    processLike,
    platform: 'linux',
    homeDir: fixture.homeDir,
    readKillSwitchFn: () => ({ active: false, code: null, detail: null }),
    readBootReceiptFn: () => ({ ok: true, receipt: readJson(fixture.bootPath) }),
    loadNodePtyFn: () => ({ ok: true, module: { spawn: () => new ScriptedPty() } }),
    acquireRunnerLockFn: () => ({ path: 'scripted-lock' }),
    releaseRunnerLockFn: () => {},
    runUnmanagedFn: () => CHILD_EXIT_CODE,
    exitFn: () => {},
    // No `log` override anywhere in this helper — every scenario below must
    // exercise the true production default sink, not a test spy.
    ...overrides,
  });
  const stderrBuffer = Buffer.concat(stderr.writes);
  const stderrBytes = stderrBuffer.length;
  const stderrText = stderrBuffer.toString('utf8');
  const logText = readDaemonErrorLog(fixture.memRoot);
  fs.rmSync(fixture.base, { recursive: true, force: true });
  return {
    result, stderrBytes, stderrText, logText,
  };
}

test('composer-channel leg 1: kill-switch-active diagnostic never reaches stderr', () => {
  const { result, stderrBytes, logText } = runSessionCaptureNoLog('leg1-kill-switch', {
    readKillSwitchFn: () => ({ active: true, code: 'kill-switch-test', detail: 'fixture' }),
  });
  assert.equal(result.mode, 'unmanaged');
  assert.equal(result.code, 'kill-switch-test');
  assert.equal(stderrBytes, 0);
  assert.ok(
    logText.includes('tag="pty-runner" message="UNMANAGED:auto-clear-disabled reason=kill-switch-test"'),
    `expected the kill-switch line in .daemon-errors.log, got: ${logText}`,
  );
});

test('composer-channel leg 1: node-pty-unavailable diagnostic never reaches stderr', () => {
  const { result, stderrBytes, logText } = runSessionCaptureNoLog('leg1-node-pty', {
    loadNodePtyFn: () => ({
      ok: false,
      code: 'node-pty-load-failed',
      detail: 'scripted missing module',
    }),
  });
  assert.equal(result.mode, 'degraded');
  assert.equal(result.code, DEGRADED_NODE_PTY);
  assert.equal(stderrBytes, 0);
  assert.ok(
    logText.includes(
      'tag="pty-runner" message="DEGRADED:auto-clear-node-pty-unavailable '
      + 'checkpoint/recovery available; auto-clear unavailable; launching unmanaged"',
    ),
    `expected the node-pty-unavailable line in .daemon-errors.log, got: ${logText}`,
  );
});

test('composer-channel leg 1 (R26 correction): runner-lock-failed has no composer to protect, so stderr carries the line too', () => {
  // Unlike kill-switch/node-pty above, this branch never calls
  // runUnmanagedFn — it returns mode:'refused' and the process exits without
  // any child ever taking the terminal. No composer, no bleed-through risk,
  // so stderr staying is correct — the file log is additional, not instead.
  const {
    result, stderrBytes, stderrText, logText,
  } = runSessionCaptureNoLog('leg1-lock-failed', {
    acquireRunnerLockFn: () => { throw new Error('scripted lock failure'); },
  });
  assert.equal(result.mode, 'refused');
  assert.equal(result.code, 'runner-lock-failed');
  assert.ok(stderrBytes > 0, 'no unmanaged handoff on this path — stderr should carry the line');
  assert.match(stderrText, /scripted lock failure/);
  assert.ok(
    logText.includes('tag="pty-runner" message="scripted lock failure"'),
    `expected the lock-failure line in .daemon-errors.log, got: ${logText}`,
  );
});

test('composer-channel leg 1: the default diagnostic sink and the disable-automation announcement never touch stderr mid-session', () => {
  // Inventoried beyond the four early-return branches above: _diagnostic
  // (the line-119 default `log` sink, reached from many in-session failure
  // paths) and _writeError (the UNMANAGED announcement _disableAutomation
  // fires) both run on an ALREADY-STARTED runner — after the child PTY's
  // output is already being proxied to the operator's terminal. This is the
  // most direct instance of the composer-paint defect: not a pre-handoff
  // line, but text interleaved with an actively rendering composer.
  const fixture = makeFixture('leg1-live-session-diagnostics');
  const pty = new ScriptedPty();
  const stdin = new ScriptedStream();
  const stdout = new ScriptedStream();
  const stderr = new ScriptedStream();
  const processLike = new ScriptedStream();
  try {
    const runner = new ManagedPtyRunner({
      ptyProcess: pty,
      memRoot: fixture.memRoot,
      sessionId: SESSION_ID,
      transport: { tick: () => {} },
      baselineBootSequence: 10,
      fsImpl: fs,
      env: fixture.env,
      stdin,
      stdout,
      stderr,
      terminal: stdout,
      processLike,
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      now: fixture.clock,
      readBootReceiptFn: () => ({ ok: true, receipt: readJson(fixture.bootPath) }),
      readKillSwitchFn: () => ({ active: false, code: null, detail: null }),
      // No `log` override — this must exercise the true production default.
      scheduleTick: () => null,
      clearTick: () => {},
      scheduleCommit: () => null,
      clearCommit: () => {},
      scheduleWatchdog: () => null,
      clearWatchdog: () => {},
      scheduleEnter: () => null,
      clearEnter: () => {},
      exitFn: () => {},
    });
    runner.start();

    runner._diagnostic('composer-channel probe: scheduled tick failure');
    runner._disableAutomation('composer-channel-probe-cancel', { source: 'test' });

    const stderrBytes = Buffer.concat(stderr.writes).length;
    const logText = readDaemonErrorLog(fixture.memRoot);
    assert.equal(stderrBytes, 0);
    assert.ok(
      logText.includes('composer-channel probe: scheduled tick failure'),
      `expected the _diagnostic line in .daemon-errors.log, got: ${logText}`,
    );
    assert.ok(
      logText.includes('UNMANAGED:auto-clear-disabled reason=composer-channel-probe-cancel'),
      `expected the _writeError line in .daemon-errors.log, got: ${logText}`,
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('V4 pass-through: literal -- suffix follows fixed args for sh and ps1', () => {
  const opaqueArgs = [
    '--model',
    'haiku',
    'two words',
    'opaque;value=$HOME',
    '--',
    'tail',
  ];
  const operatorArgs = ['ignored-before-separator', '--', ...opaqueArgs];
  const powerShellCommand = resolvePowerShellForLauncherVector();
  const powershell = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'launcher', 'aigent.ps1'),
    'utf8',
  );
  const powershellCode = powershell.replace(/^[ \t]*#.*$/gm, '');
  const powershellSourceBound = (
    /\$claudePassthroughArgs\s*=\s*@\(\)/.test(powershellCode)
    && /\$afterSeparator\s*=\s*\$false/.test(powershellCode)
    && /foreach \(\$arg in \$args\)/.test(powershellCode)
    && /if \(\$arg -ceq '--no-deps'\)[\s\S]*?continue[\s\S]*?\} elseif \(\$afterSeparator\)[\s\S]*?\$claudePassthroughArgs \+= \[string\]\$arg[\s\S]*?\} elseif \(\$arg -ceq '--'\)[\s\S]*?\$afterSeparator = \$true/.test(powershellCode)
    && /Invoke-AigentClaude -ClaudeArgs \(@\('\/start'\) \+ \$claudePassthroughArgs\)/.test(powershellCode)
    && /Invoke-AigentClaude -ClaudeArgs \(@\('--continue'\) \+ \$claudePassthroughArgs\)/.test(powershellCode)
  );

  const observed = {
    shellFirstRun: runLauncherCapture({
      frontDoor: 'sh',
      operatorArgs,
      returning: false,
    }),
    shellReturning: runLauncherCapture({
      frontDoor: 'sh',
      operatorArgs,
      returning: true,
    }),
    powershellFirstRun: powerShellCommand === null
      ? null
      : runLauncherCapture({
        frontDoor: 'ps1',
        operatorArgs,
        returning: false,
        powerShellCommand,
      }),
    powershellReturning: powerShellCommand === null
      ? null
      : runLauncherCapture({
        frontDoor: 'ps1',
        operatorArgs,
        returning: true,
        powerShellCommand,
      }),
    powershellSourceBound,
  };
  // The warm shape carries NO verb. /open is retired, and /resume is not its
  // replacement here: resume-verb.mjs:23 fires on source=clear ONLY, and
  // reopening a terminal is a warm start that --continue already restores.
  assert.deepEqual(observed, {
    shellFirstRun: ['--', '/start', ...opaqueArgs],
    shellReturning: ['--', '--continue', ...opaqueArgs],
    powershellFirstRun: powerShellCommand === null
      ? null
      : ['--', '/start', ...opaqueArgs],
    powershellReturning: powerShellCommand === null
      ? null
      : ['--', '--continue', ...opaqueArgs],
    powershellSourceBound: true,
  });
});

test('V4 pass-through: --no-deps after -- is consumed by the launcher, never forwarded', () => {
  const operatorArgs = ['--', '--model', 'haiku', '--no-deps', 'tail'];
  const forwarded = ['--model', 'haiku', 'tail'];
  const powerShellCommand = resolvePowerShellForLauncherVector();
  const observed = {
    shellFirstRun: runLauncherCapture({
      frontDoor: 'sh',
      operatorArgs,
      returning: false,
    }),
    shellReturning: runLauncherCapture({
      frontDoor: 'sh',
      operatorArgs,
      returning: true,
    }),
    powershellFirstRun: powerShellCommand === null
      ? null
      : runLauncherCapture({
        frontDoor: 'ps1',
        operatorArgs,
        returning: false,
        powerShellCommand,
      }),
    powershellReturning: powerShellCommand === null
      ? null
      : runLauncherCapture({
        frontDoor: 'ps1',
        operatorArgs,
        returning: true,
        powerShellCommand,
      }),
  };
  // --no-deps flips the launch unmanaged, so the captured vector is the
  // `claude` shim's own argv: no runner `--` prefix, and no --no-deps even
  // though it sat after the separator. A launcher that forwards it (or one
  // that stays managed and forwards it) turns every comparison red.
  assert.deepEqual(observed, {
    shellFirstRun: ['/start', ...forwarded],
    shellReturning: ['--continue', ...forwarded],
    powershellFirstRun: powerShellCommand === null
      ? null
      : ['/start', ...forwarded],
    powershellReturning: powerShellCommand === null
      ? null
      : ['--continue', ...forwarded],
  });
});

test('V5 no-dash-dash unchanged: decoy args leave both fixed command shapes byte-identical', () => {
  const decoyArgs = ['--model', 'opus', 'two words', 'opaque;value=$HOME'];
  const powerShellCommand = resolvePowerShellForLauncherVector();
  assert.deepEqual(
    {
      shellFirstRun: runLauncherCapture({
        frontDoor: 'sh',
        operatorArgs: decoyArgs,
        returning: false,
      }),
      shellReturning: runLauncherCapture({
        frontDoor: 'sh',
        operatorArgs: decoyArgs,
        returning: true,
      }),
      powershellFirstRun: powerShellCommand === null
        ? null
        : runLauncherCapture({
          frontDoor: 'ps1',
          operatorArgs: decoyArgs,
          returning: false,
          powerShellCommand,
        }),
      powershellReturning: powerShellCommand === null
        ? null
        : runLauncherCapture({
          frontDoor: 'ps1',
          operatorArgs: decoyArgs,
          returning: true,
          powerShellCommand,
        }),
    },
    {
      shellFirstRun: ['--', '/start'],
      shellReturning: ['--', '--continue'],
      powershellFirstRun: powerShellCommand === null
        ? null
        : ['--', '/start'],
      powershellReturning: powerShellCommand === null
        ? null
        : ['--', '--continue'],
    },
  );
});

test('all three existing launchers remain the managed front door with an explicit no-deps bypass', () => {
  const shell = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'launcher', 'aigent.sh'),
    'utf8',
  );
  const powershell = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'launcher', 'aigent.ps1'),
    'utf8',
  );
  const command = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'launcher', 'aigent.cmd'),
    'utf8',
  );

  assert.match(shell, /--no-deps/);
  assert.match(shell, /node "\$AIGENT_HOME\/daemons\/pty-runner\.mjs" -- "\$@"/);
  assert.match(
    shell,
    /launch_claude "\/start" \$\{operator_args\[0\]\+"\$\{operator_args\[@\]\}"\}/,
  );
  // Warm path carries NO verb — /open is retired and /resume fires on
  // source=clear only (resume-verb.mjs:23), which a terminal reopen is not.
  assert.match(
    shell,
    /launch_claude --continue \$\{operator_args\[0\]\+"\$\{operator_args\[@\]\}"\}/,
  );

  assert.match(powershell, /-ccontains '--no-deps'/);
  assert.match(powershell, /daemons\\pty-runner\.mjs/);
  assert.match(powershell, /& \$node\.Source \$runner '--' @ClaudeArgs/);
  assert.match(
    powershell,
    /Invoke-AigentClaude -ClaudeArgs \(@\('\/start'\) \+ \$claudePassthroughArgs\)/,
  );
  assert.match(
    powershell,
    /Invoke-AigentClaude -ClaudeArgs \(@\('--continue'\) \+ \$claudePassthroughArgs\)/,
  );

  assert.match(command, /aigent\.ps1" %\*/i);
  assert.match(command, /exit \/b %ERRORLEVEL%/i);
});

test('optional dependency manifest and lock pin node-pty exactly at 1.1.0', () => {
  const packageDirectory = path.join(
    REPOSITORY_ROOT,
    'daemons',
    'transport-deps',
  );
  const manifest = readJson(path.join(packageDirectory, 'package.json'));
  const lock = readJson(path.join(packageDirectory, 'package-lock.json'));
  assert.equal(manifest.dependencies['node-pty'], '1.1.0');
  assert.equal(lock.packages[''].dependencies['node-pty'], '1.1.0');
  assert.equal(lock.packages['node_modules/node-pty'].version, '1.1.0');
  // The transport root must stay minimal: node-pty is its ONLY dependency.
  // A second dependency here recreates the shared-failure-domain coupling the
  // placement review removed (closure package §6).
  assert.deepEqual(Object.keys(manifest.dependencies), ['node-pty']);
});

test('semantic-search no longer carries node-pty — transport owns its own dependency root', () => {
  // Placement review verdict MOVE (closure package §6): the transport consumed
  // exactly one package from semantic-search while that package's other
  // script-bearing deps are what breaks under npm ci --ignore-scripts.
  // Re-adding node-pty here silently re-couples transport availability to an
  // unrelated subsystem's install health.
  const packageDirectory = path.join(
    REPOSITORY_ROOT,
    'daemons',
    'semantic-search',
  );
  const manifest = readJson(path.join(packageDirectory, 'package.json'));
  const lock = readJson(path.join(packageDirectory, 'package-lock.json'));
  assert.equal(manifest.dependencies['node-pty'], undefined);
  assert.equal(lock.packages['']?.dependencies?.['node-pty'], undefined);
  assert.equal(lock.packages['node_modules/node-pty'], undefined);
});

test('runner anchor pins node-pty resolution to transport-deps — source-bound', () => {
  // Every behavioral test injects loadNodePtyFn, so no committed vector
  // exercises the REAL createRequire anchor (R26 finding on d88cc19): a
  // regression repointing it — e.g. back to semantic-search, where a stale
  // local node_modules can mask the break — would ship green. This vector
  // pins the anchor in source.
  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'daemons', 'pty-runner.mjs'),
    'utf8',
  );
  // Comments stripped so a description of the rule cannot satisfy the rule;
  // the stripping blinds this vector to comment-class defects — named
  // residue, accepted.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(
    code,
    /createRequire\(\s*new URL\('\.\/transport-deps\/package\.json', import\.meta\.url\)/,
  );
  assert.doesNotMatch(code, /createRequire\([^)]*semantic-search/);
});

test('loadNodePty default path resolves the real transport-deps install when present', (t) => {
  const installed = fs.existsSync(
    path.join(REPOSITORY_ROOT, 'daemons', 'transport-deps', 'node_modules', 'node-pty'),
  );
  if (!installed) {
    // Hermetic vantage: the real-resolution vector did NOT run here. Loud
    // skip so a hermetic green is never read as anchor coverage.
    t.skip('transport-deps/node_modules absent — real anchor resolution not exercised at this vantage');
    return;
  }
  const result = loadNodePty();
  assert.equal(result.ok, true);
  assert.equal(typeof result.module.spawn, 'function');
});

test('ConPTY helper noise follows kill-then-linger, not handler disposal (93b9d2a review F1)', () => {
  // Measured on real node-pty (independent review of 93b9d2a, four invocation
  // shapes): the helper crashes whenever the parent lingers after kill(),
  // handler disposal does NOT prevent it, and a promptly-exiting parent is
  // clean even with handlers attached. The fake must encode that mechanism.

  // Direction 1: lingering parent crashes even with every handler disposed.
  const linger = new ScriptedPty({ teardownShape: 'kill-then-linger' });
  const subscription = linger.onData(() => {});
  subscription.dispose();
  assert.equal(linger.dataHandlers.size, 0);
  linger.kill();
  linger.flushHelper();
  assert.equal(linger.helperNoise.length, 1);

  // Direction 2: prompt parent exit is clean even with handlers attached.
  const prompt = new ScriptedPty({ teardownShape: 'kill-then-linger' });
  prompt.onData(() => {});
  prompt.kill();
  prompt.parentExited = true;
  prompt.flushHelper();
  assert.equal(prompt.helperNoise.length, 0);
});

test('launcher degraded line names node itself when node is missing (93b9d2a review F2)', () => {
  // Resolve bash to an ABSOLUTE path: the child env below carries a stub-only
  // PATH, and on Windows spawnSync resolves the command against the CHILD env,
  // so a bare 'bash' would fail to launch (measured: status null, a false red).
  const bashProbe = spawnSync(
    'bash',
    ['-c', 'cygpath -w "$(command -v bash)" 2>/dev/null || command -v bash'],
    { encoding: 'utf8' },
  );
  const bashPath = (bashProbe.stdout || '').trim();
  if (bashProbe.status !== 0 || !bashPath) {
    // Named residue: no bash on this host, the sh branch cannot be exercised.
    assert.fail('bash unavailable — the F2 launcher branch has no vantage on this host');
  }

  const launcherSource = fs
    .readFileSync(fileURLToPath(new URL('../../launcher/aigent.sh', import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n'); // working tree may be CRLF on Windows; the index form is LF

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aigent-f2-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aigent-f2-bin-'));
  try {
    fs.mkdirSync(path.join(home, '.aigent'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aigent', 'first-run-done'), '');
    const launcherCopy = path.join(home, 'aigent.sh');
    fs.writeFileSync(launcherCopy, launcherSource);
    const stub = path.join(bin, 'claude');
    fs.writeFileSync(stub, '#!/bin/sh\necho CLAUDE_STUB_RAN\n');
    fs.chmodSync(stub, 0o755);

    // Precondition, proven not assumed: with the stub-only PATH the script
    // world genuinely has no node. Refuses loudly instead of false-passing.
    const nodeProbe = spawnSync(bashPath, ['-c', 'command -v node || echo __NO_NODE__'], {
      encoding: 'utf8',
      env: { PATH: bin },
    });
    assert.match(nodeProbe.stdout, /__NO_NODE__/);

    const run = spawnSync(bashPath, [launcherCopy], {
      encoding: 'utf8',
      env: { PATH: bin, AIGENT_HOME: home, HOME: home },
    });

    // PATH carries only the claude stub, so `command -v node` fails inside
    // the launcher by construction — this drives the node-missing branch.
    assert.equal(run.status, 0);
    assert.match(run.stdout, /CLAUDE_STUB_RAN/);
    assert.match(run.stderr, /DEGRADED:auto-clear-node-unavailable /);
    assert.doesNotMatch(run.stderr, /DEGRADED:auto-clear-node-pty-unavailable/);

    // The ps1 branch is not executed here (no PowerShell vantage in this
    // suite) — its token is bound by text to the sh branch. Named residue.
    const ps1 = fs
      .readFileSync(fileURLToPath(new URL('../../launcher/aigent.ps1', import.meta.url)), 'utf8');
    assert.match(ps1, /DEGRADED:auto-clear-node-unavailable /);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('an ambiguous clear-text write failure keeps the hold and never retries (leg-3 ponytail)', () => {
  // The commit-site catch (runner-control-write-ambiguous) implements the
  // at-most-once rule at the write itself: _writeControl marks the attempt
  // BEFORE pty.write, so once the throw lands the write may or may not have
  // reached the child — ambiguity is terminal, hold until receipt or watchdog,
  // never resubmit. Neutering the `submitted` disjunction in that catch sends
  // this same failure down the retry-allowed abort path and every phase/hold
  // assertion below goes red.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    assert.equal(harness.runner.phase, 'prepared');

    // The required kill-line lands first; fail the following clear-text write
    // so this remains the ambiguous post-attempt specimen rather than the new
    // pre-spend, fail-closed kill-line specimen below.
    harness.pty.failNextWriteChunk = Buffer.from(CLEAR_CONTROL_TEXT);
    harness.flushControl(); // commitClearSubmission runs here

    const observed = harness.snapshot();
    assert.equal(harness.runner.phase, 'submitted');
    assert.equal(observed.holdActive, true);
    assert.equal(observed.lastDecision?.code, 'runner-control-write-ambiguous');
    assert.equal(
      observed.events.some((entry) => entry.startsWith('submission-ambiguous')),
      true,
    );
    // The kill-line physically landed before the ambiguous clear-text throw,
    // and exactly one clear transaction was attempted.
    assert.deepEqual(
      observed.automaticWrites,
      [Buffer.from(COMPOSER_KILL_LINE)],
    );
    assert.equal(harness.runner.controlWriteAttempts, 1);

    // Never retry: further ticks may not attempt a second write.
    harness.drive();
    harness.drive();
    assert.equal(harness.runner.phase, 'submitted');
    assert.equal(harness.runner.controlWriteAttempts, 1);
    assert.deepEqual(
      harness.snapshot().automaticWrites,
      [Buffer.from(COMPOSER_KILL_LINE)],
    );

    // The watchdog is the release path (TTL = fuse): hold clears, still no write.
    harness.fireWatchdog();
    const released = harness.snapshot();
    assert.equal(released.holdActive, false);
    assert.equal(harness.runner.controlWriteAttempts, 1);
    assert.deepEqual(
      released.automaticWrites,
      [Buffer.from(COMPOSER_KILL_LINE)],
    );
  } finally {
    harness.cleanup();
  }
});

test('busy child output never blocks the clear — it queues like the capsule', () => {
  // Population attempt 1 (2026-08-14, boot 66): ack observed, intent persisted,
  // then commit sampled output once, saw it unsettled (statusline teardown was
  // still repainting), aborted runner-child-output-became-busy and never
  // retried — the cycle wedged clear-submitted/submitted:false. The principal's
  // Accepted contract: after the acknowledgement, busy output cannot veto
  // the clear; it queues through the same native path as the capsule request.
  // Restore either settled gate
  // (prepare's runner-child-output-not-settled refusal or commit's became-busy
  // abort) and the corresponding assertion below goes red.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();

    // Child actively streaming at prepare time: settlement revoked.
    harness.runner.output.note('post-ack statusline repaint');
    harness.attemptAutomaticClear();
    assert.equal(harness.runner.phase, 'prepared', 'busy output must not refuse prepare');

    // Still streaming at the commit instant — the exact attempt-1 wedge.
    harness.runner.output.note('still repainting at commit');
    harness.flushControl(); // commitClearSubmission runs here

    const observed = harness.snapshot();
    assert.equal(harness.runner.phase, 'submitted', 'busy output must not abort the commit');
    assert.equal(
      observed.events.some((entry) => entry.startsWith('submission-committed')),
      true,
      'the clear was written; the native queued-prompt path absorbs the busy turn',
    );
    assert.equal(
      observed.events.some((entry) => entry.startsWith('submission-aborted')),
      false,
      'no abort leg fired',
    );
    assert.equal(harness.runner.controlWriteAttempts, 1);
  } finally {
    harness.cleanup();
  }
});

test('teardown restores the operator terminal to its pre-start raw state (leg-3 ponytail)', () => {
  // start() records stdin.isRaw before forcing raw mode; _disposeHandlers hands
  // the recorded value back on the way out. Neuter the stdinWasRaw write-back
  // in _disposeHandlers and the post-shutdown assertion goes red: the
  // operator's terminal would stay raw after the runner exits.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
    stdinTty: true,
  });
  try {
    assert.equal(harness.stdin.isRaw, true); // raw mode forced at start()
    harness.shutdown();
    assert.equal(harness.stdin.isRaw, false); // pre-start state restored
  } finally {
    harness.cleanup();
  }
});

test('the post-submit watchdog is sized to the clear round-trip, not the settle window', () => {
  // Measured live 2026-08-05T04:03:15Z (scratch-seat driver, task bbx2lktv4):
  // submit -> clear receipt took 2m16s — the child finishes its in-flight
  // turn, then the fresh context boots hooks before the SessionStart receipt
  // lands. One watchdog armed at prepare (DEFAULT_INPUT_HOLD_TTL_MS = 15s)
  // governed BOTH the settle window and the round-trip, so every real clear
  // died mid-flight: UNMANAGED:auto-clear-disabled
  // reason=runner-input-hold-watchdog-expired at submit+15s, with the
  // completing receipt on disk two minutes later and nobody ticking.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    assert.equal(harness.runner.phase, 'prepared');
    const preIds = [...harness.scheduler.watchdogs.keys()];
    assert.equal(preIds.length, 1, 'exactly one governing watchdog while prepared');
    assert.equal(
      harness.scheduler.watchdogArms.get(preIds[0]),
      DEFAULT_INPUT_HOLD_TTL_MS,
      'pre-submit: the settle-window fuse stays short — abort fast, release the composer',
    );

    harness.flushControl();
    assert.equal(harness.runner.phase, 'submitted');
    harness.fireEnter();
    const postIds = [...harness.scheduler.watchdogs.keys()];
    assert.equal(postIds.length, 1, 'exactly one governing watchdog after submit');
    const governingTtl = harness.scheduler.watchdogArms.get(postIds[0]);
    assert.ok(
      governingTtl > 136_000,
      `post-submit: the governing fuse must exceed the measured 136s clear round-trip; a settle-window timer here kills automation while the clear is landing (governing ttl: ${governingTtl}ms)`,
    );

    // The receipt lands minutes later and must still complete the cycle.
    writeJson(harness.fixture.bootPath, {
      boot_sequence: 11,
      session_id: NEXT_SESSION_ID,
      source: 'clear',
      observed_at: new Date(harness.fixture.clock.ms() + 1000).toISOString(),
    });
    harness.childOutput('fresh-context-output\r\n');
    for (let turn = 0; turn < 3; turn += 1) harness.drive();
    harness.fireEnter();
    const observed = harness.snapshot();
    assert.equal(observed.holdActive, false, 'the receipt releases the input hold');
    assert.equal(harness.runner.automationEnabled, true, 'automation survives a slow clear');
    assert.equal(harness.runner.sessionId, NEXT_SESSION_ID, 'rebound to the fresh session');
    assert.equal(harness.runner.watchdogArmed, false, 'the round-trip fuse is disarmed at release');

    // FUSE PRESERVED (control): if the receipt never lands, the governing
    // watchdog still disables automation and releases the operator's input —
    // the fuse semantics are unchanged, only its size.
    const second = new RunnerHarness({
      mode: 'managed',
      ptyLoad: 'ok',
      lockState: 'free',
    });
    try {
      second.primeAuthorized();
      second.attemptAutomaticClear();
      second.flushControl();
      assert.equal(second.runner.phase, 'submitted');
      second.fireWatchdog();
      assert.equal(second.runner.automationEnabled, false, 'expiry stays terminal');
      assert.equal(second.snapshot().holdActive, false, 'expiry still releases the operator input hold');
    } finally {
      second.cleanup();
    }
  } finally {
    harness.cleanup();
  }
});

test('L1 stale composer bytes are separated from clear by an unconditional kill-line', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    const staleComposerBytes = Buffer.from('stale-operator-draft');
    harness.primeAuthorized();
    harness.operator(staleComposerBytes);
    harness.attemptAutomaticClear();
    harness.flushControl();
    harness.fireEnter();

    assert.deepEqual(
      harness.pty.writes,
      [
        staleComposerBytes,
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
      ],
      'operator bytes remain their own chunk and the clear lands only after kill-line',
    );
    assert.deepEqual(
      harness.snapshot().automaticWrites,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
      ],
      'the automatic channel is the exact three-chunk kill-line/clear/Enter transaction',
    );
  } finally {
    harness.cleanup();
  }
});

test('L1 kill-line write failure is named and fails closed before clear or ack spend', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.pty.failNextWriteChunk = Buffer.from(COMPOSER_KILL_LINE);
    harness.flushControl();

    const observed = harness.snapshot();
    assert.deepEqual(observed.childWrites, [], 'a failed kill-line writes no clear bytes');
    assert.deepEqual(observed.automaticWrites, []);
    assert.equal(harness.scheduler.enters.size, 0, 'no clear Enter is scheduled');
    assert.equal(harness.ackHeld(), true, 'the unused ack remains unspent');
    assert.equal(observed.clearIntent?.submitted, false, 'the clear intent remains unsubmitted');
    assert.equal(
      harness.runner.events.some((event) => event.name === 'capsule-ack-spent'),
      false,
      'the kill-line failure occurs before the ack-spend event',
    );
    assert.equal(observed.lastDecision?.code, 'runner-composer-kill-line-failed');
    assert.equal(harness.runner.automationEnabled, false, 'failure is terminal');
    assert.equal(observed.holdActive, false, 'fail-closed abort releases the pre-submit hold');
    for (let turn = 0; turn < 5; turn += 1) harness.drive();
    assert.equal(harness.runner.controlWriteAttempts, 1, 'terminal failure never retries');
    assert.deepEqual(harness.pty.writes, []);
  } finally {
    harness.cleanup();
  }
});

test('L3 child-visible clear order is kill-line, text, then exactly one delayed Enter', () => {
  // Screen forensics 2026-08-05 04:23Z (scratch-seat driver, task b361q5dwj):
  // '/clear\r' written as ONE chunk left '/clear' sitting in the composer
  // with the CR consumed — no submit, no SessionStart receipt, the round-trip
  // fuse expired loudly at +300s. The 04:00Z run raced the same write and
  // happened to land (receipt 2m16s later), which is exactly what a
  // timing-dependent defect looks like. The driver's own typed turn writes
  // text, waits 400ms, then writes \r — and has never failed. Same class as
  // the boarded gate-harness bracketed-paste finding.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    assert.equal(harness.runner.phase, 'submitted');

    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
      ],
      'the kill-line and text must be separate child-visible chunks, with no CR yet',
    );
    const enterIds = [...harness.scheduler.enters.keys()];
    assert.equal(enterIds.length, 1, 'exactly one deferred Enter is scheduled');
    const delay = harness.scheduler.enterArms.get(enterIds[0]);
    assert.equal(delay, 400, 'the default control Enter window is exactly 400ms');
    assert.ok(
      delay >= 250,
      `a real delay must separate text from Enter so the terminal treats the CR as a keypress, not paste payload (delay: ${delay}ms)`,
    );

    harness.fireEnter();
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
      ],
      'the Enter arrives as its own child-visible write after kill-line and text',
    );
    assert.equal(harness.fireEnter(), false, 'no second clear Enter remains scheduled');
  } finally {
    harness.cleanup();
  }
});

test('composer residue: queued input never flushes onto a stranded control text', () => {
  // R26 finding F1 on the two-phase write: if the deferred Enter write FAILS,
  // '/clear' is already sitting in the composer. When the round-trip fuse
  // later expires, _disableAutomation releases the hold and flushes queued
  // operator input into that composer — and the operator's own trailing CR
  // submits '/clear<operator text>'. Impossible when the write was atomic;
  // introduced by the split. The guard lives INSIDE _flushQueuedInput (a fix
  // in the caller doesn't protect direct calls): while the composer may hold
  // stranded control text, the flush must lead with a kill-line (Ctrl-U) so
  // the stranded text is destroyed before any queued byte lands.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    assert.equal(harness.runner.phase, 'submitted');
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
      ],
      'kill-line and text phases landed',
    );

    harness.pty.failWritesRemaining = 1; // the deferred Enter write throws
    harness.fireEnter();
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
      ],
      'the failed Enter recorded no bytes — /clear is stranded in the composer',
    );

    harness.operator('op-cmd\r'); // operator types during the hold: queued
    assert.ok(harness.snapshot().queuedInputBytes > 0, 'operator input is queued behind the hold');

    harness.fireWatchdog(); // fuse expires -> disable -> release -> flush

    const writes = harness.pty.writes.map((chunk) => chunk.toString('latin1'));
    const opIndex = writes.indexOf('op-cmd\r');
    assert.ok(opIndex >= 0, 'queued operator input is delivered after release');
    assert.equal(
      writes[opIndex - 1],
      COMPOSER_KILL_LINE,
      `the flush must lead with kill-line so queued bytes cannot concatenate onto the stranded '/clear' (writes: ${JSON.stringify(writes)})`,
    );
  } finally {
    harness.cleanup();
  }
});

test('the ack is not re-litigated at commit: no checkpoint recheck runs', () => {
  // This started as "the commit-time recheck must carry the observed ack",
  // which was the weaker guarantee: the recheck still ran, it was merely told
  // to relax its tail arithmetic. It could still refuse on capsule selection,
  // on the stop-writer record or on the transcript, and each of those takes
  // back an authorization the seat had already earned by saying the words.
  //
  // The recheck is gone. Once the exact ACK is observed and spent, the clear
  // is owed, and the only things allowed to stop it are the kill switch, the
  // session binding, the one-clear spend, a persistence failure, and a
  // physical write failure. A checkpoint observation is none of those.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.grantAck(); // the seat printed the literal this cycle
    harness.attemptAutomaticClear();
    harness.flushControl();
    assert.equal(harness.runner.phase, 'submitted', 'the ack must produce a committed clear');
    assert.deepEqual(
      harness.checkpointCalls,
      [],
      'nothing may re-read the checkpoint after the ack; that read could only revoke a clear the ack already authorized',
    );
  } finally {
    harness.cleanup();
  }
});

// PATCH-001S-r3: the capsule request fires AT request-checkpoint /
// checkpoint-requested — deliberately while the seat's turn may still be open
// (by design: Claude Code holds the
// prompt in its native queued-prompt path until the turn ends). This scripted
// transport holds one cycle in checkpoint-requested and NEVER reaches
// checkpoint-confirmed — the busy turn never ends. RED-FIRST VECTOR: moving
// the request back to the checkpoint-confirmed boundary turns this test red
// (this transport never gets there, so nothing would ever be written).
class StillCapsuleTransport {
  constructor(sessionId, cycleId) {
    this.sessionId = sessionId;
    this.cycleId = cycleId;
    this.calls = 0;
  }

  get state() {
    return {
      state: 'checkpoint-requested',
      cycle_id: this.cycleId,
      session_id: this.sessionId,
      hold: null,
    };
  }

  tick() {
    this.calls += 1;
    const state = this.state;
    return {
      state,
      transitioned: this.calls === 1,
      status: 'checkpoint-requested',
      action: this.calls === 1 ? 'request-checkpoint' : null,
    };
  }
}

function capsuleTextWriteCount(harness) {
  return harness.pty.writes.filter((w) => w.equals(Buffer.from(CAPSULE_REQUEST_TEXT))).length;
}

function capsuleEventCount(harness, name) {
  return harness.runner.events.filter((event) => event.name === name).length;
}

test('T3 busy-queue: request-checkpoint while the turn is active writes one text chunk + one separate Enter', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transport = new StillCapsuleTransport(SESSION_ID, 'still-cycle-1');

    // The first tick carries the action:'request-checkpoint' edge while the
    // turn is still active (this transport never confirms). Exactly one text
    // chunk goes out and exactly one separate Enter is scheduled.
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1,
      'the busy turn buys exactly one capsule text write — MUST go red if the request moves back to checkpoint-confirmed');
    assert.equal(capsuleEventCount(harness, 'capsule-request-write'), 1);
    assert.equal(capsuleEventCount(harness, 'capsule-request-enter-write'), 0,
      'the Enter is scheduled, not yet written — a separate delayed write');

    // 80 further ticks in the same held cycle: no second request, no retry.
    for (let i = 0; i < 80; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1,
      'repeated ticks do not send a second request');
    assert.equal(
      harness.runner.events.filter((event) => (
        event.name === 'capsule-request-retry'
        || event.name === 'capsule-request-exhausted'
      )).length,
      0,
      'retry and exhaustion events are outside the one-request-per-cycle contract',
    );

    // The one scheduled Enter lands as its own physical write; never a second.
    assert.equal(harness.fireEnter(), true, 'exactly one scheduled Enter exists');
    assert.equal(capsuleEventCount(harness, 'capsule-request-enter-write'), 1);
    assert.equal(harness.fireEnter(), false, 'no second Enter is ever scheduled');

    // No ack ever appears in this held cycle: no clear may be authorized.
    assert.deepEqual(harness.snapshot().automaticWrites, [],
      'no acknowledgement means no clear');
  } finally {
    harness.cleanup();
  }
});

// PATCH-001S-r3: the request fires exactly once, at the first tick where the
// cycle stands at request-checkpoint / checkpoint-requested — while the turn
// may still be open — in the proven two-phase shape; checkpoint-confirmed
// adds NOTHING (the ack gate there only refuses). BYTE-SHAPE VECTOR:
// recombining text + Enter into one chunk turns this red (the text write is
// asserted CR-free and the Enter is asserted as its own separate write).
test('T3b the capsule request fires once at checkpoint-requested, two-phase; confirmed writes nothing', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    // Walk the REAL transport: pressure first — nothing may fire there.
    assert.equal(harness.core.tick().state.state, 'pressure');
    assert.equal(capsuleTextWriteCount(harness), 0, 'nothing fires at pressure');
    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-requested');
    assert.equal(capsuleTextWriteCount(harness), 1,
      'the request fires AT checkpoint-requested — MUST go red if it waits for checkpoint-confirmed');

    // Reaching checkpoint-confirmed with settled output buys NO second write:
    // _prepareSubmission's gate only refuses (no ack -> no clear), never writes.
    assert.equal(harness.core.tick().state.state, 'checkpoint-confirmed');
    harness.runner.output.observe();
    harness.runner.output.observe(); // settled = two same-generation looks
    harness.drive();

    assert.equal(capsuleTextWriteCount(harness), 1,
      'checkpoint-confirmed adds no write — exactly one text write per cycle');
    assert.equal(capsuleEventCount(harness, 'capsule-request-write'), 1);
    const textWrite = harness.pty.writes.find((w) => w.equals(Buffer.from(CAPSULE_REQUEST_TEXT)));
    assert.ok(textWrite, 'the text write exists');
    assert.ok(!textWrite.includes(0x0d),
      'the text write carries NO carriage return — MUST go red if text and Enter are recombined');
    assert.equal(capsuleEventCount(harness, 'capsule-request-enter-write'), 0,
      'the Enter has not fired yet — it is a separately scheduled write');

    // The delayed Enter is its own physical write.
    assert.equal(harness.fireEnter(), true, 'one scheduled Enter exists');
    assert.equal(capsuleEventCount(harness, 'capsule-request-enter-write'), 1);
    const lastWrite = harness.pty.writes[harness.pty.writes.length - 1];
    assert.ok(lastWrite.equals(Buffer.from(CONTROL_ENTER)), 'the Enter is the separate trailing write');

    // Repeated ticks in the same cycle: no second text, no second Enter.
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'idle ticks cannot buy a second request');
    assert.equal(capsuleEventCount(harness, 'capsule-request-enter-write'), 1);
    assert.equal(harness.fireEnter(), false, 'no second Enter is ever scheduled for the cycle');

    // And the ack gate still holds: no ack, no clear bytes.
    assert.deepEqual(harness.snapshot().automaticWrites, [],
      'the fired request authorizes nothing — no ack means no clear');
    assert.equal(harness.snapshot().lastDecision?.code, 'runner-capsule-not-acked');
  } finally {
    harness.cleanup();
  }
});

// PATCH-001S-r3: LIVE operator input during the two-phase window, at the REAL
// busy-turn boundary — the request now goes out at checkpoint-requested, where
// inputHold is genuinely FALSE (no hand-set state, because forcing it true
// removes the exact condition this test exists to falsify — r1's T3c did that
// and could not see live bytes bypass the queue). Written through, the bytes
// concatenate onto '/context-capsule' and their CR submits the blend.
test('T3c live operator input queues behind the pending capsule Enter and releases after it', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    // Walk the REAL transport to the busy-turn boundary, exactly as T3b does.
    assert.equal(harness.core.tick().state.state, 'pressure');
    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-requested');
    assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the request text is out');
    assert.equal(harness.runner.inputHold, false,
      'no hold exists at this boundary — the queueing must not depend on one');

    const live = Buffer.from('operator note\r');
    harness.operator(live);
    assert.ok(
      !harness.pty.writes.some((w) => w.equals(live)),
      'live operator bytes queue, never write, while the capsule Enter is pending',
    );
    harness.drive();
    assert.ok(
      !harness.pty.writes.some((w) => w.equals(live)),
      'a tick cannot release them while the Enter is still pending',
    );

    assert.equal(harness.fireEnter(), true, 'the capsule Enter lands');
    harness.drive();
    assert.ok(
      harness.pty.writes.some((w) => w.equals(live)),
      'queued input releases after the Enter has physically landed',
    );
    const enterIndex = harness.pty.writes.findIndex((w) => w.equals(Buffer.from(CONTROL_ENTER)));
    const liveIndex = harness.pty.writes.findIndex((w) => w.equals(live));
    assert.ok(enterIndex !== -1 && liveIndex > enterIndex,
      'physical order is capsule text, capsule Enter, then operator input');
    assert.equal(
      harness.pty.writes.filter((w) => w.equals(Buffer.from(COMPOSER_KILL_LINE))).length, 0,
      'the clean path releases without a kill-line — the Enter landed, nothing is stranded',
    );
  } finally {
    harness.cleanup();
  }
});

// PATCH-001S-r2: a scheduler that returns no handle scheduled nothing — the
// same failure as a throw, minus the honesty. The command must fail closed
// under the named code, and operator bytes must never concatenate onto the
// stranded text.
test('T3d a null scheduleEnter result is the named schedule failure and stays fail-closed', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.scheduleEnter = () => null; // "succeeds" with no handle

    // r3: the request (and so the schedule failure) fires at the busy-turn
    // checkpoint-requested boundary; the confirmed walk that follows proves
    // the ack gate refuses without ever writing a second request.
    assert.equal(harness.core.tick().state.state, 'pressure');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'the text write happened at requested');
    assert.equal(harness.core.tick().state.state, 'checkpoint-confirmed');
    harness.runner.output.observe();
    harness.runner.output.observe();
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'confirmed adds no second write');

    const scheduleFailures = harness.runner.events
      .filter((event) => event.name === 'capsule-request-enter-schedule-failed');
    assert.equal(scheduleFailures.length, 1,
      'a null handle is the named schedule failure — MUST go red if it is treated as success');
    assert.equal(scheduleFailures[0].detail?.code, 'runner-capsule-request-enter-schedule-failed');
    assert.equal(scheduleFailures[0].detail?.detail, 'scheduleEnter returned null');
    // The tick that fires the request ends on the standing not-acked refusal,
    // exactly as the THROWN schedule failure does — the named failure is the
    // durable event, not the tick's final decision.
    assert.equal(harness.snapshot().lastDecision?.code, 'runner-capsule-not-acked');
    assert.equal(harness.fireEnter(), false, 'no Enter is pending');
    assert.equal(harness.runner.enterHandle, null, 'the handle slot stays null, never undefined');
    assert.equal(harness.runner.composerMayHoldControlText, true,
      'stranded-text protection stays armed');
    assert.deepEqual(harness.snapshot().automaticWrites, [], 'no ack means no clear');

    // Live operator bytes against the stranded text: queued, then released
    // only behind a kill-line that destroys the stranded command first.
    const live = Buffer.from('operator note\r');
    harness.operator(live);
    assert.ok(!harness.pty.writes.some((w) => w.equals(live)),
      'operator bytes queue behind stranded control text');
    harness.drive();
    const killIndex = harness.pty.writes.findIndex((w) => w.equals(Buffer.from(COMPOSER_KILL_LINE)));
    const liveIndex = harness.pty.writes.findIndex((w) => w.equals(live));
    assert.ok(killIndex !== -1 && liveIndex > killIndex,
      'the stranded text is destroyed before any operator byte reaches the composer');
    assert.equal(capsuleTextWriteCount(harness), 1,
      'the spent latch never buys a second request');
  } finally {
    harness.cleanup();
  }
});

// Composer guard (measured live 2026-09-24): the pressure request fired while
// the operator had a partially typed prompt sitting in the composer — no hold,
// no pending Enter, so the operator's bytes had already passed straight
// through — and '/context-capsule' + Enter were appended to that text and
// submitted as one mangled prompt. The retired legacy supervisor refused this
// case outright ("ENTRY-BLOCKED: composer already holds OTHER content"). The
// runner's only honest signal is InputOwnershipTracker: bytes seen since the
// last CR mean the composer MAY hold operator text, and anything unknown
// (arrows, ESC, controls) means the runner cannot say. Either way the request
// DEFERS — never a kill-line, never a sleep — and retries on later ticks once
// the composer is known empty. Deferring must not spend the cycle_id latch.
function capsuleDeferredEvents(harness) {
  return harness.runner.events.filter((event) => event.name === 'capsule-request-deferred');
}

test('C1 partial operator text defers the capsule request; the operator bytes are preserved byte-for-byte', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    // No hold, no pending Enter: the partial prompt passes straight through
    // to the child composer, exactly as it did live.
    const partial = Buffer.from('fix the flaky test in');
    harness.operator(partial);
    assert.deepEqual(harness.pty.writes, [partial], 'operator sovereignty: the partial text passes through untouched');

    harness.drive(); // pressure -> checkpoint-requested: the request would fire here
    assert.equal(harness.core.state.state, 'checkpoint-requested');
    assert.equal(capsuleTextWriteCount(harness), 0,
      `the request must NOT be appended to the operator's partial text (writes: ${JSON.stringify(harness.pty.writes.map(String))})`);
    assert.equal(harness.fireEnter(), false, 'no Enter is scheduled for a deferred request');
    assert.deepEqual(harness.pty.writes, [partial],
      'the deferral writes nothing: no request, no kill-line, no CR — the operator text is preserved byte-for-byte');
    assert.equal(capsuleDeferredEvents(harness).length, 1, 'the deferral is a named event');
    assert.equal(capsuleDeferredEvents(harness)[0].detail?.code, 'runner-capsule-request-composer-busy');
    assert.equal(harness.runner.capsuleRequestCycleId, null,
      'deferring must not spend the cycle_id latch');

    // Further ticks in the same cycle with the text still sitting there: still
    // deferred, still nothing written, and the event is a state change — logged
    // once per cycle, not per tick.
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'idle ticks never write over operator text');
    assert.deepEqual(harness.pty.writes, [partial]);
    assert.equal(capsuleDeferredEvents(harness).length, 1, 'one deferral event per cycle, not per tick');
    // The transport has walked on to checkpoint-confirmed meanwhile, where the
    // ack gate refuses each tick. While the request is still deferred that
    // refusal must name the composer wait, not a "not acked" for a request
    // that was never written.
    assert.equal(harness.core.state.state, 'checkpoint-confirmed');
    assert.equal(harness.snapshot().lastDecision?.code, 'runner-capsule-request-composer-busy',
      'a deferred cycle at checkpoint-confirmed refuses as composer-busy, never as not-acked {cycle_id:null}');
    assert.equal(harness.snapshot().lastDecision?.detail?.cycle_id, harness.core.state.cycle_id);
    assert.equal(
      harness.pty.writes.filter((w) => w.equals(Buffer.from(COMPOSER_KILL_LINE))).length, 0,
      'the operator text is never destroyed to make room for the request',
    );
  } finally {
    harness.cleanup();
  }
});

test('C2 the deferred request proceeds on a later tick once the operator submits their own prompt', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    const partial = Buffer.from('fix the flaky test in');
    harness.operator(partial);
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'setup: deferred behind the partial text');

    // The operator finishes and submits their prompt themselves. Sovereignty:
    // it passes through immediately, untouched — no queueing, no hold.
    const rest = Buffer.from(' the runner\r');
    harness.operator(rest);
    assert.deepEqual(harness.pty.writes, [partial, rest], 'the operator submission passes through unchanged');
    assert.equal(capsuleTextWriteCount(harness), 0,
      'the operator submission itself writes no request — the request waits for its own tick');

    // CR is the unambiguous boundary: the composer is known empty and the
    // next tick fires the request in the proven two-phase shape, AFTER the
    // operator's own prompt, never merged with it. That tick is ALSO the one
    // where the real transport walks requested -> confirmed, so the fire goes
    // through the extended checkpoint-confirmed gate, not the requested one.
    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-confirmed',
      'the deferred request fires at checkpoint-confirmed via the deferred-cycle gate');
    assert.equal(capsuleTextWriteCount(harness), 1, 'the request fires on the first tick after the submission');
    assert.equal(capsuleEventCount(harness, 'capsule-request-write'), 1);
    assert.equal(capsuleEventCount(harness, 'capsule-request-resumed'), 1, 'the resume is a named event');
    assert.equal(harness.runner.capsuleRequestCycleId, harness.core.state.cycle_id, 'the latch is spent by the fire, not the deferral');
    const writes = harness.pty.writes.map((w) => w.toString('latin1'));
    assert.deepEqual(writes, [partial.toString(), rest.toString(), CAPSULE_REQUEST_TEXT],
      'physical order: operator text, operator CR, then the request text as its own chunk');
    assert.equal(harness.fireEnter(), true, 'the request Enter is its own separate write');
    assert.equal(capsuleEventCount(harness, 'capsule-request-enter-write'), 1);

    // One request per cycle still holds after a deferral.
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'a deferred-then-fired request never fires twice');
    assert.equal(capsuleDeferredEvents(harness).length, 1);
    assert.equal(harness.fireEnter(), false);
  } finally {
    harness.cleanup();
  }
});

test('C3 an empty composer fires the request immediately, and a submitted prompt counts as empty', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    // A whole prompt, submitted: bytes were seen, but the CR closed them.
    harness.operator(Buffer.from('run the suite\r'));
    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-requested');
    assert.equal(capsuleTextWriteCount(harness), 1, 'a submitted prompt leaves the composer empty — the request fires as before');
    assert.equal(capsuleDeferredEvents(harness).length, 0, 'no deferral on an empty composer');
    assert.equal(harness.fireEnter(), true);
  } finally {
    harness.cleanup();
  }
});

test('C4 uncertain input ownership (an unfinished or editing control) defers; the operator CR plus its transcript record releases it', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    // Arrow-up recalls history into the composer: the runner cannot see what
    // is there now. Fail closed — defer, do not guess.
    const arrowUp = Buffer.from(`${ESC}[A`);
    harness.operator(arrowUp);
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'unknown composer contents defer the request');
    assert.equal(capsuleDeferredEvents(harness).length, 1);
    assert.equal(capsuleDeferredEvents(harness)[0].detail?.detail?.input?.unknown, true,
      'the deferral names the tracker state so the cause is diagnosable from disk');
    assert.deepEqual(harness.pty.writes, [arrowUp], 'nothing is written over the recalled text');

    // The operator presses Enter on the recalled text. Review of 436c1dd:
    // the recalled line may end in a backslash the runner never saw, so this
    // CR alone is not proof of submission -- the request stays deferred and
    // the refusal names the wait.
    harness.operator(Buffer.from('\r'));
    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-confirmed',
      'the transport walks on; the deferred cycle stays owed at checkpoint-confirmed');
    assert.equal(capsuleTextWriteCount(harness), 0, 'a CR on an unknown line is uncertain: still deferred -- MUST be red on 436c1dd');
    assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy');
    assert.equal(harness.runner.lastReason?.detail?.input?.pendingSubmission, true,
      'the composer-busy refusal names the mechanism: waiting on the transcript');

    // The prompt lands in the transcript: that is the proof. The request
    // fires through the deferred-cycle gate on the next tick, once.
    appendOperatorPromptRecord(harness, 'the recalled prompt');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'CR + its transcript record is the boundary: the request fires on the next tick');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
  } finally {
    harness.cleanup();
  }

  // The DEFERRED key must not be what fires for an undeferred cycle. A fresh
  // runner (null deferred latch) first ticking into an already-confirmed cycle
  // — the relaunch shape — must not take the deferred path.
  //
  // UPDATED FOR #90 SHAPE 2. This leg used to assert that such a runner
  // "injects nothing" and "keeps its original not-acked refusal". That WAS the
  // defect: no request was ever written for that cycle in that process, so no
  // ack was ever coming, and the runner refused runner-capsule-not-acked on
  // every tick for the life of the process — automatic refresh dead until
  // relaunch, fail-closed but silent. The desired behaviour is a named,
  // visible recovery: the cycle's ack window is read to the end of the
  // transcript, found to contain no ack, and the capsule is re-requested ONCE.
  // The original claim survives as the discriminator: the write must be
  // attributable to the drained-window recovery, never to the deferred key.
  const fresh = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(fresh.core.tick().state.state, 'pressure');
    assert.equal(fresh.core.tick().state.state, 'checkpoint-requested');
    assert.equal(fresh.core.tick().state.state, 'checkpoint-confirmed');
    fresh.runner.output.observe();
    fresh.runner.output.observe();
    fresh.drive();
    assert.equal(fresh.runner.capsuleRequestDeferredCycleId, null, 'nothing was deferred in this process');
    assert.equal(capsuleDeferredEvents(fresh).length, 0, 'the deferred path is not what fired');
    assert.equal(capsuleTextWriteCount(fresh), 1,
      'a fresh runner ticking into a confirmed cycle with no ack on disk must ASK for the capsule, not park');
    assert.equal(fresh.runner.capsuleRequestCycleId, fresh.core.state.cycle_id,
      'the request is keyed to the confirmed cycle, so it can fire only once for it');
    assert.equal(fresh.runner.capsuleAckWatch?.cycle_id, fresh.core.state.cycle_id,
      'the re-request re-opens the window bound to that same cycle');
    // One request per cycle, still: 50 further ticks write nothing more.
    for (let i = 0; i < 50; i += 1) fresh.drive();
    assert.equal(capsuleTextWriteCount(fresh), 1, 'the cycle_id latch still bounds this to one write');
    assert.equal(fresh.snapshot().lastDecision?.code, 'runner-capsule-not-acked',
      'until the ack lands the clear stays refused by name');
    assert.equal(fresh.snapshot().lastDecision?.detail?.state_cycle_id, fresh.core.state.cycle_id,
      'and the refusal names the cycle it is waiting on, never {cycle_id:null}');
  } finally {
    fresh.cleanup();
  }
});

// PR #59 review 5356605916, P1 -- the reviewer's two failing cases, end to
// end through the runner: a multiline draft must keep the request DEFERRED
// (the operator is still composing), and the operator's next PLAIN Enter
// must release it exactly once. On 08a3c62 the tracker promoted both
// newline events to submissions and the request fired into the draft.
test('C5 a backslash+Enter multiline draft keeps the capsule request deferred; the next plain Enter releases it once', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    // Reviewer's reproduction: 'first line', '\\', '\r' as separate chunks.
    const chunks = ['first line', '\\', '\r'].map((chunk) => Buffer.from(chunk));
    for (const chunk of chunks) harness.operator(chunk);
    assert.deepEqual(harness.pty.writes, chunks,
      'operator sovereignty: every byte, the backslash and its CR included, passes through untouched');

    harness.drive(); // pressure -> checkpoint-requested: the request would fire here
    assert.equal(harness.core.state.state, 'checkpoint-requested');
    assert.equal(capsuleTextWriteCount(harness), 0,
      `backslash+Enter is a newline, not a submission: the request must stay deferred -- MUST be red on 08a3c62 (writes: ${JSON.stringify(harness.pty.writes.map(String))})`);
    assert.equal(harness.fireEnter(), false, 'no Enter is scheduled for a deferred request');
    assert.equal(capsuleDeferredEvents(harness).length, 1);
    assert.equal(capsuleDeferredEvents(harness)[0].detail?.detail?.input?.knownEmpty, false);
    assert.equal(capsuleDeferredEvents(harness)[0].detail?.detail?.input?.lastNewline, true,
      'the deferral names its mechanism: the last composer event was a newline chord, not typed text');
    assert.equal(harness.runner.capsuleRequestCycleId, null, 'deferring must not spend the cycle_id latch');

    // The second line of the draft, more ticks: still deferred, nothing written.
    const second = Buffer.from('second line');
    harness.operator(second);
    for (let i = 0; i < 10; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0);
    assert.deepEqual(harness.pty.writes, [...chunks, second], 'no kill-line, no request, no CR over the draft');

    // The operator submits with a PLAIN Enter: the boundary. The next tick
    // fires the request once, after the operator's own prompt.
    const enter = Buffer.from('\r');
    harness.operator(enter);
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1,
      'the plain Enter after the multiline draft submits, and the request fires on the next tick');
    assert.equal(capsuleEventCount(harness, 'capsule-request-resumed'), 1);
    assert.deepEqual(
      harness.pty.writes.map((w) => w.toString('latin1')),
      [...chunks.map(String), second.toString(), enter.toString(), CAPSULE_REQUEST_TEXT],
      'physical order: the whole draft, its submission, then the request as its own chunk',
    );
    assert.equal(harness.fireEnter(), true, 'the request Enter is its own separate write');
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
    assert.equal(capsuleDeferredEvents(harness).length, 1);
  } finally {
    harness.cleanup();
  }
});

test('C6 a win32-input-mode Shift+Enter multiline draft keeps the capsule request deferred; the plain Enter keydown releases it once', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    // Reviewer's reproduction: 'first line', then ESC[13;28;13;1;16;1_
    // (VK_RETURN keydown, Cs=SHIFT_PRESSED).
    const chunks = ['first line', `${ESC}[13;28;13;1;16;1_`].map((chunk) => Buffer.from(chunk));
    for (const chunk of chunks) harness.operator(chunk);
    assert.deepEqual(harness.pty.writes, chunks, 'the win32 key event passes through byte-for-byte');

    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-requested');
    assert.equal(capsuleTextWriteCount(harness), 0,
      'Shift+Enter is a newline, not a submission: the request must stay deferred -- MUST be red on 08a3c62');
    assert.equal(harness.fireEnter(), false);
    assert.equal(capsuleDeferredEvents(harness).length, 1);
    assert.equal(capsuleDeferredEvents(harness)[0].detail?.detail?.input?.lastNewline, true,
      'the deferral names the Shift+Enter newline as its cause');
    assert.equal(harness.runner.capsuleRequestCycleId, null);

    // The keyup half of that Shift+Enter releases nothing; the plain Enter
    // keydown that follows is the boundary.
    harness.operator(Buffer.from(`${ESC}[13;28;13;0;16;1_`));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'the keyup places nothing and releases nothing');
    harness.operator(Buffer.from(`${ESC}[13;28;13;1;0;1_`));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1,
      'the plain Enter keydown submits; the request fires once on the next tick');
    assert.equal(capsuleEventCount(harness, 'capsule-request-resumed'), 1);
    assert.equal(harness.fireEnter(), true);
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
  } finally {
    harness.cleanup();
  }
});

test('C7 a bracketed paste with embedded newlines defers the capsule request; the operator Enter releases it', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    const paste = Buffer.from(`${ESC}[200~line one\rline two\r${ESC}[201~`);
    harness.operator(paste);
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0,
      'CRs inside a bracketed paste are payload, not submissions (existing behavior, verified)');
    assert.equal(capsuleDeferredEvents(harness).length, 1);
    assert.deepEqual(harness.pty.writes, [paste], 'the paste passes through untouched');
    harness.operator(Buffer.from('\r'));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'the operator Enter after the paste is the boundary');
    assert.equal(harness.fireEnter(), true);
  } finally {
    harness.cleanup();
  }
});

// A genuine operator prompt as Claude Code writes it: a non-meta
// "type":"user" record. String content or a text block -- both shapes occur.
function appendOperatorPromptRecord(harness, text, { shape = 'string', transcriptPath } = {}) {
  const content = shape === 'string'
    ? JSON.stringify(text)
    : `[{"type":"text","text":${JSON.stringify(text)}}]`;
  fs.appendFileSync(
    transcriptPath || harness.fixture.transcriptPath,
    `\n{"type":"user","message":{"role":"user","content":${content}},"uuid":"u-${Date.now()}"}\n`,
  );
}

// Review of 436c1dd (MED): the two specimens end to end. The composed prompt
// ends in a backslash the tracker lost sight of (DEL, or Left+Right), so the
// Enter is a NEWLINE: the request must stay deferred, nothing may be written
// by the runner, and the operator's bytes pass through byte-for-byte. On
// 436c1dd the CR submitted and '/context-capsule' was typed into the draft.
test('C8 specimens: an edited prompt ending in a lost backslash + Enter keeps the request deferred; the transcript record releases it once', () => {
  for (const [label, chunks] of [
    ['specimen 1 raw', SPECIMEN_1_RAW],
    ['specimen 2 raw', SPECIMEN_2_RAW],
    ['specimen 1 win32', SPECIMEN_1_WIN32],
    ['specimen 2 win32', SPECIMEN_2_WIN32],
  ]) {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      assert.equal(harness.core.tick().state.state, 'pressure');
      const buffers = chunks.map((chunk) => Buffer.from(chunk));
      for (const buffer of buffers) harness.operator(buffer);
      assert.deepEqual(harness.pty.writes, buffers, `${label}: operator sovereignty, every byte passes through untouched`);

      harness.drive(); // pressure -> checkpoint-requested: the request would fire here
      assert.equal(harness.core.state.state, 'checkpoint-requested');
      assert.equal(capsuleTextWriteCount(harness), 0,
        `${label}: the edited CR is not proof of submission, the request must stay deferred -- MUST be red on 436c1dd (writes: ${JSON.stringify(harness.pty.writes.map(String))})`);
      assert.equal(capsuleEventCount(harness, 'submission-uncertain'), 1, `${label}: the uncertain CR is logged once`);
      assert.equal(harness.fireEnter(), false, `${label}: no Enter is scheduled for a deferred request`);
      assert.equal(capsuleDeferredEvents(harness).length, 1);
      assert.equal(capsuleDeferredEvents(harness)[0].detail?.code, 'runner-capsule-request-composer-busy');
      const deferred = capsuleDeferredEvents(harness)[0].detail?.detail;
      assert.equal(deferred?.input?.knownEmpty, false);
      assert.equal(deferred?.input?.pendingSubmission, true, `${label}: the deferral names its mechanism`);
      assert.equal(harness.runner.capsuleRequestCycleId, null, `${label}: deferring must not spend the cycle_id latch`);

      // Ticks are not evidence: nothing lands, nothing changes, nothing is
      // written. The composer-busy refusal at checkpoint-confirmed names it.
      for (let i = 0; i < 10; i += 1) harness.drive();
      assert.equal(harness.core.state.state, 'checkpoint-confirmed');
      assert.equal(capsuleTextWriteCount(harness), 0, `${label}: no timer releases it`);
      assert.deepEqual(harness.pty.writes, buffers, `${label}: no kill-line, no request, no CR over the draft`);
      assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy');
      assert.equal(harness.runner.lastReason?.detail?.input?.pendingSubmission, true);

      // LIVENESS: the operator finishes the draft and really sends it -- the
      // prompt record lands in the bound transcript past the noted offset.
      // (The second Enter is uncertain too: the line is still tainted. The
      // record is what resolves it.)
      const win32 = label.includes('win32');
      const second = (win32
        ? ['second line', WIN32_PLAIN_ENTER, WIN32_PLAIN_ENTER_UP]
        : ['second line\r']).map((chunk) => Buffer.from(chunk));
      for (const chunk of second) harness.operator(chunk);
      harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 0, `${label}: a second Enter without a record is still not proof`);
      appendOperatorPromptRecord(harness, 'abc\nsecond line', { shape: win32 ? 'text-block' : 'string' });
      harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 1, `${label}: the record confirms the submission and the request fires once`);
      assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
      assert.equal(capsuleEventCount(harness, 'capsule-request-resumed'), 1);
      assert.equal(harness.runner.input.snapshot().knownEmpty, true, `${label}: the tracker is known-empty after confirmation (the Enter keyup is inert) -- MUST be red on 7b3a728 for win32`);
      assert.equal(harness.runner.input.snapshot().unknown, false, `${label}: no taint survives an inert keyup`);
      assert.deepEqual(
        harness.pty.writes.map((w) => w.toString('latin1')),
        [...buffers.map(String), ...second.map(String), CAPSULE_REQUEST_TEXT],
        `${label}: physical order -- the whole draft, its submission, then the request as its own chunk`,
      );
      assert.equal(harness.fireEnter(), true, `${label}: the request Enter is its own separate write`);
      for (let i = 0; i < 40; i += 1) harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 1, `${label}: exactly once`);
      assert.equal(capsuleDeferredEvents(harness).length, 1);
    } finally {
      harness.cleanup();
    }
  }
});

test('C9 specimens: records that are not operator prompts do not confirm -- tool_result content, isMeta records, and records before the noted offset', () => {
  // A record BEFORE the offset: written before the uncertain CR goes by.
  const early = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(early.core.tick().state.state, 'pressure');
    appendOperatorPromptRecord(early, 'an earlier prompt, already on disk');
    for (const chunk of SPECIMEN_1_RAW) early.operator(Buffer.from(chunk));
    const noted = early.runner.pendingSubmissionWatch;
    assert.equal(noted?.offset, fs.statSync(early.fixture.transcriptPath).size, 'the offset is noted at the CR, after the earlier record');
    for (let i = 0; i < 5; i += 1) early.drive();
    assert.equal(capsuleTextWriteCount(early), 0, 'a record before the noted offset must not confirm');
    assert.equal(early.runner.input.snapshot().pendingSubmission, true);
    assert.equal(capsuleEventCount(early, 'submission-confirmed'), 0);
  } finally {
    early.cleanup();
  }

  // Records AFTER the offset that are not prompts.
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    for (const chunk of SPECIMEN_2_RAW) harness.operator(Buffer.from(chunk));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0);

    // The child answering its own tool call: "type":"user" with a tool_result
    // block, text inside it and all.
    fs.appendFileSync(
      harness.fixture.transcriptPath,
      '\n{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"abc\\\\ looks like a prompt but is not"}]}}\n',
    );
    for (let i = 0; i < 3; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'a tool_result record is not a prompt -- must not confirm');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true);

    // Bookkeeping the child writes as the user: isMeta, carrying text.
    fs.appendFileSync(
      harness.fixture.transcriptPath,
      '\n{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Caveat: local command output"}]}}\n'
      + '{"type":"user","isMeta":true,"message":{"role":"user","content":"a meta string"}}\n',
    );
    for (let i = 0; i < 3; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'an isMeta record is not a prompt -- must not confirm');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true);

    // Not user records at all, and a half-written line. (The assistant text
    // deliberately avoids the capsule ack literal: an ack would legitimately
    // satisfy the cycle through _checkCapsuleAck and this test is about the
    // composer guard, not the ack gate.)
    fs.appendFileSync(
      harness.fixture.transcriptPath,
      '\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"the user said abc"}]}}\n'
      + '{"type":"system","content":"user typed something"}\n'
      + '{"type":"user","message":{"role":"user","content":"half-writ',
    );
    for (let i = 0; i < 3; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'assistant/system records and a half-written user line do not confirm');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true);

    // The half-written line completes: now it is a prompt record, past the
    // offset. Confirmed, released once.
    fs.appendFileSync(harness.fixture.transcriptPath, 'ten"}}\n');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'the completed prompt record confirms');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
    assert.equal(harness.fireEnter(), true);
    for (let i = 0; i < 20; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
  } finally {
    harness.cleanup();
  }
});

test('C10 specimens: a prompt record that lands while the operator keeps typing confirms the CR without declaring the new text gone', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    for (const chunk of SPECIMEN_1_RAW) harness.operator(Buffer.from(chunk));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0);
    // The record lands, and before the next tick the operator has started the
    // next prompt. Confirmation resolves the old line; the new text is live.
    appendOperatorPromptRecord(harness, 'abc\n');
    harness.operator(Buffer.from('next prompt'));
    harness.drive();
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
    assert.equal(capsuleTextWriteCount(harness), 0, 'the composer holds "next prompt": still deferred, no mangling');
    assert.equal(harness.runner.input.snapshot().knownEmpty, false);
    assert.equal(harness.runner.input.snapshot().unknown, false, 'the old taint is spent; the new line was seen byte-for-byte');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, false);
    // A clean line: its plain Enter is the zero-latency boundary as before.
    harness.operator(Buffer.from('\r'));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'the clean Enter releases it without waiting for a record');
    assert.equal(harness.fireEnter(), true);
  } finally {
    harness.cleanup();
  }
});

// Review of 7b3a728 (F2): the runner's OWN prompts land in the transcript as
// non-meta user records too -- the '/context-capsule' invocation
// (<command-name>/context-capsule</command-name>) and the post-clear wake
// message. Operator bytes observed during the request's Enter window can
// leave a pending CR that those records would "confirm", with the queued
// draft about to be flushed into a composer the tracker just called clean.
test('C11 F2: the runner\'s own records (capsule invocation, wake message) never confirm a pending CR; a real operator prompt after them does', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    for (const chunk of SPECIMEN_1_RAW) harness.operator(Buffer.from(chunk));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0);

    // The invocation record, as Claude Code writes a slash command: string
    // content, not isMeta. Also as a text block, and the wake message.
    fs.appendFileSync(
      harness.fixture.transcriptPath,
      `\n{"type":"user","message":{"role":"user","content":"<command-message>context-capsule</command-message>\\n<command-name>${CAPSULE_REQUEST_TEXT}</command-name>"}}\n`
      + `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(CAPSULE_REQUEST_TEXT)}}]}}\n`
      + `{"type":"user","message":{"role":"user","content":${JSON.stringify(WAKE_MESSAGE)}}}\n`,
    );
    for (let i = 0; i < 5; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'the runner\'s own records must not confirm the operator\'s pending CR -- MUST be red on 7b3a728');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0);
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true, 'still waiting on evidence');

    // A real operator prompt after them confirms, and the request fires once.
    appendOperatorPromptRecord(harness, 'a real prompt, sent after the request');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'the operator\'s own record confirms');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
    assert.equal(harness.fireEnter(), true);
    for (let i = 0; i < 20; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
  } finally {
    harness.cleanup();
  }
});

// Review 5480136713 (MED), end to end: an earlier operator prompt A is
// queued into a busy turn (Claude Code records it when it is dequeued, so its
// record is LATE); the operator then types abc\x, Backspace, Enter -- a
// newline inside a still-unsent draft B. On b3335c54 A's late record, read
// past the offset noted at B's CR, confirmed B, declared the composer empty,
// and the capsule request was typed into B's draft. Three variants of one
// correlation defect: A clean (R1), A itself uncertain (R2), win32 (R3).
function seedQueuedAThenEditedB(harness, { win32 = false, aUncertain = false } = {}) {
  assert.equal(harness.core.tick().state.state, 'pressure');
  let a;
  if (aUncertain) {
    // A: xyzq, Backspace, Enter -- really submits "xyz", but the Backspace
    // makes its CR uncertain too.
    a = ['xyzq', win32 ? WIN32_BACKSPACE : '\u007f', ...(win32 ? [WIN32_BACKSPACE_UP] : [])];
  } else {
    a = ['run the suite'];
  }
  a = [...a, ...(win32 ? [WIN32_PLAIN_ENTER, WIN32_PLAIN_ENTER_UP] : ['\r'])].map((chunk) => Buffer.from(chunk));
  for (const chunk of a) harness.operator(chunk);
  if (!aUncertain) {
    assert.equal(harness.runner.input.snapshot().knownEmpty, true, 'A is a clean submission: zero-latency boundary as before');
  }
  const b = (win32 ? SPECIMEN_1_WIN32 : SPECIMEN_1_RAW).map((chunk) => Buffer.from(chunk));
  for (const chunk of b) harness.operator(chunk);
  assert.deepEqual(harness.pty.writes, [...a, ...b], 'operator sovereignty: every byte of A and B passes through untouched');

  // The tick that would fire the request: refused, composer busy, nothing
  // written by the runner.
  harness.drive();
  assert.equal(harness.core.state.state, 'checkpoint-requested');
  assert.equal(capsuleTextWriteCount(harness), 0);
  assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy');
  assert.equal(harness.runner.lastReason?.detail?.input?.pendingSubmission, true);
  assert.equal(harness.fireEnter(), false);
  return { a, b };
}

// The queue-depth assertions come AFTER the write assertion on purpose: on
// b3335c54 (no queue) the first red line must be the mangle itself.
function assertStillDeferredBehindA(harness, label, written) {
  for (let i = 0; i < 5; i += 1) harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0,
    `${label}: A's late record must not confirm B -- MUST be red on b3335c54 (writes: ${JSON.stringify(harness.pty.writes.map(String))})`);
  assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0, `${label}: nothing confirmed`);
  assert.equal(harness.runner.input.snapshot().knownEmpty, false, `${label}: B's draft is not declared empty`);
  assert.equal(harness.runner.input.snapshot().pendingSubmission, true, `${label}: B still waits on its own record`);
  assert.equal(capsuleEventCount(harness, 'submission-receipt'), 1, `${label}: A's record settled A's entry`);
  assert.equal(harness.runner.input.outstanding.length, 1, `${label}: only B is outstanding now (A was owed one record, B queued behind it)`);
  assert.equal(harness.runner.lastReason?.detail?.input?.outstanding, 1, `${label}: the refusal names the depth`);
  assert.equal(capsuleDeferredEvents(harness)[0]?.detail?.detail?.input?.outstanding, 2,
    `${label}: the deferral named B waiting behind an older prompt`);
  assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy');
  assert.deepEqual(harness.pty.writes, written, `${label}: no kill-line, no request, no CR over the draft`);
  assert.equal(harness.fireEnter(), false, `${label}: no Enter scheduled`);
}

test('R1 review 5480136713: A queued clean -> B edited newline -> A\'s record late: B stays deferred, nothing is written into the draft', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const { a, b } = seedQueuedAThenEditedB(harness);
    // Not-a-prompt records never settle an entry (C9/C11 semantics kept).
    fs.appendFileSync(
      harness.fixture.transcriptPath,
      '\n{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"run the suite"}]}}\n'
      + '{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: local command"}}\n'
      + `{"type":"user","message":{"role":"user","content":${JSON.stringify(CAPSULE_REQUEST_TEXT)}}}\n`,
    );
    for (let i = 0; i < 3; i += 1) harness.drive();
    assert.equal(capsuleEventCount(harness, 'submission-receipt'), 0, 'tool_result, isMeta and runner-own records settle nothing');

    // A's ordinary user-text record lands, LATE, past the noted offset.
    appendOperatorPromptRecord(harness, 'run the suite');
    assertStillDeferredBehindA(harness, 'R1', [...a, ...b]);
    assert.equal(capsuleEventCount(harness, 'submission-receipt'), 1,
      'exactly one record settled an entry: the three non-prompt records before it counted for nothing');
  } finally {
    harness.cleanup();
  }
});

test('R2 review 5480136713: A itself uncertain (two uncertain CRs outstanding): A\'s record confirms A only; B stays deferred', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const { a, b } = seedQueuedAThenEditedB(harness, { aUncertain: true });
    assert.equal(capsuleEventCount(harness, 'submission-uncertain'), 2, 'both CRs were logged uncertain');
    appendOperatorPromptRecord(harness, 'xyz');
    assertStillDeferredBehindA(harness, 'R2', [...a, ...b]);

    // Liveness: the operator finishes B's draft and sends it. That Enter is
    // provably a submission (content typed since B, no taint between), so
    // the draft's record confirms it and the request fires exactly once.
    const rest = Buffer.from('second line\r');
    harness.operator(rest);
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'R2: an Enter without a record is still not proof');
    appendOperatorPromptRecord(harness, 'abc\nsecond line');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'R2: the draft\'s record confirms and the request fires once');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
    assert.deepEqual(
      harness.pty.writes.map((w) => w.toString('latin1')),
      [...a.map(String), ...b.map(String), rest.toString(), CAPSULE_REQUEST_TEXT],
      'R2: physical order -- A, B\'s whole draft and its submission, then the request as its own chunk',
    );
    assert.equal(harness.fireEnter(), true);
    for (let i = 0; i < 20; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
  } finally {
    harness.cleanup();
  }
});

test('R3 review 5480136713: win32 keydown/keyup variant of R1', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const { a, b } = seedQueuedAThenEditedB(harness, { win32: true });
    appendOperatorPromptRecord(harness, 'run the suite', { shape: 'text-block' });
    assertStillDeferredBehindA(harness, 'R3', [...a, ...b]);
    assert.equal(harness.runner.input.snapshot().unknown, true, 'R3: the Backspace taint stands until B is really resolved');
  } finally {
    harness.cleanup();
  }
});

test('P1 after R1\'s state B is genuinely sent: the SECOND record past the offset confirms B and releases the request exactly once', () => {
  // (a) B was a real submission after all (abcx, Backspace, Enter sends
  // "abc"): its own record is the second one and confirms it.
  const direct = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(direct.core.tick().state.state, 'pressure');
    const a = Buffer.from('run the suite\r');
    direct.operator(a);
    const b = ['abcx', '\u007f', '\r'].map((chunk) => Buffer.from(chunk));
    for (const chunk of b) direct.operator(chunk);
    direct.drive();
    assert.equal(capsuleTextWriteCount(direct), 0);
    appendOperatorPromptRecord(direct, 'run the suite');
    assertStillDeferredBehindA(direct, 'P1a', [a, ...b]);
    appendOperatorPromptRecord(direct, 'abc');
    direct.drive();
    assert.equal(capsuleTextWriteCount(direct), 1, 'P1a: B\'s own record confirms B; the request fires once');
    assert.equal(capsuleEventCount(direct, 'submission-confirmed'), 1);
    assert.equal(capsuleEventCount(direct, 'capsule-request-resumed'), 1);
    assert.equal(direct.runner.input.snapshot().knownEmpty, true);
    assert.equal(direct.runner.input.snapshot().unknown, false, 'the pre-CR taint is spent');
    assert.equal(direct.runner.input.outstanding.length, 0, 'drained');
    assert.equal(direct.runner.pendingSubmissionWatch, null, 'the watch is dropped with the queue');
    assert.deepEqual(
      direct.pty.writes.map((w) => w.toString('latin1')),
      [a.toString(), ...b.map(String), CAPSULE_REQUEST_TEXT],
      'P1a: physical order -- A, B, then the request as its own chunk',
    );
    assert.equal(direct.fireEnter(), true);
    for (let i = 0; i < 20; i += 1) direct.drive();
    assert.equal(capsuleTextWriteCount(direct), 1, 'exactly once');
    assert.equal(capsuleDeferredEvents(direct).length, 1);
  } finally {
    direct.cleanup();
  }

  // (b) B really was a newline: the operator finishes the draft and sends it
  // with a plain Enter (provably a submission), and the draft's record is
  // the second one.
  const finished = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const { a, b } = seedQueuedAThenEditedB(finished);
    appendOperatorPromptRecord(finished, 'run the suite');
    assertStillDeferredBehindA(finished, 'P1b', [...a, ...b]);
    const rest = Buffer.from('second line\r');
    finished.operator(rest);
    harnessDriveN(finished, 3);
    assert.equal(capsuleTextWriteCount(finished), 0, 'P1b: the plain Enter alone is not proof (the line is tainted)');
    appendOperatorPromptRecord(finished, 'abc\nsecond line');
    finished.drive();
    assert.equal(capsuleTextWriteCount(finished), 1, 'P1b: the draft\'s record confirms; fires once');
    assert.equal(capsuleEventCount(finished, 'submission-confirmed'), 1);
    assert.deepEqual(
      finished.pty.writes.map((w) => w.toString('latin1')),
      [...a.map(String), ...b.map(String), rest.toString(), CAPSULE_REQUEST_TEXT],
    );
    assert.equal(finished.fireEnter(), true);
    for (let i = 0; i < 20; i += 1) finished.drive();
    assert.equal(capsuleTextWriteCount(finished), 1, 'exactly once');
  } finally {
    finished.cleanup();
  }
});

function harnessDriveN(harness, n) {
  for (let i = 0; i < n; i += 1) harness.drive();
}

test('P2/P3 ordinary clean submissions: zero latency, nothing deferred, their records drain the queue in order', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    const first = Buffer.from('one\r');
    const second = Buffer.from('two\r');
    harness.operator(first);
    harness.operator(second);
    assert.equal(harness.runner.input.outstanding.length, 2, 'two prompts owed records');
    assert.notEqual(harness.runner.pendingSubmissionWatch, null, 'the receipt watch is armed by a clean submission too');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'P3: a clean composer fires at once (C1-C3 semantics unchanged)');
    assert.equal(capsuleDeferredEvents(harness).length, 0, 'nothing deferred wrongly');
    assert.equal(capsuleEventCount(harness, 'submission-uncertain'), 0);
    assert.deepEqual(
      harness.pty.writes.map((w) => w.toString('latin1')),
      [first.toString(), second.toString(), CAPSULE_REQUEST_TEXT],
    );
    assert.equal(harness.fireEnter(), true);
    // The two records land in order and settle the two entries; the queue
    // drains, the watch is dropped, the scan stops.
    appendOperatorPromptRecord(harness, 'one');
    harnessDriveN(harness, 2);
    assert.equal(harness.runner.input.outstanding.length, 1);
    assert.equal(capsuleEventCount(harness, 'submission-receipt'), 1);
    appendOperatorPromptRecord(harness, 'two');
    harnessDriveN(harness, 2);
    assert.equal(harness.runner.input.outstanding.length, 0);
    assert.equal(harness.runner.pendingSubmissionWatch, null);
    assert.equal(capsuleEventCount(harness, 'submission-receipt'), 2);
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0, 'nothing was uncertain');
    // A later uncertain CR notes a FRESH offset past both records (C9 early
    // semantics): neither can be read as its evidence.
    for (const chunk of SPECIMEN_1_RAW) harness.operator(Buffer.from(chunk));
    assert.equal(harness.runner.pendingSubmissionWatch?.offset, fs.statSync(harness.fixture.transcriptPath).size);
    assert.equal(harness.runner.input.outstanding.length, 1);
    harnessDriveN(harness, 3);
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0);
    assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
  } finally {
    harness.cleanup();
  }
});

// On the real host a hand-typed /help IS recorded (a <command-name> user
// record, non-isMeta) and settles its slot. The CRs that are genuinely never
// recorded are dialog answers -- a digit or an arrow + Enter on a permission
// or model prompt -- an Enter on a line a control emptied (Ctrl+C / Ctrl+U,
// then Enter), and hidden newlines. The specimen here is the digit answer
// `1` + Enter: a clean, non-empty line the tracker must queue.
test('P4 an expected record that never comes (a dialog answered with 1 + Enter): clean Enters never wait on it; a later Backspace+Enter prompt pays one record of latency, recovered by the next certain prompt', () => {
  // Recovery rule for clean lines: a plain Enter on a clean non-empty line
  // goes straight to _submitted(), queue or no queue -- zero latency.
  const clean = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(clean.core.tick().state.state, 'pressure');
    clean.operator(Buffer.from('1\r'));
    assert.equal(clean.runner.input.outstanding.length, 1, 'the dialog answer is queued like any prompt: the tracker cannot know it writes no record');
    clean.operator(Buffer.from('fix it\r'));
    clean.drive();
    assert.equal(capsuleTextWriteCount(clean), 1, 'P4: the stale entry never delays a clean submission');
    assert.equal(capsuleDeferredEvents(clean).length, 0);
    assert.equal(clean.fireEnter(), true);
    // "fix it"'s record settles the stale slot; "fix it" itself stays owed.
    // Harmless for clean lines: nothing waits on the queue here.
    appendOperatorPromptRecord(clean, 'fix it');
    harnessDriveN(clean, 2);
    assert.equal(clean.runner.input.outstanding.length, 1);
    assert.equal(capsuleEventCount(clean, 'submission-receipt'), 1);
  } finally {
    clean.cleanup();
  }

  // The stated cost: a MAYBE CR (Backspace immediately followed by Enter:
  // the tracker did not see the byte before the cursor) behind the stale
  // entry is not confirmed by its own record -- that record settles the
  // stale slot -- and the request waits for the operator's next certain
  // prompt. No timer, no retry, no guess: the deferral is visible
  // (outstanding:2) and clears on evidence.
  const edited = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(edited.core.tick().state.state, 'pressure');
    const help = Buffer.from('1\r');
    edited.operator(help);
    const b = ['abcx', '\u007f', '\r'].map((chunk) => Buffer.from(chunk));
    for (const chunk of b) edited.operator(chunk);
    edited.drive();
    assert.equal(capsuleTextWriteCount(edited), 0, 'deferred: the edited CR is uncertain');
    assert.equal(edited.runner.lastReason?.detail?.input?.outstanding, 2);
    appendOperatorPromptRecord(edited, 'abc');
    harnessDriveN(edited, 3);
    assert.equal(capsuleTextWriteCount(edited), 0, 'the record settles the stale slot: fail-closed, still deferred');
    assert.equal(capsuleEventCount(edited, 'submission-receipt'), 1);
    assert.equal(edited.runner.input.outstanding.length, 1);
    assert.equal(edited.runner.input.snapshot().pendingSubmission, true);
    const next = Buffer.from('again\r');
    edited.operator(next);
    harnessDriveN(edited, 2);
    assert.equal(capsuleTextWriteCount(edited), 0, 'the next Enter alone is still not proof');
    appendOperatorPromptRecord(edited, 'again');
    edited.drive();
    assert.equal(capsuleTextWriteCount(edited), 1, 'the certain prompt\'s record confirms it: recovered, fires once');
    assert.equal(capsuleEventCount(edited, 'submission-confirmed'), 1);
    assert.equal(edited.runner.input.snapshot().knownEmpty, true);
    assert.equal(edited.runner.input.snapshot().unknown, false);
    assert.deepEqual(
      edited.pty.writes.map((w) => w.toString('latin1')),
      [help.toString(), ...b.map(String), next.toString(), CAPSULE_REQUEST_TEXT],
    );
    assert.equal(edited.fireEnter(), true);
    harnessDriveN(edited, 20);
    assert.equal(capsuleTextWriteCount(edited), 1, 'exactly once');
  } finally {
    edited.cleanup();
  }
});

test('R4 session rebind forgets the old session\'s outstanding CRs and re-notes the receipt watch on the new transcript', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.operator(Buffer.from('one\r'));
    for (const chunk of SPECIMEN_1_RAW) harness.operator(Buffer.from(chunk));
    assert.equal(harness.runner.input.outstanding.length, 2);
    const oldWatch = harness.runner.pendingSubmissionWatch;
    assert.equal(oldWatch?.transcript, harness.fixture.transcriptPath);

    // The new session's transcript already holds a prompt record from before
    // the rebind: it must never be read as evidence.
    const nextTranscript = transcriptPathFor({ cwd: harness.fixture.cwd, sessionId: NEXT_SESSION_ID, homeDir: harness.fixture.homeDir });
    fs.mkdirSync(path.dirname(nextTranscript), { recursive: true });
    fs.writeFileSync(nextTranscript, '{"type":"summary"}\n');
    appendOperatorPromptRecord(harness, 'a prompt already in the new file', { transcriptPath: nextTranscript });

    assert.equal(harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)), true);
    assert.equal(harness.runner.input.outstanding.length, 1, 'only the pending CR\'s own slot survives the rebind');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true, 'the composer model is untouched');
    assert.equal(harness.runner.pendingSubmissionWatch, null, 'the watch is dropped at rebind');
    assert.equal(harness.fireEnter(), true, 'the wake Enter lands');
    harness.drive();
    assert.equal(harness.runner.pendingSubmissionWatch?.transcript, nextTranscript, 're-noted against the new transcript');
    assert.equal(harness.runner.pendingSubmissionWatch?.offset, fs.statSync(nextTranscript).size, 'at its CURRENT size, never its history');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0, 'the pre-existing record confirmed nothing');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true);

    // A new record in the new transcript resolves it (today's rebind behaviour).
    appendOperatorPromptRecord(harness, 'the first prompt of the new session', { transcriptPath: nextTranscript });
    harness.drive();
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
    assert.equal(harness.runner.input.outstanding.length, 0);
    assert.equal(harness.runner.input.snapshot().knownEmpty, true);
  } finally {
    harness.cleanup();
  }
});

// Review of c011881c (F1, MED): operator bytes typed during the clear window
// are observed, QUEUED, and flushed into the NEW session after the wake
// Enter -- their records land in the new transcript. c011881c forgot their
// slots at rebind, so the queued clean prompt's record popped the queued
// uncertain draft's slot and declared it empty. The reviewer's probe H1,
// through the real clear -> receipt -> rebind -> wake -> flush path.
test('R5 F1: CRs still queued behind the clear keep their slots across the rebind; their records in the new transcript settle them in order', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    assert.equal(harness.fireEnter(), true, 'setup: the clear Enter physically lands');
    // The operator keeps working while the clear is in flight: a clean
    // prompt, then the edited draft with a hidden newline. Both are queued.
    const hello = Buffer.from('hello there\r');
    harness.operator(hello);
    const b = SPECIMEN_1_RAW.map((chunk) => Buffer.from(chunk));
    for (const chunk of b) harness.operator(chunk);
    assert.deepEqual(harness.runner.queuedInput.map(asBuffer), [hello, ...b], 'setup: queued behind the clear');
    assert.equal(harness.runner.input.outstanding.length, 2, 'setup: hello owes a record; B is pending behind it');

    harness.observeClearReceipt('fresh');
    for (let turn = 0; turn < 3 && wakeWriteCount(harness) === 0; turn += 1) harness.drive();
    assert.equal(wakeWriteCount(harness), 1, 'setup: rebound, wake written');
    assert.equal(capsuleEventCount(harness, 'session-rebound'), 1);
    assert.equal(harness.runner.input.outstanding.length, 2,
      'both queued CRs keep their slots across the rebind -- MUST be red on c011881c (hello\'s slot was dropped)');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true);

    // The wake Enter lands and the queue flushes into the new session, in
    // order, byte-exact.
    assert.equal(harness.fireEnter(), true);
    assert.deepEqual(harness.runner.queuedInput, []);
    assert.deepEqual(
      harness.pty.writes.slice(-5).map((w) => w.toString('latin1')),
      [CONTROL_ENTER, hello.toString(), ...b.map(String)],
      'wake Enter, then the queued operator bytes untouched',
    );

    // The new transcript; the watch is re-noted against it at the next tick.
    const nextTranscript = transcriptPathFor({ cwd: harness.fixture.cwd, sessionId: NEXT_SESSION_ID, homeDir: harness.fixture.homeDir });
    fs.mkdirSync(path.dirname(nextTranscript), { recursive: true });
    fs.writeFileSync(nextTranscript, '{"type":"summary"}\n');
    harness.drive();
    assert.equal(harness.runner.pendingSubmissionWatch?.transcript, nextTranscript);

    // hello's record lands in the NEW transcript: it settles hello's slot and
    // must not confirm B, whose draft holds `abc\` + a newline.
    appendOperatorPromptRecord(harness, 'hello there', { transcriptPath: nextTranscript });
    harnessDriveN(harness, 3);
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0,
      'R5: hello\'s record must not confirm B -- MUST be red on c011881c');
    assert.equal(harness.runner.input.snapshot().knownEmpty, false, 'B\'s draft is not declared empty');
    assert.equal(harness.runner.input.snapshot().pendingSubmission, true);
    assert.equal(capsuleEventCount(harness, 'submission-receipt'), 1, 'hello\'s slot was settled');
    assert.equal(harness.runner.input.outstanding.length, 1);

    // Positive: the operator finishes B and sends it; the draft's record is
    // the next one and confirms B.
    const rest = Buffer.from('second line\r');
    harness.operator(rest);
    assert.deepEqual(harness.pty.writes[harness.pty.writes.length - 1], rest, 'passes straight through now');
    harnessDriveN(harness, 2);
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0, 'an Enter without a record is still not proof');
    appendOperatorPromptRecord(harness, 'abc\nsecond line', { transcriptPath: nextTranscript });
    harness.drive();
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1, 'B confirmed by the draft\'s record');
    assert.equal(harness.runner.input.snapshot().knownEmpty, true);
    assert.equal(harness.runner.input.snapshot().unknown, false);
  } finally {
    harness.cleanup();
  }
});

// Review of c011881c (F2): two real-host "user" record shapes that no CR
// produces. Under the ordered rule each would settle an entry still owed its
// own record. C9-style negatives.
test('C12 F2: compaction summaries and <local-command-stdout> user records settle nothing; a real prompt after them does', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    harness.operator(Buffer.from('run the suite\r'));
    for (const chunk of SPECIMEN_1_RAW) harness.operator(Buffer.from(chunk));
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0);
    assert.equal(harness.runner.input.outstanding.length, 2);

    fs.appendFileSync(
      harness.fixture.transcriptPath,
      '\n{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\\nrun the suite"}}\n'
      + '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"This session is being continued from a previous conversation."}]}}\n'
      + '{"type":"user","message":{"role":"user","content":"<local-command-stdout>Total cost: $0.12</local-command-stdout>"}}\n'
      + '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>(no content)</local-command-stdout>"}]}}\n',
    );
    harnessDriveN(harness, 3);
    assert.equal(harness.runner.input.outstanding.length, 2,
      'neither shape settles a slot -- MUST be red on c011881c');
    assert.equal(capsuleEventCount(harness, 'submission-receipt'), 0);
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 0);
    assert.equal(capsuleTextWriteCount(harness), 0);

    // A prompt that merely quotes the tag mid-text is still a prompt.
    appendOperatorPromptRecord(harness, 'run the suite');
    appendOperatorPromptRecord(harness, 'what does <local-command-stdout> mean in the transcript?');
    harness.drive();
    assert.equal(capsuleEventCount(harness, 'submission-receipt'), 1, 'the first real record settled run-the-suite');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1, 'the second confirmed B');
    assert.equal(capsuleTextWriteCount(harness), 1);
    assert.equal(harness.fireEnter(), true);
  } finally {
    harness.cleanup();
  }
});

// Review of c011881c (F3), end to end: one stale slot at the head (a dialog
// answered with an arrow + Enter, never recorded), then an edited-and-retyped
// prompt. The tracker saw `o` land before the cursor, so the Enter is certain
// and the prompt's own record -- which settles the stale slot -- confirms it
// and releases the request. On c011881c it was deferred until an un-edited
// prompt came along.
test('P5 F3: a stale slot followed by an edited-then-retyped prompt is confirmed at the first record; the request fires once', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.core.tick().state.state, 'pressure');
    const dialog = [`${ESC}[B`, '\r'].map((chunk) => Buffer.from(chunk));
    for (const chunk of dialog) harness.operator(chunk);
    assert.equal(harness.runner.input.outstanding.length, 1, 'the dialog answer is an uncertain CR: queued, never recorded');
    const prompt = ['helo', '\u007f', 'lo\r'].map((chunk) => Buffer.from(chunk));
    for (const chunk of prompt) harness.operator(chunk);
    assert.deepEqual(harness.pty.writes, [...dialog, ...prompt], 'byte-exact pass-through');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'deferred: the record is still required');
    assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy');
    assert.equal(harness.runner.lastReason?.detail?.input?.outstanding, 2);

    appendOperatorPromptRecord(harness, 'hello');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1,
      'P5: the certain prompt is confirmed by the first record after it, stale slot or not -- MUST be red on c011881c');
    assert.equal(capsuleEventCount(harness, 'submission-confirmed'), 1);
    assert.equal(harness.runner.input.snapshot().knownEmpty, true);
    assert.equal(harness.runner.input.snapshot().unknown, false);
    assert.equal(harness.runner.input.outstanding.length, 1, 'one slot carried forward, never more');
    assert.deepEqual(
      harness.pty.writes.map((w) => w.toString('latin1')),
      [...dialog.map(String), ...prompt.map(String), CAPSULE_REQUEST_TEXT],
    );
    assert.equal(harness.fireEnter(), true);
    harnessDriveN(harness, 20);
    assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
  } finally {
    harness.cleanup();
  }
});

// PATCH-001K: a verified fresh rebound is the complete wake predicate. The
// existing two-part transport writes the text synchronously at rebind, then
// submits it with one separately scheduled Enter. No transcript, input,
// readiness, retry, or exhaustion layer participates.

function wakeWriteCount(harness) {
  return harness.pty.writes.filter((w) => w.equals(Buffer.from(WAKE_MESSAGE))).length;
}

function wakeEventCount(harness, name) {
  return harness.runner.events.filter((event) => event.name === name).length;
}

function clearReceiptFor(harness, sessionId, bootSequence = 11) {
  return {
    boot_sequence: bootSequence,
    session_id: sessionId,
    source: 'clear',
    observed_at: new Date(harness.fixture.clock.ms() + 1000).toISOString(),
  };
}

test('L2 dedicated wake-Enter ownership survives clearing the control Enter slot', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)), true);
    assert.deepEqual(harness.pty.writes, [Buffer.from(WAKE_MESSAGE)]);
    const wakeEnterIds = [...harness.scheduler.enters.keys()];
    assert.equal(wakeEnterIds.length, 1, 'exactly one wake Enter is pending');
    assert.equal(
      harness.scheduler.enterArms.get(wakeEnterIds[0]),
      harness.runner.controlEnterDelayMs,
      'the wake uses the existing delayed-Enter timer family',
    );

    harness.runner._clearEnter();
    assert.deepEqual(
      [...harness.scheduler.enters.keys()],
      wakeEnterIds,
      'clearing the control pair cannot cancel or replace the wake Enter',
    );

    assert.equal(harness.fireEnter(), true);
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)],
      'the protected wake Enter physically lands exactly once',
    );
    assert.equal(harness.fireEnter(), false, 'no duplicate wake Enter remains');
    assert.equal(wakeEventCount(harness, 'wake-enter-write'), 1);
  } finally {
    harness.cleanup();
  }
});

test('K1 post-clear wake: fires once immediately at a verified fresh rebind', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(wakeWriteCount(harness), 0);
    const ok = harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID));
    assert.equal(ok, true, 'setup: rebind must succeed');
    assert.equal(
      wakeWriteCount(harness),
      1,
      'the wake text must be written synchronously before rebind returns',
    );
    assert.equal(wakeEventCount(harness, 'wake-write'), 1);
    assert.equal(wakeEventCount(harness, 'wake-injected'), 1);
    assert.equal(harness.scheduler.enters.size, 1, 'the separate Enter is scheduled by the same transaction');
  } finally {
    harness.cleanup();
  }
});

test('K3 post-clear wake: transcript growth, stillness, or absence cannot veto it', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const transcriptPath = transcriptPathFor({
      cwd: harness.fixture.cwd,
      sessionId: NEXT_SESSION_ID,
      homeDir: harness.fixture.homeDir,
    });
    assert.equal(fs.existsSync(transcriptPath), false, 'setup: no rebound transcript exists yet');
    const receipt = clearReceiptFor(harness, NEXT_SESSION_ID);
    writeJson(harness.fixture.bootPath, receipt);
    assert.equal(harness.runner._rebindAfterClear(receipt), true);
    assert.equal(wakeWriteCount(harness), 1, 'transcript absence cannot delay the synchronous wake');

    writeText(transcriptPath, 'boot\n');
    for (let i = 0; i < 8; i += 1) {
      fs.appendFileSync(transcriptPath, 'restoring-' + i + '\n');
      harness.drive();
    }
    assert.equal(wakeWriteCount(harness), 1, 'transcript growth cannot veto or duplicate the wake');
    for (let i = 0; i < 8; i += 1) harness.drive();
    assert.equal(wakeWriteCount(harness), 1, 'transcript stillness cannot duplicate the wake');

    const source = fs.readFileSync(
      fileURLToPath(new URL('../pty-runner.mjs', import.meta.url)),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /\b(?:_retryWakeIfNeeded|_armWake|wakeAttempts|wakeLastTranscriptSize|wakeIdleTicks|wakeExhausted|wakeSuppressed|WAKE_TURN_GROWTH_THRESHOLD_BYTES|wake-armed|wake-retry|wake-exhausted)\b/,
      'the deleted wake readiness/retry symbols and event names must not remain',
    );
    const fireStart = source.indexOf('  _fireWake() {');
    const enterStart = source.indexOf('  _writeWakeEnter(', fireStart);
    assert.ok(fireStart >= 0 && enterStart > fireStart, 'setup: isolate the wake text-write path');
    assert.doesNotMatch(
      source.slice(fireStart, enterStart),
      /\b(?:transcriptPathFor|statSync)\b/,
      'the wake text-write path must not read transcript size',
    );
  } finally {
    harness.cleanup();
  }
});

test('L5 wake-text failure is named, terminal, honest, and never retried (K6 carry)', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.pty.failWritesRemaining = 999;
    assert.equal(
      harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)),
      false,
      'a terminal wake-text write failure is not a successful rebind result',
    );

    assert.equal(harness.pty.failWritesRemaining, 998, 'exactly one wake text write was attempted');
    assert.equal(harness.runner.lastReason?.code, 'runner-wake-write-failed');
    assert.equal(harness.runner.automationEnabled, false);
    assert.equal(harness.runner.phase, 'disabled');
    assert.equal(wakeEventCount(harness, 'wake-write'), 1);
    assert.equal(wakeWriteCount(harness), 0, 'the fake records only successful physical writes');
    assert.deepEqual(harness.pty.writes, [], 'no child-visible wake bytes landed');
    assert.equal(harness.scheduler.enters.size, 0, 'a failed text write schedules no Enter');

    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(harness.pty.failWritesRemaining, 998, 'disabled automation performs no retry');
    assert.equal(wakeEventCount(harness, 'wake-write'), 1);
  } finally {
    harness.cleanup();
  }
});

test('L5 wake-text failure retains the pre-rebind FIFO behind the terminal hold', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const heldOperatorBytes = Buffer.from('held-before-wake-text\r');
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    harness.fireEnter();
    harness.operator(heldOperatorBytes);
    harness.observeClearReceipt('fresh');

    harness.pty.failWritesRemaining = 999;
    // The release path can span more than one tick before the rebind fires
    // the wake (L4's proven bound) — drive until the wake-write attempt is
    // observed, never past it.
    for (let turn = 0; turn < 3 && wakeEventCount(harness, 'wake-write') === 0; turn += 1) {
      harness.drive();
    }

    assert.equal(harness.pty.failWritesRemaining, 998, 'one wake-text write was attempted');
    assert.equal(harness.runner.lastReason?.code, 'runner-wake-write-failed');
    assert.equal(harness.runner.automationEnabled, false);
    assert.equal(harness.runner.inputHold, true);
    assert.deepEqual(
      harness.runner.queuedInput.map(asBuffer),
      [heldOperatorBytes],
      'wake-text failure cannot release queued bytes without a physical wake Enter',
    );
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
      ],
      'the failed wake text adds no child-visible bytes',
    );
    assert.equal(harness.scheduler.enters.size, 0);
    for (let turn = 0; turn < 10; turn += 1) harness.drive();
    assert.equal(harness.pty.failWritesRemaining, 998, 'terminal wake-text failure never retries');
  } finally {
    harness.cleanup();
  }
});

test('K2 post-clear wake: stale dirty keyboard or permission input cannot veto the rebound wake', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.input.observe('operator-is-mid-type');
    assert.equal(harness.runner.input.snapshot().knownEmpty, false, 'setup: stale pre-clear input is dirty');

    assert.equal(harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)), true);
    assert.equal(
      wakeWriteCount(harness),
      1,
      'a verified fresh rebound wakes even when the pre-clear tracker is dirty',
    );
    assert.equal(
      harness.runner.input.snapshot().knownEmpty,
      false,
      'the wake neither requires nor forges a clean input tracker',
    );
  } finally {
    harness.cleanup();
  }
});

test('K4 post-clear wake: repeated ticks cannot submit a second wake', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const receipt = clearReceiptFor(harness, NEXT_SESSION_ID);
    writeJson(harness.fixture.bootPath, receipt);
    assert.equal(harness.runner._rebindAfterClear(receipt), true);
    assert.equal(wakeWriteCount(harness), 1);

    for (let i = 0; i < 80; i += 1) harness.drive();

    assert.equal(wakeWriteCount(harness), 1, 'ticks cannot buy another wake write');
    assert.equal(wakeEventCount(harness, 'wake-write'), 1);
    assert.equal(wakeEventCount(harness, 'wake-injected'), 1);
    assert.equal(wakeEventCount(harness, 'wake-retry'), 0);
    assert.equal(wakeEventCount(harness, 'wake-exhausted'), 0);
  } finally {
    harness.cleanup();
  }
});

test('L7 duplicate receipt/rebind cannot submit a second wake (K4b carry)', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const receipt = clearReceiptFor(harness, NEXT_SESSION_ID);
    writeJson(harness.fixture.bootPath, receipt);
    assert.equal(harness.runner._rebindAfterClear(receipt), true);
    assert.equal(wakeWriteCount(harness), 1);
    assert.equal(harness.fireEnter(), true, 'complete the first wake before duplicate observations');
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)],
    );

    // Re-enter the function DIRECTLY with the identical receipt — the latch
    // inside _rebindAfterClear, not the tick-site session comparison, must
    // hold (reviewer mutant: latch replaced with `if (true)` survived every
    // prior test because no test re-entered the function).
    harness.runner._rebindAfterClear(receipt);
    harness.runner._rebindAfterClear(receipt);

    assert.equal(wakeWriteCount(harness), 1, 'the wakeSessionId latch alone must refuse a second submission');
    assert.equal(wakeEventCount(harness, 'wake-write'), 1);
    assert.equal(wakeEventCount(harness, 'wake-injected'), 1);
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)],
      'one receipt produces exactly one complete wake transaction',
    );
    assert.equal(harness.fireEnter(), false);
  } finally {
    harness.cleanup();
  }
});

test('L8 no verified fresh rotated rebind submits a wake (K5 carry)', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transportFactory = () => {
      throw new Error('K5 scripted rebind failure');
    };

    assert.equal(
      harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)),
      false,
      'a failed transport rebind is not a verified fresh rebound',
    );
    assert.equal(harness.runner.lastReason?.code, 'runner-transport-rebind-failed');
    assert.equal(wakeWriteCount(harness), 0);
    assert.equal(wakeEventCount(harness, 'wake-write'), 0);
    assert.deepEqual(harness.pty.writes, [], 'no wake bytes reach the child');
    assert.equal(harness.scheduler.enters.size, 0);
  } finally {
    harness.cleanup();
  }
});

test('L8 a non-rotated clear receipt submits no wake bytes', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(
      harness.runner._rebindAfterClear(clearReceiptFor(harness, SESSION_ID)),
      false,
    );
    assert.equal(harness.runner.lastReason?.code, 'runner-clear-session-not-rotated');
    assert.deepEqual(harness.pty.writes, []);
    assert.equal(harness.scheduler.enters.size, 0);
    assert.equal(wakeEventCount(harness, 'wake-write'), 0);
  } finally {
    harness.cleanup();
  }
});

test('L5 wake-Enter failure is named, terminal, and never retried (K7 carry)', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)), true);
    assert.equal(wakeWriteCount(harness), 1);
    assert.deepEqual(harness.pty.writes, [Buffer.from(WAKE_MESSAGE)]);
    assert.equal(harness.scheduler.enters.size, 1, 'one separate Enter is pending');
    const heldOperatorBytes = Buffer.from('held-after-wake-text\r');
    harness.operator(heldOperatorBytes);

    harness.pty.failWritesRemaining = 999;
    assert.equal(harness.scheduler.fireEnter(), true);
    assert.equal(harness.pty.failWritesRemaining, 998, 'exactly one Enter write was attempted');
    assert.equal(harness.runner.lastReason?.code, 'runner-wake-enter-write-failed');
    assert.equal(harness.runner.automationEnabled, false);
    assert.equal(harness.runner.phase, 'disabled');
    assert.equal(wakeEventCount(harness, 'wake-enter-write'), 1);
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(WAKE_MESSAGE)],
      'the failed Enter records no child-visible byte',
    );
    assert.deepEqual(
      harness.runner.queuedInput.map(asBuffer),
      [heldOperatorBytes],
      'terminal wake failure retains queued input behind the unsubmitted wake text',
    );
    assert.equal(harness.runner.inputHold, true, 'terminal failure stays fail-closed');
    assert.equal(harness.scheduler.fireEnter(), false, 'no Enter retry remains scheduled');

    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(harness.pty.failWritesRemaining, 998, 'disabled automation performs no retry');
    assert.equal(harness.runner.lastReason?.code, 'runner-wake-enter-write-failed');
    assert.equal(wakeEventCount(harness, 'wake-enter-write'), 1);
  } finally {
    harness.cleanup();
  }
});

test('L6 disable or shutdown cancels a pending wake Enter loudly and terminally', async (t) => {
  for (const kind of ['disable', 'shutdown']) {
    await t.test(kind, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        assert.equal(
          harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)),
          true,
        );
        assert.deepEqual(harness.pty.writes, [Buffer.from(WAKE_MESSAGE)]);
        assert.equal(harness.scheduler.enters.size, 1, 'setup: wake Enter is pending');
        const heldOperatorBytes = Buffer.from(`held-before-${kind}\r`);
        harness.operator(heldOperatorBytes);

        if (kind === 'disable') {
          harness.setGuard('killSwitch', true);
          harness.drive();
        } else {
          harness.shutdown();
        }

        assert.equal(harness.runner.lastReason?.code, 'runner-wake-enter-cancelled');
        assert.equal(harness.runner.automationEnabled, false);
        assert.equal(harness.runner.phase, 'disabled');
        assert.equal(harness.runner.inputHold, true, 'terminal cancellation keeps input held');
        assert.equal(harness.runner.controlLockHeld, false, 'terminal wake hold does not retain the clear lock');
        assert.equal(wakeEventCount(harness, 'wake-enter-cancelled'), 1);
        assert.equal(
          harness.runner.lastReason?.detail?.source,
          kind === 'disable' ? 'automation-disable' : 'shutdown',
        );
        if (kind === 'disable') {
          assert.equal(harness.runner.lastReason?.detail?.cause?.code, 'kill-switch-test');
        }
        assert.equal(harness.scheduler.enters.size, 0, 'the pending wake timer is removed');
        assert.equal(harness.fireEnter(), false, 'a cancelled callback cannot write later');
        assert.deepEqual(
          harness.pty.writes,
          [Buffer.from(WAKE_MESSAGE)],
          'cancellation never silently drops into or fabricates an Enter write',
        );
        assert.deepEqual(
          harness.runner.queuedInput.map(asBuffer),
          [heldOperatorBytes],
          'cancellation never releases queued input without a physical wake Enter',
        );
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('L9 first-run initialization emits no resume transaction (K8 carry)', () => {
  const fixture = makeFixture('k8-first-run-no-resume');
  const pty = new ScriptedPty();
  const scheduler = new ManualScheduler();
  const stdin = new ScriptedStream();
  const stdout = new ScriptedStream();
  const stderr = new ScriptedStream();
  const processLike = new ScriptedStream();
  const firstSessionId = 'session-first-run';
  const receipt = {
    boot_sequence: 1,
    session_id: firstSessionId,
    source: 'startup',
    observed_at: new Date(fixture.clock.ms()).toISOString(),
  };
  const state = {
    state: 'idle',
    session_id: firstSessionId,
    boot_sequence_at_start: 1,
    hold: null,
  };
  const firstRunTransport = {
    get state() { return state; },
    tick() {
      return { state, transitioned: false, status: 'idle', action: null };
    },
    beginClearSubmission() { return null; },
    confirmClearObserved() { return null; },
    close() {},
  };
  let runner = null;
  try {
    fs.rmSync(fixture.capsulePath, { force: true });
    assert.equal(fs.existsSync(fixture.capsulePath), false, 'setup: first run has no capsule yet');
    runner = new ManagedPtyRunner({
      ptyProcess: pty,
      memRoot: fixture.memRoot,
      transportFactory: () => firstRunTransport,
      baselineBootSequence: null,
      fsImpl: fs,
      env: fixture.env,
      stdin,
      stdout,
      stderr,
      terminal: stdout,
      processLike,
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      now: fixture.clock,
      readBootReceiptFn: () => ({ ok: true, receipt }),
      readKillSwitchFn: () => ({ active: false, code: null, detail: null }),
      log: (message) => fixture.logs.push(message),
      scheduleTick: (callback) => scheduler.scheduleTick(callback),
      clearTick: (handle) => scheduler.clearTick(handle),
      scheduleCommit: (callback) => scheduler.scheduleCommit(callback),
      clearCommit: (handle) => scheduler.clearCommit(handle),
      scheduleWatchdog: (callback, ttl) => scheduler.scheduleWatchdog(callback, ttl),
      clearWatchdog: (handle) => scheduler.clearWatchdog(handle),
      scheduleEnter: (callback, delay) => scheduler.scheduleEnter(callback, delay),
      clearEnter: (handle) => scheduler.clearEnter(handle),
      exitFn: () => {},
    });

    const result = runner.tick();
    assert.equal(result.state.state, 'idle');
    assert.equal(runner.sessionId, firstSessionId);
    assert.equal(runner.events.filter((event) => event.name === 'session-bound').length, 1);
    assert.equal(runner.events.filter((event) => event.name === 'session-rebound').length, 0);
    assert.equal(
      runner.events.filter((event) => (
        event.name === 'wake-write' || event.name === 'wake-injected'
      )).length,
      0,
    );
    assert.deepEqual(pty.writes, [], 'initial binding writes neither resume text nor Enter');
    assert.equal(scheduler.enters.size, 0, 'initial binding schedules no resume Enter');
  } finally {
    runner?.shutdown({ exitCode: 0, killChild: true });
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

// SPEC AMENDMENT (2026-08-05): accepted resume contract -- the wake is
// not a bare nudge, it IS the resume instruction, so the boot
// turn runs the verb visibly (thinking + narration the operator can watch),
// the same way a seat runs resume today. Locks the wording contract in code
// so a future edit can't silently drift back to a bare nudge: commands the
// run, references the staged procedure, carries a self-contained fallback
// if staging is absent, and stays within two sentences -- never inlines the
// procedure or capsule content itself (the hook already staged those; the
// wake COMMANDS the run, it doesn't duplicate the payload).
test('post-clear wake message commands the resume verb, not a bare nudge (SPEC AMENDMENT)', () => {
  // The submit CR is NOT part of this constant: it rides its own delayed
  // write so the terminal parses it as a keypress. Gluing text+CR into one
  // chunk makes the terminal read the whole thing as pasted content and the
  // message never submits -- measured on the live cert seat 2026-08-05, and
  // the reason CLEAR_CONTROL_TEXT carries no CR either.
  assert.ok(!WAKE_MESSAGE.includes('\r'), 'must NOT carry the submit CR -- a text+CR chunk is read as a paste');
  assert.ok(!WAKE_MESSAGE.includes('\n'), 'must stay a single line');
  assert.ok(/^\[\w+\]/.test(WAKE_MESSAGE), 'must open with a bracketed machine-origin prefix');

  const sentenceCount = (WAKE_MESSAGE.match(/\./g) || []).length;
  assert.ok(
    sentenceCount <= 2,
    `must command the run in max two sentences -- MUST be red on unmodified code if it exceeds that, counted ${sentenceCount}`,
  );
  assert.match(
    WAKE_MESSAGE,
    /capsule/i,
    'must command loading the capsule, not just "resume" -- MUST be red on unmodified code (the bare-nudge wording never mentions it)',
  );
  assert.match(
    WAKE_MESSAGE,
    /if\b[^.]*staged/i,
    'must carry a self-contained fallback for when no procedure is staged -- MUST be red on unmodified code',
  );
});

// The wake text and its Enter must be TWO writes. A single chunk carrying
// text+CR is read by the terminal as pasted content, so the CR lands in the
// composer instead of submitting -- the message sits there until a human
// presses Enter. This is the same defect the clear control write was already
// fixed for (see _writeControl's own comment: "Enter rides its own delayed
// write so the terminal parses it as a keypress"), and CLEAR_CONTROL_TEXT
// carries no CR for exactly this reason. Measured on the live cert seat
// 2026-08-05: the wake never submitted, and the operator's own Enter flushed
// it -- the pre-fix symptom exactly.
test('L4 child-visible resume order is wake text, one Enter, then queued input in original order', () => {
  assert.ok(
    !WAKE_MESSAGE.includes('\r'),
    'WAKE_MESSAGE must not carry a trailing CR -- a text+CR single chunk is read as a PASTE and never submits',
  );

  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const queuedBeforeReceipt = Buffer.from('queued-before-receipt');
    const queuedDuringWake = Buffer.from(CLEAR_CONTROL_INPUT);

    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    assert.equal(harness.fireEnter(), true, 'setup: the clear Enter physically lands');
    harness.operator(queuedBeforeReceipt);
    harness.observeClearReceipt('fresh');
    for (let turn = 0; turn < 3 && wakeWriteCount(harness) === 0; turn += 1) {
      harness.drive();
    }

    assert.equal(wakeWriteCount(harness), 1, 'the fresh rotated receipt writes one wake text');
    assert.equal(harness.scheduler.enters.size, 1, 'exactly one separate Enter is pending');
    assert.equal(harness.snapshot().holdActive, true, 'the wake owns the input hold until its Enter writes');
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
        Buffer.from(WAKE_MESSAGE),
      ],
      'queued pre-receipt input stays held behind the wake text',
    );

    harness.operator(queuedDuringWake);
    for (let turn = 0; turn < 8; turn += 1) harness.drive();
    assert.deepEqual(
      harness.runner.queuedInput.map(asBuffer),
      [queuedBeforeReceipt, queuedDuringWake],
      'unrelated input remains queued throughout the pending-wake-Enter window',
    );
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
        Buffer.from(WAKE_MESSAGE),
      ],
      'neither the operator path nor the tick flush gate may release input early',
    );

    assert.equal(harness.fireEnter(), true);
    assert.deepEqual(
      harness.pty.writes,
      [
        Buffer.from(COMPOSER_KILL_LINE),
        Buffer.from(CLEAR_CONTROL_TEXT),
        Buffer.from(CONTROL_ENTER),
        Buffer.from(WAKE_MESSAGE),
        Buffer.from(CONTROL_ENTER),
        queuedBeforeReceipt,
        queuedDuringWake,
      ],
      'physical order is clear transaction, wake text, wake Enter, then FIFO operator input',
    );
    assert.deepEqual(harness.runner.queuedInput, [], 'the successful wake Enter drains the queue');
    assert.equal(harness.runner.wakeEnterHandle, null, 'successful physical write releases wake ownership');
    assert.equal(harness.fireEnter(), false, 'the wake Enter is exactly once');
  } finally {
    harness.cleanup();
  }
});

// WATCHED WAKE SUBMISSION. Measured live 2026-09-24 and 2026-09-28: the
// runner rebound on the fresh receipt, wrote the wake text, wrote its Enter
// 400ms later -- while the fresh session was still running SessionStart hooks
// (~20s). The keypress was dropped and the text sat unsent until the operator
// pressed Enter. The scripted PTY never "accepts" anything, so in this
// harness a lost Enter IS the default: no child output follows it and the
// rebound session's transcript never gains the wake's user record. A landed
// Enter is modelled by appending that record (the same evidence class the
// capsule ack scan reads).

function wakeTranscriptPath(harness) {
  return transcriptPathFor({
    cwd: harness.fixture.cwd,
    sessionId: NEXT_SESSION_ID,
    homeDir: harness.fixture.homeDir,
  });
}

function landWakePrompt(harness) {
  const target = wakeTranscriptPath(harness);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(
    target,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: WAKE_MESSAGE } })}\n`,
  );
}

function wakeEnterWrites(harness) {
  const first = harness.pty.writes.findIndex((w) => w.equals(Buffer.from(WAKE_MESSAGE)));
  assert.ok(first >= 0, 'setup: the wake text was written');
  return harness.pty.writes.slice(first + 1)
    .filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length;
}

function rebindWithWakeEnterLanded(harness) {
  // Below the pressure threshold so the rebound core stays idle: these
  // specimens prove the watch, not the pressure lifecycle.
  harness.fixture.pressure.pct = 10;
  const receipt = clearReceiptFor(harness, NEXT_SESSION_ID);
  writeJson(harness.fixture.bootPath, receipt);
  assert.equal(harness.runner._rebindAfterClear(receipt), true, 'setup: rebind');
  assert.equal(harness.fireEnter(), true, 'setup: the wake Enter physically writes');
  assert.equal(harness.runner.inputHold, false, 'setup: the physical Enter releases the hold (L4 contract)');
  assert.ok(harness.runner.wakeSubmission !== null, 'the physical Enter arms the watch');
}

// One tick notices the new output; WAKE_SUBMIT_SETTLE_TICKS still ticks
// after it make the settle window.
function settleChildOutput(harness, text = 'composer-repaint\r\n') {
  harness.childOutput(text);
  for (let i = 0; i <= WAKE_SUBMIT_SETTLE_TICKS; i += 1) harness.drive();
}

test('W1 a wake Enter lost to session-start hooks is unsubmitted, re-pressed only on settled output, then committed by the transcript record', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    rebindWithWakeEnterLanded(harness);
    assert.deepEqual(harness.pty.writes, [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)]);

    // THE REPRODUCTION: Enter written, nothing accepted it. Detectable as
    // NOT submitted -- no user record, no child output after the Enter.
    assert.equal(fs.existsSync(wakeTranscriptPath(harness)), false, 'no wake prompt record exists');
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0, 'silence is not a submission');
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0, 'elapsed ticks alone never press Enter (not a bare sleep)');
    assert.equal(wakeEnterWrites(harness), 1);

    // Hooks still running: the child keeps painting, so nothing settles.
    for (let i = 0; i < WAKE_SUBMIT_SETTLE_TICKS * 2; i += 1) {
      harness.childOutput(`hook-spinner-${i}\r\n`);
      harness.drive();
    }
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0, 'busy output cannot buy a retry');

    // Hooks finish, the composer repaints, the screen holds still.
    harness.childOutput('composer-repaint\r\n');
    for (let i = 0; i < WAKE_SUBMIT_SETTLE_TICKS; i += 1) harness.drive();
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0, 'the settle window is not yet met');
    harness.drive();
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 1, 'settled post-Enter output buys exactly one retry');
    assert.equal(wakeEnterWrites(harness), 2, 'the retry is a second physical Enter');
    assert.equal(wakeWriteCount(harness), 1, 'the wake TEXT is never rewritten');
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER), Buffer.from(CONTROL_ENTER)],
    );

    // The re-pressed Enter lands: the seat records the prompt.
    landWakePrompt(harness);
    harness.drive();
    assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 1);
    assert.equal(harness.runner.wakeSubmission, null, 'the watch closes on commitment');
    const committed = harness.runner.events.find((e) => e.name === 'wake-submission-committed');
    assert.deepEqual({ enters: committed.detail.enters, retries: committed.detail.retries }, { enters: 2, retries: 1 });

    settleChildOutput(harness);
    settleChildOutput(harness);
    assert.equal(wakeEnterWrites(harness), 2, 'a committed wake buys no further Enter');
    assert.equal(harness.runner.automationEnabled, true);
  } finally {
    harness.cleanup();
  }
});

test('W2 a wake Enter accepted the first time is committed with no retry and no duplicate Enter', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    rebindWithWakeEnterLanded(harness);
    harness.childOutput('turn-started\r\n');
    landWakePrompt(harness);
    harness.drive();
    assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 1);
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0);

    for (let round = 0; round < 3; round += 1) settleChildOutput(harness);
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(wakeEnterWrites(harness), 1, 'exactly one Enter, ever');
    assert.equal(wakeWriteCount(harness), 1);
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0);
    assert.equal(wakeEventCount(harness, 'wake-submission-unconfirmed'), 0);
  } finally {
    harness.cleanup();
  }
});

test('W3 operator bytes after the wake end the watch by name: no retry over their composer', async (t) => {
  for (const kind of ['typed-after-enter', 'queued-behind-enter']) {
    await t.test(kind, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        const operatorBytes = Buffer.from(`operator-${kind}`);
        if (kind === 'queued-behind-enter') {
          // L4b shape: typed while the wake Enter was pending, released
          // behind it -- those bytes now share the composer with the text.
          harness.fixture.pressure.pct = 10;
          const receipt = clearReceiptFor(harness, NEXT_SESSION_ID);
          writeJson(harness.fixture.bootPath, receipt);
          assert.equal(harness.runner._rebindAfterClear(receipt), true);
          harness.operator(operatorBytes);
          assert.equal(harness.fireEnter(), true);
        } else {
          rebindWithWakeEnterLanded(harness);
          harness.operator(operatorBytes);
        }
        assert.deepEqual(
          harness.pty.writes,
          [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER), operatorBytes],
          'operator bytes pass through untouched after the physical Enter',
        );

        harness.drive();
        assert.equal(wakeEventCount(harness, 'wake-submission-unconfirmed'), 1);
        const closed = harness.runner.events.find((e) => e.name === 'wake-submission-unconfirmed');
        assert.equal(closed.detail.reason, 'operator-input');
        assert.equal(harness.runner.wakeSubmission, null);

        for (let round = 0; round < 3; round += 1) settleChildOutput(harness);
        assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0, 'no retry may follow operator bytes');
        assert.equal(wakeEnterWrites(harness), 1);
        assert.deepEqual(
          harness.pty.writes,
          [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER), operatorBytes],
          'the watch writes nothing over an operator-touched composer',
        );
        assert.equal(harness.runner.inputHold, false);
        assert.equal(harness.runner.automationEnabled, true, 'operator input is sovereignty, not a fault');
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('W4 the retry cap ends the watch by name with the hold released and nothing further written', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    rebindWithWakeEnterLanded(harness);
    for (let attempt = 1; attempt <= WAKE_ENTER_RETRY_LIMIT; attempt += 1) {
      settleChildOutput(harness, `repaint-${attempt}\r\n`);
      assert.equal(wakeEventCount(harness, 'wake-enter-retry'), attempt, `retry ${attempt} on settled output`);
      assert.equal(wakeEventCount(harness, 'wake-submission-unconfirmed'), 0);
    }
    assert.equal(wakeEnterWrites(harness), 1 + WAKE_ENTER_RETRY_LIMIT);

    settleChildOutput(harness, 'repaint-after-last-retry\r\n');
    assert.equal(wakeEventCount(harness, 'wake-submission-unconfirmed'), 1);
    const closed = harness.runner.events.find((e) => e.name === 'wake-submission-unconfirmed');
    assert.equal(closed.detail.reason, 'retry-cap');
    assert.equal(closed.detail.retries, WAKE_ENTER_RETRY_LIMIT);
    assert.equal(harness.runner.wakeSubmission, null);
    assert.equal(harness.runner.inputHold, false, 'the cap releases nothing it held and holds nothing new');
    assert.deepEqual(harness.runner.queuedInput, []);
    assert.equal(harness.runner.automationEnabled, true, 'an unconfirmed wake is loud, not terminal');

    for (let round = 0; round < 3; round += 1) settleChildOutput(harness);
    assert.equal(wakeEnterWrites(harness), 1 + WAKE_ENTER_RETRY_LIMIT, 'the cap is a cap');
    assert.equal(wakeWriteCount(harness), 1, 'the wake TEXT is never rewritten');
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), WAKE_ENTER_RETRY_LIMIT);
  } finally {
    harness.cleanup();
  }
});

test('W5 disable and cancellation close a pending wake watch by name and never retry afterwards', async (t) => {
  for (const kind of ['kill-switch', 'cancellation']) {
    await t.test(kind, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        rebindWithWakeEnterLanded(harness);
        if (kind === 'kill-switch') {
          harness.setGuard('killSwitch', true);
          harness.drive();
        } else {
          harness.cancel();
        }
        assert.equal(harness.runner.automationEnabled, false);
        assert.equal(harness.runner.wakeSubmission, null);
        assert.equal(wakeEventCount(harness, 'wake-submission-unconfirmed'), 1);
        const closed = harness.runner.events.find((e) => e.name === 'wake-submission-unconfirmed');
        assert.equal(closed.detail.reason, 'automation-disabled');

        for (let round = 0; round < 3; round += 1) settleChildOutput(harness);
        assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0);
        assert.deepEqual(harness.pty.writes, [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)]);
      } finally {
        harness.cleanup();
      }
    });
  }
});

// EVIDENCE DISCIPLINE FOR THE WATCH (W6-W10). The commit signal is a record
// in the REBOUND session's transcript past the offset noted at the Enter.
// Anything that is not that -- no transcript, a transcript that cannot be
// read, the old session's transcript, a record from before the Enter, the
// wake text quoted back inside a tool result or an assistant turn -- must
// never be reported as wake-submission-committed. And no path, including a
// failing retry write or a rebind while the watch is pending, may leave a
// watch that keeps pressing Enter.

const SECOND_CLEAR_SESSION_ID = 'session-after-second-clear';

function transcriptPathForSession(harness, sessionId) {
  return transcriptPathFor({
    cwd: harness.fixture.cwd,
    sessionId,
    homeDir: harness.fixture.homeDir,
  });
}

function appendTranscriptRecord(target, record) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`);
}

function wakeUserRecord() {
  return { type: 'user', message: { role: 'user', content: WAKE_MESSAGE } };
}

function lastUnconfirmed(harness) {
  const events = harness.runner.events.filter((e) => e.name === 'wake-submission-unconfirmed');
  return events[events.length - 1] || null;
}

function controlEnterWrites(harness) {
  return harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length;
}

test('W6 a transcript that is missing, unreadable, or unresolvable never commits the wake, and the Enter count stays bounded', async (t) => {
  for (const kind of ['missing', 'unreadable', 'unresolvable']) {
    await t.test(kind, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        if (kind === 'unresolvable') {
          // A receipt that passes the receipt shape check (non-empty string)
          // but no transcript path can be built for it: the watch has no
          // evidence class at all, so it must not press Enter blind.
          const badSessionId = 'bad session id!';
          assert.equal(
            transcriptPathFor({ cwd: harness.fixture.cwd, sessionId: badSessionId, homeDir: harness.fixture.homeDir }),
            null,
            'setup: the session id resolves to no transcript path',
          );
          harness.fixture.pressure.pct = 10;
          const receipt = clearReceiptFor(harness, badSessionId);
          writeJson(harness.fixture.bootPath, receipt);
          assert.equal(harness.runner._rebindAfterClear(receipt), true, 'setup: rebind');
          assert.equal(harness.fireEnter(), true, 'setup: the wake Enter physically writes');
          assert.equal(harness.runner.inputHold, false, 'the physical Enter still releases the hold');

          assert.equal(harness.runner.wakeSubmission, null, 'no watch stays armed without an evidence source');
          const closed = lastUnconfirmed(harness);
          assert.ok(closed, 'the watch closes by name');
          assert.equal(closed.detail.reason, 'transcript-unresolvable');
          assert.deepEqual({ enters: closed.detail.enters, retries: closed.detail.retries }, { enters: 1, retries: 0 });

          for (let round = 0; round <= WAKE_ENTER_RETRY_LIMIT; round += 1) settleChildOutput(harness);
          assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0, 'no evidence source means no retry Enter, ever');
          assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0);
          assert.deepEqual(harness.pty.writes, [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)]);
          assert.equal(harness.runner.automationEnabled, true, 'unconfirmed is loud, not terminal');
          return;
        }

        if (kind === 'unreadable') {
          // The path resolves but is a directory, so it is not a transcript
          // and never becomes one.
          fs.mkdirSync(wakeTranscriptPath(harness), { recursive: true });
        }
        rebindWithWakeEnterLanded(harness);
        assert.ok(wakeTranscriptPath(harness), 'setup: the rebound session resolves a transcript path');
        if (kind === 'missing') {
          assert.equal(fs.existsSync(wakeTranscriptPath(harness)), false, 'setup: no transcript exists');
        }

        for (let i = 0; i < 40; i += 1) harness.drive();
        assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0, 'absence is not a submission');
        assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0, 'absence buys no retry either');

        if (kind === 'unreadable') {
          // ─── CONTRACT CHANGE, #104, AND IT IS DELIBERATE ───────────────────
          // This case used to buy bounded retries and a `retry-cap` close. It
          // now buys NO retries at all, because the retry writes a
          // CONTROL_ENTER and at a permission dialog a CONTROL_ENTER is an
          // answer. The readiness guard will not authorise that write unless it
          // can READ the transcript, and here it cannot.
          //
          // The alternative was rejected on its merits, not by default: letting
          // the retry proceed on an unreadable transcript means treating
          // "cannot read" as "no tool call outstanding", which is the exact
          // substitution #104 exists to prevent. EACCES on a real file takes
          // the identical code path as EISDIR on a directory, so the permissive
          // reading could not be confined to the harmless case.
          //
          // WHAT IT COSTS, bounded and named. The first wake Enter is
          // structurally exempt from the guard (it fires inside
          // _rebindAfterClear, onto a context nothing has been submitted to),
          // so the post-clear resume itself still happens -- an unreadable
          // transcript costs only the RETRIES, never the wake. And the watch
          // still closes BY NAME: `watch.ticks` increments on every tick
          // regardless of the gate, so the budget close fires. A silently
          // parked watch would be worse than the thing being prevented, which
          // is why it is asserted here rather than reasoned about.
          assert.equal(wakeEnterWrites(harness), 1,
            'the first wake Enter landed: the resume is not what an unreadable '
            + 'transcript costs');

          // Settled repaints, which used to buy a retry each, now buy none.
          for (let attempt = 1; attempt <= WAKE_ENTER_RETRY_LIMIT; attempt += 1) {
            settleChildOutput(harness, `repaint-${attempt}
`);
            assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 0,
              'a retry Enter is never written while readiness cannot be established');
          }
          assert.equal(wakeEnterWrites(harness), 1, 'still just the first press');
          const held = harness.events('automatic-write-held')
            .filter((e) => e.detail?.detail?.at === 'wake-enter-retry');
          assert.ok(held.length >= 1, 'and the hold is named, not silent');
          assert.equal(held[0].detail?.detail?.readiness?.reason, 'tool-call-transcript-not-a-file',
            'naming WHY the transcript is unreadable, not just that it is');

          // THE WATCH STILL CLOSES BY NAME. Not `retry-cap` any more -- nothing
          // was retried -- but the tick budget, which is a visible, bounded
          // close rather than a park.
          for (let i = 0; i <= WAKE_SUBMIT_WATCH_TICKS; i += 1) harness.drive();
          const budgetClosed = lastUnconfirmed(harness);
          assert.ok(budgetClosed, 'the watch closes by name rather than parking');
          assert.equal(budgetClosed.detail.reason, 'watch-budget');
          assert.equal(budgetClosed.detail.retries, 0, 'with no retries spent');
          assert.equal(harness.runner.wakeSubmission, null, 'and the watch is released');
          assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0,
            'never committed without the record');
          assert.equal(wakeEnterWrites(harness), 1);
          assert.equal(wakeWriteCount(harness), 1, 'the wake TEXT is never rewritten');
          assert.equal(harness.runner.automationEnabled, true, 'unconfirmed is loud, not terminal');
          assert.equal(harness.runner.inputHold, false);
          return;
        }

        for (let attempt = 1; attempt <= WAKE_ENTER_RETRY_LIMIT; attempt += 1) {
          settleChildOutput(harness, `repaint-${attempt}\r\n`);
          assert.equal(wakeEventCount(harness, 'wake-enter-retry'), attempt);
          assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0, 'a retry is not a commit');
        }
        settleChildOutput(harness, 'repaint-after-last-retry\r\n');
        const closed = lastUnconfirmed(harness);
        assert.ok(closed, 'the watch closes by name');
        assert.equal(closed.detail.reason, 'retry-cap');
        assert.equal(closed.detail.retries, WAKE_ENTER_RETRY_LIMIT);
        assert.equal(harness.runner.wakeSubmission, null);
        assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0, 'never committed without the record');
        assert.equal(wakeEnterWrites(harness), 1 + WAKE_ENTER_RETRY_LIMIT, 'the Enter count is the first press plus the cap');

        for (let round = 0; round < 3; round += 1) settleChildOutput(harness);
        assert.equal(wakeEnterWrites(harness), 1 + WAKE_ENTER_RETRY_LIMIT, 'closed is closed');
        assert.equal(wakeWriteCount(harness), 1, 'the wake TEXT is never rewritten');
        assert.equal(harness.runner.automationEnabled, true);
        assert.equal(harness.runner.inputHold, false);
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('W7 the wake text inside a non-prompt record is a mention, not the wake landing', async (t) => {
  const specimens = {
    // The seat quoting the wake back in its own turn.
    'assistant-echo': {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `You asked: ${WAKE_MESSAGE}` }] },
    },
    // Tool results are stored as type:"user" records in the transcript; a
    // tool reading a file that carries the wake text returns it verbatim.
    'tool-result-quote': {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: `export const WAKE_MESSAGE = '${WAKE_MESSAGE}';` }],
      },
    },
    // Injected context (hook output, local command output) is a user-typed
    // record only in shape; the transcript marks it meta.
    'meta-record': {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: `<local-command-stdout>${WAKE_MESSAGE}</local-command-stdout>` },
    },
  };
  for (const [kind, record] of Object.entries(specimens)) {
    await t.test(kind, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        rebindWithWakeEnterLanded(harness);
        const line = JSON.stringify(record);
        assert.ok(line.includes(WAKE_TRANSCRIPT_LITERAL), 'setup: the specimen carries the transcript literal');
        appendTranscriptRecord(wakeTranscriptPath(harness), record);

        for (let i = 0; i < 5; i += 1) harness.drive();
        assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0, `${kind} must not read as the wake landing`);
        assert.ok(harness.runner.wakeSubmission !== null, 'the watch stays open for real evidence');

        // The scan is not broken, merely strict: the real record still commits.
        landWakePrompt(harness);
        harness.drive();
        assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 1);
        assert.equal(wakeEventCount(harness, 'wake-submission-unconfirmed'), 0);
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('W8 only the rebound session transcript past the Enter offset is evidence: old-session, pre-offset, and rotated records do not commit', async (t) => {
  for (const kind of ['old-session-transcript', 'record-before-arm-offset', 'rotated-shorter']) {
    await t.test(kind, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        const target = wakeTranscriptPath(harness);
        let sizeAtArm = 0;
        if (kind === 'record-before-arm-offset') {
          // A wake record already on disk BEFORE this Enter (a previous
          // session-start artefact, a replay) is older than the Enter, so it
          // cannot be this Enter's landing.
          appendTranscriptRecord(target, wakeUserRecord());
          sizeAtArm = fs.statSync(target).size;
        } else if (kind === 'rotated-shorter') {
          for (let i = 0; i < 64; i += 1) {
            appendTranscriptRecord(target, { type: 'system', text: `filler-${i}-${'x'.repeat(48)}` });
          }
          sizeAtArm = fs.statSync(target).size;
        }
        rebindWithWakeEnterLanded(harness);
        assert.equal(harness.runner.sessionId, NEXT_SESSION_ID, 'the rebind happened before the Enter');
        assert.equal(
          harness.runner.wakeSubmission.transcriptFrom,
          sizeAtArm,
          'the arm offset is the REBOUND session transcript size at the Enter',
        );

        if (kind === 'old-session-transcript') {
          // The record lands in the previous session's file. The path is
          // resolved from the rebound session id, so this is never read.
          appendTranscriptRecord(harness.fixture.transcriptPath, wakeUserRecord());
          assert.notEqual(harness.fixture.transcriptPath, target);
        } else if (kind === 'rotated-shorter') {
          // The file is replaced by a shorter one that carries the record
          // below the noted offset. Not growth past the Enter: not evidence.
          fs.writeFileSync(target, `${JSON.stringify(wakeUserRecord())}\n`);
          assert.ok(fs.statSync(target).size < sizeAtArm, 'setup: the rotated file is shorter than the offset');
        }

        for (let i = 0; i < 5; i += 1) harness.drive();
        assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0, `${kind} must not commit`);
        assert.ok(harness.runner.wakeSubmission !== null, 'the watch stays open');

        // A record appended to the rebound transcript past the offset does.
        if (kind === 'rotated-shorter') {
          fs.appendFileSync(target, `${'y'.repeat(sizeAtArm)}\n`);
        }
        landWakePrompt(harness);
        harness.drive();
        assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 1);
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('W9 a failing retry Enter closes the watch by name, stays non-terminal, and cannot poison a later disable into a wake fault', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    rebindWithWakeEnterLanded(harness);
    harness.pty.failNextWriteChunk = Buffer.from(CONTROL_ENTER);
    settleChildOutput(harness, 'repaint-1\r\n');
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 1, 'one retry was attempted');
    assert.equal(harness.pty.failNextWriteChunk, null, 'the retry write was the failing write');
    assert.deepEqual(
      harness.pty.writes,
      [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)],
      'the failed retry records no child-visible byte',
    );
    const closed = lastUnconfirmed(harness);
    assert.ok(closed, 'the watch closes by name');
    assert.equal(closed.detail.reason, 'enter-write-failed');
    assert.equal(closed.detail.attempt, 1);
    assert.equal(harness.runner.wakeSubmission, null);
    assert.equal(wakeEventCount(harness, 'wake-enter-write-failed'), 1);

    // Non-terminal: the hold was already released at the first Enter and the
    // composer is untouched by anyone else, so nothing new is stranded.
    assert.equal(harness.runner.automationEnabled, true);
    assert.equal(harness.runner.inputHold, false);
    assert.deepEqual(harness.runner.queuedInput, []);
    assert.notEqual(
      harness.runner.lastReason?.code,
      'runner-wake-enter-write-failed',
      'a retry write failure is not the terminal first-Enter fault',
    );

    // Bounded: closed means no further Enter, on any amount of settled output.
    for (let round = 0; round < WAKE_ENTER_RETRY_LIMIT + 1; round += 1) settleChildOutput(harness);
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 1, 'no retry after the failed one');
    assert.deepEqual(harness.pty.writes, [Buffer.from(WAKE_MESSAGE), Buffer.from(CONTROL_ENTER)]);

    // The operator's own Enter still works: live bytes pass straight through.
    const operatorEnter = Buffer.from('\r');
    harness.operator(operatorEnter);
    assert.deepEqual(harness.pty.writes.slice(-1), [operatorEnter], 'operator bytes are not queued behind a fault');

    // A later unrelated disable must report ITS OWN code and must not inherit
    // the wake-terminal handling (which retains the input hold forever).
    harness.setGuard('killSwitch', true);
    harness.drive();
    assert.equal(harness.runner.automationEnabled, false);
    assert.equal(harness.runner.lastReason?.code, 'kill-switch-test', 'the disable names its own cause');
    assert.equal(harness.runner.inputHold, false, 'no hold is retained for a wake that was never stranded by this runner');
    const operatorAfterDisable = Buffer.from('typed-after-disable');
    harness.operator(operatorAfterDisable);
    assert.deepEqual(harness.pty.writes.slice(-1), [operatorAfterDisable], 'operator input still flows after the disable');
  } finally {
    harness.cleanup();
  }
});

test('W10 a rebind while the watch is pending closes the old watch by name; the new wake gets its own watch and no retry leaks across sessions', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    rebindWithWakeEnterLanded(harness);
    settleChildOutput(harness, 'repaint-1\r\n');
    assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 1, 'setup: the first watch has spent one retry');
    assert.equal(harness.runner.wakeSubmission.retries, 1);

    // A second fresh receipt arrives while the first wake is still unconfirmed.
    const second = clearReceiptFor(harness, SECOND_CLEAR_SESSION_ID, 12);
    writeJson(harness.fixture.bootPath, second);
    assert.equal(harness.runner._rebindAfterClear(second), true, 'setup: second rebind');
    assert.equal(harness.runner.sessionId, SECOND_CLEAR_SESSION_ID);
    assert.equal(wakeWriteCount(harness), 2, 'the second fresh session gets its own wake text');

    const closed = lastUnconfirmed(harness);
    assert.ok(closed, 'the first watch is closed by name at the rebind');
    assert.equal(closed.detail.reason, 'session-rebound');
    assert.deepEqual({ enters: closed.detail.enters, retries: closed.detail.retries }, { enters: 2, retries: 1 });
    assert.equal(harness.runner.wakeSubmission, null, 'no watch survives the rebind');

    // While the second wake Enter is pending nothing ticks the old watch.
    assert.deepEqual(harness.drive(), { status: 'wake-enter-pending' });
    assert.equal(controlEnterWrites(harness), 2, 'no Enter is written while the second wake Enter is pending');

    assert.equal(harness.fireEnter(), true, 'the second wake Enter physically writes');
    assert.ok(harness.runner.wakeSubmission !== null, 'the second Enter arms a new watch');
    assert.deepEqual(
      { enters: harness.runner.wakeSubmission.enters, retries: harness.runner.wakeSubmission.retries },
      { enters: 1, retries: 0 },
      'the new watch starts its own count',
    );
    assert.equal(controlEnterWrites(harness), 3);

    // The FIRST session's record is no longer evidence for anything.
    landWakePrompt(harness);
    for (let i = 0; i < 5; i += 1) harness.drive();
    assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 0, 'the old session transcript cannot commit the new wake');

    appendTranscriptRecord(transcriptPathForSession(harness, SECOND_CLEAR_SESSION_ID), wakeUserRecord());
    harness.drive();
    assert.equal(wakeEventCount(harness, 'wake-submission-committed'), 1);
    const committed = harness.runner.events.find((e) => e.name === 'wake-submission-committed');
    assert.deepEqual({ enters: committed.detail.enters, retries: committed.detail.retries }, { enters: 1, retries: 0 });
    assert.equal(harness.runner.wakeSubmission, null);

    for (let round = 0; round < 3; round += 1) settleChildOutput(harness);
    assert.equal(controlEnterWrites(harness), 3, 'nothing retries after the rebound wake commits');
    assert.equal(wakeEventCount(harness, 'wake-submission-unconfirmed'), 1, 'exactly one close: the rebind');
  } finally {
    harness.cleanup();
  }
});

// THE CLEAR MUST WAIT FOR THE CAPSULE ACK.
// The checkpoint gate only ever proved a stop-writer RECORD existed on disk --
// and the Stop hook writes one on every turn end, autosaving a rolling capsule.
// So an idle turn satisfied the gate and the clear fired without the capsule
// verb ever running: capsule -> ack -> clear collapsed to just clear.
// ackFresh existed but only RELAXED a byte check; nothing ever required it.
// Measured live 2026-08-05: resume -> work -> idle -> clear, no capsule, no ack.
test('T4 no ACK means no clear intent and a visible runner-capsule-not-acked refusal', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.primeAuthorized();
    harness.revokeAck('capsule-verb-never-completed'); // the capsule verb never completed
    harness.attemptAutomaticClear();
    harness.flushControl();
    harness.fireEnter();

    assert.deepEqual(
      harness.snapshot().automaticWrites,
      [],
      'no ack for this cycle means no clear -- MUST be red on unmodified code',
    );
    assert.equal(clearIntentEventCount(harness), 0, 'no ACK may mint no clear intent');
    assert.equal(harness.runner.token, null, 'no ACK may mint no submission token');
    assert.equal(harness.snapshot().lastDecision?.code, 'runner-capsule-not-acked');
    assert.match(
      readDaemonErrorLog(harness.fixture.memRoot),
      /AUTO-CLEAR REFUSED \(runner-capsule-not-acked\)/,
      'the ack-less cycle must fail visibly',
    );
  } finally {
    harness.cleanup();
  }
});

test('T5 one ACK persists exactly one clear intent and the same-cycle duplicate stays refused', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    appendExactCapsuleAck(harness);
    harness.drive();

    assert.equal(clearIntentEventCount(harness), 1, 'the first valid ACK buys exactly one clear intent');
    harness.flushControl();
    const writesAfterFirstClear = harness.snapshot().automaticWrites.length;

    const duplicate = harness.forceDuplicateAttempt();
    harness.flushControl();
    assert.equal(duplicate.code, 'EDUPLICATE_CLEAR', 'the core preserves its duplicate-clear refusal');
    assert.equal(clearIntentEventCount(harness), 1, 'the ACK cannot authorize another intent');
    assert.equal(
      harness.snapshot().automaticWrites.length,
      writesAfterFirstClear,
      'the duplicate attempt writes no additional clear bytes',
    );
  } finally {
    harness.cleanup();
  }
});

test('T6b #139 a failed read of the cycle state at commit writes nothing to the seat, and the clear is decided again', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  const realFs = harness.core.fs;
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    assert.equal(harness.runner.phase, 'prepared', 'setup: commit is pending');
    const cyclePath = harness.core.cyclePath;
    const before = fs.readFileSync(cyclePath, 'utf8');
    harness.core.fs = {
      ...realFs,
      readFileSync(target, ...rest) {
        if (String(target) === String(cyclePath)) {
          throw Object.assign(new Error('UNKNOWN: unknown error, read'), { code: 'UNKNOWN' });
        }
        return realFs.readFileSync(target, ...rest);
      },
    };
    harness.flushControl();
    harness.fireEnter();

    // Only the pre-submit composer kill-line may have gone out; that is not a clear.
    assert.ok(
      !Buffer.concat(harness.snapshot().automaticWrites.map((chunk) => Buffer.from(chunk))).toString().includes('/clear'),
      'no clear may reach the seat',
    );
    assert.equal(harness.runner.token, null, 'the refused token is gone');
    assert.equal(harness.snapshot().holdActive, false, 'the refusal releases the prepared hold');
    assert.equal(harness.snapshot().lastDecision?.code, 'ECYCLE_STATE_UNREADABLE');
    assert.equal(fs.readFileSync(cyclePath, 'utf8'), before, 'submitted stays false: nothing was submitted');

    harness.core.fs = realFs;
    const withdrawn = harness.core.tick();
    assert.equal(withdrawn.status, 'clear-intent-withdrawn');
    assert.equal(JSON.parse(fs.readFileSync(cyclePath, 'utf8')).clear_intent, null);
  } finally {
    harness.core.fs = realFs;
    harness.cleanup();
  }
});

test('T6 commit kill switch aborts fail-closed and an invalid boot binding is refused', () => {
  const killed = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    killed.primeAuthorized();
    killed.attemptAutomaticClear();
    assert.equal(killed.runner.phase, 'prepared', 'setup: commit is pending');
    killed.setGuard('killSwitch', true);
    killed.flushControl();

    assert.deepEqual(killed.snapshot().automaticWrites, []);
    assert.equal(killed.snapshot().holdActive, false, 'kill-switch abort releases the prepared hold');
    assert.equal(killed.snapshot().lastDecision?.code, 'kill-switch-test');
  } finally {
    killed.cleanup();
  }

  const invalidBinding = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    invalidBinding.primeAuthorized();
    invalidBinding.setGuard('sessionBinding', 'stale');
    invalidBinding.attemptAutomaticClear();

    assert.deepEqual(invalidBinding.snapshot().automaticWrites, []);
    assert.equal(clearIntentEventCount(invalidBinding), 0, 'invalid binding mints no intent');
    assert.equal(invalidBinding.runner.token, null, 'invalid binding mints no token');
    assert.match(
      invalidBinding.snapshot().lastDecision?.code || '',
      /session|boot|binding/,
    );
  } finally {
    invalidBinding.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #78 clear after ack: refusals after the ack carry the ownership snapshot,
// and an operator byte that interrupts the prepared clear halts at a named
// hold instead of disabling silently. The ack is already observed throughout.
// ---------------------------------------------------------------------------

function clearTextWrites(harness) {
  return harness.pty.writes.map(String).filter((w) => w === CLEAR_CONTROL_TEXT).length;
}

function allRunnerLogs(harness) {
  return [...harness.fixture.logs, readDaemonErrorLog(harness.fixture.memRoot)].join('\n');
}

const OWNERSHIP_FIELDS = [
  'knownEmpty', 'unknown', 'activePaste', 'activeControl',
  'composerMayHoldControlText', 'inputHold', 'enterHandlePending', 'queuedChunks',
];

test('78a child output never owns the composer: a flood after the ack still yields exactly one clear', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    const before = harness.runner.snapshot().input;
    assert.equal(before.knownEmpty, true, 'setup: composer starts known-empty');
    appendExactCapsuleAck(harness);
    for (let i = 0; i < 50; i += 1) {
      harness.childOutput(`\u001b[2K> thinking about step ${i}...\r\n`);
      harness.childOutput('[supervisor] composer already holds OTHER content\r\n');
      harness.childOutput('\u001b[?2004h\u001b[200~pasted-looking text\u001b[201~\r\n');
    }
    assert.deepEqual(harness.runner.snapshot().input, before, 'child output must not change a single tracker field');
    harness.drive();
    harness.flushControl();
    harness.fireEnter();
    harness.drive();
    harness.drive();
    assert.equal(clearTextWrites(harness), 1, 'exactly one /clear');
    assert.equal(clearIntentEventCount(harness), 1);
  } finally {
    harness.cleanup();
  }
});

test('78b an operator byte interrupting the prepared clear after the ack halts at the named hold', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    appendExactCapsuleAck(harness);
    harness.drive();
    assert.equal(harness.runner.phase, 'prepared', 'setup: ack observed, clear prepared, commit pending');
    harness.operator('draft');
    for (let i = 0; i < 5; i += 1) { harness.drive(); harness.flushControl(); }

    assert.equal(clearTextWrites(harness), 0, 'never a clear');
    assert.equal(Buffer.concat(harness.pty.writes).toString(), 'draft', 'queued operator input preserved');
    assert.equal(harness.runner.lastReason.code, HOLD_CLEAR_STALLED_AFTER_ACK);
    assert.equal(harness.runner.automationEnabled, false);
    assert.equal(harness.ackHeld(), true, 'the ack stays unspent');
    assert.ok(harness.runner.events.some((event) => event.name === 'hold-entered'));

    const notices = allRunnerLogs(harness).split('\n')
      .filter((line) => line.includes(HOLD_CLEAR_STALLED_AFTER_ACK) && line.includes('notice'));
    assert.equal(notices.length, 1, 'exactly one loud notice');
    assert.match(notices[0], /operator-interleave-after-ack/);
    for (const field of OWNERSHIP_FIELDS) assert.match(notices[0], new RegExp(field), `notice carries ${field}`);
    // Taken before the hold released and the queue flushed.
    assert.match(notices[0], /"inputHold":true/);
    assert.match(notices[0], /"queuedChunks":1/);
    assert.equal(harness.stderr.writes.length, 0, 'never on the operator screen');
    // The hold line is the only notice: no "retrying each tick" refusal line.
    assert.doesNotMatch(allRunnerLogs(harness), /AUTO-CLEAR REFUSED \(operator-interleave\)/);
    assert.doesNotMatch(allRunnerLogs(harness), /EVENT submission-refused[^\n]*operator-interleave/);
    // Item 3: the disable event keeps the reason inside its 1200-char bound.
    const disabled = allRunnerLogs(harness).split('\n')
      .find((l) => l.includes('EVENT automation-disabled') && l.includes(HOLD_CLEAR_STALLED_AFTER_ACK));
    assert.match(disabled, /operator-interleave-after-ack/);
  } finally {
    harness.cleanup();
  }
});

test('78e every refusal after the ack carries the ownership snapshot, ownership first', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    harness.operator('typed');
    appendExactCapsuleAck(harness);
    harness.setGuard('sessionBinding', 'stale');
    harness.drive();
    harness.setGuard('stopIdle', 'missing');
    harness.drive();
    const log = allRunnerLogs(harness);
    const lines = log.split('\n').filter((line) => line.includes('EVENT submission-refused')
      || line.includes('AUTO-CLEAR REFUSED'));
    assert.ok(lines.length >= 2, 'setup: post-ack refusals were logged');
    for (const line of lines) {
      for (const field of OWNERSHIP_FIELDS) assert.match(line, new RegExp(field), `${field} missing from: ${line.slice(0, 200)}`);
    }
    // A long reason cannot push the snapshot out of the bounded line.
    harness.runner._noteSubmissionRefusal('synthetic-long', { big: 'y'.repeat(3000) });
    const long = allRunnerLogs(harness).split('\n')
      .find((l) => l.includes('EVENT submission-refused') && l.includes('synthetic-long'));
    assert.match(long, /knownEmpty/);

    // Before the ack a refusal stays as lean as it was.
    const lean = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      lean.primeAuthorized();
      lean.revokeAck('no-ack-this-cycle');
      lean.drive();
      const leanLog = allRunnerLogs(lean);
      assert.match(leanLog, /runner-capsule-not-acked/);
      assert.doesNotMatch(leanLog, /composerMayHoldControlText/);
    } finally {
      lean.cleanup();
    }
  } finally {
    harness.cleanup();
  }
});

test('78d the transport duplicate-clear refusal is logged with the snapshot and spends no second clear', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    harness.fireEnter();
    assert.equal(harness.forceDuplicateAttempt().code, 'EDUPLICATE_CLEAR');
    assert.equal(clearTextWrites(harness), 1, 'one ack, one clear');
    const line = allRunnerLogs(harness).split('\n')
      .find((l) => l.includes('EVENT submission-refused') && l.includes('EDUPLICATE_CLEAR'));
    assert.ok(line, 'the duplicate refusal is visible');
    assert.match(line, /knownEmpty/);
  } finally {
    harness.cleanup();
  }
});

test('78f the first post-ack refusal prints with the snapshot even when its code matches a pre-ack one', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    harness.setGuard('sessionBinding', 'stale');
    harness.drive();
    appendExactCapsuleAck(harness);
    harness.drive();
    const lines = allRunnerLogs(harness).split('\n')
      .filter((l) => l.includes('EVENT submission-refused') && /session|binding|boot/.test(l));
    assert.equal(lines.length, 2, 'the same code printed again once the ack was observed');
    assert.doesNotMatch(lines[0], /knownEmpty/);
    assert.match(lines[1], /knownEmpty/);
  } finally {
    harness.cleanup();
  }
});

test('78g a failing queued-input flush cannot overwrite the hold as the last reason', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    primeForTranscriptAck(harness);
    appendExactCapsuleAck(harness);
    harness.drive();
    assert.equal(harness.runner.phase, 'prepared');
    harness.pty.failWritesRemaining = 1_000_000;
    harness.operator('draft');
    assert.equal(harness.runner.lastReason.code, HOLD_CLEAR_STALLED_AFTER_ACK);
    assert.match(allRunnerLogs(harness), /queued-input-release-failed|queued input held/, 'the flush failure is still logged');
  } finally {
    harness.cleanup();
  }
});

test('78h disabling automation clears the spent-ack latch', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.primeAuthorized();
    harness.attemptAutomaticClear();
    harness.flushControl();
    assert.equal(harness.runner.ackSpentThisCycle, true, 'setup: the ack was spent');
    harness.runner._disableAutomation('test-disable', null);
    assert.equal(harness.runner.ackSpentThisCycle, false);
  } finally {
    harness.cleanup();
  }
});

// ===========================================================================
// #91 / #90 — THE ACKNOWLEDGEMENT LIFECYCLE.
//
// THE INVARIANT UNDER TEST: an acknowledgement authorizes only its own
// session/request/cycle, and it is invalidated when that cycle ends unspent.
//
// #91 (measured): the runner latched `capsuleAckSeen = true` on sight and the
// ONLY thing that ever cleared it was spending it on a /clear. The transport
// abandons cycles in several places and told the runner nothing: the narrow
// path (beginClearSubmission on a below-threshold reading -> idle +
// ECLEAR_PRESSURE_DROPPED) and the wide one (_gatePressure, reached from
// `pressure`, `checkpoint-requested` AND `checkpoint-confirmed`, which logged
// nothing at all). A surviving latch then SKIPPED the next cycle's capsule
// request -- the request gate asked `!capsuleAckSeen` -- and the clear gate
// asked only `capsuleAckSeen !== true`. Measured consequence: one capsule
// request across two distinct cycles, then a /clear on the first cycle's ack.
//
// #90 shape 1 (measured): across a relaunch the runner had no boundary of its
// own, so it seeded the forward-only ack scan from the stop-writer record's
// `offset` -- which stop-capsule-writer.mjs captures at Stop-hook time, AFTER
// the ack. The ack on disk was invisible and the request was re-injected.
//
// #90 shape 2 (filed on the issue): when the first tick's checkpoint
// observable is already satisfied the transport walks `checkpoint-requested ->
// checkpoint-confirmed` inside that one tick, so a guard keyed on the
// POST-transition state never ran, and the runner parked on
// runner-capsule-not-acked {cycle_id:null} for the life of the process.
//
// FAIL-FIRST DISCIPLINE. Every vector below is written so its SETUP is
// expressible against the pre-fix build (through the version-tolerant readers
// on the harness) and so the first assertion that goes red there is a
// BEHAVIOURAL one -- a clear that should not have been written, a capsule
// request that should have been, an ack that should not have been seen -- not
// merely the absence of a new field. The two same-cycle HOLD vectors are the
// stated exception: their behavioural half was already correct before the fix
// (a hold never cleared the boolean either), so what goes red there is the
// identity binding itself, which is the whole repair for those paths.
// ===========================================================================

const ABOVE_THRESHOLD = Object.freeze({ pct: 90, fresh: true, state: 'ok' });
const BELOW_THRESHOLD = Object.freeze({ pct: 10, fresh: true, state: 'ok' });
const TELEMETRY_MISSING = Object.freeze({ pct: null, fresh: false, state: 'missing' });
// A stale reading WITH a number is accepted by the monotonic-stale rule, so a
// telemetry-stale hold needs a reading with no usable pct.
const TELEMETRY_STALE = Object.freeze({ pct: null, fresh: false, state: 'stale' });

function setPressure(harness, observation) {
  // defineProperty, not assignment: pressureDropsAfter installs a getter and a
  // later plain assignment to it would throw in strict mode.
  Object.defineProperty(harness.fixture, 'pressure', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { ...observation },
  });
}

// A reading that is above threshold for the first `aboveReads` observations and
// below it afterwards: the live shape of a reading that drops BETWEEN the
// core's own gate and the submission-time recheck, which is the only way to
// reach ECLEAR_PRESSURE_DROPPED.
function pressureDropsAfter(harness, aboveReads) {
  let reads = 0;
  Object.defineProperty(harness.fixture, 'pressure', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads <= aboveReads ? { ...ABOVE_THRESHOLD } : { ...BELOW_THRESHOLD };
    },
  });
  return () => reads;
}

function ackObservedCount(harness) {
  return harness.events('capsule-ack-observed').length;
}

function ackInvalidations(harness) {
  return harness.events('capsule-ack-invalidated').map((event) => event.detail);
}

function transcriptSize(harness) {
  return fs.statSync(harness.fixture.transcriptPath).size;
}

// Transcript growth big enough to break the checkpoint tail arithmetic, which
// is what a real capsule run does (~15-22k measured live).
function appendCapsuleRunNoise(harness) {
  fs.appendFileSync(
    harness.fixture.transcriptPath,
    `\n{"type":"assistant","message":{"content":[{"type":"text","text":"${'c'.repeat(CHECKPOINT_TAIL_TOLERANCE_BYTES + 64)}"}]}}\n`,
  );
}

// Drive one cycle from idle up to `checkpoint-requested` with the capsule
// request written, exactly as the production tick path does it. Returns the
// cycle_id the evidence must bind to.
function driveToRequestedWithRequest(harness) {
  assert.equal(harness.drive().state.state, 'pressure');
  const cycleId = harness.core.state.cycle_id;
  assert.ok(cycleId, 'the cycle must have an identity');
  assert.equal(harness.drive().state.state, 'checkpoint-requested');
  assert.equal(capsuleTextWriteCount(harness), 1,
    'setup: the cycle got its one capsule request');
  assert.equal(harness.ackWindowOpen(), true,
    'setup: an ack window is open for the cycle that asked');
  return cycleId;
}

// ---------------------------------------------------------------------------
// #91 — every abandonment path. Each leg asserts the SAME two repairs:
//   (1) the dead cycle's ack cannot authorize the next cycle's clear, and
//   (2) the next cycle gets its OWN capsule request, because the gate is no
//       longer short-circuited by a stale latch.
// Pre-fix each leg produced one request across two cycles and a clear on the
// first cycle's ack.
// ---------------------------------------------------------------------------

function assertNextCycleEarnsItsOwnClear(harness, deadCycleId) {
  // A fresh cycle: later clock, so its identity is genuinely its own.
  harness.fixture.clock.advance(60_000);
  setPressure(harness, ABOVE_THRESHOLD);
  assert.equal(harness.drive().state.state, 'pressure');
  const nextCycleId = harness.core.state.cycle_id;
  assert.notEqual(nextCycleId, deadCycleId, 'setup: the new cycle is a different cycle');
  assert.equal(harness.ackHeld(), false,
    'the abandoned cycle ack must not be held into the new cycle');

  const requestsBefore = capsuleTextWriteCount(harness);
  assert.equal(harness.drive().state.state, 'checkpoint-requested');
  assert.equal(capsuleTextWriteCount(harness), requestsBefore + 1,
    'the new cycle must get its OWN capsule request -- pre-fix the surviving latch skipped it');

  harness.drive();
  assert.equal(clearTextWrites(harness), 0,
    'no clear may be written for a cycle that has not acked -- pre-fix the dead ack authorized it');
  assert.equal(clearIntentEventCount(harness), 0, 'and no clear intent is minted');
  assert.equal(harness.snapshot().lastDecision?.code, 'runner-capsule-not-acked');

  // The new cycle earns its own clear by its own ack, and gets exactly one.
  appendExactCapsuleAck(harness);
  harness.drive();
  assert.equal(ackObservedCount(harness) > 0, true, 'the new cycle ack is observed');
  harness.flushControl();
  assert.equal(clearTextWrites(harness), 1, 'exactly one clear, authorized by the new cycle ack');
  for (let i = 0; i < 5; i += 1) harness.drive();
  assert.equal(clearTextWrites(harness), 1, 'and no second clear');
  // Mechanism, after the behaviour: the evidence names the cycle that earned it.
  assert.equal(harness.runner.capsuleAckSpent?.cycle_id, nextCycleId,
    'the spend is recorded against the new cycle, by identity');
  return nextCycleId;
}

test('91a WIDE abandonment from `pressure`: an unspent ack dies with its cycle and cannot authorize the next one', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.drive().state.state, 'pressure');
    const dead = harness.core.state.cycle_id;
    // A capsule the operator ran by hand inside this cycle: a window open on
    // the cycle makes its ack real evidence FOR THIS CYCLE.
    harness.armAckWatch(dead);
    appendExactCapsuleAck(harness);
    assert.equal(harness.runner._checkCapsuleAck(), true, 'setup: the hand-run capsule acks');
    assert.equal(harness.ackHeld(), true, 'setup: the cycle holds an ack');

    // The wide abandonment: a below-threshold reading at `pressure`.
    setPressure(harness, BELOW_THRESHOLD);
    const abandoning = harness.drive();
    assert.equal(abandoning.state.state, 'idle', 'the transport abandons the cycle');
    assert.equal(harness.ackHeld(), false, 'the unspent ack is invalidated with its cycle');

    assertNextCycleEarnsItsOwnClear(harness, dead);

    // Mechanism, after the behaviour: the abandonment and the invalidation are
    // both named, so an operator can grep what happened.
    assert.equal(abandoning.abandoned_cycle_id, dead, 'the transport names which cycle it abandoned');
    assert.deepEqual(
      ackInvalidations(harness)
        .filter((d) => d.cycle_id === dead)
        .map((d) => [d.reason, d.cycle_id, d.acked]),
      [['cycle-ended', dead, true]],
      'and the runner names the ack that died unspent',
    );
  } finally {
    harness.cleanup();
  }
});

test('91b WIDE abandonment from `checkpoint-requested`, with the scan running LATER IN THE SAME TICK', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = driveToRequestedWithRequest(harness);

    // The ack lands on disk and is NOT yet scanned: the window is open and has
    // unread bytes in it. The next tick abandons the cycle inside
    // transport.tick() and then reaches the scan -- the exact ordering that
    // makes clearing a boolean insufficient.
    appendExactCapsuleAck(harness);
    if (harness.runner.capsuleAckWatch) harness.runner.capsuleAckWatch.drained = false;
    assert.equal(ackObservedCount(harness), 0, 'setup: the ack is on disk and unscanned');

    setPressure(harness, BELOW_THRESHOLD);
    const abandoning = harness.drive();
    assert.equal(abandoning.state.state, 'idle');
    assert.equal(ackObservedCount(harness), 0,
      'the scan that runs after the abandonment in this same tick must have NO window to latch into');
    assert.equal(harness.ackWindowOpen(), false, 'and the window is closed, not merely emptied');
    assert.equal(harness.ackHeld(), false);

    assertNextCycleEarnsItsOwnClear(harness, dead);
    assert.equal(abandoning.abandoned_cycle_id, dead);
  } finally {
    harness.cleanup();
  }
});

test('91c WIDE abandonment from `checkpoint-confirmed`: the ack is already held and still dies with its cycle', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = driveToRequestedWithRequest(harness);
    // The tick that ENDS in checkpoint-confirmed returns the submission
    // refusal, which carries no state: read the cycle from the core.
    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-confirmed');
    // The seat acks; the scan observes it without the tick that would clear.
    appendExactCapsuleAck(harness);
    assert.equal(harness.runner._checkCapsuleAck(), true, 'setup: the ack is held at checkpoint-confirmed');

    setPressure(harness, BELOW_THRESHOLD);
    const abandoning = harness.drive();
    assert.equal(abandoning.state.state, 'idle', 'a below-threshold reading abandons a CONFIRMED cycle too');
    assert.equal(clearTextWrites(harness), 0, 'the abandoned cycle writes no clear');
    assert.equal(harness.ackHeld(), false,
      'the unspent ack of a confirmed-then-abandoned cycle is invalidated with it');

    assertNextCycleEarnsItsOwnClear(harness, dead);
    assert.equal(abandoning.abandoned_cycle_id, dead);
  } finally {
    harness.cleanup();
  }
});

test('91d NARROW abandonment: ECLEAR_PRESSURE_DROPPED drops the cycle inside the refusal, and its ack dies there', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = driveToRequestedWithRequest(harness);
    harness.drive();
    assert.equal(harness.core.state.state, 'checkpoint-confirmed');
    appendExactCapsuleAck(harness);
    assert.equal(harness.runner._checkCapsuleAck(), true, 'setup: this cycle holds its ack');

    // Above threshold for the core's own gate, below it for the
    // submission-time recheck inside beginClearSubmission.
    const reads = pressureDropsAfter(harness, 1);
    harness.drive();
    assert.ok(reads() >= 2, 'setup: both the gate and the submission recheck read the observable');
    assert.equal(harness.snapshot().lastDecision?.code, 'ECLEAR_PRESSURE_DROPPED',
      'the refusal is the narrow path, by name');
    assert.equal(harness.core.state.state, 'idle', 'which abandoned the cycle inside the throw');
    assert.equal(clearTextWrites(harness), 0, 'nothing was written');
    assert.equal(harness.ackHeld(), false,
      'the ack does not outlive the cycle even for the rest of this tick');

    setPressure(harness, ABOVE_THRESHOLD);
    assertNextCycleEarnsItsOwnClear(harness, dead);
    assert.deepEqual(
      ackInvalidations(harness)
        .filter((d) => d.cycle_id === dead)
        .map((d) => [d.reason, d.cycle_id, d.acked]),
      [['cycle-ended', dead, true]],
    );
  } finally {
    harness.cleanup();
  }
});

test('91e a LATE ack from an abandoned request authorizes nothing, in that cycle or the next', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = driveToRequestedWithRequest(harness);

    // The cycle is abandoned while the capsule is still being written.
    setPressure(harness, BELOW_THRESHOLD);
    assert.equal(harness.drive().state.state, 'idle');
    assert.equal(harness.ackWindowOpen(), false, 'the abandoned request has no window');

    // The seat finishes the capsule and acks -- for a request nobody is owed.
    appendExactCapsuleAck(harness);
    for (let i = 0; i < 10; i += 1) harness.drive();
    assert.equal(ackObservedCount(harness), 0, 'a late ack for an abandoned request is not evidence');
    assert.equal(harness.ackHeld(), false);
    assert.equal(clearTextWrites(harness), 0);

    // And the NEXT cycle may not adopt it either: its window opens past it.
    harness.fixture.clock.advance(60_000);
    setPressure(harness, ABOVE_THRESHOLD);
    assert.equal(harness.drive().state.state, 'pressure');
    const next = harness.core.state.cycle_id;
    assert.notEqual(next, dead);
    assert.ok(
      harness.ackWindowFrom() === null || harness.ackWindowFrom() >= transcriptSize(harness),
      'the new cycle window opens at or past the late ack: forward-only, never a backward sweep',
    );
    for (let i = 0; i < 3 && harness.core.state.state !== 'checkpoint-confirmed'; i += 1) harness.drive();
    assert.equal(ackObservedCount(harness), 0, 'the late ack is still not evidence for the new cycle');
    assert.equal(clearTextWrites(harness), 0, 'and it authorizes no clear');
    assert.equal(capsuleTextWriteCount(harness), 2, 'the new cycle asked for its own capsule');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A HOLD that KEEPS the cycle is not an abandonment. Valid same-cycle evidence
// must survive it, and a window open on the cycle must keep collecting.
//
// STATED: the behavioural half of these two vectors was already green pre-fix
// (a hold never cleared the boolean either). What goes red pre-fix is the
// identity of the preserved evidence -- that it is bound to the cycle that is
// still alive, which is what makes "preserved" mean something.
// ---------------------------------------------------------------------------

test('91f same-cycle HOLD recovery: telemetry holds keep the cycle, so they keep its ack window and its evidence', async (t) => {
  for (const [label, observation] of [
    ['telemetry-missing', TELEMETRY_MISSING],
    ['telemetry-stale', TELEMETRY_STALE],
  ]) {
    await t.test(label, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        const cycleId = driveToRequestedWithRequest(harness);
        // The ack lands, then telemetry drops out before it is scanned.
        appendExactCapsuleAck(harness);
        setPressure(harness, observation);
        const held = harness.drive();
        assert.equal(held.state.state, `HOLD:${label}`, 'the cycle HOLDS');
        assert.equal(held.state.cycle_id, cycleId, 'and keeps its identity');
        assert.deepEqual(ackInvalidations(harness), [],
          'a hold is not an abandonment: nothing may be invalidated');
        assert.equal(ackObservedCount(harness), 1,
          'the window stayed open through the hold and collected the ack');
        assert.equal(harness.runner.capsuleAck?.cycle_id, cycleId,
          'and the evidence is bound to the cycle that is still alive');

        // Telemetry returns: the same cycle resumes and its own ack clears it.
        setPressure(harness, ABOVE_THRESHOLD);
        for (let i = 0; i < 4 && harness.runner.phase !== 'prepared'; i += 1) harness.drive();
        assert.equal(harness.core.state.cycle_id, cycleId, 'still the same cycle');
        harness.flushControl();
        assert.equal(clearTextWrites(harness), 1, 'exactly one clear, on its own cycle ack');
        assert.equal(capsuleTextWriteCount(harness), 1,
          'and exactly one capsule request for the whole cycle: the hold never re-asked');
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('91g same-cycle HOLD recovery: HOLD:checkpoint-transcript-short keeps the window open, and the ack it collects lifts it', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const cycleId = driveToRequestedWithRequest(harness);
    // The capsule run itself appends past the tail budget -- the measured loop
    // (each capsule run re-broke the very check it existed to satisfy).
    appendCapsuleRunNoise(harness);
    const held = harness.drive();
    assert.equal(held.state.state, 'HOLD:checkpoint-transcript-short');
    assert.equal(held.state.cycle_id, cycleId);
    assert.equal(harness.ackWindowOpen(), true,
      'the window survives a same-cycle checkpoint hold');
    assert.deepEqual(ackInvalidations(harness), []);

    // The seat acks INSIDE the hold. That is this cycle's own evidence.
    appendExactCapsuleAck(harness);
    harness.drive();
    assert.equal(ackObservedCount(harness), 1, 'the ack is collected during the hold');
    assert.equal(harness.runner.capsuleAck?.cycle_id, cycleId,
      'bound to the held cycle, which is still the live one');

    for (let i = 0; i < 4 && harness.runner.phase !== 'prepared'; i += 1) harness.drive();
    assert.equal(harness.core.state.cycle_id, cycleId);
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'the ack supersedes the tail arithmetic: one clear');
    assert.equal(capsuleTextWriteCount(harness), 1, 'one request for the cycle, no re-injection');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #90 shape 1 — the relaunch restore. The ack is on disk BEFORE the Stop
// offset, which is exactly where the replaced code started reading.
// ---------------------------------------------------------------------------

test('90a shape 1, `checkpoint-requested` restore: an ack on disk before the Stop offset is recovered, not re-requested', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.drive().state.state, 'pressure');
    const cycleId = harness.core.state.cycle_id;
    const atCycleStart = transcriptSize(harness);

    // The seat acks, and the Stop hook then records the transcript size -- PAST
    // the ack. The process dies before the ack is ever scanned.
    appendExactCapsuleAck(harness);
    const stopOffset = harness.writeStopRecordAtTranscriptEnd();
    assert.ok(stopOffset > atCycleStart,
      'setup: the Stop offset sits past the ack while the cycle opened before it -- that gap IS the defect');

    harness.relaunch();
    const first = harness.drive();
    assert.equal(first.state.state, 'checkpoint-requested', 'the relaunch tick walks pressure -> requested');
    assert.equal(first.state.cycle_id, cycleId, 'the same cycle, carried on disk');
    assert.equal(ackObservedCount(harness), 1,
      'the ack already on disk is seen -- pre-fix the stop-writer seed started past it');
    assert.equal(capsuleTextWriteCount(harness), 0,
      'and nothing is re-injected: that re-injection loop is what #90 measured');

    harness.drive();
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'the recovered ack buys exactly one clear');
    assert.equal(capsuleTextWriteCount(harness), 0, 'still no re-injection');

    // Mechanism, after the behaviour: the window came from the cycle's own
    // persisted boundary, which is the transcript offset at cycle start.
    const restored = harness.events('capsule-ack-watch-restored');
    assert.equal(restored.length, 1, 'the window is recovered from the cycle boundary');
    assert.equal(restored[0].detail?.from, atCycleStart,
      'and it opens exactly where the cycle opened, not at the Stop offset');
  } finally {
    harness.cleanup();
  }
});

test('90b shape 1, `HOLD:*` restore: the window is recovered from the cycle boundary and the ack on disk lifts the hold', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.drive().state.state, 'pressure');
    const cycleId = harness.core.state.cycle_id;
    const atCycleStart = transcriptSize(harness);
    assert.equal(harness.drive().state.state, 'checkpoint-requested');
    assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the cycle got its one request');

    // The capsule run breaks the tail budget: the cycle holds.
    appendCapsuleRunNoise(harness);
    assert.equal(harness.drive().state.state, 'HOLD:checkpoint-transcript-short');

    // The seat acks; the Stop hook records the size past it; more conversation
    // follows, so the hold is still live when the next process starts.
    appendExactCapsuleAck(harness);
    const stopOffset = harness.writeStopRecordAtTranscriptEnd();
    appendCapsuleRunNoise(harness);
    assert.ok(stopOffset > atCycleStart, 'setup: the Stop offset is past both the cycle start and the ack');

    harness.relaunch();
    const first = harness.drive();
    assert.equal(first.state.state, 'HOLD:checkpoint-transcript-short',
      'the hold is still live on the first tick -- the HOLD:* restore shape');
    assert.equal(first.state.cycle_id, cycleId);
    assert.equal(ackObservedCount(harness), 1,
      'the ack on disk is recovered -- pre-fix it sat behind the stop-writer seed and the cycle held forever');
    assert.equal(capsuleTextWriteCount(harness), 0, 'no re-injection');

    for (let i = 0; i < 4 && harness.runner.phase !== 'prepared'; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1,
      'the recovered ack supersedes the tail arithmetic and buys one clear');

    const restored = harness.events('capsule-ack-watch-restored');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].detail?.from, atCycleStart);
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #90 shape 2 — the first tick lands in `checkpoint-confirmed` because the
// transport walked two states inside it. Must not park silently.
// ---------------------------------------------------------------------------

test('90c shape 2, first-tick `checkpoint-confirmed` with the ack on disk: recovered, not parked', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(harness.drive().state.state, 'pressure');
    const cycleId = harness.core.state.cycle_id;
    const atCycleStart = transcriptSize(harness);
    assert.equal(harness.drive().state.state, 'checkpoint-requested');
    appendExactCapsuleAck(harness);
    harness.writeStopRecordAtTranscriptEnd();

    harness.relaunch();
    // The checkpoint observable is already satisfied, so this ONE tick walks
    // checkpoint-requested -> checkpoint-confirmed: the post-transition state a
    // state-keyed guard can never see.
    harness.drive();
    assert.equal(harness.runner.lastCoreResult?.state?.state, 'checkpoint-confirmed',
      'setup: the transport walked requested -> confirmed inside one tick');
    assert.equal(harness.runner.lastCoreResult?.state?.cycle_id, cycleId);
    assert.equal(ackObservedCount(harness), 1,
      'the ack on disk is recovered in that same tick -- pre-fix nothing initialized and nothing scanned');
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1,
      'one clear -- pre-fix this parked at runner-capsule-not-acked {cycle_id:null} until relaunch');
    assert.equal(capsuleTextWriteCount(harness), 0, 'with no re-injection');

    const restored = harness.events('capsule-ack-watch-restored');
    assert.equal(restored.length, 1,
      'initialization is keyed on cycle identity, so it ran despite the post-transition state');
    assert.equal(restored[0].detail?.from, atCycleStart);
  } finally {
    harness.cleanup();
  }
});

test('90d shape 2, first-tick `checkpoint-confirmed` with NO ack anywhere: a named visible re-request, never an indefinite park', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const cycleId = driveToRequestedWithRequest(harness);
    // No ack is ever written. The previous process asked; this one cannot know
    // that, and the seat is not going to answer a request it never saw.
    harness.writeStopRecordAtTranscriptEnd();

    harness.relaunch();
    harness.drive();
    assert.equal(harness.runner.lastCoreResult?.state?.state, 'checkpoint-confirmed');
    assert.equal(harness.runner.lastCoreResult?.state?.cycle_id, cycleId);
    assert.equal(ackObservedCount(harness), 0, 'there is nothing on disk to recover');
    assert.equal(capsuleTextWriteCount(harness), 1,
      'the cycle ASKS for its capsule rather than waiting forever -- pre-fix this wrote nothing and parked');
    const decision = harness.snapshot().lastDecision;
    assert.equal(decision?.code, 'runner-capsule-not-acked');
    assert.equal(decision?.detail?.state_cycle_id, cycleId,
      'the refusal names the cycle, never {cycle_id:null}');

    // Bounded: one request per cycle, however many ticks follow.
    for (let i = 0; i < 60; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'the cycle_id latch still bounds it to one');
    assert.equal(clearTextWrites(harness), 0, 'and no clear until the seat answers');

    appendExactCapsuleAck(harness);
    harness.drive();
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'the answer buys exactly one clear');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Boundary provenance. Legacy, absent, malformed, foreign-session, stale-cycle
// and ahead-of-transcript boundaries must each fail VISIBLY by name, open NO
// window (so no unowned bytes are ever read as evidence), and take the existing
// safe re-request path. None may authorize a clear and none may park.
// ---------------------------------------------------------------------------

test('90e boundary provenance: legacy, absent, malformed, foreign-session, stale-cycle and ahead-of-transcript all fail visibly and safely', async (t) => {
  const cases = [
    ['legacy (a seat upgrading from a build without the field)',
      (state) => { delete state.ack_boundary; }, 'ack-boundary-legacy'],
    ['absent (the transport could not capture one)',
      (state) => { state.ack_boundary = null; }, 'ack-boundary-absent'],
    ['malformed',
      (state) => { state.ack_boundary = { ...state.ack_boundary, transcript_offset: 'not-a-number' }; },
      'ack-boundary-malformed'],
    ['malformed, root not an object',
      (state) => { state.ack_boundary = 'nope'; }, 'ack-boundary-malformed'],
    ['foreign session',
      (state) => { state.ack_boundary = { ...state.ack_boundary, session_id: 'session-somebody-else' }; },
      'ack-boundary-session-mismatch'],
    ['an older cycle',
      (state) => { state.ack_boundary = { ...state.ack_boundary, cycle_id: 'cycle-from-last-night' }; },
      'ack-boundary-cycle-mismatch'],
    ['ahead of the transcript (truncated or rotated)',
      (state, harness) => {
        state.ack_boundary = {
          ...state.ack_boundary,
          transcript_offset: transcriptSize(harness) + 10_000,
        };
      },
      'ack-boundary-ahead-of-transcript'],
  ];

  for (const [label, corrupt, expectedCode] of cases) {
    await t.test(label, () => {
      const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
      try {
        const cycleId = driveToRequestedWithRequest(harness);
        // An ack IS on disk: a VALID boundary would find it, so if any of these
        // cases silently authorized a clear this is where it would show.
        appendExactCapsuleAck(harness);
        harness.writeStopRecordAtTranscriptEnd();

        const state = harness.cycleState();
        corrupt(state, harness);
        harness.writeCycleState(state);

        harness.relaunch();
        harness.drive();

        // SAFE: nothing unowned is read as evidence and nothing is authorized.
        assert.equal(ackObservedCount(harness), 0,
          `${label}: no window means no unowned bytes are read as evidence`);
        assert.equal(harness.ackHeld(), false);
        assert.equal(clearTextWrites(harness), 0, `${label}: nothing may authorize a clear`);
        assert.equal(clearIntentEventCount(harness), 0);

        // NOT A PARK: the capsule is re-requested once and the refusal names
        // the cycle it waits on.
        assert.equal(capsuleTextWriteCount(harness), 1, `${label}: the capsule is re-requested`);
        assert.equal(harness.snapshot().lastDecision?.code, 'runner-capsule-not-acked');
        assert.equal(harness.snapshot().lastDecision?.detail?.state_cycle_id, cycleId);
        for (let i = 0; i < 30; i += 1) harness.drive();
        assert.equal(capsuleTextWriteCount(harness), 1, `${label}: still exactly one request`);

        // The fresh ack for this cycle, written after the re-request, clears it.
        appendExactCapsuleAck(harness);
        harness.drive();
        harness.flushControl();
        assert.equal(clearTextWrites(harness), 1, `${label}: recovery ends in exactly one clear`);

        // VISIBLE: named once, by cause, in the events and in the seat's own log.
        const unrecoverable = harness.events('capsule-ack-window-unrecoverable');
        assert.equal(unrecoverable.length, 1,
          `${label}: the failure must be one named event, not one per tick`);
        assert.equal(unrecoverable[0].detail?.code, expectedCode, `${label}: named by cause`);
        assert.equal(unrecoverable[0].detail?.cycle_id, cycleId);
        // REWORDED DELIBERATELY (#90/#91 review, R2). This event fires when the
        // boundary fails -- before any gate has run -- so it may only state the
        // OWING. Claiming `capsule-re-requested` here was false on the measured
        // specimen where nothing was ever requested. The claim that a request
        // went out belongs to the event the writer emits, once it has.
        assert.equal(unrecoverable[0].detail?.recovery, 'capsule-request-pending');
        assert.equal(harness.events('capsule-ack-recovery-requested').length, 1,
          `${label}: and the request that DID go out is named separately, once`);
        assert.equal(
          harness.events('capsule-ack-recovery-requested')[0].detail?.cycle_id, cycleId);
        assert.match(allRunnerLogs(harness), new RegExp(expectedCode),
          `${label}: and greppable from the seat's own files`);
      } finally {
        harness.cleanup();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// POSITIVE CONTROL. The whole path, nothing poked: pressure -> request -> the
// seat's own ack -> exactly one clear, and the ack is spent once and cannot be
// re-latched afterwards.
// ---------------------------------------------------------------------------

test('91h positive control: a valid fresh ack for the live cycle yields exactly one clear, and cannot be re-latched after the spend', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const cycleId = driveToRequestedWithRequest(harness);
    appendExactCapsuleAck(harness);
    harness.drive();
    assert.equal(harness.runner.phase, 'prepared');
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1);
    assert.equal(clearIntentEventCount(harness), 1);
    assert.equal(harness.events('capsule-ack-spent').length, 1, 'spent exactly once');
    assert.equal(harness.ackHeld(), false, 'and the evidence is gone once spent');

    // SINGLE SPENDING, against the thing that made it fragile. The literal is
    // still on disk. First: the production opener refuses a spent cycle outright.
    harness.armAckWatch(cycleId);
    assert.equal(harness.ackWindowOpen(), false, 'a spent cycle gets no evidence window at all');
    // Second, and this is the property the boolean could not carry: even a
    // window forced back BEHIND the literal may not re-latch it, because what
    // refuses is the spend IDENTITY and not the position of the cursor.
    harness.forceAckWindow(cycleId, 0);
    harness.runner._checkCapsuleAck();
    assert.equal(harness.ackHeld(), false,
      're-reading the same literal may not buy a second clear');
    assert.equal(harness.events('capsule-ack-already-spent').length, 1,
      'and the refusal to re-latch is itself a named event');
    for (let i = 0; i < 10; i += 1) harness.drive();
    assert.equal(clearTextWrites(harness), 1, 'exactly one clear for the cycle, forever');
    assert.equal(capsuleTextWriteCount(harness), 1, 'and exactly one capsule request');
    assert.equal(harness.runner.capsuleAckSpent?.cycle_id, cycleId,
      'the spend is recorded by identity, which is what refuses the second latch');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Non-author review of 78a2577. Two defects the 198 vectors above could not
// see, each pinned here so the next refactor cannot repeat them.
// ---------------------------------------------------------------------------

// F1. THE PRODUCTION FIRST-BIND PATH. runPtySession builds the runner with a
// transportFactory and no transport, so _bindCurrentSession runs on the first
// tick of every real seat. It carried the pre-fix `_armCapsuleAckWatch()` call
// forward with no argument, which after the identity rewrite took the
// no-identity branch and emitted capsule-ack-watch-unidentified
// {cycle_id:null} into the events and the daemon log -- exactly one false
// alarm per launch, on the one event whose job is to say a window has no owner.
// Invisible to every other vector here, because they all inject `transport`.
//
// A session bind arms NO window: at that moment there is no cycle, so there is
// no identity a window could belong to. The window the cycle needs is opened
// from the cycle's own persisted boundary, later in the same tick.
test('F1 the production first-bind path arms no window and raises no false unowned-window alarm', () => {
  // Arm 1: the bind in isolation. It must leave the ack lifecycle exactly as
  // the constructor did -- no window, nothing named.
  const bare = new RunnerHarness({
    mode: 'managed', ptyLoad: 'ok', lockState: 'free', bindOnFirstTick: true,
  });
  try {
    assert.equal(bare.runner.transport, null,
      'setup: built the way production builds it -- factory, no injected transport');
    // _bindCurrentSession refuses a receipt that is not strictly newer than the
    // baseline, so advance the boot the way a real launch does.
    writeJson(bare.fixture.bootPath, {
      boot_sequence: 11,
      session_id: SESSION_ID,
      source: 'startup',
      observed_at: new Date(bare.fixture.clock.ms()).toISOString(),
    });
    assert.equal(bare.runner._bindCurrentSession().status, 'session-bound');
    assert.equal(bare.ackWindowOpen(), false,
      'binding a session arms no ack window: there is no cycle for one to belong to');
    assert.equal(bare.ackHeld(), false);
    assert.equal(bare.events('capsule-ack-watch-unidentified').length, 0,
      'and nothing is reported as unowned, because nothing was attempted');
  } finally {
    bare.cleanup();
  }

  // Arm 2: the whole first tick, as a seat takes it. The bind happens, the
  // cycle starts, and the only window that appears is the one the cycle's own
  // boundary opened -- never an unidentified one.
  const harness = new RunnerHarness({
    mode: 'managed', ptyLoad: 'ok', lockState: 'free', bindOnFirstTick: true,
  });
  try {
    writeJson(harness.fixture.bootPath, {
      boot_sequence: 11,
      session_id: SESSION_ID,
      source: 'startup',
      observed_at: new Date(harness.fixture.clock.ms()).toISOString(),
    });
    const first = harness.drive();
    assert.equal(harness.events('session-bound').length, 1, 'the first tick binds the session');
    assert.equal(first.state.state, 'pressure',
      'and carries on into the cycle in that same tick');

    assert.equal(harness.events('capsule-ack-watch-unidentified').length, 0,
      'a launch must not cry wolf on the unowned-window event -- MUST be red on 78a2577');
    assert.doesNotMatch(
      allRunnerLogs(harness), /capsule-ack-watch-unidentified/,
      'and it must not write that alarm to the daemon log either',
    );
    assert.equal(harness.runner.capsuleAckWatch?.cycle_id, harness.core.state.cycle_id,
      'the only window is the cycle-bound one the persisted boundary opened');
    assert.equal(harness.events('capsule-ack-watch-restored').length, 1,
      'and it is attributable to that boundary, not to the session bind');

    // 40 more ticks of an ordinary launch: still no false alarm.
    for (let i = 0; i < 40; i += 1) harness.drive();
    assert.equal(harness.events('capsule-ack-watch-unidentified').length, 0);
  } finally {
    harness.cleanup();
  }
});

// F2. "null, never 0" was true of the writer's comment and false of the
// reader's check. The reviewer rewrote a persisted boundary to 0 with an ack
// line sitting BEFORE the cycle's start: the window restored at from:0, the
// pre-cycle ack was observed, and one clear was written -- the precise
// stale-evidence shape #91 exists to reject. Offset 0 opens the window on the
// whole transcript, so it is refused on both sides now: the writer never
// persists one, and the reader names a 0 it is handed.
test('F2 a zero ack boundary is refused by name, and a pre-cycle ack behind it authorizes nothing', async (t) => {
  await t.test('a hostile zero in the persisted cycle cannot revive a pre-cycle ack', () => {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      // An ack from BEFORE this cycle existed. Its own cycle is long gone.
      appendExactCapsuleAck(harness);
      const preCycleAckEnd = transcriptSize(harness);
      assert.equal(harness.drive().state.state, 'pressure');
      const cycleId = harness.core.state.cycle_id;
      assert.ok(harness.cycleState().ack_boundary.transcript_offset >= preCycleAckEnd,
        'setup: the honest boundary opens PAST the stale ack');

      // The hostile rewrite: the one value that opens the window on everything.
      const state = harness.cycleState();
      state.ack_boundary = { ...state.ack_boundary, transcript_offset: 0 };
      harness.writeCycleState(state);

      harness.relaunch();
      harness.drive();

      assert.equal(ackObservedCount(harness), 0,
        'the pre-cycle ack must not be observed -- MUST be red on 78a2577, which accepted offset 0');
      assert.equal(harness.ackHeld(), false);
      // No window is opened ON the zero boundary. The window that does exist is
      // the one the re-requested capsule opened at the transcript's current
      // end, which sits past the stale ack -- forward-only, as it must be.
      assert.ok(harness.ackWindowFrom() >= preCycleAckEnd,
        `any window must sit past the pre-cycle ack, never at the zero boundary (got ${harness.ackWindowFrom()})`);
      for (let i = 0; i < 10; i += 1) harness.drive();
      assert.equal(clearTextWrites(harness), 0, 'and nothing authorizes a clear');
      assert.equal(clearIntentEventCount(harness), 0);

      // Safe recovery, named: the capsule is re-requested once.
      const unrecoverable = harness.events('capsule-ack-window-unrecoverable');
      assert.equal(unrecoverable.length, 1);
      assert.equal(unrecoverable[0].detail?.code, 'ack-boundary-malformed');
      assert.deepEqual(unrecoverable[0].detail?.detail, { field: 'transcript_offset' },
        'named down to the field, so an operator can see which value was refused');
      assert.equal(unrecoverable[0].detail?.cycle_id, cycleId);
      assert.equal(capsuleTextWriteCount(harness), 1, 'the capsule is re-requested, once');

      // And the cycle still earns its own clear the honest way.
      appendExactCapsuleAck(harness);
      harness.drive();
      harness.flushControl();
      assert.equal(clearTextWrites(harness), 1, 'exactly one clear, on an ack from inside the cycle');
    } finally {
      harness.cleanup();
    }
  });

  await t.test('the writer never persists a zero: an empty transcript yields ack-boundary-absent', () => {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      // The only case that can produce a genuine 0. Nothing can precede byte 0,
      // so the cost of refusing it is one re-requested capsule -- and the
      // contract stays true on the writer's side too.
      fs.writeFileSync(harness.fixture.transcriptPath, '');
      assert.equal(transcriptSize(harness), 0, 'setup: a zero-length transcript at cycle start');

      assert.equal(harness.drive().state.state, 'pressure');
      assert.equal(harness.cycleState().ack_boundary, null,
        'a zero offset is never persisted -- MUST be red on 78a2577, which persisted 0');
      assert.equal(harness.ackWindowOpen(), false);
      const unrecoverable = harness.events('capsule-ack-window-unrecoverable');
      assert.equal(unrecoverable.length, 1);
      assert.equal(unrecoverable[0].detail?.code, 'ack-boundary-absent',
        'and the reader names the absence rather than a malformation it did not see');
      assert.match(allRunnerLogs(harness), /ack-boundary-absent/);
    } finally {
      harness.cleanup();
    }
  });
});


// ===========================================================================
// NON-AUTHOR REVIEW OF 439e331 (GPT). Three defects the 26 vectors above could
// not see, each pinned here.
//
// R1 (HIGH). The WINDOW carried the identity; the RECORD did not. Whatever a
// scan found was attributed to `watch.cycle_id`, so a request the transport
// RETIRED while its answer was still outstanding came back inside the
// REPLACEMENT cycle's window and was labelled with the replacement's identity:
// request A goes out, A's cycle is abandoned, B opens, B's request is written,
// and A's delayed acknowledgement lands in B's window. B answered nothing, yet
// capsuleAck.cycle_id was B and the clear fired. 91e only proved the EOF
// boundary excludes bytes ALREADY on disk when the next window opened; it said
// nothing about an answer still in flight.
//
// R2 (MED). A restore with a legacy/absent/malformed boundary opens no window
// (deliberately, fail-safe) and marks the cycle as owing a fresh request. With
// the cycle sitting at a checkpoint HOLD that transcript growth genuinely
// justifies, the request gate admitted neither that state nor any other
// continuing checkpoint hold: no window, no request, and a hold that cannot
// lift without one. Measured 0 requests / null window for 50 ticks in all
// three boundary variants -- while the event claimed `capsule-re-requested`.
//
// R3 (MED). The drained-window guard was applied at `checkpoint-confirmed`
// only. A restore returning `checkpoint-requested` can hold a valid on-disk
// ack beyond the first bounded read: the first scan advances without reaching
// it, the unconditional arm writes another request, and the re-arm moves the
// cursor to EOF -- the valid ack ends up behind a forward-only cursor.
// ===========================================================================

// One bounded ack read. Mirrors CAPSULE_ACK_WINDOW_BYTES in pty-runner.mjs,
// which is module-private; the vectors below assert the BEHAVIOUR (a cursor
// still inside the window, an ack recovered on a later tick) rather than the
// constant, so a change there cannot make them silently vacuous.
const ACK_SCAN_WINDOW_BYTES = 262144;

// A restore window several bounded reads wide. Ordinary ~1 KiB assistant
// turns: every line is complete and well under one window, so nothing is
// skipped as oversize and the scan has to WALK the whole thing to reach what
// sits at the end of it.
// A long run of ordinary assistant conversation, used to push a restored ack
// window more than one bounded read deep.
//
// EACH LINE CARRIES THE IDENTITY FIELDS A REAL ASSISTANT RECORD CARRIES
// (#104): `message.id`, `requestId` and `apiBlockIndex`, measured present on
// every assistant record of both #104 captures, across two binary versions.
// The filler used to omit all three, which made 2.5 MiB of "conversation" that
// no real host would write, and which the outstanding-tool-call reader
// correctly refuses to treat as proof of anything (D23/D24: an unidentifiable
// assistant record cannot discharge calls a window never saw). Distinct ids per
// line, because this is a run of separate turns rather than one turn's blocks.
let oversizeRestoreSeq = 0;
function appendOversizeRestoreWindow(harness, totalBytes = ACK_SCAN_WINDOW_BYTES * 2 + 60_000) {
  const lines = [];
  let written = 0;
  while (written < totalBytes) {
    oversizeRestoreSeq += 1;
    const record = `{"type":"assistant","requestId":"req_filler_${oversizeRestoreSeq}",`
      + `"apiBlockIndex":0,"message":{"id":"msg_filler_${oversizeRestoreSeq}",`
      + `"content":[{"type":"text","text":"${'w'.repeat(900)}"}]}}`;
    lines.push(record);
    written += record.length + 1;
  }
  fs.appendFileSync(harness.fixture.transcriptPath, `\n${lines.join('\n')}\n`);
  return written;
}

// The host's own record of a capsule request reaching the seat: a "user"
// record carrying the command text, exactly as Claude Code records a slash
// command. This is the REQUEST half of the request/response evidence the
// retired-request ledger correlates on (R1) -- not a clock, not an arrival
// time.
let capsuleRequestRecordSeq = 0;
function appendCapsuleRequestRecord(harness) {
  capsuleRequestRecordSeq += 1;
  fs.appendFileSync(
    harness.fixture.transcriptPath,
    `\n{"type":"user","uuid":"capsule-request-${capsuleRequestRecordSeq}","parentUuid":null,`
    + '"message":{"role":"user","content":"<command-message>context-capsule is running</command-message>'
    + `\\n<command-name>${CAPSULE_REQUEST_TEXT}</command-name>"}}\n`,
  );
}

// driveToRequestedWithRequest counts requests from zero, which only holds for
// the FIRST cycle a harness runs. These vectors run two and three cycles in one
// process, so the same setup is asserted as a DELTA.
function driveToRequestedWithOneMoreRequest(harness) {
  const before = capsuleTextWriteCount(harness);
  assert.equal(harness.drive().state.state, 'pressure');
  const cycleId = harness.core.state.cycle_id;
  assert.ok(cycleId, 'the cycle must have an identity');
  assert.equal(harness.drive().state.state, 'checkpoint-requested');
  assert.equal(capsuleTextWriteCount(harness), before + 1,
    'setup: this cycle got its one capsule request');
  assert.equal(harness.ackWindowOpen(), true,
    'setup: an ack window is open for the cycle that asked');
  return cycleId;
}

// Open a cycle, write its request, then let the transport retire it with the
// answer still outstanding. Returns the retired cycle_id.
function retireAnOutstandingRequest(harness, { recordTheRequest = false } = {}) {
  const dead = driveToRequestedWithOneMoreRequest(harness);
  if (recordTheRequest) {
    appendCapsuleRequestRecord(harness);
    harness.drive();
    assert.equal(requestRecordsSeen(harness), 1,
      'setup: the host recorded this cycle request and the scan counted it as its own');
  }
  setPressure(harness, BELOW_THRESHOLD);
  assert.equal(harness.drive().state.state, 'idle',
    'setup: the transport abandons the cycle with its capsule still unanswered');
  assert.equal(harness.ackHeld(), false);
  assert.equal(harness.ackWindowOpen(), false, 'setup: the retired cycle keeps no window');
  return dead;
}

// Open the replacement cycle and write ITS request. Returns the live cycle_id.
function openReplacementCycleWithRequest(harness, dead) {
  harness.fixture.clock.advance(60_000);
  setPressure(harness, ABOVE_THRESHOLD);
  assert.equal(harness.drive().state.state, 'pressure');
  const live = harness.core.state.cycle_id;
  assert.notEqual(live, dead, 'setup: the replacement is genuinely a different cycle');
  assert.equal(harness.drive().state.state, 'checkpoint-requested');
  return live;
}

function retiredConsumed(harness) {
  return harness.events('capsule-ack-retired-consumed').map((event) => event.detail);
}

// VERSION-TOLERANT READERS, same purpose as ackHeld/ackWindowOpen above: every
// vector's SETUP must be expressible against the pre-correction build so the
// first assertion that goes red there is a BEHAVIOURAL one. The request-record
// tally was a boolean before re-review 5558958106 and is a count after it, and
// the durable answer account did not exist at all.
function requestRecordsSeen(harness) {
  const watch = harness.runner.capsuleAckWatch;
  if (watch === null || watch === undefined) return null;
  if (watch.request_records_seen !== undefined) return watch.request_records_seen;
  return watch.request_record_seen === true ? 1 : 0;
}

function classificationOf(harness) {
  return harness.cycleState().ack_classification ?? null;
}

function answerAccountOf(harness) {
  const record = classificationOf(harness);
  if (record === null) return null;
  return {
    requests_issued: record.requests_issued ?? null,
    answers_settled: record.answers_settled ?? null,
  };
}

test('GPT-R1a a RETIRED request late answer, landing after the replacement own request went out, authorizes nothing', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(harness);
    const live = openReplacementCycleWithRequest(harness, dead);
    assert.equal(capsuleTextWriteCount(harness), 2,
      'setup: two requests have gone out -- the retired one and the live one');
    const liveWindowFrom = harness.ackWindowFrom();
    assert.ok(Number.isSafeInteger(liveWindowFrom), 'setup: the live cycle has its own window');

    // THE SPECIMEN. The seat finishes the capsule the RETIRED request asked for
    // and says so -- now, inside the live cycle's window, after the live
    // cycle's own request was written. The live cycle has answered nothing.
    // Pre-fix this literal was labelled with the live cycle_id,
    // _capsuleAckAuthorizes said yes, and the clear fired.
    appendExactCapsuleAck(harness);
    assert.ok(transcriptSize(harness) > liveWindowFrom,
      'setup: the late answer lands INSIDE the live cycle window, not behind it');

    for (let i = 0; i < 10; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(clearIntentEventCount(harness), 0,
      'no clear intent is minted for a cycle that has answered nothing');
    assert.equal(clearTextWrites(harness), 0, 'and no clear is written');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
      'a request the live cycle never made cannot be answered on its behalf');
    assert.equal(harness.ackHeld(), false);
    assert.equal(ackObservedCount(harness), 0, 'and the literal is not latched as evidence at all');
    assert.equal(capsuleTextWriteCount(harness), 2, 'still exactly one request per cycle');

    // MECHANISM, after the behaviour: the literal discharged the OLDEST
    // outstanding request, by name, and said which live cycle it refused.
    assert.deepEqual(
      retiredConsumed(harness).map((d) => [d.cycle_id, d.owed, d.live_cycle_id]),
      [[dead, 0, live]],
      'the answer is accounted to the retired request it was owed to',
    );

    // POSITIVE CONTROL, same harness: the live cycle answers for itself and
    // gets exactly one clear. Serialization costs a legitimate completion
    // nothing.
    appendExactCapsuleAck(harness);
    harness.drive();
    assert.equal(ackObservedCount(harness), 1, 'the live cycle own answer IS evidence');
    assert.equal(harness.runner.capsuleAck?.cycle_id, live, 'bound to the cycle that earned it');
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'exactly one clear, on the live cycle own ack');
    for (let i = 0; i < 6; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'and never a second');
  } finally {
    harness.cleanup();
  }
});

test('GPT-R1b the same late answer landing after the replacement OPENED but before its request was written', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(harness);

    // The replacement opens. Its window is recovered from its own persisted
    // boundary, which sits at the transcript's end as it was when the cycle
    // opened -- so anything arriving now is INSIDE it.
    harness.fixture.clock.advance(60_000);
    setPressure(harness, ABOVE_THRESHOLD);
    assert.equal(harness.drive().state.state, 'pressure');
    const live = harness.core.state.cycle_id;
    assert.notEqual(live, dead);
    const boundaryFrom = harness.ackWindowFrom();
    assert.ok(Number.isSafeInteger(boundaryFrom), 'setup: the cycle boundary opened a window');

    appendExactCapsuleAck(harness);
    assert.ok(transcriptSize(harness) > boundaryFrom,
      'setup: the retired request answer lands inside the replacement window');

    // The replacement now asks for its own capsule. Pre-fix it never got to:
    // the late literal had already been read as its ack, so the gate was
    // short-circuited and the clear went out on a cycle that said nothing.
    assert.equal(harness.drive().state.state, 'checkpoint-requested');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
      'the replacement is not acked by an answer it never earned');
    assert.equal(capsuleTextWriteCount(harness), 2,
      'so it asks for its OWN capsule -- pre-fix the stolen ack skipped this request');

    for (let i = 0; i < 10; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(ackObservedCount(harness), 0);
    assert.equal(clearIntentEventCount(harness), 0);
    assert.equal(clearTextWrites(harness), 0);
    assert.equal(capsuleTextWriteCount(harness), 2, 'bounded to one request per cycle throughout');
    assert.deepEqual(
      retiredConsumed(harness).map((d) => [d.cycle_id, d.owed]), [[dead, 0]]);

    // And the replacement still earns its own clear the honest way.
    appendExactCapsuleAck(harness);
    harness.drive();
    assert.equal(harness.runner.capsuleAck?.cycle_id, live);
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1);
  } finally {
    harness.cleanup();
  }
});

test('GPT-R1c the ledger discharges oldest-first and CLOSES on ordering evidence, never on a timer', () => {
  // ARM 1. Two retired requests, one late answer. The answer discharges the
  // OLDER one; the live cycle is owed nothing by it and authorizes nothing.
  const first = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const deadA = retireAnOutstandingRequest(first);
    first.fixture.clock.advance(60_000);
    setPressure(first, ABOVE_THRESHOLD);
    const deadB = retireAnOutstandingRequest(first);
    assert.notEqual(deadA, deadB);

    const live = openReplacementCycleWithRequest(first, deadB);
    appendExactCapsuleAck(first);
    for (let i = 0; i < 4; i += 1) first.drive();
    first.flushControl();
    assert.equal(clearIntentEventCount(first), 0,
      'one answer for two outstanding requests settles the older one, not the live cycle');
    assert.equal(clearTextWrites(first), 0);
    assert.equal(first.runner._capsuleAckAuthorizes(live), false);

    // MECHANISM, after the behaviour.
    assert.deepEqual(
      retiredConsumed(first).map((d) => [d.cycle_id, d.owed]), [[deadA, 1]],
      'oldest first, and the remaining debt is still named');
    assert.equal(first.runner.capsuleAckRetired?.owed, 1,
      'one of the two requests is still owed an answer');
    assert.equal(first.runner.capsuleAckRetired?.records_owed, 2,
      'and neither retired request has been recorded by the host, so no later record '
      + 'can be mistaken for the live cycle and close the ledger early');

    // The live cycle's own answer is next in line behind the one still owed,
    // so it is consumed too -- fail-closed, and the cost is bounded to this
    // cycle. ARM 2 is what keeps that bound from being open-ended.
    appendExactCapsuleAck(first);
    for (let i = 0; i < 4; i += 1) first.drive();
    first.flushControl();
    assert.equal(clearTextWrites(first), 0, 'still refused, by name, never a guessed authorization');
    assert.equal(first.snapshot().lastDecision?.code, 'runner-capsule-not-acked');
    assert.equal(first.runner.capsuleAckRetired, null, 'and the ledger is now empty');
  } finally {
    first.cleanup();
  }

  // ARM 2. A retired request that is NEVER answered must not hold the ledger
  // open forever. Prompts are processed in submission order, so once the host
  // records a LATER request, every answer the earlier one could still produce
  // has already been written. The ledger closes there -- on evidence, not on a
  // timeout -- and the live cycle's own answer clears it exactly once.
  const second = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(second, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(second, dead);
    assert.equal(second.runner.capsuleAckRetired?.owed, 1, 'setup: one answer still outstanding');

    appendCapsuleRequestRecord(second);
    second.drive();
    const closed = second.events('capsule-ack-retired-closed');
    assert.equal(closed.length, 1, 'the later request record closes the ledger');
    assert.deepEqual(
      [closed[0].detail?.reason, closed[0].detail?.forgiven, closed[0].detail?.cycle_ids],
      ['later-request-recorded', 1, [dead]],
    );
    assert.equal(second.runner.capsuleAckRetired, null);
    assert.equal(retiredConsumed(second).length, 0, 'nothing was consumed: nothing ever answered');

    appendExactCapsuleAck(second);
    second.drive();
    assert.equal(ackObservedCount(second), 1,
      'and the live cycle own answer is NOT eaten by a debt that can no longer be paid');
    assert.equal(second.runner.capsuleAck?.cycle_id, live);
    second.flushControl();
    assert.equal(clearTextWrites(second), 1, 'exactly one clear');
    for (let i = 0; i < 6; i += 1) second.drive();
    second.flushControl();
    assert.equal(clearTextWrites(second), 1);
  } finally {
    second.cleanup();
  }

  // ARM 3. A RECORD BELONGS TO ONE REQUEST. A retired request whose own record
  // only lands INSIDE the live cycle's window must be counted by the ledger and
  // must NOT also be claimed by the live cycle -- claiming it would understate
  // the debt on a later retirement and close the ledger one record early, which
  // is the four-deep way back into R1.
  const third = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const deadA = retireAnOutstandingRequest(third);
    assert.equal(third.runner.capsuleAckRetired?.records_owed, 1,
      'setup: the retired request has not been recorded by the host yet');
    const deadB = openReplacementCycleWithRequest(third, deadA);

    // The retired request's record lands now -- after the live cycle's own
    // window opened, so both the ledger and the live scan can see it.
    appendCapsuleRequestRecord(third);
    third.drive();
    assert.equal(third.runner.capsuleAckRetired?.records_owed, 0,
      'the ledger accounts the record to the retired request it was owed to');
    assert.equal(requestRecordsSeen(third), 0,
      'and the live cycle does NOT also claim it');
    assert.equal(third.events('capsule-request-recorded').length, 0);
    assert.equal(third.events('capsule-ack-retired-closed').length, 0,
      'a record that is owed cannot close the ledger');

    // The live cycle is retired too, still unrecorded, so the debt grows
    // honestly rather than being written off.
    setPressure(third, BELOW_THRESHOLD);
    assert.equal(third.drive().state.state, 'idle');
    assert.equal(third.runner.capsuleAckRetired?.owed, 2);
    assert.equal(third.runner.capsuleAckRetired?.records_owed, 1,
      'the live cycle is retired owing its own record, not pre-credited with another cycle\'s');

    // A third cycle opens and asks. Either retired answer arriving now settles
    // a retired request, never this one.
    const live = openReplacementCycleWithRequest(third, deadB);
    appendExactCapsuleAck(third);
    for (let i = 0; i < 6; i += 1) third.drive();
    third.flushControl();
    assert.equal(third.runner._capsuleAckAuthorizes(live), false);
    assert.equal(clearIntentEventCount(third), 0);
    assert.equal(clearTextWrites(third), 0);
    assert.deepEqual(
      retiredConsumed(third).map((d) => [d.cycle_id, d.owed]), [[deadA, 1]]);
  } finally {
    third.cleanup();
  }
});

// The ledger's cap (internal review of 384185b, G4; re-review 5556245936, S2).
// CAPSULE_RETIRED_REQUEST_MAX is module-private, so this vector pins the BOUND
// and its invariants from the outside: the cap cannot be changed, or quietly
// removed, without a red test.
//
// REWRITTEN AFTER S2, AND THE OLD VERSION WAS THE PROBLEM. The first version of
// this vector stopped after the FIRST of nine retired answers, while seven
// tracked debts still protected the live cycle -- so it passed over a real
// defect. The reviewer's continuation delivers ALL nine request/answer pairs in
// submission order: on the old build the ninth debt had been ERASED at the cap,
// so once the first eight were discharged and the ledger emptied, A9's answer
// was read as the live cycle's (measured consumed 8, overflows 1,
// authorized(B) true, requests 10, with no out-of-order host record). What the
// cap bounds now is the MEMORY -- the retained NAMES -- and never the ownership:
// `owed` and `records_owed` keep counting, and `cycle_ids.length +
// names_dropped === owed` holds throughout.
const RETIRED_LEDGER_CAP = 8;
const RETIRED_LEDGER_OVERFLOW_BY = 1;

test('GPT-R1d the retired ledger caps its NAMES, never its debts: all nine retired answers are serialized', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    // One more retirement than the ledger will NAME. Nothing answers any of
    // them yet, so every one of these requests is genuinely outstanding.
    const total = RETIRED_LEDGER_CAP + RETIRED_LEDGER_OVERFLOW_BY;
    const retired = [];
    for (let i = 0; i < total; i += 1) {
      harness.fixture.clock.advance(60_000);
      setPressure(harness, ABOVE_THRESHOLD);
      retired.push(retireAnOutstandingRequest(harness));
    }
    assert.equal(new Set(retired).size, total,
      'setup: nine genuinely distinct cycles, each with its own request on the wire');

    // Read the ledger at the cap before anything discharges it. Optional
    // chaining throughout so a build with no ledger reaches the BEHAVIOURAL
    // assertions below rather than dying on a missing field.
    const atCap = {
      owed: harness.runner.capsuleAckRetired?.owed,
      records_owed: harness.runner.capsuleAckRetired?.records_owed,
      names_dropped: harness.runner.capsuleAckRetired?.names_dropped,
      cycle_ids: [...(harness.runner.capsuleAckRetired?.cycle_ids ?? [])],
    };

    // ALL NINE ANSWERS, IN SUBMISSION ORDER. This is the reviewer's
    // continuation: the old build survived the first eight and then handed the
    // ninth to the live cycle.
    const live = openReplacementCycleWithRequest(harness, retired[total - 1]);
    for (let i = 0; i < total; i += 1) {
      appendCapsuleRequestRecord(harness);
      appendExactCapsuleAck(harness);
      for (let tick = 0; tick < 3; tick += 1) harness.drive();
      harness.flushControl();
      assert.equal(clearIntentEventCount(harness), 0,
        `retired answer ${i + 1} of ${total} must not mint a clear intent for the live cycle`);
      assert.equal(clearTextWrites(harness), 0,
        `retired answer ${i + 1} of ${total} must not clear`);
      assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
        `retired answer ${i + 1} of ${total} must not authorize the live cycle`);
    }

    // MECHANISM, after the behaviour. The cap bounds the NAMES; the debts are
    // all still counted, and the invariant ties the two together.
    assert.equal(atCap.owed, total, 'every retirement is counted, cap or no cap');
    assert.equal(atCap.records_owed, total,
      'none of them has been recorded by the host, and the count says so');
    assert.equal(atCap.cycle_ids.length, RETIRED_LEDGER_CAP,
      'the ledger NAMES at most the cap');
    assert.deepEqual(atCap.cycle_ids, retired.slice(0, RETIRED_LEDGER_CAP),
      'and it keeps the OLDEST names -- the ones discharged first');
    assert.equal(atCap.names_dropped, RETIRED_LEDGER_OVERFLOW_BY);
    assert.equal(atCap.cycle_ids.length + atCap.names_dropped, atCap.owed,
      'THE LEDGER INVARIANT: a named debt or an unnamed one, never a lost one');

    // NAMED, NOT SILENT: the retirement whose name did not fit is reported
    // once, by cycle, with the capacity that refused it.
    assert.equal(harness.events('capsule-ack-retired').length, total,
      'one event per retirement -- including the ones past the name cap');
    const overflow = harness.events('capsule-ack-retired-overflow');
    assert.equal(overflow.length, 1, 'and exactly one overflow, not one per retirement');
    assert.equal(overflow[0].detail?.cycle_id, retired[RETIRED_LEDGER_CAP],
      'naming the first retirement whose name was dropped');
    assert.equal(overflow[0].detail?.names_retained, RETIRED_LEDGER_CAP);

    // Every answer discharged a debt, oldest first, and the one that outran the
    // names says so instead of guessing a cycle it never kept.
    const consumed = retiredConsumed(harness);
    assert.equal(consumed.length, total, 'all nine answers were consumed as retired');
    assert.deepEqual(consumed.map((d) => d.cycle_id),
      [...retired.slice(0, RETIRED_LEDGER_CAP), null],
      'oldest first, then the unnamed debt');
    assert.deepEqual(consumed.map((d) => d.named),
      [...retired.slice(0, RETIRED_LEDGER_CAP).map(() => true), false]);
    assert.equal(harness.runner.capsuleAckRetired, null, 'and the ledger is empty');

    // LEGITIMATE RECOVERY. With every debt settled, the live cycle's own
    // request record and its own answer buy it exactly one clear. Exhausting
    // the name capacity costs a real completion nothing.
    appendCapsuleRequestRecord(harness);
    appendExactCapsuleAck(harness);
    for (let tick = 0; tick < 4 && harness.runner.phase !== 'prepared'; tick += 1) harness.drive();
    assert.equal(harness.runner.capsuleAck?.cycle_id, live,
      'the live cycle own answer IS its evidence');
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'exactly one clear');
    for (let tick = 0; tick < 6; tick += 1) harness.drive();
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'and never a second');
    assert.equal(capsuleTextWriteCount(harness), total + 1,
      'one capsule request per cycle throughout: nine retired plus the live one');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R2 -- the unrecoverable boundary while a checkpoint HOLD is genuinely
// justified. The safe re-request recovery already existed; it was simply never
// reachable from this state.
// ---------------------------------------------------------------------------

// Drive one cycle into a REAL HOLD:checkpoint-transcript-short: the Stop hook
// captures the transcript, the conversation then grows past the announcement
// budget, and the checkpoint legitimately reads the capsule as stale. Not a
// fresh confirmed fixture with a hold name painted on it.
function driveToJustifiedCheckpointHold(harness) {
  const cycleId = driveToRequestedWithRequest(harness);
  const captured = harness.writeStopRecordAtTranscriptEnd();
  appendCapsuleRunNoise(harness);
  assert.ok(transcriptSize(harness) - captured > CHECKPOINT_TAIL_TOLERANCE_BYTES,
    'setup: the transcript genuinely outgrew the tail budget after the capture');
  const held = harness.drive();
  assert.equal(held.state.state, 'HOLD:checkpoint-transcript-short',
    'setup: the hold is the real one, earned by the byte arithmetic');
  assert.equal(held.state.cycle_id, cycleId);
  return cycleId;
}

const R2_BOUNDARY_CASES = [
  ['legacy (a seat upgrading from a build without the field)',
    (state) => { delete state.ack_boundary; }, 'ack-boundary-legacy'],
  ['absent (the transport could not capture one)',
    (state) => { state.ack_boundary = null; }, 'ack-boundary-absent'],
  ['malformed',
    (state) => { state.ack_boundary = { ...state.ack_boundary, transcript_offset: 'not-a-number' }; },
    'ack-boundary-malformed'],
];

test('GPT-R2a an unrecoverable boundary under a justified checkpoint HOLD re-requests the capsule, once, and recovers', () => {
  for (const [label, corrupt, expectedCode] of R2_BOUNDARY_CASES) {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      const cycleId = driveToJustifiedCheckpointHold(harness);
      const state = harness.cycleState();
      corrupt(state, harness);
      harness.writeCycleState(state);

      harness.relaunch();
      const first = harness.drive();
      assert.equal(first.state.state, 'HOLD:checkpoint-transcript-short',
        `${label}: the hold is still live and still justified`);
      assert.equal(first.state.cycle_id, cycleId);
      // The boundary failed, so NO window was restored over the held
      // transcript: the only window that can exist after this tick is the one
      // the recovery request opened at the transcript's end, asserted below.
      const unrecoverable = harness.events('capsule-ack-window-unrecoverable');
      assert.equal(unrecoverable.length, 1, `${label}: the boundary failure is named once`);
      assert.equal(harness.events('capsule-ack-watch-restored').length, 0,
        `${label}: nothing was restored -- no unowned bytes are ever read as evidence`);

      // THE REPAIR. Nothing can lift this hold but a fresh checkpoint or a
      // fresh ack, and the runner has neither a window nor an answer coming.
      // Pre-fix: 0 requests, null window, for as long as the seat ran.
      assert.equal(capsuleTextWriteCount(harness), 1,
        `${label}: the capsule is re-requested -- pre-fix nothing was ever asked for`);
      assert.equal(clearTextWrites(harness), 0, `${label}: and nothing authorizes a clear`);
      assert.equal(clearIntentEventCount(harness), 0);

      // BOUNDED, by the same one-request-per-cycle latch as every other path.
      for (let i = 0; i < 50; i += 1) harness.drive();
      harness.flushControl();
      assert.equal(capsuleTextWriteCount(harness), 1, `${label}: still exactly one request after 50 ticks`);
      assert.equal(clearTextWrites(harness), 0);
      assert.equal(harness.snapshot().lastDecision?.code, 'checkpoint-transcript-short',
        `${label}: and the cycle is still, visibly, held by the checkpoint it cannot satisfy`);

      // VISIBLE, and HONEST about what has and has not happened (R2's second
      // half): the boundary failure states the OWING, and a separate event
      // states the request -- once, and only because one went out.
      assert.equal(harness.events('capsule-ack-window-unrecoverable').length, 1,
        `${label}: named once, by cause, not once per tick`);
      assert.equal(unrecoverable[0].detail?.code, expectedCode);
      assert.equal(unrecoverable[0].detail?.recovery, 'capsule-request-pending',
        `${label}: the boundary failure may only claim the owing, not a request`);
      const requested = harness.events('capsule-ack-recovery-requested');
      assert.equal(requested.length, 1, `${label}: and the request that did go out is named once`);
      assert.equal(requested[0].detail?.cycle_id, cycleId);

      // FRESHNESS IS NOT WEAKENED: the window the re-request opened sits at the
      // transcript's end, so the hold is lifted by a NEW answer, never by old
      // unowned bytes.
      assert.ok(harness.ackWindowFrom() >= transcriptSize(harness),
        `${label}: the recovery window opens at the end, never over the held transcript`);
      appendExactCapsuleAck(harness);
      for (let i = 0; i < 5 && harness.runner.phase !== 'prepared'; i += 1) harness.drive();
      assert.equal(ackObservedCount(harness), 1, `${label}: the fresh answer is the evidence`);
      assert.equal(harness.runner.capsuleAck?.cycle_id, cycleId);
      harness.flushControl();
      assert.equal(clearTextWrites(harness), 1,
        `${label}: the ack supersedes the tail arithmetic and buys exactly one clear`);
    } finally {
      harness.cleanup();
    }
  }
});

test('GPT-R2b controls: an unrelated HOLD authority never requests, and a busy composer still defers', () => {
  // CONTROL 1. The same unrecoverable boundary, but the cycle is held by
  // TELEMETRY, not by the checkpoint. A capsule would not lift that hold and
  // the gate must not fire for it.
  const telemetry = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const cycleId = driveToRequestedWithRequest(telemetry);
    setPressure(telemetry, TELEMETRY_MISSING);
    const held = telemetry.drive();
    assert.equal(held.state.state, 'HOLD:telemetry-missing');
    assert.equal(held.state.cycle_id, cycleId);
    const state = telemetry.cycleState();
    delete state.ack_boundary;
    telemetry.writeCycleState(state);

    telemetry.relaunch();
    for (let i = 0; i < 50; i += 1) telemetry.drive();
    assert.equal(telemetry.runner.lastCoreResult?.state?.state, 'HOLD:telemetry-missing',
      'the cycle is still held by telemetry');
    assert.equal(telemetry.ackWindowOpen(), false, 'the boundary still failed');
    assert.equal(capsuleTextWriteCount(telemetry), 0,
      'a telemetry hold is not a checkpoint authority: nothing may be requested for it');
    assert.equal(clearTextWrites(telemetry), 0);
    assert.equal(telemetry.events('capsule-ack-recovery-requested').length, 0,
      'and nothing claims a recovery that did not happen');
  } finally {
    telemetry.cleanup();
  }

  // CONTROL 2. COMPOSER PROTECTION survives the new gate: operator text in the
  // composer defers the recovery request exactly as it defers any other, and
  // the operator's bytes are never written over.
  const composer = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const cycleId = driveToJustifiedCheckpointHold(composer);
    const state = composer.cycleState();
    delete state.ack_boundary;
    composer.writeCycleState(state);

    composer.relaunch();
    const partial = Buffer.from('half a thought about the');
    composer.operator(partial);
    assert.deepEqual(composer.pty.writes, [partial],
      'operator sovereignty: the text passes through untouched');

    for (let i = 0; i < 20; i += 1) composer.drive();
    assert.equal(capsuleTextWriteCount(composer), 0,
      'the recovery request is DEFERRED behind operator text, never appended to it');
    assert.deepEqual(composer.pty.writes, [partial], 'and nothing at all is written meanwhile');
    assert.equal(capsuleDeferredEvents(composer).length, 1,
      'the deferral is one named event per cycle');
    assert.equal(composer.snapshot().lastDecision?.code, 'runner-capsule-request-composer-busy',
      'the refusal names the composer wait, not a request that was never made');

    // The operator submits. The recovery request then goes out, once.
    composer.operator(Buffer.from(' runner\r'));
    composer.drive();
    assert.equal(capsuleTextWriteCount(composer), 1,
      'the deferred recovery request fires after the operator prompt -- pre-fix it never fired at all');
    assert.equal(composer.events('capsule-ack-recovery-requested').length, 1);
    assert.equal(composer.events('capsule-ack-recovery-requested')[0].detail?.cycle_id, cycleId);
    for (let i = 0; i < 30; i += 1) composer.drive();
    assert.equal(capsuleTextWriteCount(composer), 1, 'and exactly once');
  } finally {
    composer.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R3 -- a valid restore window is EVIDENCE in every state that can re-request,
// not only at `checkpoint-confirmed`.
// ---------------------------------------------------------------------------

function driveUntilAckRecovered(harness, limit = 10) {
  for (let i = 0; i < limit && ackObservedCount(harness) === 0; i += 1) harness.drive();
}

test('GPT-R3 a restore window wider than one bounded read drains before anything is re-requested, in every restore state', () => {
  // ARM 1. The `checkpoint-requested` restore (action=request-checkpoint).
  // Pre-fix this wrote a second request on the very first tick and the re-arm
  // moved the cursor to EOF, burying the valid ack behind it for good.
  const requested = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(requested.drive().state.state, 'pressure');
    const cycleId = requested.core.state.cycle_id;
    const atCycleStart = transcriptSize(requested);
    appendOversizeRestoreWindow(requested);
    appendExactCapsuleAck(requested);
    const total = transcriptSize(requested);
    requested.writeStopRecordAtTranscriptEnd();
    assert.ok(total - atCycleStart > ACK_SCAN_WINDOW_BYTES,
      'setup: the cycle own valid window is wider than one bounded read');

    requested.relaunch();
    const first = requested.drive();
    assert.equal(first.state.state, 'checkpoint-requested');
    assert.equal(first.action, 'request-checkpoint', 'the restore carries the request action');
    assert.equal(first.state.cycle_id, cycleId);
    assert.equal(capsuleTextWriteCount(requested), 0,
      'the valid window is evidence: nothing may be re-asked over it -- pre-fix this was 1');
    assert.equal(ackObservedCount(requested), 0, 'and it has not been reached yet');
    assert.ok(requested.ackWindowFrom() > atCycleStart && requested.ackWindowFrom() < total,
      `the cursor is still inside the window, not parked at EOF (got ${requested.ackWindowFrom()})`);

    driveUntilAckRecovered(requested);
    assert.equal(ackObservedCount(requested), 1,
      'the ack beyond the first bounded read is recovered once the window drains');
    assert.equal(requested.runner.capsuleAck?.cycle_id, cycleId);
    assert.equal(capsuleTextWriteCount(requested), 0, 'with no duplicate request at any point');
    for (let i = 0; i < 4 && requested.runner.phase !== 'prepared'; i += 1) requested.drive();
    requested.flushControl();
    assert.equal(clearTextWrites(requested), 1, 'and exactly one clear');
    assert.equal(capsuleTextWriteCount(requested), 0);
  } finally {
    requested.cleanup();
  }

  // ARM 2. The telemetry-HOLD -> `checkpoint-requested` restore: the cycle
  // comes back held, resumes into checkpoint-requested when telemetry returns,
  // and the same window must survive that transition.
  const viaHold = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(viaHold.drive().state.state, 'pressure');
    const cycleId = viaHold.core.state.cycle_id;
    const atCycleStart = transcriptSize(viaHold);
    assert.equal(viaHold.drive().state.state, 'checkpoint-requested');
    setPressure(viaHold, TELEMETRY_MISSING);
    assert.equal(viaHold.drive().state.state, 'HOLD:telemetry-missing');

    appendOversizeRestoreWindow(viaHold);
    appendExactCapsuleAck(viaHold);
    const total = transcriptSize(viaHold);
    viaHold.writeStopRecordAtTranscriptEnd();

    viaHold.relaunch();
    const first = viaHold.drive();
    assert.equal(first.state.state, 'HOLD:telemetry-missing', 'the restore comes back held');
    assert.equal(capsuleTextWriteCount(viaHold), 0, 'a telemetry hold requests nothing');

    setPressure(viaHold, ABOVE_THRESHOLD);
    const resumed = viaHold.drive();
    assert.equal(resumed.state.state, 'checkpoint-requested',
      'telemetry returns and the cycle resumes into checkpoint-requested');
    assert.equal(resumed.state.cycle_id, cycleId);
    assert.equal(ackObservedCount(viaHold), 0, 'setup: the ack is still beyond the cursor');
    assert.equal(capsuleTextWriteCount(viaHold), 0,
      'the window carried across the hold is still evidence -- pre-fix this resume wrote a request');
    assert.ok(viaHold.ackWindowFrom() > atCycleStart && viaHold.ackWindowFrom() < total,
      'and the cursor is still inside the window');

    driveUntilAckRecovered(viaHold);
    assert.equal(ackObservedCount(viaHold), 1, 'the ack is recovered, not buried');
    assert.equal(viaHold.runner.capsuleAck?.cycle_id, cycleId);
    assert.equal(capsuleTextWriteCount(viaHold), 0, 'with no duplicate request');
    for (let i = 0; i < 4 && viaHold.runner.phase !== 'prepared'; i += 1) viaHold.drive();
    viaHold.flushControl();
    assert.equal(clearTextWrites(viaHold), 1);
  } finally {
    viaHold.cleanup();
  }

  // ARM 3, THE MATCHED CONTROL. The same oversize window restored at
  // `checkpoint-confirmed`, where the drained guard already applied. It drained
  // and recovered before the fix and must still do so after it: the repair
  // GENERALISED this behaviour, it did not change it.
  const confirmed = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(confirmed.drive().state.state, 'pressure');
    const cycleId = confirmed.core.state.cycle_id;
    const atCycleStart = transcriptSize(confirmed);
    assert.equal(confirmed.drive().state.state, 'checkpoint-requested');
    appendOversizeRestoreWindow(confirmed);
    appendExactCapsuleAck(confirmed);
    const total = transcriptSize(confirmed);
    confirmed.writeStopRecordAtTranscriptEnd();

    confirmed.relaunch();
    confirmed.drive();
    assert.equal(confirmed.runner.lastCoreResult?.state?.state, 'checkpoint-confirmed',
      'the transport walked requested -> confirmed inside one tick');
    assert.equal(confirmed.runner.lastCoreResult?.state?.cycle_id, cycleId);
    assert.equal(capsuleTextWriteCount(confirmed), 0, 'the control drains rather than re-asking');
    assert.ok(confirmed.ackWindowFrom() > atCycleStart && confirmed.ackWindowFrom() < total);

    driveUntilAckRecovered(confirmed);
    assert.equal(ackObservedCount(confirmed), 1);
    assert.equal(confirmed.runner.capsuleAck?.cycle_id, cycleId);
    assert.equal(capsuleTextWriteCount(confirmed), 0, 'and never a duplicate request');
    for (let i = 0; i < 4 && confirmed.runner.phase !== 'prepared'; i += 1) confirmed.drive();
    confirmed.flushControl();
    assert.equal(clearTextWrites(confirmed), 1);
  } finally {
    confirmed.cleanup();
  }
});

// ===========================================================================
// RE-REVIEW 5556245936 (GPT). R2 and R3 accepted and closed for their reviewed
// cases; R1 returned FIX with three continuations. All three are replayed here
// in the real harness -- the reviewer drafted them but explicitly did not run
// this harness, so the setups below are adapted while keeping his semantic
// discriminators.
//
// S1 — THE CLAIM THAT WAS WRONG, AND WHOSE IT WAS. The previous round argued
// that the in-memory ledger was safe across a relaunch because a pre-relaunch
// answer "sits behind the next cycle's forward-only EOF boundary", so only an
// orphaned child could reopen the hole. #90 RESTORES AN EXISTING CYCLE, NOT A
// NEW ONE AT EOF: the restore reopens the cycle's ORIGINAL persisted boundary,
// which predates an answer that arrived later in that cycle's life. A
// genuinely-new-cycle-at-EOF does reject the old answer -- the matched control
// in GPT-S1b arm 3 is that control, and it is exactly what made the wrong claim
// look right. So the sequence needs no SIGKILL, no orphan, no post-relaunch
// write and no change of session identity; an ORDERLY relaunch is enough.
//
// S2 — the ninth retired request was dropped at the cap and its answer then
// accepted. Covered by the rewritten GPT-R1d above.
//
// S3 — the live reader can overtake the bounded retired reader: with a
// multi-window backlog the retired cursor is still far behind while the live
// reader is already past the old answer.
// ===========================================================================

function driveUntil(harness, predicate, limit = 40) {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return i;
    harness.drive();
  }
  assert.ok(predicate(), `bounded progress: the condition must hold within ${limit} ticks`);
  return limit;
}

test('GPT-S1a an ORDERLY same-session relaunch cannot revive an already-rejected retired answer', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(harness, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(harness, dead);

    // A answers. B has answered nothing. The live process gets this right.
    appendExactCapsuleAck(harness);
    const aAnswerEnd = transcriptSize(harness);
    for (let i = 0; i < 4; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(retiredConsumed(harness).length, 1,
      'setup: A was correctly consumed as retired BEFORE the shutdown');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
      'setup: and the live cycle was correctly refused');
    assert.equal(clearTextWrites(harness), 0);

    // The saved cycle is B, and its boundary PREDATES A's answer. That gap is
    // the defect: a restore that trusts the boundary alone reopens the window
    // over a record this process already rejected.
    harness.writeStopRecordAtTranscriptEnd();
    const saved = harness.cycleState();
    assert.equal(saved.cycle_id, live, 'setup: the saved cycle is B, not a new one');
    assert.ok(saved.ack_boundary.transcript_offset < aAnswerEnd,
      'setup: B own persisted boundary sits BEFORE A answer -- #90 restores an EXISTING cycle');

    // The existing harness relaunch shuts the old runner down and kills the old
    // scripted child. Nothing is written to the transcript afterwards; every
    // byte already existed. No SIGKILL, no orphan, no fabricated boundary.
    harness.relaunch();
    harness.drive();
    harness.flushControl();
    assert.equal(clearIntentEventCount(harness), 0,
      'the persisted B boundary must not replay A as B -- MUST be red on d950ebc');
    assert.equal(clearTextWrites(harness), 0);
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
      'evidence rejected before an orderly shutdown may not become authorization after it');
    assert.equal(ackObservedCount(harness), 0, 'and A is not latched as anyone evidence');

    // MECHANISM, after the behaviour: the window reopened PAST the record the
    // previous process classified, carried in the cycle own durable record.
    const restored = harness.events('capsule-ack-watch-restored');
    assert.equal(restored.length, 1);
    assert.ok(restored[0].detail?.from >= aAnswerEnd,
      `the restored window opens past the rejected record (got ${restored[0].detail?.from}, A ends ${aAnswerEnd})`);
    assert.equal(restored[0].detail?.boundary, saved.ack_boundary.transcript_offset,
      'and the line names both inputs, so an operator can see which one moved it');
    assert.ok(restored[0].detail?.classified_through >= aAnswerEnd);
    assert.equal(harness.cycleState().ack_classification?.cycle_id, live,
      'the classification is cycle-bound, in the cycle record -- not a new state file');
    assert.equal(harness.cycleState().ack_classification?.debts_outstanding, 0,
      'with no debts outstanding: A had already been settled');

    // POSITIVE COMPANION: B answers for itself after the relaunch and gets
    // exactly one clear. The exclusion costs a real completion nothing.
    appendExactCapsuleAck(harness);
    driveUntil(harness, () => harness.runner.phase === 'prepared', 8);
    assert.equal(harness.runner.capsuleAck?.cycle_id, live);
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'exactly one clear, on B own answer');
    for (let i = 0; i < 6; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'and never a second');
  } finally {
    harness.cleanup();
  }
});

test('GPT-S1b a debt outstanding at shutdown survives it; the exclusion stays MINIMAL and fails safe when unusable', () => {
  // ARM 1. A DEBT STILL OUTSTANDING AT SHUTDOWN. A never answered before the
  // relaunch, so the restore must rebuild the debt from the cycle's own record
  // -- otherwise A's answer, arriving afterwards, is read as B's.
  const owing = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(owing, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(owing, dead);
    for (let i = 0; i < 3; i += 1) owing.drive();
    assert.equal(owing.runner.capsuleAckRetired?.owed, 1,
      'setup: A answer is still outstanding when the process stops');
    owing.writeStopRecordAtTranscriptEnd();
    const savedClassification = owing.cycleState().ack_classification ?? null;

    owing.relaunch();
    owing.drive();
    // A answers now, after an orderly relaunch. Fixed tick count so both builds
    // reach the behavioural assertion below.
    appendExactCapsuleAck(owing);
    for (let i = 0; i < 6; i += 1) owing.drive();
    owing.flushControl();
    assert.equal(clearIntentEventCount(owing), 0,
      'A answer arriving after an orderly relaunch cannot authorize B -- MUST be red on d950ebc');
    assert.equal(clearTextWrites(owing), 0);
    assert.equal(owing.runner._capsuleAckAuthorizes(live), false);
    assert.equal(ackObservedCount(owing), 0, 'and it is not latched as B evidence at all');

    // MECHANISM, after the behaviour: the debt crossed the relaunch as a
    // number in the cycle record, and discharged A as an unnamed debt.
    assert.equal(savedClassification?.debts_outstanding, 1,
      'the cycle record carried the outstanding debt');
    assert.equal(savedClassification?.cycle_id, live, 'cycle-bound, in the cycle record');
    assert.equal(owing.events('capsule-ack-retired-restored').length, 1);
    assert.equal(retiredConsumed(owing).length, 1, 'A answer discharged A debt');
    assert.equal(retiredConsumed(owing)[0].named, false,
      'unnamed across the relaunch, and the event says so rather than guessing');

    // And B still earns its own clear afterwards.
    appendExactCapsuleAck(owing);
    driveUntil(owing, () => owing.runner.phase === 'prepared', 8);
    owing.flushControl();
    assert.equal(clearTextWrites(owing), 1, 'exactly one clear, on B own answer');
  } finally {
    owing.cleanup();
  }

  // ARM 2. THE EXCLUSION MUST NOT OVERSHOOT. A is consumed, then B genuinely
  // answers, then the process restarts. The restore must exclude A and nothing
  // more: B's own answer is still on disk and ordinary #90 restoration must
  // find it -- one clear, no duplicate request, and the evidence recovered must
  // be B's record rather than A's.
  const minimal = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(minimal, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(minimal, dead);
    appendExactCapsuleAck(minimal);
    const aAnswerEnd = transcriptSize(minimal);
    for (let i = 0; i < 3; i += 1) minimal.drive();
    assert.equal(retiredConsumed(minimal).length, 1, 'setup: A consumed as retired');
    assert.equal(minimal.runner._capsuleAckAuthorizes(live), false);

    // B now really completes, and the process dies before the scan reaches it.
    appendExactCapsuleAck(minimal);
    const bAnswerEnd = transcriptSize(minimal);
    minimal.writeStopRecordAtTranscriptEnd();

    minimal.relaunch();
    driveUntil(minimal, () => ackObservedCount(minimal) > 0, 8);
    assert.equal(ackObservedCount(minimal), 1,
      'B own answer is still recovered: the exclusion covers A and stops there');
    assert.equal(minimal.runner.capsuleAck?.cycle_id, live);
    const restored = minimal.events('capsule-ack-watch-restored')[0]?.detail;
    assert.ok(restored?.from >= aAnswerEnd,
      `the window opens PAST A answer, so what it found is B record (from ${restored?.from}, A ends ${aAnswerEnd})`);
    assert.ok(restored?.from < bAnswerEnd,
      'and BEFORE B answer, which is what lets #90 recover it at all');
    driveUntil(minimal, () => minimal.runner.phase === 'prepared', 6);
    minimal.flushControl();
    assert.equal(clearTextWrites(minimal), 1, 'exactly one clear');
    assert.equal(capsuleTextWriteCount(minimal), 0,
      'and no duplicate request: the answer was on disk and was found');
  } finally {
    minimal.cleanup();
  }

  // ARM 3, THE MATCHED CONTROL the reviewer used to isolate the wrong claim. A
  // genuinely NEW cycle captures its boundary at the transcript's end, so it
  // rejects the old answer by the boundary alone. That was always true, and it
  // is precisely why "the EOF boundary covers it" looked right for a restore
  // too. It must stay true.
  const fresh = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(fresh, { recordTheRequest: true });
    appendExactCapsuleAck(fresh);
    for (let i = 0; i < 3; i += 1) fresh.drive();
    const atOldAnswer = transcriptSize(fresh);
    const live = openReplacementCycleWithRequest(fresh, dead);
    assert.ok(fresh.cycleState().ack_boundary.transcript_offset >= atOldAnswer,
      'a NEW cycle boundary is captured at the end, past the old answer');
    fresh.writeStopRecordAtTranscriptEnd();
    fresh.relaunch();
    for (let i = 0; i < 4; i += 1) fresh.drive();
    fresh.flushControl();
    assert.equal(ackObservedCount(fresh), 0, 'so the old answer is excluded by the boundary itself');
    assert.equal(fresh.runner._capsuleAckAuthorizes(live), false);
    assert.equal(clearTextWrites(fresh), 0);
  } finally {
    fresh.cleanup();
  }

  // ARM 4. AN UNUSABLE CLASSIFICATION FAILS SAFE, BY NAME. A record that claims
  // to carry an exclusion and cannot must not silently drop it: it takes the
  // existing safe re-request path, like a bad boundary.
  const broken = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(broken, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(broken, dead);
    appendExactCapsuleAck(broken);
    for (let i = 0; i < 3; i += 1) broken.drive();
    broken.writeStopRecordAtTranscriptEnd();
    const state = broken.cycleState();
    assert.ok(state.ack_classification, 'setup: a classification was written');
    state.ack_classification = { ...state.ack_classification, classified_through: 'not-a-number' };
    broken.writeCycleState(state);

    broken.relaunch();
    broken.drive();
    broken.flushControl();
    assert.equal(ackObservedCount(broken), 0,
      'no window is opened over the held transcript, so A is not read as evidence');
    assert.equal(clearTextWrites(broken), 0);
    assert.equal(broken.runner._capsuleAckAuthorizes(live), false);
    const unrecoverable = broken.events('capsule-ack-window-unrecoverable');
    assert.equal(unrecoverable.length, 1, 'named once, by cause');
    assert.equal(unrecoverable[0].detail?.code, 'ack-classification-malformed');
    assert.deepEqual(unrecoverable[0].detail?.detail, { field: 'classified_through' });
    assert.equal(unrecoverable[0].detail?.recovery, 'capsule-request-pending');
    assert.equal(capsuleTextWriteCount(broken), 1, 'and the capsule is re-requested, once');
    assert.match(allRunnerLogs(broken), /ack-classification-malformed/);

    // The re-request opens its window at the end, so a fresh answer clears it.
    appendExactCapsuleAck(broken);
    driveUntil(broken, () => broken.runner.phase === 'prepared', 8);
    broken.flushControl();
    assert.equal(clearTextWrites(broken), 1, 'recovery ends in exactly one clear');
  } finally {
    broken.cleanup();
  }
});

test('GPT-S3 the live scan cannot overtake the retired reader across a multi-window backlog', () => {
  // ARM 1. Different starting offsets and a backlog many bounded reads deep:
  // the retired cursor is still traversing it while the live window sits at the
  // far end, so draining first is not enough on its own.
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(harness, { recordTheRequest: true });
    appendOversizeRestoreWindow(harness, ACK_SCAN_WINDOW_BYTES * 10);
    const live = openReplacementCycleWithRequest(harness, dead);
    const retiredFrom = harness.runner.capsuleAckRetired?.from;
    const liveFrom = harness.ackWindowFrom();
    assert.equal(harness.runner.capsuleAckRetired?.owed, 1, 'setup: A answer is still owed');
    assert.ok(retiredFrom < liveFrom,
      `setup: the retired cursor is behind the live window (${retiredFrom} < ${liveFrom})`);
    assert.ok(liveFrom - retiredFrom > ACK_SCAN_WINDOW_BYTES,
      'setup: and more than one bounded read behind it');

    // A completes after B was queued; B's own answer follows it, so a reader
    // that classifies in order finds A first and B second.
    appendExactCapsuleAck(harness);
    const aAnswerEnd = transcriptSize(harness);
    appendExactCapsuleAck(harness);
    harness.writeStopRecordAtTranscriptEnd();

    harness.drive();
    harness.flushControl();
    assert.equal(clearIntentEventCount(harness), 0,
      'an unclassified A answer must not authorize B -- MUST be red on d950ebc');
    assert.equal(clearTextWrites(harness), 0);
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
    assert.equal(ackObservedCount(harness), 0);
    const deferred = harness.events('capsule-ack-scan-deferred');
    assert.equal(deferred.length, 1, 'the wait is one named event, not silence');
    assert.equal(deferred[0].detail?.cycle_id, live);
    assert.ok(deferred[0].detail?.retired_from < deferred[0].detail?.from);

    // BOUNDED PROGRESS: the retired reader advances one window per tick and
    // reaches A's answer; only then does the live scan resume.
    driveUntil(harness, () => retiredConsumed(harness).length > 0, 40);
    assert.equal(retiredConsumed(harness).length, 1, 'A answer discharges A debt');
    assert.ok(retiredConsumed(harness)[0].at >= aAnswerEnd - 1,
      'and it is the record at A position, not some later literal');
    assert.equal(harness.runner.capsuleAckRetired, null, 'the ledger is empty');

    // A REAL B ANSWER SITTING BEHIND THE RETIRED ONE is still collected.
    driveUntil(harness, () => ackObservedCount(harness) > 0, 12);
    assert.equal(ackObservedCount(harness), 1, 'B own answer, which sat behind A, IS its evidence');
    assert.equal(harness.runner.capsuleAck?.cycle_id, live);
    driveUntil(harness, () => harness.runner.phase === 'prepared', 8);
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'exactly one clear');
    assert.equal(capsuleTextWriteCount(harness), 2,
      'and one capsule request per cycle throughout: the retired one and the live one');
  } finally {
    harness.cleanup();
  }

  // ARM 2. PARTIAL TAILS. A half-written record at the end of the transcript is
  // not evidence and must not be stepped over by either reader, nor strand the
  // answer it is about to become.
  const partial = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(partial, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(partial, dead);
    appendExactCapsuleAck(partial);

    // B's answer arrives HALF-WRITTEN: the literal is there, the closing
    // assistant tag is not.
    const head = '\n{"parentUuid":"p","isSidechain":false,"message":{"role":"assistant",'
      + `"content":[{"type":"text","text":"${CAPSULE_ACK_LITERAL}"}],"filler":"${'x'.repeat(600)}"}`;
    fs.appendFileSync(partial.fixture.transcriptPath, head);
    partial.writeStopRecordAtTranscriptEnd();

    driveUntil(partial, () => retiredConsumed(partial).length > 0, 10);
    partial.flushControl();
    assert.equal(retiredConsumed(partial).length, 1, 'A complete answer is consumed as A');
    assert.equal(ackObservedCount(partial), 0, 'the half-written record is not evidence');
    assert.equal(clearTextWrites(partial), 0);
    assert.equal(partial.runner._capsuleAckAuthorizes(live), false);

    // The rest of the line lands. Nothing was stranded: the completed record is
    // B's own answer and buys exactly one clear.
    fs.appendFileSync(partial.fixture.transcriptPath, ',"type":"assistant","uuid":"u"}\n');
    driveUntil(partial, () => ackObservedCount(partial) > 0, 10);
    assert.equal(ackObservedCount(partial), 1, 'the completed record acks for B');
    assert.equal(partial.runner.capsuleAck?.cycle_id, live);
    driveUntil(partial, () => partial.runner.phase === 'prepared', 8);
    partial.flushControl();
    assert.equal(clearTextWrites(partial), 1, 'exactly one clear');
  } finally {
    partial.cleanup();
  }
});

// ===========================================================================
// RE-REVIEW 5558958106 (GPT). S1/S2/S3 pass and the count-based cap remedy was
// explicitly accepted. Two ownership paths remained, both HIGH, both replayed
// here in the real harness from his drafts.
//
// T1 — RE-REQUESTING MUST NOT ERASE AN OLDER POSSIBLE COMPLETION, AND ACCEPTING
// ONE ANSWER MUST NOT ERASE ANOTHER STILL POSSIBLE. The one-request latch is
// PER PROCESS, so a RESTORED cycle's writer issues a second request. The
// original completion then satisfies the first; `hadAck` -- a boolean meaning
// "an answer was seen" -- suppressed retirement at abandonment; and the second
// completion arrived owned by nobody and authorized the replacement cycle.
// Measured authorized(B)=true, retiredOwed=0, consumed=0. His sequence
// deliberately never crosses a `/clear` (a successful clear changes session
// identity, so no old answer crosses into a new transcript): the cycle is
// abandoned from a checkpoint HOLD, before any clear commits.
//
// T2 — INABILITY TO DURABLY ESTABLISH OWNERSHIP IS A SAFETY CONDITION, NOT A
// DIAGNOSTIC. A classification write failure was called nonfatal "costing only
// a re-request". False at the FIRST write position: with no durable debt, an
// ordinary restore read the absence as clean legacy state, re-read the answer
// it had correctly rejected in memory, and authorized the live cycle. His
// matched control is the discriminator -- when the debt WAS persisted and only
// a later frontier write failed, replaying the saved debt rejects it.
// ===========================================================================

// An IO collaborator that fails the cycle-state write at the REAL filesystem
// boundary inside the real atomic-state implementation (atomicUpdate's
// renameSync onto the cycle file), rather than at a stand-in writer. `when`
// decides, from the text about to be committed, whether this write fails.
// ─── NON-VACUITY GUARD FOR THE WRITE INJECTIONS ──────────────────────────────
// WHY THIS EXISTS, and it is not hypothetical. An injection predicate that was
// correct when written went over-broad as the durable record grew: once the
// classification existed for every live cycle, "the commit carries a
// classification" matched ordinary transport transitions too, so `transport.tick()`
// threw, the runner disabled automation, and the vector proved only that a
// DEAD runner writes no clear. It stayed green for two review rounds.
//
// Fixing the predicate stops that instance. This stops the CLASS: every vector
// that injects a cycle-state write failure asserts that the runner is still
// OPERATING under it, not merely that it is safe. A vector that is safe because
// nothing is running is vacuous, and vacuity is invisible without an assertion
// that says so.
//
// `automation-disabled` is the live event (it carries `detail.code`); the two
// codes below are the ones that mean the transport itself could not be ticked
// or its result could not be read. Both verified against pty-runner.mjs rather
// than assumed from a name.
const TRANSPORT_UNUSABLE_CODES = Object.freeze([
  'runner-transport-tick-failed',
  'runner-transport-result-field-missing',
]);

function assertTransportStillTicking(harness, label) {
  const unusable = harness.events('automation-disabled')
    .map((event) => event.detail?.code)
    .filter((code) => TRANSPORT_UNUSABLE_CODES.includes(code));
  assert.deepEqual(unusable, [],
    `${label}: the injection must exercise a classification-write failure, `
    + 'NOT a failed transport tick -- a safe-because-dead runner proves nothing');
  assert.equal(harness.runner.automationEnabled, true,
    `${label}: and the runner must still be operating under the injection`);
}

function failingCycleStateFs(fixture, when) {
  const cyclePath = path.join(fixture.memRoot, 'runtime', 'auto-clear-cycle.json');
  const normalized = (target) => String(target).split('\\').join('/');
  const cycleTail = normalized(cyclePath);
  let pendingText = null;
  return {
    ...fs,
    writeFileSync(target, text, ...rest) {
      // atomicUpdate writes a temp file then renames it onto the target.
      if (normalized(target).startsWith(`${cycleTail}.`)) pendingText = String(text);
      return fs.writeFileSync(target, text, ...rest);
    },
    renameSync(from, to, ...rest) {
      if (normalized(to) === cycleTail && pendingText !== null && when(pendingText)) {
        pendingText = null;
        throw Object.assign(
          new Error('synthetic EACCES committing the cycle state'), { code: 'EACCES' },
        );
      }
      pendingText = null;
      return fs.renameSync(from, to, ...rest);
    },
  };
}

test('GPT-T1a a restored cycle that re-requests keeps ownership of its SECOND possible completion', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    // Process one: the cycle asks once, and the host records the request. No
    // answer is saved yet.
    const old = driveToRequestedWithOneMoreRequest(harness);
    appendCapsuleRequestRecord(harness);
    harness.drive();

    // Process two restores the SAME cycle and its writer asks again -- which is
    // correct, and is also the moment two completions become possible.
    harness.relaunch();
    harness.drive();
    assert.equal(harness.core.state.cycle_id, old, 'setup: the same cycle, carried on disk');
    assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the new process really re-requests');
    // Read while the cycle is still live: once it is replaced, the record on
    // disk belongs to the replacement.
    const afterReRequest = answerAccountOf(harness);

    // The capsule turn outgrows the Stop snapshot, so the core holds; the scan
    // later in that same tick accepts the resumed ORIGINAL completion, and no
    // clear is prepared because the core result is a HOLD.
    appendCapsuleRunNoise(harness);
    appendExactCapsuleAck(harness);
    assert.equal(harness.drive().state.state, 'HOLD:checkpoint-transcript-short');
    assert.equal(harness.runner._capsuleAckAuthorizes(old), true,
      'setup: the first completion is this cycle own answer and is accepted');
    assert.equal(clearIntentEventCount(harness), 0, 'setup: but no clear is prepared under a HOLD');
    const beforeAbandonment = answerAccountOf(harness);

    // Abandoned before any clear commits. One completion is still possible.
    setPressure(harness, BELOW_THRESHOLD);
    assert.equal(harness.drive().state.state, 'idle');

    const live = openReplacementCycleWithRequest(harness, old);
    // Dequeue order: the repeat request's record, then its completion. B has
    // answered nothing.
    appendCapsuleRequestRecord(harness);
    appendExactCapsuleAck(harness);
    harness.drive();
    harness.flushControl();
    assert.equal(clearIntentEventCount(harness), 0,
      'the second completion of an abandoned cycle cannot mint a clear for the replacement -- MUST be red on 46073b9');
    assert.equal(clearTextWrites(harness), 0);
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
      'a completion the replacement never asked for may not authorize it -- MUST be red on 46073b9');
    assert.equal(ackObservedCount(harness), 1,
      'and it is not latched as the replacement evidence: only the first, owned, answer ever was');

    // MECHANISM, after the behaviour: the debt was arithmetic, not a boolean,
    // and the issued-request tally crossed the relaunch in the cycle's own
    // durable record -- which is what made the second completion accountable.
    assert.deepEqual(afterReRequest, { requests_issued: 2, answers_settled: 0 },
      'the restored cycle durably owed TWO possible answers before any arrived');
    assert.deepEqual(beforeAbandonment, { requests_issued: 2, answers_settled: 1 },
      'and exactly one of them had been accounted for when it was abandoned');
    const retired = harness.events('capsule-ack-retired');
    assert.equal(retired.length, 1, 'exactly one retirement, at the abandonment');
    assert.equal(retired[0].detail?.cycle_id, old);
    assert.equal(retired[0].detail?.count, 1,
      'requests issued minus answers settled -- two minus one');
    assert.deepEqual(
      retiredConsumed(harness).map((d) => [d.cycle_id, d.owed]), [[old, 0]],
      'and the second completion discharged it rather than authorizing anyone');

    // A GENUINE CURRENT-CYCLE ANSWER AFTER THE OLDER RESPONSES ARE RECONCILED
    // still buys exactly one clear.
    appendExactCapsuleAck(harness);
    driveUntil(harness, () => harness.runner.phase === 'prepared', 8);
    assert.equal(harness.runner.capsuleAck?.cycle_id, live);
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'exactly one clear, on the replacement own answer');
    for (let i = 0; i < 6; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'and never a second');
  } finally {
    harness.cleanup();
  }
});

test('GPT-T1b ZERO, ONE and TWO completion possibilities across restore, and a new session carries none', () => {
  // ARM 1, ZERO. A cycle that never issued a request is owed nothing, so its
  // abandonment must retire nothing -- otherwise a cancelled or never-seen
  // prior request would eat the next cycle's genuine answer.
  const zero = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(zero.drive().state.state, 'pressure');
    const dead = zero.core.state.cycle_id;
    assert.equal(capsuleTextWriteCount(zero), 0, 'setup: no request was ever issued');
    setPressure(zero, BELOW_THRESHOLD);
    assert.equal(zero.drive().state.state, 'idle');
    assert.equal(zero.runner.capsuleAckRetired, null, 'nothing is owed, so nothing is retired');
    assert.equal(zero.events('capsule-ack-retired').length, 0);

    // The next cycle therefore keeps its own answer.
    const live = openReplacementCycleWithRequest(zero, dead);
    appendExactCapsuleAck(zero);
    driveUntil(zero, () => zero.runner.phase === 'prepared', 8);
    assert.equal(zero.runner.capsuleAck?.cycle_id, live);
    zero.flushControl();
    assert.equal(clearTextWrites(zero), 1, 'exactly one clear');
    assert.equal(retiredConsumed(zero).length, 0, 'and no answer was eaten by a phantom debt');
  } finally {
    zero.cleanup();
  }

  // ARM 3, ONE. One request answered once, then abandoned: no completion is
  // still possible, so again nothing is retired.
  const one = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = driveToRequestedWithOneMoreRequest(one);
    // Held, exactly as in GPT-T1a, so the answer is accepted without a clear
    // being prepared -- the two arms differ only in how many requests went out.
    appendCapsuleRunNoise(one);
    appendExactCapsuleAck(one);
    assert.equal(one.drive().state.state, 'HOLD:checkpoint-transcript-short');
    assert.equal(one.runner._capsuleAckAuthorizes(dead), true, 'setup: its own answer arrived');
    setPressure(one, BELOW_THRESHOLD);
    one.drive();
    assert.equal(one.core.state.state, 'idle');
    assert.equal(one.runner.capsuleAckRetired, null,
      'one request, one answer: the account is square and no debt is carried');

    const live = openReplacementCycleWithRequest(one, dead);
    appendExactCapsuleAck(one);
    driveUntil(one, () => one.runner.phase === 'prepared', 8);
    assert.equal(one.runner.capsuleAck?.cycle_id, live);
    one.flushControl();
    assert.equal(clearTextWrites(one), 1, 'the next cycle own answer still clears it');
    assert.equal(retiredConsumed(one).length, 0);
  } finally {
    one.cleanup();
  }

  // ARM 2, TWO, AND THE RECONCILED POSITIVE. Same shape as GPT-T1a but the
  // assertion is the completion: once the outstanding older answer has been
  // reconciled, the live cycle's own answer buys exactly one clear and the
  // older one bought none. Red before the correction, where the older answer
  // cleared first.
  const two = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const old = driveToRequestedWithOneMoreRequest(two);
    appendCapsuleRequestRecord(two);
    two.drive();
    two.relaunch();
    two.drive();
    assert.equal(capsuleTextWriteCount(two), 1, 'setup: the restore re-requests');
    appendCapsuleRunNoise(two);
    appendExactCapsuleAck(two);
    assert.equal(two.drive().state.state, 'HOLD:checkpoint-transcript-short');
    setPressure(two, BELOW_THRESHOLD);
    assert.equal(two.drive().state.state, 'idle');
    const live = openReplacementCycleWithRequest(two, old);

    // The outstanding older completion arrives, then the live cycle's own.
    appendCapsuleRequestRecord(two);
    appendExactCapsuleAck(two);
    for (let i = 0; i < 3; i += 1) two.drive();
    two.flushControl();
    assert.equal(clearTextWrites(two), 0,
      'the older completion buys nothing -- MUST be red on 46073b9');
    appendExactCapsuleAck(two);
    driveUntil(two, () => two.runner.phase === 'prepared', 8);
    assert.equal(two.runner.capsuleAck?.cycle_id, live);
    two.flushControl();
    assert.equal(clearTextWrites(two), 1, 'and the live cycle own answer buys exactly one');
  } finally {
    two.cleanup();
  }

  // ARM 4, A GENUINELY NEW SESSION. Its transcript is a different file, so it
  // cannot contain the previous session's answer, and none of the previous
  // session's accounting may cross into it.
  const rebound = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(rebound, { recordTheRequest: true });
    openReplacementCycleWithRequest(rebound, dead);
    assert.equal(rebound.runner.capsuleAckRetired?.owed, 1, 'setup: a debt is outstanding');
    assert.ok(rebound.runner.capsuleAckAccount !== null, 'setup: and an answer account exists');

    const nextTranscript = transcriptPathFor({
      cwd: rebound.fixture.cwd, sessionId: NEXT_SESSION_ID, homeDir: rebound.fixture.homeDir,
    });
    fs.mkdirSync(path.dirname(nextTranscript), { recursive: true });
    fs.writeFileSync(nextTranscript, '{"type":"summary"}\n');

    assert.equal(
      rebound.runner._rebindAfterClear(clearReceiptFor(rebound, NEXT_SESSION_ID)), true);
    assert.equal(rebound.runner.capsuleAckRetired, null,
      'the ledger indexes the old transcript and does not cross a session');
    assert.equal(rebound.runner.capsuleAckAccount, null, 'nor does the answer account');
    assert.equal(rebound.runner.capsuleAckClassifiedThrough, 0, 'nor the exclusion frontier');

    // The OLD session's answer, appended to the old file, can never be read by
    // the new session: the transcript path is resolved from the bound session.
    appendExactCapsuleAck(rebound);
    for (let i = 0; i < 6; i += 1) rebound.drive();
    rebound.flushControl();
    assert.equal(ackObservedCount(rebound), 0,
      'an answer in the previous session transcript is not evidence after the rebind');
    assert.equal(clearTextWrites(rebound), 0);
  } finally {
    rebound.cleanup();
  }
});

test('GPT-T2 a classification write that never establishes ownership fails CLOSED on restore', () => {
  // ARM 1. THE FIRST durable write is refused, at the real cycle-state
  // filesystem boundary. The in-memory rejection is correct; the restore must
  // not then read the absence as clean legacy state.
  const firstWrite = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    const dead = retireAnOutstandingRequest(firstWrite, { recordTheRequest: true });
    // From here every cycle-state commit that would carry a classification for
    // a DIFFERENT cycle than the one already recorded is refused.
    firstWrite.core.fs = failingCycleStateFs(firstWrite.fixture, (text) => {
      try {
        const next = JSON.parse(text);
        return next.ack_classification !== null && next.ack_classification !== undefined;
      } catch { return false; }
    });
    const live = openReplacementCycleWithRequest(firstWrite, dead);
    assert.equal(classificationOf(firstWrite), null,
      'setup: the live cycle ownership never became durable');

    appendExactCapsuleAck(firstWrite);
    for (let i = 0; i < 3; i += 1) firstWrite.drive();
    firstWrite.flushControl();
    assertTransportStillTicking(firstWrite, 'T2 first-write');
    assert.equal(firstWrite.runner._capsuleAckAuthorizes(live), false,
      'setup: in memory the old answer is still correctly rejected');
    // Liveness witness: the drain ran under the injection.
    assert.equal(retiredConsumed(firstWrite).length, 1,
      'setup: the drain RAN and consumed the old answer as the retired debt');
    assert.ok(firstWrite.events('capsule-ack-classification-write-failed').length >= 1,
      'setup: and the failure is named');

    // Storage works again -- the relaunch builds a fresh core with the real
    // `fs`. Ordinary same-session restore over the untouched saved cycle.
    firstWrite.relaunch();
    firstWrite.drive();
    firstWrite.flushControl();
    assert.equal(clearIntentEventCount(firstWrite), 0,
      'unknown ownership may not be read as clean legacy state -- MUST be red on 46073b9');
    assert.equal(clearTextWrites(firstWrite), 0);
    assert.equal(firstWrite.runner._capsuleAckAuthorizes(live), false);
    assert.equal(ackObservedCount(firstWrite), 0, 'the rejected answer is not re-read at all');

    // EXPLICIT RECOVERY, not a park: named by cause, one fresh request, and a
    // window that opens at the transcript end.
    const unrecoverable = firstWrite.events('capsule-ack-window-unrecoverable');
    assert.equal(unrecoverable.length, 1, 'named once, by cause');
    assert.equal(unrecoverable[0].detail?.code, 'ack-classification-unestablished');
    assert.equal(unrecoverable[0].detail?.recovery, 'capsule-request-pending');
    assert.equal(capsuleTextWriteCount(firstWrite), 1, 'one fresh request, not a park');
    assert.match(allRunnerLogs(firstWrite), /ack-classification-unestablished/);
    for (let i = 0; i < 30; i += 1) firstWrite.drive();
    assert.equal(capsuleTextWriteCount(firstWrite), 1, 'still exactly one after 30 ticks');

    appendExactCapsuleAck(firstWrite);
    driveUntil(firstWrite, () => firstWrite.runner.phase === 'prepared', 8);
    firstWrite.flushControl();
    assert.equal(clearTextWrites(firstWrite), 1, 'recovery ends in exactly one clear');
  } finally {
    firstWrite.cleanup();
  }

  // ARM 2, THE MATCHED CONTROL. The debt WAS persisted and only a LATER
  // frontier write fails. Replaying the saved debt rejects the old answer, so
  // the defect is specifically ownership never becoming durable -- not every
  // failed write.
  const laterWrite = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(laterWrite, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(laterWrite, dead);
    assert.equal(classificationOf(laterWrite)?.debts_outstanding, 1,
      'setup: the debt IS durable before anything fails');

    // The frontier the REQUEST legitimately established, which is now the
    // baseline this arm measures against (V1): what must not reach the disk is
    // the LATER advance, the one the consumed answer produces.
    const frontierAtRequest = classificationOf(laterWrite)?.classified_through ?? 0;
    assert.ok(frontierAtRequest > 0,
      'setup: issuing the request durably established its own replacement exclusion');
    // Now refuse only the writes that would ADVANCE the exclusion frontier.
    // Comparing against what is already on disk matters: a request legitimately
    // establishes a non-zero frontier of its own (re-review 5608270301, V1), so
    // a predicate of "> 0" would refuse every ordinary transition too and
    // disable automation instead of exercising a frontier-write failure.
    laterWrite.core.fs = failingCycleStateFs(laterWrite.fixture, (text) => {
      try {
        const next = JSON.parse(text);
        const onDisk = laterWrite.cycleState();
        return (next.ack_classification?.classified_through ?? 0)
          > (onDisk.ack_classification?.classified_through ?? 0);
      } catch { return false; }
    });
    appendExactCapsuleAck(laterWrite);
    for (let i = 0; i < 3; i += 1) laterWrite.drive();
    assertTransportStillTicking(laterWrite, 'T2 later-write');
    // Liveness witness: the drain ran under the injection.
    assert.equal(retiredConsumed(laterWrite).length, 1,
      'setup: the drain RAN under the injection and consumed in memory');
    assert.ok(laterWrite.events('capsule-ack-classification-write-failed').length >= 1);
    assert.equal(classificationOf(laterWrite)?.classified_through, frontierAtRequest,
      'setup: and the later frontier advance never reached the disk');

    laterWrite.relaunch();
    laterWrite.drive();
    laterWrite.flushControl();
    assert.equal(clearIntentEventCount(laterWrite), 0,
      'replaying the saved debt rejects the old answer: the safe case stays safe');
    assert.equal(clearTextWrites(laterWrite), 0);
    assert.equal(laterWrite.runner._capsuleAckAuthorizes(live), false);
    assert.equal(laterWrite.events('capsule-ack-retired-restored').length, 1,
      'and it is the REBUILT debt that does it, not a refusal to restore');
    assert.equal(laterWrite.events('capsule-ack-window-unrecoverable').length, 0,
      'the window was usable, so no re-request was needed');

    appendExactCapsuleAck(laterWrite);
    driveUntil(laterWrite, () => laterWrite.runner.phase === 'prepared', 8);
    laterWrite.flushControl();
    assert.equal(clearTextWrites(laterWrite), 1, 'and the live cycle own answer clears it');
  } finally {
    laterWrite.cleanup();
  }

  // ARM 3. AN EMPTY WINDOW WITH NO RECORD IS NOT A SAFETY PROBLEM, and must
  // not be turned into one: a legacy or just-created cycle whose window cannot
  // yet contain any evidence restores normally. This is what keeps the absent
  // rule from weakening the #90 restore into a re-request on every launch.
  const legacy = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const cycleId = driveToRequestedWithOneMoreRequest(legacy);
    legacy.writeStopRecordAtTranscriptEnd();
    const state = legacy.cycleState();
    delete state.ack_classification;
    legacy.writeCycleState(state);
    assert.equal(
      legacy.cycleState().ack_boundary.transcript_offset >= transcriptSize(legacy), true,
      'setup: the cycle window is empty -- nothing could have arrived in it');

    legacy.relaunch();
    legacy.drive();
    assert.equal(legacy.events('capsule-ack-window-unrecoverable').length, 0,
      'an empty window with no record restores normally');
    assert.equal(legacy.events('capsule-ack-watch-restored').length, 1);
    assert.equal(legacy.runner.capsuleAckWatch?.cycle_id, cycleId);

    appendExactCapsuleAck(legacy);
    driveUntil(legacy, () => legacy.runner.phase === 'prepared', 8);
    legacy.flushControl();
    assert.equal(clearTextWrites(legacy), 1, 'and the cycle own answer still clears it');
  } finally {
    legacy.cleanup();
  }
});

// ACCOUNTING THROUGH SPENDING, the third of the reviewer's three ("retain
// accounting through abandonment, restore AND spending"). Spending nulls both
// halves of the evidence inside _writeControl, without passing through the
// invalidation path at all, so a retirement keyed on held evidence cannot see
// a spent cycle. The retirement is therefore keyed on the cycle's answer
// ACCOUNT, at the lifecycle boundary.
//
// SCOPE, STATED: the spend here is real -- a real re-request, a real answer, a
// real prepared clear and a real control write -- but the cycle REPLACEMENT is
// driven by handing _syncCapsuleAckLifecycle a successor state, which is the
// same call shape the production narrow-abandonment path uses when
// beginClearSubmission drops the cycle inside the refusal. Driving a full
// clear through to release and on to a new cycle in the SAME session was not
// constructible through tick() in this harness, so this vector pins the
// accounting property rather than that end-to-end sequence.
test('GPT-T1c accounting survives SPENDING: a cleared cycle that was re-requested still owes its second completion', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    // A cycle that asked once, then a restore whose writer asked again. Two
    // completions are possible from here.
    const old = driveToRequestedWithOneMoreRequest(harness);
    appendCapsuleRequestRecord(harness);
    harness.drive();
    harness.relaunch();
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the restore re-requests');

    // The first completion arrives and is this cycle's own answer. It is SPENT
    // on a real clear, which nulls both halves of the evidence.
    appendExactCapsuleAck(harness);
    driveUntil(harness, () => harness.runner.phase === 'prepared', 8);
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'setup: the clear is written');
    assert.equal(harness.events('capsule-ack-spent').length, 1, 'setup: and the ack is spent');
    assert.equal(harness.ackHeld(), false, 'setup: so no evidence is held any more');
    assert.equal(harness.ackWindowOpen(), false);

    // The cycle is replaced. Same session, same transcript -- the shape a
    // non-rotated clear receipt leaves behind.
    const successor = { ...harness.core.state, state: 'pressure', cycle_id: 'cycle-after-the-spend' };
    harness.runner._syncCapsuleAckLifecycle({ state: successor });

    const retired = harness.events('capsule-ack-retired');
    assert.equal(retired.length, 1,
      'the spent cycle still owed one completion, and the boundary carried it -- MUST be red on 46073b9');
    assert.equal(retired[0].detail?.cycle_id, old);
    assert.equal(retired[0].detail?.count, 1, 'two issued minus one settled');
    assert.equal(harness.runner.capsuleAckRetired?.owed, 1);
    assert.equal(harness.runner.capsuleAckAccount, null,
      'and the account dies with the cycle it belonged to');

    // The outstanding completion now arrives. It discharges the old debt and
    // authorizes nothing for the successor.
    appendCapsuleRequestRecord(harness);
    appendExactCapsuleAck(harness);
    harness.runner._drainRetiredCapsuleAcks();
    assert.deepEqual(
      retiredConsumed(harness).map((d) => [d.cycle_id, d.owed]), [[old, 0]],
      'the second completion of the spent cycle discharged its own debt');
    assert.equal(harness.runner._capsuleAckAuthorizes('cycle-after-the-spend'), false);
    assert.equal(clearTextWrites(harness), 1, 'and no second clear was ever written');
  } finally {
    harness.cleanup();
  }
});

// ===========================================================================
// RE-REVIEW 5559815305 (GPT). All 40 earlier source-extract cases pass and the
// fail-closed storage policy is accepted. Two paths remained, and his closing
// framing is the design statement both fall out of:
//
//   "Unknown evidence awaiting recovery, accepted current-cycle evidence
//    awaiting spend, and excluded foreign/spent evidence are different durable
//    meanings. U1 turns unknown into clean zeros; U2 treats accepted as
//    excluded."
//
// The durable record carried TWO meanings -- a frontier and an account -- and
// was being asked to carry three. Both corrections are writer/restore
// transitions in the existing state; no watcher, file or service was added.
//
// U1 (HIGH) is the mechanism that closed T2 turning on itself: writing the
// classification unconditionally for every live cycle is what makes `present`
// the norm, and a record of valid zeros certifies the old unread window as
// clean one tick after the refusal. Any DEFERRED recovery -- telemetry hold,
// busy composer -- therefore reopened it.
//
// U2 (MED) is a regression this branch introduced, and it passes on 46073b9:
// settling an answer advances the frontier past it, which correctly stops it
// being re-read and incorrectly made it indistinguishable from a foreign
// answer, so a restart discarded a valid unspent acknowledgement and asked
// again. A #90 liveness regression, not corrupt state.
// ===========================================================================

// The injection used by the T2, U1 and V1 setups: refuse, at the real
// filesystem boundary, exactly the commits in which the RUNNER establishes or
// changes a classification.
//
// WHY IT COMPARES AGAINST THE DISK rather than just testing for a non-null
// field: since T2 the record exists for every live cycle, so an ordinary
// transport transition carries it along unchanged, and a predicate of "carries
// a classification" would refuse those too -- disabling automation instead of
// exercising a classification-write failure. A commit that NULLS the field is
// also allowed through, because that is `_startPressure` opening a new cycle,
// not the runner recording ownership.
function refuseClassificationWrites(harness) {
  harness.core.fs = failingCycleStateFs(harness.fixture, (text) => {
    try {
      const next = JSON.parse(text).ack_classification ?? null;
      if (next === null) return false;
      const onDisk = harness.cycleState().ack_classification ?? null;
      return JSON.stringify(next) !== JSON.stringify(onDisk);
    } catch { return false; }
  });
}

// Reach the U1 shape: a saved cycle whose ownership never became durable, with
// a valid boundary that PRECEDES a foreign answer. Returns { dead, live }.
function unestablishedOwnershipOverForeignAnswer(harness) {
  const dead = retireAnOutstandingRequest(harness, { recordTheRequest: true });
  refuseClassificationWrites(harness);
  const live = openReplacementCycleWithRequest(harness, dead);
  assert.equal(classificationOf(harness), null,
    'setup: the live cycle ownership never became durable');
  appendExactCapsuleAck(harness); // A's answer, not B's.
  for (let i = 0; i < 3; i += 1) harness.drive();
  // NON-VACUITY, FIRST: everything below is only evidence if the runner is
  // still running. Asserted before the safety claims, so a vector that has
  // quietly become "a dead runner writes nothing" fails here rather than
  // passing for the wrong reason.
  assertTransportStillTicking(harness, 'unestablished-ownership setup');
  assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
    'setup: in memory the foreign answer is still correctly rejected');
  // THE LIVENESS WITNESS, now deliberate rather than incidental: the drain
  // cannot have consumed the foreign answer unless the reader actually ran
  // under the injection. This is the assertion that kept these vectors from
  // being wholly vacuous while the predicate was wrong.
  assert.equal(retiredConsumed(harness).length, 1,
    'setup: the drain RAN under the injection and consumed it as the retired debt');
  return { dead, live };
}

function unrecoverableCodes(harness) {
  return harness.events('capsule-ack-window-unrecoverable').map((e) => e.detail?.code);
}

test('GPT-U1a a DEFERRED unestablished recovery stays unresolved across ticks and a restart', () => {
  for (const mode of ['telemetry-hold', 'composer-busy']) {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      const { live } = unestablishedOwnershipOverForeignAnswer(harness);

      // Storage works again, and the saved cycle and transcript survive.
      harness.relaunch();
      // ...but the safe re-request cannot go out yet.
      if (mode === 'telemetry-hold') setPressure(harness, TELEMETRY_MISSING);
      else harness.runner.handleOperatorData('an unsent operator draft');

      harness.drive();
      assert.equal(harness.runner._capsuleAckAuthorizes(live), false,
        `${mode}: setup: the first tick refuses, as it already did`);
      assert.equal(capsuleTextWriteCount(harness), 0, `${mode}: setup: and nothing is requested`);
      assert.ok(unrecoverableCodes(harness).includes('ack-classification-unestablished'),
        `${mode}: setup: named by cause`);

      // THE DEFECT. One more ordinary tick. Before the correction the
      // unconditional persistence had already written valid zeros, so this tick
      // reinitialized, bypassed the guard and reopened the original boundary.
      harness.drive();
      assert.equal(ackObservedCount(harness), 0,
        `${mode}: a deferred recovery must not reopen the old unowned answer -- MUST be red on 44ae7a4`);
      assert.equal(harness.runner._capsuleAckAuthorizes(live), false, `${mode}: nor authorize on it`);
      assert.equal(clearIntentEventCount(harness), 0, `${mode}: and no clear intent is minted`);
      assert.equal(clearTextWrites(harness), 0);
      for (let i = 0; i < 20; i += 1) harness.drive();
      assert.equal(ackObservedCount(harness), 0, `${mode}: still so after 20 ticks`);
      assert.equal(capsuleTextWriteCount(harness), 0, `${mode}: still deferred, still nothing requested`);
      assertTransportStillTicking(harness, `${mode}: U1a deferred`);

      // MECHANISM: the unresolved disposition is in the cycle's own record, so
      // it is not an in-memory latch.
      assert.equal(classificationOf(harness)?.pending?.code, 'ack-classification-unestablished',
        `${mode}: the disposition is durable, not just this tick's`);

      // A SAME-SESSION RESTART WHILE RECOVERY IS STILL PENDING must also stay
      // refused -- which is what makes the durable disposition load-bearing
      // rather than decorative.
      harness.relaunch();
      if (mode === 'composer-busy') harness.runner.handleOperatorData('still unsent');
      for (let i = 0; i < 3; i += 1) harness.drive();
      assert.equal(ackObservedCount(harness), 0,
        `${mode}: a restart while pending does not certify the window either`);
      assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
      assert.equal(clearTextWrites(harness), 0);
      assert.equal(classificationOf(harness)?.pending?.code, 'ack-classification-unestablished');
    } finally {
      harness.cleanup();
    }
  }
});

test('GPT-U1b releasing each deferral resolves the disposition with exactly one request and one clear', () => {
  for (const mode of ['telemetry-hold', 'composer-busy']) {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      const { live } = unestablishedOwnershipOverForeignAnswer(harness);
      harness.relaunch();
      if (mode === 'telemetry-hold') setPressure(harness, TELEMETRY_MISSING);
      else harness.runner.handleOperatorData('an unsent operator draft');
      for (let i = 0; i < 3; i += 1) harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 0, 'setup: still deferred');
      assert.equal(clearTextWrites(harness), 0,
        `${mode}: nothing may clear while recovery is pending -- MUST be red on 44ae7a4`);

      // RELEASE. Telemetry returns, or the operator submits their draft.
      if (mode === 'telemetry-hold') setPressure(harness, ABOVE_THRESHOLD);
      else harness.operator(Buffer.from('\r'));
      for (let i = 0; i < 3; i += 1) harness.drive();
      assert.equal(ackObservedCount(harness), 0,
        `${mode}: releasing the deferral must not accept the old unowned answer -- MUST be red on 44ae7a4`);
      assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
      driveUntil(harness, () => capsuleTextWriteCount(harness) === 1, 10);
      assertTransportStillTicking(harness, `${mode}: U1b release`);
      assert.equal(capsuleTextWriteCount(harness), 1,
        `${mode}: the deferral releases exactly one request`);
      assert.equal(classificationOf(harness)?.pending ?? null, null,
        'and issuing it with its ownership recorded is what resolves the disposition');
      assert.ok(harness.ackWindowFrom() >= transcriptSize(harness),
        'whose window opens at the end, so the old unowned answer stays excluded');
      assert.equal(ackObservedCount(harness), 0, 'nothing has been accepted yet');

      // The fresh answer to the fresh request buys exactly one clear.
      appendExactCapsuleAck(harness);
      driveUntil(harness, () => harness.runner.phase === 'prepared', 10);
      assert.equal(harness.runner.capsuleAck?.cycle_id, live);
      harness.flushControl();
      assert.equal(clearTextWrites(harness), 1, `${mode}: exactly one clear`);
      for (let i = 0; i < 6; i += 1) harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 1, 'and exactly one request, ever');
    } finally {
      harness.cleanup();
    }
  }

  // THE IMMEDIATE-RECOVERY POSITIVE, retained: with nothing deferring it the
  // request goes out on the refusing tick itself, so the disposition is
  // resolved before any second restore can see it. This is the path GPT-T2
  // arm 1 covers; it must keep working unchanged.
  const immediate = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const { live } = unestablishedOwnershipOverForeignAnswer(immediate);
    immediate.relaunch();
    immediate.drive();
    assert.equal(capsuleTextWriteCount(immediate), 1,
      'no deferral, so the safe re-request goes out immediately');
    assert.equal(classificationOf(immediate)?.pending ?? null, null, 'and resolves the disposition');
    assert.equal(ackObservedCount(immediate), 0);
    appendExactCapsuleAck(immediate);
    driveUntil(immediate, () => immediate.runner.phase === 'prepared', 8);
    assert.equal(immediate.runner.capsuleAck?.cycle_id, live);
    immediate.flushControl();
    assert.equal(clearTextWrites(immediate), 1, 'exactly one clear');
  } finally {
    immediate.cleanup();
  }
});

test('GPT-U2a an ACCEPTED but unspent completion survives a restart without re-requesting', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const live = driveToRequestedWithOneMoreRequest(harness);
    // Accepted under a checkpoint HOLD, so no clear is prepared and nothing is
    // spent -- the answer is valid, current, and still owed its clear.
    appendCapsuleRunNoise(harness);
    appendExactCapsuleAck(harness);
    assert.equal(harness.drive().state.state, 'HOLD:checkpoint-transcript-short');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), true, 'setup: accepted');
    assert.equal(clearIntentEventCount(harness), 0, 'setup: and unspent');
    assert.deepEqual(answerAccountOf(harness), { requests_issued: 1, answers_settled: 1 });

    harness.relaunch();
    for (let i = 0; i < 4 && harness.runner.phase !== 'prepared'; i += 1) harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0,
      'accepted unspent evidence is not rejected foreign evidence -- MUST be red on 44ae7a4');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), true,
      'the held acknowledgement is re-established, not thrown away');
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'and it buys the clear it had already earned');

    // MECHANISM: re-established from its recorded position, and counted once.
    assert.equal(harness.events('capsule-ack-restored').length, 1);
    assert.equal(harness.events('capsule-ack-observed').length, 0,
      'the literal is NOT re-read -- the frontier still excludes it');
    assert.deepEqual(answerAccountOf(harness), { requests_issued: 1, answers_settled: 1 },
      'and the completion is not counted twice');
  } finally {
    harness.cleanup();
  }
});

test('GPT-U2b accepted is distinguished from rejected and from spent, and the unscanned path is unchanged', () => {
  // ARM 1. REJECTED-A STAYS REJECTED. A foreign answer is consumed as a retired
  // debt, then B's own answer is accepted under a hold, then the process
  // restarts. Re-establishing B's evidence must not rewind the frontier and
  // reopen A.
  const both = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const dead = retireAnOutstandingRequest(both, { recordTheRequest: true });
    const live = openReplacementCycleWithRequest(both, dead);
    appendExactCapsuleAck(both); // A's late answer.
    for (let i = 0; i < 3; i += 1) both.drive();
    assert.equal(retiredConsumed(both).length, 1, 'setup: A consumed as retired');
    assert.equal(both.runner._capsuleAckAuthorizes(live), false);

    appendCapsuleRunNoise(both);
    appendExactCapsuleAck(both); // B's own answer.
    driveUntil(both, () => both.runner._capsuleAckAuthorizes(live), 6);
    assert.equal(clearIntentEventCount(both), 0, 'setup: accepted under a hold, unspent');

    both.relaunch();
    for (let i = 0; i < 4 && both.runner.phase !== 'prepared'; i += 1) both.drive();
    assert.equal(both.runner._capsuleAckAuthorizes(live), true,
      'B own accepted answer is re-established -- MUST be red on 44ae7a4');
    assert.equal(capsuleTextWriteCount(both), 0, 'with no duplicate request');
    assert.equal(retiredConsumed(both).length, 0,
      'and A is not re-read: the frontier did not rewind');
    assert.equal(ackObservedCount(both), 0, 'nothing was re-scanned at all');
    both.flushControl();
    assert.equal(clearTextWrites(both), 1, 'exactly one clear');
  } finally {
    both.cleanup();
  }

  // ARM 2. SPENT IS NOT RE-ESTABLISHED. Once the clear intent exists the
  // completion has been spent, and the durable intent is the discriminator.
  const spent = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const live = driveToRequestedWithOneMoreRequest(spent);
    appendExactCapsuleAck(spent);
    driveUntil(spent, () => spent.runner.phase === 'prepared', 8);
    spent.flushControl();
    assert.equal(clearTextWrites(spent), 1, 'setup: the clear was written');
    assert.equal(clearIntentEventCount(spent), 1, 'setup: so a clear intent exists');
    assert.ok(spent.cycleState().clear_intent !== null, 'setup: durably');

    spent.relaunch();
    for (let i = 0; i < 6; i += 1) spent.drive();
    spent.flushControl();
    assert.equal(spent.events('capsule-ack-restored').length, 0,
      'a spent completion is not re-established');
    assert.equal(spent.runner._capsuleAckAuthorizes(live), false);
    assert.equal(clearTextWrites(spent), 0, 'and no second clear is written in the new process');
  } finally {
    spent.cleanup();
  }

  // ARM 3. THE ON-DISK-BUT-UNSCANNED PATH IS UNCHANGED. No answer was ever
  // accepted, so there is no marker; the ordinary #90 restore finds the
  // literal by scanning, exactly as before.
  const unscanned = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    assert.equal(unscanned.drive().state.state, 'pressure');
    const live = unscanned.core.state.cycle_id;
    appendExactCapsuleAck(unscanned);
    unscanned.writeStopRecordAtTranscriptEnd();
    assert.equal(classificationOf(unscanned)?.accepted ?? null, null,
      'setup: nothing was accepted, so nothing is marked');

    unscanned.relaunch();
    driveUntil(unscanned, () => ackObservedCount(unscanned) > 0, 8);
    assert.equal(ackObservedCount(unscanned), 1,
      'the unscanned answer is still recovered by SCANNING, not by a marker');
    assert.equal(unscanned.events('capsule-ack-restored').length, 0);
    assert.equal(unscanned.runner.capsuleAck?.cycle_id, live);
    driveUntil(unscanned, () => unscanned.runner.phase === 'prepared', 6);
    unscanned.flushControl();
    assert.equal(clearTextWrites(unscanned), 1, 'exactly one clear');
    assert.equal(capsuleTextWriteCount(unscanned), 0, 'and no re-request');
  } finally {
    unscanned.cleanup();
  }
});

// ===========================================================================
// RE-REVIEW 5608270301 (GPT), the final one: FIX on exactly one blocker, with
// no nice-to-haves and no scope additions. All 45 earlier checks pass,
// including the U1/U2 examples.
//
// V1 — RESOLVING RECOVERY DID NOT DURABLY SAVE ITS REPLACEMENT BOUNDARY. The
// disposition change was durable and the exclusion it depends on was not:
// `_writeCapsuleRequest` wrote `pending: null` plus the issue tally, and then
// `_armCapsuleAckWatch` moved only the IN-MEMORY cursor to the transcript's
// end. Neither `ack_boundary` nor `classified_through` was advanced to that
// replacement position, so a later restore reopened the ORIGINAL boundary and
// accepted the very answer the pending marker had just correctly refused.
// Measured: before the restart boundary 317, reader 543, classified_through 0,
// pending null, authorized(B) false; after it, with no new transcript data,
// reader 317 and authorized(B) true via `transcript-scan`.
//
// WHY THE EXISTING VECTORS MISSED IT, in his words and worth recording:
// GPT-U1a restarts while STILL pending, and GPT-U1b releases recovery and then
// supplies the answer WITHOUT an intervening restart. Neither covers the
// continuation where recovery is released and the process restarts before any
// answer arrives.
// ===========================================================================

test('GPT-V1 a resolved recovery boundary survives a second same-session relaunch before any answer', () => {
  for (const mode of ['telemetry-hold', 'composer-busy']) {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      const { live } = unestablishedOwnershipOverForeignAnswer(harness);
      const foreignAnswerEnd = transcriptSize(harness);

      // Recovery is deferred, and the pending marker correctly blocks the old
      // unowned answer -- the part that already worked.
      harness.relaunch();
      if (mode === 'telemetry-hold') setPressure(harness, TELEMETRY_MISSING);
      else harness.runner.handleOperatorData('an unsent operator draft');
      for (let i = 0; i < 3; i += 1) harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 0, `${mode}: setup: still deferred`);
      assert.equal(classificationOf(harness)?.pending?.code,
        'ack-classification-unestablished', `${mode}: setup: and recorded as unresolved`);

      // RELEASE. Exactly one fresh request goes out, the disposition resolves,
      // and the in-memory reader moves to the transcript's end.
      if (mode === 'telemetry-hold') setPressure(harness, ABOVE_THRESHOLD);
      else harness.operator(Buffer.from('\r'));
      driveUntil(harness, () => capsuleTextWriteCount(harness) === 1, 10);
      assert.equal(classificationOf(harness)?.pending ?? null, null,
        `${mode}: setup: the disposition is resolved`);
      assert.equal(ackObservedCount(harness), 0, `${mode}: setup: nothing accepted yet`);
      assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
      assert.ok(harness.ackWindowFrom() >= transcriptSize(harness),
        `${mode}: setup: and the reader sits at the end`);

      // Five ordinary ticks. No fresh answer, no crash, nothing appended.
      for (let i = 0; i < 5; i += 1) harness.drive();
      assert.equal(clearTextWrites(harness), 0);
      const sizeBeforeRestart = transcriptSize(harness);

      // THE DEFECT: a same-session restore over the saved cycle and an
      // UNCHANGED transcript. Before the correction the original boundary
      // reopened and the old answer was accepted as this cycle's.
      harness.relaunch();
      for (let i = 0; i < 3; i += 1) harness.drive();
      harness.flushControl();
      assert.equal(transcriptSize(harness), sizeBeforeRestart,
        `${mode}: setup: no new transcript data was involved`);
      assertTransportStillTicking(harness, `${mode}: V1 post-relaunch`);
      assert.equal(ackObservedCount(harness), 0,
        `${mode}: an answer rejected before recovery cannot authorize after it -- MUST be red on bb7cbd9`);
      assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
      assert.equal(clearIntentEventCount(harness), 0);
      assert.equal(clearTextWrites(harness), 0);

      // MECHANISM: the replacement exclusion is durable, so the restore opens
      // PAST the old answer instead of over it.
      assert.ok((classificationOf(harness)?.classified_through ?? 0) >= foreignAnswerEnd,
        `${mode}: the replacement exclusion was saved with the resolution`);
      assert.ok(harness.ackWindowFrom() === null
        || harness.ackWindowFrom() >= foreignAnswerEnd,
      `${mode}: so any window opens past it (got ${harness.ackWindowFrom()})`);

      // And a GENUINE completion still produces exactly one clear.
      appendExactCapsuleAck(harness);
      driveUntil(harness, () => harness.runner.phase === 'prepared', 10);
      assert.equal(harness.runner.capsuleAck?.cycle_id, live);
      harness.flushControl();
      assert.equal(clearTextWrites(harness), 1, `${mode}: exactly one clear`);
      for (let i = 0; i < 6; i += 1) harness.drive();
      harness.flushControl();
      assert.equal(clearTextWrites(harness), 1, `${mode}: and never a second`);
    } finally {
      harness.cleanup();
    }
  }
});

test('GPT-V1b failing to persist the resolved boundary leaves the disposition set and writes no request', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const { live } = unestablishedOwnershipOverForeignAnswer(harness);
    const foreignAnswerEnd = transcriptSize(harness);
    harness.relaunch();
    setPressure(harness, TELEMETRY_MISSING);
    for (let i = 0; i < 3; i += 1) harness.drive();
    assert.equal(classificationOf(harness)?.pending?.code, 'ack-classification-unestablished',
      'setup: recovery is deferred and recorded as unresolved');

    // Storage fails again exactly at the write that would resolve the
    // disposition and save its replacement exclusion. One write, so nothing
    // may be resolved by half.
    refuseClassificationWrites(harness);
    setPressure(harness, ABOVE_THRESHOLD);
    for (let i = 0; i < 6; i += 1) harness.drive();

    assertTransportStillTicking(harness, 'V1b resolution-write');
    // LIVENESS WITNESS for this vector: the deferral is only meaningful if the
    // transport actually RESUMED out of the telemetry hold under the
    // injection. If it had not, "no request was written" would be true of a
    // runner that never reached the gate at all.
    // Measured, not assumed: it resumes and walks on to checkpoint-confirmed.
    // What the witness needs is that it left the hold and reached a state the
    // request gate admits, so "no request was written" is a refusal and not an
    // unreached gate.
    assert.ok(['checkpoint-requested', 'checkpoint-confirmed'].includes(harness.core.state.state),
      `the transport resumed under the injection and reached the gate (got ${harness.core.state.state})`);
    assert.equal(capsuleTextWriteCount(harness), 0,
      'no request is written when its ownership and boundary cannot be saved');
    assert.equal(classificationOf(harness)?.pending?.code, 'ack-classification-unestablished',
      'and the disposition stays set: nothing was resolved');
    assert.equal(harness.runner.capsuleAckPending?.cycle_id, live,
      'in memory too, so the next attempt still knows it is unresolved');
    assert.ok(harness.events('capsule-request-ownership-unrecorded').length >= 1,
      'named, once per cycle');
    assert.equal(ackObservedCount(harness), 0, 'and the old unowned answer is still refused');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
    assert.equal(clearTextWrites(harness), 0);

    // A restart while that is still true must stay refused as well.
    harness.relaunch();
    setPressure(harness, TELEMETRY_MISSING);
    for (let i = 0; i < 3; i += 1) harness.drive();
    assert.equal(ackObservedCount(harness), 0,
      'a half-resolved recovery cannot become clean across a restart either');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
    assert.equal(clearTextWrites(harness), 0);

    // Storage recovers: exactly one request, and this time the resolution and
    // its replacement exclusion land together.
    setPressure(harness, ABOVE_THRESHOLD);
    driveUntil(harness, () => capsuleTextWriteCount(harness) === 1, 12);
    assert.equal(classificationOf(harness)?.pending ?? null, null, 'resolved on the retry');

    // AND THE RETRIED PATH TAKES THE SAME RESTART, before any answer: a
    // resolution that reached the disk on a second attempt must carry its
    // replacement exclusion just as the first-attempt one does.
    harness.relaunch();
    for (let i = 0; i < 3; i += 1) harness.drive();
    harness.flushControl();
    assert.equal(ackObservedCount(harness), 0,
      'a retried resolution must not reopen the old unowned answer either -- MUST be red on bb7cbd9');
    assert.equal(harness.runner._capsuleAckAuthorizes(live), false);
    assert.equal(clearIntentEventCount(harness), 0);
    assert.equal(clearTextWrites(harness), 0);
    assert.ok((classificationOf(harness)?.classified_through ?? 0) >= foreignAnswerEnd,
      'because the replacement exclusion was saved alongside the resolution');

    // The genuine completion then buys exactly one clear.
    appendExactCapsuleAck(harness);
    driveUntil(harness, () => harness.runner.phase === 'prepared', 10);
    assert.equal(harness.runner.capsuleAck?.cycle_id, live);
    harness.flushControl();
    assert.equal(clearTextWrites(harness), 1, 'exactly one clear');
  } finally {
    harness.cleanup();
  }
});

// -- issue #99: a control byte inside an unfinished sequence ------------------
//
// ECMA-48 5.4 / DEC STD 070: a C0 control encountered inside a control
// sequence is EXECUTED immediately and the sequence then resumes. xterm, vte
// and xterm.js all do this. Before the fix the tracker appended such a byte to
// `sequence` instead, so a CR arriving inside a mouse report never reached the
// CR boundary: it submitted on the host and booked NO outstanding slot, and
// the focus/mouse whitelist then restored the pre-report state wholesale.

test('IA1 #99: a CR inside an unfinished mouse report is accounted, and the whitelist cannot launder it away', () => {
  // The report still completes, still matches the whitelist, still clears the
  // parser -- mouse handling is preserved. What changes is that the executed
  // CR leaves a NAMED taint and a booked slot behind it.
  const vector = new InputOwnershipTracker();
  vector.observe('draft');
  vector.observe(`${ESC}[<0;10;5`);          // report opened, unterminated
  vector.observe('\r');                      // C0 executed by a compliant child
  const mid = vector.snapshot();
  assert.equal(mid.outstanding, 1,
    'the executed CR books the record it may owe -- MUST be red on c3563fc (was 0)');
  assert.equal(mid.pendingSubmission, true,
    'and books it as UNCERTAIN: mid-sequence the byte before the cursor is unseeable');
  assert.equal(vector.pendingSubmission.certain, false,
    'never `certain`: a child that buffers the whole CSI submitted nothing at all');

  // AND in the shape that actually breaks the invariant: with a PRIOR pending
  // CR, `certain` is also derived from that record (`quietSince &&
  // previous.dirtyAfter`), which passing `before = null` does NOT suppress.
  // The no-prior-pending case above leaves `quietSince` false, so it cannot
  // pin this on its own (pre-push review D1).
  const withPrior = new InputOwnershipTracker();
  withPrior.observe(`${ESC}[A`);             // arrow-up: fail-closed taint
  withPrior.observe('\r');                   // uncertain CR #1
  withPrior.observe('typed');                // content -> previous.dirtyAfter = true
  withPrior.observe(`${ESC}[<0;40;12`);
  withPrior.observe('\r');                   // the CR inside the report
  assert.equal(withPrior.pendingSubmission.certain, false,
    'a prior dirty record must not make a mid-sequence CR certain -- MUST be red on 38fcc940');

  vector.observe('M');                       // report terminates
  const after = vector.snapshot();
  assert.equal(after.activeControl, false, 'the mouse report still completes and clears the parser');
  assert.equal(after.unknown, true,
    'and the whitelist restore cannot launder the executed control away -- MUST be red on c3563fc');
  assert.equal(after.outstanding, 1, 'the booked slot survives the restore -- MUST be red on c3563fc');
  assert.equal(after.pendingSubmission, true, 'as does the uncertain record');
  assert.ok(after.lastTaint && after.lastTaint.includes('\\r'),
    'the refusal log names the executed control outright');
  assert.equal(after.knownEmpty, false, 'so the composer is never declared empty here');
});

test('IA2 #99: an unaccounted CR let an unrelated receipt settle the next entry one record early', () => {
  // The measured harm. Prompt A is submitted, its transcript record is LATE
  // (Claude Code records a queued prompt when it is dequeued at turn end).
  // The operator then types a new draft B, edits it, and presses Enter -- an
  // uncertain CR. A's late record must NOT confirm B.
  const run = (firstEnter) => {
    const tracker = new InputOwnershipTracker();
    tracker.observe('first');
    firstEnter(tracker);
    tracker.observe('second-draft');
    tracker.observe('\u007f');               // an edit: the line is tainted
    tracker.observe('\r');                   // uncertain CR on draft B
    const verdict = tracker.noteOperatorPromptRecord();   // A's late record
    return { verdict, snapshot: tracker.snapshot() };
  };

  // CONTROL: the CR lands OUTSIDE the report. Two slots are outstanding, so
  // A's record settles A's slot and B keeps waiting.
  const control = run((tracker) => {
    tracker.observe(`${ESC}[<0;10;5M`);
    tracker.observe('\r');
  });
  assert.equal(control.verdict, 'consumed', "control: A's record settles A's own slot");
  assert.equal(control.snapshot.knownEmpty, false, 'control: draft B is preserved');

  // VECTOR: the CR lands INSIDE the report. Before the fix this booked no
  // slot, so A's record popped B's slot, matched its units, confirmed it, and
  // _submitted() the tracker -- declaring the unsent draft B empty.
  const vector = run((tracker) => {
    tracker.observe(`${ESC}[<0;10;5`);
    tracker.observe('\r');
    tracker.observe('M');
  });
  assert.equal(vector.verdict, 'consumed',
    "A's record must settle A's slot, not confirm B -- MUST be red on c3563fc (was \"confirmed\")");
  assert.equal(vector.snapshot.knownEmpty, false,
    'draft B is NOT empty: the capsule request must not be placed into it -- MUST be red on c3563fc (was true)');
  assert.equal(vector.snapshot.pendingSubmission, true, 'B still waits on its own evidence');
});

test('IA3 #99: every sequence mode that can swallow a control books it, and the deferral still clears', () => {
  // The whitelisted CSI completions are the dangerous ones (they restore the
  // pre-report state), but a string-mode sequence can swallow a CR too.
  for (const [label, open, close] of [
    ['mouse report', `${ESC}[<0;10;5`, 'M'],
    ['focus report', `${ESC}[`, 'I'],
    ['CPR response', `${ESC}[24;8`, 'R'],
    ['win32 keyup', `${ESC}[16;42;0;0;0;`, '1_'],
    ['paste start', `${ESC}[20`, `0~x${ESC}[201~`],
    ['OSC title', `${ESC}]0;ti`, `tle${ESC}\\`],
  ]) {
    const tracker = new InputOwnershipTracker();
    tracker.observe('draft');
    tracker.observe(open);
    tracker.observe('\r');
    assert.equal(tracker.snapshot().outstanding, 1, `${label}: the executed CR is booked`);
    tracker.observe(close);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.outstanding, 1, `${label}: and survives the sequence completing`);
    assert.equal(snapshot.unknown, true, `${label}: the line stays tainted`);
    assert.equal(snapshot.knownEmpty, false, `${label}: never declared empty`);

    // LIVENESS: the deferral is not a stall. Genuine evidence clears it.
    assert.equal(tracker.noteOperatorPromptRecord(), 'confirmed', `${label}: its own record confirms it`);
  }

  // ESC is the ST introducer in the string modes, so it must still terminate
  // them rather than being treated as an executed control -- otherwise the
  // mode would never close and the deferral would be permanent.
  const osc = new InputOwnershipTracker();
  osc.observe(`${ESC}]0;title${ESC}\\`);
  assert.equal(osc.mode, 'normal', 'ST still terminates an OSC');
  assert.equal(osc.snapshot().activeControl, false);
});

test('IA4 #99: ESC CR stays the documented Alt+Enter newline, and paste payload controls stay inert', () => {
  // ESC CR is Claude Code's Alt+Enter NEWLINE chord (class comment): a
  // control byte on the taint path that owes NO record. The #99 fix must not
  // promote it into a booked submission.
  const altEnter = new InputOwnershipTracker();
  altEnter.observe('draft');
  altEnter.observe(`${ESC}\r`);
  assert.equal(altEnter.snapshot().outstanding, 0, 'Alt+Enter books nothing');
  assert.equal(altEnter.snapshot().knownEmpty, false, 'and leaves the line dirty');

  // Bracketed paste exists so that controls in the payload are inert TEXT.
  // A CR between the markers is a pasted newline, not an executed control.
  const paste = new InputOwnershipTracker();
  paste.observe(`${ESC}[200~line one\rline two\r${ESC}[201~`);
  assert.equal(paste.snapshot().outstanding, 0,
    'CRs inside a bracketed paste are payload and book nothing');
  assert.equal(paste.snapshot().unknown, false, 'and do not taint the line');
  paste.observe('\r');
  assert.equal(paste.snapshot().knownEmpty, true, 'the operator Enter after the paste still submits');
});

test('IA5 #99 second-order: a report interleaved into a paste must not become the byte before the cursor', () => {
  // A terminal emits focus and mouse reports whenever the window is touched,
  // INCLUDING while a paste is being delivered, and those bytes arrive
  // interleaved between the two markers. The seven-byte probe cannot tell
  // them from payload, so a report landing just before the end marker made
  // `lastByte` the report's final 'M' instead of the payload's backslash --
  // and the operator's next Enter read as a clean SUBMISSION where it is
  // really a backslash NEWLINE.
  const BACKSLASH = String.fromCharCode(0x5c);
  const MOUSE = `${ESC}[<0;10;5M`;

  const clean = new InputOwnershipTracker();
  clean.observe(`${ESC}[200~abc${BACKSLASH}${ESC}[201~`);
  clean.observe('\r');
  assert.equal(clean.snapshot().lastNewline, true,
    'control: a paste ending in a backslash makes the next Enter a newline');
  assert.equal(clean.snapshot().knownEmpty, false, 'control: the draft is preserved');
  assert.equal(clean.snapshot().outstanding, 0, 'control: a newline owes no record');

  const interleaved = new InputOwnershipTracker();
  interleaved.observe(`${ESC}[200~abc${BACKSLASH}${MOUSE}${ESC}[201~`);
  const afterPaste = interleaved.snapshot();
  assert.equal(afterPaste.lastByte, null,
    "the report's trailing M must not be adopted as the byte before the cursor -- MUST be red on c3563fc (was \"M\")");
  assert.equal(afterPaste.unknown, true,
    'the byte before the cursor is not provable, so the line is tainted -- MUST be red on c3563fc');

  interleaved.observe('\r');
  const afterEnter = interleaved.snapshot();
  assert.equal(afterEnter.knownEmpty, false,
    'the Enter is NOT a proven submission: the draft survives -- MUST be red on c3563fc (was true)');
  assert.equal(afterEnter.pendingSubmission, true, 'it waits on transcript evidence instead');

  // LIVENESS: an ordinary paste with no interleaved sequence is untouched,
  // and the tainted case still clears on genuine evidence.
  const ordinary = new InputOwnershipTracker();
  ordinary.observe(`${ESC}[200~pasted text${ESC}[201~`);
  assert.equal(ordinary.snapshot().unknown, false, 'an ordinary paste is not tainted by this rule');
  assert.equal(ordinary.snapshot().lastByte, 't', 'and still knows its last payload byte');
  assert.equal(interleaved.confirmSubmission(), true, 'and the interleaved case clears on evidence');
});

// -- repeated-log correction in _disableAutomation ---------------------------
//
// Measured on a contained seat: with the kill switch held active the runner
// emitted `automation-disabled` on EVERY tick -- +330 events in 30s (~11/sec,
// ~145 MB/day of daemon log). `alreadyDisabled` was computed but applied only
// to the terminal announcement, never to the event.
//
// The correction suppresses the EMISSION only. The per-tick cleanup is the
// mechanism that cancels an Enter or a commit scheduled BETWEEN polls, so the
// second assertion below is the one that proves quiet was not bought with
// safety.

test('IA6 a held kill switch emits ONE automation-disabled event, and still cancels every write scheduled between polls', () => {
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    const { runner } = harness;
    const disabledEvents = () => harness.snapshot().events
      .filter((entry) => entry.startsWith('automation-disabled'));

    harness.setGuard('killSwitch', true);
    harness.drive();

    // (1) ENTRY still speaks, and still carries the full evidence.
    const entry = disabledEvents();
    assert.equal(entry.length, 1, 'entering the disabled state emits exactly one event');
    assert.ok(entry[0].includes('kill-switch-test'),
      'the first emission still names the code, so the operator knows why automation is off');
    assert.ok(entry[0].includes('fixture'),
      'and still carries the detail, which on a live seat is the resolved kill-switch path');
    assert.equal(runner.automationEnabled, false);
    assert.equal(runner.phase, 'disabled');

    // (2) Identical polls add nothing to the log -- AND every poll still
    // cancels an automatic write that appeared since the last one.
    for (let poll = 0; poll < 20; poll += 1) {
      runner.enterToken += 1;
      const token = runner.enterToken;
      runner.enterHandle = runner.scheduleEnter(
        () => runner._writeControlEnter(token),
        runner.controlEnterDelayMs,
      );
      runner.commitHandle = runner.scheduleCommit(() => runner.commitClearSubmission());
      assert.ok(runner.enterHandle, `poll ${poll}: the Enter really was scheduled`);
      assert.ok(runner.commitHandle, `poll ${poll}: the commit really was scheduled`);

      harness.drive();

      assert.equal(runner.enterHandle, null,
        `poll ${poll}: the Enter scheduled since the last poll is still cancelled`);
      assert.equal(runner.commitHandle, null,
        `poll ${poll}: and so is the commit -- suppression work must never be skipped`);
    }

    assert.equal(disabledEvents().length, 1,
      '20 identical polls add no further events -- MUST be red on c3563fc (was 21)');

    // Nothing the runner cancelled can still fire, and nothing was written.
    harness.fireEnter();
    harness.flushControl();
    assert.deepEqual(harness.snapshot().automaticWrites, [],
      'no automatic write escaped across the repeated polls');

    // (3) A genuinely different EFFECTIVE reason speaks up again.
    runner._disableAutomation('runner-test-other-reason', 'a different cause');
    const changed = disabledEvents();
    assert.equal(changed.length, 2, 'a changed reason emits a fresh event');
    assert.ok(changed[1].includes('runner-test-other-reason'), 'naming the new reason');

    // ... and that reason then stops repeating in its turn.
    runner._disableAutomation('runner-test-other-reason', 'a different cause');
    runner._disableAutomation('runner-test-other-reason', 'a different cause');
    assert.equal(disabledEvents().length, 2, 'the new reason does not repeat either');

    // A changed DETAIL under the same code is also a changed reason: the
    // comparison is on the whole emitted {code, detail}, not the code alone.
    runner._disableAutomation('runner-test-other-reason', 'a third cause');
    assert.equal(disabledEvents().length, 3, 'a changed detail is a changed reason too');

    // The runner is still disabled throughout -- quiet, not re-enabled.
    assert.equal(runner.automationEnabled, false);
    assert.equal(runner.phase, 'disabled');
  } finally {
    harness.cleanup();
  }
});

test('IA7 #99 live seat: a paste carrying win32 key sequences is not trusted for the byte before the cursor, and costs exactly one record', () => {
  // OBSERVED ON A CONTAINED SEAT, not constructed: an operator's pasted
  // message was logged as an operator-input/operator-write pair whose
  // bracketed-paste payload carried embedded win32-input-mode key sequences
  // (ESC[13;28;13;1;0;1_ -- a plain VK_RETURN keydown) between the markers.
  // So escape sequences inside a paste are ordinary traffic, not an edge case.
  //
  // The tracker cannot decode key events in paste mode, so after such a paste
  // the byte before the cursor is whatever the last key event placed -- NOT
  // the last raw byte on the wire. Before the fix the probe adopted the
  // sequence's terminator: lastByte '_'. The operator's next Enter then read
  // as a CLEAN submission, with zero evidence behind it.
  const WIN32_ENTER = `${ESC}[13;28;13;1;0;1_`;
  const live = `${ESC}[200~Titus, #97 and #102 are merged${WIN32_ENTER}`
    + `${WIN32_ENTER}and the next step${WIN32_ENTER}${ESC}[201~`;

  const tracker = new InputOwnershipTracker();
  tracker.observe(live);
  const pasted = tracker.snapshot();
  assert.equal(pasted.lastByte, null,
    "a key sequence's terminator is not the byte before the cursor -- MUST be red on c3563fc (was \"_\")");
  assert.equal(pasted.unknown, true,
    'the paste is not byte-exact for this purpose, so the line is tainted -- MUST be red on c3563fc');
  assert.equal(pasted.knownEmpty, false, 'and the composer is never declared empty');

  // BOUNDED COST, stated: the operator's next Enter is an uncertain
  // submission rather than a guess, and exactly ONE transcript record
  // resolves it completely. This is the documented one-tick price, not a
  // stall -- the failure this file's discipline rules out.
  tracker.observe('\r');
  const entered = tracker.snapshot();
  assert.equal(entered.pendingSubmission, true, 'the Enter waits on evidence');
  assert.equal(entered.outstanding, 1, 'and books exactly one record');

  assert.equal(tracker.noteOperatorPromptRecord(), 'confirmed', 'the first record confirms it');
  const resolved = tracker.snapshot();
  assert.equal(resolved.knownEmpty, true, 'the composer is then known empty, on evidence');
  assert.equal(resolved.unknown, false, 'and clean');
  assert.equal(resolved.outstanding, 0, 'owing nothing further -- the deferral is bounded at one record');
});

// -- pre-push review findings D1/D2/D3/D4 ------------------------------------
//
// D1 was fail-OPEN and made the #99 repair worse than master on its own
// vector: a mid-sequence CR could be marked `certain`, and an unrelated older
// receipt then confirmed it one record early -- #99's failure mode in a
// narrower shape. D2 and D3 were fail-closed but desynchronised the FIFO with
// phantom entries. All three were the same three lines in _controlInSequence.

test('IA8 D1 #99: a mid-sequence CR is NEVER `certain`, so no older receipt can confirm it early', () => {
  // The reviewer's vector. An earlier uncertain CR owes a record; the operator
  // then types an ordinary draft (which sets dirtyAfter on that record) and
  // presses Enter inside a wheel-scroll report. `before = null` kills only the
  // isPlacedByte disjunct -- `quietSince && previous.dirtyAfter` made `certain`
  // true anyway, and the FIRST CR's record then confirmed the SECOND.
  const BACKSLASH = String.fromCharCode(0x5c);
  const tracker = new InputOwnershipTracker();
  tracker.observe(`${ESC}[A`);                 // arrow-up recalls history: fail-closed taint
  tracker.observe('\r');                       // uncertain CR #1 -- one record owed
  tracker.observe(`new draft${BACKSLASH}`);    // a draft ending in the PR #59 continuation
  tracker.observe(`${ESC}[<0;40;12`);          // wheel-scroll report opens
  tracker.observe('\r');                       // the operator's Enter lands INSIDE it
  tracker.observe('M');                        // report completes, whitelist restores

  assert.equal(tracker.pendingSubmission?.certain, false,
    'a mid-sequence CR is never certain -- MUST be red on 38fcc940 (was true)');

  // Host truth: the composer holds `new draft\` + a newline. Backslash+Enter
  // is a NEWLINE, so that CR submitted nothing and owes no record; the record
  // that arrives belongs to CR #1.
  tracker.noteOperatorPromptRecord();
  assert.equal(tracker.snapshot().knownEmpty, false,
    'the live draft must survive CR #1\'s receipt -- MUST be red on 38fcc940 (was true)');
});

test('IA9 D2/D3 #99: a mid-sequence CR books a slot only when the host could have submitted', () => {
  const BACKSLASH = String.fromCharCode(0x5c);

  // D2 -- a backslash before the cursor makes that Enter a composer NEWLINE
  // (PR #59 review, P1), exactly as the win32 plain-Enter branch already
  // reads preSequenceLastByte. It owes no record, so booking one would leave
  // a phantom at the head of the FIFO to absorb the next genuine receipt.
  const backslash = new InputOwnershipTracker();
  backslash.observe(`abc${BACKSLASH}`);
  backslash.observe(`${ESC}[<0;10;5`);
  backslash.observe('\r');
  backslash.observe('M');
  assert.equal(backslash.snapshot().outstanding, 0,
    'a newline chord owes no record -- MUST be red on 38fcc940 (was 1)');
  assert.equal(backslash.snapshot().unknown, true,
    'but the line is still tainted: whether the child executed the CR is unknowable');

  // D3 -- an Enter on a composer that was EMPTY and CLEAN changes nothing on
  // either branch of the ambiguity, so it is neither booked nor tainted.
  // Tainting would manufacture a deferral on a provably empty composer.
  const empty = new InputOwnershipTracker();
  empty.observe(`${ESC}[<0;1;1`);
  empty.observe('\r');
  empty.observe('M');
  const emptySnapshot = empty.snapshot();
  assert.equal(emptySnapshot.outstanding, 0,
    'an Enter on an empty composer owes no record -- MUST be red on 38fcc940 (was 1)');
  assert.equal(emptySnapshot.unknown, false,
    'and leaves nothing to be uncertain about -- MUST be red on 38fcc940 (was true)');
  assert.equal(emptySnapshot.knownEmpty, true, 'the composer is still known empty');

  // D3 compound -- the manufactured deferral the phantom caused: a paste and
  // an Enter on a genuinely empty composer must not sit behind
  // runner-capsule-request-composer-busy waiting for a second submission.
  const compound = new InputOwnershipTracker();
  compound.observe(`${ESC}[<0;1;1`);
  compound.observe('\r');
  compound.observe('M');
  compound.observe(`${ESC}[200~pasted${ESC}[201~`);
  compound.observe('\r');
  const after = compound.snapshot();
  assert.equal(after.knownEmpty, true,
    'the composer is empty and says so -- MUST be red on 38fcc940 (was false)');
  assert.equal(after.pendingSubmission, false,
    'with no deferral manufactured -- MUST be red on 38fcc940 (was true)');
  assert.equal(after.unknown, false, 'and no taint');

  // The booking that SHOULD happen still happens: a real draft, no backslash.
  const real = new InputOwnershipTracker();
  real.observe('draft');
  real.observe(`${ESC}[<0;10;5`);
  real.observe('\r');
  real.observe('M');
  assert.equal(real.snapshot().outstanding, 1, 'a CR that could have submitted is still booked');
  assert.equal(real.pendingSubmission.certain, false, 'and still never certain');
});

test('IA10 D4: the automation-disabled dedupe key is not truncated', () => {
  // boundedDetailJson slices to REFUSAL_DETAIL_MAX (1200) with no marker, so
  // two details differing only past that bound compared EQUAL and the second
  // emission was swallowed while lastReason.detail silently updated -- the
  // operator would read a stale reason. Reachable through errorText(error).
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    const { runner } = harness;
    const disabledEvents = () => harness.snapshot().events
      .filter((entry) => entry.startsWith('automation-disabled'));

    const prefix = 'x'.repeat(1400);           // longer than REFUSAL_DETAIL_MAX
    runner._disableAutomation('runner-test-long', `${prefix}FIRST`);
    assert.equal(disabledEvents().length, 1, 'entry emits');

    runner._disableAutomation('runner-test-long', `${prefix}SECOND`);
    assert.equal(disabledEvents().length, 2,
      'a detail that differs only past the bound is still a changed reason -- MUST be red on 38fcc940 (was 1)');

    // ... and an identical long detail still does NOT repeat.
    runner._disableAutomation('runner-test-long', `${prefix}SECOND`);
    assert.equal(disabledEvents().length, 2, 'an identical long detail does not repeat');
    assert.equal(runner.lastReason.detail, `${prefix}SECOND`, 'lastReason carries the live reason');
  } finally {
    harness.cleanup();
  }
});

// -- review 5630883337, R1 ---------------------------------------------------
//
// A receipt establishes SUBMISSION, not that an unfinished control or paste
// sequence has finished arriving. confirmSubmission()'s clean branch called
// _submitted(), which resets the PARSER along with the composer model. Until
// the inner-CR path existed that was unreachable: every other way to be
// pending mid-sequence goes through the ESC-arrival taint, which marks
// dirtyAfter and lands in the dirty branch. _controlInSequence mints a record
// with dirtyAfter:false while `mode` is already 'csi', which opened it.

test('IA11 R1: a receipt arriving before a sequence\'s final byte neither releases input nor discards the parser', () => {
  // All three opener shapes, because the defect is in the confirmation path
  // and not in the mouse-report case: a vector set that only exercised CSI
  // would pass over two thirds of this.
  const shapes = [
    ['CSI mouse report', `${ESC}[<0;10;5`, 'M', true],
    ['focus report', `${ESC}[`, 'I', true],
    // A paste opener completes into PASTE mode, which is content arriving --
    // not an inert completion, so it stays deferred by design. Only the
    // deferral half applies to it.
    ['paste opener', `${ESC}[200`, '~', false],
  ];

  for (const [label, opener, closer, inert] of shapes) {
    const tracker = new InputOwnershipTracker();
    tracker.observe('draft');
    tracker.observe(opener);               // final byte deliberately withheld
    tracker.observe('\r');                 // the inner CR books its record

    assert.equal(tracker.noteOperatorPromptRecord(), 'confirmed',
      `${label}: the CR's own receipt settles it`);

    // THE BLOCKER: the parser must survive, so automatic input stays shut.
    const mid = tracker.snapshot();
    assert.equal(mid.knownEmpty, false,
      `${label}: a receipt must not release input with the final byte absent -- MUST be red on 8a110b6 (was true)`);
    assert.equal(mid.activeControl, true,
      `${label}: the unfinished sequence is still in flight -- MUST be red on 8a110b6 (was false)`);
    assert.equal(tracker.mode, 'csi',
      `${label}: and the parser state was not discarded -- MUST be red on 8a110b6 (was "normal")`);

    tracker.observe(closer);
    const done = tracker.snapshot();
    assert.equal(done.activeControl, false, `${label}: the sequence then completes as it always did`);
    if (inert) {
      // RELEASED BY THE RECEIPT ALONE -- no second operator Enter, no
      // fabricated receipt. Refusing to settle would have stranded this.
      assert.equal(done.knownEmpty, true,
        `${label}: an inert completion releases on the receipt already held -- MUST be red on 8a110b6 (was false)`);
      assert.equal(done.unknown, false, `${label}: and clean`);
      assert.equal(done.pendingSubmission, false, `${label}: owing nothing further`);
    } else {
      assert.equal(tracker.mode, 'paste', `${label}: a paste opener completes into paste mode`);
      assert.equal(done.knownEmpty, false, `${label}: a paste is content, so it stays deferred`);
    }
  }

  // CONTROL, the other ordering: final byte BEFORE the receipt. This is the
  // path that already worked and must keep working.
  for (const [label, opener, closer] of [
    ['CSI mouse report', `${ESC}[<0;10;5`, 'M'],
    ['focus report', `${ESC}[`, 'I'],
  ]) {
    const tracker = new InputOwnershipTracker();
    tracker.observe('draft');
    tracker.observe(opener);
    tracker.observe('\r');
    tracker.observe(closer);               // completes FIRST
    assert.equal(tracker.noteOperatorPromptRecord(), 'confirmed', `${label} (control): confirmed`);
    const after = tracker.snapshot();
    assert.equal(after.knownEmpty, true, `${label} (control): released`);
    assert.equal(after.activeControl, false, `${label} (control): nothing in flight`);
  }

  // And a receipt landing while the sequence is SPLIT ACROSS CHUNKS.
  const split = new InputOwnershipTracker();
  split.observe('draft');
  split.observe(`${ESC}[<0;10`);
  split.observe(';5');
  split.observe('\r');
  assert.equal(split.noteOperatorPromptRecord(), 'confirmed', 'split: the receipt settles the CR');
  const splitMid = split.snapshot();
  assert.equal(splitMid.knownEmpty, false,
    'split: still deferred across chunk boundaries -- MUST be red on 8a110b6 (was true)');
  assert.equal(split.mode, 'csi', 'split: the half-read sequence survives the receipt');
  split.observe('M');
  assert.equal(split.snapshot().knownEmpty, true, 'split: and releases when it completes');

  // A FAIL-CLOSED completion after the receipt must still taint: arrow-up
  // genuinely recalls history into the composer.
  const recalled = new InputOwnershipTracker();
  recalled.observe('draft');
  recalled.observe(`${ESC}[`);
  recalled.observe('\r');
  recalled.noteOperatorPromptRecord();
  recalled.observe('A');                   // ESC[A -- arrow-up, not inert
  const taintedSnapshot = recalled.snapshot();
  assert.equal(taintedSnapshot.knownEmpty, false, 'a recalled history line is not an empty composer');
  assert.equal(taintedSnapshot.unknown, true, 'and is tainted, because something unreadable followed the submission');
});

test('IA12 R1 at the gate: the capsule request is not written while a sequence is unfinished, and fires once it completes', () => {
  // The tracker assertions above are the mechanism; this is the consequence
  // the blocker was actually about -- _writeCapsuleRequest's composer guard
  // reads knownEmpty, so a false release opens the automatic-input gate.
  for (const [label, opener, closer] of [
    ['mouse report', `${ESC}[<0;10;5`, 'M'],
    ['focus report', `${ESC}[`, 'I'],
  ]) {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      assert.equal(harness.core.tick().state.state, 'pressure');
      for (const chunk of ['draft', opener, '\r']) harness.operator(Buffer.from(chunk));

      harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 0, `${label}: deferred before any receipt`);
      assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy');

      // The receipt lands with the sequence's final byte still absent.
      appendOperatorPromptRecord(harness, 'the prompt that inner CR submitted');
      for (let i = 0; i < 5; i += 1) harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 0,
        `${label}: a receipt must not open the gate mid-sequence -- MUST be red on 8a110b6 (was 1)`);
      assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy',
        `${label}: and the deferral is still named`);
      assert.equal(harness.fireEnter(), false, `${label}: no Enter was scheduled either`);

      // The sequence completes: the receipt already held releases it, with no
      // further operator Enter and no fabricated receipt.
      harness.operator(Buffer.from(closer));
      harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 1,
        `${label}: the completion releases it on the receipt already held`);
      assert.equal(harness.fireEnter(), true, `${label}: and its Enter rides a separate write`);
      for (let i = 0; i < 20; i += 1) harness.drive();
      assert.equal(capsuleTextWriteCount(harness), 1, `${label}: exactly once`);
    } finally {
      harness.cleanup();
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// #104 DIALOG READINESS
//
// THE DEFECT. _writeCapsuleRequest's only write gate was `composer.knownEmpty`,
// which models the composer TEXT LINE and knows nothing about a modal dialog.
// With a permission dialog on screen and nothing typed, knownEmpty is true --
// so the runner wrote its request text plus a CONTROL_ENTER, and a bare Enter
// at that dialog selects option 1, "Yes". Option 2 is "Yes, and switch to
// accept edits ... for this session", so an Enter one row down would disable
// prompting for the rest of the session.
//
// THE SIGNAL, measured on binary 2.1.309 (capture 2026-10-23T16:09Z, driver at
// scratchpad/p104): while the dialog is open the bound transcript holds a
// `tool_use` with no matching `tool_result`.
//
//   16:09:55.083Z  tool_use   toolu_016Dhtgz..., name Read
//   16:09:55.993Z  permission dialog on screen
//   16:09:57.195Z  ESC sent
//   16:09:57.250Z  tool_result for that id, is_error:true
//
// The pairing completes either way, so the signal exists ONLY while it matters.
// Every record shape below is verbatim from that capture.
// ════════════════════════════════════════════════════════════════════════════

// The two ids the capture actually produced.
const TOOL_ID_READ = 'toolu_016DhtgzbEi3BhBgrWo5qHyu';
const TOOL_ID_BASH = 'toolu_01Fk9hGNPYstevgX5U2TyKxR';
const DENIAL_TEXT = 'The user does not want to proceed with this tool use. '
  + 'The tool use was rejected (e.g. if it was a file edit, the new_string was '
  + 'not written to the file).';

function appendLine(harness, record, transcriptPath) {
  fs.appendFileSync(
    transcriptPath || harness.fixture.transcriptPath,
    `${typeof record === 'string' ? record : JSON.stringify(record)}\n`,
  );
}

// An assistant record opening one or more tool calls -- the capture's shape.
// What is actually on disk. Named for the case it exists to make visible: the
// MEASURED 2.1.310 run where the tool_use record was in the host's buffer and
// not in the file, so a reader of bytes could not see the call at all.
function readUnflushedTranscript(harness, transcriptPath = harness.fixture.transcriptPath) {
  try { return fs.readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
}

function openToolCall(harness, ids, options = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  appendLine(harness, {
    type: 'assistant',
    isSidechain: options.sidechain === true,
    message: {
      role: 'assistant',
      content: list.map((id) => ({
        type: 'tool_use',
        ...(id === null ? {} : { id }),
        name: options.name || 'Read',
        input: { file_path: 'probe.txt' },
      })),
    },
  }, options.transcriptPath);
  // ─── THE HOOK RAN FOR THIS CALL (#104) ─────────────────────────────────────
  // A tool_use record in the transcript means the host DECIDED to call a tool,
  // and on a wired seat that decision ran PreToolUse first -- which is exactly
  // what the interlock's missed-tool-calls leg checks. A fixture that writes the
  // record without running the hook is modelling a seat whose hook has stopped,
  // and the runner (correctly) holds every automatic write there.
  //
  // So the default is to run it, which keeps these vectors tests of the
  // TRANSCRIPT reader. `hook: false` models the dead-hook seat on purpose, and
  // `unflushed` (the measured 2.1.310 case) is the opposite shape: the hook ran
  // and the bytes are NOT on disk -- so it runs the hook and writes nothing.
  if (options.hook !== false) {
    for (const id of list) {
      harness.interlockPermissionCheck(id ?? 'toolu_ANON', options.name || 'Read');
    }
  }
}

// The hook's side of a call that is now finished, WITHOUT a transcript record.
// The measured asymmetry (2026-10-25, 2.1.310): an allowed tool produces
// PostToolUse, a DENIED one produces none at all.
function finishToolCallHook(harness, id, options = {}) {
  return harness.interlockToolFinished(id, options.name || 'Read');
}

// The host's answer. `denied` is the measured cancellation shape, right down to
// is_error and the denial prose.
function settleToolCall(harness, id, options = {}) {
  appendLine(harness, {
    type: 'user',
    isSidechain: options.sidechain === true,
    ...(options.denied ? { toolDenialKind: 'tool_use_rejected' } : {}),
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        is_error: options.denied === true,
        content: options.denied ? DENIAL_TEXT : 'probe.txt\n     1\thello',
      }],
    },
  }, options.transcriptPath);
  // The interlock's own clear for this call. A DENIED result gets no
  // PostToolUse on a real host, so the Stop sweep is what clears it -- which is
  // why `denied` drives Stop here and an ordinary answer drives PostToolUse.
  // Modelling it the other way round would hide the very hole the sweep exists
  // to cover.
  if (options.hook !== false) {
    if (options.denied === true) harness.interlockObserved();
    else harness.interlockToolFinished(id, options.name || 'Read');
  }
}

// A plain assistant turn. The ANCHOR: the API cannot be called again while a
// tool_use in the previous assistant message is unanswered, so this record
// proves every call opened before it was answered.
function anchorTurn(harness, text = 'Done.', options = {}) {
  appendLine(harness, {
    type: 'assistant',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }, options.transcriptPath);
}

function readinessOf(harness) {
  return harness.runner._automaticWriteReadiness();
}

function heldCodes(harness) {
  return harness.events('automatic-write-held').map((event) => event.detail?.code);
}

function heldAt(harness) {
  return harness.events('automatic-write-held').map((event) => event.detail?.detail?.at);
}

// pressure -> the tick at which the capsule request would fire.
function atRequestEdge(harness) {
  assert.equal(harness.core.tick().state.state, 'pressure');
  assert.equal(harness.runner.input.snapshot().knownEmpty, true,
    'setup: the composer is CLEAN, so the pre-existing guard permits the write');
}

function dialogCase(name, fn) {
  test(`#104 ${name}`, () => {
    const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try { fn(harness); } finally { harness.cleanup(); }
  });
}

// ─── THE DEFECT ITSELF ──────────────────────────────────────────────────────

dialogCase('D1 THE DEFECT: an outstanding tool call holds the capsule request, composer clean', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, TOOL_ID_READ);

  harness.drive();
  assert.equal(harness.core.state.state, 'checkpoint-requested',
    'setup: the lifecycle reached the state the request fires at');
  assert.equal(capsuleTextWriteCount(harness), 0,
    'FIRST RED: pre-fix this is 1 -- the request text went out at the dialog, '
    + 'and its CONTROL_ENTER 400ms later selects "Yes"');
  assert.equal(harness.fireEnter(), false, 'and no Enter was scheduled behind it');
  assert.equal(harness.runner.lastReason?.code, 'runner-tool-call-outstanding');
  assert.deepEqual(harness.runner.lastReason?.detail?.readiness?.tool_use_ids, [TOOL_ID_READ],
    'the refusal names the call it is waiting on, by id');
  assert.deepEqual(heldCodes(harness), ['runner-tool-call-outstanding']);
  assert.deepEqual(heldAt(harness), ['capsule-request'],
    'and names the write boundary that was held');
  assert.match(allRunnerLogs(harness), /automatic-write-held/, 'durable, not memory-only');
});

dialogCase('D2 the composer guard STAYS -- the two guards are independent, and both are named', (harness) => {
  assert.equal(harness.core.tick().state.state, 'pressure');
  // Composer dirty, no outstanding call: the pre-existing guard still decides.
  harness.operator(Buffer.from('fix the flaky test in'));
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
  assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy',
    'the composer guard is not replaced by the readiness guard');

  // Both conditions at once: still nothing written, and the composer guard
  // runs first (it is the cheaper, long-standing one).
  openToolCall(harness, TOOL_ID_READ);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
  assert.equal(harness.runner.lastReason?.code, 'runner-capsule-request-composer-busy');

  // Operator submits: the composer clears but the call is still open.
  harness.operator(Buffer.from('\r'));
  appendOperatorPromptRecord(harness, 'fix the flaky test in auth.test.js');
  harness.drive();
  assert.equal(harness.runner.input.snapshot().knownEmpty, true, 'the composer is clean now');
  assert.equal(capsuleTextWriteCount(harness), 0,
    'and the readiness guard holds it on its own -- neither guard is sufficient alone');
  assert.equal(harness.runner.lastReason?.code, 'runner-tool-call-outstanding');

  // The call settles: the request finally fires, exactly once.
  settleToolCall(harness, TOOL_ID_READ);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1);
  for (let i = 0; i < 20; i += 1) harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'exactly once');
});

// ─── PAIRED BY ID ───────────────────────────────────────────────────────────

dialogCase('D3 one result does not release another call: pairing is by id, not by count', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, [TOOL_ID_READ, TOOL_ID_BASH]);
  assert.equal(readinessOf(harness).detail?.outstanding, 2, 'setup: two calls open');

  // The Bash call is answered. The Read call is the one with the dialog.
  settleToolCall(harness, TOOL_ID_BASH);
  const partial = readinessOf(harness);
  assert.equal(partial.ready, false, 'one answer may not release the other call');
  assert.deepEqual(partial.detail?.tool_use_ids, [TOOL_ID_READ],
    'and the remaining id is exactly the unanswered one');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // An answer for an id nobody opened releases nothing either.
  settleToolCall(harness, 'toolu_never_issued_000000000');
  assert.equal(readinessOf(harness).ready, false, 'a foreign id settles nothing here');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  settleToolCall(harness, TOOL_ID_READ);
  assert.equal(readinessOf(harness).ready, true);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1);
});

dialogCase('D4 a cancellation settles its OWN call and authorizes no business action', (harness) => {
  harness.primeAuthorized();
  harness.revokeAck('test-d4-no-ack');
  openToolCall(harness, TOOL_ID_READ);
  assert.equal(readinessOf(harness).ready, false);

  // The measured cancellation: ESC at the dialog, is_error:true, denial prose.
  settleToolCall(harness, TOOL_ID_READ, { denied: true });
  assert.equal(readinessOf(harness).ready, true,
    'an error/cancellation result settles its own call -- the runner is not wedged by a refusal');

  // ... and authorizes NOTHING. Readiness is permission to WRITE, never an
  // authorization: the clear is still gated on this cycle's capsule ack.
  harness.drive();
  assert.equal(clearTextWrites(harness), 0, 'no clear rides a cancellation');
  assert.equal(harness.runner.capsuleAck, null);
  assert.ok(
    harness.runner.lastReason?.code?.startsWith('runner-capsule'),
    `the ack gate still owns the clear, got ${harness.runner.lastReason?.code}`,
  );
});

dialogCase('D5 a sidechain (subagent) call raises the same dialog, so it counts -- and its own answer clears it', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, TOOL_ID_READ, { sidechain: true });
  assert.equal(readinessOf(harness).ready, false,
    'a subagent tool call puts the same dialog on the same screen: excluding it would be a fail-open');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
  settleToolCall(harness, TOOL_ID_READ, { sidechain: true });
  assert.equal(readinessOf(harness).ready, true,
    'and excluding only its answers would be a wedge');
});

// ─── NO FAIL-OPEN ───────────────────────────────────────────────────────────

dialogCase('D6 an api-request-blob REPLAY of a result cannot release a call that is open now', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, TOOL_ID_READ);
  // The exact third carrier the capture contained: api-request-blob/tool_result.
  // It is a replay of a request payload, not an event.
  appendLine(harness, {
    type: 'api-request-blob',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: TOOL_ID_READ, is_error: false, content: 'ok' }],
    },
  });
  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'a replay must not settle a live call -- MUST be red if settlement is read from any record type');
  assert.deepEqual(verdict.detail?.tool_use_ids, [TOOL_ID_READ]);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
});

dialogCase('D7 the fail-closed set: a half-written tail and an unparsable record both refuse BY NAME', (harness) => {
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: a quiet transcript is ready');

  // 1. A record that is still being written. It may BE the tool_use.
  fs.appendFileSync(harness.fixture.transcriptPath,
    '{"type":"assistant","message":{"content":[{"type":"tool_u');
  const behind = readinessOf(harness);
  assert.equal(behind.ready, false, 'a half-written tail is not an empty outstanding-call set');
  assert.equal(behind.code, 'runner-tool-call-reader-behind');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // 2. That same line, completed as garbage: carries the marker, will not parse.
  fs.appendFileSync(harness.fixture.transcriptPath, 'se","id":\n');
  const unreadable = readinessOf(harness);
  assert.equal(unreadable.ready, false);
  assert.equal(unreadable.code, 'runner-tool-call-readiness-unknown');
  assert.equal(unreadable.detail?.reason, 'tool-call-record-unreadable');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
});

dialogCase('D8 a tool_use with no usable id is UNREADABLE, never ignored', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, null);
  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'a call that cannot be named is a call that cannot be paired -- ignoring it is the fail-open');
  assert.equal(verdict.detail?.reason, 'tool-call-record-unreadable');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
});

dialogCase('D9 an UNRESOLVED transcript refuses; an ABSENT one depends on which boundary is asking', (harness) => {
  atRequestEdge(harness);
  // Unresolvable path: nothing is known, so nothing is claimed.
  const realPath = harness.runner._transcriptPath;
  harness.runner._transcriptPath = () => null;
  const unresolved = readinessOf(harness);
  assert.equal(unresolved.ready, false);
  assert.equal(unresolved.detail?.reason, 'tool-call-transcript-unresolved');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
  harness.runner._transcriptPath = realPath;

  // ENOENT on a RESOLVED path is positive evidence ONLY where the session can
  // genuinely not have a transcript yet. Claude Code writes the transcript with
  // its first record, so "no file" means "no records" -- but that is a fact
  // about a NEW session, and the capsule/clear boundaries only fire for a
  // session at ~80% pressure, which provably has one. So the same reader state
  // yields different answers by boundary, and the reader reports the fact
  // rather than guessing which case it is in (D40-D44).
  fs.rmSync(harness.fixture.transcriptPath);
  assert.equal(harness.runner._automaticWriteReadiness('wake-enter-retry').ready, true,
    'at the wake retry an absent file really does mean "nothing submitted yet" -- '
    + 'holding here would lose the post-clear resume on every real clear');
  const strict = harness.runner._automaticWriteReadiness('capsule-request');
  assert.equal(strict.ready, false,
    'at the capsule request it cannot mean that: this session has a transcript, '
    + 'so absence means the path mis-resolved');
  assert.equal(strict.detail?.reason, 'tool-call-transcript-absent');
  assert.equal(harness.runner._automaticWriteReadiness('clear-submission').ready, false);
  assert.equal(harness.runner._automaticWriteReadiness(undefined).ready, false,
    'and an unrecognised boundary is STRICT, so a new write site gets the '
    + 'fail-closed answer by default rather than inheriting the exemption');
});

dialogCase('D9b (#111) a ZERO-LENGTH transcript is not-ready at the capsule, clear and control boundaries, ready at the wake retry, and ready again once a record lands', (harness) => {
  atRequestEdge(harness);
  fs.writeFileSync(harness.fixture.transcriptPath, '');
  harness.runner.toolCallWatch = null;
  assert.equal(harness.runner._automaticWriteReadiness('wake-enter-retry').ready, true,
    'at the wake retry no records yet is the truth');
  for (const where of ['capsule-request', 'capsule-request-enter', 'clear-submission', 'control-enter', undefined]) {
    const verdict = harness.runner._automaticWriteReadiness(where);
    assert.equal(verdict.ready, false, `${where}: a session under pressure has records; an empty file is not its live transcript`);
    assert.equal(verdict.code, 'runner-tool-call-readiness-unknown');
    assert.equal(verdict.detail?.reason, 'tool-call-transcript-empty');
    assert.equal(verdict.detail?.at, where ?? null);
  }
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'nothing is written while the transcript is empty');
  // The first record lands: the same reader, the same boundary, now ready.
  fs.appendFileSync(harness.fixture.transcriptPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
  assert.equal(harness.runner._automaticWriteReadiness('capsule-request').ready, true,
    'growth is read by the same catch-up pass; no rebind needed');
});

dialogCase('D9c an ABSENT transcript that then appears is read: the first record makes the strict boundary ready, no large append needed', (harness) => {
  atRequestEdge(harness);
  fs.rmSync(harness.fixture.transcriptPath);
  harness.runner.toolCallWatch = null;
  const absent = harness.runner._automaticWriteReadiness('capsule-request');
  assert.equal(absent.ready, false);
  assert.equal(absent.detail?.reason, 'tool-call-transcript-absent');
  // The post-clear session writes its first record (a few hundred bytes, far
  // below any re-baseline jump). The watch must not keep saying "absent".
  fs.writeFileSync(harness.fixture.transcriptPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
  const after = harness.runner._automaticWriteReadiness('capsule-request');
  assert.equal(after.ready, true,
    'MUST be red on 836a886f: `absent` was a bind-time snapshot never cleared, so every strict boundary refused until an unrelated >1 MiB jump re-baselined');
  assert.equal(harness.runner.toolCallWatch?.absent, undefined);
});

dialogCase('D10 an unanchored baseline refuses: a call beyond the bounded tail is never assumed away', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, TOOL_ID_READ);
  // Push the call out of reach of the baseline span with records that are NOT
  // anchors (no top-level assistant record), so nothing can discharge the
  // unknown. 1.4 MiB > 4 x 256 KiB.
  const filler = `${JSON.stringify({ type: 'attachment', message: { role: 'user', content: 'x'.repeat(200_000) } })}\n`;
  for (let i = 0; i < 7; i += 1) fs.appendFileSync(harness.fixture.transcriptPath, filler);

  // A FRESH reader, as a relaunched process would build it.
  harness.runner.toolCallWatch = null;
  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'the tail read could not reach the call, so readiness is UNKNOWN -- not empty');
  assert.equal(verdict.detail?.reason, 'tool-call-baseline-unanchored');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // An anchor arrives: the API was called AGAIN, which proves the call was
  // answered. The reader recovers without any whole-file scan. It has to be the
  // FIRST block of an IDENTIFIED response -- that is what makes it proof rather
  // than a guess (D23, D24).
  responseBlock(harness, {
    response: 'msg_the_next_response_after_the_filler',
    blockIndex: 0,
    content: [{ type: 'text', text: 'the call was answered and I replied' }],
  });
  // THE INTERLOCK'S OWN CLEAR FOR THE SAME FACT (#104). The anchor proves the
  // call was answered; on a real seat that answer is what ran PostToolUse (an
  // allowed call) or ended the turn (a denied one). This vector is about the
  // TRANSCRIPT reader's discharge, so the interlock's half of the same event is
  // driven explicitly rather than left half-done -- otherwise readiness would be
  // held by the interlock and the discharge under test would be invisible.
  finishToolCallHook(harness, TOOL_ID_READ);
  harness.runner.toolCallWatch = null;
  assert.equal(readinessOf(harness).ready, true, 'the anchor discharges the unknown');
});

dialogCase('D11 a degraded reader does not re-scan its megabyte every tick', (harness) => {
  atRequestEdge(harness);
  fs.appendFileSync(harness.fixture.transcriptPath, '{"type":"assistant","tool_use":\n');
  assert.equal(readinessOf(harness).detail?.reason, 'tool-call-record-unreadable');
  const at = harness.runner.toolCallWatch.degraded.detail.at;
  for (let i = 0; i < 25; i += 1) {
    assert.equal(readinessOf(harness).ready, false, 'still refusing, by name');
  }
  assert.equal(harness.runner.toolCallWatch.degraded.detail.at, at,
    'the same fault is not re-baselined on every tick');
});

// ─── RESTART WHILE A CALL IS PENDING ────────────────────────────────────────

dialogCase('D12 RESTART while a call is pending: the new process reads the tail, not the end', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, TOOL_ID_READ);
  assert.equal(readinessOf(harness).ready, false, 'setup: held before the restart');

  // A new process over the same seat: everything in memory is discarded,
  // everything on disk survives. A reader that started its cursor at the
  // transcript END would see an empty set here -- and would also never see the
  // answer, so it would be wrong forever rather than briefly.
  harness.relaunch();
  assert.equal(harness.runner.toolCallWatch, null, 'setup: the reader starts with no state');
  const afterRestart = readinessOf(harness);
  assert.equal(afterRestart.ready, false,
    'the restarted process still sees the pending call -- MUST be red for an end-anchored cursor');
  assert.deepEqual(afterRestart.detail?.tool_use_ids, [TOOL_ID_READ]);
  // The relaunched core RESUMES the persisted cycle, so it is already past
  // 'pressure' -- which is the restore shape that matters here: a cycle that
  // comes back at the checkpoint stage is exactly the one the request gate
  // fires for (#90 shape 2).
  harness.drive();
  assert.ok(
    ['checkpoint-requested', 'checkpoint-confirmed'].includes(harness.core.state.state),
    `setup: the restored cycle is at the request stage, got ${harness.core.state.state}`,
  );
  assert.equal(capsuleTextWriteCount(harness), 0, 'and writes nothing');
  assert.equal(harness.runner.lastReason?.code, 'runner-tool-call-outstanding',
    'and the refusal names the pending call, not a composer it cannot see');

  // The operator answers; the restarted process proceeds.
  settleToolCall(harness, TOOL_ID_READ, { denied: true });
  assert.equal(readinessOf(harness).ready, true);
});

// ─── LIVENESS ───────────────────────────────────────────────────────────────

dialogCase('D13 LIVENESS: ordinary successful tool execution leaves automation unstuck', (harness) => {
  atRequestEdge(harness);
  // Three ordinary turns of real work, each with tool calls that succeed.
  for (let turn = 0; turn < 3; turn += 1) {
    const a = `toolu_live_a_${turn}`;
    const b = `toolu_live_b_${turn}`;
    openToolCall(harness, [a, b]);
    assert.equal(readinessOf(harness).ready, false, `turn ${turn}: held while the calls are open`);
    settleToolCall(harness, a);
    settleToolCall(harness, b);
    assert.equal(readinessOf(harness).ready, true, `turn ${turn}: released by its own answers`);
    anchorTurn(harness, `turn ${turn} complete`);
    assert.equal(readinessOf(harness).ready, true, `turn ${turn}: and stays released`);
  }
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'the request fires normally afterwards');
  assert.equal(harness.fireEnter(), true, 'and its Enter rides a separate write');
  assert.deepEqual(heldCodes(harness), [], 'nothing was ever held at a write boundary');
});

dialogCase('D14 LIVENESS: a deferral does not spend the cycle latch -- the request still fires later', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, TOOL_ID_READ);
  for (let i = 0; i < 12; i += 1) harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
  assert.equal(harness.runner.capsuleRequestCycleId, null,
    'the one-request-per-cycle latch is unspent: a deferred cycle still owns its one write');
  assert.equal(heldCodes(harness).length, 1, 'and the hold is logged once, not once per tick');

  settleToolCall(harness, TOOL_ID_READ);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'the same cycle gets its write');
  assert.equal(harness.events('automatic-write-released').length, 1,
    'and the release is named, so the log shows the resolution and not only the hold');
});

// ─── THE DANGEROUS ORDERING: TEXT PLACED, THEN THE DIALOG, THEN THE ENTER ───

dialogCase('D15 THE DANGEROUS ORDERING: a dialog between the text and its Enter defers the Enter', (harness) => {
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the text went out on a clean, quiet seat');
  assert.equal(harness.runner.composerMayHoldControlText, true, 'setup: the composer may hold it');
  assert.notEqual(harness.runner.enterHandle, null, 'setup: its Enter is pending');

  // The tool request lands in the 400ms gap. This is the ordering the capture
  // shows: the record exists before the dialog paints.
  openToolCall(harness, TOOL_ID_READ);

  const enterWrites = () => harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length;
  assert.equal(harness.fireEnter(), true, 'the timer fires');
  assert.equal(enterWrites(), 0,
    'FIRST RED: pre-fix a CONTROL_ENTER goes out here and selects "Yes" at the dialog');

  // STRANDED-TEXT PROTECTION INTACT: the flag stays up and the Enter stays
  // owned, so nothing is lost and nothing can concatenate onto the line.
  assert.equal(harness.runner.composerMayHoldControlText, true,
    'a deferral must not clear the stranded-text flag');
  assert.notEqual(harness.runner.enterHandle, null,
    'and must not drop the Enter: the handle slot still owns the composer');
  assert.deepEqual(heldAt(harness), ['capsule-request-enter']);

  // QUEUED OPERATOR INPUT PROTECTION INTACT: operator bytes stay behind the
  // pending Enter and are never appended to the stranded command text.
  harness.runner.inputHold = true;
  harness.operator(Buffer.from('operator types while the dialog is up'));
  harness.runner.inputHold = false;
  harness.drive();
  assert.ok(queuedByteLength(harness.runner) > 0,
    'queued bytes wait behind the pending Enter, as they do for any pending control Enter');
  assert.equal(
    harness.pty.writes.filter((w) => w.toString().includes('operator types')).length, 0,
    'and are NOT concatenated onto the stranded command text',
  );

  // The operator answers the dialog. The owned Enter lands on the next fire.
  settleToolCall(harness, TOOL_ID_READ, { denied: true });
  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWrites(), 1, 'exactly one Enter, after the dialog is gone');
  assert.equal(harness.runner.composerMayHoldControlText, false, 'and the text is no longer stranded');
  assert.equal(capsuleTextWriteCount(harness), 1, 'the text was never rewritten');
});

dialogCase('D16 the deferral is bounded: past the budget the line is stranded LOUDLY, never Entered', (harness) => {
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: text out, Enter pending');
  openToolCall(harness, TOOL_ID_READ);

  // An operator who walks away from the dialog. The Enter is rescheduled, and
  // bounded: it never becomes an unbounded timer loop.
  let fires = 0;
  while (harness.fireEnter()) {
    fires += 1;
    assert.ok(fires < 1000, 'the deferral must terminate');
  }
  assert.ok(fires > 1, 'it was rescheduled rather than dropped on the first refusal');
  assert.equal(
    harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length, 0,
    'not one Enter went out across the whole budget',
  );
  assert.equal(harness.runner.lastReason?.code, 'runner-automatic-enter-stranded');
  assert.equal(harness.runner.enterHandle, null, 'the budget is spent, so the slot is released');
  assert.equal(harness.runner.composerMayHoldControlText, true,
    'and the flag stays UP: the next queued-input release must lead with a kill-line');

  // That protection is what the flag is for -- prove it still fires.
  harness.runner.inputHold = true;
  harness.operator(Buffer.from('operator input after the strand'));
  harness.runner.inputHold = false;
  harness.drive();
  const kill = harness.pty.writes.findIndex((w) => w.equals(Buffer.from(COMPOSER_KILL_LINE)));
  const bytes = harness.pty.writes.findIndex((w) => w.toString().includes('operator input after'));
  assert.ok(kill >= 0, 'the stranded line is destroyed before the queue releases');
  assert.ok(bytes > kill, 'and the operator bytes land AFTER the kill-line, never appended to the command');
});

// ─── THE OTHER SHARED WRITE BOUNDARIES ──────────────────────────────────────

dialogCase('D17 the clear: refused before a token is minted, so nothing has to be released', (harness) => {
  harness.primeAuthorized();
  openToolCall(harness, TOOL_ID_READ);

  const result = harness.attemptAutomaticClear();
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'runner-tool-call-outstanding');
  assert.equal(clearTextWrites(harness), 0,
    'FIRST RED: pre-fix /clear plus its Enter go out at the dialog');
  assert.equal(harness.runner.phase, 'idle', 'no token, no hold, no watchdog: a clean refusal');
  assert.equal(harness.runner.inputHold, false);
  assert.equal(clearIntentEventCount(harness), 0, 'and no intent was persisted');
  assert.notEqual(harness.runner.capsuleAck, null, 'the ack is NOT spent by the refusal');
  assert.deepEqual(heldAt(harness), ['clear-submission']);

  // The dialog is answered: the clear proceeds on the ack it still holds.
  settleToolCall(harness, TOOL_ID_READ, { denied: true });
  harness.attemptAutomaticClear();
  harness.flushControl();
  assert.equal(clearTextWrites(harness), 1, 'liveness: the held clear is not lost, only delayed');
});

dialogCase('D18 the clear Enter: a dialog in the gap defers it and keeps /clear from being submitted blind', (harness) => {
  harness.primeAuthorized();
  harness.attemptAutomaticClear();
  harness.flushControl();
  assert.equal(clearTextWrites(harness), 1, 'setup: /clear text written, Enter pending');
  assert.notEqual(harness.runner.enterHandle, null);

  openToolCall(harness, TOOL_ID_READ);
  const entersAfterClear = () => {
    const at = harness.pty.writes.findIndex((w) => w.equals(Buffer.from(CLEAR_CONTROL_TEXT)));
    return harness.pty.writes.slice(at + 1).filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length;
  };
  assert.equal(harness.fireEnter(), true);
  assert.equal(entersAfterClear(), 0, 'FIRST RED: pre-fix the clear Enter answers the dialog');
  assert.equal(harness.runner.composerMayHoldControlText, true, 'stranded-text flag stays up');
  assert.notEqual(harness.runner.enterHandle, null, 'the Enter stays owned');
  assert.deepEqual(heldAt(harness), ['control-enter']);

  settleToolCall(harness, TOOL_ID_READ);
  assert.equal(harness.fireEnter(), true);
  assert.equal(entersAfterClear(), 1, 'and lands once the dialog is gone');
});

dialogCase('D19 the wake Enter retry: the one wake boundary a dialog can reach is gated', (harness) => {
  rebindWithWakeEnterLanded(harness);
  assert.equal(wakeEnterWrites(harness), 1, 'setup: the first wake Enter landed');
  const wakeTranscript = wakeTranscriptPath(harness);

  // The wake Enter was swallowed, so no wake record exists -- but the operator
  // submitted their own prompt behind the released hold and the seat is now
  // working, with a dialog up. The retry would press Enter into it.
  fs.mkdirSync(path.dirname(wakeTranscript), { recursive: true });
  fs.writeFileSync(wakeTranscript, '{"type":"summary"}\n');
  appendOperatorPromptRecord(harness, 'the operator own prompt', { transcriptPath: wakeTranscript });
  openToolCall(harness, TOOL_ID_READ, { transcriptPath: wakeTranscript });

  settleChildOutput(harness);
  harness.drive();
  assert.equal(wakeEnterWrites(harness), 1,
    'FIRST RED: pre-fix the retry writes a second Enter straight into the dialog');
  assert.equal(harness.runner.wakeSubmission?.retries, 0,
    'and the retry BUDGET is not consumed by a deferral -- the retry is owed, not spent');
  assert.deepEqual(heldAt(harness), ['wake-enter-retry']);

  // The dialog is answered. The retry it was owed still happens.
  settleToolCall(harness, TOOL_ID_READ, { denied: true, transcriptPath: wakeTranscript });
  settleChildOutput(harness);
  harness.drive();
  assert.equal(wakeEnterWrites(harness), 2, 'liveness: the owed retry is delayed, not lost');
  assert.equal(harness.runner.wakeSubmission?.retries, 1);
});

// ─── THE RESIDUAL WINDOW: STATED AS A FACT, NOT CLAIMED AWAY ────────────────

dialogCase('D20 NO CHECK-THEN-WRITE RACE: a permission check recorded after the readiness read still holds the write', (harness) => {
  atRequestEdge(harness);
  // THE RACE THIS VECTOR USED TO CONCEDE. Interpose at the readiness boundary
  // itself: answer "ready" truthfully, then let the host begin a permission
  // check before the write reaches the PTY. A last-moment transcript read is
  // not an atomic lock and no transcript evidence can make it one -- which is
  // why this vector asserted, as a documented fact, that the write went out.
  //
  // WHAT CHANGED (#104 interlock). The decision and the write now happen inside
  // the same gate the hook must take to record a pending check, so a marker
  // written in that window is seen by the re-read INSIDE the gate. The hook
  // here writes NOTHING to the transcript, which is the measured 2.1.310 shape:
  // the tool_use record existed in the host's buffer and was not on disk (offset
  // 286521, file 283263 bytes, absent from all three samples taken while the
  // dialog was up). The transcript leg cannot see this call at all. The
  // interlock can.
  const real = harness.runner._automaticWriteReadiness.bind(harness.runner);
  let raced = false;
  harness.runner._automaticWriteReadiness = (where) => {
    const verdict = real(where);
    if (!raced && verdict.ready) {
      raced = true;
      const hook = harness.interlockPermissionCheck(TOOL_ID_READ);
      assert.equal(hook.action, 'allow', 'setup: the hook recorded the check and let it proceed');
    }
    return verdict;
  };

  harness.drive();
  assert.equal(raced, true, 'setup: the race was actually run');
  assert.equal(readUnflushedTranscript(harness).includes(TOOL_ID_READ), false,
    'setup: the call is NOT in the transcript -- this is the unflushed case, so the '
    + '#110 transcript reader is blind to it by construction');
  assert.equal(capsuleTextWriteCount(harness), 0,
    'FIRST RED: pre-fix the text write goes out, because the only evidence was a '
    + 'transcript read that had already answered and a transcript the host had not '
    + 'flushed. The gate closes the window: the pending map is re-read INSIDE it.');
  assert.equal(harness.runner.lastReason?.code, 'runner-permission-check-pending');
  assert.equal(harness.runner.lastReason?.detail?.readiness?.reason, 'interlock-permission-pending');
  assert.deepEqual(
    harness.runner.lastReason?.detail?.readiness?.tool_use_ids, [TOOL_ID_READ],
    'and it names the call the host is asking about',
  );
  // NOTHING SPENT. The gate is taken before the cycle_id latch, so the held
  // request is still owed.
  assert.equal(harness.runner.capsuleRequestCycleId, null, 'the cycle still owns its one request');
  assert.equal(harness.runner.interlockGate, null, 'and the gate is not leaked by the refusal');

  // LIVENESS: the dialog is cancelled. A denied call produces NO PostToolUse on
  // a real host (measured 2026-10-25), so the turn's Stop is what sweeps it --
  // and then the owed request goes out with no operator keystroke.
  harness.interlockObserved();
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'delayed, not lost, and recovered without a manual Enter');
});

dialogCase('D20b RESIDUAL, NAMED: the window before the hook has taken the gate is still open', (harness) => {
  atRequestEdge(harness);
  // THE RESIDUAL THAT REMAINS, and it is a different and much smaller one than
  // the transcript's. The gate makes "the runner decided and wrote" atomic with
  // respect to "the hook recorded a check". It cannot cover the interval between
  // the host DECIDING to call a tool and the hook PROCESS reaching the gate --
  // a node spawn. In that interval neither leg can see the call: the hook has
  // not marked it, and the host may not have flushed the record either.
  //
  // So: the text write completes (gate taken, written, released), and only THEN
  // does the host's hook reach the gate. Nothing in the transcript, as in the
  // measured 2.1.310 run.
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1,
    'HONEST: the text went out. The hook had not reached the gate while the runner '
    + 'held it, so there was nothing to see. This is the residual, stated as a fact.');
  const hook = harness.interlockPermissionCheck(TOOL_ID_READ);
  assert.equal(hook.action, 'allow', 'the hook takes the now-free gate and records the check');
  assert.equal(readUnflushedTranscript(harness).includes(TOOL_ID_READ), false,
    'and the transcript still knows nothing about it');

  // WHAT THE DESIGN STILL BUYS, in two independent ways.
  //
  // 1. THE SECOND LEG. The delayed Enter re-reads inside its own gate, so the
  //    dangerous keypress is held even though the text write lost the race --
  //    and here the transcript reader could not have held it.
  assert.equal(harness.fireEnter(), true);
  assert.equal(
    harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length, 0,
    'the Enter -- the keypress that would answer the dialog -- is held',
  );
  assert.equal(harness.runner.lastReason?.code, 'runner-permission-check-pending');
  assert.equal(harness.runner.composerMayHoldControlText, true, 'stranded-text flag stays up');
  assert.equal(harness.runner.enterDeferredAt, 'capsule-request-enter', 'and the Enter is owned, not dropped');

  // 2. THE DRAIN. The runner recorded `last_write_at` inside the gate BEFORE
  //    writing, so a hook arriving now waits out the bytes still in flight
  //    before it lets the permission check -- and therefore the dialog -- start.
  //    Bounded by INTERLOCK_DRAIN_MS, and the wait is the HOOK's, never the
  //    runner's.
  const state = harness.interlockState();
  assert.equal(typeof state.last_write_at, 'number', 'the write is stamped');
  const slept = [];
  harness.interlockHook('PreToolUse', { tool_use_id: 'toolu_SECOND', tool_name: 'Read' }, {
    now: () => state.last_write_at + 10,
    sleep: (ms) => slept.push(ms),
  });
  assert.equal(slept.length, 1, 'the hook drains once');
  assert.ok(slept[0] > 0 && slept[0] <= INTERLOCK_DRAIN_MS,
    `and the drain is bounded by INTERLOCK_DRAIN_MS, got ${slept[0]}`);
});

dialogCase('D20c THE OTHER DIRECTION: the hook cannot start a permission check while the runner holds the gate', (harness) => {
  atRequestEdge(harness);
  // MUTUAL exclusion means both directions, and this is the one D20 does not
  // cover. The runner holds the gate from the moment it decides to write until
  // the bytes are out; a hook that arrives inside that span cannot record its
  // marker, so it must not let the permission check proceed either.
  //
  // THE FALLBACK FAILS CLOSED: deny. The tool call does not run, so no dialog
  // appears, so there is nothing for an automatic keystroke to answer. A denial
  // is recoverable -- the model is told why -- whereas an automatic "Yes, and
  // switch to accept edits for this session" is not.
  const realWrite = harness.pty.write.bind(harness.pty);
  let verdict = null;
  harness.pty.write = (data) => {
    if (verdict === null && String(data).includes(CAPSULE_REQUEST_TEXT)) {
      verdict = harness.interlockPermissionCheck(TOOL_ID_READ);
    }
    return realWrite(data);
  };
  harness.drive();
  harness.pty.write = realWrite;

  assert.notEqual(verdict, null, 'setup: the hook ran inside the held span');
  assert.equal(verdict.action, 'deny',
    'the hook refuses to let the call reach the permission check while the composer '
    + 'is being written to -- bounded wait, then the fail-closed fallback');
  assert.equal(verdict.code, 'interlock-gate-busy');
  assert.equal(capsuleTextWriteCount(harness), 1, 'and the runner own write was not disturbed');
  // NOT RECORDED. A denied call never reaches a dialog, so leaving a marker for
  // it would hold automation for a permission check that cannot happen.
  assert.deepEqual(Object.keys(harness.interlockState().pending), [],
    'a denied call leaves nothing pending');

  // LIVENESS: once the span is over, the same hook call succeeds.
  assert.equal(harness.interlockPermissionCheck(TOOL_ID_READ).action, 'allow',
    'the refusal is about the span, not sticky');
});

// ─── THE ANCHOR IS A RESPONSE, NOT A RECORD ─────────────────────────────────
// MEASURED (both captures): one API response is written as SEVERAL top-level
// assistant records, one per content block, sharing `message.id`/`requestId`
// and numbered by `apiBlockIndex`:
//
//   blockIdx=0  reqId=req_011CgMaKpY...  msg.id=msg_011CgMaKpq...  thinking
//   blockIdx=1  reqId=req_011CgMaKpY...  msg.id=msg_011CgMaKpq...  tool_use
//
// So a response issuing PARALLEL tool calls lands as two records carrying
// tool_use under ONE response id. A rule that cleared on every assistant
// record drops call A when call B's record arrives, and once B's own result
// settles B the set reads EMPTY with A's dialog still on screen.
//
// The block splitting is measured. The parallel shape is INFERRED from it --
// both captures ran haiku, which issued one tool at a time -- so these vectors
// construct it from the measured record shape rather than from a capture of it.
const RESPONSE_A = 'msg_011CgMaKpqN9E1BCsz8F7h2M';
const RESPONSE_B = 'msg_011CgMaLrX67MrxkrmjfiLQ5';

// One block of one response, exactly as the host writes it.
function responseBlock(harness, {
  response, blockIndex, content, transcriptPath, sidechain = false,
}) {
  appendLine(harness, {
    type: 'assistant',
    isSidechain: sidechain === true,
    requestId: `req_for_${response}`,
    apiBlockIndex: blockIndex,
    message: { role: 'assistant', id: response, model: 'claude-haiku-5-5', content },
  }, transcriptPath);
}

const useBlock = (id) => [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'probe.txt' } }];

dialogCase('D21 PARALLEL calls split across blocks of ONE response: the second does not drop the first', (harness) => {
  atRequestEdge(harness);
  // blockIdx 0 opens the turn, then two tool_use blocks of the SAME response.
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: [{ type: 'thinking', thinking: 'two reads' }] });
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 1, content: useBlock(TOOL_ID_READ) });
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 2, content: useBlock(TOOL_ID_BASH) });

  const both = readinessOf(harness);
  assert.equal(both.ready, false);
  assert.equal(both.detail?.outstanding, 2,
    'FIRST RED for a record-scoped anchor: it would hold 1, having dropped the earlier call');
  assert.deepEqual(both.detail?.tool_use_ids.slice().sort(), [TOOL_ID_READ, TOOL_ID_BASH].sort());

  // The second call is answered. The FIRST is the one with the dialog, and it
  // must still hold the write.
  settleToolCall(harness, TOOL_ID_BASH);
  const still = readinessOf(harness);
  assert.equal(still.ready, false,
    'a record-scoped anchor reads EMPTY here -- the dialog for the first call is still up');
  assert.deepEqual(still.detail?.tool_use_ids, [TOOL_ID_READ]);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // Both answered: released.
  settleToolCall(harness, TOOL_ID_READ, { denied: true });
  assert.equal(readinessOf(harness).ready, true);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'liveness: it fires once both are settled');
});

dialogCase('D22 a NEW response still clears the previous one -- the anchor keeps working', (harness) => {
  atRequestEdge(harness);
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: useBlock(TOOL_ID_READ) });
  assert.equal(readinessOf(harness).ready, false, 'setup: response A has a call open');

  // A new response proves A's calls were answered, even with no tool_result
  // record in the window at all (the restart/unread-region case).
  responseBlock(harness, { response: RESPONSE_B, blockIndex: 0, content: [{ type: 'text', text: 'done' }] });
  assert.equal(readinessOf(harness).ready, true,
    'a DIFFERENT response is the anchor: the API cannot be called again with A unanswered');
});

dialogCase('D23 a window that begins MID-response cannot discharge calls it never saw', (harness) => {
  atRequestEdge(harness);
  // Response A's first block opens a call. Then a non-anchor filler run pushes
  // it out of the baseline span, and the first record the tail can reach is a
  // LATER block of that same response.
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: useBlock(TOOL_ID_READ) });
  const filler = `${JSON.stringify({ type: 'attachment', message: { role: 'user', content: 'x'.repeat(200_000) } })}\n`;
  for (let i = 0; i < 7; i += 1) fs.appendFileSync(harness.fixture.transcriptPath, filler);
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 7, content: [{ type: 'text', text: 'still response A' }] });

  harness.runner.toolCallWatch = null;
  const midResponse = readinessOf(harness);
  assert.equal(midResponse.ready, false,
    'blockIdx 7 of a response is NOT proof that an earlier block of the same response '
    + 'opened nothing -- discharging there is the fail-open');
  assert.equal(midResponse.detail?.reason, 'tool-call-baseline-unanchored');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // The FIRST block of a new response is proof, and discharges it.
  responseBlock(harness, { response: RESPONSE_B, blockIndex: 0, content: [{ type: 'text', text: 'a new response' }] });
  harness.runner.toolCallWatch = null;
  assert.equal(readinessOf(harness).ready, true,
    'apiBlockIndex 0 of a new response is the one record that proves it');
});

dialogCase('D24 an assistant record with NO response identity clears nothing and discharges nothing', (harness) => {
  atRequestEdge(harness);
  // openToolCall writes a record with no message.id, no requestId and no
  // apiBlockIndex -- the shape this suite used before the response scoping, and
  // the shape a future format change would produce.
  openToolCall(harness, TOOL_ID_READ);
  assert.equal(readinessOf(harness).ready, false, 'the call is open');

  // Another identity-less assistant record must NOT be read as a new response.
  anchorTurn(harness, 'no identity on this record either');
  const after = readinessOf(harness);
  assert.equal(after.ready, false,
    'conservative, never permissive: an unidentifiable record cannot clear a live call');
  assert.deepEqual(after.detail?.tool_use_ids, [TOOL_ID_READ]);

  // Its own answer still settles it, so the reader cannot wedge on this path.
  settleToolCall(harness, TOOL_ID_READ);
  assert.equal(readinessOf(harness).ready, true,
    'liveness: results settle by id regardless of response identity');
});

// ─── A SUBAGENT'S RESPONSE IS NOT AN ANCHOR ─────────────────────────────────
// The anchor argument is "the API cannot be called again while a tool_use in
// the previous assistant message is unanswered". That holds WITHIN one
// conversation. A subagent is a DIFFERENT conversation, driven by its own API
// calls, so its responses say nothing about the main conversation's calls.
//
// MEASURED (2026-10-24, a real subagents/agent-*.jsonl): a sidechain assistant
// record carries its own message.id, requestId AND apiBlockIndex -- blockIdx 0
// thinking, 1 text, 2 tool_use under one message.id. It therefore satisfies
// both `fresh` and `startsResponse`, so an unscoped anchor clears a
// main-conversation call on it. D5's property (a subagent's call COUNTS,
// because it raises the same dialog on the same screen) must survive.
//
// REACHABILITY, stated: on 2.1.310 subagent records go to a SEPARATE file and
// the bound transcript holds none, so these two vectors defend the INLINE shape
// -- the one #79 had to exclude in isAckLine/isCapsuleRequestRecord, and the one
// D5 asserts. The reader does not get to assume it away.
dialogCase('D25 a SUBAGENT response is not an anchor: it cannot clear the main conversation\'s call', (harness) => {
  atRequestEdge(harness);
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: useBlock(TOOL_ID_READ) });
  assert.equal(readinessOf(harness).ready, false, 'the main conversation has a call open');

  // The subagent's own response, in the measured shape.
  responseBlock(harness, {
    response: 'msg_011CgSubagentOwnResponse01',
    blockIndex: 0,
    sidechain: true,
    content: [{ type: 'text', text: 'the subagent is talking to itself' }],
  });
  const after = readinessOf(harness);
  assert.equal(after.ready, false,
    'FIRST RED: the sidechain record satisfied fresh AND startsResponse, so it cleared the set '
    + 'and the write would have gone out with the dialog on screen');
  assert.deepEqual(after.detail?.tool_use_ids, [TOOL_ID_READ]);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // The main conversation's own answer still releases: the exclusion is narrow.
  settleToolCall(harness, TOOL_ID_READ);
  assert.equal(readinessOf(harness).ready, true, 'liveness: the real answer still releases');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1);
});

dialogCase('D26 a SUBAGENT response cannot discharge an unanchored baseline either', (harness) => {
  atRequestEdge(harness);
  openToolCall(harness, TOOL_ID_READ);
  // Push the call beyond the baseline span, as D10 does.
  const filler = `${JSON.stringify({ type: 'attachment', message: { role: 'user', content: 'x'.repeat(200_000) } })}\n`;
  for (let i = 0; i < 7; i += 1) fs.appendFileSync(harness.fixture.transcriptPath, filler);

  // A subagent response lands in the readable tail. It must NOT be taken as
  // proof that the unreachable region's calls were answered.
  responseBlock(harness, {
    response: 'msg_011CgSubagentOwnResponse02',
    blockIndex: 0,
    sidechain: true,
    content: [{ type: 'text', text: 'subagent output in the tail' }],
  });
  harness.runner.toolCallWatch = null;
  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED: a sidechain record discharged the unknown prefix it never covered');
  assert.equal(verdict.detail?.reason, 'tool-call-baseline-unanchored');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // A real response of the MAIN conversation still discharges it.
  responseBlock(harness, {
    response: 'msg_011CgMainConversationNext1',
    blockIndex: 0,
    content: [{ type: 'text', text: 'the main conversation replied' }],
  });
  // As in D10: the interlock's half of "that call was answered" (#104).
  finishToolCallHook(harness, TOOL_ID_READ);
  harness.runner.toolCallWatch = null;
  assert.equal(readinessOf(harness).ready, true, 'liveness: a real anchor still discharges');
});

// ─── B1: AN OVERSIZE-RECORD STEP IS NOT DISCHARGED BY `responsesSeen >= 2` ──
//
// THE COVERAGE GAP THIS CLOSES FIRST. Nothing in D1-D26 ever produced a record
// LARGER THAN ONE WINDOW, so _stepToolCallWindow's oversize branch -- the one
// that steps the cursor over an unread region and raises `unknownOpen` -- had
// zero coverage. D10/D23/D26's fillers are 200 KiB lines, deliberately under
// the 256 KiB window. These vectors really cross it.
//
// THE DEFECT. The two-response discharge argument ("the first response proves
// everything before it was answered, the second proves the first's calls were")
// holds only when the unknown region is the PREFIX OF THE SCAN. `responsesSeen`
// is a running count over the whole scan and was never reset, so it is already
// >= 2 by the time any real tail has been walked -- the clause was effectively
// always satisfied. And a stepped-over record is never PARSED, so it never sets
// `openResponse`; that makes the very next assistant record `fresh`
// unconditionally, INCLUDING a later content block of the stepped record's own
// response.
//
// REACHABILITY IS ORDINARY, not contrived: a Write/Edit/MultiEdit carrying more
// than 256 KiB of `input.content` is exactly the tool shape that raises the
// permission dialog, and a parallel batch with a large write in it is routine.

// A single record that genuinely exceeds one window, carrying a tool call --
// the measured Write/Edit shape, where the file body lives in input.content.
function oversizeWriteCall(harness, { response, blockIndex, id, bytes = 300_000, transcriptPath }) {
  appendLine(harness, {
    type: 'assistant',
    isSidechain: false,
    requestId: `req_for_${response}`,
    apiBlockIndex: blockIndex,
    message: {
      role: 'assistant',
      id: response,
      model: 'claude-haiku-5-5',
      content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: 'big.txt', content: 'x'.repeat(bytes) } }],
    },
  }, transcriptPath);
}

const OVERSIZE_WRITE_ID = 'toolu_01OversizeWriteCallAAA';
const SIBLING_READ_ID = 'toolu_01SmallSiblingReadBBB';

dialogCase('D27 B1: a sibling block cannot discharge an oversize-stepped record of its OWN response', (harness) => {
  atRequestEdge(harness);
  // A settled earlier response, so the scan holds one anchor before the step.
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: [{ type: 'text', text: 'first turn' }] });
  // Response B block 0: the Write whose dialog is on screen. One record, and
  // bigger than a whole window, so the reader can only step over it.
  oversizeWriteCall(harness, { response: RESPONSE_B, blockIndex: 0, id: OVERSIZE_WRITE_ID });
  // Response B block 1: a small parallel sibling, auto-approved.
  responseBlock(harness, { response: RESPONSE_B, blockIndex: 1, content: useBlock(SIBLING_READ_ID) });
  // The sibling's own answer arrives. The Write's dialog is STILL up.
  settleToolCall(harness, SIBLING_READ_ID);

  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED for B1: the stepped region may hold a call, and a LATER BLOCK OF THE SAME '
    + 'RESPONSE proves nothing about it -- pre-fix this reads ready, so the automatic Enter '
    + 'goes out at the Write dialog');
  // The reader cannot name the id (it never parsed the record), so it must say
  // so rather than present an empty set.
  assert.ok(
    harness.runner.toolCallWatch.unknownOpen === true
    || (verdict.detail?.tool_use_ids || []).includes(OVERSIZE_WRITE_ID),
    'and it is honest about WHY: either the unknown stands, or the id is named',
  );
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'nothing is written at the dialog');

  // CONTROL, the coordinator's own: the identical transcript with a small
  // content field is held correctly, which is what isolates the oversize step
  // as the mechanism rather than the record shape.
  const control = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    atRequestEdge(control);
    responseBlock(control, { response: RESPONSE_A, blockIndex: 0, content: [{ type: 'text', text: 'first turn' }] });
    oversizeWriteCall(control, { response: RESPONSE_B, blockIndex: 0, id: OVERSIZE_WRITE_ID, bytes: 1_000 });
    responseBlock(control, { response: RESPONSE_B, blockIndex: 1, content: useBlock(SIBLING_READ_ID) });
    settleToolCall(control, SIBLING_READ_ID);
    const held = readinessOf(control);
    assert.equal(held.ready, false, 'control: held');
    assert.deepEqual(held.detail?.tool_use_ids, [OVERSIZE_WRITE_ID],
      'control: and the readable record names the very call the oversize arm loses');
  } finally {
    control.cleanup();
  }
});

dialogCase('D28 B1 variant: no parallel call needed -- ANY later block of that response discharged it', (harness) => {
  atRequestEdge(harness);
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: [{ type: 'text', text: 'first turn' }] });
  oversizeWriteCall(harness, { response: RESPONSE_B, blockIndex: 0, id: OVERSIZE_WRITE_ID });
  // A plain text continuation block of the SAME response. No tool call at all.
  responseBlock(harness, { response: RESPONSE_B, blockIndex: 1, content: [{ type: 'text', text: 'writing that file now' }] });

  assert.equal(readinessOf(harness).ready, false,
    'FIRST RED for the B1 variant: a text block of the stepped record OWN response '
    + 'proves nothing, and needs no sibling tool call to do the damage');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
});

dialogCase('D29 B1 liveness: block 0 of a DIFFERENT response after a step still discharges', (harness) => {
  atRequestEdge(harness);
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: [{ type: 'text', text: 'first turn' }] });
  oversizeWriteCall(harness, { response: RESPONSE_B, blockIndex: 0, id: OVERSIZE_WRITE_ID });
  // The FIRST block of a genuinely NEW response. The API was called again, so
  // every call of the stepped-over response is answered. `startsResponse` is
  // sound here and must keep working -- the fix must not break it.
  responseBlock(harness, {
    response: 'msg_a_third_response_entirely',
    blockIndex: 0,
    content: [{ type: 'text', text: 'the write finished and I replied' }],
  });

  assert.equal(readinessOf(harness).ready, true,
    'startsResponse of a NEW response is real proof after a step -- this must stay green, '
    + 'or the fix has traded a fail-open for a wedge');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'and the held write goes out');
});

dialogCase('D30 B1 liveness: the PREFIX two-response discharge the >= 2 clause exists for still works', (harness) => {
  atRequestEdge(harness);
  // Push the scan start above byte zero so `unknownOpen` comes from the scan
  // PREFIX -- the one case the two-response argument is actually valid for.
  const filler = `${JSON.stringify({ type: 'attachment', message: { role: 'user', content: 'x'.repeat(200_000) } })}\n`;
  for (let i = 0; i < 7; i += 1) fs.appendFileSync(harness.fixture.transcriptPath, filler);
  // Two distinct responses, NEITHER carrying apiBlockIndex, so `startsResponse`
  // is false for both and only the two-response argument can discharge.
  for (const response of ['msg_prefix_response_one', 'msg_prefix_response_two']) {
    appendLine(harness, {
      type: 'assistant',
      isSidechain: false,
      requestId: `req_for_${response}`,
      message: { role: 'assistant', id: response, model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ordinary turn' }] },
    });
  }

  harness.runner.toolCallWatch = null;
  assert.equal(readinessOf(harness).ready, true,
    'the two-response argument is SOUND for a scan prefix and must survive the fix: '
    + 'the first response proves every call before it was answered, the second proves '
    + 'the first own calls were');
});

dialogCase('D31 B1: the refusal names an oversize STEP distinctly from an unanchored baseline', (harness) => {
  atRequestEdge(harness);
  responseBlock(harness, { response: RESPONSE_A, blockIndex: 0, content: [{ type: 'text', text: 'first turn' }] });
  oversizeWriteCall(harness, { response: RESPONSE_B, blockIndex: 0, id: OVERSIZE_WRITE_ID });

  const stepped = readinessOf(harness);
  assert.equal(stepped.ready, false);
  assert.ok(
    stepped.detail?.reason === 'tool-call-oversize-record-unread'
    || stepped.detail?.reason === 'oversize-record-unread',
    'an operator needs to tell "a record bigger than the window went unread" from '
    + `"the tail held no anchor" -- they have different answers; got ${stepped.detail?.reason}`,
  );
  assert.ok(typeof stepped.detail?.at === 'number' || typeof stepped.detail?.from === 'number',
    'and it says where, so the record can be found');
});

// ─── B2: THE DEFERRAL MUST NOT WITHHOLD THE OPERATOR'S OWN KEYSTROKES ───────
//
// THE DEFECT, and it is a mutual wait. handleOperatorData queues whenever
// `inputHold || wakeEnterHandle !== null || enterHandle !== null ||
// composerMayHoldControlText`, and _flushQueuedInput returns early on
// `enterHandle !== null`. The #104 deferral holds `enterHandle` non-null for up
// to AUTOMATIC_ENTER_DEFERRAL_LIMIT x controlEnterDelayMs.
//
// So in the DIALOG case the deferral's only termination condition is the
// operator answering the dialog -- and the operator's answer is precisely what
// is being withheld. Resolved only by the budget expiring about a minute later.
// Before #104, `enterHandle` was non-null for the 400 ms two-phase gap and the
// hold was imperceptible; it is now a minute-long operator blackout at the one
// moment the human must act.
//
// NOT a wedge, and the docs must say that accurately: the tick path
// (`!inputHold && queuedInput.length > 0 && !_flushQueuedInput()`) flushes after
// the strand, and the kill-line branch destroys the stranded text before
// releasing the bytes. Bounded ~60 s blackout, not an indefinite lockout.
//
// THE RULE THESE VECTORS PIN: operator bytes arriving while an automatic Enter
// is DEFERRED mean the operator is taking over. Strand that Enter at once, then
// let the existing kill-line + flush path destroy the stranded automatic text
// and deliver the operator's bytes -- without waiting for a tick. A NORMALLY
// pending Enter (lands in 400 ms) keeps the old behaviour, because the
// no-concatenation invariant is still correct for it.

function enterWriteCount(harness) {
  return harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length;
}
function writeIndexOf(harness, needle) {
  return harness.pty.writes.findIndex((w) => w.toString('latin1').includes(needle));
}
function killLineIndexes(harness) {
  return harness.pty.writes
    .map((w, i) => (w.equals(Buffer.from(COMPOSER_KILL_LINE)) ? i : -1))
    .filter((i) => i >= 0);
}

// Text out, Enter pending, dialog up, Enter deferred. The state B2 lives in.
function deferredEnterAtDialog(harness) {
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the request text went out');
  assert.notEqual(harness.runner.enterHandle, null, 'setup: its Enter is pending');
  openToolCall(harness, TOOL_ID_READ);
  assert.equal(harness.fireEnter(), true, 'setup: the timer fires');
  assert.equal(enterWriteCount(harness), 0, 'setup: and the Enter is held, not written');
  assert.notEqual(harness.runner.enterHandle, null, 'setup: it was rescheduled, so it is DEFERRED');
  assert.equal(harness.runner.composerMayHoldControlText, true, 'setup: text may be stranded');
  assert.equal(harness.runner.inputHold, false, 'setup: no hold -- the operator is free to type');
}

dialogCase('D32 B2: operator bytes during a DEFERRED Enter reach the child, and strand that Enter', (harness) => {
  deferredEnterAtDialog(harness);

  // The operator answers the dialog. ESC is the one key that cancels it, and it
  // is the key the deferral was withholding while waiting for its effect.
  const esc = Buffer.from([0x1b]);
  harness.operator(esc);

  assert.equal(queuedByteLength(harness.runner), 0,
    'FIRST RED for B2: the operator\'s answer to the dialog must not sit in the queue -- '
    + 'pre-fix it waits out the whole ~60s budget, and the dialog is waiting for it');
  assert.ok(writeIndexOf(harness, '\u001b') >= 0, 'the bytes physically reached the child');

  // THE OPERATOR TAKING OVER STRANDS THE AUTOMATIC ENTER. Immediately: the
  // timer is cancelled and the slot released, so nothing can submit the
  // automatic text later behind the operator's back.
  assert.equal(harness.runner.enterHandle, null, 'the deferred Enter is released, not left armed');
  assert.equal(harness.fireEnter(), false, 'and its timer is cancelled, not merely orphaned');
  assert.equal(enterWriteCount(harness), 0, 'no automatic Enter ever went out');

  // AND THE NO-CONCATENATION INVARIANT STILL HOLDS: the stranded command text
  // is destroyed by a kill-line BEFORE the operator's bytes land.
  const kill = killLineIndexes(harness);
  assert.ok(kill.length >= 1, 'a kill-line destroyed the stranded automatic text');
  assert.ok(kill[kill.length - 1] < writeIndexOf(harness, '\u001b'),
    'and it landed BEFORE the operator bytes, so nothing concatenated onto /context-capsule');
  assert.equal(harness.runner.composerMayHoldControlText, false,
    'the flag is down once the kill-line has actually destroyed the text');

  // Later ticks must not resurrect it.
  for (let i = 0; i < 10; i += 1) harness.drive();
  assert.equal(enterWriteCount(harness), 0, 'still no automatic Enter');
  assert.equal(capsuleTextWriteCount(harness), 1, 'and the text was not rewritten');
});

dialogCase('D33 B2: a NORMALLY pending Enter still queues operator bytes -- the invariant is unchanged', (harness) => {
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: text out');
  assert.notEqual(harness.runner.enterHandle, null, 'setup: Enter pending, NOT deferred');
  assert.equal(harness.events('automatic-write-held').length, 0, 'setup: nothing was held');

  // No dialog, no deferral: this Enter lands in 400ms and the composer holds
  // unsubmitted command text. Operator bytes written through now would
  // concatenate onto it and their CR would submit the blend (PATCH-001S-r2).
  harness.operator(Buffer.from('operator types in the two-phase gap'));
  assert.ok(queuedByteLength(harness.runner) > 0,
    'they must still QUEUE -- the fix must not open this hole');
  assert.equal(writeIndexOf(harness, 'operator types in the two-phase gap'), -1,
    'and must not reach the child ahead of the Enter');

  // The Enter lands normally, then the queue releases behind it.
  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWriteCount(harness), 1, 'the automatic Enter is NOT stranded by a normal pend');
  harness.drive();
  assert.ok(writeIndexOf(harness, 'operator types in the two-phase gap') > 0,
    'and the operator bytes follow it');
});

dialogCase('D34 B2: an input HOLD still wins -- a deferred Enter opens no hole through it', (harness) => {
  deferredEnterAtDialog(harness);
  // A hold means another automatic transaction owns the composer. The operator
  // takeover rule must not override that.
  harness.runner.inputHold = true;
  harness.operator(Buffer.from('bytes arriving during a hold'));
  assert.ok(queuedByteLength(harness.runner) > 0,
    'held bytes stay held: the deferral rule is about the Enter slot, not about holds');
  assert.equal(writeIndexOf(harness, 'bytes arriving during a hold'), -1);
});

dialogCase('D35 B2: the operator takeover is named, so a minute of silence is never the record', (harness) => {
  deferredEnterAtDialog(harness);
  harness.operator(Buffer.from([0x1b]));
  const stranded = harness.runner.events.filter(
    (e) => e.name === 'automatic-enter-stranded' || e.name === 'automatic-enter-operator-takeover',
  );
  assert.ok(stranded.length >= 1, 'the strand is an event, not an inference');
  assert.ok(
    /operator/.test(JSON.stringify(stranded[stranded.length - 1].detail ?? {}))
    || /operator/.test(harness.runner.lastReason?.code ?? ''),
    'and it says the OPERATOR caused it, not that a budget ran out',
  );
  assert.match(allRunnerLogs(harness), /automatic-enter/, 'durable, not memory-only');
});

// ─── M6: NO AUTOMATIC TEXT LITERAL MAY CONTAIN A DIGIT ──────────────────────
//
// The ungated automatic TEXT writes are safe partly for a reason that was only
// a comment: '/clear', '/context-capsule' and WAKE_MESSAGE contain NO DIGITS.
// At the permission dialog a digit selects that option directly -- so a literal
// carrying a `2` would answer "Yes, and switch to accept edits ... for this
// session" with no Enter involved at all, which is the worst #104 outcome and
// reachable without any of the Enter machinery. WAKE_MESSAGE is prose and could
// acquire a numeral in an ordinary edit, so this is an assertion now, evaluated
// at module load as well as here.
test('#104 M6 no automatic text literal may contain a digit (a digit answers the dialog directly)', () => {
  for (const [name, literal] of [
    ['CLEAR_CONTROL_TEXT', CLEAR_CONTROL_TEXT],
    ['CAPSULE_REQUEST_TEXT', CAPSULE_REQUEST_TEXT],
    ['WAKE_MESSAGE', WAKE_MESSAGE],
  ]) {
    assert.equal(automaticTextLiteralProblem(name, literal), null,
      `${name} must carry no digit: at a permission dialog a digit selects that option`);
  }
  // NON-VACUOUS: the guard has to bite, or it is decoration. These are the two
  // shapes an ordinary edit to WAKE_MESSAGE would produce.
  const problem = automaticTextLiteralProblem('SYNTHETIC', 'run step 2 of the procedure');
  assert.ok(problem, 'the predicate must reject a digit-bearing literal');
  assert.equal(problem.code, 'automatic-text-literal-carries-digit');
  assert.match(problem.detail, /"2"/, 'and name the offending character');
  assert.match(problem.detail, /index 9/, 'and where it is');
  assert.equal(automaticTextLiteralProblem('SYNTHETIC', 'no numerals here'), null);
  assert.ok(automaticTextLiteralProblem('SYNTHETIC', undefined),
    'a non-string literal is also a problem, not a pass');
});

// ─── S2: THE requestId FALLBACK MIXES IDENTITY SPACES ───────────────────────
//
// The code and the docs both claimed "if either field ever disappears the
// reader goes conservative, never permissive". That is FALSE for a PARTIAL
// disappearance. `response` is `message.id` when present and `requestId`
// otherwise, with no record of which one it came from -- so block 0 carrying
// only `requestId` and block 1 carrying only `message.id` yield two different
// strings for the SAME response, block 1 reads as a new response, and it clears
// block 0's live call.
//
// Latent: both fields were measured present on every assistant record of both
// captures. But an invariant that is stated has to be true or withdrawn, and
// this one is cheap to make true -- tag the space (`msg:` / `req:`) and treat a
// change of space as "cannot say": not fresh, no clear, no discharge.

const S2_CALL_FIRST = 'toolu_01S2FirstBlockCallAAA';
const S2_CALL_SECOND = 'toolu_01S2SecondBlockCallBB';

// One block, with control over WHICH identity fields it carries.
function partialIdentityBlock(harness, {
  response, blockIndex, content, carry, transcriptPath,
}) {
  const record = {
    type: 'assistant',
    isSidechain: false,
    apiBlockIndex: blockIndex,
    message: { role: 'assistant', model: 'claude-haiku-5-5', content },
  };
  if (carry === 'req' || carry === 'both') record.requestId = `req_${response}`;
  if (carry === 'msg' || carry === 'both') record.message.id = `msg_${response}`;
  appendLine(harness, record, transcriptPath);
}

dialogCase('D36 S2: a PARTIAL identity disappearance must not read as a new response', (harness) => {
  atRequestEdge(harness);
  // Both blocks belong to ONE response. Block 0 carries only requestId; block 1
  // carries only message.id. Nothing about the conversation changed -- only
  // which field the host happened to write.
  partialIdentityBlock(harness, {
    response: 'one_and_only_response', blockIndex: 0, carry: 'req', content: useBlock(S2_CALL_FIRST),
  });
  const first = readinessOf(harness);
  assert.equal(first.ready, false, 'setup: block 0 opened a call');
  assert.deepEqual(first.detail?.tool_use_ids, [S2_CALL_FIRST]);

  partialIdentityBlock(harness, {
    response: 'one_and_only_response', blockIndex: 1, carry: 'msg', content: useBlock(S2_CALL_SECOND),
  });
  const both = readinessOf(harness);
  assert.equal(both.detail?.outstanding, 2,
    'FIRST RED for S2: the space change made block 1 look like a NEW response, so it '
    + 'CLEARED block 0 live call -- pre-fix the set holds 1, not 2');
  assert.deepEqual(both.detail?.tool_use_ids.slice().sort(), [S2_CALL_FIRST, S2_CALL_SECOND].sort());

  // And the second call's own answer must not empty the set.
  settleToolCall(harness, S2_CALL_SECOND);
  const still = readinessOf(harness);
  assert.equal(still.ready, false, 'the first call is still unanswered');
  assert.deepEqual(still.detail?.tool_use_ids, [S2_CALL_FIRST]);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'and nothing is written at its dialog');
});

dialogCase('D37 S2: a space change cannot DISCHARGE an unknown either', (harness) => {
  atRequestEdge(harness);
  // Start the scan above byte zero so the unknown is the scan prefix.
  const filler = `${JSON.stringify({ type: 'attachment', message: { role: 'user', content: 'x'.repeat(200_000) } })}\n`;
  for (let i = 0; i < 7; i += 1) fs.appendFileSync(harness.fixture.transcriptPath, filler);
  // Two records that LOOK like two responses only because the space flipped.
  // Neither carries apiBlockIndex, so only the two-response argument could
  // discharge -- and it must not, because there may be only one response here.
  partialIdentityBlock(harness, {
    response: 'same_response_twice', blockIndex: undefined, carry: 'req', content: [{ type: 'text', text: 'a' }],
  });
  partialIdentityBlock(harness, {
    response: 'same_response_twice', blockIndex: undefined, carry: 'msg', content: [{ type: 'text', text: 'b' }],
  });

  harness.runner.toolCallWatch = null;
  assert.equal(readinessOf(harness).ready, false,
    'two spaces of ONE identity are not two responses, so they cannot discharge a prefix');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
});

dialogCase('D38 S2 liveness: a consistent space still anchors, in either space', (harness) => {
  for (const carry of ['msg', 'req']) {
    const h = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
    try {
      atRequestEdge(h);
      partialIdentityBlock(h, {
        response: 'response_one', blockIndex: 0, carry, content: useBlock(S2_CALL_FIRST),
      });
      assert.equal(readinessOf(h).ready, false, `${carry}: the call is open`);
      // A genuinely different response, in the SAME space: a real anchor.
      partialIdentityBlock(h, {
        response: 'response_two', blockIndex: 0, carry, content: [{ type: 'text', text: 'done' }],
      });
      assert.equal(readinessOf(h).ready, true,
        `${carry}: a real new response in a consistent space must still clear -- `
        + 'tagging the space must not cost the anchor');
    } finally {
      h.cleanup();
    }
  }
});

// ─── A TRANSCRIPT PATH THAT IS NOT A FILE ───────────────────────────────────
//
// CI (ubuntu) went red on W6's `unreadable` case while Windows stayed green,
// and the split is a `stat` difference, verified on both platforms rather than
// inferred:
//
//   Windows  statSync(dir).size === 0   -> the reader takes the ZERO-LENGTH
//            branch, which is positive evidence ("no records, so no call"),
//            and answers READY.
//   Linux    statSync(dir).st_size === 40 (non-zero) -> the window read runs,
//            readSync throws EISDIR, the reader goes degraded, and answers
//            NOT READY.
//
// The Linux answer is the correct one and the Windows answer is a fail-open:
// a path that resolves to a DIRECTORY is not a transcript, and "I cannot read
// it" must never become "there are no tool calls" -- the exact substitution
// this whole unit exists to prevent. That it reached a positive verdict only
// because a directory happens to stat as zero bytes on one platform makes it
// an accident, not a decision.
//
// So the reader rejects a non-regular-file explicitly, which also makes the two
// platforms agree instead of encoding a `stat` quirk as behaviour.
dialogCase('D39 a transcript path that is a DIRECTORY is not evidence of an empty call set', (harness) => {
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: a real transcript file reads ready');

  // Replace the transcript with a directory at the same path.
  fs.rmSync(harness.fixture.transcriptPath);
  fs.mkdirSync(harness.fixture.transcriptPath, { recursive: true });
  harness.runner.toolCallWatch = null;

  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED ON WINDOWS: statSync(dir).size is 0 here, so the zero-length '
    + '"no records, no calls" branch answers ready -- a fail-open that ubuntu CI '
    + 'caught only because a directory stats non-zero there');
  assert.equal(verdict.code, 'runner-tool-call-readiness-unknown');
  assert.equal(verdict.detail?.reason, 'tool-call-transcript-not-a-file',
    'and it is named for what it is, not for whichever read error the platform '
    + 'happens to raise (EISDIR on linux, nothing at all on win32)');

  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'and no automatic write goes out');

  // LIVENESS: a real file at that path again is read normally.
  fs.rmSync(harness.fixture.transcriptPath, { recursive: true });
  fs.writeFileSync(harness.fixture.transcriptPath, '0123456789\n');
  harness.runner.toolCallWatch = null;
  assert.equal(readinessOf(harness).ready, true, 'the refusal is about the path, not sticky');
});

// ─── ENOENT IS NOT POSITIVE EVIDENCE AT EVERY BOUNDARY ──────────────────────
//
// THE ARGUMENT THAT WAS OVER-APPLIED. An absent transcript was read as "the
// host has written no records, so no tool dialog can exist". That is sound for
// the post-clear WAKE: a brand-new session genuinely has written nothing, and
// W1/W4/W6/W9/W10 all depend on it.
//
// It is NOT sound at the capsule-request or clear boundary. Those fire because
// the session reached ~80% context pressure, so that session provably HAS a
// transcript. ENOENT there cannot mean "no records yet" -- it means the path
// mis-resolved (wrong session id, wrong cwd, wrong home) -- and answering ready
// means the runner writes command text plus a CONTROL_ENTER blind. #104 again,
// by a sixth route.
//
// Reproduced against the shipped reader before writing these:
//   ENOENT on a resolved path : {"ready":true,...}
//   mis-resolved session path : {"ready":true,...}
//   (the real path says)      : {"ready":false,"code":"runner-tool-call-outstanding",
//                                "tool_use_ids":["toolu_LIVE_CALL"]}
//   _automaticWriteReadiness parameters: 0
//
// That last line is the structural half: readiness took no boundary argument,
// so no call site could ask for a stricter answer even if it wanted one.

// Point the READER's path resolution at a file that does not exist, leaving the
// real transcript on disk so the checkpoint observables still pass. That is the
// mis-resolution shape: the reader looks somewhere nothing was ever written.
function misresolveReaderPath(harness) {
  const gone = path.join(path.dirname(harness.fixture.transcriptPath), 'session-not-here.jsonl');
  assert.equal(fs.existsSync(gone), false, 'setup: the reader path does not exist');
  harness.runner._transcriptPath = () => gone;
  return gone;
}

dialogCase('D40 ENOENT at the CLEAR boundary refuses by name and writes nothing', (harness) => {
  harness.primeAuthorized();
  assert.notEqual(harness.runner.capsuleAck, null, 'setup: this cycle holds its ack');
  misresolveReaderPath(harness);

  const result = harness.attemptAutomaticClear();
  assert.equal(result.status, 'refused',
    'FIRST RED: an absent transcript at the clear boundary cannot mean "no calls" -- '
    + 'this session is at pressure, so it HAS a transcript, and ENOENT means the path '
    + 'mis-resolved. Pre-fix the clear reaches submission-prepared: token minted, intent '
    + 'persisted, hold taken, and /clear plus its Enter then go out blind');
  assert.equal(clearTextWrites(harness), 0, 'and no text was written');
  assert.equal(result.code, 'runner-tool-call-readiness-unknown');
  assert.equal(result.detail?.readiness?.reason, 'tool-call-transcript-absent');
  assert.equal(result.detail?.at, 'clear-submission', 'and names the boundary');

  // A clean refusal: nothing minted, nothing spent, nothing held.
  assert.equal(harness.runner.phase, 'idle');
  assert.equal(harness.runner.inputHold, false);
  assert.equal(clearIntentEventCount(harness), 0, 'no intent persisted');
  assert.notEqual(harness.runner.capsuleAck, null, 'the ack is NOT spent by the refusal');
  assert.equal(
    harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length, 0,
    'and no Enter rode behind it',
  );
  assert.match(allRunnerLogs(harness), /tool-call-transcript-absent/, 'durable, not memory-only');

  // LIVENESS: once the reader resolves the real transcript again, the held
  // clear proceeds on the ack it still has.
  delete harness.runner._transcriptPath;
  harness.attemptAutomaticClear();
  harness.flushControl();
  assert.equal(clearTextWrites(harness), 1, 'delayed, not lost');
});

dialogCase('D41 ENOENT at the CAPSULE-REQUEST boundary refuses by name and writes nothing', (harness) => {
  atRequestEdge(harness);
  misresolveReaderPath(harness);

  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0,
    'FIRST RED: same argument, same session, same impossibility');
  assert.equal(harness.fireEnter(), false, 'and no Enter was scheduled');
  assert.equal(harness.runner.lastReason?.code, 'runner-tool-call-readiness-unknown');
  assert.equal(harness.runner.lastReason?.detail?.readiness?.reason, 'tool-call-transcript-absent');
  assert.deepEqual(heldAt(harness), ['capsule-request']);
  assert.equal(harness.runner.capsuleRequestCycleId, null,
    'and the cycle latch is unspent, so the request is still owed');

  delete harness.runner._transcriptPath;
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'liveness: it fires once the path resolves');
});

dialogCase('D42 ENOENT at a delayed ENTER defers it rather than pressing blind', (harness) => {
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: text out, Enter pending');
  // The path goes missing in the two-phase gap.
  misresolveReaderPath(harness);

  assert.equal(harness.fireEnter(), true, 'the timer fires');
  assert.equal(
    harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length, 0,
    'FIRST RED: a bare Enter must not go out while the reader cannot see the session',
  );
  assert.deepEqual(heldAt(harness), ['capsule-request-enter']);
  assert.equal(harness.runner.composerMayHoldControlText, true, 'stranded-text flag stays up');
  assert.notEqual(harness.runner.enterHandle, null, 'and the Enter stays owned');

  delete harness.runner._transcriptPath;
  assert.equal(harness.fireEnter(), true);
  assert.equal(
    harness.pty.writes.filter((w) => w.equals(Buffer.from(CONTROL_ENTER))).length, 1,
    'and lands once the session is visible again',
  );
});

dialogCase('D43 the asymmetry is the point: ENOENT stays READY at the wake retry', (harness) => {
  // Pinned in ONE place so the two boundaries cannot drift apart silently. The
  // wake family runs before the new session's first record exists, which is why
  // W1/W4/W6/W9/W10 depend on this answer.
  rebindWithWakeEnterLanded(harness);
  assert.equal(fs.existsSync(wakeTranscriptPath(harness)), false,
    'setup: the post-clear session genuinely has no transcript yet');

  settleChildOutput(harness);
  harness.drive();
  assert.equal(wakeEventCount(harness, 'wake-enter-retry'), 1,
    'the wake retry still proceeds: here ENOENT really does mean "nothing submitted yet"');
  assert.deepEqual(
    harness.events('automatic-write-held').filter((e) => e.detail?.detail?.at === 'wake-enter-retry'),
    [], 'and nothing was held at that boundary',
  );
});

dialogCase('D44 the refusal survives a RESTART -- it is per-boundary, not per-binding', (harness) => {
  // THE HOLE IN THE TEMPTING ALTERNATIVE. "Permit ENOENT until the binding has
  // seen its first record" is boundary-agnostic and fails here: a relaunched
  // process has a fresh watch that has seen no records, so a capsule boundary
  // immediately post-restart would read ENOENT as ready again -- which is the
  // mis-resolution case this is meant to catch. Strictness has to come from the
  // BOUNDARY, which survives the restart, not from accumulated observation.
  harness.relaunch();
  assert.equal(harness.runner.toolCallWatch, null, 'setup: a fresh reader, no records seen');
  misresolveReaderPath(harness);
  // Drive to the stage the request gate actually fires at, or this vector
  // proves nothing: a fresh core's first tick is only `pressure`.
  for (let i = 0; i < 6 && !['checkpoint-requested', 'checkpoint-confirmed']
    .includes(harness.core.state.state); i += 1) harness.drive();
  assert.ok(
    ['checkpoint-requested', 'checkpoint-confirmed'].includes(harness.core.state.state),
    `setup: the restored cycle must reach the request stage, got ${harness.core.state.state}`,
  );
  assert.equal(harness.runner.input.snapshot().knownEmpty, true,
    'setup: and the composer is clean, so the only thing that can refuse is readiness');
  assert.equal(capsuleTextWriteCount(harness), 0,
    'FIRST RED: a fresh binding is not a licence to write blind');
  assert.equal(harness.runner.lastReason?.detail?.readiness?.reason, 'tool-call-transcript-absent');
  assert.deepEqual(heldAt(harness), ['capsule-request']);
});

// ─── #104 I: THE BOUNDED PRE-PERMISSION INTERLOCK ───────────────────────────
//
// WHAT THE D SERIES COULD NOT COVER. Every D vector reads the TRANSCRIPT, and
// #110 shipped on the assumption that a tool_use record becomes readable before
// its dialog can accept a keystroke. A host run disproved it: on binary 2.1.310
// (2026-10-24T21:07Z, session 529aa897) the record occupied bytes 286521-288638
// while the file was 283263 bytes at all three samples taken WHILE a real
// permission dialog was on screen. Not partially written -- not flushed at all.
// The 163,968-byte flush carrying both the call and its answer arrived only
// after the cancellation: creation to readability >= 2.44 s. 1 run in 4.
//
// So the I series exercises the case the D series cannot construct and the #110
// reader cannot see: the dialog exists and the transcript says nothing. The
// evidence comes instead from a PreToolUse hook, which the host runs
// synchronously BEFORE the permission check, and from the gate both sides take.
//
// THE PAYLOAD SHAPE IS MEASURED, NOT GUESSED (2026-10-25, binary 2.1.310,
// authenticated disposable profile, project-level .claude/settings.json):
//
//   PreToolUse   session_id transcript_path cwd prompt_id permission_mode
//                effort hook_event_name tool_name tool_input TOOL_USE_ID
//   PostToolUse  ... + tool_response tool_use_id duration_ms
//   Stop         ... + stop_hook_active last_assistant_message
//
// and the one observation that decided the clearing design: the DENIED Read
// produced a PreToolUse and NO PostToolUse at all, while the allowed Glob
// produced both. A cancelled dialog is therefore swept by the turn's Stop, never
// cleared by PostToolUse.

// The dialog is on screen and the transcript is empty: the measured case.
function unflushedPermissionCheck(harness, id = TOOL_ID_READ, tool = 'Read') {
  const before = readUnflushedTranscript(harness);
  const verdict = harness.interlockPermissionCheck(id, tool);
  assert.equal(verdict.action, 'allow', 'setup: the hook recorded the check');
  assert.equal(readUnflushedTranscript(harness), before,
    'setup: NOTHING was written to the transcript -- this is the unflushed shape, '
    + 'so the #110 reader is blind to this call by construction');
  return verdict;
}

dialogCase('I1 THE MEASURED FAILURE: a real dialog with the tool_use bytes UNFLUSHED holds the capsule request', (harness) => {
  atRequestEdge(harness);
  // The #110 reader's own verdict first, so the vector PROVES its premise
  // rather than assuming it: with nothing on disk, it sees no outstanding call.
  harness.runner.toolCallWatch = null;
  const transcriptOnly = harness.runner._checkToolCalls();
  assert.equal(transcriptOnly.outstanding.size, 0,
    'setup: the transcript reader sees no outstanding call, which is exactly what it '
    + 'reported on the host run while a real dialog was up');

  unflushedPermissionCheck(harness);

  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED: #110 answers ready here and the request plus a bare Enter go out into '
    + 'a live permission dialog. The interlock sees the check because the hook ran '
    + 'BEFORE it, not concurrently with it.');
  assert.equal(verdict.code, 'runner-permission-check-pending');
  assert.equal(verdict.detail?.reason, 'interlock-permission-pending');
  assert.deepEqual(verdict.detail?.tool_use_ids, [TOOL_ID_READ]);

  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'and no automatic text went out');
  assert.equal(enterWriteCount(harness), 0, 'and no Enter rode behind it');
  assert.deepEqual(heldAt(harness), ['capsule-request']);
  assert.match(allRunnerLogs(harness), /interlock-permission-pending/, 'durable, not memory-only');
  assert.equal(harness.runner.capsuleRequestCycleId, null, 'nothing spent: the request is still owed');
});

dialogCase('I2 the delayed Enter: a dialog raised between the text and its Enter, with nothing on disk', (harness) => {
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the text went out with no check pending');

  // THE DANGEROUS ORDERING, in the shape #110 cannot see. '/context-capsule' is
  // in the composer; the dialog appears in the 400 ms gap; the transcript still
  // holds nothing.
  unflushedPermissionCheck(harness);

  assert.equal(harness.fireEnter(), true, 'the Enter callback runs');
  assert.equal(enterWriteCount(harness), 0,
    'FIRST RED: #110 presses Enter here, which at that dialog selects "Yes"');
  // DEFERRED, NOT DROPPED -- every protection of the two-phase write is intact.
  assert.equal(harness.runner.enterDeferredAt, 'capsule-request-enter');
  assert.notEqual(harness.runner.enterHandle, null, 'the Enter stays owned');
  assert.equal(harness.runner.composerMayHoldControlText, true, 'stranded-text flag stays up');
  assert.deepEqual(heldAt(harness), ['capsule-request-enter']);

  // SAFE RECOVERY WITHOUT ANOTHER MANUAL ENTER. The operator cancels; a denied
  // call produces no PostToolUse, so the turn's Stop sweeps it, and the Enter
  // the runner was holding lands by itself.
  harness.interlockObserved();
  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWriteCount(harness), 1,
    'the owed Enter lands on its own -- no second manual keystroke');
  assert.equal(harness.runner.composerMayHoldControlText, false, 'and the composer is clean again');
});

dialogCase('I3 the CLEAR: held before anything is spent, and its prepare-to-commit span is exclusive', (harness) => {
  harness.primeAuthorized();
  assert.notEqual(harness.runner.capsuleAck, null, 'setup: this cycle holds its ack');
  unflushedPermissionCheck(harness);

  const refused = harness.attemptAutomaticClear();
  assert.equal(refused.status, 'refused',
    'FIRST RED: #110 reaches submission-prepared here -- token minted, intent persisted, '
    + 'hold taken -- and then writes /clear plus a bare Enter into the dialog');
  assert.equal(refused.code, 'runner-permission-check-pending');
  assert.equal(refused.detail?.readiness?.reason, 'interlock-permission-pending');
  assert.equal(clearTextWrites(harness), 0, 'no text');
  assert.equal(harness.runner.phase, 'idle', 'nothing minted');
  assert.equal(harness.runner.inputHold, false, 'nothing held');
  assert.equal(clearIntentEventCount(harness), 0, 'no intent persisted');
  assert.notEqual(harness.runner.capsuleAck, null, 'the ack is NOT spent by the refusal');
  assert.equal(harness.runner.interlockGate, null, 'and the gate is not leaked');

  // THE SPAN. #110 residual (3) was the one scheduler turn between the gate in
  // _prepareSubmission and the text write in commitClearSubmission, left open
  // because the only refusal available at commit is the terminal
  // _abortPrepared. The gate is HELD across that turn instead, so a hook
  // arriving inside it cannot record a check -- there is nothing to re-test.
  harness.interlockObserved();
  const prepared = harness.attemptAutomaticClear();
  assert.equal(prepared.status, 'submission-prepared', 'liveness: the held clear proceeds');
  assert.notEqual(harness.runner.interlockGate, null, 'the gate is held across the commit turn');
  const insideSpan = harness.interlockPermissionCheck('toolu_IN_THE_GAP');
  assert.equal(insideSpan.action, 'deny',
    'residual (3) closed: a permission check cannot even START inside the span');
  assert.equal(insideSpan.code, 'interlock-gate-busy');

  harness.flushControl();
  assert.equal(clearTextWrites(harness), 1, 'and the clear text goes out');
  assert.equal(harness.runner.interlockGate, null, 'the span ends at the text write');
});

// ─── MISSING, STALE OR FAILED EVIDENCE IS NEVER AN ALL-CLEAR ────────────────
// THE SINGLE MOST IMPORTANT PROPERTY of this whole unit. Each case below is a
// different way for "the interlock is not there" to look identical to "no tool
// call is pending", and the second reading is a worse, SILENT fail-open than
// the gap being closed. Each gets its own name so the log says which.
const INTERLOCK_ABSENCE_CASES = [
  ['interlock-hook-not-wired', (h, dir) => {
    writeJson(h.fixture.settingsPath, { hooks: {} });
    h.runner.interlockWiring = null;
  }],
  ['interlock-state-missing', (h, dir) => fs.rmSync(path.join(dir, 'state.json'), { force: true })],
  ['interlock-state-unreadable', (h, dir) => fs.writeFileSync(path.join(dir, 'state.json'), '{not json')],
  ['interlock-state-stale', (h, dir) => writeInterlockState({
    dir,
    state: { ...h.interlockState(), nonce: 'a-nonce-from-some-other-binding' },
  })],
  ['interlock-hook-not-observed', (h, dir) => writeInterlockState({
    dir,
    state: { ...h.interlockState(), pre_runs: 0, post_runs: 0, stop_runs: 0 },
  })],
  // The proof file removed from under a LIVE binding -- a cleaned state
  // directory, a disk wipe, an operator tidying. _ensureInterlockProof returns
  // early while the bound session id still matches, so nothing rewrites it and
  // the evidence read is the one that speaks.
  ['interlock-proof-missing', (h, dir) => fs.rmSync(path.join(dir, 'proof.json'), { force: true })],
  ['interlock-hook-changed', (h) => { h.runner.interlockHookSha256 = 'f'.repeat(64); }],
];

for (const [expected, breakIt] of INTERLOCK_ABSENCE_CASES) {
  dialogCase(`I4 MISSING EVIDENCE (${expected}) is a NAMED hold, never an all-clear`, (harness) => {
    atRequestEdge(harness);
    assert.equal(readinessOf(harness).ready, true, 'setup: a proven interlock is ready');
    breakIt(harness, harness.interlockDir());

    const verdict = readinessOf(harness);
    assert.equal(verdict.ready, false,
      `FIRST RED: with ${expected} the pre-fix runner answers ready -- the absence of a `
      + 'marker reads as "no tool call", which is the fail-open this leg exists to stop');
    assert.equal(verdict.code, 'runner-interlock-not-ready', 'top-level code');
    assert.equal(verdict.detail?.reason, expected, 'named reason');
    harness.drive();
    assert.equal(capsuleTextWriteCount(harness), 0, 'and nothing is written');
    assert.equal(enterWriteCount(harness), 0, 'and no Enter rode behind it');
    assert.match(allRunnerLogs(harness), new RegExp(expected), 'durable, not memory-only');
  });
}

dialogCase('I4b A SESSION ID THE INTERLOCK CANNOT NAME A DIRECTORY FOR is a named hold', (harness) => {
  // Driven through _interlockReadiness directly, because a session id that
  // breaks the interlock's path ALSO breaks the transcript's -- and that
  // refusal (tool-call-transcript-absent) would arrive first and mask this leg.
  // Both are holds, so there is no fail-open either way; this vector exists so
  // the interlock's OWN branch has coverage rather than being shadowed.
  atRequestEdge(harness);
  assert.equal(harness.runner._interlockReadiness('capsule-request').ready, true, 'setup: proven');
  harness.runner.sessionId = '../escape/../..';
  const verdict = harness.runner._interlockReadiness('capsule-request');
  assert.equal(verdict.ready, false, 'a path it cannot name is not evidence of an empty pending map');
  assert.equal(verdict.code, 'runner-interlock-not-ready');
  assert.equal(verdict.detail?.reason, 'interlock-dir-unresolved');
  // And the composed verdict still holds the write, by whichever name arrives
  // first -- the property that matters is that nothing is written.
  assert.equal(readinessOf(harness).ready, false);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);
});

dialogCase('I4c THE OFF SWITCH CANNOT OPEN THE GATE', (harness) => {
  // AIGENT_INTERLOCK=off silences the hook. If the runner's side treated that
  // as "nothing to check" the switch would be a one-line fail-open -- which is
  // how six of this issue's seven fail-opens looked. It is a refusal instead:
  // turning the interlock off stops automatic writes, it does not permit them.
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: proven and ready');
  harness.fixture.env.AIGENT_INTERLOCK = 'off';
  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false, 'FIRST RED: an off switch that permits writes is a fail-open');
  assert.equal(verdict.detail?.reason, 'interlock-disabled');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'and nothing is written');
  delete harness.fixture.env.AIGENT_INTERLOCK;
  assert.equal(readinessOf(harness).ready, true, 'and it is a switch, not a latch');
});

dialogCase('I5 a hook that STOPS RUNNING is detected positively, by the tool calls it did not see', (harness) => {
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: proven and ready');

  // STALENESS WITHOUT A TIMEOUT. Idle time proves nothing -- a quiet session
  // makes no tool calls -- so an idle-staleness rule would hold automation on a
  // healthy seat and would be a liveness bug dressed as a safety check. What IS
  // proof is a tool_use the reader has parsed that the hook never ran for: on a
  // wired seat, every tool call runs PreToolUse first.
  //
  // `hook: false` is exactly that seat: the record is written, the hook does
  // not run.
  openToolCall(harness, TOOL_ID_READ, { hook: false });
  settleToolCall(harness, TOOL_ID_READ, { hook: false });
  anchorTurn(harness);

  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED: the transcript says the call is answered, so #110 is ready -- but the '
    + 'hook that is supposed to be guarding the dialog demonstrably did not run for it');
  assert.equal(verdict.detail?.reason, 'interlock-hook-missed-tool-calls');
  assert.equal(verdict.detail?.tool_uses_since, 1);
  assert.equal(verdict.detail?.hook_runs_since, 0);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // LIVENESS, AND THE WAY THIS USED TO BE WRONG. The original version advanced
  // `pre_runs` with a bare interlockPermissionCheck() -- which writes no
  // transcript record -- so `toolUsesObserved` stayed put and the "recovery" it
  // claimed was a shape no real seat produces. On a real seat the two counters
  // always move together, because a tool call writes a record AND runs the
  // hook. openToolCall/settleToolCall do both.
  //
  // The recovery rule itself is leg 4's forgiveness, and I18 is where it is
  // exercised in full. Here the point is narrower: the refusal is about the
  // counters and is not sticky.
  const recoveryId = 'toolu_BOTH_COUNTERS_MOVE';
  openToolCall(harness, recoveryId);
  settleToolCall(harness, recoveryId);
  anchorTurn(harness);
  assert.equal(readinessOf(harness).ready, true, 'the refusal is about the counters, not permanent');
});

dialogCase('I6 REBIND: the new session inherits no evidence, and says so by name', (harness) => {
  // The interlock's proof, state and gate all live under the SESSION id, and a
  // rebind always rotates it (_rebindAfterClear refuses a receipt that does
  // not). So evidence cannot be inherited -- which is the whole restart story
  // on this side, and the reason the nonce exists.
  const firstDir = harness.interlockDir();
  assert.ok(fs.existsSync(path.join(firstDir, 'proof.json')), 'setup: the first binding is proven');
  const firstNonce = harness.interlockState().nonce;
  const firstBindingNonce = harness.runner.interlockNonce;

  harness.options.interlockAutoPrime = false;
  rebindWithWakeEnterLanded(harness);
  assert.equal(harness.runner.sessionId, NEXT_SESSION_ID, 'setup: the session rotated');

  const wakeTranscript = wakeTranscriptPath(harness);
  fs.mkdirSync(path.dirname(wakeTranscript), { recursive: true });
  fs.writeFileSync(wakeTranscript, '{"type":"summary"}\n');
  appendOperatorPromptRecord(harness, 'the operator own prompt', { transcriptPath: wakeTranscript });
  settleChildOutput(harness);
  harness.drive();

  assert.equal(wakeEnterWrites(harness), 1,
    'FIRST RED: the retry presses Enter on an interlock this session has never proven');
  assert.equal(harness.runner.wakeSubmission?.retries, 0, 'and the owed retry is not spent');
  // The rebind voided the binding; the next tick wrote a FRESH proof for the new
  // session. Either way it is not the old binding's nonce, which is what makes
  // the previous session's state file read as stale rather than as evidence.
  assert.notEqual(harness.runner.interlockNonce, firstBindingNonce,
    'the binding was voided at the rebind and re-established for the new session');
  const held = harness.events('automatic-write-held').at(-1);
  assert.equal(held?.detail?.detail?.at, 'wake-enter-retry');
  assert.equal(held?.detail?.code, 'runner-interlock-not-ready');
  assert.ok(
    ['interlock-state-stale', 'interlock-state-missing', 'interlock-hook-not-observed']
      .includes(held?.detail?.detail?.readiness?.reason),
    `named for the missing evidence, got ${held?.detail?.detail?.readiness?.reason}`,
  );
  assert.notEqual(harness.interlockDir(), firstDir, 'a new directory for a new binding');

  // LIVENESS: the new session has its first turn, which is what re-establishes
  // evidence on a real seat -- and the owed retry then happens.
  harness.interlockObserved();
  assert.notEqual(harness.interlockState().nonce, firstNonce, 'a fresh nonce, not the old one');
  settleChildOutput(harness);
  harness.drive();
  assert.equal(wakeEnterWrites(harness), 2, 'the owed retry is delayed, not lost');
});

dialogCase('I7 OPERATOR SOVEREIGNTY: an interlock deferral never withholds the human keystroke', (harness) => {
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the text is in the composer');
  unflushedPermissionCheck(harness);
  assert.equal(harness.fireEnter(), true);
  assert.equal(harness.runner.enterDeferredAt, 'capsule-request-enter', 'setup: the Enter is deferred');

  // #110 SHIPPED A DEFECT OF EXACTLY THIS SHAPE and the interlock must not
  // reintroduce it by another route: the deferral held `enterHandle` non-null,
  // which made handleOperatorData QUEUE the operator's bytes -- including the
  // answer to the dialog the deferral was waiting for -- for up to 60 s. The
  // deferral's only termination condition was the thing it was withholding.
  const before = harness.pty.writes.length;
  harness.operator('3');
  const after = harness.pty.writes.slice(before).map(String);
  assert.ok(after.includes('3'),
    'the operator byte reaches the child IN THE SAME CALL -- no tick, no blackout');
  const killIndex = after.indexOf(COMPOSER_KILL_LINE);
  assert.ok(killIndex >= 0 && killIndex < after.indexOf('3'),
    'and it lands BEHIND a kill-line, so it cannot concatenate onto the stranded '
    + 'automatic text -- "delivered" is not satisfied by concatenation');
  assert.equal(harness.runner.lastReason?.code, 'runner-automatic-enter-operator-takeover',
    'named as a takeover, not left looking like a budget expiry');
  assert.equal(harness.runner.enterDeferredAt, null, 'the Enter is abandoned at once');
  assert.equal(harness.runner.enterHandle, null, 'and the slot is released');

  // THE TWO EXEMPTIONS THE OPERATOR PATH DEPENDS ON, tested rather than
  // asserted. _writeOperator and COMPOSER_KILL_LINE are ungated, and both just
  // travelled with a permission check PENDING. Gating either would make the
  // human wait behind the interlock, which is the defect above.
  assert.deepEqual(Object.keys(harness.interlockState().pending), [TOOL_ID_READ],
    'the check was pending for the whole exchange');
});

dialogCase('I8 THE WAKE EXEMPTION: the text and its first Enter fire where no check can exist', (harness) => {
  // #110 exempted these STRUCTURALLY -- they run inside _rebindAfterClear, onto
  // a context the host has just torn down and rebuilt, so no tool_use can
  // exist. The interlock lets that claim be TESTED rather than asserted: the
  // pending map is the host's own record of whether a permission check is in
  // flight, and at this moment the directory does not even exist.
  harness.options.interlockAutoPrime = false;
  const before = harness.pty.writes.length;
  rebindWithWakeEnterLanded(harness);
  const written = harness.pty.writes.slice(before).map(String);
  assert.deepEqual(written, [WAKE_MESSAGE, CONTROL_ENTER],
    'the wake text and its first Enter go out, unchanged by the interlock');
  assert.equal(fs.existsSync(path.join(harness.interlockDir(), 'state.json')), false,
    'and there is provably no permission check: the new binding has no state at all');
  assert.equal(fs.existsSync(wakeTranscriptPath(harness)), false,
    'nor any transcript -- which is why the transcript reader could not gate these two either');
});

dialogCase('I8b AND THE WAKE EXEMPTION IS NOT A HOLE: the clear it rides on is itself interlocked', (harness) => {
  // The only route to the wake is a clear whose Enter went out. A check pending
  // at that Enter means no submitted clear, which means no rebind, which means
  // no wake. So the exemption cannot be reached with a dialog on screen.
  harness.primeAuthorized();
  const prepared = harness.attemptAutomaticClear();
  assert.equal(prepared.status, 'submission-prepared');
  harness.flushControl();
  assert.equal(clearTextWrites(harness), 1, 'setup: /clear is in the composer');
  unflushedPermissionCheck(harness);
  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWriteCount(harness), 0,
    'the clear is never SUBMITTED while a check is pending, so the rebind the wake '
    + 'rides on cannot happen with a dialog up');
  assert.equal(harness.runner.enterDeferredAt, 'control-enter');
  assert.equal(harness.runner.composerMayHoldControlText, true);

  // LIVENESS: the dialog is cancelled, the turn ends, the clear submits itself.
  harness.interlockObserved();
  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWriteCount(harness), 1, 'recovered with no manual Enter');
});

dialogCase('I9 PENDING NEVER EXPIRES INTO READY: an old marker is renamed, not released', (harness) => {
  atRequestEdge(harness);
  unflushedPermissionCheck(harness);
  const fresh = readinessOf(harness);
  assert.equal(fresh.ready, false,
    'FIRST RED: a recorded permission check with nothing on disk is invisible to #110');
  assert.equal(fresh.detail?.reason, 'interlock-permission-pending');

  // A HUMAN CAN READ A DIALOG FOR MINUTES, and age cannot tell that from a
  // marker nothing ever cleared. So age changes only the NAME -- which is what
  // lets an operator tell the two apart -- and both HOLD. An age-based release
  // would be the fail-open with a timer on it.
  harness.fixture.clock.advance(10 * 60 * 1000);
  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED IF THIS EVER EXPIRES: a stale marker must not become an all-clear');
  assert.equal(verdict.code, 'runner-permission-check-pending');
  assert.equal(verdict.detail?.reason, 'interlock-pending-stale', 'renamed, so the log distinguishes them');
  assert.ok(verdict.detail?.oldest_age_ms >= 10 * 60 * 1000);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // THE BOUND ON AN ORPHAN is the turn's Stop, not a timer.
  harness.interlockObserved();
  assert.equal(readinessOf(harness).ready, true, 'the sweep is what releases it');
});

dialogCase('I10 A CANCELLED TURN PRODUCES NO Stop: the settled id is what releases the marker', (harness) => {
  // MEASURED ON A REAL HOST, and it is why this path exists (binary 2.1.310,
  // 2026-10-25 run 3, session ee986519). The clearing design started as
  // PostToolUse plus the turn's Stop sweep. An ESC-cancelled turn produced NO
  // Stop hook invocation at all: `stop_runs` stayed at 1 from before the dialog,
  // through the cancellation and through the whole of the NEXT turn's tool call,
  // reaching 2 only when that later turn ended. The marker was held for 48 s
  // with no dialog on screen, and an operator who walked away would have held
  // automation indefinitely.
  //
  // So the id does it. A `tool_result` is written whichever way the dialog is
  // answered, the marker is keyed by the host's own tool_use_id, and the #110
  // reader already pairs on it.
  atRequestEdge(harness);
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 1, 'setup: the text is in the composer');
  unflushedPermissionCheck(harness);
  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWriteCount(harness), 0, 'setup: the Enter is held');

  // The operator presses ESC. The host writes the call AND its denial -- the
  // measured 2.1.310 flush carried both together -- and fires NO Stop.
  const stopsBefore = harness.interlockState().stop_runs;
  openToolCall(harness, TOOL_ID_READ, { hook: false });
  settleToolCall(harness, TOOL_ID_READ, { denied: true, hook: false });
  anchorTurn(harness);
  assert.equal(harness.interlockState().stop_runs, stopsBefore,
    'setup: no Stop fired, exactly as measured on the cancelled turn');
  assert.deepEqual(Object.keys(harness.interlockState().pending), [TOOL_ID_READ],
    'setup: the marker is still in the file -- nothing swept it');

  // The hook ran for the call (a real seat always does), so leg 4 is satisfied
  // and the only thing left is the marker.
  harness.interlockPermissionCheck(TOOL_ID_READ);

  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWriteCount(harness), 1,
    'FIRST RED without the settled-id path: the marker survives a turn that never '
    + 'Stopped, so the owed Enter waits for an unrelated later turn to end -- 48 s on '
    + 'the measured run, and for ever if the operator walks away');
  assert.equal(readinessOf(harness).ready, true, 'and readiness is back');

  // AND IT IS STILL BY ID. A different call's result releases nothing.
  const second = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    atRequestEdge(second);
    unflushedPermissionCheck(second, 'toolu_THE_ONE_ON_SCREEN');
    openToolCall(second, 'toolu_SOMETHING_ELSE', { hook: false });
    settleToolCall(second, 'toolu_SOMETHING_ELSE', { hook: false });
    second.interlockPermissionCheck('toolu_SOMETHING_ELSE');
    const verdict = readinessOf(second);
    assert.equal(verdict.ready, false, 'one result settles its own call and no other');
    assert.equal(verdict.code, 'runner-permission-check-pending');
    assert.deepEqual(verdict.detail?.tool_use_ids, ['toolu_THE_ONE_ON_SCREEN']);
  } finally {
    second.cleanup();
  }
});

// ─── #104 I11-I15: THE DELIBERATE MANUAL RECOVERY, FROM THE RUNNER'S SIDE ───
//
// The owner's requirement, in his words: "Document and test the deliberate
// manual-only recovery path, keeping automatic runner writes disabled and
// Claude's permission checks intact. No silent fallback that disables the
// protection."
//
// So every vector here asserts all three, because a vector that only proved
// the wedge clears would be the fail-open version of this feature:
//
//   (a) the operator can proceed            -- the hook stops denying
//   (b) automatic runner writes stay OFF    -- refused BY NAME, at every boundary
//   (c) permission checking stays armed     -- no rule, mode or wiring touched

// Every boundary that can write automatically. `_writeOperator` and the two
// kill-lines are deliberately absent: they are the operator's own bytes and the
// protection that keeps those bytes off stranded text, and both are exempt --
// see "The exemptions, re-examined" in docs/dialog-readiness.md.
const AUTOMATIC_BOUNDARIES = [
  'capsule-request', 'capsule-request-enter', 'clear-submission',
  'control-enter', 'wake-enter-retry',
];

// (b), as a function, so no vector can assert it half-way.
function assertAutomaticWritesStillRefused(harness, expectedReason) {
  for (const where of AUTOMATIC_BOUNDARIES) {
    const verdict = harness.runner._automaticWriteReadiness(where);
    assert.equal(verdict.ready, false, `${where}: automatic writes must stay refused`);
    assert.equal(verdict.code, 'runner-interlock-released', `${where}: by this name`);
    assert.equal(verdict.detail?.reason, expectedReason, `${where}: naming the release`);
    assert.equal(verdict.detail?.at, where, `${where}: and the boundary`);
  }
}

// (c), likewise. Recovery must not weaken permission prompting by ANY route:
// not a rule, not a mode, not by unwiring the hook, not by the kill switch.
function assertPermissionCheckingStillArmed(harness, settingsBefore) {
  const settingsNow = fs.readFileSync(harness.fixture.settingsPath, 'utf8');
  assert.equal(settingsNow, settingsBefore,
    'the settings file is byte-identical: nothing was added to permissions.allow, '
    + 'no defaultMode was changed, and the hook was not unwired');
  // The wiring leg re-evaluated from scratch, so a cached pass cannot stand in
  // for the file still being right.
  harness.runner.interlockWiring = null;
  assert.equal(harness.runner._interlockWiringProblem(), null,
    'the hook is still wired at PreToolUse, PostToolUse and Stop');
  assert.equal(harness.fixture.env.AIGENT_INTERLOCK, undefined,
    'and recovery did not reach for the off switch');
  // The hook expresses NO permission opinion: it allows the call to reach the
  // host's own check rather than deciding it. A hook that returned an approval
  // here would be the thing this whole issue is about.
  const verdict = harness.interlockPermissionCheck('toolu_AFTER_RECOVERY');
  assert.notEqual(verdict.action, 'deny', '(a) the operator can proceed');
  assert.notEqual(verdict.action, 'approve', 'and the hook never approves anything');
  return verdict;
}

dialogCase('I11 THE RELEASE: the operator proceeds, automation stays off by name, prompting stays armed', (harness) => {
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: a healthy, proven interlock');
  const settingsBefore = fs.readFileSync(harness.fixture.settingsPath, 'utf8');

  // THE WEDGE WITH NO SELF-RECOVERY (G18's T7): a directory at the gate path.
  // Nothing in the shipped code clears this -- not age, not pid liveness, not a
  // nonce change -- so without a deliberate path it is a permanent tool outage.
  fs.mkdirSync(path.join(harness.interlockDir(), GATE_NAME));
  const wedged = harness.interlockPermissionCheck('toolu_WEDGED');
  assert.equal(wedged.action, 'deny', 'setup: tool calls are being denied');
  assert.equal(wedged.code, 'interlock-gate-path-unusable');

  // THE DELIBERATE ACT. Written by a human, through the shipped subcommand, so
  // the vector cannot drift from what an operator would actually do.
  assert.equal(harness.interlockRelease('the gate path is a directory after a disk event'), 0);

  // (a)
  const after = harness.interlockPermissionCheck('toolu_AFTER_RELEASE');
  assert.equal(after.action, 'allow',
    'FIRST RED: with no release path this stays denied for ever -- a permanent tool '
    + 'outage, which is not a trade anyone agreed to');
  assert.equal(after.code, 'interlock-released-manually');

  // (b) -- and this is the half that makes the release a trade and not a hole.
  assertAutomaticWritesStillRefused(harness, 'interlock-released-manually');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'no automatic text');
  assert.equal(enterWriteCount(harness), 0, 'no automatic Enter');
  // (c)
  assertPermissionCheckingStillArmed(harness, settingsBefore);

  // NOT SILENT. Named on both sides and durable, because "the protection is off
  // now" is precisely the fact that must never be discoverable only by reading
  // the source.
  assert.match(allRunnerLogs(harness), /interlock-released-manually/,
    'the runner says so, durably');
  assert.match(allRunnerLogs(harness), /the gate path is a directory after a disk event/,
    'and records the operator own reason, so the log says WHY automation was given up');
});

dialogCase('I11b THE RELEASE at the CLEAR boundary: refused, with nothing spent', (harness) => {
  // The clear is the boundary with the most to lose -- it mints a token,
  // persists an intent, takes the input hold and spends the cycle's ack -- so
  // the release has to refuse it BEFORE any of that, exactly as the dialog
  // guards do. Its own vector because it needs the authorized lifecycle, which
  // the capsule-request drive in I11 has already moved past.
  harness.primeAuthorized();
  assert.notEqual(harness.runner.capsuleAck, null, 'setup: this cycle holds its ack');
  assert.equal(harness.interlockRelease('released while a clear was authorized'), 0);

  const clear = harness.attemptAutomaticClear();
  assert.equal(clear.status, 'refused',
    'FIRST RED: without the release latch the clear proceeds and /clear plus its Enter '
    + 'go out on a seat the operator deliberately took automation away from');
  assert.equal(clear.code, 'runner-interlock-released');
  assert.equal(clear.detail?.readiness?.reason, 'interlock-released-manually');
  assert.equal(clearTextWrites(harness), 0, 'no text');
  assert.equal(harness.runner.phase, 'idle', 'nothing minted');
  assert.equal(harness.runner.inputHold, false, 'nothing held');
  assert.equal(clearIntentEventCount(harness), 0, 'no intent persisted');
  assert.notEqual(harness.runner.capsuleAck, null, 'and the ack is NOT spent');
  assert.equal(harness.runner.interlockGate, null, 'and no gate is leaked');
});

dialogCase('I12 THE LATCH: deleting the release does not re-enable automation; only a new binding does', (harness) => {
  atRequestEdge(harness);
  const settingsBefore = fs.readFileSync(harness.fixture.settingsPath, 'utf8');
  assert.equal(harness.interlockRelease('operator gave up on automation for this session'), 0);
  assert.equal(readinessOf(harness).code, 'runner-interlock-released', 'setup: released');

  // A TOGGLE WOULD BE THE FAIL-OPEN. If removing the file re-armed automation,
  // then a seat could be released, left running, and silently re-enter the
  // state the release was the escape from -- with the interlock now unobserved
  // for this binding and the operator no longer watching.
  fs.rmSync(path.join(harness.interlockDir(), RELEASE_NAME), { force: true });
  assert.equal(fs.existsSync(path.join(harness.interlockDir(), RELEASE_NAME)), false,
    'setup: the file is gone');
  assertAutomaticWritesStillRefused(harness, 'interlock-released-manually');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'FIRST RED without the latch: the write goes out again');
  assertPermissionCheckingStillArmed(harness, settingsBefore);

  // AND IT IS NOT A PERMANENT KILL EITHER. A new binding starts over, and a
  // rebind is itself deliberate: it only happens behind an interlocked clear,
  // and it lands on a new session id, so the old binding's release file is not
  // even on the new path.
  harness.options.interlockAutoPrime = false;
  rebindWithWakeEnterLanded(harness);
  assert.equal(harness.runner.interlockReleased, null, 'the latch clears with the binding');
  assert.notEqual(harness.interlockDir(), null);
  assert.equal(fs.existsSync(path.join(harness.interlockDir(), RELEASE_NAME)), false,
    'and the new binding has no release of its own');
  // LIVENESS, asserted on the property rather than on the wake machinery: once
  // the host has invoked the hook for the NEW nonce, the new binding is ready
  // to write automatically again. (`wake-enter-retry` is the boundary entitled
  // to read a not-yet-existing transcript as "no records", which is what a
  // freshly rebound session has -- see ABSENT_TRANSCRIPT_READY_AT.)
  // One tick first, because the proof for the NEW session is written by the
  // runner's own tick-path seeding -- the hook is deliberately inert until it
  // exists, so an observation before that would stamp nothing.
  harness.drive();
  harness.interlockObserved();
  const reborn = harness.runner._automaticWriteReadiness('wake-enter-retry');
  assert.equal(reborn.ready, true,
    `liveness: a release is scoped to its binding, not a permanent kill `
    + `(got ${reborn.code}/${reborn.detail?.reason})`);
  assert.equal(harness.runner.interlockReleased, null);
});

dialogCase('I13 A MALFORMED RELEASE IS NOT A RELEASE: it keeps refusing, and says why', (harness) => {
  atRequestEdge(harness);
  // The operator meant to recover and got the file wrong. Silence here would be
  // the worst of both worlds: still wedged, and believing otherwise.
  fs.writeFileSync(path.join(harness.interlockDir(), RELEASE_NAME), '{"release":"manual"}');
  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false, 'a near-miss releases nothing');
  assert.equal(verdict.code, 'runner-interlock-not-ready');
  assert.equal(verdict.detail?.reason, 'interlock-release-foreign-session',
    'and the runner names which way it was wrong');
  assert.equal(harness.runner.interlockReleased, null, 'the latch is NOT set by a near-miss');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0, 'nothing is written while it is sorted out');
  assert.match(allRunnerLogs(harness), /interlock-release-foreign-session/, 'durably named');

  // Corrected, it takes.
  assert.equal(harness.interlockRelease('corrected after a malformed first attempt'), 0);
  assert.equal(readinessOf(harness).code, 'runner-interlock-released');
});

dialogCase('I14 RE-ARM: a wiped interlock directory restores the protection instead of losing it silently', (harness) => {
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: proven');
  const firstNonce = harness.runner.interlockNonce;

  // The state directory is cleaned out from under a live binding -- a wiped
  // temp tree, an operator tidying. THE OLD BEHAVIOUR WAS THE WORST SHAPE OF
  // ALL: the runner held automatic writes for ever (safe), while the HOOK went
  // inert for want of a proof, so the protection was gone and nothing would
  // ever bring it back. Safe, silent, and permanent.
  fs.rmSync(harness.interlockDir(), { recursive: true, force: true });
  const gone = readinessOf(harness);
  assert.equal(gone.ready, false, 'the runner still refuses, which was never the problem');
  assert.equal(gone.detail?.reason, 'interlock-proof-missing');
  assert.equal(harness.runner.interlockNonce, null,
    'FIRST RED: pre-fix the binding is kept, so no fresh proof is ever written and the '
    + 'hook stays inert -- the protection is lost for the rest of the session');
  assert.match(allRunnerLogs(harness), /interlock-rearming/, 'and it says it is re-arming');

  // The next call writes a fresh proof with a FRESH nonce, so the hook is armed
  // again. This is the one automatic transition in the unit, and it goes in the
  // direction of MORE protection, never less.
  const rearmed = readinessOf(harness);
  assert.notEqual(harness.runner.interlockNonce, null, 'bound again');
  assert.notEqual(harness.runner.interlockNonce, firstNonce, 'under a new nonce');
  assert.equal(rearmed.ready, false, 'and automatic writes stay held until the host observes it');
  // `-state-missing` rather than `-not-observed`, and they are the same fact at
  // two different points in the evidence order: the fresh binding has no state
  // file at all until the host runs the hook for it. Either name means "the
  // host has not been seen to invoke this hook for this nonce".
  assert.equal(rearmed.detail?.reason, 'interlock-state-missing');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // The host runs the hook once and the seat is whole again.
  harness.interlockObserved();
  assert.equal(readinessOf(harness).ready, true, 'liveness: re-arming is a repair, not a wedge');
});

dialogCase('I15 THE RUNNER IS GONE: a dead runner pid stops the hook denying, and writes nothing', (harness) => {
  atRequestEdge(harness);
  // The recovery that needs NO WRITE, which is what makes it the answer when
  // the thing being recovered from IS a failed write. Reached here by making
  // the proof name a pid that is not alive -- which is what stopping the
  // managed runner leaves behind.
  const dir = harness.interlockDir();
  fs.mkdirSync(path.join(dir, GATE_NAME));                    // the unclearable wedge
  const proof = JSON.parse(fs.readFileSync(path.join(dir, PROOF_NAME), 'utf8'));

  const denied = harness.interlockHook('PreToolUse', { tool_use_id: 'toolu_W', tool_name: 'Read' },
    { processLike: { kill: () => true } });
  assert.equal(denied.action, 'deny', 'setup: with the runner alive the wedge denies');
  // AND IT WROTE NOTHING, which is the corrected rule. A denial IS an
  // invocation and leg 4 would like the count -- but this path runs because
  // the gate is held by somebody else, and the only way to record it would be
  // an ungated read-modify-write of the whole state file, which destroyed a
  // live dialog's marker when it was tried. Leg 4's forgiveness absorbs the
  // dropped increment instead. STATE.JSON IS WRITTEN ONLY UNDER THE GATE.
  assert.notEqual(harness.interlockState().last_event, 'PreToolUse:denied',
    'a gate-busy denial does not write to a state file it does not own');
  const stateBefore = fs.readFileSync(path.join(dir, STATE_NAME), 'utf8');

  const gone = harness.interlockHook('PreToolUse', { tool_use_id: 'toolu_W', tool_name: 'Read' }, {
    processLike: {
      kill: (pid) => {
        if (pid === proof.runner_pid) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
        return true;
      },
    },
  });
  assert.equal(gone.action, 'inert',
    'FIRST RED: pre-fix a dead runner still denies, so stopping the runner was not a '
    + 'recovery and the only unclearable wedges had none at all');
  assert.equal(gone.code, 'interlock-runner-gone');
  assert.equal(fs.readFileSync(path.join(dir, STATE_NAME), 'utf8'), stateBefore,
    'and it records nothing: there is no automatic writer left to protect against');
});

dialogCase('I16 F1: a gate STOLEN from a live held span is detected, and the clear aborts rather than writing', (harness) => {
  // THE REVIEWER'S COMPOSED FAIL-OPEN, end to end, with no injected errors and
  // only a forward clock step. Three defects composed:
  //
  //   1. `stealable` takes a gate from a holder whose pid is ALIVE and whose
  //      nonce MATCHES once it looks older than GATE_STALE_MS. The comment
  //      claiming a legitimate holder cannot reach that age was false: the
  //      clear's held span covers a setImmediate, a kill-switch read and a
  //      transport write, and a forward wall-clock step reaches it regardless.
  //   2. `_interlockedWriteUnderHeldGate` skipped the pending re-read on the
  //      premise that nothing could become pending while we held the gate.
  //   3. `commitClearSubmission` tested only the IN-MEMORY handle.
  //
  // Reported result: ENTER_WENT_OUT_WITH_A_LIVE_PERMISSION_CHECK: true.
  //
  // THE FIX IS DETECTION, NOT PREVENTION, and that is deliberate: the steal is
  // the gate's only self-recovery from a dead holder, and no age bound can
  // survive a clock step, so the honest move is to stop trusting the in-memory
  // handle and ask the disk.
  harness.primeAuthorized();
  assert.notEqual(harness.runner.capsuleAck, null, 'setup: this cycle holds its ack');

  const prepared = harness.attemptAutomaticClear();
  assert.equal(prepared.status, 'submission-prepared', 'setup: the span is open');
  assert.notEqual(harness.runner.interlockGate, null, 'setup: and the runner holds the gate');

  // The clock steps forward past GATE_STALE_MS, so the runner's own live,
  // legitimately-held gate now looks abandoned to any other party.
  harness.fixture.clock.advance(GATE_STALE_MS + 1000);

  // A real permission check arrives. The hook steals the stale-looking gate and
  // records its marker -- exactly what a dialog going up looks like.
  const stolen = harness.interlockPermissionCheck('toolu_A_LIVE_PERMISSION_CHECK');
  assert.equal(stolen.action, 'allow', 'setup: the hook took the gate and marked');
  assert.deepEqual(Object.keys(harness.interlockState().pending), ['toolu_A_LIVE_PERMISSION_CHECK'],
    'setup: a permission check is in flight');

  // THE COMMIT. Pre-fix it checked `interlockGate !== null`, which is still
  // true -- the runner has no idea it was robbed -- so '/clear' went out and
  // its Enter followed into the dialog.
  harness.flushControl();
  assert.equal(clearTextWrites(harness), 0,
    'FIRST RED: ENTER_WENT_OUT_WITH_A_LIVE_PERMISSION_CHECK. The premise that closed '
    + 'residual (3) was "nothing can become pending while I hold the gate" -- so when '
    + 'the gate is gone, the premise is gone, and writing on it is the defect');
  assert.equal(enterWriteCount(harness), 0, 'and no Enter rode behind it');
  assert.equal(harness.runner.phase, 'abandoned',
    'the span aborts, because a clear it cannot prove exclusion for is not a clear it '
    + 'may make');
  assert.equal(harness.runner.lastReason?.code, 'runner-interlock-gate-lost');
  assert.equal(harness.runner.interlockGate, null, 'and the stale handle is dropped');
  assert.match(allRunnerLogs(harness), /interlock-gate-lost/, 'named, durably');
});

dialogCase('I16b F1: the one-shot write path re-reads pending INSIDE the gate it actually holds', (harness) => {
  // The other half of F1: the capsule request's held span. Same shape, cheaper
  // to reach -- the marker lands while the runner believes it holds the gate,
  // and the write must not happen.
  atRequestEdge(harness);
  const realWrite = harness.pty.write.bind(harness.pty);
  let robbed = false;
  harness.pty.write = (data) => {
    // Rob the gate at the last possible moment: the runner is inside its held
    // span, between the pending check and the write.
    if (!robbed && String(data).includes(CAPSULE_REQUEST_TEXT)) {
      robbed = true;
      harness.fixture.clock.advance(GATE_STALE_MS + 1000);
      harness.interlockPermissionCheck('toolu_ROBBED');
    }
    return realWrite(data);
  };
  harness.drive();
  harness.pty.write = realWrite;

  // The text itself is the residual the design already owns (D20b): the hook
  // had not reached the gate when the runner held it. What must NOT happen is
  // the Enter going out afterwards on a gate the runner no longer holds.
  assert.equal(harness.fireEnter(), true);
  assert.equal(enterWriteCount(harness), 0, 'the Enter is held');
  assert.equal(harness.runner.enterDeferredAt, 'capsule-request-enter', 'and owned, not dropped');
  const reason = harness.runner.lastReason?.detail?.readiness?.reason
    ?? harness.runner.lastReason?.code;
  assert.ok(
    String(reason).includes('interlock'),
    `held for an interlock reason, got ${JSON.stringify(reason)}`,
  );
});

dialogCase('I17 F6: a session that HAS used tools requires PreToolUse evidence, not just a Stop', (harness) => {
  // `pre + post + stop >= 1` let `stop_runs` alone satisfy "the host invokes
  // the hook" -- but Stop proves only that the FILE runs, and PreToolUse is the
  // only invocation that protects anything. Combined with mid-session unwiring,
  // legs 1/2/3 would all pass on a Stop from before the unwiring, while leg 4's
  // detector reads transcript bytes whose flush lag was measured at >= 2.44 s
  // with the record absent for an entire dialog -- so for the first dialog
  // after a PreToolUse outage BOTH mechanisms would be blind at once, which is
  // the one combination the two-mechanism design exists to exclude.
  atRequestEdge(harness);
  const dir = harness.interlockDir();

  // A seat whose only evidence is a Stop, and which HAS made a tool call.
  writeInterlockState({
    dir,
    state: { ...harness.interlockState(), pre_runs: 0, post_runs: 0, stop_runs: 1 },
  });
  openToolCall(harness, TOOL_ID_READ, { hook: false });
  settleToolCall(harness, TOOL_ID_READ, { hook: false });
  anchorTurn(harness);

  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED: a Stop from before an unwiring satisfied the observed leg, so the '
    + 'interlock read as live while nothing was protecting the dialog');
  assert.equal(verdict.detail?.reason, 'interlock-hook-not-observed');
  assert.equal(verdict.detail?.pre_runs, 0, 'and names the counter that is missing');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // THE EXCEPTION IS REAL AND NARROW. A session that has provably made NO tool
  // calls cannot produce a PreToolUse, and a Stop is the only evidence
  // obtainable -- a seat that reached pressure on one pasted document must not
  // be held for ever. `toolUsesObserved === 0` is the reader's own count, not
  // an assumption.
  const quiet = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    atRequestEdge(quiet);
    writeInterlockState({
      dir: quiet.interlockDir(),
      state: { ...quiet.interlockState(), pre_runs: 0, post_runs: 0, stop_runs: 1 },
    });
    quiet.runner.toolUsesObserved = 0;
    quiet.runner.interlockCheckpoint = null;
    assert.equal(readinessOf(quiet).ready, true,
      'a toolless session is live on a Stop alone -- otherwise this leg is a liveness bug');
  } finally {
    quiet.cleanup();
  }
});

dialogCase('I18 F4: a dropped increment is forgiven on POSITIVE evidence, never on a timer', (harness) => {
  // Leg 4 compared cumulative deltas and re-anchored only on a PASS, so ONE
  // missed `pre_runs` increment was never forgiven: five consecutive healthy
  // calls still refused, the capsule request and the clear stayed refused for
  // the rest of the session, and the seat never auto-cleared at pressure again
  // -- a permanent automation outage recoverable only by restart. The owner
  // accepted fail-closed in principle and explicitly NOT a permanent outage.
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: healthy');

  // A call the hook did not see (a host timeout on the hook, or a crash
  // mid-invocation -- the causes that survive counting denials).
  openToolCall(harness, TOOL_ID_READ, { hook: false });
  settleToolCall(harness, TOOL_ID_READ, { hook: false });
  anchorTurn(harness);
  const deficit = readinessOf(harness);
  assert.equal(deficit.ready, false, 'the deficit refuses, which is correct');
  assert.equal(deficit.detail?.reason, 'interlock-hook-missed-tool-calls');

  // FIVE HEALTHY CALLS AFTERWARDS. Both counters move together, which is what
  // they do on a real seat -- and the reason the old I5/G12 vectors did not
  // exercise this: they moved only one.
  for (let i = 0; i < 5; i += 1) {
    const id = `toolu_HEALTHY_${i}`;
    openToolCall(harness, id);
    settleToolCall(harness, id);
  }
  anchorTurn(harness);

  const recovered = readinessOf(harness);
  assert.equal(recovered.ready, true,
    'FIRST RED: pre-fix this still refuses -- the deficit is cumulative and never '
    + 'forgiven, so one dropped increment ends automation for the session');
  // AND THE FORGIVENESS IS NAMED, because it resolves in the permissive
  // direction and a silent permissive transition is exactly what this issue
  // keeps finding.
  assert.match(allRunnerLogs(harness), /interlock-deficit-forgiven/, 'said out loud');

  // IT IS POSITIVE EVIDENCE, NOT A TIMEOUT. A hook that is actually DEAD never
  // advances pre_runs, so the deficit stands however long it waits.
  const dead = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    atRequestEdge(dead);
    // Establish the agreement point FIRST. Leg 4 is a delta, and with no
    // checkpoint the reader's absolute count is absorbed rather than charged to
    // the hook -- which is correct (a baseline walk parses history the hook
    // handled before the state file existed) but means a vector has to pass
    // through a healthy check before it can observe a deficit at all.
    assert.equal(readinessOf(dead).ready, true, 'setup: healthy, and the checkpoint is set');
    for (let i = 0; i < 5; i += 1) {
      const id = `toolu_UNSEEN_${i}`;
      openToolCall(dead, id, { hook: false });
      settleToolCall(dead, id, { hook: false });
    }
    anchorTurn(dead);
    dead.fixture.clock.advance(3600_000);
    const stillDead = readinessOf(dead);
    assert.equal(stillDead.ready, false, 'a dead hook is not forgiven by the passage of time');
    assert.equal(stillDead.detail?.reason, 'interlock-hook-missed-tool-calls');
  } finally {
    dead.cleanup();
  }
});

dialogCase('I20 N1: the wiring leg accepts the spelling install.sh RENDERS, in either form', (harness) => {
  // THE MOST CONSEQUENTIAL DEFECT IN THIS ISSUE, and the cheapest to have
  // caught. install.sh renders hook commands through `abspath` -> `cygpath -u`,
  // so a real Windows `.claude/settings.json` carries the MSYS spelling. The
  // anchored match added for F5 compared raw strings, and `"/c/..."` does not
  // contain `"c:/..."` -- so a CORRECTLY INSTALLED WINDOWS SEAT read as
  // `interlock-hook-not-wired` on every tick and held every automatic write
  // for ever. Fail-closed, but total, on the platform the product runs on.
  //
  // Verified against two independently installed trees on this host, e.g.
  //   SessionStart :: node "/c/aigent-recovery/canary-seat/daemons/sessionstart-reinject.mjs"
  atRequestEdge(harness);

  // (1) THE RENDERED FORM. This is what the fixture now writes by default, so
  //     every other vector in the suite exercises it too.
  harness.runner.interlockWiring = null;
  assert.equal(harness.runner._interlockWiringProblem(), null,
    'FIRST RED: the MSYS spelling the installer produces read as UNWIRED');
  // THE PROPERTY, not a win32 regex. `install.sh` renders through `cygpath -u`,
  // which produces `/c/...` on Windows and leaves a POSIX path alone -- so what
  // the fixture must carry is "whatever this platform's installer would render",
  // which is exactly what msysPath() computes. The previous assertion was a
  // literal `/"\/[a-z]\//`, which cannot match a POSIX path and so was a
  // Windows-only assumption inside a cross-platform suite.
  assert.ok(
    fs.readFileSync(harness.fixture.settingsPath, 'utf8').includes(INTERLOCK_HOOK_PATH_MSYS),
    'setup: the fixture carries the spelling this platform installer renders',
  );

  // (2) THE NATIVE FORM still works -- a hand-written seat, or a future
  //     installer that stops converting.
  writeJson(harness.fixture.settingsPath, {
    hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
      event,
      [{ matcher: '', hooks: [{ type: 'command', command: `node "${INTERLOCK_HOOK_PATH}" ${event}` }] }],
    ])),
  });
  harness.fixture.clock.advance(1000);
  harness.runner.interlockWiring = null;
  assert.equal(harness.runner._interlockWiringProblem(), null, 'the native spelling too');

  // (3) AND THE ANCHORING STILL ANCHORS. Normalising the two spellings must not
  //     become "any path ending in that basename". A different install is still
  //     a different install -- in EITHER spelling, which is the half the old
  //     counterexample could not express because its own form was the real one.
  for (const foreign of [
    'node "/d/other/install/daemons/pre-permission-interlock.mjs"',
    'node "D:/other/install/daemons/pre-permission-interlock.mjs"',
    'node "/c/somewhere/else/daemons/pre-permission-interlock.mjs"',
    'node "pre-permission-interlock.mjs"',
  ]) {
    writeJson(harness.fixture.settingsPath, {
      hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
        event, [{ matcher: '', hooks: [{ type: 'command', command: foreign }] }],
      ])),
    });
    harness.fixture.clock.advance(1000);
    harness.runner.interlockWiring = null;
    const verdict = harness.runner._interlockWiringProblem();
    assert.notEqual(verdict, null, `${foreign} is not this install's hook`);
    assert.equal(verdict.code, 'interlock-hook-not-wired');
  }
});

dialogCase('I19 F5: unwiring the hook mid-session is noticed, not cached over', (harness) => {
  // The wiring verdict was memoised on success for the whole binding, so
  // unwiring was invisible until a successful interlocked clear happened to
  // re-bind. That is reachable by ordinary means: the model holds Edit on the
  // project tree and `/hooks` rewrites this very file.
  atRequestEdge(harness);
  assert.equal(readinessOf(harness).ready, true, 'setup: wired and healthy');

  const settings = JSON.parse(fs.readFileSync(harness.fixture.settingsPath, 'utf8'));
  delete settings.hooks.PreToolUse;
  writeJson(harness.fixture.settingsPath, settings);
  harness.fixture.clock.advance(1000);

  const verdict = readinessOf(harness);
  assert.equal(verdict.ready, false,
    'FIRST RED: the cached pass survives the file it was computed from, so the runner '
    + 'keeps writing automatically with no hook in front of the dialog');
  assert.equal(verdict.detail?.reason, 'interlock-hook-not-wired');
  harness.drive();
  assert.equal(capsuleTextWriteCount(harness), 0);

  // LIVENESS: re-wiring is noticed too -- the cache is keyed on what it was
  // computed from, so it is not sticky in either direction.
  writeJson(harness.fixture.settingsPath, JSON.parse(
    fs.readFileSync(harness.fixture.settingsPath, 'utf8').length >= 0
      ? JSON.stringify({
        hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
          event,
          [{ matcher: '', hooks: [{ type: 'command', command: `node "${INTERLOCK_HOOK_PATH}"`, timeout: 8000 }] }],
        ])),
      })
      : '{}',
  ));
  assert.equal(harness.runner._interlockWiringProblem(), null, 'wired again');

  // AND THE THREE EVENTS MUST COME FROM ONE FILE. `found` used to accumulate
  // across the candidate files, so three different files could satisfy the
  // three required events -- which is not an install that works.
  writeJson(harness.fixture.settingsPath, {
    hooks: {
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `node "${INTERLOCK_HOOK_PATH}"` }] }],
    },
  });
  const split = harness.runner._interlockWiringProblem();
  assert.notEqual(split, null, 'one file wiring only PreToolUse is not wired');
  assert.equal(split.code, 'interlock-hook-not-wired');

  // AND THE COMMAND MUST NAME *THIS* RUNNER'S SIBLING. A bare basename match
  // would be satisfied by some other install's copy of the hook.
  writeJson(harness.fixture.settingsPath, {
    hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
      event,
      // A DIFFERENT DRIVE, so the counterexample cannot be confused with the
      // rendered spelling of THIS install -- which is what made the original
      // `/some/other/install/...` misleading: it had the same FORM as a real
      // Windows install, so this vector would have rejected a correct seat.
      [{ matcher: '', hooks: [{ type: 'command', command: 'node "/d/other/install/daemons/pre-permission-interlock.mjs"' }] }],
    ])),
  });
  const foreign = harness.runner._interlockWiringProblem();
  assert.notEqual(foreign, null, 'another install’s hook is not this one');
  assert.equal(foreign.code, 'interlock-hook-not-wired');
});

dialogCase('I21 F-D: a command with DOUBLED backslashes is still this install hook', (harness) => {
  // install.sh renders through `shell_double_quoted`, which ESCAPES
  // backslashes -- so when `cygpath` is unavailable the command can carry
  //   node "c:\\\\dev\\\\daemons\\\\pre-permission-interlock.mjs"
  // and unifying separators turned that into `c://dev//...`, which matched
  // nothing. Narrower than N1 -- it needs cygpath to be absent AND the path to
  // carry backslashes -- and fail-closed, but the same class of defect.
  atRequestEdge(harness);
  // A SYNTHETIC win32 root, so the vector tests the matcher rather than this
  // host's path shape -- and so it runs identically on Linux.
  harness.runner._interlockHookFile = () => SYNTHETIC_WIN_HOOK;
  const B = BACKSLASH_IN_TESTS;
  const native = SYNTHETIC_WIN_HOOK.split('/').join(B);
  const doubled = native.split(B).join(B + B);
  const wire = (command) => {
    writeJson(harness.fixture.settingsPath, {
      hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
        event, [{ matcher: '', hooks: [{ type: 'command', command }] }],
      ])),
    });
    harness.fixture.clock.advance(1000);
    harness.runner.interlockWiring = null;
    return harness.runner._interlockWiringProblem();
  };
  assert.equal(wire(`node "${doubled}"`), null,
    'FIRST RED: doubled separators read as not-wired, so a seat installed without '
    + 'cygpath held every automatic write for ever');

  // AND THE ANCHORING SURVIVES THE COLLAPSE. Flattening repeated slashes must
  // not make two different roots compare equal.
  for (const foreign of [
    `node "d:${B}${B}other${B}${B}daemons${B}${B}pre-permission-interlock.mjs"`,
    'node "//server/share/daemons/pre-permission-interlock.mjs"',
  ]) {
    const verdict = wire(foreign);
    assert.notEqual(verdict, null, `${foreign} is not this install's hook`);
    assert.equal(verdict.code, 'interlock-hook-not-wired');
  }

  // THE SAME COLLAPSE, ON A POSIX ROOT. Covered here so the Windows host tests
  // the Linux shape and vice versa, rather than each platform testing only its
  // own -- which is how the drive-letter arithmetic in the first version of
  // this vector went unnoticed until CI.
  harness.runner._interlockHookFile = () => SYNTHETIC_POSIX_HOOK;
  assert.equal(wire(`node "${SYNTHETIC_POSIX_HOOK}"`), null, 'a POSIX install is wired');
  assert.equal(wire(`node "${SYNTHETIC_POSIX_HOOK.split('/').join('//')}"`), null,
    'and doubled separators collapse there too');
  assert.notEqual(wire('node "/other-install/daemons/pre-permission-interlock.mjs"'), null,
    'while a different POSIX root is still rejected');
});

dialogCase('I22 item 2: a UNC share named like the drive is NOT this install hook', (harness) => {
  // THE LOOSENING MY OWN F-D FIX INTRODUCED. The UNC guard tested
  // `startsWith("//")` on the WHOLE value, which only fires when the value IS a
  // bare path -- true of the resolved sibling, false of a settings COMMAND,
  // which begins `node `. So a quoted UNC prefix was flattened and a share
  // named `c` matched drive `C:`:
  //
  //   node "\\\\c\\dev\\...\\pre-permission-interlock.mjs"  ->  node "c:/dev/..."
  //
  // read as WIRED. Exotic, and it weakens only the wiring leg -- legs 1 and 2
  // still anchor on the sibling's own sha256 -- but it is a loosening of
  // exactly the property the anchoring exists for, introduced by the fix for a
  // rejection bug. The detection is per TOKEN now.
  atRequestEdge(harness);
  // SYNTHETIC win32 root again, and the tail taken by stripping the ROOT rather
  // than by `slice(3)` -- which assumed `C:/` and silently mangled a POSIX path
  // into `me/runner/...` on Linux, making the assertions pass for the wrong
  // reason.
  harness.runner._interlockHookFile = () => SYNTHETIC_WIN_HOOK;
  const B = BACKSLASH_IN_TESTS;
  const nativeTail = withoutRoot(SYNTHETIC_WIN_HOOK).split('/').join(B);
  const wire = (command) => {
    writeJson(harness.fixture.settingsPath, {
      hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
        event, [{ matcher: '', hooks: [{ type: 'command', command }] }],
      ])),
    });
    harness.fixture.clock.advance(1000);
    harness.runner.interlockWiring = null;
    return harness.runner._interlockWiringProblem();
  };

  const uncNamedLikeDrive = `node "${B}${B}c${B}${nativeTail}"`;
  const verdict = wire(uncNamedLikeDrive);
  assert.notEqual(verdict, null,
    'FIRST RED: a UNC share named `c` read as this install, because the UNC guard '
    + 'never fired on a command string');
  assert.equal(verdict.code, 'interlock-hook-not-wired');

  // A real server share is rejected too, as it always was.
  assert.notEqual(wire(`node "${B}${B}server${B}share${B}daemons${B}pre-permission-interlock.mjs"`), null);

  // AND THE ESCAPED-BACKSLASH CASE F-D EXISTS FOR STILL WORKS. The fix for the
  // loosening must not re-break the rejection bug.
  const escaped = `c:${B}${B}${nativeTail.split(B).join(B + B)}`;
  assert.equal(wire(`node "${escaped}"`), null, 'the doubled-backslash install is still wired');
  assert.equal(wire(`node "${msysPath(SYNTHETIC_WIN_HOOK)}"`), null,
    'and so is the rendered MSYS form');

  // `//c/...` IS AMBIGUOUS BY CONSTRUCTION -- it is both a doubled-MSYS path and
  // a UNC share named `c`, the same string with two meanings -- so it is
  // REJECTED. That is the decision rather than an oversight: when a form cannot
  // be told apart from a foreign root, the safe reading is the rejecting one,
  // and no renderer in this product produces it (cygpath emits single slashes).
  const doubledMsys = msysPath(SYNTHETIC_WIN_HOOK).split('/').join('//');
  assert.notEqual(wire(`node "${doubledMsys}"`), null,
    'an ambiguous form fails closed rather than being guessed');
});

dialogCase('I23 CLAUDE_CONFIG_DIR: the wiring leg reads the profile the HOST uses, and only that one', (harness) => {
  // READ-ACROSS FROM #103, where a plugin detector always read
  // `~/.claude/settings*.json` while the host was using the directory named by
  // `CLAUDE_CONFIG_DIR`. This leg had the same shape and no override handling.
  //
  // CONSTRUCTED BOTH WAYS, because guessing is what produced every fail-open in
  // this issue -- and the composed outcome differs from the leg's own verdict:
  //
  //   FALSE POSITIVE (wired only at ~/.claude, host reads the override): the
  //   leg passed on an unused profile, and it was NOT reachable as a fail-open
  //   -- but for a stronger reason than leg 3's exception. `state.json` is
  //   written only by the HOOK, so with no hook running there is no state file
  //   and the chain stops at `interlock-state-missing`. Leg 3 is never reached,
  //   so its "no tool_use in the tail" exception sits behind a precondition
  //   that never opens. Asserted below rather than argued.
  //
  //   FALSE NEGATIVE (wired at user level INSIDE the override): the leg
  //   rejected a correctly wired seat and held automation for ever. Nothing
  //   detected or lifted that, and it is the direction that actually bites.
  atRequestEdge(harness);
  const wiring = {
    hooks: Object.fromEntries(['PreToolUse', 'PostToolUse', 'Stop'].map((event) => [
      event,
      [{ matcher: '', hooks: [{ type: 'command', command: `node "${INTERLOCK_HOOK_PATH_MSYS}" ${event}`, timeout: 8000 }] }],
    ])),
  };
  const override = path.join(harness.fixture.base, 'override-profile');
  fs.mkdirSync(override, { recursive: true });
  const userLevel = path.join(harness.fixture.homeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(userLevel), { recursive: true });
  const recheck = () => {
    harness.fixture.clock.advance(1000);
    harness.runner.interlockWiring = null;
    return harness.runner._interlockWiringProblem();
  };

  // Strip the project wiring so the user level is the only thing that can
  // satisfy the leg.
  writeJson(harness.fixture.settingsPath, { hooks: {} });
  harness.fixture.env.CLAUDE_CONFIG_DIR = override;

  // (1) wired only at ~/.claude, which the host is NOT reading -> rejected.
  writeJson(userLevel, wiring);
  const unused = recheck();
  assert.notEqual(unused, null,
    'FIRST RED: the leg passed on ~/.claude while the host was reading the override, '
    + 'so its claim -- "the hook is wired where the host will read it" -- was false');
  assert.equal(unused.code, 'interlock-hook-not-wired');

  // AND THE COMPOSED VERDICT WAS NEVER OPEN, even when the leg passed. This is
  // the composed-evidence design working: nothing writes `state.json` but the
  // hook, so with no hook running the chain cannot reach leg 3 at all.
  //
  // The fixture primes a live interlock by default, so the no-hook-has-ever-run
  // state has to be constructed: remove the state file the prime wrote. That is
  // the seat this scenario is about -- the host is reading a profile with no
  // hook in it, so nothing has ever stamped.
  fs.rmSync(path.join(harness.interlockDir(), STATE_NAME), { force: true });
  assert.equal(fs.existsSync(path.join(harness.interlockDir(), STATE_NAME)), false,
    'no hook has run, so there is no state file');
  const composed = harness.runner._interlockReadiness('capsule-request');
  assert.equal(composed.ready, false, 'and readiness refuses either way');
  assert.ok(
    ['interlock-hook-not-wired', 'interlock-state-missing'].includes(composed.detail?.reason),
    `by name, got ${composed.detail?.reason}`,
  );

  // (2) wired at user level INSIDE the override -> accepted.
  fs.rmSync(userLevel, { force: true });
  writeJson(path.join(override, 'settings.json'), wiring);
  assert.equal(recheck(), null,
    'FIRST RED: a correctly wired override profile read as unwired, holding automation '
    + 'for ever on a seat that was set up properly');

  // (3) ONE PROFILE, NOT BOTH. With the override set, a hook wired ONLY in the
  //     unused `~/.claude` must not satisfy the leg -- scanning both would be
  //     the false-positive direction, and it is the one that matters here.
  fs.rmSync(path.join(override, 'settings.json'), { force: true });
  writeJson(override + '/settings.json', { hooks: {} });
  writeJson(userLevel, wiring);
  const both = recheck();
  assert.notEqual(both, null, 'the unused profile cannot satisfy the leg');
  assert.equal(both.code, 'interlock-hook-not-wired');

  // (4) WITH NO OVERRIDE, `~/.claude` is the fallback -- which is what the host
  //     itself does.
  delete harness.fixture.env.CLAUDE_CONFIG_DIR;
  assert.equal(recheck(), null, 'and the fallback still works when the override is unset');

  // (5) THE SHIPPED INSTALL SHAPE IS UNAFFECTED. install.sh renders into
  //     <root>/.claude/settings.json, and the override moves the USER directory
  //     and not the project one -- measured on this host, where the payload and
  //     N10 runs both used CLAUDE_CONFIG_DIR with project-level settings and
  //     the hooks fired.
  fs.rmSync(userLevel, { force: true });
  harness.fixture.env.CLAUDE_CONFIG_DIR = override;
  writeJson(harness.fixture.settingsPath, wiring);
  assert.equal(recheck(), null, 'a correct aigent-OS install passes with the override set');
});
