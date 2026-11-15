# Privasi & data pribadi (RoPA/DPIA ringkas)

Dokumen kerja untuk Adhitron. Ini **bukan nasihat hukum**; tinjau ulang bila dipakai untuk organisasi
atau data orang lain. Aplikasi berjalan di laptop sendiri dan menyimpan data di folder `data/`.

## Peran

- **Kamu** adalah pemilik laptop dan pengendali data (controller) untuk data yang kamu masukkan.
- **Penyedia model** (Anthropic/Claude Code, OpenCode dan provider modelnya) memproses prompt saat kamu
  mengirim giliran; mereka punya kebijakan privasi sendiri.
- **Layanan push** (FCM, Mozilla, Apple, Windows) hanya menerima payload notifikasi yang sudah diminimalkan.
- **Tailscale** hanya jalur jaringan untuk akses HP; bukan penyimpan data aplikasi.
- **WhatsApp** hanya dipakai untuk mengirim PIN pairing ke nomormu sendiri. Sesi WhatsApp berjalan **di dalam
  Adhitron** di laptop ini, dan pesannya diteruskan WhatsApp seperti chat biasa.
- **Spotify/GitHub** hanya aktif bila kamu menghubungkannya.

## Data yang disimpan

| Data | Isi | Retensi / hapus |
|---|---|---|
| `state.json` | pengaturan, favorit, tag/arsip sesi, antrian, jadwal, VAPID, status kantor | sampai dihapus / backup |
| `chats/`, `chats-opencode/` | pesan panel chat (prompt, jawaban, tool) | retensi chat 0–3650 hari; default selamanya |
| `usage.jsonl`, `usage-archive/` | token, biaya, akun, project, sesi, agent | retensi laporan 0–3650 hari; default selamanya |
| `auth-audit.jsonl` | aksi login/logout akun & provider | 180 hari / maks 2.000 aksi |
| `audit.log` | aksi data: backup, verifikasi, hapus, retensi, persetujuan CLI | maks 500 baris |
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
| `wa/` | sesi WhatsApp (kredensial login + kunci enkripsi pesan), terenkripsi AES-256-GCM; nomor yang ditautkan ada di dalamnya | sampai **Lepas** ditekan, perangkat dicabut dari HP, atau folder dihapus; **tidak ada kedaluwarsa otomatis**; **tidak ikut backup** |
| `state.json.pre-per-project-*` | salinan state sebelum migrasi | maks 5 file/30 hari |
| Registry Windows `HKLM\...\Winlogon\DefaultPassword` (mode sebelum login) | sandi Windows akun ini, ditulis oleh Windows **tanpa enkripsi** saat kamu menekan Aktifkan | sampai tombol **Matikan** (atau pengaturan autologon lain) menghapusnya |

Data yang **tidak** disimpan Adhitron:

| Data | Perlakuan |
|---|---|
| PIN akses WhatsApp | hanya HMAC-SHA256 di memori (kunci acak per proses), 5 menit, sekali pakai; tidak pernah ditulis ke disk, log, atau respons API |
| Alamat IP + User-Agent peminta PIN | disimpan **plaintext di memori proses** (bukan disk/log) untuk rate-limit dan pengikat PIN ke browser; hilang saat server restart |
| Nomor WhatsApp tujuan PIN | tidak lagi diisi lewat env: PIN selalu dikirim ke nomor yang **sedang tertaut**. Nomornya hanya ada di dalam sesi terenkripsi `wa/` dan tampil di Setelan laptop |
| Kunci enkripsi sesi WhatsApp (`wa/key`) | hanya di laptop ini, di folder `data/` milik user; tidak pernah dikirim ke perangkat mana pun, tidak masuk backup, tidak dicatat di log. Windows mengabaikan mode file `0600`, jadi perlindungan nyatanya adalah izin folder profil: siapa pun yang bisa membaca `data/` bisa membaca kuncinya juga |
| Sandi Windows untuk autologon (mode sebelum login) | diketik di modal Setelan dan diteruskan ke proses Administrator lewat file sementara per-user di `%TEMP%` yang dihapus sebelum registry ditulis; Adhitron tidak menyimpannya. Windows sendiri yang menyimpannya **tanpa enkripsi** di registry (baris di tabel atas) |

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

## CLI bridge (eksperimental, opt-in)

- Hanya aktif bila kamu menjalankan `office claude`; tanpa itu tidak ada hook dan tidak ada file settings.
- Hook mengirim **nama tool + input yang sudah dipotong** ke server lokal: perintah, path, isi file
  (`content`/`old_string`/`new_string`), URL, atau argumen MCP—dipotong dengan penanda “dipotong” dan
  anggaran ±12 KB. Bukan isi prompt atau percakapan.
- Kartu izin muncul di kantor dan perangkat yang dipasangkan (termasuk WiFi hanya-baca yang bisa melihat,
  tetapi tidak bisa menjawab). Notifikasi HP **tidak** menyediakan tombol “Izinkan” dari layar kunci untuk
  izin CLI; buka aplikasi untuk melihat konteksnya.
- Token API per start ditulis ke file sementara di folder temp OS (mode 0600), dirujuk oleh hook, dan
  dihapus saat wrapper selesai. Token tidak lewat environment tool, tidak masuk `data/`, log, atau backup.
  File settings sementara di `data/cli-bridge/` hanya berisi path hook dan dihapus saat wrapper selesai.
- Server tidak pernah otomatis mengizinkan: server mati, timeout, atau hook gagal → hook tidak memberi
  keputusan dan **prompt terminal Claude Code** yang mengambil alih. Keputusan dicatat di `audit.log`
  sebagai `cli-approval` (tool, project, hasil: allow/deny/timeout; tanpa isi perintah).
- Endpoint `/api/cli-bridge/ask` hanya untuk laptop: token, origin, dan daftar laptop-only wajib.
- Batas kepercayaan: proses lokal dengan hak user yang sama (termasuk tool yang dijalankan agent) tetap
  dipercaya dan bisa membaca token/approval seperti klien lokal lain. Bridge mengurangi risiko salah klik
  dan prompt injection biasa, bukan isolasi OS dari proses jahat.

## Tujuan & dasar pemrosesan

- Menjalankan aplikasi, menyimpan percakapan, menampilkan status, kuota, laporan, dan antrian.
- Menjawab izin dan mengirim notifikasi yang kamu minta.
- Mengirim PIN pairing lewat WhatsApp ke nomormu sendiri (kamu menautkannya sendiri di ⚙).
- Membuat Windows login sendiri dalam mode sebelum login (kamu mengetik sandinya sekali dan bisa mematikannya kapan saja).
- Menghitung biaya/pemakaian dan menampilkan data provider yang kamu hubungkan.
- Dasar: pelaksanaan layanan yang kamu minta dan persetujuan saat menghubungkan akun/provider/push/WhatsApp.
  Kamu dapat mematikan atau memutus koneksi kapan saja.

## Pihak ketiga & transfer

Tergantung fitur yang dipakai, data dapat dikirim ke:

- Anthropic/Claude Code dan provider model OpenCode (prompt, konteks, lampiran);
- OpenCode Console (kuota/usage/request log, dengan token yang tersimpan di OpenCode);
- layanan push (nama project, role, nama tool, status; bukan isi chat);
- WhatsApp, lewat sesi WhatsApp Web yang berjalan di laptop, hanya untuk pesan PIN pairing ke nomormu sendiri.
  Protokol ini bukan API resmi Meta: pesan tetap diproses WhatsApp sesuai kebijakannya;
- Tailscale (jalur jaringan), Spotify/GitHub (bila dihubungkan).

Provider dapat memproses data di luar Indonesia. Periksa kebijakan masing-masing penyedia sebelum
memakai data sensitif.

### Perpindahan mesin (auto context bridge)

Memilih model dari mesin lain mengirim **ringkasan percakapan project itu** (teks prompt/jawaban, maks
30 pesan yang dipadatkan, plus label langkah tool terakhir) ke provider mesin baru sebagai bagian prompt
berikutnya. Semua berjalan lokal saat menyusun ringkasan (tanpa panggilan model tambahan), dan rahasia
yang dikenali polanya (token `sk-…`/GitHub/Slack/JWT, `KEY=value`, URL ber-kredensial, private key)
disamarkan menjadi `***`. Catatan ringkasan itu sendiri **hanya ada di memori** sesi baru dan dipakai
sekali; yang tersimpan di `chats/`/`chats-opencode/` hanya satu baris info `🔁 Ringkasan konteks … dikirim
ke …`. Salinan prompt tetap tersimpan di sisi provider tujuan sesuai kebijakannya, di luar `data/`.

## Hak subjek data

- **Akses/portabilitas**: ekspor ZIP backup, PDF/CSV laporan, dan file di `data/`.
- **Koreksi**: ubah pengaturan/nama/tag dari UI, atau edit file project.
- **Hapus**: retensi otomatis, tombol 🧹 di 🕵️ Data saya, hapus data per project, dan hapus file backup.
  Sesi WhatsApp dihapus lewat **Lepas** di ⚙ → 📱 PIN ke HP (panel 🕵️ Data saya tidak mencakup folder `data/wa/`);
  autologon Windows dimatikan lewat **Matikan** di ⚙ → Sistem → 🔐 Akses saat PC terkunci.
- **Keberatan/penarikan**: logout provider/OpenCode Console, matikan push, putuskan Spotify, lepas WhatsApp,
  matikan autologon, atau hapus data terkait.
- **Pembatasan**: transkrip asli Claude/OpenCode disimpan di luar `data/` dan harus dihapus dari folder
  providernya sendiri.

## Keamanan

- Server hanya di loopback; akses HP lewat pairing/Tailscale, WiFi hanya-baca.
- Token API per start, CSP ketat, cookie HttpOnly, dan rahasia tidak masuk backup.
- Folder `data/` dibatasi ke user ini lewat izin folder profil (Windows mengabaikan mode file `0600`).
- Jangan arahkan `OFFICE_DATA_DIR` ke folder bersama/sinkron: kunci sesi WhatsApp ada **di sebelah** data terenkripsinya, jadi siapa pun yang bisa membaca folder itu (atau salinan cloud-nya) bisa membuka sesinya.

## DPIA ringkas — risiko & mitigasi

| Risiko | Mitigasi | Sisa risiko |
|---|---|---|
| Prompt berisi data pribadi terkirim ke provider | kendali di sisi pengguna; provider punya kebijakan sendiri | sedang |
| Ringkasan percakapan menyeberang ke provider mesin lain | hanya saat model mesin lain dipilih; rahasia berpola disamarkan; catatan hanya di memori, sekali pakai | sedang |
| Token OpenCode Console bocor | hanya dibaca server, tidak ke browser/log/backup; cache memori | rendah |
| Request log memuat identitas | field pribadi dibuang sebelum keluar server; sessionID laporan dipotong | rendah |
| Data provider di laporan dibuka dari WiFi | WiFi hanya-baca tidak memanggil console; laporan tetap dari cache laptop | rendah |
| Backup ZIP berisi transkrip | enkripsi `.aob` opsional; backup immutable per project | sedang |
| HP hilang / WiFi disadap | pairing, cookie, WiFi hanya-baca, Tailscale HTTPS | rendah–sedang |
| PIN pairing bocor (dibaca dari WhatsApp, ditebak) | 5 menit, sekali pakai, 3 percobaan, minta ulang dibatasi; HMAC di memori (IP + User-Agent plaintext di memori, tidak ke disk/log); PIN dibuang saat akses HP dimatikan | rendah |
| Sesi WhatsApp di laptop disalahgunakan | sesi terenkripsi AES-256-GCM di `wa/`, kunci tidak ikut backup; QR hanya bisa diambil dari laptop (HP/Tailscale ditolak); **Lepas** menghapus sesi dari disk | rendah–sedang |
| Folder `data/` disalin atau disinkronkan ke cloud/OneDrive | kunci enkripsi ada di folder yang sama dengan data terenkripsinya, jadi enkripsi tidak menolong bila seluruh folder ikut tersalin; jangan sinkronkan `data/`, aktifkan enkripsi disk, tekan **Lepas** bila laptop dijual/dipinjamkan | tinggi bila folder disinkron |
| WhatsApp berhenti bekerja karena protokol tidak resmi | pemakaian WhatsApp Web bukan API resmi Meta; jalur kode 6 digit dari layar laptop tetap berfungsi, tautkan ulang bila perlu | sedang |
| Sandi Windows tersimpan di registry (mode sebelum login) | opsional, sandi divalidasi sebelum ditulis, bisa dimatikan dari tombol **Matikan** yang sama; sarankan BitLocker + akun Windows khusus | sedang |
| Audit log tumbuh | batas 500 baris / 180 hari / 2.000 aksi | rendah |

## Insiden

Karena aplikasi lokal, kebocoran biasanya berarti akses ke laptop/folder `data/` atau file backup.
Langkah: cabut HP di 📱, logout provider, ganti kata sandi backup, hapus salinan yang bocor, dan catat
waktu/lingkup. Bila melibatkan data orang lain, pertimbangkan kewajiban notifikasi insiden (UU PDP
maks. 3×24 jam) dan hubungi penasihat hukum.
