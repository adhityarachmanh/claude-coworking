// 📄 Lihat file: a read-only viewer for one text file of the active project (POST /api/projects/:id/file).
// Opened from a path in the chat (tool rows, paths in Claude's answers), the Changes tab, and openFile().
// Line numbers, light syntax highlight (the chat's own highlighter), search (Ctrl+F), copy, "Buka di VS Code"
// (laptop), `:line` to jump to and mark a line. File content is only ever inserted escaped, never as HTML.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { copyText, flashButton } from '../core/util.js';
import { highlight, renderMarkdown } from '../markdown.js';
import { openModal } from '../ui/modals.js';

const MAX_MARKED = 5000; // search hits marked in the text (the count still covers all of them)
const PLAIN = new Set(['text', 'md']); // no highlighter for prose

export const viewer = {
  project: null,
  path: null, // as asked for (relative or absolute); the server answers with the project-relative path
  outside: false, // an absolute path outside the project, confirmed by the user (laptop only)
  line: null,
  lineEnd: null,
  data: null, // the server's answer
  lines: [], // raw text per line
  html: [], // highlighted html per line
  hits: [], // line indexes matching the search
  marked: new Set(), // line indexes currently drawn with <mark>
  hit: -1,
  seq: 0, // bumped per open: a late answer for an earlier file is dropped
  searchTimer: null,
  mode: 'preview', // 👁 Pratinjau | ‹› Kode, for files that have a preview (previewKind)
};

// ---------- 👁 preview per file type ----------

/** What a file looks like rendered: md → Markdown, csv/tsv → table, json → formatted, svg/image → picture, html → page. */
export function previewKind(d) {
  if (!d) return null;
  if (d.image) return 'image';
  const ext = String(d.path ?? '').toLowerCase().split('.').pop();
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'csv' || ext === 'tsv') return 'table';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (ext === 'svg') return 'svg';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

/** RFC 4180-ish CSV (quotes, doubled quotes, newlines in quotes); `sep` is , or a tab. At most `max` rows. */
export function parseCsv(text, sep = ',', max = 1000) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= max) return { rows, more: true };
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return { rows, more: false };
}

function previewHtml(kind, d) {
  const text = String(d.content ?? '');
  switch (kind) {
    case 'image':
      return `<div class="fv-preview fv-img"><img src="data:${escapeHtml(d.image.mime)};base64,${d.image.data}" alt="${escapeHtml(d.path)}"></div>`;
    case 'svg':
      return `<div class="fv-preview fv-img"><img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}" alt="${escapeHtml(d.path)}"></div>`;
    case 'md':
      return `<div class="fv-preview md">${renderMarkdown(text)}</div>`; // the chat's renderer: HTML in the file stays escaped
    case 'html':
      // sandbox without allow-scripts: the page's own scripts, forms and navigation never run
      return `<div class="fv-preview"><iframe class="fv-frame" sandbox="" referrerpolicy="no-referrer" title="Pratinjau ${escapeHtml(d.path)}" srcdoc="${escapeHtml(text)}"></iframe></div>`;
    case 'json': {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return `<div class="fv-preview"><p class="fv-note warn">JSON tidak valid (mungkin JSONC dengan komentar): ditampilkan apa adanya.</p><pre class="fv-pre">${highlight(text, 'json')}</pre></div>`;
      }
      return `<div class="fv-preview"><pre class="fv-pre">${highlight(pretty, 'json')}</pre></div>`;
    }
    case 'table': {
      const { rows, more } = parseCsv(text, d.path.toLowerCase().endsWith('.tsv') ? '\t' : ',');
      if (!rows.length) return '<p class="muted fv-state">(file kosong)</p>';
      const [head, ...body] = rows;
      return `<div class="fv-preview fv-table-wrap"><table class="fv-table"><thead><tr>${head.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>${more ? '<p class="fv-note">Hanya 1000 baris pertama yang ditampilkan.</p>' : ''}</div>`;
    }
    default:
      return '';
  }
}

const isOpen = () => !$('#file-modal').hidden;

// ---------- paths in text ----------

// What looks like a project file: a known extension, optionally `:line` or `:line-line`.
const EXT = 'png|jpe?g|gif|webp|bmp|ico|avif|tsv|js|mjs|cjs|jsx|ts|tsx|mts|json|jsonc|md|css|scss|less|html|htm|vue|svelte|py|rb|php|java|kt|go|rs|c|h|cc|cpp|hpp|cs|swift|dart|lua|sh|bash|ps1|psm1|bat|cmd|sql|yml|yaml|toml|ini|xml|svg|txt|env|lock|gradle|properties|conf|cfg|csv|log|graphql|prisma|tf';
// In running text a path needs at least one folder (`src/x.js`), so plain words like "node.js" stay text.
// Absolute paths (C:\… or /home/…) are allowed too: chat links to screenshots/temp files live outside the project.
const TEXT_PATH = new RegExp(String.raw`(?<![\w@./\\:-])((?:[A-Za-z]:[\\/]|\/)?(?:\.{1,2}[\\/])?(?:[\w@.-]+[\\/])+[\w@.-]+\.(?:${EXT}))(?::(\d+)(?:[-–](\d+))?)?(?![\w/\\])`, 'gi');
// Inline `code` that is exactly a path may also be a bare file name (`server.js`, `package.json:12`).
const CODE_PATH = new RegExp(String.raw`^((?:[A-Za-z]:[\\/]|\/)?(?:\.{1,2}[\\/])?(?:[\w@.-]+[\\/])*[\w@.-]+\.(?:${EXT}))(?::(\d+)(?:[-–](\d+))?)?$`, 'i');

/** "src/app.js:120-130" → { path, line, lineEnd }. A Windows drive colon (C:\…) is part of the path. */
export function parseFileRef(ref) {
  const m = String(ref ?? '').trim().match(/^(.+?)(?::(\d+)(?:[-–](\d+))?)?$/);
  if (!m || /^[A-Za-z]$/.test(m[1])) return { path: String(ref ?? '').trim(), line: null, lineEnd: null };
  return { path: m[1], line: m[2] ? Number(m[2]) : null, lineEnd: m[3] ? Number(m[3]) : null };
}

/** A button that opens the viewer (escaped attributes; the label is given as html). */
export function fileLinkHtml(path, labelHtml, { line = null, title = 'Lihat isi file' } = {}) {
  return `<button type="button" class="file-link" data-file="${escapeHtml(path)}"${line ? ` data-line="${Number(line)}"` : ''} title="${escapeHtml(title)}">${labelHtml}</button>`;
}

/**
 * Turns paths in a rendered answer into viewer links: inline `code` that is a path, and folder/file.ext paths in
 * running text. Code blocks, links and buttons are left alone. Existence is checked when clicked (the viewer
 * says "tidak ditemukan"), so nothing is fetched while reading.
 */
export function linkifyPaths(root) {
  if (!root || state.active === DEMO_ID) return;
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a, button')) continue;
    const m = code.textContent.match(CODE_PATH);
    if (!m) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-link';
    btn.dataset.file = m[1];
    if (m[2]) btn.dataset.line = m[2];
    if (m[3]) btn.dataset.lineEnd = m[3];
    btn.title = 'Lihat isi file';
    code.replaceWith(btn);
    btn.append(code);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('pre, code, a, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts = [];
  while (walker.nextNode()) if (/[\\/]/.test(walker.currentNode.nodeValue)) texts.push(walker.currentNode);
  for (const node of texts) {
    const text = node.nodeValue;
    TEXT_PATH.lastIndex = 0;
    if (!TEXT_PATH.test(text)) continue;
    TEXT_PATH.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(TEXT_PATH)) {
      frag.append(text.slice(last, m.index));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'file-link';
      btn.dataset.file = m[1];
      if (m[2]) btn.dataset.line = m[2];
      if (m[3]) btn.dataset.lineEnd = m[3];
      btn.title = 'Lihat isi file';
      btn.textContent = m[0];
      frag.append(btn);
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

// ---------- open ----------

/** True for an absolute path that is not below the active project (Windows drive or POSIX root). */
function isOutsideProject(ref) {
  const project = state.projects.find((p) => p.id === state.active);
  const root = String(project?.path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  const target = String(ref ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  if (!root || !/^(?:[a-z]:\/|\/)/i.test(target)) return false;
  return target !== root && !target.startsWith(`${root}/`);
}

/** Opens `ref` ("src/x.js", "src/x.js:120", an absolute path inside the project) in the viewer. */
export async function openFile(ref, { line = null, lineEnd = null } = {}) {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu untuk melihat file.');
  const parsed = parseFileRef(ref);
  if (!parsed.path) return toast('Pilih file dulu.');
  const outside = isOutsideProject(parsed.path);
  if (outside) {
    const ok = window.confirm(`File ini di luar folder project:\n${parsed.path}\n\nBuka read-only? Hanya path di folder Temp, Desktop, Documents, Downloads, atau Pictures yang diizinkan.`);
    if (!ok) return;
  }
  Object.assign(viewer, { project: state.active, path: parsed.path, outside, line: line ?? parsed.line, lineEnd: lineEnd ?? parsed.lineEnd, data: null, lines: [], html: [], hits: [], hit: -1 });
  viewer.mode = viewer.line ? 'code' : 'preview'; // a `:line` link wants the line marked in the code
  viewer.marked.clear();
  const seq = ++viewer.seq;
  renderHead();
  $('#fv-q').value = '';
  $('#fv-count').textContent = '';
  $('#fv-body').innerHTML = '<p class="muted fv-state"><span class="spinner" aria-hidden="true"></span> Memuat file…</p>';
  openModal('file-modal');
  await load(seq, false);
}

async function load(seq, reveal) {
  let data;
  try {
    data = await api(`/api/projects/${viewer.project}/file`, { path: viewer.path, ...(viewer.outside ? { outside: true } : {}), ...(reveal ? { reveal: true } : {}) });
  } catch (err) {
    if (seq !== viewer.seq) return;
    $('#fv-body').innerHTML = `<div class="state-error fv-state" role="alert">${escapeHtml(err.message)}</div>`;
    renderHead();
    return;
  }
  if (seq !== viewer.seq) return;
  viewer.data = data;
  renderHead();
  if (data.secret && data.content == null) return renderSecretGate();
  renderContent();
  focusScrollBox();
}

/** The scroll box (preview or code) gets focus, so PgUp/PgDn/Space/arrows scroll it right away. */
function focusScrollBox() {
  if (document.activeElement === $('#fv-q')) return; // never steal the search field
  $('#fv-body .fv-preview, #fv-code')?.focus({ preventScroll: true });
}

// ---------- rendering ----------

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} KB` : `${n} byte`);

function renderHead() {
  const d = viewer.data;
  const shown = (d?.path ?? viewer.path ?? '').replace(/\\/g, '/');
  const cut = shown.lastIndexOf('/');
  $('#fv-title').innerHTML = `<span aria-hidden="true">📄</span> <span class="fv-name">${escapeHtml(shown.slice(cut + 1) || 'Lihat file')}</span>${cut > 0 ? ` <span class="fv-dir">${escapeHtml(shown.slice(0, cut + 1))}</span>` : ''}`;
  const meta = d
    ? [
        fmtBytes(d.size),
        `diubah ${new Date(d.mtime).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        d.language && d.language !== 'text' ? d.language : '',
        viewer.lines.length ? `${viewer.lines.length.toLocaleString('id-ID')} baris` : '',
      ].filter(Boolean)
    : [];
  $('#fv-meta').textContent = meta.join(' · ');
  const hasText = Boolean(d && d.content != null);
  const kind = previewKind(d);
  const toggle = $('#fv-mode');
  toggle.hidden = !kind || kind === 'image' || (d?.secret && d.content == null);
  toggle.textContent = viewer.mode === 'preview' ? '‹› Kode' : '👁 Pratinjau';
  toggle.title = viewer.mode === 'preview' ? 'Lihat sumbernya (nomor baris, cari)' : `Lihat hasilnya (${{ md: 'Markdown', table: 'tabel', json: 'JSON rapi', svg: 'gambar', html: 'halaman' }[kind] ?? 'pratinjau'})`;
  $('#fv-copy').disabled = !hasText;
  $('#fv-q').disabled = !hasText;
  $('#fv-prev').disabled = $('#fv-next').disabled = !hasText;
  // The open route resolves paths inside the project: an outside file stays view-only here.
  $('#fv-open').disabled = !d || viewer.outside;
  $('#fv-open').title = viewer.outside ? 'Hanya file di dalam project yang bisa dibuka di VS Code' : 'Buka file ini di VS Code';
}

function renderSecretGate() {
  $('#fv-body').innerHTML = `<div class="fv-secret" role="alert">
    <p><b>⚠ File ini mungkin berisi rahasia</b> (kunci, token, kata sandi, kredensial).</p>
    <p class="muted small">Isinya tidak ditampilkan sebelum kamu konfirmasi. Pastikan layar tidak sedang dibagikan atau direkam.</p>
    <button type="button" class="danger" data-fv-reveal>Tampilkan isi</button>
  </div>`;
}

/** Highlighted html split into lines; a token spanning lines (block comment, template string) is closed and reopened. */
function splitHighlighted(html) {
  const lines = [];
  let open = '';
  let cur = '';
  for (const part of html.split(/(<span class="hl-\w">|<\/span>|\n)/)) {
    if (part === '\n') {
      lines.push(open ? `${cur}</span>` : cur);
      cur = open;
    } else if (part.startsWith('<span')) {
      open = part;
      cur += part;
    } else if (part === '</span>') {
      open = '';
      cur += part;
    } else cur += part;
  }
  lines.push(open ? `${cur}</span>` : cur);
  return lines;
}

function renderContent() {
  const d = viewer.data;
  const kind = previewKind(d);
  if (kind === 'image' || (kind && viewer.mode === 'preview')) {
    viewer.lines = d.content == null ? [] : String(d.content).replace(/\r\n?/g, '\n').split('\n');
    renderHead();
    const notes = d.truncated ? `<p class="fv-note">File besar: pratinjau dari ${fmtBytes(d.content.length)} pertama.</p>` : '';
    $('#fv-body').innerHTML = notes + previewHtml(kind, d);
    const box = $('#fv-body .fv-preview');
    if (box) {
      // its own scroll box (CSS): focusable and named, so the keyboard and screen readers reach it
      box.tabIndex = 0;
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', `Pratinjau ${d.path}`);
    }
    if (kind === 'md') linkifyPaths($('#fv-body .fv-preview')); // file links inside a README open here too
    return;
  }
  const text = String(d.content ?? '').replace(/\r\n?/g, '\n');
  viewer.lines = text.split('\n');
  if (viewer.lines.length > 1 && viewer.lines.at(-1) === '') viewer.lines.pop(); // the final newline is not a line
  viewer.html = PLAIN.has(d.language) ? viewer.lines.map(escapeHtml) : splitHighlighted(highlight(viewer.lines.join('\n'), d.language));
  renderHead();
  const width = String(viewer.lines.length).length;
  const rows = viewer.html.map((h, i) => `<div class="fv-l" data-n="${i + 1}"><span class="fv-n" aria-hidden="true">${i + 1}</span><code class="fv-t">${h || ' '}</code></div>`).join('');
  const notes = [
    d.truncated ? `<p class="fv-note">File besar: hanya ${fmtBytes(d.content.length)} pertama dari ${fmtBytes(d.size)} yang ditampilkan.</p>` : '',
    d.secret ? '<p class="fv-note warn">⚠ File ini mungkin berisi rahasia. Jangan bagikan layar ini.</p>' : '',
  ].join('');
  $('#fv-body').innerHTML = `${notes}<div id="fv-code" class="fv-code" style="--ln:${width}ch" tabindex="0" role="region" aria-label="Isi file ${escapeHtml(d.path)}">${rows || '<p class="muted fv-state">(file kosong)</p>'}</div>`;
  if (viewer.line) jumpTo(viewer.line, viewer.lineEnd);
}

const lineEl = (i) => $('#fv-code')?.children[i] ?? null;

/** Scrolls line `n` (1-based) to the middle and marks it (or n…end). */
function jumpTo(n, end = null) {
  const code = $('#fv-code');
  if (!code) return;
  code.querySelectorAll('.fv-l.target').forEach((el) => el.classList.remove('target'));
  const from = Math.min(Math.max(1, n), viewer.lines.length);
  const to = Math.min(Math.max(from, end ?? from), viewer.lines.length, from + 500);
  for (let i = from; i <= to; i++) lineEl(i - 1)?.classList.add('target');
  centerOn(lineEl(from - 1));
}

function centerOn(el) {
  const code = $('#fv-code');
  if (!el || !code) return;
  code.scrollTop = Math.max(0, el.offsetTop - code.clientHeight / 2 + el.offsetHeight / 2);
  code.scrollLeft = 0;
}

// ---------- search (Ctrl+F inside the dialog) ----------

function markLine(raw, q) {
  const lower = raw.toLowerCase();
  let out = '';
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    out += `${escapeHtml(raw.slice(at, i))}<mark>${escapeHtml(raw.slice(i, i + q.length))}</mark>`;
    at = i + q.length;
  }
  return out + escapeHtml(raw.slice(at));
}

function search() {
  clearTimeout(viewer.searchTimer);
  viewer.searchTimer = null;
  const q = $('#fv-q').value.toLowerCase();
  // Lines marked by the previous search go back to their highlighted form.
  for (const i of viewer.marked) {
    const el = lineEl(i);
    if (el) {
      el.lastElementChild.innerHTML = viewer.html[i] || ' ';
      el.classList.remove('hit', 'cur');
    }
  }
  viewer.marked.clear();
  viewer.hits = [];
  viewer.hit = -1;
  if (q) {
    viewer.lines.forEach((l, i) => l.toLowerCase().includes(q) && viewer.hits.push(i));
    for (const i of viewer.hits.slice(0, MAX_MARKED)) {
      const el = lineEl(i);
      if (!el) continue;
      el.lastElementChild.innerHTML = markLine(viewer.lines[i], q);
      el.classList.add('hit');
      viewer.marked.add(i);
    }
  }
  if (viewer.hits.length) step(0, true);
  else $('#fv-count').textContent = q ? 'tidak ada' : '';
}

/** Moves to the next (+1) / previous (-1) hit, wrapping around. */
function step(dir, absolute = false) {
  if (!viewer.hits.length) return;
  lineEl(viewer.hits[viewer.hit])?.classList.remove('cur');
  viewer.hit = absolute ? dir : (viewer.hit + dir + viewer.hits.length) % viewer.hits.length;
  const el = lineEl(viewer.hits[viewer.hit]);
  el?.classList.add('cur');
  centerOn(el);
  $('#fv-count').textContent = `${viewer.hit + 1}/${viewer.hits.length}`;
}

// ---------- wiring ----------

export function initFileViewer() {
  // Any [data-file] link in the app (chat rows, answers, Changes tab) opens the viewer.
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('[data-file]');
    if (!link) return;
    e.preventDefault();
    openFile(link.dataset.file, { line: Number(link.dataset.line) || null, lineEnd: Number(link.dataset.lineEnd) || null });
  });

  $('#fv-mode').addEventListener('click', () => {
    viewer.mode = viewer.mode === 'preview' ? 'code' : 'preview';
    if (viewer.data) renderContent();
    renderHead();
  });
  $('#fv-body').addEventListener('click', (e) => {
    if (!e.target.closest('[data-fv-reveal]')) return;
    $('#fv-body').innerHTML = '<p class="muted fv-state"><span class="spinner" aria-hidden="true"></span> Memuat file…</p>';
    load(viewer.seq, true);
  });

  // Searching needs the lines: a preview switches to the code first
  $('#fv-q').addEventListener('focus', () => {
    if (viewer.mode !== 'preview' || !previewKind(viewer.data) || previewKind(viewer.data) === 'image') return;
    viewer.mode = 'code';
    renderContent();
    renderHead();
  });
  $('#fv-q').addEventListener('input', () => {
    clearTimeout(viewer.searchTimer);
    viewer.searchTimer = setTimeout(search, 120);
  });
  $('#fv-q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Typed and Enter right away: run the pending search (lands on the first hit) instead of stepping past it.
    if (viewer.searchTimer) return search();
    step(e.shiftKey ? -1 : 1);
  });
  $('#fv-next').addEventListener('click', () => step(1));
  $('#fv-prev').addEventListener('click', () => step(-1));

  // Ctrl+F / ⌘F while the viewer is open searches the file, not the page.
  document.addEventListener('keydown', (e) => {
    if (!isOpen() || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f' || $('#fv-q').disabled) return;
    e.preventDefault();
    $('#fv-q').focus();
    $('#fv-q').select();
  });

  $('#fv-copy').addEventListener('click', async (e) => {
    if (viewer.data?.content == null) return;
    flashButton(e.currentTarget, (await copyText(viewer.data.content)) ? '✓ Disalin' : 'Gagal menyalin');
  });

  $('#fv-open').addEventListener('click', () => {
    const file = viewer.data?.path ?? viewer.path;
    api(`/api/projects/${viewer.project}/open`, { app: 'code', file, ...(viewer.line ? { line: viewer.line } : {}) })
      .then(() => toast('Membuka VS Code…', 'ok'))
      .catch((err) => toast(err.message));
  });

  // Closed: drop the (possibly large) content and any late answer.
  new MutationObserver(() => {
    if (isOpen()) return;
    viewer.seq++;
    clearTimeout(viewer.searchTimer);
    Object.assign(viewer, { data: null, lines: [], html: [], hits: [] });
    viewer.marked.clear();
    $('#fv-body').innerHTML = '';
  }).observe($('#file-modal'), { attributeFilter: ['hidden'] });
}
