# Uji manual CLI bridge (gerbang rilis)

Status: **belum dijalankan.** Skenario 4–6 tetap harus dilihat manusia karena perilaku **TUI** tidak bisa diuji
otomatis: memastikan hook yang gagal/timeout benar-benar menyerahkan keputusan ke **prompt interaktif Claude
Code di terminal**, bukan menolak diam-diam atau auto-allow. Sisi servernya (404 untuk folder di luar project,
`fallback` saat timeout, token sempit) sudah diuji di `test/cli-bridge.test.mjs`.

Perkiraan waktu: **15–20 menit**. Jalankan di laptop (Windows), server Adhit Office menyala, dan Claude Code
sudah login.

## Persiapan

1. Server menyala: `node scripts/restart.mjs` (atau buka aplikasi seperti biasa), lalu jalankan preflight:
   ```powershell
   node scripts/uji-cli-bridge.mjs
   ```
   Semua baris harus ✔. Kalau ada yang ✘, perbaiki dulu (server mati, `claude` tidak ditemukan, versi server lama).
2. Pastikan folder uji terdaftar sebagai project di kantor. Paling mudah: pakai folder repo ini
   (`C:\Users\adhit\projects\claude-coworking`).
3. Terminal baru, masuk ke folder uji:
   ```powershell
   cd C:\Users\adhit\projects\claude-coworking
   ```
4. Jalankan wrapper (bukan `claude` langsung):
   ```powershell
   .\office.cmd claude
   ```
   Kalau `office.cmd` ada di PATH, cukup `office claude`.
5. Catat hasil tiap skenario di tabel bawah. Untuk skenario yang gagal, simpan teks terminal + jam kejadian.

> Jangan memakai `claude` langsung untuk uji ini: tanpa wrapper, hook tidak terpasang dan hasilnya tidak sah.

## Skenario

### 1. Izinkan dari aplikasi (dasar)

Prompt:

```
Buat file uji-bridge.txt berisi "ok" memakai tool Write. Jangan memakai tool lain.
```

Yang harus terjadi:

- [ ] Kartu izin muncul di kantor (dan di HP bila push aktif) dengan penanda **Terminal · CLI bridge**.
- [ ] Isi file terlihat di kartu (bukan kosong), tanpa tombol **Izinkan selalu**.
- [ ] Klik **Izinkan** → file `uji-bridge.txt` dibuat, giliran selesai normal di terminal.
- [ ] Tidak ada aturan izin baru yang tersimpan (buka 🛡️ Aturan izin: tidak ada entri baru).

### 2. Tolak dari aplikasi

Prompt sama, file `uji-bridge.txt` dihapus dulu.

- [ ] Klik **Tolak** (isi alasan: "uji manual").
- [ ] File **tidak** dibuat.
- [ ] Model menerima penolakan dan melanjutkan giliran tanpa langkah itu.
- [ ] Kartu tercatat ditolak; audit `cli-approval` bertambah (⚙ → Data saya → audit).

### 3. Perintah shell & penyamaran rahasia

Prompt:

```
Jalankan perintah PowerShell: echo uji --token rahasia123
```

- [ ] Kartu menampilkan perintah dengan `--token ***` (bukan nilai asli).
- [ ] **Izinkan** menjalankan perintah; output muncul di terminal.

### 4. Hook gagal di tengah giliran → prompt terminal (GERBANG)

1. Mulai prompt yang memakai `Write`.
2. Saat kartu izin muncul di kantor, **matikan server** dari laptop (⚙ → ⏻ Matikan server).
3. Tunggu di terminal.

Yang harus terjadi:

- [ ] Terminal **menampilkan prompt izin interaktif Claude Code** (bukan auto-allow, bukan diam lalu menolak).
- [ ] Jawab **Allow** di terminal → file dibuat.
- [ ] Kartu di aplikasi hilang/tertutup (tidak menggantung).
- [ ] Nyalakan server lagi setelah uji.

### 5. Timeout tanpa jawaban → prompt terminal (GERBANG)

1. Mulai prompt yang memakai `Write`.
2. **Jangan jawab** kartu izin. Tunggu ±2 menit (server menjawab `fallback` di 115 dtk, hook berhenti di 118 dtk).
3. Perhatikan terminal.

Yang harus terjadi:

- [ ] Setelah ±2 menit, prompt izin interaktif muncul di terminal.
- [ ] Kartu di aplikasi berubah dari *menunggu* menjadi tertutup/fallback, tidak menggantung.
- [ ] Jawab **Deny** di terminal → file tidak dibuat.

### 6. Folder di luar project (GERBANG)

1. Buat folder sementara di luar project, mis. `C:\Users\adhit\AppData\Local\Temp\luar-project`.
2. Dari folder itu jalankan `C:\Users\adhit\projects\claude-coworking\office.cmd claude`.
3. Minta Claude menulis file di folder itu.

Yang harus terjadi:

- [ ] **Tidak ada kartu** di kantor (hook menerima 404 "bukan project").
- [ ] Prompt izin normal Claude Code muncul di terminal dan bisa dijawab di sana.

### 7. Perintah terlalu panjang

Prompt: minta Claude menjalankan perintah PowerShell yang panjangnya > 800 karakter (mis. `Write-Output` dengan
string panjang berulang).

- [ ] **Tidak ada kartu**; terminal menampilkan prompt izin sendiri (tidak ada izin buta dari preview terpotong).

### 8. Subagent & MCP (opsional, kalau tersedia)

- [ ] Minta Claude mendelegasikan tugas `Write` ke subagent → kartu tetap muncul, penanda asal tetap jelas.
- [ ] Kalau ada server MCP, minta satu tool MCP → kartu muncul untuk `mcp__*`.

## Hasil

| # | Skenario | Hasil (Lulus/Gagal) | Catatan |
|---|---|---|---|
| 1 | Izinkan dari aplikasi | | |
| 2 | Tolak dari aplikasi | | |
| 3 | Shell & redaksi rahasia | | |
| 4 | Server mati → prompt terminal | | |
| 5 | Timeout → prompt terminal | | |
| 6 | Folder luar project | | |
| 7 | Perintah terlalu panjang | | |
| 8 | Subagent/MCP (opsional) | | |

Tanggal:
Versi Claude Code (`claude --version`):
Versi Adhit Office (`package.json`):

## Setelah semua lulus

1. Konfirmasi **security review** masih berlaku: di `docs/design-cli-bridge.md` langkah 3 sudah ✅, tetapi kalau
   ada perubahan kode bridge sejak review itu, minta Security meninjau ulang sebelum status berubah.
2. Ubah status di `docs/design-cli-bridge.md` menjadi **dirilis (opt-in)** dan centang langkah 2 di rencana.
3. Tambahkan tombol/status **CLI bridge** di ⚙ → Sistem (belum ada di UI).
4. Perbarui README/FITUR/PANDUAN: hapus label "belum dirilis".
5. Catat di CHANGELOG bagian **Belum dirilis**.

Kalau ada yang gagal: **jangan** rilis fitur ini; catat skenario yang gagal di issue/CHANGELOG dan biarkan
status tetap eksperimental.
