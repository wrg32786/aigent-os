#!/usr/bin/env node
// stop-capsule-writer.mjs — every-turn capsule delta writer.
//
// Stop hook. Parses the transcript delta since the last turn and anchored-merges
// it into the operator's ONE active capsule, so disk state is never more than one
// turn stale (compaction = RAM, capsule = disk).
//
// Fire-and-forget: the parent process re-spawns itself detached+unref with the
// hook payload and exits 0 immediately — the turn is never blocked, whatever the
// transcript size. All real work happens in the child (--worker).
//
// CONCURRENCY: one writer at a time per session — a lock file under the runtime
// dir serializes concurrent workers (fast consecutive turns, or a PreCompact flush
// running this same worker synchronously). A loser exits WITHOUT advancing the
// offset, so its delta is simply picked up next turn — deferred, never lost.
//
// Kill-switch: LIFECYCLE_KILL_STOP_WRITER=1 disables (test runners + emergencies).
// INVARIANT: fail open — any error exits 0. Never blocks a turn. Never silent:
// real failures append to <memRoot>/.daemon-errors.log.
//
// v0.9.0 minimal model: the pointer this worker stamps at BODY_STATE.json's
// state.last_capsule is a COMPATIBILITY hint only — orientation/audit tooling may
// read it, but resume-verb.mjs never does (it selects the newest valid capsule by
// created_at). That drops the finalize-freeze byte-lock, the curated-vs-rolling
// pointer race guard, and close_kind stamping the refresh-cycle tower needed —
// there is exactly one writer of exactly one pointer now, unconditionally.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, openSync,
  closeSync, statSync, renameSync, rmSync, appendFileSync, writeSync, realpathSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CAPSULE_SECTIONS, classifyMcpEffect, capsuleRowKey, doneRowPriority, DONE_LIMITS, DONE_TAG, locateCapsuleSection, parseSideEffectRow, formatSideEffectRow, effectKey, inert, storedData, memRoot as resolveMemRoot, scalar, unsafeRawCapsuleDocument,
} from './lifecycle-common.mjs';
import { unsafeRawTranscriptDelta } from './raw-acquisitions.mjs';
import { framingFrontmatter, framingBanner } from './memory-hygiene/resume-framing.mjs';

const require = createRequire(import.meta.url);
const { atomicUpdateJson } = require('./memory-hygiene/atomic-state.cjs');
const { redact } = require('./redact.cjs');

const SELF = fileURLToPath(import.meta.url);

function shellWords(text) {
  text = text.replace(/^\s*\$[A-Za-z_]\w*\s*=\s*/, '');
  // Tokenize before stripping quotes so a quoted option value stays one token.
  const words = (text.trim().match(/(?:[^\s"'(){}]+|"(?:\\.|[^"\\])*"|'[^']*')+|[(){}]/g) || []);
  const wrappers = /^(sudo|time|env|nohup|exec|command|nice|ionice|timeout)$/i;
  const optionValue = {
    sudo: /^(?:-[ughpCRT]|--user|--group|--host|--prompt|--chdir|--chroot|--command-timeout)$/,
    time: /^(?:-[fo]|--format|--output)$/,
    env: /^(?:-[uCS]|--unset|--chdir|--split-string)$/,
    exec: /^-a$/,
    timeout: /^(?:-s|--signal|-k|--kill-after)$/,
    nice: /^(?:-n|--adjustment)$/,
    ionice: /^(?:-[cnptu]|--class|--classdata|--pid|--pgid|--uid)$/,
  };
  while (words.length) {
    if (/^(?:\(|then|else|do|\{|if|while|until|!)$/.test(words[0])) { words.shift(); continue; }
    if (/^[A-Za-z_]\w*=/.test(words[0])) { words.shift(); continue; }
    if (!wrappers.test(words[0])) break;
    const wrapper = words.shift().toLowerCase();
    while (words[0]?.startsWith('-')) {
      const option = words.shift();
      if (option === '--') break;
      if (optionValue[wrapper]?.test(option)) words.shift();
    }
    if (wrapper === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(words[0])) words.shift();
  }
  return words;
}

function shellCommand(text) {
  const words = shellWords(text).map((word) => word.replace(/["']/g, '').replace(/\s+/g, ' '));
  const commands = /^(?:git|gh|curl|wget|docker|railway|vercel|npm|pnpm|yarn|aws|kubectl|terraform|scp|rsync|wrangler|fly|netlify|firebase|gcloud|Invoke-RestMethod|Invoke-WebRequest)$/i;
  const binary = (word = '') => word.split(/[\\/]/).pop().replace(/@[^\s]+$/, '').replace(/\.exe$/i, '');
  if (/^(?:npx|pnpm|yarn|bunx)$/i.test(binary(words[0]))) {
    let next = 1;
    if (/^(?:pnpm|yarn)$/i.test(binary(words[0])) && words[next] === 'dlx') next++;
    while (words[next]?.startsWith('-')) {
      const option = words[next++];
      if (/^(?:-p|--package)$/.test(option)) next++;
      else if (!/^(?:-y|--yes|-q|--package=.+)$/.test(option)) break;
    }
    if (commands.test(binary(words[next]))) words.splice(0, next);
  }
  const command = binary(words.shift());
  if (!commands.test(command)) return '';
  const original = [...words];
  const options = [];
  while (/^-\S+/.test(words[0])) {
    const option = words.shift();
    if (option === '--') break;
    if (/^(?:-n|-C|-c|--profile|--project|--context|--token|--namespace|--region|--git-dir|--work-tree|--config-env)$/.test(option)) words.shift();
    else options.push(option);
  }
  // Flag-driven commands need their original flag/value adjacency for evidence.
  const args = /^(?:curl|wget|scp|rsync|Invoke-RestMethod|Invoke-WebRequest)$/i.test(command)
    ? original : words.length ? words : options;
  return [command, ...args].join(' ');
}

// Find substitutions without treating quoted prose or escaped delimiters as code.
function substitutionEnd(command, start, backtick) {
  let depth = 1, quote = null;
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (backtick && ch === '`') return i;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (!backtick && ch === '(') depth++;
    if (!backtick && ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function shellSegments(command, toolName) {
  if (toolName === 'PowerShell') command = command.replace(/`\r?\n/g, ' ');
  const segments = [];
  let quote = null;
  let start = 0;
  let unquoted = '';
  const heredocs = [];
  let substitutions = [];
  const push = (end) => {
    const text = command.slice(start, end);
    const words = shellWords(text);
    const shell = /^(?:bash|sh|zsh)$/i.test(words[0]) && words[1] === '-c'
      ? 'Bash' : /^(?:pwsh|powershell)$/i.test(words[0]) && /^-Command$/i.test(words[1]) ? 'PowerShell' : null;
    const payload = words[2];
    if (shell && /^(?:"(?:\\.|[^"\\])*"|'[^']*')$/.test(payload)) {
      const inner = payload.slice(1, -1);
      segments.push(...shellSegments(payload[0] === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner, shell));
    } else {
      segments.push(...substitutions, { text, unquoted: unquoted.padEnd(end - start, ' ') });
    }
    substitutions = [];
    unquoted = '';
  };
  const drainHeredocs = () => {
    if (!heredocs.length) return;
    const bodyStart = start;
    for (const { word, tabs } of heredocs.splice(0)) {
      while (start < command.length) {
        const newline = command.indexOf('\n', start);
        const end = newline === -1 ? command.length : newline;
        let line = command.slice(start, end).replace(/\r$/, '');
        if (tabs) line = line.replace(/^\t+/, '');
        start = newline === -1 ? command.length : newline + 1;
        if (line === word) break;
      }
    }
    segments.push({ text: command.slice(bodyStart, start), unquoted: '', opaque: true });
  };
  for (let i = 0; i < command.length; i++) {
    // Keep the unquoted mask aligned with the original segment.
    unquoted = unquoted.padEnd(i - start, ' ');
    const ch = command[i];
    if (toolName === 'Bash' && ch === '\\' && quote !== "'") {
      if (!quote) unquoted += ' ';
      i++;
      continue;
    }
    if (quote !== "'" && (command.startsWith('$(', i) || (toolName === 'Bash' && ch === '`'))) {
      const backtick = ch === '`';
      const innerStart = i + (backtick ? 1 : 2);
      const end = substitutionEnd(command, innerStart, backtick);
      if (end !== -1) {
        substitutions.push(...shellSegments(command.slice(innerStart, end), toolName));
        unquoted += ' ';
        i = end;
        continue;
      }
    }
    if (!quote && ch === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
      push(i);
      const newline = command.indexOf('\n', i);
      start = newline === -1 ? command.length : newline + 1;
      drainHeredocs();
      i = start - 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; unquoted += ' '; continue; }
    if (command.startsWith('<<<', i)) {
      unquoted += ' ';
      i += 2;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') {
      const heredoc = /^<<(-?)[ \t]*(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([\w]+))/.exec(command.slice(i));
      if (heredoc) {
        heredocs.push({ word: heredoc[2] ?? heredoc[3] ?? heredoc[4], tabs: heredoc[1] === '-' });
        unquoted += ' ';
        i += heredoc[0].length - 1;
        continue;
      }
    }
    if (ch === ';' || ch === '|' || ch === '\n' || (ch === '&' && command[i - 1] !== '>')) {
      push(i);
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      start = i + 1;
      if (ch === '\n' && heredocs.length) {
        // Bodies and terminators are opaque, including quoted command-looking text.
        drainHeredocs();
        i = start - 1;
      }
    } else {
      unquoted += ch;
    }
  }
  push(command.length);
  return segments.filter((segment) => segment.text.trim());
}

const SHELL_EFFECT = new RegExp(String.raw`^(?:` + [
  String.raw`git\s+push\b`,
  String.raw`gh\s+(?:pr|issue|release)\s+(?:create|merge|comment|close|reopen|edit)\b`,
  String.raw`gh\s+release\s+(?:upload|delete)\b`,
  String.raw`gh\s+repo\s+(?:create|delete|edit|fork)\b`,
  String.raw`gh\s+pr\s+review\b`,
  String.raw`gh\s+(?:workflow\s+run|secret\s+set|variable\s+set|issue\s+delete|pr\s+ready)\b`,
  String.raw`gh\s+api\b[^\n]*\s(?:(?:-X\s*=?|--method(?:\s+|=))["']?(?:POST|PUT|PATCH|DELETE)\b|(?:-f|-F|--field|--raw-field|--input)(?:\s|=|$))`,
  String.raw`curl\b[^\n]*\s(?:-[fsS]*d\S|(?:-[fsS]*d|--data|--data-raw|--data-binary|--form|-F|--upload-file|--json|-T|--data-urlencode)(?:\s|=|$)|(?:--request(?:\s+|=)|-[fsS]*X(?:\s*|=))["']?(?:POST|PUT|PATCH|DELETE)\b)`,
  String.raw`docker\s+push\b|railway\s+up\b|(?:npm|pnpm|yarn)\s+(?:un)?publish\b`,
  String.raw`vercel(?:$|\s+(?:--yes|-y|--prod|deploy|promote|rollback|rm|remove|env\s+add|alias\s+set)(?:\s|$))`,
  String.raw`wget\b[^\n]*\s(?:--(?:post-data|post-file|body-data|body-file)(?:=|\s)|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b)`,
  String.raw`aws\s+cloudformation\s+deploy\b`,
  String.raw`Invoke-(?:RestMethod|WebRequest)\b[^\n]*\s-Method\s+["']?(?:Post|Put|Patch|Delete)\b`,
  String.raw`aws\s+\S+\s+(?:put|create|delete|send)\b|gcloud\s+\S+\s+(?:deploy|create|delete|update)\b`,
  String.raw`aws\s+s3\s+(?:cp|sync|rm|mv)\b|aws\s+sns\s+publish\b|aws\s+sqs\s+send-message\b`,
  String.raw`aws\s+lambda\s+(?:update|invoke|create|delete)\S*`,
  String.raw`kubectl\s+(?:apply|delete|rollout(?!\s+(?:status|history)\b)|scale|patch|create)\b|terraform\s+(?:apply|destroy)\b`,
  String.raw`(?:scp|rsync)\b(?!\s+--(?:version|help)\b)|(?:wrangler|fly|netlify|firebase)\s+deploy\b`,
].join('|') + ')', 'i');
// The quoted JSON key has its boundary inside the quote, not before it.
const ID_KEY = /(?:\b(?:message[_-]?id|msg[_-]?id|draft[_-]?id|thread[_-]?id|job[_-]?id|run[_-]?id|deployment[_-]?id|post[_-]?id|order[_-]?id|task[_-]?id|op[_-]?id)|"id")\s*["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:/-]{3,119})/i;
const NAMED_ID_KEY = new RegExp(ID_KEY.source.replace('|"id"', ''), 'i');
const NAMED_IDS = ['message_id', 'msg_id', 'draft_id', 'thread_id', 'job_id', 'run_id', 'deployment_id',
  'post_id', 'order_id', 'task_id', 'op_id', 'messageId', 'draftId', 'jobId', 'runId', 'deploymentId'];
function resultEvidence(text) {
  text = text.slice(0, 64 * 1024);
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    text = text.slice(0, 4000);
    return { id: NAMED_ID_KEY.exec(text)?.[1] ?? ID_KEY.exec(text)?.[1],
      unclean: /\b(error|failed|failure|denied|refused|rejected|not sent|timed? ?out)\b/i.test(text) };
  }
  const object = (value) => value !== null && typeof value === 'object';
  const handle = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  const named = (value) => {
    if (!object(value)) return undefined;
    const key = NAMED_IDS.find((key) => Object.hasOwn(value, key));
    return key === undefined ? undefined : handle(value[key]);
  };
  const nested = (value, depth = 0) => {
    if (depth > 6 || !object(value)) return undefined;
    const own = named(value);
    if (own !== undefined) return own;
    for (const child of Object.values(value)) {
      const id = nested(child, depth + 1);
      if (id !== undefined) return id;
    }
    return undefined;
  };
  try {
    const nonempty = (value) => value === true || (typeof value === 'string' && value.length > 0)
      || (object(value) && Object.keys(value).length > 0);
    const hasError = object(parsed) && (nonempty(parsed.error) || nonempty(parsed.errors) || parsed.isError === true
      || /^(?:failed|failure|error|declined|rejected|canceled)$/i.test(parsed.status));
    return {
      id: named(parsed) ?? (object(parsed) && Object.hasOwn(parsed, 'id') ? handle(parsed.id) : undefined) ?? nested(parsed),
      unclean: object(parsed) && (hasError || parsed.ok === false || parsed.success === false),
    };
  } catch { return { id: undefined, unclean: true }; }
}
const ID_URL = /https?:\/\/[^\s"'<>)\]]{8,200}/;
const INPUT_ID_KEY = /^(?:(?:message|msg|draft|thread|job|run|deployment|post|order|task|op)[_-]?)?id$/i;
const SHELL_CHECK = 're-run the read form of the command (git ls-remote, gh pr view, curl GET) before any retry';
function inputHandle(input) {
  return Object.entries(input).find(([key, value]) => INPUT_ID_KEY.test(key)
    && (typeof value === 'string' || typeof value === 'number'))?.[1] ?? 'none';
}
function storedTarget(target, shell) {
  let text = typeof target === 'object' ? JSON.stringify(target) : String(target);
  if (shell) {
    const command = shellCommand(text);
    const effect = (SHELL_EFFECT.exec(command)?.[0] ?? '').trim();
    const words = command.split(' ');
    const method = /(?:--request|--method|-Method|-[fsS]*X)\s*=?\s*(POST|PUT|PATCH|DELETE)\b/i.exec(command)?.[1];
    // AWS's recognized put/create/delete/send prefixes can name hyphenated actions.
    const action = /^aws\b/i.test(effect) ? effect + /^[\w-]*/.exec(command.slice(effect.length))[0] : effect;
    // Select only the recognized action, never its flags, operands or payload.
    const label = /^(?:curl|wget|Invoke-)/i.test(command)
      ? [words[0], method?.toUpperCase()].filter(Boolean).join(' ')
      : /^gh\s+api\b/i.test(command) ? 'gh api'
        : action.split(/\s+/).filter((word) => !word.startsWith('-')).join(' ');
    const url = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/i.exec(text)?.[0];
    let origin = '';
    try { const parsed = new URL(url); origin = ` ${parsed.protocol}//${parsed.host}`; } catch { /* no valid origin */ }
    return storedData(label + origin, 240);
  }
  if (/^https?:\/\//i.test(text)) text = text.split(/[?#]/, 1)[0];
  text = redact(text);
  if (typeof target === 'object') text = text.slice(0, 240);
  return storedData(text, 120);
}
function storedResultId(value) {
  return storedData(redact(String(value).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1')
    .replace(/^(https?:\/\/[^?#]*)\?[^#]*/i, '$1')), 120);
}
function resultText(content) {
  return (typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
    : '');
}


// Instrument identity, stamped into every receipt (board d185aeea). The hash
// names the BYTES that ran, not the tree they sat in: hooks spawn this file
// per-invocation, so a checked-out tree label would lie whenever the working
// file differs from HEAD. Computed once per spawn, BEFORE the top-level worker
// body below can reach writeState; a failure degrades to 'unknown' rather than
// blocking the receipt.
const WRITER_IDENTITY = (() => {
  try {
    return {
      writer_sha256: createHash('sha256').update(readFileSync(SELF)).digest('hex').slice(0, 16),
      writer_mtime: statSync(SELF).mtime.toISOString(),
    };
  } catch {
    return { writer_sha256: 'unknown', writer_mtime: 'unknown' };
  }
})();

function memRoot(root) {
  return resolveMemRoot(root);
}

function sha12(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function logErr(root, msg) {
  try {
    appendFileSync(path.join(memRoot(String(root || process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || ''))
      , '.daemon-errors.log'),
    `${new Date().toISOString()} tag="stop-capsule-writer" message=${inert(msg, 1000)}\n`);
  } catch { /* truly nowhere to log */ }
}

// ── parent: detach the worker and get out of the way ─────────────────────────
if (process.argv[2] !== '--worker') {
  try {
    if (process.env.LIFECYCLE_KILL_STOP_WRITER === '1') process.exit(0);
    const raw = readStdin();
    if (!raw) process.exit(0);
    let payload = {};
    try { payload = JSON.parse(raw); } catch { process.exit(0); }
    // stop_hook_active = this Stop fired because a previous Stop hook continued
    // the turn — never re-enter.
    if (payload.stop_hook_active === true) process.exit(0);
    const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
    if (!root) process.exit(0);
    const child = spawn(process.execPath, [SELF, '--worker', JSON.stringify({ ...payload, __root: root })], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // spawn() failures (ENOENT/EMFILE/AV-block) surface async on a later tick —
    // listen, then exit on the NEXT tick so the listener can fire.
    child.on('error', (e) => logErr(root, `spawn failed: ${e?.message || e}`));
    child.unref();
    setImmediate(() => process.exit(0));
  } catch (e) {
    logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR, `parent: ${e?.stack || e}`);
    process.exit(0);
  }
} else {
// ── worker: parse transcript delta, anchored-merge into the active capsule ───
let lockFd = null;
let lockPath = null;
let workerRoot = '';
// Machine-readable outcome for a synchronous invoker (a precompact flush, if a
// fork wires one) — exit-0 alone must never read as "flushed" (no-transcript /
// no-delta / lock-defer all exit 0). fs.writeSync on fd 1 is synchronous even on
// pipes, and 'exit' fires for explicit process.exit(), so every path below reports.
let outcome = 'noop:early';
process.on('exit', () => { try { writeSync(1, `SWE_OUTCOME:${outcome}\n`); } catch { /* stdio ignored (detached Stop path) */ } });
try {
  // The kill-switch must hold at the worker chokepoint too, for any caller that
  // invokes the worker directly and bypasses the Stop parent.
  if (process.env.LIFECYCLE_KILL_STOP_WRITER === '1') { outcome = 'noop:killed'; process.exit(0); }
  const payload = JSON.parse(process.argv[3] || '{}');
  const root = String(payload.__root || '');
  workerRoot = root;
  const rawSid = String(payload.session_id || '');
  const transcriptPath = String(payload.transcript_path || '');
  if (!root || !rawSid) { outcome = 'noop:bad-payload'; process.exit(0); }
  // Session ids cross three structural boundaries: lock/state filenames,
  // capsule filenames, and the capsule's id scalar. Keep ordinary harness ids
  // readable; map every other byte sequence to a stable constrained token.
  const sidIsConstrained = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rawSid);
  const sid = sidIsConstrained ? rawSid : `session-${sha12(rawSid)}`;
  const capsuleSid = sidIsConstrained ? sid.slice(0, 8) : sid;
  if (!transcriptPath || !existsSync(transcriptPath)) { outcome = 'noop:no-transcript'; process.exit(0); }

  // Content gate — lazy + fail-open, zero deps: the ONE vocabulary for
  // injection-echo/ceremony, shared with capsule-verb's validateCapsuleText.
  // Import failure degrades to pre-gate behavior (logged, never blocks a turn).
  let gate = null;
  try {
    gate = await import('./capsule-content-gate.mjs');
    if (typeof gate.isInjectionEcho !== 'function') {
      throw new TypeError('capsule-content-gate.mjs did not export isInjectionEcho()');
    }
  } catch (e) {
    gate = null;
    logErr(root, `content-gate import failed (gate skipped): ${e?.message || e}`);
  }
  const isInjectionEcho = (text) => {
    if (!gate) return false;
    try {
      return Boolean(gate.isInjectionEcho(text));
    } catch (e) {
      // Treat a broken gate like an import failure for the rest of this worker.
      // Falling back may capture noisier data, but the Stop snapshot still lands.
      gate = null;
      logErr(root, `content-gate check failed (gate skipped; write continues fail-open): ${e?.message || e}`);
      return false;
    }
  };

  // Keep validation inside the worker's fail-open boundary. A broken or missing
  // validator is diagnostic: it must be visible, but must never prevent the best
  // available Stop snapshot from landing.
  let validateCapsuleText = null;
  try {
    ({ validateCapsuleText } = await import('./capsule-verb.mjs'));
    if (typeof validateCapsuleText !== 'function') {
      throw new TypeError('capsule-verb.mjs did not export validateCapsuleText()');
    }
  } catch (e) {
    validateCapsuleText = null;
    logErr(root, `capsule validator import failed (write continues fail-open): ${e?.message || e}`);
  }

  const MEM = memRoot(root);
  const RUNTIME = path.join(MEM, 'runtime', 'stop-writer');
  mkdirSync(RUNTIME, { recursive: true });

  // Single-writer lock per session. Loser defers to next turn (offset untouched =
  // no data loss). Stale locks (>30s — a killed worker) are stolen.
  lockPath = path.join(RUNTIME, `${sid}.lock`);
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > 30_000) {
        rmSync(lockPath, { force: true });
        lockFd = openSync(lockPath, 'wx');
      } else {
        outcome = 'noop:lock-defer';
        process.exit(0); // live writer holds it — defer, don't lose
      }
    } catch { outcome = 'noop:lock-defer'; process.exit(0); }
  }
  // process.exit() SKIPS finally blocks — release the lock on the 'exit' event,
  // which fires even for explicit exits (all early-exit paths below leak the
  // lock otherwise, deferring every later writer to the 30s stale-steal).
  process.on('exit', () => {
    try { closeSync(lockFd); } catch {}
    try { rmSync(lockPath, { force: true }); } catch {}
  });

  const stateFile = path.join(RUNTIME, `${sid}.json`);
  let state = { offset: 0, capsule_path: null, last_delta_sha: null };
  try { state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) }; } catch { /* fresh */ }

  const size = statSync(transcriptPath).size;
  if (size === state.offset) { outcome = 'noop:no-delta'; process.exit(0); } // true no-op
  if (size < state.offset) {
    // Transcript replaced/rotated shorter — a stale offset here would stall the
    // writer for the rest of the session. Reset + reprocess; normalized dedup
    // below absorbs re-seen bullets.
    logErr(root, `transcript shrank (${state.offset} -> ${size}) for ${sid} — offset reset to 0`);
    state.offset = 0;
  }
  const chunk = unsafeRawTranscriptDelta(
    transcriptPath,
    state.offset,
    size,
    'the stop writer parses the complete multiline transcript delta before rendering stored fields',
  );

  // ── extract the delta ──────────────────────────────────────────────────────
  const filesRead = new Set();
  const filesModified = new Set();
  const errors = [];
  const claimedRows = new Set();
  const utterances = [];
  const effectCalls = new Map();
  const effectResults = new Map();
  const toolResults = [];
  // Defer decoding until the complete delta identifies forward-paired effect calls.
  const resultContents = new Map();
  const seenCalls = new Set();
  const effectsByTool = new Map();
  let effectPosition = 0;
  let latestRequest = null;

  // Speaker-aware classification. A close-time sweep can grep [OPERATOR] for
  // unbanked human directives, so [OPERATOR] must be PRECISE — over-tagging agent
  // chatter as [OPERATOR] makes the grep useless. Every bullet gets its true
  // source: RELAY:x for a cross-session relay message (a live multi-agent mesh, if
  // one is wired), PEER:x for a same-harness teammate/subagent envelope
  // ("Another Claude session sent a message: <teammate-message ...>"),
  // INJECT:harness for a harness/supervisor injection (gated centrally in
  // capsule-content-gate.mjs), and OPERATOR only for a genuine human utterance.
  // `human` also gates the objective so it can never be a peer envelope.
  // A turn that is ONLY a pasted path/attachment carries no directive. Live
  // specimen, titus seat 2026-08-01: the whole turn was
  //   C:\dev\cockpit\pasted\2026-08-01T22-35-23-688Z-image.png
  // and it became the seat's stated objective.
  // ⚑ RULED (titus, 2026-08-02): such a turn is NOT an objective; it falls to
  // the honest placeholder. A path LOOKS like a real objective, so it beats a
  // curated capsule on selection and poisons the resume — the 0d6fb75c class.
  // The trade against e9253777 was accepted explicitly: honest-empty beats
  // plausible-garbage.
  // Deliberately narrow. The ENTIRE turn must be one path-shaped token: quoted
  // (the quotes are the delimiter, so inner spaces are fine) or unquoted and
  // whitespace-free. It must START with a path root and END in an extension, so
  // a lone word ("continue") and a lone bare filename ("page.tsx") are NOT
  // caught, and a path INSIDE a sentence stays a genuine OPERATOR directive.
  // NOT covered, named rather than silently missed: an unquoted path containing
  // spaces — indistinguishable from prose without guessing.
  const isBareAttachment = (s) => {
    const trimmed = String(s).trim();
    if (!trimmed) return false;
    const quoted = /^"([^"]+)"$/.exec(trimmed) || /^'([^']+)'$/.exec(trimmed);
    const one = quoted ? quoted[1] : trimmed;
    if (!quoted && /\s/.test(one)) return false;
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(one)) return false;
    return /\.[A-Za-z0-9]{1,6}$/.test(one);
  };
  // Same root+extension bar as isBareAttachment, applied to each LEADING
  // @-token only. Returns the remainder (trimmed) -- empty string when the turn
  // was nothing but paste tokens.
  const stripLeadingAttachments = (s0) => {
    let t = String(s0).trim();
    const tok = /^@(?:"([^"]+)"|'([^']+)'|(\S+))\s*/;
    for (;;) {
      const m = tok.exec(t);
      if (!m) break;
      const p = m[1] ?? m[2] ?? m[3];
      if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(p) || !/\.[A-Za-z0-9]{1,6}$/.test(p)) break;
      t = t.slice(m[0].length).trim();
    }
    return t;
  };

  const classify = (s) => {
    const t = storedData(s, 2000);
    let m;
    // [^\]]*\] consumes any "@ <timestamp>" suffix a relay might add before the ]
    if ((m = t.match(/^\[room from ([\w-]+)[^\]]*\]\s*/i))) return { who: `RELAY:${m[1].toLowerCase()}`, human: false, t: t.slice(m[0].length) };
    if (/^\[inbox\b/i.test(t)) return { who: 'RELAY:inbox', human: false, t };
    // Peer ONLY when the message IS the teammate envelope (starts with the known
    // preamble or the tag). An UNANCHORED teammate_id match would downgrade a
    // HUMAN message that merely quotes teammate_id="x" to PEER — losing the
    // objective + the [OPERATOR] sweep.
    if (/^Another Claude session sent a message/i.test(t) || /^<teammate-message\b/i.test(t)) {
      const pm = t.match(/teammate_id="([\w-]+)"/i);
      return { who: pm ? `PEER:${pm[1].toLowerCase()}` : 'PEER:agent', human: false, t };
    }
    // Harness/supervisor injections ([supervisor-resume], [refresh-cycle],
    // [auto-pull], loop ticks, ...) arrive as PLAIN user strings and would
    // otherwise fall through to [OPERATOR] — which makes injected instruction
    // text the capsule OBJECTIVE verbatim. Gate them out of human-hood; they stay
    // recoverable as tagged utterances under Done.
    if (isInjectionEcho(t)) return { who: 'INJECT:harness', human: false, t };
    // Not human-hood, so it can never reach `latestRequest` -> the objective,
    // and it never pollutes the [OPERATOR] sweep. Its own tag, deliberately NOT
    // an OPERATOR variant, since the sweep greps that prefix. Still recoverable
    // under Done, exactly like a harness injection.
    // A LEADING @-quoted/@-bare paste token is harness decoration fused onto
    // real speech (live specimen, pheme seat 2026-08-02: @"...uploads...PNG"
    // followed by a genuine directive became the objective verbatim, token and
    // all). RULED (titus, 2026-08-02, board d25a884e): strip leading PATH-SHAPED
    // @-token(s) when real text follows -- the words stand VERBATIM; if nothing
    // follows, it is the 1043e52 placeholder class (the @ prefix must not let a
    // lone paste escape that rule). An @-token that is not path-shaped
    // (@titus, email @ 5pm) or not leading is speech and is never touched.
    const bare = stripLeadingAttachments(t);
    if (!bare || isBareAttachment(bare)) return { who: 'ATTACHMENT', human: false, t };
    return { who: 'OPERATOR', human: true, t: bare };
  };
  const tagUtterance = (cl, messageId) => {
    const row = `[${cl.who}] ${storedData(cl.t, 240)}`;
    const key = capsuleRowKey(row);
    // Deduplicate before the cap so repeats cannot evict distinct speech.
    // Keep the latest occurrence in capture order, matching the stored rows.
    const prior = utterances.findIndex((utterance) => capsuleRowKey(utterance.row) === key);
    if (prior !== -1) utterances.splice(prior, 1);
    utterances.push({ row, messageId });
    // Protect only the latest assistant row; older claims yield to operators.
    if (utterances.length > DONE_LIMITS.delta) {
      const latestAssistant = utterances.findLastIndex(({ row }) => DONE_TAG.exec(row)?.[1] === 'ASSISTANT');
      const priorities = utterances.map(({ row }, index) =>
        index === latestAssistant ? Infinity : doneRowPriority(row));
      utterances.splice(priorities.indexOf(Math.min(...priorities)), 1);
    }
  };

  // Harness wrapper blocks pollute the objective if left in (reminders are
  // frequently APPENDED after real user text, not prepended).
  const stripMeta = (s) => s
    .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/gi, '')
    // BLOCK, not tag — deliberately the same shape as the system-reminder line
    // above, `|$` unterminated fallback included. The previous pattern matched
    // only the OPENING tag, so `</local-command-stdout>` AND the command output
    // between the tags both survived and became the objective. Live specimen,
    // metis 2026-08-01:
    //   objective: "Login successful. Remote Control disconnected.</local-command-stdout>"
    // ⚑ Matching `</?` instead would delete the stray tag and leave the command
    // output standing as the objective — the artifact disappears and the defect
    // does not. Harness output is never a human utterance.
    .replace(/<local-command-[^>]*>[\s\S]*?(<\/local-command-[^>]*>|$)/gi, '')
    // ORPHAN CLOSER — the mirror of the `|$` fallback above, and the half that
    // fallback does NOT cover. The writer reads a DELTA WINDOW, so a window that
    // begins mid-block carries the content plus a closer whose OPENER fell
    // outside the window. The paired patterns cannot match that (after `<` they
    // require a letter, not `/`), so before this line the metis specimen still
    // reproduced byte-for-byte THROUGH the block-strip fix.
    // Everything up to the closer is block content, so it goes with the block.
    // ⚑ Deleting just the stray tag is the documented trap: it would leave
    // "Login successful. Remote Control disconnected." standing as the objective.
    // ⚑ MENTION vs USE (R26 finding, titus 2026-08-02). Anchored at BOTH ends:
    // the orphan closer must TERMINATE the message. Anchoring only at ^ made this
    // greedy to the last tag-shaped substring ANYWHERE, so a human QUOTING the
    // literal tag was cut down to a fragment — `" -- please fix the stop writer"`
    // survived alone as the objective. A mangled objective is WORSE than the
    // placeholder: it still reads as speech, so nothing downstream can tell.
    // Both-ends anchoring keeps the one MEASURED specimen (metis: block content
    // then a closer, nothing after) and refuses every mention case.
    // NAMED RESIDUE, not silently dropped: an orphan closer with block content
    // before it AND human text after it stays untouched. That shape is
    // structurally identical to a mid-sentence quotation, so syntax cannot split
    // them — declining beats guessing, because guessing wrong eats the operator's
    // real words. The earlier test asserting that shape SHOULD strip was my own
    // invention, never a measured specimen; it is deleted, not weakened.
    .replace(/^[\s\S]*<\/(?:system-reminder|local-command-[^>]*)>\s*$/i, '')
    .trim();

  let previousTimestamp = 'unknown';
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; } // partial trailing lines are normal
    // JSON primitives and malformed content blocks are valid JSON but not
    // transcript events. Skip them instead of abandoning the entire Stop delta.
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
    const requested = typeof ev.timestamp === 'string' ? ev.timestamp : previousTimestamp;
    previousTimestamp = requested;

    // Pair by operation ID across the entire delta, including sidechains.
    for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
      if (!b || typeof b !== 'object') continue;
      const position = effectPosition++;
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const result = { tool_use_id: storedData(b.tool_use_id, 240), is_error: b.is_error === true, position };
        toolResults.push(result);
        if (!seenCalls.has(result.tool_use_id) || effectsByTool.has(result.tool_use_id)) {
          resultContents.set(result, b.content);
        }
      }
      if (ev.type !== 'assistant' || b.type !== 'tool_use' || typeof b.id !== 'string') continue;
      const toolOp = storedData(b.id, 240);
      seenCalls.add(toolOp);
      const input = b.input ?? {};
      const shell = b.name === 'Bash' || b.name === 'PowerShell';
      const mcpEffect = classifyMcpEffect(b.name) !== 'read';
      if (!shell && b.name !== 'SendMessage' && !mcpEffect) continue;
      const segments = shell ? (typeof input.command === 'string' ? shellSegments(input.command, b.name) : []) : [null];
      for (const [index, segment] of segments.entries()) {
        const command = segment?.text.trim();
        if (shell && (segment.opaque || /--dry-run/i.test(segment.unquoted)
          || /^rsync\b[^\n]*\s-[a-zA-Z]*n[a-zA-Z]*(?:\s|$)/i.test(shellCommand(segment.unquoted))
          || !SHELL_EFFECT.test(shellCommand(command)))) continue;
        const target = shell ? command : ['to', 'recipient', 'recipients', 'channel', 'channel_id', 'url', 'repo', 'subject', 'title', 'command']
          .map((key) => input[key]).find((value) => value !== undefined && value !== null) ?? b.name;
        const op = segments.length > 1 ? `${toolOp}#${index}` : toolOp;
        if (!effectsByTool.has(toolOp)) effectsByTool.set(toolOp, new Set());
        effectsByTool.get(toolOp).add(op);
        effectCalls.set(op, { op, toolOp, kind: storedData(`${ev.isSidechain === true ? 'sidechain:' : ''}${shell ? 'shell' : b.name}`, 240),
          earlierSegment: shell && index < segments.length - 1,
          target: storedTarget(target, shell), requested: storedData(requested, 120),
          id: storedData(redact(inputHandle(input)), 120), position });
      }
    }

    if (ev.type === 'user' && !ev.isMeta) {
      const speech = ev.isSidechain !== true;
      const c = ev.message?.content;
      if (typeof c === 'string' && speech) {
        const clean = stripMeta(c);
        if (clean && !clean.startsWith('<')) { const cl = classify(clean); if (cl.human) latestRequest = storedData(cl.t, 300); tagUtterance(cl); }
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
          if (speech && b.type === 'text' && typeof b.text === 'string' && b.text) {
            const clean = stripMeta(b.text);
            if (clean && !clean.startsWith('<')) { const cl = classify(clean); if (cl.human) latestRequest = storedData(cl.t, 300); tagUtterance(cl); }
          }
          if (b.type === 'tool_result' && b.is_error) {
            const txt = resultText(b.content);
            if (txt) errors.push(storedData(txt, 200));
          }
        }
      }
    } else if (ev.type === 'assistant') {
      const speech = ev.isSidechain !== true;
      const content = ev.message?.content;
      if (!Array.isArray(content)) continue;
      // ID-less events are distinct messages, but their own blocks still coalesce.
      const messageId = typeof ev.message.id === 'string' && ev.message.id.trim()
        ? ev.message.id : ev;
      for (const b of content) {
        if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
        if (speech && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          // Replace only an earlier text block belonging to this same message.
          const prior = utterances.findIndex((utterance) => utterance.messageId === messageId);
          if (prior !== -1) utterances.splice(prior, 1);
          tagUtterance({ who: 'ASSISTANT', t: b.text }, messageId);
        }
        if (b.type !== 'tool_use') continue;
        const input = b.input ?? {};
        if (b.name === 'Read' || b.name === 'Grep' || b.name === 'Glob') {
          const p = input.file_path || input.path;
          if (p) filesRead.add(storedData(p, 240));
        } else if (b.name === 'Edit' || b.name === 'Write' || b.name === 'NotebookEdit') {
          if (input.file_path) filesModified.add(storedData(input.file_path, 240));
        } else if (/(^|_)board_claim$/i.test(String(b.name || ''))
          && typeof input.task_id === 'string' && input.task_id.trim()) {
          // Generic match on any *_board_claim tool (an optional task-board MCP,
          // whatever it is named) rather than one hardcoded server name.
          claimedRows.add(storedData(input.task_id, 160));
        }
      }
    }
  }

  // ── locate or create the operator's ONE active capsule ────────────────────
  const deltaSignature = (eligibleResults) => sha12(JSON.stringify({
    r: latestRequest, fr: [...filesRead].sort(), fm: [...filesModified].sort(),
    e: errors, c: [...claimedRows].sort(),
    u: utterances.map(({ row }) => row),
    ...(effectCalls.size || eligibleResults.length ? { effects: [...effectCalls], results: eligibleResults } : {}),
  }));
  // Deltas without possible effect results need no capsule read or path repair.
  if (!effectCalls.size && !toolResults.some(({ tool_use_id }) => !seenCalls.has(tool_use_id))
    && deltaSignature([]) === state.last_delta_sha) {
    writeState(stateFile, { ...state, offset: size });
    outcome = 'noop:no-delta';
    process.exit(0);
  }

  const capDir = path.join(MEM, 'capsules');
  mkdirSync(capDir, { recursive: true });
  const capDirResolved = path.resolve(capDir);
  const capDirReal = realpathSync(capDir);
  const isWithinCapsules = (candidate, resolveLinks = false) => {
    let resolved;
    try {
      resolved = resolveLinks ? realpathSync(candidate) : path.resolve(candidate);
    } catch {
      return false;
    }
    const base = resolveLinks ? capDirReal : capDirResolved;
    const relative = path.relative(base, resolved);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const dateStr = new Date().toISOString().slice(0, 10);
  let capPath = state.capsule_path;
  if (capPath) {
    const resolved = path.resolve(String(capPath));
    const contained = isWithinCapsules(resolved)
      && (!existsSync(resolved) || isWithinCapsules(resolved, true));
    if (!contained) {
      logErr(root, `outside capsule state path refused: ${inert(capPath, 300)}`);
      capPath = null;
    } else {
      capPath = resolved;
    }
  }
  if (capPath && !existsSync(capPath)) {
    // Pointed-to capsule vanished (external delete / archive pass). Recreating
    // silently would erase the session's history unaudited.
    logErr(root, `active capsule missing at ${capPath} — recreating fresh; prior history lost`);
    capPath = null;
  }
  if (!capPath) {
    capPath = path.join(capDir, `${dateStr}-auto-${capsuleSid}.md`);
  }

  // Only a real operator utterance establishes the objective. A claim identifies
  // a row, not what the operator intended to accomplish. When no objective was
  // captured, say so explicitly.
  const humanRequest = (latestRequest && !isInjectionEcho(latestRequest))
    ? latestRequest : null;
  const rowIds = [...claimedRows].map((r) => r.slice(0, 8)).join(', ');
  const unknownObjective = claimedRows.size
    ? `Unknown: no operator objective was captured; claimed row id(s) ${rowIds} were observed.`
    : 'Unknown: no operator objective was captured in this Stop delta.';
  const objective = humanRequest || unknownObjective;

  // The transcript has no trustworthy structured "waiting on" event. Tool
  // errors are possible blockers, but even then their pending status is unknown.
  // State that uncertainty instead of encoding YAML null ("nothing is pending").
  const waitingOn = errors.length
    ? `Unknown: ${errors.length} captured tool error(s) may be pending; inspect Historical-Errors.`
    : 'Unknown: this Stop delta did not capture whether anything is pending.';

  // A next action comes only from structured evidence. Assistant prose remains
  // reference material in the body; truncating it into this field would turn a
  // fragment into an instruction.
  const nextValid = claimedRows.size
    ? `Re-verify claimed row(s) ${rowIds} against the live memory, then continue that claimed work.`
    : 'No concrete next action was captured in this Stop delta.';

  function skeleton() {
    return `---
id: ${dateStr}-auto-${capsuleSid}
parent_capsule_id: null
status: active
objective: ${JSON.stringify(objective)}
waiting_on: ${JSON.stringify(waitingOn)}
resume_trigger: compact
expires: null
trigger: stop-delta
next_valid_action: ${JSON.stringify(nextValid)}
success_criteria: []
tags: [capsule, autosave]
created_at: ${new Date().toISOString()}
resolved_at: null
${framingFrontmatter()}
---

> [!info] [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.
${framingBanner('> ')}

${CAPSULE_SECTIONS.map(({ title, anchor }) => `## ${title}\n${anchor}`).join('\n\n')}
`;
  }

  // AUDIT: the stop writer is a document transformer. It must preserve body
  // sections it does not own while applying anchored changes to owned fields.
  let doc = existsSync(capPath)
    ? unsafeRawCapsuleDocument(
      capPath,
      'stop writer preserves unowned capsule body sections during anchored mutation',
    )
    : skeleton();

  const effectsSection = locateCapsuleSection(doc, 'effects');
  const priorEffects = new Map((effectsSection ? doc.slice(effectsSection.start, effectsSection.end) : '')
    .split(/\r?\n/).map(parseSideEffectRow).filter(Boolean).map((row) => [row.op, row]));
  const priorByTool = new Map();
  for (const row of priorEffects.values()) {
    if (row.outcome !== 'requested') continue;
    const toolOp = row.kind.replace(/^sidechain:/, '') === 'shell' ? row.op.replace(/#\d+$/, '') : row.op;
    // Index exact IDs too: a literal tool ID may itself end in a segment suffix.
    for (const key of new Set([toolOp, row.op])) {
      if (!priorByTool.has(key)) priorByTool.set(key, new Set());
      priorByTool.get(key).add(row.op);
    }
  }
  // Pair against the same resolved document that the merge will update.
  const priorRequested = new Set(priorByTool.keys());
  const eligibleResults = toolResults.filter(({ tool_use_id }) => effectsByTool.has(tool_use_id)
    || (!seenCalls.has(tool_use_id) && priorRequested.has(tool_use_id)))
    .map((result) => {
      const text = resultText(resultContents.get(result));
      return { ...result, evidence: resultEvidence(text), text: text.slice(0, 4000) };
    });
  resultContents.clear();
  const deltaSig = deltaSignature(eligibleResults);
  if (deltaSig === state.last_delta_sha) {
    writeState(stateFile, { ...state, offset: size });
    outcome = 'noop:no-delta';
    process.exit(0);
  }
  for (const result of eligibleResults) {
    const candidates = effectsByTool.get(result.tool_use_id) ?? priorByTool.get(result.tool_use_id);
    for (const op of candidates || []) {
      if (effectCalls.get(op)?.earlierSegment) continue;
      const interrupted = /timeout|timed out|interrupted|aborted|cancelled|connection|ECONNRESET/i.test(result.text);
      effectResults.set(op, { ...result, failed: result.is_error && !interrupted });
    }
  }

  // The shared row key ignores list markers and volatile HH:MM stamps, so
  // replaying a span at another wall-clock minute cannot duplicate its rows.
  function mergeUnder(definition, bullets, keyFn = capsuleRowKey, replace = false) {
    if (!bullets.length) return;
    const { anchor } = definition;
    const section = locateCapsuleSection(doc, definition);
    if (!section || section.anchorAt === null) {
      // Hand-edited capsule without anchors: leaving it alone is right, but the
      // offset still advances — these bullets never land anywhere else, so the
      // drop must be visible.
      logErr(root, `anchor ${anchor} missing in ${path.basename(capPath)} — ${bullets.length} bullet(s) NOT merged (hand-edited capsule?)`);
      return;
    }
    if (!section.hasHeading) {
      logErr(root, `anchor ${anchor} has no section heading in ${path.basename(capPath)} — merging under anchor`);
    }
    if (replace) {
      const replacements = new Map(bullets.map((row) => [keyFn(row), row]));
      const original = doc.slice(section.start, section.end);
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      let matched = false;
      const matchedKeys = new Set();
      const lines = original.split(/\r?\n/).map((row) => {
        const key = keyFn(row);
        if (!replacements.has(key)) return row;
        const fresh = replacements.get(key);
        matchedKeys.add(key);
        matched = true;
        return fresh;
      });
      if (matched) doc = doc.slice(0, section.start) + lines.join(eol) + doc.slice(section.end);
      bullets = [...replacements].filter(([key]) => !matchedKeys.has(key)).map(([, row]) => row);
      if (!bullets.length) return;
    }
    const currentSection = locateCapsuleSection(doc, definition);
    const existing = doc.slice(currentSection.start, currentSection.end).split(/\r?\n/)
      .filter((row) => row.trim() && row.trim() !== anchor);
    const existingNorm = new Set(
      existing.map(keyFn).filter(Boolean),
    );
    const fresh = bullets.filter((bullet) => {
      const key = keyFn(bullet);
      if (existingNorm.has(key)) return false;
      existingNorm.add(key);
      return true;
    });
    if (!fresh.length) return;
    const body = doc.slice(currentSection.start, currentSection.end);
    const eol = body.includes('\r\n') ? '\r\n' : '\n';
    if (replace) {
      // Side effects are chronological history: append after all existing rows.
      // A nested heading immediately before the next anchor belongs to that
      // anchor's section for insertion, even though our read window includes it.
      const nextHeading = /(?:^|\r?\n)#{1,6}[ \t]+[^\r\n]*(?:\r?\n[ \t]*)*$/.exec(body);
      if (nextHeading && /^\s*<!-- swe:[a-z]+ -->/.test(doc.slice(currentSection.end))) {
        const insertAt = currentSection.start + nextHeading.index;
        doc = doc.slice(0, insertAt) + eol + fresh.join(eol) + eol + doc.slice(insertAt);
        return;
      }
      const content = body.trimEnd();
      const insertAt = currentSection.start + content.length;
      doc = doc.slice(0, insertAt) + eol + fresh.join(eol) + eol + eol + doc.slice(currentSection.end);
    } else {
      const insertAt = currentSection.anchorAt + anchor.length;
      doc = doc.slice(0, insertAt) + eol + fresh.join(eol) + doc.slice(insertAt);
    }
  }

  // Legacy untagged rows are assistant claims. Preserve outer speaker tags:
  // an assistant quoting a tag must never suppress that speaker's own row.
  const doneKey = (row) => {
    const key = capsuleRowKey(row);
    return !key || DONE_TAG.test(key)
      ? key : `[ASSISTANT] ${key}`;
  };
  const ts = new Date().toISOString().slice(11, 16);
  // Speaker-tagged utterances land under Done — a sweep can grep `[OPERATOR]` there.
  // Autosaves store accepted speech newest-first; readers preserve file order.
  const bulletsBySection = {
    done: utterances.slice().reverse().map(({ row }) => `- ${ts} ${row}`),
    files: [
      ...[...filesModified].map((f) => `- MODIFIED ${f}`),
      ...[...filesRead].filter((f) => !filesModified.has(f)).map((f) => `- read ${f}`),
    ],
    errors: errors.map((e) => `- ${ts} ${e} → (unresolved at capture; check next Done bullet)`),
    rows: [...claimedRows].map((r) => `- ${r} (claimed this session — re-verify against memory at reinject)`),
  };

  const updates = new Map(effectCalls);
  for (const [op, result] of effectResults) {
    if (!updates.has(op) && priorEffects.has(op)) updates.set(op, { ...priorEffects.get(op), position: result.position });
  }
  const ordered = [...updates.values()].sort((a, b) => a.position - b.position);
  // Prior rows are updates to recorded history, never part of the new-row cap.
  const newCalls = ordered.filter((call) => !priorEffects.has(call.op));
  const retainedNew = new Set(newCalls.slice(-24).map((call) => call.op));
  if (newCalls.length > 24) logErr(root, `side-effects: ${newCalls.length - 24} rows not recorded in this delta (cap 24)`);
  const effectRows = ordered.filter((call) => priorEffects.has(call.op) || retainedNew.has(call.op)).map((call) => {
    const result = effectResults.get(call.op);
    const prior = priorEffects.get(call.op);
    // A replayed call without a new result must not erase an observed outcome.
    if (!result && prior) return formatSideEffectRow(prior);
    const evidence = result?.evidence;
    const structuredId = evidence?.id;
    const extracted = structuredId || ID_URL.exec((result?.text || '').slice(0, 4000))?.[0];
    const id = extracted ? storedResultId(extracted) : call.id;
    const kind = call.kind.replace(/^sidechain:/, '');
    const check = result?.failed ? 'see Historical-Errors' : kind === 'shell' ? SHELL_CHECK
      : kind === 'SendMessage' ? 'confirm receipt with the recipient before any resend'
      : id !== 'none' ? `read back by id with a read tool on ${kind.split('__')[1]}; never re-run ${kind}`
        : 'no id: ask the operator before any retry';
    return formatSideEffectRow({ ...call, id, check: storedData(check, 500),
      outcome: call.earlierSegment ? 'unknown' : !result ? 'requested' : result.failed ? 'failed' : structuredId && !result.is_error && !evidence.unclean ? 'confirmed' : 'unknown' });
  });
  for (const definition of CAPSULE_SECTIONS) {
    if (definition.key !== 'effects') {
      mergeUnder(definition, bulletsBySection[definition.key] || [], definition.key === 'done' ? doneKey : capsuleRowKey);
      continue;
    }
    // Earlier merges can shift offsets; locate again before restoring the anchor.
    const currentEffects = locateCapsuleSection(doc, definition);
    if (effectRows.length && currentEffects && currentEffects.anchorAt === null) {
      const eol = /\r\n|\n|\r/.exec(doc)?.[0] || '\n';
      doc = doc.slice(0, currentEffects.start) + eol + definition.anchor + doc.slice(currentEffects.start);
    }
    if (effectRows.length && !currentEffects) {
      // Upgrade older capsules in place without reordering their other sections.
      const gates = locateCapsuleSection(doc, 'gates');
      const at = gates?.headingAt ?? gates?.anchorAt ?? doc.length;
      const eol = /\r\n|\n|\r/.exec(doc)?.[0] || '\n';
      const before = doc.slice(0, at);
      const gap = before.endsWith(eol + eol) ? '' : before.endsWith(eol) ? eol : eol + eol;
      doc = before + gap + `${gates?.headingAt != null ? /^#+/.exec(doc.slice(gates.headingAt))[0] : '##'} ${definition.title}${eol}${definition.anchor}${eol}${eol}` + doc.slice(at);
    }
    mergeUnder(definition, effectRows, effectKey, true);
  }

  // Refresh live frontmatter fields. objective moves only on a real operator
  // utterance (apart from healing the legacy placeholder), while next_valid_action
  // is refreshed from structured evidence or an explicit no-action marker.
  // Contract fields are touched ONLY on the writer's own autosave capsules (an
  // exact `autosave` tag plus trigger `stop-delta`) — deliberate/curated capsules
  // own their frontmatter outright. Body bullets can never confer ownership.
  const autosaveTag = (scalar(doc, 'tags') || '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((tag) => tag.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .includes('autosave');
  const writerOwnedAutosave = autosaveTag
    && (scalar(doc, 'trigger') || '').toLowerCase() === 'stop-delta';
  if (writerOwnedAutosave) {
    if (humanRequest) {
      doc = doc.replace(/^objective: .*$/m, `objective: ${JSON.stringify(objective)}`);
    } else {
      // Heal writer-owned autosaves created by the old skeleton without
      // overwriting a meaningful objective retained from an earlier turn.
      doc = doc.replace(
        `objective: ${JSON.stringify('In-flight work (auto-captured; see latest session log)')}`,
        `objective: ${JSON.stringify(objective)}`,
      );
    }
    // In the capsule schema, unquoted null means "nothing is pending." The old
    // autosave never knew that, so migrate it to an honest unknown marker.
    doc = doc.replace(
      /^waiting_on:[ \t]*(?:null|~)[ \t]*$/mi,
      `waiting_on: ${JSON.stringify(waitingOn)}`,
    );
    doc = doc.replace(/^next_valid_action: .*$/m, `next_valid_action: ${JSON.stringify(nextValid)}`);
  }

  // Validate the exact final document, after every merge and frontmatter
  // refresh. Problems, malformed results, and thrown exceptions are logged, but
  // the snapshot still writes: a Stop hook must always fail open.
  if (validateCapsuleText) {
    try {
      const validation = validateCapsuleText(doc);
      if (!validation || !Array.isArray(validation.problems)) {
        throw new TypeError('validateCapsuleText() returned an unexpected result');
      }
      if (validation.problems.length) {
        logErr(root, `capsule validation reported ${validation.problems.length} problem(s); write continues fail-open: ${validation.problems.join(' | ').slice(0, 1200)}`);
      }
    } catch (e) {
      logErr(root, `capsule validation threw; write continues fail-open: ${e?.stack || e}`);
    }
  }

  // Write the capsule. tmp+rename first; if rename can't land (AV lock etc.),
  // fall back to a direct write — non-atomicity beats data loss. If NOTHING
  // lands, exit WITHOUT advancing state so next turn retries this same delta.
  const tmp = capPath + '.tmp';
  let committed = false;
  let staged = false;
  try {
    writeFileSync(tmp, doc);
    staged = true;
  } catch (e) {
    logErr(root, `capsule tmp write failed; attempting direct write: ${e?.message || e}`);
  }
  if (staged) {
    try { renameSync(tmp, capPath); committed = true; } catch {
      try { rmSync(capPath, { force: true }); renameSync(tmp, capPath); committed = true; } catch {
        // Direct fallback below also covers a rename failure after the target
        // was removed.
      }
    }
  }
  if (!committed) {
    try { writeFileSync(capPath, doc); committed = true; } catch (e3) {
      logErr(root, `capsule write failed (tmp+rename AND direct): ${e3?.message || e3} — state NOT advanced, will retry next turn`);
    }
  }
  try { rmSync(tmp, { force: true }); } catch {}
  if (!committed) { outcome = 'error:write-failed'; process.exit(0); }

  // Pointer: aigent-OS is single-operator, so the pointer always lives at
  // BODY_STATE.json's state.last_capsule — a COMPATIBILITY hint for orientation
  // tooling only. Resume itself reads the newest valid capsule by date and never
  // relies on this file, so there is no guard to reconcile here: every worker
  // that wins the lock above simply stamps its own capsule, unconditionally.
  const pointer = {
    id: path.basename(capPath, '.md'),
    path: path.relative(root, capPath).replace(/\\/g, '/'),
    // Read from the exact final document so a retained objective on a rolling
    // autosave cannot be replaced in the pointer by this delta's unknown marker.
    objective: scalar(doc, 'objective') || objective,
    status: 'active',
    created_at: new Date().toISOString(),
    trigger: 'stop-delta',
    session_id: sid,
  };
  try {
    // Lock-serialized read-modify-write. The plain read-mutate-write this
    // replaced could lose the whole update: a sibling session (or the curated
    // close writer) reading BODY_STATE between our read and our write would
    // commit its own copy over ours, and the pointer would silently be one
    // capsule behind with nothing anywhere recording that it happened.
    const bsPath = path.join(MEM, 'BODY_STATE.json');
    let hadState = true;
    atomicUpdateJson(bsPath, (bs) => {
      if (!bs?.state) { hadState = false; return null; }
      bs.state.last_capsule = { ...bs.state.last_capsule, ...pointer };
      return bs;
    });
    if (!hadState) {
      logErr(root, 'BODY_STATE.json has no .state — capsule pointer not updated (compat hint only; resume is unaffected)');
    }
  } catch (e) {
    logErr(root, `BODY_STATE pointer update failed: ${e?.message || e}`);
  }

  writeState(stateFile, { offset: size, capsule_path: capPath, last_delta_sha: deltaSig });
  outcome = 'flushed';
} catch (e) {
  outcome = 'error:worker';
  logErr(workerRoot, `worker: ${e?.stack || e}`);
} finally {
  if (lockFd !== null) { try { closeSync(lockFd); } catch {} }
  if (lockPath) { try { rmSync(lockPath, { force: true }); } catch {} }
}
process.exit(0);
}

// Atomic-ish JSON state write (tmp+rename, direct-write fallback) — the same
// discipline as the capsule doc; a torn state file causes duplicate-merge noise.
// Every receipt leaves here carrying WRITER_IDENTITY; callers cannot omit it.
function writeState(file, obj) {
  const stamped = { ...obj, ...WRITER_IDENTITY };
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(stamped, null, 1));
  try { renameSync(tmp, file); } catch {
    try { rmSync(file, { force: true }); renameSync(tmp, file); } catch {
      try { writeFileSync(file, JSON.stringify(stamped, null, 1)); rmSync(tmp, { force: true }); } catch { /* next read falls back to defaults */ }
    }
  }
}
