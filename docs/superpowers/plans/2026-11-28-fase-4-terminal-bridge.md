# Fase 4 — Terminal bridge di dalam Adhitron (spike + implementasi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** TUI-only features (attach agent view, MCP elicitation, `/batch`, `/ultrareview`, `/teleport`) berjalan di panel Terminal dalam Adhitron, bukan window terpisah.

**Architecture:** `xterm.js` di browser ↔ WebSocket ber-token ↔ helper PTY (ConPTY) di server. Perintah dipatok (`claude attach <id>`, `claude`, `opencode`), bukan shell bebas; hanya laptop.

**Spec:** `docs/superpowers/specs/2026-11-28-adopsi-penuh-tahap-2-design.md` (Fase 4).

## Global Constraints

- Native addon harus jalan di paket **Node SEA** (Node 22) — buktikan dulu, jangan asumsikan.
- Tanpa shell bebas: argv allowlist dari `src/terminal-launch.js`.
- Laptop-only (bukan WiFi read-only); sesi ditutup saat app keluar; audit singkat.
- Jika spike gagal: pertahankan fallback `/terminal` (Windows Terminal) dan catat alasannya.

## Task 1: Spike PTY (timebox 1 sesi)

- [ ] `npm install --no-save node-pty` + `node -e "require('node-pty')"` di Node 22 dan Node terpasang.
- [ ] Buat `tools/pty-spike.mjs`: spawn `cmd.exe`, kirim `echo halo`, baca output, exit.
- [ ] Uji `claude attach <id>` dan `opencode` TUI bisa dirender (lebar/tinggi).
- [ ] Uji pemuatan dari SEA: helper `.node` di folder `native/` + `createRequire` (bukan di dalam blob).
- [ ] Catat hasil (versi, ABI, error) di `docs/design-opencode.md → Catatan upstream` / komentar.

## Task 2: Helper PTY + WebSocket

- [ ] `src/pty-helper.js`: proses terpisah dijalankan oleh Node runtime portabel; protokol baris JSON (spawn/resize/input/exit).
- [ ] Route WebSocket ber-token di `server.js` (upgrade hanya untuk path `/ws/terminal`, token sesi, laptop-only).
- [ ] Batas: satu terminal per project, ukuran frame, idle timeout, kill saat putus.

## Task 3: UI terminal

- [ ] `xterm.js` + fit addon disajikan dari `public/vendor` (tanpa bundler).
- [ ] Modal/panel Terminal: pilih mode (attach/claude/opencode), tombol Stop, status.
- [ ] Sambungkan tombol **Attach (terminal)** dan `/terminal` ke panel ini; fallback Windows Terminal bila PTY tidak tersedia.

## Task 4: Rilis

- [ ] Security review (akses terminal dari Tailscale, token, kill switch).
- [ ] `test:smoke` + area UI; dokumentasi FITUR/matriks/CHANGELOG; rilis.
