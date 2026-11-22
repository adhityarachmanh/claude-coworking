# Adhitron Web — portal + chat multi-user + browsing

Status: **M1–M7 selesai & ter-commit; M8 (dokumen, keamanan, rilis) berjalan.**
Hosting: satu situs Netlify (folder `bridge/`, Netlify Functions v2 + Blobs + Neon).

## Masalah yang dipecahkan

Adhitron lokal (Node di PC) butuh PC hidup. Adhitron Web = versi hosting yang tetap berguna saat PC mati:

- **Portal `/`** — halaman pilih: 💬 Chat atau 🔌 Remote Power.
- **💬 Chat `/chat/*`** — chat AI multi-user seperti Gemini/Claude di browser. Tiap user login sendiri dan
  menempel **API key miliknya sendiri** (kuota & biaya jadi milik user, bukan operator situs). Bisa browsing
  (cari web + baca halaman) dengan chip sumber bernomor.
- **🔌 Remote Power `/bridge/*`** — jembatan daya yang sudah ada, dipindah dari root ke `/bridge` (logika inti
  `bridge/src/bridge.mjs` tidak berubah; hanya dipasang di prefiks).

## Keputusan yang mengikat

- Satu situs: `/` portal, `/chat/*` chat, `/bridge/*` remote power. Jembatan **tidak lagi di root**.
- Auth v1: **email + password** (scrypt via `node:crypto`), session cookie `httpOnly`. Verifikasi email = fase 2.
- DB: **Neon Postgres** lewat **SQL langsung** (`@neondatabase/serverless`, driver HTTP — tanpa codegen/build
  step, sesuai gaya repo). Skema eksplisit di `bridge/db/schema.sql`. Logika diuji lewat impl repo in-memory;
  konektivitas Neon diuji terpisah saat `DATABASE_URL` ada. Setiap query di-scope `userId`.
  `apiKeyEnc` tidak pernah meninggalkan server. *(Keputusan ini menggantikan Prisma dari rencana awal atas
  persetujuan user: Prisma menambah langkah build `prisma generate` yang tidak cocok untuk Functions.)*
- Provider v1: OpenAI-compatible, Anthropic, Google Gemini. API key user dienkripsi **AES-256-GCM** (pola
  `bridge/src/vault.mjs`).
- **Model & Effort per-percakapan** meniru Adhitron lokal: daftar model per provider + chip sumber, favorit,
  Effort Default/Low/Medium/High/X-High/Max + **Auto(LLM)** (ada tapi **mati secara default**), tier
  Hemat/Sedang/Kuat. Effort dipetakan per provider (Anthropic thinking / Gemini thinking budget / OpenAI
  `reasoning_effort`; yang tak didukung diabaikan diam-diam). Classifier Auto memakai model murah milik provider user.
  Saat menambah provider, **cek key memuat daftar model asli** dari penyedimu; user memilih lewat checklist dan
  pilihannya **disimpan per provider** (`providers.models` jsonb). Pemilih Model memakai daftar itu bila ada,
  fallback ke katalog statis.
- **Browsing**: toggle per-percakapan "🔎 Browsing". Tool `web_search` + `fetch_url`. Mesin default
  **DuckDuckGo HTML** (tanpa kunci); Tavily/Brave opsional via env. Native tool-calling dengan fallback "prompted".
  Chip sumber bernomor. Anti-SSRF (allowlist http(s), blokir IP privat/loopback), timeout, cache per-URL,
  batas N pencarian per percakapan.

## Skema (Postgres)

`users`, `sessions`, `providers`, `conversations`, `messages`, `citations`, `tool_runs` — semua milik `userId`
(cascade saat user dihapus). DDL kanonik di `bridge/db/schema.sql`; diterapkan lewat `bridge/scripts/migrate.mjs`.

## Rute chat

- `POST /chat/api/auth/{signup,login,logout}` · `GET /chat/api/me`
- `GET /chat/api/provider-kinds` · `GET|POST /chat/api/providers` · `PATCH|DELETE /chat/api/providers/:id`
  · `POST /chat/api/providers/:id/test` · `POST /chat/api/providers/models` (cek key calon provider + daftar model)
- `GET|POST /chat/api/conversations` · `GET|PATCH|DELETE /chat/api/conversations/:id`
- `POST /chat/api/conversations/:id/messages` (SSE)
- Proteksi: cookie httpOnly + cek `Origin` + anti-CSRF + rate-limit per IP/jendela.
- Halaman: `/` portal · `/auth/login` & `/auth/register` form terpisah · `/chat` aplikasi (tanpa form) ·
  `/chat/app.js` & `/chat/auth.js` skrip klien (diuji syntax). Routing ber-sesi diputuskan di server: `/chat` tanpa
  sesi → `302 /auth/login`, `/auth/*` dengan sesi → `302 /chat` (menghapus kedipan form saat refresh).

## Milestone

- **M1** Neon/Postgres + skema (`bridge/db/schema.sql`) + interface repo (impl SQL + in-memory untuk test). ✅
- **M2** Restrukturisasi situs: portal `/` + jembatan pindah `/bridge`. ✅
- **M3** Auth signup/login/logout/session + rate-limit. ✅
- **M4** Provider CRUD + vault enkripsi + daftar model. ✅
- **M5** Chat core — streaming 3 provider + model/effort/tier + Auto classifier. ✅
- **M6** Browsing — `web_search` + `fetch_url` + anti-SSRF + kutipan. ✅
- **M7** UI chat penuh + polish portal. ✅
- **M8** Docs, CHANGELOG, build Netlify, security+compliance, rilis. ⏳

## Catatan teknis penting

- Netlify Functions v2 streaming/SSE timeout ~10–26 dtk — divalidasi di M5/M6; mitigasi: batas panjang,
  streaming bertahap, fallback non-stream.
- **Kepatuhan material**: menyimpan API key & isi chat orang lain → wajib kebijakan privasi, ToS, hak hapus data,
  review UU PDP sebelum rilis publik (lihat `docs/privasi-adhitron-web.md`).
- Deploy: `@netlify/blobs` store `adhitron-bridge` (jembatan) & `adhitron-web` (rate-limit chat);
  `DATABASE_URL` = Neon; `ENCRYPTION_KEY` = 32-byte hex; cron `* * * * *` di `netlify/functions/scheduled.mjs`.

### Menjalankan lokal (`bridge/`)

```powershell
cd bridge
Copy-Item .env.example .env   # isi ENCRYPTION_KEY (salin dari Netlify UI; nilai disamarkan di CLI)
npm run dev                   # → http://localhost:8888
```

- `npm run dev` menjalankan `scripts/dev-server.mjs`: memuat `.env` (**mengikat** — menimpa env shell
  yang sudah ada) lalu menyerahkan ke `netlify functions:serve`. **`DATABASE_URL`** boleh dikosongkan di
  `.env` — CLI menyuntik dari project Netlify (context default = produksi). **`ENCRYPTION_KEY` wajib diisi di `.env`**
  karena tidak disuntik untuk fungsi lokal; tanpa itu penambahan provider menjawab **500** `Server belum dikonfigurasi untuk menyimpan key`.
  Nilai aslinya hanya bisa disalin dari **Netlify UI → Environment variables** (`netlify env:get` menyamarkannya, mis. `****e0aa`).
- Situs ini menyajikan **fungsi/fungsi-saja** (tanpa static server/portal) — cukup untuk menguji `/chat/*` dan API.
  Aset statis (`/chat/app.js`, halaman) tetap dilayani karena situs dirender dari fungsi `bridge.mjs`.
- `netlify dev` **tidak** dipakai di mesin ini: proxy fungsinya macet (edge-bundler butuh `deno`, dan ada folder
  `netlify/` nyasar di root repo yang membingungkan resolve sehingga semua rute 404), walau ia bisa membaca `.env`.
  `netlify functions:serve` melayani fungsi dengan andal tetapi **tidak** membaca `.env` — itulah kenapa ada runner.
- `.env` **tidak pernah** di-commit (`bridge/.gitignore`: `.env` / `.env.*`, dengan pengecualian `!.env.example`).
- Env opsional browsing: `TAVILY_API_KEY` / `BRAVE_API_KEY` (kosong → DuckDuckGo HTML tanpa key).
- **Auth: email + password saja.** Login pihak ketiga (Google dll.) sengaja **tidak** dipakai v1 — lihat catatan
  di bawah.

## Kenapa tanpa login pihak ketiga (v1)

Login Google tidak bisa "numpang" OAuth client milik orang lain: Google mewajibkan `redirect_uri` situs kita
terdaftar di client yang bersangkutan, dan hanya pemilik client yang bisa menambahkannya. Satu jalur tanpa setup
adalah *shared credentials* Neon Auth — tetapi consent screen menampilkan branding Neon (bukan Adhitron) dan Neon
sendiri menyebutnya untuk **dev/testing, bukan produksi**. Karena Adhitron Web adalah situs publik, v1 memakai
email + password agar kredensial & identitas tetap di tangan operator. Bila nanti diinginkan, Google OAuth client
sendiri (≈5 menit di GCP) bisa ditambahkan **tanpa mengubah** fondasi auth: cukup rute `/chat/api/auth/google` +
callback yang menautkan ke tabel `users` lalu menerbitkan cookie sesi yang sama.

## Lampiran (Fase 1)

Status: **diimplementasi (Fase 1).** Scope fase 1 hanya **gambar (PNG/JPEG/GIF/WebP)** dan **file teks**
(log/kode/md/json/csv/…). **PDF ditunda** (lihat akhir bagian). Kontrak API yang sudah dibekukan tidak diubah:

- `POST /chat/api/conversations/:id/messages` — body boleh menambah `attachments: [{ name, mediaType, data }]`,
  `data` = base64 **tanpa prefiks** `data:`. Opsional; pesan teks saja tetap bekerja.
- Setelah tersimpan, chip lampiran pesan user ada di `meta.attachments` = `[{ kind, name, size }]`.

### 1. Blok konten netral + terjemahan per provider

Satu bentuk netral dipakai di seluruh jalur chat; hanya `buildRequest` (`bridge/src/chat.mjs`) yang tahu
perbedaan provider — sama seperti teks/tool saat ini. Sebuah `content` pesan boleh berupa **string** (perilaku
lama, tak berubah) **atau array blok netral**:

```
{ type: 'text',  text: string }
{ type: 'image', mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: <base64> }
```

Terjemahan (fungsi murni baru, mis. `blocksToContent(kind, blocks)`):

| Netral | OpenAI | Anthropic | Google |
|---|---|---|---|
| `text` | `{ type:'text', text }` | `{ type:'text', text }` | `{ text }` (dalam `parts`) |
| `image` | `{ type:'image_url', image_url:{ url:'data:<mediaType>;base64,<data>' } }` | `{ type:'image', source:{ type:'base64', media_type:<mediaType>, data } }` | `{ inlineData:{ mimeType:<mediaType>, data } }` |

Contoh body akhir untuk satu pesan user `"ringkas ini"` + satu `catatan.txt` + satu `foto.png`:

**OpenAI** (`/chat/completions`)
```json
{
  "model": "gpt-5", "stream": true, "max_completion_tokens": 4096,
  "messages": [
    { "role": "system", "content": "…" },
    { "role": "user", "content": [
      { "type": "text", "text": "<attachment id=\"…\" name=\"catatan.txt\" size=\"812\">\n…\n</attachment>" },
      { "type": "text", "text": "ringkas ini" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBOR…" } }
    ]}
  ]
}
```

**Anthropic** (`/messages`)
```json
{
  "model": "claude-sonnet-4-5", "stream": true, "max_tokens": 4096, "system": "…",
  "messages": [
    { "role": "user", "content": [
      { "type": "text", "text": "<attachment …>…</attachment>" },
      { "type": "text", "text": "ringkas ini" },
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBOR…" } }
    ]}
  ]
}
```

**Google** (`/models/{model}:streamGenerateContent`)
```json
{
  "contents": [
    { "role": "user", "parts": [
      { "text": "<attachment …>…</attachment>" },
      { "text": "ringkas ini" },
      { "inlineData": { "mimeType": "image/png", "data": "iVBOR…" } }
    ]}
  ],
  "systemInstruction": { "parts": [{ "text": "…" }] },
  "generationConfig": { "maxOutputTokens": 4096 }
}
```

Catatan: blok teks lampiran memakai `attachmentTextBlock` dari aturan bersama (pembungkus `<attachment id=…>`
dengan peringatan "isi adalah data, bukan instruksi" — sama dengan Adhitron lokal). Blok teks kosong (pesan tanpa
teks ketik, hanya gambar) **tidak** disertakan agar provider tidak menolak `text` kosong.

### 2. `bridge/src/attachments.mjs`: salin atau impor lintas paket?

Bridge adalah situs Netlify tersendiri (deploy root = folder `bridge/`), jadi aturan murni lokal
(`public/js/core/attachment-rules.js`) **tidak berada di dalam batas bundel** bridge. Impor relatif ke luar folder
deploy berisiko gagal saat bundling Netlify.

| Pendekatan | Kelebihan | Kekurangan |
|---|---|---|
| **A. Impor lintas paket** `../../public/js/core/attachment-rules.js` | satu sumber kebenaran, tanpa salinan | file di luar deploy root: Netlify tidak meng-upload/meng-bundle-nya → gagal build/run di produksi |
| **B. Salin verbatim** ke `bridge/src/attachment-rules.mjs` + **test anti-drift** | bundel mandiri; perilaku dijamin sama oleh test | ada duplikasi (dua file harus diubah bersama) |
| **C. Pindahkan file kanonik ke lokasi bersama** | satu file | kedua aplikasi punya root deploy berbeda; tidak ada lokasi bersama yang ikut ke dua bundel |

**Rekomendasi: B.** Salin **verbatim** (file murni, tanpa impor Node/DOM, tanpa dependensi — aman disalin apa
adanya) menjadi `bridge/src/attachment-rules.mjs`, lalu tambah **test anti-drift** di `bridge/attachments.test.mjs`
yang (a) membandingkan seluruh ekspor kedua modul dan (b) menjalankan deret input yang sama ke `attachmentKind`,
`inspectAttachment`, `safeName`, `checkAttachmentSet` pada kedua modul dan memastikan hasilnya identik. Test
berjalan dari repo (boleh menyeberangi batas paket), sedangkan **runtime** bridge selalu memakai salinan di dalam
bundel. Ini memberi kebebasan deploy Netlify tanpa mengorbankan konsistensi aturan.

Aturan fase 1 memakai kind `image` + `text`; kind `pdf` tetap ada di salinan (agar salinannya verbatim) tetapi
**ditolak** di lapisan `bridge/src/attachments.mjs` dengan pesan Indonesia (lihat §5 tentang cara mengaktifkan PDF).

### 3. Validasi & batas di server

Klien tak dipercaya; setiap lampiran divalidasi ulang di server dengan aturan yang sama (kind dari ekstensi lalu
MIME, isi diverifikasi magic bytes / UTF-8, nama disanitasi `safeName`).

- Jumlah: `ATTACH_LIMITS.maxFiles` (10) per pesan — dihitung **sebelum** base64 didekode.
- Per file: teks ≤ `ATTACH_LIMITS.textBytes` (200 KB); gambar ≤ `ATTACH_LIMITS.imageBytes` **dan** ≤ batas total
  bridge (di bawah); dimensi gambar ≤ `imagePixels` (8000 px/sisi).
- Total teks: `ATTACH_LIMITS.textTotalBytes` (500 KB).

**Batas total bridge (khusus).** Beda dari server lokal (batas body 30 MB), Netlify Functions (berbasis AWS Lambda,
panggilan sinkron) membatasi **payload permintaan ±6 MB** — base64 menambah ±33%, jadi total **file** harus jauh di
bawah 6 MB agar JSON + teks + overhead masih muat. Karena itu bridge memakai overlay:

```
export const BRIDGE_ATTACH_LIMITS = { totalBytes: 3 * 1024 * 1024 }; // 3 MB file → ±4 MB base64, sisakan margin
```

Batas per gambar tetap `imageBytes` (3,75 MB) secara aturan bersama, tetapi **total** 3 MB yang berlaku efektif.
Angka 6 MB Lambda **wajib diverifikasi** saat implementasi (uji kirim lampiran besar ke deploy Netlify); bila
ternyata lebih kecil, turunkan `totalBytes` — bukan mengubah `ATTACH_LIMITS` bersama. Panjang base64 dideklarasikan
dicek lebih dulu (seperti `src/attachments.js`) supaya gagal cepat dengan pesan ramah, sebelum menyentuh buffer.

Pesan error (Bahasa Indonesia, pola sama dengan lokal):

| Kondisi | Pesan |
|---|---|
| base64 tidak kanonik / `length % 4 ≠ 0` | `Data lampiran rusak (bukan base64).` |
| kind tidak dikenal (mis. `.exe`) | `<nama>: jenis file tidak didukung. Lampirkan gambar (PNG/JPEG/GIF/WebP) atau file teks (log, kode, md, json, csv, …).` |
| PDF (fase 1) | `<nama>: PDF belum didukung pada versi ini.` |
| melebihi per-file | `<nama> lebih dari <ukuran>.` (teks: tambah `Taruh file di folder project lalu sebut dengan @file.`) |
| melebihi jumlah | `Maksimal 10 lampiran per pesan.` |
| melebihi total | `Total lampiran lebih dari 3 MB.` |
| total teks | `Total lampiran teks lebih dari 500 KB. …` |

Error divalidasi lewat kelas `AttachmentError` (status 400) yang dipetakan ke JSON oleh `guard` — tidak membocorkan
detail internal. Validasi terjadi di `runTurn` sebelum pesan disimpan; input salah → `400` tanpa efek samping.

### 4. Riwayat (`historyFor`) & apa yang disimpan

**Keputusan isi tersimpan:** `content` = **teks ketik user saja**; `meta.attachments` = chip `[{kind,name,size}]`;
`meta.textBlocks` = array blok `<attachment …>` yang sudah dirender, **hanya untuk kind teks**. **Isi gambar
(base64) TIDAK disimpan** di DB. Tidak ada perubahan skema — `messages.meta` sudah `jsonb`.

`historyFor(messages)` untuk pesan user membangun `content` sebagai array netral:
`[...(m.meta?.textBlocks ?? []).map(t => ({type:'text',text:t})), ...(m.content ? [{type:'text',text:m.content}] : [])]`,
dan `{role, content: m.content}` untuk asisten. Pesan giliran berjalan memakai blok gambar langsung (tidak lewat DB).

**Konsekuensi (dipilih sadar):**

- **Teks lampiran ikut dikirim ulang** di setiap giliran berikutnya → percakapan lanjut tetap "melihat" isi file;
  pengorbanan: token bertambah sebesar ukuran blok teks (dibatasi 500 KB/pesan). `meta.textBlocks` disimpan agar
  blok yang dikirim identik dengan yang asli (termasuk id acak anti-injeksi).
- **Gambar lama TIDAK dikirim ulang** → hemat token besar (satu gambar base64 jauh lebih mahal daripada teks tiap
  giliran). Konsekuensi: setelah giliran pertama, model tidak lagi "melihat" gambar; jawaban terhadap pertanyaan
  lanjutan soal isi gambar bergantung pada jawaban pertama (model biasanya mendeskripsikannya) atau user
  melampirkan ulang. Ini sejalan dengan perilaku Adhitron lokal (`resume-turn.js`) yang menyatakan lampiran tidak
  ikut dikirim ulang.
- Alternatif "simpan base64 gambar di DB lalu kirim ulang" sengaja **ditolak**: membengkakkan baris DB, biaya
  token tiap giliran, dan menambah risiko penyimpanan data biner besar.

Pesan boleh **tanpa teks** bila ada lampiran: `messageProblem` (teks kosong) hanya berlaku saat `attachments` juga
kosong. Judul percakapan dari pesan pertama: pakai teks bila ada, selain itu `Lampiran` (atau nama file pertama).

### 5. Menambahkan PDF nanti

Karena salinan aturan sudah mengenal kind `pdf`, pengaktifannya nanti hanya: (a) izinkan kind `pdf` di
`bridge/src/attachments.mjs`, (b) tambah cabang `{ type:'document', source:{ type:'base64', media_type:'application/pdf', data } }`
di `blocksToContent` untuk OpenAI/Anthropic dan `inlineData` untuk Google, (c) kembalikan `pdf` ke `ATTACH_ACCEPT`
di UI chat, (d) uji batas ukuran terhadap limit payload Netlify (PDF 5 MB base64 ≈ 6,7 MB — melebihi margin, jadi
batas PDF bridge harus lebih rendah). Tidak ada perubahan skema.

### Rencana test (`bridge/*.test.mjs`)

File baru `bridge/attachments.test.mjs` + tambahan di `bridge/chat.test.mjs`. Semua tanpa jaringan (`fetchImpl`
palsu), memakai `makeMemoryRepo` seperti suite chat.

`bridge/attachments.test.mjs`

- **Anti-drift**: seluruh ekspor `bridge/src/attachment-rules.mjs` sama dengan
  `../public/js/core/attachment-rules.js`; deret input yang sama menghasilkan output identik di kedua modul.
- **Sukses gambar + teks**: `readAttachments({attachments:[pngBase64, txtBase64]})` → dua item dengan kind benar;
  `contentBlocks` menghasilkan `[text-attachment, text, image]`; `attachmentChips` → `[{kind,name,size}]`.
- **base64 rusak** (karakter ilegal, `length % 4 ≠ 0`, string kosong) → error `Data lampiran rusak (bukan base64).`
- **jenis tak didukung** (nama `.exe` / MIME tak dikenal) → error "jenis file tidak didukung".
- **PDF ditolak** fase 1 → error "PDF belum didukung".
- **terlalu besar**: per gambar, per teks, total teks, dan total bridge (> 3 MB) → pesan masing-masing.
- **nama berbahaya** (`../../a.png`, karakter bidi/zero-width) → chip `name` bersih dan panjang ≤ 100.
- **magic bytes salah** (nama `.png` tapi isi bukan PNG) → error "bukan gambar … yang valid".

`bridge/chat.test.mjs`

- **buildRequest per provider** dengan messages berisi array blok: OpenAI → `image_url.url` data URL; Anthropic →
  `image.source.{type:'base64',media_type,data}`; Google → `parts[].inlineData.{mimeType,data}`; pesan teks-only
  tetap string seperti sebelumnya (regresi).
- **giliran (SSE) dengan lampiran**: POST body + `attachments` → `fetchImpl` memverifikasi body provider memuat blok
  gambar & blok teks lampiran; setelah selesai `meta.attachments` tersimpan sebagai chip dan `meta.textBlocks`
  tersimpan; bubble tidak menyimpan base64.
- **lanjutan hemat gambar**: giliran kedua pada percakapan sama → body provider memuat blok teks lampiran lama
  tetapi **tidak** memuat blok gambar lama.
- **error 400 lampiran**: base64 rusak / terlalu besar / jenis tak didukung → `400` JSON berpesan Indonesia dan
  **tidak** ada pesan user tersimpan.
- **lampiran tanpa teks**: pesan dengan gambar saja (text kosong) diterima; teks kosong tanpa lampiran tetap `400`.
- **isolasi**: validasi tetap berjalan walau klien mengaku sukses (server memvalidasi ulang).

Definisi selesai fase 1: `npm run test:related -- bridge/attachments.mjs bridge/chat.mjs bridge/chat-run.mjs`
hijau, `npm run check` hijau, dan `CHANGELOG.md` diperbarui.