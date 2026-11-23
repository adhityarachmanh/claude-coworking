# Fase 6 — Minor Claude (hooks, flag per project, command sisa)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menuntaskan adopsi Claude Code: mengelola **hooks** (tambah/ubah/hapus, bukan sekadar lihat), **flag per project** (`--fallback-model`, `--max-turns`, `--max-budget-usd`, `--tools`/`--allowedTools`/`--disallowedTools`, `--setting-sources`), dan memastikan `/goal`, `/loop`, `/fewer-permission-prompts` diteruskan sebagai command. Ditutup dengan **matriks adopsi** yang memetakan seluruh kemampuan kedua mesin ke Adhitron.

**Architecture:** Hooks disunting lewat `src/claude-admin.js` (sudah punya `listHooks`) menulis `hooks` di settings file (pola `src/permissions.js`). Flag per project disimpan sebagai setelan (validasi di `Hub.cleanSettings`) dan diteruskan sebagai argumen spawn di `src/session.js` (masuk `restartKey`). Command sisa cukup didaftarkan di katalog, tidak ada kode handler baru.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, UI statis.

**Spec:** `docs/superpowers/specs/2026-11-22-adopsi-tuntas-mesin-design.md` (Fase 6, baris 119–125)

## Global Constraints

- Claude Code terpasang **2.1.328**. Referensi otoritatif: https://code.claude.com/docs/en/cli-reference, /docs/commands, /docs/hooks (diperiksa ulang 2026-11-23).
- Hook = entri `hooks` di settings file (`user`/`project`/`local`), bentuk `{ matcher, hooks: [{ type: "command", command, timeout? }] }`; `matcher` = nama event (`PreToolUse`, `UserPromptSubmit`, …) atau `Event:tool` (mis. `PreToolUse:Edit`). Handler lain (`http`, `prompt`, `agent`, `mcp_tool`) tidak diedit lewat form; dibiarkan lewat tab/editor JSON.
- Flag `--tools` membatasi tool; `--allowedTools`/`--disallowedTools` mengatur izin tanpa prompt/deny; `--max-turns` dan `--max-budget-usd` hanya mode print (cocok, karena Adhitron memakai `claude -p`); `--setting-sources` = subset `user,project,local`.
- Teks UI Bahasa Indonesia, komentar kode Inggris, tanpa kata "mesin" di string UI.
- Hooks user hanya dari laptop; project/local dari laptop/Tailscale (pola agents). Flag per project hanya untuk project Claude (route/UI disembunyikan untuk OpenCode).

## Review Focus

1. **Hook tidak boleh merusak file settings** — JSON rusak/symlink ditolak; kunci lain (permissions, outputStyle, env) dipertahankan; `matcher`/`command`/`timeout` divalidasi; menghapus hook yang tidak ada = 404.
2. **Flag tidak boleh mengirim argumen aneh ke spawn** — state.json yang diedit tangan (string/non-angka/junk) dibersihkan `cleanSettings`; `--max-turns`/`--max-budget-usd` harus integer positif; daftar tool di-escape/di-quote benar agar argumen tunggal tidak pecah.
3. **Perubahan flag berlaku pada proses berikutnya** — masuk `restartKey`, proses idle ditutup; giliran berjalan tidak diubah di tengah jalan.
4. **Hooks & flag hanya untuk Claude** — route hooks dan dialog flag menolak/menyembunyikan saat mesin OpenCode; user-scope hooks laptop-only.
5. **`/goal` `/loop` `/fewer-permission-prompts` tetap sampai ke Claude** — bukan di `CLI_ONLY`; muncul di autocomplete; dikirim sebagai teks (Claude menjalankannya sebagai command/skill).

---

## File Structure

- Modify: `src/claude-admin.js` (save/delete hook), `src/routes/extensions.js`, `src/hub.js` (cleanSettings + DEFAULT_SETTINGS), `src/session.js` (spawn + restartKey), `public/js/features/extensions.js` (UI hooks), `public/js/features/composer.js` atau dialog baru (UI flag), `public/index.html`, `public/js/features/commands.js` (katalog)
- Test: `test/claude-hooks.test.mjs`, `test/claude-hooks-route.test.mjs`, `test/claude-flags.test.mjs`, `test/claude-flags-session.test.mjs`, `test/opencode-config-ui.test.mjs`? tidak — `test/claude-flags-ui.test.mjs`, `test/mobile-chat.test.mjs` (jika kena), `test/format.test.mjs`
- Docs: `docs/adopsi-mesin.md` (baru), `docs/design-opencode.md`, `CHANGELOG.md`, `docs/FITUR.md`, `docs/uji-ui.md`

---

### Task 1: Hooks — aturan tulis/hapus

**Files:** Modify `src/claude-admin.js`; Test `test/claude-hooks.test.mjs`

**Interfaces:**
- Consumes: `settingsFile` dari `src/permissions.js`; `node:fs`, `node:path`.
- Produces:
  - `HOOK_EVENTS` (daftar event sah untuk datalist UI)
  - `HOOK_LIMITS = { command: 2000, matcher: 200, timeout: 600000, hooks: 100 }`
  - `saveHook({ projectPath, userDir, scope, matcher, command, timeout }) -> { hook }`
  - `deleteHook({ projectPath, userDir, scope, matcher, command }) -> { removed }`
  - `HookError extends Error { status }`

- [ ] **Step 1: Tulis test gagal** — baca/tulis di tmp: `saveHook` membuat/menambah `hooks`, mempertahankan `permissions`/`outputStyle`; menimpa `command` pada `matcher` yang sama; validasi `matcher` (`PreToolUse`, `PreToolUse:Edit`; tolak `../`, kosong, `a b`), `command` non-kosong ≤2000, `timeout` integer 0..600000; `deleteHook` menghapus command yang cocok, membuang grup kosong, 404 bila tidak ada; file settings JSON rusak → 409 tanpa menulis.

- [ ] **Step 2–5:** implementasi, jalankan `node --test test/claude-hooks.test.mjs`, commit `git commit -m "Claude hooks: tulis dan hapus hook di settings"`.

---

### Task 2: Hooks — route

**Files:** Modify `src/routes/extensions.js`; Test `test/claude-hooks-route.test.mjs`

**Interfaces:** tambah route:
- `POST /api/projects/:id/hooks/save` `{ scope, matcher, command, timeout }` → `{ hook }`
- `POST /api/projects/:id/hooks/delete` `{ scope, matcher, command }` → `{ removed }`
- Gating: `claude: true`; `user` scope laptop-only; baca hooks tetap (sudah ada).

- [ ] **Step 1–5:** test gagal→lulus, commit `git commit -m "Claude hooks: route simpan dan hapus"`.

---

### Task 3: Hooks — UI

**Files:** Modify `public/js/features/extensions.js`, `public/index.html`; Test `test/mobile-chat.test.mjs` (bila kena) + UI hooks test bila ada harness.

**Interfaces:** di tab **Hooks** (`#hooks-tab`): daftar hook sekarang bisa ditambah/diubah/dihapus — baris punya **✎ Edit** dan **Hapus**; tombol **＋ Hook**; form `#hook-form` (event select+datalist, command, timeout, scope) memakai kelas existing. Baca/tulis memakai route Task 2. User-scope disembunyikan untuk HP Tailscale.

- [ ] **Step 1–5:** implementasi + jalankan UI terkait, commit `git commit -m "Claude hooks: kelola dari tab Hooks"`.

---

### Task 4: Flag per project — setelan + spawn

**Files:** Modify `src/hub.js`, `src/session.js`; Test `test/claude-flags.test.mjs`, `test/claude-flags-session.test.mjs`

**Interfaces:**
- `DEFAULT_SETTINGS` menambah: `claudeFallbackModel: ''`, `claudeMaxTurns: null`, `claudeMaxBudgetUsd: null`, `claudeTools: null`, `claudeAllowedTools: []`, `claudeDisallowedTools: []`, `claudeSettingSources: null`.
- `cleanSettings` memvalidasi: `claudeFallbackModel` string `^[\w./:#-]{0,200}$`; `claudeMaxTurns`/`claudeMaxBudgetUsd` integer positif (atau null); `claudeTools`/`claudeAllowedTools`/`claudeDisallowedTools` array string ≤50, tiap ≤500 tanpa kontrol, dedupe; `claudeSettingSources` string subset `user|project|local` dipisah koma (atau null). Nilai tak sah diabaikan (stored stays).
- `restartKey` menyertakan ketujuh field ini.
- `src/session.js` spawn menambahkan argumen (hanya bila ada): `--fallback-model <…>`, `--max-turns <n>`, `--max-budget-usd <n>`, `--tools <list>`, `--allowedTools <list>`, `--disallowedTools <list>`, `--setting-sources <a,b>` — masing-masing satu argumen utuh (spawn array, tidak dipecah shell).

- [ ] **Step 1: Tulis test gagal** — `cleanSettings` menyaring junk; `settingsFor` default; `session.spawn` meneruskan argumen dengan benar (fake CLI mencatat argv, pola `add-dirs-session.test.mjs`); perubahan flag menutup proses idle (restartKey).
- [ ] **Step 2–5:** implementasi, jalankan, commit `git commit -m "Claude flags: setelan per project diteruskan ke spawn"`.

---

### Task 5: Flag per project — UI + command sisa

**Files:** Modify `public/index.html`, `public/js/features/composer.js` (atau dialog `features/claude-flags.js`), `public/js/features/commands.js`; Test `test/claude-flags-ui.test.mjs`

**Interfaces:**
- Dialog `#claude-flags-modal` dibuka dari **Pengaturan giliran** (tombol **⚙️ Flag Claude…**, hanya Claude). Field: fallback model, max turns, max budget (USD), tools (satu string), allowed/disallowed tools (textarea satu-per-baris), setting sources (select multi/teks). Simpan ke `POST /api/projects/:id/settings` dengan kunci di atas; reload memantulkan nilai.
- Katalog command (`LOCAL_COMMANDS`): tambah `goal` (`/goal <syarat>`, "Terus bekerja sampai syarat tercapai"), `loop` (`/loop [interval] [prompt]`, "Ulangi prompt terjadwal"), `fewer-permission-prompts` ("Kurangi prompt izin dengan allowlist") — tanpa handler baru (diteruskan sebagai teks ke Claude); pastikan tidak ada di `CLI_ONLY`.

- [ ] **Step 1–5:** test gagal→lulus (fake server memantulkan settings; mobile+desktop tanpa overflow), commit `git commit -m "Claude flags: dialog per project dan command sisa"`.

---

### Task 6: Matriks adopsi + dokumentasi + rilis 1.0.94

**Files:** buat `docs/adopsi-mesin.md`; modify `docs/design-opencode.md`, `CHANGELOG.md`, `docs/FITUR.md`, `docs/uji-ui.md`, `package.json`, `package-lock.json`

- [ ] **Step 1:** tulis `docs/adopsi-mesin.md` — dua tabel (Claude Code, OpenCode) memetakan **setiap kemampuan** (CLI command, flag, slash command, settings, tool, fitur) → lokasi di Adhitron (dialog/route/perintah) atau **keluar cakupan dengan alasan**; sebut versi dan sumber (code.claude.com/docs, opencode.ai/docs) per baris.
- [ ] **Step 2:** catatan upstream `docs/design-opencode.md` — baris 2.1.328: bentuk hooks, flag print-mode, `/goal` `/loop` `/fewer-permission-prompts` sebagai skill/command yang diteruskan.
- [ ] **Step 3:** `CHANGELOG.md` (`## Belum dirilis`) + `docs/FITUR.md` (Hooks, Flag Claude, command sisa) + `docs/uji-ui.md` (file test baru).
- [ ] **Step 4: Gerbang** — `npm run check`; `npm run test:related -- src/claude-admin.js src/routes/extensions.js src/hub.js src/session.js public/js/features/extensions.js public/js/features/composer.js public/js/features/commands.js`; `node --test test/claude-hooks*.test.mjs test/claude-flags*.test.mjs`; 12 smoke file langsung (Windows) / `npm run test:smoke` di CI.
- [ ] **Step 5: Rilis 1.0.94** — bump versi, promosikan CHANGELOG, commit `Rilis 1.0.94: hooks, flag Claude, dan matriks adopsi`, tag `v1.0.94`, push, pantau workflow sampai GitHub Release terbentuk.

---

## Self-Review

**Spec coverage:** hooks (Task 1–3), flag per project (Task 4–5), `/goal` `/loop` `/fewer-permission-prompts` (Task 5), matriks tuntas (Task 6). `/sandbox`/`/batch`/cloud/terminal-only tetap di luar cakupan (sudah dicatat di spec).
**Type consistency:** `saveHook`/`deleteHook`/`HookError` dipakai route+UI; nama field settings (`claudeFallbackModel`, …) sama di `DEFAULT_SETTINGS`, `cleanSettings`, `restartKey`, spawn, UI, dan test.
**Review Focus:** lima butir punya test di Task 1 (file settings), Task 4 (cleanSettings/spawn/restart), Task 2/5 (scope/mesin/command sisa).
**Proportion:** plan memuat bentuk data, batas, dan test; body ditulis saat eksekusi.
