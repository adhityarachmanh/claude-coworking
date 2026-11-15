# Pengembangan Adhitron

Panduan kerja untuk manusia dan agen AI. Peta singkat + aturan "kapan selesai" ada di
[AGENTS.md](../AGENTS.md); dokumen ini menjelaskan **mengapa** dan **bagaimana** melakukan perubahan tanpa
merusak yang lain.

Daftar isi: [Prasyarat](#prasyarat) · [Menjalankan](#menjalankan) · [Arsitektur](#arsitektur) ·
[Alur satu permintaan](#alur-satu-permintaan) · [Menambah rute API](#menambah-rute-api) ·
[Menambah fitur UI](#menambah-fitur-ui) · [Menulis test](#menulis-test) ·
[Memilih test yang dijalankan](#memilih-test-yang-dijalankan) · [Debugging](#debugging) ·
[Migrasi/perubahan data](#migrasiperubahan-data) · [Rilis](#rilis) · [Masalah umum](#masalah-umum)

## Prasyarat

- **Node.js >= 20** (repo memakai `node:test`, `fetch`, dan ES module tanpa transpiler).
- `npm install` sekali (dependensi: paket WhatsApp; saat dev juga ESLint).
- Windows untuk fitur yang memakai PowerShell/Task Scheduler/TLS Windows. Test non-Windows otomatis di-skip.
- Tidak perlu API key: aplikasi mengoperasikan **CLI milikmu** (`claude`, opsional `opencode`) yang sudah login.
  Untuk test, CLI-nya diganti `test-support/fake-claude.mjs`, jadi tidak butuh akun.

## Menjalankan

```bash
npm start                 # server di http://localhost:4317
npm run dev               # sama, dengan --watch (jangan bersamaan dengan server background!)
node scripts/restart.mjs  # restart rapi: shutdown → tunggu port bebas → background → tunggu /health
```

Data lokal ada di `data/` (riwayat chat, settings, log `data/server.log`) kecuali `OFFICE_DATA_DIR` diubah.
File rahasia (`.keys/`) dan hasil build (`dist/`, `.build/`) tidak pernah di-commit.

## Arsitektur

```
server.js                composition root: config, listener HTTP/LAN/HTTPS, gerbang keamanan, SSE, pairing
src/routes/index.js      satu router berisi semua rute API (src/routes/router.js: method + pola path)
src/routes/<topik>.js    handler per kelompok; hanya melakukan pekerjaannya sendiri
src/session.js           proses Claude Code headless per project (izin, mode/model/effort, rewind, MCP)
src/acp-session.js       mesin OpenCode lewat ACP
src/translator.js        stream-json → event kantor + pesan chat + status
src/hub.js               state aplikasi, broadcast SSE, persistensi
src/<topik>.js           logika lain yang bisa dites tanpa server (murni bila mungkin)
public/js/app.js         bootstrap UI; features/ (fitur), core/ (aturan + util murni), css/, index.html
test-support/            runner test, fake CLI, CDP (browser tanpa dependency), helper
test/*.test.mjs          test; grupnya ditentukan otomatis oleh test-support/ci-tests.mjs
scripts/                 build, setup, update, restart, generator ikon
desktop/, installer/     shell Electron + installer (lihat docs/packaging-desktop.md)
```

Prinsip yang dipegang:

- **Tanpa framework.** Router, SSE, Web Push, ZIP, dan penanda tangan TLS ditulis sendiri; menambah dependency baru
  butuh alasan kuat (ukuran, audit keamanan, lisensi).
- **Keamanan di satu pintu.** Semua keputusan Host/Origin, token per-start, jalur khusus laptop (`LOCAL_ONLY`),
  dan allowlist baca-saja untuk HP di WiFi biasa ada di `server.js`. Handler rute tidak boleh membuat aturan
  keamanannya sendiri.
- **Logika murni dipisah.** Kalau sebuah aturan bisa diuji tanpa server/browser, taruh di `src/*.js` atau
  `public/js/core/*.js` supaya masuk `test:fast` (jalankan tiap simpan, ±30 dtk).
- **Hermetik.** Test memakai folder sementara + port acak + CLI palsu, sehingga aman dijalankan saat aplikasi
  terpasang sedang hidup.

## Alur satu permintaan

1. Browser memanggil API dengan header token per-start (`src/core/api.js`).
2. `server.js` memeriksa Host/Origin, token, apakah rute khusus laptop, dan allowlist WiFi (`wifiAllows`) →
   403/401 bila tidak berhak.
3. `src/routes/router.js` mencocokkan method + pola path, lalu memanggil handler `(ctx, req, res, params, body)`.
4. Handler memakai modul `src/*`, mengubah `hub` bila state berubah; perubahan dikirim ke semua klien lewat SSE.
5. UI (`public/js/features/*`) menerima event, memperbarui DOM.

## Menambah rute API

1. Tulis test dulu di `test/<topik>.test.mjs` (atau `test/server.test.mjs` bila butuh server sungguhan).
2. Tambahkan handler di `src/routes/<topik>.js` dengan pola yang sama seperti tetangganya; ekspor lewat fungsi
   `register(router)`.
3. Bila topiknya baru, daftarkan modulnya di `src/routes/index.js`.
4. Tentukan sifat rute secara sadar: boleh dari HP di WiFi biasa (baca-saja), hanya laptop, atau perlu token CLI.
   Kebijakannya ditulis di `server.js`, bukan di handler.
5. Panggil dari UI lewat `public/js/core/api.js` agar token dan penanganan 401 konsisten.
6. Perbarui `docs/FITUR.md` bila ini perilaku yang dilihat pengguna.

## Menambah fitur UI

- Markup di `public/index.html`, gaya di `public/css/`, perilaku di `public/js/features/<fitur>.js`,
  aturan murni di `public/js/core/`.
- Teks untuk pengguna **bahasa Indonesia**, singkat, dan jangan mengklaim sesuatu yang tidak dilakukan server
  (mis. "sudah dimatikan" padahal hasilnya belum diketahui).
- Tangani tiga keadaan: kosong, memuat, dan gagal — termasuk pesan error dari server (`err.message`), bukan pesan
  generik yang menutupi penyebabnya.
- Aksesibilitas ikut diuji: tombol harus punya nama yang terbaca screen reader (test audit UI memeriksa ini).
- Test: tambahkan blok `describeArea('UI <area> …')` di `test/ui.test.mjs`, lalu jalankan
  `npm run test:ui:area -- <area>`.

## Menulis test

- `node:test` + `node:assert/strict`; satu file per topik, nama `test/<topik>.test.mjs`.
- Grup dipilih otomatis (`test-support/ci-tests.mjs`): mengimpor `test-support/cdp.mjs` → browser; memakai
  `node:child_process` atau `src/server.js` → integrasi; sisanya → cepat. Tidak ada daftar manual yang perlu diisi.
- **Fake, jangan asli.** Untuk CLI pakai `test-support/fake-claude.mjs`; untuk proses eksternal (`gh`, Tailscale,
  Spotify) arahkan env ke skrip palsu. Test tidak boleh menyentuh akun, riwayat, atau jaringan asli.
- **Selalu isolasi.** Set `OFFICE_DATA_DIR`, `CLAUDE_PROJECTS_DIR`, `CLAUDE_CONFIG_FILE`, `CLAUDE_CONFIG_DIR`,
  `PROJECTS_ROOT` ke folder sementara; port dari `freePort()`, bukan 4317.
- **Jangan pernah membuat test bergantung pada urutan.** Setiap test harus lulus sendiri.
- Angka dan teks yang rapuh (jumlah tombol, urutan elemen) boleh diuji, tapi beri pesan assertion yang menjelaskan
  artinya supaya kegagalan di masa depan mudah dibaca.

## Memilih test yang dijalankan

| Perintah | Isi | Kapan |
|---|---|---|
| `npm run check` | ESLint + `test:fast` | setiap selesai mengubah kode |
| `npm run test:related -- <file>…` | hanya test yang terkait file yang berubah | selama bekerja, setelah tiap perubahan kecil |
| `npm run test:fast` | logika murni, tanpa browser/server | tiap simpan |
| `npm run test:smoke` | 10 file integrasi paling kritis | sebelum push/rilis |
| `npm run test:unit` | semua test tanpa browser | sebelum PR besar |
| `npm run test:ui:area -- <blok>` | blok UI tertentu | saat mengubah UI |
| `npm run test:ui` | semua blok UI | sebelum rilis (puluhan menit) |
| `npm test` | semuanya | paling lambat; hanya bila perlu |

`test:related` memetakan file yang berubah ke test yang menyebutnya (nama modul, judul blok, kata kunci topik).
Pemetaannya sengaja konservatif: kalau tidak ada test yang cocok, ia menjalankan `test:fast`; kalau yang berubah
adalah file bersama (`server.js`, `public/index.html`, `package.json`, `test-support/**`, modul `src` yang dipakai
banyak fitur), ia jatuh ke gerbang yang lebih luas. Jadi hasil "lulus" dari `test:related` tidak pernah berarti
"tidak ada test yang dijalankan".

Selalu beri batas waktu pada run panjang (`--test-timeout=900000`, atau `CI_UI_FILE_TIMEOUT_MS`). Run UI yang
menggantung sekarang gagal sendiri: `startServer()` di suite UI menyerah setelah 90 dtk
(`OFFICE_UI_START_TIMEOUT_MS`) dan mencetak stderr server.

## Debugging

- **Server dev**: `data/server.log`; status ringkas `GET /health`; event real-time `GET /stream` (SSE).
  `curl http://localhost:4317/health` setelah `node scripts/restart.mjs`.
- **Rute 401/403/409**: baca pesan dari `server.js`/handler; UI harus menampilkan alasannya. Jangan menebak —
  status 409 biasanya berarti ada keadaan di mesin (task terpasang, sandi salah, sesi WhatsApp terpakai).
- **Proses yatim** (server test atau `claude` yang tidak mati): cari lewat `Get-Process node` dan periksa command
  line-nya sebelum mematikan; jangan `Stop-Process` global.
- **Test browser**: `CHROME_PATH=…` untuk memilih browser, `OFFICE_UI_SHOTS=<folder>` menyimpan screenshot, dan
  `node test-support/run-each-ui-test.mjs --timeout 120 test/ui.test.mjs` untuk membuktikan tiap test UI bisa
  berdiri sendiri.
- **Membaca kegagalan**: pesan assertion di repo ini ditulis untuk menerangkan maksud test; kalau pesannya tidak
  cukup, perbaiki pesannya sekalian (itu bagian dari perbaikan).

## Migrasi/perubahan data

Tidak ada database: state berupa JSON/JSONL di `data/`. Saat mengubah bentuk data:

1. Tetap bisa membaca bentuk lama (tulis fungsi normalisasi, bukan skrip sekali jalan).
2. Tulis test untuk bentuk lama **dan** baru di file yang sama.
3. Jangan pernah menulis ke folder data asli dari test.
4. Sebutkan di `CHANGELOG.md` bila pengguna perlu melakukan sesuatu (mis. membuka ⚙ atau menjalankan `setup.cmd`).

## Rilis

1. Naikkan `version` di `package.json` (dan `CHANGELOG.md` bagian *Belum dirilis* → bagian versi baru).
2. `npm run check` + `npm run test:smoke` hijau; untuk perubahan UI juga `npm run test:ui`.
3. Commit dengan awalan `Rilis x.y.z:`; tag `vX.Y.Z` memicu workflow rilis (draft, baru terbit setelah semua
   installer + checksum lengkap). Rincian build: [packaging-desktop.md](packaging-desktop.md).
4. Aplikasi terpasang memeriksa `releases/latest`, jadi **draft tidak terlihat oleh updater** — publikasikan dulu.

## Masalah umum

| Gejala | Penyebab & jalan keluar |
|---|---|
| `npm start` gagal: port dipakai | server background masih hidup → `node scripts/restart.mjs`, atau pakai `OFFICE_PORT` lain |
| Test menyentuh data asli | dipanggil dengan `node --test` langsung sementara env `OFFICE_*` aktif → jalankan lewat `npm run …` |
| Test UI menggantung | server test tidak pernah siap; lihat stderr yang kini dicetak saat timeout, cari proses yatim/server nyangkut di port |
| `test:ui:area` "tanpa test" | nama blok salah eja; lihat tabel di [uji-ui.md](uji-ui.md) |
| File ikon test gagal | jalankan `node scripts/make-icons.mjs` lalu commit hasilnya |
| `gh` belum login | dialog PR menampilkan instruksi login; test memakai `gh` palsu, jadi suite tetap hijau |
