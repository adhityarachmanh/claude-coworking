# "Chat umum" di aplikasi lokal Adhitron — design

Tanggal: 2026-11-22
Status: disetujui
Ukuran: perubahan sedang (Fase 1); Fase 2 opsional

## Kenapa

Aplikasi lokal Adhitron hanya menyetir mesin coding (Claude Code / OpenCode) **per project**: satu
proses per folder, `data/chats/<id>.jsonl` per folder, dan **setiap** porta mesin butuh `cwd` — baik
`spawn` Claude (`cwd: project.path`, `src/session.js:915`) maupun `session/new` OpenCode
(`cwd: this.project.path`, `src/acp-session.js:1963`). Tak ada permukaan untuk sekadar **bertanya hal
umum** (mis. menyusun timesheet, merencanakan sesuatu) tanpa mengotori sebuah project kerja.

Aplikasi sudah punya konsep entri **virtual** (`demo`, `path: null`, `src/hub.js:370`), tapi ia dibuang
di mana-mana: `withProject` → 404, chat/turn/antrian/riwayat semua `continue` bila `virtual`, dan
`health`/dashboard tak menghitungnya. Jadi entri virtual bukan sesi; ia demo animasi.

Yang **gratis** kalau memakai jalur project biasa (project nyata bersumber `folder`/`custom`):
ganti mesin Claude↔OpenCode, pilih model/effort, Effort/Model Auto, 📋 Antrian, riwayat ⌛ & resume,
⏪ rewind, mode tim, panel chat, dan komposer — semuanya sudah per-project.

## Tujuan

- Satu **project bawaan** "Chat umum" yang bisa dipilih dari picker seperti project lain, memakai
  mesin chat yang sama (Claude Code / OpenCode, bisa diganti).
- Konteksnya **global**, bukan terikat folder project kerja user: mesin bekerja di sebuah **folder
  sandbox milik aplikasi** (`<dataDir>/chat-umum/`), jadi file kerja (mis. `timesheet.md`) tidak
  menyentuh foldermu.
- Nyaman dipakai: selalu muncul **paling atas** di picker, ikon 💬.

## Non-tujuan

- Tidak membuat UI chat baru: memakai panel chat yang sudah ada.
- Tidak menghapus atau mengubah data project user.
- Tidak mengganti atau menyamarkan "Demo kantor".
- Tidak menyentuh jalur AI-provider langsung (itu arah lama "Adhitron Web", sudah dibatalkan).

## Anti-tujuan

- Menjadikan "Chat umum" project **user** biasa yang bisa dihapus/diarsipkan dan bisa hilang saat
  pindai ulang folder — ia harus selalu ada.
- Membuat mesin berjalan **tanpa** `cwd` (`path: null`): menyentuh `spawn`, `session/new`, transkrip,
  backup, dan rewind sekaligus — jauh lebih rapuh untuk manfaat yang setara.

## Kendala & temuan kode

- **Entri hilang saat rescan.** `refreshProjects()` (`server.js:730`) menghapus tiap project yang tak
  menyumbang `sources` (`if (!project.sources.length …) hub.projects.delete(id)`), dan `discoverProjects`
  (`src/projects.js:56`) hanya memunculkan folder di bawah root. Entri bawaan bisa terhapus di sini bila
  tak dijaga.
- **Entri ganda bila folder di bawah root.** `upsertProject` memakai `projectId(dir)` (hash SHA-1 dari
  path). Sandbox diletakkan di `<dataDir>/chat-umum/`, sedangkan `discoverProjects` memakai
  `PROJECTS_ROOT` (default `~/projects`) — dua akar berbeda, jadi sandbox tak akan pernah memunculkan
  entri folder duplikat. Tetap dijaga: entri bawaan memakai **id tetap** `chat-umum`.
- **Id tak boleh diturunkan dari path** untuk membedakan entri bawaan dari project folder biasa.
- **Isolasi test.** Hub dibuat dengan `new Hub({ dataDir })` (lihat `test/budget.test.mjs`); sandbox
  harus ikut `dataDir` yang sama supaya test tak menyentuh data nyata.

## Pendekatan (dipilih: A)

- **A. Project bawaan bersandbox (dipilih).** Id tetap `chat-umum`, `path: <dataDir>/chat-umum/`,
  ditandai `system: true`. Sesi memakai jalur project biasa. Hampir nol kode mesin; semua fitur
  per-project langsung berlaku. Sandbox memenuhi kebutuhan `cwd`.
- **B. Project virtual `path: null` (ditolak).** Paling "murni" tapi menyentuh spawn/sesi/transkrip/
  backup/rewind — paling besar & rapuh.
- **C. Panel chat global terpisah (ditolak).** UI + jalur server baru; duplikasi besar dari yang ada.

## Rancangan (Fase 1 — inti)

### Server

1. **Registrasi entri.** Konstanta `GENERAL_ID = 'chat-umum'` di `src/hub.js`; entri
   `{ id: GENERAL_ID, name: 'Chat umum', path: <dataDir>/chat-umum, sources: ['system'], system: true }`
   dibuat di konstruktor Hub (ketika dataDir diketahui), dengan folder sandbox `mkdirSync(recursive:true)`.
2. **Tahan rescan.** `refreshProjects()` tidak mengapus/mengutak-atik entri `system`; ia dipastikan ada
   (di-`upsert` bila hilang). Tetapkan juga `settings.engine` default untuknya bila belum ada (pola
   `upsertProject` yang menyemai engine).
3. **Kecualikan dari "project nyata".** `src/health.js` (`realProjects`) memfilter `p.system` seperti
   `virtual`/`demo`; dashboard klien menyembunyikannya dari hitungan "semua project" bila relevan.
4. **Guard rute destruktif** (pertahanan berlapis; UI juga menyembunyikan tombolnya):
   - `POST /api/projects/:id/purge` (`src/routes/projects.js`) → tolak 409 untuk entri `system`.
   - `POST /api/projects/:id/archive` (`src/routes/projects.js`) → tolak 409 untuk entri `system`.
   - `POST /api/data/project` (`src/routes/data.js`, hapus data satu project) → tolak 404/409 untuk
     entri `system` (mengikuti pola `virtual` di sana).
   - `POST /api/projects` & `/api/config`: tak perlu perubahan.
5. **Pulihkan sandbox** bila dihapus user: `refreshProjects()` memastikan folder ada lagi.

### Klien

1. **Urutan & ikon picker** (`public/js/features/picker.js`): entri `system` **selalu di paling atas**
   (`projectRank` mengembalikan nilai tertinggi) dan berikon 💬.
2. **Sembunyikan aksi destruktif** untuk entri `system`: tanpa tombol 📦 arsip, 🗑 purge, maupun ×
   "hapus dari daftar". Bintang favorit pun disembunyikan (selalu di atas, tak perlu difavoritkan).
3. Judul/jalur: tampilkan "Simulasi"/"Sandbox" alih-alih path mentah bila perlu.

## Fase 2 (opsional, menyusul) — menjangkau project

Saat sesi "Chat umum" jalan, folder **root project user** ditambahkan sebagai direktori yang diizinkan
mesin (Claude `--add-dir`, OpenCode padanannya) sehingga ia bisa **membaca** project tanpa menjelajah
seluruh disk. **Wajib diverifikasi ke versi CLI terpasang** sebelum dipakai; bila flag tak tersedia,
Fase 1 tetap jalan (chat-umum hanya bekerja di sandbox-nya). Tidak dikerjakan sampai Fase 1 mendarat
dan diverifikasi.

## Bagian yang diserahkan ke pelaksana

- Nama folder sandbox (`chat-umum`) dan konstantanya.
- Detail penjagaan `refreshProjects` (upsert vs. skip) — pilih yang paling kecil perubahannya.
- Bentuk pesan penolakan (409) untuk rute destruktif.

## Uji terima

1. "Chat umum" selalu ada di `listProjects()` setelah beberapa kali `refreshProjects()`, walau sandbox
   dihapus di tengah.
2. Bisa menjalankan sesi (Claude & OpenCode) dengan `cwd` = sandbox.
3. Ganti mesin, pilih model/effort, Auto, antrian, resume setelah restart — bekerja (diuji di jalur
   sesi yang sudah ada).
4. `POST /api/projects/:id/purge`, `archive`, dan `/api/data/project` menolak id `chat-umum`.
5. Entri `system` tak dihitung sebagai "project nyata" di health.
6. Picker menaruhnya paling atas, ikon 💬, tanpa tombol destruktif.
7. `npm run check` hijau + `test:related` untuk berkas yang diubah.