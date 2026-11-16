# Remote power — jembatan daya jarak jauh (Netlify, multi-tenant)

Adhitron butuh **Claude Code CLI / OpenCode CLI** yang berjalan di PC-mu — dan PC yang mati listrik tidak bisa dijangkau dari jarak jauh. Jembatan ini menjembataninya: layanan kecil di **Netlify** (online 24 jam) yang bisa menyalakan dan memutus listrik PC-mu lewat **smart plug** (Bardi, Smart Life, dsb.) via **Tuya Cloud API**.

**Prinsip:** Adhitron tidak pernah tahu merek plug-mu. Ia hanya menyimpan **URL jembatan + token** dan berbicara ke kontrak endpoint di bawah.

```
HP / browser apa pun ──▶ jembatan (Netlify, online 24 jam) ──▶ Tuya Cloud API ──▶ smart plug ──▶ PC
                              ▲
                              └── heartbeat "PC hidup" dari Adhitron tiap 2 mnt
```

Cara kerja singkat:

1. **Nyalakan**: plug **ON** → BIOS *Restore on AC Power Loss = Power On* membuat PC boot sendiri. Plug yang sudah ON disikluskan OFF → ON agar BIOS mendapat kejadian listrik baru.
2. **Matikan**: pemicu menulis jadwal `offAt` (default 5 menit), lalu **cron tiap menit** mengeksekusinya — tetap tepat waktu walaupun PC (dan Adhitron) sudah mati.
3. **Status**: halaman status publik menampilkan state eksplisit — 🟢 hidup / 🖥 booting / 🟡 kemungkinan hidup / 🟡 standby / ⚫ mati / ⚪ belum pasti — plus ⏳ countdown pemutusan dan tombol yang sesuai state, termasuk alur tunggu "Nyalakan PC → booting → 🟢 → ▶ Buka Adhitron" saat pertama menyalakan dari jauh. Listrik plug-nya juga dipantau realtime (daya, tegangan, arus, status saklar). Halaman memuat ulang status tiap **5 detik** (2 detik saat booting) dan menampilkan **umur bukti** ("Bukti: heartbeat 42 dtk lalu · daya 9 dtk lalu"). Sesudah listrik diputus — dari halaman, dari cron, maupun dari aplikasi Bardi — tombol **⚡ Nyalakan** terkunci **2 menit** (hitungan mundurnya tampil di tombol) supaya sisa daya di PSU habis dulu.

## Dua jalur pemakaian

### a) Pakai jembatan operator (paling mudah)

Kalau operator jembatan (mis. pengembang Adhitron) sudah menjalankan situs jembatan:

1. Buka halaman pendaftaran situs jembatan (`/`), isi kredensial Tuya-mu sendiri (Access ID, Access Secret, Device ID, region) — lihat [Setup Tuya](#setup-tuya-bardi--smart-life). Kredensialmu **dicek langsung ke Tuya sebelum disimpan** (read-only, tanpa perintah apa pun), lalu **terenkripsi** di server; kamu mendapat **URL + token**. Kalau Tuya menolak, pendaftaran berhenti dengan alasan yang jelas dan tidak ada data yang tersimpan.
2. Di Adhitron, buka **⚙ → Remote power** dan tempel: **URL** = bridgeUrl, **Token** = token.
3. Selesai. Adhitron mengirim heartbeat tiap 2 menit (beat pertama langsung saat server siap). **⏻ Matikan PC** di Adhitron mematikan Windows; menyalakan PC dan memutus arus Bardi dilakukan dari halaman status jembatan.

### b) Jadi operator sendiri (deploy jembatanmu sendiri)

Ingin mengendalikan penuh? Deploy folder `bridge/` ke Netlify sendiri:

1. Buat situs Netlify dari folder `bridge/` — mis. `netlify deploy --dir bridge`, atau import repo dengan *base directory* `bridge/`. Tanpa build step.
2. Set env var di Netlify UI (Site configuration → Environment variables):
   - `ENCRYPTION_KEY` — **wajib**, 32-byte hex (64 karakter), mis. `openssl rand -hex 32`. Kredensial user dienkripsi AES-256-GCM dengan kunci `scrypt(tokenUser + ENCRYPTION_KEY, salt)`; tanpa ini pendaftaran space menolak.
3. Deploy. Cron potong listrik tiap menit otomatis aktif pada deploy produksi. Blobs store `adhitron-bridge` dibuat otomatis pada pemakaian pertama.
4. Daftarkan space lewat halaman `/` situsmu, lalu tempel URL + token di ⚙ Adhitron (jalur a).

Detail lengkap deploy, struktur kode, anti-abuse, dan pengelolaan space (rotasi token, hapus space): **[bridge/README.md](../bridge/README.md)**.

## Setup Tuya (Bardi / Smart Life)

1. Daftar di [iot.tuya.com](https://iot.tuya.com) dan buat **Cloud Project**. Pilih **data center** yang sesuai akun Smart Life-mu (kredensial hanya valid di DC itu); kalau ragu, bridge mendeteksinya otomatis.
2. Salin **Access ID** (= Client ID) dan **Access Secret**.
3. Tautkan akun **Smart Life** yang berisi plug (Devices → Link Smart Life).
4. Cari **Device ID** plug-nya.

Data center yang didukung: `eu` (Eropa Tengah), `eu-west` (Eropa Barat), `america` (Amerika Barat), `us-east` (Amerika Timur), `asia` (Tiongkok), `india`, `singapore` — alias lama `us`/`cn`/`sg`/`in` dikanonisasi otomatis. Salah pilih region tidak menggagalkan pendaftaran: bridge mencoba ketujuhnya secara paralel (read-only) dan menyimpan yang benar.

## Checklist di sisi PC (wajib sekali)

- **BIOS**: *Restore on AC Power Loss = Power On* — inilah yang membuat PC menyala sendiri saat plug mendapat listrik.
- **Windows autostart**: Adhitron harus menyala otomatis saat login, jadi PC yang baru boot langsung siap dijangkau. Kalau PC sering di-reboot dari jauh dan tidak ada orang di depannya, nyalakan mode **🔐 Akses saat PC terkunci** di ⚙ → Sistem (autologon + layar terkunci) — lihat [README → Sebelum login Windows](../README.md#sebelum-login-windows-opsional).

## Kontrak API (Adhitron ↔ jembatan)

Semua respons JSON. Auth API **hanya lewat header** (query `?token=` hanya untuk halaman HTML):

| Endpoint | Header | Body / query | Respons |
|---|---|---|---|
| `POST /api/heartbeat` | `X-Bridge-Token: <token>` | `{ ts, version }` — tiap 2 menit (best-effort), tanpa data pribadi | `{ ok }` |
| `POST /api/on` | `X-Bridge-Token` / `X-Status-Token` | `?force=1` untuk memaksa siklus OFF → ON | `{ ok }` — PC masih hidup tanpa `force` → **409**; ≤ 2 menit sesudah pemutusan → **409** + `retryAfterSec` (berlaku juga untuk `force`) |
| `POST /api/off?delay=300[&hold=1]` | `X-Bridge-Token` / `X-Status-Token` | delay 0–3600 dtk (kosong = `offDelaySec` dari handoff, default 300); `hold=1` = kebal pembatalan heartbeat (tombol "Putus arus") | `{ ok, offAt, fired, handoffUrl }` |
| `POST /api/off/cancel` | `X-Bridge-Token` / `X-Status-Token` | — | `{ ok, cancelled }` — hapus jadwal tanpa menyentuh plug |
| `POST /api/handoff[?delay=N]` | `X-Bridge-Token` / `X-Status-Token` | delay 0–3600 dtk (opsional) | `{ ok, handoffUrl, offDelaySec }` — tiket halaman status, tanpa jadwal/plug |
| `GET /api/status` | `X-Bridge-Token` / `X-Status-Token` | — | status (di bawah) |
| `GET /api/energy` | `X-Bridge-Token` / `X-Status-Token` | — (tanpa `range`/`tz`) | `{ ok, now:{powerW,voltageV,currentMa}, switchOn, energyKwh, updatedAt }`; `{ ok:false, error }` dengan pesan generik bila Tuya gagal |

Hanya **endpoint IoT Core gratis** yang dipakai: `GET /v1.0/devices/{id}/status` dan `POST /v1.0/devices/{id}/commands`. Endpoint statistik energi Power Management (`/v1.0/iot-03/energy/electricity/...`) **sudah dihapus** dari jembatan karena akun ini tidak punya izin memakainya — tidak ada satu pun panggilan ke sana, jadi tidak ada lagi bagian yang gagal karena izin API.

Kode error: token salah / tiket kedaluwarsa → **401**; body salah → **400**; PC masih hidup pada `POST /api/on` tanpa `force` → **409**; `POST /api/on` dalam 2 menit sesudah listrik diputus → **409** + `retryAfterSec`; kredensial Tuya ditolak → **422** (register) / **400** (manage); Tuya tak terjangkau, kuota, atau cap **300 verifikasi/hari** → **503**; register lebih dari 10 space/IP/hari → **429**.

**Menyalakan PC yang masih hidup ditolak.** `POST /api/on` tanpa `?force=1` menjawab **409** `{ "error": "PC sepertinya masih hidup — listrik tidak disiklus. Kirim ?force=1 kalau yakin." }` dan **tidak memanggil Tuya** sama sekali — supaya PC yang sedang hidup tidak mati mendadak karena siklus OFF → ON. `?force=1` memaksa siklus itu (dipakai tombol **⚡ Nyalakan paksa** pada state `unknown`).

**Jeda 2 menit sesudah pemutusan.** Begitu listrik benar-benar diputus (`lastOffAt` terisi), `POST /api/on` **dan** `POST /api/on?force=1` dijawab **409** `{ "error": "Listrik baru diputus — tunggu N dtk lagi, …", "retryAfterSec": N }` + header `Retry-After`, tanpa memanggil Tuya — sisa daya di PSU harus habis dulu sebelum plug dinyalakan lagi (batas fisik, jadi `force` tidak membukanya). Jeda ini berlaku untuk **semua** pemutusan: `POST /api/off?delay=0`, cron, dan plug yang dimatikan dari aplikasi Bardi/Smart Life (transisi `switchOn` → false saat sampling).

**Kredensial dicek sebelum disimpan.** Pendaftaran (`POST /api/space`) memanggil Tuya — token + `GET /v1.0/devices/{deviceId}/status`, read-only dengan timeout 5 dtk — **sebelum** menyimpan apa pun dan tanpa `/commands`. Ditolak → **422** (`Client ID/Secret atau region ditolak Tuya.` / `Device ID tidak ada di project ini (pastikan akun Smart Life sudah di-link).` / `Device ini bukan smart plug dengan saklar.`); Tuya tak terjangkau atau timeout → **503** `Tidak bisa menghubungi Tuya Cloud, coba lagi.`. Tidak ada record, index token, atau tiket yang tersimpan saat gagal; pesan error tidak memuat Client ID/Secret/Device ID. Update di `/manage` memvalidasi **kredensial efektif** (secret lama dipakai bila kolom secret kosong) dengan hasil yang sama: ditolak → **400**, jaringan → **503**, setelan lama dipertahankan. Selain throttle 10 pendaftaran/IP/hari, ada **cap global 300 verifikasi kredensial per hari** (lintas IP) supaya kuota Tuya operator tidak bisa dihabiskan dari banyak IP; bila terlampaui → **503** `Batas verifikasi harian situs tercapai, coba besok.`

`GET /api/status` →

```json
{
  "id": "1a2b3c4d", "alive": true,          // alive = ada bukti segar PC hidup (lihat tabel state)
  "state": "alive",                         // alive | booting | suspected-alive | standby | off | unknown
  "heartbeatFresh": true, "powerFresh": true, // heartbeat < 4 mnt · sampel daya < 90 dtk
  "heartbeatAgeSec": 41, "powerAgeSec": 12,   // null = belum pernah ada
  "offAt": 1794..., "secondsUntilOff": 214, // jadwal pemutusan (null = tidak ada)
  "offDelaySec": 120,                       // jeda tombol Putus arus di halaman (dari handoff)
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
| `alive` | heartbeat < **2,5 mnt**, atau sampel daya segar > 15 W dengan heartbeat < 2,5 mnt — kecuali saklar `switch_1 === false` atau sampel segar ≤ 10 W (bukti listrik menang) | PC hidup |
| `booting` | daya > 15 W ≥ 30 dtk, heartbeat basi — **atau** baru diperintah `POST /api/on` dan belum ada sampel daya baru (jendela 3 mnt: sampel lama dibuang, jadi tidak pernah jatuh ke `off`) | PC booting — atau beku |
| `suspected-alive` | daya > 15 W segar, heartbeat basi, < 30 dtk — **atau** heartbeat 2,5–4 mnt tanpa bukti daya segar (kabar PC sudah berhenti) | kemungkinan hidup, bukti belum cukup — tombol **Putus arus listrik** tidak ditawarkan |
| `standby` | sampel daya segar 10–15 W — mengalahkan heartbeat segar sekalipun | standby / baru dinyalakan, belum bisa dijangkau — **tidak** dihitung hidup |
| `off` | `switchOn === false`, sampel daya segar ≤ 10 W, atau plug tercatat OFF tanpa heartbeat segar dan tanpa jadwal menunggu | PC mati |
| `unknown` | tidak ada bukti segar | belum pasti |

`heartbeatFresh` tetap berarti "heartbeat < 4 menit" (kontrak lama) — tetapi `alive` hanya diberikan bila heartbeat lebih muda dari **2,5 menit**. Kabar yang berumur 2,5–4 menit tanpa bukti daya segar menjadi `suspected-alive`, supaya tombol "Putus arus listrik" hilang setelah PC tak lagi berkabar (PC yang sudah mati tidak bisa dimatikan Windows-nya dari halaman).

Pembacaan listrik dan saklar memakai **satu** panggilan `GET /v1.0/devices/{id}/status` (IoT Core, gratis). Parsing DP-nya cocok lewat `code` maupun nomor DP `id`, karena firmware Bardi kadang hanya mengirim salah satunya:

| DP | Skala | Arti |
|---|---|---|
| `switch_1` (1) | boolean / 0–1 | saklar plug |
| `cur_power` (19) | ÷ 10 → W | daya aktif |
| `cur_voltage` (20) | ÷ 10 → V | tegangan |
| `cur_current` (18) | mA | arus |
| `add_ele` (17) | ÷ 100 → kWh | pemakaian kumulatif |

Field yang tidak dilaporkan plug menjadi `null`, bukan error — plug tanpa sensor daya tetap bisa dinyalakan/dimatikan.

Percobaan sampel daya dibatasi **10 dtk** (halaman memuat status tiap 5 dtk), tetapi `powerAt` hanya maju bila pembacaan Tuya berhasil — sampel gagal tetap terlihat basi, jadi status tidak pernah "bohong" karena sampel lama. `POST /api/on` yang berhasil **membuang sampel lama** (`powerW = null`, `powerAt = 0`, `powerTryAt = 0`) dan mencatat `turnedOnAt`: sesudah itu statusnya `booting` sampai ada sampel daya baru, bukan `off` dari angka 0 W sebelum PC dinyalakan.

**Aturan pembatalan (kontrak heartbeat):** jika heartbeat datang ketika ada jadwal `offAt` di masa depan, jadwal **otomatis dibatalkan** (heartbeat = bukti PC hidup). Tombol **⏻ Putus arus listrik** di halaman memakai `hold=1`, sehingga heartbeat **tidak** membatalkan jadwal itu; `POST /api/on` atau tombol **✕ Batalkan jadwal** (`POST /api/off/cancel`, tanpa menyentuh plug) yang membatalkannya. Listrik tetap dipotong setelah delay bila tidak dibatalkan. Adhitron **tidak lagi menjadwalkan pemutusan** dari aplikasi — "⏻ Matikan PC" hanya mematikan Windows lalu membuka halaman status lewat `POST /api/handoff`.

## Halaman status & tiket serah-terima

- `POST /api/off` dan `POST /api/handoff` mengembalikan `handoffUrl` = `/s/<id>?t=<tiket>` — tiket **sekali pakai**, TTL 10 menit, untuk membuka halaman status dari HP **tanpa token jangka panjang**. `handoff` hanya membuat tiket (tanpa jadwal/plug) dan dipakai Adhitron setelah Windows dimatikan; delay yang dikirim disimpan untuk tombol Putus arus. Membuka tiket menghapusnya dan membuat tiket sesi baru untuk polling (tiap **5 detik**, 2 detik saat booting; header `X-Status-Token`).
- Halaman status menampilkan state dan tombol yang sesuai: **alive** → 🟢 PC hidup + **⏻ Putus arus listrik** dan **▶ Buka Adhitron** (arus Bardi; Windows tidak dimatikan dari sini); **booting**/**standby**/**suspected-alive** → hanya **⚠ Putus paksa**; **off** → **⚡ Nyalakan PC** + **⏻ Putus arus listrik**; **unknown** → **⚡ Nyalakan paksa** (konfirmasi, menyiklus listrik). Countdown **⏳ listrik diputus dalam m:ss** tetap tampil; bila jadwal aktif dan daya ≤ 10 W, barisnya menjadi **⚫ PC sudah mati · ⏳ listrik diputus dalam m:ss**. Penolakan server (mis. **409**) tampil sebagai peringatan di halaman, bukan gagal diam-diam.
- Di bawah baris state ada baris kecil **Bukti: heartbeat 42 dtk lalu · daya 9 dtk lalu** (`belum ada` bila belum pernah) supaya kelihatan seberapa segar bukti yang dipakai.
- Selama jeda 2 menit sesudah pemutusan, tombol **⚡ Nyalakan PC** / **⚡ Nyalakan paksa** dirender nonaktif dengan hitung mundur (`⚡ Nyalakan PC (1:57)`) plus catatan "Tunggu 2 menit setelah listrik diputus agar sisa daya di komputer habis." Hitung mundurnya berjalan tiap detik di browser dan tombol aktif sendiri saat mencapai 0 tanpa menunggu poll; server tetap menolak dengan **409** bila dipaksa.
- Halaman menampilkan peringatan **⚠ gagal memutus — cek plug manual** bila cron 3× gagal.
- Bagian **⚡ Listrik Bardi** adalah monitoring realtime: kartu **daya aktif** (W), **tegangan** (V), **arus** (mA, atau A bila ≥ 1000 mA), **status plug** (`🔌 Plug ON/OFF`), tombol **↻ Refresh**, dan teks "diperbarui N dtk lalu". Datanya dari `GET /api/energy` — satu panggilan device status Tuya IoT Core (gratis) dengan cache 5 detik. Tab **7 hari / 12 bulan** sudah dihapus, karena statistiknya butuh API Power Management yang tidak tersedia untuk akun ini. Halaman memanggil endpoint itu **hanya** saat dibuka, saat **↻ Refresh**, dan 3× jeda 5 detik setelah aksi daya — tidak ada polling tanpa henti, supaya kuota Tuya tidak habis. Saat Bardi masih mengukur daya > 15 W, tombol pemutusan arus meminta **konfirmasi tambahan** karena PC kemungkinan masih hidup.
- Alur tunggu saat menyalakan dari jauh: **Nyalakan PC → booting → 🟢 → ▶ Buka Adhitron**.

## Keamanan

- Kredensial Tuya **tidak pernah plaintext**: AES-256-GCM, kunci `scrypt(tokenUser + ENCRYPTION_KEY, salt per-space)`; rotasi token ikut re-enkripsi. Adhitron hanya menyimpan URL jembatan + token.
- `ENCRYPTION_KEY` hidup di env var Netlify; tidak ada secret di kode.
- Register dibatasi 10 space per IP per hari; heartbeat ditulis maksimal 1×/menit per space.
- Jembatan tidak pernah mengekspos kredensial vendor dalam respons atau halaman apa pun.

Membangun jembatan sendiri dengan stack lain? Kontrak di atas adalah panduannya — endpoint dan semantiknya wajib sama.
