# Runbook Notifikasi Insiden — Adhitron Web (`/chat`)

Status: **draf untuk rilis publik v1** — tinjau bersama penanggung jawab privasi (DPO) sebelum situs dibuka umum.
Acuan: UU PDP (UU No. 27/2022, khususnya Pasal 46) dan GDPR (Pasal 33–34) bila ada pengguna di UE.

Tujuan: bila terjadi **pelanggaran data pribadi** (confidentiality/integrity/availability), tim tahu urutan langkah,
siapa yang memutuskan, dan apa isi pemberitahuan — sehingga batas waktu terpenuhi.

## 1. Batas waktu (jangan lewat)

| Kewajiban | Batas | Ke mana |
|---|---|---|
| Pemberitahuan awal ke **subjek data** | **3×24 jam** sejak diketahui | email terdaftar tiap user terdampak |
| Pemberitahuan ke **lembaga PDP** (Indonesia) | **3×24 jam** sejak diketahui | kanal resmi lembaga |
| Bila ada pengguna **UE** — ke otoritas pengawas | **72 jam** sejak diketahui | otoritas pengawas (lead) |
| Bila ada pengguna **UE** & risiko tinggi — ke subjek data | **tanpa penundaan yang tidak perlu** | email/kontak user |

Ukuran waktu dihitung sejak insiden **diketahui** (bukan sejak terjadi). Mulai hitung dari saat siapa pun di tim
menyadarinya; catat waktunya.

> Isi tabel di atas wajib dikonfirmasi legal: UU PDP Pasal 46 mengatur pemberitahuan tertulis **paling lambat 3×24 jam**
> kepada subjek data dan lembaga. GDPR menetapkan 72 jam ke otoritas. Bila keduanya berlaku, penuhi yang **paling ketat**
> (3×24 jam).

## 2. Peran

| Peran | Siapa | Tugas |
|---|---|---|
| Penanggung jawab insiden | *(isi: nama/telepon)* | memutuskan tingkat insiden, memimpin respons |
| Kontak privasi (DPO) | *(isi: nama/email)* | menyusun & mengirim pemberitahuan, catat keputusan |
| Kontak teknis | *(isi: nama/telepon)* | mitigasi teknis, perbaikan, bukti |
| Kontak vendor | Neon (support), Netlify (support) | bila akar masalah di vendor |

(*Placeholder di atas harus diisi operator sebelum rilis publik — ini bagian dari checklist `privasi-adhitron-web.md` item #4.*)

## 3. Klasifikasi awal (5 menit pertama)

Tanya cepat:

1. **Data apa** yang terdampak? (email/hash password/API key terenkripsi/isi chat/`tool_runs`)
2. **Berapa banyak** user & seberapa sensitif?
3. **Apakah masih berlangsung** (kebocoran aktif) atau sudah berhenti?
4. **Penyebab**: bug aplikasi, kebocoran kredensial operator, vendor (Neon/Netlify), atau penyedia AI milik user?
5. **Risiko**: apakah data bisa dipakai merugikan (mis. API key terdekripsi, sesi valid dicuri)?

Tingkat:
- **P1 (tinggi)** — isi chat/API key terdekripsi/export seluruh DB bocor, sesi besar-besaran dapat diambil. Notifikasi penuh.
- **P2 (sedang)** — akses tak sah terbatas, sebagian kecil user, tidak ada rahasia plaintext.
- **P3 (rendah)** — hampir tanpa dampak pada subjek data. Cukup catat internal.

## 4. Langkah respons (paralel bila bisa)

1. **Kurangi dampak** — cabut kredensial terdampak (putar `ENCRYPTION_KEY`? hapus sesi terdampak lewat SQL
   `delete from sessions ...`), matikan fitur/endpoint yang menjadi vektor, blokir akses.
2. **Simpan bukti** — jangan hapus log/jejak sebelum tercatat. Salin log fungsi Netlify, log Neon, dan catatan
   `tool_runs`/`sessions` yang relevan (timpa dengan tanda waktu UTC).
3. **Tentukan cakupan** — daftar user terdampak (dan hanya mereka) untuk pemberitahuan.
4. **Perbaiki akar masalah** — patch, uji (test regresi), deploy, lalu verifikasi.
5. **Catat** — satu catatan linimasa: waktu diketahui, waktu tiap langkah, keputusan, siapa memutuskan.

## 5. Pemberitahuan (template)

Kirim lewat email terdaftar (dan pengumuman di situs bila skala besar). Nada: jelas, tanpa menyalahkan, tanpa
detail teknis yang membahayakan. Isi minimum yang diwajibkan:

- apa yang terjadi & kapan;
- data pribadi apa yang terdampak;
- kemungkinan akibatnya;
- langkah yang sudah kami lakukan;
- langkah yang bisa dilakukan user (mis. ganti API key, ganti password, logout semua perangkat);
- kontak privasi untuk bertanya.

### Draft email (ID)

> Subjek: **Pemberitahuan insiden data pribadi — Adhitron Web**
>
> Halo,
>
> Kami mengabari adanya **insiden keamanan** pada layanan Adhitron Web yang mungkin memengaruhi data akunmu.
>
> **Apa yang terjadi:** [1–2 kalimat, tanpa detail yang membahayakan].
> **Kapan:** [tanggal/jam, zona waktu].
> **Data yang mungkin terdampak:** [mis. email & isi percakapan / API key terenkripsi].
> **Kemungkinan dampak:** [ringkas & jujur].
> **Yang sudah kami lakukan:** [mitigasi & perbaikan].
> **Yang sebaiknya kamu lakukan:** [ganti password / putar API key di penyedia AI / keluar dari semua perangkat].
>
> Kami menyesali kejadian ini. Pertanyaan: [kontak privasi].
>
> — [Nama operator]

### Draft catatan internal (untuk arsip kepatuhan)

```
Insiden: <id>            Diketahui: <UTC>        Tercatat oleh: <nama>
Tingkat: P1/P2/P3        Cakupan: <n> user       Data: <kategori>
Penyebab: <...>          Mitigasi: <...>         Perbaikan: <...>
Kirim ke subjek: <waktu> Kirim ke lembaga: <waktu>  Otoritas UE: <waktu/NA>
Keputusan & dasar: <...> Tindak lanjut: <...>
```

## 6. Sesudahnya (post-mortem, dalam 7 hari)

- Tulis post-mortem: akar masalah, deteksi, respons, apa yang bisa diperbaiki.
- Tambah test yang menangkap ulang insiden (agar tak terulang).
- Perbarui dokumen ini bila ada langkah yang ternyata kurang.
- Bila ada perubahan kebijakan, naikkan `POLICY_VERSION` (`bridge/src/chat-api.mjs`) dan pertimbangkan pemberitahuan.

## 7. Kontak cepat

| Perlu | Ke mana |
|---|---|
| Neon support / status | *(isi tautan)* |
| Netlify support / status | *(isi tautan)* |
| Lembaga PDP (Indonesia) | *(isi kanal resmi)* |
| Penasihat hukum | *(isi)* |

> Catatan: jangan menyimpan kredensial operator di dokumen ini. Gunakan pengelola rahasia tim.