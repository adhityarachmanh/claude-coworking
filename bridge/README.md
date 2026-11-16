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
   menampilkan state eksplisit — 🟢 hidup / 🖥 booting / 🟡 kemungkinan hidup / 🟡 standby / ⚫ mati / ⚪ belum pasti — plus
   ⏳ countdown pemutusan dan tombol yang sesuai dengan state itu. Di bawahnya ada monitoring listrik
   realtime (daya, tegangan, arus, status saklar) dari data IoT Core yang sama. Halaman memuat ulang status
   tiap **5 dtk** (2 dtk saat booting) dan menampilkan **umur bukti** ("Bukti: heartbeat 42 dtk lalu · daya 9 dtk lalu").
   Sesudah listrik diputus — dari halaman, cron, atau aplikasi Bardi — tombol **⚡ Nyalakan** terkunci **2 menit**
   dengan hitung mundur, supaya sisa daya di PSU habis dulu.

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

1. Daftar di [iot.tuya.com](https://iot.tuya.com) dan buat **Cloud Project**. Saat membuat project, **pilih data center yang sesuai akun Smart Life-mu** — kredensial hanya valid di data center itu. Kalau tidak yakin, biarkan saja: bridge mendeteksinya otomatis.
2. Salin **Access ID** (= Client ID) dan **Access Secret**.
3. Tautkan akun **Smart Life** yang berisi plug (Devices → Link Smart Life).
4. Cari **Device ID** plug-nya.
5. Set BIOS PC: **Restore on AC Power Loss = Power On**.

Data center yang didukung (7): `eu` (Eropa Tengah), `eu-west` (Eropa Barat), `america` (Amerika Barat), `us-east` (Amerika Timur), `asia` (Tiongkok), `india`, `singapore`. Alias lama `us`/`cn`/`sg`/`in` dikanonisasi otomatis. Kalau region yang dipilih ditolak, bridge mencoba **semua** data center secara paralel (read-only) dan menyimpan yang benar — jadi salah pilih region tidak lagi menggagalkan pendaftaran.

**Kalau tetap ditolak (422):** pesan menyertakan kode Tuya, mis. `(kode Tuya 1004)`. `1004` = signature/Secret tidak cocok → salin ulang **Access Secret** dari Cloud Project (hanya tampil sekali; spasi/newline kini otomatis di-trim), dan pastikan memakai **Access ID/Access Secret Cloud Project**, bukan API key portal lain. `1106` = Device ID tidak ada/tidak punya izin di project itu. Kuota/trial habis → **503**, bukan 422.

## Kontrak API (untuk Adhitron / client lain)
Semua respons JSON. Auth API **hanya lewat header** (query `?token=` hanya untuk halaman HTML):

| Endpoint | Header | Body / query | Respons |
|---|---|---|---|
| `POST /api/space` | — (IP di-throttle 10/hari) | `{ tuyaClientId, tuyaClientSecret, tuyaDeviceId, tuyaRegion, adhitronUrl? }` | valid → `{ ok, id, token, bridgeUrl, statusUrl, manageUrl }` · kredensial ditolak Tuya → **422** · Tuya tak terjangkau → **503** |
| `POST /api/pair` | `X-Bridge-Token: <ownerToken>` **saja** (tiket → 401) | — | `{ ok, code, expiresAt }` |
| `POST /api/pair/claim` | — (kodenya sendiri bukti; 20 gagal/IP/jam + 3000 gagal/jam total) | `{ code }` (8 karakter base32, string) | sama dengan `POST /api/space` |
| `POST /api/heartbeat` | `X-Bridge-Token: <ownerToken>` | `{ ts, version }` | `{ ok }` |
| `POST /api/off?delay=300[&hold=1]` | `X-Bridge-Token` (atau `X-Status-Token`) | delay 0-3600 dtk (kosong = `offDelaySec` yang disimpan handoff, default 300); `hold=1` = kebal pembatalan heartbeat | `{ ok, offAt, fired, handoffUrl }` |
| `POST /api/off/cancel` | `X-Bridge-Token` / `X-Status-Token` | - | `{ ok, cancelled }` - hapus jadwal tanpa menyentuh plug |
| `POST /api/handoff[?delay=N]` | `X-Bridge-Token` / `X-Status-Token` | delay 0-3600 dtk (opsional, disimpan untuk tombol Putus arus) | `{ ok, handoffUrl, offDelaySec }` - tiket halaman status, tanpa jadwal/plug |
| `POST /api/on` | `X-Bridge-Token` / `X-Status-Token` | `?force=1` untuk memaksa siklus OFF → ON | `{ ok }` · PC masih hidup tanpa `force` → **409** · ≤ 2 mnt sesudah pemutusan → **409** `{ error, retryAfterSec }` + header `Retry-After` (berlaku juga untuk `force`) |
| `GET /api/status` | `X-Bridge-Token` / `X-Status-Token` | - | status (di bawah) |
| `GET /api/energy` | `X-Bridge-Token` / `X-Status-Token` | - (tanpa argumen range/tz) | `{ ok, now:{powerW,voltageV,currentMa}, switchOn, energyKwh, updatedAt }` — monitoring realtime dari SATU panggilan device status Tuya IoT Core (gratis; cache 5 dtk). Gagal → `{ ok:false, error }` dengan pesan generik |

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
  kalau Tuya tidak terjangkau/timeout: **503** `Tidak bisa menghubungi Tuya Cloud, coba lagi.`. Kalau region yang
  dipilih ditolak, **semua 7 data center dicoba otomatis** (paralel, read-only) dan region yang berhasil disimpan;
  hanya kalau semuanya menolak kredensial, pesan 422 muncul. Tidak ada
  record space, index token, maupun tiket yang tersimpan saat gagal. Throttle 10/IP/hari tetap dihitung
  sebelum validasi, dan ada **cap GLOBAL 300 verifikasi/hari** (lintas IP) supaya kuota Tuya operator tidak
  bisa dihabiskan dari banyak IP; bila terlampaui → **503** `Batas verifikasi harian situs tercapai, coba besok.`
  (tidak ada yang tersimpan). Pesan error tidak pernah memuat Client ID/Secret/Device ID.
- **`POST /api/on` menolak menyalakan PC yang masih hidup.** Bila heartbeat segar atau daya segar > 15 W,
  jembatan menjawab **409** `{ "error": "PC sepertinya masih hidup — listrik tidak disiklus. Kirim ?force=1
  kalau yakin." }` **tanpa memanggil Tuya** (tidak ada siklus OFF → ON yang membunuh PC). `POST /api/on?force=1`
  memaksa siklus OFF → ON — dipakai tombol **⚡ Nyalakan paksa** saat status `unknown`.
- **Jeda 2 menit sesudah listrik diputus.** Begitu listrik benar-benar terputus (`lastOffAt` terisi),
  `POST /api/on` **dan** `POST /api/on?force=1` dijawab **409** `{ "error": "Listrik baru diputus — tunggu N dtk
  lagi, …", "retryAfterSec": N }` + header `Retry-After`, tanpa memanggil Tuya: sisa daya di PSU harus habis
  sebelum plug dinyalakan lagi (`force` tidak membukanya — ini batas fisik, bukan sekadar pengaman). Jeda yang
  sama berlaku untuk semua jalur pemutusan: `POST /api/off?delay=0`, cron, dan plug yang dimatikan dari aplikasi
  Bardi/Smart Life (transisi `switchOn` → `false` saat sampling daya).
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
  "id": "1a2b3c4d", "alive": true,          // alive = ada bukti segar PC hidup (lihat tabel state)
  "state": "alive",                         // alive | booting | suspected-alive | standby | off | unknown
  "heartbeatFresh": true, "powerFresh": true, // heartbeat < 4 mnt · sampel daya < 90 dtk
  "heartbeatAgeSec": 41, "powerAgeSec": 12,   // null = belum pernah ada
  "offAt": 1794..., "secondsUntilOff": 214, // jadwal pemutusan (null = tidak ada)
  "lastOffAt": 1793...,                     // kapan listrik benar-benar diputus (null = belum pernah)
  "onCooldownSec": 0,                       // sisa jeda 2 menit sebelum Nyalakan boleh (null = belum pernah diputus)
  "plug": "on",                             // saklar terakhir yang diketahui: perintah yang dikirim atau pembacaan switch_1/switch (null = tak diketahui)
  "powerW": 45.3, "voltageV": 220.1, "currentMa": 990, "switchOn": true,
  "energyKwh": 12.34,                       // kWh kumulatif DP add_ele (null kalau plug tidak melaporkannya)
  "powerAt": 1794...,                       // sampel daya terakhir yang BERHASIL (percobaan dibatasi 1×/10 dtk)
  "booting": false,                         // daya > 15 W ≥ 30 dtk tanpa heartbeat segar
  "needsAttention": false,                  // ⚠ cron gagal memutus 3× — cek plug manual
  "lastHeartbeat": 1794..., "adhitronUrl": "https://nama.ts.net"
}
```

Aturan `state` (tegangan **tidak** dipakai sebagai bukti hidup — 220 V tetap ada walau PC mati):

| `state` | Bukti | Arti |
|---|---|---|
| `alive` | heartbeat < **2,5 mnt**, atau sampel daya < 90 dtk dengan daya > 15 W dan heartbeat < 2,5 mnt — kecuali sampel segar ≤ 10 W atau saklar `switch_1 === false` (bukti listrik menang) | PC hidup |
| `booting` | daya > 15 W ≥ 30 dtk, heartbeat basi — **atau** baru diperintah `POST /api/on` dan belum ada sampel daya baru (jendela 3 mnt; sampel lama sudah dibuang, jadi tidak jatuh ke `off`) | PC booting — atau beku |
| `suspected-alive` | daya > 15 W segar, heartbeat basi, < 30 dtk — **atau** heartbeat 2,5–4 mnt tanpa bukti daya segar (PC berhenti berkabar) | kemungkinan hidup, bukti belum cukup — tombol **Putus arus listrik** tidak ditawarkan |
| `standby` | sampel daya segar 10–15 W — mengalahkan heartbeat segar sekalipun | standby / baru dinyalakan — belum bisa dijangkau |
| `off` | `switchOn === false`, sampel daya segar ≤ 10 W, atau plug tercatat OFF tanpa heartbeat segar dan tanpa jadwal menunggu | PC mati |
| `unknown` | tidak ada bukti segar | belum bisa dipastikan |

`heartbeatFresh` tetap berarti "heartbeat < 4 mnt" (kontrak lama), tetapi `alive` hanya diberikan bila heartbeat
lebih muda dari **2,5 mnt**: kabar 2,5–4 mnt tanpa bukti daya segar menjadi `suspected-alive`, supaya tombol
**⏻ Putus arus listrik** hilang setelah PC berhenti berkabar.

Pembacaan listrik dan saklar memakai **satu** panggilan `GET /v1.0/devices/{id}/status` (IoT Core, gratis).
`switchOn`/`lastPlug` ikut diperbarui dari `switch_1`, jadi plug yang dimatikan dari aplikasi Bardi/Smart Life
langsung terbaca OFF (dan transisi ke OFF mencatat `lastOffAt`, yang memulai jeda 2 menit). `samplePower`
membatasi **percobaan** Tuya lewat `powerTryAt` (**10 dtk**); `powerAt` hanya maju saat pembacaan berhasil, jadi
sampel gagal tidak pernah tampak segar. `POST /api/on` yang berhasil **membuang sampel lama** (`powerW = null`,
`powerAt = 0`, `powerTryAt = 0`) dan mencatat `turnedOnAt`: statusnya `booting` sampai sampel daya baru datang,
bukan `off` dari angka 0 W sebelum PC dinyalakan.

Parsing datapoint cocok lewat `code` **maupun** nomor DP `id` (sebagian gateway hanya meneruskan `id`), dan field
yang tidak dilaporkan plug menjadi `null` — bukan error:

| DP | Nama | Skala |
|---|---|---|
| 1 | `switch_1` (atau `switch` di firmware lama) | boolean / 0–1 |
| 19 | `cur_power` | ÷ 10 → W |
| 20 | `cur_voltage` | ÷ 10 → V |
| 18 | `cur_current` | mA |
| 17 | `add_ele` | ÷ 100 → kWh |

Endpoint API yang sengaja **tidak** dipakai: statistik energi Power Management
(`/v1.0/iot-03/energy/electricity/...`) — berbayar dan tidak tersedia untuk akun ini, jadi endpoint itu sudah
dihapus dari jembatan. Yang tersisa hanya dua endpoint IoT Core gratis di atas.

**PENTING — aturan pembatalan (kontrak heartbeat):** jika heartbeat datang ketika ada jadwal `offAt` di masa
depan, jadwal **otomatis dibatalkan** (heartbeat = bukti PC hidup; dipakai untuk membatalkan "putus paksa"
kalau PC ternyata hidup lagi). Karena itu tombol **⏻ Putus arus listrik** di halaman memakai
`POST /api/off?hold=1`: jadwal itu **tidak** dibatalkan oleh heartbeat (listrik tetap dipotong setelah delay);
`POST /api/on` atau **✕ Batalkan jadwal** (`POST /api/off/cancel`, tanpa menyentuh plug) yang membatalkannya.
Adhitron sendiri **tidak lagi menjadwalkan pemutusan** dari aplikasi: "⏻ Matikan PC" hanya mematikan Windows
dan meminta handoff (lihat di bawah), jadi tidak ada heartbeat yang perlu dijeda. Tanpa
`hold` (mis. tombol **⚠ Putus paksa**), aturan pembatalan heartbeat di atas tetap berlaku.

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
- `/s/<id>?t=<tiket>` atau `/s/<id>?token=<ownerToken>` — halaman status; polling `GET /api/status` tiap **5 dtk**
  (2 dtk saat booting) dengan header **`X-Status-Token`** (aturan halaman: bukan `X-Bridge-Token`) membawa tiket
  sesi / ownerToken. Di bawah baris state ada baris kecil **Bukti: heartbeat 42 dtk lalu · daya 9 dtk lalu**
  (`belum ada` bila belum pernah) — umur bukti yang dipakai untuk menilai state.
  Tombol mengikuti `state` — `alive`: **⏻ Putus arus listrik** + **▶ Buka Adhitron** (memotong arus Bardi; Windows
  tidak dimatikan dari sini); `booting`/`suspected-alive`: hanya **⚠ Putus paksa**; `off`: **⚡ Nyalakan PC** +
  **⏻ Putus arus listrik**; `unknown`: **⚡ Nyalakan paksa** (konfirmasi, memakai
  `/api/on?force=1`). Penolakan **409** ditampilkan sebagai peringatan di halaman, bukan gagal diam-diam.
  Bila jadwal aktif dan daya ≤ 10 W: **⚫ PC sudah mati · ⏳ listrik diputus dalam m:ss**.
  Selama jeda 2 menit sesudah pemutusan, tombol **⚡ Nyalakan PC** / **⚡ Nyalakan paksa** dirender nonaktif dengan
  hitung mundur (`⚡ Nyalakan PC (1:57)`) plus catatan "Tunggu 2 menit setelah listrik diputus agar sisa daya di
  komputer habis."; hitung mundurnya berjalan tiap detik di browser dan tombol aktif sendiri saat mencapai 0.
  Di bawah tombol ada bagian **⚡ Listrik Bardi (realtime)**: kartu **daya aktif**, **tegangan**, **arus**
  (mA, atau A bila ≥ 1000 mA), dan **status plug** (`🔌 Plug ON/OFF`), tombol **↻ Refresh**, serta teks
  "diperbarui N dtk lalu". Datanya dari **satu** panggilan device status Tuya IoT Core (gratis) — tidak ada
  statistik Power Management yang berbayar. Halaman memanggil endpoint ini **hanya** saat dibuka, saat Refresh
  ditekan, dan 3× jeda 5 dtk setelah aksi daya; tidak ada polling energi tanpa henti (kuota Tuya ~26.000/bulan).
  Saat Bardi masih mengukur daya > 15 W, tombol pemutusan arus meminta **konfirmasi tambahan** karena PC
  kemungkinan masih hidup.

## Cron tiap menit (`scheduledSweep`)

Satu pass per tick, tidak pernah loop: untuk tiap space dengan `offAt` jatuh tempo —

1. `lastHeartbeat > offAtWrittenAt` (PC ternyata hidup lagi) → **batal**.
2. Else: plug **OFF** via Tuya, lalu verifikasi daya: `≤ 10 W` → sukses (jadwal dibersihkan, `attempts = 0`,
   `lastOffAt = now` sehingga tombol Nyalakan terkunci 2 menit); plug tanpa sensor daya → komando OFF dianggap sukses.
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
(`OFFICE_POWER_BEAT_MS` bisa menimpanya: integer milidetik ≥ 60000; nilai lebih kecil diabaikan). Saat pengguna
memilih **⏻ Matikan PC**, Adhitron hanya memanggil `POST /api/handoff?delay=<offDelaySec>` (tiket halaman status,
tanpa jadwal/plug), lalu menjalankan `shutdown /s /t 45` untuk Windows. Memutus arus Bardi dilakukan **manual**
dari halaman status (**⏻ Putus arus listrik**); heartbeat berhenti sendiri karena server ikut mati.

## Test

```bash
node --test --test-timeout=60000 "bridge/**/*.test.mjs"
```

**84 tes** (`node --test`), menggunakan fake fetch Tuya + fake Blobs - tanpa jaringan. Mencakup: register &
enkripsi (tidak ada plaintext di store), validasi kredensial ke Tuya sebelum menyimpan (422/503, pesan tanpa
kredensial), throttle 10/IP/hari, auth 401, jadwal off + tiket sekali pakai, pembatalan via heartbeat,
cron sukses / coba ulang / needsAttention / batal, `hold=1` (heartbeat tidak membatalkan "matikan rapi"), `/api/on` (409 saat PC masih hidup, `?force=1`, hapus jadwal),
**jeda 2 menit sesudah pemutusan** (`onCooldownSec`/`lastOffAt` di status, 409 + `retryAfterSec` untuk `/api/on` **dan** `?force=1`, cron mencatat `lastOffAt`, sampel 0 W lama dibuang sehingga status `booting` bukan `off`),
cap global 300 verifikasi/hari, error Tuya stabil (tanpa JSON mentah), status `state` + field umur heartbeat/daya,
heartbeat 3 mnt → `suspected-alive` tanpa tombol Putus arus, sampel daya 10 dtk (dua poll = satu panggilan Tuya), sampel daya gagal tidak dianggap segar, `standby` 10–15 W,
`GET /api/energy` (satu device status + cache 5 dtk, gagal → `ok:false` pesan generik), parsing DP lewat `id` tanpa `code`, halaman tidak bocorkan
kredensial, tombol per state, manage (update/validasi/rotasi/hapus), kode pasangan (8 karakter base32, hanya
sha256 di store, TTL 2 menit, sekali pakai, hanya ownerToken yang boleh membuat kode, satu kode aktif per
space, pesan 401 yang sama, 400 untuk body salah, throttle 20/IP/jam + 3000/jam total → 429, pembersihan cron).
