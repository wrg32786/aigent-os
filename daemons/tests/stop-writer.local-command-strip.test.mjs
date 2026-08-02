// stop-writer.local-command-strip.test.mjs — harness output is not a human objective.
//
// Real-glue: runs the REAL stop-capsule-writer worker over a real transcript
// delta in a temp seat, exactly as capsule-content-gate.test.mjs does. No mocks
// and no reimplementation of the strip — a test that re-derives the regex would
// pass against a broken writer.
//
// LIVE SPECIMEN THIS DEFENDS (metis seat, 2026-08-01):
//   memory/capsules/2026-08-01-auto-metis-03dc0248.md
//   objective: "Login successful. Remote Control disconnected.</local-command-stdout>"
// Command STDOUT — including a literal closing tag — became the seat's stated
// objective. Reproduced byte-exact from the pre-fix strip before this was written.
//
// ROOT CAUSE: the strip matched `<local-command-…>` (opening tag) but not
// `</local-command-…>`, so it removed the opener and left BOTH the content and
// the closer. The content then reads as an ordinary user utterance and becomes
// `humanRequest` -> `objective`.
//
// ⚑ THE ONE-CHARACTER FIX IS A TRAP. Adding `\/?` matches both tags and leaves
// "Login successful. Remote Control disconnected." as the objective — the visible
// artifact disappears and command output silently remains the objective. The
// symptom is invariant under the wrong fix. The strip must be BLOCK-oriented,
// matching the `<system-reminder>` line directly above it in the source.
//
// Run: node daemons/tests/stop-writer.local-command-strip.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, '..', 'stop-capsule-writer.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
};

function runWriter({ sid, userText }) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'lcs-'));
  const root = path.join(base, 'test-seat');
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  mkdirSync(path.join(root, 'memory', 'runtime', 'stop-writer'), { recursive: true });
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({ state: {} }));

  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: userText } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'did the thing; delta ' + sid }] } }),
  ].join('\n') + '\n');

  execFileSync(process.execPath, [DAEMON, '--worker',
    JSON.stringify({ __root: root, session_id: sid, transcript_path: transcript })], { encoding: 'utf8' });

  const state = JSON.parse(readFileSync(path.join(root, 'memory', 'runtime', 'stop-writer', `${sid}.json`), 'utf8'));
  const doc = readFileSync(state.capsule_path, 'utf8');
  rmSync(base, { recursive: true, force: true });
  return doc;
}
const fm = (doc, key) => ((doc.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1] || '');

console.log('stop-writer local-command strip');

// ── THE SPECIMEN ─────────────────────────────────────────────────────────────
{
  const doc = runWriter({
    sid: 'lcs-paired',
    userText: '<local-command-stdout>Login successful. Remote Control disconnected.</local-command-stdout>',
  });
  const obj = fm(doc, 'objective');
  check('a paired local-command block never becomes the objective',
    !/Login successful/.test(obj) && !/local-command/.test(obj),
    `objective was ${obj}`);
  // Nothing human was said, so the writer must fall back to its honest
  // placeholder — NOT invent something. That is the e9253777 contract.
  check('with no human text, the honest placeholder is used instead',
    /Unknown|In-flight work/i.test(obj), `objective was ${obj}`);
}

// ── the closing tag specifically, since that is what leaked ──────────────────
{
  const doc = runWriter({
    sid: 'lcs-closer',
    userText: 'ship the parity fix<local-command-stdout>noise</local-command-stdout>',
  });
  const obj = fm(doc, 'objective');
  check('real user text survives; the block around it does not',
    /ship the parity fix/.test(obj) && !/noise/.test(obj) && !/local-command/.test(obj),
    `objective was ${obj}`);
}

// ── unterminated block: mirrors the <system-reminder> rule on the line above ──
{
  const doc = runWriter({
    sid: 'lcs-unterminated',
    userText: 'do the thing<local-command-stdout>truncated output with no closer',
  });
  const obj = fm(doc, 'objective');
  check('an UNTERMINATED block is swallowed to end-of-text, like system-reminder',
    /do the thing/.test(obj) && !/truncated output/.test(obj) && !/local-command/.test(obj),
    `objective was ${obj}`);
}

// ── ORPHAN TRAILING CLOSER — the Stop writer reads a DELTA WINDOW, so a window
//    that begins mid-block carries the content plus a closer with NO opener.
//    That is byte-identical to the metis specimen, and the paired-block strip
//    does not match it (after `<` it requires `l`, not `/`).
//
//    ⚑ Stripping just the orphan TAG is the same trap as the one-character fix:
//    it would leave "Login successful. Remote Control disconnected." standing as
//    the objective. If the opener fell outside the window then everything before
//    the closer IS block content, so it swallows — the exact mirror of the
//    unterminated-opener rule above. Losing a real objective to the honest
//    placeholder is recoverable; publishing stdout as the objective is not.
{
  const doc = runWriter({
    sid: 'lcs-orphan-closer',
    userText: 'Login successful. Remote Control disconnected.</local-command-stdout>',
  });
  const obj = fm(doc, 'objective');
  check('an orphan CLOSER swallows what precedes it (mirror of the unterminated-opener rule)',
    !/local-command/.test(obj) && !/Login successful/.test(obj), `objective was ${obj}`);
  check('orphan-closer-only input falls through to the honest placeholder',
    /Unknown|In-flight work/i.test(obj), `objective was ${obj}`);
}
{
  const doc = runWriter({
    sid: 'lcs-orphan-closer-tail',
    userText: 'stale stdout</local-command-stdout>now ship the hero fix',
  });
  const obj = fm(doc, 'objective');
  check('text AFTER an orphan closer is real speech and survives',
    /now ship the hero fix/.test(obj) && !/stale stdout/.test(obj) && !/local-command/.test(obj),
    `objective was ${obj}`);
}

// ── NEGATIVE CONTROLS — must hold before AND after. A fix that breaks these is
//    eating real user speech. ─────────────────────────────────────────────────
{
  const doc = runWriter({ sid: 'lcs-neg-plain', userText: 'Fix the SparkLoop pagination and push it' });
  check('NEG: ordinary human text is untouched',
    /Fix the SparkLoop pagination/.test(fm(doc, 'objective')), `objective was ${fm(doc, 'objective')}`);
}
{
  // A human may legitimately TALK about the tag. Over-stripping would eat this.
  const doc = runWriter({
    sid: 'lcs-neg-mentions',
    userText: 'the writer leaks a local-command-stdout marker into the objective, fix it',
  });
  const obj = fm(doc, 'objective');
  check('NEG: prose MENTIONING local-command-stdout is not stripped',
    /fix it/.test(obj) && /leaks a local-command-stdout marker/.test(obj), `objective was ${obj}`);
}

console.log(failures ? `\n${failures} FAILING` : '\nall green');
process.exit(failures ? 1 : 0);
