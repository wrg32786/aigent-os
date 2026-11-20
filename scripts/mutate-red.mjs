#!/usr/bin/env node
// Prove a check can go red (Law XV). For a single user in a clean working tree.
// Refuses dirty or outside targets and unchanged bytes. Restores on interrupt.
//
//   node scripts/mutate-red.mjs --file <path> --find <text> --replace <text> [--timeout <sec>] -- <test command...>
//   node scripts/mutate-red.mjs --restore
//
// The check must pass on the original bytes and fail on the mutation.
// --restore recovers a pending snapshot after a killed run.
//
//// Exit 0: green then red (the check can fail). Exit 1: still green after the
// mutation, or red before it. Exit 2: usage, find text missing or not unique,
// pending restore, or restore failed (loud; the snapshot path is printed).
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const STORE = process.env.MUTATE_RED_STORE || path.join(tmpdir(), 'mutate-red');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const die = (code, msg) => { console.error(`mutate-red: ${msg}`); process.exit(code); };

const root = realpathSync(execFileSync('git', ['-C', path.dirname(fileURLToPath(import.meta.url)),
  'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());

function checkedTarget(file) {
  const resolved = realpathSync(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    die(2, 'target outside the repository: ' + file);
  }
  return resolved;
}

function requireClean(file) {
  const status = execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', 'status',
    '--porcelain', '--untracked-files=all', '--ignored', '--', path.relative(root, file)], { cwd: root });
  if (status.length) die(2, 'target has uncommitted changes: ' + file);
}

function restoreRecord(recordPath) {
  const rec = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (sha(readFileSync(rec.snapshot)) !== rec.sha) throw new Error('snapshot hash mismatch');
  let actual;
  try {
    const current = checkedTarget(rec.file);
    actual = current === rec.file ? sha(readFileSync(current)) : 'redirected to ' + current;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    actual = 'missing';
  }
  if (actual !== rec.mutatedSha) {
    throw new Error('target changed: expected ' + (rec.mutatedSha || 'unrecorded mutation hash')
      + ', found ' + actual + '; snapshot kept at ' + rec.snapshot);
  }
  copyFileSync(rec.snapshot, rec.file);
  if (sha(readFileSync(rec.file)) !== rec.sha) throw new Error('restored file hash mismatch');
  rmSync(recordPath, { force: true });
  rmSync(rec.snapshot, { force: true });
  return rec.file;
}

const argv = process.argv.slice(2);

if (argv[0] === '--restore') {
  const pending = existsSync(STORE) ? readdirSync(STORE).filter((f) => f.endsWith('.json')) : [];
  if (!pending.length) { console.log('mutate-red: nothing pending'); process.exit(0); }
  for (const f of pending) console.log(`mutate-red: restored ${restoreRecord(path.join(STORE, f))}`);
  process.exit(0);
}

const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  die(2, 'usage: --file F --find A --replace B [--timeout S] -- <test command...> | --restore\n'
    + 'For a single user in a clean working tree. Refuses dirty or outside targets and unchanged bytes. Restores on interrupt.');
}
const opts = {};
for (let i = 0; i < sep; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
const cmd = argv.slice(sep + 1);
if (!opts.file || opts.find === undefined || opts.replace === undefined) die(2, '--file, --find and --replace are required');
if (opts.find === opts.replace) die(2, 'identical replacement leaves target unchanged');
const file = checkedTarget(path.resolve(opts.file));
const timeoutMs = Number(opts.timeout || 120) * 1000;
const id = sha(file).slice(0, 16);
const recordPath = path.join(STORE, `${id}.json`);
if (existsSync(recordPath)) die(2, `a killed run left ${file} unrestored; run --restore first`);

requireClean(file);
const original = readFileSync(file);
const originalHash = sha(original);
const text = original.toString('utf8');
const hits = text.split(opts.find).length - 1;
if (hits !== 1) die(2, `--find text occurs ${hits} times in ${file}; it must occur exactly once`);

// No shell: arguments pass through unquoted-safe. On Windows name the real binary (node, npm.cmd).
let child;
let activeRecord;
function interrupted(reason) {
  child?.kill();
  try {
    if (activeRecord) restoreRecord(activeRecord);
  } catch (error) {
    die(2, 'RESTORE FAILED: ' + error.message);
  }
  die(2, String(reason));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => interrupted(signal));
process.on('uncaughtException', interrupted);

function run() {
  return new Promise(resolve => {
    child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', timeout: timeoutMs });
    child.once('error', error => resolve({ error }));
    child.once('close', (status, signal) => {
      child = undefined;
      resolve({ status, signal });
    });
  });
}
const passed = (r) => r.status === 0 && !r.error && !r.signal;

console.log(`mutate-red: baseline run on the real file`);
if (!passed(await run())) die(1, 'the check is red BEFORE the mutation; fix that first, a red-on-red proves nothing');

requireClean(file);
mkdirSync(STORE, { recursive: true });
const mutated = Buffer.from(text.replace(opts.find, () => opts.replace));
const snapshot = path.join(STORE, `${id}-${randomUUID()}.snapshot`);
copyFileSync(file, snapshot, constants.COPYFILE_EXCL);
if (sha(readFileSync(snapshot)) !== originalHash) {
  rmSync(snapshot);
  die(2, 'target changed during the baseline run');
}
try {
  writeFileSync(recordPath, JSON.stringify({ file, sha: originalHash, mutatedSha: sha(mutated), snapshot, at: new Date().toISOString() }), { flag: 'wx' });
} catch (error) {
  rmSync(snapshot);
  if (error.code === 'EEXIST') die(2, 'another run owns this target');
  throw error;
}
let verdict;
try {
  activeRecord = recordPath;
  writeFileSync(file, mutated);
  const landed = readFileSync(file);
  if (landed.equals(original)) {
    rmSync(recordPath);
    rmSync(snapshot);
    die(2, 'mutation write left target unchanged');
  }
  if (!landed.equals(mutated)) throw new Error('mutation write verification failed');
  console.log(`mutate-red: mutated ${file} in place (if a scheduler or server runs this path, mutate a copy instead)`);
  const mutant = await run();
  if (mutant.error || mutant.signal || mutant.status === null) verdict = 'INCOMPLETE';
  else verdict = mutant.status === 0 ? 'GREEN' : 'RED';
} finally {
  try {
    restoreRecord(recordPath);
    activeRecord = undefined;
    console.log(`mutate-red: restored ${file} from snapshot, hash verified`);
  } catch (error) {
    die(2, `RESTORE FAILED: ${error.message}. Snapshot kept at ${snapshot}`);
  }
}
if (verdict === 'INCOMPLETE') die(2, 'the mutant check did not finish');
if (verdict === 'GREEN') die(1, 'STILL GREEN after the mutation: this check cannot see that change');
console.log('mutate-red: PASS, green on the real file and red on the mutant');
