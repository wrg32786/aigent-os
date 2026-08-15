# Regression suite for launcher/aigent.ps1 first-run marker ownership. The
# launcher must retry /start until the /start skill itself records durable
# completion; it must never infer completion from claude exiting alone.
# PowerShell port of tests/test-launcher-first-run-marker.sh (same 3 vectors).

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Root 'launcher\aigent.ps1'
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('aigent-launcher-suite-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Work | Out-Null

$script:LauncherProc = $null
$script:StubPid = $null
$Total = 3

function Cleanup {
    if ($script:StubPid) {
        try { Stop-Process -Id $script:StubPid -Force -ErrorAction Stop } catch {}
        $script:StubPid = $null
    }
    if ($script:LauncherProc -and -not $script:LauncherProc.HasExited) {
        try { $script:LauncherProc.Kill() } catch {}
    }
    try { Remove-Item -Recurse -Force $Work -ErrorAction Stop } catch {}
}

function Fail([string]$Message) {
    [Console]::Error.WriteLine("FAIL: $Message")
    Cleanup
    exit 1
}

# ── claude stub: a real child process, so killing it never kills the launcher ──
$FakeBin = Join-Path $Work 'fakebin'
New-Item -ItemType Directory -Force $FakeBin | Out-Null

$StubPs1 = Join-Path $FakeBin 'claude-stub.ps1'
Set-Content -Path $StubPs1 -Value @'
$ErrorActionPreference = 'Stop'
switch ($env:CLAUDE_STUB_MODE) {
    'noop' { exit 0 }
    'sleep' {
        if (-not $env:CLAUDE_PID_FILE) { exit 2 }
        Set-Content -Path $env:CLAUDE_PID_FILE -Value $PID
        Start-Sleep -Seconds 30
        exit 0
    }
    'complete' {
        if (-not $env:CLAUDE_CALL_LOG) { exit 2 }
        $line = "$($args.Count)"
        foreach ($arg in $args) { $line += "`t$arg" }
        Add-Content -Path $env:CLAUDE_CALL_LOG -Value $line
        if ($args.Count -eq 1 -and $args[0] -eq '/start') {
            $aigentDir = Join-Path $env:AIGENT_HOME '.aigent'
            New-Item -ItemType Directory -Force $aigentDir | Out-Null
            Set-Content -Path (Join-Path $aigentDir 'state.json') -Value '{"schemaVersion":1,"status":"ready"}'
            New-Item -ItemType File -Force (Join-Path $aigentDir 'first-run-done') | Out-Null
        }
        exit 0
    }
    default {
        [Console]::Error.WriteLine("unexpected CLAUDE_STUB_MODE: $($env:CLAUDE_STUB_MODE)")
        exit 2
    }
}
'@

Set-Content -Path (Join-Path $FakeBin 'claude.cmd') -Value @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$StubPs1" %*
exit /b %ERRORLEVEL%
"@

$env:PATH = "$FakeBin;$env:PATH"

# The launcher's product contract is pwsh (aigent.cmd and the installer
# shortcut both target it), so the suite drives it under pwsh too.
# --no-deps is the launcher's own flag for running claude directly instead of
# through the managed runner. Without it the launcher execs
# $AIGENT_HOME/daemons/pty-runner.mjs, and these fixtures are bare temp
# directories with no daemons tree, so the run dies before the stub is reached.
# Marker ownership lives in the top-level first-run branch, outside
# Invoke-AigentClaude, so it behaves identically on both paths; the managed path
# has its own coverage in daemons/tests/pty-runner.test.mjs.
function Invoke-Launcher([string]$LogPath) {
    & pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Launcher --no-deps > $LogPath 2>&1
    return $LASTEXITCODE
}

# ── 1. Zero-exit no-op: launcher must not manufacture completion ────────
$NoopHome = Join-Path $Work 'noop-home'
New-Item -ItemType Directory -Force $NoopHome | Out-Null
$env:AIGENT_HOME = $NoopHome
$env:CLAUDE_STUB_MODE = 'noop'
$NoopExit = Invoke-Launcher (Join-Path $Work 'noop.log')
if ($NoopExit -ne 0) { Fail "no-op /start launcher invocation returned nonzero ($NoopExit)" }
if (Test-Path (Join-Path $NoopHome '.aigent\first-run-done')) {
    Fail 'no-op /start manufactured first-run-done'
}
Write-Host "[1/$Total] zero-exit no-op: no first-run marker"

# ── 2. Interrupted stub: killing its exact PID must leave no marker ────────
$KillHome = Join-Path $Work 'kill-home'
$PidFile = Join-Path $Work 'claude.pid'
New-Item -ItemType Directory -Force $KillHome | Out-Null
$env:AIGENT_HOME = $KillHome
$env:CLAUDE_STUB_MODE = 'sleep'
$env:CLAUDE_PID_FILE = $PidFile

$script:LauncherProc = Start-Process -FilePath 'pwsh' `
    -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Launcher, '--no-deps' `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Work 'kill.log') `
    -RedirectStandardError (Join-Path $Work 'kill.err')

$Deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $Deadline) {
    if ((Test-Path $PidFile) -and (Get-Item $PidFile).Length -gt 0) { break }
    Start-Sleep -Milliseconds 50
}
if (-not ((Test-Path $PidFile) -and (Get-Item $PidFile).Length -gt 0)) {
    Fail 'sleeping claude stub did not publish its PID'
}
$script:StubPid = [int](Get-Content $PidFile | Select-Object -First 1)
if (-not (Get-Process -Id $script:StubPid -ErrorAction SilentlyContinue)) {
    Fail 'claude stub PID was not running'
}
Stop-Process -Id $script:StubPid -Force
$script:StubPid = $null

if (-not $script:LauncherProc.WaitForExit(15000)) {
    Fail 'launcher did not exit after its claude stub was killed'
}
$script:LauncherProc = $null
if (Test-Path (Join-Path $KillHome '.aigent\first-run-done')) {
    Fail 'interrupted /start left a first-run marker'
}
Write-Host "[2/$Total] PID-targeted interruption: no first-run marker"
Remove-Item Env:\CLAUDE_PID_FILE

# ── 3. Skill-owned completion: marker routes the next launch to the warm path ─
#
# The warm path sends --continue and no slash-command. /open is retired
# (docs/capsule-v2-doctrine.md), and the launcher stopped sending it when the
# managed runner landed; this expectation follows the launcher.
$CompleteHome = Join-Path $Work 'complete-home'
$CallLog = Join-Path $Work 'claude-calls.tsv'
New-Item -ItemType Directory -Force $CompleteHome | Out-Null
$env:AIGENT_HOME = $CompleteHome
$env:CLAUDE_STUB_MODE = 'complete'
$env:CLAUDE_CALL_LOG = $CallLog

Invoke-Launcher (Join-Path $Work 'complete-first.log') | Out-Null
if (-not (Test-Path (Join-Path $CompleteHome '.aigent\first-run-done'))) {
    Fail 'completed /start did not leave its skill-owned marker'
}
$StateJson = Get-Content (Join-Path $CompleteHome '.aigent\state.json') -Raw
if ($StateJson -notmatch '"status"\s*:\s*"ready"') {
    Fail 'completed /start did not record ready state'
}

Invoke-Launcher (Join-Path $Work 'complete-second.log') | Out-Null
$ExpectedCalls = @("1`t/start", "1`t--continue")
$ActualCalls = @(Get-Content $CallLog)
if (($ActualCalls.Count -ne $ExpectedCalls.Count) -or
    (@(Compare-Object $ExpectedCalls $ActualCalls -SyncWindow 0).Count -ne 0)) {
    [Console]::Error.WriteLine('expected claude calls:')
    $ExpectedCalls | ForEach-Object { [Console]::Error.WriteLine("  $_") }
    [Console]::Error.WriteLine('actual claude calls:')
    $ActualCalls | ForEach-Object { [Console]::Error.WriteLine("  $_") }
    Fail 'completed first run did not route the second launch to --continue'
}
Write-Host "[3/$Total] skill-owned completion: second launch receives --continue"

Write-Host "launcher first-run marker suite passed ($Total/$Total)"
Cleanup
exit 0
