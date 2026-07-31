# RUN 3 Report

## Baseline and scope

- Work started from a clean worktree at `cb904d0`.
- `cb904d0` differs from `3a1d66a` only by the tracked
  `BUILD-SPEC-RUN3.md`.
- Before the committed-baseline RED runs, this command exited 0:

  ```text
  git diff --exit-code cb904d0 -- daemons/pty-runner.mjs launcher/aigent.sh launcher/aigent.ps1 launcher/aigent.cmd
  ```

  Only `daemons/tests/pty-runner.test.mjs` contained the new vectors.
- No commit was created.

## What changed

- `runPtySession` now reads `AIGENT_PRESSURE_THRESHOLD_PCT` at the
  production wiring site. An absent value explicitly passes the core's
  existing default of 80; a decimal integer from 5 through 95 is passed to
  every transport construction/rebind; any set invalid value emits
  `DEGRADED:auto-clear-threshold-invalid <raw>` on stderr and launches the
  session unmanaged before a PTY, runner lock, or transport is created.
- `aigent.sh` and `aigent.ps1` now collect arguments only after the first
  literal `--`, consume `--no-deps` everywhere, and append the remaining
  arguments after `/start` or `--continue /open`. The shell's empty-array
  expansion uses the Bash-3-safe nounset guard required by stock macOS Bash.
- Five hermetic vectors bind the real transport construction seam and the
  actual sh/PowerShell launcher argv shapes. The PowerShell parser is also
  source-bound for hosts without PowerShell.

## Files touched

- `daemons/pty-runner.mjs`
- `daemons/tests/pty-runner.test.mjs`
- `launcher/aigent.sh`
- `launcher/aigent.ps1`
- `RUN3-REPORT.md`

`launcher/aigent.cmd` remains byte-identical: its existing `%*` delegation to
`aigent.ps1` already implements the required command-file behavior.
`daemons/auto-clear-transport.mjs` is untouched.

## RED-first evidence

V1 through V4 ran while every scoped production file still matched
`cb904d0`. All excerpts below are copied from the test runner output.

### V1 threshold-applied

Command exited 1:

```text
node --test --test-name-pattern='^V1 ' daemons/tests/pty-runner.test.mjs
```

```text
✖ V1 threshold-applied: env=15 reaches the production transport constructor (18.8961ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  undefined !== 15
```

### V2 threshold-invalid-refuses

Command exited 1:

```text
node --test --test-name-pattern='^V2 ' daemons/tests/pty-runner.test.mjs
```

```text
✖ V2 threshold-invalid-refuses: env=abc is loud and automation stays disarmed (12.5172ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    {
  +   line: '',
  +   managedSpawnCount: 1,
  +   mode: 'managed',
  +   runnerPresent: true,
  -   line: 'DEGRADED:auto-clear-threshold-invalid abc\n',
  -   managedSpawnCount: 0,
  -   mode: 'degraded',
  -   runnerPresent: false,
      transportConstructionCount: 0,
  +   unmanagedSpawnCount: 0
  -   unmanagedSpawnCount: 1
    }
```

This single RED exposes both lying halves: the named line was absent and the
managed PTY was armed.

### V3 threshold-unset-default

Command exited 1:

```text
node --test --test-name-pattern='^V3 ' daemons/tests/pty-runner.test.mjs
```

```text
✖ V3 threshold-unset-default: absent env passes 80 to the production constructor (15.7144ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  undefined !== 80
```

### V4 pass-through

Command exited 1:

```text
node --test --test-name-pattern='^V4 ' daemons/tests/pty-runner.test.mjs
```

```text
✖ V4 pass-through: literal -- suffix follows fixed args for sh and ps1 (3300.7505ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

      powershellReturning: [
        '--',
        '--continue',
        '/open',
  -     '--model',
  -     'haiku',
  -     'two words',
  -     '*',
  -     '--',
  -     'tail'
      ],
  +   powershellSourceBound: false,
  -   powershellSourceBound: true,
      shellFirstRun: [
        '--',
        '/start',
  -     '--model',
  -     'haiku',
  -     'two words',
  -     '*',
  -     '--',
  -     'tail'
      ],
      shellReturning: [
        '--',
        '--continue',
        '/open',
  -     '--model',
  -     'haiku',
  -     'two words',
  -     '*',
  -     '--',
  -     'tail'
      ]
```

The final test uses `opaque;value=$HOME` instead of `*` to remove
Git-for-Windows startup glob expansion from the test vantage. This was a
harness-only refinement after the captured baseline RED.

### V5 no-dash-dash unchanged

V5 requires the command to be byte-identical to the committed baseline, so
its behavior-only test was necessarily GREEN on `cb904d0`:

```text
✔ V5 no-dash-dash unchanged: decoy args leave both fixed command shapes byte-identical (3778.5043ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

The vector's more specific contract says it is RED against a pass-through
change that perturbs the default path. The tests therefore preceded a
temporary, natural unconditional-forward implementation. That mutation was
not retained. Against it, the V5 command exited 1 with:

```text
✖ V5 no-dash-dash unchanged: decoy args leave both fixed command shapes byte-identical (8218.4062ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    {
      powershellReturning: [
        '--',
        '--continue',
        '/open',
  +     '--model',
  +     'opus',
  +     'two words',
  +     'opaque;value=$HOME'
      ],
      shellFirstRun: [
        '--',
        '/start',
  +     '--model',
  +     'opus',
  +     'two words',
  +     'opaque;value=$HOME'
      ],
      shellReturning: [
        '--',
        '--continue',
        '/open',
  +     '--model',
  +     'opus',
  +     'two words',
  +     'opaque;value=$HOME'
      ]
    }
```

This provenance is stated explicitly rather than mislabeling baseline behavior
as a failure.

## GREEN evidence

The final focused command exited 0:

```text
✔ V1 threshold-applied: env=15 reaches the production transport constructor (36.4252ms)
✔ V2 threshold-invalid-refuses: env=abc is loud and automation stays disarmed (52.3187ms)
✔ V3 threshold-unset-default: absent env passes 80 to the production constructor (12.5272ms)
✔ V4 pass-through: literal -- suffix follows fixed args for sh and ps1 (10083.2102ms)
✔ V5 no-dash-dash unchanged: decoy args leave both fixed command shapes byte-identical (10763.7483ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ skipped 0
```

Additional final results:

- `daemons/tests/pty-runner.test.mjs`: 41 passed, 0 failed, 0 skipped.
- Sequential daemon discovery: all 28 of 28 `*.test.mjs` files exited 0.
  The 18 `node:test` files contributed 210 tests: 204 passed, 0 failed, and
  6 environment skips. All 10 script-style harnesses passed.
  - Two existing memory-hygiene skips: `needs bash and python3, which
    memory-capture.sh itself requires`.
  - Four existing statusline skips: `jq unavailable`.
- `tests/tool-tracker.test.cjs`: 9 passed, 0 failed, 0 skipped.
- JavaScript syntax checks, Bash syntax, PowerShell AST parsing, and
  `git diff --check` passed.
- SHA-256 values for the runner, test file, and both launchers were unchanged
  from the start through the end of the final 28-file gate.

## Exact validation commands and mechanics

```text
git status --short
git diff --exit-code cb904d0 -- daemons/pty-runner.mjs launcher/aigent.sh launcher/aigent.ps1 launcher/aigent.cmd
node --test --test-name-pattern='^V1 ' daemons/tests/pty-runner.test.mjs
node --test --test-name-pattern='^V2 ' daemons/tests/pty-runner.test.mjs
node --test --test-name-pattern='^V3 ' daemons/tests/pty-runner.test.mjs
node --test --test-name-pattern='^V4 ' daemons/tests/pty-runner.test.mjs
node --test --test-name-pattern='^V5 ' daemons/tests/pty-runner.test.mjs
node --test --test-name-pattern='^V[1-5] ' daemons/tests/pty-runner.test.mjs
node --test daemons/tests/pty-runner.test.mjs
node --test tests/tool-tracker.test.cjs
node --check daemons/pty-runner.mjs
node --check daemons/tests/pty-runner.test.mjs
bash -n launcher/aigent.sh
powershell.exe -NoLogo -NoProfile -Command "$tokens = $null; $parseErrors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'launcher/aigent.ps1'), [ref]$tokens, [ref]$parseErrors) | Out-Null; if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }; Write-Output 'PowerShell syntax OK'"
git diff --check
git status --short
```

The successful final daemon gate enumerated `daemons/tests`, filtered and
sorted the 28 names ending in `.test.mjs`, and awaited this exact argv for
each file before starting the next:

```text
node ["daemons/tests/<sorted-name>.test.mjs"]
```

That is the repository CI loop's direct, sequential `node "$f"` semantics.
The orchestrator used a 180-second per-file timeout and stopped on any
nonzero exit. An earlier Bash-wrapper diagnostic stalled at file 5 in this
Windows sandbox and was terminated; it is not counted as validation evidence.

## Deviations

zero deviations, stated.
