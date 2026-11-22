# Fase 5a — Commands, Instructions, dan Web search OpenCode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kelola **slash commands OpenCode** (`.opencode/commands`), daftar **`instructions`**, dan **provider web search** dari Adhitron, tanpa terminal.

**Architecture:** `src/opencode-commands.js` memegang aturan + IO file command (pola `src/skills.js`: containment, backup, frontmatter) dan route baru `src/routes/opencode-commands.js` menyajikannya. `instructions` dan `websearch` adalah kunci config yang ditambahkan ke view + `mergeForm` `src/opencode-config.js`, lalu ke form `#oc-form-panel`. Plugins dan varian model sudah ada; plan ini hanya memverifikasi dan mendokumentasikannya.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, UI statis `public/`.

**Spec:** `docs/superpowers/specs/2026-11-22-adopsi-tuntas-mesin-design.md` (Fase 5, baris 112–117)

## Global Constraints

- OpenCode terpasang **2.3.2**; perilaku mengikuti https://opencode.ai/docs/commands, /docs/config, /docs/websearch.
- Command = file `.md`; nama = path relatif tanpa `.md` (nested → `nama/sub`). Frontmatter: `description`, `agent`, `model` (`provider/model#variant`), `subagent` (boolean; `subtask` alias lama). Body = `template`.
- Command global: `<OPENCODE_CONFIG_HOME | XDG_CONFIG_HOME | ~/.config>/opencode/commands`; project: `<project>/.opencode/commands`. Direktori `command/` singular tetap dibaca (legacy), tulis ke `commands/`.
- Tulis command **project** boleh laptop/Tailscale; command **global** hanya dari laptop. Route menolak project yang mesinnya Claude (409).
- Backups di `<dataDir>/opencode-command-backups/`; symlink/junction pada root atau file ditolak; `mtime` adalah kunci optimistis; tulis atomik.
- `instructions`: array string (path/glob/URL), maksimal 100 entri, tiap entri 1–500 karakter tanpa karakter kontrol; kosong menghapus kunci.
- `websearch`: `false` (nonaktif), `{ provider: "<id>" }` (id `[a-z0-9][a-z0-9-]{0,39}`, termasuk `opencode`/`random`), atau tidak diatur. Provider bawaan: `opencode`, `exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`, `random`.
- Jangan menyentuh kunci config lain; file config yang tidak valid tetap ditolak 409 (perilaku yang ada).
- Teks UI Bahasa Indonesia, komentar kode Bahasa Inggris, tanpa kata "mesin" di string UI.

## Review Focus

1. **ID command tidak boleh keluar folder** — `../evil`, `/abs`, `a\b`, `a//b`, `.`/`..`, atau id kosong ditolak 400; symlink/junction pada root/file ditolak 409; tidak ada tulis/hapus di luar root.
2. **Frontmatter tidak merusak isi** — kunci asing (mis. `metadata.x`) dipertahankan; `subtask` lama dihormati saat `subagent` tidak ada; body yang memuat `---` tidak terpotong.
3. **Instructions/websearch tidak menghapus config lain** — hanya kunci itu yang berubah; nilai `undefined` di form tidak menyentuh apa pun; `websearch` objek dengan kunci asing mempertahankannya saat `provider` diganti.
4. **Scope dan mesin** — command global tidak bisa ditulis dari Tailscale; project Claude menolak route command (409); daftar project menang atas global untuk id yang sama.
5. **File berubah di tempat lain** — `mtime` lama → 409 tanpa menulis; rename memindahkan file dan menghapus yang lama hanya setelah tulisan baru berhasil; hapus/rename tidak menyisakan file yatim.

---

## File Structure

- Create: `src/opencode-commands.js`
- Create: `src/routes/opencode-commands.js`
- Create: `public/js/features/opencode-commands.js`
- Modify: `src/routes/index.js`, `src/opencode-config.js`, `public/js/features/opencode-config.js`, `public/index.html`
- Test: `test/opencode-commands.test.mjs`, `test/opencode-commands-route.test.mjs`, `test/opencode-commands-ui.test.mjs`, `test/opencode-config.test.mjs`, `test/opencode-config-ui.test.mjs`
- Docs: `CHANGELOG.md`, `docs/FITUR.md`, `docs/design-opencode.md`, `docs/uji-ui.md`

---

### Task 1: Aturan + IO command OpenCode

**Files:**
- Create: `src/opencode-commands.js`
- Test: `test/opencode-commands.test.mjs`

**Interfaces:**
- Consumes: `openCodeConfigRoot` dari `src/opencode-config.js`; `node:fs`, `node:path`, `node:crypto`.
- Produces:
  - `COMMAND_LIMITS = { bytes: 65536, id: 64, description: 500, agent: 200, model: 200 }`
  - `class CommandError extends Error { status }`
  - `commandRoots({ projectPath, env = process.env }) -> [{ scope:'project'|'user', dir, source }]` (project canonical, lalu legacy `command/`, lalu user canonical + legacy)
  - `validCommandId(id) -> boolean`
  - `parseCommandFile(text) -> { description, agent, model, subagent, subtask, body, front }`
  - `listCommands({ projectPath, env }) -> [{ id, description, agent, model, subagent, scope, source, mtime }]`
  - `readCommand({ projectPath, env, scope, source, id }) -> { id, description, agent, model, subagent, body, scope, source, mtime }`
  - `saveCommand({ projectPath, env, dataDir, scope, source, id, previous, name?, description, agent, model, subagent, template, mtime }) -> { command, backedUp }`
  - `deleteCommand({ projectPath, env, dataDir, scope, source, id, mtime }) -> { backedUp }`
  - `commandBackupRoot(dataDir) -> string`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CommandError, commandRoots, deleteCommand, listCommands, parseCommandFile, readCommand, saveCommand } from '../src/opencode-commands.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const write = (f, text) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
const envFor = (home) => ({ OFFICE_OPENCODE_CONFIG_HOME: home });

test('listCommands: project menang atas global, nested id, legacydibaca, frontmatter terurai', () => {
  const project = tmp('oc-p-'); const home = tmp('oc-h-');
  write(path.join(project, '.opencode', 'commands', 'review.md'), '---\ndescription: Review PR\nagent: build\nmodel: openai/gpt-5#high\nsubagent: true\n---\n\nReview $ARGUMENTS\n');
  write(path.join(project, '.opencode', 'commands', 'team', 'deploy.md'), '---\ndescription: Deploy\n---\n\ndeploy\n');
  write(path.join(project, '.opencode', 'command', 'lama.md'), '---\ndescription: Lama\n---\nlama\n');
  write(path.join(home, 'opencode', 'commands', 'review.md'), '---\ndescription: global\n---\nglobal\n');
  const list = listCommands({ projectPath: project, env: envFor(home) });
  assert.deepEqual(list.map((c) => c.id), ['lama', 'review', 'team/deploy']);
  assert.equal(list.find((c) => c.id === 'review').description, 'Review PR');
  assert.equal(list.find((c) => c.id === 'review').scope, 'project');
  assert.equal(list.find((c) => c.id === 'team/deploy').source, '.opencode/commands (project)');
  assert.equal(list.find((c) => c.id === 'lama').source, '.opencode/command (project, lama)');
  assert.equal(parseCommandFile('tanpa frontmatter').body, 'tanpa frontmatter');
});

test('save/read/delete: frontmatter ditulis, kunci asing dipertahankan, backup, mtime, validasi id', () => {
  const project = tmp('oc-s-'); const home = tmp('oc-sh-'); const dataDir = tmp('oc-sd-');
  const saved = saveCommand({ projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)', id: 'review', name: 'review', description: 'Review PR', agent: 'build', model: 'openai/gpt-5#high', subagent: true, template: 'Review $ARGUMENTS\n' });
  assert.equal(saved.command.id, 'review');
  const file = path.join(project, '.opencode', 'commands', 'review.md');
  assert.match(readFileSync(file, 'utf8'), /^---\ndescription: Review PR\nagent: build\nmodel: openai\/gpt-5#high\nsubagent: true\n---\n\nReview \$ARGUMENTS\n$/);
  const again = saveCommand({ projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)', id: 'review', description: 'Baru', agent: '', model: '', subagent: false, template: 'x\n', mtime: readCommand({ projectPath: project, env: envFor(home), scope: 'project', source: '.opencode/commands (project)', id: 'review' }).mtime });
  assert.ok(again.backedUp);
  assert.equal(deleteCommand({ projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)', id: 'review' }).backedUp.length > 0, true);
  assert.equal(existsSync(file), false);
  assert.throws(() => saveCommand({ projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)', id: '../evil', description: '', agent: '', model: '', subagent: false, template: 'x' }), (e) => e instanceof CommandError && e.status === 400);
  assert.throws(() => saveCommand({ projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)', id: 'a//b', description: '', agent: '', model: '', subagent: false, template: 'x' }), (e) => e.status === 400);
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test test/opencode-commands.test.mjs` → module belum ada.

- [ ] **Step 3: Implement** `src/opencode-commands.js`
  - `validCommandId`: tiap segmen `^[A-Za-z0-9][\w.-]{0,63}$`, dipisah `/`, maksimal 4 segmen, tanpa `.`/`..`, tanpa karakter kontrol.  - Frontmatter diurai baris-per-baris (pola `parseSkillFrontmatter`) dan menyimpan `front` mentah; `saveCommand` menulis ulang hanya kunci yang diketahui, mempertahankan baris lain; `subagent` ditulis bila boolean, `subtask` lama dipertahankan bila `subagent` tidak dikirim.
  - `listCommands` membaca root project lalu user, dedupe per id (project menang), lewati symlink dan file > 256 KB; id = path relatif (`a/b.md` → `a/b`).
  - `saveCommand`/`deleteCommand`: validasi + containment (`realpathSync` root & file, tolak symlink/junction), `mtime` mismatch → 409, backup ke `<dataDir>/opencode-command-backups/<scope>~<id dengan / jadi __>~<ts>.md` (maks 20 per id), tulis atomik, rename memindahkan file (tulis baru dulu, hapus lama setelah sukses).

- [ ] **Step 4: Run test to verify it passes** — `node --test test/opencode-commands.test.mjs` → PASS.

- [ ] **Step 5: Commit** — `git add src/opencode-commands.js test/opencode-commands.test.mjs; git commit -m "OpenCode commands: aturan, daftar, simpan/hapus dengan backup"`

---

### Task 2: Route command OpenCode

**Files:**
- Create: `src/routes/opencode-commands.js`
- Modify: `src/routes/index.js`
- Test: `test/opencode-commands-route.test.mjs`

**Interfaces:**
- Consumes: ekspor Task 1; `withProject`; `json`; `ctx.isLocal`, `ctx.isReadOnly`, `ctx.hub.engineOf`, `ctx.hub.dataDir`.
- Produces route:
  - `POST /api/projects/:id/opencode-commands` → `{ commands, roots }`
  - `POST /api/projects/:id/opencode-commands/read` `{ scope, source, id }` → `{ command }`
  - `POST /api/projects/:id/opencode-commands/save` `{ scope, source, id, previous, name, description, agent, model, subagent, template, mtime }` → `{ command, backedUp }`
  - `POST /api/projects/:id/opencode-commands/delete` `{ scope, source, id, mtime }` → `{ backedUp }`

- [ ] **Step 1: Write the failing test** (pola `test/add-dirs-route.test.mjs`): project + `env` lewat `process.env.OFFICE_OPENCODE_CONFIG_HOME` (set ke tmp di file test), ctx `{ hub, isLocal, isReadOnly, dataDir }`, `hub.engineOf = () => 'opencode'`.
  Assert: daftar 200; save project dari Tailscale (`isLocal:false`) 200; save user dari Tailscale 403; project mesin Claude (`engineOf → 'claude'`) 409; id `../evil` 400; baca dari WiFi (`isReadOnly:true`) 403.

- [ ] **Step 2: Run to fail** — route belum terdaftar.

- [ ] **Step 3: Implement** route + registrasi di `src/routes/index.js` setelah `outputStyles`.
  - Gate mesin: `if (ctx.hub.engineOf?.(project.id) !== 'opencode') return json(res, 409, { error: 'Commands OpenCode hanya tersedia saat mesin OpenCode aktif.' })`.
  - Baca: `isReadOnly !== false` → 403. Tulis: `scope === 'user' && !ctx.isLocal(req)` → 403.
  - Error `CommandError` → status + `{ error }`; lainnya dilempar ulang.

- [ ] **Step 4: Run to pass** — `node --test test/opencode-commands-route.test.mjs`.

- [ ] **Step 5: Commit** — `git add src/routes/opencode-commands.js src/routes/index.js test/opencode-commands-route.test.mjs; git commit -m "OpenCode commands: route baca/simpan/hapus dengan gerbang project"`

---

### Task 3: Instructions + websearch di config (server)

**Files:**
- Modify: `src/opencode-config.js`
- Test: `test/opencode-config.test.mjs`

**Interfaces:**
- Produces:
  - `instructionsView(config) -> string[]`
  - `websearchView(config) -> { mode: 'inherit'|'off'|'provider', provider: string }`
  - view `readOpenCodeConfig` menambah `instructions`, `websearch`
  - `mergeForm` menerima `form.instructions` (array) dan `form.websearch` (`{ mode, provider }`)

- [ ] **Step 1: Write failing tests**

```js
test('readOpenCodeConfig: instructions dan websearch tampil apa adanya', () => {
  const dir = path.join(TMP, 'projects', 'oc-view');
  write(path.join(dir, 'opencode.json'), JSON.stringify({ instructions: ['AGENTS.md', '~/aturan/*.md'], websearch: { provider: 'exa' } }));
  const view = readOpenCodeConfig({ scope: 'project', projectPath: dir, home: HOME });
  assert.deepEqual(view.instructions, ['AGENTS.md', '~/aturan/*.md']);
  assert.deepEqual(view.websearch, { mode: 'provider', provider: 'exa' });
  write(path.join(dir, 'opencode.json'), JSON.stringify({ websearch: false }));
  assert.deepEqual(readOpenCodeConfig({ scope: 'project', projectPath: dir, home: HOME }).websearch, { mode: 'off', provider: '' });
});

test('mergeForm instructions/websearch: validasi, kosong menghapus, kunci lain aman', () => {
  const base = { theme: 'x', websearch: { provider: 'exa', extra: 1 }, instructions: ['lama.md'] };
  let merged = mergeForm(base, { instructions: ['AGENTS.md', 'AGENTS.md', ' https://contoh.test/a.md '], websearch: { mode: 'provider', provider: 'tavily' } });
  assert.deepEqual(merged.instructions, ['AGENTS.md', 'https://contoh.test/a.md']);
  assert.deepEqual(merged.websearch, { provider: 'tavily', extra: 1 });
  merged = mergeForm(merged, { instructions: [], websearch: { mode: 'off', provider: '' } });
  assert.equal(merged.instructions, undefined);
  assert.equal(merged.websearch, false);
  merged = mergeForm(merged, { websearch: { mode: 'inherit', provider: '' } });
  assert.equal('websearch' in merged, false);
  for (const bad of [{ instructions: 'x' }, { instructions: ['x'.repeat(501)] }, { instructions: ['a\nb'] }, { instructions: Array(101).fill('a.md') }, { websearch: { mode: 'provider', provider: '' } }, { websearch: { mode: 'provider', provider: 'Bad Provider' } }, { websearch: { mode: 'lain' } }]) {
    assert.throws(() => mergeForm({}, bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});
```

- [ ] **Step 2: Run to fail** — `node --test test/opencode-config.test.mjs`.

- [ ] **Step 3: Implement** di `src/opencode-config.js`
  - `instructionsView`: hanya string; selain array → `[]`.
  - `websearchView`: `false` → off; `{provider:string}` → provider; selain itu inherit.
  - `mergeInstructions`: array wajib; tiap entri string non-kosong setelah trim, ≤500, tanpa `[\u0000-\u001f\u007f]`, maksimal 100, dedupe case-sensitive; array kosong → `delete config.instructions`.
  - `mergeWebsearch`: objek `{ mode, provider }`; `inherit` → `delete config.websearch`; `off` → `config.websearch = false`; `provider` → validasi `^[a-z0-9][a-z0-9-]{0,39}$`, lalu `config.websearch = { ...(isObject(config.websearch) ? config.websearch : {}), provider }`.
  - Panggil keduanya di `mergeForm` hanya bila field `!== undefined`.

- [ ] **Step 4: Run to pass** — test yang sama hijau.

- [ ] **Step 5: Commit** — `git commit -m "OpenCode config: instructions dan provider web search di form"`

---

### Task 4: Instructions + websearch di UI config

**Files:**
- Modify: `public/js/features/opencode-config.js`, `public/index.html`
- Test: `test/opencode-config-ui.test.mjs`

**Interfaces:**
- Markup baru di `#oc-form-panel`: `#oc-instructions-list`, `#oc-instruction-add`; `#oc-websearch`.
- `collectInstructions()` → array string dari baris `[data-instruction]`; `renderInstructions(list)`.

- [ ] **Step 1: Write failing test** (tambahan di harness UI config): fake view membawa `instructions: ['AGENTS.md']`, `websearch: { mode:'provider', provider:'exa' }`; assert dua baris terisi, select `exa`; tambah baris + ubah provider → POST form berisi `instructions: ['AGENTS.md','baru.md']`, `websearch: {mode:'provider', provider:'tavily'}`; hapus semua baris → `instructions: []`.

- [ ] **Step 2: Run to fail** — `node --test test/opencode-config-ui.test.mjs`.

- [ ] **Step 3: Implement**
  - Baris instruksi memakai kelas yang ada (`oc-agent`, `oc-agent-grid`, `oc-field`, `ghost`), input `data-instruction` dengan placeholder `AGENTS.md, ~/aturan/*.md, https://…`.
  - Select websearch opsi: `inherit` (Bawaan), `off` (Nonaktif), `opencode`, `random`, `exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`; nilai provider di luar daftar tetap ditampilkan sebagai opsi tambahan.
  - `save()` mengirim `instructions` dan `websearch`; form hanya dikirim dari tab Form (perilaku yang ada).
  - Teks bantuan: `instructions` = file/glob/URL yang selalu dibaca; websearch = provider yang dipakai tool pencarian.

- [ ] **Step 4: Run to pass** — test UI config hijau.

- [ ] **Step 5: Commit** — `git commit -m "OpenCode config: instruksi tambahan dan provider web search di form editor"`

---

### Task 5: Dialog Commands OpenCode

**Files:**
- Create: `public/js/features/opencode-commands.js`
- Modify: `public/index.html` (tombol `#oc-commands-open` di `#oc-form-panel`, modal `#oc-commands-modal` setelah `#oc-config-modal`), `public/js/features/opencode-config.js` (init tombol), `public/js/app.js`
- Test: `test/opencode-commands-ui.test.mjs`

**Interfaces:**
- Produces: `openOpenCodeCommands()`, `initOpenCodeCommands()`.
- Markup: `#oc-commands-modal`, `#oc-commands-project`, `#oc-commands-body`; baris `[data-cmd-use]` tidak perlu—dialog hanya CRUD.

- [ ] **Step 1: Write failing test** (real server, fake `OPENCODE_BIN`, `OFFICE_OPENCODE_CONFIG_HOME` di TMP; project mesin OpenCode lewat `settings.engine`): buka config modal → klik `#oc-commands-open` → daftar kosong; `#oc-command-new` → isi id/deskripsi/template → simpan → file `.opencode/commands/<id>.md` ada; edit → ubah template → file berubah + backup bertambah; hapus → file hilang; mobile+desktop tanpa overflow; project Claude menolak (tombol/route).

- [ ] **Step 2: Run to fail** — modal belum ada.

- [ ] **Step 3: Implement** dialog pola `features/skills.js`: `list`/`form`; scope project/user (user hanya dari laptop), pilihan source untuk edit, field id (dinonaktifkan saat edit? izinkan rename via `previous`), deskripsi, agent, model, subagent checkbox, template textarea. Tombol `#oc-commands-open` di form config hanya tampil bila project mesin OpenCode (atau selalu, route yang menolak). Teks bantuan menyebut `$ARGUMENTS`, `$1`, `` !`cmd` `` dan reload otomatis.

- [ ] **Step 4: Run to pass** + `node --test test/css-coverage.test.mjs`.

- [ ] **Step 5: Commit** — `git commit -m "OpenCode commands: dialog kelola command dari editor config"`

---

### Task 6: Dokumentasi + gerbang + rilis 1.0.91

**Files:** `docs/design-opencode.md`, `CHANGELOG.md`, `docs/FITUR.md`, `docs/uji-ui.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Catatan upstream** — tambah baris 2.3.2: commands `.opencode/commands` (nested → `/`, legacy `command/`, frontmatter, `$ARGUMENTS`/`$1`, `` !`cmd` ``, reload otomatis; config `commands` tetap ada), `instructions` array, `websearch.provider` + 7 nilai; plugin & varian model sudah didukung sejak 1.0.x (verifikasi).
- [ ] **Step 2: CHANGELOG** — `## Belum dirilis` → fitur **📝 Commands OpenCode**, **📚 Instruksi tambahan**, **🔎 Provider web search**; sebut batas (global laptop-only, project Tailscale, backup, id aman, maks 100 instruksi).
- [ ] **Step 3: FITUR + uji-ui** — baris tabel untuk Commands; perluas bullet **Config & Agent OpenCode** dengan instructions/websearch; sebut `test/opencode-commands-ui.test.mjs` di paragraf file terpisah.
- [ ] **Step 4: Gerbang** — `npm run check`; `npm run test:related -- src/opencode-commands.js src/routes/opencode-commands.js src/opencode-config.js public/js/features/opencode-commands.js public/js/features/opencode-config.js`; `node --test test/opencode-commands.test.mjs test/opencode-commands-route.test.mjs test/opencode-commands-ui.test.mjs`; 12 smoke file langsung (Windows) / `npm run test:smoke` di CI.
- [ ] **Step 5: Rilis 1.0.91** — bump `package.json` + lock, promosikan CHANGELOG, commit `Rilis 1.0.91: commands, instructions, dan web search OpenCode`, tag `v1.0.91`, push main + tag, pantau workflow sampai GitHub Release terbentuk.

---

## Self-Review

**Spec coverage:** Fase 5 butir Commands → Task 1–2 + UI Task 5; `instructions` → Task 3–4; websearch provider → Task 3–4; plugins & varian model → diverifikasi di Task 6 (sudah ada). Policies dan config lanjutan sengaja masuk **5b** (keputusan user: dua rilis).
**Type consistency:** `CommandError.status`, `commandRoots`, `listCommands`, `readCommand`, `saveCommand`, `deleteCommand` dipakai sama di route/UI; field `source` dipakai untuk memilih root; id modal/atribut `#oc-command-*` dan `data-cmd-*` konsisten.
**Review Focus:** lima butir di atas masing-masing punya test di Task 1 (id/containment/frontmatter/mtime), Task 2 (scope/mesin), Task 3 (config lain), Task 1/5 (rename/hapus).
**Proportion:** plan memuat signature, nilai yang dipatok, dan test; body implementasi ditulis saat eksekusi.
