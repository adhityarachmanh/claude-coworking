@echo off
title Adhitron - Setup
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!!] Node.js belum terpasang. Pasang Node.js 20+ dari https://nodejs.org lalu jalankan setup.cmd lagi.
  echo.
  pause
  exit /b 1
)

rem Step by step: Node + Claude Code, Tailscale, firewall rule, auto-start + start the server now.
rem Every install asks first (Y/n).
node scripts\setup.mjs
if errorlevel 1 (
  pause
  exit /b 1
)

start "" http://localhost:4317
pause
