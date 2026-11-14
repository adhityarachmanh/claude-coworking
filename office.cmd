@echo off
rem 🏢 CLI Adhitron: `office pair` (kode pasangan untuk Tailscale SSH) · `office claude [...]` (CLI bridge opt-in).
if /I "%~1"=="pair" (
  node "%~dp0tools\pair.mjs" %2 %3 %4 %5 %6 %7 %8 %9
) else (
  node "%~dp0tools\cli-bridge\launch.mjs" %*
)
