// boot-receipt.mjs -- durable proof that SessionStart actually ran.
//
// WHY THIS EXISTS: a clear submission is not proof that the CLI accepted it.
// The only durable acknowledgement available to a later transport process is
// the SessionStart payload written by the CLI after the new context boots.  A
// monotonic receipt turns that payload into an observable which survives a
// crash and cannot be confused with the boot that preceded the clear.
//
// This file is a library carrier, not another hook entry point.  Direct
// execution intentionally has no main block and therefore performs no write.
// The SessionStart carrier calls writeBootReceipt() before every other boot
// action.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { atomicUpdate } = require('./memory-hygiene/atomic-state.cjs');

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('boot receipt clock returned an invalid date');
  return date;
}

function oneLine(value, maximum = 1000) {
  const collapsed = String(value ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  return JSON.stringify(collapsed.slice(0, maximum));
}

function appendReceiptError({ memRoot, message, fsImpl, observedAt, logError }) {
  if (typeof logError === 'function') {
    try { logError(message); } catch { /* diagnostic hooks never own SessionStart */ }
    return;
  }
  const line = `${observedAt} tag="boot-receipt" message=${oneLine(message)}\n`;
  try {
    fsImpl.appendFileSync(path.join(memRoot, '.daemon-errors.log'), line);
  } catch {
    try { fsImpl.writeSync(2, line); } catch { /* truly nowhere to log */ }
  }
}

function validPreviousReceipt(value) {
  return value
    && typeof value === 'object'
    && Number.isSafeInteger(value.boot_sequence)
    && value.boot_sequence >= 0
    && value.boot_sequence < Number.MAX_SAFE_INTEGER
    && typeof value.session_id === 'string'
    && typeof value.source === 'string'
    && typeof value.observed_at === 'string'
    && Number.isFinite(Date.parse(value.observed_at));
}

/**
 * Persist the current SessionStart observation.
 *
 * All mutable IO is injectable so tests can prove the tmp-plus-rename commit
 * and control the clock without waiting.  Failures are deliberately returned
 * as null after logging: this receipt must never turn a usable SessionStart
 * into a failed hook.
 */
export function writeBootReceipt({
  payload = {},
  memRoot,
  fsImpl = fs,
  now = () => new Date(),
  logError,
} = {}) {
  let observedAt;
  try {
    observedAt = asDate(now()).toISOString();
  } catch (error) {
    observedAt = new Date(0).toISOString();
    appendReceiptError({
      memRoot: String(memRoot || ''),
      message: `write failed: ${error?.message || error}`,
      fsImpl,
      observedAt,
      logError,
    });
    return null;
  }

  const memoryRoot = String(memRoot || '');
  if (!memoryRoot) {
    appendReceiptError({
      memRoot: memoryRoot,
      message: 'write failed: memRoot is required',
      fsImpl,
      observedAt,
      logError,
    });
    return null;
  }

  const receiptPath = path.join(memoryRoot, 'runtime', 'boot-receipt.json');
  let written = null;
  let priorProblem = null;
  const notePriorProblem = (detail) => {
    if (priorProblem === null) priorProblem = detail;
  };

  try {
    atomicUpdate(receiptPath, (text) => {
      let sequence = 0;
      if (text === null) {
        notePriorProblem('previous receipt missing');
      } else {
        try {
          const previous = JSON.parse(text);
          if (!validPreviousReceipt(previous)) throw new TypeError('invalid boot_sequence');
          sequence = previous.boot_sequence + 1;
        } catch (error) {
          notePriorProblem(`previous receipt corrupt (${error?.message || error})`);
        }
      }

      written = {
        boot_sequence: sequence,
        session_id: String(payload?.session_id ?? ''),
        source: String(payload?.source ?? 'startup'),
        observed_at: observedAt,
      };
      return `${JSON.stringify(written, null, 2)}\n`;
    }, {
      fsImpl,
      now: () => asDate(now()).getTime(),
    });
    if (priorProblem !== null) {
      appendReceiptError({
        memRoot: memoryRoot,
        message: `${priorProblem}; boot_sequence reset to 0`,
        fsImpl,
        observedAt,
        logError,
      });
    }
    return written;
  } catch (error) {
    appendReceiptError({
      memRoot: memoryRoot,
      message: `write failed: ${error?.message || error}`,
      fsImpl,
      observedAt,
      logError,
    });
    return null;
  }
}
