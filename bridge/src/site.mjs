// bridge/src/site.mjs — halaman portal situs (root '/') dan kerangka chat ('/chat').
// Portal memilih dua pintu: 💬 Chat (AI multi-user, API key milik user sendiri) dan 🔌 Remote Power
// (jembatan daya yang dipasang di '/bridge'). Warna & pola mengikuti brand Adhitron (lihat pages.mjs);
// file ini sengaja mandiri supaya portal bisa berevolusi tanpa menyentuh halaman jembatan.
import { escapeHtml } from './pages.mjs';

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
<rect width="64" height="64" rx="14" fill="#17181e"/>
<g fill="none" stroke="#d97757" stroke-width="1.5">
<ellipse cx="32" cy="32" rx="18.7" ry="6.7"/>
<ellipse cx="32" cy="32" rx="18.7" ry="6.7" transform="rotate(60 32 32)"/>
<ellipse cx="32" cy="32" rx="18.7" ry="6.7" transform="rotate(-60 32 32)"/>
</g>
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
--accent-soft:#2a211d;--accent-line:#5a3a2c}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);
margin:0;min-height:100vh;display:flex;flex-direction:column;line-height:1.55;-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;font-weight:600;font-size:.95rem}
.brand svg{width:30px;height:30px;border-radius:8px;display:block;flex:none}
.brand em{font-style:normal;color:var(--accent)}
main{width:100%;max-width:720px;margin:0 auto;padding:34px 20px 56px;flex:1}
h1{margin:0 0 6px;font-size:1.6rem;letter-spacing:-.02em;line-height:1.2}
p{margin:8px 0}
a{color:var(--accent)}
.muted{color:var(--muted);font-size:.9rem}
.lead{color:var(--text-2);margin:0 0 24px;font-size:1.02rem}
.doors{display:grid;gap:14px}
@media(min-width:620px){.doors{grid-template-columns:1fr 1fr}}
.door{display:block;text-decoration:none;color:var(--text);background:var(--surface);border:1px solid var(--line);
border-radius:16px;padding:20px;transition:border-color .15s,transform .15s}
.door:hover{border-color:var(--accent-line);transform:translateY(-2px)}
.door:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.door .ico{font-size:2rem;line-height:1}
.door h2{margin:12px 0 6px;font-size:1.12rem}
.door p{margin:0;color:var(--text-2);font-size:.92rem}
.door .go{display:inline-block;margin-top:14px;color:var(--accent);font-weight:600;font-size:.9rem}
.foot{padding:14px 20px;border-top:1px solid var(--line);text-align:center;font-size:.75rem;color:var(--muted)}
.note{background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:10px;
padding:10px 12px;font-size:.85rem;margin:16px 0}
.chat-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tabs{display:flex;gap:6px;margin:16px 0 10px}
.tab{flex:1;padding:10px 12px;min-height:44px;border-radius:10px;border:1px solid var(--line);
background:var(--surface);color:var(--text-2);font:inherit;font-size:.95rem;font-weight:600;cursor:pointer}
.tab.active{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent)}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.authform{margin-top:10px}
label{display:block;margin:12px 0 4px;font-size:.8rem;font-weight:600;letter-spacing:.02em;color:var(--muted)}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--surface);
color:var(--text);font:inherit;font-size:.95rem}
input:focus{border-color:var(--accent);outline:none}
.btn{display:block;width:100%;margin:14px 0 4px;padding:13px 16px;min-height:50px;border-radius:12px;
border:1px solid transparent;font:inherit;font-size:1rem;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.btn:active{transform:translateY(1px)}
.on{background:var(--accent-solid);color:#fff}
.on:hover{background:var(--accent-hover)}
.ghost{background:var(--surface-2);color:var(--text);border-color:var(--line)}
.ghost:hover{background:var(--line)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.msg{margin:12px 0;padding:10px 12px;border-radius:10px;font-size:.88rem;background:var(--surface-2);border:1px solid var(--line)}
.msg.bad{background:#2a1614;border-color:#6e2a24}
`;

const shell = (title, body) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#121317">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/">${LOGO}<span>Adhitron</span></a></header>
<main>${body}</main>
<footer class="foot">Adhitron · kantor pixel-art untuk Claude Code &amp; OpenCode</footer>
</body></html>`;

/** Portal '/': dua pintu. Chat memakai API key milik user; Remote power memakai jembatan '/bridge'. */
export function portalPageHtml() {
  return shell('Adhitron', `
<h1>Selamat datang di Adhitron</h1>
<p class="lead">Dua alat dalam satu tempat. Pilih salah satu.</p>
<div class="doors">
<a class="door" href="/chat">
<span class="ico" aria-hidden="true">💬</span>
<h2>Chat</h2>
<p>Ngobrol dengan AI dari browser — model &amp; effort seperti Adhitron lokal, plus browsing web.
Masuk dengan akunmu dan tempel <b>API key milikmu sendiri</b>.</p>
<span class="go">Buka Chat →</span>
</a>
<a class="door" href="/bridge">
<span class="ico" aria-hidden="true">🔌</span>
<h2>Remote Power</h2>
<p>Nyalakan / matikan PC dari jauh lewat smart plug (Bardi, Smart Life) — cocok saat PC sedang mati
dan kamu ingin menyalakannya dari HP.</p>
<span class="go">Buka Remote Power →</span>
</a>
</div>
<div class="note">🔐 Di Chat, API key-mu disimpan terenkripsi dan hanya dipakai untuk permintaanmu sendiri.</div>`);
}

/** Kerangka halaman chat. M3: form masuk/daftar + status sesi. Percakapan menyusul (M7). */
export function chatPageHtml() {
  return shell('Chat — Adhitron', `
<div class="chat-head">
  <h1>💬 Chat</h1>
  <div id="who" class="muted" hidden></div>
</div>
<p class="lead">Chat AI multi-user: masuk dengan akunmu, tempel API key milikmu, lalu ngobrol dengan
pilihan model &amp; effort dan browsing web.</p>

<section id="auth">
  <div class="tabs">
    <button class="tab active" data-tab="login" type="button">Masuk</button>
    <button class="tab" data-tab="signup" type="button">Daftar</button>
  </div>
  <form id="f-login" class="authform">
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required minlength="8"></label>
    <button class="btn on" type="submit">Masuk</button>
  </form>
  <form id="f-signup" class="authform" hidden>
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <label>Password (minimal 8 karakter)<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
    <button class="btn on" type="submit">Daftar</button>
  </form>
  <div id="authout" class="msg" hidden></div>
</section>

<section id="app" hidden>
  <div class="note">✅ Kamu sudah masuk. Penyusun percakapan (model, effort, browsing) menyusul di langkah
  berikutnya — untuk sekarang halaman ini memastikan akun &amp; sesi bekerja.</div>
  <button class="btn ghost" id="logout" type="button">Keluar</button>
</section>

<p class="muted"><a href="/">← Kembali ke portal</a></p>

<script>
const $ = (id) => document.getElementById(id);
const API = '/chat/api';
async function call(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}
function msg(text, kind) {
  const el = $('authout');
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}
async function refresh() {
  const { ok, data } = await call('/me');
  if (ok) {
    $('auth').hidden = true;
    $('app').hidden = false;
    $('who').hidden = false;
    $('who').textContent = 'masuk sebagai ' + data.user.email;
  } else {
    $('auth').hidden = false;
    $('app').hidden = true;
    $('who').hidden = true;
  }
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    $('f-login').hidden = tab.dataset.tab !== 'login';
    $('f-signup').hidden = tab.dataset.tab !== 'signup';
    msg('');
  });
}
async function submit(form, path) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    msg('Memproses…');
    const { ok, data } = await call(path, { method: 'POST', body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
    if (ok) { msg(''); await refresh(); }
    else msg((data && data.error) || 'Gagal, coba lagi', 'bad');
  });
}
submit($('f-login'), '/auth/login');
submit($('f-signup'), '/auth/signup');
$('logout').addEventListener('click', async () => { await call('/auth/logout', { method: 'POST' }); await refresh(); });
refresh();
</script>`);
}

/** Router situs (portal + chat). Mengembalikan Response untuk path yang dikenal, atau null. */
export function handleSite(request, url = new URL(request.url)) {
  const path = url.pathname;
  if (path === '/' && request.method === 'GET') return html(portalPageHtml());
  if ((path === '/chat' || path === '/chat/') && request.method === 'GET') return html(chatPageHtml());
  return null;
}

const html = (body, status = 200) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
});