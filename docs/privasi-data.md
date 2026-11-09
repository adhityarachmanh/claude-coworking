# Privasi & data pribadi (RoPA/DPIA ringkas)

Dokumen kerja untuk Adhit Office. Ini **bukan nasihat hukum**; tinjau ulang bila dipakai untuk organisasi
atau data orang lain. Aplikasi berjalan di laptop sendiri dan menyimpan data di folder `data/`.

## Peran

- **Kamu** adalah pemilik laptop dan pengendali data (controller) untuk data yang kamu masukkan.
- **Penyedia model** (Anthropic/Claude Code, OpenCode dan provider modelnya) memproses prompt saat kamu
  mengirim giliran; mereka punya kebijakan privasi sendiri.
- **Layanan push** (FCM, Mozilla, Apple, Windows) hanya menerima payload notifikasi yang sudah diminimalkan.
- **Tailscale** hanya jalur jaringan untuk akses HP; bukan penyimpan data aplikasi.
- **Spotify/GitHub** hanya aktif bila kamu menghubungkannya.

## Data yang disimpan

| Data | Isi | Retensi / hapus |
|---|---|---|
| `state.json` | pengaturan, favorit, tag/arsip sesi, antrian, jadwal, VAPID, status kantor | sampai dihapus / backup |
| `chats/`, `chats-opencode/` | pesan panel chat (prompt, jawaban, tool) | retensi chat 0–3650 hari; default selamanya |
| `usage.jsonl`, `usage-archive/` | token, biaya, akun, project, sesi, agent | retensi laporan 0–3650 hari; default selamanya |
| `auth-audit.jsonl` | aksi login/logout akun & provider | 180 hari / maks 2.000 aksi |
| `audit.log` | aksi data: backup, verifikasi, hapus, retensi | maks 500 baris |
| `redo/<project>/` | perubahan kode/percapakan untuk redo | maks 5 per project, 7 hari |
| `queue-files/` | lampiran item antrian | sampai item selesai/dibatalkan/project dihapus |
| `trash/` | transkrip sesi Claude yang dihapus | 30 hari |
| `metrics.json` | angka kesehatan server (tanpa isi chat) | rolling 7 hari |
| `server.log` | log server | sampai dikosongkan dari 🕵️ Data saya |
| `model-prices.json` | cache harga model | diperbarui harian |
| `claude-check.json` | status kompatibilitas Claude Code | sampai dihapus |
| `opencode-config-backups/` | backup config OpenCode sebelum diubah | 10 per file, 90 hari |
| `backup-schedule/` | file ZIP backup otomatis | sesuai jadwal (1–100 file) |
| `push-history.json` | riwayat notifikasi terakhir | maks 30 entri; bisa dihapus |
| `spotify.json`, TLS | token Spotify, sertifikat | sampai logout/dihapus; tidak ikut backup |
| `state.json.pre-per-project-*` | salinan state sebelum migrasi | maks 5 file/30 hari |

**Backup** adalah ZIP seluruh kantor. File backup yang sudah dibuat **tidak bisa dihapus per project**;
hapus file ZIP-nya sendiri bila perlu.

## OpenCode Console (kuota, usage, request log)

- Token OAuth **OpenCode Console** disimpan oleh OpenCode, bukan oleh aplikasi. Aplikasi membacanya
  sementara lewat `opencode auth export opencode` untuk memanggil endpoint console.
- Token **tidak** dikirim ke browser, tidak dicatat di log aplikasi, dan tidak masuk backup.
- Data yang diambil: paket/kuota, aktivitas harian, usage per model, dan request log (model, app, durasi,
  token, biaya, status). Aplikasi **membuang** `userID`, `workspaceID`, `requestID`, header, metadata,
  negara/kota, dan tidak pernah mengambil isi prompt/jawaban. `nextCursor` dari provider dikirim sebagai
  handle pagination opaque; `sessionID` di laporan dipotong menjadi 8 karakter.
- Hasil console di-cache di memori sebentar (±60 detik), termasuk total per sesi; tidak disimpan ke disk.
- Data request log dan total/biaya per sesi juga dapat muncul di laporan, PDF, dan CSV. Laporan dari
  perangkat **WiFi hanya-baca tidak memanggil console**; bagian provider hanya tersedia dari laptop atau
  Tailscale (akses penuh).
- Token console di-cache di memori paling lama ±5 menit; cache dibuang saat login/logout atau kredensial
  berubah. Setelah logout atau kredensial dihapus, panel kembali ke estimasi lokal.
- Endpoint console bersifat internal/undocumented; bila berubah, aplikasi kembali ke estimasi dan tidak
  mengirim data tambahan.

## Tujuan & dasar pemrosesan

- Menjalankan aplikasi, menyimpan percakapan, menampilkan status, kuota, laporan, dan antrian.
- Menjawab izin dan mengirim notifikasi yang kamu minta.
- Menghitung biaya/pemakaian dan menampilkan data provider yang kamu hubungkan.
- Dasar: pelaksanaan layanan yang kamu minta dan persetujuan saat menghubungkan akun/provider/push.
  Kamu dapat mematikan atau memutus koneksi kapan saja.

## Pihak ketiga & transfer

Tergantung fitur yang dipakai, data dapat dikirim ke:

- Anthropic/Claude Code dan provider model OpenCode (prompt, konteks, lampiran);
- OpenCode Console (kuota/usage/request log, dengan token yang tersimpan di OpenCode);
- layanan push (nama project, role, nama tool, status; bukan isi chat);
- Tailscale (jalur jaringan), Spotify/GitHub (bila dihubungkan).

Provider dapat memproses data di luar Indonesia. Periksa kebijakan masing-masing penyedia sebelum
memakai data sensitif.

## Hak subjek data

- **Akses/portabilitas**: ekspor ZIP backup, PDF/CSV laporan, dan file di `data/`.
- **Koreksi**: ubah pengaturan/nama/tag dari UI, atau edit file project.
- **Hapus**: retensi otomatis, tombol 🧹 di 🕵️ Data saya, hapus data per project, dan hapus file backup.
- **Keberatan/penarikan**: logout provider/OpenCode Console, matikan push, putuskan Spotify, atau hapus
  data terkait.
- **Pembatasan**: transkrip asli Claude/OpenCode disimpan di luar `data/` dan harus dihapus dari folder
  providernya sendiri.

## Keamanan

- Server hanya di loopback; akses HP lewat pairing/Tailscale, WiFi hanya-baca.
- Token API per start, CSP ketat, cookie HttpOnly, dan rahasia tidak masuk backup.
- Folder `data/` dibatasi ke user ini (best effort).
- Jangan arahkan `OFFICE_DATA_DIR` ke folder bersama/sinkron.

## DPIA ringkas — risiko & mitigasi

| Risiko | Mitigasi | Sisa risiko |
|---|---|---|
| Prompt berisi data pribadi terkirim ke provider | kendali di sisi pengguna; provider punya kebijakan sendiri | sedang |
| Token OpenCode Console bocor | hanya dibaca server, tidak ke browser/log/backup; cache memori | rendah |
| Request log memuat identitas | field pribadi dibuang sebelum keluar server; sessionID laporan dipotong | rendah |
| Data provider di laporan dibuka dari WiFi | WiFi hanya-baca tidak memanggil console; laporan tetap dari cache laptop | rendah |
| Backup ZIP berisi transkrip | enkripsi `.aob` opsional; backup immutable per project | sedang |
| HP hilang / WiFi disadap | pairing, cookie, WiFi hanya-baca, Tailscale HTTPS | rendah–sedang |
| Audit log tumbuh | batas 500 baris / 180 hari / 2.000 aksi | rendah |

## Insiden

Karena aplikasi lokal, kebocoran biasanya berarti akses ke laptop/folder `data/` atau file backup.
Langkah: cabut HP di 📱, logout provider, ganti kata sandi backup, hapus salinan yang bocor, dan catat
waktu/lingkup. Bila melibatkan data orang lain, pertimbangkan kewajiban notifikasi insiden (UU PDP
maks. 3×24 jam) dan hubungi penasihat hukum.
