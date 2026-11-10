# Changelog

Perubahan yang terasa oleh pengguna. Detail fitur ada di [README](README.md); panduan harian di [docs/PANDUAN.md](docs/PANDUAN.md).

## 1.0.12

- **🧰 Persiapan: pasang dari aplikasi, tanpa terminal.** Di **⚙ → Sistem → Persiapan** (dan otomatis sekali saat instalasi baru belum punya project) ada status **Node.js, Claude Code, OpenCode, dan Tailscale** dengan tombol **Pasang**, progres yang bisa dibatalkan, serta **Buka terminal login** untuk `claude`/`opencode auth login`. Semua instalasi meminta konfirmasi dan hanya dari laptop/Tailscale.
- **Tanpa Node.js pun bisa.** `setup.cmd` kini membawa bootstrap: jika Node belum ada, ia menawarkan **Node.js LTS resmi** yang diunduh ke **runtime milik Adhitron** (±30 MB, SHA-256 diperiksa, tanpa admin, tanpa mengubah PATH sistem). Claude Code dipasang ke prefix lokal yang sama; OpenCode opsional. Installer `.exe`/Electron memakai wizard yang sama, jadi tidak lagi “prasyarat sudah terpasang”.
- **Login tetap aman.** Kredensial tidak diotomasi dan tidak pernah disimpan aplikasi: terminal dibuka dengan PATH runtime, lalu status diperiksa ulang. Tailscale tetap opsional (winget) dan HP tetap perlu aplikasi Tailscale sendiri.

## 1.0.11

- **🔄 Mesin mengikuti model, tanpa aksi ganti mesin.** Tombol **🔀 Mesin project** dan `POST /api/projects/:id/engine` dihapus. Pilih model di **Pengaturan giliran** dan project memakai mesin model itu untuk giliran berikutnya; model mesin lain ditolak **409** selama project bekerja, ada izin/rencana menunggu, antrean berisi item, giliran terputus, atau rewind.
- **📋 Satu daftar model.** Pemilih model kini berisi grup **Claude Code** dan **OpenCode** dalam satu pilihan. Chip pengaturan giliran tidak lagi menampilkan badge mesin, dan badge mesin di daftar project dihapus (mesin tetap terlihat di bar sesi).
- **🌉 Konteks pindah otomatis.** Saat mesin berganti, ringkasan percakapan mesin sebelumnya dari chat tersimpan disuntik otomatis ke sesi baru—tanpa panggilan model dan tanpa token. Ringkasan itu **dikirim ke provider mesin baru** sebagai bagian prompt berikutnya; rahasia yang dikenali polanya (token, `KEY=value`, URL ber-kredensial, private key) disamarkan menjadi `***`, dan catatan ringkasannya hanya ada di memori serta dipakai sekali. Chat menulis satu baris `🔁 Ringkasan konteks dari … dikirim ke … (N pesan)` dan status **🧠 Konteks siap** muncul sampai pesan berikutnya. Maks 30 pesan dipadatkan + 8 langkah tool terakhir; ini **ringkasan, bukan replika percakapan**.
- **🧵 Riwayat satu alur.** Chat menampilkan timeline gabungan kedua mesin dan tiap pesan membawa mesin asalnya; badge halus hanya muncul saat mesin berubah. Penulisan tetap terpisah di `data/chats` dan `data/chats-opencode`, jadi kembali ke mesin lama melanjutkan sesi aslinya. Rewind/redo tetap per mesin dan kuota kedua mesin tetap terpisah.
- **🐞 Perbaikan saat pindah mesin.** Riwayat chat tidak lagi bisa saling menimpa saat file salah satu mesin dikompaksi; peringatan "provider logout" milik mesin lama dibersihkan; dan redo percakapan lintas mesin ditolak dengan alasan yang jelas (bukan menulis ke sesi mesin yang salah).
- **🗑 Handoff manual dihapus.** Dialog **🔁 Lanjutkan dari mesin lain** beserta route `/handoff/info`, `/handoff`, `/handoff/apply`, dan `/handoff/context` sudah tidak ada (404). Antrean perpindahan mesin (`enginePending`/`engineQueue`) juga dihapus.
- **👤 Akun: dua tab info.** Dialog Akun hanya menampilkan tab **Claude** (paket, kuota, pemakaian) dan **OpenCode** (provider, login, pemakaian); tab tidak memindahkan project. Aksi **Jadikan mesin bawaan** dihapus.
- **📦 Tidak perlu migrasi.** `settings[id].engine`, `engineSettings`, dan `sessionsByEngine` dibaca seperti sebelumnya; backup lama tetap bisa diimpor. Yang hilang hanya route handoff dan route switch mesin.

## 1.0.10

- **🏷️ Nama baru: Adhitron.** Nama tampilan aplikasi berubah dari *Adhit Office* menjadi **Adhitron** di judul halaman, PWA, notifikasi, laporan, dan pesan terminal. Logo dan ikon ikut diperbarui (favicon, ikon PWA, ikon installer dan aplikasi desktop). Fitur dan perilakunya tidak berubah.
- **👥 Nama role bawaan ikut berganti.** Default di 👥 Kelola tim menjadi `Adhitron - Lead`, `Adhitron - PM`, `Adhitron - BA`, dan seterusnya untuk 18 role (Lead, PM, BA, Tech Lead, UI/UX, Frontend, Backend, DBA, QA, Security, DevOps, Writer, Freelancer, Mobile, Data/AI, Support, Reviewer, Compliance). Nama yang sudah kamu ubah sendiri tetap dipakai; **↺ Tim bawaan** mengembalikannya ke nama baru.
- **📦 EXE, installer, dan aplikasi desktop berganti nama.** Build Windows menghasilkan `Adhitron.exe` di `dist\Adhitron` dengan installer `Adhitron-Setup-<versi>.exe`; aplikasi desktop menjadi **Adhitron Desktop** (`AdhitronDesktop.exe`); Linux memakai `Adhitron`/`adhitron_<versi>_amd64.deb`, macOS memakai `Adhitron.app`. Installer memakai AppId yang sama, jadi pemasangan 1.0.9 ditingkatkan di tempat tanpa uninstall.
- **💾 Data, env, dan auto-start lama tetap dipakai.** Folder data (`%LOCALAPPDATA%\AdhitOffice`, `~/Library/Application Support/AdhitOffice`, `~/.local/share/adhit-office`), env `OFFICE_*`, nama backup `adhit-office-backup*.zip`, repo `claude-coworking`, serta `claude-coworking.vbs`, task `Claude Coworking`, dan rule firewall `Claude Coworking (Tailscale)` tidak berubah. Tidak ada migrasi data: setelah update, riwayat, pengaturan, pairing HP, dan auto-start langsung terpakai. Jangan memindahkan folder data ke nama baru.
- **⬆ Update dari versi lama tetap satu jalur.** Rilis transisi menerbitkan installer yang sama dengan dua nama: `Adhitron-Setup-*.exe` dan `AdhitOffice-Setup-*.exe`. Versi 1.0.9 hanya mencari nama lama, sedangkan versi baru membaca nama Adhitron lebih dulu dan memakai nama lama sebagai cadangan.

## 1.0.9

- **📋 Pencarian & filter antrian.** Dialog antrian punya pencarian teks dan filter status (Menunggu/Berjalan/Selesai/Gagal); item yang tidak cocok disembunyikan dengan empty state yang jelas.
- **🧪 Test browser mingguan + pembersihan draft rilis.** Alur chat/HP/dialog diuji di Chrome headless setiap Sabtu di CI (file yang gagal diulang sekali dan dilaporkan flaky). Draft rilis yang terbengkalai lebih dari 14 hari dihapus otomatis beserta tag-nya.
- **🛡️ Smoke integrasi di setiap PR.** Selain cek sintaks, ESLint, dan `test:fast`, CI kini menjalankan `npm run test:smoke`: server sungguhan, izin, antrian/batas giliran, backup, dan CLI bridge (~1–2 mnt). Regresi jalur rilis tertangkap sebelum merge, bukan baru di nightly.
- **📝 Checklist uji manual pra-rilis.** Dua gerbang yang tidak bisa diotomatiskan kini punya prosedur dan tabel hasil: **CLI bridge** (`docs/uji-manual-cli-bridge.md`, termasuk fallback prompt terminal saat server mati/timeout, plus preflight `node scripts/uji-cli-bridge.mjs`) dan **HP** (`docs/uji-manual-hp.md`, keyboard, push, layar kunci, PWA). Status rilis mengikuti hasil kedua checklist ini.
- **📦 Upload terlalu besar kini menjelaskan penolakannya.** Setelah menjawab **413**, server tidak lagi langsung memutus koneksi secara paksa saat klien masih mengirim; respons dibiarkan terkirim lebih dulu. Sebelumnya klien bisa hanya melihat `ECONNRESET` dan tidak tahu upload-nya ditolak.

## 1.0.8

- **🔐 CLI bridge: token sempit.** Launcher tidak lagi mengambil token aplikasi dari halaman HTML; ia meminta token CLI yang hanya diterima `/api/cli-bridge/ask`. File token milik hook tidak bisa dipakai untuk shutdown, backup, atau menjawab izin lain bila bocor.

## 1.0.7

- **🚦 Rilis tidak lagi setengah jadi.** GitHub Release dibuat sebagai **draft** dan baru dipublikasikan setelah aset Windows, Linux, dan macOS (arm64 + x64) beserta checksum/signature lengkap. Kalau satu platform gagal atau asetnya hilang, rilis tetap draft dan job publish gagal dengan nama aset yang kurang.
- **🌙 Test integrasi tiap malam.** Workflow `nightly` menjalankan `test:unit` (server sungguhan, backup, antrian, izin, HTTPS, CLI) di Windows dan Ubuntu; bisa dipicu manual dari tab Actions tanpa memperlambat CI push.

## 1.0.5

- **🧪 CI menjalankan test cepat.** Setiap push dan pull request kini menjalankan cek sintaks, ESLint, dan `test:fast` (~40 dtk) di Ubuntu. Test browser/server tetap lokal supaya CI tidak lambat dan flaky.
- **📝 Catatan rilis dari CHANGELOG.** Halaman Release GitHub kini menampilkan perubahan versi itu (dari `CHANGELOG.md`), bukan lagi "Rilis vX".
- **🔧 `npm run lint` diperbaiki.** Skrip memakai `npm exec` sehingga tetap jalan di mesin yang `npx`-nya salah resolusi.

## 1.0.4

- **🖥️ CLI bridge: kartu izin lebih aman.** Perintah shell yang lebih panjang dari yang bisa ditampilkan utuh kini **tidak bisa diizinkan dari aplikasi**—keputusan dikembalikan ke terminal supaya bagian tengah perintah tidak lolos tanpa dilihat. Preview tetap menampilkan awal dan akhir, rahasia (token, `--token`, `-u`, password, URL ber-kredensial, private key) disamarkan sebelum masuk chat/backup/notifikasi HP, dan tombol *Izinkan semua* tidak muncul untuk izin terminal. Status tetap **eksperimental** sampai uji TUI manual.
- **🔐 Figma bridge: semua endpoint butuh token.** `/poll`, `/result`, dan `/exec` kini mewajibkan token per-run (dicetak di terminal, disimpan plugin), CORS dibatasi ke origin plugin Figma, request URL rusak tidak lagi mematikan bridge, dan `delete`/`batch` tidak diekspos lewat HTTP. Token bisa ditetapkan lewat `FIGMA_BRIDGE_TOKEN` (minimal 16 karakter).
- **🧪 Test cepat untuk verifikasi harian.** `npm run test:fast` menjalankan hanya test logika murni (tanpa browser/server, ~36 dtk); tersedia juga `test:unit` dan `test:ui`. README kini jujur bahwa CI hanya membangun/merilis, bukan menjalankan test.

## 1.0.3

- **💾 Backup sesi OpenCode.** Export/import kini menyertakan sesi OpenCode melalui `opencode session export/import` (bukan salinan DB saat service hidup). Sesi yang sudah ada dilewati; bila OpenCode tidak terpasang, sesi dilewati dengan peringatan. Format backup naik ke versi 2. Pratinjau import menyebut jumlah sesi OpenCode dan memperingatkan backup lama yang tidak menyimpan path project.
- **🔀 Jadwal ganti mesin bertahan dan bisa dibatalkan.** Ganti mesin yang dijadwalkan saat project bekerja kini diingat setelah server restart, tetap diterapkan otomatis, dan bisa dibatalkan dari dialog mesin project.
- **🌉 Figma bridge: perintah dari terminal.** `tools/figma-bridge/cli.mjs` mengirim perintah (status, selection, node, export, create_*, set_fill, move, resize, delete, batch) lewat endpoint `/exec` yang hanya aktif bila `FIGMA_BRIDGE_TOKEN` diatur.
- **🧾 Log server dibatasi.** `server.log` diputar ke `server.log.1` saat melewati 5 MB agar folder data tidak membengkak.

## 1.0.2

- **🔀 Ganti mesin saat project bekerja.** Memilih mesin lain saat giliran berjalan kini **dijadwalkan** dan diterapkan otomatis setelah giliran selesai; antrian/izin/giliran terputus tetap harus diselesaikan dulu.
- **Tombol Mesin project lebih jelas.** Saat project sibuk, menunggu izin, punya antrian, atau giliran terputus, tombol menampilkan alasan; error 409 juga muncul sebagai toast.
- **Backup project & chat lengkap.** Export menyertakan root efektif dan path setiap project, sehingga import mengenali project walaupun root tidak pernah diatur manual. Backup lama perlu dibuat ulang.
- **Build Electron lebih andal.** CI memakai runtime Electron lokal/mirror, menghindari kegagalan unduhan 504 dari GitHub.

## 1.0.1

### Perbaikan

- **Backup lengkap untuk project & chat.** Export kini menyertakan **root project efektif** dan **path setiap project**, bukan hanya root yang pernah diatur manual. Sebelumnya project yang memakai root default tidak dikenali saat import, sehingga chat dan pengaturan project ikut terbuang. Import juga membuat project eksplisit dari path backup. Buat ulang backup lama setelah update.

## 1.0.0

### Eksperimental

- **🔀 Ganti mesin menyegarkan semua klien.** Event `engine` per project kini memuat ulang setiap jendela yang terbuka (browser dan Desktop), jadi riwayat chat, aktivitas, badge, dan pengaturan tidak tertinggal di mesin lama atau terlihat seperti rollback. “Pengaturan giliran” juga sudah mengikuti mesin project (Mode Build/Plan untuk OpenCode).
- **🖥 Mode Desktop (Electron) + installer Website/Desktop/All.** Installer Windows kini menawarkan tiga mode: Website (browser/PWA), Desktop (jendela Electron + tray), atau keduanya. Electron memakai server dan data yang sama, single instance, tutup jendela minimize ke tray, dan update tetap satu jalur. Build Windows menyertakan server SEA + Electron. Rilis memakai **Ed25519** (`.sig` wajib bila public key ikut build) selain SHA-256; workflow GitHub Actions hanya berisi build Windows/Linux/macOS dan mengunggah aset bertanda tangan. Detail: [docs/packaging-desktop.md](docs/packaging-desktop.md).
- **📦 Build Windows, Linux, dan skrip macOS.** `npm run build:win` menghasilkan `AdhitOffice.exe` (Node SEA) + installer per-user Inno Setup; `npm run build:linux` menghasilkan tarball portable + `.deb` (systemd user unit, desktop entry); `npm run build:mac` menghasilkan `.app` (lokal di Mac atau lewat GitHub Actions macOS tanpa Mac sendiri, belum ditandatangani). Data di folder user, UI tetap web/PWA. Update Windows mengecek GitHub Releases, mewajibkan aset installer + SHA-256, memverifikasi hash dan host sebelum menjalankan installer senyap; ditolak saat ada giliran berjalan. Build belum ditandatangani. Detail: [docs/packaging-desktop.md](docs/packaging-desktop.md).
- **🌉 CLI bridge opt-in.** `office claude` menjalankan Claude Code dengan hook `PreToolUse` sementara sehingga izin tool berbahaya bisa dijawab dari kantor/HP. Fail-closed: server mati, timeout, atau hook gagal menyerahkan keputusan ke prompt terminal. Izin CLI diberi penanda **Terminal · CLI bridge**, tidak bisa di-allow dari layar kunci, dibatasi 3 menitung/project, dan dicatat sebagai `cli-approval`. **Belum dirilis**: menunggu uji TUI manual (fallback prompt terminal) sebelum masuk README fitur dan pengaturan.

## 2026-11-08

### Baru

- **📈 Riwayat kesehatan 7 hari + alarm backup.** 🩺 Kesehatan sistem sekarang punya bagian **Aktivitas 7 hari**: ringkasan **Hari ini** dan tabel 7 hari (Hari, Giliran, Gagal, Antrian, Tunggu p95, Kena batas) — giliran selesai/gagal dan rata-rata durasinya, item antrian yang mulai dengan p50/p95 waktu tunggu, berapa kali prompt masuk antrian atau command/handoff/approval ditolak karena ⚡ batas giliran, plus jumlah restart server dan waktu terakhir. Semua angka agregat, tersimpan rolling 7 hari lokal di `data/metrics.json` (tanpa isi percakapan atau nama project, bukan bagian backup); hari tanpa sampel tunggu ditulis `—`. Pemeriksaan **Backup otomatis** kini ikut memeriksa folder tujuan: file `adhit-office-backup-auto-*.zip` terbaru harus ada dan tidak lebih tua dari jadwal (>36 jam untuk harian, >8 hari untuk mingguan), file hilang atau basi jadi warning, dan export manual `adhit-office-backup-*.zip` tidak dihitung.
- **⚡ Batas giliran bersamaan.** Batasi berapa project yang boleh bekerja serentak dari aplikasi: ⚙ → **Umum** → **⚡ Batas giliran bersamaan** (default **3**, rentang 0–8, **0 = tanpa batas**, hanya dari laptop). Saat penuh, prompt ke project lain **otomatis masuk 📋 Antrian** sebagai bubble **antre #N** dengan tombol **✕ Batal**; giliran memakai bubble yang sama, slot diberikan FIFO lintas project (interaktif sebelum tugas terjadwal/runbook), dan Effort/Model Auto baru diklasifikasi saat giliran mulai. `/compact`/`/continue`/handoff ditolak dengan penjelasan. Sesi CLI di terminal tidak dihitung. Badge `⚡ 2/3` tampil di 🗂 Semua project dan bar HP. Menurunkan batas tidak memotong giliran yang sedang berjalan.
- **⏳ Retensi otomatis chat & laporan pemakaian.** ⚙ → **Cadangkan riwayat** → **🕵️ Data saya** sekarang punya pilihan batas **Chat** dan **Laporan pemakaian** (0/30/90/180/365 hari; default **0 = simpan selamanya**), dengan **Pratinjau**, **Simpan**, dan **Bersihkan sekarang** (berkonfirmasi, tidak bisa dibatalkan). Pembersihan berjalan otomatis saat server start dan tiap 24 jam: hanya pesan panel chat dan baris ledger yang lewat batas, sedangkan baris tanpa timestamp valid/rusak, transkrip sesi, riwayat sesi, backup, dan file project tidak disentuh. Ledger di-backup harian sebagai `.bak-retention-YYYYMMDD`, dan setiap run tercatat di audit `retention-run` (bisa disaring dan diunduh CSV).
- **🧹 Pemakaian disk & pembersihan aman.** 🕵️ Data saya kini menampilkan ukuran per kategori—chat, ledger dan arsipnya, lampiran antrian, bundel redo, backup config OpenCode, riwayat kesehatan, log server, audit aksi/login, salinan state lama, cache harga model, trash, dan backup otomatis—dengan tombol **Hapus bundel redo**, **Hapus backup config OpenCode**, **Hapus riwayat kesehatan**, **Kosongkan log server**, dan **Hapus salinan state lama**. Audit aksi dan audit login hanya ditampilkan sebagai bukti. **Hapus data project** sekarang ikut menghapus bundel redo dan lampiran antrian project itu; backup otomatis (ZIP seluruh kantor) tetap utuh dan tidak bisa dihapus per project. Semua aksi tercatat di audit `data-purge`.
- **⏸ Jeda semua antrian + ETA hidup.** 🌐 Semua antrian punya tombol **⏸ Jeda semua / ▶ Lanjutkan semua**: menjeda semua antrian yang masih menunggu/berjalan, atau melanjutkan hanya antrian yang dijeda user—antrian gagal/budget/akun/restart tetap dijeda, dan giliran berjalan tidak dipotong. ETA kini menampilkan `±X mnt · ≈HH.MM` dan disegarkan tiap menit selama dialog terbuka.
- **📌 Pin prioritas antrian.** Item yang masih menunggu bisa dipin dari dialog 📋 Antrian atau 🌐 Semua; item yang dipin dijalankan lebih dulu lintas project (beberapa pin: yang paling tua menang), tanpa mengubah urutan item lain. Hanya item menunggu yang bisa dipin.
- **🔊 Bacakan balasan asisten.** Toggle per perangkat di 🔔 Pengaturan notifikasi: jawaban akhir giliran dibacakan dengan suara browser. Markdown dibersihkan, blok kode dilewati, jawaban panjang dipotong di batas kata; Stop/Esc menghentikan suara. Tidak ada teks yang dikirim ke server aplikasi.
- **🔐 Privasi & data pribadi.** Ditambahkan dokumen **[docs/privasi-data.md](docs/privasi-data.md)**: daftar data yang disimpan, retensi, pihak ketiga, hak subjek data, dan DPIA ringkas—termasuk penjelasan token OpenCode Console, data usage/request log yang dinormalisasi, serta batas backup per project. Panel OpenCode dan request log kini menyatakan bahwa token tidak dikirim ke browser dan data request tidak memuat prompt/header/lokasi.
- **📊 Kuota OpenCode Go resmi + laporan provider.** 👤 Akun kini membaca **OpenCode Console** (token OAuth yang sudah tersimpan) untuk menampilkan paket, masa aktif, dan **tiga meter resmi** Rolling/5 jam, Weekly/7 hari, Monthly/30 hari—persis seperti halaman akun OpenCode, lengkap dengan hitung mundur reset. Kartu **Pemakaian OpenCode** (Hari ini/7 hari) memakai endpoint usage resmi untuk **biaya, request, dan token**, dengan **rincian per model** (request, input, cache read/write, output, biaya) dan **📡 Request terbaru di dalam dialog Akun** (durasi, TTFT, token, biaya, status, pagination cursor); tombol 📡 di Riwayat sesi membuka request khusus sesi itu plus **total provider sesi** (request/token/biaya) yang dibandingkan dengan ledger. 📊 Laporan menambahkan bagian **OpenCode Go — data provider** (aktivitas harian, model, dan biaya provider maksimal 5 sesi teratas) untuk laporan akun/Semua akun; angka provider tidak dicampur dengan tabel project/role. Token tidak pernah dikirim ke browser, dicatat, atau masuk backup; jika console tidak tersedia/kedaluwarsa, aplikasi kembali ke estimasi.
- **🧭 Klasifikasi Auto memakai Seimbang.** Effort/Model Auto kini selalu menilai prompt dengan model tier **Seimbang** (dari tangga project), bukan model yang sedang aktif. Pro/kuat/maks hanya dipakai untuk menjalankan tugas, jadi klasifikasi tidak lagi menghabiskan token model besar. Slot Seimbang kosong → default mesin; classifier gagal → aturan lokal, giliran tetap jalan.
- **🧠 Auto memilih model dan effort terpisah.** Satu panggilan classifier kini mengembalikan **level** (untuk model) dan **effort** (untuk thinking). Tugas yang sudah jelas bisa `Kuat` + `medium`, tugas ambiguous bisa `Seimbang` + `high`; guardrail menjaga `max` hanya untuk `xhigh/max`, `low` hanya untuk `low`, dan fallback ke pemetaan lama bila effort tidak valid. Antrian menyimpan kedua keputusan sehingga model tetap dari level, effort tetap dari keputusan thinking.
- **▶ Notifikasi antrian mulai.** 🔔 pengaturan notifikasi punya jenis **Antrian mulai** (mati secara bawaan), memberi tahu saat item antrean benar-benar mulai—di laptop maupun push HP. Isi prompt tidak pernah ikut ke payload notifikasi.
- **🌐 Semua antrian + perkiraan tunggu + edit prompt antre.** Tombol **🌐 Semua** di dialog 📋 Antrian (atau `Ctrl+P` → *Semua antrian*) menampilkan antrian semua project dalam urutan penjadwalan adil—berjalan dulu, lalu menunggu `#N`, lalu yang dijeda ⏸—dengan ringkasan `N menunggu · M berjalan` (+ `· K antrian dijeda`) dan tombol **Buka** / **Batal**; dari HP WiFi hanya-lihat. Bubble **antre #N** kini menampilkan perkiraan `±X mnt` atau `sebentar` dari median durasi giliran terakhir (maks 10 per project, fallback lintas project; tanpa data = tanpa ETA). Tombol **Edit** pada bubble yang masih antre mengubah item itu di tempat—server memperbarui bubble yang sama, sedangkan item yang sudah berjalan ditolak (409).
- **🧹 Perapian tombol & action row.** Tombol **⬇ Unduh CSV** di 📊 Laporan kini berlabel lengkap, punya lebar minimum, dan tidak lagi gepeng/terpotong; footer Laporan menaruh teks cakupan di baris sendiri dan tombol rata kanan. Semua baris aksi di dialog sekarang membungkus dan tombolnya tidak menyusut, termasuk toolbar 📋 Antrian, ⚙ Cadangan, dan dialog lainnya. Field pencarian 🕘 Riwayat sesi juga mendapat satu baris penuh.
- **🧩 Laporan per role (perkiraan).** 📊 Laporan kini punya tabel **Per role**: token, persentase, biaya, dan jumlah delegasi untuk **Lead (utama)** serta tiap role subagent (Backend, Frontend, QA, Reviewer, …). Claude memakai proporsi transcript (main vs `agent-*.jsonl`); OpenCode memakai **`agent` yang disimpan di ledger** (build/plan = Lead), dengan `session.list` sebagai cadangan untuk baris lama—jadi role OpenCode tetap terbaca meski sesinya sudah dihapus. Tabel selalu berjumlah sama dengan total laporan. Baris **Cakupan** menunjukkan berapa persen token/sesi yang punya rincian role; sisanya masuk **OpenCode (tanpa rincian role)** atau **Tanpa rincian role**, bukan diklaim sebagai Lead. Tersedia di pratinjau, PDF, dan CSV.

## 2026-11-07

### Baru

- **Proyeksi budget akhir bulan.** Bagian Budget menampilkan perkiraan `±$X` akhir bulan dari laju pemakaian bulan ini, plus peringatan bila proyeksinya melewati batas bulanan. Tetap perkiraan, bukan tagihan.
- **📜 Chat panjang tetap ringan.** Tab Chat hanya menggambar 80 pesan terakhir; tombol **Muat N pesan lama** menambah sebelumnya tanpa menggeser pesan yang sedang dibaca. Pencarian `Ctrl+F` tetap menjangkau seluruh percakapan, dan lompatan dari ⚠ Perlu perhatian, 📋 Antrian, atau notifikasi otomatis membuka pesan lama yang dituju.
- **⏰ Tunda pengingat di Perlu perhatian.** Setiap item punya tombol **⏰** untuk menyembunyikannya (beserta badge) selama 1 jam; **Tampilkan** mengembalikannya lebih cepat. Tersimpan per browser dan tidak mengubah antrian atau izin yang menunggu.
- **👆 Geser antar view di HP.** Geser kiri/kanan untuk pindah **Kantor ↔ Chat ↔ Perubahan ↔ Aktivitas**. Geser vertikal tetap scroll; gesture yang mulai di kotak pesan, dialog, atau panel yang bisa digeser menyamping tidak ikut berpindah.
- **🔇 Bisukan notifikasi per project.** Di 🔔 Pengaturan notifikasi, centang project yang tidak ingin mengganggu; suara dan pop-up project itu diam di perangkat ini (minta izin pun tidak berbunyi), dan aturan yang sama dipakai push di HP.
- **🏷 Chip filter tag + 📦 arsip otomatis.** Riwayat sesi menampilkan chip tag yang bisa diklik untuk menyaring. Setiap project bisa memilih **Arsip otomatis 30/90/180 hari**; sesi tua masuk 📦 Diarsipkan, dan tombol ↩ menyematkannya agar tidak terarsip lagi karena umur.
- **⧗ Shell OpenCode sesi lain ikut terlihat.** Panel Tugas latar sekarang juga menampilkan shell OpenCode dari sesi lain di folder project yang sama, sebagai daftar **hanya lihat** (tanpa output dan tanpa Hentikan).
- **🏷/📦 Tag & arsip massal + kelola tag.** Centang beberapa sesi untuk memberi satu tag atau mengarsipkan sekaligus; **✎ Kelola tag** mengganti nama/menghapus satu tag di semua sesi project.
- **📚 Runbook antrian.** Dialog 📋 Antrian bisa menyimpan item yang masih menunggu sebagai runbook bernama (per project); **▶ Jalankan** menambahkannya kembali ke antrian. Tersimpan di state aplikasi dan ikut backup.
- **🩺 Bundel diagnostik.** Tombol di Kesehatan sistem (dan Ctrl+P) mengunduh `.zip` berisi info versi, hasil health, dan 512 KB log terakhir; folder home disamarkan dan tidak ada isi percakapan.
- **🎨 Figma bridge lokal.** `tools/figma-bridge/` menyediakan server MCP + plugin Figma desktop: agent bisa membaca seleksi/halaman/node, mengekspor SVG/PNG, serta membuat frame, rectangle, teks, mengubah warna, dan memindahkan node lewat Plugin API. Semua lokal (`127.0.0.1:3939`); tanpa token Figma dan tanpa data keluar dari laptop.
- **🔎 Verifikasi & 🔑 ganti sandi backup.** Tombol **Verifikasi file** memeriksa `.zip`/`.aob` beserta kata sandinya tanpa memulihkan apa pun; **Ganti sandi** mengenkripsi ulang `.aob` dengan kata sandi baru lalu mengunduh file barunya.
- **🎲 Recovery key & kekuatan sandi.** Tombol **Buat** mengisi kata sandi acak 20 karakter (format berkelompok) dan indikator kekuatan; **📋** menyalinnya. Tidak ada pemulihan bila hilang.
- **🧹 Hapus data per project.** Di panel **Data saya**: pilih project lalu hapus chat kedua mesin, ledger, pengaturan, sesi, antrian, dan runbook project itu. Project dan folder tetap ada.
- **📜 Audit: filter & CSV.** Aktivitas data bisa disaring per jenis dan diunduh sebagai CSV.
- **📜 Audit aksi data.** Ekspor/impor/verifikasi/ganti sandi backup dan pembersihan data dicatat di `data/audit.log` (tanpa isi percakapan) dan tampil di panel **Data saya**.
- **🔐 Backup terenkripsi.** Isi kata sandi (min. 8 karakter) saat Export untuk mendapat `.aob` terenkripsi AES-256-GCM; Import menerima `.zip` maupun `.aob` (kata sandi diminta lewat kolom yang sama). Tidak ada pemulihan kata sandi.
- **🕵️ Panel “Data saya”.** ⚙ → Cadangkan riwayat menampilkan ukuran state, chat, ledger, riwayat notifikasi, trash, dan backup otomatis; tombol aman untuk menghapus riwayat notifikasi dan mengosongkan trash.
- **↻ Ulangi sekali bila gagal.** Opsi per project di dialog 📋 Antrian: item yang gagal dicoba ulang otomatis satu kali sebelum antrian dijeda.
- **↻ Lanjutkan runbook dari item gagal.** Item antrian dari runbook ditandai; bila salah satu gagal, tombol **↻ Lanjutkan** mengulang item itu dan melanjutkan antrian tanpa mengulang prompt yang sudah sukses.
- **📚 Pustaka runbook bawaan.** Editor runbook punya contoh siap pakai (Rilis, Perbaikan bug, Review PR, Cek CI) yang bisa diubah sebelum disimpan.
- **🕘 Riwayat versi runbook.** Lima versi terakhir nama + prompt disimpan; **Pulihkan** memuat versi lama ke editor untuk disimpan lagi.
- **✎ Editor runbook.** Runbook punya editor nama + prompt (pisahkan prompt dengan baris `---`), bukan hanya ganti nama.
- **📅 Kalender jadwal 7 hari.** Tab ⚙ → Jadwal menampilkan jadwal 7 hari ke depan (jam dan potongan prompt per hari).
- **🗂 Arsip project.** Tombol 📦 di daftar project menyembunyikannya tanpa menghapus data; toggle 📦 di judul dialog menampilkan project yang diarsipkan.
- **🛠 Checklist “Buat kerangka”.** Dari checklist project, satu tombol (setelah konfirmasi) membuat README.md, AGENTS.md, .env.example, dan docs/README.md yang belum ada; file yang sudah ada tidak pernah ditimpa.
- **✅ Checklist project.** Ctrl+P → *Checklist project* menunjukkan butir kesiapan (README, AGENTS/CLAUDE.md, package.json, test/build, git, docs, .env.example, model) beserta saran singkat.
- **📈 Sparkline biaya 7 hari.** Baris **Hari ini** di 🗂 Semua project menampilkan grafik kecil biaya tujuh hari terakhir beserta totalnya, dari pembacaan ledger yang sama.
- **🔎 Ctrl+P mencari file lintas project.** `@kata` mencari di project aktif lalu di project lain; hasil dari project lain menampilkan nama projectnya, dan memilihnya pindah project lalu membuka file.
- **🏷 Tag & 📦 arsip sesi.** Riwayat sesi bisa diberi tag (ikut tercari) dan diarsipkan tanpa dihapus; filter **📦 Diarsipkan** menampilkan yang disembunyikan. Tersimpan di state aplikasi, jadi konsisten antar perangkat.
- **🔎 Ctrl+P mencari isi percakapan.** Ketik 2+ huruf dan palet menampilkan grup **Percakapan** dari semua project, lengkap dengan cuplikan dan nama project; pilih hasilnya untuk melanjutkan sesi itu. Prefix `>`/`@`/`#` tetap mempersempit ke perintah/file/project.
- **🗑 Hapus beberapa sesi sekaligus.** Di 🕘 Riwayat sesi, centang beberapa sesi (atau **Pilih semua**) lalu **Hapus N sesi**; satu konfirmasi untuk semuanya, dan sesi yang sedang dibuka atau berjalan di terminal tidak ikut terhapus.
- **⬆ Pratinjau sebelum restore backup.** Memilih `.zip` di **Import riwayat** sekarang menampilkan isinya dulu — jumlah project dan sesi, chat per mesin, ukuran, waktu pembuatan, serta data kantor yang ikut — lalu tombol **Pulihkan semua**. Server hanya membaca arsip saat pratinjau; belum ada yang ditulis.
- **☑️ Restore selektif per project.** Di pratinjau, setiap project punya checkbox (default semua). Project yang tidak dicentang tidak ikut dipulihkan — transkrip dan chat-nya dilewati; pengaturan, laporan token, dan riwayat prompt tetap digabung.
- **↩️ Pulihkan sesi terhapus.** Sesi Claude yang dihapus muncul di **🗑 Sesi terhapus** pada 🕘 Riwayat sesi; **↩ Pulihkan** mengembalikan transkrip (dan subagent-nya) ke riwayat. Sesi yang sudah ada lagi dengan id yang sama tidak ditimpa.
- **📅 Saring Riwayat sesi.** Pilih **Semua waktu / 7 / 30 / 90 hari terakhir**; filter digabung dengan kotak pencarian.
- **🔁 HTTPS/Tailscale menyambung sendiri.** Kalau Tailscale belum tersambung saat aplikasi menyala, sertifikat HTTPS dicoba ulang tiap menit sampai berhasil (tanpa restart); log hanya mencatat perubahan, bukan setiap percobaan.
- **🧹 Retensi trash sesi.** Sesi terhapus disimpan di `data/trash` dan dibersihkan otomatis setelah **30 hari** (dicek saat start lalu tiap hari); jumlahnya tampil di Riwayat sesi. File asing di folder trash tidak pernah disentuh. `OFFICE_TRASH_DAYS` bisa mengubah batasnya (0 = simpan selamanya).
- **📊 Grafik biaya 7 hari.** Bagian Budget menampilkan batang biaya per hari (Sen–Min/Minggu ini), termasuk hari kosong; arahkan kursor untuk tanggal dan nominal. Ikut tampil di ringkasan 🩺 Kesehatan.
- **📈 Ringkasan “Hari ini” di dashboard.** Di atas daftar 🗂 Semua project: biaya tercatat hari ini (dengan cakupan baris berbiaya), jumlah giliran, token, sesi, dan project yang tersentuh — satu request per menit, dan tidak diminta di halaman hanya-lihat.
- **⚖ Audit kontras warna.** Test baru menghitung kontras WCAG (4,5:1 teks normal, 3:1 teks besar) untuk halaman, dashboard, Pengaturan, dan palet perintah di **tema terang dan gelap**; hasilnya bersih dan akan menangkap regresi styling.
- **★ Pesan tersimpan.** Tandai pesan atau jawaban dengan **☆**, lalu buka **Ctrl+P → Pesan tersimpan** untuk melihat daftarnya; **Buka di chat** menyorot barisnya (memuat halaman chat lama bila perlu) dan **Hapus** melepas tanda. Tersimpan di browser per project.
- **✎ Ganti nama sesi lama (Claude Code).** Tombol **✎** di 🕘 Riwayat sesi sekarang juga muncul untuk sesi Claude: judul baru ditulis sebagai `custom-title` (tipe yang sama dengan `/rename`), jadi muncul di daftar dan saat melanjutkan sesi. Sesi yang sedang dibuka atau berjalan di terminal tetap harus diganti dari tempatnya.
- **☑️ Pilih data kantor saat restore.** Di pratinjau import, selain per project, kamu bisa melepas **Pengaturan & folder project**, **Laporan token**, atau **Riwayat prompt (↑)**. Yang tidak dicentang tidak digabung; transkrip dan file project tetap mengikuti pilihan project.
- **⚡ Aksi cepat di kartu dashboard.** Kartu project di 🗂 Semua project punya tombol **📋 Antrian** (membuka antrian project itu tanpa berpindah project) dan **■ Hentikan** saat project sedang bekerja.
- **📦 Export beberapa sesi sekaligus.** Pilih sesi di 🕘 Riwayat sesi lalu **⬇ Export N**: satu `.zip` berisi `.md` per sesi (Claude) atau `.json` (OpenCode), maksimal 25 sesi.
- **🔎 Filter pencarian transkrip.** Prefix **`?`** membatasi Ctrl+P ke isi percakapan, dengan token filter di depan: `claude`/`opencode` dan `7d`/`30d`/`90d` (mis. `?opencode 7d checkout`). Token filter tidak ikut dikirim sebagai kata kunci.
- **🧭 Chip status di dashboard.** Di atas daftar 🗂 Semua project ada chip **Semua / Butuh kamu / Bekerja / Antrian / Idle** beserta hitungannya; klik untuk menyaring kartu, klik lagi untuk kembali ke semua. Pencarian tetap bekerja di atas filter.
- **🕘 Riwayat backup otomatis.** Di ⚙ → Cadangan, daftar backup terjadwal di folder tujuan (nama, waktu, ukuran) dengan tombol **↩ Pulihkan**; file backup tidak dipindahkan atau dihapus, dan hasil pemulihan memakai jalur merge yang sama dengan import.
- **📲 Pasang sebagai aplikasi.** Bagian baru di ❓ Panduan menjelaskan install di Android/iPhone; tombol **Pasang sekarang** muncul saat browser menawarkan PWA (Chrome/Edge). Tidak ada cache offline — halaman memuat token sesi per-start, jadi sengaja tidak disimpan di cache browser.
- **📈 Top project “Hari ini”.** Ringkasan harian kini menyebut satu–dua project paling aktif hari ini (berdasarkan giliran/token), di samping biaya, giliran, token, sesi, dan jumlah project.
- **🔔 Riwayat notifikasi.** Di ⚙ → Notifikasi (laptop) ada daftar 30 notifikasi terakhir yang dikirim ke HP: waktu, project, jenis (minta izin/selesai/berhenti/antrian/tes), role, dan perangkat tujuan. Disimpan di memori server sejak aplikasi menyala.
- **🎨 Tema kontras tinggi.** Pilihan **Tampilan → Kontras tinggi**: latar hitam, teks putih, aksen kuning, dan garis putih. Diaudit otomatis dengan target WCAG AA seperti tema lain.
- **💾 Riwayat notifikasi bertahan setelah restart.** Log 30 notifikasi terakhir disimpan di `data/push-history.json` (tidak ikut backup) dan dimuat lagi saat server menyala.
- **🔢 Badge ikon aplikasi.** Saat dipasang sebagai PWA, ikon aplikasi menampilkan jumlah izin yang menunggu (Badging API); badge hilang saat tidak ada izin tertunda.
- **💰 Badge budget per project.** Kartu di 🗂 Semua project menampilkan `💰 $terpakai / $batas` untuk project yang punya batas sendiri, dengan warna kuning ≥80% dan merah ≥100%.
- **⌨️ Daftar shortcut di Panduan.** Tekan **?** (atau Ctrl+P → *Daftar shortcut keyboard*) untuk melihat semua tombol: project, palet, cari chat, riwayat prompt, latar belakang, Enter/Alt+Enter, Shift+Tab, Alt+M, Esc, dan Esc Esc.
- **🔗 Shortcut PWA.** Menu cepat ikon aplikasi: **Semua project** (`/?open=dashboard`) dan **Riwayat sesi** (`/?open=sessions`); parameter dibersihkan setelah dialog terbuka.
- **📊 Banding periode di laporan.** Ringkasan laporan menampilkan delta **token** dan **biaya** terhadap periode sebelumnya yang sama panjang.
- **💵 Token & biaya per sesi.** Baris di 🕘 Riwayat sesi menampilkan `1,2k token · $0,50` bila ledger punya catatan untuk sesi itu; biaya berasal dari baris berbiaya (baris $0 OpenCode tidak menambah angka).
- **🔖 Cari di pesan tersimpan.** Kotak cari di **Ctrl+P → Pesan tersimpan** menyaring berdasarkan teks dan peran; query dikosongkan setiap dialog dibuka.
- **📤 Export CSV laporan.** Tombol **⬇ CSV** di laporan mengunduh angka per periode (input, output, cache, total token, biaya) dengan BOM agar Excel membaca format Indonesia.

### Diperbaiki

- **♿ Audit aksesibilitas.** Kontrol tanpa nama, field tanpa label, gambar tanpa `alt`, id ganda, dan referensi ARIA yang menggantung kini diperiksa otomatis di halaman utama, tab Perubahan/Aktivitas, serta dialog Pengaturan, Semua project, palet perintah, dan Antrian. Target sentuh yang terlalu kecil (tombol sesi, toggle karyawan, kartu dashboard, toggle batas antrian) dinaikkan ke minimal 24×24 px.

- **📱 Sheet HP di layar pendek.** Tinggi maksimum sheet sekarang mengikuti padding modal, jadi tidak lagi melewati tepi layar saat kontennya panjang (mis. Pengaturan giliran di 844×390).
- **Kantor lebih lega.** Kartu karyawan default terlipat dengan ringkasan jumlah orang/aktif; tombol **Mode Otak** pindah dari atas panggung ke baris kontrol di bawah kantor.
- **Pencarian global lebih luas.** **Ctrl+P** kini juga menemukan panel Pengaturan (Umum, Tim & izin, Jadwal, Notifikasi, Spotify, Cadangan, Sistem) dan aksi **Cari di chat ini**, bukan hanya project, file, dan perintah.

## 2026-11-06

### Baru

- **👋 Tur singkat & pencarian pengaturan.** Tur 4 langkah dari Panduan/layar kosong; kotak cari di ⚙ langsung menampilkan panel yang cocok.
- **🔍 Pencarian chat bisa dilompati.** Kotak cari di tab Chat menyaring pesan yang cocok, menandai teksnya, dan menghitung **2/5**; **Enter** / **Shift+Enter** pindah ke hasil berikutnya/sebelumnya (membungkus di ujung), dan kueri tetap aktif saat percakapan dimuat ulang (mis. setelah tersambung lagi) — berganti project menutupnya.
- **✅ Penanda pesan baru.** Chat memberi pemisah tanggal dan penanda **“Pesan baru”** saat kamu membaca pesan lama; tombol **↓ N pesan baru** membawa kembali ke bawah.
- **🎛️ Tampilan yang bisa disesuaikan.** Pilih tema **Terang / Gelap / Ikuti sistem**, ukuran teks **Kecil / Normal / Besar**, kepadatan **Nyaman / Padat**, dan animasi **Ikuti sistem / Kurangi / Penuh**. Tersimpan per perangkat.
- **⚠ Perlu perhatian.** Badge di **🗂 Semua project** dan daftar di dashboard mengumpulkan izin yang menunggu, antrian dijeda, budget tercapai, giliran terputus, dan jadwal gagal; klik item untuk langsung ke project/panel terkait.
- **Budget jadi penghenti, bukan hanya peringatan.** Saat pemakaian harian/mingguan/bulanan mencapai batas, prompt baru, ringkas konteks, lanjutkan giliran, handoff, dan build dari kartu rencana ditolak sampai batas dinaikkan atau dikosongkan. Batas bisa **global atau per project**, dan tombol **Izinkan 1 giliran** memberi satu giliran lewat (berlaku 5 menit). Antrian ikut dijeda dengan alasan budget; turn yang sedang berjalan tidak dipotong.
- **⏰ Tugas terjadwal.** Di ⚙ → **Jadwal** kamu bisa menyimpan prompt per project: sekali, harian, atau mingguan. Saat waktunya tiba prompt masuk antrian, jadi tetap mengikuti aturan antrian, budget, dan izin yang sama. Jadwal bisa **diubah**, **dijalankan sekarang**, dijeda, dilanjutkan, atau dihapus; hasilnya muncul di chat dan status terakhir (**selesai/gagal**, waktu, error) tersimpan di daftar. Perubahan budget dan override juga dicatat di `data/budget-audit.jsonl` dan bisa dilihat di **Riwayat perubahan budget**; tiap jadwal menyimpan **5 run terakhir**.

### Diperbaiki

- **Notifikasi tidak lagi menghalangi klik.** Toast seperti *"Jadwal diperbarui"* tampil di atas tombol selama 4 detik dan sempat menelan klik berikutnya (mis. saat menyimpan lalu langsung menekan tombol yang sama); toast sekarang hanya informasi dan klik diteruskan ke tombol di bawahnya.
- **Toast bertumpuk rapi.** Beberapa notifikasi tidak lagi saling menimpa: tampil berurutan (maksimal 3, yang terlama dibuang) dan pesan yang sama tidak dobel.
- **Klik 🔍 cari di chat tidak lagi menyembunyikan chat.** Tombol aksi di bar tab sempat dianggap tombol tab sehingga ikut berpindah tab, mengosongkan fokus, dan menyembunyikan panel chat; sekarang hanya tombol tab yang berpindah.
- **UI lebih sedikit tulisan.** Dialog **⚙ Pengaturan** kini memakai tab juga di HP (satu bagian sekaligus, bukan satu lembar panjang), penjelasan panjang dipersingkat, baris hint di atas kotak pesan dibatasi 2 pesan terpenting (sisanya di tooltip), kartu rencana menampilkan ringkasan dulu dengan **Lihat rencana lengkap**, empty state/laporan memakai kalimat lebih pendek, dan detail **Kesehatan sistem** serta **Laporan** dilipat sampai dibuka.
- **Kartu rencana tidak lagi terasa macet.** Klik **▶ Lanjut build** atau **Minta revisi** kini menampilkan loading beranimasi di kartu (**“Menentukan model & effort…”** / **“Mengirim revisi…”**) dan baris typing di chat, lalu satu baris info `⚙️ Auto build: Effort High · Model Kuat → deepseek-v4-pro — alasan`. Bubble build/revisi ikut membawa tag **Auto** (effort) dan **Model**. Saat Auto mati, hanya ada loading singkat tanpa klasifikasi; tombol dikunci selama proses agar tidak terkirim dua kali.

## 2026-11-05

### Baru

- **Default Model Auto lebih murah.** Tangga default OpenCode Go sekarang `deepseek-v4.1-flash → glm-5.3-flash → deepseek-v4-pro → glm-5.3` — tanpa Kimi K3/K3.1 Pro yang mahal. Kualitas tetap bertingkat, dan project yang sudah punya tangga sendiri tidak berubah.
- **Mesin per project.** Setiap project bisa memakai **Claude Code** atau **OpenCode** sendiri (⚙ Pengaturan → **🔀 Mesin project**), dan dua project boleh berjalan bersamaan. Riwayat chat disimpan terpisah per mesin dan tidak dihapus saat berganti; model/effort/agent diingat per mesin untuk project itu. Di Akun, pilihan mesin sekarang menjadi **default untuk project baru** (project lama tidak ikut pindah). Pergantian ditolak saat project sibuk/izin menunggu/antrean/“Lanjutkan”.
- **Backup membawa mesin per project (Stage 2).** 📦 Export/import sekarang menyertakan mesin tiap project, pengaturan model/effort/agent per mesin, dan id percakapan **Claude** (id OpenCode tidak dipulihkan karena penyimpanannya tidak ikut backup). Saat import, mesin dipulihkan bila OpenCode terpasang; bila tidak, project dari backup memakai Claude Code. Salinan rollback `state.json.pre-per-project-*` **tanpa data HP/VAPID**, maksimal 5 file/30 hari. Data workspace lama (`workspaces`) dimigrasi otomatis satu arah saat start.
- **Perintah cepat tier & mode fokus.** `/hemat`, `/seimbang`, `/kuat`, `/maks` langsung memilih model tier itu (Auto dimatikan), `/auto` menyalakan Auto lagi. `/fokus` menyembunyikan dan menghentikan animasi kantor (diingat per perangkat, ada tombol keluar) agar chat/panel lega.
- **Budget pemakaian global.** ⚙ → **Umum** → **Budget pemakaian global**: batas **harian / mingguan / bulanan** (USD, kosong = tanpa batas), dengan bar `$12,30 / $20 (62%)` hijau/kuning (≥80%)/merah (≥100%) dan sisa dolar. Ringkasan ikut tampil di 🩺 Kesehatan. Dihitung dari biaya tercatat (harga list Claude; OpenCode Go umumnya $0 karena langganan) dan tidak memblokir pekerjaan.
- **Kesehatan sistem + checklist persiapan.** ⚙ → **Sistem** → **🩺 Kesehatan sistem** menampilkan akun, OpenCode, folder project, backup otomatis, akses HP/HTTPS, jumlah error server 24 jam, dan ukuran data dalam satu layar, plus checklist login/project/backup/HTTPS/OpenCode. Ada **↻ Periksa ulang**; laporan terakhir tetap tampil bila refresh gagal. Hanya laptop/Tailscale.
- **Alasan Auto & estimasi biaya.** Chat kini menampilkan alasan pilihan Auto (`🤖 Model Auto: Kuat → deepseek-v4-pro — multi-file bug fix`, dan badge Effort Auto ikut menampilkan alasan). Di atas kotak pesan ada estimasi `±$0.02` untuk prompt yang sedang diketik: konteks terpakai + teks prompt + asumsi output, memakai harga list/efektif; perkiraan, tidak menghalangi kirim.
- **Perkiraan sisa kuota OpenCode Go (Go / Go Plus / Go Teams).** Di 👤 Akun (OpenCode) ada **Kuota OpenCode Go** per model: terpakai/batas, sisa, dan bar **5 jam / 7 hari / 30 hari** (hijau/kuning/merah), dihitung dari token tercatat × harga list katalog resmi. Pilih paket **Go ($10/bulan)**, **Go Plus ($40/bulan)**, atau **Go Teams ($20/anggota/bulan)**; batas tiap model mengikuti tabel resmi paket itu, dan Go Teams dihitung per anggota. Model gratis tampil `tak terbatas`. Ini perkiraan; kuota resmi tetap di console OpenCode.
- **Hapus project yatim.** Project yang foldernya sudah dipindah/dihapus kini ditandai **folder hilang** di daftar project dan bisa dibersihkan lewat 🗑. Konfirmasi menjelaskan bahwa yang dihapus hanya data aplikasi (pengaturan, riwayat chat kedua mesin, antrian, baris laporan token); folder di disk dan file backup tidak disentuh. Server menolak purge untuk project yang foldernya masih ada, dan tombol ini mati di HP hanya-lihat. Project custom yang foldernya hilang tetap terdaftar setelah restart/refresh supaya datanya bisa dibersihkan.
- **Redo setelah rewind.** Setelah rewind, dialog menawarkan **↩ Ulangi perubahan** (kode yang belum di-commit, repo git, konflik dilewati, backup di `data/redo/`) dan **🔄 Pulihkan percakapan**: Claude kembali ke posisi terakhir; OpenCode memulihkan salinan percakapan sebagai sesi baru karena revert OpenCode menghapus pesan lama. Rewind kode di folder non-git ditolak sejak awal agar tidak ada perubahan tanpa undo.
- **Ganti akun dengan aman.** Login/logout Claude dan logout provider OpenCode kini menampilkan ringkasan dampak, **menjeda semua antrian** (chip “dijeda karena akun berubah”), dan mengunci logout provider dengan konfirmasi `LOGOUT`. Bila model aktif berasal dari provider yang logout, model tidak diganti diam-diam: muncul peringatan dan prompt menunggu sampai kamu memilih model lain/Default. Ada **Riwayat perubahan akun** (masuk/keluar, mesin/provider, laptop/HP, gagal/berhasil) tanpa token.
- **Logo model di kantor & otak.** Mode Otak menampilkan logo model aktif di inti otak, dan ruangan Lead punya plakat logo model yang sedang dipakai (termasuk saat Model Auto memilih tier). Logo dibaca dari folder `ai_logos/` (nama file = id model); model tanpa logo memakai monogram. Folder itu juga disajikan ke HP yang terpasang (gambar publik, tanpa data project).
- **Tangga Model Auto bisa diatur.** Di bawah pilihan model (saat Auto aktif) ada **Atur tangga…**: pilih model untuk **Hemat / Seimbang / Kuat / Maks** per mesin, atau **Bawaan** untuk kembali ke default. Berlaku untuk Claude Code dan OpenCode, tersimpan per project dan ikut backup.
- **Model Auto.** Pilihan **Auto — sesuaikan task** memakai klasifikasi task yang sama dengan Effort Auto (satu panggilan) untuk memilih model dari tangga **Hemat / Seimbang / Kuat / Maks**: Claude `haiku → sonnet → opus → fable`, OpenCode Go `deepseek-v4.1-flash → glm-5.3-flash → deepseek-v4-pro → glm-5.3`. Pergantian diumumkan di chat, tidak pernah di tengah giliran, dan memilih model konkret/Default mematikan Auto.
- **Harga model di Pengaturan giliran.** Daftar model kini menampilkan biaya per 1 juta token. Model **OpenCode Go** memakai harga list dari katalog resmi `opencode.ai` (input/output/cache, ditandai `±` untuk tarif jam sibuk, cache harian), sedangkan model **Claude** dan model tanpa harga list memakai **harga efektif dari catatan pemakaian** 90 hari terakhir. Model gratis tampil `gratis`; model yang belum pernah dipakai diberi penjelasan *Belum ada data harga*.
- **Ringkas konteks sekali klik.** 🧹 di status konteks (atau `/ringkas`) meringkas percakapan yang makin panjang, dengan **Fokus** opsional untuk Claude Code (mis. *pertahankan keputusan API*). Dengan OpenCode tombol memakai `/compact` bila sesinya menyediakan command itu. Ditolak dengan penjelasan saat giliran berjalan, ada izin menunggu, atau rewind berjalan; riwayat chat di aplikasi tidak diubah. Auto-compact bawaan Claude Code tetap berjalan sendiri (ambangnya tampil di status konteks).
- **Biaya per model di laporan.** Daftar model di 📊 Laporan kini menampilkan biaya dari catatan pemakaian, dengan aturan yang sama seperti per mesin: `—` bila belum ada catatan biaya dan `$0.00` untuk model gratis.
- **Statistik per mesin.** 📊 Laporan kini punya blok **Per mesin**: **Claude · Web**, **Claude · Terminal**, **OpenCode · Web**, dan **OpenCode · Terminal** dengan total token, persentase, dan biaya. Pilih **Semua akun (Claude + OpenCode)** untuk melihat kedua mesin dalam satu laporan. Biaya `—` berarti belum ada catatan biaya, `$0.00` untuk model gratis, dan `(N%)` bila hanya sebagian catatan punya biaya; kartu **Estimasi biaya** menampilkan cakupan catatan biaya. PDF memuat tabel per mesin dan per mesin × sumber. Rincian per role belum tersedia karena pemakaian subagent digabung ke sesi induknya.
- **Riwayat backup config OpenCode.** ⚙ → tab **Sistem** → **🧩 Config & Agent OpenCode** kini punya **🕘 Riwayat backup**: lihat versi lama file config, **Pratinjau** isinya, lalu **Pulihkan**. Isi yang sedang dipakai dibackup lebih dulu sebelum dipulihkan, jadi hasilnya masih bisa dibatalkan. Aplikasi menyimpan **10 backup terakhir per file selama 90 hari**.
- **Deteksi config OpenCode ganda + Konsolidasi.** Banner kuning di atas editor menunjukkan semua file config yang dibaca OpenCode (global, `opencode.json` project, `.opencode/opencode.json`), urutannya, dan file mana yang menang per kunci. **Konsolidasi ke file ini** menggabungkan isi `.opencode` ke `opencode.json` project, lalu memindahkan file `.opencode` ke folder backup aplikasi dengan awalan `dot--`—untuk pemulihan manual, tidak muncul di Riwayat backup.
- **Lokasi backup config pindah.** Backup tidak lagi ditulis sebagai `.bak-<waktu>` di sebelah file config, melainkan di folder data aplikasi (`opencode-config-backups/global/` dan `opencode-config-backups/<project>/`). File `.bak-*` lama tetap muncul di daftar (**format lama**) dan tetap bisa dipulihkan.
- **Perubahan dari luar tidak tertimpa.** Simpan, Pulihkan, dan Konsolidasi ditolak kalau file config diubah di luar aplikasi sejak editor dibuka—termasuk kalau editor sudah lama terbuka. Muncul pesan *"File berubah di luar aplikasi…"* dan tidak ada yang ditulis; klik **↻ Muat ulang** lalu ulangi. Backup yang rusak tidak bisa dipulihkan, dan file `.bak-*` lama tetap bisa dipulihkan (tidak pernah dihapus aplikasi).

### Diperbaiki

- **Header dan composer lebih lega.** Label teks di header diganti ikon + tooltip, meta sesi yang berulang dihapus, status koneksi menjadi titik saat tersambung, dan status line hanya muncul saat ada hal yang perlu diperhatikan.
- **Catatan di modal lebih ringkas.** Penjelasan panjang di Pengaturan, backup, kuota, antrian, izin, dan config OpenCode dipersingkat; detail lengkap tetap tersedia di dokumentasi.
- **Buka file di luar project dari chat.** Path absolut di chat (mis. screenshot di folder temp) kini bisa dibuka read-only dari laptop setelah konfirmasi. Server membatasinya ke folder Temp, Desktop, Documents, Downloads, atau Pictures, menolak path relatif/UNC/perangkat, dan tetap memakai gerbang file rahasia. Di HP hanya-lihat/Tailscale tetap ditolak untuk path luar project.
- **Sesi baru kini benar-benar bersih.** Klik **＋ Sesi baru** mengosongkan kolom chat project, bukan hanya menambah pembatas. Transkrip sesi lama tetap tersedia di **Riwayat sesi**; yang dibersihkan hanya panel chat dan file chat aplikasi.
- **Handoff jadi konteks sesi (bukan file).** Di dialog 🔁 Lanjutkan dari mesin lain, **Jadikan konteks sesi** menyimpan catatan handoff di memory sesi project: tidak mengirim prompt, tidak mengubah `CLAUDE.md`/`AGENTS.md`, dan tidak membuat bubble chat. Konteks ditempelkan sekali pada pesan berikutnya, lalu hilang saat sesi baru/ganti mesin. **Masukkan ke kotak pesan** tetap ada untuk yang ingin mengirim sebagai prompt.
- **Empty state & banner lebih tenang.** Teks sambutan dan placeholder dipersingkat, starter jadi grid 2×2, status “Standby” di kartu karyawan yang idle disembunyikan, label akun menjadi avatar saja, dan banner status dibuat lebih tipis.
- **Label mesin mengikuti project.** Empty state, cuplikan dashboard, tooltip sesi, dan Mode tim tidak lagi menyebut Claude saat project memakai OpenCode. Path folder pindah ke tooltip header agar top bar lebih tenang.
- **Header & layar utama lebih ringkas.** Notifikasi dan Bantuan pindah ke menu **⋯** di header desktop, chip pengaturan tidak lagi mengulang nama mesin, empty state memakai 3 starter, kartu karyawan cukup satu baris, dan panel chat default sedikit lebih lebar (420 px).
- **Ledger pemakaian & audit tidak tumbuh tanpa batas.** `data/usage.jsonl` dirotasi otomatis ke `data/usage-archive/` (tetap dibaca laporan dan ikut backup, termasuk saat import), dan `auth-audit.jsonl` dipadatkan ke 180 hari/maks 2.000 aksi. Query laporan memakai cache yang diperbarui saat file berubah.
- **Model Auto tidak macet saat berganti model.** Pergantian model (mis. Auto → `kimi-k3.1-pro` + effort high) sekarang **ditunggu selesai sebelum prompt dikirim**; sebelumnya prompt berjalan bersamaan dengan switch model sehingga giliran bisa diam tanpa jawaban. Ada test regresi dengan switch model yang sengaja diperlambat.
- **Volume Spotify tidak tertinggal pelan.** Setelah izin dijawab, volume dikembalikan juga bila nilainya sempat bergeser sedikit di bawah batas duck (sebelumnya harus sama persis, jadi musik bisa tertinggal nyaris mati). Fitur *kecilkan saat izin* tetap opsional dan **default mati**; setelan kamu sekarang dimatikan.
- **Auto menilai ulang dengan konteks rencana.** Classifier Effort/Model Auto kini menerima percakapan terakhir dan daftar rencana/todo, jadi prompt lanjutan seperti “kerjakan” dinilai dari rencana yang baru muncul — bukan dari satu kata.
- **Handoff Pintar benar-benar jalan.** Mode **🧠 Pintar** di *🔁 Lanjutkan dari mesin lain* sebelumnya menggantung sampai batas 4 menit lalu gagal, karena `opencode run` / `claude -p` menunggu input stdin yang tidak pernah ditutup. Sekarang catatan handoff selesai dalam hitungan detik dan masuk ke kotak pesan seperti mode Cepat.
- **Effort Auto memakai model (LLM), bukan hanya aturan lokal.** Penyebabnya sama: classifier OpenCode/Claude menunggu stdin, kehabisan waktu 25 detik, lalu diam-diam jatuh ke perkiraan lokal. Kini level effort benar-benar dinilai oleh model yang sedang aktif.

## 2026-11-04

### Baru

- **Pencarian percakapan Claude + OpenCode.** 🔎 Cari percakapan sekarang mencari di sesi Claude **dan** OpenCode, per project atau semua project. Hasil dari mesin lain bisa langsung dilanjutkan; app menawarkan pindah mesin bila perlu.
- **Plugin OpenCode dari app.** ⚙ → tab **Sistem** → **Plugin OpenCode**: lihat plugin terpasang, tambah dari paket npm/Git, hapus, update satu/semua, dan cek update lewat CLI OpenCode — tanpa membuka terminal.
- **Effort Auto (LLM).** Pilihan Effort baru menilai kompleksitas setiap prompt dengan **model yang sedang aktif** (Default mengikuti default mesin) sebelum giliran mulai. Badge `Auto: High` muncul di prompt, antrian menyimpan levelnya, dan effort manual tidak memakai token classifier.
- **OpenCode tanpa CLI.** Dari ⚙ → tab **Sistem** → Kompatibilitas OpenCode ada **⬆ Update OpenCode** (`opencode upgrade`) dan **↻ Restart layanan OpenCode** (`opencode service restart`). Di **🕘 Riwayat sesi**, OpenCode punya **⬆ Import JSON** untuk file hasil export. Di HP, **🔁 Lanjutkan dari mesin lain** kini muncul di sheet ⋯.

### Diperbaiki

- **Kantor di HP landscape.** Empat baris banner (koneksi, Claude, OpenCode, update) kini punya baris grid sendiri; sebelumnya satu banner yang tidak ditempatkan membuat tinggi area kantor menjadi 0, sehingga ilustrasi, Mode Otak, dan daftar karyawan tidak terlihat.
- **Handoff Pintar memakai mesin & model aktif.** Mode Pintar di *Lanjutkan dari mesin lain* memakai token dan model yang sedang aktif di sesi chat, bukan mesin sumber yang parkir atau model yang dipatok dari setting, jadi kuota/langganan mesin lain tidak terpakai.
- **Status Effort Auto terlihat.** Saat Auto sedang menentukan effort, chat menampilkan indikator **Menentukan effort...** dengan animasi, jadi prompt tidak terkesan belum terkirim.
- **Pengaturan desktop lebih ringkas.** Dialog ⚙ Pengaturan di laptop kini dibagi menjadi tab **Umum, Tim & izin, Notifikasi, Spotify, Cadangan, dan Sistem**; hanya isi tab yang bergulir. Di HP tampilannya tetap satu daftar panjang seperti sebelumnya.
- **Batas mesin lebih jelas.** Saat mesin OpenCode aktif, dialog khusus Claude Code—aturan izin, plugin/agent/hooks, dan export sesi lengkap—disembunyikan. Pencarian percakapan tetap tersedia. Route-nya juga menolak (409), jadi tidak ada lagi perubahan config Claude yang tidak sengaja dari mode OpenCode. OpenCode memakai `opencode.json` dan export JSON di Riwayat Sesi.
- **Mode OpenCode disederhanakan.** Pilihan Izin di mesin OpenCode kini hanya **Build** dan **Plan**, mengikuti dua mode native OpenCode. Build tetap memakai kartu izin app; Plan memakai agent plan yang read-only.
- **Usage OpenCode lebih lengkap.** Token dan biaya sesi terminal OpenCode ikut dicatat ke laporan. Akun OpenCode menampilkan pemakaian lokal hari ini/7 hari dengan catatan bahwa sisa kuota provider tidak tersedia dari OpenCode.

## 2026-11-01 – 2026-11-02

### Baru

- **💰 Batas antrian.** Maks token output dan/atau maks biaya (USD, estimasi) per project untuk 📋 Antrian; antrian berhenti sendiri saat batas tercapai, tanpa memotong giliran yang berjalan.
- **🔔 Pengaturan notifikasi.** Notifikasi dan suara per jenis kejadian, 🌙 jam tenang, hanya project favorit, volume. Disimpan per perangkat.
- **🎤 Input suara** (`Alt+M`), Indonesia/English, di HTTPS atau localhost.

- **🔔 Notifikasi push ke HP.** Notifikasi minta izin, selesai, error, dan antrian berhenti tetap muncul walau aplikasi ditutup. Di Android ada tombol **Tolak** (dan **Izinkan** untuk baca/edit file) langsung di notifikasi; di iPhone ketuk untuk membuka kartu izinnya. Butuh jalur HTTPS di bawah. [Setup](README.md#notifikasi-push-ke-hp)
- **🔒 HTTPS lewat Tailscale** di `https://<nama-laptop>.<tailnet>.ts.net:4318`, dengan sertifikat dari `tailscale cert` yang diperbarui otomatis. Jalur ini juga membuat 🎤 input suara bisa dipakai di HP.
- **♪ Spotify.** Pill lagu di header, radio di lounge kantor, dialog ♪ Musik (kontrol, volume, perangkat, playlist, putar mulai dari lagu tertentu). ▶ tanpa perangkat aktif membuka Spotify di laptop di latar belakang. Bisa mengecilkan atau menjeda musik saat ada izin yang menunggu. Login dengan Client ID saja (PKCE, tanpa client secret). [Setup](docs/FITUR.md#musik-spotify)
- **🗂 Semua project.** Dashboard semua project dalam satu layar, yang butuh kamu di atas.
- **⚠ Deteksi macet.** Chip peringatan untuk tool tanpa output 3 menit, tool yang berjalan 10+ menit, dan delegasi tanpa aktivitas 5 menit, dengan tombol Hentikan / Pindah ke latar / Lihat detail.
- **📎 Lampiran file teks, log, dan PDF**, bukan hanya gambar. Lampiran ikut saat ↻ Ulangi dan Edit, dan tetap di draf saat pindah project.
- **👮 Role Compliance / Privacy (DPO).** Tim bawaan sekarang 17 role + Lead.
- **📱 Tampilan HP minimalis** untuk semua tab: header ringkas dengan ⋯, kotak pesan lebar penuh dengan ＋ dan chip pengaturan, serta **mode landscape**.

### Berubah

- **🏢 Kantor** menjadi satu lantai tetap 640×344 dengan ruang kaca dan pod kubikel per departemen. Role yang dimatikan meninggalkan meja kosong; ruangan tidak lagi berubah ukuran.
- **💾 Riwayat chat** per project pindah ke `data/chats/*.jsonl` (bukan `state.json`) dan sekarang ikut backup. Data lama dipindahkan otomatis saat start; salinan `state.json.bak-chats-*` disimpan dulu.
- Label baris tool di chat lebih manusiawi, termasuk di riwayat lama.

### Diperbaiki

- **Banyak tab tidak macet lagi:** semua tab berbagi satu koneksi live ke server.
- Chat kembali mengikuti pesan terbaru setelah pindah project dengan cepat.
- Request dengan URL rusak tidak lagi membuat server crash.
- Biaya per giliran dihitung benar (dipakai batas antrian).
- **Firewall:** `setup.cmd` kini membuka TCP 4317 **dan** 4318 (HTTPS) untuk alamat Tailscale, dan mengganti aturan lama yang hanya membuka 4317. Sebelumnya HTTPS `:4318` dari HP terblokir.

### Keamanan & privasi

- Lewat WiFi (HTTP, hanya lihat), server tidak lagi mengirim email/nama/organisasi akun Claude, daftar HP yang dipasangkan, nama perangkat Spotify, dan nama HP yang menjawab izin.
- Pairing HTTPS terikat ke jalur HTTPS (cookie `__Host-`), dan tidak berlaku di HTTP.

### Perlu dilakukan

- **Notifikasi push:** nyalakan *HTTPS Certificates* di admin console Tailscale, lalu pasangkan HP sekali lagi lewat **🔒 Tailscale (HTTPS)**. Pairing lama lewat WiFi/Tailscale-http tetap jalan.
- **Jalankan `setup.cmd` lagi** (minta izin Administrator sekali) supaya aturan firewall membuka port 4318. [Troubleshooting](README.md#kalau-hp-tidak-tersambung)
- **Tim yang sudah pernah disimpan** tidak berubah: aktifkan Compliance lewat 👥 Kelola tim, atau ↺ Tim bawaan.
- **Spotify** opsional: hanya aktif setelah Client ID diisi di ⚙.
