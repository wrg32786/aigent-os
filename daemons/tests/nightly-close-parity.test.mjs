// End-to-end mutation proofs for the nightly close-parity controller.
// Every writable fixture is created below the operating system temp directory.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { zonedDateKey } from '../nightly-freshness.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS = path.resolve(TEST_DIR, '..');
const PASS_CLI = path.join(DAEMONS, 'nightly-pass.mjs');
const CONTRACTS_CLI = path.join(DAEMONS, 'nightly-contracts.mjs');
const FRESHNESS_CLI = path.join(DAEMONS, 'nightly-freshness.mjs');
const RECONCILE_CLI = path.join(DAEMONS, 'nightly-reconcile.mjs');
const LEDGER_PREDICATE_CLI = path.join(DAEMONS, 'nightly-ledger-predicate.mjs');
const LEDGER_STAGE_CLI = path.join(DAEMONS, 'nightly-ledger-stage.mjs');
const LEDGER_REVIEW_CLI = path.join(DAEMONS, 'nightly-ledger-review.mjs');
const DECISION_OUTCOME_CLI = path.join(DAEMONS, 'nightly-decision-outcome.mjs');

const PASS_DATE = '2026-03-10';
const PASS_NOW = '2026-03-10T20:00:00.000Z';
const AFTER_BEGIN = '2026-03-10T20:01:00.000Z';
const TIME_ZONE = 'America/Los_Angeles';
const CUTOFF_HOUR = '4';
const GIT_NULL_CONFIG = process.platform === 'win32' ? 'NUL' : os.devNull;
const BASH_EXE = [
  process.env.AIGENT_BASH_EXE,
  process.env.BASH_EXE,
  process.env.ProgramFiles
    ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
    : null,
  '/bin/bash',
  '/usr/bin/bash',
].filter(Boolean).find((candidate) => existsSync(candidate));
assert.ok(BASH_EXE, 'a real Bash executable is required for the system-check proof');

const tempRoots = [];

function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function fixture(label = 'workspace') {
  const base = mkdtempSync(path.join(os.tmpdir(), 'aigent-nightly-proof-'));
  const root = path.join(base, label);
  const memory = path.join(root, 'vault', 'memory');
  const runtime = path.join(memory, 'runtime');
  mkdirSync(runtime, { recursive: true });

  write(root, 'vault/memory/runtime/LESSONS.jsonl', '');
  write(root, 'vault/memory/runtime/BELIEF_STATE.jsonl', '');
  write(root, 'vault/memory/runtime/PROCEDURES.jsonl', '');
  write(root, 'vault/memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl', '');
  write(root, 'vault/memory/runtime/GOAL_STACK.json', '{"active_goals":[]}\n');
  write(root, 'vault/memory/runtime/SELF_MODEL.json', JSON.stringify({
    capabilities: [],
    known_capabilities: [],
    limitations: [],
    known_limitations: [],
  }, null, 2) + '\n');
  write(root, 'vault/memory/DREAM_LOG.md', '# Dream Log\n');
  write(root, 'vault/memory/MEMORY_CANDIDATES.md', '| Candidate | Status |\n|---|---|\n');
  write(root, 'vault/memory/HONESTY_LEDGER.md', '# Honesty Ledger\n');
  write(root, 'vault/memory/TRUST_DECAY.md', '# Trust Decay\n\n## Open\n');
  write(root, 'vault/memory/FAILURE_MODES.md', '# Failure Modes\n');
  write(root, 'vault/memory/DECISION_LOG.md', '# Decision Log\n');
  write(root, 'vault/memory/DECISION_OUTCOMES.md', '# Decision Outcomes\n');
  writeValidContext(root);
  writeValidReconcileInputs(root);
  writeSystemCheck(root, 0);

  tempRoots.push(base);
  return { base, root, memory, runtime };
}

function writeValidContext(root) {
  write(root, 'vault/memory/SESSION_LOG.md', [
    '# Session Log',
    '',
    `## ${PASS_DATE} - fixture entry`,
    '',
    '**Objective:** Verify the executable postcondition.',
    '**Completed:** Restored the mutated fixture.',
    '**Decisions:** Keep the proof deterministic.',
    '**Open threads:** None.',
    '**Next action:** Run the validator.',
    '',
  ].join('\n'));
  write(root, 'vault/memory/ACTIVE_PRIORITIES.md', [
    '# Active Priorities',
    '',
    '## Operating Mode: Focused',
    `Last reviewed: ${PASS_DATE}`,
    '',
    '## Tier 1',
    '- [[Alpha]]',
    '- [[Beta]]',
    '',
    '| Tier | Project | Intended share |',
    '|---|---|---|',
    '| 1 | [[Alpha]] | 60% |',
    '| 1 | [[Beta]] | 40% |',
    '',
  ].join('\n'));
}

function writeValidReconcileInputs(root, date = PASS_DATE) {
  write(root, 'vault/projects/Alpha.md', '# Alpha\n');
  write(root, 'vault/projects/Beta.md', '# Beta\n');
  write(root, `vault/daily/${date}.md`, '# Alpha\nWorked on [[Beta]].\n');
}

function writeSystemCheck(root, exitCode) {
  const file = write(root, 'daemons/system-check.sh', [
    '#!/usr/bin/env bash',
    `echo "SYSTEM_CHECK ${exitCode === 0 ? 'PASS' : 'FAIL'} fixture"`,
    `exit ${exitCode}`,
    '',
  ].join('\n'));
  try {
    chmodSync(file, 0o755);
  } catch {
    // The controller invokes the script through bash, so an executable bit is
    // not required on platforms that do not expose POSIX permissions.
  }
}

function canonicalDream(date = PASS_DATE) {
  return [
    `## ${date}: deterministic synthesis`,
    '- **Sources reviewed:** fixture:daily; fixture:runtime',
    '- **Lessons extracted:** no lessons extracted this pass',
    '- **Improvement candidates proposed:** none',
    '- **Patterns observed:** none',
    '- **Discarded as one-off:** none',
    '- **Calibration miscalls:** none',
    '- **Productive surprises:** none',
    '- **Open trust-decay items to watch:** none',
    '',
  ].join('\n');
}

function isolatedEnv(root, extra = {}) {
  const keep = [
    'ComSpec',
    'Path',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'WINDIR',
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    AIGENT_OS_ROOT: root,
    AIGENT_PROJECT_DIR: root,
    AIGENT_STATE_HOME_DIR: root,
    AIGENT_NIGHTLY_TIME_ZONE: TIME_ZONE,
    AIGENT_NIGHTLY_CUTOFF_HOUR: CUTOFF_HOUR,
    AIGENT_BASH_EXE: BASH_EXE,
    TZ: 'UTC',
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function runNode(file, args, { root, input, extraEnv, timeout = 20_000 } = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    env: isolatedEnv(root, extraEnv),
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  });
}

function scrubProof(value) {
  const nativeTemp = os.tmpdir();
  const candidates = [
    nativeTemp.replaceAll('\\', '\\\\'),
    nativeTemp,
    nativeTemp.replaceAll('\\', '/'),
  ];
  return candidates.reduce(
    (output, candidate) => output.split(candidate).join('<temp>'),
    String(value || '').trim().replace(/\s+/g, ' '),
  );
}

function proof(label, result) {
  const stdout = scrubProof(result.stdout);
  const stderr = scrubProof(result.stderr);
  console.log(`${label} status=${result.status} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
}

function begin(root, runId, date = PASS_DATE, now = PASS_NOW) {
  const result = runNode(PASS_CLI, [
    'begin',
    '--root', root,
    '--date', date,
    ...(runId ? ['--run-id', runId] : []),
    '--now', now,
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
  ], { root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^NIGHTLY_PASS BEGIN\b/);
  return result;
}

function record(root, checkpoint, {
  artifact,
  status = 'pass',
  exitCode = 0,
  now = AFTER_BEGIN,
  timeout,
} = {}) {
  return runNode(PASS_CLI, [
    'record',
    '--root', root,
    '--checkpoint', checkpoint,
    '--status', status,
    '--exit-code', String(exitCode),
    '--detail', 'mutation fixture',
    '--artifact', artifact,
    '--now', now,
    '--no-deliver',
  ], { root, timeout });
}

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], {
    cwd: root,
    env: isolatedEnv(root),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function initIgnoredGitFixture(root, { visibleFile = false } = {}) {
  assert.equal(git(root, ['init']).status, 0);
  write(root, '.git/info/exclude', [
    '*',
    ...(visibleFile ? ['!uncommitted-proof.txt'] : []),
    '',
  ].join('\n'));
}

function checkpointCase(checkpoint, brokenSetup, restoredSetup) {
  const broken = fixture(`${checkpoint}-break`);
  begin(broken.root, `${checkpoint}-break`);
  const brokenSpec = brokenSetup(broken);
  const brokenRun = record(broken.root, checkpoint, brokenSpec);
  assert.notEqual(brokenRun.status, 0, `${checkpoint} mutation unexpectedly passed`);
  assert.match(`${brokenRun.stdout}\n${brokenRun.stderr}`, /RED|FAIL|ERROR/i);
  proof(`BREAK checkpoint=${checkpoint}`, brokenRun);

  const restored = fixture(`${checkpoint}-restore`);
  begin(restored.root, `${checkpoint}-restore`);
  const restoredSpec = restoredSetup(restored);
  const restoredRun = record(restored.root, checkpoint, restoredSpec);
  assert.equal(restoredRun.status, 0, restoredRun.stderr || restoredRun.stdout);
  assert.match(restoredRun.stdout, /NIGHTLY_CHECKPOINT GREEN/);
  proof(`RESTORE checkpoint=${checkpoint}`, restoredRun);
}

test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    } catch {
      // Temp cleanup is best effort on platforms that retain short-lived locks.
    }
  }
});

test('mutation proof: freshness reads the newest dated header instead of file mtime', () => {
  const { root } = fixture('freshness');
  const log = write(root, 'vault/memory/runtime/NIGHTLY_LOG.md', [
    '## Nightly Pass -- 2026-03-08 (stale)',
    '',
  ].join('\n'));
  const touched = new Date('2030-01-01T00:00:00.000Z');
  utimesSync(log, touched, touched);

  const broken = runNode(FRESHNESS_CLI, [
    '--kind', 'nightly',
    '--file', log,
    '--now', PASS_NOW,
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
  ], { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /NIGHTLY_FRESHNESS FAIL/);
  proof('BREAK freshness', broken);

  writeFileSync(log, `## Nightly Pass -- ${PASS_DATE} (restored)\n`, 'utf8');
  const restored = runNode(FRESHNESS_CLI, [
    '--kind', 'nightly',
    '--file', log,
    '--now', PASS_NOW,
    '--time-zone', TIME_ZONE,
    '--cutoff-hour', CUTOFF_HOUR,
  ], { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /NIGHTLY_FRESHNESS PASS/);
  proof('RESTORE freshness', restored);
});

test('mutation proof: Dream synthesis is append-only and has a canonical dated shape', () => {
  const { root, runtime } = fixture('dream-contract');
  begin(root, 'dream-contract');
  const state = path.join(runtime, 'NIGHTLY_PASS_STATE.json');
  write(root, 'vault/memory/DREAM_LOG.md', `# Dream Log\n\n## ${PASS_DATE}: incomplete\n`);

  const broken = runNode(CONTRACTS_CLI, [
    'dream',
    '--root', root,
    '--date', PASS_DATE,
    '--snapshot', state,
  ], { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /DREAM_CONTRACT FAIL/);
  proof('BREAK dream-contract', broken);

  write(root, 'vault/memory/DREAM_LOG.md', `# Dream Log\n\n${canonicalDream()}`);
  const restored = runNode(CONTRACTS_CLI, [
    'dream',
    '--root', root,
    '--date', PASS_DATE,
    '--snapshot', state,
  ], { root });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.match(restored.stdout, /DREAM_CONTRACT PASS/);
  proof('RESTORE dream-contract', restored);
});

test('mutation proof: reconciliation fails when canonical intended-share input is absent', () => {
  const { root } = fixture('reconcile');
  write(root, 'vault/memory/ACTIVE_PRIORITIES.md', '# Active Priorities\n');

  const broken = runNode(RECONCILE_CLI, [
    '--root', root,
    '--as-of', PASS_DATE,
  ], { root });
  assert.equal(broken.status, 1);
  assert.match(`${broken.stdout}\n${broken.stderr}`, /RECONCILE FAIL/);
  proof('BREAK reconcile', broken);

  writeValidContext(root);
  const restored = runNode(RECONCILE_CLI, [
    '--root', root,
    '--as-of', PASS_DATE,
  ], { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /RECONCILE PASS/);
  proof('RESTORE reconcile', restored);
});

test('mutation proof: cognitive updates preserve append-only ids and paired aliases', () => {
  const { root, runtime } = fixture('cognitive-contract');
  begin(root, 'cognitive-contract');
  const state = path.join(runtime, 'NIGHTLY_PASS_STATE.json');
  const belief = (id) => JSON.stringify({
    belief_id: id,
    belief: 'Executable postconditions prevent false green status.',
    confidence: 0.8,
    source: 'fixture:mutation-proof',
    status: 'active',
    last_checked: PASS_DATE,
  }) + '\n';
  const procedure = (id) => JSON.stringify({
    proc_id: id,
    name: 'Verify before recording',
    procedure: 'Run the named postcondition and retain its receipt.',
    applicable_when: 'A checkpoint is about to be recorded.',
    source: 'fixture:mutation-proof',
    created_at: PASS_DATE,
  }) + '\n';
  write(root, 'vault/memory/runtime/BELIEF_STATE.jsonl', belief('b002'));
  write(root, 'vault/memory/runtime/PROCEDURES.jsonl', procedure('p002'));
  write(root, 'vault/memory/runtime/SELF_MODEL.json', JSON.stringify({
    capabilities: ['verified capability'],
    known_capabilities: [],
    limitations: [],
    known_limitations: [],
  }, null, 2) + '\n');

  const args = [
    'cognitive',
    '--root', root,
    '--snapshot', state,
    '--new-belief-ids', 'b001',
    '--new-procedure-ids', 'p001',
    '--self-alias-additions', 'verified capability',
  ];
  const broken = runNode(CONTRACTS_CLI, args, { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /COGNITIVE_CONTRACT FAIL/);
  proof('BREAK cognitive-contract', broken);

  write(root, 'vault/memory/runtime/BELIEF_STATE.jsonl', belief('b001'));
  write(root, 'vault/memory/runtime/PROCEDURES.jsonl', procedure('p001'));
  write(root, 'vault/memory/runtime/SELF_MODEL.json', JSON.stringify({
    capabilities: ['verified capability'],
    known_capabilities: ['verified capability'],
    limitations: [],
    known_limitations: [],
  }, null, 2) + '\n');
  const restored = runNode(CONTRACTS_CLI, args, { root });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.match(restored.stdout, /COGNITIVE_CONTRACT PASS/);
  proof('RESTORE cognitive-contract', restored);
});

test('mutation proof: meta-improvement requires explicit operator approval evidence', () => {
  const { root } = fixture('meta-gate');
  const candidateId = 'ni-20260310-01';
  const candidate = (status, evidence) => [
    '# Dream Log',
    '',
    `### ${candidateId}: bounded improvement`,
    `- **status:** ${status}`,
    `- **operator evidence:** ${evidence}`,
    '',
  ].join('\n');
  write(root, 'vault/memory/DREAM_LOG.md', candidate('proposed', 'pending'));

  const args = [
    'meta',
    '--root', root,
    '--candidate', candidateId,
  ];
  const broken = runNode(CONTRACTS_CLI, args, { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /META_GATE FAIL/);
  proof('BREAK meta-gate', broken);

  write(
    root,
    'vault/memory/DREAM_LOG.md',
    candidate('approved', 'user message source:fixture-approval'),
  );
  const restored = runNode(CONTRACTS_CLI, args, { root });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.match(restored.stdout, /META_GATE PASS/);
  proof('RESTORE meta-gate', restored);
});

test('mutation proof: direct ledger predicates are fixed, data-only, and receipted', () => {
  const { root } = fixture('ledger-predicate');
  write(root, 'vault/memory/runtime/predicate.json', '{"state":"green"}\n');
  const baseArgs = [
    '--root', root,
    '--type', 'json_field_equals',
    '--path', 'memory/runtime/predicate.json',
    '--pointer', '/state',
    '--now', PASS_NOW,
  ];

  const broken = runNode(LEDGER_PREDICATE_CLI, [
    ...baseArgs,
    '--expected-json', '"red"',
  ], { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /LEDGER_PREDICATE FAIL/);
  assert.match(broken.stdout, /"exit_code":1/);
  assert.match(broken.stdout, /"receipt_hash":"[0-9a-f]{64}"/);
  proof('BREAK ledger-predicate', broken);

  const restored = runNode(LEDGER_PREDICATE_CLI, [
    ...baseArgs,
    '--expected-json', '"green"',
  ], { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /LEDGER_PREDICATE PASS/);
  assert.match(restored.stdout, /"exit_code":0/);
  assert.match(restored.stdout, /"receipt_hash":"[0-9a-f]{64}"/);
  proof('RESTORE ledger-predicate', restored);
});

test('mutation proof: mechanical ledger staging requires a reproducible green receipt', () => {
  const { root } = fixture('ledger-stage');
  write(root, 'vault/memory/runtime/predicate.json', '{"state":"green"}\n');
  const proposal = {
    type: 'json_field_equals',
    args: {
      path: 'memory/runtime/predicate.json',
      pointer: '/state',
    },
    expected: 'green',
  };
  const predicate = runNode(LEDGER_PREDICATE_CLI, [
    '--root', root,
    '--type', proposal.type,
    '--path', proposal.args.path,
    '--pointer', proposal.args.pointer,
    '--expected-json', JSON.stringify(proposal.expected),
    '--now', PASS_NOW,
  ], { root });
  assert.equal(predicate.status, 0, predicate.stderr);
  const receipt = JSON.parse(predicate.stdout.replace(/^LEDGER_PREDICATE PASS\s+/, ''));
  const candidate = {
    ledger: 'failure_modes',
    claim: 'atomic write failure is mechanically reproduced',
    source_refs: ['fixture:atomic-write'],
    evidence_class: 'mechanical',
    predicate_proposal: proposal,
    predicate_receipt: {
      ...receipt,
      receipt_hash: '0'.repeat(64),
    },
  };
  const args = (value) => [
    '--root', root,
    '--date', PASS_DATE,
    '--now', PASS_NOW,
    '--candidate-json', JSON.stringify(value),
  ];

  const broken = runNode(LEDGER_STAGE_CLI, args(candidate), { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /LEDGER_STAGE FAIL/);
  assert.match(broken.stderr, /receipt hash invalid/i);
  proof('BREAK ledger-stage-receipt', broken);

  candidate.predicate_receipt = receipt;
  const restored = runNode(LEDGER_STAGE_CLI, args(candidate), { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /LEDGER_STAGE PASS/);
  const row = JSON.parse(
    readFileSync(
      path.join(root, 'vault', 'memory', 'runtime', 'NIGHTLY_CAPTURE_CANDIDATES.jsonl'),
      'utf8',
    ).trim(),
  );
  assert.equal(row.status, 'staged');
  assert.equal(row.predicate_receipt.exit_code, 0);
  proof('RESTORE ledger-stage-receipt', restored);

  const replay = runNode(LEDGER_STAGE_CLI, args(candidate), { root });
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /LEDGER_STAGE SKIP duplicate=/);
});

test('mutation proof: ledger review rejects unreadable candidates and emits a real weekly receipt', () => {
  const { root } = fixture('ledger-review');
  const candidates = path.join(
    root,
    'vault',
    'memory',
    'runtime',
    'NIGHTLY_CAPTURE_CANDIDATES.jsonl',
  );
  writeFileSync(candidates, '{invalid json\n', 'utf8');
  const args = [
    '--root', root,
    '--now', '2026-03-13T20:00:00.000Z',
    '--time-zone', TIME_ZONE,
  ];

  const broken = runNode(LEDGER_REVIEW_CLI, args, { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /LEDGER_REVIEW FAIL/);
  proof('BREAK ledger-review', broken);

  writeFileSync(candidates, '', 'utf8');
  const restored = runNode(LEDGER_REVIEW_CLI, args, { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /LEDGER_REVIEW PASS/);
  assert.match(restored.stdout, /FRIDAY_MEASUREMENT/);
  proof('RESTORE ledger-review', restored);
});

test('mutation proof: an operator-authored decision outcome requires one unique due match', () => {
  const { root } = fixture('decision-outcome');
  const decisionDate = '2026-02-08';
  const title = 'Adopt bounded nightly protocol';
  const outcomes = '# Decision Outcomes\n';
  write(root, 'vault/memory/DECISION_OUTCOMES.md', outcomes);
  const decisionEntry = [
    `### ${decisionDate} - ${title}`,
    '',
    'Record the result after the due interval.',
    '',
  ].join('\n');
  write(
    root,
    'vault/memory/DECISION_LOG.md',
    `# Decision Log\n\n${decisionEntry}${decisionEntry}`,
  );
  const args = [
    '--root', root,
    '--as-of', PASS_DATE,
    '--decision-date', decisionDate,
    '--decision-title', title,
    '--interval', '30',
    '--outcome', 'HELD',
    '--operator-text', 'HELD',
    '--operator-source', 'user message source:fixture-outcome',
    '--expected-file-sha', sha256(outcomes),
  ];

  const broken = runNode(DECISION_OUTCOME_CLI, args, { root });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /DECISION_OUTCOME FAIL/);
  assert.match(broken.stderr, /ambiguous/i);
  proof('BREAK decision-outcome', broken);

  write(root, 'vault/memory/DECISION_LOG.md', `# Decision Log\n\n${decisionEntry}`);
  const restored = runNode(DECISION_OUTCOME_CLI, args, { root });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /DECISION_OUTCOME PASS appended=1/);
  assert.match(
    readFileSync(path.join(root, 'vault', 'memory', 'DECISION_OUTCOMES.md'), 'utf8'),
    /\*\*30-day check \(2026-03-10\):\*\* HELD/,
  );
  proof('RESTORE decision-outcome', restored);

  const replay = runNode(DECISION_OUTCOME_CLI, args, { root });
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /DECISION_OUTCOME SKIP duplicate=yes/);
});

const sourceRoot = path.dirname(DAEMONS);
const previousDate = '2026-03-09';
const beforeCutoff = '2026-03-10T08:00:00.000Z';
const nightlyLog = 'vault/memory/runtime/NIGHTLY_LOG.md';
const nightlyLabel = '"Nightly fire freshness and terminal evidence"';

function previousNight(status, date = previousDate) {
  return [
    `## Nightly Pass -- ${date}`,
    'protocol: fixture-1L-1C',
    `status: ${status}`,
    `completed_at: ${date}T20:00:00Z`,
    `- dream: status=${status} exit=${status === 'PASS' ? 0 : 1} validator=fixture`,
    '',
  ].join('\n');
}

function healthySystemCheck(root, now = PASS_NOW) {
  const memory = 'vault/memory';
  write(root, `${memory}/BODY_STATE.json`, '{"_schema":1,"state":{}}');
  write(root, `${memory}/HEAT_INDEX.json`, JSON.stringify({
    generated_at: now, hot_top_20: [], total_notes: 0,
  }));
  write(root, `${memory}/MEMORY_CANDIDATES.md`, '## Candidates\n');
  write(root, `${memory}/SWEEP_LOG.md`, `### ${zonedDateKey(now, TIME_ZONE)}\n`);
  write(root, `${memory}/AGENT_FITNESS.md`, '| Date | Session |\n');
  write(root, `${memory}/capsules/check.md`, '---\nid: check\nstatus: active\n---\n');
  write(root, `${memory}/runtime/ACTIVE_STATE.json`, '{"mode":"idle"}');
  write(root, `${memory}/runtime/BELIEF_STATE.jsonl`, '{"belief_id":"b001","confidence":1}\n');
  write(root, `${memory}/runtime/STATE_EVENTS.jsonl`, '');
  write(root, `${memory}/runtime/SELF_MODEL.json`, JSON.stringify({
    capabilities: ['read'], known_capabilities: ['read'],
    limitations: ['offline'], known_limitations: ['offline'],
  }));
}

function runSystemCheck(stateHome, extraEnv, repository = sourceRoot, cwd = repository) {
  const result = spawnSync(BASH_EXE, [path.join(repository, 'daemons', 'system-check.sh')], {
    cwd,
    env: isolatedEnv(stateHome, { AIGENT_ROOT: repository, ...extraEnv }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

const header = `## Nightly Pass -- ${previousDate}\n`;
for (const [name, log, detail] of [
  ['complete', previousNight('PASS'), null],
  ['stale', previousNight('PASS', '2026-03-02'), 'code=stale'],
  ['missing', null, 'code=missing'],
  ['incomplete', previousNight('PASS').replace('validator=fixture', ''), 'code=incomplete'],
  ['unverified', header, 'code=unverified'],
  ['failed checkpoint', previousNight('FAIL'), 'code=failed'],
  ['reported failure', header + 'status: FAIL\n', 'code=failed'],
  ['watchdog error', previousNight('PASS'), 'NIGHTLY_WATCHDOG ERROR'],
]) {
  test(`system check outside a pass with ${name} evidence`, () => {
    const { root } = fixture();
    healthySystemCheck(root);
    write(root, 'vault/memory/DREAM_LOG.md', canonicalDream());
    if (log !== null) write(root, nightlyLog, log);
    begin(root, 'current', PASS_DATE, beforeCutoff);
    const run = runSystemCheck(root, {
      AIGENT_SYSTEM_CHECK_NOW: beforeCutoff,
      ...(name === 'watchdog error' && { AIGENT_NIGHTLY_CUTOFF_HOUR: '25' }),
    });
    const line = run.stdout.split(/\r?\n/).find(value => value.includes(nightlyLabel));
    if (detail) {
      assert.ok(line?.startsWith(`✗ ${nightlyLabel}`) && line.includes(detail), run.stdout);
    } else {
      assert.equal(line, `✓ ${nightlyLabel}`, run.stdout);
    }
    assert.equal(run.status, detail ? 1 : 0, run.stdout);
  });
}

for (const log of ['failed', 'missing']) {
  test(`system check inside a running pass after a ${log} night`, () => {
    const { root } = fixture();
    healthySystemCheck(root);
    write(root, 'vault/memory/DREAM_LOG.md', canonicalDream());
    if (log === 'failed') write(root, nightlyLog, previousNight('FAIL'));
    const runId = begin(root, undefined, PASS_DATE, beforeCutoff).stdout.match(/\brun=(\S+)/)[1];
    const run = runSystemCheck(root, {
      AIGENT_NIGHTLY_RUN_ID: runId, AIGENT_SYSTEM_CHECK_NOW: beforeCutoff,
    });
    assert.ok(run.stdout.split(/\r?\n/).includes(
      `ℹ ${nightlyLabel} - "Inside nightly pass ${runId}. The watchdog reports the previous night."`,
    ), run.stdout);
    assert.equal(run.status, 0, run.stdout);
  });
}

for (const state of ['pass', 'fail', 'abandoned', 'other run', 'missing', 'unreadable', 'empty id']) {
  test(`system check uses the watchdog with ${state} pass state`, () => {
    const { root, runtime } = fixture();
    healthySystemCheck(root);
    write(root, 'vault/memory/DREAM_LOG.md', canonicalDream());
    const file = path.join(runtime, 'NIGHTLY_PASS_STATE.json');
    const runId = '2026-03-10-2026-03-10T080000000Z';
    if (state === 'unreadable') mkdirSync(file);
    else if (state !== 'missing') {
      writeFileSync(file, JSON.stringify({
        status: ['other run', 'empty id'].includes(state) ? 'running' : state,
        run_id: state === 'other run' ? runId.replace('T08', 'T09') : runId,
      }));
    }
    const run = runSystemCheck(root, {
      AIGENT_NIGHTLY_RUN_ID: state === 'empty id' ? '' : runId,
      AIGENT_SYSTEM_CHECK_NOW: beforeCutoff,
    });
    assert.ok(run.stdout.split(/\r?\n/).some(line =>
      line.startsWith(`✗ ${nightlyLabel}`) && line.includes('code=missing')), run.stdout);
    assert.equal(run.status, 1, run.stdout);
  });
}

test('system check uses the watchdog for a sibling state home with a leading space', () => {
  const { base, root } = fixture('seat');
  healthySystemCheck(root);
  write(root, 'vault/memory/DREAM_LOG.md', canonicalDream());
  cpSync(root, path.join(base, ' seat'), { recursive: true });
  const runId = begin(root).stdout.match(/\brun=(\S+)/)[1];
  const run = runSystemCheck(' seat', {
    AIGENT_NIGHTLY_RUN_ID: runId, AIGENT_SYSTEM_CHECK_NOW: beforeCutoff,
  }, sourceRoot, base);
  assert.match(run.stdout, /✗ "Nightly fire freshness and terminal evidence".*code=missing/);
  assert.equal(run.status, 1);
});

test('running pass query rejects matching IDs outside the generated format', () => {
  const { root, runtime } = fixture();
  for (const runId of ['custom', '2026-03-10-2026-03-10T080000000Z\n', '/nightly/run']) {
    writeFileSync(path.join(runtime, 'NIGHTLY_PASS_STATE.json'), JSON.stringify({
      status: 'running', run_id: runId,
    }));
    const run = runNode(PASS_CLI, ['is-running', '--root', root], {
      root, extraEnv: { AIGENT_NIGHTLY_RUN_ID: runId },
    });
    assert.equal(run.status, 1, JSON.stringify(runId));
  }
});

test('system check rejects a path in the run ID even if Bash converts it', () => {
  const { root } = fixture();
  healthySystemCheck(root);
  write(root, 'vault/memory/DREAM_LOG.md', canonicalDream());
  const runId = '/nightly/run';
  const env = { AIGENT_NIGHTLY_RUN_ID: runId, AIGENT_SYSTEM_CHECK_NOW: beforeCutoff };
  const probe = spawnSync(BASH_EXE, ['-c', 'node -p "process.env.AIGENT_NIGHTLY_RUN_ID"'], {
    cwd: root, env: isolatedEnv(root, env), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const storedId = process.platform === 'win32' ? probe.stdout.trimEnd() : '/another/run';
  assert.notEqual(storedId, runId);
  begin(root, storedId);
  const run = runSystemCheck(root, env);
  assert.match(run.stdout, /✗ "Nightly fire freshness and terminal evidence".*code=missing/);
  assert.equal(run.status, 1);
});

test('begin reports a watchdog error once and still starts the pass', () => {
  const { root, runtime } = fixture();
  mkdirSync(path.join(runtime, 'NIGHTLY_ALERTS.jsonl'));
  const started = begin(root);
  assert.match(started.stderr, /^NIGHTLY_WATCHDOG ERROR [^\r\n]+\r?\n$/);
  const state = JSON.parse(readFileSync(path.join(runtime, 'NIGHTLY_PASS_STATE.json'), 'utf8'));
  assert.equal(state.status, 'running');
});

function prepareGreenPass(root, now, date) {
  cpSync(DAEMONS, path.join(root, 'daemons'), {
    recursive: true, filter: file => file !== TEST_DIR,
  });
  cpSync(path.join(sourceRoot, 'skills'), path.join(root, 'skills'), { recursive: true });
  write(root, 'evals/check.json', '{}');
  initIgnoredGitFixture(root);
  writeValidReconcileInputs(root, date);
  healthySystemCheck(root, now);
}

function finishGreenPass(root, runId, now, date) {
  write(root, 'vault/memory/DREAM_LOG.md', `# Dream Log\n\n${canonicalDream(date)}`);
  for (const [name, artifact] of [
    ['dream', 'file:memory/DREAM_LOG.md'],
    ['reconcile', 'stdout:reconcile@exit=0'],
    ['context-hygiene', 'stdout:context-hygiene@exit=0'],
    ['sweep-now', 'file:memory/SWEEP_LOG.md'],
    ['heat-index', 'file:memory/HEAT_INDEX.json'],
    ['digest', 'none:no-staged-candidates'],
    ['system-check', null],
    ['cognitive-runtime', 'stdout:cognitive-runtime@exit=0'],
    ['ledger-capture', 'none:no-ledger-candidates'],
    ['ledger-review', 'stdout:ledger-review@exit=0'],
    ['vault-sync', 'none:nothing-to-commit'],
  ]) {
    if (name === 'system-check') {
      const run = runSystemCheck(root, { AIGENT_NIGHTLY_RUN_ID: runId }, root);
      const result = record(root, name, {
        status: run.status === 0 ? 'pass' : 'fail', exitCode: run.status,
        artifact: `stdout:system-check@exit=${run.status}`, now, timeout: 120_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + run.stdout);
      assert.match(result.stdout, /GREEN name=system-check status=pass exit=0/);
      continue;
    }
    const result = record(root, name, { artifact, status: name === 'digest' ? 'skipped' : 'pass', now });
    assert.equal(result.status, 0, result.stdout || result.stderr);
  }
  const finished = runNode(PASS_CLI, ['finish', '--root', root, '--no-deliver'], { root });
  assert.equal(finished.status, 0, finished.stdout || finished.stderr);
  assert.ok(finished.stdout.includes(`NIGHTLY_PASS GREEN run=${runId} status=pass`), finished.stdout);
  assert.match(readFileSync(path.join(root, nightlyLog), 'utf8'), /- system-check: status=PASS exit=0/);
}

test('system check checkpoint and pass finish green after a failed night', () => {
  const { root } = fixture();
  const now = new Date().toISOString();
  const date = zonedDateKey(now, TIME_ZONE);
  prepareGreenPass(root, now, date);
  const yesterday = new Date(`${date}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  write(root, nightlyLog, previousNight('FAIL', yesterday.toISOString().slice(0, 10)));
  const started = begin(root, undefined, date, now);
  finishGreenPass(root, started.stdout.match(/\brun=(\S+)/)[1], now, date);
});

test('begin prints only the start line and writes no alert after a green night', () => {
  const { root, runtime } = fixture();
  write(root, nightlyLog, previousNight('PASS'));
  const started = begin(root, undefined, PASS_DATE, beforeCutoff);
  assert.equal(started.stderr, '');
  assert.match(started.stdout, /^NIGHTLY_PASS BEGIN [^\r\n]+\r?\n$/);
  assert.equal(existsSync(path.join(runtime, 'NIGHTLY_ALERTS.jsonl')), false);
});

test('begin reports a missed night before a green pass and the next session start', () => {
  const { root, runtime } = fixture();
  const now = new Date().toISOString();
  const date = zonedDateKey(now, TIME_ZONE);
  prepareGreenPass(root, now, date);
  const day = new Date(`${date}T08:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  const missed = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() - 1);
  write(root, nightlyLog, previousNight('PASS', day.toISOString().slice(0, 10)));

  const started = begin(root, undefined, date, `${date}T08:00:00Z`);
  assert.match(started.stderr, /^\[NIGHTLY-ALERT: "NIGHTLY:NO_FIRE"\][^\r\n]+\r?\n$/);
  assert.ok(started.stderr.includes(`expected=${missed}`), started.stderr);
  const ledger = path.join(runtime, 'NIGHTLY_ALERTS.jsonl');
  const gapEvents = () => readFileSync(ledger, 'utf8').trimEnd().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.alert_id === `NIGHTLY:NO_FIRE:${missed}`);
  const raised = gapEvents();
  assert.deepEqual(raised.map(row => row.event), ['raised', 'delivery']);
  assert.equal(raised[1].status, 'active');
  assert.equal(raised[1].delivery.local, 'stderr');
  finishGreenPass(root, started.stdout.match(/\brun=(\S+)/)[1], now, date);
  assert.deepEqual(gapEvents(), raised);

  const boot = runNode(path.join(DAEMONS, 'sessionstart-reinject.mjs'), [], {
    root, input: JSON.stringify({ cwd: root, source: 'startup' }),
  });
  assert.equal(boot.status, 0, boot.stderr);
  assert.doesNotMatch(boot.stdout + boot.stderr, /NIGHTLY:NO_FIRE/);
  const events = gapEvents();
  assert.deepEqual(events.map(row => row.event), ['raised', 'delivery', 'resolved']);
  assert.equal(events[2].status, 'resolved');
  assert.equal(events[2].resolution, `fresh complete nightly block ${date}`);
  console.log(`Missed ${missed}: active after begin and finish, cleared at session start by ${date}.`);
});

test('mutation proof: every nightly checkpoint re-derives its own postcondition', () => {
  checkpointCase(
    'dream',
    ({ root }) => {
      write(root, 'vault/memory/DREAM_LOG.md', `# Dream Log\n\n## ${PASS_DATE}: incomplete\n`);
      return { artifact: 'file:memory/DREAM_LOG.md' };
    },
    ({ root }) => {
      write(root, 'vault/memory/DREAM_LOG.md', `# Dream Log\n\n${canonicalDream()}`);
      return { artifact: 'file:memory/DREAM_LOG.md' };
    },
  );

  checkpointCase(
    'reconcile',
    ({ root }) => {
      write(root, 'vault/memory/ACTIVE_PRIORITIES.md', '# Active Priorities\n');
      return { artifact: 'stdout:reconcile@exit=0' };
    },
    () => ({ artifact: 'stdout:reconcile@exit=0' }),
  );

  checkpointCase(
    'context-hygiene',
    ({ root }) => {
      write(root, 'vault/memory/SESSION_LOG.md', `- ${PASS_DATE} malformed\n`);
      return { artifact: 'stdout:context-hygiene@exit=0' };
    },
    () => ({ artifact: 'stdout:context-hygiene@exit=0' }),
  );

  checkpointCase(
    'sweep-now',
    ({ root }) => {
      write(root, 'vault/memory/SWEEP_LOG.md', '### 2026-02-01\n');
      return { artifact: 'file:memory/SWEEP_LOG.md' };
    },
    ({ root }) => {
      write(root, 'vault/memory/SWEEP_LOG.md', `### ${PASS_DATE}\n`);
      return { artifact: 'file:memory/SWEEP_LOG.md' };
    },
  );

  checkpointCase(
    'heat-index',
    ({ root }) => {
      write(root, 'vault/memory/HEAT_INDEX.json', JSON.stringify({
        generated_at: '2026-03-01T00:00:00.000Z',
        hot_top_20: [],
        total_notes: 0,
      }));
      return { artifact: 'file:memory/HEAT_INDEX.json' };
    },
    ({ root }) => {
      write(root, 'vault/memory/HEAT_INDEX.json', JSON.stringify({
        generated_at: AFTER_BEGIN,
        hot_top_20: [],
        total_notes: 0,
      }));
      return { artifact: 'file:memory/HEAT_INDEX.json' };
    },
  );

  checkpointCase(
    'digest',
    ({ root }) => {
      write(root, 'vault/memory/MEMORY_CANDIDATES.md', '| Candidate | Status |\n|---|---|\n| proof | staged |\n');
      return { artifact: 'none:no-staged-candidates', status: 'skipped' };
    },
    () => ({ artifact: 'none:no-staged-candidates', status: 'skipped' }),
  );

  checkpointCase(
    'system-check',
    ({ root }) => {
      writeSystemCheck(root, 1);
      return { artifact: 'stdout:system-check@exit=0' };
    },
    () => ({ artifact: 'stdout:system-check@exit=0' }),
  );

  checkpointCase(
    'cognitive-runtime',
    ({ root }) => {
      write(root, 'vault/memory/runtime/GOAL_STACK.json', '{invalid json\n');
      return { artifact: 'stdout:cognitive-runtime@exit=0' };
    },
    () => ({ artifact: 'stdout:cognitive-runtime@exit=0' }),
  );

  checkpointCase(
    'ledger-capture',
    ({ root }) => {
      write(root, 'vault/memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl', `${JSON.stringify({
        candidate_id: 'nc-20260310-01',
        status: 'staged',
      })}\n`);
      return { artifact: 'none:no-ledger-candidates' };
    },
    () => ({ artifact: 'none:no-ledger-candidates' }),
  );

  checkpointCase(
    'ledger-review',
    ({ root }) => {
      write(root, 'vault/memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl', '{invalid json\n');
      return { artifact: 'stdout:ledger-review@exit=0' };
    },
    () => ({ artifact: 'stdout:ledger-review@exit=0' }),
  );

  checkpointCase(
    'vault-sync',
    ({ root }) => {
      initIgnoredGitFixture(root, { visibleFile: true });
      write(root, 'uncommitted-proof.txt', 'dirty\n');
      return { artifact: 'none:nothing-to-commit' };
    },
    ({ root }) => {
      initIgnoredGitFixture(root);
      return { artifact: 'none:nothing-to-commit' };
    },
  );
});
