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
  inert, memRoot as resolveMemRoot, scalar, unsafeRawCapsuleDocument,
} from './lifecycle-common.mjs';
import { unsafeRawTranscriptDelta } from './raw-acquisitions.mjs';
import { framingFrontmatter, framingBanner } from './memory-hygiene/resume-framing.mjs';

const require = createRequire(import.meta.url);
const { atomicUpdateJson } = require('./memory-hygiene/atomic-state.cjs');

const SELF = fileURLToPath(import.meta.url);

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
  let latestRequest = null;
  let lastAssistantText = null;

  // Persisted capsule bullets are a precursor to later orientation. Reuse the
  // render boundary for its complete control collapse and announced bound, then
  // store the decoded single-line value in the existing capsule schema.
  const storedData = (value, maximum = 240) => JSON.parse(inert(value, maximum));

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
  const tagUtterance = (cl) => {
    if (utterances.length >= 12) return; // bound a paste-bomb turn
    utterances.push(`[${cl.who}] ${storedData(cl.t, 240)}`);
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

  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; } // partial trailing lines are normal
    // JSON primitives and malformed content blocks are valid JSON but not
    // transcript events. Skip them instead of abandoning the entire Stop delta.
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;

    if (ev.type === 'user' && !ev.isMeta) {
      const c = ev.message?.content;
      if (typeof c === 'string') {
        const clean = stripMeta(c);
        if (clean && !clean.startsWith('<')) { const cl = classify(clean); if (cl.human) latestRequest = storedData(cl.t, 300); tagUtterance(cl); }
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            const clean = stripMeta(b.text);
            if (clean && !clean.startsWith('<')) { const cl = classify(clean); if (cl.human) latestRequest = storedData(cl.t, 300); tagUtterance(cl); }
          }
          if (b.type === 'tool_result' && b.is_error) {
            const txt = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content
                  .filter((x) => x && typeof x === 'object'
                    && !Array.isArray(x) && x.type === 'text' && typeof x.text === 'string')
                  .map((x) => x.text).join(' ')
                : '';
            if (txt) errors.push(storedData(txt, 200));
          }
        }
      }
    } else if (ev.type === 'assistant') {
      const content = ev.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          lastAssistantText = storedData(b.text, 240);
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

  const deltaSig = sha12(JSON.stringify({
    r: latestRequest, fr: [...filesRead].sort(), fm: [...filesModified].sort(),
    e: errors, c: [...claimedRows].sort(), a: lastAssistantText?.slice(0, 200) ?? null,
    u: utterances,
  }));
  // SHA-256 dedup: identical delta (a pure-conversation turn) → advance the
  // offset, skip the write.
  if (deltaSig === state.last_delta_sha) {
    writeState(stateFile, { ...state, offset: size });
    outcome = 'noop:no-delta';
    process.exit(0);
  }

  // ── locate or create the operator's ONE active capsule ────────────────────
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

  const ANCHORS = {
    done: '<!-- swe:done -->',
    errors: '<!-- swe:errors -->',
    rejected: '<!-- swe:rejected -->',
    files: '<!-- swe:files -->',
    facts: '<!-- swe:facts -->',
    gates: '<!-- swe:gates -->',
    rows: '<!-- swe:rows -->',
  };

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

## Done (don't redo)
${ANCHORS.done}

## Historical-Errors → Resolutions
${ANCHORS.errors}

## Historical-Rejected-Approaches
${ANCHORS.rejected}

## Files-Read / Files-Modified
${ANCHORS.files}

## Operating-Facts
${ANCHORS.facts}

## Pending-Gates
${ANCHORS.gates}

## Claimed-Rows
${ANCHORS.rows}
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

  // A bullet minus its `- ` prefix and volatile HH:MM stamp — dedup must not be
  // defeated by re-processing a span at a different wall-clock minute (a
  // timestamped duplicate could otherwise reappear after an offset reset).
  const normalize = (b) => b.trim().replace(/^- /, '').replace(/^\d{2}:\d{2} /, '');

  function mergeUnder(anchor, bullets) {
    if (!bullets.length) return;
    const idx = doc.indexOf(anchor);
    if (idx === -1) {
      // Hand-edited capsule without anchors: leaving it alone is right, but the
      // offset still advances — these bullets never land anywhere else, so the
      // drop must be visible.
      logErr(root, `anchor ${anchor} missing in ${path.basename(capPath)} — ${bullets.length} bullet(s) NOT merged (hand-edited capsule?)`);
      return;
    }
    const insertAt = idx + anchor.length;
    const sectionEnd = (() => {
      const rest = doc.indexOf('\n## ', insertAt);
      return rest === -1 ? doc.length : rest;
    })();
    const existingNorm = new Set(
      doc.slice(insertAt, sectionEnd).split('\n').map(normalize).filter(Boolean),
    );
    const fresh = bullets.filter((b) => !existingNorm.has(normalize(b)));
    if (!fresh.length) return;
    doc = doc.slice(0, insertAt) + '\n' + fresh.join('\n') + doc.slice(insertAt);
  }

  const ts = new Date().toISOString().slice(11, 16);
  // Speaker-tagged utterances land under Done — a sweep can grep `[OPERATOR]` there.
  mergeUnder(ANCHORS.done, utterances.map((u) => `- ${ts} ${u}`));
  mergeUnder(ANCHORS.files, [
    ...[...filesModified].map((f) => `- MODIFIED ${f}`),
    ...[...filesRead].filter((f) => !filesModified.has(f)).map((f) => `- read ${f}`),
  ]);
  mergeUnder(ANCHORS.errors, errors.map((e) => `- ${ts} ${e} → (unresolved at capture; check next Done bullet)`));
  mergeUnder(ANCHORS.rows, [...claimedRows].map((r) => `- ${r} (claimed this session — re-verify against memory at reinject)`));
  if (lastAssistantText) {
    mergeUnder(ANCHORS.done, [`- ${ts} ${lastAssistantText}`]);
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
function writeState(file, obj) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  try { renameSync(tmp, file); } catch {
    try { rmSync(file, { force: true }); renameSync(tmp, file); } catch {
      try { writeFileSync(file, JSON.stringify(obj, null, 1)); rmSync(tmp, { force: true }); } catch { /* next read falls back to defaults */ }
    }
  }
}
