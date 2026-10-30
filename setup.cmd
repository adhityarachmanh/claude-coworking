@echo off
title Claude Coworking - Setup
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!!] Node.js belum terpasang. Pasang Node.js 20+ dari https://nodejs.org lalu jalankan setup.cmd lagi.
  echo.
  pause
  exit /b 1
)

rem Checks Node + Claude Code, installs auto-start at Windows login, starts the server now.
node scripts\setup.mjs --autostart
if errorlevel 1 (
  pause
  exit /b 1
)

rem Give the server a moment, then open the office.
timeout /t 3 /nobreak >nul
start "" http://localhost:4317
echo Selesai. Jendela ini boleh ditutup.
pause
