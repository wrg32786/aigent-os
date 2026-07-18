#!/usr/bin/env node
// sessionend-flush.mjs — zero-leak leg: final capsule flush on REAL session
// termination. SessionEnd is a distinct platform hook (fires on clear / logout /
// prompt_input_exit / other); Stop does NOT fire on those paths, so without this
// leg a session's final delta dies with the process.
//
// Runs the same stop-capsule-writer worker synchronously — the per-session
// lock serializes against any in-flight Stop write — then journals a
// session-end event line so a journal replay can see where sessions ended and
// whether their last flush landed.
//
// Nobody reads SessionEnd stdout — this leg prints nothing. Fail open (exit 0
// always); failures append to <memRoot>/.daemon-errors.log. The worker honors
// LIFECYCLE_KILL_STOP_WRITER internally. Inner flush budget 5000ms (node
// cold-start is ~1.6s idle, worse under load); this leg never blocks anything,
// so a timeout only costs a false "did not land" log line, but the headroom
// keeps that noise down. Wire at hook timeout ≥8000ms so the outer never
// guillotines the inner (see .claude/settings.json.template and
// docs/zero-leak-flush.md).

import { appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seatOf, memRoot, logErr, readStdin } from './lifecycle-common.mjs';

const STOP_WRITER = join(dirname(fileURLToPath(import.meta.url)), 'stop-capsule-writer.mjs');
// lock-defer is NOT benign here: at SessionEnd there is no next turn to retry —
// we're relying on the concurrent detached Stop worker surviving process
// teardown, which is unconfirmed on Windows. Distinct log below.
const BENIGN = new Set(['flushed', 'noop:no-delta', 'noop:killed']);

try {
  const raw = readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {
    // Root may be recoverable from env even when stdin is garbage — logErr
    // falls back to the env roots internally.
    logErr('', 'sessionend-flush', 'stdin JSON parse failed — session-end flush degraded to env-root only');
  }
  const root = process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
  if (!root) {
    logErr('', 'sessionend-flush', 'no root resolvable (no AIGENT_ROOT / CLAUDE_PROJECT_DIR / payload.cwd) — final flush SKIPPED unrecorded');
    process.exit(0);
  }
  const seat = seatOf(root); // single-operator default 'operator'; AIGENT_SEAT_ID override for forks
  const reason = String(payload.reason || 'unknown');

  let flush = 'error:spawn';
  try {
    const res = spawnSync(process.execPath, [STOP_WRITER, '--worker', JSON.stringify({ ...payload, __root: root })], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    flush = String(res.stdout || '').match(/SWE_OUTCOME:(\S+)/)?.[1]
      ?? (res.error ? `error:${res.error.code || res.error.message}` : `error:exit=${res.status}`);
  } catch (e) {
    flush = `error:${e?.message || e}`;
  }
  if (flush === 'noop:lock-defer') {
    logErr(root, 'sessionend-flush', `lock-defer at session end (reason=${reason}) — relying on the concurrent Stop worker to land the final delta; unconfirmed at teardown`);
  } else if (!BENIGN.has(flush)) {
    logErr(root, 'sessionend-flush', `final flush did not land (${flush}) on reason=${reason} — last delta may be journal-only`);
  }

  // Journal event line — a replay can pair prompts with the session boundary
  // and the fate of its final flush. Tiny; rotation is the prompt journal's job
  // on the next prompt.
  const dir = path.join(memRoot(root), 'runtime');
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, 'utterance-journal.jsonl'), JSON.stringify({
    ts: new Date().toISOString(),
    sid: String(payload.session_id || ''),
    seat,
    source: 'session-end',
    reason,
    flush,
  }) + '\n');
} catch (e) {
  logErr(process.env.AIGENT_ROOT || process.env.CLAUDE_PROJECT_DIR || '', 'sessionend-flush', `outer: ${e?.stack || e}`);
}
process.exit(0);
