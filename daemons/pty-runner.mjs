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
  capsuleAckBoundaryProblem,
  capsuleAckClassification,
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
export const WAKE_MESSAGE = '[aigent] post-clear resume: run the resume procedure staged at session start now -- load the selected capsule, re-ground, and act. If none is staged, load the newest valid capsule from the capsules directory under this install\'s memory root and proceed.';
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
        this.pasteEndProbe = `${this.pasteEndProbe}${character}`.slice(-7);
        if (this.pasteEndProbe.endsWith('\u001b[201~')) {
          // An EMPTY paste places nothing: the byte before the cursor is
          // still whatever preceded the paste-start sequence -- and the
          // pending record goes back to its ESC-arrival snapshot, since the
          // end marker's own bytes marked it dirty above.
          if (this.pasteEndProbe.length === 7) {
            this.lastByte = this.pasteEndProbe[0];
          } else {
            this.lastByte = this.preSequenceLastByte;
            this._restorePending();
          }
          this.mode = 'normal';
          this.pasteEndProbe = '';
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
    // Composer guard: the cycle whose request was deferred behind operator
    // text (or uncertain input ownership). Diagnostic latch only — it makes
    // the deferral a once-per-cycle event; the request itself stays pending.
    this.capsuleRequestDeferredCycleId = null;
    // Receipt watch for the tracker's outstanding CRs: {transcript, offset,
    // midLine}. Noted when the queue goes from empty to non-empty, scanned
    // each tick by _checkPendingSubmission for new operator prompt records,
    // which resolve the queue oldest-first. Null when nothing is outstanding.
    this.pendingSubmissionWatch = null;
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
    this.currentControlWriteAttempted = true;
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
    this.capsuleAckSpent = {
      session_id: spentIdentity.session_id,
      cycle_id: spentIdentity.cycle_id,
    };
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

  // Open (or re-open) the cycle's forward-only ack window at the transcript's
  // current end. Called when the request is written: nothing already on disk
  // can answer a request that has only just gone out.
  _armCapsuleAckWatch(cycleId) {
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
    let from = null;
    try {
      const transcript = this._transcriptPath();
      if (transcript) {
        const size = fs.statSync(transcript).size;
        if (Number.isSafeInteger(size) && size >= 0) from = size;
      }
    } catch { from = null; }
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
  _settleCapsuleAnswer(cycleId, through) {
    const account = this._capsuleAccountFor(cycleId);
    if (account !== null) account.answers_settled += 1;
    if (Number.isSafeInteger(through)) {
      this.capsuleAckClassifiedThrough = Math.max(this.capsuleAckClassifiedThrough, through);
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
        detail: { from: offset, size, pending: size - offset },
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
    account.requests_issued += 1;
    if (this._persistCapsuleAckClassification(cycleId) === 'failed') {
      account.requests_issued -= 1;
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
    this._armCapsuleAckWatch(cycleId);
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
        this._settleCapsuleAnswer(watch.cycle_id, settledAt);
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
    this._event('automation-disabled', this.lastReason, REFUSAL_DETAIL_MAX);
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
      const deferred = this.capsuleRequestDeferredCycleId === cycleId
        && this.capsuleRequestCycleId !== cycleId;
      this.lastReason = deferred
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
      this._noteSubmissionRefusal(this.lastReason.code, this.lastReason.detail);
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
    watch.retries += 1;
    watch.enters += 1;
    watch.outputSeen = false;
    watch.settledTicks = 0;
    try {
      this._event('wake-enter-retry', { attempt: watch.retries, limit: WAKE_ENTER_RETRY_LIMIT });
      this.pty.write(CONTROL_ENTER);
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
