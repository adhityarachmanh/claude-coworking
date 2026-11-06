# Changelog

Perubahan yang terasa oleh pengguna. Detail fitur ada di [README](README.md); panduan harian di [docs/PANDUAN.md](docs/PANDUAN.md).

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
