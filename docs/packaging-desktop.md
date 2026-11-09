# Packaging & update aplikasi desktop

Status: **Windows installer + auto-update selesai sebagai fase 1 (belum ditandatangani).** Linux/macOS
menyusul. UI tetap web (localhost), bukan aplikasi Electron.

## Keputusan

- **Node SEA** (single executable) + aset web di folder yang sama. Tidak menambah runtime dependency.
- **UI tetap web**: `http://127.0.0.1:4317`, bisa dipasang sebagai PWA. Tidak ada website publik yang
  mengakses file lokal.
- **Data di luar folder install**:
  - Windows: `%LOCALAPPDATA%\AdhitOffice\data`
  - macOS: `~/Library/Application Support/AdhitOffice/data`
  - Linux: `$XDG_DATA_HOME/adhit-office/data`
  - Mode portable: file bernama `portable` di folder aplikasi (atau `OFFICE_PORTABLE=1`).
- **Installer per-user** (tanpa admin), Start Menu + opsi Desktop/autostart, uninstaller.
- **Update dari GitHub Releases**, wajib **SHA-256** dari aset rilis yang sama; installer dijalankan
  senyap setelah diverifikasi. Code signing belum ada (lihat risiko).

## Build Windows

Prasyarat: Node >= 20, koneksi internet (esbuild/postject via npx), [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```powershell
npm run build:win
```

Output:

```
dist/AdhitOffice/AdhitOffice.exe      # single executable + aset
dist/AdhitOffice/public/
dist/AdhitOffice/ai_logos/
dist/installer/AdhitOffice-Setup-<versi>.exe
```

Catatan:

- `scripts/build-windows.mjs` membundel `server.js` dengan esbuild (CJS), membuat blob Node SEA, menyuntikkan
  dengan postject, lalu menyalin `public/`, `ai_logos/`, dokumen, dan `package.json`.
- `server.js` memakai `OFFICE_APP_DIR` bila ada; di build SEA `import.meta` kosong sehingga folder exe dipakai.
- `scripts/restart.mjs` (mode git) tidak dipakai build terpasang; auto-update memakai installer.
- Inno Setup hanya dipakai saat build. Tanpa ISCC, folder portable tetap dihasilkan.

## Auto-update

Alur (⚙ Sistem → Update aplikasi, atau banner):

1. `DesktopUpdater` mengecek `api.github.com/repos/<repo>/releases/latest` tiap 30 menit.
2. Rilis harus punya aset `AdhitOffice-Setup-<versi>.exe` **dan** `AdhitOffice-Setup-<versi>.exe.sha256`.
3. Saat user menekan **Update sekarang**:
   - unduh installer (maks 300 MB, timeout 10 menit),
   - verifikasi SHA-256; tidak cocok → file dibuang, update dibatalkan,
   - hanya URL `github.com`/`*.githubusercontent.com` yang diterima,
   - jalankan installer `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /TASKS=`,
   - installer menutup server lama dan menjalankan versi baru (`WizardSilent`),
   - update ditolak saat ada giliran berjalan.
4. Unduhan lama dibersihkan saat start; hanya installer versi terbaru yang disimpan.

Repo default: `adhityarachmanh/claude-coworking`; ubah dengan env `OFFICE_UPDATE_REPO=owner/repo`.
Matikan pengecekan dengan `OFFICE_UPDATE_CHECK=0`.

### Rilis yang harus dibuat

Tag `v0.2.1` (atau lebih baru) dengan aset:

```
AdhitOffice-Setup-0.2.1.exe
AdhitOffice-Setup-0.2.1.exe.sha256   # isi: <64 hex>  nama-file
```

Buat SHA-256:

```powershell
Get-FileHash dist\installer\AdhitOffice-Setup-0.2.1.exe -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash.ToLower())  AdhitOffice-Setup-0.2.1.exe" } |
  Set-Content dist\installer\AdhitOffice-Setup-0.2.1.exe.sha256 -Encoding ascii
```

## Keamanan & risiko

- **Belum ditandatangani**: Windows SmartScreen akan memperingatkan. Sebelum rilis publik, tambahkan
  Authenticode dan verifikasi tanda tangan installer (bukan hanya SHA-256).
- SHA-256 dari rilis GitHub melindungi dari unduhan rusak/man-in-the-middle, **bukan** dari repo yang
  disusupi. Tanda tangan kode + kunci rilis terpisah tetap diperlukan.
- Installer berjalan dengan hak user; tidak butuh admin. Data pengguna tidak dihapus saat uninstall.
- Update ditolak saat giliran berjalan; token/secret tidak ikut installer.
- Port default 4317; jika bentrok, jalankan dengan `OFFICE_PORT` lain.

## Linux & macOS (fase berikut)

- **Linux**: AppImage + `.deb`, systemd user service, data di XDG, update mandiri dari AppImage.
- **macOS**: `.app`/`.dmg`, launchd, **notarization** Apple Developer ID.
- Build SEA di tiap OS (Node SEA tidak cross-compile); CI matrix per OS.
- Tray/jendela native opsional (Electron/Tauri) tanpa mengubah UI web.

## Checklist rilis

- [ ] Versi di `package.json` dinaikkan.
- [ ] `npm test` + `npm run lint` bersih.
- [ ] `npm run build:win` menghasilkan exe + Setup.
- [ ] Uji install, jalankan, health 200, uninstall.
- [ ] Buat tag GitHub + dua aset (installer + sha256).
- [ ] Uji update dari versi sebelumnya.
- [ ] (Sebelum publik) code signing + notarization untuk macOS.
