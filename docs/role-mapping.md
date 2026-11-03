# Peta tugas → peran

Bagaimana kantor menentukan siapa yang mengerjakan sebuah langkah. Sumbernya `src/roles.js`, dan setiap baris di bawah dikunci oleh test di `test/role-map.test.mjs`.

## Dua jenis atribusi

| Situasi | Cara menentukan | Ketepatan |
|---|---|---|
| Lead mendelegasikan ke subagent (`Agent` / `subagent`) | Nama tipe agen; langkah milik subagent ditandai lewat `parent_tool_use_id` | Pasti (dari stream) |
| Lead bekerja sendiri (Read, Edit, Bash, MCP, Skill) | Aturan berurutan di bawah ini | Deterministik, mengikuti aturan |

Kalau peran tujuan dimatikan di 👥 Kelola tim, pekerjaannya berpindah sesuai rantai cadangan di `src/role-catalog.js`. Contohnya Compliance → Security, Support → QA, dan Reviewer → Tech Lead.

## File (Read / Edit / Write, juga `cat`, `sed -n`, `> file` di shell)

Aturan dicek dari atas; yang pertama cocok yang dipakai.

| File | Peran |
|---|---|
| Test, fixture, mock, config test runner (`jest.config`, `pytest.ini`, `conftest.py`) | QA |
| `LICENSE`, `NOTICE`, third-party notices, kebijakan privasi / DPIA | Compliance |
| `SECURITY.md`, kunci & sertifikat (`.pem`, `.key`, `.crt`), config scanner, `dependabot.yml`, threat model | Security |
| `CLAUDE.md`, `AGENTS.md`, `.claude/agents\|commands\|skills` | Tech Lead |
| `.claude/settings*.json`, `.vscode/`, `.mcp.json`, `opencode.json` | DevOps |
| Kontrak API (`openapi`, `swagger`, `asyncapi`, `.proto`) | Tech Lead |
| Config lint / format (`.eslintrc`, `.prettierrc`, `biome.json`, `ruff.toml`) | QA |
| Log build / CI / deploy | DevOps |
| Log aplikasi lainnya, saat dibaca | Support (QA bila Support mati) |
| Dokumen: ADR, arsitektur, RFC, tech spec | Tech Lead |
| Dokumen: PRD, roadmap, backlog, scope, acceptance criteria | PM |
| Dokumen: requirements, user stories, use case, aturan bisnis, glosarium | BA |
| Dokumen: test plan, test case, UAT | QA |
| Dokumen: runbook, playbook, deploy, incident, postmortem | DevOps |
| Dokumen: design system, style guide, wireframe | UI/UX |
| Dokumen lain (README, panduan) | Writer saat ditulis, BA saat dibaca |
| Mobile (`*.dart`, `android/`, `ios/`) / data (`*.ipynb`, `dbt/`) | Mobile / Data (bila peran aktif) |
| SQL, migrasi, seeder, schema, `.sqlite` | DBA |
| Terjemahan (`locales/`, `i18n/`) | Frontend |
| Dependensi & build (`package.json`, lockfile, `tsconfig`, bundler config, `Makefile`, `.gitignore`, skrip `.sh`/`.ps1`/`.cmd`) | DevOps |
| Docker, CI, Terraform, k8s, hosting config, `.env`, YAML lain | DevOps |
| Gambar, font, ikon, file desain, CSS, SVG | UI/UX |
| Komponen, halaman, template (`.tsx`, `.vue`, `.ejs`, `.mjml`), `client/` | Frontend |
| Sisanya (kode server) | Backend |

## Perintah shell (Bash / PowerShell)

Pembungkus seperti `timeout N`, `cmd /c`, `powershell -Command "…"`, dan `bash -c "…"` dibuka dulu. Redirect `> run.log` tidak menutupi perintah aslinya.

Satu baris perintah bisa berisi beberapa langkah. Urutan prioritasnya:

1. **Niat**: test, build, deploy, migrasi, dan sejenisnya. Yang menentukan adalah perintah pertama yang memperlihatkan niat.
2. **Menulis file**: perannya mengikuti file tujuan.
3. **Membaca file**: perannya mengikuti file, sama seperti Read.
4. **Deskripsi perintah** dari model.
5. **Pengembangan biasa**, seperti `git commit`.
6. **Mencari**: Tech Lead, atau QA bila yang dicari adalah test.
7. **Menunggu**: Lead.

Tabel ini berlaku untuk tim klasik.

| Perintah | Peran |
|---|---|
| `npm/yarn audit`, `pip-audit`, `gitleaks`, `trivy`, `semgrep`, `openssl`, `ssh-keygen`, `gpg`, `npm run audit` | Security |
| Test (`npm test`, `node --test`, `pytest`, `go test`, `vitest`), coverage, `k6`, `lighthouse` | QA |
| Lint & typecheck (`eslint`, `tsc`, `mypy`, `phpstan`), `node --check`, `curl` ke app, skrip `smoke`/`verify` | QA |
| Membaca log hasil test (`grep "pass\|fail" run.log`) | QA |
| `psql`, `pg_dump`, `prisma`, `drizzle-kit`, `artisan migrate`, `manage.py makemigrations`, skrip `seed`/`migrate` | DBA |
| `svgo`, `pa11y`, skrip `icon`/`sprite`/`favicon` | UI/UX |
| `typedoc`, `jsdoc`, `mkdocs`, `sphinx-build`, `docusaurus` | Writer |
| Docker / k8s / Terraform / cloud CLI, `git push/pull/fetch/tag`, `gh release/run/workflow`, `gh pr create/merge` | DevOps |
| `npm publish`, build (`npm run build`, `make`), install dependency | DevOps |
| `claude doctor/update/mcp/plugin`, `opencode models/auth`, skrip `restart`/`setup`/`update`/`deploy` | DevOps |
| Proses, jaringan, firewall, scheduler | DevOps |
| Dev server frontend (`vite`, `next dev`, `ng serve`, `storybook`) | Frontend |
| `git diff/log/blame/show/status`, `gh pr view/list/review/diff/checks` | Tech Lead |
| `gh issue`, `gh project` | PM |
| Formatter (`prettier --write`, `black`, `gofmt -w`) | Pemilik file yang diformat |
| `git add/commit/checkout`, `node server.js`, skrip tanpa nama yang jelas | Backend |
| `sleep`, `Start-Sleep`, dan loop yang menunggu proses selesai | Lead |

Peran opsional mengambil pekerjaannya sendiri ketika aktif:

| Peran | Pekerjaan |
|---|---|
| Mobile | `flutter`, `gradlew`, `xcodebuild` |
| Data | `dbt`, `jupyter`, skrip `train`/`etl` |
| Support | `kubectl logs`, `journalctl` |
| Reviewer | `gh pr review/diff/checks` |

## Tool MCP

| Server | Peran |
|---|---|
| Browser (`playwright`, `puppeteer`, `chrome`) | QA |
| Database (`postgres`, `supabase`, `mongo`, `bigquery`) | DBA |
| Desain (`figma`, `canva`, `excalidraw`) | UI/UX |
| Dokumen (`notion`, `confluence`, `drive`, `docs`, `sheets`) | Writer |
| Pesan & rapat (`slack`, `gmail`, `outlook`, `calendar`, `teams`) | PM |
| Keamanan (`snyk`, `sonar`, `semgrep`) | Security |
| Monitoring & cloud (`sentry`, `datadog`, `vercel`, `cloudflare`, `aws`) | DevOps |
| GitHub/GitLab: buat/merge PR, release, workflow | DevOps |
| GitHub/GitLab: issue, milestone | PM |
| GitHub/GitLab: review | Reviewer, atau Tech Lead bila Reviewer mati |
| GitHub/GitLab: baca kode/commit | Tech Lead |
| Pelacak kerja (`jira`, `linear`, `asana`) | PM |
| Layanan pihak ketiga (`stripe`, `twilio`, `sendgrid`) | Backend |
| Riset (`context7`, `search`, `arxiv`, `pubmed`) | BA |
| Lainnya | Lead |

## Skill

| Nama skill memuat | Peran |
|---|---|
| `security` | Security |
| `review`, `simplify` | Reviewer, atau Tech Lead bila Reviewer mati |
| `test`, `qa`, `verify`, `run` | QA |
| `design`, `figma`, `ui`, `theme` | UI/UX |
| `init`, `claude-md` | Tech Lead |
| `doc`, `docx`, `pptx`, `xlsx`, `pdf`, `readme`, `changelog` | Writer |
| `data`, `chart`, `sql`, `analy` | Data, atau Backend bila Data mati |
| `deploy`, `release`, `schedule`, `loop`, `config`, `setup` | DevOps |
| `plan`, `scope`, `prd`, `brainstorm` | PM |
| `research`, `search`, `explore` | BA |
| `api`, `backend` | Backend |
| Lainnya | Lead |

## Tool lain

| Tool | Peran |
|---|---|
| `TodoWrite`, `Task*`, `EnterPlanMode`, `ExitPlanMode` | PM |
| `Grep`, `Glob` | Tech Lead |
| `WebFetch`, `WebSearch` | BA |
| `Artifact` | UI/UX |
| `AskUserQuestion`, `ToolSearch`, dan tool koordinasi lain | Lead |

## Tipe subagent

Sebagian nama punya alias tetap:

| Nama | Peran |
|---|---|
| `Plan` | Tech Lead |
| `general-purpose`, `general` (OpenCode), `fork` | Freelancer |

Nama lain dicocokkan berurutan dengan pola berikut:

| Pola | Peran |
|---|---|
| privacy, gdpr | Compliance |
| accessibility, a11y | UI/UX |
| security, devsecops, audit | Security |
| devops, sre, cloud, docker, k8s, terraform | DevOps |
| data, ml | Data |
| dba, sql, postgres, mongo, redis | DBA |
| writer, docs, copywriter, translator | Writer |
| qa, test, debug, debugger, performance | QA |
| review | Reviewer, atau Tech Lead bila Reviewer mati |
| architect, api-designer, system-design | Tech Lead |
| ui, ux, design | UI/UX |
| flutter, android | Mobile |
| frontend, react, next, tailwind | Frontend |
| analyst, explore, research, requirements | BA |
| backend, api, developer, integration, payment | Backend |
| pm, planner, product | PM |
| Tidak cocok dengan pola mana pun | Freelancer |

## Nama yang belum dikenali: 🧭 Pemetaan peran

Untuk nama yang tidak cocok dengan aturan mana pun (MCP server, skill, tipe subagent, file skrip, atau program baru), buka **👥 Kelola tim → 🧭 Pemetaan peran**. Nama yang ditentukan di sana berlaku lebih dulu daripada aturan bawaan. Urutannya:

| Urutan | Sumber | Lokasi | Ikut di-push? |
|---|---|---|---|
| 1 | Pemetaan project | `<project>/.office-roles.json` | Ikut git **project itu** kalau kamu commit, sehingga satu tim project berbagi pemetaan |
| 2 | Pemetaan laptop ini (pilihanmu ✋ dan jawaban AI 🤖) | `data/state.json` (`roleMap`), ikut 💾 Backup | Tidak |
| 3 | Aturan bawaan | `src/roles.js` | Ya (repo aplikasi) |

Contoh `.office-roles.json` (kunci `<jenis>:<nama>`, jenisnya `mcp`, `skill`, `agent`, `script`, atau `cmd`):

```json
{
  "agent:growth-hacker": "pm",
  "mcp:hubspot": "pm",
  "script:sync-erp.mjs": "backend"
}
```

Kalau role tujuan sedang nonaktif, pekerjaannya diteruskan ke rantai cadangan seperti biasa.

### 🤖 AI untuk nama baru (opsional, default mati)

Saat dinyalakan, nama yang belum dikenali dikirim dalam satu kelompok kecil ke model termurah mesin aktif. Di Claude Code itu `claude -p --model haiku`, dalam mode baca-saja. Di OpenCode itu `opencode run --agent plan` dengan model bawaanmu.

Cara kerjanya:
- **Yang dikirim** hanya nama dan contoh nama tool, misalnya `mcp:hubspot (contoh: create_deal)`. Kode, path, isi perintah, dan chat tidak pernah ikut.
- **Biaya**: beberapa ratus token per nama, dan setiap nama hanya ditanyakan sekali. Jawabannya disimpan dan dipakai seterusnya.
- **Nama yang belum terjawab** dicoba lagi paling cepat sehari kemudian.
- **Pilihanmu sendiri** tidak pernah ditimpa AI.
