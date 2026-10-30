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
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  AutoClearTransport,
  CAPSULE_ACK_LITERAL,
  DEFAULT_PRESSURE_THRESHOLD_PCT,
  RunnerLockError,
  acquireRunnerLock,
  capsuleAckBoundaryProblem,
  capsuleAckClassification,
  evaluateCheckpointFreshness,
  transcriptPathFor,
  readKillSwitch,
  releaseRunnerLock,
} from './auto-clear-transport.mjs';
import { memRoot as resolveMemoryRoot } from './lifecycle-common.mjs';
import {
  acquireGate as acquireInterlockGate,
  interlockEnabled,
  gateStillHeld as interlockGateStillHeld,
  interlockEvidence,
  manualRelease as interlockManualRelease,
  pendingProblem as interlockPendingProblem,
  readState as readInterlockState,
  releaseGate as releaseInterlockGate,
  sessionDir as interlockSessionDir,
  sweepSessionDirs as sweepInterlockSessionDirs,
  writeProof as writeInterlockProof,
  writeState as writeInterlockState,
} from './pre-permission-interlock.mjs';

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
export const WAKE_MESSAGE = '[aigent] post-clear resume: run the resume procedure staged at session start now -- load the selected capsule, re-ground, and act. If none is staged, load the newest valid capsule from the capsules directory under this install\'s memory root and proceed.';
// ─── NO AUTOMATIC TEXT LITERAL MAY CONTAIN A DIGIT (#104 M6) ────────────────
// The ungated automatic TEXT writes are safe for a reason that used to be only
// a comment, and it is load-bearing: at a permission dialog a DIGIT selects
// that option directly. So a literal carrying a `2` would answer "Yes, and
// switch to accept edits (auto-approve file edits and common file commands) for
// this session" with no Enter involved at all -- the worst outcome in #104, and
// reachable without touching any of the Enter machinery that the rest of this
// file spends its length guarding.
//
// '/clear' and '/context-capsule' are stable, but WAKE_MESSAGE is PROSE and
// could acquire a numeral in an ordinary edit ("run step 2 of the procedure").
// So it is an assertion evaluated at module load, not a note: these are
// compile-time constants, the check can only fail because someone edited a
// literal, and that is exactly when a hard stop is wanted. Refusing to load is
// louder and safer than launching a runner that can answer a dialog by typing.
export function automaticTextLiteralProblem(name, literal) {
  if (typeof literal !== 'string') {
    return { code: 'automatic-text-literal-not-a-string', detail: `${name}: ${typeof literal}` };
  }
  const digit = literal.match(/[0-9]/);
  if (digit === null) return null;
  return {
    code: 'automatic-text-literal-carries-digit',
    detail: `${name} contains "${digit[0]}" at index ${digit.index}: a digit typed at a `
      + 'permission dialog selects that option directly',
  };
}

for (const [name, literal] of [
  ['CLEAR_CONTROL_TEXT', CLEAR_CONTROL_TEXT],
  ['CAPSULE_REQUEST_TEXT', CAPSULE_REQUEST_TEXT],
  ['WAKE_MESSAGE', WAKE_MESSAGE],
]) {
  const problem = automaticTextLiteralProblem(name, literal);
  if (problem !== null) throw new Error(`#104 M6 ${problem.code}: ${problem.detail}`);
}

export const DEFAULT_RUNNER_TICK_MS = 100;
export const DEFAULT_INPUT_HOLD_TTL_MS = 15_000;
// Post-submit fuse: the clear round-trip spans the child finishing its
// in-flight turn plus the fresh context booting hooks before the SessionStart
// receipt lands. Measured live 2026-08-05: 2m16s on a loaded box. The
// settle-window TTL above must never govern that window.
export const DEFAULT_CLEAR_VERIFY_TTL_MS = 300_000;
// The wake Enter is WATCHED, like the clear's submission. Measured live
// 2026-09-24 and 2026-09-28: the runner rebound on the fresh boot receipt,
// wrote the wake text, wrote its Enter 400ms later -- and the fresh session
// was still running its SessionStart hooks (~20s on that seat). The keypress
// was dropped; the wake text sat unsent in the composer until the operator
// pressed Enter (35s later on 09-24, by hand on 09-28). The text is NEVER
// rewritten (that duplicates it). Only the Enter is pressed again, on
// evidence, never on elapsed time: the child must have produced output since
// the last Enter (hooks finished, screen repainted) and that output must then
// hold still for a settle window. Confirmation is the same evidence class the
// capsule ack uses -- the seat's own transcript gaining a USER record that
// carries the wake text (clean JSONL, not the ANSI screen). Retries are
// capped, the whole watch is tick-budgeted, and operator bytes end it.
export const WAKE_TRANSCRIPT_LITERAL = JSON.stringify(WAKE_MESSAGE).slice(1, -1);
export const WAKE_ENTER_RETRY_LIMIT = 3;
export const WAKE_SUBMIT_SETTLE_TICKS = 10;
export const WAKE_SUBMIT_WATCH_TICKS = 1200;

// #78: the named stop for a cycle whose ack was observed but whose clear was
// never submitted. Entered when an operator byte interrupts the prepared clear.
export const HOLD_CLEAR_STALLED_AFTER_ACK = 'HOLD:clear-stalled-after-ack';
// A refusal line carrying the ownership snapshot is longer than the 400-char
// default; give it room so the snapshot is never the part that gets cut.
const REFUSAL_DETAIL_MAX = 1200;

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
// Cs is KEY_EVENT_RECORD.dwControlKeyState (Windows console API). Only the
// HELD-modifier bits make an Enter "not a plain submission":
//   RIGHT_ALT_PRESSED 0x01  LEFT_ALT_PRESSED 0x02
//   RIGHT_CTRL_PRESSED 0x04 LEFT_CTRL_PRESSED 0x08  SHIFT_PRESSED 0x10
// The lock states (NUMLOCK_ON 0x20, SCROLLLOCK_ON 0x40, CAPSLOCK_ON 0x80)
// and ENHANCED_KEY 0x100 (set on the numpad Enter) ride along on ordinary
// submissions and must never veto one -- the mask deliberately stops at 0x1F.
const WIN32_CS_MODIFIER_MASK = 0x1f;

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

// One transcript line IS an operator prompt record when it parses as a
// "type":"user" record that is not isMeta and whose message content is a
// non-empty string or carries at least one text block. tool_result-only
// content (the child answering its own tool calls) and isMeta records
// (local-command caveats, skill bodies) are bookkeeping, never a prompt.
// Half-written or non-JSON lines are simply not records.
// NOT THE RUNNER'S OWN PROMPTS (review of 7b3a728, F2): the capsule request
// ('/context-capsule', which Claude Code records as a
// <command-name>/context-capsule</command-name> user record) and the
// post-clear wake message are typed by the runner, and operator bytes seen
// during their Enter window can leave a pending CR that those records would
// then "confirm" -- with the operator's queued draft about to be flushed
// into a composer the tracker just called clean. Any record carrying either
// text is skipped. Cost, fail-closed: an operator prompt that merely quotes
// '/context-capsule' confirms nothing; the next one does.
// NOT PRODUCED BY ANY CR (review of c011881c, F2): two real-host "user"
// record shapes carry text, are not isMeta, and correspond to no operator
// Enter -- under the ordered rule below each would settle an outstanding CR
// that is still owed its own record, shifting attribution the dangerous way:
//   - compaction summaries, `isCompactSummary:true` ("This session is being
//     continued from a previous conversation...");
//   - local command output as a user record on older builds, content
//     starting with <local-command-stdout> (newer builds write type:"system").
// Both skipped. (A hand-typed slash command such as /help IS recorded as a
// <command-name>/help</command-name> user record and does count.)
const RUNNER_OWN_PROMPT_TEXTS = [CAPSULE_REQUEST_TEXT, WAKE_MESSAGE];
const LOCAL_COMMAND_STDOUT_PREFIX = '<local-command-stdout>';

// The byte the tracker knows to sit before the cursor proves the next plain
// Enter SUBMITS when it is a seen printable, a paste's final byte, or the
// newline a chord placed ('\r' from InputOwnershipTracker#_newline). A
// control byte (Backspace, DEL) or null (an arrow, an unfinished ESC, a
// fresh line) proves nothing; a backslash never reaches this test, the CR
// branch reads it as a newline first.
// MEASURED RULE this rests on (Claude Code 2.1.296, 2026-10-12, disposable
// session, non-author reviewer): Enter becomes a newline ONLY when the
// character immediately BEFORE THE CURSOR is a backslash -- never because
// the text ENDS in one.
//   E1  `abc\`, Left, Left, `y`, Enter  -> submitted, record `abyc\`
//   E2  `abc\`, Left, Enter             -> submitted, record `abc\`
//   E3  `abc\`, Enter (cursor after \)  -> newline, no record
//   E4  `ab\cd`, Enter                  -> submitted, record `abc\nab\\cd`
// So a seen non-backslash byte placed at the cursor is sufficient, wherever
// the cursor is in the line.
function isPlacedByte(byte) {
  if (typeof byte !== 'string' || byte.length === 0 || byte === '\\') return false;
  if (byte === '\r') return true;
  const code = byte.codePointAt(0);
  return code >= 0x20 && code !== 0x7f;
}

// A byte that a STRING-mode sequence (OSC, DCS/SOS/PM/APC, or the
// unknown-control overflow mode) executes rather than carries, per ECMA-48
// 5.4 (issue #99). ESC is excluded because it introduces the ST terminator
// those modes end on, and BEL because it terminates an OSC; treating either
// as executed would leave the mode unterminated forever -- a permanent
// deferral, the one failure this file's discipline rules out.
function isExecutedControlInString(byte) {
  if (byte === '\u001b' || byte === '\u0007') return false;
  const code = byte.codePointAt(0);
  return code < 0x20 || code === 0x7f;
}

function isOperatorPromptRecord(line) {
  if (!line.includes('"user"')) return false;
  let record;
  try { record = JSON.parse(line); } catch { return false; }
  if (!record || record.type !== 'user' || record.isMeta === true) return false;
  if (record.isCompactSummary === true) return false;
  const content = record.message?.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (!content.some((block) => block && block.type === 'text' && typeof block.text === 'string')) text = null;
  }
  if (text === null || text.length === 0) return false;
  if (text.startsWith(LOCAL_COMMAND_STDOUT_PREFIX)) return false;
  return !RUNNER_OWN_PROMPT_TEXTS.some((own) => text.includes(own));
}

/**
 * Fail-closed model of the operator's current input line.
 *
 * A PLAIN CR is the only unambiguous submission boundary.  Completed terminal
 * controls remain "unknown" because an arrow, delete, or editor sequence may
 * have changed text the runner cannot see.  Unknown is cleared only by CR.
 *
 * NEWLINE, NOT SUBMISSION (PR #59 review, P1): the composer's documented
 * multiline-input keys arrive on the same wire as a submission and, wherever
 * the tracker can tell them apart, must not be promoted to one -- a wrong
 * "submitted" verdict is exactly the mangled prompt the capsule-request
 * guard exists to prevent, while a wrong "still composing" verdict only
 * defers until the operator's next plain Enter. So:
 *   - a CR immediately preceded by a backslash (same chunk or split across
 *     chunks; `lastByte` remembers) is Claude Code's backslash+Enter newline.
 *     The backslash itself is composer text; the CR is an edit, not a CR
 *     boundary. `/terminal-setup` makes Shift+Enter send exactly these bytes.
 *   - a win32-input-mode VK_RETURN keydown with any HELD modifier bit in Cs
 *     (Shift/Ctrl/Alt) is NOT proof of submission. Claude Code documents
 *     Shift+Enter and Option/Alt+Enter as newline keys (interactive-mode,
 *     "Multiline input"; Windows Terminal Shift+Enter "works without
 *     setup"), and the legacy-VT encodings of the same chords (LF for
 *     Ctrl+J, ESC CR for Alt+Enter) already read as non-submitting edits
 *     here. Ctrl+Enter is the one chord Claude Code documents as a SEND
 *     (chat:sendNow, v2.1.275+; older builds undocumented, and terminals
 *     without extended keys deliver it as plain Enter anyway) -- the runner
 *     cannot see the child's version or key decoding, so it is deliberately
 *     kept on the non-submission side: the cost of being wrong there is one
 *     deferral until the next plain Enter, never a mangled prompt. Lock and
 *     enhanced bits (numpad Enter) do not count as modifiers.
 *   - a LF (Ctrl+J) and an ESC CR (Alt+Enter) are control bytes and stay on
 *     the existing taint path: dirty, never submitted.
 * KNOWN RESIDUALS, stated so nobody "fixes" one into a permanent defer:
 *   - Keybindings: chat:submit (Enter) and chat:newline (Ctrl+J) are
 *     rebindable in ~/.claude/keybindings.json. The runner does not read
 *     that file; an operator who moves submission off Enter defeats the CR
 *     boundary in both directions.
 *   - The Ctrl+Enter-only operator: under win32-input-mode every Ctrl+Enter
 *     is a modified VK_RETURN, so an operator who habitually sends with
 *     chat:sendNow and never presses a plain Enter is deferred INDEFINITELY
 *     -- the capsule request AND the auto-clear both wait on a plain Enter
 *     that never comes. Deliberate: a wrong "submitted" there is the mangled
 *     prompt; the deferral is visible (composer-busy refusal every tick,
 *     snapshot `lastNewline:true`) and clears at the next plain Enter.
 * UNCERTAIN SUBMISSION (review of 436c1dd, MED): a plain CR that arrives
 * while the line is UNKNOWN-tainted is not proof of submission either. The
 * taint means an editing control (DEL, backspace, an arrow, an unfinished
 * ESC) may have moved the cursor or changed the text, so the byte before the
 * cursor is whatever the runner last failed to see -- `abc\` + DEL + CR and
 * `abc\` + Left + Right + CR both leave the cursor after a backslash, and
 * that CR is Claude Code's backslash+Enter NEWLINE. Before this fix the CR
 * submitted and cleared the taint ("CR is the only thing that clears
 * unknown"), and the capsule request was typed into the operator's draft.
 * Now such a CR is recorded as `pendingSubmission` {units, taintedAfter}:
 * the line stays dirty, nothing is cleared, and the runner resolves it with
 * EVIDENCE it already reads -- a new non-meta "type":"user" prompt record in
 * the bound transcript past the offset noted when the CR went by
 * (ManagedPtyRunner#_checkPendingSubmission). That record confirms the
 * submission (confirmSubmission -> _submitted) and is the liveness control;
 * no record means the line stays dirty and the guard keeps deferring, with
 * snapshot `pendingSubmission:true` naming the wait. Fail-closed cost: an
 * operator who edits a line and submits it waits one transcript read (one
 * tick) instead of zero; an operator whose edited CR was a newline waits,
 * correctly, until the draft is really sent. A CR on a CLEAN line keeps its
 * zero-latency boundary role above.
 * ORDERED RECEIPTS (review 5480136713, MED): a record is evidence that SOME
 * submission was recorded, not that the latest uncertain CR was. On Claude
 * Code's queued-prompt path a prompt submitted into a busy turn is recorded
 * when it is dequeued at turn end, so the record of an EARLIER prompt A can
 * land after the operator has typed `abc\`, Backspace, Enter -- a newline
 * inside an unsent draft B -- and, attributed to B, declared B's draft
 * empty. Records are written in submission order, so the tracker keeps
 * `outstanding`, a FIFO of every CR that may still produce one:
 *   - a plain CR / plain VK_RETURN keydown on a CLEAN, NON-empty line owes
 *     exactly one record (_cleanSubmission); on a known-empty line it owes
 *     none (Claude Code ignores it) and is not queued;
 *   - an uncertain CR owes one if it submitted, none if it was a newline or
 *     an Enter on an emptied line. It is queued as its own entry, except
 *     when NOTHING was placed and no taint landed since the previous
 *     uncertain CR: then its fate follows that CR's (submitted -> this one is
 *     a no-op; newline -> this one submits the draft) and the two together
 *     owe at most one record, so it takes over that CR's slot.
 * Each operator prompt record the runner reads (noteOperatorPromptRecord)
 * resolves the OLDEST entry. The pending uncertain CR is confirmed by a
 * record only when (a) the popped entry is its own -- nothing older could
 * have produced the record -- or (b) the CR is `certain`: the tracker SAW
 * the byte before the cursor and it was not a backslash, so this Enter
 * submitted whatever the draft was, whichever submission the record belongs
 * to. A CR is certain when the last thing placed before it, after the last
 * taint, was a printable, a paste's final byte or a newline chord (lastByte
 * at the CR: `abcx`, Backspace, `y`, Enter is certain; Backspace or an arrow
 * immediately followed by Enter is not -- review of c011881c, F3), or when
 * nothing at all happened since a previous certain CR. This is sound
 * because Claude Code reads the byte BEFORE THE CURSOR, not the end of the
 * text (measured on Claude Code 2.1.296, 2026-10-12, disposable session:
 * E1-E4 at isPlacedByte above). A record while an older entry is
 * outstanding never confirms a newer uncertain draft.
 * COST, stated: an entry whose record never comes stays at the head and
 * absorbs the next record. Such CRs are real on the host: a dialog answer
 * (arrow or digit + Enter on a permission or model prompt), an Enter on a
 * line a control emptied (Ctrl+C or Ctrl+U, then Enter), a hidden newline.
 * (A hand-typed /help IS recorded, as a <command-name> user record, and
 * settles its slot.) Clean Enters never wait on the queue (zero latency as
 * before) and a `certain` CR confirms at the first record after it, so a
 * stale entry only delays the confirmation of a MAYBE CR -- an Enter whose
 * byte-before-cursor the tracker did not see -- until the operator's next
 * certain or clean prompt is recorded. Chosen over any non-evidence
 * compaction: dropping an entry whose late record is still coming re-opens
 * the misattribution above. The queue is forgotten only when the bound
 * transcript changes (forgetOutstanding at session rebind): records of the
 * old session cannot land in the new file -- except for CRs still QUEUED
 * behind the clear at that moment, which the runner flushes into the NEW
 * session after the wake Enter and whose records therefore land in the new
 * transcript (review of c011881c, F1): those entries are kept.
 * CLOSED (review of 7b3a728, F1): inert sequences after the uncertain CR --
 * the Enter's own win32 keyup, focus/mouse reports, query responses, an
 * empty paste -- used to mark the record taintedAfter through the ESC-
 * arrival taint, so a confirmed EMPTY composer stayed unknown for the rest
 * of the session under win32-input-mode. The record is now snapshotted and
 * restored with the other pre-sequence flags.
 */
export class InputOwnershipTracker {
  constructor() {
    this.mode = 'normal';
    this.sequence = '';
    this.pasteEndProbe = '';
    // ESCs observed since this paste began. Exactly one -- the end marker's
    // own -- means the probe saw nothing but payload; more means a terminal
    // report was interleaved into the paste (or the payload carried an ESC),
    // and the byte before the cursor is not provable (issue #99, paste
    // branch of observe()).
    this.pasteEscapes = 0;
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
    // The last byte KNOWN to sit before the composer cursor, or null when the
    // runner cannot say (fresh, just submitted, or after a control that may
    // have moved the cursor). Only one value is ever consulted: a backslash,
    // which turns the next CR into a newline instead of a submission.
    // Snapshotted on ESC arrival like the flags above so a completed inert
    // sequence (keyup, report) restores it and a decoded printable replaces it.
    this.lastByte = null;
    this.preSequenceLastByte = null;
    // A plain CR observed while the line was unknown-tainted (class comment,
    // UNCERTAIN SUBMISSION): {units: receivedUnits at that CR, taintedAfter:
    // whether any taint landed since, dirtyAfter: whether any CONTENT was
    // placed since}. Null when no such CR is outstanding. Resolved only by
    // confirmSubmission() (transcript evidence, runner-side) or by a later
    // _submitted(); never by a timer. Snapshotted (as a copy) on ESC arrival
    // like the flags above, so an inert sequence restores it unmarked.
    this.pendingSubmission = null;
    this.preSequencePending = null;
    // FIFO of CRs that may still produce an operator prompt record (class
    // comment, ORDERED RECEIPTS): {units}. The pending uncertain CR, when
    // there is one, is always the tail. Popped oldest-first by
    // noteOperatorPromptRecord; never by _submitted(), which clears the
    // composer model but not the records the child still owes.
    this.outstanding = [];
  }

  // Records that this observation tainted the tracker and WHY, bounded and
  // printable: ESC substituted for \e (a raw control byte has no place in a
  // log line), sliced to 80 chars so one runaway sequence can't blow out the
  // refusal detail. Called at every site that sets unknown=true, with the
  // cause captured BEFORE the caller clears/truncates this.sequence.
  _taint(cause) {
    this.unknown = true;
    this.lastTaint = cause.split(ESC).join('\\e').slice(0, 80);
    if (this.pendingSubmission !== null) {
      this.pendingSubmission.taintedAfter = true;
      this.pendingSubmission.dirtyAfter = true;
    }
  }

  // Content landed in the composer after the pending uncertain CR: once that
  // CR is confirmed it no longer implies an EMPTY composer. Called at every
  // site that places text (printable, control byte, paste payload, newline);
  // the fail-closed branches reach it through _taint.
  _contentAfterPending() {
    if (this.pendingSubmission !== null) this.pendingSubmission.dirtyAfter = true;
  }

  // A C0 control (or DEL) that arrived while a sequence was still UNFINISHED
  // (issue #99).
  //
  // ECMA-48 5.4 / DEC STD 070: a C0 control encountered inside a control
  // sequence is EXECUTED IMMEDIATELY and the sequence then resumes as though
  // the control had not been there -- it is not a parameter byte. xterm, vte
  // and xterm.js all implement this. The tracker used to append such a byte to
  // `sequence` instead, so a CR arriving mid-mouse-report never reached the CR
  // boundary below: it submitted on the host, wrote a transcript record, and
  // the tracker booked NOTHING. The report then still matched the focus/mouse
  // whitelist, which restored the pre-report state wholesale, and that
  // unaccounted record later settled the NEXT outstanding entry one record
  // early -- declaring an unsent draft empty and placing the capsule request
  // into it. Measured before this fix (CR inside the report vs outside):
  // 0 slots queued / knownEmpty true / draft gone, against 1 slot / knownEmpty
  // false / draft preserved.
  //
  // Two things are therefore required of every such byte, and ONE of them is
  // not enough:
  //   (a) the line is tainted, with the executed control named in lastTaint;
  //   (b) a CR additionally BOOKS the record it may owe -- it is an uncertain
  //       submission (class comment, UNCERTAIN SUBMISSION), never a clean one:
  //       mid-sequence the runner cannot see the byte before the cursor, and a
  //       child that buffers the whole CSI submits nothing at all. `certain`
  //       is therefore false (before = null), so no unrelated record can
  //       confirm it.
  // And both must SURVIVE the completion of the sequence they arrived in. The
  // whitelist branches below restore the ESC-arrival snapshot wholesale, which
  // would undo (a) and (b) together -- tainting alone does NOT fix this. So the
  // snapshot itself is poisoned here: every restore path (focus/mouse,
  // query-response, win32 keyup, paste start, empty paste) then puts back the
  // TAINTED line with the booked CR still on it, while mouse/focus handling
  // keeps working exactly as before -- the sequence still completes, still
  // matches, still clears `mode`/`sequence`/`activeControl`.
  //
  // Not called for ESC in the string modes (OSC/DCS/SOS/PM/APC), where ESC is
  // the ST introducer rather than an executed control, and not called at all in
  // `paste` mode: bracketed paste exists precisely so that controls in the
  // payload are inert text, and in `escape` mode, where ESC CR is Claude Code's
  // documented Alt+Enter NEWLINE chord and owes no record (class comment).
  _controlInSequence(character, units) {
    // WHICH CRs OWE A RECORD. A mid-sequence CR is booked only when the host
    // could actually have submitted something. The three declines below mirror
    // rules this file already enforces elsewhere; booking regardless put a
    // PHANTOM entry at the head of the FIFO, and a phantom is not harmless --
    // the next genuine receipt is spent on it (`consumed`) while the real
    // entry keeps waiting.
    //
    // (1) EMPTY AND CLEAN at ESC arrival: Claude Code ignores an Enter on an
    // empty composer, and a child that buffered the sequence placed nothing
    // either -- so nothing happened on either branch of the ambiguity. No
    // record, and nothing to be uncertain ABOUT, so this returns before the
    // taint as well: tainting here would manufacture a deferral on a composer
    // that is provably empty. Same reasoning as _cleanSubmission declining to
    // queue an Enter when `wasEmpty`.
    if (character === '\r' && this.preSequenceKnownEmpty && !this.preSequenceUnknown) return;

    // The executed byte is rendered PRINTABLY into the cause (a CR as \r, a
    // LF as \n), on the same reasoning _taint substitutes \e for ESC: this
    // taint's whole job is to make the deferral legible in the refusal log,
    // and a raw control byte has no place in a log line.
    this._taint(`${this.sequence}${JSON.stringify(character).slice(1, -1)}`);
    this.knownEmpty = false;
    this.lastByte = null;

    // (2) A BACKSLASH before the cursor makes Enter a composer NEWLINE, not a
    // submission (PR #59 review, P1) -- the win32 plain-Enter branch reads
    // preSequenceLastByte for exactly this byte, and so must this path. Such a
    // CR owes no record. The line still stays TAINTED: whether the child
    // executed the control at all is unknowable mid-sequence, so the next
    // plain Enter is resolved by evidence instead of guessed at.
    if (character === '\r' && this.preSequenceLastByte !== '\\' && !this.preSequenceKnownEmpty) {
      // The pre-sequence copy, not the live record: this sequence's own ESC
      // arrival already marked the live one (same reasoning as the win32
      // plain-Enter branch).
      this._uncertainSubmission(units, this.preSequencePending, null);
      // (3) THE INVARIANT, ENFORCED RATHER THAN MERELY STATED. A mid-sequence
      // CR can never be `certain`. Passing `before = null` kills only the
      // isPlacedByte disjunct; _uncertainSubmission also derives `certain`
      // from the PREVIOUS record (`quietSince && previous.dirtyAfter`, and
      // `previous.certain`), and an ordinary typed draft after an earlier
      // uncertain CR sets dirtyAfter -- so the flag came back TRUE and let an
      // unrelated, older receipt confirm this CR one record early, declaring a
      // live draft empty. That is #99's own failure mode in a narrower shape.
      // Mid-sequence the runner can see neither the byte before the cursor nor
      // whether the child executed the control, so the answer is always maybe.
      this.pendingSubmission.certain = false;
    }
    this.preSequenceUnknown = true;
    this.preSequenceKnownEmpty = false;
    this.preSequenceLastTaint = this.lastTaint;
    this.preSequenceLastByte = this.lastByte;
    this.preSequencePending = this.pendingSubmission === null
      ? null
      : { ...this.pendingSubmission };
  }

  // A completed sequence proved inert (or a known keystroke): put back the
  // record as it was at ESC arrival. Always a FRESH copy, so the later marks
  // of this sequence's own bytes (an empty paste's end marker, say) can
  // never have reached the snapshot, and so one snapshot can be restored
  // more than once.
  _restorePending() {
    this.pendingSubmission = this.preSequencePending === null
      ? null
      : { ...this.preSequencePending };
  }

  _submitted() {
    this.mode = 'normal';
    this.sequence = '';
    this.pasteEndProbe = '';
    this.pasteEscapes = 0;
    this.knownEmpty = true;
    this.unknown = false;
    this.activePaste = false;
    this.activeControl = false;
    this.lastTaint = null;
    this.lastByte = null;
    this.pendingSubmission = null;
    this.preSequencePending = null;
  }

  // A plain CR (raw, or a plain VK_RETURN keydown) on a CLEAN line: the
  // zero-latency boundary. `wasEmpty` is the composer's emptiness BEFORE this
  // CR (the raw flag, or the pre-sequence copy for the win32 keydown, whose
  // ESC arrival forced the live flag dirty). A non-empty line owes the child
  // one prompt record and is queued so that record can never be read as a
  // later uncertain CR's (class comment, ORDERED RECEIPTS); an Enter on an
  // empty composer owes none.
  _cleanSubmission(units, wasEmpty) {
    if (!wasEmpty) this.outstanding.push({ units });
    this._submitted();
  }

  // A plain CR on an UNKNOWN-tainted line: maybe a submission, maybe the
  // backslash+Enter newline (the taint hides the byte before the cursor).
  // Nothing is cleared. `units` is the receivedUnits count up to and
  // including this CR, so the runner can tell whether anything was typed
  // after it when the evidence arrives. `previous` is the uncertain CR still
  // pending when this one arrived (the live record on the raw path, the
  // pre-sequence copy on the win32 path), or null; it decides how this CR is
  // queued. `before` is the byte known to sit before the cursor at this CR
  // (lastByte, or its pre-sequence copy on the win32 path): a seen printable,
  // paste byte or newline chord makes the CR `certain` -- the Enter submitted
  // -- while a control byte or null (Backspace, arrow, unfinished ESC right
  // before the Enter) leaves it a maybe (class comment, ORDERED RECEIPTS). A
  // later uncertain CR replaces the record: evidence is attributed to the
  // latest one.
  _uncertainSubmission(units, previous, before) {
    const quietSince = previous !== null && !previous.taintedAfter;
    const certain = isPlacedByte(before) || (quietSince && previous.dirtyAfter);
    const tail = this.outstanding[this.outstanding.length - 1];
    if (quietSince && !previous.dirtyAfter && tail !== undefined && tail.units === previous.units) {
      // Nothing placed since the previous uncertain CR: this Enter is a
      // no-op if that one submitted and the draft's submission if it was a
      // newline. One record at most between them -- the slot is taken over,
      // not duplicated, and keeps its place in the order.
      tail.units = units;
    } else {
      this.outstanding.push({ units });
    }
    this.pendingSubmission = {
      units,
      taintedAfter: false,
      dirtyAfter: false,
      certain: certain || (quietSince && previous.certain === true),
    };
    this.knownEmpty = false;
    this.lastByte = null;
  }

  // Runner-side: one operator prompt record was read past the noted offset.
  // It resolves the OLDEST outstanding CR. Returns 'confirmed' when it
  // confirmed the pending uncertain CR (its own entry, or a `certain` CR --
  // class comment, ORDERED RECEIPTS), 'consumed' when it settled an older
  // entry and the pending CR, if any, keeps waiting, or 'unmatched' when
  // nothing was outstanding (a submission this tracker never saw: before a
  // relaunch, say). Never confirms on 'unmatched': no entry, no evidence.
  noteOperatorPromptRecord() {
    const entry = this.outstanding.shift();
    if (entry === undefined) return 'unmatched';
    const pending = this.pendingSubmission;
    if (pending === null) return 'consumed';
    if (entry.units === pending.units || pending.certain === true) {
      this.confirmSubmission();
      return 'confirmed';
    }
    return 'consumed';
  }

  // The bound transcript changed (session rebind after a clear): records of
  // the old session cannot land in the new file, so outstanding entries are
  // forgotten -- except (a) every CR at or past `keepFromUnits`, the units
  // observed before the operator input still QUEUED behind the clear, which
  // the runner flushes into the new session and whose records land in the
  // new transcript (review of c011881c, F1; `>=` errs towards keeping, since
  // a kept stale slot costs latency while a dropped live one re-opens the
  // misattribution), and (b) the pending uncertain CR's own slot, which keeps
  // today's rebind behaviour of waiting for the next record in the new
  // transcript (the composer model is untouched; the runner re-notes the
  // offset against the new file's current size).
  forgetOutstanding(keepFromUnits = Infinity) {
    const pending = this.pendingSubmission;
    const kept = this.outstanding.filter((entry) => entry.units >= keepFromUnits);
    if (pending !== null && !kept.some((entry) => entry.units === pending.units)) {
      kept.push({ units: pending.units });
    }
    this.outstanding = kept;
  }

  // Runner-side evidence (a new operator prompt record in the transcript past
  // the offset noted at the pending CR) says that CR submitted. Nothing
  // PLACED since (dirtyAfter false -- inert sequences such as the Enter's own
  // win32 keyup, focus and mouse reports do not count, review of 7b3a728 F1):
  // the composer is empty, full _submitted(). Content placed since: it is a
  // fresh line the tracker already observed byte-for-byte, so the pre-CR
  // taint is spent -- unless a taint landed after the CR, which stays.
  // Returns true when a pending record was resolved.
  confirmSubmission() {
    const pending = this.pendingSubmission;
    if (pending === null) return false;
    if (!pending.dirtyAfter) {
      // A RECEIPT PROVES SUBMISSION, NOT ARRIVAL (review 5630883337, R1).
      // It says nothing about whether the rest of an unfinished control or
      // paste sequence has reached the runner yet. _submitted() resets the
      // PARSER along with the composer model, and until the inner-CR path
      // existed that was unreachable here: every other way to be pending
      // mid-sequence goes through the ESC-arrival taint, which marks
      // dirtyAfter and so lands in the dirty branch below.
      // _controlInSequence mints a record with dirtyAfter:false while `mode`
      // is ALREADY 'csi', which opened two holes at once -- measured on all
      // three opener shapes (CSI mouse report, focus report, paste opener):
      //   (a) automatic input was RELEASED immediately, because snapshot()'s
      //       knownEmpty is gated only by `activeSequence`, and clearing
      //       mode/activeControl made that gate pass with the final byte
      //       still absent; and
      //   (b) the sequence's remaining bytes were then parsed in NORMAL
      //       mode, so a mouse report's trailing 'M' landed as composer
      //       TEXT -- leaving knownEmpty false even after completion.
      // So the parser is left strictly alone while a sequence is in flight,
      // and the ESC-arrival snapshot is re-pointed at the CONFIRMED state
      // rather than discarded. The sequence then completes exactly as it
      // always did: an inert completion restores that snapshot and releases
      // on this receipt alone -- no second operator Enter and no fabricated
      // receipt -- while a fail-closed completion taints, which is correct,
      // because something unreadable arrived after the submission.
      // Not folded into _submitted(): the win32 plain-Enter branch calls it
      // through _cleanSubmission at a moment when `mode` is still 'csi' and
      // RELIES on it resetting the parser, because that sequence has already
      // completed. Only this boundary can be reached mid-sequence.
      if (this.mode !== 'normal' || this.activeControl || this.activePaste) {
        this.knownEmpty = true;
        this.unknown = false;
        this.lastTaint = null;
        this.lastByte = null;
        this.pendingSubmission = null;
        this.preSequenceUnknown = false;
        this.preSequenceKnownEmpty = true;
        this.preSequenceLastTaint = null;
        this.preSequenceLastByte = null;
        this.preSequencePending = null;
        return true;
      }
      this._submitted();
      return true;
    }
    this.pendingSubmission = null;
    // A sequence in flight at this moment restores from the snapshot when it
    // completes: nulled here so a resolved record can never be resurrected.
    // (Its own ESC arrival marked the live record, which is why this is the
    // dirty branch; the line stays unknown until the next uncertain CR is
    // confirmed in turn -- one extra round, fail-closed.)
    this.preSequencePending = null;
    if (!pending.taintedAfter) {
      this.unknown = false;
      this.lastTaint = null;
    }
    return true;
  }

  // The CR (raw, or a win32 VK_RETURN keydown) was a composer NEWLINE, not a
  // submission: the line stays dirty, nothing is cleared, and the byte before
  // the cursor is now the newline itself -- so a second plain Enter submits.
  _newline() {
    this.knownEmpty = false;
    this.lastByte = '\r';
    this._contentAfterPending();
  }

  observe(data) {
    const text = asText(data);
    // receivedUnits is counted for the whole chunk up front; `seen` walks it
    // so an uncertain CR can record the count up to and including ITSELF, not
    // the chunk's tail ('\rxyz' must not read as "nothing typed since").
    const unitsBefore = this.receivedUnits;
    this.receivedUnits += text.length;
    let seen = 0;

    for (const character of text) {
      seen += character.length;
      if (this.mode === 'paste') {
        this.knownEmpty = false;
        this._contentAfterPending();
        // Seven bytes, not six: the one before the end marker is the last
        // PAYLOAD byte, which now sits before the cursor -- a paste ending
        // in a backslash makes the operator's next Enter a newline too.
        if (character === '\u001b') this.pasteEscapes += 1;
        this.pasteEndProbe = `${this.pasteEndProbe}${character}`.slice(-7);
        if (this.pasteEndProbe.endsWith('\u001b[201~')) {
          // SECOND-ORDER CASE (issue #99): a terminal emits focus and mouse
          // reports whenever the window is touched, INCLUDING while a paste is
          // being delivered, and those bytes arrive interleaved on the same
          // wire between the two markers. The probe cannot tell them from
          // payload, so a report landing just before the end marker made
          // `lastByte` the report's final 'M' instead of the payload's real
          // trailing byte. Measured: `ESC[200~abc\ ESC[<0;10;5M ESC[201~` then
          // Enter read as a CLEAN SUBMISSION (knownEmpty true, one slot
          // queued) where the same paste without the report correctly read as
          // a backslash NEWLINE -- so the request was placed into the
          // operator's unsent pasted draft.
          // Exactly one ESC belongs to this paste: the end marker's own. More
          // than one means a sequence was interleaved (or the payload itself
          // carried an ESC), and either way the byte before the cursor is no
          // longer provable -- so it is `null` and the line is tainted rather
          // than trusted. Cost: one deferral until the operator's next plain
          // Enter resolves against transcript evidence, the same fail-closed
          // price every other ambiguity in this file pays.
          const interleaved = this.pasteEscapes > 1;
          if (interleaved) this._taint(this.pasteEndProbe);
          // An EMPTY paste places nothing: the byte before the cursor is
          // still whatever preceded the paste-start sequence -- and the
          // pending record goes back to its ESC-arrival snapshot, since the
          // end marker's own bytes marked it dirty above.
          if (this.pasteEndProbe.length === 7) {
            this.lastByte = interleaved ? null : this.pasteEndProbe[0];
          } else {
            this.lastByte = this.preSequenceLastByte;
            this._restorePending();
          }
          this.mode = 'normal';
          this.pasteEndProbe = '';
          this.pasteEscapes = 0;
          this.activePaste = false;
          this.activeControl = false;
        }
        continue;
      }

      if (character === '\r' && this.mode === 'normal') {
        // Backslash + Enter is Claude Code's documented newline: the CR is a
        // composer edit, not a boundary (PR #59 review, P1). Same chunk or
        // split across chunks -- lastByte carries across observe() calls.
        if (this.lastByte === '\\') {
          this._newline();
          continue;
        }
        // Unknown-tainted line: the byte before the cursor may be a
        // backslash the runner never saw move into place. Not proof of
        // submission -- recorded, and resolved by transcript evidence
        // (class comment, UNCERTAIN SUBMISSION).
        if (this.unknown) {
          this._uncertainSubmission(unitsBefore + seen, this.pendingSubmission, this.lastByte);
          continue;
        }
        this._cleanSubmission(unitsBefore + seen, this.knownEmpty);
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
        // A C0 control (or DEL) here is EXECUTED, not a parameter byte
        // (issue #99, _controlInSequence). `continue` without appending is
        // the standards-correct model: the sequence resumes unaffected, so a
        // mouse report split by a CR still matches the whitelist below and
        // a paste start split by one is still a paste start -- only now on a
        // line that stays tainted with the CR booked.
        const inner = character.codePointAt(0);
        if (inner < 0x20 || inner === 0x7f) {
          this._controlInSequence(character, unitsBefore + seen);
          continue;
        }
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
            // A completed paste start proves the ESC was not an editing
            // control: its payload is observed byte-for-byte and lands at
            // the cursor, so the ESC-arrival poison is lifted exactly as the
            // report whitelists below do. Without this every paste left the
            // line unknown-tainted (lastTaint "\e") and, now that a CR on a
            // tainted line waits for evidence, the Enter after a paste would
            // wait too -- while knownEmpty stays false through the paste.
            this.unknown = this.preSequenceUnknown;
            this.lastTaint = this.preSequenceLastTaint;
            this._restorePending();
            // A paste IS content (review of 4e71bb3, F3): marked here, at
            // the start, so a confirmation that lands between this chunk and
            // the payload chunk cannot read the record as "nothing placed
            // since" and _submitted() the tracker mid-paste -- the request
            // would fire into a composer the payload then lands on. The
            // empty-paste end marker restores the unmarked snapshot, so an
            // empty paste still confirms EMPTY.
            this._contentAfterPending();
            this.mode = 'paste';
            this.sequence = '';
            this.activePaste = true;
            this.activeControl = false;
            this.pasteEndProbe = '';
            this.pasteEscapes = 0;
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
            this.lastByte = this.preSequenceLastByte;
            this._restorePending();
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
            this.lastByte = this.preSequenceLastByte;
            this._restorePending();
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
              // semantics as the report whitelists above. The Enter's own
              // keyup always follows an uncertain keydown on the live wire,
              // so this restore is what keeps that CR confirmable as EMPTY
              // (review of 7b3a728, F1).
              this.unknown = this.preSequenceUnknown;
              this.knownEmpty = this.preSequenceKnownEmpty;
              this.lastTaint = this.preSequenceLastTaint;
              this.lastByte = this.preSequenceLastByte;
              this._restorePending();
              this.mode = 'normal';
              this.sequence = '';
              this.activeControl = false;
            } else if (event.kd === 1 && event.vk === VK_RETURN
              && ((event.cs & WIN32_CS_MODIFIER_MASK) !== 0 || this.preSequenceLastByte === '\\')) {
              // KEYDOWN Enter with a HELD modifier (Shift/Ctrl/Alt), or
              // right after a backslash: a composer newline chord (Shift,
              // Alt, backslash) or at best an unverifiable send (Ctrl, see
              // the class comment) -- never PROOF of submission (PR #59
              // review, P1: ESC[13;28;13;1;16;1_ is Shift+Enter,
              // SHIFT_PRESSED=0x10). Treated like the printable branch
              // below: dirty, unknown/lastTaint restored, no taint added.
              // Lock/enhanced bits are masked out by WIN32_CS_MODIFIER_MASK.
              this.unknown = this.preSequenceUnknown;
              this.lastTaint = this.preSequenceLastTaint;
              this._restorePending();
              this._newline();
              this.mode = 'normal';
              this.sequence = '';
              this.activeControl = false;
            } else if (event.kd === 1 && event.vk === VK_RETURN) {
              // KEYDOWN plain Enter: identical submission semantics to a raw
              // CR, including the uncertain case -- on a line that was
              // unknown-tainted BEFORE this event (the ESC arrival itself
              // taints, so the pre-sequence flag is the one that counts) it
              // is recorded, not trusted, and the transcript decides.
              if (this.preSequenceUnknown) {
                this.unknown = true;
                this.lastTaint = this.preSequenceLastTaint;
                // The pre-sequence copy, not the live record: this event's
                // own ESC arrival already marked the live one.
                this._uncertainSubmission(unitsBefore + seen, this.preSequencePending, this.preSequenceLastByte);
                this.mode = 'normal';
                this.sequence = '';
                this.activeControl = false;
              } else {
                this._cleanSubmission(unitsBefore + seen, this.preSequenceKnownEmpty);
              }
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
              this.lastByte = String.fromCodePoint(event.uc);
              this._restorePending();
              this._contentAfterPending();
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
        // Executed control inside the string (issue #99). BEL terminates an
        // OSC and ESC introduces its ST, so neither is an executed control
        // here; every other C0 is. These modes already taint on completion,
        // so what this adds is the missing ACCOUNTING for a CR -- the record
        // the child owes when it executes one mid-string.
        if (isExecutedControlInString(character)) {
          this._controlInSequence(character, unitsBefore + seen);
          continue;
        }
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
        // Same rule as the OSC branch above (issue #99): ESC introduces ST,
        // every other C0 is executed.
        if (isExecutedControlInString(character)) {
          this._controlInSequence(character, unitsBefore + seen);
          continue;
        }
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
        // Null until the sequence proves inert (restore) or decodes to a
        // printable (replace): a tainting control may have moved the cursor,
        // so a CR after it keeps the pre-existing boundary semantics.
        this.preSequenceLastByte = this.lastByte;
        this.lastByte = null;
        // A COPY of the pending record, taken before the arrival taint marks
        // it: every branch that proves the sequence inert (or a known
        // keystroke) restores this copy, so only a fail-closed completion
        // leaves taintedAfter/dirtyAfter set (review of 7b3a728, F1).
        this.preSequencePending = this.pendingSubmission === null
          ? null
          : { ...this.pendingSubmission };
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
      this.lastByte = character;
      this._contentAfterPending();
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
      // Diagnosability (PR #59 review of 8d4a8b4): a deferral after a newline
      // chord read {knownEmpty:false, unknown:false, lastTaint:null} --
      // indistinguishable from typed text. lastByte is JSON-escaped so the
      // refusal log stays printable (a CR renders as \r, a backslash as \\);
      // lastNewline names the mechanism outright: the last composer event
      // was a newline chord (backslash+Enter or a modified Enter), and the
      // request waits on a PLAIN Enter.
      lastByte: this.lastByte === null ? null : JSON.stringify(this.lastByte).slice(1, -1),
      lastNewline: this.lastByte === '\r',
      // Names the wait outright: a plain Enter went by on a tainted line and
      // the runner is waiting for the transcript to show the prompt it sent.
      pendingSubmission: this.pendingSubmission !== null,
      // How many earlier CRs the record must get past before it can be this
      // one's (class comment, ORDERED RECEIPTS): a deferral with
      // pendingSubmission:true and outstanding > 1 is waiting on an older
      // prompt's record, not on its own.
      outstanding: this.outstanding.length,
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

const CAPSULE_ACK_WINDOW_BYTES = 262144;
// How many unanswered retired capsule requests the ledger will carry at once
// (#90/#91 review, R1). One is the measured shape (abandon, replace, late
// answer); the headroom covers a seat that churns cycles faster than it
// answers. Past it the ledger stops growing and says so, rather than becoming
// an unbounded list fed by a loop the runner does not control.
const CAPSULE_RETIRED_REQUEST_MAX = 8;
// The ack is the LAST non-empty line of an assistant record's last text block
// (a trailing ``` fence line is ignored) that, trimmed, equals the literal after
// at most one trailing period and ONE symmetric wrapper (backticks, ** or __,
// which the capsule skill's reuse path renders; a period may sit inside or
// outside it). A bullet, a single-character wrapper, prose, or the literal
// quoted mid-text never matches.
function stripAckWrapper(line) {
  const dropDot = (t) => t.replace(/\.$/, '');
  const m = dropDot(line.trim()).match(/^(`+|\*\*|__)?(.*?)\1$/);
  if (!m) return '';
  return (m[1] ? dropDot(m[2]) : m[2]).trim();
}
// The one reader of whole JSONL lines. Reads at most maxBytes from `from` and
// returns only COMPLETE (newline-terminated) lines, plus the offset to resume
// at: past the last complete line, or past the window when ONE record fills a
// FULL window with no newline (so it can never pin the offset). A shorter,
// half-written tail keeps the offset where it is and is read again next time.
// The length comes from readSync, so a short read after a truncation is never
// parsed as transcript.
function readCompleteLines(file, from, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes);
  const fd = fs.openSync(file, 'r');
  let n = 0;
  try { n = fs.readSync(fd, buffer, 0, maxBytes, from); } finally { fs.closeSync(fd); }
  const lines = [];
  // `ends[i]` is the ABSOLUTE offset just past line i's newline. The retired
  // request drain (#90/#91 review, R1) has to say where a consumed
  // acknowledgement ended, so the live cycle's window can be advanced past
  // exactly that literal and no further -- advancing it to the end of the read
  // window instead would swallow a legitimate answer that landed in the same
  // interval.
  const ends = [];
  let consumed = 0;
  for (let pos = 0; pos < n;) {
    const nl = buffer.indexOf(0x0a, pos);
    if (nl < 0 || nl >= n) break;
    lines.push(buffer.subarray(pos, nl));
    pos = nl + 1;
    consumed = pos;
    ends.push(from + pos);
  }
  const skipped = lines.length === 0 && n === maxBytes;
  return { lines, ends, skipped, nextOffset: from + (skipped ? n : consumed) };
}
// Does this complete line carry an ack the seat itself said? Byte prefilter
// first so only candidates are decoded. Sidechain (subagent) records never count.
function isAckLine(buf) {
  if (!buf.includes(CAPSULE_ACK_LITERAL)) return false;
  let record;
  try { record = JSON.parse(buf.toString('utf8')); } catch { return false; }
  if (record?.type !== 'assistant' || record.isSidechain === true
    || !Array.isArray(record.message?.content)) return false;
  const texts = record.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string');
  const lastText = texts[texts.length - 1];
  if (!lastText) return false;
  const textLines = lastText.text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (textLines[textLines.length - 1] === '```') textLines.pop();
  return textLines.length > 0 && stripAckWrapper(textLines[textLines.length - 1]) === CAPSULE_ACK_LITERAL;
}
// Does this complete line carry a capsule request, as the HOST recorded it?
// The request is submitted as a prompt, so Claude Code writes it into the
// transcript as a "user" record carrying the command text — the one record the
// runner can point at and say "that is a request that reached the seat".
//
// This is request/response PROVENANCE, not arrival time (#90/#91 review, R1).
// It does two jobs, both about ORDER rather than about clocks:
//   - it marks the moment a cycle's own request reached the host, so a retired
//     cycle's request record can be told apart from the live cycle's;
//   - prompts are processed in submission order, so once a LATER request's
//     record exists, every answer an EARLIER request could still produce has
//     already been written. That is what lets the retired-request drain below
//     terminate on evidence instead of waiting for an answer never coming.
// Sidechain (subagent) records are never the seat's own prompt.
function isCapsuleRequestRecord(buf) {
  if (!buf.includes(CAPSULE_REQUEST_TEXT)) return false;
  let record;
  try { record = JSON.parse(buf.toString('utf8')); } catch { return false; }
  if (!record || record.type !== 'user' || record.isSidechain === true) return false;
  const content = record.message?.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return typeof text === 'string' && text.includes(CAPSULE_REQUEST_TEXT);
}

// ─── OUTSTANDING TOOL CALLS (#104) ───────────────────────────────────────────
// WHY: _writeCapsuleRequest's only write gate was `composer.knownEmpty`, which
// models the composer TEXT LINE and knows nothing about a modal dialog. With a
// permission dialog on screen and nothing typed, knownEmpty is true -- so the
// runner wrote its request text plus a CONTROL_ENTER, and a bare Enter at that
// dialog selects option 1, "Yes". One row down is "Yes, and switch to accept
// edits ... for this session", which would disable prompting for the rest of
// the session. Measured on binary 2.1.309 (capture 2026-10-23T16:09Z):
//
//   16:09:55.083Z  tool_use   toolu_016Dhtgz... name=Read   written
//   16:09:55.993Z  permission dialog on screen
//   16:09:57.195Z  ESC sent
//   16:09:57.250Z  tool_result for that id, is_error:true, "The user doesn't
//                  want to proceed with this tool use..."
//
// THE SIGNAL: while the dialog is open the transcript holds a `tool_use` with
// no matching `tool_result`. The pairing completes either way (an answer, a
// cancellation, an error), so a post-hoc read of a finished transcript shows
// zero unanswered ids -- the signal exists only while it matters, which is why
// it has to be read live at the write boundary and not reconstructed later.
//
// WHAT IS NOT USED: the transcript records "permissionMode":"default" even when
// the child was launched with `--permission-mode manual` (verified in the same
// capture). The transcript's mode vocabulary is not the CLI's, so nothing here
// keys on that value.
const TOOL_CALL_WINDOW_BYTES = CAPSULE_ACK_WINDOW_BYTES;
// How far back the baseline walks to find an ANCHOR (see toolCallRecord): four
// windows, once per transcript bind, never per tick. The measured capture's
// last top-level assistant record sat 177k before the end of a 465k file, so
// one window would have anchored it; four is headroom for an attachment-heavy
// tail. Past it the reader is DEGRADED and says so -- it never guesses empty.
const TOOL_CALL_BASELINE_WINDOWS = 4;
// How many READS the baseline may spend walking that span. It is not the same
// number, and the difference is measured rather than cosmetic: readCompleteLines
// consumes only up to the LAST COMPLETE LINE in a window, so a transcript of
// 200 KiB records advances ~200 KiB per 256 KiB read. Four reads would then
// cover ~800 KiB of a 1 MiB span and the walk would stop short of an anchor
// that is actually in it -- reporting "unanchored" for a transcript the reader
// could have read. Twice the windows is enough slack for any record size that
// still fits in one window; a span the budget cannot cross is an honest
// `tool-call-baseline-unanchored`.
const TOOL_CALL_BASELINE_READS = TOOL_CALL_BASELINE_WINDOWS * 2;
// How many windows one readiness check will read to catch the cursor up to the
// transcript's end. A reader that is still behind after this is NOT READY
// (`runner-tool-call-reader-behind`) rather than answering from a stale set:
// the cursor keeps its ground and the next check continues forward.
const TOOL_CALL_CATCHUP_WINDOWS = 4;
// How many outstanding ids a refusal detail names before it summarises. The
// detail is a diagnostic, not the state.
const TOOL_CALL_NAMED_MAX = 8;
// How many times a DELAYED automatic Enter may be rescheduled while a tool call
// is outstanding, before the text it would have submitted is declared stranded.
// 150 reschedules at the default 400 ms controlEnterDelayMs is a minute, which
// covers an ordinary tool execution (the measured capture's Read settled in
// 2.2 s, and that was with a human pressing ESC) by a wide margin while staying
// a bounded number of timer fires rather than an open-ended loop. Past it the
// Enter is NOT written: stranding the line loudly is correct, because the Enter
// is the defect.
const AUTOMATIC_ENTER_DEFERRAL_LIMIT = 150;
// ─── WHICH BOUNDARIES MAY READ AN ABSENT TRANSCRIPT AS "NO CALLS" ────────────
// The absence argument -- "the host has written no records, so no tool dialog
// can exist" -- is sound only where the bound session can genuinely not have a
// transcript yet. That is the post-clear WAKE family and nothing else: it runs
// on a context the host has just rebuilt, before its first record exists, and
// the deterministic suite asserts exactly that.
//
// At the capsule-request and clear boundaries the same answer is a FAIL-OPEN.
// Those fire because the session reached ~80% context pressure, so that session
// provably HAS a transcript; ENOENT there cannot mean "no records yet", it means
// the path mis-resolved (wrong session id, wrong cwd, wrong home). Answering
// ready would write command text plus a bare Enter into a session the runner
// cannot see -- #104 by a sixth route.
//
// STRICTNESS COMES FROM THE BOUNDARY, not from what the reader has observed.
// The tempting alternative -- permit absence until this binding has seen its
// first record -- is boundary-agnostic and breaks on restart: a relaunched
// process has seen nothing, so a capsule boundary immediately post-restart
// would be permitted again, which is the mis-resolution case. A boundary
// survives a restart; accumulated observation does not (D44).
//
// An unlisted boundary is STRICT. A new write site therefore gets the
// fail-closed answer by default rather than inheriting the exemption.
// The boundaries entitled to read an ABSENT or EMPTY transcript as "no records,
// so no dialog": the post-clear wake family, which runs before the new
// session's first record exists. Every other boundary (capsule request, its
// Enter, the clear, a control) fires for a session under context pressure,
// which provably has records; absence or emptiness there says the reader is
// not looking at the live transcript (#110, #111). A frozen array, not a frozen
// Set: freezing a Set does not stop `.add()`.
const ABSENT_TRANSCRIPT_READY_AT = Object.freeze(['wake-enter-retry']);

// ─── THE BOUNDED PRE-PERMISSION INTERLOCK (#104, after #110) ─────────────────
// #110 gated every automatic write on the transcript. MEASURED on 2.1.310 (run
// 2026-10-24T21:07Z) that signal was NOT ON DISK while the dialog was on
// screen: the tool_use record occupied bytes 286521-288638 and the file was
// 283263 bytes at all three samples -- not partially written, not flushed at
// all. Readiness said `ready: true` with a real permission prompt up, and the
// flush carrying both the call and its answer arrived only after the
// cancellation: creation-to-readability >= 2.44 s. One run in four.
//
// So the evidence now comes from somewhere CAUSAL. daemons/pre-permission-
// interlock.mjs is a PreToolUse/PostToolUse/Stop hook that the host runs
// synchronously BEFORE the permission check, and the runner and that hook take
// THE SAME GATE around their respective critical sections. The full argument --
// why this is a mutex rather than a second file to poll, where the bounded
// waits are, which way the fallback fails, and the four legs of the liveness
// proof -- is in that file's header and in docs/dialog-readiness.md. What lives
// here is only the runner's half.
//
// BOTH READERS STAY. The interlock is the primary mechanism and the transcript
// reader is the second: they fail in different directions (the interlock cannot
// see a call the host issued before the hook got the gate; the transcript
// cannot see a call the host has not flushed) and readiness requires BOTH to
// say yes.
//
// How far a pending marker's age goes before the hold is renamed. It is NOT a
// release: a human can read a dialog for minutes, and age cannot tell that from
// an orphaned marker, so both hold and only the NAME changes. The bound exists
// so the operator can tell the two apart in the log.
const INTERLOCK_PENDING_STALE_MS = 120000;
// How many recently SETTLED tool_use ids the reader remembers, so the interlock
// can discount a marker whose call the transcript has answered. A recent-history
// lookup, not a ledger: the only ids that matter are ones a pending marker still
// names, and a marker lives for one permission check. Dropped on re-baseline
// with the rest of the watch, which is fail-closed (the marker is then held
// until a Stop sweep).
const TOOL_CALL_SETTLED_MEMORY = 512;
// Where the runner looks for the hook wiring. These are the files THIS product
// installs and THIS runner can read: install.sh renders .claude/settings.json
// from .claude/settings.json.template, so a correct aigent-OS install always
// matches here. An exotic install that wires the hook somewhere the runner
// cannot read (managed enterprise settings) fails CLOSED and says so by name
// rather than being assumed fine -- that trade is stated in the doc.
// PROJECT-level files only. The USER-level one is resolved separately, because
// `CLAUDE_CONFIG_DIR` moves it -- see _interlockUserSettingsFile.
const INTERLOCK_WIRING_FILES = Object.freeze([
  ['.claude', 'settings.json'],
  ['.claude', 'settings.local.json'],
]);
const INTERLOCK_HOOK_FILE = 'pre-permission-interlock.mjs';
const BACKSLASH = String.fromCharCode(92);
// ─── THE SPELLING install.sh ACTUALLY RENDERS (N1) ──────────────────────────
// The wiring leg compares a command string from settings.json against the
// resolved sibling hook, and an anchored comparison of raw strings REJECTED
// EVERY REAL WINDOWS INSTALL. install.sh renders paths through `abspath` ->
// `cygpath -u`, so a rendered file carries the MSYS spelling:
//
//   node "/c/aigent-recovery/canary-seat/daemons/sessionstart-reinject.mjs"
//
// while the runner resolves its own sibling as `C:/...`. `"/c/..."` does not
// contain `"c:/..."`, so a correctly installed Windows seat read as
// `interlock-hook-not-wired` on every tick and held every automatic write for
// ever -- fail-closed but total, on the platform the product runs on, from the
// installer the product ships. Verified against two independently installed
// trees on this host.
//
// The two spellings are therefore canonicalised to one before comparison:
// lowercased, separators unified, and a leading `/<drive>/` folded to
// `<drive>:/`. BOTH SIDES go through the same transform, so this is a
// normalisation rather than a loosening -- a path under a different root still
// fails to match, including one written in the other spelling.
//
// NOTE (measured, N10): this is only about the FILE's content. The host does
// convert the command path and `env.AIGENT_ROOT` to native form before the hook
// process sees them, so the hook and the runner resolve the same interlock
// root. The runner reads the settings file directly, with no shell in between,
// which is why it sees the MSYS spelling and has to understand it.
function comparablePath(value) {
  if (typeof value !== 'string') return '';
  let unified = value.toLowerCase().split(BACKSLASH).join('/');
  // DOUBLED SEPARATORS COLLAPSE (F-D). install.sh's `shell_double_quoted`
  // escapes backslashes, so a rendered command can carry `node "c:\\dev\\..."`,
  // which unifies to `c://dev//...` and then matched nothing. Narrower than N1
  // -- it needs cygpath to be unavailable AND the path to carry backslashes --
  // and fail-closed, but the same class of defect.
  //
  // A `//` AT A TOKEN BOUNDARY IS PRESERVED, because that is a UNC prefix
  // (`\\server\share`) and flattening it would make two different roots
  // compare equal. UNC paths are otherwise unhandled here, which is named in
  // the doc rather than silently half-supported.
  //
  // THE FIRST VERSION OF THIS TESTED `startsWith('//')` ON THE WHOLE VALUE,
  // which only fires when the value IS a bare path -- true of the resolved
  // sibling, false of a settings COMMAND, which begins `node `. So a quoted UNC
  // prefix was flattened and a share named `c` matched drive `C:`:
  //
  //   node "\\\\c\\dev\\...\\pre-permission-interlock.mjs"  ->  node "c:/dev/..."
  //
  // read as WIRED. Exotic -- it needs a share whose name is a single letter
  // equal to the runner's drive -- and it weakens only the wiring leg, since
  // legs 1 and 2 still anchor on the sibling's own sha256 and leg 3 still needs
  // the host to have run something that writes this nonce. But it is a
  // LOOSENING of exactly the property the anchoring exists for, introduced by
  // the fix for a rejection bug: the recurring shape of this whole issue.
  //
  // The detection is PER TOKEN now, on the same boundary the drive-fold below
  // keys on, so the two agree about where a path starts.
  const UNC_MARK = String.fromCharCode(1);
  unified = unified.replace(/(^|[\s"'=(])\/\//g, `$1${UNC_MARK}`);
  unified = unified.replace(/\/{2,}/g, '/');
  unified = unified.split(UNC_MARK).join('//');
  // `/c/x` -> `c:/x`, at a token boundary so ordinary absolute POSIX paths
  // (`/usr/...`, `/some/other/install/...`) are left alone.
  return unified.replace(/(^|[\s"'=(])\/([a-z])\//g, '$1$2:/');
}
// Every PreToolUse event must reach the hook, so the wiring must carry a
// matcher that matches every tool. An empty matcher is the template's form; '*'
// and '.*' are the other two spellings of the same thing.
const INTERLOCK_WIRING_MATCHERS = Object.freeze(new Set(['', '*', '.*']));
// The hook events the runner requires to be wired. PreToolUse is the interlock
// itself. Stop is what bounds an orphaned marker: a cancelled tool call gets no
// PostToolUse (measured 2026-10-25, binary 2.1.310 -- the denied Read produced
// PreToolUse and no PostToolUse, while the allowed Glob produced both), and a
// dialog cannot be on screen once the turn has ended.
const INTERLOCK_REQUIRED_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'Stop']);

const TOOL_USE_MARKER = '"tool_use"';
const TOOL_RESULT_MARKER = '"tool_result"';
const ASSISTANT_TYPE_MARKER = '"type":"assistant"';
const TOOL_CALL_OPAQUE = Object.freeze({ kind: 'opaque' });
const TOOL_CALL_UNREADABLE = Object.freeze({ kind: 'unreadable' });

// What one COMPLETE transcript line says about outstanding tool calls.
//
//   {kind:'assistant', opens:[id...]}  a new assistant turn, opening these ids
//   {kind:'results',   settles:[id...]} the host's answers to those ids
//   {kind:'opaque'}                    nothing to say
//   {kind:'unreadable'}                carries a marker but will not parse, or
//                                      carries a call that cannot be named
//
// THE CARRIERS ARE MEASURED, NOT GUESSED. In the #104 capture the only records
// carrying these blocks were `assistant/tool_use` (x2), `user/tool_result` (x2)
// and `api-request-blob/tool_result` (x1). The blob is a REPLAY of the request
// payload, not an event -- so settlement is read ONLY from a top-level
// `"type":"user"` record. Admitting the blob would let a replay of an old
// answer release a call that is open right now, which is the fail-open this
// whole unit exists to prevent.
//
// AND THE BLOB'S POSITION IS NOT EVEN STABLE, which turns that from a tidy
// rule into a load-bearing one. On 2.1.309 the blob FOLLOWED the authoritative
// record. Measured again on 2.1.310 (live run 2026-10-24T18:59Z, session
// a1b3a275) it PRECEDED it, by offset and by 0.76 s of wall clock:
//
//   451495  assistant         18:59:02.114Z  tool_use    toolu_01Rhprv... (Glob)
//   453586  api-request-blob  (no timestamp)  tool_result toolu_01Rhprv...
//   455821  user              18:59:02.870Z  tool_result toolu_01Rhprv...
//
// A reader that accepted the blob would therefore release the call EARLY, on a
// record the host has not yet committed as the answer -- not merely duplicate a
// settlement it already held.
//
// THE ASYMMETRY IS THE SAFETY PROPERTY. Missing an OPEN and inventing a SETTLE
// are the two fail-open mistakes:
//   - a tool_use block with no usable `id` is UNREADABLE, never ignored: a call
//     that cannot be named is a call that cannot be paired;
//   - a tool_result block with no usable `tool_use_id` settles nothing;
//   - a line that carries a marker and will not parse is UNREADABLE.
// Sidechain (subagent) records are deliberately INCLUDED on both sides: a
// subagent's tool call raises the same dialog on the same screen, so excluding
// it would be a fail-open, and excluding only its answers would be a wedge.
//
// A NEW API RESPONSE IS THE ANCHOR -- not merely a new assistant RECORD, and
// the difference is a fail-open. The API cannot be called again while any
// tool_use in the previous assistant message is unanswered, so a new RESPONSE
// proves every call from earlier responses has been answered. That protocol
// fact is what lets a bounded tail read establish the whole outstanding set
// without reading from byte zero, and what discharges an unread region (an
// oversize record stepped over) or a restart's unknown prefix.
//
// BUT ONE RESPONSE IS WRITTEN AS SEVERAL TOP-LEVEL `assistant` RECORDS, one per
// content block, and that is measured, not supposed. Both captures show it:
//
//   blockIdx=0  reqId=req_011CgMaKpY...  msg.id=msg_011CgMaKpq...  thinking
//   blockIdx=1  reqId=req_011CgMaKpY...  msg.id=msg_011CgMaKpq...  tool_use
//
// So a response that issues PARALLEL tool calls lands as two records carrying
// `tool_use` under ONE response id. A rule that cleared the set on every
// assistant record would therefore drop call A the moment call B's record
// arrived -- and once B's own result settled B, the set would read EMPTY with
// A's dialog still on screen. Exactly the fail-open this unit exists to stop.
// (The block splitting is measured; the parallel-call shape is inferred from
// it, because both captures ran haiku issuing one tool at a time.)
//
// The anchor is therefore scoped to the response identity -- `message.id`, the
// API's own id for the response, with `requestId` as a fallback -- and the
// `unknownOpen` DISCHARGE additionally requires `apiBlockIndex === 0`, proof
// that this record is the START of its response. A window that began in the
// MIDDLE of a response cannot discharge calls it never saw, because an earlier
// block of that same response may have opened one.
//
// If either field ever disappears from the format the reader goes conservative,
// never permissive: no clear and no discharge, so a baseline reports
// `tool-call-baseline-unanchored` -- loud and fail-closed.
function toolCallRecord(buf) {
  if (!buf.includes(TOOL_USE_MARKER)
    && !buf.includes(TOOL_RESULT_MARKER)
    && !buf.includes(ASSISTANT_TYPE_MARKER)) return TOOL_CALL_OPAQUE;
  let record;
  try { record = JSON.parse(buf.toString('utf8')); } catch { return TOOL_CALL_UNREADABLE; }
  if (!record || typeof record !== 'object') return TOOL_CALL_OPAQUE;
  const content = Array.isArray(record.message?.content) ? record.message.content : null;
  if (record.type === 'assistant') {
    const opens = [];
    if (content) {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        if (typeof block.id !== 'string' || block.id.length === 0) return TOOL_CALL_UNREADABLE;
        opens.push(block.id);
      }
    }
    const id = record.message?.id;
    const req = record.requestId;
    // A SIDECHAIN (SUBAGENT) RESPONSE IS NOT AN ANCHOR, and that is a fail-open
    // if it is missed. Its calls still COUNT -- a subagent's tool call raises
    // the same dialog on the same screen, which is why D5 exists -- but the
    // record belongs to a DIFFERENT conversation, so the API having been called
    // for IT proves nothing about the main conversation's outstanding calls.
    //
    // MEASURED SHAPE (2026-10-24, a real subagents/ transcript): a sidechain
    // assistant record carries its own `message.id`, `requestId` AND
    // `apiBlockIndex` (0 thinking, 1 text, 2 tool_use under one id). So without
    // this exclusion it satisfies BOTH `fresh` and `startsResponse`, and it
    // would clear -- and discharge the unknown prefix for -- a main-conversation
    // call whose dialog is on screen. That is leg 6's fail-open by another
    // route, and it is the same exclusion the ack and capsule-request readers
    // already make (isAckLine, isCapsuleRequestRecord, both added for #79).
    //
    // ON REACHABILITY, stated rather than implied: on the binary measured here
    // (2.1.310) subagent records are written to a SEPARATE
    // `subagents/agent-*.jsonl` file and the bound transcript holds none of
    // them, so this is defence for the inline shape rather than a live defect
    // fix. The inline shape is what #79 had to exclude, and the suite's own D5
    // asserts it, so the reader does not get to assume it away.
    const sidechain = record.isSidechain === true;
    return {
      kind: 'assistant',
      opens,
      // The response this record is a block of. Null when neither field is
      // usable, which the caller treats as "cannot say", never as "new".
      // TAGGED WITH ITS IDENTITY SPACE (#104 S2). The bare fallback mixed two
      // namespaces: one response whose block 0 carried only `requestId` and
      // whose block 1 carried only `message.id` produced two different strings,
      // so block 1 read as a NEW response and cleared block 0's live call. The
      // tag makes a space change visible to the caller, which treats it as
      // "cannot say" rather than as news -- which is what the "conservative,
      // never permissive" claim always said and did not do.
      response: sidechain
        ? null
        : (typeof id === 'string' && id.length > 0
          ? `msg:${id}`
          : (typeof req === 'string' && req.length > 0 ? `req:${req}` : null)),
      // True only when this record is provably the FIRST block of its response.
      startsResponse: !sidechain && record.apiBlockIndex === 0,
    };
  }
  if (record.type === 'user' && content) {
    const settles = [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      if (typeof block.tool_use_id !== 'string' || block.tool_use_id.length === 0) continue;
      settles.push(block.tool_use_id);
    }
    if (settles.length > 0) return { kind: 'results', settles };
  }
  return TOOL_CALL_OPAQUE;
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
    // The EFFECTIVE reason last emitted as an `automation-disabled` event, or
    // null before the first one. _disableAutomation runs its whole cleanup on
    // every poll (a kill switch is re-read each tick), but the event is a
    // state-change log: without this, a held kill switch emitted one event per
    // tick -- measured on a contained seat at +330 events in 30s (~11/sec,
    // ~145 MB/day of daemon log). Compared AFTER this method's own rewrites of
    // code/detail, so a genuine change of reason still speaks up.
    this.automationDisabledReason = null;
    this.controlWriteAttempts = 0;
    this.capsuleRequestCycleId = null;
    // Composer guard: the cycle whose request was deferred behind operator
    // text (or uncertain input ownership). Diagnostic latch only — it makes
    // the deferral a once-per-cycle event; the request itself stays pending.
    this.capsuleRequestDeferredCycleId = null;
    // Receipt watch for the tracker's outstanding CRs: {transcript, offset,
    // midLine}. Noted when the queue goes from empty to non-empty, scanned
    // each tick by _checkPendingSubmission for new operator prompt records,
    // which resolve the queue oldest-first. Null when nothing is outstanding.
    this.pendingSubmissionWatch = null;
    // #104: the cycle whose capsule request is held because a tool call is
    // outstanding (or readiness cannot be established), plus the named reason.
    // Read by _prepareSubmission so the clear's refusal names the real wait
    // instead of blaming a composer that is demonstrably clean.
    this.capsuleRequestReadinessHold = null;
    // DIALOG READINESS (#104): the outstanding-tool-call reader's state, or
    // null before the first read. Shape:
    //   { transcript, from, midLine, outstanding:Map<id,offset>, unknownOpen,
    //     degraded:{code,detail}|null, baselineSize }
    // Forward-only within one transcript, re-baselined when the bound
    // transcript changes or shrinks. NOT persisted and deliberately so: the
    // transcript tail IS the durable record this would otherwise duplicate, and
    // a persisted offset can drift from the file it indexes (that drift is #90
    // shape 1). See _noteToolCallWatch for the restart argument.
    this.toolCallWatch = null;
    // Once-per-run latches so the reader's named events are state changes
    // rather than per-tick floods.
    this.toolCallDegradedCode = null;
    this.toolCallOutstandingKey = null;
    // ─── THE PRE-PERMISSION INTERLOCK (#104) ───────────────────────────────
    // The binding this runner has proven to itself. `interlockSessionId` is
    // which session the proof on disk was written for, so a rebind (which
    // always rotates the session id -- see _rebindAfterClear) voids it
    // automatically rather than inheriting another session's evidence.
    this.interlockSessionId = null;
    this.interlockNonce = null;
    this.interlockHookPath = null;
    this.interlockHookSha256 = null;
    // Cached wiring verdict for this binding. A FAILING verdict is re-checked
    // every time (so an operator who fixes the install is not locked out until
    // restart); a PASSING one is trusted for the binding, because a hook
    // removed from the settings mid-session is caught empirically by the
    // missed-tool-calls leg on the very next tool call.
    this.interlockWiring = null;
    // Last point at which the hook's own invocation count and the transcript
    // reader's tool_use count agreed. Null means "not established yet", which
    // the evidence check initialises rather than treats as a failure. Dropped
    // on every re-baseline -- see _noteToolCallWatch.
    this.interlockCheckpoint = null;
    // The gate handle while the runner HOLDS it across more than one scheduler
    // turn. Exactly one holder: the clear's prepare-to-commit span, which is
    // how #110's residual (3) is closed. Null at every other time; a leak is
    // bounded by the gate going stealable (GATE_STALE_MS).
    this.interlockGate = null;
    this.interlockHeldFor = null;
    // ─── THE OPERATOR'S MANUAL RELEASE (#104 leg 30) ───────────────────────
    // LATCHED, and that is the property that makes a release a trade rather
    // than a toggle. Once this binding has seen a valid release, every
    // automatic write is refused for the rest of it -- deleting the file does
    // NOT re-enable automation, because a release is a decision about the
    // binding. Only a new binding (a restart, or a post-clear rebind, each a
    // deliberate human act with a new session id and so a new directory)
    // starts over. Null until observed; then {reason, at}.
    this.interlockReleased = null;
    // Once-per-shape latch for the forgiven-deficit event.
    this.interlockForgaveKey = null;
    // Monotone count of tool_use blocks the reader has PARSED, across baseline
    // and catch-up alike. Only ever compared as a delta against
    // interlockCheckpoint; see the evidence header in the hook module for why
    // an absolute comparison against the hook's counter would be wrong.
    this.toolUsesObserved = 0;
    // How many times the CURRENT delayed automatic Enter has been rescheduled
    // because a tool call was outstanding. Reset whenever a fresh Enter is
    // scheduled by a text write, and bounded by AUTOMATIC_ENTER_DEFERRAL_LIMIT.
    this.enterDeferrals = 0;
    // WHICH BOUNDARY'S Enter is currently DEFERRED awaiting readiness, or null.
    // This is not the same state as "an Enter is pending" (#104 B2): a normally
    // pending Enter lands in controlEnterDelayMs and the no-concatenation
    // invariant is correct for it, while a DEFERRED one is waiting on a
    // condition only the operator can clear. Operator input strands the second
    // and queues behind the first.
    this.enterDeferredAt = null;
    // The last uncertain CR logged (tracker units), so 'submission-uncertain'
    // stays a once-per-CR event now that the watch outlives any one CR.
    this.lastUncertainUnits = null;
    // ───────────────────────────────────────────────────────────────────────
    // THE ACKNOWLEDGEMENT LIFECYCLE (#90, #91).
    //
    // THE INVARIANT: an acknowledgement authorizes only its own
    // session/request/cycle, and it is invalidated when that cycle ends
    // unspent.
    //
    // This used to be two booleans and a bare offset. `capsuleAckSeen` latched
    // on sight and the only thing that ever cleared it was spending it on a
    // /clear, so a cycle the TRANSPORT abandoned (a below-threshold reading
    // from `pressure`, `checkpoint-requested` or `checkpoint-confirmed`, or
    // inside beginClearSubmission) left the latch standing, the next cycle's
    // capsule request was SKIPPED because the latch said "already acked", and
    // the clear fired on the dead cycle's evidence: one capsule request across
    // two distinct cycles, then a /clear on the first cycle's ack (#91).
    //
    // Clearing the boolean on every abandonment path is not enough. The scan
    // runs LATER IN THE SAME TICK as a _gatePressure abandonment, and a late
    // ack from an abandoned request can land at any time, so a cleared boolean
    // simply re-latches. The evidence is therefore IDENTITY-BOUND: it names
    // the session and the cycle it belongs to, the authorization test is an
    // identity comparison rather than a truth test, and no later cycle can
    // adopt earlier evidence.
    //
    // `capsuleAck`      — null, or { session_id, cycle_id, from, observed_at }:
    //                     the ack observed for exactly that identity. The
    //                     cycle_id IS the request identity -- _writeCapsuleRequest
    //                     writes exactly one request per cycle_id, so there is
    //                     no narrower boundary to bind to.
    // `capsuleAckWatch` — null, or { session_id, cycle_id, from, drained }: the
    //                     forward-only transcript window for that same
    //                     identity. `from` only ever advances; `drained` turns
    //                     true once the window has been read to the end of the
    //                     transcript with no ack in it.
    // `capsuleAckSpent` — null, or { session_id, cycle_id }: the identity whose
    //                     ack has already bought its one clear. Evidence for a
    //                     spent identity can never be latched again, so a
    //                     re-opened window cannot re-spend the same literal.
    //
    // Only _latchCapsuleAck writes evidence, only _armCapsuleAckWatch opens a
    // window, and only _syncCapsuleAckLifecycle decides which cycle they may
    // belong to.
    //
    // THE RETIRED REQUEST (#90/#91 review, R1). Identity binding alone is not
    // enough, because the window — not the record — carried the identity: a
    // scan attributed whatever it found to `watch.cycle_id`, so a request the
    // transport RETIRED while its answer was still outstanding came back inside
    // the REPLACEMENT cycle's window and was labelled with the replacement's
    // identity. Request A goes out, A's cycle is abandoned, B opens, B's
    // request is written, and A's delayed acknowledgement lands in B's window:
    // B never answered, yet capsuleAck.cycle_id was B and the clear fired.
    //
    // The repair is request/response SERIALIZATION, on evidence the runner
    // actually has. Every capsule request this process writes is owed exactly
    // one answer. When a cycle dies with its request unanswered the debt
    // survives the cycle here, and the next acknowledgement literal to appear
    // in file order DISCHARGES THE OLDEST OUTSTANDING REQUEST — it is consumed
    // as the retired request's late answer and may not be latched for anyone.
    // No literal is labelled with "whatever cycle is live now" and nothing
    // turns on when bytes arrived.
    //
    // `capsuleAckRetired` — null, or { session_id, from, owed, records_owed,
    //                       cycle_ids, names_dropped }: `from` is a forward-only
    //                       cursor that starts where the retired cycle's own
    //                       window stood, `owed` counts answers still
    //                       outstanding, `records_owed` counts retired requests
    //                       whose own host record has not been seen yet (which
    //                       is how the drain recognises the LIVE cycle's request
    //                       record and closes on ordering evidence rather than
    //                       waiting), and `cycle_ids` names the oldest debts up
    //                       to CAPSULE_RETIRED_REQUEST_MAX with `names_dropped`
    //                       counting the rest. `cycle_ids.length +
    //                       names_dropped === owed` ALWAYS: see the cap note on
    //                       _retireCapsuleRequests. A debt is a number, never a
    //                       name, so running out of names cannot lose one.
    //
    // ─── THE RELAUNCH, AND THE CLAIM THAT WAS WRONG (re-review 5556245936, S1)
    //
    // This comment used to say the ledger could stay in memory because an
    // answer written before a relaunch "sits behind the next cycle's
    // forward-only EOF boundary", so only an orphaned child could reopen the
    // hole. THAT WAS FALSE, and it is worth writing down why, because the
    // mistake is the kind that looks like the fix.
    //
    // #90 RESTORES AN EXISTING CYCLE, NOT A NEW ONE AT EOF. A genuinely new
    // cycle captures its boundary at the transcript's end, and such a cycle
    // does reject an older answer -- the reviewer's matched control confirms
    // it, which is exactly what made the wrong claim look right. But a restore
    // reopens the cycle's ORIGINAL persisted boundary, taken when that cycle
    // opened, which PREDATES an answer that arrived later in its life. So the
    // measured sequence needs no SIGKILL, no orphan, no post-relaunch write and
    // no change of session identity: A requested, A abandoned, B opened and
    // requested, A completed and was correctly consumed as retired
    // (authorized(B) false), then an ORDERLY relaunch -- and the new process,
    // having lost the ledger and the cursor, reopened B's old boundary, read A
    // again and labelled it B. Measured: authorized(B) true, from 317,
    // requests 0.
    //
    // THE PRINCIPLE: evidence that was rejected before an orderly shutdown must
    // not become authorization afterward. What crosses the relaunch is NOT this
    // ledger and NOT a new state file -- it is two numbers in the cycle's own
    // durable record, `ack_classification.classified_through` and
    // `.debts_outstanding` (see the ACK CLASSIFICATION note in
    // auto-clear-transport.mjs). The restore reopens the window at
    // max(boundary, classified_through) and rebuilds the ledger with the debts
    // that were still outstanding. Everything else about the ledger is still
    // per-process and dies with it.
    this.capsuleAck = null;
    this.capsuleAckWatch = null;
    this.capsuleAckSpent = null;
    this.capsuleAckRetired = null;
    // The monotone frontier this session has CLASSIFIED: the highest transcript
    // offset through which acknowledgement evidence has been judged to be
    // somebody else's -- a retired request's answer that was consumed, or a
    // literal refused as already spent. Persisted through
    // transport.noteAckClassification so a restore cannot re-read it as the
    // restored cycle's own answer (S1). Session-scoped and forward-only;
    // boundaries only ever advance, so one number serves every cycle.
    this.capsuleAckClassifiedThrough = 0;
    // THE LIVE CYCLE'S ANSWER ACCOUNT (re-review 5558958106, T1) -- null, or
    // { cycle_id, requests_issued, answers_settled }. Mirrors the durable
    // tallies in ack_classification for the cycle the runner is reasoning
    // about, and is re-keyed when the cycle changes.
    //
    // WHY ARITHMETIC REPLACED A BOOLEAN. Retirement used to be suppressed by
    // `hadAck` -- "an answer was observed" read as "every possible answer was
    // discharged". It is not. The one-request-per-cycle latch is PER PROCESS,
    // so a restored cycle's writer issues a SECOND request; the original
    // completion then satisfies the first, `hadAck` suppresses retirement at
    // abandonment, and the second completion arrives owned by nobody and
    // authorizes the replacement cycle. Measured authorized(B)=true,
    // retiredOwed=0, consumed=0, with no orphan and no cross-session mixing.
    //
    // Outstanding answers = requests_issued - answers_settled, and that is
    // exactly how many debts an abandonment carries forward. It falls out
    // correctly at both ends: one request answered once retires nothing (so a
    // cancelled or never-seen prior request cannot eat the next cycle's
    // answer), and a re-request answered once retires exactly one.
    this.capsuleAckAccount = null;
    // THE UNRESOLVED DISPOSITION (re-review 5559815305, U1) -- null, or
    // { cycle_id, code }. Ownership for that cycle could not be established and
    // no request has yet gone out to resolve it.
    //
    // WHERE THIS CAME FROM: the mechanism that CLOSED T2 is what opened U1.
    // Writing the classification unconditionally for every live cycle is what
    // makes `present` the norm, and a record of valid zeros says "nothing
    // classified, nothing owed" -- which, one tick after a refusal, certifies
    // the old unread window as clean and reopens it. The refusal only survived
    // as long as the tick it happened in, so any DEFERRED recovery -- a
    // telemetry hold, a busy operator composer -- bypassed it. Measured
    // first-tick rejection followed by authorized(B)=true, requests=0, from=317
    // in both deferral variants.
    //
    // So the disposition is durable too, and `_persistCapsuleAckClassification`
    // propagates it instead of flattening it. It is cleared in exactly one
    // place: when a request is actually issued with its ownership recorded,
    // because that request's window opens at the transcript's end and
    // supersedes the window that could not be established.
    this.capsuleAckPending = null;
    // THE ACCEPTED-BUT-UNSPENT MARKER (U2) -- null, or { cycle_id, at }: a
    // completion for that cycle was accepted and is still awaiting its spend.
    // Settling an answer advances the exclusion frontier past it, which is
    // right -- it must never be re-read -- but on its own it made an accepted
    // answer indistinguishable from a foreign one, so an ordinary restart threw
    // a valid unspent acknowledgement away and asked again. That was a #90
    // liveness regression introduced by the S1 frontier, not corrupt state.
    this.capsuleAckAccepted = null;
    // Once-per-run latch for the named event emitted while the live scan is
    // waiting for the retired reader to catch up (S3).
    this.capsuleAckDeferringToLedger = false;
    // Once-per-cycle latch for the classification write-failure event.
    this.capsuleAckClassificationFailedCycleId = null;
    // Once-per-cycle latch for a request deferred because its ownership could
    // not be recorded durably (T2).
    this.capsuleRequestOwnershipCycleId = null;
    // The end offset of the last request record the ledger attributed to a
    // RETIRED request. A record is one request's, not two: without this the
    // live cycle could also claim a record the ledger had already counted,
    // which would understate `records_owed` on a later retirement and let the
    // ledger close one record too early. Monotonic, session-scoped.
    this.capsuleRetiredRecordEnd = 0;
    // The cycle whose persisted boundary could not be recovered, so the named
    // event is a state change rather than a per-tick flood.
    this.capsuleAckRecoveryCycleId = null;
    // Exactly-once latch for the synchronous post-clear wake.
    this.wakeSessionId = null;
    // Watched wake submission: armed when the wake Enter physically lands,
    // closed by name (committed / unconfirmed). Null outside that window.
    this.wakeSubmission = null;
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

  _event(name, detail = null, maximum = 400) {
    this.events.push({ name, detail });
    // Also durable: these were memory-only, so "did the capsule request go
    // out? did the wake fire?" was unanswerable from a
    // seat's own files -- twice in one night. All sites are state changes,
    // not per-tick, so the log stays readable.
    this._diagnostic(`EVENT ${name} ${boundedDetailJson(detail, maximum)}`);
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
    // `currentControlWriteAttempted` used to be set HERE, at the top. It feeds
    // commitClearSubmission's ambiguity test, and setting it this early meant an
    // interlock refusal -- which happens BEFORE any byte -- was reported as
    // "the write may have happened": phase submitted, ack spent, nothing in the
    // composer, and a terminal disable when the watchdog expired. The code can
    // prove nothing was written, so it must not claim otherwise. It is set
    // immediately before the byte now; see the interlocked callback below.
    // An ack buys ONE clear. Spend it here, at the moment it is used, so it
    // cannot authorize the next one: a surviving ack cleared the seat again
    // the instant it rebound -- clear, resume, clear, with no capsule in
    // between (measured live 2026-08-05). The spend is recorded BY IDENTITY, so
    // a window re-read that finds the same literal again cannot re-latch it
    // (_latchCapsuleAck refuses a spent identity) and no later cycle inherits
    // the spend record either.
    const spentIdentity = this.capsuleAck ?? {
      session_id: this.sessionId,
      cycle_id: this.token?.cycle_id ?? null,
    };
    this.capsuleAck = null;
    this.capsuleAckWatch = null;
    // Accepted no longer: it has been spent, and a restore must not
    // re-establish it (U2). The transport's durable clear_intent is the other
    // half of that guard, and the restore checks it too.
    this.capsuleAckAccepted = null;
    this.capsuleAckSpent = {
      session_id: spentIdentity.session_id,
      cycle_id: spentIdentity.cycle_id,
    };
    this._event('capsule-ack-spent', CLEAR_CONTROL_TEXT);
    this._event('control-write', CLEAR_CONTROL_TEXT);
    // ─── THROUGH THE HELD GATE, SO IT STAMPS (review F-drain) ──────────────
    // This write was interlocked by the HELD span but went straight to the pty,
    // so it never recorded `last_write_at` -- which meant a hook arriving right
    // after '/clear' hit the composer got no drain at all. It was the one
    // automatic write that was inside the gate and invisible to it. Routing it
    // through the same helper as the other four also gives it the on-disk
    // ownership re-verification the held path now does.
    const interlocked = this._interlockedWrite(
      'clear-text',
      () => {
        // SET IMMEDIATELY BEFORE THE BYTE. See the note at the top of this
        // method: the ambiguity flag now means what its name says, so an
        // interlock refusal (which happens before this callback runs at all)
        // takes the clean abort instead of being reported as a write that may
        // have happened.
        this.currentControlWriteAttempted = true;
        return this.pty.write(CLEAR_CONTROL_TEXT);
      },
    );
    if (!interlocked.ok) {
      // Reachable without any exotic fault: gateStillHeld() returns false on a
      // TRANSIENT read error of the gate file, so one EMFILE lands here.
      // Nothing has been written -- the refusal happens before the callback
      // runs -- so this is flagged as a PROVABLE non-write and the commit's
      // catch takes the clean abort instead of the ambiguous branch.
      const failure = new Error(`interlock refused the clear text: ${interlocked.detail?.reason ?? interlocked.code}`);
      failure.code = interlocked.code;
      failure.detail = interlocked.detail;
      failure.provableNoWrite = true;
      throw failure;
    }
    const result = interlocked.result;
    this.composerMayHoldControlText = true;
    // Enter rides its own delayed write so the terminal parses it as a
    // keypress; a text write that throws never schedules it (the abort path
    // owns that case). The token pins the deferred callback to THIS
    // scheduling — a cleared-but-still-firing timer from an injected
    // scheduler is a no-op.
    this._clearEnter();
    this.enterToken += 1;
    const token = this.enterToken;
    // A FRESH Enter, so the #104 deferral budget starts over (per-Enter, not
    // per-session).
    this.enterDeferrals = 0;
    this.enterDeferredAt = null;
    this.enterHandle = this.scheduleEnter(
      () => this._writeControlEnter(token),
      this.controlEnterDelayMs,
    );
    return result;
  }

  _writeControlEnter(token) {
    if (token !== this.enterToken) return;
    // M1: the handle slot is released on EVERY exit from this callback, as it
    // was before #104. A callback that returns with `enterHandle` still set
    // leaves _flushQueuedInput and handleOperatorData reading a pending Enter
    // that will never fire -- inert in production, where `closed` means
    // teardown, but a permanent in-process wedge.
    if (this.closed) {
      this.enterHandle = null;
      this.enterDeferredAt = null;
      return;
    }
    if (this.phase !== 'submitted' && this.phase !== 'submitting') {
      this.enterHandle = null;
      this.enterDeferredAt = null;
      return;
    }
    // DIALOG READINESS (#104). '/clear' is already in the composer; this is the
    // keypress that submits it, and at a permission dialog it is the keypress
    // that answers the dialog instead. Re-read here rather than trusting the
    // verdict from the text write: the whole hazard is a dialog that appeared
    // in between. A deferral keeps the handle slot and the stranded-text flag,
    // so nothing is lost and nothing can concatenate onto the line.
    const readiness = this._automaticWriteReadiness('control-enter');
    if (!readiness.ready) {
      this._deferAutomaticEnter(
        'control-enter',
        () => this._writeControlEnter(token),
        readiness,
      );
      return;
    }
    // ─── THE INTERLOCK (#104) ────────────────────────────────────────────────
    // Same shape as the capsule request's Enter: gate, pending re-read and the
    // keypress are one critical section, and a refusal DEFERS rather than
    // dropping the Enter. This is the keypress that answers a permission dialog
    // with "Yes", so it is the one the whole unit exists for.
    let interlocked;
    try {
      interlocked = this._interlockedWrite('control-enter', () => {
        this._event('control-enter-write', CONTROL_ENTER);
        return this.pty.write(CONTROL_ENTER);
      });
    } catch (error) {
      this._automaticWriteReleased('control-enter');
      this.enterHandle = null;
      this.enterDeferrals = 0;
      this.enterDeferredAt = null;
      this.lastReason = {
        code: 'runner-control-enter-write-failed',
        detail: errorText(error),
      };
      this._event('control-enter-write-failed', this.lastReason);
      return;
    }
    if (!interlocked.ok) {
      this._deferAutomaticEnter(
        'control-enter',
        () => this._writeControlEnter(token),
        interlocked,
      );
      return;
    }
    this._automaticWriteReleased('control-enter');
    this.enterHandle = null;
    this.enterDeferrals = 0;
    this.enterDeferredAt = null;
    // The write-failure path moved up into the catch around the interlocked
    // write: the text may sit in the composer unsubmitted, the round-trip fuse
    // stays armed and expires loudly if no receipt ever lands, and the
    // stranded-text flag stays up so a later queued-input flush leads with a
    // kill-line instead of concatenating onto '/clear'.
    this.composerMayHoldControlText = false;
  }

  // ─── A DELAYED AUTOMATIC ENTER THAT CANNOT GO OUT YET (#104) ───────────────
  // THE DANGEROUS ORDERING this exists for: the text write has already placed
  // command text in the composer, and the tool request/dialog appears in the
  // 400 ms gap BEFORE the Enter. The Enter must not be written -- a bare Enter
  // at that dialog selects "Yes" -- and it must not be DROPPED either, because
  // dropping it strands the line silently and then releases queued operator
  // bytes onto it.
  //
  // So the Enter is RESCHEDULED, on the SAME token, into the SAME handle slot.
  // Every protection the two-phase write already has therefore stays intact
  // for exactly as long as the deferral lasts:
  //   - composerMayHoldControlText stays TRUE, so a queued-input flush leads
  //     with a kill-line rather than concatenating onto stranded command text;
  //   - enterHandle stays NON-NULL, so _flushQueuedInput keeps every queued
  //     operator chunk BEHIND the pending Enter and nothing interleaves;
  //   - the token is unchanged, so a clear submission that begins meanwhile
  //     still bumps it and this callback still becomes the no-op it should be.
  //
  // Returns true when the Enter is still owned (rescheduled), false when the
  // budget is spent and the text is stranded by name. A scheduler that throws
  // or hands back no handle is treated as the budget being spent: identical
  // outcome, and the existing write-failure paths already say what that means.
  _deferAutomaticEnter(where, callback, readiness) {
    this._automaticWriteHeld(where, readiness);
    this.enterDeferrals += 1;
    const strand = (code, detail) => {
      this.enterHandle = null;
      this.enterDeferredAt = null;
      this.lastReason = { code, detail };
      this._event('automatic-enter-stranded', this.lastReason, REFUSAL_DETAIL_MAX);
      return false;
    };
    if (this.enterDeferrals > AUTOMATIC_ENTER_DEFERRAL_LIMIT) {
      // The budget is spent and the Enter is NOT written. The text stays in the
      // composer with the stranded-text flag UP, which is what the kill-line
      // protection reads; the clear's round-trip fuse (if this was a clear)
      // expires loudly on its own schedule. Stranding is the correct outcome:
      // the alternative is the keypress this whole unit refuses to make.
      return strand('runner-automatic-enter-stranded', {
        at: where,
        deferrals: this.enterDeferrals - 1,
        limit: AUTOMATIC_ENTER_DEFERRAL_LIMIT,
        readiness: readiness.code,
      });
    }
    let handle = null;
    try {
      handle = this.scheduleEnter(callback, this.controlEnterDelayMs);
    } catch (error) {
      return strand('runner-automatic-enter-reschedule-failed', {
        at: where,
        error: errorText(error),
      });
    }
    if (handle === null || handle === undefined) {
      return strand('runner-automatic-enter-reschedule-failed', {
        at: where,
        error: 'scheduler returned no handle',
      });
    }
    this.enterHandle = handle;
    // MARKED AS DEFERRED, not merely pending. handleOperatorData reads this to
    // tell the operator-takeover case from the ordinary two-phase gap (B2).
    this.enterDeferredAt = where;
    return true;
  }

  // ─── OPERATOR TAKEOVER (#104 B2) ───────────────────────────────────────────
  // Operator bytes arriving while an automatic Enter is DEFERRED mean the
  // operator is taking over, so that Enter is abandoned at once: the timer is
  // cancelled, the token bumped (a cleared-but-still-firing scheduler callback
  // becomes a no-op), and the slot released.
  //
  // `composerMayHoldControlText` is deliberately LEFT UP. The automatic text is
  // still in the composer, and the flag is what makes the queued-input release
  // lead with a kill-line instead of concatenating the operator's bytes onto
  // it. Stranding without it would be the concatenation bug this guard exists
  // to avoid.
  _strandDeferredEnter(cause) {
    const where = this.enterDeferredAt;
    if (where === null) return false;
    this.enterDeferredAt = null;
    this.enterDeferrals = 0;
    this._clearEnter();
    this.lastReason = {
      code: 'runner-automatic-enter-operator-takeover',
      detail: { at: where, cause },
    };
    this._event('automatic-enter-stranded', this.lastReason, REFUSAL_DETAIL_MAX);
    return true;
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
  // operator can run /context-capsule by hand within the cycle, and that
  // capsule is just as real (measured live 2026-08-05: a hand-run capsule
  // completed and acked, and the clear never came because the watcher only
  // armed when the runner wrote the request). The window is bound to the CYCLE
  // rather than to the session so a hand-run capsule from BEFORE the cycle
  // existed cannot authorize it -- that was #91 wearing a friendly face.
  _transcriptPath() {
    try {
      return transcriptPathFor({
        cwd: this.cwd,
        sessionId: this.sessionId,
        homeDir: this.homeDir,
        env: this.env,
      });
    } catch { return null; }
  }

  // The transcript's current end: the position a request's window opens at, and
  // therefore the REPLACEMENT EXCLUSION a request establishes. Null when it
  // cannot be resolved, which is never treated as 0 (that would open the window
  // on the whole file). Resolved once per request so the durable record and the
  // in-memory cursor cannot disagree about where the replacement is
  // (re-review 5608270301, V1).
  _transcriptEnd() {
    try {
      const transcript = this._transcriptPath();
      if (!transcript) return null;
      const size = fs.statSync(transcript).size;
      return Number.isSafeInteger(size) && size >= 0 ? size : null;
    } catch { return null; }
  }

  // Open (or re-open) the cycle's forward-only ack window at the transcript's
  // current end. Called when the request is written: nothing already on disk
  // can answer a request that has only just gone out. `from` is passed by the
  // request writer so the window opens at exactly the position it already
  // persisted as the replacement exclusion (V1).
  _armCapsuleAckWatch(cycleId, from = null) {
    if (typeof cycleId !== 'string' || cycleId.length === 0) {
      // No identity, no window. Fail visibly rather than opening an unowned
      // window that the next cycle could inherit.
      this.capsuleAckWatch = null;
      this.capsuleAckSkipping = false;
      this._event('capsule-ack-watch-unidentified', { cycle_id: cycleId ?? null });
      return null;
    }
    if (this._ackAlreadySpent(cycleId)) {
      this.capsuleAckWatch = null;
      this.capsuleAckSkipping = false;
      return null;
    }
    if (from === null) from = this._transcriptEnd();
    if (from === null) {
      // An unresolvable transcript must NOT become offset 0: that would open
      // the window on the whole file and could revive an earlier cycle's ack.
      this.capsuleAckWatch = null;
      this.capsuleAckSkipping = false;
      this._event('capsule-ack-watch-unopened', {
        cycle_id: cycleId,
        code: 'transcript-unresolved',
      });
      return null;
    }
    this.capsuleAckWatch = {
      session_id: this.sessionId,
      cycle_id: cycleId,
      from,
      drained: true,
      // How many of THIS cycle's request records the scan has gone past. A
      // COUNT, not a flag (T1): a restored cycle can have issued two requests
      // and will therefore produce two records, and the retired-request drain
      // needs to know how many are still to come or its ordering closure can
      // be fooled into forgiving a debt by the retired cycle's OWN later
      // request record.
      request_records_seen: 0,
    };
    this.capsuleAckSkipping = false;
    return this.capsuleAckWatch;
  }

  _ackAlreadySpent(cycleId) {
    return this.capsuleAckSpent !== null
      && this.capsuleAckSpent.cycle_id === cycleId
      && this.capsuleAckSpent.session_id === this.sessionId;
  }

  // The ONE authorization test. An ack authorizes a clear for `cycleId` only
  // when the evidence names that cycle AND this session. Not "is there an
  // ack": "is this cycle's ack held".
  _capsuleAckAuthorizes(cycleId) {
    return this.capsuleAck !== null
      && typeof cycleId === 'string'
      && this.capsuleAck.cycle_id === cycleId
      && this.capsuleAck.session_id === this.sessionId;
  }

  // The only writer of ack evidence.
  _latchCapsuleAck({ cycleId, from = null, source = null }) {
    if (typeof cycleId !== 'string' || cycleId.length === 0) {
      this._event('capsule-ack-unattributable', { source, cycle_id: cycleId ?? null });
      return false;
    }
    if (this._ackAlreadySpent(cycleId)) {
      // Single spending: the cycle's one clear is already bought. A window
      // re-read that finds the same literal again may not re-authorize it.
      this._event('capsule-ack-already-spent', { cycle_id: cycleId, source });
      return false;
    }
    this.capsuleAck = {
      session_id: this.sessionId,
      cycle_id: cycleId,
      from,
      observed_at: source,
    };
    // The first refusal after the ack always prints, with its snapshot, even
    // when its code matches the last pre-ack one.
    this._lastRefusalPrinted = null;
    return true;
  }

  // The shared invalidation point: the cycle this evidence belonged to is over
  // or has been replaced. Nulls BOTH halves, so the scan that may still run
  // later in the same tick has no window to latch into and a late ack from the
  // abandoned request authorizes nothing.
  //
  // Closing the window is not the same as cancelling the REQUEST. A request
  // already on the wire is still owed an answer by the seat, and that answer
  // can land at any time afterwards -- including inside the replacement
  // cycle's window (R1). So the debts are retired here rather than forgotten:
  // see _retireCapsuleRequests. `retire:false` is for the session boundaries,
  // where the next transcript is a different file and the old offsets index
  // nothing.
  //
  // THE RETIREMENT ITSELF IS NOT HERE (T1). It is keyed on the cycle's ANSWER
  // ACCOUNT, at the lifecycle boundary in _retireAccountedCycle, because a
  // cycle can reach its end holding no evidence at all -- its acknowledgement
  // was observed and SPENT on a clear, which nulls both halves without passing
  // through this method. The reviewer's requirement is accounting retained
  // through abandonment, restore AND spending, and keying on held evidence
  // misses the third.
  _invalidateCapsuleAck(reason, detail = null, { retire = true } = {}) {
    const hadAck = this.capsuleAck !== null;
    const had = hadAck || this.capsuleAckWatch !== null;
    const identity = this.capsuleAck ?? this.capsuleAckWatch;
    this.capsuleAck = null;
    this.capsuleAckWatch = null;
    this.capsuleAckSkipping = false;
    // The accepted marker belongs to the evidence that just died with its
    // cycle; it is not an exclusion and must not outlive it (U2).
    if (identity !== null && this.capsuleAckAccepted?.cycle_id === identity.cycle_id) {
      this.capsuleAckAccepted = null;
    }
    if (had) {
      this._event('capsule-ack-invalidated', {
        reason,
        session_id: identity?.session_id ?? null,
        cycle_id: identity?.cycle_id ?? null,
        // true when a real acknowledgement died unspent -- the #91 specimen.
        acked: hadAck,
        detail,
      });
    }
    return had;
  }

  // THE ONE RETIREMENT SITE (T1). A cycle is ending or has been replaced: carry
  // forward exactly the answers it may still receive and then drop its account.
  //
  // Keyed on the ACCOUNT rather than on held evidence, because the three ways a
  // cycle can end differ in what it is still holding: abandoned with a window
  // open, abandoned holding an observed acknowledgement, or ended having SPENT
  // one on a clear -- and the spend nulls both halves without passing through
  // _invalidateCapsuleAck at all. The account outlives all three, so one site
  // covers abandonment, restore and spending.
  _retireAccountedCycle(liveCycleId, reason) {
    const account = this.capsuleAckAccount;
    if (account === null || account.cycle_id === liveCycleId) return 0;
    const outstanding = Math.max(0, account.requests_issued - account.answers_settled);
    let retired = 0;
    if (outstanding > 0) {
      retired = this._retireCapsuleRequests(account.cycle_id, {
        count: outstanding,
        // The watch, if it is still open, is this cycle's own cursor; the
        // frontier covers the case where it is already closed. Both are past
        // every answer already settled, which is what keeps the drain from
        // discharging the new debt against an answer this cycle already had.
        from: this.capsuleAckWatch?.cycle_id === account.cycle_id
          ? this.capsuleAckWatch.from
          : this.capsuleAckClassifiedThrough,
        recordsOwed: Math.max(
          0,
          account.requests_issued - (this.capsuleAckWatch?.cycle_id === account.cycle_id
            ? this.capsuleAckWatch.request_records_seen
            : 0),
        ),
        reason,
      });
    }
    this.capsuleAckAccount = null;
    return retired;
  }

  // The live cycle's answer account, re-keyed when the cycle changes. A cycle
  // the runner has not accounted for yet starts at zero and is seeded from the
  // durable record by _restoreCapsuleAckWatch (T1).
  _capsuleAccountFor(cycleId) {
    if (typeof cycleId !== 'string' || cycleId.length === 0) return null;
    if (this.capsuleAckAccount === null
      || this.capsuleAckAccount.cycle_id !== cycleId) {
      this.capsuleAckAccount = {
        cycle_id: cycleId,
        requests_issued: 0,
        answers_settled: 0,
      };
    }
    return this.capsuleAckAccount;
  }

  // How many answers this cycle may still receive: one per request issued that
  // has not yet been accounted for. Never negative -- an answer the runner
  // settled without having issued a request (a hand-run capsule) is evidence,
  // not a debt.
  _outstandingAnswers(cycleId) {
    const account = this.capsuleAckAccount;
    if (account === null || account.cycle_id !== cycleId) return 0;
    return Math.max(0, account.requests_issued - account.answers_settled);
  }

  // An answer has been ACCOUNTED FOR by this cycle: observed and latched, or
  // found and refused because the cycle's one clear is already bought. Either
  // way it is one of the completions this cycle's requests could produce, so it
  // stops counting towards what is still outstanding (T1). `through` is the end
  // offset of the record, which also joins the durable exclusion frontier so no
  // restore can count the same literal twice.
  _settleCapsuleAnswer(cycleId, through, { accepted = false } = {}) {
    const account = this._capsuleAccountFor(cycleId);
    if (account !== null) account.answers_settled += 1;
    if (Number.isSafeInteger(through)) {
      this.capsuleAckClassifiedThrough = Math.max(this.capsuleAckClassifiedThrough, through);
    }
    // ACCEPTED is not the same as EXCLUDED (U2). An answer this cycle accepted
    // and has not yet spent must be recoverable across a restart; one it
    // refused (already spent, unattributable) must not be. Only the accepting
    // path leaves the marker.
    if (accepted && typeof cycleId === 'string' && Number.isSafeInteger(through)) {
      this.capsuleAckAccepted = { cycle_id: cycleId, at: through };
    }
  }

  // ─── THE RETIRED REQUEST AND ITS LATE ANSWER (#90/#91 review, R1) ─────────
  //
  // Carry the DEBTS of a cycle that died owing answers. `count` comes from the
  // cycle's own arithmetic -- requests issued minus answers settled -- so a
  // cycle that never asked carries nothing, a cycle answered once per request
  // carries nothing, and a RESTORED cycle whose writer issued a second request
  // and received one answer carries exactly one (T1).
  //
  // WHAT THIS NO LONGER CONSULTS: `hadAck` and `_ackAlreadySpent`. Both were
  // boolean stand-ins for "all answers discharged" and both were wrong for a
  // re-requested cycle. Spending is irrelevant to whether another completion is
  // still coming; the arithmetic subsumes it, and in the ordinary
  // one-request-answered-once case it yields zero debts exactly as the booleans
  // did. Session-bound, so the cursor always indexes the file it came from.
  //
  // `from` must start PAST every answer this cycle already settled, or the
  // drain would re-read the settled literal and discharge the new debt against
  // it -- leaving the still-outstanding completion free to authorize the next
  // cycle. The classification frontier is exactly that offset.
  _retireCapsuleRequests(cycleId, { count, from, recordsOwed, reason }) {
    if (typeof cycleId !== 'string' || cycleId.length === 0) return 0;
    if (!Number.isSafeInteger(count) || count <= 0) return 0;
    const start = Math.max(
      Number.isSafeInteger(from) ? from : 0,
      this.capsuleAckClassifiedThrough,
    );
    if (this.capsuleAckRetired === null) {
      this.capsuleAckRetired = {
        session_id: this.sessionId,
        // Forward only, and never behind what has already been classified.
        from: start,
        owed: 0,
        records_owed: 0,
        cycle_ids: [],
        names_dropped: 0,
      };
    }
    const drain = this.capsuleAckRetired;
    let retired = 0;
    for (let i = 0; i < count; i += 1) {
      // A DEBT IS A NUMBER, NEVER A NAME (re-review 5556245936, S2, accepted).
      // The cap used to refuse the retirement outright: the event was emitted,
      // `false` was returned, and the debt was simply GONE -- so the ninth
      // retired request's answer, arriving after the first eight had been
      // discharged and the ledger had emptied, was read as the live cycle's.
      // Raising the cap only moves that failure. What the cap bounds now is the
      // MEMORY: `cycle_ids` retains the OLDEST names up to it and
      // `names_dropped` counts the rest, with `cycle_ids.length +
      // names_dropped === owed` invariant. A discharge spends a name first and
      // an unnamed debt afterwards, so FIFO order is preserved and an unnamed
      // debt protects the live cycle exactly as a named one does.
      const named = drain.cycle_ids.length < CAPSULE_RETIRED_REQUEST_MAX;
      drain.owed += 1;
      retired += 1;
      if (named) {
        drain.cycle_ids.push(cycleId);
      } else {
        drain.names_dropped += 1;
        // Once per ledger, not once per retirement past the cap: this is a
        // capacity state change, and the debt itself is still counted.
        if (drain.names_dropped === 1) {
          this._event('capsule-ack-retired-overflow', {
            cycle_id: cycleId,
            owed: drain.owed,
            names_retained: drain.cycle_ids.length,
            reason,
          });
        }
      }
    }
    // One host record per request issued, so a cycle that asked twice and whose
    // second request has not been recorded yet still owes a record. Getting
    // this wrong is how the ordering closure could be fooled into forgiving a
    // debt by the retired cycle's OWN later request record (T1).
    if (Number.isSafeInteger(recordsOwed) && recordsOwed > 0) {
      drain.records_owed += Math.min(recordsOwed, retired);
    }
    this._event('capsule-ack-retired', {
      cycle_id: cycleId,
      reason,
      from: drain.from,
      count: retired,
      owed: drain.owed,
      records_owed: drain.records_owed,
      named: drain.names_dropped === 0,
    });
    return retired;
  }

  // Discharge outstanding retired requests against the acknowledgements that
  // actually arrive, OLDEST REQUEST FIRST. Runs once per tick, before the live
  // cycle's own scan, with the same discipline as that scan: one bounded read
  // per tick, forward only, complete lines only.
  //
  // What this is NOT: it is not a clock and it is not "the newest literal wins".
  // Each capsule request is owed exactly one answer, so the n-th literal to
  // appear discharges the n-th outstanding request. A literal consumed here is
  // the retired request's answer BY CONSTRUCTION and may authorize nothing; the
  // live cycle's window is advanced past exactly that record so it cannot
  // re-read it, and no further, so a genuine answer landing in the same
  // interval is still collected.
  //
  // CLOSURE ON ORDERING EVIDENCE. Once the host has recorded a request that is
  // NOT one of the retired ones, every answer the retired ones could still
  // produce has already been written, and the ledger closes.
  //
  // THIS IS A CORRECTNESS RULE, NOT A LIVENESS CONVENIENCE. State it that way
  // because the obvious reading ("it stops the ledger waiting forever") is the
  // weaker half. Measured by the non-author reviewer: with `records_owed = 0`
  // and a later request record landing BEFORE the earlier request's answer, the
  // ledger closes, nothing is consumed, the live scan latches the retired
  // answer, and one clear is written -- R1 reopened. So the closure is only
  // sound if that ordering cannot occur.
  //
  // IT CANNOT, AND NOT BY A NEW ASSUMPTION. The precedent is the measured
  // doctrine already written into this file at the ORDERED RECEIPTS note (see
  // the InputOwnershipTracker header, "ORDERED RECEIPTS (review 5480136713,
  // MED)"): on Claude Code's queued-prompt path a prompt submitted into a busy
  // turn is recorded when it is DEQUEUED at turn end, and records are written
  // in submission order. A later request's record therefore cannot precede an
  // earlier request's turn -- and the earlier request's answer is part of that
  // turn. The operator-CR FIFO (`outstanding` + noteOperatorPromptRecord,
  // oldest-first) has rested on exactly this fact since that review.
  //
  // STATED PLAINLY: if the host's record timing ever changes, the operator CR
  // FIFO and this acknowledgement ledger break TOGETHER, for the same reason,
  // and both are fixed at the same place. There is no second, private
  // assumption here to go stale on its own.
  //
  // `records_owed` is what keeps the test honest: a retired request whose own
  // record has not landed yet consumes the first record it sees instead of
  // being mistaken for the live cycle's.
  _drainRetiredCapsuleAcks() {
    const drain = this.capsuleAckRetired;
    if (drain === null) return false;
    if (drain.session_id !== this.sessionId) {
      // A different transcript: the cursor indexes nothing here.
      this.capsuleAckRetired = null;
      return false;
    }
    let consumed = false;
    try {
      const transcript = this._transcriptPath();
      if (!transcript) return false;
      const size = fs.statSync(transcript).size;
      if (size <= drain.from) return false;
      const { lines, ends, nextOffset } = readCompleteLines(
        transcript, drain.from, CAPSULE_ACK_WINDOW_BYTES);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isCapsuleRequestRecord(line)) {
          if (drain.records_owed > 0) {
            // A retired request's own record, landing late. Still its own, and
            // marked so the live cycle's scan cannot claim the same record.
            drain.records_owed -= 1;
            this.capsuleRetiredRecordEnd = Math.max(this.capsuleRetiredRecordEnd, ends[i]);
            continue;
          }
          this._event('capsule-ack-retired-closed', {
            reason: 'later-request-recorded',
            at: ends[i],
            forgiven: drain.owed,
            cycle_ids: [...drain.cycle_ids],
            names_dropped: drain.names_dropped,
          });
          drain.owed = 0;
          drain.names_dropped = 0;
          drain.cycle_ids.length = 0;
          break;
        }
        if (!isAckLine(line)) continue;
        drain.owed -= 1;
        consumed = true;
        const end = ends[i];
        // Oldest first: a retained name, then an unnamed debt. Both protect the
        // live cycle identically; only the event detail differs (S2).
        const named = drain.cycle_ids.length > 0;
        const retiredCycleId = named ? drain.cycle_ids.shift() : null;
        if (!named && drain.names_dropped > 0) drain.names_dropped -= 1;
        this._event('capsule-ack-retired-consumed', {
          cycle_id: retiredCycleId,
          named,
          at: end,
          owed: drain.owed,
          live_cycle_id: this.capsuleAckWatch?.cycle_id ?? null,
        });
        // SERIALIZED: the live cycle's own answer must come after this one, so
        // its window may not re-read this record. Past this record exactly.
        if (this.capsuleAckWatch !== null && this.capsuleAckWatch.from < end) {
          this.capsuleAckWatch.from = end;
        }
        // CLASSIFIED, DURABLY (S1). This record has now been judged to be a
        // retired request's answer, so it must never be read as anyone's
        // evidence again -- including by the next process, which restores this
        // cycle at its ORIGINAL boundary from before this record existed.
        this.capsuleAckClassifiedThrough = Math.max(this.capsuleAckClassifiedThrough, end);
        if (drain.owed <= 0) break;
      }
      drain.from = Math.max(drain.from, nextOffset);
      if (drain.owed <= 0) this.capsuleAckRetired = null;
      if (this.capsuleAckWatch !== null) {
        this.capsuleAckWatch.drained = this.capsuleAckWatch.from >= size;
      }
      return consumed;
    } catch { return false; }
  }

  // Hand the cycle's own durable record the two facts a restore needs: how far
  // this session has classified acknowledgement evidence, and how many retired
  // requests are still owed an answer (re-review 5556245936, S1).
  //
  // NOT A SECOND LEDGER AND NOT A NEW FILE. Two integers, inside the cycle
  // record the transport already writes, validated and made monotone by the
  // transport (noteAckClassification). Nothing is written when there is nothing
  // to say -- a session that has classified nothing and owes nothing never
  // touches the disk, which is every ordinary cycle -- and the transport
  // dedupes the rest, so a write happens on a state change rather than on a
  // tick. A write failure is named once per cycle and is never fatal: the worst
  // case is the pre-S1 behaviour for one restore, and the clear stays gated on
  // an acknowledgement either way.
  _persistCapsuleAckClassification(cycleId) {
    if (typeof cycleId !== 'string' || cycleId.length === 0) return 'unsupported';
    if (typeof this.transport?.noteAckClassification !== 'function') return 'unsupported';
    const debts = this.capsuleAckRetired === null ? 0 : this.capsuleAckRetired.owed;
    const account = this._capsuleAccountFor(cycleId);
    // UNCONDITIONAL FOR A LIVE CYCLE (T2). This used to skip the write when
    // there was "nothing to say", which made an absent record ambiguous between
    // "nothing happened" and "the write failed" -- and the restore read that
    // ambiguity as clean legacy state. Writing the zeros makes PRESENT the
    // norm, so absence is evidence of a real problem and can be routed to the
    // safe re-request path. The transport dedupes, so this is still one write
    // per cycle plus one per change, not one per tick, and it is retried on the
    // next ordinary tick for as long as it keeps failing -- no retry loop and
    // no backoff timer.
    let stored = null;
    try {
      stored = this.transport.noteAckClassification({
        cycleId,
        classifiedThrough: this.capsuleAckClassifiedThrough,
        debtsOutstanding: debts,
        requestsIssued: account?.requests_issued ?? 0,
        answersSettled: account?.answers_settled ?? 0,
        // PROPAGATED, NOT FLATTENED (U1/U2). These are the two meanings the
        // record did not carry, and writing zeros over them is precisely the
        // defect: unknown became clean, and accepted became excluded.
        pending: this.capsuleAckPending?.cycle_id === cycleId
          ? { code: this.capsuleAckPending.code }
          : null,
        accepted: this.capsuleAckAccepted?.cycle_id === cycleId
          ? { cycle_id: cycleId, at: this.capsuleAckAccepted.at }
          : null,
      });
    } catch (error) {
      return this._classificationWriteFailed(cycleId, errorText(error));
    }
    // A null return is the transport refusing the record, which for this
    // purpose is the same unresolved condition as a throw: ownership did not
    // become durable.
    if (stored === null || stored === undefined) {
      return this._classificationWriteFailed(cycleId, 'refused by the transport');
    }
    this.capsuleAckClassificationFailedCycleId = null;
    return 'ok';
  }

  _classificationWriteFailed(cycleId, detail) {
    // ONE named line per cycle, not one per tick: the write is retried on every
    // ordinary tick for as long as it keeps failing, and a flood of identical
    // lines would bury the one that matters.
    if (this.capsuleAckClassificationFailedCycleId !== cycleId) {
      this.capsuleAckClassificationFailedCycleId = cycleId;
      this._event('capsule-ack-classification-write-failed', {
        cycle_id: cycleId,
        detail,
        // Stated, because the previous wording called this merely nonfatal:
        // a restore cannot read an absent record as clean legacy state, so the
        // consequence is a named re-request, never a silent authorization.
        consequence: 'ownership-unestablished',
      }, REFUSAL_DETAIL_MAX);
    }
    return 'failed';
  }

  // Reconcile the runner's ack evidence with the cycle the core is actually in.
  // Runs once per tick, immediately after transport.tick() and BEFORE the scan,
  // so an abandonment the transport performed inside that call cannot be
  // followed by a scan that re-latches the dead cycle's ack.
  //
  // FIRST-TICK checkpoint-confirmed (#90 shape 2): the guard this replaces
  // keyed on the POST-transition state being `checkpoint-requested` or
  // `HOLD:*`, and the transport can walk `checkpoint-requested ->
  // checkpoint-confirmed` inside one tick, so a relaunch into an
  // already-satisfied checkpoint never initialized anything and parked on
  // runner-capsule-not-acked {cycle_id:null} for the life of the process.
  // Initialization is keyed on the CYCLE IDENTITY instead -- the stable fact,
  // the same one before and after any number of in-tick transitions -- so
  // every live cycle initializes exactly once regardless of which state the
  // tick ends in.
  _syncCapsuleAckLifecycle(coreResult) {
    const state = coreResult?.state ?? null;
    const cycleId = typeof state?.cycle_id === 'string' && state.cycle_id.length > 0
      ? state.cycle_id
      : null;

    // The cycle ended (idle / released / no cycle at all) or was replaced by a
    // different one. Either way the evidence and the window die with it.
    if (cycleId === null || cycleId !== (this.capsuleAck ?? this.capsuleAckWatch)?.cycle_id) {
      // FIRST, while this cycle's own cursor is still available: carry forward
      // the answers it may still receive (T1). Fires exactly once per cycle
      // change, including for a cycle that spent its acknowledgement and so
      // holds no evidence here at all.
      this._retireAccountedCycle(cycleId, cycleId === null ? 'cycle-ended' : 'cycle-replaced');
      if (this.capsuleAck !== null || this.capsuleAckWatch !== null) {
        this._invalidateCapsuleAck(
          cycleId === null ? 'cycle-ended' : 'cycle-replaced',
          {
            cycle_id: cycleId,
            core_state: state?.state ?? null,
            abandoned_cycle_id: coreResult?.abandoned_cycle_id ?? null,
          },
        );
      }
      if (this.capsuleAckSpent !== null && this.capsuleAckSpent.cycle_id !== cycleId) {
        this.capsuleAckSpent = null;
      }
      if (this.capsuleAckRecoveryCycleId !== cycleId) {
        this.capsuleAckRecoveryCycleId = null;
      }
    }
    if (cycleId === null) return null;

    // A HOLD that keeps the cycle is NOT an abandonment: same cycle_id, so the
    // evidence above was preserved and there is nothing to initialize.
    if (this._capsuleAckAuthorizes(cycleId)) return this.capsuleAck;
    if (this.capsuleAckWatch !== null) return null;
    if (this._ackAlreadySpent(cycleId)) return null;

    // No window for this cycle yet: this is the cycle's one initialization.
    return this._restoreCapsuleAckWatch(state, cycleId);
  }

  // Recover the cycle's own evidence window from the boundary the transport
  // persisted when the cycle opened (#90 shape 1).
  //
  // The replaced code seeded the scan from runtime/stop-writer/<session>.json,
  // whose `offset` stop-capsule-writer.mjs captures at Stop-hook time -- AFTER
  // the ack it was being used to find. The scan is forward-only, so the ack on
  // disk was invisible and the request was re-injected on every relaunch.
  //
  // The boundary is read from the cycle state the core just handed us, so it is
  // the same snapshot as the cycle_id it is checked against. It is BOUNDED (one
  // CAPSULE_ACK_WINDOW_BYTES read per tick, forward only, never backward and
  // never a whole-transcript sentinel sweep), SESSION-BOUND (the transcript is
  // resolved from this.sessionId and the boundary must name that session), and
  // PROVENANCE-CHECKED (it must name this cycle, and its offset may not sit
  // past the end of the transcript it claims to index).
  //
  // Legacy / absent / foreign / malformed boundaries all land in the same
  // place: a named event, no window, and the existing safe re-request path.
  //
  // THE RESTORE IS WHERE S1 LIVES (re-review 5556245936). The boundary alone is
  // the offset at which this cycle OPENED, so on its own it reopens the window
  // over everything that happened since -- including a retired request's answer
  // that the previous process already classified and rejected. The cycle's
  // durable `ack_classification` carries exactly the two facts needed to stop
  // that, and this is the one reader of them:
  //   - the window opens at max(boundary, classified_through), so an already
  //     rejected record is never re-read as evidence;
  //   - debts that were still outstanding REBUILD the ledger, so an answer that
  //     lands after the relaunch still discharges the oldest outstanding
  //     request instead of authorizing this cycle.
  // Absent means "nothing was ever classified" and the boundary alone is right
  // (this is also the legacy shape). A record that is present but UNUSABLE is
  // refused, by name, into the same safe re-request path as a bad boundary:
  // it claims to carry an exclusion and cannot, and silently dropping the
  // exclusion is the one outcome S1 forbids.
  _restoreCapsuleAckWatch(state, cycleId) {
    const problem = capsuleAckBoundaryProblem(state, {
      sessionId: this.sessionId,
      cycleId,
    });
    if (problem) return this._capsuleAckWatchUnrecoverable(cycleId, problem);

    const classification = capsuleAckClassification(state, {
      sessionId: this.sessionId,
      cycleId,
    });
    if (classification !== null && classification.ok !== true) {
      return this._capsuleAckWatchUnrecoverable(cycleId, {
        code: classification.code,
        detail: classification.detail ?? null,
      });
    }
    const boundaryOffset = state.ack_boundary.transcript_offset;
    const classifiedThrough = classification === null
      ? 0
      : classification.record.classified_through;
    const debts = classification === null
      ? 0
      : classification.record.debts_outstanding;
    const offset = Math.max(boundaryOffset, classifiedThrough);

    const transcript = this._transcriptPath();
    let size = null;
    if (transcript) {
      try { size = fs.statSync(transcript).size; } catch { size = null; }
    }
    if (size === null) {
      return this._capsuleAckWatchUnrecoverable(cycleId, {
        code: 'ack-boundary-transcript-unreadable',
        detail: { path: transcript },
      });
    }
    // --- UNKNOWN IS NOT CLEAN (re-review 5558958106, T2) ------------------
    // An ABSENT classification used to mean "nothing was ever classified, use
    // the boundary alone". That reading is only safe if the absence proves
    // nothing happened -- and it does not, because a classification WRITE CAN
    // FAIL. Measured: a retirement whose debt write was refused, its late
    // answer correctly rejected in memory, the exclusion write refused too,
    // and then an ordinary restore over the untouched saved cycle read the
    // absence as clean legacy state, re-read the rejected answer and
    // authorized the live cycle. A named diagnostic is not a recovery.
    //
    // So absence is an UNRESOLVED OWNERSHIP CONDITION, and the recovery is the
    // one that already exists: no window, named, and one fresh request whose
    // window opens at the transcript's end. It is NOT a park -- that was the
    // objection that ruled out requiring `ack_boundary` itself -- and the
    // request gate bounds it to one per cycle per process.
    //
    // THE DISCRIMINATOR, and why this does not weaken the #90 restore: the
    // runner now writes this record for EVERY live cycle (see
    // _persistCapsuleAckClassification), zeros included, so "present" is the
    // norm and absence is genuinely anomalous. The one tick where absence is
    // normal is the tick that CREATED the cycle -- the transport nulls the
    // field as it captures the boundary, and the runner's write comes later in
    // that same tick -- and in that tick the window is EMPTY by construction,
    // because the boundary was captured moments earlier. An empty window holds
    // no evidence to misattribute, so it restores normally. A NON-EMPTY window
    // with no record is the unresolved case.
    if (classification === null && offset < size) {
      return this._capsuleAckWatchUnrecoverable(cycleId, {
        code: 'ack-classification-unestablished',
        detail: { from: offset, size, unread: size - offset },
      });
    }
    // STILL UNRESOLVED (U1). A recorded disposition says a previous tick -- or
    // a previous process -- refused this window and no request has gone out
    // since. It refuses exactly as absence does, and for the same reason: the
    // window was never established, so nothing has certified it clean. This is
    // what makes a DEFERRED recovery survive both the next tick and a
    // same-session restart, rather than living only in memory.
    if (classification !== null && classification.record.pending !== null) {
      return this._capsuleAckWatchUnrecoverable(cycleId, {
        code: classification.record.pending.code,
        detail: { from: offset, size, awaiting: 'capsule-request' },
      });
    }
    if (offset > size) {
      // The window indexes a transcript that no longer exists (truncated,
      // rotated, or a different file under the same name). Reading from it
      // would be reading unowned bytes. Named with BOTH inputs, so an operator
      // can see whether it was the boundary or the classification that was
      // ahead of the file.
      return this._capsuleAckWatchUnrecoverable(cycleId, {
        code: 'ack-boundary-ahead-of-transcript',
        detail: {
          transcript_offset: boundaryOffset,
          classified_through: classifiedThrough,
          from: offset,
          size,
        },
      });
    }
    this.capsuleAckClassifiedThrough = Math.max(
      this.capsuleAckClassifiedThrough, classifiedThrough);
    // SEED THE ANSWER ACCOUNT (T1). The tallies are why a restored cycle that
    // asks again knows it may now receive two completions, and why its
    // abandonment retires the one it has not received. Without this the second
    // request would look like the cycle's first.
    if (classification !== null) {
      this.capsuleAckAccount = {
        cycle_id: cycleId,
        requests_issued: classification.record.requests_issued,
        answers_settled: classification.record.answers_settled,
      };
    }
    // ACCEPTED, NOT EXCLUDED (U2). The frontier above correctly puts this
    // cycle's own accepted answer behind the cursor so it is never re-read --
    // and that is exactly what made it indistinguishable from a foreign one, so
    // a restart discarded a valid unspent acknowledgement and asked again
    // (measured: before restart authorized true and 1/1; after restart
    // authorized false, requests 1, account 2/1, with no new answer).
    //
    // The marker re-establishes the HELD EVIDENCE from its recorded position.
    // It does not re-read the literal and it does not move the frontier
    // backwards, so the rejected foreign answer below it stays rejected; and it
    // does not touch `answers_settled`, which already counted this completion,
    // so nothing is counted twice. A cycle that has already minted its clear
    // intent is NOT re-established: that is the durable half of "spent", and it
    // is the discriminator between accepted-unspent and spent.
    const acceptedRecord = classification === null ? null : classification.record.accepted;
    if (acceptedRecord !== null
      && acceptedRecord.cycle_id === cycleId
      && acceptedRecord.at <= size
      && state.clear_intent === null
      && !this._ackAlreadySpent(cycleId)) {
      this.capsuleAckAccepted = { cycle_id: cycleId, at: acceptedRecord.at };
      if (this._latchCapsuleAck({
        cycleId,
        from: acceptedRecord.at,
        source: 'classification-restore',
      })) {
        this._event('capsule-ack-restored', {
          cycle_id: cycleId,
          at: acceptedRecord.at,
        });
        if (typeof this.transport?.noteCapsuleAck === 'function') {
          // The transport's freshness substitute is in-memory too, so without
          // this the recovered acknowledgement could not lift the checkpoint
          // hold it was accepted under.
          this.transport.noteCapsuleAck({ cycleId });
        }
      }
    }
    if (debts > 0) {
      // REBUILT, not invented: the count is the cycle's own durable record of
      // how many answers were outstanding. No cycle ids survive, so every
      // rebuilt debt is unnamed -- which protects the live cycle exactly as a
      // named one does (see _retireCapsuleRequests). `records_owed` is set to
      // the same count because nothing is known about whose records have
      // landed, and assuming "not yet" only delays the closure, which is the
      // conservative direction.
      this.capsuleAckRetired = {
        session_id: this.sessionId,
        from: offset,
        owed: debts,
        records_owed: debts,
        cycle_ids: [],
        names_dropped: debts,
      };
      this._event('capsule-ack-retired-restored', {
        cycle_id: cycleId,
        from: offset,
        owed: debts,
      });
    }
    this.capsuleAckWatch = {
      session_id: this.sessionId,
      cycle_id: cycleId,
      from: offset,
      drained: offset >= size,
      request_records_seen: 0,
    };
    this.capsuleAckSkipping = false;
    this._event('capsule-ack-watch-restored', {
      cycle_id: cycleId,
      from: offset,
      size,
      // Only when they actually moved the window, so the ordinary restore line
      // keeps the shape it has always had.
      ...(classifiedThrough > boundaryOffset
        ? { boundary: boundaryOffset, classified_through: classifiedThrough }
        : {}),
      ...(debts > 0 ? { debts_restored: debts } : {}),
      ...(classification !== null
        && (classification.record.requests_issued > 0
          || classification.record.answers_settled > 0)
        ? {
          requests_issued: classification.record.requests_issued,
          answers_settled: classification.record.answers_settled,
        }
        : {}),
    });
    return null;
  }

  // No usable boundary. Fail VISIBLY and fail SAFE: no window is opened (so no
  // unowned bytes are ever read as evidence), the cycle is marked as owing a
  // fresh request, and the clear stays refused by name until a new ack for
  // THIS cycle arrives. Never a silent authorization and never an indefinite
  // park: the request gate in tick() sees the missing window and re-requests.
  //
  // WHAT THIS EVENT MAY CLAIM (#90/#91 review, R2). It used to say
  // `recovery: capsule-re-requested` at the moment the boundary failed --
  // before any gate had run and whether or not a request was ever written. On
  // the measured specimen (unrecoverable boundary while a checkpoint HOLD was
  // still justified) nothing was requested at all and the line said otherwise,
  // which is the worst thing a diagnostic can do. It now states the OWING:
  // `capsule-request-pending`. The separate `capsule-ack-recovery-requested`
  // event is written by _writeCapsuleRequest, and only once the request
  // actually reached the PTY.
  _capsuleAckWatchUnrecoverable(cycleId, problem) {
    this.capsuleAckWatch = null;
    this.capsuleAckSkipping = false;
    // DURABLE, NOT JUST FOR THIS TICK (U1). The refusal used to live only as
    // long as the tick it happened in, and the unconditional classification
    // write later in that same tick replaced it with valid zeros -- so the next
    // tick reinitialized, found a present record, bypassed this guard and
    // reopened the very window that could not be established. Recording the
    // disposition means a DEFERRED recovery stays refused until a request
    // actually goes out. It applies to every code here, not only the
    // classification one: a malformed classification is itself overwritten by
    // that zero write, so it had the same hole.
    if (typeof cycleId === 'string' && cycleId.length > 0) {
      this.capsuleAckPending = { cycle_id: cycleId, code: problem.code };
    }
    if (this.capsuleAckRecoveryCycleId !== cycleId) {
      this.capsuleAckRecoveryCycleId = cycleId;
      // ONE line per occurrence. _event already writes itself to the daemon
      // error log, carrying cycle_id, code, detail and recovery; the separate
      // prose _diagnostic this replaces said the same thing twice (review of
      // 78a2577, F9).
      this._event('capsule-ack-window-unrecoverable', {
        cycle_id: cycleId,
        code: problem.code,
        detail: problem.detail ?? null,
        recovery: 'capsule-request-pending',
      }, REFUSAL_DETAIL_MAX);
    }
    return null;
  }

  // The window is armed by the caller, bound to the cycle this request belongs
  // to, so this writer can never open an unowned one.
  _fireCapsuleRequest() {
    // Text write throws propagate to the caller's fail-closed catch — nothing
    // is scheduled for a request that never reached the PTY.
    this._event('capsule-request-write', CAPSULE_REQUEST_TEXT);
    // Inside the gate _writeCapsuleRequest is holding (#104). The held-gate
    // form records `last_write_at` so the hook drains the bytes still in flight
    // before it lets a permission check start; it cannot refuse here, because
    // the hold already proved nothing was pending and nothing can have been
    // added since.
    const interlocked = this._interlockedWrite(
      'capsule-request',
      () => this.pty.write(CAPSULE_REQUEST_TEXT),
    );
    if (!interlocked.ok) {
      // Only reachable if the state file became unwritable between the hold and
      // here. Fail closed the same way a PTY write failure does: nothing is
      // scheduled, the text never went out, and the refusal is named.
      const failure = new Error(`interlock refused the capsule request: ${interlocked.detail?.reason ?? interlocked.code}`);
      failure.code = interlocked.code;
      failure.detail = interlocked.detail;
      throw failure;
    }
    const result = interlocked.result;
    // From this moment the composer may hold '/context-capsule' unsubmitted;
    // the queued-input flush leads with a kill-line while this flag is up, so
    // operator bytes can never concatenate onto stranded command text.
    this.composerMayHoldControlText = true;
    this._clearEnter();
    this.enterToken += 1;
    const token = this.enterToken;
    // A FRESH Enter, so the #104 deferral budget starts over. It is per-Enter,
    // not per-session: a request whose Enter was held for 30s and then landed
    // must not leave the NEXT one with a shortened budget.
    this.enterDeferrals = 0;
    this.enterDeferredAt = null;
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
    // M1, same as _writeControlEnter: never return holding the handle slot.
    if (this.closed) {
      this.enterHandle = null;
      this.enterDeferredAt = null;
      return;
    }
    // DIALOG READINESS (#104). The measured defect's second leg: the request
    // text is already in the composer and this is the Enter that, at a
    // permission dialog, selects "Yes". Re-read, because the hazard is a dialog
    // that appeared AFTER the text write's own check -- which is also the one
    // thing the text-write gate cannot cover (see _automaticWriteReadiness on
    // why this is not a lock).
    const readiness = this._automaticWriteReadiness('capsule-request-enter');
    if (!readiness.ready) {
      this._deferAutomaticEnter(
        'capsule-request-enter',
        () => this._writeCapsuleRequestEnter(token),
        readiness,
      );
      return;
    }
    // ─── THE INTERLOCK (#104) ────────────────────────────────────────────────
    // The gate, the pending re-read and the keypress are one critical section.
    // A marker recorded by the hook between the readiness check above and this
    // line is therefore seen -- which is the case the transcript reader cannot
    // see at all when the host has not flushed. A refusal DEFERS exactly like a
    // readiness refusal: same token, same handle slot, same stranded-text flag.
    let interlocked;
    try {
      interlocked = this._interlockedWrite('capsule-request-enter', () => {
        this._event('capsule-request-enter-write', CONTROL_ENTER);
        return this.pty.write(CONTROL_ENTER);
      });
    } catch (error) {
      // A PTY write that threw INSIDE the critical section. The gate is already
      // released (_interlockedWrite's finally), and the pre-#104 handling is
      // unchanged: the text may sit in the composer unsubmitted, the flag stays
      // up for the kill-line protection, no retry, no ack, no clear.
      this._automaticWriteReleased('capsule-request-enter');
      this.enterHandle = null;
      this.enterDeferrals = 0;
      this.enterDeferredAt = null;
      this.lastReason = {
        code: 'runner-capsule-request-enter-write-failed',
        detail: errorText(error),
      };
      this._event('capsule-request-enter-write-failed', this.lastReason);
      return;
    }
    if (!interlocked.ok) {
      this._deferAutomaticEnter(
        'capsule-request-enter',
        () => this._writeCapsuleRequestEnter(token),
        interlocked,
      );
      return;
    }
    this._automaticWriteReleased('capsule-request-enter');
    this.enterHandle = null;
    this.enterDeferrals = 0;
    this.enterDeferredAt = null;
    this.composerMayHoldControlText = false;
  }

  _writeCapsuleRequest(cycleId) {
    if (this.capsuleRequestCycleId === cycleId) return false;
    // COMPOSER GUARD (measured live 2026-09-24): the request fired while the
    // operator had a partially typed prompt in the composer. No hold and no
    // pending Enter exist at this boundary, so those bytes had already passed
    // straight through — and '/context-capsule' + Enter were appended to them
    // and submitted as one mangled prompt. The legacy supervisor refused this
    // case ("ENTRY-BLOCKED: composer already holds OTHER content"). The only
    // honest signal the runner has is the input tracker: operator bytes seen
    // since the last CR mean the composer MAY hold text, and any unfinished or
    // editing control means the runner cannot say. Either way: DEFER. Never a
    // kill-line (that destroys the operator's text), never a timing sleep.
    // The state is persistent, so the tick re-enters here until the composer
    // is known empty (the operator submits) and the request then fires in
    // the usual two-phase shape. The cycle_id latch is spent by the FIRE
    // below, not by the deferral — a deferred cycle still owns its one write.
    // Once per cycle, not per tick: _event is a state-change log.
    // FAIL-CLOSED CONSEQUENCE, stated plainly: the runner cannot see the
    // composer, and a CR on a CLEAN line is the only boundary the tracker
    // trusts outright. An operator who typed and then cleared the line with
    // Esc or Ctrl+C leaves the tracker tainted, so the request stays deferred
    // until their next Enter AND the prompt it sent shows up in the transcript
    // (tracker pendingSubmission, runner _checkPendingSubmission) — the
    // transport sits at checkpoint-confirmed (not HOLD) with pressure still
    // climbing, signalled by the one deferred event here plus the
    // composer-busy refusal _prepareSubmission repeats each tick, its detail
    // naming `pendingSubmission:true` while the evidence is awaited. Chosen
    // over guessing: a wrong "empty" verdict is exactly the mangled prompt above.
    // Known gap, not closed here: a relaunch starts a fresh tracker
    // (knownEmpty) even if the composer already held text from before.
    const composer = this.input.snapshot();
    if (!composer.knownEmpty) {
      if (this.capsuleRequestDeferredCycleId !== cycleId) {
        this.capsuleRequestDeferredCycleId = cycleId;
        this.lastReason = {
          code: 'runner-capsule-request-composer-busy',
          detail: { cycle_id: cycleId, input: composer },
        };
        this._event('capsule-request-deferred', this.lastReason);
      }
      return false;
    }
    // ─── DIALOG READINESS (#104) ───────────────────────────────────────────
    // ALONGSIDE the composer guard above, never instead of it. The composer
    // guard models the composer TEXT LINE; it knows nothing about a modal
    // dialog, and with a dialog open and nothing typed it reads CLEAN. That is
    // the defect: the request text went out and its Enter 400ms later selects
    // "Yes" at a permission prompt (measured, binary 2.1.309 -- see
    // toolCallRecord). Neither guard is sufficient alone and both must pass.
    //
    // DEFER, and deliberately BEFORE the ownership tally below: the cycle_id
    // latch stays unspent, so this cycle still owns its one write and an
    // ordinary later tick issues it once the call is answered. One event per
    // boundary per reason, not one per tick.
    const readiness = this._automaticWriteReadiness('capsule-request');
    if (!readiness.ready) {
      this._automaticWriteHeld('capsule-request', readiness);
      // RECORDED SO THE CLEAR'S REFUSAL CAN NAME IT. _prepareSubmission used
      // to decide between "not acked" and "composer busy" from the composer
      // latch alone; with a third reason for a request not having gone out,
      // that choice would have reported a composer that is demonstrably clean.
      // Same objection as the one that put the composer case there.
      this.capsuleRequestReadinessHold = {
        cycle_id: cycleId,
        code: readiness.code,
        detail: readiness.detail,
      };
      return false;
    }
    // ─── THE INTERLOCK GATE IS TAKEN HERE, BEFORE ANYTHING IS SPENT ──────────
    // The readiness check above proved nothing was pending a moment ago; this
    // TAKES the gate so nothing can become pending until the text is written.
    // It has to be here rather than down in _fireCapsuleRequest, because by
    // then the cycle_id latch has been spent and the ownership tally persisted
    // -- a refusal at that point would cost the cycle its one request with no
    // retry. Taken before the spend, a refusal costs one tick, exactly like the
    // composer and readiness deferrals above.
    //
    // _holdInterlockGate re-reads the pending map INSIDE the gate, so this is
    // also the read that cannot be raced by the hook.
    const gateHold = this._holdInterlockGate('capsule-request');
    if (!gateHold.ok) {
      const readinessLike = {
        ready: false,
        code: gateHold.code === 'interlock-permission-pending' || gateHold.code === 'interlock-pending-stale'
          ? 'runner-permission-check-pending'
          : 'runner-interlock-not-ready',
        detail: { reason: gateHold.code, at: 'capsule-request', ...(gateHold.detail === null || typeof gateHold.detail !== 'object' ? {} : gateHold.detail) },
      };
      this._automaticWriteHeld('capsule-request', readinessLike);
      this.capsuleRequestReadinessHold = {
        cycle_id: cycleId,
        code: readinessLike.code,
        detail: readinessLike.detail,
      };
      return false;
    }
    try {
      return this._writeCapsuleRequestUnderGate(cycleId);
    } finally {
      this._releaseInterlockGate('capsule-request');
    }
  }

  // Everything from "this cycle is going to ask" to "the text is in the
  // composer", inside the held gate. Split out purely so the gate release is a
  // single `finally` rather than repeated on each of the tally's exit paths.
  _writeCapsuleRequestUnderGate(cycleId) {
    this.capsuleRequestReadinessHold = null;
    this._automaticWriteReleased('capsule-request');
    if (this.capsuleRequestDeferredCycleId === cycleId) {
      this._event('capsule-request-resumed', { cycle_id: cycleId });
    }
    // OWNERSHIP BEFORE THE OBLIGATION (re-review 5558958106, T1 and T2). Issuing
    // a request creates one more possible completion, and the count must be
    // DURABLE before the request exists -- the second request for a cycle is
    // issued by a different process from the first, and a restore that cannot
    // see the count cannot know how many answers are still owed. So the tally
    // is incremented and persisted here, and if it cannot be made durable the
    // request is NOT written: creating an obligation the runner cannot account
    // for is the condition T2 ruled unsafe, and the deferral is the explicit
    // recovery. The cycle_id latch is left unspent, so the next ordinary tick
    // retries -- one attempt per tick, no retry loop and no backoff timer,
    // exactly like the composer deferral above.
    const account = this._capsuleAccountFor(cycleId);
    // ─── THE RESOLUTION AND ITS REPLACEMENT ARE ONE WRITE (V1) ─────────────
    // Resolving the unresolved disposition used to be durable while the
    // exclusion it depends on was not. `pending: null` and the issue tally were
    // persisted, and then _armCapsuleAckWatch moved only the IN-MEMORY cursor
    // to the transcript's end -- neither `ack_boundary` nor
    // `classified_through` was advanced to that replacement position. So a
    // later restore reopened the ORIGINAL boundary and accepted the very answer
    // the pending marker had just correctly refused. Measured: before the
    // restart boundary 317, reader 543, classified_through 0, pending null,
    // authorized(B) false; after it, with no new transcript data, reader 317
    // and authorized(B) true via `transcript-scan`.
    //
    // The replacement exclusion therefore rides the SAME record that clears
    // pending. Advancing `classified_through` is the equivalent durable
    // exclusion the reviewer allows, and it needs no rewrite of `ack_boundary`
    // because the restore already opens at
    // max(ack_boundary.transcript_offset, classified_through).
    //
    // ONE WRITE, so a failure leaves NOTHING resolved: the tally, the
    // disposition and the frontier are all rolled back together and the request
    // is not written. And if the replacement position cannot even be resolved,
    // a pending disposition is not cleared at all -- there would be no
    // exclusion to put in its place.
    const replacement = this._transcriptEnd();
    const pendingBeforeRequest = this.capsuleAckPending;
    // An UNRESOLVABLE replacement position does not block the request -- it
    // just does not resolve anything. _armCapsuleAckWatch opens no window for
    // it either, so nothing can be latched for this cycle and the clear stays
    // refused by name; leaving the disposition set is the honest record of
    // that, and a later restore re-requests rather than reopening the old
    // window. Blocking instead would break the legitimate recovery for a cycle
    // whose transcript does not exist yet -- a seat rebound onto a new session,
    // which is exactly where `ack-boundary-absent` recovery lives.
    const resolvesPending = pendingBeforeRequest?.cycle_id === cycleId
      && replacement !== null;
    if (pendingBeforeRequest?.cycle_id === cycleId && replacement === null) {
      this._event('capsule-request-boundary-unresolved', {
        cycle_id: cycleId,
        code: pendingBeforeRequest.code,
      });
    }
    const frontierBeforeRequest = this.capsuleAckClassifiedThrough;
    const acceptedBeforeRequest = this.capsuleAckAccepted;
    account.requests_issued += 1;
    if (resolvesPending) this.capsuleAckPending = null;
    if (replacement !== null) {
      this.capsuleAckClassifiedThrough = Math.max(frontierBeforeRequest, replacement);
    }
    // A request going out supersedes any earlier accepted answer for this
    // cycle: the gate only reaches here when none is held, so a surviving
    // marker could only resurrect an answer this request replaces.
    if (acceptedBeforeRequest?.cycle_id === cycleId) this.capsuleAckAccepted = null;
    if (this._persistCapsuleAckClassification(cycleId) === 'failed') {
      account.requests_issued -= 1;
      this.capsuleAckPending = pendingBeforeRequest;
      this.capsuleAckClassifiedThrough = frontierBeforeRequest;
      this.capsuleAckAccepted = acceptedBeforeRequest;
      this.lastReason = {
        code: 'runner-capsule-request-ownership-unrecorded',
        detail: { cycle_id: cycleId },
      };
      if (this.capsuleRequestOwnershipCycleId !== cycleId) {
        this.capsuleRequestOwnershipCycleId = cycleId;
        this._event('capsule-request-ownership-unrecorded', this.lastReason);
      }
      return false;
    }
    this.capsuleRequestOwnershipCycleId = null;
    this.capsuleRequestCycleId = cycleId;
    // A request going out now cannot be answered by anything already on disk,
    // so the cycle's window re-opens at the transcript's current end. The gate
    // that reached here proved this cycle holds no ack, and the lifecycle
    // boundary guarantees any evidence is either absent or this cycle's own, so
    // there is nothing to invalidate -- only a window to replace.
    //
    // THE WINDOW THIS REPLACES IS EVIDENCE (#90/#91 review, R3). Re-arming
    // moves the cursor to the transcript's end, so a valid restored window that
    // still had unread bytes in it would lose whatever those bytes held. The
    // caller's gate is what guarantees that cannot happen: it only reaches here
    // when the cycle has no window at all, or when its window has been read to
    // the end of the transcript (`drained`). That guard used to be applied at
    // `checkpoint-confirmed` alone, which is how a `checkpoint-requested`
    // restore with the ack beyond the first bounded read wrote a second request
    // and buried its own answer behind the new cursor.
    this._armCapsuleAckWatch(cycleId, replacement);
    const result = this._fireCapsuleRequest();
    // RECOVERY, CLAIMED ONLY ONCE IT HAPPENED (R2). A throw out of
    // _fireCapsuleRequest never reaches this line, so the event cannot report a
    // request that did not go out.
    if (this.capsuleAckRecoveryCycleId === cycleId) {
      this._event('capsule-ack-recovery-requested', { cycle_id: cycleId });
    }
    return result;
  }

  // Scan the transcript (clean text, no ANSI — unlike the screen) for the
  // capsule ack literal past the cycle's own boundary. On sight, tell the
  // transport: the ack substitutes for telemetry FRESHNESS only. Bounded read
  // (one window per tick), forward only, stops for the cycle once seen.
  //
  // The window IS the identity: whatever this finds is attributed to
  // `watch.cycle_id`, never to "the current cycle", so a scan that runs after
  // an abandonment has no window to attribute anything to.
  _checkCapsuleAck() {
    const watch = this.capsuleAckWatch;
    if (this.capsuleAck !== null || watch === null) return false;
    try {
      const transcript = this._transcriptPath();
      if (!transcript) return false;
      const size = fs.statSync(transcript).size;
      const from = watch.from;
      if (size <= from) {
        watch.drained = true;
        return false;
      }
      // ─── THE FRONTIER (re-review 5556245936, S3) ───────────────────────────
      // DRAINING FIRST IS NOT ENOUGH. Both readers are bounded to one window per
      // tick and the retired cursor starts EARLIER, so with a multi-window
      // backlog the live reader runs far ahead of the classification it depends
      // on: measured retired cursor 775379 against live cursor 2500517, debt
      // still 1, nothing consumed, and authorized(B) true -- on complete,
      // ordinary records in submission order, with no oversize line and no
      // appeal to the closure rule.
      //
      // So while any debt is outstanding, the retired cursor is a CEILING: the
      // live scan may not read a byte that has not yet been classified against
      // the earlier outstanding requests. It is one shared frontier, not a
      // second budget -- each reader still performs at most one bounded read per
      // tick, and the retired reader advances the ceiling as it goes, so the
      // live cycle's own answer is simply collected a few ticks later. With no
      // ledger (the overwhelmingly common case) there is no ceiling and nothing
      // changes.
      const ceiling = this.capsuleAckRetired === null ? null : this.capsuleAckRetired.from;
      if (ceiling !== null && from >= ceiling) {
        // Unclassified evidence lies ahead. NOT `drained`: the cycle still owns
        // unread bytes, so the request gate must not re-ask over them either.
        watch.drained = false;
        if (!this.capsuleAckDeferringToLedger) {
          this.capsuleAckDeferringToLedger = true;
          this._event('capsule-ack-scan-deferred', {
            cycle_id: watch.cycle_id,
            from,
            retired_from: ceiling,
            owed: this.capsuleAckRetired.owed,
          });
        }
        return false;
      }
      this.capsuleAckDeferringToLedger = false;
      // The literal also appears in the capsule SKILL's own instructions, and a
      // seat can mention it in prose, thinking, or a tool call. A mention is not
      // a use (measured live 2026-08-05: a raw substring scan acked while the
      // capsule was still being written; issue #79: the tag check was still a
      // substring one level down). Only a COMPLETE assistant record's text line
      // counts (see isAckLine). A half-written line matches nothing and the
      // offset only moves past complete lines, so no half is ever stranded.
      const budget = ceiling === null
        ? CAPSULE_ACK_WINDOW_BYTES
        : Math.min(CAPSULE_ACK_WINDOW_BYTES, ceiling - from);
      const clamped = budget < CAPSULE_ACK_WINDOW_BYTES;
      const { lines, ends, skipped, nextOffset } = readCompleteLines(
        transcript, from, budget);
      if (skipped && clamped) {
        // A read cut short by the ceiling that happens to contain no newline is
        // NOT proof of an oversize record, so it may not step the cursor over
        // one. Wait for the ceiling to move instead.
        watch.drained = false;
        return false;
      }
      // In file order, so the request record that belongs to this cycle is
      // noted before any answer that follows it (#90/#91 review, R1). The
      // flag is PROVENANCE the retired-request ledger consumes: a cycle whose
      // request the host has already recorded cannot be mistaken, after it
      // dies, for the next cycle whose record is still to come.
      // A RECORD BELONGS TO ONE REQUEST. While the ledger is still waiting for
      // a retired request's own record, this cycle claims none -- the record it
      // would be looking at is at least as likely to be the retired one's, and
      // claiming it would understate `records_owed` on a later retirement and
      // close the ledger one record early. Likewise a record the ledger has
      // already attributed is excluded by offset. Both refusals are
      // conservative: an unclaimed record only makes the ledger wait longer.
      const ledgerOwesRecords = (this.capsuleAckRetired?.records_owed ?? 0) > 0;
      // One record per request this cycle has issued -- a restored cycle that
      // asked again will produce two, and both are its own (T1).
      const issued = this.capsuleAckAccount?.cycle_id === watch.cycle_id
        ? this.capsuleAckAccount.requests_issued
        : 0;
      let latched = false;
      let refused = false;
      let settledAt = null;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (watch.request_records_seen < issued
          && !ledgerOwesRecords
          && ends[i] > this.capsuleRetiredRecordEnd
          && isCapsuleRequestRecord(line)) {
          watch.request_records_seen += 1;
          this._event('capsule-request-recorded', {
            cycle_id: watch.cycle_id,
            at: ends[i],
            seen: watch.request_records_seen,
            issued,
          });
          continue;
        }
        if (!isAckLine(line)) continue;
        if (this._latchCapsuleAck({
          cycleId: watch.cycle_id,
          from,
          source: 'transcript-scan',
        })) latched = true;
        else refused = true;
        settledAt = ends[i];
        break;
      }
      if (latched) {
        // ACCOUNTED FOR, AND DURABLY (T1). One of this cycle's possible
        // completions has arrived. The frontier moves past exactly this record
        // so no restore can count the same literal again, and the tally moves
        // so an abandonment knows how many completions are STILL possible --
        // the question `hadAck` answered wrongly.
        this._settleCapsuleAnswer(watch.cycle_id, settledAt, { accepted: true });
        this._event('capsule-ack-observed', CAPSULE_ACK_LITERAL);
        if (typeof this.transport?.noteCapsuleAck === 'function') {
          // Named, so the transport can refuse evidence for a cycle it is no
          // longer in rather than treating the timestamp as news.
          this.transport.noteCapsuleAck({ cycleId: watch.cycle_id });
        }
        return true;
      }
      if (refused) {
        // Unattributable or already spent: the literal is real but it buys
        // nothing. It is still one of THIS cycle's completions, so it is
        // accounted for -- otherwise the cycle would look like it were still
        // owed an answer it has already received. Advance the window so the
        // same line is not re-examined, and record the refusal DURABLY -- a
        // restore must not re-read a literal this cycle has already rejected
        // (S1).
        watch.from = Math.max(from, nextOffset);
        watch.drained = watch.from >= size;
        this._settleCapsuleAnswer(watch.cycle_id, watch.from);
        return false;
      }
      // One event per skip run, not per tick.
      if (skipped && !this.capsuleAckSkipping) this._event('capsule-ack-window-skip', { from, length: nextOffset - from });
      this.capsuleAckSkipping = skipped;
      watch.from = Math.max(from, nextOffset);
      // The whole window is read: the cycle demonstrably has no ack on disk,
      // which is what licenses a re-request rather than an indefinite wait.
      watch.drained = watch.from >= size;
      return false;
    } catch { return false; }
  }

  // Pair the tracker's outstanding queue with the transcript offset at the
  // moment its FIRST entry went by: only a record written after that CR can
  // belong to any queued CR, and the offset then only advances (records are
  // consumed in order, review 5480136713). A drained queue drops the watch
  // so the next CR notes afresh. Offset resolution failures read as 0 --
  // fail-closed only in the sense that the watch still waits for records;
  // the path is re-resolved each tick (see _checkPendingSubmission).
  _notePendingSubmission() {
    if (this.input.outstanding.length === 0) {
      this.pendingSubmissionWatch = null;
      return;
    }
    if (this.pendingSubmissionWatch === null) {
      let transcript = null;
      let offset = 0;
      try {
        transcript = transcriptPathFor({ cwd: this.cwd, sessionId: this.sessionId, homeDir: this.homeDir, env: this.env });
        offset = transcript ? fs.statSync(transcript).size : 0;
      } catch { offset = 0; }
      this.pendingSubmissionWatch = { transcript, offset, midLine: false };
    }
    const pending = this.input.pendingSubmission;
    if (pending !== null && this.lastUncertainUnits !== pending.units) {
      this.lastUncertainUnits = pending.units;
      this._event('submission-uncertain', {
        units: pending.units,
        offset: this.pendingSubmissionWatch.offset,
        outstanding: this.input.outstanding.length,
      });
    }
  }

  // LIVENESS for an edited-then-submitted prompt (review of 436c1dd, MED):
  // the tracker will not read a CR on a tainted line as a submission, so the
  // runner proves it with evidence it already reads -- the bound session's
  // transcript. A genuinely submitted prompt lands there as a NEW non-meta
  // "type":"user" record with prompt text (string content or a text block;
  // tool_result blocks and isMeta records are the child's own bookkeeping,
  // not prompts) past the offset noted when the CR went by. Same bounded
  // read and complete-line discipline as _checkCapsuleAck; additionally a
  // single line longer than the window is skipped whole (a multi-hundred-k
  // tool_result record must not park the watch for the rest of the session).
  // No timer, no retry: until a record appears the line stays dirty and the
  // capsule request keeps deferring with `pendingSubmission:true` in the
  // refusal detail. A session rebind changes the transcript path; the watch
  // then re-notes against the new file's current size, never its history.
  // ORDERED (review 5480136713): every record found is handed to the tracker
  // in file order and settles the OLDEST outstanding CR -- an earlier clean
  // prompt's late record can never confirm a newer uncertain draft. The scan
  // therefore runs while ANY CR is outstanding, not only an uncertain one,
  // at the same bounded cost per tick (one stat, at most one window read).
  _checkPendingSubmission() {
    if (this.input.outstanding.length === 0) {
      this.pendingSubmissionWatch = null;
      return false;
    }
    if (this.pendingSubmissionWatch === null) this._notePendingSubmission();
    const watch = this.pendingSubmissionWatch;
    try {
      const transcript = transcriptPathFor({ cwd: this.cwd, sessionId: this.sessionId, homeDir: this.homeDir, env: this.env });
      if (!transcript) return false;
      if (watch.transcript !== transcript) {
        watch.transcript = transcript;
        watch.offset = fs.statSync(transcript).size;
        watch.midLine = false;
        return false;
      }
      const size = fs.statSync(transcript).size;
      if (size <= watch.offset) return false;
      const length = Math.min(size - watch.offset, 262144);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(transcript, 'r');
      try { fs.readSync(fd, buffer, 0, length, watch.offset); } finally { fs.closeSync(fd); }
      const lastBreak = buffer.lastIndexOf(0x0a);
      if (lastBreak < 0) {
        // No complete line in the window. A partial tail is read again next
        // tick; a FULL window with no newline is one oversize line -- step
        // over it and discard its remainder up to the next newline.
        if (length === 262144) {
          watch.offset += length;
          watch.midLine = true;
        }
        return false;
      }
      const lines = buffer.toString('utf8', 0, lastBreak).split('\n');
      if (watch.midLine) {
        lines.shift();
        watch.midLine = false;
      }
      watch.offset += lastBreak + 1;
      let confirmed = false;
      for (const line of lines) {
        if (!isOperatorPromptRecord(line)) continue;
        const outcome = this.input.noteOperatorPromptRecord();
        if (outcome === 'confirmed') {
          confirmed = true;
          this._event('submission-confirmed', { offset: watch.offset, input: this.input.snapshot() });
        } else {
          this._event('submission-receipt', { outcome, offset: watch.offset, input: this.input.snapshot() });
        }
      }
      if (this.input.outstanding.length === 0) this.pendingSubmissionWatch = null;
      return confirmed;
    } catch { return false; }
  }

  // ─── DIALOG READINESS (#104) ───────────────────────────────────────────────
  // Establish the outstanding-call reader for the bound transcript, from a
  // BOUNDED TAIL read. This is the whole of the restart story and it needs no
  // new persisted state:
  //
  //   RESTART WHILE A CALL IS PENDING. A new process cannot start its cursor at
  //   the transcript's END -- that is precisely the fail-open trap, because the
  //   pending tool_use is already behind it and its answer will never be seen
  //   either, so the set would look empty forever. It also cannot start at byte
  //   zero: transcripts reach tens of megabytes. So it starts one bounded span
  //   BACK from the end and scans forward. The pending tool_use is at most one
  //   record from the end (the host writes nothing further in a turn that is
  //   blocked on an unanswered call), so the tail is where it always is.
  //
  //   WHY NOT A PERSISTED OFFSET. The persisted-offset machinery exists for
  //   evidence that must not be re-read (an ack buys one clear, so re-reading
  //   it is an authorization bug). Readiness is the opposite: it is a LIVE
  //   predicate, re-derivable from the tail, and re-reading it costs nothing.
  //   A persisted offset would add a way for the record and the file to
  //   disagree -- which is #90 shape 1 -- in exchange for nothing.
  //
  // The scan starts UNANCHORED (`unknownOpen`) whenever it starts above byte
  // zero, and only a top-level assistant record discharges that -- see
  // toolCallRecord. An unanchored baseline is NOT READY: an incomplete read
  // must never present as an empty outstanding-call set.
  _noteToolCallWatch() {
    const transcript = this._transcriptPath();
    // THE INTERLOCK CHECKPOINT IS DROPPED ON EVERY RE-BASELINE (#104). A
    // baseline walk re-reads records this reader may already have counted, so
    // its tool_use total stops being comparable with the hook's invocation
    // count and the delta would read as "the hook missed calls" on a healthy
    // seat. Dropping it makes the next evidence check re-establish the
    // agreement point. Not a hole: a re-baseline also raises `unknownOpen`,
    // which holds every automatic write until an anchor discharges it.
    this.interlockCheckpoint = null;
    const degraded = (code, detail = null) => {
      this.toolCallWatch = {
        transcript,
        from: 0,
        midLine: false,
        outstanding: new Map(),
        // Recently settled ids, so the interlock can discount a marker whose
        // call the transcript has answered (#104).
        settledIds: new Set(),
        unknownOpen: true,
        openResponse: null,
        responsesSeen: 0,
        unknownCause: null,
        degraded: { code, detail },
        baselineSize: null,
        endSeen: null,
      };
      return this.toolCallWatch;
    };
    if (!transcript) return degraded('tool-call-transcript-unresolved');
    let stat;
    try { stat = fs.statSync(transcript); } catch (error) {
      // ENOENT IS A POSITIVE ANSWER, not a missing one. Claude Code creates the
      // transcript with its first record, so an absent file on a RESOLVED path
      // means the bound session has recorded nothing -- and a tool permission
      // dialog cannot exist without a `tool_use` record. Identical in substance
      // to the zero-length case below.
      //
      // LOAD-BEARING FOR THE POST-CLEAR WAKE. That whole family (text, owned
      // Enter, retries) runs before the new session's FIRST record exists; the
      // deterministic suite asserts exactly that (`fs.existsSync(
      // wakeTranscriptPath(harness))` is false at the wake Enter). Treating the
      // absence as "cannot say" would hold the wake forever and lose the
      // post-clear resume on every real clear -- trading a hazard that cannot
      // occur for a certain failure. Any OTHER stat error (EACCES, EIO) says
      // nothing about records and stays a named NOT-READY.
      if (error?.code === 'ENOENT') {
        this.toolCallWatch = {
          transcript,
          from: 0,
          midLine: false,
          outstanding: new Map(),
          // Recently settled ids, so the interlock can discount a marker whose
          // call the transcript has answered (#104).
          settledIds: new Set(),
          unknownOpen: false,
          openResponse: null,
          responsesSeen: 0,
          unknownCause: null,
          degraded: null,
          baselineSize: 0,
          endSeen: 0,
          // RECORDED, NOT RESOLVED HERE. The reader cannot tell the legitimate
          // wake case from a mis-resolved path -- both are simply "no file" --
          // so it reports the fact and lets each write boundary decide whether
          // absence is an answer it is entitled to use
          // (ABSENT_TRANSCRIPT_READY_AT).
          absent: true,
        };
        return this.toolCallWatch;
      }
      return degraded('tool-call-transcript-unreadable', errorText(error));
    }
    const size = stat.size;
    // NOT A REGULAR FILE IS NOT AN EMPTY TRANSCRIPT (CI, ubuntu vs win32).
    // Verified on both platforms: a DIRECTORY stats as size 0 on win32 and 40
    // on linux. With 0 the catch-up loop never runs, readCompleteLines is never
    // called, no EISDIR is ever raised, and the ZERO-LENGTH branch below
    // answers READY -- the branch that means "the host has written no records,
    // so no tool dialog can exist". On linux the same path goes degraded with
    // an EISDIR out of the window read.
    //
    // The linux answer is the right one. A path that resolves to a directory
    // (or a FIFO, or a socket) is not a transcript, and "I cannot read it" must
    // never become "there are no tool calls". Rejecting it HERE, by what the
    // path is rather than by whichever error the platform happens to raise,
    // makes the two platforms agree instead of encoding a `stat` quirk as
    // behaviour -- and makes the class reproducible off CI.
    if (!stat.isFile()) {
      return degraded('tool-call-transcript-not-a-file', {
        directory: stat.isDirectory(),
      });
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      return degraded('tool-call-transcript-size-invalid', { size });
    }
    const from = Math.max(0, size - TOOL_CALL_WINDOW_BYTES * TOOL_CALL_BASELINE_WINDOWS);
    const watch = {
      transcript,
      from,
      // Above byte zero the span begins mid-record, so the first complete line
      // it yields is a tail fragment and is dropped (same discipline as
      // _checkPendingSubmission).
      midLine: from > 0,
      outstanding: new Map(),
      // Recently settled ids, so the interlock can discount a marker whose
      // call the transcript has answered (#104).
      settledIds: new Set(),
      unknownOpen: from > 0,
      // The API response whose calls are currently outstanding (see
      // toolCallRecord). Only a record of a DIFFERENT response clears the set.
      openResponse: null,
      // Distinct response identities this scan has seen SINCE THE LAST UNKNOWN
      // was raised, in order -- reset by an oversize step, because the
      // two-response argument only holds for the prefix of the count (B1).
      // Two is a discharge proof on its own (see _stepToolCallWindow).
      responsesSeen: 0,
      // WHY `unknownOpen` is raised, so the refusal can name it: the scan began
      // above byte zero (an unanchored baseline), or a record larger than one
      // window was stepped over mid-scan. Different situations, different
      // answers. Null whenever `unknownOpen` is false.
      unknownCause: from > 0
        ? { code: 'tool-call-baseline-unanchored', at: from }
        : null,
      degraded: null,
      baselineSize: size,
      // The transcript end this pass saw. Readiness compares the cursor to it:
      // a cursor short of the end means a record is half-written or the file
      // outgrew one catch-up pass, and either way the verdict is "cannot say".
      endSeen: size,
    };
    this.toolCallWatch = watch;
    // Bounded: at most TOOL_CALL_BASELINE_READS reads, once per bind.
    for (let i = 0; i < TOOL_CALL_BASELINE_READS && watch.from < size; i += 1) {
      if (!this._stepToolCallWindow(watch, size)) break;
    }
    if (watch.degraded === null && watch.unknownOpen) {
      // The span held no anchor. Loud and FAIL CLOSED: readiness is unknown,
      // not empty. _checkToolCalls re-baselines on real growth, so this cannot
      // become a per-tick re-scan of the same bytes.
      watch.degraded = {
        // The CAUSE, not a blanket "unanchored": a baseline that walked into an
        // oversize record says so, and says where (B1/D31).
        code: watch.unknownCause?.code ?? 'tool-call-baseline-unanchored',
        detail: {
          from,
          size,
          windows: TOOL_CALL_BASELINE_WINDOWS,
          ...(watch.unknownCause?.at === undefined ? {} : { at: watch.unknownCause.at }),
          ...(watch.unknownCause?.bytes === undefined ? {} : { unread_bytes: watch.unknownCause.bytes }),
        },
      };
    }
    return watch;
  }

  // One bounded window through the one JSONL reader. Returns false when the
  // scan cannot usefully continue this pass (nothing complete to read, or the
  // reader went degraded).
  _stepToolCallWindow(watch, size) {
    const budget = Math.min(TOOL_CALL_WINDOW_BYTES, size - watch.from);
    if (budget <= 0) return false;
    let read;
    try {
      read = readCompleteLines(watch.transcript, watch.from, budget);
    } catch (error) {
      watch.degraded = { code: 'tool-call-window-read-failed', detail: errorText(error) };
      return false;
    }
    const { lines, ends, skipped, nextOffset } = read;
    if (lines.length === 0) {
      // A half-written tail keeps the cursor where it is and is read again.
      // That leaves `from < size`, which readiness reads as NOT caught up --
      // the record being written right now may be the tool_use.
      //
      // A read CUT SHORT by the file's end that happens to contain no newline
      // is NOT proof of an oversize record, so it may not step the cursor over
      // one (the same clamp _checkCapsuleAck applies to its ceiling).
      if (!skipped || budget < TOOL_CALL_WINDOW_BYTES) return false;
      // ONE record longer than a whole window. The step has to be taken or the
      // scan never terminates, and the bytes stepped over may have opened a
      // call -- so the UNKNOWN is recorded instead of being assumed away.
      //
      // THE COUNTER IS RESET HERE, AND THAT IS THE WHOLE OF B1. The
      // two-response discharge below is sound only while the unknown region is
      // the PREFIX OF THE COUNT, and `responsesSeen` is a running total over
      // the entire scan: by the time any real tail has been walked it is
      // already >= 2, so the clause was effectively always satisfied and a
      // stepped region got discharged by records that prove nothing about it.
      // Reproduced on a 300 KB `Write`/`input.content` -- the exact tool shape
      // that raises the dialog -- where a small parallel sibling of the SAME
      // response discharged it and the sibling's own answer then emptied the
      // set, with the Write's dialog still on screen (D27/D28).
      //
      // Resetting restores the precondition. After the step, response #1 proves
      // every call BEFORE it was answered and response #2 proves #1's own calls
      // were; together they cover the stepped region, because a stepped region
      // carries no newline at all and is therefore strictly inside ONE record,
      // hence inside one response.
      //
      // `openResponse` is deliberately NOT reset. Clearing it would make a
      // later block of the stepped record's own response read as FRESH, which
      // would clear a live SIBLING call -- trading this fail-open for a new one.
      // Leaving it is also right on its own terms: a `fresh` verdict after a
      // step still only clears calls from an EARLIER response, which the newer
      // response's existence genuinely proves answered.
      const steppedFrom = watch.from;
      watch.from = nextOffset;
      watch.midLine = true;
      watch.unknownOpen = true;
      watch.responsesSeen = 0;
      // NAMED DISTINCTLY from an unanchored baseline (D31): "a record bigger
      // than the window went unread at offset N" and "the tail held no anchor"
      // are different situations with different operator answers, and the
      // offset is what makes the first one actionable.
      watch.unknownCause = {
        code: 'tool-call-oversize-record-unread',
        at: steppedFrom,
        bytes: nextOffset - steppedFrom,
      };
      return true;
    }
    let first = 0;
    if (watch.midLine) {
      first = 1;
      watch.midLine = false;
    }
    for (let i = first; i < lines.length; i += 1) {
      const record = toolCallRecord(lines[i]);
      if (record.kind === 'unreadable') {
        // A line that carries a tool marker and will not parse, or a call with
        // no usable id. Fail closed and name it: this is exactly the "cannot
        // say" case that must not read as "nothing outstanding".
        watch.from = Math.max(watch.from, nextOffset);
        watch.degraded = { code: 'tool-call-record-unreadable', detail: { at: ends[i] } };
        return false;
      }
      if (record.kind === 'assistant') {
        // THE ANCHOR, SCOPED TO THE RESPONSE (see toolCallRecord). A record of
        // a DIFFERENT response proves every call from earlier responses was
        // answered, so those are cleared. A record of the SAME response is a
        // continuation block -- it may be the second half of a PARALLEL pair,
        // so it adds its ids and clears nothing. An unidentifiable record
        // clears nothing either: conservative, never permissive.
        // A DIFFERENT IDENTITY SPACE IS NOT A DIFFERENT RESPONSE (S2). Two
        // records can only be compared when they are named in the same space;
        // across a space change the reader cannot tell one response from two,
        // so it says nothing: not fresh, no clear, no discharge. The call ids
        // are still added below, and results still settle by id, so this is
        // conservative without being a wedge.
        const sameSpace = watch.openResponse === null
          || (typeof record.response === 'string'
            && record.response.slice(0, record.response.indexOf(':'))
              === watch.openResponse.slice(0, watch.openResponse.indexOf(':')));
        const fresh = typeof record.response === 'string'
          && sameSpace
          && record.response !== watch.openResponse;
        if (fresh) {
          watch.outstanding.clear();
          watch.openResponse = record.response;
          watch.responsesSeen += 1;
          // The DISCHARGE needs more than freshness: it claims calls the window
          // never saw are answered, and an earlier block of THIS response could
          // have opened one. Two independent proofs, either sufficient:
          //
          //   apiBlockIndex === 0 -- this record IS the start of its response,
          //   so it has no earlier block that could have opened anything.
          //
          //   the SECOND distinct response in this scan -- the first one's
          //   existence already proved every call before IT was answered (the
          //   API was called again), and this second one proves every call of
          //   the first was answered. Together those cover the window's whole
          //   unknown prefix with no block index at all, which is what keeps
          //   the discharge working if that field ever changes.
          if (record.startsResponse || watch.responsesSeen >= 2) {
            watch.unknownOpen = false;
            watch.unknownCause = null;
          }
        }
        for (const id of record.opens) watch.outstanding.set(id, ends[i]);
        // THE INTERLOCK'S LIVENESS LEG 4 (#104 I-series). Every tool_use the
        // reader parses is a tool call the host made, and every tool call the
        // host made must have run the PreToolUse hook. Counted here, compared
        // as a delta in _interlockReadiness: if the hook stops running, the
        // next call makes the two counters disagree and automatic writes are
        // held BY NAME -- positive detection of a dead hook, not a timeout.
        this.toolUsesObserved += record.opens.length;
      } else if (record.kind === 'results') {
        // BY ID, AND ONLY ITS OWN. One result may not release another
        // outstanding call -- that is the whole point of pairing on the id
        // rather than on a count. A cancellation or error result settles its
        // own call here and authorizes nothing: readiness is a permission to
        // WRITE, never an authorization for a business action, and the clear
        // stays gated on this cycle's capsule ack exactly as before.
        for (const id of record.settles) {
          watch.outstanding.delete(id);
          // THE INTERLOCK'S OTHER CLEARING PATH (#104, after host run 3). A
          // `tool_result` is written whichever way the dialog was answered, so
          // an id seen settled here is positive evidence that its permission
          // check is over -- which is what releases an interlock marker whose
          // cancelled turn never produced a Stop. Bounded: a FIFO of the last
          // TOOL_CALL_SETTLED_MEMORY ids, because this is a recent-history
          // lookup and not a ledger.
          watch.settledIds.add(id);
          if (watch.settledIds.size > TOOL_CALL_SETTLED_MEMORY) {
            for (const oldest of watch.settledIds) {
              watch.settledIds.delete(oldest);
              if (watch.settledIds.size <= TOOL_CALL_SETTLED_MEMORY) break;
            }
          }
        }
      }
    }
    watch.from = Math.max(watch.from, nextOffset);
    return true;
  }

  // Bring the reader up to the transcript's end, bounded. Re-baselines when the
  // bound transcript changes (session rebind) or shrinks (truncation, replaced
  // file) -- a cursor that indexes a file that no longer exists is not evidence.
  _checkToolCalls() {
    const transcript = this._transcriptPath();
    const watch = this.toolCallWatch;
    if (watch === null || watch.transcript !== transcript) return this._noteToolCallWatch();
    if (!transcript) return this._noteToolCallWatch();
    let stat;
    try { stat = fs.statSync(transcript); } catch (error) {
      // A transcript that has gone away is re-baselined, not patched over: if
      // it is simply not there yet (ENOENT) the baseline answers that honestly
      // (no records, no calls); anything else lands as a named NOT-READY.
      if (error?.code === 'ENOENT') return this._noteToolCallWatch();
      watch.degraded = { code: 'tool-call-transcript-unreadable', detail: errorText(error) };
      return watch;
    }
    // The file an ABSENT watch was waiting for is here: re-baseline from it.
    // `absent` was a bind-time snapshot; left standing, every strict boundary
    // would refuse `tool-call-transcript-absent` after a post-clear rebind until
    // an unrelated large append happened to re-baseline (#125 review).
    if (watch.absent === true) return this._noteToolCallWatch();
    // Replaced in place by something that is not a file: re-baseline, which
    // names it rather than reading on against a cursor that indexes nothing.
    if (!stat.isFile()) return this._noteToolCallWatch();
    const size = stat.size;
    if (!Number.isSafeInteger(size) || size < watch.from) return this._noteToolCallWatch();
    if (watch.degraded !== null) {
      // A degraded reader re-attempts its baseline only on REAL growth, so a
      // standing fault stays one bounded read rather than becoming a per-tick
      // multi-megabyte re-scan. Until then readiness stays false by name.
      if (watch.baselineSize !== null
        && size >= watch.baselineSize + TOOL_CALL_WINDOW_BYTES) {
        return this._noteToolCallWatch();
      }
      if (watch.baselineSize === null) return this._noteToolCallWatch();
      return watch;
    }
    // FAR BEHIND: JUMP, DO NOT CRAWL. Forward-only is load-bearing for the ACK
    // reader -- re-reading an acknowledgement is an authorization bug -- but
    // readiness is the opposite: a LIVE predicate about right now, where a
    // position nearer the end is strictly better evidence. A reader that
    // crawled one bounded span per tick through a large append (a restore
    // backlog; measured in the suite at 2.5 MiB arriving between two ticks)
    // would sit at `reader-behind` for several ticks and hold writes that have
    // nothing to wait for. Re-baselining from the tail converges in ONE tick,
    // costs the same bounded read, and keeps the fail-closed property: the jump
    // sets `unknownOpen`, which only an anchor discharges.
    if (size - watch.from > TOOL_CALL_WINDOW_BYTES * TOOL_CALL_CATCHUP_WINDOWS) {
      return this._noteToolCallWatch();
    }
    for (let i = 0; i < TOOL_CALL_CATCHUP_WINDOWS && watch.from < size; i += 1) {
      if (!this._stepToolCallWindow(watch, size)) break;
    }
    watch.endSeen = size;
    return watch;
  }

  // ─── THE PRE-PERMISSION INTERLOCK: THE RUNNER'S HALF (#104) ────────────────

  // Where this binding's gate and state live. Null when it cannot be resolved,
  // which is a NOT-READY and never an all-clear.
  _interlockDir() {
    return interlockSessionDir({
      memRoot: this.memRoot,
      sessionId: this.sessionId,
      env: this.env,
    });
  }

  // The hook file, as a sibling of this module. Resolved rather than
  // configured: the runner and the hook ship together, so a path that has to be
  // kept in sync by hand is a way for the proof to be about the wrong file.
  _interlockHookFile() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), INTERLOCK_HOOK_FILE);
  }

  // Is the hook wired for every tool, in a settings file this runner can read?
  //
  // This is the one leg that is about CONFIGURATION rather than observation,
  // and it is kept because it is the leg that speaks up BEFORE the seat reaches
  // pressure: an install that never wired the hook would otherwise look exactly
  // like a session that has not had a turn yet. Its false-negative risk (an
  // install that wires the hook in a file the runner cannot read) is a
  // fail-CLOSED risk with a named code, which is the direction this whole issue
  // demands, and install.sh renders the file checked here.
  // ─── WHERE THE HOST ACTUALLY KEEPS USER SETTINGS (#103 read-across) ──────
  // `CLAUDE_CONFIG_DIR` overrides the USER config directory, so a runner that
  // always reads `~/.claude/settings.json` can be looking at a profile the host
  // is not using. That was found in #103's plugin detector and reads straight
  // across to this leg.
  //
  // CONSTRUCTED BOTH WAYS before fixing, because guessing is what has produced
  // every fail-open in this issue:
  //
  //   FALSE POSITIVE -- hook wired only at `~/.claude` while the host reads the
  //   override. The wiring leg DOES pass on the unused profile. It is **not**
  //   reachable as a fail-open, and the reason is stronger than the one I was
  //   asked to check: `state.json` is written only by the HOOK (or by an
  //   interlocked write, which needs readiness to have already passed), so with
  //   no hook running there is no state file at all and the chain stops at
  //   `interlock-state-missing`. Leg 3 is never reached, so leg 3's
  //   "no tool_use in the tail" exception cannot be the door -- it sits behind
  //   a precondition that never opens.
  //
  //   FALSE NEGATIVE -- hook wired at user level INSIDE the override profile,
  //   which is the one the host reads. The leg reports `interlock-hook-not-wired`
  //   on a correctly wired seat and holds automation for ever. Fail-closed, but
  //   nothing detects or lifts it, and this is the direction that actually
  //   bites.
  //
  // PROJECT settings are unaffected: the override moves the user directory, not
  // the project one. Measured on this host, not assumed -- the payload and N10
  // runs both used `CLAUDE_CONFIG_DIR` with a project-level
  // `.claude/settings.json`, and the hooks fired.
  //
  // ONE PROFILE, NOT BOTH. Scanning `~/.claude` as well would let a hook wired
  // in the UNUSED profile satisfy the leg, which is the false-positive
  // direction and the one that matters here. `~/.claude` is the fallback only
  // when the override is unset, which is what the host itself does.
  _interlockUserSettingsFile() {
    const override = this.env?.CLAUDE_CONFIG_DIR;
    if (typeof override === 'string' && override.length > 0) {
      return path.join(override, 'settings.json');
    }
    if (typeof this.homeDir !== 'string' || this.homeDir.length === 0) return null;
    return path.join(this.homeDir, '.claude', 'settings.json');
  }

  _interlockWiringProblem() {
    const hookFile = this._interlockHookFile();
    // ─── RE-CHECKED, NOT MEMOISED ON SUCCESS (F5) ──────────────────────────
    // A passing verdict used to be cached for the whole binding, so unwiring
    // the hook mid-session was invisible until a successful interlocked clear
    // happened to re-bind. That is reachable by ordinary means: the model holds
    // Edit on the project tree, and `/hooks` rewrites the very file this reads.
    // The cache is now keyed on what it was computed FROM -- each candidate
    // file's mtime and size -- so a pass is reused only while the files are
    // byte-for-byte the ones that produced it.
    const candidates = [];
    if (typeof this.cwd === 'string' && this.cwd.length > 0) {
      for (const rest of INTERLOCK_WIRING_FILES) candidates.push(path.join(this.cwd, ...rest));
    }
    const userSettings = this._interlockUserSettingsFile();
    if (userSettings !== null) candidates.push(userSettings);
    const stamp = candidates.map((file) => {
      try {
        const st = this.fs.statSync(file);
        return `${file}:${st.mtimeMs}:${st.size}`;
      } catch { return `${file}:absent`; }
    }).join('|');
    if (this.interlockWiring !== null && this.interlockWiring.ok
      && this.interlockWiring.stamp === stamp) return null;

    // ─── ANCHORED TO *THIS* RUNNER'S SIBLING, AND TO ONE FILE ──────────────
    // A bare `includes('pre-permission-interlock.mjs')` would be satisfied by
    // some other install's copy, and accumulating `found` across the candidate
    // files let the three required events be satisfied by three DIFFERENT
    // files -- neither of which is an install that works. The command must
    // reference the hook that ships beside THIS runner, and one single settings
    // file must wire all three events, which is what install.sh renders.
    const wanted = comparablePath(hookFile);
    const read = [];
    let satisfiedBy = null;
    for (const file of candidates) {
      let raw;
      try { raw = this.fs.readFileSync(file, 'utf8'); } catch { continue; }
      read.push(file);
      let settings;
      try { settings = JSON.parse(raw); } catch { continue; }
      const hooks = settings?.hooks;
      if (!hooks || typeof hooks !== 'object') continue;
      const found = new Set();
      for (const event of INTERLOCK_REQUIRED_EVENTS) {
        const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
        for (const group of groups) {
          const matcher = typeof group?.matcher === 'string' ? group.matcher : '';
          if (!INTERLOCK_WIRING_MATCHERS.has(matcher)) continue;
          for (const entry of (Array.isArray(group?.hooks) ? group.hooks : [])) {
            const command = comparablePath(entry?.command);
            if (command.includes(wanted)) found.add(event);
          }
        }
      }
      if (INTERLOCK_REQUIRED_EVENTS.every((event) => found.has(event))) {
        satisfiedBy = file;
        break;
      }
    }
    if (satisfiedBy === null) {
      this.interlockWiring = { ok: false, stamp };
      return {
        code: 'interlock-hook-not-wired',
        detail: { settings_read: read.length, hook: hookFile, events: INTERLOCK_REQUIRED_EVENTS },
      };
    }
    this.interlockWiring = { ok: true, stamp, file: satisfiedBy };
    return null;
  }

  // Establish -- or re-establish after a rebind -- the proof the hook keys on.
  // The nonce is this binding's identity: the hook stamps it into the state
  // file, so evidence from a previous binding can never be mistaken for this
  // one's. Writing it is also what makes the hook non-inert at all, which is
  // why the hook's "no proof, no opinion" rule is not a fail-open: the same
  // absence refuses on both sides.
  _ensureInterlockProof() {
    const dir = this._interlockDir();
    if (dir === null) {
      return { code: 'interlock-dir-unresolved', detail: { session_id: this.sessionId ?? null } };
    }
    if (this.interlockSessionId === this.sessionId && this.interlockNonce !== null) return null;
    const hookPath = this._interlockHookFile();
    let digest;
    try {
      digest = crypto.createHash('sha256').update(this.fs.readFileSync(hookPath)).digest('hex');
    } catch (error) {
      return { code: 'interlock-hook-missing', detail: { path: hookPath, error: errorText(error) } };
    }
    const nonce = crypto.randomUUID();
    const written = writeInterlockProof({
      dir,
      fsImpl: this.fs,
      proof: {
        nonce,
        session_id: this.sessionId,
        runner_pid: this.processLike?.pid ?? process.pid,
        hook_path: hookPath,
        hook_sha256: digest,
        created_at: new Date(this.now()).toISOString(),
      },
    });
    if (!written.ok) return { code: written.code, detail: written.detail ?? null };
    this.interlockSessionId = this.sessionId;
    this.interlockNonce = nonce;
    this.interlockHookPath = hookPath;
    this.interlockHookSha256 = digest;
    // A fresh binding has established no agreement point with the hook yet.
    this.interlockCheckpoint = null;
    this._event('interlock-bound', { session_id: this.sessionId, hook_sha256: digest.slice(0, 12) });
    try {
      sweepInterlockSessionDirs({
        memRoot: this.memRoot,
        keepSessionId: this.sessionId,
        fsImpl: this.fs,
        env: this.env,
        now: this.now().getTime(),
      });
    } catch { /* an uncollected old directory is inert */ }
    return null;
  }

  // THE INTERLOCK'S VERDICT. Every exit except the last is a NAMED NOT-READY.
  // There is no branch that answers ready because something could not be seen.
  _interlockReadiness(where) {
    const unknown = (reason, detail) => ({
      ready: false,
      code: 'runner-interlock-not-ready',
      detail: {
        reason,
        // THE RESOLVED DIRECTORY, in every interlock refusal. The design record
        // itself observes that an operator reads `interlock-hook-not-observed`
        // as "this session has not had a turn yet" -- so a root DIVERGENCE
        // between the hook's resolution and the runner's would look exactly
        // like a warming-up seat. Printing the path the runner actually
        // resolved makes that visible in the log instead of indistinguishable
        // from it.
        dir: this._interlockDir(),
        ...(detail === null || detail === undefined ? {} : detail),
      },
    });
    // ─── THE LATCH, TESTED BEFORE ANYTHING ELSE ──────────────────────────────
    // A release already seen for this binding refuses every automatic write for
    // the rest of it, whatever the rest of the evidence now says and whether or
    // not the file is still there. Nothing below can make this ready again.
    if (this.interlockReleased !== null) {
      return {
        ready: false,
        code: 'runner-interlock-released',
        detail: {
          reason: 'interlock-released-manually',
          at: where ?? null,
          operator_reason: this.interlockReleased.reason,
        },
      };
    }
    if (!interlockEnabled(this.env)) {
      // THE OFF SWITCH CANNOT OPEN THE GATE. Turning the interlock off stops
      // automatic writes; it does not permit them.
      return unknown('interlock-disabled', null);
    }
    const dir = this._interlockDir();
    if (dir === null) return unknown('interlock-dir-unresolved', { session_id: this.sessionId ?? null });
    // THE OPERATOR'S RELEASE, read before the wiring and the evidence, because
    // a released seat is one whose evidence may be permanently unobtainable --
    // that is usually WHY it was released. A malformed one is a named refusal,
    // never silently ignored: an operator who wrote one has to learn it did not
    // take, and the safe direction while they find out is to keep refusing.
    const release = interlockManualRelease({ dir, sessionId: this.sessionId, fsImpl: this.fs });
    if (release !== null && !release.ok) {
      return unknown(release.code, release.detail === undefined ? null : { detail: release.detail });
    }
    if (release !== null && release.ok) {
      this.interlockReleased = {
        reason: String(release.release.reason).slice(0, 400),
        at: new Date(this.now()).toISOString(),
      };
      // Terminal for the binding, and said once, loudly. The event carries the
      // operator's own reason so the log records WHY automation was given up.
      this._event('interlock-released-manually', {
        session_id: this.sessionId,
        reason: this.interlockReleased.reason,
        automatic_writes: 'disabled for this binding',
      }, REFUSAL_DETAIL_MAX);
      return {
        ready: false,
        code: 'runner-interlock-released',
        detail: {
          reason: 'interlock-released-manually',
          at: where ?? null,
          operator_reason: this.interlockReleased.reason,
        },
      };
    }
    const wiring = this._interlockWiringProblem();
    if (wiring) return unknown(wiring.code, wiring.detail);
    const proofProblem = this._ensureInterlockProof();
    if (proofProblem) return unknown(proofProblem.code, proofProblem.detail);
    let evidence;
    try {
      evidence = interlockEvidence({
        dir,
        nonce: this.interlockNonce,
        sessionId: this.sessionId,
        runnerPid: this.processLike?.pid ?? process.pid,
        hookPath: this.interlockHookPath,
        hookSha256: this.interlockHookSha256,
        toolUsesObserved: this.toolUsesObserved,
        checkpoint: this.interlockCheckpoint,
        fsImpl: this.fs,
      });
    } catch (error) {
      return unknown('interlock-evidence-read-failed', { error: errorText(error) });
    }
    if (evidence.ok && evidence.forgaveDeficit) {
      // A deficit resolved in the PERMISSIVE direction, so it is named. The
      // evidence for it is that the hook has demonstrably run since the
      // agreement point; the shortfall is a dropped increment, not a dead hook.
      const key = `forgave:${evidence.forgaveDeficit.tool_uses_since}`;
      if (this.interlockForgaveKey !== key) {
        this.interlockForgaveKey = key;
        this._event('interlock-deficit-forgiven', evidence.forgaveDeficit);
      }
    }
    if (!evidence.ok) {
      // ─── RE-ARM, rather than stay silently unprotected ────────────────────
      // The proof FILE has gone while this runner still believes it is bound --
      // a cleaned state directory, a wiped temp tree. That state used to be
      // permanent in the worst way: the runner held automatic writes for ever
      // (safe) while the HOOK went inert for want of a proof, so the protection
      // was gone and nothing would ever restore it. Voiding the binding makes
      // the next call write a fresh proof with a fresh nonce, which re-arms the
      // hook; automatic writes stay held until the host observes it again.
      //
      // This is the opposite direction from a recovery and so needs no manual
      // gate: it ADDS protection. Only `-missing` qualifies -- a `-mismatch`
      // means some other writer owns this directory, and overwriting its proof
      // would be a fight rather than a repair.
      if (evidence.code === 'interlock-proof-missing' && this.interlockSessionId === this.sessionId) {
        this._event('interlock-rearming', { session_id: this.sessionId, reason: evidence.code });
        this.interlockSessionId = null;
        this.interlockNonce = null;
        this.interlockCheckpoint = null;
      }
      return unknown(evidence.code, evidence.detail);
    }
    this.interlockCheckpoint = evidence.nextCheckpoint;
    const pending = interlockPendingProblem(evidence.state, {
      now: this.now().getTime(),
      staleMs: INTERLOCK_PENDING_STALE_MS,
      settled: this.toolCallWatch?.settledIds ?? null,
    });
    if (pending) {
      // A permission check IS in flight. Its own top-level code, the way an
      // outstanding tool call has one: this is the mechanism working, not a
      // degraded reader.
      return {
        ready: false,
        code: 'runner-permission-check-pending',
        detail: { reason: pending.code, at: where ?? null, ...pending.detail },
      };
    }
    return { ready: true, code: null, detail: null };
  }

  // ─── THE CRITICAL SECTION ──────────────────────────────────────────────────
  // THE ONE PLACE AN AUTOMATIC WRITE ACTUALLY HAPPENS. The decision and the
  // write are inside the same gate the hook must take to record a pending
  // permission check, which is what makes this exclusion rather than a check
  // followed by a write:
  //
  //   * if the hook holds the gate first, its marker is on disk and fsynced
  //     before it releases, so the `pendingProblem` read below sees it and the
  //     write never happens;
  //   * if the runner holds it first, `pty.write` has RETURNED before the hook
  //     can acquire, and `last_write_at` -- recorded BEFORE the write, so a
  //     crash cannot lose it -- makes the hook wait out INTERLOCK_DRAIN_MS for
  //     the bytes in flight before it lets the permission check start.
  //
  // The runner never WAITS on the gate (budgetMs 0). A gate held by a hook
  // means a permission check is beginning, and deferring is the correct answer;
  // blocking the runner's event loop would stop it pumping the child's output.
  //
  // Returns { ok: true, result } or { ok: false, code, detail } -- the second
  // shape is what the calling boundary turns into its own named refusal or
  // deferral, exactly as a readiness refusal would be.
  _interlockedWrite(where, write) {
    if (this.interlockGate !== null) {
      // Already inside a held span (the clear's prepare-to-commit). No new
      // pending marker can have appeared since it was taken, so that hold IS
      // the exclusion for this write.
      return this._interlockedWriteUnderHeldGate(where, write);
    }
    if (!interlockEnabled(this.env)) {
      return { ok: false, code: 'runner-interlock-not-ready', detail: { reason: 'interlock-disabled', at: where } };
    }
    const dir = this._interlockDir();
    if (dir === null) {
      return {
        ok: false,
        code: 'runner-interlock-not-ready',
        detail: { reason: 'interlock-dir-unresolved', at: where },
      };
    }
    const gate = acquireInterlockGate({
      dir,
      side: `runner:${where}`,
      nonce: this.interlockNonce,
      budgetMs: 0,
      fsImpl: this.fs,
      now: () => this.now().getTime(),
      processLike: this.processLike?.kill ? this.processLike : process,
      pid: this.processLike?.pid ?? process.pid,
    });
    if (!gate.ok) {
      return {
        ok: false,
        code: 'runner-interlock-not-ready',
        detail: { reason: gate.code, at: where, ...(gate.detail === null || typeof gate.detail !== 'object' ? {} : gate.detail) },
      };
    }
    try {
      return this._interlockedWriteUnderHeldGate(where, write, gate.handle);
    } finally {
      releaseInterlockGate(gate.handle);
    }
  }

  // The body of the critical section, shared by the one-shot form above and the
  // held-gate form the clear uses. `handle` is null when the caller took the
  // gate earlier (this.interlockGate) -- the re-read of `pending` is skipped
  // then, because nothing could have been added while we held it.
  _interlockedWriteUnderHeldGate(where, write, handle = null) {
    const dir = this._interlockDir();
    const stateRead = readInterlockState({ dir, fsImpl: this.fs });
    if (!stateRead.ok) {
      return {
        ok: false,
        code: 'runner-interlock-not-ready',
        detail: { reason: stateRead.code, at: where },
      };
    }
    const state = stateRead.state;
    if (state.nonce !== this.interlockNonce) {
      return {
        ok: false,
        code: 'runner-interlock-not-ready',
        detail: { reason: 'interlock-state-stale', at: where },
      };
    }
    // ─── ON-DISK OWNERSHIP, NOT THE IN-MEMORY HANDLE (F1) ──────────────────
    // The held-gate path used to skip the re-read on the premise that nothing
    // could have become pending while the runner held the gate. The premise was
    // false: `stealable` takes a gate from a LIVE holder with a matching nonce
    // once it looks older than GATE_STALE_MS, and both held spans can reach
    // that -- the clear spans a setImmediate, a kill-switch read and a
    // transport write; the capsule request spans the ownership persist -- and a
    // forward wall-clock step reaches it unconditionally. Reproduced end to
    // end with no injected errors and a +6 s clock step: the Enter went out
    // with a live permission check recorded.
    //
    // So the invariant is asked of the DISK, because the invariant is a file
    // another process can take. If it is no longer ours, this is not a write we
    // are entitled to make.
    const gateNow = handle ?? this.interlockGate;
    if (gateNow !== null && !interlockGateStillHeld(gateNow)) {
      if (this.interlockGate !== null && handle === null) {
        // Held-span case: drop the stale handle so nothing later believes it.
        this.interlockGate = null;
        this.interlockHeldFor = null;
      }
      this._event('interlock-gate-lost', { at: where });
      return {
        ok: false,
        code: 'runner-interlock-not-ready',
        detail: { reason: 'interlock-gate-lost', at: where },
      };
    }
    {
      // AND THE PENDING RE-READ HAPPENS ON BOTH PATHS NOW. Skipping it for the
      // held span was the other half of F1: ownership can be lost, so "nothing
      // can have been added" was never guaranteed. The read is one small file.
      const pending = interlockPendingProblem(state, {
        now: this.now().getTime(),
        staleMs: INTERLOCK_PENDING_STALE_MS,
        settled: this.toolCallWatch?.settledIds ?? null,
      });
      if (pending) {
        return {
          ok: false,
          code: 'runner-permission-check-pending',
          detail: { reason: pending.code, at: where, ...pending.detail },
        };
      }
    }
    // BEFORE the write, never after: a crash between the two leaves the hook
    // draining for a write that never happened (harmless), where the other
    // order would leave a written byte with no drain (the hazard).
    state.last_write_at = this.now().getTime();
    // ─── REALLY CLEAR WHAT THE TRANSCRIPT HAS SETTLED (F8) ─────────────────
    // The settled-id path was a read-side DISCOUNT only: the marker stayed in
    // the file for ever, so release depended on a bounded FIFO that empties on
    // re-baseline. We hold the gate here, which is the only safe moment to
    // mutate the pending map, so the ids the transcript has answered are
    // deleted for real. Costs nothing -- the state write is already happening.
    const settled = this.toolCallWatch?.settledIds ?? null;
    if (settled !== null) {
      for (const id of Object.keys(state.pending)) {
        if (settled.has(id)) delete state.pending[id];
      }
    }
    const written = writeInterlockState({ dir, state, fsImpl: this.fs });
    if (!written.ok) {
      return {
        ok: false,
        code: 'runner-interlock-not-ready',
        detail: { reason: written.code, at: where },
      };
    }
    return { ok: true, result: write() };
  }

  // Take the gate and KEEP it across scheduler turns. One caller: the clear's
  // prepare-to-commit span. #110 left that span open (residual 3) because the
  // only refusal available in commitClearSubmission is the terminal
  // _abortPrepared, so a re-check there could only make things worse. Holding
  // the gate needs no re-check: no permission marker can be recorded while the
  // runner holds it, so the gap is closed rather than re-tested.
  _holdInterlockGate(where) {
    if (this.interlockGate !== null) return { ok: true, code: null, detail: null };
    if (!interlockEnabled(this.env)) {
      return { ok: false, code: 'interlock-disabled', detail: null };
    }
    const dir = this._interlockDir();
    if (dir === null) return { ok: false, code: 'interlock-dir-unresolved', detail: null };
    const gate = acquireInterlockGate({
      dir,
      side: `runner-hold:${where}`,
      nonce: this.interlockNonce,
      budgetMs: 0,
      fsImpl: this.fs,
      now: () => this.now().getTime(),
      processLike: this.processLike?.kill ? this.processLike : process,
      pid: this.processLike?.pid ?? process.pid,
    });
    if (!gate.ok) return { ok: false, code: gate.code, detail: gate.detail ?? null };
    // THE PENDING CHECK BELONGS INSIDE THE ACQUISITION, not beside it. Taking
    // the gate and then asking a separate question would be the check-then-act
    // shape this unit exists to remove; asking it here means the whole held span
    // begins from a state that is provably clear and that nothing else can
    // change while it lasts.
    const stateRead = readInterlockState({ dir, fsImpl: this.fs });
    if (!stateRead.ok) {
      releaseInterlockGate(gate.handle);
      return { ok: false, code: stateRead.code, detail: stateRead.detail ?? null };
    }
    if (stateRead.state.nonce !== this.interlockNonce) {
      releaseInterlockGate(gate.handle);
      return { ok: false, code: 'interlock-state-stale', detail: null };
    }
    const pending = interlockPendingProblem(stateRead.state, {
      now: this.now().getTime(),
      staleMs: INTERLOCK_PENDING_STALE_MS,
      settled: this.toolCallWatch?.settledIds ?? null,
    });
    if (pending) {
      releaseInterlockGate(gate.handle);
      return { ok: false, code: pending.code, detail: pending.detail ?? null };
    }
    this.interlockGate = gate.handle;
    this.interlockHeldFor = where;
    this._event('interlock-gate-held', { at: where });
    return { ok: true, code: null, detail: null };
  }

  // Released on EVERY exit from the held span, including every abort. A leaked
  // gate denies this session's tool calls until it goes stealable, which is a
  // liveness fault even though it is the safe direction -- so it is released
  // from _abortPrepared, from commitClearSubmission's early return, from the
  // post-write path, and from teardown.
  _releaseInterlockGate(why) {
    if (this.interlockGate === null) return false;
    const where = this.interlockHeldFor;
    // THE BOOLEAN IS THE ONE "I LOST OWNERSHIP" SIGNAL THERE IS, and discarding
    // it was part of F1: a span could run to completion having been stolen from
    // and never find out. False means the gate on disk was not ours, so
    // somebody else may hold it right now -- which is a state worth a named
    // event even though nothing can be done about it after the fact.
    const wasOurs = releaseInterlockGate(this.interlockGate);
    this.interlockGate = null;
    this.interlockHeldFor = null;
    if (!wasOurs) {
      this._event('interlock-gate-lost', { at: where, why: why ?? null, when: 'release' });
    } else {
      this._event('interlock-gate-released', { at: where, why: why ?? null });
    }
    return wasOurs;
  }

  // THE READINESS TEST every automatic writer consults. Returns
  // { ready, code, detail }.
  //
  // It reads FRESH -- one stat plus at most TOOL_CALL_CATCHUP_WINDOWS bounded
  // window reads -- because the whole signal is live: a tool_use written two
  // ticks ago is already answered, and one written 200 ms ago is not visible in
  // last tick's verdict.
  //
  // HONESTY, STATED HERE BECAUSE THIS IS WHERE IT MATTERS: this is NOT an
  // atomic lock against the child opening a dialog. It proves no call was
  // outstanding at the moment of the stat. Between that stat and the pty.write
  // the child may issue a tool_use and raise a dialog, and nothing in the
  // transcript can prevent that.
  //
  // AND THE WINDOW IS WIDER THAN THAT RACE. An earlier version of this comment
  // cited "0.91 s of advance notice" from comparing a record's `timestamp` to
  // the dialog's appearance. That compares the wrong clocks: a timestamp is
  // when the host CREATED the record, and this reader reads BYTES. A measured
  // host run has the bytes arriving LATE -- a `tool_use` record absent from the
  // file at every sample taken while its dialog was on screen, present only
  // after the cancellation, a flush lag of >= 2.44 s -- so the signal can
  // simply not exist yet for seconds. The host's transcript writes are
  // buffered and the flush is not announced. See docs/dialog-readiness.md,
  // residual (2), for the numbers and the supported mechanism that would close
  // it causally.
  //
  // AN EMPTY OR ABSENT TRANSCRIPT IS AN ANSWER ONLY AT THE BOUNDARIES ENTITLED
  // TO IT (ABSENT_TRANSCRIPT_READY_AT, #110/#111). At the post-clear wake no
  // records yet is the truth, and a tool permission dialog cannot exist without
  // a `tool_use` record, so "no calls outstanding" is right there and refusing
  // it would only cost liveness. At a capsule, clear or control boundary the
  // session has records, so an empty or missing file means the reader is not
  // looking at the live transcript: named NOT-READY. A path that will not
  // resolve, or a file that will not stat, says nothing at all, and absence of
  // evidence must not read as evidence of absence: those are named NOT-READY
  // everywhere. The one exposure both share
  // is a wrong `sessionId`, which would point the reader at some other seat's
  // file; that is the same exposure the ack scan already carries and it is
  // bounded by the same boot/session binding guard (_bootBindingProblem).
  _automaticWriteReadiness(where) {
    let watch;
    try { watch = this._checkToolCalls(); } catch (error) {
      return {
        ready: false,
        code: 'runner-tool-call-read-failed',
        detail: errorText(error),
      };
    }
    if (!watch) {
      return { ready: false, code: 'runner-tool-call-reader-absent', detail: null };
    }
    // ABSENCE IS ONLY AN ANSWER AT THE BOUNDARIES ENTITLED TO IT. See
    // ABSENT_TRANSCRIPT_READY_AT: the wake family may read "no file" as "no
    // records, so no dialog"; the capsule-request and clear boundaries may not,
    // because their session provably has a transcript and absence there means
    // the path mis-resolved. An unrecognised boundary is strict.
    // ONE LIVE PREDICATE: the transcript holds no records, whether the file is
    // absent (#110) or zero-length (#111). The session asking for a capsule, a
    // clear or a control is under pressure and has records; no records there
    // means the reader is not looking at its live transcript (a stale
    // resolution, a fresh --continue onto the wrong id). The wake family keeps
    // its exemption: there, no records yet is the truth. The two reasons stay
    // distinct in the detail so a log reader can tell which it saw.
    const noRecords = watch.absent === true || watch.endSeen === 0;
    if (noRecords && !ABSENT_TRANSCRIPT_READY_AT.includes(where)) {
      return {
        ready: false,
        code: 'runner-tool-call-readiness-unknown',
        detail: { reason: watch.absent === true ? 'tool-call-transcript-absent' : 'tool-call-transcript-empty', at: where ?? null },
      };
    }
    if (watch.degraded !== null) {
      // `at` used to carry the whole detail OBJECT under a name that promises an
      // offset, so a degraded refusal could not be read without knowing which
      // branch produced it. An object detail is spread now; a scalar one (the
      // record offset the unreadable branch reports) still lands on `at`.
      const extra = watch.degraded.detail;
      return {
        ready: false,
        code: 'runner-tool-call-readiness-unknown',
        detail: {
          reason: watch.degraded.code,
          ...(extra === null || extra === undefined
            ? {}
            : (typeof extra === 'object' ? extra : { at: extra })),
        },
      };
    }
    if (watch.unknownOpen) {
      return {
        ready: false,
        code: 'runner-tool-call-readiness-unknown',
        detail: {
          reason: watch.unknownCause?.code ?? 'unanchored',
          from: watch.from,
          ...(watch.unknownCause?.at === undefined ? {} : { at: watch.unknownCause.at }),
          ...(watch.unknownCause?.bytes === undefined ? {} : { unread_bytes: watch.unknownCause.bytes }),
        },
      };
    }
    if (typeof watch.endSeen === 'number' && watch.from < watch.endSeen) {
      // Either a record is half-written right now (it may BE the tool_use), or
      // the transcript outgrew one catch-up pass. Both are "cannot say yet".
      return {
        ready: false,
        code: 'runner-tool-call-reader-behind',
        detail: { from: watch.from, end: watch.endSeen },
      };
    }
    if (watch.outstanding.size > 0) {
      const ids = Array.from(watch.outstanding.keys());
      return {
        ready: false,
        code: 'runner-tool-call-outstanding',
        detail: {
          outstanding: ids.length,
          tool_use_ids: ids.slice(0, TOOL_CALL_NAMED_MAX),
        },
      };
    }
    // ─── THE INTERLOCK LEG (#104) ────────────────────────────────────────────
    // LAST, not first, and the ordering is load-bearing in one direction only:
    // the transcript reader above is what advances `toolUsesObserved`, which is
    // the input to the interlock's missed-tool-calls leg. Running the interlock
    // first would compare against last tick's count and lose a tick of
    // detection latency. Nothing about safety depends on the order -- every
    // branch of both halves is a refusal -- and readiness requires BOTH, so a
    // transcript refusal above and an interlock refusal here are both holds.
    //
    // This is also the only leg that can say "a permission check is in flight
    // RIGHT NOW" on the measured binary, because the transcript bytes proving
    // the same thing may be minutes from the disk.
    const interlock = this._interlockReadiness(where);
    if (!interlock.ready) return interlock;
    return { ready: true, code: null, detail: null };
  }

  // The one place an automatic writer refuses on readiness. `where` names the
  // write boundary so the log says which one was held. Events are state
  // changes, not per-tick: the same reason at the same boundary logs once.
  _automaticWriteHeld(where, readiness) {
    this.lastReason = {
      code: readiness.code,
      detail: { at: where, ...(readiness.detail === null ? {} : { readiness: readiness.detail }) },
    };
    const key = `${where}:${readiness.code}`;
    if (this.toolCallOutstandingKey !== key) {
      this.toolCallOutstandingKey = key;
      this._event('automatic-write-held', this.lastReason, REFUSAL_DETAIL_MAX);
    }
    return this.lastReason;
  }

  _automaticWriteReleased(where) {
    if (this.toolCallOutstandingKey === null) return;
    if (!this.toolCallOutstandingKey.startsWith(`${where}:`)) return;
    this.toolCallOutstandingKey = null;
    this._event('automatic-write-released', { at: where });
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
    // Before the bytes reach the child (write or queue below): a CR the
    // tracker could not trust is noted against the transcript's CURRENT size,
    // so only a record written after it can ever confirm it.
    this._notePendingSubmission();

    // ─── OPERATOR TAKEOVER (#104 B2) ─────────────────────────────────────────
    // A DEFERRED automatic Enter is waiting on a condition only the operator
    // can clear -- a permission dialog -- and the queueing rule below would
    // withhold the very keystroke that clears it. That was a mutual wait,
    // resolved only by the deferral budget expiring about a minute later: a
    // minute-long operator blackout at the one moment the human must act.
    //
    // So operator bytes abandon that Enter immediately rather than waiting for
    // a tick. Three things this does NOT do, each load-bearing:
    //   - it does not touch a NORMALLY pending Enter (400 ms, no dialog): the
    //     no-concatenation invariant is correct there and the bytes still queue
    //     behind it (D33);
    //   - it does not override an input HOLD or a pending WAKE Enter -- those
    //     are other automatic transactions owning the composer (D34);
    //   - it does not hand the bytes straight to the child. The automatic text
    //     is still in the composer, so they go through the ordinary queue and
    //     the flush below leads with the kill-line that destroys it.
    const takeover = !this.inputHold
      && this.wakeEnterHandle === null
      && this._strandDeferredEnter('operator-input');

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
      // A takeover releases NOW: the dialog is waiting for these bytes, and
      // waiting a tick is what made this a blackout. _flushQueuedInput owns the
      // kill-line, so the stranded automatic text is destroyed before they land
      // and nothing concatenates. (_abortPrepared already flushed if it ran;
      // the queue is then empty and this is a no-op.)
      if (takeover) this._flushQueuedInput();
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
        env: this.env,
        fsImpl: this.fs,
        // The observed ack settles the transcript-tail race its own
        // announcement (and any operator nudges) create — the evaluator
        // already honors it; the recheck must not re-race blind.
        // The SAME identity test the #91 clear gate uses, against the cycle the
        // runner last saw: "an ack is held" is not a question this code may
        // ask. No caller today (this method is unreachable on master and here
        // alike), but a revival must not reintroduce the defect through a
        // weaker test (review of 78a2577, F3).
        ackFresh: this._capsuleAckAuthorizes(this.lastCoreResult?.state?.cycle_id),
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
    // NO WINDOW IS ARMED HERE. This is the production FIRST-BIND path -- a
    // runner built with transportFactory and no transport takes it on its very
    // first tick -- and at that moment there is no cycle, so there is no
    // identity a window could belong to. The pre-fix call armed one from the
    // session alone ("any capsule counts"), which is the shape #91 rejects; the
    // cycle's own persisted boundary opens the window later in this same tick,
    // through _syncCapsuleAckLifecycle. Carried forward unchanged after the
    // identity rewrite, the no-argument call took _armCapsuleAckWatch's
    // no-identity branch and cried wolf once per launch on
    // capsule-ack-watch-unidentified -- the one event whose job is to flag an
    // unowned window (review of 78a2577, F1).
    //
    // What is kept from the sibling path (_rebindAfterClear) is its
    // INVALIDATION, not its arming: every session bind clears ack state at BOTH
    // bind sites, so the invariant does not rest on an argument about
    // constructor ordering. At first bind it is silent by construction -- all
    // three fields are already null and _invalidateCapsuleAck only speaks when
    // there was something to invalidate.
    this.capsuleAckSpent = null;
    this.capsuleAckRecoveryCycleId = null;
    // The retired-request ledger is a set of offsets into the OLD session's
    // transcript. A different session is a different file, so the cursor
    // indexes nothing here and carrying it forward would serialize the new
    // session's answers against a debt it never incurred (R1).
    this.capsuleAckRetired = null;
    this.capsuleRetiredRecordEnd = 0;
    this.capsuleAckClassifiedThrough = 0;
    this.capsuleAckDeferringToLedger = false;
    this.capsuleAckAccount = null;
    this.capsuleAckPending = null;
    this.capsuleAckAccepted = null;
    this._invalidateCapsuleAck(
      'session-bound', { session_id: this.sessionId }, { retire: false });
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
    // THE HELD INTERLOCK GATE IS RELEASED ON EVERY ABORT (#104). This is the
    // single funnel for abandoning a prepared clear, so releasing here covers
    // the kill switch, the input-lock invariants, the binding guard, the
    // commit-schedule failure and the operator interleave below. A leaked gate
    // would deny this session's tool calls until it went stealable -- the safe
    // direction, but still a liveness fault, and one with no need to exist.
    this._releaseInterlockGate(`abort:${code}`);
    // An operator byte in the hold window after the ack used to end the cycle
    // here with the ack unspent and the runner silently disabled (#78). The
    // ambiguity is the operator's composer, so halt by name and say why.
    // A prepared clear always holds an ack, so no ack check is needed here.
    // The hold line is the one notice; no refusal line precedes it.
    if (code === 'operator-interleave') {
      this._holdClearStalled('operator-interleave-after-ack');
      return true;
    }
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
    // SAFETY NET (#104). Every ordinary path releases the held gate where it
    // takes it; this is the catch-all for a disable arriving mid-span. A gate
    // the runner holds after automation is off protects nothing and denies the
    // child's tool calls until it goes stealable.
    this._releaseInterlockGate(`automation-disabled:${code}`);
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
    this._closeWakeSubmission('automation-disabled', { code });
    this.token = null;
    this.currentControlWriteAttempted = false;
    this.resumeReceipt = null;
    this.receiptQualifiedOutput = null;
    this.postSubmitOutputGeneration = null;
    this.automationEnabled = false;
    this.phase = 'disabled';
    this.capsuleAckSpent = null;
    this.lastReason = { code, detail };
    // ONE EMISSION PER STATE, NOT PER POLL. Everything above this line runs on
    // EVERY call, deliberately: a kill switch is re-read each tick, and an
    // Enter or a commit scheduled between two polls is cancelled by the
    // _clearEnter/_clearWakeEnter/_clearCommit/_closeWakeSubmission above. Only
    // the EVENT is suppressed here -- never the suppression work -- so there is
    // no early return and no branch around the cleanup.
    // The comparison is against the EFFECTIVE reason, the one actually being
    // emitted: the wakeCancellation branch and the wakeTerminalCodes fallback
    // above both rewrite code/detail, so comparing the ARGUMENT would re-emit
    // whenever a rewrite happened to differ from it. The first emission still
    // carries the full {code, detail} (on a live seat, {"code":
    // "kill-switch-file","detail":"<resolved path>"}), so the operator can
    // still see why automation is off and where the switch lives.
    // UNTRUNCATED on purpose. boundedDetailJson slices to REFUSAL_DETAIL_MAX
    // with no marker, so two details that differ only past that bound would
    // compare equal and the second would be swallowed while lastReason.detail
    // silently updated -- the operator would read a stale reason. The emitted
    // event is still bounded; only this comparison key is not.
    let effectiveReason;
    try {
      effectiveReason = JSON.stringify([code, detail]);
    } catch {
      effectiveReason = `${code}\u0000${String(detail)}`;
    }
    const reasonChanged = this.automationDisabledReason !== effectiveReason;
    this.automationDisabledReason = effectiveReason;
    if (!alreadyDisabled || reasonChanged) {
      this._event('automation-disabled', this.lastReason, REFUSAL_DETAIL_MAX);
    }
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
    if (this.wakeEnterHandle !== null || this.wakeSubmission !== null) {
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
    // After the ack, a refusal that names only its code cannot say which
    // composer flag was stuck (#78): attach the ownership snapshot, first, so
    // the line bound never cuts it.
    if (this._postAck()) detail = { ownership: this._ownershipSnapshot(), reason: detail };
    // The refusal goes in the EVENT stream too, not only the error log. A
    // cycle that stops advancing leaves the events as the only record of what
    // it was waiting for, and this one said nothing: a seat sat at
    // checkpoint-confirmed for 3.5h and the events showed the capsule request
    // and then silence, with the reason deduped into a single line in a
    // different file. Once per change, so a steady refusal cannot flood.
    this._event('submission-refused', { code, detail }, REFUSAL_DETAIL_MAX);
    const line = `AUTO-CLEAR REFUSED (${code}) — clear not submitted; `
      + `retrying each tick detail=${boundedDetailJson(detail, REFUSAL_DETAIL_MAX)}`;
    // NO stderr. Ever. It shares the operator's screen, paints over the
    // composer, and when two codes oscillate the once-per-change limiter fires
    // on every flip — it BLOCKED operator input on the live seat
    // (a repeated live-seat specimen). The file is the record.
    appendDaemonErrorLog(this.memRoot, fs, 'pty-runner', line);
  }

  // True once this cycle's ack exists, spent or not, so refusals after it
  // carry the ownership snapshot (#78).
  get ackSpentThisCycle() {
    return this.capsuleAckSpent !== null;
  }

  _postAck() {
    return this.capsuleAck !== null || this.capsuleAckSpent !== null;
  }

  // What the runner believes about the composer, in one bounded object: the
  // tracker's own snapshot plus the hold and pending-Enter state around it.
  // Only operator bytes and the runner's own writes feed these; child output
  // never does.
  _ownershipSnapshot() {
    return {
      ...this.input.snapshot(),
      composerMayHoldControlText: this.composerMayHoldControlText,
      inputHold: this.inputHold,
      enterHandlePending: this.enterHandle !== null,
      wakeEnterPending: this.wakeEnterHandle !== null,
      queuedChunks: this.queuedInput.length,
      phase: this.phase,
    };
  }

  // Terminal. One loud notice (the daemon error log, the only safe channel:
  // the screen belongs to the operator's composer) carrying the reason and the
  // ownership snapshot, automation off, nothing retried. The snapshot is taken
  // before the disable path releases the hold and flushes the queued input.
  // The ack stays unspent and the transport keeps its unsubmitted intent, so
  // a relaunch reads the same state and decides.
  _holdClearStalled(reason) {
    const snapshot = this._ownershipSnapshot();
    this._disableAutomation(
      HOLD_CLEAR_STALLED_AFTER_ACK,
      { ownership: snapshot, reason },
      { announce: false },
    );
    // The disable path just flushed the queue; a flush that failed has logged
    // itself and written its own reason over the hold. The hold wins.
    this.lastReason = { code: HOLD_CLEAR_STALLED_AFTER_ACK, detail: { ownership: snapshot, reason } };
    this._event('hold-entered', { hold: HOLD_CLEAR_STALLED_AFTER_ACK, reason }, REFUSAL_DETAIL_MAX);
    this._writeError(
      `${HOLD_CLEAR_STALLED_AFTER_ACK} notice: the capsule was acknowledged but no clear was submitted `
      + `reason=${reason} ownership=${boundedDetailJson(snapshot, REFUSAL_DETAIL_MAX)} `
      + 'automatic clear stopped; clear by hand or relaunch to re-arm',
    );
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
    //
    // THE #91 GATE. The question is not "is an ack held" but "is THIS cycle's
    // ack held": an unspent acknowledgement from a cycle the transport
    // abandoned names a different cycle_id and therefore authorizes nothing,
    // whichever abandonment path ran and whether or not anything remembered to
    // clear a flag. That is what makes the fix a property of the lifecycle
    // boundary rather than of any one catch site.
    if (!this._capsuleAckAuthorizes(coreResult?.state?.cycle_id)) {
      // PATCH-001S-r3: NOTHING is written here. The request itself fired back
      // at request-checkpoint / checkpoint-requested (the tick path) — by the
      // accepted transport contract it rides Claude Code's native queued-prompt
      // path while the turn is still open. This gate keeps ONLY the ack
      // requirement: no ack -> no clear, and the refusal stays visible on
      // every tick until the ack appears.
      // A request still DEFERRED behind operator text (composer guard) has not
      // been written, so "not acked {cycle_id:null}" would misname the wait:
      // the seat is not owed an ack yet, the runner is waiting on the
      // composer. Name that instead, same detail shape as the deferral event.
      const cycleId = coreResult?.state?.cycle_id;
      const unwritten = this.capsuleRequestCycleId !== cycleId;
      // #104: a request held for DIALOG READINESS is the third reason it may
      // not have gone out, and it takes precedence over the composer latch --
      // which may still be set from an earlier tick on a composer that is now
      // demonstrably clean. Naming the composer there would misreport the wait
      // in exactly the way the composer case was added to stop.
      const heldForReadiness = unwritten
        && this.capsuleRequestReadinessHold?.cycle_id === cycleId;
      const deferred = unwritten
        && this.capsuleRequestDeferredCycleId === cycleId;
      this.lastReason = heldForReadiness
        ? {
          code: this.capsuleRequestReadinessHold.code,
          detail: {
            at: 'capsule-request',
            cycle_id: cycleId,
            ...(this.capsuleRequestReadinessHold.detail === null
              ? {}
              : { readiness: this.capsuleRequestReadinessHold.detail }),
          },
        }
        : deferred
          ? {
            code: 'runner-capsule-request-composer-busy',
            detail: { cycle_id: cycleId, input: this.input.snapshot() },
          }
          : {
          code: 'runner-capsule-not-acked',
          // The cycle the refusal is ABOUT, not only the cycle this process
          // happens to have written a request for: the park specimen showed
          // `{cycle_id:null}` and could not say which cycle was waiting, nor
          // whether an evidence window was even open for it (#90 shape 2).
          detail: {
            cycle_id: this.capsuleRequestCycleId,
            state_cycle_id: cycleId ?? null,
            ack_window: this.capsuleAckWatch === null
              ? null
              : { from: this.capsuleAckWatch.from, drained: this.capsuleAckWatch.drained },
          },
        };
      this._noteSubmissionRefusal(this.lastReason.code, this.lastReason.detail);
      return { status: 'refused', ...this.lastReason };
    }

    // ─── DIALOG READINESS (#104) ─────────────────────────────────────────────
    // The clear is TWO automatic writes -- '/clear' and, 400ms later, a bare
    // Enter -- and that Enter at a permission dialog selects "Yes" (measured;
    // see toolCallRecord). The gate sits HERE, after the ack gate and BEFORE
    // the token is minted, for the same reason the ack gate does: nothing has
    // been spent yet, so the refusal costs one tick and releases nothing. The
    // ack is NOT consumed (that happens in _writeControl), the hold is not
    // taken, no intent is persisted, and the next ordinary tick re-enters.
    //
    // THE CLEAR'S TRANSCRIPT READ IS NOT REPEATED at commit time, because the
    // only refusal available there is _abortPrepared, which is TERMINAL. What
    // IS repeated at commit time is the gate's ON-DISK OWNERSHIP, and it has to
    // be: the gate is a file another process can take, and it was measured
    // being taken from a live held span after a forward clock step. So residual
    // (3) is closed by the held gate PLUS that commit-time re-verification,
    // whose outcome is terminal -- which means the cost of a stolen gate is the
    // session's automation rather than one tick. That trade is stated in
    // docs/dialog-readiness.md rather than hidden here.
    const clearReadiness = this._automaticWriteReadiness('clear-submission');
    if (!clearReadiness.ready) {
      this._automaticWriteHeld('clear-submission', clearReadiness);
      this._noteSubmissionRefusal(this.lastReason.code, this.lastReason.detail);
      return { status: 'refused', ...this.lastReason };
    }
    // ─── RESIDUAL (3) FROM #110, CLOSED AT A STATED PRICE ─────────────────────
    // The gate is TAKEN here, before anything is spent, and HELD across the
    // scheduleCommit turn, so no permission marker can be recorded inside it.
    // That is what closes the gap -- but it is not the whole mechanism: the gate
    // can be STOLEN from a live holder (measured, after a forward clock step),
    // so commitClearSubmission re-verifies on-disk ownership and aborts if it
    // is gone. The price is that a stolen gate costs the session its automation
    // rather than one tick, and that price is the honest version of the claim.
    //
    // A refusal here is still the cheap one: nothing minted, no intent
    // persisted, no hold taken, no ack spent. The gate is released on every
    // exit from the held span -- see _releaseInterlockGate's callers.
    const clearGate = this._holdInterlockGate('clear-submission');
    if (!clearGate.ok) {
      const readinessLike = {
        ready: false,
        code: clearGate.code === 'interlock-permission-pending' || clearGate.code === 'interlock-pending-stale'
          ? 'runner-permission-check-pending'
          : 'runner-interlock-not-ready',
        detail: { reason: clearGate.code, at: 'clear-submission', ...(clearGate.detail === null || typeof clearGate.detail !== 'object' ? {} : clearGate.detail) },
      };
      this._automaticWriteHeld('clear-submission', readinessLike);
      this._noteSubmissionRefusal(this.lastReason.code, this.lastReason.detail);
      return { status: 'refused', ...this.lastReason };
    }
    this._automaticWriteReleased('clear-submission');

    let token;
    try {
      token = this.transport.beginClearSubmission();
    } catch (error) {
      this.lastReason = {
        code: error?.code || 'runner-clear-begin-refused',
        detail: error?.detail ?? errorText(error),
      };
      // THE NARROW ABANDONMENT (#91), accounted for where it happens: this
      // call can DROP the cycle it just refused -- ECLEAR_PRESSURE_DROPPED
      // transitions to idle inside the throw. The next tick's lifecycle
      // boundary would catch it, but nothing should hold evidence for a cycle
      // that no longer exists even for the rest of this tick, so re-run the
      // boundary against the state the transport is in NOW. A cycle that
      // SURVIVED its refusal (kill switch, telemetry hold, checkpoint hold)
      // keeps the same cycle_id and keeps its evidence: the identity test
      // decides, not the refusal code.
      if (this.transport?.state && typeof this.transport.state === 'object') {
        this._syncCapsuleAckLifecycle({ state: this.transport.state });
      }
      // The gate was taken before this refusal could be known (#104). Three of
      // the four refusals between the hold and `phase = 'prepared'` are NOT
      // routed through _abortPrepared -- that only funnels aborts from the
      // prepared phase -- so each one releases explicitly.
      this._releaseInterlockGate('clear-begin-refused');
      this._noteSubmissionRefusal(this.lastReason.code, this.lastReason.detail);
      return { status: 'refused', ...this.lastReason };
    }
    const problem = tokenProblem(token, this.transport);
    if (problem) {
      this.token = null;
      this.automationEnabled = false;
      this.phase = 'abandoned';
      this.lastReason = problem;
      this._releaseInterlockGate('clear-token-invalid');
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
      this._releaseInterlockGate('watchdog-arm-failed');
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
    if (this.closed || this.phase !== 'prepared') {
      // Not an abort, so _abortPrepared's release does not run here. A gate
      // held for a commit that is never going to happen is released by name.
      this._releaseInterlockGate('commit-not-prepared');
      return false;
    }
    // THE GATE MUST STILL BE HELD (#104). _prepareSubmission took it and the
    // whole closure of residual (3) is that nothing could become pending in
    // between -- so arriving here without it means the premise is gone, not
    // that the premise is unnecessary. _abortPrepared is the right outcome:
    // the alternative is writing '/clear' plus an Enter with the exclusion
    // unproven, which is the defect.
    if (this.interlockGate === null || !interlockGateStillHeld(this.interlockGate)) {
      // ON DISK (F1). Testing the in-memory handle only asked whether WE think
      // we hold it; the gate is a file another process can take, and a +6 s
      // clock step is enough. If the exclusion is gone the premise that closed
      // residual (3) is gone with it, and writing '/clear' plus an Enter on an
      // unproven exclusion is the defect itself.
      const lost = this.interlockGate !== null;
      this._abortPrepared('runner-interlock-gate-lost', {
        at: 'clear-commit',
        ...(lost ? { detail: 'the gate on disk is no longer ours' } : {}),
      });
      return false;
    }

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

    // NO ack re-check here, deliberately, and the identity fix does not add
    // one. The load-bearing reason is that there is nothing to re-check:
    // tick() returns early while phase === 'prepared', so no lifecycle sync
    // and no transport.tick() can run between _prepareSubmission's identity
    // gate and this commit, and the cycle the token was minted for therefore
    // cannot be abandoned or replaced in that window. The second reason is
    // intent, not mechanism: re-testing the evidence here would add another
    // way for an acked cycle to end up parked with nothing written, which is
    // what the enumerated post-ack refusal list above exists to prevent.
    // The SPEND in _writeControl is identity-bound instead, so one ack still
    // buys exactly one clear and no later cycle can inherit it.

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
      // THE HELD SPAN ENDS HERE (#104). '/clear' is in the composer and its
      // delayed Enter is scheduled; that Enter takes the gate again on its own
      // account at _writeControlEnter. Holding past this point would block the
      // child's tool calls for the whole 400 ms two-phase gap for no gain --
      // the text is written, which is what the hold was protecting.
      this._releaseInterlockGate('clear-text-written');
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
      // A PROVABLE NON-WRITE IS NOT AMBIGUOUS. The interlock refuses before the
      // callback that holds the pty.write runs, so when it is the thing that
      // threw, no byte left and the transport's persisted `submitted` is a
      // statement about intent rather than about the composer. Reporting
      // "may have happened" there spends the ack, parks the phase at submitted
      // and disables on the watchdog -- for a write the code KNOWS did not
      // happen.
      const provableNoWrite = error?.provableNoWrite === true;
      const submitted = !provableNoWrite
        && (this.transport?.state?.clear_intent?.submitted === true
          || this.currentControlWriteAttempted);
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
        // Ambiguous means the write MAY have happened. Either way this span is
        // over and the gate must not be inherited by the next turn (#104).
        this._releaseInterlockGate('clear-write-ambiguous');
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
    // THE INTERLOCK IS BOUND TO THE OLD SESSION (#104). Its gate, its state and
    // its proof all live under the OLD session id's directory, and that
    // directory is never consulted again. Release the gate before the id moves,
    // or the release would target the new session's path; then void the binding
    // so the next gated boundary writes a fresh proof with a fresh nonce. That
    // is the whole of the restart/rebind story on this side: evidence cannot be
    // inherited, because the nonce the hook stamps belongs to one binding.
    this._releaseInterlockGate('session-rebound');
    this.interlockSessionId = null;
    this.interlockNonce = null;
    this.interlockWiring = null;
    this.interlockCheckpoint = null;
    this.toolUsesObserved = 0;
    // THE RELEASE LATCH CLEARS WITH THE BINDING, and only with it. A new
    // session id means a new interlock directory, so the previous binding's
    // release file is not even on the path any more -- the next evidence check
    // starts from nothing, as it must. A rebind is itself a deliberate act (it
    // only happens behind an interlocked clear), so this is not a way to
    // shake off a release by accident.
    this.interlockReleased = null;
    // A watch still pending for the previous wake is evidence-bound to the
    // previous session's transcript; from here that file is never read again.
    // Close it by name so no counter survives into the next wake's watch.
    this._closeWakeSubmission('session-rebound', {
      from_session_id: this.sessionId,
      session_id: receipt.session_id,
    });
    this.transport = next;
    this.sessionId = receipt.session_id;
    this.baselineBootSequence = receipt.boot_sequence;
    this.lastCoreResult = null;
    // A new session owns no cycle yet, so it owns no acknowledgement either:
    // evidence, window and spend record all belonged to the session that just
    // ended. The next cycle's boundary opens the next window (#91).
    this.capsuleAckSpent = null;
    this.capsuleAckRecoveryCycleId = null;
    // Same reason as the first-bind site: the retired-request ledger's offsets
    // index the previous session's transcript and nothing else (R1).
    this.capsuleAckRetired = null;
    this.capsuleRetiredRecordEnd = 0;
    this.capsuleAckClassifiedThrough = 0;
    this.capsuleAckDeferringToLedger = false;
    this.capsuleAckAccount = null;
    this.capsuleAckPending = null;
    this.capsuleAckAccepted = null;
    this._invalidateCapsuleAck(
      'session-rebound', { session_id: receipt.session_id }, { retire: false });
    // The old session's records cannot land in the new transcript: forget the
    // CRs they were owed to, and re-note the receipt watch against the new
    // file's current size (never its history) at the next input or tick.
    // NOT the operator bytes still queued behind this clear (review of
    // c011881c, F1): handleOperatorData observes a chunk, then queues it, and
    // the queue is a suffix of what was observed, so the units of its chunks
    // -- counted as the tracker counts them -- locate the CRs that will be
    // flushed into the NEW session and recorded there.
    // Units observed BEFORE the queued tail; forgetOutstanding keeps entries
    // at or past that count, so the one CR that can sit exactly there (the
    // final byte of the last chunk written pre-clear) is kept as a harmless
    // stale slot rather than risk dropping a queued one when an observed but
    // unqueued byte (the SIGINT ETX) skews the count by one.
    // STATED RESIDUAL (re-review of 3de47875, LOW): the `>=` margin covers
    // exactly one observed-but-unqueued unit; two ETX observations inside
    // one queued window would skew the boundary past the first queued CR.
    // Exact counting would track unqueued observed units separately; not
    // done here because the ETX path is the only such observer today.
    const queuedUnits = this.queuedInput.reduce((total, chunk) => total + asText(chunk).length, 0);
    this.input.forgetOutstanding(this.input.receivedUnits - queuedUnits);
    this.pendingSubmissionWatch = null;
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
      // Armed BEFORE the release: the watch must know whether queued operator
      // bytes are about to follow the Enter into the composer.
      this._armWakeSubmissionWatch();
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

  // Watched wake submission (see WAKE_ENTER_RETRY_LIMIT). Armed at the
  // physical wake Enter, before queued input releases behind it. The
  // transcript offset noted here is where the wake's own USER record must
  // appear -- nothing before the Enter can be that record.
  _armWakeSubmissionWatch() {
    let transcript = null;
    let transcriptFrom = 0;
    try {
      transcript = transcriptPathFor({ cwd: this.cwd, sessionId: this.sessionId, homeDir: this.homeDir, env: this.env });
      transcriptFrom = transcript ? fs.statSync(transcript).size : 0;
    } catch { transcriptFrom = 0; }
    this.wakeSubmission = {
      enters: 1,
      retries: 0,
      ticks: 0,
      transcriptFrom,
      inputUnits: this.input.receivedUnits,
      // Queued operator bytes release right behind this Enter. If the Enter
      // was dropped they now share the composer with the wake text, and a
      // retry Enter would submit THEIR blend -- the watch may only observe.
      operatorBytes: this.queuedInput.length > 0,
      outputGeneration: this.output.generation,
      outputSeen: false,
      settledTicks: 0,
    };
    // No transcript path for this session means no evidence class at all:
    // nothing could ever commit the watch, so every settled repaint would buy
    // a blind Enter up to the cap. A retry without a way to observe its
    // landing is a bare retry; the watch closes by name instead. (A path that
    // resolves but has no file yet is the ordinary pre-submission state and
    // stays armed -- the record appears when the seat accepts the prompt.)
    if (transcript === null) {
      this._closeWakeSubmission('transcript-unresolvable', { session_id: this.sessionId });
    }
  }

  _closeWakeSubmission(reason, detail = null) {
    const watch = this.wakeSubmission;
    if (watch === null) return;
    this.wakeSubmission = null;
    const counts = { enters: watch.enters, retries: watch.retries, ticks: watch.ticks };
    if (reason === 'committed') {
      this._event('wake-submission-committed', counts);
      return;
    }
    this._event('wake-submission-unconfirmed', { reason, ...counts, ...(detail || {}) });
  }

  // Same scan shape as _checkCapsuleAck: bounded read past the noted offset,
  // one complete line carrying both the wake text and the USER tag. A user
  // record is the seat accepting the prompt; the operator's own Enter
  // producing it counts too -- the wake landed either way.
  //
  // The line is PARSED, not substring-matched, because "type":"user" is not
  // only the typed prompt: the transcript stores tool results as type:"user"
  // records too (content blocks of type "tool_result" -- a tool reading a
  // file that carries the wake text returns it verbatim), and injected
  // context (hook and local-command output) as isMeta user records. Only
  // typed text -- a string content, or a "text" block -- is the seat
  // accepting the prompt. Same record model stop-capsule-writer reads.
  _wakeUserRecordLanded(line) {
    if (!line.includes(WAKE_TRANSCRIPT_LITERAL) || !line.includes('"type":"user"')) return false;
    let record;
    try { record = JSON.parse(line); } catch { return false; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.type !== 'user' || record.isMeta === true) return false;
    const message = record.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (message.role !== undefined && message.role !== 'user') return false;
    const content = message.content;
    if (typeof content === 'string') return content.includes(WAKE_MESSAGE);
    if (!Array.isArray(content)) return false;
    return content.some((block) => block && typeof block === 'object' && !Array.isArray(block)
      && block.type === 'text' && typeof block.text === 'string'
      && block.text.includes(WAKE_MESSAGE));
  }

  _wakeRecordObserved(watch) {
    try {
      const transcript = transcriptPathFor({ cwd: this.cwd, sessionId: this.sessionId, homeDir: this.homeDir, env: this.env });
      if (!transcript) return false;
      const size = fs.statSync(transcript).size;
      if (size <= watch.transcriptFrom) return false;
      const from = Math.max(0, watch.transcriptFrom - WAKE_TRANSCRIPT_LITERAL.length);
      const length = Math.min(size - from, 262144);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(transcript, 'r');
      try { fs.readSync(fd, buffer, 0, length, from); } finally { fs.closeSync(fd); }
      const landed = buffer.toString('utf8').split('\n')
        .some((line) => this._wakeUserRecordLanded(line));
      if (landed) return true;
      const lastBreak = buffer.lastIndexOf(0x0a);
      if (lastBreak >= 0) {
        watch.transcriptFrom = Math.max(watch.transcriptFrom, from + lastBreak + 1);
      }
      return false;
    } catch { return false; }
  }

  _tickWakeSubmission() {
    const watch = this.wakeSubmission;
    watch.ticks += 1;
    if (this._wakeRecordObserved(watch)) {
      this._closeWakeSubmission('committed');
      return;
    }
    // Operator sovereignty: any operator byte that reached the child since
    // the wake text (queued release at the Enter, or live input since) ends
    // the watch. Their composer, their Enter. Logged, never retried.
    if (watch.operatorBytes || this.input.receivedUnits !== watch.inputUnits) {
      this._closeWakeSubmission('operator-input');
      return;
    }
    // Another automatic transaction owns the composer now; its own kill-line
    // and Enter discipline govern whatever the wake left there.
    if (this.inputHold || this.enterHandle !== null
      || this.composerMayHoldControlText || this.phase !== 'idle') {
      this._closeWakeSubmission('composer-busy', { phase: this.phase });
      return;
    }
    if (watch.ticks > WAKE_SUBMIT_WATCH_TICKS) {
      this._closeWakeSubmission('watch-budget', { ticks_budget: WAKE_SUBMIT_WATCH_TICKS });
      return;
    }
    // Evidence gate: output SINCE the last Enter, then stillness. A dropped
    // keypress leaves the seat busy (hooks) and later repainting; only that
    // repaint settling says the seat can take a keypress now. Elapsed ticks
    // alone never press Enter.
    if (this.output.generation !== watch.outputGeneration) {
      watch.outputGeneration = this.output.generation;
      watch.outputSeen = true;
      watch.settledTicks = 0;
      return;
    }
    if (!watch.outputSeen) return;
    watch.settledTicks += 1;
    if (watch.settledTicks < WAKE_SUBMIT_SETTLE_TICKS) return;
    if (watch.retries >= WAKE_ENTER_RETRY_LIMIT) {
      this._closeWakeSubmission('retry-cap', { limit: WAKE_ENTER_RETRY_LIMIT });
      return;
    }
    // ─── DIALOG READINESS (#104) ─────────────────────────────────────────────
    // THE ONE WAKE BOUNDARY A DIALOG CAN REACH, and the reason it differs from
    // the other two is worth stating because it decided the whole wake family.
    //
    // The wake TEXT and its first owned Enter fire inside _rebindAfterClear,
    // onto a context the host has just torn down and rebuilt. Nothing has been
    // submitted to that context, so no tool_use can exist and no tool dialog
    // can be open -- the hazard is structurally absent, which is why those two
    // are not gated. (It is also why they could not be: that window precedes
    // the new session's FIRST transcript record, so the evidence source does
    // not exist yet. The deterministic suite asserts exactly that. ENOENT is
    // read as the positive answer it is -- see _noteToolCallWatch -- so the
    // reader does not hold them either way, but the structural argument is the
    // load-bearing one, not the ENOENT handling.)
    //
    // THIS boundary is different. It fires on later ticks, after the first
    // Enter released the input hold and queued operator bytes went in behind
    // it. The operator's own prompt can be running by now, with a dialog up,
    // while the WAKE's record still has not appeared -- which is exactly the
    // state the retry was built for. So a dialog here is reachable and this
    // Enter is gated.
    //
    // DEFERRED, NOT SPENT: the retry budget is untouched, so the owed retry
    // still happens once the dialog is answered. Elapsed ticks alone never
    // press Enter here, and now neither does an answered dialog's absence.
    const retryReadiness = this._automaticWriteReadiness('wake-enter-retry');
    if (!retryReadiness.ready) {
      this._automaticWriteHeld('wake-enter-retry', retryReadiness);
      return;
    }
    this._automaticWriteReleased('wake-enter-retry');
    watch.retries += 1;
    watch.enters += 1;
    watch.outputSeen = false;
    watch.settledTicks = 0;
    try {
      // ─── THE INTERLOCK (#104) ──────────────────────────────────────────────
      // The gate, the pending re-read and the keypress are one critical
      // section, like the other two Enter boundaries. A refusal here GIVES THE
      // RETRY BACK: the budget was incremented above (the counters are what the
      // close reasons are computed from), and a held retry is still owed, which
      // is the contract the readiness gate above already established.
      const interlocked = this._interlockedWrite('wake-enter-retry', () => {
        this._event('wake-enter-retry', { attempt: watch.retries, limit: WAKE_ENTER_RETRY_LIMIT });
        return this.pty.write(CONTROL_ENTER);
      });
      if (!interlocked.ok) {
        watch.retries -= 1;
        watch.enters -= 1;
        this._automaticWriteHeld('wake-enter-retry', {
          ready: false,
          code: interlocked.code,
          detail: interlocked.detail,
        });
        return;
      }
    } catch (error) {
      // The composer is untouched by anyone else, so nothing is stranded
      // that was not already. Named, closed; the operator's Enter still works.
      // A DISTINCT code from the first Enter's runner-wake-enter-write-failed:
      // that one is terminal and _disableAutomation treats a lastReason
      // carrying it as a stranded wake (retains the input hold, renames a
      // later unrelated disable after it). The hold here was released at the
      // first Enter and nothing is stranded, so this must never read as that.
      this.lastReason = {
        code: 'runner-wake-enter-retry-write-failed',
        detail: { attempt: watch.retries, limit: WAKE_ENTER_RETRY_LIMIT, error: errorText(error) },
      };
      this._event('wake-enter-write-failed', this.lastReason);
      this._closeWakeSubmission('enter-write-failed', { attempt: watch.retries });
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
    // ─── SEED THE INTERLOCK PROOF AS EARLY AS POSSIBLE (#104) ────────────────
    // The hook is deliberately INERT until this file exists ("no managed
    // runner means no opinion"), so writing it on the first tick rather than at
    // the first gated boundary is what lets the hook start counting its own
    // invocations from the start of the session. Without it the first gated
    // boundary would arrive, write the proof, and then have to wait for the
    // next Stop before `interlock-hook-not-observed` cleared -- a hold that is
    // safe but avoidable. Idempotent and free after it succeeds once (it
    // returns immediately while the bound session id still matches), and its
    // problem is deliberately ignored here: _interlockReadiness re-runs it and
    // is where the refusal is named.
    if (interlockEnabled(this.env)) this._ensureInterlockProof();
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
    // The watched wake runs ahead of lifecycle work each tick so a retry
    // Enter can never follow control text written later in the same tick.
    if (this.wakeSubmission !== null) this._tickWakeSubmission();

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

    // THE ACKNOWLEDGEMENT LIFECYCLE BOUNDARY (#90, #91). Runs on EVERY tick,
    // keyed on cycle identity, before anything reads or writes ack evidence:
    //
    //  - a cycle the transport just abandoned inside the tick() above (any of
    //    the three _gatePressure paths: pressure, checkpoint-requested,
    //    checkpoint-confirmed) loses its evidence AND its window here, so the
    //    scan immediately below has nothing to re-latch into and a late ack
    //    from the abandoned request authorizes nothing;
    //  - a cycle that merely HOLDS keeps the same cycle_id and keeps its
    //    evidence untouched;
    //  - a live cycle with no window yet recovers one from the boundary the
    //    transport persisted when the cycle opened, instead of the stop-writer
    //    offset that sits PAST the ack (#90 shape 1), and regardless of which
    //    state this tick ended in (#90 shape 2).
    this._syncCapsuleAckLifecycle(coreResult);
    // THE RETIRED REQUESTS' ANSWERS, FIRST (#90/#91 review, R1). A request the
    // transport retired is still owed one answer by the seat, and that answer
    // can land at any time -- including inside the replacement cycle's window,
    // where identity binding alone would have labelled it with the replacement
    // cycle. Draining before the live scan is what makes the oldest outstanding
    // request, rather than the newest cycle, the thing a literal discharges.
    // Runs on EVERY tick, including the idle ones between cycles, because that
    // is exactly when a late answer arrives.
    this._drainRetiredCapsuleAcks();
    if (this.capsuleAck === null && this.capsuleAckWatch !== null) {
      this._checkCapsuleAck();
    }
    // THE CLASSIFICATION CROSSES THE RELAUNCH (re-review 5556245936, S1).
    // Written after BOTH readers have run, so it reflects what this tick
    // actually classified, and only when it CHANGED -- noteAckClassification
    // dedupes against the persisted record, so an ordinary tick writes nothing.
    this._persistCapsuleAckClassification(coreResult.state.cycle_id);
    // Outstanding operator CRs resolve here, BEFORE the composer guard below
    // consults the tracker, so a confirmed submission releases a deferred
    // request on this same tick -- exactly once, through the usual gate.
    if (this.input.outstanding.length > 0) {
      this._checkPendingSubmission();
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
    // guarded on "this cycle is not acked" so a relaunch that already found the
    // ack on disk (the scan above) never re-injects. A request DEFERRED behind
    // operator text (composer guard in _writeCapsuleRequest) stays owed to
    // its cycle after the transport walks on to checkpoint-confirmed — the
    // walk takes one ok tick, and without this the deferred cycle would wedge
    // at runner-capsule-not-acked.
    //
    // #90 SHAPE 2, the silent park: a process whose FIRST tick lands in
    // `checkpoint-confirmed` (the transport walks requested -> confirmed inside
    // one tick when the checkpoint observable is already satisfied) never
    // wrote a request for that cycle, so there is no ack coming and the old
    // gate — keyed to the deferred cycle_id alone — injected nothing and
    // refused runner-capsule-not-acked forever: automatic refresh dead until
    // relaunch, fail-closed but silent. The gate now also fires at
    // checkpoint-confirmed when the cycle demonstrably has no ack to wait for:
    // either no evidence window could be recovered for it (legacy / absent /
    // foreign / malformed boundary — each already named visibly by
    // _capsuleAckWatchUnrecoverable) or its window has been read to the end of
    // the transcript with no ack in it (`drained`). Waiting for the window to
    // drain is what keeps a relaunch whose ack IS on disk, but more than one
    // scan window past the boundary, from re-injecting before the scan reaches
    // it. The one-request-per-cycle_id latch inside _writeCapsuleRequest still
    // bounds this to a single write per cycle, so the HOLD oscillation loop
    // this gate was originally narrowed for cannot come back.
    //
    // #90/#91 REVIEW, R2 — THE CHECKPOINT HOLD WITH NOWHERE TO GO. A restore
    // whose persisted boundary is legacy / absent / malformed leaves NO window
    // (_capsuleAckWatchUnrecoverable, which fails safe on purpose) while the
    // cycle sits at `HOLD:checkpoint-transcript-short`, genuinely justified by
    // transcript growth past the Stop record. That hold lifts only on a fresh
    // ack (the ack supersedes the tail arithmetic) or a fresh checkpoint, and
    // the gate admitted neither this state nor any other continuing checkpoint
    // hold: no window, no request, nothing requested for as long as the seat
    // ran. The checkpoint-HOLD family is the SAME stage of the cycle's life as
    // `checkpoint-confirmed` -- the transport itself treats `HOLD:checkpoint-*`
    // as the checkpoint-requested continuation -- so it is admitted on the same
    // terms and under the same guards. Other HOLD authorities (telemetry, boot
    // receipt, kill switch, clear-ambiguous) are NOT admitted: they are not
    // waiting on a capsule and a request would not lift them.
    //
    // #90/#91 REVIEW, R3 — THE RESTORE WINDOW IS EVIDENCE, IN EVERY STATE. The
    // drained guard used to apply at `checkpoint-confirmed` only. A restore
    // that comes back `checkpoint-requested` (or carries
    // `action=request-checkpoint`) can hold a perfectly valid on-disk ack
    // beyond the first bounded read: the first scan advances without reaching
    // it, the unconditional arm writes ANOTHER request, and _armCapsuleAckWatch
    // moves the cursor to the transcript's end -- putting the valid ack behind
    // the cursor, where nothing forward-only can ever reach it again. The guard
    // is therefore applied to every state the gate admits: a cycle that still
    // owns an unread window waits for it to drain, at one bounded read per
    // tick, and only then asks again. A cycle with NO window (nothing to lose)
    // and a cycle whose request is deferred behind operator text are unchanged.
    const ackCycleId = coreResult.state.cycle_id;
    const coreStateName = typeof coreResult.state.state === 'string'
      ? coreResult.state.state
      : '';
    const atCheckpointStage = coreResult.action === 'request-checkpoint'
      || coreStateName === 'checkpoint-requested'
      || coreStateName === 'checkpoint-confirmed'
      || coreStateName.startsWith('HOLD:checkpoint-');
    // Nothing is lost by re-arming: either there is no window for this cycle,
    // or its window has been read to the end of the transcript with no ack in
    // it, or the request is still owed because the composer deferred it.
    const windowHoldsNoUnreadEvidence = this.capsuleRequestDeferredCycleId === ackCycleId
      || this.capsuleAckWatch === null
      || this.capsuleAckWatch.drained === true;
    if (!this._capsuleAckAuthorizes(ackCycleId)
      && atCheckpointStage
      && windowHoldsNoUnreadEvidence) {
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
    // Teardown's own release (#104). A runner that exits holding the gate
    // leaves the child's next tool call waiting out GATE_STALE_MS before the
    // hook can steal it -- recoverable, but there is no reason to leave it.
    this._releaseInterlockGate('runner-teardown');

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
    this._closeWakeSubmission('shutdown', { exit_code: normalizedExitCode });
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

// Issue #98. A parent that is itself a Claude Code session exports
// CLAUDE_CODE_CHILD_SESSION=1, and a `claude` spawned with it inherited keeps
// its transcript OFF: no records, no sessions/<pid>.json descriptor. Every
// transcript-reading guard in this runner (checkpoint freshness, the ack
// restore scan, the ack reader, dialog readiness) then reads a file that exists,
// parses and never grows, and the failure presents as a park, not a
// misconfiguration; a later --continue resumes from the frozen file and drops
// the unpersisted work. The runner is the one boundary every launch passes
// (shortcut, direct, unmanaged fallback), so the child's environment is built
// here: the marker removed and persistence asked for through the host's own
// opt-in (CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, read by the installed 2.1.314
// binary). Only the child's copy changes; the runner's own `env`, the operator's
// shell and the global settings are untouched. The launcher's direct branches
// (--no-deps, node missing) exec claude without this runner and carry the same
// two lines themselves (launcher/aigent.ps1, launcher/aigent.sh).
export function childEnvironment(env = process.env) {
  const child = { ...env };
  delete child.CLAUDE_CODE_CHILD_SESSION;
  // A default, never an override: an operator who set the opt-in explicitly
  // (to any value) keeps their word.
  child.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE ??= '1';
  return child;
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
  const childEnv = childEnvironment(env);
  const resolved = resolvePtyCommand({
    command,
    args,
    platform,
    env: childEnv,
    fsImpl,
  });
  const windowsVerbatimArguments = platform === 'win32'
    && typeof resolved.args === 'string';
  const spawnArgs = windowsVerbatimArguments
    ? [resolved.args]
    : resolved.args;
  const result = spawnSyncFn(resolved.command, spawnArgs, {
    cwd,
    env: resolved.env || childEnv,
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
  // The child's environment (#98), built once here; `env` itself stays the
  // runner's and is still read for AIGENT_* configuration above and below.
  const childEnv = childEnvironment(env);
  let resolved;
  try {
    resolved = resolvePtyCommand({
      command,
      args: childArgs,
      platform,
      env: childEnv,
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
      env: resolved.env || childEnv,
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
