// ⚡ Template prompt: built-in prompts for common engineering work plus the user's own (stored on the server,
// the same on the laptop and a phone). Picked from a dialog (⚡ button, /t, /template); the text goes into the
// composer — never sent — with its first {placeholder} selected; Tab jumps to the next one.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { setMobileView } from '../ui/layout.js';
import { autosize, updateBashMode } from './composer.js';
import { scheduleDraftSave } from './draft.js';

export const TEMPLATE_LIMITS = { name: 60, text: 8000, count: 50 }; // the server enforces the same (src/templates.js)

export const BUILTIN_TEMPLATES = [
  {
    id: 'b-review',
    name: 'Review diff saat ini (bug, keamanan, kualitas)',
    text: 'Review semua perubahan yang belum di-commit (git diff) di project ini.\nCari: bug dan edge case, masalah keamanan (validasi input, auth, data sensitif/secrets), serta kualitas kode (penamaan, duplikasi, error handling, test yang kurang).\nLaporkan per file dengan tingkat keparahan (tinggi/sedang/rendah) dan saran perbaikan konkret. Jangan ubah kode dulu.\nPerhatikan khusus: {area atau risiko yang perlu diperhatikan}',
  },
  {
    id: 'b-test',
    name: 'Tulis test untuk perubahan terakhir',
    text: 'Tulis test otomatis untuk perubahan terakhir di {file atau fitur}.\nIkuti framework dan pola test yang sudah dipakai project. Cakup jalur normal, edge case, dan kondisi error.\nJalankan test-nya dan pastikan semuanya lulus.',
  },
  {
    id: 'b-error',
    name: 'Jelaskan error ini & perbaiki root cause',
    text: 'Error berikut muncul saat {langkah untuk mereproduksi}:\n\n```\n{tempel log / stack trace di sini}\n```\n\nJelaskan akar masalahnya (root cause) secara singkat, lalu perbaiki di sumbernya, bukan menambal gejala. Tambahkan test yang menangkap bug ini bila memungkinkan, lalu jalankan test dan lint.',
  },
  {
    id: 'b-refactor',
    name: 'Refactor file tanpa mengubah perilaku',
    text: 'Refactor {path file} agar lebih mudah dibaca dan dirawat tanpa mengubah perilakunya.\nPertahankan API publik dan kontrak yang ada. Jalankan test/lint sebelum dan sesudah untuk membuktikan perilakunya tetap sama, lalu ringkas apa yang diubah.',
  },
  {
    id: 'b-commit',
    name: 'Buat commit message & commit',
    text: 'Lihat semua perubahan yang belum di-commit. Bila isinya berbeda topik, kelompokkan menjadi beberapa commit.\nTulis commit message yang jelas: ringkasan maksimal 72 karakter, lalu penjelasan singkat mengapa perubahan dibuat. Kemudian commit.',
  },
  {
    id: 'b-summary',
    name: 'Ringkas apa yang dikerjakan di sesi ini',
    text: 'Ringkas apa yang sudah dikerjakan di sesi ini dalam poin singkat: tujuan, perubahan per file, keputusan penting beserta alasannya, yang belum selesai, dan langkah berikutnya.',
  },
  {
    id: 'b-ux',
    name: 'Audit tampilan/UX halaman',
    text: 'Audit tampilan dan UX halaman {nama halaman atau URL}: konsistensi visual, state kosong/loading/error, aksesibilitas (kontras, label, navigasi keyboard), dan tampilan di HP.\nBeri daftar temuan, urut dari dampak terbesar, beserta saran perbaikan. Jangan ubah kode dulu.',
  },
  {
    id: 'b-bug',
    name: 'Cari & perbaiki bug',
    text: 'Cari dan perbaiki bug: {apa yang terjadi vs. yang seharusnya}.\nReproduksi dulu, temukan root cause, perbaiki secara minimal dan terfokus, tambahkan test yang menangkap bug ini, lalu jalankan test dan lint.',
  },
];

/** A {placeholder}: a short, single-line part in braces (not code like `{}` or `{ a: 1 }` spanning lines). */
const PLACEHOLDER = /\{[^{}\n]{1,80}\}/g;

// active: placeholders from an inserted template are still being filled (Tab jumps between them).
export const placeholders = { active: false };

const tpl = {
  custom: null, // the user's templates from the server (null = not loaded yet)
  loading: false,
  error: null,
  query: '',
  active: 0, // index into the visible list
  range: null, // { start, end } in the composer the template replaces
  editing: null, // null = picking; { id|null, name, text } = the form
};

// ---------- placeholders ----------

/** Selects the next {placeholder} at or after `from` (wrapping once); false when none is left to jump to. */
export function selectPlaceholder(input, from = 0) {
  const find = (start) => {
    const re = new RegExp(PLACEHOLDER.source, 'g');
    re.lastIndex = start;
    return re.exec(input.value);
  };
  const m = find(from) ?? (from > 0 ? find(0) : null);
  // The only one left is the one already selected: Tab goes on to the next control (no keyboard trap).
  if (!m || (m.index === input.selectionStart && m.index + m[0].length === input.selectionEnd)) {
    placeholders.active = false;
    return false;
  }
  input.setSelectionRange(m.index, m.index + m[0].length);
  if (input.scrollHeight > input.clientHeight) scrollToSelection(input);
  return true;
}

/**
 * Scrolls a textarea so its selection is in view (browsers keep the old scroll position after `value` changes).
 * Measured with the text up to the selection (wrapping included), then the full text is put back.
 */
function scrollToSelection(input) {
  const { value, selectionStart, selectionEnd } = input;
  const height = input.style.height;
  input.style.height = `${input.clientHeight}px`; // keep the box size while measuring
  input.value = value.slice(0, selectionStart);
  const top = input.scrollHeight;
  input.value = value;
  input.style.height = height;
  input.setSelectionRange(selectionStart, selectionEnd);
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
  input.scrollTop = Math.max(0, top - lineHeight * 2);
}

/** Tab in the composer while a template's placeholders are open; true when it moved the selection. */
export function tabToPlaceholder(input) {
  if (!placeholders.active) return false;
  return selectPlaceholder(input, input.selectionEnd);
}

// ---------- the list ----------

const allTemplates = () => [...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true })), ...(tpl.custom ?? [])];

function visibleTemplates() {
  const q = tpl.query.trim().toLowerCase();
  const all = allTemplates();
  return q ? all.filter((t) => t.name.toLowerCase().includes(q) || t.text.toLowerCase().includes(q)) : all;
}

const optionId = (i) => `tpl-opt-${i}`;

function renderList() {
  const list = $('#tpl-list');
  const items = visibleTemplates();
  tpl.active = Math.min(Math.max(tpl.active, 0), Math.max(items.length - 1, 0));
  const option = (t, i) =>
    `<div class="tpl-opt${i === tpl.active ? ' active' : ''}" role="option" id="${optionId(i)}" data-i="${i}" aria-selected="${i === tpl.active}">
      <b>${escapeHtml(t.name)}</b><small>${escapeHtml(t.text.replace(/\s+/g, ' ').slice(0, 140))}</small></div>`;
  const builtin = items.filter((t) => t.builtin);
  const mine = items.filter((t) => !t.builtin);
  const index = new Map(items.map((t, i) => [t, i]));
  const group = (id, title, rows, empty) =>
    `<div role="group" aria-labelledby="${id}"><div class="s-group" id="${id}" role="presentation">${title}</div>${rows.length ? rows.map((t) => option(t, index.get(t))).join('') : `<p class="muted small tpl-empty">${empty}</p>`}</div>`;
  const mineEmpty = tpl.error
    ? `Gagal memuat template milikmu: ${escapeHtml(tpl.error)}`
    : tpl.custom == null
      ? 'Memuat…'
      : tpl.query
        ? 'Tidak ada yang cocok.'
        : 'Belum ada. Klik ＋ Baru, atau ⧉ Jadikan milikku pada template bawaan.';
  list.innerHTML = (builtin.length || !tpl.query ? group('tpl-g-builtin', 'Bawaan', builtin, 'Tidak ada yang cocok.') : '') + group('tpl-g-mine', `Milikku${tpl.custom ? ` <span class="muted">${tpl.custom.length}/${TEMPLATE_LIMITS.count}</span>` : ''}`, mine, mineEmpty);
  $('#tpl-search').setAttribute('aria-activedescendant', items.length ? optionId(tpl.active) : '');
  list.querySelector('.tpl-opt.active')?.scrollIntoView({ block: 'nearest' });
  renderPreview(items[tpl.active] ?? null);
  const full = (tpl.custom?.length ?? 0) >= TEMPLATE_LIMITS.count;
  $('#tpl-new').disabled = full || tpl.custom == null;
  $('#tpl-new').title = full ? `Maksimal ${TEMPLATE_LIMITS.count} template — hapus yang tidak dipakai dulu` : 'Buat template baru';
}

function renderPreview(t) {
  $('#tpl-preview').textContent = t ? t.text : 'Pilih template untuk melihat isinya.';
  $('#tpl-use').disabled = !t;
  $('#tpl-edit').hidden = !t || t.builtin;
  $('#tpl-delete').hidden = !t || t.builtin;
  $('#tpl-copy').hidden = !t || !t.builtin;
}

async function loadTemplates() {
  tpl.loading = true;
  try {
    const { templates } = await api('/api/templates');
    tpl.custom = Array.isArray(templates) ? templates.filter((t) => typeof t?.name === 'string' && typeof t?.text === 'string') : [];
    tpl.error = null;
  } catch (err) {
    tpl.error = err.message;
  } finally {
    tpl.loading = false;
    if (!tpl.editing) renderList();
  }
}

// ---------- open / insert ----------

/**
 * Opens the picker. `range` is the part of the composer the template replaces (default: the current selection);
 * /t passes the place where it was typed.
 */
export function openTemplates(range = null) {
  if (state.readOnly) return;
  const input = $('#prompt');
  tpl.range = range ?? { start: input.selectionStart, end: input.selectionEnd };
  tpl.query = '';
  tpl.active = 0;
  showPicker();
  $('#tpl-search').value = '';
  openModal('templates-modal');
  $('#tpl-search').focus();
  renderList();
  loadTemplates(); // every open: a template added on the other device shows up
}

/** Puts the template into the composer (not sent) and selects its first placeholder. */
export function insertTemplate(t) {
  if (!t || state.readOnly) return;
  closeModal('templates-modal');
  if (narrow.matches) setMobileView('chat');
  const input = $('#prompt');
  const value = input.value;
  const start = Math.min(tpl.range?.start ?? value.length, value.length);
  const end = Math.min(Math.max(tpl.range?.end ?? start, start), value.length);
  const before = value.slice(0, start);
  const after = value.slice(end);
  // Into existing text: as its own paragraph.
  const lead = before && !/\n\s*$/.test(before) ? '\n\n' : '';
  const trail = after && !/^\s*\n/.test(after) ? '\n\n' : '';
  const at = before.length + lead.length;
  input.value = before + lead + t.text + trail + after;
  autosize(); // first: the box's final height decides where the selection scrolls to
  input.focus();
  placeholders.active = true;
  if (!selectPlaceholder(input, at)) input.setSelectionRange(at + t.text.length, at + t.text.length);
  updateBashMode();
  scheduleDraftSave();
}

function activeTemplate() {
  return visibleTemplates()[tpl.active] ?? null;
}

// ---------- the add / edit form ----------

function showPicker() {
  tpl.editing = null;
  $('#tpl-pick').hidden = false;
  $('#tpl-form').hidden = true;
}

function showForm(editing) {
  tpl.editing = editing;
  $('#tpl-pick').hidden = true;
  $('#tpl-form').hidden = false;
  $('#tpl-form-title').textContent = editing.id ? 'Ubah template' : 'Template baru';
  $('#tpl-name').value = editing.name;
  $('#tpl-text').value = editing.text;
  $('#tpl-error').textContent = '';
  for (const id of ['#tpl-name', '#tpl-text']) $(id).removeAttribute('aria-invalid');
  updateCounts();
  $('#tpl-name').focus();
}

function updateCounts() {
  $('#tpl-name-count').textContent = `${$('#tpl-name').value.length}/${TEMPLATE_LIMITS.name}`;
  $('#tpl-text-count').textContent = `${$('#tpl-text').value.length}/${TEMPLATE_LIMITS.text}`;
}

/** Client-side checks, the same rules the server applies; returns [field, message] or null. */
function formError(name, text, id) {
  if (!name) return ['#tpl-name', 'Nama template wajib diisi.'];
  if (name.length > TEMPLATE_LIMITS.name) return ['#tpl-name', `Nama maksimal ${TEMPLATE_LIMITS.name} karakter.`];
  if ((tpl.custom ?? []).some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) return ['#tpl-name', `Sudah ada template bernama "${name}".`];
  if (!text) return ['#tpl-text', 'Isi template wajib diisi.'];
  if (text.length > TEMPLATE_LIMITS.text) return ['#tpl-text', `Isi maksimal ${TEMPLATE_LIMITS.text} karakter.`];
  return null;
}

async function saveForm() {
  const id = tpl.editing?.id ?? null;
  const name = $('#tpl-name').value.replace(/\s+/g, ' ').trim();
  const text = $('#tpl-text').value.trim();
  const problem = formError(name, text, id);
  for (const sel of ['#tpl-name', '#tpl-text']) $(sel).setAttribute('aria-invalid', String(problem?.[0] === sel));
  $('#tpl-error').textContent = problem?.[1] ?? '';
  if (problem) return $(problem[0]).focus();
  $('#tpl-save').disabled = true;
  try {
    const res = await api('/api/templates/save', { id, name, text });
    tpl.custom = res.templates;
    showPicker();
    tpl.query = '';
    $('#tpl-search').value = '';
    tpl.active = allTemplates().findIndex((t) => t.id === res.template.id);
    renderList();
    $('#tpl-search').focus();
    toast(id ? 'Template diperbarui.' : 'Template disimpan.', 'ok');
  } catch (err) {
    $('#tpl-error').textContent = err.message;
  } finally {
    $('#tpl-save').disabled = false;
  }
}

async function deleteActive() {
  const t = activeTemplate();
  if (!t || t.builtin) return;
  if (!window.confirm(`Hapus template "${t.name}"?`)) return;
  try {
    tpl.custom = (await api('/api/templates/delete', { id: t.id })).templates;
    renderList();
    $('#tpl-search').focus();
    toast('Template dihapus.', 'ok');
  } catch (err) {
    toast(err.message);
  }
}

export function initTemplates() {
  $('#btn-template').addEventListener('click', () => openTemplates());
  const search = $('#tpl-search');
  search.addEventListener('input', () => {
    tpl.query = search.value;
    tpl.active = 0;
    renderList();
  });
  // Combobox keys: focus stays in the search box, ↑↓ move through the list, Enter inserts (Esc closes the dialog).
  search.addEventListener('keydown', (e) => {
    const count = visibleTemplates().length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
      e.preventDefault();
      tpl.active = (tpl.active + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
      renderList();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      insertTemplate(activeTemplate());
    }
  });
  // Click picks (shows the full text below); double-click inserts. On a phone: tap, then "Sisipkan".
  $('#tpl-list').addEventListener('mousedown', (e) => {
    if (e.target.closest('.tpl-opt')) e.preventDefault(); // keep focus (and the keyboard) in the search box
  });
  $('#tpl-list').addEventListener('click', (e) => {
    const opt = e.target.closest('.tpl-opt');
    if (!opt) return;
    tpl.active = Number(opt.dataset.i);
    renderList();
  });
  $('#tpl-list').addEventListener('dblclick', (e) => {
    const opt = e.target.closest('.tpl-opt');
    if (opt) insertTemplate(visibleTemplates()[Number(opt.dataset.i)]);
  });
  $('#tpl-use').addEventListener('click', () => insertTemplate(activeTemplate()));
  $('#tpl-new').addEventListener('click', () => showForm({ id: null, name: '', text: '' }));
  $('#tpl-edit').addEventListener('click', () => {
    const t = activeTemplate();
    if (t && !t.builtin) showForm({ id: t.id, name: t.name, text: t.text });
  });
  $('#tpl-copy').addEventListener('click', () => {
    const t = activeTemplate();
    if (t) showForm({ id: null, name: `${t.name} (salinan)`.slice(0, TEMPLATE_LIMITS.name), text: t.text });
  });
  $('#tpl-delete').addEventListener('click', deleteActive);
  $('#tpl-cancel').addEventListener('click', () => {
    showPicker();
    renderList();
    $('#tpl-search').focus();
  });
  $('#tpl-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveForm();
  });
  $('#tpl-name').addEventListener('input', updateCounts);
  $('#tpl-text').addEventListener('input', updateCounts);
  renderList(); // the built-in ones are there from the start
}
