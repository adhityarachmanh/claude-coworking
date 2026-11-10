# Mesin Mengikuti Model (satu riwayat, tanpa switch) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hapus konsep "ganti mesin" dari alur pengguna: mesin ditentukan oleh model yang dipilih di Pengaturan giliran, riwayat kedua mesin tampil sebagai satu alur, dan konteks disambung otomatis saat mesin berganti.

**Architecture:** Sesi native tetap dua (Claude Code / OpenCode) dan store chat tetap dua (`data/chats`, `data/chats-opencode`). `settings[id].engine` menjadi hasil turunan dari model terakhir yang dipilih (bukan aksi switch). Saat `SessionManager.get()` melihat mesin berubah, proses lama ditutup, sesi baru dibuat, dan catatan konteks (dari chat mesin lama, tanpa panggilan model) disimpan sebagai handoff context yang ikut pada prompt berikutnya. Snapshot chat memakai timeline gabungan yang diberi tag `engine`, sementara penulisan tetap ke store mesin masing-masing.

**Tech Stack:** Node ≥ 20, ES modules, tanpa dependensi npm, frontend vanilla, `node --test`.

**Spec:** keputusan desain di percakapan (final plan, 10 Nov 2026). Dokumen pendukung: `docs/design-opencode.md` §11, `docs/FITUR.md` (Bagian Mesin & Riwayat), `src/handoff.js`.

## Global Constraints

- **Nol dependensi npm baru.** Hanya modul Node bawaan.
- **CSP tidak berubah**; frontend vanilla (tanpa framework/build step).
- **Tidak ada migrasi data**: dua store chat tetap dipakai; backup tetap dua store; `state.json` tidak berubah skemanya.
- **Tidak ada panggilan model** untuk auto-handoff (pakai isi chat yang sudah ada).
- Format kode mengikuti file sekitarnya; komentar bahasa Inggris seperti kode yang ada, teks UI bahasa Indonesia.
- Test wajib: `npm run lint`, `npm run test:fast` hijau; test baru untuk tiap perilaku.

## Review Focus

- Memilih model mesin lain saat project **sedang bekerja** tidak boleh membuat 409 permanen atau mengganti mesin di tengah giliran.
- Project dengan antrean/izin menunggu: perubahan mesin lewat model tidak boleh mencampur dua workspace.
- Auto-handoff hanya sekali per perpindahan dan tidak boleh berulang saat tidak ada pesan baru.
- Timeline gabungan harus stabil setelah restart (urutan `ts`, tidak ada duplikat) dan `chat_update` tetap mengenai pesan yang benar.
- Model yang tidak tersedia (provider logout) tidak boleh membuat giliran gagal tanpa pesan jelas (`modelStale` tetap berlaku).

---

### Task 1: Server — engine mengikuti model, timeline gabungan

**Files:**
- Modify: `src/hub.js` (`updateSettings` ~1117, `chat()` ~1711, `snapshot()` ~1827, `clearChat` ~624)
- Test: `test/engine-mix.test.mjs` (baru)

**Interfaces:**
- `updateSettings(id, patch)`: bila `patch.engine` berbeda dari sebelumnya **dan** `patch.model`/`patch.effort`/`patch.agent` dikirim bersamaan, nilai dari patch dipakai (jangan ditimpa `engineSettings`).
- `chat(id, msg)` menyimpan `engine: this.engineOf(id)` pada setiap pesan.
- `timeline(id, limit = CHAT_LIMIT)`: gabungan pesan dua store + runtime, diberi `engine` per pesan, diurutkan `(ts, id numerik)`, dipotong `limit`.
- `snapshot()` memakai `timeline(id)` untuk `chats[id]`.
- `clearChat(id)` menghapus kedua store + `rt.chat`.

- [ ] Tulis test: `updateSettings({engine:'opencode', model:'opencode-go/x'})` menyimpan model itu (bukan model lama OpenCode).
- [ ] Tulis test: `timeline()` menggabungkan pesan claude+opencode urut `ts`, tiap pesan punya `engine`; setelah `snapshot()` panjang ≤ 150.
- [ ] Implementasi, jalankan `node --test test/engine-mix.test.mjs`.
- [ ] `npm run test:fast` hijau.

### Task 2: Server — auto context bridge + buang mesin antre

**Files:**
- Modify: `src/handoff.js` (tambah `bridgeNote(chat)` dan `needsBridge(hub, id, to)`; versi sync tanpa `git`)
- Modify: `src/session.js` (`get()` ~314, buang `queueEngineSwitch` 385, `resumePendingEngines` 413, `applyPendingEngine` 425, `cancelPendingEngine` 436, panggilan di ~1331)
- Modify: `src/routes/projects.js` (buang route `POST /api/projects/:id/engine`)
- Test: `test/engine-mix.test.mjs`

**Interfaces:**
- `bridgeNote(chat)` → string Markdown ringkas (≤14.000 char) dari pesan user/assistant + tool terakhir; **tanpa** git dan tanpa model.
- `needsBridge(hub, id, to)` → true bila chat mesin lain punya pesan lebih baru daripada penanda `contextBridge` terakhir di chat `to`.
- `SessionManager.get(project)`: saat `session.engine !== engine`, tutup sesi lama, buat sesi baru; bila `needsBridge` → `session.setHandoffContext(bridgeNote(otherChat))` dan `hub.chat(id, { kind:'info', contextBridge:{from,to,messages}, text:'🔁 Konteks … dibawa ke …' })`. Tidak ada divider.
- Hapus `enginePending`/`engineQueue` dari state & status.

- [ ] Test: ganti engine lewat `updateSettings` lalu `get()` → `handoffReady` true, info `contextBridge` ada sekali; panggilan `get()` kedua tidak menambah info.
- [ ] Test: tanpa pesan di mesin lama → tidak ada info/handoff.
- [ ] Test: `POST /engine` → 404.
- [ ] Implementasi + `node --test`.

### Task 3: Server — model kedua mesin dalam satu endpoint

**Files:**
- Modify: `src/routes/projects.js` (`POST /api/projects/:id/models` ~83)
- Test: `test/engine-mix.test.mjs`

**Interfaces:**
- Respons tetap punya field lama (`engine`, `models`, `current`, `needsStart`) untuk mesin aktif, ditambah:
  `engines: { claude: { models:[{value,name,efforts}], current, needsStart }, opencode: { … } }`.
- Claude diambil dari katalog (`hub.persisted.catalog.models` → `{value,name}`); OpenCode seperti sekarang.
- Cache per project ≤ 30 detik agar tidak memanggil `opencode models` tiap render.

- [ ] Test: respons memuat `engines.claude.models` dan `engines.opencode`; field lama tetap ada.
- [ ] Implementasi + test.

### Task 4: Frontend — satu daftar model, hapus switch

**Files:**
- Modify: `public/js/features/composer.js` (`renderModelOptions` ~492, `saveModel`, chip ~165), `public/js/features/engine.js` (`projectModels`, `projectModelOptions`), `public/js/features/settings.js` (hapus bagian Mesin project ~179-290), `public/index.html` (hapus elemen `#project-engine*`), `public/js/features/picker.js` (hapus `engineTag`), `public/js/features/account.js` + `public/js/features/opencode-account.js` (hapus switch, dua view info), `src/routes/account.js`/`src/routes/projects.js` (route `/api/engine` dihapus jika hanya untuk switch).
- Test: `test/engine-mix-ui.test.mjs` (baru), sesuaikan test yang menyebut "Mesin project".

**Interfaces:**
- `#model` menampilkan `<optgroup label="Claude Code">` dan `<optgroup label="OpenCode">` (provider di dalamnya).
- Memilih model mesin lain → satu `POST /api/projects/:id/settings { engine, model }`; saat `state.statuses[id].busy` model mesin lain `disabled` dengan title "Tunggu giliran ini selesai".
- Chip pengaturan giliran tidak menampilkan badge mesin (`engineBadge` dihapus dari situ).
- Akun: tab "Claude" dan "OpenCode" hanya info; tidak memanggil `/api/engine`; tidak ada tombol "Jadikan mesin bawaan".

- [ ] Test UI: dua optgroup ada; memilih model OpenCode mengirim `{engine:'opencode', model}`.
- [ ] Test UI: tidak ada `#project-engine` dan tidak ada `.engine-opt`.
- [ ] Implementasi + `npm run test:ui -- <file>`.

### Task 5: Frontend — riwayat satu alur

**Files:**
- Modify: `public/js/features/chat.js` (render badge mesin halus per pesan), `public/js/core/stream.js` (merge `chat` event tanpa duplikat), `public/js/features/history.js` bila menampilkan per mesin.
- Test: `test/engine-mix-ui.test.mjs`

**Interfaces:**
- Setiap pesan punya `m.engine` dari server; badge kecil `✳`/`▢` di samping nama pengirim hanya bila `engine` berbeda dari pesan sebelumnya.
- `chat_reset` mengosongkan seluruh timeline project.

- [ ] Test UI: snapshot berisi pesan dua mesin → dua pesan tampil berurutan dengan badge berbeda.
- [ ] Implementasi + test.

### Task 6: Verifikasi & dokumentasi

- [ ] `npm run lint`, `npm run test:fast`, `npm run test:smoke`.
- [ ] Perbarui `docs/FITUR.md`, `docs/PANDUAN.md`, `docs/design-opencode.md` §11, `README.md` (bagian mesin), `CHANGELOG.md` (versi berikutnya).
- [ ] Review diff oleh `architect`/`reviewer`.
