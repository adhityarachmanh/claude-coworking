# Desain: Tab Chat di HP yang ringkas (≤ 760 px)

Status: **diimplementasi** (fase 1 Chat: commit 9082578; fase 2 view lain + landscape: commit 356d023, lihat §9) · Penulis: UI/UX · 2026-11-02
Test: `test/mobile-chat.test.mjs`, `test/mobile-views.test.mjs`. Sisa: uji manual di perangkat nyata (§8.3) belum tercatat di repo.
Lingkup: tampilan Chat di HP (target 390×844 dan 360×740): header, session bar, area chat, composer, navigasi bawah, mode WiFi hanya-lihat.
Batasan: frontend vanilla, tanpa dependensi baru, **tanpa perubahan backend/API/skema data**, CSP tidak berubah, desktop (> 760 px) **tidak berubah**.

> Catatan audit: angka di §1 dihitung dari markup dan CSS (`public/index.html`, `public/css/app.css` blok `@media (max-width: 760px)`), bukan dari screenshot. Sesi audit ini tidak punya akses shell. Screenshot "sebelum" diambil frontend/QA dengan perintah di §8.1 sebelum mulai mengubah kode.

---

## 0. Ringkasan keputusan

| # | Keputusan | Alasan singkat |
|---|---|---|
| M1 | Header HP: **nama project + subjudul sesi/status + satu ⋯**. Akun, 📊, ⚙, 📱, kuota dan Spotify pindah ke sheet ⋯ | Header sekarang memuat 3 sampai 7 kontrol di 390 px |
| M2 | **Session bar disembunyikan di HP.** Judul jadi subjudul header; 🕘, ＋, ⋯ dan menu export masuk sheet ⋯ | Menghemat ±60 px tinggi dan 4 kontrol |
| M3 | Composer dua baris dalam satu kotak: **textarea di atas**, toolbar di bawah: **[＋] [chip pengaturan] … [tombol kirim/stop]** | Pola Claude/ChatGPT mobile. Textarea tidak lagi terjepit tombol |
| M4 | **＋ membuka sheet**: 📎 Lampiran, ⚡ Template, 📋 Antrian, 🎤 Suara, `!` Shell, `@` File, `/` Command | Lima tombol ikon di baris input menjadi satu |
| M5 | **Chip pengaturan** ("🛡 Tanya dulu · Opus · Tim") membuka sheet berisi Izin/Model/Effort/Mode tim/Bahasa suara. Elemen `.controls` yang **sudah ada** dipindah ke sheet (ID tetap) | Baris select yang di-scroll ke samping hilang. Logika `saveSettings` tidak berubah |
| M6 | **Satu tombol berubah fungsi**: 🎤 (kotak kosong, idle, suara tersedia) → ↑ Kirim (ada teks/lampiran) → ■ Stop (sibuk dan kotak kosong) | Satu target besar di posisi jempol |
| M7 | Status line jadi **strip tipis di atas kotak input**, hanya muncul kalau ada isi: daftar tugas, ⧗ tugas latar, 📋 antrian, konteks ≥ 70 %, ⚠ auto-izin | Mode dan model sudah tampil di chip |
| M8 | Pill Spotify dan kuota **tidak tampil di header Chat HP**. Spotify tetap di view Kantor dan sheet ⋯. Kuota warn/crit tampil sebagai **titik pada ⋯** dan baris di sheet | Informasi tetap ada, header tetap bersih |
| M9 | WiFi hanya-lihat: **satu banner** menggantikan kotak input. Kontrol aksi **disembunyikan** di composer, dan **nonaktif dengan alasan yang terlihat** di sheet | Sekarang ada 9 kontrol nonaktif tanpa penjelasan di layar sentuh (alasan hanya ada di `title`) |
| M10 | Keyboard terbuka: navigasi bawah disembunyikan, composer menempel di atas keyboard, chat tetap di posisi terbawah kalau sebelumnya di bawah | Ruang chat saat mengetik naik ±90 px |
| M11 | Semua perubahan diberi gerbang `@media (max-width: 760px)` (CSS) dan `narrow.matches` (JS). Elemen baru `hidden`/`display:none` di desktop | Desktop tidak regresi |

---

## 1. Audit "sebelum" (HP, Chat tab)

### 1.1 Jumlah kontrol per area

Kontrol = elemen interaktif yang terlihat. "Kondisi" = muncul hanya pada keadaan tertentu.

| Area | Selalu | Kondisional | Catatan |
|---|---|---|---|
| Header (`.topbar`) | 3: crumb, 👤 akun, 📊 laporan | +1 kuota, +2 Spotify (pill + ⏯), laptop: +⚙, +📱 | 🔔 dan ❓ sudah disembunyikan. #conn hanya titik status |
| Session bar | 4: judul (rename), 🕘 Riwayat sesi, ＋ Sesi baru, ⋯ | +⧗ tugas, +📋 antrian | Dua baris (judul + `#sb-meta`) |
| Chat kosong | 6: 4 starter + 2 tautan | | |
| Chat berjalan | per baris tool/approval | kartu izin: 4 tombol, ⚠ macet: 1–3 | Salin/Edit/Ulangi `opacity:0` sampai hover/focus, jadi **tidak terlihat di layar sentuh** |
| Composer: baris pengaturan | 4: Izin, Model, Effort, Mode tim | +Suara (bahasa) | `overflow-x:auto`, scrollbar disembunyikan, jadi Effort/Mode tim **terpotong tanpa tanda bisa di-scroll** |
| Composer: baris input | 5: 📎, ⚡, textarea, 📋, Kirim | +🎤, +■ Stop | |
| Composer: bawah | 0 | +⧗ "n tugas berjalan", +daftar tugas (head) | Status line + hint = 2 baris teks |
| Navigasi bawah | 5 | | |
| **Total layar idle** | **21** (+6 starter) | **sampai +10** | Di sekitar composer saat idle: **9** (10–11 dengan suara) |

### 1.2 Tabel kontrol dan keputusan

| Kontrol | Lokasi sekarang | Frekuensi | Keputusan HP |
|---|---|---|---|
| Crumb (ganti project) | header | sering | **Tetap**, plus subjudul sesi/status |
| 👤 Akun | header | jarang | Pindah ke sheet ⋯ |
| 📊 Laporan | header | jarang | Pindah ke sheet ⋯ |
| ⚙ Pengaturan, 📱 Buka di HP | header (laptop) | jarang | Pindah ke sheet ⋯ |
| Pill kuota | header | situasional | Sembunyikan. Titik warna pada ⋯ dan baris di sheet |
| Pill Spotify + ⏯ | header | sedang | Sembunyikan di view Chat. Tetap di Kantor. Baris "♪ Musik" di sheet ⋯ |
| #conn | header | status | **Tetap** (titik) |
| Judul sesi (rename) | session bar | jarang | Subjudul header. Rename lewat sheet ⋯ |
| 🕘 Riwayat sesi | session bar | sedang | Sheet ⋯ (item pertama) |
| ＋ Sesi baru | session bar | sedang | Sheet ⋯ |
| ⋯ menu (export ×2, izin, tim, terminal, VS Code, folder) | session bar | jarang | Digabung ke sheet ⋯ header |
| ⧗ tugas latar (chip) | session bar + status line (duplikat) | situasional | Satu chip di strip status |
| 📋 antrian (chip) | session bar | situasional | Chip di strip status |
| Select Izin | baris pengaturan | sedang | Sheet pengaturan, ringkasan di chip |
| Select Model | baris pengaturan | jarang | Sheet pengaturan |
| Select Effort | baris pengaturan | jarang | Sheet pengaturan |
| Switch Mode tim | baris pengaturan | jarang | Sheet pengaturan |
| Select bahasa suara | baris pengaturan | sangat jarang | Sheet pengaturan (bagian "Suara") |
| 📎 Lampiran | baris input | sedang | Sheet ＋ |
| ⚡ Template | baris input | sedang | Sheet ＋ |
| 📋 Tambah ke antrian | baris input | jarang | Sheet ＋ ("Tambah ke antrian" / "Buka antrian") |
| 🎤 Suara | baris input | sedang | Tombol berubah fungsi saat kotak kosong + item di sheet ＋ |
| ■ Stop | baris input | situasional | Tombol berubah fungsi. Saat ada teks: tombol Stop kecil di baris "Tim sedang bekerja…" |
| Kirim | baris input | sangat sering | **Tetap**, ikon ↑ 44×44 |
| Textarea | baris input | sangat sering | **Tetap**, lebar penuh |
| Status line (mode, model, konteks) | bawah input | pasif | Mode+model ada di chip. Konteks hanya ≥ 70 % di strip |
| Hint (`#composer-hint`) | bawah input | pasif | Disembunyikan. Pesan sibuk masuk baris typing, read-only jadi banner, ⚠ auto-izin masuk strip |
| Daftar tugas (todos) | atas composer | situasional | Strip, **default terlipat** di HP (1 baris "◼ 2/5 Menulis test ▸") |
| Starter (4) + tautan (2) | chat kosong | sekali | **Tetap** (layar sambutan, tidak mengganggu) |
| Salin/Edit/Ulangi pesan | chat | sedang | Tetap. Di `(hover:none)` dibuat terlihat (opacity .7) |
| Navigasi bawah (5) | bawah | sering | **Tetap**. Disembunyikan saat keyboard terbuka |

### 1.3 Temuan masalah (dengan perkiraan ukuran)

1. **Textarea terjepit.** Lebar baris input di 360 px = 360 − 16 (padding composer) − 2 (border) − 10 (padding `.input`) = 332 px. Tombol: 4 ikon × 32 + Kirim ±64 + Stop ±73 + 6 gap × 8 = 313 px. **Textarea tersisa ±19 px** saat sibuk dengan suara aktif. Di 390 px ±49 px. Saat idle tanpa suara di 360 px ±130 px.
2. **Baris select terpotong diam-diam.** Empat `select` maks 132 px + label + switch kira-kira 600 px di wadah 344 px. Mode tim dan Suara ada di luar layar tanpa indikasi.
3. **Tinggi chat sempit** (390×844 PWA, perkiraan): header 52+47 (safe area), session bar ±60, composer ±140 (pengaturan 40 + input 48 + status 20 + hint 18 + padding 14), navigasi 54+34. **Chat ±457 px saat idle.** Saat sibuk dengan todos (±150) dan typing (22): **±285 px**. Dengan keyboard (±336 px): chat **hampir habis**.
4. **Keyboard tidak ditangani.** Tidak ada `visualViewport`/`interactive-widget`. `body` 100dvh `overflow:hidden`: di iOS keyboard menutupi composer dan halaman digeser. Di Android Chrome ≥108 (default `resizes-visual`) hal serupa terjadi. Navigasi bawah ikut memakan tempat di atas keyboard.
5. **Read-only tidak jelas di layar sentuh.** `applyReadOnly` hanya men-disable dan mengisi `title` (tooltip tidak ada di HP). Ada 9 kontrol abu-abu di composer. Penjelasan hanya ada di placeholder dan hint kecil.
6. **Duplikasi**: ⧗ tugas ada di session bar dan status line. Mode ada di select dan status line. Model ada di select, status line dan `#sb-meta`.
7. **Landscape HP (844×390) mendapat layout desktop** karena lebarnya > 760 px: grid satu kolom dengan stage 52vw, panel 80vh, jadi tidak bisa dipakai. (Lihat §5.4, keputusan Lead.)
8. Aksi pesan (Salin/Edit/Ulangi) `opacity:0` sampai hover sehingga tidak bisa ditemukan di layar sentuh.

---

## 2. Alur pengguna (HP)

| Tugas | Sebelum | Sesudah |
|---|---|---|
| Kirim pesan | ketik → Kirim | ketik → ↑ (sama, target lebih besar) |
| Lampirkan file | 📎 → pilih file | ＋ → 📎 Lampiran → pilih file (**2 tap**) |
| Template | ⚡ → pilih | ＋ → ⚡ Template → pilih (2 tap) |
| Ganti mode izin | scroll baris → select | chip → Izin (2 tap). Ringkasan selalu terlihat di chip |
| Stop | ■ Stop | tombol ■ (kotak kosong), atau "■ Stop" di baris typing (1 tap) |
| Riwayat sesi / Sesi baru | 1 tap | ⋯ → item (2 tap) |
| Export, izin, tim, terminal | ⋯ → item (2 tap) | ⋯ → item (2 tap) |
| Akun, Laporan | 1 tap | ⋯ → item (2 tap) |
| Tugas latar / antrian | chip (1 tap) | chip di strip (1 tap) |
| Musik | pill (1 tap) | ⋯ → ♪ Musik (2 tap), atau view Kantor (1 tap + radio) |

Semua aksi tetap bisa dicapai **≤ 2 tap** dari Chat.

---

## 3. Layout baru (wireframe 390 px)

Legenda: `[ ]` tombol (≥ 44×44 hit area), `( )` chip, `▔▔` batas area.

### 3.1 Idle, chat kosong

```
┌──────────────────────────────────────┐ safe-area-top
│ toko ▾                        ●  [⋯] │  52 px. Crumb: nama project (b)
│ Percakapan baru                      │  + subjudul (small, muted)
├──────────────────────────────────────┤
│                                      │
│              ✳                       │
│     Mulai kerja di toko              │
│  Claude Code berjalan langsung…      │
│  ┌──────────────────────────────┐    │
│  │ 🧭 Jelaskan project ini      │    │  starter (1 kolom, sudah ada)
│  │ 🐞 Cari bug                  │    │
│  │ 🧪 Tambah test               │    │
│  │ 🔍 Review perubahan          │    │
│  └──────────────────────────────┘    │
│  🕘 Lanjutkan sesi · ❓ Panduan       │
│                                      │
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ Ketik pesan…                     │ │  textarea 1 baris, tumbuh ≤ 160 px
│ │ [＋] (🛡 Tanya dulu · Opus · Tim ▾)  [🎤]│ │  toolbar: 3 kontrol
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│  🏢     💬     📝      📋      🔎     │  navigasi bawah (5)
│ Kantor  Chat  Perubahan Aktivitas Cari│
└──────────────────────────────────────┘ safe-area-bottom
```
Di sekitar composer saat idle: **textarea + ＋ + chip + 🎤/↑ = 4 kontrol**.

### 3.2 Turn berjalan (tool, live output, todos)

```
│ toko ▾                        ●  [⋯] │
│ Tambah validasi login · bekerja…     │  subjudul: judul sesi · status
├──────────────────────────────────────┤
│                    ┌───────────────┐ │
│                    │ tambah validasi│ │  pesan user
│                    └───────────────┘ │
│ ✓ Dev   Read src/login.js            │  baris tool (sudah ada)
│ ◌ QA    Bash npm test                │
│   │ PASS auth.test.js                │  live-tail (sudah ada)
│   │ RUN  login.test.js…              │
│ ┌──────────────────────────────────┐ │
│ │ 🤖 Claude                  10.42 │ │
│ │ Saya menambahkan…                │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ ••• Tim sedang bekerja…              │  baris typing (+ "■ Stop" bila kotak berisi teks)
│ (◼ 2/5 Menulis test ▸) (⧗ 1) (📋 2)  │  strip status: chip, 1 baris, scroll-x bila penuh
│ ┌──────────────────────────────────┐ │
│ │ Ketik pesan…                     │ │
│ │ [＋] (🛡 Tanya dulu · Opus · Tim ▾)  [■]│ │  tombol = Stop (kotak kosong + sibuk)
│ └──────────────────────────────────┘ │
│  navigasi bawah                      │
```
- Ketuk `(◼ 2/5 …▸)` membuka daftar tugas (maks 132 px, scroll internal) **di atas** kotak input. Ketuk lagi melipat.
- Konteks ≥ 70 % menambah chip `(konteks 78 %)` berwarna `--ask`, ≥ 90 % `--err`. Chip ini hanya teks (bagian dari strip `role="status"`), bukan tombol. Saran `/compact` tetap ada di `title`.
- Saat keyboard tertutup dan `body.kb-open` tidak aktif, `.mobile-nav` tetap menanggung safe-area bawah. Composer tidak menambah padding safe-area sendiri.
- Pengguna mengetik saat sibuk: tombol berubah ke ↑ (kirim di tengah giliran, perilaku yang sudah ada), dan "■ Stop" muncul di baris typing.

### 3.3 Kartu izin menunggu

```
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │  .approval.pending (glow sudah ada)
│ │ ✋ Dev minta izin · Bash          │ │
│ │ npm install zod                  │ │
│ │ ┌─────────────┐ ┌──────────────┐ │ │
│ │ │  Izinkan    │ │    Tolak     │ │ │  baris 1: primer (≥ 44 px)
│ │ └─────────────┘ └──────────────┘ │ │
│ │ ┌─────────────┐ ┌──────────────┐ │ │
│ │ │Izinkan selalu│ │Semua (sesi) │ │ │  baris 2: ghost
│ │ └─────────────┘ └──────────────┘ │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ (✋ Menunggu izinmu ↑)                │  strip: chip, ketuk = scroll ke kartu + focus
│ ┌ composer ────────────────────────┐ │
```
- Urutan visual lewat CSS `order` (DOM tetap: allow, always, all, deny): `allow` 0, `deny` 1, `always` 2, `all` 3.
- Chip "✋ Menunggu izinmu" di strip hanya muncul bila kartu pending **di luar viewport** chat (IntersectionObserver ringan, atau cukup selalu tampil saat ada pending, lihat §6 J5).

### 3.4 Composer berisi teks + lampiran

```
│ ┌──────────────────────────────────┐ │
│ │ [🖼 screenshot.png 120 KB  ✕]    │ │  .attachments (chip 40 px, sudah ada)
│ │ tolong cek error di gambar ini,  │ │
│ │ terutama bagian header           │ │  textarea tumbuh
│ │ [＋] (🛡 Tanya dulu · Opus · Tim ▾)  [↑]│ │  ↑ = Kirim (accent)
│ └──────────────────────────────────┘ │
```
`!` di awal: border kotak `--shell` (sudah ada, `.bash-mode`).

### 3.5 Sheet ＋ (bottom sheet, `.modal`)

```
├──────────────────────────────────────┤
│              ───                     │  grabber (dekoratif)
│ Tambahkan                        [✕] │  .modal-head
│ ┌────────┐ ┌────────┐ ┌────────┐     │
│ │   📎   │ │   ⚡   │ │   🎤   │     │  ubin 3 kolom, tinggi ≥ 72 px
│ │Lampiran│ │Template│ │ Suara  │     │  (🎤 hanya bila voiceAvailable())
│ └────────┘ └────────┘ └────────┘     │
│ ┌────────┐ ┌────────┐ ┌────────┐     │
│ │   📋   │ │   !    │ │   @    │     │
│ │Antrian │ │ Shell  │ │  File  │     │
│ └────────┘ └────────┘ └────────┘     │
│ ┌────────┐                           │
│ │   /    │                           │
│ │Command │                           │
│ └────────┘                           │
│ Gambar, PDF, log/teks/kode · ! menjalankan
│ perintah di folder project           │  bantuan kecil (muted)
└──────────────────────────────────────┘
```
Perilaku tiap ubin:

| Ubin | Aksi | Fokus setelahnya |
|---|---|---|
| 📎 Lampiran | tutup sheet, **di handler klik yang sama** panggil `$('#file-input').click()` (iOS butuh gesture) | dialog file OS |
| ⚡ Template | tutup sheet, `$('#btn-template').click()` | dialog template (sudah ada) |
| 🎤 Suara | tutup sheet, `$('#btn-voice').click()` | tetap |
| 📋 Antrian | teks di kotak: `$('#btn-queue-add').click()` (tambah). Kotak kosong: buka antrian (perilaku yang sudah ada di tombol yang sama). Label ubin berganti: "Tambah ke antrian" / "Buka antrian" | dialog/toast |
| `!` Shell | sisipkan `!` di awal kotak bila belum ada | `#prompt` (keyboard muncul, memang diinginkan) |
| `@` File | sisipkan `@` di posisi kursor, picu event `input` (suggest jalan) | `#prompt` |
| `/` Command | kotak kosong: isi `/` dan picu `input` | `#prompt` |

### 3.6 Sheet pengaturan (dari chip)

```
│ Pengaturan giliran               [✕] │
│ Izin                                 │
│ [ 🛡️ Tanya dulu                   ▾] │  select asli lebar penuh, 44 px, 16 px font
│ Kapan Claude minta izin sebelum…     │  deskripsi (muted, dari title yang ada)
│ Model                                │
│ [ Opus                           ▾]  │
│ Effort                               │
│ [ Default                        ▾]  │  disabled + teks "Model ini tidak mendukung effort"
│ ┌──────────────────────────────────┐ │
│ │ Mode tim                    [●━] │ │  switch, baris 44 px
│ │ Didelegasikan ke PM, BA, Dev…    │ │
│ └──────────────────────────────────┘ │
│ Bahasa input suara (bila 🎤 ada)      │
│ [ Indonesia                      ▾]  │
│ Berlaku untuk project ini. Tersimpan otomatis.
```
Isinya adalah **node `.controls` yang sudah ada**, dipindah ke sheet saat `narrow.matches` (dan dikembalikan ke `#composer` saat lebar > 760 px). Semua listener `change → saveSettings` tetap.

Chip ringkasan: `MODE_SHORT[mode] · modelLabel · (effort bila ≠ default) · (Tim bila aktif)`, contoh `🛡 Tanya dulu · Opus · High · Tim`. Dipotong elipsis, maks 1 baris. Saat mode "🚫 Jangan tanya" atau `autoApprove`, chip memakai warna `--warn-*`.

### 3.7 Sheet ⋯ (header)

```
│ toko                             [✕] │
│ Tambah validasi login                │  judul sesi + #sb-meta (muted)
│ sesi web · 3f9a1c2b · opus           │
│ ── Sesi ──────────────────────────── │
│ 🕘 Riwayat sesi                      │  baris 48 px
│ ＋ Sesi baru                          │
│ ✎ Ganti nama sesi                    │  (hanya bila ada sessionId)
│ ⏪ Rewind                             │
│ ── Percakapan ────────────────────── │
│ ⬇ Export percakapan (.md)            │
│ ⬇ Export sesi lengkap (.md)          │
│ ⌨ Salin perintah lanjut di terminal  │
│ 🛡️ Aturan izin   ·  👥 Kelola tim     │
│ ── Lainnya ───────────────────────── │
│ 👤 Akun · kuota 82 % (sesi 5 jam) ●   │  titik warn/crit dari #quota-pill
│ ♪ Musik · Judul – Artis              │  (bila #spotify-box tidak hidden)
│ 📊 Laporan token                     │
│ 🔔 Notifikasi   ❓ Panduan            │
│ ⚙ Pengaturan   📱 Buka di HP          │  (laptop sempit saja; .local-only)
```
Setiap baris adalah **proxy** ke kontrol yang sudah ada (`data-proxy="#btn-sessions"`, `data-proxy="[data-more=export]"`, dll.). Tidak ada logika baru selain meneruskan klik.

### 3.8 WiFi hanya-lihat

```
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ 👁 Hanya lihat lewat WiFi.        │ │  #ro-banner, role="status", --ask
│ │ Kirim perintah dari laptop atau  │ │
│ │ lewat Tailscale.                 │ │
│ └──────────────────────────────────┘ │
│  navigasi bawah                      │
```
- `.input`, chip, ＋, baris typing Stop: **disembunyikan** (bukan disabled). Strip status tetap (hanya baca).
- Sheet ⋯: item yang mengubah sesuatu (Sesi baru, Ganti nama, Rewind) tampil **disabled** dengan teks kecil "Hanya dari laptop/Tailscale" di baris itu (bukan hanya `title`). Item baca (Riwayat, Export, Aturan izin, Kelola tim, Laporan) tetap aktif. Dialog tujuan sudah punya `.ro-note` sendiri.
- Kartu izin: perilaku `approvals.js` yang sudah ada (tidak diubah).

### 3.9 State lain

| State | Tampilan HP |
|---|---|
| Memuat (sebelum snapshot) | header crumb "menghubungkan…" (sudah ada), chat kosong, composer tampil, ↑ disabled |
| Offline (`connection.online=false`) | ↑ disabled + strip chip "⚡ Belum tersambung" (teks `OFFLINE_HINT` singkat). `#conn-banner` tetap |
| Error kirim | toast (sudah ada), teks dan lampiran kembali ke kotak |
| Demo | composer diganti tombol "▶ Jalankan demo" (sudah ada). ＋/chip disembunyikan |
| Merekam suara | tombol berubah jadi ■ merah berdenyut (`.voice-btn[aria-pressed=true]`, sudah ada). `#voice-live` di atas kotak |
| Compacting | baris typing "✻ Memadatkan konteks…" (sudah ada) |
| Suggest `/` `@` | `#suggest` tampil di atas kotak (sudah ada), maks 40 % tinggi viewport |

---

## 4. Aksesibilitas

| Aspek | Ketentuan |
|---|---|
| Target sentuh | ＋, tombol kirim, ⋯ header: 44×44. Chip: tinggi 36 px visual, hit area 44 px (`padding-block` atau `::before` inset −4px). Baris sheet ≥ 48 px. Ubin ≥ 72 px |
| Label | `#btn-plus`: `aria-label="Tambahkan: lampiran, template, antrian, suara"` `aria-haspopup="dialog"`. Chip: `aria-label` lengkap ("Pengaturan giliran: mode Tanya dulu, model Opus, effort default, mode tim aktif"), diperbarui di `renderComposer`. Tombol kirim/stop: `aria-label` mengikuti fungsi aktif ("Kirim pesan" / "Hentikan giliran" / "Mulai input suara"). Hanya **satu** dari ketiganya yang terlihat dan bisa difokus, sisanya `display:none` |
| Urutan baca/fokus | header (crumb, ⋯) → chat → baris typing → strip status → lampiran → textarea → ＋ → chip → kirim/stop → navigasi bawah. Textarea tetap **sebelum** toolbar di DOM (sudah begitu bila hanya `order` CSS yang dipakai untuk tombol, lihat §5.2) |
| Chat | tambahkan `role="log"` `aria-label="Percakapan"` pada `#chat` (shared, aman untuk desktop) |
| Sheet | memakai `.modal` + `.modal-card[role=dialog][aria-modal=true]` sehingga fokus masuk/kembali dan Tab trap dari `ui/modals.js` otomatis berlaku. **Elemen sheet harus ada di HTML statis** karena `initModals()` mendaftarkan `.modal` saat start |
| Kembali fokus | menutup sheet ＋/⋯ mengembalikan fokus ke pemicu (perilaku modals.js). Ubin yang menyisipkan teks memanggil `#prompt.focus()` secara eksplisit |
| Kontras | hanya token yang ada: chip `--text-2` di `--surface-2`, warn `--warn-text-strong` di `--warn-soft`, banner `--ask` di `--surface-2`. QA cek ≥ 4.5:1 (teks) dan ≥ 3:1 (ikon/border fokus) |
| Gerak | animasi sheet (slide-up 180 ms) dan denyut suara mengikuti blok `prefers-reduced-motion` global yang sudah ada |
| Read-only | alasan ditulis sebagai teks yang terlihat, bukan hanya `title` |
| Zoom iOS | semua input/select di sheet `font-size: var(--fs-input-touch)` (16 px) |

Tema: UI saat ini hanya punya satu skema gelap (tema kantor hanya mengubah pixel art). Spec ini **hanya memakai token** (`--surface-*`, `--accent*`, `--border`, `--chrome`, `--warn-*`, `--err-*`) sehingga tema terang nanti cukup mengganti token.

---

## 5. Perubahan untuk frontend dev

### 5.1 `public/index.html`

| # | Perubahan | Shared/HP |
|---|---|---|
| H1 | Viewport meta: tambah `interactive-widget=resizes-content` → `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content` | shared (desktop mengabaikannya) |
| H2 | Topbar: tambah `<button id="btn-head-more" class="icon-btn phone-only" aria-haspopup="dialog" aria-label="Menu: sesi, export, akun, lainnya">⋯</button>` sebelum `#conn` | HP |
| H3 | Topbar: di dalam/sesudah crumb, `<small id="head-sub" class="phone-only head-sub"></small>` (subjudul sesi · status). Alternatif: render di `picker.js` sebagai bagian crumb. Pilih salah satu, jangan dua | HP |
| H4 | `.input`: tambah `<button id="btn-plus" class="ghost icon phone-only" type="button" aria-haspopup="dialog" aria-label="Tambahkan: lampiran, template, antrian, suara">＋</button>` dan `<button id="settings-chip" class="settings-chip phone-only" type="button" aria-haspopup="dialog"></button>` **sesudah** textarea | HP |
| H5 | `#btn-send`: tambah `aria-label="Kirim pesan"`. `#btn-stop`: `aria-label="Hentikan giliran"` (teks tetap untuk desktop) | shared, aman |
| H6 | `#typing`: tambah `<button id="typing-stop" class="ghost phone-only" type="button">■ Stop</button>` | HP |
| H7 | Di composer sebelum `.input`: `<div id="ro-banner" class="ro-banner phone-only" role="status" hidden>👁 Hanya lihat lewat WiFi. Kirim perintah dari laptop atau lewat Tailscale.</div>` | HP |
| H8 | `#chat`: `role="log" aria-label="Percakapan"` | shared |
| H9 | Tiga modal baru (statis, `hidden`): `#plus-modal` (ubin), `#turn-settings-modal` (wadah kosong `.sheet-body` untuk `.controls`), `#head-more-modal` (daftar proxy). Semua `.modal > .modal-card[role=dialog][aria-modal=true][aria-labelledby]` dengan `.modal-head` + `[data-close]` | HP (tidak pernah dibuka di desktop) |

### 5.2 `public/css/app.css` (semua di `@media (max-width: 760px)` kecuali disebut)

```css
/* Di luar media query: elemen khusus HP tidak pernah tampil di desktop. */
.phone-only { display: none; }

@media (max-width: 760px) {
  /* Header: crumb + ⋯ saja */
  #btn-head-more, .head-sub { display: inline-grid; }
  #btn-account, #btn-report, #btn-settings, #btn-phone, #quota-pill { display: none !important; }
  body[data-view='panel'] #spotify-box { display: none !important; } /* tetap tampil di view Kantor */
  /* Titik peringatan kuota pada ⋯ */
  body:has(#quota-pill.warn:not([hidden])) #btn-head-more,
  body:has(#quota-pill.crit:not([hidden])) #btn-head-more { position: relative; }
  body:has(#quota-pill.crit:not([hidden])) #btn-head-more::after { /* titik 8px --err, kanan atas */ }

  /* Session bar diganti header + sheet */
  .session-bar { display: none; }

  /* Composer: kolom, urutan strip → lampiran → kotak */
  .composer { display: flex; flex-direction: column; padding: 6px 8px; } /* safe-area bawah sudah di .mobile-nav */
  #todos { order: 1; } #statusline { order: 2; margin: 0 0 6px; } #suggest { order: 3; }
  #voice-live { order: 4; } #attachments { order: 5; } .input { order: 6; } #ro-banner { order: 6; }
  .composer > .controls, #composer-hint { display: none; } /* .controls dipindah JS ke sheet; ini cadangan */

  /* Kotak input dua baris: textarea penuh di atas, toolbar di bawah (DOM tetap) */
  .input { flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 6px 6px 6px 10px; }
  .input textarea { flex: 1 0 100%; order: 0; }
  #btn-attach, #btn-template, #btn-queue-add { display: none; }
  #btn-plus { display: grid; order: 1; width: 44px; height: 44px; }
  #settings-chip { display: inline-flex; order: 2; flex: 0 1 auto; min-width: 0; margin-right: auto; }
  #btn-voice, #btn-stop, #btn-send { order: 3; width: 44px; height: 44px; padding: 0; border-radius: 50%; }

  /* Tombol berubah fungsi (sama sekali tanpa JS): satu yang terlihat */
  .composer:has(#prompt:placeholder-shown):not(:has(.att-chip)) #btn-send { display: none; }    /* kosong → bukan Kirim */
  .composer:has(#prompt:not(:placeholder-shown)) #btn-voice,
  .composer:has(.att-chip) #btn-voice,
  .composer:has(#btn-stop:not([hidden])) #btn-voice:not([aria-pressed='true']) { display: none; }
  .composer:has(#prompt:not(:placeholder-shown)) #btn-stop,
  .composer:has(.att-chip) #btn-stop { display: none; }
  /* Kosong, idle, tanpa 🎤: Kirim tampil disabled supaya posisi tidak kosong */
  .composer:has(#prompt:placeholder-shown):has(#btn-voice[hidden]):has(#btn-stop[hidden]) #btn-send { display: grid; }
  /* Ikon: teks "Kirim"/"■ Stop" disembunyikan visual, aria-label dari HTML */
  #btn-send, #btn-stop { font-size: 0; }
  #btn-send::before { content: '↑' / ''; font-size: var(--fs-xl); }
  #btn-stop::before { content: '■' / ''; font-size: var(--fs-lg); }

  /* Stop tambahan di baris typing hanya saat kotak berisi teks */
  #typing-stop { display: none; margin-left: auto; min-height: 36px; }
  .panel:has(#prompt:not(:placeholder-shown)) #typing:not([hidden]) #typing-stop { display: inline-flex; }

  /* Strip status: satu baris chip */
  .statusline { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; gap: 6px; }
  .statusline .sl-mode, .statusline .sl-model, .statusline .sep { display: none; }
  .statusline .sl-ctx:not(.mid):not(.high) { display: none; }
  .statusline > * { flex: none; /* gaya chip: pill, --surface-2, min-height 32px */ }
  .todos-pinned { padding: 4px 10px; margin-bottom: 6px; }

  /* Read-only: satu banner, input disembunyikan */
  body.read-only #ro-banner { display: block; }
  body.read-only .input, body.read-only #typing-stop, body.read-only #composer-hint { display: none !important; }

  /* Keyboard terbuka (body.kb-open diset JS) */
  body.kb-open .mobile-nav { display: none; }
  body.kb-open .composer { padding-bottom: 6px; }
  body.kb-open .input textarea { max-height: 30dvh; }

  /* Kartu izin: Izinkan + Tolak di baris pertama */
  .approval .ap-actions [data-act='deny'] { order: 1; }
  .approval .ap-actions [data-act='always'] { order: 2; }
  .approval .ap-actions [data-act='all'] { order: 3; }
  .approval .ap-actions button { min-height: 44px; }

  /* Sheet */
  .plus-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .plus-tile { min-height: 72px; flex-direction: column; /* ikon 22px + label --fs-sm */ }
  #turn-settings-modal .controls { flex-direction: column; align-items: stretch; flex-wrap: nowrap; overflow: visible; gap: 12px; }
  #turn-settings-modal .ctl { flex-direction: column; align-items: stretch; white-space: normal; }
  #turn-settings-modal select { max-width: none; min-height: 44px; font-size: var(--fs-input-touch); }
  #turn-settings-modal .switch { min-height: 44px; justify-content: space-between; }
  .sheet-row { display: flex; align-items: center; gap: 10px; min-height: 48px; width: 100%; text-align: left; }
  .sheet-row small { /* alasan disabled di read-only, --muted */ }
}

/* Aksi pesan terlihat di layar sentuh (shared, hanya pointer tanpa hover) */
@media (hover: none) { .msg-actions, .msg-copy { opacity: .7; } }
```
Catatan:
- `:has()` didukung iOS 15.4+ / Chrome 105+, sesuai target PWA. Tanpa `:has()` semua tombol tampil (degradasi aman, tidak ada yang hilang).
- `.sl-model` belum ada: `statusline.js` perlu memberi class pada span model (S3).
- Placeholder harus tidak kosong agar `:placeholder-shown` bekerja (sudah: `applyPlaceholder`).

### 5.3 JS

| # | File | Perubahan |
|---|---|---|
| J1 | `features/composer.js` | `renderComposer`: perbarui teks + `aria-label` `#settings-chip` dari `#mode/#model/#effort/#team-mode` (pakai `MODE_LABEL` dari statusline.js, ekspor versi pendek `MODE_SHORT`). Tambah `#btn-plus` dan `#settings-chip` ke `ACTION_CONTROLS`. `applyReadOnly` juga set `#ro-banner.hidden = false` |
| J2 | `features/composer.js` | `initComposerControls`: saat `narrow.matches`, pindahkan `document.querySelector('#composer .controls')` ke `#turn-settings-modal .sheet-body`; pada `narrow` `change` kembalikan ke posisi semula (`#composer` sebelum `#suggest`). Satu fungsi `placeControls()` |
| J3 | `features/composer.js` | Kirim/stop tidak butuh JS (CSS §5.2). `#typing-stop` → `click` meneruskan ke `#btn-stop` |
| J4 | **baru** `features/phone-sheets.js` (± 80 baris) | `#btn-plus` → `openModal('plus-modal')`; label ubin antrian mengikuti isi kotak; ubin 🎤 `hidden = !voiceAvailable()`; klik ubin = tutup sheet + proxy (lihat §3.5). `#settings-chip` → `openModal('turn-settings-modal')`. `#btn-head-more` → isi header sheet (judul dari `#sb-title`, meta dari `#sb-meta`, kuota dari `#quota-pill`, musik dari `#spotify-pill`) lalu `openModal('head-more-modal')`. Delegasi `[data-proxy]` → `document.querySelector(sel).click()` setelah menutup sheet. Read-only: disabled + `<small>` alasan pada baris yang mengubah sesuatu |
| J5 | `features/statusline.js` | Beri class `sl-model`. Tambah chip `📋 n` (`data-open-queue`, memanggil `openQueue`) dan chip `✋ Menunggu izinmu` (ketuk = scroll + focus kartu `.approval.pending` terakhir) hanya bila `narrow.matches`. Chip `⚠ Semua izin otomatis` saat `st.autoApprove` |
| J6 | `features/statusline.js` | `renderTodos`: di HP default `collapsed` (set sekali saat init bila `narrow.matches`, simpan pilihan user per sesi halaman) |
| J7 | `features/sessions.js` | `renderSessionBar`: juga tulis `#head-sub` = judul sesi + `· bekerja…`/`· menunggu izin`/kosong |
| J8 | **baru** di `ui/layout.js` | `initKeyboardInset()`: bila `window.visualViewport` ada dan `narrow.matches`, pada `resize`: `kbOpen = innerHeight - vv.height > 120` → `body.classList.toggle('kb-open')`; set `--vv-h: ${vv.height}px` dan CSS HP `body { height: var(--vv-h, 100dvh) }`. Sebelum resize catat apakah chat di bawah; sesudahnya `scrollChat(true)` bila ya. Listener `resize` saja (tanpa polling) |
| J9 | `app.js` | panggil `initPhoneSheets()` dan `initKeyboardInset()` |
| J10 | `features/more-menu.js` | tidak diubah. Sheet ⋯ memakai `[data-more=…]` lewat proxy |

Tidak ada perubahan pada `api.js`, `stream.js`, server, atau skema data.

### 5.4 Phone-only vs shared

| Perubahan | Cakupan | Risiko desktop |
|---|---|---|
| H1 viewport `interactive-widget` | shared | tidak ada (diabaikan desktop) |
| H5 `aria-label` Kirim/Stop | shared | nama aksesibel jadi "Kirim pesan" (test yang mencari teks "Kirim" tetap lulus karena teks tidak diubah) |
| H8 `role=log` | shared | screen reader desktop mengumumkan pesan baru, perlu dicek tidak terlalu ramai (`aria-live` bawaan log = polite) |
| `(hover:none)` aksi pesan | shared, layar sentuh saja | laptop touchscreen menampilkan aksi samar |
| Lainnya | `@media (max-width:760px)` / `narrow.matches` / `.phone-only` | tidak ada |

**Keputusan untuk Lead (landscape):** HP landscape (844×390) saat ini mendapat layout desktop. Usulan fase 2: ganti query HP menjadi `(max-width: 760px), (pointer: coarse) and (max-height: 500px)` di `core/dom.js` (`narrow`) **dan** di ke-10 blok CSS. Ini perubahan shared yang lebar, jadi **tidak** termasuk fase 1. Di fase 1, landscape diterima apa adanya.

---

## 6. Kriteria penerimaan

| # | Kriteria |
|---|---|
| A1 | Di 390×844 dan 360×740, Chat idle: **≤ 5 kontrol terlihat di sekitar composer** (textarea, ＋, chip, 1 tombol kirim/🎤, opsional chip strip). Header: **≤ 2 tombol** (crumb, ⋯) + titik #conn |
| A2 | Tidak ada overflow horizontal di 360 px (`horizontalOverflow` = null) dalam semua state: idle, sibuk + todos + live output, kartu izin, lampiran 3 file, suggest terbuka, sheet ＋/pengaturan/⋯ terbuka, read-only |
| A3 | Textarea ≥ 280 px lebar di 360 px dalam semua state (sekarang ±19 px saat sibuk) |
| A4 | Setiap aksi yang ada sebelumnya bisa dicapai **≤ 2 tap** dari Chat (tabel §2). Tidak ada ID/handler lama yang hilang |
| A5 | Tepat satu dari `#btn-send/#btn-stop/#btn-voice` terlihat di toolbar pada setiap kombinasi (kosong/teks/lampiran × idle/sibuk × suara ada/tidak × merekam) |
| A6 | Target sentuh ≥ 44×44 untuk ＋, kirim/stop, ⋯. Chip dan item strip ≥ 36 px tinggi visual |
| A7 | Tinggi area `#chat` saat idle di 390×844 ≥ 560 px (sekarang ±457). Saat keyboard terbuka (simulasi `visualViewport` 508 px) navigasi bawah hilang dan kotak input berada di atas tepi keyboard |
| A8 | Sheet: fokus masuk saat buka, Tab terkunci, Esc/✕/backdrop menutup, fokus kembali ke pemicu. Ubin `!`/`@`/`/` memfokuskan `#prompt` |
| A9 | Read-only: `#ro-banner` terlihat, `.input` tidak terlihat, tidak ada kontrol aksi disabled tanpa alasan tertulis di composer atau sheet ⋯ |
| A10 | Desktop 1440×900: snapshot DOM/visual composer, session bar dan header **identik** dengan sebelum (tidak ada `.phone-only` terlihat, `.controls` tetap di composer) |
| A11 | Lebar berubah melintasi 760 px (rotate/resize): `.controls` kembali ke composer, pengaturan tetap tersimpan, tidak ada error console |
| A12 | Tidak ada error console. Test UI yang ada tetap lulus (selector lama dipertahankan) |

---

## 7. Catatan untuk frontend/QA

- **Jangan** menduplikasi logika: sheet hanya meneruskan klik ke kontrol yang ada (`data-proxy`). Kontrol aslinya tetap di DOM (disembunyikan CSS di HP), jadi keyboard shortcut, test dan read-only tetap bekerja.
- `#btn-voice` saat merekam harus tetap terlihat walau kotak berisi teks interim (aturan `:not([aria-pressed='true'])` di §5.2 perlu diperluas ke kasus teks: tambahkan `#btn-voice[aria-pressed='true'] { display: grid !important; }` dan sembunyikan `#btn-send` saat merekam).
- Klik 📎 dari sheet: `file-input.click()` harus terjadi sinkron di handler `click` ubin, sebelum `await` apa pun.
- `modals.js` sudah melupakan origin fokus saat keyboard iOS ditutup. Jangan memaksa `#prompt.focus()` saat menutup sheet ⋯/pengaturan (keyboard akan muncul tanpa diminta).
- `setMobileView('chat')` dipanggil `fillComposer`/template/queue, jadi tidak perlu ditambah.
- Chip `✋ Menunggu izinmu` versi sederhana: tampil selama ada approval pending (tanpa IntersectionObserver). Boleh ditingkatkan nanti.

---

## 8. Rencana test

### 8.1 Screenshot sebelum/sesudah (manual, dengan batas waktu)

```powershell
# Folder output di luar repo; timeout keras 15 menit
$env:OFFICE_UI_SHOTS = "$env:TEMP\mobile-audit"; New-Item -ItemType Directory -Force $env:OFFICE_UI_SHOTS | Out-Null
node --test --test-concurrency=1 --test-timeout=900000 test/ui.test.mjs
```
Tambahkan helper `shot('chat-idle')`, `shot('chat-busy')`, `shot('chat-approval')`, `shot('chat-composer-attach')`, `shot('chat-readonly')`, `shot('sheet-plus')`, `shot('sheet-settings')`, `shot('sheet-more')` di test baru (pola yang sama dengan `shot()` di test "🛡️ Aturan izin" dan "👥 Kelola tim").

### 8.2 Test otomatis baru (`test/ui.test.mjs`, viewport 390×844 dan 360×740 mobile)

| Test | Isi |
|---|---|
| `HP chat: composer ringkas` | hitung kontrol terlihat dalam `#composer` (filter `getClientRects().length` + bukan disabled-hidden) ≤ 5. Header: tombol terlihat dalam `.topbar` ≤ 2. `horizontalOverflow` null. Lebar `#prompt` ≥ 280 |
| `HP chat: tombol kirim berubah fungsi` | matriks A5: kosong/teks/lampiran × idle/sibuk (fake Claude turn panjang) × `btn-voice` hidden/tidak. Tepat satu tombol terlihat dan `aria-label` sesuai |
| `HP chat: sheet ＋` | buka, fokus di ubin pertama, Tab terkunci, ubin `@` menyisipkan `@` dan membuka `#suggest`, Esc menutup dan fokus kembali ke `#btn-plus`. Ubin 📎 memicu klik `#file-input` (spy) |
| `HP chat: sheet pengaturan` | `.controls` ada di dalam `#turn-settings-modal`. Ganti Izin → chip berubah dan `POST …/settings` terkirim (fake server). Resize ke 1440 → `.controls` kembali di `#composer` |
| `HP chat: sheet ⋯` | setiap baris proxy membuka dialog yang sama seperti tombol aslinya (riwayat, export → `__downloads`, izin, tim, laporan, akun) |
| `HP chat: strip status` | todos terlipat 1 baris, chip ⧗/📋/konteks muncul sesuai `statuses`, tidak overflow |
| `HP chat: keyboard` | set `visualViewport` palsu tidak mungkin di CDP, jadi pakai `Emulation.setVisibleSize`/`setDeviceMetricsOverride` tinggi 500 + dispatch `resize`: `body.kb-open`, `.mobile-nav` tersembunyi, `.input` di dalam viewport |
| `UI HP lewat WiFi (hanya lihat)` (perluas yang ada) | `#ro-banner` terlihat, `.input` tidak, baris "Sesi baru" di sheet ⋯ disabled dengan `<small>` alasan |
| `desktop tidak berubah` | 1440×900: `.phone-only` semua `display:none`, `.controls` parent = `#composer`, `#btn-attach/#btn-template/#btn-queue-add` terlihat, `.session-bar` terlihat |

Semua `waitFor` memakai `timeoutMs` eksplisit (pola yang ada). Jalankan per test dengan `test-support/run-each-ui-test.mjs` bila perlu isolasi.

### 8.3 Manual (perangkat nyata)

iPhone (Safari + PWA standalone) dan Android Chrome, potret: keyboard buka/tutup saat chat panjang, rotasi, VoiceOver/TalkBack urutan baca (§4), Dynamic Type besar (teks 130 %), mode WiFi (read-only) dan Tailscale.

---

## 9. Fase 2: view lain + HP landscape (diimplementasi)

Query HP sekarang `(max-width: 760px), (pointer: coarse) and (max-height: 500px)` di `public/js/core/dom.js` (`narrow`) dan semua blok `@media` HP di `public/css/app.css`. Blok tablet (761–1100 px) dikecualikan untuk HP landscape. Laptop (> 760 px, pointer halus) tidak berubah: sidik layout 1440×900 dan 900×480 identik sebelum/sesudah.

| View | Sebelum (390 px, kontrol di luar baris daftar) | Sesudah | Aksi utama | Ke ⋯ |
|---|---|---|---|---|
| Kantor | header 2 + 🗂 1 | header 2 + 🗂 1 (sticky saat gulir), kartu tim tanpa subjudul peran | 🗂 Semua project | – |
| Perubahan | header 2 + 12 (Lihat file, VS Code, Review, ↻, ⎇, ＋ Branch, Fetch, Pull, Push, PR, pesan, Commit) | header 2 + 3 (⎇, pesan, Commit) | Commit | Lihat file, Review, ↻, VS Code, ＋ Branch, Fetch, Pull, Push, PR (nonaktif dengan alasan tertulis) |
| Aktivitas | 0 (teks panjang meluber ke samping) | 0, teks dibungkus, 13 px | – | – |
| Cari | input + ✕ | sama, sheet muat di landscape | – | – |

- Header ⋯ **sadar-view**: grup `[data-view="chat"]` (Sesi, Percakapan) hanya di Chat, `[data-view="changes"]` (Perubahan, Git) hanya di Perubahan; "Lainnya" selalu ada. Subjudul sesi hanya di Chat.
- Diff di HP: `pre-wrap` di dalam `#ch-diff` (tanpa geser samping); header ⎇ dan Commit tidak ikut tergulir.
- Landscape (`(pointer: coarse) and (max-height: 500px) and (orientation: landscape)`): navigasi jadi rail kiri 72 px (+ safe-area), header 44 px, composer satu baris `[＋][teks][chip][↑]`, Kantor = kantor kiri + 🗂/tim kanan, Perubahan = file kiri + diff kanan. Keyboard terbuka: header dan rail disembunyikan. Sheet: tengah, maks 640 px, tinggi maks layar, judul + ✕ sticky.
- Test: `test/mobile-views.test.mjs` (390×844, 360×740, 844×390, desktop 1440×900 dan 900×480).
