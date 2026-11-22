# Pantau CI opsional (saklar per project) — design

Tanggal: 2026-11-22
Status: disetujui (user: "sesuaikan sesuai rekomendasi kamu")

## Kenapa

Pemeriksa CI GitHub (`src/github-ci.js`) berjalan **otomatis** setelah setiap push: ia mengikuti run commit
yang baru di-push, menampilkan chip di tab Perubahan, dan menulis satu baris di chat saat run selesai. Untuk repo
yang CI-nya memang belum aktif — workflow template yang sengaja dibiarkan merah (mis. `asset-management-white-label`
yang `ci` + `migrate`-nya gagal karena secret/DB belum diisi) — baris **"❌ CI GitHub gagal: …"** terbaca seperti
error yang harus ditindak, padahal user belum mengaktifkan CI di repo itu.

Saat ini tidak ada cara mematikannya: begitu push terjadi, pemeriksaan dan garisnya selalu muncul.

## Tujuan

- Satu saklar per project yang mematikan pemantauan CI: **tidak ada** polling, **tidak ada** chip, **tidak ada**
  baris chat untuk repo itu — sampai dinyalakan lagi.
- Bawaan **nyala**: perilaku sekarang tidak berubah bagi project yang memang memakai CI.
- Bisa diubah dari Pengaturan giliran (laptop dan HP lewat Tailscale), tersimpan di `state.json` per project.

## Non-tujuan

- Tidak menghapus fitur pemeriksaan CI-nya (tetap ada, hanya bisa dimatikan).
- Tidak mendeteksi otomatis "workflow ini masih template" (itu pendekatan B/C yang ditolak): keputusan tetap milik user.

## Anti-tujuan (gagal kalau terjadi)

- Mematikan saklar masih menyisakan chip ❌ atau baris chat lama yang mengesankan error.
- Menyalakan lagi tidak memulai pemantauan baru setelah push berikutnya.

## Batasan

- Per project, lewat jalur setelan yang sudah ada (`POST /api/projects/:id/settings`, `hub.cleanSettings`), jadi
  validasi/hak akses ikut jalur yang sama (WiFi biasa tetap read-only).
- Hanya membaca GitHub; tidak menjalankan ulang apa pun.
- Tanpa dependensi baru, tanpa skema baru di luar `state.json` (`settings[id].ciFollow`).

## Pendekatan yang dipertimbangkan

1. **Saklar per project "Pantau CI setelah push" (dipilih).** Paling sederhana: user yang tahu repo-nya belum siap
   mematikannya sekali, dan repo itu senyap. Mematikannya juga menghentikan polling dan membersihkan chip.
2. **Baris gagal hanya setelah workflow pernah hijau (baseline).** Otomatis senyap untuk template, tetapi perlu
   menyimpan riwayat dan terasa "sihir".
3. **Buang baris chat untuk gagal; sisakan chip di Perubahan.** Mengurangi kebisingan, tetapi chip ❌ tetap ada dan
   pemeriksaan tetap berjalan.

User memilih **1**.

## Keputusan

- **Nama & nilai**: `ciFollow` (boolean) di `settings[id]`; **absen = nyala**. Hanya `false` yang mengartikan "mati",
  sehingga tidak ada migrasi untuk `state.json` lama.
- **Perubahan setelan**: `hub.cleanSettings` menerima `ciFollow` boolean; `hub.ciFollowFor(id)` mengembalikan
  `settingsFor(id).ciFollow !== false`.
- **Watcher**: `CiWatcher.watch(id)` menolak jalan saat `hub.ciFollowFor(id)` palsu (tidak ada `ci: pending`, tidak
  ada polling, tidak ada chat). `CiWatcher.unwatch(id)` menghentikan yang sedang berjalan (timer dibatalkan, entry
  dihapus) sehingga poll yang tengah menunggu `check()` berhenti sendiri.
- **Efek di route setelan**: saat `patch.ciFollow === false` → `hub.ciUnwatch(id)` + `hub.setStatus(id, { ci: null })`
  (chip hilang). Saat `true` → `hub.ciWatch(id)` (mulai memantau commit saat ini; maju ke push berikutnya).
- **UI**: checkbox **🐙 Pantau CI setelah push** di dalam `.controls` (Pengaturan giliran), di bawah **Tolak izin tak
  terjawab**. `renderComposer` mengisi `#ci-follow.checked = st.ciFollow !== false`; perubahannya lewat `saveSettings`
  (kirim `ciFollow`). `#ci-follow` ikut dinonaktifkan di mode hanya-lihat.
- **Chip**: `renderCi` menyembunyikan chip saat `st.ci` kosong **atau** `st.ciFollow === false` (pertahanan lapis
  kedua di sisi klien).

## Test yang diharapkan (TDD)

- `test/github-ci.test.mjs`: watcher **tidak** memantau saat `ciFollowFor` palsu (tidak ada status maupun chat);
  `unwatch` menghentikan pemantauan yang berjalan tanpa baris chat.
- `test/hub-ci-follow.test.mjs` (baru, unit murni): `DEFAULT` → `ciFollowFor` true; `cleanSettings({ciFollow:false})`
  tersimpan dan `ciFollowFor` jadi false; `{ciFollow:true}` kembali true; junk (non-boolean) diabaikan.
- Tidak menyentuh UI test berat (checkbox muncul di `.controls` yang sudah dites lewat jalur setelan yang ada).

## Yang saya panggil sendiri

- Nama setelan `ciFollow` dan label **"Pantau CI setelah push"**.
- Ikon 🐙 (gurita GitHub) sejajar gaya label lain.
- Mematikan juga membersihkan chip (bukan hanya menghentikan langganan) supaya "mati" benar-benar berarti diam.