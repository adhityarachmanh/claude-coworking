# Adhit Office

Kantor pixel-art untuk **mengoperasikan Claude Code dari browser dan HP**. Pilih project, ketik prompt, jawab izin. Tim IT berisi 17 role + Lead terlihat bekerja di kantor secara real-time. Sesi yang kamu jalankan di terminal (CLI) juga ikut tampil.

```
Browser / HP ──HTTP(S) + SSE──▶ server.js ──stdin/stdout (stream-json)──▶ claude -p   (sesi web, satu proses per project)
                                   ▲
                                   └── membaca ~/.claude/projects/*.jsonl  (sesi CLI, read-only, real-time)
```

Server menjalankan Claude Code milikmu sendiri dalam mode headless, jadi login, settings, MCP, dan `CLAUDE.md` tiap project tetap terpakai. Tidak perlu API key dan tidak ada dependency npm. Cukup Node.js ≥ 20.

Panduan harian yang lebih santai: [docs/PANDUAN.md](docs/PANDUAN.md). Detail tiap fitur: [docs/FITUR.md](docs/FITUR.md). Riwayat perubahan: [CHANGELOG.md](CHANGELOG.md).

> Dulu bernama *Claude Coworking*. Nama teknis yang sudah terpasang di Windows (file `claude-coworking.vbs`, task Task Scheduler `Claude Coworking`, rule firewall `Claude Coworking (Tailscale)`) sengaja tidak diganti, supaya auto-start yang sudah jalan tidak rusak.

**Isi**

- [Mulai cepat](#mulai-cepat)
- [Dari HP](#dari-hp)
- [Fitur](docs/FITUR.md): [Chat & izin](docs/FITUR.md#chat--izin) · [Tim & kantor](docs/FITUR.md#tim--kantor) · [Project & dashboard](docs/FITUR.md#project--dashboard) · [Git](docs/FITUR.md#git) · [Lampiran](docs/FITUR.md#lampiran) · [Antrian & batas](docs/FITUR.md#antrian--batas) · [Notifikasi](docs/FITUR.md#notifikasi) · [Musik (Spotify)](docs/FITUR.md#musik-spotify) · [Akun & laporan](docs/FITUR.md#akun--laporan) · [Backup & riwayat](docs/FITUR.md#backup--riwayat) · [Retensi data](docs/FITUR.md#retensi-data)
- [Keamanan & privasi](#keamanan--privasi)
- [Saat Claude Code diperbarui](#saat-claude-code-diperbarui)
- [Test & pengembangan](#test--pengembangan)
- [Struktur](#struktur)

## Mulai cepat

1. Pasang **Node.js 20+** dan **Claude Code** (`npm install -g @anthropic-ai/claude-code`), lalu login sekali dengan menjalankan `claude` di terminal.
2. Clone repo ini ke folder mana saja.
3. Double-click **`setup.cmd`**. Setup berjalan langkah demi langkah dan **selalu bertanya (Y/n) sebelum memasang apa pun**:

   | Langkah | Yang dilakukan |
   |---|---|
   | 1. Node.js & Claude Code | Memeriksa versi, memberi tahu cara memasang kalau belum ada |
   | 2. Tailscale (opsional) | Menawarkan pasang lewat winget, lalu membuka halaman login. Dibutuhkan untuk kendali dari HP di jaringan mana saja |
   | 3. Firewall | Aturan sempit: hanya TCP 4317 (HTTP) dan 4318 (HTTPS), hanya dari alamat Tailscale, profil Private (muncul jendela izin Administrator sekali). Aturan lama yang hanya membuka 4317 diganti |
   | 4. Auto-start & server | Auto-start saat Windows login **plus penjaga Task Scheduler** yang mengecek tiap 5 menit dan menyalakan server lagi kalau mati (setelah sleep, hibernate, Fast Startup, atau crash). Lalu server langsung dinyalakan di latar belakang |

4. Buka `http://localhost:4317`. Atur **⚙ → Folder induk projects** (satu per baris; semua subfolder-nya jadi project). Tanpa pengaturan ini, dipakai folder induk dari folder app ini (atau env `PROJECTS_ROOT`).
5. Klik **🔔** untuk notifikasi, lalu **📱** untuk menghubungkan HP ([Dari HP](#dari-hp)).

Setelah itu terminal, Claude Code, dan browser di laptop boleh ditutup. Server tetap jalan dan menyala sendiri setiap Windows login.

**Cara lain menjalankan**

| Perintah | Fungsi |
|---|---|
| `start-office.cmd` | Jalankan server di jendela biasa dan buka browser |
| `npm run open` | Sama, lewat npm (`http://localhost:4317`) |
| `npm start` / `npm run dev` | Tanpa membuka browser / dengan `--watch` |
| ⚙ → *Nyalakan otomatis saat Windows login* | Pasang atau lepas auto-start dari web (file `claude-coworking.vbs` di folder Startup). Log di `data/server.log` |
| ⚙ → **⏻ Matikan server** | Hentikan server background, misalnya sebelum `git pull` |
| **`update.cmd`** | Update ke versi terbaru dari GitHub: tampilkan perubahan → tanya (Y/n) → `git pull --ff-only` → restart rapi. Menolak kalau ada perubahan lokal yang belum di-commit. `node scripts/update.mjs --check` hanya mengecek |
| Banner **⬆ Versi baru tersedia** / ⚙ → *Update Adhit Office* | Server mengecek GitHub tiap 30 menit (hanya `git fetch`). Banner menampilkan daftar perubahan dan **Update sekarang** (dari laptop) = pull + restart otomatis; halaman tersambung lagi sendiri. `OFFICE_UPDATE_CHECK=0` mematikan pengecekan |
| `node scripts/restart.mjs` | Restart yang rapi (lihat [Test & pengembangan](#test--pengembangan)) |
| `node scripts\setup.mjs --check` | Cek status semua langkah setup tanpa mengubah apa pun |
| `uninstall-autostart.cmd` | Lepas auto-start dan penjaga Task Scheduler |

> Jangan jalankan `npm run dev` bersamaan dengan server background, karena keduanya memakai port 4317.

> Kalau folder repo dipindah atau versi Node.js diganti (misalnya lewat nvm), jalankan `setup.cmd` lagi, karena lokasi keduanya tercatat di script auto-start.

> **Setelah update dari versi sebelum HTTPS:** jalankan `setup.cmd` lagi sekali (minta izin Administrator). Aturan firewall lama hanya membuka port 4317, sehingga HTTPS `:4318` dari HP terblokir.

**Troubleshooting**

| Gejala | Penyebab & solusi |
|---|---|
| `Port 4317 sudah dipakai` | Server lain (background) sudah jalan. Buka saja `http://localhost:4317`, atau matikan dulu lewat ⚙ → ⏻ |
| `Claude Code tidak ditemukan` di log | Set env `CLAUDE_BIN` ke path `claude` |
| HP tidak tersambung | Lihat [Dari HP → Kalau HP tidak tersambung](#kalau-hp-tidak-tersambung) |
| Chat terasa macet | Lihat chip ⚠ di [Chat & izin](docs/FITUR.md#chat--izin) dan [PANDUAN: Kalau terasa macet](docs/PANDUAN.md#kalau-terasa-macet) |
| Prompt masuk **📋 Antrian** karena **⚡ batas giliran bersamaan** | Batas global sedang penuh (default 3). Prompt ke project lain otomatis antri dan jalan sendiri saat ada slot; tunggu, atau ubah batas di ⚙ → Umum |
| Server mati setelah laptop sleep | Penjaga Task Scheduler menyalakannya lagi dalam ±5 menit. Jalankan `node scripts\setup.mjs --check` untuk memastikan penjaga terpasang |

## Dari HP

Akses HP **mati secara default**. Ada tiga jalur, dan masing-masing dipasangkan (pairing) terpisah:

| Jalur | Alamat | Akses | Catatan |
|---|---|---|---|
| 📶 WiFi yang sama | `http://<IP-laptop>:4317` | **Hanya lihat** | HTTP tanpa enkripsi. Kotak pesan diganti banner *"👁 Hanya lihat lewat WiFi"* |
| 🌐 Tailscale | `http://<IP-Tailscale>:4317` | **Penuh** | Terenkripsi oleh Tailscale (WireGuard), dari jaringan mana saja |
| 🔒 Tailscale (HTTPS) | `https://<nama-laptop>.<tailnet>.ts.net:4318` | **Penuh + notifikasi push** | Wajib untuk Web Push dan 🎤 input suara di HP |

Pengaturan laptop (folder projects, tambah folder project, auto-start, matikan server, akses HP, backup, Spotify Client ID/login, aturan izin, buka VS Code/folder) **hanya bisa diubah dari laptop**, apa pun jalurnya.

### Menghubungkan HP

1. Di laptop, klik **📱** di header, lalu centang **Izinkan akses dari HP**.
2. Pilih jalur: alamat WiFi, **🌐 Dari mana saja (Tailscale)**, atau **🔒 Tailscale (HTTPS)** (muncul kalau sertifikat HTTPS sudah aktif).
3. Scan QR dengan kamera HP. Atau buka alamatnya lalu masukkan **kode 6 digit** dari layar laptop.
4. Selesai. HP diingat, jadi lain kali cukup buka alamat itu lagi. HP yang tidak dipakai 30 hari dicabut otomatis.

Untuk Tailscale: pasang **Tailscale** di laptop dan HP (`tailscale.com/download`), login dengan akun yang sama, dan nyalakan VPN Tailscale di HP. Aplikasi mengenali interface Tailscale laptop secara otomatis saat akses HP aktif.

### Pasang sebagai aplikasi (PWA)

- **Android (Chrome/Edge):** menu ⋮ → *Add to Home screen* / *Install app*.
- **iPhone/iPad (Safari):** Bagikan → **Tambahkan ke Layar Utama**. Aplikasi dari layar utama punya penyimpanan terpisah dari Safari, jadi **masukkan kode pairing sekali lagi** di sana.

### Notifikasi push ke HP

Notifikasi tetap muncul walau aplikasi ditutup atau HP terkunci. Hanya lewat jalur **🔒 Tailscale (HTTPS)**.

1. **Sekali di Tailscale:** buka admin console Tailscale → **DNS**, pastikan MagicDNS aktif, lalu nyalakan **HTTPS Certificates**. Nama laptop + tailnet akan tercatat di log publik Certificate Transparency (bukan akses: alamatnya tetap hanya bisa dijangkau dari dalam tailnet).
2. **Di laptop:** 📱 → klik **Periksa lagi** sampai muncul *"🔒 HTTPS aktif: https://…:4318"*. Sertifikat diambil lewat `tailscale cert` (di Windows berjalan tanpa hak Administrator), disimpan di `data/tls/`, dan diperbarui otomatis (dicek tiap 12 jam). Kalau Tailscale belum tersambung saat aplikasi menyala, HTTPS **dicoba ulang otomatis tiap menit** sampai berhasil — tidak perlu restart.
3. **Di HP:** pairing lewat **🔒 Tailscale (HTTPS)** (lihat di atas).
4. **Di HP:** buka **🔔 Pengaturan notifikasi** (tombol **🔎 Cari** di navigasi bawah → *Pengaturan notifikasi*, atau **⋯** → 🔔) → bagian **📱 Notifikasi HP (push)** → **Aktifkan**, izinkan notifikasi, lalu **Kirim tes**.

| Platform | Push | Tombol di notifikasi |
|---|---|---|
| Android Chrome/Edge | Ya, tanpa perlu install PWA | **Tolak** selalu ada. **Izinkan** hanya untuk tool baca/edit file (Read, Edit, Write, Glob, Grep, …) dan hanya kalau *Tombol Izinkan di layar kunci* aktif. Bash/PowerShell, web, dan MCP selalu harus dibuka di aplikasi |
| iPhone/iPad (iOS/iPadOS 16.4+) | **Hanya** dari aplikasi Layar Utama | Tidak ada tombol. Ketuk notifikasi untuk membuka kartu izinnya |
| HP lewat WiFi atau Tailscale-http | Tidak (browser hanya mengizinkan push di HTTPS) | – |

- Yang dikirim: minta izin, tugas selesai, berhenti/error, antrian yang berhenti sendiri, dan (opsional, mati secara bawaan) **antrian mulai**. Pengaturan 🔔 di HP itu (per jenis, jam tenang memakai jam HP, hanya favorit) ikut berlaku.
- Selama aplikasi terbuka dan terlihat di HP itu, push ditahan supaya tidak dobel.
- Isi notifikasi hanya nama project, nama role, dan **nama tool**: tanpa perintah, path, isi chat, atau teks error.
- Izin yang dijawab dari notifikasi memunculkan toast di laptop (*"Diizinkan dari HP (…) lewat notifikasi."*).

### Supaya bisa diakses saat kamu pergi

- **Laptop harus menyala dan tidak sleep.** *Settings → System → Power*: saat dicolok, sleep = **Never**; *saat lid ditutup = Do nothing* kalau laptop sering ditutup.
- Nyalakan **auto-start** (⚙) supaya server jalan lagi setelah restart.

> Tunnel publik seperti ngrok atau Cloudflare Tunnel sengaja tidak dipakai. Aplikasi ini bisa menjalankan perintah di laptopmu, jadi lebih aman kalau tidak punya alamat publik sama sekali.

### Kalau HP tidak tersambung

| Gejala | Solusi |
|---|---|
| Halaman tidak terbuka sama sekali | Saat pertama kali, Windows bisa menanyakan izin firewall untuk Node.js: pilih **Allow** untuk jaringan *Private*. Lewat Tailscale: pastikan langkah firewall `setup.cmd` sudah dijalankan |
| HTTPS `:4318` tidak terbuka, padahal 📱 menulis "HTTPS aktif" | Aturan firewall masih versi lama (hanya 4317). Jalankan `setup.cmd` lagi: aturannya diganti dengan 4317 + 4318. Cadangan manual (PowerShell Administrator): `New-NetFirewallRule -DisplayName 'Claude Coworking (Tailscale)' -Direction Inbound -Protocol TCP -LocalPort 4317,4318 -RemoteAddress 100.64.0.0/10 -Profile Private -Action Allow` (hapus dulu aturan lama dengan nama itu) |
| 📱 meminta menyalakan *HTTPS Certificates* | Nyalakan di admin console Tailscale (DNS → HTTPS Certificates), lalu **Periksa lagi** |
| Kode ditolak | Kode berlaku 2 menit, sekali pakai, dan diganti setelah 5 kali salah. Ambil kode baru di laptop |
| "Perangkat belum dipasangkan" | HP dicabut, tidak dipakai 30 hari, atau jalurnya beda (pairing HTTPS tidak berlaku di HTTP dan sebaliknya). Pairing ulang |
| Tidak ada tombol 🎤 di HP | Input suara butuh HTTPS. Buka lewat 🔒 Tailscale (HTTPS) |

### Sesi dari CLI

Semua sesi `claude` yang kamu jalankan di terminal, di project mana pun, otomatis tampil di kantor dengan tanda **CLI**: prompt, balasan, tool, delegasi subagent, dan tanda selesai. Server hanya **membaca** transcript yang ditulis Claude Code (`~/.claude/projects`), jadi tidak ada hook dan CLI tidak terpengaruh.

Batasan: izin untuk sesi CLI tetap dijawab di terminal, dan prompt dari web membuat sesi web terpisah (tidak menyuntikkan pesan ke sesi CLI yang sedang terbuka). Rencana opt-in untuk menjawab izin CLI dari kantor/HP sudah melalui spike dan didokumentasikan di [docs/design-cli-bridge.md](docs/design-cli-bridge.md)—belum diimplementasikan.

## Fitur

Detail tiap fitur—termasuk batasan dan perilakunya—ada di **[docs/FITUR.md](docs/FITUR.md)**. README ini fokus pada cara menjalankan, akses HP, keamanan, pengembangan, dan struktur.

- **⚡ Batas giliran bersamaan** (⚙ → Umum, default 3, 0 = tanpa batas, diubah dari laptop): batasi berapa project yang boleh bekerja serentak dari aplikasi. Prompt ke project lain otomatis masuk 📋 Antrian saat penuh, tampil sebagai bubble **antre #N** dengan tombol **✕ Batal**, dan dijalankan FIFO lintas project. Badge `⚡ 2/3` tampil di 🗂 Semua project dan di bar HP. Detail: [Antrian & batas](docs/FITUR.md#antrian--batas).
- **🌐 Semua antrian + ETA + jeda semua + pin**: dialog 📋 Antrian punya tombol **🌐 Semua** (juga `Ctrl+P` → *Semua antrian*) untuk melihat antrian semua project dalam urutan giliran yang adil—**berjalan** dulu, lalu menunggu `#N`, lalu yang **dijeda** ⏸—dengan **Buka** dan **Batal**. **📌 Pin** pada item menunggu menjalankannya sebelum item lain lintas project (📍 melepas pin); hanya item yang masih menunggu yang bisa dipin. ETA `±X mnt · ≈HH.MM` disegarkan tiap menit selama dialog terbuka, dan tombol **⏸ Jeda semua / ▶ Lanjutkan semua** menghentikan atau melanjutkan antrian yang kamu jeda (antrian gagal/budget tetap dijeda; giliran berjalan tidak dipotong). Bubble **antre #N** juga menampilkan perkiraan `±X mnt` / `sebentar` (tanpa data: tanpa ETA), dan **Edit** pada bubble yang masih antre mengubah item itu langsung. Ini perkiraan, bukan janji. Detail: [Antrian & batas](docs/FITUR.md#antrian--batas).
- **⏳ Retensi otomatis** (⚙ → Cadangkan riwayat → 🕵️ Data saya, default simpan selamanya): hapus pesan panel chat dan baris laporan pemakaian yang lebih lama dari batas. Transkrip sesi, riwayat sesi, dan backup tidak disentuh. **🕵️ Data saya** juga menampilkan pemakaian disk per kategori—chat, ledger dan arsipnya, lampiran antrian, bundel redo, backup config OpenCode, riwayat kesehatan, log server, audit aksi/login, salinan state lama, cache harga model, trash, dan backup otomatis—dengan pembersihan aman untuk redo, backup config OpenCode, riwayat kesehatan, log server, dan salinan state lama. **Hapus data project** ikut menghapus redo dan lampiran antrian project itu; backup otomatis (ZIP seluruh kantor) tetap utuh dan tidak bisa dihapus per project. Detail: [Retensi data](docs/FITUR.md#retensi-data).
- **🧩 Laporan per role (perkiraan)** (📊 Laporan): tabel token, persentase, biaya, dan delegasi per role—Lead serta subagent. Claude memakai transcript subagent; OpenCode memakai `agent` yang disimpan di ledger (fallback ke session list untuk baris lama). Totalnya membagi total laporan; baris **OpenCode (tanpa rincian role)** dan **Tanpa rincian role** menunjukkan token dari sesi yang sudah tidak ditemukan, plus cakupan persentase. Tersedia di pratinjau, PDF, dan CSV. Detail: [Akun & laporan](docs/FITUR.md#akun--laporan).
- **🔊 Bacakan balasan (TTS)** (🔔 → *Pengaturan notifikasi* → **Bacakan balasan**, per perangkat): jawaban asisten yang selesai dibacakan dengan suara browser. Markdown dibersihkan, blok kode dilewati, jawaban sangat panjang dipotong di batas kata; **Stop/Esc** menghentikan suara. Tidak ada teks yang dikirim ke server aplikasi.
- **📊 Kuota OpenCode Go resmi + laporan provider**: 👤 Akun membaca OpenCode Console untuk paket, masa aktif, tiga meter resmi **5 jam / 7 hari / 30 hari**, dan kartu **Pemakaian OpenCode** Hari ini/7 hari (biaya, request, token) dari endpoint usage, plus rincian per model (request, input, cache, output, biaya) dan **📡 Request terbaru** per request—bukan estimasi. 📊 Laporan menambahkan bagian **OpenCode Go — data provider** (aktivitas harian dan model) yang terpisah dari tabel ledger. Token console tidak pernah dikirim ke browser/log/backup; jika console tidak tersedia, panel kembali ke estimasi. Detail: [Akun & laporan](docs/FITUR.md#akun--laporan).
- **📈 Riwayat kesehatan 7 hari + alarm backup**: 🩺 Kesehatan sistem menampilkan ringkasan **Hari ini** dan tabel **Aktivitas 7 hari** — giliran selesai/gagal, antrian yang mulai, waktu tunggu p95, berapa kali kena ⚡ batas giliran, dan restart server — dari agregat angka di `data/metrics.json` (tanpa isi percakapan atau nama project, rolling 7 hari lokal, bukan bagian backup). Cek **Backup otomatis** kini memastikan file `adhit-office-backup-auto-*.zip` terbaru benar-benar ada dan tidak basi (>36 jam untuk harian, >8 hari untuk mingguan). Detail: [Kesehatan & diagnostik](docs/FITUR.md#kesehatan--diagnostik).

## Keamanan & privasi

**Jaringan dan akses**

- Server hanya listen di `127.0.0.1`. Saat akses HP aktif, juga di alamat LAN dan Tailscale laptop (bukan `0.0.0.0`), plus listener HTTPS `:4318` **hanya** di interface Tailscale.
- Setiap request diperiksa header `Host`/`Origin` (per skema: halaman http tidak bisa memanggil origin https dan sebaliknya). Semua API butuh token acak per start yang disisipkan ke halaman.
- **WiFi = hanya lihat, Tailscale = penuh.** Satu gerbang di server (`wifiAllows`, `src/remote.js`) mengizinkan WiFi hanya untuk daftar baca; endpoint baru otomatis ditolak. Pencarian percakapan, export sesi, dan aturan izin juga tidak dibuka lewat WiFi.
- Interface Tailscale dikenali dari **nama interface**, bukan sekadar alamat `100.x` (WiFi kantor/hotspot dengan CGNAT juga memakai rentang itu).
- Koneksi dari loopback lewat TLS tidak pernah dianggap laptop.
- Tunnel publik tidak dipakai. Lihat [Dari HP](#dari-hp).

**Pairing HP**

- Kode 6 digit berlaku 2 menit, sekali pakai, diganti setelah 5 kali salah. Alamat yang 5 kali salah diblokir 60 detik; lebih dari 20 tebakan salah dalam 10 menit menjeda pairing untuk semua selama 10 menit.
- HP menyimpan token acak di cookie `HttpOnly; SameSite=Strict` (HTTPS: `__Host-office_device; Secure`). Server hanya menyimpan hash-nya. Token **terikat jalur**: pairing HTTPS tidak berlaku di HTTP, dan sebaliknya.
- Cabut kapan saja di 📱 (koneksi live HP itu langsung diputus). HP yang tidak dipakai 30 hari dicabut otomatis, langganan push-nya ikut terhapus.

**Privasi lewat WiFi** (HTTP biasa bisa disadap di jaringan yang sama). Penonton WiFi **tidak menerima**:

| Data | Yang dikirim ke WiFi |
|---|---|
| Akun Claude | Hanya paket dan kuota. Tanpa email, nama, organisasi, atau ID asli |
| Laporan token | Tanpa email/organisasi; ID akun diganti ID buram |
| Daftar HP yang dipasangkan | Kosong |
| Spotify | Lagu yang diputar, tanpa nama perangkat; tanpa playlist dan daftar perangkat |
| Izin dijawab dari notifikasi | Tanpa nama HP yang menjawab |
| File rahasia (`.env*`, kunci, kredensial) | Tidak pernah dikirim ke HP mana pun |

Isi chat dan kode tetap terlihat lewat WiFi, jadi **pakai hanya di WiFi yang kamu percaya**.

**Halaman web**

- Content-Security-Policy ketat (`script-src 'self'`, tanpa script inline, `object-src 'none'`, `base-uri 'none'`, `connect-src 'self'`), `frame-ancestors 'self'` + `X-Frame-Options` (anti-clickjacking tombol **Izinkan**), `Referrer-Policy: no-referrer`. COOP `same-origin` di laptop dan HTTPS. Tanpa HSTS (sengaja: berlaku per host di semua port).
- Error tak terduga hanya dikirim sebagai pesan umum; detail di log server.
- Ikon, manifest PWA, dan service worker (HTTPS saja) bisa diambil tanpa pairing karena tidak berisi data.

**Notifikasi push**

- Langganan disimpan di record HP. Kunci VAPID di `data/state.json`; izin folder `data/` dibatasi ke user ini (best effort). Keduanya tidak ikut backup.
- Server hanya mengirim ke layanan push yang dikenal (FCM, Mozilla, Apple, Windows), lewat HTTPS port 443.
- **Izinkan/Tolak dari notifikasi** memakai token sekali pakai per (izin, HP), 256-bit, disimpan hanya sebagai hash di memori, berlaku 15 menit, plus cookie HTTPS HP itu. Izinkan dari layar kunci hanya untuk tool baca/edit file; selalu bisa dimatikan per HP.

**Claude Code, file, dan perintah**

- Izin tetap mengikuti aturan Claude Code. Mode default selalu bertanya sebelum menulis file atau menjalankan perintah. Mengubah aturan izin hanya dari laptop.
- Login/logout akun hanya dari laptop atau HP lewat Tailscale, dengan peringatan ke laptop. Server tidak pernah membaca token login (`.credentials.json`).
- Folder jaringan (`\\server\share`, `\\?\`, `\\.\`) ditolak sebelum disentuh, supaya Windows tidak mengirim hash NTLM ke server lain.
- **Buka di VS Code / folder** hanya dari laptop, hanya untuk project terdaftar, dijalankan tanpa shell.
- Diff file baru berupa symlink hanya menampilkan tujuannya.
- Export/import riwayat hanya dari laptop. Isi zip diperiksa (zip-slip, symlink, nama device Windows, CRC) sebelum ada yang ditulis.

**Spotify**

- Token di `data/spotify.json` (mode 0600, tidak ikut backup, tidak pernah dikirim ke browser). Jangan arahkan `OFFICE_DATA_DIR` ke folder bersama/sinkron. Client ID, hubungkan, dan putuskan hanya dari laptop. Album art diproksikan server, jadi HP tidak menghubungi CDN Spotify.

**HTTPS lewat Tailscale:** jangan jalankan layanan HTTPS lain (`tailscale serve`/Funnel) di nama mesin yang sama, karena cookie berlaku per host, bukan per port.

## Saat Claude Code diperbarui

Adhit Office memakai protokol internal Claude Code, sedangkan Claude Code memperbarui dirinya sendiri. Karena itu server membaca versi Claude Code (`claude --version`) saat menyala dan setiap 6 jam. Kalau versinya baru, server menjalankan **cek kontrak ringan** di latar belakang:

- Menunggu sampai tidak ada giliran yang berjalan (prompt dan start server tidak pernah ditahan).
- Sebagian besar tanpa token: versi, flag peluncuran yang dipakai aplikasi, `initialize` (perintah, model, agent dari file), dan perintah kontrol (mode, model, konteks).
- Paling banyak **1 request Haiku kecil** untuk memeriksa format streaming; bisa dimatikan.

Hasilnya tampil sebagai pemberitahuan di atas kantor: "Claude Code diperbarui ke vX — semua cek kontrak lulus ✅" (hilang sendiri), atau "⚠ … cek kontrak gagal (…)" beserta nama cek yang gagal (tetap tampil sampai ditutup). HP lewat WiFi biasa hanya melihat pemberitahuan pasif.

**⚙ Pengaturan → tab Sistem → 🧩 Kompatibilitas Claude Code** (hanya dari laptop) menampilkan status cek terakhir, tombol **Cek kompatibilitas Claude Code**, serta dua pengaturan: *Cek otomatis saat Claude Code diperbarui* dan *Boleh pakai 1 request kecil (Haiku)* (keduanya aktif secara bawaan). Statusnya disimpan di `data/claude-check.json` dan tidak ikut backup.

OpenCode punya deteksi yang sama (tanpa token sama sekali): lihat [Mesin: Claude Code atau OpenCode](docs/FITUR.md#mesin-claude-code-atau-opencode) dan `npm run test:opencode`.

Untuk detail lengkap, jalankan `npm run test:claude` (23 cek terhadap Claude Code asli, beberapa request Haiku; lihat [Test & pengembangan](#test--pengembangan)).

## Test & pengembangan

```bash
npm test             # offline: unit + server sungguhan dengan Claude Code palsu + UI (Chrome/Edge headless, dilewati bila tidak ada)
npm run test:claude  # kontrak ke Claude Code asli (beberapa request Haiku, memakai akunmu)
npm run test:opencode  # kontrak ke OpenCode asli: cek tanpa token + giliran singkat dengan model gratis; `-- --light` = tanpa token saja
npm run lint         # ESLint versi terkunci lewat npx
node test-support/ci-tests.mjs unit   # seperti CI: semua test tanpa browser
node test-support/ci-tests.mjs ui     # seperti CI: test browser per file, yang gagal diulang sekali (dilaporkan FLAKY)
```

CI GitHub (`.github/workflows/test.yml`) menjalankan tiga job: **lint** (cek sintaks + ESLint), **unit** (Windows + Ubuntu) dan **ui** (Ubuntu, Chrome bawaan runner). Push baru ke branch yang sama membatalkan run lama. File UI yang baru lulus saat diulang ditulis di ringkasan job sebagai *flaky*, supaya diperbaiki, bukan disembunyikan.

| Lapis | Isi |
|---|---|
| Unit (`test/*.test.mjs`) | Role & katalog tim, translator, markdown, git, mirror CLI, riwayat & chat store, aturan notifikasi/dashboard/deteksi macet/lampiran, ledger token, laporan, Web Push (kripto RFC 8291/8292), TLS, Spotify (dengan Spotify palsu), ZIP & backup, ikon |
| Integrasi (`test/server.test.mjs`, `https`, `push`, `spotify-server`, …) | `server.js` sungguhan dengan `test-support/fake-claude.mjs`: keamanan API, gerbang WiFi, pairing, HTTPS, izin, stop, antrian, backup |
| UI (`ui`, `mobile-chat`, `mobile-views`, `multitab`, `queue-ui`, `push-ui`, `spotify-ui`, …) | Browser headless lewat CDP (`test-support/cdp.mjs`), viewport HP dan desktop. `CHROME_PATH=…` untuk memilih browser, `OFFICE_UI_SHOTS=<folder>` untuk menyimpan screenshot |
| Kontrak (`test-support/claude-contract.mjs`) | Asumsi protokol terhadap Claude Code asli: `init`, streaming, `can_use_tool`, allow/deny, interrupt, `--agents`, format transcript |
| Kontrak OpenCode (`test-support/opencode-contract.mjs`) | Asumsi ACP terhadap OpenCode asli: `initialize`, `session/new` + configOptions, command, `set_config_option`, `session/load`, `opencode models`/`session list`, lalu (model gratis `opencode-go/beam-free`, atau `OPENCODE_CONTRACT_MODEL=<provider/model>`) streaming + `usage`, bentuk `session/request_permission` + tolak, `session/cancel` |

Test offline juga jalan di GitHub Actions (Windows dan Linux) setiap push, plus lint.

**Isolasi.** Semua test memakai folder sementara dan port acak (`OFFICE_DATA_DIR`, `CLAUDE_PROJECTS_DIR`, `CLAUDE_CONFIG_FILE`, `CLAUDE_CONFIG_DIR`, `OFFICE_TAILSCALE_BIN`, `OFFICE_OPEN_DRY_RUN`), jadi tidak menyentuh riwayat, settings, Tailscale, atau Spotify aslimu, dan aman dijalankan saat server background menyala. Tips:

- Jalankan satu file: `node --test --test-concurrency=1 test/ui.test.mjs`. Satu test: tambahkan `--test-name-pattern="<nama>"`.
- Buktikan tiap test UI bisa jalan sendiri (tanpa bergantung urutan), dengan batas waktu per test:

  ```bash
  node test-support/run-each-ui-test.mjs test/ui.test.mjs test/queue-ui.test.mjs
  node test-support/run-each-ui-test.mjs --timeout 120 --jobs 2 --filter "Semua project" test/ui.test.mjs
  node test-support/run-each-ui-test.mjs --shuffle 3 test/ui.test.mjs   # plus 3 run penuh urutan acak
  ```

- Selalu beri batas waktu pada run yang lama (mis. `--test-timeout=900000`); jangan menunggu tanpa batas.

**Restart server saat mengembangkan app ini:**

```bash
node scripts/restart.mjs            # port lain: --port 4400 (atau env OFFICE_PORT)
```

Skrip meminta server berhenti dengan rapi (`POST /api/shutdown`, hanya dari laptop), menunggu port bebas, lalu menjalankan `node server.js --background` ter-detach (log di `data/server.log`) dan menunggu `/health`. Argumen lain untuk `server.js` setelah `--` (mis. `node scripts/restart.mjs -- --open`).

Pakai ini, bukan `Stop-Process -Force`, dan sebaiknya saat tidak ada giliran/subagent yang berjalan. Proses Claude Code adalah child process server, jadi **giliran yang berjalan selalu terputus saat server berhenti**:

| Cara berhenti | Giliran yang sedang berjalan |
|---|---|
| `scripts/restart.mjs`, Ctrl+C, ⚙ → ⏻ Matikan server, SIGTERM | Dicatat terputus, di-interrupt seperti Esc (maks 3 dtk) supaya Claude Code menutup giliran di transcript, baru proses dimatikan |
| `Stop-Process -Force`, crash, laptop mati | Penanda giliran ditemukan saat start berikutnya; bagian jawaban yang belum ditulis bisa hilang |

Setelah hidup lagi, chat project itu menawarkan **▶ Lanjutkan** / **Tutup** (lihat [Chat & izin](docs/FITUR.md#chat--izin)).

**Env opsional**

| Variabel | Default | Fungsi |
|---|---|---|
| `OFFICE_PORT` | `4317` | Port HTTP |
| `OFFICE_HTTPS_PORT` | `4318` | Port HTTPS Tailscale (harus beda dari `OFFICE_PORT`) |
| `OFFICE_DATA_DIR` | `data/` | Folder data (harus pribadi) |
| `PROJECTS_ROOT` | folder induk app ini | Folder induk project sebelum diatur di ⚙ |
| `CLAUDE_BIN` | terdeteksi | Path `claude` |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Lokasi transcript |
| `OFFICE_TAILSCALE_BIN` | terdeteksi | Path Tailscale CLI |
| `OFFICE_BROWSER` | Edge/Chrome | Browser untuk PDF laporan |
| `OFFICE_BACKUP_MAX_BYTES` | 4 GB | Batas upload import riwayat |
| `SPOTIFY_CLIENT_ID` | – | Client ID Spotify (kalau tidak diisi di ⚙) |

Ikon diubah lewat sprite 16×16 di `scripts/make-icons.mjs`, lalu `node scripts/make-icons.mjs`. Test gagal kalau ikon yang di-commit tidak sesuai generator.

## Struktur

```
server.js              composition root: config, listener HTTP/LAN/HTTPS, gerbang keamanan, SSE, pairing
src/routes/            handler API per kelompok (router.js: method + pola path → handler)
src/session.js         proses headless Claude Code per project (izin, mode/model/effort, rewind, MCP, tugas latar)
src/mirror.js          tail transcript sesi CLI (read-only)
src/translator.js      stream-json → event kantor + pesan chat + status
src/transcripts.js     riwayat sesi, resume, rantai prompt untuk rewind
src/conversation.js    🔎 cari percakapan + export sesi .md
src/hub.js             state, SSE broadcast (dengan versi tersaring untuk WiFi), persistensi
src/chat-store.js      riwayat chat per project (data/chats/*.jsonl)
src/role-catalog.js    katalog 17 role, rantai fallback, prompt Lead
src/roles.js           pemetaan agent/tool/file → role
src/remote.js          akses HP: pairing, perangkat, gerbang WiFi (wifiAllows), redaksi
src/tls.js             sertifikat HTTPS Tailscale (tailscale cert)
src/webpush.js         Web Push tanpa dependency (VAPID, aes128gcm)
src/push.js            kebijakan push: event, pengaturan per HP, token aksi Izinkan/Tolak
src/spotify.js         ♪ Spotify: OAuth PKCE, polling, kontrol, album art proxy
src/spotify-launcher.js  buka aplikasi Spotify di latar belakang
src/queue.js           📋 antrian + batas antrian
src/concurrency.js     ⚡ batas giliran bersamaan (global, lintas project)
src/attachments.js     📎 validasi lampiran di server
src/git.js · files.js · file-view.js · permissions.js · templates.js · task-detail.js
src/account.js · usage.js · report.js   akun, ledger token, laporan PDF
src/role-usage.js      🧩 perkiraan token/biaya per role dari transcript subagent
src/backup.js · backup-schedule.js · zip.js   export/import riwayat, backup otomatis, ZIP
src/retention.js       ⏳ retensi otomatis chat panel + ledger pemakaian
src/metrics.js         📈 agregat aktivitas 7 hari untuk 🩺 (tanpa isi percakapan)
src/open.js · autostart.js · claude-bin.js · modules.js
public/index.html      satu halaman; public/js/app.js = entry point (ES module native, tanpa build)
public/js/core/        state, api, stream (+ stream-share: satu koneksi untuk semua tab), aturan murni (*-rules.js)
public/js/features/    satu module per fitur (chat, composer, izin, dashboard, push, spotify, phone-sheets, …)
public/js/office/      renderer pixel-art (dunia 640×344, sprite, tema, radio)
public/sw.js           service worker push (hanya di HTTPS)
.claude/agents/        definisi subagent per role
scripts/               setup, restart, make-icons
test/ · test-support/  test + Claude/Spotify/Tailscale palsu, CDP, run-each-ui-test
docs/                  PANDUAN.md + catatan desain (web push, Spotify, chat HP)
```
