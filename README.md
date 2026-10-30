# Claude Coworking

Kantor pixel-art untuk **mengoperasikan Claude Code dari browser**. Pilih project, ketik prompt, setujui izin. Tim IT berisi 12 orang terlihat bekerja di kantor secara real-time. CLI tidak perlu dibuka, tapi sesi yang kamu jalankan di CLI juga ikut tampil.

```
Browser ──HTTP/SSE──▶ server.js ──stdin/stdout (stream-json)──▶ claude.exe -p   (sesi dari web, satu proses per project)
                         ▲
                         └── membaca ~/.claude/projects/*.jsonl  (sesi dari CLI, read-only, real-time)
```

Server menjalankan Claude Code milikmu sendiri dalam mode headless, jadi login, settings, MCP, dan `CLAUDE.md` tiap project tetap terpakai. Tidak perlu API key dan tidak ada dependency npm. Cukup Node.js ≥ 20.

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

Nama dan tampilan bisa diubah di `public/js/office/cast.js`.

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

Di HP kamu bisa memakai semuanya: chat, kartu izin, panel perubahan, dan melihat kantor. Pengaturan sensitif (folder projects, auto-start, matikan server, akses HP) hanya bisa diubah dari laptop.

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
3. Double-click **`setup.cmd`**. Script ini memeriksa Node.js dan Claude Code, memasang auto-start, menyalakan server di latar belakang, lalu membuka browser.
4. Di web, klik **⚙** dan atur folder projects device itu, lalu klik 🔔 untuk notifikasi.

Setelah itu server selalu menyala sendiri setiap Windows login. Untuk melepas auto-start, jalankan `uninstall-autostart.cmd`.

> Kalau folder repo dipindah atau versi Node.js diganti (misalnya lewat nvm), jalankan `setup.cmd` lagi, karena lokasi keduanya tercatat di script auto-start.

## Menjalankan

Double-click **`start-office.cmd`** (otomatis membuka browser), atau:

```bash
npm run open    # http://localhost:4317
```

Tutup jendela server (atau tekan Ctrl+C) untuk berhenti. Semua proses Claude Code ikut ditutup.

**Nyala otomatis saat Windows login:** buka **⚙** di sidebar, lalu centang *Nyalakan otomatis saat Windows login*. Server berjalan tanpa jendela (log di `data/server.log`), jadi kamu cukup membuka `http://localhost:4317`. Untuk mematikannya, pakai tombol **⏻ Matikan server** di panel yang sama. Mencentang ini membuat file `claude-coworking.vbs` di folder Startup Windows, dan menghapus centang akan menghapus file itu.

## Cara pakai

| Bagian | Fungsi |
|---|---|
| **Sidebar** | Daftar project: folder yang pernah dibuka Claude Code di device ini (✳) + semua subfolder dari **folder induk** yang kamu atur lewat **⚙**. Satu folder lepas bisa ditambah lewat kolom di bawah. |
| **⚙ Folder projects** | Atur satu atau lebih folder induk (satu per baris). Disimpan per device di `data/state.json`. Kalau belum diatur, dipakai folder tempat `agent-place` berada (atau env `PROJECTS_ROOT`). |
| **Chat** | Prompt ke Claude Code di folder project itu. Saat tim bekerja, pesan baru masuk antrean. |
| **Kartu izin** | Muncul setiap kali Claude butuh izin: **Izinkan**, **Izinkan selalu** (simpan aturan), **Izinkan semua (sesi ini)**, atau **Tolak**. Pertanyaan (`AskUserQuestion`) dan rencana (mode *Rencana dulu*) juga dijawab di sini. |
| **Mode izin** | 🛡 Tanya dulu (default) · ✏️ Auto-edit file · ⚡ Auto · 📋 Rencana dulu |
| **Model** | Default dari settings Claude Code, atau Opus / Sonnet / Haiku |
| **Mode tim** | Claude mendelegasikan ke 11 subagent di atas. Visualnya lebih hidup, tapi **lebih banyak token**. Matikan untuk Claude Code biasa. |
| **■ Stop** / `Esc` | Menghentikan giliran yang sedang berjalan. Sesi tetap bisa dilanjutkan. |
| **↺ Sesi baru** | Mulai percakapan baru (Claude lupa konteks sebelumnya). |
| **🕘 Riwayat sesi** | Lanjutkan sesi Claude Code lama di project itu, baik dari CLI maupun web. Percakapan terakhirnya dimuat ke chat. |
| **`/` command** | Autocomplete slash command, skill, dan custom command yang dilaporkan Claude Code (`/context`, `/compact`, `/code-review`, …). |
| **`@file`** | Autocomplete path file di project. |
| **📎 Gambar** | Lampirkan gambar (paste, drag & drop, atau 📎). PNG/JPEG/GIF/WebP, maks 5 gambar × 5 MB. |
| **🔔 Notifikasi** | Klik 🔔 di header untuk mengaktifkan. Notifikasi Windows dan suara muncul saat ada yang **minta izin**, tugas **selesai**, atau **berhenti/error**, selama kamu sedang di tab/aplikasi lain atau di project lain. Klik notifikasinya untuk langsung ke project itu. |
| **Tab Perubahan** | `git status` dan diff per file yang belum di-commit (diperbarui otomatis setelah tim mengedit), tombol **🔍 Minta review** (Arif me-review semua perubahan), dan **Commit** (`git add -A` + commit, dengan konfirmasi). |
| **Detail tool** | Klik baris tool untuk melihat perintah, diff edit (`-`/`+`), dan output. Klik baris delegasi untuk melihat instruksi dan laporan subagent. |

Balasan Claude tampil streaming per kata, code block diberi syntax highlighting, dan setiap giliran ditutup dengan durasi, jumlah langkah, ukuran konteks, dan token output.
| **🎬 Demo kantor** | Simulasi tanpa Claude Code, termasuk satu kartu izin. |

Percakapan berlanjut antar prompt (`--resume`). Riwayat chat dan pengaturan per project disimpan di `data/state.json`.

## Kantor

- **Ruang boss** berdinding kaca untuk Adhitya (Engineering Lead): meja eksekutif, kursi kulit, kursi tamu, dan TV grafik aktivitas. Boss duduk menghadap pintu, tamu (prompt) datang ke depan mejanya, dan boss keluar ruangan untuk mendelegasikan.
- 11 meja staf dalam 3 baris (Produk & Desain, Engineering, Kualitas & Ops), meja meeting bundar, pantry, sofa, dan rak server di samping DevOps.
- Tiap tool call menggerakkan karakter yang sesuai. Layar monitornya menunjukkan jenis kerja: kode, terminal, test, dokumen, desain, pencarian, browser, kanban, tabel database, pipeline CI/CD, security scan, diff review.
- Delegasi: Claude berjalan ke meja anggota tim. Minta izin: anggota tim berdiri dan angkat tangan. Error: layar merah dan asap. Selesai: confetti.
- Whiteboard menampilkan todo list Claude, atau daftar delegasi.
- Saat idle, tim ngopi, duduk di sofa, ngobrol, atau cek server. Jendela dan lampu mengikuti jam lokal. Ada kucing kantor.

## Keamanan

- Server hanya listen di `127.0.0.1`, memeriksa header `Host`/`Origin`, dan semua API butuh token acak per start (disisipkan ke halaman). Situs lain tidak bisa menyuruh server menjalankan Claude Code.
- Izin tetap mengikuti aturan Claude Code. Mode default selalu bertanya sebelum menulis file atau menjalankan perintah.

## Test

```bash
npm test             # ±8 detik, offline: unit + server sungguhan dengan Claude Code palsu
npm run test:claude  # uji kontrak ke Claude Code asli (beberapa request Haiku)
```

| Lapis | Isi |
|---|---|
| Unit (`test/*.test.mjs`) | Pemetaan role/file/perintah, translator (streaming, tool, subagent, token), markdown & keamanan HTML, git panel, mirror CLI & riwayat sesi dengan transcript palsu |
| Integrasi (`test/server.test.mjs`) | Server dijalankan dengan `test-support/fake-claude.mjs` yang meniru protokol stream-json: keamanan API (token, Origin, Host, path), prompt + streaming, izin (izinkan/tolak), stop/interrupt, validasi pengaturan, demo |
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
public/js/app.js     UI: sidebar, chat, kartu izin, panel tim
public/js/office/    renderer pixel-art (sprite, dunia, scene, stage)
.claude/agents/      definisi subagent per role
```

Env opsional: `OFFICE_PORT` (default 4317), `PROJECTS_ROOT` (default folder induk app ini), `CLAUDE_BIN` (path `claude` jika tidak terdeteksi).
