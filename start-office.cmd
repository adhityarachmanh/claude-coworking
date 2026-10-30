@echo off
title Claude Coworking
cd /d "%~dp0"
echo Menjalankan Claude Coworking... (tutup jendela ini untuk berhenti)
node server.js --open
pause
