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

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, openSync, readSync,
  closeSync, statSync, renameSync, rmSync, appendFileSync, writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memRoot as resolveMemRoot, crossSessionCuratedAllowed, curatedWindowMs } from './lifecycle-common.mjs';

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
      , '.daemon-errors.log'), `${new Date().toISOString()} [stop-capsule-writer] ${msg}\n`);
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
  const sid = String(payload.session_id || '');
  const transcriptPath = String(payload.transcript_path || '');
  if (!root || !sid) { outcome = 'noop:bad-payload'; process.exit(0); }
  if (!transcriptPath || !existsSync(transcriptPath)) { outcome = 'noop:no-transcript'; process.exit(0); }

  // Content gate — lazy + fail-open, zero deps: the ONE vocabulary for
  // injection-echo/ceremony, shared with capsule-verb's validateCapsuleText.
  // Import failure degrades to pre-gate behavior (logged, never blocks a turn).
  let gate = null;
  try { gate = await import('./capsule-content-gate.mjs'); }
  catch (e) { logErr(root, `content-gate import failed (gate skipped): ${e?.message || e}`); }

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
  const fd = openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(size - state.offset);
  readSync(fd, buf, 0, buf.length, state.offset);
  closeSync(fd);
  const chunk = buf.toString('utf8');

  // ── extract the delta ──────────────────────────────────────────────────────
  const filesRead = new Set();
  const filesModified = new Set();
  const errors = [];
  const claimedRows = new Set();
  const utterances = [];
  let latestRequest = null;
  let lastAssistantText = null;

  // Speaker-aware classification. A close-time sweep can grep [OPERATOR] for
  // unbanked human directives, so [OPERATOR] must be PRECISE — over-tagging agent
  // chatter as [OPERATOR] makes the grep useless. Every bullet gets its true
  // source: RELAY:x for a cross-session relay message (a live multi-agent mesh, if
  // one is wired), PEER:x for a same-harness teammate/subagent envelope
  // ("Another Claude session sent a message: <teammate-message ...>"),
  // INJECT:harness for a harness/supervisor injection (gated centrally in
  // capsule-content-gate.mjs), and OPERATOR only for a genuine human utterance.
  // `human` also gates the objective so it can never be a peer envelope.
  const classify = (s) => {
    const t = s.replace(/\s+/g, ' ').trim(); // collapse first (raw "\n## " would corrupt section parsing)
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
    if (gate && gate.isInjectionEcho(t)) return { who: 'INJECT:harness', human: false, t };
    return { who: 'OPERATOR', human: true, t };
  };
  const tagUtterance = (cl) => {
    if (utterances.length >= 12) return; // bound a paste-bomb turn
    utterances.push(`[${cl.who}] ${cl.t.slice(0, 240)}`);
  };

  // Harness wrapper blocks pollute the objective if left in (reminders are
  // frequently APPENDED after real user text, not prepended).
  const stripMeta = (s) => s
    .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/gi, '')
    .replace(/<local-command-[\s\S]*?>/gi, '')
    .trim();

  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; } // partial trailing lines are normal

    if (ev.type === 'user' && !ev.isMeta) {
      const c = ev.message?.content;
      if (typeof c === 'string') {
        const clean = stripMeta(c);
        if (clean && !clean.startsWith('<')) { const cl = classify(clean); if (cl.human) latestRequest = clean.slice(0, 300); tagUtterance(cl); }
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text) {
            const clean = stripMeta(b.text);
            if (clean && !clean.startsWith('<')) { const cl = classify(clean); if (cl.human) latestRequest = clean.slice(0, 300); tagUtterance(cl); }
          }
          if (b.type === 'tool_result' && b.is_error) {
            const txt = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
            if (txt) errors.push(txt.replace(/\s+/g, ' ').slice(0, 200));
          }
        }
      }
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) lastAssistantText = b.text.trim();
        if (b.type !== 'tool_use') continue;
        const input = b.input ?? {};
        if (b.name === 'Read' || b.name === 'Grep' || b.name === 'Glob') {
          const p = input.file_path || input.path;
          if (p) filesRead.add(String(p));
        } else if (b.name === 'Edit' || b.name === 'Write' || b.name === 'NotebookEdit') {
          if (input.file_path) filesModified.add(String(input.file_path));
        } else if (/(^|_)board_claim$/i.test(String(b.name || '')) && input.task_id) {
          // Generic match on any *_board_claim tool (an optional task-board MCP,
          // whatever it is named) rather than one hardcoded server name.
          claimedRows.add(String(input.task_id));
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
  const dateStr = new Date().toISOString().slice(0, 10);
  let capPath = state.capsule_path;
  if (capPath && !existsSync(capPath)) {
    // Pointed-to capsule vanished (external delete / archive pass). Recreating
    // silently would erase the session's history unaudited.
    logErr(root, `active capsule missing at ${capPath} — recreating fresh; prior history lost`);
    capPath = null;
  }
  if (!capPath) {
    capPath = path.join(capDir, `${dateStr}-auto-${sid.slice(0, 8)}.md`);
  }

  // objective only ever carries a REAL human utterance — the classifier already
  // gates injections; this re-check is defense in depth. When no human spoke this
  // turn, nothing is synthesized: the ownership rule below keeps an existing
  // capsule's objective untouched, and the skeleton default is only ever born at
  // capsule creation.
  const humanRequest = (latestRequest && !(gate && gate.isInjectionEcho(latestRequest)))
    ? latestRequest : null;
  const objective = humanRequest || 'In-flight work (auto-captured; see latest session log)';
  // next_valid_action must carry CONTENT (claimed rows, live assistant state) —
  // templates like "Re-read the active turn state below..." are exactly what
  // capsule-verb's content gate bans; this template must never match it.
  const rowHint = claimedRows.size
    ? `Re-verify claimed row(s) ${[...claimedRows].map((r) => r.slice(0, 8)).join(', ')} against the live memory, then continue that work`
    : 'Re-derive the next action from the live memory (autosave carries deltas only)';
  const nextValid = lastAssistantText
    ? `${rowHint}; last assistant state: ${lastAssistantText.replace(/\s+/g, ' ').slice(0, 180)}`
    : rowHint;

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
id: ${dateStr}-auto-${sid.slice(0, 8)}
parent_capsule_id: null
status: active
objective: ${JSON.stringify(objective)}
waiting_on: null
resume_trigger: compact
expires: null
trigger: stop-delta
definition_hash: ${sha12(objective + nextValid)}
next_valid_action: ${JSON.stringify(nextValid)}
success_criteria: []
tags: [capsule, autosave]
created_at: ${new Date().toISOString()}
resolved_at: null
---

> [!info] [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.

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

  let doc = existsSync(capPath) ? readFileSync(capPath, 'utf8') : skeleton();

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
    mergeUnder(ANCHORS.done, [`- ${ts} ${lastAssistantText.replace(/\s+/g, ' ').slice(0, 240)}`]);
  }

  // Refresh live frontmatter fields — the rolling writer only RAISES content,
  // never downgrades it. objective moves only on a real human utterance, and the
  // contract fields are touched at all ONLY on the writer's own autosave capsules
  // (tags carry `autosave`) — deliberate/curated capsules own their frontmatter
  // outright. Body bullets can never match (always `- `-prefixed) and .replace is
  // leftmost-first so frontmatter wins.
  const docTags = ((doc.match(/^tags:\s*(.+)\s*$/m) || [])[1] || '').toLowerCase();
  if (/\bautosave\b/.test(docTags)) {
    let effObjective = objective;
    if (humanRequest) {
      doc = doc.replace(/^objective: .*$/m, `objective: ${JSON.stringify(objective)}`);
    } else {
      const m = doc.match(/^objective: (.*)$/m);
      if (m) { try { effObjective = JSON.parse(m[1]); } catch { effObjective = m[1]; } }
    }
    doc = doc
      .replace(/^next_valid_action: .*$/m, `next_valid_action: ${JSON.stringify(nextValid)}`)
      .replace(/^definition_hash: .*$/m, `definition_hash: ${sha12(effObjective + nextValid)}`);
  }

  // Write the capsule. tmp+rename first; if rename can't land (AV lock etc.),
  // fall back to a direct write — non-atomicity beats data loss. If NOTHING
  // lands, exit WITHOUT advancing state so next turn retries this same delta.
  const tmp = capPath + '.tmp';
  let committed = false;
  writeFileSync(tmp, doc);
  try { renameSync(tmp, capPath); committed = true; } catch {
    try { rmSync(capPath, { force: true }); renameSync(tmp, capPath); committed = true; } catch {
      try { writeFileSync(capPath, doc); committed = true; rmSync(tmp, { force: true }); } catch (e3) {
        logErr(root, `capsule write failed (tmp+rename AND direct): ${e3?.message || e3} — state NOT advanced, will retry next turn`);
      }
    }
  }
  if (!committed) { outcome = 'error:write-failed'; process.exit(0); }

  // Pointer: aigent-OS is single-operator, so the pointer always lives at
  // BODY_STATE.json's state.last_capsule.
  //
  // FINALIZE-GUARD: if the pointer already aims at a DIFFERENT capsule that is
  // finalize-live (status: active + real waiting_on — the exact predicate an
  // auto-refresh watcher would gate on), the operator deliberately finalized and
  // the pointer must NOT be re-pointed at this session's auto-capsule (whose
  // skeleton waiting_on is null) — that swap strands the session: a watcher reads
  // "not finalized" and refuses to auto-clear forever. The auto-capsule content
  // above still lands; only the pointer move is skipped. The lock self-releases
  // when the fresh session marks the capsule resumed (status != active). Fail-open:
  // any read/parse error falls back to the old re-point behavior.
  function pointerLockedByFinalize() {
    try {
      const cur = JSON.parse(readFileSync(path.join(MEM, 'BODY_STATE.json'), 'utf8'))?.state?.last_capsule;
      if (!cur?.path) return false;
      const curAbs = path.resolve(root, cur.path);
      if (curAbs === path.resolve(capPath)) return false; // same file — frontmatter refresh never touches waiting_on
      const fm = readFileSync(curAbs, 'utf8').split(/^---\s*$/m)[1] || '';
      const status = (fm.match(/^status:\s*(\S+)/m) || [])[1]?.trim() || '';
      const w = ((fm.match(/^waiting_on:\s*(.+)\s*$/m) || [])[1] || '').trim().toLowerCase();
      const waitingReal = !!w && w !== 'null' && w !== '~' && w !== '""' && w !== "''";
      // A deliberate /context-capsule READY capsule can carry waiting_on:null
      // (nothing blocks its resume) yet must NOT be clobbered. Discriminate the
      // disposable auto-writers by the `autosave` TAG: only skeleton() here (and
      // any other auto-writer a fork adds) emits it — hand/close/context-capsule
      // capsules never do. Tag-based covers every future auto-writer by
      // construction; a literal-trigger allowlist would blindside the next one.
      const tags = ((fm.match(/^tags:\s*(.+)\s*$/m) || [])[1] || '').toLowerCase();
      const isAutoSkeleton = /\bautosave\b/.test(tags);
      return status === 'active' && (waitingReal || !isAutoSkeleton);
    } catch { return false; }
  }
  // CURATED-CLOSE PRECEDENCE (the two-writer pointer race): a curated close
  // (trigger curated-close; manual-close accepted as the legacy spelling) stamped
  // for THIS session and finalized inside the race window ALWAYS keeps the
  // pointer — the stop-delta tail of a close sequence (the close-summary turn's
  // own Stop hook, post-close "anything to add" chatter) must never clobber it.
  // WINDOW-BOUNDED (SCW_CURATED_WIN_MS, default 45 min): a session that genuinely
  // RESUMES work after a curated close re-earns its rolling anchor once the
  // window lapses — an unbounded curated freeze would strand the resumed work on
  // a "session complete" anchor. Fail-open on any read/parse error, like every
  // guard in this daemon.
  function curatedPointerWins() {
    try {
      const cur = JSON.parse(readFileSync(path.join(MEM, 'BODY_STATE.json'), 'utf8'))?.state?.last_capsule;
      if (!cur) return false;
      if (cur.trigger !== 'curated-close' && cur.trigger !== 'manual-close') return false;
      const fin = Date.parse(String(cur.finalized_at || ''));
      if (!Number.isFinite(fin)) return false;
      if ((Date.now() - fin) >= curatedWindowMs()) return false;
      if (String(cur.session_id || '') !== sid) {
        // A session that rotated WITHOUT a clear keeps its curated close
        // authoritative — raw equality made the close invisible after rotation and
        // the stop-delta clobbered it every turn. Case-A stays safe: a clear-born
        // session, stale/absent boot evidence, or a consumed (status:resumed)
        // capsule all fall back to the old exclusion. A falsy session_id (the
        // stamper's own no-sid-resolvable branch) is never cross-session eligible —
        // hard reject, as raw !== always did. Window checked above (cheap) before
        // the helper's file reads.
        if (!cur.session_id) return false;
        const capAbs = typeof cur.path === 'string' && cur.path.trim() !== ''
          ? (path.isAbsolute(cur.path) ? cur.path : path.resolve(root, cur.path))
          : null;
        if (!capAbs || !crossSessionCuratedAllowed(MEM, sid, capAbs)) return false;
      }
      return true;
    } catch { return false; }
  }
  const pointer = {
    id: path.basename(capPath, '.md'),
    path: path.relative(root, capPath).replace(/\\/g, '/'),
    objective,
    status: 'active',
    created_at: new Date().toISOString(),
    trigger: 'stop-delta',
    session_id: sid,
  };
  // Distinguish a CLOBBER (this session's skeleton auto-capsule, waiting_on:null —
  // repointing to it would strand a deliberately-finalized pointer) from a
  // legitimate FINALIZE-ADVANCE (the operator finalized THIS session's OWN
  // capsule — waiting_on real — and the pointer SHOULD move to it). The base
  // guard blocks BOTH, freezing the pointer on the previous finalized capsule
  // until a human advances it by hand. Allow the repoint when this session's
  // capsule (the `doc` just written) is itself finalize-live — same
  // status:active + real-waiting_on predicate the guard uses.
  const thisFm = doc.split(/^---\s*$/m)[1] || '';
  const thisStatus = (thisFm.match(/^status:\s*(\S+)/m) || [])[1]?.trim() || '';
  const thisW = ((thisFm.match(/^waiting_on:\s*(.+)\s*$/m) || [])[1] || '').trim().toLowerCase();
  const thisFinalized = thisStatus === 'active' && !!thisW && thisW !== 'null' && thisW !== '~' && thisW !== '""' && thisW !== "''";
  if (curatedPointerWins()) {
    // this session was curated-closed inside the race window — pointer stays on
    // the curated capsule; the rolling auto-capsule content above is still saved
  } else if (pointerLockedByFinalize() && !thisFinalized) {
    // a DIFFERENT capsule is deliberately finalized and this session has NOT
    // finalized its own yet — pointer stays; auto-capsule content already saved
  } else {
    try {
      const bsPath = path.join(MEM, 'BODY_STATE.json');
      const bs = JSON.parse(readFileSync(bsPath, 'utf8'));
      if (bs?.state) {
        bs.state.last_capsule = { ...bs.state.last_capsule, ...pointer };
        writeFileSync(bsPath, JSON.stringify(bs, null, 2));
      } else {
        logErr(root, 'BODY_STATE.json has no .state — capsule pointer not updated (reinject will miss it)');
      }
    } catch (e) {
      logErr(root, `BODY_STATE pointer update failed: ${e?.message || e}`);
    }
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
if (outcome === 'flushed') await launchStopAutofire();
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

async function launchStopAutofire() {
  let root = '';
  let sid = '';
  let lockFd = null;
  let lockFile = null;
  // FAIL-OPEN: the writer contract is fail-open, so this optional tail launch is
  // contained and reports failures through the writer's existing error sink.
  try {
    if (process.env.CAPSULE_VERB_AUTOFIRE !== '1') return;
    const payload = JSON.parse(process.argv[3] || '{}');
    root = String(payload.__root || '');
    sid = String(payload.session_id || '');
    if (!root || !sid) return;

    const memory = memRoot(root);
    const requestFile = path.join(memory, 'runtime', `refresh-request-${sid}.json`);
    if (!existsSync(requestFile)) return;
    const { readRequest } = await import('./refresh-request.mjs');
    const request = readRequest(memory, sid);
    if (!request) throw new Error('refresh request present but unreadable or invalid');
    const expiresMs = Date.parse(request.expires_at);
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return;

    const { homedir } = await import('node:os');
    const home = homedir();
    const stateDir = path.join(home, '.claude', 'ctx-refresh');
    mkdirSync(stateDir, { recursive: true });
    const launchStateFile = path.join(stateDir, `${sid}.state`);
    lockFile = `${launchStateFile}.autofire.lock`;
    const lockDeadline = Date.now() + 1_000;
    while (existsSync(lockFile)) {
      if (Date.now() - statSync(lockFile).mtimeMs > 30_000) {
        rmSync(lockFile, { force: true });
        break;
      }
      if (Date.now() >= lockDeadline) {
        throw new Error('timed out waiting for autofire state lock');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    lockFd = openSync(lockFile, 'wx');

    const launchState = existsSync(launchStateFile)
      ? JSON.parse(readFileSync(launchStateFile, 'utf8'))
      : {};
    if (!launchState || typeof launchState !== 'object' || Array.isArray(launchState)) {
      throw new Error('launch state is not an object');
    }

    let shouldLaunch = request.cycle_id !== launchState.last_autofire_cycle_id;
    if (!shouldLaunch) {
      const pointer = JSON.parse(readFileSync(path.join(memory, 'BODY_STATE.json'), 'utf8'))
        ?.state?.last_capsule ?? null;
      const finalizedAtMs = Date.parse(pointer?.finalized_at);
      const launchedAt = launchState.last_autofire_launched_at;
      const capsulePath = typeof pointer?.path === 'string' && pointer.path.trim() !== ''
        ? (path.isAbsolute(pointer.path) ? pointer.path : path.resolve(root, pointer.path))
        : null;
      shouldLaunch = pointer?.trigger === 'curated-close'
        && Number.isFinite(finalizedAtMs)
        && capsulePath !== null
        && existsSync(capsulePath)
        && typeof launchedAt === 'number'
        && Number.isFinite(launchedAt)
        && finalizedAtMs > launchedAt
        // Same cross-session acceptance as curatedPointerWins / readCuratedPointer —
        // a rotated-but-not-cleared close re-launches the autofire too, instead of
        // waiting out request.expires_at.
        && (pointer.session_id === sid
          || (Boolean(pointer.session_id)
            && (Date.now() - finalizedAtMs) < curatedWindowMs()
            && crossSessionCuratedAllowed(memory, sid, capsulePath)));
    }
    if (!shouldLaunch) return;

    const launchedAt = Date.now();
    const nextState = {
      ...launchState,
      last_autofire_cycle_id: request.cycle_id,
      last_autofire_launched_at: launchedAt,
    };
    writeState(launchStateFile, nextState);
    const recorded = JSON.parse(readFileSync(launchStateFile, 'utf8'));
    if (recorded?.last_autofire_cycle_id !== request.cycle_id
      || recorded.last_autofire_launched_at !== launchedAt) {
      throw new Error('launch state did not persist before spawn');
    }

    const normalizedRoot = path.resolve(root).replace(/\\/g, '/');
    const projectSlug = normalizedRoot.replace(/[^A-Za-z0-9]/g, '-');
    const transcriptPath = String(payload.transcript_path || '')
      || path.join(home, '.claude', 'projects', projectSlug, `${sid}.jsonl`);
    const workerPayload = Buffer.from(JSON.stringify({
      root,
      sid,
      eventId: null,
      transcriptPath,
    }), 'utf8').toString('base64url');
    const sensorPath = path.resolve(path.dirname(SELF), 'ctx-refresh-sensor.mjs');
    const child = spawn(process.execPath, [sensorPath, '--autofire-worker', workerPayload], {
      detached: true,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!child.pid) throw new Error('autofire worker did not receive a process id');
    child.once('error', (error) => {
      logErr(root, `autofire worker error sid=${sid}: ${error?.message || error}`);
    });
    child.unref();
    await new Promise((resolve) => setImmediate(resolve));
  } catch (e) {
    logErr(root, `autofire tail failed sid=${sid}: ${e?.message || e}`);
  } finally {
    if (lockFd !== null) { try { closeSync(lockFd); } catch {} }
    if (lockFd !== null && lockFile) { try { rmSync(lockFile, { force: true }); } catch {} }
  }
}
