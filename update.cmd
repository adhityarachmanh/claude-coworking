@echo off
title Adhit Office - Update
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!!] Node.js belum terpasang. Jalankan setup.cmd dulu.
  echo.
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!!] Git belum terpasang. Pasang dari https://git-scm.com lalu jalankan update.cmd lagi.
  echo.
  pause
  exit /b 1
)

rem Fetch, show what is new, ask (Y/n), git pull --ff-only, clean restart. Local changes are never touched.
node scripts\update.mjs %*
pause
