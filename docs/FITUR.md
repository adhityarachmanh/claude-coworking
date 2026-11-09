# Fitur

Detail tiap fitur, termasuk batasan dan perilakunya. Kembali ke [README](../README.md).

## Chat & izin

| Bagian | Fungsi |
|---|---|
| **Chat** | Prompt ke Claude Code di folder project. Pesan yang dikirim saat tim bekerja masuk antrean Claude Code sendiri, seperti di CLI. Balasan streaming, code block di-highlight, tiap giliran ditutup dengan durasi, langkah, konteks, dan token output. Lebar panel bisa digeser (klik dua kali untuk ukuran bawaan) |
| **📜 Chat panjang** | Halaman terbaru dulu: hanya 80 pesan terakhir yang digambar, jadi percakapan panjang tetap ringan. Tombol **Muat N pesan lama** menambah pesan sebelumnya tanpa menggeser baris yang sedang dibaca. **Ctrl+F** tetap mencari di seluruh percakapan, dan lompatan dari ⚠ Perlu perhatian, 📋 Antrian, atau notifikasi membuka pesan lama yang dituju |
| **🔍 Cari di percakapan** (`Ctrl+F`) | Kotak cari di tab Chat menyaring pesan yang cocok, menandai teksnya, dan menampilkan **2/5**. **Enter** / **Shift+Enter** pindah antar hasil (membungkus di ujung); `Esc` menutup. Kueri tetap aktif saat percakapan dimuat ulang (mis. tersambung lagi); berganti project menutupnya |
| **Kartu izin** | **Izinkan**, **Izinkan selalu** (simpan aturan), **Izinkan semua (sesi ini)**, atau **Tolak** (bisa dengan instruksi). `AskUserQuestion` dijawab dengan pilihan atau jawaban sendiri. Kartu rencana punya tiga aksi: **Lanjut build**, **Minta revisi**, dan **Selesai** (tanpa build) |
| **Mode izin** | 🛡️ Tanya dulu (default) · ✏️ Auto-edit file · ⚡ Auto · 📋 Rencana dulu · 🚫 Jangan tanya. `Shift+Tab` berganti mode, langsung berlaku juga di tengah giliran |
| **🛡️ Aturan izin** (`/permissions`, menu ⋯) | Aturan allow/ask/deny yang tersimpan, per file settings (project lokal, project bersama, user). Mengubah hanya dari laptop |
| **Model · Effort · Mode tim** | Daftar model dari Claude Code sendiri (`/model`, termasuk alias seperti `opusplan`). Effort Default/Low/Medium/High/X-High/Max, plus **Auto (LLM)** yang menilai setiap prompt. Mode tim mendelegasikan ke subagent (lebih hidup, lebih banyak token). Semua per project, berlaku tanpa restart |
| **■ Stop** / `Esc` | Hentikan giliran dan batalkan pesan yang antre. Sesi tetap bisa dilanjutkan |
| **⏪ Rewind** (`Esc Esc`, `/rewind`) | Kembalikan kode dan/atau percakapan ke sebelum salah satu pesanmu (checkpoint Claude Code, atau revert sesi OpenCode), dengan pratinjau file. Pesan yang di-rewind tetap terlihat di chat tapi diredupkan, dan pesanmu kembali ke kotak pesan untuk diedit. Setelah rewind, dialog menawarkan **↩ Ulangi perubahan (redo)** untuk perubahan belum di-commit (repo git, file byte-identik, konflik dilewati, backup di `data/redo/`) dan **🔄 Pulihkan percakapan** — Claude kembali ke posisi terakhir; OpenCode memulihkan **salinan** sebagai sesi baru (sesi lama yang terhapus tidak kembali) |
| **▶ Lanjutkan setelah restart** | Kalau server berhenti di tengah giliran, chat menampilkan *"… giliran terputus"* dengan **▶ Lanjutkan** (ke sesi yang sama) dan **Tutup**. Tidak ada yang dikirim otomatis |
| **⚠ Deteksi macet** | Tool tanpa output baru **3 mnt** atau berjalan **10+ mnt**, dan delegasi tanpa aktivitas **5 mnt**, mendapat chip *⚠ … mungkin macet* dengan **■ Hentikan giliran**, **⧗ Pindah ke latar** (perintah shell), atau **Lihat detail** (delegasi). Satu notifikasi *Berhenti / error* per kejadian. Hanya peringatan: tidak pernah menghentikan apa pun sendiri |
| **Output live** | Perintah Bash/PowerShell yang berjalan menampilkan baris terakhir; dibuka (▸) menampilkan output lengkap (8 KB terakhir) |
| **⧗ Tugas latar** (`/tasks`, `Ctrl+B`) | Perintah dan agent latar: status, output/detail live, **Hentikan**. `Ctrl+B` memindahkan yang sedang jalan ke latar. Shell OpenCode dari **sesi lain di folder yang sama** ikut terlihat sebagai daftar **hanya lihat** (tanpa output dan tanpa Hentikan) |
| **🔌 Server MCP** (`/mcp`) | Status, sambungkan ulang, aktif/nonaktif, login OAuth |
| **Status line & daftar tugas** | Mode, model, konteks terpakai (seperti `/context`), tugas latar; todo list Claude menempel di atas kotak pesan |
| **`/` · `@` · `!`** | Slash command lengkap dari Claude Code · autocomplete file · perintah shell langsung di folder project (PowerShell di Windows; output ikut ke Claude bersama pesan berikutnya) |
| **⚡ Template** (`/t`) | Template bawaan dan buatan sendiri (tersimpan di server). Bagian `{…}` langsung terpilih, `Tab` ke bagian berikutnya |
| **🎤 Input suara** (`Alt+M`) | Pengenalan suara bawaan browser, Indonesia/English. Hanya di HTTPS atau localhost |
| **Sesi** | Bar sesi (judul, asal, model; klik judul untuk ganti nama), **＋ Sesi baru** (mengosongkan kolom chat; transkrip sesi lama tetap ada di Riwayat sesi), **🕘 Riwayat sesi** (web dan CLI, dikelompokkan per hari; saring **7/30/90 hari**, pencarian, chip **🏷 tag**, atau **📦 Diarsipkan**; **Arsip otomatis** per project 30/90/180 hari untuk sesi yang tidak dipakai; tiap baris menampilkan **token & biaya tercatat** sesi itu bila ada di ledger; **🏷** memberi tag (ikut tercari), **📦** mengarsipkan tanpa menghapus, **✎** mengganti nama sesi lama — untuk Claude Code ditulis sebagai judul kustom seperti `/rename`; centang beberapa sesi lalu **⬇ Export N** (satu `.zip`), **🏷 Tag N**, **📦 Arsipkan N**, atau **Hapus N sesi**; **✎ Kelola tag** mengganti nama/menghapus tag di semua sesi sekaligus; dan **↩ Pulihkan** sesi yang terlanjur dihapus dari bagian **🗑 Sesi terhapus** — sesi yang sedang dibuka atau berjalan di terminal tidak ikut; trash otomatis dibersihkan setelah **30 hari**), menu ⋯: export percakapan / sesi lengkap ke `.md`, salin perintah `claude --resume`, buka di VS Code/folder (laptop) |
| **🔎 Cari percakapan** (`/search`, `Ctrl+P`) | Cari teks di sesi Claude **dan** OpenCode, untuk project ini atau semua project; hasil bisa langsung dilanjutkan (mesin ikut berpindah bila perlu) |
| **🔎 Palet perintah** (`Ctrl+P`) | Semua aksi, file (`@`), project (`#`), perintah (`>`), pengaturan, dan — saat mengetik 2+ huruf — **isi percakapan** dari semua project (grup **Percakapan**); `@query` juga mencari **file di project lain** (nama project tampil sebagai keterangan, memilihnya pindah project lalu membuka file). Awali dengan **`?`** untuk mencari **hanya di transkrip**, dengan filter `claude`/`opencode` dan `7d`/`30d`/`90d` (mis. `?opencode 7d checkout`). Pilih hasilnya untuk melanjutkan sesi itu |
| **✅ Checklist project** (Ctrl+P) | Apa yang masih kurang agar project nyaman dikerjakan AI: README, AGENTS.md/CLAUDE.md, package.json + perintah test/build, git, `docs/`, `.env.example`, dan model yang dipilih. **🛠 Buat kerangka** membuat file yang belum ada (tidak pernah menimpa file yang sudah ada) setelah konfirmasi |
| **Riwayat prompt** | `↑`/`↓` di kotak pesan, `Ctrl+R` untuk mencari |
| **📄 Lihat file** | Klik path di chat atau tab Perubahan: isi file read-only, nomor baris, cari, salin, **Buka di VS Code** (laptop). Path di luar project (mis. screenshot di folder temp) bisa dibuka dari laptop setelah konfirmasi, hanya di bawah folder Temp, Desktop, Documents, Downloads, atau Pictures. File rahasia (`.env*`, `*.pem`, `id_*`, kredensial) butuh konfirmasi di laptop dan tidak pernah dikirim ke HP |
| **❓ Bantuan** (`?`) · **🎬 Demo** | Panduan singkat dan shortcut · simulasi kantor tanpa Claude Code |

Riwayat chat tiap project disimpan di `data/chats/<id>.jsonl` (250 pesan terakhir). Pengaturan per project ada di `data/state.json`.

**Di HP:** tampilan Chat ringkas: header = nama project + subjudul sesi + **⋯** (sesi, export, **🔁 Lanjutkan dari mesin lain**, akun, laporan, musik, notifikasi, pengaturan); kotak pesan lebar penuh dengan **＋** (lampiran, template, antrian, suara, `!`, `@`, `/`) dan chip pengaturan giliran (izin, model, effort, mode tim). **Geser kiri/kanan** untuk pindah **Kantor ↔ Chat ↔ Perubahan ↔ Aktivitas** (geser vertikal tetap scroll; mulai dari kotak pesan, dialog, atau panel yang bisa digeser menyamping tidak ikut berpindah). Di **❓ Panduan** ada bagian **📲 Pasang sebagai aplikasi**: tombol **Pasang sekarang** muncul saat browser menawarkannya (Chrome/Edge), iPhone lewat **Bagikan → Tambahkan ke Layar Utama**; ikon aplikasi menampilkan **angka izin menunggu** (Badging API). Dialog **⚙ Pengaturan** juga memakai tab di HP (satu bagian sekaligus), jadi tidak lagi satu lembar panjang. Satu tombol berganti fungsi: 🎤 → ↑ Kirim → ■ Stop. Tab Perubahan menyisakan ⎇, pesan commit, dan Commit; sisanya di ⋯. Mode **landscape** memakai rail navigasi kiri dan dua kolom. Saat keyboard terbuka, navigasi bawah disembunyikan.

**Banyak tab:** semua tab di satu browser berbagi **satu koneksi live** ke server (satu tab memimpin, yang lain menerima lewat BroadcastChannel), jadi membuka banyak tab tidak lagi menghabiskan batas koneksi browser.

## Tanpa terminal

- **👋 Tur singkat**: dari **❓ Panduan** atau layar chat kosong. Empat langkah: pilih project, kirim permintaan, jawab izin, lalu pantau antrian/jadwal/budget.
- **🔎 Cari pengaturan**: kotak cari di atas dialog ⚙ menampilkan panel yang cocok dan menyembunyikan sisanya; kosongkan untuk kembali ke tab.
- **✅ Penanda pesan**: chat memberi pemisah tanggal dan **“Pesan baru”** saat kamu sedang membaca pesan lama; tombol **↓ N pesan baru** membawa kembali ke bawah.
- **★ Pesan tersimpan**: klik **☆ Simpan** pada pesanmu (atau **☆** di jawaban Claude) untuk menandainya. Buka daftarnya lewat **Ctrl+P → Pesan tersimpan**, cari dengan kotak di atas daftar, lalu **Buka di chat** (barisnya disorot, halaman lama dimuat bila perlu) atau **Hapus**. Tersimpan di browser ini per project.
- **🎛️ Tampilan**: ⚙ → **Umum** → **Tampilan** mengatur **terang/gelap/kontras tinggi/ikuti sistem**, ukuran teks, kepadatan, dan animasi. Tersimpan per perangkat; tema kantor pixel tetap diatur terpisah.
- **♿ Aksesibilitas**: tombol dan kontrol punya nama untuk pembaca layar, field punya label, gambar punya `alt`, referensi ARIA selalu menunjuk elemen yang ada, dan target sentuh minimal **24×24 px** (44 px di layar sentuh), plus **kontras teks WCAG AA** (4,5:1; 3:1 untuk teks besar) di tema terang dan gelap. Diperiksa otomatis oleh test audit.
- **⚠ Perlu perhatian**: badge di tombol **🗂 Semua project** dan daftar di atas dashboard: izin menunggu, antrian dijeda, budget tercapai, giliran terputus, dan jadwal gagal. Klik item untuk pindah ke project/panel yang tepat; tombol **⏰** menunda satu item (dan badge-nya) selama 1 jam, dengan **Tampilkan** untuk mengembalikannya lebih cepat. Menunda hanya menyembunyikan pengingat — antrian/izin tetap seperti semula.
- **Izin, Model, Effort, Mode tim** ada di dialog *Pengaturan giliran*: klik chip ⚙ di atas kotak chat (di HP di bawah teks). **Effort Auto (LLM)** menilai kompleksitas tiap prompt dengan **model yang sedang aktif** (Default mengikuti default mesin) sebelum giliran mulai; hasilnya tampil sebagai badge `Auto: High` di chat. Manual tetap tersedia dan tidak memakai token classifier.
- **🤖 Model Auto**: pilihan **Auto — sesuaikan task** di daftar Model. Klasifikasi task yang sama dengan Effort Auto (satu panggilan, tanpa token tambahan bila Effort Auto juga aktif) memilih model dari tangga **Hemat / Seimbang / Kuat / Maks**:
  - Claude Code: `haiku` → `sonnet` → `opus` → `fable`.
  - OpenCode Go: `deepseek-v4.1-flash` → `glm-5.3-flash` → `deepseek-v4-pro` → `glm-5.3`.
  Level `low` → Hemat, `medium` → Seimbang, `high` → Kuat, `xhigh`/`max` → Maks. Pergantian diumumkan di chat beserta **alasannya** (`🤖 Model Auto: Kuat → deepseek-v4-pro — multi-file bug fix`), dan badge **Effort Auto** juga menampilkan alasan. Tidak pernah di tengah giliran; memilih model konkret atau Default mematikan Auto. **Atur tangga…** membuka 4 pilihan model per mesin. Classifier ikut membaca **percakapan dan rencana/todo terakhir**.
- **💵 Estimasi biaya sebelum kirim**: baris kecil di atas kotak pesan menampilkan `±$0.02` untuk prompt yang sedang diketik — konteks terpakai + teks prompt + asumsi output 600 token, memakai harga list OpenCode Go atau harga efektif Claude. Arahkan kursor untuk rincian; angka ini perkiraan dan tidak menghalangi pengiriman.
- **⚡ Perintah cepat**: `/hemat`, `/seimbang`, `/kuat`, `/maks` langsung memilih model tier itu untuk mesin aktif (Auto dimatikan agar pilihan pasti), `/auto` menyalakan Model Auto lagi. **Focus mode** (`/fokus`) menyembunyikan dan menghentikan animasi kantor supaya chat/panel lega; pengaturan diingat per perangkat dan ada tombol keluar.
- **💲 Harga di daftar model**: pilihan model menampilkan biaya per 1 juta token. Untuk model **OpenCode Go** harganya diambil dari katalog resmi `opencode.ai` (input/output/cache, ditandai `±` bila ada tarif jam sibuk; diperbarui otomatis maksimal sehari sekali). Untuk model **Claude** (atau model tanpa harga list) ditampilkan **harga efektif dari catatan pemakaian** 90 hari terakhir (`≈$…/1M tercatat`). Tanpa data: tidak ada angka, dan baris di bawah pilihan menjelaskan alasannya.
- **■ Stop / Esc** menghentikan giliran yang sedang berjalan, termasuk giliran yang dimulai Claude sendiri setelah tugas latar selesai, dan menghentikan tugas latar itu juga.
- **🩺 Doctor** dan **⬆ Update Claude Code**: ⚙ → tab **Sistem** → Kompatibilitas Claude Code (sama dengan `claude doctor` / `claude update`, dari laptop).
- **🩺 Kesehatan sistem**: ⚙ → **Sistem** → **Kesehatan sistem** menampilkan ringkasan dan **Pemeriksaan** dulu; **Persiapan**, ukuran data, dan error 24 jam ada di **Detail & persiapan** yang bisa dibuka. Ada tombol **↻ Periksa ulang** dan **🩺 Bundel diagnostik** (`.zip` berisi info versi, health, dan 512 KB log terakhir; folder home disamarkan). Hanya laptop/Tailscale; tidak ada polling.
- Command yang hanya membuka layar terminal (`/config`, `/hooks`, `/doctor`, `/login`, …) tidak ditawarkan di autocomplete; kalau diketik, aplikasi menunjukkan tempatnya di sini.
- **🧠 /memory**: edit `CLAUDE.md` (project), `CLAUDE.local.md` (pribadi) dan `~/.claude/CLAUDE.md` langsung di aplikasi; dengan OpenCode: `AGENTS.md` (project dan global). File yang diubah di tempat lain sejak dibuka tidak ditimpa. Laptop atau Tailscale.
- **🕘 Riwayat sesi**: per sesi 🏷 *Tag* (kata pendek, ikut tercari; kosongkan untuk menghapus), chip tag di atas daftar untuk menyaring (**✎ Kelola tag** mengganti nama/menghapus satu tag di semua sesi), 📦 *Arsipkan* (masih bisa dilanjutkan/diekspor, tapi tidak tampil di daftar utama — pilih filter **📦 Diarsipkan** untuk melihatnya), **Arsip otomatis 30/90/180 hari** per project (sesi tua masuk arsip; ↩ pada sesi yang diarsipkan otomatis menyematkannya). Centang beberapa sesi untuk **🏷 Tag N**, **📦 Arsipkan N**, **⬇ Export N**, atau **Hapus N**. Per sesi juga ⑂ *Cabangkan* (lanjutkan salinannya, aslinya utuh; Claude `--fork-session`, OpenCode `session.fork`), ⬇ export (`.md` untuk Claude, JSON OpenCode yang bisa diimpor lagi), 🗑 hapus (transcript Claude dipindah ke `data/trash`, bisa dikembalikan), ✎ ganti nama (OpenCode). Dengan OpenCode, **⬆ Import JSON** memanggil `opencode session import` (laptop saja).
- **🔁 Lanjutkan dari mesin lain**: satu tombol **Terapkan**. Aplikasi menyusun konteks gratis dari riwayat mesin lain lalu langsung mengirim **prompt context-only** ke sesi aktif: AI diminta hanya mengingat konteks dan membalas “Konteks diterima.”, tanpa mengerjakan apa pun, tanpa kartu rencana, dan tanpa mengubah file. Konteks menjadi bagian percakapan sesi. Ditolak saat sesi sedang sibuk atau ada izin yang belum dijawab.
- **🧹 Ringkas konteks**: tombol di status konteks (atau `/ringkas`) meringkas percakapan yang makin panjang. Fokus opsional (misalnya "pertahankan keputusan API") hanya dipakai Claude Code; OpenCode menjalankan `/compact` bila command itu tersedia di sesinya. Tidak bisa dipakai saat giliran berjalan, ada izin menunggu, atau rewind berjalan. Riwayat chat di aplikasi tidak diubah; Claude Code juga tetap punya auto-compact bawaannya sendiri (ambangnya tampil di status konteks).
- **🧠 Logo model aktif**: Mode Otak menampilkan logo model di **inti otak**, dan ruangan Lead di kantor punya **plakat logo** model yang sedang dipakai (mengikuti model/tier yang benar-benar berjalan, termasuk saat Model Auto). Logo dibaca dari folder `ai_logos/` (nama file = id model, mis. `kimi-k3.1-pro.svg`); model tanpa logo menampilkan monogram.
- **🔌 /mcp → ＋ Tambah server**: server lokal (perintah) atau remote (URL), untuk project ini atau semua project, lewat `claude mcp add` / `opencode mcp add` (laptop saja). Dengan OpenCode, /mcp menampilkan server dari `opencode.json` (global + project); login OAuth server OpenCode masih `opencode mcp auth <nama>`.
- **🧩 /plugin · 🤖 /agents · 🪝 /hooks** (dialog *Ekstensi Claude Code*): pasang plugin dari marketplace (perintah yang diminta marketplace selalu ditampilkan dulu untuk dikonfirmasi), aktif/nonaktif, hapus; buat/edit/hapus subagent sendiri (`.claude/agents/*.md`, project atau semua project); lihat hooks dari semua settings.json. Memasang plugin hanya dari laptop.
- **✅ CI GitHub**: setiap push (⬆ Push, pull request, atau `git push` yang dijalankan tim) diikuti dengan `gh run list` untuk commit itu. Chip di bar git tab Perubahan menunjukkan ⏳ berjalan / ✅ lulus / ❌ gagal (klik untuk membuka run-nya), dan satu baris di chat saat selesai. Butuh `gh` yang sudah login. Hanya membaca, tidak menjalankan ulang apa pun.
- **⇡ Pull request** (tab Perubahan → PR): login GitHub sekali lewat kode perangkat yang tampil di aplikasi (sama dengan `gh auth login --web`), lalu form judul/deskripsi/branch tujuan/draft → push branch → `gh pr create`. Atau *Biar Claude yang buat*.
- **OpenCode `@file`**: file project yang disebut dengan `@` dikirim juga sebagai referensi file (ACP `resource_link`), seperti di TUI OpenCode.

## Mesin: Claude Code atau OpenCode

**Mesin dipilih per project** di ⚙ Pengaturan → **🔀 Mesin project**. Dua project boleh memakai mesin berbeda **pada saat yang sama** (Claude Code di satu project, OpenCode di project lain). Di **👤 Akun**, pilihan **Mesin bawaan untuk project baru** hanya menentukan mesin untuk project yang baru ditambahkan; project lama tetap memakai mesinnya sendiri dan tidak ikut dipindah.

- **Claude Code** (bawaan)
- **OpenCode**: banyak provider, mis. Gemini dan model gratis OpenCode Go. Pilihan ini muncul kalau `opencode` terpasang (`npm i -g @opencode/cli`, atau set env `OPENCODE_BIN`).

Riwayat chat **disimpan terpisah per mesin** (`data/chats` untuk Claude Code, `data/chats-opencode` untuk OpenCode). Mengganti mesin satu project hanya mengganti riwayat yang ditampilkan: riwayat mesin sebelumnya tetap di disk dan muncul lagi saat project itu dikembalikan. Pengaturan model/effort/agent diingat **per mesin** untuk project itu. Pergantian ditolak (409) selama project itu sedang bekerja, punya izin menunggu, antrean berisi item, atau ada giliran terputus yang ditawarkan untuk dilanjutkan.

**Login OpenCode.** OpenCode tidak punya satu akun: tiap provider login sendiri. 👤 Akun menampilkan provider yang sudah terhubung (kredensial tersimpan atau variabel lingkungan) dengan tombol **Logout** per kredensial, dan **＋ Login provider** (cari provider → API key, atau OAuth lewat browser, termasuk form tambahan seperti GitHub Enterprise). Semuanya lewat `opencode api` (penyimpanan yang sama dengan `opencode auth login|logout|list`); API key tidak dicatat di log. Dari HP hanya lewat Tailscale, sama seperti login Claude. 🕘 Riwayat sesi menampilkan (dan melanjutkan) sesi OpenCode project itu. 📦 Import backup selalu masuk ke riwayat Claude Code; chat OpenCode di dalamnya masuk ke store OpenCode.

| | OpenCode |
|---|---|
| Didukung | Chat streaming, tool + animasi kantor, papan todo, **kartu izin** (Izinkan / Selalu / Izinkan semua / Tolak), ■ Stop / `Esc`, antrean, `!` shell, lanjut sesi OpenCode (`ses_…`), ▶ Lanjutkan setelah restart, token + biaya ke 📊 Laporan dan 💰 Batas antrian |
| Model | Daftar dari `opencode models` (provider yang kamu atur di OpenCode), bisa dicari; *Default* = pilihan OpenCode sendiri |
| Mode izin | **Build** (kerja normal, kartu izin tetap mengikuti aturan app) · **Plan** (agent `plan` OpenCode, read-only). Aturannya dikirim per proses lewat `OPENCODE_CONFIG_CONTENT`, jadi config OpenCode milikmu tidak pernah diubah. Aturan `permission` milikmu di `opencode.json` **digabung, bukan ditimpa**: `deny` tetap `deny`, aturan berpola (`"git *": "allow"`) tetap berlaku |
| Agent | Agent buatanmu (primary agent di `opencode.json`) untuk Build; Plan selalu memakai agent `plan` |
| Command | `/init`, `/review` dan command buatanmu muncul di autocomplete `/` dengan deskripsinya |
| Mode tim | Role kantor jadi **subagent OpenCode** (file config `OPENCODE_CONFIG` berisi `agents` + prompt Lead sebagai `instructions`). Lead mendelegasikan lewat tool `subagent`; tool milik subagent dikerjakan role itu di kantor |
| Effort | Opsi `effort` OpenCode per model (mis. low/high/max): dipilih level terdekat yang ditawarkan model. **Auto (LLM)** memakai model yang sedang aktif di project (atau Default OpenCode) — tidak memilih model lain dari katalog |
| ❓ Pertanyaan | Tool `question` OpenCode muncul sebagai **kartu pertanyaan yang sama** dengan `AskUserQuestion` Claude (pilihan tunggal/ganda + jawaban sendiri; *Lewati* = OpenCode lanjut tanpa jawaban). Lewat *form elicitation* ACP. Notifikasi HP dan akses sama dengan Claude (WiFi hanya melihat). Pertanyaan yang menyebut kata seperti *password/token/api key* tidak dikirim OpenCode ke klien mana pun: model diminta bertanya di jawabannya |
| 📋 Kartu rencana | Agent `plan` OpenCode tidak punya tool "selesai merencanakan", jadi saat mode 📋 Rencana dulu, **setiap giliran yang selesai** memunculkan kartu rencana berisi jawaban terakhirnya. Tiga aksi: **▶ Lanjut build** mengganti mode (agent `build`, sesi yang sama) lalu mengirim "Rencana disetujui. Kerjakan sekarang sesuai rencana di atas."; **Minta revisi** + catatan mengirim catatan itu dan tetap di plan; **Selesai** menyimpan rencana tanpa build dan tetap di plan. Jika Model/Effort Auto aktif, rencana tersebut dianalisa ulang sebelum build/revisi: kartu menampilkan loading beranimasi (bukan terasa macet), chat menulis `⚙️ Auto build: Effort High · Model Kuat → deepseek-v4-pro — alasan`, dan bubble build/revisi membawa tag **Auto** + **Model**. Pesan baru sebelum menjawab menutup kartu |
| ⏪ Rewind | Lewat revert sesi OpenCode sendiri (`session.revert.stage` + `commit`). **Pesan yang dipilih dan semua sesudahnya dihapus dari sesi OpenCode** (tidak bisa di-redo dari aplikasi). *Kode & percakapan* juga mengembalikan file yang diubah OpenCode sejak pesan itu dari snapshot-nya (perubahanmu sendiri di file yang sama ikut tertimpa); *Percakapan saja* tidak menyentuh file. *Kode saja* tidak ada di OpenCode (tombolnya mati). Pratinjau = daftar file dari snapshot giliran sesudahnya (tanpa hitungan +/−). Ditolak (409) selama giliran berjalan. Akses sama dengan Rewind Claude: daftar pesan boleh dibaca dari WiFi, pratinjau dan rewind hanya laptop/Tailscale |
| ⧗ Shell yang lama | Perintah bash OpenCode dicari di shell *background service* OpenCode (`opencode api shell.list`): baris chat-nya menampilkan **output live**, deteksi macet memakai aturan **tanpa output 3 mnt**, **⧗ Pindah ke latar** memakai `session.background`, dan **■** di monitor tugas menghentikan shell itu. Kalau `opencode models` sempat kosong (service baru menyala), pemilih model memakai daftar dari sesi OpenCode yang sedang berjalan. Kalau perintahnya tidak ditemukan di service, yang berlaku hanya aturan *berjalan 10+ mnt* |
| ✕ Tolak | OpenCode menghentikan seluruh giliran saat izin ditolak. Supaya sama dengan Claude Code, aplikasi melanjutkannya dengan catatan *"Saya menolak izin untuk …"* (beserta alasanmu kalau diisi), dan model meneruskan pekerjaan tanpa langkah itu. **■ Stop** tetap menghentikan semuanya |
| 🖥 Sesi dari terminal | OpenCode yang dibuka di terminal (`opencode`, `opencode run`) memakai *background service* yang sama dengan aplikasi. Sesi yang sedang berjalan dan bukan milik aplikasi dibaca tiap 5 detik (`session.active` + `session.message.list`) lalu tampil di kantor dan chat project-nya sebagai sesi terminal, seperti sesi CLI Claude Code. Hanya membaca; riwayat lama tidak diputar ulang |
| ⏳ Batas provider | Saat provider menolak permintaan (mis. HTTP 429 rate limit) dan OpenCode mencoba lagi, chat menampilkan *⏳ Batas pemakaian provider tercapai … percobaan N* (dibaca dari `retry` pesan sesi selama giliran berjalan). OpenCode tidak memberi sisa kuota, jadi hanya kejadian penolakan yang tampil |
| 🔌 MCP | Server dari `opencode.json` (global + project) dengan **status langsung** dari *background service* OpenCode (`mcp.list`: tersambung / menyambung / gagal / perlu login / nonaktif). **↻ Sambungkan ulang**, **▶ / ⏸** (berlaku sampai OpenCode dimulai ulang; config tidak diubah) dan **🔑 Login** lewat OAuth integrasi OpenCode. Kalau provider memberi kode, tempel di kolom yang muncul |
| ⧗ Tugas latar | Shell yang berjalan dari giliran OpenCode project ini tampil di panel ⧗ Tugas latar (`/tasks`): output, ■ hentikan, dan *di latar* saat tool-nya sudah selesai atau dipindah dengan Ctrl+B. **■ Stop** ikut menghentikannya. Shell dari sesi OpenCode **lain** di folder yang sama tampil hanya-lihat (tanpa output/Hentikan) |

- Token OpenCode tercatat di laporan sebagai akun **OpenCode**, terpisah dari akun Claude—termasuk sesi web dan sesi terminal yang dibaca mirror. Akun OpenCode menampilkan pemakaian lokal hari ini/7 hari; sisa kuota provider tidak disediakan OpenCode.
- Setelah satu **Tolak**, OpenCode menghentikan gilirannya, sehingga kartu izin lain dari giliran itu ditutup otomatis.
- Pesan pertama yang menyalakan layanan latar OpenCode dicoba ulang sekali secara otomatis.
- 📦 Backup riwayat membawa chat kedua mesin (`office/chats/` dan `office/chats-opencode/`).
- Saat mesin OpenCode aktif, dialog khusus Claude Code (aturan izin, plugin/agent/hooks, export sesi lengkap) disembunyikan dan route-nya menolak. Pencarian percakapan tetap tersedia dan mencakup sesi Claude + OpenCode. OpenCode memakai `opencode.json` untuk aturan/agent/plugin (bisa diedit lewat **Config & Agent OpenCode**, dengan riwayat backup yang bisa dipulihkan), serta export JSON di Riwayat Sesi.
- **Update & restart OpenCode** dari ⚙ → tab **Sistem** → Kompatibilitas OpenCode: **⬆ Update OpenCode** menjalankan `opencode upgrade`, **↻ Restart layanan OpenCode** menjalankan `opencode service restart`. Keduanya laptop-only, satu per satu, dan ditolak saat ada giliran yang berjalan.
- **🧩 Plugin OpenCode** di bagian yang sama: daftar dari `opencode plugin list`, **＋ Tambah** dari paket npm/Git, **Hapus**, **Update**, **Cek update**, dan **Update semua**. Laptop-only dan memakai config global OpenCode; restart layanan setelah memasang plugin agar aktif.
- **🧩 Config & Agent OpenCode** di bagian yang sama: pilih **Project ini** atau **Global**, lalu ubah `model`, `small_model`, dan agent (nama, mode, model, deskripsi, prompt) lewat **Form**, atau seluruh file lewat **JSON**. Tab JSON menulis teks apa adanya sehingga komentar JSONC tetap; simpan lewat Form menulis JSON biasa. Config yang rusak tetap bisa dibuka lewat tab JSON untuk diperbaiki. Laptop-only dan ditolak saat ada giliran berjalan; sesi OpenCode yang idle dimuat ulang agar config baru dipakai giliran berikutnya.

**Sumber config & banner konflik.** Aplikasi hanya mengubah satu file, tetapi OpenCode membaca beberapa file berurutan—yang belakangan menang per kunci:

| Urutan | File | Cakupan |
|---|---|---|
| 1 | `~/.config/opencode/opencode.json` | Global (atau `opencode.jsonc`) |
| 2 | `<project>/opencode.json` | Project — file yang diedit aplikasi |
| 3 | `<project>/.opencode/opencode.json` | Project; menang atas file root untuk kunci yang sama |

- Kalau `opencode.json` dan `opencode.jsonc` ada di folder yang sama, OpenCode **hanya membaca `.json`**; `.jsonc` diabaikan.
- Banner kuning di atas editor muncul saat ada lebih dari satu file yang dibaca. Isinya: urutan file, file mana yang **dipakai OpenCode** (menang per kunci), dan penegasan bahwa aplikasi hanya mengubah satu file. **Tutup** menyembunyikannya sampai editor dibuka lagi.
- **Konsolidasi ke file ini** (hanya cakupan Project, saat `.opencode` ikut terbaca): isi `.opencode` digabung ke `opencode.json` root (`.opencode` menang per kunci), file root ditulis, lalu file `.opencode` **dipindah** ke folder backup aplikasi dengan awalan **`dot--`**—tidak dihapus. Salinan itu **tidak muncul di 🕘 Riwayat backup** file root dan hanya untuk pemulihan manual di folder data. Tidak ditawarkan untuk kasus `opencode.json` + `opencode.jsonc` di folder yang sama, dan ditolak kalau salah satu file bukan JSON/JSONC yang valid.
- **🕘 Riwayat backup** di bawah editor: daftar backup per cakupan (waktu, ukuran, format), **Pratinjau** isi sebelum memulihkan, dan **Pulihkan**. Memulihkan membackup isi yang sekarang lebih dulu, jadi hasilnya masih bisa dibatalkan. Backup yang rusak ditandai *tidak valid* dan tombol Pulihkan dimatikan.
- **Lokasi & retensi:** `<data>/opencode-config-backups/global/` dan `<data>/opencode-config-backups/<projectId>/`—bukan `.bak-<waktu>` di sebelah config. Maksimal **10 backup per file**, disimpan **90 hari**. File `.bak-*` lama di sebelah config tetap terdaftar (penanda *format lama*) dan bisa dipulihkan; aplikasi tidak pernah menghapusnya. Folder ini tidak ikut 📦 Export riwayat.
- **Simpan, Pulihkan, dan Konsolidasi ditolak (409)** kalau file berubah di luar aplikasi sejak editor dibuka—termasuk kalau editor sudah lama terbuka (*"File berubah di luar aplikasi. Muat ulang lalu simpan lagi."*); tidak ada yang ditulis. Klik **↻ Muat ulang**, cek perubahannya, lalu ulangi. Ketiganya juga ditolak selama ada giliran berjalan (*"Tidak bisa mengubah config OpenCode saat masih ada giliran yang berjalan."*).
- Semua di atas hanya dari laptop, termasuk lewat Tailscale; HP di WiFi biasa tidak bisa membuka editor ini.
- **Saat OpenCode diperbarui**: server membaca `opencode --version` saat menyala (±45 dtk) dan setiap 6 jam. Versi baru → **cek kontrak ringan tanpa token** di latar belakang (setelah giliran yang berjalan selesai): handshake ACP (`initialize`, kemampuan `loadSession`/gambar/@file), `session/new` + opsi model/mode + daftar command, `session/set_config_option`, `session/load`, `opencode models`, `opencode session list`. Tidak pernah mengirim prompt (tidak memanggil model); sesi uji dihapus lagi. Hasilnya muncul sebagai pemberitahuan seperti untuk Claude Code ("OpenCode diperbarui ke vX — semua cek kontrak lulus ✅", atau "⚠ … cek kontrak gagal (…)" + `npm run test:opencode`). **⚙ → tab Sistem → 🧩 Kompatibilitas OpenCode** (hanya dari laptop, hanya bila OpenCode terpasang): status, tombol cek manual, dan *Cek otomatis saat OpenCode diperbarui*. Status di `data/opencode-check.json` (tidak ikut backup). Tanpa OpenCode terpasang: tidak ada apa pun.
- Desain lengkap: [`docs/design-opencode.md`](design-opencode.md).

## Tim & kantor

Siapa yang mengerjakan setiap langkah (file, perintah shell, MCP, skill, tipe subagent) mengikuti peta tetap di [docs/role-mapping.md](role-mapping.md). Langkah dari subagent yang didelegasikan selalu dikerjakan role itu. Nama yang belum dikenali (MCP, skill, subagent, skrip baru) bisa dipetakan di **👥 Kelola tim → 🧭 Pemetaan peran**: untuk laptop ini, atau untuk project lewat `.office-roles.json` yang bisa di-commit bersama project. Ada juga opsi AI (default mati) yang memetakan nama baru sekali saja dengan sedikit token.

| Orang | Role | Dipakai untuk |
|---|---|---|
| Adhit - Lead | Engineering Lead (Claude) | **Atasan**: menerima prompt-mu (di Mode Otak menjadi otak di tengah) dan menutup giliran |
| Adhit - PM | Product Manager | **Juru bicara & pembagi tugas**: menerima brief dari Lead, memecah pekerjaan di papan task, mengantar tugas ke tiap role dan menerima laporannya, bertanya ke kamu bila perlu. Scope, prioritas, acceptance criteria |
| Adhit - BA | Business Analyst | Kebutuhan, aturan bisnis, analisis kode/dokumen |
| Adhit - Tech Lead | Tech Lead / Architect | Desain teknis, arsitektur, review diff |
| Adhit - UI/UX | UI/UX Designer | Alur pengguna, styling, aksesibilitas |
| Adhit - Frontend | Frontend Developer | Komponen, halaman, state di client |
| Adhit - Backend | Backend Developer | API, logika bisnis, integrasi |
| Adhit - DBA | Database Engineer | Skema, migrasi, query, perbaikan data |
| Adhit - QA | QA Engineer | Reproduksi bug, test otomatis, verifikasi |
| Adhit - Security | Security Engineer | Review keamanan, secret, audit dependensi |
| Adhit - DevOps | DevOps / SRE | Build, CI/CD, Docker, environment, deploy |
| Adhit - Writer | Technical Writer | README, dokumentasi API, changelog |
| Adhit - Freelancer | Freelancer / Generalist | Subagent non-spesialis (`general-purpose`, `fork`, tipe tak dikenal). Selalu aktif |
| Adhit - Mobile | Mobile Developer | Flutter, React Native, Android/iOS |
| Adhit - Data/AI | Data / AI Engineer | Pipeline data, analitik, fitur ML/AI |
| Adhit - Support | Tech Support / Helpdesk | Triage laporan user, reproduksi dari log |
| Adhit - Reviewer | Code Reviewer | Review kode independen sebelum dinyatakan selesai |
| Adhit - Compliance | Compliance / Privacy (DPO) | Data pribadi (UU PDP / GDPR): consent, retensi, kebijakan privasi |

**👥 Kelola tim** (⚙, menu ⋯, `Ctrl+P`, atau `/team`): pilih role dari katalog bawaan (12 inti + 5 opsional: Mobile, Data/AI, Support, Reviewer, Compliance). **Bawaan: semua 17 role aktif, termasuk Compliance.** Tim yang sudah pernah disimpan tidak diubah; aktifkan role baru di sini, atau **↺ Tim bawaan**. Lead selalu ada, Freelancer selalu aktif. Role nonaktif tidak dipakai: pekerjaannya dialihkan ke role aktif terdekat (mis. reviewer → architect, data → backend, compliance → security → ba; katalog di `src/role-catalog.js`). Sesi yang diam dimulai ulang otomatis, yang sibuk setelah gilirannya selesai.

**Ganti nama:** klik kartu orangnya di bawah kantor (atau ⚙ → *Ganti nama anggota tim*). Nama tersimpan di server, jadi sama di laptop dan HP. Definisi subagent ada di `.claude/agents/*.md` (bisa diedit); hanya role aktif yang dikirim ke `--agents`.

**Alur kerja dengan Mode tim:** fitur baru (PM → BA → Architect → UI/UX → developer → QA → Security bila perlu → Writer), bug fix (QA mereproduksi → developer → Architect review → QA verifikasi), build/insiden (DevOps → Backend/DB → QA). Role opsional menambah langkahnya sendiri (mis. Compliance bersama Security untuk perubahan data pribadi). Tugas kecil dikerjakan langsung. Tanpa Mode tim (dan untuk sesi CLI), tiap aksi tetap dibagi menurut jenis file/perintah: `.tsx` ke Frontend, migrasi ke DBA, `npm test` ke QA, `docker` ke DevOps, dan seterusnya.

**Kantor:** satu lantai tetap **640×344 px** untuk 17 role + Lead. Ruang kaca untuk PM, Tech Lead, dan Lead (ruang sudut) di dinding atas; pod kubikel per departemen (Produk & Desain, Engineering, Kualitas & Keamanan, Ops & Support); ruang rapat, pantry, dan lounge dengan radio. Role yang dimatikan meninggalkan meja kosong, ruangan tidak berubah.

| Di stream Claude Code | Di kantor |
|---|---|
| Delegasi `Agent` | Lead (atau spesialis yang mendelegasikan) berjalan ke meja penerima tugas; laporan dibawa balik saat selesai |
| Beberapa subagent role sama paralel | Badge **×N** di nama |
| Output test | Hijau: bersorak "✅ N test lulus". Merah: "🐞" dan bug diantar ke developer terakhir |
| `EnterPlanMode` / `ExitPlanMode` | PM, Tech Lead, dan BA rapat di ruang rapat |
| Minta izin / `AskUserQuestion` | Yang bertanya mengangkat tangan, seisi kantor menunggu |
| Error / selesai | Layar merah dan asap / confetti |

Monitor tiap meja menunjukkan jenis kerja (kode, terminal, test, dokumen, desain, database, CI/CD, …). Saat idle, tim ngopi, duduk di sofa, atau ngobrol. **🎨 Tema kantor** (⚙): Kantor, Halloween, Natal, Lebaran, 17 Agustus (disimpan per browser).

## Project & dashboard

- **Pilih project** (`Ctrl+K`, klik nama project): folder yang pernah dibuka Claude Code (✳) dan semua subfolder dari folder induk. Bisa dicari, ↑↓ + Enter, dan ditambah satu folder lepas (laptop). **☆** menjadikan favorit (selalu di atas, tersimpan di server), **📦** mengarsipkan project (disembunyikan dari daftar tanpa menghapus data; tombol **📦** di judul dialog menampilkan yang diarsipkan, dan project yang sedang dibuka selalu terlihat). Tombol project menampilkan jumlah izin yang menunggu di project lain. Project yang foldernya sudah dipindah/dihapus ditandai **folder hilang** dan bisa dibersihkan lewat 🗑 — hanya data aplikasi (pengaturan, riwayat chat kedua mesin, antrian, baris laporan token) yang dihapus; folder di disk dan file backup tidak disentuh. Project custom yang foldernya hilang tetap terdaftar setelah restart/refresh. Project yang foldernya masih ada tidak bisa di-purge.
- **🗂 Semua project** (header, `Ctrl+P`, `/dashboard`; di HP bar di atas tampilan Kantor): satu layar untuk semua project, diurutkan **butuh kamu** (✋ Butuh izin, ⚠ Terputus, ⚠ mungkin macet) → **⏳ Bekerja** → **📋 Antrian** → **💤 Idle**. Tiap kartu: aktivitas terakhir, model, konteks %, potongan prompt/jawaban, dan **badge budget** `💰 $12,00 / $20,00` bila project punya batas sendiri (kuning ≥80%, merah ≥100%). **✋ Lihat izin** langsung ke kartu izinnya; **📋 Antrian** membuka antrian project itu dan **■ Hentikan** menghentikan giliran yang sedang berjalan — tanpa pindah project. Di atas daftar ada ringkasan **Hari ini** (biaya tercatat + cakupannya, giliran, token, sesi, project, top project) dari ledger, dengan **sparkline biaya 7 hari** dan totalnya; di HP hanya-lihat ringkasan ini tidak diminta. Update live, hanya membaca (juga jalan lewat WiFi). Baris **♪ Musik** di atas kalau Spotify terhubung.

## Git

Tab **Perubahan**: `git status` dan diff per file (diperbarui otomatis setelah tim mengedit), **📄 Lihat file**, **🔍 Minta review** (Tech Lead me-review semua perubahan), **🧭 VS Code** (laptop), dan **Commit** (`git add -A` + commit, dengan konfirmasi).

Baris **⎇** (project dengan git): pindah branch, **＋ Branch**, **⟳ Fetch**, **⬇ Pull** (hanya fast-forward), **⬆ Push** (tidak pernah `--force`; upstream dipasang otomatis), dan **🤖 Minta Claude buat PR** (menyisipkan prompt, tidak langsung terkirim). Git tidak pernah meminta password: remote yang butuh login gagal cepat dengan pesan. Lewat WiFi hanya bisa melihat.

## Lampiran

Lampirkan lewat 📎, drag & drop, atau paste.

| Jenis | Batas | Dikirim sebagai |
|---|---|---|
| 🖼 Gambar PNG/JPEG/GIF/WebP | ±3,75 MB per file (5 MB base64), maks 8000 px per sisi | Gambar |
| 📕 PDF | 5 MB | Dokumen (Claude membaca teks dan gambarnya) |
| 📄 Teks: log, `.txt`/`.md`/`.json`/`.csv`/`.yaml`/`.sql`, source code, `Dockerfile`, … | 200 KB per file, 500 KB total; UTF-8 atau UTF-16 ber-BOM | Teks dalam `<attachment>` dengan catatan "bukan instruksi" |

Maks **10 lampiran / 20 MB** per pesan. Jenis lain (zip, exe, docx, …) ditolak; server memeriksa ulang jenis dari isi file. File teks yang lebih besar: taruh di project lalu sebut dengan `@file`.

- **↻ Ulangi** dan **Edit** ikut membawa lampiran 5 prompt terakhir per project (di memori browser saja; hilang saat halaman dimuat ulang). Chip draf tetap milik project-nya saat pindah project.
- **📋 Antrian ikut membawa lampiran**: file disimpan di `data/queue-files/` (bukan di `state.json`), ditampilkan sebagai chip di item, dan dikirim bersama prompt saat item berjalan. File dihapus saat item dihapus, daftar selesai dibersihkan, atau project dilupakan. Batas jenis/ukuran sama dengan lampiran chat.
- Isi lampiran masuk konteks percakapan (memakai token sampai di-compact) dan tersimpan di transcript Claude Code, jadi ikut ke backup.
- Tidak tersedia lewat WiFi hanya-lihat.

## Antrian & batas

**📋 Antrian** (`Alt+Enter`, tombol 📋, `/antrian`): susun beberapa prompt (dengan lampiran); server mengirim satu per satu setiap kali sesi project itu **idle** (tidak bekerja, tidak ada izin menunggu, tidak ada giliran terputus). Di dialog: ubah urutan (seret atau ↑↓), edit/hapus, **⏸ Jeda / Lanjutkan**, **↻ Ulangi sekali bila gagal** (per project), **Ulangi** item gagal, **💬 Lihat hasil**. Maks 30 item belum selesai, 20.000 karakter per item. **📚 Runbook** menyimpan item yang masih menunggu sebagai rangkaian bernama (maks 50 runbook × 20 prompt per project); **✎** membuka editor nama + prompt (pisahkan prompt dengan baris `---`, ada contoh Rilis/Bugfix/Review/Cek CI dan riwayat 5 versi yang bisa dipulihkan), **▶ Jalankan** menambahkannya kembali ke antrian, **⏰** menjadikannya jadwal harian, dan **↻ Lanjutkan** mengulang item runbook yang gagal lalu melanjutkan antrian.

Antrian **berhenti sendiri** bila item gagal atau dihentikan, kuota akun habis, atau batas tercapai. Setelah server restart, antrian **tetap dijeda** sampai kamu melanjutkan.

**💰 Batas antrian** (di dialog): maks token output dan/atau maks biaya (USD, estimasi harga list) per project, dengan bar progres. Dicek setiap kali satu item selesai, jadi giliran yang berjalan tidak pernah dipotong. Menyimpan batas baru atau melanjutkan setelah berhenti karena batas memulai hitungan dari nol.

**⚡ Batas giliran bersamaan** (⚙ → **Umum**, hanya dari laptop): berapa banyak project yang boleh bekerja serentak. Default **3**, rentang **0–8**, dan **0 = tanpa batas** (tersimpan sebagai `maxConcurrent` di `state.json`).

- Hanya giliran yang dijalankan server yang dihitung. Sesi CLI di terminal tidak dihitung dan tidak dibatasi.
- Saat batas penuh, prompt baru ke project lain **otomatis masuk 📋 Antrian** dan berjalan sendiri saat ada slot kosong (tidak ada prompt yang hilang). Prompt itu langsung tampil sebagai bubble **“antre #N”** dengan tombol **✕ Batal**; giliran yang sama memakai bubble tersebut (tidak dobel). Pesan susulan ke project yang sedang bekerja tetap diterima karena bergabung ke giliran yang sama.
- Slot diberikan secara **FIFO lintas project**: prompt interaktif didahulukan dari tugas terjadwal/runbook, lalu yang paling lama menunggu. Nomor `#N` mengikuti urutan itu.
- Effort/Model Auto untuk prompt yang antri diputuskan **saat giliran mulai**, bukan saat menunggu, jadi tidak ada panggilan klasifikasi tambahan saat laptop penuh.
- `/compact`, `/continue`, dan handoff tetap ditolak dengan **429** beserta penjelasan (menyebut project yang sedang bekerja); kartu rencana yang menunggu persetujuan tetap terbuka.
- Item 📋 Antrian **tidak gagal**: tetap menunggu lalu berjalan otomatis saat ada slot kosong. Bila antrian project sedang dijeda, prompt yang datang saat batas penuh ditolak dengan penjelasan agar tidak menumpuk diam-diam.
- Di 🗂 Semua project ada badge `⚡ 2/3` (jumlah yang bekerja / batas; disembunyikan bila 0, berwarna peringatan saat penuh), dengan ringkasan yang sama di bar HP.
- Menurunkan batas tidak pernah memotong giliran yang sedang berjalan; batas baru berlaku untuk giliran berikutnya. Mengubah batas hanya bisa dari laptop (dari HP, termasuk Tailscale, bagian ini tidak tersedia).

**🌐 Semua antrian** (tombol **🌐 Semua** di header dialog 📋 Antrian, atau `Ctrl+P` → *Semua antrian*): semua item antrian lintas project dalam urutan penjadwalan yang sama dengan pemberian slot—item **berjalan** dulu (paling lama mulai), lalu **menunggu** menurut posisi global `#N`, lalu antrian yang **dijeda** (⏸). Judulnya meringkas `N menunggu · M berjalan`, ditambah `· K antrian dijeda` bila ada. Tiap baris punya **Buka** (membuka dialog 📋 Antrian project itu) dan **Batal** untuk item yang menunggu. Panel mengikuti event `queue`, jadi menyegar sendiri selama terbuka. Hanya-lihat: boleh dibuka dari HP WiFi, tetapi Batal (dan semua perubahan) ditolak dari sana. Datanya dari `POST /api/queues` (read-only) yang mengembalikan `queues`, `waiting`, `running`, plus `queuePosition` dan `etaMs` per item.

**⏳ Perkiraan tunggu di bubble:** bubble **antre #N** menampilkan `· ±X mnt` bila tunggunya ≥60 detik, atau `· sebentar` bila kurang. Angkanya dari median durasi giliran terakhir project itu (maks 10 terakhir; bila belum ada, dipakai durasi lintas project), lalu slot yang sedang berjalan disimulasikan. Tanpa data durasi sama sekali, ETA tidak ditampilkan—bubble tetap `antre #N`. Ini perkiraan, bukan janji.

**✎ Edit prompt antre** (tombol **Edit** pada bubble yang masih `antre`): mengubah item antrian itu sendiri, bukan menyalin teksnya ke kotak pesan. Server menulis ulang item dan memperbarui **bubble yang sama**, jadi tidak ada item atau bubble kedua. Item yang sudah berjalan tidak bisa diedit (ditolak **409**).

**Batasan:** item pada antrian project yang dijeda tetap dihitung **menunggu** di ringkasan dan diberi penanda **dijeda**, walau belum punya posisi `#N` dan tidak akan mulai sampai antrian dilanjutkan.

**⏳ Peringatan kuota** (⚙): toast, notifikasi, dan penanda berwarna saat kuota sesi 5 jam atau mingguan melewati ambang kuning/merah (ambang diatur di ⚙, disimpan per browser). Dibaca dari sesi yang berjalan, tanpa request tambahan.

## Notifikasi

Klik **🔔** di header untuk mengaktifkan. Notifikasi dan suara muncul saat ada yang **minta izin**, tugas **selesai**, atau **berhenti/error**, selama kamu di tab/aplikasi lain atau project lain (minta izin tetap berbunyi walau sedang dilihat). Klik notifikasinya untuk langsung ke project itu.

**🔔 Pengaturan notifikasi** (`Ctrl+P` → *Pengaturan notifikasi*; di HP tombol 🔎 atau ⋯; di laptop juga klik kanan 🔔 atau ⚙):

- notifikasi dan suara on/off **per jenis kejadian**;
- **🌙 jam tenang** (boleh lewat tengah malam), dengan *Izin tetap diberitahu saat jam tenang* (aktif secara bawaan);
- **hanya project favorit ★**, **🔇 project dibisukan** (tidak ada suara/pop-up dari project itu, termasuk minta izin), **volume** dengan **▶ Tes suara**, **↺ Kembalikan bawaan**;
- **📱 Notifikasi HP (push)**: lihat [Notifikasi push ke HP](../README.md#notifikasi-push-ke-hp).

Disimpan per perangkat (browser).

## Musik (Spotify)

Kontrol Spotify yang sudah kamu pakai (Spotify Connect) lewat Spotify Web API. Butuh **Spotify Premium** untuk kontrol; now-playing tetap tampil tanpa Premium.

**Setup (sekali, di laptop: ⚙ → ♪ Spotify):**

1. Buat app di [developer.spotify.com](https://developer.spotify.com/dashboard).
2. Tambahkan Redirect URI persis seperti yang tampil di ⚙ (tombol **📋 Salin**): `http://127.0.0.1:4317/spotify/callback`. Kalau `OFFICE_PORT` diubah, port di URI ikut berubah.
3. Di *Users and Access*, tambahkan email akun Spotify kamu (app mode pengembangan).
4. Tempel **Client ID** lalu **Simpan**. **Tanpa client secret** (login memakai PKCE). Bisa juga lewat env `SPOTIFY_CLIENT_ID`.
5. **🔗 Hubungkan**, login di Spotify, lalu tutup tab-nya.

**Pemakaian:**

- **Pill lagu** di header, **radio** di lounge kantor (karakter yang santai ikut bergoyang), dan baris ♪ di 🗂 Semua project. Klik untuk dialog **♪ Musik**: ⏮ ⏯ ⏭, volume, **Perangkat**, dan **Playlist** (lihat isi playlist milikmu dan putar mulai dari lagu tertentu; playlist milik orang lain atau Spotify diputar utuh).
- **▶ tanpa perangkat aktif:** server memilih perangkat ★ utama (☆ *Selalu putar di sini*), satu-satunya perangkat yang ada, atau **membuka aplikasi Spotify di laptop di latar belakang** (diperkecil, tanpa mencuri fokus) lalu memutar di sana. Bisa dimatikan: ⚙ → *Buka Spotify otomatis di latar belakang*. **💻 Laptop ini** selalu ada di daftar perangkat.
- **Saat ada permintaan izin:** Mati / Kecilkan / Jeda; dipulihkan setelah izin dijawab kalau kamu tidak mengubah apa pun.
- **⏏ Putuskan** menghapus token lokal. Untuk mencabut akses sepenuhnya: spotify.com/account/apps.

| Dari | Bisa |
|---|---|
| Laptop | Semua, termasuk Client ID, hubungkan/putuskan, tampilkan radio |
| HP Tailscale | Kontrol, perangkat, playlist, *saat ada permintaan izin* dan buka otomatis |
| HP WiFi | Hanya melihat lagu yang diputar (tanpa nama perangkat) |

## Akun & laporan

**👤 Akun** (avatar di header): nama, email, organisasi, paket, kuota (sesi 5 jam & mingguan, dari `/usage`, tanpa memakai token), dan pemakaian token hari ini / 7 hari.

- **Ganti akun / Login** menjalankan `claude auth login`; tempel kodenya di dialog bila diminta. Ada juga *Login via Console* untuk akun API.
- **Logout** menjalankan `claude auth logout` dan berlaku untuk **seluruh Claude Code di laptop**, termasuk terminal.
- Sebelum ganti akun muncul ringkasan dampak: giliran yang berjalan selesai dulu, **semua antrian dijeda** (chip “dijeda karena akun berubah”), dan sesi terminal perlu dibuka ulang. Lanjutkan hanya setelah dikonfirmasi.
- Setelah ganti akun, proses Claude dari web dimulai ulang. Giliran yang berjalan selesai dulu, tokennya dicatat ke akun lama. **Perubahan akun tercatat** di **Riwayat perubahan akun** (masuk/keluar, mesin/provider, laptop atau nama HP, gagal/berhasil).
- Dari HP **hanya lewat Tailscale**. Logout dari HP butuh konfirmasi + ketik `LOGOUT`. Setiap login/logout dari HP memunculkan peringatan di laptop dan dicatat di `data/server.log` serta riwayat perubahan akun.
- OpenCode: logout provider juga butuh konfirmasi `LOGOUT`. Kalau model yang sedang dipakai berasal dari provider itu, model **tidak diganti diam-diam**; muncul peringatan dan prompt berikutnya menunggu sampai kamu memilih model lain atau Default.

**📊 Laporan**: pemakaian token per akun atau **Semua akun (Claude + OpenCode)** dan periode (Hari ini, 7 hari, 30 hari, Bulan ini, Semua, atau 📅 tanggal). Pratinjau berisi KPI dan **📈 Tren** per hari/minggu/bulan; rincian per periode, per model, blok **Per mesin**, dan **Per role (perkiraan)** ada di **Rincian per periode & model** yang bisa dibuka. **⬇ Unduh PDF** menambah rincian per mesin × sumber, per project, sumber (web/CLI), sesi teratas, per role, dan kuota. PDF dibuat Edge/Chrome headless (env `OFFICE_BROWSER` untuk path lain); tanpa keduanya, laporan dibuka di tab baru untuk dicetak.

- **Budget pemakaian**: di ⚙ → **Umum** → **Budget pemakaian** pilih **Global (semua project)** atau satu project, lalu isi batas **harian / mingguan / bulanan** (USD, atau kosong = tanpa batas). Baris `$12,30 / $20 (62%)` berubah hijau/kuning (≥80%)/merah (≥100%), dengan **sisa** dolar, plus **proyeksi akhir bulan** `±$X` dari laju bulan ini (peringatan bila proyeksinya melewati batas bulanan) dan **grafik 7 hari terakhir** (batang per hari, hari kosong tetap tampil; arahkan kursor untuk tanggal dan nominalnya). Ringkasan global muncul di 🩺 Kesehatan. Saat sebuah batas tercapai, **pengiriman prompt dihentikan** (prompt, ringkas konteks, lanjutkan giliran, handoff, dan build dari kartu rencana ditolak) dan antrian dijeda. Tombol **Izinkan 1 giliran** memberi satu giliran lewat dengan konfirmasi (berlaku 5 menit), lalu hard stop aktif lagi. Perubahan batas dan override dicatat di `data/budget-audit.jsonl` (180 hari terakhir) dan bisa dilihat di **Riwayat perubahan budget** pada bagian yang sama. Dihitung dari biaya tercatat (harga list Claude; OpenCode Go umumnya tercatat $0 karena langganan).

- **⏰ Tugas terjadwal**: ⚙ → **Jadwal**. Simpan prompt per project dengan jadwal **sekali**, **harian**, atau **mingguan** (jam lokal). Daftar jadwal menampilkan **kalender 7 hari ke depan** (jam + potongan prompt per hari). Jadwal juga bisa menunjuk **📚 runbook** (dibuat dari tombol ⏰ di daftar runbook): saat waktunya tiba, semua prompt runbook masuk ke **antrian** dan tetap mengikuti aturan giliran, izin, dan budget yang sama; jadwal bisa **diubah**, **dijalankan sekarang**, dijeda, dilanjutkan, atau dihapus; hasil gilirannya muncul di chat dan status terakhir (**selesai/gagal**, waktu, error) tersimpan di daftar jadwal, lengkap dengan **riwayat 5 run terakhir**. Jadwal yang terlewat lebih dari 12 jam tidak dijalankan terlambat.

- **Kuota OpenCode Go**: di 👤 Akun (OpenCode) ada perkiraan sisa kuota per model untuk jendela **5 jam / 7 hari / 30 hari**, dihitung dari token tercatat × harga list katalog resmi. Pilih paketmu: **Go ($10/bulan)**, **Go Plus ($40/bulan)**, atau **Go Teams ($20/anggota/bulan)**; batas tiap model mengikuti tabel resmi paket itu, dan Go Teams dihitung per anggota. Angka ini perkiraan — kuota resmi tetap di console OpenCode.

- **Per mesin**: baris **Claude · Web**, **Claude · Terminal**, **OpenCode · Web**, dan **OpenCode · Terminal** (yang kosong disembunyikan) dengan total token, persentase dari total laporan, dan biaya. Pilih **Semua akun** untuk melihat Claude dan OpenCode dalam satu laporan; pilihan per akun tetap ada.
- **Biaya per model**: daftar model di laporan juga menampilkan biaya dari catatan pemakaian (bukan harga list). `—` berarti belum ada catatan biaya untuk model itu, `$0.00` untuk model gratis.
- **Biaya**: `—` bila tidak ada catatan biaya untuk kelompok itu, `$0.00` untuk model gratis (OpenCode), dan `(N%)` bila hanya sebagian catatan punya biaya. Kartu **Estimasi biaya** menampilkan berapa persen catatan yang punya biaya.
- **🧩 Per role (perkiraan)**: tabel **Backend Developer**, **Frontend Developer**, **QA**, **Lead (utama)**, dan role lain dengan token, persentase dari total laporan, biaya, serta jumlah delegasi. Claude dihitung dari **proporsi token di transcript**: main thread = Lead, setiap `agent-*.jsonl` = role dari `agentType`-nya. OpenCode memakai **`agent` yang disimpan di ledger** sejak fitur ini aktif (build/plan = Lead, nama role = subagent); baris lama yang belum punya `agent` memakai `session.list` sebagai cadangan. Total tabel **selalu sama dengan total laporan**; cache read dan sesi yang sudah tidak ditemukan membuat pembagiannya tidak presisi. Sesi Claude tanpa transcript masuk **Tanpa rincian role**; sesi OpenCode yang tidak ditemukan di ledger/store masuk **OpenCode (tanpa rincian role)**. Baris **Cakupan** menunjukkan berapa persen token dan berapa sesi yang benar-benar punya rincian role. CSV juga memuat bagian ini.

- Catatan token disimpan bersama akun yang login saat itu (`data/usage.jsonl`), jadi dua akun tidak tercampur. Data mulai terkumpul sejak fitur ini aktif; transcript lama tidak dihitung. File ini **dirotasi otomatis** ke `data/usage-archive/` saat besar, dan semua arsip tetap dibaca laporan serta ikut backup.
- **Audit akun** (`data/auth-audit.jsonl`) dipadatkan saat file melewati 256 KB atau saat server mulai: menyimpan **180 hari terakhir** (maks 2.000 aksi).
- Sesi CLI ikut tercatat ke akun yang sedang login. Setelah ganti akun, buka ulang sesi CLI yang masih terbuka. Estimasi biaya (USD, harga list) hanya untuk sesi web.

## Figma (bridge lokal)

`tools/figma-bridge/` menghubungkan agent AI ke **Figma desktop** lewat plugin, tanpa token Figma dan tanpa internet:

- Jalankan bridge: `node tools/figma-bridge/server.mjs` (HTTP lokal `127.0.0.1:3939` + MCP stdio).
- Di Figma desktop: **Plugins → Development → Import plugin from manifest…** → pilih `tools/figma-bridge/plugin/manifest.json`, lalu jalankan **Adhit Office Bridge** di file yang ingin dikerjakan. Biarkan jendela plugin terbuka.
- Daftarkan MCP di Adhit Office (**🔌 Server MCP**) dengan command `node <path repo>\tools\figma-bridge\server.mjs`.
- Tool: `figma_status`, `figma_selection`, `figma_page`, `figma_node`, `figma_export` (SVG/PNG), `figma_create_frame`, `figma_create_rect`, `figma_create_text`, `figma_set_fill`, `figma_move`.
- Perintah hanya masuk lewat MCP; plugin memakai izin akun Figma kamu dan hanya file yang sedang terbuka. Detail & troubleshooting: [`tools/figma-bridge/README.md`](../tools/figma-bridge/README.md).

## Kesehatan & diagnostik

🩺 **Kesehatan sistem** (⚙ → tab **Sistem**, hanya laptop/Tailscale) merangkum server, akun, folder project, backup, akses HP, error 24 jam, dan ukuran data. Bagian di bawah menjelaskan angka aktivitas dan arti peringatan backup; pemeriksaan lain ada di [Tanpa terminal](#tanpa-terminal).

**📈 Aktivitas 7 hari**

Di bawah **Pemeriksaan**, 🩺 menampilkan baris **Hari ini** dan tabel 7 hari terakhir (waktu lokal, hari tertua di atas):

| Kolom | Isi |
|---|---|
| Hari | Tanggal `DD/MM` |
| Giliran | Giliran web yang selesai (berhasil + gagal) |
| Gagal | Giliran yang berakhir gagal |
| Antrian | Item 📋 Antrian yang mulai dijalankan |
| Tunggu p95 | Waktu tunggu item antrian, persentil 95; `—` bila hari itu tidak ada sampel |
| Kena batas | Berapa kali ⚡ batas giliran bersamaan tercapai: prompt yang masuk antrian + command/handoff/approval yang ditolak |

Yang dicatat hanya **angka agregat** di `data/metrics.json`, rolling **7 hari** lokal (hari yang lebih lama dibuang otomatis):

- jumlah giliran selesai/gagal dan rata-rata durasinya,
- jumlah item antrian yang mulai, plus p50/p95 waktu tunggunya,
- `capacityQueued`: prompt masuk antrian karena batas giliran,
- `capacityRefused`: command, handoff, atau approval ditolak karena batas,
- jumlah restart server dan waktu terakhirnya.

Contoh: `Hari ini: 12 giliran (1 gagal) · 3 dari antrian · rata-rata 2 mnt · tunggu p95 45 dtk · 2× kena batas.` Tabelnya bisa berisi:

| Hari | Giliran | Gagal | Antrian | Tunggu p95 | Kena batas |
|---|---|---|---|---|---|
| 02/11 | 8 | 0 | 1 | 30 dtk | 0 |
| 03/11 | 0 | 0 | 0 | — | 0 |
| 04/11 | 14 | 1 | 4 | 1 mnt | 3 |
| 05/11 | 11 | 0 | 2 | 0 dtk | 1 |

- Hari tanpa sampel tunggu menampilkan `—`, bukan `0`; hari tanpa aktivitas tetap tampil dengan angka `0`.
- Restart dihitung setiap server menyala dan tidak ikut dibuang bersama jendela 7 hari; baris di bawah tabel menulis `Server mulai ulang N kali · terakhir …`.
- Kalau server belum mengirim data metrics (versi lama), bagian ini tidak muncul sama sekali.

**Alarm backup**

Pemeriksaan **Backup otomatis** di 🩺 tidak berhenti di status jadwal terakhir: server juga melihat folder tujuan dan mencari file `adhit-office-backup-auto-*.zip` terbaru.

| Kondisi | Hasil di 🩺 |
|---|---|
| File auto terbaru ada dan masih segar | ✅ `Terakhir … · nama file · ukuran` |
| Harian: file lebih tua dari **36 jam**; mingguan: lebih tua dari **8 hari** | ⚠ warning, ingatkan untuk memeriksa folder lalu menjalankan lagi |
| File tidak ditemukan (folder pindah, file dihapus, atau folder tidak terbaca) | ⚠ *File backup tidak ditemukan di folder tujuan* |
| Jadwal mati, folder belum diatur, belum pernah jalan, atau run terakhir gagal | ⚠ warning, tanpa cek file |

- Hanya file hasil ⏰ backup otomatis yang dihitung. Export manual `adhit-office-backup-YYYY-MM-DD.zip` (tanpa `-auto-`) tidak dihitung, jadi menyimpan export manual tidak mematikan alarm.
- Umur file dibandingkan dengan jadwal yang aktif: harian memberi toleransi 36 jam (satu jadwal terlewat), mingguan 8 hari.
- Perbaiki dengan memastikan folder tujuan ada dan bisa ditulis, lalu **▶ Jalankan sekarang** di ⚙ → Cadangkan riwayat.

**Batasan**

- Angka hanya dari giliran **web yang dijalankan server**. Sesi CLI yang dipantulkan ke kantor (mirror) dan demo kantor tidak dihitung, karena server tidak menjalankan gilirannya.
- p95 dihitung dari maksimal 200 sampel tunggu terakhir per hari, jadi angka ini perkiraan.
- `data/metrics.json` adalah **diagnostik, bukan backup**: tidak ikut export/import, tidak memuat teks percakapan/prompt/nama project, dan aman dihapus (server mulai dari kosong).

## Backup & riwayat

Ganti SSD, install ulang Windows, atau pindah laptop tanpa kehilangan percakapan lama.

1. Laptop lama: **⚙ → 💾 Cadangkan riwayat → ⬇ Export riwayat** → `adhit-office-backup-YYYY-MM-DD.zip`. Isi **🔐 Kata sandi backup** (min. 8 karakter) bila ingin file **`.aob` terenkripsi** (AES-256-GCM); **🎲 Buat** mengisi kata sandi acak kuat, **📋** menyalinnya. Kosongkan untuk `.zip` biasa. Simpan di tempat aman (isinya seluruh riwayat percakapan). **🔎 Verifikasi file** memeriksa file + sandi tanpa memulihkan; **🔑 Ganti sandi** membuat ulang `.aob` dengan sandi baru.
2. Laptop baru: [Mulai cepat](../README.md#mulai-cepat), login dengan `claude`, clone/salin folder project-mu.
3. **⚙ → Cadangkan riwayat → ⬆ Import riwayat**, pilih `.zip`/`.aob` (isi kata sandi di kolom yang sama untuk `.aob`), lihat **pratinjau** (jumlah project, sesi, chat, ukuran, tanggal dibuat), centang project yang ingin dipulihkan (default semua) dan **data kantor** yang ikut (pengaturan & folder, laporan token, riwayat prompt), lalu **Pulihkan**. Daftar project/sesi langsung ter-update. Project yang tidak dicentang tidak ikut (transkrip dan chat-nya).
4. Lanjutkan lewat **🕘 Riwayat sesi**. Project dari backup membawa **mesinnya** (bila OpenCode terpasang) dan percakapan **Claude** yang tersimpan di arsip; sesi OpenCode tidak dipulihkan karena penyimpanannya tidak ikut backup. Mode izin tiap project kembali ke **Tanya dulu**.

| Ikut di backup | Tidak ikut |
|---|---|
| `~/.claude/projects/**` (sesi, subagent, `memory/`), `history.jsonl`, `file-history/` (checkpoint rewind), `plans/` | Login & kredensial Claude (`.credentials.json`, `~/.claude.json`) |
| `data/state.json` (folder, favorit, pengaturan project, **mesin per project**, model/effort per mesin, nama tim, template), `data/usage.jsonl` + `data/usage-archive/` (ledger, dirotasi otomatis), `data/chats/*.jsonl` dan `data/chats-opencode/*.jsonl` (riwayat chat panel) | HP yang dipasangkan dan langganan push, kunci VAPID, `data/tls/`, `data/spotify.json`, `data/metrics.json`, cache, `server.log`, salinan `data/state.json.pre-per-project-*` |

**Import menggabungkan, tidak menimpa:**

| Data | Aturan |
|---|---|
| Sesi `.jsonl` | Belum ada → ditulis. Sudah ada → diganti hanya kalau versi backup adalah **lanjutan** dari yang ada. Bercabang → tidak ditimpa, ada peringatan. Sesi yang sedang berjalan tidak disentuh |
| File lain (memori, checkpoint, rencana) | Belum ada → ditulis. Identik → dilewati. Berbeda → **tidak pernah ditimpa**: disimpan sebagai `<nama>.from-backup` dengan peringatan |
| `history.jsonl`, `usage.jsonl` | Digabung tanpa duplikat (maks 64 MB) |
| Chat panel | Digabung per pesan (yang sudah ada dilewati), 250 pesan terbaru disimpan. Izin/tool yang dulu menunggu tampil sebagai dibatalkan |
| `state.json` | Folder hanya ditambah kalau berada **di bawah folder home** laptop ini dan ada. Favorit ditambah; pengaturan per project hanya mengisi yang kosong. **Mesin tiap project** dan pengaturan model/effort per mesin dipulihkan bila mesinnya tersedia (OpenCode tidak terpasang → Claude Code). **Mode izin tidak pernah dipulihkan**; id percakapan Claude boleh dipulihkan (transkripnya ikut), id OpenCode tidak (penyimpanannya tidak ikut). Import tidak pernah menghapus apa pun |

**Folder home berbeda** (mis. `C:\Users\lama` → `C:\Users\baru`): folder transcript diganti nama mengikuti aturan Claude Code supaya `claude --resume` di folder baru menemukannya. Import yang sama boleh diulang; tidak ada yang ditambahkan dua kali.

> **Hanya import backup milikmu sendiri.** Import memperlakukan backup sebagai data yang belum tentu tepercaya, tetapi isi transcript dan memori project tetap dibaca Claude saat sesi dilanjutkan. Backup adalah **data pribadi**: pilih enkripsi kata sandi (`.aob`) bila file akan disimpan di tempat yang kurang aman; tanpa kata sandi file `.zip` tidak terenkripsi (transcript, email akun, id percakapan). Simpan di folder yang hanya kamu akses, dan hapus bila tidak diperlukan. Import hanya menambah, tidak pernah menghapus.

**Hapus data:** export zip adalah jawaban akses/portabilitas. Untuk menghapus, hapus zip backup, folder `data/chats*`, `data/usage*.jsonl`, `data/auth-audit.jsonl`, `data/redo/`, `data/trash/`, dan `~/.claude/projects` sesuai kebutuhan. Salinan `data/state.json.pre-per-project-*` (paling banyak 5, maks 30 hari, **tanpa** data HP/VAPID) juga aman dihapus setelah aplikasi berjalan normal.

**⏰ Backup otomatis** (⚙ → Cadangkan riwayat, laptop, nonaktif secara default): **Harian** atau **Mingguan** + hari, **jam**, **folder tujuan** (path lengkap di laptop ini; folder jaringan dan path relatif ditolak), dan **simpan N backup terakhir** (1–100). Nama file `adhit-office-backup-auto-YYYYMMDD-HHmmss.zip`. Jadwal yang terlewat saat laptop mati dijalankan sekali begitu server menyala. Rotasi hanya menghapus file `adhit-office-backup-auto-*.zip`. Ada **▶ Jalankan sekarang** dan status hasil terakhir. File terbaru juga dicek ada dan tidak basi di 🩺 (lihat [Kesehatan & diagnostik](#kesehatan--diagnostik)).

**🕵️ Data saya** (⚙ → Cadangkan riwayat, laptop): ukuran `state.json`, riwayat chat kedua mesin, ledger pemakaian dan arsipnya, lampiran antrian, bundel redo, backup config OpenCode, riwayat kesehatan, log server, riwayat notifikasi, trash sesi (dengan retensi 30 hari), dan backup otomatis. Pembersihan aman: **🧹 Hapus riwayat notifikasi**, **🗑 Kosongkan trash sesi**, **↩️ Hapus bundel redo**, **🧩 Hapus backup config OpenCode**, **📈 Hapus riwayat kesehatan**, dan **📝 Kosongkan log server** (semua permanen; cadangkan dulu bila perlu). **Hapus data project** menghapus chat kedua mesin, ledger, pengaturan, sesi, antrian, lampiran antrian, dan bundel redo satu project tanpa menghapus project/folder-nya. Backup otomatis adalah ZIP seluruh kantor, jadi file yang sudah dibuat **tidak bisa dihapus per project**—hapus ZIP-nya sendiri bila perlu. Riwayat chat dan laporan pemakaian tidak dihapus dari tombol lain. Bagian **📜 Aktivitas data terakhir** menampilkan audit ekspor/impor/verifikasi/ganti sandi backup dan pembersihan data (tanpa isi percakapan), bisa disaring dan diunduh CSV.

**Format:** ZIP standar (bisa dibuka Explorer / `Expand-Archive`), ditulis tanpa dependency oleh `src/zip.js` (deflate streaming, CRC-32, ZIP64 otomatis). Upload import maks 4 GB (`OFFICE_BACKUP_MAX_BYTES`).

Batasan: lokasi Claude mengikuti `~/.claude` (atau `CLAUDE_PROJECTS_DIR`). Pindah antar-OS belum diuji. Nama folder transcript yang dipotong Claude Code (path > 200 karakter) tidak di-remap.

## Retensi data

**⏳ Retensi otomatis** (⚙ → **💾 Cadangkan riwayat** → **🕵️ Data saya**, hanya dari laptop) membersihkan dua hal yang tumbuh terus: riwayat chat panel dan ledger pemakaian. Default keduanya **0 = simpan selamanya**, jadi tidak ada yang terhapus sampai kamu mengaturnya.

| Pengaturan | Default | Pilihan |
|---|---|---|
| Batas pesan chat | `0` (simpan selamanya) | 0/30/90/180/365 hari di UI; server menerima 0–3650 |
| Batas laporan pemakaian | `0` (simpan selamanya) | sama |

Nilainya tersimpan sebagai `retention` `{ chatsDays, usageDays }` di `state.json`.

**Yang dihapus:** pesan panel chat aplikasi (`data/chats`, `data/chats-opencode`) dan baris ledger pemakaian (`data/usage.jsonl` serta `data/usage-archive/*.jsonl`) yang lebih lama dari batas. Pesan/baris tanpa timestamp valid dan baris rusak selalu dipertahankan.

**Yang tidak disentuh:** transkrip sesi Claude/OpenCode, riwayat sesi, backup, dan file project. Retensi ini juga terpisah dari retensi trash sesi (30 hari) dan **Hapus data project**.

**Pembersihan manual lain:** tombol di 🕵️ Data saya menghapus data yang tidak punya batas retensi otomatis—bundel redo (`data/redo/`), backup config OpenCode (`data/opencode-config-backups/`), riwayat kesehatan (`data/metrics.json`), dan isi `data/server.log`. Semuanya bisa dibuat lagi oleh aplikasi (riwayat kesehatan dan log mulai kosong lagi), dan setiap aksi tercatat sebagai audit `data-purge`. Lampiran antrian ikut terhapus saat item antriannya dibatalkan/selesai atau saat data project dihapus.

**Di panel:** pilih batas **Chat** dan **Laporan pemakaian**, lalu:

- **Pratinjau** menghitung berapa yang akan terhapus tanpa menyentuh file.
- **Simpan** hanya menyimpan pilihan; pembersihan ikut jadwal otomatis.
- **Bersihkan sekarang** menyimpan pilihan yang ada di layar lalu langsung menjalankan. Ada konfirmasi berisi hasil pratinjau terakhir, dan tindakan ini tidak bisa dibatalkan.

Retensi berjalan otomatis saat server start dan tiap **24 jam**. Sebelum file ledger ditulis ulang, dibuat backup harian `.bak-retention-YYYYMMDD` (satu per file per hari; salinan ini sendiri dibersihkan setelah 30 hari). Setiap run dicatat di audit **`retention-run`** pada 📜 Aktivitas data, bisa disaring per jenis dan diunduh CSV.
