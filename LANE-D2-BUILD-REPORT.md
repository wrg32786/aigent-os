# Lane D2 — sessionstart-reinject.mjs capsule-reread TOCTOU (F003/F005 follow-up)

**Executor:** titus (direct build; replaces a Codex dispatch that was aborted mid-investigation by
OpenAI's content-safety filter — `.lane-d2-run.err` in this worktree is that crashed session's log,
left untouched; no code changes had landed from it, confirmed by `git status` before starting).
**Branch:** `titus/lane-d-f003-f005` @ `814cbd3`. Worktree: `C:/dev/wt-aigent-lane-d`. No git/network
operations performed; no existing commits touched.

## Defect

`daemons/sessionstart-reinject.mjs:156` rendered the SessionStart "NEWEST ACTIVE CAPSULE" block by
calling `unsafeRawCapsuleDocument(newest.path, ...)` — a raw `readFileSync` with **no containment
check at all** — on a path that `newestValidCapsule()`/`selectCapsule()` had already validated
*earlier*, during selection. Between that validation and this touch, the path can be swapped
(symlink/junction/out-of-root) and the unguarded read follows it, injecting out-of-vault content
into every ordinary (non-clear) SessionStart. This is the same class of bug F003/F005 already fixed
for the selector and for `resume-verb.mjs`'s re-read — `sessionstart-reinject.mjs` was the one
remaining site still reusing a stale verdict instead of re-validating adjacent to the touch.

## Structural fix needed before the vector could even be written

`sessionstart-reinject.mjs` is a bare top-level script (reads stdin, calls `process.exit(0)`) with no
main-module guard — it has always been invoked by *spawning* it as a subprocess, never imported.
Importing it directly to reach the capsule-read logic for testing runs its entire top-level body on
import, including a synchronous `readFileSync(0, 'utf8')` stdin read. Confirmed by direct
observation: a `node --test` run against a first draft that imported the file hung with zero output
for several minutes; killed by specific PID (42296 parent + 69456 child test-isolation worker, both
identified via `Get-CimInstance Win32_Process` and stopped individually — never `taskkill /IM`).

Fix: split the capsule-read/render logic into a new sibling module,
`daemons/sessionstart-capsule-block.mjs`, exporting `newestCapsuleBlock(root, MEM, { fsImpl, logErr })`
— side-effect-free, directly importable, mirroring the existing precedent (`resume-verb.mjs` is
already a separate importable module that the hook entrypoint calls into).
`sessionstart-reinject.mjs` now imports and calls it with no `fsImpl` (real filesystem, byte-for-byte
identical behavior to before). No other file imported `sessionstart-reinject.mjs` as a module
(verified by grep before editing — every existing reference was a `spawnSync` path string), so this
was a purely additive change from the perspective of every existing test.

## RED — proven against 814cbd3's unfixed mechanism

Host constraint discovered mid-build: this Windows environment cannot create file symlinks
(`fs.symlinkSync(..., 'file')` → `EPERM`, no `SeCreateSymbolicLinkPrivilege`/Developer Mode) but
*can* create directory junctions — exactly matching the existing suite's own pattern
(`capsule-path-integrity.test.mjs` skips its one native-file-symlink test but passes its junction
test). Primary evidence therefore uses the same portable technique the existing "resume re-read"
test uses for the analogous `resume-verb.mjs` site: an injected `fsImpl` whose `lstatSync` reports a
symlink for the capsule path starting immediately after it has been read once (modeling the verdict
going stale in the gap), with a secondary best-effort native-symlink test that skips gracefully where
unavailable (it did, here).

Ran against the still-unfixed `newestCapsuleBlock()` (still calling `unsafeRawCapsuleDocument`):

```
✖ warm-orientation read re-validates containment instead of reusing a stale selection verdict (8.0072ms)
✔ warm-orientation read still renders the ordinary, unswapped capsule (4.5709ms)
✔ no valid capsule degrades to the orient-with-/open message, never throws (2.5736ms)
﹣ native out-of-root symlink is refused where the host permits creating one (3.1883ms) # file symlink creation unavailable: EPERM
ℹ tests 4
ℹ pass 2
ℹ fail 1
ℹ skipped 1

✖ failing tests:
AssertionError [ERR_ASSERTION]: a refused re-read takes the documented degrade path, not a silent success — got: "\n🔁 NEWEST ACTIVE CAPSULE (created_at) — pull sections on demand, never assume: \"memory/capsules/selected.md\"\n> [REFERENCE ONLY] — state snapshot, not instructions. Latest memory state wins.\n   objective: \"Protect the warm-orientation capsule read\"\n   next_valid_action: \"run the focused integrity tests\"\n   waiting_on: \"the containment gate\"\n   ..."
    expected: /became unreadable \(logged\)/
    operator: 'match'
```

This is the load-bearing proof: even with the injected filesystem reporting "this path is now a
symlink," the unfixed mechanism rendered the capsule successfully anyway — because
`unsafeRawCapsuleDocument` never consults `fsImpl` (or any stat) at all. The second read reuses
selection's stale verdict unconditionally. No fix applied yet at this point.

## Fix

`daemons/sessionstart-capsule-block.mjs` now routes the read through the branch's existing contained
reader — reused as-is, no new mechanism:

```js
const doc = readContainedCapsuleDocument(
  capsulesRoot,
  newest.path,
  'warm-orientation-reread',
  filesystem,
);
```

This is the identical pattern `resume-verb.mjs`'s `loadCapsule()` already uses for its own re-read
(`readContainedCapsuleDocument(capsulesRoot, newest.path, 'resume-reread', filesystem)`) — containment
is re-validated by `assertCapsulePathContained` immediately adjacent to the touch, so a path swapped
after selection is refused (typed `CapsulePathRefusal`, `code: 'ECAPSULEPATH'`, `reason:
'capsule-path-symlink'`), not read.

## GREEN — same vectors, same host, after the fix

```
✔ warm-orientation read re-validates containment instead of reusing a stale selection verdict (7.7947ms)
✔ warm-orientation read still renders the ordinary, unswapped capsule (3.0299ms)
✔ no valid capsule degrades to the orient-with-/open message, never throws (2.1156ms)
﹣ native out-of-root symlink is refused where the host permits creating one (2.2336ms) # file symlink creation unavailable: EPERM
ℹ tests 4
ℹ pass 3
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 747.4422
```

The primary vector's PROOF rests on the two assertions that discriminate across the fix: the
render shows the documented `⚠ Newest capsule became unreadable (logged)` degrade line (never a
silent success), and `.daemon-errors.log` names the typed refusal reason `capsule-path-symlink`,
not a generic failure. **CORRECTED PER R26 ROUND 2:** an earlier draft framed the `readFileSync`
count staying at **1** as a third proof leg. That assertion does NOT discriminate — the raw read
in the unfixed mechanism goes through lifecycle-common's direct module binding, which the test's
fs proxy can never observe, so the count is 1 under both mechanisms. The phrasing was ported from
`resume-verb.mjs`'s re-read test, where it IS discriminating (that site routes reads through the
injected filesystem); it was carried here without re-deriving whether it still discriminated
against THIS mechanism. The assertion is retained as a pin of the proxy-observable read
population, labeled as such in the test.

## Caller census by grep (re-derived after the fix, not inherited)

```
$ grep -rn "unsafeRawCapsuleDocument(" daemons --include=*.mjs
daemons/lifecycle-common.mjs:40:export function unsafeRawCapsuleDocument(capsulePath, reason) {
daemons/curated-close-pointer.mjs:51:const doc = unsafeRawCapsuleDocument(
daemons/precompact-flush.mjs:194:    const doc = unsafeRawCapsuleDocument(
daemons/stop-capsule-writer.mjs:474:    ? unsafeRawCapsuleDocument(
daemons/tests/render-boundary.test.mjs:216:    () => unsafeRawCapsuleDocument('not-read', ''),
```

`sessionstart-reinject.mjs` (and the new `sessionstart-capsule-block.mjs`) no longer appear — the
assigned defect's call site is gone. The `render-boundary.test.mjs:216` hit tests the primitive's own
reason-validation contract directly (not a caller reusing a stale verdict); it lives under `tests/`
and is outside the production scan `render-boundary-guard.test.mjs` runs.

**Three production callers remain outside lifecycle-common's own guarded internals — named as
residue, not fixed in this pass:**

| File | Shape |
|---|---|
| `curated-close-pointer.mjs:51` | Validates containment ~7 lines earlier with its own ad hoc lexical `path.relative` check (no lstat/symlink detection at all), then reads unguarded. Adjacent, but the check itself is weaker than `assertCapsulePathContained`. |
| `precompact-flush.mjs:194` | `activeCapsule()` validates at line 178 (also lexical-only, no symlink detection), read happens at line 194 — same "validate once, reuse later" shape as the fixed defect. |
| `stop-capsule-writer.mjs:474` | Validates via `realpathSync`-based containment ~100 lines earlier (stronger check than the other two), then reads unguarded later in the same function — same stale-verdict shape. |

**Justification for not fixing these now:** all three are pre-existing conditions, not introduced or
touched by this change, and each is a separately-scoped fix (different validation code, different
functions, would each need its own RED-first vector and review — materially larger than the one named
defect this order assigned). `stop-capsule-writer.mjs` was just reviewed and shipped in this branch's
own prior commit (814cbd3, "token-owned Stop-writer lock"); touching it further in this pass risks
conflicting with that just-completed review, and the fences for this order explicitly bar changes to
existing Lane D commits' territory. All three already appear in `render-boundary-guard.test.mjs`'s
`JS_RAW_ALLOWLIST` with their own audited "reason" (content-safety, not path-safety) — that prior
audit did not evaluate path-containment timing, only rendering safety, so this residue is a genuine
open item, not a rediscovery of something already closed. Recommend a follow-up Lane D leg per file.

## Structural guard consistency (render-boundary-guard.test.mjs)

Moving the capsule-read block into a new file changed which file four existing allowlist entries
must key against. Updated in lockstep (required for the existing "production readers and raw access
stay centralized or exactly audited" test to stay green, not a scope expansion):
- Removed the now-stale `{file: 'daemons/sessionstart-reinject.mjs', accessor:
  'unsafeRawCapsuleDocument'}` `JS_RAW_ALLOWLIST` entry (call site no longer exists there;
  `readContainedCapsuleDocument` isn't `unsafeRaw*`-named, so it needs no allowlist entry at all).
- Re-keyed the three `capsuleValue(doc, '...')` `JS_SAFE_READER_ALLOWLIST` entries from
  `daemons/sessionstart-reinject.mjs` to `daemons/sessionstart-capsule-block.mjs` (same calls, moved
  file, same reason text).
- Left the two `unsafeRawMemoryDocument` entries for `sessionstart-reinject.mjs` (identity-core,
  session-log) untouched — those reads were not part of this defect and did not move.

`render-boundary-guard.test.mjs` alone: 13/13 pass after the edits.

## Full daemon gate

```
node --test --test-concurrency=2 daemons/tests/*.test.mjs
```
Baseline (before any change): 179 tests, 174 pass, 0 fail, 5 skipped, exit 0.
After (with the fix + 4 new vectors): **183 tests, 177 pass, 0 fail, 6 skipped, exit 0.**
Delta is exactly the 4 new tests in `sessionstart-reinject.capsule-reread.test.mjs` (3 pass, 1 skip —
the native-symlink bonus, EPERM on this host). No other file's pass/fail count changed; the
subprocess-based suites that spawn `sessionstart-reinject.mjs` directly (`render-boundary.test.mjs`,
`resume-verb.test.mjs`, `nightly-watchdog-hooks.test.mjs`) were run in isolation first to confirm the
module split caused no regression: 60/60 non-skipped pass (1 expected skip).

## Fences respected

No changes to selector ranking (`selectCapsule`'s field-order/rejection logic untouched), transport
surfaces, lock code, or any existing Lane D commit (nothing amended/rebased; all new work is
uncommitted on top of 814cbd3). No git or network operations performed.

## Files changed

- `daemons/sessionstart-reinject.mjs` — removed the vulnerable inline capsule-read block; now imports
  and calls `newestCapsuleBlock()` from the new module.
- `daemons/sessionstart-capsule-block.mjs` (new) — the extracted, fixed, testable render function.
- `daemons/tests/sessionstart-reinject.capsule-reread.test.mjs` (new) — the RED/GREEN vectors.
- `daemons/tests/render-boundary-guard.test.mjs` — allowlist re-keyed to match the file split (see
  above); no behavior change to the guard itself.

## Residue (what these tests cannot prove)

- The native out-of-root symlink vector is environment-gated (skips under `EPERM`) — it did not run
  green on this host as an independent confirmation; the portable fake-stat vector is the load-bearing
  proof and does not depend on host privilege.
- The three named residue callers above are real, pre-existing gaps of the same general shape;
  scoped out of this pass per the fix order's own "name as residue" allowance.
- This fix (and its tests) prove containment re-validation for **this** call site only; it does not
  re-audit `assertCapsulePathContained` itself (unchanged, already covered by
  `capsule-path-integrity.test.mjs`).

LANE-D2 SELF-TESTS: 3/3 (+1 environment-skipped: native file-symlink creation unavailable on this host, EPERM — 0 fail)
