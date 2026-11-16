# Aktivitas Tim yang Jelas — Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panel Aktivitas dan monitor ⧗ menampilkan satu baris per agent (bukan satu baris per tool call), dengan durasi hidup, status berjalan/menunggu/lama, dan langkah yang bisa dibuka — tanpa proses yang terlihat macet.

**Architecture:** Satu modul murni baru (`public/js/core/agent-runs.js`) mengelompokkan event menjadi *run* dan menghitung statusnya. `activity.js` merender run itu (header + langkah yang bisa dilipat) dan memperbarui jam/status tiap detik lewat `textContent` saja. Perubahan kecil menyusul di monitor ⧗ dan baris status composer. Tidak ada perubahan server atau API.

**Tech Stack:** Vanilla ES modules, DOM, CSS; test `node:test` + CDP (`test-support/cdp.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-16-aktivitas-tim-jelas-design.md`

## Global Constraints

- Komentar kode **bahasa Inggris**; teks UI **bahasa Indonesia**.
- Tanpa dependency baru; tanpa perubahan `src/**` atau kontrak API.
- Perilaku **■ Stop**, urutan event, isi chat, dan batas 200 baris lama tidak berubah.
- Tidak ada persentase/estimasi progres (jumlah langkah total tidak diketahui).
- Semua animasi menghormati `prefers-reduced-motion`.
- Jangan melemahkan test lama; kalau perilaku berubah sengaja, ubah test di commit yang sama dan jelaskan.
- Commit hanya file milik task ini (di working tree mungkin ada pekerjaan fitur lain yang belum di-commit).

## Review Focus

- Event dari **dua agent yang berselang-seling** harus jadi dua baris, bukan satu baris yang berganti-ganti peran.
- Event dengan `ts` **tidak berurutan** (clock mundur/sama) tidak boleh membuat durasi negatif atau run pecah aneh.
- Run yang **sudah selesai** tidak boleh menampilkan spinner; run yang **masih berjalan** tidak boleh terlipat sampai pengguna menutupnya sendiri.
- Daftar yang **sangat panjang** (ratusan langkah) tetap responsif: ticker tidak boleh menggambar ulang seluruh daftar tiap detik.
- `role` yang tidak dikenal `cast.js` tetap tampil dengan nama yang masuk akal, bukan `undefined`.
- Detail tugas agent yang berjalan tidak boleh terus-terusan "menunggu" saat ada langkah baru (hitung dari `updatedAt`, bukan dari waktu buka panel).

---

### Task 1: Modul murni pengelompokan run

**Files:**
- Create: `public/js/core/agent-runs.js`
- Test: `test/agent-runs.test.mjs`

**Interfaces:**
- Produces:
  - `RUN_GAP_MS = 90_000`, `STALL_MS = 45_000`, `SLOW_MS = 120_000`, `RECENT_DONE_MS = 5_000`
  - `fmtRun(ms: number): string` — `"0:07"`, `"1:12"` (menit:detik).
  - `groupRuns(events: OfficeEvent[], { now?: number, busy?: boolean }): AgentRun[]` — **run terbaru lebih dulu**.
  - Tipe `AgentRun = { key, role, events, steps, startedAt, lastAt, status, elapsedMs, stateText }`
    dengan `status: 'running'|'waiting'|'slow'|'done'`.
  - `donePreview(tasks: Task[], { showAll?: false, max?: 3 }): { rows: Task[], hiddenCount: number }`.
  - (Task 2 menambah `runMarkup` di modul yang sama; lihat task itu.)

**Aturan `groupRuns`:**
- Event disimpan server dalam urutan lama→baru. Run baru dimulai bila `role` berbeda atau `evt.ts - prev.ts > RUN_GAP_MS`.
- `key = `${role}:${events[0].id}``.
- `status` sebuah run = `'done'` bila salah satu benar: `busy === false`; ada run lain yang lebih baru dengan role sama; run memuat event `kind === 'agent_stop'`. Selain itu menurut umur `now - lastAt`: `< STALL_MS` → `running`, `< SLOW_MS` → `waiting`, selain itu `slow`.
- `elapsedMs` = `(status === 'done' ? lastAt : now) - startedAt`, minimal 0.
- `stateText` (Indonesia): `berjalan ${fmtRun}` / `menunggu ${N} dtk` / `lama, masih jalan · ${N} mnt` / `selesai · ${fmtRun}`.

- [ ] **Step 1: Tulis test yang gagal** — `test/agent-runs.test.mjs`, gaya `node:test` seperti `test/composer-typing.test.mjs`:

```js
import { groupRuns, donePreview, fmtRun, RUN_GAP_MS, STALL_MS, SLOW_MS } from '../public/js/core/agent-runs.js';

const ev = (id, ts, role, kind = 'tool_start') => ({ id, ts, project: 'p', role, kind, label: `langkah ${id}` });
const T = 1_000_000;

test('dua langkah role sama dalam jeda → satu run, terbaru lebih dulu', () => {
  const runs = groupRuns([ev(1, T, 'backend'), ev(2, T + 10_000, 'backend')], { now: T + 20_000, busy: true });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].steps, 2);
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].stateText, 'berjalan 0:20');
});

test('role berganti → run terpisah dan run yang lebih lama berstatus done', () => { /* backend, frontend, backend */ });

test('jeda lebih dari RUN_GAP_MS memecah run', () => { /* RUN_GAP_MS + 1 */ });

test('ambang 45/120 detik: running → waiting → slow', () => { /* STALL_MS, SLOW_MS */ });

test('busy=false membuat semua run done, tanpa spinner', () => { /* status 'done', stateText selesai */ });

test('agent_stop menutup run walau busy=true', () => { /* kind agent_stop */ });

test('durasi tidak pernah negatif saat jam klien mundur', () => { /* now < startedAt → elapsedMs 0 */ });

test('donePreview: maksimal 3 baris selesai, sisanya dihitung', () => {
  const done = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, status: 'completed' }));
  assert.deepEqual(donePreview(done, {}).rows.map((t) => t.id), ['t0', 't1', 't2']);
  assert.equal(donePreview(done, {}).hiddenCount, 4);
  assert.equal(donePreview(done, { showAll: true }).rows.length, 7);
  assert.deepEqual(donePreview(done, { showAll: true }).hiddenCount, 0);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal** — `node --test test/agent-runs.test.mjs` → `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implementasi** `public/js/core/agent-runs.js` sesuai Interfaces/Aturan di atas. Satu loop dari event lama→baru untuk membentuk run, lalu satu loop dari belakang untuk status `done` (index run terakhir per role). Tidak ada I/O, DOM, atau import dari `features/**`.

- [ ] **Step 4: Jalankan, pastikan lulus** — `node --test test/agent-runs.test.mjs` → 8/8 lulus.

- [ ] **Step 5: Commit**

```bash
git add public/js/core/agent-runs.js test/agent-runs.test.mjs
git commit -m "Tambah pengelompokan aktivitas per agent"
```

---

### Task 2: Panel Aktivitas memakai run + jam hidup

**Files:**
- Modify: `public/js/features/activity.js` (ganti isi)
- Modify: `public/css/app.css` (tambah blok `.activity .run…` di dekat gaya `.activity` yang ada)
- Modify: `public/js/core/stream.js:160` (tetap memanggil `appendActivity(evt, true)`; tidak perlu diubah bila API dipertahankan)
- Test: `test/agent-runs.test.mjs` (tambah kasus `runsFor` bila perlu)

**Interfaces:**
- Consumes: `groupRuns`, `fmtRun`, `RECENT_DONE_MS` dari Task 1; `roleName`, `roleColor` dari `../office/cast.js`; `escapeHtml`, `$` dari `../core/dom.js`; `time` dari `../core/format.js`.
- Produces:
  - `appendActivity(evt, prepend)` dan `renderActivity()` tetap diekspor dengan nama sama (dipakai `stream.js`, `picker.js`, `team.js`).
  - `runMarkup(runs: AgentRun[], { now?: number, expanded?: Map<string, boolean>, roleName: (role) => string, roleColor: (role) => string, time: (ts) => string, escapeHtml: (s) => string }): string` di `public/js/core/agent-runs.js` — string HTML daftar `<li class="run">…`, dipakai `activity.js` **dan** diuji tanpa browser. Role yang tidak dikenal harus memakai `roleName(role)` apa adanya (tidak pernah `undefined`).


**Perilaku render:**
- Satu `<li class="run" data-run="${key}" data-role="${role}" data-status="${status}">` per run; run terbaru di atas.
- Header: `<button class="run-head" type="button" data-run-toggle aria-expanded="true|false" aria-controls="run-${key}">` berisi titik warna role, `<b>roleName</b>`, `${steps} langkah · <span data-clock>${fmtRun(elapsedMs)}</span>`, `<span data-state>${stateText}</span>`, chevron.
- Isi: `<ol id="run-${key}" class="run-steps">` dengan markup langkah **sama seperti sekarang** (`time`, dot, role, ikon, teks).
- Default terbuka: run terbaru keseluruhan yang `status !== 'done'`, atau run yang `now - lastAt < RECENT_DONE_MS`. Selain itu terlipat. Klik header membalik pilihan pengguna (simpan di `Map<key, boolean>`).
- Acara `appendActivity` hanya memperbarui `state.events` (sudah dilakukan `stream.js`) lalu menjadwalkan render (debounce 50 ms). Jangan menambah DOM satu per satu.
- Batas: render maksimal 40 run; event per run dibatasi markup yang ada (200 baris total).
- Ticker `setInterval(..., 1000)` yang dibuat **sekali** di modul: memperbarui `[data-clock]` dan `[data-state]` (dan `data-status`) lewat `textContent`/`dataset`; memanggil `renderActivity()` **hanya** ketika sebuah run melewati `RECENT_DONE_MS` (satu kali per run, dijaga `Set`).
- `renderActivity()` menyimpan `window.scrollY`/`#activity.scrollTop` dan mengembalikannya setelah render.

- [ ] **Step 1: Tulis test `runMarkup` di `test/agent-runs.test.mjs`** (tanpa browser): satu run 2 langkah menghasilkan tepat satu `<li class="run"`, `aria-expanded="true"` untuk run terbaru yang berjalan, teks `${steps} langkah`, dan `role` tak dikenal (`'kurir'`) muncul sebagai `kurir` (bukan `undefined`). Untuk run `done`, `aria-expanded="false"` dan `<ol … hidden>`.

- [ ] **Step 2: Jalankan, pastikan gagal** — `node --test test/agent-runs.test.mjs`.

- [ ] **Step 3: Implementasi** `runMarkup` di `agent-runs.js` dan tulis ulang `activity.js` memakainya. **Jangan** mengubah `KIND_ICON` (kecuali memindahkannya ke modul bila perlu) dan jangan mengubah teks tiap langkah.

- [ ] **Step 4: Tambah CSS** — `.run`, `.run-head` (tombol lebar penuh), `.run-meta`, `.run-state`, `.run-steps`, chevron berputar saat `[aria-expanded="true"]`, transisi 120 ms, dan blok `@media (prefers-reduced-motion: reduce) { .run-steps { transition: none } }`.

- [ ] **Step 5: Verifikasi manual cepat** — `npm run test:related -- public/js/features/activity.js public/js/core/agent-runs.js` (harus lulus; UI tidak dijalankan di sini).

- [ ] **Step 6: Commit**

```bash
git add public/js/features/activity.js public/js/core/agent-runs.js public/css/app.css test/agent-runs.test.mjs
git commit -m "Aktivitas: satu baris per agent dengan durasi dan status"
```

---

### Task 3: Monitor ⧗ meringkas tugas selesai

**Files:**
- Modify: `public/js/features/tasks.js` (fungsi `renderList`, kunci signature, dan handler klik daftar yang sudah ada)
- Test: `test/agent-runs.test.mjs` (sudah mencakup `donePreview` di Task 1)

**Interfaces:**
- Consumes: `donePreview(tasks, { showAll, max: 3 })` dari Task 1.
- Produces: `tasksView.showAllDone: boolean` (default `false`).

**Perilaku:**
- `renderList`: setelah memisahkan `running` dan `done`, tampilkan `donePreview(done, { showAll: tasksView.showAllDone }).rows`. Bila `hiddenCount > 0`, tambahkan satu baris tombol:
  `<li class="tasks-more"><button type="button" data-tasks-more>Tampilkan ${hiddenCount} selesai</button></li>`;
  bila `showAllDone` benar dan `done.length > 3`, teksnya `Sembunyikan ${done.length - 3} selesai`.
- Kunci signature `renderList` **wajib** menyertakan `tasksView.showAllDone`.
- Klik `[data-tasks-more]`: balik `showAllDone`, panggil `renderList(tasksOf(tasksView.project))` (atau `renderTasks()`), jaga fokus pada tombol itu.
- Tugas yang **berjalan** tidak pernah disembunyikan.
- `renderHead`: untuk `task.kind === 'agent'` yang masih berjalan dan punya `tasksView.details.get(task.id)?.updatedAt`, hitung `quietSec = Math.round((Date.now() - updatedAt) / 1000)`; bila `quietSec >= 45`, tambahkan ke `#td-meta`:
  `<span class="sep">·</span><span class="td-wait">menunggu ${quietSec} dtk</span>`.
  Signature `tasksView.keys.head` menyertakan `Math.floor(quietSec / 15)` supaya tidak menulis ulang tiap detik.

- [ ] **Step 1: Tambah assertion perilaku** di `test/agent-runs.test.mjs` bila belum: `donePreview` dengan 3 atau kurang → `hiddenCount 0` dan semua baris tampil.
- [ ] **Step 2: Jalankan** `node --test test/agent-runs.test.mjs` → hijau.
- [ ] **Step 3: Implementasi** perubahan `tasks.js` (tanpa menyentuh detail/step render atau polling).
- [ ] **Step 4: Verifikasi** `npm run test:related -- public/js/features/tasks.js` → smoke 11 lulus, 0 gagal.
- [ ] **Step 5: Commit**

```bash
git add public/js/features/tasks.js test/agent-runs.test.mjs
git commit -m "Monitor tugas: ringkas daftar tugas selesai"
```

---

### Task 4: Baris status composer menyebut durasi saat lama

**Files:**
- Modify: `public/js/core/composer-typing.js`
- Modify: `public/js/features/composer.js` (hitung `busyMs`, panggil ticker teks)
- Test: `test/composer-typing.test.mjs`

**Interfaces:**
- `typingText({ classifying, planPreparing, compacting, busy, cliBusy, engine, busyMs = 0 }, engineLabel)`:
  - untuk cabang `busy` dan `cliBusy`, bila `busyMs >= SLOW_MS` (impor dari `agent-runs.js`) tambahkan ` · ${Math.floor(busyMs / 60_000)} mnt` di akhir teks.
  - cabang lain tidak berubah.
- `composer.js`: variabel modul `busySince = 0`; di `renderComposer()`, bila `st.busy || st.cliBusy` dan `busySince === 0` set `busySince = Date.now()`; bila tidak sibuk reset ke 0. Ekstrak penulisan `#typing-text` ke `renderTypingText(st)` yang dipanggil dari `renderComposer()` dan dari `setInterval(..., 1000)` (hanya menulis bila teks berubah).

- [ ] **Step 1: Tulis test gagal** di `test/composer-typing.test.mjs`: `busyMs: 130_000` pada `cliBusy` + `opencode` → `'OpenCode (terminal) sedang bekerja… · 2 mnt'`; `busyMs: 60_000` → tanpa sufiks; `busyMs` tidak memengaruhi cabang `classifying`/`planPreparing`/`compacting`.
- [ ] **Step 2: Jalankan** `node --test test/composer-typing.test.mjs` → gagal.
- [ ] **Step 3: Implementasi** sesuai Interfaces.
- [ ] **Step 4: Jalankan** `node --test test/composer-typing.test.mjs` → semua lulus.
- [ ] **Step 5: Commit**

```bash
git add public/js/core/composer-typing.js public/js/features/composer.js test/composer-typing.test.mjs
git commit -m "Baris status: sebut durasi saat proses lama"
```

---

### Task 5: Test UI area + dokumentasi

**Files:**
- Create: `test/activity-runs-ui.test.mjs`
- Modify: `docs/FITUR.md` (satu paragraf di bagian Chat/Aktivitas)
- Modify: `CHANGELOG.md` (satu butir di **Belum dirilis**)

**Interfaces:**
- Test memakai pola `test/health-metrics-ui.test.mjs`: `before` menyalakan server dengan `OFFICE_DATA_DIR`/`PROJECTS_ROOT` sementara, `launchBrowser()`, lalu `describeArea('UI Aktivitas tim', { skip: SKIP ?? false }, …)` yang diimpor dari `../test-support/ui-area-select.mjs`.

- [ ] **Step 1: Tulis test UI** — buka app, jalankan demo (`#btn-demo`), buka tab Aktivitas (`.tabs button[data-tab="activity"]`), lalu tunggu `#activity li.run[data-run]`. Assert:
  - minimal satu `li.run[data-run]` dengan `b` berisi nama role (bukan `undefined`);
  - `button.run-head[aria-expanded]` ada; run selesai (bila ada) `aria-expanded="false"` dan `<ol.run-steps>` `hidden`;
  - klik satu header membalik `aria-expanded` dan visibilitas `<ol>`;
  - tidak ada error konsol (`page.clearProblems()` + cek akhir).
- [ ] **Step 2: Jalankan** `npm run test:ui:area -- "UI Aktivitas tim"` → lulus.
- [ ] **Step 3: Dokumentasi** — `docs/FITUR.md`: panel Aktivitas menampilkan satu baris per agent dengan durasi/status dan langkah yang bisa dibuka; monitor ⧗ meringkas tugas selesai. `CHANGELOG.md` (**Belum dirilis**): satu butir bahasa Indonesia bergaya entri yang ada.
- [ ] **Step 4: Gerbang akhir** — `npm run check` (exit 0) dan `npm run test:related -- public/js/core/agent-runs.js public/js/features/activity.js public/js/features/tasks.js public/js/features/composer.js`.
- [ ] **Step 5: Commit**

```bash
git add test/activity-runs-ui.test.mjs docs/FITUR.md CHANGELOG.md
git commit -m "Uji UI aktivitas per agent dan dokumentasi"
```

---

## Catatan eksekusi

- Working tree mungkin berisi pekerjaan fitur lain yang belum di-commit (bridge remote power + WhatsApp). **Jangan** memasukkannya ke commit task-task di atas; pakai `git add` per path.
- Bila `#btn-demo` tidak muncul (project sudah ada), buka project demo lewat `location.hash = '#demo'`/`DEMO_ID` sesuai pola test UI yang ada; jangan mengubah `src/demo.js`.
- Jalankan setiap perintah dengan batas waktu; jangan `npm run test:ui` penuh.
