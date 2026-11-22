# Adopsi tuntas kemampuan Claude Code & OpenCode ke Adhitron — design

Tanggal: 2026-11-22
Status: menunggu persetujuan user (pendekatan A dipilih user)
Sumber riset: `docs/superpowers/research/2026-11-22-inventaris-claude-code.md`,
`docs/superpowers/research/2026-11-22-inventaris-opencode.md` (docs resmi, 2026-11-22;
OpenCode terpasang 2.3.2).

## Kenapa

Tujuan user: **tidak perlu lagi membuka terminal `claude` maupun `opencode`** untuk memakai
kemampuan kedua mesin. Adhitron sudah mengadopsi hampir seluruhnya (lihat `docs/FITUR.md`),
tetapi riset resmi menemukan sejumlah kemampuan yang belum punya tempat di aplikasi — hanya
bisa dipakai kalau mengetik sendiri di CLI, atau lewat editor JSON mentah. Design ini menutup
sisa celah itu.

## Tujuan

- Setiap kemampuan resmi kedua mesin punya jalur di aplikasi: UI/route, bukan sekadar
  "bisa kalau diketik".
- Perubahan **kecil, teruji, dan bisa dirilis** per domain; tidak ada big-bang.
- Konsisten dengan pola repo: aturan murni di `src/` yang bisa dites, teks UI Bahasa Indonesia,
  komentar kode Inggris, TDD, `CHANGELOG.md`/`docs/FITUR.md` diperbarui.

## Non-tujuan

- **Bukan** mengganti mesin atau menyalin seluruh CLI. Aplikasi tetap memanggil `claude`/`opencode`
  di belakang.
- **Bukan** mengejar fitur managed/enterprise (policy MDM, `self-hosted-runner`, `gateway`,
  `remote-control`, `--cloud`/`--teleport`): itu untuk organisasi/cloud, bukan kantor lokal.
- **Bukan** menambah platform deployment baru (share/upload ke cloud, akun OpenCode).

## Anti-tujuan

- Satu rilis raksasa yang lama sebelum ada manfaat terlihat.
- Menambah dependensi npm baru bila bisa dihindari.
- Menyentuh/menghapus data project user atau config mesin tanpa izin.

## Batasan & jebakan

- Windows + PowerShell; Node >= 20 ESM; tanpa framework/bundler.
- Gerbang: `npm run check`, `npm run test:related -- <file>`, `npm run test:smoke` bila menyentuh
  server, area UI relevan bila menyentuh `public/`.
- Kegagalan **pra-ada** yang dikecualikan (jangan "diperbaiki" tanpa diminta):
  `test/opencode.test.mjs:499` (mcp-add), audit UI desktop 1440×900, flaky
  `opencode-background-real`. Bug `test:smoke` di Windows (separator path) pra-ada.
- OpenCode 2.3.2: `experimental.todo` off, `external_directory` default allow, `request` agent
  disimpan tapi belum dikirim. Jangan membuat fake meniru frame yang tak pernah dikirim mesin.

## Pendekatan (dibahas & dipilih user)

- **A — Sisir per domain, satu rilis kecil per langkah (dipilih).** Terasa cepat, aman, mudah
  dibatalkan, mudah di-review. Rugi: beberapa rilis.
- **B — Satu "Pusat Ekstensi" besar.** Koheren tapi lama, permukaan bug besar, sulit di-review.
- **C — Lapisan tipis passthrough JSON saja.** Murah tapi tidak "tanpa terminal" — bertentangan
  dengan tujuan user.

## Keputusan setelah review architect (2026-11-22)

Review menemukan koreksi penting yang sudah dimasukkan ke rencana di bawah:

- **Worktree dikelola aplikasi, bukan mesin.** OpenCode tidak punya perintah CLI `worktree`
  (hanya tool Code Mode/plugin); `claude --worktree` di mode headless `-p` belum terbukti. Karena
  itu aplikasi menjalankan `git worktree add/remove/list` sendiri (`src/worktree.js`), lalu
  **mengarahkan cwd sesi** ke hasilnya — seragam untuk kedua mesin dan tidak bergantung pada flag
  yang belum terverifikasi. Bila jalur engine ingin dipakai, probe dulu dan catat di
  `docs/design-opencode.md → Catatan upstream`.
- **Model "cwd aktif" jadi prasyarat.** Hari ini cwd sesi = identitas project
  (`src/session.js` spawn `cwd: this.project.path`, `src/acp-session.js`, `src/util.js` `projectId`,
  `server.js` `insideKnownProjectDir`, mirror `src/mirror.js` `upsertProject(entry.cwd)`). Perlu
  `workspacePath` eksplisit di sesi (default `project.path`, ikut `restartKey`), dan folder di bawah
  `.claude/worktrees/` **tidak boleh** menerbitkan project baru. Worktree = **atribut project**,
  bukan project baru.
- **Dependensi fase:** Fase 4 (`/skills`) bergantung pada Fase 2 (daftar skill); Fase 3 paling rapi
  setelah Fase 1; bagian memory/`.claude/rules/` dipindah dari Fase 6 ke dekat Fase 2.
- **Cakupan ditinjau ulang** (lihat daftar fase): `/sandbox` dan `/batch` keluar (Windows native
  tidak di-sandbox; `/batch` mahal & bergantung Fase 1). Hooks/flag Claude, plugin/provider/
  instructions OpenCode masuk sebagai butir eksplisit.

## Rencana bertahap (tiap fase = satu siklus rilis)

Urutan dipilih agar manfaat yang paling sering dipakai datang lebih dulu. Setiap fase mendapat
plan implementasi sendiri (`writing-plans`) sebelum dikerjakan.

**Fase 1 — Worktree (dikelola aplikasi, untuk kedua mesin).**
- `src/worktree.js` (aturan murni): validasi nama/branch, deteksi repo git, path
  `.claude/worktrees/<name>`, guard non-git; jalankan `git worktree add/remove/list`.
- **Prasyarat di fase yang sama:** `workspacePath` eksplisit di sesi (default `project.path`,
  masuk `restartKey`); folder `.claude/worktrees/**` dikecualikan dari `discoverProjects`/
  `insideKnownProjectDir`/mirror agar tidak lahir project baru; pindah worktree = respawn bersih
  (jangan `--resume` lintas cwd tanpa probe).
- UI: dialog dari tab Perubahan/menu ⋯ project; status worktree di bar sesi; hapus butuh `force`
  bila ada perubahan; tolak (409) saat bukan git atau ada giliran berjalan (pola `opencode-config`).

**Fase 2 — Skills (dua mesin) + memory lanjutan.**
- Pengelola `.claude/skills/` + `.opencode/skills/` (dan lokasi global): lihat, buat, edit, hapus
  `SKILL.md` + file pendukung; munculkan `description`/`name`.
- Route baru `src/routes/skills.js`, aturan murni penguraian frontmatter + validasi id.
- Laptop-only untuk scope global (pola subagent/plugin); backup sebelum menulis (pola
  `opencode-config-backups/`); security review karena menulis file ke folder project/user.
- Ikut di fase ini: **auto memory & `.claude/rules/`** di editor memory (`src/routes/memory.js`),
  karena berbagi area yang sama.

**Fase 3 — Folder tambahan & References (setelah Fase 1).**
- Claude `additionalDirectories` per project: pakai ulang abstraksi path/validasi dari Fase 1.
- OpenCode References (path lokal + repo Git sebagai sumber bernama) di editor config/agent.

**Fase 4 — Output style & `/skills` (setelah Fase 2).**
- Output style Claude: pilih/buat dari aplikasi (tak lagi "atur dari terminal").
- Tampilkan daftar skill yang termuat (`/skills`) pada kedua mesin — memakai daftar Fase 2.

**Fase 5 — Sisa OpenCode.**
- Commands (`.opencode/commands`), Policies (hard-deny; butuh OpenCode ≥ 2.2.3, websearch.use
  ≥ 2.2.6 — probe & catat), **plugins** (add/list/check/update/remove — menyamai UI plugin Claude),
  **providers/model variants** (`#variant`, headers/body), **`instructions` array**, websearch
  provider, dan config lanjutan (`compaction`, `warming`, `formatter`, `snapshots`, `watcher`,
  `media`, `tool_output`, `experimental.*`) via form (Tab JSON tetap ada).

**Fase 6 — Minor Claude.**
- Pengelolaan **hooks** Claude (minimal tambah/ubah/hapus, bukan sekadar lihat) — atau catat tegas
  sebagai di luar cakupan sadar bila dinilai terlalu besar.
- Flag per project: `--fallback-model`, `--max-turns`, `--max-budget-usd`,
  `--tools`/`--allowedTools`/`--disallowedTools`, `--setting-sources`.
- `/goal`, `/loop`, `/fewer-permission-prompts` (kemungkinan cukup diteruskan sebagai teks command;
  cek dulu di plan).

**Keluar dari cakupan (sadar):** `/sandbox` (Windows native tak di-sandbox, nilai ~0 di sini),
`/batch` (memicu 5–30 subagent worktree — mahal, bergantung Fase 1), dan seperti sebelumnya:
`opencode uninstall/share/run/service get-set-unset/debug heap-dump/mini/serve/acp/api/pair/ci`;
command Claude yang hanya membuka layar terminal; managed/enterprise policy; cloud/teleport.

## Definisi selesai tiap fase (wajib, dari AGENTS.md)

Tiap plan fase memuat checklist ini:

- **Test gagal-dulu** (aturan murni di `src/`), `npm run check` hijau,
  `npm run test:related -- <file>`, `npm run test:smoke` bila menyentuh server/sesi/izin,
  dan `npm run test:ui:area -- "<blok>"` bila menyentuh `public/`.
- **Probe upstream + catat** tanggal/versi di `docs/design-opencode.md → Catatan upstream` sebelum
  workaround/fitur menyentuh Claude/OpenCode (Fase 1 `--worktree`; Fase 5 policies/websearch
  dengan versi minimum 2.2.3/2.2.6).
- **`test-support/fake-acp.mjs` hanya meniru frame yang benar-benar dikirim mesin**; sebut
  sumbernya; jangan bikin fake menebak.
- **Edge case murni per fase**: Fase 1 (nama worktree, guard non-git), Fase 2 (frontmatter rusak,
  id skill), Fase 3 (path absolut/UNC/jaringan).
- **Update `CHANGELOG.md` (bagian "Belum dirilis") + `docs/FITUR.md`**; `docs/design-opencode.md`
  bila menyentuh OpenCode.
- **Kebijakan laptop-only** konsisten untuk yang menulis config/skill global.
- **Security/compliance review** untuk fase yang menulis file (Fase 2, 3, 5) atau menyentuh izin;
  **backup sebelum menulis config/skill** mengikuti pola `opencode-config-backups/`.
- **Isolasi data test**: jalankan lewat `npm run …`; jangan menyentuh instalasi/env `OFFICE_*` asli.

## Yang diserahkan ke builder

- Rincian UI tiap fase (dialog vs panel), penamaan route, dan bentuk test — diputuskan di plan
  masing-masing fase.
- Fase boleh dipecah lagi atau urutannya digeser bila satu fase ternyata bergantung pada fase lain
  (mis. Skills dan Output style menyentuh area tampilan yang mirip).
- Setiap fase wajib punya test yang gagal dulu, dan memperbarui `CHANGELOG.md` + `docs/FITUR.md`.

## Test yang diharapkan (per fase, TDD)

Contoh untuk Fase 1 (paling konkret): test murni untuk validasi nama/path/branch worktree dan
guard non-git; test integrasi route worktree (spawn `claude`/`opencode` palsu seperti pola
`test-support/fake-acp.mjs`); verifikasi manual di Windows. Fase lain mengikuti pola serupa;
rinciannya di plan tiap fase.