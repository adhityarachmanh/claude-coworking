# Fase 1a — Permukaan cepat Claude (hook + catatan rilis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menutup dua celah permukaan Claude Code yang masih menyuruh user ke terminal: event hook `PreSkillShellCommand` (2.1.332) dan `/release-notes`.

**Architecture:** Hook event ditambahkan ke satu sumber daftar (`src/claude-admin.js`) dan fallback editor. Catatan rilis dibaca dari `CHANGELOG.md` yang sudah ikut dipaketkan (`scripts/build-windows.mjs`), diurai oleh fungsi murni, disajikan route read-only, dan ditampilkan di modal.

**Tech Stack:** Node ESM, `node:test`, UI statis (tanpa framework), `renderMarkdown` yang sudah ada.

**Spec:** `docs/superpowers/specs/2026-11-28-adopsi-penuh-tahap-2-design.md` (Fase 1: hooks + `/release-notes`).

## Global Constraints

- Teks UI Bahasa Indonesia; komentar kode Inggris.
- Test dulu (gagal), lalu implementasi; `npm run test:related -- <file>` hijau.
- Tidak menambah dependensi npm.
- Route read-only baru tidak boleh membocorkan path/data pribadi; cukup versi + isi CHANGELOG.
- `/release-notes` tidak lagi masuk `CLI_ONLY` (pesan "Khusus terminal").

## Review Focus

- `CHANGELOG.md` tidak ada di instalasi (mis. build lama): route harus 404 yang jelas, UI menampilkan pesan, bukan crash.
- Heading `## Belum dirilis` di dev: tetap tampil sebagai bagian pertama, bukan dianggap versi.
- Isi CHANGELOG berisi karakter non-ASCII/emoji: parser tidak boleh memotong atau mengubahnya.
- Hook event baru harus bisa disimpan lewat `saveHook` (bukan hanya tampil di datalist).
- Command `/release-notes` di project OpenCode: tetap jalan (catatan rilis aplikasi, bukan mesin).

---

### Task 1: Event hook `PreSkillShellCommand`

**Files:**
- Modify: `src/claude-admin.js` (HOOK_EVENTS)
- Modify: `public/js/features/extensions.js` (FALLBACK_HOOK_EVENTS)
- Test: `test/claude-hooks.test.mjs`

**Interfaces:**
- Produces: `HOOK_EVENTS` (frozen array) memuat `'PreSkillShellCommand'`; editor memakai daftar server, fallback memuat event yang sama.

- [ ] **Step 1: Write the failing test**

Tambahkan di `test/claude-hooks.test.mjs`:

```js
import { HOOK_EVENTS } from '../src/claude-admin.js';

test('HOOK_EVENTS memuat PreSkillShellCommand (Claude Code 2.1.332)', () => {
  assert.ok(HOOK_EVENTS.includes('PreSkillShellCommand'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/claude-hooks.test.mjs`
Expected: FAIL (`false !== true`).

- [ ] **Step 3: Implement**

Di `HOOK_EVENTS`, sisipkan `'PreSkillShellCommand'` setelah `'UserPromptExpansion'`.
Di `FALLBACK_HOOK_EVENTS` (`public/js/features/extensions.js`), sisipkan nama yang sama setelah `'UserPromptSubmit'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/claude-hooks.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/claude-admin.js public/js/features/extensions.js test/claude-hooks.test.mjs
git commit -m "Tambah event hook PreSkillShellCommand"
```

---

### Task 2: `/release-notes` native

**Files:**
- Create: `src/release-notes.js`
- Create: `src/routes/release-notes.js`
- Modify: `src/routes/index.js`
- Create: `public/js/features/release-notes.js`
- Modify: `public/index.html` (modal)
- Modify: `public/js/features/commands.js`
- Test: `test/release-notes.test.mjs`

**Interfaces:**
- Produces: `parseReleaseNotes(markdown: string, { limit?: number } = {}) -> Array<{ version: string, body: string }>`
  - `version` = teks heading tanpa `## `; `body` = isi sampai heading `## ` berikutnya, di-trim.
  - Urutan dipertahankan (terbaru dulu); `limit` default 8.
- Produces: `GET /api/release-notes -> 200 { version: string|null, sections: Array<{version,body}> }` atau `404 { error }`.
- Produces: `openReleaseNotes(): Promise<void>` di UI.

- [ ] **Step 1: Write the failing test**

`test/release-notes.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReleaseNotes } from '../src/release-notes.js';

const md = `# Changelog

## Belum dirilis

- Fitur baru.

## 1.12.0

- Rilis terbaru.

## 1.11.0

- Lama.
`;

test('parseReleaseNotes: urutan, heading, body, dan batas', () => {
  const all = parseReleaseNotes(md);
  assert.deepEqual(all.map((s) => s.version), ['Belum dirilis', '1.12.0', '1.11.0']);
  assert.equal(all[1].body, '- Rilis terbaru.');
  assert.equal(parseReleaseNotes(md, { limit: 1 }).length, 1);
});

test('parseReleaseNotes: teks tanpa heading dan input aneh aman', () => {
  assert.deepEqual(parseReleaseNotes(''), []);
  assert.deepEqual(parseReleaseNotes(null), []);
  assert.deepEqual(parseReleaseNotes('# Changelog\n\ntanpa bagian'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/release-notes.test.mjs`
Expected: FAIL (module not found / function not defined).

- [ ] **Step 3: Implement the parser**

`src/release-notes.js`: fungsi murni; pisahkan dengan regex `^##[ \t]+(.+)$` multiline, ambil pasangan heading+body, `trim()`, buang body kosong opsional (tetap tampilkan heading dengan body kosong), batasi `limit` (default 8, minimal 1, maks 50). Tidak boleh melempar untuk input non-string.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/release-notes.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement the route**

`src/routes/release-notes.js`:
- `register(router)` mendaftarkan `router.get('/api/release-notes', handler)`.
- Baca kandidat `CHANGELOG.md` berurutan: `process.env.OFFICE_APP_DIR`, `process.cwd()`, `path.dirname(process.execPath)`; pakai yang pertama ada.
- Versi dari `package.json` di folder yang sama (fallback `null`).
- Gagal baca → `json(res, 404, { error: 'Catatan rilis tidak ditemukan di instalasi ini.' })`.
- Daftarkan di `src/routes/index.js` (import + `releaseNotes.register`).

- [ ] **Step 6: Implement the UI**

- `public/js/features/release-notes.js`: `openReleaseNotes()` membuka `#release-notes-modal`, menampilkan spinner, `api('/api/release-notes')`, render tiap bagian `<section><h3>…</h3><div class="md">${renderMarkdown(body)}</div></section>`; error → `.state-error` dengan pesan.
- `public/index.html`: modal `#release-notes-modal` (pola `#help-modal`, `data-close`), body `#release-notes-body`.
- `public/js/features/commands.js`: hapus baris `release-notes` dari `CLI_ONLY`; tambah `{ name: 'release-notes', description: '📜 Catatan rilis Adhitron (versi terpasang)' }` ke `LOCAL_COMMANDS`; import `openReleaseNotes`; tambah `case 'release-notes': openReleaseNotes(); return true;`.
- Tidak perlu init baru (tombol tutup modal sudah global).

- [ ] **Step 7: Verify**

Run: `node --check src/release-notes.js && node --check src/routes/release-notes.js && node --check public/js/features/release-notes.js`
Run: `npm run test:related -- src/release-notes.js public/js/features/commands.js src/routes/release-notes.js`
Expected: test parser lulus; tidak ada test yang rusak.

- [ ] **Step 8: Commit**

```bash
git add src/release-notes.js src/routes/release-notes.js src/routes/index.js public/index.html public/js/features/release-notes.js public/js/features/commands.js test/release-notes.test.mjs
git commit -m "Catatan rilis native untuk /release-notes"
```

---

### Task 3: Dokumentasi

- [ ] Tambah `## Belum dirilis` di `CHANGELOG.md` (di atas `## 1.12.0`) dengan dua butir: event hook `PreSkillShellCommand`, `/release-notes` native.
- [ ] Perbarui `docs/FITUR.md` (command `/release-notes` dan hooks) dan `docs/adopsi-mesin.md` (baris `/release-notes` dari 🚫 menjadi ✅).
- [ ] Commit dokumentasi bersama Task 2 atau commit terpisah.
