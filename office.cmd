@echo off
rem 🌉 Opt-in CLI bridge: `office claude [...]`. Tanpa perintah ini, CLI tetap seperti biasa.
node "%~dp0tools\cli-bridge\launch.mjs" %*
