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

2. **Plugin Figma** (sekali saja):
   - Buka **Figma desktop**, bukan browser.
   - Menu **Plugins → Development → Import plugin from manifest…**
   - Pilih `tools/figma-bridge/plugin/manifest.json`.
   - Buka file desainmu → **Plugins → Development → Adhit Office Bridge**.
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

## Keamanan

- Server hanya mendengarkan `127.0.0.1`; perintah **hanya** masuk lewat MCP (HTTP tidak punya endpoint untuk menambah perintah).
- Plugin berjalan dengan izin akun Figma kamu dan hanya bisa mengakses file yang sedang terbuka.
- `manifest.json` membatasi plugin ke `http://127.0.0.1:3939`; tidak ada akses internet.
- Tidak ada token Figma dan tidak ada isi desain yang dikirim ke layanan lain.

## Jika bermasalah

- **“Bridge lokal belum aktif”** — jalankan `node tools/figma-bridge/server.mjs`; pastikan port 3939 tidak dipakai proses lain (`FIGMA_BRIDGE_PORT` bisa mengganti, sesuaikan juga `manifest.json`).
- **Plugin tidak muncul** — import ulang manifest dari menu Development, lalu jalankan dari file yang benar.
- **Tool bilang plugin belum terhubung** — plugin harus terbuka dan jendelanya terlihat; polling berhenti saat plugin ditutup.
- **Ubah port** — set `FIGMA_BRIDGE_PORT` untuk server dan `allowedDomains` di `plugin/manifest.json`.
