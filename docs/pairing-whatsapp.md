# WhatsApp untuk PIN pairing HP

Halaman `/pair` punya dua jalur masuk:

1. **📲 Kirim PIN ke WhatsApp** — PIN 6 digit dikirim ke WhatsApp-mu, jadi HP bisa dipasangkan walau tidak ada
   yang duduk di depan laptop.
2. **Punya kode 6 digit dari layar laptop?** — jalur bawaan, terlipat di bawah. **Tanpa setup apa pun.**

Dokumen ini menjelaskan cara menautkan WhatsApp dari dalam aplikasi, batas keamanan PIN, dan cara mengatasinya
kalau PIN tidak datang. Ringkasan akses HP ada di [README → Dari HP](../README.md#dari-hp).

```
HP ──▶ /pair ──▶ server Adhitron (WhatsApp di dalam proses) ──▶ WhatsApp ──▶ HP pemilik
                      │
                      └── PIN: hanya HMAC di memori, 5 menit, 3 percobaan, sekali pakai
```

Tidak ada Docker, gateway terpisah, atau environment variable. WhatsApp berjalan di dalam server Adhitron.

## Menautkan WhatsApp

**Dari HP, tanpa QR (bisa diremote lewat Tailscale):**

1. Buka **⚙ Setelan** → **📱 PIN ke HP** → pilih **WhatsApp**.
2. Di kolom **"Atau tautkan dari HP tanpa QR"**, tulis nomor WhatsApp lengkap dengan kode negara (mis. `628123456789`).
3. Tekan **Minta kode tautan** → muncul kode 8 karakter.
4. Di HP: **WhatsApp** → **Perangkat tertaut** → **Tautkan dengan nomor telepon**, lalu ketik kode itu.
5. Status menjadi *Tertaut.* Tekan **Tes** untuk mengirim pesan uji, atau **Lepas** untuk memutus tautan.

**Dari laptop, dengan QR** (sekali saja): pilih **WhatsApp** → **Tautkan** → status *Menghubungkan…* → **kode QR**
muncul → di HP: **Perangkat tertaut** → **Tautkan perangkat** → pindai.

Kode QR tidak pernah dikirim ke perangkat lain: `GET /api/wa/status` dari HP/Tailscale mengembalikan keadaan
(`off`, `qr`, `connecting`, `linked`) tanpa gambar QR, dan event status ke perangkat lain juga tanpa QR/nomor. Kode
tautan (pairing code) boleh dibuat dari HP — itu satu-satunya cara menautkan tanpa memindai layar laptop.

Kalau QR sudah lebih dari satu menit, gambar disembunyikan dan server memutar kode baru; tidak perlu memuat
ulang halaman. Tombol **Tautkan** berubah menjadi **Batal** selama menunggu pindai.

## Ke mana PIN dikirim

PIN dikirim ke **nomor WhatsApp yang baru ditautkan** — nomormu sendiri. Tidak ada kolom nomor tujuan yang
perlu diisi. Karena itu, tautkan nomor yang memang kamu pegang; nomor itu yang akan menerima PIN pairing
berikutnya.

## Kalau tidak menautkan WhatsApp

Jalur **kode 6 digit dari layar laptop** tetap ada dan tetap menjadi bawaan. Tanpa menautkan WhatsApp:

- halaman `/pair` menampilkan form kode (bukan tombol PIN yang menunggu tanpa ujung);
- permintaan PIN menjawab **503** `WhatsApp belum ditautkan.`
- saat HP meminta masuk, kode 6 digit tampil di layar laptop.

## Di mana sesinya disimpan

| Berkas | Isi |
|---|---|
| `data/wa/session.bin` | sesi WhatsApp (kredensial + kunci enkripsi pesan), **terenkripsi** AES-256-GCM |
| `data/wa/key` | kunci 32 byte untuk membuka sesi, di folder `data/` milik user Windows ini (izin folder, bukan mode file: Windows mengabaikan `0600`) |

- Kunci **tidak pernah** dikirim ke perangkat mana pun, tidak masuk respons API, tidak masuk log.
- Kunci ada **di folder yang sama** dengan data terenkripsinya: enkripsi menolong bila hanya satu file yang bocor,
  bukan bila seluruh folder `data/` (atau salinan cloud-nya) tersalin. Jangan sinkronkan `data/`.
- Folder sesi **tidak ikut backup** dan tidak ditampilkan ke HP.
- **Lepas** menghapus seluruh folder sesi (juga bila WhatsApp tidak menjawab); tautkan ulang berarti memindai QR lagi.
- Kalau file sesi rusak atau diubah, aplikasi menolak membukanya (tidak menimpa diam-diam) dan menyuruh
  **Lepas** lalu memindai ulang.

## Kalau perangkat dicabut dari HP

Kalau kamu menghapus Adhitron dari **Perangkat tertaut** di WhatsApp:

- status di ⚙ berubah menjadi *Belum ditautkan.* dan sesi di laptop ikut dihapus (kredensial itu tidak bisa
  dipakai lagi);
- permintaan PIN menjawab **503** `WhatsApp belum ditautkan.`;
- halaman `/pair` otomatis menyuruh memakai **kode 6 digit dari layar laptop**;
- untuk memakai PIN lagi, tautkan ulang lewat **Tautkan** → pindai QR.

## Batas keamanan PIN

| Aturan | Nilainya |
|---|---|
| Umur PIN | 5 menit |
| Percobaan | 3 kali salah → PIN hangus, harus minta baru |
| Pemakaian | Sekali pakai; verifikasi kedua dengan PIN yang sama selalu gagal |
| PIN yang masih hidup | Bisa lebih dari satu (satu per browser): PIN baru **tidak** membatalkan pesan WhatsApp lama yang belum kedaluwarsa |
| Terikat perangkat | Hanya browser yang meminta PIN (cookie `office_pin`) yang bisa memverifikasinya |
| Jeda minta ulang | 1×/60 detik |
| Batas per jam | 5 permintaan, dan 3 permintaan per alamat IP |
| Salah beruntun | 8 PIN salah dalam sejam → permintaan dijeda 15 menit |
| Setelah gagal kirim | Jeda 10 detik sebelum minta lagi; kuota jam tidak terpakai |
| Yang disimpan | HMAC-SHA256 dengan kunci acak per proses (di memori), plus alamat IP dan User-Agent peminta (plaintext di memori, tidak ke disk/log) |
| Yang tidak pernah keluar | PIN itu sendiri — tidak di respons API, halaman, atau log |

PIN juga **langsung dibuang** saat akses HP dimatikan atau satu perangkat dicabut: keputusan pemilik tidak
boleh menyisakan PIN yang masih bisa dipakai.

## API

### WhatsApp (khusus laptop)

| Endpoint | Body | Respons sukses |
|---|---|---|
| `GET /api/wa/status` | – | `{ state, qr, me }`; `state`: `off` \| `qr` \| `connecting` \| `linked` |
| `POST /api/wa/status` | – | Sama dengan `GET` (dipakai halaman yang hanya bisa POST) |
| `POST /api/wa/link` | – | Status yang sama; `connecting` sampai QR pertama muncul. Idempoten |
| `POST /api/wa/unlink` | – | `{ ok: true }`; sesi dihapus |
| `POST /api/wa/test` | – | `{ ok: true }`; pesan uji ke nomor yang tertaut |

Kode error:

| Status | Arti |
|---|---|
| **403** | Dipanggil dari HP atau Tailscale (`Pengaturan ini hanya bisa diubah dari laptop.`) |
| **409** | `POST /api/wa/test` saat belum tertaut (`WhatsApp belum ditautkan.`) |
| **503** | Sesi tidak bisa dibaca/diubah, atau pesan tidak terkirim (`WhatsApp tidak bisa dihubungi. Coba lagi.`) |
| **504** | `unlink` tidak dijawab HP dalam 5 detik (`WhatsApp tidak merespons saat dilepas. Periksa jaringan di laptop lalu coba lagi.`) |

### PIN pairing

Ketiga rute ini hidup **sebelum** gerbang pairing (justru HP yang belum terpasang yang memanggilnya), tetapi
hanya selama akses HP menyala. Semua memakai JSON dan tidak butuh token API, tetapi:

- `request-pin` memasang cookie `office_pin` (HTTPS: `__Host-office_pin`; HttpOnly, SameSite=Strict, 10 menit)
  yang **mengikat PIN ke browser peminta**. Verifikasi dari browser lain (cookie berbeda) ditolak **401**.
- Lewat listener **HTTPS Tailscale**, ketiga rute mensyaratkan peer-nya perangkat dari **akun tailnet pemilik
  laptop** (pemeriksaan yang sama dengan auto-pair). Selain itu — termasuk bila CLI `tailscale status` gagal
  dijawab — jawabannya **403** dan halaman menyuruh memakai kode dari layar laptop.

| Endpoint | Body | Respons sukses |
|---|---|---|
| `GET /api/auth/pin-status` | – | `{ configured, status, active, expiresInSec, canRequestInSec }` |
| `POST /api/auth/request-pin` | – | `{ ok: true, expiresInSec, attemptsLeft }` + cookie `office_pin` |
| `POST /api/auth/verify-pin` | `{ pin: "123456" }` | `{ ok: true }` + cookie perangkat (cookie PIN dihapus); `{ ok: true, already: true }` bila browser ini sudah terpasang |

`verify-pin` mewajibkan `Content-Type: application/json` (selain itu **405**). Kalau browser sudah punya
cookie perangkat yang sah, PIN tidak diperiksa dan tidak dihanguskan — jawabannya `already: true`.

`pin-status` memetakan keadaan WhatsApp ke kontrak halaman `/pair`:

| Keadaan WhatsApp | `configured` / `status` | Halaman `/pair` |
|---|---|---|
| Belum ditautkan (`off`) | `false` / `disconnected` | Menyuruh memakai kode dari layar laptop |
| Menunggu QR (`qr`) | `true` / `qr_ready` | Tombol PIN mati, menyuruh kode laptop |
| Menyambung (`connecting`) | `true` / `connecting` | Tombol PIN mati, menyuruh kode laptop |
| Tertaut (`linked`) | `true` / `connected` | Tombol PIN hidup |

Kode error **`request-pin` / `verify-pin`** (`pin-status` selalu **200** selama akses HP menyala):

| Status | Arti |
|---|---|
| **403** | Akses HP dimatikan (`Akses dari perangkat lain sedang dimatikan.`), daftar perangkat sudah penuh (maksimal 20) saat verifikasi, atau peer HTTPS Tailscale bukan perangkat akun pemilik |
| **400** | PIN salah — ada `triesLeft` |
| **401** | PIN kedaluwarsa, sudah hangus karena 3 kali salah, atau diminta dari browser lain (`Kode ini diminta dari perangkat lain.`) |
| **429** | Terlalu cepat minta ulang (60 detik), lebih dari 5 permintaan/jam, lebih dari 3 permintaan/jam dari satu alamat IP, atau 8 PIN salah dalam sejam (jeda 15 menit) — ada `retryAfter` dan header `Retry-After` |
| **503** | WhatsApp belum ditautkan (`WhatsApp belum ditautkan.`) atau pengiriman PIN gagal (`Kode tidak terkirim ke WhatsApp. Coba lagi.`) |

Pesan error yang keluar selalu teks tetap; detail teknis hanya masuk log server.

## Halaman `/pair`

- Jalur utama: **📲 Kirim PIN ke WhatsApp** (berubah menjadi **📲 Kirim ulang PIN** dengan hitung mundur).
- Jalur cadangan terlipat: **Punya kode 6 digit dari layar laptop?**
- Kalau `pin-status` menjawab `configured: false` atau status bukan `connected`, tombol PIN dimatikan sendiri
  dan teks pembuka menyuruh memakai kode dari laptop — tidak ada pesan yang ditunggu tanpa ujung.
- Lewat bukan-HTTPS, halaman memperingatkan bahwa PIN dikirim tanpa enkripsi; pakai tautan Tailscale (https).

## Perangkat yang sudah dikenal

Perangkat yang **sudah pernah dipasangkan lewat HTTPS Tailscale** tidak diminta PIN/kode lagi kalau cookie-nya
hilang: identitas node tailnet (`tailscale status --json`) dicocokkan dengan record yang ada, lalu record
**yang sama** mendapat cookie baru (token lama mati, daftar perangkat tidak bertambah).

Perangkat yang dipasangkan lewat WiFi biasa tetap perlu kode sekali pakai, karena di jalur itu tidak ada yang
membuktikan siapa pemilik peer-nya.

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| Tombol **📲 Kirim PIN ke WhatsApp** mati, atau PIN tidak pernah datang | WhatsApp belum ditautkan, sedang menyambung, atau sesinya dicabut dari HP. Pakai kode dari layar laptop, lalu tautkan ulang lewat ⚙ → 📱 PIN ke HP |
| Status *Belum ditautkan.* padahal sudah memindai QR | Pindai ulang: kode QR berlaku singkat. Pastikan yang dipindai adalah **Perangkat tertaut → Tautkan perangkat** di WhatsApp, bukan kode lain |
| Tombol **Tautkan** tidak memunculkan QR | Server sedang membuat soket; tunggu beberapa detik. Kalau tetap *Menghubungkan ke WhatsApp…*, periksa koneksi internet laptop lalu tekan **Batal** dan **Tautkan** lagi |
| `WhatsApp belum ditautkan.` saat minta PIN | Sesi belum ada atau baru dicabut dari HP. Tautkan ulang dari laptop, atau pakai kode laptop |
| `Kode tidak terkirim ke WhatsApp. Coba lagi.` | Pengiriman gagal (jaringan laptop bermasalah). Tunggu 10 detik, lalu minta lagi; kuota jam tidak terpakai |
| Pesan uji bilang "terkirim" tetapi tidak terlihat di WhatsApp | Pesan dikirim ke **nomor itu sendiri**, jadi ada di chat **Pesan ke diri sendiri** (WhatsApp → pesan baru → namamu sendiri; di beberapa versi bernama "You"). Versi sebelum perbaikan ini mengalamatkan pesan ke ID ber-device sehingga tidak pernah tampil — perbarui aplikasi |
| `Sesi WhatsApp tidak bisa dibaca: file sesi rusak atau diubah.` | File sesi di `data/wa/` rusak. Tekan **Lepas**, lalu **Tautkan** dan pindai QR baru |
| `Kunci sesi WhatsApp hilang atau berubah…` | `data/wa/key` hilang/berubah. Tekan **Lepas**, lalu tautkan ulang |
| `WhatsApp tidak merespons saat dilepas.` | HP tidak menjawab dalam 5 detik. Periksa jaringan laptop, lalu tekan **Lepas** lagi |
| "Tunggu N detik sebelum meminta kode lagi" | Jeda 60 detik antar-permintaan. Tunggu sesuai hitungan di halaman |
| "Terlalu banyak permintaan kode dalam satu jam" | Batas 5/jam. Tunggu, atau pakai kode dari layar laptop |
| "Terlalu banyak permintaan kode dari perangkat ini" | Batas 3/jam per alamat IP. Tunggu, atau pakai kode dari layar laptop |
| "Terlalu banyak kode salah. Coba lagi dalam N menit." | 8 PIN salah dalam sejam → permintaan dijeda 15 menit. Tunggu, lalu pakai kode dari layar laptop |
| "Kode ini diminta dari perangkat lain" | PIN terikat ke browser yang memintanya. Minta PIN baru dari HP yang akan dipasangkan — jangan minta dari laptop/browser lain lalu memasukkan PIN di HP |
| "Kode salah 3 kali dan sudah dibatalkan" | PIN hangus. Minta PIN baru |
| `Perangkat Tailscale ini bukan milik pemilik laptop` | HP tidak memakai akun tailnet yang sama, node shared-in, atau `tailscale status` di laptop gagal dijawab. Pakai kode dari layar laptop |

## Catatan keamanan

- **QR adalah kredensial.** Siapa pun yang memindai kode itu menautkan WhatsApp-nya ke Adhitron dan bisa
  membaca/mengirim pesan atas namamu. Tautkan hanya dari laptopmu sendiri, dan jangan pernah membagikan
  tangkapan layar QR.
- Sesi WhatsApp = kredensial login. Sesi disimpan terenkripsi di `data/wa/`; kuncinya hanya di laptop ini dan
  tidak ikut backup. Tekan **Lepas** bila fitur ini tidak dipakai — PIN otomatis tidak bisa dikirim dan
  halaman `/pair` kembali ke jalur kode.
- **Protokol tidak resmi.** WhatsApp di aplikasi ini memakai WhatsApp Web, bukan API resmi Meta. WhatsApp
  bisa mengubah protokolnya kapan saja sehingga tautan berhenti bekerja, dan nomor pemilik berisiko dibatasi.
  Kalau itu terjadi, jalur **kode 6 digit dari layar laptop** tetap jalan.
- Nomor WhatsApp yang ditautkan dan PIN adalah data pribadi. Aplikasi hanya menyimpan nomor itu di dalam sesi
  terenkripsi (tampil di Setelan laptop); PIN tidak disimpan sama sekali. Lihat
  [privasi-data.md](privasi-data.md).
