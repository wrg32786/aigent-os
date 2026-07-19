# aigent-OS remote installer (Windows)
# Fetches aigent-OS onto disk. Run via:
#   irm https://tools.theaigent.xyz/os/install.ps1 | iex
#
# For a checksum-verified variant (recommended -- fetches this script and
# its checksum from GitHub at a pinned commit instead of trusting whatever
# the domain above currently serves), see:
#   docs/install-security.md#checksum-pinned-install
#
# This script only clones/updates the aigent-OS checkout. It does not run
# the framework installer itself -- that stays a separate, inspectable local
# step (bash install.sh), per docs/install-security.md's "no remote-fetch-
# and-execute" guarantee for the framework installer.
#
# PowerShell 5.1 and PowerShell 7+ compatible. No param() block (breaks
# under "irm | iex"), no Read-Host, no interactive prompts. Safe to re-run.
#
# All logic lives inside a function and uses 'return' instead of 'exit', and
# 'exit' only runs at the very end, gated on $MyInvocation.MyCommand.Path.
# That gate is non-empty whenever this text is loaded FROM A FILE -- both
# "pwsh -File web-install.ps1" (a real child process, where exiting is
# correct) and dot-sourcing a saved copy into the CURRENT session (where
# calling exit would still close the caller's shell, same as it would for
# any dot-sourced script). It is empty only when the text arrives inline via
# "irm | iex", which is the one-liner this script ships as -- that is the
# case this gate exists to protect, and it is exercised by that command.
# Prefer "& .\web-install.ps1" (or just double-click / pwsh -File) over
# dot-sourcing a saved copy if you want exit codes to never touch your shell.

function Invoke-AigentOSInstall {
    # $env:AIGENT_OS_REPO_URL exists only so tests/test-web-install.sh can
    # point this script at a local fixture remote instead of the real GitHub
    # repo (mirrors the existing $env:AIGENT_OS_DIR override below). If an
    # attacker already controls your environment variables they already have
    # code execution, so this override is not a new trust boundary -- same
    # caveat the $env:AIGENT_OS_DIR comment below makes for the target
    # directory.
    $repoUrl = $env:AIGENT_OS_REPO_URL
    if ([string]::IsNullOrWhiteSpace($repoUrl)) {
        $repoUrl = 'https://github.com/wrg32786/aigent-os.git'
    }

    function TrimGitSuffix([string]$url) {
        if ($url -and $url.EndsWith('.git')) { return $url.Substring(0, $url.Length - 4) }
        return $url
    }

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

    # If $HOME is unset or empty (uncommon, but possible in some restricted
    # or non-interactive hosts), Join-Path collapses this to the relative
    # path ".\aigent-os" resolved against the current directory instead of
    # the user's home -- not dangerous, just possibly not where they expect.
    $targetDir = $env:AIGENT_OS_DIR
    if ([string]::IsNullOrWhiteSpace($targetDir)) {
        $targetDir = Join-Path $HOME 'aigent-os'
    }

    # A directory starting with "-" would be misread as an option by any
    # command that takes it as a positional argument (e.g. git clone).
    # Reject it outright rather than relying solely on "--" below.
    if ($targetDir.StartsWith('-')) {
        Write-Host ""
        Write-Host "[aigent-OS installer] ERROR: `$env:AIGENT_OS_DIR must not start with '-' (got: $targetDir)."
        Write-Host "Use an absolute path instead."
        Write-Host ""
        return 1
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
            # Exact match only (not a substring/regex test): the local git
            # config at $targetDir is attacker-controlled input. A loose match
            # would accept any origin that merely CONTAINS our org/repo name
            # (a redirect URL, a query string, a lookalike subdomain) without
            # actually being our repo. Normalize a trailing .git either side.
            if ($LASTEXITCODE -eq 0 -and (TrimGitSuffix $remoteUrl) -eq (TrimGitSuffix $repoUrl)) {
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
        Write-Host "Existing aigent-OS checkout found at $targetDir. Updating..."
        # Pin origin to the canonical URL before pulling. The gate check above
        # decides whether this looks like our checkout, but the actual fetch
        # never relies on trusting whatever the local git config had
        # configured -- it always pulls from the URL this script hardcodes.
        & git -C $targetDir remote set-url origin $repoUrl
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "[aigent-OS installer] ERROR: could not set the origin remote in $targetDir."
            Write-Host "Resolve manually, then re-run."
            Write-Host ""
            return 1
        }
        # Fetch + merge the CURRENT branch by name explicitly, rather than a
        # bare "git pull --ff-only" (finding #21). A bare pull follows
        # branch.<name>.remote / branch.<name>.merge from local git config,
        # which is independent of origin's URL: if that tracking config
        # points somewhere else (a remote named e.g. "upstream" added by a
        # prior compromise, or by the operator themselves for development),
        # repinning origin's URL above does not stop the pull from fetching
        # from wherever tracking config says. Naming both the remote and the
        # branch explicitly bypasses that ambient config entirely.
        $currentBranch = & git -C $targetDir rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentBranch) -or $currentBranch -eq 'HEAD') {
            Write-Host ""
            Write-Host "[aigent-OS installer] ERROR: $targetDir has a detached HEAD, not a branch checkout."
            Write-Host "Resolve manually, then re-run."
            Write-Host ""
            return 1
        }
        & git -C $targetDir fetch origin $currentBranch
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "[aigent-OS installer] ERROR: git fetch from the canonical origin failed in $targetDir."
            Write-Host "Check your network connection and try again."
            Write-Host ""
            return 1
        }
        & git -C $targetDir merge --ff-only "origin/$currentBranch"
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "[aigent-OS installer] ERROR: fast-forward merge failed in $targetDir."
            Write-Host "Check for local changes or a diverged branch, resolve manually, then re-run."
            Write-Host ""
            return 1
        }
    } else {
        Write-Host "Cloning aigent-OS into $targetDir ..."
        & git clone -- $repoUrl $targetDir
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
# the user's interactive shell -- so it's skipped. See the header comment
# above: this same emptiness gate does NOT distinguish dot-sourcing a saved
# copy from a real child process -- dot-sourcing still sets a non-empty
# path, so exit still fires there too.
if ($MyInvocation.MyCommand.Path) {
    exit $aigentInstallExitCode
}
