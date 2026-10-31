# Adhit Office

Kantor pixel-art untuk **mengoperasikan Claude Code dari browser dan HP**. Pilih project, ketik prompt, setujui izin. Tim IT berisi 12 orang terlihat bekerja di kantor secara real-time. CLI tidak perlu dibuka, tapi sesi yang kamu jalankan di CLI juga ikut tampil.

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
| Adhitya | Engineering Lead (Claude) | Orkestrasi: memecah pekerjaan dan mendelegasikan |
| Jepri | Product Manager | Scope, prioritas, acceptance criteria, severity bug |
| Ebi | Business Analyst | Kebutuhan, aturan bisnis, analisis kode/dokumen |
| Arif | Tech Lead / Architect | Desain teknis, keputusan arsitektur, **code review** |
| Ananda | UI/UX Designer | Alur pengguna, styling, aksesibilitas |
| Putri | Frontend Developer | Komponen, halaman, state, bug di sisi client |
| William | Backend Developer | API, logika bisnis, integrasi, bug di sisi server |
| Jaka | Database Engineer | Skema, migrasi, query, perbaikan data |
| Rizka | QA Engineer | Reproduksi bug, test otomatis, regresi, verifikasi |
| Reza | Security Engineer | Review OWASP, secret, audit dependensi |
| Doni | DevOps / SRE | Build, CI/CD, Docker, environment, deploy |
| Syifa | Technical Writer | README, dokumentasi API, changelog |

**Ganti nama anggota tim:** klik kartu orangnya di bawah kantor (atau ⚙ → *Ganti nama anggota tim*), isi nama baru, lalu **Simpan**. Nama yang kosong kembali ke nama bawaan. Nama baru langsung tampil di kantor, chat, dan aktivitas, dan tersimpan di server (`data/state.json`), jadi sama di laptop dan HP. Peran dan sifat kerja tiap role tidak berubah, hanya namanya. Tampilan (rambut, baju, warna) diatur di `public/js/office/cast.js`.

Definisinya ada di `.claude/agents/*.md` (bisa diedit). Dengan **Mode tim** aktif, agent ini diinjeksi ke project mana pun lewat `--agents`, dan Claude diberi alur kerja:

- **Fitur baru**: PM → BA → Architect → UI/UX → Frontend/Backend/DB → QA → Security (jika menyentuh auth/input/data) → Writer
- **Bug fix**: QA mereproduksi (failing test) → developer pemilik memperbaiki akar masalah → Architect review diff → QA verifikasi
- **Build/deploy/insiden**: DevOps → Backend/DB → QA

Claude hanya memanggil role yang relevan. Tugas kecil dikerjakan langsung tanpa delegasi. Tanpa Mode tim (atau untuk sesi CLI biasa), tiap aksi tetap dibagi ke orang yang paling cocok menurut jenis file/perintahnya: `.tsx` ke Putri, migrasi ke Jaka, `npm test` ke Rizka, `docker` ke Doni, `git diff` ke Arif, dan seterusnya.

## Buka dari HP

1. Di laptop, klik **📱** di header, lalu centang **Izinkan akses dari HP**.
2. Sambungkan HP ke **WiFi yang sama** dengan laptop.
3. Scan QR dengan kamera HP. Atau buka alamat yang tertera (mis. `http://192.168.1.10:4317`) lalu masukkan **kode 6 digit**.
4. Selesai. HP diingat, jadi lain kali cukup buka alamat itu lagi.
5. Opsional: pilih **Add to Home Screen** / **Tambahkan ke Layar Utama** di menu browser. Adhit Office muncul dengan ikonnya sendiri dan terbuka seperti aplikasi. Di iPhone, aplikasi dari layar utama punya penyimpanan terpisah dari Safari, jadi masukkan kode pairing sekali lagi di sana.

Di HP kamu bisa memakai semuanya: chat, kartu izin, panel perubahan, dan melihat kantor. Pengaturan sensitif (folder projects, auto-start, matikan server, akses HP) hanya bisa diubah dari laptop. Login/logout akun Claude bisa dari HP, tapi hanya lewat Tailscale.

**Keamanan:**
- Mati secara default. Saat dimatikan, server hanya mendengarkan `127.0.0.1`.
- Saat dinyalakan, server juga mendengarkan alamat LAN laptop (bukan `0.0.0.0`).
- Perangkat baru wajib pairing dengan kode dari layar laptop. Kode berlaku 2 menit, sekali pakai, dan diganti setelah 5 kali salah.
- HP yang terpasang menyimpan token acak di cookie `HttpOnly`. Server hanya menyimpan hash-nya.
- Perangkat bisa dicabut kapan saja di jendela 📱.
- Koneksinya HTTP biasa (tanpa enkripsi), jadi **pakai hanya di WiFi yang kamu percaya** (rumah/kantor), bukan WiFi publik.
- Saat pertama kali dinyalakan, Windows bisa menanyakan izin firewall untuk Node.js. Pilih **Allow** untuk jaringan *Private*.

### Dari luar rumah (beda jaringan) dengan Tailscale

Supaya bisa membuka kantor dari mana saja (data seluler, WiFi kantor, dll.) **tanpa membuka laptop ke internet publik**:

1. Pasang **Tailscale** di laptop (`tailscale.com/download`), lalu login.
2. Pasang aplikasi **Tailscale** di HP, lalu login dengan akun yang sama.
3. Di laptop, buka **📱**. Muncul pilihan **🌐 Dari mana saja (Tailscale)**. Pilih itu, lalu scan QR-nya dari HP.

Tailscale membuat jaringan pribadi terenkripsi (WireGuard) yang hanya berisi perangkatmu sendiri. Aplikasi ini otomatis mengenali alamat Tailscale (`100.64.0.0/10`) dan mendengarkannya saat akses HP aktif, tanpa pengaturan tambahan. Alamat WiFi dan Tailscale dipasangkan terpisah, jadi HP perlu scan sekali untuk masing-masing.

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

## Menjalankan

Double-click **`start-office.cmd`** (otomatis membuka browser), atau:

```bash
npm run open    # http://localhost:4317
```

Tutup jendela server (atau tekan Ctrl+C) untuk berhenti. Semua proses Claude Code ikut ditutup.

**Nyala otomatis saat Windows login:** buka **⚙** di header, lalu centang *Nyalakan otomatis saat Windows login*. Server berjalan tanpa jendela (log di `data/server.log`), jadi kamu cukup membuka `http://localhost:4317`. Untuk mematikannya, pakai tombol **⏻ Matikan server** di panel yang sama. Mencentang ini membuat file `claude-coworking.vbs` di folder Startup Windows, dan menghapus centang akan menghapus file itu.

## Cara pakai

| Bagian | Fungsi |
|---|---|
| **Pilih project** (`Ctrl+K`) | Klik nama project di header. Dialog berisi folder yang pernah dibuka Claude Code di device ini (✳) dan semua subfolder dari **folder induk** yang kamu atur lewat **⚙**. Bisa dicari, dipilih dengan ↑↓ + Enter, dan ditambah satu folder lepas lewat kolom di bawah. Klik **☆** untuk menjadikan favorit: project favorit selalu di atas (tersimpan di server, sama di laptop dan HP), disusul project yang sedang bekerja atau minta izin. Tombol project juga menampilkan jumlah izin yang menunggu di project lain. |
| **👤 Akun** | Profil akun Claude yang sedang login, kuota paket, pemakaian token hari ini/7 hari, serta **Ganti akun** / **Logout**. Lihat [Akun Claude & laporan token](#akun-claude--laporan-token). |
| **📊 Laporan** | Laporan pemakaian token per akun (input, output, cache read/write, cache hit, request, estimasi biaya) yang bisa diunduh sebagai PDF. |
| **⚙ Folder projects** | Atur satu atau lebih folder induk (satu per baris). Disimpan per device di `data/state.json`. Kalau belum diatur, dipakai folder tempat `agent-place` berada (atau env `PROJECTS_ROOT`). |
| **Chat** | Prompt ke Claude Code di folder project itu. Saat tim bekerja, pesan baru masuk antrean. |
| **Kartu izin** | Muncul setiap kali Claude butuh izin: **Izinkan**, **Izinkan selalu** (simpan aturan), **Izinkan semua (sesi ini)**, atau **Tolak**. Pertanyaan (`AskUserQuestion`) dan rencana (mode *Rencana dulu*) juga dijawab di sini. |
| **Izin** | 🛡️ Tanya dulu (default) · ✏️ Auto-edit file · ⚡ Auto · 📋 Rencana dulu |
| **Model** | Default dari settings Claude Code, atau Opus / Sonnet / Haiku |
| **Effort** | Seberapa dalam Claude berpikir (`--effort`): Default (dari settings Claude Code), Low, Medium, High, X-High, Max. Lebih tinggi lebih teliti untuk tugas sulit, tapi lebih lambat dan lebih banyak token. Berlaku per project; mengganti effort memulai ulang proses Claude dan percakapan tetap berlanjut. |
| **Mode tim** | Claude mendelegasikan ke 11 subagent di atas. Visualnya lebih hidup, tapi **lebih banyak token**. Matikan untuk Claude Code biasa. |
| **■ Stop** / `Esc` | Muncul di sebelah **Kirim** saat tim bekerja. Menghentikan giliran yang sedang berjalan, dan sesi tetap bisa dilanjutkan. |
| **Bar sesi** | Baris di atas chat yang menunjukkan percakapan Claude Code yang sedang dipakai: judul, asal (web atau lanjutan sesi terminal), dan model. |
| **＋ Sesi baru** | Mulai percakapan baru. Claude tidak membawa konteks sebelumnya, tapi percakapan lama tetap ada di riwayat. |
| **🕘 Riwayat sesi** | Dialog berisi sesi Claude Code di project itu, dari terminal maupun web. Sesi dikelompokkan per hari dan bisa dicari. Klik **Lanjutkan** untuk memuat percakapan terakhirnya ke chat, dan Claude melanjutkan dengan konteks yang sama. |
| **⋯ Lainnya** | Menu di bar sesi: **Export percakapan** ke Markdown, **Salin perintah lanjut di terminal** (`cd` ke project + `claude --resume <id>`), serta **Buka project di VS Code** dan **Buka folder project** (khusus laptop). |
| **Salin · Edit · ↻ Ulangi** | Arahkan kursor ke pesan (di HP selalu tampil). Jawaban dan code block bisa disalin. Prompt bisa disalin, diedit ulang di kotak pesan, atau dikirim lagi (**Ulangi** hanya ada di prompt web terakhir). |
| **↑ / ↓** | Di kotak pesan, panggil lagi prompt sebelumnya di project itu, seperti di CLI. Draft yang sedang diketik kembali setelah prompt terbaru. |
| **❓ Bantuan** / `?` | Panduan singkat, penjelasan mode izin, dan daftar shortcut keyboard. |
| **`/` command** | Autocomplete slash command, skill, dan custom command yang dilaporkan Claude Code (`/context`, `/compact`, `/code-review`, …). |
| **`@file`** | Autocomplete path file di project. |
| **📎 Gambar** | Lampirkan gambar (paste, drag & drop, atau 📎). PNG/JPEG/GIF/WebP, maks 5 gambar × 5 MB. |
| **🔔 Notifikasi** | Klik 🔔 di header untuk mengaktifkan. Notifikasi Windows dan suara muncul saat ada yang **minta izin**, tugas **selesai**, atau **berhenti/error**, selama kamu sedang di tab/aplikasi lain atau di project lain. Klik notifikasinya untuk langsung ke project itu. |
| **Tab Perubahan** | `git status` dan diff per file yang belum di-commit (diperbarui otomatis setelah tim mengedit), tombol **🔍 Minta review** (Arif me-review semua perubahan), **🧭 VS Code** (membuka file yang dipilih di VS Code, khusus laptop), dan **Commit** (`git add -A` + commit, dengan konfirmasi). |
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

**📊 Laporan** membuat PDF pemakaian token untuk **satu akun** dan satu periode (hari ini, 7/30 hari, bulan ini, semua, atau tanggal pilihan): ringkasan KPI, grafik harian, rincian per model, project, sumber (web/CLI), sesi teratas, dan kuota paket. Setiap catatan token disimpan bersama akun yang sedang login saat token itu dipakai (`data/usage.jsonl`), jadi pemakaian dua akun tidak pernah tercampur.

- Data mulai terkumpul **sejak fitur ini aktif**. Transcript lama Claude Code tidak mencatat akun, jadi sengaja tidak dihitung.
- Sesi dari web dan dari CLI (lewat mirror) sama-sama tercatat. Transcript CLI tidak menyimpan akun, jadi token CLI dicatat ke akun yang sedang login. Setelah ganti akun, tutup lalu buka lagi sesi CLI yang masih terbuka agar catatannya tetap akurat. Estimasi biaya (USD, harga list) hanya tersedia untuk sesi web. Untuk paket Pro/Max/Team yang membatasi adalah kuota, bukan biaya.
- PDF dibuat oleh Edge/Chrome dalam mode headless dengan profil sementara. Kalau tidak ada keduanya, laporan dibuka di tab baru untuk dicetak ke PDF dari browser.

## Kantor

- **Ruang boss** berdinding kaca untuk Adhitya (Engineering Lead): meja eksekutif, kursi kulit, kursi tamu, dan TV grafik aktivitas. Boss duduk menghadap pintu, tamu (prompt) datang ke depan mejanya, dan boss keluar ruangan untuk mendelegasikan.
- 11 meja staf dalam 3 baris (Produk & Desain, Engineering, Kualitas & Ops), meja meeting bundar, pantry, sofa, dan rak server di samping DevOps.
- Tiap tool call menggerakkan karakter yang sesuai. Layar monitornya menunjukkan jenis kerja: kode, terminal, test, dokumen, desain, pencarian, browser, kanban, tabel database, pipeline CI/CD, security scan, diff review.
- Delegasi: Claude berjalan ke meja anggota tim. Minta izin: anggota tim berdiri dan angkat tangan. Error: layar merah dan asap. Selesai: confetti.
- Whiteboard menampilkan todo list Claude, atau daftar delegasi.
- Saat idle, tim ngopi, duduk di sofa, ngobrol, atau cek server. Jendela dan lampu mengikuti jam lokal. Ada kucing kantor.

## Keamanan

- Server hanya listen di `127.0.0.1`, memeriksa header `Host`/`Origin`, dan semua API butuh token acak per start (disisipkan ke halaman). Situs lain tidak bisa menyuruh server menjalankan Claude Code.
- Situs lain tidak bisa memuat kantor di dalam iframe (`frame-ancestors 'self'`, `X-Frame-Options`), sehingga tombol seperti **Izinkan** tidak bisa dipancing lewat clickjacking.
- Izin tetap mengikuti aturan Claude Code. Mode default selalu bertanya sebelum menulis file atau menjalankan perintah.
- Login/logout akun hanya dari laptop atau dari HP lewat Tailscale (ditolak lewat WiFi biasa), dengan peringatan ke laptop. Server tidak pernah membaca token login (`.credentials.json`); profil diambil dari `claude auth status` dan data profil di `~/.claude.json`.
- **Buka di VS Code / folder** hanya bisa dari laptop, hanya untuk folder project yang terdaftar (file harus berada di dalam project), dan dijalankan tanpa shell. Path dikirim sebagai argumen biasa, tidak pernah ditafsirkan sebagai perintah.
- Ikon dan manifest PWA bisa diambil tanpa pairing karena tidak berisi data. Selain itu semuanya tetap butuh pairing.

## Test

```bash
npm test             # ±8 detik, offline: unit + server sungguhan dengan Claude Code palsu
npm run test:claude  # uji kontrak ke Claude Code asli (beberapa request Haiku)
```

| Lapis | Isi |
|---|---|
| Unit (`test/*.test.mjs`) | Pemetaan role/file/perintah, translator (streaming, tool, subagent, token), markdown & keamanan HTML, git panel, mirror CLI & riwayat sesi dengan transcript palsu, parsing `/usage`, ledger token per akun, ringkasan & PDF laporan, perintah buka VS Code/folder per OS, ikon app sesuai generator |
| Integrasi (`test/server.test.mjs`) | Server dijalankan dengan `test-support/fake-claude.mjs` yang meniru protokol stream-json: keamanan API (token, Origin, Host, path, anti-iframe), prompt + streaming, izin (izinkan/tolak), stop/interrupt, validasi pengaturan, demo, profil & kuota akun, laporan yang tidak mencampur akun, favorit, buka VS Code (dry-run), manifest PWA tanpa pairing |
| Kontrak (`test-support/claude-contract.mjs`) | 15 cek terhadap Claude Code asli: `init`, streaming, `can_use_tool`, allow/deny, interrupt, `--agents`, format transcript yang dipakai mirror |

**Setelah meng-update Claude Code, jalankan `npm run test:claude`.** Aplikasi ini bergantung pada protokol internal CLI, dan test ini yang pertama memberi tahu kalau ada yang berubah. Test offline juga jalan otomatis di GitHub Actions (Windows dan Linux) setiap kali push.

Semua test memakai folder sementara (`OFFICE_DATA_DIR`, `CLAUDE_PROJECTS_DIR`, `CLAUDE_CONFIG_FILE`), jadi tidak menyentuh riwayat chat atau transcript aslimu.

## Struktur

```
server.js            HTTP + SSE + API
src/session.js       proses headless Claude Code per project, antrean, izin, stop
src/mirror.js        tail transcript sesi CLI (read-only) → kantor & chat
src/translator.js    stream-json → event kantor + pesan chat
src/hub.js           state, SSE broadcast, persistensi
src/projects.js      penemuan folder project
src/roles.js         pemetaan agent/tool → role, label, isi layar
src/demo.js          skenario demo
src/account.js       profil akun, kuota (/usage), login/logout lewat CLI
src/usage.js         ledger token per akun (data/usage.jsonl) + ringkasan
src/report.js        HTML laporan + PDF via Edge/Chrome headless
src/open.js          buka project/file di VS Code atau file manager (tanpa shell)
public/js/app.js     UI: pemilih project, chat, kartu izin, akun, laporan, bantuan, panel tim
public/js/office/    renderer pixel-art (sprite, dunia, scene, stage)
public/icons/        ikon app (PWA, favicon) — dibuat oleh scripts/make-icons.mjs
public/manifest.webmanifest   manifest PWA (Add to Home Screen)
.claude/agents/      definisi subagent per role
```

Env opsional: `OFFICE_PORT` (default 4317), `PROJECTS_ROOT` (default folder induk app ini), `CLAUDE_BIN` (path `claude` jika tidak terdeteksi), `OFFICE_BROWSER` (path Edge/Chrome untuk PDF laporan), `OFFICE_EDITOR` (path editor selain VS Code, misalnya Cursor).

Ikon diubah lewat sprite 16×16 di `scripts/make-icons.mjs`, lalu jalankan `node scripts/make-icons.mjs`. Test akan gagal kalau ikon yang di-commit tidak sesuai generator.
