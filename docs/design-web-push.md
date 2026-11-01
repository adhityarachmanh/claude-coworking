# Desain: HTTPS via Tailscale + Web Push dengan tombol Izinkan / Tolak

Status: **usulan** (belum diimplementasi) · Penulis: Tech Lead · 2026-11-01
Lingkup: (1) listener HTTPS untuk akses Tailscale, (2) Web Push ke HP, (3) notifikasi dengan aksi Izinkan/Tolak.
Batasan tetap: Node ≥ 20, **nol dependensi npm**, frontend vanilla, CSP ketat, semua jaminan di README "Buka dari HP" dan "Keamanan" dipertahankan.

---

## 0. Ringkasan keputusan

| # | Keputusan | Alasan singkat |
|---|---|---|
| D1 | **`tailscale cert` + listener `https` milik kita sendiri**, bind hanya ke IP Tailscale, port **4318** | `remoteAddress` tetap 100.x dan `localAddress` tetap IP interface Tailscale, jadi `isTailscaleConnection` dan gerbang WiFi bekerja apa adanya. `tailscale serve` membuat request datang dari 127.0.0.1 dan terlihat seperti laptop. |
| D2 | HTTP tetap jalan persis seperti sekarang; HTTPS adalah **tambahan** yang hanya aktif kalau sertifikat tersedia | Kalau HTTPS Certificates belum dinyalakan di tailnet, semuanya berjalan seperti hari ini. |
| D3 | Origin HTTPS = **origin terpisah**, jadi **pairing terpisah**. Cookie `__Host-office_device` (`Secure`). Token perangkat **terikat transport**: token yang dipasangkan lewat HTTPS ditolak di HTTP, dan sebaliknya | Host berbeda (nama `ts.net` vs IP) sehingga cookie memang tidak dibagi. Ikatan transport adalah defense in depth. |
| D4 | **Tanpa HSTS**; COOP `same-origin` dikirim juga di HTTPS | HSTS berlaku per host (mengabaikan port) dan tidak menambah keamanan di dalam tunnel WireGuard. |
| D5 | Web Push diimplementasi sendiri dengan `node:crypto`: VAPID ES256 (RFC 8292) + `aes128gcm` (RFC 8291/8188) | Layak tanpa dependensi (sekitar 200 LOC) dan diverifikasi dengan known-answer vector RFC 8291 Appendix A. |
| D6 | Subscription disimpan **di record perangkat** (`persisted.remote.devices[].push`); kunci VAPID di `persisted.remote.vapid` | Cabut perangkat atau auto-unpair otomatis ikut menghapus subscription. `exportState()` sudah membuang `remote`, jadi kunci dan subscription tidak pernah masuk backup. |
| D7 | Pengaturan notifikasi (localStorage) **dikirim bersama subscription** dan disinkronkan setiap kali berubah; server memakai **`notifyPlan()` yang sama** (`public/js/core/notify-rules.js`, modul murni) dengan jam di zona waktu HP | Satu sumber aturan. Favorit memang sudah ada di server. |
| D8 | Payload minimal: nama project, nama role, **nama tool saja** (bukan perintah, path, atau teks error) | Tampil di lock screen; metadata terlihat oleh FCM/APNs/Mozilla. Detail tetap ada di aplikasi. |
| D9 | Aksi dari notifikasi memakai **action token sekali pakai** per (approval, perangkat), TTL 15 menit, disimpan hanya di memori sebagai hash, **dan** cookie perangkat HTTPS. Endpoint `/api/push/act`, dikecualikan hanya dari `x-office-token` | SW tidak punya token CSRF per-start. Endpoint tetap di bawah `/api/` supaya gerbang WiFi (`wifiAllows`) otomatis menolaknya. |
| D10 | Aksi hanya **Izinkan** (setara tombol "Izinkan", bukan "selalu"/"semua") dan **Tolak**, hanya untuk `kind: 'tool'`. Question/plan → buka aplikasi | Keputusan dengan cakupan lebih luas tetap butuh layar penuh. |
| D11 | Service worker **tanpa `fetch` handler** (tidak ada cache), didaftarkan hanya di origin HTTPS; `/sw.js` mengembalikan 404 di HTTP | Tidak bisa merusak jalur HTTP/WiFi. Respons 404 saat update check membuat browser meng-unregister SW (kill switch alami). |

---

## A. HTTPS untuk Tailscale

### A1. Perbandingan

| Kriteria | **(1) `tailscale cert` + listener https kita (DIPILIH)** | (2) `tailscale serve` (reverse proxy) |
|---|---|---|
| Alamat peer di Node | `100.x` HP; `localAddress` = IP Tailscale laptop | `127.0.0.1`, jadi `isLocal()` = true |
| Gerbang yang ada (`isLocal`, `LOCAL_ONLY`, `wifiAllows`, `canManageAccount`) | Bekerja tanpa diubah | **Berbahaya**: HP dianggap laptop (akses ke `/api/config`, backup, `/api/remote`, shutdown). Perlu backend terpisah plus kepercayaan pada header `Tailscale-User-*` |
| Proses lokal lain | Tidak berpengaruh | Siapa pun di laptop bisa memanggil port backend |
| Siklus hidup | Ikut proses kita (berhenti saat server mati atau akses HP dimatikan) | Konfigurasi persisten di tailscaled, tetap aktif saat app mati atau akses HP off |
| Port | Bebas (4318) | 443 (bentrok dengan Serve/Funnel lain) |
| Sertifikat | Kita baca file dari `tailscale cert`, reload dengan `setSecureContext` | Diurus tailscaled |
| Kompleksitas | Sedang (cert manager + listener) | Rendah di awal, tinggi untuk membuatnya aman |

**Keputusan**: opsi (1). Opsi (2) melanggar invarian "loopback = laptop" yang menjadi dasar seluruh model keamanan. Sebagai defense in depth, `isLocal` diubah menjadi `LOOPBACK.has(remoteAddress) && !req.socket.encrypted`: socket TLS **tidak pernah** dianggap laptop, meskipun suatu hari ada orang yang memasang `serve` atau bind HTTPS ke loopback.

### A2. Topologi listener

| Listener | Bind | Skema | Host yang diterima | Siapa |
|---|---|---|---|---|
| utama | `127.0.0.1:4317` | http | `localhost:4317`, `127.0.0.1:4317` | laptop (tidak berubah) |
| LAN/Tailscale | setiap IP dari `lanAddresses()` `:4317` | http | `<ip>:4317` | tidak berubah (WiFi read-only, Tailscale-http penuh) |
| **baru** | setiap IP `kind === 'tailscale'` `:4318` | **https** | **hanya** `<dnsName>:4318` (mis. `arh-3.taild0f8a1.ts.net:4318`) | HP Tailscale |

- Port: `OFFICE_HTTPS_PORT` (default `4318`). Port 443 tidak dipakai karena bisa bentrok dengan Tailscale Serve/Funnel atau IIS, dan port yang berbeda membuat jelas mana HTTP dan mana HTTPS.
- Listener HTTPS **tidak pernah** di-bind ke LAN atau loopback. Aktif hanya jika `remote.enabled && cert.state ∈ {ok, expiring}`.
- `syncLanServers()` digeneralisasi menjadi `syncListeners()` yang mengelola kedua map (`lanServers`, `httpsServers`) dengan interval 30 detik yang sama, dan memutus socket saat dimatikan.
- `https.createServer({ cert, key, minVersion: 'TLSv1.2' }, handler)`; sertifikat baru dipasang dengan `server.setSecureContext({ cert, key })` tanpa restart.
- Akses dari laptop sendiri ke `https://<dnsName>:4318` datang dari IP Tailscale laptop sendiri, jadi diperlakukan sebagai HP dan harus pairing. Tidak ada eskalasi.

### A3. Perubahan di `handler()` (server.js)

```js
// Sketsa, bukan kode final
const secure = Boolean(req.socket.encrypted);
const scheme = secure ? 'https' : 'http';
const hosts = allowedHosts(secure); // secure: [`${tls.host}:${HTTPS_PORT}`]; http: seperti sekarang
if (!hosts.includes(host)) return json(res, 421, { error: 'bad host' });
// Origin wajib sama skema DAN host: https listener hanya menerima Origin https://<dnsName>:4318
if (req.headers.origin && !hosts.some((h) => req.headers.origin === `${scheme}://${h}`)) return json(res, 403, { error: 'bad origin' });
const { pathname } = new URL(req.url, `${scheme}://${host}`);
```

- `LOCAL_SECURITY_HEADERS` (COOP) dikirim kalau `isLocal(req) || secure`. Komentar dan baris README tentang COOP diperbarui.
- CSP: tambahkan `worker-src 'self'` secara eksplisit (sudah tercakup lewat fallback `default-src`, tetapi lebih baik eksplisit) dan `manifest-src 'self'`.
- **Tanpa HSTS**. HSTS berlaku untuk host di semua port: kalau suatu hari ada yang membuka `http://<dnsName>:4317`, browser akan memaksa https ke port 4317 dan gagal. HSTS juga tidak menambah apa pun di dalam WireGuard. Tanpa `upgrade-insecure-requests`.

### A4. Cookie, pairing, dan ikatan transport

- Cookie HTTPS: `__Host-office_device=<token>; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`. Prefix `__Host-` menjamin tidak ada `Domain` dan wajib `Secure`.
- Listener HTTP membaca hanya `office_device`; listener HTTPS membaca hanya `__Host-office_device`.
- `RemoteAccess.pair(..., { transport })` menyimpan `device.transport = 'https' | 'http'` (record lama dianggap `'http'`). `verify(token, { transport })` mengembalikan `null` kalau tidak cocok. Token HTTPS tidak pernah berlaku di HTTP (tempat token bisa disadap).
- **Pairing terpisah** (keputusan): origin berbeda berarti localStorage, cookie, izin notifikasi, dan SW juga terpisah. Ini konsisten dengan README ("Alamat WiFi dan Tailscale dipasangkan terpisah").
- Dialog 📱: daftar alamat mendapat entri baru `{ kind: 'tailscale-https', host }` berlabel **"🔒 Tailscale + notifikasi (HTTPS)"**, dan menjadi pilihan default bila tersedia. `/api/remote/pairing` menerima `{ https: true }` dan menghasilkan `qrUrl = https://<dnsName>:4318/pair?k=…`. Daftar perangkat menampilkan badge `🔒 HTTPS` / `🔔 Push`.
- Opsional (fase 5): tombol "Pindah ke HTTPS" di HP yang sudah pairing lewat Tailscale-http. Endpoint `/api/device/https-handoff` hanya untuk `isTailscaleConnection` dan bukan WiFi, menghasilkan pairing key sekali pakai (60 detik), lalu redirect ke `https://…/pair?k=`. Level kepercayaannya sama dengan perangkat itu (sudah kendali penuh). Lihat Pertanyaan Q5.

### A5. Akuisisi dan perpanjangan sertifikat (`src/tls.js`, baru)

Alur `TailscaleCert.refresh()`:

1. Cari CLI: `OFFICE_TAILSCALE_BIN`, lalu `tailscale` di PATH, lalu `%ProgramFiles%\Tailscale\tailscale.exe`. Jalankan dengan `execFile` (tanpa shell), `windowsHide: true`, timeout 90 detik.
2. `tailscale status --json` → `Self.DNSName` (hapus titik di akhir) dan `CertDomains`.
3. Kalau `CertDomains` kosong atau tidak memuat DNSName → state `certs-disabled`.
4. `tailscale cert --cert-file <DATA>/tls/<host>.crt --key-file <DATA>/tls/<host>.key <host>`. Tailscaled menyimpan cache dan baru menerbitkan ulang menjelang kedaluwarsa. **Jangan pernah** memakai `--force` (rate limit Let's Encrypt).
5. Validasi dengan `new X509Certificate(pem)`: `checkHost(host)`, `validTo`, `checkPrivateKey(createPrivateKey(keyPem))`. Hitung fingerprint; kalau berubah, panggil `setSecureContext`.
6. Saat start: pakai file di disk dulu kalau masih valid (start offline tetap bisa HTTPS), lalu `refresh()` di belakang.

Jadwal: saat start (async, tidak memblokir listener HTTP), setiap **12 jam**, saat akses HP dinyalakan, dan lewat tombol **"Periksa lagi"** di 📱 (`/api/remote/https-check`, otomatis laptop-only karena prefix `/api/remote`). Interval harian ini juga aman untuk rencana Let's Encrypt memperpendek masa berlaku sertifikat (45 hari).

Penyimpanan: `data/tls/` di folder data aplikasi (`APP_DIR/data`, atau `OFFICE_DATA_DIR`), **bukan** di bawah profil user. Satu file `<host>.pem` (kunci + chain, ditulis atomik lewat rename) plus `last-host`. Folder dibuat dengan mode `0o700`; di Windows izinnya dibatasi best-effort dengan `icacls <dir> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"` (kalau gagal hanya dicatat di log). File ini **tidak** ikut backup: daftar file backup bersifat eksplisit (`KNOWN_FILES`), dan perlu ditambah test regresi yang memastikannya.

State (dikirim lewat `remote.publicInfo().https`, tanpa path atau key):

| state | Arti | Listener | Teks di 📱 |
|---|---|---|---|
| `off` | Akses HP mati | tidak | – |
| `no-tailscale` | CLI tidak ada atau tidak login | tidak | (tips Tailscale yang sudah ada) |
| `certs-disabled` | `CertDomains` kosong | tidak | "Nyalakan **HTTPS Certificates** di admin console Tailscale (DNS → HTTPS Certificates), lalu klik Periksa lagi." Ditambah catatan CT log (lihat Risiko R3) |
| `ok` | valid, sisa > 14 hari | ya | "🔒 https://arh-3…:4318 · berlaku s/d 30 Jan" |
| `expiring` | sisa ≤ 14 hari dan refresh gagal | ya | peringatan + error terakhir |
| `expired` / `error` | kedaluwarsa, host tidak cocok, CLI gagal tanpa cert valid | **tidak** (listener ditutup) | pesan error singkat; detail di server.log |

Mode gagal penting: CLI butuh hak admin di Windows (lihat R1), MagicDNS dimatikan (tidak ada DNSName), tailnet dirotasi (nama berubah, cert lama `checkHost` gagal, host lama ditolak 421), dan offline saat perpanjangan (cert lama tetap dipakai sampai `validTo`).

---

## B. Web Push tanpa dependensi npm

### B1. Modul

- `src/webpush.js` (murni, tanpa pengetahuan app, sekitar 200 LOC): `generateVapidKeys()`, `vapidAuthHeader({ endpoint, keys, subject, now })`, `encrypt({ plaintext, p256dh, auth, salt?, ephemeral?, padTo? })`, `send(subscription, payload, { ttl, urgency, topic, vapid, request? })`.
- `src/push.js` (kebijakan app): `PushService` mengamati `hub.observers`, menerapkan pengaturan per perangkat, membuat payload, mengelola action token, dan menangani respons push service.

### B2. VAPID (RFC 8292)

- `generateKeyPairSync('ec', { namedCurve: 'prime256v1' })`. Simpan JWK private (`d`) dan public raw 65 byte (`0x04 || x || y` dari JWK) di `persisted.remote.vapid = { publicKey, privateJwk, created }`. Dibuat lazily pada subscribe pertama.
- JWT: header `{"typ":"JWT","alg":"ES256"}`, claims `{ aud: new URL(endpoint).origin, exp: now + 12h, sub }`. Tanda tangan: `crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })` menghasilkan r‖s 64 byte langsung, tanpa konversi DER. Cache per `aud` sampai 1 jam sebelum `exp`.
- Header: `Authorization: vapid t=<jwt>, k=<publicKey b64url>`.
- `sub`: `OFFICE_PUSH_CONTACT` atau default `mailto:` (Apple menolak JWT tanpa `sub` yang valid). Lihat Q3.
- Rotasi kunci VAPID membuat semua subscription tidak berlaku, jadi semuanya dihapus dan HP berlangganan ulang saat aplikasi dibuka.

### B3. Enkripsi payload (RFC 8291, `aes128gcm` RFC 8188)

Semuanya tersedia di `node:crypto` (Node 20):

```text
ecdh       = createECDH('prime256v1'); as_public = ecdh.generateKeys()   // 65 B raw (atau setPrivateKey untuk KAT)
ecdh_secret= ecdh.computeSecret(ua_public)                                // throw kalau p256dh bukan titik valid
key_info   = "WebPush: info\0" || ua_public || as_public
IKM        = hkdfSync('sha256', ecdh_secret, auth_secret, key_info, 32)   // extract+expand sekaligus
salt       = randomBytes(16)
CEK        = hkdfSync('sha256', IKM, salt, "Content-Encoding: aes128gcm\0", 16)
NONCE      = hkdfSync('sha256', IKM, salt, "Content-Encoding: nonce\0", 12)
ct||tag    = AES-128-GCM(CEK, NONCE, plaintext || 0x02 || 0x00*pad)       // satu record, delimiter 0x02
body       = salt(16) || rs(uint32 BE 4096) || idlen(1)=65 || as_public(65) || ct || tag(16)
```

- Overhead: header 86 B + delimiter 1 B + tag 16 B = **103 B**. Batas body push service 4096 B, jadi plaintext ≤ 3993 B. Payload kita sekitar 250–450 B JSON.
- **Padding** ke kelipatan 256 B supaya jenis event (ask/done/error) tidak bisa ditebak dari ukuran oleh push service.
- Header HTTP: `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `TTL`, `Urgency`, `Topic`, `Authorization`.
- Pengiriman: `https.request` POST, timeout 10 detik, maksimal 4 pengiriman bersamaan. Tidak ada dukungan proxy korporat (catat di README).

### B4. Penyimpanan subscription per perangkat

```js
// persisted.remote.devices[i]
{ id, hash, name, created, lastSeen,
  transport: 'https',                  // baru (A4)
  push: {                              // baru; null/absent = tidak berlangganan
    endpoint, p256dh, auth,            // b64url; endpoint di-allowlist
    prefs: { ...cleanNotifySettings(), tz: 'Asia/Jakarta' },
    actions: true,                     // tombol Izinkan/Tolak di notifikasi (Q2)
    created, lastOk, lastError, failures,
  } }
```

- `revoke()` dan `pruneIdle()` menghapus seluruh record, sehingga subscription ikut terhapus. Tidak ada state kedua yang bisa tertinggal. Action token milik perangkat itu juga dibuang (callback `onRemoved` baru di `RemoteAccess`, server memanggil `push.forgetDevice(id)`).
- Akses HP dimatikan: subscription disimpan, tetapi **tidak ada push yang dikirim** (`PushService` memeriksa `remote.enabled` dan perangkat valid, tidak idle) dan action token dibuang.
- Respons push service: `201` → `lastOk`. `404/410` → hapus `device.push`. `413` → log (bug). `429/503` → hormati `Retry-After` dan drop event (notifikasi bersifat best-effort). `400/401/403` → `lastError`; setelah 3 kali gagal berturut-turut, hapus subscription (biasanya kunci VAPID tidak cocok).
- **Allowlist endpoint (anti-SSRF)**: hanya `https:`, port 443, host berakhiran `fcm.googleapis.com`, `push.services.mozilla.com`, `push.apple.com`, `notify.windows.com`. Perangkat yang sudah pairing pun tidak boleh membuat server mem-POST ke URL sembarang (mis. layanan di LAN). Allowlist bisa di-inject lewat konstruktor untuk test, bukan lewat env.
- Validasi saat subscribe: `p256dh` 65 B diawali `0x04` dan titik valid (uji `computeSecret`), `auth` 16 B, endpoint ≤ 1024 karakter, body ≤ 4 KB.

### B5. Event yang di-push dan pengaturan per perangkat

Sumber: `hub.observers` (pola yang sama dengan `src/queue.js`).

| Event | Pemicu (broadcast) | kind untuk `notifyPlan` | Urgency | TTL | Topic | Aksi |
|---|---|---|---|---|---|---|
| Minta izin | `approval` dengan `status: 'pending'` | `ask` | `high` | 1800 | `a<h(project)>` | Izinkan/Tolak (hanya `kind:'tool'`) |
| Izin sudah dijawab | `approval` dengan status ≠ pending, hanya ke perangkat yang tadi menerima "ask" | – (selalu, `silent`) | `normal` | 1800 | sama dengan ask | – (mengganti notifikasi tag `ask:<id>`) |
| Tugas selesai | `chat` dengan `kind:'result'`, `ok` | `done` | `normal` | 900 | `d<h>` | – |
| Berhenti / error | `chat` dengan `kind:'result'` dan `!ok`, atau `kind:'error'` | `error` | `normal` | 3600 | `e<h>` | – |
| Antrian dijeda | `queue` → `taskQueue.summary(id)` berubah menjadi `paused` dengan `reason ≠ 'user'` (edge-triggered, state terakhir disimpan per project di PushService) | `error` (v1, lihat Q4) | `normal` | 3600 | `q<h>` | – |

- `h(project)` = `base64url(sha256(installSalt + projectId)).slice(0, 20)`. Header Topic **tidak terenkripsi**, jadi harus opaque (maks. 32 karakter, alfabet b64url). Topic hanya menggantikan pesan yang **belum terkirim** di antrian push service.
- **Kebijakan**: untuk setiap perangkat dengan `push`, panggil `notifyPlan(kind, prefs, { away: true, favorite: hub.persisted.favorites.includes(project), now: phoneClock(prefs.tz) })`. Push dikirim hanya jika `plan.popup`; `silent = !plan.sound`. `phoneClock(tz)` adalah objek `{ getHours, getMinutes }` yang dihitung dengan `Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`. `inQuietHours` hanya memanggil kedua method itu, jadi **`notify-rules.js` tidak perlu diubah**. Server meng-import `../public/js/core/notify-rules.js` (modul murni, sudah dipakai test di Node). `tz` yang tidak valid diganti zona waktu laptop.
- **Sinkronisasi pengaturan**: `features/push.js` memanggil `POST /api/push/prefs` setiap kali `saveNotifySettings` / `setNotifyOn` berjalan (hook kecil di `notify.js`). Selain itu, subscription lengkap dikirim ulang (idempoten) setiap kali aplikasi dibuka di origin HTTPS. Ini sekaligus menjadi self-healing untuk `pushsubscriptionchange`. 🔔 off sama dengan `prefs.enabled = false`, dan server tidak mengirim apa pun.
- **Anti-dobel**: di perangkat yang punya push aktif, `notify()` di halaman tetap memainkan chime tetapi **tidak** membuat `new Notification` (SW yang menampilkannya). SW **selalu** menampilkan notifikasi untuk setiap push: WebKit mencabut subscription setelah beberapa push tanpa notifikasi, dan Chrome menampilkan pesan generik.

### B6. Privasi payload

Payload (setelah didekripsi SW). String dibuat di server dalam bahasa Indonesia, sehingga SW tetap tipis:

```json
{ "v": 1, "type": "ask", "tag": "ask:<approvalId>", "title": "✋ Backend minta izin — claude-coworking",
  "body": "Bash · ketuk untuk melihat detail", "silent": false, "ts": 1761980000000,
  "url": "/?p=<projectId>&ap=<approvalId>", "approval": { "id": "<approvalId>", "kind": "tool" },
  "act": "<action token, hanya jika eligible>", "pending": 2 }
```

- **Tidak** memuat perintah (`label` untuk Bash berisi `$ <command>`), path file, isi chat, teks error, maupun email akun. Isinya hanya nama project (dipotong 40 karakter), nama role, nama tool, dan jumlah izin yang menunggu.
- Alasan: isi notifikasi tampil di lock screen dan riwayat notifikasi OS. Payload memang terenkripsi end-to-end, tetapi push service melihat metadata (endpoint/perangkat, waktu, ukuran, TTL, Urgency, Topic) dan IP laptop. Padding dan Topic opaque mengurangi kebocoran itu.
- Opsi "tampilkan detail perintah di notifikasi" **tidak** ada di v1 (Q1).

---

## C. Notifikasi dengan aksi (Izinkan / Tolak)

### C1. Kenapa tidak memakai API biasa

`handleApi` mewajibkan `x-office-token`, yaitu secret per-start yang disisipkan ke `index.html`. SW tidak punya token itu (dan token berubah setiap restart). Token itu juga tidak boleh disimpan di SW/IndexedDB, karena akan mengubah secret per-start menjadi secret yang persisten.

### C2. Action token

- Dibuat saat push "ask" dikirim ke perangkat D untuk approval A dengan `kind === 'tool'` dan `D.push.actions === true`: `token = randomBytes(32).toString('base64url')`. Server menyimpan **hanya** `sha256(token)` → `{ approvalId, deviceId, exp: now + 15 min }` di `Map` **memori** (hilang saat restart, sama seperti approval yang juga in-memory).
- **Sekali pakai**: dihapus saat dipakai, apa pun hasilnya. **Dibuang** saat approval selesai (dari mana pun), perangkat dicabut/idle, akses HP dimatikan, atau kedaluwarsa (disapu setiap menit). Jumlahnya dibatasi oleh banyaknya approval pending × perangkat.
- Cakupan: hanya `{ allow: true }` atau `{ allow: false }`, tanpa `always`, `allowAll`, `mode`, maupun `message`.

### C3. Endpoint `POST /api/push/act`

Tetap di bawah `/api/`, sehingga **gerbang WiFi tetap satu-satunya** dan otomatis menolak endpoint ini (tidak ada di `wifiAllows`). `handleApi` mengecualikan **hanya path ini** dari pemeriksaan `x-office-token`, karena action token menggantikannya (dan lebih kuat: terikat, sekali pakai, singkat). Pemeriksaan, berurutan:

1. `req.socket.encrypted` dan `isTailscaleConnection(localAddress, remoteAddress)`. Kalau tidak terpenuhi → 403. HTTP (termasuk Tailscale-http) tidak bisa memakai endpoint ini.
2. Host dan Origin sudah diperiksa `handler()` (SW mengirim `Origin: https://<dnsName>:4318` pada POST).
3. `device = remote.verify(cookie['__Host-office_device'], { transport: 'https' })`, wajib ada (cookie **dan** token).
4. Body JSON ≤ 1 KB `{ t, d: 'allow'|'deny' }`. Lookup `sha256(t)`. Harus ada, belum kedaluwarsa, dan `deviceId === device.id`. Hapus token.
5. Approval masih `pending` dan `kind === 'tool'` → `hub.resolveApproval(id, { allow, answeredBy: { device: device.name, via: 'push' } })`.
6. Respons: `200 { ok: true, status: 'allowed'|'denied' }` · `409 { status: 'allowed'|'denied'|'cancelled'|'gone' }`, dengan status akhir diambil dari LRU kecil (200 entri) berisi approval yang sudah selesai di PushService · `401/403/410` untuk token tidak valid atau kedaluwarsa.
7. Rate limit: 20 kegagalan per menit per IP → 429. Token 256-bit tidak bisa di-brute-force, jadi ini hanya untuk meredam noise.

Laptop: approval yang dijawab lewat push memunculkan toast/log "Diizinkan dari HP 'Android · Chrome' (notifikasi)", polanya sama dengan `accountAlert`. `answeredBy` juga ikut di broadcast `approval`.

### C4. Service worker: `notificationclick`

```js
// public/sw.js (sketsa)
self.addEventListener('notificationclick', (event) => {
  const { notification, action } = event;
  const data = notification.data ?? {};
  notification.close();
  if ((action === 'allow' || action === 'deny') && data.act) {
    event.waitUntil(answer(data, action)); // fetch + ganti notifikasi dengan hasilnya
  } else {
    event.waitUntil(openApp(data.url)); // fokus client yang ada atau clients.openWindow(url)
  }
});

async function answer(data, decision) {
  let title;
  try {
    const res = await fetch('/api/push/act', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: data.act, d: decision }),
    });
    const out = await res.json().catch(() => ({}));
    title = res.ok ? (out.status === 'allowed' ? '✓ Diizinkan' : '✗ Ditolak')
      : res.status === 409 ? `Sudah dijawab: ${STATUS_LABEL[out.status] ?? 'tidak berlaku lagi'}`
      : 'Tidak bisa dijawab dari notifikasi — ketuk untuk membuka';
  } catch {
    title = 'Tidak tersambung (Tailscale mati?) — ketuk untuk membuka';
  }
  // Tag sama + silent: mengganti notifikasi lama tanpa bunyi; tanpa actions.
  return self.registration.showNotification(title, { tag: data.tag, silent: true, data: { url: data.url } });
}
```

- `push` handler: `event.waitUntil(showNotification(p.title, { body, tag, silent, data, actions: p.act ? [{ action: 'allow', title: 'Izinkan' }, { action: 'deny', title: 'Tolak' }] : [], requireInteraction: p.type === 'ask' }))`. Untuk `type: 'resolved'`, pakai tag yang sama, silent, tanpa actions.
- Deep link: `app.js` membaca `?p=<projectId>&ap=<approvalId>` saat load, memanggil `selectProject(p)`, menggulir ke kartu approval, lalu `history.replaceState` membersihkan URL. Ini juga dipakai klik notifikasi di halaman (laptop).
- Kalau cookie ternyata tidak terkirim dari SW (lihat R2), server membalas 401 dan SW menampilkan "ketuk untuk membuka". Fallback ini aman.

### C5. Perilaku per platform

| Platform | Push | Tombol aksi | Catatan |
|---|---|---|---|
| Android Chrome/Edge | Ya (FCM), tidak perlu install PWA | **Ya**, maks. 2 (`Notification.maxActions`) | `requireInteraction` diabaikan. Aksi bisa ditekan dari lock screen tergantung setelan OS (R4). Menekan aksi tidak membuka app. |
| Android Firefox | Ya (Mozilla autopush) | Tidak/terbatas | Fallback: ketuk untuk membuka |
| iOS/iPadOS Safari ≥ 16.4 | **Hanya** PWA di layar utama; izin harus diminta dari gesture user | **Tidak ada** action button | Ketuk notifikasi → app terbuka di kartu izin. PWA layar utama punya storage sendiri, jadi perlu pairing HTTPS sekali lagi di sana (sudah dijelaskan README). |
| Desktop (laptop sendiri) | Tidak dipakai | – | Laptop tetap memakai `notify.js` in-page. SW tidak didaftarkan di `localhost`. |

---

## D. Service worker: scope, CSP, cache, update

- File `public/sw.js` (klasik, bukan module SW, supaya kompatibel dengan Firefox/iOS lama), dilayani di `/sw.js` dengan scope `/`, `Content-Type: text/javascript`, `Cache-Control: no-cache`. Ditambahkan ke `PUBLIC_ASSET` **hanya di listener HTTPS** (tidak berisi data; fetch update SW tidak boleh bergantung pada cookie). Di listener HTTP: **404**.
- Registrasi di `features/push.js`: hanya jika `location.protocol === 'https:' && isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window`. Panggilannya `register('/sw.js', { scope: '/', updateViaCache: 'none' })`. Di HTTP/WiFi dan localhost kode ini tidak pernah berjalan.
- **Tidak ada `fetch` handler, tidak ada Cache Storage**. API, `/stream`, dan `index.html` (yang membawa token per-start) tidak pernah melewati SW. Offline shell tidak berguna karena kantor butuh server, dan cache justru berisiko menyajikan token atau UI basi. Chrome tidak lagi mewajibkan `fetch` handler untuk installability.
- Update: konstanta `SW_VERSION` di sw.js, `install` → `skipWaiting()`, `activate` → `clients.claim()`. Ini aman karena tidak ada cache.
- Kill switch: menonaktifkan fitur di server berarti `/sw.js` membalas 404, dan browser meng-unregister SW pada pemeriksaan update berikutnya. Unsubscribe di server cukup dengan menghapus `device.push`.
- CSP header berlaku juga untuk skrip SW. `worker-src 'self'`, `connect-src 'self'` (fetch `/api/push/act` sesuai). Tidak perlu `'unsafe-*'`.
- Manifest: `id`, `scope`, dan `start_url` sudah `/`. Tidak ada perubahan selain memastikan manifest dilayani di HTTPS (sudah lewat `PUBLIC_ASSET`).

---

## E. Jalur WiFi tetap read-only

| Lapisan | Jaminan |
|---|---|
| Browser | Jalur HTTP bukan secure context, jadi `serviceWorker` dan `PushManager` tidak ada. HP WiFi tidak bisa berlangganan. |
| Subscribe | `/api/push/subscribe|prefs|unsubscribe|test` tidak ada di `wifiAllows` (otomatis 403 di WiFi), dan **juga** mensyaratkan `req.socket.encrypted` serta `device.transport === 'https'`. |
| Aksi | `/api/push/act`: gerbang WiFi + `encrypted` + `isTailscaleConnection` + cookie `__Host-` dengan transport `https` + token terikat perangkat. |
| Listener | HTTPS hanya bind ke IP interface bernama Tailscale. Peer 100.x di WiFi CGNAT tetap ditolak oleh `isTailscaleConnection`. |
| Saat aksi | Kalau VPN Tailscale di HP mati, `<dnsName>` tidak resolve/route dan fetch gagal, sehingga SW menampilkan pesan dan tidak ada yang dijawab. Push tetap tiba lewat internet, tetapi **aksi selalu lewat Tailscale**. |

Test regresi wajib: semua `/api/push/*` → 403 `readOnly` dari LAN (perluas loop yang sudah ada di `test/server.test.mjs` sekitar baris 400).

---

## F. File/modul yang berubah

| File | Perubahan | Role |
|---|---|---|
| `src/tls.js` (baru) | `TailscaleCert`: cari CLI, status, cert, validasi X509, jadwal, state | backend |
| `src/webpush.js` (baru) | VAPID, JWT ES256, enkripsi RFC 8291, `send()` | backend |
| `src/push.js` (baru) | `PushService`: observer, kebijakan (`notifyPlan`), payload, topic, action token, LRU status, penanganan respons, allowlist | backend |
| `src/remote.js` | `transport` di `pair/verify`, `onRemoved`, `publicInfo().https`, badge push per perangkat, entri alamat `tailscale-https` | backend |
| `server.js` | `syncListeners()` (http + https), `handler` sadar skema (Host/Origin/URL/COOP/CSP), `isLocal` dengan `!encrypted`, cookie `__Host-`, `/sw.js`, `/api/push/{subscribe,unsubscribe,prefs,test,act}`, `/api/remote/https-check`, `answeredBy` | backend |
| `src/hub.js` | `resolveApproval` meneruskan `answeredBy` ke approval yang di-broadcast | backend |
| `public/sw.js` (baru) | handler `push` / `notificationclick` / `pushsubscriptionchange` (best-effort) | frontend |
| `public/js/features/push.js` (baru) | registrasi SW, subscribe/unsubscribe, sync prefs, toggle "Tombol aksi di notifikasi", banner "Buka versi HTTPS untuk notifikasi" di Tailscale-http | frontend |
| `public/js/features/notify.js` | hook sync prefs; lewati `new Notification` kalau push aktif di perangkat ini | frontend |
| `public/js/features/phone.js` | status HTTPS + "Periksa lagi", QR HTTPS, badge 🔒/🔔 per perangkat | frontend |
| `public/js/app.js` | deep link `?p=&ap=` | frontend |
| snapshot `client` | `secure`, `push: { available, vapidPublicKey, subscribed }` (hanya di HTTPS) | backend |
| `README.md` | tabel jalur (+ baris "🔒 Tailscale HTTPS: penuh + notifikasi"), Keamanan (cookie `__Host-`, action token, privasi payload, CT log), langkah mengaktifkan HTTPS Certificates | devops/docs |
| `test/*` | lihat Test plan | qa |

Kontrak API baru (semuanya POST JSON, kecuali `act`, semuanya butuh `x-office-token`):

| Endpoint | Body | Respons | Syarat |
|---|---|---|---|
| `/api/push/subscribe` | `{ subscription: { endpoint, keys: { p256dh, auth } }, prefs, actions }` | `{ ok }` | https + Tailscale + device https |
| `/api/push/prefs` | `{ prefs, actions? }` | `{ ok }` | idem |
| `/api/push/unsubscribe` | `{}` | `{ ok }` | idem |
| `/api/push/test` | `{}` | `{ ok, status }` (kode dari push service) | idem |
| `/api/push/act` | `{ t, d }` | lihat C3 | **tanpa** `x-office-token`; https + Tailscale + cookie + token |
| `/api/remote/https-check` | `{}` | `publicInfo().https` | laptop saja |

---

## G. Rencana bertahap

| Fase | Isi | Role | Exit criteria |
|---|---|---|---|
| **0. Spike** (1–2 hari) | Nyalakan HTTPS Certificates. Cek apakah `tailscale cert` jalan **tanpa admin** di Windows. Cek prompt firewall Windows untuk port 4318. Cek di Android Chrome bahwa fetch dari SW pada `notificationclick` mengirim cookie `__Host- SameSite=Strict`. Cek Apple menerima `sub` VAPID pilihan kita. | devops, frontend, backend | Keempat pertanyaan terjawab; R1/R2 ditutup atau ada mitigasi |
| **1. HTTPS** | `src/tls.js`, `syncListeners`, handler sadar skema, `isLocal` dengan `!encrypted`, cookie `__Host-`, ikatan transport, UI 📱 (status, QR HTTPS), README | backend, frontend, devops | HP pairing di `https://<dnsName>:4318`, gerbang tidak berubah, `certs-disabled` dan HTTP tetap seperti sekarang |
| **2. Kripto Web Push** | `src/webpush.js` + KAT | backend, security (review) | KAT RFC 8291 lulus, JWT terverifikasi |
| **3. Subscription + notifikasi (tanpa aksi)** | `src/push.js`, endpoint subscribe/prefs/test, `sw.js` (push + klik buka), `features/push.js`, deep link, anti-dobel | backend, frontend | Notifikasi ask/done/error/queue tiba di Android dan iOS PWA sesuai pengaturan |
| **4. Aksi** | action token, `/api/push/act`, `answeredBy`, notifikasi "resolved", toggle aksi | backend, frontend, security | Izinkan/Tolak dari lock screen Android berjalan; WiFi/HTTP terbukti ditolak |
| **5. Polishing** | handoff HTTPS (Q5), banner di Tailscale-http, metrik "push terakhir" per perangkat di 📱 | frontend, backend | – |

Security review wajib di akhir fase 1 dan fase 4 (checklist: gerbang WiFi, `isLocal`, Host/Origin per skema, token sekali pakai, allowlist endpoint, privasi payload, tidak ada secret di log).

---

## H. Test plan

**Unit (node:test, tanpa jaringan)**
- `test/webpush.test.mjs`
  - **KAT RFC 8291 Appendix A**: suntikkan `as_private` (via `ecdh.setPrivateKey`), `salt`, `ua_public`, `auth_secret`, dan plaintext "When I grow up, I want to be a watermelon". Assert `ecdh_secret`, `key_info`, `IKM`, `CEK`, `NONCE`, header, dan body final byte-per-byte sesuai appendix.
  - Round-trip: dekriptor sisi-UA khusus test (berperan sebagai browser) membuka hasil `encrypt()` dengan padding 0/256/3993 B; plaintext 3994 B harus ditolak.
  - VAPID: kunci publik 65 B diawali `0x04`; JWT header/claims (`aud` = origin endpoint, `exp` ≤ 24 jam, ada `sub`); signature 64 B lolos `crypto.verify(..., { dsaEncoding: 'ieee-p1363' })`.
  - `p256dh` tidak valid (bukan titik pada kurva, 33 B compressed, panjang salah) ditolak.
- `test/push.test.mjs`: kebijakan (per-event, quiet hours lintas tengah malam di `tz` HP ≠ zona waktu laptop, `allowAsk`, favoritesOnly dari favorit server, 🔔 off), pemetaan event (edge-triggered queue pause, `reason: 'user'` tidak di-push), payload **tanpa** perintah/path (assert `$ ` dan path tidak muncul), topic opaque ≤ 32 karakter, padding. Token: sekali pakai, kedaluwarsa, salah perangkat, dibuang saat resolve/revoke/remote off, LRU 409. Respons push: 404/410 hapus, 429 Retry-After, 3× 403 hapus. Allowlist menolak `http:`, IP, port ≠ 443, host lain.
- `test/remote.test.mjs`: ikatan transport (`verify` dengan transport berbeda → null), revoke dan prune menghapus `push`, `publicInfo` tidak membocorkan endpoint/kunci.
- `test/tls.test.mjs`: CLI palsu (skrip node lewat `OFFICE_TAILSCALE_BIN`) untuk skenario: tidak ada CLI, `CertDomains` kosong, sukses (fixture cert), host tidak cocok, kedaluwarsa, ≤ 14 hari, CLI gagal dengan cert lama valid.
- `test/backup.test.mjs`: export tidak memuat `remote.vapid`, `devices[].push`, maupun `data/tls`.

**Integrasi**
- Fake push endpoint: server http lokal yang di-inject ke `PushService` (allowlist lewat konstruktor, bukan env). Fake ini mendekripsi body dengan kunci UA test, memverifikasi JWT VAPID dan header (`TTL`, `Urgency`, `Topic`, `Content-Encoding`), dan bisa diprogram membalas 201/404/410/429.
- `test/server.test.mjs`: fixture cert self-signed (`test-support/fixtures/tls/`, untuk `localhost`) dengan listener HTTPS uji. Uji Host/Origin per skema, cookie `__Host-` beserta atributnya, `isLocal` false di TLS (request TLS dari 127.0.0.1 **tidak** mendapat hak laptop), `/sw.js` 404 di HTTP, `/api/push/*` 403 dari LAN, dan `/api/push/act` tanpa `x-office-token` ditolak di HTTP. Jalur `isTailscaleConnection` tetap di unit test (CI tidak punya interface Tailscale), dan tidak ada env bypass untuk gerbang.

**UI (CDP, `test-support/cdp.mjs`)**
- Chrome headless dengan `--ignore-certificate-errors` ke origin HTTPS fixture: SW terdaftar, tidak ada `fetch` handler (`registration.active` ada, `caches.keys()` kosong). `ServiceWorker.deliverPushMessage` dengan payload ask menghasilkan `registration.getNotifications()` yang memuat tag, actions, dan judul yang benar. Payload `resolved` mengganti notifikasi tanpa actions. Halaman HTTP tidak mendaftarkan SW.
- Deep link `?p=&ap=` memilih project dan menyorot kartu approval.

**Manual QA (perangkat nyata)**: Android Chrome (aksi dari lock screen, Tailscale mati, izin sudah dijawab di laptop, server restart), iPhone PWA iOS ≥ 16.4 (pairing ulang, ketuk membuka kartu), HP WiFi (tidak ada opsi push, semua aksi tetap ditolak).

---

## I. Risiko

| # | Risiko | Dampak | Mitigasi |
|---|---|---|---|
| R1 | `tailscale cert` di Windows mungkin butuh admin (LocalAPI cert access) | Perpanjangan otomatis gagal | Spike fase 0. Fallback: Scheduled Task elevated mingguan yang menjalankan `tailscale cert` ke `data/tls`, sementara server hanya membaca file (devops) |
| R2 | Cookie `SameSite=Strict` tidak terkirim dari fetch SW pada `notificationclick` di browser tertentu | Aksi gagal | Spike fase 0. Fallback aman sudah ada (401, lalu "ketuk untuk membuka"). Jangan melonggarkan ke `Lax` tanpa review |
| R3 | Sertifikat Let's Encrypt tercatat di **Certificate Transparency log publik**: nama mesin + tailnet (`arh-3.taild0f8a1.ts.net`) menjadi publik | Kebocoran metadata (bukan akses: hanya bisa dijangkau dari dalam tailnet) | Jelaskan di 📱 sebelum user menyalakan. Bisa rename mesin di Tailscale (Q6) |
| R4 | Tombol Izinkan bisa ditekan dari lock screen Android | Orang yang memegang HP terkunci bisa mengizinkan satu aksi tool | Hanya `kind:'tool'`, sekali, tanpa "selalu". Toggle per perangkat. Toast di laptop. Default di Q2 |
| R5 | Push service down atau di-throttle | Notifikasi terlambat/hilang | Best-effort. Aplikasi dan laptop tetap menjadi sumber kebenaran |
| R6 | Kode kripto buatan sendiri | Bug enkripsi | KAT RFC + round-trip + review security. Cakupan sempit (satu record, satu cipher) |
| R7 | Laptop tidur saat approval pending | Push sudah terkirim, aksi gagal | SW menampilkan "tidak tersambung". README sudah menganjurkan sleep = Never |
| R8 | Nama tailnet atau mesin berubah | Host lama 421, cert lama tidak cocok | `refresh()` mendeteksi `checkHost` gagal, state `error`, HP pairing ulang |

---

## J. ADR singkat

**ADR-1: Listener HTTPS sendiri, bukan `tailscale serve`.**
Konteks: model keamanan bergantung pada alamat socket (loopback = laptop, interface Tailscale = penuh, sisanya read-only). Keputusan: `tailscale cert` + `https.createServer` di IP Tailscale port 4318, dan socket TLS tidak pernah dianggap lokal. Konsekuensi: kita mengelola file cert dan perpanjangannya, serta perlu pairing terpisah. Semua gerbang yang ada tetap berlaku tanpa header kepercayaan baru.

**ADR-2: Web Push diimplementasi sendiri dengan `node:crypto`.**
Konteks: kebijakan nol dependensi. Keputusan: implementasi RFC 8291/8292 sekitar 200 LOC dengan KAT. Konsekuensi: perlu review kripto; tidak ada supply-chain risk; satu record `aes128gcm` saja (tanpa `aesgcm` lama, yang sudah tidak dibutuhkan browser modern).

**ADR-3: Aksi notifikasi lewat action token sekali pakai.**
Konteks: SW tidak punya token CSRF per-start, dan persistensi token tersebut tidak diinginkan. Keputusan: token 256-bit per (approval, perangkat), hash di memori, TTL 15 menit, hanya allow/deny, plus cookie `__Host-`, endpoint di bawah `/api/` dengan pengecualian `x-office-token` untuk satu path ini. Konsekuensi: setelah restart server, aksi dari notifikasi lama gagal dengan aman (approval-nya juga sudah tidak ada).

---

## K. Pertanyaan terbuka untuk user

1. **Q1 Privasi**: cukup "nama tool" (mis. `Bash`) di notifikasi, atau perlu opsi per perangkat untuk menampilkan potongan perintah (`$ npm install …`, 60 karakter)? Default desain: tidak ditampilkan.
2. **Q2 Tombol Izinkan di lock screen**: default **aktif** (sesuai tujuan fitur) dengan toggle per perangkat, atau default **hanya Tolak** dan Izinkan sebagai opt-in?
3. **Q3 Kontak VAPID (`sub`)**: alamat `mailto:` mana yang boleh dikirim ke push service (terlihat oleh Google/Apple/Mozilla)? Usulan: `OFFICE_PUSH_CONTACT`, dengan default alamat noreply generik.
4. **Q4 "Antrian dijeda"**: cukup ikut toggle "Berhenti / error" (v1), atau perlu kind dan toggle sendiri di 🔔 Pengaturan notifikasi (mengubah `NOTIFY_KINDS`)?
5. **Q5 Handoff**: boleh HP yang sudah pairing lewat Tailscale-http "naik" ke HTTPS tanpa scan QR ulang (link sekali pakai), atau tetap wajib scan dari laptop?
6. **Q6 CT log**: setuju nama `arh-3.taild0f8a1.ts.net` tercatat publik? Kalau tidak, rename mesin di Tailscale dulu sebelum menyalakan HTTPS Certificates.
7. **Q7** Perlu "jangan kirim push ke HP kalau laptop sedang aktif dipakai" (heuristik: tab laptop terlihat dalam 2 menit terakhir)? Tidak termasuk di v1.
8. **Q8** Setelah HTTPS stabil, apakah listener Tailscale-**http** (`100.x:4317`) dimatikan agar hanya ada satu jalur kendali penuh, atau tetap dipertahankan demi kompatibilitas? Desain v1: dipertahankan.
