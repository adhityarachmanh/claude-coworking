// bridge/src/site.mjs — halaman portal situs (root '/') dan kerangka chat ('/chat').
// Portal memilih dua pintu: 💬 Chat (AI multi-user, API key milik user sendiri) dan 🔌 Remote Power
// (jembatan daya yang dipasang di '/bridge'). Warna & pola mengikuti brand Adhitron (lihat pages.mjs);
// file ini sengaja mandiri supaya portal bisa berevolusi tanpa menyentuh halaman jembatan.
import { escapeHtml } from './pages.mjs';
import { chatAppJs } from './chat-app.mjs';

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
/* --- tata letak chat (M7) --- */
.chatwrap{display:grid;gap:0;height:100svh;height:100dvh;grid-template-rows:minmax(0,1fr)}
.chatbody{display:grid;grid-template-columns:1fr;min-height:0}
@media(min-width:820px){.chatbody{grid-template-columns:260px 1fr}}
.side{border-right:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;min-height:0}
.side[hidden]{display:none}
.side .side-top{padding:12px;display:flex;flex-direction:column;gap:8px}
.side .side-top .btn{margin:0}
.convs{list-style:none;margin:0;padding:0 8px 12px;overflow:auto;flex:1;min-height:0}
.convs li{margin:2px 0}
.conv{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:1px solid transparent;
color:var(--text-2);padding:9px 10px;border-radius:9px;font:inherit;font-size:.88rem;cursor:pointer}
.conv:hover{background:var(--surface-2)}
.conv.active{background:var(--accent-soft);border-color:var(--accent-line);color:var(--text)}
.conv .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv .del{color:var(--muted);border:none;background:transparent;font:inherit;cursor:pointer;padding:2px 4px}
.conv .del:hover{color:var(--accent-2)}
.chatmain{display:flex;flex-direction:column;min-height:0}
.thread{flex:1;overflow:auto;padding:18px 16px 8px;display:flex;flex-direction:column;gap:14px}
.turn{display:flex;flex-direction:column;gap:6px;max-width:100%}
.turn .who{font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.bubble{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 14px;font-size:.95rem;overflow-wrap:anywhere}
.turn.user .bubble{background:var(--surface-2)}
.turn.assistant .bubble{border-color:var(--line)}
.bubble pre{background:#0e0f13;border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:auto;font-size:.85rem}
.bubble code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86em;background:#0e0f13;padding:1px 5px;border-radius:5px}
.bubble pre code{background:none;padding:0}
.bubble a{color:var(--accent-2)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:5px;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;
padding:3px 10px;font-size:.78rem;color:var(--text-2);text-decoration:none;max-width:100%}
.chip b{color:var(--accent);font-weight:700}
.chip:hover{border-color:var(--accent-line)}
.composer{border-top:1px solid var(--line);padding:10px 12px 14px;background:var(--surface)}
.ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.ctl select,.ctl input[type=text]{background:var(--surface-2);border:1px solid var(--line);color:var(--text);
border-radius:9px;padding:8px 10px;font:inherit;font-size:.85rem;min-height:40px}
.ctl label.chk{display:inline-flex;align-items:center;gap:6px;font-size:.82rem;color:var(--text-2);
background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:7px 12px;cursor:pointer;min-height:40px}
.ctl label.chk input{width:auto;margin:0}
.ctl.on{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent)}
.rowin{display:flex;gap:8px;align-items:flex-end}
textarea{width:100%;resize:none;min-height:52px;max-height:180px;background:var(--surface-2);border:1px solid var(--line);
border-radius:12px;color:var(--text);font:inherit;font-size:.95rem;padding:12px 14px}
textarea:focus{border-color:var(--accent);outline:none}
.sendbtn{flex:none;min-width:52px;min-height:52px;border-radius:12px;border:1px solid transparent;background:var(--accent-solid);
color:#fff;font-size:1.2rem;cursor:pointer}
.sendbtn:disabled{opacity:.5;cursor:default}
.sendbtn.stop{background:#6e2a24}
.hint{font-size:.74rem;color:var(--muted);margin:6px 2px 0}
.overlay{position:fixed;inset:0;background:rgba(6,7,10,.7);display:flex;align-items:flex-start;justify-content:center;
padding:24px 12px;overflow:auto;z-index:40}
.overlay[hidden]{display:none}
.modal{background:var(--surface);border:1px solid var(--line);border-radius:16px;width:100%;max-width:560px;padding:18px}
.modal h2{margin:0 0 4px;font-size:1.15rem}
.prov{border:1px solid var(--line);border-radius:12px;padding:12px;margin:10px 0;display:flex;gap:10px;align-items:center;justify-content:space-between}
.prov .meta{min-width:0}
.prov .meta b{display:block}
.prov .meta span{font-size:.8rem;color:var(--muted)}
.prov .acts{display:flex;gap:6px;flex:none}
.mini{background:var(--surface-2);border:1px solid var(--line);color:var(--text-2);border-radius:9px;padding:8px 12px;
font:inherit;font-size:.82rem;cursor:pointer;min-height:40px}
.mini:hover{border-color:var(--accent-line);color:var(--text)}
.mini.danger:hover{border-color:#6e2a24;color:var(--accent-2)}
.grid2{display:grid;gap:8px}
@media(min-width:520px){.grid2{grid-template-columns:1fr 1fr}}
.tiers{display:grid;gap:8px;margin-top:6px}
.tiers label{margin:0}
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);
border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle}
@keyframes sp{to{transform:rotate(360deg)}}
.menu-btn{display:none}
@media(max-width:819px){.menu-btn{display:inline-flex}.side{position:fixed;top:0;bottom:0;left:0;width:min(280px,86vw);z-index:30;
transform:translateX(-100%);transition:transform .18s}.side.open{transform:none;box-shadow:0 0 0 100vmax rgba(0,0,0,.5)}
input,select,textarea,.ctl select,.ctl input[type=text]{font-size:16px}}
@media(pointer:coarse){.conv,.mini,.menu-btn,.ctl select,.ctl input[type=text],.ctl label.chk{min-height:44px}
.chip{padding:8px 12px}.conv .del{min-width:44px;min-height:44px}}
/* --- kerangka penuh untuk /chat (tanpa header/footer) --- */
body.nochrome{height:var(--vv-h,100dvh);min-height:0;overflow:hidden}
body.nochrome .chatwrap{height:100%;padding-bottom:env(safe-area-inset-bottom)}
body.nochrome .composer{padding-bottom:calc(14px + env(safe-area-inset-bottom))}
body.nochrome .side{padding-bottom:env(safe-area-inset-bottom)}
.authwrap{width:100%;max-width:440px;margin:0 auto;padding:calc(28px + env(safe-area-inset-top)) 18px calc(28px + env(safe-area-inset-bottom));overflow:auto;height:100svh;height:100dvh}
@media(max-width:360px){.authwrap{padding:16px 12px}.doors{gap:10px}.door{padding:16px}}
.overlay{padding-bottom:calc(24px + env(safe-area-inset-bottom))}
.scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
.bubble img{max-width:100%;height:auto}
.bubble p:first-child{margin-top:0}
.bubble p:last-child{margin-bottom:0}
.bubble ul{margin:6px 0;padding-left:20px}
.chip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prov .meta b,.prov .meta span{overflow-wrap:anywhere}
`;

const shell = (title, body, { bare = false, chrome = true } = {}) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#121317">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body${
  chrome ? '' : ' class="nochrome"'
}>
${chrome ? `<header class="top"><a class="brand" href="/">${LOGO}<span>Adhitron</span></a></header>` : ''}
${bare ? body : `<main>${body}</main>`}
${chrome ? '<footer class="foot">Adhitron · kantor pixel-art untuk Claude Code &amp; OpenCode · <a href="/privasi">Privasi</a> · <a href="/syarat">Syarat</a></footer>' : ''}
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

/** Halaman chat penuh (M7): sidebar riwayat, thread, composer model/effort/browsing, setelan provider. */
export function chatPageHtml() {
  return shell('Chat — Adhitron', `
<section id="auth" class="authwrap">
  <a class="brand" href="/" style="display:inline-flex;margin-bottom:8px">${LOGO}<span>Adhitron <em>Chat</em></span></a>
  <h1>💬 Chat</h1>
  <p class="lead">Masuk dengan akunmu, tempel API key milikmu sendiri, lalu ngobrol dengan pilihan model
  &amp; effort serta browsing web.</p>
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
  <p class="muted"><a href="/">← Kembali ke portal</a></p>
</section>

<section id="app" class="chatwrap" hidden>
  <div class="chatbody">
    <aside class="side" id="side">
      <div class="side-top">
        <button class="btn on" id="newconv" type="button">+ Percakapan baru</button>
        <button class="mini" id="settings" type="button">⚙ Provider &amp; API key</button>
      </div>
      <ul class="convs" id="convs"></ul>
      <div class="side-top">
        <div class="muted" id="who"></div>
        <button class="mini danger" id="logout" type="button">Keluar</button>
        <button class="mini danger" id="delacct" type="button">Hapus akun</button>
      </div>
    </aside>
    <div class="chatmain">
      <div class="top" style="gap:10px">
        <button class="mini menu-btn" id="menu" type="button" aria-label="Riwayat">☰</button>
        <b id="ttl">Percakapan baru</b>
      </div>
      <div class="thread" id="thread" aria-live="polite"></div>
      <form class="composer" id="composer">
        <div class="ctl">
          <select id="model" aria-label="Model"></select>
          <select id="effort" aria-label="Effort"></select>
          <label class="chk" id="auto-wrap" title="Biarkan LLM memilih model & effort"><input type="checkbox" id="auto"> Auto</label>
          <label class="chk" id="browse-wrap" title="Cari web & kutip sumber"><input type="checkbox" id="browsing"> 🔎 Browsing</label>
        </div>
        <div class="rowin">
          <textarea id="input" rows="2" placeholder="Tulis pesan… (Enter kirim, Shift+Enter baris baru)"></textarea>
          <button class="sendbtn" id="send" type="submit" aria-label="Kirim">➤</button>
        </div>
        <div class="hint" id="hint"></div>
      </form>
    </div>
  </div>
</section>

<div class="overlay" id="prov" hidden>
  <div class="modal">
    <h2>⚙ Provider &amp; API key</h2>
    <p class="muted">API key disimpan terenkripsi (AES-256-GCM) dan hanya dipakai untuk permintaanmu.</p>
    <div id="provlist"></div>
    <form id="provform">
      <div class="grid2">
        <label>Jenis<select name="kind" id="pkind"></select></label>
        <label>Label<input name="label" type="text" placeholder="mis. OpenAI saya"></label>
      </div>
      <label>API key<input name="apiKey" type="password" autocomplete="off" required></label>
      <label>Base URL (opsional, untuk OpenAI-compatible)<input name="baseUrl" type="text" placeholder="https://..."></label>
      <div class="grid2" style="margin-top:10px">
        <button class="btn on" type="submit">Tambah provider</button>
        <button class="btn ghost" type="button" id="provclose">Tutup</button>
      </div>
      <div id="provmsg" class="msg" hidden></div>
    </form>
  </div>
</div>

<script src="/chat/app.js" defer></script>`, { chrome: false, bare: true });
}

/** Halaman kebijakan privasi (/privasi). Teks ringkas, jujur soal pihak ketiga & hak hapus. */
export function privacyPageHtml() {
  return shell('Kebijakan Privasi — Adhitron', `
<h1>Kebijakan Privasi</h1>
<p class="lead">Berlaku untuk situs Adhitron Web. Ringkas dan apa adanya.</p>
<h2>Data yang kami simpan</h2>
<p>Email, hash password, API key milikmu (terenkripsi <b>AES-256-GCM</b>), riwayat percakapan, pesan,
dan catatan pencarian saat fitur Browsing dipakai. API key hanya 4 karakter terakhirnya yang ditampilkan.</p>
<h2>Untuk apa</h2>
<p>Hanya untuk menjalankan akunmu: login, menyimpan provider, dan mengobrol. Kami tidak menjual data dan tidak
memasang pelacak iklan.</p>
<h2>Pihak ketiga</h2>
<p>Data disimpan di <b>Neon</b> (database) dan <b>Netlify</b> (hosting). Saat kamu mengobrol, isi pesan dikirim ke
<b>penyedia AI milikmu</b> untuk menghasilkan jawaban. Saat Browsing aktif, teks pencarian dikirim ke mesin
pencari (DuckDuckGo, atau Tavily/Brave bila diaktifkan operator).</p>
<h2>Catatan penting soal API key</h2>
<p>API key-mu dienkripsi dengan kunci operator. Artinya secara teknis operator situs dapat mendekripsinya;
kami berkomitmen tidak mengaksesnya kecuali untuk operasional yang kamu minta.</p>
<h2>Hakmu</h2>
<p>Kamu bisa <b>menghapus akun beserta seluruh datanya</b> kapan saja dari halaman Chat (⚙ / tombol Hapus akun).
Penghapusan bersifat permanen. Permintaan lain (akses, koreksi, ekspor) bisa dikirim ke kontak di bawah.</p>
<h2>Retensi</h2>
<p>Data disimpan selama akunmu aktif. Sesi kedaluwarsa dibersihkan berkala. Menghapus akun menghapus semuanya.</p>
<h2>Kontak</h2>
<p>Pertanyaan privasi: hubungi operator situs ini.</p>
<p class="muted"><a href="/">← Kembali ke portal</a></p>`);
}

/** Halaman syarat layanan (/syarat). */
export function termsPageHtml() {
  return shell('Syarat Layanan — Adhitron', `
<h1>Syarat Layanan</h1>
<p class="lead">Aturan memakai Adhitron Web (versi sederhana).</p>
<h2>Layanan ini apa</h2>
<p>Alat untuk mengobrol dengan AI memakai <b>API key milikmu sendiri</b>. Biaya & kuota pemakaian AI sepenuhnya
milikmu; situs hanya perantara.</p>
<h2>Tanggung jawabmu</h2>
<p>Jaga kerahasiaan password dan API key-mu. Jangan memakai layanan untuk hal melanggar hukum, menyebarkan
konten berbahaya, atau mengganggu layanan orang lain.</p>
<h2>Tanpa jaminan</h2>
<p>Layanan disediakan "apa adanya". Jawaban AI bisa salah — periksa sebelum dipakai. Kami tidak menjamin
layanan bebas gangguan.</p>
<h2>Perubahan</h2>
<p>Syarat bisa berubah; perubahan penting akan ditampilkan di situs.</p>
<p class="muted"><a href="/">← Kembali ke portal</a></p>`);
}

/** Router situs (portal + chat). Mengembalikan Response untuk path yang dikenal, atau null. */
export function handleSite(request, url = new URL(request.url)) {
  const path = url.pathname;
  if (path === '/' && request.method === 'GET') return html(portalPageHtml());
  if ((path === '/chat' || path === '/chat/') && request.method === 'GET') return html(chatPageHtml());
  if (path === '/chat/app.js' && request.method === 'GET') return js(chatAppJs());
  if ((path === '/privasi' || path === '/privasi/') && request.method === 'GET') return html(privacyPageHtml());
  if ((path === '/syarat' || path === '/syarat/') && request.method === 'GET') return html(termsPageHtml());
  return null;
}

const js = (body, status = 200) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
});

const html = (body, status = 200) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
});