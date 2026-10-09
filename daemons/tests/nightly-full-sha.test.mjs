// nightly-full-sha.test.mjs -- git artifacts must carry the full 40-char commit id.
// Run: node --test daemons/tests/nightly-full-sha.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isFullCommitSha } from '../nightly-paths.mjs';
import { runLedgerPredicate } from '../nightly-ledger-predicate.mjs';

const FULL = 'a'.repeat(40);

test('validator: 7-char and 39/41-char ids are refused, 40-char passes', () => {
  assert.equal(isFullCommitSha(FULL.slice(0, 7)), false);
  assert.equal(isFullCommitSha(FULL.slice(0, 39)), false);
  assert.equal(isFullCommitSha(`${FULL}a`), false);
  assert.equal(isFullCommitSha(''), false);
  assert.equal(isFullCommitSha(FULL), true);
  assert.equal(isFullCommitSha(FULL.toUpperCase()), true);
});

test('git_commit_present: a real commit passes by full id and a short id is refused', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'full-sha-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x');
  const sha = git('rev-parse', 'HEAD');
  const run = (s) => runLedgerPredicate({ root, type: 'git_commit_present', args: { repo: '.', sha: s }, expected: true });
  assert.equal(run(sha).exit_code, 0);
  const short = run(sha.slice(0, 7));
  assert.equal(short.exit_code, 1);
  assert.match(String(short.error), /full 40/);
});
