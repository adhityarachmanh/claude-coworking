# Inventaris Kemampuan Resmi Claude Code

Riset dari dokumentasi resmi (code.claude.com/docs). Satu baris per item. Label Bahasa Indonesia.
Tanggal: 2026-11-22.

---

## 1. Perintah CLI (commands)

- `claude` — mulai sesi interaktif di direktori kerja.
- `claude -p "<prompt>"` — mode non-interaktif/headless (print lalu keluar).
- `claude -c` / `--continue` — lanjutkan sesi terakhir di direktori itu.
- `claude -r` / `--resume [session]` — pilih dan lanjutkan sesi tersimpan.
- `claude update` — perbarui Claude Code ke versi terbaru.
- `claude install` — pasang/atur instalasi Claude Code.
- `claude auth login|logout|status` — kelola otentikasi akun.
- `claude agents` — buka agent view (pantau/kelola sesi background).
- `claude attach <id>` — lampirkan terminal ke sesi background.
- `claude auto-mode defaults|reset` — kelola bawaan auto mode.
- `claude daemon logs|run|status|stop` — kelola proses daemon.
- `claude doctor` — diagnosa kesehatan instalasi.
- `claude import` — impor konfigurasi/sesi.
- `claude logs` — lihat log.
- `claude mcp` — kelola server MCP.
- `claude mcp login|logout` — otentikasi server MCP (OAuth).
- `claude plugin` (alias `plugins`) — kelola plugin.
- `claude purge` — bersihkan data lokal.
- `claude remote-control` — kendalikan sesi jarak jauh.
- `claude respawn` — jalankan ulang proses.
- `claude rm` — hapus sesi/artefak.
- `claude self-hosted-runner` — runner yang dihosting sendiri.
- `claude setup-token` — buat token setup.
- `claude stop` (alias `kill`) — hentikan sesi.
- `claude ultrareview` — tinjauan kode tingkat lanjut.
- `claude gateway` — jalankan lewat LLM gateway.

**Sumber:** https://code.claude.com/docs/en/cli-reference.md

---

## 2. Flag CLI penting

- `--add-dir <dir>` — tambah direktori kerja tambahan (akses file, bukan konfigurasi).
- `--agents <json>` — definisikan subagent inline.
- `--allowedTools` / `--disallowedTools` — allowlist/denylist tool.
- `--model <alias|name>` — pilih model.
- `--permission-mode <mode>` — mode izin: `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`/`manual`.
- `--output-format text|json|stream-json` — format keluaran.
- `--input-format` — format masukan.
- `--settings <json|file>` — override setting untuk satu sesi.
- `--setting-sources` — batasi sumber setting yang dimuat.
- `--mcp-config <file>` — arahkan file konfigurasi MCP.
- `--strict-mcp-config` — hanya pakai MCP dari `--mcp-config`.
- `--plugin-dir` / `--plugin-url` — muat plugin dari direktori/URL.
- `--dangerously-skip-permissions` — lewati semua prompt izin (container/VM terisolasi saja).
- `--allow-dangerously-skip-permissions` — izinkan mode bypass di sesi.
- `--dangerously-load-development-channels` — muat channel pengembangan.
- `--system-prompt` / `--append-system-prompt` (+`-file`) — ganti/tambah system prompt.
- `--json-schema` — paksa keluaran sesuai skema JSON.
- `--max-turns <n>` — batas jumlah giliran.
- `--max-budget-usd <n>` — batas anggaran biaya.
- `--fork-session` — bercabang dari sesi saat dilanjutkan.
- `--worktree` / `-w [name]` — jalankan dalam git worktree terisolasi.
- `--tmux` — jalankan dalam tmux.
- `--bg` / `--background` — langsung ke sesi background.
- `--tools` — tool yang tersedia.
- `--restricted` / `--safe-mode` — mode aman/terbatas (kustomisasi mati).
- `--bare` — mode minimalis.
- `--verbose` — keluaran rinci.
- `--session-id` — tetapkan id sesi.
- `--effort <level>` — tingkat usaha model.
- `--fallback-model` — model cadangan.
- `--channels` — aktifkan channel (notifikasi/remote).
- `--cloud` / `--teleport` — jalankan di cloud / pindahkan sesi.
- `--debug` / `--debug-file` — mode debug dan berkas log debug.
- `--name` / `-n` — nama sesi.
- `--version` / `-v` — tampilkan versi.
- `--teammate-mode auto|tmux|iterm2` — mode tampilan teammate (eksperimental).

**Sumber:** https://code.claude.com/docs/en/cli-reference.md

---

## 3. Slash Commands bawaan (di sesi)

- `/init` — buat/inisialisasi CLAUDE.md untuk proyek.
- `/memory` — lihat/edit memori (CLAUDE.md, memori otomatis).
- `/model` — ganti model.
- `/effort` — atur tingkat usaha model.
- `/fast` — aktifkan matikan fast mode.
- `/context` — lihat pemakaian konteks.
- `/compact` — ringkas percakapan untuk menghemat konteks.
- `/clear` — bersihkan percakapan.
- `/resume` — buka sesi tersimpan.
- `/branch` — bercabang sesi baru.
- `/fork` — salin percakapan ke sesi background baru.
- `/subtask` — jalankan subagent fork (dengan konteks penuh).
- `/rewind` (alias `/checkpoint`, `/undo`) — menu restore kode/percakapan dan ringkas.
- `/diff` — tinjau perubahan.
- `/code-review` (alias `/review`) — tinjauan kode.
- `/security-review` — tinjauan keamanan.
- `/permissions` (alias `/allowed-tools`) — kelola rule izin.
- `/plan` — masuk/kelola plan mode.
- `/plugin` — kelola plugin.
- `/mcp` — kelola server MCP (list/enable/disable/reconnect).
- `/agents` — kelola subagent.
- `/hooks` — kelola hooks.
- `/config` (alias `/settings`) — buka pengaturan.
- `/doctor` (alias `/checkup`) — diagnosa konfigurasi.
- `/status` — status sesi.
- `/usage` (alias `/cost`, `/stats`) — pemakaian/biaya.
- `/export` — ekspor transkrip.
- `/add-dir` — tambah direktori.
- `/cd` — ganti direktori kerja.
- `/tasks` (alias `/bashes`) — kelola tugas/shell background.
- `/background` (alias `/bg`) — pindahkan sesi ke background.
- `/goal` — tetapkan tujuan sesi.
- `/loop` (alias `/proactive`) — tugaskan tugas berulang terjadwal.
- `/sandbox` — konfigurasi sandbox Bash.
- `/theme` — tema tampilan.
- `/tui` — pengaturan antarmuka terminal.
- `/color` — warna sesi (dipakai di agent view).
- `/exit` (alias `/quit`) — keluar.
- `/login` / `/logout` — masuk/keluar akun.
- `/skills` — kelola skills.
- `/fewer-permission-prompts` — bantu kurangi prompt izin.
- `/batch` — pecah satu perubahan besar menjadi 5–30 subagent terisolasi worktree.
- `/deep-research` — riset mendalam.
- `/design` — bantu desain.
- `/simplify` — sederhanakan kode.
- `/run` — jalankan proyek.
- `/reload-plugins` / `/reload-skills` — muat ulang plugin/skills.
- `/btw` — pertanyaan sampingan (overlay).
- `/stop` — hentikan sesi (dari agent view/peek).
- `/install-github-app` — pasang integrasi GitHub.
- `/debug` — mode debug.

**Sumber:** https://code.claude.com/docs/en/commands.md

---

## 4. Settings / Konfigurasi

- Scope User: `~/.claude/settings.json` — pengaturan pribadi lintas proyek.
- Scope Shared project: `.claude/settings.json` — dibagikan lewat repo.
- Scope Project local: `.claude/settings.local.json` — lokal, tidak di-commit.
- Scope Managed: `managed-settings.json` — dikelola organisasi (MDM/server-managed).
- Berkas global: `~/.claude.json` (`.claude.json`) — konfigurasi global.
- Presedensi: managed → command line (`--settings`) → project local → shared project → user.
- Perilaku merge: daftar digabung; sebagian kunci override (`fallbackModel`, `modelPicker`, `availableModels`, `modelSettings`).
- `$schema` — dukungan skema JSON untuk autocomplete/validasi.
- `CLAUDE_CONFIG_DIR` — mengalihkan lokasi `~/.claude`.
- `defaultToAgentsView` — buka agent view saat `claude` tanpa argumen.
- `teammateMode` (`auto`/`tmux`/`iterm2`) — mode tampilan agent teams.
- `preferredNotifChannel` — channel notifikasi terminal.
- `cleanupPeriodDays` — berapa lama artefak/snapshot disimpan.
- `prefersReducedMotion` / `copyOnSelect` / `leftArrowOpensAgents` / `subagentPromptCacheTtl` — preferensi UI/perilaku.
- `permissions.blockReadsOutsideWorkingDirectories` / `permissions.blockWritesOutsideWorkingDirectories` — batasi baca/tulis di luar direktori kerja.
- `env` — set variabel environment lewat settings.

**Sumber:** https://code.claude.com/docs/en/settings.md

---

## 5. Permissions (Izin)

- Rule `allow` / `ask` / `deny` — dievaluasi urut: deny → ask → allow.
- Sintaks `Tool` — cocokkan tool apa pun.
- Sintaks `Tool(specifier)` — cocokkan tool dengan pola argumen.
- Wildcard `*` dan `:*` — pencocokan longgar argumen.
- Param match `Tool(param:value)` — cocokkan field argumen tertentu.
- Bare tool name — hapus tool dari konteks.
- Read/Edit memakai sintaks gitignore (negasi `!`, absolut `//`, home `~/`, anchor `/`).
- Bash rule dibatasi teks perintah; enforcement jaringan sebaiknya lewat sandbox.
- Mode `default` — manual, hanya baca dalam direktori kerja tanpa prompt.
- Mode `acceptEdits` — auto-approve edit file + perintah fs umum (`mkdir`, `touch`, `rm`, `mv`, `cp`, `sed`).
- Mode `plan` — baca + perintah yang lolos classifier saat auto mode tersedia.
- Mode `auto` — semua tindakan dengan pemeriksaan classifier di belakang.
- Mode `dontAsk` — hanya tool pra-disetujui; yang butuh prompt ditolak.
- Mode `bypassPermissions` — semua tanpa prompt (hanya container/VM terisolasi).
- Workspace trust dialog — konfirmasi folder belum dipercaya sebelum jalan.
- Read-only commands (`ls`, `cat`, `git status`, dll.) — berjalan tanpa prompt.
- Aturan izin dari hook `PreToolUse` bisa `allow`/`deny`/minta persetujuan.
- Beberapa tindakan tak pernah auto-approve (rule ask, tool interaktif, `rm` critical path, dll.).

**Sumber:** https://code.claude.com/docs/en/permissions.md, https://code.claude.com/docs/en/permission-modes.md

---

## 6. Hooks (Event)

- `SessionStart` — saat sesi mulai.
- `Setup` — tahap setup.
- `UserPromptSubmit` — saat prompt user dikirim.
- `UserPromptExpansion` — saat prompt user diekspansi.
- `PreToolUse` — sebelum tool dijalankan (bisa allow/deny).
- `PermissionRequest` — saat permintaan izin muncul.
- `PermissionDenied` — saat izin ditolak.
- `PostToolUse` — setelah tool sukses.
- `PostToolUseFailure` — setelah tool gagal.
- `PostToolBatch` — setelah batch tool.
- `Notification` — saat notifikasi dikirim.
- `MessageDisplay` — saat pesan ditampilkan.
- `SubagentStart` / `SubagentStop` — sekitar siklus subagent.
- `TaskCreated` / `TaskCompleted` — saat task dibuat/selesai (agent teams).
- `TeammateIdle` — saat teammate akan idle.
- `Stop` / `StopFailure` — saat Claude berhenti (sukses/gagal).
- `InstructionsLoaded` — saat instruksi dimuat.
- `ConfigChange` — saat konfigurasi berubah.
- `CwdChanged` / `DirectoryAdded` — saat direktori kerja berubah/ditambah.
- `FileChanged` — saat berkas berubah.
- `WorktreeCreate` / `WorktreeRemove` — saat worktree dibuat/dihapus.
- `PreCompact` / `PostCompact` — sekitar compact.
- `PreModelSwitch` / `PostModelSwitch` — sekitar ganti model.
- `Elicitation` / `ElicitationResult` — permintaan masukan (MCP elicitation).
- `SessionEnd` — saat sesi berakhir.
- Tipe handler: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- Matcher + kondisi `if` (memakai sintaks rule izin).
- Lokasi: user / project / local / managed settings, `hooks/hooks.json` plugin, frontmatter skill & subagent.

**Sumber:** https://code.claude.com/docs/en/hooks.md

---

## 7. MCP (Model Context Protocol)

- Transport `stdio` — server lokal lewat stdin/stdout.
- Transport `sse` (deprecated) — Server-Sent Events.
- Transport `http` (streamable-http) — HTTP jarak jauh.
- Transport `ws` — WebSocket.
- Scope `local` (default) — hanya untuk user di proyek itu.
- Scope `project` — `.mcp.json` dibagikan lewat repo.
- Scope `user` — tersedia lintas proyek.
- Perintah: `claude mcp add`, `add-json`, `list`, `get`, `remove`, `login`, `logout`.
- Timeout: `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, dan `timeout` per-server.
- Otentikasi OAuth didukung.
- Channels (`--channels`) untuk notifikasi/remote.
- Penamaan tool: `mcp__<server>__<tool>`.
- Runtime v1/v2 lewat `MCP_SDK_GENERATION`.
- Organization controls pada connector tools (bisa diset `ask`).
- Elicitation: server MCP minta masukan ke user.
- Tool MCP bisa ditandai `requiresUserInteraction`.

**Sumber:** https://code.claude.com/docs/en/mcp.md

---

## 8. Plugins

- Plugin = direktori berisi skills, agents, hooks, MCP servers, atau komponen lain yang dimuat sebagai satu unit.
- Marketplace = katalog yang mendaftar plugin dan lokasi fetch-nya.
- Plugin bisa dimuat dari folder maupun dikembangkan sendiri.
- `plugin.json` di dalam `.claude-plugin/` — manifest plugin (metadata + `userConfig`).
- `userConfig` — nilai konfigurasi yang diminta ke user saat instalasi.
- Fields manifest: path komponen (standar/override), versi, deskripsi.
- Referensi CLI plugin, manifest, dan marketplace tersedia terpisah.
- Mod = plugin yang menyetel perilaku tertentu (mis. `agent.spawn` hook memilih model).

**Sumber:** https://code.claude.com/docs/en/plugins/overview.md, https://code.claude.com/docs/en/plugins/manifest-reference.md

---

## 9. Subagents (Subagent kustom)

- Subagent = asisten AI khusus dengan context window, system prompt, akses tool, dan izin sendiri.
- Delegasi otomatis saat task cocok dengan deskripsi subagent.
- Request subagent dihitung ke limit pemakaian akun yang sama.
- Definisi di `.claude/agents/` (project), user, managed, atau plugin.
- Frontmatter mendukung `tools`, `disallowedTools`, `model`, `effort`, `autoCompactWindow`, `skills`, `mcpServers`, `background`.
- `context: fork` — skill berjalan sebagai subagent (foreground fork restorasi via rewind).
- Fork subagent — subagent mewarisi konteks percakapan penuh (dipicu `/subtask`).
- `subagentPromptCacheTtl` (mis. `1h`) — perpanjang cache prompt subagent.
- Nama subagent memungkinkan mereka saling mengirim pesan (`SendMessage`).
- `CLAUDE_CODE_SUBAGENT_MODEL` — set model semua subagent.

**Sumber:** https://code.claude.com/docs/en/sub-agents.md

---

## 10. Skills

- Skill = `SKILL.md` berisi instruksi yang dimuat saat relevan.
- Dipanggil otomatis saat relevan atau manual via `/skill-name`.
- Custom commands lama (`.claude/commands/`) sudah digabung ke skills (tetap kompatibel).
- Isi skill hanya dimuat saat dipakai (hemat konteks dibanding CLAUDE.md).
- Bisa dijalankan sebagai subagent (`context: fork`) dengan kontrol `background`.
- Bisa pakai tool terbatas dan model tersendiri.
- Bundled skills bawaan: `/debug`, `/code-review`, `/batch`, `/deep-research`, `/design`, `/simplify`, dll.
- `skills` pada subagent/teammate: teammate memuat dari project & user settings.

**Sumber:** https://code.claude.com/docs/en/skills.md

---

## 11. Memory (Memori Proyek)

- `CLAUDE.md` — instruksi persisten buatan user.
- `AGENTS.md` — alternatif yang dibaca Claude sebagai instruksi proyek.
- Auto memory — catatan yang ditulis Claude sendiri dari koreksi/preferensi user.
- `.claude/rules/` — aturan yang dicakup per tipe file.
- CLAUDE.md bisa bersarang per direktori (konteks sesuai lokasi).
- `/memory` — lihat/edit memori.
- Preferensi training data dapat diatur user.

**Sumber:** https://code.claude.com/docs/en/memory.md

---

## 12. Output Styles

- Output style = instruksi yang mengatur peran, nada, dan format respons untuk satu sesi.
- Empat gaya bawaan selain default (mis. Concise, Explanatory).
- Bisa dibuat kustom (bahkan mengubah Claude menjadi non-engineer, mis. penulis/analis data).
- Berguna agar tidak mengulang instruksi gaya di setiap prompt.

**Sumber:** https://code.claude.com/docs/en/output-styles.md

---

## 13. Checkpointing (Rewind & Summarize)

- Checkpoint otomatis dibuat setiap prompt yang memulai giliran.
- Snapshot disimpan untuk 100 checkpoint terakhir per sesi.
- `/rewind` (alias `/undo`) atau `Esc` dua kali (input kosong) membuka menu rewind.
- Aksi: Restore code and conversation; Restore conversation; Restore code; Summarize from here; Summarize up to here; Never mind.
- Checkpoint tersimpan bersama percakapan (bisa rewind setelah resume).
- Snapshot dihapus oleh retention sweep (~30 hari, atur `cleanupPeriodDays`).
- Batasan: perubahan via Bash tidak dilacak; edit subagent non-fork tidak direstorasi; perubahan luar sesi tidak dilacak; symlink/hardlink dilewati; bukan pengganti version control.

**Sumber:** https://code.claude.com/docs/en/checkpointing.md

---

## 14. Background Tasks, Agent View & Agent Teams

- Sesi background = percakapan Claude Code penuh yang jalan tanpa terminal terpaut.
- `claude agents` — agent view: satu layar untuk dispatch & pantau sesi background.
- `--bg` / `--background` — jalankan sesi langsung ke background.
- `/background` (alias `/bg`) — pindahkan sesi aktif ke background.
- `/fork` — salin sesi aktif ke sesi background baru.
- Supervisor process — menjalankan sesi background meski shell/terminal ditutup.
- State baris: Working / Needs input / Idle / Completed / Failed / Stopped.
- Filter: `a:<name>`, `s:<state>`, `n:<text>`, `o:<text>`, nomor/URL PR.
- `claude agents --json` — baca state sesi dari skrip.
- Peek panel (`Space`) — lihat/reply tanpa lampirkan; `→`/`Enter` lampirkan.
- Agent teams (eksperimental, off by default) — aktif lewat `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- Agent team = team lead + teammates + shared task list + mailbox.
- Display mode: in-process (dalam terminal) atau split panes (butuh tmux/iTerm2 `it2`).
- Mailbox: `~/.claude/teams/{team}/inboxes/{agent}.json`.
- Team config: `~/.claude/teams/{team}/config.json`; task list: `~/.claude/tasks/{team}/`.
- Task status: pending, in progress, completed; bisa saling bergantung (blocked).
- Komunikasi antar-agent lewat `SendMessage`; approval tidak bisa dialihkan antar-agent.
- Batasan agent teams: tanpa resume in-process teammate, status task bisa lag, shutdown lambat, satu team per sesi, tanpa nested team, tanpa subagent background dari teammate in-process, lead tetap.

**Sumber:** https://code.claude.com/docs/en/agent-view.md, https://code.claude.com/docs/en/agent-teams.md, https://code.claude.com/docs/en/agents.md

---

## 15. Model Config

- Alias model: `default`, `best` (=opus), `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`.
- `opusplan` — pakai opus saat plan mode, lalu sonnet saat eksekusi.
- Nama model penuh (mis. `claude-opus-5-5`) untuk pin versi.
- Env var: `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
- `ANTHROPIC_BASE_URL` — ubah tujuan request (bukan pemilih model).
- Effort level (`/effort`, `--effort`) — atur tingkat usaha model.
- Extended context `[1m]` — konteks 1 juta token untuk sesi panjang.
- Auto-compact window — atur jendela auto compact.
- `/model` — ganti model di sesi; `/fast` — fast mode.
- Restriksi model organisasi: `availableModels` allowlist.

**Sumber:** https://code.claude.com/docs/en/model-config.md

---

## 16. Security & Sandbox

- Arsitektur berbasis izin (permission-based) sebagai fondasi keamanan.
- Sandboxed Bash tool — isolasi filesystem & jaringan untuk perintah shell (macOS/Linux/WSL2; Windows native tidak di-sandbox).
- Sandbox mode: `auto-allow` bisa jalankan tanpa prompt; tetap lewat alur izin biasa.
- Cakupan sandbox: hanya perintah shell; file tools, MCP, hooks berjalan di luar sandbox.
- Filesystem isolation — batasi path yang bisa diakses perintah.
- Network isolation — batasi domain jaringan (enforcement tak bergantung teks perintah).
- Working directory boundary — prompt saat file tools keluar folder (Manual mode).
- Accept Edits mode — auto-approve edit + perintah fs umum di dalam working directory.
- Proteksi prompt injection: sistem izin, approval perintah jaringan (`curl`/`wget`), deny rule.
- WebFetch — halaman dibaca model terpisah lalu diringkas, bukan mentah.
- Trust verification — workspace trust dialog + approval `.mcp.json`.
- Kebijakan privasi/retensi lewat Anthropic Privacy Center & Terms.
- Kepatuhan: SOC 2 Type 2, ISO 27001 (Anthropic Trust Center).
- Tanggung jawab user untuk meninjau kode/perintah sebelum disetujui.

**Sumber:** https://code.claude.com/docs/en/security.md, https://code.claude.com/docs/en/sandboxing.md

---

## 17. Worktrees (Sesi Paralel)

- `claude --worktree <name>` (`-w`) — buat worktree dan mulai sesi di dalamnya.
- Default path `.claude/worktrees/<name>/`, branch `worktree-<name>`.
- Nama otomatis (mis. `bright-running-fox`) bila nama tidak diberikan.
- `.worktreeinclude` — salin berkas gitignored (mis. `.env`) ke tiap worktree.
- Tool `EnterWorktree` / `ExitWorktree` — pindah worktree dalam sesi.
- Isolasi subagent dengan worktree.
- Hook: `${CLAUDE_PROJECT_DIR}` tetap di root proyek; `cwd` mengikuti worktree.
- Non-git VCS: konfigurasi hooks untuk menggantikan logika git.
- Cleanup worktree saat keluar; resume sesi worktree didukung.

**Sumber:** https://code.claude.com/docs/en/worktrees.md

---

## Catatan

- Semua halaman diambil dari dokumentasi resmi (code.claude.com/docs) via indeks `https://code.claude.com/docs/llms.txt`.
- Tidak ada domain yang "(tidak ditemukan)"; seluruh halaman di atas tersedia.