# Matriks Adopsi Mesin (Claude Code & OpenCode)

Tujuan Adhitron: mengoperasikan Claude Code dan OpenCode dari aplikasi tanpa CLI. Dokumen ini memetakan **setiap kemampuan** kedua mesin ke tempatnya di Adhitron, atau menandainya **di luar cakupan** dengan alasan. Versi terpasang saat ditulis: **Claude Code 2.1.331**, **OpenCode 2.4.1**.

Sumber otoritatif: https://code.claude.com/docs (cli-reference, commands, hooks, settings, permissions, skills, output-styles, plugins, sub-agents, mcp, agent-view, worktrees, goal, scheduled-tasks, ultrareview) dan https://opencode.ai/docs (config, commands, policies, permissions, skills, plugins, providers, websearch, mcp-servers, cli). Ditinjau ulang 2026-11-24.

Status: ✅ = diadopsi (disebut lokasinya) · 🚫 = di luar cakupan sadar (disebut alasannya).

## Claude Code

| Kemampuan | Di Adhitron | Status |
|---|---|---|
| Sesi & prompt (`claude -p`, resume, lanjut) | kotak pesan, Antrian, Riwayat/Riwayat Sesi, ▶ Lanjutkan | ✅ |
| Login/logout akun (`claude auth login/logout`) | 👤 Akun: login **in-app** (Claude.ai, **Console/API**, **SSO**), kode dari browser ditempel di dialog, logout; status/kadaluarsa login terlihat | ✅ |
| Model, effort, Mode tim | Pengaturan giliran (⚙), chip model/effort, /model /effort | ✅ |
| Mode izin (Build/Plan/Auto + deny) | Mode (Shift+Tab), Aturan izin. `acceptEdits` dipetakan ke Build (auto-edit) dan `dontAsk` ke Plan (menolak semua yang bertanya), jadi mode Claude tidak muncul mentah di UI | ✅ |
| Permission rules (allow/ask/deny) | Aturan izin (`/permissions`), kartu izin | ✅ |
| Working dir & folder tambahan | 📂 Folder tambahan (`--add-dir`); untuk OpenCode lewat ACP `additionalDirectories` | ✅ |
| Memory (CLAUDE.md, rules, auto memory) | Editor Memory (`/memory`) | ✅ |
| Skills | 🧩 Skills (`/skills`) | ✅ |
| Output styles | 🎭 Output style (`/output-style`) | ✅ |
| Subagents (`.claude/agents`) | 🤖 Subagent (menu/`/agents`) | ✅ |
| Plugins | 🧩 Plugin di dialog **Ekstensi** (menu/`/plugin`): marketplace (pasang, aktif/nonaktif, **update**, hapus), **ℹ Detail** (komponen + biaya token), **⚙ Opsi** (`userConfig`, nilai lewat stdin), **marketplace terdaftar** (tambah/update/hapus) dan **prune** dependensi yatim (pratinjau `--dry-run` lalu `-y`) | ✅ |
| Hooks | 🪝 Hooks (menu/`/hooks`) — lihat, tambah, ubah, hapus | ✅ |
| MCP servers | 🔌 MCP (`/mcp`): tambah lokal/remote, **header HTTP**, transport HTTP/SSE, status/reconnect/disable/login, **logout** (hapus kredensial OAuth) | ✅ |
| Rewind/checkpoint & ringkas | ⏪ Rewind, 🧹 Ringkas | ✅ |
| Tugas latar | ⧗ Tugas latar (`/tasks`), Monitor: shell dan subagent milik sesi app | ✅ |
| Agent view / sesi latar Claude (`claude agents --json`, stop/rm/respawn/logs, `daemon status`, `daemon.log`) | ⋯ → **🖥 Sesi latar Claude**: daftar lintas project (`--json --all`), state/status/waitingFor, stop, respawn, rm, log sesi, status daemon, dan **log daemon**. **Attach/balas tetap terminal** (TUI agent view) | ✅ (kecuali attach) |
| Worktree (`claude -w`) | ⎇ Worktree (menu) | ✅ |
| PR (`gh`) | 🧩 Pull request | ✅ |
| `/goal`, `/loop`, `/fewer-permission-prompts` | diteruskan sebagai command (katalog `/goal`, `/loop`, `/fewer-permission-prompts`) | ✅ |
| `/code-review` (lokal, base/PR/path) | diteruskan sebagai command (katalog `/code-review`); hasil review muncul di chat | ✅ |
| `claude ultrareview` / `/code-review ultra` | 🚫 review **cloud berbayar**: butuh login claude.ai, mengunggah repo ke sandbox Anthropic, 3 run gratis lalu $5–25 per review, 5–15 menit, dan `-p` keluar sebelum temuan datang (docs: pakai subcommand). Bukan operasi lokal; tetap lewat terminal bila diperlukan | 🚫 |
| `/btw`, `/recap`, `/insights` | diteruskan sebagai command (katalog); hasilnya muncul di chat, tanpa panel khusus | ✅ |
| Flag `--fallback-model`, `--max-turns`, `--max-budget-usd`, `--tools`, `--allowedTools`, `--disallowedTools`, `--setting-sources`, **`--plugin-dir`/`--plugin-url`** (plugin sesi) | ⚙️ Flag Claude (menu) → setelan project → spawn | ✅ |
| `--advisor` (model penasihat) | ⚙️ Flag Claude → **Model advisor** → `--advisor` | ✅ |
| `/fast` (fast mode) | ⚙️ Flag Claude → **Fast mode** → `--settings` `{"fastMode":true}` (flag `/fast` hanya untuk sesi interaktif) | ✅ |
| `--prompt-suggestions` | ⚙️ Flag Claude → **Saran prompt berikutnya**; bar “Saran berikutnya” di atas kotak pesan mengisi kotak, tidak mengirim sendiri | ✅ |
| `--autocompact <auto\|tokens>` | ⚙️ Flag Claude → **Auto-compact** (`auto`/`500k`, minimal 100k) → `--autocompact` | ✅ |
| `--include-hook-events` | ⚙️ Flag Claude → **Event hook di chat** → hook yang gagal muncul sebagai baris peringatan (nama event + baris pertama stderr) | ✅ |
| `--forward-subagent-text` | ⚙️ Flag Claude → **Transkrip subagent di kartu delegasi**: kata-kata subagent ikut tersimpan di detail kartu, lalu laporan akhirnya | ✅ |
| `--no-session-persistence`, `--safe-mode`, `--debug` | ⚙️ Flag Claude → **Mode privat**, **Safe mode**, **Debug log** | ✅ |
| `claude auto-mode defaults\|reset`, `/auto-mode-setup` | ⋯ → **Auto mode Claude** (editor `autoMode` di `~/.claude/settings.json`, laptop) | ✅ (reset = kosongkan daftar) |
| `claude purge` | ⋯ → **Bersihkan data Claude** (pratinjau `--dry-run`, ketik path folder kerja untuk konfirmasi, laptop, tidak saat giliran/antrian berjalan; worktree aktif ikut jadi sasaran) | ✅ |
| `claude import` (dari Codex/Cursor/…) | 🚫 sesi interaktif yang menulis config agen lain; menjalankannya butuh TTY dan keputusan per item | 🚫 |
| `--append-system-prompt` (tambahan per project) | ⚙️ Flag Claude → **Instruksi sistem tambahan**: teks (maks 4000) digabung dengan prompt tim lewat `--append-system-prompt` + `--append-system-prompt-file` (Claude Code 2.1.283+; terpasang 2.1.331) | ✅ |
| `--system-prompt` / `--system-prompt-file` (mengganti prompt bawaan) | 🚫 sengaja: menghapus panduan tool & pengaman bawaan; persona bisa lewat output style/CLAUDE.md | 🚫 |
| `/context` rincian + statistik prompt cache | ✅ rincian per kategori (`detail:"full"`: prompt sistem, memory/CLAUDE.md, tool bawaan, MCP, instruksi MCP, agent, command/skill, percakapan+tool+lampiran) tampil di dialog **Ringkas konteks**; statistik cache belum ditampilkan (cache read/write ada di ledger/usage) | ✅ (rincian) |
| Elicitation MCP (server minta input) | `-p` non-interaktif: Claude Code membatalkan permintaan input MCP (docs); kartu form hanya ada di jalur ACP | 🚫 (batasan `-p`) |
| `/init`, `/doctor`, `/status`, `/usage` | sebagian: ⚙ Kompatibilitas Claude Code | ✅ (status/usage via 👤 Akun & status bar) |
| `/sandbox` | Windows native tidak di-sandbox; nilai ~0 | 🚫 |
| `/batch` | memicu 5–30 subagent worktree (mahal, butuh worktree) | 🚫 |
| Cloud/teleport, remote-control, desktop app, self-hosted | keluar cakupan lokal | 🚫 |
| Terminal-only (`/theme`, `/tui`, `/vim`, `/keybindings`, …) | khusus tampilan terminal | 🚫 |

## OpenCode

| Kemampuan | Di Adhitron | Status |
|---|---|---|
| Sesi & ACP | mesin OpenCode (engine), resume | ✅ |
| Model & effort | Pengaturan giliran (⚙) | ✅ |
| Config `opencode.json(c)` (model, small_model, agent) | Config & Agent OpenCode (Form/JSON); `agents` V2: mode, steps, color, hidden, disabled, `default_agent` | ✅ |
| References (path/repo) | 🔗 References di form config | ✅ |
| Commands (`.opencode/commands`) | 📝 Commands OpenCode | ✅ |
| Skills | 🧩 Skills (Claude + OpenCode); sumber tambahan lewat `skills` array (folder/katalog HTTP) di form config | ✅ |
| Memory (AGENTS.md) | Editor Memory | ✅ |
| Permissions & Policies | Aturan izin (permissions) · 🛡️ Policies · **izin tersimpan** (`permission.saved.list/remove`) bisa ditinjau dan dihapus | ✅ |
| Instructions (`instructions`) | 📚 Instruksi tambahan (form config) | ✅ |
| Web search (`websearch.provider`) | 🔎 Provider web search (form config) | ✅ |
| Lampiran (teks, gambar, PDF) | kotak pesan; PDF dikirim sebagai `resource` blob ACP | ✅ |
| Config lanjutan (compaction, warming, snapshots, watcher, formatter, media, tool_output, experimental) | ⚙️ Config lanjutan; `compaction.background` + penanda compaction di chat | ✅ |
| Providers (login, kustom, headers/body) | 👤 Akun → provider, 🔌 header/body; akun tersimpan bisa diganti (credential.activate) | ✅ |
| Ollama / model lokal | ⚙ → Sistem → **Model lokal (Ollama)**: status, daftar model, GPU/CPU (`/api/ps`), salin nama `ollama/<model>`; OpenCode mendeteksi `127.0.0.1:11434` sendiri | ✅ |
| Varian model `#variant` | pemilih model | ✅ |
| Plugins | 🧩 Plugin OpenCode di dialog **Ekstensi** yang sama (tab Plugin menggantikan marketplace saat project OpenCode): npm/Git, tambah/hapus/update | ✅ |
| MCP servers | 🔌 MCP; status/reconnect/disable/login/**logout**; **⚙ Lanjutan** per server (`disabled`, `codemode`, `pool`, `protocol`, `cwd`, `timeout`) ditulis ke config dengan backup; header HTTP saat menambah | ✅ |
| Worktree | ⎇ Worktree (aplikasi) | ✅ |
| Automations (2.4) | ⏰ Automation OpenCode: prompt/Code Mode, interval/cron/sekali/event MCP (server dari daftar MCP project), jeda/lanjut/hapus | ✅ |
| `opencode uninstall/share/run/service get-set-unset/debug heap-dump/mini/serve/acp/api/pair/ci` | internal/khusus terminal/berisiko | 🚫 |

## Fitur di luar CLI (pembeda Adhitron)

| Kemampuan | Di Adhitron | Status |
|---|---|---|
| Papan “perlu tindakan” lintas project | izin/rencana/pertanyaan, model hilang, mode lama, budget, CI gagal, OpenCode berhenti, antrian, giliran terputus, jadwal gagal; tunda 1 jam | ✅ |
| Laporan pola kerja | biaya/token/permintaan/sesi per project, model, dan jam (7/30/90 hari) | ✅ |
| Bandingkan model | satu pertanyaan ke dua model Claude (tool mati, sesi tidak disimpan), jawaban + biaya + durasi | ✅ |
| Tanya arsip | cari lintas transkrip, jawab hanya dari kutipan dengan nomor sumber yang bisa dibuka | ✅ |
| Nilai jawaban terakhir | model kedua menilai kebenaran/risiko/verifikasi jawaban terakhir, tanpa tool | ✅ |
| Anggaran per model | batas harian/mingguan/bulanan per model, dicek sebelum prompt/antrean | ✅ |
| Rekap mingguan | ringkasan Markdown 7 hari dari ledger (total, project, model, jam) tanpa model call; **otomatis** mingguan (hari+jam) dan muncul di ⚠ Perlu tindakan sampai dibuka | ✅ |

---

Catatan: baris 🔜 dikerjakan di **Fase 6**; setelahnya matriks ini diperbarui menjadi ✅ dan dicatat di CHANGELOG. Baris 🚫 disengaja dan tidak akan dibangun kecuali kebutuhan berubah.
