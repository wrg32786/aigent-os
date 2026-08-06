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
  CAPSULE_CONTROL_INPUT,
  CLEAR_CONTROL_INPUT,
  CLEAR_CONTROL_TEXT,
  CONTROL_ENTER,
  DEFAULT_INPUT_HOLD_TTL_MS,
  DEGRADED_NODE_PTY,
  InputOwnershipTracker,
  ManagedPtyRunner,
  WAKE_MESSAGE,
  loadNodePty,
  resolvePtyCommand,
  runUnmanaged,
  runPtySession,
} from '../pty-runner.mjs';
import { defineTransportConformanceSuite } from './transport-conformance.mjs';

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
    if (this.failWritesRemaining > 0) {
      this.failWritesRemaining -= 1;
      throw new Error('scripted PTY write failure');
    }
    const rendered = asBuffer(value);
    this.writes.push(rendered);
    // Control chunks come in three exact shapes: the legacy combined
    // '/clear\r' (operator manual clears), the two-phase text '/clear', and
    // its separately written Enter '\r'. A bare CR counts as control ONLY
    // when it immediately follows the control text — a queued operator
    // Enter flushed later must never consume a control classification
    // (R26 F6).
    const isControlChunk = rendered.equals(Buffer.from(CLEAR_CONTROL_INPUT))
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
  const transcript = '0123456789';
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
          spawn() {
            managedSpawnCount += 1;
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
    idFactory: ({ sessionId: sid, bootSequence }) => (
      `cycle-${sid}-${bootSequence}`
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
    this.core = makeCore(this.fixture);
    this.transport = wrapCore(this.core, this.guards);
    this.managedSpawnCount = 1;
    this.runner = new ManagedPtyRunner({
      ptyProcess: this.pty,
      memRoot: this.fixture.memRoot,
      sessionId: SESSION_ID,
      transport: this.transport,
      transportFactory: (receipt) => wrapCore(
        makeCore(this.fixture, receipt.session_id),
        this.guards,
      ),
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
    this.runner.capsuleAckSeen = true;
    this.runner.output.observe();
    this.runner.output.observe();
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
          this.runner.capsuleAckSeen = false;
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
    // it a fresh ack -- the ack gate has its own test.
    this.runner.capsuleAckSeen = true;
    const output = this.runner.output.observe();
    const result = this.runner._prepareSubmission(
      this.runner.lastCoreResult,
      output,
    );
    return { code: result?.code || null };
  }

  drive() {
    return this.runner?.tick?.();
  }

  flushControl() {
    return this.scheduler.flushCommit();
  }

  operator(value) {
    if (this.runner) {
      const rendered = asBuffer(value);
      if (this.runner.inputHold
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
  tracker.observe('\r');
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001b[200~pasted\rtext');
  assert.equal(tracker.snapshot().activePaste, true);
  assert.equal(tracker.snapshot().knownEmpty, false);
  tracker.observe('\u001b[201~');
  assert.equal(tracker.snapshot().activePaste, false);
  assert.equal(tracker.snapshot().knownEmpty, false);
  tracker.observe('\r');
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001b[');
  tracker.observe('\r');
  assert.equal(
    tracker.snapshot().activeControl,
    true,
    'CR inside an incomplete CSI must not fabricate an empty prompt',
  );
  tracker.observe('A\r');
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001b]0;title\r');
  assert.equal(
    tracker.snapshot().activeControl,
    true,
    'CR inside OSC must remain fail-closed until its terminator',
  );
  tracker.observe('\u0007\r');
  assert.equal(tracker.snapshot().knownEmpty, true);

  tracker.observe('\u001bPpayload\r');
  assert.equal(
    tracker.snapshot().activeControl,
    true,
    'DCS payloads are active controls until ST',
  );
  tracker.observe('\u001b\\\r');
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
  assert.equal(tracker.snapshot().lastTaint, null, 'CR submission clears lastTaint along with the rest of the state');

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

  // win32 Enter keydown must still submit unconditionally, exactly like a
  // raw CR does even when the line is currently unknown-tainted
  tracker.observe(`${ESC}[13;28;13;1;0;1_`);
  assert.equal(tracker.snapshot().knownEmpty, true, 'win32 Enter keydown submits unconditionally, same as raw CR');
});

test('post-submit kill and cancellation keep queued input out of the old context', async (t) => {
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
          [Buffer.from(CLEAR_CONTROL_TEXT)],
          'post-submit disable must not flush bytes before resume verification',
        );

        harness.observeClearReceipt('fresh');
        for (let turn = 0; turn < 3; turn += 1) harness.drive();
        observed = harness.snapshot();
        assert.equal(observed.holdActive, false);
        assert.equal(observed.queuedInputBytes, 0);
        assert.deepEqual(
          observed.automaticWrites,
          [Buffer.from(CLEAR_CONTROL_TEXT)],
          'disable/cancel after submit must never retry the control command',
        );
        assert.ok(
          Buffer.concat(observed.childWrites)
            .includes(Buffer.from('queued-for-fresh-context\r')),
          'queued bytes must be delivered only after fresh-context release',
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
    observed = harness.snapshot();
    assert.equal(observed.holdActive, false);
    assert.deepEqual(
      observed.automaticWrites,
      [Buffer.from(CLEAR_CONTROL_TEXT), Buffer.from(CONTROL_ENTER)],
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

test('composer-channel leg 3: a submission refusal persists the tracker snapshot, not just the code', () => {
  // Measured on a live seat 2026-08-04: a cycle wedged on
  // runner-input-not-empty while the visible composer was empty. The
  // refusal log carried the code alone — the stuck flag (activePaste vs
  // activeControl vs unknown vs plain bytes) was undiagnosable from disk.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    // No trailing Enter: a bare draft leaves knownEmpty false (an Enter
    // would submit and reset it), the input-not-empty gate this refusal
    // targets.
    harness.runner.input.observe('draft-text');
    harness.attemptAutomaticClear();
    const observed = harness.snapshot();
    assert.match(observed.lastDecision.code, /runner-input-not-empty/);

    const logText = readDaemonErrorLog(harness.fixture.memRoot);
    assert.match(logText, /AUTO-CLEAR REFUSED \(runner-input-not-empty\)/);
    assert.match(logText, /detail=/);
    for (const field of ['knownEmpty', 'activePaste', 'activeControl', 'unknown', 'receivedUnits']) {
      assert.ok(
        logText.includes(field),
        `expected the persisted refusal detail to carry ${field}, got: ${logText}`,
      );
    }
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
      [Buffer.from(CLEAR_CONTROL_INPUT)],
      'the operator-issued /clear must remain the only physical write',
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
      [Buffer.from(CLEAR_CONTROL_TEXT), Buffer.from(CONTROL_ENTER)],
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

test('an ambiguous control-write failure keeps the hold and never retries (leg-3 ponytail)', () => {
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

    harness.pty.failWritesRemaining = 1; // the control write itself throws
    harness.flushControl(); // commitClearSubmission runs here

    const observed = harness.snapshot();
    assert.equal(harness.runner.phase, 'submitted');
    assert.equal(observed.holdActive, true);
    assert.equal(observed.lastDecision?.code, 'runner-control-write-ambiguous');
    assert.equal(
      observed.events.some((entry) => entry.startsWith('submission-ambiguous')),
      true,
    );
    // The throw preceded the fake's record: zero PHYSICAL writes landed, and
    // exactly one attempt was made.
    assert.deepEqual(observed.automaticWrites, []);
    assert.equal(harness.runner.controlWriteAttempts, 1);

    // Never retry: further ticks may not attempt a second write.
    harness.drive();
    harness.drive();
    assert.equal(harness.runner.phase, 'submitted');
    assert.equal(harness.runner.controlWriteAttempts, 1);
    assert.deepEqual(harness.snapshot().automaticWrites, []);

    // The watchdog is the release path (TTL = fuse): hold clears, still no write.
    harness.fireWatchdog();
    const released = harness.snapshot();
    assert.equal(released.holdActive, false);
    assert.equal(harness.runner.controlWriteAttempts, 1);
    assert.deepEqual(released.automaticWrites, []);
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

test('the control clear is text plus a separately scheduled Enter, never one chunk', () => {
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
      harness.snapshot().automaticWrites,
      [Buffer.from('/clear')],
      'the text write must not carry the CR — a single chunk lands in the composer without submitting under bracketed paste',
    );
    const enterIds = [...harness.scheduler.enters.keys()];
    assert.equal(enterIds.length, 1, 'exactly one deferred Enter is scheduled');
    const delay = harness.scheduler.enterArms.get(enterIds[0]);
    assert.ok(
      delay >= 250,
      `a real delay must separate text from Enter so the terminal treats the CR as a keypress, not paste payload (delay: ${delay}ms)`,
    );

    harness.fireEnter();
    assert.deepEqual(
      harness.snapshot().automaticWrites,
      [Buffer.from('/clear'), Buffer.from('\r')],
      'the Enter arrives as its own write through the same automatic-write classification',
    );
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
    assert.deepEqual(harness.pty.writes, [Buffer.from('/clear')], 'text phase landed');

    harness.pty.failWritesRemaining = 1; // the deferred Enter write throws
    harness.fireEnter();
    assert.deepEqual(harness.pty.writes, [Buffer.from('/clear')], 'the failed Enter recorded no bytes — /clear is stranded in the composer');

    harness.operator('op-cmd\r'); // operator types during the hold: queued
    assert.ok(harness.snapshot().queuedInputBytes > 0, 'operator input is queued behind the hold');

    harness.fireWatchdog(); // fuse expires -> disable -> release -> flush

    const writes = harness.pty.writes.map((chunk) => chunk.toString('latin1'));
    const opIndex = writes.indexOf('op-cmd\r');
    assert.ok(opIndex >= 0, 'queued operator input is delivered after release');
    assert.equal(
      writes[opIndex - 1],
      '\u0015',
      `the flush must lead with kill-line so queued bytes cannot concatenate onto the stranded '/clear' (writes: ${JSON.stringify(writes)})`,
    );
  } finally {
    harness.cleanup();
  }
});

test('the commit-time checkpoint recheck carries the observed ack', () => {
  // The principal's design (2026-08-05): ack literal + capsule exists ->
  // clear. evaluateCheckpointFreshness already honors ackFresh (it settles
  // the transcript-tail race the capsule's own announcement creates) — but
  // the runner's commit-time recheck never passed the flag, so the tail
  // tolerance re-raced blind at the exact moment it mattered. Measured on
  // the reference seat: checkpoint confirmed, then the operator's nudge
  // turns re-tripped the recheck until the freshness window ate the cycle.
  const harness = new RunnerHarness({
    mode: 'managed',
    ptyLoad: 'ok',
    lockState: 'free',
  });
  try {
    harness.primeAuthorized();
    harness.runner.capsuleAckSeen = true; // the seat printed the literal this cycle
    harness.attemptAutomaticClear();
    harness.flushControl();
    assert.equal(harness.runner.phase, 'submitted');
    const commitCall = harness.checkpointCalls.at(-1);
    assert.equal(
      commitCall?.ackFresh,
      true,
      'the runner must hand the observed ack to the checkpoint evaluator — omitting it re-races the tail tolerance the ack exists to settle',
    );
  } finally {
    harness.cleanup();
  }
});

// DEFECT B / FIX B (2026-08-05): _writeCapsuleRequest is one-shot per
// cycle_id by design (guard added 2026-08-04 to stop an infinite
// re-injection loop — see its comment in pty-runner.mjs). But the single pty
// write it fires can land in a TUI that is not ready (measured live
// 2026-08-05: a relaunch injected the request during --continue restore and
// the seat never answered). With no ack and nothing re-asking, the cycle is
// wedged forever. A scripted transport stands in for the real
// AutoClearTransport core here — unlike wrapCore/makeCore it never resolves
// checkpoint freshness on its own timeline, so these tests can drive a
// deterministic "stuck forever" sequence without fighting the real
// selector/stop-writer machinery that governs when checkpointObservable
// actually succeeds.
class WedgedCapsuleTransport {
  constructor(sessionId, cycleId) {
    this.sessionId = sessionId;
    this.cycleId = cycleId;
    this.calls = 0;
  }

  get state() {
    const wedged = this.calls > 1;
    return {
      state: wedged ? 'HOLD:checkpoint-transcript-short' : 'checkpoint-requested',
      cycle_id: this.cycleId,
      session_id: this.sessionId,
      hold: wedged
        ? { code: 'checkpoint-transcript-short', detail: { resume_state: 'checkpoint-requested' } }
        : null,
    };
  }

  tick() {
    this.calls += 1;
    const state = this.state;
    if (this.calls === 1) {
      return { state, transitioned: true, status: 'checkpoint-requested', action: 'request-checkpoint' };
    }
    return { state, transitioned: false, status: 'hold', code: state.hold.code, detail: state.hold.detail };
  }
}

function capsuleWriteCount(harness) {
  return harness.pty.writes.filter((w) => w.equals(Buffer.from(CAPSULE_CONTROL_INPUT))).length;
}

test('a lost capsule request retries after the transcript sits idle, bounded and idle-gated', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transport = new WedgedCapsuleTransport(SESSION_ID, 'wedge-cycle-1');

    harness.drive(); // the one-shot initial fire
    assert.equal(capsuleWriteCount(harness), 1, 'the initial fire must still happen exactly once');

    // transcript never changes: no ack, seat fully settled and ack-less
    for (let i = 0; i < 5; i += 1) harness.drive();

    assert.equal(
      capsuleWriteCount(harness),
      2,
      'a request that never gets an ack must retry once the transcript has sat idle for >=5 ticks -- ' +
      'MUST be red on unmodified code (measured live 2026-08-05: a seat wedged forever with nothing to re-ask)',
    );
    assert.ok(
      harness.runner.events.some((e) => e.name === 'capsule-request-retry'),
      'the retry must be LOUD -- capsule-request-retry event, so the wedge is visible on disk',
    );
  } finally {
    harness.cleanup();
  }
});

test('a GROWING transcript never triggers a capsule-request retry (protects the 2026-08-04 anti-loop fix)', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transport = new WedgedCapsuleTransport(SESSION_ID, 'wedge-cycle-2');
    harness.drive(); // initial fire

    // A growing transcript means the seat may be mid-capsule. Interrupting
    // it is the exact infinite-reinjection loop the 08-04 guard exists to
    // prevent -- this must hold no matter how many ticks pass.
    for (let i = 0; i < 20; i += 1) {
      fs.appendFileSync(harness.fixture.transcriptPath, `growing-${i}\n`);
      harness.drive();
    }

    assert.equal(
      capsuleWriteCount(harness),
      1,
      'a growing transcript must never trigger a retry, only the one-shot initial fire',
    );
    assert.equal(
      harness.runner.events.filter((e) => e.name === 'capsule-request-retry').length,
      0,
    );
  } finally {
    harness.cleanup();
  }
});

test('a permanently silent request stops at exactly 3 attempts and goes loud once, never again', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transport = new WedgedCapsuleTransport(SESSION_ID, 'wedge-cycle-3');
    harness.drive(); // attempt 1 (initial)

    // far more ticks than the cap needs (3 attempts * 5 idle ticks each)
    for (let i = 0; i < 60; i += 1) harness.drive();

    assert.equal(capsuleWriteCount(harness), 3, 'exactly 3 attempts total: the initial fire plus 2 bounded retries');
    assert.equal(
      harness.runner.events.filter((e) => e.name === 'capsule-request-exhausted').length,
      1,
      'the wedge must go loud on disk exactly once, never silently and never repeatedly',
    );

    for (let i = 0; i < 20; i += 1) harness.drive();
    assert.equal(capsuleWriteCount(harness), 3, 'no further writes ever, no matter how many more ticks pass');
  } finally {
    harness.cleanup();
  }
});

test('the ack literal ends the wedge -- capsule-ack-observed fires and retries stop', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transport = new WedgedCapsuleTransport(SESSION_ID, 'wedge-cycle-4');
    harness.drive(); // initial fire
    for (let i = 0; i < 5; i += 1) harness.drive(); // reach the first retry

    assert.equal(capsuleWriteCount(harness), 2, 'setup: the first retry must have fired before the ack arrives');

    // A transcript ENTRY, not a bare literal: the ack counts only in the
    // seat's own turn, because the capsule skill's instructions carry the
    // same words and land in the transcript the moment the verb is invoked.
    fs.appendFileSync(
      harness.fixture.transcriptPath,
      `\n{"type":"assistant","message":{"content":[{"type":"text","text":"${CAPSULE_ACK_LITERAL}"}]}}\n`,
    );
    harness.drive();
    assert.equal(harness.runner.capsuleAckSeen, true, 'the ack must be observed');
    assert.ok(harness.runner.events.some((e) => e.name === 'capsule-ack-observed'));

    for (let i = 0; i < 20; i += 1) harness.drive();
    assert.equal(capsuleWriteCount(harness), 2, 'no further retries once the ack is seen');
  } finally {
    harness.cleanup();
  }
});

// R26 FIX finding 1 (MUST): capsuleRequestAttempts must advance on the catch
// path, not just the success path. An attempt TRIED is an attempt SPENT --
// the bound is on injections attempted, not confirmed successful, or a
// transient EAGAIN-class pty.write failure would re-arm the retry forever
// (it would re-fire every 5 idle ticks with no cap, and
// capsule-request-exhausted would never fire).
test('a capsule-request retry write that throws still spends its attempt (transient EAGAIN class)', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transport = new WedgedCapsuleTransport(SESSION_ID, 'wedge-cycle-5');
    harness.drive(); // initial fire succeeds
    assert.equal(capsuleWriteCount(harness), 1);

    // Every write from here on throws (ScriptedPty's built-in counter) --
    // stands in for a transient EAGAIN-class pty.write failure on retry.
    harness.pty.failWritesRemaining = 999;

    for (let i = 0; i < 60; i += 1) harness.drive();

    assert.equal(
      harness.runner.capsuleRequestAttempts,
      3,
      'a throwing write must still spend its attempt -- MUST be red on unmodified code ' +
      '(attempts never advances past 1, so the retry re-fires every 5 idle ticks forever ' +
      'and capsule-request-exhausted never fires)',
    );
    assert.equal(
      harness.runner.events.filter((e) => e.name === 'capsule-request-exhausted').length,
      1,
      'exhaustion must still go loud even though every retry write failed',
    );
    assert.equal(
      capsuleWriteCount(harness),
      1,
      'the initial fire is the only write that actually landed -- every retry write threw',
    );
  } finally {
    harness.cleanup();
  }
});

// R26 FIX finding 2 (SHOULD): a HOLD unrelated to the capsule wedge (e.g.
// HOLD:telemetry-stale, which the pressure gate can raise WHILE already in
// checkpoint-requested/HOLD:checkpoint-* territory) can carry
// hold.detail.resume_state:'checkpoint-requested' too. Gating on resume_state
// alone lets that unrelated hold spend the 3-attempt budget before the seat
// ever returns to the real wedge. The gate must check the state STRING
// itself: bare checkpoint-requested, or a HOLD whose own code is
// checkpoint-* (HOLD:checkpoint-transcript-short and siblings) -- never any
// hold merely resuming to checkpoint-requested.
class TelemetryStaleThenWedgedTransport {
  constructor(sessionId, cycleId, telemetryStaleTicks) {
    this.sessionId = sessionId;
    this.cycleId = cycleId;
    this.telemetryStaleTicks = telemetryStaleTicks;
    this.calls = 0;
  }

  get state() {
    const base = { cycle_id: this.cycleId, session_id: this.sessionId };
    if (this.calls === 1) {
      return { ...base, state: 'checkpoint-requested', hold: null };
    }
    if (this.calls <= 1 + this.telemetryStaleTicks) {
      return {
        ...base,
        state: 'HOLD:telemetry-stale',
        hold: { code: 'telemetry-stale', detail: { resume_state: 'checkpoint-requested' } },
      };
    }
    return {
      ...base,
      state: 'HOLD:checkpoint-transcript-short',
      hold: { code: 'checkpoint-transcript-short', detail: { resume_state: 'checkpoint-requested' } },
    };
  }

  tick() {
    this.calls += 1;
    const state = this.state;
    if (this.calls === 1) {
      return { state, transitioned: true, status: 'checkpoint-requested', action: 'request-checkpoint' };
    }
    return { state, transitioned: false, status: 'hold', code: state.hold.code, detail: state.hold.detail };
  }
}

test('a HOLD:telemetry-stale detour consumes zero retry budget, even though its resume_state is checkpoint-requested', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.runner.transport = new TelemetryStaleThenWedgedTransport(SESSION_ID, 'wedge-cycle-6', 10);
    harness.drive(); // initial fire

    for (let i = 0; i < 10; i += 1) harness.drive(); // all 10 ticks are HOLD:telemetry-stale

    assert.equal(
      capsuleWriteCount(harness),
      1,
      'HOLD:telemetry-stale must never spend retry budget, no matter how many idle ticks pass inside it -- ' +
      'MUST be red on unmodified code (resume_state alone qualifies it, so it fires retries during the detour)',
    );
    assert.equal(harness.runner.capsuleRequestAttempts, 1);

    // now genuinely settle into the real wedge -- the budget must be fully
    // intact, unspent by the telemetry-stale detour
    for (let i = 0; i < 5; i += 1) harness.drive();
    assert.equal(
      capsuleWriteCount(harness),
      2,
      'the real wedge still gets its first retry once it arrives, budget untouched by the detour',
    );
  } finally {
    harness.cleanup();
  }
});

// DEFECT 4 / FIX (2026-08-05): a SessionStart hook delivers the resume
// procedure + capsule as CONTEXT ONLY -- hooks do not create a turn. With no
// first message, a fresh post-clear seat cannot act on the procedure, posts
// no telemetry, and the pressure gate holds on telemetry-missing forever
// (measured live on the cert seat, transcript head in hand: hook fired,
// capsule loaded -- delivery is NOT the problem, the absent first turn is).
// The operator saying "hi" un-stuck it every time -- this is that
// hand-delivered wake, automated. Same idle-gated, 3-attempt-bounded shape
// as the capsule-request retry. WAKE_MESSAGE/WAKE_TURN_GROWTH_THRESHOLD_BYTES
// are imported above from '../pty-runner.mjs'.

function wakeWriteCount(harness) {
  return harness.pty.writes.filter((w) => w.equals(Buffer.from(WAKE_MESSAGE))).length;
}

function clearReceiptFor(harness, sessionId, bootSequence = 11) {
  return {
    boot_sequence: bootSequence,
    session_id: sessionId,
    source: 'clear',
    observed_at: new Date(harness.fixture.clock.ms() + 1000).toISOString(),
  };
}

test('post-clear wake: fires once after the transcript settles, with no turn present', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const transcriptPath = transcriptPathFor({
      cwd: harness.fixture.cwd,
      sessionId: NEXT_SESSION_ID,
      homeDir: harness.fixture.homeDir,
    });
    writeText(transcriptPath, 'boot\n'); // the new session's transcript already carries some hook boot content

    const ok = harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID));
    assert.equal(ok, true, 'setup: rebind must succeed');
    assert.equal(wakeWriteCount(harness), 0, 'no wake yet -- no ticks have run');

    for (let i = 0; i < 8; i += 1) harness.drive();

    assert.equal(
      wakeWriteCount(harness),
      1,
      'a settled transcript with no turn must fire the wake exactly once -- MUST be red on unmodified code',
    );
    assert.ok(harness.runner.events.some((e) => e.name === 'wake-injected'), 'the fire must be LOUD');
  } finally {
    harness.cleanup();
  }
});

test('post-clear wake: a GROWING transcript defers the fire until it settles', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const transcriptPath = transcriptPathFor({
      cwd: harness.fixture.cwd,
      sessionId: NEXT_SESSION_ID,
      homeDir: harness.fixture.homeDir,
    });
    writeText(transcriptPath, 'boot\n');
    harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID));

    // the seat may still be restoring -- transcript keeps growing for several ticks
    for (let i = 0; i < 8; i += 1) {
      fs.appendFileSync(transcriptPath, `restoring-${i}\n`);
      harness.drive();
    }
    assert.equal(
      wakeWriteCount(harness),
      0,
      'a growing transcript must never fire the wake -- MUST be red on unmodified code if it fires early',
    );

    // now it genuinely settles
    for (let i = 0; i < 8; i += 1) harness.drive();
    assert.equal(wakeWriteCount(harness), 1, 'the wake must still fire once the transcript genuinely settles');
  } finally {
    harness.cleanup();
  }
});

test('post-clear wake: a write that throws still spends its attempt, capped at 3, exhausted once (mirrors the capsule-request contract)', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const transcriptPath = transcriptPathFor({
      cwd: harness.fixture.cwd,
      sessionId: NEXT_SESSION_ID,
      homeDir: harness.fixture.homeDir,
    });
    writeText(transcriptPath, 'boot\n');
    harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID));

    harness.pty.failWritesRemaining = 999; // every write throws from here on

    for (let i = 0; i < 40; i += 1) harness.drive();

    assert.equal(
      harness.runner.wakeAttempts,
      3,
      'a throwing write must still spend its attempt, capped at 3 -- MUST be red on unmodified code',
    );
    assert.equal(
      harness.runner.events.filter((e) => e.name === 'wake-exhausted').length,
      1,
      'exhaustion must go loud exactly once even though every write threw',
    );
    assert.equal(wakeWriteCount(harness), 0, 'every write threw -- none actually landed');
  } finally {
    harness.cleanup();
  }
});

test('post-clear wake: a dirty composer defers the fire until the tracker clears', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const transcriptPath = transcriptPathFor({
      cwd: harness.fixture.cwd,
      sessionId: NEXT_SESSION_ID,
      homeDir: harness.fixture.homeDir,
    });
    writeText(transcriptPath, 'boot\n');
    harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID));

    harness.runner.input.observe('operator-is-mid-type'); // dirty composer, no CR yet

    for (let i = 0; i < 8; i += 1) harness.drive();
    assert.equal(
      wakeWriteCount(harness),
      0,
      'a dirty composer must hold the wake -- MUST be red on unmodified code if it glues onto operator typing',
    );

    harness.runner.input.observe('\r'); // operator submits -- composer reads clean again
    harness.drive();
    assert.equal(wakeWriteCount(harness), 1, 'the wake must fire on the first tick the composer reads clean again');
  } finally {
    harness.cleanup();
  }
});

// SPEC AMENDMENT (2026-08-05): principal's direct design word -- the wake is
// not a bare nudge, it IS the resume instruction, fleet-style, so the boot
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
test('post-clear wake: the Enter rides its own write so the terminal parses it as a keypress', () => {
  assert.ok(
    !WAKE_MESSAGE.includes('\r'),
    'WAKE_MESSAGE must not carry a trailing CR -- a text+CR single chunk is read as a PASTE and never submits',
  );

  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    const transcriptPath = transcriptPathFor({
      cwd: harness.fixture.cwd,
      sessionId: NEXT_SESSION_ID,
      homeDir: harness.fixture.homeDir,
    });
    writeText(transcriptPath, 'boot\n');

    assert.equal(harness.runner._rebindAfterClear(clearReceiptFor(harness, NEXT_SESSION_ID)), true, 'setup: rebind');
    for (let i = 0; i < 10; i += 1) harness.drive();

    assert.equal(wakeWriteCount(harness), 1, 'setup: the wake text must have been written once');
    harness.scheduler.fireEnter(); // the Enter is a DEFERRED write -- flush it
    const textIndex = harness.pty.writes.findIndex((w) => w.equals(Buffer.from(WAKE_MESSAGE)));
    const afterText = harness.pty.writes.slice(textIndex + 1);
    assert.ok(
      afterText.some((w) => w.equals(Buffer.from(CONTROL_ENTER))),
      'a SEPARATE CONTROL_ENTER write must follow the wake text -- MUST be red on unmodified code, where the CR is glued into WAKE_MESSAGE and the terminal swallows it as pasted content',
    );
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
test('automatic clear does NOT submit until the capsule ack for this cycle is seen', () => {
  const harness = new RunnerHarness({ mode: 'managed', ptyLoad: 'ok', lockState: 'free' });
  try {
    harness.primeAuthorized();
    harness.runner.capsuleAckSeen = false; // the capsule verb never completed
    harness.attemptAutomaticClear();
    harness.flushControl();
    harness.fireEnter();

    assert.deepEqual(
      harness.snapshot().automaticWrites,
      [],
      'no ack for this cycle means no clear -- MUST be red on unmodified code',
    );
    // The ACKED path needs no leg here: primeAuthorized() sets the ack, so
    // every other clear test in this file is the positive control -- they go
    // red if this guard ever over-blocks.
  } finally {
    harness.cleanup();
  }
});
