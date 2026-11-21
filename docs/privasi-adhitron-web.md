# Catatan Privasi & Kepatuhan — Adhitron Web (`/chat`)

Status: **draf untuk rilis publik v1** — wajib ditinjau penanggung jawab privasi (DPO) sebelum situs dibuka umum.
Acuan: UU PDP (UU No. 27/2022) dan, bila ada pengguna luar Indonesia, GDPR.

## Data apa yang disimpan

Adhitron Web (`/chat`) menyimpan data berikut di database Neon Postgres operator:

| Data | Isi | Dasar | Sifat |
|---|---|---|---|
| `users` | email, nama tampilan (opsional), **hash** password (scrypt + salt) | Akun pengguna | Pribadi |
| `sessions` | sha256 token sesi, waktu kedaluwarsa | Keamanan login | Pribadi |
| `providers` | label, jenis, base URL, **API key user terenkripsi AES-256-GCM**, 4 karakter terakhir (hint) | Layanan chat | Rahasia |
| `conversations` | judul, model/effort pilihan, toggle browsing | Riwayat chat | Pribadi |
| `messages` | isi obrolan user & asisten | Riwayat chat | Pribadi |
| `citations` | judul/URL/cuplikan sumber browsing | Fitur browsing | Publik (dari web) |
| `tool_runs` | catatan pencarian/pembacaan halaman (query/URL + status) | Kuota & audit fitur | Dapat memuat data pribadi bila user mengetikkannya |

Password **tidak pernah** disimpan/dilog dalam bentuk asli. API key user **tidak pernah** dikirim kembali ke klien
(hanya 4 karakter terakhir) dan tidak pernah ditulis ke log.

## Retensi & penghapusan

- Menghapus percakapan menghapus pesan & kutipannya (cascade). Menghapus provider menghapus API key-nya.
- **Hak hapus (UU PDP Pasal 35–36 / GDPR Pasal 17):** perlu jalur "hapus akun" yang menghapus **seluruh** baris
  milik user (users, sessions, providers, conversations, messages, citations, tool_runs). *(TODO: endpoint
  `DELETE /chat/api/me` + tombol di UI sebelum rilis publik.)*
- Sesi kedaluwarsa dibersihkan saat diakses; cron juga membersihkannya berkala bersama jejak `tool_runs` (lihat bagian retensi).

## Pihak ketiga

- **Neon** (database) — memproses seluruh data di atas atas nama operator.
- **Penyedia AI milik user** (OpenAI/Anthropic/Google atau OpenAI-compatible) — menerima isi pesan + API key milik
  user itu sendiri untuk menghasilkan jawaban. Ini pilihan user, bukan operator.
- **Mesin pencari** (DuckDuckGo HTML default; Tavily/Brave bila dikonfigurasi) — menerima teks **query** saat fitur
  Browsing aktif.
- **Netlify** (hosting + Blobs untuk rate-limit).
- Bila login pihak ketiga ditambahkan kelak: sebut penyedianya di sini.

## Wajib sebelum rilis publik

1. ✅ **Halaman Kebijakan Privasi** (`/privasi`) & **Syarat Layanan** (`/syarat`), ditaut dari footer semua halaman.
2. ✅ **Hapus akun & data**: `DELETE /chat/api/me` + tombol "Hapus akun" (konfirmasi bertingkat); cascade membuang
   sessions/providers/conversations/messages/citations/tool_runs.
3. ⬜ **Persetujuan** saat daftar (checkbox) + catatan versi kebijakan yang disetujui (kolom `consent_at`/`consent_version`).
4. ⬜ **Kontak** operator untuk permintaan subjek data (ganti "hubungi operator" dengan email/tautan resmi).
5. ✅ **Retensi terjadwal**: cron Netlify tiap menit menjalankan `sweepChatRetention` (`bridge/src/retention.mjs`) —
   membersihkan sesi kedaluwarsa dan membuang jejak `tool_runs` lebih tua dari **90 hari** (`TOOL_RUN_KEEP_MS`).
6. ✅ **Enkripsi at-rest & in-transit**: `ENCRYPTION_KEY` operator untuk API key; TLS wajib (Netlify).
7. ✅ **Log**: tidak ada API key/password/isi chat yang tercatat di log server.
8. ⬜ **Anak**: tetapkan batas usia minimum sesuai kebijakan.
9. ⬜ **Transfer lintas negara**: kunci region Neon + kumpulkan DPA Neon/Netlify; dokumentasikan dasar transfer.
10. ⬜ **Notifikasi insiden**: runbook + template (UU PDP maks. 3×24 jam).

## Catatan teknis yang mendukung kepatuhan

- API key user dienkripsi AES-256-GCM dengan kunci operator (`bridge/src/secrets.mjs`); bentuk publik hanya hint.
- Cookie sesi `httpOnly` + `Secure` + `SameSite=Lax`; state-changing request wajib same-origin (anti-CSRF).
- Semua query repo ter-scope `userId`; data user lain tidak dapat diakses lewat API.
- Anti-SSRF mencegah browsing memanggil alamat internal/metadata cloud (`bridge/src/ssrf.mjs`).