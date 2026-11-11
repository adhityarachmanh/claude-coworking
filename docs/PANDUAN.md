# Panduan harian Adhitron

Panduan singkat untuk pemakaian sehari-hari, di laptop dan HP. Detail tiap fitur ada di [FITUR](FITUR.md); cara menjalankan dan keamanan ada di [README](../README.md).

Belum terpasang? Ikuti [Mulai cepat](../README.md#mulai-cepat) dulu. Kalau Node.js atau CLI belum ada, buka **🧰 Persiapan** di ⚙ → Sistem: Adhitron menawarkan pemasangan Node.js, Claude Code, OpenCode, dan Tailscale tanpa admin.

## Mulai kerja di laptop

1. Buka `http://localhost:4317`.
2. Klik nama project di kiri atas (atau `Ctrl+K`), lalu pilih project. Tandai yang sering dipakai dengan ☆.
3. Ketik permintaan di chat, lalu **Enter**. `Shift+Enter` untuk baris baru.
4. Saat tim mau mengedit file atau menjalankan perintah, kartu izin muncul. Pilih **Izinkan**, **Izinkan selalu**, atau **Tolak**.
5. Cek hasilnya di tab **Perubahan**, lalu **Commit**.

Tips:

- Tekan `?` untuk daftar shortcut, atau `Ctrl+P` untuk mencari aksi apa saja. Di palet, `@kata` mencari file di project ini **dan** project lain (nama project tampil di keterangan). Cari juga **Checklist project** dan **Bundel diagnostik** di sana.
- Antrian 📋 bisa disimpan sebagai **📚 Runbook** lalu diedit (nama + prompt, ada contoh siap pakai dan riwayat versi) dan dijalankan lagi kapan saja; dari daftar runbook bisa diganti nama, dijadwalkan harian (⏰), atau **↻ Lanjutkan** bila ada item yang gagal. Tab ⚙ → Jadwal menampilkan kalender 7 hari.
- Project yang jarang dipakai bisa diarsipkan lewat **📦** di daftar project; toggle 📦 di judul dialog menampilkannya lagi.
- Riwayat sesi bisa dirapikan dengan **🏷 tag** (ikut tercari, ada chip penyaring) dan **📦 arsip** (disembunyikan dari daftar utama, tetap bisa dilanjutkan); **Arsip otomatis** bisa menyembunyikan sesi yang tidak dipakai 30/90/180 hari. Centang beberapa sesi untuk memberi tag atau mengarsipkan sekaligus.
- Ingin Claude bekerja tanpa ditunggui? Ganti mode dengan `Shift+Tab`: **🔨 Build** mengubah file otomatis (perintah shell & jaringan tetap minta izin), **📋 Plan** hanya menyusun rencana.
- Pekerjaan berurutan? Masukkan ke **📋 Antrian** (`Alt+Enter`). Lihat [Antrian & batas](FITUR.md#antrian--batas).
- Mau melihat antrian semua project sekaligus? Buka **🌐 Semua** di dialog 📋 Antrian (atau `Ctrl+P` → *Semua antrian*): **Buka** melompat ke antrian project itu, **Batal** membatalkan item yang masih menunggu. ETA `±X mnt` / `sebentar` di bubble **antre #N** hanya perkiraan, dan **Edit** pada bubble itu mengubah prompt yang masih antre di tempat, tanpa item kedua.

## Menjawab izin dari HP

**Sekali saja:**

1. Pasang Tailscale di laptop dan HP, login dengan akun yang sama.
2. Di laptop: **📱** → centang **Izinkan akses dari HP** → pilih **🔒 Tailscale (HTTPS)** → scan QR dari HP. Kalau pilihan itu belum ada, ikuti langkah [Notifikasi push ke HP](../README.md#notifikasi-push-ke-hp) dulu.
3. Pasang sebagai aplikasi: Android lewat menu ⋮ → *Install app*; iPhone lewat Bagikan → **Tambahkan ke Layar Utama**, lalu buka dari ikon itu dan masukkan kode pairing sekali lagi.
4. Di HP: **🔎 Cari** → *Pengaturan notifikasi* → **📱 Notifikasi HP (push)** → **Aktifkan** → **Kirim tes**.

**Setiap hari:**

- Notifikasi *minta izin* muncul walau aplikasi ditutup.
- **Android:** tekan **Tolak** langsung dari notifikasi. **Izinkan** dari notifikasi hanya ada untuk baca/edit file; perintah terminal selalu dibuka di aplikasi dulu.
- Tidak ingin diganggu project tertentu? Di 🔔 Pengaturan notifikasi centang project itu pada **🔇 Project dibisukan**; suara dan pop-up-nya diam, termasuk di HP.
- **iPhone:** ketuk notifikasinya. Aplikasi terbuka tepat di kartu izinnya.
- Di aplikasi, jawab lewat kartu izin seperti di laptop.

Lewat WiFi rumah biasa (tanpa Tailscale), HP **hanya bisa melihat**. Itu disengaja: koneksi WiFi biasa tidak terenkripsi. Lihat [Dari HP](../README.md#dari-hp).

## Izin sesi terminal (CLI bridge, eksperimental)

1. Pastikan Adhitron berjalan dan folder kerja terdaftar sebagai project.
2. Di terminal folder project, jalankan `office claude` (dari folder repo ini, atau `office.cmd` di PATH).
3. Saat Claude Code meminta izin untuk tool berbahaya, kartu **Terminal · CLI bridge** muncul di kantor/HP. Jawab **Izinkan** atau **Tolak** di aplikasi.
4. Kalau server mati, hook gagal, atau tidak dijawab ±2 menit, izin kembali ke **prompt terminal**—tidak pernah otomatis diizinkan.
5. Izin CLI tidak bisa di-allow dari layar kunci; buka aplikasi untuk melihat perintah/path yang sudah dipotong.

Status: **belum dirilis** sampai uji TUI manual selesai. Batasan lengkap: [CLI bridge](FITUR.md#cli-bridge-eksperimental).

## Memutar musik

**Sekali saja, di laptop:** ⚙ → **♪ Spotify**. Ikuti 4 langkah di sana (buat app di developer.spotify.com, salin Redirect URI, tambahkan email Spotify-mu, tempel Client ID), lalu **🔗 Hubungkan**. Butuh Spotify Premium. Detail: [Musik (Spotify)](FITUR.md#musik-spotify).

**Setiap hari:**

- Tekan ▶ di pill lagu (header) atau di radio di lounge kantor. Kalau Spotify belum terbuka di mana pun, aplikasi Spotify di laptop dibuka di latar belakang lalu langsung memutar.
- Klik pill lagu untuk dialog **♪ Musik**: ganti lagu, volume, pilih perangkat, atau buka **Playlist** dan pilih lagu.
- Ingin selalu memutar di perangkat tertentu? Tekan ☆ *Selalu putar di sini* di daftar perangkat.
- Mau musik mengecil saat ada izin yang menunggu? Atur *Saat ada permintaan izin* → **Kecilkan** atau **Jeda**.
- Dari HP lewat Tailscale bisa mengontrol. Lewat WiFi hanya melihat lagu yang diputar.

## Melihat semua project

- Laptop: klik **🗂 Semua project** di header (atau `Ctrl+P` → *Semua project*).
- HP: ketuk bar **🗂 Semua project** di atas tampilan **Kantor**. Ringkasannya, misalnya *1 butuh kamu · 2 bekerja*, langsung terlihat.

Yang **butuh kamu** selalu di atas: izin yang menunggu, giliran terputus, atau yang mungkin macet. Ketuk **✋ Lihat izin** untuk langsung ke kartu izinnya. Detail: [Project & dashboard](FITUR.md#project--dashboard).

Project yang foldernya sudah dipindah/dihapus ditandai **folder hilang** dan bisa dibersihkan lewat 🗑 di daftar project (project custom tetap terdaftar setelah restart/refresh). Yang dihapus hanya data aplikasi (pengaturan, riwayat chat kedua mesin, antrian, baris laporan token); folder di disk dan file backup tidak disentuh. Project yang foldernya masih ada ditolak, dan HP yang hanya-lihat tidak bisa menghapus.

## Melihat pemakaian per mesin

1. Buka **📊 Laporan** (avatar akun, atau `Ctrl+P` → *Laporan*).
2. Pilih **Semua akun (Claude + OpenCode)** untuk melihat kedua mesin sekaligus, atau satu akun saja.
3. Pilih periode: Hari ini, 7 hari, 30 hari, Bulan ini, Semua, atau tanggal sendiri.
4. Di atas kartu ringkasan ada **“Dibanding periode sebelumnya (sama panjang)”**: persentase naik/turun **token** dan **biaya** dibanding rentang tepat sebelum periode yang dipilih (muncul saat rentang mulai jelas, bukan “Semua”).
5. Di bagian **Per mesin** lihat baris **Claude · Web**, **Claude · Terminal**, **OpenCode · Web**, dan **OpenCode · Terminal**.
   - **Total** = token untuk kelompok itu, **%** = bagiannya dari seluruh laporan.
   - **Biaya** `—` berarti belum ada catatan biaya untuk kelompok itu; `$0.00` berarti model gratis (biasanya OpenCode).
   - Angka dalam tanda kurung, misalnya `$1.20 (87%)`, berarti hanya 87% catatan di kelompok itu yang punya biaya.
6. **⬇ Unduh PDF** memuat tabel yang sama dengan rincian lebih lengkap (per mesin × sumber, per project, sesi teratas). **⬇ CSV** mengunduh angka per periode (input, output, cache, total token, biaya) untuk diolah di spreadsheet.

Rincian **per role** tersedia di laporan: token, persentase, biaya, dan delegasi per role (termasuk Lead), dengan baris cakupan yang jujur. Detail: [Akun & laporan](FITUR.md#akun--laporan).

## Meringkas konteks percakapan

Kalau percakapan makin panjang dan status konteks mendekati batas:

1. Klik **🧹** di status konteks (atau ketik `/ringkas`).
2. (Opsional) isi **Fokus**, misalnya *pertahankan keputusan API dan file yang diubah*. Fokus ini hanya dipakai Claude Code.
3. Klik **Ringkas**. Tunggu indikator *Memadatkan konteks percakapan…* sampai selesai.
4. Percakapan di panel chat tetap utuh; yang diringkas adalah konteks yang dikirim ke mesin.

Tombol ini tidak bisa dipakai saat tim sedang bekerja, ada izin yang menunggu jawaban, atau rewind berjalan. Dengan OpenCode, tombol hanya jalan kalau sesinya menyediakan `/compact`; kalau tidak, muncul penjelasan. Detail: [Tanpa terminal](FITUR.md#tanpa-terminal).

## Melihat harga saat memilih model

1. Buka chip **⚙ Pengaturan giliran** di atas kotak chat (di HP di bawah teks).
2. Buka daftar **Model**. Setiap model menampilkan biaya per 1 juta token bila diketahui:
   - model **OpenCode Go**: `— $0.15 in / $0.60 out /1M`; tanda `±` berarti ada tarif lebih tinggi pada jam sibuk (arahkan kursor ke model untuk detail).
   - model **Claude** atau lainnya: `— ≈$1.23/1M tercatat`, dihitung dari biaya pemakaian yang sudah tercatat (90 hari terakhir), bukan harga list.
   - `— gratis` untuk model gratis.
3. Baris kecil di bawah daftar menjelaskan sumber angkanya. Kalau tertulis *Belum ada data harga*, model itu belum pernah dipakai dan tidak punya harga list.

Harga OpenCode Go diambil dari katalog resmi `opencode.ai` dan disimpan di folder data aplikasi; pembaruan gagal (offline) tidak mengganggu pemilihan model. Detail: [Tanpa terminal](FITUR.md#tanpa-terminal).

## Memakai Model Auto

1. Buka chip **⚙ Pengaturan giliran** → daftar **Model** → pilih **Auto — sesuaikan task**.
2. Setiap prompt dinilai dulu (satu panggilan yang sama dengan Effort Auto) memakai **model tier Seimbang** — bukan model aktif. Classifier memilih **level** untuk model dan **effort** thinking secara terpisah, lalu model giliran dipilih dari tangga:
   - **Hemat** untuk pertanyaan/typo/perubahan kecil,
   - **Seimbang** untuk bug fix dan fitur kecil,
   - **Kuat** untuk pekerjaan multi-file/refactor,
   - **Maks** untuk tugas paling berat.
   Effort bisa berbeda: refactor yang sudah jelas bisa `Kuat` + `medium`, bug yang belum jelas bisa `Seimbang` + `high`.
3. Di chat muncul `🤖 Model Auto: Seimbang → sonnet` saat model berganti. Pilihan model di daftar ikut berubah.
4. Memilih model tertentu (atau **Default**) mematikan Auto. Saat tim sedang bekerja, model tidak diganti di tengah giliran.
5. **Atur tangga…** (di bawah pilihan model saat Auto aktif): pilih model untuk **Hemat / Seimbang / Kuat / Maks** per mesin, atau **Bawaan** untuk kembali ke default. Berlaku untuk Claude Code dan OpenCode.
6. Alasan pilihan Auto muncul di chat (`🤖 Model Auto: Kuat → deepseek-v4-pro — multi-file bug fix`) dan pada badge Effort Auto. Baris `±$…` di atas kotak pesan adalah estimasi biaya prompt (konteks + teks + asumsi output), bukan tagihan pasti.

- **Model Auto** kini menilai setiap prompt **bersama konteks rencana terakhir**: percakapan terakhir dan daftar todo/plan ikut dikirim ke classifier, jadi prompt lanjutan singkat seperti *“kerjakan”* atau *“lanjut”* dinilai dari rencana yang baru muncul, bukan dari satu kata. Detail: [Tanpa terminal](FITUR.md#tanpa-terminal).

## Mengulangi perubahan setelah rewind

Kalau salah rewind (kode):

1. Buka dialog **⏪ Rewind** lagi. Bagian **↩ Ulangi perubahan (redo)** menampilkan rewind terakhir.
2. Klik untuk melihat pratinjau: file mana yang akan **dikembalikan** dan mana yang akan **dihapus**.
3. File yang kamu ubah setelah rewind ditandai **bentrok** dan **dilewati**. Centang **“Timpa file yang sudah saya ubah”** hanya jika kamu yakin.
4. Klik **↩ Ulangi**. Salinan file saat ini disimpan dulu di `data/redo/` sebelum ditimpa.

Batasan: redo kode hanya untuk **perubahan kode yang belum di-commit** di **repo git**; rewind kode di folder non-git ditolak sejak awal (tidak ada yang berubah).

**Pulihkan percakapan**: di bagian redo yang sama, klik **🔄 Pulihkan percakapan**. Untuk Claude Code, percakapan kembali ke posisi terakhir (transkripnya memang tidak dihapus). Untuk OpenCode, app memulihkan **salinan** percakapan sebagai **sesi baru** — sesi lama yang sudah dihapus tidak kembali, tetapi isi percakapannya tersedia lagi.

## Melihat sisa kuota OpenCode Go

1. Buka **👤 Akun** → tab **OpenCode**.
2. Gulir ke **Kuota OpenCode Go**. Kalau kredensial **OpenCode Console** tersedia, panel menampilkan **Data resmi OpenCode**: paket, masa aktif, dan tiga bar **Rolling / Weekly / Monthly** dengan persentase terpakai dan hitung mundur reset—sama seperti halaman akun OpenCode. Di atasnya, kartu **Pemakaian OpenCode** menampilkan **biaya, request, dan token** untuk **Hari ini** dan **7 hari** dari endpoint usage resmi; buka **Rincian per model** untuk request/input/cache/output/biaya tiap model, atau **📡 Request terbaru** yang tampil **di dalam dialog Akun** untuk detail per request (durasi, TTFT, token, biaya, status).
3. Kalau data resmi tidak tersedia, panel memakai perkiraan manual: pilih paket **Go ($10/bulan)**, **Go Plus ($40/bulan)**, atau **Go Teams ($20/anggota/bulan)**. Tiap model menampilkan **terpakai / batas**, **sisa**, dan tiga bar **5 jam / 7 hari / 30 hari**.
   - Hijau < 70%, kuning 70–90%, merah > 90%.
   - `tak terbatas` untuk model gratis; `batas belum diketahui` untuk model yang tidak ada di tabel paket itu.
4. Aktivitas harian, daftar model, dan **biaya provider maksimal 5 sesi teratas** dari provider juga ada di **📊 Laporan → OpenCode Go — data provider**, bukan di panel kuota. Angka perkiraan lokal tetap dipakai hanya saat data resmi tidak tersedia. Di **🕘 Riwayat sesi**, tombol **📡** membuka request khusus sesi OpenCode itu, dengan **total provider** (request/token/biaya) dan pembanding total ledger sesi.

Detail: [Akun & laporan](FITUR.md#akun--laporan) · [Privasi & data pribadi](privasi-data.md).

## Mengatur budget pemakaian

1. Buka ⚙ → tab **Umum** → **Budget pemakaian global**.
2. Isi batas **Harian**, **Mingguan**, dan/atau **Bulanan** dalam USD. Kosongkan (atau isi 0) untuk mematikan batas itu.
3. Klik **Simpan**. Ringkasan menampilkan `$12,30 / $20 (62%)`, bar hijau/kuning/merah (≥80% kuning, ≥100% merah), dan **sisa** dolar.
4. Angka ini juga muncul di 🩺 **Kesehatan sistem**.

Catatan: dihitung dari **biaya yang tercatat** (harga list untuk Claude). OpenCode Go adalah langganan, jadi biayanya umumnya tercatat $0 dan tidak banyak memengaruhi budget. Budget ini **hanya peringatan**, tidak menghentikan giliran atau antrian.

## Perintah cepat & mode fokus

- Ketik `/hemat`, `/seimbang`, `/kuat`, atau `/maks` untuk langsung memakai model tier itu (untuk mesin yang aktif). Auto dimatikan agar pilihan tidak berubah; `/auto` menyalakannya lagi.
- Ketik `/fokus` untuk menyembunyikan dan menghentikan animasi kantor. Chat dan panel memakai seluruh layar; tombol **Keluar mode fokus** mengembalikannya. Pilihan diingat di perangkat itu.

## Mesin mengikuti model

1. Buka project yang diinginkan, lalu klik chip **⚙ Pengaturan giliran** di atas kotak pesan.
2. Di **Model**, pilih model dari grup **Claude Code** atau **OpenCode**. Memilih model mesin lain langsung memakai mesin itu untuk giliran berikutnya; tidak ada tombol ganti mesin.
3. Project lain tidak terpengaruh; dua project boleh berjalan bersamaan dengan mesin berbeda.
4. Chat menampilkan satu alur dari kedua mesin. Saat mesin berganti, ringkasan percakapan mesin sebelumnya dibawa otomatis (satu baris `🔁 Konteks dari …`) dan status **🧠 Konteks siap** muncul sampai pesan berikutnya. Ringkasan ini bukan salinan percakapan, dan kuota serta rewind tetap milik masing-masing mesin.
5. Model mesin lain ditolak (**409**) bila project sedang bekerja, ada izin/rencana menunggu, antrean berisi item, ada giliran terputus, atau rewind berjalan — selesaikan dulu.

Kembali ke mesin sebelumnya melanjutkan sesi aslinya; pengaturan model/effort/agent tiap mesin tetap diingat. Di **👤 Akun** ada dua tab info, **Claude** dan **OpenCode**, yang hanya menampilkan kuota, pemakaian, dan provider.

## Memeriksa kesehatan aplikasi

1. Buka ⚙ → tab **Sistem** → **🩺 Kesehatan sistem**.
2. Baca ringkasan di atas: **Siap dipakai (X/N)** atau **Perlu perhatian**.
3. **Pemeriksaan**: akun Claude, OpenCode, folder project, backup otomatis, akses HP + HTTPS, error server 24 jam, ukuran data. Hijau = aman, kuning = perlu perhatian, merah = gagal.
4. **Persiapan**: checklist login, folder project, backup otomatis, HTTPS, OpenCode — lengkapi yang masih kosong.
5. Klik **↻ Periksa ulang** setelah memperbaiki sesuatu. Laporan terakhir tetap terlihat bila refresh gagal.

Di bagian **Aktivitas 7 hari** kamu bisa melihat tren giliran, antrian, dan berapa kali kena batas selama sepekan; baris **Hari ini** merangkumnya dalam satu kalimat, dan hari tanpa sampel tunggu ditulis `—`.

Hanya dari laptop atau Tailscale; di HP WiFi biasa tombol ini tidak muncul. Detail: [Pengaturan](FITUR.md#tanpa-terminal).

## Mengganti akun dengan aman

1. Buka **👤 Akun** (avatar di header).
2. Klik **Login** atau **Logout**. Muncul ringkasan dampak:
   - berlaku untuk **seluruh Claude Code di laptop**,
   - giliran yang sedang berjalan dibiarkan selesai dulu,
   - **semua antrian dijeda** sampai kamu memeriksanya,
   - sesi terminal perlu dibuka ulang.
3. Batal = tidak ada yang berubah. Lanjutkan = proses login/logout berjalan.
4. Periksa chip antrian: kalau tertulis *dijeda karena akun berubah*, buka 📋 Antrian, cek model/akun, lalu **Lanjutkan**.
5. Lihat **Riwayat perubahan akun** di dialog yang sama untuk memastikan siapa (laptop/HP) dan kapan perubahan terjadi.

**OpenCode:** logout provider juga butuh konfirmasi `LOGOUT`. Kalau model aktif berasal dari provider itu, model tidak diganti otomatis — pilih model lain atau **Default** dulu; sebelum itu prompt berikutnya ditolak dengan penjelasan.

## Mengubah config atau agent OpenCode

Hanya dari laptop. Dari HP (termasuk lewat Tailscale) editor ini tidak terbuka.

1. Buka ⚙ → tab **Sistem** → **🧩 Config & Agent OpenCode**.
2. Pilih **Project ini** atau **Global**. Path file yang sedang diedit tampil di atas editor.
3. Ubah **Model**, **Small model**, dan **Agent** lewat tab **Form**, atau seluruh file lewat tab **JSON**. Klik **Simpan**.
4. Tunggu sampai tidak ada giliran yang berjalan; editor menolak menyimpan, memulihkan, atau menggabungkan selama tim masih bekerja.

**Kalau muncul banner kuning** (artinya ada lebih dari satu file config):

- Baca daftar di banner: OpenCode membaca file berurutan, dan nilai dari file **terakhir** yang menang per kunci. File yang bertanda *dipakai OpenCode* itulah yang berlaku.
- Aplikasi hanya mengubah `opencode.json` project (atau file global). File lain tidak ikut berubah.
- Mau semuanya jadi satu file? Klik **Konsolidasi ke file ini**: isi `.opencode/opencode.json` digabung ke `opencode.json` (nilai `.opencode` menang), lalu file `.opencode` dipindah ke folder backup aplikasi dengan awalan `dot--`—tidak dihapus, tetapi **tidak muncul di 🕘 Riwayat backup**. Itu salinan untuk pemulihan manual di folder data aplikasi.
- Konsolidasi aman kalau kamu memang ingin satu file saja untuk project itu. Kalau `.opencode/opencode.json` sengaja dibagikan ke tim lewat git, bicarakan dulu: setelah konsolidasi file itu tidak ada lagi di folder project (salinannya ada di folder backup aplikasi dengan awalan `dot--`).
- Kalau yang dobel hanya `opencode.json` dan `opencode.jsonc` di folder yang sama, tombol Konsolidasi tidak muncul. Cukup rapikan sendiri: OpenCode memang hanya membaca `.json`.

**Melihat atau memulihkan versi lama:**

1. Buka editor yang sama, lalu buka **🕘 Riwayat backup**.
2. Pilih satu baris → **Pratinjau** untuk membaca isinya tanpa mengubah apa pun.
3. Klik **Pulihkan**, lalu konfirmasi. Isi yang sekarang dibackup lebih dulu, jadi masih bisa dikembalikan.
4. Baris bertanda *tidak valid* (file rusak) tidak bisa dipulihkan; tombolnya mati.
5. Aplikasi menyimpan **10 backup terakhir per file** selama **90 hari** di folder data aplikasi. File `.bak-*` lama tetap muncul dengan tanda *format lama* dan tidak pernah dihapus aplikasi.

**Kalau muncul *"File berubah di luar aplikasi…"*** (saat menyimpan, memulihkan, atau menggabungkan): file config diubah di luar aplikasi—atau editor sudah lama terbuka—jadi tidak ada yang ditulis. Klik **↻ Muat ulang**, cek perubahannya, lalu ulangi. Detail: [Mesin: Claude Code atau OpenCode](FITUR.md#mesin-claude-code-atau-opencode).

## Kalau terasa macet

| Yang terlihat | Yang dilakukan |
|---|---|
| Chip *⚠ Tidak ada output 3 mnt — mungkin macet* | Build atau test yang lama memang wajar. Kalau yakin macet: **⧗ Pindah ke latar** (perintah tetap jalan, kamu bisa lanjut chat) atau **■ Hentikan giliran** |
| Chip *⚠ <role> tidak ada aktivitas 5 mnt* | **Lihat detail** untuk melihat langkah terakhir subagent itu, lalu putuskan |
| Tim diam, tidak ada chip | Cek kartu izin yang menunggu (gulir chat, atau 🗂 Semua project) |
| *"… giliran terputus"* setelah restart | **▶ Lanjutkan** meneruskan di sesi yang sama. Tidak ada yang dikirim otomatis |
| Antrian tidak jalan | Buka 📋 Antrian: mungkin dijeda (setelah restart, item gagal, kuota habis, atau batas tercapai). Tekan **Lanjutkan** |
| Laptop terasa berat saat banyak project bekerja | Turunkan **⚙ → Umum → ⚡ Batas giliran bersamaan** (0–8; 0 = tanpa batas). Prompt ke project lain tampil sebagai bubble **antre #N** (bisa **✕ Batal**) dan jalan FIFO; giliran yang sedang berjalan tidak dipotong |
| Halaman tidak update / banyak tab terbuka | Muat ulang halaman. Semua tab berbagi satu koneksi, jadi menutup tab lain tidak perlu |
| HP tidak tersambung | Lihat [Kalau HP tidak tersambung](../README.md#kalau-hp-tidak-tersambung) |

`Esc` selalu menghentikan giliran yang berjalan. Deteksi macet hanya memberi peringatan, tidak pernah menghentikan apa pun sendiri.

## Pindah laptop atau backup

**Rutin:** ⚙ → **💾 Cadangkan riwayat** → **⏰ Backup otomatis**. Pilih Harian/Mingguan, jam, folder tujuan (mis. `D:\Backup\adhit-office`), dan berapa backup yang disimpan, lalu **💾 Simpan jadwal**.

Kalau pemeriksaan **Backup otomatis** di 🩺 berwarna kuning, buka ⚙ → Cadangkan riwayat, pastikan folder tujuan masih ada, lalu klik **▶ Jalankan sekarang**.

Kalau folder `data/` terasa makin besar, atur **⚙ → Cadangkan riwayat → 🕵️ Data saya → ⏳ Retensi otomatis**: pilih batas chat dan laporan pemakaian (default simpan selamanya), klik **Pratinjau**, lalu **Simpan**. Transkrip sesi dan backup tidak ikut dihapus. Detail: [Retensi data](FITUR.md#retensi-data).

**Pindah laptop:**

1. Laptop lama: ⚙ → Cadangkan riwayat → **⬇ Export riwayat**.
2. Laptop baru: ikuti [Mulai cepat](../README.md#mulai-cepat), login dengan `claude`, dan clone folder project-mu.
3. ⚙ → Cadangkan riwayat → **⬆ Import riwayat**, pilih file `.zip`.
4. Buka project → **🕘 Riwayat sesi** → **Lanjutkan**.

Yang ikut kembali: riwayat chat kedua mesin, **mesin tiap project**, pengaturan model/effort per mesin, **root project efektif dan path tiap project** (jadi project tetap dikenali walau root-nya tidak pernah diatur manual), **sesi OpenCode** (lewat `opencode session export/import`), dan percakapan **Claude** yang tersimpan di backup. Bila OpenCode tidak terpasang saat import, sesi OpenCode dilewati dan project memakai Claude Code.

Yang perlu diulang di laptop baru: login Claude, pairing HP (termasuk notifikasi push), dan menghubungkan Spotify. Mode tiap project kembali ke **Build**.

> Backup adalah **data pribadi**. Pilih enkripsi kata sandi (`.aob`) bila file akan disimpan di tempat yang kurang aman; tanpa kata sandi file `.zip` tidak terenkripsi. Simpan di folder yang hanya kamu akses dan hapus bila tidak perlu. Import hanya menambah, tidak menghapus. Detail: [Backup & riwayat](FITUR.md#backup--riwayat).
