// stop-writer.receipt-identity.test.mjs — a receipt names the instrument that wrote it.
//
// Real-glue: runs the REAL stop-capsule-writer worker over a real transcript
// delta in a temp seat, then reads the RECEIPT (memory/runtime/stop-writer/
// <sid>.json), not the capsule. No mocks.
//
// WHY (board d185aeea, split from d25a884e by ruling 2026-08-02): receipts
// carried only {offset, capsule_path, last_delta_sha}. Diagnosing whether a
// live specimen fired through a fixed or unfixed writer took THREE instruments
// (hook grep across vaults, git ancestry, mtime-vs-commit-time) when one
// receipt field answers it in one read. The stamp identifies the BYTES that
// ran, not the tree they sat in: committed-tree-is-not-the-running-tree.
//
// CONTRACT UNDER TEST: every receipt write carries
//   writer_sha256: first 16 hex of sha256 over the writer's own file bytes
//   writer_mtime:  ISO mtime of the writer file at spawn
// and the stamp DISCRIMINATES: different writer bytes yield a different stamp.
//
// Run: node daemons/tests/stop-writer.receipt-identity.test.mjs
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  cpSync, appendFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS = path.join(HERE, '..');
const DAEMON = path.join(DAEMONS, 'stop-capsule-writer.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
};

const sha16 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

// Builds a temp seat, returns handles so a case can run the writer more than
// once against the same seat (the repeat-delta receipt path needs that).
function makeSeat(prefix) {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(base, 'test-seat');
  mkdirSync(path.join(root, 'memory', 'capsules'), { recursive: true });
  mkdirSync(path.join(root, 'memory', 'runtime', 'stop-writer'), { recursive: true });
  writeFileSync(path.join(root, 'memory', 'BODY_STATE.json'), JSON.stringify({ state: {} }));
  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(transcript, '');
  return { base, root, transcript };
}

const DELTA = (tag) => [
  JSON.stringify({ type: 'user', message: { content: 'ship the receipt identity stamp' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'did the thing; delta ' + tag }] } }),
].join('\n') + '\n';

function runWriter(seat, sid, daemon = DAEMON) {
  execFileSync(process.execPath, [daemon, '--worker',
    JSON.stringify({ __root: seat.root, session_id: sid, transcript_path: seat.transcript })], { encoding: 'utf8' });
  return JSON.parse(readFileSync(
    path.join(seat.root, 'memory', 'runtime', 'stop-writer', `${sid}.json`), 'utf8'));
}

console.log('stop-writer receipt identity');

// ── PRESENCE + IDENTITY: the stamp is the live writer's own bytes ────────────
{
  const seat = makeSeat('rid-');
  appendFileSync(seat.transcript, DELTA('one'));
  const receipt = runWriter(seat, 'rid-presence');
  check('receipt carries writer_sha256 (16 hex)',
    /^[0-9a-f]{16}$/.test(receipt.writer_sha256 || ''), `writer_sha256 was ${receipt.writer_sha256}`);
  check('receipt carries a parseable writer_mtime',
    !Number.isNaN(Date.parse(receipt.writer_mtime || '')), `writer_mtime was ${receipt.writer_mtime}`);
  check('writer_sha256 equals an independent hash of the writer file (not a constant)',
    receipt.writer_sha256 === sha16(DAEMON),
    `receipt ${receipt.writer_sha256} vs file ${sha16(DAEMON)}`);

  // ── REPEAT-DELTA PATH: the early-exit receipt write stamps too ─────────────
  appendFileSync(seat.transcript, DELTA('one')); // identical delta content: same delta sig
  const receipt2 = runWriter(seat, 'rid-presence');
  check('the repeat-delta (same-sig) receipt write carries the stamp',
    receipt2.writer_sha256 === sha16(DAEMON), `writer_sha256 was ${receipt2.writer_sha256}`);
  check('NEG: same writer bytes twice yields the same stamp',
    receipt.writer_sha256 === receipt2.writer_sha256,
    `${receipt.writer_sha256} vs ${receipt2.writer_sha256}`);
  rmSync(seat.base, { recursive: true, force: true });
}

// ── DISCRIMINATION: two writer versions yield two different stamps ──────────
// Mutate a COPY of the whole daemons dir (relative imports must resolve);
// the live tree is never touched.
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'rid-sandbox-'));
  cpSync(DAEMONS, path.join(sandbox, 'daemons'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}tests`) && !src.includes('node_modules'),
  });
  const mutant = path.join(sandbox, 'daemons', 'stop-capsule-writer.mjs');
  appendFileSync(mutant, '\n// version-marker: rid discrimination vector\n');

  const seat = makeSeat('rid-mut-');
  appendFileSync(seat.transcript, DELTA('two'));
  const receipt = runWriter(seat, 'rid-discriminate', mutant);
  check('a byte-different writer stamps a DIFFERENT writer_sha256',
    /^[0-9a-f]{16}$/.test(receipt.writer_sha256 || '') && receipt.writer_sha256 !== sha16(DAEMON),
    `mutant stamped ${receipt.writer_sha256}, live file is ${sha16(DAEMON)}`);
  check('and the mutant stamp equals an independent hash of the mutant bytes',
    receipt.writer_sha256 === sha16(mutant),
    `receipt ${receipt.writer_sha256} vs mutant file ${sha16(mutant)}`);
  rmSync(seat.base, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall green' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
