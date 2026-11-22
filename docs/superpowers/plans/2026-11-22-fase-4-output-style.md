# Fase 4 — Output Style Claude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kelola **output style** Claude Code dari Adhitron — pilih gaya bawaan/kustom, buat/edit/hapus gaya kustom — tanpa terminal, plus pastikan `/skills` sudah menampilkan daftar skill kedua mesin.

**Architecture:** Modul murni `src/output-styles.js` memegang aturan (daftar gaya, frontmatter, path, validasi, baca/tulis file gaya, baca/tulis `outputStyle` di `settings.local.json`) dengan pola containment + backup seperti `src/skills.js`. Route `src/routes/output-styles.js` menyajikan baca/pilih/simpan/hapus, lalu memanggil `session.reloadSettings()` (pola route izin) agar proses Claude yang idle memakai gaya baru pada pesan berikutnya. UI adalah dialog mandiri `#output-style-modal` dari menu ⋯ / sheet HP / perintah `/output-style`.

**Tech Stack:** Node ≥ 20 ESM, `node:test` + `node:assert/strict`, UI statis `public/` (tanpa framework), ESLint via `npm exec`.

**Spec:** `docs/superpowers/specs/2026-11-22-adopsi-tuntas-mesin-design.md` (Fase 4, baris 108–110)

## Global Constraints

- Teks UI **Bahasa Indonesia**; komentar kode **Bahasa Inggris**. Jangan memakai kata "mesin" di string UI.
- Claude Code terpasang: **2.1.328**. `/output-style` berjalan non-interaktif (docs: ≥ 2.1.269); `Concise` ≥ 2.1.237.
- Gaya bawaan bersifat case-sensitive: `default`, `Proactive`, `Concise`, `Explanatory`, `Learning`. Nilai yang tidak cocok persis = Default.
- File gaya kustom: `Markdown` dengan frontmatter `name`, `description`, `keep-coding-instructions`; lokasi project `<project>/.claude/output-styles/<slug>.md`, user `<CLAUDE_CONFIG_DIR atau ~/.claude>/output-styles/<slug>.md`.
- Pilihan disimpan sebagai `outputStyle` di `<project>/.claude/settings.local.json`. Kunci lain di file itu **tidak boleh** berubah; file yang bukan JSON valid tidak pernah ditimpa; symlink/junction ditolak.
- Tulis gaya **project** boleh dari laptop atau Tailscale; tulis gaya **user** dan baca daftar hanya dari laptop/Tailscale (bukan WiFi biasa), mengikuti `src/routes/skills.js`.
- Setiap tulis/hapus gaya kustom menyimpan salinan lama di `<dataDir>/output-style-backups/`; maksimal 20 salinan per file. Proses yang sedang menjalankan giliran menolak perubahan (409).
- Perubahan pilihan berlaku pada **pesan berikutnya** (proses idle ditutup lewat `reloadSettings()`, yang menunda bila masih ada tugas latar).
- `/skills` sudah selesai di Fase 2 (`openSkills()` + `LOCAL_COMMANDS`); Fase 4 hanya memverifikasi dan mendokumentasikannya, tanpa kode baru.

## Review Focus

1. **Nilai `outputStyle` peka huruf besar/kecil.** `concise` bukan `Concise`; Claude memakai Default, jadi dialog harus menampilkan default + nilai tak dikenal, bukan diam-diam mengklaim Concise aktif.
2. **`settings.local.json` berisi kunci lain / JSON rusak / symlink.** Simpan pilihan hanya boleh mengubah `outputStyle`; file rusak ditolak 409 tanpa ditulis, symlink ditolak.
3. **File gaya kustom rusak atau bentrok nama.** Frontmatter tak terbaca tidak boleh membuat seluruh daftar gagal; nama ganda project–user memakai project; menyimpan nama yang sudah dipakai file lain ditolak 409.
4. **Menulis saat giliran berjalan atau dari HP WiFi.** Pilih/simpan/hapus harus 409 saat giliran berjalan; gaya user hanya dari laptop; baca daftar ditolak untuk WiFi biasa.
5. **Gaya yang sedang dipakai dihapus/diganti nama.** Pilihan lokal tidak boleh tertinggal menunjuk nama yang hilang; hapus/ganti nama saat gaya itu aktif ditolak dengan pesan yang jelas.

---

## File Structure

- Create: `src/output-styles.js` — aturan + IO gaya dan setelan (satu tanggung jawab).
- Create: `src/routes/output-styles.js` — HTTP + gating + reload sesi.
- Create: `public/js/features/output-styles.js` — dialog dan form.
- Modify: `src/routes/index.js` (registrasi), `public/index.html` (menu, sheet, modal), `public/js/features/more-menu.js`, `public/js/app.js` (init), `public/js/features/commands.js` (`/output-style`, hapus dari `CLI_ONLY`).
- Test: `test/output-styles.test.mjs`, `test/output-styles-route.test.mjs`, `test/output-styles-ui.test.mjs`.
- Docs: `CHANGELOG.md`, `docs/FITUR.md`, `docs/design-opencode.md`, `docs/uji-ui.md`.

---

### Task 1: Membaca gaya (bawaan + kustom) dan pilihan yang berlaku

**Files:**
- Create: `src/output-styles.js`
- Test: `test/output-styles.test.mjs`

**Interfaces:**
- Consumes: `settingsFile` dari `src/permissions.js`; `node:fs`, `node:os`, `node:path`.
- Produces:
  - `BUILTIN_STYLES: ReadonlyArray<{ name: string, description: string }>`
  - `OUTPUT_STYLE_LIMITS = { bytes: 65536, name: 60, description: 300, slug: 60 }`
  - `class OutputStyleError extends Error { status: number }`
  - `styleRoots({ projectPath, userDir }) -> Array<{ scope: 'project'|'user', dir: string }>`
  - `parseStyleFile(text) -> { name: string, description: string, keepCodingInstructions: boolean, body: string }` (frontmatter rusak: nama kosong, body = seluruh teks)
  - `listOutputStyles({ projectPath, userDir }) -> Array<{ name, slug, description, keepCodingInstructions, scope, builtin, file? }>`
  - `currentOutputStyle({ projectPath, userDir }) -> { name, source: 'local'|'project'|'user'|'default', unknown: string|null }`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUILTIN_STYLES, currentOutputStyle, listOutputStyles, parseStyleFile } from '../src/output-styles.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const write = (f, text) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };

test('parseStyleFile: frontmatter name/description/keep-coding-instructions, body terpisah', () => {
  const parsed = parseStyleFile('---\nname: "Diagrams first"\ndescription: "Mulai dengan diagram"\nkeep-coding-instructions: true\n---\n\nPakai diagram.\n');
  assert.deepEqual(parsed, { name: 'Diagrams first', description: 'Mulai dengan diagram', keepCodingInstructions: true, body: 'Pakai diagram.\n' });
  const broken = parseStyleFile('tanpa frontmatter');
  assert.equal(broken.name, '');
  assert.equal(broken.body, 'tanpa frontmatter');
});

test('listOutputStyles: bawaan selalu ada, file .md project/user terbaca, project menang atas user', () => {
  const project = tmp('os-p-'); const userDir = tmp('os-u-');
  write(path.join(project, '.claude', 'output-styles', 'ringkas.md'), '---\nname: "Ringkas"\ndescription: "Pendek"\n---\n\nx\n');
  write(path.join(project, '.claude', 'output-styles', 'rusak.md'), 'tanpa frontmatter\n');
  write(path.join(userDir, 'output-styles', 'ringkas.md'), '---\nname: "Ringkas"\ndescription: "versi user"\n---\n\ny\n');
  write(path.join(userDir, 'output-styles', 'catatan.txt'), 'bukan gaya');
  const styles = listOutputStyles({ projectPath: project, userDir });
  assert.deepEqual(styles.filter((s) => s.builtin).map((s) => s.name), ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']);
  const ringkas = styles.filter((s) => s.name === 'Ringkas');
  assert.equal(ringkas.length, 1);
  assert.equal(ringkas[0].scope, 'project');
  assert.equal(ringkas[0].description, 'Pendek');
  assert.ok(styles.some((s) => s.name === 'rusak' && s.scope === 'project'), 'nama fallback = nama file');
  assert.ok(!styles.some((s) => s.name === 'catatan'), 'hanya .md');
});

test('currentOutputStyle: local > project > user, nilai tak dikenal dilaporkan (case-sensitive)', () => {
  const project = tmp('os-c-'); const userDir = tmp('os-cu-');
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'default', source: 'default', unknown: null });
  write(path.join(userDir, 'settings.json'), JSON.stringify({ outputStyle: 'Explanatory' }));
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'Explanatory', source: 'user', unknown: null });
  write(path.join(project, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'Concise' }));
  assert.equal(currentOutputStyle({ projectPath: project, userDir }).name, 'Concise');
  write(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ outputStyle: 'concise' }));
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'default', source: 'local', unknown: 'concise' });
  write(path.join(project, '.claude', 'settings.local.json'), '{rusak');
  assert.throws(() => currentOutputStyle({ projectPath: project, userDir }), (e) => e.status === 409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/output-styles.test.mjs`
Expected: FAIL — `Cannot find module '../src/output-styles.js'`.

- [ ] **Step 3: Implement `src/output-styles.js`**

Tulis konstanta dan fungsi di atas. Detail yang dipatok:
- `BUILTIN_STYLES` deskripsi (teks UI, bukan "mesin"): `default: 'Bawaan Claude Code'`, `Proactive: 'Langsung mengerjakan, sedikit bertanya'`, `Concise: 'Jawaban singkat, langsung ke hasil'`, `Explanatory: 'Menjelaskan alasan di balik perubahan'`, `Learning: 'Menjelaskan sambil meminta kamu menulis sebagian kode'`.
- `styleRoots` mengembalikan `[{scope:'project', dir: path.join(projectPath, '.claude', 'output-styles')}, {scope:'user', dir: path.join(userDir, 'output-styles')}]`.
- `userDir` default `userConfigDir()` dari `src/permissions.js`.
- Baca settings per scope memakai `settingsFile(projectPath, scope, userDir)`; `JSON.parse` teks tanpa BOM; nilai `outputStyle` non-string = `unknown` (bukan crash).
- `listOutputStyles`: dedupe per nama persis (case-sensitive), project dulu; file yang `lstat`-nya symlink dilewati; kegagalan baca satu file dilewati (jangan menggagalkan daftar).
- Slug = `name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)`; nama tampil = `frontmatter.name || basename(file,'.md')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/output-styles.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/output-styles.js test/output-styles.test.mjs
git commit -m "Output style: daftar gaya bawaan/kustom dan pilihan yang berlaku"
```

---

### Task 2: Menyimpan dan menghapus file gaya kustom (backup + containment)

**Files:**
- Modify: `src/output-styles.js`
- Test: `test/output-styles.test.mjs`

**Interfaces:**
- Produces:
  - `readStyle({ projectPath, userDir, scope, slug }) -> { name, slug, description, keepCodingInstructions, body, scope, mtime }`
  - `saveStyle({ projectPath, userDir, dataDir, scope, slug?, name, description, keepCodingInstructions, body, mtime? }) -> { style, backedUp }`
  - `deleteStyle({ projectPath, userDir, dataDir, scope, slug, mtime? }) -> { backedUp }`
  - `outputStyleBackupRoot(dataDir) -> string`

- [ ] **Step 1: Write the failing test**

Tambahan impor di `test/output-styles.test.mjs`: `existsSync, readFileSync, symlinkSync` dari `node:fs` dan `OutputStyleError` dari modul.

```js
test('saveStyle: membuat file berfrontmatter, menimpa dengan backup, dan menolak nama tak sah', () => {
  const project = tmp('os-s-'); const userDir = tmp('os-su-'); const dataDir = tmp('os-sd-');
  const saved = saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Diagrams first', description: 'Mulai diagram', keepCodingInstructions: true, body: 'Pakai diagram.\n' });
  const file = path.join(project, '.claude', 'output-styles', 'diagrams-first.md');
  assert.equal(saved.style.name, 'Diagrams first');
  assert.equal(saved.backedUp, null);
  assert.match(readFileSync(file, 'utf8'), /^---\nname: "Diagrams first"\ndescription: "Mulai diagram"\nkeep-coding-instructions: true\n---\n\nPakai diagram\.\n$/m);
  const back = readStyle({ projectPath: project, userDir, scope: 'project', slug: 'diagrams-first' });
  assert.equal(back.name, 'Diagrams first');
  assert.equal(back.body, 'Pakai diagram.\n');
  assert.equal(back.keepCodingInstructions, true);
  const again = saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', slug: 'diagrams-first', name: 'Diagrams first', description: '', keepCodingInstructions: false, body: 'Versi dua.\n', mtime: readStyle({ projectPath: project, userDir, scope: 'project', slug: 'diagrams-first' }).mtime });
  assert.ok(again.backedUp, 'salinan lama dibuat');
  for (const bad of ['', 'a/b', 'a\\b', 'x'.repeat(61), 'Concise', 'default']) {
    assert.throws(() => saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: bad, description: '', keepCodingInstructions: false, body: 'x' }), (e) => e instanceof OutputStyleError && e.status === 400, bad);
  }
  assert.throws(() => saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Nama baru', description: '', keepCodingInstructions: false, body: 'x'.repeat(70_000) }), (e) => e.status === 413);
  // Nama yang sama dengan file lain di scope yang sama ditolak.
  assert.throws(() => saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Diagrams first', description: '', keepCodingInstructions: false, body: 'y' }), (e) => e.status === 409);
});

test('deleteStyle: menghapus file dengan backup; file di luar scope tidak tersentuh lewat symlink', (t) => {
  const project = tmp('os-d-'); const userDir = tmp('os-du-'); const dataDir = tmp('os-dd-');
  saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Hapus aku', description: '', keepCodingInstructions: false, body: 'x\n' });
  const removed = deleteStyle({ projectPath: project, userDir, dataDir, scope: 'project', slug: 'hapus-aku' });
  assert.ok(removed.backedUp);
  assert.equal(existsSync(path.join(project, '.claude', 'output-styles', 'hapus-aku.md')), false);
  const outside = tmp('os-out-');
  write(path.join(outside, 'victim.md'), 'jangan dihapus');
  mkdirSync(path.join(project, '.claude'), { recursive: true });
  try {
    symlinkSync(outside, path.join(project, '.claude', 'output-styles'), 'junction');
  } catch {
    return t.skip('no privilege for symlinks here');
  }
  if (!existsSync(path.join(project, '.claude', 'output-styles', 'victim.md'))) return t.skip('junction is not readable in this environment');
  assert.throws(() => deleteStyle({ projectPath: project, userDir, dataDir, scope: 'project', slug: 'victim' }), (e) => e.status === 409);
  assert.ok(existsSync(path.join(outside, 'victim.md')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/output-styles.test.mjs`
Expected: FAIL — `saveStyle is not a function` (atau impor gagal).

- [ ] **Step 3: Implement `saveStyle`, `deleteStyle`, `readStyle`**

Detail yang dipatok:
- Validasi nama: trim, 1–60 karakter, tanpa `/ \ : * ? " < > |` dan tanpa baris baru; tidak boleh sama (case-insensitive) dengan nama bawaan; slug bentrok di scope yang sama → 409.
- `body` maksimal 64 KB; `description` satu baris maksimal 300 karakter.
- Frontmatter selalu ditulis dengan urutan `name`, `description` (hanya bila ada), `keep-coding-instructions: true` (hanya bila true); nilai string memakai `JSON.stringify` (YAML-valid); akhir file satu newline.
- Sebelum menimpa/menghapus, salin file lama ke `outputStyleBackupRoot(dataDir)` sebagai `<scope>-<slug>-<ISO timestamp tanpa :>.<ext>`; simpan maksimal 20 per slug (yang tertua dipangkas).
- Containment: `realpathSync` root yang ada (atau parent terdekat), tolak root/file symlink atau junction → 409; nama file selalu `<slug>.md` (slug divalidasi `^[a-z0-9][a-z0-9-]{0,59}$`).
- `mtime` (angka dari `stat.mtimeMs`) bila dikirim dan tidak sama dengan file sekarang → 409 "berubah di tempat lain"; untuk file baru, `mtime` harus `undefined`/`null`.
- Tulis file atomik: temp file di folder yang sama lalu `renameSync`.
- `readStyle` untuk slug yang tidak ada → 404.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/output-styles.test.mjs`
Expected: PASS (5 tests; 1 skip bila lingkungan tidak mendukung junction).

- [ ] **Step 5: Commit**

```bash
git add src/output-styles.js test/output-styles.test.mjs
git commit -m "Output style: simpan/hapus gaya kustom dengan backup dan penjagaan folder"
```

---

### Task 3: Menyimpan pilihan ke `settings.local.json`

**Files:**
- Modify: `src/output-styles.js`
- Test: `test/output-styles.test.mjs`

**Interfaces:**
- Produces: `saveSelection({ projectPath, userDir, name }) -> { name, file }` — `name` `'default'` menghapus kunci; nama lain ditulis apa adanya (sudah divalidasi pemanggil terhadap daftar gaya).

- [ ] **Step 1: Write the failing test**

```js
test('saveSelection: hanya mengubah outputStyle, mempertahankan kunci/indentasi, dan default menghapus kunci', () => {
  const project = tmp('os-sel-'); const userDir = tmp('os-selu-');
  const file = path.join(project, '.claude', 'settings.local.json');
  write(file, '{\n  "permissions": { "allow": ["Read"] },\n  "outputStyle": "Concise"\n}\n');
  const result = saveSelection({ projectPath: project, userDir, name: 'Explanatory' });
  assert.equal(result.file, file);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(data, { permissions: { allow: ['Read'] }, outputStyle: 'Explanatory' });
  assert.match(readFileSync(file, 'utf8'), /^\{\n {2}"permissions"/, 'indentasi 2 spasi dipertahankan');
  saveSelection({ projectPath: project, userDir, name: 'default' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ['Read'] } });
  write(file, '{rusak');
  assert.throws(() => saveSelection({ projectPath: project, userDir, name: 'Concise' }), (e) => e.status === 409);
  assert.equal(readFileSync(file, 'utf8'), '{rusak', 'file rusak tidak ditimpa');
  const fresh = tmp('os-self-');
  saveSelection({ projectPath: fresh, userDir, name: 'Concise' });
  assert.deepEqual(JSON.parse(readFileSync(path.join(fresh, '.claude', 'settings.local.json'), 'utf8')), { outputStyle: 'Concise' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/output-styles.test.mjs`
Expected: FAIL — `saveSelection is not a function`.

- [ ] **Step 3: Implement `saveSelection`**

Detail:
- File selalu `settingsFile(projectPath, 'local', userDir)`.
- Baca memakai aturan yang sama dengan `currentOutputStyle` (BOM boleh, JSON valid objek); file tidak ada → objek baru; symlink → 409.
- `name === 'default'` → `delete data.outputStyle`; selain itu `data.outputStyle = name` (string non-kosong).
- Tulis atomik dengan indentasi terdeteksi (`/^[{[]\r?\n([ \t]+)/`), akhiri newline; `mkdir -p` folder `.claude`.
- Kunci lain dipertahankan apa adanya (urutan tidak dijamin, nilai sama).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/output-styles.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/output-styles.js test/output-styles.test.mjs
git commit -m "Output style: pilihan disimpan ke settings.local.json tanpa menyentuh kunci lain"
```

---

### Task 4: Route baca/pilih/simpan/hapus + reload sesi

**Files:**
- Create: `src/routes/output-styles.js`
- Modify: `src/routes/index.js`
- Test: `test/output-styles-route.test.mjs`

**Interfaces:**
- Consumes: semua ekspor `src/output-styles.js`; `claudeOnly`, `withProject`; `appliedOf`, `json`; `ctx.isLocal(req)`, `ctx.isReadOnly(req)`, `ctx.hub.dataDir`, `ctx.sessions.get(project)`.
- Produces route (`register(router)`):
  - `POST /api/projects/:id/output-styles` → `{ styles, current }`
  - `POST /api/projects/:id/output-styles/select` body `{ name }` → `{ current, applied }`
  - `POST /api/projects/:id/output-styles/save` body `{ scope, slug?, name, description, keepCodingInstructions, body, mtime? }` → `{ style, backedUp, current, applied }`
  - `POST /api/projects/:id/output-styles/delete` body `{ scope, slug, mtime? }` → `{ backedUp, current, applied }`
- Errors: `OutputStyleError.status` diteruskan; error lain dilempar ulang.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

const mkCtx = ({ local = true, readOnly = false, reload = () => 'restarted' } = {}) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'osr-data-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'osr-proj-'));
  const hub = new Hub({ dataDir });
  const project = hub.upsertProject(dir, 'custom');
  const session = { reloadSettings: reload, turnActive: () => false };
  const sessions = { sessions: new Map([[project.id, session]]) };
  return { ctx: { hub, sessions, isLocal: () => local, isReadOnly: () => readOnly, dataDir }, project, dir, session };
};
let router;
const call = async (ctx, pattern, body = {}) => {
  const route = router.routes.find((r) => r.pattern === pattern);
  assert.ok(route, pattern);
  let status = 0;
  let text = '';
  const res = { writeHead: (s) => (status = s), end: (t) => (text = t ?? '') };
  await route.handler(ctx, { local: true, headers: {} }, res, { id: ctx.hub.projects.keys().next().value }, body);
  return { status, body: text ? JSON.parse(text) : null };
};

test('route output style: baca, pilih, simpan kustom; gating laptop/Tailscale dan 409 saat giliran berjalan', async () => {
  router = buildRouter();
  const { ctx, dir, session } = mkCtx();
  let reloads = 0;
  session.reloadSettings = () => { reloads += 1; return 'restarted'; };
  const read = await call(ctx, '/api/projects/:id/output-styles');
  assert.equal(read.status, 200);
  assert.equal(read.body.current.name, 'default');
  assert.equal(read.body.styles.filter((s) => s.builtin).length, 5);

  const sel = await call(ctx, '/api/projects/:id/output-styles/select', { name: 'Concise' });
  assert.equal(sel.status, 200);
  assert.equal(sel.body.applied, 'restarted');
  assert.equal(reloads, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).outputStyle, 'Concise');

  const saved = await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Diagram dulu', description: '', keepCodingInstructions: false, body: 'x\n' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.style.slug, 'diagram-dulu');
  const bad = await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'a/b', description: '', keepCodingInstructions: false, body: 'x' });
  assert.equal(bad.status, 400);

  // HP WiFi biasa: baca ditolak; gaya user hanya dari laptop.
  assert.equal((await call(mkCtx({ readOnly: true }).ctx, '/api/projects/:id/output-styles')).status, 403);
  const tail = mkCtx({ local: false });
  assert.equal((await call(tail.ctx, '/api/projects/:id/output-styles/save', { scope: 'user', name: 'Global', description: '', keepCodingInstructions: false, body: 'x' })).status, 403);
  assert.equal((await call(tail.ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Dari HP', description: '', keepCodingInstructions: false, body: 'x' })).status, 200);

  // Giliran berjalan: pilih/simpan ditolak.
  session.turnActive = () => true;
  assert.equal((await call(ctx, '/api/projects/:id/output-styles/select', { name: 'Concise' })).status, 409);
  assert.equal((await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Dua', description: '', keepCodingInstructions: false, body: 'x' })).status, 409);
});

test('route output style: hapus gaya yang sedang dipakai ditolak 409', async () => {
  router = buildRouter();
  const { ctx } = mkCtx();
  await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Aktif', description: '', keepCodingInstructions: false, body: 'x' });
  await call(ctx, '/api/projects/:id/output-styles/select', { name: 'Aktif' });
  const del = await call(ctx, '/api/projects/:id/output-styles/delete', { scope: 'project', slug: 'aktif' });
  assert.equal(del.status, 409);
  assert.match(del.body.error, /Ganti|aktif/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/output-styles-route.test.mjs`
Expected: FAIL — route belum terdaftar (`route(...)` undefined).

- [ ] **Step 3: Implement `src/routes/output-styles.js` dan registrasi**

Detail:
- `withClaudeProject = withProject(claudeOnly(fn, 'Output style'))`.
- Baca: `if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: 'Output style hanya bisa dibuka dari laptop atau lewat Tailscale.' });`
- `select`: validasi `name` cocok persis dengan salah satu `listOutputStyles().name` atau `'default'` → 404/400; `turnActive()` → 409 `{ error: 'Tidak bisa mengganti output style saat masih ada giliran yang berjalan.', code: 'busy' }`; panggil `saveSelection`, lalu `applied = appliedOf([ctx.sessions.get(project).reloadSettings()])`, `hub.chat` info.
- `save`: `scope = body.scope === 'user' ? 'user' : 'project'`; scope user + `!ctx.isLocal(req)` → 403; busy → 409; cek nama yang diedit sedang dipakai (`currentOutputStyle().name`) dan nama berubah, atau `delete` slug yang sedang dipakai → 409 pesan "Ganti dulu...". Simpan lalu `reloadSettings()`.
- `delete`: scope user laptop-only, busy 409, dipakai → 409; `deleteStyle`, reload.
- Semua error `OutputStyleError` → `json(res, err.status, { error: err.message })`.
- Daftarkan di `src/routes/index.js` setelah `skills`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/output-styles-route.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/output-styles.js src/routes/index.js test/output-styles-route.test.mjs
git commit -m "Output style: route baca/pilih/simpan/hapus dengan gerbang laptop dan giliran"
```

---

### Task 5: Dialog Output style + menu + perintah `/output-style`

**Files:**
- Create: `public/js/features/output-styles.js`
- Modify: `public/index.html` (item menu setelah `data-more="dirs"` ~baris 157, sheet HP ~baris 1819, modal setelah `#skills-modal` ~baris 556), `public/js/features/more-menu.js`, `public/js/app.js`, `public/js/features/commands.js`
- Test: `test/output-styles-ui.test.mjs`

**Interfaces:**
- Consumes: `api`, `toast`, `$`, `escapeHtml`, `state`, `openModal`, route Task 4.
- Produces: `openOutputStyle(): Promise<void>` (ekspor dari `public/js/features/output-styles.js`), dipakai `commands.js`.
- Markup id: `#output-style-modal`, `#os-list`, `#os-form`, `#os-name`, `#os-description`, `#os-keep`, `#os-body`, `#os-error`, `#os-new`, `#os-save`, `#os-cancel`, `#os-close`; atribut baris `data-os-use`, `data-os-edit`, `data-os-delete`, `data-os-name`, `data-os-scope`, `data-os-slug`.

- [ ] **Step 1: Write the failing test**

Buat `test/output-styles-ui.test.mjs` dengan harness yang sama seperti `test/opencode-config-ui.test.mjs` (server + fake `/api/projects/:id/output-styles*` lewat `page.route`/server palsu; lihat polanya). Test:

```js
test('dialog output style: daftar bawaan + aktif, pilih mengirim select, buat/edit/hapus kustom, dan tinggi gaya baru tersimpan', async () => {
  // ...buka halaman, buka dialog dari menu ⋯ → Output style (atau perintah /output-style)
  // 1) baris bawaan 5 + "Diagram dulu" (kustom) terlihat; yang aktif berbadge "aktif"
  // 2) klik [data-os-use="Concise"] → POST /select { name: 'Concise' }; badge aktif pindah
  // 3) #os-new → isi nama/deskripsi/body → #os-save → POST /save { scope: 'project', name: 'Diagram dulu', ... }
  // 4) klik [data-os-edit="diagram-dulu"] → form terisi → ubah body → simpan → POST /save dengan slug + mtime
  // 5) klik [data-os-delete="diagram-dulu"] → confirm → POST /delete { scope:'project', slug, mtime }
  // 6) buka ulang dialog: daftar dari server (termasuk gaya baru) tampil
  // 7) /output-style Concise di kotak chat memanggil select tanpa membuka modal
  // 8) ukuran mobile 390x844 dan desktop 1440x900: tidak ada overflow horizontal/modal; tanpa error konsol
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/output-styles-ui.test.mjs`
Expected: FAIL — `#output-style-modal` tidak ada.

- [ ] **Step 3: Implement UI**

Detail:
- Modal memakai kelas yang sudah ada: `modal`, `modal-card ext-card`, `modal-head`, `ext-body`, `oc-agent`, `oc-agent-head`, `pill`, `backup-actions`, `field-error`, `muted small`. Jangan menambah kelas ber-hyphen baru tanpa aturan CSS (test CSS coverage).
- `renderList`: baris per gaya; urutkan `default` dulu, lalu bawaan, lalu kustom project, lalu user; badge `aktif`, `bawaan`, `project`/`semua project`; tombol **Pakai**, **Edit**/**Hapus** hanya untuk kustom.
- Form: `#os-form hidden`; `#os-new` membersihkan form dan menampilkan; `#os-edit` mengisi; simpan mengirim `scope`, `slug` (bila edit), `name`, `description`, `keepCodingInstructions`, `body`, `mtime` (bila edit); sukses → kembali ke daftar + reload + toast.
- Hapus memakai `window.confirm` menyebut nama gaya; 409 dari server ditampilkan di `#os-error` (mis. gaya aktif).
- Menu: `data-more="style" data-cap="permissions"` dengan teks `🎭 Output style…`; sheet HP `data-proxy="[data-more='style']" data-mutates data-cap="permissions"`. Daftarkan di `more-menu.js` → `openOutputStyle()`; init di `app.js`.
- `commands.js`: tambahkan `{ name: 'output-style', argumentHint: '[nama]', description: '🎭 Ganti output style Claude (bawaan atau kustom)' }`; hapus `'output-style'` dari `CLI_ONLY`; di `localCommand`: tanpa argumen → `openOutputStyle()`; dengan argumen → `POST select` dengan nama yang cocok tanpa beda huruf besar/kecil dari daftar (bila tidak ada, toast daftar nama); bila `projectEngine() !== 'claude'` → toast `Output style hanya untuk Claude Code.` dan `return true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/output-styles-ui.test.mjs`
Expected: PASS (1 test, 2 viewport).

- [ ] **Step 5: Commit**

```bash
git add public/js/features/output-styles.js public/index.html public/js/features/more-menu.js public/js/app.js public/js/features/commands.js test/output-styles-ui.test.mjs
git commit -m "Output style: dialog pilih/buat/edit/hapus dari menu dan /output-style"
```

---

### Task 6: Dokumentasi, gerbang lengkap, rilis 1.0.90

**Files:**
- Modify: `docs/design-opencode.md` (Catatan upstream), `CHANGELOG.md`, `docs/FITUR.md`, `docs/uji-ui.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Catatan upstream**

Tambahkan satu baris di tabel **Catatan upstream** `docs/design-opencode.md`:
`| 2026-11-22 | Claude Code 2.1.328 | /output-style berjalan non-interaktif (docs ≥ 2.1.269) dan menulis {"outputStyle":"<Nama>"} ke .claude/settings.local.json; gaya kustom = .claude/output-styles/*.md dengan frontmatter name/description/keep-coding-instructions; nilai case-sensitive, nilai salah = Default. Probe stream-json: perintah dijawab local_command "output_style" tanpa biaya token. Aplikasi menulis kunci outputStyle di file yang sama lalu reloadSettings(); tidak memakai /output-style agar jalur file tetap satu. | https://code.claude.com/docs/en/output-styles + probe di mesin ini |`

- [ ] **Step 2: CHANGELOG**

Tambahkan `## Belum dirilis` dengan satu paragraf tebal:
**🎭 Output style Claude** — pilih `default`/Proactive/Concise/Explanatory/Learning atau gaya kustom dari dialog (menu ⋯, sheet HP, `/output-style`); buat/edit/hapus `*.md` di `.claude/output-styles` (project) atau `~/.claude/output-styles` (semua project), dengan backup dan validasi; pilihan ditulis ke `settings.local.json` tanpa mengubah kunci lain, berlaku pada pesan berikutnya, dan gaya yang sedang aktif tidak bisa dihapus. Gaya user hanya dari laptop; project dari laptop/Tailscale; ditolak saat giliran berjalan.

- [ ] **Step 3: FITUR + uji-ui**

- `docs/FITUR.md` tabel Chat & izin: baris `| **🎭 Output style** (\`/output-style\`, menu ⋯) | ... |` (bawaan + kustom, backup, laptop/Tailscale, 409 saat giliran).
- Bagian Claude Code: perluas bullet yang menyebut aturan izin/config dengan kalimat output style.
- `docs/uji-ui.md`: sebut `test/output-styles-ui.test.mjs` di paragraf "Test UI di file terpisah".

- [ ] **Step 4: Gerbang lengkap**

```bash
npm run check
npm run test:related -- src/output-styles.js src/routes/output-styles.js public/js/features/output-styles.js public/js/features/commands.js
node --test test/output-styles.test.mjs
node --test test/output-styles-ui.test.mjs
# Windows: jalankan 12 file smoke satu per satu (runner test:smoke masih bug path)
npm run test:smoke   # di CI Linux
```
Expected: hijau; kegagalan pra-ada yang tercatat (`test/opencode.test.mjs:485`, flaky `opencode-background-real`) tidak dihitung.

- [ ] **Step 5: Rilis 1.0.90**

```bash
# package.json + package-lock.json: version 1.0.90
# CHANGELOG.md: "## Belum dirilis" -> "## 1.0.90"
git add -A
git commit -m "Rilis 1.0.90: output style Claude dari aplikasi"
git tag v1.0.90
git push origin main
git push origin v1.0.90
```
Lalu pantau `gh run list --limit 3` sampai GitHub Release `v1.0.90` terbentuk dan workflow `test` hijau.

---

## Self-Review

**Spec coverage:** Fase 4 butir "Output style Claude: pilih/buat dari aplikasi" → Task 1–5 + rilis Task 6; butir "`/skills` pada kedua mesin" → sudah ada di Fase 2, diverifikasi Task 6 dan dicatat di FITUR (tidak ada kode baru). Nilai yang dipatok (case-sensitive, 5 gaya bawaan, path file, key `outputStyle`) diambil dari docs resmi + probe.
**Type consistency:** `OutputStyleError.status`, `styleRoots`, `listOutputStyles`, `currentOutputStyle`, `readStyle`, `saveStyle`, `deleteStyle`, `saveSelection` dipakai konsisten di route/UI; id modal `#os-*` dan atribut `data-os-*` sama antara markup, fitur, dan test.
**Proportion:** plan memuat signature, nama test, dan nilai yang dipatok; body implementasi tetap ditulis saat eksekusi.
**Review Focus:** lima butir di atas masing-masing punya test di Task 1 (case-sensitive), Task 3 (file settings), Task 2 (nama ganda/frontmatter), Task 4 (gating/giliran), Task 4 (hapus gaya aktif).
