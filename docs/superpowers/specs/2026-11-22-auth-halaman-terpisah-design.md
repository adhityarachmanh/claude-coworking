# /auth terpisah + /chat bersih + cek model provider + rapikan UI/UX — desain

Tanggal: 2026-11-22 · Status: **disetujui & diterapkan** · Pemilik: Adhitron Web (`bridge/`)

## Masalah

1. **Kedip form saat refresh `/chat`.** `/chat` mengirim form (`#auth`) *dan* aplikasi (`#app`) sekaligus;
   keputusan "mana yang tampil" terjadi di browser setelah `app.js` memanggil `/chat/api/me`. Saat refresh,
   form selalu tampil sekejap dulu — user ingin ini hilang sepenuhnya.
2. **Form dan aplikasi bercampur di satu URL.** User ingin halaman form berdiri sendiri, dan `/chat` murni
   aplikasi.
3. **Login & daftar harus halaman terpisah.** Tidak lagi satu halaman dengan tab.
4. **Menambah provider tanpa tahu modelnya.** User ingin mengecek API key lalu **melihat & memilih model** seperti
   Adhitron lokal, bukan menebak dari katalog statis.
5. **UI/UX "kurang rapih".** Perlu sapuan kerapian visual tanpa mengubah perilaku fitur.

## Keputusan

- **Halaman:** `/auth/login` (Masuk) dan `/auth/register` (Buat akun) masing-masing satu form berdiri sendiri.
  `/auth` (tanpa sub-halaman) hanya mengarahkan ke halaman yang tepat. **`/chat`** = aplikasi saja.
- **Penentuan di server, bukan browser.** `handleSite` diberi akses sesi supaya bisa memutuskan sebelum HTML
  dikirim — ini yang menghapus kedipan; redirect berbasis JS tidak cukup karena browser tetap merender sesuatu dulu.
- **Portal `/` tetap netral** (tidak redirect).
- **Menambah provider = cek key → muat & pilih model.** Memanfaatkan respons `GET /models` provider yang sudah
  dipanggil `client.mjs`; sekarang daftarnya **dikembalikan, ditampilkan sebagai checklist, dan disimpan**.
- **Perubahan sesedikit mungkin, ikuti pola repo.** Semua warna/komponen tetap dari `CSS` yang sudah ada; tidak
  menambah framework, tidak menulis ulang CSS.

## Routing & sesi (server)

| Permintaan | Tanpa sesi | Dengan sesi |
|---|---|---|
| `GET /chat` | 302 → `/auth/login` | 200 aplikasi |
| `GET /auth` | 302 → `/auth/login` | 302 → `/chat` |
| `GET /auth/login` | 200 form masuk | 302 → `/chat` |
| `GET /auth/register` | 200 form daftar | 302 → `/chat` |

- `handleSite(request, env, url)` menerima `env` (repo + encryptionKey) dari fungsi Netlify. Kalau `env` tidak
  ada, perilaku lama tetap jalan (halaman tetap tersaji; sesi dianggap tidak ada).
- Sesi dibaca dengan `currentUser` yang diekspor dari `chat-api.mjs` (tanpa siklus impor: `site.mjs` →
  `chat-api.mjs`; `chat-api.mjs` tidak mengimpor `site.mjs`).
- Kegagalan DB saat cek sesi **fail-open ke arah form** (jangan 500).
- `chatPageHtml()` **tanpa** blok form (hanya `#app` + overlay provider + empty state JS). `loginPageHtml()` dan
  `registerPageHtml()` dari satu helper `authPageHtml()` (kartu terpusat), skripnya `/chat/auth.js`.
- `/auth/login?expired=1` menampilkan catatan "Sesi berakhir, silakan masuk lagi." (dipakai klien saat sesi habis).
- Link keluar: tombol **Keluar** → `location.href = '/auth/login'`; **Hapus akun** → setelah sukses → `/auth/login`.

## Sisi klien

- `chat-app.mjs` (`/chat/app.js`): hapus jalur auth (`showAuth`, tab, `wireAuth`, `authMsg`). `refresh()` hanya
  memanggil `/me`; 401 → `location.href = '/auth/login?expired=1'`.
- `authJs()` (`/chat/auth.js`): form per halaman (`data-action="login"|"signup"`), tombol Lihat/Sembunyikan
  password, error di dalam kartu, sukses → `location.href = '/chat'`.

## Provider: cek key → muat & pilih model

- `client.mjs`: `probeModels(provider, apiKey, fetchImpl)` → `{ ok, models:[{id,label}] }` atau `{ ok:false, error }`.
  Menormalkan tiga bentuk respons: OpenAI/Anthropic `{data:[{id, display_name?}]}`, Gemini
  `{models:[{name:"models/x", displayName}]}`. `testProviderKey` kini tipis di atasnya.
- `chat-api.mjs`: rute baru `POST /chat/api/providers/models` (login + same-origin) memprobe key calon provider
  **tanpa menyimpannya**; `POST/PATCH /providers` menerima & menyimpan array `models` terpilih
  (dinormalkan: unik, id wajib, maks 500). `POST /providers/:id/test` memprobe key tersimpan lalu **menyimpan**
  daftar hasilnya.
- Skema: kolom `providers.models jsonb` (null = pakai katalog statis); `alter table ... add column if not exists`
  idempoten di `schema.sql`. `publicProvider` membawa `models`.
- `providers.mjs`: `effectiveModels(kind, providerModels)` menggabungkan daftar milik provider (bila ada) dengan
  tier & effort; `tierFor`/`modelSupportsEffort` memakai katalog statis bila id cocok, selain itu heuristik nama.
  Semua pemakaian model (`defaultModelFor`, `cheapestModelFor`, `modelForTier`, classifier `auto.mjs`) menerima
  `providerModels`.
- UI panel provider: tombol **Cek key & muat model** → checklist model (semua tercentang, pencarian, Pilih
  semua/Kosongkan) → **Simpan provider**. Provider lama: **Uji & muat model** menyegarkan daftarnya. Pemilih
  Model di composer memakai `provider.models` bila ada, fallback ke katalog statis.

## Sapuan UI/UX

- **Auth:** kartu terpusat (logo + judul + subjudul), satu form per halaman, tombol primer penuh, error di dalam
  kartu, tautan pindah login↔daftar, `autocomplete`/`enterkeyhint`/`autocapitalize` benar, Lihat password.
- **Chat:** empty state thread (sambutan + 3 saran prompt sekali-klik), sidebar berjudul "Riwayat" dengan identitas
  user + aksi sekunder dikelompokkan, header thread menampilkan konteks `provider · model · effort · browsing`,
  `aria-label`/fokus terlihat, tanpa scroll horizontal.
- **Konsistensi:** radius/border/warna seragam dengan portal & `/bridge`.

## Yang di luar cakupan (sengaja)

- Autentikasi pihak ketiga, verifikasi email, reset password.
- Item privasi/consent lain (checklist terpisah di `docs/privasi-adhitron-web.md`).
- Mengubah alur portal `/` selain "tetap netral".
- Menyentuh `src/bridge.mjs` (Remote Power `/bridge`) — hanya verifikasi tak ada regresi.

## Kriteria terima (teruji)

1. `GET /chat` **dengan** sesi → 200 HTML aplikasi; **tanpa** sesi → 302 `/auth/login`.
2. `GET /auth` tanpa sesi → 302 `/auth/login`; dengan sesi → 302 `/chat`.
3. `GET /auth/login` tanpa sesi → 200 form masuk (`data-action="login"`); `/auth/register` → 200 form daftar
   (`data-action="signup"`); keduanya 302 `/chat` bila sudah masuk.
4. HTML `/chat` **tidak** memuat `data-action="login"`; `app.js` & `auth.js` valid syntax.
5. `probeModels` menormalkan 3 bentuk respons; `POST /providers/models` menolak 401 (tanpa login) & 403 (beda
   origin); daftar model terpilih tersimpan dan terbaca kembali.
6. `/`, `/privasi`, `/syarat`, `/bridge` tetap 200.
7. `npm run lint` hijau, suite bridge hijau.