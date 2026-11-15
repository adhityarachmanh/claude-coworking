# WhatsApp di dalam aplikasi + autologon lewat GUI — Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Setiap langkah memakai checkbox (`- [ ]`).

**Goal:** Pengguna bisa menautkan WhatsApp dengan memindai QR di dalam aplikasi (tanpa Docker, tanpa terminal, satu server), dan menyalakan mode "server hidup sebelum login Windows" lewat satu tombol + satu UAC.

**Architecture:** WhatsApp Web dijalankan **di dalam** proses server Adhitron lewat `@whiskeysockets/baileys`; kunci sesi disimpan terenkripsi AES-256-GCM di `data/wa/`. Gateway WAHA, empat environment variable, dan seluruh langkah terminal dihapus. Autologon dikerjakan satu helper PowerShell elevated yang dipanggil lewat CLI aplikasi yang sama (`Adhitron.exe --autologon-enable`), dipakai oleh modal Setelan **dan** halaman installer.

**Tech Stack:** Node 20+, esbuild → Node SEA (satu exe), Inno Setup 6, `@whiskeysockets/baileys@7`, `qrcode`.

**Spec:** percakapan dengan pemilik produk, 15 Nov 2026 (disetujui: WhatsApp in-process via scan QR; autologon via GUI + installer; tanpa Telegram; tanpa commit/push/rilis).

## Global Constraints

- **Jangan commit, jangan push, jangan rilis.** Semua perubahan tetap di working tree. Versi tetap `1.0.33`.
- **Tidak ada langkah terminal untuk pengguna akhir.** Tidak ada `setx`, `docker`, atau "jalankan .cmd sebagai Administrator".
- WhatsApp hanya bisa ditautkan/dilepas dari **laptop** (`LOCAL_ONLY`), tidak pernah dari HP yang sudah dipasangkan.
- Sandi Windows: **tidak pernah** disimpan aplikasi, tidak masuk log, tidak masuk `state.json`, tidak dikirim ke klien lain. Hanya lewat file sementara per-user yang dihapus helper segera setelah dibaca.
- Kunci sesi WhatsApp disimpan terenkripsi; tidak pernah dikirim ke klien mana pun.
- UI berbahasa Indonesia, konsisten dengan copy yang sudah ada.
- Gate verifikasi: `npm run test:fast` (0 gagal), `npm run test:smoke` (0 gagal), `node --test bridge/netlify.test.mjs` (tidak boleh turun), ESLint exit 0.
- Spike yang sudah lulus: bundle esbuild 7,5 MB → blob SEA → `wa-spike.exe` 103 MB mengeluarkan QR (`QR_OK len=277`). Jangan ulangi spike; bangun di atasnya.

## Review Focus

1. **QR bocor ke perangkat lain** — QR = kredensial sesi. `/api/wa/*` wajib 403 dari HP/Tailscale, termasuk lewat websocket broadcast.
2. **UAC dibatalkan** — tidak ada perubahan registry sama sekali, UI bilang "dibatalkan", bukan error mentah.
3. **Sandi Windows salah** — helper memvalidasi dengan `LogonUser` **sebelum** menulis registry; kalau salah, registry tidak berubah (kalau tidak, PC gagal boot dan tidak ada yang bisa login).
4. **Autologon menyala tanpa pengunci layar** — status `unsafeDesktop` yang sudah ada harus tetap muncul dan bisa dimatikan dari GUI.
5. **Sesi WhatsApp dicabut dari HP** — status berubah `disconnected`, permintaan PIN menjawab 503, halaman `/pair` jatuh ke kode layar laptop (tidak menggantung).
6. **Installer silent (updater)** — tidak boleh memunculkan UAC atau halaman sandi.

---

### Task 1: Penyimpanan sesi WhatsApp terenkripsi

**Files:**
- Create: `src/wa-auth-store.js`
- Test: `test/wa-auth-store.test.mjs`

**Interfaces:**
- Consumes: tidak ada.
- Produces:
  - `export class EncryptedAuthStore { constructor({ dir, readFile = readFileSync, writeFile = writeFileSync, rm = (p) => rmSync(p, { recursive: true, force: true }), randomBytes = crypto.randomBytes }) }`
  - `async load(): Promise<{ state: { creds, keys }, saveCreds: () => Promise<void> }>` — `creds`/`keys` memakai serialisasi `BufferJSON` dari baileys; state kosong dimulai dari `initAuthCreds()`.
  - `async wipe(): Promise<void>` — hapus seluruh folder sesi (dipakai `unlink`).
  - `get dir()`.
- Enkripsi: `AES-256-GCM`, kunci 32 byte acak di `data/wa/key` (mode `0o600`), file sesi `data/wa/session.bin` = `iv(12) | tag(16) | ciphertext`. Tidak ada plaintext di disk.

- [ ] **Step 1: Tulis test yang gagal** — `test/wa-auth-store.test.mjs`:
  `test('saves the session encrypted: no plaintext on disk', ...)` — set satu kredensial unik (`me.id = '628111@s.whatsapp.net'`), panggil `saveCreds`, baca byte file dengan `readFileSync`, `assert.ok(!raw.includes('628111'))`; lalu `load()` di store baru dan `assert.equal(creds.me.id, '628111@s.whatsapp.net')`.
  `test('wipe removes every file', ...)` — setelah `wipe()`, `existsSync(dir)` false.
  `test('a tampered file is refused, not silently reset', ...)` — balik satu byte ciphertext, `load()` menolak dengan pesan Indonesia (jangan menimpa sesi yang masih bisa diperbaiki).
- [ ] **Step 2: Jalankan, pastikan gagal** — `node --test test/wa-auth-store.test.mjs` → FAIL `Cannot find module`.
- [ ] **Step 3: Implementasi** `src/wa-auth-store.js` (kelas di atas; `saveCreds` menulis atomik: file `.tmp` lalu `renameSync`).
- [ ] **Step 4: Jalankan, pastikan lulus** — `node --test test/wa-auth-store.test.mjs` → PASS 3/3.

### Task 2: `WhatsAppLink` — satu soket, QR, kirim, lepas

**Files:**
- Create: `src/wa-link.js`
- Test: `test/wa-link.test.mjs`

**Interfaces:**
- Consumes: `EncryptedAuthStore` (Task 1).
- Produces:
  - `export class WaLink { constructor({ store, socketFactory = makeWASocket, qrToDataUrl, now = Date.now, onChange = () => {} }) }`
  - `async status(): Promise<{ state: 'off'|'qr'|'connecting'|'linked', qr: string|null, me: { number: string, name: string }|null }>` — `state` `'qr'` hanya berisi QR terbaru (data URL PNG); QR kedaluwarsa 60 dtk → `qr: null` tapi `state` tetap `'qr'` (soket masih memutar QR baru).
  - `async link(): Promise<status>` — idempoten: kalau soket sudah ada, kembalikan status yang ada (jangan buka dua soket).
  - `async unlink(): Promise<void>` — `logout()` bila memungkinkan, tutup soket, `store.wipe()`.
  - `async sendText(text: string): Promise<{ ok: true }>` — kirim ke nomor sendiri (`creds.me.id`). Melempar `WaLinkError` dengan `code: 'not_linked'` bila belum tertaut.
  - `stop(): void` — tutup soket (dipakai saat server shutdown).
  - `export class WaLinkError extends Error { code: 'not_linked'|'send_failed' }`
- Pemetaan status ke kontrak halaman `/pair` yang **sudah ada** (jangan ubah `public/js/pair.js`): `linked → { configured: true, status: 'connected' }`, `qr/connecting → { configured: true, status: 'qr_ready'|'connecting' }`, `off → { configured: false, status: 'disconnected' }`.
- `onChange` dipanggil setiap kali status berubah (QR baru, tersambung, terputus) — server memakainya untuk `hub.broadcast('wa', status)`.
- Reconnect: `connection === 'close'` dengan alasan bukan `loggedOut` → coba lagi (maks 5x, jeda naik), lalu `state: 'off'` dengan pesan terakhir disimpan di `lastError` (string aman, tanpa kredensial).

- [ ] **Step 1: Tulis test dengan soket palsu** — `test/wa-link.test.mjs`:
  `test('link() emits a QR and reports qr_ready', ...)`, `test('a second link() does not open a second socket', ...)`, `test('sendText goes to the linked account itself', ...)` (assert `sock.sendMessage` dipanggil dengan `'628111@s.whatsapp.net'`), `test('sendText before linking throws not_linked', ...)`, `test('a closed socket reconnects, loggedOut goes off', ...)`, `test('unlink() wipes the store and stops the socket', ...)`.
- [ ] **Step 2: Jalankan, pastikan gagal** — `node --test test/wa-link.test.mjs` → FAIL.
- [ ] **Step 3: Implementasi** `src/wa-link.js` (event `connection.update` → status; `qrToDataUrl` default `QRCode.toDataURL(qr, { margin: 1, width: 240 })`; logger baileys di-silence).
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS 6/6.

### Task 3: Rute `/api/wa/*` (laptop saja) + broadcast

**Files:**
- Create: `src/routes/wa.js`
- Modify: `server.js` (registrasi router, instansiasi `WaLink`, tambahkan 4 path ke `LOCAL_ONLY`, `waLink.stop()` saat shutdown)
- Test: `test/wa-api.test.mjs`

**Interfaces:**
- Consumes: `WaLink` (Task 2), `json`/`readJson` dari `src/routes/http.js`.
- Produces:
  - `GET /api/wa/status` → `{ state, qr, me }`
  - `POST /api/wa/link` → status yang sama (200)
  - `POST /api/wa/unlink` → `{ ok: true }`
  - `POST /api/wa/test` → `{ ok: true }`, atau 409 `{ error: 'WhatsApp belum ditautkan.' }`
  - event websocket `wa` membawa `{ state, qr, me }` (bentuk sama dengan `GET`).
- QR **tidak** masuk ke payload `config` yang dikirim ke HP (jangan tambahkan ke `publishConfig`).

- [ ] **Step 1: Tulis test** — `test/wa-api.test.mjs` (pola `test/access-pin-api.test.mjs`: server sungguhan + `OFFICE_WA_FAKE=1` yang memasang soket palsu):
  `test('status starts off', ...)`, `test('link returns a QR and status polling sees it', ...)`, `test('test 409 when not linked, 200 after link', ...)`, `test('over plain WiFi the routes are refused', ...)` (gunakan helper `wifi` yang sudah ada di test e2e lain → 403).
- [ ] **Step 2: Jalankan, pastikan gagal**.
- [ ] **Step 3: Implementasi** `src/routes/wa.js` + sambungkan di `server.js`.
- [ ] **Step 4: Jalankan, pastikan lulus**.

### Task 4: PIN lewat `WaLink`, WAHA dihapus

**Files:**
- Modify: `server.js` (baris 35–36, 271–275, 985–988), `src/access-pin.js` (komentar header saja)
- Delete: `src/wa-service.js`, `test/wa-service.test.mjs`
- Test: `test/access-pin-api.test.mjs` (sesuaikan), `test/access-pin.test.mjs` (tetap)

**Interfaces:**
- Consumes: `WaLink.status()`, `WaLink.sendText()`, `pinMessage` (pindahkan `pinMessage` ke `src/access-pin.js` bila `wa-service.js` dihapus — jangan duplikasi).
- Produces: `accessPin = new AccessPin({ send: (pin) => waLink.sendText(pinMessage(pin)), ... })`; `pin-status` membaca `waLink.status()` dan memetakan dengan aturan Task 2.

- [ ] **Step 1: Sesuaikan test** — `test/access-pin-api.test.mjs` memakai `OFFICE_WA_FAKE=1` (bukan server WAHA palsu): PIN dikirim ke nomor tertaut; `pin-status` menjawab `configured: false` saat belum tertaut; permintaan PIN menjawab 503 dengan pesan "WhatsApp belum ditautkan."
- [ ] **Step 2: Jalankan, pastikan gagal**.
- [ ] **Step 3: Implementasi** — hapus `src/wa-service.js` + testnya, pindahkan `pinMessage`, ganti transport, hapus baca `WAHA_URL`/`WA_TARGET_NUMBER`/`WAHA_SESSION`/`WAHA_API_KEY` di seluruh repo (`grep -r WAHA` harus kosong kecuali CHANGELOG lama).
- [ ] **Step 4: Jalankan** `node --test test/access-pin-api.test.mjs test/access-pin.test.mjs` → PASS.
- [ ] **Step 5: Cek tidak ada sisa** — `grep -rn "WAHA_URL\|WA_TARGET_NUMBER\|wa-service" src server.js public test` → kosong (kecuali CHANGELOG bagian rilis lama).

### Task 5: Setelan → 📱 PIN ke HP (UI)

**Files:**
- Modify: `public/index.html` (ganti blok WhatsApp/legacy di dalam modal Setelan), `public/js/features/settings.js`, `public/js/api.js` bila perlu
- Test: `test/ui.test.mjs` (tambahkan test bernama `settings: WhatsApp card` mengikuti pola test `pair.html` yang ada)

**Interfaces:**
- Consumes: `GET /api/wa/status`, `POST /api/wa/link|unlink|test`, event websocket `wa`.
- Produces: elemen `#wa-state`, `#wa-qr`, `#wa-me`, `#btn-wa-link`, `#btn-wa-unlink`, `#btn-wa-test`.

- [ ] **Step 1: Tulis test UI** — dua viewport (pola test yang sudah ada): kartu menampilkan "Belum ditautkan" + tombol Tautkan; setelah `/api/wa/link` dipanggil (route di-stub) gambar QR muncul dan tombol berubah jadi "Batal"; state `linked` menampilkan nomor + tombol Tes/Lepas dan menyembunyikan QR. Assert juga: teks `WAHA`, `setx`, `.cmd`, `docker` **tidak ada** di halaman Setelan.
- [ ] **Step 2: Jalankan, pastikan gagal**.
- [ ] **Step 3: Implementasi** markah + JS (polling 2 dtk selama modal terbuka, berhenti saat tertutup/tertaut).
- [ ] **Step 4: Jalankan, pastikan lulus**.

### Task 6: Autologon — helper elevated + CLI

**Files:**
- Create: `src/autologon.js`
- Modify: `server.js` (tangani `--autologon-enable` / `--autologon-disable` **sebelum** server start, seperti `--background` di baris 155)
- Test: `test/autologon.test.mjs`

**Interfaces:**
- Consumes: `startupDir` dari `src/autostart.js` (ekspor helper baru `startupDirOf(options)`), `lockLauncherScript`.
- Produces:
  - `export function winlogonScript(): string` — isi PowerShell tetap (tanpa sandi di dalamnya), argumen: `-PasswordFile`, `-User`, `-Domain`, `-Startup`.
  - `export function windowsAccount(user = process.env.USERNAME, upn = '') : { user, domain }` — bila akun Microsoft (`upn` mengandung `@`) → `{ user: upn, domain: 'MicrosoftAccount' }`; selain itu `{ user, domain: os.hostname() }`.
  - `export async function enableAutologon({ password, appDir, port, exec = execFileSync, spawn = childProcess.spawn }): Promise<{ ok: true, verified: true } | never>` — menulis `password` ke `%TEMP%\adhitron-autologon-<rand>.txt` (mode `0o600`), menjalankan `Start-Process ... -Verb RunAs -Wait` ke `--autologon-enable`, membaca kode keluar, menghapus file di `finally`, lalu `autostartStatus()` untuk memastikan `autologon === 'on'`.
  - Kode keluar helper: `0` sukses, `3` sandi salah, `4` tidak bisa menulis registry, `5` bukan Administrator, `6` UAC dibatalkan (1223).
  - `export function helperMain(argv): Promise<number>` — dipanggil dari `server.js`.
- Aturan: sandi divalidasi dengan `LogonUser` **sebelum** menulis; `DefaultPassword` ditulis terakhir; helper menghapus file sandi lebih dulu.

- [ ] **Step 1: Tulis test** (exec/spawn disuntik, tidak ada UAC sungguhan):
  `test('the elevated script never contains the password', ...)` (assert `!script.includes(password)`), `test('a wrong password exits 3 and leaves the registry untouched', ...)`, `test('Microsoft account uses the MicrosoftAccount domain', ...)`, `test('enable writes the password file with 0600 and removes it in finally', ...)`, `test('UAC cancel (1223) is reported as cancelled, not as an error', ...)`, `test('after enabling, status must read autologon on', ...)`.
- [ ] **Step 2: Jalankan, pastikan gagal**.
- [ ] **Step 3: Implementasi** `src/autologon.js` + cabang CLI di `server.js`.
- [ ] **Step 4: Jalankan, pastikan lulus**.

### Task 7: Setelan → 🔐 Akses saat PC terkunci (UI)

**Files:**
- Modify: `public/index.html` (ganti `#autologon-help`/`#autologon-path` dengan tombol + modal), `public/js/features/settings.js`
- Test: `test/ui.test.mjs` (`settings: autologon modal`)

**Interfaces:**
- Consumes: `POST /api/autostart` (mode `boot`), route baru `POST /api/autologon` `{ password }` → 200 `{ ok, autostart }`, 401 `{ error: 'Sandi Windows salah.' }`, 409 `{ error: 'Dibatalkan.' }`; `POST /api/autologon/disable`.
- Produces: `#btn-autologon-enable`, `#autologon-modal`, `#autologon-password`, `#btn-autologon-disable`.

- [ ] **Step 1: Tulis test UI** — modal muncul saat tombol ditekan, field `type="password"` + `autocomplete="current-password"`, tombol kirim disabled bila kosong; respons 401 menampilkan "Sandi Windows salah." dan modal tetap terbuka; sukses menutup modal dan menampilkan status aktif; teks `enable-autologon.cmd` **tidak ada** di halaman.
- [ ] **Step 2: Jalankan, pastikan gagal**.
- [ ] **Step 3: Implementasi** markah + JS; hapus `#autologon-path` dan hint `.cmd` dari `syncAutostartSection()`; route `POST /api/autologon` didaftarkan di `src/routes/misc.js` dan masuk `LOCAL_ONLY`.
- [ ] **Step 4: Jalankan, pastikan lulus**.

### Task 8: Installer ikut menyalakan mode sebelum login

**Files:**
- Modify: `installer/Adhitron.iss`
- Test: `test/installer-bootmode.test.mjs` (test sumber, pola `test/firewall-check.test.mjs`: string harus sinkron)

**Interfaces:**
- Consumes: `Adhitron.exe --autologon-enable --password-file <path>` (Task 6).
- Produces: task `bootmode` (tidak dicentang, `skipifsilent`), halaman `CreateInputQueryPage` dengan field sandi (`PasswordChar := '*'`), satu `[Run]` elevated (pola `Start-Process -Verb RunAs` yang sudah dipakai baris firewall).

- [ ] **Step 1: Tulis test** — `test('the installer asks for the password only when the boot mode task is checked', ...)`, `test('the installer run entry is skipped on silent installs', ...)` (`skipifsilent` pada baris `bootmode`), `test('the password never appears in the .iss at build time', ...)`.
- [ ] **Step 2: Jalankan, pastikan gagal**.
- [ ] **Step 3: Implementasi** `.iss` (halaman sandi, task, Run entry, hapus file sementara).
- [ ] **Step 4: Verifikasi kompilasi nyata** — `node scripts/build-windows.mjs` → `dist/installer/Adhitron-Setup-1.0.33.exe` terbentuk; buka `[Run]` dan pastikan tidak ada `UAC` pada `WizardSilent`.
- [ ] **Step 5: Jalankan, pastikan lulus** + `node --test test/installer-bootmode.test.mjs`.

### Task 9: Build, dokumen, dan pembersihan

**Files:**
- Modify: `package.json` (+`@whiskeysockets/baileys`, `+qrcode`), `scripts/build-windows.mjs` (assert bundle berisi baileys), `README.md`, `docs/pairing-whatsapp.md`, `docs/privasi-data.md`, `CHANGELOG.md`, `docs/remote-power-bridge.md` bila menyebut WAHA
- Delete: baris `enable-autologon.cmd`/`disable-autologon.cmd` dari `src/autostart.js` + test terkait (GUI menggantikannya), `.cmd` dari `[Files]`/docs

**Interfaces:**
- Consumes: semuanya.
- Produces: dokumentasi tanpa satu pun perintah terminal untuk fitur ini.

- [ ] **Step 1: `package.json`** — tambah dua dependensi; jalankan `npm install` (non-interaktif).
- [ ] **Step 2: Build** — `node scripts/build-windows.mjs` exit 0; `dist/Adhitron/Adhitron.exe` ada dan ukurannya < 130 MB.
- [ ] **Step 3: Tulis ulang** `docs/pairing-whatsapp.md` (alur GUI: Setelan → 📱 → Tautkan → pindai QR), `README`, `CHANGELOG` bagian "Belum dirilis", `privasi-data.md` (kunci sesi WhatsApp + sandi Windows di registry, retensi, cara menghapus).
- [ ] **Step 4: Hapus .cmd** dari `src/autostart.js`, test, dan dokumen; `grep -rn "enable-autologon" .` → kosong.
- [ ] **Step 5: Gate penuh** — `npm run test:fast`, `npm run test:smoke`, `node --test bridge/netlify.test.mjs`, ESLint 0.

---

## Review akhir (wajib sebelum lapor selesai)

- `security`: QR tidak bisa diambil dari HP/Tailscale, kunci sesi terenkripsi, sandi Windows tidak bocor ke log/state/halaman.
- `compliance`: sesi WhatsApp + nomor + sandi Windows di registry masuk `privasi-data.md` (dasar pemrosesan, retensi, cara hapus).
- `reviewer`: diff penuh (kebenaran, edge case, konsistensi gaya, test).
