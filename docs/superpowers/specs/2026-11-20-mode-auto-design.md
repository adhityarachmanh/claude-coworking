# Mode ketiga "Auto" (OpenCode dan Claude Code) — design

Tanggal: 2026-11-20
Status: menunggu persetujuan

## Kenapa

Sesi Adhitron berjalan di bawah mesin OpenCode milik aplikasi (`OFFICE_MANAGED=1`), dan aplikasi mengirim
`OPENCODE_CONFIG_CONTENT` dengan `permission: { edit: 'allow', bash: 'ask', webfetch: 'ask' }` (mode **Build**).
Akibatnya setiap perintah shell dan setiap `webfetch` memunculkan kartu izin, walau user sudah menyalakan izin
global `allow` di `~/.config/opencode/opencode.json`: `mergePermission` (src/opencode-bin.js) menahan aturan user
agar **tidak pernah melonggar** dari mode. Kebutuhan nyatanya: satu cara yang sah untuk "kerjakan saja, jangan
tanya tiap langkah" tanpa menonaktifkan pengaman yang ada.

Upstream sudah menyediakan bentuk resminya di kedua engine:

- **OpenCode** (`opencode --help`, 2.3.2): `--auto = Auto-approve permissions that are not explicitly denied`.
- **Claude Code** (`claude --help`, 2.1.328): `--permission-mode auto` — classifier latar meninjau aksi alih-alih
  user; deny tetap menang; **default upstream** sejak 2.1.283. `bypassPermissions` sengaja **tidak** ditawarkan.

Aplikasi sendiri pernah punya mode `auto`, lalu dilebur ke `build` (1.0.x) dan kini hanya mengenal `build`/`plan`
(src/modes.js). Jadi mode `auto` bukan hal asing: kita mengembalikannya sebagai mode tersimpan ketiga yang resmi.

## Tujuan

- Satu mode tersimpan ketiga, **Auto**, untuk **kedua** engine (Claude + OpenCode), satu kosakata di UI dan di
  `state.json`.
- Auto = "lanjut tanpa bertanya tiap langkah": OpenCode tanpa kartu izin untuk shell/web; Claude memakai classifier
  bawaannya.
- Aturan `deny`, file rahasia (`.env`), dan pengaman lain tetap otoritatif.

## Non-tujuan

- Tidak menambah `bypassPermissions` (melewati semua pemeriksaan) atau `--dangerously-skip-permissions`.
- Tidak menghapus `autoApprove` per-sesi (tombol "Izinkan semua (sesi ini)") — ia tetap ada untuk sesi build biasa.
- Tidak mengubah alur Plan.

## Anti-tujuan (gagal kalau terjadi)

- Mode lama yang tersimpan sebagai string `auto` (dari versi app yang dulu) berubah diam-diam menjadi Auto baru
  sehingga permission jadi lebih longgar tanpa persetujuan.
- `deny` user bisa ditembus di mode Auto.
- Mode Auto membuat `.env` dan file rahasia terbaca otomatis.

## Batasan

- `isMode` saat ini menerima hanya `build`/`plan`; jalur tulis menolak yang lain (`hub.cleanSettings`).
- `migrateMode` memetakan `auto`(lama) → `build`. Pemetaan itu harus **tetap**, agar nilai lama tidak menjadi Auto
  baru.
- `openCodeConfigContent` membangun `permission` dari `permissionConfig(mode)`; `mergePermission` sudah mengenal
  `mode === 'auto'` (ask→allow) — hanya jalurnya belum pernah aktif.
- `claudePermissionMode` memetakan ke `acceptEdits` atau `plan`; perlu cabang `auto`.

## Pendekatan yang dipertimbangkan

1. **Mode ketiga "Auto" untuk dua engine** (dipilih). Satu kosakata, per-project, paling dekat dengan cara kedua
   CLI upstream berpikir. Menyentuh migrasi mode, picker, Shift+Tab, dan satu jalur tes per engine.
2. **Toggle terpisah "Izinkan otomatis shell & web"** di Pengaturan giliran. Perubahan mental lebih kecil, tetapi
   menghasilkan dua kontrol yang saling berinteraksi (Plan + auto = kontradiksi) dan tidak lazim dibanding upstream.
3. **Auto khusus OpenCode saja.** Radius paling kecil, tetapi dua engine berperilaku beda untuk label yang sama.

User memilih **1**.

## Jawaban atas temuan builder-check (2026-11-20)

`migrateModes()` (src/hub.js) berjalan **setiap** load dan memanggil `migrateMode(raw.mode)`. Karena
`migrateMode('auto')` (nilai legacy, artinya dulu auto-edit) → `build`, menaruh mode baru pada string `'auto'`
akan: (a) **menulis ulang Auto baru kembali ke build** pada restart, dan (b) membuat cabang legacy di
`cleanSettings` (`patch.mode === 'auto' → 'build'`) menjadi *dead code*, sehingga tab lama yang mengirim
`mode:'auto'` (auto-edit) justru tersimpan sebagai Auto yang lebih longgar — tepat di anti-tujuan #1.

**Keputusan: mode baru memakai nilai tersimpan yang belum pernah dipakai versi lama**, yaitu `'autopilot'`
(label UI tetap **⚡ Auto**). Dengan itu:

- `migrateMode('auto')` tetap → `build` (legacy, tidak pernah menjadi Auto); `migrateMode('autopilot')` → `null`.
- Cabang legacy di `cleanSettings` tetap hidup dan benar (tab lama `'auto'` → `build`).
- Tidak perlu field/versi skema baru; perubahan paling kecil dan idempoten.

**`appModeFromCli('auto') → 'autopilot'`** (bug #3): `onModeReported` hanya dipanggil untuk sesi yang **dikelola
app** (`this.child`), jadi yang dilaporkan selalu mode yang app sendiri kirim — bila app mengirim
`--permission-mode auto`, hanya pemetaan inilah yang mencegah mode terlihat "balik" ke build. Sesi CLI di luar
app tidak pernah lewat jalur ini, jadi tidak ada risiko "CLI eksternal diam-diam menyalakan Auto".

**Bar OpenCode = tanpa kartu izin untuk shell & web** (3 tool: `edit`/`bash`/`webfetch`), bukan paritas
`--auto` penuh. `permissionConfig('autopilot')` tidak menyentuh `read`, jadi aturan OpenCode default/user untuk
`.env` **tetap berlaku** — anti-tujuan #3 aman, dan itulah yang kita janjikan. Di luar tiga tool itu, aturan
user/default tetap otoritatif (dokumentasikan di tooltip Auto).

**Transisi mode**: Claude berubah **langsung** (`set_permission_mode`); OpenCode **respawn** (karena
`processKey` memuat `permissionConfig`). Di v1 tidak ada dialog tambahan — perilaku ini sudah lazim untuk
pergantian mode OpenCode (sama seperti Plan).

**Ganti mode dari HP**: tetap boleh lewat Tailscale (setara laptop, konsisten dengan aksi lain); WiFi biasa
tetap read-only (rute settings tidak ada di allowlist). Karena Auto memperlonggar, minta **security review**.

## Keputusan

- **Kosakata**: `MODES = ['build', 'plan', 'autopilot']`; label UI `⚡ Auto`. `normalizeMode` memetakan nilai
  tak dikenal → `build`; `plan`/`autopilot` tetap. Nilai `'auto'` legacy **tidak** jadi mode baru (lihat atas).
- **Urutan siklus & UI**: Build → Plan → **Auto**. Label: `⚡ Auto`. Penjelasan: "Auto: langsung dikerjakan tanpa
  kartu izin untuk shell & jaringan; aturan deny dan file rahasia tetap berlaku."
- **OpenCode → Auto**: `permissionConfig('autopilot') = { edit: 'allow', bash: 'allow', webfetch: 'allow' }`, lalu
  `mergePermission(base, user, 'autopilot')` (mode `autopilot` mengubah `ask` user menjadi allow; **deny user
  tetap deny**). Perilaku untuk tiga tool itu ≈ `opencode --auto`.
- **Claude → Auto**: `claudePermissionMode('autopilot') = 'auto'` (bukan lagi hanya acceptEdits/plan), dikirim sebagai
  `--permission-mode auto` dan `set_permission_mode auto`.
- **Plan tetap otoritatif**: di kedua engine, Plan masih menolak edit/shell/network; Auto tidak berlaku saat Plan.
- **Auto tidak menyentuh agent ACP OpenCode**: opsi `mode` di `session/set_config_option` adalah **agent**
  (build/plan/custom), bukan permission. `agentForMode('autopilot')` tetap `build`/agent user; pelonggaran hanya lewat
  `OPENCODE_CONFIG_CONTENT`. Jadi tidak ada bentrok dengan `setOption('mode', …)` di handshake.
- **`autoApprove` per-sesi** tetap ada dan tidak berubah (ia menutup kasus "tolak/izin semua" di Build).
- **Migrasi**: nilai lama `auto` → `build` (tetap, di `migrateMode`), karena itu arti lamanya (auto-edit) dan tidak
  boleh menjadi Auto baru yang lebih longgar. Mode baru (`autopilot`) hanya muncul dari **pilihan eksplisit** user.

## Bagian teknis yang tersentuh (peta, bukan kode)

- `src/modes.js`: `MODES`, `isMode`, `normalizeMode`, `claudePermissionMode` (cabang autopilot), dan
  `appModeFromCli('auto') → 'autopilot'`. `DEFAULT_MODE` tetap `build`. `migrateMode` **tidak** diubah: `auto` lama
  tetap → build, `autopilot` tidak dipetakan.
- `src/opencode-bin.js`: `mergePermission` menambah cabang `mode === 'autopilot'` (ask→allow); `permissionConfig`
  (di `src/acp-session.js`) menambah cabang autopilot.
- `src/acp-session.js`: `permissionConfig`; `OPENCODE_CAPS.modes` jadi `['build', 'plan', 'autopilot']`.
- `src/hub.js`: `cleanSettings` menerima `autopilot` via `isMode` (cabang `'auto'` legacy tetap utuh).
- `public/js/core/engine-caps.js`: `ALL_MODES = ['build', 'plan', 'autopilot']`; `capsFor` sudah memfilter lewat
  `normalizeMode`.
- `public/js/features/statusline.js`: `MODE_SHORT`/`MODE_LABEL`/`MODE_CYCLE` + `modeLabel`.
- `public/index.html`: `<option value="autopilot">⚡ Auto</option>`, `title` mode-ctl.
- `public/js/features/composer.js`: tooltip/chip; `renderModeChoice` (banner mode lama) tetap.
- `docs/FITUR.md`, `CHANGELOG.md`, `docs/design-opencode.md` §0.2 & §1.

## Yang saya panggil sendiri (builder Bisa putuskan)

- Ikon `⚡` untuk Auto (konsisten dengan gaya label lain).
- Auto **tidak** menghapus tombol "Izinkan semua (sesi ini)" di kartu izin (tetap ada di Build).
- Posisi Auto di akhir siklus (Build → Plan → Auto) agar dua mode lama tidak bergeser.

## Yang masih perlu Anda putuskan (kalau ada)

- Tidak ada yang menghambat. Nilai tersimpan `autopilot` dipilih demi menjaga `auto` legacy tetap aman; label UI
  tetap **⚡ Auto**. Semua keputusan lain bisa dikoreksi.

## Risiko

- **Keamanan**: Auto memperlonggar shell/web. Mitigasi: `deny` tetap menang, aturan `read`/`.env` tetap berlaku
  (mode tidak menyentuh tool `read`), Plan tetap read-only, dan Auto hanya dari pilihan eksplisit. Review keamanan
  diminta (mode `autopilot`, `mergePermission`, `appModeFromCli`).
- **Migrasi**: nilai lama `auto` harus tetap → build (tes khusus) dan `autopilot` tidak boleh dipetakan.
- **Claude classifier**: `--permission-mode auto` butuh model yang mendukung; bila tidak, Claude memakai perilaku
  bawaan. Tidak ada kegagalan keras.

## Test yang diharapkan (TDD)

- `test/modes.test.mjs`: `isMode('autopilot')`, `normalizeMode('autopilot')`, `claudePermissionMode('autopilot')`,
  `appModeFromCli('auto') → 'autopilot'`, `migrateMode('auto') → build` dan `migrateMode('autopilot') → null`.
- `test/opencode-*.test.mjs`: `permissionConfig('autopilot')` menghasilkan allow untuk bash/web; `mergePermission`
  menahan deny user.
- `test/hub-*.test.mjs` atau setara: `cleanSettings({mode:'autopilot'})` tersimpan; tab lama (`{mode:'auto'}` tanpa
  `modeChosen`) tetap jatuh ke build.
- UI area: mode select menampilkan Auto, chip & statusline menampilkannya, Shift+Tab melewatinya.