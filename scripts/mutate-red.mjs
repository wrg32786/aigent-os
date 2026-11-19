#!/usr/bin/env node
// mutate-red.mjs: prove a check can go red (Law XV) without losing the file.
//
//   node scripts/mutate-red.mjs --file <path> --find <text> --replace <text> [--timeout <sec>] -- <test command...>
//   node scripts/mutate-red.mjs --restore        restore every snapshot a killed run left behind
//
// Runs the test once on the real file (must pass), applies the mutation, runs it
// again (must fail), then restores FROM A BYTE SNAPSHOT and checks the hash. It
// never uses git: `git checkout --` restores the last commit, which silently
// deletes any uncommitted fix in the same file. The snapshot and a
// pending record are written before the mutation, so a run killed mid-test is
// recovered by `--restore`, and a new run on the same file refuses until then.
// The test gets its own timeout, shorter than any outer runner cap, so this
// process always reaches the restore step itself.
//
// Exit 0: green then red (the check can fail). Exit 1: still green after the
// mutation, or red before it. Exit 2: usage, find text missing or not unique,
// pending restore, or restore failed (loud; the snapshot path is printed).
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const STORE = process.env.MUTATE_RED_STORE || path.join(tmpdir(), 'mutate-red');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const die = (code, msg) => { console.error(`mutate-red: ${msg}`); process.exit(code); };

function restoreRecord(recordPath) {
  const rec = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (sha(readFileSync(rec.snapshot)) !== rec.sha) throw new Error('snapshot hash mismatch');
  copyFileSync(rec.snapshot, rec.file);
  if (sha(readFileSync(rec.file)) !== rec.sha) throw new Error('restored file hash mismatch');
  rmSync(recordPath, { force: true });
  rmSync(rec.snapshot, { force: true });
  return rec.file;
}

const argv = process.argv.slice(2);
mkdirSync(STORE, { recursive: true });

if (argv[0] === '--restore') {
  const pending = readdirSync(STORE).filter((f) => f.endsWith('.json'));
  if (!pending.length) { console.log('mutate-red: nothing pending'); process.exit(0); }
  for (const f of pending) console.log(`mutate-red: restored ${restoreRecord(path.join(STORE, f))}`);
  process.exit(0);
}

const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) die(2, 'usage: --file F --find A --replace B [--timeout S] -- <test command...>');
const opts = {};
for (let i = 0; i < sep; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
const cmd = argv.slice(sep + 1);
if (!opts.file || opts.find === undefined || opts.replace === undefined) die(2, '--file, --find and --replace are required');
const file = path.resolve(opts.file);
const timeoutMs = Number(opts.timeout || 120) * 1000;
const original = readFileSync(file);
const originalHash = sha(original);
const text = original.toString('utf8');
const hits = text.split(opts.find).length - 1;
if (hits !== 1) die(2, `--find text occurs ${hits} times in ${file}; it must occur exactly once`);

const id = sha(file).slice(0, 16);
const recordPath = path.join(STORE, `${id}.json`);
if (existsSync(recordPath)) die(2, `a killed run left ${file} unrestored; run --restore first`);

// No shell: arguments pass through unquoted-safe. On Windows name the real binary (node, npm.cmd).
const run = () => spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', timeout: timeoutMs });
const passed = (r) => r.status === 0 && !r.error && !r.signal;

console.log(`mutate-red: baseline run on the real file`);
if (!passed(run())) die(1, 'the check is red BEFORE the mutation; fix that first, a red-on-red proves nothing');

const snapshot = path.join(STORE, `${id}-${randomUUID()}.snapshot`);
copyFileSync(file, snapshot, constants.COPYFILE_EXCL);
if (sha(readFileSync(snapshot)) !== originalHash) {
  rmSync(snapshot);
  die(2, 'target changed during the baseline run');
}
try {
  writeFileSync(recordPath, JSON.stringify({ file, sha: originalHash, snapshot, at: new Date().toISOString() }), { flag: 'wx' });
} catch (error) {
  rmSync(snapshot);
  if (error.code === 'EEXIST') die(2, 'another run owns this target');
  throw error;
}
let verdict;
try {
  writeFileSync(file, text.replace(opts.find, () => opts.replace));
  console.log(`mutate-red: mutated ${file} in place (if a scheduler or server runs this path, mutate a copy instead)`);
  const mutant = run();
  if (mutant.error || mutant.signal || mutant.status === null) verdict = 'INCOMPLETE';
  else verdict = mutant.status === 0 ? 'GREEN' : 'RED';
} finally {
  try {
    restoreRecord(recordPath);
    console.log(`mutate-red: restored ${file} from snapshot, hash verified`);
  } catch (error) {
    die(2, `RESTORE FAILED: ${error.message}. Snapshot kept at ${snapshot}`);
  }
}
if (verdict === 'INCOMPLETE') die(2, 'the mutant check did not finish');
if (verdict === 'GREEN') die(1, 'STILL GREEN after the mutation: this check cannot see that change');
console.log('mutate-red: PASS, green on the real file and red on the mutant');
