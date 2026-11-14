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
3. **Status**: halaman status publik menampilkan state eksplisit — 🟢 hidup / 🖥 booting / 🟡 kemungkinan hidup / ⚫ mati / ⚪ belum pasti — plus ⏳ countdown pemutusan dan tombol yang sesuai state, termasuk alur tunggu "Nyalakan PC → booting → 🟢 → ▶ Buka Adhitron" saat pertama menyalakan dari jauh.

## Dua jalur pemakaian

### a) Pakai jembatan operator (paling mudah)

Kalau operator jembatan (mis. pengembang Adhitron) sudah menjalankan situs jembatan:

1. Buka halaman pendaftaran situs jembatan (`/`), isi kredensial Tuya-mu sendiri (Access ID, Access Secret, Device ID, region) — lihat [Setup Tuya](#setup-tuya-bardi--smart-life). Kredensialmu **dicek langsung ke Tuya sebelum disimpan** (read-only, tanpa perintah apa pun), lalu **terenkripsi** di server; kamu mendapat **URL + token**. Kalau Tuya menolak, pendaftaran berhenti dengan alasan yang jelas dan tidak ada data yang tersimpan.
2. Di Adhitron, buka **⚙ → Remote power** dan tempel: **URL** = bridgeUrl, **Token** = token.
3. Selesai. Adhitron mengirim heartbeat tiap 2 menit (beat pertama langsung saat server siap), dan tombol nyalakan/matikan jalan dari kantor/HP.

### b) Jadi operator sendiri (deploy jembatanmu sendiri)

Ingin mengendalikan penuh? Deploy folder `bridge/` ke Netlify sendiri:

1. Buat situs Netlify dari folder `bridge/` — mis. `netlify deploy --dir bridge`, atau import repo dengan *base directory* `bridge/`. Tanpa build step.
2. Set env var di Netlify UI (Site configuration → Environment variables):
   - `ENCRYPTION_KEY` — **wajib**, 32-byte hex (64 karakter), mis. `openssl rand -hex 32`. Kredensial user dienkripsi AES-256-GCM dengan kunci `scrypt(tokenUser + ENCRYPTION_KEY, salt)`; tanpa ini pendaftaran space menolak.
3. Deploy. Cron potong listrik tiap menit otomatis aktif pada deploy produksi. Blobs store `adhitron-bridge` dibuat otomatis pada pemakaian pertama.
4. Daftarkan space lewat halaman `/` situsmu, lalu tempel URL + token di ⚙ Adhitron (jalur a).

Detail lengkap deploy, struktur kode, anti-abuse, dan pengelolaan space (rotasi token, hapus space): **[bridge/README.md](../bridge/README.md)**.

## Setup Tuya (Bardi / Smart Life)

1. Daftar di [iot.tuya.com](https://iot.tuya.com) (region sesuai app — Indonesia biasanya **eu**), buat **Cloud Project**.
2. Salin **Access ID** (= Client ID) dan **Access Secret**.
3. Tautkan akun **Smart Life** yang berisi plug (Devices → Link Smart Life).
4. Cari **Device ID** plug-nya.

Region yang diterima jembatan: `eu`, `america`, `asia` (alias portal lama `us`/`cn` dikanonisasi otomatis).

## Checklist di sisi PC (wajib sekali)

- **BIOS**: *Restore on AC Power Loss = Power On* — inilah yang membuat PC menyala sendiri saat plug mendapat listrik.
- **Windows autostart**: Adhitron harus menyala otomatis saat login, jadi PC yang baru boot langsung siap dijangkau.

## Kontrak API (Adhitron ↔ jembatan)

Semua respons JSON. Auth API **hanya lewat header** (query `?token=` hanya untuk halaman HTML):

| Endpoint | Header | Body / query | Respons |
|---|---|---|---|
| `POST /api/heartbeat` | `X-Bridge-Token: <token>` | `{ ts, version }` — tiap 2 menit (best-effort), tanpa data pribadi | `{ ok }` |
| `POST /api/on` | `X-Bridge-Token` / `X-Status-Token` | `?force=1` untuk memaksa siklus OFF → ON | `{ ok }` — PC masih hidup tanpa `force` → **409** |
| `POST /api/off?delay=300[&hold=1]` | `X-Bridge-Token` / `X-Status-Token` | delay 0–3600 dtk, default 300 — dijadwalkan, cron memutus tepat waktu; `hold=1` = kebal pembatalan heartbeat (tombol "Matikan PC rapi") | `{ ok, offAt, fired, handoffUrl }` |
| `POST /api/off/cancel` | `X-Bridge-Token` / `X-Status-Token` | — | `{ ok, cancelled }` — hapus jadwal tanpa menyentuh plug |
| `GET /api/status` | `X-Bridge-Token` / `X-Status-Token` | — | status (di bawah) |

Kode error: token salah / tiket kedaluwarsa → **401**; body salah → **400**; PC masih hidup pada `POST /api/on` tanpa `force` → **409**; kredensial Tuya ditolak → **422** (register) / **400** (manage); Tuya tak terjangkau, kuota, atau cap **300 verifikasi/hari** → **503**; register lebih dari 10 space/IP/hari → **429**.

**Menyalakan PC yang masih hidup ditolak.** `POST /api/on` tanpa `?force=1` menjawab **409** `{ "error": "PC sepertinya masih hidup — listrik tidak disiklus. Kirim ?force=1 kalau yakin." }` dan **tidak memanggil Tuya** sama sekali — supaya PC yang sedang hidup tidak mati mendadak karena siklus OFF → ON. `?force=1` memaksa siklus itu (dipakai tombol **⚡ Nyalakan paksa** pada state `unknown`).

**Kredensial dicek sebelum disimpan.** Pendaftaran (`POST /api/space`) memanggil Tuya — token + `GET /v1.0/devices/{deviceId}/status`, read-only dengan timeout 5 dtk — **sebelum** menyimpan apa pun dan tanpa `/commands`. Ditolak → **422** (`Client ID/Secret atau region ditolak Tuya.` / `Device ID tidak ada di project ini (pastikan akun Smart Life sudah di-link).` / `Device ini bukan smart plug dengan saklar.`); Tuya tak terjangkau atau timeout → **503** `Tidak bisa menghubungi Tuya Cloud, coba lagi.`. Tidak ada record, index token, atau tiket yang tersimpan saat gagal; pesan error tidak memuat Client ID/Secret/Device ID. Update di `/manage` memvalidasi **kredensial efektif** (secret lama dipakai bila kolom secret kosong) dengan hasil yang sama: ditolak → **400**, jaringan → **503**, setelan lama dipertahankan. Selain throttle 10 pendaftaran/IP/hari, ada **cap global 300 verifikasi kredensial per hari** (lintas IP) supaya kuota Tuya operator tidak bisa dihabiskan dari banyak IP; bila terlampaui → **503** `Batas verifikasi harian situs tercapai, coba besok.`

`GET /api/status` →

```json
{
  "id": "1a2b3c4d", "alive": true,          // alive = heartbeat segar ATAU daya segar > 20 W
  "state": "alive",                         // alive | booting | suspected-alive | off | unknown
  "heartbeatFresh": true, "powerFresh": true, // heartbeat < 7 mnt · sampel daya < 90 dtk
  "heartbeatAgeSec": 41, "powerAgeSec": 12,   // null = belum pernah ada
  "offAt": 1794..., "secondsUntilOff": 214, // jadwal pemutusan (null = tidak ada)
  "plug": "on",                             // asumsi terakhir dari perintah yang dikirim
  "powerW": 45.3, "powerAt": 1794...,       // sampel daya terakhir yang berhasil (percobaan 1×/30 dtk)
  "booting": false,                         // daya > 20 W ≥ 30 dtk tanpa heartbeat segar
  "needsAttention": false,                  // ⚠ cron gagal memutus 3× — cek plug manual
  "lastHeartbeat": 1794..., "adhitronUrl": "https://nama.ts.net"
}
```

| `state` | Bukti | Arti |
|---|---|---|
| `alive` | heartbeat < 7 mnt, atau daya segar > 20 W - kecuali sampel segar ≤ 5 W (bukti listrik menang) | PC hidup |
| `booting` | daya > 20 W ≥ 30 dtk, heartbeat basi | booting — atau beku |
| `suspected-alive` | daya > 20 W segar, heartbeat basi, < 30 dtk | kemungkinan hidup |
| `off` | daya ≤ 5 W segar, atau plug OFF tanpa heartbeat segar | PC mati |
| `unknown` | tidak ada bukti segar | belum pasti |

Percobaan sampel daya dibatasi 30 dtk, tetapi `powerAt` hanya maju bila pembacaan Tuya berhasil — sampel gagal tetap terlihat basi, jadi status tidak pernah "bohong" karena sampel lama.

**Aturan pembatalan (kontrak heartbeat):** jika heartbeat datang ketika ada jadwal `offAt` di masa depan, jadwal **otomatis dibatalkan** (heartbeat = bukti PC hidup). Karena itu, saat memanggil `POST /api/off` (alur shutdown rapi) Adhitron **berhenti mengirim heartbeat 12 menit** sejak permintaan shutdown lalu melanjutkannya sendiri - kalau tidak, jadwalnya membatalkan dirinya sendiri. Pengecualian: tombol **⏻ Matikan PC rapi** di halaman status memakai `hold=1`, sehingga heartbeat **tidak** membatalkan jadwal itu; `POST /api/on` atau tombol **✕ Batalkan jadwal** (`POST /api/off/cancel`, tanpa menyentuh plug) yang membatalkannya. Listrik tetap dipotong setelah delay bila tidak dibatalkan.

## Halaman status & tiket serah-terima

- `POST /api/off` mengembalikan `handoffUrl` = `/s/<id>?t=<tiket>` — tiket **sekali pakai**, TTL 10 menit, untuk membuka halaman status dari HP **tanpa token jangka panjang**. Membukanya menghapus tiket dan membuat tiket sesi baru untuk polling (tiap 10 detik, header `X-Status-Token`).
- Halaman status menampilkan state dan tombol yang sesuai: **alive** → 🟢 PC hidup + **⏻ Matikan PC rapi** dan **▶ Buka Adhitron**; **booting**/**suspected-alive** → hanya **⚠ Putus paksa**; **off** → **⚡ Nyalakan PC**; **unknown** → **⚡ Nyalakan paksa** (konfirmasi, menyiklus listrik). Countdown **⏳ listrik diputus dalam m:ss** tetap tampil; bila jadwal aktif dan daya ≤ 5 W, barisnya menjadi **⚫ PC sudah mati · ⏳ listrik diputus dalam m:ss**. Penolakan server (mis. **409**) tampil sebagai peringatan di halaman, bukan gagal diam-diam.
- Halaman juga menampilkan daya plug (watt) dan peringatan **⚠ gagal memutus — cek plug manual** bila cron 3× gagal.
- Alur tunggu saat menyalakan dari jauh: **Nyalakan PC → booting → 🟢 → ▶ Buka Adhitron**.

## Keamanan

- Kredensial Tuya **tidak pernah plaintext**: AES-256-GCM, kunci `scrypt(tokenUser + ENCRYPTION_KEY, salt per-space)`; rotasi token ikut re-enkripsi. Adhitron hanya menyimpan URL jembatan + token.
- `ENCRYPTION_KEY` hidup di env var Netlify; tidak ada secret di kode.
- Register dibatasi 10 space per IP per hari; heartbeat ditulis maksimal 1×/menit per space.
- Jembatan tidak pernah mengekspos kredensial vendor dalam respons atau halaman apa pun.

Membangun jembatan sendiri dengan stack lain? Kontrak di atas adalah panduannya — endpoint dan semantiknya wajib sama.
