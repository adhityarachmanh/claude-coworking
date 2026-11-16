# Aktivitas tim yang jelas — desain (2026-11-16)

## Kenapa

Panel **Aktivitas** (dan monitor **⧗ Tugas latar**) menampilkan **satu baris per tool call**. Satu agent
yang menjalankan 13 perintah tampil sebagai 13 baris tanpa durasi, tanpa hitungan langkah, dan tanpa tanda
"sudah selesai" yang jelas. Ringkasan di atas panel milik tugas sebelumnya, sehingga panel bisa bilang
"Selesai" sambil masih menampilkan aktivitas. Hasilnya: proses yang normal terlihat seperti **loading
yang macet**.

Tujuan: setiap proses terbaca dalam sekali lihat — **siapa** yang bekerja, **sedang apa**, **sudah berapa
lama**, **macet atau tidak**, dan **apa yang sudah selesai** — tanpa persentase palsu.

## Keputusan

**Satu baris per agent (run), langkah di dalamnya bisa dibuka-tutup.** Deteksi "lama" dihitung dari jarak
antar-langkah. Agent yang selesai melipat otomatis. Murni tampilan: **tidak ada perubahan server, API, atau
perilaku Stop**.

Contoh tampilan:

```
⏳ Backend · 7 langkah · 1:12              [▾]
   ├ Menjalankan test bridge         ✓ 8 dtk
   ├ Debug manual register           ✓ 21 dtk
   └ Menjalankan ulang test         ⟳ 12 dtk
✓ Frontend · 9 langkah · 34 dtk            [▸]   (dilipat 5 dtk setelah selesai)
```

### Alternatif yang ditolak

- **Timeline ringkas (gabung langkah sejenis).** Lebih murah, tetapi tetap kacau ketika dua agent berjalan
  bersamaan karena tidak ada batas "milik siapa" tiap baris.
- **Progres dari server (penghitung langkah + heartbeat).** Paling akurat, tetapi menyentuh
  `src/acp-session.js`, `/tasks`, dan test-nya untuk manfaat yang kecil dibanding tampilan di atas.

## Perilaku

### Pengelompokan (agent run)

- Satu **run** = satu **role dalam satu giliran**. Giliran dimulai oleh event `prompt`; dua agent yang bekerja
  bersamaan karena itu tetap punya barisnya masing-masing, dan run dari giliran lama tidak dihidupkan lagi oleh
  giliran baru.
- Event `delegate` dan `agent_stop` tetap tampil sebagai langkah di dalam run-nya (bukan run baru).
- Run diurutkan menurut aktivitas terakhirnya (terbaru di atas), sehingga run panjang yang masih bekerja tetap
  di atas run pendek yang baru selesai.
- Run terbaru yang masih berjalan **terbuka**; run selesai **terlipat** otomatis **5 detik** setelah
  langkah terakhirnya, dan bisa dibuka lagi dengan satu klik.
- Batas 200 event lama tetap berlaku; run yang terlipat tidak merender langkah sama sekali (DOM tetap kecil).

### Status dan "tidak macet"

- **Berjalan**: ada langkah baru dalam 45 detik terakhir → spinner + durasi berjalan.
- **Menunggu**: 45–120 detik tanpa langkah baru → titik kuning, teks "menunggu 45 dtk".
- **Lama**: lebih dari 120 detik tanpa langkah baru **dan role itu masih memegang pekerjaan** (tool/agent yang
  belum selesai) → "lama, masih jalan · 2 mnt" + pengingat **■ Stop**. Role yang sudah tidak memegang pekerjaan
  disebut **selesai**, bukan "masih jalan".
- Penghitung waktu berdetak tiap detik dengan memperbarui **teks** saja (bukan menggambar ulang daftar),
  agar tidak berkedip dan tidak kehilangan fokus.

### Tugas latar (⧗)

- Baris yang berjalan tetap seperti sekarang (durasi + spinner), ditambah badge "menunggu N dtk" di
  **detail tugas** bila langkahnya diam terlalu lama (agent saja; shell yang lama berjalan itu normal).
- Lebih dari 3 tugas selesai diringkas menjadi satu baris "✓ 7 selesai" yang bisa dibuka.

### Baris status composer

- Label sudah mengikuti mesin project (OpenCode/Claude Code) — tidak berubah di sini.
- Bila giliran berjalan tanpa langkah baru lebih dari 2 menit, teksnya menjadi
  "… masih bekerja · 2 mnt" supaya pengguna tahu itu bukan macet.

### Aksesibilitas

- Header run adalah `<button aria-expanded>`; isi memakai `<ol>`; pembacaan layar menerima teks status
  ("7 langkah, berjalan 1 menit 12 detik").
- Animasi buka-tutup menghormati `prefers-reduced-motion`.

## Yang tidak berubah

- Perilaku **■ Stop**, urutan event, isi chat, dan kontrak API.
- Tidak ada persentase/estimasi progres karena jumlah langkah total tidak diketahui di awal.

## Test

- Unit murni `public/js/core/agent-runs.js`: pengelompokan per role, batas jeda 90 dtk, ambang
  berjalan/menunggu/lama (45/120 dtk), durasi, run kosong, dan run yang sudah selesai.
- UI area "UI Aktivitas": dua agent paralel tampil sebagai dua baris, run selesai terlipat setelah
  hitungan, ticker memperbarui durasi tanpa menggambar ulang daftar, `aria-expanded` benar.
- `npm run check` + `npm run test:ui:area -- "UI Aktivitas"`.

## Risiko

- **Data event historis** dari sesi lama tidak punya timestamp langkah yang rapat: run bisa terpecah lebih
  sering. Dampaknya hanya tampilan (lebih banyak baris), bukan kehilangan data.
- **Jam klien mundur/maju** dapat menggeser label durasi; nilai di-clamp minimal 0.
