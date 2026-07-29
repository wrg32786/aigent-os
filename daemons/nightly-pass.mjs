#!/usr/bin/env node
// Evidence controller for the seven-leg nightly framework. Eleven checkpoints
// are independently recorded; any missing or failed checkpoint makes the pass
// fail and raises a named durable alert.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emitNightlyAlert, resolveNightlyAlerts,
} from './nightly-alerts.mjs';
import {
  maskMarkdownFences, newestDatedHeader, validDateKey, zonedDateKey,
} from './nightly-freshness.mjs';
import {
  captureNightlyContractSnapshot,
  validateCognitiveContract,
  validateDreamContract,
} from './nightly-contracts.mjs';
import { reviewNightlyLedgers } from './nightly-ledger-review.mjs';
import {
  buildNightlyChildEnv,
  defaultNightlyRoot,
  pathInside,
  pathInsideOperationalRoots,
  resolveMemoryRelative,
  resolveNightlyConfig,
  resolveNightlyPaths,
  resolveRepositoryOrMemoryPath,
} from './nightly-paths.mjs';
import { inert } from './lifecycle-common.mjs';

export const NIGHTLY_PROTOCOL = 'close-parity-v2-7L-11C';
export const NIGHTLY_CHECKPOINTS = Object.freeze([
  'dream',
  'reconcile',
  'context-hygiene',
  'sweep-now',
  'heat-index',
  'digest',
  'system-check',
  'cognitive-runtime',
  'ledger-capture',
  'ledger-review',
  'vault-sync',
]);
export const NIGHTLY_SKIPPABLE_CHECKPOINTS = Object.freeze([
  'sweep-now',
  'digest',
]);

const ARTIFACT_SCHEMES = Object.freeze({
  dream: ['file'],
  reconcile: ['stdout'],
  'context-hygiene': ['stdout'],
  'sweep-now': ['file'],
  'heat-index': ['file'],
  digest: ['file', 'none'],
  'system-check': ['stdout'],
  'cognitive-runtime': ['stdout'],
  'ledger-capture': ['file', 'stdout', 'none'],
  'ledger-review': ['stdout'],
  'vault-sync': ['git', 'none'],
});

const NONE_REASONS = Object.freeze({
  digest: ['no-staged-candidates'],
  'ledger-capture': ['no-ledger-candidates'],
  'vault-sync': ['nothing-to-commit'],
});

const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));

function statePath(root) {
  return path.join(resolveNightlyPaths(root).runtimeRoot, 'NIGHTLY_PASS_STATE.json');
}

function logPath(root) {
  return path.join(resolveNightlyPaths(root).runtimeRoot, 'NIGHTLY_LOG.md');
}

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, file);
}

function readState(root) {
  const file = statePath(root);
  if (!existsSync(file)) throw new Error(`nightly state missing: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function optionalText(paths, relative, { required = false } = {}) {
  const file = resolveMemoryRelative(paths, relative);
  if (!existsSync(file)) {
    if (required) throw new Error(`required nightly input missing: memory/${relative}`);
    return null;
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (required) {
      throw new Error(
        `required nightly input unreadable: memory/${relative}: ${error?.message || error}`,
      );
    }
    return null;
  }
}

function jsonlLineCount(text) {
  if (text === null || text === undefined) return 0;
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    try {
      JSON.parse(line);
    } catch (error) {
      throw new Error(`JSONL snapshot line ${index + 1} invalid: ${error?.message || error}`);
    }
  }
  return lines.length;
}

function captureFireSnapshot(paths) {
  const candidates = optionalText(
    paths,
    'runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl',
    { required: true },
  );
  optionalText(paths, 'MEMORY_CANDIDATES.md', { required: true });
  return {
    contract_snapshot: captureNightlyContractSnapshot({
      dreamText: optionalText(paths, 'DREAM_LOG.md'),
      lessonsText: optionalText(paths, 'runtime/LESSONS.jsonl'),
      beliefsText: optionalText(paths, 'runtime/BELIEF_STATE.jsonl'),
      proceduresText: optionalText(paths, 'runtime/PROCEDURES.jsonl'),
      selfModelText: optionalText(paths, 'runtime/SELF_MODEL.json'),
    }),
    ledger_snapshot: {
      candidate_lines: jsonlLineCount(candidates),
    },
  };
}

function boundedOutput(value, max = 1_500) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' | ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function runKnown(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: options.env,
  });
  return {
    status: Number.isInteger(result.status) ? result.status : 2,
    output: boundedOutput(
      [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'),
    ),
  };
}

function bashExecutable() {
  const windowsRoot = process.platform === 'win32'
    ? path.parse(
      process.env.SystemRoot
        || process.env.SYSTEMROOT
        || process.env.WINDIR
        || process.env.ComSpec
        || process.env.COMSPEC
        || 'C:\\',
    ).root
    : null;
  const candidates = [
    process.env.AIGENT_BASH_EXE,
    process.env.BASH_EXE,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
      : null,
    process.env.ProgramW6432
      ? path.join(process.env.ProgramW6432, 'Git', 'bin', 'bash.exe')
      : null,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : null,
    windowsRoot
      ? path.join(windowsRoot, 'Program Files', 'Git', 'bin', 'bash.exe')
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || 'bash';
}

function stagedMemoryCandidateCount(paths) {
  const text = optionalText(paths, 'MEMORY_CANDIDATES.md', { required: true });
  return (maskMarkdownFences(text).match(/\|[ \t]*staged[ \t]*\|/gi) || []).length;
}

function stagedNightlyCandidateCount(paths) {
  const text = optionalText(
    paths,
    'runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl',
    { required: true },
  );
  return String(text).split(/\r?\n/).filter(Boolean).reduce((count, line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`nightly candidate line ${index + 1} invalid: ${error?.message || error}`);
    }
    return count + (row.status === 'staged' ? 1 : 0);
  }, 0);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      index += 1;
    } else out[key] = true;
  }
  return out;
}

function normalizedDate(value) {
  const date = String(value || '');
  if (!validDateKey(date)) throw new Error(`invalid pass date: ${date}`);
  return date;
}

function realPathAllowed(paths, target) {
  const realTarget = realpathSync(target);
  const roots = [paths.repositoryRoot, paths.stateRoot]
    .filter(existsSync)
    .map((root) => realpathSync(root));
  return roots.some((root) => pathInside(root, realTarget));
}

function childContext(root, state) {
  const paths = resolveNightlyPaths(root);
  return {
    paths,
    env: buildNightlyChildEnv({
      paths,
      timeZone: state.time_zone,
      cutoffHour: state.cutoff_hour,
    }),
  };
}

function commandPostcondition(root, checkpoint, state, exitCode, now) {
  const paths = resolveNightlyPaths(root);
  try {
    if (checkpoint === 'dream') {
      const result = validateDreamContract({
        dreamText: readFileSync(resolveMemoryRelative(paths, 'DREAM_LOG.md'), 'utf8'),
        lessonsText: readFileSync(
          resolveMemoryRelative(paths, 'runtime/LESSONS.jsonl'),
          'utf8',
        ),
        passDate: state.pass_date,
        dreamSnapshot: state.contract_snapshot?.dream,
        lessonSnapshot: state.contract_snapshot?.lessons,
      });
      return {
        ok: result.ok === (exitCode === 0),
        output: result.output,
        actualExit: result.ok ? 0 : 1,
      };
    }
    if (checkpoint === 'cognitive-runtime') {
      const result = validateCognitiveContract({
        goalsText: readFileSync(
          resolveMemoryRelative(paths, 'runtime/GOAL_STACK.json'),
          'utf8',
        ),
        beliefsText: readFileSync(
          resolveMemoryRelative(paths, 'runtime/BELIEF_STATE.jsonl'),
          'utf8',
        ),
        selfModelText: readFileSync(
          resolveMemoryRelative(paths, 'runtime/SELF_MODEL.json'),
          'utf8',
        ),
        proceduresText: readFileSync(
          resolveMemoryRelative(paths, 'runtime/PROCEDURES.jsonl'),
          'utf8',
        ),
        cognitiveSnapshot: state.contract_snapshot,
      });
      return {
        ok: result.ok === (exitCode === 0),
        output: result.output,
        actualExit: result.ok ? 0 : 1,
      };
    }
    if (checkpoint === 'reconcile') {
      const context = childContext(root, state);
      const run = runKnown(process.execPath, [
        path.join(DAEMON_DIR, 'nightly-reconcile.mjs'),
        '--root', context.paths.repositoryRoot,
        '--as-of', state.pass_date,
      ], {
        cwd: context.paths.repositoryRoot,
        env: context.env,
      });
      return {
        ok: run.status === exitCode
          && (exitCode !== 0 || /\bRECONCILE PASS\b/.test(run.output)),
        output: run.output,
        actualExit: run.status,
      };
    }
    if (checkpoint === 'context-hygiene') {
      const context = childContext(root, state);
      const run = runKnown(process.execPath, [
        path.join(DAEMON_DIR, 'nightly-context-hygiene.mjs'),
        '--root', context.paths.repositoryRoot,
      ], {
        cwd: context.paths.repositoryRoot,
        env: context.env,
      });
      return {
        ok: run.status === exitCode
          && (exitCode !== 0 || /\bCONTEXT_HYGIENE PASS\b/.test(run.output)),
        output: run.output,
        actualExit: run.status,
      };
    }
    if (checkpoint === 'system-check') {
      const context = childContext(root, state);
      const run = runKnown(
        bashExecutable(),
        [path.join(context.paths.repositoryRoot, 'daemons', 'system-check.sh')],
        {
          cwd: context.paths.repositoryRoot,
          env: context.env,
        },
      );
      return {
        ok: run.status === exitCode,
        output: run.output || `system-check exit=${run.status}`,
        actualExit: run.status,
      };
    }
    if (checkpoint === 'ledger-review') {
      const result = reviewNightlyLedgers({
        root,
        now,
        timeZone: state.time_zone,
      });
      return {
        ok: exitCode === 0 && result.ok,
        output: result.output,
        actualExit: result.ok ? 0 : 1,
      };
    }
    if (checkpoint === 'ledger-capture') {
      const current = jsonlLineCount(optionalText(
        paths,
        'runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl',
        { required: true },
      ));
      const ok = exitCode === 0
        && current >= Number(state.ledger_snapshot?.candidate_lines || 0);
      return {
        ok,
        output: `LEDGER_CAPTURE_POSTCONDITION ${ok ? 'PASS' : 'FAIL'}`
          + ` before=${state.ledger_snapshot?.candidate_lines || 0}`
          + ` after=${current} staged=${stagedNightlyCandidateCount(paths)}`,
        actualExit: ok ? 0 : 1,
      };
    }
    if (checkpoint === 'digest') {
      const staged = stagedMemoryCandidateCount(paths);
      const actualExit = staged > 0 ? 0 : 1;
      return {
        ok: actualExit === exitCode,
        output: `DIGEST_POSTCONDITION ${actualExit === 0 ? 'PASS' : 'FAIL'}`
          + ` staged=${staged} source=memory/MEMORY_CANDIDATES.md`,
        actualExit,
      };
    }
  } catch (error) {
    return {
      ok: exitCode !== 0,
      output: `${checkpoint} postcondition error: ${error?.message || error}`,
      actualExit: 1,
    };
  }
  return { ok: true, output: '', actualExit: exitCode };
}

function artifactCheck(root, ref, {
  checkpoint,
  state,
  status,
  exitCode,
  now,
} = {}) {
  const paths = resolveNightlyPaths(root);
  const value = String(ref || '').trim();
  if (!value) return { ok: false, detail: 'artifact reference missing' };
  const match = value.match(/^(file|git|stdout|none):(.+)$/);
  if (!match) {
    return {
      ok: false,
      detail: 'artifact must use file:|git:|stdout:|none: scheme',
    };
  }
  const [, scheme, payload] = match;
  if (!ARTIFACT_SCHEMES[checkpoint]?.includes(scheme)) {
    return { ok: false, detail: `${scheme}: artifact is not allowed for ${checkpoint}` };
  }
  if (checkpoint === 'digest') {
    const staged = stagedMemoryCandidateCount(paths);
    if (status === 'skipped' && (scheme !== 'none' || staged !== 0)) {
      return {
        ok: false,
        detail: `digest skip requires zero staged rows; observed=${staged}`,
      };
    }
    if (status === 'pass' && staged === 0) {
      return { ok: false, detail: 'digest pass requires at least one staged row to surface' };
    }
  }

  if (scheme === 'none') {
    if (!NONE_REASONS[checkpoint]?.includes(payload)) {
      return { ok: false, detail: `none: reason is not allowed for ${checkpoint}` };
    }
    if (checkpoint === 'digest' && stagedMemoryCandidateCount(paths) !== 0) {
      return {
        ok: false,
        detail: 'digest claimed no staged candidates but staged rows exist',
      };
    }
    if (checkpoint === 'ledger-capture') {
      const current = jsonlLineCount(optionalText(
        paths,
        'runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl',
        { required: true },
      ));
      if (current !== Number(state.ledger_snapshot?.candidate_lines || 0)) {
        return {
          ok: false,
          detail: `ledger capture claimed none but candidate lines changed`
            + ` ${state.ledger_snapshot?.candidate_lines || 0}->${current}`,
        };
      }
    }
    if (checkpoint === 'vault-sync') {
      const context = childContext(root, state);
      const run = runKnown(
        'git',
        ['-C', context.paths.repositoryRoot, 'status', '--porcelain'],
        {
          cwd: context.paths.repositoryRoot,
          env: context.env,
        },
      );
      if (run.status !== 0 || run.output) {
        return {
          ok: false,
          detail: `vault sync claimed nothing-to-commit but git status was`
            + ` ${run.status}: ${run.output || 'unavailable'}`,
        };
      }
    }
    return {
      ok: true,
      detail: value,
      validator: `${checkpoint.toUpperCase()} NONE_PREDICATE PASS reason=${payload}`,
    };
  }

  if (scheme === 'stdout') {
    const parsed = payload.match(/^([a-z][a-z0-9-]*)@exit=(-?\d+)$/);
    if (!parsed || parsed[1] !== checkpoint || Number(parsed[2]) !== exitCode) {
      return {
        ok: false,
        detail: `stdout artifact must be stdout:${checkpoint}@exit=${exitCode}`,
      };
    }
    const postcondition = commandPostcondition(
      root,
      checkpoint,
      state,
      exitCode,
      now,
    );
    if (!postcondition.ok) {
      return {
        ok: false,
        detail: `${checkpoint} executable postcondition`
          + ` exit=${postcondition.actualExit}: ${boundedOutput(postcondition.output)}`,
        validator: postcondition.output,
      };
    }
    return { ok: true, detail: value, validator: postcondition.output };
  }

  if (scheme === 'git') {
    if (!/^[0-9a-f]{7,40}$/i.test(payload)) {
      return {
        ok: false,
        detail: 'git artifact must be a 7-40 character hexadecimal commit id',
      };
    }
    try {
      const context = childContext(root, state);
      execFileSync(
        'git',
        ['-C', context.paths.repositoryRoot, 'cat-file', '-e', `${payload}^{commit}`],
        {
          stdio: 'ignore',
          windowsHide: true,
          env: context.env,
        },
      );
      const head = execFileSync(
        'git',
        ['-C', context.paths.repositoryRoot, 'rev-parse', 'HEAD'],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: context.env,
        },
      ).trim();
      const resolved = execFileSync(
        'git',
        ['-C', context.paths.repositoryRoot, 'rev-parse', payload],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: context.env,
        },
      ).trim();
      if (resolved !== head) {
        return {
          ok: false,
          detail: `git artifact ${payload} is not current HEAD ${head}`,
        };
      }
    } catch {
      return { ok: false, detail: `git commit is not present in repository: ${payload}` };
    }
    return { ok: true, detail: value, validator: `GIT_COMMIT PASS sha=${payload}` };
  }

  const target = resolveRepositoryOrMemoryPath(paths, payload);
  if (!pathInsideOperationalRoots(paths, target)) {
    return { ok: false, detail: `artifact file escapes operational roots: ${payload}` };
  }
  if (!existsSync(target)) return { ok: false, detail: `artifact file missing: ${payload}` };
  try {
    if (!realPathAllowed(paths, target)) {
      return { ok: false, detail: `artifact file resolves outside operational roots: ${payload}` };
    }
  } catch (error) {
    return { ok: false, detail: `artifact file unreadable: ${error?.message || error}` };
  }

  const canonicalFiles = {
    dream: 'memory/DREAM_LOG.md',
    'sweep-now': 'memory/SWEEP_LOG.md',
    'heat-index': 'memory/HEAT_INDEX.json',
    digest: 'memory/MEMORY_CANDIDATES.md',
    'ledger-capture': 'memory/runtime/NIGHTLY_CAPTURE_CANDIDATES.jsonl',
  };
  if (canonicalFiles[checkpoint]) {
    const canonical = resolveRepositoryOrMemoryPath(paths, canonicalFiles[checkpoint]);
    if (path.resolve(target) !== path.resolve(canonical)) {
      return {
        ok: false,
        detail: `${checkpoint} artifact must be canonical ${canonicalFiles[checkpoint]}`,
      };
    }
  }

  if (checkpoint === 'dream') {
    const newest = newestDatedHeader(readFileSync(target, 'utf8'), 'dream').newest;
    if (newest !== state.pass_date) {
      return {
        ok: false,
        detail: `dream artifact newest header ${newest || 'none'}`
          + ` does not match pass date ${state.pass_date}`,
      };
    }
    const postcondition = commandPostcondition(root, checkpoint, state, exitCode, now);
    if (!postcondition.ok) {
      return {
        ok: false,
        detail: boundedOutput(postcondition.output),
        validator: postcondition.output,
      };
    }
    return { ok: true, detail: value, validator: postcondition.output };
  }
  if (checkpoint === 'heat-index') {
    try {
      const heat = JSON.parse(readFileSync(target, 'utf8'));
      const generated = Date.parse(String(heat.generated_at || ''));
      const started = Date.parse(state.started_at);
      const observed = (now instanceof Date ? now : new Date(now)).getTime();
      if (!Number.isFinite(generated)
          || generated < started - 60_000
          || generated > observed + 60_000
          || !Array.isArray(heat.hot_top_20)
          || !Number.isInteger(heat.total_notes)
          || heat.total_notes < 0) {
        return {
          ok: false,
          detail: 'heat artifact schema or generated_at is stale/invalid for this pass',
        };
      }
    } catch (error) {
      return { ok: false, detail: `heat artifact invalid JSON: ${error?.message || error}` };
    }
  }
  if (checkpoint === 'digest') {
    const postcondition = commandPostcondition(root, checkpoint, state, exitCode, now);
    if (!postcondition.ok) {
      return {
        ok: false,
        detail: boundedOutput(postcondition.output),
        validator: postcondition.output,
      };
    }
    return { ok: true, detail: value, validator: postcondition.output };
  }
  if (checkpoint === 'sweep-now') {
    const searchable = maskMarkdownFences(readFileSync(target, 'utf8'));
    const dates = [
      ...searchable.matchAll(/^###[ \t]+(\d{4}-\d{2}-\d{2})\b/gm),
    ]
      .map((entry) => entry[1])
      .filter(validDateKey)
      .sort();
    const newest = dates.at(-1);
    if (!newest) {
      return { ok: false, detail: 'sweep artifact has no valid dated H3 header' };
    }
    const age = Math.round(
      (
        Date.parse(`${state.pass_date}T00:00:00Z`)
        - Date.parse(`${newest}T00:00:00Z`)
      ) / 86_400_000,
    );
    if ((status === 'skipped' && (age < 0 || age > 7))
        || (status !== 'skipped' && newest !== state.pass_date)) {
      return {
        ok: false,
        detail: `sweep cadence header ${newest} is invalid`
          + ` for ${status} on ${state.pass_date}`,
      };
    }
    return {
      ok: true,
      detail: value,
      validator: `SWEEP_CADENCE PASS newest=${newest} age_days=${age}`,
    };
  }
  if (checkpoint === 'ledger-capture') {
    const postcondition = commandPostcondition(root, checkpoint, state, exitCode, now);
    if (!postcondition.ok) {
      return {
        ok: false,
        detail: postcondition.output,
        validator: postcondition.output,
      };
    }
    return { ok: true, detail: value, validator: postcondition.output };
  }
  return {
    ok: true,
    detail: value,
    validator: `${checkpoint.toUpperCase()} ARTIFACT PASS ${value}`,
  };
}

function logPreamble() {
  return [
    '---',
    'title: "Nightly Log"',
    'tags: [runtime, nightly, evidence]',
    '---',
    '',
    '# Nightly Log',
    '',
    'Append-only evidence emitted by daemons/nightly-pass.mjs.',
    '',
  ].join('\n');
}

function cleanDetail(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
}

export async function beginNightlyPass({
  root = defaultNightlyRoot(),
  date,
  runId,
  now = new Date(),
  replace = false,
  deliver = true,
  timeZone,
  cutoffHour,
  stderr = process.stderr,
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const config = resolveNightlyConfig({ timeZone, cutoffHour });
  const passDate = normalizedDate(
    date || zonedDateKey(instant, config.timeZone),
  );
  const timestamp = instant.toISOString();
  const file = statePath(root);
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, 'utf8'));
    if (previous.status === 'running' && !replace) {
      throw new Error(`nightly pass already running: ${inert(previous.run_id, 200)}`);
    }
    if (previous.status === 'running' && replace) {
      await emitNightlyAlert({
        root,
        code: 'NIGHTLY:ABANDONED_PASS',
        summary: `previous nightly pass abandoned (${inert(previous.run_id, 200)})`,
        detail: `replacement started at ${timestamp}`,
        evidence: `memory/runtime/NIGHTLY_PASS_STATE.json run=${inert(previous.run_id, 200)}`,
        scope: previous.run_id,
        now,
        deliver,
        timeZone: config.timeZone,
        stderr,
      });
    }
  }
  const paths = resolveNightlyPaths(root);
  const snapshots = captureFireSnapshot(paths);
  const state = {
    schema_version: 1,
    protocol: NIGHTLY_PROTOCOL,
    run_id: String(runId || `${passDate}-${timestamp.replace(/[:.]/g, '')}`),
    pass_date: passDate,
    time_zone: config.timeZone,
    cutoff_hour: config.cutoffHour,
    started_at: timestamp,
    finished_at: null,
    status: 'running',
    expected_checkpoints: [...NIGHTLY_CHECKPOINTS],
    checkpoints: {},
    contract_snapshot: snapshots.contract_snapshot,
    ledger_snapshot: snapshots.ledger_snapshot,
    protocol_errors: [],
    alert_path: 'memory/runtime/NIGHTLY_ALERTS.jsonl',
    log_written: false,
    alerts_resolved: false,
  };
  atomicJson(file, state);
  return state;
}

export async function recordNightlyCheckpoint({
  root = defaultNightlyRoot(),
  checkpoint,
  status,
  exitCode,
  detail,
  artifact,
  now = new Date(),
  deliver = true,
  stderr = process.stderr,
} = {}) {
  const state = readState(root);
  if (state.status !== 'running') {
    throw new Error(`nightly pass is not running: ${state.status}`);
  }
  if (!NIGHTLY_CHECKPOINTS.includes(checkpoint)) {
    throw new Error(`unknown nightly checkpoint: ${checkpoint}`);
  }
  if (!['pass', 'skipped', 'fail'].includes(status)) {
    throw new Error(`invalid checkpoint status: ${status}`);
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  if (state.checkpoints[checkpoint]) {
    const protocolError = {
      code: `NIGHTLY:DUPLICATE_CHECKPOINT:${checkpoint}`,
      checkpoint,
      recorded_at: instant.toISOString(),
      detail: 'checkpoint record refused; original evidence preserved',
    };
    if (!state.protocol_errors.some((entry) => entry.code === protocolError.code)) {
      state.protocol_errors.push(protocolError);
      atomicJson(statePath(root), state);
      await emitNightlyAlert({
        root,
        code: protocolError.code,
        summary: `${checkpoint} checkpoint was recorded more than once`,
        detail: protocolError.detail,
        evidence: `memory/runtime/NIGHTLY_PASS_STATE.json run=${state.run_id}`,
        scope: state.run_id,
        now: instant,
        deliver,
        timeZone: state.time_zone,
        stderr,
      });
    }
    throw new Error(
      `checkpoint already recorded; start a new pass instead of overwriting evidence:`
      + ` ${checkpoint}`,
    );
  }
  const code = Number(exitCode);
  if (!Number.isInteger(code)) {
    throw new Error(`exit code must be an integer: ${exitCode}`);
  }
  const skipAllowed = status !== 'skipped'
    || NIGHTLY_SKIPPABLE_CHECKPOINTS.includes(checkpoint);
  let artifactResult;
  try {
    artifactResult = artifactCheck(root, artifact, {
      checkpoint,
      state,
      status,
      exitCode: code,
      now: instant,
    });
  } catch (error) {
    artifactResult = {
      ok: false,
      detail: `${checkpoint} artifact validation error: ${error?.message || error}`,
    };
  }
  const normalizedStatus = status === 'fail'
    || code !== 0
    || !artifactResult.ok
    || !skipAllowed
    ? 'fail'
    : status;
  const validationDetail = [
    !skipAllowed ? `${checkpoint} is mandatory and cannot be skipped` : '',
    !artifactResult.ok ? artifactResult.detail : '',
  ].filter(Boolean).join('; ');
  const record = {
    checkpoint,
    status: normalizedStatus,
    exit_code: code,
    recorded_at: instant.toISOString(),
    detail: cleanDetail(
      validationDetail ? `${detail || ''}; ${validationDetail}` : detail,
    ),
    artifact: String(artifact || ''),
    validator: boundedOutput(artifactResult.validator || artifactResult.detail),
    alert: normalizedStatus === 'fail'
      ? `memory/runtime/NIGHTLY_ALERTS.jsonl#NIGHTLY:LEG_FAIL:${checkpoint}:${state.run_id}`
      : 'none',
  };
  state.checkpoints[checkpoint] = record;
  atomicJson(statePath(root), state);

  if (normalizedStatus === 'fail') {
    await emitNightlyAlert({
      root,
      code: `NIGHTLY:LEG_FAIL:${checkpoint}`,
      summary: `${checkpoint} checkpoint failed (exit ${code})`,
      detail: record.detail,
      evidence: `${record.artifact || 'none'} run=${state.run_id}`,
      scope: state.run_id,
      now: instant,
      deliver,
      timeZone: state.time_zone,
      stderr,
    });
  }
  return record;
}

function appendPassLog(root, state) {
  const file = logPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, logPreamble(), 'utf8');
  const exactHeader = `## Nightly Pass -- ${state.pass_date} (${state.run_id})`;
  if (readFileSync(file, 'utf8').includes(exactHeader)) return file;
  const records = NIGHTLY_CHECKPOINTS
    .filter((checkpoint) => state.checkpoints[checkpoint])
    .map((checkpoint) => state.checkpoints[checkpoint]);
  const passed = records.filter((record) => record.status === 'pass').length;
  const skipped = records.filter((record) => record.status === 'skipped').length;
  const failed = records.filter((record) => record.status === 'fail').length;
  const lines = [
    '',
    exactHeader,
    `protocol: ${state.protocol}`,
    `status: ${state.status.toUpperCase()}`,
    `time_zone: ${state.time_zone}`,
    `cutoff_hour: ${state.cutoff_hour}`,
    `started_at: ${state.started_at}`,
    `completed_at: ${state.finished_at}`,
    `framework_legs: 7 | checkpoints: ${records.length}/${NIGHTLY_CHECKPOINTS.length}`
      + ` | pass: ${passed} | skipped: ${skipped} | fail: ${failed}`
      + ` | protocol_errors: ${state.protocol_errors?.length || 0}`,
    'alert_path: memory/runtime/NIGHTLY_ALERTS.jsonl',
    '',
  ];
  for (const checkpoint of NIGHTLY_CHECKPOINTS) {
    const record = state.checkpoints[checkpoint];
    if (!record) {
      lines.push(
        `- ${checkpoint}: status=MISSING exit=1 evidence=none`
        + ' alert=memory/runtime/NIGHTLY_ALERTS.jsonl validator=none',
      );
    } else {
      lines.push(
        `- ${checkpoint}: status=${record.status.toUpperCase()}`
        + ` exit=${record.exit_code} evidence=${record.artifact}`
        + ` alert=${record.alert} recorded_at=${record.recorded_at}`
        + ` detail=${record.detail || 'none'}`
        + ` validator=${record.validator || 'none'}`,
      );
    }
  }
  for (const error of state.protocol_errors || []) {
    lines.push(
      `- protocol-error: code=${error.code}`
      + ` checkpoint=${error.checkpoint}`
      + ` recorded_at=${error.recorded_at}`
      + ` detail=${error.detail}`,
    );
  }
  lines.push('', '---', '');
  appendFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

export async function finishNightlyPass({
  root = defaultNightlyRoot(),
  now = new Date(),
  deliver = true,
  stderr = process.stderr,
} = {}) {
  const state = readState(root);
  if (!['running', 'pass', 'fail'].includes(state.status)) {
    throw new Error(`nightly pass cannot finish from status: ${state.status}`);
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  if (state.status === 'running') {
    const missing = NIGHTLY_CHECKPOINTS.filter(
      (checkpoint) => !state.checkpoints[checkpoint],
    );
    const failed = NIGHTLY_CHECKPOINTS.filter(
      (checkpoint) => state.checkpoints[checkpoint]?.status === 'fail',
    );
    const protocolErrors = state.protocol_errors || [];
    state.finished_at = instant.toISOString();
    state.status = missing.length || failed.length || protocolErrors.length
      ? 'fail'
      : 'pass';
    state.missing_checkpoints = missing;
    state.failed_checkpoints = failed;
    state.finish_alerts_emitted = false;
    atomicJson(statePath(root), state);
  }

  if (!state.finish_alerts_emitted) {
    if (state.missing_checkpoints?.length) {
      await emitNightlyAlert({
        root,
        code: 'NIGHTLY:INCOMPLETE_PASS',
        summary: `nightly pass missing ${state.missing_checkpoints.length} checkpoint(s)`,
        detail: state.missing_checkpoints.join(', '),
        evidence: `memory/runtime/NIGHTLY_PASS_STATE.json run=${state.run_id}`,
        scope: state.run_id,
        now: instant,
        deliver,
        timeZone: state.time_zone,
        stderr,
      });
    }
    state.finish_alerts_emitted = true;
    atomicJson(statePath(root), state);
  }
  if (!state.log_written) {
    appendPassLog(root, state);
    state.log_written = true;
    atomicJson(statePath(root), state);
  }
  if (state.status === 'pass' && !state.alerts_resolved) {
    for (const checkpoint of NIGHTLY_CHECKPOINTS) {
      resolveNightlyAlerts({
        root,
        code: `NIGHTLY:LEG_FAIL:${checkpoint}`,
        reason: `checkpoint restored by complete green pass ${state.run_id}`,
        now: instant,
      });
    }
    resolveNightlyAlerts({
      root,
      codePrefix: 'NIGHTLY:DUPLICATE_CHECKPOINT:',
      reason: `complete green pass ${state.run_id}`,
      now: instant,
    });
    resolveNightlyAlerts({
      root,
      code: 'NIGHTLY:INCOMPLETE_PASS',
      reason: `complete green pass ${state.run_id}`,
      now: instant,
    });
    state.alerts_resolved = true;
    atomicJson(statePath(root), state);
  }
  return state;
}

export async function recordEvidenceCommitFailure({
  root = defaultNightlyRoot(),
  exitCode,
  detail,
  now = new Date(),
  deliver = true,
  stderr = process.stderr,
} = {}) {
  const state = readState(root);
  if (!state.log_written || !['pass', 'fail'].includes(state.status)) {
    throw new Error('nightly evidence-commit failure can be recorded only after finish');
  }
  const code = Number(exitCode);
  if (!Number.isInteger(code) || code === 0) {
    throw new Error('evidence-commit failure requires a non-zero integer exit code');
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const timestamp = instant.toISOString();
  const event = {
    status: 'fail',
    exit_code: code,
    recorded_at: timestamp,
    detail: cleanDetail(detail),
    alert: `memory/runtime/NIGHTLY_ALERTS.jsonl`
      + `#NIGHTLY:EVIDENCE_COMMIT_FAIL:${state.run_id}`,
  };
  await emitNightlyAlert({
    root,
    code: 'NIGHTLY:EVIDENCE_COMMIT_FAIL',
    summary: `nightly evidence commit failed (exit ${code})`,
    detail: event.detail,
    evidence: `memory/runtime/NIGHTLY_LOG.md run=${state.run_id}`,
    scope: state.run_id,
    now: instant,
    deliver,
    timeZone: state.time_zone,
    stderr,
  });
  state.evidence_commit = event;
  atomicJson(statePath(root), state);
  const marker = `### Nightly Evidence Commit Failure --`
    + ` ${state.pass_date} (${state.run_id})`;
  const log = logPath(root);
  if (!readFileSync(log, 'utf8').includes(marker)) {
    appendFileSync(log, [
      '',
      marker,
      `status: FAIL | exit: ${code} | recorded_at: ${timestamp}`,
      `detail: ${event.detail || 'none'}`,
      `alert: ${event.alert}`,
      '',
    ].join('\n'), 'utf8');
  }
  return { ...event, run_id: state.run_id };
}

export function recordEvidenceCommitSuccess({
  root = defaultNightlyRoot(),
  sha,
  now = new Date(),
} = {}) {
  const state = readState(root);
  if (!state.log_written || !['pass', 'fail'].includes(state.status)) {
    throw new Error('nightly evidence-commit success can be recorded only after finish');
  }
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) {
    throw new Error('evidence success requires a commit sha');
  }
  try {
    const context = childContext(root, state);
    execFileSync(
      'git',
      ['-C', context.paths.repositoryRoot, 'cat-file', '-e', `${sha}^{commit}`],
      {
        stdio: 'ignore',
        windowsHide: true,
        env: context.env,
      },
    );
  } catch {
    throw new Error(`evidence success commit is not present: ${sha}`);
  }
  const resolved = resolveNightlyAlerts({
    root,
    code: 'NIGHTLY:EVIDENCE_COMMIT_FAIL',
    scope: state.run_id,
    reason: `evidence commit retry succeeded at ${sha}`,
    now,
  });
  return {
    ok: true,
    status: 'pass',
    run_id: state.run_id,
    sha: String(sha),
    resolved,
    output: `NIGHTLY_EVIDENCE_COMMIT GREEN`
      + ` run=${state.run_id} sha=${sha} resolved=${resolved}`,
  };
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0];
  const root = args.root ? path.resolve(String(args.root)) : defaultNightlyRoot();
  try {
    let result;
    if (action === 'begin') {
      result = await beginNightlyPass({
        root,
        date: args.date,
        runId: args['run-id'],
        now: args.now ? new Date(String(args.now)) : new Date(),
        replace: Boolean(args.replace),
        deliver: !args['no-deliver'],
        timeZone: args['time-zone'],
        cutoffHour: args['cutoff-hour'],
      });
      process.stdout.write(
        `NIGHTLY_PASS BEGIN run=${result.run_id}`
        + ` date=${result.pass_date} protocol=${result.protocol}`
        + ` time_zone=${result.time_zone}`
        + ' state=memory/runtime/NIGHTLY_PASS_STATE.json\n',
      );
    } else if (action === 'record') {
      result = await recordNightlyCheckpoint({
        root,
        checkpoint: String(args.checkpoint || args.leg || ''),
        status: String(args.status || ''),
        exitCode: args['exit-code'],
        detail: args.detail,
        artifact: args.artifact,
        now: args.now ? new Date(String(args.now)) : new Date(),
        deliver: !args['no-deliver'],
      });
      process.stdout.write(
        `NIGHTLY_CHECKPOINT ${result.status === 'fail' ? 'RED' : 'GREEN'}`
        + ` name=${result.checkpoint} status=${result.status}`
        + ` exit=${result.exit_code} artifact=${result.artifact}`
        + ` alert=${result.alert}`
        + ` validator=${result.validator || 'none'}`
        + ` detail=${boundedOutput(result.detail || 'none')}\n`,
      );
    } else if (action === 'finish') {
      result = await finishNightlyPass({
        root,
        now: args.now ? new Date(String(args.now)) : new Date(),
        deliver: !args['no-deliver'],
      });
      process.stdout.write(
        `NIGHTLY_PASS ${result.status === 'pass' ? 'GREEN' : 'RED'}`
        + ` run=${result.run_id} status=${result.status}`
        + ` missing=${result.missing_checkpoints?.join(',') || 'none'}`
        + ` failed=${result.failed_checkpoints?.join(',') || 'none'}`
        + ' log=memory/runtime/NIGHTLY_LOG.md'
        + ' alert=memory/runtime/NIGHTLY_ALERTS.jsonl\n',
      );
    } else if (action === 'evidence-fail') {
      result = await recordEvidenceCommitFailure({
        root,
        exitCode: args['exit-code'],
        detail: args.detail,
        now: args.now ? new Date(String(args.now)) : new Date(),
        deliver: !args['no-deliver'],
      });
      process.stdout.write(
        `NIGHTLY_EVIDENCE_COMMIT RED run=${result.run_id}`
        + ` exit=${result.exit_code} alert=${result.alert}\n`,
      );
    } else if (action === 'evidence-success') {
      result = recordEvidenceCommitSuccess({
        root,
        sha: args.sha,
        now: args.now ? new Date(String(args.now)) : new Date(),
      });
      process.stdout.write(result.output + '\n');
    } else {
      throw new Error(
        'usage: nightly-pass.mjs'
        + ' begin|record|finish|evidence-fail|evidence-success [options]',
      );
    }
    process.exit(result.status === 'fail' ? 1 : 0);
  } catch (error) {
    process.stderr.write(
      `NIGHTLY_PASS ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(2);
  }
}
