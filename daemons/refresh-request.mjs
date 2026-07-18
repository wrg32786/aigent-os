// refresh-request.mjs — the controller-to-session request-intake primitive.
//
// The controller->session CHALLENGE CROSSING. The controller mints a 32-byte
// base64url nonce and drops a short-lived RefreshRequest file into the session's
// runtime dir; the session's deterministic autofire worker reads it and hands the
// RAW challenge to runCapsuleVerb (which computes the sha256:<hex> digest). The raw
// nonce is NEVER persisted in the pointer / cycle record / capsule / vault — only
// this transient request file carries it, and only until the cycle consumes it.
//
//   RefreshRequest = {
//     version: 1,
//     cycle_id: string,
//     challenge: string,                 // raw base64url nonce — transient ONLY
//     captured_through_hint: { event_id: string|null, offset: number },  // Cursor
//     expires_at: string,                // ISO8601 — worker refuses past this
//     issued_at: string,                 // ISO8601
//   }
//   writeRequest(seatMemRoot, sid, req) -> path        // atomic tmp+rename, loud
//   readRequest(seatMemRoot, sid)       -> req | null  // fail-closed (absent/torn -> null)
//   createRequest(fields)               -> req         // pure constructor, loud on bad input
//
// File location: <seatMemRoot>/runtime/refresh-request-<sid>.json (one per session).
// Same atomic write discipline as refresh-cycle.mjs / curated-close-pointer.mjs.

import {
  readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, writeSync,
} from 'node:fs';
import path from 'node:path';

// Loud-but-non-fatal diagnostic. readRequest fails CLOSED (returns null) rather
// than handing a half-trusted request to the cycle, but a PRESENT-yet-broken file
// is a real anomaly the operator must see — stderr is visible to a hook tail and is
// never injected into model context. ENOENT (no request yet) stays quiet: absence
// is the normal steady state, not a failure.
function warn(msg) {
  try { writeSync(2, `${new Date().toISOString()} [refresh-request] ${msg}\n`); } catch { /* nowhere to log */ }
}

function requestPath(seatMemRoot, sid) {
  if (typeof seatMemRoot !== 'string' || seatMemRoot.trim().length === 0) {
    throw new Error('refresh-request: seatMemRoot must be a non-empty path');
  }
  if (typeof sid !== 'string' || sid.trim().length === 0) {
    throw new Error('refresh-request: session id (sid) is required to locate the request path');
  }
  return path.join(path.resolve(seatMemRoot), 'runtime', `refresh-request-${sid}.json`);
}

// Loud, specific problems — never a bare "invalid". Empty array = valid shape.
// Shape validation only: expiry is a POLICY the worker applies against its own
// clock (so a past expires_at is a well-formed request the reader still surfaces —
// the worker, not the reader, decides it is too old to fire).
function validateRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return ['request is not an object'];
  const problems = [];
  if (req.version !== 1) {
    problems.push(`version must be 1, got: ${JSON.stringify(req.version)}`);
  }
  for (const f of ['cycle_id', 'challenge']) {
    if (typeof req[f] !== 'string' || req[f].length === 0) {
      problems.push(`${f} must be a non-empty string, got: ${JSON.stringify(req[f])}`);
    }
  }
  for (const f of ['issued_at', 'expires_at']) {
    if (typeof req[f] !== 'string' || !Number.isFinite(Date.parse(req[f]))) {
      problems.push(`${f} must be an ISO8601 string, got: ${JSON.stringify(req[f])}`);
    }
  }
  const hint = req.captured_through_hint;
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) {
    problems.push('captured_through_hint must be an object');
  } else {
    if (hint.event_id !== null
      && (typeof hint.event_id !== 'string' || hint.event_id.length === 0)) {
      problems.push(`captured_through_hint.event_id must be a non-empty string or null, got: ${JSON.stringify(hint.event_id)}`);
    }
    if (!Number.isInteger(hint.offset) || hint.offset < 0) {
      problems.push(`captured_through_hint.offset must be a non-negative integer, got: ${JSON.stringify(hint.offset)}`);
    }
  }
  return problems;
}

// Pure constructor — no disk I/O. Fills version 1, issued_at now, and a zeroed
// hint when absent, then validates. Throws loud on malformed input rather than
// returning a half-built request.
export function createRequest(fields = {}) {
  const now = new Date().toISOString();
  const hint = fields.captured_through_hint || {};
  const req = {
    version: 1,
    cycle_id: fields.cycle_id ?? null,
    challenge: fields.challenge ?? null,
    captured_through_hint: {
      event_id: hint.event_id ?? null,
      offset: hint.offset ?? 0,
    },
    expires_at: fields.expires_at ?? null,
    issued_at: fields.issued_at ?? now,
  };
  const problems = validateRequest(req);
  if (problems.length) {
    throw new Error(`refresh-request: cannot create malformed request: ${problems.join('; ')}`);
  }
  return req;
}

// Atomic tmp+rename write (mirrors refresh-cycle.mjs's writeCycleRecord). Refuses
// to persist a malformed request — a partial/garbage challenge must never reach the
// session, so the failure is loud (throw) not a silently-written bad file.
export function writeRequest(seatMemRoot, sid, req) {
  const problems = validateRequest(req);
  if (problems.length) {
    throw new Error(`refresh-request: refusing to write malformed request for sid=${sid}: ${problems.join('; ')}`);
  }
  const file = requestPath(seatMemRoot, sid);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(req, null, 1));
  try {
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(file, { force: true });
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(req, null, 1));
      try { rmSync(tmp, { force: true }); } catch { /* tmp orphan is harmless */ }
    }
  }
  return file;
}

// Fail-closed read: an absent file (normal — no request yet), an unreadable file,
// unparsable JSON (a torn mid-write rename), or a shape-invalid record ALL return
// null — never a throw, never a half-trusted request. The worker treats null as a
// hard refusal of the cycle: no /clear, no injection fires on a challenge it could
// not fully verify. This is the safe direction under a concurrent controller write.
export function readRequest(seatMemRoot, sid) {
  let file;
  try {
    file = requestPath(seatMemRoot, sid);
  } catch (e) {
    warn(`bad request path (seatMemRoot=${JSON.stringify(seatMemRoot)}, sid=${JSON.stringify(sid)}): ${e?.message || e}`);
    return null;
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // no request yet — steady state, quiet
    warn(`request unreadable at ${file}: ${e?.message || e}`);
    return null;
  }
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    warn(`torn/malformed request JSON at ${file}: ${e?.message || e}`);
    return null;
  }
  const problems = validateRequest(req);
  if (problems.length) {
    warn(`invalid request shape at ${file}: ${problems.join('; ')}`);
    return null;
  }
  return req;
}

export { requestPath };
