#!/usr/bin/env node
// Append-only nightly alerts with local delivery. The durable ledger is the
// authority; stderr provides immediate visibility and SessionStart re-surfaces
// every still-active alert.

import {
  appendFileSync, mkdirSync, readFileSync,
} from 'node:fs';
import path from 'node:path';
import { zonedDateKey } from './nightly-freshness.mjs';
import {
  defaultNightlyRoot,
  normalizeTimeZone,
  resolveNightlyPaths,
} from './nightly-paths.mjs';

const ALERT_REF = 'memory/runtime/NIGHTLY_ALERTS.jsonl';

export function nightlyAlertPath(root = defaultNightlyRoot()) {
  return path.join(resolveNightlyPaths(root).runtimeRoot, 'NIGHTLY_ALERTS.jsonl');
}

function appendEvent(root, event) {
  const file = nightlyAlertPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
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
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

export function formatNightlyAlertLine(event) {
  return `[NIGHTLY-ALERT: ${sanitize(event.code, 80)}] ${sanitize(event.summary, 160)}`
    + ` — evidence: ${sanitize(event.evidence, 220)}`;
}

function writeLocalDelivery(stderr, line) {
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
  reason,
  now = new Date(),
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const timestamp = instant.toISOString();
  const active = readActiveNightlyAlerts(root, { throwOnReadError: true }).alerts
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

export function formatNightlyBootAlerts(root = defaultNightlyRoot(), {
  limit = 5,
} = {}) {
  const parsed = readActiveNightlyAlerts(root);
  const lines = [];
  if (parsed.errors.length) {
    lines.push(
      `[NIGHTLY-ALERT: ALERT_LEDGER_INVALID] ${parsed.errors.length} ledger issue(s)`
      + ` — ${String(parsed.file).replace(/\\/g, '/')}`,
    );
  }
  for (const alert of parsed.alerts.slice(0, limit)) {
    lines.push(formatNightlyAlertLine(alert));
  }
  if (parsed.alerts.length > limit) {
    lines.push(
      `[NIGHTLY-ALERT: MORE] ${parsed.alerts.length - limit}`
      + ` additional active alert(s) in ${ALERT_REF}`,
    );
  }
  return lines;
}
