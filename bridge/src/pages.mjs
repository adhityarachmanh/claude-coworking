// bridge/src/pages.mjs — semua halaman HTML (register / manage / status) dari string template,
// pola statusPageHtml lama di bridge/worker.js. Tanpa file statis: situsnya murni fungsi.
// Nilai dari user (adhitronUrl, pesan) SELALU lewat escapeHtml — kredensial Tuya tidak pernah masuk HTML.

const CSS = `body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#1b1b1b;padding:24px 28px;border-radius:14px;max-width:520px}
h1{margin:0 0 6px;font-size:1.3rem}.muted{color:#999;font-size:.85rem}
.state{font-size:1.05rem;margin:10px 0 18px}
.btn{display:block;width:100%;margin:8px 0;padding:12px;border-radius:10px;border:0;font-size:1rem;cursor:pointer;text-decoration:none;box-sizing:border-box}
.on{background:#2e7d32;color:#fff}.off{background:#c62828;color:#fff}.open{background:#265ea8;color:#fff}.ghost{background:#333;color:#eee}
label{display:block;margin:10px 0 2px;font-size:.85rem;color:#bbb}
input,select{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;font-size:.95rem}
.note{background:#26251b;border:1px solid #6b5d1e;border-radius:10px;padding:10px 12px;font-size:.85rem;margin:12px 0}
.warn{background:#2b1a1a;border:1px solid #7a3030;border-radius:10px;padding:10px 12px;font-size:.9rem;margin:12px 0}
.count{font-size:1.6rem;font-variant-numeric:tabular-nums}
code{background:#111;padding:2px 6px;border-radius:6px;word-break:break-all}
ol{padding-left:20px;font-size:.9rem;color:#ccc}li{margin:4px 0}
.danger{border:1px solid #7a3030;border-radius:10px;padding:12px;margin-top:16px}`;

export const escapeHtml = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** JSON aman untuk <script>: ganti '<' agar tidak bisa menutup tag lebih awal. */
const jsonForScript = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

const page = (title, body) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><div class="card">${body}</div></body></html>`;

const tuyaHelp = `<p class="muted">Cara ambil kredensial (Bardi / Smart Life):</p><ol>
<li>Daftar di <b>iot.tuya.com</b> (region sesuai app-mu — Indonesia biasanya <b>eu</b>), buat <b>Cloud Project</b>.</li>
<li>Salin <b>Access ID</b> (→ Client ID) dan <b>Access Secret</b>.</li>
<li>Tautkan akun <b>Smart Life</b> ke project (Devices → Link Smart Life).</li>
<li>Cari <b>Device ID</b> plug-nya di daftar device.</li>
<li>Set BIOS: <b>Restore on AC Power Loss = Power On</b> agar plug ON membuat PC boot.</li></ol>`;

const privacy = `<div class="note">🔐 <b>Privasi:</b> kredensial Tuya-mu disimpan <b>terenkripsi AES-256-GCM</b>
 di server ini (kunci diturunkan dari token pribadimu + kunci operator). Pembacaannya butuh akses ke
 server operator <i>dan</i> data store — <b>operator berkomitmen tidak membacanya</b>; kredensial hanya
 dipakai untuk mengoperasikan plug-mu sendiri, dan <b>dapat dihapus / dirotasi kapan saja</b> lewat halaman manage.</div>`;

/** Pemberitahuan privasi lengkap (compliance): tampil di halaman register, selesaikan daftar = setuju. */
const privacyNotice = `<div class="note" style="max-height:220px;overflow:auto;font-size:.78rem">
<b>🔐 Pemberitahuan privasi</b>
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
</ul></div>`;

export function registerPageHtml(notice = '') {
  return page('Adhitron Remote Power — daftar', `
<h1>⚡ Remote power untuk PC-mu</h1>
<p class="muted">Nyalakan / matikan PC dari jauh lewat smart plug (Bardi, Smart Life, dsb.), gratis, multi-user:
daftar, tempel URL + token di panel ⚙ Remote power Adhitron.</p>
${notice}
${tuyaHelp}
${privacy}
${privacyNotice}
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
  return page('Kelola space', `
<h1>⚙ Kelola space</h1>
<p class="muted">id: <code>${escapeHtml(space.id)}</code> · dibuat ${new Date(space.createdAt).toISOString().slice(0, 16).replaceAll('T', ' ')} UTC</p>
<p class="muted">Halaman ini adalah cara resmi melihat / memperbarui / menghapus data yang tersimpan tentangmu.
Kredensial tidak pernah ditampilkan siap-salin — isi ulang untuk mengubah (Secret kosong = tetap pakai yang lama).</p>
${notice}
${newToken ? `<div class="note"><b>Token baru (token lama MATI):</b><br><code>${escapeHtml(newToken)}</code><br>Salin sekarang — hanya ditampilkan sekali.</div>` : ''}
<form method="post" action="/api/manage?token=${encodeURIComponent(queryToken)}">
<input type="hidden" name="action" value="update">
<label>Client ID (Access ID)<input name="tuyaClientId" value="${escapeHtml(creds.tuyaClientId)}" maxlength="200"></label>
<label>Client Secret (kosongkan = tetap pakai yang lama)<input name="tuyaClientSecret" type="password" placeholder="••••••••" maxlength="200"></label>
<label>Device ID plug<input name="tuyaDeviceId" value="${escapeHtml(creds.tuyaDeviceId)}" maxlength="200"></label>
<label>Region<select name="tuyaRegion">${regionOpts}</select></label>
<label>URL Adhitron (https://…, kosongkan = tanpa link)<input name="adhitronUrl" value="${escapeHtml(space.adhitronUrl ?? '')}" maxlength="200"></label>
<button class="btn on" type="submit">Simpan perubahan</button>
</form>
<form method="post" action="/api/manage?token=${encodeURIComponent(queryToken)}" onsubmit="return confirm('Rotasi token? Token lama langsung mati — Adhitron perlu diisi ulang.')">
<input type="hidden" name="action" value="rotate">
<button class="btn ghost" type="submit">🔁 Rotasi token</button>
</form>
<div class="danger">
<b>🗑 Hapus space</b> — kredensial terenkripsi dihapus permanen, Adhitron berhenti bekerja.
<form method="post" action="/api/manage?token=${encodeURIComponent(queryToken)}" onsubmit="return confirm('Hapus space ini secara permanen?')">
<input type="hidden" name="action" value="delete">
<label><input type="checkbox" name="confirm" value="HAPUS" style="width:auto"> Saya yakin hapus space ini</label>
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
<h1>⚡ Remote power PC</h1>
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
      '<p class="muted">Tutup dulu aplikasimu; listrik diputus 5 mnt lagi — jembatan tidak bisa memerintahkan OS mati dari jauh.</p>' +
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
