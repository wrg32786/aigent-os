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
  acquireRunnerLock,
  evaluateCheckpointFreshness,
  releaseRunnerLock,
  transcriptPathFor,
} from '../auto-clear-transport.mjs';
import {
  CLEAR_CONTROL_INPUT,
  DEGRADED_NODE_PTY,
  InputOwnershipTracker,
  ManagedPtyRunner,
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

  scheduleWatchdog(callback) {
    return this._schedule(this.watchdogs, callback);
  }

  clearWatchdog(handle) {
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
    if (rendered.equals(Buffer.from(CLEAR_CONTROL_INPUT))) {
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
    loadNodePtyFn: () => ({
      ok: true,
      module: {
        spawn() {
          managedSpawnCount += 1;
          return pty;
        },
      },
    }),
    runUnmanagedFn: () => {
      unmanagedSpawnCount += 1;
      return CHILD_EXIT_CODE;
    },
    acquireRunnerLockFn: () => ({ path: 'run3-threshold-wiring-lock' }),
    releaseRunnerLockFn: () => {},
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
        line: Buffer.concat(stderr.writes).toString('utf8'),
        mode: result.mode,
        runnerPresent: Boolean(result.runner),
        managedSpawnCount,
        transportConstructionCount: constructed.length,
        unmanagedSpawnCount,
      };
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
  const marker = path.join(home, '.aigent', 'first-run-done');
  const capturePrefix = 'RUN3_LAUNCH_ARGV:';
  try {
    fs.mkdirSync(daemonDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(daemonDirectory, 'pty-runner.mjs'),
      `process.stdout.write('${capturePrefix}' + Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64') + '\\n');\n`,
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
      scheduleWatchdog: (callback) => this.scheduler.scheduleWatchdog(callback),
      clearWatchdog: (handle) => this.scheduler.clearWatchdog(handle),
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
      readCheckpointObservableFn: () => evaluateCheckpointFreshness({
        memRoot: this.fixture.memRoot,
        sessionId: this.runner?.sessionId || SESSION_ID,
        cwd: this.fixture.cwd,
        homeDir: this.fixture.homeDir,
        fsImpl: fs,
        selectCapsuleFn: () => this.fixture.selection,
      }),
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
          fs.appendFileSync(
            this.fixture.transcriptPath,
            '\nactivity after checkpoint\n',
          );
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
    const logs = [
      ...this.fixture.logs.map((entry) => asBuffer(entry)),
      ...this.stderr.writes.map(asBuffer),
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
  automaticClear: Buffer.from(CLEAR_CONTROL_INPUT),
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
          [Buffer.from(CLEAR_CONTROL_INPUT)],
          'post-submit disable must not flush bytes before resume verification',
        );

        harness.observeClearReceipt('fresh');
        for (let turn = 0; turn < 3; turn += 1) harness.drive();
        observed = harness.snapshot();
        assert.equal(observed.holdActive, false);
        assert.equal(observed.queuedInputBytes, 0);
        assert.deepEqual(
          observed.automaticWrites,
          [Buffer.from(CLEAR_CONTROL_INPUT)],
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
      [Buffer.from(CLEAR_CONTROL_INPUT)],
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
      [Buffer.from(CLEAR_CONTROL_INPUT)],
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
      line: 'DEGRADED:auto-clear-threshold-invalid abc\n',
      mode: 'degraded',
      runnerPresent: false,
      managedSpawnCount: 0,
      transportConstructionCount: 0,
      unmanagedSpawnCount: 1,
    });
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
        line: `DEGRADED:auto-clear-threshold-invalid ${String(raw)}\n`,
        mode: 'degraded',
        runnerPresent: false,
        managedSpawnCount: 0,
        transportConstructionCount: 0,
        unmanagedSpawnCount: 1,
      });
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
    && /Invoke-AigentClaude -ClaudeArgs \(@\('--continue', '\/open'\) \+ \$claudePassthroughArgs\)/.test(powershellCode)
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
  assert.deepEqual(observed, {
    shellFirstRun: ['--', '/start', ...opaqueArgs],
    shellReturning: ['--', '--continue', '/open', ...opaqueArgs],
    powershellFirstRun: powerShellCommand === null
      ? null
      : ['--', '/start', ...opaqueArgs],
    powershellReturning: powerShellCommand === null
      ? null
      : ['--', '--continue', '/open', ...opaqueArgs],
    powershellSourceBound: true,
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
      shellReturning: ['--', '--continue', '/open'],
      powershellFirstRun: powerShellCommand === null
        ? null
        : ['--', '/start'],
      powershellReturning: powerShellCommand === null
        ? null
        : ['--', '--continue', '/open'],
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
  assert.match(
    shell,
    /launch_claude --continue "\/open" \$\{operator_args\[0\]\+"\$\{operator_args\[@\]\}"\}/,
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
    /Invoke-AigentClaude -ClaudeArgs \(@\('--continue', '\/open'\) \+ \$claudePassthroughArgs\)/,
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
