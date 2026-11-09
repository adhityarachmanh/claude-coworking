# Packaging & update aplikasi desktop

Status: **Windows installer dengan mode Website/Desktop (Electron) + auto-update bertanda tangan, Linux
tarball/.deb, dan skrip macOS .app.** Build Windows/Linux dapat dibuat dari Windows; build macOS lewat
GitHub Actions atau Mac. UI tetap web lokal; mode Desktop hanya shell Electron.

## Keputusan

- **Node SEA** (single executable) + aset web di folder yang sama.
- **UI tetap web**: `http://127.0.0.1:4317`, bisa PWA. Mode Desktop memakai **Electron** yang menyambung ke
  server yang sama—bukan server kedua, bukan Chromium terpisah untuk website.
- **Satu versi**: installer memperbarui server + Electron bersama; tidak ada dua jalur update.
- **Data di luar folder install** (nama folder **sengaja tidak berubah** saat rebrand ke Adhitron, supaya riwayat
  yang sudah ada tidak hilang; env `OFFICE_*` juga tetap):
  - Windows: `%LOCALAPPDATA%\AdhitOffice\data`
  - macOS: `~/Library/Application Support/AdhitOffice/data`
  - Linux: `$XDG_DATA_HOME/adhit-office/data`
  - Mode portable: file bernama `portable` di folder aplikasi (atau `OFFICE_PORTABLE=1`).
- **Installer per-user** (tanpa admin), tiga mode: **Website / Desktop / All**, Start Menu + opsi autostart,
  uninstaller.
- **Update dari GitHub Releases**, wajib **SHA-256** dan **Ed25519** (public key ikut build); installer
  dijalankan senyap setelah diverifikasi. Code signing Authenticode belum ada (lihat risiko).
- **Host tunggal**: token API tersedia di `GET /` untuk proses lokal mana pun. Jalankan Adhitron hanya
  di laptop/akun pribadi; jangan dijadikan layanan bersama multi-user sampai ada isolasi peer (Unix socket
  + `SO_PEERCRED` / named pipe ber-ACL).

## Build Windows

Prasyarat: Node >= 20, `npm install` (Electron/electron-builder), koneksi internet (esbuild/postject via npx),
[Inno Setup 6](https://jrsoftware.org/isinfo.php).

```powershell
npm install        # sekali
npm run build:win
```

Output:

```
dist/Adhitron/Adhitron.exe            # server SEA + aset
dist/electron/win-unpacked/           # Electron shell
dist/installer/Adhitron-Setup-<versi>.exe
```

Installer memasang ke `{localappdata}\Programs\Adhitron` (per-user, tanpa admin).

Installer menanyakan mode:

- **Website**: shortcut server/browser + PWA.
- **Desktop**: shortcut `AdhitronDesktop.exe` (Electron).
- **All**: keduanya.

Electron menjalankan/menyambung ke `127.0.0.1:4317`, single instance, tray, dan menutup jendela berarti
minimize ke tray. `nodeIntegration` mati, `contextIsolation`/`sandbox` aktif, hanya navigasi localhost.
Updater menutup kedua proses sebelum mengganti file.

Catatan:

- `scripts/build-windows.mjs` membundel `server.js` dengan esbuild (CJS), membuat blob Node SEA, menyuntikkan
  dengan postject, lalu menyalin `public/`, `ai_logos/`, dokumen, dan `package.json`. Installer memakai
  `installer/Adhitron.iss` (AppId lama dipertahankan supaya upgrade dari Adhit Office berjalan sebagai upgrade).
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
dist/linux/Adhitron-<versi>-linux-x64.tar.gz   # portable
dist/linux/adhitron_<versi>_amd64.deb          # Debian/Ubuntu
```

- Tarball: ekstrak, jalankan `./Adhitron --background` (atau `jalankan.sh`), buka `http://127.0.0.1:4317`.
- `.deb`: pasang `sudo dpkg -i adhitron_<versi>_amd64.deb`. Berisi `/opt/adhitron`, `/usr/bin/adhitron`,
  `adhitron.desktop` + ikon `adhitron.png`, dan systemd user unit `adhitron.service`.
- Aktifkan layanan: `systemctl --user enable --now adhitron.service`.
- Data: `~/.local/share/adhit-office/data` (nama folder lama, tidak berubah); mode portable lewat file `portable`.
- Auto-update build terpasang **belum** tersedia untuk Linux; perbarui dengan `.deb`/tarball baru.
- Paket `.deb` berganti nama (`adhit-office` → `adhitron`). Bila versi lama terpasang, lepaskan dulu:
  `sudo dpkg -r adhit-office` (data di `~/.local/share/adhit-office` tidak disentuh), lalu pasang paket baru.

## Build macOS

Tidak perlu Mac sendiri: workflow **`.github/workflows/build-macos.yml`** membangun `.app` di runner
GitHub macOS (arm64 + Intel) dan mengunggah ZIP ke Release saat push tag `v*`. Bisa juga dijalankan manual
dari tab **Actions → build-macos → Run workflow** (hasilnya sebagai artifact).

Build lokal (kalau punya Mac):

```bash
npm run build:mac
```

Output: `dist/macos/Adhitron-<versi>-macos-<arch>-unsigned.zip` berisi `Adhitron.app`.

- Build hanya jalan di macOS (`process.platform === 'darwin'`).
- `.app` menjalankan server lalu membuka `http://127.0.0.1:4317`; launcher mengarahkan `OFFICE_APP_DIR`
  ke `Contents/Resources` dan build melakukan **ad-hoc codesign** agar bisa diuji lokal.
- Data: `~/Library/Application Support/AdhitOffice/data` (nama folder lama, tidak berubah).
- Belum dinotarisasi: macOS bisa menolak build unduhan. Pengguna membuka lewat **System Settings →
  Privacy & Security → Open Anyway**, atau:
  `xattr -dr com.apple.quarantine "Adhitron.app"`.
- Rilis publik yang mulus tetap butuh **Developer ID + notarization** (akun Apple Developer); tambahkan
  secret ke workflow setelah itu.

Untuk notarization di Mac:

```bash
codesign --deep --force --options runtime --sign "Developer ID Application: …" "Adhitron.app"
xcrun notarytool submit … --wait
xcrun stapler staple "Adhitron.app"
```

- Auto-update macOS belum diimplementasikan (gunakan ZIP baru; Sparkle bisa ditambahkan nanti).

## Auto-update

Alur (⚙ Sistem → Update aplikasi, atau banner):

1. `DesktopUpdater` mengecek `api.github.com/repos/<repo>/releases/latest` tiap 30 menit.
2. Rilis harus punya aset `Adhitron-Setup-<versi>.exe` **dan** `Adhitron-Setup-<versi>.exe.sha256`
   (updater juga masih menerima nama lama `AdhitOffice-Setup-<versi>.exe` — lihat *Alias nama lama* di bawah).
3. Saat user menekan **Update sekarang**:
   - unduh installer (maks 300 MB, timeout 10 menit),
   - verifikasi SHA-256; tidak cocok → file dibuang, update dibatalkan,
   - hanya URL `github.com`/`*.githubusercontent.com` yang diterima,
   - jalankan installer `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /TASKS=`,
   - installer menutup server lama (termasuk `AdhitOffice.exe` versi 1.0.9) dan menjalankan versi baru
     (`WizardSilent`),
   - update ditolak saat ada giliran berjalan.
4. Unduhan lama dibersihkan saat start; hanya installer yang baru diverifikasi yang disimpan
   (`Adhitron-Setup-<versi>.exe` di `data/updates`). File bernama lama ikut dibersihkan.

Repo default: `adhityarachmanh/claude-coworking`; ubah dengan env `OFFICE_UPDATE_REPO=owner/repo`.
Matikan pengecekan dengan `OFFICE_UPDATE_CHECK=0`.

### Alias nama lama (satu rilis transisi)

Aplikasi berganti nama dari **Adhit Office** ke **Adhitron**, tetapi build terpasang 1.0.9 hanya mencari aset
`AdhitOffice-Setup-<versi>.exe` — nama baru saja akan membuat update otomatis 1.0.9 → 1.0.10 gagal
("Rilis terbaru tidak menyertakan installer + SHA-256").

Karena itu rilis transisi (**1.0.10**) mengunggah installer yang **sama persis** di bawah dua nama:

```
Adhitron-Setup-1.0.10.exe            + .sha256 + .sig   # nama baru (dipakai 1.0.10+)
AdhitOffice-Setup-1.0.10.exe         + .sha256 + .sig   # alias byte-identik, hanya untuk 1.0.9
```

- `scripts/sign-release.mjs` dijalankan untuk keduanya, jadi tiap nama punya `.sha256` dan `.sig` sendiri;
  hash dan tanda tangannya identik karena byte-nya sama, hanya nama file di dalam `.sha256` yang berbeda.
  Penanda `.sha256`/`.sig` harus bernama sama dengan asetnya.
- Workflow `.github/workflows/release.yml` menyalin installer baru ke nama lama sebelum menandatangani, lalu
  memeriksa **kedua** kelompok aset saat publish.
- `src/desktop-update.js` menerima kedua nama (nama baru dicek lebih dulu), dan pembersihan unduhan lama
  mengenali keduanya.
- Alias ini **boleh dihapus mulai 1.0.11**: cukup hapus `Copy-Item`/cek aset lama di workflow dan entri
  `AdhitOffice` di `INSTALLER_BASE_NAMES` pada `src/desktop-update.js`.
- Catatan upgrade: 1.0.9 → 1.0.10 memakai **AppId yang sama**, jadi Inno memperlakukannya sebagai update (bukan
  dua instalasi). `UsePreviousAppDir` tetap default `yes`, sehingga mesin yang sudah punya 1.0.9 tetap memakai
  folder lamanya (`Programs\AdhitOffice`) dan file di dalamnya diganti dengan `Adhitron.exe`; instalasi baru
  memakai `Programs\Adhitron`. `UsePreviousGroup=no` + `[InstallDelete]` memindahkan Start Menu ke grup
  **Adhitron** dan menghapus shortcut/grup **Adhit Office** yang lama, jadi tidak ada dua entri autostart yang
  berebut port 4317. Data di `%LOCALAPPDATA%\AdhitOffice\data` tidak ikut terhapus. Installer juga menghentikan
  proses `AdhitOffice.exe`/`AdhitOfficeDesktop.exe` yang masih berjalan.

### Tanda tangan rilis (direkomendasikan sebelum publik)

SHA-256 dari rilis yang sama hanya melindungi dari unduhan rusak/MITM. Untuk melindungi dari repo yang
disusupi, buat kunci Ed25519 dan sertakan kunci publik di build:

```bash
node scripts/update-key.mjs          # private key di .keys/ (JANGAN commit), public key di assets/
npm run build:win                    # update-pubkey.pem ikut ke paket
node scripts/sign-release.mjs dist/installer/Adhitron-Setup-0.2.1.exe .keys/update-private-key.pem
```

Saat `update-pubkey.pem` ada di folder aplikasi, updater **menolak** rilis tanpa `.sig` yang valid.
Untuk rilis publik tetap tambahkan Authenticode (Windows) / Developer ID + notarization (macOS).

### Rilis yang harus dibuat

Tag `v0.2.1` (atau lebih baru) dengan aset:

```
Adhitron-Setup-0.2.1.exe
Adhitron-Setup-0.2.1.exe.sha256   # isi: <64 hex>  nama-file
Adhitron-Setup-0.2.1.exe.sig      # wajib bila update-pubkey.pem ikut di build
```

Untuk rilis transisi, workflow `release.yml` otomatis menyalin dan menandatangani `AdhitOffice-Setup-<versi>.exe` beserta `.sha256`/`.sig` (lihat *Alias nama lama*); tidak perlu menambahkannya manual.

Buat SHA-256:

```powershell
Get-FileHash dist\installer\Adhitron-Setup-0.2.1.exe -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash.ToLower())  Adhitron-Setup-0.2.1.exe" } |
  Set-Content dist\installer\Adhitron-Setup-0.2.1.exe.sha256 -Encoding ascii
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
- **Tray/jendela native** sudah tersedia lewat Electron (Windows); Linux/macOS Electron menyusul.
- **Authenticode/notarization** tetap langkah berikutnya; Ed25519 hanya untuk integritas update.

## Rilis otomatis (GitHub Actions)

- `.github/workflows/release.yml` — tag `v*`: build Windows (server + Electron + installer) dan Linux,
  tanda tangani semua aset dengan secret `UPDATE_SIGNING_KEY`, upload ke GitHub Release.
- `.github/workflows/build-macos.yml` — build macOS arm64 + Intel, tanda tangani ZIP, lampirkan ke Release.
- Secret `UPDATE_SIGNING_KEY` = isi `update-private-key.pem`. Public key sudah di `assets/update-pubkey.pem`
  dan ikut build, sehingga rilis tanpa `.sig` **ditolak** oleh updater.
- Alur rilis: naikkan `version`, commit, buat tag `v<versi>`, push tag. Tidak perlu build manual.
- Draft/prerelease tidak dianggap `latest`.

## Checklist rilis

- [ ] Versi di `package.json` dinaikkan.
- [ ] `npm test` + `npm run lint` bersih.
- [ ] `npm run build:win` menghasilkan server + Electron + Setup.
- [ ] Uji instalasi mode Website, Desktop, dan All; tray dan single instance.
- [ ] Uji update dari versi sebelumnya; `.sig` salah/hilang ditolak.
- [ ] Push tag `v<versi>` (Actions membangun + menandatangani + mengunggah).
- [ ] (Sebelum publik) Authenticode/notarization untuk macOS.
