#!/usr/bin/env node
// ctx-telemetry.mjs -- dependency-free context-pressure writer and reader.
//
// WHY THIS EXISTS: the statusline is the CLI-owned observable for context
// pressure, but the original shell writer silently stopped producing it when
// jq was absent.  A missing pressure signal must be a named degraded state, not
// an accidental feature flag.  This Node implementation gives the shell a
// fallback and can also be used as the statusline command itself.
//
// The writer preserves the existing on-disk contract:
//   ~/.claude/ctx-refresh/<session_id>.json
//   {"used_percentage": N, "ts": "..."}
//
// Mutable IO and the clock are injectable.  The reader uses file mtime as the
// freshness observable; it never waits and never treats elapsed time alone as
// evidence that a lifecycle action occurred.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { atomicUpdate } = require('./memory-hygiene/atomic-state.cjs');

export const DEFAULT_PRESSURE_FRESHNESS_MS = 120_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN = /^[A-Za-z0-9_-]+$/;
const PERCENTAGE_TOKEN = /^[0-9]+(?:\.[0-9]+)?$/;

function hasOwn(value, field) {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, field);
}

function clockMs(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError('telemetry clock returned an invalid date');
  return milliseconds;
}

function timestampSeconds(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function validSessionId(value) {
  return typeof value === 'string' && SESSION_TOKEN.test(value);
}

function numericPercentage(value) {
  const rendered = typeof value === 'number' ? String(value) : value;
  if (typeof rendered !== 'string' || !PERCENTAGE_TOKEN.test(rendered)) return null;
  const pct = Number(rendered);
  return Number.isFinite(pct) ? pct : null;
}

export function pressureFilePath({ sessionId, homeDir = os.homedir() } = {}) {
  if (!validSessionId(sessionId)) return null;
  return path.join(String(homeDir), '.claude', 'ctx-refresh', `${sessionId}.json`);
}

function pruneOldTelemetry({ directory, fsImpl, currentMs }) {
  let entries;
  try { entries = fsImpl.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry?.isFile?.() || !entry.name.endsWith('.json')) continue;
    const candidate = path.join(directory, entry.name);
    try {
      if (currentMs - fsImpl.statSync(candidate).mtimeMs > RETENTION_MS) fsImpl.unlinkSync(candidate);
    } catch { /* housekeeping never owns the statusline */ }
  }
}

/**
 * Write one statusline observation.  Invalid input is a deliberate no-op.
 */
export function writeTelemetry({
  payload,
  homeDir = os.homedir(),
  fsImpl = fs,
  now = () => new Date(),
} = {}) {
  const sessionId = hasOwn(payload, 'session_id') ? payload.session_id : null;
  const rawPct = payload?.context_window && hasOwn(payload.context_window, 'used_percentage')
    ? payload.context_window.used_percentage
    : null;
  const pct = numericPercentage(rawPct);
  const target = pressureFilePath({ sessionId, homeDir });
  if (!target || pct === null) return null;

  let currentMs;
  try { currentMs = clockMs(now); } catch { return null; }
  const ts = timestampSeconds(currentMs);
  try {
    atomicUpdate(
      target,
      () => `{"used_percentage": ${pct}, "ts": ${JSON.stringify(ts)}}\n`,
      { fsImpl, now: () => clockMs(now) },
    );
    pruneOldTelemetry({ directory: path.dirname(target), fsImpl, currentMs });
    return { file: target, used_percentage: pct, ts };
  } catch {
    return null;
  }
}

// The longer name is kept as an explicit library affordance for statusline
// callers; both exports are the same single implementation.
export const writeContextTelemetry = writeTelemetry;

/**
 * Read the pressure observable without collapsing degraded conditions.
 */
export function readPressure({
  sessionId,
  homeDir = os.homedir(),
  staleAfterMs = DEFAULT_PRESSURE_FRESHNESS_MS,
  freshnessMs,
  fsImpl = fs,
  now = () => new Date(),
} = {}) {
  const target = pressureFilePath({ sessionId, homeDir });
  if (!target) return { pct: null, fresh: false, state: 'missing' };

  let text;
  let modifiedMs;
  try {
    text = fsImpl.readFileSync(target, 'utf8');
    modifiedMs = fsImpl.statSync(target).mtimeMs;
  } catch {
    return { pct: null, fresh: false, state: 'missing' };
  }
  if (!Number.isFinite(modifiedMs)) {
    return { pct: null, fresh: false, state: 'missing' };
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return { pct: null, fresh: false, state: 'missing' };
  }
  if (!hasOwn(parsed, 'used_percentage')) {
    return { pct: null, fresh: false, state: 'missing' };
  }
  const pct = numericPercentage(parsed.used_percentage);
  if (pct === null) return { pct: null, fresh: false, state: 'missing' };

  const windowMs = freshnessMs === undefined ? staleAfterMs : freshnessMs;
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    return { pct: null, fresh: false, state: 'missing' };
  }
  let currentMs;
  try { currentMs = clockMs(now); } catch {
    return { pct: null, fresh: false, state: 'missing' };
  }
  if (currentMs - modifiedMs > windowMs) {
    return { pct, fresh: false, state: 'stale' };
  }
  return { pct, fresh: true, state: 'ok' };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  const argvPath = path.resolve(process.argv[1]);
  return process.platform === 'win32'
    ? modulePath.toLowerCase() === argvPath.toLowerCase()
    : modulePath === argvPath;
}

function renderBuiltIn(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const model = typeof payload?.model?.display_name === 'string'
    ? payload.model.display_name
    : 'Claude';
  const pct = numericPercentage(payload?.context_window?.used_percentage);
  return pct === null ? model : `${model} | ctx ${Math.floor(pct)}%`;
}

function runCli() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* empty input */ }
  let payload = null;
  try { payload = JSON.parse(input); } catch { /* malformed statusline payload */ }
  if (payload) writeTelemetry({ payload, homeDir: process.env.HOME || os.homedir() });
  if (process.argv.includes('--write-only')) return;

  const delegate = process.env.AIGENT_STATUSLINE_DELEGATE
    || path.join(process.env.HOME || os.homedir(), '.claude', 'statusline-command.sh');
  try {
    if (fs.existsSync(delegate)) {
      const result = spawnSync('bash', [delegate], {
        input,
        encoding: 'utf8',
        env: process.env,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      return;
    }
  } catch { /* use the built-in line */ }

  const rendered = renderBuiltIn(payload);
  if (rendered) process.stdout.write(`${rendered}\n`);
}

if (isMainModule()) runCli();
