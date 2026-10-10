// Run: node --test daemons/tests/vault-sync-approval.test.mjs
// Real Git repositories and local bare remotes only. No provider/network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNC = new URL('../vault-sync.mjs', import.meta.url);
const KEY = 'aigent.vaultSyncPushUrl';

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'vault-sync-approval-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault');
  const home = path.join(base, 'home');
  mkdirSync(home);
  mkdirSync(path.join(root, '.aigent'), { recursive: true });
  mkdirSync(path.join(root, 'vault/memory'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  delete env.AIGENT_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'vault sync test');
  git('config', 'user.email', 'vault-sync@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, '.aigent/state.json'), '{"schemaVersion":1}\n');
  writeFileSync(path.join(root, 'seed.txt'), 'public seed\n');
  git('add', 'seed.txt');
  git('commit', '-qm', 'seed');
  const remote = path.join(base, 'remote.git');
  git('init', '-q', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-qu', 'origin', 'main');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'vault/memory/private.md'), 'synthetic private memory\n');
  const run = (cli = false) => {
    const args = cli ? [fileURLToPath(SYNC)] : ['--input-type=module', '-e',
      `import {syncInstalledVault} from ${JSON.stringify(SYNC.href)}; console.log(JSON.stringify(syncInstalledVault(process.cwd())));`];
    const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    return cli ? r : JSON.parse(r.stdout);
  };
  const approve = (url = remote) => git('config', '--local', '--add', KEY, url);
  const unchanged = () => {
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(git('diff', '--cached', '--name-only'), '');
    assert.equal(git('--git-dir=' + remote, 'rev-parse', 'refs/heads/main'), before);
    assert.equal(readFileSync(path.join(root, 'vault/memory/private.md'), 'utf8'), 'synthetic private memory\n');
  };
  const refused = () => {
    const r = run();
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.committed, false);
    assert.equal(r.pushed, false);
    assert.match(r.detail, /destination.*approv/i);
    unchanged();
    return r;
  };
  return { base, root, home, env, git, remote, before, run, approve, unchanged, refused };
}

test('a clone origin is not memory-publication approval; refusal preserves source and index', (t) => {
  const f = fixture(t);
  f.refused();
  const log = readFileSync(path.join(f.root, 'vault/memory/.daemon-errors.log'), 'utf8');
  assert.equal(log.trim().split('\n').length, 1);
  assert.match(log, /tag="vault-sync"/);
});

test('only a repository-local exact URL can approve sync', (t) => {
  const f = fixture(t);
  f.git('config', '--global', KEY, f.remote);
  f.refused();
  f.approve(f.remote + '-other');
  f.refused();
  f.approve();
  const r = f.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.committed, true);
  assert.equal(r.pushed, true);
  assert.match(f.git('--git-dir=' + f.remote, 'show', 'main:vault/memory/private.md'), /synthetic private/);
});

test('an included config cannot silently enroll a new installation', (t) => {
  const f = fixture(t);
  const shared = path.join(f.base, 'shared.config');
  f.git('config', '--file', shared, KEY, f.remote);
  f.git('config', '--local', 'include.path', shared);
  f.refused();
});

test('fetch URL approval does not approve a different push URL', (t) => {
  const f = fixture(t);
  const other = path.join(f.base, 'other.git');
  f.git('init', '-q', '--bare', other);
  f.git('remote', 'set-url', '--push', 'origin', other);
  f.approve();
  f.refused();
  assert.equal(f.git('--git-dir=' + other, 'for-each-ref'), '');
});

test('one unapproved destination refuses the entire multi-push before any publication', (t) => {
  const f = fixture(t);
  const other = path.join(f.base, 'other.git');
  f.git('init', '-q', '--bare', other);
  f.git('remote', 'set-url', '--push', 'origin', f.remote);
  f.git('remote', 'set-url', '--push', '--add', 'origin', other);
  f.approve();
  f.refused();
  assert.equal(f.git('--git-dir=' + other, 'for-each-ref'), '');
  f.approve(other);
  const r = f.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const url of [f.remote, other]) {
    assert.equal(f.git('--git-dir=' + url, 'rev-parse', 'refs/heads/main'), f.git('rev-parse', 'HEAD'));
  }
});

test('approval is of Git-resolved push destination, not an alias', (t) => {
  const f = fixture(t);
  const alias = 'https://synthetic.invalid/vault.git';
  // Always resolves to a local bare repository, even on the old unguarded code.
  f.git('config', `url.${f.remote}.pushInsteadOf`, alias);
  f.git('remote', 'set-url', 'origin', alias);
  f.approve(alias);
  f.refused();
  f.approve();
  assert.equal(f.run().ok, true);
});

test('revoked approval blocks pending already-committed memory too', (t) => {
  const f = fixture(t);
  f.approve();
  assert.equal(f.run().ok, true);
  writeFileSync(path.join(f.root, 'vault/memory/later.md'), 'pending local commit\n');
  f.git('add', 'vault/memory/later.md');
  f.git('commit', '-qm', 'manual local memory');
  const local = f.git('rev-parse', 'HEAD');
  const remote = f.git('--git-dir=' + f.remote, 'rev-parse', 'refs/heads/main');
  f.git('config', '--local', '--unset-all', KEY);
  const r = f.run();
  assert.equal(r.ok, false);
  assert.equal(r.pushed, false);
  assert.equal(f.git('rev-parse', 'HEAD'), local);
  assert.equal(f.git('--git-dir=' + f.remote, 'rev-parse', 'refs/heads/main'), remote);
});

test('approved new push URL receives clean HEAD despite a stale upstream tracking ref', (t) => {
  const f = fixture(t);
  f.approve();
  assert.equal(f.run().ok, true);
  const other = path.join(f.base, 'new-destination.git');
  f.git('init', '-q', '--bare', other);
  f.git('remote', 'set-url', '--push', 'origin', other);
  f.approve(other);
  const r = f.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.git('--git-dir=' + other, 'rev-parse', 'refs/heads/main'), f.git('rev-parse', 'HEAD'));
});

test('authorized push failure retains the local commit and remains lifecycle fail-soft', (t) => {
  const f = fixture(t);
  const absent = path.join(f.base, 'absent.git');
  f.git('remote', 'set-url', '--push', 'origin', absent);
  f.approve(absent);
  const r = f.run();
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.match(r.detail, /git push failed/);
  assert.match(f.git('show', 'HEAD:vault/memory/private.md'), /synthetic private/);
  const cli = f.run(true);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr, '');
});

test('unapproved CLI stays fail-soft, while no remote remains the existing silent no-op', (t) => {
  const f = fixture(t);
  const r = f.run(true);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  f.unchanged();
  f.git('remote', 'remove', 'origin');
  const noRemote = f.run();
  assert.deepEqual(noRemote, { ok: true, committed: false, pushed: false, detail: 'no remote configured' });
});


test('revocation during staging is rechecked before push; local commit survives', (t) => {
  const f = fixture(t);
  f.approve();
  const filter = path.join(f.base, 'revoke.cjs');
  writeFileSync(filter, `const fs=require('node:fs'); const cp=require('node:child_process');
    cp.spawnSync('git', ['config','--local','--unset-all',${JSON.stringify(KEY)}]);
    process.stdout.write(fs.readFileSync(0));`);
  f.git('config', 'filter.revoke.clean', `"${process.execPath}" "${filter}"`);
  writeFileSync(path.join(f.root, '.gitattributes'), 'vault/memory/private.md filter=revoke\n');
  const r = f.run();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.match(r.detail, /destination approval missing/);
  assert.equal(f.git('--git-dir=' + f.remote, 'rev-parse', 'refs/heads/main'), f.before);
  assert.match(f.git('show', 'HEAD:vault/memory/private.md'), /synthetic private/);
});

test('memory publication never inherits automatic tag publication', (t) => {
  const f = fixture(t);
  f.approve();
  f.git('config', 'push.followTags', 'true');
  f.git('tag', '-a', 'local-only', '-m', 'not approved for publication');
  assert.equal(f.run().ok, true);
  assert.equal(f.git('--git-dir=' + f.remote, 'for-each-ref', 'refs/tags'), '');
});
