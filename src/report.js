// Usage report: print-ready HTML, turned into a PDF by a locally installed Edge/Chrome (headless).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => Math.round(n ?? 0).toLocaleString('id-ID');
const short = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} M` : n >= 1e6 ? `${(n / 1e6).toFixed(2)} jt` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} rb` : num(n));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const usd = (x) => (x == null ? '—' : `$${x.toFixed(2)}`);
const dateFmt = (ts, opts = { dateStyle: 'medium' }) => new Date(ts).toLocaleString('id-ID', opts);

function table(title, rows, label) {
  if (!rows.length) return '';
  return `<h2>${esc(title)}</h2>
  <table>
    <thead><tr><th>${esc(label)}</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th><th>Cache hit</th></tr></thead>
    <tbody>${rows
      .map((r) => `<tr><td>${esc(r.key)}</td><td>${num(r.input)}</td><td>${num(r.output)}</td><td>${num(r.cacheRead)}</td><td>${num(r.cacheWrite)}</td><td><b>${num(r.total)}</b></td><td>${pct(r.cacheHitRate)}</td></tr>`)
      .join('')}</tbody>
  </table>`;
}

const UNIT_TITLE = { day: 'hari', week: 'minggu', month: 'bulan' };
// Engine and source labels for the per-engine section (the data keys stay claude/opencode, web/cli).
const ENGINE_LABEL = { claude: 'Claude', opencode: 'OpenCode', unknown: 'Tidak diketahui' };
const SOURCE_LABEL = { web: 'Web', cli: 'Terminal', unknown: 'Tidak diketahui' };
const GO_PLAN_LABEL = { go: 'Go', plus: 'Go Plus', teams: 'Go Teams' };
const costCell = (r) => `${usd(r.costUsd)}${r.costUsd != null && r.costCoverage < 1 ? ` (${Math.floor(r.costCoverage * 100)}%)` : ''}`;

/**
 * "OpenCode Go — data provider": the exact console meters and activity for the report period. The provider data is
 * account-wide (no project/role dimension), so it is a separate section and never added to the ledger tables.
 */
function providerSection(go) {
  if (!go) return '';
  const plan = GO_PLAN_LABEL[go.plan] ?? go.product ?? 'OpenCode Go';
  const active = go.activeUntil && !Number.isNaN(Date.parse(go.activeUntil)) ? dateFmt(Date.parse(go.activeUntil), { dateStyle: 'medium' }) : '';
  const meters = (Array.isArray(go.meters) ? go.meters : [])
    .map((m) => {
      const percent = m.percent == null ? null : Math.min(100, Math.round(m.percent * 1000) / 10);
      return `<tr><td>${esc(m.label)}</td><td>${esc(`${usd(m.usedUsd)} / ${usd(m.limitUsd)}`)}</td><td>${percent == null ? '—' : `${percent}%`}</td><td>${esc(m.resetsAt ? dateFmt(Date.parse(m.resetsAt), { dateStyle: 'medium', timeStyle: 'short' }) : '—')}</td></tr>`;
    })
    .join('');
  const totals = go.totals ?? { costUsd: 0, tokens: 0, requests: 0 };
  const daily = Array.isArray(go.daily) ? go.daily : [];
  const dailyRows = daily
    .map((d) => `<tr><td>${esc(d.date)}</td><td>${esc(usd(d.costUsd))}</td><td>${num(d.tokens)}</td><td>${num(d.requests)}</td></tr>`)
    .join('');
  const range = daily.length ? `${dateFmt(Date.parse(daily[0].date))} — ${dateFmt(Date.parse(daily.at(-1).date))}` : 'tidak ada aktivitas pada periode ini';
  const models = (Array.isArray(go.models) ? go.models : []).slice(0, 20);
  const modelRows = models.map((m) => `<tr><td>${esc(m.model)}</td><td>${num(m.requests)}</td></tr>`).join('');
  return `<h2>OpenCode Go — data provider</h2>
  <p><b>${esc(plan)}</b>${active ? ` · aktif sampai ${esc(active)}` : ''} · <span class="muted">sumber: OpenCode Console</span></p>
  ${meters ? `<table><thead><tr><th>Jendela</th><th>Terpakai / batas</th><th>%</th><th>Reset</th></tr></thead><tbody>${meters}</tbody></table>` : ''}
  <p>Periode ${esc(range)}: <b>${esc(usd(totals.costUsd))}</b> · ${num(totals.tokens)} token · ${num(totals.requests)} request</p>
  ${dailyRows ? `<table class="sub"><thead><tr><th>Tanggal</th><th>Biaya</th><th>Token</th><th>Request</th></tr></thead><tbody>${dailyRows}</tbody></table>` : ''}
  ${modelRows ? `<h2>OpenCode Go — model (request)</h2><table><thead><tr><th>Model</th><th>Request</th></tr></thead><tbody>${modelRows}</tbody></table>` : ''}
  <p class="muted">Data provider mencakup seluruh pemakaian akun OpenCode, termasuk perangkat lain; data ini tidak punya dimensi project/role dan tidak dijumlahkan ke tabel ledger.</p>`;
}

/** Table with a cost column; requests/turns are not broken down per engine. */
function costTable(rows, label) {
  if (!rows.length) return '';
  return `<table class="sub">
    <thead><tr><th>${esc(label)}</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th><th>Cache hit</th><th>Biaya</th></tr></thead>
    <tbody>${rows
      .map((r) => `<tr><td>${esc(r.key)}</td><td>${num(r.input)}</td><td>${num(r.output)}</td><td>${num(r.cacheRead)}</td><td>${num(r.cacheWrite)}</td><td><b>${num(r.total)}</b></td><td>${pct(r.cacheHitRate)}</td><td>${esc(costCell(r))}</td></tr>`)
      .join('')}</tbody>
  </table>`;
}

/** "Per mesin": which engine spent the tokens, then engine × source (web or terminal). */
function engineSection(summary) {
  const engines = (summary.byEngine ?? []).filter((r) => r.total > 0).map((r) => ({ ...r, key: ENGINE_LABEL[r.key] ?? r.key }));
  const combos = (summary.byEngineSource ?? [])
    .filter((r) => r.total > 0) // empty buckets stay out of the report
    .map((r) => ({ ...r, key: `${ENGINE_LABEL[r.engine] ?? r.engine} · ${SOURCE_LABEL[r.source] ?? r.source}` }));
  if (!engines.length && !combos.length) return '';
  return `<h2>Per mesin</h2>
  ${costTable(engines, 'Mesin')}
  ${costTable(combos, 'Mesin · sumber')}`;
}

// Usage-based seats (Enterprise): the organisation's limit status from the rate-limit events (src/account.js billingStatus).
const BILLING_TEXT = {
  allowed: 'Masih dalam batas organisasi',
  allowed_warning: 'Mendekati batas yang diatur admin',
  rejected: 'Batas organisasi tercapai',
};

/** "31 Okt 2026", "26 Okt – 1 Nov 2026" or "Oktober 2026". */
export function periodLabel({ start, end }, unit) {
  if (unit === 'month') return dateFmt(start, { month: 'long', year: 'numeric' });
  if (unit === 'week' && new Date(start).toDateString() !== new Date(end).toDateString()) {
    return `${dateFmt(start, { day: 'numeric', month: 'short' })} – ${dateFmt(end, { dateStyle: 'medium' })}`;
  }
  return dateFmt(start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Bar label under the chart: "31/10" for a day or week start, "Okt" for a month. */
function shortLabel({ start }, unit) {
  const d = new Date(start);
  return unit === 'month' ? dateFmt(start, { month: 'short' }) : `${d.getDate()}/${d.getMonth() + 1}`;
}

/** Stacked bars, one per day/week/month of the range (empty ones included, so gaps show). */
function periodChart(summary) {
  const unit = summary.groupBy ?? 'day';
  const periods = summary.byPeriod ?? [];
  if (!periods.length) return '';
  const max = periods.reduce((m, p) => Math.max(m, p.total), 1);
  const every = Math.ceil(periods.length / 16); // keep the labels readable on A4
  const bars = periods
    .map((p, i) => {
      const h = (v) => `${((v / max) * 100).toFixed(2)}%`;
      const label = i % every === 0 || i === periods.length - 1 ? shortLabel(p, unit) : '';
      return `<div class="bar" title="${esc(periodLabel(p, unit))}: ${num(p.total)}">
        <div class="stack"><span class="s-out" style="height:${h(p.output)}"></span><span class="s-read" style="height:${h(p.cacheRead)}"></span><span class="s-in" style="height:${h(p.input + p.cacheWrite)}"></span></div>
        <small>${esc(label)}</small>
      </div>`;
    })
    .join('');
  return `<h2>Pemakaian per ${UNIT_TITLE[unit]}</h2>
  <div class="chart">${bars}</div>
  <div class="legend"><span class="s-in"></span>Input + cache write <span class="s-read"></span>Cache read <span class="s-out"></span>Output · puncak ${short(max)} token/${UNIT_TITLE[unit]}</div>`;
}

/** Only the periods with usage (oldest first); how many were empty is said in the title. */
function periodTable(summary) {
  const unit = summary.groupBy ?? 'day';
  const periods = summary.byPeriod ?? [];
  const used = periods.filter((p) => p.total).map((p) => ({ ...p, key: periodLabel(p, unit) }));
  const name = UNIT_TITLE[unit];
  return table(`Rincian per ${name} · ${used.length} dari ${periods.length} ${name} ada pemakaian`, used, name[0].toUpperCase() + name.slice(1));
}

/**
 * 🧩 Per role (estimate): the ledger total split by the transcript's main/subagent token proportion. The table always
 * adds up to the report's own total; the note makes clear it is not a second measurement.
 */
function roleSection(summary) {
  const roles = (summary.byRole?.roles ?? []).filter((r) => r.tokens > 0);
  if (!roles.length) return '';
  const rows = roles
    .map(
      (r) =>
        `<tr><td>${esc(r.label ?? r.role)}</td><td><b>${num(r.tokens)}</b></td><td>${pct(r.share ?? 0)}</td><td>${esc(costCell(r))}</td><td>${num(r.delegations ?? 0)}</td></tr>`,
    )
    .join('');
  const cov = summary.byRole?.coverage;
  const coverage = cov
    ? `<p class="muted">Cakupan: ${pct(cov.percent ?? 0)} token (${num(cov.sessionsWithTranscript ?? 0)} dari ${num(cov.sessions ?? 0)} sesi) punya rincian role. "OpenCode (tanpa rincian role)" dan "Tanpa rincian role" mencakup sesi yang tidak ditemukan di store OpenCode atau transcript Claude.</p>`
    : '';
  return `<h2>Per role <span class="muted">(perkiraan)</span></h2>
  ${coverage}
  <table class="sub">
    <thead><tr><th>Role</th><th>Total</th><th>%</th><th>Biaya</th><th>Delegasi</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="muted">${esc(summary.byRole.note ?? '')}</p>`;
}

/** @param {{ account, profile, limits, summary, generatedAt }} data */
export function reportHtml({ account, profile, limits, billing = null, summary, opencodeGo = null }) {
  const t = summary.totals;
  // Three scopes: one Claude account, one OpenCode account, or every account (the combined report).
  const scope = account.email === 'Semua akun' ? 'all' : account.id === 'opencode' || account.email === 'OpenCode' ? 'opencode' : 'claude';
  const isOpenCode = scope === 'opencode';
  const isAll = scope === 'all';
  const kpis = [
    ['Total token', short(t.total), `${num(t.total)} token`],
    ['Input', short(t.input), 'token baru yang dikirim'],
    ['Output', short(t.output), 'token yang dihasilkan'],
    ['Cache read', short(t.cacheRead), 'konteks dibaca dari cache'],
    ['Cache write', short(t.cacheWrite), 'konteks disimpan ke cache'],
    ['Cache hit rate', pct(t.cacheHitRate), 'cache read ÷ total konteks'],
    ['Permintaan / giliran', `${num(t.requests)} / ${num(t.turns)}`, 'API request (CLI) / giliran (web)'],
    ['Estimasi biaya', usd(t.costUsd), t.costCoverage < 1 ? `list price · ${pct(t.costCoverage)} catatan punya biaya` : 'list price'],
  ];
  const limitRows = (limits?.windows ?? []).map((w) => `<tr><td>${esc(w.label)}</td><td><div class="meter"><span style="width:${Math.min(100, w.percent)}%"></span></div></td><td>${w.percent}%</td><td>${esc(w.resets ?? '—')}</td></tr>`).join('');
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>Laporan Penggunaan Token — ${esc(account.email)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 10.5px/1.45 "Segoe UI", Arial, sans-serif; color: #1d1f24; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #d97757; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  h1 span { color: #d97757; }
  h2 { font-size: 12.5px; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #e3e5ea; }
  .muted { color: #6b7280; }
  .who { text-align: right; }
  .who b { font-size: 12px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #fdeee8; color: #b85f42; font-weight: 700; font-size: 9.5px; text-transform: uppercase; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .kpi { border: 1px solid #e3e5ea; border-radius: 8px; padding: 8px 10px; break-inside: avoid; }
  .kpi small { display: block; color: #6b7280; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
  .kpi b { display: block; font-size: 17px; margin: 2px 0; }
  .kpi span { color: #6b7280; font-size: 9px; }
  table { width: 100%; border-collapse: collapse; break-inside: auto; }
  table.sub { margin-top: 6px; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #eef0f3; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { background: #f6f7f9; font-size: 9.5px; text-transform: uppercase; color: #4b5563; }
  tr { break-inside: avoid; }
  .chart { display: flex; align-items: flex-end; justify-content: center; gap: 2px; height: 130px; border-bottom: 1px solid #d0d4da; padding-top: 4px; }
  .bar { flex: 1; max-width: 48px; display: flex; flex-direction: column; align-items: center; height: 100%; min-width: 0; }
  .stack { flex: 1; width: 100%; display: flex; flex-direction: column-reverse; justify-content: flex-start; }
  .stack span { display: block; width: 100%; }
  .bar small { font-size: 7.5px; color: #6b7280; }
  .s-in { background: #3d85c6; }
  .s-read { background: #9cc3e8; }
  .s-out { background: #d97757; }
  .legend { margin-top: 4px; color: #4b5563; font-size: 9px; }
  .legend span { display: inline-block; width: 9px; height: 9px; margin: 0 3px 0 10px; vertical-align: -1px; border-radius: 2px; }
  .meter { height: 8px; background: #eef0f3; border-radius: 99px; overflow: hidden; }
  .meter span { display: block; height: 100%; background: #d97757; }
  .notes { margin-top: 16px; padding: 8px 10px; background: #f6f7f9; border-radius: 8px; color: #4b5563; font-size: 9px; }
  .notes li { margin: 2px 0; }
  .empty { padding: 30px; text-align: center; color: #6b7280; border: 1px dashed #d0d4da; border-radius: 8px; }
</style></head>
<body>
  <header>
    <div>
      <h1>Laporan Penggunaan Token</h1>
      <div class="muted">Periode ${esc(dateFmt(summary.from))} — ${esc(dateFmt(summary.to))} · dibuat ${esc(dateFmt(Date.now(), { dateStyle: 'medium', timeStyle: 'short' }))}</div>
    </div>
    <div class="who">
      <b>${esc(profile?.fullName || profile?.displayName || account.email)}</b><br>
      ${profile?.fullName || profile?.displayName ? `${esc(account.email)}<br>` : ''}
      <span class="muted">${esc(account.org ?? '')}</span> ${profile?.subscriptionType ? `<span class="badge">${esc(profile.subscriptionType)}</span>` : ''}
    </div>
  </header>

  ${summary.records ? `
  <div class="kpis">${kpis.map(([label, value, hint]) => `<div class="kpi"><small>${esc(label)}</small><b>${esc(value)}</b><span>${esc(hint)}</span></div>`).join('')}</div>
  ${periodChart(summary)}
  ${periodTable(summary)}
  ${table('Per model', summary.byModel, 'Model')}
  ${table('Per project', summary.byProject, 'Project')}
  ${table('Per sumber', summary.bySource, 'Sumber')}
  ${engineSection(summary)}
  ${roleSection(summary)}
  ${providerSection(opencodeGo)}
  ${table('10 sesi teratas', summary.topSessions.map((s) => ({ ...s, key: `${s.key.split('|')[0]} · ${s.key.split('|')[1].slice(0, 8)}` })), 'Project · sesi')}
  ` : `<div class="empty">Belum ada pemakaian tercatat ${isAll ? '' : 'untuk akun ini '}pada periode tersebut.</div>`}

  ${limitRows ? `<h2>Kuota langganan saat laporan dibuat</h2><table><thead><tr><th>Jendela</th><th style="width:45%">Terpakai</th><th>%</th><th>Reset</th></tr></thead><tbody>${limitRows}</tbody></table>` : ''}
  ${!limitRows && billing ? `<h2>Batas pemakaian organisasi saat laporan dibuat</h2><p><b>${esc(BILLING_TEXT[billing.status] ?? 'Status belum diketahui')}</b>${billing.resetsAt ? ` · periode tagihan reset ${esc(dateFmt(billing.resetsAt * 1000, { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}</p><p class="muted">Paket berbasis pemakaian (usage-based): tidak ada kuota sesi/mingguan dalam persen. Pemakaian ditagih ke organisasi dengan batas yang diatur admin.</p>` : ''}
  ${!limitRows && !billing && limits?.note ? `<h2>Kuota langganan saat laporan dibuat</h2><p style="white-space:pre-line">${esc(limits.note)}</p><p class="muted">Akun ini tidak melaporkan kuota dalam persen. Teks di atas adalah pesan asli dari <code>/usage</code>.</p>` : ''}

  <div class="notes"><b>Catatan</b><ul>
    <li>${isAll ? 'Hanya pemakaian <b>semua akun</b> yang tercatat. Setiap catatan menyimpan akun yang sedang login saat token dipakai, dan laporan ini menjumlahkan semuanya.' : `Hanya pemakaian akun <b>${esc(account.email)}</b>. Setiap catatan menyimpan akun yang sedang login saat token dipakai, jadi akun lain tidak ikut terhitung.`}</li>
    <li>Sumber: sesi dari web Adhit Office (per giliran, termasuk subagent) dan ${isAll ? 'sesi Claude Code maupun OpenCode di terminal yang terbaca oleh mirror (per request/pesan)' : isOpenCode ? 'sesi OpenCode di terminal yang terbaca oleh mirror (per pesan)' : 'sesi Claude Code di terminal yang terbaca oleh mirror (per API request)'}, sejak pencatatan aktif.</li>
    <li><b>Cache read</b> = konteks yang dipakai ulang dari cache (jauh lebih murah); <b>cache write</b> = konteks yang baru disimpan ke cache. Cache hit rate tinggi berarti sesi efisien.</li>
    ${summary.byRole?.roles?.length ? `<li><b>Per role</b> adalah perkiraan: total token/biaya laporan dibagi menurut proporsi token di transcript (main thread vs subagent). Cache read dan sesi tanpa transcript bisa membuat angkanya tidak presisi, tetapi jumlah tabel tetap sama dengan total laporan.</li>` : ''}
    ${isAll ? '<li>Biaya tabel lokal adalah estimasi: harga list Claude Code dan data biaya OpenCode bila provider menyediakannya. Bagian <b>OpenCode Go — data provider</b> memakai angka resmi console dan tidak dijumlahkan ke tabel lokal.</li>' : isOpenCode ? '<li>Biaya tabel lokal berasal dari ledger. Bagian <b>OpenCode Go — data provider</b> (bila tersedia) memakai angka resmi console; keduanya tidak dijumlahkan.</li>' : '<li>Biaya adalah estimasi harga list dari Claude Code (hanya tersedia untuk sesi web). Untuk langganan Pro/Max/Team, yang membatasi adalah kuota, bukan biaya.</li>'}
  </ul></div>
</body></html>`;
}

/** Edge or Chrome, whichever is installed (override with OFFICE_BROWSER). */
export function findBrowser() {
  const candidates = [
    process.env.OFFICE_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** @returns {Promise<Buffer>} */
export function renderPdf(html) {
  const browser = findBrowser();
  if (!browser) return Promise.reject(new Error('Tidak ada Edge/Chrome untuk membuat PDF.'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-report-'));
  const htmlFile = path.join(dir, 'report.html');
  const pdfFile = path.join(dir, 'report.pdf');
  writeFileSync(htmlFile, html, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(dir, 'profile')}`, // never touches your real browser profile
      '--no-pdf-header-footer', '--print-to-pdf-no-header',
      `--print-to-pdf=${pdfFile}`, pathToFileURL(htmlFile).href,
    ], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const pdf = readFileSync(pdfFile);
        resolve(pdf);
      } catch {
        reject(new Error('Browser gagal membuat PDF.'));
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  });
}
