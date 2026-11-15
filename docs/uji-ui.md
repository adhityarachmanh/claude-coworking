# Test UI per area — hanya blok yang tersentuh

Suite UI membuka browser sungguhan, jadi `npm run test:ui` (semua blok) memakan puluhan menit. Untuk pengembangan
harian, jalankan **hanya blok yang tersentuh** dengan `npm run test:ui:area`. Test yang dijalankan sama persis;
tidak ada test yang disalin, diubah, atau dihapus.

```powershell
npm run test:ui:area -- "settings: WhatsApp card"     # satu test
npm run test:ui:area -- settings                      # semua blok yang namanya memuat "settings"
npm run test:ui:area -- settings compact              # beberapa blok
```

## Cara kerjanya

- `test-support/ui-area.mjs` menjalankan `test/ui.test.mjs` satu kali per argumen, dengan `UI_ONLY` diisi argumen itu
  dan `--test-name-pattern` yang sama (untuk argumen yang tidak cocok dengan test mana pun, node melaporkan
  `tests 0`).
- Di suite, `describeArea(...)` (`test-support/ui-area-select.mjs`) **melewati blok** yang namanya tidak memuat
  `UI_ONLY`, jadi server, browser, dan halaman blok itu tidak ikut disiapkan.
- Satu proses per argumen: server, browser, dan halaman dibagi bersama dan satu halaman dipakai ulang per viewport,
  sehingga dua blok asing dalam satu proses **lebih lambat** daripada dijalankan berurutan.
- Tanpa `UI_ONLY` (yaitu `npm run test:ui` dan `npm run test`), semua blok berjalan seperti biasa.

## Blok yang bisa dipilih

Argumen dicocokkan sebagai **substring** nama `describe`, jadi pakai potongan yang unik:

| Argumen | Cakupan |
|---|---|
| `UI mobile 390x844`, `UI desktop 1440x900` | audit utama: beranda, semua modal, kontras, aksesibilitas, laporan, sesi |
| `UI Ringkas konteks` | 🧹 Ringkas konteks |
| `CSP` | laporan cetak di bawah Content-Security-Policy |
| `UI HP lewat WiFi` | HP hanya-lihat lewat WiFi |
| `UI chat live` | gelembung chat yang tetap terisi |
| `UI koneksi putus` | server berhenti lalu kembali (**paling lambat**: me-restart server) |
| `UI palet perintah` | Ctrl+P, 🔎 cari percakapan, ⬇ ekspor .md |
| `UI notifikasi` | 🔔 notifikasi + 🎤 input suara |
| `UI perintah tier` | `/hemat…/maks`, `:mode 🎯` |
| `Semua project` | 🗂 semua project sekaligus |
| `Setelan PIN` | 📱 PIN ke HP (WhatsApp) + 🔐 Akses saat PC terkunci |

## Kapan memakai yang mana

- Selama mengembangkan satu fitur: `test:ui:area` untuk bloknya, ditambah `npm run test:fast`.
- Mengubah `public/index.html`, `public/css/`, `public/js/core/`, atau `server.js`: blok audit utama ikut jalankan.
- Sebelum rilis / PR besar: `npm run test:ui` (semua blok).
- Argumen yang tidak cocok dengan blok mana pun dilaporkan **GAGAL "tanpa test"**, bukan lulus — salah eja nama tidak
  boleh terlihat hijau.
