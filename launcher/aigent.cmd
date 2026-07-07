@echo off
REM aigent.cmd: double-click / PATH entry point for The AIgent (Windows).
REM Thin wrapper so the operator never sees PowerShell flags. Calls aigent.ps1.
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0aigent.ps1" %*
