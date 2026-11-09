# 🌉 Figma bridge (lokal)

Jembatan lokal antara agent AI (MCP) dan **Figma desktop** lewat plugin Figma. Tidak butuh Figma API token, tidak ada data yang keluar dari laptop.

```
Agent (MCP stdio)
      ↕
tools/figma-bridge/server.mjs   (HTTP 127.0.0.1:3939 + MCP)
      ↕  polling
Plugin Figma (ui.html ↔ code.js, Plugin API)
      ↕
Dokumen Figma yang sedang dibuka
```

## Menjalankan

1. **Bridge** (biarkan terminal ini terbuka):
   ```powershell
   node tools/figma-bridge/server.mjs
   ```
   Cek: <http://127.0.0.1:3939/health> → `{"ok":true,...}`.

   Terminal juga mencetak **Token bridge**. Token itu disimpan di `%TEMP%/figma-bridge-token.txt` untuk CLI dan harus ditempel sekali di plugin (disimpan di Figma). Set `FIGMA_BRIDGE_TOKEN` (minimal 16 karakter) bila ingin token tetap.

2. **Plugin Figma** (sekali saja):
   - Buka **Figma desktop**, bukan browser.
   - Menu **Plugins → Development → Import plugin from manifest…**
   - Pilih `tools/figma-bridge/plugin/manifest.json`.
   - Buka file desainmu → **Plugins → Development → Adhit Office Bridge**.
   - Tempel **Token bridge** dari terminal ke kolom token, lalu **Simpan**.
   - Jendela plugin menampilkan “Terhubung. Menunggu perintah dari agent…”. Biarkan terbuka.

3. **Daftarkan MCP** di Adhit Office:
   - Buka project → **🔌 Server MCP** → tambah server lokal.
   - Command: `node C:\Users\adhit\projects\claude-coworking\tools\figma-bridge\server.mjs`
   - Scope: **user** (semua project) atau project ini.
   - Setelah tersimpan, agent bisa memakai tool `figma_*`.

   Untuk OpenCode/Claude Code, tambahkan server MCP stdio dengan command yang sama.

## Tool yang tersedia

| Tool | Kegunaan |
|---|---|
| `figma_status` | Plugin terhubung? file/page apa yang terbuka |
| `figma_selection` | Node yang sedang dipilih |
| `figma_page` | Struktur halaman (depth 3, maks 500 node) |
| `figma_node` | Detail satu node |
| `figma_export` | Ekspor node sebagai SVG atau PNG (data URL) |
| `figma_create_frame` | Buat frame (nama, ukuran, posisi, fill, parent) |
| `figma_create_rect` | Buat rectangle (fill, radius) |
| `figma_create_text` | Buat teks Inter (ukuran, warna) |
| `figma_set_fill` | Ganti warna solid node |
| `figma_move` | Pindahkan node |

Semua perubahan bisa dibatalkan dengan **Ctrl+Z** di Figma.

## Perintah dari terminal (opsional)

`node tools/figma-bridge/cli.mjs <perintah> [key=value ... | JSON]` mengirim perintah lewat `POST /exec` dengan token yang sama. Perintah yang tersedia: `status`, `selection`, `page`, `node`, `export`, `create_frame`, `create_rect`, `create_text`, `set_fill`, `move`, `resize`.

`delete` dan `batch` **tidak** diekspos lewat HTTP; keduanya hanya ada di dalam plugin.

## Keamanan

- Server hanya mendengarkan `127.0.0.1` dan **setiap** endpoint plugin/CLI (`/poll`, `/result`, `/exec`) mewajibkan token per-run; tanpa token, halaman web mana pun tidak bisa membaca perintah atau memalsukan hasil.
- Token dicetak di terminal saat bridge menyala, dapat diganti lewat `FIGMA_BRIDGE_TOKEN` (minimal 16 karakter), dan disimpan plugin di `figma.clientStorage`.
- CORS dan header Private-Network-Access hanya dikirim ke origin plugin Figma (opaque/`figma.com`); halaman web lain tidak mendapatkannya. Pembatas utamanya tetap token — `Origin: null` bisa datang dari iframe sandbox mana pun, jadi CORS bukan satu-satunya gerbang.
- `manifest.json` membatasi plugin ke `http://localhost:3939`; tidak ada akses internet.
- Tidak ada token Figma dan tidak ada isi desain yang dikirim ke layanan lain.

## Jika bermasalah

- **“Bridge lokal belum aktif”** — jalankan `node tools/figma-bridge/server.mjs`; pastikan port 3939 tidak dipakai proses lain (`FIGMA_BRIDGE_PORT` bisa mengganti, sesuaikan juga `manifest.json`).
- **Plugin tidak muncul** — import ulang manifest dari menu Development, lalu jalankan dari file yang benar.
- **Tool bilang plugin belum terhubung** — plugin harus terbuka dan jendelanya terlihat; polling berhenti saat plugin ditutup.
- **“Token salah/kedaluwarsa”** — bridge membuat token baru setiap kali menyala (kecuali `FIGMA_BRIDGE_TOKEN` diatur). Salin token terbaru dari terminal bridge ke plugin.
- **Ubah port** — set `FIGMA_BRIDGE_PORT` untuk server dan `allowedDomains` di `plugin/manifest.json`.
