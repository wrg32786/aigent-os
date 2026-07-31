# Launcher Install Fix Report

Date: 2026-07-31

Baseline: `5156cf168afc853614552191e53132b28299b544` on
`titus/f001-standalone-transport`

Disposition: fix, regression vector, and this report are uncommitted for titus.

## Outcome

COPY-mode installs now include `launcher/`. A newly copied
`launcher/aigent.sh` also receives its required executable bit without changing
the permissions of a pre-existing target file. No transport assertion,
`daemons/` file, `launcher/` file, or RUN-1/2/3 file changed.

## RED first

`tests/test-installer-launcher-copy.sh` was added while `install.sh` was still
identical to the pinned baseline. The vector builds the same small synthetic
source shape used by the existing installer harness, runs `install.sh` in COPY
mode against a scratch target, then asserts both managed front doors exist and
the shell front door is executable.

Transcript:

```text
$ git rev-parse HEAD
5156cf168afc853614552191e53132b28299b544

$ git diff --exit-code -- install.sh
# exit 0; no output

$ bash tests/test-installer-launcher-copy.sh
FAIL: copy install omitted launcher/aigent.sh
# exit 1
```

This is the requested failure mode: the COPY install completed, but the first
launcher postcondition failed because the target had no `launcher/` tree.

## Measurement and fix

The directory fix is the requested addition:

```text
-COPY_DIRS=(system vault hooks skills daemons scripts docs memory evals)
+COPY_DIRS=(system vault hooks skills daemons scripts docs memory evals launcher)
```

One additional installer-owned correction was measured rather than inferred:

```text
$ git ls-files -s -- launcher/aigent.sh launcher/aigent.ps1
100644 f226ee455af94a803ceb0454d4c3a34c7655ef39 0 launcher/aigent.ps1
100644 1abfcf1ddeec057295f1ffcab807b87df3da7a7d 0 launcher/aigent.sh

$ sed -n '202p' launcher/install.sh
chmod +x "$here/aigent.sh"
```

A POSIX checkout therefore supplies `aigent.sh` as `0644`, while the launcher's
own installer establishes `+x`. The top-level installer now records whether the
target launcher was absent before the tree copy and applies `chmod +x` only to
that newly copied, symlink-safe file. The existing single audited
`copy_missing_tree` callsite remains unchanged.

## GREEN evidence

### Regression vector

```text
$ bash tests/test-installer-launcher-copy.sh
[1/1] copy install ships executable shell and PowerShell launchers
launcher copy installer suite passed (1/1)
# exit 0
```

### Four installer control shapes

All controls used disposable copies of the existing minimal installer fixture
and `--no-deps`.

| Mode | Path shape | Result |
|---|---|---:|
| in-place | MSYS script/current-directory path | exit 0, `Mode: in-place`, ready |
| in-place | native Windows `--target` path | exit 0, `Mode: in-place`, ready |
| copy | MSYS scratch target (the regression vector) | exit 0, launchers asserted |
| copy | native Windows spaced `--target` path | exit 0, launchers asserted |

Final native-Windows COPY control excerpt:

```text
$ "C:\Program Files\Git\bin\bash.exe" "C:\Users\will\AppData\Local\Temp\launcher-copy-final-control-RKFizV\source\install.sh" --target "C:\Users\will\AppData\Local\Temp\launcher-copy-final-control-RKFizV\copy target" --no-deps
Source: /tmp/launcher-copy-final-control-RKFizV/source
Target: /tmp/launcher-copy-final-control-RKFizV/copy target
Mode:   copy
[ok] launcher/
[ok] aigent-OS is ready
# exit 0; launcher/aigent.sh and launcher/aigent.ps1 both present
```

### Full tracked-tree COPY control

An additional control removed ignored worktree residue from the source: it
expanded `git archive HEAD` into a scratch directory, overlaid the final
uncommitted `install.sh`, and installed that complete shipped tree into a second
scratch target with `--no-deps`.

```text
Source: /tmp/launcher-tracked-copy-control-kKAE4h/source
Target: /tmp/launcher-tracked-copy-control-kKAE4h/reference install
Mode:   copy
[ok] launcher/
[ok] Skills: 71 new, 0 existing directories processed
[ok] Agents: 9 new, existing definitions processed
[ok] aigent-OS is ready
# exit 0

$ test -f "$TARGET/launcher/aigent.sh" \
    && test -f "$TARGET/launcher/aigent.ps1" \
    && test -x "$TARGET/launcher/aigent.sh"
# exit 0
```

### Standard repository gate

The final clean run used the requested standard entry. Git Bash was prepended
to the tool runner's PATH because the runner did not expose `bash` by default.

```text
$ node --test
tests 230
suites 2
pass 224
fail 0
cancelled 0
skipped 6
todo 0
duration_ms 122437.9013
# exit 0
```

Totals: repository gate `224 passed / 0 failed / 6 platform-skipped` out of 230
discovered; launcher COPY vector `1/1` passed. Earlier environment-invalid or
pre-correction diagnostics are not counted as green evidence.

Additional final checks:

```text
$ bash -n install.sh tests/test-installer-launcher-copy.sh
# exit 0

$ node --test daemons/tests/render-boundary-guard.test.mjs
tests 13
pass 13
fail 0

$ git diff --check
# exit 0; no output
```

## Diff scope and fences

Intended deliverable scope:

- `install.sh`: add `launcher` to `COPY_DIRS`; restore `+x` only for a newly
  copied, symlink-safe `launcher/aigent.sh`.
- `tests/test-installer-launcher-copy.sh`: new isolated COPY-mode regression
  vector.
- `LAUNCHER-INSTALL-FIX-REPORT.md`: this evidence report.

`git diff --name-only` names only `install.sh` among tracked files; the test and
report are new and intentionally untracked. A scoped diff over `daemons/`,
`launcher/`, BUILD-SPEC-RUN1/2/3, and RUN1/2/3 reports is empty. The pre-existing
dispatcher artifacts `.launcher-install-run.err` and
`FIX-ORDER-LAUNCHER-INSTALL.md` were preserved and are not deliverables.

## Law XX residue

- The regression vector is local and synthetic. It does **not** prove a
  networked fresh clone, remote availability or authenticity, bootstrap
  checksum verification, archive/checkout line-ending behavior, or dependency
  installation (`--no-deps` is deliberate).
- This Windows/MSYS filesystem synthesizes executable status, so the local
  `test -x` cannot itself distinguish `0644` from `0755`. The tracked `100644`
  measurement and explicit `chmod +x` establish the POSIX correction; a POSIX
  run of the same vector is the direct mode-bit proof.
- The installer intentionally does not chmod a pre-existing target launcher;
  the vector proves a fresh COPY install, not repair of user-owned residue on a
  rerun.
- Presence and mode are proved here. Networked installation and live launcher
  behavior remain separate acceptance surfaces.

LAUNCHER-INSTALL SELF-TESTS: 1/1
