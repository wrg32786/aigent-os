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
// node-pty is intentionally loaded at runtime from the transport's own
// minimal dependency root (daemons/transport-deps — node-pty is its ONLY
// dependency, so transport availability never couples to another subsystem's
// install health; closure package §6).  A no-deps install must still launch
// Claude: checkpoint and recovery hooks remain useful while automatic clear
// reports a loud, named degraded state.
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
  CAPSULE_ACK_LITERAL,
  DEFAULT_PRESSURE_THRESHOLD_PCT,
  RunnerLockError,
  acquireRunnerLock,
  evaluateCheckpointFreshness,
  transcriptPathFor,
  readKillSwitch,
  releaseRunnerLock,
} from './auto-clear-transport.mjs';
import { memRoot as resolveMemoryRoot } from './lifecycle-common.mjs';

const optionalRequire = createRequire(
  new URL('./transport-deps/package.json', import.meta.url),
);

export const DEGRADED_NODE_PTY = 'DEGRADED:auto-clear-node-pty-unavailable';
export const DEGRADED_NODE_PTY_LINE = `${DEGRADED_NODE_PTY} checkpoint/recovery available; auto-clear unavailable; launching unmanaged`;
export const DEGRADED_PRESSURE_THRESHOLD_INVALID = 'DEGRADED:auto-clear-threshold-invalid';
export const UNMANAGED_AUTO_CLEAR_OFF = 'UNMANAGED:auto-clear-disabled';
export const CLEAR_CONTROL_INPUT = '/clear\r';
// Two-phase control write: text first, Enter as its own delayed write.
// MEASURED (scratch-seat driver, 2026-08-05): the one-chunk '/clear\r' left
// '/clear' parked in the composer with the queued-messages hint at 04:23Z
// (no submit, no receipt) yet landed at 04:00Z; the two-phase form landed on
// both certified runs. Candidate mechanisms, neither singly proven: the CR
// inside one chunk reads as paste payload under bracketed paste, or the
// chunk arrives during a turn transition and queues, needing a separate
// release keypress. The delayed Enter closes both. The capsule request used
// to be the counter-evidence here (it went out one-chunk and executed on the
// certified runs) — cycle-005 retired that: the one-chunk request was written
// mid-turn and produced no journal row, no turn, and no ack (PATCH-001S).
// Every automated slash command now uses this same two-phase shape. 400ms
// matches the driver's never-failed typed-turn pattern; nothing verifies the
// text rendered before the Enter fires (named residue, boarded with the
// capsule-leg row).
export const CLEAR_CONTROL_TEXT = '/clear';
export const CONTROL_ENTER = '\r';
export const DEFAULT_CONTROL_ENTER_DELAY_MS = 400;
// Kill-line (Ctrl-U): unconditionally destroys stale composer text before an
// automatic clear, and protects queued-input release if control text strands.
// A no-op on an empty composer.
export const COMPOSER_KILL_LINE = '\u0015';
// The transport reaches 'checkpoint-requested' and then waits for a capsule to
// exist. Nothing was ever asking the seat to write one: tick() returns
// action:'request-checkpoint' (auto-clear-transport.mjs:1019) and this file had
// no reader for it — the word "action" appeared exactly once here, in an
// unrelated comment. So a standalone seat armed, tripped its threshold, and sat
// in checkpoint-requested forever. The Stop-hook autosave does NOT satisfy this;
// that is a rolling best-effort record, not the capsule verb.
//
// PATCH-001S: TEXT ONLY — the Enter is a separate delayed PTY write, exactly
// like the clear. Cycle-005 measured the one-chunk '/context-capsule\r' form
// producing no UserPromptSubmit journal row, no turn, no ack — the defect was
// the BYTE SHAPE, not the timing. PATCH-001S-r3 (accepted transport contract, the review record
// review 4923642846): the request submits at request-checkpoint /
// checkpoint-requested, deliberately while the seat's turn may still be open —
// Claude Code holds it in its native queued-prompt path until the turn ends.
// Only the two-phase shape below is authorized to write it.
export const CAPSULE_REQUEST_TEXT = '/context-capsule';
// DEFECT 4 / FIX (2026-08-05): a SessionStart hook delivers the resume
// procedure + capsule as CONTEXT ONLY -- hooks do not create a turn. With no
// first message, a fresh post-clear seat cannot act on the procedure, posts
// no telemetry, and the pressure gate holds on telemetry-missing forever.
// Measured live on the cert seat (transcript head in hand): the operator
// typing "hi" un-stuck it every time -- this is that hand-delivered nudge,
// automated.
//
// SPEC AMENDMENT (2026-08-05, accepted resume contract): not a bare
// nudge -- the wake IS the resume instruction, so the boot turn runs the
// verb visibly (thinking + narration the operator can watch), exactly like
// a seat running resume today. Commands the run in two sentences, never
// inlines the procedure or capsule content itself (the hook already staged
// those); carries a self-contained fallback so the command still resolves
// to a real action even if staging is somehow absent. One line, neutral,
// machine-origin (bracketed prefix) so it reads unambiguously as an
// injected command, not an operator message.
//
// Wording mirrors this repo's OWN documented resume contract, not fleet
// shorthand: docs/two-verb-lifecycle.md defines /resume as exactly "load
// state, re-ground, act" (no fourth step), and selectCapsule()'s own
// convention is "newest valid capsule" -- both reused verbatim below so the
// command names a real, defined action rather than an undefined one.
// No trailing CR, for the same reason CLEAR_CONTROL_TEXT carries none: a
// single chunk of text+CR is read by the terminal as PASTED CONTENT, so the
// CR lands in the composer instead of submitting. The Enter rides its own
// delayed write (see _fireWake / _writeWakeEnter, mirroring _writeControl).
export const WAKE_MESSAGE = '[aigent] post-clear resume: run the resume procedure staged at session start now -- load the selected capsule, re-ground, and act. If none is staged, load the newest valid capsule from vault/memory/capsules and proceed.';
export const DEFAULT_RUNNER_TICK_MS = 100;
export const DEFAULT_INPUT_HOLD_TTL_MS = 15_000;
// Post-submit fuse: the clear round-trip spans the child finishing its
// in-flight turn plus the fresh context booting hooks before the SessionStart
// receipt lands. Measured live 2026-08-05: 2m16s on a loaded box. The
// settle-window TTL above must never govern that window.
export const DEFAULT_CLEAR_VERIFY_TTL_MS = 300_000;

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

// composer-channel leg 1: the diagnostic channel shares the operator's
// console. process.stderr and the live PTY's proxied output render to the
// SAME terminal — a diagnostic line painted there lands visually inside the
// operator's composer (measured on a live seat 2026-08-05; the operator
// named this bleed-through class roughly ten times). Every default `log`
// implementation below appends to the memRoot error log instead, matching
// the pattern already established by _noteSubmissionRefusal and by
// auto-clear-transport.mjs's own defaultLog. NO stderr. Ever.
function appendDaemonErrorLog(memRoot, fsImpl, tag, message) {
  try {
    fsImpl.appendFileSync(
      path.join(memRoot, '.daemon-errors.log'),
      `${new Date().toISOString()} tag="${tag}" message="${oneLine(message)}"\n`,
    );
  } catch { /* file sink unavailable; the message is dropped, never painted on-screen */ }
}

function makeMemRootLog(memRoot, fsImpl = fs) {
  return (message) => appendDaemonErrorLog(memRoot, fsImpl, 'pty-runner', message);
}

// composer-channel leg 3: a live cycle wedged on runner-input-not-empty
// while the visible composer was empty (measured 2026-08-04). The refusal
// log carried the CODE only, never the tracker snapshot living in
// lastReason.detail at every call site, so which flag was actually stuck
// (activePaste vs activeControl vs unknown vs plain bytes) was undiagnosable
// from disk. Bounded so one pathological detail object can't blow the line.
function boundedDetailJson(detail, maximum = 400) {
  if (detail === null || detail === undefined) return 'null';
  try {
    return oneLine(JSON.stringify(detail), maximum);
  } catch {
    return oneLine(String(detail), maximum);
  }
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

// Built via fromCharCode, not a literal escape, so no raw control byte sits
// in this source file -- InputOwnershipTracker's own lastTaint substitution
// (below) exists for the same reason: a control byte in a log/diff is a
// footgun for every tool that reads it after this one.
const ESC = String.fromCharCode(27);

// TERMINAL REPORT RESPONSES (FIX A, 2026-08-05): the terminal ANSWERS
// queries on stdin -- these are responses, not operator input, and none of
// them can place text in the composer. Extends the existing focus/mouse
// report whitelist inside InputOwnershipTracker#observe. Each pattern is
// anchored end-to-end against the COMPLETED sequence (this.sequence already
// includes the final byte at match time).
const TERMINAL_REPORT_RESPONSES = [
  // CPR -- cursor position report, the DSR-6 answer: ESC [ Pl ; Pc R
  new RegExp(`^${ESC}\\[\\d+(?:;\\d+)*R$`),
  // DECXCPR -- extended CPR (adds a page id): ESC [ ? Pl ; Pc R
  // Known ambiguity: xterm's modified-F3 can emit ESC[1;<m>R, colliding
  // with a bare CPR above. Acceptable -- F3 cannot insert composer text
  // either, whitelisted or not.
  new RegExp(`^${ESC}\\[\\?\\d+(?:;\\d+)*R$`),
  // DA1/DA2 -- device attributes responses: ESC [ ? ... c  or  ESC [ > ... c
  new RegExp(`^${ESC}\\[[?>]\\d*(?:;\\d+)*c$`),
  // DSR -- device status report: ESC [ 0 n  or  ESC [ 3 n
  new RegExp(`^${ESC}\\[[03]n$`),
  // DECRPM -- mode report: ESC [ ? Pd ; Ps $ y
  new RegExp(`^${ESC}\\[\\?\\d+;\\d+\\$y$`),
];

// win32-input-mode (DECSET 9001, CLI-toggled by the client app, e.g. VS
// Code / node-pty callers): once armed, ConPTY encodes EVERY keystroke as
// ESC[Vk;Sc;Uc;Kd;Cs;Rc_ instead of the legacy VT keycodes -- including
// Enter, which no longer arrives as a raw CR. No copy of the spec is
// vendored in this repo; verified 2026-08-05 against the published spec
// text (microsoft/terminal doc/specs/#4999 - Improved keyboard handling in
// Conpty.md) rather than trusting an earlier field-order reading that
// carried its own explicit unverified caveat. Confirmed field order and defaults:
//   Vk (virtual key code)      default 0
//   Sc (scan code)             default 0
//   Uc (Unicode char, decimal) default 0
//   Kd (key-down: 1=down/0=up) default 0
//   Cs (control-key-state)     default 0
//   Rc (repeat count)          default 1
// Trailing params may be omitted entirely.
const WIN32_INPUT_MODE_SHAPE = new RegExp(`^${ESC}\\[([\\d;]*)_$`);
const VK_RETURN = 13;

// Returns {vk, sc, uc, kd, cs, rc} for a syntactically valid win32-input-
// mode key event, or null for anything that doesn't match the six-field
// digit/semicolon shape at all (malformed input stays fail-closed via the
// caller's normal else branch -- this parser never guesses).
function parseWin32InputModeEvent(sequence) {
  const shapeMatch = WIN32_INPUT_MODE_SHAPE.exec(sequence);
  if (!shapeMatch) return null;
  const fields = shapeMatch[1].split(';');
  if (fields.length > 6) return null;
  const defaults = [0, 0, 0, 0, 0, 1];
  const [vk, sc, uc, kd, cs, rc] = defaults.map((fallback, index) => {
    const raw = fields[index];
    return raw === undefined || raw === '' ? fallback : Number(raw);
  });
  return { vk, sc, uc, kd, cs, rc };
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
    // Pre-sequence snapshot: ESC poisons the flags on ARRIVAL (fail-closed for
    // unfinished sequences). A COMPLETED benign terminal report restores them;
    // anything unfinished or unrecognized keeps the poison.
    this.preSequenceUnknown = false;
    this.preSequenceKnownEmpty = true;
    // R26 FIX finding 3: restored alongside the two flags above by both
    // whitelist branches. Without this, a whitelisted report on an
    // already-clean tracker read the contradictory {unknown:false,
    // lastTaint:"\e"} -- ESC-arrival taints lastTaint unconditionally, and
    // neither whitelist branch undid it.
    this.preSequenceLastTaint = null;
    // Diagnosability (FIX A2, 2026-08-05): the printable cause of the most
    // recent taint, or null if never tainted since the last submission.
    // Flows into the refusal log's detail JSON via snapshot() -- without
    // this, "unknown:true" on a live seat names no mechanism to check.
    this.lastTaint = null;
  }

  // Records that this observation tainted the tracker and WHY, bounded and
  // printable: ESC substituted for \e (a raw control byte has no place in a
  // log line), sliced to 80 chars so one runaway sequence can't blow out the
  // refusal detail. Called at every site that sets unknown=true, with the
  // cause captured BEFORE the caller clears/truncates this.sequence.
  _taint(cause) {
    this.unknown = true;
    this.lastTaint = cause.split(ESC).join('\\e').slice(0, 80);
  }

  _submitted() {
    this.mode = 'normal';
    this.sequence = '';
    this.pasteEndProbe = '';
    this.knownEmpty = true;
    this.unknown = false;
    this.activePaste = false;
    this.activeControl = false;
    this.lastTaint = null;
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
        this._taint(this.sequence);
        this.mode = 'normal';
        this.sequence = '';
        this.activeControl = false;
        this.knownEmpty = false;
        continue;
      }

      if (this.mode === 'csi') {
        this.sequence += character;
        if (this.sequence.length > 64) {
          this._taint(this.sequence);
          this.mode = 'unknown-control';
          this.sequence = this.sequence.slice(-2);
          this.activeControl = true;
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
          } else if (
            // TERMINAL REPORTS, not operator input — sequences the terminal
            // emits about the window that CANNOT place text in the composer:
            //   ESC[I / ESC[O   focus in / focus out
            //   ESC[<...M/m     SGR mouse reports (wheel scroll, clicks)
            // Measured on a live seat 2026-08-04: with these classified as
            // unknown input, every alt-tab and every wheel scroll marked the
            // composer dirty, and the auto-clear refused for the whole 120s
            // telemetry window — OBSERVING the seat prevented the clear.
            // Arrow keys and everything else stay fail-closed: arrow-up
            // genuinely recalls history into the composer and MUST refuse.
            this.sequence === '\u001b[I'
            || this.sequence === '\u001b[O'
            || (this.sequence.startsWith('\u001b[<')
              && (character === 'M' || character === 'm'))
          ) {
            this.unknown = this.preSequenceUnknown;
            this.knownEmpty = this.preSequenceKnownEmpty;
            this.lastTaint = this.preSequenceLastTaint;
            this.mode = 'normal';
            this.sequence = '';
            this.activeControl = false;
          } else if (TERMINAL_REPORT_RESPONSES.some((pattern) => pattern.test(this.sequence))) {
            // Terminal query RESPONSES (FIX A, 2026-08-05), not operator
            // input, same restore semantics as the whitelist immediately
            // above: CPR/DECXCPR, DA1/DA2, DSR, DECRPM. Measured on a live
            // seat 2026-08-05: snapshot {knownEmpty:false, activePaste:
            // false, activeControl:false, unknown:true} blocked auto-clear
            // with an empty composer, because these completed CSI answers
            // fell through to the fail-closed else branch below.
            this.unknown = this.preSequenceUnknown;
            this.knownEmpty = this.preSequenceKnownEmpty;
            this.lastTaint = this.preSequenceLastTaint;
            this.mode = 'normal';
            this.sequence = '';
            this.activeControl = false;
          } else if (character === '_' && parseWin32InputModeEvent(this.sequence) !== null) {
            // win32-input-mode key event (FIX, 2026-08-05): a DECODED
            // keystroke, not a terminal report -- so unlike the whitelists
            // above this is never a blanket pass-through. Only two narrow
            // cases get special handling; everything else (Kd outside
            // {0,1}, backspace/delete/arrows/function keys) falls to the
            // same fail-closed else branch raw CSI codes already use.
            const event = parseWin32InputModeEvent(this.sequence);
            if (event.kd === 0) {
              // KEYUP: places nothing in the composer -- same restore
              // semantics as the report whitelists above.
              this.unknown = this.preSequenceUnknown;
              this.knownEmpty = this.preSequenceKnownEmpty;
              this.lastTaint = this.preSequenceLastTaint;
              this.mode = 'normal';
              this.sequence = '';
              this.activeControl = false;
            } else if (event.kd === 1 && event.vk === VK_RETURN) {
              // KEYDOWN Enter: identical submission semantics to a raw CR
              // -- unconditional, same as the raw-CR branch above, even if
              // the line is currently unknown-tainted from something else.
              this._submitted();
            } else if (event.kd === 1 && event.uc >= 0x20 && event.uc !== 0x7f) {
              // KEYDOWN printable (same 0x20..0x7e boundary the raw-byte
              // path below already uses for its DEL/control check): we
              // KNOW a character was typed, so no taint. knownEmpty is
              // forced dirty -- genuine new content, unlike the whitelists
              // above -- while unknown/lastTaint restore normally: one
              // known keystroke doesn't retroactively clear an EARLIER
              // unknown taint still sitting in the line.
              this.unknown = this.preSequenceUnknown;
              this.knownEmpty = false;
              this.lastTaint = this.preSequenceLastTaint;
              this.mode = 'normal';
              this.sequence = '';
              this.activeControl = false;
            } else {
              // KEYDOWN non-printable, non-Return (backspace/delete/
              // arrows/function keys mutate text invisibly -- same
              // fail-closed reasoning as today's raw-mode arrows), or a
              // Kd value outside {0,1} that this parser deliberately
              // never guesses at.
              this._taint(this.sequence);
              this.mode = 'normal';
              this.sequence = '';
              this.activeControl = false;
              this.knownEmpty = false;
            }
          } else {
            this._taint(this.sequence);
            this.mode = 'normal';
            this.sequence = '';
            this.activeControl = false;
            this.knownEmpty = false;
          }
        }
        continue;
      }

      if (this.mode === 'osc') {
        this.sequence += character;
        if (character === '\u0007' || this.sequence.endsWith('\u001b\\')) {
          this._taint(this.sequence);
          this.mode = 'normal';
          this.sequence = '';
          this.activeControl = false;
          this.knownEmpty = false;
        } else if (this.sequence.length > 1024) {
          this._taint(this.sequence);
          this.mode = 'unknown-control';
          this.sequence = this.sequence.slice(-2);
          this.activeControl = true;
          this.knownEmpty = false;
        }
        continue;
      }

      if (this.mode === 'string-control' || this.mode === 'unknown-control') {
        this.sequence = `${this.sequence}${character}`.slice(-1024);
        if (this.sequence.endsWith('\u001b\\')) {
          this._taint(this.sequence);
          this.mode = 'normal';
          this.sequence = '';
          this.activeControl = false;
          this.knownEmpty = false;
        } else {
          this._taint(this.sequence);
          this.activeControl = true;
          this.knownEmpty = false;
        }
        continue;
      }

      if (character === '\u001b') {
        this.preSequenceUnknown = this.unknown;
        this.preSequenceKnownEmpty = this.knownEmpty;
        this.preSequenceLastTaint = this.lastTaint;
        this.mode = 'escape';
        this.sequence = character;
        this.activeControl = true;
        this._taint(character);
        this.knownEmpty = false;
        continue;
      }

      const code = character.codePointAt(0);
      if (code < 0x20 || code === 0x7f) {
        this._taint(character);
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
      lastTaint: this.lastTaint,
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
    log = makeMemRootLog(memRoot, fsImpl),
    scheduleTick = (callback, milliseconds) => setInterval(callback, milliseconds),
    clearTick = (handle) => clearInterval(handle),
    scheduleCommit = (callback) => setImmediate(callback),
    clearCommit = (handle) => clearImmediate(handle),
    scheduleWatchdog = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearWatchdog = (handle) => clearTimeout(handle),
    scheduleEnter = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearEnter = (handle) => clearTimeout(handle),
    controlEnterDelayMs = DEFAULT_CONTROL_ENTER_DELAY_MS,
    tickMs = DEFAULT_RUNNER_TICK_MS,
    inputHoldTtlMs = DEFAULT_INPUT_HOLD_TTL_MS,
    clearVerifyTtlMs = DEFAULT_CLEAR_VERIFY_TTL_MS,
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
    this.log = typeof log === 'function' ? log : makeMemRootLog(memRoot, fsImpl);
    this.scheduleTick = scheduleTick;
    this.clearTick = clearTick;
    this.scheduleCommit = scheduleCommit;
    this.clearCommit = clearCommit;
    this.scheduleWatchdog = scheduleWatchdog;
    this.clearWatchdog = clearWatchdog;
    this.scheduleEnter = scheduleEnter;
    this.clearEnter = clearEnter;
    this.controlEnterDelayMs = controlEnterDelayMs;
    this.enterHandle = null;
    this.enterToken = 0;
    this.wakeEnterHandle = null;
    this.wakeEnterToken = 0;
    this.composerMayHoldControlText = false;
    this.tickMs = tickMs;
    this.inputHoldTtlMs = inputHoldTtlMs;
    this.clearVerifyTtlMs = clearVerifyTtlMs;
    this.watchdogTtlMs = null;
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
    this.capsuleRequestCycleId = null;
    // Ack sentinel: transcript offset to scan from, set when the capsule
    // request is written. The ack literal appearing past it IS the completion
    // signal (the event-driven transport design, 2026-08-04).
    this.capsuleAckSearchFrom = null;
    this.capsuleAckSeen = false;
    // Exactly-once latch for the synchronous post-clear wake.
    this.wakeSessionId = null;
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
    // Also durable: these were memory-only, so "did the capsule request go
    // out? did the wake fire?" was unanswerable from a
    // seat's own files -- twice in one night. All sites are state changes,
    // not per-tick, so the log stays readable.
    this._diagnostic(`EVENT ${name} ${boundedDetailJson(detail)}`);
  }

  _diagnostic(message) {
    try { this.log(message); } catch { /* diagnostics never own input */ }
  }

  _writeOperator(data) {
    this._event('operator-write', asText(data));
    return this.pty.write(data);
  }

  _writeControl() {
    // The kill-line already landed in commitClearSubmission, pre-submit —
    // by the time this writer runs the composer is clean and the only
    // remaining chunks are the clear text and its delayed Enter.
    this.currentControlWriteAttempted = true;
    // An ack buys ONE clear. Spend it here, at the moment it is used, so it
    // cannot authorize the next one: a surviving ack cleared the seat again
    // the instant it rebound -- clear, resume, clear, with no capsule in
    // between (measured live 2026-08-05).
    this.capsuleAckSeen = false;
    this._event('capsule-ack-spent', CLEAR_CONTROL_TEXT);
    this._event('control-write', CLEAR_CONTROL_TEXT);
    const result = this.pty.write(CLEAR_CONTROL_TEXT);
    this.composerMayHoldControlText = true;
    // Enter rides its own delayed write so the terminal parses it as a
    // keypress; a text write that throws never schedules it (the abort path
    // owns that case). The token pins the deferred callback to THIS
    // scheduling — a cleared-but-still-firing timer from an injected
    // scheduler is a no-op.
    this._clearEnter();
    this.enterToken += 1;
    const token = this.enterToken;
    this.enterHandle = this.scheduleEnter(
      () => this._writeControlEnter(token),
      this.controlEnterDelayMs,
    );
    return result;
  }

  _writeControlEnter(token) {
    if (token !== this.enterToken) return;
    this.enterHandle = null;
    if (this.closed) return;
    if (this.phase !== 'submitted' && this.phase !== 'submitting') return;
    try {
      this._event('control-enter-write', CONTROL_ENTER);
      this.pty.write(CONTROL_ENTER);
      this.composerMayHoldControlText = false;
    } catch (error) {
      // The text may sit in the composer unsubmitted; the round-trip fuse
      // stays armed and expires loudly if no receipt ever lands, and the
      // stranded-text flag stays up so a later queued-input flush leads
      // with a kill-line instead of concatenating onto '/clear'.
      this.lastReason = {
        code: 'runner-control-enter-write-failed',
        detail: errorText(error),
      };
      this._event('control-enter-write-failed', this.lastReason);
    }
  }

  _clearEnter() {
    this.enterToken += 1;
    if (this.enterHandle !== null) {
      try { this.clearEnter(this.enterHandle); } catch { /* already fired */ }
    }
    this.enterHandle = null;
  }

  _clearWakeEnter(detail = null) {
    this.wakeEnterToken += 1;
    if (this.wakeEnterHandle === null) return null;
    try { this.clearEnter(this.wakeEnterHandle); } catch { /* already fired */ }
    this.wakeEnterHandle = null;
    const reason = {
      code: 'runner-wake-enter-cancelled',
      detail,
    };
    this._event('wake-enter-cancelled', reason);
    return reason;
  }

  // Carries action:'request-checkpoint' to the seat. The transport decides WHEN
  // a capsule is owed; this is the only thing that tells the seat so.
  //
  // ONE WRITE PER CYCLE_ID — not per state visit, and the difference was a live
  // feedback loop, found by the PRINCIPAL, not by me, 2026-08-04 ~17:55: the
  // first guard re-armed whenever the state left checkpoint-requested, but the
  // state OSCILLATES through HOLD:telemetry-stale and back on every operator
  // turn. Each re-entry fired ANOTHER /context-capsule; each capsule run
  // appended ~15-22k to the transcript; which re-broke checkpoint-transcript-
  // short; which held until the operator nudged; whose nudge re-armed the guard.
  // The injection meant to close the cycle was the thing keeping it open — the
  // seat re-asked for a capsule it already had, forever. Keying on cycle_id
  // makes the request fire exactly once per pressure cycle no matter how many
  // times the state wobbles through holds within it.
  // TWO-PHASE since PATCH-001S — text, then a protected delayed Enter on the
  // SAME token slot the clear uses (capsule and clear submissions cannot
  // overlap: the clear is impossible until this request's ack exists, so one
  // slot serves both and no fourth timer/token family is added). The prior
  // one-chunk form was retired by measurement, not style: cycle-005 wrote it
  // mid-turn and the seat never saw a prompt (no journal row, no turn, no
  // ack — supplement-A, 7b980f0). The run-2 forensics that once defended
  // one-chunk showed it can execute, never that it always does.
  // FIX B (PATCH-001I): writes the request once per cycle and resets
  // the ack search offset to the current transcript size. Then wait for the
  // ack or fail visibly at runner-capsule-not-acked; no retry is authorized.
  // The ack belongs to the CAPSULE VERB, not to whoever asked for it: the
  // operator can run /context-capsule by hand, and that capsule is just as
  // real. Armed at every session bind so any capsule counts (measured live
  // 2026-08-05: a hand-run capsule completed and acked, and the clear never
  // came because the watcher only armed when the runner wrote the request).
  _armCapsuleAckWatch() {
    try {
      const transcript = transcriptPathFor({ cwd: this.cwd, sessionId: this.sessionId, homeDir: this.homeDir });
      this.capsuleAckSearchFrom = transcript ? fs.statSync(transcript).size : 0;
    } catch { this.capsuleAckSearchFrom = 0; }
  }

  _fireCapsuleRequest() {
    this._armCapsuleAckWatch();
    // Text write throws propagate to the caller's fail-closed catch — nothing
    // is scheduled for a request that never reached the PTY.
    this._event('capsule-request-write', CAPSULE_REQUEST_TEXT);
    const result = this.pty.write(CAPSULE_REQUEST_TEXT);
    // From this moment the composer may hold '/context-capsule' unsubmitted;
    // the queued-input flush leads with a kill-line while this flag is up, so
    // operator bytes can never concatenate onto stranded command text.
    this.composerMayHoldControlText = true;
    this._clearEnter();
    this.enterToken += 1;
    const token = this.enterToken;
    try {
      const handle = this.scheduleEnter(
        () => this._writeCapsuleRequestEnter(token),
        this.controlEnterDelayMs,
      );
      if (handle === null || handle === undefined) {
        // A scheduler that returns no handle scheduled nothing — the same
        // failure as a throw, minus the honesty. Fail closed identically:
        // text stays stranded (flag up), no retry, no ack, no clear. The
        // handle slot stays null so every enterHandle guard reads the truth.
        this.lastReason = {
          code: 'runner-capsule-request-enter-schedule-failed',
          detail: `scheduleEnter returned ${handle === null ? 'null' : 'undefined'}`,
        };
        this._event('capsule-request-enter-schedule-failed', this.lastReason);
      } else {
        this.enterHandle = handle;
      }
    } catch (error) {
      // Fail closed: the text is stranded (flag stays up), the cycle gets no
      // ack and therefore no clear, and the refusal stays visible each tick.
      // No retry — the cycle_id latch has already been spent.
      this.lastReason = {
        code: 'runner-capsule-request-enter-schedule-failed',
        detail: errorText(error),
      };
      this._event('capsule-request-enter-schedule-failed', this.lastReason);
    }
    return result;
  }

  // The capsule request's own Enter. A separate callback from the clear's
  // (_writeControlEnter guards on the submission phase, which the capsule
  // request runs outside of) but the SAME token/handle slot — a clear
  // submission that begins while this is pending bumps the token and this
  // callback becomes a no-op, with the stranded text destroyed by the clear
  // path's pre-submit kill-line.
  _writeCapsuleRequestEnter(token) {
    if (token !== this.enterToken) return;
    this.enterHandle = null;
    if (this.closed) return;
    try {
      this._event('capsule-request-enter-write', CONTROL_ENTER);
      this.pty.write(CONTROL_ENTER);
      this.composerMayHoldControlText = false;
    } catch (error) {
      // The text may sit in the composer unsubmitted. Fail closed: flag stays
      // up (kill-line protection), no retry, no ack, no clear — the not-acked
      // refusal remains visible every tick.
      this.lastReason = {
        code: 'runner-capsule-request-enter-write-failed',
        detail: errorText(error),
      };
      this._event('capsule-request-enter-write-failed', this.lastReason);
    }
  }

  _writeCapsuleRequest(cycleId) {
    if (this.capsuleRequestCycleId === cycleId) return false;
    this.capsuleRequestCycleId = cycleId;
    this.capsuleAckSeen = false;
    return this._fireCapsuleRequest();
  }

  // Scan the transcript (clean text, no ANSI — unlike the screen) for the
  // capsule ack literal past the request offset. On sight, tell the transport:
  // the ack substitutes for telemetry FRESHNESS only. Bounded read, once per
  // tick, stops permanently for the cycle once seen.
  _checkCapsuleAck() {
    if (this.capsuleAckSeen || this.capsuleAckSearchFrom === null) return false;
    let transcript = null;
    try {
      transcript = transcriptPathFor({ cwd: this.cwd, sessionId: this.sessionId, homeDir: this.homeDir });
      if (!transcript) return false;
      const size = fs.statSync(transcript).size;
      if (size <= this.capsuleAckSearchFrom) return false;
      const from = Math.max(0, this.capsuleAckSearchFrom - CAPSULE_ACK_LITERAL.length);
      const length = Math.min(size - from, 262144);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(transcript, 'r');
      try { fs.readSync(fd, buffer, 0, length, from); } finally { fs.closeSync(fd); }
      const text = buffer.toString('utf8');
      // The literal also appears in the capsule SKILL's own instructions, which
      // land in the transcript the moment the verb is invoked -- so a raw
      // substring scan read "you must say this" as "she said this" and acked
      // while the capsule was still being written (measured live 2026-08-05:
      // ack at +0ms, clear at +100ms, capsule unfinished). A mention is not a
      // use: only the seat's OWN turn counts.
      const said = text.split('\n').some((line) => line.includes(CAPSULE_ACK_LITERAL)
        && line.includes('"type":"assistant"'));
      if (said) {
        this.capsuleAckSeen = true;
        this._event('capsule-ack-observed', CAPSULE_ACK_LITERAL);
        if (typeof this.transport?.noteCapsuleAck === 'function') {
          this.transport.noteCapsuleAck();
        }
        return true;
      }
      // Advance only as far as the last COMPLETE line. The match needs the
      // literal and the assistant tag on ONE line, and a measured line carries
      // them about 1.3k apart, so a line read half-written matches nothing --
      // and an offset advanced into it strands the literal behind the read for
      // the rest of the cycle: the next read starts mid-line and splits out a
      // fragment holding the tag without the literal. Neither half ever
      // matches. An unterminated tail is simply read again next tick.
      // ponytail: a single unterminated line longer than the 256k window would
      // stop the offset advancing at all; re-reading it each tick is bounded
      // and cheap, so no line-length cap until a transcript needs one.
      const lastBreak = buffer.lastIndexOf(0x0a);
      if (lastBreak >= 0) {
        this.capsuleAckSearchFrom = Math.max(this.capsuleAckSearchFrom, from + lastBreak + 1);
      }
      return false;
    } catch { return false; }
  }

  _writeOutput(data) {
    try { this.stdout?.write?.(data); } catch (error) {
      this._diagnostic(`runner stdout write failed: ${errorText(error)}`);
    }
  }

  // composer-channel leg 1: this used to write straight to this.stderr,
  // which shares the terminal the child PTY is actively rendering to —
  // the worst case of the bleed-through class, since it lands mid-composer
  // rather than merely pre-handoff. Routes through the same file sink as
  // every other in-session diagnostic now.
  _writeError(line) {
    this._diagnostic(line);
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

    // Queue whenever automatic command text may still occupy the composer: a
    // hold, a pending wake Enter, a pending shared control Enter (the capsule
    // request's or clear's two-phase window), or text stranded by a failed
    // schedule/write. Live bytes written through here concatenate onto that
    // text and their CR submits the blend (PATCH-001S-r2).
    if (this.inputHold
      || this.wakeEnterHandle !== null
      || this.enterHandle !== null
      || this.composerMayHoldControlText) {
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
        // The observed ack settles the transcript-tail race its own
        // announcement (and any operator nudges) create — the evaluator
        // already honors it; the recheck must not re-race blind.
        ackFresh: this.capsuleAckSeen === true,
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
    this._armCapsuleAckWatch();
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

  _armWatchdog(ttlMs = this.inputHoldTtlMs) {
    let handle;
    try {
      handle = this.scheduleWatchdog(
        () => this._watchdogExpired(),
        ttlMs,
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
    this.watchdogTtlMs = ttlMs;
    this._event('watchdog-armed', { ttl_ms: ttlMs });
    return { ok: true };
  }

  _clearWatchdog() {
    if (this.watchdogHandle !== null) {
      try { this.clearWatchdog(this.watchdogHandle); } catch { /* already fired */ }
    }
    this.watchdogHandle = null;
    this.watchdogArmed = false;
    this.watchdogTtlMs = null;
  }

  _clearCommit() {
    if (this.commitHandle !== null) {
      try { this.clearCommit(this.commitHandle); } catch { /* already running */ }
    }
    this.commitHandle = null;
  }

  _flushQueuedInput() {
    // Wake text owns the child composer until its dedicated Enter physically
    // lands. Keep every unrelated queued chunk behind that write.
    if (this.wakeEnterHandle !== null) return true;

    // Same ownership rule for the shared control Enter slot (PATCH-001S):
    // while a capsule request's (or clear's) delayed Enter is pending, the
    // composer holds command text that has not been submitted — released
    // operator bytes would concatenate onto it and their trailing CR would
    // submit the blend. Queued input waits until the Enter lands (the flag
    // and kill-line below cover the stranded-text case where it never does).
    if (this.enterHandle !== null) return true;

    // R26 F1: while '/clear' may be stranded in the composer (text written,
    // Enter never landed), flushing queued bytes would concatenate the
    // operator's input onto it and their trailing CR would submit the blend.
    // Destroy the stranded text first; if even that write fails, hold the
    // queue closed rather than corrupt it. Guard lives INSIDE this unit —
    // every caller (disable, abort, release) is protected, including future
    // direct calls.
    if (this.composerMayHoldControlText && this.queuedInput.length > 0) {
      try {
        this._event('composer-kill-line', COMPOSER_KILL_LINE);
        this.pty.write(COMPOSER_KILL_LINE);
        this.composerMayHoldControlText = false;
      } catch (error) {
        this.lastReason = {
          code: 'runner-composer-kill-line-failed',
          detail: errorText(error),
        };
        this._event('queued-input-release-failed', this.lastReason);
        this._diagnostic(
          `queued input held: stranded control text and kill-line failed: ${errorText(error)}`,
        );
        return false;
      }
    }
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
    // Same silent-loop hazard as _prepareSubmission: a commit-time abort that
    // repeats every tick is invisible without this. Measured 2026-08-04: intent
    // written, submitted:false for six minutes, zero output — the abort code
    // was unknowable from outside the process.
    this._noteSubmissionRefusal(code, detail);
    this._clearCommit();
    this._clearWatchdog();
    this._clearEnter();
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
    const wakeTerminalCodes = new Set([
      'runner-wake-write-failed',
      'runner-wake-enter-schedule-failed',
      'runner-wake-enter-write-failed',
      'runner-wake-enter-cancelled',
    ]);
    this._clearCommit();
    this._clearWatchdog();
    this._clearEnter();
    const wakeCancellation = this._clearWakeEnter({
      source: 'automation-disable',
      cause: { code, detail },
    });
    if (wakeCancellation) {
      code = wakeCancellation.code;
      detail = wakeCancellation.detail;
    } else if (!wakeTerminalCodes.has(code)
      && wakeTerminalCodes.has(this.lastReason?.code)) {
      code = this.lastReason.code;
      detail = this.lastReason.detail;
    }
    this.token = null;
    this.currentControlWriteAttempted = false;
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    this.automationEnabled = false;
    this.phase = 'disabled';
    this.lastReason = { code, detail };
    this._event('automation-disabled', this.lastReason);
    if (wakeTerminalCodes.has(code)) {
      // The wake text may still occupy the composer. With no retry permitted,
      // there is no safe release point: retain the existing input hold so
      // later operator bytes remain queued instead of concatenating onto it.
      this.inputHold = true;
      this.controlLockHeld = false;
    } else {
      this._releaseInputHold(code);
      this._flushQueuedInput();
    }
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
      ttl_ms: this.watchdogTtlMs ?? this.inputHoldTtlMs,
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
    if (this.wakeEnterHandle !== null) {
      this._disableAutomation(reason, { source: 'cancellation' });
      return true;
    }
    this.automationEnabled = false;
    this.phase = 'disabled';
    this.lastReason = { code: reason, detail: { source: 'cancellation' } };
    return true;
  }

  // Every refusal below sets lastReason IN MEMORY and returns — nothing ever
  // surfaced it. Measured cost on a live seat 2026-08-04: checkpoint-confirmed
  // with hold:null for the FULL 120s telemetry window, ~1,200 ticks, zero
  // submissions, zero output — then the window closed and the state decayed
  // back to HOLD:telemetry-stale. Which of the five gates refused was
  // unknowable from outside the process. This prints the refusal ONCE per
  // reason-code change (never per tick), so a stuck loop names itself.
  _noteSubmissionRefusal(code, detail = null) {
    if (this._lastRefusalPrinted === code) return;
    this._lastRefusalPrinted = code;
    // The refusal goes in the EVENT stream too, not only the error log. A
    // cycle that stops advancing leaves the events as the only record of what
    // it was waiting for, and this one said nothing: a seat sat at
    // checkpoint-confirmed for 3.5h and the events showed the capsule request
    // and then silence, with the reason deduped into a single line in a
    // different file. Once per change, so a steady refusal cannot flood.
    this._event('submission-refused', { code, detail });
    const line = `AUTO-CLEAR REFUSED (${code}) — clear not submitted; `
      + `retrying each tick detail=${boundedDetailJson(detail)}`;
    // NO stderr. Ever. It shares the operator's screen, paints over the
    // composer, and when two codes oscillate the once-per-change limiter fires
    // on every flip — it BLOCKED operator input on the live seat
    // (a repeated live-seat specimen). The file is the record.
    appendDaemonErrorLog(this.memRoot, fs, 'pty-runner', line);
  }

  _prepareSubmission(coreResult, outputObservation) {
    if (!outputObservation || !hasOwn(outputObservation, 'settled')) {
      this.lastReason = {
        code: 'runner-output-observable-field-missing',
        detail: { fields: ['settled'] },
      };
      this._noteSubmissionRefusal(this.lastReason.code, this.lastReason.detail);
      return { status: 'refused', ...this.lastReason };
    }
    const idleProblem = idleEvidenceProblem(coreResult, this.sessionId);
    if (idleProblem) {
      this.lastReason = idleProblem;
      this._noteSubmissionRefusal(idleProblem.code, idleProblem.detail);
      return { status: 'refused', ...idleProblem };
    }
    const bindingProblem = this._bootBindingProblem(coreResult.state);
    if (bindingProblem) {
      this.lastReason = bindingProblem;
      this._noteSubmissionRefusal(bindingProblem.code, bindingProblem.detail);
      return { status: 'refused', ...bindingProblem };
    }
    // capsule -> ack -> clear. The checkpoint gate only proves a stop-writer
    // RECORD exists, and the Stop hook writes one on EVERY turn end with a
    // rolling autosave capsule -- so an idle turn satisfied it and the clear
    // fired with the capsule verb never having run (measured live 2026-08-05:
    // resume -> work -> idle -> clear, no capsule, no ack). ackFresh existed
    // but only RELAXED a byte check; nothing ever required the ack itself.
    // Refused here, before a token is minted, so no hold has to be released.
    if (this.capsuleAckSeen !== true) {
      // PATCH-001S-r3: NOTHING is written here. The request itself fired back
      // at request-checkpoint / checkpoint-requested (the tick path) — by the
      // accepted transport contract it rides Claude Code's native queued-prompt
      // path while the turn is still open. This gate keeps ONLY the ack
      // requirement: no ack -> no clear, and the refusal stays visible on
      // every tick until the ack appears.
      this.lastReason = {
        code: 'runner-capsule-not-acked',
        detail: { cycle_id: this.capsuleRequestCycleId },
      };
      this._noteSubmissionRefusal(this.lastReason.code, this.lastReason.detail);
      return { status: 'refused', ...this.lastReason };
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

    // Busy child output does NOT gate the clear (accepted transport contract,
    // 2026-08-14): the control write rides Claude Code's native queued-prompt
    // path — typed into a busy turn it enqueues and dequeues at turn end,
    // the same certified path the capsule request itself uses. Sampling
    // settlement here loses a race the queue was built to absorb.
    // The checkpoint is NOT re-read here. The seat's own ACK is what
    // authorizes this clear, and it has already been observed and spent; a
    // second look at the checkpoint after that point can only take the
    // authorization back for an ordinary observation. It refused on capsule
    // selection, on the stop-writer record and on the transcript, none of
    // which the seat can influence once it has said the words. Deleted rather
    // than guarded: recovery machinery around a veto that should not exist is
    // how the silent park got built the first time.
    // What still refuses after the ACK, and all of it deliberate: the kill
    // switch above, the input-lock and watchdog invariants above, the session
    // binding below, one ACK spending exactly one clear, the transport's own
    // duplicate-clear refusal, a persistence failure, and a physical write
    // failure on the kill-line, the text or the Enter.
    const bindingProblem = this._bootBindingProblem(this.transport?.state);
    if (bindingProblem) {
      this._abortPrepared(bindingProblem.code, bindingProblem.detail);
      return false;
    }

    // Clear-channel integrity (PATCH-001L): destroy stale composer bytes
    // BEFORE the transport can persist a submitted intent. token.submit
    // persists 'submitted' regardless of a writer throw, so a kill-line
    // inside the writer can never fail closed — here it has spent nothing:
    // named refusal, terminal, pre-submit.
    this.controlWriteAttempts += 1;
    try {
      this._event('composer-kill-line', COMPOSER_KILL_LINE);
      this.pty.write(COMPOSER_KILL_LINE);
    } catch (error) {
      this._abortPrepared('runner-composer-kill-line-failed', errorText(error));
      this._disableAutomation('runner-composer-kill-line-failed', errorText(error));
      return false;
    }

    this.phase = 'submitting';
    this.postSubmitOutputGeneration = this.output.generation;
    try {
      this.token.submit(() => this._writeControl());
      this.phase = 'submitted';
      this._event('submission-committed');
      // The settle-window fuse must not govern the clear round-trip: the
      // child finishes its in-flight turn, then the fresh context boots
      // hooks before the receipt lands (measured 2m16s live, 2026-08-05).
      // Re-arm sized to that window. Expiry semantics are unchanged — the
      // fuse still releases the hold and disables loudly.
      this._clearWatchdog();
      const rearm = this._armWatchdog(this.clearVerifyTtlMs);
      if (!rearm.ok) {
        this._disableAutomation(rearm.code, rearm.detail);
        return false;
      }
      return true;
    } catch (error) {
      const submitted = this.transport?.state?.clear_intent?.submitted === true
        || this.currentControlWriteAttempted;
      if (submitted) {
        // Persistence or a PTY write may have happened.  Ambiguity is terminal
        // for writes: keep the hold until receipt or watchdog, never retry.
        // The write may be in flight, so the round-trip fuse applies here too.
        this.phase = 'submitted';
        this.lastReason = {
          code: 'runner-control-write-ambiguous',
          detail: errorText(error),
        };
        this._event('submission-ambiguous', this.lastReason);
        this._clearWatchdog();
        const rearmAmbiguous = this._armWatchdog(this.clearVerifyTtlMs);
        if (!rearmAmbiguous.ok) {
          this._disableAutomation(rearmAmbiguous.code, rearmAmbiguous.detail);
        }
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
    this._clearEnter();
    this.token = null;
    this.currentControlWriteAttempted = false;
    this.phase = 'idle';
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    const rebound = this._rebindAfterClear(receipt);
    if (rebound) {
      this._flushQueuedInput();
    }
    this._event('resume-released');
    const disable = this.disableAfterRelease;
    this.disableAfterRelease = null;
    if (disable && rebound) {
      this._disableAutomation(disable.code, disable.detail);
    }
    return { status: 'released', state: released.state };
  }

  _rebindAfterClear(receipt) {
    if (!receipt) return false;
    if (typeof this.transportFactory !== 'function') {
      this._disableAutomation('runner-transport-rebind-unavailable', {
        field: 'transportFactory',
      });
      return false;
    }
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
    this._armCapsuleAckWatch();
    this._event('session-rebound', {
      session_id: receipt.session_id,
      boot_sequence: receipt.boot_sequence,
    });
    if (this.wakeSessionId !== receipt.session_id) {
      this.wakeSessionId = receipt.session_id;
      try {
        this._fireWake();
        this._event('wake-injected', {
          session_id: receipt.session_id,
        });
      } catch (error) {
        this.lastReason = {
          code: error?.code || 'runner-wake-write-failed',
          detail: error?.detail ?? errorText(error),
        };
        this._event('wake-write-failed', this.lastReason);
        this._disableAutomation(this.lastReason.code, this.lastReason.detail);
        return false;
      }
    }
    return true;
  }

  // Two writes, never one: the text, then the Enter on its own delayed write
  // so the terminal parses it as a keypress rather than swallowing it as
  // pasted content. It uses the existing timer family but a dedicated
  // handle/token pair, so clearing the control Enter cannot cancel it and a
  // cleared-but-still-firing wake timer is a no-op.
  _fireWake() {
    this.inputHold = true;
    this._event('wake-write', WAKE_MESSAGE);
    const result = this.pty.write(WAKE_MESSAGE);
    this.wakeEnterToken += 1;
    const token = this.wakeEnterToken;
    const handle = this.scheduleEnter(
      () => this._writeWakeEnter(token),
      this.controlEnterDelayMs,
    );
    if (handle === null || handle === undefined) {
      const failure = new Error('wake Enter scheduler returned no handle');
      failure.code = 'runner-wake-enter-schedule-failed';
      failure.detail = 'scheduler returned no handle';
      throw failure;
    }
    this.wakeEnterHandle = handle;
    return result;
  }

  _writeWakeEnter(token) {
    if (token !== this.wakeEnterToken) return;
    this.wakeEnterToken += 1;
    if (this.closed) return;
    try {
      this._event('wake-enter-write', CONTROL_ENTER);
      this.pty.write(CONTROL_ENTER);
      this.wakeEnterHandle = null;
      this._releaseInputHold('wake-enter-written');
      this._flushQueuedInput();
    } catch (error) {
      this.wakeEnterHandle = null;
      // The wake text may sit in the composer unsubmitted. Loud, and the
      // exactly-once latch is already spent. Disable terminally; never retry.
      this.lastReason = {
        code: 'runner-wake-enter-write-failed',
        detail: errorText(error),
      };
      this._event('wake-enter-write-failed', this.lastReason);
      this._disableAutomation(this.lastReason.code, this.lastReason.detail);
    }
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
    if (this.wakeEnterHandle !== null) {
      return { status: 'wake-enter-pending' };
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
      const rebound = this._rebindAfterClear(currentBoot.receipt);
      // Binary resume rule: a fresh post-clear session resumes exactly once,
      // BEFORE any other lifecycle work. The wake text and its protected Enter
      // own the composer for the rest of this tick; the top-of-tick
      // wake-enter-pending guard owns every later tick until the Enter lands.
      if (rebound && this.wakeEnterHandle !== null) {
        return { status: 'wake-enter-pending' };
      }
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

    if (this.capsuleAckSearchFrom === null
      && (coreResult.state.state === 'checkpoint-requested'
        || String(coreResult.state.state).startsWith('HOLD:'))) {
      // Relaunch into an in-flight cycle: the ack may ALREADY be on disk from a
      // previous process. Scan from the stop-writer offset BEFORE injecting —
      // re-injecting was the loop exposed by a live run: each relaunch wrote
      // another request, which wrote another ~14-20k, which re-broke the check.
      try {
        const recordPath = path.join(this.memRoot, 'runtime', 'stop-writer', `${this.sessionId}.json`);
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (Number.isSafeInteger(record.offset)) this.capsuleAckSearchFrom = record.offset;
      } catch { /* no record yet — first injection will set the offset */ }
    }
    if (!this.capsuleAckSeen && this.capsuleAckSearchFrom !== null) {
      this._checkCapsuleAck();
    }
    // PATCH-001S-r3: the seat is owed a capsule and the request fires HERE,
    // at request-checkpoint / checkpoint-requested — deliberately while the
    // seat's turn may still be open. The accepted transport contract (the review record
    // review 4923642846): /context-capsule submits into Claude Code's native
    // queued-prompt path and waits out the busy turn. Cycle-005 proved only
    // that the one-chunk '/context-capsule\r' byte shape produced no turn —
    // never that busy-turn submission is invalid — and _writeCapsuleRequest
    // is two-phase now. STATE-DRIVEN, NOT EDGE-TRIGGERED: the state persists
    // across relaunches, the edge does not. Keyed to cycle_id inside
    // _writeCapsuleRequest (one request per pressure cycle, no retry);
    // guarded on !capsuleAckSeen so a relaunch that already found the ack on
    // disk (the scan above) never re-injects.
    if (!this.capsuleAckSeen
      && (coreResult.action === 'request-checkpoint'
        || coreResult.state.state === 'checkpoint-requested')) {
      try {
        this._writeCapsuleRequest(coreResult.state.cycle_id);
      } catch (error) {
        // Fail closed, no retry: the cycle_id latch is spent, the cycle ends
        // at runner-capsule-not-acked rather than at a guessed recovery.
        this.lastReason = {
          code: 'runner-capsule-request-write-failed',
          detail: errorText(error),
        };
        this._event('capsule-request-write-failed', this.lastReason);
      }
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
    this._clearEnter();

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
    const normalizedExitCode = Number.isInteger(exitCode) ? exitCode : 1;
    // shutdown() is the runner's close path. A wake text already written to
    // the child may never lose its owned Enter silently during teardown.
    const wakeCancellation = this._clearWakeEnter({
      source: 'shutdown',
      exit_code: normalizedExitCode,
    });
    if (wakeCancellation) {
      this.automationEnabled = false;
      this.phase = 'disabled';
      this.inputHold = true;
      this.controlLockHeld = false;
      this.lastReason = wakeCancellation;
      this._event('automation-disabled', this.lastReason);
    }
    this.closed = true;
    this.exitCode = normalizedExitCode;

    // PROMPT PARENT EXIT is the load-bearing guard against the ConPTY
    // helper's AttachConsole stack trace. Measured four ways on real node-pty
    // (independent review of 93b9d2a, F1): the helper crashes whenever the
    // parent lingers after kill() — handler disposal does NOT prevent it
    // (4/4 crashed disposed-and-lingering), and a promptly-exiting parent is
    // clean even with handlers still attached. shutdown() therefore always
    // ends in exitFn below; the disposal here is ordinary resource hygiene,
    // not the crash guard.
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
  log = makeMemRootLog(resolveMemoryRoot(root), fsImpl),
  exitFn = (code) => process.exit(code),
  runnerOptions = {},
} = {}) {
  const memoryRoot = resolveMemoryRoot(root);
  const thresholdConfigured = hasOwn(env, 'AIGENT_PRESSURE_THRESHOLD_PCT');
  const thresholdRaw = env.AIGENT_PRESSURE_THRESHOLD_PCT;
  const parsedThreshold = Number(thresholdRaw);
  // V2 threshold-invalid-refuses: only a decimal integer in the committed
  // 5-95 gate range may arm production automation.
  const thresholdValid = !thresholdConfigured || (
    typeof thresholdRaw === 'string'
    && /^[0-9]+$/.test(thresholdRaw)
    && parsedThreshold >= 5
    && parsedThreshold <= 95
  );
  // V2 threshold-invalid-refuses: a bad operator value must stay loud and
  // unmanaged; falling through would arm the wrong gate population.
  if (!thresholdValid) {
    appendDaemonErrorLog(
      memoryRoot,
      fsImpl,
      'pty-runner',
      `${DEGRADED_PRESSURE_THRESHOLD_INVALID} ${oneLine(thresholdRaw)}`,
    );
    return {
      mode: 'degraded',
      code: DEGRADED_PRESSURE_THRESHOLD_INVALID,
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
  // V3 threshold-unset-default: the production constructor receives the
  // committed 80 default explicitly when the environment surface is absent.
  const pressureThresholdPct = thresholdConfigured
    ? parsedThreshold
    : DEFAULT_PRESSURE_THRESHOLD_PCT;
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
    appendDaemonErrorLog(memoryRoot, fsImpl, 'pty-runner', `${UNMANAGED_AUTO_CLEAR_OFF} reason=${reason}`);
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
    appendDaemonErrorLog(memoryRoot, fsImpl, 'pty-runner', DEGRADED_NODE_PTY_LINE);
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
    // R26 correction: unlike the three branches above, this one never calls
    // runUnmanagedFn — it returns mode:'refused' and the process just exits.
    // No composer ever exists on this path, so it sits on the SAME side of
    // the composer-channel boundary as the boot-failure block below: stderr
    // is legitimate here. Keep the file log too — both is fine.
    try { stderr.write(`${oneLine(error?.message || error)}\n`); } catch { /* visible if possible */ }
    appendDaemonErrorLog(memoryRoot, fsImpl, 'pty-runner', error?.message || error);
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
    // V1 threshold-applied: bind the validated operator value at the real
    // AutoClearTransport construction site, including every later rebind.
    pressureThresholdPct,
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
