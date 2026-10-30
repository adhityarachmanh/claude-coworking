@echo off
title Adhit Office - Hapus auto-start
cd /d "%~dp0"
node scripts\setup.mjs --remove
pause
