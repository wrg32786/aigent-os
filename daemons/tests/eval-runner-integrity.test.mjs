#!/usr/bin/env node
// F017: exercise the REAL eval runner against a hermetic fake install. Each
// vector gets its own child run so an already-red regression assertion cannot
// hide a false-green target behind the same process exit.

import assert from 'node:assert/strict';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(REPO_ROOT, 'evals', 'run-evals.mjs');
const FIXTURE = path.join(REPO_ROOT, 'evals', 'fixtures', 'f017');
const SOURCE_CORPUS = JSON.parse(readFileSync(path.join(FIXTURE, 'evals', 'skill-recall-tests.json'), 'utf8'));
const CONTROL_IDS = [
  'f017-control-scorer-a',
  'f017-control-scorer-b',
  'f017-control-taxonomy',
];

function runVector(id, mutate = (row) => row) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'f017-eval-runner-'));
  try {
    cpSync(FIXTURE, fixtureRoot, { recursive: true });
    const target = SOURCE_CORPUS.find((row) => row.id === id);
    assert.ok(target, `fixture corpus is missing ${id}`);
    const controls = CONTROL_IDS.map((controlId) => {
      const row = SOURCE_CORPUS.find((candidate) => candidate.id === controlId);
      assert.ok(row, `fixture corpus is missing ${controlId}`);
      return row;
    });
    writeFileSync(
      path.join(fixtureRoot, 'evals', 'skill-recall-tests.json'),
      `${JSON.stringify([mutate({ ...target }), ...controls], null, 2)}\n`,
      'utf8',
    );

    const proc = spawnSync(process.execPath, [RUNNER, '--json'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AIGENT_ROOT: fixtureRoot },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(proc.error, undefined, `runner did not execute: ${proc.error?.message}`);
    assert.equal(proc.signal, null, `runner was killed by ${proc.signal}`);
    let report;
    assert.doesNotThrow(() => { report = JSON.parse(proc.stdout); },
      `runner did not emit JSON:\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
    const result = report.results.find((row) => row.suite === 'skill-recall' && row.id === id);
    assert.ok(result, `runner report is missing skill-recall/${id}`);
    console.log(`${id}: exit=${proc.status} status=${result.status} detail=${JSON.stringify(result.detail)}`);
    return { proc, report, result };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function assertHealthyControls(report, targetId, targetStatus) {
  for (const id of CONTROL_IDS) {
    const row = report.results.find((candidate) => candidate.suite === 'skill-recall' && candidate.id === id);
    assert.equal(row?.status, 'pass', `${id} must keep the isolated runner witnessed and healthy`);
  }
  assert.equal(
    report.results.find((row) => row.id === 'f017-control-scorer-a')?.matched,
    true,
    'a scorer control must witness the trigger scorer',
  );
  assert.equal(
    report.results.find((row) => row.id === 'f017-control-taxonomy')?.matched,
    false,
    'a taxonomy record may pass but must not impersonate the trigger scorer',
  );
  assert.deepEqual(report.starved, []);
  assert.deepEqual(report.undercovered, []);
  assert.deepEqual(report.unwitnessed, []);
  assert.equal(report.undeclared, 0);

  // A red target's process exit proves nothing if an unrelated fixture row is
  // also fatal. Pin the complete fatal set so every isolated exit is target-caused.
  const fatal = report.results
    .filter((row) => ['fail', 'gap-closed', 'harness-error'].includes(row.status))
    .map((row) => `${row.suite}/${row.id}:${row.status}`);
  assert.deepEqual(
    fatal,
    targetStatus === 'pass' ? [] : [`skill-recall/${targetId}:${targetStatus}`],
  );
}

test('F017 V1: partial stdout plus nonzero exit is a fatal harness error', () => {
  // V1's harness-error detail intentionally does not trust or echo partial stdout.
  // Lock the fixture stimulus separately so this test cannot weaken into merely
  // checking a nonzero child that never printed the false-positive record.
  const fixtureProc = spawnSync('bash', [path.join(FIXTURE, 'daemons', 'caddy.sh')], {
    input: JSON.stringify({ prompt: 'F017 vector V1' }),
    encoding: 'utf8',
  });
  assert.equal(fixtureProc.status, 1);
  assert.equal(fixtureProc.stdout, '[CADDY] /skill-recall - "partial output before crash"\n');
  assert.match(fixtureProc.stderr, /fixture V1 stderr: caddy crashed after partial output/);

  const { proc, report, result } = runVector('f017-v1-nonzero-token');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'harness-error');
  assert.match(result.detail, /exit code 1/);
  assert.match(result.detail, /fixture V1 stderr: caddy crashed after partial output/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017 V2: stderr-only token stays red and its bounded diagnostic is visible', () => {
  const { proc, report, result } = runVector('f017-v2-stderr-only');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /fixture V2 stderr-only token: skill-recall/);
  assert.doesNotMatch(result.detail, /F017_V2_TAIL_MUST_BE_TRUNCATED/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017 V3 forward: seo-research does not satisfy expected seo', () => {
  const { proc, report, result } = runVector('f017-v3-forward');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /\[CADDY\] \/seo-research -/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017 V3 inverse: seo does not satisfy expected seo-research', () => {
  const { proc, report, result } = runVector('f017-v3-inverse');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /\[CADDY\] \/seo -/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017 V4: a miss line naming skill-recall is not a positive record', () => {
  const { proc, report, result } = runVector('f017-v4-dead-router-miss');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /No skill match — run \/skill-recall/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017: requires cannot excuse a child-process harness error', () => {
  const { proc, report, result } = runVector(
    'f017-v1-nonzero-token',
    (row) => ({ ...row, requires: 'fixture declared precondition' }),
  );
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'harness-error');
  assertHealthyControls(report, result.id, result.status);
});

test('F017: must_not_suggest compares exact parsed identities', () => {
  const { proc, report, result } = runVector(
    'f017-v3-forward',
    (row) => ({
      ...row,
      expected_skill: 'seo-research',
      must_not_suggest: ['seo'],
    }),
  );
  assert.equal(proc.status, 0);
  assert.equal(result.status, 'pass');
  assertHealthyControls(report, result.id, result.status);
});

test('F017: acceptable alternatives compare exact parsed identities', () => {
  const { proc, report, result } = runVector(
    'f017-v3-forward',
    (row) => ({
      ...row,
      expected_skill: 'skill-recall',
      acceptable_alternatives: ['seo'],
    }),
  );
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /\[CADDY\] \/seo-research -/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017: a killed caddy child is a fatal harness error', () => {
  const { proc, report, result } = runVector('f017-guard-signal');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'harness-error');
  // POSIX reports SIGTERM directly; Git Bash can translate it to exit 143 or the
  // raw wait status 3840 before Node observes it. All prove an abnormal exit.
  assert.match(result.detail, /signal SIGTERM|exit code (?:143|3840)/);
  assert.match(result.detail, /fixture signal stderr: caddy received TERM/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017: an expected token in scorer description text cannot satisfy a case', () => {
  const { proc, report, result } = runVector('f017-guard-description');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /\[CADDY\] \/control - "description mentions skill-recall/);
  assertHealthyControls(report, result.id, result.status);
});

test('F017: taxonomy records also compare exact parsed identities', () => {
  const { proc, report, result } = runVector('f017-guard-taxonomy-substring');
  assert.equal(proc.status, 1);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /`\/seo-research`/);
  assertHealthyControls(report, result.id, result.status);
});
