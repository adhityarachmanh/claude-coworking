# Pantau CI opsional (saklar per project) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Satu saklar per project — **Pantau CI setelah push** — yang mematikan polling, chip, dan baris chat pemeriksa CI GitHub untuk repo yang CI-nya belum siap.

**Architecture:** Setelan boolean `ciFollow` di `settings[id]` (`state.json`, **absen = nyala**). `CiWatcher.watch` menolaknya saat mati; `unwatch` menghentikan yang sedang jalan. Route setelan yang sudah ada memanggil `hub.ciUnwatch`/`hub.ciWatch` dan membersihkan chip. Checkbox di `.controls` (Pengaturan giliran).

**Tech Stack:** Node ES module, vanilla JS + CSS statis (tanpa bundler), `node:test`. Tanpa dependensi baru, tanpa skema baru.

**Spec:** `docs/superpowers/specs/2026-11-22-pantau-ci-opsional-design.md`

## Global Constraints

- Teks UI: **Bahasa Indonesia**; komentar kode: **Inggris**.
- Nilai setelan `ciFollow`: hanya `false` berarti "mati"; **absen/`true` = nyala** (tidak ada migrasi `state.json`).
- Hanya baca GitHub; tidak menjalankan ulang apa pun.
- WiFi biasa tetap read-only (rute `POST /api/projects/:id/settings` tidak ada di allowlist — tidak diubah).
- Test lama tidak dihapus/dilemahkan.

## Review Focus

- **`unwatch` saat poll sedang berjalan.** `poll()` menunggu `check()`; kalau project dimatikan di tengah tunggu, poll yang kembali tidak boleh menulis status/chat lagi. Uji: `unwatch` di tengah siklus → tidak ada baris chat setelahnya.
- **Junk di `state.json`.** `ciFollow: "no"` (hand-edit) harus diabaikan, bukan mematikan diam-diam. Uji di Task 1.
- **Menyalakan lagi setelah push.** Mematikan lalu menyalakan harus memulai pemantauan commit saat ini lagi. Uji di Task 3.
- **Chip klien.** `renderCi` menyembunyikan chip saat `ci` kosong **atau** `ciFollow === false` (pertahanan lapis kedua).

---

### Task 1: `ciFollow` di Hub

**Files:**
- Modify: `src/hub.js` (`DEFAULT_SETTINGS` baris 65; `cleanSettings` dekat `denyUnanswered` baris 1351; metode baru dekat `setQueueRetryOnce` baris 1228)
- Test: `test/ci-follow.test.mjs` (baru)

**Interfaces:**
- Consumes: — (mandiri).
- Produces: `DEFAULT_SETTINGS.ciFollow === true`; `hub.ciFollowFor(id) -> boolean`; `hub.cleanSettings(base, { ciFollow })` menyimpan hanya boolean.

- [ ] **Step 1: Tulis test yang gagal** (`test/ci-follow.test.mjs`)

```js
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';

test('pantau CI: nyala secara bawaan, hanya false yang mematikan', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-ci-')) });
  hub.projects.set('p1', { id: 'p1', path: 'C:/p', name: 'p1' });
  assert.equal(hub.ciFollowFor('p1'), true, 'absen = nyala');
  hub.updateSettings('p1', { ciFollow: false });
  assert.equal(hub.ciFollowFor('p1'), false);
  assert.equal(hub.cleanSettings(hub.settingsFor('p1'), { ciFollow: 'no' }).ciFollow, undefined, 'junk tidak mematikan');
  hub.updateSettings('p1', { ciFollow: true });
  assert.equal(hub.ciFollowFor('p1'), true);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/ci-follow.test.mjs`
Expected: FAIL — `hub.ciFollowFor is not a function`

- [ ] **Step 3: Implementasi** — `DEFAULT_SETTINGS` tambah `ciFollow: true`; `cleanSettings` tambah `if (typeof patch.ciFollow === 'boolean') next.ciFollow = patch.ciFollow;`; tambah `ciFollowFor(id) { return this.settingsFor(id).ciFollow !== false; }`.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/ci-follow.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (`git add src/hub.js test/ci-follow.test.mjs`; pesan: `Saklar pantau CI per project: setelan ciFollow`).

---

### Task 2: Watcher menghormati saklar

**Files:**
- Modify: `src/github-ci.js` (`watch` baris 63–73; metode baru `unwatch`)
- Test: `test/github-ci.test.mjs` (tambah 2 test)

**Interfaces:**
- Consumes: `hub.ciFollowFor(id)` (Task 1), `hub.setStatus`.
- Produces: `CiWatcher.watch(id) -> false` saat `ciFollowFor` palsu (tanpa efek samping); `CiWatcher.unwatch(id)`.

- [ ] **Step 1: Tulis test yang gagal** (tambah ke `test/github-ci.test.mjs`)

```js
test('pantau CI mati: tidak ada polling, status, maupun baris chat', async () => {
  const h = hub();
  h.ciFollowFor = () => false;
  const w = new CiWatcher({ hub: h, gh: 'gh', check: async () => ({ state: 'failure', runs: [{ name: 'ci', conclusion: 'failure' }], url: 'https://github.com/o/r/actions/runs/1' }), pollMs: 5, firstMs: 5 });
  assert.equal(w.watch('p1'), false);
  await wait(40);
  assert.equal(h.statuses.length, 0, 'tidak menulis status');
  assert.equal(h.chats.length, 0, 'tidak menulis chat');
});

test('unwatch: menghentikan pemantauan yang berjalan, tanpa baris chat', async () => {
  const h = hub();
  const w = new CiWatcher({ hub: h, gh: 'gh', check: async () => ({ state: 'running', runs: [{ name: 'ci', status: 'in_progress', conclusion: '' }] }), pollMs: 5, firstMs: 5 });
  w.watch('p1');
  await wait(20);
  w.unwatch('p1');
  assert.equal(w.watching.size, 0);
  const seen = h.chats.length;
  await wait(40);
  assert.equal(h.chats.length, seen, 'tidak ada baris chat setelah dihentikan');
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/github-ci.test.mjs`
Expected: FAIL — `unwatch` belum ada / `watch` tetap true saat dimatikan

- [ ] **Step 3: Implementasi** — di `watch()`, setelah cek `gh`/`project`, tambah `if (this.hub.ciFollowFor?.(projectId) === false) return false;`. Tambah `unwatch(projectId) { const w = this.watching.get(projectId); if (w) clearTimeout(w.timer); this.watching.delete(projectId); }`. Pola `poll` sudah memakai identitas `w` (baris 76, 80) sehingga poll yang kembali setelah `unwatch` berhenti sendiri — jangan diubah.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/github-ci.test.mjs`
Expected: PASS (test lama tetap hijau)

- [ ] **Step 5: Commit** (pesan: `Watcher CI hormati saklar + unwatch`).

---

### Task 3: Route setelan + chip klien

**Files:**
- Modify: `server.js` (dekat baris 1588: `hub.ciUnwatch`)
- Modify: `src/routes/projects.js` (setelah `hub.updateSettings` baris 133)
- Modify: `public/index.html` (di `.controls`, setelah `#deny-ctl` baris 216)
- Modify: `public/js/features/composer.js` (`renderComposer` baris 103; `saveSettings` baris 776; `ACTION_CONTROLS` baris 136; listener baris 952)
- Modify: `public/js/features/ci-status.js` (`renderCi` baris 18–23)
- Test: `test/ci-follow-route.test.mjs` (baru)

**Interfaces:**
- Consumes: `hub.ciFollowFor`/`cleanSettings` (Task 1), `CiWatcher.watch/unwatch` (Task 2).
- Produces: `hub.ciWatch(id)`, `hub.ciUnwatch(id)`; `POST /api/projects/:id/settings { ciFollow }`; `#ci-follow`; `st.ciFollow` di status.

- [ ] **Step 1: Tulis test integrasi yang gagal** (`test/ci-follow-route.test.mjs`) — pola `spawn(server.js)` dari `test/engine-per-project.test.mjs`, dengan `OFFICE_GH_BIN` = `test-support` fake gh yang mencetak `[]`, dan `PROJECTS_ROOT`. Tuntut: `POST /settings { ciFollow: false }` → 200 dan `GET /api/state` (snapshot) untuk project itu `status.ci === null`; `POST { ciFollow: true }` → `status.ci.state === 'pending'`. (Kalau fake gh belum ada, Step 3 menyertakannya.)

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/ci-follow-route.test.mjs`
Expected: FAIL — `ci` tidak pernah `null`/`pending`

- [ ] **Step 3: Implementasi**
  - `server.js`: `hub.ciUnwatch = (projectId) => ciWatcher.unwatch(projectId);` tepat di bawah `hub.ciWatch`.
  - `src/routes/projects.js` (setelah `hub.updateSettings(project.id, patch)`): bila `patch.ciFollow === false` → `hub.ciUnwatch?.(project.id); hub.setStatus(project.id, { ci: null });`; bila `patch.ciFollow === true` → `hub.ciWatch?.(project.id)`. Lalu `hub.setStatus(project.id, hub.settingsFor(project.id));` supaya `ciFollow` terkirim ke halaman (letakkan setelah blok di atas, sebelum `session.syncSettings()`).
  - `public/index.html`: `<label id="ci-ctl" class="switch" title="Setelah push, pantau hasil GitHub Actions-nya dan beri kabar di chat. Matikan untuk repo yang CI-nya belum siap."><input id="ci-follow" type="checkbox" checked /> Pantau CI setelah push</label>`.
  - `composer.js`: `$('#ci-follow').checked = st.ciFollow !== false;` di `renderComposer`; `ciFollow: $('#ci-follow').checked` di `saveSettings`; tambah `'#ci-follow'` ke `ACTION_CONTROLS`; tambah `'#ci-follow'` ke daftar `for (const id of [...])`.
  - `ci-status.js`: di `renderCi`, `if (!ci || state.statuses[state.active]?.ciFollow === false) { el.hidden = true; return; }`.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/ci-follow-route.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (pesan: `Route setelan ciFollow + chip & checkbox pantau CI`).

---

### Task 4: Dokumentasi + gerbang akhir (commit terakhir)

**Files:**
- Modify: `CHANGELOG.md` (bagian `## Belum dirilis` di atas rilis teratas — buat bila belum ada)
- Modify: `docs/FITUR.md` (baris 84, entri **✅ CI GitHub**)

- [ ] **Step 1:** Catatan rilis bahasa pengguna (saklar per project, efeknya, bawaan nyala) + satu kalimat di FITUR.md.
- [ ] **Step 2:** `npm run test:related -- src/hub.js src/github-ci.js src/routes/projects.js public/js/features/ci-status.js public/js/features/composer.js`
- [ ] **Step 3:** `npm run test:smoke` (menyentuh server + route setelan) lalu `npm run check`.
- [ ] **Step 4: Commit + push.**

---

## Catatan eksekusi

Metode: **native** (dikerjakan di sesi ini; user meminta langsung jalan). Review independen atas diff oleh subagent `reviewer` setelah Task 3; verifikasi ulang `qa`.