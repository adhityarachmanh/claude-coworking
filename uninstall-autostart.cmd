@echo off
title Claude Coworking - Hapus auto-start
cd /d "%~dp0"
node scripts\setup.mjs --remove
pause
