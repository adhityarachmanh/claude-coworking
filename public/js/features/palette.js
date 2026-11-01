// Command palette (Ctrl+P / Ctrl+Shift+P, 🔎 in the top bar): one search box for every action — switch
// project, open a project file, run a slash command, open a dialog, switch theme / permission mode / model /
// effort, chat actions. Fuzzy match with highlighted letters, ↑↓ Enter Esc, recently used actions first.
// Prefixes narrow the list: `>` commands & actions, `@` files, `#` projects.
// Accessible as a combobox (the input) driving a listbox (aria-activedescendant); no focusable options.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { THEME_IDS, THEMES, theme } from '../office/themes.js';
import { closeModal, openModal } from '../ui/modals.js';
import { LOCAL_COMMANDS, localCommand } from './commands.js';
import { fillComposer } from './composer.js';
import { exportActiveSession, openSearch } from './conversations.js';
import { openFile } from './file-viewer.js';
import { openMcp } from './mcp.js';
import { openNotifySettings } from './notify.js';
import { openProjects, selectProject } from './picker.js';
import { openRewind } from './rewind.js';
import { openRoster } from './roster.js';
import { openSessions } from './sessions.js';
import { slashCatalog } from './suggest.js';
import { openTasks } from './tasks.js';
import { applyTheme } from './theme.js';
import { toggleVoice, voiceAvailable, voiceRecording } from './voice.js';

const RECENT_KEY = 'office.palette.recent';
const RECENT_MAX = 6;
const MAX_PER_GROUP = { project: 12, file: 12, command: 12 };
const MAX_ITEMS = 80;

// Group order (also the order with an empty query) and headers.
const GROUPS = [
  ['recent', 'Terakhir dipakai'],
  ['project', 'Project'],
  ['file', 'File'],
  ['chat', 'Chat'],
  ['dialog', 'Buka'],
  ['setting', 'Izin, model & effort'],
  ['theme', 'Tema'],
  ['command', 'Perintah'],
];
const GROUP_LABEL = Object.fromEntries(GROUPS);

const PREFIXES = {
  '>': { label: 'Perintah & aksi', groups: ['chat', 'dialog', 'setting', 'theme', 'command'] },
  '@': { label: 'File project', groups: ['file'] },
  '#': { label: 'Project', groups: ['project'] },
};

export const palette = { items: [], shown: [], cursor: 0, files: [], filesFor: null, fileSeq: 0, fileTimer: null, loadingFiles: false };

const isOpen = () => !$('#palette-modal').hidden;

// ---------- fuzzy match ----------

const isBoundary = (text, i) => i === 0 || /[\s/\\_\-.:·()[\]]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

/**
 * Scores `text` against `query` (case-insensitive): a contiguous hit beats scattered letters, word starts
 * and early hits score more. Returns null when the letters are not all there in order.
 * @returns {{ score: number, indices: number[] } | null}
 */
export function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const at = t.indexOf(q);
  if (at > -1) {
    const indices = Array.from({ length: q.length }, (_, k) => at + k);
    return { score: 1000 + (at === 0 ? 300 : 0) + (isBoundary(text, at) ? 200 : 0) - at * 2 - (t.length - q.length), indices };
  }
  // Scattered letters: greedy, but jump to the next word start when it still holds the letter.
  const indices = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    let i = t.indexOf(ch, from);
    if (i < 0) return null;
    for (let j = i; j > -1 && j < t.length; j = t.indexOf(ch, j + 1)) {
      if (isBoundary(text, j)) {
        i = j;
        break;
      }
      if (j - i > 24) break; // don't skip far ahead for a word start
    }
    const prev = indices.at(-1);
    score += 10 + (isBoundary(text, i) ? 25 : 0) + (prev !== undefined && i === prev + 1 ? 15 : 0) - Math.min(i - from, 20);
    indices.push(i);
    from = i + 1;
  }
  return { score: score - (t.length - indices.length) * 0.5, indices };
}

/** `text` escaped, with the matched letters wrapped in <mark>. */
function highlighted(text, indices) {
  if (!indices?.length) return escapeHtml(text);
  const hit = new Set(indices);
  let html = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    if (hit.has(i) !== open) {
      html += open ? '</mark>' : '<mark>';
      open = !open;
    }
    html += escapeHtml(text[i]);
  }
  return open ? `${html}</mark>` : html;
}

// ---------- recent actions ----------

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(id) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    // storage blocked: no history, the palette still works
  }
}

// ---------- the actions ----------

const click = (sel) => () => $(sel)?.click();

function fileItem(path) {
  const slash = path.lastIndexOf('/');
  return { id: `file:${path}`, group: 'file', icon: '📄', label: path, hint: slash > -1 ? path.slice(0, slash) : '', run: () => openFile(path), match: path };
}

/** Every action for the current state (built on open and on each keystroke: cheap, and never stale). */
function buildItems() {
  const ro = state.readOnly ? READ_ONLY_HINT : null;
  const isDemo = !state.active || state.active === DEMO_ID;
  const needProject = isDemo ? 'Pilih project dulu (bukan demo)' : null;
  const laptopOnly = state.local ? null : 'Hanya dari laptop';
  const st = state.statuses[state.active] ?? {};
  const items = [];
  const add = (item) => items.push({ hint: '', kbd: '', disabled: null, keywords: '', ...item });

  for (const p of state.projects) {
    add({
      id: `project:${p.id}`,
      group: 'project',
      icon: p.id === DEMO_ID ? '🎬' : p.sources?.includes('claude') ? '✳' : '▢',
      label: p.name,
      hint: p.id === state.active ? 'aktif' : (p.path ?? 'simulasi').replace(/^.*[\\/]projects[\\/]/, '…/'),
      keywords: p.path ?? '',
      run: () => selectProject(p.id),
    });
  }

  add({ id: 'chat:new', group: 'chat', icon: '＋', label: 'Sesi baru', hint: 'Mulai percakapan baru', kbd: '/clear', disabled: needProject ?? ro, keywords: 'new clear reset', run: () => localCommand('/clear') });
  add({ id: 'chat:stop', group: 'chat', icon: '■', label: 'Hentikan giliran', hint: 'Stop yang sedang berjalan', kbd: 'Esc', disabled: needProject ?? ro ?? (st.busy || st.queue ? null : 'Tidak ada yang sedang berjalan'), keywords: 'stop interrupt batal', run: click('#btn-stop') });
  add({ id: 'chat:export-session', group: 'chat', icon: '⬇', label: 'Export sesi ke Markdown (.md)', hint: 'Dari transcript Claude Code', kbd: '/export', disabled: needProject ?? (st.sessionId ? null : 'Belum ada sesi'), keywords: 'export download unduh markdown', run: () => exportActiveSession() });
  add({ id: 'chat:export-chat', group: 'chat', icon: '⬇', label: 'Export chat yang tampil (.md)', disabled: (state.chats[state.active] ?? []).length ? null : 'Belum ada percakapan', keywords: 'export download unduh', run: click('#more-menu [data-more="export"]') });
  add({ id: 'chat:search', group: 'chat', icon: '🔎', label: 'Cari percakapan', hint: 'Di semua sesi project', kbd: '/search', disabled: needProject, keywords: 'search find cari riwayat transcript', run: () => openSearch() });
  const noVoice = state.active === DEMO_ID ? 'Input suara tidak tersedia di demo' : !window.isSecureContext ? 'Butuh HTTPS atau localhost' : 'Browser ini tidak mendukung input suara';
  add({ id: 'chat:voice', group: 'chat', icon: '🎤', label: voiceRecording() ? 'Hentikan input suara' : 'Input suara', hint: 'Ketik dengan suara di kotak pesan', kbd: 'Alt M', disabled: state.active === DEMO_ID ? noVoice : (needProject ?? ro ?? (voiceAvailable() ? null : noVoice)), keywords: 'voice mic mikrofon suara dikte speech', run: () => toggleVoice() });

  const dialogs = [
    ['projects', '📁', 'Ganti project', 'Ctrl K', null, () => openProjects(), 'switch project picker'],
    ['sessions', '🕘', 'Riwayat sesi', '/resume', needProject, () => openSessions(), 'history resume lanjutkan'],
    ['tasks', '⧗', 'Tugas latar', '/tasks', needProject, () => openTasks(), 'background tasks agent'],
    ['rewind', '⏪', 'Rewind', 'Esc Esc', needProject, () => openRewind(), 'checkpoint undo kembalikan'],
    ['mcp', '🔌', 'Server MCP', '/mcp', needProject ?? ro, () => openMcp(), 'mcp server plugin'],
    ['templates', '⚡', 'Template prompt', '/t', needProject ?? ro, () => localCommand('/template'), 'template snippet'],
    ['roster', '👥', 'Kelola tim', '/team', null, () => openRoster(), 'team tim role roster anggota meja kelola'],
    ['settings', '⚙', 'Pengaturan', '', laptopOnly, click('#btn-settings'), 'settings config preferences'],
    ['notify', '🔔', 'Pengaturan notifikasi', '', null, () => openNotifySettings(), 'notification notifikasi suara sound jam tenang quiet volume favorit'],
    ['account', '👤', 'Akun Claude', '', null, click('#btn-account'), 'account login kuota quota'],
    ['report', '📊', 'Laporan penggunaan token', '', null, click('#btn-report'), 'report usage token pdf'],
    ['phone', '📱', 'Buka di HP', '', $('#btn-phone')?.hidden ? laptopOnly ?? 'Tidak tersedia' : null, click('#btn-phone'), 'phone mobile qr hp'],
    ['help', '❓', 'Bantuan & shortcut', '?', null, () => openModal('help-modal'), 'help shortcut panduan keyboard'],
  ];
  for (const [id, icon, label, kbd, disabled, run, keywords] of dialogs) add({ id: `dialog:${id}`, group: 'dialog', icon, label, kbd, disabled, run, keywords });

  // The composer's own selects: their options are the source of truth (the model list grows with the catalog).
  const selects = [
    ['mode', 'Izin', 'permission mode'],
    ['model', 'Model', 'model'],
    ['effort', 'Effort', 'effort thinking'],
  ];
  for (const [key, title, keywords] of selects) {
    const select = $(`#${key}`);
    if (!select) continue;
    for (const opt of select.options) {
      const current = select.value === opt.value;
      add({
        id: `setting:${key}:${opt.value}`,
        group: 'setting',
        icon: key === 'mode' ? '🛡' : key === 'model' ? '🧠' : '💭',
        label: `${title}: ${opt.textContent.trim()}`,
        hint: current ? 'aktif' : '',
        disabled: needProject ?? ro ?? (select.disabled ? 'Tidak tersedia untuk model ini' : null),
        keywords,
        run: () => {
          select.value = opt.value;
          select.dispatchEvent(new Event('change')); // the composer saves it, like picking it by hand
          toast(`${title}: ${opt.textContent.trim()}`, 'ok');
        },
      });
    }
  }

  for (const id of THEME_IDS) {
    add({ id: `theme:${id}`, group: 'theme', icon: THEMES[id].icon, label: `Tema: ${THEMES[id].label}`, hint: theme.current === id ? 'aktif' : '', keywords: 'theme tema', run: () => applyTheme(id) });
  }

  // Slash commands: the app's own run here; Claude Code's go into the composer to be sent.
  const local = new Set(LOCAL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  for (const c of slashCatalog()) {
    const own = local.has(c.name);
    add({
      id: `command:${c.name}`,
      group: 'command',
      icon: own ? '⌘' : '✳',
      label: `/${c.name}`,
      hint: c.description ?? (own ? '' : 'Perintah Claude Code'),
      kbd: own ? '' : 'ke kotak pesan',
      disabled: c.name === 'help' ? null : needProject ?? ro,
      keywords: c.aliases?.join(' ') ?? '',
      run: () => (own ? localCommand(`/${c.name}`) : fillComposer(`/${c.name} `)),
    });
  }

  for (const f of palette.filesFor === state.active ? palette.files : []) add(fileItem(f));
  return items;
}

// ---------- filtering & drawing ----------

function parseQuery(raw) {
  const prefix = PREFIXES[raw[0]] ? raw[0] : null;
  return { prefix, q: (prefix ? raw.slice(1) : raw).trim() };
}

function filterItems() {
  const { prefix, q } = parseQuery($('#palette-input').value);
  const allowed = prefix ? new Set(PREFIXES[prefix].groups) : null;
  const all = buildItems().filter((it) => !allowed || allowed.has(it.group));
  if (!q) {
    // Empty query: recently used first, then everything in group order.
    const byId = new Map(all.map((it) => [it.id, it]));
    const recent = prefix ? [] : readRecent().map((id) => byId.get(id) ?? (id.startsWith('file:') && !isDemo() ? fileItem(id.slice(5)) : null)).filter(Boolean);
    const recentIds = new Set(recent.map((it) => it.id));
    const rest = all.filter((it) => !recentIds.has(it.id));
    const counts = {};
    const capped = rest.filter((it) => (counts[it.group] = (counts[it.group] ?? 0) + 1) <= (MAX_PER_GROUP[it.group] ?? Infinity));
    return [...recent.map((it) => ({ ...it, shownIn: 'recent' })), ...capped].slice(0, MAX_ITEMS);
  }
  const scored = [];
  for (const it of all) {
    const m = fuzzyMatch(q, it.match ?? it.label);
    const k = m ? null : fuzzyMatch(q, `${it.hint} ${it.keywords}`);
    if (m) scored.push({ ...it, score: m.score + (it.disabled ? -50 : 0), indices: m.indices });
    // A contiguous hit in the hint/keywords only ("settings" → Pengaturan), always ranked below any hit in a name.
    else if (k && k.score > 900) scored.push({ ...it, score: k.score / 1000 - 1000, indices: [] });
  }
  // Groups ordered by their best hit, items by score inside a group.
  const best = {};
  for (const it of scored) best[it.group] = Math.max(best[it.group] ?? -Infinity, it.score);
  scored.sort((a, b) => best[b.group] - best[a.group] || (a.group === b.group ? b.score - a.score : a.group.localeCompare(b.group)));
  const counts = {};
  return scored.filter((it) => (counts[it.group] = (counts[it.group] ?? 0) + 1) <= (MAX_PER_GROUP[it.group] ?? 8)).slice(0, MAX_ITEMS);
}

const isDemo = () => !state.active || state.active === DEMO_ID;

function render() {
  const list = $('#palette-list');
  const input = $('#palette-input');
  palette.shown = filterItems();
  palette.cursor = Math.min(palette.cursor, Math.max(0, palette.shown.length - 1));
  const { prefix, q } = parseQuery(input.value);
  $('#palette-scope').textContent = prefix ? PREFIXES[prefix].label : '';
  $('#palette-scope').hidden = !prefix;
  if (!palette.shown.length) {
    const waiting = palette.loadingFiles && (!prefix || prefix === '@');
    list.innerHTML = `<div class="pal-empty" role="presentation">${waiting ? 'Mencari file…' : q ? `Tidak ada yang cocok dengan “${escapeHtml(q)}”.` : 'Tidak ada aksi di sini.'}</div>`;
    input.removeAttribute('aria-activedescendant');
    $('#palette-count').textContent = waiting ? '' : 'Tidak ada hasil';
    return;
  }
  let html = '';
  let group = null;
  palette.shown.forEach((it, i) => {
    const g = it.shownIn ?? it.group;
    if (g !== group) {
      if (group !== null) html += '</div>';
      html += `<div class="pal-group" role="group" aria-labelledby="pal-g-${g}"><div class="pal-group-head" id="pal-g-${g}" role="presentation">${escapeHtml(GROUP_LABEL[g])}</div>`;
      group = g;
    }
    const extra = it.disabled ? `<small class="pal-why">${escapeHtml(it.disabled)}</small>` : it.hint ? `<small>${escapeHtml(it.hint)}</small>` : '';
    html += `<div class="pal-opt ${i === palette.cursor ? 'active' : ''}" id="pal-opt-${i}" role="option" aria-selected="${i === palette.cursor}" ${it.disabled ? 'aria-disabled="true"' : ''} data-i="${i}">
      <span class="pal-ico" aria-hidden="true">${escapeHtml(it.icon)}</span>
      <span class="pal-text"><span class="pal-label">${highlighted(it.match ?? it.label, it.indices)}</span>${extra}</span>
      ${it.kbd ? `<kbd>${escapeHtml(it.kbd)}</kbd>` : ''}
    </div>`;
  });
  list.innerHTML = `${html}</div>`;
  input.setAttribute('aria-activedescendant', `pal-opt-${palette.cursor}`);
  $('#palette-count').textContent = `${palette.shown.length} hasil`;
  $('#palette-list .pal-opt.active')?.scrollIntoView({ block: 'nearest' });
}

function move(delta) {
  if (!palette.shown.length) return;
  palette.cursor = (palette.cursor + delta + palette.shown.length) % palette.shown.length;
  for (const el of document.querySelectorAll('#palette-list .pal-opt')) {
    const on = Number(el.dataset.i) === palette.cursor;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  }
  $('#palette-input').setAttribute('aria-activedescendant', `pal-opt-${palette.cursor}`);
  $('#palette-list .pal-opt.active')?.scrollIntoView({ block: 'nearest' });
}

// ---------- files (POST /api/projects/:id/files, the same index as @file in the composer) ----------

function queueFiles() {
  clearTimeout(palette.fileTimer);
  const { prefix, q } = parseQuery($('#palette-input').value);
  const wanted = prefix === '@' || (!prefix && q.length >= 2);
  if (!wanted || isDemo()) {
    palette.files = [];
    palette.loadingFiles = false;
    return;
  }
  palette.loadingFiles = true;
  const seq = ++palette.fileSeq;
  const project = state.active;
  palette.fileTimer = setTimeout(async () => {
    try {
      const { files } = await api(`/api/projects/${project}/files`, { q });
      if (seq !== palette.fileSeq || !isOpen()) return;
      palette.files = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string').slice(0, 30);
      palette.filesFor = project;
    } catch {
      if (seq !== palette.fileSeq) return;
      palette.files = [];
    }
    palette.loadingFiles = false;
    render();
  }, 120);
}

// ---------- open / run ----------

export function openPalette(prefill = '') {
  const input = $('#palette-input');
  input.value = prefill;
  palette.cursor = 0;
  palette.files = [];
  palette.filesFor = null;
  render();
  queueFiles();
  openModal('palette-modal');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function closePalette() {
  clearTimeout(palette.fileTimer);
  palette.fileSeq++;
  closeModal('palette-modal');
}

/** Runs the item at `i`. Disabled items explain why instead (they stay in the list, so nothing seems missing). */
function runAt(i) {
  const it = palette.shown[i];
  if (!it) return;
  if (it.disabled) return toast(it.disabled, 'warn');
  closePalette();
  // Actions that open a dialog or switch project start from a clean slate (no dialog left underneath).
  if (['dialog', 'project', 'file', 'chat'].includes(it.group) || it.id.startsWith('command:')) {
    for (const m of document.querySelectorAll('.modal')) if (!m.hidden) m.hidden = true;
  }
  remember(it.id);
  try {
    const out = it.run();
    out?.catch?.((err) => toast(err.message));
  } catch (err) {
    toast(err.message);
  }
}

export function initPalette() {
  const input = $('#palette-input');
  input.addEventListener('input', () => {
    palette.cursor = 0;
    queueFiles();
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      move(e.key === 'PageDown' ? 8 : -8);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(palette.cursor);
    }
  });
  const list = $('#palette-list');
  // mousedown: keep focus in the input (the combobox owns it); click runs.
  list.addEventListener('mousedown', (e) => {
    if (e.target.closest('.pal-opt')) e.preventDefault();
  });
  list.addEventListener('click', (e) => {
    const opt = e.target.closest('.pal-opt');
    if (opt) runAt(Number(opt.dataset.i));
  });
  list.addEventListener('mousemove', (e) => {
    const opt = e.target.closest('.pal-opt');
    if (opt && Number(opt.dataset.i) !== palette.cursor && !narrow.matches) move(Number(opt.dataset.i) - palette.cursor);
  });
  $('#btn-palette').addEventListener('click', () => openPalette());
  $('#nav-palette').addEventListener('click', () => openPalette()); // phone: bottom nav
}
