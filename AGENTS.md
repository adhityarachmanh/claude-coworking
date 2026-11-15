# AGENTS.md — titik masuk untuk agen AI

Baca ini dulu, lalu [docs/PENGEMBANGAN.md](docs/PENGEMBANGAN.md) kalau perlu detail. Dokumen ini menjawab tiga hal:
**di mana kode ditaruh**, **perintah mana yang dijalankan**, dan **kapan pekerjaan dianggap selesai**.

## Aplikasi ini apa

Adhitron = kantor pixel-art (web lokal) untuk mengoperasikan **Claude Code** dan **OpenCode** dari browser dan HP.

```
Browser/HP ──HTTP+SSE──▶ server.js ──stdin/stdout stream-json──▶ claude -p   (satu proses per project)
                            │
                            └── membaca ~/.claude/projects/*.jsonl (sesi CLI, read-only)
```

Tanpa framework dan tanpa bundler: Node >= 20, ES module, UI berupa file statis di `public/` yang dimuat langsung
oleh browser. Dependency npm-nya hanya paket WhatsApp + `qrcode`; ESLint dijalankan lewat `npm exec` (tidak dipasang
sebagai dependency), dan Electron/esbuild/postject hanya devDependency untuk build.

## Perintah pokok

| Kebutuhan | Perintah |
|---|---|
| Menjalankan dari source | `npm start` → http://localhost:4317 (`npm run open` membuka browser, `npm run dev` pakai `--watch`) |
| **Gerbang cepat sebelum menyatakan selesai** | `npm run check` (ESLint + `test:fast`, ±30 dtk) |
| Test yang menyentuh file yang kamu ubah | `npm run test:related -- <path>...` (mis. `npm run test:related -- src/wa-link.js public/js/features/settings.js`) |
| Semua test tanpa browser | `npm run test:unit` |
| Gerbang rilis (integrasi: server, izin, antrian, backup, CLI bridge) | `npm run test:smoke` |
| Test browser | `npm run test:ui:area -- "UI Setelan PIN"` untuk blok tertentu; `npm run test:ui` untuk semuanya (puluhan menit) |
| Restart server dev | `node scripts/restart.mjs` — **jangan** `Stop-Process -Force` dan jangan `npm run dev` bersamaan dengan server background |

Selalu beri batas waktu pada perintah panjang. Jangan menunggu tanpa batas dan jangan poll satu baris log saja.

## Alur kerja yang dipakai repo ini

1. **Test dulu (TDD).** Tulis test yang gagal untuk perilaku yang diminta, baru implementasi. Jangan menghapus atau
   melemahkan test yang ada; kalau perilaku berubah dengan sengaja, ubah test-nya di commit yang sama dan jelaskan.
2. **Ubah sekecil mungkin**, ikuti pola file di sekitarnya.
3. Jalankan `npm run test:related -- <file yang berubah>` beberapa kali selama bekerja, lalu `npm run check` di akhir.
4. Kalau menyentuh server, izin, antrian, backup, atau mesin project: tambah `npm run test:smoke`.
5. Kalau menyentuh UI: jalankan area UI yang terkait (tabel di [docs/uji-ui.md](docs/uji-ui.md)).
6. Perbarui dokumentasi yang jadi acuan perilaku: `CHANGELOG.md` (bagian *Belum dirilis*) untuk perubahan yang
   dirasakan pengguna, `docs/FITUR.md` untuk perilaku fitur, dan dokumen topik di `docs/` bila relevan.

Definisi selesai:

- [ ] ada test yang membuktikan perilaku baru/ perbaikan (gagal sebelum, lulus sesudah)
- [ ] `npm run check` hijau
- [ ] `npm run test:related -- <file>` hijau (dan `test:smoke` bila menyentuh server/antrian/backup/mesin)
- [ ] UI terkait lulus via `test:ui:area` bila menyentuh `public/`
- [ ] `CHANGELOG.md` / dokumen terkait diperbarui bila pengguna merasakan perubahannya

## Peta: mengubah X di mana

| Perubahan | File |
|---|---|
| Rute API baru | `src/routes/<topik>.js` (ekspor `register(router)`), didaftarkan di `src/routes/index.js` |
| Aturan keamanan (Host/Origin, token, izin laptop, allowlist WiFi) | `server.js` — **bukan** di handler rute |
| Logika bisnis yang bisa dites tanpa server | `src/<topik>.js` (murni, tanpa I/O global bila mungkin) |
| Proses Claude Code per project | `src/session.js`, `src/translator.js` (stream-json → event kantor) |
| Mesin OpenCode (ACP) | `src/acp-session.js`, `src/opencode-*.js` |
| Riwayat/resume sesi CLI | `src/mirror.js`, `src/transcripts.js` |
| State + SSE | `src/hub.js` |
| Fitur UI | `public/js/features/<fitur>.js`; aturan murni di `public/js/core/` |
| Halaman/markup | `public/index.html`, gaya di `public/css/` |
| Teks yang tampil ke pengguna | **Bahasa Indonesia**; komentar kode **bahasa Inggris** |
| Ikon | sprite di `scripts/make-icons.mjs`, lalu `node scripts/make-icons.mjs` (test membandingkan hasilnya) |
| Build/installer/update | `scripts/build-*.mjs`, `desktop/`, `installer/`, `docs/packaging-desktop.md` |
| Skrip setup Windows | `scripts/setup.mjs`, `src/setup/**`, `setup.cmd` |

Lapisan test: file di `test/*.test.mjs`. Yang mengimpor `test-support/cdp.mjs` adalah **test browser** (lambat);
yang memakai `node:child_process` atau `src/server.js` adalah **integrasi** (lambat); sisanya **logika murni**
(cepat). Pilihan grupnya otomatis di `test-support/ci-tests.mjs`, jadi jangan memindahkan file ke daftar manual
kecuali memang perlu.

Menambah test: `test/<topik>.test.mjs` dengan `node:test` + `node:assert/strict`. Test baru otomatis ikut grup yang
tepat, termasuk `test:related`. Untuk test browser: `import { launchBrowser } from '../test-support/cdp.mjs'` dan
sebut nama blok yang bisa dipilih lewat `describeArea` (lihat [docs/uji-ui.md](docs/uji-ui.md)).

## Jebakan yang sering memakan waktu

- **Isolasi data.** Aplikasi terpasang menyetel env `OFFICE_*` untuk anak-anaknya. Jalankan test lewat
  `npm run …` (runner menghapus env itu). Kalau memanggil `node --test` langsung, hapus dulu `OFFICE_APP_DIR`,
  `OFFICE_DATA_DIR`, `OFFICE_PORT`, `PROJECTS_ROOT`, `CLAUDE_BIN`, `CLAUDE_PROJECTS_DIR` agar test tidak menyentuh
  instalasi/riwayat asli.
- **Port 4317.** Jangan menyalakan server dev saat server background hidup. Test memakai port acak.
- **Suite UI satu file besar.** `test/ui.test.mjs` berisi ~200 test (±10.000 baris) dan butuh puluhan menit. Selama
  mengembangkan, pakai `test:ui:area`. `startServer()` di suite itu punya batas waktu 90 dtk
  (`OFFICE_UI_START_TIMEOUT_MS`) dan mencetak stderr server — kalau timeout itu muncul, biasanya ada server yatim
  atau port bentrok, bukan test yang salah. Filter area yang salah eja gagal ~5 dtk dengan pesan yang menyebutnya.
- **Satu proses per area.** `test:ui:area` menjalankan satu proses per argumen; jangan menggabungkan blok asing
  dalam satu panggilan, itu justru lebih lambat.
- **Windows vs Linux.** Beberapa test (PowerShell, Task Scheduler, TLS) hanya berjalan di Windows atau sebaliknya;
  `skip` yang ada bukan test yang rusak.
- **Jangan memakai data asli.** `.keys/`, `data/`, `dist/`, `.build/`, `.superpowers/` bukan bahan commit.
- **Commit message** bahasa Indonesia, satu topik per commit. Rilis memakai awalan `Rilis x.y.z:` dan
  `CHANGELOG.md` sebagai catatan rilis.

## Dokumen acuan

| Dokumen | Isi |
|---|---|
| [docs/PENGEMBANGAN.md](docs/PENGEMBANGAN.md) | alur pengembangan lengkap: setup, arsitektur, menambah rute/fitur/test, debugging, rilis |
| [docs/FITUR.md](docs/FITUR.md) | perilaku tiap fitur yang dianggap benar |
| [docs/uji-ui.md](docs/uji-ui.md) | blok test UI yang bisa dipilih dan kapan memakainya |
| [docs/packaging-desktop.md](docs/packaging-desktop.md) | build Windows/Linux/macOS, installer, auto-update |
| [docs/uji-manual-cli-bridge.md](docs/uji-manual-cli-bridge.md), [docs/uji-manual-hp.md](docs/uji-manual-hp.md) | checklist yang hanya bisa diuji di perangkat asli |
| [CHANGELOG.md](CHANGELOG.md) | riwayat perubahan per rilis |
