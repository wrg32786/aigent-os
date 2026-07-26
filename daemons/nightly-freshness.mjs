#!/usr/bin/env node
// Date-header freshness predicates. File mtimes are deliberately irrelevant:
// touching a stale log must not turn stale evidence green.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NIGHTLY_CUTOFF_HOUR,
  DEFAULT_NIGHTLY_TIME_ZONE,
  normalizeCutoffHour,
  normalizeTimeZone,
} from './nightly-paths.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const DEFAULT_TIME_ZONE = DEFAULT_NIGHTLY_TIME_ZONE;
export { DEFAULT_NIGHTLY_CUTOFF_HOUR };

export function maskMarkdownFences(value) {
  const source = String(value ?? '');
  let fence = null;
  return source.replace(/[^\r\n]*(?:\r\n|\n|\r|$)/g, (line) => {
    if (!line) return line;
    const body = line.replace(/(?:\r\n|\n|\r)$/, '');
    const ending = line.slice(body.length);
    const marker = body.match(/^[ \t]*(`{3,}|~{3,})/)?.[1] || null;
    if (!fence && marker) {
      fence = { char: marker[0], length: marker.length };
      return ' '.repeat(body.length) + ending;
    }
    if (fence) {
      const close = body.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/)?.[1] || null;
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      return ' '.repeat(body.length) + ending;
    }
    return line;
  });
}

export function validDateKey(value) {
  if (!DATE_RE.test(String(value))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function dateEpoch(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDays(value, delta) {
  return new Date(dateEpoch(value) + delta * DAY_MS).toISOString().slice(0, 10);
}

export function zonedParts(now, timeZone = DEFAULT_TIME_ZONE) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid now value: ${now}`);
  const zone = normalizeTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: parts.weekday,
    timeZone: zone,
  };
}

export function zonedDateKey(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return zonedParts(now, timeZone).date;
}

export function expectedNightlyDate({
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  cutoffHour = DEFAULT_NIGHTLY_CUTOFF_HOUR,
} = {}) {
  const local = zonedParts(now, timeZone);
  const cutoff = normalizeCutoffHour(cutoffHour);
  return local.hour >= cutoff ? local.date : addDays(local.date, -1);
}

export function newestDatedHeader(text, kind) {
  if (!['nightly', 'dream'].includes(kind)) {
    throw new Error(`unsupported freshness kind: ${kind}`);
  }
  const pattern = kind === 'nightly'
    ? /^##[ \t]+Nightly Pass[ \t]*--[ \t]*(\d{4}-\d{2}-\d{2})\b/gmi
    : /^##[ \t]+(\d{4}-\d{2}-\d{2})\b/gm;
  const dates = [];
  let match;
  const searchable = maskMarkdownFences(text);
  while ((match = pattern.exec(searchable)) !== null) {
    if (validDateKey(match[1])) dates.push(match[1]);
  }
  dates.sort();
  return { newest: dates.at(-1) || null, dates };
}

export function assessFreshness({
  kind,
  file,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  maxAgeDays = 7,
  cutoffHour = DEFAULT_NIGHTLY_CUTOFF_HOUR,
} = {}) {
  if (!['nightly', 'dream'].includes(kind)) {
    throw new Error(`unsupported freshness kind: ${kind}`);
  }
  const zone = normalizeTimeZone(timeZone);
  const maxDays = Number(maxAgeDays);
  if (!Number.isFinite(maxDays) || maxDays < 0) {
    throw new Error(`max age days must be non-negative: ${maxAgeDays}`);
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      kind,
      code: error?.code === 'ENOENT' ? 'missing' : 'unreadable',
      file,
      newest: null,
      timeZone: zone,
      detail: error?.code === 'ENOENT'
        ? 'file missing'
        : `file unreadable: ${error?.message || error}`,
    };
  }

  const parsed = newestDatedHeader(text, kind);
  if (!parsed.newest) {
    return {
      ok: false,
      kind,
      code: 'no-valid-header',
      file,
      newest: null,
      timeZone: zone,
      detail: `no valid ${kind} date header`,
    };
  }

  const local = zonedParts(now, zone);
  const futureDays = Math.round((dateEpoch(parsed.newest) - dateEpoch(local.date)) / DAY_MS);
  if (futureDays > 0) {
    return {
      ok: false,
      kind,
      code: 'future-header',
      file,
      newest: parsed.newest,
      currentDate: local.date,
      timeZone: zone,
      detail: `newest header ${parsed.newest} is ${futureDays}d in the future`,
    };
  }

  if (kind === 'nightly') {
    const expected = expectedNightlyDate({
      now,
      timeZone: zone,
      cutoffHour,
    });
    const lagDays = Math.round((dateEpoch(expected) - dateEpoch(parsed.newest)) / DAY_MS);
    return {
      ok: lagDays <= 0,
      kind,
      code: lagDays <= 0 ? 'fresh' : 'stale',
      file,
      newest: parsed.newest,
      expected,
      lagDays: Math.max(0, lagDays),
      timeZone: zone,
      cutoffHour: normalizeCutoffHour(cutoffHour),
      detail: lagDays <= 0
        ? `newest header ${parsed.newest} meets expected fire date ${expected}`
        : `newest header ${parsed.newest} is ${lagDays}d behind expected fire date ${expected}`,
    };
  }

  const ageDays = Math.round((dateEpoch(local.date) - dateEpoch(parsed.newest)) / DAY_MS);
  return {
    ok: ageDays <= maxDays,
    kind,
    code: ageDays <= maxDays ? 'fresh' : 'stale',
    file,
    newest: parsed.newest,
    currentDate: local.date,
    ageDays,
    maxAgeDays: maxDays,
    timeZone: zone,
    detail: ageDays <= maxDays
      ? `newest header ${parsed.newest} is ${ageDays}d old (<=${maxDays}d)`
      : `newest header ${parsed.newest} is ${ageDays}d old (>${maxDays}d)`,
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

export function formatFreshness(result) {
  const label = result.kind === 'dream' ? 'DREAM_CADENCE' : 'NIGHTLY_FRESHNESS';
  const fields = [
    `${label} ${result.ok ? 'PASS' : 'FAIL'}`,
    `code=${result.code}`,
    `newest=${result.newest ?? 'none'}`,
  ];
  if (result.expected) fields.push(`expected=${result.expected}`);
  if (Number.isInteger(result.ageDays)) fields.push(`age_days=${result.ageDays}`);
  if (Number.isFinite(result.maxAgeDays)) fields.push(`threshold_days=${result.maxAgeDays}`);
  if (result.timeZone) fields.push(`time_zone=${result.timeZone}`);
  fields.push(`file=${String(result.file || '').replace(/\\/g, '/')}`);
  return fields.join(' ');
}

const direct = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (direct) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const kind = String(args.kind || '');
    const file = args.file ? path.resolve(String(args.file)) : '';
    if (!kind || !file) {
      throw new Error('usage: nightly-freshness.mjs --kind nightly|dream --file PATH [--now ISO] [--max-days N] [--time-zone Z] [--cutoff-hour N]');
    }
    const result = assessFreshness({
      kind,
      file,
      now: args.now ? new Date(String(args.now)) : new Date(),
      timeZone: args['time-zone'] ?? process.env.AIGENT_NIGHTLY_TIME_ZONE,
      maxAgeDays: Number(args['max-days'] ?? 7),
      cutoffHour: Number(
        args['cutoff-hour']
          ?? process.env.AIGENT_NIGHTLY_CUTOFF_HOUR
          ?? DEFAULT_NIGHTLY_CUTOFF_HOUR,
      ),
    });
    process.stdout.write(formatFreshness(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`NIGHTLY_FRESHNESS ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`);
    process.exit(2);
  }
}
