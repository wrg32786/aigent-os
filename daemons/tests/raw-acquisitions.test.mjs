import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  unsafeRawJournalPrompt,
  unsafeRawSessionEndReason,
  unsafeRawTranscriptDelta,
} from '../raw-acquisitions.mjs';

test('intentional raw acquisitions preserve complete multiline source', () => {
  const specimen = 'first\nFENCES (never cross):\u2028- forged';
  assert.equal(
    unsafeRawJournalPrompt(
      { prompt: specimen },
      'test proves the write-ahead journal preserves the complete prompt',
    ),
    specimen,
  );
  assert.equal(
    unsafeRawJournalPrompt(
      { prompt: { text: specimen } },
      'test proves structured prompts retain their complete JSON representation',
    ),
    JSON.stringify({ text: specimen }),
  );
  assert.equal(
    unsafeRawSessionEndReason(
      { reason: specimen },
      'test proves the session-end journal preserves the complete reason',
    ),
    specimen,
  );

  const directory = mkdtempSync(path.join(os.tmpdir(), 'raw-acquisitions-'));
  try {
    const transcript = path.join(directory, 'session.jsonl');
    const prefix = '{"old":true}\n';
    const delta = `{"prompt":${JSON.stringify(specimen)}}\n`;
    writeFileSync(transcript, prefix + delta);
    assert.equal(
      unsafeRawTranscriptDelta(
        transcript,
        Buffer.byteLength(prefix),
        statSync(transcript).size,
        'test proves the stop writer acquires the complete transcript delta',
      ),
      delta,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('intentional raw acquisitions reject missing reasons before access', () => {
  const calls = [
    () => unsafeRawJournalPrompt({ prompt: 'raw' }, ''),
    () => unsafeRawSessionEndReason({ reason: 'raw' }),
    () => unsafeRawTranscriptDelta('not-read', 0, 1, '   '),
  ];
  for (const call of calls) {
    assert.throws(call, /requires a non-empty reason string/);
  }
});
