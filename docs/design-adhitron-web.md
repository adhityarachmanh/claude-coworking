# Adhitron Web — portal + chat multi-user + browsing

Status: **rencana disetujui, sedang dikerjakan** (M1–M8).
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
- DB: **Neon Postgres** via **Prisma** + `@prisma/adapter-neon` (tanpa binary engine — aman serverless).
  Setiap query di-scope `userId`. `apiKeyEnc` tidak pernah meninggalkan server.
- Provider v1: OpenAI-compatible, Anthropic, Google Gemini. API key user dienkripsi **AES-256-GCM** (pola
  `bridge/src/vault.mjs`).
- **Model & Effort per-percakapan** meniru Adhitron lokal: daftar model per provider + chip sumber, favorit,
  Effort Default/Low/Medium/High/X-High/Max + **Auto(LLM)** (ada tapi **mati secara default**), tier
  Hemat/Sedang/Kuat. Effort dipetakan per provider (Anthropic thinking / Gemini thinking budget / OpenAI
  `reasoning_effort`; yang tak didukung diabaikan diam-diam). Classifier Auto memakai model murah milik provider user.
- **Browsing**: toggle per-percakapan "🔎 Browsing". Tool `web_search` + `fetch_url`. Mesin default
  **DuckDuckGo HTML** (tanpa kunci); Tavily/Brave opsional via env. Native tool-calling dengan fallback "prompted".
  Chip sumber bernomor. Anti-SSRF (allowlist http(s), blokir IP privat/loopback), timeout, cache per-URL,
  batas N pencarian per percakapan.

## Skema Prisma (usulan)

`User`, `Session`, `Provider`, `Conversation`, `Message`, `Citation`, `ToolRun` — semua milik `userId`.

## Rute chat

- `POST /chat/api/auth/{signup,login,logout}` · `GET /chat/api/me`
- `GET|POST /chat/api/providers` (+ `/models`)
- `GET|POST /chat/api/conversations` · `GET|PATCH|DELETE /chat/api/conversations/:id`
- `POST /chat/api/conversations/:id/messages` (SSE)
- Proteksi: cookie httpOnly + cek `Origin` + anti-CSRF + rate-limit per user.

## Milestone

- **M1** Neon/Postgres + skema Prisma + adapter (interface repo; impl Prisma + in-memory untuk test).
- **M2** Restrukturisasi situs: portal `/` + jembatan pindah `/bridge` (API jembatan tetap kompatibel).
- **M3** Auth signup/login/logout/session + rate-limit.
- **M4** Provider CRUD + vault enkripsi + daftar model.
- **M5** Chat core — streaming 3 provider + model/effort/tier + Auto classifier.
- **M6** Browsing — `web_search` + `fetch_url` + anti-SSRF + kutipan.
- **M7** UI chat penuh + polish portal.
- **M8** Docs, CHANGELOG, build Netlify, security+compliance, rilis.

## Catatan teknis penting

- Netlify Functions v2 streaming/SSE timeout ~10–26 dtk — divalidasi di M5/M6; mitigasi: batas panjang,
  streaming bertahap, fallback non-stream.
- **Kepatuhan material**: menyimpan API key & isi chat orang lain → wajib kebijakan privasi, ToS, hak hapus data,
  review UU PDP sebelum rilis publik.
- Deploy: `@netlify/blobs` store `adhitron-bridge`; `ENCRYPTION_KEY` = 32-byte hex; cron `* * * * *` di
  `netlify/functions/scheduled.mjs`.