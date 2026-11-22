# Fase 3 — Folder Tambahan (Claude) & References (OpenCode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code boleh diberi folder tambahan per project dari aplikasi (`--add-dir`), dan editor config OpenCode bisa mengelola `references` (folder lokal atau repo Git) lewat form — tanpa terminal.

**Architecture:** Folder tambahan disimpan sebagai atribut project (`settings.additionalDirectories`) dengan aturan path murni di `src/add-dirs.js`, dialirkan ke proses Claude sebagai `--add-dir`, dan dikelola lewat route per project + dialog sendiri. References diperluas di editor config OpenCode yang sudah ada: `mergeForm` menerima `form.references`, `readOpenCodeConfig` mengembalikan tampilan references, dan UI menambah bagian References di form.

**Tech Stack:** Node >= 20 (ESM, tanpa framework), `node:test` + `node:assert/strict`, CDP untuk test browser, HTML/CSS/JS statis.

**Spec:** `docs/superpowers/specs/2026-11-22-adopsi-tuntas-mesin-design.md` (Fase 3; otoritas bila plan bertentangan)

## Global Constraints

- Test dulu (gagal), lalu implementasi; satu topik per commit, pesan commit bahasa Indonesia.
- Komentar kode bahasa Inggris; semua teks UI dan pesan error bahasa Indonesia. Kata "mesin" tidak boleh muncul di string UI (voice test).
- Folder tambahan: **absolut**, folder yang ada, bukan path jaringan/UNC, `~` dikembangkan, duplikat ditolak (tanpa beda huruf besar/kecil di Windows), maksimal **10**, panjang tiap path maksimal **500** karakter.
- Folder tambahan khusus Claude (`claudeOnly`); menambah/menghapus **hanya dari laptop** (route + `LOCAL_ONLY_ACTION`). Daftar boleh dibaca lewat Tailscale, ditolak di WiFi biasa (tidak masuk allowlist baca).
- Mengubah folder tambahan ditolak **409** selama project itu punya giliran berjalan; perubahan berlaku pada proses Claude berikutnya.
- References OpenCode: alias 1–64 karakter tanpa `/`, `\`, spasi, backtick, koma; tepat satu dari `path` atau `repository`; `file:` sebagai repository ditolak; `branch` hanya `[A-Za-z0-9/_.-]`, tidak dimulai `-`, tanpa `..`; `description` maksimal 500; `hidden` boolean; maksimal **50** references.
- Menyimpan references memakai jalur simpan config yang ada: backup otomatis, lock `baseHash`, dan penolakan saat giliran berjalan tetap berlaku.
- Jangan menambah class CSS baru kecuali juga menambah rule di `public/css/app.css` (coverage test). Reuse `worktree-*` dan `oc-*`.
- Probe upstream sudah dijalankan 2026-11-22: Claude Code **2.1.328** punya `--add-dir <directories...>` (More directories Claude can access); OpenCode **2.3.2**. Catat di `docs/design-opencode.md` → “Catatan upstream” sebelum implementasi menyentuh keduanya.
- Di akhir: `npm run check` hijau, `npm run test:related -- <file berubah>` hijau, `npm run test:smoke` (server tersentuh), test UI baru dijalankan langsung (`node --test <file>`), lalu rilis `1.0.88`.

## Review Focus

1. `\\server\share` dan `//server/share` adalah path absolut di Windows: harus ditolak sebagai folder jaringan, bukan diterima lalu diberikan ke Claude.
2. `state.json` yang diedit tangan dengan `additionalDirectories` berupa string/objek/junk tidak boleh membuat `settingsFor` melempar atau mengirim argumen aneh ke spawn.
3. Mengubah folder tambahan saat ada giliran berjalan, atau setelah masuk worktree, harus membuat proses berikutnya memakai daftar baru (restart key), bukan daftar lama.
4. Alias references kosong/berisi `/` atau repository `file:` harus ditolak 400 **tanpa menulis file config**.
5. Simpan form OpenCode tidak boleh menghapus/mengubah kunci config lain, field asing di dalam satu reference, atau blok `references` yang tidak disentuh pengguna.

---

### Task 1: Aturan folder tambahan (murni)

**Files:**
- Create: `src/add-dirs.js`
- Test: `test/add-dirs.test.mjs`

**Interfaces:**
- Consumes: `isNetworkPath` dari `src/projects.js`; `node:path`, `node:os`.
- Produces:
  - `ADD_DIR_LIMIT = 10`, `ADD_DIR_MAX_LENGTH = 500`
  - `class AddDirError extends Error { status }`
  - `expandHome(value, home = os.homedir()) -> string`
  - `cleanAddDirs(list, { home = os.homedir() } = {}) -> string[]`
  - `addDirectory({ list, value, home = os.homedir(), exists = isDirectory }) -> string[]`
  - `removeDirectory({ list, value, home = os.homedir() }) -> string[]`
  - `addDirViews(list, { exists = isDirectory } = {}) -> { path, exists }[]`

- [ ] **Step 1: Write the failing test**

```js
// test/add-dirs.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ADD_DIR_LIMIT, addDirViews, addDirectory, cleanAddDirs, expandHome, removeDirectory } from '../src/add-dirs.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'office-dirs-'));

test('addDirectory: absolut, ada, bukan jaringan; ~ dikembangkan', () => {
  const home = tmp();
  const lib = path.join(home, 'pustaka');
  mkdirSync(lib);
  assert.deepEqual(addDirectory({ list: [], value: lib, home }), [lib]);
  assert.deepEqual(addDirectory({ list: [], value: '~/pustaka', home }), [lib]);
  assert.throws(() => addDirectory({ list: [], value: 'pustaka', home }), /absolut/);
  assert.throws(() => addDirectory({ list: [], value: '\\\\server\\share', home }), /jaringan/);
  assert.throws(() => addDirectory({ list: [], value: path.join(home, 'hilang'), home }), /tidak ditemukan/);
});

test('addDirectory: duplikat (tanpa beda huruf di Windows), maksimal 10', () => {
  const home = tmp();
  const dirs = Array.from({ length: ADD_DIR_LIMIT }, (_, i) => { const d = path.join(home, `d${i}`); mkdirSync(d); return d; });
  const full = dirs.reduce((list, d) => addDirectory({ list, value: d, home }), []);
  assert.equal(full.length, ADD_DIR_LIMIT);
  assert.throws(() => addDirectory({ list: full, value: path.join(home, 'satu-lagi'), home }), /Maksimal/);
  const dup = process.platform === 'win32' ? dirs[0].toUpperCase() : dirs[0];
  assert.throws(() => addDirectory({ list: full, value: dup, home }), /sudah ada/);
});

test('cleanAddDirs: junk state.json dibuang, tidak melempar, berhenti di batas', () => {
  const home = tmp();
  const real = path.join(home, 'real');
  mkdirSync(real);
  assert.deepEqual(cleanAddDirs(null), []);
  assert.deepEqual(cleanAddDirs([42, '', 'relatif', '\\\\srv\\x', real, real, 'x'.repeat(ADD_DIR_MAX_LENGTH + 1)]), [real]);
});

test('removeDirectory melepas path yang foldernya sudah tidak ada', () => {
  const home = tmp();
  const gone = path.join(home, 'sudah-hilang');
  assert.deepEqual(removeDirectory({ list: [gone], value: gone, home }), []);
  assert.throws(() => removeDirectory({ list: [], value: gone, home }), /tidak ada di daftar/);
});

test('addDirViews menandai folder yang hilang', () => {
  const home = tmp();
  const real = path.join(home, 'ada');
  mkdirSync(real);
  assert.deepEqual(addDirViews([real, path.join(home, 'tidak-ada')]), [
    { path: real, exists: true },
    { path: path.join(home, 'tidak-ada'), exists: false },
  ]);
  assert.equal(expandHome('~', home), home);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/add-dirs.test.mjs`
Expected: FAIL — `Cannot find module '../src/add-dirs.js'`

- [ ] **Step 3: Implement `src/add-dirs.js`**

Rules: trim → `expandHome` (`~`, `~/`, `~\`) → reject empty, network (`isNetworkPath`), non-absolute → `path.resolve`. `cleanAddDirs` silently drops every invalid entry and de-duplicates case-insensitively on `win32`; it accepts at most `ADD_DIR_LIMIT`. `addDirectory` throws `AddDirError` with status 400 (`Path folder tidak boleh kosong.`, `Folder jaringan (\\server\share) tidak didukung. Pakai folder di laptop ini.`, `Path folder tambahan harus absolut (mis. C:\kerja\pustaka).`, `Folder tidak ditemukan.`, `Maksimal 10 folder tambahan.`) and 409 (`Folder itu sudah ada di daftar.`). `removeDirectory` resolves without checking existence and throws 404 `Folder itu tidak ada di daftar.`. `addDirViews` uses the injected `exists` (default `isDirectory`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/add-dirs.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/add-dirs.js test/add-dirs.test.mjs
git commit -m "Folder tambahan: aturan path murni (absolut, bukan jaringan, maksimal 10)"
```

---

### Task 2: Settings project + spawn Claude

**Files:**
- Modify: `src/hub.js` (`DEFAULT_SETTINGS` line 66; `settingsFor` 1251–1264; `cleanSettings` 1345–1397)
- Modify: `src/session.js` (`restartKey` line 52; `spawn` 883–930)
- Test: `test/add-dirs-session.test.mjs`

**Interfaces:**
- Consumes: `cleanAddDirs` dari Task 1.
- Produces: `settingsFor(id).additionalDirectories: string[]` (selalu array bersih); proses Claude menerima satu `--add-dir` dengan semua path; `restartKey` berubah saat daftar berubah.

- [ ] **Step 1: Write the failing test**

Salin pola `test/worktree-session.test.mjs` (`fakeClaude`, `freshHubAndProject`), lalu:

```js
test('spawn meneruskan --add-dir untuk setiap folder tambahan', async () => {
  const { hub, dir, project } = freshHubAndProject('ad');
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b');
  mkdirSync(a); mkdirSync(b);
  hub.updateSettings(project.id, { additionalDirectories: [a, b] });
  const record = path.join(dir, 'spawn.json');
  const manager = new SessionManager({ hub, claude: fakeClaude(record), opencode: null, agents: {}, teamPrompt: '', ledger: null, account: null });
  const session = manager.get(project);
  session.spawn(hub.settingsFor(project.id));
  const argv = (await waitRecord(record)).argv;
  const at = argv.indexOf('--add-dir');
  assert.ok(at >= 0);
  assert.deepEqual(argv.slice(at + 1, at + 3), [a, b]);
  session.closeChild();
});

test('daftar folder baru menutup proses idle supaya pesan berikutnya memakai daftar itu', async () => {
  const { hub, dir, project } = freshHubAndProject('ar');
  const a = path.join(dir, 'a'); mkdirSync(a);
  const manager = new SessionManager({ hub, claude: fakeClaude(path.join(dir, 'spawn.json')), opencode: null, agents: {}, teamPrompt: '', ledger: null, account: null });
  const session = manager.get(project);
  session.spawn(hub.settingsFor(project.id));
  assert.ok(session.child);
  hub.updateSettings(project.id, { additionalDirectories: [a] });
  session.syncSettings();
  assert.equal(session.child, null, 'proses ditutup: spawn berikutnya membawa --add-dir');
});

test('settingsFor membersihkan additionalDirectories dari state.json yang diedit tangan', () => {
  const { hub, dir, project } = freshHubAndProject('aj');
  hub.updateSettings(project.id, {}); // pastikan entri settings ada
  hub.persisted.settings[project.id].additionalDirectories = 'bukan array';
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, []);
  hub.persisted.settings[project.id].additionalDirectories = [null, 'relatif'];
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/add-dirs-session.test.mjs`
Expected: FAIL — `--add-dir` tidak ada / `syncSettings` tidak menutup proses.

- [ ] **Step 3: Implement hub + spawn**

`src/hub.js`: import `cleanAddDirs`; add `additionalDirectories: []` to `DEFAULT_SETTINGS`; in `settingsFor` add `settings.additionalDirectories = cleanAddDirs(this.persisted.settings?.[id]?.additionalDirectories);`; in `cleanSettings` add `if (Array.isArray(patch.additionalDirectories)) next.additionalDirectories = cleanAddDirs(patch.additionalDirectories);`.
`src/session.js`: `const restartKey = (s) => String(s.team) + '|' + (s.workspacePath ?? '') + '|' + (s.additionalDirectories ?? []).join('\n');`; in `spawn` after the `--permission-mode` push: `if (settings.additionalDirectories?.length) args.push('--add-dir', ...settings.additionalDirectories);` (one variadic flag: `--add-dir <directories...>`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/add-dirs-session.test.mjs test/worktree-session.test.mjs`
Expected: PASS (keduanya).

- [ ] **Step 5: Commit**

```bash
git add src/hub.js src/session.js test/add-dirs-session.test.mjs
git commit -m "Folder tambahan: settings per project dan --add-dir ke proses Claude"
```

---

### Task 3: Route folder tambahan + gerbang laptop

**Files:**
- Create: `src/routes/add-dirs.js`
- Modify: `src/routes/index.js` (import + register), `server.js:807` (`LOCAL_ONLY_ACTION`)
- Test: `test/add-dirs-route.test.mjs`, `test/review-guards.test.mjs`

**Interfaces:**
- Consumes: `addDirectory`, `removeDirectory`, `addDirViews`, `AddDirError`, `ADD_DIR_LIMIT` (Task 1); `settingsFor`/`updateSettings` (Task 2); `withProject`, `claudeOnly` dari `src/routes/project.js`.
- Produces:
  - `POST /api/projects/:id/dirs` → `{ dirs: { path, exists }[], max: 10 }`
  - `POST /api/projects/:id/dirs-add` body `{ path }` → `{ dirs, max: 10 }`
  - `POST /api/projects/:id/dirs-remove` body `{ path }` → `{ dirs, max: 10 }`

- [ ] **Step 1: Write the failing test**

Pakai pola dari `test/review-guards.test.mjs` (router asli + `Hub` asli di folder temp). Definisikan satu helper `callRoute` yang mengembalikan `{ status, body }`:

```js
// test/add-dirs-route.test.mjs
const router = buildRouter();
const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-dirs-route-')) });
const project = hub.upsertProject(mkdtempSync(path.join(tmpdir(), 'office-dirs-project-')), 'custom');
const sessions = { sessions: new Map() };
const ctx = { hub, sessions, isLocal: (req) => req.local !== false };
const call = (pattern, body = {}, req = { local: true }) =>
  callRoute(router, pattern, ctx, req, body, { id: project.id });

test('daftar kosong, tambah dari laptop, bertahan di settings, lalu hapus', async () => {
  const extra = mkdtempSync(path.join(tmpdir(), 'office-extra-'));
  assert.deepEqual((await call('/api/projects/:id/dirs')).body, { dirs: [], max: 10 });
  const added = (await call('/api/projects/:id/dirs-add', { path: extra })).body;
  assert.deepEqual(added.dirs, [{ path: extra, exists: true }]);
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, [extra]);
  assert.deepEqual((await call('/api/projects/:id/dirs-remove', { path: extra })).body, { dirs: [], max: 10 });
});

test('path relatif 400, duplikat 409, dan bukan dari laptop 403', async () => {
  assert.equal((await call('/api/projects/:id/dirs-add', { path: 'relatif' })).status, 400);
  const extra = mkdtempSync(path.join(tmpdir(), 'office-extra-'));
  await call('/api/projects/:id/dirs-add', { path: extra });
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extra })).status, 409);
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extra }, { local: false })).status, 403);
});

test('giliran berjalan menolak 409 dan engine OpenCode menolak 409', async () => {
  sessions.sessions.set(project.id, { turnActive: () => true });
  assert.equal((await call('/api/projects/:id/dirs-add', { path: mkdtempSync(path.join(tmpdir(), 'office-extra-')) })).status, 409);
  sessions.sessions.clear();
  hub.updateSettings(project.id, { engine: 'opencode' });
  assert.equal((await call('/api/projects/:id/dirs')).status, 409);
});
```

Di `test/review-guards.test.mjs` tambahkan satu test sumber:

```js
test('folder tambahan: tambah/hapus termasuk aksi laptop-only', () => {
  const text = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const re = new RegExp(/const LOCAL_ONLY_ACTION =\s*\/(.*)\/;/.exec(text)[1]);
  assert.ok(re.test('/api/projects/p1/dirs-add'));
  assert.ok(re.test('/api/projects/p1/dirs-remove'));
  assert.ok(!re.test('/api/projects/p1/dirs'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/add-dirs-route.test.mjs test/review-guards.test.mjs`
Expected: FAIL — route belum terdaftar; regex `LOCAL_ONLY_ACTION` belum memuat `dirs-add`.

- [ ] **Step 3: Implement route + guards**

`src/routes/add-dirs.js`: a `guard` wrapper translating `AddDirError` to `json(res, err.status, { error })`; `fromLaptop(ctx, req)` throws `AddDirError(403, 'Folder tambahan hanya bisa diubah dari laptop.')` when `ctx.isLocal(req) !== true`; `busy` helper (409 `Tidak bisa mengubah folder tambahan saat masih ada giliran yang berjalan.`); `syncSession` calls `sessions.sessions.get(id)?.syncSettings?.()`. Register all three with `withProject(claudeOnly(guard(...), 'Folder tambahan'))`. Add → chat line `Folder tambahan ditambahkan: <path> (berlaku pada pesan berikutnya).`; remove → `Folder tambahan dilepas: <path>.` List answers `{ dirs, max: ADD_DIR_LIMIT }`; add/remove answer the same after updating settings.
`src/routes/index.js`: import `addDirs` and register after `skills`.
`server.js`: `LOCAL_ONLY_ACTION` alternation gets `|dirs-add|dirs-remove`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/add-dirs-route.test.mjs test/review-guards.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/add-dirs.js src/routes/index.js server.js test/add-dirs-route.test.mjs test/review-guards.test.mjs
git commit -m "Folder tambahan: route per project, tambah/hapus hanya dari laptop"
```

---

### Task 4: Dialog Folder tambahan

**Files:**
- Create: `public/js/features/add-dirs.js`
- Modify: `public/index.html` (menu ⋯ line ~156, sheet HP line ~1798, modal setelah `#worktree-modal`), `public/js/features/more-menu.js`, `public/js/app.js` (init)
- Test: `test/add-dirs-ui.test.mjs`

**Interfaces:**
- Consumes: route Task 3; `laptopBlocked`, `api`, `toast` dari `core/api.js`; `guardCap` dari `features/engine.js`; `openModal` dari `ui/modals.js`.
- Produces: `openAddDirs()`, `initAddDirs()`.

- [ ] **Step 1: Write the failing test**

Salin kerangka `test/worktree-ui.test.mjs` (server temp + `fake-claude.mjs`, satu project, `launchBrowser`, viewport desktop). Isi test:

```js
describe('📂 UI Folder tambahan', { skip: SKIP ?? false }, () => {
  test('buka dialog, tambah folder, tolak path relatif, lalu hapus', async () => {
    const extra = mkdtempSync(path.join(tmpdir(), 'office-ui-extra-'));
    // buka menu ⋯ lalu item [data-more='dirs'] (klik), tunggu #dirs-modal terlihat
    // isi #dirs-path = extra, submit #dirs-add-form
    // tunggu #dirs-list li[data-dir] ada; baca dataset.path => extra
    // isi #dirs-path = 'relatif', submit; tunggu #dirs-error memuat /absolut/
    // klik [data-dir-remove] di baris; tunggu baris hilang dan #dirs-sum memuat 'Belum ada'
    // setelah reload halaman + buka dialog lagi: daftar tetap kosong (tersimpan di server)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/add-dirs-ui.test.mjs`
Expected: FAIL — dialog/menu belum ada.

- [ ] **Step 3: Implement UI**

- `public/index.html`: menu item `<button role="menuitem" data-more="dirs" data-cap="permissions">📂 Folder tambahan</button>` setelah Worktree; sheet HP `<button ... data-proxy="[data-more='dirs']" data-mutates data-cap="permissions">… Folder tambahan</button>`; modal `#dirs-modal` memakai class yang sudah ada (`modal`, `modal-card worktree-card`, `modal-head`, `worktree-list`, `worktree-create`, `field-error`). Judul `📂 Folder tambahan`, catatan bahwa Claude boleh membaca/menulis folder itu dan perubahan berlaku pada pesan berikutnya, input `#dirs-path` (maxlength 500, placeholder `C:\kerja\pustaka`), `<ul id="dirs-list" class="worktree-list">`, `#dirs-error`, `#dirs-laptop-note`.
- `public/js/features/add-dirs.js`: `openAddDirs()` → `guardCap('permissions')`, refuse `state.readOnly` (`toast('Folder tambahan hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn')`), refuse `DEMO_ID`; set project name, clear error, `openModal('dirs-modal')`, load list. Row: `li[data-dir]` with `.wt-name` (`<b>` basename, `<small>` full path), badge `tidak ditemukan` when `exists === false`, remove button `[data-dir-remove]` with confirm. Busy/laptop state via `laptopBlocked('/api/projects/contoh/dirs-add')`; disable input/buttons while busy; `view.busy` guard identical to worktree `act()`.
- `more-menu.js`: import + `data-more === 'dirs'` branch.
- `app.js`: `import { initAddDirs }` + `initAddDirs();` next to `initWorktree()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/add-dirs-ui.test.mjs`
Expected: PASS (atau skip bila CDP tidak tersedia).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/features/add-dirs.js public/js/features/more-menu.js public/js/app.js test/add-dirs-ui.test.mjs
git commit -m "Folder tambahan: dialog dari menu, daftar dengan penanda folder hilang"
```

---

### Task 5: References OpenCode (server)

**Files:**
- Modify: `src/opencode-config.js` (`OPENCODE_CONFIG_LIMITS` line 12, `readOpenCodeConfig` 246–284, `mergeForm` 621–674)
- Test: `test/opencode-config.test.mjs`

**Interfaces:**
- Consumes: `isObject`, `validateObject`, `OpenCodeConfigError`, `FORBIDDEN_KEYS` yang sudah ada.
- Produces: `readOpenCodeConfig(...).references: { name, kind, path, repository, branch, description, hidden }[]`; `mergeForm` menerima `form.references` (array objek `{ name, kind, path, repository, branch, description, hidden }`).

- [ ] **Step 1: Write the failing test**

```js
test('readOpenCodeConfig: references tampil sebagai path atau repository (string shorthand ikut)', () => {
  // tulis opencode.json: references { pustaka: { path: '~/lib', description: 'buku' }, web: 'owner/repo', lokal: './docs' }
  const view = readOpenCodeConfig({ scope: 'project', projectPath: dir });
  assert.deepEqual(view.references.map((r) => [r.name, r.kind]), [['lokal', 'path'], ['pustaka', 'path'], ['web', 'repository']]);
  assert.equal(view.references.find((r) => r.name === 'pustaka').description, 'buku');
});

test('mergeForm references: path/repo/branch, field asing dipertahankan, entri kosong membuang blok', () => {
  const base = { references: { pustaka: { path: '~/lib', extra: 1 } } };
  const merged = mergeForm(base, { references: [{ name: 'pustaka', kind: 'path', path: '~/lib2' }, { name: 'web', kind: 'repository', repository: 'owner/repo', branch: 'main', description: 'situs' }] });
  assert.equal(merged.references.pustaka.extra, 1);
  assert.equal(merged.references.pustaka.path, '~/lib2');
  assert.deepEqual(merged.references.web, { repository: 'owner/repo', branch: 'main', description: 'situs' });
  assert.equal(mergeForm(merged, { references: [] }).references, undefined);
});

test('mergeForm references menolak alias tak sah, file:, branch ../.. tanpa menulis', () => {
  for (const item of [
    { name: 'a/b', kind: 'path', path: '~/x' },
    { name: 'a b', kind: 'path', path: '~/x' },
    { name: '', kind: 'path', path: '~/x' },
    { name: 'x', kind: 'repository', repository: 'file:../repo' },
    { name: 'x', kind: 'repository', repository: 'owner/repo', branch: '../main' },
    { name: 'x', kind: 'repository', repository: 'owner/repo', branch: '-main' },
    { name: '__proto__', kind: 'path', path: '~/x' },
  ]) assert.throws(() => mergeForm({}, { references: [item] }), (err) => err.status === 400, JSON.stringify(item));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/opencode-config.test.mjs`
Expected: FAIL — `view.references` undefined / `mergeForm` mengabaikan `references`.

- [ ] **Step 3: Implement references**

- `OPENCODE_CONFIG_LIMITS`: add `references: 50`, `referenceName: 64`.
- `referencesView(config)`: iterate `config.references`; a string entry starting with `.`, `/`, `~` is a local path, any other bare string is a Git repository; objects use `path`/`repository` (path wins if both), keep `branch`, `description`, `hidden` only with the right type; sort by name.
- `readOpenCodeConfig`: return `references: referencesView(config)`.
- `mergeForm`: after agents, `if (form.references !== undefined) { ... }`: array ≤ 50; `config.references` must be a plain object or absent; per item validate name (1–64 characters, none of spasi `/` `\` backtick koma atau karakter kontrol; reject `FORBIDDEN_KEYS`), duplicate, `kind` (`path`|`repository`), preserve the old entry's unknown fields, write exactly one of `path`/`repository` (delete the other plus `branch` for `path`), validate `branch` (`/^[A-Za-z0-9/_.-]+$/`, not starting `-`, no `..`), reject `repository` starting with `file:` (case-insensitive), `description` ≤ 500 (empty deletes), `hidden` boolean (`false` deletes); an item with every field empty is skipped; empty result deletes `config.references`; end with `validateObject(config)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/opencode-config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-config.js test/opencode-config.test.mjs
git commit -m "References OpenCode: tampilan, validasi alias/repo/cabang, simpan lewat form"
```

---

### Task 6: References di form editor

**Files:**
- Modify: `public/index.html` (`#oc-form-panel`, after `#oc-agent-list` line ~1403)
- Modify: `public/js/features/opencode-config.js` (`renderView` 130–146, `applyBusy` 235–246, `collectAgents` 308–323, `save` 325–339, `initOpenCodeConfig`)
- Test: `test/opencode-config-ui.test.mjs`

**Interfaces:**
- Consumes: `view.references` (Task 5), `form.references` (Task 5).
- Produces: `referenceRow()`, `renderReferences()`, `collectReferences()`, `+ Reference` (`#oc-reference-add`) dan `#oc-reference-list`.

- [ ] **Step 1: Write the failing test**

Tambahkan satu test di `describe` yang sudah ada (pakai helper `configPage`/`openConfigEditor`):

```js
test('references: tambah satu folder dan satu repo, simpan, lalu terbaca lagi', async () => {
  // buka editor (project), klik #oc-reference-add dua kali
  // baris 1: nama 'pustaka', jenis 'path', path '~/lib', deskripsi 'buku'
  // baris 2: nama 'web', jenis 'repository', repository 'owner/repo', branch 'main'
  // klik Simpan; tunggu file opencode.json memuat "pustaka" dan "owner/repo"
  // tutup + buka editor lagi: dua baris references tampil dengan nilai yang sama
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/opencode-config-ui.test.mjs`
Expected: FAIL — `#oc-reference-add` tidak ada.

- [ ] **Step 3: Implement UI**

Markup: heading `References` + tombol `+ Reference` (`#oc-reference-add`), `<div id="oc-reference-list" class="oc-agent-list">`, satu baris bantuan (folder lokal atau repo Git di luar project; `~/` untuk folder home; alias tanpa spasi/`/`).
JS: `referenceRow(ref)` memakai class `oc-agent`/`oc-agent-grid`/`oc-field`; field `data-ref="name|kind|path|repository|branch|description|hidden"`; jenis `path` menampilkan input path, jenis `repository` menampilkan repository + branch (toggle via `change`). `renderReferences(list)` dari `view.references`; `collectReferences()` membuang baris kosong; `applyBusy` juga men-disable `#oc-reference-add` dan tombol hapus; `save()` mengirim `body.form.references = collectReferences()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/opencode-config-ui.test.mjs`
Expected: PASS (atau skip bila CDP tidak tersedia).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/features/opencode-config.js test/opencode-config-ui.test.mjs
git commit -m "References OpenCode: bagian di form editor (folder lokal dan repo Git)"
```

---

### Task 7: Dokumentasi + rilis

**Files:**
- Modify: `docs/design-opencode.md` (Catatan upstream), `CHANGELOG.md`, `docs/FITUR.md`, `docs/uji-ui.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Catatan upstream**

Tambahkan dua baris di tabel "Catatan upstream" `docs/design-opencode.md`:
- `2026-11-22 | 2.3.2 | references: peta alias → { path } atau { repository, branch?, description?, hidden? }; alias tanpa / \ spasi backtick koma; repo file: tidak didukung; checkout per remote+branch di data dir. Form editor kini membaca/menulis blok ini. | https://opencode.ai/docs/references + docs/migrate-v1 (reference → references) + opencode --version 2.3.2`
- `2026-11-22 | Claude Code 2.1.328 | --add-dir <directories...> menambah folder yang boleh diakses proses; aplikasi meneruskannya dari settings.additionalDirectories per project (satu flag, beberapa path). | claude --help di mesin ini`

- [ ] **Step 2: CHANGELOG**

Tambahkan `## Belum dirilis` di atas `## 1.0.87`, satu paragraf tebal per fitur: **📂 Folder tambahan (Claude)**, **🔗 References OpenCode**. Sebut batas: laptop-only, maksimal 10 folder, path jaringan ditolak, berlaku pada pesan berikutnya; references maksimal 50, alias/`file:`/branch divalidasi, backup seperti simpan config lain.

- [ ] **Step 3: FITUR**

- Tabel Chat & izin: baris `| **📂 Folder tambahan** (menu ⋯) | Claude boleh membaca/menulis folder di luar project... |`.
- Bagian OpenCode: perluas bullet **📚 Config & Agent OpenCode** dengan bagian References (alias, folder lokal `~/`, repo Git + branch, deskripsi, sembunyikan; validasi; maksimal 50).
- `docs/uji-ui.md`: tambahkan `| UI Folder tambahan (file sendiri) | \`node --test test/add-dirs-ui.test.mjs\`; ubah di dialog ⋯ |` mengikuti format catatan file terpisah.

- [ ] **Step 4: Gerbang lengkap**

```bash
npm run check
npm run test:related -- src/add-dirs.js src/session.js src/hub.js src/routes/add-dirs.js server.js src/opencode-config.js public/js/features/add-dirs.js public/js/features/opencode-config.js
node --test test/add-dirs-ui.test.mjs
node --test test/opencode-config-ui.test.mjs
npm run test:smoke
```
Expected: semua hijau (skip CDP/Windows-known tetap skip; kegagalan pra-ada yang sudah tercatat tidak dihitung).

- [ ] **Step 5: Rilis 1.0.88**

```bash
# package.json + package-lock.json: version 1.0.88
# CHANGELOG.md: "## Belum dirilis" -> "## 1.0.88"
git add -A
git commit -m "Rilis 1.0.88: folder tambahan Claude + references OpenCode"
git tag v1.0.88
git push origin main
git push origin v1.0.88
```
Lalu pantau `.github/workflows/release.yml` (`gh run list --limit 3`) sampai GitHub Release `v1.0.88` terbentuk.

---

## Self-Review

**Spec coverage:** Fase 3 punya dua butir: `additionalDirectories` per project (Task 1–4) dan OpenCode References di editor config (Task 5–6). Definisi selesai fase (test gagal-dulu, check, related, smoke, UI, CHANGELOG/FITUR, catatan upstream, kebijakan laptop-only, backup config) ada di Task 7. Edge case path absolut/UNC/jaringan ditutup Task 1 dan Review Focus 1.
**Type consistency:** nama `additionalDirectories`, `addDirectory/removeDirectory/addDirViews/cleanAddDirs`, `references`, `form.references`, `#oc-reference-*`, `#dirs-*` dipakai sama di semua task.
**Proportion:** plan memuat signature, nama test, dan nilai yang dipatok; body implementasi tetap ditulis saat eksekusi.
