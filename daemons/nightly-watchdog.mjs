#!/usr/bin/env node
// Daily no-fire watchdog. It reads the actual newest NIGHTLY_LOG date header,
// verifies that the header belongs to a complete green evidence block, raises a
// durable local alert on red, and resolves that alert on green.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessFreshness, formatFreshness, maskMarkdownFences,
} from './nightly-freshness.mjs';
import {
  NIGHTLY_CHECKPOINTS, NIGHTLY_PROTOCOL, NIGHTLY_SKIPPABLE_CHECKPOINTS,
} from './nightly-pass.mjs';
import {
  emitNightlyAlert, nightlyAlertPath, resolveNightlyAlerts,
} from './nightly-alerts.mjs';
import {
  defaultNightlyRoot as resolveDefaultNightlyRoot,
  normalizeCutoffHour,
  normalizeTimeZone,
  resolveNightlyConfig,
  resolveNightlyPaths,
} from './nightly-paths.mjs';

export function defaultNightlyRoot() {
  return resolveDefaultNightlyRoot();
}

export function assessNightlyCompletion({
  file,
  date,
  timeZone,
  cutoffHour,
} = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'unreadable',
      detail: error?.code === 'ENOENT'
        ? 'nightly log missing'
        : `nightly log unreadable: ${error?.message || error}`,
      missing: [],
    };
  }

  const pattern = /^##[ \t]+Nightly Pass[ \t]*--[ \t]*(\d{4}-\d{2}-\d{2})\b/gmi;
  const headers = [];
  let match;
  const searchable = maskMarkdownFences(text);
  while ((match = pattern.exec(searchable)) !== null) {
    headers.push({ date: match[1], index: match.index });
  }
  const selectedIndex = headers.findLastIndex((header) => header.date === date);
  if (selectedIndex < 0) {
    return {
      ok: false,
      code: 'missing-block',
      detail: `no evidence block for newest header ${date || 'none'}`,
      missing: [],
    };
  }
  const selected = headers[selectedIndex];
  const next = headers.find((header) => header.index > selected.index);
  const block = searchable.slice(selected.index, next?.index ?? searchable.length);
  const protocol = block.match(/^protocol:[ \t]*(\S+)[ \t]*$/mi)?.[1] || null;
  const status = block.match(/^status:[ \t]*(PASS|FAIL)[ \t]*$/mi)?.[1] || null;
  const completedAt = block.match(/^completed_at:[ \t]*(\S+)[ \t]*$/mi)?.[1] || null;
  const recordedZone = block.match(/^time_zone:[ \t]*(\S+)[ \t]*$/mi)?.[1] || null;
  const recordedCutoff = block.match(/^cutoff_hour:[ \t]*(\d{1,2})[ \t]*$/mi)?.[1] ?? null;
  const checkpointRows = [
    ...block.matchAll(
      /^-[ \t]+([a-z][a-z0-9-]*):[ \t]+status=(PASS|SKIPPED|FAIL)[ \t]+exit=(-?\d+)\b.*$/gmi,
    ),
  ];
  const recorded = new Set(
    checkpointRows.map((entry) => entry[1].toLowerCase()),
  );
  const missing = NIGHTLY_CHECKPOINTS.filter(
    (checkpoint) => !recorded.has(checkpoint),
  );
  const duplicates = NIGHTLY_CHECKPOINTS.filter(
    (checkpoint) => checkpointRows
      .filter((entry) => entry[1].toLowerCase() === checkpoint)
      .length > 1,
  );
  const unknown = checkpointRows
    .map((entry) => entry[1].toLowerCase())
    .filter((checkpoint) => !NIGHTLY_CHECKPOINTS.includes(checkpoint));
  const failedRows = checkpointRows.filter(
    (entry) => entry[2].toUpperCase() === 'FAIL' || Number(entry[3]) !== 0,
  );
  const illegalSkips = checkpointRows
    .filter((entry) => (
      entry[2].toUpperCase() === 'SKIPPED'
      && !NIGHTLY_SKIPPABLE_CHECKPOINTS.includes(entry[1].toLowerCase())
    ))
    .map((entry) => entry[1].toLowerCase());
  const unreceipted = checkpointRows
    .filter((entry) => !/\bvalidator=(?!none(?:\s|$))\S+/i.test(entry[0]))
    .map((entry) => entry[1].toLowerCase());
  const invalid = [];
  if (protocol !== NIGHTLY_PROTOCOL) invalid.push(`protocol=${protocol || 'missing'}`);
  if (!status) invalid.push('terminal status');
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) invalid.push('completed_at');
  if (!recordedZone) {
    invalid.push('time_zone');
  } else {
    try {
      const normalized = normalizeTimeZone(recordedZone);
      if (timeZone && normalized !== normalizeTimeZone(timeZone)) {
        invalid.push(`time_zone=${recordedZone}`);
      }
    } catch {
      invalid.push(`time_zone=${recordedZone}`);
    }
  }
  if (recordedCutoff === null) {
    invalid.push('cutoff_hour');
  } else {
    try {
      const normalized = normalizeCutoffHour(recordedCutoff);
      if (cutoffHour !== undefined
          && normalized !== normalizeCutoffHour(cutoffHour)) {
        invalid.push(`cutoff_hour=${recordedCutoff}`);
      }
    } catch {
      invalid.push(`cutoff_hour=${recordedCutoff}`);
    }
  }
  if (missing.length) invalid.push(`checkpoints=${missing.join(',')}`);
  if (duplicates.length) invalid.push(`duplicate_checkpoints=${duplicates.join(',')}`);
  if (unknown.length) invalid.push(`unknown_checkpoints=${unknown.join(',')}`);
  if (illegalSkips.length) invalid.push(`illegal_skips=${illegalSkips.join(',')}`);
  if (unreceipted.length) invalid.push(`validator_receipts=${unreceipted.join(',')}`);
  // A block that claims PASS while carrying failed rows is lying about itself —
  // that IS an integrity defect. A block that says FAIL and shows failed rows is
  // telling the truth, and truth-telling must not be scored as incompleteness.
  if (status === 'PASS' && failedRows.length) {
    invalid.push('PASS status conflicts with failed checkpoint rows');
  }
  // Completeness is STRUCTURAL; the verdict is separate. A pass that ran every
  // checkpoint and honestly reported failures DID run — folding that into
  // `incomplete` made honest failure and a silently dead nightly emit the same
  // NIGHTLY:NO_FIRE alert, which buries a real no-fire in the noise of passes
  // that did fire, and penalises the pass for reporting truthfully.
  const structurallyComplete = invalid.length === 0;
  const failedTerminal = structurallyComplete && (status === 'FAIL' || failedRows.length > 0);
  const failedCheckpoints = failedRows.map((entry) => entry[1].toLowerCase());
  let detail;
  if (!structurallyComplete) {
    detail = `incomplete evidence block: ${invalid.join('; ')}`;
  } else if (failedTerminal) {
    detail = `complete ${NIGHTLY_PROTOCOL} evidence block, terminal status=FAIL`
      + ` — fired and failed: ${failedCheckpoints.length ? failedCheckpoints.join(', ') : 'no failed checkpoint rows'}`;
  } else {
    detail = `completed ${NIGHTLY_PROTOCOL} evidence block`
      + ` with ${NIGHTLY_CHECKPOINTS.length}/${NIGHTLY_CHECKPOINTS.length} checkpoints`;
  }
  return {
    ok: structurallyComplete && !failedTerminal,
    code: failedTerminal ? 'failed' : (structurallyComplete ? 'complete' : 'incomplete'),
    protocol,
    status,
    completedAt,
    timeZone: recordedZone,
    cutoffHour: recordedCutoff === null ? null : Number(recordedCutoff),
    missing,
    failedCheckpoints,
    detail,
  };
}

export async function runNightlyWatchdog({
  root = defaultNightlyRoot(),
  now = new Date(),
  deliver = true,
  persist = true,
  timeZone,
  cutoffHour,
  stderr = process.stderr,
} = {}) {
  const config = resolveNightlyConfig({ timeZone, cutoffHour });
  const paths = resolveNightlyPaths(root);
  const log = path.join(paths.runtimeRoot, 'NIGHTLY_LOG.md');
  const headerFreshness = assessFreshness({
    kind: 'nightly',
    file: log,
    now,
    timeZone: config.timeZone,
    cutoffHour: config.cutoffHour,
  });
  const completion = headerFreshness.ok
    ? assessNightlyCompletion({
      file: log,
      date: headerFreshness.newest,
      timeZone: config.timeZone,
      cutoffHour: config.cutoffHour,
    })
    : null;
  const freshness = completion?.ok === false
    ? {
      ...headerFreshness,
      ok: false,
      // Propagate the assessor's own code. Hardcoding 'incomplete' here would
      // flatten "fired and failed" back into "never ran" one line after the
      // assessor learned to tell them apart.
      code: completion.code || 'incomplete',
      detail: completion.detail,
    }
    : headerFreshness;
  if (freshness.ok) {
    const resolved = persist
      ? resolveNightlyAlerts({
        root,
        code: 'NIGHTLY:NO_FIRE',
        reason: `fresh complete nightly block ${freshness.newest}`,
        now,
      })
      : 0;
    return {
      ok: true,
      freshness,
      completion,
      resolved,
      alertPath: nightlyAlertPath(root),
      output: `NIGHTLY_WATCHDOG GREEN newest=${freshness.newest}`
        + ` expected=${freshness.expected}`
        + ` time_zone=${config.timeZone} resolved=${resolved}`,
    };
  }

  // Fired and failed is a distinct, truthful condition — NOT a no-fire. The
  // per-leg alerts already name which checkpoints failed; claiming the pass
  // never completed over a full evidence block is the instrument lying.
  const firedButFailed = freshness.code === 'failed';
  const failedNames = completion?.failedCheckpoints ?? [];
  let alert = null;
  if (persist) {
    if (firedButFailed) {
      // It ran. Clear any prior NO_FIRE so a genuine silent death later is not
      // masked by a stale one, and so the ledger never carries both claims.
      resolveNightlyAlerts({
        root,
        code: 'NIGHTLY:NO_FIRE',
        reason: `nightly ${freshness.newest} fired with terminal status=FAIL`,
        now,
      });
    }
    alert = await emitNightlyAlert({
      root,
      code: firedButFailed ? 'NIGHTLY:PASS_FAILED' : 'NIGHTLY:NO_FIRE',
      summary: firedButFailed
        ? `nightly pass fired and failed (${failedNames.length} checkpoint${failedNames.length === 1 ? '' : 's'}: ${failedNames.join(', ') || 'unnamed'})`
        : `nightly pass did not complete (${freshness.code})`,
      detail: freshness.detail,
      evidence: `memory/runtime/NIGHTLY_LOG.md`
        + ` newest=${freshness.newest ?? 'none'}`
        + ` expected=${freshness.expected ?? 'unknown'}`,
      scope: freshness.expected || 'missing',
      now,
      deliver,
      timeZone: config.timeZone,
      stderr,
    });
  }
  return {
    ok: false,
    freshness,
    completion,
    alert,
    alertPath: nightlyAlertPath(root),
    output: `NIGHTLY_WATCHDOG RED code=${freshness.code}`
      + ` newest=${freshness.newest ?? 'none'}`
      + ` expected=${freshness.expected ?? 'unknown'}`
      + ` time_zone=${config.timeZone}`
      + ' alert=memory/runtime/NIGHTLY_ALERTS.jsonl'
      + ` delivery=${alert?.delivery?.local ?? 'disabled'}`,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      index += 1;
    } else out[key] = true;
  }
  return out;
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runNightlyWatchdog({
      root: args.root ? path.resolve(String(args.root)) : defaultNightlyRoot(),
      now: args.now ? new Date(String(args.now)) : new Date(),
      deliver: !args['no-deliver'],
      persist: !args['check-only'],
      timeZone: args['time-zone'],
      cutoffHour: args['cutoff-hour'],
    });
    process.stdout.write(result.output + '\n');
    if (args.verbose) process.stdout.write(formatFreshness(result.freshness) + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(
      `NIGHTLY_WATCHDOG ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`,
    );
    process.exit(2);
  }
}
