// transport-conformance.mjs -- reusable observable contract for managed PTYs.
//
// WHY THIS EXISTS: a transport wrapper can look correct while moving one guard
// to the wrong side of the PTY write, retrying an ambiguous /clear, or losing
// bytes during an input hold.  Those are integration failures, not properties
// of one implementation.  This module therefore registers the same black-box
// contract against any wrapper that supplies the semantic adapter below.
//
// Importing this file registers no tests.  A public runner (or a downstream
// wrapper) explicitly calls defineTransportConformanceSuite(adapter).
//
// Adapter contract
// ----------------
// adapter.createHarness(options) starts one isolated scripted session and
// returns a harness.  It may return a promise.  The suite passes these options:
//
//   mode: 'managed' | 'unmanaged'       reference pass-through selection
//   ptyLoad: 'ok' | 'fail'              optional node-pty loader outcome
//   lockState: 'free' | 'live' | 'stale'
//   pauseBeforeControlWrite: boolean    expose the deterministic pre-write seam
//   teardownShape: 'normal' | 'kill-then-linger'
//
// A harness supplies the following semantic methods (sync or async):
//
//   primeAuthorized()
//     Drive the real/shared transport core to checkpoint-confirmed and install
//     current boot/session, Stop-idle, settled-output, empty-input, and held
//     control-lock observations.  It must not submit /clear.
//   setGuard(name, value)
//     Change one external guard.  Names used here are outputSettled, stopIdle,
//     sessionBinding, controlLock, inputState, checkpoint, and killSwitch.
//   attemptAutomaticClear()
//     Enter the runner's automatic submission path.  With
//     pauseBeforeControlWrite, it persists intent, arms the watchdog, begins
//     the input hold, and leaves the one scheduled commit pending.
//   forceDuplicateAttempt()
//     Exercise the same submission entry point a duplicate scheduler call
//     would reach; return (or record) the core refusal without writing the PTY.
//   drive()
//     Run one deterministic control-loop turn (never a wall-clock sleep).
//   flushControl()
//     Run the pending control-input commit, if any.
//   operator(bytes), childOutput(bytes), resize(cols, rows), sigint(),
//   childExit(code), observeClearReceipt(kind), cancel(), fireWatchdog(),
//   shutdown(), flushHelper(), snapshot(), persistentState(which), cleanup().
//
// observeClearReceipt() receives 'fresh', 'stale', or 'wrong-source'.
// shutdown()/flushHelper() model the node-pty kill-then-linger reproduction.
// persistentState() receives 'baseline' (captured before runner start) or
// 'current'; it returns only checkpoint/recovery sentinel content.
// cleanup() is optional; all other methods are required only by the scenarios
// that call them.
//
// snapshot() returns the normalized observable record:
//
//   {
//     automaticWrites: Array<string|Buffer|Uint8Array>, // one item per PTY call
//     childWrites:     Array<string|Buffer|Uint8Array>, // all child input calls
//     parentWrites:    Array<string|Buffer|Uint8Array>, // child output forwarded
//     holdActive: boolean,
//     queuedInputBytes: number,
//     watchdogArmed: boolean,
//     lastDecision: { code?: string } | null,
//     coreState: string,
//     clearIntent: object | null,
//     resizes: Array<{ cols: number, rows: number } | [number, number]>,
//     signals: string[],
//     runnerExitCode: number | null,
//     managed: boolean,
//     managedSpawnCount: number,
//     unmanagedSpawnCount: number,
//     degradedState: string | null,
//     logs: string[],
//     helperNoise: string[],
//     childKilled: boolean,
//     events: string[]
//   }
//
// The fake behind the adapter should record these event names (descriptive
// suffixes are fine): clear-intent-persisted, watchdog-armed,
// input-hold-started, data-handler-disposed, child-killed, runner-exited.
// Recording bytes by PTY write call, rather than concatenating them, is what
// lets this suite prove that /clear is one atomic control input.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const DEFAULT_CLEAR = Buffer.from('/clear\r');
const DEFAULT_MANUAL = Buffer.from('/clear\r');
const DEFAULT_CHILD_OUTPUT = Buffer.from('\u001b[32mready\u001b[0m\r\n');
const DEFAULT_QUEUED = Buffer.from('after-clear\r');
const DEFAULT_EXIT_CODE = 23;

function requireMethod(target, name) {
  assert.equal(
    typeof target?.[name],
    'function',
    `transport conformance adapter is missing harness.${name}()`,
  );
  return target[name].bind(target);
}

async function call(target, name, ...args) {
  return requireMethod(target, name)(...args);
}

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value);
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  if (value && Object.prototype.hasOwnProperty.call(value, 'bytes')) {
    return bytes(value.bytes);
  }
  throw new TypeError(`conformance byte record has unsupported shape: ${typeof value}`);
}

function byteRecords(value, field) {
  assert.ok(Array.isArray(value), `snapshot.${field} must be an array`);
  return value.map(bytes);
}

function hexRecords(value, field) {
  return byteRecords(value, field).map((entry) => entry.toString('hex'));
}

function joinedBytes(value, field) {
  return Buffer.concat(byteRecords(value, field));
}

function textLines(value) {
  if (!Array.isArray(value)) return '';
  return value.map((entry) => {
    try { return bytes(entry).toString('utf8'); } catch { return String(entry); }
  }).join('\n');
}

function decisionCode(observation) {
  const candidate = observation?.lastDecision?.code
    ?? observation?.decisionCode
    ?? observation?.code
    ?? null;
  return typeof candidate === 'string' ? candidate : '';
}

function assertNamedDecision(observation, pattern, label) {
  const code = decisionCode(observation);
  assert.ok(code, `${label} must surface a named decision code`);
  assert.match(code, pattern, `${label} surfaced unexpected code ${JSON.stringify(code)}`);
}

function eventIndex(events, pattern) {
  if (!Array.isArray(events)) return -1;
  return events.findIndex((entry) => pattern.test(String(entry)));
}

function assertNoAutomaticWrite(observation, label) {
  assert.deepEqual(
    hexRecords(observation.automaticWrites, 'automaticWrites'),
    [],
    `${label} must write zero automatic-control bytes`,
  );
}

function assertReleased(observation, label) {
  assert.equal(observation.holdActive, false, `${label} must release the input hold`);
  assert.equal(
    observation.watchdogArmed,
    false,
    `${label} must disarm the watchdog on normal/abort release`,
  );
}

function passThroughProjection(observation) {
  assert.ok(Array.isArray(observation.resizes), 'snapshot.resizes must be an array');
  assert.ok(Array.isArray(observation.signals), 'snapshot.signals must be an array');
  return {
    childWrites: hexRecords(observation.childWrites, 'childWrites'),
    parentWrites: hexRecords(observation.parentWrites, 'parentWrites'),
    resizes: observation.resizes,
    signals: observation.signals,
    runnerExitCode: observation.runnerExitCode,
  };
}

async function makeHarness(t, adapter, options) {
  const harness = await adapter.createHarness(options);
  assert.ok(harness && typeof harness === 'object', 'createHarness() must return a harness');
  if (typeof harness.cleanup === 'function') {
    t.after(async () => harness.cleanup());
  }
  return harness;
}

async function snapshot(harness) {
  const observed = await call(harness, 'snapshot');
  assert.ok(observed && typeof observed === 'object', 'snapshot() must return an object');
  return observed;
}

async function preparePending(harness) {
  await call(harness, 'primeAuthorized');
  await call(harness, 'attemptAutomaticClear');
  const observed = await snapshot(harness);
  assert.equal(observed.holdActive, true, 'prepared transaction must own the input hold');
  assert.equal(observed.watchdogArmed, true, 'prepared transaction must arm its watchdog');
  assert.ok(observed.clearIntent, 'prepared transaction must expose persisted clear intent');
  assertNoAutomaticWrite(observed, 'prepared transaction before commit');

  const intent = eventIndex(observed.events, /clear[-_ ]intent.*persist|intent.*persist/i);
  const watchdog = eventIndex(observed.events, /watchdog.*arm/i);
  const hold = eventIndex(observed.events, /(?:input[-_ ])?hold.*(?:start|begin|active)/i);
  assert.ok(intent >= 0, 'trace must record clear-intent persistence');
  assert.ok(watchdog >= 0, 'trace must record watchdog arming');
  assert.ok(hold >= 0, 'trace must record input-hold start');
  assert.ok(
    intent < hold && watchdog < hold,
    'input hold may begin only after intent persistence and watchdog arming',
  );
  return observed;
}

/**
 * Register the standalone transport contract against one implementation.
 *
 * This function is intentionally the only registration site in the module:
 * importing transport-conformance.mjs alone has no node:test side effects.
 */
export function defineTransportConformanceSuite(adapter, options = {}) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('transport conformance adapter object is required');
  }
  if (typeof adapter.createHarness !== 'function') {
    throw new TypeError('transport conformance adapter.createHarness() is required');
  }

  const name = String(options.name || adapter.name || 'managed transport');
  const automaticClear = bytes(options.automaticClear ?? DEFAULT_CLEAR);
  const manualClear = bytes(options.manualClear ?? DEFAULT_MANUAL);
  const childOutput = bytes(options.childOutput ?? DEFAULT_CHILD_OUTPUT);
  const queuedAfterClear = bytes(options.queuedAfterClear ?? DEFAULT_QUEUED);
  const childExitCode = Number.isInteger(options.childExitCode)
    ? options.childExitCode
    : DEFAULT_EXIT_CODE;
  const degradedPattern = options.degradedPattern
    ?? /(?:DEGRADED.*node-pty|node-pty.*(?:unavailable|load|missing))/i;

  describe(`${name}: transport conformance`, { concurrency: false }, () => {
    test('1. concatenation: nonempty, pasted, partial-control, and unknown input fail closed', async (t) => {
      const cases = [
        ['unsubmitted operator text', Buffer.from('draft'), null, /input|empty|operator/i],
        ['active bracketed paste', Buffer.from('\u001b[200~draft'), null, /paste|input|empty/i],
        ['active control sequence', Buffer.from('\u001b['), null, /control|input|empty/i],
        ['unknown input ownership', null, 'unknown', /unknown|input|empty/i],
        ['independent active-paste guard', null, 'active-paste-only', /paste|input/i],
        ['independent active-control guard', null, 'active-control-only', /control|input/i],
        ['independent unknown-input guard', null, 'unknown-only', /unknown|input/i],
      ];

      for (const [label, operatorBytes, inputState, reason] of cases) {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await call(harness, 'primeAuthorized');
        if (inputState) await call(harness, 'setGuard', 'inputState', inputState);
        if (operatorBytes) await call(harness, 'operator', operatorBytes);
        await call(harness, 'attemptAutomaticClear');
        await call(harness, 'flushControl');

        const observed = await snapshot(harness);
        assertNoAutomaticWrite(observed, label);
        assertNamedDecision(observed, reason, label);
        if (operatorBytes) {
          assert.deepEqual(
            joinedBytes(observed.childWrites, 'childWrites'),
            operatorBytes,
            `${label} must pass through unchanged and never gain an appended /clear`,
          );
        }
      }
    });

    test('2. busy seat: output, Stop-idle, session, and control-lock guards fail closed', async (t) => {
      const cases = [
        ['unsettled child output', 'outputSettled', false, /output|settled|busy/i],
        ['missing Stop-idle evidence', 'stopIdle', 'missing', /stop|idle/i],
        ['stale boot/session binding', 'sessionBinding', 'stale', /session|boot|binding/i],
        ['control-input lock not held', 'controlLock', false, /control|lock/i],
      ];

      for (const [label, guard, value, reason] of cases) {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await call(harness, 'primeAuthorized');
        await call(harness, 'setGuard', guard, value);
        await call(harness, 'attemptAutomaticClear');
        await call(harness, 'flushControl');

        const observed = await snapshot(harness);
        assertNoAutomaticWrite(observed, label);
        assertNamedDecision(observed, reason, label);
      }

      {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await preparePending(harness);
        await call(harness, 'setGuard', 'outputSettled', false);
        await call(harness, 'flushControl');
        const observed = await snapshot(harness);
        assertReleased(observed, 'output becoming busy before commit');
        assertNoAutomaticWrite(observed, 'output becoming busy before commit');
        assertNamedDecision(observed, /output|busy|settled/i, 'commit-time output guard');
      }

      {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await preparePending(harness);
        await call(harness, 'setGuard', 'sessionBinding', 'stale');
        await call(harness, 'flushControl');
        const observed = await snapshot(harness);
        assertReleased(observed, 'session changing before commit');
        assertNoAutomaticWrite(observed, 'session changing before commit');
        assertNamedDecision(observed, /session|boot|binding/i, 'commit-time session guard');
      }
    });

    test('3. submit accepted without a new clear receipt stays held and never rewrites', async (t) => {
      const harness = await makeHarness(t, adapter, {
        mode: 'managed',
        ptyLoad: 'ok',
        lockState: 'free',
        pauseBeforeControlWrite: true,
      });
      await preparePending(harness);
      await call(harness, 'flushControl');

      let observed = await snapshot(harness);
      assert.deepEqual(
        hexRecords(observed.automaticWrites, 'automaticWrites'),
        [automaticClear.toString('hex')],
        '/clear must be exactly one atomic PTY write',
      );
      assert.equal(observed.holdActive, true, 'accepted submission must hold until observed clear');

      await call(harness, 'childOutput', childOutput);
      for (let turn = 0; turn < 3; turn += 1) {
        await call(harness, 'drive');
        await call(harness, 'flushControl');
      }
      observed = await snapshot(harness);
      assert.deepEqual(
        hexRecords(observed.automaticWrites, 'automaticWrites'),
        [automaticClear.toString('hex')],
        'absence of a fresh receipt must never retry /clear',
      );
      assert.equal(observed.holdActive, true, 'no receipt must keep the cycle held');

      await call(harness, 'operator', queuedAfterClear);
      observed = await snapshot(harness);
      assert.equal(observed.holdActive, true);
      assert.ok(
        Number.isInteger(observed.queuedInputBytes)
          && observed.queuedInputBytes >= queuedAfterClear.byteLength,
        'post-submit operator input must be queued, not dropped or sent to the old context',
      );

      await call(harness, 'observeClearReceipt', 'wrong-source');
      for (let turn = 0; turn < 3; turn += 1) await call(harness, 'drive');
      observed = await snapshot(harness);
      assert.equal(observed.holdActive, true, 'a higher non-clear receipt cannot release the hold');
      assert.deepEqual(
        hexRecords(observed.automaticWrites, 'automaticWrites'),
        [automaticClear.toString('hex')],
      );

      await call(harness, 'observeClearReceipt', 'stale');
      for (let turn = 0; turn < 3; turn += 1) await call(harness, 'drive');
      observed = await snapshot(harness);
      assert.equal(observed.holdActive, true, 'a stale receipt cannot release the hold');
      assert.deepEqual(
        hexRecords(observed.automaticWrites, 'automaticWrites'),
        [automaticClear.toString('hex')],
      );

      await call(harness, 'observeClearReceipt', 'fresh');
      for (let turn = 0; turn < 3; turn += 1) await call(harness, 'drive');
      observed = await snapshot(harness);
      assertReleased(observed, 'fresh source=clear receipt');
      assert.equal(observed.queuedInputBytes, 0, 'release must drain all queued input');
      assert.ok(
        joinedBytes(observed.childWrites, 'childWrites').includes(queuedAfterClear),
        'queued input must reach the fresh context after release',
      );
      assert.deepEqual(
        hexRecords(observed.automaticWrites, 'automaticWrites'),
        [automaticClear.toString('hex')],
        'successful observation must not create another control write',
      );
    });

    test('4. duplicate clear: active intent is refused by the core before PTY IO', async (t) => {
      const harness = await makeHarness(t, adapter, {
        mode: 'managed',
        ptyLoad: 'ok',
        lockState: 'free',
        pauseBeforeControlWrite: true,
      });
      await preparePending(harness);
      await call(harness, 'flushControl');
      const before = await snapshot(harness);

      const result = await call(harness, 'forceDuplicateAttempt');
      await call(harness, 'flushControl');
      const after = await snapshot(harness);
      const code = typeof result?.code === 'string' ? result.code : decisionCode(after);
      assert.equal(code, 'EDUPLICATE_CLEAR', 'core must name the active-intent refusal');
      assert.deepEqual(
        hexRecords(after.automaticWrites, 'automaticWrites'),
        hexRecords(before.automaticWrites, 'automaticWrites'),
        'duplicate core refusal must write zero additional PTY bytes',
      );
    });

    test('5. interleave abort: an operator byte before commit releases immediately', async (t) => {
      const harness = await makeHarness(t, adapter, {
        mode: 'managed',
        ptyLoad: 'ok',
        lockState: 'free',
        pauseBeforeControlWrite: true,
      });
      await preparePending(harness);

      const operatorByte = Buffer.from('x');
      await call(harness, 'operator', operatorByte);
      let observed = await snapshot(harness);
      assertReleased(observed, 'pre-submit operator abort');
      assertNoAutomaticWrite(observed, 'pre-submit operator abort');
      assert.equal(observed.queuedInputBytes, 0, 'aborting byte must be released, not stranded');
      assert.deepEqual(
        joinedBytes(observed.childWrites, 'childWrites'),
        operatorByte,
        'aborting operator byte must be delivered exactly once',
      );
      assertNamedDecision(observed, /operator|interleave|input.*abort/i, 'operator abort');

      await call(harness, 'flushControl');
      observed = await snapshot(harness);
      assertNoAutomaticWrite(observed, 'stale scheduled commit after operator abort');
    });

    test('6. hold release: kill switch, checkpoint failure, cancellation, and TTL all clean up', async (t) => {
      {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await preparePending(harness);
        await call(harness, 'setGuard', 'killSwitch', true);
        await call(harness, 'drive');
        let observed = await snapshot(harness);
        assertReleased(observed, 'kill-switch abort');
        assertNoAutomaticWrite(observed, 'kill-switch abort');
        assertNamedDecision(observed, /kill-switch|killed/i, 'kill-switch abort');
        await call(harness, 'flushControl');
        observed = await snapshot(harness);
        assertNoAutomaticWrite(observed, 'stale scheduled commit after kill switch');
      }

      {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await call(harness, 'primeAuthorized');
        await call(harness, 'setGuard', 'checkpoint', 'failed');
        await call(harness, 'attemptAutomaticClear');
        await call(harness, 'flushControl');
        const observed = await snapshot(harness);
        assertReleased(observed, 'failed-checkpoint refusal');
        assertNoAutomaticWrite(observed, 'failed-checkpoint refusal');
        assert.equal(observed.clearIntent, null, 'failed checkpoint must mint no intent');
        assertNamedDecision(observed, /checkpoint/i, 'failed-checkpoint refusal');
      }

      {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await preparePending(harness);
        await call(harness, 'setGuard', 'checkpoint', 'failed');
        await call(harness, 'flushControl');
        const observed = await snapshot(harness);
        assertReleased(observed, 'checkpoint becoming stale before commit');
        assertNoAutomaticWrite(observed, 'checkpoint becoming stale before commit');
        assertNamedDecision(observed, /checkpoint/i, 'commit-time checkpoint guard');
      }

      {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await preparePending(harness);
        await call(harness, 'cancel');
        let observed = await snapshot(harness);
        assertReleased(observed, 'explicit cancellation');
        assertNoAutomaticWrite(observed, 'explicit cancellation');
        assertNamedDecision(observed, /cancel|abort/i, 'explicit cancellation');
        await call(harness, 'flushControl');
        observed = await snapshot(harness);
        assertNoAutomaticWrite(observed, 'stale scheduled commit after cancellation');
      }

      {
        const harness = await makeHarness(t, adapter, {
          mode: 'managed',
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: true,
        });
        await preparePending(harness);
        await call(harness, 'fireWatchdog');
        let observed = await snapshot(harness);
        assertReleased(observed, 'watchdog safety fuse');
        assertNoAutomaticWrite(observed, 'watchdog safety fuse before commit');
        assertNamedDecision(observed, /watchdog|ttl|timeout/i, 'watchdog safety fuse');
        await call(harness, 'flushControl');
        observed = await snapshot(harness);
        assertNoAutomaticWrite(observed, 'stale scheduled commit after watchdog');
      }
    });

    test('7. teardown: dispose, kill, and prompt exit produce zero helper crash noise', async (t) => {
      const harness = await makeHarness(t, adapter, {
        mode: 'managed',
        ptyLoad: 'ok',
        lockState: 'free',
        pauseBeforeControlWrite: false,
        teardownShape: 'kill-then-linger',
      });
      await call(harness, 'shutdown');
      await call(harness, 'flushHelper');
      const observed = await snapshot(harness);

      const disposed = eventIndex(observed.events, /data.*(?:handler|subscription).*(?:dispose|remove)|dispose.*data/i);
      const killed = eventIndex(observed.events, /child.*kill|kill.*child/i);
      const exited = eventIndex(observed.events, /runner.*exit|exit.*runner/i);
      assert.ok(disposed >= 0, 'teardown trace must record data-handler disposal');
      assert.ok(killed >= 0, 'teardown trace must record child kill');
      assert.ok(exited >= 0, 'teardown trace must record prompt runner exit');
      assert.ok(
        disposed < killed && killed < exited,
        'owned teardown order must be dispose data handlers -> kill child -> runner exit',
      );
      assert.equal(observed.childKilled, true, 'teardown must physically call the PTY kill seam');
      assert.equal(
        observed.runnerExitCode,
        0,
        'owned teardown must invoke the prompt parent-exit seam',
      );

      const noise = [
        textLines(observed.helperNoise),
        textLines(observed.parentWrites),
        textLines(observed.logs),
      ].join('\n');
      assert.doesNotMatch(
        noise,
        /AttachConsole failed|conpty.*(?:stack|error)|\n\s*at\s+\S+/i,
        'kill-then-linger teardown must not leak the node-pty helper stack trace',
      );
    });

    test('8. pass-through: manual /clear, output, resize, SIGINT, and exit match unmanaged', async (t) => {
      const exercise = async (mode) => {
        const harness = await makeHarness(t, adapter, {
          mode,
          ptyLoad: 'ok',
          lockState: 'free',
          pauseBeforeControlWrite: false,
        });
        if (mode === 'managed') {
          await call(harness, 'setGuard', 'killSwitch', true);
          await call(harness, 'drive');
        }
        await call(harness, 'operator', manualClear);
        await call(harness, 'childOutput', childOutput);
        await call(harness, 'resize', 132, 43);
        await call(harness, 'sigint');
        await call(harness, 'childExit', childExitCode);
        const observed = await snapshot(harness);
        assertNoAutomaticWrite(observed, `${mode} manual-command path`);
        return observed;
      };

      const managed = await exercise('managed');
      const unmanaged = await exercise('unmanaged');
      assert.deepEqual(
        passThroughProjection(managed),
        passThroughProjection(unmanaged),
        'managed transport must be byte/event-identical to the unmanaged reference',
      );
      assert.deepEqual(
        joinedBytes(managed.childWrites, 'childWrites'),
        manualClear,
        'manual /clear must pass through even while automation is killed',
      );
      assert.equal(managed.runnerExitCode, childExitCode, 'child exit status must propagate');
    });

    test('9. single runner: live lock refuses nonzero and stale lock is reclaimed loudly', async (t) => {
      const live = await makeHarness(t, adapter, {
        mode: 'managed',
        ptyLoad: 'ok',
        lockState: 'live',
        pauseBeforeControlWrite: false,
      });
      const liveObserved = await snapshot(live);
      assert.ok(
        Number.isInteger(liveObserved.runnerExitCode) && liveObserved.runnerExitCode !== 0,
        'live-lock refusal must exit nonzero',
      );
      assert.equal(liveObserved.managedSpawnCount, 0, 'live-lock refusal must not spawn a PTY child');
      assert.equal(liveObserved.unmanagedSpawnCount, 0, 'live-lock refusal must not fall through');
      assert.match(textLines(liveObserved.logs), /live.*runner.*lock|runner-live/i);

      const stale = await makeHarness(t, adapter, {
        mode: 'managed',
        ptyLoad: 'ok',
        lockState: 'stale',
        pauseBeforeControlWrite: false,
      });
      const staleObserved = await snapshot(stale);
      assert.equal(staleObserved.managed, true, 'stale-lock reclaim must continue managed');
      assert.equal(staleObserved.managedSpawnCount, 1, 'reclaimed runner must spawn exactly once');
      assert.equal(staleObserved.unmanagedSpawnCount, 0);
      assert.match(textLines(staleObserved.logs), /stale.*runner.*lock.*reclaim/i);
    });

    test('10. degraded mode: node-pty load failure is loud and unmanaged fallback remains intact', async (t) => {
      const harness = await makeHarness(t, adapter, {
        mode: 'managed',
        ptyLoad: 'fail',
        lockState: 'free',
        pauseBeforeControlWrite: false,
      });
      const before = await call(harness, 'persistentState', 'baseline');

      await call(harness, 'operator', manualClear);
      await call(harness, 'childOutput', childOutput);
      await call(harness, 'childExit', childExitCode);

      const after = await call(harness, 'persistentState', 'current');
      const observed = await snapshot(harness);
      assert.equal(observed.managed, false, 'node-pty load failure must not claim managed mode');
      assert.equal(observed.managedSpawnCount, 0, 'failed node-pty loader cannot spawn managed');
      assert.equal(observed.unmanagedSpawnCount, 1, 'degraded mode must launch unmanaged once');
      assert.equal(observed.runnerExitCode, childExitCode, 'fallback exit status must propagate');
      assert.ok(
        typeof observed.degradedState === 'string' && observed.degradedState.length > 0,
        'degraded mode must expose a named state',
      );
      assert.match(observed.degradedState, degradedPattern);
      assert.match(
        textLines(observed.logs),
        degradedPattern,
        'degraded state must be printed/logged loudly',
      );
      assert.deepEqual(
        joinedBytes(observed.childWrites, 'childWrites'),
        manualClear,
        'unmanaged degraded fallback must remain interactive',
      );
      assert.deepEqual(
        after,
        before,
        'loader failure must not alter checkpoint/recovery persistence',
      );
    });
  });
}
