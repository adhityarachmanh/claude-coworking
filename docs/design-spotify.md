# Desain: Integrasi Spotify (Spotify Connect lewat Web API dari server)

Status: **usulan** (belum diimplementasi) · Penulis: Tech Lead · 2026-11-02
Lingkup: now-playing di kantor (radio di lounge + karakter idle ikut bergoyang), kontrol kecil (play/pause, next/prev, volume, pilih perangkat, playlist) di header dan 🗂 dashboard, bisa dari HP lewat Tailscale, read-only lewat WiFi. Opsional: kecilkan/jeda musik saat kartu izin muncul.
Batasan tetap: Node ≥ 20, **nol dependensi npm**, frontend vanilla, CSP ketat (`script-src 'self'`, `connect-src 'self'`) **tidak diubah**, gerbang yang ada (`isLocal`, `LOCAL_ONLY`, `canManageAccount`, `wifiAllows`) dipakai apa adanya, rahasia tidak pernah masuk backup.
Keputusan yang sudah diambil user/Lead: **Approach A**, yaitu server mengendalikan perangkat Spotify Connect yang sudah ada lewat Web API. Tanpa Web Playback SDK dan tanpa script pihak ketiga di halaman. User punya Premium dan sudah punya app Spotify (Client ID).

Kode baru: **`src/spotify.js`** (service, tanpa HTTP server) + **`src/routes/spotify.js`** (route module, pola `register(router)` sama seperti `src/routes/account.js`). Di `server.js` hanya ada beberapa baris wiring (§7). File itu sedang dipecah oleh dev lain, jadi wiring dikerjakan **setelah** pemecahan itu masuk.

---

## 0. Ringkasan keputusan

| # | Keputusan | Alasan singkat |
|---|---|---|
| D1 | **Authorization Code + PKCE (S256)**, tanpa client secret. Secret tidak pernah diminta atau disimpan, walaupun user punya | Public client di laptop; secret di disk tidak menambah keamanan |
| D2 | Redirect URI **`http://127.0.0.1:<OFFICE_PORT>/spotify/callback`** (default `:4317`), di luar `/api/` | Aturan Spotify 2025: `localhost` ditolak, loopback harus IP eksplisit. Callback adalah navigasi GET dari Spotify, jadi tidak bisa membawa `x-office-token` |
| D3 | **Login, logout dan konfigurasi hanya dari laptop** (`LOCAL_ONLY`). HP menampilkan "Hubungkan dari laptop" | Redirect ke 127.0.0.1 di HP berarti HP itu sendiri. Lagi pula ini konfigurasi |
| D4 | Client ID diisi di **⚙ Pengaturan (laptop)**, disimpan di `data/spotify.json`. `SPOTIFY_CLIENT_ID` (env) hanya fallback. Tidak pernah lewat chat atau commit | `data/` di-gitignore. Satu sumber kebenaran yang terlihat di UI |
| D5 | Token di **file terpisah `data/spotify.json`**, **bukan** `state.json`/`hub.persisted` | Backup memakai daftar eksplisit (`exportState()` + usage + chats), jadi file baru otomatis tidak ikut. Tidak ada risiko lupa menambah key ke daftar buang `exportState()` |
| D6 | Token **tidak pernah dikirim ke browser**. Browser hanya menerima `publicState()` yang sudah disaring (tanpa token, URI, ID track/playlist/perangkat, nama akun) | Menutup kebocoran lewat SSE, yang juga diterima HP WiFi |
| D7 | **Polling di server** `GET /v1/me/player`: 5 s saat playing, 20 s saat pause atau tanpa perangkat, 60 s setelah 10 menit tanpa perubahan, **berhenti** kalau tidak ada stream SSE terbuka. Hasil di-push lewat SSE `spotify` | Satu poller untuk semua tab/HP. Kuota Spotify (jendela 30 s) aman di 6 req/30 s |
| D8 | Kontrol: semua `POST /api/spotify/*` (pola API yang ada). **WiFi hanya boleh `state` dan `art`** | `wifiAllows` adalah allowlist; endpoint baru otomatis ditolak sampai didaftarkan |
| D9 | Album art **diproksikan server** (`POST /api/spotify/art {id}` → bytes gambar → `blob:` di browser). CSP tidak diubah | `img-src` sudah mengizinkan `blob:`; HP tidak menghubungi CDN Spotify; tidak ada URL dari klien (anti-SSRF) |
| D10 | Fetch keluar hanya ke `accounts.spotify.com`, `api.spotify.com` dan CDN gambar yang di-allowlist. `redirect: 'error'`, timeout 8 s (token 10 s), batas ukuran respons | SSRF dan waktu tunggu tanpa batas |
| D11 | 429: hormati `Retry-After` secara global (`blockedUntil`). Selama diblokir tidak ada request keluar; write mendapat 503 dengan jam coba lagi | Aturan Spotify. Retry yang keras kepala justru memperpanjang blokir |
| D12 | "Kecilkan saat izin" dihitung **di server** (observer `hub.observers` pada event `approval`). Setting `off \| duck \| pause`, default `off` | Approval adalah state server; tetap jalan walau laptop tidak membuka halaman |
| D13 | Test: service menerima `{ accountsOrigin, apiOrigin, fetch, now }` lewat **konfigurasi konstruktor**. Untuk test server/UI end-to-end ada test hook **loopback-only** (§9.1), dan token yang didapat dari origin lain tidak pernah dipakai | Pola yang sama dengan `OFFICE_HTTPS_TEST_BIND`: tidak bisa mengarahkan token asli ke host lain |

---

## 1. OAuth (Authorization Code + PKCE)

### 1.1 Fakta Spotify yang dipakai (cek ulang saat implementasi)

Dokumentasi tidak bisa diambil dari sesi ini (tidak ada akses web). Poin di bawah berasal dari pengetahuan per pertengahan 2026. **Backend wajib memverifikasi ulang** di developer.spotify.com sebelum coding:

| Poin | Nilai |
|---|---|
| Authorize | `GET https://accounts.spotify.com/authorize?response_type=code&client_id&redirect_uri&scope&state&code_challenge_method=S256&code_challenge` |
| Token | `POST https://accounts.spotify.com/api/token` form-urlencoded: `grant_type=authorization_code, code, redirect_uri, client_id, code_verifier`. **Tanpa** header Basic (PKCE) |
| Refresh | `grant_type=refresh_token, refresh_token, client_id`. Respons PKCE **bisa membawa refresh token baru (rotasi)**: simpan kalau ada, kalau tidak pakai yang lama |
| Umur access token | 3600 s (`expires_in`) |
| Redirect URI (aturan April 2025, berlaku untuk semua app sejak akhir 2025) | Harus HTTPS, **kecuali loopback** yang harus berupa IP eksplisit `http://127.0.0.1:PORT` atau `http://[::1]:PORT`. `localhost` **ditolak**. Harus sama persis dengan yang terdaftar di Dashboard |
| Revoke | **Tidak ada endpoint revoke token.** Logout = hapus token lokal + arahkan user ke `https://www.spotify.com/account/apps/` untuk mencabut akses |
| Development Mode | App dev-mode hanya bisa dipakai akun yang didaftarkan di Dashboard → *User Management* / *Users and Access*. Spotify memperketat dev mode beberapa kali (2024–2026), jadi kuota dan syaratnya perlu dicek ulang (§11) |
| Endpoint yang dihentikan untuk app baru (Nov 2024) | audio-features (BPM), recommendations, featured/editorial playlists. Kita **tidak** memakainya. Goyangan karakter memakai tempo tetap (§6.2) |

### 1.2 Scope

Minimal: `user-read-playback-state user-modify-playback-state playlist-read-private`.

- `user-read-currently-playing` **tidak perlu**: `GET /v1/me/player` sudah memuat item yang sedang diputar dengan `user-read-playback-state`. Usul: jangan diminta (layar persetujuan lebih kecil). Kalau Lead tetap ingin memintanya, tidak ada dampak teknis.
- `playlist-read-collaborative` hanya perlu kalau playlist kolaboratif ingin ikut tampil (pertanyaan terbuka Q3).
- Tanpa `user-read-private`/`user-read-email`. Nama tampilan diambil dari `GET /v1/me` (tanpa scope) **sekali** saat login dan hanya ditampilkan di ⚙ laptop.

### 1.3 Alur

```
Laptop UI (⚙ Spotify)                 server (127.0.0.1:4317)                    accounts.spotify.com
  │ POST /api/spotify/login ───────────▶ LOCAL_ONLY + x-office-token
  │                                     buat flow: state(32B), verifier(64B), challenge=S256,
  │                                     returnOrigin=origin halaman (localhost:4317 atau 127.0.0.1:4317)
  │ ◀──────── { url } ──────────────────┘ (satu flow aktif; flow baru menggantikan yang lama; TTL 10 menit)
  │ window.open(url, '_blank', 'noopener')  ──────────────────────────────────────▶ login + setuju
  │                                     GET /spotify/callback?code&state ◀────────── 302
  │                                     isLocal? host 127.0.0.1:PORT? state cocok (timingSafeEqual), belum
  │                                     dipakai, belum kedaluwarsa → hapus flow (sekali pakai)
  │                                     POST /api/token (code + verifier) ─────────────▶
  │                                     simpan token → GET /v1/me (nama) → broadcast 'spotify'
  │                                     balas HTML statis "Spotify terhubung, tab ini boleh ditutup"
  │                                     + tautan ke returnOrigin (tanpa script)
  │ ◀── SSE 'spotify' (status: idle/playing) — tab kantor langsung ter-update
```

Detail:
- **`state`** = `randomBytes(32).toString('base64url')`; **`code_verifier`** = `randomBytes(64).toString('base64url')` (86 karakter, masih di rentang 43–128); `code_challenge` = `sha256(verifier)` base64url. Flow disimpan **hanya di memori**. Restart server di tengah login berarti login diulang.
- `state` sekaligus menahan **login CSRF**: situs lain tidak bisa membuat laptop terhubung ke akun Spotify penyerang, karena flow hanya bisa dimulai lewat POST bertoken.
- Callback dengan `?error=access_denied` → halaman "Dibatalkan" (200), flow dihapus. State salah, kedaluwarsa atau sudah dipakai → 400 "Tautan login tidak valid, mulai lagi dari ⚙". **Tidak ada pertukaran token** dalam kasus ini (diuji lewat log fake server).
- Callback dari selain laptop (`!isLocal`) → 404, sama seperti path yang tidak dikenal.
- Halaman hasil dibuat tanpa script (lolos CSP), `Cache-Control: no-store`. `Referrer-Policy: no-referrer` yang sudah ada mencegah `code` bocor lewat Referer.
- `show_dialog=true` hanya dikirim kalau user menekan "Ganti akun".
- **Redirect URI ditampilkan persis** di ⚙ (dengan tombol salin), dibentuk dari `PORT` yang berlaku. Kalau `OFFICE_PORT` diubah, URI di Dashboard harus diubah juga (diberi peringatan di ⚙).

### 1.4 Penyimpanan: `data/spotify.json`

```json
{
  "v": 1,
  "clientId": "0123456789abcdef0123456789abcdef",
  "settings": { "office": true, "duck": "off", "duckVolume": 20 },
  "auth": {
    "origin": "https://accounts.spotify.com",
    "accessToken": "…",
    "expiresAt": 1793600000000,
    "refreshToken": "…",
    "scope": "user-read-playback-state user-modify-playback-state playlist-read-private",
    "displayName": "Adhit"
  }
}
```

- Ditulis atomik (`.tmp` lalu `rename`), mode `0o600` (di Windows praktis ACL profil user, setara `~/.claude/.credentials.json`). Tidak ada enkripsi tambahan; DPAPI tanpa dependensi tidak sepadan untuk v1.
- `clientId` divalidasi `/^[0-9a-f]{32}$/i`. Sumber: file → `SPOTIFY_CLIENT_ID` → kosong. UI menunjukkan sumbernya ("dari env" berarti read-only di ⚙).
- `auth.origin` dicatat. Saat load, kalau origin ≠ `accountsOrigin` yang aktif, `auth` dibuang. Token asli tidak pernah dikirim ke fake server dan sebaliknya (D13).
- File rusak atau tidak bisa di-parse → di-rename ke `spotify.json.corrupt-<ts>`, status `disconnected`, ada log satu baris tanpa isi.
- **Tidak ikut backup**: `writeBackup` hanya memasukkan `exportState()`, `usage.jsonl` dan `data/chats`. Test regresi memastikan nama `spotify` tidak muncul di zip (§9).

### 1.5 Refresh dan siklus token

- `accessToken()` me-refresh kalau `expiresAt - now < 60 s`. **Single-flight**: request yang bersamaan menunggu promise refresh yang sama.
- Respons 401 dari API → satu kali refresh paksa lalu **satu kali** ulang; gagal lagi berarti error `revoked`.
- Refresh menjawab `400 invalid_grant` (dicabut di spotify.com, atau rotasi hilang) → hapus `auth`, status `disconnected` dengan alasan `revoked`, broadcast.
- Error jaringan saat refresh → error `network` (token lama tetap disimpan), backoff polling (§2.3).

### 1.6 Logout

`POST /api/spotify/logout` (laptop) → hapus `auth` dari file, buang flow, hentikan poller, broadcast `disconnected`. UI menampilkan: "Untuk mencabut akses sepenuhnya, buka spotify.com/account/apps" (tautan biasa, target `_blank`, `rel=noopener`). Client ID tetap tersimpan.

### 1.7 Login dimulai dari HP

v1: **tidak bisa**. `/api/spotify/login` ada di `LOCAL_ONLY`. HP (Tailscale maupun WiFi) melihat status `disconnected` dengan teks "Hubungkan Spotify dari laptop (⚙ Pengaturan)" tanpa tombol.
Opsi v2 (tidak direkomendasikan sekarang): mendaftarkan redirect HTTPS kedua `https://<magicdns>:4318/spotify/callback`. Secara teknis diizinkan Spotify (HTTPS), tetapi menambah permukaan (Host guard per listener, dua redirect URI, flow yang terikat transport) untuk kebutuhan yang hanya terjadi sekali.

---

## 2. API proxy

### 2.1 Endpoint

Semua endpoint `/api/*` melewati gerbang yang ada (Host, Origin, `x-office-token`, POST, JSON).

| Endpoint | Jenis | Laptop | HP Tailscale | HP WiFi | Body → Respons |
|---|---|---|---|---|---|
| `POST /api/spotify/state` | read | ✓ | ✓ | **✓** | `{}` → `publicState()`. Memicu poll hanya kalau data lebih tua dari 2 s (coalesced, single-flight), jadi tidak bisa dipakai untuk spam |
| `POST /api/spotify/art` | read | ✓ | ✓ | **✓** | `{ id }` (hex 16) → `image/jpeg\|png\|webp`. `id` hanya dikenal kalau berasal dari state atau playlist terakhir |
| `POST /api/spotify/devices` | write-side | ✓ | ✓ | ✗ | `{}` → `{ devices: [{ id, name, type, active, volume, supportsVolume, restricted }] }`. ID perangkat hanya untuk pengontrol |
| `POST /api/spotify/playlists` | write-side | ✓ | ✓ | ✗ | `{ offset? }` → `{ items: [{ id, name, tracks, artId }], next }`. Cache 5 menit, `limit=50` |
| `POST /api/spotify/control` | write | ✓ | ✓ | ✗ | `{ action, … }` (§2.2) → `publicState()` setelah poll cepat |
| `POST /api/spotify/config` | laptop | ✓ | ✗ | ✗ | `{ clientId?, settings? }` (kosong = baca) → `{ clientIdSet, clientIdHint: "…cdef", clientIdSource, redirectUri, connected, displayName, settings }` |
| `POST /api/spotify/login` | laptop | ✓ | ✗ | ✗ | `{ switchAccount? }` → `{ url }`. 409 kalau Client ID belum diisi |
| `POST /api/spotify/logout` | laptop | ✓ | ✗ | ✗ | `{}` → `{ ok }` |
| `GET /spotify/callback` | laptop | ✓ | 404 | 404 | §1.3 |

Playlist dan perangkat **tidak dibuka di WiFi** karena nama playlist privat termasuk data pribadi dan tidak perlu terlihat lewat HTTP yang bisa disadap. Status (judul lagu yang sedang diputar) memang sudah terdengar di ruangan.

### 2.2 `control` — kontrak

```js
// Semua input divalidasi; ID harus ada di cache terakhir (devices / playlists), bukan sekadar cocok regex.
{ action: 'play' }                                   // PUT /v1/me/player/play           (lanjutkan)
{ action: 'pause' }                                  // PUT /v1/me/player/pause
{ action: 'next' } | { action: 'previous' }          // POST /v1/me/player/next|previous
{ action: 'volume', volume: 0..100 }                 // PUT /v1/me/player/volume?volume_percent=
{ action: 'transfer', deviceId, play?: boolean }     // PUT /v1/me/player  { device_ids: [id], play }
{ action: 'playlist', playlistId, deviceId? }        // PUT /v1/me/player/play?device_id=  { context_uri: 'spotify:playlist:<id>' }
```

- `deviceId`: `/^[\w-]{1,128}$/` + harus ada di daftar `devices` terakhir (≤ 5 menit). `playlistId`: `/^[A-Za-z0-9]{22}$/` + harus ada di cache playlist. URI dibentuk server, **bukan** dari klien.
- `volume`: integer 0–100. Server menggabungkan request volume (yang terakhir menang, maksimal 1 request per 300 ms ke Spotify).
- Setelah write: poll di +400 ms dan +1500 ms (state Spotify sering tertinggal), lalu kembali ke jadwal normal.
- Kontrol tidak dicoba ulang otomatis kecuali kasus 401 → refresh (§1.5). Kontrol yang dobel (mis. `next` dua kali) lebih buruk daripada kontrol yang gagal.

### 2.3 Polling

```
viewers = hub.clients.size > 0          (setiap stream SSE terbuka, termasuk HP)
jadwal:
  tidak terhubung / tanpa viewer          → tanpa timer (poll langsung saat ada stream baru: spotify.wake())
  playing                                 → min(5 s, sisa durasi lagu + 750 ms)
  paused / tanpa perangkat (204)          → 20 s; 60 s setelah 10 menit tanpa perubahan
  error network / 5xx                     → backoff 5 → 10 → 20 → 40 → 120 s (maks), reset saat sukses
  blockedUntil (429)                      → timer di blockedUntil + jitter 0–2 s
```
- Satu request di udara pada satu waktu (single-flight). Timer memakai `unref()`. `stop()` dipanggil saat shutdown.
- Broadcast `spotify` **hanya kalau ada perubahan** (status, item, device, volume, `isPlaying`, atau loncatan progress > 3 s). Progress diinterpolasi di klien dari `{ progressMs, at }`, jadi tidak ada broadcast tiap 5 s untuk lagu yang sama.
- `GET /v1/me/player?additional_types=episode` supaya podcast juga tampil (`kind: 'episode'`).

### 2.4 Rate limit, timeout, error

| Kondisi Spotify | Deteksi | `publicState().error.code` | Perilaku |
|---|---|---|---|
| 429 | status 429, `Retry-After` (detik; tidak ada → 30 s) | `rate-limited` (+ `until`) | `blockedUntil` global; read memakai cache, write → 503 `{ error, retryAfter }`. `Retry-After` > 1 jam tetap dihormati dan ditampilkan sebagai jam |
| Tanpa perangkat aktif | `GET /me/player` 204, atau 404 `NO_ACTIVE_DEVICE` | `no-device` | UI menawarkan pemilih perangkat ("Buka Spotify di HP/PC, lalu pilih di sini") |
| Bukan Premium | 403 `reason: PREMIUM_REQUIRED` | `premium` | Kontrol dinonaktifkan; now-playing tetap jalan |
| Perangkat terbatas | `device.is_restricted` atau 403 lain | `restricted` | Kontrol nonaktif untuk perangkat itu |
| Token dicabut | refresh `invalid_grant` | `revoked` → status `disconnected` | §1.5 |
| Jaringan / timeout / 5xx | `AbortError`, `fetch` throw, 5xx | `network` | Backoff; state terakhir tetap tampil dengan label "terakhir diperbarui hh:mm" |
| Private session / iklan | `item: null` atau `currently_playing_type: 'ad'` | – | `track: { kind: 'ad' }` atau "Sesi pribadi" |

- Setiap fetch: `AbortSignal.timeout(8000)` (token: 10000), `redirect: 'error'`. Body dibaca dengan **batas** (JSON 1 MB, gambar 512 KB); lewat batas → batalkan dan anggap `network`.
- Pesan error untuk browser berbahasa Indonesia dan generik. Body respons Spotify **tidak pernah** diteruskan atau di-log utuh.

### 2.5 Album art: proxy vs izinkan CDN

| Kriteria | **Proxy via server (DIPILIH)** | Tambah `https://i.scdn.co` ke `img-src` |
|---|---|---|
| CSP | Tidak berubah (`blob:` sudah diizinkan) | Melonggarkan CSP global; CDN lain (`mosaic.scdn.co`, `*.spotifycdn.com`) ikut perlu ditambahkan |
| Privasi HP | HP hanya bicara dengan laptop | HP (juga lewat WiFi) menghubungi CDN Spotify langsung |
| SSRF | Klien hanya mengirim `id` opaque; URL berasal dari respons Spotify dan host di-allowlist | Tidak relevan |
| Biaya | ~60 LOC, cache LRU di memori | 1 baris |
| Offline Tailscale-only (HP tanpa internet) | Tetap jalan | Gambar rusak |

Rincian proxy:
- Dari `album.images` (atau `show.images` / `playlist.images`) dipilih gambar terkecil yang ≥ 64 px (biasanya 300 px). URL harus `https:` dengan host di `ART_HOSTS = {i.scdn.co, mosaic.scdn.co, image-cdn-ak.spotifycdn.com, image-cdn-fa.spotifycdn.com}`. Host lain → `artId: null` (placeholder piringan hitam pixel).
- `artId = sha256(url).slice(0, 16)`. Map `artId → url` hanya diisi dari respons Spotify (maks. 200 entri). Byte cache LRU 20 gambar.
- Validasi respons: `Content-Type` ∈ {jpeg, png, webp} **dan** magic bytes cocok, ≤ 512 KB. Header balasan: `Content-Type` hasil validasi, `Cache-Control: private, max-age=86400`, `nosniff` (sudah global).
- Klien: `api('/api/spotify/art', { id }, { raw: true })` → `blob` → `URL.createObjectURL`, dicabut saat art berganti. Map `artId → objectURL` di klien supaya art tidak diunduh ulang.

### 2.6 Kontrak `publicState()` (SSE `spotify` + snapshot + `/state`)

```js
{
  status: 'unconfigured' | 'disconnected' | 'idle' | 'playing' | 'paused',
  error: null | { code: 'no-device'|'premium'|'restricted'|'rate-limited'|'network'|'revoked'|'no-app'|'launch-timeout', message: string, until?: number },
  track: null | { kind: 'track'|'episode'|'ad', title: string, artists: string, album: string, artId: string|null, durationMs: number },
  progressMs: number, at: number,          // at = Date.now() server saat progress diukur (interpolasi klien)
  device: null | { name: string, type: string, volume: number|null, supportsVolume: boolean },
  office: boolean,                         // settings.office: tampilkan radio/ticker di kantor
  launching: boolean,                      // server sedang membuka aplikasi Spotify di laptop (§2.8), selalu berakhir
  updatedAt: number,
}
```
- **Tidak ada**: token, Client ID, URI/ID track, album, playlist, perangkat, maupun nama akun. Test mengecek ini dengan memindai key dan nilai secara rekursif (§9).
- Semua string dipotong 200 karakter. Klien merender **hanya lewat `textContent`**, karena judul lagu adalah input yang tidak tepercaya.
- Snapshot SSE mendapat field `spotify` (satu baris di `openStream`), jadi halaman baru langsung punya state tanpa request.

### 2.7 Perangkat utama (★)

- `data/spotify.json` menyimpan `preferredDevice: { id, name, type } | null` (di samping `settings`, bukan di dalamnya, supaya `/settings` tidak pernah mengirim id perangkat). Isinya diperbarui setelah `transfer`, `play`, atau `playlist` berhasil: perangkat tujuan, atau perangkat yang aktif menurut Spotify. File hanya ditulis kalau nilainya berubah.
- `POST /devices` → `{ devices: [{ …, preferred: boolean }], preferred: null | { name, type, available } }`.
- `POST /control { action: 'prefer', deviceId: string | null }` ("Selalu putar di sini"): hanya disimpan, tanpa request ke Spotify. `deviceId` harus ada di daftar perangkat terakhir; `null` menghapus ★. Balasan: `publicState()`.
- id perangkat tidak pernah masuk `publicState()`.

### 2.8 ▶ tanpa perangkat aktif: pilih otomatis, lalu buka Spotify di latar belakang

Berlaku untuk `play` dan `playlist` tanpa `deviceId`. Kalau masih ada perangkat aktif, ini cuma play biasa. Kalau perangkat aktif ternyata sudah hilang (balasan 404), langsung ke langkah di bawah.
1. Ambil `/me/player/devices`. Kalau ada yang aktif, play biasa.
2. Tepat **satu** perangkat yang bisa dipakai (tidak `restricted`) → transfer + play di perangkat itu.
3. Kalau tidak, dan perangkat ★ tersedia → pakai perangkat ★.
4. Tidak ada perangkat sama sekali, **atau** ★ bertipe `computer` (laptop ini) tetapi tidak tersedia → buka aplikasi di laptop, dengan syarat: request datang dari laptop atau HP lewat Tailscale (`ctx.canManageAccount(req)` → `allowLaunch`; WiFi biasa sudah ditolak gerbang read-only), `settings.autoLaunch` aktif (default ON; laptop lewat `/config`, HP Tailscale lewat `/settings`), dan server punya launcher (`null` di mode test).
5. Selain itu, error `pick-device` (409: ada beberapa perangkat, pilih satu atau tandai ★) atau `no-device` (404).

Membuka aplikasi (`src/spotify-launcher.js`, tanpa shell, argumen tetap):
- Windows (a): `%APPDATA%\Spotify\Spotify.exe --minimized` lewat `execFile` (`windowsHide`, `detached`, `unref`).
- Windows (b), versi Microsoft Store: folder `%LOCALAPPDATA%\Packages\SpotifyAB.SpotifyMusic_<publisher>` (nama divalidasi regex) → AUMID `<family>!Spotify` → `explorer.exe shell:AppsFolder\<AUMID>`. Versi Store tidak menerima argumen, jadi jendelanya bisa muncul. Setelah perangkatnya terdeteksi, PowerShell tersembunyi dengan skrip tetap (tanpa input user, timeout 5 s) memanggil `ShowWindowAsync(MainWindowHandle, 6)` (SW_MINIMIZE, fokus kembali ke jendela sebelumnya). Langkah ini opsional (`createSpotifyLauncher({ minimizeStoreWindow: false })`) dan best effort.
- (c) Tidak terpasang → `no-app` (404): "Pasang Spotify, atau buka Spotify di HP/PC lain lalu pilih di sini."
- macOS: `open -g -a Spotify`. Linux/lainnya: tidak membuka apa pun (→ `no-device`).
- Aplikasi dibuka paling sering sekali per `launchGapMs` = 30 s. ▶ kedua dalam rentang itu hanya ikut menunggu. Prosesnya single-flight: ▶ yang datang bersamaan berbagi satu proses buka dan satu masa tunggu.
- Masa tunggunya terbatas: polling `/me/player/devices` tiap `launchPollMs` = 1 s, paling lama `launchWaitMs` = 20 s (dibatasi tenggat waktu **dan** jumlah poll). Tiap poll kena timeout request yang sama dan blok 429 global (429 langsung menghentikan tunggu). Yang dicari: perangkat ★ bertipe computer, perangkat computer yang namanya sama dengan hostname, perangkat computer baru, atau satu-satunya perangkat kalau sebelumnya kosong. Sesudah ketemu: transfer + play (atau putar playlist dengan `device_id`), dengan retry 404 maksimal 2 kali. Kalau tidak ketemu: `launch-timeout` (504).
- Selama proses, `publicState().launching = true` (SSE). Setelah selesai, nilainya selalu `false`. Error `no-app`/`launch-timeout` juga masuk `publicState().error` sampai poll berikutnya.
- UI: pill dan dialog menampilkan "Membuka Spotify di latar belakang…" (teks miring, tanpa spinner) dan tombol menunggu. ▶ tetap aktif saat tidak ada perangkat aktif (pill, dialog, 🗂, Ctrl+P). Daftar perangkat menampilkan "★ utama" dan tombol ☆ "Selalu putar di sini". Opsi ⚙ "Buka Spotify otomatis di latar belakang". Kalau balasan error datang tanpa event SSE, klien sendiri yang mematikan `launching`.

---

## 3. Struktur modul

### 3.1 `src/spotify.js` (service)

```js
export const SPOTIFY_SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private'];
export class SpotifyError extends Error { /* code, status, retryAfter */ }

export class SpotifyService {
  /**
   * @param {object} o
   * @param {string} o.file                 data/spotify.json
   * @param {string} o.redirectUri          http://127.0.0.1:<PORT>/spotify/callback
   * @param {() => number} o.viewers        jumlah stream SSE (hub.clients.size)
   * @param {(state) => void} o.onChange    → hub.broadcast('spotify', state)
   * @param {string} [o.envClientId]        process.env.SPOTIFY_CLIENT_ID
   * @param {string} [o.accountsOrigin]     default https://accounts.spotify.com   (test: fake)
   * @param {string} [o.apiOrigin]          default https://api.spotify.com         (test: fake)
   * @param {Set<string>} [o.artHosts]
   * @param {typeof fetch} [o.fetch]        default globalThis.fetch
   * @param {() => number} [o.now]
   * @param {object} [o.timing]             { playMs: 5000, pausedMs: 20000, … } (test: diperkecil)
   */
  constructor(o) {}
  start(); stop(); wake();                 // wake: dipanggil openStream
  publicState(); config(); setConfig({ clientId, settings });
  startLogin({ returnOrigin, switchAccount }); // → { url }
  finishLogin({ code, state, error });     // → { ok } | { error: 'invalid-state'|'denied'|'exchange' }
  logout();
  devices(); playlists({ offset }); control(body); art(id);   // → { type, bytes }
  observeApproval(type, data, pendingCount); // D12
}
```
- Murni Node (`node:crypto`, `node:fs/promises`, global `fetch`), tanpa akses ke `hub`. Semua dependensi diinjeksi supaya bisa diuji tanpa server.
- Semua URL keluar dibentuk dari `accountsOrigin`/`apiOrigin` + path konstan + parameter yang di-`encodeURIComponent`. Sebelum fetch ada `assertAllowed(url)`, yang mencocokkan origin dengan Set yang diisi di konstruktor.

### 3.2 `src/routes/spotify.js` (route module)

```js
// ---------- Spotify (♪) ----------
// state/art: read (allowed over WiFi, src/remote.js). devices/playlists/control: laptop + Tailscale.
// config/login/logout: laptop only (LOCAL_ONLY in server.js). GET /spotify/callback: laptop only, non-API (server.js).
export function register(router) { /* router.post('/api/spotify/…', handler) × 8 */ }
/** GET /spotify/callback — called by server.js for a local GET only; never throws (the URL holds the code). */
export async function callback(ctx, req, res, url) {}
```
- `SpotifyError` dipetakan ke `json(res, status, { error, code, retryAfter })`: 409 unconfigured/disconnected, 403 premium/restricted, 404 no-device, 503 rate-limited, 502 network.
- `callback` menangkap **semua** error sendiri. Penting: catch generik di `handler()` me-log `req.url`, padahal URL callback berisi `code` dan `state`.

---

## 4. Keamanan

| Ancaman | Mitigasi |
|---|---|
| CSRF pada callback / login CSRF | `state` 256-bit, sekali pakai, TTL 10 menit, dibandingkan dengan `timingSafeEqual`, dan hanya bisa dibuat lewat `POST /api/spotify/login` (token per-start + `LOCAL_ONLY`). PKCE S256 mengikat `code` ke verifier yang hanya ada di memori server |
| Token bocor ke browser / HP | Token hanya ada di `SpotifyService` dan file. `publicState()` disaring (D6) dan ada test pemindaian rekursif |
| Token bocor ke backup | File terpisah di luar daftar backup + test zip |
| Token/code di log | Tidak pernah me-log token, `code`, `verifier`, header `Authorization`, body token, atau URL callback. Log Spotify memakai format tetap: `Spotify: <aksi> gagal (<status>/<code>)`. `callback` tidak pernah melempar ke catch generik. Test memindai stdout server untuk token/code dari fake |
| WiFi (HTTP yang bisa disadap) | `wifiAllows` hanya ditambah `/api/spotify/state` dan `/api/spotify/art`. Yang lain otomatis ditolak (allowlist) |
| Konfigurasi dari HP | `config`/`login`/`logout` masuk `LOCAL_ONLY`. Callback `!isLocal` → 404 |
| Origin / DNS rebinding | Gerbang yang ada (`allowedHosts`, cek `Origin`) berlaku. Callback berupa navigasi GET (browser tidak mengirim `Origin`), dilindungi `state` |
| SSRF | Origin keluar tetap (konstruktor), `redirect: 'error'`, ID tervalidasi + harus ada di cache, URL gambar hanya dari respons Spotify + allowlist host, klien hanya mengirim `artId` |
| DoS ke Spotify lewat HP | `/state` coalesced (≥ 2 s), polling single-flight, volume digabung, 429 global |
| XSS lewat metadata lagu | Hanya `textContent`/`aria-label` (atribut, bukan HTML); string dipotong |
| Test hook disalahgunakan | Hanya `http://127.0.0.1:<port>`; token terikat origin (§1.4); peringatan di log saat aktif |

---

## 5. Notifikasi, quiet hours, "kecilkan saat izin"

- Integrasi Spotify **tidak pernah** membuat notifikasi, suara, atau toast saat lagu berganti. Error kontrol hanya tampil sebagai toast untuk aksi user sendiri.
- **Duck** (D12), setting `duck: 'off' | 'duck' | 'pause'`, `duckVolume` 0–50 (default 20):
  - Observer `hub.observers` menerima `approval`. Hitung jumlah approval pending (`hub.approvals.size`).
  - 0 → ≥1 dan `status === 'playing'`: `duck` simpan `{ deviceName, prevVolume }` lalu set volume ke `duckVolume`; `pause` simpan `{ deviceName, title }` lalu pause.
  - ≥1 → 0, didebounce 1.5 s supaya izin beruntun tidak naik-turun: pulihkan **hanya kalau** user tidak mengubah apa pun. Untuk `duck`: perangkat sama dan volume masih `duckVolume`. Untuk `pause`: masih paused dan judul sama. Kalau tidak, memori duck dibuang diam-diam.
  - Perangkat tanpa `supportsVolume` → mode `duck` jatuh ke "tidak melakukan apa-apa" (bukan pause, untuk menghindari kejutan).
- **Quiet hours** (aturan klien di `notify-rules.js`) tidak memengaruhi duck. Duck menyangkut audio user sendiri, bukan notifikasi kantor. Server memang tidak tahu pengaturan quiet hours, dan ini disengaja.
- Setting duck ada di ⚙ (laptop-only, satu endpoint `config`). Pertanyaan terbuka Q5: perlu dibuka juga untuk HP Tailscale?

---

## 6. UI

### 6.1 Radio di kantor (lantai 640×344)

- **Posisi: di atas coffee table lounge.** Meja di `(580, 212, 40×10)`, sofa di `(568, 176, 64×20)`, kursi sofa di `(584|600|616, 204)`. Radio retro 14×9 px digambar di **x 603–616, y 204–212**, berdiri di permukaan meja. Tidak perlu blocker baru (sudah tertutup blocker meja) dan karakter yang duduk di sofa terlihat "mendengarkan". Pantry (counter, kulkas, dispenser, cafe table) sudah padat, jadi bukan pilihan.
- Layer statis (`world.js`, `add(222+, …)`): body radio, speaker grille dan antena, sesuai palet tema (`themes.js`; tema Natal/Lebaran/Agustus boleh memberi warna sendiri lewat decor-*). Layer hidup (`stage.js`): LED hijau menyala saat `playing`, 2–3 not ♪ melayang naik (satu per ~900 ms, pudar dalam 1.2 s) saat `playing`. Radio digambar diam saat paused/idle dan abu-abu saat `disconnected`.
- **A11y dan klik**: `<button class="office-radio">` HTML di atas canvas (pola `tags.js`, ikut skala stage), hit area minimal 32×32 CSS px walau stage diperkecil di 390 px. `aria-label` dinamis: "Musik: «Judul» – Artis, sedang diputar. Buka kontrol musik" / "Musik: dijeda" / "Spotify belum terhubung". Klik membuka dialog ♪ (§6.4).
- `settings.office === false` → radio tetap jadi dekor diam tanpa tombol, ticker dan goyangan.

### 6.2 Karakter bergoyang

- Hanya saat `isPlaying` dan `document.visibilityState === 'visible'`.
- Karakter yang **idle** (sofa, cafe, coffee, window, stretch, chat; bukan yang sedang bekerja di meja, berjalan, atau menunggu izin) mendapat offset y 0/−1 px dengan tempo tetap **~112 BPM** (audio-features tidak tersedia untuk app baru) dan fase acak per karakter. Per lagu, sekitar 50% karakter idle dipilih acak, sedangkan yang duduk di sofa (dekat radio) selalu ikut.
- `prefers-reduced-motion: reduce` → tidak ada goyangan dan tidak ada not melayang (LED tetap ada).
- P2 (opsional): aktivitas idle baru `radio`, yaitu berjalan ke `(596, 226)` menghadap atas lalu bergoyang 6–10 s. Hanya saat playing, dengan bobot rendah di daftar `scene.js`.

### 6.3 Header: pill now-playing

- `<button id="spotify-pill" class="spotify-pill" aria-haspopup="dialog">` disisipkan setelah `#quota-pill`, isinya `[art 16px][♪ Judul – Artis]`, ditambah `<button id="spotify-toggle">⏯</button>` terpisah (aria-label "Jeda musik"/"Putar musik").
- Teks dipotong dengan ellipsis (maks. 220 px). **Tanpa marquee**. Judul lengkap ada di `title` dan `aria-label`.
- Disembunyikan kalau `unconfigured`, atau kalau `disconnected` di HP. Di laptop, `disconnected` menampilkan pill kecil "♪ Hubungkan" yang membuka ⚙.
- ≤ 600 px (termasuk 390 px): label disembunyikan, hanya art/♪ + ⏯ (masing-masing 32 px). Mengikuti pola `.icon-btn.labeled .lbl` yang sudah ada.
- Read-only (WiFi): ⏯ disembunyikan, pill tetap membuka dialog dengan kontrol nonaktif.

### 6.4 Dialog ♪ Musik (`#spotify-modal`, `openModal`)

- Atas: art 96 px (`image-rendering: auto`), judul (h2), artis, album, nama perangkat + ikon tipe.
- Progress: `<div role="progressbar" aria-valuemin=0 aria-valuemax=durasi aria-valuenow>` + teks `1:23 / 3:45`, diinterpolasi tiap 1 s **tanpa** `aria-live`.
- Kontrol: ⏮ ⏯ ⏭ (`<button>` dengan aria-label) dan volume `<input type="range" aria-label="Volume">` (kirim setelah jeda 250 ms dan saat `change`; nonaktif kalau `!supportsVolume`).
- **Perangkat**: daftar radio button (`role="radiogroup"`), dimuat via `/devices` saat dialog dibuka dan lewat tombol "↻". Memilih perangkat memicu `transfer` (play mengikuti state saat itu). Perangkat `restricted` nonaktif.
- **Playlist**: tombol "Playlist" membuka sub-panel dalam dialog yang sama: kolom filter (client-side), daftar 50 item (art 32 px, nama, jumlah lagu, tombol ▶), "Muat lagi" (`offset`). Daftar kosong → "Belum ada playlist".
- Status/error: `<p role="status" aria-live="polite">`, mis. "Tidak ada perangkat aktif. Buka Spotify di HP/PC lalu pilih di sini." / "Butuh Spotify Premium." / "Dibatasi Spotify, coba lagi 14:32."
- Read-only: semua kontrol `disabled` + catatan `READ_ONLY_ERROR`. Keputusan "boleh atau tidak" memakai `client.readOnlyApi` yang sudah ada (pola `api.js` `setReadOnlyApi`), jadi tanpa salinan aturan.
- Laptop: tautan "⚙ Pengaturan Spotify".
- Fokus awal ke ⏯, Esc menutup, fokus kembali ke pemicu (perilaku `modals.js`).

### 6.5 🗂 Dashboard

Satu baris "♪ Musik" di bagian atas dashboard: art 32 px, judul – artis, ⏯ ⏭, tombol "Lainnya…" yang membuka dialog ♪. Render dipakai bersama: `renderNowPlaying(el, state, { compact })` di `public/js/features/spotify.js`.

### 6.6 ⚙ Pengaturan → bagian "Spotify" (laptop saja; tidak dirender di HP)

1. Langkah singkat: buat app di developer.spotify.com → tambahkan Redirect URI (ditampilkan + 📋 salin) → *Users and Access*: tambahkan email akun Spotify kamu → tempel Client ID.
2. `Client ID` (input teks, `autocomplete=off`, `spellcheck=false`). Setelah tersimpan hanya ditampilkan `••••cdef`. Kalau sumbernya env, field read-only dengan label "dari SPOTIFY_CLIENT_ID". **Tidak ada field secret.**
3. Status + tombol **Hubungkan** / **Ganti akun** / **Putuskan**, plus "Terhubung sebagai Adhit".
4. Toggle "Tampilkan di kantor" dan select "Saat ada permintaan izin: Biarkan / Kecilkan ke 20% / Jeda".

### 6.7 State kosong

| Status | Kantor | Header | Dialog |
|---|---|---|---|
| `unconfigured` | radio dekor diam | (laptop) tidak ada | – (radio membuka ⚙ di laptop, toast "Atur di laptop" di HP) |
| `disconnected` | radio abu-abu | laptop: "♪ Hubungkan"; HP: tidak ada | "Hubungkan dari laptop" |
| `idle` / `no-device` | radio diam | "♪ Tidak ada yang diputar" | pemilih perangkat ditonjolkan |
| `paused` | radio diam, LED redup | judul + ▶ | normal |
| `playing` | LED + not + goyang | judul + ⏸ | normal |
| `rate-limited` / `network` | state terakhir | state terakhir + ⚠ kecil | pesan + jam |

---

## 7. Wiring di `server.js` dan file yang berubah

Dikerjakan setelah pemecahan `src/routes/*` selesai. Ukurannya sekitar 15 baris.

| File | Perubahan |
|---|---|
| `src/spotify.js` | **baru**: service (§3.1) |
| `src/routes/spotify.js` | **baru**: route + `callback` (§3.2) |
| `src/routes/index.js` | tambah `spotify` ke daftar `register` |
| `src/remote.js` | `WIFI_READ_GLOBAL` += `/api/spotify/state`, `/api/spotify/art` (+ satu baris komentar) |
| `server.js` | `LOCAL_ONLY` += `/api/spotify/config`, `/api/spotify/login`, `/api/spotify/logout`; buat `new SpotifyService({ file: path.join(DATA_DIR, 'spotify.json'), redirectUri: \`http://127.0.0.1:${PORT}/spotify/callback\`, viewers: () => hub.clients.size, onChange: (s) => hub.broadcast('spotify', s), envClientId: process.env.SPOTIFY_CLIENT_ID, ...spotifyTestHook() })`; `ctx.spotify`; `hub.observers.add(...)` untuk duck; `openStream`: `spotify: spotify.publicState()` di snapshot + `spotify.wake()`; `handler`: `if (local && req.method === 'GET' && pathname === '/spotify/callback') return spotifyCallback(ctx, req, res, url)` **sebelum** `serveStatic`; `shutdown`: `spotify.stop()` |
| `public/js/features/spotify.js` | **baru**: pill, dialog, dashboard row, ⚙ section, cache art blob |
| `public/js/core/state.js` / `stream.js` | simpan `state.spotify` dari snapshot + event `spotify` |
| `public/js/office/world.js` | sprite radio (statis) |
| `public/js/office/stage.js` / `scene.js` | LED, not ♪, offset goyang, (P2) aktivitas `radio` |
| `public/js/office/tags.js` | tombol overlay radio |
| `public/index.html`, `public/css/*` | `#spotify-pill`, `#spotify-toggle`, `#spotify-modal`, bagian ⚙ |
| `test-support/fake-spotify.mjs` | **baru** (§9.1) |
| `README.md` | bagian "Spotify" (setup, privasi, batasan HP/WiFi) |

---

## 8. Ketergantungan waktu tunggu (tanpa tunggu tanpa batas)

- Setiap fetch keluar punya `AbortSignal.timeout`. Refresh single-flight ikut di-timeout (promise refresh selesai dalam ≤ 10 s, berhasil atau gagal).
- Flow login: TTL 10 menit, dibersihkan oleh timer `unref()`.
- Poller: tidak ada loop `while`; satu `setTimeout` berikutnya dijadwalkan di `finally`.
- Test: setiap tunggu memakai deadline (pola `cdp.mjs`/`waitFor` dengan timeout). Fake server punya mode "hang" untuk menguji timeout dengan `timing.requestMs` kecil (mis. 200 ms).

---

## 9. Test

### 9.1 Fake Spotify: `test-support/fake-spotify.mjs`

Server `node:http` di `127.0.0.1:0`, diekspor sebagai `startFakeSpotify({ scenario }) → { origin, log, set(patch), close() }`. Juga bisa dijalankan sebagai proses anak untuk test UI.
- `GET /authorize` → validasi parameter, lalu **langsung** 302 ke `redirect_uri?code=…&state=…` (persetujuan otomatis). Skenario `deny` → `?error=access_denied`.
- `POST /api/token` → verifikasi `S256(code_verifier) === code_challenge`, `client_id`, `redirect_uri` persis sama, `code` sekali pakai. Mengeluarkan token dan **merotasi** refresh token. Skenario `invalidGrant`.
- `GET /v1/me`, `/v1/me/player` (200 / 204), `/v1/me/player/devices`, `/v1/me/playlists`; `PUT|POST` kontrol mengubah state skenario. `GET /img/<n>.jpg` (JPEG kecil yang valid).
- Skenario: `rateLimit: { retryAfter }`, `premiumRequired`, `noDevice`, `expireNow`, `hang`, `badImageType`, `bigImage`.
- `log`: setiap request (method, path, header `authorization` ada atau tidak). Dipakai untuk assert "tidak ada pertukaran token saat state salah" dan "tidak ada request selama diblokir".

**Injeksi**:
- Unit dan route test: `new SpotifyService({ accountsOrigin: fake.origin, apiOrigin: fake.origin, artHosts: new Set(['127.0.0.1:<port>']), timing: {…} })`. Route test memakai `buildRouter()` + `ctx` buatan, tanpa `server.js`.
- Test server/UI (proses `server.js`): `spotifyTestHook()` membaca `OFFICE_SPOTIFY_TEST_ORIGIN`, **hanya** diterima kalau cocok `^http://127\.0\.0\.1:\d{2,5}$` (selain itu diabaikan + peringatan). Hook ini mengganti kedua origin dan `artHosts`, lalu log berisi `Spotify: MODE TEST (<origin>)`. Kombinasi dengan §1.4 (token terikat origin) membuat hook ini tidak bisa mengirim token asli ke mana pun. Ini setara dengan preseden `OFFICE_HTTPS_TEST_BIND`. Kalau Lead menolak env sama sekali, lihat Q8.

### 9.2 Daftar test

| File | Test |
|---|---|
| `test/spotify.test.mjs` (unit) | PKCE: vektor RFC 7636 App. B (`dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`), panjang dan charset verifier; URL authorize memuat scope minimal dan `S256`; state: cocok / salah / dipakai ulang / kedaluwarsa (`now` palsu); exchange lalu file tersimpan atomik tanpa `clientSecret`; refresh 60 s sebelum kedaluwarsa; **refresh single-flight** (5 panggilan bersamaan = 1 request token); rotasi refresh tersimpan; `invalid_grant` → `disconnected` + `auth` terhapus; 401 → refresh + ulang tepat sekali; **429** → `blockedUntil`, tidak ada request selama blokir (log fake), write → 503 + `retryAfter`; cadence polling (playing 5 s, sisa lagu, paused 20 s, tanpa viewer 0 request); mapping 204 / `NO_ACTIVE_DEVICE` / `PREMIUM_REQUIRED` / episode / ad / `item: null`; `publicState()` **dipindai rekursif**: tidak ada token, `uri`, `id`, `spotify:`, Client ID, displayName; validasi `deviceId`/`playlistId` (regex + harus ada di cache, `spotify:track:x` ditolak); art: host di luar allowlist → `artId: null`, Content-Type/magic salah → ditolak, > 512 KB → dibatalkan; timeout (skenario `hang`) selesai < 1 s dengan `timing` kecil; file rusak → `.corrupt-*`; token dari origin lain dibuang saat load; duck/pause + pemulihan + "user mengubah volume, jangan pulihkan" + debounce |
| `test/spotify-routes.test.mjs` | `buildRouter()` memuat 8 route `/api/spotify/*`; pemetaan `SpotifyError` → status; `callback` dengan state salah → 400 tanpa request token; `callback` tidak pernah melempar |
| `test/remote.test.mjs` (tambahan) | `wifiAllows('/api/spotify/state')` dan `art` = true; `control`, `devices`, `playlists`, `config`, `login`, `logout` = false; `WIFI_READ_API` ikut memuatnya |
| `test/server.test.mjs` (tambahan, proses nyata + fake) | Alur OAuth penuh: POST login → ikuti `url` ke fake `/authorize` → 302 → GET callback di `127.0.0.1` → event SSE `spotify` status `playing`; HP **WiFi**: `state` 200, `control`/`devices`/`playlists` 403 `readOnly`; HP **Tailscale**: `control` 200, `config`/`login`/`logout` 403 laptop-only; callback dari non-loopback → 404; **`data/spotify.json` tidak ada di zip `/api/backup/export`** dan `state.json` tidak memuat key `spotify`; stdout server tidak memuat access/refresh token atau `code` dari fake; snapshot SSE memuat `spotify` tanpa token |
| `test/ui.test.mjs` / `queue-ui`-style CDP | Fake now-playing (judul berisi `<img src=x onerror=…>`, tampil sebagai teks); pill memperlihatkan judul dan `aria-label` radio; ⏯ mengirim `control` lalu fake berubah ke paused; mode read-only: kontrol `disabled`, tidak ada request `control`; 390 px: tidak ada overflow horizontal di header, pill hanya ikon; `prefers-reduced-motion` (CDP `Emulation.setEmulatedMedia`): tidak ada offset goyang/not; `unconfigured` → pill tidak ada |

Semua test proses memakai `OFFICE_DATA_DIR` sementara dan deadline (sesuai memori tim: tanpa tunggu tanpa batas, isolasi `none`).

---

## 10. Urutan pengerjaan per role

| # | Role | Pekerjaan | Bergantung pada |
|---|---|---|---|
| 1 | Backend | Verifikasi fakta §1.1 di dokumentasi Spotify terbaru (PKCE, loopback, dev mode, `additional_types`) dan catat bedanya di dokumen ini | – |
| 2 | Backend | `test-support/fake-spotify.mjs` + `src/spotify.js` (store, PKCE, token, poller, control, art, duck) + `test/spotify.test.mjs` | 1 |
| 3 | Backend | `src/routes/spotify.js` + `test/spotify-routes.test.mjs` | 2 |
| 4 | Backend (setelah pemecahan server.js masuk) | Wiring §7 (`server.js`, `index.js`, `remote.js`), test hook, test server | 3 + pemecahan |
| 5 | UI/UX | Sprite radio 14×9 per tema, not ♪, mock pill/dialog 390 px dan desktop, teks state kosong (ID) | paralel dengan 2 |
| 6 | Frontend | `features/spotify.js` (pill, dialog, perangkat, playlist, dashboard, ⚙), `state.spotify`, cache art blob | kontrak §2.6 (bisa pakai fake state sebelum 4) |
| 7 | Frontend | Radio di `world.js`/`stage.js`/`tags.js`, goyangan di `scene.js`, reduced-motion | 5 |
| 8 | QA | Test UI CDP §9.2, uji manual dengan Spotify asli (PC + HP sebagai perangkat Connect, Tailscale, WiFi) | 4, 6, 7 |
| 9 | Security | Review: log (grep token/code), `publicState`, gerbang WiFi/LOCAL_ONLY, test hook, backup | 4 |
| 10 | Writer | README "Spotify": setup langkah demi langkah, Redirect URI persis, privasi (apa yang terlihat lewat WiFi), cara mencabut akses | 4 |

Perkiraan: backend ±600 LOC + 500 LOC test, frontend ±450 LOC + CSS.

---

## 11. Pertanyaan terbuka

| # | Pertanyaan | Usulan default |
|---|---|---|
| Q1 | Syarat Development Mode Spotify saat ini (jumlah user, wajib Premium untuk pemilik app, endpoint yang dibatasi). Apakah `/me/playlists` dan kontrol player masih tersedia untuk app dev-mode baru? | Verifikasi di langkah 1. Kalau dibatasi, playlist menjadi fitur opsional |
| Q2 | Apakah loopback boleh memakai port dinamis (didaftarkan tanpa port)? | Tidak bergantung pada itu: daftarkan URI persis dengan port, tampilkan di ⚙ |
| Q3 | Playlist kolaboratif ikut tampil (`playlist-read-collaborative`)? | Tidak untuk v1 |
| Q4 | `user-read-currently-playing` tetap diminta (keputusan awal Lead)? | Hapus, karena redundan |
| Q5 | Setting duck dan "tampilkan di kantor" boleh diubah dari HP Tailscale? | Tidak; satu endpoint `config` laptop-only |
| Q6 | Playlist milik Spotify (editorial/algoritmik, mis. Discover Weekly) tidak lagi muncul atau bisa diakses untuk app baru sejak Nov 2024. Perlu pesan khusus? | Cukup tidak tampil; tanpa pesan |
| Q7 | "Viewer" = setiap stream SSE, termasuk tab tersembunyi. Perlu sinyal visibilitas dari klien untuk menghemat polling? | Tidak untuk v1 (interval paused 20–60 s sudah murah) |
| Q8 | Test hook env loopback-only diterima? Alternatifnya `server.js` diekspor sebagai factory (`createOffice(config)`), yang merupakan refactor besar | Terima hook env loopback-only + token terikat origin |
| Q9 | Login dari HP Tailscale lewat redirect HTTPS MagicDNS (§1.7)? | Tidak; tunda ke v2 kalau benar-benar diminta |
