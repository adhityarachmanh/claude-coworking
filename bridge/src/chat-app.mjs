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
  clearAttach();
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
    const atts = m.meta && Array.isArray(m.meta.attachments) ? historyAttachments(m.meta.attachments) : '';
    return '<div class="turn ' + esc(m.role) + '" data-id="' + esc(m.id) + '"><div class="who">' + (m.role === 'user' ? 'Kamu' : 'Asisten') + '</div><div class="bubble">' + md(m.content || '') + atts + chips + '</div></div>';
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

/* ---------------------------------------------------------------- lampiran (📎) */
// Client side rules (kinds, limits, refusals). The server checks every upload again — this is only UX.
const ATT_LIMITS = { maxFiles: 10, imageBytes: Math.floor((5 * 1024 * 1024 * 3) / 4), textBytes: 200 * 1024, totalBytes: 3 * 1024 * 1024 };
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const TEXT_EXT = ['txt', 'text', 'log', 'out', 'err', 'md', 'markdown', 'mdx', 'rst', 'json', 'jsonc', 'json5', 'jsonl', 'ndjson',
  'csv', 'tsv', 'yaml', 'yml', 'xml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sql', 'graphql', 'diff', 'patch',
  'html', 'htm', 'css', 'scss', 'svg', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'dart', 'lua', 'pl', 'r', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'];
const TEXT_NAMES = ['dockerfile', 'makefile', 'readme', 'license', 'changelog', 'codeowners', '.gitignore', '.env'];
const TEXT_MIME = /^(text\/|application\/(json|ld\+json|xml|x-yaml|yaml|sql|javascript|x-javascript|typescript|x-sh|toml|x-ndjson|graphql)$)/;
// Pending files: [{ kind, name, size, mediaType, data(base64), url? }]
let ATTACH = [];
let readingAtt = Promise.resolve();

function attExt(name) {
  const b = String(name || '').toLowerCase();
  const d = b.lastIndexOf('.');
  return d > 0 ? b.slice(d + 1) : '';
}
/** 'image' | 'text' | null (extension first, then MIME). */
function attachmentKind(name, mediaType) {
  const base = String(name || '').toLowerCase();
  const ext = attExt(base);
  const type = String(mediaType || '').toLowerCase();
  if (IMAGE_EXT.indexOf(ext) >= 0) return 'image';
  if (TEXT_EXT.indexOf(ext) >= 0 || TEXT_NAMES.indexOf(base) >= 0 || /\.log(\.|$)/.test(base)) return 'text';
  if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return 'image';
  if (TEXT_MIME.test(type)) return 'text';
  return null;
}
function fmtSize(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}
/** Name safe to show and to send: no folders, no control/bidi characters, at most 100 chars. */
function safeName(name) {
  let base = String(name || '').split(/[\\/]/).pop();
  base = base.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  base = base.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"<>\x60|?*:]/g, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\.+$/, '');
  const chars = Array.from(base);
  if (chars.length > 100) {
    const ext = attExt(base);
    const keep = ext && ext.length < 12 ? '.' + ext : '';
    base = chars.slice(0, 100 - Array.from(keep).length - 1).join('') + '…' + keep;
  }
  return base || 'lampiran';
}
/** Image type from magic bytes only (the declared MIME is never trusted). */
function imageMagic(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
/** Base64 of raw bytes (never btoa on a unicode string). */
function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** UTF-8/UTF-16 text, or null when the bytes are binary. */
function decodeText(bytes) {
  try {
    let text;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    else text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.indexOf('\u0000') >= 0 ? null : text;
  } catch { return null; }
}
function attError(msg) {
  const h = $('hint');
  h.textContent = '⚠ ' + msg;
  h.className = 'hint bad';
}
function chipHtml(a, i) {
  const icon = a.kind === 'image' && a.url
    ? '<span class="thumb"><img src="' + esc(a.url) + '" alt=""></span>'
    : '<span class="thumb" aria-hidden="true">📄</span>';
  const rm = i === null || i === undefined ? '' : '<button type="button" class="rm" data-i="' + i + '" title="Hapus" aria-label="Hapus lampiran ' + esc(a.name) + '">×</button>';
  return '<span class="chip-att" title="' + esc(a.name) + '">' + icon
    + '<span class="name">' + esc(a.name) + '</span><span class="size">' + fmtSize(a.size) + '</span>' + rm + '</span>';
}
function renderAttach() {
  const box = $('attachments');
  box.hidden = !ATTACH.length;
  box.innerHTML = ATTACH.map((a, i) => chipHtml(a, i)).join('');
}
function clearAttach() { ATTACH = []; renderAttach(); }
/** Chips of a message's stored attachments (name + size only, no body). */
function historyAttachments(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const chips = list
    .filter((a) => a && typeof a === 'object')
    .map((a) => chipHtml({ kind: a.kind === 'image' ? 'image' : 'text', name: safeName(a.name), size: a.size }, null));
  return chips.length ? '<div class="msg-attachments">' + chips.join('') + '</div>' : '';
}
function totalAttach() { return ATTACH.reduce((sum, a) => sum + (a.size || 0), 0); }

/** Reads picked/dropped/pasted files one by one so the totals are checked in order. */
function addFiles(files) {
  const list = files ? [].slice.call(files) : [];
  if (!list.length) return readingAtt;
  readingAtt = readingAtt.then(async () => {
    for (const file of list) {
      const name = safeName(file.name);
      const kind = attachmentKind(name, file.type);
      if (!kind) { attError(name + ': jenis file tidak didukung. Lampirkan gambar (PNG/JPEG/GIF/WebP) atau file teks (log, kode, md, json, csv, …).'); continue; }
      const size = file.size || 0;
      if (!size) { attError(name + ' kosong.'); continue; }
      if (kind === 'image' && size > ATT_LIMITS.imageBytes) { attError(name + ' lebih dari ' + fmtSize(ATT_LIMITS.imageBytes) + '.'); continue; }
      if (kind === 'text' && size > ATT_LIMITS.textBytes) { attError(name + ' lebih dari ' + fmtSize(ATT_LIMITS.textBytes) + '.'); continue; }
      if (ATTACH.length >= ATT_LIMITS.maxFiles) { attError('Maksimal ' + ATT_LIMITS.maxFiles + ' lampiran per pesan.'); break; }
      if (totalAttach() + size > ATT_LIMITS.totalBytes) { attError('Total lampiran lebih dari ' + fmtSize(ATT_LIMITS.totalBytes) + '.'); continue; }
      let bytes;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { attError(name + ' tidak bisa dibaca.'); continue; }
      if (kind === 'image') {
        const type = imageMagic(bytes);
        if (!type) { attError(name + ' bukan gambar PNG/JPEG/GIF/WebP yang valid.'); continue; }
        const data = toBase64(bytes);
        ATTACH.push({ kind: 'image', name, size, mediaType: type, data, url: 'data:' + type + ';base64,' + data });
      } else {
        if (decodeText(bytes) === null) { attError(name + ' bukan file teks (UTF-8).'); continue; }
        ATTACH.push({ kind: 'text', name, size, mediaType: 'text/plain', data: toBase64(bytes) });
      }
      renderAttach();
    }
  });
  return readingAtt;
}

$('btn-attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('attachments').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  ATTACH.splice(Number(b.dataset.i), 1);
  renderAttach();
});
// Paste an image from the clipboard (text paste stays a normal paste).
$('input').addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files ? [].slice.call(e.clipboardData.files) : [];
  if (!files.length || (e.clipboardData.getData && e.clipboardData.getData('text/plain'))) return;
  e.preventDefault();
  addFiles(files);
});
// Drag & drop over the composer box.
const composerEl = $('composer');
composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('drop'); });
composerEl.addEventListener('dragleave', (e) => { if (!composerEl.contains(e.relatedTarget)) composerEl.classList.remove('drop'); });
composerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  composerEl.classList.remove('drop');
  if (e.dataTransfer) addFiles(e.dataTransfer.files);
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
  $('hint').className = 'hint';
  $('hint').innerHTML = on ? '<span class="spin"></span> Asisten menulis…' : '';
}
function stop() { if (CONTROLLER) CONTROLLER.abort(); }

async function sendMsg() {
  if (!CONV) { alert('Buat atau buka percakapan dulu.'); return; }
  const text = $('input').value.trim();
  if (!text && !ATTACH.length) return;
  $('input').value = ''; $('input').style.height = 'auto';
  if ($('thread').querySelector('.empty')) $('thread').innerHTML = '';
  appendTurn('user', text, ATTACH.map((a) => ({ kind: a.kind, name: a.name, size: a.size })));
  const sent = ATTACH.slice();
  clearAttach();
  const asst = appendTurn('assistant', '');
  scrollBottom();
  setSending(true);
  CONTROLLER = new AbortController();
  let finished = false;
  try {
    const res = await fetch('/chat/api/conversations/' + CONV.id + '/messages', {
      method: 'POST', credentials: 'same-origin', signal: CONTROLLER.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachments: sent.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data })) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      asst.bubble.innerHTML = '<span class="msg bad">' + esc(err.error || 'Gagal mengirim') + '</span>';
      // The message never left: put the files back (ATTACH was cleared before sending) so they can be retried.
      ATTACH = sent;
      renderAttach();
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
function appendTurn(role, text, atts) {
  const el = document.createElement('div');
  el.className = 'turn ' + role;
  const attHtml = historyAttachments(atts);
  el.innerHTML = '<div class="who">' + (role === 'user' ? 'Kamu' : 'Asisten') + '</div><div class="bubble">' + (text ? md(text) : '<span class="muted"><span class="spin"></span> …</span>') + attHtml + '</div>';
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