# RUN 2 Report

## Files touched

- `daemons/pty-runner.mjs`: optional managed PTY host, sole-input-writer
  transaction, output settlement, receipt-qualified release, lifecycle lock,
  kill-switch degradation, owned teardown, and unmanaged fallback.
- `daemons/tests/transport-conformance.mjs`: reusable ten-vector transport
  conformance suite.
- `daemons/tests/pty-runner.test.mjs`: public-runner adapter, fake-PTY coverage,
  race/edge coverage, launcher checks, Windows argv checks, and real process
  seams.
- `daemons/semantic-search/package.json` and `package-lock.json`: exact
  `node-pty@1.1.0` direct dependency and resolved lock graph.
- `launcher/aigent.sh`, `launcher/aigent.ps1`, and `launcher/aigent.cmd`:
  managed runner front doors with the explicit `--no-deps` unmanaged path.
- `RUN2-REPORT.md`: this report.

`BUILD-SPEC-RUN2.md` is user-owned input and was not changed.

## Test counts

- RUN 2 runner/conformance file: 29 passed, 0 failed, 0 skipped. The ten
  binding transport vectors are all represented and pass through the public
  runner adapter.
- Repository daemon discovery: all 28 of 28 `*.test.mjs` files passed under
  the CI workflow's sequential `node "$f"` execution semantics.
- The 18 `node:test` files contributed 198 tests: 194 passed, 0 failed, and
  4 existing jq-gated statusline cases skipped. All 10 script-style harnesses
  also passed.
- Repository tool-tracker tests: 9 passed, 0 failed, 0 skipped.
- Real Windows ConPTY smoke: `PTY_OK` observed and child exit code 7 preserved.
- `node-pty` load/pin checks, JavaScript syntax checks, Bash syntax, PowerShell
  parsing, and `git diff --check` passed.

The CI loop's first validation call completed the first 18 files before the
host's 240-second command wrapper expired while the nineteenth file was
running. The remaining ten files were then invoked individually with the same
CI `node <file>` semantics and all passed. A later diagnostic attempt to keep
the complete loop inside a persistent child could not launch its nested Node
process in this Windows sandbox and was stopped; it is not counted as a test
result.

A non-authoritative concurrent diagnostic,
`node --test "daemons/tests/*.test.mjs"`, produced one interference failure in
the existing `model-tier-guard` script. That command is not the repository
gate: it runs files concurrently, whereas the workflow deliberately executes
the mixed script/node:test files sequentially. The same guard passed in the
authoritative sequential run.

## Deviations

- Acceptance-command environment discrepancy: on this host's Node v24.15.0,
  the literal `node --test daemons/tests/` command does not discover the
  directory. It treats `daemons/tests` as one module and exits 1 with
  `MODULE_NOT_FOUND` (0 passed, 1 failed). The repository's CI workflow
  documents this exact Node behavior and therefore uses the sequential glob
  loop above; the equivalent split sequential execution was green.
- Fail-closed re-arm boundary: RUN 1's public state machine re-arms a released
  cycle only after a receipt bound to a different session ID. If an anomalous
  higher `source=clear` receipt retains the old session ID, RUN 2 releases
  queued input after fresh output is observed, then emits the named
  `runner-clear-session-not-rotated` degraded state and continues unmanaged.
  It does not manufacture a reset or modify/reimplement RUN 1 state. Normal
  clear receipts with a rotated session re-arm normally.

There are no other implementation deviations.

## Exact validation commands run

Repository-root checks:

```text
node --version
node --check daemons/pty-runner.mjs
node --check daemons/tests/transport-conformance.mjs
node --check daemons/tests/pty-runner.test.mjs
node --test daemons/tests/pty-runner.test.mjs
node --test tests/tool-tracker.test.cjs
bash -n launcher/aigent.sh
powershell.exe -NoProfile -Command "$tokens = $null; $parseErrors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'launcher/aigent.ps1'), [ref]$tokens, [ref]$parseErrors) | Out-Null; if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }; Write-Output 'PowerShell syntax OK'"
node --test daemons/tests/
node --test "daemons/tests/*.test.mjs"
git diff --check
git status --short
```

The repository CI discovery body inspected and run was:

```bash
set -euo pipefail
shopt -s nullglob
files=(daemons/tests/*.test.mjs)
if [ ${#files[@]} -eq 0 ]; then
  echo "No daemons test files matched: the glob or the layout changed."
  echo "Refusing to report a green gate that ran nothing."
  exit 1
fi
echo "Running ${#files[@]} daemons test files"
for f in "${files[@]}"; do
  echo "::group::$f"
  node "$f"
  echo "::endgroup::"
done
```

After the wrapper limit, the unfinished suffix was run as:

```text
node daemons/tests/render-boundary.test.mjs
node daemons/tests/resume-verb.test.mjs
node daemons/tests/semantic-search-deny.test.mjs
node daemons/tests/sessionend-flush.test.mjs
node daemons/tests/state-home-dir.test.mjs
node daemons/tests/statusline-ctx.test.mjs
node daemons/tests/stop-capsule-writer.classify.test.mjs
node daemons/tests/stop-capsule-writer.consumed-reuse.test.mjs
node daemons/tests/stop-capsule-writer.test.mjs
node daemons/tests/userpromptsubmit-journal.test.mjs
```

Dependency checks, from `daemons/semantic-search`:

```text
npm ci --ignore-scripts
npm install --ignore-scripts
npm ls node-pty --depth=0
node --input-type=module -e "import { loadNodePty } from '../pty-runner.mjs'; const loaded = loadNodePty(); console.log(JSON.stringify({ ok: loaded.ok, hasSpawn: typeof loaded.module?.spawn === 'function' })); process.exit(loaded.ok && typeof loaded.module?.spawn === 'function' ? 0 : 1);"
```

The real ConPTY smoke used direct Node argv with this exact `-e` source:

```js
import { loadNodePty } from '../pty-runner.mjs'; const loaded=loadNodePty(); if(!loaded.ok) process.exit(2); const child=loaded.module.spawn(process.execPath,['-e','process.stdout.write("PTY_OK");process.exit(7)'],{name:'xterm-color',cols:80,rows:24,cwd:process.cwd(),env:process.env}); let output=''; child.onData(data=>{output+=data}); child.onExit(({exitCode})=>{console.log(JSON.stringify({output,exitCode})); process.exit(output.includes('PTY_OK')&&exitCode===7?0:1)});
```
