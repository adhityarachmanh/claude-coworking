# Inventaris Kemampuan Resmi OpenCode (V2)

- **Paket npm**: `@opencode/cli` (repo `https://github.com/anomalyco/opencode`)
- **Versi terpasang di mesin Adhitron**: OpenCode **2.3.2**
- **Sumber**: dokumentasi resmi `https://opencode.ai/docs/...` (diambil 2026-11-22, format markdown)
- **Catatan versi**: Dokumen resmi saat ini mendeskripsikan **OpenCode 2 (V2)**. Halaman [`/docs/migrate-v1`](https://opencode.ai/docs/migrate-v1) menjelaskan perbedaan perilaku V1 vs V2. Bila sebuah halaman menyebut "V1" secara eksplisit, itu ditandai di bawah.
- **Metode**: riset dokumentasi (bukan implementasi). Tidak ada kode yang diubah.

> Legenda: `(tidak ditemukan)` = halaman 404 / tidak ada di docs V2 saat pengambilan.

---

## 1. Perintah CLI

Instalasi: `curl -fsSL https://opencode.ai/v2/install | bash`, `brew install anomalyco/tap/opencode-v2`, `npm i -g @opencode/cli`, `bun`, `pnpm`, `yarn`, `vp install`, `paru -S opencode-beta`, `mise use -g opencode`. Binary standalone tersedia untuk macOS/Windows/Linux (glibc & musl). Windows package manager tidak didukung.

Setiap perintah menerima `--help`. Beberapa perintah server menerima `--standalone` (server privat) atau `--server <url>`.

| Perintah | Ringkas | Flag penting |
|---|---|---|
| `opencode` | Membuka TUI penuh di project | `opencode ~/dir` (pindah project), `--standalone`, `--server <url>`, `--continue`, `--model`, `--prompt` (mini) |
| `opencode run <prompt>` | Kirim pesan, cetak balasan, tanpa UI | `--model provider/model`, `--continue`, `--session <id>`, `--format json`, `--file <path>` (berulang), `--agent <id>`, `--auto`, `--archived`, `--standalone` |
| `opencode mini` | UI interaktif minimal | `--continue`, `--model`, `--prompt`, `--session` |
| `opencode session` | Kelola sesi | sub: `list` (`--max-count`, `--format json`), `delete <id>` (ikut anak), `export <id>` (`--sanitize`), `import <file>` (`--directory`) |
| `opencode auth` | Kelola provider & kredensial | sub: `list` (`--format json`), `login <id>` (`--method key`), `logout <id> <account>`, `switch <id> <account>`, `export <id>`, `import <file>` |
| `opencode models` | Daftar semua model tersedia | — |
| `opencode mcp` | Kelola server MCP | sub: `list`, `add <name> --url <url>` / `--global` / `--env K=V` / `--header K=V` / `-- <cmd>`, `auth [name]`, `logout <name>` |
| `opencode plugin` | Kelola plugin | sub: `list` (`--builtin`), `add <pkg>`, `check`, `update [pkg]`, `remove <pkg>` |
| `opencode stats` | Statistik pemakaian | `--days <n>`, `--models`, `--cost`, `--json`, `--project <dir>` |
| `opencode serve` | Jalankan API + web server (foreground) | `--hostname`, `--port`, `--cors <origin>` |
| `opencode pair` | Cetak link sekali-pakai + QR untuk sign-in browser/app | `--url`, `--remote` (OpenTunnel), `--yes` |
| `opencode service` | Kelola server background | `start`, `restart`, `status`, `stop`, `get <key>`, `set <key> <value>`, `unset <key>`; key: `hostname`, `port`, `password`, `cors`, `env`, `remote`, `disabled` |
| `opencode reload` | Reload konfigurasi tanpa restart server (sesi lanjut di batas step) | — |
| `opencode api` | Request ke server yang berjalan | `opencode api GET /api/session`, `opencode api session.list --param limit=10`, `--data '{...}'`, `-H "k: v"` |
| `opencode acp` | Server Agent Client Protocol via stdin/stdout (integrasi editor) | — |
| `opencode debug` | Alat debugging | `agents`, `config`, `heap-dump` (`--directory`), `paths [selector]` (db, home, data, config, cache, state, tmp, bin, log, repos) |
| `opencode upgrade [version]` | Upgrade ke versi terbaru/spesifik (alias `update`) | `--method <pm>` |
| `opencode uninstall` | Hentikan service, hapus global cache, uninstall (data sesi & config tidak dihapus) | `--dry-run`, `--force`/`-f` |

**Auto-approve**: `opencode run --auto` menyetujui permission yang tidak secara eksplisit di-deny.

**Sumber**: `https://opencode.ai/docs/cli/commands/`, `/docs/cli/` (lihat juga `/docs/cli/config`, `/docs/cli/web` — halaman `/docs/cli/tui` tidak ditemukan).

---

## 2. Konfigurasi (`opencode.jsonc`)

- **Format**: JSON atau JSONC (komentar + trailing comma). Schema: `https://opencode.ai/config.json`.
- **Lokasi** (precedence naik): global `~/.config/opencode/opencode.json(c)` → project `opencode.json(c)` & `.opencode/opencode.json(c)` (direktori terluar menang) → system `/etc/opencode` (Linux), `%ProgramData%\opencode` (Windows), `/Library/Application Support/opencode` (macOS). Khusus macOS: managed preferences MDM domain `ai.opencode.managed` (precedence tertinggi).
- **System dir** juga memuat `agents/`, `commands/`, `skills/`, `plugins/` machine-wide.
- **Merging**: file langsung digabung dari terjauh→terdekat, lalu file di dalam `.opencode/` (selalu menimpa file langsung).
- **Variabel**: `{env:NAME}` (string kosong bila tak diset) dan `{file:path}` (relatif ke file config, absolut, atau `~/`).

### Field utama

| Field | Fungsi |
|---|---|
| `$schema` | URL schema untuk validasi editor |
| `shell` | Shell untuk terminal & tool shell (mis. `/bin/zsh`) |
| `model` | Model default `provider/model` (root tidak menyimpan `#variant`) |
| `default_agent` | Agent primer default (harus ada, visible, primary-capable; fallback `build`) |
| `update` | `"disable"` \| `"notify"` (default) \| `"auto"`; hanya dari global config |
| `username` | Diterima tapi tidak ditampilkan di percakapan |
| `permissions` | Array rule terurut `{action, resource, effect}` |
| `policies` | Statement biner `{action, resource, effect: allow\|deny}` (hard-deny) |
| `agents` | Definisi/override agent (peta id → konfigurasi) |
| `snapshots` | Aktif/nonaktif snapshot filesystem untuk undo/revert |
| `watcher.ignore` | Pola file/dir yang tak memicu update filesystem |
| `formatter` | `true` untuk formatter bawaan, atau konfigurasi kustom |
| `media.image` | `auto_resize`, `max_width` (2000), `max_height` (2000), `max_base64_bytes` (5242880) |
| `tool_output` | `max_lines` (2000), `max_bytes` (51200) |
| `websearch` | `{provider: <id>}` atau `false` untuk menonaktifkan |
| `mcp` | `{servers: {...}, timeout: {...}}` |
| `compaction` | `{auto, keep: {tokens}, buffer}` |
| `warming` | `{prompt, interval, duration}` (default disabled) |
| `skills` | Array path lokal/URL katalog |
| `commands` | Peta command (nama → definisi) |
| `instructions` | Array file/glob/URL instruksi tambahan |
| `references` | Peta alias → local path / Git repo |
| `worktree.directory` | Direktori induk worktree baru |
| `plugins` | Array paket/path/objek plugin |
| `providers` | Peta provider (models, settings, headers, body, package, env, dll) |

### Experimental (`experimental.*`)
`todo` (default false), `subagent_depth` (default 1), `image_generate.model`, `location_idle_timeout` (default "60 minutes", `false` = never unload), `policies` (deprecated → gunakan top-level `policies`).

**Sumber**: `https://opencode.ai/docs/config`

### CLI settings (klien terminal, `~/.config/opencode/cli.json`)
File global tunggal (V2 menggantikan `tui.json(c)` berlapis V1; auto-migrasi). Inline via `OPENCODE_CLI_CONFIG_CONTENT`. Schema `https://opencode.ai/v2/cli.json`.
Grup: `theme`, `animations`, `cursor`; `mouse`, `scroll`, `prompt`; `session` (sidebar, scrollbar, submit_scroll, thinking, grouping, image_preview, tps, markdown, new_location, permissions); `tabs`; `diffs` (source: branch/committed/working/turn, wrap, tree, single, view); `attention` (notifications, sound, volume, sound_pack, sounds); `highlights`; `terminal`; `mini` (thinking, tools, shell_output, turn_summary, footer, splash, work_spinner, mono, replay, replay_limit); `keybinds` + `leader.timeout`; `plugins`; `debug` (devtools, timing, turn_tokens); `experimental`.
**Sumber**: `https://opencode.ai/docs/cli/config`

---

## 3. Tools bawaan

| Tool | Kegunaan | Permission action / resource | Catatan |
|---|---|---|---|
| `read` | Baca file / listing dir non-rekursif | `read` / path ternormalisasi | 2000 baris & 50 KiB per halaman; baris dipotong >2000 char; PNG/JPEG/GIF/WebP/PDF hingga 20 MiB |
| `glob` | Cari path dari pola | `glob` / pola | default limit 100, timeout 30 dtk; `hidden`, `limit` |
| `grep` | Cari isi file | `grep` / regex (bukan path) | regex default, `literal`; limit 100, timeout 30 dtk |
| `edit` | Ganti teks tepat satu kali di file | `edit` / path | `oldString`, `newString`, `replaceAll`; formatter opsional |
| `write` | Buat/timpa file | `edit` / path | buat parent dir; formatter opsional |
| `patch` | Patch multi-file (add/update/move/delete) | `edit` / setiap path | hanya untuk model GPT tertentu; model lain dapat `edit`+`write` |
| `shell` | Jalankan perintah di shell host | `shell` / tiap command dari scanner | `workdir`, `timeout` (default 2 menit), `background` (tanpa timeout) |
| `webfetch` | Ambil satu URL HTTP(S) | `webfetch` / URL | format markdown/text/html; timeout ≤120 dtk |
| `websearch` | Cari web via integrasi terpilih | `websearch` / query | lihat §11 |
| `experimental_image_generate` | Buat/edit gambar | `experimental_image_generate` / model terpilih | eksperimental; background; `prompt`, `images`, `model`, `path` |
| `question` | Tanya user (pause eksekusi) | `question` / `*` | header, prompt, choices, `multiple`; selalu ada jawaban bebas |
| `skill` | Muat instruksi skill | `skill` / skill ID | ID harus terdaftar; lihat §6 |
| `subagent` | Mulai child session | `subagent` / agent ID | selalu background; depth default 1 |
| `execute` | JavaScript Code Mode | `execute` / `*` | tanpa fs/imports/timers; ada `fetch`; deny → tools MCP langsung didaftarkan |
| `opencode.session.rename` / `_move` | Ganti judul / pindah sesi | (via `execute` / tool langsung) | `rename(sessionID?)`, `move(directory)` di batas aman |
| `opencode.worktree_create` / `_list` / `_remove` | Kelola worktree | `worktree_remove` pakai `edit` / dir | `create(name)`, `list()`, `remove(directory, force?)` |
| `browser` (Code Mode namespace) | Kontrol browser desktop app | deny `browser *` menghapus katalog | tab, navigasi, snapshot, search, click, form, screenshot, transfer file (≤5 MiB), console, network, performance trace, heap, Lighthouse |
| `list_mcp_resources` / `read_mcp_resource` | Baca resource MCP | `opencode_list_mcp_resources` / nama server; `opencode_read_mcp_resource` / `<server>:<uri>` | lihat §7 |

Tool MCP diberi nama `<server>_<tool>` (karakter non `[A-Za-z0-9_-]` → `_`). Default diakses lewat `execute`; `codemode: false` → langsung. Skills menambah instruksi (bukan tool); Attachments/References melengkapi tanpa melewati permission.

**Sumber**: `https://opencode.ai/docs/tools`

---

## 4. Agents

- **Lokasi**: global `~/.config/opencode/agents/<name>.md`; project `.opencode/agents/<name>.md` (path bersarang jadi bagian ID, mis. `team/reviewer`). V1 juga menemukan `agent/`, `agents/`, `mode/`, `modes/`.
- **Format**: Markdown (frontmatter = field `agents` config; body = `system` prompt) atau JSONC di bawah `agents`.
- **Mode**: `primary` (default untuk agent kustom baru), `subagent` (hanya child via tool `subagent`), `all`.
- **Built-in visible**: `build` (primary, default), `plan` (primary), `general` (subagent), `explore` (subagent). Hidden: `compaction`, `title`, `summary` (maintenance, tak dapat dipilih). V2 tidak punya `scout`.
- **Merging**: definisi digabung sesuai urutan config; skalar terakhir menang, request map merge per key, permission rule append. Global `permissions` berlaku sebelum rule agent.

### Field agent
`description`, `mode`, `model` (`provider/model#variant` atau objek `{providerID, model, variant}`), `system`, `permissions` (array rule), `steps` (max model steps; di step akhir tool dilepas + minta ringkasan), `hidden` (hapus dari listing/catalog; kontrol visibilitas, bukan keamanan), `color` (hex 6 digit), `disabled` (hapus agent), `request` (`headers`, `body` — V2 menyimpan tapi **belum** mengirim ke model).

> Jangan pakai field legacy V1: `temperature`, `top_p`, `prompt`, `permission`, `tools`, `disable`, `maxSteps`.

**Sumber**: `https://opencode.ai/docs/agents`

---

## 5. Commands (slash commands)

- **Lokasi**: global `~/.config/opencode/commands/`; project `.opencode/commands/`. Hanya `.md`. Path bersarang → nama dengan `/` (mis. `/team/review`). Direktori singular legacy `command/` juga ditemukan.
- **JSON**: di bawah `commands` (wajib `template`).
- **Frontmatter/field**: `template` (JSON saja), `description`, `agent`, `model` (`provider/model#variant`), `subagent` (boolean; `true` = child background, `false` = sesi sekarang), `subtask` (alias deprecated; `subagent` menang bila keduanya ada).
- **Argumen**: `$ARGUMENTS` (string lengkap); posisi `$1`, `$2`, … (kutip tunggal/ganda mengelompokkan & dihapus; placeholder tertinggi menelan sisa argumen; posisi hilang = string kosong). **Fallback**: tanpa placeholder, argumen ditambahkan setelah baris kosong.
- **Shell**: `` !`cmd` `` menyisipkan output sebelum prompt dikirim; placeholder diperluas lebih dulu. Block shell dijalankan saat evaluasi command, **di luar** alur permission tool (hanya sumber tepercaya).
- **Attachments**: `@path` di template tidak diperluas (teks biasa); lampirkan lewat composer.
- **Execution**: default di sesi sekarang; model: `command.model` > `agent.model` > model sesi. `subagent: true` → child background. Loading: project menimpa global; command kustom dapat menggantikan built-in; reload otomatis.

**Sumber**: `https://opencode.ai/docs/commands`

---

## 6. Skills

- **Struktur**: `SKILL.md` dalam direktori skill (direktori direkomendasikan; file pendukung di sampingnya). Path relatif terhadap direktori `SKILL.md`.
- **Penemuan otomatis**: global `~/.config/opencode/skills`; kompat global `~/.claude/skills`, `~/.agents/skills`; project `.opencode/skills`; kompat project `.claude/skills`, `.agents/skills`. Markdown harus di root sumber; `SKILL.md` boleh bersarang. Lewati file/dir tersembunyi & `node_modules`; berhenti 6 level di bawah root.
- **Sumber tambahan**: array `skills` (path relatif ke cwd, `~/`, absolut, atau URL `http(s)` katalog). Semua config digabung.
- **Katalog HTTP**: `index.json` berisi `{skills:[{name, version, files}]}`; unduh dari `<base>/<name>/<file>`; increment `version` untuk refresh cache.
- **Frontmatter**: `name` (label tampilan), `description` (wajib agar model menemukan), `metadata.opencode/autoinvoke: false` atau `disable-model-invocation: true` (sembunyikan dari model, tetap bisa dimuat eksplisit). V2 menerima `license`/`compatibility` tapi tak menafsirkan.
- **ID**: diturunkan dari path (case-sensitive). `<source>/git-release/SKILL.md` → `git-release`; `<source>/teams/release/SKILL.md` → `release`.
- **Precedence** (rendah→tinggi): built-in skill → `.claude/skills` → `.agents/skills` → `~/.config/opencode/skills` → project `.opencode/skills` → entri `skills` config eksplisit.
- **Loading**: pada tiap step, hanya ID/nama/description yang didaftarkan; model memuat via tool `skill`. Sebut `@skill-id` untuk memuat manual.
- **Permission**: action `skill`, resource = skill ID (`allow`/`ask`/`deny`).

**Sumber**: `https://opencode.ai/docs/skills`

---

## 7. MCP servers

- **Setup CLI**: `opencode mcp add <name> --url <url>` (remote), `-- <cmd>` (local), `--global`, `--env K=V`, `--header K=V`. Remote default pakai OAuth; `needs authentication` → `/mcps` atau `opencode mcp auth <name>`; hapus kredensial `opencode mcp logout <name>`.
- **Config**: `mcp.servers.<name>` (V2 tidak menaruh nama langsung di `mcp`). Server auto-connect; pakai `disabled` (bukan `enabled`) untuk menyimpan tanpa koneksi. Config berprecedence lebih tinggi mengganti seluruh objek server.
- **Local**: `type:"local"`, `command:[...]`, opsional `cwd`, `environment`, `disabled`, `codemode`, `timeout`, `protocol`, `pool`. `{env:NAME}` untuk substitusi.
- **Remote**: `type:"remote"`, `url` absolut (Streamable HTTP), opsional `headers`, `oauth` (objek atau `false`), `disabled`, `codemode`, `timeout`, `protocol`, `pool`.
- **OAuth**: diaktifkan default; PKCE; kredensial di luar config project. Client registration: pre-registered (`oauth.client_id`) → CIMD (public client, tanpa `redirect_uri`) → DCR. Field: `client_id`, `client_secret`, `scope`, `callback_port` (1–65535), `redirect_uri`, `auth_server_metadata_url`.
- **Timeouts**: `mcp.timeout` global (`startup` 30 dtk, `catalog` 30 dtk, `execution` 12 jam); `servers.<name>.timeout` menimpa per kunci.
- **Protocol**: `legacy` (default, s/d revisi 2025-11-25), `auto` (probe `server/discover` untuk 2026-07-28, fallback legacy), `2026-07-28` (wajib).
- **Shared connections (`pool: true`)**: hanya revisi 2026-07-28; pengaturan sama → satu koneksi. Local hanya di mesin yang sama, butuh `cwd` tetap.
- **Naming**: tool `<server>_<tool>`; prompt → command `<server>:<prompt>`.
- **Permissions**: action MCP = `<server>_<tool>` (resource `*`); `codemode: false` untuk daftar langsung.
- **Resources**: `opencode_list_mcp_resources` / `opencode_read_mcp_resource`.
- **Server instructions**: ditambahkan ke system prompt sebagai `<mcp_instructions>`; dihilangkan bila semua tool di-deny.
- **Input requests**: MCP elicitation ditampilkan sebagai form/link.
- **Context**: session ID dikirim di `CallToolRequest.params._meta["ai.opencode/sessionID"]` (opaque, jangan untuk auth).
- **Management**: `/mcps` (view/connect/disconnect/auth); hapus dengan menghapus entri di config.

**Sumber**: `https://opencode.ai/docs/mcp-servers`

---

## 8. Permissions

- **Rule**: `{action, resource, effect}` dengan `effect` = `allow` | `deny` | `ask`. Bila tak ada rule yang cocok → `ask`.
- **Matching**: wildcard `*` (nol atau lebih karakter, termasuk `/`), `?` (satu karakter), sisanya literal. Path dinormalisasi `/`; case-insensitive di Windows. Shell pattern berakhiran ` *` juga cocok tanpa argumen. **Rule terakhir yang cocok menang** (broad dulu, pengecualian setelahnya).
- **Kombinasi beberapa resource**: ada `deny` → deny; jika tidak ada, ada `ask` → ask; jika tidak, allow.
- **Daftar action V2**:

| Action | Resource |
|---|---|
| `read` | path internal (Location-relatif) atau path eksternal absolut kanonik |
| `edit` | target path untuk `edit`, `write`, `patch` |
| `glob` | pola glob |
| `grep` | regex (bukan path pencarian) |
| `shell` | string command dari scanner (compound bisa menghasilkan beberapa) |
| `subagent` | agent ID |
| `skill` | skill ID |
| `question` | `*` |
| `webfetch` | URL |
| `websearch` | query |
| `experimental_image_generate` | model gambar `providerID/modelID[#variant]` |
| `external_directory` | batas direktori eksternal kanonik (`.../*`) |
| `<server>_<tool>` | `*` (tool MCP) |
| `opencode_list_mcp_resources` | nama server MCP |
| `opencode_read_mcp_resource` | `<server>:<uri>` |
| `execute` | `*` (deny → hapus Code Mode) |

> `doom_loop` dan `lsp` **bukan** action V2 Core. V1: `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`, `permission`→`permissions`.

- **Directories**: path di luar Location + worktree dicek ke `external_directory` (default **allow**; V1 default ask — tambahkan rule `ask` untuk perilaku V1). `~`, `~/`, `$HOME`, `$HOME/` diperluas untuk `external_directory`/`read`/`edit`; shell tetap raw.
- **Scanner shell**: analisis Bash, Zsh, POSIX `sh`, PowerShell. Command tak aman (syntax rusak, `eval`) → gagal bila ada rule `shell` deny; jika tidak → butuh approval seluruh command + `external_directory *`.
- **Defaults**: base policy tiap agent = `*` allow; `*.env` ask; `*.env.*` ask; `*.env.example` allow. Agent bawaan menambah: `build` allow questions; `plan` allow questions + deny edit kecuali `~/.opencode/plan`; `general` deny questions & subagent; `explore` deny semua kecuali shell/read/glob/grep/webfetch/websearch/external_directory + ask `.env`; `title`/`summary` deny semua; `compaction` base policy.
- **Agents**: rule global di top-level, rule spesifik di `agents.<id>.permissions` (append, bukan replace).
- **Approvals**: `once` (sekali), `always` (simpan pola tool untuk project), `reject` (tolak semua pending di sesi). Approval tersimpan = rule allow project-scoped; tidak pernah menimpa `deny`.
- **Policies**: dapat hard-deny setelah rule & approval (lihat §10).

**Sumber**: `https://opencode.ai/docs/permissions`

---

## 9. Plugins

- **Config**: `plugins` array — paket npm (nama/version/tag/range), scoped, Git (`github:`/`git+ssh`/`#branch`, `::path:`), path lokal (`./`, `../`, absolut, `file://`), atau objek `{package, options}`. Path relatif dari file config. Path lokal wajib direktori.
- **Discovery otomatis**: file `.ts`/`.js` langsung + direktori paket di `.opencode/plugins/` (global: `~/.config/opencode/plugins/`).
- **Control**: proses berurutan; prefix `-` menonaktifkan; `*` semua; `.*` prefix ID. `-opencode.fork-notice` mematikan notice di fork. Built-in `opencode.config.policy` & `opencode.provider.opencode` mengabaikan removal (enforcement policy).
- **Manage CLI**: `plugin add`, `list` (`--builtin`), `check`, `update [pkg]`, `remove`.
- **Auto-update paket**: plugin memperbarui diri bila menamai target (`@latest`, range semver, branch Git, `semver:`); dicek saat start & tiap 24 jam. Versi/commit pasti di-pin.
- **Reload**: perubahan di config dir yang di-watch reload otomatis. `opencode service restart` untuk lainnya.
- **Desktop**: plugin export `./gui-experimental` menambah panel/command/settings di OpenCode Desktop. **TUI**: plugin khusus TUI dikonfigurasi di `cli.json`.

### API plugin (bagian server)
- **Definisi**: `Plugin.define({ id, setup(ctx) })` dari `@opencode/plugin`; `setup` boleh mengembalikan cleanup. `ctx.location` = `{directory, workspaceID?, project:{id, directory, canonical}}`; `ctx.options`.
- **Bagian paket**: Server (`.`/`./server`), TUI (`./tui`), GUI (`./gui-experimental`), RPC (`./rpc`).
- **Transforms** (sinkron, edit state domain): `ctx.provider.transform`, `ctx.model.transform`, `ctx.agent.transform`, `ctx.command.transform`, `ctx.integration.transform`, `ctx.mcp.transform`, `ctx.reference.transform`, `ctx.skill.transform`, `ctx.tool.transform`, `ctx.vcs.transform`, `ctx.worktree.transform`, `ctx.websearch.transform`; masing-masing punya `reload()` dan `ctx.<domain>.list()/get()`.
- **Domain lain**: `ctx.credential.activate`, `ctx.session` (create/get/remove/context/prompt/generate/command/synthetic/compact/switchAgent/switchModel/interrupt/wait/move, `instructions.entry`), `ctx.permission` (assert/list/get/reply), `ctx.storage` (get/set/remove/scan), `ctx.plugin.list`, `ctx.vcs`, `ctx.worktree` (project-based: create/list/refresh/remove), `ctx.websearch` (providers/query), `ctx.generate` (eksperimental: text/image/decisions), `ctx.event.subscribe({types, signal})`.
- **Hooks** (`ctx.<domain>.hook(event, fn)` → Registration.dispose()): Sessions — `fork`, `prompt` (admission, mutable draft: text/files/agents/skills/metadata/delivery), model requests — `context`, `compaction`, `generate`, `title` (ubah system/messages/tools/options; `result` untuk skip model call).
- **Tool plugin**: `editor.namespace({name, description})`, `editor.add({name, description, input, options:{namespace, codemode}, execute})`, `editor.update/remove/list/get`; `freeform: {type:"text"|"regex"|"lark"}`; `context.signal` untuk cancel; `context.progress`.
- **VCS provider**: `init?(scope,{signal})` untuk membuat repo baru. **Worktree strategy**: `create/remove/list` + `Worktree.OperationError` untuk force confirmation.

**Sumber**: `https://opencode.ai/docs/plugins`, `/docs/build/plugins`, `/docs/build/plugins/server`

---

## 10. Policies (terpisah dari Permissions)

- **Statement**: `{action, resource, effect: allow|deny}`; biner, tidak pernah prompt, hanya mengetatkan. Validasi gagal → statement di-drop + warning.
- **Action**: `provider.use`, `tool.use`, `integration.connect`, `integration.use`, `mcp.use`, `skill.use`, `plugin.use`, `websearch.use`.
- **Matching** sama dengan permissions (`*`, `?`, akhiran ` *`); **last match wins**; tanpa match → allow. Resource `tool.use` = `<action>:<value>` (mis. `shell:git push *`).
- **Precedence** (tinggi→rendah): 1) macOS managed preferences; 2) system config; 3) Console workspace terhubung; 4) global `~/.config/opencode`; 5) `opencode.json(c)` langsung (luar menang); 6) `.opencode/opencode.json(c)` (luar menang). Statement dari config lebih luas dievaluasi terakhir.
- **Tool denials** berlaku setelah rule agent & saved approval → override `ask` dan "Allow always"; gagal dengan `Blocked by configuration policy`.
- **Versi minimum**: `integration.connect/use`, `mcp.use`, `skill.use`, `plugin.use` butuh **2.2.3**; `websearch.use` butuh **2.2.6**.
- **Console**: workspace OpenCode Console mengompilasi Providers & Tools policies → statement `policies` (berlaku ~1 menit); plugin Console & policy tidak bisa dinonaktifkan.
- **Enterprise**: deploy policy di system config / MDM macOS; contoh: blokir free tier, wajibkan workspace Console, allow hanya provider/MCP disetujui.

**Sumber**: `https://opencode.ai/docs/policies`, `/docs/enterprise`, `/docs/console`

---

## 11. Web search

- **Provider bawaan (5)**: Exa (`exa`, `EXA_API_KEY`), Firecrawl (`firecrawl`, `FIRECRAWL_API_KEY`), Parallel (`parallel`, `PARALLEL_API_KEY`), Tavily (`tavily`, `TAVILY_API_KEY`), TinyFish (`tinyfish`, `TINYFISH_API_KEY` opsional). Connect via `/connect` atau env var. Plus `opencode` (OpenCode Web Search via Console).
- **Selection**: `websearch.provider` di config, atau `"random"` (pilih otomatis; sesi memakai provider terpilih sampai rate-limited).
- **Limits**: HTTP 429 → random retry ke provider lain; provider itu cooldown `Retry-After` atau 60 dtk. Semua cooldown → search gagal segera. Pindah/restart sesi menghapus provider yang diingat; cooldown dibagi per workspace.
- **Permission**: action `websearch`, resource = query. **Disable**: `websearch: false` (hapus tool).
- **Policy**: `websearch.use` (resource = provider ID).

**Sumber**: `https://opencode.ai/docs/websearch`

---

## 12. Attachments

- **Cara**: lampirkan file lokal lewat desktop/web (Attach file, paste, drag). Pilihan desktop ≤20 MiB total.
- **Syntax V2**: `{uri, name?, description?}`; `uri` absolut `file:` (path tersedia ke server; `?start=&end=` baris 1-based untuk teks) atau `data:` inline. URL HTTP(S) tidak didukung.
- **Format yang terlihat model**: file teks UTF-8 (nama + teks), direktori (listing non-rekursif), PNG/JPEG/GIF/WebP (image), PDF (document, butuh model PDF). SVG = teks; AVIF/BMP/audio/video biner tidak disertakan. Media type dideteksi dari bytes. Reject URL invalid, path tak terbaca, decoded >20 MiB.
- **Images**: `media.image` — `auto_resize` (true), `max_width` (2000), `max_height` (2000), `max_base64_bytes` (5242880). Berlaku untuk attachment & gambar dari tool `read`. Resize pertahankan aspect ratio, coba PNG/JPEG lebih kecil.
- **Read tool**: kenali PNG/JPEG/GIF/WebP dari isi, hingga 20 MiB data sumber.

**Sumber**: `https://opencode.ai/docs/attachments`

---

## 13. References

- **Fungsi**: akses bernama ke direktori/ repo di luar project.
- **Local**: `path` (relatif ke file config, absolut, `~/`); shorthand string lokal hanya bila diawali `.`, `/`, atau `~` (bare string = Git repo).
- **Git**: `repository` (shorthand GitHub `owner/repo`, Git URL, host/path, SCP-style; `file:` tidak didukung), `branch` opsional (validasi: `[A-Za-z0-9/_.-]`, tak mulai `-`, tanpa `..`).
- **Storage**: satu checkout per remote+branch di global data dir: `opencode/repos/<host>/<repo-path>` (branch → suffix `@<branch>`).
- **Refresh**: clone async bila belum ada; checkout diperiksa di background saat load/reload & setelah prompt baru; eligible bila ≥24 jam sejak percobaan terakhir; reset ke branch/ default. Tidak ada polling; prompt tak menunggu clone/refresh.
- **Field**: `path` (local wajib), `repository` (Git wajib), `branch`, `description` (tampil di instruksi agent bila ada), `hidden` (hapus dari selector interaktif).
- **Alias**: tidak boleh kosong/mengandung `/`, `\`, whitespace, backtick, koma.
- **Permissions**: tidak memberi permission ekstra; akses luar tetap ikut `external_directory` + rule edit.

**Sumber**: `https://opencode.ai/docs/references`

---

## 14. Web / Desktop / TUI

### Web (`/docs/cli/web`)
- Web UI dilayani server yang sama dengan TUI, dilindungi password. `opencode pair` cetak link sekali-pakai (kadaluarsa 5 menit) + QR. Sesi 30 hari; ganti password → logout semua.
- Port default: macOS/Linux/WSL **49374**, Windows **28894**. Konfigurasi via `opencode service set` (`hostname`, `port`, `password`, `cors`, `env`). Mengubah setting menghentikan server background (mulai lagi untuk apply).
- **Standalone**: `opencode serve --hostname 0.0.0.0 --port 4096`; client `opencode --server http://127.0.0.1:4096`. Auth: `OPENCODE_PASSWORD` (HTTP Basic; username selalu `opencode`). **Remote**: `opencode pair --remote` (OpenTunnel, E2EE, butuh password; `--yes` untuk non-interaktif).
- Halaman `/docs/desktop` → **(tidak ditemukan, 404)**.

### TUI (`/docs/tui`)
- Jalankan `opencode`; Shift/Ctrl/Alt+Enter atau Ctrl+J untuk baris baru; `@` cari file (`@path#L-L`); `!` mode shell; `/` daftar slash command; `/btw <question>`; `/models` (Ctrl+X M, F2 cycle); `/agents` (Ctrl+X A, Shift+Tab cycle); sesi (`Ctrl+X N`, `Ctrl+X L`, `/sessions`, Ctrl+O); tabs (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+X W, Ctrl+Shift+T); history (`/undo` Ctrl+X U, `/redo` Ctrl+X R); `/editor` (Ctrl+X E). Leader default **Ctrl+X**. `/highlights` untuk release notes.
- Halaman `/docs/tui` sebagai dokumen terpisah tidak ada; konten TUI ada di `/docs/cli` dan `/docs/tui`.

---

## 15. Console & model

### Console (`/docs/console`)
Bersifat opsional. Fitur: workspaces (bagi akses tim), Inference (model proprietary & open source), Providers (akun provider via gateway), usage tracking & budgets, deploy policy team-wide, web search, Harnesses (pakai model Console dari Claude Code/Codex/dll), langganan **OpenCode Go** ($10/bulan), Go Plus ($40), Go Teams ($20/member). Setiap akun mulai dengan workspace **Personal**. Connect via `/connect`.

### Models (`/docs/models`)
- Katalog dari `models.dev` + integrasi provider + config. `/models` hanya tampil model enabled dengan provider tersedia (project-specific).
- `--model` per run; `model` di config = default; session yang dipilih menang atas default.
- **Free models**: `OPENCODE_DISABLE_FREE_MODELS=1` menyembunyikan model `opencode`/`opencode-go` tanpa harga input.
- **Variants**: `#variant` (mis. `openai/gpt-6.1-sol#high`); didefinisikan di `variants` array (`id`, `settings`, `headers`, `body`) atau dari `capabilities.reasoning` (`supported`, `toggle`, `effort`, `budget`).
- **Options**: `settings` (opsi paket), `headers`, `body`; provider → model → variant. **Aliases**: `modelID` + `name` + `capabilities` + `limit`; fallback 200k context / 32k output. `disabled: true` menyembunyikan model.
- **Reasoning**: `compatibility.reasoningField`. **Prompt caching**: otomatis (Anthropic dll); `compatibility.cacheFormat` (`anthropic`/`alibaba`); `settings.cache.ttl` (`ms`/`s`/`m`/`h`/`d`, mis. `"1h"`).
- **Compatibility**: `reasoningField`, `requireReasoning`, `maxTokensField`, `requireFinishReason`, `requireAssistantAfterTool`, `supportsPromptCacheKey`, `streamUsage`, `cacheFormat`, `supportsThinkingBlockBinding`, `supportsEffortUpdates`, `mediaInput`.
- **Local**: Ollama, LM Studio, vLLM terdeteksi otomatis (default `127.0.0.1:11434`, `:1234`, `:8000`); provider custom OpenAI-compatible.
- **Providers (`/docs/providers`)**: field provider `name`, `env`, `package`, `canonical`, `compatibility`, `settings`, `headers`, `body`, `models`; endpoint override `settings.baseURL`; packages native (`@opencode/ai/providers/...`); timeouts `headerTimeout` (5 mnt), `chunkTimeout` (15 mnt), `timeout`; `settings.encoding` (`zstd`/`gzip`/`none`); WebSocket `settings.transport`; Azure/Bedrock/Vertex/Copilot khusus. V2 provider IDs kanonik: `azure`, `google-vertex` (V1 `azure-cognitive-services`, `google-vertex-anthropic` dihapus).

---

## 16. Catatan Versi V1 → V2 (`/docs/migrate-v1`)

- **Breaking changes V2**: (1) plugin pakai API baru; (2) server API & client kontrak baru; (3) config klien terminal dari `tui.json(c)` berlapis → satu `cli.json` global (auto-migrasi).
- **Config**: `permission`→`permissions` (array terurut); action `bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`; `agent`/`mode`→`agents`; `prompt`→`system`, `disable`→`disabled`, `variant` gabung ke `#`, `maxSteps`→`steps`; `snapshot`→`snapshots`; `attachment`→`media`; `mcp` server langsung → `mcp.servers` + `enabled`→`disabled` + timeout terpisah; `compaction.preserve_recent_tokens`→`keep.tokens`, `reserved`→`buffer`; `skills.paths/urls`→array `skills`; `command`→`commands`, `subtask`→`subagent`; `reference`→`references`; `provider`→`providers` (`npm`→`package` dengan prefix `aisdk:`, `api`→`settings.baseURL`); model `id`→`modelID`, `tool_call`/`modalities`→`capabilities.*`, `status:"deprecated"`→`disabled:true`, `cache_read/write`→`cache.read/write`, variants object→array.
- **V1 `enabled_providers`/`disabled_providers`** → policies `provider.use`. `autoupdate` → `update`. `small_model` → `agents.title.model`.
- **Todos off by default** di V2 (`experimental.todo: true`). **`external_directory` allowed by default** di V2 (V1 ask).
- **Field V1 tanpa padanan V2** (diabaikan + warning): `logLevel`, `server`, top-level `subagent_depth`, `compaction.tail_turns`/`prune`, agent `name` di JSON, MCP entry tanpa `type`, `batch_tool`/`openTelemetry`/`primary_tools`/`continue_loop_on_deny`, provider `id`/`whitelist`/`blacklist`, provider-model `release_date`/`attachment`/`reasoning`/`temperature`/`experimental`/`status` non-deprecated/`interleaved` boolean.
- **LSP**: V2 menerima config `lsp` tapi **tidak** menjalankannya / tak ada tool atau diagnostik LSP.
- **Server auth V2**: `OPENCODE_PASSWORD` (username selalu `opencode`); `OPENCODE_SERVER_USERNAME` tidak didukung.
- **Agent files**: V2 menemukan `agent/`, `agents/`, `mode/`, `modes/`; file `mode/`/`modes/` = primary (tambah `mode: primary` saat dipindah). **Skill**: `.opencode/skill/` & `.opencode/skills/`. **Instruction**: `AGENTS.md` + fallback `CLAUDE.md` (per direktori), `OPENCODE_DISABLE_CLAUDE_CODE`.

---

## 17. Hal resmi lain yang relevan

- **Compaction**: `compaction.auto`, `keep.tokens`, `buffer` (angka token atau persen), native provider compaction (`settings.compaction.type: "native"`).
- **Warming**: `warming` (default off), `interval: "auto"`, `duration` (≤30 menit), guna `cache.ttl`.
- **Formatter**: jalankan setelah `write`/`edit`/`patch` bila `formatter` diaktifkan.
- **Snapshots**: untuk undo/revert (`snapshots`).
- **Instructions**: file `AGENTS.md` global & project + `instructions` array.
- **Worktree**: `worktree.directory`; strategi plugin dapat menggantikan Git default; operasi berbasis project (`projectID`).
- **Server API**: paket `@opencode/client`; `opencode api` untuk request; `OPENCODE_PASSWORD`, Basic auth username `opencode`; CORS via `serve --cors`/`service set cors`.
- **ACP**: `opencode acp` (Agent Client Protocol via stdin/stdout untuk integrasi editor).
- **Debug**: `opencode debug paths` selector: `db`, `home`, `data`, `config`, `cache`, `state`, `tmp`, `bin`, `log`, `repos`; `debug heap-dump`, `debug agents`, `debug config`.

---

## 18. Halaman yang diminta tapi tidak ditemukan (404)

- `https://opencode.ai/docs/desktop` → **(tidak ditemukan, 404)** (build desktop dijelaskan di `/docs/` dan `/docs/cli/web`).
- `https://opencode.ai/docs/headless` → **(tidak ditemukan, 404)**.
- `https://opencode.ai/docs/tui` → **(tidak ditemukan, 404)**; konten TUI ada di `/docs/cli` (intro) dan `/docs/tui`.
- `https://opencode.ai/docs/cli/commands/` sub-halaman per perintah → **tidak ada**; tiap perintah mendukung `--help`.

---

## Sumber (URL)

- https://opencode.ai/docs/ (index)
- https://opencode.ai/docs/cli/ , /docs/cli/commands/ , /docs/cli/config , /docs/cli/web
- https://opencode.ai/docs/config
- https://opencode.ai/docs/tools
- https://opencode.ai/docs/agents
- https://opencode.ai/docs/commands
- https://opencode.ai/docs/skills
- https://opencode.ai/docs/mcp-servers
- https://opencode.ai/docs/permissions
- https://opencode.ai/docs/policies
- https://opencode.ai/docs/plugins , /docs/build/plugins , /docs/build/plugins/server
- https://opencode.ai/docs/attachments
- https://opencode.ai/docs/references
- https://opencode.ai/docs/websearch
- https://opencode.ai/docs/migrate-v1
- https://opencode.ai/docs/console
- https://opencode.ai/docs/enterprise
- https://opencode.ai/docs/models
- https://opencode.ai/docs/providers
- https://opencode.ai/docs/tui