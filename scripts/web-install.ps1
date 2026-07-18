# aigent-OS remote installer (Windows)
# Fetches aigent-OS onto disk. Run via:
#   irm https://tools.theaigent.xyz/os/install.ps1 | iex
#
# This script only clones/updates the aigent-OS checkout. It does not run
# the framework installer itself -- that stays a separate, inspectable local
# step (bash install.sh), per docs/install-security.md's "no remote-fetch-
# and-execute" guarantee for the framework installer.
#
# PowerShell 5.1 and PowerShell 7+ compatible. No param() block (breaks
# under "irm | iex"), no Read-Host, no interactive prompts. Safe to re-run.
#
# All logic lives inside a function and uses 'return' instead of 'exit' so
# that a failure never closes the caller's interactive shell when this
# script arrives via "irm | iex". 'exit' only fires when this file is run
# directly as a .ps1 (a real child process, where closing it is correct).

function Invoke-AigentOSInstall {
    $repoUrl = 'https://github.com/wrg32786/aigent-os.git'
    $repoMatch = 'wrg32786/aigent-os'

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "[aigent-OS installer] ERROR: git was not found on your PATH."
        Write-Host ""
        Write-Host "git is required to download aigent-OS. Install it, then re-run this command:"
        Write-Host "  winget install --id Git.Git -e"
        Write-Host "  or: https://git-scm.com/downloads"
        Write-Host ""
        return 1
    }

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "[aigent-OS installer] ERROR: Claude Code was not found on your PATH."
        Write-Host ""
        Write-Host "aigent-OS runs inside Claude Code, so it needs to be installed first:"
        Write-Host "  npm install -g @anthropic-ai/claude-code"
        Write-Host ""
        Write-Host "No Node.js/npm, or want another install option? See https://claude.ai/code"
        Write-Host "Then re-run this command."
        Write-Host ""
        return 1
    }

    $targetDir = $env:AIGENT_OS_DIR
    if ([string]::IsNullOrWhiteSpace($targetDir)) {
        $targetDir = Join-Path $HOME 'aigent-os'
    }

    if (Test-Path -LiteralPath $targetDir -PathType Leaf) {
        Write-Host ""
        Write-Host "[aigent-OS installer] ERROR: $targetDir already exists and is a file, not a directory."
        Write-Host 'Set $env:AIGENT_OS_DIR to a different path and re-run this command.'
        Write-Host ""
        return 1
    }

    $dirExists = Test-Path -LiteralPath $targetDir -PathType Container
    $dirEmpty = $true
    if ($dirExists) {
        $existingItems = Get-ChildItem -LiteralPath $targetDir -Force -ErrorAction SilentlyContinue
        $dirEmpty = (($existingItems | Measure-Object).Count -eq 0)
    }

    $isOurRepo = $false
    if ($dirExists -and -not $dirEmpty) {
        $null = & git -C $targetDir rev-parse --is-inside-work-tree 2>$null
        if ($LASTEXITCODE -eq 0) {
            $remoteUrl = & git -C $targetDir remote get-url origin 2>$null
            if ($LASTEXITCODE -eq 0 -and $remoteUrl -match [regex]::Escape($repoMatch)) {
                $isOurRepo = $true
            }
        }
    }

    if ($dirExists -and -not $dirEmpty -and -not $isOurRepo) {
        Write-Host ""
        Write-Host "[aigent-OS installer] ERROR: $targetDir already exists and is not an aigent-OS checkout."
        Write-Host "Nothing was changed. Point somewhere else with:"
        Write-Host '  $env:AIGENT_OS_DIR = "C:\path\you\want"'
        Write-Host "then re-run this command."
        Write-Host ""
        return 1
    }

    if ($isOurRepo) {
        Write-Host "Existing aigent-OS checkout found at $targetDir. Pulling latest..."
        & git -C $targetDir pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "[aigent-OS installer] ERROR: git pull failed in $targetDir."
            Write-Host "Check for local changes or a diverged branch, resolve manually, then re-run."
            Write-Host ""
            return 1
        }
    } else {
        Write-Host "Cloning aigent-OS into $targetDir ..."
        & git clone $repoUrl $targetDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "[aigent-OS installer] ERROR: git clone failed. Check your network connection and try again."
            Write-Host ""
            return 1
        }
    }

    Write-Host ""
    Write-Host "aigent-OS is ready at: $targetDir"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. cd `"$targetDir`""
    Write-Host "  2. bash install.sh"
    Write-Host "  3. Open Claude Code in that directory (or run: claude)"
    Write-Host "     First time in this directory, run /start to complete setup."
    Write-Host ""
    return 0
}

$aigentInstallExitCode = Invoke-AigentOSInstall

# Only exit the process when this file is actually running as a script file
# (a dedicated child process). When the same text arrives via "irm | iex",
# $MyInvocation.MyCommand.Path is empty and calling exit here would close
# the user's interactive shell -- so it's skipped.
if ($MyInvocation.MyCommand.Path) {
    exit $aigentInstallExitCode
}
