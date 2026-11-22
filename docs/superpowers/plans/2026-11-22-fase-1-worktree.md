# Fase 1 — Worktree (dikelola aplikasi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buat/pilih/daftar/hapus git worktree dari aplikasi dan jalankan mesin (Claude Code / OpenCode) di dalamnya, tanpa worktree berubah menjadi project baru.

**Architecture:** Aplikasi sendiri menjalankan `git worktree add/list/remove` (`src/worktree.js`, aturan murni + wrapper git), lalu sesi memakai **path workspace aktif** (`project.path` atau path worktree) sebagai cwd. Worktree adalah **atribut project** (`settings.worktree`), bukan project baru: folder di bawah `.claude/worktrees/**` dikecualikan dari penemuan project dan mirror. Mengganti workspace = respawn bersih (tidak `--resume` lintas cwd).

**Tech Stack:** Node >= 20 ES module, `node:child_process` `execFile`, `node:test`, vanilla JS/CSS statis. Tanpa dependensi baru, tanpa skema baru selain kunci `worktree` di `settings[id]`.

**Spec:** `docs/superpowers/specs/2026-11-22-adopsi-tuntas-mesin-design.md`

## Global Constraints

- Teks UI: **Bahasa Indonesia**; komentar kode: **Inggris**.
- Worktree dikelola **aplikasi** lewat `git`; **jangan** bergantung pada `claude --worktree` atau perintah CLI worktree OpenCode (belum terverifikasi / tidak ada).
- Worktree **bukan project baru**: jangan biarkan mirror/`discoverProjects` menerbitkannya. `project.id`, ledger, chat, dan riwayat tetap milik project induk.
- Path worktree: `<project>/.claude/worktrees/<name>`; branch: `worktree-<name>`.
- Validasi nama: `^[a-z0-9][a-z0-9-]{0,63}$`.
- Guard: project non-git ditolak dengan pesan jelas; aksi tulis ditolak **409** saat ada giliran berjalan (pola `src/routes/opencode-config.js:7-8`).
- Laptop-only untuk aksi yang menulis/mengubah worktree (pola SECURE_ADMIN di `server.js`); daftar boleh dibaca dari Tailscale.
- Test lama tidak dihapus/dilemahkan. Jalankan gerbang lewat `npm run …`; jangan sentuh env `OFFICE_*`/instalasi asli.

## Review Focus

- **Pergantian cwd = respawn bersih.** Pindah/keluar worktree harus menutup proses lama dan memulai sesi baru di cwd itu, **tanpa** `--resume` id lama (bisa replay/gagal lintas cwd). Uji: setelah `setWorktree`, `restartKey` berubah → `spawn()` dipanggil lagi; `--resume` tidak muncul saat cwd berubah.
- **Worktree tidak jadi project.** Folder di bawah `.claude/worktrees/**` tidak boleh muncul di daftar project meski Claude Code mencatatnya di `~/.claude.json`. Uji di Task 2.
- **Guard non-git & nama tak sah.** Project non-git dan nama di luar pola ditolak sebelum `git` dipanggil. Uji murni di Task 1.
- **Hapus worktree berisi perubahan.** Wajib `force` eksplisit; tanpa itu git menolak dan pesannya diteruskan. Uji di Task 1.
- **Proses yang tak bisa memulai.** `git` tidak ada / path tidak ada → error jelas, tidak menggantung.
- **Engine OpenCode ikut hormat.** Case OpenCode (`src/acp-session.js` spawn `cwd`) memakai workspace path yang sama; jangan hanya menyentuh Claude.

---

### Task 1: `src/worktree.js` — aturan murni + operasi git

**Files:**
- Create: `src/worktree.js`
- Test: `test/worktree.test.mjs` (baru)

**Interfaces:**
- Consumes: `src/projects.js` `isNetworkPath`; `src/child-env.js` `childEnv` (pola `src/git.js:10-16`).
- Produces:
  - `validWorktreeName(name) -> boolean` (`/^[a-z0-9][a-z0-9-]{0,63}$/`)
  - `worktreePath(projectPath, name) -> string` = `path.join(projectPath, '.claude', 'worktrees', name)`
  - `worktreeBranch(name) -> string` = `worktree-${name}`
  - `parseWorktreeList(porcelainText) -> [{ path, branch, head }]`
  - `isWorktreeDir(relPath) -> boolean` (apakah sebuah path relatif berada di bawah `.claude/worktrees/`)
  - `async isGitRepo(cwd) -> boolean`
  - `async listWorktrees(cwd) -> [{ path, branch, head, isMain }]`
  - `async createWorktree(cwd, name) -> { path, branch }` (lempar `WorktreeError` bila gagal)
  - `async removeWorktree(cwd, dirPath, { force = false }) -> void` (lempar `WorktreeError` bila perlu force)
  - `class WorktreeError extends Error { constructor(message, { code, status, output } = {}) }`

- [ ] **Step 1: Tulis test yang gagal** (`test/worktree.test.mjs`) — aturan murni

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { isWorktreeDir, parseWorktreeList, validWorktreeName, worktreeBranch, worktreePath } from '../src/worktree.js';

test('validWorktreeName: pola lowercase kebab, 1–64 char', () => {
  assert.equal(validWorktreeName('login'), true);
  assert.equal(validWorktreeName('a'.repeat(64)), true);
  assert.equal(validWorktreeName('a'.repeat(65)), false);
  assert.equal(validWorktreeName('Login'), false);
  assert.equal(validWorktreeName('../evil'), false);
  assert.equal(validWorktreeName('a/b'), false);
  assert.equal(validWorktreeName('-x'), false);
  assert.equal(validWorktreeName(''), false);
});

test('worktreePath & worktreeBranch', () => {
  assert.equal(worktreePath('C:/p', 'login'), path.join('C:/p', '.claude', 'worktrees', 'login'));
  assert.equal(worktreeBranch('login'), 'worktree-login');
});

test('isWorktreeDir: hanya di bawah .claude/worktrees', () => {
  assert.equal(isWorktreeDir(path.join('.claude', 'worktrees', 'x')), true);
  assert.equal(isWorktreeDir('src'), false);
  assert.equal(isWorktreeDir('.claude/worktrees-other/x'), false);
});

test('parseWorktreeList: blok porcelain → path/branch/head + isMain pertama', () => {
  const text = [
    'worktree C:/p',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree C:/p/.claude/worktrees/login',
    'HEAD def456',
    'branch refs/heads/worktree-login',
    '',
  ].join('\n');
  const list = parseWorktreeList(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].isMain, true);
  assert.equal(list[0].branch, 'main');
  assert.equal(list[1].path, 'C:/p/.claude/worktrees/login');
  assert.equal(list[1].branch, 'worktree-login');
  assert.equal(list[1].isMain, false);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/worktree.test.mjs`
Expected: FAIL — modul `../src/worktree.js` belum ada

- [ ] **Step 3: Tulis test operasi git** (tambah ke file yang sama) — memakai repo git sementara

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createWorktree, isGitRepo, listWorktrees, removeWorktree, WorktreeError } from '../src/worktree.js';

function freshRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-'));
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'hi');
  run('add', '-A'); run('commit', '-qm', 'init');
  return dir;
}

test('isGitRepo: true di repo, false di folder biasa', async () => {
  const repo = freshRepo();
  const plain = mkdtempSync(path.join(tmpdir(), 'plain-'));
  try {
    assert.equal(await isGitRepo(repo), true);
    assert.equal(await isGitRepo(plain), false);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});

test('create/list/remove worktree', async () => {
  const repo = freshRepo();
  try {
    const wt = await createWorktree(repo, 'login');
    assert.equal(wt.branch, 'worktree-login');
    const list = await listWorktrees(repo);
    assert.ok(list.some((w) => w.branch === 'worktree-login'));
    await removeWorktree(repo, wt.path, { force: false });
    assert.ok(!(await listWorktrees(repo)).some((w) => w.branch === 'worktree-login'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('createWorktree: nama tak sah & non-git ditolak tanpa memanggil git', async () => {
  const plain = mkdtempSync(path.join(tmpdir(), 'plain-'));
  try {
    await assert.rejects(() => createWorktree(plain, 'login'), (e) => e instanceof WorktreeError && e.code === 'no-repo');
    await assert.rejects(() => createWorktree(plain, '../x'), (e) => e instanceof WorktreeError && e.code === 'invalid-name');
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

test('removeWorktree: worktree dengan perubahan ditolak tanpa force', async () => {
  const repo = freshRepo();
  try {
    const wt = await createWorktree(repo, 'wip');
    writeFileSync(path.join(wt.path, 'dirty.txt'), 'x');
    await assert.rejects(() => removeWorktree(repo, wt.path, { force: false }), (e) => e instanceof WorktreeError && e.code === 'dirty');
    await removeWorktree(repo, wt.path, { force: true });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
```

- [ ] **Step 4: Jalankan, pastikan gagal**

Run: `node --test test/worktree.test.mjs`
Expected: FAIL — `createWorktree`/`isGitRepo` belum ada

- [ ] **Step 5: Implementasi `src/worktree.js`**

Isi minimal yang menentukan:
- `validWorktreeName` = regex di Interfaces; `worktreePath`/`worktreeBranch` seperti di atas.
- `parseWorktreeList`: pisah per baris kosong; tiap blok ambil `worktree `, `HEAD `, `branch refs/heads/` (atau `detached`); blok pertama `isMain: true`.
- `isWorktreeDir(rel)`: normalisasi `/`, cek prefix `.claude/worktrees/`.
- `isGitRepo(cwd)`: `git rev-parse --is-inside-work-tree` (execFile, `windowsHide`, `childEnv`, timeout 15 s); `false` saat gagal.
- `createWorktree(cwd, name)`: tolak `invalid-name` bila `!validWorktreeName`; tolak `no-repo` bila `!await isGitRepo`; lalu `git worktree add <worktreePath(cwd,name)> -b <worktreeBranch(name)>`; sukses → `{ path, branch }`; gagal → `WorktreeError` dengan `code` dari classifier (`exists` bila branch/path sudah ada, `failed` lain).
- `listWorktrees(cwd)`: `git worktree list --porcelain` → `parseWorktreeList`; non-repo → `[]`.
- `removeWorktree(cwd, dirPath, { force })`: `!isInside`/path bukan worktree → `invalid`; jalankan `git worktree remove [--force] <path>`; bila gagal dan bukan force dan output menyebut perubahan → `WorktreeError('… ada perubahan…', { code: 'dirty', status: 409 })`; bila force → `git worktree remove --force`.
- `WorktreeError` mengikuti pola `GitError` (`src/git.js:70-86`): `status` default 400, `code`, `output`.

- [ ] **Step 6: Jalankan, pastikan lulus**

Run: `node --test test/worktree.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit** (`git add src/worktree.js test/worktree.test.mjs`; pesan: `Aturan & operasi git worktree (src/worktree.js)`).

---

### Task 2: Hub — workspace path, atribut worktree, pengecualian project

**Files:**
- Modify: `src/hub.js` (`DEFAULT_SETTINGS` ~baris 65; `cleanSettings` dekat `ciFollow`; metode baru dekat `ciFollowFor` ~baris 1225; `upsertProject` ~1003)
- Modify: `src/projects.js` (`discoverProjects` baris 56-75)
- Modify: `server.js` (`insideKnownProjectDir` ~baris 725 — dipakai `mirror.skipDir` dan `openCodeMirror.skipDir`, jadi satu perubahan menutup mirror kedua mesin)
- Test: `test/worktree-hub.test.mjs` (baru) + asersi mirror di `test/worktree-route.test.mjs` (Task 4)

**Interfaces:**
- Consumes: `src/worktree.js` `isWorktreeDir`.
- Produces:
  - `hub.worktreeOf(id) -> { name, path, branch } | null`
  - `hub.workspacePathFor(id) -> string` (path worktree bila ada dan folder masih ada, selain itu `project.path`)
  - `hub.setWorktree(id, { name, path, branch } | null) -> void` (menyimpan/menghapus; broadcast `projects`)
  - `cleanSettings` menerima kunci `worktree` (objek {name,path,branch} atau `null`), junk diabaikan
  - `hub.settingsFor(id)` juga memuat `workspacePath` (hasil `workspacePathFor(id)`), agar `restartKey(s)` (Task 3) melihatnya
  - `discoverProjects` **tidak** mengembalikan folder di bawah `.claude/worktrees/**`
  - `insideKnownProjectDir(dir)` (server.js) mengembalikan `false` untuk folder di bawah
    `.claude/worktrees/**`, sehingga `mirror.skipDir`/`openCodeMirror.skipDir` juga melewatinya
  - `restartKey(s)` (di `src/session.js`, Task 3) ikut memuat `workspacePath`

- [ ] **Step 1: Tulis test yang gagal** (`test/worktree-hub.test.mjs`)

```js
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';

test('worktree = atribut project; workspacePathFor mengikuti', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-wt-')) });
  const dir = mkdtempSync(path.join(tmpdir(), 'proj-'));
  const project = hub.upsertProject(dir, 'custom');
  assert.equal(hub.worktreeOf(project.id), null);
  assert.equal(hub.workspacePathFor(project.id), project.path, 'tanpa worktree = folder project');

  const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');
  mkdirSync(wtPath, { recursive: true });
  hub.setWorktree(project.id, { name: 'login', path: wtPath, branch: 'worktree-login' });
  assert.deepEqual(hub.worktreeOf(project.id), { name: 'login', path: wtPath, branch: 'worktree-login' });
  assert.equal(hub.workspacePathFor(project.id), wtPath);
  assert.equal(hub.projects.get(project.id).path, project.path, 'path project induk tidak berubah');

  hub.setWorktree(project.id, null);
  assert.equal(hub.workspacePathFor(project.id), project.path);
});

test('cleanSettings: worktree divalidasi, junk diabaikan', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-wtc-')) });
  hub.projects.set('p1', { id: 'p1', path: 'C:/p', name: 'p1', sources: ['custom'] });
  const base = hub.settingsFor('p1');
  assert.equal(hub.cleanSettings(base, { worktree: 'junk' }).worktree, undefined, 'junk tidak tersimpan');
  const ok = hub.cleanSettings(base, { worktree: { name: 'x', path: 'C:/p/.claude/worktrees/x', branch: 'worktree-x' } });
  assert.deepEqual(ok.worktree, { name: 'x', path: 'C:/p/.claude/worktrees/x', branch: 'worktree-x' });
  assert.equal(hub.cleanSettings(base, { worktree: null }).worktree, null, 'null menghapus');
});

test('discoverProjects melewati folder di bawah .claude/worktrees', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'root-'));
  const proj = path.join(root, 'app'); mkdirSync(proj);
  const wt = path.join(proj, '.claude', 'worktrees', 'login'); mkdirSync(wt, { recursive: true });
  const { discoverProjects } = await import('../src/projects.js');
  const found = discoverProjects({ roots: [root], extra: [] }).map(([d]) => d);
  assert.ok(found.includes(proj));
  assert.ok(!found.includes(wt), 'worktree bukan project');
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/worktree-hub.test.mjs`
Expected: FAIL — `worktreeOf`/`workspacePathFor`/`setWorktree` belum ada; `discoverProjects` masih memasukkan worktree

- [ ] **Step 3: Implementasi**
  - `src/hub.js`: `worktreeOf(id)` → `this.settingsFor(id).worktree ?? null` (hanya bila bentuknya `{name,path,branch}` string sah). `workspacePathFor(id)`: ambil `worktreeOf`, bila ada dan `isDirectory(wt.path)` → `wt.path`, selain itu path project. `setWorktree(id, wt)`: simpan lewat mekanisme patch setelan yang ada (mis. `this.updateSettings(id, { worktree: wt })` bila tersedia, atau tulis `persisted.settings[id].worktree` + `scheduleSave`), lalu `broadcast('projects', this.listProjects())`.
  - `cleanSettings`: tambah cabang `worktree` — `null` disimpan sebagai `null`; objek dengan `name`/`path`/`branch` string (name valid via `validWorktreeName`) disimpan `{name,path,branch}`; selain itu diabaikan (tidak mengubah nilai lama).
  - `src/projects.js`: di `discoverProjects`, sebelum `found.push`, buang `dir` yang `isWorktreeDir(path.relative(<root atau project induk>, dir))` — praktisnya: `if (isWorktreeDir(dir)) continue;` dengan `isWorktreeDir` menerima path absolut dan mencocokkan segmen `/.claude/worktrees/`. Terapkan di cabang `~/.claude.json` **dan** cabang `readdirSync` (meski yang kedua biasanya sudah terlewat karena `.claude` tersembunyi).
  - `server.js` `insideKnownProjectDir(dir)` (~baris 725): tambahkan `if (isWorktreeDir(dir)) return false;` sebelum `isInside(...)`. Ini yang menutup `mirror.skipDir` (`server.js:251`) dan `openCodeMirror.skipDir` (`server.js:263`) sekaligus, karena keduanya memanggil `insideKnownProjectDir`. Uji di Task 4 (mirror) — folder worktree yang dicatat `~/.claude.json` tidak boleh jadi sesi CLI project.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/worktree-hub.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (pesan: `Worktree sebagai atribut project + pengecualian dari daftar project`).

---

### Task 3: SessionManager — sesi berjalan di workspace aktif

**Files:**
- Modify: `src/session.js` (`restartKey` baris 52; `spawn` baris 883-919; tempat lain yang memakai `this.project.path` untuk **cwd engine**: baris 551, 915)
- Modify: `src/acp-session.js` (`spawn` OpenCode baris ~1846-1857; `cwd` baris ~1963, 1572, 1651, 1660, 1819, 1825 — hanya yang benar-benar cwd proses/engine)
- Test: `test/worktree-session.test.mjs` (baru)

**Interfaces:**
- Consumes: `hub.workspacePathFor(id)` (Task 2).
- Produces: `SessionManager`/`AcpSession` memakai `workspacePathFor(id)` sebagai cwd proses; `restartKey(s)` memuat workspace sehingga pergantian memicu respawn tanpa `--resume`.

- [ ] **Step 1: Tulis test yang gagal** (`test/worktree-session.test.mjs`) — pola fake spawn dari test sesi yang ada

```js
// Assert two things without a real model:
// 1) restartKey differs when the workspace path differs (so spawn() runs again).
// 2) after setWorktree, the spawn cwd is the worktree path and no --resume id from the old cwd is passed.
```

Ikuti pola yang sudah ada di `test/session.test.mjs` (fake `claude.command` yang mencatat argv + cwd). Tuntut: `cwd` = path worktree; daftar argv **tidak** memuat `--resume` saat workspace berganti.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/worktree-session.test.mjs`
Expected: FAIL — cwd masih `project.path`; `/resume` ikut terbawa

- [ ] **Step 3: Implementasi**
  - `restartKey(s)`: ubah agar memuat **workspace dan team** — `String(s.team) + '|' + (s.workspacePath ?? '')` — sehingga pergantian workspace memicu respawn bersih pada prompt berikutnya, bukan hanya saat `team` berubah.
  - `spawn(settings)` (baris 883+): hitung `const cwd = this.hub.workspacePathFor(this.id)` di awal; pakai `cwd` untuk `spawn(..., { cwd })`; `--resume` (`sessionId`) **hanya** ditambahkan bila workspace sekarang sama dengan workspace saat sesi terakhir dibuat. Simpan workspace aktif di `this.applied.workspacePath` (atau `this.lastWorkspace`); saat workspace berbeda → **jangan** `--resume`, mulai sesi baru di cwd itu dan reset `this.resumeAt`/`this.forkNext`.
  - `settingsFor` sudah mengembalikan setelan; tambahkan `workspacePath` ke objek yang dipakai `restartKey` (mis. di `hub.settingsFor` atau di pemanggil `restartKey`).
  - `src/acp-session.js`: `const cwd = this.hub.workspacePathFor(this.id)` pada spawn proses OpenCode; pakai untuk `{ cwd }` dan untuk helper shell yang memang berjalan di folder engine; **jangan** ubah pemakaian `project.path` untuk pemetaan role/transcript yang memang milik project induk (mis. `inferRole({ projectPath })` tetap `this.project.path`).

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/worktree-session.test.mjs` lalu `npm run test:related -- src/session.js src/acp-session.js`
Expected: PASS

- [ ] **Step 5: Commit** (pesan: `Sesi berjalan di workspace aktif (worktree)`).

---

### Task 4: Route `src/routes/worktree.js`

**Files:**
- Create: `src/routes/worktree.js`
- Modify: `src/routes/index.js` (import + daftar `register`)
- Modify: `server.js` (allowlist SECURE_ADMIN untuk aksi tulis — cari daftar path `opencode-config`)
- Test: `test/worktree-route.test.mjs` (baru, integrasi `spawn(server.js)`)

**Interfaces:**
- Consumes: `src/worktree.js` (Task 1), `hub.workspacePathFor`/`setWorktree`/`worktreeOf` (Task 2), `sessions.syncSettings`/`reloadSettings`.
- Produces:
  - `POST /api/projects/:id/worktrees` → `{ worktrees: [...], active: '<name>'|null, workspace: '<path>' }`
  - `POST /api/projects/:id/worktree-create { name }` → `{ worktree: {name,path,branch}, workspace }`; 409 saat giliran berjalan; 400 `invalid-name`/`no-repo`; 409 `exists`
  - `POST /api/projects/:id/worktree-enter { name }` → menyetel `hub.setWorktree`, menyinkronkan sesi, membalas `{ workspace }`
  - `POST /api/projects/:id/worktree-exit` → `hub.setWorktree(id, null)` + sync session
  - `POST /api/projects/:id/worktree-remove { name, force }` → hapus; bila worktree itu yang aktif, keluar dulu

- [ ] **Step 1: Tulis test integrasi yang gagal** (`test/worktree-route.test.mjs`)

Pola `spawn(server.js)` dari `test/engine-per-project.test.mjs`, `PROJECTS_ROOT` = repo git sementara yang dibuat test. Tuntut:
1. `POST /worktrees` pada repo git → 200, `worktrees` memuat main.
2. `POST /worktree-create { name: 'login' }` → 200; folder `<project>/.claude/worktrees/login` ada; `GET /api/state`/`projects` **tidak** memuatnya sebagai project.
3. `POST /worktree-enter { name: 'login' }` → `workspacePathFor` = path worktree; status project `workspace` menunjuk ke sana.
4. `POST /worktree-exit` → workspace kembali ke folder project.
5. `POST /worktree-remove { name: 'login' }` → folder hilang.
6. Project non-git → `worktree-create` 400 `no-repo`.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/worktree-route.test.mjs`
Expected: FAIL — route belum ada (404)

- [ ] **Step 3: Implementasi**
  - `src/routes/worktree.js`: `register(router)` dengan lima route di atas. Pola: `withProject`; `hasRunningTurn(ctx.sessions)` → 409 `busy` (sama seperti `opencode-config.js:7-8`); `WorktreeError` → status/code/output; sukses tulis → `ctx.sessions.syncSettings(id)` (atau `reloadSettings`) agar respawn memakai workspace baru; tulis baris chat info (`⎇ Worktree login aktif — sesi berikutnya berjalan di sana.`).
  - `src/routes/index.js`: import `worktree` + daftarkan setelah `git.register`.
  - `server.js`: tambahkan path tulis worktree ke allowlist SECURE_ADMIN (laptop-only), meniru entri `opencode-config`. Daftar `worktrees` (baca) tidak perlu admin.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/worktree-route.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (pesan: `Route worktree: daftar, buat, masuk, keluar, hapus`).

---

### Task 5: UI — dialog Worktree + status di bar sesi

**Files:**
- Modify: `public/index.html` (dialog `<section id="worktree-modal">` + tombol di tab Perubahan / menu ⋯)
- Create: `public/js/features/worktree.js`
- Modify: `public/js/app.js` (inisialisasi fitur)
- Modify: `public/js/core/state.js` (simpan `worktrees`/`workspace` per project dari status)
- Modify: `public/js/features/changes.js` (tombol **⎇ Worktree** di baris ⎇) atau `public/js/features/sessions.js` (menu ⋯)
- Modify: `public/css/app.css` (gaya dialog ringkas)
- Test: `test/worktree-ui.test.mjs` (baru, standalone seperti `test/activity-runs-ui.test.mjs`)

**Interfaces:**
- Consumes: route Task 4; `api()`, `openModal()` (`public/js/ui/modals.js`), `toast()`.
- Produces: dialog **Worktree** — daftar worktree (nama, branch, aktif), **＋ Buat**, **Masuk**, **Keluar**, **Hapus** (konfirmasi; `force` bila ditolak); chip **⎇ <name>** di bar sesi saat workspace = worktree; laptop-only (tombol nonaktif dengan penjelasan di HP WiFi).

- [ ] **Step 1: Tulis test UI yang gagal** (`test/worktree-ui.test.mjs`)

Standalone + `describeArea('UI Worktree', …)`; `spawn(server.js)` dengan repo git sementara. Tuntut: buka dialog → daftar memuat main; buat `login` → baris muncul; masuk → chip `⎇ login` tampil di bar sesi; keluar → chip hilang. Tanpa error konsol.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/worktree-ui.test.mjs`
Expected: FAIL — dialog belum ada

- [ ] **Step 3: Implementasi**
  - `public/index.html`: dialog + tombol pemicu; ikuti pola dialog yang ada (mis. `turn-settings-modal`).
  - `public/js/features/worktree.js`: `openWorktree()` memuat daftar, menggambar, dan menangani aksi; pesan galat dari `code` (`no-repo`, `invalid-name`, `exists`, `dirty`, `busy`) diterjemahkan ke Bahasa Indonesia.
  - `public/js/core/state.js`: simpan `workspace`/`worktrees` dari status project; chip bar sesi membaca `st.worktree`.
  - `public/css/app.css`: gaya ringkas konsisten dengan dialog lain.
  - Aksesibilitas: tombol punya nama untuk pembaca layar, target sentuh ≥ 24 px.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/worktree-ui.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (pesan: `UI Worktree: dialog + status di bar sesi`).

---

### Task 6: Dokumentasi + probe upstream + gerbang akhir

**Files:**
- Modify: `CHANGELOG.md` (bagian `## Belum dirilis`)
- Modify: `docs/FITUR.md` (entri **Worktree** — taruh di bagian **Project & dashboard** atau **Git**)
- Modify: `docs/design-opencode.md` (**Catatan upstream**: tanggal 2026-11-22, OpenCode 2.3.2, fakta "OpenCode tidak punya perintah CLI worktree; hanya tool Code Mode/plugin", sumber inventaris/`--help`; keputusan aplikasi mengelola git sendiri)

- [ ] **Step 1:** Catatan rilis bahasa pengguna: buat/pilih/hapus worktree dari aplikasi, sesi berjalan di sana, worktree bukan project baru.
- [ ] **Step 2:** `docs/FITUR.md`: satu entri fitur + satu baris di tabel yang relevan.
- [ ] **Step 3:** `docs/design-opencode.md` → **Catatan upstream**: probe `opencode --help`/inventaris (worktree bukan perintah CLI), tulis tanggal+versi+sumber.
- [ ] **Step 4:** `npm run test:related -- src/worktree.js src/hub.js src/projects.js src/session.js src/acp-session.js src/routes/worktree.js public/js/features/worktree.js`
- [ ] **Step 5:** `npm run test:smoke` (menyentuh server/route/sesi) lalu `npm run check`.
- [ ] **Step 6: Commit + push.**

---

## Catatan eksekusi

- **Probe sebelum mengunci**: sebelum Task 3 dianggap selesai, jalankan `opencode --help` dan `claude --help` di mesin ini sekali untuk mengonfirmasi tidak ada perintah worktree yang tersembunyi; catat hasilnya di `docs/design-opencode.md`. Bila ternyata ada, tetap pakai jalur aplikasi (konsisten dua mesin), tapi catat faktanya.
- **Fake**: `test-support/fake-acp.mjs` tidak perlu berkas worktree (tidak ada frame ACP baru). Jangan menambah frame tebakan.
- **Batas fase**: worktree **tidak** memindahkan project, ledger, chat, atau riwayat. Pindah balik ke folder project memakai sesi Claude di cwd itu (id percakapan per cwd) — jelaskan di dokumentasi, jangan menipu dengan mengaku percakapan pindah utuh.
- Metode eksekusi: menunggu pilihan user (native vs subagent-driven).