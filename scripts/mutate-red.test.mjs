// node --test scripts/mutate-red.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mutate-red.mjs');

async function fixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mutate-red-test-'));
  const repo = path.join(dir, 'repo');
  const source = execFileSync('git', ['-C', path.dirname(HELPER), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '--quiet', '--local', '--shared', '--no-checkout', source, repo]);
  execFileSync('git', ['-C', repo, 'restore', '--source=HEAD', '--staged', '--worktree', '--', '.gitattributes']);
  const target = path.join(repo, '.gitattributes');
  const script = path.join(repo, 'mutate-red.mjs');
  copyFileSync(HELPER, script);
  const check = path.join(dir, 'check.mjs');
  writeFileSync(check, `import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync(${JSON.stringify(target)}, 'utf8').includes('text=auto') ? 0 : 1);\n`);
  const env = { ...process.env, MUTATE_RED_STORE: path.join(dir, 'store') };
  const helper = (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', cwd: repo, env,
  });
  try { return await run({ dir, repo, script, target, check, helper, env }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a mutation the check sees: exit 0 and the file is restored byte for byte', () => fixture(({ target, check, helper }) => {
  const before = readFileSync(target);
  const r = helper('--file', target, '--find', 'text=auto', '--replace', 'text=two', '--', process.execPath, check);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS/);
  assert.deepEqual(readFileSync(target), before);
}));

test('a mutation the check cannot see: exit 1, STILL GREEN, file restored', () => fixture(({ target, check, helper }) => {
  const before = readFileSync(target);
  const r = helper('--file', target, '--find', 'eol=lf', '--replace', 'eol=crlf', '--', process.execPath, check);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /STILL GREEN/);
  assert.deepEqual(readFileSync(target), before);
}));

test('absent find text is refused before touching the file', () => fixture(({ target, check, helper }) => {
  const before = readFileSync(target);
  const r = helper('--file', target, '--find', 'absent', '--replace', 'x', '--', process.execPath, check);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /occurs 0 times/);
  assert.deepEqual(readFileSync(target), before);
}));

test('a run killed mid-test is recovered by --restore, and blocks new runs until then', () => fixture(({ dir, target, check, helper }) => {
  const before = readFileSync(target);
  // Kill only this fixture's helper, once the check has observed the mutation.
  const killHelper = path.join(dir, 'kill-helper.mjs');
  writeFileSync(killHelper, `import { readFileSync } from 'node:fs';
if (readFileSync(${JSON.stringify(target)}, 'utf8').includes('text=nine')) {
  process.kill(process.ppid, 'SIGKILL');
}
`);
  const killed = helper('--file', target, '--find', 'text=auto', '--replace', 'text=nine',
    '--', process.execPath, killHelper);
  assert.notEqual(killed.status, 0, 'the interrupted helper must not complete');
  assert.match(readFileSync(target, 'utf8'), /text=nine/, 'the mutation is still on disk after the kill');
  const blocked = helper('--file', target, '--find', 'text=nine', '--replace', 'text=auto', '--', process.execPath, check);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /--restore first/);
  const restored = helper('--restore');
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(readFileSync(target), before);
  assert.equal(existsSync(path.join(dir, 'store')) && helper('--restore').stdout.includes('nothing pending'), true);
}));

test('repeated find text is refused before touching the file', () => fixture(({ target, check, helper }) => {
  const before = readFileSync(target);
  const r = helper('--file', target, '--find', 'Windows', '--replace', 'x', '--', process.execPath, check);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /occurs 2 times/);
  assert.deepEqual(readFileSync(target), before);
}));

for (const kind of ['outside', 'dirty']) {
  test(kind + ' target is refused before writing', () => fixture(({ dir, target, helper, env }) => {
    if (kind === 'outside') target = path.join(dir, 'outside.txt');
    writeFileSync(target, 'changed bytes');
    const marker = path.join(dir, 'check-ran');
    const r = helper('--file', target, '--find', 'bytes', '--replace', 'content', '--', process.execPath,
      '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, kind === 'outside' ? /outside the repository/ : /uncommitted changes/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(env.MUTATE_RED_STORE), false);
    assert.equal(readFileSync(target, 'utf8'), 'changed bytes');
  }));
}

test('restore preserves an intervening edit and reports both hashes', () => fixture(({ target, helper }) => {
  const check = `const fs = require('node:fs'); const file = ${JSON.stringify(target)};
    if (fs.readFileSync(file, 'utf8').includes('text=two')) fs.writeFileSync(file, 'later edit');`;
  const r = helper('--file', target, '--find', 'text=auto', '--replace', 'text=two', '--', process.execPath, '-e', check);
  assert.equal(readFileSync(target, 'utf8'), 'later edit', 'restoration overwrote the intervening edit');
  assert.equal(r.status, 2);
  for (const failure of [r, helper('--restore')]) {
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /expected [a-f0-9]{64}.*found [a-f0-9]{64}/);
    assert.equal(readFileSync(target, 'utf8'), 'later edit');
  }
}));

for (const event of ['SIGINT', 'SIGTERM', 'uncaught error']) {
  test(event + ' during the mutant check restores original bytes', () => fixture(async ({ dir, repo, env, script, target }) => {
    const before = readFileSync(target);
    const bridge = path.join(dir, 'interrupt.cjs');
    // Windows kill() forcibly terminates a process. Deliver the console signal
    // event over IPC there. POSIX sends the actual signal to the helper.
    writeFileSync(bridge, `process.on('message', event => {
      if (event === 'uncaught error') throw Error('injected error');
      process.emit(event);
    }); process.channel.unref();`);
    const check = `if (require('fs').readFileSync(${JSON.stringify(target)}, 'utf8').includes('text=two')) {
      setTimeout(() => process.exit(1), 3000);
    }`;
    const child = spawn(process.execPath, ['--require', bridge, script, '--file', target, '--find', 'text=auto',
      '--replace', 'text=two', '--', process.execPath, '-e', check], {
      cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let sent = false;
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (sent || !output.includes('mutated ')) return;
      sent = true;
      if (event === 'uncaught error' || process.platform === 'win32') child.send(event);
      else child.kill(event);
    });
    child.stderr.on('data', chunk => { output += chunk; });
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.ok(sent, output);
    assert.notEqual(status, 0, 'helper completed the mutant instead of handling ' + event);
    assert.deepEqual(readFileSync(target), before, 'interrupted helper left the mutation on disk');
  }));
}

test('restore reports a missing target without recreating it', () => fixture(({ target, helper }) => {
  const check = `const fs = require('node:fs'); const file = ${JSON.stringify(target)};
    if (fs.readFileSync(file, 'utf8').includes('text=two')) fs.unlinkSync(file);`;
  const r = helper('--file', target, '--find', 'text=auto', '--replace', 'text=two', '--', process.execPath, '-e', check);
  assert.equal(existsSync(target), false, 'restoration recreated the deleted target');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /expected [a-f0-9]{64}.*found missing/);
}));
