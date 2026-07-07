# aigent.ps1: The AIgent harness launcher (the branded front door).
#
# Goal: a convenience front door for operators who'd rather not type `claude`
# by hand. Double-click the "AIgent" icon (or type `aigent` in any shell) and
# your operator wakes up, warm-resumed, in a branded window. No cd, no flags.
#
# First launch  -> runs the guided first-win flow (/start: install check, the
#                  /operator-setup interview, and one real win) and marks first-run done.
# Every launch after -> `claude --continue` warm-resumes their ongoing operator.
#
# AIGENT_HOME points at the installed harness; the installer sets it (falls back
# to ~/aigent). Plain PowerShell, no build step: edits take effect immediately.

$ErrorActionPreference = 'Stop'
$ESC   = [char]27
$cyan  = "$ESC[38;2;94;230;208m"   # brand cyan #5EE6D0
$dim   = "$ESC[2m"
$reset = "$ESC[0m"
try { $Host.UI.RawUI.WindowTitle = 'The AIgent' } catch {}

$AigentHome = if ($env:AIGENT_HOME) { $env:AIGENT_HOME } else { Join-Path $env:USERPROFILE 'aigent' }

if (-not (Test-Path $AigentHome)) {
  Write-Host ""
  Write-Host "  ${cyan}THE AIGENT${reset}"
  Write-Host "  Harness not found at $AigentHome."
  Write-Host "  Re-run the installer (or set AIGENT_HOME), then open AIgent again."
  Read-Host "  Press Enter to close"
  exit 1
}
Set-Location $AigentHome

Write-Host ""
Write-Host "  ${cyan}THE AIGENT${reset}"
Write-Host "  ${dim}your operator is waking up...${reset}"
Write-Host ""

$marker = Join-Path $AigentHome '.aigent\first-run-done'

if (-not (Test-Path $marker)) {
  # First boot: the guided Day-1 flow. /start owns install-check -> /operator-setup
  # interview -> first win, then writes the marker itself. We also write it as a
  # fallback so a mid-flow exit never re-triggers the whole intro.
  New-Item -ItemType Directory -Force (Split-Path $marker) | Out-Null
  claude "/start"
  if (-not (Test-Path $marker)) { New-Item -ItemType File -Force $marker | Out-Null }
} else {
  # Returning operator: never cold-start. Warm-resume the latest session and orient.
  claude --continue "/open"
}

Write-Host ""
Write-Host "  ${dim}Tip: next time, say ""close up"" before you quit — your AIgent banks the session so it remembers everything.${reset}"
Write-Host ""
