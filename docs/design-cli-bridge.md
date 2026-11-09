# Desain: CLI bridge opt-in (izin sesi terminal dari kantor/HP)

Status: **spike selesai, belum diimplementasikan.** Dokumen ini mencatat hasil uji nyata dengan Claude Code 2.1.316 (Windows) dan rencana implementasi yang aman. Tidak ada kode produksi yang berubah karena dokumen ini.

## Masalah

Sesi web bisa menjawab izin lewat kartu di kantor/HP karena aplikasi yang menjalankan Claude Code (`src/session.js`, `--permission-prompt-tool stdio`). Sesi **CLI** yang kamu jalankan sendiri di terminal masih bertanya dan menunggu di terminal — README menyebutnya sebagai batasan. Kalau kamu sedang jauh dari laptop, giliran itu berhenti sampai ada yang menekan tombol di sana.

## Keputusan arah

Gunakan **wrapper opt-in** `office claude`, bukan mengubah config Claude milik user:

1. Wrapper menjalankan `claude` seperti biasa, ditambah `--settings <file>` milik aplikasi.
2. Settings itu hanya menambahkan hook `PreToolUse` untuk tool yang berbahaya (`Write|Edit|Bash|WebFetch|mcp__*`).
3. Hook mengirim payload ke server Adhit Office di localhost, menunggu jawaban, lalu mengembalikan `permissionDecision: allow|deny`.
4. Kalau server mati, lambat, atau hook gagal: hook keluar tanpa keputusan → Claude Code kembali ke alur izin normal di terminal (**fail-closed**, tidak pernah auto-allow).
5. Tanpa wrapper, CLI tetap 100% seperti sekarang. Tidak ada hook yang dipasang diam-diam ke `~/.claude/settings.json`.

## Hasil spike (Claude Code 2.1.316, Windows)

Hook uji: `PreToolUse` dengan matcher `Write|Edit|Bash`, `timeout: 30`, command `node hook.mjs`. Prompt meminta model membuat `izin.txt` memakai tool `Write`.

| Uji | Perilaku hook | Hasil |
|---|---|---|
| Tolak | Langsung `permissionDecision: deny` | Model menerima penolakan, `izin.txt` **tidak dibuat**, `permission_denials` berisi `Write` |
| Tunggu lalu izinkan | Tidur 4 detik, lalu `allow` | Hook benar-benar ditahan (~4 dtk), `izin.txt` dibuat berisi `ok`, giliran selesai normal |
| Hook gagal | `process.exit(1)` | `izin.txt` **tidak dibuat**; alur izin normal berjalan dan menolak (fail-closed) |
| Hook melewati timeout | `timeout: 3`, hook tidur 4 dtk | Hook dianggap gagal, `izin.txt` **tidak dibuat**; CLI tidak menggantung melewati batas |

Payload yang diterima hook (contoh nyata, diringkas):

```json
{
  "session_id": "1349129d-…",
  "transcript_path": "C:\\Users\\…\\.claude\\projects\\…jsonl",
  "cwd": "C:\\…\\work",
  "prompt_id": "3aa07c00-…",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "C:\\…\\izin.txt", "content": "ok" },
  "tool_use_id": "toolu_018R…"
}
```

Jawaban hook:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Disetujui dari Adhit Office"
  }
}
```

Catatan spike:

- `claude.exe` dari shim nvm gagal di folder kerja tertentu karena path `C:\Users\…\Author Software\…` mengandung spasi; `claude.cmd` dari instalasi npm bekerja. Wrapper harus memakai binary yang benar-benar bisa dijalankan (resolusi `.cmd` di Windows).
- `--permission-mode manual` dilaporkan sebagai `"permission_mode": "default"` di payload hook. Jangan bergantung pada nilai itu untuk keputusan keamanan.
- Hook bisa menahan proses beberapa detik; batas `timeout` hook adalah pengaman utama. Nilai yang diusulkan: **120 detik** untuk memberi waktu menjawab dari HP, dengan heartbeat/ETA di kartu.
- Mode `-p` tidak punya prompt terminal. Uji ini membuktikan fail-closed, tetapi **fallback ke prompt interaktif saat hook gagal belum diuji otomatis** (perlu uji manual di TUI). Itu syarat sebelum fitur dinyatakan siap.

## Arsitektur usulan

```
office claude
  └─ claude --settings <data>/cli-bridge/settings.json
       └─ PreToolUse hook → node <app>/tools/cli-bridge/hook.mjs
            ├─ POST http://127.0.0.1:<port>/api/cli-bridge/ask  (token + origin)
            │    └─ kartu izin yang sama di kantor/HP (hub.requestApproval)
            │         └─ jawaban user: allow / deny / selalu izinkan / tolak dengan alasan
            ├─ long-poll sampai jawaban atau timeout
            └─ stdout: permissionDecision allow|deny
```

Komponen:

- `tools/cli-bridge/hook.mjs` — membaca stdin JSON, memanggil server, mencetak keputusan. Tidak menulis log isi tool ke disk.
- `tools/cli-bridge/settings.js` — membuat file settings sementara di folder data aplikasi, dengan command hook dan timeout. File ini tidak pernah menyentuh config user.
- `src/routes/cli-bridge.js` — `POST /api/cli-bridge/ask` (laptop-only, token, origin), `GET /api/cli-bridge/answer/:id` atau long-poll; memakai `hub.requestApproval` supaya kartu, notifikasi HP, dan audit sama dengan sesi web.
- `office` launcher — entry point kecil yang meneruskan argumen ke `claude` dan menambahkan `--settings`. Opt-in eksplisit; tanpa `office`, tidak ada yang berubah.

## Aturan keamanan (wajib)

1. **Fail-closed.** Server mati, timeout, jawaban tidak valid, atau hook error → `deny`/tanpa keputusan, tidak pernah `allow`.
2. **Laptop-only + token + origin** untuk endpoint bridge, sama seperti route data lain. HP hanya menjawab lewat kartu aplikasi yang sudah terautentikasi, bukan endpoint baru.
3. **Tidak ada isi prompt/tool di payload push.** Notifikasi HP hanya memuat nama project, role, dan nama tool—persis aturan `src/push.js` sekarang. Detail perintah hanya di kartu aplikasi.
4. **Tidak menulis config user.** File settings dibuat di folder data aplikasi dan dihapus saat wrapper selesai (best effort).
5. **Audit.** Setiap keputusan bridge dicatat sebagai aksi `cli-approval` (tool, project, via terminal/HP, hasil) tanpa isi perintah.
6. **Batasan waktu.** Timeout hook 120 detik; setelah itu CLI kembali ke prompt terminal (perlu verifikasi manual).
7. **Matcher sempit.** Hanya tool yang benar-benar berbahaya; baca file biasa tetap mengikuti aturan Claude Code.

## Pertanyaan yang harus dijawab sebelum implementasi

- Apakah hook yang gagal benar-benar memunculkan prompt interaktif di TUI, atau langsung menolak? (uji manual)
- Berapa batas timeout hook yang aman di macOS/Linux dan Windows?
- Apakah hook juga berjalan untuk subagent dan MCP tool? Perlukah matcher `mcp__*`?
- Bagaimana menghindari dua kartu untuk satu izin (hook + aturan permission Claude Code)?
- Apakah `--settings` tetap dihormati saat user memakai `--resume`/`--continue`?
- Apakah sesi yang dimulai dari wrapper harus ditandai di UI sebagai “CLI bridge aktif”?

## Rencana implementasi bertahap

1. **Prototipe lokal** (tanpa rilis): launcher + hook + endpoint, diuji dengan fake server dan 1 turn Haiku.
2. **Uji TUI manual**: setujui/tolak dari terminal, HP, dan saat server mati; pastikan tidak ada auto-allow.
3. **Keamanan**: review endpoint, token/origin, audit, dan payload push oleh security.
4. **Rilis opt-in**: dokumentasi `office claude`, status di README, dan tombol “CLI bridge” di ⚙ Sistem (hanya laptop).
5. **Baru setelah itu**: pertimbangkan integrasi ke sesi CLI yang sudah berjalan (di luar cakupan desain ini).
