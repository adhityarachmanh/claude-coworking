# Remote power — jembatan daya jarak jauh (Netlify, multi-tenant)

Adhitron butuh **Claude Code CLI / OpenCode CLI** yang berjalan di PC-mu — dan PC yang mati listrik tidak bisa dijangkau dari jarak jauh. Jembatan ini menjembataninya: layanan kecil di **Netlify** (online 24 jam) yang bisa menyalakan dan memutus listrik PC-mu lewat **smart plug** (Bardi, Smart Life, dsb.) via **Tuya Cloud API**.

**Prinsip:** Adhitron tidak pernah tahu merek plug-mu. Ia hanya menyimpan **URL jembatan + token** dan berbicara ke kontrak endpoint di bawah.

```
HP / browser apa pun ──▶ jembatan (Netlify, online 24 jam) ──▶ Tuya Cloud API ──▶ smart plug ──▶ PC
                              ▲
                              └── heartbeat "PC hidup" dari Adhitron tiap 5 mnt
```

Cara kerja singkat:

1. **Nyalakan**: plug **ON** → BIOS *Restore on AC Power Loss = Power On* membuat PC boot sendiri. Plug yang sudah ON disikluskan OFF → ON agar BIOS mendapat kejadian listrik baru.
2. **Matikan**: pemicu menulis jadwal `offAt` (default 5 menit), lalu **cron tiap menit** mengeksekusinya — tetap tepat waktu walaupun PC (dan Adhitron) sudah mati.
3. **Status**: halaman status publik menampilkan 🟢 hidup / ⚫ mati / ⏳ countdown pemutusan, plus alur tunggu "Nyalakan PC → booting → 🟢 → ▶ Buka Adhitron" saat pertama menyalakan dari jauh.

## Dua jalur pemakaian

### a) Pakai jembatan operator (paling mudah)

Kalau operator jembatan (mis. pengembang Adhitron) sudah menjalankan situs jembatan:

1. Buka halaman pendaftaran situs jembatan (`/`), isi kredensial Tuya-mu sendiri (Access ID, Access Secret, Device ID, region) — lihat [Setup Tuya](#setup-tuya-bardi--smart-life). Kredensialmu **terenkripsi** di server; kamu mendapat **URL + token**.
2. Di Adhitron, buka **⚙ → Remote power** dan tempel: **URL** = bridgeUrl, **Token** = token.
3. Selesai. Adhitron mengirim heartbeat tiap 5 menit, dan tombol nyalakan/matikan jalan dari kantor/HP.

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
| `POST /api/heartbeat` | `X-Bridge-Token: <token>` | `{ ts, version }` — tiap ±5 menit (best-effort), tanpa data pribadi | `{ ok }` |
| `POST /api/on` | `X-Bridge-Token` / `X-Status-Token` | — (plug sudah ON → siklus OFF → ON) | `{ ok }` |
| `POST /api/off?delay=300` | `X-Bridge-Token` / `X-Status-Token` | delay 0–3600 dtk, default 300 — dijadwalkan, cron memutus tepat waktu | `{ ok, offAt, fired, handoffUrl }` |
| `GET /api/status` | `X-Bridge-Token` / `X-Status-Token` | — | status (di bawah) |

Kode error: token salah / tiket kedaluwarsa → **401**; body salah → **400**; kegagalan Tuya → **502**; register lebih dari 10 space/IP/hari → **429**.

`GET /api/status` →

```json
{
  "id": "1a2b3c4d", "alive": true,          // alive = heartbeat < 30 mnt
  "offAt": 1794..., "secondsUntilOff": 214, // jadwal pemutusan (null = tidak ada)
  "plug": "on",                             // asumsi terakhir dari perintah yang dikirim
  "powerW": 45.3, "powerAt": 1794...,       // sampel daya terakhir (1×/30 dtk — kuota Tuya)
  "booting": false,                         // powerW > 20 W ≥ 30 dtk && !alive
  "needsAttention": false,                  // ⚠ cron gagal memutus 3× — cek plug manual
  "lastHeartbeat": 1794..., "adhitronUrl": "https://nama.ts.net"
}
```

**Aturan pembatalan (kontrak heartbeat):** jika heartbeat datang ketika ada jadwal `offAt` di masa depan, jadwal **otomatis dibatalkan** (heartbeat = bukti PC hidup). Karena itu, saat memanggil `POST /api/off` (alur shutdown rapi) Adhitron **berhenti mengirim heartbeat** sampai shutdown selesai — kalau tidak, jadwalnya membatalkan dirinya sendiri.

## Halaman status & tiket serah-terima

- `POST /api/off` mengembalikan `handoffUrl` = `/s/<id>?t=<tiket>` — tiket **sekali pakai**, TTL 10 menit, untuk membuka halaman status dari HP **tanpa token jangka panjang**. Membukanya menghapus tiket dan membuat tiket sesi baru untuk polling (tiap 10 detik, header `X-Status-Token`).
- Halaman status menampilkan 🟢 hidup / ⚫ mati / ⏳ countdown, tombol **Nyalakan / Matikan rapi / Putus paksa**, daya Bardi (watt), dan peringatan **⚠ gagal memutus — cek plug manual** bila cron 3× gagal.
- Alur tunggu saat menyalakan dari jauh: **Nyalakan PC → booting → 🟢 → ▶ Buka Adhitron**.

## Keamanan

- Kredensial Tuya **tidak pernah plaintext**: AES-256-GCM, kunci `scrypt(tokenUser + ENCRYPTION_KEY, salt per-space)`; rotasi token ikut re-enkripsi. Adhitron hanya menyimpan URL jembatan + token.
- `ENCRYPTION_KEY` hidup di env var Netlify; tidak ada secret di kode.
- Register dibatasi 10 space per IP per hari; heartbeat ditulis maksimal 1×/menit per space.
- Jembatan tidak pernah mengekspos kredensial vendor dalam respons atau halaman apa pun.

Membangun jembatan sendiri dengan stack lain? Kontrak di atas adalah panduannya — endpoint dan semantiknya wajib sama.
