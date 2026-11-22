# ID per sesi + riwayat gaya Claude untuk `/chat` — design

Status: **disetujui, sedang dikerjakan.**
Tanggal: 2026-11-22. Fase: pengembangan lokal Adhitron Web (setelah Fase 1 lampiran).

## Intent & why

Adhitron Web saat ini hanya punya satu URL untuk chat, `/chat`. Berpindah atau membuka percakapan hanya
mengubah variabel di memori (`CONV` di `bridge/src/chat-app.mjs`); URL tidak berubah dan tidak ada
`history.pushState` maupun pemulihan saat muat ulang. Akibatnya:

- **Refresh selalu kembali ke empty state** ("Mulai mengobrol"); percakapan yang sedang dibuka hilang dari layar.
- Percakapan **tidak bisa di-bookmark**, tidak bisa dibuka di tab lain, dan tombol back/forward browser tidak
  berguna.
- Sidebar **Riwayat** hanya daftar judul polos: tanpa kelompok tanggal, tanpa ganti nama, tanpa tombol hapus.

Tujuannya menyamai pengalaman claude.ai: tiap percakapan punya identitas di URL (`/chat/<id>`), bisa
di-refresh/bookmark/dibuka di tab lain, dengan sidebar riwayat yang rapi dan bisa dikelola.

## Goals

- URL per percakapan: `/chat/<id>`; refresh/bookmark/buka-tab-lain bekerja; back/forward browser bekerja.
- Sidebar riwayat dikelompokkan **Hari ini / Kemarin / 7 hari terakhir / Lebih lama**, judul bisa
  **diganti** dan percakapan bisa **dihapus** (dengan konfirmasi).
- Berpindah percakapan **tanpa reload** (streaming & status tetap utuh).
- Sekaligus **memperbaiki bug select Model/Effort kosong** saat halaman pertama dimuat (karena select
  hanya terisi setelah sebuah percakapan dibuka).

## Non-goals

- Tidak mengubah skema DB (kolom `conversations.id`, `title`, `updated_at` sudah cukup).
- Tidak merender pesan di sisi server (server hanya menyajikan kerangka halaman yang sama).
- Tidak ada pencarian riwayat, tidak ada tautan publik antar pengguna (URL tetap di balik sesi), tidak ada
  virtual scroll.
- Tidak menyentuh streaming/Stop dan lampiran (Fase 1) selain memastikan tidak rusak.

## Anti-goals

- Jangan sampai streaming/Stop rusak atau percakapan reload penuh tiap pindah.
- Jangan sampai percakapan milik user lain bisa diakses; server tetap `404` untuk id bukan milik user.

## Constraints

- Chat adalah SPA: router `handleSite` (`bridge/src/site.mjs`) hanya mengenal `/chat` dan `/chat/app.js`.
- Logika klien disajikan sebagai **string** (`chatAppJs()`), bukan modul Node; hanya diuji syntax (`vm.Script`).
  Karena itu logika murni baru ditaruh di **modul sungguhan** yang bisa di-`import` dan dites, lalu disematkan
  ke string klien (pola sama dengan `bridge/src/attachment-rules.mjs` yang disalin verbatim).
- Endpoint `PATCH /chat/api/conversations/:id` dan `DELETE /chat/api/conversations/:id` **sudah ada**
  (`bridge/src/chat-api.mjs`), jadi tidak perlu API baru.

## Approaches (sudah dibahas & dipilih)

- **A. Routing sisi-klien (`history.pushState`) + rute server `/chat/<id>` — DIPILIH.** Perubahan server
  minimal (satu cabang rute), perpindahan instan (tanpa reload), back/forward bekerja karena URL nyata.
- **B. Render penuh per percakapan (reload tiap pindah).** Ditolak: reload penuh tiap ganti percakapan membuat
  streaming/status hilang dan terasa lambat.
- **C. Hanya `localStorage`.** Ditolak: tidak bisa bookmark/dibuka di tab lain — bukan "seperti Claude".

## Bagian yang sudah diputuskan

1. **Rute server** (`bridge/src/site.mjs`): `/chat` dan `/chat/<uuid>` (`^/chat/[0-9a-fA-F-]{36}$`) menyajikan
   halaman chat yang sama bila ada sesi; tanpa sesi → `302 /auth/login`; `/chat/<id-ngawur>` → `null` (404).
   `/chat/app.js` tetap seperti sekarang.
2. **Klien**: saat muat, baca `location.pathname`; bila ada id → `openConv(id)`; bila `GET /conversations/:id`
   membalas 404 → `history.replaceState(null, '', '/chat')` + empty state. Pindah percakapan →
   `history.pushState(null, '', '/chat/' + id)`. Percakapan baru dari mengirim pesan → `replaceState('/chat/'+id)`
   (agar tombol back kembali ke percakapan sebelumnya / empty, bukan kembali ke "baru" lagi). Event `popstate`
   → buka/serve sesuai URL.
3. **Select Model/Effort**: pecah `renderModelOptions()` menjadi `renderModelSelectors()` (selalu mengisi opsi
   dari provider efektif + daftar Effort) dan `syncConvControls()` (nilai spesifik percakapan). Empty state pun
   punya select terisi — **bug kosong hilang**.
4. **Sidebar riwayat**: kelompok tanggal dari `updatedAt` (zona waktu **lokal** browser). Tiap item: klik = buka;
   **ganti nama** inline (ikon ✎ → input → Enter/blur menyimpan via `PATCH`); **hapus** (ikon 🗑 + konfirmasi via
   `DELETE`; bila percakapan aktif yang dihapus → `replaceState('/chat')` + empty state).
5. **Logika kelompok tanggal** ditaruh di modul murni baru `bridge/src/chat-list.mjs`
   (`groupConversations(convs, nowMs, { locale })`), **dites langsung**, lalu disematkan ke string klien lewat
   `.toString()` — satu sumber kebenaran.

## Keputusan pembuat (bisa dikoreksi)

- Ganti nama **inline** (bukan `prompt()` bawaan browser) — lebih rapi dan konsisten dengan UI.
- Kelompok memakai **waktu lokal browser**, bukan UTC.
- Tombol hapus & ganti nama muncul **saat hover/focus** pada item (tetap ramah sentuh lewat `pointer:coarse`).

## What's left to the builder

- Detail CSS: gaya header grup (`.convs-head` sudah ada), ikon aksi hover, input rename, mode gelap/tema yang
  sudah ada (`--accent`, `--surface-2`, dst).
- Tinggi/scroll sidebar: daftar `.convs` sudah `overflow:auto; flex:1`, pastikan tetap benar dengan header grup.
- Perilaku ramah HP: aksi hapus/rename pada `@media(pointer:coarse)` sudah punya `min-height:44px`.

## Rencana test

- `bridge/chat-list.test.mjs` (baru): `groupConversations` — batas hari (Hari ini/Kemarin/7 hari/Lebih lama),
  urutan menurun, tanggal tanpa zona, daftar kosong, `updatedAt` null/kacau.
- `bridge/netlify.test.mjs` / `bridge/functions.test.mjs`: `/chat/<uuid>` dengan sesi → 200 halaman chat;
  `/chat/<id-ngawur>` → 404 (null); `/chat/<uuid>` tanpa sesi → redirect `/auth/login`; `app.js` tetap
  syntax-valid (`vm.Script`).
- Pastikan `GET /conversations/:id` milik user lain tetap `404` (sudah ada di suite chat).
- Definisi selesai: `npm run test:related -- bridge/src/chat-list.mjs bridge/src/site.mjs bridge/src/chat-app.mjs`
  hijau, `npm run check` hijau, area UI terkait (bila ada) hijau, `CHANGELOG.md` diperbarui.