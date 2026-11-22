#!/usr/bin/env node
// Append-only nightly alerts with local delivery. The durable ledger is the
// authority; stderr provides immediate visibility and SessionStart re-surfaces
// every still-active alert.

import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { zonedDateKey } from './nightly-freshness.mjs';
import {
  defaultNightlyRoot,
  normalizeTimeZone,
  resolveNightlyPaths,
} from './nightly-paths.mjs';
import { collapseLineBreaking, inert } from './lifecycle-common.mjs';

const ALERT_REF = 'memory/runtime/NIGHTLY_ALERTS.jsonl';
const OLDER_CODE_LIMIT = 6;
export const STANDING_SCOPE = 'standing';

export function nightlyAlertPath(root = defaultNightlyRoot()) {
  return path.join(resolveNightlyPaths(root).runtimeRoot, 'NIGHTLY_ALERTS.jsonl');
}

function appendEvent(root, event) {
  const file = nightlyAlertPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  let separator = '';
  const size = statSync(file, { throwIfNoEntry: false })?.size;
  if (size) {
    const fd = openSync(file, 'r');
    try {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, size - 1) === 0 || tail[0] !== 0x0a) separator = '\n';
    } finally {
      closeSync(fd);
    }
  }
  appendFileSync(file, separator + JSON.stringify(event) + '\n', 'utf8');
  return file;
}

export function readNightlyAlertEvents(root = defaultNightlyRoot(), {
  throwOnReadError = false,
} = {}) {
  const file = nightlyAlertPath(root);
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, events: [], errors: [] };
    if (throwOnReadError) throw error;
    return {
      file,
      events: [],
      errors: [`ledger unreadable: ${error?.message || error}`],
    };
  }
  const events = [];
  const errors = [];
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.alert_id || !parsed.status) throw new Error('missing alert_id/status');
      events.push(parsed);
    } catch (error) {
      errors.push(`line ${index + 1}: ${error?.message || error}`);
    }
  }
  return { file, events, errors };
}

export function readActiveNightlyAlerts(root = defaultNightlyRoot(), options) {
  const parsed = readNightlyAlertEvents(root, options);
  const latest = new Map();
  for (const event of parsed.events) latest.set(event.alert_id, event);
  const alerts = [...latest.values()]
    .filter((event) => event.status === 'active')
    .sort((left, right) => (
      String(left.raised_at || left.timestamp)
        .localeCompare(String(right.raised_at || right.timestamp))
    ));
  return { ...parsed, alerts };
}

function sanitize(value, max = 240) {
  let result = collapseLineBreaking(value ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (result.length > max) {
    result = `${result.slice(0, max)}…[+${result.length - max} chars]`;
  }
  return result;
}

function quoteAlertField(value, max) {
  try {
    return inert(value, max);
  } catch {
    return '""';
  }
}

export function formatNightlyAlertLine(event) {
  return `[NIGHTLY-ALERT: ${quoteAlertField(event.code, 80)}] summary=${quoteAlertField(event.summary, 160)}`
    + ` — evidence=${quoteAlertField(event.evidence, 220)}`;
}

export function writeLocalDelivery(stderr, line) {
  try {
    if (typeof stderr === 'function') stderr(line + '\n');
    else if (stderr && typeof stderr.write === 'function') stderr.write(line + '\n');
    else throw new Error('stderr destination unavailable');
    return { local: 'stderr' };
  } catch (error) {
    return {
      local: 'failed',
      error: sanitize(error?.message || error, 300),
    };
  }
}

export async function emitNightlyAlert({
  root = defaultNightlyRoot(),
  code,
  summary,
  detail,
  evidence,
  scope,
  now = new Date(),
  deliver = true,
  timeZone,
  stderr = process.stderr,
} = {}) {
  if (!root || !code || !summary || !evidence) {
    throw new Error('root, code, summary, and evidence are required');
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const effectiveTimeZone = normalizeTimeZone(
    timeZone ?? process.env.AIGENT_NIGHTLY_TIME_ZONE,
  );
  const timestamp = instant.toISOString();
  const effectiveScope = scope === undefined || scope === null || scope === ''
    ? zonedDateKey(instant, effectiveTimeZone)
    : scope;
  const alertId = `${sanitize(code, 80)}:${sanitize(effectiveScope, 80)}`;
  const existing = readActiveNightlyAlerts(root, { throwOnReadError: true })
    .alerts.find((alert) => alert.alert_id === alertId);
  const cleanSummary = sanitize(summary);
  const cleanEvidence = sanitize(evidence, 300);
  const sameAlert = existing
    && existing.summary === cleanSummary
    && existing.evidence === cleanEvidence;
  if (sameAlert && (existing.delivery?.local === 'stderr' || !deliver)) {
    return { ...existing, deduped: true, file: nightlyAlertPath(root) };
  }

  const base = {
    schema_version: 1,
    alert_id: alertId,
    code: sanitize(code, 80),
    name: sanitize(code, 80),
    summary: cleanSummary,
    detail: sanitize(detail, 500),
    evidence: cleanEvidence,
    scope: sanitize(effectiveScope, 80),
    raised_at: existing?.raised_at || timestamp,
    timestamp,
    status: 'active',
    alert_path: ALERT_REF,
    time_zone: effectiveTimeZone,
  };
  if (!sameAlert) {
    appendEvent(root, {
      ...base,
      event: 'raised',
      delivery: {
        local: 'pending',
        session_start: 'pending',
      },
    });
  }

  const local = deliver
    ? writeLocalDelivery(stderr, formatNightlyAlertLine(base))
    : { local: 'skipped', reason: 'delivery disabled' };
  const delivery = {
    ...local,
    session_start: 'pending',
    ...(local.local === 'stderr' ? { delivered_at: timestamp } : {}),
  };
  const event = { ...base, event: 'delivery', delivery };
  appendEvent(root, event);
  return {
    ...event,
    file: nightlyAlertPath(root),
    deduped: Boolean(sameAlert),
  };
}

export function resolveNightlyAlerts({
  root = defaultNightlyRoot(),
  code,
  codePrefix,
  scope,
  exceptAlertId,
  raisedThrough,
  reason,
  now = new Date(),
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const timestamp = instant.toISOString();
  const through = parseAlertTime(raisedThrough);
  const active = readActiveNightlyAlerts(root, { throwOnReadError: true }).alerts
    .filter((alert) => alert.alert_id !== exceptAlertId)
    .filter((alert) => raisedThrough === undefined || lastWrittenTime(alert) <= through)
    .filter((alert) => !code || alert.code === code)
    .filter((alert) => !codePrefix || String(alert.code).startsWith(codePrefix))
    .filter((alert) => !scope || alert.scope === scope);
  for (const alert of active) {
    appendEvent(root, {
      ...alert,
      event: 'resolved',
      status: 'resolved',
      timestamp,
      resolved_at: timestamp,
      resolution: sanitize(reason || 'predicate restored green', 300),
      delivery: {
        ...(alert.delivery || {}),
        session_start: 'cleared',
      },
    });
  }
  return active.length;
}

function parseAlertTime(value) {
  if (typeof value === 'number') return new Date(value).getTime();
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function lastWrittenTime(alert) {
  const time = parseAlertTime(alert.timestamp);
  return Number.isFinite(time) ? time : parseAlertTime(alert.raised_at);
}

function bootClockTime(now) {
  try {
    const time = typeof now === 'number' || typeof now === 'string'
      ? new Date(now).getTime()
      : Date.prototype.getTime.call(now);
    if (Number.isFinite(time)) return time;
  } catch {
    // The supplied clock value has no Date timestamp.
  }
  return Date.now();
}

export function formatNightlyBootAlerts(root = defaultNightlyRoot(), {
  limit = 5,
  now = new Date(),
} = {}) {
  const parsed = readActiveNightlyAlerts(root);
  const lines = [];
  if (parsed.errors.length) {
    lines.push(
      `[NIGHTLY-ALERT: ALERT_LEDGER_INVALID] ${parsed.errors.length} ledger issue(s)`
      + ` — file=${inert(String(parsed.file).replace(/\\/g, '/'))}`,
    );
  }
  const cutoff = bootClockTime(now) - 7 * 24 * 60 * 60 * 1000;
  const recent = [];
  const olderByLabel = new Map();
  for (const alert of parsed.alerts) {
    const time = lastWrittenTime(alert);
    if (time < cutoff) {
      const label = quoteAlertField(alert.code, 80);
      olderByLabel.set(label, (olderByLabel.get(label) || 0) + 1);
    } else {
      recent.push({ alert, time: Number.isFinite(time) ? time : -Infinity });
    }
  }
  recent.sort((left, right) => right.time - left.time);
  const visible = recent.slice(0, Number.isInteger(limit) && limit >= 0 ? limit : 5);
  for (const { alert } of visible) {
    lines.push(formatNightlyAlertLine(alert));
  }
  if (recent.length > visible.length) {
    lines.push(
      `[NIGHTLY-ALERT: MORE] ${recent.length - visible.length}`
      + ` additional active alert(s) in ${ALERT_REF}`,
    );
  }
  if (olderByLabel.size) {
    const counts = [...olderByLabel]
      .sort((left, right) => right[1] - left[1])
      .slice(0, OLDER_CODE_LIMIT)
      .map(([label, count]) => `${label} ${count}`);
    if (olderByLabel.size > counts.length) {
      counts.push(`+${olderByLabel.size - counts.length} more code(s)`);
    }
    lines.push(
      `[NIGHTLY-ALERT: OLDER] ${parsed.alerts.length - recent.length} active alert(s) older than 7 days`
      + ` (${counts.join(', ')}) in ${ALERT_REF}`,
    );
  }
  return lines;
}
