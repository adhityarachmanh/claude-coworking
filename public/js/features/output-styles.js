// 🎭 Output style (menu ⋯, sheet HP, /output-style): pick a built-in or custom style, and edit the custom
// Markdown files directly (server: src/routes/output-styles.js, src/output-styles.js). The choice is the project's
// local Claude Code setting; a custom style for every project is written from the laptop only.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const os = { project: null, styles: [], current: null, note: '', editing: null, busy: false, error: '' };

const isLocal = () => state.local !== false;
const activeName = () => (!os.current ? 'tidak terbaca' : os.current.name === 'default' ? 'Default' : os.current.name);
const scopeLabel = (scope) => (scope === 'user' ? 'semua project' : scope === 'project' ? 'project ini' : 'bawaan');

function render() {
  $('#os-project').textContent = os.project ? `· ${projectName(os.project)}` : '';
  $('#os-body').innerHTML = os.editing ? formHtml() : listHtml();
}

function listHtml() {
  const rows = os.styles
    .map((style) => {
      const active = os.current?.name === style.name;
      const custom = !style.builtin;
      const canWrite = !custom || isLocal() || style.scope !== 'user';
      const actions = [
        `<button type="button" class="ghost" data-os-use="${escapeHtml(style.name)}"${active ? ' disabled' : ''}>${active ? 'Aktif' : 'Pakai'}</button>`,
        custom && canWrite
          ? `<button type="button" class="ghost" data-os-edit="${escapeHtml(style.slug)}" data-os-scope="${escapeHtml(style.scope)}">✎ Edit</button><button type="button" class="ghost danger-text" data-os-delete="${escapeHtml(style.slug)}" data-os-scope="${escapeHtml(style.scope)}">Hapus</button>`
          : custom
            ? '<small class="muted">ubah dari laptop</small>'
            : '',
      ].join('');
      return `<li data-os-row="${escapeHtml(style.name)}">
        <div>
          <b>${escapeHtml(style.name)}</b>
          ${active ? '<span class="pill">aktif</span>' : ''}
          <span class="pill">${escapeHtml(style.builtin ? 'bawaan' : scopeLabel(style.scope))}</span>
          <p class="muted small">${escapeHtml(style.description || 'Tanpa deskripsi.')}</p>
        </div>
        <div class="ext-actions">${actions}</div>
      </li>`;
    })
    .join('');
  const chosen = os.current
    ? `<p class="muted small">Aktif sekarang: <b>${escapeHtml(activeName())}</b>${os.current.source && os.current.source !== 'default' ? ` (dari ${escapeHtml(scopeLabel(os.current.source === 'local' ? 'project' : os.current.source))}${os.current.source === 'local' ? ' · setelan lokal' : ''})` : ''}. Berlaku pada pesan berikutnya.</p>`
    : `<p class="field-error" role="alert">${escapeHtml(os.note || 'Pilihan gaya yang aktif tidak terbaca.')}</p>`;
  const unknown = os.current?.unknown
    ? `<p class="field-error" role="alert">Nilai "${escapeHtml(os.current.unknown)}" di setelan tidak dikenal Claude Code (peka huruf besar/kecil), jadi Default yang dipakai.</p>`
    : '';
  return `<p class="muted small">Gaya mengatur peran, nada, dan format jawaban Claude untuk seluruh percakapan (seperti <code>/output-style</code> di terminal). Pilihan disimpan di <code>.claude/settings.local.json</code>; gaya kustom adalah file Markdown di <code>.claude/output-styles</code> (project) atau <code>~/.claude/output-styles</code> (semua project).</p>
    ${chosen}
    ${unknown}
    ${isLocal() ? '' : '<p class="muted small">🔒 Gaya untuk <b>semua project</b> hanya bisa diubah dari laptop; gaya project ini tetap bisa dari sini.</p>'}
    <ul class="ext-list" id="os-list">${rows || '<li><p class="muted small">Belum ada gaya.</p></li>'}</ul>
    <div class="acct-actions"><button type="button" class="primary" id="os-new">＋ Gaya baru</button></div>`;
}

function formHtml() {
  const e = os.editing;
  return `<form id="os-form" class="oc-form">
    <p class="muted small">${e.slug ? 'Ubah gaya kustom. Mengganti nama akan memindahkan berkasnya.' : 'Gaya baru disimpan sebagai file Markdown dengan frontmatter name/description/keep-coding-instructions.'}</p>
    <label class="oc-field"><span>Nama gaya *</span><input id="os-name" name="name" required maxlength="60" autocomplete="off" value="${escapeHtml(e.name ?? '')}" placeholder="Diagram dulu" /></label>
    <label class="oc-field"><span>Deskripsi (tampil di pemilih gaya)</span><input id="os-description" name="description" maxlength="300" autocomplete="off" value="${escapeHtml(e.description ?? '')}" placeholder="Mulai penjelasan dengan diagram" /></label>
    <label class="oc-field"><span>Berlaku untuk</span><select id="os-scope" name="scope"${e.slug ? ' disabled' : ''}>
      <option value="project"${e.scope !== 'user' ? ' selected' : ''}>Project ini (.claude/output-styles)</option>
      ${isLocal() ? `<option value="user"${e.scope === 'user' ? ' selected' : ''}>Semua project (~/.claude/output-styles)</option>` : ''}
    </select>${e.slug ? '<small class="muted">Scope tidak bisa dipindah saat mengedit; buat gaya baru untuk scope lain.</small>' : isLocal() ? '' : '<small class="muted">Gaya semua project diubah dari laptop.</small>'}</label>
    <label class="oc-field"><span>Pertahankan instruksi coding Claude Code</span><input id="os-keep" name="keep" type="checkbox"${e.keepCodingInstructions ? ' checked' : ''} /></label>
    <label class="oc-field"><span>Instruksi gaya *</span><textarea id="os-instructions" name="body" class="memory-text" rows="10" spellcheck="false" required>${escapeHtml(e.body ?? '')}</textarea></label>
    <p class="muted small">Simpan ke <code>${escapeHtml(e.scope === 'user' ? '~/.claude/output-styles' : '.claude/output-styles')}</code>. Salinan lama disimpan di folder data aplikasi sebelum ditimpa.</p>
    <p id="os-error" class="field-error" role="alert">${escapeHtml(os.error)}</p>
    <div class="acct-actions"><button type="button" class="ghost" id="os-cancel">Batal</button><button type="submit" class="primary" id="os-save">💾 Simpan gaya</button></div>
  </form>`;
}

async function load() {
  try {
    const data = await api(`/api/projects/${os.project}/output-styles`);
    os.styles = data.styles ?? [];
    os.current = data.current ?? null;
    os.note = data.note ?? '';
    os.error = '';
    render();
  } catch (err) {
    $('#os-body').innerHTML = `<p class="state-error">${escapeHtml(err.message)}</p>`;
  }
}

export async function openOutputStyle() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Output style hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  os.project = state.active;
  os.editing = null;
  os.styles = [];
  os.current = null;
  os.note = '';
  os.error = '';
  openModal('output-style-modal');
  render();
  await load();
}

/** Applies a style name the way `/output-style <nama>` does (case-insensitive, like the CLI). */
export async function applyOutputStyle(name) {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Output style hanya bisa diubah dari laptop atau lewat Tailscale.', 'warn');
  try {
    const data = await api(`/api/projects/${state.active}/output-styles`);
    const wanted = String(name ?? '').trim().toLowerCase();
    const picked = data.styles?.find((style) => style.name.toLowerCase() === wanted)?.name;
    if (!picked) return toast(`Gaya "${name}" tidak dikenal. Buka /output-style untuk daftar.`, 'warn');
    const reply = await api(`/api/projects/${state.active}/output-styles/select`, { name: picked });
    toast(`Output style: ${reply.current.name === 'default' ? 'Default' : reply.current.name} — berlaku pada pesan berikutnya.`, 'ok');
  } catch (err) {
    toast(err.message, 'warn');
  }
}

async function selectStyle(name) {
  if (os.busy) return;
  os.busy = true;
  try {
    await api(`/api/projects/${os.project}/output-styles/select`, { name });
    toast(`Output style: ${name === 'default' ? 'Default' : name} — berlaku pada pesan berikutnya.`, 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    os.busy = false;
  }
}

async function editStyle(button) {
  const { osEdit: slug, osScope: scope } = button.dataset;
  try {
    const { style } = await api(`/api/projects/${os.project}/output-styles/read`, { scope, slug });
    os.editing = { ...style, mtime: style.mtime };
    os.error = '';
    render();
  } catch (err) {
    toast(err.message, 'warn');
  }
}

async function deleteStyle(button) {
  const { osDelete, osScope } = button.dataset;
  const style = os.styles.find((s) => s.slug === osDelete && s.scope === osScope);
  if (!style) return;
  if (!window.confirm(`Hapus gaya "${style.name}"? Salinan lama disimpan di folder data aplikasi.`)) return;
  try {
    await api(`/api/projects/${os.project}/output-styles/delete`, { scope: osScope, slug: osDelete, mtime: style.mtime });
    toast(`Gaya "${style.name}" dihapus.`, 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'warn');
  }
}

async function save() {
  if (os.busy || !os.editing) return;
  const form = $('#os-form');
  const name = $('#os-name').value.trim();
  const scope = $('#os-scope').value === 'user' ? 'user' : 'project';
  const body = {
    scope,
    slug: os.editing.slug ?? null,
    name,
    description: $('#os-description').value,
    keepCodingInstructions: $('#os-keep').checked,
    body: $('#os-instructions').value,
    mtime: os.editing.slug ? os.editing.mtime : null,
  };
  os.busy = true;
  os.error = '';
  try {
    await api(`/api/projects/${os.project}/output-styles/save`, body);
    toast(`Gaya "${name}" tersimpan. Berlaku pada pesan berikutnya.`, 'ok');
    os.editing = null;
    await load();
  } catch (err) {
    os.error = err.message;
    form.querySelector('#os-error').textContent = err.message;
  } finally {
    os.busy = false;
  }
}

export function initOutputStyle() {
  $('#os-refresh').addEventListener('click', load);
  $('#os-body').addEventListener('click', (e) => {
    const use = e.target.closest('[data-os-use]');
    if (use) return selectStyle(use.dataset.osUse);
    const edit = e.target.closest('[data-os-edit]');
    if (edit) return editStyle(edit);
    const del = e.target.closest('[data-os-delete]');
    if (del) return deleteStyle(del);
    if (e.target.closest('#os-new')) {
      os.editing = { scope: 'project', slug: null, name: '', description: '', keepCodingInstructions: false, body: '', mtime: null };
      os.error = '';
      return render();
    }
    if (e.target.closest('#os-cancel')) {
      os.editing = null;
      os.error = '';
      return render();
    }
  });
  $('#os-body').addEventListener('submit', (e) => {
    if (e.target.id !== 'os-form') return;
    e.preventDefault();
    save();
  });
}
