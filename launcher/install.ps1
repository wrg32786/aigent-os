# install.ps1: wire up the "AIgent" front door on Windows.
# Run once (the harness installer calls this after it clones the repo). Creates:
#   1. a PATH shim so `aigent` works in any terminal,
#   2. Desktop + Start-Menu "AIgent" shortcuts (so non-terminal users just click),
#   3. the AIGENT_HOME user env var pointing at the harness.
#
# Usage:  pwsh -File install.ps1 -AigentHome "C:\Users\<you>\aigent"

param(
  [string]$AigentHome = (Join-Path $env:USERPROFILE 'aigent')
)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'aigent.cmd'
if (-not (Test-Path $launcher)) { throw "aigent.cmd not found next to install.ps1" }

# ── Harness setup (must run BEFORE shortcut/PATH wiring) ─────────────────────
$Root = Split-Path $PSScriptRoot -Parent   # repo root = parent of launcher/

# H1. Populate .claude/skills/ from skills/
$skillsSrc  = Join-Path $Root 'skills'
$skillsDst  = Join-Path $Root '.claude\skills'
New-Item -ItemType Directory -Force $skillsDst | Out-Null
if (Test-Path $skillsSrc) {
  foreach ($dir in Get-ChildItem $skillsSrc -Directory) {
    $skillFile = Join-Path $dir.FullName 'SKILL.md'
    if (Test-Path $skillFile) {
      $dst = Join-Path $skillsDst $dir.Name
      if (-not (Test-Path $dst)) {
        Copy-Item -Recurse $dir.FullName $dst
        Write-Host "  [harness] skill copied: $($dir.Name)"
      }
    }
  }
}

# H2. Render .claude/settings.json from template (forward slashes, no BOM)
$tplPath  = Join-Path $Root '.claude\settings.json.template'
$jsonPath = Join-Path $Root '.claude\settings.json'
if ((Test-Path $tplPath) -and (-not (Test-Path $jsonPath))) {
  $rootFwd = $Root.Replace('\', '/')
  $content = (Get-Content $tplPath -Raw) -replace 'AIGENT_ROOT', $rootFwd
  [System.IO.File]::WriteAllText($jsonPath, $content)
  Write-Host "  [harness] settings.json rendered ($rootFwd)"
}

# H3. Vault runtime folders
foreach ($folder in @('vault/daily','vault/projects','vault/people','vault/concepts','vault/memory')) {
  New-Item -ItemType Directory -Force (Join-Path $Root $folder) | Out-Null
}
Write-Host "  [harness] vault folders ensured"
# ─────────────────────────────────────────────────────────────────────────────

# 1. AIGENT_HOME (user scope) so the launcher always finds the harness.
[Environment]::SetEnvironmentVariable('AIGENT_HOME', $AigentHome, 'User')

# 2. PATH shim: ~/.aigent/bin/aigent.cmd -> the real launcher. Add bin to PATH.
$bin = Join-Path $env:USERPROFILE '.aigent\bin'
New-Item -ItemType Directory -Force $bin | Out-Null
@"
@echo off
call "$launcher" %*
"@ | Set-Content -Encoding ascii (Join-Path $bin 'aigent.cmd')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$bin*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User')
}

# 3. Desktop + Start-Menu shortcuts named "AIgent" (brand icon if present).
$icon = Join-Path $PSScriptRoot 'aigent.ico'   # drop a 256px brand .ico here
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'),
                   (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'AIgent.lnk'))
  $lnk.TargetPath       = 'pwsh.exe'
  $lnk.Arguments        = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$($PSScriptRoot)\aigent.ps1`""
  $lnk.WorkingDirectory = $AigentHome
  $lnk.Description       = 'The AIgent: wake your operator'
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
}

Write-Host "AIgent installed. Open it from the Desktop icon, or type 'aigent' in a NEW terminal."
Write-Host "(New terminal needed once so PATH refreshes.)"
