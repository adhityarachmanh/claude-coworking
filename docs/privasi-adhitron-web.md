# Catatan Privasi & Kepatuhan — Adhitron Web (`/chat`)

Status: **draf untuk rilis publik v1** — wajib ditinjau penanggung jawab privasi (DPO) sebelum situs dibuka umum.
Acuan: UU PDP (UU No. 27/2022) dan, bila ada pengguna luar Indonesia, GDPR.

## Data apa yang disimpan

Adhitron Web (`/chat`) menyimpan data berikut di database Neon Postgres operator:

| Data | Isi | Dasar | Sifat |
|---|---|---|---|
| `users` | email, nama tampilan (opsional), **hash** password (scrypt + salt), versi & waktu persetujuan | Akun pengguna | Pribadi |
| `sessions` | sha256 token sesi, waktu kedaluwarsa | Keamanan login | Pribadi |
| `providers` | label, jenis, base URL, **API key user terenkripsi AES-256-GCM**, 4 karakter terakhir (hint) | Layanan chat | Rahasia |
| `conversations` | judul, model/effort pilihan, toggle browsing | Riwayat chat | Pribadi |
| `messages` | isi obrolan user & asisten | Riwayat chat | Pribadi |
| `messages.meta.attachments` | chip lampiran tiap pesan: `{kind, name, size}` (jenis, **nama file**, ukuran). Isi gambar **tidak** disimpan | Riwayat chat | Pribadi (nama file dapat memuat info: mis. `KTP-budi.jpg`) |
| `messages.meta.textBlocks` | **isi lengkap lampiran teks** (log/kode/md/json/csv/…) yang sudah ter-render, disisipkan kembali tiap giliran lanjutan | Riwayat chat & konteks | Pribadi (dapat memuat data pribadi pihak ketiga) |
| `citations` | judul/URL/cuplikan sumber browsing | Fitur browsing | Publik (dari web) |
| `tool_runs` | catatan pencarian/pembacaan halaman (query/URL + status) | Kuota & audit fitur | Dapat memuat data pribadi bila user mengetikkannya |

Password **tidak pernah** disimpan/dilog dalam bentuk asli. API key user **tidak pernah** dikirim kembali ke klien
(hanya 4 karakter terakhir) dan tidak pernah ditulis ke log.

## Retensi & penghapusan

- Menghapus percakapan menghapus pesan & kutipannya (cascade). Menghapus provider menghapus API key-nya.
- **Hak hapus (UU PDP Pasal 35–36 / GDPR Pasal 17):** jalur "hapus akun" (`DELETE /chat/api/me` + tombol di UI)
  menghapus **seluruh** baris milik user (users, sessions, providers, conversations, messages, citations, tool_runs)
  lewat cascade FK. Lihat item #2 di daftar wajib.
- Sesi kedaluwarsa dibersihkan saat diakses; cron juga membersihkannya berkala bersama jejak `tool_runs` (lihat bagian retensi).

## Pihak ketiga

- **Neon** (database) — memproses seluruh data di atas atas nama operator.
- **Penyedia AI milik user** (OpenAI/Anthropic/Google atau OpenAI-compatible) — menerima isi pesan + API key milik
  user itu sendiri untuk menghasilkan jawaban. Ini pilihan user, bukan operator. **Lampiran ikut dikirim**: isi file
  teks dan byte gambar di-encode base64 lalu disertakan pada permintaan ke penyedia. Data yang sudah dikirim ke
  penyedia tunduk pada kebijakan & retensi penyedia masing-masing (di luar kendali operator).
- **Mesin pencari** (DuckDuckGo HTML default; Tavily/Brave bila dikonfigurasi) — menerima teks **query** saat fitur
  Browsing aktif.
- **Netlify** (hosting + Blobs untuk rate-limit).
- Bila login pihak ketiga ditambahkan kelak: sebut penyedianya di sini.

## Lampiran pada chat — temuan & teks usulan (Fase 1)

Fitur lampiran mengubah jenis data yang diproses: selain teks ketik, kini ada **nama file**, **isi file teks** yang
disimpan di DB (`meta.textBlocks`), dan **isi gambar** yang dikirim ke penyedia. Acuan teknis: `bridge/src/attachments.mjs`,
`bridge/src/chat-run.mjs` (`meta` yang disimpan di baris pesan), `bridge/src/chat.mjs` (`blocksToContent`).
Fungsi kebijakan yang perlu diperbarui: `privacyPageHtml()` & `termsPageHtml()` di `bridge/src/site.mjs`
(**belum diubah** — Lead/frontend yang menerapkan; naikkan `POLICY_VERSION`).

Temuan berprioritas (kode/versi `2026-11-22` saat ini):

| Prioritas | Temuan | Aturan relevan | Lokasi |
|---|---|---|---|
| **Harus ada** | Kebijakan hanya menyebut "isi pesan dikirim ke penyedia AI". Lampiran (gambar + teks) juga dikirim, tetapi tidak disebut → transparansi kurang | UU PDP Pasal 20–21 (transparansi); GDPR Pasal 13 | teks `/privasi` "Pihak ketiga" |
| **Harus ada** | Isi lampiran teks disimpan permanen di DB (`meta.textBlocks`) tanpa disebut; chip menyimpan **nama file** (bisa memuat info pribadi) | UU PDP Pasal 21–22 (tujuan & minimisasi); GDPR Pasal 5 | "Data apa yang kami simpan" |
| **Harus ada** | Tanggung jawab user atas data pribadi pihak ketiga dalam lampiran belum disebut | UU PDP Pasal 20, 51; ToS | `/syarat` "Tanggung jawabmu" |
| **Sebaiknya ada** | Retensi `meta.textBlocks` hanya terikat umur akun/percakapan (cascade), tidak ada retensi terpisah → perlu pernyataan eksplisit | UU PDP Pasal 26 (retensi); GDPR Pasal 5(1)(e) | "Retensi" |
| **Sebaiknya ada** | Gambar **tidak** disimpan (hanya dikirim), sementara teks **disimpan** — beda perilaku ini belum diungkap | UU PDP Pasal 21 (keterbukaan); GDPR Pasal 13 | "Data apa yang kami simpan" |
| **Sebaiknya ada** | Retensi & pemrosesan di sisi penyedia AI (data yang sudah dikirim) tidak disebut sebagai di luar kendali operator | UU PDP Pasal 21; GDPR Pasal 13(1)(e) | "Pihak ketiga" |
| **Opsional** | Chips/history tidak dipisah per CSR; cukup dijelaskan dalam satu paragraf | — | — |

### Teks usulan (Bahasa Indonesia)

1. **`/privasi` — bagian "Pihak ketiga"** (tambahan pada kalimat penyedia AI):
   > "Saat kamu mengobrol, **isi pesanmu beserta lampiran yang kamu kirim** (teks file dan/atau gambar) diteruskan ke
   > **penyedia AI milikmu** untuk menghasilkan jawaban. Data yang sudah diterima penyedia tunduk pada kebijakan
   > privasi dan masa retensi penyedia tersebut, di luar kendali operator situs ini."

2. **`/privasi` — bagian "Data yang kami simpan"** (sisipkan sebelum atau sesudah paragraf pesan):
   > "Jika kamu melampirkan file, kami menyimpan **nama file, jenis, dan ukurannya** sebagai bagian dari riwayat
   > pesan. Untuk **file teks** (log, kode, md, json, csv, …), **isi teksnya juga disimpan** agar percakapan
   > lanjutan tetap memiliki konteks. **Isi gambar tidak kami simpan** — gambar hanya diteruskan ke penyedia AI
   > untuk giliran bersangkutan. Karena itu, jangan melampirkan file yang memuat data pribadi orang lain tanpa
   > izin, atau data sensitif (mis. dokumen identitas, data kesehatan, data keuangan)."

3. **`/privasi` — bagian "Retensi"** (tambahan):
   > "Nama file dan isi lampiran teks ikut terhapus saat kamu menghapus pesan, percakapan, atau akunmu. Tidak ada
   > batas retensi terpisah untuk lampiran selain masa hidup akunmu."

4. **`/syarat` — bagian "Tanggung jawabmu"** (tambahan):
   > "Kamu bertanggung jawab atas isi yang kamu lampirkan. Jangan melampirkan data pribadi pihak lain
   > (mis. nama, NIK, email, nomor telepon pada screenshot atau log) tanpa dasar yang sah, dan jangan
   > melampirkan data yang bersifat sensitif."

Bagian ini butuh **konfirmasi tim legal** sebelum dipublikasikan (lihat bawah).

## Wajib sebelum rilis publik

1. ✅ **Halaman Kebijakan Privasi** (`/privasi`) & **Syarat Layanan** (`/syarat`), ditaut dari footer semua halaman.
2. ✅ **Hapus akun & data**: `DELETE /chat/api/me` + tombol "Hapus akun" (konfirmasi bertingkat); cascade membuang
   sessions/providers/conversations/messages/citations/tool_runs.
3. ✅ **Persetujuan** saat daftar (checkbox wajib) + catatan versi kebijakan yang disetujui (`consent_version`/`consent_at`,
   diisi `POLICY_VERSION` di `bridge/src/chat-api.mjs`). Naikkan versi saat teks kebijakan berubah bermakna.
4. ⬜ **Kontak** operator untuk permintaan subjek data (ganti "hubungi operator" dengan email/tautan resmi).
5. ✅ **Retensi terjadwal**: cron Netlify tiap menit menjalankan `sweepChatRetention` (`bridge/src/retention.mjs`) —
   membersihkan sesi kedaluwarsa dan membuang jejak `tool_runs` lebih tua dari **90 hari** (`TOOL_RUN_KEEP_MS`).
6. ✅ **Enkripsi at-rest & in-transit**: `ENCRYPTION_KEY` operator untuk API key; TLS wajib (Netlify).
7. ✅ **Log**: tidak ada API key/password/isi chat yang tercatat di log server.
8. ⬜ **Anak**: tetapkan batas usia minimum sesuai kebijakan.
9. ⬜ **Transfer lintas negara**: kunci region Neon + kumpulkan DPA Neon/Netlify; dokumentasikan dasar transfer.
10. ✅ **Notifikasi insiden**: runbook + template di [runbook-insiden-adhitron-web.md](runbook-insiden-adhitron-web.md)
    (UU PDP: pemberitahuan ke subjek data & lembaga maks. 3×24 jam; GDPR: 72 jam ke otoritas).
11. ✅ **Lampiran pada chat (Fase 1)** — teks kebijakan dilengkapi: (a) lampiran diteruskan ke penyedia AI;
    (b) nama file & isi lampiran teks disimpan, isi gambar tidak; (c) tanggung jawab user atas data pribadi
    pihak ketiga dalam lampiran. `POLICY_VERSION` dinaikkan ke `2026-11-23`. Lihat bagian
    "Lampiran pada chat — temuan & teks usulan" di atas.

## Perlu konfirmasi tim legal

- **Dasar pemrosesan lampiran.** Saat ini dasar yang dinyatakan adalah kontrak (menjalankan layanan yang diminta).
  Mengirim lampiran ke penyedia AI atas perintah user masih dapat dibingkai sebagai kontrak; **konfirmasi** apakah
  perlu penjelasan tambahan bahwa penyedia AI adalah pihak ketiga independen (bukan *processor* operator) dan
  apakah operator perlu DPA terpisah dengan user untuk aliran ini.
- **Data pribadi pihak ketiga dalam lampiran.** Operator memproses data pribadi orang lain yang dibawa user tanpa
  hubungan langsung. Konfirmasi klausul tanggung jawab user yang tepat di ToS dan perlu-tidaknya mekanisme
  permintaan subjek data pihak ketiga (mis. bila seseorang meminta penghapusan gambar/log yang memuat datanya).
- **Retensi lampiran.** Konfirmasi bahwa "selama akun aktif + terhapus saat hapus akun" memadai, atau perlu batas
  waktu terpisah untuk `meta.textBlocks` yang berisi data pribadi pihak ketiga.
- **Transfer lintas negara.** Lampiran ikut terkirim ke penyedia AI yang dapat berada di luar Indonesia; kaitkan
  dengan item #9 (region Neon + dasar transfer).

## Catatan teknis yang mendukung kepatuhan

- **Arsip versi kebijakan.** `POLICY_VERSION` (`bridge/src/chat-api.mjs`) dicatat di tiap akun saat daftar
  (`users.consent_version`). Teks tiap versi terarsip permanen di riwayat git (commit yang memuatnya), jadi isi
  yang disetujui user dapat dibuktikan. Naikkan versi **sebelum** mengubah teks kebijakan yang sudah dilihat user.
  - `2026-11-22` — versi publik pertama (persetujuan wajib saat daftar; retensi, dasar pemrosesan, cookie, dan
    hak subjek data). Belum dirilis saat dokumen ini ditulis; tetapkan commit rilisnya di `CHANGELOG.md`.
  - `2026-11-23` — menambahkan **lampiran pada chat**: lampiran (teks & gambar) diteruskan ke penyedia AI;
    nama file & isi lampiran teks disimpan, isi gambar tidak; retensi lampiran ikut pesan/akun; serta tanggung
    jawab user atas data pihak ketiga dalam lampiran (lihat bagian "Lampiran pada chat — temuan & teks usulan").

- API key user dienkripsi AES-256-GCM dengan kunci operator (`bridge/src/secrets.mjs`); bentuk publik hanya hint.
- Cookie sesi `httpOnly` + `Secure` + `SameSite=Lax`; state-changing request wajib same-origin (anti-CSRF).
- Semua query repo ter-scope `userId`; data user lain tidak dapat diakses lewat API.
- Anti-SSRF mencegah browsing memanggil alamat internal/metadata cloud (`bridge/src/ssrf.mjs`).