@echo off
title Adhitron - Setup
cd /d "%~dp0"

rem Works without Node.js: scripts\bootstrap-node.ps1 finds the portable runtime, a system Node, or downloads
rem the official Node.js LTS ZIP (checksum-checked, per-user, no admin). Then scripts\setup.mjs runs:
rem Node + Claude Code (+ optional OpenCode), Tailscale, firewall, auto-start + start the server now.
rem Every install asks first (Y/n); --check only reports.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-node.ps1" %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

if /i not "%~1"=="--check" (
  start "" http://localhost:4317
  pause
)
