# Adhit Office

Kantor pixel-art untuk **mengoperasikan Claude Code dari browser dan HP**. Pilih project, ketik prompt, jawab izin. Tim IT berisi 17 role + Lead terlihat bekerja di kantor secara real-time. Sesi yang kamu jalankan di terminal (CLI) juga ikut tampil.

```
Browser / HP ──HTTP(S) + SSE──▶ server.js ──stdin/stdout (stream-json)──▶ claude -p   (sesi web, satu proses per project)
                                   ▲
                                   └── membaca ~/.claude/projects/*.jsonl  (sesi CLI, read-only, real-time)
```

Server menjalankan Claude Code milikmu sendiri dalam mode headless, jadi login, settings, MCP, dan `CLAUDE.md` tiap project tetap terpakai. Tidak perlu API key dan tidak ada dependency npm. Cukup Node.js ≥ 20.

Panduan harian yang lebih santai: [docs/PANDUAN.md](docs/PANDUAN.md). Riwayat perubahan: [CHANGELOG.md](CHANGELOG.md).

> Dulu bernama *Claude Coworking*. Nama teknis yang sudah terpasang di Windows (file `claude-coworking.vbs`, task Task Scheduler `Claude Coworking`, rule firewall `Claude Coworking (Tailscale)`) sengaja tidak diganti, supaya auto-start yang sudah jalan tidak rusak.

**Isi**

- [Mulai cepat](#mulai-cepat)
- [Dari HP](#dari-hp)
- [Fitur](#fitur): [Chat & izin](#chat--izin) · [Tim & kantor](#tim--kantor) · [Project & dashboard](#project--dashboard) · [Git](#git) · [Lampiran](#lampiran) · [Antrian & batas](#antrian--batas) · [Notifikasi](#notifikasi) · [Musik (Spotify)](#musik-spotify) · [Akun & laporan](#akun--laporan) · [Backup & riwayat](#backup--riwayat)
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
| Chat terasa macet | Lihat chip ⚠ di [Chat & izin](#chat--izin) dan [PANDUAN: Kalau terasa macet](docs/PANDUAN.md#kalau-terasa-macet) |
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
2. **Di laptop:** 📱 → klik **Periksa lagi** sampai muncul *"🔒 HTTPS aktif: https://…:4318"*. Sertifikat diambil lewat `tailscale cert` (di Windows berjalan tanpa hak Administrator), disimpan di `data/tls/`, dan diperbarui otomatis (dicek tiap 12 jam).
3. **Di HP:** pairing lewat **🔒 Tailscale (HTTPS)** (lihat di atas).
4. **Di HP:** buka **🔔 Pengaturan notifikasi** (tombol **🔎 Cari** di navigasi bawah → *Pengaturan notifikasi*, atau **⋯** → 🔔) → bagian **📱 Notifikasi HP (push)** → **Aktifkan**, izinkan notifikasi, lalu **Kirim tes**.

| Platform | Push | Tombol di notifikasi |
|---|---|---|
| Android Chrome/Edge | Ya, tanpa perlu install PWA | **Tolak** selalu ada. **Izinkan** hanya untuk tool baca/edit file (Read, Edit, Write, Glob, Grep, …) dan hanya kalau *Tombol Izinkan di layar kunci* aktif. Bash/PowerShell, web, dan MCP selalu harus dibuka di aplikasi |
| iPhone/iPad (iOS/iPadOS 16.4+) | **Hanya** dari aplikasi Layar Utama | Tidak ada tombol. Ketuk notifikasi untuk membuka kartu izinnya |
| HP lewat WiFi atau Tailscale-http | Tidak (browser hanya mengizinkan push di HTTPS) | – |

- Yang dikirim: minta izin, tugas selesai, berhenti/error, dan antrian yang berhenti sendiri. Pengaturan 🔔 di HP itu (per jenis, jam tenang memakai jam HP, hanya favorit) ikut berlaku.
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

Batasan: izin untuk sesi CLI tetap dijawab di terminal, dan prompt dari web membuat sesi web terpisah (tidak menyuntikkan pesan ke sesi CLI yang sedang terbuka).

## Fitur

### Chat & izin

| Bagian | Fungsi |
|---|---|
| **Chat** | Prompt ke Claude Code di folder project. Pesan yang dikirim saat tim bekerja masuk antrean Claude Code sendiri, seperti di CLI. Balasan streaming, code block di-highlight, tiap giliran ditutup dengan durasi, langkah, konteks, dan token output. Lebar panel bisa digeser (klik dua kali untuk ukuran bawaan) |
| **Kartu izin** | **Izinkan**, **Izinkan selalu** (simpan aturan), **Izinkan semua (sesi ini)**, atau **Tolak** (bisa dengan instruksi). `AskUserQuestion` dijawab dengan pilihan atau jawaban sendiri. Rencana disetujui dengan auto-edit atau tanya tiap edit |
| **Mode izin** | 🛡️ Tanya dulu (default) · ✏️ Auto-edit file · ⚡ Auto · 📋 Rencana dulu · 🚫 Jangan tanya. `Shift+Tab` berganti mode, langsung berlaku juga di tengah giliran |
| **🛡️ Aturan izin** (`/permissions`, menu ⋯) | Aturan allow/ask/deny yang tersimpan, per file settings (project lokal, project bersama, user). Mengubah hanya dari laptop |
| **Model · Effort · Mode tim** | Daftar model dari Claude Code sendiri (`/model`, termasuk alias seperti `opusplan`). Effort Default/Low/Medium/High/X-High/Max. Mode tim mendelegasikan ke subagent (lebih hidup, lebih banyak token). Semua per project, berlaku tanpa restart |
| **■ Stop** / `Esc` | Hentikan giliran dan batalkan pesan yang antre. Sesi tetap bisa dilanjutkan |
| **⏪ Rewind** (`Esc Esc`, `/rewind`) | Kembalikan kode dan/atau percakapan ke sebelum salah satu pesanmu (checkpoint Claude Code, atau revert sesi OpenCode), dengan pratinjau file. Pesan yang di-rewind tetap terlihat di chat tapi diredupkan, dan pesanmu kembali ke kotak pesan untuk diedit |
| **▶ Lanjutkan setelah restart** | Kalau server berhenti di tengah giliran, chat menampilkan *"… giliran terputus"* dengan **▶ Lanjutkan** (ke sesi yang sama) dan **Tutup**. Tidak ada yang dikirim otomatis |
| **⚠ Deteksi macet** | Tool tanpa output baru **3 mnt** atau berjalan **10+ mnt**, dan delegasi tanpa aktivitas **5 mnt**, mendapat chip *⚠ … mungkin macet* dengan **■ Hentikan giliran**, **⧗ Pindah ke latar** (perintah shell), atau **Lihat detail** (delegasi). Satu notifikasi *Berhenti / error* per kejadian. Hanya peringatan: tidak pernah menghentikan apa pun sendiri |
| **Output live** | Perintah Bash/PowerShell yang berjalan menampilkan baris terakhir; dibuka (▸) menampilkan output lengkap (8 KB terakhir) |
| **⧗ Tugas latar** (`/tasks`, `Ctrl+B`) | Perintah dan agent latar: status, output/detail live, **Hentikan**. `Ctrl+B` memindahkan yang sedang jalan ke latar |
| **🔌 Server MCP** (`/mcp`) | Status, sambungkan ulang, aktif/nonaktif, login OAuth |
| **Status line & daftar tugas** | Mode, model, konteks terpakai (seperti `/context`), tugas latar; todo list Claude menempel di atas kotak pesan |
| **`/` · `@` · `!`** | Slash command lengkap dari Claude Code · autocomplete file · perintah shell langsung di folder project (PowerShell di Windows; output ikut ke Claude bersama pesan berikutnya) |
| **⚡ Template** (`/t`) | Template bawaan dan buatan sendiri (tersimpan di server). Bagian `{…}` langsung terpilih, `Tab` ke bagian berikutnya |
| **🎤 Input suara** (`Alt+M`) | Pengenalan suara bawaan browser, Indonesia/English. Hanya di HTTPS atau localhost |
| **Sesi** | Bar sesi (judul, asal, model; klik judul untuk ganti nama), **＋ Sesi baru**, **🕘 Riwayat sesi** (web dan CLI, dikelompokkan per hari), menu ⋯: export percakapan / sesi lengkap ke `.md`, salin perintah `claude --resume`, buka di VS Code/folder (laptop) |
| **🔎 Cari percakapan** (`/search`, `Ctrl+P`) | Cari teks di semua sesi project ini atau semua project |
| **🔎 Palet perintah** (`Ctrl+P`) | Semua aksi, file (`@`), project (`#`), perintah (`>`) |
| **Riwayat prompt** | `↑`/`↓` di kotak pesan, `Ctrl+R` untuk mencari |
| **📄 Lihat file** | Klik path di chat atau tab Perubahan: isi file read-only, nomor baris, cari, salin, **Buka di VS Code** (laptop). File rahasia (`.env*`, `*.pem`, `id_*`, kredensial) butuh konfirmasi di laptop dan tidak pernah dikirim ke HP |
| **❓ Bantuan** (`?`) · **🎬 Demo** | Panduan singkat dan shortcut · simulasi kantor tanpa Claude Code |

Riwayat chat tiap project disimpan di `data/chats/<id>.jsonl` (250 pesan terakhir). Pengaturan per project ada di `data/state.json`.

**Di HP:** tampilan Chat ringkas: header = nama project + subjudul sesi + **⋯** (sesi, export, akun, laporan, musik, notifikasi, pengaturan); kotak pesan lebar penuh dengan **＋** (lampiran, template, antrian, suara, `!`, `@`, `/`) dan chip pengaturan giliran (izin, model, effort, mode tim). Satu tombol berganti fungsi: 🎤 → ↑ Kirim → ■ Stop. Tab Perubahan menyisakan ⎇, pesan commit, dan Commit; sisanya di ⋯. Mode **landscape** memakai rail navigasi kiri dan dua kolom. Saat keyboard terbuka, navigasi bawah disembunyikan.

**Banyak tab:** semua tab di satu browser berbagi **satu koneksi live** ke server (satu tab memimpin, yang lain menerima lewat BroadcastChannel), jadi membuka banyak tab tidak lagi menghabiskan batas koneksi browser.

### Tanpa terminal

- **Izin, Model, Effort, Mode tim** ada di dialog *Pengaturan giliran*: klik chip ⚙ di atas kotak chat (di HP di bawah teks).
- **■ Stop / Esc** menghentikan giliran yang sedang berjalan, termasuk giliran yang dimulai Claude sendiri setelah tugas latar selesai, dan menghentikan tugas latar itu juga.
- **🩺 Doctor** dan **⬆ Update Claude Code**: ⚙ → Kompatibilitas Claude Code (sama dengan `claude doctor` / `claude update`, dari laptop).
- Command yang hanya membuka layar terminal (`/config`, `/hooks`, `/doctor`, `/login`, …) tidak ditawarkan di autocomplete; kalau diketik, aplikasi menunjukkan tempatnya di sini.
- **🧠 /memory**: edit `CLAUDE.md` (project), `CLAUDE.local.md` (pribadi) dan `~/.claude/CLAUDE.md` langsung di aplikasi; dengan OpenCode: `AGENTS.md` (project dan global). File yang diubah di tempat lain sejak dibuka tidak ditimpa. Laptop atau Tailscale.
- **🕘 Riwayat sesi**: per sesi ⑂ *Cabangkan* (lanjutkan salinannya, aslinya utuh; Claude `--fork-session`, OpenCode `session.fork`), ⬇ export (`.md` untuk Claude, JSON OpenCode yang bisa diimpor lagi), 🗑 hapus (transcript Claude dipindah ke `data/trash`, bisa dikembalikan), ✎ ganti nama (OpenCode).
- **🔌 /mcp → ＋ Tambah server**: server lokal (perintah) atau remote (URL), untuk project ini atau semua project, lewat `claude mcp add` / `opencode mcp add` (laptop saja). Dengan OpenCode, /mcp menampilkan server dari `opencode.json` (global + project); login OAuth server OpenCode masih `opencode mcp auth <nama>`.
- **🧩 /plugin · 🤖 /agents · 🪝 /hooks** (dialog *Ekstensi Claude Code*): pasang plugin dari marketplace (perintah yang diminta marketplace selalu ditampilkan dulu untuk dikonfirmasi), aktif/nonaktif, hapus; buat/edit/hapus subagent sendiri (`.claude/agents/*.md`, project atau semua project); lihat hooks dari semua settings.json. Memasang plugin hanya dari laptop.
- **✅ CI GitHub**: setiap push (⬆ Push, pull request, atau `git push` yang dijalankan tim) diikuti dengan `gh run list` untuk commit itu. Chip di bar git tab Perubahan menunjukkan ⏳ berjalan / ✅ lulus / ❌ gagal (klik untuk membuka run-nya), dan satu baris di chat saat selesai. Butuh `gh` yang sudah login. Hanya membaca, tidak menjalankan ulang apa pun.
- **⇡ Pull request** (tab Perubahan → PR): login GitHub sekali lewat kode perangkat yang tampil di aplikasi (sama dengan `gh auth login --web`), lalu form judul/deskripsi/branch tujuan/draft → push branch → `gh pr create`. Atau *Biar Claude yang buat*.
- **OpenCode `@file`**: file project yang disebut dengan `@` dikirim juga sebagai referensi file (ACP `resource_link`), seperti di TUI OpenCode.

### Mesin: Claude Code atau OpenCode

Mesin dipilih untuk seluruh aplikasi di **👤 Akun → Mesin AI**:

- **Claude Code** (bawaan)
- **OpenCode**: banyak provider, mis. Gemini dan model gratis OpenCode Go. Pilihan ini muncul kalau `opencode` terpasang (`npm i -g @opencode/cli`, atau set env `OPENCODE_BIN`).

Tiap mesin adalah **workspace sendiri**: riwayat chat (`data/chats` untuk Claude Code, `data/chats-opencode` untuk OpenCode), percakapan yang dilanjutkan, pengaturan model/mode per project, dan giliran yang terpotong. Pindah mesin tidak menghapus apa pun: saat kembali, riwayat mesin itu muncul lagi persis seperti ditinggalkan. Yang dipakai bersama: daftar project, favorit, nama tim. Pindah mesin ditolak selama ada project yang sedang bekerja atau 📋 Antrian masih berisi item, dan semua tab/HP yang terbuka dimuat ulang otomatis.

**Login OpenCode.** OpenCode tidak punya satu akun: tiap provider login sendiri. Dengan mesin OpenCode, 👤 Akun menampilkan provider yang sudah terhubung (kredensial tersimpan atau variabel lingkungan) dengan tombol **Logout** per kredensial, dan **＋ Login provider** (cari provider → API key, atau OAuth lewat browser, termasuk form tambahan seperti GitHub Enterprise). Semuanya lewat `opencode api` (penyimpanan yang sama dengan `opencode auth login|logout|list`); API key tidak dicatat di log. Dari HP hanya lewat Tailscale, sama seperti login Claude. 🕘 Riwayat sesi menampilkan (dan melanjutkan) sesi OpenCode project itu. 📦 Import backup hanya saat Claude Code aktif; chat OpenCode di dalamnya masuk ke workspace OpenCode.

| | OpenCode |
|---|---|
| Didukung | Chat streaming, tool + animasi kantor, papan todo, **kartu izin** (Izinkan / Selalu / Izinkan semua / Tolak), ■ Stop / `Esc`, antrean, `!` shell, lanjut sesi OpenCode (`ses_…`), ▶ Lanjutkan setelah restart, token + biaya ke 📊 Laporan dan 💰 Batas antrian |
| Model | Daftar dari `opencode models` (provider yang kamu atur di OpenCode), bisa dicari; *Default* = pilihan OpenCode sendiri |
| Mode izin | **Build** (kerja normal, kartu izin tetap mengikuti aturan app) · **Plan** (agent `plan` OpenCode, read-only). Aturannya dikirim per proses lewat `OPENCODE_CONFIG_CONTENT`, jadi config OpenCode milikmu tidak pernah diubah. Aturan `permission` milikmu di `opencode.json` **digabung, bukan ditimpa**: `deny` tetap `deny`, aturan berpola (`"git *": "allow"`) tetap berlaku |
| Agent | Agent buatanmu (primary agent di `opencode.json`) untuk Build; Plan selalu memakai agent `plan` |
| Command | `/init`, `/review` dan command buatanmu muncul di autocomplete `/` dengan deskripsinya |
| Mode tim | Role kantor jadi **subagent OpenCode** (file config `OPENCODE_CONFIG` berisi `agents` + prompt Lead sebagai `instructions`). Lead mendelegasikan lewat tool `subagent`; tool milik subagent dikerjakan role itu di kantor |
| Effort | Opsi `effort` OpenCode per model (mis. low/high/max): dipilih level terdekat yang ditawarkan model |
| ❓ Pertanyaan | Tool `question` OpenCode muncul sebagai **kartu pertanyaan yang sama** dengan `AskUserQuestion` Claude (pilihan tunggal/ganda + jawaban sendiri; *Lewati* = OpenCode lanjut tanpa jawaban). Lewat *form elicitation* ACP. Notifikasi HP dan akses sama dengan Claude (WiFi hanya melihat). Pertanyaan yang menyebut kata seperti *password/token/api key* tidak dikirim OpenCode ke klien mana pun: model diminta bertanya di jawabannya |
| 📋 Kartu rencana | Agent `plan` OpenCode tidak punya tool "selesai merencanakan", jadi saat mode 📋 Rencana dulu, **setiap giliran yang selesai** memunculkan kartu rencana berisi jawaban terakhirnya: **✓ Setujui, auto-edit** / **✓ Setujui, tanya tiap edit** mengganti mode (agent `build`, sesi yang sama) lalu mengirim "Rencana disetujui. Kerjakan sekarang…"; **Minta revisi** + catatan mengirim catatan itu dan tetap di plan (tanpa catatan: kartu ditutup saja). Pesan baru sebelum menjawab menutup kartu |
| ⏪ Rewind | Lewat revert sesi OpenCode sendiri (`session.revert.stage` + `commit`). **Pesan yang dipilih dan semua sesudahnya dihapus dari sesi OpenCode** (tidak bisa di-redo dari aplikasi). *Kode & percakapan* juga mengembalikan file yang diubah OpenCode sejak pesan itu dari snapshot-nya (perubahanmu sendiri di file yang sama ikut tertimpa); *Percakapan saja* tidak menyentuh file. *Kode saja* tidak ada di OpenCode (tombolnya mati). Pratinjau = daftar file dari snapshot giliran sesudahnya (tanpa hitungan +/−). Ditolak (409) selama giliran berjalan. Akses sama dengan Rewind Claude: daftar pesan boleh dibaca dari WiFi, pratinjau dan rewind hanya laptop/Tailscale |
| ⧗ Shell yang lama | Perintah bash OpenCode dicari di shell *background service* OpenCode (`opencode api shell.list`): baris chat-nya menampilkan **output live**, deteksi macet memakai aturan **tanpa output 3 mnt**, **⧗ Pindah ke latar** memakai `session.background`, dan **■** di monitor tugas menghentikan shell itu. Kalau `opencode models` sempat kosong (service baru menyala), pemilih model memakai daftar dari sesi OpenCode yang sedang berjalan. Kalau perintahnya tidak ditemukan di service, yang berlaku hanya aturan *berjalan 10+ mnt* |
| ✕ Tolak | OpenCode menghentikan seluruh giliran saat izin ditolak. Supaya sama dengan Claude Code, aplikasi melanjutkannya dengan catatan *"Saya menolak izin untuk …"* (beserta alasanmu kalau diisi), dan model meneruskan pekerjaan tanpa langkah itu. **■ Stop** tetap menghentikan semuanya |
| 🖥 Sesi dari terminal | OpenCode yang dibuka di terminal (`opencode`, `opencode run`) memakai *background service* yang sama dengan aplikasi. Sesi yang sedang berjalan dan bukan milik aplikasi dibaca tiap 5 detik (`session.active` + `session.message.list`) lalu tampil di kantor dan chat project-nya sebagai sesi terminal, seperti sesi CLI Claude Code. Hanya membaca; riwayat lama tidak diputar ulang |
| ⏳ Batas provider | Saat provider menolak permintaan (mis. HTTP 429 rate limit) dan OpenCode mencoba lagi, chat menampilkan *⏳ Batas pemakaian provider tercapai … percobaan N* (dibaca dari `retry` pesan sesi selama giliran berjalan). OpenCode tidak memberi sisa kuota, jadi hanya kejadian penolakan yang tampil |
| 🔌 MCP | Server dari `opencode.json` (global + project) dengan **status langsung** dari *background service* OpenCode (`mcp.list`: tersambung / menyambung / gagal / perlu login / nonaktif). **↻ Sambungkan ulang**, **▶ / ⏸** (berlaku sampai OpenCode dimulai ulang; config tidak diubah) dan **🔑 Login** lewat OAuth integrasi OpenCode. Kalau provider memberi kode, tempel di kolom yang muncul |
| ⧗ Tugas latar | Shell yang berjalan dari giliran OpenCode project ini tampil di panel ⧗ Tugas latar (`/tasks`): output, ■ hentikan, dan *di latar* saat tool-nya sudah selesai atau dipindah dengan Ctrl+B. **■ Stop** ikut menghentikannya |

- Token OpenCode tercatat di laporan sebagai akun **OpenCode**, terpisah dari akun Claude.
- Setelah satu **Tolak**, OpenCode menghentikan gilirannya, sehingga kartu izin lain dari giliran itu ditutup otomatis.
- Pesan pertama yang menyalakan layanan latar OpenCode dicoba ulang sekali secara otomatis.
- 📦 Backup riwayat membawa chat kedua mesin (`office/chats/` dan `office/chats-opencode/`).
- Saat mesin OpenCode aktif, dialog khusus Claude Code (aturan izin, plugin/agent/hooks, cari percakapan, export sesi lengkap) disembunyikan dan route-nya menolak. OpenCode memakai `opencode.json` untuk aturan/agent/plugin, serta export JSON di Riwayat Sesi.
- **Saat OpenCode diperbarui**: server membaca `opencode --version` saat menyala (±45 dtk) dan setiap 6 jam. Versi baru → **cek kontrak ringan tanpa token** di latar belakang (setelah giliran yang berjalan selesai): handshake ACP (`initialize`, kemampuan `loadSession`/gambar/@file), `session/new` + opsi model/mode + daftar command, `session/set_config_option`, `session/load`, `opencode models`, `opencode session list`. Tidak pernah mengirim prompt (tidak memanggil model); sesi uji dihapus lagi. Hasilnya muncul sebagai pemberitahuan seperti untuk Claude Code ("OpenCode diperbarui ke vX — semua cek kontrak lulus ✅", atau "⚠ … cek kontrak gagal (…)" + `npm run test:opencode`). **⚙ → 🧩 Kompatibilitas OpenCode** (hanya dari laptop, hanya bila OpenCode terpasang): status, tombol cek manual, dan *Cek otomatis saat OpenCode diperbarui*. Status di `data/opencode-check.json` (tidak ikut backup). Tanpa OpenCode terpasang: tidak ada apa pun.
- Desain lengkap: [`docs/design-opencode.md`](docs/design-opencode.md).

### Tim & kantor

Siapa yang mengerjakan setiap langkah (file, perintah shell, MCP, skill, tipe subagent) mengikuti peta tetap di [docs/role-mapping.md](docs/role-mapping.md). Langkah dari subagent yang didelegasikan selalu dikerjakan role itu. Nama yang belum dikenali (MCP, skill, subagent, skrip baru) bisa dipetakan di **👥 Kelola tim → 🧭 Pemetaan peran**: untuk laptop ini, atau untuk project lewat `.office-roles.json` yang bisa di-commit bersama project. Ada juga opsi AI (default mati) yang memetakan nama baru sekali saja dengan sedikit token.

| Orang | Role | Dipakai untuk |
|---|---|---|
| Adhit - Lead | Engineering Lead (Claude) | **Atasan**: menerima prompt-mu (di Mode Otak menjadi otak di tengah) dan menutup giliran |
| Adhit - PM | Product Manager | **Juru bicara & pembagi tugas**: menerima brief dari Lead, memecah pekerjaan di papan task, mengantar tugas ke tiap role dan menerima laporannya, bertanya ke kamu bila perlu. Scope, prioritas, acceptance criteria |
| Adhit - BA | Business Analyst | Kebutuhan, aturan bisnis, analisis kode/dokumen |
| Adhit - Tech Lead | Tech Lead / Architect | Desain teknis, arsitektur, review diff |
| Adhit - UI/UX | UI/UX Designer | Alur pengguna, styling, aksesibilitas |
| Adhit - Frontend | Frontend Developer | Komponen, halaman, state di client |
| Adhit - Backend | Backend Developer | API, logika bisnis, integrasi |
| Adhit - DBA | Database Engineer | Skema, migrasi, query, perbaikan data |
| Adhit - QA | QA Engineer | Reproduksi bug, test otomatis, verifikasi |
| Adhit - Security | Security Engineer | Review keamanan, secret, audit dependensi |
| Adhit - DevOps | DevOps / SRE | Build, CI/CD, Docker, environment, deploy |
| Adhit - Writer | Technical Writer | README, dokumentasi API, changelog |
| Adhit - Freelancer | Freelancer / Generalist | Subagent non-spesialis (`general-purpose`, `fork`, tipe tak dikenal). Selalu aktif |
| Adhit - Mobile | Mobile Developer | Flutter, React Native, Android/iOS |
| Adhit - Data/AI | Data / AI Engineer | Pipeline data, analitik, fitur ML/AI |
| Adhit - Support | Tech Support / Helpdesk | Triage laporan user, reproduksi dari log |
| Adhit - Reviewer | Code Reviewer | Review kode independen sebelum dinyatakan selesai |
| Adhit - Compliance | Compliance / Privacy (DPO) | Data pribadi (UU PDP / GDPR): consent, retensi, kebijakan privasi |

**👥 Kelola tim** (⚙, menu ⋯, `Ctrl+P`, atau `/team`): pilih role dari katalog bawaan (12 inti + 5 opsional: Mobile, Data/AI, Support, Reviewer, Compliance). **Bawaan: semua 17 role aktif, termasuk Compliance.** Tim yang sudah pernah disimpan tidak diubah; aktifkan role baru di sini, atau **↺ Tim bawaan**. Lead selalu ada, Freelancer selalu aktif. Role nonaktif tidak dipakai: pekerjaannya dialihkan ke role aktif terdekat (mis. reviewer → architect, data → backend, compliance → security → ba; katalog di `src/role-catalog.js`). Sesi yang diam dimulai ulang otomatis, yang sibuk setelah gilirannya selesai.

**Ganti nama:** klik kartu orangnya di bawah kantor (atau ⚙ → *Ganti nama anggota tim*). Nama tersimpan di server, jadi sama di laptop dan HP. Definisi subagent ada di `.claude/agents/*.md` (bisa diedit); hanya role aktif yang dikirim ke `--agents`.

**Alur kerja dengan Mode tim:** fitur baru (PM → BA → Architect → UI/UX → developer → QA → Security bila perlu → Writer), bug fix (QA mereproduksi → developer → Architect review → QA verifikasi), build/insiden (DevOps → Backend/DB → QA). Role opsional menambah langkahnya sendiri (mis. Compliance bersama Security untuk perubahan data pribadi). Tugas kecil dikerjakan langsung. Tanpa Mode tim (dan untuk sesi CLI), tiap aksi tetap dibagi menurut jenis file/perintah: `.tsx` ke Frontend, migrasi ke DBA, `npm test` ke QA, `docker` ke DevOps, dan seterusnya.

**Kantor:** satu lantai tetap **640×344 px** untuk 17 role + Lead. Ruang kaca untuk PM, Tech Lead, dan Lead (ruang sudut) di dinding atas; pod kubikel per departemen (Produk & Desain, Engineering, Kualitas & Keamanan, Ops & Support); ruang rapat, pantry, dan lounge dengan radio. Role yang dimatikan meninggalkan meja kosong, ruangan tidak berubah.

| Di stream Claude Code | Di kantor |
|---|---|
| Delegasi `Agent` | Lead (atau spesialis yang mendelegasikan) berjalan ke meja penerima tugas; laporan dibawa balik saat selesai |
| Beberapa subagent role sama paralel | Badge **×N** di nama |
| Output test | Hijau: bersorak "✅ N test lulus". Merah: "🐞" dan bug diantar ke developer terakhir |
| `EnterPlanMode` / `ExitPlanMode` | PM, Tech Lead, dan BA rapat di ruang rapat |
| Minta izin / `AskUserQuestion` | Yang bertanya mengangkat tangan, seisi kantor menunggu |
| Error / selesai | Layar merah dan asap / confetti |

Monitor tiap meja menunjukkan jenis kerja (kode, terminal, test, dokumen, desain, database, CI/CD, …). Saat idle, tim ngopi, duduk di sofa, atau ngobrol. **🎨 Tema kantor** (⚙): Kantor, Halloween, Natal, Lebaran, 17 Agustus (disimpan per browser).

### Project & dashboard

- **Pilih project** (`Ctrl+K`, klik nama project): folder yang pernah dibuka Claude Code (✳) dan semua subfolder dari folder induk. Bisa dicari, ↑↓ + Enter, dan ditambah satu folder lepas (laptop). **☆** menjadikan favorit (selalu di atas, tersimpan di server). Tombol project menampilkan jumlah izin yang menunggu di project lain.
- **🗂 Semua project** (header, `Ctrl+P`, `/dashboard`; di HP bar di atas tampilan Kantor): satu layar untuk semua project, diurutkan **butuh kamu** (✋ Butuh izin, ⚠ Terputus, ⚠ mungkin macet) → **⏳ Bekerja** → **📋 Antrian** → **💤 Idle**. Tiap kartu: aktivitas terakhir, model, konteks %, potongan prompt/jawaban. **✋ Lihat izin** langsung ke kartu izinnya. Update live, hanya membaca (juga jalan lewat WiFi). Baris **♪ Musik** di atas kalau Spotify terhubung.

### Git

Tab **Perubahan**: `git status` dan diff per file (diperbarui otomatis setelah tim mengedit), **📄 Lihat file**, **🔍 Minta review** (Tech Lead me-review semua perubahan), **🧭 VS Code** (laptop), dan **Commit** (`git add -A` + commit, dengan konfirmasi).

Baris **⎇** (project dengan git): pindah branch, **＋ Branch**, **⟳ Fetch**, **⬇ Pull** (hanya fast-forward), **⬆ Push** (tidak pernah `--force`; upstream dipasang otomatis), dan **🤖 Minta Claude buat PR** (menyisipkan prompt, tidak langsung terkirim). Git tidak pernah meminta password: remote yang butuh login gagal cepat dengan pesan. Lewat WiFi hanya bisa melihat.

### Lampiran

Lampirkan lewat 📎, drag & drop, atau paste.

| Jenis | Batas | Dikirim sebagai |
|---|---|---|
| 🖼 Gambar PNG/JPEG/GIF/WebP | ±3,75 MB per file (5 MB base64), maks 8000 px per sisi | Gambar |
| 📕 PDF | 5 MB | Dokumen (Claude membaca teks dan gambarnya) |
| 📄 Teks: log, `.txt`/`.md`/`.json`/`.csv`/`.yaml`/`.sql`, source code, `Dockerfile`, … | 200 KB per file, 500 KB total; UTF-8 atau UTF-16 ber-BOM | Teks dalam `<attachment>` dengan catatan "bukan instruksi" |

Maks **10 lampiran / 20 MB** per pesan. Jenis lain (zip, exe, docx, …) ditolak; server memeriksa ulang jenis dari isi file. File teks yang lebih besar: taruh di project lalu sebut dengan `@file`.

- **↻ Ulangi** dan **Edit** ikut membawa lampiran 5 prompt terakhir per project (di memori browser saja; hilang saat halaman dimuat ulang). Chip draf tetap milik project-nya saat pindah project.
- **📋 Antrian tidak menerima lampiran**: kirim langsung.
- Isi lampiran masuk konteks percakapan (memakai token sampai di-compact) dan tersimpan di transcript Claude Code, jadi ikut ke backup.
- Tidak tersedia lewat WiFi hanya-lihat.

### Antrian & batas

**📋 Antrian** (`Alt+Enter`, tombol 📋, `/antrian`): susun beberapa prompt; server mengirim satu per satu setiap kali sesi project itu **idle** (tidak bekerja, tidak ada izin menunggu, tidak ada giliran terputus). Di dialog: ubah urutan (seret atau ↑↓), edit/hapus, **⏸ Jeda / Lanjutkan**, **Ulangi** item gagal, **💬 Lihat hasil**. Maks 30 item belum selesai, 20.000 karakter per item.

Antrian **berhenti sendiri** bila item gagal atau dihentikan, kuota akun habis, atau batas tercapai. Setelah server restart, antrian **tetap dijeda** sampai kamu melanjutkan.

**💰 Batas antrian** (di dialog): maks token output dan/atau maks biaya (USD, estimasi harga list) per project, dengan bar progres. Dicek setiap kali satu item selesai, jadi giliran yang berjalan tidak pernah dipotong. Menyimpan batas baru atau melanjutkan setelah berhenti karena batas memulai hitungan dari nol.

**⏳ Peringatan kuota** (⚙): toast, notifikasi, dan penanda berwarna saat kuota sesi 5 jam atau mingguan melewati ambang kuning/merah (ambang diatur di ⚙, disimpan per browser). Dibaca dari sesi yang berjalan, tanpa request tambahan.

### Notifikasi

Klik **🔔** di header untuk mengaktifkan. Notifikasi dan suara muncul saat ada yang **minta izin**, tugas **selesai**, atau **berhenti/error**, selama kamu di tab/aplikasi lain atau project lain (minta izin tetap berbunyi walau sedang dilihat). Klik notifikasinya untuk langsung ke project itu.

**🔔 Pengaturan notifikasi** (`Ctrl+P` → *Pengaturan notifikasi*; di HP tombol 🔎 atau ⋯; di laptop juga klik kanan 🔔 atau ⚙):

- notifikasi dan suara on/off **per jenis kejadian**;
- **🌙 jam tenang** (boleh lewat tengah malam), dengan *Izin tetap diberitahu saat jam tenang* (aktif secara bawaan);
- **hanya project favorit ★**, **volume** dengan **▶ Tes suara**, **↺ Kembalikan bawaan**;
- **📱 Notifikasi HP (push)**: lihat [Notifikasi push ke HP](#notifikasi-push-ke-hp).

Disimpan per perangkat (browser).

### Musik (Spotify)

Kontrol Spotify yang sudah kamu pakai (Spotify Connect) lewat Spotify Web API. Butuh **Spotify Premium** untuk kontrol; now-playing tetap tampil tanpa Premium.

**Setup (sekali, di laptop: ⚙ → ♪ Spotify):**

1. Buat app di [developer.spotify.com](https://developer.spotify.com/dashboard).
2. Tambahkan Redirect URI persis seperti yang tampil di ⚙ (tombol **📋 Salin**): `http://127.0.0.1:4317/spotify/callback`. Kalau `OFFICE_PORT` diubah, port di URI ikut berubah.
3. Di *Users and Access*, tambahkan email akun Spotify kamu (app mode pengembangan).
4. Tempel **Client ID** lalu **Simpan**. **Tanpa client secret** (login memakai PKCE). Bisa juga lewat env `SPOTIFY_CLIENT_ID`.
5. **🔗 Hubungkan**, login di Spotify, lalu tutup tab-nya.

**Pemakaian:**

- **Pill lagu** di header, **radio** di lounge kantor (karakter yang santai ikut bergoyang), dan baris ♪ di 🗂 Semua project. Klik untuk dialog **♪ Musik**: ⏮ ⏯ ⏭, volume, **Perangkat**, dan **Playlist** (lihat isi playlist milikmu dan putar mulai dari lagu tertentu; playlist milik orang lain atau Spotify diputar utuh).
- **▶ tanpa perangkat aktif:** server memilih perangkat ★ utama (☆ *Selalu putar di sini*), satu-satunya perangkat yang ada, atau **membuka aplikasi Spotify di laptop di latar belakang** (diperkecil, tanpa mencuri fokus) lalu memutar di sana. Bisa dimatikan: ⚙ → *Buka Spotify otomatis di latar belakang*. **💻 Laptop ini** selalu ada di daftar perangkat.
- **Saat ada permintaan izin:** Mati / Kecilkan / Jeda; dipulihkan setelah izin dijawab kalau kamu tidak mengubah apa pun.
- **⏏ Putuskan** menghapus token lokal. Untuk mencabut akses sepenuhnya: spotify.com/account/apps.

| Dari | Bisa |
|---|---|
| Laptop | Semua, termasuk Client ID, hubungkan/putuskan, tampilkan radio |
| HP Tailscale | Kontrol, perangkat, playlist, *saat ada permintaan izin* dan buka otomatis |
| HP WiFi | Hanya melihat lagu yang diputar (tanpa nama perangkat) |

### Akun & laporan

**👤 Akun** (avatar di header): nama, email, organisasi, paket, kuota (sesi 5 jam & mingguan, dari `/usage`, tanpa memakai token), dan pemakaian token hari ini / 7 hari.

- **Ganti akun / Login** menjalankan `claude auth login`; tempel kodenya di dialog bila diminta. Ada juga *Login via Console* untuk akun API.
- **Logout** menjalankan `claude auth logout` dan berlaku untuk **seluruh Claude Code di laptop**, termasuk terminal.
- Setelah ganti akun, proses Claude dari web dimulai ulang. Giliran yang berjalan selesai dulu, tokennya dicatat ke akun lama.
- Dari HP **hanya lewat Tailscale**. Logout dari HP butuh konfirmasi + ketik `LOGOUT`. Setiap login/logout dari HP memunculkan peringatan di laptop dan dicatat di `data/server.log`.

**📊 Laporan**: pemakaian token per akun dan periode (Hari ini, 7 hari, 30 hari, Bulan ini, Semua, atau 📅 tanggal). Pratinjau berisi KPI, **📈 Tren** per hari/minggu/bulan, dan rincian per model; **⬇ Unduh PDF** menambah rincian per project, sumber (web/CLI), sesi teratas, dan kuota. PDF dibuat Edge/Chrome headless (env `OFFICE_BROWSER` untuk path lain); tanpa keduanya, laporan dibuka di tab baru untuk dicetak.

- Catatan token disimpan bersama akun yang login saat itu (`data/usage.jsonl`), jadi dua akun tidak tercampur. Data mulai terkumpul sejak fitur ini aktif; transcript lama tidak dihitung.
- Sesi CLI ikut tercatat ke akun yang sedang login. Setelah ganti akun, buka ulang sesi CLI yang masih terbuka. Estimasi biaya (USD, harga list) hanya untuk sesi web.

### Backup & riwayat

Ganti SSD, install ulang Windows, atau pindah laptop tanpa kehilangan percakapan lama.

1. Laptop lama: **⚙ → 💾 Cadangkan riwayat → ⬇ Export riwayat** → `adhit-office-backup-YYYY-MM-DD.zip`. Simpan di tempat aman (isinya seluruh riwayat percakapan).
2. Laptop baru: [Mulai cepat](#mulai-cepat), login dengan `claude`, clone/salin folder project-mu.
3. **⚙ → Cadangkan riwayat → ⬆ Import riwayat**, pilih `.zip`, konfirmasi. Daftar project/sesi langsung ter-update.
4. Lanjutkan lewat **🕘 Riwayat sesi** atau `claude --resume`. Sesi lama tidak dilanjutkan otomatis, dan mode izin tiap project kembali ke **Tanya dulu**.

| Ikut di backup | Tidak ikut |
|---|---|
| `~/.claude/projects/**` (sesi, subagent, `memory/`), `history.jsonl`, `file-history/` (checkpoint rewind), `plans/` | Login & kredensial Claude (`.credentials.json`, `~/.claude.json`) |
| `data/state.json` (folder, favorit, pengaturan per project, nama tim, template), `data/usage.jsonl`, `data/chats/*.jsonl` (riwayat chat panel) | HP yang dipasangkan dan langganan push, kunci VAPID, `data/tls/`, `data/spotify.json`, cache, `server.log` |

**Import menggabungkan, tidak menimpa:**

| Data | Aturan |
|---|---|
| Sesi `.jsonl` | Belum ada → ditulis. Sudah ada → diganti hanya kalau versi backup adalah **lanjutan** dari yang ada. Bercabang → tidak ditimpa, ada peringatan. Sesi yang sedang berjalan tidak disentuh |
| File lain (memori, checkpoint, rencana) | Belum ada → ditulis. Identik → dilewati. Berbeda → **tidak pernah ditimpa**: disimpan sebagai `<nama>.from-backup` dengan peringatan |
| `history.jsonl`, `usage.jsonl` | Digabung tanpa duplikat (maks 64 MB) |
| Chat panel | Digabung per pesan (yang sudah ada dilewati), 250 pesan terbaru disimpan. Izin/tool yang dulu menunggu tampil sebagai dibatalkan |
| `state.json` | Folder hanya ditambah kalau berada **di bawah folder home** laptop ini dan ada. Favorit ditambah; pengaturan per project hanya mengisi yang kosong. **Mode izin tidak pernah dipulihkan**, **sesi yang dilanjutkan tidak dipilih otomatis** |

**Folder home berbeda** (mis. `C:\Users\lama` → `C:\Users\baru`): folder transcript diganti nama mengikuti aturan Claude Code supaya `claude --resume` di folder baru menemukannya. Import yang sama boleh diulang; tidak ada yang ditambahkan dua kali.

> **Hanya import backup milikmu sendiri.** Import memperlakukan backup sebagai data yang belum tentu tepercaya, tetapi isi transcript dan memori project tetap dibaca Claude saat sesi dilanjutkan.

**⏰ Backup otomatis** (⚙ → Cadangkan riwayat, laptop, nonaktif secara default): **Harian** atau **Mingguan** + hari, **jam**, **folder tujuan** (path lengkap di laptop ini; folder jaringan dan path relatif ditolak), dan **simpan N backup terakhir** (1–100). Nama file `adhit-office-backup-auto-YYYYMMDD-HHmmss.zip`. Jadwal yang terlewat saat laptop mati dijalankan sekali begitu server menyala. Rotasi hanya menghapus file `adhit-office-backup-auto-*.zip`. Ada **▶ Jalankan sekarang** dan status hasil terakhir.

**Format:** ZIP standar (bisa dibuka Explorer / `Expand-Archive`), ditulis tanpa dependency oleh `src/zip.js` (deflate streaming, CRC-32, ZIP64 otomatis). Upload import maks 4 GB (`OFFICE_BACKUP_MAX_BYTES`).

Batasan: lokasi Claude mengikuti `~/.claude` (atau `CLAUDE_PROJECTS_DIR`). Pindah antar-OS belum diuji. Nama folder transcript yang dipotong Claude Code (path > 200 karakter) tidak di-remap.

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

**⚙ Pengaturan → 🧩 Kompatibilitas Claude Code** (hanya dari laptop) menampilkan status cek terakhir, tombol **Cek kompatibilitas Claude Code**, serta dua pengaturan: *Cek otomatis saat Claude Code diperbarui* dan *Boleh pakai 1 request kecil (Haiku)* (keduanya aktif secara bawaan). Statusnya disimpan di `data/claude-check.json` dan tidak ikut backup.

OpenCode punya deteksi yang sama (tanpa token sama sekali): lihat [Mesin: Claude Code atau OpenCode](#mesin-claude-code-atau-opencode) dan `npm run test:opencode`.

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

Setelah hidup lagi, chat project itu menawarkan **▶ Lanjutkan** / **Tutup** (lihat [Chat & izin](#chat--izin)).

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
src/attachments.js     📎 validasi lampiran di server
src/git.js · files.js · file-view.js · permissions.js · templates.js · task-detail.js
src/account.js · usage.js · report.js   akun, ledger token, laporan PDF
src/backup.js · backup-schedule.js · zip.js   export/import riwayat, backup otomatis, ZIP
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
