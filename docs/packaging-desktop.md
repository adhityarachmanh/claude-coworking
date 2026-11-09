# Packaging & update aplikasi desktop

Status: **Windows installer + auto-update, Linux tarball/.deb, dan skrip macOS .app.** Build Windows/Linux
dapat dibuat dari Windows; build macOS harus dijalankan di Mac (dan belum ditandatangani). UI tetap web
(localhost), bukan aplikasi Electron.

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
  senyap setelah diverifikasi. Bila `assets/update-pubkey.pem` disertakan saat build, update juga **wajib**
  punya `.sig` Ed25519. Code signing Authenticode belum ada (lihat risiko).
- **Host tunggal**: token API tersedia di `GET /` untuk proses lokal mana pun. Jalankan Adhit Office hanya
  di laptop/akun pribadi; jangan dijadikan layanan bersama multi-user sampai ada isolasi peer (Unix socket
  + `SO_PEERCRED` / named pipe ber-ACL).

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

## Build Linux

Prasyarat: Node >= 20 dan koneksi internet (esbuild/postject via npx). Tidak perlu mesin Linux untuk
membuat paket, tetapi **uji binary di Linux sebelum publish**.

```bash
npm run build:linux
```

Output:

```
dist/linux/AdhitOffice-<versi>-linux-x64.tar.gz   # portable
dist/linux/adhit-office_<versi>_amd64.deb         # Debian/Ubuntu
```

- Tarball: ekstrak, jalankan `./AdhitOffice --background` (atau `jalankan.sh`), buka `http://127.0.0.1:4317`.
- `.deb`: pasang `sudo dpkg -i adhit-office_<versi>_amd64.deb`. Berisi `/opt/adhit-office`,
  `/usr/bin/adhit-office`, desktop entry, ikon, dan systemd user unit.
- Aktifkan layanan: `systemctl --user enable --now adhit-office.service`.
- Data: `~/.local/share/adhit-office/data`; mode portable lewat file `portable`.
- Auto-update build terpasang **belum** tersedia untuk Linux; perbarui dengan `.deb`/tarball baru.

## Build macOS

Prasyarat: macOS + Xcode Command Line Tools. Node SEA memakai runtime lokal, dan rilis publik wajib
**codesign + notarization** (akun Apple Developer).

```bash
npm run build:mac
```

Output: `dist/macos/AdhitOffice-<versi>-macos-<arch>-unsigned.zip` berisi `Adhit Office.app`.

- Build hanya jalan di macOS (`process.platform === 'darwin'`).
- `.app` menjalankan server lalu membuka `http://127.0.0.1:4317`; launcher mengarahkan `OFFICE_APP_DIR`
  ke `Contents/Resources` dan build melakukan **ad-hoc codesign** agar bisa diuji lokal.
- Data: `~/Library/Application Support/AdhitOffice/data`.
- Belum dinotarisasi: Gatekeeper menolak unduhan dari internet; buka dengan klik kanan → **Open** hanya
  untuk build lokal. Untuk rilis:

```bash
codesign --deep --force --options runtime --sign "Developer ID Application: …" "Adhit Office.app"
xcrun notarytool submit … --wait
xcrun stapler staple "Adhit Office.app"
```

- Auto-update macOS belum diimplementasikan (gunakan ZIP baru; Sparkle bisa ditambahkan nanti).

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
4. Unduhan lama dibersihkan saat start; hanya installer yang baru diverifikasi yang disimpan.

Repo default: `adhityarachmanh/claude-coworking`; ubah dengan env `OFFICE_UPDATE_REPO=owner/repo`.
Matikan pengecekan dengan `OFFICE_UPDATE_CHECK=0`.

### Tanda tangan rilis (direkomendasikan sebelum publik)

SHA-256 dari rilis yang sama hanya melindungi dari unduhan rusak/MITM. Untuk melindungi dari repo yang
disusupi, buat kunci Ed25519 dan sertakan kunci publik di build:

```bash
node scripts/update-key.mjs          # private key di .keys/ (JANGAN commit), public key di assets/
npm run build:win                    # update-pubkey.pem ikut ke paket
node scripts/sign-release.mjs dist/installer/AdhitOffice-Setup-0.2.1.exe .keys/update-private-key.pem
```

Saat `update-pubkey.pem` ada di folder aplikasi, updater **menolak** rilis tanpa `.sig` yang valid.
Untuk rilis publik tetap tambahkan Authenticode (Windows) / Developer ID + notarization (macOS).

### Rilis yang harus dibuat

Tag `v0.2.1` (atau lebih baru) dengan aset:

```
AdhitOffice-Setup-0.2.1.exe
AdhitOffice-Setup-0.2.1.exe.sha256   # isi: <64 hex>  nama-file
AdhitOffice-Setup-0.2.1.exe.sig      # wajib bila update-pubkey.pem ikut di build
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

## Catatan platform berikutnya

- **Linux**: AppImage (butuh tooling Linux) dan signing paket; systemd user unit sudah disertakan di `.deb`.
- **macOS**: notarization + Sparkle/auto-update; ikon `.icns` bisa ditambahkan dari `icon-512.png`.
- **Windows**: Authenticode agar SmartScreen tidak memperingatkan; updater bisa memverifikasi tanda tangan
  selain SHA-256.
- **Tray/jendela native** opsional (Electron/Tauri) tanpa mengubah UI web.

## Checklist rilis

- [ ] Versi di `package.json` dinaikkan.
- [ ] `npm test` + `npm run lint` bersih.
- [ ] `npm run build:win` menghasilkan exe + Setup.
- [ ] Uji install, jalankan, health 200, uninstall.
- [ ] Buat tag GitHub + dua aset (installer + sha256).
- [ ] Uji update dari versi sebelumnya.
- [ ] (Sebelum publik) code signing + notarization untuk macOS.
