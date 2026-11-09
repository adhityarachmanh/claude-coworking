# Uji manual di HP (gerbang rilis)

Status: **belum dijalankan** (lihat catatan §8.3 di `docs/design-mobile-chat.md`). Test UI headless memeriksa
390×844, 360×740, dan landscape 844×390 di Chrome desktop; checklist ini menutup hal yang hanya muncul di
perangkat nyata: keyboard, safe-area, push, dan layar kunci.

Perkiraan waktu: **20 menit**. Siapkan satu HP (Android atau iPhone) dan laptop dengan server menyala.

## Persiapan

1. Laptop: pastikan **Tailscale** tersambung dan HTTPS aktif (📱 → 🔒 Tailscale (HTTPS)).
2. HP: Tailscale menyala, lalu pairing lewat QR atau kode 6 digit.
3. Catat perangkat dan versi browser di tabel hasil.
4. Kosongkan antrian dan pastikan tidak ada giliran berjalan supaya notifikasi mudah dipicu.

## Checklist

### 1. Pairing & tampilan awal

- [ ] Halaman terbuka lewat HTTPS, tidak ada peringatan sertifikat.
- [ ] Pairing berhasil; setelah tutup-buka browser, HP masih diingat (tidak minta kode lagi).
- [ ] Header HP: nama project + subjudul sesi + **⋯**; navigasi bawah terlihat.
- [ ] Lebar 390 px tanpa scroll horizontal.

### 2. Kirim prompt & keyboard

- [ ] Ketik prompt: navigasi bawah **hilang** saat keyboard terbuka; kotak pesan tetap di atas keyboard.
- [ ] Chat tetap di posisi terbawah kalau sebelumnya di bawah.
- [ ] Tutup keyboard: navigasi bawah kembali.
- [ ] Tombol berganti fungsi dengan benar: 🎤 → ↑ Kirim → ■ Stop.
- [ ] Setelah kirim, balasan streaming muncul tanpa perlu refresh.

### 3. Navigasi geser

- [ ] Geser kiri/kanan berpindah **Kantor ↔ Chat ↔ Perubahan ↔ Aktivitas**.
- [ ] Geser vertikal tetap scroll (tidak ikut pindah tab).
- [ ] Mulai geser dari kotak pesan/dialog/panel yang bisa digeser menyamping **tidak** berpindah tab.
- [ ] Landscape: rail navigasi kiri + dua kolom, tidak ada elemen terpotong.

### 4. Izin dari HP

- [ ] Kirim prompt yang memicu `Write` di laptop; kartu izin muncul di HP.
- [ ] **Izinkan** dari HP → giliran lanjut; toast bahwa izin dijawab dari HP (mis. "Diizinkan dari HP (…) lewat notifikasi") muncul di laptop.
- [ ] Ulangi, **Tolak** → giliran berhenti sesuai aturan.
- [ ] Saat mode WiFi (hanya lihat): kotak pesan diganti banner "👁 Hanya lihat lewat WiFi", tidak bisa kirim.

### 5. Push notification (HTTPS)

- [ ] 🔔 → 📱 Notifikasi HP (push) → **Aktifkan** → izinkan notifikasi → **Kirim tes** berhasil.
- [ ] Kunci HP, picu izin dari laptop: notifikasi masuk walau aplikasi tertutup.
- [ ] Android: tombol **Izinkan** hanya muncul untuk tool baca/edit (Read/Edit/Write/Glob/Grep); tidak muncul
      untuk Bash/PowerShell/MCP.
- [ ] iPhone: tidak ada tombol; ketuk notifikasi membuka kartu izinnya.
- [ ] Izinkan dari layar kunci → keputusan tercatat dan toast muncul di laptop.
- [ ] Saat aplikasi terbuka dan terlihat: push ditahan (tidak dobel dengan notifikasi in-app).

### 6. TTS & PWA

- [ ] 🔔 → Pengaturan notifikasi → **Bacakan balasan**: jawaban akhir giliran dibacakan; blok kode dilewati.
- [ ] **Stop** atau `Esc` menghentikan suara.
- [ ] Pasang sebagai aplikasi (Android: menu ⋮ → Install; iPhone: Bagikan → Tambah ke Layar Utama).
- [ ] Dari ikon Layar Utama: pairing diminta sekali lagi (iPhone) lalu berfungsi.
- [ ] Badge ikon menampilkan jumlah izin menunggu (Badging API, Android Chrome).

### 7. Kondisi buruk

- [ ] Matikan server: strip "Belum tersambung" muncul, tombol kirim nonaktif (bukan error mentah).
- [ ] Nyalakan server: halaman tersambung lagi sendiri tanpa refresh.
- [ ] HP diam 30 hari → otomatis dicabut (bisa diperiksa dengan mengubah tanggal; opsional).

## Hasil

| # | Bagian | Hasil (Lulus/Gagal) | Catatan |
|---|---|---|---|
| 1 | Pairing & tampilan awal | | |
| 2 | Kirim prompt & keyboard | | |
| 3 | Navigasi geser | | |
| 4 | Izin dari HP | | |
| 5 | Push notification | | |
| 6 | TTS & PWA | | |
| 7 | Kondisi buruk | | |

Tanggal:
Perangkat:
OS:
Browser + versi:
Jalur: WiFi / Tailscale HTTP / Tailscale HTTPS

## Setelah semua lulus

1. Catat hasilnya di `docs/design-mobile-chat.md` §8.3 (ganti "belum tercatat di repo").
2. Masukkan ringkasannya ke CHANGELOG bagian **Belum dirilis**.

Kalau ada yang gagal: catat di tabel dan jangan anggap bagian itu selesai; perbaikan UI dikerjakan sebelum
rilis gabungan.
