// bridge/src/pages.mjs — semua halaman HTML (register / manage / status) dari string template,
// pola statusPageHtml lama di bridge/worker.js. Tanpa file statis: situsnya murni fungsi.
// Nilai dari user (adhitronUrl, pesan) SELALU lewat escapeHtml — kredensial Tuya tidak pernah masuk HTML.
// Tampilan: brand Adhitron (bg gelap #121317, aksen oranye #d97757, logo inline) — CSS satu blok di bawah,
// tanpa dependensi, responsif (phone 390 / desktop 1440). Nama class .note/.warn/.btn/.danger/.muted
// dipertahankan karena dipakai juga oleh notice dari bridge.mjs.
import { REGION_KEYS, REGION_LABELS } from './tuya.mjs';

/** Semua data center Tuya (7) + label manusiawi; default dipakai kalau region tersimpan tidak dikenal. */
const regionOptions = (selected) =>
  REGION_KEYS.map((r) => `<option value="${r}" ${selected === r ? 'selected' : ''}>${REGION_LABELS[r] ?? r}</option>`).join('');

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
<rect width="64" height="64" rx="14" fill="#17181e"/>
<g fill="none" stroke="#d97757" stroke-width="1.5">
<ellipse cx="32" cy="32" rx="18.7" ry="6.7"/>
<ellipse cx="32" cy="32" rx="18.7" ry="6.7" transform="rotate(60 32 32)"/>
<ellipse cx="32" cy="32" rx="18.7" ry="6.7" transform="rotate(-60 32 32)"/>
</g>
<circle cx="41.4" cy="15.8" r="2.9" fill="#f0a07f" opacity=".14"/>
<circle cx="50.7" cy="32" r="3.2" fill="#f3e6dc" opacity=".14"/>
<circle cx="41.4" cy="48.2" r="2.4" fill="#b85a3c" opacity=".16"/>
<circle cx="41.4" cy="15.8" r="1.9" fill="#f0a07f"/>
<circle cx="50.7" cy="32" r="1.9" fill="#f3e6dc"/>
<circle cx="41.4" cy="48.2" r="1.4" fill="#b85a3c"/>
<rect x="26.8" y="26.8" width="10.4" height="10.4" rx="2.4" fill="#20222b" stroke="#d97757" stroke-width="1"/>
<path d="M29.2 29.3 32 32l-2.8 2.7" fill="none" stroke="#d97757" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="32.4" y="34" width="3.1" height="0.9" rx="0.45" fill="#f3e6dc"/>
</svg>`;

const CSS = `
:root{--bg:#121317;--surface:#191a20;--surface-2:#22242c;--line:#2e3038;--text:#ece9e4;--text-2:#c9c6c1;
--muted:#a09c95;--accent:#d97757;--accent-2:#f0a07f;--accent-solid:#b85a3c;--accent-hover:#a24f34;
--accent-soft:#2a211d;--accent-line:#5a3a2c;--danger:#b3261e;--danger-hover:#962018;
--danger-soft:#2a1614;--danger-line:#6e2a24}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);
margin:0;min-height:100vh;display:flex;flex-direction:column;line-height:1.55;-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;font-weight:600;font-size:.95rem}
.brand svg{width:30px;height:30px;border-radius:8px;display:block;flex:none}
.brand em{font-style:normal;color:var(--accent)}
main.card{width:100%;max-width:600px;margin:0 auto;padding:26px 20px 44px;flex:1}
@media(min-width:720px){main.card{padding:36px 24px 56px}}
h1{margin:0 0 8px;font-size:1.35rem;letter-spacing:-.01em;line-height:1.25}
h2{margin:26px 0 4px;font-size:.95rem}
h2:first-of-type{margin-top:18px}
h2::after{content:"";display:block;width:34px;height:2px;background:var(--accent);border-radius:2px;margin-top:5px}
p{margin:8px 0}
a{color:var(--accent)}
.muted{color:var(--muted);font-size:.88rem}
.lead{color:var(--text-2);margin:0 0 18px}
.state{font-size:1.2rem;font-weight:600;margin:16px 0 8px;font-variant-numeric:tabular-nums}
.btn{display:block;width:100%;margin:10px 0;padding:14px 16px;min-height:52px;border-radius:12px;
border:1px solid transparent;font:inherit;font-size:1rem;font-weight:600;cursor:pointer;
text-align:center;text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{
outline:2px solid var(--accent);outline-offset:2px}
.on{background:var(--accent-solid);color:#fff}
.on:hover{background:var(--accent-hover)}
.off{background:var(--danger);color:#fff}
.off:hover{background:var(--danger-hover)}
.open{background:var(--accent);color:#16171c}
.open:hover{background:var(--accent-2)}
.ghost{background:var(--surface-2);color:var(--text);border-color:var(--line)}
.ghost:hover{background:var(--line)}
label{display:block;margin:12px 0 4px;font-size:.8rem;font-weight:600;letter-spacing:.02em;color:var(--muted)}
input,select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);
background:var(--surface);color:var(--text);font:inherit;font-size:.95rem}
input:focus,select:focus{border-color:var(--accent);outline:none}
input[type=checkbox]{width:auto;margin-right:7px;accent-color:var(--accent);vertical-align:-2px}
ol{list-style:none;counter-reset:step;margin:10px 0;padding:0}
ol li{counter-increment:step;position:relative;padding:7px 0 7px 34px;font-size:.92rem;color:var(--text-2)}
ol li::before{content:counter(step);position:absolute;left:0;top:8px;width:22px;height:22px;border-radius:7px;
background:var(--accent-soft);border:1px solid var(--accent-line);color:var(--accent);
font-size:.72rem;font-weight:700;display:grid;place-items:center}
.note{background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:10px;
padding:10px 12px;font-size:.85rem;margin:14px 0}
.warn{background:var(--danger-soft);border:1px solid var(--danger-line);border-radius:10px;
padding:12px 14px;font-size:.9rem;margin:14px 0}
.danger{border:1px solid var(--danger-line);border-radius:12px;padding:14px;margin-top:22px;background:var(--danger-soft)}
.count{font-size:1.6rem;font-variant-numeric:tabular-nums}
code{background:var(--surface-2);border:1px solid var(--line);padding:2px 6px;border-radius:6px;word-break:break-all;font-size:.85em}
details{margin:14px 0;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
summary{cursor:pointer;padding:10px 12px;font-size:.85rem;color:var(--muted)}
details>div{padding:0 12px 12px;font-size:.78rem;color:var(--text-2)}
.foot{padding:14px 20px;border-top:1px solid var(--line);text-align:center;font-size:.75rem;color:var(--muted)}
[hidden]{display:none!important}
.card-box{background:var(--surface);border:1px solid var(--accent-line);border-radius:12px;padding:14px;margin:14px 0}
/* Kode pasangan 8 karakter base32: besar + monospace supaya mudah dibaca dan diketik ulang di perangkat lain. */
.pair-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:1.9rem;line-height:1.2;
letter-spacing:.22em;font-variant-numeric:tabular-nums;text-align:center;padding:12px 10px;margin:10px 0 6px;
background:var(--surface-2);border:1px solid var(--accent-line);border-radius:12px;color:var(--text);
word-break:break-all}
.pair-code.expired{color:var(--muted);border-color:var(--line);text-decoration:line-through}
`;

export const escapeHtml = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** JSON aman untuk <script>: ganti '<' agar tidak bisa menutup tag lebih awal. */
const jsonForScript = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

const page = (title, body) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#121317">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/">${LOGO}<span>Adhitron <em>Remote&nbsp;Power</em></span></a></header>
<main class="card">${body}</main>
<footer class="foot">Jembatan daya Adhitron · kredensial tersimpan terenkripsi, tidak pernah dibagikan</footer>
</body></html>`;

const tuyaHelp = `<h2>Siapkan kredensial Tuya</h2>
<p class="muted">Cara ambil kredensial (Bardi / Smart Life) — panduan lengkap: <a href="https://iot.tuya.com" rel="noreferrer">iot.tuya.com</a></p>
<ol>
<li>Daftar di <a href="https://iot.tuya.com" rel="noreferrer"><b>iot.tuya.com</b></a> (region sesuai app-mu — Indonesia biasanya <b>eu</b>), buat <b>Cloud Project</b>.</li>
<li>Salin <b>Access ID</b> (→ Client ID) dan <b>Access Secret</b>.</li>
<li>Tautkan akun <b>Smart Life</b> ke project (Devices → Link Smart Life).</li>
<li>Cari <b>Device ID</b> plug-nya di daftar device.</li>
<li>Set BIOS: <b>Restore on AC Power Loss = Power On</b> agar plug ON membuat PC boot.</li>
</ol>`;

/** Catatan pendek (selalu tampil) + pemberitahuan privasi lengkap (compliance) terlipat di <details>. */
const privacy = `<div class="note">🔐 <b>Privasi:</b> kredensial Tuya-mu disimpan <b>terenkripsi</b> (AES-256-GCM) di server ini,
hanya dipakai untuk mengoperasikan plug-mu sendiri, dan dapat dihapus / dirotasi kapan saja lewat halaman manage.</div>`;

const privacyNotice = `<details><summary>🔐 Pemberitahuan privasi lengkap</summary><div>
<b>Isi pemberitahuan:</b>
<ul style="padding-left:18px;margin:8px 0">
<li><b>Data yang disimpan:</b> kredensial Tuya-mu (Client ID, Secret, Device ID, region — terenkripsi),
URL Adhitron opsional, dan status perangkat (heartbeat "PC hidup", sampel daya watt).</li>
<li><b>IP:</b> alamat IP-mu dipakai hanya untuk batas <b>10 pendaftaran per hari</b>, kadaluwarsa harian,
tidak dipakai untuk hal lain.</li>
<li><b>Tujuan:</b> semata operasi plug-mu sendiri (nyalakan/matikan PC). Bukan untuk iklan, analitik,
atau dibagikan ke siapa pun.</li>
<li><b>Pihak ketiga:</b> Tuya Cloud (region pilihanmu) yang menerima perintah plug, dan Netlify (hosting
situs ini — servernya di luar Indonesia).</li>
<li><b>Retensi:</b> selama space-mu aktif. Space tanpa heartbeat lebih dari <b>6 bulan</b> dihapus
otomatis (yang didaftarkan tapi tak pernah dipakai: 30 hari).</li>
<li><b>Hakmu:</b> lihat, ubah, hapus, dan rotasi token kapan saja lewat halaman manage — kuncinya
token-mu sendiri.</li>
<li><b>Insiden kebocoran:</b> operator wajib mengabari kamu dan merotasi token terdampak maksimal
3×24 jam.</li>
<li><b>Setuju:</b> menyelesaikan pendaftaran = kamu setuju pada pemberitahuan ini.</li>
<li><b>Kontak:</b> [kontak] (operator situs).</li>
<li><b>Catatan:</b> log hosting Netlify memuat IP/teknis sesuai kebijakan Netlify; dan <b>jangan
sebarkan URL manage-mu</b> — token ada di URL-nya.</li>
</ul></div></details>`;

/** Bentuk yang diterbitkan server untuk "space" di localStorage (id 8 hex, token 64 hex). */
const SPACE_SHAPE = Object.freeze({
  id: /^[0-9a-f]{8}$/i,
  token: /^[0-9a-f]{64}$/i,
  bridgeUrl: /^https?:\/\/[^\s]+$/,
  manageUrl: /^\/manage\?token=[0-9a-f]{64}$/i,
  statusUrl: /^\/s\/[0-9a-f]{8}$/i,
  tokenInManage: /^\/manage\?token=([0-9a-f]{64})$/i,
});

/** Kode pasangan: 8 karakter base32 tanpa huruf/angka ambigu (tanpa backslash, aman disuntik ke <script>).
 *  Alfabet sama dengan backend: 2-9 + A-Z tanpa I, L, O, U. Dibandingkan uppercase (input user di-toUpperCase). */
const PAIR_DIGITS = '23456789';
const PAIR_LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_CODE_SOURCE = `^[${PAIR_DIGITS}${PAIR_LETTERS}]{8}$`;
/** Atribut HTML pattern (case-insensitive: huruf kecil ikut diterima, backend juga menerimanya). */
const PAIR_PATTERN = `[${PAIR_DIGITS}${PAIR_LETTERS}${PAIR_LETTERS.toLowerCase()}]{8}`;

export function registerPageHtml(notice = '') {
  return page('Adhitron Remote Power — daftar', `
<h1>Remote power untuk PC-mu</h1>
<p class="lead">Nyalakan / matikan PC dari jauh lewat smart plug (Bardi, Smart Life, dsb.) — gratis, multi-user:
daftar, tempel URL + token di panel ⚙ Remote power Adhitron.</p>
${notice}
${tuyaHelp}
${privacy}
${privacyNotice}
<section id="space" class="card-box" hidden>
<h2>Space kamu</h2>
<p class="muted">id: <code id="sp-id"></code></p>
<p><b>Tempel di panel Adhitron ⚙ → Remote power:</b></p>
<p>URL jembatan: <code id="sp-url"></code></p>
<p>Token: <code id="sp-token"></code></p>
<a class="btn open" id="sp-status" href="#">Buka halaman status</a>
<a class="btn ghost" id="sp-manage" href="#">⚙ Kelola / hapus space</a>
<p class="muted">Token = kunci penuh space ini, dan sekarang tersimpan <b>hanya di browser ini</b>. Klik “Lupakan” kalau perangkat ini dipakai bersama.</p>
<button class="btn ghost" id="sp-forget" type="button">Lupakan di perangkat ini</button>
<button class="btn ghost" id="sp-new" type="button">+ Daftar space baru</button>
<p class="muted">“Lupakan” hanya menghapus salinan di browser — space di server tetap ada selama tokennya kamu simpan.</p>
</section>
<div id="regzone">
<h2>Daftar</h2>
<p class="muted">Kredensial dicek langsung ke Tuya Cloud sebelum disimpan.</p>
<form id="reg">
<label>Client ID (Access ID Tuya)<input name="tuyaClientId" required maxlength="200"></label>
<label>Client Secret (Access Secret Tuya)<input name="tuyaClientSecret" type="password" required maxlength="200"></label>
<label>Device ID plug<input name="tuyaDeviceId" required maxlength="200"></label>
<label>Region (data center Tuya)<select name="tuyaRegion">${regionOptions('america')}</select></label>
<p class="muted">Tidak yakin? Biarkan apa adanya — bridge mencoba semua data center dan menyimpan yang benar otomatis.</p>
<label>URL Adhitron (opsional, https://… — link "Buka Adhitron" di halaman status)<input name="adhitronUrl" placeholder="https://nama-mu.ts.net" maxlength="200"></label>
<button class="btn on" type="submit">Daftar &amp; dapat token</button>
</form>
<div id="out"></div>
</div>
<div id="pastezone">
<h2>Sudah punya token?</h2>
<p class="muted">Tempel token dari panel ⚙ Remote power Adhitron untuk membuka space yang sudah ada — ini tidak membuat space baru.</p>
<form id="paste">
<label>Token (64 karakter hex)<input name="token" required minlength="64" maxlength="64" autocomplete="off" spellcheck="false" placeholder="64 karakter hex"></label>
<button class="btn ghost" type="submit">Buka space-ku</button>
</form>
<div id="paste-out"></div>
</div>
<div id="pairzone">
<h2>Punya kode pasangan?</h2>
<p class="muted">Buka space yang sama di perangkat ini tanpa mengetik token: di perangkat lain yang sudah membuka halaman Kelola,
tekan <b>📲 Buat kode pasangan</b>, lalu masukkan kode 8 karakter itu di sini (huruf besar/kecil sama). Kode berlaku 2 menit
dan hanya bisa dipakai sekali.</p>
<form id="pair" novalidate>
<label>Kode 8 karakter (dari halaman Kelola)<input name="code" inputmode="text" autocapitalize="characters" pattern="${PAIR_PATTERN}" minlength="8" maxlength="8" required autocomplete="one-time-code" spellcheck="false" placeholder="K7M2QX9B"></label>
<button class="btn ghost" type="submit">Buka dengan kode</button>
</form>
<div id="pair-out"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
// Ingat space di browser ini (localStorage), supaya refresh tidak mengembalikan ke form kosong.
// Hanya URL yang disimpan; token sudah ada di dalam manageUrl (satu salinan rahasia), dan semuanya
// dirender lewat textContent — tidak ada jalur innerHTML dari data ini.
const SPACE_KEY = 'adhitron-space';
// Bentuk yang benar-benar diterbitkan server. Regex-nya disuntik dari modul (SPACE_SHAPE) lewat new RegExp:
// menulis regex literal di sini akan kehilangan backslash-nya (template string memakan \/ \? \s), dan
// seluruh <script> jadi SyntaxError — perilaku ini dijaga test yang mengompilasi skrip halaman.
const ID_RE = new RegExp(${jsonForScript(SPACE_SHAPE.id.source)}, 'i');
const TOKEN_RE = new RegExp(${jsonForScript(SPACE_SHAPE.token.source)}, 'i');
const BRIDGE_RE = new RegExp(${jsonForScript(SPACE_SHAPE.bridgeUrl.source)}, 'i');
const MANAGE_RE = new RegExp(${jsonForScript(SPACE_SHAPE.manageUrl.source)}, 'i');
const STATUS_RE = new RegExp(${jsonForScript(SPACE_SHAPE.statusUrl.source)}, 'i');
const TOKEN_IN_MANAGE_RE = new RegExp(${jsonForScript(SPACE_SHAPE.tokenInManage.source)}, 'i');
const CODE_RE = new RegExp(${jsonForScript(PAIR_CODE_SOURCE)});
// Entri localStorage bisa rusak/aneh (storage bersama, versi lama): yang tidak cocok diperlakukan sebagai
// "belum ada space" — bukan dirender sebagai [object Object] dan bukan dipasang sebagai href.
const readSpace = () => {
  try {
    const v = JSON.parse(localStorage.getItem(SPACE_KEY) || 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return null;
    if (typeof v.bridgeUrl !== 'string' || !BRIDGE_RE.test(v.bridgeUrl)) return null;
    if (typeof v.manageUrl !== 'string' || !MANAGE_RE.test(v.manageUrl)) return null;
    if (typeof v.statusUrl !== 'string' || !STATUS_RE.test(v.statusUrl)) return null;
    return v;
  } catch { return null; }
};
const saveSpace = (space) => {
  try { localStorage.setItem(SPACE_KEY, JSON.stringify(space)); } catch { /* storage penuh/diblokir: tetap boleh daftar */ }
};
const tokenOf = (space) => {
  const m = TOKEN_IN_MANAGE_RE.exec(space.manageUrl);
  return m ? m[1] : '';
};
/** Hanya field yang memang dipakai kartu, dan hanya bila bentuknya sah (jawaban server tidak dipercaya begitu saja). */
const pickSpace = (d) => {
  if (!d || typeof d !== 'object') return null;
  const id = typeof d.id === 'string' ? d.id : '';
  const bridgeUrl = typeof d.bridgeUrl === 'string' ? d.bridgeUrl : '';
  const statusUrl = typeof d.statusUrl === 'string' ? d.statusUrl : '';
  const manageUrl = typeof d.manageUrl === 'string' ? d.manageUrl : '';
  if (!ID_RE.test(id) || !BRIDGE_RE.test(bridgeUrl) || !STATUS_RE.test(statusUrl) || !MANAGE_RE.test(manageUrl)) return null;
  return { id: id, bridgeUrl: bridgeUrl, statusUrl: statusUrl, manageUrl: manageUrl };
};
const errText = (d, fallback) => (d && typeof d.error === 'string' && d.error ? d.error : fallback);
function renderSpace() {
  const space = readSpace();
  const box = $('space');
  if (!space) {
    box.hidden = true;
    $('regzone').hidden = false;
    $('pastezone').hidden = false;
    $('pairzone').hidden = false;
    return;
  }
  const token = tokenOf(space);
  $('sp-id').textContent = space.id;
  $('sp-url').textContent = space.bridgeUrl;
  $('sp-token').textContent = token;
  $('sp-manage').href = space.manageUrl;
  $('sp-status').href = token && space.statusUrl ? space.statusUrl + '?token=' + encodeURIComponent(token) : space.manageUrl;
  box.hidden = false;
  $('regzone').hidden = true;
  $('pastezone').hidden = true;
  $('pairzone').hidden = true;
}
$('sp-forget').addEventListener('click', () => {
  try { localStorage.removeItem(SPACE_KEY); } catch { /* nothing to forget */ }
  renderSpace();
});
$('sp-new').addEventListener('click', () => {
  $('regzone').hidden = false;
  $('pastezone').hidden = false;
  $('pairzone').hidden = false;
  $('regzone').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
});
$('paste').addEventListener('submit', (e) => {
  e.preventDefault();
  const out = $('paste-out');
  const token = String(new FormData(e.target).get('token') || '').trim();
  if (!TOKEN_RE.test(token)) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = '⚠ Token harus 64 karakter hex (sudah termasuk huruf dan angka).';
    out.replaceChildren(warn);
    return;
  }
  location.href = '/manage?token=' + encodeURIComponent(token);
});
// 📲 Kode pasangan dari halaman Kelola di perangkat lain: sekali pakai, berlaku 2 menit.
$('pair').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('pair-out');
  const warn = (msg) => {
    const box = document.createElement('div');
    box.className = 'warn';
    box.textContent = msg;
    out.replaceChildren(box);
  };
  const code = String(new FormData(e.target).get('code') || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) return warn('⚠ Kode harus 8 karakter: A–Z dan 2–9 (tanpa I, L, O, U).');
  out.innerHTML = '<p class="muted">Membuka…</p>';
  try {
    const r = await fetch('/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return warn('⚠ ' + errText(d, 'kode tidak dikenal atau kedaluwarsa'));
    const space = pickSpace(d);
    if (!space) return warn('⚠ Jawaban server tidak lengkap — coba lagi.');
    saveSpace(space); // kartu "Space kamu" yang tampil, tanpa redirect
    renderSpace();
  } catch (err) {
    warn('⚠ jaringan gagal — coba lagi.');
  }
});
document.getElementById('reg').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, out = $('out');
  out.innerHTML = '<p class="muted">Mendaftarkan…</p>';
  try {
    const r = await fetch('/api/space', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(f))) });
    const d = await r.json();
    // B7: nilai dari server dirender via textContent (bukan innerHTML) — tidak ada jalur injeksi.
    if (!r.ok) {
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = '⚠ ' + (d.error || 'gagal');
      out.replaceChildren(warn);
      return;
    }
    const note = document.createElement('div');
    note.className = 'note';
    const b = document.createElement('b');
    b.textContent = 'Berhasil! Tempel di panel Adhitron ⚙ → Remote power:';
    note.appendChild(b);
    const p1 = document.createElement('p');
    p1.append('URL jembatan: ');
    const urlCode = document.createElement('code');
    urlCode.textContent = d.bridgeUrl;
    p1.appendChild(urlCode);
    const p2 = document.createElement('p');
    p2.append('Token: ');
    const tokCode = document.createElement('code');
    tokCode.textContent = d.token;
    p2.appendChild(tokCode);
    const a = document.createElement('a');
    a.className = 'btn ghost';
    a.href = d.manageUrl;
    a.textContent = '⚙ Kelola / hapus space';
    const p3 = document.createElement('p');
    p3.className = 'muted';
    p3.textContent = 'Simpan token sekarang. Halaman status nanti bisa dibuka tanpa token lewat link serah-terima.';
    note.append(p1, p2, a, p3);
    out.replaceChildren(note);
    // Ingat space ini supaya refresh menampilkan kartu "Space kamu", bukan form kosong lagi.
    saveSpace({ id: d.id, bridgeUrl: d.bridgeUrl, statusUrl: d.statusUrl, manageUrl: d.manageUrl });
    renderSpace();
  } catch (err) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = '⚠ jaringan gagal';
    out.replaceChildren(warn);
  }
});
renderSpace();
</script>`);
}

/** space.ownerToken tidak ada lagi di record (terenkripsi) — form action memakai token dari query request. */
export function managePageHtml(space, queryToken, creds, { notice = '', newToken = null } = {}) {
  const regionOpts = regionOptions(creds.tuyaRegion);
  const formAction = `/api/manage?token=${encodeURIComponent(queryToken)}`;
  return page('Kelola space', `
<h1>Kelola space</h1>
<p class="muted">id: <code>${escapeHtml(space.id)}</code> · dibuat ${new Date(space.createdAt).toISOString().slice(0, 16).replaceAll('T', ' ')} UTC</p>
${notice}
${newToken ? `<div class="note"><b>Token baru (token lama MATI):</b><br><code>${escapeHtml(newToken)}</code><br>Salin sekarang — hanya ditampilkan sekali.</div>` : ''}
<h2>Kredensial &amp; URL</h2>
<p class="muted">Kredensial tidak pernah ditampilkan siap-salin — isi ulang untuk mengubah (Secret kosong = tetap pakai yang lama).</p>
<p class="muted">Perubahan dicek ke Tuya dulu; kalau ditolak, setelan lama dipertahankan.</p>
<form method="post" action="${formAction}">
<input type="hidden" name="action" value="update">
<label>Client ID (Access ID)<input name="tuyaClientId" value="${escapeHtml(creds.tuyaClientId)}" maxlength="200"></label>
<label>Client Secret (kosongkan = tetap pakai yang lama)<input name="tuyaClientSecret" type="password" placeholder="••••••••" maxlength="200"></label>
<label>Device ID plug<input name="tuyaDeviceId" value="${escapeHtml(creds.tuyaDeviceId)}" maxlength="200"></label>
<label>Region (data center Tuya)<select name="tuyaRegion">${regionOpts}</select></label>
<p class="muted">Region dicek &amp; dideteksi otomatis saat disimpan.</p>
<label>URL Adhitron (https://…, kosongkan = tanpa link)<input name="adhitronUrl" value="${escapeHtml(space.adhitronUrl ?? '')}" maxlength="200"></label>
<button class="btn on" type="submit">Simpan perubahan</button>
</form>
<h2>📲 Pasangkan perangkat lain</h2>
<p class="muted">Buka situs ini di perangkat lain (mis. HP), lalu masukkan kode 8 karakter di bagian <b>Punya kode pasangan?</b> —
space langsung terbuka di sana tanpa mengetik token. Kode berlaku 2 menit dan hanya bisa dipakai sekali.</p>
<button class="btn ghost" type="button" id="pair-new">Buat kode pasangan</button>
<div id="pair-code" class="pair-code" hidden></div>
<p id="pair-note" class="muted" aria-live="polite"><span id="pair-msg"></span> <span id="pair-count" aria-hidden="true"></span></p>
<button class="btn ghost" type="button" id="pair-copy" hidden>Salin link manage</button>
<h2>Token</h2>
<p class="muted">Rotasi membuat token lama langsung mati — Adhitron perlu diisi ulang.</p>
<form method="post" action="${formAction}" onsubmit="return confirm('Rotasi token? Token lama langsung mati — Adhitron perlu diisi ulang.')">
<input type="hidden" name="action" value="rotate">
<button class="btn ghost" type="submit">🔁 Rotasi token</button>
</form>
<div class="danger">
<b>🗑 Hapus space</b> — kredensial terenkripsi dihapus permanen, Adhitron berhenti bekerja.
<form method="post" action="${formAction}" onsubmit="return confirm('Hapus space ini secara permanen?')">
<input type="hidden" name="action" value="delete">
<label><input type="checkbox" name="confirm" value="HAPUS"> Saya yakin hapus space ini</label>
<button class="btn off" type="submit">Hapus permanen</button>
</form></div>
<script>
// Kartu "Space kamu" di "/" harus ikut token yang berlaku: setelah rotasi, token lama di localStorage
// akan 401. Sinkronkan hanya untuk space yang id-nya cocok; kalau belum ada yang diingat sama sekali,
// ingat space ini (alur "Sudah punya token?" → /manage) — tapi jangan menimpa space lain.
try {
  const KEY = 'adhitron-space';
  const token = ${jsonForScript(String(queryToken ?? ''))};
  const id = ${jsonForScript(space.id)};
  if (/^[0-9a-f]{64}$/i.test(token)) {
    let stored = null;
    try {
      const raw = localStorage.getItem(KEY);
      stored = raw ? JSON.parse(raw) : null;
    } catch { stored = null; }
    // Entri dianggap "space lain" hanya bila benar-benar punya id yang sah; objek kosong/rusak = belum ada.
    const recalled = stored && typeof stored === 'object' && !Array.isArray(stored) && /^[0-9a-f]{8}$/i.test(stored.id ?? '');
    if (!recalled) {
      localStorage.setItem(KEY, JSON.stringify({
        id: id,
        bridgeUrl: location.origin,
        statusUrl: '/s/' + id,
        manageUrl: '/manage?token=' + encodeURIComponent(token),
      }));
    } else if (stored.id === id) {
      stored.manageUrl = '/manage?token=' + encodeURIComponent(token);
      localStorage.setItem(KEY, JSON.stringify(stored));
    }
  }
} catch {}
// 📲 Pasangkan perangkat lain: kode 8 karakter base32 sekali pakai (2 menit) + link manage untuk ditempel di sana.
// Semua isi dari server divalidasi dulu (alfabet & panjang kode, waktu kedaluwarsa wajar) lalu dirender via textContent.
const PAIR_TOKEN = ${jsonForScript(String(queryToken ?? ''))};
const PAIR_CODE_RE = new RegExp(${jsonForScript(PAIR_CODE_SOURCE)});
const PAIR_TTL_MS = 2 * 60 * 1000;
const byId = (id) => document.getElementById(id);
let pairTimer = 0, pairEndsAt = 0;
const pairMsg = (text) => { const el = byId('pair-msg'); if (el) el.textContent = text; };
function pairTick() {
  const left = Math.max(0, Math.ceil((pairEndsAt - Date.now()) / 1000));
  const count = byId('pair-count');
  if (count) count.textContent = '· sisa ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'); // berhenti di 0:00
  if (left > 0) return;
  clearInterval(pairTimer);
  pairTimer = 0;
  byId('pair-code').classList.add('expired');
  pairMsg('⌛ Kode kedaluwarsa — tekan “Buat kode baru” untuk kode lain.');
}
function showPairCode(code, expiresAt) {
  const now = Date.now();
  const exp = Number(expiresAt);
  const sane = Number.isFinite(exp) && exp > now && exp - now <= 10 * 60 * 1000; // jam server ngawur → pakai 2 menit lokal
  pairEndsAt = sane ? exp : now + PAIR_TTL_MS;
  const box = byId('pair-code');
  box.textContent = String(code).toUpperCase(); // selalu uppercase, apa pun yang dikirim server
  box.classList.remove('expired');
  box.hidden = false;
  byId('pair-copy').hidden = false;
  pairMsg('Kode siap — masukkan di perangkat lain. Berlaku 2 menit dan hanya sekali pakai.');
  pairTick();
  clearInterval(pairTimer);
  pairTimer = setInterval(pairTick, 1000);
}
byId('pair-new').addEventListener('click', async () => {
  const btn = byId('pair-new');
  if (!PAIR_TOKEN) { pairMsg('⚠ Token tidak ada di URL — buka halaman Kelola lewat link manage-mu.'); return; }
  btn.disabled = true;
  btn.textContent = 'Membuat kode…';
  try {
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'X-Bridge-Token': PAIR_TOKEN } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d && typeof d.error === 'string' && d.error ? d.error : 'HTTP ' + r.status);
    const raw = d && typeof d.code === 'string' ? d.code.trim().toUpperCase() : ''; // kode selalu ditampilkan uppercase
    const code = PAIR_CODE_RE.test(raw) ? raw : '';
    if (!code) throw new Error('kode dari server tidak lengkap');
    showPairCode(code, d.expiresAt);
    btn.textContent = 'Buat kode baru';
  } catch (err) {
    pairMsg('⚠ Gagal membuat kode: ' + (err && err.message ? err.message : 'jaringan gagal'));
    btn.textContent = 'Coba lagi';
  } finally {
    btn.disabled = false;
  }
});
byId('pair-copy').addEventListener('click', async () => {
  if (!PAIR_TOKEN) return;
  const link = location.origin + '/manage?token=' + encodeURIComponent(PAIR_TOKEN);
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard tidak tersedia');
    await navigator.clipboard.writeText(link);
    pairMsg('✅ Link manage disalin — buka di perangkat lain, lalu tempel di kolom alamat.');
  } catch (err) {
    window.prompt('Salin link manage (Ctrl+C):', link); // fallback: tidak semua browser mengizinkan clipboard
  }
});
</script>`);
}

export const deletedPageHtml = (id = '') => page('Space dihapus', `
<h1>🗑 Space dihapus</h1><p class="muted">Semua data (termasuk kredensial terenkripsi) sudah dihapus dari server.</p>
<p><a href="/">← Daftar lagi</a></p>
<script>
// Kartu "Space kamu" di "/" tidak boleh menunjuk space yang sudah tidak ada (hanya yang id-nya cocok).
try {
  const KEY = 'adhitron-space';
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const s = JSON.parse(raw);
    if (s && s.id === ${jsonForScript(String(id))}) localStorage.removeItem(KEY);
  }
} catch {}
</script>`);

export const errorPageHtml = (title, text) => page(escapeHtml(title), `
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="/">← Beranda</a></p>`);

const POWER_OFF_W = 5; // sama dengan ambang bridge: di bawah ini listrik dianggap benar-benar terputus
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** State eksplisit dari server; jawaban versi lama (tanpa `state`) diperlakukan konservatif. */
const stateOfStatus = (s) => s.state || (s.alive ? 'alive' : 'unknown');

/** Baris state awal (server-side, fallback tanpa JS). Fungsi modul — bukan bagian dari script halaman.
 *  Aturan (sama dengan render() di klien):
 *    alive → 🟢 hidup · booting → 🖥 · suspected-alive → 🟡 · off → ⚫ · unknown → ⚪ belum pasti.
 *  Daya ≤ 5 W saat jadwal mati aktif = listrik sudah tidak mengalir: tampilkan "PC sudah mati", bukan 🟢. */
export function initialLine(s) {
  if (s.needsAttention) return '⚠ gagal memutus — cek plug manual';
  const state = stateOfStatus(s);
  const watts = s.powerW != null ? ` (${s.powerW} W)` : '';
  const countdown = s.offAt && s.secondsUntilOff != null ? ` · ⏳ listrik diputus dalam ${fmtClock(s.secondsUntilOff)}` : '';
  if (s.powerW != null && s.powerW <= POWER_OFF_W && s.offAt != null) return '⚫ PC sudah mati' + countdown;
  if (state === 'alive') return '🟢 PC hidup' + countdown;
  if (state === 'booting') return '🖥 PC sedang booting…' + watts + countdown;
  if (state === 'suspected-alive') return '🟡 PC kemungkinan hidup' + watts + countdown;
  if (state === 'off') return '⚫ PC mati' + countdown;
  return '⚪ Status belum pasti' + countdown;
}

/** Tombol untuk render server-side (sebelum JS jalan). Aturannya identik dengan render() di klien:
 *  hidup → Matikan PC rapi + Buka Adhitron; booting/curiga hidup → hanya Putus paksa; mati → Nyalakan PC;
 *  belum pasti → Nyalakan paksa (menyiklus listrik). */
function initialButtons(state, s) {
  const open = s.adhitronUrl
    ? `<a class="btn open" href="${escapeHtml(s.adhitronUrl)}" target="_self" rel="noreferrer">▶ Buka Adhitron</a>`
    : '';
  if (state === 'alive') {
    return '<button class="btn off" onclick="offRapi()">⏻ Matikan PC rapi</button>'
      + '<p class="muted">Listrik diputus 5 mnt lagi; tutup dulu aplikasimu — jembatan tidak bisa memerintahkan OS mati dari jauh.</p>'
      + open;
  }
  if (state === 'booting' || state === 'suspected-alive') {
    return '<button class="btn off" onclick="force()">⚠ Putus paksa</button>'
      + '<p class="muted">PC tidak kunjung hidup? Putus paksa memotong listrik dalam 5 mnt; kalau ternyata heartbeat datang, jadwal otomatis batal.</p>';
  }
  if (state === 'off') {
    return '<button class="btn on" onclick="nyalakan()">⚡ Nyalakan PC</button>'
      + (s.adhitronUrl ? '<p class="muted">Setelah hidup: tombol ▶ Buka Adhitron muncul di sini.</p>' : '');
  }
  return '<button class="btn on" onclick="nyalakanPaksa()">⚡ Nyalakan paksa</button>'
    + '<p class="muted">Belum ada bukti yang cukup untuk memastikan PC mati. Nyalakan paksa menyiklus listrik OFF → ON — PC yang masih hidup akan mati sebentar.</p>';
}

/** Halaman status: state awal dirender server (fallback tanpa JS), lalu JS polling /api/status tiap 10 dtk
 * dengan header X-Status-Token (bukan X-Bridge-Token — aturan sendiri untuk tiket/ownerToken di halaman).
 * Aturan tombol per `status.state`:
 *   alive          → ⏻ Matikan PC rapi + ▶ Buka Adhitron;
 *   booting        → hanya ⚠ Putus paksa (jangan tawarkan "matikan rapi" untuk PC yang belum bisa dijangkau);
 *   suspected-alive→ sama, dengan nada "kemungkinan hidup";
 *   off            → ⚡ Nyalakan PC (ditolak server dengan 409 kalau ternyata masih hidup);
 *   unknown        → ⚡ Nyalakan paksa (?force=1, listrik disiklus — dijelaskan lewat confirm). */
export function statusPageHtml(id, pollToken, fromTicket, status, adhitronUrl) {
  const state = stateOfStatus(status);
  const initial = {
    state, alive: status.alive, offAt: status.offAt, secondsUntilOff: status.secondsUntilOff,
    plug: status.plug, powerW: status.powerW, booting: status.booting,
    needsAttention: status.needsAttention, lastHeartbeat: status.lastHeartbeat, adhitronUrl,
  };
  return page('Remote power', `
<h1>Remote power PC</h1>
<div class="state" id="state">${escapeHtml(initialLine(initial))}</div>
<div id="extra"></div>
<div id="btns">${initialButtons(state, initial)}${status.offAt ? '<button class="btn" onclick="batalkan()">✕ Batalkan jadwal</button>' : ''}</div>
<p class="muted" id="plug">Plug: ${escapeHtml(status.plug ?? '?')}${status.powerW != null ? ` · ${escapeHtml(String(status.powerW))} W` : ''}</p>
<script>
const ID = ${jsonForScript(id)}, TOKEN = ${jsonForScript(pollToken)}, FROM_TICKET = ${jsonForScript(fromTicket)};
const POWER_OFF_W = ${POWER_OFF_W};
let bootMode = false, timer = null, flash = '';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
if (FROM_TICKET) history.replaceState(null, '', '/s/' + ID + '?t=' + TOKEN); // tiket sesi menggantikan tiket serah-terima di URL
function fmt(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }
async function call(path) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'X-Status-Token': TOKEN } });
    if (r.ok) return { ok: true };
    // 409 ("PC sepertinya masih hidup") dan kawan-kawan: alasannya HARUS terlihat di halaman.
    const d = await r.json().catch(() => ({}));
    return { ok: false, error: (d && typeof d.error === 'string' && d.error) ? d.error : 'Permintaan ditolak (HTTP ' + r.status + ').' };
  } catch { return { ok: false, error: 'jaringan gagal — coba lagi.' }; }
}
function render(s) {
  if (s.id !== ID) return;
  const state = s.state || (s.alive ? 'alive' : 'unknown');
  const extra = [];
  if (s.needsAttention) extra.push('<div class="warn">⚠ gagal memutus — cek plug manual, lalu coba Nyalakan ulang.</div>');
  if (flash) extra.push('<div class="warn">⚠ ' + esc(flash) + '</div>');
  $('extra').innerHTML = extra.join('');
  const watts = s.powerW != null ? ' (' + s.powerW + ' W)' : '';
  const countdown = (s.offAt && s.secondsUntilOff != null) ? ' · ⏳ listrik diputus dalam ' + fmt(s.secondsUntilOff) : '';
  let line, btns = '';
  if (state === 'alive') {
    line = '🟢 PC hidup';
    btns = '<button class="btn off" onclick="offRapi()">⏻ Matikan PC rapi</button>' +
      '<p class="muted">Listrik diputus 5 mnt lagi; tutup dulu aplikasimu — jembatan tidak bisa memerintahkan OS mati dari jauh.</p>' +
      (s.adhitronUrl ? '<a class="btn open" href="' + esc(s.adhitronUrl) + '" target="_self" rel="noreferrer">▶ Buka Adhitron</a>' : '');
    bootMode = false;
  } else if (state === 'booting' || state === 'suspected-alive' || bootMode) {
    line = (state === 'suspected-alive' ? '🟡 PC kemungkinan hidup' : '🖥 PC sedang booting…') + watts;
    btns = '<button class="btn off" onclick="force()">⚠ Putus paksa</button>' +
      '<p class="muted">PC tidak kunjung hidup? Putus paksa memotong listrik dalam 5 mnt; kalau ternyata heartbeat datang, jadwal otomatis batal.</p>';
  } else if (state === 'off') {
    line = '⚫ PC mati';
    btns = '<button class="btn on" onclick="nyalakan()">⚡ Nyalakan PC</button>';
    if (s.adhitronUrl) btns += '<p class="muted">Setelah hidup: tombol ▶ Buka Adhitron muncul di sini.</p>';
  } else {
    line = '⚪ Status belum pasti' + watts;
    btns = '<button class="btn on" onclick="nyalakanPaksa()">⚡ Nyalakan paksa</button>' +
      '<p class="muted">Belum ada bukti yang cukup untuk memastikan PC mati. Nyalakan paksa menyiklus listrik OFF → ON — PC yang masih hidup akan mati sebentar.</p>';
  }
  // Daya ≤ 5 W saat jadwal mati aktif: listrik sudah tidak mengalir → jangan tampilkan "PC hidup".
  if (s.offAt && s.powerW != null && s.powerW <= POWER_OFF_W) line = '⚫ PC sudah mati';
  if (countdown) line += countdown;
  // A pending schedule can always be dropped without cycling the plug (hold=1 is not cancelled by heartbeats).
  if (s.offAt) btns += '<button class="btn" onclick="batalkan()">✕ Batalkan jadwal</button>';
  $('state').textContent = line;
  $('btns').innerHTML = btns;
  $('plug').textContent = 'Plug: ' + (s.plug ?? '?') + (s.powerW != null ? ' · ' + s.powerW + ' W' : '');
}
async function act(path, boot) {
  flash = '';
  bootMode = !!boot; // optimistis: tampilkan "booting…" sampai poll berikutnya
  const r = await call(path);
  if (!r.ok) { bootMode = false; flash = r.error; } // jangan diam: alasan penolakan server tampil di halaman
  poll();
}
function nyalakan() { act('/api/on', true); }
function nyalakanPaksa() {
  if (confirm('Nyalakan paksa? Listrik akan disiklus OFF → ON. Kalau PC ternyata masih hidup, PC mati mendadak lalu hidup lagi. Lanjut?')) act('/api/on?force=1', true);
}
function offRapi() { if (confirm('Tutup dulu aplikasimu; listrik diputus 5 mnt lagi — jembatan tidak bisa memerintahkan OS mati dari jauh. Lanjut?')) act('/api/off?delay=300&hold=1'); }
async function batalkan() {
  if (!confirm('Batalkan jadwal pemutusan listrik? PC tetap menyala.')) return;
  flash = '';
  const r = await call('/api/off/cancel');
  if (!r.ok) flash = r.error;
  poll();
}
function force() { if (confirm('Putus paksa? Listrik diputus dalam 5 menit; kalau ternyata PC hidup lagi, jadwal otomatis batal.')) act('/api/off?delay=300'); }
async function poll() {
  try {
    const r = await fetch('/api/status', { headers: { 'X-Status-Token': TOKEN } });
    if (r.status === 401) { $('state').textContent = '⚫ sesi kedaluwarsa — muat ulang halaman / minta link baru'; return; }
    render(await r.json());
  } catch { /* jaringan: coba lagi di tick berikutnya */ }
  clearTimeout(timer);
  timer = setTimeout(poll, bootMode ? 3000 : 10000);
}
render(${jsonForScript(initial)});
poll();
</script>`);
}

/** Halaman kalau tiket kedaluwarsa / token salah pada halaman HTML (401). */
export const ticketExpiredHtml = () => page('Sesi kedaluwarsa', `
<h1>⌛ Link tidak berlaku</h1>
<p class="muted">Link serah-terima hanya dipakai sekali dan kedaluwarsa 10 menit. Minta link baru (tombol Matikan PC di
Adhitron) atau buka <code>/manage</code> dengan token-mu.</p><p><a href="/">← Beranda</a></p>`);
