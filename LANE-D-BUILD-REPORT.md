# Lane D Build Report — lifecycle filesystem integrity (F003 + F005)

Date: 2026-07-31 (America/Los_Angeles)  
Workspace: `C:/dev/wt-aigent-lane-d`  
Supplied baseline pin: `a9d1cc720cefe68e64054df7f5e324a94284812f`

## Outcome

F003 and F005 are implemented with committed-shape tests. The final bounded full-daemon gate completed with 172 passes, 0 failures, and 7 named skips across 179 tests. The working tree is intentionally uncommitted.

Lane D focused tests comprise 19 tests: 18 passed, 0 failed, and 1 skipped because this Windows sandbox denies native file-symlink creation. The equivalent injected file-link vector and a native Windows junction-parent vector both executed and passed.

## Changed files

- `daemons/lifecycle-common.mjs`
- `daemons/resume-verb.mjs`
- `daemons/memory-hygiene/atomic-state.cjs`
- `daemons/stop-capsule-writer.mjs`
- `daemons/tests/atomic-state.lock-ownership.test.mjs`
- `daemons/tests/capsule-path-integrity.test.mjs` (new)
- `daemons/tests/stop-capsule-writer.lock-ownership.test.mjs` (new)
- `daemons/tests/render-boundary-guard.test.mjs`
- `LANE-D-BUILD-REPORT.md` (new)

## Requirement disposition

| Req. | Disposition | Measured implementation/evidence |
|---|---|---|
| 1 | Complete | `assertCapsulePathContained()` canonicalizes the capsules root with `realpath`, uses `path.relative` containment, walks every component below the root with `lstat`, rejects file links and parent links/junctions, rejects non-regular leaves, and compares the actual canonical path with the expected path below the canonical root. Native Windows junction-parent coverage passed. |
| 2 | Complete | Fresh guards run at selector read (`selector-read`), resume re-read (`resume-reread`), and consume (`consume-final-read`, stage, and commit). Selection ranking and result fields remain unchanged. |
| 3 | Complete | Consume now stages to an operation-unique in-root path using exclusive `wx`. Both final and temporary names are checked before staging and checked again immediately before rename. Unsafe cleanup is refused. |
| 4 | Complete | Path refusals are typed `CapsulePathRefusal` / `ECAPSULEPATH` and carry stable `reason` and `stage` fields. Selector refusals enter `rejected`; resume re-read refusals enter `rejected` and the daemon log; consume refusals are caught and logged by the resume verb. Tests prove degraded/no-crash behavior. |
| 5 | Complete | Stop writer delegates to the sole lock implementation in `atomic-state.cjs`. Each acquisition token is `<pid>-<24 random hex chars>`. Stale takeover uses operation-unique rename quarantines whose names bind the reaper token and expected marker fingerprint. The actor deletes only its own quarantine, never a later canonical pathname. Release uses the same boundary and refuses non-owners with `ELOCKOWNERSHIP`. |
| 6 | Complete | Stop acquisition uses `timeoutMs: 0`, `staleMs: 30_000`, and target `runtime/stop-writer/<sid>`. Contention exits 0 with `SWE_OUTCOME:noop:lock-defer`; the state/offset file remains byte-identical. Normal worker flush, exit 0, offset advance, and lock/quarantine cleanup passed. Release refusal is logged and remains fail-open. |
| 7 | Complete | Deterministic tests commit the stale-observer/successor interleaving; the contender times out and the successor token remains. Slow prior-owner release throws loudly without deleting the successor. Unverifiable non-owner release refuses, and a genuinely stale dead/damaged marker is recovered and released normally. |
| 8 | Complete | All new security vectors were made assertion-RED against the untouched mechanism or an exact pre-edit reproduction. Harness launch failures and the native symlink skip were excluded from RED evidence. Transcripts follow. |
| 9 | Complete | Platform and measurement residue is named below. No unexercised class is presented as measured. |
| 10 | Complete with runner discrepancy | The literal ordered command was run and exposed a Node-on-Windows directory-argument incompatibility. The complete 28-file suite was then run by glob with bounded concurrency: 179 tests, 172 pass, 0 fail, 7 named skips. |

## EXPECTED-RED evidence

### F003 initial committed-shape vectors

Command, run before production edits:

```text
node --test daemons/tests/capsule-path-integrity.test.mjs
```

```text
exit 1
tests 9
pass 1
fail 7
skipped 1
cancelled 0
todo 0
```

The seven intended assertion failures were:

1. Selector accepted the injected capsule-file symlink.
2. Selector accepted the canonical sibling-prefix escape.
3. Resume re-read did not degrade after the selected path changed to a link.
4. Consume did not refuse final-path drift at commit.
5. Consume did not refuse temporary-path drift at commit.
6. Consume followed a native Windows junction parent.
7. Consume wrote through a lexical sibling-prefix escape.

The byte-preserving ordinary-consume control passed. Native `symlinkSync(..., 'file')` returned `EPERM`, so that skip was not counted as RED; the injected file-link assertion failed normally.

### F003 late-added authority/logging vectors

Two tests were added after the initial RED. They were run against a disposable exact reproduction of the baseline `read final -> rewrite -> write final` mechanism and the pre-edit resume catch discipline:

```text
node --test C:\tmp\lane-d-f003-late-red.test.mjs
```

```text
exit 1
tests 2
pass 0
fail 2
skipped 0
```

- Baseline emitted no typed `capsule-path-symlink` / `consume-final-commit` log because it ignored the injected boundary filesystem and did not refuse.
- Baseline raised no `capsules-root-required` exception; its one-argument marker wrote the arbitrary target.

The disposable reproduction was removed after measurement. Both failures were assertions, not import, syntax, or harness errors.

### F005 ownership and stale-successor vectors

Command, run against the unmodified atomic-state mechanism:

```text
node --test daemons/tests/atomic-state.lock-ownership.test.mjs
```

```text
exit 1
tests 5
suites 1
pass 2
fail 3
duration_ms 725.5131
```

The three assertion failures proved that the stale contender deleted/acquired over the committed successor, expired prior-owner release was silent instead of `ELOCKOWNERSHIP`, and an unverifiable marker release was silent instead of `ELOCKOWNERSHIP`.

### F005 Stop-writer delegation

The exact pre-edit Stop-writer import and hand-rolled lock excerpts were base64-fed to the committed wiring assertion:

```text
C:/Program Files/nodejs/node.exe -e "<node:test committed wiring assertion>" "<base64 exact pre-edit excerpt>"
```

```text
exit 1
tests 1
suites 0
pass 0
fail 1
duration_ms 4.2727
```

The assertion failed with `Stop writer must use the one shared ownership-safe lock primitive`. This was an assertion-based exact reproduction, not a parser or fixture error.

## GREEN evidence

### F003 focused gate

```text
node --test daemons/tests/capsule-path-integrity.test.mjs daemons/tests/resume-verb.test.mjs
```

```text
exit 0
tests 39
pass 38
fail 0
skipped 1
duration_ms 5707.6285
```

The one skip is the native Windows file-symlink privilege residue. The Windows junction test executed and passed.

### F005 focused gate

```text
node --test daemons/tests/atomic-state.lock-ownership.test.mjs daemons/tests/stop-capsule-writer.lock-ownership.test.mjs
```

```text
exit 0
tests 8
suites 1
pass 8
fail 0
skipped 0
duration_ms 3986.2144
```

### Structural raw-boundary guard

```text
node --test daemons/tests/render-boundary-guard.test.mjs
```

```text
exit 0
tests 13
pass 13
fail 0
duration_ms 895.0534
```

The guard's exact lifecycle allowances were updated for the new contained accessor. Its scanner was not weakened. Atomic marker fingerprinting was reshaped so raw marker bytes never require a new rendering allowance.

## Full daemon gate

### Literal ordered command

The requested command was run exactly:

```text
node --test daemons/tests/
```

On Node `v24.15.0` for Windows it treated `daemons/tests/` as a module path and returned:

```text
exit 1
Error: Cannot find module 'C:\dev\wt-aigent-lane-d\daemons\tests'
code: MODULE_NOT_FOUND
tests 1
pass 0
fail 1
duration_ms 691.7331
```

This is a runner incompatibility, not product-test evidence, and is not counted green.

### Complete equivalent gate

The repository had 26 top-level `*.test.mjs` files before Lane D, not the order's stated 27. The two new files make 28. All 28 were run with Node's supported glob. Local Git Bash directories were prepended to `PATH` for baseline shell-dependent tests.

The default parallel run completed in 122506.9709 ms with 169 pass, 3 whole-file failures, and 7 skips. The three failures (`discipline-check`, `gateguard`, and `model-tier-guard`) were child-probe timeout starvation. Running those same files with concurrency 1 produced 3/3 pass in 45314.8422 ms. A fully serialized all-file run exceeded the control channel's five-minute response ceiling and produced no usable summary.

The final bounded complete run was:

```text
node --test --test-concurrency=2 daemons/tests/*.test.mjs
```

```text
exit 0
tests 179
suites 1
pass 172
fail 0
cancelled 0
skipped 7
todo 0
duration_ms 188166.2522
```

Named skips:

- 1 Lane D skip: native Windows capsule-file symlink creation denied with `EPERM`.
- 2 pre-existing memory-capture cases: Bash plus `python3` unavailable as a usable pair.
- 4 pre-existing statusline cases: `jq` unavailable.

No standalone git or network command was issued. The required daemon suite includes its own read-only repository assertions; those were not bypassed.

## Named residue and discrepancies

1. **Native file symlink privilege:** this Windows sandbox denied file-symlink creation with `EPERM`. The same refusal logic was executed through injected `lstat`/`realpath`, and a native Windows junction parent executed green, but native file-link creation itself is unmeasured here.
2. **Handle-relative TOCTOU:** Node's path APIs do not provide a portable handle-relative, reparse-point-safe read/rename transaction. Guards are adjacent to each required touch and repeated before staging and commit; an attacker scheduled between the last check and the individual OS path syscall remains an irreducible narrow window in this implementation.
3. **Actual process-kill quarantine recovery:** deterministic committed interleavings, stale/dead marker recovery, and no-leftover-quarantine behavior are measured. An OS-level kill precisely between canonical-to-quarantine rename and recovery was not exercised.
4. **Expired-but-still-executing worker:** the measured contract proves an expired prior handle cannot release/delete a successor and that only the current token owns the pathname. It does not simulate an actually live old worker continuing unrelated application writes after its 30-second lease has expired; that lease boundary is unchanged from baseline semantics.
5. **Source discrepancy:** `reviews/external-review-001/FINAL-DISPOSITION.md` is absent from this worktree. The quoted disposition in the build order was therefore treated as authoritative.
6. **Baseline verification fence:** the supplied pin was not independently queried because the order prohibited git commands. All RED runs used the untouched working-tree mechanism observed before edits or exact saved pre-edit reproductions.
7. **Consume temporary path discrepancy:** baseline consume wrote the final file directly and had no temporary path. This change introduced an exclusive staging path so both final and temporary names could be checked at the required write/commit boundaries.
8. **Test-count discrepancy:** measured baseline inventory was 26 top-level test files, not 27. Final inventory is 28 after the two new Lane D files.
9. **Runner discrepancy:** Node v24.15.0 on this Windows host does not expand a directory argument for `node --test daemons/tests/`; the complete supported glob gate is the zero-failure result reported above.

LANE-D SELF-TESTS: 18/19
