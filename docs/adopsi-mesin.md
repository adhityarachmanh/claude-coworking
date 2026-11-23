# Matriks Adopsi Mesin (Claude Code & OpenCode)

Tujuan Adhitron: mengoperasikan Claude Code dan OpenCode dari aplikasi tanpa CLI. Dokumen ini memetakan **setiap kemampuan** kedua mesin ke tempatnya di Adhitron, atau menandainya **di luar cakupan** dengan alasan. Versi terpasang saat ditulis: **Claude Code 2.1.328**, **OpenCode 2.3.2**.

Sumber otoritatif: https://code.claude.com/docs (cli-reference, commands, hooks, settings, permissions, skills, output-styles, plugins, sub-agents, mcp, agent-view, worktrees, goal, scheduled-tasks) dan https://opencode.ai/docs (config, commands, policies, permissions, skills, plugins, providers, websearch, mcp-servers, cli). Ditinjau ulang 2026-11-23.

Status: ✅ = diadopsi (disebut lokasinya) · 🚫 = di luar cakupan sadar (disebut alasannya).

## Claude Code

| Kemampuan | Di Adhitron | Status |
|---|---|---|
| Sesi & prompt (`claude -p`, resume, lanjut) | kotak pesan, Antrian, Riwayat/Riwayat Sesi, ▶ Lanjutkan | ✅ |
| Model, effort, Mode tim | Pengaturan giliran (⚙), chip model/effort, /model /effort | ✅ |
| Mode izin (Build/Plan/Auto + deny) | Mode (Shift+Tab), Aturan izin. `acceptEdits` dipetakan ke Build (auto-edit) dan `dontAsk` ke Plan (menolak semua yang bertanya), jadi mode Claude tidak muncul mentah di UI | ✅ |
| Permission rules (allow/ask/deny) | Aturan izin (`/permissions`), kartu izin | ✅ |
| Working dir & folder tambahan | 📂 Folder tambahan (`--add-dir`) | ✅ |
| Memory (CLAUDE.md, rules, auto memory) | Editor Memory (`/memory`) | ✅ |
| Skills | 🧩 Skills (`/skills`) | ✅ |
| Output styles | 🎭 Output style (`/output-style`) | ✅ |
| Subagents (`.claude/agents`) | 🤖 Subagent (menu/`/agents`) | ✅ |
| Plugins | 🧩 Plugin (menu/`/plugin`) | ✅ |
| Hooks | 🪝 Hooks (menu/`/hooks`) — lihat, tambah, ubah, hapus | ✅ |
| MCP servers | 🔌 MCP (`/mcp`) | ✅ |
| Rewind/checkpoint & ringkas | ⏪ Rewind, 🧹 Ringkas | ✅ |
| Tugas latar & agent view | ⧗ Tugas latar (`/tasks`), Monitor | ✅ |
| Worktree (`claude -w`) | ⎇ Worktree (menu) | ✅ |
| PR (`gh`) | 🧩 Pull request | ✅ |
| `/goal` | diteruskan sebagai command (katalog `/goal`) | ✅ |
| `/loop` | diteruskan sebagai command (katalog `/loop`) | ✅ |
| `/fewer-permission-prompts` | diteruskan sebagai skill (katalog) | ✅ |
| Flag `--fallback-model`, `--max-turns`, `--max-budget-usd`, `--tools`, `--allowedTools`, `--disallowedTools`, `--setting-sources` | ⚙️ Flag Claude (menu) → setelan project → spawn | ✅ |
| `--advisor` (model penasihat) | ⚙️ Flag Claude → **Model advisor** → `--advisor` | ✅ |
| `/fast` (fast mode) | ⚙️ Flag Claude → **Fast mode** → `--settings` `{"fastMode":true}` (flag `/fast` hanya untuk sesi interaktif) | ✅ |
| `--prompt-suggestions` | ⚙️ Flag Claude → **Saran prompt berikutnya**; bar “Saran berikutnya” di atas kotak pesan mengisi kotak, tidak mengirim sendiri | ✅ |
| `--autocompact <auto\|tokens>` | ⚙️ Flag Claude → **Auto-compact** (`auto`/`500k`, minimal 100k) → `--autocompact` | ✅ |
| `--include-hook-events` | ⚙️ Flag Claude → **Event hook di chat** → hook yang gagal muncul sebagai baris peringatan (nama event + baris pertama stderr) | ✅ |
| `--forward-subagent-text` | ⚙️ Flag Claude → **Transkrip subagent di kartu delegasi**: kata-kata subagent ikut tersimpan di detail kartu, lalu laporan akhirnya | ✅ |
| `claude auto-mode defaults\|reset`, `/auto-mode-setup` | ⋯ → **Auto mode Claude** (editor `autoMode` di `~/.claude/settings.json`, laptop) | ✅ (reset = kosongkan daftar) |
| `claude purge` | ⋯ → **Bersihkan data Claude** (pratinjau `--dry-run`, ketik path folder kerja untuk konfirmasi, laptop, tidak saat giliran/antrian berjalan; worktree aktif ikut jadi sasaran) | ✅ |
| `claude import` (dari Codex/Cursor/…) | 🚫 sesi interaktif yang menulis config agen lain; menjalankannya butuh TTY dan keputusan per item | 🚫 |
| Flag system prompt (`--system-prompt`/`--append-…`) | ⚠ di luar cakupan: butuh teks prompt khusus per sesi; bisa lewat output style/CLAUDE.md | 🚫 |
| `/context` rincian + statistik prompt cache | sebagian: ringkasan token/window/auto-compact dari `get_context_usage`; `detail:"full"` dan field cache hanya ada di status line JSON / butuh probe sesi nyata | ✅ (ringkas) |
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
| Config `opencode.json(c)` (model, small_model, agent) | Config & Agent OpenCode (Form/JSON) | ✅ |
| References (path/repo) | 🔗 References di form config | ✅ |
| Commands (`.opencode/commands`) | 📝 Commands OpenCode | ✅ |
| Skills | 🧩 Skills (Claude + OpenCode) | ✅ |
| Memory (AGENTS.md) | Editor Memory | ✅ |
| Permissions & Policies | Aturan izin (permissions) · 🛡️ Policies · **izin tersimpan** (`permission.saved.list/remove`) bisa ditinjau dan dihapus | ✅ |
| Instructions (`instructions`) | 📚 Instruksi tambahan (form config) | ✅ |
| Web search (`websearch.provider`) | 🔎 Provider web search (form config) | ✅ |
| Lampiran (teks, gambar, PDF) | kotak pesan; PDF dikirim sebagai `resource` blob ACP | ✅ |
| Config lanjutan (compaction, warming, snapshots, watcher, formatter, media, tool_output, experimental) | ⚙️ Config lanjutan | ✅ |
| Providers (login, kustom, headers/body) | 👤 Akun → provider, 🔌 header/body | ✅ |
| Varian model `#variant` | pemilih model | ✅ |
| Plugins | 🧩 Plugin OpenCode | ✅ |
| MCP servers | 🔌 MCP | ✅ |
| Worktree | ⎇ Worktree (aplikasi) | ✅ |
| `opencode uninstall/share/run/service get-set-unset/debug heap-dump/mini/serve/acp/api/pair/ci` | internal/khusus terminal/berisiko | 🚫 |

---

Catatan: baris 🔜 dikerjakan di **Fase 6**; setelahnya matriks ini diperbarui menjadi ✅ dan dicatat di CHANGELOG. Baris 🚫 disengaja dan tidak akan dibangun kecuali kebutuhan berubah.
