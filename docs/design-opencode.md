# Desain: OpenCode sebagai mesin alternatif (Fase 1)

Status: **Fase 1 diimplementasikan** · Penulis: Tech Lead · 2026-11-03

> **Catatan implementasi** (beda dari usulan di bawah):
> - **D3/D4:** tidak ada `acp-translator.js` dan `acp-rpc.js` terpisah. `src/acp-session.js` berisi `AcpAdapter`, yang mengubah update ACP menjadi pesan stream-json ala Claude dan memasukkannya ke `StreamTranslator` yang sama. Di file itu juga ada klien JSON-RPC kecil di `AcpSession`, turunan `ClaudeSession` lewat `acpSessionClass()`. Hasilnya, `translator.js` tidak perlu diubah sama sekali.
> - **D7:** token OpenCode dicatat ke ledger dengan akun `OpenCode` (`OPENCODE_ACCOUNT`), bukan field `engine`.
> - **D8:** daftar model berasal dari `opencode models` (di-cache 10 menit, `src/opencode-bin.js`), dilayani `POST /api/projects/:id/models`. Respons memuat `needsStart: true` kalau daftarnya kosong, sehingga UI memuat ulang.
> - **Start dingin:** proses yang mati saat handshake dicoba ulang sekali dengan antrean tetap utuh.
> - **Test:** `test/opencode.test.mjs` dengan `test-support/fake-acp.mjs`, termasuk simulasi start dingin. Uji end-to-end manual dengan OpenCode asli (`opencode-go/beam-free`) lulus: kartu izin Write, file dibuat, token dan biaya tercatat.
Lingkup: satu project bisa memakai **OpenCode** (lewat Agent Client Protocol, `opencode.exe acp`) sebagai pengganti Claude Code. Chat, kantor pixel-art, kartu izin, Stop/Esc, antrean, laporan token, dan pemulihan setelah restart tetap bekerja dengan UI yang sama.
Batasan tetap: Node ≥ 20 ESM, **nol dependensi npm**, Windows sebagai platform utama, frontend vanilla. **Config OpenCode milik user tidak pernah diubah.** Semua perintah punya timeout (maksimal 120 detik), tanpa loop tunggu tanpa batas, dan `windowsHide: true`.

Fakta protokol di dokumen ini berasal dari probe OpenCode v2.0.18 (lihat §0.1). Bagian yang hanya bersumber dari spesifikasi ACP ditandai *(spek)* dan harus diverifikasi lewat `test-support/opencode-contract.mjs`.

---

## 0. Ringkasan keputusan

| # | Keputusan | Alasan singkat |
|---|---|---|
| D1 | Setting per project **`engine: 'claude' \| 'opencode'`**, default `'claude'`, disimpan di `persisted.settings[id]` bersama `mode/model/effort/team` | Satu tempat untuk setting per project. Project lama tanpa field ini otomatis bernilai `claude`, jadi tidak perlu migrasi data. |
| D2 | Kelas baru **`AcpSession`** (`src/acp-session.js`) dengan **API publik yang sama** seperti `ClaudeSession` untuk method yang dipanggil routes/queue. `SessionManager.get()` memilih kelas berdasarkan `engine` | Routes, queue, dan hub tidak perlu tahu mesin mana yang dipakai. Method yang tidak didukung mengembalikan error yang jelas (`unsupported`), bukan crash. |
| D3 | **`AcpTranslator`** (`src/acp-translator.js`) mengubah `session/update` menjadi pemanggilan **sink yang sama** (`chat`, `updateChat`, `office`, `status`) dengan nama tool **ala Claude** (`Read`, `Edit`, `Bash`, ...) | `inferRole`, `screenFor`, `describeTool`, `inputDetail`, `parseTestSummary`, animasi kantor, dan detektor macet dipakai ulang tanpa perubahan. |
| D4 | Klien JSON-RPC 2.0 kecil milik kita (`src/acp-rpc.js`, sekitar 120 LOC): framing per baris, korelasi `id`, timeout per request, dan handler untuk request dari agent | Tanpa dependensi. Protokolnya sederhana. |
| D5 | Izin dipaksa lewat env **`OPENCODE_CONFIG_CONTENT`** saat spawn (dibangun dari mode app) dan dijawab lewat `session/request_permission` | Tidak menyentuh `opencode.json` user. Mode berganti → proses di-respawn saat idle, sama seperti `reloadSettings()` di Claude. |
| D6 | Setelah satu **reject** dalam suatu giliran, semua kartu izin lain yang masih terbuka di giliran itu **ditutup otomatis** (ditolak); `PermissionNotFoundError` / `stopReason: "cancelled"` ditampilkan sebagai **"Dihentikan"**, bukan error | Sesuai perilaku yang terbukti di probe: setelah reject, OpenCode membatalkan giliran dan permintaan paralel lainnya sudah tidak valid. |
| D7 | Token/biaya: `usage` dari hasil `session/prompt` per giliran; biaya = **selisih** `usage_update.cost.amount` (kumulatif sesi). Dicatat ke ledger dengan `engine: 'opencode'` dan `model: 'provider/model'` | Laporan dan batas biaya antrean tetap berfungsi. Biaya model gratis = 0. |
| D8 | Daftar model per project diambil dari `configOptions` milik `session/new` dan **di-cache per project** (`persisted.engineCatalog.opencode`) | Ada 144 model dan bergantung pada provider yang dikonfigurasi user. Tidak boleh tercampur dengan katalog Claude (`persisted.catalog`). |
| D9 | Mengganti mesin = **percakapan baru**: proses dihentikan, `sessionId` dikosongkan, dan chat mendapat info "Mesin diganti ke OpenCode" | Transcript Claude dan sesi OpenCode tidak saling kompatibel. Cara paling sederhana yang jujur. |
| D10 | UI memakai **flag kemampuan per mesin** (`config.engines[engine].caps`) untuk menyembunyikan fitur yang tidak didukung | Frontend tidak perlu bercabang dengan `if (engine === 'opencode')` di banyak tempat. |
| D11 | Ditemukan seperti `claude-bin.js`: env `OPENCODE_BIN`, lalu `node_modules/@opencode/cli/bin/opencode.exe` di setiap dir PATH, lalu `opencode.exe` langsung yang terverifikasi `--version`. **Spawn tanpa shell** | Shim `.cmd`/`opencode` di PATH tidak bisa di-spawn tanpa shell, dan shell membuka celah injeksi argumen. |

### 0.1 Fakta protokol yang sudah terbukti (OpenCode v2.0.18)

- `opencode.exe acp`: JSON-RPC 2.0, satu JSON per baris lewat stdio.
- `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}, terminal:false}}` → `agentCapabilities {loadSession:true, promptCapabilities:{image:true, embeddedContext:true}, sessionCapabilities:{close,delete,fork,list,resume}}`.
- `session/new {cwd, mcpServers:[]}` → `{sessionId:"ses_…", configOptions:[{id:"model", type:"select", currentValue, options:[{value:"provider/model", name}]}, {id:"mode", currentValue:"build", options:build/plan}]}` + notifikasi `available_commands_update` (`init`, `review`).
- `session/set_config_option {sessionId, configId, value}` berfungsi.
- `session/prompt` → `{stopReason:"end_turn"|"cancelled", usage:{inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens}}`.
- `session/update`: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update {used, size, cost:{amount, currency}}`; *(spek)* `plan`, `session/cancel`, `session/load`.
- Izin: `session/request_permission` dengan opsi `once` / `always` / `reject`, dijawab dengan `{outcome:{outcome:"selected", optionId}}`.

---

## 1. Setting `engine` per project

### 1.1 Data

```js
// src/hub.js
export const ENGINES = ['claude', 'opencode'];
export const DEFAULT_SETTINGS = { engine: 'claude', mode: 'manual', model: '', effort: '', team: true };
```

`cleanSettings(base, patch)`:
- `ENGINES.includes(patch.engine)` → `next.engine = patch.engine`. Nilai lain diabaikan (sama seperti field lain).
- **Validasi model bergantung pada mesin**: untuk `opencode`, `model` valid jika `''` atau ada di `persisted.engineCatalog.opencode.models[].value` **atau** cocok dengan `^[a-z0-9][\w.-]*\/[\w.:@-]+$` (provider/model). Ini supaya model bisa dipilih sebelum katalog pertama terisi; kalau OpenCode menolaknya, kita tampilkan error dan model kembali ke default.
- Jika `patch.engine` berbeda dari `base.engine`, maka `model` dan `effort` di-reset ke `''` (model Claude tidak berlaku di OpenCode, dan sebaliknya). `mode` dipertahankan, tapi `dontAsk` dipetakan ke `manual` untuk OpenCode (§5.2).
- `effort` **diabaikan** untuk OpenCode di Fase 1 (lihat tabel paritas).

### 1.2 Migrasi

Tidak ada migrasi data: `settingsFor(id)` sudah melakukan `{ ...DEFAULT_SETTINGS, ...persisted }`, jadi project lama mendapat `engine: 'claude'`. Ekspor dan backup ikut membawa field ini. Template project (`src/templates.js`) dan "duplikat setting" (hub.js:606) **ikut menyalin** `engine`.

### 1.3 Ganti mesin (D9)

Endpoint settings yang sudah ada (`PATCH` settings → `hub.updateSettings`) menerima `engine`. Jika `engine` berubah:
1. Tolak dengan `409 { error: 'busy' }` kalau sesi sedang menjalankan giliran atau ada item antrean yang `started` (pengguna harus Stop dulu).
2. `sessions.get(project).kill()`, `sessions.delete(project.id)`, `hub.setSessionId(id, null)`.
3. Chat info: "Mesin diganti ke OpenCode. Percakapan baru dimulai."
4. `SessionManager.get()` berikutnya membuat kelas yang sesuai.

---

## 2. `AcpSession` dan paritas

### 2.1 Posisi di arsitektur

```
routes/queue ──► SessionManager.get(project)
                   ├─ engine 'claude'   → ClaudeSession (tidak berubah)
                   └─ engine 'opencode' → AcpSession
                                           ├─ AcpRpc       (stdio JSON-RPC, src/acp-rpc.js)
                                           ├─ AcpTranslator (session/update → sink, src/acp-translator.js)
                                           └─ hub (chat/office/status/approval/ledger) — sama
```

`SessionManager` mendapat `opencode` (hasil `findOpencode()`) di konstruktornya, berdampingan dengan `claude`. `shutdown()` tidak berubah karena `AcpSession` mengimplementasikan `turnActive / beginShutdown / waitTurnEnd / closeChild`.

### 2.2 Siklus hidup proses

| Langkah | Detail |
|---|---|
| spawn | `spawn(bin.command, [...bin.args, 'acp'], { cwd: project.path, windowsHide: true, stdio: ['pipe','pipe','pipe'], env })`. `env` = `process.env` + `OPENCODE_CONFIG_CONTENT` (§5) + `OPENCODE_DISABLE_AUTOUPDATE=1` + `OPENCODE_CLIENT=adhit-office`. **Tanpa** `OPENCODE_CONFIG_DIR` atau `OPENCODE_DISABLE_PROJECT_CONFIG` (config user dan project tetap berlaku; kita hanya menimpa `permission`). |
| handshake | `initialize` (timeout **20 dtk**) lalu `session/load {sessionId, cwd, mcpServers:[]}` jika ada `sessionIdFor(id)`, atau `session/new` (timeout **30 dtk**). Hasilnya: `sessionId` → `hub.setSessionId`, `configOptions` → katalog (D8), lalu `set_config_option` untuk model/mode jika berbeda dari `currentValue` (timeout 10 dtk masing-masing). |
| gagal handshake | Kill tree, chat error "OpenCode gagal start: <pesan>; stderr: <500 karakter terakhir>", prompt yang menunggu ditandai `cancelled`. Jika `session/load` gagal (sesi sudah dihapus), coba sekali `session/new` dengan info "Sesi lama tidak ditemukan; memulai sesi baru". |
| prompt | Prompt **diserialkan** oleh antrean milik kita (`inflight` sama seperti Claude: `queued` → `started`). Satu `session/prompt` aktif sekaligus; berikutnya dikirim setelah hasilnya kembali. Tanpa timeout request (giliran bisa lama); dijaga oleh detektor macet dan Stop. |
| exit/crash | `child.on('exit')`: request yang menunggu di-reject (`ProcessExited`), giliran aktif ditutup sebagai `halt` (office) + chat error jika `code !== 0` dan bukan karena kita yang menutup. `child = null`; prompt berikutnya men-spawn ulang dan menjalankan `session/load`. |
| idle shutdown | Sama: `IDLE_SHUTDOWN_MS` (20 menit) setelah idle → `closeChild()`. |
| closeChild | `stdin.end()`; jika belum keluar dalam 3 dtk → `killTree(pid)`. |
| killTree | Reuse logika `ClaudeSession.killTree` (Windows: `taskkill /pid <pid> /T /F`, timeout 10 dtk, windowsHide). **Dipindahkan ke `src/util.js`** sebagai `killTree(pid)` agar dipakai oleh kedua kelas. |

### 2.3 Tabel paritas `ClaudeSession` → `AcpSession` (Fase 1)

Legenda: **Ya** = didukung · **Tunda** = belum di Fase 1, method mengembalikan `unsupported` · **Sembunyi** = UI disembunyikan lewat caps.

| Fitur / method | Fase 1 | Implementasi ACP / alasan |
|---|---|---|
| `prompt(text, attachments, extra)` streaming | **Ya** | `session/prompt`, `prompt:[{type:'text'}]`. Lampiran gambar → `{type:'image', mimeType, data}` (`promptCapabilities.image`); lampiran teks → `{type:'resource', resource:{uri:'file:///<name>', mimeType, text}}` (`embeddedContext`). |
| Antrean (`inflight`, `queued`, batal item antrean) | **Ya** | Antrean milik kita (OpenCode tidak punya antrean stdin seperti Claude). Membatalkan item yang belum mulai cukup dilakukan di sisi kita. |
| `stop()` (Stop/Esc) | **Ya** | Notifikasi `session/cancel {sessionId}`. Kartu izin terbuka dijawab `{outcome:{outcome:'cancelled'}}` *(spek)*. Jika `session/prompt` belum kembali dalam 10 dtk → `killTree` + respawn lazy. |
| `reset()` | **Ya** | `sessionId` dikosongkan, `closeChild()`. Sesi baru dibuat saat prompt berikutnya. |
| `resume(sessionId, history)` | **Ya** | `session/load`. Replay `session/update` dari OpenCode **dibuang** (flag `replaying` di translator) karena chat sudah disimpan oleh `chat-store` milik kita; history untuk tampilan diambil dari `session/list` (lihat baris di bawah). |
| Daftar sesi (Riwayat) | **Ya (minimal)** | `session/list {cwd}` *(spek, `sessionCapabilities.list`)* → `{id, title, updatedAt}`. Route `/sessions` bercabang per mesin. Ekspor percakapan (`exportSession`) → **Tunda**. |
| `continueInterrupted()` setelah restart | **Ya** | Sama: `trackTurn()` menandai giliran yang terputus di disk; setelah restart, `session/load` lalu prompt `CONTINUE_PROMPT`. |
| `syncSettings()` | **Ya** | Model/mode plan → `set_config_option` (tanpa respawn). Perubahan mode izin → `restartPending`, respawn saat idle (env berubah). |
| Pemilih model | **Ya** | Dari `configOptions[id=model]` (D8). |
| Mode izin manual/acceptEdits/auto/plan | **Ya** | §5.2. `dontAsk` → **Sembunyi**. |
| Effort | **Sembunyi** | ACP tidak punya padanannya. Varian "thinking" OpenCode berbeda per provider; ditunda. |
| Kartu izin + "Izinkan semua" (autoApprove) | **Ya** | §5. "Selalu" → `optionId:'always'` (disimpan OpenCode **di memori sesi**, tidak ditulis ke config user — wajib dicek di kontrak, Q3). |
| AskUserQuestion / ExitPlanMode (kartu question/plan) | **Sembunyi** | ACP Fase 1 tidak punya padanannya. Mode plan cukup memakai `mode=plan`; setelah selesai, user mengganti mode secara manual. |
| Tool + animasi kantor | **Ya** | §3. |
| Board/todo | **Ya** | `plan {entries}` *(spek)* → `office board` + `status.todos`. |
| Subagen (Task/delegate) + `_meta child-session-updates` | **Tunda** | Format update sesi anak belum diprobe. Fase 1 tidak mengiklankan apa pun di `_meta`; tool `task` OpenCode dipetakan ke `Task` biasa (delegasi tanpa anak). |
| Mode tim (agents + lead prompt) | **Sembunyi** | `--agents` / `--append-system-prompt-file` khusus Claude. Fase 2: agent OpenCode lewat config inline. |
| `shell(command)` (`!perintah`) | **Ya** | Dijalankan oleh kita (implementasinya sama dan tidak bergantung pada mesin); hasilnya disisipkan ke prompt berikutnya. Ekstrak ke helper bersama. |
| Slash commands | **Ya (minimal)** | `available_commands_update` → katalog commands per project (`init`, `review`); dikirim sebagai teks `/init`. |
| `rewindPoints / rewindPreview / rewind` | **Sembunyi** | Tidak ada di ACP. (`session/fork` ada, tetapi semantiknya berbeda; Fase 2.) |
| `mcpStatus / mcpAction` | **Sembunyi** | MCP dikelola config OpenCode user. |
| Tugas latar (`taskOutput / stopTask / backgroundTasks`) | **Sembunyi** | Tidak ada konsep tugas latar di ACP. Mengembalikan daftar kosong. |
| `rename(title)` | **Tunda** | Tidak ada method di ACP; judul disimpan lokal saja (hub) bila diperlukan. |
| Token/biaya → ledger, laporan, batas antrian | **Ya** | §2.4. |
| Konteks (bar konteks) | **Ya** | `usage_update.used / size` → `status.context { used, size }`. |
| Detektor macet | **Ya** | Bekerja dari event office/chat yang sama (stuck-rules di frontend). Tidak perlu perubahan selama translator memancarkan `tool_start` / `tool_end` / `stop`. |
| Pemulihan setelah restart (`trackTurn`, `beginShutdown`, `waitTurnEnd`) | **Ya** | `beginShutdown` = `session/cancel`; sisanya sama. |
| Mirror CLI (`src/mirror.js`) | **Tunda** | Membaca transcript Claude; tidak berlaku. |
| Akun Claude (`childAccount`, switch akun) | **N/A** | OpenCode memakai auth provider sendiri (`opencode auth`). `accountChanged()` tidak menyentuh sesi OpenCode. |
| Rate limit / api_retry info | **Tunda** | Belum terlihat di probe. |

### 2.4 Token, biaya, ledger

Saat `session/prompt` selesai:

```js
// usage dari hasil prompt (per giliran); cost dari usage_update (kumulatif sesi)
const costUsd = Math.max(0, (this.lastCost ?? this.costAtTurnStart) - this.costAtTurnStart);
this.m.ledger?.record({
  account: null, source: 'web', engine: 'opencode', project: this.project,
  sessionId: this.sessionId, model: this.applied.model || this.catalogDefaultModel,
  input: u.inputTokens - (u.cachedReadTokens ?? 0), output: u.outputTokens,
  cacheRead: u.cachedReadTokens ?? 0, cacheWrite: 0, costUsd, turns: 1,
});
```

- `costAtTurnStart` = `cost.amount` terakhir yang diketahui saat prompt dikirim (0 untuk sesi baru). Setelah `session/load`, `usage_update` pertama hanya dipakai sebagai baseline (bukan biaya).
- `currency !== 'USD'` → `costUsd: undefined` + log satu kali (Q4).
- `inputTokens` di OpenCode sudah termasuk cache atau belum: **Q5**, diverifikasi di kontrak. Rumus di atas mengasumsikan "termasuk".
- Hasil giliran ke translator: `{ ok, interrupted, usage, costUsd, durationMs }` → chat `result` dengan `meta { durationMs, tokensIn, tokensOut, costUsd }`, sehingga **batas biaya antrean** (`src/queue.js`, membaca `meta.costUsd`) bekerja tanpa perubahan.
- `src/usage.js` / laporan: field `engine` baru bersifat opsional (default `claude`). Laporan bisa dikelompokkan per model; model `provider/model` tampil apa adanya.

---

## 3. `AcpTranslator`: ACP → event yang sama

### 3.1 Pemetaan update

| `session/update` | Sink (sama dengan StreamTranslator) |
|---|---|
| `agent_message_chunk` (messageId baru) | `chat {kind:'assistant', text:'', streaming:true}`, lalu `updateChat` menambah teks; `office {kind:'say', role:'claude', text: firstSentence}` saat pesan selesai (messageId berganti, ada tool_call, atau akhir giliran) |
| `agent_thought_chunk` | `chat {kind:'thinking', streaming}` + `office {kind:'think', role:'claude'}` |
| `tool_call` (pending) | Disimpan saja, **belum dipancarkan** (rawInput masih `{}`). Jika dalam 1,5 dtk belum ada update, tetap dipancarkan dengan data seadanya (title/kind) |
| `tool_call_update` status `in_progress` (atau pertama kali ada rawInput) | Petakan ke nama tool Claude (§3.2) → `chat {kind:'tool', role, tool, text: describeTool, status:'running', input: inputDetail}` + `office {kind:'tool_start', role, label, tool, screen}` |
| `tool_call_update` `completed` / `failed` | `updateChat {status:'done'|'error', output}`; `office {kind:'tool_end'...}` seperti `onUser` di StreamTranslator; untuk Bash, `parseTestSummary(output)` → `office {kind:'tests'}` |
| `plan {entries}` | `office {kind:'board', items}` + `status {todos}` |
| `usage_update` | `status {context:{used, size}}`; simpan `cost.amount` |
| `available_commands_update` | `hub.setProjectCommands(id, names)` |
| hasil `session/prompt` | `onTurnResult`: tool yang masih berjalan → `status:'cancel'`; `chat {kind:'result'}`; `office {kind:'stop'|'halt'|'error', role:'claude'}` |

**Refactor kecil yang disarankan**: bagian `onToolUse` / `onToolResult` / `finishTurn` milik `StreamTranslator` sudah mengambil `(name, input, id)` secara generik. `AcpTranslator` **meng-extend atau menyusun (compose)** `StreamTranslator` dan memanggil method internal tersebut dengan blok sintetis `{ type:'tool_use', id: toolCallId, name, input }` / `{ type:'tool_result', tool_use_id, content, is_error }` / result sintetis. Dengan begitu emitWorking, rememberRole, activeRoles, dan tests tidak diduplikasi. Ini pilihan utama; menulis ulang dari nol hanya jika method internal tersebut terlalu terikat ke format Claude.

### 3.2 Pemetaan tool ACP → nama tool Claude

Urutan: lihat `kind`, lalu bentuk `rawInput`, lalu `title`.

| ACP `kind` | `rawInput` (in_progress) | Nama Claude | `input` yang dikirim ke `inferRole/screenFor/describeTool` |
|---|---|---|---|
| `read` | `{path}` / `{filePath}` | `Read` | `{file_path: path}` |
| `read` | `{query}` / `{pattern}` | `Grep` | `{pattern: query, path}` |
| `read` | `{pattern}` dengan glob (`*`) | `Glob` | `{pattern}` |
| `edit` | `{path, content}` tanpa `oldString` / file baru | `Write` | `{file_path, content}` |
| `edit` | `{path, oldString, newString}` atau `files:[…]` (patch) | `Edit` | `{file_path, old_string, new_string}` (patch: `file_path` = file pertama) |
| `execute` | `{command, cwd}` | `Bash` | `{command, description: title}` |
| `execute` | `{code}` | `Bash` | `{command: code}` (ditandai `codeExec: true` hanya untuk tampilan) |
| `fetch` *(spek)* / `other` dengan `{url}` | `{url}` | `WebFetch` | `{url}` |
| `search` *(spek)* / `other` dengan `{query}` tanpa path | | `WebSearch` | `{query}` |
| `think` *(spek)* | | (diabaikan, bukan tool) | |
| `other` dengan title `todowrite` / `todoread` | `{todos}` | `TodoWrite` | `{todos}` (status OpenCode `pending/in_progress/completed` sama) |
| `other` dengan title `task` | `{description, prompt, subagent_type}` | `Task` | apa adanya |
| lainnya | apa pun | `mcp__opencode__<title>` | rawInput apa adanya (inferRole memberi role default) |

Catatan:
- `path` relatif dibuat absolut terhadap `project.path` sebelum dipetakan (screenFor/inferRole memakai pola path seperti `test/`, `docs/`).
- Fungsi pemetaan ini **murni** (`acpToolName(kind, title, rawInput) → {name, input}`) dan diekspor untuk unit test.
- `COMMAND_RULES` (`src/role-catalog.js`) langsung berlaku karena perintah shell dipetakan ke `Bash.command`.

---

## 4. Menemukan dan menjalankan `opencode.exe`

`src/opencode-bin.js` (cermin `claude-bin.js`):

```js
export function findOpencode() {
  // 1. OPENCODE_BIN: .js/.mjs → node <file> (dipakai fake-acp di test), selain itu exe langsung
  // 2. Setiap dir di PATH: node_modules/@opencode/cli/bin/opencode(.exe)  ← nvm4w, npm global
  // 3. Biner langsung (opencode.exe di PATH, ~/.opencode/bin) hanya jika `--version` menjawab
  //    dengan pola versi (execFileSync, timeout 15 dtk, windowsHide, stdio ignore/pipe)
  // → { command, args } | null
}
```

- Hasil dicache saat start server (seperti `claude`). Tombol "Cek ulang" di dialog pemeriksaan (Fase 2) dapat memanggilnya lagi.
- Jika `null` dan project memakai OpenCode → prompt ditolak dengan chat error "OpenCode tidak ditemukan. Pasang `npm i -g @opencode/cli` atau set env OPENCODE_BIN."
- Versi (`opencode --version`, timeout 15 dtk) disimpan di `config.engines.opencode.version` untuk ditampilkan. Tanpa auto-update (`OPENCODE_DISABLE_AUTOUPDATE=1`).
- Timeout: handshake `initialize` 20 dtk, `session/new|load` 30 dtk, `set_config_option` 10 dtk, `session/list` 10 dtk, cancel → hasil prompt 10 dtk sebelum kill. Semua lewat `AcpRpc.request(method, params, timeoutMs)` yang me-reject dengan `TimeoutError` dan **tidak** meninggalkan entri di map pending.
- Baris stdout yang bukan JSON → diabaikan (dicatat ke ring buffer debug 2 KB). Baris > 8 MB → proses dianggap rusak, kill.

---

## 5. Izin dan mode

### 5.1 Alur

```
OpenCode ──request session/request_permission {toolCall, options}──► AcpSession.onPermission
  ├─ autoApprove && kind tool  → jawab 'once' langsung
  ├─ else → hub.chat {kind:'approval'} + hub.requestApproval({id, kind:'tool', tool:<nama Claude>,
  │         label: describeTool, input: preview (diff dari content[type=diff] / command), canAlways:true})
  │         + office {kind:'ask'}
  └─ keputusan user:
       allow           → optionId 'once'
       allow + always  → optionId 'always'
       allowAll        → 'once' + this.autoApprove = true
       deny            → optionId 'reject'
                          → turnRejected = true; SEMUA approval lain yang masih pending di giliran ini
                            ditutup: dijawab 'reject' (jika request masih hidup) dan kartunya
                            ditandai "Ditutup otomatis (giliran dihentikan)"
```

- `approvalId` = `acp:<jsonrpc id>`; id JSON-RPC dari agent bisa berupa angka atau string, dan disimpan apa adanya untuk balasan.
- Pratinjau: `content[].type === 'diff'` → `{file_path, old_string: oldText, new_string: newText}` agar renderer diff kartu yang sudah ada bisa dipakai. Teks dipotong ke batas `previewInput` yang sama.
- Kartu yang masih terbuka saat giliran berakhir (`stopReason` apa pun) atau proses exit → `hub.resolveApproval(id, 'expired')`.
- Hasil prompt berupa error `-32603` dengan `data.errorName === 'PermissionNotFoundError'` **atau** `stopReason: 'cancelled'` → giliran ditutup sebagai **interrupted** (`office halt`, `result {ok:false, text:'Dihentikan'}`), bukan chat error.
- Web Push (`src/push.js`): request izin melewati `hub.requestApproval` yang sama, jadi notifikasi ikut berfungsi. `LOCKSCREEN_SAFE_TOOLS` berlaku pada nama tool hasil pemetaan (`Read/Edit/Write`).

### 5.2 Pemetaan mode

| Mode app | `OPENCODE_CONFIG_CONTENT` | configOption `mode` |
|---|---|---|
| `manual` | `{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}` | `build` |
| `acceptEdits` | `{"permission":{"edit":"allow","bash":"ask","webfetch":"ask"}}` | `build` |
| `auto` | `{"permission":{"edit":"allow","bash":"allow","webfetch":"allow"}}` | `build` |
| `plan` | seperti `manual` | `plan` |
| `dontAsk` | tidak ditawarkan (UI sembunyi); jika tersimpan → diperlakukan `manual` | `build` |

- Perubahan `edit/bash/webfetch` hanya berlaku lewat respawn (env) → `restartPending = true`, respawn saat idle + `session/load` (seperti `reloadSettings()`). Perubahan `plan` ↔ `build` saja → `set_config_option` tanpa respawn.
- `OPENCODE_CONFIG_CONTENT` di-merge OpenCode **di atas** config user/project. Aturan `permission` yang lebih spesifik di config user (mis. `bash: {"git *": "allow"}`) mungkin tetap menang (Q2). Ini tidak melonggarkan mode `manual` lebih dari yang dipilih user sendiri.
- JSON env dibangun dengan `JSON.stringify` dari objek konstan, tidak pernah dari input user.

---

## 6. UI

### 6.1 Kontrak config (`GET /api/config` dan event `config`)

```js
config.engines = {
  claude:   { available: true,  version: '2.1.x', caps: CAPS_CLAUDE },
  opencode: { available: true,  version: '2.0.18', caps: CAPS_OPENCODE },
};
// caps (boolean): effort, team, rewind, mcp, bgTasks, askQuestion, exportSession, mirror, modes:[...]
const CAPS_OPENCODE = { effort:false, team:false, rewind:false, mcp:false, bgTasks:false, askQuestion:false,
                        exportSession:false, mirror:false, modes:['manual','acceptEdits','auto','plan'] };
```

Status project (`hub.setStatus`) menambah `engine` (sudah ada lewat settings) dan `models` **per project** untuk OpenCode:

```js
// GET /api/projects/:id/models  →  { engine:'opencode', models:[{value:'opencode-go/beam-free', name:'Beam (free)'}], current:'…', fetchedAt }
```

- Katalog terisi saat sesi pertama start. Sebelum itu, endpoint mengembalikan `models: []` dan `needsStart: true`; pemilih model menampilkan "Default (dari config OpenCode)" + teks "Daftar model muncul setelah pesan pertama".
- 144 model: pemilih model OpenCode memakai **kotak pencarian** (filter teks klien) dan dikelompokkan per provider (prefix sebelum `/`).

### 6.2 Perubahan frontend

| Tempat | Perubahan |
|---|---|
| `public/js/features/settings.js` (setting project) | Pilihan **Mesin**: Claude Code / OpenCode (OpenCode dinonaktifkan dengan tooltip jika `available:false`). Konfirmasi: "Mengganti mesin memulai percakapan baru." Tangani `409 busy`. |
| `public/js/features/composer.js` | Membaca `caps` mesin project: sembunyikan effort, toggle Mode tim, dan mode `dontAsk`; pemilih model memakai `/models` untuk OpenCode. |
| `public/js/features/rewind.js`, `mcp.js`, `tasks.js`, `conversations.js` (ekspor) | Tombol/entri disembunyikan jika cap `false`. |
| `public/js/features/statusline.js` + kartu dashboard | Label mesin kecil "OpenCode" (badge) bila `engine !== 'claude'`. |
| `public/js/features/approvals.js` | Teks penutupan otomatis ("Ditutup otomatis: giliran dihentikan"). Tidak ada perubahan struktur. |
| `public/js/features/report.js` | Kolom/filter mesin (opsional, Fase 1 cukup menampilkan nama model `provider/model`). |
| `public/js/core/engine-caps.js` (baru, murni) | `capsFor(config, engine)` + default aman bila config lama (tanpa `engines`) → caps Claude. Diuji unit. |

---

## 7. Test

### 7.1 `test-support/fake-acp.mjs` (seperti `fake-claude.mjs`)

Skrip Node yang dijalankan lewat `OPENCODE_BIN=<path>.mjs`. Ia membaca JSON-RPC per baris dan menjawab sesuai **skenario dari teks prompt** (pola yang sama dengan fake-claude):

| Prompt mengandung | Perilaku fake |
|---|---|
| (biasa) | `agent_message_chunk` x3 → `usage_update` → hasil `end_turn` + usage |
| `[read]` / `[edit]` / `[bash:npm test]` | `tool_call` pending → `tool_call_update` in_progress + rawInput → completed (output `"5 passing"` untuk test) |
| `[ask-edit]` | `session/request_permission` (kind edit, content diff); allow → tool completed, reject → failed + `cancelled` |
| `[ask-parallel]` | Dua permintaan izin paralel; setelah satu reject → prompt error `-32603 PermissionNotFoundError` |
| `[slow]` | Chunk tiap 200 ms sampai `session/cancel` → `cancelled` |
| `[crash]` | `process.exit(3)` di tengah giliran |
| `[hang-init]` | Tidak menjawab `initialize` (uji timeout handshake, timeout di-override lewat env test menjadi 1 dtk) |
| `[plan]` | Update `plan` dengan 3 entri |

Juga: `session/new` mengembalikan `configOptions` kecil (3 model), `session/load` me-replay 2 update (harus diabaikan oleh translator), `session/list`, `set_config_option`, dan menulis `OPENCODE_CONFIG_CONTENT` yang diterimanya ke event `_meta` di hasil `initialize` agar test bisa memverifikasi env mode.

### 7.2 Test otomatis (`node --test`, semua dengan timeout per test ≤ 60 dtk)

| File | Isi |
|---|---|
| `test/acp-translator.test.mjs` (baru) | Unit: `acpToolName` (tabel §3.2), chunk → chat/office, completed/failed, tests summary, plan → board, replay diabaikan, hasil cancelled → halt. |
| `test/acp-rpc.test.mjs` (baru) | Framing (baris terpecah/ganda), timeout tidak bocor, request dari agent, exit me-reject semua pending. |
| `test/opencode-server.test.mjs` (baru) | Integrasi lewat server penuh + fake-acp: setting engine (validasi, 409 busy, reset sesi), streaming, kartu izin allow/reject/auto-tutup paralel, Stop, antrean 2 prompt, ledger mencatat `engine:'opencode'` dan selisih biaya, respawn saat mode berganti (env berubah), crash → halt + prompt berikutnya `session/load`, handshake timeout → error jelas, `continueInterrupted`. |
| `test/server.test.mjs` | Satu test regresi: project tanpa `engine` tetap memakai Claude (fake-claude) dan config lama tetap valid. |
| `test/ui.test.mjs` / unit `engine-caps` | Kontrol disembunyikan sesuai caps; pemilih model memakai `/models`. |

### 7.3 `test-support/opencode-contract.mjs` (manual, model gratis)

Dijalankan manual: `node test-support/opencode-contract.mjs` (memakai `findOpencode()`, model `opencode-go/beam-free`, cwd = direktori temp baru). Setiap langkah punya timeout (maks 120 dtk) dan skrip selalu `killTree` di `finally`. Yang diverifikasi:
1. Bentuk `initialize`, `session/new`, `configOptions`.
2. Prompt teks → chunk + `end_turn` + bentuk `usage`.
3. Tool read/edit/bash: urutan `tool_call` → `tool_call_update` dan bentuk `rawInput` untuk setiap kind (memperbarui tabel §3.2).
4. Izin dengan env `manual`: allow / reject / paralel (`PermissionNotFoundError`).
5. `session/cancel` saat giliran berjalan → `cancelled`.
6. `session/load` + replay, `session/list`.
7. `plan` update (jika muncul), `usage_update.cost`, apakah `inputTokens` termasuk cache (Q5).
8. Opsi `always` **tidak** mengubah file config user (hash `~/.config/opencode/*` sebelum dan sesudah, Q3).

Hasilnya dicetak sebagai tabel PASS/FAIL. Tidak dijalankan di CI (membutuhkan jaringan dan auth).

---

## 8. Keamanan

| Risiko | Mitigasi |
|---|---|
| Injeksi argumen/perintah saat spawn | `spawn` tanpa shell, argumen tetap `['acp']`; `cwd` = path project yang sudah divalidasi `projects.js`. |
| Config user berubah | Tidak menulis file apa pun ke dir config OpenCode; hanya env `OPENCODE_CONFIG_CONTENT` (objek konstan). Diverifikasi kontrak langkah 8. |
| Mode lebih longgar dari pilihan user | Env dibangun dari `settings.mode` yang sudah divalidasi. `auto` hanya bisa dipilih lewat UI yang sama (gerbang `LOCAL_ONLY`/WiFi read-only tetap berlaku). |
| fs/terminal dari agent ke klien | `clientCapabilities.fs.*=false`, `terminal:false`; request `fs/*` atau `terminal/*` dari agent dijawab error `-32601`. Agent tidak bisa membaca file lewat klien kita. |
| Output agent berbahaya di UI | Melewati renderer chat/markdown yang sama (escape, CSP). Teks dipotong dengan batas `truncate` yang sama. |
| Kunci provider di env/log | `stderr` yang ditampilkan dipotong 500 karakter dan **disensor** dengan pola `sk-…`, `key=…`, `Bearer …` sebelum masuk chat/log. Env tidak pernah dikirim ke frontend. |
| Push/lock screen | Payload tetap hanya nama tool (D8 di desain web push). |
| Proses yatim (orphan) | `killTree` saat exit, shutdown server, idle, dan timeout cancel. |
| JSON-RPC raksasa/rusak | Batas baris 8 MB, parse dalam try/catch, id yang tidak dikenal diabaikan. |

---

## 9. Pembagian kerja dan kontrak

### 9.1 Backend (tanpa menyentuh `public/`)

| File | Status | Isi |
|---|---|---|
| `src/opencode-bin.js` | baru | `findOpencode()`, `opencodeVersion()` |
| `src/acp-rpc.js` | baru | `AcpRpc` (request/notify/onRequest/onNotification, timeout, close) |
| `src/acp-translator.js` | baru | `AcpTranslator`, `acpToolName()` (murni, diekspor) |
| `src/acp-session.js` | baru | `AcpSession` (API publik §2.3), pemetaan mode → env, ledger |
| `src/session.js` | ubah | `SessionManager`: terima `opencode`, `get()` memilih kelas, `killTree` dan helper `shell` dipindah ke `src/util.js`. `ClaudeSession` hanya ganti import |
| `src/translator.js` | ubah kecil | Ekspos `onToolUse/onToolResult/finishTurn` agar bisa dipakai `AcpTranslator` (tanpa perubahan perilaku) |
| `src/hub.js` | ubah | `ENGINES`, `engine` di `DEFAULT_SETTINGS`/`cleanSettings`, validasi model per mesin, `persisted.engineCatalog`, `config.engines` + caps |
| `src/routes/session.js`, `src/routes/project.js` | ubah | `/sessions` bercabang per mesin; `GET /api/projects/:id/models`; `409 busy` saat ganti mesin; method `unsupported` → `409 { error:'unsupported' }` |
| `src/usage.js` | ubah kecil | Field `engine` opsional di ledger + agregasi |
| `src/server.js` | ubah kecil | `findOpencode()` saat start, teruskan ke `SessionManager` |
| `test-support/fake-acp.mjs`, `test-support/opencode-contract.mjs`, `test/acp-*.test.mjs`, `test/opencode-server.test.mjs` | baru | §7 |

### 9.2 Frontend (tanpa menyentuh `src/`)

| File | Isi |
|---|---|
| `public/js/core/engine-caps.js` (baru) | `capsFor()` murni |
| `public/js/features/settings.js` | Pilihan mesin + konfirmasi + 409 |
| `public/js/features/composer.js` | Caps, pemilih model OpenCode (cari + grup) |
| `public/js/features/rewind.js`, `mcp.js`, `tasks.js`, `conversations.js`, `statusline.js`, `dashboard.js`, `approvals.js` | Sembunyikan sesuai caps, badge mesin, teks auto-tutup |
| `test/ui.test.mjs` (bagian UI) + unit `engine-caps` | |

### 9.3 Kontrak API/event (dibekukan sebelum kerja paralel)

1. `PATCH` settings menerima `engine: 'claude'|'opencode'` → `200 {settings}` atau `409 {error:'busy'}`.
2. `config.engines[engine] = { available, version, caps }` (§6.1). Config tanpa `engines` = hanya Claude.
3. `GET /api/projects/:id/models` → `{ engine, models:[{value,name}], current, needsStart? }`.
4. Status project menyertakan `engine`.
5. Event chat/office/approval **tidak berubah bentuk**. Tambahan: approval bisa ditutup dengan `status:'auto-closed'`; result `meta.costUsd` bisa `0`.
6. Method sesi yang tidak didukung → `409 {error:'unsupported', engine}`.

### 9.4 Urutan pengerjaan

| Langkah | Role | Hasil | Bergantung pada |
|---|---|---|---|
| 1 | Backend | `opencode-contract.mjs` dijalankan sekali; perbarui §3.2 dan jawab Q1/Q3/Q5 | — |
| 2 | Backend | `acp-rpc.js` + test | — |
| 3 | Backend | `fake-acp.mjs` | 2 |
| 4 | Backend | `acp-translator.js` + refactor kecil `translator.js` + test | 1 |
| 5 | Backend | Setting `engine` di hub + `config.engines` + endpoint `/models` (kontrak §9.3 nyata, bisa dipakai FE) | — |
| 6 | Frontend | `engine-caps.js`, settings, composer, penyembunyian fitur (dengan data dari langkah 5 atau mock) | 5 (kontrak) |
| 7 | Backend | `acp-session.js` + `SessionManager.get` + izin + ledger + test integrasi | 2, 3, 4, 5 |
| 8 | QA/Tech Lead | Review, jalankan kontrak manual end-to-end dengan `beam-free`, update README ("Memakai OpenCode") | 6, 7 |

---

## 10. Pertanyaan terbuka

| # | Pertanyaan | Cara menjawab |
|---|---|---|
| Q1 | Bentuk `rawInput` persis untuk glob/grep/webfetch/todowrite/task di v2.0.18, dan apakah `kind` `fetch/search/think` benar dipakai | Kontrak langkah 3 |
| Q2 | Apakah aturan `permission` granular di config user mengalahkan `OPENCODE_CONFIG_CONTENT`? | Uji manual dengan config temp (`OPENCODE_CONFIG_DIR` ke direktori temp **hanya di kontrak**) |
| Q3 | Apakah `optionId:'always'` dipersist ke disk oleh OpenCode? Jika ya, `canAlways` dimatikan di Fase 1 | Kontrak langkah 8 |
| Q4 | `usage_update.cost.currency` selain USD mungkin? | Asumsi USD; selain itu biaya kosong |
| Q5 | Apakah `inputTokens` sudah termasuk `cachedReadTokens`? | Kontrak langkah 7 |
| Q6 | Format update sesi anak (`_meta opencode/child-session-updates`) untuk animasi subagen | Fase 2 |
| Q7 | Apakah perlu mode tim untuk OpenCode (agent inline lewat `OPENCODE_CONFIG_CONTENT.agent`)? | Keputusan produk, Fase 2 |
| Q8 | Respon `session/request_permission` saat cancel: `{outcome:{outcome:'cancelled'}}` diterima v2.0.18? | Kontrak langkah 5 |

## 11. Fase 1b: mesin per aplikasi (workspace) dan login provider

Keputusan (permintaan user): mesin bukan lagi pilihan per project di composer, tapi pilihan **seluruh aplikasi** di 👤 Akun.
Tiap mesin adalah entitas terpisah; pindah mesin tidak menghapus riwayat mesin lain.

- **State** (`src/hub.js`): `persisted.engine` = mesin aktif. Kunci per mesin `WORKSPACE_KEYS = settings, sessions, turns,
  interrupted` tetap di tempat lamanya untuk mesin aktif (kode lain tidak berubah); milik mesin yang tidak aktif disimpan di
  `persisted.workspaces[<engine>]` dan ditukar oleh `Hub.switchEngine`. Chat: `data/chats` (Claude Code, tidak berubah) dan
  `data/chats-<engine>`; id pesan tetap unik lintas workspace (`seq` = max kedua folder). `settingsFor().engine` selalu mesin
  aktif; `cleanSettings` mengabaikan `engine` dari patch.
- **Pindah** (`SessionManager.switchEngine`, `POST /api/engine {engine}`): 409 kalau ada giliran berjalan atau prompt antre;
  semua proses ditutup, hub menukar workspace, event `engine` membuat semua halaman memuat ulang (snapshot baru).
  Hanya laptop/Tailscale (`ACCOUNT_AUTH`).
- **Login provider** (`src/opencode-auth.js`, semua `opencode api <operation>`):
  `integration.list` (provider, metode key/oauth/env, koneksi), `integration.connect.key {key, answer}`,
  `integration.oauth.connect {methodID, answer}` → `{attemptID, url, instructions, mode: auto|code}`, `integration.oauth.status`
  (pending/complete/failed/expired, dipoll halaman tiap 2 dtk maks 10 menit), `integration.oauth.complete {code}`,
  `integration.oauth.cancel`, `credential.remove`. Route: `/api/opencode/providers|login/key|login/oauth|login/status|login/code|
  login/cancel|logout`. Error dipotong ke baris pertama penyebab; API key/kode tidak pernah dilog. Catatan: body (berisi API key)
  dikirim sebagai argumen `--data` proses `opencode` berumur pendek di laptop sendiri.
- **Riwayat sesi**: dengan OpenCode, `/api/projects/:id/sessions` memakai `opencode session list --format json` di folder project.
- **Backup** (📦) selalu berisi riwayat Claude Code (chat `data/chats` + pengaturan/sesi Claude, juga saat OpenCode aktif). Import hanya saat Claude Code aktif (409 kalau tidak), agar tidak tercampur. Chat OpenCode ikut sebagai `office/chats-opencode/<id>.jsonl` dan saat import digabung ke folder workspace OpenCode (`Hub.importEngineChats`).
- Pindah mesin juga ditolak bila 📋 Antrian masih berisi item, chat belum tersimpan ke disk, atau migrasi chat lama gagal.

## 12. Fase 2a: Mode tim, Effort, versi

- **Mode tim** (`caps.team = true`): `SessionManager.openCodeTeamConfig()` menulis `data/team/opencode-<hash>.json` = `{ agents: { <role>: { description, system, mode: "subagent" } }, instructions: [opencode-lead-<hash>.md] }` (skema `Config.Info` OpenCode 2.x) dan diberikan lewat env `OPENCODE_CONFIG` (17 prompt ≈ 34 KB, melebihi batas env Windows 32 KB untuk `OPENCODE_CONFIG_CONTENT`). Prompt Lead ditambah satu kalimat: delegasi lewat tool `subagent` (`agent` = nama role). Terbukti dengan OpenCode asli: Lead memanggil `subagent {agent:"pm"}`.
- **Atribusi subagent**: OpenCode mengalirkan tool milik subagent ke sesi yang sama dengan judul `"<description>: <tool>"`. `AcpAdapter` mengingat `description → toolCallId` dari panggilan `subagent` yang berjalan, membuang awalan judul dan mengirim `parent_tool_use_id`, jadi kerja itu tercatat untuk role subagent (seperti subagent Claude).
- **Effort** (`caps.effort = true`): opsi ACP `effort` (kategori `thought_level`, nilainya per model, mis. `low|medium|high|xhigh|max|default`). `effortValue()` memilih level terdekat yang tersedia; diterapkan setelah handshake, saat effort diganti, dan lagi setelah ganti model.
- **Versi**: `opencode --version` (15 dtk) setelah start, masuk `config.engines.opencode.version` dan tampil di tombol mesin di Akun.

## 13. Fase 2b: sesuai OpenCode asli

- **Izin digabung** (`permissionConfig(mode, readUserPermission(project))`): `permission` dari `~/.config/opencode/opencode.json(c)`, `<project>/opencode.json(c)` dan `<project>/.opencode/` dibaca (JSONC) tiap spawn. OpenCode menumpuk semua sumber config dan aturan yang cocok terakhir menang; `OPENCODE_CONFIG_CONTENT` adalah lapisan terakhir, jadi `"*"` tiap tool = yang paling ketat (deny > ask > allow) antara mode dan catch-all user (`mergePermission` di `src/opencode-bin.js`). Catch-all user = `"*"` tool itu atau aturan string-nya; hanya bila tool itu tidak punya, dipakai catch-all global (`"permission": "deny"` atau v2 `action: "*"`): aturan per-tool yang ditulis user mengalahkan aturan global miliknya sendiri (`{"*":"deny","bash":"allow"}` → bash mengikuti mode), tapi mode tetap tidak pernah melonggarkan hasilnya. Pola global (`{"*":{"rm *":"deny"}}`) ikut ke setiap tool, sebelum pola tool itu sendiri. `deny` milik user (catch-all maupun pola) tidak pernah dilonggarkan di mode apa pun; aturan berpola tetap (sesudah `"*"`); di ⚡ Auto `ask` user menjadi `allow` (seperti `--auto`), di dontAsk semuanya menjadi `deny`. Akibat "paling ketat": di ✏️ acceptEdits, user yang menulis `edit: "ask"` (atau `{"*":"ask"}`) tetap ditanya untuk edit — itu disengaja (pilihan user di config-nya sendiri). Format v2 `permissions: [{ action, resource, effect }]` (berurutan; `shell` = bash, `subagent` = task, `*` = semua tool) juga dibaca. Kunci key (`__proto__`, `constructor`, `prototype`) dari file user diabaikan (anti prototype pollution).
- **Run sekali baca-saja** (handoff Pintar, klasifikasi peran: `opencode run --agent plan`): `OPENCODE_CONFIG_CONTENT` = `{"permission":{"*":"deny","read":…,"grep":"allow","glob":"allow","list":"allow"}}` (`readOnlyOpenCodeEnv`), isi variabel itu yang sudah ada tetap dibawa. Dicek dengan `opencode debug agents` (2.2.5): lapisan ini datang sesudah file user (v1 maupun v2), jadi shell/MCP yang di-allow user ikut ditolak; aturan baca milik user tetap berlaku, dan `.env` (default OpenCode: ask) ditutup karena tidak ada yang bisa menjawab.
- **Agent**: nilai opsi ACP `mode` (build, plan, primary agent user) dikirim sebagai `status.agents`; setelan per project `agent` ('' = build). 📋 Rencana dulu selalu memakai `plan`. Agent yang sudah tidak ada jatuh kembali ke build.
- **Command**: `available_commands_update` → `status.commands` → autocomplete (`slashCatalog`, mesin OpenCode).
- Claude Code: command layar-terminal (`CLI_ONLY` di public/js/features/commands.js) disaring dari autocomplete; `claude doctor` / `claude update` lewat `/api/claude-check/doctor|update` (laptop saja).

