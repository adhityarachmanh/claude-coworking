# Adopsi penuh Claude Code & OpenCode — tahap 2 (di luar cakupan lama) — design

Tanggal: 2026-11-28
Status: **menunggu persetujuan user**. Pendekatan yang diusulkan: **Hybrid (native dulu, terminal
terbatas untuk sisa)** huruf C pada diskusi 2026-11-26.
Sumber riset (2026-11-28):

- `code.claude.com/docs/en/commands` (daftar command lengkap), CHANGELOG **Claude Code 2.1.332**
  (25 Nov 2026), `claude attach --help` / `claude agents --help` (2.1.332).
- `github.com/anomalyco/opencode/releases` **v2.4.2** (26 Nov 2026), `opencode --help` (2.4.1
  terpasang), `opencode.ai/docs/cli`.
- Matriks internal: `docs/adopsi-mesin.md` (terakhir 2026-11-26, 1.12.0).

Versi terpasang saat riset: Claude Code **2.1.331** di v26 (rusak) dan **2.1.332** di v24,
OpenCode **2.4.1**; rilis terbaru npm: Claude **2.1.332**, OpenCode **2.4.2**.

## Kenapa

Tujuan user (diulang 2026-11-28): **semua kemampuan mesin Claude Code dan OpenCode bisa dipakai
dari Adhitron, tanpa membuka CLI**, ditambah fitur yang tidak ada di CLI dan bermanfaat. Rilis
1.12.0 sudah menutup sebagian besar domain harian (lihat `docs/FITUR.md` dan
`docs/adopsi-mesin.md`), tetapi masih ada:

1. kemampuan resmi yang belum punya jalur UI (hanya bisa diketik di CLI), dan
2. kemampuan yang secara teknis **tidak punya antarmuka non-interaktif** — hanya bisa lewat TUI
   (`claude attach`, MCP elicitation di `-p`, ultrareview/teleport, `/batch`).

Design lama `2026-11-22-adopsi-tuntas-mesin-design.md` sengaja mengecualikan kelompok (2). User
kini meminta kelompok itu juga. Karena itu tahap ini menambahkan **terminal bridge** sebagai jalur
terakhir, sementara semua yang punya jalur native tetap dibangun sebagai UI Adhitron.

## Tujuan

- Setiap kemampuan resmi kedua mesin punya salah satu: **UI native**, **dijalankan mesin tanpa
  TUI**, atau **terminal bridge** — dengan alasan yang dicatat di matriks.
- Fitur di luar CLI yang menambah nilai nyata: galeri media, biaya skill, pesan antar sesi,
  penghemat biaya/latensi, onboarding tim.
- Per fase kecil, teruji, bisa dirilis; tidak ada big-bang.

## Non-tujuan

- Menyalin seluruh CLI ke Adhitron (mis. editor tema, keybinding).
- Menggantikan mesin; aplikasi tetap memanggil `claude`/`opencode`.
- Fitur enterprise/managed (policy MDM, gateway, self-hosted runner) dan cloud yang tidak bisa
  dijalankan lokal tanpa akun berbayar — tetap bisa lewat terminal, bukan dibangun ulang.
- Menyentuh data project user atau config mesin tanpa izin/backup.

## Anti-tujuan

- Satu rilis raksasa yang lama sebelum ada manfaat terlihat.
- Terminal bebas (shell) yang bisa diakses dari HP/Tailscale.
- Menambah dependensi npm baru selain yang benar-benar dibutuhkan terminal bridge (`node-pty`,
  `xterm`), dan hanya jika spike membuktikannya jalan di paket SEA.

## Batasan & jebakan

- Windows + PowerShell, Node >= 20 ESM, tanpa framework/bundler; teks UI Indonesia, komentar Inggris.
- Server dipaketkan sebagai **Node SEA** (`scripts/build-windows.mjs`); native addon harus dimuat
  dari disk dengan ABI Node yang sama — ini risiko utama terminal bridge, karena itu **spike dulu**.
- `claude attach` hanya membuka sesi di terminal; `claude agents --json` sudah dipakai panel Sesi
  latar. Attach butuh TUI/PTY, bukan `-p`.
- MCP elicitation **tidak tersedia di `-p`** (docs); satu-satunya jalur adalah TUI.
- OpenCode 2.4.2: session arsip otomatis batal saat dikirimi pesan; automation tetap jalan setelah
  run gagal; plan-mode rules ada di system prompt (tidak perlu UI baru).
- Gerbang wajib per fase: `npm run check`, `test:related`, `test:smoke` bila menyentuh server, area
  UI bila menyentuh `public/`. Flaky yang diketahui tetap dikecualikan.

## Pendekatan yang dibahas

- **A — Terminal bridge penuh.** Semua lewat terminal di Adhitron. 100% cepat, tetapi UI bukan
  kantor, keamanan shell besar, dan di HP buruk. Tidak dipilih.
- **B — Native saja.** Rapi, tetapi kelompok (2) tetap butuh CLI. Tidak memenuhi “semua”.
- **C — Hybrid (diusulkan).** Native untuk semua yang punya jalur; terminal **terbatas** hanya
  untuk sisa (attach, elicitation, ultrareview/teleport, `/batch`), laptop-only, perintah dipatok,
  bukan shell bebas. Ini satu-satunya jalur yang memenuhi tujuan tanpa mengorbankan UI harian.

## Rencana bertahap (tiap fase = satu siklus rilis)

### Fase 1 — Permukaan Claude yang belum ada

- **MCP skills** (2.1.332 beta, `server:skill`): tampilkan di 🧩 Skills + bisa dipanggil dari `/`.
- **`/init`**: tombol “Buat/segarkan CLAUDE.md” (jalankan command lewat sesi; tampilkan hasil dan
  diff sebelum menyimpan). Termasuk opsi `CLAUDE_CODE_NEW_INIT` bila aman.
- **`/import`**: wizard impor dari Codex/Gemini/Cursor (`-p --yes`, `--dry-run` dulu) dengan
  pratinjau file yang akan ditulis; backup.
- **Reload & diagnosa**: `/reload-plugins`, `/reload-skills`, `/skill-doctor` (biaya token + pemakaian
  per skill), `/team-onboarding` (panduan Markdown dari riwayat).
- **Sesi**: `/rename` (judul sesi), `/release-notes` (dialog changelog versi terpasang).
- **Hooks**: event `PreSkillShellCommand` di editor hooks (tolak/izinkan perintah shell inline).
- **Kontrol percakapan**: `/branch` (cabang percakapan), `/fork` (salin ke sesi latar), `/subtask`
  (subagent yang mewarisi percakapan penuh) — UI tombol di chat + daftar sesi.
- **Sesi latar**: tombol **Buka di chat** yang melanjutkan sesi latar lewat `--resume <id>` di
  stream-json (probe dulu; jika mesin menolak sesi yang masih berjalan, tampilkan pilihan Stop
  dulu). Ini menggantikan `claude attach` untuk kasus baca/balas, tanpa TUI.
- **`/ship` & `/steward`**: mode “pantau PR” — commit/push/PR lalu perbaiki CI & review sampai
  hijau, dengan batas waktu dan tombol Stop; memakai fitur PR/CI yang sudah ada.
- **`/loop`**: penjadwal per sesi (prompt berulang) memakai scheduler aplikasi; berhenti saat sesi
  ditutup atau app mati.

### Fase 2 — Permukaan OpenCode yang belum ada

- **Export/import sesi** (JSON) untuk backup/pindah mesin; **arsip sesi** (buat, buka, kirim pesan
  membatalkan arsip) + pencarian mencakup arsip.
- **Statistik tool** (`stats --tools`): laju sukses/gagal per tool, umur data, per project; masuk
  ke **Pola kerja**.
- **Renew config** (`opencode reload`) dari UI setelah menyimpan config.
- **Galeri media**: hasil `generate_image`/`generate_video` (dan file media lain) tampil sebagai
  thumbnail/video player, buka folder, salin path; setelan model media.
- **Rotasi akun Claude Agent** (`configDir` daftar folder): pindah otomatis saat limit, dengan
  status akun aktif di panel OpenCode.
- **Judul & fork sesi** setara `run --title/--fork`; opsi buat sesi arsip untuk otomasi.

### Fase 3 — Fitur di luar CLI (pembeda)

- **Biaya skill**: token per skill, berapa kali dipakai, tombol nonaktifkan (setara `/skill-doctor`).
- **Galeri media bersama** (Claude & OpenCode) dengan filter project/jenis.
- **Pesan antar sesi**: kirim pesan dari satu project ke sesi lain di Adhitron (relay hub),
  dengan daftar penerima seperti `/list-agents`; nanti bisa menjembatani `SendMessage` Claude.
- **Penghemat biaya/latensi**: jalankan skill `cost-optimize`/`latency-optimize` untuk project yang
  memakai Anthropic API, tampilkan diff usulan.
- **Onboarding tim**: hasil `/team-onboarding` disimpan sebagai dokumen yang bisa dibagikan.

### Fase 4 — Terminal bridge (spike dulu)

- **Spike**: buktikan `node-pty` (ConPTY) + `xterm` bisa dimuat dari paket SEA Node 22 dan bisa
  menjalankan `claude attach <id>` serta `opencode` TUI. Jika gagal, alternatif: helper process
  Node runtime portabel + `node-pty`, atau buka Windows Terminal satu klik (fallback jujur).
- **UI**: panel Terminal per project, **hanya dari laptop** (bukan WiFi/Tailscale read-only), dengan
  konfirmasi; perintah dipatok ke `claude attach <id>` / `opencode` (bukan shell bebas); sesi
  ditutup saat app keluar; log audit singkat.
- **Cakupan**: MCP elicitation, `claude attach`, `/ultrareview`, `/teleport`/`/remote-control`,
  `/batch`, command TUI-only (`/theme`, `/tui`, `/focus`, `/keybindings`).
- **Keamanan**: security review wajib sebelum rilis; tidak ada input perintah bebas; allowlist
  argumen; timeout; kill switch.

### Fase 5 — Audit ulang & matriks

- Jalankan ulang inventaris terhadap docs 2.1.332/2.4.2 (dan rilis berikutnya), ubah
  `docs/adopsi-mesin.md` menjadi ✅/🧪/🚫 dengan alasan tepat.
- Regression UI penuh area yang tersentuh; perbarui `CHANGELOG.md`/`FITUR`.

## Definisi selesai tiap fase

Checklist AGENTS.md: test gagal-dulu, `npm run check`, `test:related`, `test:smoke` bila server,
area UI, dokumentasi, probe upstream dicatat di `docs/design-opencode.md → Catatan upstream` untuk
perilaku OpenCode yang baru, dan `test-support/fake-acp.mjs` hanya meniru frame nyata.

## Risiko & keputusan

- **node-pty di SEA** adalah risiko teknis terbesar; karena itu Fase 4 dimulai dengan spike dan
  boleh gagal (fallback Windows Terminal). Tidak ada fase lain yang bergantung padanya.
- **Cloud/berbayar** (ultrareview, teleport, cloud routines) tetap bergantung akun & biaya; terminal
  hanya menyediakan jalurnya, bukan menggratiskan.
- **Keamanan terminal**: laptop-only, perintah dipatok, audit, kill switch.
- **Tanpa `/system-prompt` pengganti** (keputusan lama: menghapus pengaman bawaan) dan tanpa
  sandbox Windows (tidak didukung).

## Yang diserahkan ke builder

- Bentuk UI tiap butir (dialog/panel/tombol), nama route, dan test — diputuskan di plan per fase.
- Urutan dalam fase boleh digeser bila saling bergantung; setiap fase tetap satu siklus rilis.
- Fase 4 hanya dikerjakan setelah spike hijau; jika merah, tulis hasilnya dan pilih fallback.
