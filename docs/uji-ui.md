# Test UI per area — hanya blok yang tersentuh

Suite UI membuka browser sungguhan, jadi `npm run test:ui` (semua blok) memakan puluhan menit. Untuk pengembangan
harian, jalankan **hanya blok yang tersentuh** dengan `npm run test:ui:area`. Test yang dijalankan sama persis;
tidak ada test yang disalin, diubah, atau dihapus.

```powershell
npm run test:ui:area -- "UI Setelan PIN"      # semua blok yang namanya memuat "UI Setelan PIN"
npm run test:ui:area -- "UI notifikasi"       # satu blok
npm run test:ui:area -- "UI chat live" "CSP"  # beberapa blok
```

Argumen dicocokkan dengan **nama blok `describe`**, bukan nama test di dalamnya. Filter yang tidak cocok dengan blok
mana pun **gagal** dengan pesan yang menyebut filternya: server dan browser sempat dinyalakan (~3–5 dtk), lalu satu
test bernama filter itu gagal. Sebelum penjaga ini ada, filter salah eja membuat run tanpa test sama sekali — dan
pernah menggantung karena server/browser yang dinyalakan untuknya tidak pernah ditutup.

## Cara kerjanya

- `test-support/ui-area.mjs` menjalankan `test/ui.test.mjs` satu kali per argumen, dengan `UI_ONLY` diisi argumen itu
  dan `--test-name-pattern` yang sama, plus batas waktu per child (`UI_AREA_TIMEOUT_MS`, bawaan 30 menit).
- Di suite, `describeArea(...)` (`test-support/ui-area-select.mjs`) **melewati blok** yang namanya tidak memuat
  `UI_ONLY`, jadi server, browser, dan halaman blok itu tidak ikut disiapkan. Kalau tidak ada blok yang cocok,
  `checkUiSelection()` di akhir suite membuat **satu test gagal** bernama filter itu — bukan "tests 0" yang bisa
  terbaca hijau.
- Satu proses per argumen: server, browser, dan halaman dibagi bersama dan satu halaman dipakai ulang per viewport,
  sehingga dua blok asing dalam satu proses **lebih lambat** daripada dijalankan berurutan.
- Tanpa `UI_ONLY` (yaitu `npm run test:ui` dan `npm run test`), semua blok berjalan seperti biasa.
- `startServer()` menyerah setelah 90 detik (`OFFICE_UI_START_TIMEOUT_MS`) dan mencetak stderr server: server yang
  tidak pernah siap membuat run **gagal**, tidak menggantung.

## Blok yang bisa dipilih

Argumen dicocokkan sebagai **substring** nama `describe`, jadi pakai potongan yang unik:

| Argumen | Cakupan |
|---|---|
| `UI mobile 390x844`, `UI desktop 1440x900` | audit utama: beranda, semua modal, kontras, aksesibilitas, laporan, sesi |
| `UI Ringkas konteks` | 🧹 Ringkas konteks |
| `CSP` | laporan cetak di bawah Content-Security-Policy |
| `UI HP lewat WiFi` | HP hanya-lihat lewat WiFi (⚙ tidak bisa dibuka) |
| `UI HP lewat Tailscale` | HP terpasang lewat Tailscale: ⚙ terbuka, kontrol khusus laptop disembunyikan |
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
- Argumen yang tidak cocok dengan blok mana pun dilaporkan **GAGAL** dengan pesan yang menyebut filternya, bukan
  lulus — salah eja nama tidak boleh terlihat hijau. Daftar nama blok yang benar ada di tabel di atas (atau
  `npm run test:related` akan menyarankan blok yang menyentuh file yang kamu ubah).
