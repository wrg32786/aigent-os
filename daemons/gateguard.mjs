#!/usr/bin/env node
// gateguard.mjs -- PreToolUse(Edit|Write|Bash) fact-forcing gate.
//
// Guards the most expensive class of agent mistake: confidently mutating the WRONG
// file. Not a bug in the edit, a bug in the target -- the agent drifts into an
// adjacent file that looks like the goal, edits it correctly, and reports success.
// Nothing downstream catches that, because every individual step was valid.
//
// The mechanism is a one-time gate per target. The FIRST Edit/Write of a given file
// in a session is denied with a short fact checklist: name what imports it, name
// what the change affects, and quote the instruction being acted on. The agent
// presents those facts and retries; the retry passes. Destructive Bash commands get
// the same treatment keyed per command, plus a rollback line. The cost is one
// forced pause per file; the thing it buys is that the target is named out loud
// before it is mutated.
//
// OFF BY DEFAULT. A gate that denies the first touch of every file is a real change
// in how a session feels, so it ships inert and the operator opts in:
//   AIGENT_GATEGUARD=enforce   (or =on)   enable the gate
//   AIGENT_GATEGUARD unset/off/0/false    exit immediately, zero behavior change
// Wired into settings.json.template so enabling it is one environment variable, not
// a settings edit. This is the opt-in half of the repo's suggest-don't-block
// doctrine (model-tier-guard.mjs makes the same split, defaulting the other way
// because its per-dispatch advisory is rare enough to be signal rather than noise).
//
// STATE: one zero-byte marker file per gated target under
// <memRoot>/runtime/gateguard/<session>/. First-touch is decided by an atomic
// exclusive create ('wx'), so concurrent tool calls can never both see "first" and
// there is no read-modify-write race. A new session id means a new directory, which
// is what makes the gate per-session without any expiry bookkeeping.
//
// INVARIANT: FAIL OPEN. Any error, unwritable vault, unparseable payload, or
// unexpected shape exits 0 (allow). This hook must never be the reason a session
// cannot make progress.

import { mkdirSync, openSync, closeSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  inert, memRoot as resolveMemRoot, readStdin, logErr,
} from './lifecycle-common.mjs';

const SESSION_DIR_TTL_MS = 24 * 60 * 60 * 1000;

export function isEnabled(env = process.env) {
  const v = String(env.AIGENT_GATEGUARD || '').trim().toLowerCase();
  return v === 'enforce' || v === 'on' || v === '1' || v === 'true';
}

function hash16(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

// Destructive shapes worth a rollback plan before they run. Deliberately narrow:
// every pattern here either deletes data or rewrites history irreversibly.
export function isDestructiveBash(command) {
  const cmd = String(command || '');
  if (/\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/.test(cmd)) return true;
  if (/\brm\s+(?:--recursive\s+--force|--force\s+--recursive)\b/.test(cmd)) return true;
  if (/\bgit\b.*\breset\b.*--hard\b/.test(cmd)) return true;
  if (/\bgit\b.*\bpush\b.*--force\b/.test(cmd) && !/--force-with-lease\b/.test(cmd)) return true;
  if (/\bgit\b.*\bclean\b.*-[a-zA-Z]*f/.test(cmd)) return true;
  if (/\b(?:drop\s+table|delete\s+from|truncate)\b/i.test(cmd)) return true;
  if (/\bdd\s+if=/.test(cmd)) return true;
  return false;
}

// Read-only git is how an agent GATHERS the facts this gate asks for. Gating it
// would make the checklist impossible to satisfy without tripping the gate again.
export function isReadOnlyGit(command) {
  return /^git\s+(?:status|diff(?:\s+--name-only|\s+--name-status)?|log(?:\s+--oneline|\s+--max-count=\d+)*|branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD)\s*$/
    .test(String(command || '').trim());
}

// Never gate the settings files that wire this hook: denying an edit to them would
// leave an operator unable to turn the gate off through the normal path.
export function isExemptPath(filePath) {
  return /\.claude[/\\]settings.*\.json$/.test(String(filePath || ''));
}

// Atomic first-touch test. Exclusive create succeeds exactly once per key; every
// later call (and any failure to create the marker at all) reads as "not first",
// which is the fail-open direction.
function claimFirstTouch(dir, key) {
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(path.join(dir, hash16(key)), 'wx'));
    return true;
  } catch {
    return false;
  }
}

// Bounded housekeeping: drop session directories older than a day so the marker
// tree cannot grow without limit in a long-lived vault.
function pruneStaleSessions(baseDir, now = Date.now()) {
  try {
    for (const entry of readdirSync(baseDir)) {
      const full = path.join(baseDir, entry);
      try {
        if (now - statSync(full).mtimeMs > SESSION_DIR_TTL_MS) rmSync(full, { recursive: true, force: true });
      } catch { /* a directory that vanished under us needs no pruning */ }
    }
  } catch { /* no base dir yet */ }
}

export function editChecklist(filePath) {
  return `[GateGuard] Before editing path ${inert(filePath)}, present these facts:

1. List the files that import or require this one (use Grep).
2. Name the public functions or exports this change affects.
3. If this file reads or writes data files, show the field names and structure.
4. Quote the instruction you are acting on, verbatim.

Present the facts, then retry the same operation.

(To disable: unset AIGENT_GATEGUARD)`;
}

export function writeChecklist(filePath) {
  return `[GateGuard] Before creating path ${inert(filePath)}, present these facts:

1. Name the file and line that will call this new file.
2. Confirm no existing file already serves this purpose (use Glob).
3. If this file reads or writes data files, show the field names and structure.
4. Quote the instruction you are acting on, verbatim.

Present the facts, then retry the same operation.

(To disable: unset AIGENT_GATEGUARD)`;
}

export function destructiveChecklist() {
  return `[GateGuard] Destructive command. Before running it, present these facts:

1. List the files or data this command will modify or delete.
2. Write the rollback procedure in one line.
3. Quote the instruction you are acting on, verbatim.

Present the facts, then retry the same operation.`;
}

export function firstBashChecklist() {
  return `[GateGuard] Before the first shell command this session, present these facts:

1. The current request, in one sentence.
2. What this specific command verifies or produces.

Present the facts, then retry the same operation.

(To disable: unset AIGENT_GATEGUARD)`;
}

// PreToolUse deny protocol: exit 0 and print the decision object. A non-deny run
// prints nothing at all.
function deny(reason) {
  try {
    writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  } catch { /* nothing printable means the call simply proceeds -- fail open */ }
}

function main() {
  try {
    if (!isEnabled()) return;

    let payload = {};
    try { payload = JSON.parse(readStdin() || '{}'); } catch { /* non-JSON stdin */ }
    const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
    if (!root) return;

    const tool = String(payload.tool_name || '').toLowerCase();
    if (!tool) return;
    const input = (payload.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};

    const base = path.join(resolveMemRoot(root), 'runtime', 'gateguard');
    pruneStaleSessions(base);
    const sessionDir = path.join(base, hash16(payload.session_id || process.env.CLAUDE_SESSION_ID || root));

    if (tool === 'edit' || tool === 'write') {
      const filePath = typeof input.file_path === 'string' ? input.file_path : '';
      if (!filePath || isExemptPath(filePath)) return;
      if (claimFirstTouch(sessionDir, `file:${filePath}`)) {
        deny(tool === 'edit' ? editChecklist(filePath) : writeChecklist(filePath));
      }
      return;
    }

    if (tool === 'bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (!command || isReadOnlyGit(command)) return;
      if (isDestructiveBash(command)) {
        if (claimFirstTouch(sessionDir, `destructive:${command}`)) deny(destructiveChecklist());
        return;
      }
      if (claimFirstTouch(sessionDir, 'bash:session')) deny(firstBashChecklist());
    }
  } catch (e) {
    logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', 'gateguard', `outer: ${e?.stack || e}`);
  }
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  main();
  process.exit(0);
}
