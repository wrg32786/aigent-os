@echo off
REM aigent.cmd: double-click / PATH entry point for The AIgent (Windows).
REM Thin wrapper into the managed PowerShell front door.
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0aigent.ps1" %*
exit /b %ERRORLEVEL%
