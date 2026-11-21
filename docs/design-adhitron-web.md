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