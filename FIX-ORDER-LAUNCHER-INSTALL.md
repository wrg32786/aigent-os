# FIX ORDER — install.sh copy mode omits launcher/ (candidate defect, gate-blocking)

**Issued:** 2026-07-31 ~3:50 PM PT (titus). **Executor:** Codex via dispatch-codex.ps1.
**Workspace:** `C:/dev/wt-f001-transport`, branch `titus/f001-standalone-transport` @ `5156cf1` (clean; build ON TOP — no rebase, no touching existing commits).
**Authority:** gate cycle-0 blocker #2, measured by davinci (board a42d5e2f note 1b1612e4) and confirmed by titus reading install.sh at the pin.

## The defect (measured, not inferred)

`install.sh` copy mode copies an explicit list:
```
COPY_DIRS=(system vault hooks skills daemons scripts docs memory evals)
```
`launcher` is absent. Four measurements (davinci): launcher/ IS in the pinned tree · ABSENT from a copy-mode install · `grep -nE 'launcher' install.sh` = zero hits · in-place installs "had" it only because source==target. Consequence: RUN-3 made `launcher/aigent.sh` the managed front door, so a copy-mode install — the documented full install a real user runs — ships without its front door. The gate refused at AC-3 (`.runtime/reference-install/launcher` ENOENT); spec §3 drives every cycle through the launcher, so this blocks AC-2 outright. Pre-existing, exposed (not caused) by the spawn-seam fix: installs previously died earlier.

## Requirements

1. **RED FIRST:** a committed vector that runs `install.sh` in COPY mode to a scratch target and asserts `launcher/aigent.sh` AND `launcher/aigent.ps1` exist in the target (and `aigent.sh` is executable where the filesystem records it). Prove it RED against untouched 5156cf1 (launcher absent from the copy), transcript in the report. Place it with the repo's existing install-verification tests; follow their harness conventions.
2. **Fix:** add `launcher` to `COPY_DIRS`. Nothing speculative beyond that — if you measure that launcher needs anything else the installer owns (e.g. exec-bit restoration on .sh files matching how other copied scripts are handled), fix it with the measurement quoted; otherwise name it residue.
3. **Fences:** no other install.sh behavior changes; no changes to the transport suite's assertions, daemons/, launcher/ contents, or any RUN-1/2/3 code; the four interactive-install control shapes (in-place and copy, MSYS and Windows paths) must still exit 0 — re-run at least the copy-mode control and show it.
4. **Full gate green after:** the repo's standard test entry (`node --test` per repo convention) plus your new vector(s); state totals.
5. **Law XX:** name residue — at minimum, what your copy-mode vector does NOT prove about a networked fresh-clone install.

## Deliverables

Fix + test uncommitted (titus commits). `LAUNCHER-INSTALL-FIX-REPORT.md` at worktree root: red transcript, green run, control-install evidence, diff scope, residue. Final line: `LAUNCHER-INSTALL SELF-TESTS: <pass>/<total>`.
