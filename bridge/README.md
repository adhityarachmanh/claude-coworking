# Remote Power Bridge — Netlify, multi-tenant

Layanan jembatan daya untuk **Adhitron** (dan siapa pun): nyalakan / matikan PC dari jauh lewat smart plug
(Bardi, Smart Life, dsb.) lewat **Tuya Cloud API**. Kini **multi-tenant**: setiap user mendaftar di web,
memasukkan kredensial Tuya-nya sendiri, dan mendapat **URL + token** untuk ditempel di panel ⚙ Remote power Adhitron.

```
HP / browser apa pun ──▶ jembatan ini (Netlify, online 24 jam) ──▶ Tuya Cloud API ──▶ smart plug ──▶ PC
                              ▲
                              └── heartbeat "PC hidup" dari Adhitron tiap 2 mnt
```

1. **Nyalakan**: plug **ON** → BIOS *Restore on AC Power Loss = Power On* membuat PC boot sendiri. Plug yang
   sudah ON disikluskan OFF → ON agar BIOS dapat kejadian listrik baru.
2. **Matikan**: pemicu menulis jadwal `offAt` (default 5 mnt), lalu **cron tiap menit** mengeksekusinya —
   tetap tepat waktu walaupun PC (dan Adhitron) sudah mati.
3. **Status**: halaman status publik (bisa dibuka via **tiket serah-terima** tanpa token jangka panjang)
   menampilkan state eksplisit — 🟢 hidup / 🖥 booting / 🟡 kemungkinan hidup / ⚫ mati / ⚪ belum pasti — plus
   ⏳ countdown pemutusan dan tombol yang sesuai dengan state itu.

**Halaman `/` mengingat space di browser ini.** Setelah daftar, URL + token ditampilkan dan
`{ id, bridgeUrl, statusUrl, manageUrl }` disimpan di `localStorage` (kunci `adhitron-space`) — jadi refresh
menampilkan kartu **Space kamu** (Buka status / ⚙ Kelola / Lupakan), bukan form kosong lagi. Token tidak
disimpan terpisah (sudah ada di `manageUrl`), dan kolom **Sudah punya token?** membuka `/manage?token=…`
tanpa membuat space baru. “Lupakan” hanya menghapus salinan di perangkat; space di server tetap ada.

**Pindah perangkat tanpa daftar ulang.** Ingatan itu hanya milik satu browser. Untuk membuka space yang sama di
HP/laptop lain — tanpa membuat space kedua — pakai **kode pasangan**: di halaman Kelola tekan
**📲 Pasangkan perangkat lain** → **Buat kode pasangan**, lalu masukkan **8 karakter** itu (mis. `K7M2QX9B`) di
halaman `/` perangkat baru pada bagian **Punya kode pasangan?**. Huruf besar/kecil sama. Kode berlaku 2 menit dan
sekali pakai; sesudah diklaim, space langsung diingat di perangkat itu. Tombol **Salin link manage** juga
tersedia kalau ingin menempel link `/manage?token=…` langsung.

## Deploy (Netlify, gratis)

1. Buat situs Netlify baru (mis. `netlify deploy --dir bridge` atau import repo dengan *base directory* `bridge/`).
   Tanpa build step; routing sudah ditangani `config.path` di tiap fungsi.
2. Set **env var** di Netlify UI (Site configuration → Environment variables):
   - `ENCRYPTION_KEY` — **wajib**, 32-byte hex (64 karakter), mis. `openssl rand -hex 32`.
     Kredensial user dienkripsi AES-256-GCM dengan kunci `scrypt(tokenUser + ENCRYPTION_KEY, salt)`;
     tanpa ini pendaftaran space menolak.
3. Deploy. Blobs store `adhitron-bridge` dibuat otomatis pada pemakaian pertama.
4. Cron tiap menit (`* * * * *`) dinyatakan di `netlify/functions/scheduled.mjs` — otomatis aktif pada
   deploy produksi (bukan deploy preview).

Struktur:

```
bridge/
  netlify.toml              konfigurasi situs (functions dir, catatan env)
  package.json             dependensi sendiri: @netlify/blobs (runtime Netlify juga menyediakannya)
  netlify/functions/
    bridge.mjs             handler v2 untuk semua rute (config.path: /, /api/*, /s/*, /manage)
    scheduled.mjs          scheduled function cron * * * * * (sweep jadwal mati)
  src/
    bridge.mjs             inti: routing, auth, endpoint register/heartbeat/off/on/status, cron sweep
    tuya.mjs               adapter Tuya Cloud (diporting dari worker.js lama: HMAC-SHA256 dua lapis, siklus ON)
    vault.mjs              enkripsi kredensial per-space (AES-256-GCM + scrypt) + enkripsi ownerToken
    store.mjs              lapisan penyimpanan di atas Blobs (space/<id>, token/<sha256>, ticket/h|s/<t>, reg/<ip>,
                           pair/<sha256>, pairSpace/<id>, pairtry/<bucket>)
    pages.mjs              halaman HTML: pendaftaran, manage, status (template string, tanpa file statis)
  netlify.test.mjs         test: node --test (fake fetch Tuya + fake Blobs)
```

## Setup Tuya (Bardi / Smart Life)

1. Daftar di [iot.tuya.com](https://iot.tuya.com) (region sesuai app — Indonesia biasanya **eu**), buat **Cloud Project**.
2. Salin **Access ID** (= Client ID) dan **Access Secret**.
3. Tautkan akun **Smart Life** yang berisi plug (Devices → Link Smart Life).
4. Cari **Device ID** plug-nya.
5. Set BIOS PC: **Restore on AC Power Loss = Power On**.

Region yang diterima bridge: `eu`, `america`, `asia` (alias portal lama `us`/`cn` dikanonisasi otomatis).

## Kontrak API (untuk Adhitron / client lain)

Semua respons JSON. Auth API **hanya lewat header** (query `?token=` hanya untuk halaman HTML):

| Endpoint | Header | Body / query | Respons |
|---|---|---|---|
| `POST /api/space` | — (IP di-throttle 10/hari) | `{ tuyaClientId, tuyaClientSecret, tuyaDeviceId, tuyaRegion, adhitronUrl? }` | valid → `{ ok, id, token, bridgeUrl, statusUrl, manageUrl }` · kredensial ditolak Tuya → **422** · Tuya tak terjangkau → **503** |
| `POST /api/pair` | `X-Bridge-Token: <ownerToken>` **saja** (tiket → 401) | — | `{ ok, code, expiresAt }` |
| `POST /api/pair/claim` | — (kodenya sendiri bukti; 20 gagal/IP/jam + 3000 gagal/jam total) | `{ code }` (8 karakter base32, string) | sama dengan `POST /api/space` |
| `POST /api/heartbeat` | `X-Bridge-Token: <ownerToken>` | `{ ts, version }` | `{ ok }` |
| `POST /api/off?delay=300[&hold=1]` | `X-Bridge-Token` (atau `X-Status-Token`) | delay 0-3600 dtk, default 300; `hold=1` = jadwal "matikan rapi" yang kebal pembatalan heartbeat | `{ ok, offAt, fired, handoffUrl }` |
| `POST /api/off/cancel` | `X-Bridge-Token` / `X-Status-Token` | - | `{ ok, cancelled }` - hapus jadwal tanpa menyentuh plug |
| `POST /api/on` | `X-Bridge-Token` / `X-Status-Token` | `?force=1` untuk memaksa siklus OFF → ON | `{ ok }` · PC masih hidup tanpa `force` → **409** |
| `GET /api/status` | `X-Bridge-Token` / `X-Status-Token` | — | status (di bawah) |

- `bridgeUrl` = URL situs jembatan; **panel Adhitron ⚙ Remote power: URL = bridgeUrl, token = `token`**.
- **Kode pasangan** (pindah space ke perangkat lain): `POST /api/pair` membuat kode **8 karakter base32** —
  alfabet `23456789ABCDEFGHJKMNPQRSTVWXYZ` (tanpa `I`, `L`, `O`, `U`, `0`, `1`), huruf besar/kecil sama
  (dinormalisasi uppercase), mis. `K7M2QX9B`. TTL **120 detik**, **sekali pakai**, dan **satu kode aktif per
  space** (kode lama mati saat kode baru dibuat). Hanya **ownerToken** yang boleh membuat kode: tiket
  serah-terima/sesi dari link status ditolak **401**, jadi tiket tidak bisa ditukar menjadi token permanen.
  Yang disimpan hanya **sha256(kode)** (`pair/<sha256>`; kode plaintext tidak pernah masuk store atau log).
  `POST /api/pair/claim` tidak butuh auth — kodenya sendiri bukti — dipanggil same-origin **tanpa header CORS**,
  dan menjawab dengan bentuk yang sama seperti register, jadi perangkat baru langsung memegang `token` +
  `manageUrl`. Kode salah, kedaluwarsa, atau sudah dipakai → **401** dengan **satu pesan yang sama** (jenis
  kegagalan tidak dibocorkan); body bukan `{ code }` valid → **400**; **20 klaim gagal per IP per jam** atau
  **3000 klaim gagal per jam total** → **429**. Kode yang tidak pernah diklaim dibuang cron.
- `handoffUrl` = `/s/<id>?t=<tiket>` — tiket serah-terima (jenis `ticket/h/`) **sekali pakai**, TTL 10 menit,
  untuk membuka halaman status tanpa token jangka panjang. Sekali pakai berlaku di mana pun: lewat halaman
  ATAU langsung sebagai `X-Status-Token` — pemakaian pertama menghapusnya (pemakaian kedua → **401**).
  Membukanya membuat **tiket sesi** baru (jenis `ticket/s/`, reusable sampai TTL) untuk polling halaman.
- **Registrasi memvalidasi kredensial ke Tuya lebih dulu (fail closed).** `POST /api/space` memanggil Tuya —
  token + `GET /v1.0/devices/{deviceId}/status` (read-only, timeout 5 dtk) — **sebelum** menyimpan apa pun.
  Tidak ada `/commands` saat validasi. Kalau ditolak: **422** dengan pesan spesifik (`Client ID/Secret atau
  region ditolak Tuya.`, `Device ID tidak ada di project ini …`, `Device ini bukan smart plug dengan saklar.`);
  kalau Tuya tidak terjangkau/timeout: **503** `Tidak bisa menghubungi Tuya Cloud, coba lagi.`. Tidak ada
  record space, index token, maupun tiket yang tersimpan saat gagal. Throttle 10/IP/hari tetap dihitung
  sebelum validasi, dan ada **cap GLOBAL 300 verifikasi/hari** (lintas IP) supaya kuota Tuya operator tidak
  bisa dihabiskan dari banyak IP; bila terlampaui → **503** `Batas verifikasi harian situs tercapai, coba besok.`
  (tidak ada yang tersimpan). Pesan error tidak pernah memuat Client ID/Secret/Device ID.
- **`POST /api/on` menolak menyalakan PC yang masih hidup.** Bila heartbeat segar atau daya segar > 20 W,
  jembatan menjawab **409** `{ "error": "PC sepertinya masih hidup — listrik tidak disiklus. Kirim ?force=1
  kalau yakin." }` **tanpa memanggil Tuya** (tidak ada siklus OFF → ON yang membunuh PC). `POST /api/on?force=1`
  memaksa siklus OFF → ON — dipakai tombol **⚡ Nyalakan paksa** saat status `unknown`.
- Kontrak header: **`X-Bridge-Token`** membawa ownerToken (dipakai Adhitron) dan diterima di semua endpoint
  API yang membutuhkan token; **`X-Status-Token`** membawa ownerToken ATAU tiket (`ticket/s/` sesi, atau
  `ticket/h/` serah-terima yang langsung habis dipakai) dan setara di `/api/off`, `/api/on`, `/api/status` —
  tetapi TIDAK di `/api/heartbeat` (khusus ownerToken). Token salah / tiket kedaluwarsa → **401**. Body salah
  → **400**. Kegagalan Tuya saat perintah → **502**. Throttle register → **429**. Validasi kredensial:
  ditolak Tuya → **422** (register) / **400** (manage), Tuya tak terjangkau → **503**. PC masih hidup saat
  `POST /api/on` tanpa `force` → **409**.

`GET /api/status` →

```json
{
  "id": "1a2b3c4d", "alive": true,          // alive = heartbeat segar ATAU daya segar > 20 W
  "state": "alive",                         // alive | booting | suspected-alive | off | unknown
  "heartbeatFresh": true, "powerFresh": true, // heartbeat < 7 mnt · sampel daya < 90 dtk
  "heartbeatAgeSec": 41, "powerAgeSec": 12,   // null = belum pernah ada
  "offAt": 1794..., "secondsUntilOff": 214, // jadwal pemutusan (null = tidak ada)
  "plug": "on",                             // asumsi terakhir dari perintah yang dikirim
  "powerW": 45.3, "powerAt": 1794...,       // sampel daya terakhir yang BERHASIL (percobaan dibatasi 1×/30 dtk)
  "booting": false,                         // daya > 20 W ≥ 30 dtk tanpa heartbeat segar
  "needsAttention": false,                  // ⚠ cron gagal memutus 3× — cek plug manual
  "lastHeartbeat": 1794..., "adhitronUrl": "https://nama.ts.net"
}
```

Aturan `state`:

| `state` | Bukti | Arti |
|---|---|---|
| `alive` | heartbeat < 7 mnt, atau sampel daya < 90 dtk dengan daya > 20 W - kecuali sampel segar ≤ 5 W (bukti listrik menang) | PC hidup |
| `booting` | daya > 20 W ≥ 30 dtk, heartbeat basi | PC booting — atau beku |
| `suspected-alive` | daya > 20 W segar, heartbeat basi, < 30 dtk | kemungkinan hidup, bukti belum cukup |
| `off` | daya ≤ 5 W segar, atau plug OFF tanpa heartbeat segar | PC mati |
| `unknown` | tidak ada bukti segar | belum bisa dipastikan |

`samplePower` membatasi **percobaan** Tuya lewat `powerTryAt` (30 dtk); `powerAt` hanya maju saat pembacaan
berhasil, jadi sampel gagal tidak pernah tampak segar.

**PENTING — aturan pembatalan (kontrak heartbeat):** jika heartbeat datang ketika ada jadwal `offAt` di masa
depan, jadwal **otomatis dibatalkan** (heartbeat = bukti PC hidup; dipakai untuk membatalkan "putus paksa"
kalau PC ternyata hidup lagi). Karena itu client yang memanggil `POST /api/off` (alur shutdown rapi) **wajib
berhenti mengirim heartbeat sampai proses shutdown selesai** — Adhitron menjeda heartbeat 12 menit sejak
permintaan shutdown dan melanjutkannya sendiri setelah itu.

**Pengecualian `hold=1`:** tombol **⏻ Matikan PC rapi** di halaman status memanggil
`POST /api/off?delay=300&hold=1`. Jadwal itu **tidak** dibatalkan oleh heartbeat (listrik tetap dipotong setelah
delay, walau Adhitron masih sempat menjawab selama OS shutdown); `POST /api/on` atau **✕ Batalkan jadwal**
(`POST /api/off/cancel`, tanpa menyentuh plug) yang membatalkannya. Tanpa
`hold` (dari Adhitron atau tombol **⚠ Putus paksa**), aturan pembatalan heartbeat di atas tetap berlaku.

Halaman web:

- `/` — pendaftaran + panduan kredensial + pemberitahuan privasi (ringkas selalu tampil; versi lengkap terlipat di `<details>`).
  Halaman memakai brand Adhitron (logo inline SVG, latar gelap, aksen oranye) — CSS satu blok di `pages.mjs`.
  Form menampilkan catatan **"Kredensial dicek langsung ke Tuya Cloud sebelum disimpan."** — daftar baru
  berhasil setelah Tuya menerima Client ID/Secret, region, dan Device ID-nya.
  Bagian **Punya kode pasangan?** menerima kode **8 karakter** (huruf besar/kecil sama): `POST /api/pair/claim`,
  lalu space langsung diingat di perangkat itu (kartu **Space kamu**, bukan form kosong).
- `/manage?token=<ownerToken>` — ganti kredensial/adhitronUrl, rotasi token (re-enkripsi otomatis, token lama mati),
  hapus space (wajib konfirmasi), plus **📲 Pasangkan perangkat lain**: **Buat kode pasangan** (kode 8 karakter +
  hitung mundur 2 menit) dan **Salin link manage** untuk dibuka di perangkat lain. Update memvalidasi
  **kredensial efektif** (secret lama dipakai bila kolom secret dikosongkan) ke Tuya: ditolak → halaman
  menjawab **400** dengan alasan spesifik, jaringan → **503**, dan setelan lama tetap dipakai.
- `/s/<id>?t=<tiket>` atau `/s/<id>?token=<ownerToken>` — halaman status; polling `GET /api/status` tiap 10 dtk
  dengan header **`X-Status-Token`** (aturan halaman: bukan `X-Bridge-Token`) membawa tiket sesi / ownerToken.
  Tombol mengikuti `state` — `alive`: **⏻ Matikan PC rapi** + **▶ Buka Adhitron**; `booting`/`suspected-alive`:
  hanya **⚠ Putus paksa**; `off`: **⚡ Nyalakan PC**; `unknown`: **⚡ Nyalakan paksa** (konfirmasi, memakai
  `/api/on?force=1`). Penolakan **409** ditampilkan sebagai peringatan di halaman, bukan gagal diam-diam.
  Bila jadwal aktif dan daya ≤ 5 W: **⚫ PC sudah mati · ⏳ listrik diputus dalam m:ss**.

## Cron tiap menit (`scheduledSweep`)

Satu pass per tick, tidak pernah loop: untuk tiap space dengan `offAt` jatuh tempo —

1. `lastHeartbeat > offAtWrittenAt` (PC ternyata hidup lagi) → **batal**.
2. Else: plug **OFF** via Tuya, lalu verifikasi daya: `< 5 W` → sukses (jadwal dibersihkan, `attempts = 0`);
   plug tanpa sensor daya → komando OFF dianggap sukses.
3. Masih tinggi → `attempts++`, jadwal ulang `offAt = now + 60`; **3× gagal** → jadwal dihentikan,
   `needsAttention = true` (halaman status: "⚠ gagal memutus — cek plug manual").

## Anti-abuse & keamanan

- Register dibatasi **10 space per IP per hari** (key `reg/<ip>/<tanggal>` di Blobs; hitungan get+set, bukan
  atomik; key hari sebelumnya ikut dihapus saat register berikutnya).
- Klaim kode pasangan dibatasi **20 kegagalan per IP per jam** dan **3000 kegagalan per jam total** (bucket
  `_global`) — key `pairtry/<bucket>/<yyyy-mm-ddThh>`, terpisah dari kuota register → **429**. Kode hanya
  disimpan sebagai `pair/<sha256(kode)>` (8 karakter base32, TTL 120 detik, sekali pakai, satu kode aktif per
  space lewat `pairSpace/<id>`); cron membuang kode dan hitungan lama supaya key tidak menumpuk.
- Heartbeat ditulis maksimal 1×/menit per space (diterima `ok` tapi tidak menulis ulang) — kecuali ada jadwal
  yang perlu dibatalkan, itu selalu ditulis.
- Kredensial Tuya **tidak pernah plaintext** di store maupun halaman: AES-256-GCM, kunci `scrypt(tokenUser +
  ENCRYPTION_KEY, salt per-space)` — rotasi token ikut re-enkripsi. `adhitronUrl` disimpan plaintext.
  **ownerToken juga tidak pernah plaintext di store**: di record space ia tersimpan terenkripsi dengan kunci
  murni dari `ENCRYPTION_KEY` (cron tetap bisa memulihkannya untuk dekripsi kredensial), dan index auth
  memakai key `token/<sha256(ownerToken)>` — snapshot store tidak memuat token siap-pakai. Tiket terbagi dua
  jenis: `ticket/h/<t>` serah-terima **sekali pakai** (hapus di pemakaian pertama, di jalur halaman maupun
  header) dan `ticket/s/<t>` tiket sesi polling (reusable sampai TTL).
- Header token divalidasi (hex, 16–64 karakter) sebelum dipakai sebagai key Blobs; respons membawa
  `Cache-Control: no-store` (respons register/manage memuat token, halaman memuat tiket).
- Halaman HTML jembatan mengirim `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `nosniff`, dan
  `frame-ancestors 'none'` — kode/tiket pernah ada di URL, jadi halaman tidak boleh di-frame atau membocorkan
  referrer. API JSON membawa CORS, **kecuali** `/api/pair` dan `/api/pair/claim` yang khusus same-origin
  (situs lain tidak bisa memicu klaim kode).
- Tidak ada secret di kode; `ENCRYPTION_KEY` lewat env var Netlify. Query selalu terparameterisasi (Blobs API),
  nilai user di HTML selalu di-escape.
- **Insiden keamanan:** operator wajib merotasi `ENCRYPTION_KEY` dan mengabari user terdampak
  (rotasi token paksa) ≤ 3×24 jam.
- **Retensi (cron):** space yang didaftarkan tapi tak pernah dipakai (> 30 hari, heartbeat 0) atau tanpa
  heartbeat lebih dari ±6 bulan dihapus otomatis, termasuk index token dan semua tiketnya.

## Di sisi Adhitron

⚙ → **Remote power**: kolom URL = `bridgeUrl` dari pendaftaran (mis. `https://adhitron-bridge.netlify.app`),
token = `token`. Adhitron mengirim **beat pertama segera saat server siap, lalu tiap 2 menit**
(`OFFICE_POWER_BEAT_MS` bisa menimpanya: integer milidetik ≥ 60000; nilai lebih kecil diabaikan). Saat shutdown: panggil `POST /api/off?delay=300`
lalu **berhenti heartbeat 12 menit** (kontrak pembatalan tetap: heartbeat saat jadwal aktif membatalkan jadwal);
buka `handoffUrl` untuk halaman status serah-terima di HP.

## Test

```bash
node --test --test-timeout=60000 "bridge/**/*.test.mjs"
```

**64 tes** (`node --test`), menggunakan fake fetch Tuya + fake Blobs - tanpa jaringan. Mencakup: register &
enkripsi (tidak ada plaintext di store), validasi kredensial ke Tuya sebelum menyimpan (422/503, pesan tanpa
kredensial), throttle 10/IP/hari, auth 401, jadwal off + tiket sekali pakai, pembatalan via heartbeat,
cron sukses / coba ulang / needsAttention / batal, `hold=1` (heartbeat tidak membatalkan "matikan rapi"), `/api/on` (409 saat PC masih hidup, `?force=1`, hapus jadwal),
cap global 300 verifikasi/hari, error Tuya stabil (tanpa JSON mentah), status `state` + field umur heartbeat/daya, sampel daya gagal tidak dianggap segar, halaman tidak bocorkan
kredensial, tombol per state, manage (update/validasi/rotasi/hapus), kode pasangan (8 karakter base32, hanya
sha256 di store, TTL 2 menit, sekali pakai, hanya ownerToken yang boleh membuat kode, satu kode aktif per
space, pesan 401 yang sama, 400 untuk body salah, throttle 20/IP/jam + 3000/jam total → 429, pembersihan cron).
