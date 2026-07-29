// Explicit declarations for the few lifecycle paths that intentionally acquire
// complete multiline external data. Callers must state why the raw structure is
// required; rendered fields derived from these values still cross inert().

import {
  closeSync,
  openSync,
  readSync,
} from 'node:fs';

function requireReason(reason, accessor) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError(`${accessor} requires a non-empty reason string`);
  }
}

export function unsafeRawJournalPrompt(payload, reason) {
  requireReason(reason, 'unsafeRawJournalPrompt');
  if (typeof payload?.prompt === 'string') return payload.prompt;
  if (payload && typeof payload === 'object'
    && Object.prototype.hasOwnProperty.call(payload, 'prompt')
    && payload.prompt !== null
    && payload.prompt !== undefined) {
    return JSON.stringify(payload.prompt);
  }
  return '';
}

export function unsafeRawSessionEndReason(payload, reason) {
  requireReason(reason, 'unsafeRawSessionEndReason');
  return String(payload?.reason || 'unknown');
}

export function unsafeRawTranscriptDelta(
  transcriptPath,
  startOffset,
  endOffset,
  reason,
) {
  requireReason(reason, 'unsafeRawTranscriptDelta');
  const start = Number(startOffset);
  const end = Number(endOffset);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError('unsafeRawTranscriptDelta requires valid byte offsets');
  }

  const buffer = Buffer.alloc(end - start);
  const descriptor = openSync(transcriptPath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        start + bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(descriptor);
  }
  return buffer.subarray(0, bytesRead).toString('utf8');
}
