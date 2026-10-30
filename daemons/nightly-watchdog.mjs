#!/usr/bin/env node
// Daily no-fire watchdog. It reads the actual newest NIGHTLY_LOG date header,
// verifies that the header belongs to a complete green evidence block, raises a
// durable local alert on red, and resolves that alert on green.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessFreshness, formatFreshness, maskMarkdownFences, nightlyHeaderPattern,
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

// A protocol id ends in `-<legs>L-<checkpoints>C` (close-parity-v2-7L-11C,
// metis-local-v1-7L-7C). The product's own protocol names its checkpoints; a
// seat-local protocol declares only how many there are, and its rows name
// them. Null when the id does not declare a shape: nothing can be checked.
export function parseNightlyProtocol(protocol) {
  const match = /-(\d+)L-(\d+)C$/i.exec(String(protocol ?? ''));
  if (!match) return null;
  return { legs: Number(match[1]), checkpoints: Number(match[2]) };
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

  const pattern = nightlyHeaderPattern();
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
  const declared = parseNightlyProtocol(protocol);
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
  // The product's protocol names its checkpoints, so a missing one is named.
  // A seat-local protocol declares a count, so a shortfall is counted: absent
  // rows are absent, never read as skipped. Either way 7 of 7 passes and 6 of 7
  // does not.
  const ours = protocol === NIGHTLY_PROTOCOL;
  const expectedCount = ours ? NIGHTLY_CHECKPOINTS.length : (declared?.checkpoints ?? 0);
  const missing = ours
    ? NIGHTLY_CHECKPOINTS.filter((checkpoint) => !recorded.has(checkpoint))
    : (recorded.size < expectedCount ? [`${recorded.size} of ${expectedCount} recorded`] : []);
  const names = [...recorded];
  const duplicates = names.filter(
    (checkpoint) => checkpointRows
      .filter((entry) => entry[1].toLowerCase() === checkpoint)
      .length > 1,
  );
  const unknown = ours
    ? names.filter((checkpoint) => !NIGHTLY_CHECKPOINTS.includes(checkpoint))
    : (recorded.size > expectedCount ? [`${recorded.size} recorded, ${expectedCount} declared`] : []);
  const failedRows = checkpointRows.filter(
    (entry) => entry[2].toUpperCase() === 'FAIL' || Number(entry[3]) !== 0,
  );
  // Only the product's protocol declares which checkpoints may be skipped; a
  // seat-local protocol's skips are its own, still receipted below.
  const illegalSkips = checkpointRows
    .filter((entry) => (
      ours
      && entry[2].toUpperCase() === 'SKIPPED'
      && !NIGHTLY_SKIPPABLE_CHECKPOINTS.includes(entry[1].toLowerCase())
    ))
    .map((entry) => entry[1].toLowerCase());
  const unreceipted = checkpointRows
    .filter((entry) => !/\bvalidator=(?!none(?:\s|$))\S+/i.test(entry[0]))
    .map((entry) => entry[1].toLowerCase());
  // A line that LOOKS like a checkpoint row but misses the strict row regex was
  // being dropped in SILENCE. Paired with a well-formed row for the same
  // checkpoint it evaded `missing` (the good row satisfies `recorded`) AND
  // `duplicates` (which only counts strict matches), so the block could report
  // "11/11 checkpoints" with a FAIL row sitting in it. Count loosely, compare
  // strictly: a row the strict parser cannot read is loud, never invisible.
  const looseRows = [...block.matchAll(/^-[ \t]+[a-z][a-z0-9-]*:[ \t]+status=/gmi)];
  // A RECOGNISED RUN WHOSE EVIDENCE THIS READER CANNOT READ IS UNVERIFIED (issue
  // #122): the newest header is for the expected night, so the pass fired, but
  // the block under it carries no machine-readable evidence at all (a prose
  // journal entry) or evidence in a format that is not this protocol (a seat's
  // local protocol name). Neither is PASS: nothing was verified. Neither is a
  // no-fire: the night was not missed. It is its own verdict and its own alert,
  // so a reader is told the truth and a genuinely silent night still reads as
  // NO_FIRE. A block in THIS protocol with broken structure stays `incomplete`
  // (an abandoned night) and one that reports FAIL stays `failed`.
  const anyEvidence = protocol !== null || status !== null || looseRows.length > 0;
  if (!anyEvidence || (protocol !== null && declared === null)) {
    const detail = anyEvidence
      ? `evidence block under ${date} declares protocol ${protocol}, which names no shape (-<L>L-<C>C); the run is recorded but cannot be verified`
      : `no machine-readable evidence block under ${date}; the run is recorded but cannot be verified`;
    return {
      ok: false,
      code: 'unverified',
      protocol,
      status,
      completedAt,
      timeZone: recordedZone,
      cutoffHour: recordedCutoff === null ? null : Number(recordedCutoff),
      missing: [],
      failedCheckpoints: [],
      detail,
    };
  }
  const invalid = [];
  if (looseRows.length !== checkpointRows.length) {
    invalid.push(`unparseable_rows=${looseRows.length - checkpointRows.length}`);
  }
  if (protocol === null) invalid.push('protocol=missing');
  if (!status) invalid.push('terminal status');
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) invalid.push('completed_at');
  // A hand-authored block may omit time_zone / cutoff_hour: it then means the
  // defaults (nightly-paths DEFAULT_*), the same ones the watchdog itself runs
  // under, and is never failed for their absence. Present, they must agree.
  if (recordedZone) {
    try {
      const normalized = normalizeTimeZone(recordedZone);
      if (timeZone && normalized !== normalizeTimeZone(timeZone)) {
        invalid.push(`time_zone=${recordedZone}`);
      }
    } catch {
      invalid.push(`time_zone=${recordedZone}`);
    }
  }
  if (recordedCutoff !== null) {
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
  if (declared && Number.isFinite(declared.legs) && declared.legs <= 0) invalid.push(`legs=${declared.legs}`);
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
    detail = `complete ${protocol} evidence block, terminal status=FAIL`
      + ` — fired and failed: ${failedCheckpoints.length ? failedCheckpoints.join(', ') : 'no failed checkpoint rows'}`;
  } else {
    detail = `completed ${protocol} evidence block`
      + ` with ${recorded.size}/${expectedCount} checkpoints`;
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

// Every alert code this watchdog can raise. The emitter and the green-path
// resolver both go through these constants, so the string that gets raised is
// the same object that gets cleared — the defect that made PASS_FAILED
// permanent was the resolver hand-listing NO_FIRE only.
//
// What this DOES enforce: no code can be raised from a literal that is absent
// from the list, because the emitter has no literals left to raise.
// What it does NOT enforce: adding a third code still means adding it here by
// hand. Nothing fails if you forget. The constants make that omission awkward
// and visible at the call site rather than invisible — they do not make it
// impossible, and an earlier version of this comment claimed otherwise.
const ALERT_NO_FIRE = 'NIGHTLY:NO_FIRE';
const ALERT_PASS_FAILED = 'NIGHTLY:PASS_FAILED';
// A recognised run with no evidence this reader can verify (issue #122).
const ALERT_UNVERIFIED = 'NIGHTLY:UNVERIFIED';

export const WATCHDOG_ALERT_CODES = Object.freeze([
  ALERT_NO_FIRE,
  ALERT_PASS_FAILED,
  ALERT_UNVERIFIED,
]);

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
    // Green clears EVERY red this watchdog can raise, derived from the shared
    // list rather than hand-listed. An alert that never clears re-surfaces at
    // every boot after the condition is gone, which teaches the reader to skip
    // the channel — and then a real alert lands somewhere already ignored.
    const resolved = persist
      ? WATCHDOG_ALERT_CODES.reduce((total, code) => total + resolveNightlyAlerts({
        root,
        code,
        reason: `fresh complete nightly block ${freshness.newest}`,
        now,
      }), 0)
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
  // Recorded, not verifiable: it fired, so a standing NO_FIRE is cleared like
  // the failed case, and its own alert names what is missing.
  const unverified = freshness.code === 'unverified';
  const failedNames = completion?.failedCheckpoints ?? [];
  let alert = null;
  if (persist) {
    if (firedButFailed || unverified) {
      // It ran. Clear any prior NO_FIRE so a genuine silent death later is not
      // masked by a stale one, and so the ledger never carries both claims.
      resolveNightlyAlerts({
        root,
        code: ALERT_NO_FIRE,
        reason: unverified
          ? `nightly ${freshness.newest} fired; its evidence cannot be verified`
          : `nightly ${freshness.newest} fired with terminal status=FAIL`,
        now,
      });
    }
    alert = await emitNightlyAlert({
      root,
      code: firedButFailed ? ALERT_PASS_FAILED : (unverified ? ALERT_UNVERIFIED : ALERT_NO_FIRE),
      summary: firedButFailed
        ? `nightly pass fired and failed (${failedNames.length} checkpoint${failedNames.length === 1 ? '' : 's'}: ${failedNames.join(', ') || 'unnamed'})`
        : (unverified
          ? 'nightly pass recorded without verifiable evidence (unverified: not a pass, not a no-fire)'
          : `nightly pass did not complete (${freshness.code})`),
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
