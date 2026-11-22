# Baris tunggu antar-langkah di chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selama giliran masih berjalan tetapi tidak ada langkah yang sedang berjalan, tampilkan satu baris eksplisit **"⏳ Tim sedang menyusun langkah berikutnya…"** di ujung daftar chat (dan Aktivitas), agar jeda antar-langkah tidak terbaca seperti macet.

**Architecture:** Aturan murni `nextStepHint({ busy, running })` di `public/js/core/turn-progress.js`. Di chat, satu elemen `#chat-waiting` di ujung `#chat` dinyalakan/dimatikan oleh fungsi paint yang dipanggil dari event `status` dan setelah render. Di tab Aktivitas, satu `<li class="activity-waiting">` saat `busyNow()` benar tetapi tidak ada run `live`. Tanpa perubahan server.

**Tech Stack:** Vanilla JS + CSS statis (tanpa bundler), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-22-baris-tunggu-antar-langkah-design.md`

## Global Constraints

- Teks UI: **Bahasa Indonesia**; komentar kode: **Inggris**.
- Aturan murni tanpa DOM agar bisa dites; tanpa dependensi baru; tanpa perubahan server.
- Jangan menghapus/melemahkan test lama.

## Review Focus

- **Giliran belum jalan tapi chat punya pesan lama.** Baris tunggu hanya boleh muncul saat `st.busy` benar; kalau tidak, chat yang terbuka tenang tidak boleh menampilkan apa pun. Uji di Task 1.
- **Langkah sedang berjalan.** Saat ada tool/delegate `status: 'running'`, baris tunggu harus **hilang** (tidak dobel dengan spinner langkah). Uji di Task 1.
- **Semua langkah subagent sudah `running` non-aktif (stale).** `running` menghitung hanya `status === 'running'`, sehingga langkah `stale` tidak menahan baris tunggu. Uji di Task 1.
- **Proyek bukan yang aktif.** Paint hanya menyentuh `#chat`; status proyek lain tidak boleh memunculkan baris di proyek yang dilihat. Uji di Task 2 (unit oleh handler) — cukup memanggil paint hanya saat `status.project === state.active`.
- **Giliran selesai.** Begitu `st.busy` menjadi false (atau `result`, `error`), baris hilang. Uji di Task 1.

---

### Task 1: Aturan murni `nextStepHint`

**Files:**
- Modify: `public/js/core/turn-progress.js` (tambah ekspor di dekat `progressLabel`)
- Test: `test/next-step-hint.test.mjs` (baru)

**Interfaces:**
- Consumes: — (mandiri).
- Produces: `export function nextStepHint({ busy = false, running = 0 } = {}) -> string` — `'⏳ Tim sedang menyusun langkah berikutnya…'` bila `busy` benar dan `running === 0`; `''` sebaliknya.

- [ ] **Step 1: Tulis test yang gagal** (`test/next-step-hint.test.mjs`)

```js
// The wait row between steps: shown while a turn is running but no step is running yet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextStepHint } from '../public/js/core/turn-progress.js';

test('baris tunggu: hanya saat giliran hidup tanpa langkah berjalan', () => {
  assert.equal(nextStepHint({ busy: false, running: 0 }), '', 'chat tenang: tidak ada baris');
  assert.equal(nextStepHint({ busy: true, running: 2 }), '', 'ada langkah berjalan: tidak perlu baris');
  assert.equal(nextStepHint({ busy: true, running: 0 }), '⏳ Tim sedang menyusun langkah berikutnya…');
  assert.equal(nextStepHint({}), '', 'tanpa argumen pun aman');
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `$env:CI=1; node --test test/next-step-hint.test.mjs`
Expected: FAIL — `nextStepHint is not a function` (atau assertion gagal).

- [ ] **Step 3: Implementasi** — tambah setelah `progressLabel` di `public/js/core/turn-progress.js`:

```js
/**
 * The wait row between steps: visible while the turn is still running but nothing is running yet, so a gap
 * between a finished subagent step and the Lead's next step never reads as "stuck".
 */
export function nextStepHint({ busy = false, running = 0 } = {}) {
  return busy && Number(running) === 0 ? '⏳ Tim sedang menyusun langkah berikutnya…' : '';
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `$env:CI=1; node --test test/next-step-hint.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit** (`git add public/js/core/turn-progress.js test/next-step-hint.test.mjs`; pesan: `Baris tunggu antar-langkah: aturan murni nextStepHint`).

---

### Task 2: Baris tunggu di ujung daftar chat

**Files:**
- Modify: `public/js/features/chat.js` (`renderChat` baris 51-90; tambah `paintChatWaiting`; panggil setelah `paintChat`)
- Modify: `public/js/core/stream.js` (handler `status` baris 149-160: panggil `paintChatWaiting`)
- Modify: `public/css/app.css` (gaya `.chat-waiting`, dekat gaya `.typing`)
- Test: `test/chat-waiting.test.mjs` (baru, unit atas helper paint murni — lihat Step 1)

**Interfaces:**
- Consumes: `nextStepHint` (Task 1); `state.statuses[state.active]` (`busy`), `state.chats[state.active]` (menghitung langkah `running`).
- Produces: `paintChatWaiting(status)` di `public/js/features/chat.js` — satu-satunya penulis elemen `#chat-waiting`.

- [ ] **Step 1: Tulis test yang gagal** (`test/chat-waiting.test.mjs`) — uji aturan pemetaan status→visibilitas tanpa DOM, lewat helper murni `runningSteps(messages)` yang ditambahkan di `turn-progress.js`:

```js
// How many steps of the current turn are still running (drives the wait row's visibility).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runningSteps } from '../public/js/core/turn-progress.js';

test('langkah berjalan dihitung hanya setelah user prompt terakhir, status running saja', () => {
  const msgs = [
    { kind: 'user', ts: 1 },
    { kind: 'tool', status: 'ok', ts: 2 },
    { kind: 'tool', status: 'running', ts: 3 },
    { kind: 'delegate', status: 'running', ts: 4 },
    { kind: 'tool', status: 'stale', ts: 5 },
  ];
  assert.equal(runningSteps(msgs), 2, 'dua langkah running (stale tidak dihitung)');
  // A new user prompt starts a new turn: the running steps of the previous turn do not count.
  assert.equal(runningSteps([...msgs, { kind: 'user', ts: 6 }]), 0);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `$env:CI=1; node --test test/chat-waiting.test.mjs`
Expected: FAIL — `runningSteps is not a function`.

- [ ] **Step 3: Implementasi**

  a. `public/js/core/turn-progress.js` — tambah `runningSteps`:

```js
/** How many steps after the latest user prompt are still running (the wait row hides while any is). */
export function runningSteps(messages = []) {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === 'user') { start = i; break; }
  }
  let running = 0;
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if ((m?.kind === 'tool' || m?.kind === 'delegate') && m.status === 'running') running += 1;
  }
  return running;
}
```

  b. `public/js/features/chat.js` — impor `nextStepHint, runningSteps` dari `../core/turn-progress.js`; tambah elemen di `renderChat` (setelah `paintChat`, sebelum `scrollChat`):

```js
// The gap between a finished step and the Lead's next one: one explicit row, so an empty tail never reads as stuck.
export function paintChatWaiting(status = state.statuses[state.active] ?? {}) {
  const hint = nextStepHint({ busy: Boolean(status.busy), running: runningSteps(state.chats[state.active] ?? []) });
  let row = chatEl.querySelector('.chat-waiting');
  if (!hint) { row?.remove(); return; }
  if (!row) {
    row = document.createElement('div');
    row.className = 'chat-waiting';
    row.setAttribute('role', 'status');
    chatEl.append(row);
  }
  if (row.textContent !== hint) row.textContent = hint;
}
```

Panggil `paintChatWaiting()` di akhir `renderChat` (kedua jalur: kosong dan berisi), dan setelah `appendChat`/`renderChat` di handler `chat` (baris ~180-183) serta di handler `chat_update` (baris ~277-286) — cukup di handler `status` `stream.js` dan setelah tiap `renderChat`. Di `stream.js` `status(status)`, di dalam blok `status.project === state.active`, tambah `paintChatWaiting(status);`.

  c. `public/css/app.css` — gaya dekat `.typing`:

```css
/* The wait row in the chat tail while the turn runs and no step is running (no spinner: the turn IS alive). */
.chat-waiting { margin: 8px 12px; color: var(--muted); font-size: 13px; font-style: italic; opacity: .85; }
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `$env:CI=1; node --test test/chat-waiting.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit** (pesan: `Baris tunggu antar-langkah di ujung daftar chat`).

---

### Task 3: Baris tunggu di tab Aktivitas

**Files:**
- Modify: `public/js/features/activity.js` (`renderActivity` baris 68-103)
- Modify: `public/css/app.css` (gaya `.activity-waiting`)
- Test: `test/chat-waiting.test.mjs` (tambah satu test atas `nextStepHint` untuk jalur aktivitas)

**Interfaces:**
- Consumes: `nextStepHint` (Task 1); `busyNow()` dan `runsNow()` di `activity.js`.
- Produces: baris `<li class="activity-waiting">` di `#activity` saat busy tanpa run live; tidak ada ekspor baru.

- [ ] **Step 1: Tulis test yang gagal** — tambah ke `test/chat-waiting.test.mjs`:

```js
test('aktivitas: baris tunggu hanya saat busy tanpa run live', () => {
  // Same rule the activity tab applies: busy and no live run -> the hint text.
  assert.equal(nextStepHint({ busy: true, running: 0 }), '⏳ Tim sedang menyusun langkah berikutnya…');
  assert.equal(nextStepHint({ busy: true, running: 1 }), '');
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `$env:CI=1; node --test test/chat-waiting.test.mjs`
Expected: FAIL hanya bila impor `nextStepHint` sudah ada; kalau sudah lulus, lanjut (test ini mengunci perilaku yang sudah dibangun di Task 1).

- [ ] **Step 3: Implementasi** — di `renderActivity`, setelah `runs` dihitung dan sebelum/atau sesudah penulisan `list.innerHTML`, sisipkan baris tunggu ketika `busyNow()` dan `!runs.some((r) => r.status !== 'done')`:

```js
// Busy with no run live: say the team is between steps, right in the list a user is watching.
const liveRun = runs.some((r) => r.status !== 'done');
const waiting = busyNow() && !liveRun;
```

lalu tambahkan ke hasil render (append setelah markup run, atau ke `<li class="activity-empty">` diganti bila `waiting`): bila `runs.length` ada, `list.innerHTML += '<li class="activity-waiting">⏳ Tim sedang menyusun langkah berikutnya…</li>'` saat `waiting`. Bila `!runs.length && waiting`, tampilkan baris tunggu (bukan "Belum ada aktivitas…").

Gaya di `app.css`: `.activity-waiting { color: var(--muted); font-style: italic; }`.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `$env:CI=1; node --test test/chat-waiting.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** (pesan: `Baris tunggu antar-langkah di tab Aktivitas`).

---

### Task 4: Dokumentasi + gerbang akhir (commit terakhir)

**Files:**
- Modify: `CHANGELOG.md` (bagian `## Belum dirilis` teratas)
- Modify: `docs/FITUR.md` (entri aktivitas/chat)

- [ ] **Step 1:** Satu bulir bahasa pengguna: baris "⏳ Tim sedang menyusun langkah berikutnya…" mengisi jeda antar-langkah agar tidak terbaca macet.
- [ ] **Step 2:** `npm run test:related -- public/js/core/turn-progress.js public/js/features/chat.js public/js/features/activity.js public/js/core/stream.js`
- [ ] **Step 3:** `npm run check`; blok UI chat yang relevan lewat `npm run test:ui:area -- "<nama blok>"`.
- [ ] **Step 4: Commit + push.** Review independen dif oleh subagent `reviewer`.

---

## Catatan eksekusi

Metode: **native** (dikerjakan langsung di sesi ini). Review independen atas diff oleh subagent `reviewer` setelah Task 3.