# FIX ORDER — Lane D leg 2: the 4th unguarded capsule read (sessionstart-reinject.mjs)

**Issued:** 2026-07-31 ~2:40 PM PT (titus). **Executor:** Codex via dispatch-codex.ps1.
**Workspace:** `C:/dev/wt-aigent-lane-d`, branch `titus/lane-d-f003-f005` @ `814cbd3` (clean; build ON TOP — do not rebase or touch existing commits).
**Authority:** GPT program review (merge-blocking) + r26-lane-d finding 1, board row 92cea5f2 leg 1.

## Defect

`daemons/sessionstart-reinject.mjs:156` reads the SELECTED capsule via `unsafeRawCapsuleDocument(newest.path, ...)` to render the SessionStart "NEWEST ACTIVE CAPSULE" block — after selection validated the path, violating the branch's own invariant: callers must not validate at selection and then reuse that stale verdict for a later read. TOCTOU: the path can change (symlink/junction/out-of-root swap) between selection and this warm-orientation read → out-of-vault document injected into the session prompt. Fires on every ordinary (non-clear) SessionStart.

## Requirements

1. RED FIRST: committed vector — swap the selected capsule path to a symlink/out-of-root target BETWEEN selection and the warm-orientation read; assert the read REFUSES (typed, loud, degrade-never-crash per the branch's established discipline) and nothing out-of-root reaches the rendered block. Prove RED against 814cbd3's mechanism; transcript in report.
2. Route the read through the branch's contained reader (`readContainedCapsuleDocument` / the same guard family Lane D shipped) — reuse, no new mechanism.
3. CALLER CENSUS BY GREP (row AC): after the fix, `unsafeRawCapsuleDocument` has ZERO callers outside lifecycle-common's own guarded internals — the count is re-derived, not inherited. Any remaining caller is either fixed in this pass or NAMED residue with justification.
4. Full daemon gate: `node --test --test-concurrency=2 daemons/tests/*.test.mjs` zero failures, plus new vector(s).
5. Fences: no changes to selector ranking, transport surfaces, lock code, or existing Lane D commits. No git/network (titus commits).

## Deliverables

Code + tests uncommitted on the worktree; `LANE-D2-BUILD-REPORT.md` at worktree root (red/green transcripts, grep census, residue); final line `LANE-D2 SELF-TESTS: <pass>/<total>`.
