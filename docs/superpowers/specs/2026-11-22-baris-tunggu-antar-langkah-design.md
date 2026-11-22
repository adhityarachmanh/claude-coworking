# Baris tunggu antar-langkah di chat — design

Tanggal: 2026-11-22
Status: disetujui (user memilih pendekatan 1)

## Kenapa

Saat Lead menugaskan satu langkah ke subagent, chat menutupnya dengan baris hasil milik subagent itu
(`✓ Selesai · 60 dtk · 1 langkah · konteks … · output …`). Setelah langkah itu tertutup dan sebelum Lead
memunculkan langkah berikutnya, **daftar chat berhenti** — padahal giliran masih berjalan (`st.busy` benar).
Satu-satunya penanda hidup adalah baris kecil `••• Tim sedang bekerja…` di bawah composer, yang mudah terlewat.
Pada konteks besar (mis. Lead 607k token) jeda antar-langkah ini terasa lama, sehingga tampak seperti macet —
padahal sesi itu memang lanjut dengan sendirinya.

## Tujuan

- Isi celah itu dengan satu baris eksplisit di ujung daftar chat selama giliran masih berjalan tetapi tidak ada
  langkah yang sedang berjalan: **"⏳ Tim sedang menyusun langkah berikutnya…"**.
- Baris hanya muncul saat memang menunggu (giliran hidup, tidak ada langkah `running`); hilang begitu langkah
  berikutnya datang atau giliran selesai.

## Non-tujuan

- Tidak mengubah baris hasil subagent (`✓ Selesai …`): itu memang benar — subagent-nya selesai.
- Tidak menyentuh mesin, antrian, izin, atau server. Murni tampilan dari `status.busy` yang sudah dikirim.
- Tidak menambah timer/polling baru: memakai event `status` dan `chat_update`/`chat` yang sudah ada.

## Batasan

- Teks UI Bahasa Indonesia; komentar kode bahasa Inggris.
- Aturan hidup di modul murni (`public/js/core/turn-progress.js`) agar bisa dites tanpa DOM.
- Tanpa dependensi baru, tanpa perubahan server.

## Keputusan

- **Aturan murni**: `nextStepHint({ busy, running })` di `public/js/core/turn-progress.js` mengembalikan string
  label atau `''`. `busy` = proyek sedang mengerjakan giliran; `running` = jumlah langkah yang masih `running`
  pada giliran berjalan (buat/tool/delegate). Muncul hanya bila `busy` **dan** `running === 0`.
- **Chat**: baris `<div class="chat-waiting">` ditempatkan setelah pesan terakhir. `renderChat` menambahkannya,
  dan sebuah `paintChatWaiting(status)` (dipanggil dari event `status` dan setelah render) menyalakan/mematikannya
  sesuai `nextStepHint`. Baris ini **bukan** pesan (tak masuk `state.chats`, tak pernah masuk hitungan giliran).
- **Aktivitas**: saat `busyNow()` benar tetapi tidak ada run yang `live`, tambahkan satu `<li class="activity-waiting">`
  berisi teks yang sama di ujung daftar. (Hanya mengganti baris "Belum ada aktivitas…" yang salah pada kondisi ini.)

## Test yang diharapkan (TDD)

- `test/next-step-hint.test.mjs` (baru, murni): `nextStepHint` `''` saat tidak busy; `''` saat ada langkah running;
  label saat busy tanpa langkah running.
- Test browser di blok chat yang ada (bila murah): baris muncul saat `busy` + tanpa langkah running, hilang saat
  giliran selesai. Bila blok chat berat, cukup test murni + verifikasi manual.