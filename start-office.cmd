@echo off
title Adhit Office
cd /d "%~dp0"
echo Menjalankan Adhit Office... (tutup jendela ini untuk berhenti)
node server.js --open
pause
