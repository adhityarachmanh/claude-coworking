# Panduan harian Adhit Office

Panduan singkat untuk pemakaian sehari-hari, di laptop dan HP. Detail lengkap ada di [README](../README.md).

Belum terpasang? Ikuti [Mulai cepat](../README.md#mulai-cepat) dulu.

## Mulai kerja di laptop

1. Buka `http://localhost:4317`.
2. Klik nama project di kiri atas (atau `Ctrl+K`), lalu pilih project. Tandai yang sering dipakai dengan ☆.
3. Ketik permintaan di chat, lalu **Enter**. `Shift+Enter` untuk baris baru.
4. Saat tim mau mengedit file atau menjalankan perintah, kartu izin muncul. Pilih **Izinkan**, **Izinkan selalu**, atau **Tolak**.
5. Cek hasilnya di tab **Perubahan**, lalu **Commit**.

Tips:

- Tekan `?` untuk daftar shortcut, atau `Ctrl+P` untuk mencari aksi apa saja.
- Ingin Claude bekerja tanpa ditunggui? Ganti mode izin (`Shift+Tab`). Mode paling aman tetap **🛡️ Tanya dulu**.
- Pekerjaan berurutan? Masukkan ke **📋 Antrian** (`Alt+Enter`). Lihat [Antrian & batas](../README.md#antrian--batas).

## Menjawab izin dari HP

**Sekali saja:**

1. Pasang Tailscale di laptop dan HP, login dengan akun yang sama.
2. Di laptop: **📱** → centang **Izinkan akses dari HP** → pilih **🔒 Tailscale (HTTPS)** → scan QR dari HP. Kalau pilihan itu belum ada, ikuti langkah [Notifikasi push ke HP](../README.md#notifikasi-push-ke-hp) dulu.
3. Pasang sebagai aplikasi: Android lewat menu ⋮ → *Install app*; iPhone lewat Bagikan → **Tambahkan ke Layar Utama**, lalu buka dari ikon itu dan masukkan kode pairing sekali lagi.
4. Di HP: **🔎 Cari** → *Pengaturan notifikasi* → **📱 Notifikasi HP (push)** → **Aktifkan** → **Kirim tes**.

**Setiap hari:**

- Notifikasi *minta izin* muncul walau aplikasi ditutup.
- **Android:** tekan **Tolak** langsung dari notifikasi. **Izinkan** dari notifikasi hanya ada untuk baca/edit file; perintah terminal selalu dibuka di aplikasi dulu.
- **iPhone:** ketuk notifikasinya. Aplikasi terbuka tepat di kartu izinnya.
- Di aplikasi, jawab lewat kartu izin seperti di laptop.

Lewat WiFi rumah biasa (tanpa Tailscale), HP **hanya bisa melihat**. Itu disengaja: koneksi WiFi biasa tidak terenkripsi. Lihat [Dari HP](../README.md#dari-hp).

## Memutar musik

**Sekali saja, di laptop:** ⚙ → **♪ Spotify**. Ikuti 4 langkah di sana (buat app di developer.spotify.com, salin Redirect URI, tambahkan email Spotify-mu, tempel Client ID), lalu **🔗 Hubungkan**. Butuh Spotify Premium. Detail: [Musik (Spotify)](../README.md#musik-spotify).

**Setiap hari:**

- Tekan ▶ di pill lagu (header) atau di radio di lounge kantor. Kalau Spotify belum terbuka di mana pun, aplikasi Spotify di laptop dibuka di latar belakang lalu langsung memutar.
- Klik pill lagu untuk dialog **♪ Musik**: ganti lagu, volume, pilih perangkat, atau buka **Playlist** dan pilih lagu.
- Ingin selalu memutar di perangkat tertentu? Tekan ☆ *Selalu putar di sini* di daftar perangkat.
- Mau musik mengecil saat ada izin yang menunggu? Atur *Saat ada permintaan izin* → **Kecilkan** atau **Jeda**.
- Dari HP lewat Tailscale bisa mengontrol. Lewat WiFi hanya melihat lagu yang diputar.

## Melihat semua project

- Laptop: klik **🗂 Semua project** di header (atau `Ctrl+P` → *Semua project*).
- HP: ketuk bar **🗂 Semua project** di atas tampilan **Kantor**. Ringkasannya, misalnya *1 butuh kamu · 2 bekerja*, langsung terlihat.

Yang **butuh kamu** selalu di atas: izin yang menunggu, giliran terputus, atau yang mungkin macet. Ketuk **✋ Lihat izin** untuk langsung ke kartu izinnya. Detail: [Project & dashboard](../README.md#project--dashboard).

## Melihat pemakaian per mesin

1. Buka **📊 Laporan** (avatar akun, atau `Ctrl+P` → *Laporan*).
2. Pilih **Semua akun (Claude + OpenCode)** untuk melihat kedua mesin sekaligus, atau satu akun saja.
3. Pilih periode: Hari ini, 7 hari, 30 hari, Bulan ini, Semua, atau tanggal sendiri.
4. Di bagian **Per mesin** lihat baris **Claude · Web**, **Claude · Terminal**, **OpenCode · Web**, dan **OpenCode · Terminal**.
   - **Total** = token untuk kelompok itu, **%** = bagiannya dari seluruh laporan.
   - **Biaya** `—` berarti belum ada catatan biaya untuk kelompok itu; `$0.00` berarti model gratis (biasanya OpenCode).
   - Angka dalam tanda kurung, misalnya `$1.20 (87%)`, berarti hanya 87% catatan di kelompok itu yang punya biaya.
5. **⬇ Unduh PDF** memuat tabel yang sama dengan rincian lebih lengkap (per mesin × sumber, per project, sesi teratas).

Rincian **per role** belum tersedia: pemakaian subagent digabung ke sesi induknya. Detail: [Akun & laporan](../README.md#akun--laporan).

## Meringkas konteks percakapan

Kalau percakapan makin panjang dan status konteks mendekati batas:

1. Klik **🧹** di status konteks (atau ketik `/ringkas`).
2. (Opsional) isi **Fokus**, misalnya *pertahankan keputusan API dan file yang diubah*. Fokus ini hanya dipakai Claude Code.
3. Klik **Ringkas**. Tunggu indikator *Memadatkan konteks percakapan…* sampai selesai.
4. Percakapan di panel chat tetap utuh; yang diringkas adalah konteks yang dikirim ke mesin.

Tombol ini tidak bisa dipakai saat tim sedang bekerja, ada izin yang menunggu jawaban, atau rewind berjalan. Dengan OpenCode, tombol hanya jalan kalau sesinya menyediakan `/compact`; kalau tidak, muncul penjelasan. Detail: [Tanpa terminal](../README.md#tanpa-terminal).

## Melihat harga saat memilih model

1. Buka chip **⚙ Pengaturan giliran** di atas kotak chat (di HP di bawah teks).
2. Buka daftar **Model**. Setiap model menampilkan biaya per 1 juta token bila diketahui:
   - model **OpenCode Go**: `— $0.15 in / $0.60 out /1M`; tanda `±` berarti ada tarif lebih tinggi pada jam sibuk (arahkan kursor ke model untuk detail).
   - model **Claude** atau lainnya: `— ≈$1.23/1M tercatat`, dihitung dari biaya pemakaian yang sudah tercatat (90 hari terakhir), bukan harga list.
   - `— gratis` untuk model gratis.
3. Baris kecil di bawah daftar menjelaskan sumber angkanya. Kalau tertulis *Belum ada data harga*, model itu belum pernah dipakai dan tidak punya harga list.

Harga OpenCode Go diambil dari katalog resmi `opencode.ai` dan disimpan di folder data aplikasi; pembaruan gagal (offline) tidak mengganggu pemilihan model. Detail: [Tanpa terminal](../README.md#tanpa-terminal).

## Memakai Model Auto

1. Buka chip **⚙ Pengaturan giliran** → daftar **Model** → pilih **Auto — sesuaikan task**.
2. Setiap prompt dinilai dulu (satu panggilan yang sama dengan Effort Auto), lalu model dipilih dari tangga:
   - **Hemat** untuk pertanyaan/typo/perubahan kecil,
   - **Seimbang** untuk bug fix dan fitur kecil,
   - **Kuat** untuk pekerjaan multi-file/refactor,
   - **Maks** untuk tugas paling berat.
3. Di chat muncul `🤖 Model Auto: Seimbang → sonnet` saat model berganti. Pilihan model di daftar ikut berubah.
4. Memilih model tertentu (atau **Default**) mematikan Auto. Saat tim sedang bekerja, model tidak diganti di tengah giliran.
5. **Atur tangga…** (di bawah pilihan model saat Auto aktif): pilih model untuk **Hemat / Seimbang / Kuat / Maks** per mesin, atau **Bawaan** untuk kembali ke default. Berlaku untuk Claude Code dan OpenCode.

- **Model Auto** kini menilai setiap prompt **bersama konteks rencana terakhir**: percakapan terakhir dan daftar todo/plan ikut dikirim ke classifier, jadi prompt lanjutan singkat seperti *“kerjakan”* atau *“lanjut”* dinilai dari rencana yang baru muncul, bukan dari satu kata. Detail: [Tanpa terminal](../README.md#tanpa-terminal).

## Mengulangi perubahan setelah rewind

Kalau salah rewind (kode):

1. Buka dialog **⏪ Rewind** lagi. Bagian **↩ Ulangi perubahan (redo)** menampilkan rewind terakhir.
2. Klik untuk melihat pratinjau: file mana yang akan **dikembalikan** dan mana yang akan **dihapus**.
3. File yang kamu ubah setelah rewind ditandai **bentrok** dan **dilewati**. Centang **“Timpa file yang sudah saya ubah”** hanya jika kamu yakin.
4. Klik **↩ Ulangi**. Salinan file saat ini disimpan dulu di `data/redo/` sebelum ditimpa.

Batasan: redo hanya untuk **perubahan kode yang belum di-commit** di **repo git**; percakapan yang sudah di-rewind tidak dikembalikan, dan rewind kode di folder non-git ditolak sejak awal (tidak ada yang berubah).

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

**Kalau muncul *"File berubah di luar aplikasi…"*** (saat menyimpan, memulihkan, atau menggabungkan): file config diubah di luar aplikasi—atau editor sudah lama terbuka—jadi tidak ada yang ditulis. Klik **↻ Muat ulang**, cek perubahannya, lalu ulangi. Detail: [Mesin: Claude Code atau OpenCode](../README.md#mesin-claude-code-atau-opencode).

## Kalau terasa macet

| Yang terlihat | Yang dilakukan |
|---|---|
| Chip *⚠ Tidak ada output 3 mnt — mungkin macet* | Build atau test yang lama memang wajar. Kalau yakin macet: **⧗ Pindah ke latar** (perintah tetap jalan, kamu bisa lanjut chat) atau **■ Hentikan giliran** |
| Chip *⚠ <role> tidak ada aktivitas 5 mnt* | **Lihat detail** untuk melihat langkah terakhir subagent itu, lalu putuskan |
| Tim diam, tidak ada chip | Cek kartu izin yang menunggu (gulir chat, atau 🗂 Semua project) |
| *"… giliran terputus"* setelah restart | **▶ Lanjutkan** meneruskan di sesi yang sama. Tidak ada yang dikirim otomatis |
| Antrian tidak jalan | Buka 📋 Antrian: mungkin dijeda (setelah restart, item gagal, kuota habis, atau batas tercapai). Tekan **Lanjutkan** |
| Halaman tidak update / banyak tab terbuka | Muat ulang halaman. Semua tab berbagi satu koneksi, jadi menutup tab lain tidak perlu |
| HP tidak tersambung | Lihat [Kalau HP tidak tersambung](../README.md#kalau-hp-tidak-tersambung) |

`Esc` selalu menghentikan giliran yang berjalan. Deteksi macet hanya memberi peringatan, tidak pernah menghentikan apa pun sendiri.

## Pindah laptop atau backup

**Rutin:** ⚙ → **💾 Cadangkan riwayat** → **⏰ Backup otomatis**. Pilih Harian/Mingguan, jam, folder tujuan (mis. `D:\Backup\adhit-office`), dan berapa backup yang disimpan, lalu **💾 Simpan jadwal**.

**Pindah laptop:**

1. Laptop lama: ⚙ → Cadangkan riwayat → **⬇ Export riwayat**.
2. Laptop baru: ikuti [Mulai cepat](../README.md#mulai-cepat), login dengan `claude`, dan clone folder project-mu.
3. ⚙ → Cadangkan riwayat → **⬆ Import riwayat**, pilih file `.zip`.
4. Buka project → **🕘 Riwayat sesi** → **Lanjutkan**.

Yang perlu diulang di laptop baru: login Claude, pairing HP (termasuk notifikasi push), dan menghubungkan Spotify. Mode izin tiap project kembali ke **Tanya dulu**. Detail: [Backup & riwayat](../README.md#backup--riwayat).
