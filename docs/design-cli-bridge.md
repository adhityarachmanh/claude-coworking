# Desain: CLI bridge opt-in (izin sesi terminal dari kantor/HP)

Status: **prototipe diimplementasikan, belum dirilis.** Dokumen ini mencatat hasil uji nyata dengan Claude Code 2.1.316 (Windows) dan rencana implementasi yang aman. Rilis menunggu **uji TUI manual** (fallback prompt terminal saat hook gagal/timeout); security review prototipe sudah selesai (langkah 3) dan diulang bila kode bridge berubah. Prosedur uji dan tabel hasil: **[uji-manual-cli-bridge.md](uji-manual-cli-bridge.md)**.

## Masalah

Sesi web bisa menjawab izin lewat kartu di kantor/HP karena aplikasi yang menjalankan Claude Code (`src/session.js`, `--permission-prompt-tool stdio`). Sesi **CLI** yang kamu jalankan sendiri di terminal masih bertanya dan menunggu di terminal — README menyebutnya sebagai batasan. Kalau kamu sedang jauh dari laptop, giliran itu berhenti sampai ada yang menekan tombol di sana.

## Keputusan arah

Gunakan **wrapper opt-in** `office claude`, bukan mengubah config Claude milik user:

1. Wrapper menjalankan `claude` seperti biasa, ditambah `--settings <file>` milik aplikasi.
2. Settings itu hanya menambahkan hook `PreToolUse` untuk tool yang berbahaya (`Write|Edit|Bash|WebFetch|mcp__*`).
3. Hook mengirim payload ke server Adhitron di localhost, menunggu jawaban, lalu mengembalikan `permissionDecision: allow|deny`.
4. Kalau server mati, lambat, atau hook gagal: hook keluar tanpa keputusan → Claude Code kembali ke alur izin normal di terminal (**fail-closed oleh bridge**; hasil akhirnya mengikuti aturan izin Claude Code sendiri, yang bisa auto-allow bila user sudah punya allowlist).
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
    "permissionDecisionReason": "Disetujui dari Adhitron"
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
- `src/routes/cli-bridge.js` — `POST /api/cli-bridge/token` (laptop-only) menerbitkan **token CLI sempit**, lalu `POST /api/cli-bridge/ask` (laptop-only, `x-cli-token`, origin) dan long-poll; memakai `hub.requestApproval` supaya kartu, notifikasi HP, dan audit sama dengan sesi web.
- `office` launcher — entry point kecil yang meneruskan argumen ke `claude` dan menambahkan `--settings`. Opt-in eksplisit; tanpa `office`, tidak ada yang berubah.
- **Least privilege.** Token CLI hanya diterima `/api/cli-bridge/ask`; token itu tidak bisa memanggil API lain (shutdown, backup, jawab izin, ubah project). Token aplikasi yang disuntikkan ke `index.html` tidak lagi dipakai hook.

## Aturan keamanan (wajib)

1. **Fail-closed.** Server mati, timeout, jawaban tidak valid, atau hook error → tidak ada keputusan; prompt
   terminal Claude Code yang mengambil alih. Tidak pernah `allow`. Timeout **bukan** penolakan eksplisit.
2. **Laptop-only + token + origin** untuk endpoint bridge, sama seperti route data lain. HP hanya menjawab lewat kartu aplikasi yang sudah terautentikasi, bukan endpoint baru. Notifikasi HP untuk izin CLI tidak boleh punya tombol “Izinkan” dari layar kunci (tanpa konteks).
3. **Tidak ada isi prompt/tool di payload push.** Notifikasi HP hanya memuat nama project, role/asal, dan nama tool—persis aturan `src/push.js` sekarang. Detail perintah hanya di kartu aplikasi.
4. **Tidak menulis config user.** File settings dibuat di folder data aplikasi dan dihapus saat wrapper selesai (best effort). Token per start ditulis ke file sementara di folder temp OS (mode 0600), bukan ke environment tool, dan dihapus bersama settings.
5. **Audit.** Setiap keputusan bridge dicatat sebagai aksi `cli-approval` (tool, project, hasil allow/deny/timeout; tanpa isi perintah).
6. **Batasan waktu.** Timeout hook 120 detik; server menjawab lebih dulu (115 detik) dengan `fallback`, lalu prompt terminal muncul (perlu verifikasi manual).
7. **Matcher sempit.** Hanya tool yang benar-benar berbahaya; baca file biasa tetap mengikuti aturan Claude Code.
8. **Preview jujur.** Input yang dipotong selalu diberi penanda; tidak ada field yang tampil kosong seolah-olah tidak ada isi.
9. **Batas antrean.** Maksimal 3 izin CLI menunggu per project dan 10 secara global; lebih dari itu `429`.
10. **Batas kepercayaan.** Proses lokal dengan hak user yang sama (termasuk tool/MCP yang dijalankan agent) tetap dipercaya; bridge bukan isolasi OS dari agent hostile.

## Pertanyaan yang harus dijawab sebelum implementasi

- Apakah hook yang gagal benar-benar memunculkan prompt interaktif di TUI, atau langsung menolak? (uji manual)
- Berapa batas timeout hook yang aman di macOS/Linux dan Windows?
- Apakah hook juga berjalan untuk subagent dan MCP tool? Perlukah matcher `mcp__*`?
- Bagaimana menghindari dua kartu untuk satu izin (hook + aturan permission Claude Code)?
- Apakah `--settings` tetap dihormati saat user memakai `--resume`/`--continue`?
- Apakah sesi yang dimulai dari wrapper harus ditandai di UI sebagai “CLI bridge aktif”?

## Rencana implementasi bertahap

1. ✅ **Prototipe lokal**: launcher (`office.cmd` → `tools/cli-bridge/launch.mjs`), hook
   (`tools/cli-bridge/hook.mjs`), settings sementara (`tools/cli-bridge/settings.mjs`), route
   (`src/routes/cli-bridge.js`), dan helper payload (`src/cli-bridge.js`). Diuji otomatis dengan fake server:
   allow, deny, timeout, server error, token hilang, dan folder di luar project (semua fail-closed).
2. ⏳ **Uji TUI manual**: setujui/tolak dari terminal, HP, dan saat server mati; pastikan tidak ada auto-allow
   dan prompt terminal benar-benar muncul saat hook gagal/timeout. **Ini prasyarat rilis.**
3. ✅ **Keamanan**: review endpoint, token/origin, audit, payload push, dan launcher oleh security. Temuan
   utama sudah diperbaiki: token tidak lewat environment, preview diberi penanda pemotongan, izin CLI tidak
   bisa di-allow dari layar kunci, timeout menjadi fallback (bukan deny), kartu memakai chat/deep-link,
   sanitasi C1/bidi/zero-width, guard duplikat, dan batas antrean 3/project + 10 global. Bukti di riwayat:
   commit `1c1d404` (token CLI dibatasi ke route izin), `b8cf1a3` (kartu izin CLI), `1b57fb2` (perbaikan
   keamanan bridge).
4. 🟡 **Rilis opt-in**: dokumentasi eksperimental sudah ada di README/FITUR/PANDUAN/CHANGELOG. Status
   “siap” dan tombol “CLI bridge” di ⚙ Sistem menunggu uji TUI manual (langkah 2).
5. ⏳ **Baru setelah itu**: pertimbangkan integrasi ke sesi CLI yang sudah berjalan (di luar cakupan desain ini).
