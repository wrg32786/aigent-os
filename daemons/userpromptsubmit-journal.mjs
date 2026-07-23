#!/usr/bin/env node
// userpromptsubmit-journal.mjs — zero-leak leg: write-ahead utterance journal.
// UserPromptSubmit fires BEFORE the model sees the prompt — this leg appends the
// RAW prompt to <memRoot>/runtime/utterance-journal.jsonl synchronously, so
// nothing counts as "heard" until it is on disk (write-ahead-log semantics, a
// capture-at-landing pattern). Closes the crash window: a crash between
// prompt-submit and Stop no longer loses the operator's words.
//
// CRITICAL: UserPromptSubmit stdout is INJECTED into the turn's context — this
// hook must never print. Fail open (exit 0 always); real failures append to
// <memRoot>/.daemon-errors.log (fail loud — never silent).
//
// Kill-switch: LIFECYCLE_KILL_JOURNAL=1. Rotation: file larger than
// LIFECYCLE_JOURNAL_MAX_BYTES (default 16 MiB) rolls to a dated sidecar first —
// the journal is append-only forever otherwise.

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { seatOf, memRoot, logErr, readStdin } from './lifecycle-common.mjs';

const MAX_BYTES = Number(process.env.LIFECYCLE_JOURNAL_MAX_BYTES) || 16 * 1024 * 1024;

try {
  if (process.env.LIFECYCLE_KILL_JOURNAL === '1') process.exit(0);
  // WAL discipline: a prompt that can't be journaled must never vanish without
  // a trace — every drop path below logs before exiting.
  const raw = readStdin();
  if (raw === null) {
    logErr('', 'userpromptsubmit-journal', 'stdin read THREW — a prompt may be lost unjournaled');
    process.exit(0);
  }
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {
    logErr('', 'userpromptsubmit-journal', 'stdin JSON parse failed — a prompt may be lost unjournaled');
    process.exit(0);
  }
  const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
  if (!root) {
    logErr('', 'userpromptsubmit-journal', 'no root resolvable (no AIGENT_ROOT / CLAUDE_PROJECT_DIR / payload.cwd) — a prompt may be lost unjournaled');
    process.exit(0);
  }
  const seat = seatOf(root); // single-operator default 'operator'; AIGENT_SEAT_ID override for forks
  // Non-string prompt (structured content): journal its JSON form rather than
  // dropping — capture-at-landing means capture whatever landed.
  const prompt = typeof payload.prompt === 'string' ? payload.prompt
    : ('prompt' in payload && payload.prompt != null ? JSON.stringify(payload.prompt) : '');
  if (!prompt) process.exit(0); // no prompt key at all — benign hook noise

  // Codex finding #23: raw prompts are as sensitive as anything in the vault —
  // the journal directory and file get owner-only mode, not whatever the
  // ambient umask leaves them at. mode on mkdirSync/appendFileSync only takes
  // effect when the path is CREATED, so an already-existing dir/file (e.g. one
  // written before this fix shipped) is chmod'd unconditionally below too —
  // self-healing on the next hook firing instead of staying insecure forever.
  // Best-effort: chmod has no real analog on Windows/NTFS, so failures there
  // are swallowed rather than losing a prompt over a permissions no-op.
  const dir = path.join(memRoot(root), 'runtime');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* e.g. Windows: no POSIX mode bits */ }
  const file = path.join(dir, 'utterance-journal.jsonl');
  // Rotation: only the missing-file case is silent; a rename that fails on an
  // oversize journal is a real signal (unbounded growth otherwise).
  if (existsSync(file)) {
    try {
      if (statSync(file).size > MAX_BYTES) {
        const rotated = path.join(dir,
          `utterance-journal-${new Date().toISOString().slice(0, 10)}-${process.pid}.jsonl`);
        renameSync(file, rotated);
        try { chmodSync(rotated, 0o600); } catch { /* best-effort, see above */ }
      }
    } catch (e) {
      logErr(root, 'userpromptsubmit-journal', `rotation failed (${e?.message || e}) — journal will keep growing; prompt still appended`);
    }
  }

  // RAW and full — truncation here would defeat the WAL. The capsule carries
  // the tagged/bounded rendering; the journal carries the truth.
  appendFileSync(file, JSON.stringify({
    ts: new Date().toISOString(),
    sid: String(payload.session_id || ''),
    seat,
    source: 'prompt',
    prompt,
  }) + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort, see above */ }
} catch (e) {
  logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', 'userpromptsubmit-journal', `${e?.stack || e}`);
}
process.exit(0);
