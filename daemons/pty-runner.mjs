#!/usr/bin/env node
// pty-runner.mjs -- the interactive, managed half of auto-clear transport.
//
// WHY THIS EXISTS: the persisted transport core can authorize one clear, but it
// deliberately cannot own a terminal.  A separate process must be the sole
// writer to Claude's PTY so operator input cannot be concatenated with an
// automatic command, interleaved through it, or delivered to the context being
// replaced.  This runner supplies that ownership without moving any lifecycle
// decision out of AutoClearTransport.
//
// node-pty is intentionally loaded at runtime from the repository's existing
// optional-dependency package.  A no-deps install must still launch Claude:
// checkpoint and recovery hooks remain useful while automatic clear reports a
// loud, named degraded state.
//
// All mutable boundaries are injectable.  Deterministic tests use a scripted
// PTY, clock, scheduler, receipt reader, kill-switch reader, and transport.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  AutoClearTransport,
  RunnerLockError,
  acquireRunnerLock,
  evaluateCheckpointFreshness,
  readKillSwitch,
  releaseRunnerLock,
} from './auto-clear-transport.mjs';
import { memRoot as resolveMemoryRoot } from './lifecycle-common.mjs';

const optionalRequire = createRequire(
  new URL('./semantic-search/package.json', import.meta.url),
);

export const DEGRADED_NODE_PTY = 'DEGRADED:auto-clear-node-pty-unavailable';
export const DEGRADED_NODE_PTY_LINE = `${DEGRADED_NODE_PTY} checkpoint/recovery available; auto-clear unavailable; launching unmanaged`;
export const UNMANAGED_AUTO_CLEAR_OFF = 'UNMANAGED:auto-clear-disabled';
export const CLEAR_CONTROL_INPUT = '/clear\r';
export const DEFAULT_RUNNER_TICK_MS = 100;
export const DEFAULT_INPUT_HOLD_TTL_MS = 15_000;

function hasOwn(value, field) {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, field);
}

function asText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data ?? '');
}

function asPtyInput(data) {
  if (typeof data === 'string' || Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return String(data ?? '');
}

function errorText(error) {
  return error?.message || String(error);
}

function oneLine(value, maximum = 1200) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function defaultDiagnostic(message) {
  try { process.stderr.write(`${oneLine(message)}\n`); } catch { /* no diagnostic sink */ }
}

function safeCall(fn, ...args) {
  try {
    return { ok: true, value: fn(...args) };
  } catch (error) {
    return { ok: false, error };
  }
}

function dispose(subscription) {
  try { subscription?.dispose?.(); } catch { /* teardown is best effort */ }
}

function validReceiptProblem(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { code: 'runner-boot-receipt-invalid', detail: 'root object missing' };
  }
  const absent = ['boot_sequence', 'session_id', 'source', 'observed_at']
    .filter((field) => !hasOwn(receipt, field));
  if (absent.length) {
    return {
      code: 'runner-boot-receipt-field-missing',
      detail: { fields: absent },
    };
  }
  if (!Number.isSafeInteger(receipt.boot_sequence) || receipt.boot_sequence < 0) {
    return {
      code: 'runner-boot-receipt-field-invalid',
      detail: { field: 'boot_sequence' },
    };
  }
  for (const field of ['session_id', 'source', 'observed_at']) {
    if (typeof receipt[field] !== 'string') {
      return {
        code: 'runner-boot-receipt-field-invalid',
        detail: { field },
      };
    }
  }
  if (receipt.session_id.length === 0) {
    return {
      code: 'runner-boot-receipt-field-invalid',
      detail: { field: 'session_id' },
    };
  }
  if (!Number.isFinite(Date.parse(receipt.observed_at))) {
    return {
      code: 'runner-boot-receipt-field-invalid',
      detail: { field: 'observed_at' },
    };
  }
  return null;
}

/**
 * Read the durable SessionStart observable used to bind and verify the runner.
 */
export function readBootReceiptObservable({
  memRoot,
  fsImpl = fs,
} = {}) {
  if (typeof memRoot !== 'string' || memRoot.length === 0) {
    return {
      ok: false,
      code: 'runner-memory-root-missing',
      detail: { field: 'memRoot' },
    };
  }
  const target = path.join(memRoot, 'runtime', 'boot-receipt.json');
  let receipt;
  try {
    receipt = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      code: error?.code === 'ENOENT'
        ? 'runner-boot-receipt-missing'
        : 'runner-boot-receipt-invalid',
      detail: { path: target, error: errorText(error) },
    };
  }
  const problem = validReceiptProblem(receipt);
  if (problem) return { ok: false, ...problem };
  return { ok: true, receipt };
}

function killSwitchProblem(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return {
      code: 'runner-kill-switch-invalid',
      detail: 'root object missing',
    };
  }
  const absent = ['active', 'code', 'detail']
    .filter((field) => !hasOwn(observation, field));
  if (absent.length) {
    return {
      code: 'runner-kill-switch-field-missing',
      detail: { fields: absent },
    };
  }
  if (typeof observation.active !== 'boolean') {
    return {
      code: 'runner-kill-switch-field-invalid',
      detail: { field: 'active' },
    };
  }
  if (observation.active && typeof observation.code !== 'string') {
    return {
      code: 'runner-kill-switch-field-invalid',
      detail: { field: 'code' },
    };
  }
  return null;
}

/**
 * Fail-closed model of the operator's current input line.
 *
 * A CR is the only unambiguous submission boundary.  Completed terminal
 * controls remain "unknown" because an arrow, delete, or editor sequence may
 * have changed text the runner cannot see.  Unknown is cleared only by CR.
 */
export class InputOwnershipTracker {
  constructor() {
    this.mode = 'normal';
    this.sequence = '';
    this.pasteEndProbe = '';
    this.knownEmpty = true;
    this.unknown = false;
    this.activePaste = false;
    this.activeControl = false;
    this.receivedUnits = 0;
  }

  _submitted() {
    this.mode = 'normal';
    this.sequence = '';
    this.pasteEndProbe = '';
    this.knownEmpty = true;
    this.unknown = false;
    this.activePaste = false;
    this.activeControl = false;
  }

  observe(data) {
    const text = asText(data);
    this.receivedUnits += text.length;

    for (const character of text) {
      if (this.mode === 'paste') {
        this.knownEmpty = false;
        this.pasteEndProbe = `${this.pasteEndProbe}${character}`.slice(-6);
        if (this.pasteEndProbe === '\u001b[201~') {
          this.mode = 'normal';
          this.pasteEndProbe = '';
          this.activePaste = false;
          this.activeControl = false;
        }
        continue;
      }

      if (character === '\r' && this.mode === 'normal') {
        this._submitted();
        continue;
      }

      if (this.mode === 'escape') {
        this.sequence += character;
        if (character === '[') {
          this.mode = 'csi';
          continue;
        }
        if (character === ']') {
          this.mode = 'osc';
          continue;
        }
        if (['P', '_', '^', 'X'].includes(character)) {
          this.mode = 'string-control';
          continue;
        }
        this.mode = 'normal';
        this.sequence = '';
        this.activeControl = false;
        this.unknown = true;
        this.knownEmpty = false;
        continue;
      }

      if (this.mode === 'csi') {
        this.sequence += character;
        if (this.sequence.length > 64) {
          this.mode = 'unknown-control';
          this.sequence = this.sequence.slice(-2);
          this.activeControl = true;
          this.unknown = true;
          this.knownEmpty = false;
          continue;
        }
        const code = character.codePointAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          if (this.sequence === '\u001b[200~') {
            this.mode = 'paste';
            this.sequence = '';
            this.activePaste = true;
            this.activeControl = false;
            this.pasteEndProbe = '';
          } else {
            this.mode = 'normal';
            this.sequence = '';
            this.activeControl = false;
            this.unknown = true;
            this.knownEmpty = false;
          }
        }
        continue;
      }

      if (this.mode === 'osc') {
        this.sequence += character;
        if (character === '\u0007' || this.sequence.endsWith('\u001b\\')) {
          this.mode = 'normal';
          this.sequence = '';
          this.activeControl = false;
          this.unknown = true;
          this.knownEmpty = false;
        } else if (this.sequence.length > 1024) {
          this.mode = 'unknown-control';
          this.sequence = this.sequence.slice(-2);
          this.activeControl = true;
          this.unknown = true;
          this.knownEmpty = false;
        }
        continue;
      }

      if (this.mode === 'string-control' || this.mode === 'unknown-control') {
        this.sequence = `${this.sequence}${character}`.slice(-1024);
        if (this.sequence.endsWith('\u001b\\')) {
          this.mode = 'normal';
          this.sequence = '';
          this.activeControl = false;
          this.unknown = true;
          this.knownEmpty = false;
        } else {
          this.activeControl = true;
          this.unknown = true;
          this.knownEmpty = false;
        }
        continue;
      }

      if (character === '\u001b') {
        this.mode = 'escape';
        this.sequence = character;
        this.activeControl = true;
        this.unknown = true;
        this.knownEmpty = false;
        continue;
      }

      const code = character.codePointAt(0);
      if (code < 0x20 || code === 0x7f) {
        this.unknown = true;
      }
      this.knownEmpty = false;
    }
    return this.snapshot();
  }

  snapshot() {
    const activeSequence = this.activePaste
      || this.activeControl
      || this.mode !== 'normal';
    return {
      knownEmpty: this.knownEmpty && !this.unknown && !activeSequence,
      activePaste: this.activePaste,
      activeControl: this.activeControl || (
        this.mode !== 'normal' && this.mode !== 'paste'
      ),
      unknown: this.unknown,
      receivedUnits: this.receivedUnits,
    };
  }
}

/**
 * Output is settled only after two observations see the same generation.
 * An interval may sample this object, but elapsed time never creates evidence:
 * a child data event changes the generation and immediately revokes settlement.
 */
export class OutputSettlementTracker {
  constructor() {
    this.generation = 0;
    this.units = 0;
    this.lastObservedGeneration = null;
    this.unchangedObservations = 0;
  }

  note(data) {
    this.generation += 1;
    this.units += asText(data).length;
    this.unchangedObservations = 0;
    return this.snapshot(false);
  }

  observe() {
    if (this.lastObservedGeneration === this.generation) {
      this.unchangedObservations += 1;
    } else {
      this.lastObservedGeneration = this.generation;
      this.unchangedObservations = 0;
    }
    return this.snapshot(this.unchangedObservations >= 1);
  }

  snapshot(settled = (
    this.lastObservedGeneration === this.generation
    && this.unchangedObservations >= 1
  )) {
    return {
      settled,
      generation: this.generation,
      units: this.units,
      unchangedObservations: this.unchangedObservations,
    };
  }
}

function idleEvidenceProblem(result, sessionId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      code: 'runner-stop-idle-evidence-invalid',
      detail: 'root object missing',
    };
  }
  const absent = ['state', 'status', 'observable']
    .filter((field) => !hasOwn(result, field));
  if (absent.length) {
    return {
      code: 'runner-stop-idle-evidence-field-missing',
      detail: { fields: absent },
    };
  }
  if (!result.state || typeof result.state !== 'object') {
    return {
      code: 'runner-stop-idle-evidence-field-invalid',
      detail: { field: 'state' },
    };
  }
  const stateAbsent = ['state', 'session_id', 'boot_sequence_at_start']
    .filter((field) => !hasOwn(result.state, field));
  if (stateAbsent.length) {
    return {
      code: 'runner-stop-idle-evidence-field-missing',
      detail: { fields: stateAbsent.map((field) => `state.${field}`) },
    };
  }
  if (result.state.state !== 'checkpoint-confirmed'
    || result.status !== 'checkpoint-confirmed') {
    return {
      code: 'runner-stop-idle-not-observed',
      detail: {
        state: result.state.state,
        status: result.status,
      },
    };
  }
  if (result.state.session_id !== sessionId) {
    return {
      code: 'runner-stop-idle-session-mismatch',
      detail: {
        expected: sessionId,
        observed: result.state.session_id,
      },
    };
  }
  if (!result.observable || typeof result.observable !== 'object') {
    return {
      code: 'runner-stop-idle-evidence-field-invalid',
      detail: { field: 'observable' },
    };
  }
  const observableAbsent = ['ok', 'capsule', 'record', 'transcript']
    .filter((field) => !hasOwn(result.observable, field));
  if (observableAbsent.length) {
    return {
      code: 'runner-stop-idle-evidence-field-missing',
      detail: {
        fields: observableAbsent.map((field) => `observable.${field}`),
      },
    };
  }
  if (result.observable.ok !== true) {
    return {
      code: 'runner-stop-idle-not-observed',
      detail: { field: 'observable.ok' },
    };
  }
  const requiredNested = [
    ['capsule', 'path'],
    ['record', 'capsule_path'],
    ['record', 'offset'],
    ['transcript', 'path'],
    ['transcript', 'size'],
  ];
  const nestedAbsent = requiredNested
    .filter(([parent, field]) => !hasOwn(result.observable[parent], field))
    .map(([parent, field]) => `observable.${parent}.${field}`);
  if (nestedAbsent.length) {
    return {
      code: 'runner-stop-idle-evidence-field-missing',
      detail: { fields: nestedAbsent },
    };
  }
  return null;
}

function tokenProblem(token, transport) {
  if (!token || typeof token !== 'object') {
    return {
      code: 'runner-clear-token-invalid',
      detail: 'root object missing',
    };
  }
  const absent = ['id', 'cycle_id', 'written_at', 'submit']
    .filter((field) => !hasOwn(token, field));
  if (absent.length) {
    return {
      code: 'runner-clear-token-field-missing',
      detail: { fields: absent },
    };
  }
  if (typeof token.submit !== 'function') {
    return {
      code: 'runner-clear-token-field-invalid',
      detail: { field: 'submit' },
    };
  }
  const state = transport?.state;
  if (!state || typeof state !== 'object'
    || !hasOwn(state, 'state')
    || !hasOwn(state, 'clear_intent')) {
    return {
      code: 'runner-clear-intent-field-missing',
      detail: { fields: ['state.state', 'state.clear_intent'] },
    };
  }
  if (state.state !== 'clear-submitted'
    || !state.clear_intent
    || !hasOwn(state.clear_intent, 'written_at')
    || !hasOwn(state.clear_intent, 'submitted')
    || state.clear_intent.submitted !== false) {
    return {
      code: 'runner-clear-intent-not-persisted',
      detail: {
        state: state.state,
        clear_intent: state.clear_intent,
      },
    };
  }
  return null;
}

/**
 * Sole owner of operator and control writes to one node-pty child.
 */
export class ManagedPtyRunner {
  constructor({
    ptyProcess,
    memRoot,
    sessionId = null,
    transport = null,
    transportFactory = null,
    baselineBootSequence = null,
    fsImpl = fs,
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    terminal = process.stdout,
    processLike = process,
    platform = process.platform,
    cwd = process.cwd(),
    homeDir = os.homedir(),
    now = () => new Date(),
    readBootReceiptFn = readBootReceiptObservable,
    readKillSwitchFn = readKillSwitch,
    readCheckpointObservableFn = evaluateCheckpointFreshness,
    log = defaultDiagnostic,
    scheduleTick = (callback, milliseconds) => setInterval(callback, milliseconds),
    clearTick = (handle) => clearInterval(handle),
    scheduleCommit = (callback) => setImmediate(callback),
    clearCommit = (handle) => clearImmediate(handle),
    scheduleWatchdog = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearWatchdog = (handle) => clearTimeout(handle),
    tickMs = DEFAULT_RUNNER_TICK_MS,
    inputHoldTtlMs = DEFAULT_INPUT_HOLD_TTL_MS,
    exitFn = (code) => process.exit(code),
    outerLockHandle = null,
    releaseOuterLockFn = releaseRunnerLock,
  } = {}) {
    if (!ptyProcess || typeof ptyProcess.write !== 'function') {
      throw new TypeError('ptyProcess with write() is required');
    }
    for (const method of ['onData', 'onExit', 'resize', 'kill']) {
      if (typeof ptyProcess?.[method] !== 'function') {
        throw new TypeError(`ptyProcess with ${method}() is required`);
      }
    }
    if (typeof memRoot !== 'string' || memRoot.length === 0) {
      throw new TypeError('memRoot is required');
    }
    if (transport !== null && typeof transport.tick !== 'function') {
      throw new TypeError('transport with tick() is required');
    }
    if (transport === null && typeof transportFactory !== 'function') {
      throw new TypeError('transportFactory is required before session binding');
    }

    this.pty = ptyProcess;
    this.memRoot = memRoot;
    this.sessionId = sessionId || transport?.sessionId || null;
    this.transport = transport;
    this.transportFactory = transportFactory;
    this.baselineBootSequence = baselineBootSequence;
    this.fs = fsImpl;
    this.env = env;
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.terminal = terminal;
    this.processLike = processLike;
    this.platform = platform;
    this.cwd = cwd;
    this.homeDir = homeDir;
    this.now = now;
    this.readBootReceiptFn = readBootReceiptFn;
    this.readKillSwitchFn = readKillSwitchFn;
    this.readCheckpointObservableFn = readCheckpointObservableFn;
    this.log = typeof log === 'function' ? log : defaultDiagnostic;
    this.scheduleTick = scheduleTick;
    this.clearTick = clearTick;
    this.scheduleCommit = scheduleCommit;
    this.clearCommit = clearCommit;
    this.scheduleWatchdog = scheduleWatchdog;
    this.clearWatchdog = clearWatchdog;
    this.tickMs = tickMs;
    this.inputHoldTtlMs = inputHoldTtlMs;
    this.exitFn = exitFn;
    this.outerLockHandle = outerLockHandle;
    this.releaseOuterLockFn = releaseOuterLockFn;

    this.input = new InputOwnershipTracker();
    this.output = new OutputSettlementTracker();
    this.queuedInput = [];
    this.events = [];
    this.lastReason = null;
    this.lastCoreResult = null;
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    this.disableAfterRelease = null;
    this.token = null;
    this.phase = 'idle';
    this.inputHold = false;
    this.controlLockHeld = false;
    this.watchdogArmed = false;
    this.automationEnabled = true;
    this.controlWriteAttempts = 0;
    this.currentControlWriteAttempted = false;
    this.started = false;
    this.closed = false;
    this.childExited = false;
    this.exitCode = null;

    this.tickHandle = null;
    this.commitHandle = null;
    this.watchdogHandle = null;
    this.dataSubscription = null;
    this.exitSubscription = null;
    this.stdinWasRaw = null;

    this._onInput = (data) => this.handleOperatorData(data);
    this._onResize = () => this.resize(
      this.terminal?.columns,
      this.terminal?.rows,
    );
    this._onSigint = () => this.forwardSigint();
    this._onSigterm = () => this.shutdown({ exitCode: 143, killChild: true });
    this._onSighup = () => this.shutdown({ exitCode: 129, killChild: true });
  }

  _event(name, detail = null) {
    this.events.push({ name, detail });
  }

  _diagnostic(message) {
    try { this.log(message); } catch { /* diagnostics never own input */ }
  }

  _writeOperator(data) {
    this._event('operator-write', asText(data));
    return this.pty.write(data);
  }

  _writeControl() {
    this.controlWriteAttempts += 1;
    this.currentControlWriteAttempted = true;
    this._event('control-write', CLEAR_CONTROL_INPUT);
    return this.pty.write(CLEAR_CONTROL_INPUT);
  }

  _writeOutput(data) {
    try { this.stdout?.write?.(data); } catch (error) {
      this._diagnostic(`runner stdout write failed: ${errorText(error)}`);
    }
  }

  _writeError(line) {
    try { this.stderr?.write?.(`${oneLine(line)}\n`); } catch {
      this._diagnostic(line);
    }
  }

  start() {
    if (this.started) return this;
    if (this.closed) throw new Error('runner is closed');
    this.started = true;

    this.dataSubscription = this.pty.onData((data) => this.handleChildData(data));
    this.exitSubscription = this.pty.onExit((event) => {
      const code = Number.isInteger(event?.exitCode)
        ? event.exitCode
        : (
          Number.isInteger(event?.signal)
            ? 128 + event.signal
            : 1
        );
      this.childExited = true;
      this.shutdown({ exitCode: code, killChild: false });
    });

    this.stdin?.on?.('data', this._onInput);
    this.terminal?.on?.('resize', this._onResize);
    this.processLike?.on?.('SIGINT', this._onSigint);
    this.processLike?.on?.('SIGTERM', this._onSigterm);
    this.processLike?.on?.('SIGHUP', this._onSighup);

    if (this.stdin?.isTTY && typeof this.stdin.setRawMode === 'function') {
      this.stdinWasRaw = Boolean(this.stdin.isRaw);
      try {
        this.stdin.setRawMode(true);
        this.stdin.resume?.();
      } catch (error) {
        this._disableAutomation(
          'runner-input-ownership-unavailable',
          errorText(error),
        );
      }
    }

    if (typeof this.scheduleTick === 'function') {
      this.tickHandle = this.scheduleTick(() => {
        try {
          this.tick();
        } catch (error) {
          this._handleScheduledTickError(error);
        }
      }, this.tickMs);
    }
    this._event('runner-started');
    return this;
  }

  handleChildData(data) {
    if (this.closed) return;
    let receiptBeforeData = null;
    if (this.phase === 'submitted' || this.phase === 'submitting') {
      const boot = this._readBoot();
      if (boot.ok && this._isNewClearReceipt(boot.receipt)) {
        receiptBeforeData = boot.receipt;
      }
    }
    this.output.note(data);
    if (receiptBeforeData) {
      this.receiptQualifiedOutput = {
        boot_sequence: receiptBeforeData.boot_sequence,
        generation: this.output.generation,
      };
      this._event('post-receipt-child-output-observed', {
        boot_sequence: receiptBeforeData.boot_sequence,
        generation: this.output.generation,
      });
    }
    this._writeOutput(data);
  }

  _handleScheduledTickError(error) {
    const detail = errorText(error);
    if (this.phase === 'prepared') {
      this._abortPrepared('runner-control-loop-failed', detail);
      return;
    }
    if (this.phase === 'submitted' || this.phase === 'submitting') {
      this.lastReason = {
        code: 'runner-submitted-control-loop-failed',
        detail,
      };
      this._event('submitted-control-loop-failed', this.lastReason);
      this._diagnostic(
        `runner submitted control loop failed; receipt verification remains held: ${detail}`,
      );
      return;
    }
    this._disableAutomation('runner-control-loop-failed', detail);
  }

  handleOperatorData(data) {
    if (this.closed) return;
    const chunk = asPtyInput(data);
    this.input.observe(chunk);
    this._event('operator-input', asText(chunk));

    if (this.inputHold) {
      this.queuedInput.push(chunk);
      if (this.phase === 'prepared') {
        this._abortPrepared('operator-interleave', {
          bytes: typeof chunk === 'string'
            ? Buffer.byteLength(chunk)
            : chunk.byteLength,
        });
      }
      return;
    }
    if (this.queuedInput.length > 0) {
      // A previous release may have met a transient PTY write failure.  Keep
      // later operator bytes behind that retained queue so pass-through order
      // never changes merely because the carrier briefly rejected a write.
      this.queuedInput.push(chunk);
      this._flushQueuedInput();
      return;
    }
    this._writeOperator(chunk);
  }

  resize(columns, rows) {
    if (this.closed) return false;
    if (!Number.isInteger(columns) || columns <= 0
      || !Number.isInteger(rows) || rows <= 0) {
      this.lastReason = {
        code: 'runner-resize-observable-invalid',
        detail: { columns, rows },
      };
      return false;
    }
    if (typeof this.pty.resize !== 'function') {
      this.lastReason = {
        code: 'runner-resize-handler-missing',
        detail: { field: 'pty.resize' },
      };
      return false;
    }
    this._event('resize', { columns, rows });
    this.pty.resize(columns, rows);
    return true;
  }

  forwardSigint() {
    if (this.closed) return false;
    if (this.inputHold || this.platform === 'win32') {
      // node-pty explicitly rejects kill(signal) on Windows.  ETX is the PTY
      // input representation of Ctrl-C and still travels through the runner's
      // sole-writer/input-hold path.  The same path is used on every platform
      // while a transaction is held, so SIGINT cannot interleave with /clear.
      this._event('sigint-forwarded');
      this.handleOperatorData('\u0003');
      return true;
    }
    if (typeof this.pty.kill !== 'function') {
      this.lastReason = {
        code: 'runner-sigint-handler-missing',
        detail: { field: 'pty.kill' },
      };
      return false;
    }
    try {
      this.input.observe('\u0003');
      this._event('sigint-forwarded');
      this.pty.kill('SIGINT');
      return true;
    } catch (error) {
      this.lastReason = {
        code: 'runner-sigint-forward-failed',
        detail: errorText(error),
      };
      return false;
    }
  }

  _readKillSwitch() {
    let observation;
    try {
      observation = this.readKillSwitchFn({
        memRoot: this.memRoot,
        env: this.env,
        fsImpl: this.fs,
      });
    } catch (error) {
      return {
        ok: false,
        problem: {
          code: 'runner-kill-switch-read-failed',
          detail: errorText(error),
        },
      };
    }
    const problem = killSwitchProblem(observation);
    return problem
      ? { ok: false, problem }
      : { ok: true, observation };
  }

  _readBoot() {
    let observation;
    try {
      observation = this.readBootReceiptFn({
        memRoot: this.memRoot,
        fsImpl: this.fs,
      });
    } catch (error) {
      return {
        ok: false,
        code: 'runner-boot-receipt-read-failed',
        detail: errorText(error),
      };
    }
    if (!observation || typeof observation !== 'object'
      || !hasOwn(observation, 'ok')) {
      return {
        ok: false,
        code: 'runner-boot-observable-field-missing',
        detail: { fields: ['ok'] },
      };
    }
    if (observation.ok !== true) {
      return {
        ok: false,
        code: typeof observation.code === 'string'
          ? observation.code
          : 'runner-boot-observable-field-missing',
        detail: hasOwn(observation, 'detail')
          ? observation.detail
          : { fields: ['code', 'detail'] },
      };
    }
    if (!hasOwn(observation, 'receipt')) {
      return {
        ok: false,
        code: 'runner-boot-observable-field-missing',
        detail: { fields: ['receipt'] },
      };
    }
    const problem = validReceiptProblem(observation.receipt);
    if (problem) return { ok: false, ...problem };
    return { ok: true, receipt: observation.receipt };
  }

  _readCurrentCheckpoint() {
    let observation;
    try {
      observation = this.readCheckpointObservableFn({
        memRoot: this.memRoot,
        sessionId: this.sessionId,
        cwd: this.cwd,
        homeDir: this.homeDir,
        fsImpl: this.fs,
      });
    } catch (error) {
      return {
        ok: false,
        code: 'runner-checkpoint-observable-read-failed',
        detail: errorText(error),
      };
    }
    if (!observation || typeof observation !== 'object'
      || !hasOwn(observation, 'ok')) {
      return {
        ok: false,
        code: 'runner-checkpoint-observable-field-missing',
        detail: { fields: ['ok'] },
      };
    }
    if (observation.ok !== true) {
      return {
        ok: false,
        code: typeof observation.code === 'string'
          ? observation.code
          : 'runner-checkpoint-observable-field-missing',
        detail: hasOwn(observation, 'detail')
          ? observation.detail
          : { fields: ['code', 'detail'] },
      };
    }
    const absent = ['capsule', 'record', 'transcript']
      .filter((field) => !hasOwn(observation, field));
    const requiredNested = [
      ['capsule', 'path'],
      ['record', 'capsule_path'],
      ['record', 'offset'],
      ['transcript', 'path'],
      ['transcript', 'size'],
    ];
    const nestedAbsent = requiredNested
      .filter(([parent, field]) => !hasOwn(observation[parent], field))
      .map(([parent, field]) => `${parent}.${field}`);
    if (absent.length || nestedAbsent.length) {
      return {
        ok: false,
        code: 'runner-checkpoint-observable-field-missing',
        detail: { fields: [...absent, ...nestedAbsent] },
      };
    }
    return { ok: true, observation };
  }

  _bindCurrentSession() {
    const boot = this._readBoot();
    if (!boot.ok) {
      this.lastReason = { code: boot.code, detail: boot.detail };
      return { status: 'awaiting-current-boot', ...this.lastReason };
    }
    if (Number.isSafeInteger(this.baselineBootSequence)
      && boot.receipt.boot_sequence <= this.baselineBootSequence) {
      this.lastReason = {
        code: 'runner-current-boot-not-observed',
        detail: {
          baseline: this.baselineBootSequence,
          observed: boot.receipt.boot_sequence,
        },
      };
      return { status: 'awaiting-current-boot', ...this.lastReason };
    }

    let created;
    try {
      created = this.transportFactory(boot.receipt);
    } catch (error) {
      this._disableAutomation(
        'runner-transport-create-failed',
        errorText(error),
      );
      return {
        status: 'disabled',
        code: 'runner-transport-create-failed',
      };
    }
    if (!created || typeof created.tick !== 'function'
      || typeof created.beginClearSubmission !== 'function'
      || typeof created.confirmClearObserved !== 'function'
      || typeof created.close !== 'function') {
      this._disableAutomation(
        'runner-transport-interface-missing',
        {
          fields: [
            'tick',
            'beginClearSubmission',
            'confirmClearObserved',
            'close',
          ],
        },
      );
      return {
        status: 'disabled',
        code: 'runner-transport-interface-missing',
      };
    }
    this.transport = created;
    this.sessionId = boot.receipt.session_id;
    this.baselineBootSequence = boot.receipt.boot_sequence;
    this._event('session-bound', {
      session_id: this.sessionId,
      boot_sequence: this.baselineBootSequence,
    });
    return { status: 'session-bound', receipt: boot.receipt };
  }

  _bootBindingProblem(coreState) {
    const boot = this._readBoot();
    if (!boot.ok) return { code: boot.code, detail: boot.detail };
    if (!coreState || typeof coreState !== 'object') {
      return {
        code: 'runner-current-session-binding-invalid',
        detail: 'core state missing',
      };
    }
    const absent = ['session_id', 'boot_sequence_at_start']
      .filter((field) => !hasOwn(coreState, field));
    if (absent.length) {
      return {
        code: 'runner-current-session-binding-field-missing',
        detail: { fields: absent },
      };
    }
    if (boot.receipt.session_id !== this.sessionId
      || coreState.session_id !== this.sessionId) {
      return {
        code: 'runner-current-session-binding-mismatch',
        detail: {
          runner: this.sessionId,
          core: coreState.session_id,
          receipt: boot.receipt.session_id,
        },
      };
    }
    if (!Number.isSafeInteger(coreState.boot_sequence_at_start)
      || boot.receipt.boot_sequence !== coreState.boot_sequence_at_start) {
      return {
        code: 'runner-current-boot-binding-mismatch',
        detail: {
          required: coreState.boot_sequence_at_start,
          observed: boot.receipt.boot_sequence,
        },
      };
    }
    return null;
  }

  _isNewClearReceipt(receipt) {
    const startSequence = this.transport?.state?.boot_sequence_at_start;
    return receipt?.source === 'clear'
      && Number.isSafeInteger(receipt?.boot_sequence)
      && Number.isSafeInteger(startSequence)
      && receipt.boot_sequence > startSequence;
  }

  _armWatchdog() {
    let handle;
    try {
      handle = this.scheduleWatchdog(
        () => this._watchdogExpired(),
        this.inputHoldTtlMs,
      );
    } catch (error) {
      return {
        ok: false,
        code: 'runner-watchdog-arm-failed',
        detail: errorText(error),
      };
    }
    if (handle === null || handle === undefined) {
      return {
        ok: false,
        code: 'runner-watchdog-arm-failed',
        detail: 'scheduler returned no handle',
      };
    }
    this.watchdogHandle = handle;
    this.watchdogArmed = true;
    this._event('watchdog-armed', { ttl_ms: this.inputHoldTtlMs });
    return { ok: true };
  }

  _clearWatchdog() {
    if (this.watchdogHandle !== null) {
      try { this.clearWatchdog(this.watchdogHandle); } catch { /* already fired */ }
    }
    this.watchdogHandle = null;
    this.watchdogArmed = false;
  }

  _clearCommit() {
    if (this.commitHandle !== null) {
      try { this.clearCommit(this.commitHandle); } catch { /* already running */ }
    }
    this.commitHandle = null;
  }

  _flushQueuedInput() {
    let released = 0;
    while (this.queuedInput.length > 0) {
      const chunk = this.queuedInput[0];
      try {
        this._writeOperator(chunk);
      } catch (error) {
        this.lastReason = {
          code: 'runner-queued-input-write-failed',
          detail: {
            error: errorText(error),
            remaining_chunks: this.queuedInput.length,
          },
        };
        this._event('queued-input-release-failed', this.lastReason);
        this._diagnostic(
          `queued input remains held after PTY write failure: ${errorText(error)}`,
        );
        return false;
      }
      this.queuedInput.shift();
      released += 1;
    }
    if (released) this._event('queued-input-released', { chunks: released });
    return true;
  }

  _releaseInputHold(reason) {
    if (!this.inputHold && !this.controlLockHeld) return;
    this.inputHold = false;
    this.controlLockHeld = false;
    this._event('input-hold-released', reason);
  }

  _abortPrepared(code, detail = null) {
    if (this.phase !== 'prepared') return false;
    this._clearCommit();
    this._clearWatchdog();
    this.token = null;
    this.currentControlWriteAttempted = false;
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    this.phase = 'abandoned';
    this.automationEnabled = false;
    this.lastReason = { code, detail };
    this._event('submission-aborted', this.lastReason);
    this._releaseInputHold(code);
    this._flushQueuedInput();
    return true;
  }

  _disableAutomation(code, detail = null, { announce = true } = {}) {
    const alreadyDisabled = this.automationEnabled === false
      && this.phase === 'disabled';
    this._clearCommit();
    this._clearWatchdog();
    this.token = null;
    this.currentControlWriteAttempted = false;
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    this.automationEnabled = false;
    this.phase = 'disabled';
    this.lastReason = { code, detail };
    this._event('automation-disabled', this.lastReason);
    this._releaseInputHold(code);
    this._flushQueuedInput();
    if (announce && !alreadyDisabled) {
      this._writeError(`${UNMANAGED_AUTO_CLEAR_OFF} reason=${code}`);
    }
  }

  _latchDisableAfterRelease(code, detail = null) {
    if (this.disableAfterRelease === null) {
      this.disableAfterRelease = { code, detail };
      this._event('automation-disable-latched', this.disableAfterRelease);
      this._writeError(
        `${UNMANAGED_AUTO_CLEAR_OFF} pending-resume-release reason=${code}`,
      );
    }
    this.lastReason = { code, detail };
    return {
      status: 'held',
      code,
      detail,
    };
  }

  _watchdogExpired() {
    if (this.closed || !this.inputHold) return;
    this.watchdogHandle = null;
    this.watchdogArmed = false;
    this._disableAutomation('runner-input-hold-watchdog-expired', {
      ttl_ms: this.inputHoldTtlMs,
      phase: this.phase,
    });
  }

  cancel(reason = 'runner-cancelled') {
    if (this.phase === 'prepared') {
      return this._abortPrepared(reason, { source: 'cancellation' });
    }
    if (this.phase === 'submitted' || this.phase === 'submitting') {
      this._latchDisableAfterRelease(reason, { source: 'cancellation' });
      return true;
    }
    if (this.inputHold) {
      this._disableAutomation(reason, { source: 'cancellation' });
      return true;
    }
    this.automationEnabled = false;
    this.phase = 'disabled';
    this.lastReason = { code: reason, detail: { source: 'cancellation' } };
    return true;
  }

  _prepareSubmission(coreResult, outputObservation) {
    const input = this.input.snapshot();
    if (!input.knownEmpty) {
      this.lastReason = {
        code: 'runner-input-not-empty',
        detail: input,
      };
      return { status: 'refused', ...this.lastReason };
    }
    if (input.activePaste || input.activeControl || input.unknown) {
      this.lastReason = {
        code: 'runner-input-sequence-active',
        detail: input,
      };
      return { status: 'refused', ...this.lastReason };
    }
    if (!outputObservation || !hasOwn(outputObservation, 'settled')) {
      this.lastReason = {
        code: 'runner-output-observable-field-missing',
        detail: { fields: ['settled'] },
      };
      return { status: 'refused', ...this.lastReason };
    }
    if (outputObservation.settled !== true) {
      this.lastReason = {
        code: 'runner-child-output-not-settled',
        detail: outputObservation,
      };
      return { status: 'refused', ...this.lastReason };
    }
    const idleProblem = idleEvidenceProblem(coreResult, this.sessionId);
    if (idleProblem) {
      this.lastReason = idleProblem;
      return { status: 'refused', ...idleProblem };
    }
    const bindingProblem = this._bootBindingProblem(coreResult.state);
    if (bindingProblem) {
      this.lastReason = bindingProblem;
      return { status: 'refused', ...bindingProblem };
    }

    let token;
    try {
      token = this.transport.beginClearSubmission();
    } catch (error) {
      this.lastReason = {
        code: error?.code || 'runner-clear-begin-refused',
        detail: error?.detail ?? errorText(error),
      };
      return { status: 'refused', ...this.lastReason };
    }
    const problem = tokenProblem(token, this.transport);
    if (problem) {
      this.token = null;
      this.automationEnabled = false;
      this.phase = 'abandoned';
      this.lastReason = problem;
      return { status: 'refused', ...problem };
    }
    this.token = token;
    this.currentControlWriteAttempted = false;
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    this._event('clear-intent-persisted', { token_id: token.id });

    const watchdog = this._armWatchdog();
    if (!watchdog.ok) {
      this.token = null;
      this.automationEnabled = false;
      this.phase = 'abandoned';
      this.lastReason = { code: watchdog.code, detail: watchdog.detail };
      return { status: 'refused', ...this.lastReason };
    }

    // The input hold/control mutex begins only after all three load-bearing
    // facts exist: core checkpoint confirmation, persisted intent, watchdog.
    this.controlLockHeld = true;
    this.inputHold = true;
    this.phase = 'prepared';
    this._event('input-hold-started');

    try {
      const handle = this.scheduleCommit(() => this.commitClearSubmission());
      if (handle === null || handle === undefined) {
        throw new Error('scheduler returned no handle');
      }
      this.commitHandle = handle;
      this._event('control-commit-scheduled');
    } catch (error) {
      this._abortPrepared('runner-control-commit-schedule-failed', errorText(error));
      return {
        status: 'refused',
        code: 'runner-control-commit-schedule-failed',
        detail: errorText(error),
      };
    }
    return {
      status: 'submission-prepared',
      token_id: token.id,
    };
  }

  commitClearSubmission() {
    this.commitHandle = null;
    if (this.closed || this.phase !== 'prepared') return false;

    const killed = this._readKillSwitch();
    if (!killed.ok) {
      this._abortPrepared(killed.problem.code, killed.problem.detail);
      return false;
    }
    if (killed.observation.active) {
      this._abortPrepared(killed.observation.code, killed.observation.detail);
      return false;
    }
    if (!this.inputHold || !this.controlLockHeld || !this.watchdogArmed) {
      this._abortPrepared('runner-control-input-lock-not-held', {
        input_hold: this.inputHold,
        control_lock: this.controlLockHeld,
        watchdog_armed: this.watchdogArmed,
      });
      return false;
    }

    const input = this.input.snapshot();
    if (!input.knownEmpty || input.activePaste || input.activeControl || input.unknown) {
      this._abortPrepared('runner-input-changed-before-submit', input);
      return false;
    }
    const output = this.output.observe();
    if (output.settled !== true) {
      this._abortPrepared('runner-child-output-became-busy', output);
      return false;
    }
    const checkpoint = this._readCurrentCheckpoint();
    if (!checkpoint.ok) {
      this._abortPrepared(checkpoint.code, checkpoint.detail);
      return false;
    }
    const bindingProblem = this._bootBindingProblem(this.transport?.state);
    if (bindingProblem) {
      this._abortPrepared(bindingProblem.code, bindingProblem.detail);
      return false;
    }

    this.phase = 'submitting';
    this.postSubmitOutputGeneration = this.output.generation;
    try {
      this.token.submit(() => this._writeControl());
      this.phase = 'submitted';
      this._event('submission-committed');
      return true;
    } catch (error) {
      const submitted = this.transport?.state?.clear_intent?.submitted === true
        || this.currentControlWriteAttempted;
      if (submitted) {
        // Persistence or a PTY write may have happened.  Ambiguity is terminal
        // for writes: keep the hold until receipt or watchdog, never retry.
        this.phase = 'submitted';
        this.lastReason = {
          code: 'runner-control-write-ambiguous',
          detail: errorText(error),
        };
        this._event('submission-ambiguous', this.lastReason);
        return false;
      }
      this.phase = 'prepared';
      this._abortPrepared(
        error?.code || 'runner-control-submit-refused',
        error?.detail ?? errorText(error),
      );
      return false;
    }
  }

  _tickSubmitted() {
    const output = this.output.observe();
    if (this.resumeReceipt === null) {
      const boot = this._readBoot();
      if (!boot.ok) {
        this.lastReason = { code: boot.code, detail: boot.detail };
        return { status: 'held', ...this.lastReason };
      }
      const startSequence = this.transport?.state?.boot_sequence_at_start;
      const isNewClear = this._isNewClearReceipt(boot.receipt);
      if (!isNewClear) {
        this.lastReason = {
          code: boot.receipt.source !== 'clear'
            ? 'clear-source-not-observed'
            : 'clear-sequence-not-new',
          detail: {
            source: boot.receipt.source,
            observed: boot.receipt.boot_sequence,
            required_after: startSequence,
          },
        };
        return { status: 'held', ...this.lastReason };
      }

      let observed;
      try {
        observed = this.transport.confirmClearObserved(boot.receipt);
      } catch (error) {
        this.lastReason = {
          code: 'runner-clear-confirm-failed',
          detail: errorText(error),
        };
        this._event('clear-confirm-failed', this.lastReason);
        return { status: 'held', ...this.lastReason };
      }
      this.lastCoreResult = observed;
      if (!observed?.state || !hasOwn(observed.state, 'state')) {
        this.lastReason = {
          code: 'runner-clear-confirm-result-field-missing',
          detail: { fields: ['state.state'] },
        };
        return { status: 'held', ...this.lastReason };
      }
      if (!['clear-verified', 'released'].includes(observed.state.state)) {
        this.lastReason = {
          code: observed.code || 'runner-clear-not-verified',
          detail: observed.detail ?? observed.state.state,
        };
        return { status: 'held', ...this.lastReason };
      }
      this.resumeReceipt = boot.receipt;
      this._event('fresh-clear-receipt-observed', {
        boot_sequence: boot.receipt.boot_sequence,
        session_id: boot.receipt.session_id,
      });
    }

    const freshOutput = this.receiptQualifiedOutput !== null
      && this.receiptQualifiedOutput.boot_sequence
        === this.resumeReceipt?.boot_sequence
      && Number.isSafeInteger(this.receiptQualifiedOutput.generation)
      && output.generation >= this.receiptQualifiedOutput.generation;
    if (!freshOutput || output.settled !== true) {
      this.lastReason = {
        code: !freshOutput
          ? 'runner-fresh-context-output-not-observed'
          : 'runner-fresh-context-output-not-settled',
        detail: {
          output,
          receipt_qualified_output: this.receiptQualifiedOutput,
        },
      };
      return { status: 'held', ...this.lastReason };
    }

    let released = this.lastCoreResult;
    if (released?.state?.state === 'clear-verified') {
      try {
        released = this.transport.tick();
      } catch (error) {
        this.lastReason = {
          code: 'runner-resume-release-failed',
          detail: errorText(error),
        };
        this._event('resume-release-failed', this.lastReason);
        return { status: 'held', ...this.lastReason };
      }
      this.lastCoreResult = released;
    }
    if (released?.state?.state !== 'released') {
      this.lastReason = {
        code: 'runner-resume-release-not-observed',
        detail: { state: released?.state?.state },
      };
      return { status: 'held', ...this.lastReason };
    }

    const receipt = this.resumeReceipt;
    this._clearWatchdog();
    this.token = null;
    this.currentControlWriteAttempted = false;
    this.phase = 'idle';
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    this._releaseInputHold('resume-released');
    this._flushQueuedInput();
    this._event('resume-released');
    this._rebindAfterClear(receipt);
    const disable = this.disableAfterRelease;
    this.disableAfterRelease = null;
    if (disable) {
      this._disableAutomation(disable.code, disable.detail);
    }
    return { status: 'released', state: released.state };
  }

  _rebindAfterClear(receipt) {
    if (!receipt || typeof this.transportFactory !== 'function') return false;
    if (receipt.session_id === this.sessionId) {
      // RUN 1 deliberately keeps `released` terminal until it observes a new
      // session id.  A higher clear receipt without that rotation still proves
      // resume for queued input, but it cannot safely authorize another cycle.
      // Surface that inherited limitation instead of silently pretending the
      // old terminal core was re-armed.
      this.baselineBootSequence = receipt.boot_sequence;
      this._disableAutomation('runner-clear-session-not-rotated', {
        session_id: receipt.session_id,
        boot_sequence: receipt.boot_sequence,
      });
      return false;
    }
    try { this.transport?.close?.(); } catch { /* acquireLock=false carrier */ }
    let next;
    try {
      next = this.transportFactory(receipt);
    } catch (error) {
      this._disableAutomation(
        'runner-transport-rebind-failed',
        errorText(error),
      );
      return false;
    }
    if (!next || typeof next.tick !== 'function'
      || typeof next.beginClearSubmission !== 'function'
      || typeof next.confirmClearObserved !== 'function'
      || typeof next.close !== 'function') {
      this._disableAutomation(
        'runner-transport-interface-missing',
        {
          fields: [
            'tick',
            'beginClearSubmission',
            'confirmClearObserved',
            'close',
          ],
        },
      );
      return false;
    }
    this.transport = next;
    this.sessionId = receipt.session_id;
    this.baselineBootSequence = receipt.boot_sequence;
    this.lastCoreResult = null;
    this._event('session-rebound', {
      session_id: receipt.session_id,
      boot_sequence: receipt.boot_sequence,
    });
    return true;
  }

  tick() {
    if (this.closed) return { status: 'closed' };

    const submitted = this.phase === 'submitted' || this.phase === 'submitting';
    const killed = this._readKillSwitch();
    if (!killed.ok) {
      if (submitted) {
        this._latchDisableAfterRelease(
          killed.problem.code,
          killed.problem.detail,
        );
        return this._tickSubmitted();
      }
      if (this.phase === 'prepared') {
        this._abortPrepared(killed.problem.code, killed.problem.detail);
        return { status: 'disabled', ...killed.problem };
      }
      this._disableAutomation(
        killed.problem.code,
        killed.problem.detail,
      );
      return { status: 'disabled', ...killed.problem };
    }
    if (killed.observation.active) {
      if (submitted) {
        this._latchDisableAfterRelease(
          killed.observation.code,
          killed.observation.detail,
        );
        return this._tickSubmitted();
      }
      if (this.phase === 'prepared') {
        this._abortPrepared(
          killed.observation.code,
          killed.observation.detail,
        );
        return {
          status: 'disabled',
          code: killed.observation.code,
          detail: killed.observation.detail,
        };
      }
      this._disableAutomation(
        killed.observation.code,
        killed.observation.detail,
      );
      return {
        status: 'disabled',
        code: killed.observation.code,
        detail: killed.observation.detail,
      };
    }
    if (!this.inputHold && this.queuedInput.length > 0
      && !this._flushQueuedInput()) {
      return {
        status: 'refused',
        ...(this.lastReason || {
          code: 'runner-queued-input-not-drained',
        }),
      };
    }
    if (!this.automationEnabled) {
      return {
        status: 'disabled',
        ...(this.lastReason || {}),
      };
    }

    if (this.transport === null) {
      const binding = this._bindCurrentSession();
      if (this.transport === null || binding.status !== 'session-bound') return binding;
    }
    if (this.phase === 'submitted' || this.phase === 'submitting') {
      return this._tickSubmitted();
    }
    if (this.phase === 'prepared') {
      return { status: 'submission-prepared' };
    }

    // A manual /clear is never gated.  When it creates a new session while the
    // core is safely idle/released, bind a fresh RUN-1 core before asking it to
    // make another lifecycle decision.  Active cycles remain with the old core
    // long enough for that core to observe and release its own durable intent.
    const currentBoot = this._readBoot();
    if (currentBoot.ok
      && currentBoot.receipt.source === 'clear'
      && Number.isSafeInteger(this.baselineBootSequence)
      && currentBoot.receipt.boot_sequence > this.baselineBootSequence
      && currentBoot.receipt.session_id !== this.sessionId
      && ['idle', 'released'].includes(this.transport?.state?.state)) {
      this._rebindAfterClear(currentBoot.receipt);
      if (!this.automationEnabled) {
        return { status: 'disabled', ...(this.lastReason || {}) };
      }
    }

    const output = this.output.observe();
    let coreResult;
    try {
      coreResult = this.transport.tick();
    } catch (error) {
      this._disableAutomation(
        'runner-transport-tick-failed',
        errorText(error),
      );
      return {
        status: 'disabled',
        code: 'runner-transport-tick-failed',
        detail: errorText(error),
      };
    }
    this.lastCoreResult = coreResult;
    if (!coreResult || typeof coreResult !== 'object'
      || !hasOwn(coreResult, 'state')
      || !coreResult.state
      || !hasOwn(coreResult.state, 'state')) {
      this._disableAutomation(
        'runner-transport-result-field-missing',
        { fields: ['state.state'] },
      );
      return {
        status: 'disabled',
        code: 'runner-transport-result-field-missing',
      };
    }

    if (coreResult.state.state === 'released') {
      const releasedBoot = this._readBoot();
      if (releasedBoot.ok
        && releasedBoot.receipt.source === 'clear'
        && Number.isSafeInteger(this.baselineBootSequence)
        && releasedBoot.receipt.boot_sequence > this.baselineBootSequence
        && releasedBoot.receipt.session_id !== this.sessionId) {
        this._rebindAfterClear(releasedBoot.receipt);
      }
      return coreResult;
    }
    if (coreResult.state.state !== 'checkpoint-confirmed') return coreResult;
    return this._prepareSubmission(coreResult, output);
  }

  snapshot() {
    return {
      automationEnabled: this.automationEnabled,
      phase: this.phase,
      inputHold: this.inputHold,
      controlLockHeld: this.controlLockHeld,
      watchdogArmed: this.watchdogArmed,
      queuedInput: [...this.queuedInput],
      input: this.input.snapshot(),
      output: this.output.snapshot(),
      controlWriteAttempts: this.controlWriteAttempts,
      sessionId: this.sessionId,
      lastReason: this.lastReason,
      events: this.events.map((event) => ({ ...event })),
      exitCode: this.exitCode,
      closed: this.closed,
    };
  }

  _disposeHandlers() {
    if (this.tickHandle !== null) {
      try { this.clearTick(this.tickHandle); } catch { /* already stopped */ }
      this.tickHandle = null;
    }
    this._clearCommit();
    this._clearWatchdog();

    dispose(this.dataSubscription);
    this._event('data-handler-disposed');
    dispose(this.exitSubscription);
    this.dataSubscription = null;
    this.exitSubscription = null;

    this.stdin?.off?.('data', this._onInput);
    this.terminal?.off?.('resize', this._onResize);
    this.processLike?.off?.('SIGINT', this._onSigint);
    this.processLike?.off?.('SIGTERM', this._onSigterm);
    this.processLike?.off?.('SIGHUP', this._onSighup);

    if (this.stdinWasRaw !== null && typeof this.stdin?.setRawMode === 'function') {
      try { this.stdin.setRawMode(this.stdinWasRaw); } catch { /* terminal closed */ }
    }
  }

  shutdown({
    exitCode = 0,
    killChild = true,
  } = {}) {
    if (this.closed) return false;
    this.closed = true;
    this.exitCode = Number.isInteger(exitCode) ? exitCode : 1;

    // Disposal before kill is load-bearing on ConPTY.  Leaving the data
    // carrier attached while the parent lingers after p.kill() produces a
    // helper AttachConsole stack trace that looks like a real harness failure.
    this._disposeHandlers();
    try { this.transport?.close?.(); } catch { /* acquireLock=false carrier */ }
    if (this.outerLockHandle) {
      try {
        this.releaseOuterLockFn(this.outerLockHandle, { fsImpl: this.fs });
      } catch { /* stale lock is reclaimable on next start */ }
      this.outerLockHandle = null;
    }

    if (killChild && !this.childExited && typeof this.pty.kill === 'function') {
      try {
        this._event('child-kill');
        this.pty.kill();
      } catch (error) {
        this._diagnostic(`runner child teardown failed: ${errorText(error)}`);
      }
    }
    this._event('runner-exit', { exitCode: this.exitCode });
    this.exitFn(this.exitCode);
    return true;
  }
}

function normalizedPtyModule(moduleValue) {
  const spawn = moduleValue?.spawn || moduleValue?.default?.spawn;
  return typeof spawn === 'function' ? { spawn } : null;
}

/**
 * Optional runtime load.  Failure is data for the launcher, never an import
 * crash at module evaluation time.
 */
export function loadNodePty({
  requireFn = optionalRequire,
} = {}) {
  try {
    const normalized = normalizedPtyModule(requireFn('node-pty'));
    if (!normalized) {
      return {
        ok: false,
        code: 'node-pty-interface-missing',
        detail: { field: 'spawn' },
      };
    }
    return { ok: true, module: normalized };
  } catch (error) {
    return {
      ok: false,
      code: 'node-pty-load-failed',
      detail: errorText(error),
    };
  }
}

const WINDOWS_SHIM_COMMAND_ENV = '__AIGENT_PTY_SHIM_COMMAND';
const WINDOWS_SHIM_ARG_ENV_PREFIX = '__AIGENT_PTY_SHIM_ARG_';

function quoteWindowsArg(value) {
  const rendered = String(value);
  let quoted = '"';
  let slashes = 0;
  for (const character of rendered) {
    if (character === '\\') {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${'\\'.repeat((slashes * 2) + 1)}"`;
      slashes = 0;
      continue;
    }
    quoted += `${'\\'.repeat(slashes)}${character}`;
    slashes = 0;
  }
  return `${quoted}${'\\'.repeat(slashes * 2)}"`;
}

function windowsPathValue(env) {
  return env.Path || env.PATH || env.path || '';
}

function resolveWindowsExecutable(command, env, fsImpl = fs) {
  const rendered = String(command);
  const hasDirectory = /[\\/]/.test(rendered);
  const extensions = path.win32.extname(rendered)
    ? ['']
    : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean);
  const directories = hasDirectory
    ? ['']
    : windowsPathValue(env).split(';').filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = hasDirectory
        ? `${rendered}${extension}`
        : path.win32.join(directory, `${rendered}${extension}`);
      try {
        if (fsImpl.statSync(candidate).isFile()) return candidate;
      } catch { /* continue through PATH/PATHEXT */ }
    }
  }
  return null;
}

function unwrapStandardNodeCmdShim(shimPath, args, env, fsImpl = fs) {
  let source;
  try {
    source = fsImpl.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  if (typeof source !== 'string' || source.length > 64 * 1024) return null;

  const shimDirectory = path.win32.dirname(shimPath);
  let target = null;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(
      /(?:"(?:%~dp0[\\/]node\.exe|%_prog%|%NODE_EXE%)"|(?:^|[&\s])node(?:\.exe)?)\s+"(?:%~dp0|%dp0%)[\\/]([^"\r\n]+\.(?:cjs|mjs|js))"\s+%\*\s*$/i,
    );
    if (!match) continue;
    const candidate = path.win32.resolve(shimDirectory, match[1]);
    const boundary = `${path.win32.resolve(shimDirectory)}\\`.toLowerCase();
    if (!candidate.toLowerCase().startsWith(boundary)) continue;
    try {
      if (!fsImpl.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    target = candidate;
    break;
  }
  if (!target) return null;

  const localNode = path.win32.join(shimDirectory, 'node.exe');
  let nodeExecutable = null;
  try {
    if (fsImpl.statSync(localNode).isFile()) nodeExecutable = localNode;
  } catch { /* resolve node through PATH below */ }
  nodeExecutable ||= resolveWindowsExecutable('node', env, fsImpl);
  if (!nodeExecutable || !/\.(?:com|exe)$/i.test(nodeExecutable)) return null;
  return {
    command: nodeExecutable,
    args: [target, ...args],
  };
}

/**
 * ConPTY cannot CreateProcess an npm .cmd shim directly.  Hosting through the
 * platform command processor preserves the ordinary `claude` PATH behavior.
 */
export function resolvePtyCommand({
  command = 'claude',
  args = [],
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
} = {}) {
  if (platform !== 'win32') return { command, args: [...args] };
  const resolved = resolveWindowsExecutable(command, env, fsImpl);
  if (resolved && /\.(?:com|exe)$/i.test(resolved)) {
    return { command: resolved, args: [...args] };
  }
  if (resolved && /\.cmd$/i.test(resolved)) {
    const unwrapped = unwrapStandardNodeCmdShim(
      resolved,
      args,
      env,
      fsImpl,
    );
    if (unwrapped) return unwrapped;
  }
  // cmd.exe expands percent-delimited names even inside quotes.  Putting raw
  // argv on its command line would therefore corrupt values such as `100%` or
  // `%PATH%`.  Expand one private environment reference per token instead:
  // percent characters introduced by that expansion are not recursively
  // expanded, while /v:off preserves literal exclamation marks.
  const commandEnv = {
    ...env,
    [WINDOWS_SHIM_COMMAND_ENV]: quoteWindowsArg(resolved || command),
  };
  const references = [`%${WINDOWS_SHIM_COMMAND_ENV}%`];
  args.forEach((value, index) => {
    const name = `${WINDOWS_SHIM_ARG_ENV_PREFIX}${index}`;
    commandEnv[name] = quoteWindowsArg(value);
    references.push(`%${name}%`);
  });
  const commandLine = references.join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    // node-pty accepts a pre-escaped command-line string on Windows.  The outer
    // quote pair belongs to cmd /s /c; each inner token remains individually
    // quoted so spaces in the npm shim path and fixed launcher arguments survive.
    args: `/d /v:off /s /c "${commandLine}"`,
    env: commandEnv,
  };
}

export function runUnmanaged({
  command = 'claude',
  args = [],
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  spawnSyncFn = spawnSync,
} = {}) {
  const resolved = resolvePtyCommand({
    command,
    args,
    platform,
    env,
    fsImpl,
  });
  const windowsVerbatimArguments = platform === 'win32'
    && typeof resolved.args === 'string';
  const spawnArgs = windowsVerbatimArguments
    ? [resolved.args]
    : resolved.args;
  const result = spawnSyncFn(resolved.command, spawnArgs, {
    cwd,
    env: resolved.env || env,
    stdio: 'inherit',
    shell: false,
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (result?.error) return 1;
  if (Number.isInteger(result?.status)) return result.status;
  const signalNumber = typeof result?.signal === 'string'
    ? os.constants?.signals?.[result.signal]
    : null;
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

function baselineSequence(observation) {
  return observation?.ok === true
    && Number.isSafeInteger(observation.receipt?.boot_sequence)
    ? observation.receipt.boot_sequence
    : null;
}

function baselineObservationProblem(observation) {
  if (!observation || typeof observation !== 'object'
    || !hasOwn(observation, 'ok')) {
    return {
      code: 'runner-boot-baseline-field-missing',
      detail: { fields: ['ok'] },
    };
  }
  if (typeof observation.ok !== 'boolean') {
    return {
      code: 'runner-boot-baseline-field-invalid',
      detail: { field: 'ok' },
    };
  }
  if (observation.ok) {
    if (!hasOwn(observation, 'receipt')) {
      return {
        code: 'runner-boot-baseline-field-missing',
        detail: { fields: ['receipt'] },
      };
    }
    return validReceiptProblem(observation.receipt);
  }
  const absent = ['code', 'detail']
    .filter((field) => !hasOwn(observation, field));
  if (absent.length) {
    return {
      code: 'runner-boot-baseline-field-missing',
      detail: { fields: absent },
    };
  }
  if (observation.code !== 'runner-boot-receipt-missing') {
    return {
      code: 'runner-boot-baseline-unavailable',
      detail: {
        observed_code: observation.code,
        observed_detail: observation.detail,
      },
    };
  }
  return null;
}

/**
 * Start either the managed carrier or the explicit unmanaged fallback.
 */
export function runPtySession({
  childArgs = [],
  command = 'claude',
  root = process.cwd(),
  cwd = root,
  env = process.env,
  fsImpl = fs,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  processLike = process,
  platform = process.platform,
  homeDir = os.homedir(),
  forceUnmanaged = false,
  loadNodePtyFn = loadNodePty,
  runUnmanagedFn = runUnmanaged,
  acquireRunnerLockFn = acquireRunnerLock,
  releaseRunnerLockFn = releaseRunnerLock,
  readKillSwitchFn = readKillSwitch,
  readBootReceiptFn = readBootReceiptObservable,
  createTransportFn = (options) => new AutoClearTransport(options),
  log = defaultDiagnostic,
  exitFn = (code) => process.exit(code),
  runnerOptions = {},
} = {}) {
  const memoryRoot = resolveMemoryRoot(root);
  if (forceUnmanaged) {
    return {
      mode: 'unmanaged',
      exitCode: runUnmanagedFn({
        command,
        args: childArgs,
        cwd,
        env,
        platform,
        fsImpl,
      }),
    };
  }

  let initialKill;
  try {
    initialKill = readKillSwitchFn({
      memRoot: memoryRoot,
      env,
      fsImpl,
    });
  } catch (error) {
    initialKill = {
      active: true,
      code: 'kill-switch-read-failed',
      detail: errorText(error),
    };
  }
  const initialKillProblem = killSwitchProblem(initialKill);
  if (initialKillProblem || initialKill.active) {
    const reason = initialKillProblem?.code || initialKill.code;
    try { stderr.write(`${UNMANAGED_AUTO_CLEAR_OFF} reason=${reason}\n`); } catch { /* visible if possible */ }
    return {
      mode: 'unmanaged',
      code: reason,
      exitCode: runUnmanagedFn({
        command,
        args: childArgs,
        cwd,
        env,
        platform,
        fsImpl,
      }),
    };
  }

  let loaded;
  try {
    loaded = loadNodePtyFn();
  } catch (error) {
    loaded = {
      ok: false,
      code: 'node-pty-load-failed',
      detail: errorText(error),
    };
  }
  if (!loaded?.ok || typeof loaded?.module?.spawn !== 'function') {
    try { stderr.write(`${DEGRADED_NODE_PTY_LINE}\n`); } catch { /* visible if possible */ }
    return {
      mode: 'degraded',
      code: DEGRADED_NODE_PTY,
      exitCode: runUnmanagedFn({
        command,
        args: childArgs,
        cwd,
        env,
        platform,
        fsImpl,
      }),
    };
  }

  let lockHandle;
  try {
    lockHandle = acquireRunnerLockFn({
      memRoot: memoryRoot,
      fsImpl,
      log,
    });
  } catch (error) {
    const code = error instanceof RunnerLockError || error?.code === 'ERUNNERLIVE'
      ? (error.exitCode || 1)
      : 1;
    try { stderr.write(`${oneLine(error?.message || error)}\n`); } catch { /* visible if possible */ }
    return {
      mode: 'refused',
      code: error?.code || 'runner-lock-failed',
      exitCode: code,
    };
  }

  let beforeBoot;
  try {
    beforeBoot = readBootReceiptFn({ memRoot: memoryRoot, fsImpl });
  } catch (error) {
    try { releaseRunnerLockFn(lockHandle, { fsImpl }); } catch { /* reclaimable */ }
    try {
      stderr.write(`PTY runner boot baseline failed: ${oneLine(errorText(error))}\n`);
    } catch { /* visible if possible */ }
    return {
      mode: 'failed',
      code: 'runner-boot-baseline-failed',
      exitCode: 1,
    };
  }
  const baselineProblem = baselineObservationProblem(beforeBoot);
  if (baselineProblem) {
    try { releaseRunnerLockFn(lockHandle, { fsImpl }); } catch { /* reclaimable */ }
    try {
      stderr.write(`PTY runner boot baseline invalid: ${baselineProblem.code}\n`);
    } catch { /* visible if possible */ }
    return {
      mode: 'failed',
      code: baselineProblem.code,
      detail: baselineProblem.detail,
      exitCode: 1,
    };
  }
  let resolved;
  try {
    resolved = resolvePtyCommand({
      command,
      args: childArgs,
      platform,
      env,
      fsImpl,
    });
  } catch (error) {
    try { releaseRunnerLockFn(lockHandle, { fsImpl }); } catch { /* reclaimable */ }
    try {
      stderr.write(`PTY runner command resolution failed: ${oneLine(errorText(error))}\n`);
    } catch { /* visible if possible */ }
    return {
      mode: 'failed',
      code: 'runner-command-resolution-failed',
      exitCode: 1,
    };
  }
  let ptyProcess;
  try {
    ptyProcess = loaded.module.spawn(resolved.command, resolved.args, {
      name: env.TERM || 'xterm-256color',
      cols: Number.isInteger(stdout?.columns) && stdout.columns > 0
        ? stdout.columns
        : 80,
      rows: Number.isInteger(stdout?.rows) && stdout.rows > 0
        ? stdout.rows
        : 24,
      cwd,
      env: resolved.env || env,
    });
  } catch (error) {
    try { releaseRunnerLockFn(lockHandle, { fsImpl }); } catch { /* reclaimable */ }
    try { stderr.write(`PTY runner spawn failed: ${oneLine(errorText(error))}\n`); } catch { /* visible if possible */ }
    return {
      mode: 'failed',
      code: 'runner-pty-spawn-failed',
      exitCode: 1,
    };
  }

  const transportFactory = (receipt) => createTransportFn({
    memRoot: memoryRoot,
    sessionId: receipt.session_id,
    cwd,
    homeDir,
    fsImpl,
    env,
    log,
    acquireLock: false,
  });
  let runner;
  try {
    runner = new ManagedPtyRunner({
      ptyProcess,
      memRoot: memoryRoot,
      transportFactory,
      baselineBootSequence: baselineSequence(beforeBoot),
      fsImpl,
      env,
      stdin,
      stdout,
      stderr,
      terminal: stdout,
      processLike,
      platform,
      cwd,
      homeDir,
      readBootReceiptFn,
      readKillSwitchFn,
      log,
      exitFn,
      outerLockHandle: lockHandle,
      releaseOuterLockFn: releaseRunnerLockFn,
      ...runnerOptions,
    });
    runner.start();
  } catch (error) {
    try { runner?._disposeHandlers?.(); } catch { /* best-effort start unwind */ }
    try {
      stderr.write(`PTY runner start failed: ${oneLine(errorText(error))}\n`);
    } catch { /* visible if possible */ }
    try { releaseRunnerLockFn(lockHandle, { fsImpl }); } catch { /* reclaimable */ }
    try { ptyProcess.kill(); } catch { /* no carrier may survive failed start */ }
    const promptExit = typeof runner?.exitFn === 'function'
      ? runner.exitFn
      : exitFn;
    promptExit(1);
    return {
      mode: 'failed',
      code: 'runner-start-failed',
      exitCode: 1,
    };
  }
  return { mode: 'managed', runner, exitCode: null };
}

export function parseRunnerArguments(argv = process.argv.slice(2)) {
  const values = [...argv];
  const separator = values.indexOf('--');
  if (separator >= 0) return values.slice(separator + 1);
  return values;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  const argvPath = path.resolve(process.argv[1]);
  return process.platform === 'win32'
    ? modulePath.toLowerCase() === argvPath.toLowerCase()
    : modulePath === argvPath;
}

if (isMainModule()) {
  const root = process.env.AIGENT_HOME
    || process.env.AIGENT_ROOT
    || process.cwd();
  const result = runPtySession({
    childArgs: parseRunnerArguments(),
    root,
    cwd: root,
  });
  if (result.mode !== 'managed') process.exitCode = result.exitCode;
}
