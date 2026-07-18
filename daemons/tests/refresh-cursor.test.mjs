// daemons/tests/refresh-cursor.test.mjs — the capture-cursor primitive.
// Run: node --test daemons/tests/refresh-cursor.test.mjs
//
// Golden-fixture transcripts -> expected cursor; cursorEqual/cursorAdvanced truth
// table; and a CONCURRENT-WRITE RACE test (read at EVERY mid-write byte position
// must never over- or under-count).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCursor, cursorEqual, cursorAdvanced } from '../refresh-cursor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── shared fixture + helpers ─────────────────────────────────────────────────
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'refresh-cursor-golden.json'), 'utf8'),
);
const vec = (name) => {
  const v = FIXTURE.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`fixture vector not found: ${name}`);
  return v;
};
// On-disk bytes for a vector: complete lines each + '\n', then the torn trailing.
function bytesOf(v) {
  return Buffer.from(v.lines.map((l) => l + '\n').join('') + (v.trailing || ''), 'utf8');
}
// Inject a buffer as the transcript; stat reports its byte length.
function depsFor(buf) {
  return { readFile: () => buf, stat: () => ({ size: buf.length }) };
}
function cursorOf(v) {
  const buf = bytesOf(v);
  return readCursor('X:/fake/<slug>/<sid>.jsonl', depsFor(buf));
}

// ── golden-fixture transcripts -> expected cursor ────────────────────────────
describe('readCursor — golden fixture vectors', () => {
  for (const v of FIXTURE.vectors) {
    it(`${v.name}: ${v.doc}`, () => {
      assert.deepEqual(cursorOf(v), v.expected);
    });
  }

  it('empty transcript -> null', () => {
    assert.equal(cursorOf(vec('empty')), null);
  });

  it('partial-trailing-line -> cursor at last COMPLETE line, torn bytes ignored', () => {
    const partial = cursorOf(vec('partial_trailing_line'));
    const multi = cursorOf(vec('multi_line'));
    assert.deepEqual(partial, multi);
    assert.equal(partial.event_id, 'u3');
  });

  it('multi-line -> cursor at the final complete line', () => {
    assert.deepEqual(cursorOf(vec('multi_line')), { event_id: 'u3', offset: 89 });
  });

  it('offset counts BYTES not chars (astral multibyte char)', () => {
    assert.equal(cursorOf(vec('multibyte')).offset, 28);
  });

  it('corrupt last complete line -> falls back to previous boundary', () => {
    assert.deepEqual(cursorOf(vec('corrupt_last_line_fallback')), { event_id: 'u2', offset: 61 });
  });

  it('no top-level uuid -> event_id from message.id', () => {
    assert.equal(cursorOf(vec('message_id_fallback')).event_id, 'msg_abc123');
  });

  it('only a torn partial (no newline yet) -> null', () => {
    assert.equal(cursorOf(vec('no_complete_line')), null);
  });
});

// ── growth-by-one ────────────────────────────────────────────────────────────
describe('readCursor — growth by one line advances the cursor', () => {
  it('before -> after: strictly advanced, not equal, new event_id', () => {
    const before = cursorOf(vec('growth_before'));
    const after = cursorOf(vec('growth_after'));
    assert.equal(cursorAdvanced(before, after), true);
    assert.equal(cursorEqual(before, after), false);
    assert.ok(after.offset > before.offset, 'offset must strictly increase');
    assert.notEqual(after.event_id, before.event_id);
  });
});

// ── cursorEqual / cursorAdvanced truth tables ────────────────────────────────
describe('cursorEqual truth table', () => {
  const A = { event_id: 'a', offset: 5 };
  const cases = [
    ['same event_id+offset', A, { event_id: 'a', offset: 5 }, true],
    ['offset differs', A, { event_id: 'a', offset: 6 }, false],
    ['event_id differs', A, { event_id: 'b', offset: 5 }, false],
    ['null,null', null, null, true],
    ['null,cursor', null, A, false],
    ['cursor,null', A, null, false],
  ];
  for (const [name, a, b, expected] of cases) {
    it(name, () => assert.equal(cursorEqual(a, b), expected));
  }
});

describe('cursorAdvanced truth table', () => {
  const cases = [
    ['cur beyond prev', { event_id: 'a', offset: 5 }, { event_id: 'b', offset: 6 }, true],
    ['cur behind prev', { event_id: 'b', offset: 6 }, { event_id: 'a', offset: 5 }, false],
    ['equal offsets', { event_id: 'a', offset: 5 }, { event_id: 'a', offset: 5 }, false],
    ['prev null, cur set', null, { event_id: 'a', offset: 1 }, true],
    ['prev set, cur null', { event_id: 'a', offset: 5 }, null, false],
    ['both null', null, null, false],
  ];
  for (const [name, prev, cur, expected] of cases) {
    it(name, () => assert.equal(cursorAdvanced(prev, cur), expected));
  }
});

// ── CRLF robustness (local; the shared fixture is LF-only like real transcripts)
describe('readCursor — CRLF transcripts', () => {
  it('strips trailing CR before parse; offset counts the \\r\\n bytes', () => {
    const buf = Buffer.from('{"uuid":"c1"}\r\n{"uuid":"c2"}\r\n', 'utf8');
    const cur = readCursor('x', depsFor(buf));
    assert.equal(cur.event_id, 'c2');
    assert.equal(cur.offset, buf.length);
  });
  it('torn CRLF (\\r without \\n) -> last complete line, no over-count', () => {
    const buf = Buffer.from('{"uuid":"c1"}\r\n{"uuid":"c2"}\r\n{"uuid":"c3"}\r', 'utf8');
    const cur = readCursor('x', depsFor(buf));
    assert.equal(cur.event_id, 'c2');
    assert.equal(cur.offset, Buffer.byteLength('{"uuid":"c1"}\r\n{"uuid":"c2"}\r\n', 'utf8'));
  });
});

// ── CONCURRENT-WRITE RACE ────────────────────────────────────────────────────
describe('readCursor — concurrent-write race (never over/under-counts)', () => {
  const LINES = [
    '{"uuid":"r1","type":"user"}',
    '{"uuid":"r2","type":"assistant","t":"go 🚀"}',
    '{"uuid":"r3","type":"user"}',
  ];
  const boundaries = [];
  let acc = 0;
  for (const l of LINES) { acc += Buffer.byteLength(l + '\n', 'utf8'); boundaries.push(acc); }
  const torn = '{"uuid":"r4","type":"assis';
  const full = Buffer.from(LINES.map((l) => l + '\n').join('') + torn, 'utf8');

  it('read at every byte position lands exactly on the last complete boundary', () => {
    let lastOffset = 0;
    for (let p = 0; p <= full.length; p++) {
      const slice = full.subarray(0, p);
      const cur = readCursor('x', depsFor(slice));
      let expected = null;
      for (const b of boundaries) { if (b <= p) expected = b; }
      if (expected === null) {
        assert.equal(cur, null, `p=${p}: no complete line yet -> null`);
      } else {
        assert.equal(cur.offset, expected, `p=${p}: must sit on boundary ${expected}`);
        assert.ok(cur.offset <= p, `p=${p}: never over-counts past available bytes`);
        assert.ok(cur.offset >= lastOffset, `p=${p}: never regresses (no under-count)`);
        lastOffset = cur.offset;
      }
    }
  });

  it('the torn 4th write never advances the cursor past line 3', () => {
    const b3 = boundaries[2];
    for (let p = b3; p <= full.length; p++) {
      const cur = readCursor('x', depsFor(full.subarray(0, p)));
      assert.equal(cur.offset, b3, `p=${p}: torn tail must not advance the cursor`);
      assert.equal(cur.event_id, 'r3');
    }
  });
});
