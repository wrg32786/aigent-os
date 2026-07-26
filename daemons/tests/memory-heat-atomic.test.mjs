// Mutation proofs for the memory-heat atomic writer and temp-file ignore rule.
// Mutated module copies and all outputs live below the operating system temp dir.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const HEAT_MODULE = path.join(REPO_ROOT, 'daemons', 'memory-heat', 'compute-heat.js');
const GITIGNORE = path.join(REPO_ROOT, '.gitignore');
const tempRoots = [];

function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function fixture(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `aigent-heat-${label}-`));
  tempRoots.push(root);
  return root;
}

function isolatedEnv(root) {
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
    AIGENT_ROOT: root,
    AIGENT_VAULT_ROOT: path.join(root, 'vault'),
    AIGENT_OS_ROOT: root,
    AIGENT_PROJECT_DIR: root,
    AIGENT_STATE_HOME_DIR: root,
    AIGENT_NIGHTLY_TIME_ZONE: 'America/Los_Angeles',
    AIGENT_NIGHTLY_CUTOFF_HOUR: '4',
    TZ: 'UTC',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function runNode(file, args, root) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    env: isolatedEnv(root),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
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

function atomicRunner(root) {
  return write(root, 'runner/atomic-proof.cjs', [
    "const fs = require('node:fs');",
    'const modulePath = process.argv[2];',
    'const output = process.argv[3];',
    'const proofPid = Number(process.argv[4]);',
    'const { writeHeatIndexAtomic } = require(modulePath);',
    'fs.mkdirSync(require("node:path").dirname(output), { recursive: true });',
    'const previous = \'{"generation":"previous"}\';',
    'fs.writeFileSync(output, previous, "utf8");',
    'const reports = [];',
    'const fsImpl = {',
    '  writeFileSync: fs.writeFileSync,',
    '  existsSync: fs.existsSync,',
    '  unlinkSync: fs.unlinkSync,',
    '  renameSync() {',
    '    const error = new Error("fixture rename denied");',
    '    error.code = "EPERM";',
    '    throw error;',
    '  },',
    '};',
    'let caught = null;',
    'try {',
    '  writeHeatIndexAtomic(output, \'{"generation":"new"}\', {',
    '    fsImpl,',
    '    pid: proofPid,',
    '    report: (message) => reports.push(String(message)),',
    '  });',
    '} catch (error) {',
    '  caught = error;',
    '}',
    'const temp = `${output}.tmp-${proofPid}`;',
    'const priorPreserved = fs.readFileSync(output, "utf8") === previous;',
    'const tempRemoved = !fs.existsSync(temp);',
    'const named = reports.length === 1',
    '  && /MEMORY_HEAT_WRITE FAIL code=EPERM stage=rename cleanup=removed/.test(reports[0])',
    '  && /MEMORY_HEAT_WRITE FAIL code=EPERM stage=rename cleanup=removed/.test(String(caught?.message));',
    'const ok = caught?.code === "EPERM" && priorPreserved && tempRemoved && named;',
    'process.stdout.write(',
    '  `HEAT_ATOMIC ${ok ? "PASS" : "FAIL"} code=${caught?.code || "none"} prior_preserved=${priorPreserved} temp_removed=${tempRemoved} reports=${reports.length} message=${JSON.stringify(caught?.message || "")}\\n`,',
    ');',
    'process.exitCode = ok ? 0 : 1;',
    '',
  ].join('\n'));
}

function ignoreRunner(root) {
  return write(root, 'runner/ignore-proof.cjs', [
    "const fs = require('node:fs');",
    'const text = fs.readFileSync(process.argv[2], "utf8");',
    'const ok = /^vault\\/memory\\/HEAT_INDEX\\.json\\.tmp-\\*$/m.test(text);',
    'process.stdout.write(`HEAT_TEMP_IGNORE ${ok ? "PASS" : "FAIL"} pattern=vault/memory/HEAT_INDEX.json.tmp-*\\n`);',
    'process.exitCode = ok ? 0 : 1;',
    '',
  ].join('\n'));
}

test.after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    } catch {
      // Best effort for transient locks.
    }
  }
});

test('mutation proof: rename failure is named, preserves the prior index, and removes temp output', () => {
  const root = fixture('atomic');
  const source = readFileSync(HEAT_MODULE, 'utf8');
  const cleanupLine = 'fsImpl.unlinkSync(tempOutput);';
  const reportLine = 'report(message);';
  assert.ok(source.includes(cleanupLine), 'production writer must contain its temp cleanup');
  assert.ok(source.includes(reportLine), 'production writer must report the named failure');

  const mutated = source
    .replace(cleanupLine, '/* mutation: cleanup removed */')
    .replace(reportLine, '/* mutation: report removed */');
  assert.notEqual(mutated, source);
  const brokenModule = write(root, 'modules/compute-heat-broken.cjs', mutated);
  const runner = atomicRunner(root);
  const brokenOutput = path.join(root, 'broken', 'vault', 'memory', 'HEAT_INDEX.json');
  const broken = runNode(runner, [brokenModule, brokenOutput, '4701'], root);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /HEAT_ATOMIC FAIL/);
  assert.match(broken.stdout, /prior_preserved=true/);
  assert.match(broken.stdout, /temp_removed=false/);
  assert.match(broken.stdout, /reports=0/);
  proof('BREAK heat-atomic', broken);

  const restoredOutput = path.join(root, 'restored', 'vault', 'memory', 'HEAT_INDEX.json');
  const restored = runNode(runner, [HEAT_MODULE, restoredOutput, '4702'], root);
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.match(restored.stdout, /HEAT_ATOMIC PASS/);
  assert.match(restored.stdout, /prior_preserved=true/);
  assert.match(restored.stdout, /temp_removed=true/);
  assert.match(restored.stdout, /reports=1/);
  proof('RESTORE heat-atomic', restored);
});

test('mutation proof: the full family of atomic temp outputs is ignored', () => {
  const root = fixture('ignore');
  const original = readFileSync(GITIGNORE, 'utf8');
  const pattern = 'vault/memory/HEAT_INDEX.json.tmp-*';
  assert.ok(original.split(/\r?\n/).includes(pattern));
  const mutated = original.split(/\r?\n/).filter((line) => line !== pattern).join('\n');
  const candidate = write(root, 'gitignore-fixture', mutated);
  const runner = ignoreRunner(root);

  const broken = runNode(runner, [candidate], root);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /HEAT_TEMP_IGNORE FAIL/);
  proof('BREAK heat-temp-ignore', broken);

  writeFileSync(candidate, original, 'utf8');
  const restored = runNode(runner, [candidate], root);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /HEAT_TEMP_IGNORE PASS/);
  proof('RESTORE heat-temp-ignore', restored);
});
