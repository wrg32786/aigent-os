#!/usr/bin/env node
// precompact-flush.mjs - PreCompact: side effect only. PreCompact stdout is NOT added to the
// model's context, so this hook prints nothing and instead records state for the next
// SessionStart(source=compact):
//   - no valid capsule  -> write a small marker (.precompact-marker.json) in the capsule dir;
//     session-start-resume.mjs turns it into a "run /capsule" nudge and deletes it.
//   - a valid capsule   -> remove any stale marker. (The post-compact SessionStart hook points
//     at the capsule on its own.)
// The plugin has no background transcript writer (that stays in aigent-os), so it cannot author
// a capsule here. A full aigent-os install owns this hook: exit 0, write nothing.
// Never blocks compaction: any error exits 0. No network.

import {
  readPayload, detectAigentOs, capsuleDir, selectCapsule, maxAgeDays, writeMarker, takeMarker,
} from './capsule-lib.mjs';

try {
  const payload = readPayload();
  if (detectAigentOs(payload).detected) process.exit(0);

  const dir = capsuleDir(payload);
  const { capsule, rejected } = selectCapsule(dir, { maxAgeDays: maxAgeDays() });
  if (capsule) takeMarker(dir);
  else writeMarker(dir, { rejected: rejected.filter((r) => r.reason !== 'already-consumed').map((r) => ({ name: r.name, reason: r.reason })).slice(0, 10) });
} catch (e) {
  try { process.stderr.write(`context-capsule precompact-flush: ${e?.message || e}\n`); } catch { /* nothing more to do */ }
}
process.exit(0);
