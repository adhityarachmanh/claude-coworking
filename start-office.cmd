@echo off
title Adhitron
cd /d "%~dp0"
echo Menjalankan Adhitron... (tutup jendela ini untuk berhenti)
node server.js --open
pause
