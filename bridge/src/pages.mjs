// bridge/src/pages.mjs — semua halaman HTML (register / manage / status) dari string template,
// pola statusPageHtml lama di bridge/worker.js. Tanpa file statis: situsnya murni fungsi.
// Nilai dari user (adhitronUrl, pesan) SELALU lewat escapeHtml — kredensial Tuya tidak pernah masuk HTML.
// Tampilan: brand Adhitron (bg gelap #121317, aksen oranye #d97757, logo inline) — CSS satu blok di bawah,
// tanpa dependensi, responsif (phone 390 / desktop 1440). Nama class .note/.warn/.btn/.danger/.muted
// dipertahankan karena dipakai juga oleh notice dari bridge.mjs.

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

export function registerPageHtml(notice = '') {
  return page('Adhitron Remote Power — daftar', `
<h1>Remote power untuk PC-mu</h1>
<p class="lead">Nyalakan / matikan PC dari jauh lewat smart plug (Bardi, Smart Life, dsb.) — gratis, multi-user:
daftar, tempel URL + token di panel ⚙ Remote power Adhitron.</p>
${notice}
${tuyaHelp}
${privacy}
${privacyNotice}
<h2>Daftar</h2>
<form id="reg">
<label>Client ID (Access ID Tuya)<input name="tuyaClientId" required maxlength="200"></label>
<label>Client Secret (Access Secret Tuya)<input name="tuyaClientSecret" type="password" required maxlength="200"></label>
<label>Device ID plug<input name="tuyaDeviceId" required maxlength="200"></label>
<label>Region<select name="tuyaRegion"><option value="eu">eu (Eropa)</option><option value="america">america</option><option value="asia">asia</option></select></label>
<label>URL Adhitron (opsional, https://… — link "Buka Adhitron" di halaman status)<input name="adhitronUrl" placeholder="https://nama-mu.ts.net" maxlength="200"></label>
<button class="btn on" type="submit">Daftar &amp; dapat token</button>
</form>
<div id="out"></div>
<script>
const $ = (id) => document.getElementById(id);
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
  } catch (err) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = '⚠ jaringan gagal';
    out.replaceChildren(warn);
  }
});
</script>`);
}

/** space.ownerToken tidak ada lagi di record (terenkripsi) — form action memakai token dari query request. */
export function managePageHtml(space, queryToken, creds, { notice = '', newToken = null } = {}) {
  const regionOpts = ['eu', 'america', 'asia']
    .map((r) => `<option value="${r}" ${creds.tuyaRegion === r ? 'selected' : ''}>${r}</option>`).join('');
  const formAction = `/api/manage?token=${encodeURIComponent(queryToken)}`;
  return page('Kelola space', `
<h1>Kelola space</h1>
<p class="muted">id: <code>${escapeHtml(space.id)}</code> · dibuat ${new Date(space.createdAt).toISOString().slice(0, 16).replaceAll('T', ' ')} UTC</p>
${notice}
${newToken ? `<div class="note"><b>Token baru (token lama MATI):</b><br><code>${escapeHtml(newToken)}</code><br>Salin sekarang — hanya ditampilkan sekali.</div>` : ''}
<h2>Kredensial &amp; URL</h2>
<p class="muted">Kredensial tidak pernah ditampilkan siap-salin — isi ulang untuk mengubah (Secret kosong = tetap pakai yang lama).</p>
<form method="post" action="${formAction}">
<input type="hidden" name="action" value="update">
<label>Client ID (Access ID)<input name="tuyaClientId" value="${escapeHtml(creds.tuyaClientId)}" maxlength="200"></label>
<label>Client Secret (kosongkan = tetap pakai yang lama)<input name="tuyaClientSecret" type="password" placeholder="••••••••" maxlength="200"></label>
<label>Device ID plug<input name="tuyaDeviceId" value="${escapeHtml(creds.tuyaDeviceId)}" maxlength="200"></label>
<label>Region<select name="tuyaRegion">${regionOpts}</select></label>
<label>URL Adhitron (https://…, kosongkan = tanpa link)<input name="adhitronUrl" value="${escapeHtml(space.adhitronUrl ?? '')}" maxlength="200"></label>
<button class="btn on" type="submit">Simpan perubahan</button>
</form>
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
</form></div>`);
}

export const deletedPageHtml = () => page('Space dihapus', `
<h1>🗑 Space dihapus</h1><p class="muted">Semua data (termasuk kredensial terenkripsi) sudah dihapus dari server.</p>
<p><a href="/">← Daftar lagi</a></p>`);

export const errorPageHtml = (title, text) => page(escapeHtml(title), `
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="/">← Beranda</a></p>`);

/** Baris state awal (server-side, fallback tanpa JS). Fungsi modul — bukan bagian dari script halaman. */
export function initialLine(s) {
  if (s.needsAttention) return '⚠ gagal memutus — cek plug manual';
  if (s.alive) return '🟢 PC hidup';
  if (s.offAt && s.secondsUntilOff != null) {
    const m = Math.floor(s.secondsUntilOff / 60), sec = s.secondsUntilOff % 60;
    return `⏳ listrik diputus dalam ${m}:${String(sec).padStart(2, '0')}`;
  }
  return '⚫ PC mati — belum ada kabar';
}

/** Halaman status: state awal dirender server (fallback tanpa JS), lalu JS polling /api/status tiap 10 dtk
 * dengan header X-Status-Token (bukan X-Bridge-Token — aturan sendiri untuk tiket/ownerToken di halaman).
 * Aturan tombol:
 *   mati  → ⚡ Nyalakan PC (masuk mode tunggu "booting…" sampai heartbeat hidup → ▶ Buka Adhitron);
 *   hidup → hanya ⏻ Matikan PC rapi (delay 300 dtk, tombol potong-manual lain terkunci);
 *   beku  (power tinggi + heartbeat basi ≥ 30 mnt) → ⚠ Putus paksa (confirm, delay 300; heartbeat datang = batal otomatis). */
export function statusPageHtml(id, pollToken, fromTicket, status, adhitronUrl) {
  const initial = {
    alive: status.alive, offAt: status.offAt, secondsUntilOff: status.secondsUntilOff,
    plug: status.plug, powerW: status.powerW, booting: status.booting,
    needsAttention: status.needsAttention, lastHeartbeat: status.lastHeartbeat, adhitronUrl,
  };
  return page('Remote power', `
<h1>Remote power PC</h1>
<div class="state" id="state">${escapeHtml(initialLine(initial))}</div>
<div id="extra"></div>
<div id="btns"></div>
<p class="muted" id="plug">Plug: ${escapeHtml(status.plug ?? '?')}${status.powerW != null ? ` · ${escapeHtml(String(status.powerW))} W` : ''}</p>
<script>
const ID = ${jsonForScript(id)}, TOKEN = ${jsonForScript(pollToken)}, FROM_TICKET = ${jsonForScript(fromTicket)};
let bootMode = false, timer = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
if (FROM_TICKET) history.replaceState(null, '', '/s/' + ID + '?t=' + TOKEN); // tiket sesi menggantikan tiket serah-terima di URL
function fmt(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }
async function call(path) { try { const r = await fetch(path, { method: 'POST', headers: { 'X-Status-Token': TOKEN } }); return r.ok; } catch { return false; } }
function render(s) {
  if (s.id !== ID) return;
  if (s.needsAttention) $('extra').innerHTML = '<div class="warn">⚠ gagal memutus — cek plug manual, lalu coba Nyalakan ulang.</div>';
  else $('extra').innerHTML = '';
  let line, btns = '';
  if (s.alive) {
    line = '🟢 PC hidup';
    btns = '<button class="btn off" onclick="offRapi()">⏻ Matikan PC rapi</button>' +
      '<p class="muted">Listrik diputus 5 mnt lagi; tutup dulu aplikasimu — jembatan tidak bisa memerintahkan OS mati dari jauh.</p>' +
      (s.adhitronUrl ? '<a class="btn open" href="' + esc(s.adhitronUrl) + '" target="_self" rel="noreferrer">▶ Buka Adhitron</a>' : '');
    bootMode = false;
  } else if (s.booting || bootMode) {
    line = '🖥 PC sedang booting…' + (s.powerW != null ? ' (' + s.powerW + ' W)' : '');
    btns = '<button class="btn off" onclick="force()">⚠ Putus paksa</button>' +
      '<p class="muted">PC tidak kunjung hidup? Putus paksa memotong listrik dalam 5 mnt; kalau ternyata heartbeat datang, jadwal otomatis batal.</p>';
  } else {
    line = '⚫ PC mati';
    btns = '<button class="btn on" onclick="nyalakan()">⚡ Nyalakan PC</button>';
    if (s.adhitronUrl) btns += '<p class="muted">Setelah hidup: tombol ▶ Buka Adhitron muncul di sini.</p>';
  }
  if (s.offAt && s.secondsUntilOff != null) line += ' · ⏳ listrik diputus dalam ' + fmt(s.secondsUntilOff);
  $('state').textContent = line;
  $('btns').innerHTML = btns;
  $('plug').textContent = 'Plug: ' + (s.plug ?? '?') + (s.powerW != null ? ' · ' + s.powerW + ' W' : '');
}
function nyalakan() { bootMode = true; call('/api/on').then(poll); }
function offRapi() { if (confirm('Tutup dulu aplikasimu; listrik diputus 5 mnt lagi — jembatan tidak bisa memerintahkan OS mati dari jauh. Lanjut?')) call('/api/off?delay=300').then(poll); }
function force() { if (confirm('Putus paksa? Listrik diputus dalam 5 menit; kalau ternyata PC hidup lagi, jadwal otomatis batal.')) call('/api/off?delay=300').then(poll); }
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
