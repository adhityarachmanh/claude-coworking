# Fase 2 — Skills (dua mesin) + Memory lanjutan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kelola **skills** Claude Code & OpenCode (`.claude/skills`, `.opencode/skills`, `.agents/skills`, dan lokasi globalnya) dari aplikasi — lihat, buat, edit, hapus `SKILL.md` + file pendukung — dan lengkapi editor **Memory** dengan `.claude/rules/*.md` serta **auto memory** (`~/.claude/projects/<encoded>/memory/`).

**Architecture:** Aturan murni + operasi file di `src/skills.js` (frontmatter, id, penemuan direktori per mesin, baca/tulis/hapus, backup). Route tipis di `src/routes/skills.js` (pola `src/routes/extensions.js`: baca dari laptop/Tailscale, tulis scope global dari laptop saja; backup sebelum menulis mengikuti pola `src/opencode-config.js`). Memory lanjutan memperluas `src/memory-files.js` + `src/routes/memory.js` yang sudah ada (tambah kunci `.claude/rules/*` dan auto-memory per project). UI: satu tab **🧩 Skills** baru di `#ext-modal` yang berlaku untuk **kedua mesin**, plus tab baru di `#memory-modal`.

**Tech Stack:** Node >= 20 ES module, `node:fs`, `node:test`, vanilla JS/CSS statis. Tanpa dependensi baru, tanpa skema baru.

**Spec:** `docs/superpowers/specs/2026-11-22-adopsi-tuntas-mesin-design.md` (Fase 2)

## Global Constraints

- Teks UI: **Bahasa Indonesia**; komentar kode: **Inggris**.
- **Skills bukan tools**: menambah skill hanya menambah instruksi, tidak melewati izin. Jangan pura-pura mengubah izin.
- **Laptop-only untuk scope global** (`~/.claude/skills`, `~/.config/opencode/skills`, `~/.agents/skills`): menulis di sana mensteer setiap project (pola subagent/plugin). Skill **project** boleh ditulis dari Tailscale.
- **Backup sebelum menulis** file skill yang sudah ada (pola `opencode-config-backups/` di `src/opencode-config.js:285-407`); backup di `dataDir`, bukan di folder config.
- **Jangan sentuh data user tanpa izin**: hanya path skill yang dikenal yang dibaca/ditulis; symlink di salah satu path ditolak (pola `src/memory-files.js:63-64`).
- Test lama tidak dihapus/dilemahkan. Jalankan gerbang lewat `npm run …`; jangan sentuh env `OFFICE_*`/instalasi asli.
- Id skill: `^[a-z0-9][a-z0-9-]{0,63}$` (huruf kecil, angka, minus). `description` wajib agar model bisa menemukan skill.

## Review Focus

- **Frontmatter rusak.** `SKILL.md` tanpa frontmatter / frontmatter tanpa `description` tetap muncul di daftar (dengan penanda), tidak boleh menggagalkan seluruh daftar. Uji murni Task 1.
- **Id dari path, bukan judul.** Id diturunkan dari nama direktori (OpenCode: `<source>/git-release/SKILL.md` → `git-release`). Uji Task 1.
- **Scope global = laptop-only.** Route menolak 403 untuk skill global dari non-laptop; UI menyembunyikan tombolnya. Uji Task 3 & 5.
- **Backup dulu, baru tulis.** Menimpa `SKILL.md` yang ada wajib menghasilkan backup; tidak ada file baru tanpa backup saat file lama ada. Uji Task 2.
- **Path tak boleh keluar dari root skill.** Id/`previous` yang aneh (`../x`, `a/b`) ditolak sebelum menyentuh fs. Uji Task 1 & 2.
- **Memory lanjutan tidak merusak tab lama.** Kunci `project`/`local`/`user` tetap ada; `.claude/rules/*` dan auto-memory muncul sebagai kunci tambahan; file auto-memory yang ditulis Claude (mtime berubah) tetap tunduk aturan "sudah berubah sejak dibuka" (409). Uji Task 4.
- **Dua mesin hormat.** Daftar skill OpenCode memuat `.claude/skills` (kompat) juga; jangan hanya Claude.

---

### Task 1: `src/skills.js` — aturan murni (frontmatter, id, penemuan direktori)

**Files:**
- Create: `src/skills.js`
- Test: `test/skills.test.mjs` (baru)

**Interfaces:**
- Consumes: `src/claude-admin.js` `parseAgent` (pola frontmatter — boleh disalin ke fungsi sendiri agar tidak mengubah perilaku agent).
- Produces:
  - `SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/`
  - `validSkillId(id) -> boolean`
  - `parseSkillFrontmatter(text) -> { meta, body }` (`meta` = objek key:value sederhana; nilai dikupas kutip)
  - `skillRoots({ engine, scope, projectPath, home }) -> [{ source, scope, dir, engine }]` — daftar direktori sumber skill untuk engine itu, urut **precedence naik** (lihat OpenCode §6); `scope` = `'project' | 'user'`
  - `listSkills({ engine, projectPath, home }) -> [{ id, name, description, scope, source, engine, dir, file, hasSupport, error? }]`
  - `skillFile(dir) -> string` = `path.join(dir, 'SKILL.md')`
  - `class SkillError extends Error { constructor(status, message) }`

- [ ] **Step 1: Tulis test yang gagal** (`test/skills.test.mjs`)

```js
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listSkills, parseSkillFrontmatter, skillRoots, validSkillId } from '../src/skills.js';

test('validSkillId: huruf kecil/angka/minus, 1–64 char', () => {
  assert.equal(validSkillId('git-release'), true);
  assert.equal(validSkillId('a'.repeat(64)), true);
  assert.equal(validSkillId('a'.repeat(65)), false);
  assert.equal(validSkillId('Git'), false);
  assert.equal(validSkillId('../evil'), false);
  assert.equal(validSkillId('a/b'), false);
  assert.equal(validSkillId('-x'), false);
  assert.equal(validSkillId(''), false);
});

test('parseSkillFrontmatter: key:value sederhana + body; tanpa frontmatter = meta kosong', () => {
  const { meta, body } = parseSkillFrontmatter('---\nname: Git Release\ndescription: "Buat rilis"\n---\n\nLangkah…\n');
  assert.equal(meta.name, 'Git Release');
  assert.equal(meta.description, 'Buat rilis');
  assert.match(body, /Langkah/);
  assert.deepEqual(parseSkillFrontmatter('# Tanpa frontmatter').meta, {});
});

test('skillRoots: Claude & OpenCode, project + user, precedence naik', () => {
  const claude = skillRoots({ engine: 'claude', projectPath: 'C:/p', home: 'C:/h' }).map((r) => r.dir.replace(/\\/g, '/'));
  assert.ok(claude.some((d) => d.endsWith('p/.claude/skills')), 'project .claude/skills');
  assert.ok(claude.some((d) => d.endsWith('h/.claude/skills')), 'user ~/.claude/skills');
  const oc = skillRoots({ engine: 'opencode', projectPath: 'C:/p', home: 'C:/h' }).map((r) => r.dir.replace(/\\/g, '/'));
  assert.ok(oc.some((d) => d.endsWith('p/.opencode/skills')));
  assert.ok(oc.some((d) => d.endsWith('h/.config/opencode/skills')));
  assert.ok(oc.some((d) => d.endsWith('p/.claude/skills')), 'kompat .claude/skills');
});

test('listSkills: id dari nama direktori, description dibaca, file pendukung ditandai', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dir = path.join(project, '.claude', 'skills', 'git-release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Git Release\ndescription: Buat rilis\n---\n\nisi\n');
  writeFileSync(path.join(dir, 'notes.md'), 'x');
  const list = listSkills({ engine: 'claude', projectPath: project, home });
  const found = list.find((s) => s.id === 'git-release');
  assert.ok(found);
  assert.equal(found.description, 'Buat rilis');
  assert.equal(found.scope, 'project');
  assert.equal(found.hasSupport, true);
});

test('listSkills: SKILL.md tanpa description tetap muncul dengan penanda, tidak menggagalkan daftar', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dir = path.join(project, '.claude', 'skills', 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '# tanpa frontmatter\n');
  const found = listSkills({ engine: 'claude', projectPath: project, home }).find((s) => s.id === 'broken');
  assert.ok(found);
  assert.equal(found.description, '');
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/skills.test.mjs`
Expected: FAIL — modul `../src/skills.js` belum ada

- [ ] **Step 3: Implementasi `src/skills.js`**
  - `SKILL_ID`/`validSkillId` seperti di atas.
  - `parseSkillFrontmatter`: pakai regex `^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$`; tiap baris `^([\w-]+):\s*(.*)$` → `meta`; kutip dikupas. Tanpa blok → `{ meta: {}, body: text }`.
  - `skillRoots`: Claude → `[project/.claude/skills (project), home/.claude/skills (user)]`. OpenCode → `[project/.claude/skills (project, kompat), project/.agents/skills (project, kompat), home/.claude/skills (user, kompat), home/.agents/skills (user, kompat), home/.config/opencode/skills (user), project/.opencode/skills (project)]` (urut precedence naik; source diberi label Indonesia, mis. `'.claude/skills (project)'`).
  - `listSkills`: untuk tiap root, `readdirSync(dir, { withFileTypes: true })`; hanya direktori yang punya `SKILL.md` (file di root juga diterima bila bernama `*.md`? **Tidak** — hanya `SKILL.md` di dalam direktori, sesuai riset); `id` = nama direktori; baca frontmatter; `hasSupport` = ada file lain di direktori; file > 256 KB dilewati; satu direktori rusak tidak menggagalkan yang lain (`error` diisi). Root yang tidak ada → dilewati.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/skills.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (`Aturan skills: frontmatter, id, penemuan direktori dua mesin`).

---

### Task 2: `src/skills.js` — baca/tulis/hapus + backup

**Files:**
- Modify: `src/skills.js`
- Test: `test/skills.test.mjs` (tambah)

**Interfaces:**
- Consumes: `src/opencode-config.js` pola `ensurePrivateDir`/`writeFileAtomic` (salin pola lokal, jangan impor agar tidak mengikat).
- Produces:
  - `readSkill({ engine, projectPath, home, scope, source, id }) -> { id, name, description, scope, source, file, content, mtime, support: [{ name, bytes }], exists }`
  - `saveSkill({ engine, projectPath, home, scope, source, id, previous, name, description, content, dataDir, baseMtime }) -> { id, scope, source, backedUp: boolean }`
  - `deleteSkill({ engine, projectPath, home, scope, source, id, dataDir }) -> { ok: true, backedUp: boolean }`
  - `skillBackupRoot(dataDir) -> string` = `path.join(dataDir, 'skills-backups')`

- [ ] **Step 1: Tulis test yang gagal** (tambah ke `test/skills.test.mjs`)

```js
import { existsSync, readFileSync } from 'node:fs';
import { deleteSkill, readSkill, saveSkill } from '../src/skills.js';

test('saveSkill: menulis SKILL.md + backup file lama', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'git-release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Old\ndescription: old\n---\n\nlama\n');
  const r = saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: 'project', id: 'git-release', name: 'Git Release', description: 'Buat rilis', content: 'Langkah baru\n', dataDir, baseMtime: 0 });
  assert.equal(r.backedUp, true);
  const written = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(written, /name: Git Release/);
  assert.match(written, /Langkah baru/);
  assert.ok(existsSync(path.join(dataDir, 'skills-backups')), 'backup dibuat');
});

test('saveSkill: id tak sah ditolak tanpa menyentuh fs', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  assert.throws(() => saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: 'project', id: '../evil', name: 'x', description: 'y', content: 'z', dataDir }), (e) => e instanceof SkillError && e.status === 400);
});

test('saveSkill: file berubah sejak dibuka → 409', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
  const loaded = readSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: 'project', id: 'x' });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\nberubah\n'); // touched elsewhere
  assert.throws(() => saveSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: 'project', id: 'x', name: 'x', description: 'y', content: 'z', dataDir, baseMtime: loaded.mtime }), (e) => e instanceof SkillError && e.status === 409);
});

test('deleteSkill: menghapus direktori skill, membackup bila ada', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'h-'));
  const project = mkdtempSync(path.join(tmpdir(), 'p-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'd-'));
  const dir = path.join(project, '.claude', 'skills', 'gone');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: gone\ndescription: y\n---\n');
  const r = deleteSkill({ engine: 'claude', projectPath: project, home, scope: 'project', source: 'project', id: 'gone', dataDir });
  assert.equal(r.ok, true);
  assert.equal(existsSync(dir), false);
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/skills.test.mjs`
Expected: FAIL — `readSkill`/`saveSkill`/`deleteSkill` belum ada

- [ ] **Step 3: Implementasi**
  - `resolveDir({ engine, projectPath, home, scope, source, id })`: cari root di `skillRoots` dengan `scope`+`source` cocok; `id` harus `validSkillId`; hasil = `path.join(root.dir, id)`; **verifikasi** hasil masih di dalam `root.dir` (pola `isInside`) sebelum dipakai.
  - `readSkill`: `lstatSync` → symlink ditolak 409; file > 256 KB → 413; `SKILL.md` hilang → `exists:false, content:''`; `support` = daftar file lain di direktori (nama + ukuran).
  - `saveSkill`: validasi id + `description` wajib (400); `baseMtime` beda > 1 ms → 409 (pesan "sudah berubah sejak dibuka"); backup file lama via `writeBackup`-style ke `skillBackupRoot(dataDir)/<scope-folder>`; tulis `---\nname: …\ndescription: …\n---\n\n<content>\n` atomik; `previous` berbeda → hapus direktori lama (id lama) setelah tulis sukses.
  - `deleteSkill`: validasi id; backup `SKILL.md` bila ada; `rmSync(dir, { recursive: true, force: true })`.
  - `SkillError` pola `AdminError`/`MemoryError`: `status`.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/skills.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (`Skills: baca/tulis/hapus + backup sebelum menulis`).

---

### Task 3: Route `src/routes/skills.js`

**Files:**
- Create: `src/routes/skills.js`
- Modify: `src/routes/index.js` (import + `register` setelah `extensions.register`)
- Modify: `server.js` (`SECURE_ADMIN` tambah path tulis skill — baca boleh dari Tailscale)
- Test: `test/skills-route.test.mjs` (baru, integrasi `spawn(server.js)`)

**Interfaces:**
- Consumes: `src/skills.js` (Task 1–2), `withProject`, `json`, `ctx.hub.dataDir`, `ctx.hub.engineOf`, `ctx.isLocal`/`ctx.isReadOnly`.
- Produces:
  - `POST /api/projects/:id/skills` → `{ engine, skills: [...] }`
  - `POST /api/projects/:id/skills/read { scope, source, id }` → `{ skill }`
  - `POST /api/projects/:id/skills/save { scope, source, id, previous, name, description, content, mtime }` → `{ skill, backedUp }` (403 bila `scope==='user'` dan bukan laptop)
  - `POST /api/projects/:id/skills/delete { scope, source, id }` → `{ ok, backedUp }` (403 sama)

- [ ] **Step 1: Tulis test integrasi yang gagal** (`test/skills-route.test.mjs`)

Pola `spawn(server.js)` dari `test/worktree-route.test.mjs`/`test/engine-per-project.test.mjs`; `PROJECTS_ROOT` = folder project sementara (buat `.claude/skills/hello/SKILL.md`). Tuntut:
1. `POST /skills` → 200, `skills` memuat `hello` dengan `description`.
2. `POST /skills/save { scope:'project', source:'project', id:'hello', description:'D' , content:'isi' }` → 200; file berubah.
3. `POST /skills/read` → mengembalikan `content` yang baru.
4. `POST /skills/delete` → folder hilang.
5. `POST /skills/save` dengan `id:'../evil'` → 400.
6. Project non-Claude/OpenCode tetap 200 (skills dua mesin).

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/skills-route.test.mjs`
Expected: FAIL — route belum ada (404)

- [ ] **Step 3: Implementasi**
  - `src/routes/skills.js`: `guard` pola `src/routes/extensions.js:16-27` — baca ditolak bila `isReadOnly(req)` (plain WiFi); tulis **scope user** ditolak bila `!isLocal(req)`; galat `SkillError` → status.
  - `src/routes/index.js`: daftarkan `skills.register` setelah `extensions.register`.
  - `server.js`: tambah `/api/projects/:id/skills/save` & `/api/projects/:id/skills/delete` ke `SECURE_ADMIN`? **Tidak** — `SECURE_ADMIN` berupa path literal tanpa `:id`. Gunakan pola yang ada untuk route ber-`:id`: cukup guard di route (`isReadOnly`) + `LOCAL_ONLY_ACTION` **tidak** ditambahkan (skill project boleh dari Tailscale). Cukup pastikan route **tidak** masuk `WIFI_READ_PROJECT` (default: hanya path yang terdaftar yang boleh dari WiFi; route baru otomatis tertolak dari WiFi, diterima dari Tailscale). Verifikasi di test: dari plain WiFi → 403 (bila harness mengizinkan) — cukup pastikan guard `isReadOnly` ada.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/skills-route.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (`Route skills: daftar, baca, simpan, hapus`).

---

### Task 4: Memory lanjutan — `.claude/rules/*.md` + auto memory

**Files:**
- Modify: `src/memory-files.js` (`memoryFiles` tambah kunci rules + auto-memory)
- Modify: `src/routes/memory.js` (tidak perlu berubah bila `memoryFiles` sudah mengembalikan kunci baru; pastikan daftar file tetap memuat semuanya)
- Test: `test/memory-files.test.mjs` (tambah)

**Interfaces:**
- Consumes: `src/backup.js` `encodeProjectPath` (pola encoding: `p.replace(/[^a-zA-Z0-9]/g, '-')`) — salin pola lokal agar tidak impor berat.
- Produces (kunci baru di `memoryFiles`):
  - `rules-project` → `.claude/rules/*.md` (project) — **daftar file**, bukan satu file; direpresentasikan sebagai satu kunci yang mengembalikan gabungan? **Keputusan:** satu kunci per file dengan `key = 'rule:<name>'` (dinamis) agar bisa diedit satu-satu. `memoryFiles` mengembalikan daftar dinamis untuk rules.
  - `auto-memory` → `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` (scope user, tapi **per project**; hanya-baca? → boleh diedit, aturan mtime tetap).
  - File auto-memory lain (`memory/*.md`) sebagai `key = 'auto:<name>'`.

- [ ] **Step 1: Tulis test yang gagal** (tambah ke `test/memory-files.test.mjs`)

```js
test('memoryFiles: .claude/rules/*.md muncul sebagai kunci dinamis (project)', () => {
  const p = project();
  const rules = path.join(p, '.claude', 'rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(path.join(rules, 'api.md'), '# Aturan API\n');
  const files = memoryFiles('claude', p, home());
  const rule = files.find((f) => f.key === 'rule:api');
  assert.ok(rule, 'rule:api terdaftar');
  assert.equal(rule.scope, 'project');
});

test('memoryFiles: auto memory project (~/.claude/projects/<encoded>/memory) muncul', () => {
  const p = project();
  const h = home();
  const enc = p.replace(/[^a-zA-Z0-9]/g, '-');
  const memDir = path.join(h, '.claude', 'projects', enc, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(path.join(memDir, 'MEMORY.md'), '# Memori\n');
  writeFileSync(path.join(memDir, 'catatan.md'), 'x\n');
  const files = memoryFiles('claude', p, h);
  assert.ok(files.some((f) => f.key === 'auto:MEMORY'), 'MEMORY.md auto memory');
  assert.ok(files.some((f) => f.key === 'auto:catatan'), 'catatan.md auto memory');
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/memory-files.test.mjs`
Expected: FAIL — kunci rules/auto belum ada

- [ ] **Step 3: Implementasi**
  - `memoryFiles`: setelah file tetap, tambah hasil `rulesFiles(projectPath)` (baca `readdirSync(.claude/rules)` → `*.md`, key `rule:<basename-tanpa-.md>`, label `Aturan: <name>`, scope `project`, hint "Aturan per tipe file (.claude/rules).") dan `autoMemoryFiles(projectPath, home)` (baca `home/.claude/projects/<encoded>/memory/*.md`; `MEMORY.md` → key `auto:MEMORY` label "Auto memory (indeks)"; lain → `auto:<name>`; scope `'project'` — karena ia milik project ini, bukan semua project).
  - `readMemory`/`writeMemory` memakai `fileOf` yang mencari di `memoryFiles` → otomatis bekerja untuk kunci baru (karena key unik). Pastikan `fileOf` tidak pecah saat daftar memuat puluhan file.
  - Auto memory **hanya** untuk engine `claude` (OpenCode tidak memakainya); rules juga Claude.
  - `MAX_MEMORY_BYTES` tetap.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/memory-files.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (`Memory: .claude/rules + auto memory di editor`).

---

### Task 5: UI — tab Skills + tab memory lanjutan

> **Deviasi saat eksekusi (2026-11-22):** Skills dibuat sebagai **dialog sendiri** (`public/js/features/skills.js`, `#skills-modal`) + perintah `/skills` + item menu **⋯ → 🧩 Skills…** dan baris sheet HP — **bukan** tab di `#ext-modal`. Alasannya: dialog *Ekstensi* digerbangi **Claude-only** (`guardCap('extensions')`, `src/routes/extensions.js` `claude: true`), sedangkan Skills berlaku untuk **kedua mesin**; menaruhnya di sana akan salah menyembunyikannya saat project berjalan di OpenCode. Tab memory lanjutan **tidak perlu UI baru**: `public/js/features/memory.js` merender tab dari daftar `memoryFiles`, jadi kunci `rule:*`/`auto:*` otomatis muncul (Task 4).

**Files:**
- Modify: `public/index.html` (`#ext-tabs` tambah `<button data-tab="skills">🧩 Skills</button>`; `#memory-tabs` sudah dinamis)
- Modify: `public/js/features/extensions.js` (tab `skills` + render/form/handler)
- Modify: `public/js/features/commands.js` (tambah `/skills` → `openExtensions('skills')`)
- Modify: `public/css/app.css` (gaya form skill bila perlu; pakai `.oc-form`/`.ext-list` yang ada)
- Test: `test/skills-ui.test.mjs` (baru, standalone)

**Interfaces:**
- Consumes: route Task 3; `api()`, `toast()`, `openModal()`, `state.local`/`state.readOnly`.
- Produces: tab **Skills** — daftar skill (nama, id, deskripsi, scope, sumber, penanda "file pendukung"); **＋ Skill baru**, **✎ Edit**, **Hapus**; form (Nama, Deskripsi, Isi `SKILL.md`, id); tombol global dinonaktifkan untuk non-laptop dengan penjelasan.

- [ ] **Step 1: Tulis test UI yang gagal** (`test/skills-ui.test.mjs`)

Standalone + `describeArea('UI Skills', …)`; `spawn(server.js)` dengan project sementara berisi `.claude/skills/hello/SKILL.md`. Tuntut: buka tab Skills → baris `hello` muncul; buat skill baru `demo` → muncul di daftar; tanpa error konsol.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test test/skills-ui.test.mjs`
Expected: FAIL — tab belum ada

- [ ] **Step 3: Implementasi**
  - `public/index.html`: tambah tombol tab.
  - `public/js/features/extensions.js`: cabang `ext.tab === 'skills'` → `load()` memanggil `/api/projects/:id/skills`; render daftar + form; handler save/delete; hormati `state.local` untuk scope user.
  - `public/js/features/commands.js`: tambah command `/skills`.
  - Aksesibilitas: tombol bernama; target sentuh ≥ 24 px.

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `node --test test/skills-ui.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit** (`UI Skills: tab + form + perintah /skills`).

---

### Task 6: Dokumentasi + probe upstream + gerbang akhir

**Files:**
- Modify: `CHANGELOG.md` (`## Belum dirilis`)
- Modify: `docs/FITUR.md` (entri **Skills** + perbarui entri **Memory** untuk rules/auto memory)
- Modify: `docs/design-opencode.md` (**Catatan upstream**: skills OpenCode 2.3.2 — sumber `opencode.ai/docs/skills`, precedence, id dari path)

- [ ] **Step 1:** Catatan rilis bahasa pengguna: kelola skills dua mesin dari aplikasi, memory kini mencakup rules + auto memory.
- [ ] **Step 2:** `docs/FITUR.md`: satu entri fitur + baris tabel.
- [ ] **Step 3:** `docs/design-opencode.md` → **Catatan upstream**: tanggal 2026-11-22, OpenCode 2.3.2, fakta skills (precedence, id dari path, `.claude/skills` kompat), sumber.
- [ ] **Step 4:** `npm run test:related -- src/skills.js src/routes/skills.js src/memory-files.js src/routes/memory.js public/js/features/extensions.js public/js/features/memory.js`
- [ ] **Step 5:** `npm run test:smoke` lalu `npm run check`; `npm run test:ui:area -- "UI Skills"` (bila blok terdaftar).
- [ ] **Step 6: Commit + push.**

---

## Catatan eksekusi

**Status (2026-11-22):** Task 1–6 **selesai**; Fase 2 dirilis sebagai **1.0.87** setelah dua putaran review independen (security + code) dan perbaikan temuan. Lihat `.superpowers/sdd/2026-11-22-fase-2-skills-memory/progress.md` untuk catatan eksekusi.

- **Security review wajib** (menulis file ke folder project/user): setelah Task 5, minta review security atas `src/skills.js` + `src/routes/skills.js` (path traversal, symlink, backup, scope).
- **Backup**: file skill lama disalin ke `dataDir/skills-backups/<scope-folder>/` sebelum ditimpa; tidak menyentuh folder config.
- **Batas fase**: skills hanya menambah instruksi; tidak mengubah izin, tidak menjalankan kode. Auto memory ditulis Claude sendiri — editor hanya membacanya (dan boleh memperbaikinya), aturan 409 tetap.
- Metode eksekusi: **native** (satu reviewer di akhir), mengikuti Fase 1.
