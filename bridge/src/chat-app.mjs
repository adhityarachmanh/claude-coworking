// bridge/src/chat-app.mjs — perangkat lunak sisi klien halaman /chat (M7). Berkas ini di-serve sebagai
// /chat/app.js; hanya memakai API publik /chat/api/* dan stream SSE dari /chat/api/conversations/:id/messages.
// Ditulis sebagai string (bukan modul Node) supaya bisa diuji: `chatAppJs()` harus valid syntax.
//
// Fitur: masuk/daftar, sidebar riwayat (buat/buka/hapus), thread dengan streaming + Stop, markdown ringan,
// chip sumber bernomor yang bisa diklik, pilih Model & Effort + Auto, toggle Browsing, dan panel Provider.

export function chatAppJs() { return APP; }

/** Skrip halaman masuk/daftar (/chat/auth.js): satu form per halaman, tanpa jalur auth di sisi klien chat. */
export function authJs() { return AUTH; }

const AUTH = String.raw`
'use strict';
const form = document.getElementById('authform');
const out = document.getElementById('authout');
const show = (text, kind) => { out.textContent = text || ''; out.className = 'msg' + (kind ? ' ' + kind : ''); out.hidden = !text; };
const peek = document.getElementById('peek');
if (peek) peek.addEventListener('click', () => {
  const p = document.getElementById('password');
  const on = p.type === 'password';
  p.type = on ? 'text' : 'password';
  peek.textContent = on ? 'Sembunyikan' : 'Lihat';
  peek.setAttribute('aria-label', on ? 'Sembunyikan password' : 'Tampilkan password');
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const action = form.dataset.action;
  show('Memproses…');
  form.querySelector('button[type=submit]').disabled = true;
  try {
    const r = await fetch('/chat/api/auth/' + action, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: f.get('email'), password: f.get('password'), consent: form.querySelector('#consent') ? f.get('consent') === 'on' : undefined }),
    });
    const data = await r.json().catch(() => null);
    if (r.ok) { location.href = '/chat'; return; }
    show((data && data.error) || 'Gagal, coba lagi', 'bad');
  } catch { show('Tidak bisa menghubungi server', 'bad'); }
  form.querySelector('button[type=submit]').disabled = false;
});
`;

const APP = String.raw`
'use strict';
const $ = (id) => document.getElementById(id);
const API = '/chat/api';
let ME = null, CONVS = [], CONV = null, CATALOG = { kinds: [] }, PROVIDERS = [], CONTROLLER = null, SENDING = false;

/* ---------------------------------------------------------------- utils */
async function call(path, opts = {}) {
  const r = await fetch(API + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null; try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}
function provMsg(text, kind) {
  const el = $('provmsg'); el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); el.hidden = !text;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* Markdown ringan: escape dulu, lalu code fence, inline code, tebal, tautan, judul, daftar, paragraf. */
function md(text) {
  const blocks = [];
  let t = esc(text).replace(/\r\n/g, '\n');
  t = t.replace(/\n\x60\x60\x60([\s\S]*?)\x60\x60\x60\n/g, (_, code) => { blocks.push(code.replace(/^\n+|\n+$/g, '')); return '\u0000BLOCK' + (blocks.length - 1) + '\u0000'; });
  t = t.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/\[(\d+)\]/g, '<b class="cite" data-cite="$1">[$1]</b>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.split(/\n{2,}/).map((p) => {
    const lines = p.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return '<ul>' + lines.map((l) => '<li>' + l.replace(/^\s*[-*]\s+/, '') + '</li>').join('') + '</ul>';
    if (lines.every((l) => /^#{1,6}\s+/.test(l))) return lines.map((l) => '<b>' + l.replace(/^#{1,6}\s+/, '') + '</b>').join('<br>');
    return '<p>' + lines.join('<br>') + '</p>';
  }).join('');
  t = t.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => '<pre><code>' + blocks[Number(i)] + '</code></pre>');
  return t;
}

/* ---------------------------------------------------------------- sesi */
async function refresh() {
  const { ok, data } = await call('/me');
  if (!ok) { location.href = '/auth/login?expired=1'; return; }
  ME = data.user; showApp();
}
async function showApp() {
  $('who').textContent = 'masuk sebagai ' + ME.email;
  await loadCatalog(); await loadProviders(); await loadConvs();
  if (!CONV) renderEmpty();
}
$('logout').addEventListener('click', async () => { await call('/auth/logout', { method: 'POST' }); location.href = '/auth/login'; });
$('delacct').addEventListener('click', async () => {
  if (!confirm('Hapus akun beserta SELURUH data (percakapan, provider, API key)? Tindakan ini permanen.')) return;
  if (!confirm('Yakin? Data tidak bisa dikembalikan.')) return;
  const { ok, data } = await call('/me', { method: 'DELETE' });
  if (ok) { alert('Akun dihapus.'); location.href = '/auth/login'; } else alert((data && data.error) || 'Gagal menghapus akun');
});

/* ---------------------------------------------------------------- katalog, provider */
async function loadCatalog() {
  const { ok, data } = await call('/provider-kinds');
  if (ok) { CATALOG = data; $('pkind').innerHTML = data.kinds.map((k) => '<option value="' + esc(k.kind) + '">' + esc(k.label) + '</option>').join(''); }
}
async function loadProviders() {
  const { ok, data } = await call('/providers');
  PROVIDERS = ok ? data.providers : [];
  $('provlist').innerHTML = PROVIDERS.length
    ? PROVIDERS.map((p) => '<div class="prov"><div class="meta"><b>' + esc(p.label) + '</b><span>' + esc(p.kind) + (p.keyHint ? ' · …' + esc(p.keyHint) : '') + (p.models && p.models.length ? ' · ' + p.models.length + ' model' : '') + '</span></div><div class="acts"><button class="mini" data-test="' + esc(p.id) + '">Uji &amp; muat model</button><button class="mini danger" data-del="' + esc(p.id) + '">Hapus</button></div></div>').join('')
    : '<p class="muted">Belum ada provider. Tambahkan API key milikmu di bawah.</p>';
  renderModelOptions();
}
$('settings').addEventListener('click', () => { closeSide(); $('prov').hidden = false; });
$('provclose').addEventListener('click', () => { $('prov').hidden = true; });
$('prov').addEventListener('click', (e) => { if (e.target === $('prov')) $('prov').hidden = true; });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('prov').hidden) $('prov').hidden = true;
  else if ($('side').classList.contains('open')) { closeSide(); $('menu').focus(); }
});

/* muat & pilih model hasil "cek key" (checklist, semua tercentang, ada pencarian) */
let FOUND = [];
function renderModels() {
  const q = ($('mlfilter').value || '').toLowerCase();
  const items = FOUND.filter((m) => !q || m.id.toLowerCase().includes(q) || String(m.label).toLowerCase().includes(q));
  $('ml-items').innerHTML = items.map((m) => '<li><label><input type="checkbox" value="' + esc(m.id) + '"' + (m.checked ? ' checked' : '') + '><span>' + esc(m.label || m.id) + '</span></label></li>').join('')
    || '<li class="muted">Tidak ada model cocok.</li>';
  $('ml-count').textContent = FOUND.filter((m) => m.checked).length + ' / ' + FOUND.length + ' model dipilih';
}
function setModels(list) {
  FOUND = (list || []).map((m) => ({ id: m.id, label: m.label || m.id, checked: m.checked !== false }));
  $('modellist').hidden = !FOUND.length;
  if (FOUND.length) renderModels(); else $('ml-count').textContent = '0 model';
}
$('probe').addEventListener('click', async () => {
  const f = new FormData($('provform'));
  const kind = f.get('kind'), apiKey = String(f.get('apiKey') || '').trim();
  if (!apiKey) { provMsg('Isi API key dulu.', 'bad'); return; }
  provMsg('Menghubungi provider…');
  const { ok, data } = await call('/providers/models', { method: 'POST', body: JSON.stringify({ kind, apiKey, baseUrl: f.get('baseUrl') }) });
  if (!ok) { provMsg('❌ ' + ((data && data.error) || 'Gagal'), 'bad'); setModels([]); return; }
  setModels(data.models);
  provMsg('✅ Key berlaku. ' + data.models.length + ' model dimuat — pilih yang ingin dipakai.');
});
$('mlfilter').addEventListener('input', renderModels);
$('ml-all').addEventListener('click', () => { FOUND.forEach((m) => { m.checked = true; }); renderModels(); });
$('ml-none').addEventListener('click', () => { FOUND.forEach((m) => { m.checked = false; }); renderModels(); });
$('ml-items').addEventListener('change', (e) => {
  const box = e.target.closest('input[type=checkbox]'); if (!box) return;
  const m = FOUND.find((x) => x.id === box.value); if (m) m.checked = box.checked;
  $('ml-count').textContent = FOUND.filter((x) => x.checked).length + ' / ' + FOUND.length + ' model dipilih';
});
$('provform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData($('provform')); provMsg('Menyimpan…');
  const body = { kind: f.get('kind'), label: f.get('label'), apiKey: f.get('apiKey'), baseUrl: f.get('baseUrl') };
  if (FOUND.length) body.models = FOUND.filter((m) => m.checked).map((m) => ({ id: m.id, label: m.label }));
  const { ok, data } = await call('/providers', { method: 'POST', body: JSON.stringify(body) });
  if (ok) { $('provform').reset(); setModels([]); provMsg(''); await loadProviders(); }
  else provMsg((data && data.error) || 'Gagal menyimpan', 'bad');
});
$('provlist').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-test]'), d = e.target.closest('[data-del]');
  if (t) {
    provMsg('Menguji & memuat model…');
    const { ok, data } = await call('/providers/' + t.dataset.test + '/test', { method: 'POST' });
    if (ok) { await loadProviders(); provMsg('✅ Key berlaku. ' + ((data.models && data.models.length) || 0) + ' model dimuat.'); renderModelOptions(); }
    else provMsg('❌ ' + ((data && data.error) || 'Gagal'), 'bad');
  }
  if (d && confirm('Hapus provider ini beserta API key-nya?')) {
    await call('/providers/' + d.dataset.del, { method: 'DELETE' });
    await loadProviders();
  }
});

/* ---------------------------------------------------------------- model & effort */
const EFFORTS = [['default', 'Effort: Default'], ['low', 'Effort: Low'], ['medium', 'Effort: Medium'], ['high', 'Effort: High'], ['xhigh', 'Effort: X-High'], ['max', 'Effort: Max']];
function currentKind() {
  const p = PROVIDERS.find((x) => x.id === (CONV && CONV.providerId)) || PROVIDERS[0];
  return p ? p.kind : (CATALOG.kinds[0] ? CATALOG.kinds[0].kind : null);
}
function renderModelOptions() {
  if (!CONV) return;
  const kind = currentKind();
  const prov = PROVIDERS.find((x) => x.id === (CONV && CONV.providerId)) || PROVIDERS[0];
  const custom = prov && Array.isArray(prov.models) ? prov.models : null;
  const block = (CATALOG.kinds || []).find((k) => k.kind === kind);
  const models = custom && custom.length ? custom
    : (block ? block.models : []);
  $('model').innerHTML = models.map((m) => '<option value="' + esc(m.id) + '">' + esc(m.label || m.id) + '</option>').join('');
  $('effort').innerHTML = EFFORTS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  if (CONV.model) $('model').value = CONV.model;
  if (CONV.effort) $('effort').value = CONV.effort;
  $('auto').checked = !!CONV.modelAuto || !!CONV.effortAuto;
  $('browsing').checked = !!CONV.browsing;
}
function patchConv(patch) {
  if (!CONV) return;
  Object.assign(CONV, patch);
  return call('/conversations/' + CONV.id, { method: 'PATCH', body: JSON.stringify(patch) });
}
$('model').addEventListener('change', () => patchConv({ model: $('model').value }));
$('effort').addEventListener('change', () => patchConv({ effort: $('effort').value }));
$('auto').addEventListener('change', () => patchConv({ modelAuto: $('auto').checked, effortAuto: $('auto').checked }));
$('browsing').addEventListener('change', () => patchConv({ browsing: $('browsing').checked }));

/* ---------------------------------------------------------------- daftar percakapan */
async function loadConvs() {
  const { ok, data } = await call('/conversations');
  CONVS = ok ? data.conversations : [];
  renderConvs();
}
function renderConvs() {
  $('convs').innerHTML = CONVS.map((c) => '<li><button class="conv' + (CONV && c.id === CONV.id ? ' active' : '') + '" data-open="' + esc(c.id) + '"><span class="t">' + esc(c.title) + '</span></button></li>').join('');
}
$('convs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]'); if (b) openConv(b.dataset.open);
});
$('newconv').addEventListener('click', async () => {
  if (!PROVIDERS.length) { $('prov').hidden = false; provMsg('Tambahkan provider dulu.'); return; }
  const { ok, data } = await call('/conversations', { method: 'POST', body: JSON.stringify({ providerId: PROVIDERS[0].id }) });
  if (ok) { CONVS.unshift(data.conversation); openConv(data.conversation.id); closeSide(); }
});
$('menu').addEventListener('click', () => { const s = $('side'); s.classList.toggle('open'); if (s.classList.contains('open')) { s.setAttribute('aria-hidden', 'false'); } else { s.removeAttribute('aria-hidden'); } });
function closeSide() { const s = $('side'); s.classList.remove('open'); s.removeAttribute('aria-hidden'); }

function setConv(c) {
  CONV = c;
  $('ttl').textContent = c.title || 'Percakapan baru';
  renderConvs(); renderModelOptions(); renderCtx();
}

/** Ringkas konteks percakapan di header: model · effort · browsing. */
function renderCtx() {
  if (!CONV) { $('ctx').textContent = ''; return; }
  const prov = PROVIDERS.find((x) => x.id === CONV.providerId) || PROVIDERS[0];
  const modelOpt = $('model').selectedOptions[0];
  const modelLabel = modelOpt ? modelOpt.textContent : (CONV.model || '');
  const bits = [];
  if (prov) bits.push(prov.label);
  if (modelLabel && (!CONV.modelAuto && !CONV.effortAuto)) bits.push(modelLabel);
  if (CONV.modelAuto || CONV.effortAuto) bits.push('Auto');
  if (CONV.browsing) bits.push('🔎 Browsing');
  $('ctx').textContent = bits.join(' · ');
}
$('model').addEventListener('change', renderCtx);
$('effort').addEventListener('change', renderCtx);
$('auto').addEventListener('change', renderCtx);
$('browsing').addEventListener('change', renderCtx);

/* ---------------------------------------------------------------- thread */
async function openConv(id) {
  const { ok, data } = await call('/conversations/' + id);
  if (!ok) return;
  setConv(data.conversation);
  renderThread(data.messages, data.citations);
  closeSide();
  scrollBottom();
}
function renderThread(messages, citations) {
  if (!messages || !messages.length) { renderEmpty(); return; }
  const byMsg = {};
  for (const c of citations || []) (byMsg[c.messageId] = byMsg[c.messageId] || []).push(c);
  $('thread').innerHTML = messages.map((m) => {
    const cites = byMsg[m.id] || [];
    const chips = cites.length ? '<div class="chips">' + cites.map((c) => '<a class="chip" href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer"><b>[' + c.idx + ']</b> ' + esc(c.title || c.url) + '</a>').join('') + '</div>' : '';
    return '<div class="turn ' + esc(m.role) + '" data-id="' + esc(m.id) + '"><div class="who">' + (m.role === 'user' ? 'Kamu' : 'Asisten') + '</div><div class="bubble">' + md(m.content || '') + chips + '</div></div>';
  }).join('');
}
function scrollBottom() { const t = $('thread'); t.scrollTop = t.scrollHeight; }

/** Empty state thread: sambutan + saran prompt yang mengisi composer saat diklik. */
function renderEmpty() {
  $('thread').innerHTML =
    '<div class="empty">'
    + '<div class="empty-ico" aria-hidden="true">💬</div>'
    + '<h2>Mulai mengobrol</h2>'
    + '<p class="muted">Pilih provider &amp; model di bawah, lalu kirim pesan. Tempel API key milikmu di ⚙ provider.</p>'
    + '<div class="empty-sug" role="list">'
    + '<button type="button" class="sug" data-sug="Jelaskan dengan sederhana: ">Jelaskan konsep ini dengan sederhana…</button>'
    + '<button type="button" class="sug" data-sug="Buat ringkasan dari: ">Buat ringkasan dari…</button>'
    + '<button type="button" class="sug" data-sug="Bantu saya membuat rencana untuk: ">Bantu saya membuat rencana…</button>'
    + '</div></div>';
}
$('thread').addEventListener('click', (e) => {
  const s = e.target.closest('.sug'); if (!s) return;
  $('input').value = s.dataset.sug; $('input').focus();
  $('input').dispatchEvent(new Event('input'));
});

/* ---------------------------------------------------------------- kirim + streaming */
$('composer').addEventListener('submit', (e) => { e.preventDefault(); SENDING ? stop() : sendMsg(); });
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!SENDING) sendMsg(); } });
$('input').addEventListener('input', () => { const el = $('input'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; });

function setSending(on) {
  SENDING = on;
  const b = $('send');
  b.classList.toggle('stop', on);
  b.textContent = on ? '■' : '➤';
  b.title = on ? 'Stop' : 'Kirim';
  $('hint').innerHTML = on ? '<span class="spin"></span> Asisten menulis…' : '';
}
function stop() { if (CONTROLLER) CONTROLLER.abort(); }

async function sendMsg() {
  if (!CONV) { alert('Buat atau buka percakapan dulu.'); return; }
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = ''; $('input').style.height = 'auto';
  if ($('thread').querySelector('.empty')) $('thread').innerHTML = '';
  appendTurn('user', text);
  const asst = appendTurn('assistant', '');
  scrollBottom();
  setSending(true);
  CONTROLLER = new AbortController();
  let finished = false;
  try {
    const res = await fetch('/chat/api/conversations/' + CONV.id + '/messages', {
      method: 'POST', credentials: 'same-origin', signal: CONTROLLER.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      asst.bubble.innerHTML = '<span class="msg bad">' + esc(err.error || 'Gagal mengirim') + '</span>';
      finished = true; return;
    }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let acc = ''; let cites = [];
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!block.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(block.slice(5).trim()); } catch { continue; }
        if (ev.type === 'text') { acc += ev.text; asst.bubble.innerHTML = md(acc) + chipsHtml(cites); scrollBottom(); }
        else if (ev.type === 'sources') { cites = ev.sources; asst.bubble.innerHTML = md(acc) + chipsHtml(cites); }
        else if (ev.type === 'notice') { asst.bubble.innerHTML = '<span class="muted">' + esc(ev.notice) + '</span>' + md(acc) + chipsHtml(cites); }
        else if (ev.type === 'meta') { asst.bubble.innerHTML = (acc ? md(acc) : '<span class="muted"><span class="spin"></span> …</span>') + chipsHtml(cites); }
        else if (ev.type === 'error') { asst.bubble.innerHTML = md(acc) + '<span class="msg bad">' + esc(ev.error) + '</span>' + chipsHtml(cites); finished = true; }
        else if (ev.type === 'done') { finished = true; asst.el.dataset.id = ev.messageId || ''; }
      }
    }
    if (!finished) asst.bubble.innerHTML = md(acc) + chipsHtml(cites);
  } catch (err) {
    if (err && err.name === 'AbortError') asst.bubble.innerHTML = md(acc) + '<span class="muted">(dihentikan)</span>' + chipsHtml(cites);
  } finally {
    CONTROLLER = null; setSending(false);
    loadConvs();
  }
}
function chipsHtml(cites) {
  if (!cites || !cites.length) return '';
  return '<div class="chips">' + cites.map((c, i) => '<a class="chip" href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer"><b>[' + (i + 1) + ']</b> ' + esc(c.title || c.url) + '</a>').join('') + '</div>';
}
function appendTurn(role, text) {
  const el = document.createElement('div');
  el.className = 'turn ' + role;
  el.innerHTML = '<div class="who">' + (role === 'user' ? 'Kamu' : 'Asisten') + '</div><div class="bubble">' + (text ? md(text) : '<span class="muted"><span class="spin"></span> …</span>') + '</div>';
  $('thread').appendChild(el);
  return { el, bubble: el.querySelector('.bubble') };
}

/* klik judul kutipan di dalam jawaban → buka sumber yang cocok (bila ada) */
$('thread').addEventListener('click', (e) => {
  const c = e.target.closest('.cite'); if (!c) return;
  const idx = Number(c.dataset.cite);
  const bubble = c.closest('.turn');
  const chip = bubble && bubble.querySelectorAll('.chip')[idx - 1];
  if (chip) window.open(chip.href, '_blank', 'noopener');
});

/* keyboard HP: ikat tinggi app ke visualViewport supaya composer tak tertutup */
(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const apply = () => root.style.setProperty('--vv-h', vv.height + 'px');
  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
})();

refresh();
`;