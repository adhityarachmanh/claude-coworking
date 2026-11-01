# Adhit Office

Kantor pixel-art untuk **mengoperasikan Claude Code dari browser dan HP**. Pilih project, ketik prompt, setujui izin. Tim IT berisi 16 role + Lead terlihat bekerja di kantor secara real-time. CLI tidak perlu dibuka, tapi sesi yang kamu jalankan di CLI juga ikut tampil.

```
Browser ──HTTP/SSE──▶ server.js ──stdin/stdout (stream-json)──▶ claude.exe -p   (sesi dari web, satu proses per project)
                         ▲
                         └── membaca ~/.claude/projects/*.jsonl  (sesi dari CLI, read-only, real-time)
```

Server menjalankan Claude Code milikmu sendiri dalam mode headless, jadi login, settings, MCP, dan `CLAUDE.md` tiap project tetap terpakai. Tidak perlu API key dan tidak ada dependency npm. Cukup Node.js ≥ 20.

> Dulu bernama *Claude Coworking*. Nama teknis yang sudah terpasang di Windows (file `claude-coworking.vbs`, task Task Scheduler `Claude Coworking`, rule firewall `Claude Coworking (Tailscale)`) sengaja tidak diganti, supaya auto-start yang sudah jalan tidak rusak.

## Tim

| Orang | Role | Dipakai untuk |
|---|---|---|
| Adhit - Lead | Engineering Lead (Claude) | Orkestrasi: memecah pekerjaan dan mendelegasikan |
| Adhit - PM | Product Manager | Scope, prioritas, acceptance criteria, severity bug |
| Adhit - BA | Business Analyst | Kebutuhan, aturan bisnis, analisis kode/dokumen |
| Adhit - Tech Lead | Tech Lead / Architect | Desain teknis, keputusan arsitektur, **code review** |
| Adhit - UI/UX | UI/UX Designer | Alur pengguna, styling, aksesibilitas |
| Adhit - Frontend | Frontend Developer | Komponen, halaman, state, bug di sisi client |
| Adhit - Backend | Backend Developer | API, logika bisnis, integrasi, bug di sisi server |
| Adhit - DBA | Database Engineer | Skema, migrasi, query, perbaikan data |
| Adhit - QA | QA Engineer | Reproduksi bug, test otomatis, regresi, verifikasi |
| Adhit - Security | Security Engineer | Review OWASP, secret, audit dependensi |
| Adhit - DevOps | DevOps / SRE | Build, CI/CD, Docker, environment, deploy |
| Adhit - Writer | Technical Writer | README, dokumentasi API, changelog |
| Adhit - Freelancer | Freelancer / Generalist | Subagent yang bukan spesialis (`general-purpose`, `fork`, tipe custom yang tidak dikenali) |
| Adhit - Mobile | Mobile Developer | Flutter, React Native, Android/iOS, build & bug khusus perangkat |
| Adhit - Data/AI | Data / AI Engineer | Pipeline data, analitik, notebook, fitur ML/AI (LLM, embedding, RAG) |
| Adhit - Support | Tech Support / Ops Helpdesk | Triage laporan user, reproduksi dari log, respons awal insiden |
| Adhit - Reviewer | Code Reviewer | Review kode independen atas diff sebelum pekerjaan dinyatakan selesai |

**👥 Kelola tim:** ⚙ → *Kelola tim*, menu ⋯, palet Ctrl+P, atau ketik `/team`. Susunan tim hanya dipilih dari **katalog role bawaan** (tidak ada role buatan bebas): 12 role inti + 4 role opsional — `mobile` (Mobile Developer), `data` (Data / AI Engineer), `support` (Tech Support / Ops Helpdesk), `reviewer` (Code Reviewer). Lead selalu ada; Freelancer selalu aktif karena jadi pengganti generalis di ujung setiap rantai fallback. Maks 16 role aktif (semua muat; mulai 13 role kantor mendapat baris meja ke-4 dan ruangan lebih tinggi). Bawaan: semua 16 role aktif (4 baris meja). Tim yang sudah pernah disimpan tidak diubah; **↺ Tim bawaan** mengembalikannya ke 16 role. Role nonaktif tidak pernah dipakai: pekerjaannya dialihkan ke role aktif terdekat (mis. reviewer → architect, data → backend, mobile → frontend, support → qa/ba; katalog di `src/role-catalog.js`). Hanya role aktif yang dikirim ke `--agents` dan disebut di prompt Lead; sesi yang diam dimulai ulang otomatis, yang sibuk setelah gilirannya selesai. Lewat WiFi hanya bisa dilihat.

**Ganti nama anggota tim:** klik kartu orangnya di bawah kantor (atau ⚙ → *Ganti nama anggota tim*), isi nama baru, lalu **Simpan**. Nama yang kosong kembali ke nama bawaan. Nama baru langsung tampil di kantor, chat, dan aktivitas, dan tersimpan di server (`data/state.json`), jadi sama di laptop dan HP. Peran dan sifat kerja tiap role tidak berubah, hanya namanya. Tampilan (rambut, baju, warna) diatur di `public/js/office/cast.js`.

Definisinya ada di `.claude/agents/*.md` (bisa diedit). Dengan **Mode tim** aktif, agent ini diinjeksi ke project mana pun lewat `--agents`, dan Claude diberi alur kerja:

- **Fitur baru**: PM → BA → Architect → UI/UX → Frontend/Backend/DB → QA → Security (jika menyentuh auth/input/data) → Writer
- **Bug fix**: QA mereproduksi (failing test) → developer pemilik memperbaiki akar masalah → Architect review diff → QA verifikasi
- **Build/deploy/insiden**: DevOps → Backend/DB → QA

Selama role opsional aktif, alurnya bertambah:

- **Mobile**: Mobile mengerjakan sisi app → Backend untuk API-nya → QA verifikasi di build device/emulator
- **Data/AI**: Data merancang pipeline/analisis/integrasi model → DBA pemilik skema → Backend menyajikan → QA
- **Laporan user/insiden**: Support triage dan reproduksi dari log dulu → developer pemilik menerima laporan yang jelas
- **Sebelum kode dinyatakan selesai**: Reviewer me-review diff (Architect tetap untuk keputusan desain)

Claude hanya memanggil role yang relevan. Tugas kecil dikerjakan langsung tanpa delegasi. Tanpa Mode tim (atau untuk sesi CLI biasa), tiap aksi tetap dibagi ke orang yang paling cocok menurut jenis file/perintahnya: `.tsx` ke Adhit - Frontend, migrasi ke Adhit - DBA, `npm test` / `curl` ke Adhit - QA, `docker` / `npm install` / cek port & proses ke Adhit - DevOps, `grep` / `cat` / `git diff` ke Adhit - Tech Lead, otomasi browser (Claude in Chrome) ke Adhit - QA, MCP Docs ke Adhit - Writer, dan seterusnya. Rantai perintah (`cd x && npm test | tail`) dinilai dari perintah intinya, bukan dari kata yang kebetulan muncul.

**Interaksi tim mengikuti stream Claude Code:**

| Di stream | Di kantor |
|---|---|
| `Agent` dari Claude utama / dari subagent lain | Adhit - Lead, atau spesialis yang mendelegasikan, berjalan ke meja penerima tugas |
| Subagent selesai (`tool_result` dari `Agent`) | Penerima tugas membawa laporan ke yang menugaskannya |
| Beberapa subagent dengan role sama berjalan paralel | Badge **×N** di nama, dan tetap sibuk sampai semuanya selesai |
| Output test (jest, vitest, pytest, mocha, phpunit, node, go, cargo) | Hijau: bersorak "✅ N test lulus". Merah: "🐞". Kalau test dijalankan Claude utama, QA mengantar bug ke developer terakhir yang mengedit kode. Kalau QA berupa subagent, temuannya kembali lewat laporan ke lead, sama seperti di Claude Code. |
| `EnterPlanMode` / `ExitPlanMode` | PM, Tech Lead, dan BA rapat berdiri di area meeting |
| `AskUserQuestion` / persetujuan rencana | Yang bertanya mengangkat tangan dengan pertanyaannya, dan seisi kantor menunggu jawabanmu |

## Buka dari HP

1. Di laptop, klik **📱** di header, lalu centang **Izinkan akses dari HP**.
2. Sambungkan HP ke **WiFi yang sama** dengan laptop.
3. Scan QR dengan kamera HP. Atau buka alamat yang tertera (mis. `http://192.168.1.10:4317`) lalu masukkan **kode 6 digit**.
4. Selesai. HP diingat, jadi lain kali cukup buka alamat itu lagi.
5. Opsional: pilih **Add to Home Screen** / **Tambahkan ke Layar Utama** di menu browser. Adhit Office muncul dengan ikonnya sendiri dan terbuka seperti aplikasi. Di iPhone, aplikasi dari layar utama punya penyimpanan terpisah dari Safari, jadi masukkan kode pairing sekali lagi di sana.

Apa yang bisa dilakukan HP tergantung jalurnya:

| Jalur | Akses | Bisa | Tidak bisa |
|---|---|---|---|
| 📶 WiFi yang sama (HTTP biasa) | **Hanya lihat** | Melihat kantor, chat, kartu izin, panel perubahan & diff, isi file (kecuali file rahasia), aktivitas, riwayat sesi, akun & laporan token | Mengirim prompt atau `!` shell, menjawab izin, ganti mode/model/effort, commit, rewind, sesi baru/lanjutkan sesi, stop, MCP, hentikan tugas, favorit, ganti nama tim, login/logout |
| 🌐 Tailscale (terenkripsi) | **Penuh** | Semua yang bisa dilakukan di laptop, termasuk login/logout akun Claude (dengan konfirmasi) | Pengaturan laptop (lihat di bawah) |

Lewat WiFi, kotak pesan dan tombol aksi tampil nonaktif dengan keterangan *"Hanya lihat lewat WiFi — pakai Tailscale untuk mengirim perintah"*. Pengaturan sensitif (folder projects, tambah folder project, auto-start, matikan server, akses HP, buka VS Code/folder) hanya bisa diubah dari laptop, apa pun jalurnya.

**Keamanan:**
- Mati secara default. Saat dimatikan, server hanya mendengarkan `127.0.0.1`.
- Saat dinyalakan, server juga mendengarkan alamat LAN laptop (bukan `0.0.0.0`).
- Perangkat baru wajib pairing dengan kode dari layar laptop. Kode berlaku 2 menit, sekali pakai, dan diganti setelah 5 kali salah (jendela 📱 di laptop langsung menampilkan kode baru). Alamat yang 5 kali salah menebak diblokir 60 detik.
- HP yang terpasang menyimpan token acak di cookie `HttpOnly`. Server hanya menyimpan hash-nya.
- Perangkat bisa dicabut kapan saja di jendela 📱. Koneksi live HP itu langsung diputus saat dicabut.
- Koneksi WiFi adalah HTTP biasa (tanpa enkripsi): cookie perangkat bisa disadap orang lain di jaringan yang sama. Karena itu **lewat WiFi HP hanya bisa melihat**; semua aksi (prompt, shell, izin, commit, pengaturan) ditolak server. Untuk mengendalikan dari HP, pakai Tailscale. Tetap **pakai hanya di WiFi yang kamu percaya** (rumah/kantor), karena isi chat dan kode tetap terlihat.
- Saat pertama kali dinyalakan, Windows bisa menanyakan izin firewall untuk Node.js. Pilih **Allow** untuk jaringan *Private*.

### Dari luar rumah (beda jaringan) dengan Tailscale

Supaya bisa membuka kantor dari mana saja (data seluler, WiFi kantor, dll.) **tanpa membuka laptop ke internet publik**:

1. Pasang **Tailscale** di laptop (`tailscale.com/download`), lalu login.
2. Pasang aplikasi **Tailscale** di HP, lalu login dengan akun yang sama.
3. Di laptop, buka **📱**. Muncul pilihan **🌐 Dari mana saja (Tailscale)**. Pilih itu, lalu scan QR-nya dari HP.

Tailscale membuat jaringan pribadi terenkripsi (WireGuard) yang hanya berisi perangkatmu sendiri, jadi lewat Tailscale HP mendapat **kendali penuh** (mengirim perintah, menjawab izin, commit). Aplikasi ini otomatis mengenali alamat Tailscale (`100.64.0.0/10`) dan mendengarkannya saat akses HP aktif, tanpa pengaturan tambahan. Alamat WiFi dan Tailscale dipasangkan terpisah, jadi HP perlu scan sekali untuk masing-masing.

Supaya tetap bisa diakses saat kamu pergi:
- **Laptop harus menyala dan tidak sleep.** Atur di *Settings → System → Power*: saat dicolok, sleep = **Never**. Atur juga *saat lid ditutup = Do nothing* kalau laptop sering kamu tutup.
- Nyalakan **auto-start** (⚙), supaya server langsung jalan lagi setelah laptop restart.

> Tunnel publik seperti ngrok atau Cloudflare Tunnel sengaja tidak dipakai. Aplikasi ini bisa menjalankan perintah di laptopmu, jadi lebih aman kalau tidak punya alamat publik sama sekali.

## Sesi dari CLI (real-time)

Semua sesi `claude` yang kamu jalankan di terminal, di project mana pun, otomatis tampil di kantor. Prompt, balasan, tool, delegasi subagent, dan tanda selesai ditandai **CLI**. Server hanya **membaca** file transcript yang memang ditulis Claude Code (`~/.claude/projects`), jadi tidak ada hook dan CLI tidak terpengaruh sama sekali.

Batasan: izin untuk sesi CLI tetap dijawab di terminal (transcript tidak mencatat prompt izin yang sedang menunggu), dan mengetik prompt dari web membuat sesi web terpisah, bukan menyuntikkan pesan ke sesi CLI yang sedang terbuka.

## Setup di device baru

1. Pasang **Node.js 20+** dan **Claude Code** (`npm install -g @anthropic-ai/claude-code`), lalu login sekali dengan menjalankan `claude` di terminal.
2. Clone repo ini ke folder mana saja.
3. Double-click **`setup.cmd`**. Setup berjalan langkah demi langkah dan **selalu bertanya (Y/n) sebelum memasang apa pun**:

   | Langkah | Yang dilakukan |
   |---|---|
   | 1. Node.js & Claude Code | Memeriksa versi, memberi tahu cara memasang kalau belum ada |
   | 2. Tailscale (opsional) | Menawarkan pasang lewat winget, lalu membuka halaman login. Dibutuhkan supaya HP bisa membuka kantor dari jaringan mana saja |
   | 3. Firewall | Menawarkan aturan sempit: hanya TCP 4317, hanya dari alamat Tailscale (muncul jendela izin Administrator sekali) |
   | 4. Auto-start & server | Memasang auto-start saat login **plus penjaga Task Scheduler** yang mengecek setiap 5 menit dan menyalakan server lagi kalau mati (setelah sleep, hibernate, Fast Startup, atau crash). Lalu langsung menyalakan server di latar belakang |

4. Di web: **⚙** untuk folder projects, **🔔** untuk notifikasi, **📱** untuk menghubungkan HP.
5. Di HP: pasang **Tailscale**, login dengan akun yang sama, lalu scan QR dari 📱.

Setelah itu Claude Code, terminal, dan browser di laptop boleh ditutup. Server tetap jalan dan menyala sendiri setiap Windows login.

| Perintah | Fungsi |
|---|---|
| `node scripts\setup.mjs --check` | Cek status semua langkah tanpa mengubah apa pun |
| `uninstall-autostart.cmd` | Melepas auto-start |
| ⚙ → **⏻ Matikan server** | Menghentikan server background, misalnya sebelum `git pull` lalu `setup.cmd` lagi |

> Jangan jalankan `npm run dev` bersamaan dengan server background, karena keduanya memakai port 4317.

> Kalau folder repo dipindah atau versi Node.js diganti (misalnya lewat nvm), jalankan `setup.cmd` lagi, karena lokasi keduanya tercatat di script auto-start.

## Pindah laptop / backup riwayat

Ganti SSD, install ulang Windows, atau pindah ke laptop baru, tanpa kehilangan percakapan lama:

1. Di laptop lama: **⚙ → Cadangkan riwayat → ⬇ Export riwayat**. Browser mengunduh `adhit-office-backup-YYYY-MM-DD.zip`. Simpan file ini di tempat aman, karena isinya seluruh riwayat percakapanmu.
2. Di laptop baru: pasang app seperti di [Setup di device baru](#setup-di-device-baru), login dengan `claude`, lalu clone/salin folder project-mu.
3. **⚙ → Cadangkan riwayat → ⬆ Import riwayat**, pilih file `.zip`, lalu konfirmasi. Ringkasan hasil tampil di dialog, dan daftar project/sesi langsung ter-update tanpa restart.
4. Lanjutkan: buka project → **Riwayat sesi**, pilih sesinya, atau jalankan `claude --resume` di folder project. Sesi lama tidak dilanjutkan otomatis, dan mode izin tiap project kembali ke **Manual**.

> **Hanya import backup milikmu sendiri.** Import memperlakukan file backup sebagai data yang belum tentu tepercaya. Backup tidak bisa menimpa file yang sudah ada (selain melanjutkan transcript yang sama), tidak bisa mengubah mode izin, tidak bisa memilih sesi yang dilanjutkan, dan tidak bisa menambah folder di luar folder home-mu. Meski begitu, isi transcript dan memori project tetap dibaca Claude saat sesi dilanjutkan.

| Ikut di backup | Tidak ikut |
|---|---|
| `~/.claude/projects/**` (semua project: sesi `.jsonl`, subagent, `memory/`), `history.jsonl` (↑ riwayat prompt), `file-history/` (checkpoint rewind), `plans/` | Login & kredensial (`.credentials.json`, `~/.claude.json`) |
| `data/state.json` (folder induk, folder tambahan, favorit, pengaturan per project, nama tim) dan `data/usage.jsonl` (laporan token) | Cache, downloads, `server.log`, HP yang dipasangkan (pasangkan ulang di laptop baru) |

**Folder home berbeda** (mis. `C:\Users\lama` → `C:\Users\baru`): folder transcript diganti nama mengikuti aturan Claude Code (karakter non-alfanumerik jadi `-`, mis. `C:\Users\baru\projects\toko` → `C--Users-baru-projects-toko`), supaya `claude --resume` di folder baru menemukannya. Path di luar folder home tidak diubah. Isi file sesi tidak diubah. Satu-satunya pengecualian adalah field `project` di `history.jsonl`, yang dipindah ke home baru supaya riwayat ↑ per project tetap jalan.

**Import menggabungkan, tidak menimpa buta:**

| Data | Aturan |
|---|---|
| Sesi `.jsonl` (termasuk subagent) | Belum ada → ditulis. Sudah ada → diganti hanya kalau versi backup adalah **lanjutan** dari yang ada (isi lama sama persis, lalu bertambah). Kalau isinya bercabang, file tidak ditimpa dan ada peringatan. Tidak dibuat salinan kedua, supaya tidak muncul sesi ganda. Sesi yang sedang berjalan (proses web aktif, giliran CLI berjalan, atau file ditulis < 1 menit lalu) **tidak disentuh** |
| File lain (memori, checkpoint, rencana, meta) | Belum ada → ditulis. Identik (ukuran + CRC) → dilewati. Berbeda → **tidak pernah ditimpa**: versi backup disimpan di sampingnya sebagai `<nama>.from-backup` (`-2`, `-3`, …) dengan peringatan. Memori yang ditambahkan ke project yang sudah ada di laptop ini selalu dilaporkan di peringatan |
| `history.jsonl` | Baris unik dari keduanya, diurutkan menurut `timestamp` (maks 64 MB, lebih besar dilewati dengan peringatan) |
| `usage.jsonl` | Digabung tanpa duplikat (maks 64 MB) |
| `state.json` | Lewat hub, bukan menimpa file. Folder induk/tambahan (dan folder project dari manifest) hanya ditambah kalau, setelah di-remap, berada **di bawah folder home** laptop ini (bukan home itu sendiri, bukan root drive, bukan folder jaringan) dan foldernya ada. Selain itu dilewati dengan peringatan, jadi tambahkan manual bila perlu. Favorit ditambah. Pengaturan per project (model, effort, mode tim) diisi hanya kalau di laptop ini belum ada. **Mode izin tidak pernah dipulihkan** (selalu Manual), dan **sesi yang dilanjutkan tidak dipilih otomatis**. Nama tim hanya untuk role yang belum diganti. Chat panel tidak dipulihkan (riwayat sesi diambil dari transcript). **HP yang dipasangkan tidak diimpor**: token HP terikat ke alamat laptop lama, dan mengimpor hash-nya diam-diam akan memberi akses lagi ke perangkat yang mungkin sudah tidak kamu pakai |

Project yang foldernya sudah ada di laptop baru langsung muncul di daftar. Folder yang belum ada dilaporkan di peringatan, dan riwayatnya tetap dipulihkan, jadi akan muncul setelah folder itu di-clone. Setiap file ditulis atomik (file sementara lalu rename, folder tujuan diperiksa ulang tepat sebelum rename). Waktu modifikasi aslinya dipertahankan supaya urutan "terakhir dipakai" tetap benar, tetapi tidak pernah melewati waktu sekarang. Import yang sama boleh dijalankan berulang: tidak ada yang ditambahkan dua kali.

**Keamanan:** Export/import hanya dari laptop. HP ditolak (403), termasuk lewat Tailscale. Endpoint tetap butuh token + cek Host/Origin. Upload maksimal 4 GB (`OFFICE_BACKUP_MAX_BYTES`), disimpan sementara di `data/tmp/` lalu dihapus. Sisa upload yang terputus dibersihkan saat server start. Zip dibatasi maksimal 200.000 entri dan central directory 64 MB. Sebelum ada satu byte pun yang ditulis, setiap entri zip diperiksa: harus berada di bawah prefix yang dikenal (`claude/projects/`, `claude/file-history/`, `claude/plans/`, `claude/history.jsonl`, `office/state.json`, `office/usage.jsonl`, `manifest.json`), dan ditolak kalau berisi `..`, path absolut, drive letter, backslash, nama device Windows, nama pendek 8.3 (`~1`), symlink, entri terenkripsi, atau nama ganda. Tujuan akhir di-resolve (termasuk symlink/junction) dan harus berada di dalam folder tujuan. Ukuran dan CRC setiap file diverifikasi saat diekstrak. Hanya satu export/import yang bisa berjalan pada satu waktu.

**Format:** ZIP standar (bisa dibuka Windows Explorer / `Expand-Archive`), ditulis dan dibaca oleh `src/zip.js` tanpa dependency: deflate streaming per file, CRC-32, nama UTF-8, dan ZIP64 otomatis untuk file > ~3,75 GB, total > 4 GB, atau lebih dari 65.535 file. Export di-stream langsung ke browser, tanpa menampung seluruh zip di memori server. Contoh ukuran: 173 MB transcript menjadi zip 57 MB dalam ±4 detik.

### ⏰ Backup otomatis

**⚙ → Cadangkan riwayat → ⏰ Backup otomatis** (nonaktif secara default, hanya dari laptop): pilih **Harian** atau **Mingguan** + hari, **jam** (waktu lokal), **folder tujuan** (path lengkap di laptop ini yang ada dan bisa ditulis; folder jaringan `\\server\share`, path perangkat `\\.\…`/`\\?\…`, path relatif, dan nama perangkat Windows ditolak), dan **simpan N backup terakhir** (1–100). Isinya sama dengan Export riwayat, bernama `adhit-office-backup-auto-YYYYMMDD-HHmmss.zip`. Server memeriksa jadwal tiap menit; jadwal yang terlewat saat laptop mati dijalankan sekali begitu server menyala, sedangkan jadwal sebelum pengaturan disimpan tidak pernah dijalankan. Backup ditulis ke `.<nama>.zip.partial` di folder yang sama, di-flush, lalu di-rename, jadi tidak pernah ada zip setengah jadi dengan nama backup. Rotasi hanya menghapus file yang cocok dengan pola nama `adhit-office-backup-auto-*.zip` (export manual dan file lain tidak disentuh). Backup otomatis tidak berjalan bersamaan dengan export/import (dicoba lagi menit berikutnya). Hasil terakhir (waktu, nama, ukuran, atau error) tampil di ⚙, plus tombol **▶ Jalankan sekarang**.

Batasan: lokasi Claude mengikuti `~/.claude` (atau `CLAUDE_PROJECTS_DIR`). `CLAUDE_CONFIG_DIR` belum dibaca, sama seperti bagian app lainnya. Pindah antar-OS (Windows ↔ macOS/Linux) memetakan path di bawah home, tetapi belum diuji. Nama folder transcript yang dipotong Claude Code untuk path yang sangat panjang (> 200 karakter) tidak di-remap.

## Menjalankan

Double-click **`start-office.cmd`** (otomatis membuka browser), atau:

```bash
npm run open    # http://localhost:4317
```

Tutup jendela server (atau tekan Ctrl+C) untuk berhenti. Semua proses Claude Code ikut ditutup.

### Restart server (mis. saat mengembangkan app ini)

```bash
node scripts/restart.mjs            # port lain: --port 4400 (atau env OFFICE_PORT)
```

Skrip ini meminta server berhenti dengan rapi (`POST /api/shutdown`, hanya dari laptop), menunggu port bebas, lalu menjalankan `node server.js --background` ter-detach (log di `data/server.log`) dan menunggu `/health`. Argumen lain untuk `server.js` bisa ditaruh setelah `--` (mis. `node scripts/restart.mjs -- --open`; tanpa `--background`, output server tidak tersimpan).

Pakai ini, bukan `Stop-Process -Force`. Proses Claude Code adalah child process server (prompt & jawaban lewat pipe stdin/stdout), jadi **giliran yang sedang berjalan selalu terputus saat server berhenti**. Bedanya:

| Cara berhenti | Yang terjadi pada giliran yang sedang berjalan |
|---|---|
| `scripts/restart.mjs`, Ctrl+C, ⚙ → **⏻ Matikan server**, SIGTERM | Dicatat sebagai terputus, lalu di-interrupt seperti Esc (maks 3 dtk) supaya Claude Code menutup giliran di transcript-nya, baru prosesnya dimatikan |
| `Stop-Process -Force`, crash, laptop mati | Penanda "giliran berjalan" (ditulis ke `data/state.json` saat giliran mulai) ditemukan saat start berikutnya. Bagian jawaban yang belum selesai ditulis bisa hilang |

Setelah server hidup lagi, chat project itu menampilkan *"Server di-restart saat Claude sedang bekerja — giliran terputus"*, dan di atas kotak pesan ada tombol **▶ Lanjutkan** (mengirim "Lanjutkan pekerjaan yang terputus tadi…" ke sesi yang sama lewat `--resume`) dan **Tutup**. Tidak ada yang dikirim otomatis, karena melanjutkan memakai token. Di kantor, Lead memasang tanda menunggu (✋). Mengirim prompt lain, memulai sesi baru, atau membuka sesi lain juga menutup pemberitahuan itu.

**Nyala otomatis saat Windows login:** buka **⚙** di header, lalu centang *Nyalakan otomatis saat Windows login*. Server berjalan tanpa jendela (log di `data/server.log`), jadi kamu cukup membuka `http://localhost:4317`. Untuk mematikannya, pakai tombol **⏻ Matikan server** di panel yang sama. Mencentang ini membuat file `claude-coworking.vbs` di folder Startup Windows, dan menghapus centang akan menghapus file itu.

## Cara pakai

| Bagian | Fungsi |
|---|---|
| **Pilih project** (`Ctrl+K`) | Klik nama project di header. Dialog berisi folder yang pernah dibuka Claude Code di device ini (✳) dan semua subfolder dari **folder induk** yang kamu atur lewat **⚙**. Bisa dicari, dipilih dengan ↑↓ + Enter, dan ditambah satu folder lepas lewat kolom di bawah. Klik **☆** untuk menjadikan favorit: project favorit selalu di atas (tersimpan di server, sama di laptop dan HP), disusul project yang sedang bekerja atau minta izin. Tombol project juga menampilkan jumlah izin yang menunggu di project lain. |
| **👤 Akun** | Profil akun Claude yang sedang login, kuota paket, pemakaian token hari ini/7 hari, serta **Ganti akun** / **Logout**. Lihat [Akun Claude & laporan token](#akun-claude--laporan-token). |
| **📊 Laporan** | Laporan pemakaian token per akun (input, output, cache read/write, cache hit, request, estimasi biaya) yang bisa diunduh sebagai PDF. |
| **⚙ Folder projects** | Atur satu atau lebih folder induk (satu per baris). Disimpan per device di `data/state.json`. Kalau belum diatur, dipakai folder tempat `agent-place` berada (atau env `PROJECTS_ROOT`). |
| **Chat** | Prompt ke Claude Code di folder project itu. Pesan yang dikirim saat tim bekerja masuk antrean Claude Code sendiri dan dibaca Claude di langkah berikutnya, sama seperti di CLI. Di desktop, lebar panel chat bisa diatur dengan menggeser tepi kirinya (klik dua kali untuk ukuran bawaan). |
| **Kartu izin** | Muncul setiap kali Claude butuh izin: **Izinkan**, **Izinkan selalu** (simpan aturan), **Izinkan semua (sesi ini)**, atau **Tolak** (bisa disertai instruksi untuk Claude). Pertanyaan (`AskUserQuestion`) bisa dijawab dengan pilihan atau jawaban sendiri. Rencana (mode *Rencana dulu*) disetujui dengan **auto-edit** atau **tanya tiap edit**, seperti dialog rencana di CLI. |
| **Izin** | 🛡️ Tanya dulu (default) · ✏️ Auto-edit file · ⚡ Auto · 📋 Rencana dulu · 🚫 Jangan tanya. `Shift+Tab` di kotak pesan berganti mode. Perubahan langsung berlaku, juga di tengah giliran. |
| **Model** | Daftar model dari Claude Code sendiri (sama dengan `/model`: Fable, Opus, Sonnet, Haiku, dan versi spesifik). `/model <nama>` juga menerima alias seperti `opus[1m]` atau `opusplan`. Ganti model langsung berlaku tanpa restart. |
| **Effort** | Seberapa dalam Claude berpikir (`--effort`): Default (dari settings Claude Code), Low, Medium, High, X-High, Max. Lebih tinggi lebih teliti untuk tugas sulit, tapi lebih lambat dan lebih banyak token. Berlaku per project dan langsung berlaku tanpa restart (kembali ke Default memulai ulang prosesnya, percakapan tetap berlanjut). |
| **Mode tim** | Claude mendelegasikan ke subagent dari role yang aktif (bawaan 15; Freelancer menampung tipe `general-purpose`/`fork`). Visualnya lebih hidup, tapi **lebih banyak token**. Matikan untuk Claude Code biasa. |
| **📋 Antrian** (`Alt+Enter`, tombol 📋, `/antrian`) | Susun beberapa prompt untuk satu project: `Alt+Enter` (atau tombol 📋 di samping **Kirim**) memasukkan isi kotak pesan ke antrian, bukan langsung dikirim; kotak kosong membuka daftarnya. Server mengirim item berikutnya otomatis saat sesi project itu **idle** (tidak bekerja, tidak ada izin yang menunggu, tidak ada giliran terputus), satu per satu, masing-masing di gilirannya sendiri. Di dialog: ubah urutan (seret atau ↑↓), edit/hapus item yang menunggu, **Jeda/Lanjutkan**, **Ulangi** item gagal, **💬 Lihat hasil** (lompat ke prompt dan jawabannya di chat). Status: menunggu/berjalan/selesai/gagal. Antrian berhenti sendiri bila item gagal atau dihentikan (Esc), kuota akun habis, atau **batas antrian** tercapai (pemberitahuan di chat + toast). **Batas antrian** (di dialog): maks token output dan/atau maks biaya (USD, estimasi harga list) per project; progresnya tampil sebagai bar. Batas dicek setiap kali satu item selesai, jadi giliran yang sedang berjalan tidak pernah dipotong. Menyimpan batas baru, atau melanjutkan antrian yang dijeda karena batas, memulai hitungan dari nol. Biaya dan token dihitung per giliran (termasuk subagent); giliran yang berhenti tanpa hasil (server di-restart, Claude Code keluar) tidak ikut terhitung. Antrian disimpan di `data/state.json`: setelah server di-restart antrian **tetap dijeda** sampai kamu melanjutkan. Maks 30 item belum selesai, 20.000 karakter per item. Chip 📋 di bar sesi menampilkan jumlahnya (⏸ saat dijeda). Lewat WiFi hanya bisa melihat. |
| **■ Stop** / `Esc` | Muncul di sebelah **Kirim** saat tim bekerja. Menghentikan giliran yang sedang berjalan dan membatalkan pesan yang masih antre; sesi tetap bisa dilanjutkan. |
| **⏪ Rewind** (`Esc Esc`, `/rewind`) | Kembalikan **kode dan/atau percakapan** ke sebelum salah satu pesanmu, memakai checkpoint Claude Code. Pratinjau menunjukkan file yang akan kembali (+/−). Pesan yang di-rewind masuk lagi ke kotak pesan untuk diedit. |
| **Status line** | Di bawah kotak pesan: mode izin, model, dan konteks terpakai dari Claude Code (seperti `/context`, dengan batas auto-compact), plus jumlah tugas latar. |
| **Daftar tugas** | Todo list Claude (TodoWrite/Task) menempel di atas kotak pesan dan update live. |
| **✻ Berpikir** | Proses berpikir Claude tampil sebagai baris yang bisa dibuka (kalau modelnya membagikannya). |
| **🔌 Server MCP** (`/mcp`) | Status semua server MCP, **Sambungkan ulang**, **Aktifkan/Nonaktifkan**, dan **Login** OAuth untuk server yang perlu login. Dari HP, login hanya lewat Tailscale. |
| **⧗ Tugas latar** (`/tasks`, `Ctrl+B`) | Perintah dan agent yang dijalankan Claude Code (misalnya dev server): status, output terakhir, dan **Hentikan**. `Ctrl+B` memindahkan yang sedang jalan ke latar belakang. |
| **Output live di chat** | Baris perintah Bash/PowerShell yang sedang berjalan menampilkan beberapa baris output terakhir; dibuka (▸) menampilkan output lengkap (8 KB terakhir) yang terus bertambah. Hanya dibaca selama baris itu terlihat di layar; berhenti saat perintah selesai. |
| **📄 Lihat file** | Path file di chat (baris Read/Edit/Write, path seperti `src/app.js:120` di jawaban Claude) dan tombol **📄 Lihat file** di tab Perubahan membuka isi file (read-only, hanya di dalam folder project): nomor baris, syntax highlight, `:baris` disorot, cari (`Ctrl+F`), salin, **Buka di VS Code** (laptop). File yang mungkin berisi rahasia (`.env*`, `*.pem`, `id_*`, kredensial) butuh konfirmasi di laptop dan tidak pernah dikirim ke HP. |
| **`!perintah`** | Jalankan perintah shell langsung di folder project (PowerShell di Windows). Output-nya ikut ke Claude bersama pesan berikutnya, seperti bash mode di CLI. Dari HP hanya lewat Tailscale. |
| **Bar sesi** | Baris di atas chat yang menunjukkan percakapan Claude Code yang sedang dipakai: judul, asal (web atau lanjutan sesi terminal), dan model. Klik judulnya untuk mengganti nama sesi (sama dengan `/rename`). |
| **＋ Sesi baru** | Mulai percakapan baru. Claude tidak membawa konteks sebelumnya, tapi percakapan lama tetap ada di riwayat. |
| **🕘 Riwayat sesi** | Dialog berisi sesi Claude Code di project itu, dari terminal maupun web. Sesi dikelompokkan per hari dan bisa dicari. Klik **Lanjutkan** untuk memuat percakapan terakhirnya ke chat, dan Claude melanjutkan dengan konteks yang sama. |
| **⋯ Lainnya** | Menu di bar sesi: **Export percakapan** ke Markdown, **Salin perintah lanjut di terminal** (`cd` ke project + `claude --resume <id>`), serta **Buka project di VS Code** dan **Buka folder project** (khusus laptop). |
| **Salin · Edit · ↻ Ulangi** | Arahkan kursor ke pesan (di HP selalu tampil). Jawaban dan code block bisa disalin. Prompt bisa disalin, diedit ulang di kotak pesan, atau dikirim lagi (**Ulangi** hanya ada di prompt web terakhir). |
| **↑ / ↓** · `Ctrl+R` | Di kotak pesan, panggil lagi prompt sebelumnya di project itu, seperti di CLI. Draft yang sedang diketik kembali setelah prompt terbaru. `Ctrl+R` mencari di riwayat prompt. |
| **❓ Bantuan** / `?` | Panduan singkat, penjelasan mode izin, dan daftar shortcut keyboard. |
| **`/` command** | Menu slash command lengkap dengan deskripsi dan argumen, langsung dari Claude Code (built-in, skill, plugin, custom command). Command yang jalan headless (`/usage`, `/context`, `/compact`, `/rename`, …) menampilkan output-nya di chat. Yang di terminal berupa dialog (`/clear`, `/model`, `/effort`, `/resume`, `/rewind`, `/mcp`, `/tasks`, `/memory`, `/help`) dijalankan oleh aplikasi ini. |
| **`@file`** | Autocomplete path file di project. |
| **📎 Gambar** | Lampirkan gambar (paste, drag & drop, atau 📎). PNG/JPEG/GIF/WebP, maks 5 gambar × 5 MB. |
| **🔔 Notifikasi** | Klik 🔔 di header untuk mengaktifkan. Notifikasi Windows dan suara muncul saat ada yang **minta izin**, tugas **selesai**, atau **berhenti/error**, selama kamu sedang di tab/aplikasi lain atau di project lain. Klik notifikasinya untuk langsung ke project itu. |
| **Tab Perubahan** | `git status` dan diff per file yang belum di-commit (diperbarui otomatis setelah tim mengedit), tombol **🔍 Minta review** (Adhit - Tech Lead me-review semua perubahan), **🧭 VS Code** (membuka file yang dipilih di VS Code, khusus laptop), dan **Commit** (`git add -A` + commit, dengan konfirmasi). |
| **Detail tool** | Klik baris tool untuk melihat perintah, diff edit (`-`/`+`), dan output. Klik baris delegasi untuk melihat instruksi dan laporan subagent. |
| **🎬 Demo kantor** | Simulasi tanpa Claude Code, termasuk satu kartu izin. |

Balasan Claude tampil streaming per kata, code block diberi syntax highlighting, dan setiap giliran ditutup dengan durasi, jumlah langkah, ukuran konteks, dan token output.

Percakapan berlanjut antar prompt (`--resume`). Riwayat chat dan pengaturan per project disimpan di `data/state.json`.

## Akun Claude & laporan token

Klik avatar di header (**👤**) untuk melihat akun mana yang sedang dipakai Claude Code di laptop ini: nama, email, organisasi, paket, peran, tier rate limit, kuota paket (sesi 5 jam & mingguan, dari `/usage` — tidak memakai token), dan pemakaian token akun itu hari ini dan 7 hari terakhir.

- **Ganti akun / Login** menjalankan `claude auth login` seperti biasa: halaman login claude.ai terbuka di browser. Kalau halaman itu menampilkan kode, tempel kodenya di dialog. Ada juga *Login via Console* untuk akun API.
- **Logout** menjalankan `claude auth logout`. Ini berlaku untuk **seluruh Claude Code di laptop**, termasuk terminal/CLI.
- Setelah ganti akun atau logout, proses Claude dari web dimulai ulang agar memakai akun baru. Giliran yang sedang berjalan dibiarkan selesai dulu, dan tokennya tetap dicatat ke akun lama.
- Login/logout bisa dari laptop, atau dari HP **hanya lewat Tailscale** (koneksi terenkripsi). Lewat WiFi biasa (HTTP) HP hanya bisa melihat profil, kuota, dan laporan.
  - Login dari HP: ketuk **🔑 Buka halaman login Claude**, selesaikan login di HP, lalu tempel kode yang ditampilkan halaman itu.
  - Logout dari HP butuh dua langkah: konfirmasi, lalu ketik `LOGOUT`.
  - Setiap login/logout dari HP memunculkan peringatan (toast, suara, dan notifikasi) di laptop dan dicatat di `data/server.log`.

**📊 Laporan** menampilkan dan mengunduh (PDF) pemakaian token untuk **satu akun** dan satu periode. Alurnya dua langkah:

1. **Pilih data**: akun dan periode (Hari ini, 7 hari, 30 hari, Bulan ini, Semua, atau 📅 Pilih tanggal). Rentang tanggalnya ditulis di bawah pilihan. Pilihan ini berlaku untuk pratinjau **dan** PDF.
2. **Pratinjau**: ringkasan KPI, lalu **📈 Tren pemakaian** dengan tombol **Per hari / Per minggu / Per bulan** tepat di atas grafiknya. Grafik menampilkan satu batang per hari/minggu/bulan untuk seluruh periode, termasuk yang kosong. Tabel di bawahnya hanya berisi periode yang ada pemakaian, terbaru di atas. *Per minggu* dan *per bulan* nonaktif kalau periodenya belum mencakup dua minggu/bulan, karena isinya akan sama dengan total.

Kalau pencatatan akun itu baru dimulai di tengah periode, pratinjau memberi tahu sejak kapan, supaya batang kosong di awal tidak disangka "tidak dipakai". Baris di samping **⬇ Unduh PDF** menyebut isi PDF-nya: akun, rentang tanggal, dan rinciannya. PDF juga memuat rincian per model, project, sumber (web/CLI), sesi teratas, dan kuota paket. Setiap catatan token disimpan bersama akun yang sedang login saat token itu dipakai (`data/usage.jsonl`), jadi pemakaian dua akun tidak pernah tercampur.

- Data mulai terkumpul **sejak fitur ini aktif**. Transcript lama Claude Code tidak mencatat akun, jadi sengaja tidak dihitung.
- Sesi dari web dan dari CLI (lewat mirror) sama-sama tercatat. Transcript CLI tidak menyimpan akun, jadi token CLI dicatat ke akun yang sedang login. Setelah ganti akun, tutup lalu buka lagi sesi CLI yang masih terbuka agar catatannya tetap akurat. Estimasi biaya (USD, harga list) hanya tersedia untuk sesi web. Untuk paket Pro/Max/Team yang membatasi adalah kuota, bukan biaya.
- PDF dibuat oleh Edge/Chrome dalam mode headless dengan profil sementara. Kalau tidak ada keduanya, laporan dibuka di tab baru untuk dicetak ke PDF dari browser.

## Kantor

- **Ruang boss** berdinding kaca untuk Adhit - Lead (Engineering Lead): meja eksekutif, kursi kulit, kursi tamu, dan TV grafik aktivitas. Boss duduk menghadap pintu, tamu (prompt) datang ke depan mejanya, dan boss keluar ruangan untuk mendelegasikan.
- Satu meja staf per role aktif dalam grid 4 kolom (bawaan 16 meja dalam 4 baris; tim ≤ 12 role tetap 3 baris), meja meeting bundar, pantry, sofa, dan rak server di samping DevOps.
- Tiap tool call menggerakkan karakter yang sesuai. Layar monitornya menunjukkan jenis kerja: kode, terminal, test, dokumen, desain, pencarian, browser, kanban, tabel database, pipeline CI/CD, security scan, diff review.
- Delegasi: Claude berjalan ke meja anggota tim. Minta izin: anggota tim berdiri dan angkat tangan. Error: layar merah dan asap. Selesai: confetti.
- Whiteboard menampilkan todo list Claude, atau daftar delegasi.
- Saat idle, tim ngopi, duduk di sofa, ngobrol, atau cek server. Jendela dan lampu mengikuti jam lokal. Ada kucing kantor.

## Keamanan

- Server hanya listen di `127.0.0.1`, memeriksa header `Host`/`Origin`, dan semua API butuh token acak per start (disisipkan ke halaman). Situs lain tidak bisa menyuruh server menjalankan Claude Code.
- Situs lain tidak bisa memuat kantor di dalam iframe (`frame-ancestors 'self'`, `X-Frame-Options`), sehingga tombol seperti **Izinkan** tidak bisa dipancing lewat clickjacking.
- Setiap respons membawa Content-Security-Policy ketat (`script-src 'self'`, tanpa script inline, `object-src 'none'`, `base-uri 'none'`, `connect-src 'self'`), dan `Referrer-Policy: no-referrer`; halaman di laptop juga `Cross-Origin-Opener-Policy: same-origin` (browser mengabaikan COOP di alamat http://IP, jadi tidak dikirim ke HP). Gaya inline tetap diizinkan karena tampilan dan laporan PDF memakainya.
- Akses HP: **WiFi = hanya lihat, Tailscale = penuh**. Satu gerbang di server (`wifiAllows` di `src/remote.js`) mengizinkan WiFi hanya untuk daftar aksi baca; endpoint baru otomatis ditolak lewat WiFi sampai sengaja dimasukkan ke daftar itu.
- Folder jaringan (UNC seperti `\\server\share`, `//server/share`, `\\?\`, `\\.\`) ditolak sebelum disentuh, supaya Windows tidak mengirim hash NTLM ke server lain.
- Diff file baru yang berupa symlink hanya menampilkan tujuannya (`symlink → …`), bukan isi file yang ditunjuk.
- Error tak terduga di server hanya dikirim ke browser sebagai pesan umum; detailnya ada di log server.
- Izin tetap mengikuti aturan Claude Code. Mode default selalu bertanya sebelum menulis file atau menjalankan perintah.
- Login/logout akun hanya dari laptop atau dari HP lewat Tailscale (ditolak lewat WiFi biasa), dengan peringatan ke laptop. Server tidak pernah membaca token login (`.credentials.json`); profil diambil dari `claude auth status` dan data profil di `~/.claude.json`.
- **Buka di VS Code / folder** hanya bisa dari laptop, hanya untuk folder project yang terdaftar (file harus berada di dalam project), dan dijalankan tanpa shell. Path dikirim sebagai argumen biasa, tidak pernah ditafsirkan sebagai perintah.
- Export/import riwayat hanya dari laptop. Isi zip diperiksa (zip-slip, symlink, nama device, CRC) sebelum ada yang ditulis, dan kredensial login tidak pernah ikut di backup. Lihat [Pindah laptop / backup riwayat](#pindah-laptop--backup-riwayat).
- Ikon dan manifest PWA bisa diambil tanpa pairing karena tidak berisi data. Selain itu semuanya tetap butuh pairing.

## Test

```bash
npm test             # ±8 detik, offline: unit + server sungguhan dengan Claude Code palsu
npm run test:claude  # uji kontrak ke Claude Code asli (beberapa request Haiku)
```

| Lapis | Isi |
|---|---|
| Unit (`test/*.test.mjs`) | Pemetaan role/file/perintah, translator (streaming, tool, subagent, token), markdown & keamanan HTML, git panel, mirror CLI & riwayat sesi dengan transcript palsu, parsing `/usage`, ledger token per akun, ringkasan & PDF laporan, perintah buka VS Code/folder per OS, ikon app sesuai generator |
| Integrasi (`test/server.test.mjs`) | Server dijalankan dengan `test-support/fake-claude.mjs` yang meniru protokol stream-json: keamanan API (token, Origin, Host, path, anti-iframe, CSP), HP lewat WiFi hanya-lihat, pairing (lockout, putus saat dicabut), tolak folder UNC, prompt + streaming, izin (izinkan/tolak), stop/interrupt, validasi pengaturan, demo, profil & kuota akun, laporan yang tidak mencampur akun, favorit, buka VS Code (dry-run), manifest PWA tanpa pairing |
| Backup (`test/zip.test.mjs`, `test/backup.test.mjs`) | ZIP round-trip (kosong, UTF-8, ribuan file, beberapa MB, ZIP64), CRC salah, zip-slip/symlink/nama device ditolak, dibuka `Expand-Archive` (Windows). Dua server dengan home berbeda: export → import, folder di-remap, aturan merge, usage & riwayat prompt digabung, sesi muncul di API, import ulang idempoten, 413, tanpa token/HP ditolak |
| Kontrak (`test-support/claude-contract.mjs`) | 15 cek terhadap Claude Code asli: `init`, streaming, `can_use_tool`, allow/deny, interrupt, `--agents`, format transcript yang dipakai mirror |

**Setelah meng-update Claude Code, jalankan `npm run test:claude`.** Aplikasi ini bergantung pada protokol internal CLI, dan test ini yang pertama memberi tahu kalau ada yang berubah. Test offline juga jalan otomatis di GitHub Actions (Windows dan Linux) setiap kali push.

Semua test memakai folder sementara (`OFFICE_DATA_DIR`, `CLAUDE_PROJECTS_DIR`, `CLAUDE_CONFIG_FILE`), jadi tidak menyentuh riwayat chat atau transcript aslimu.

## Struktur

```
server.js            HTTP + SSE + API
src/session.js       proses headless Claude Code per project, lewat control protocol-nya:
                     antrean, izin, ganti mode/model/effort langsung, rewind, MCP, tugas latar
src/mirror.js        tail transcript sesi CLI (read-only) → kantor & chat
src/translator.js    stream-json → event kantor + pesan chat + status (todo, konteks, tugas, judul)
src/transcripts.js   riwayat sesi, history untuk resume, rantai prompt untuk rewind
src/hub.js           state, SSE broadcast, persistensi
src/projects.js      penemuan folder project
src/roles.js         pemetaan agent/tool → role, label, isi layar
src/demo.js          skenario demo
src/account.js       profil akun, kuota (/usage), login/logout lewat CLI
src/usage.js         ledger token per akun (data/usage.jsonl) + ringkasan
src/report.js        HTML laporan + PDF via Edge/Chrome headless
src/open.js          buka project/file di VS Code atau file manager (tanpa shell)
src/backup.js        export/import riwayat (⚙ → Cadangkan riwayat): isi backup, remap folder, aturan merge
src/backup-schedule.js  ⏰ backup otomatis terjadwal: validasi folder, jadwal, tulis atomik, rotasi
src/queue.js         📋 antrian prompt per project: simpan, urutan, jalankan saat sesi idle, jeda otomatis
src/zip.js           ZIP writer/reader tanpa dependency (deflate streaming, CRC-32, ZIP64, cek nama aman)
public/js/app.js     entry point UI (ES module native, tanpa build): menyambungkan semua fitur sesuai urutan
public/js/core/      $/escapeHtml, state global, api() + toast, format, stream SSE, scene kantor
public/js/ui/        dialog (fokus, Tab trap), shortcut global, layout (tab, nav HP, panel resizable)
public/js/features/  satu module per fitur: chat, composer, izin, tim, sesi, rewind, perubahan, akun, laporan, MCP, tugas, HP, …
public/js/office/    renderer pixel-art (sprite, dunia, scene, stage)
public/icons/        ikon app (PWA, favicon) — dibuat oleh scripts/make-icons.mjs
public/manifest.webmanifest   manifest PWA (Add to Home Screen)
.claude/agents/      definisi subagent per role
```

Env opsional: `OFFICE_PORT` (default 4317), `PROJECTS_ROOT` (default folder induk app ini), `CLAUDE_BIN` (path `claude` jika tidak terdeteksi), `OFFICE_BROWSER` (path Edge/Chrome untuk PDF laporan), `OFFICE_EDITOR` (path editor selain VS Code, misalnya Cursor), `OFFICE_BACKUP_MAX_BYTES` (batas upload import riwayat, default 4 GB).

Ikon diubah lewat sprite 16×16 di `scripts/make-icons.mjs`, lalu jalankan `node scripts/make-icons.mjs`. Test akan gagal kalau ikon yang di-commit tidak sesuai generator.
