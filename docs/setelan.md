# Di mana setiap setelan disimpan

Tujuan halaman ini: **tidak ada setelan yang hilang saat server dimatikan atau halaman dimuat ulang**, dan setelan
yang sama terlihat dari laptop maupun HP.

## Tiga tempat, satu aturan

| Tempat | Untuk apa | Bertahan saat… |
|---|---|---|
| `data/state.json` (**sumber kebenaran**) | semua yang memengaruhi perilaku server: folder project, grup, model favorit, jembatan daya (termasuk pilihan ⏻), budget, routines, batas giliran, retensi | restart server, pindah browser, ganti perangkat |
| `data/…` lain | data besar/rahasia: `chats/*.jsonl`, `wa/session.bin` + `wa/key`, `backups/`, `audit.log` | restart server |
| `localStorage` | **hanya** preferensi tampilan per-browser: lebar panel, pesan tersimpan (★), pengaturan notifikasi, snooze, tab terakhir | restart server, tetapi **hilang** bila cache browser dibersihkan dan tidak terlihat dari perangkat lain |

Aturan praktis: **kalau nilainya memengaruhi apa yang dilakukan server (atau harus sama di HP dan laptop), simpan di
`state.json`.** `localStorage` tidak boleh jadi satu-satunya tempat untuk setelan seperti itu.

## Peta setelan

| Setelan | Disimpan di | Dibaca/ditulis oleh |
|---|---|---|
| Folder induk project, project kustom | `state.json` → `roots`, `custom` | `src/hub.js`, `src/projects.js` |
| Project favorit / tersembunyi (arsip) | `state.json` → `favorites`, `archivedProjects` | `src/hub.js` |
| Grup project | `state.json` → `projectGroups` | `src/routes/groups.js` |
| Model favorit | `state.json` → `favoriteModels` | `src/routes/*` |
| Setelan umum (⚙), setelan per mesin (engine) | `state.json` → `settings`, `engineSettings` | `src/hub.js` |
| Mesin aktif (Claude/OpenCode), plan OpenCode | `state.json` → `engine`, `opencodeGoPlan` | `src/routes/*` |
| Mode/model/effort per project | `state.json` → `sessions`, `sessionsByEngine` | `src/session.js`, `src/acp-session.js` |
| Batas giliran (concurrency), budget harian/mingguan/bulanan | `state.json` → `settings`, `budget`, `projectBudgets` | `src/queue.js`, `src/budget.js` |
| **Jembatan daya: URL, token, jeda, ⏻ ikut mematikan Windows** | `state.json` → `remotePower` (`bridgeUrl`, `token`, `offDelaySec`, `shutdownPc`) | `src/hub.js` (`cleanRemotePower`), `src/routes/misc.js`, `public/js/features/settings.js` |
| Routines / runbook | `state.json` → `routines`, `runbooks` | `src/routines.js` |
| Retensi data | `state.json` → `settings` (bagian retensi) | `src/retention.js` |
| Sesi WhatsApp (tautan perangkat) | `data/wa/session.bin` + `data/wa/key` (terenkripsi AES-GCM) | `src/wa-auth-store.js`, `src/wa-link.js` |
| Riwayat chat | `data/chats/*.jsonl` | `src/chat-store.js` |
| Backup | `data/backups/` | `src/backup*.js` |
| Lebar panel samping | `localStorage` → `office.panelWidth` | `public/js/ui/layout.js` |
| Pengaturan notifikasi, pesan tersimpan, snooze, tab aktif | `localStorage` (per browser) | `public/js/core/notify-rules.js`, `bookmarks.js`, `attention.js`, `stream.js` |

## Kalau menambah setelan baru

1. Tambahkan field-nya di `Hub` (`src/hub.js`) + fungsi normalisasi (`clean…`) supaya `state.json` lama tetap terbaca.
2. Tulis lewat route baru (atau route yang ada) dengan validasi; jangan menulis file sendiri.
3. UI **membaca dari server** saat panel dibuka, dan menyimpan saat diubah — jangan mengandalkan nilai default di DOM.
4. Tambahkan test: simpan → buat ulang `Hub` (atau restart server) → nilainya sama.
5. Perbarui tabel di halaman ini.
