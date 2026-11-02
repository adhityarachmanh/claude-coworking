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
