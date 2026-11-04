# Changelog

Perubahan yang terasa oleh pengguna. Detail fitur ada di [README](README.md); panduan harian di [docs/PANDUAN.md](docs/PANDUAN.md).

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
- **♪ Spotify.** Pill lagu di header, radio di lounge kantor, dialog ♪ Musik (kontrol, volume, perangkat, playlist, putar mulai dari lagu tertentu). ▶ tanpa perangkat aktif membuka Spotify di laptop di latar belakang. Bisa mengecilkan atau menjeda musik saat ada izin yang menunggu. Login dengan Client ID saja (PKCE, tanpa client secret). [Setup](README.md#musik-spotify)
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
