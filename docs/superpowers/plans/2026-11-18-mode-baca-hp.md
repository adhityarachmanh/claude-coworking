# Mode Baca HP (lipat area input) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Di HP, satu ketukan dapat melipat composer (kotak input + strip status + chip tugas) sehingga chat memakai seluruh layar, dan sebuah pil mengambang mengembalikannya.

**Architecture:** Kelas `body.composer-folded` menyembunyikan `.composer` lewat CSS di blok `@media` HP yang sudah ada; sebuah modul fitur baru (`features/phone-fold.js`) memegang state + tombol, dan aturan murni (ikon apa yang harus tetap terlihat saat terlipat) dipisah ke `core/fold-rules.js` supaya bisa dites tanpa browser. Tidak ada perubahan server/API/skema, tidak ada dependensi baru, desktop (> 760 px) tidak tersentuh.

**Tech Stack:** Vanilla ES modules + CSS statis (tanpa bundler), `node:test`, `test-support/cdp.mjs` untuk test browser.

**Spec:** `docs/design-mobile-chat.md` §10 (Mode baca) — desain yang disetujui di percakapan.

## Global Constraints

- Hanya HP: setiap aturan CSS/JS baru aktif di `@media (max-width: 760px), (pointer: coarse) and (max-height: 500px)` atau `narrow.matches` (`public/js/core/dom.js`). Desktop harus **identik**.
- Elemen baru diberi kelas `phone-only` (`.phone-only { display: none }` di luar blok HP, `public/css/app.css:2607`).
- Bahasa teks yang terlihat ke pengguna: **Indonesia**; komentar kode: **Inggris**.
- Tanpa dependensi baru; tanpa perubahan backend/API/skema; CSP tidak berubah.
- Target sentuh tombol lipat & pil: **≥ 44×44 px**.
- Test lama tidak boleh dihapus/dilemahkan. `test/mobile-chat.test.mjs:403` menuntut `#composer` ≤ 5 kontrol terlihat → tombol lipat harus jadi kontrol ke-5, bukan ke-6.
- Kunci penyimpanan: `localStorage['office.composerFolded']` (`'1'`/`'0'`).

## Review Focus

- **Terlipat saat pindah ke mode hanya-lihat (WiFi).** `#btn-fold` ada di dalam `.input` yang disembunyikan di mode itu, jadi cara masuk hilang; pil `#btn-unfold` berada di luar `.input` sehingga jalan keluar tetap ada. Uji: `#btn-unfold` tetap terlihat dan bisa membuka composer di halaman read-only.
- **Fokus & keyboard.** Membuka kembali harus memfokuskan `#prompt` (satu ketukan = langsung bisa mengetik); melipat harus melepas fokus supaya keyboard tidak menggantung di atas pil.
- **Status yang tidak boleh hilang saat terlipat.** Izin menunggu dan sambungan putus harus tetap terlihat di pil — uji `unfold-flags`.
- **Tidak ada overflow horizontal** di 360 px pada kedua keadaan (terbuka & terlipat).

---

### Task 1: Aturan murni + test unit

**Files:**
- Create: `public/js/core/fold-rules.js`
- Test: `test/fold-rules.test.mjs`

**Interfaces:**
- Produces: `FOLD_FLAGS` (`{ pending, busy, offline }` → `{ icon, label }`), `foldFlags({ pending, busy, online }) → { icon, label }[]` (urutan tetap: izin, sambungan, sibuk).

- [ ] **Step 1: Tulis test yang gagal** (`test/fold-rules.test.mjs`)

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldFlags } from '../public/js/core/fold-rules.js';

const icons = (s) => foldFlags(s).map((f) => f.icon);

test('tidak ada apa-apa saat semuanya aman', () => {
  assert.deepEqual(foldFlags(), []);
  assert.deepEqual(foldFlags({ pending: false, busy: false, online: true }), []);
});

test('izin menunggu, sambungan putus dan giliran berjalan punya ikonnya sendiri', () => {
  assert.deepEqual(icons({ pending: true }), ['✋']);
  assert.deepEqual(icons({ online: false }), ['⚡']);
  assert.deepEqual(icons({ busy: true }), ['⏳']);
});

test('urutannya tetap: izin dulu, lalu sambungan, lalu sibuk', () => {
  assert.deepEqual(icons({ pending: true, busy: true, online: false }), ['✋', '⚡', '⏳']);
});

test('setiap ikon membawa label yang bisa dibacakan', () => {
  for (const f of foldFlags({ pending: true, busy: true, online: false })) assert.match(f.label, /\w/);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/fold-rules.test.mjs`
Expected: FAIL — `Cannot find module .../public/js/core/fold-rules.js`

- [ ] **Step 3: Implementasi `foldFlags`**

`public/js/core/fold-rules.js`: dua ekspor seperti di Interfaces. Hanya fungsi murni (tanpa DOM), urutan: `pending`, `!online`, `busy`.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/fold-rules.test.mjs`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add public/js/core/fold-rules.js test/fold-rules.test.mjs
git commit -m "Aturan ikon pil mode baca HP"
```

---

### Task 2: Markup + CSS + test browser yang gagal

**Files:**
- Modify: `public/index.html` (di dalam `.input`, setelah `#btn-send`; dan satu pil setelah `#composer`)
- Modify: `public/css/app.css` (blok `@media (max-width: 760px), (pointer: coarse) and (max-height: 500px)` yang mulai di baris 2641)
- Test: `test/mobile-chat.test.mjs` (test baru di dalam `describe('HP chat <vp>')`, dan `fresh()` mengembalikan keadaan terbuka)

**Interfaces:**
- Produces: `#btn-fold` (tombol `▾`, `aria-expanded`), `#btn-unfold` (pil, `class="phone-only unfold-pill"`, berisi `#unfold-flags`), kelas `body.composer-folded`.

- [ ] **Step 1: Tulis test browser yang gagal** — di dalam `describe('HP chat ' + vp.name)`, satu `test('mode baca: ...')` yang menuntut: `#btn-fold` terlihat; setelah `page.click('#btn-fold')` → `#composer` tidak terlihat, `#btn-unfold` terlihat, `#chat` lebih tinggi, `horizontalOverflow` null, `localStorage['office.composerFolded']==='1'`; `patchStatus({pending:true})` → `#unfold-flags` berisi `✋`; klik `#btn-unfold` → composer terlihat lagi, `document.activeElement.id === 'prompt'`, storage `'0'`. Tambahkan pemulihan di `fresh()`: impor `setFold` dari `/js/features/phone-fold.js` dan panggil `setFold(false)`.
- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/mobile-chat.test.mjs`
Expected: FAIL — `#btn-fold` tidak ada

- [ ] **Step 3: Markup** (`public/index.html`): `<button id="btn-fold" class="ghost icon phone-only" type="button" aria-expanded="true" aria-controls="composer" aria-label="Lipat area input (mode baca)">▾</button>` setelah `#btn-send`, dan `<button id="btn-unfold" class="phone-only unfold-pill" type="button" aria-label="Buka area input"><span aria-hidden="true">⌨</span> Tulis <span id="unfold-flags" class="unfold-flags" hidden></span></button>` setelah `#composer`.
- [ ] **Step 4: CSS** di blok HP: `#btn-fold` (44×44, `order: 4`, bulat), `body.composer-folded .composer { display: none }`, `#btn-unfold` (`position: absolute; right: 10px; bottom: 10px; min-height: 44px`, `display: none` secara bawaan) dan `body.composer-folded #btn-unfold { display: inline-flex }`. Desktop tetap aman karena semuanya di dalam blok HP.
- [ ] **Step 5: Commit** (`git add public/index.html public/css/app.css test/mobile-chat.test.mjs`).

---

### Task 3: Modul fitur + wiring

**Files:**
- Create: `public/js/features/phone-fold.js`
- Modify: `public/js/features/composer.js` (panggil `renderFoldFlags(st)` di `renderComposer`, dekat `renderVoice()`)
- Modify: `public/js/app.js` (panggil `initPhoneFold()` setelah `initPhoneSheets()`)

**Interfaces:**
- Consumes: `foldFlags` (Task 1), `#btn-fold`, `#btn-unfold`, `#unfold-flags`, `#prompt` (Task 2).
- Produces: `fold` (`{ on }`), `setFold(on, focus = false)`, `renderFoldFlags(st)`, `initPhoneFold()`.

- [ ] **Step 1: `initPhoneFold()`** — baca `localStorage['office.composerFolded']`, `apply()` (`body.classList.toggle('composer-folded', fold.on && narrow.matches)` + `aria-expanded` pada `#btn-fold`), `#btn-fold` → `setFold(true)`, `#btn-unfold` → `setFold(false, true)`, `renderFoldFlags()`.
- [ ] **Step 2: `setFold(on, focus)`** — set `fold.on`, simpan ke `localStorage` (dibungkus `try`), `apply()`, `#prompt.blur()` saat melipat, `#prompt.focus({ preventScroll: true })` saat membuka bila `focus`.
- [ ] **Step 3: `renderFoldFlags(st = state.statuses[state.active] ?? {})`** — `foldFlags({ pending, busy: st.busy || st.cliBusy || st.compacting, online: connection.online })`; tulis ikon + `title` ke `#unfold-flags` (`escapeHtml`, sembunyikan bila kosong) dan perbarui `aria-label` pil.
- [ ] **Step 4: Wiring** — `composer.js` memanggil `renderFoldFlags(st)`; `app.js` memanggil `initPhoneFold()`.
- [ ] **Step 5: Jalankan test browser, pastikan lulus** (`node --test test/mobile-chat.test.mjs`).
- [ ] **Step 6: Commit.**

---

### Task 4: Dokumentasi + gerbang akhir

**Files:**
- Modify: `CHANGELOG.md` (bagian `## Belum dirilis` baru di atas `## 1.0.49`)
- Modify: `docs/FITUR.md` (bagian `Chat & izin`)
- Modify: `docs/design-mobile-chat.md` (tambah §10 "Mode baca" + baris status)

- [ ] **Step 1:** Catatan rilis singkat (bahasa pengguna) + perilaku di FITUR.md + ringkasan desain §10.
- [ ] **Step 2:** `npm run test:related -- public/js/features/phone-fold.js public/js/core/fold-rules.js public/js/features/composer.js public/js/app.js public/index.html public/css/app.css`
- [ ] **Step 3:** `npm run test:ui:area` tidak memuat blok mobile (file sendiri): jalankan `npm run test:smoke` bila menyentuh server (tidak), dan `npm run check`.
- [ ] **Step 4: Commit + push.**

---

## Catatan eksekusi

Metode eksekusi: **native** (dikerjakan langsung di sesi ini) — pengguna sudah meminta "kerjakan sekarang". Review independen atas diff dilakukan setelah Task 3 oleh subagent `reviewer`, verifikasi ulang oleh `qa`.
