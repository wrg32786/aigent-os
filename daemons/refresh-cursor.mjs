// refresh-cursor.mjs — the capture-cursor primitive for the two-verb lifecycle.
//
// The single source of truth for "how far has this session been captured
// through." Pure, dependency-injected, PTY-free.
//
// Source of truth = the session TRANSCRIPT jsonl, NOT the stop-writer state file
// (whose offset only advances on Stop events — proven stale mid-turn).
//
//   Cursor = { event_id: string, offset: number }
//     offset   = byte index just PAST the terminating newline of the last COMPLETE
//                jsonl line = the cumulative "captured-through" byte boundary.
//     event_id = that line's `uuid` (or its assistant message id).
//   readCursor(transcriptPath, {readFile, stat}) -> Cursor | null
//   cursorEqual(a, b)         -> event_id AND offset both equal
//   cursorAdvanced(prev, cur) -> cur strictly beyond prev

import { readFileSync, statSync } from 'node:fs';
const defaultReadFile = (p) => readFileSync(p);           // Buffer (no encoding)
const defaultStat = (p) => statSync(p);                   // Stats (.size)

// Works entirely in BYTES (Buffer), never JS-string chars, so the offset is a true
// byte boundary regardless of multibyte UTF-8 content in the transcript.

const NEWLINE = 0x0a; // '\n'
const CR = 0x0d;      // '\r'

// event_id for a parsed transcript record: the line's own `uuid`, else the
// assistant message id (message.id).
function cursorEventId(obj) {
  if (obj && typeof obj.uuid === 'string' && obj.uuid) return obj.uuid;
  if (obj && obj.message && typeof obj.message.id === 'string' && obj.message.id) return obj.message.id;
  return null;
}

// Parse ONE physical line's bytes (terminating newline already excluded). Strips
// a single trailing CR so CRLF transcripts parse. Returns {ok:true,obj}|{ok:false}.
function parseLineBytes(bytes) {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === CR) end -= 1;
  if (end === 0) return { ok: false };
  try {
    return { ok: true, obj: JSON.parse(bytes.toString('utf8', 0, end)) };
  } catch {
    return { ok: false };
  }
}

// Scan `buf` for the last COMPLETE (newline-terminated) line that parses AND
// carries an event identity (uuid or message.id). offset = byte index just PAST
// that line's terminating newline = cumulative boundary (monotonic as complete
// lines are appended). Bytes after the final newline are the torn/mid-write
// trailing segment and are NEVER counted (race-safe: a partial append can neither
// over- nor under-count). Two backward-fallback rules compose:
//   torn-line rule: a newline-terminated line that fails to parse falls back to
//     the previous complete line's boundary;
//   cursor-neutral rule: a line that parses but has NO identity (uuid-less harness
//     metadata) is skipped the same way. Real transcript tails end with such
//     records constantly; anchoring the cursor to the last IDENTITY-bearing line
//     keeps metadata churn from moving the cursor. A transcript with no
//     identity-bearing line at all -> null (not-ready; the caller retries per its
//     own null-cursor rule).
function scanCursor(buf) {
  let searchEnd = buf.length; // exclusive upper bound for this line's newline hunt
  while (searchEnd > 0) {
    const nl = buf.lastIndexOf(NEWLINE, searchEnd - 1);
    if (nl === -1) break; // no (more) newline-terminated line -> nothing complete
    const lineStart = nl > 0 ? buf.lastIndexOf(NEWLINE, nl - 1) + 1 : 0;
    const res = parseLineBytes(buf.subarray(lineStart, nl));
    if (res.ok) {
      const eventId = cursorEventId(res.obj);
      if (eventId !== null) return { event_id: eventId, offset: nl + 1 };
    }
    searchEnd = nl; // corrupt or identity-less -> previous newline boundary
  }
  return null;
}

// readCursor(transcriptPath, {readFile, stat}) -> Cursor | null. deps default to
// real fs; a torn/absent/empty file is fail-soft -> null (never throws).
function readCursor(transcriptPath, deps) {
  const d = deps || {};
  const readFile = d.readFile || defaultReadFile;
  const stat = d.stat || defaultStat;
  let size = null;
  try {
    const st = stat(transcriptPath);
    size = st && typeof st.size === 'number' ? st.size : null;
  } catch {
    return null;
  }
  if (size === 0) return null;
  let buf;
  try {
    buf = readFile(transcriptPath);
  } catch {
    return null;
  }
  if (buf == null) return null;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf); // byte-exactness if a string slipped in
  if (buf.length === 0) return null;
  return scanCursor(buf);
}

// cursorEqual(a,b): event_id AND offset both equal (null == null -> equal).
function cursorEqual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.event_id === b.event_id && a.offset === b.offset;
}

// cursorAdvanced(prev,cur): cur strictly beyond prev by byte boundary. A first
// cursor (prev null) with any real cur is an advance; a null cur never advances.
function cursorAdvanced(prev, cur) {
  if (cur == null) return false;
  if (prev == null) return true;
  return cur.offset > prev.offset;
}

export { readCursor, cursorEqual, cursorAdvanced };
