// 🧠 Memory (/memory): edit CLAUDE.md / CLAUDE.local.md / ~/.claude/CLAUDE.md (Claude Code) or AGENTS.md (OpenCode)
// right here, from the laptop or over Tailscale (server: src/routes/memory.js). A file changed elsewhere since it
// was opened is never overwritten (409: reload first).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const mem = { project: null, files: [], file: null, saving: false };

const dirty = () => mem.file && $('#memory-text').value !== mem.file.content;

function render() {
  const f = mem.file;
  $('#memory-project').textContent = `· ${projectName(mem.project)}`;
  $('#memory-tabs').innerHTML = mem.files
    .map((x) => `<button type="button" class="engine-opt${x.key === f?.key ? ' on' : ''}" data-mem="${escapeHtml(x.key)}" aria-pressed="${x.key === f?.key}">${escapeHtml(x.label)}${x.exists ? '' : ' <small class="muted">(baru)</small>'}</button>`)
    .join('');
  $('#memory-hint').textContent = f ? `${f.hint} ${f.path}` : '';
  $('#memory-save').disabled = !f || mem.saving;
}

async function load(key) {
  try {
    const data = await api(`/api/projects/${mem.project}/memory`, key ? { key } : {});
    Object.assign(mem, { files: data.files, file: data.file });
    $('#memory-text').value = data.file.content;
    render();
  } catch (err) {
    toast(err.message);
  }
}

export async function openMemory() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Memory hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  mem.project = state.active;
  $('#memory-text').value = '';
  mem.file = null;
  openModal('memory-modal');
  await load();
  $('#memory-text').focus();
}

async function save() {
  if (!mem.file || mem.saving) return;
  mem.saving = true;
  render();
  try {
    const { file } = await api(`/api/projects/${mem.project}/memory/save`, { key: mem.file.key, content: $('#memory-text').value, mtime: mem.file.mtime });
    mem.file = file;
    const entry = mem.files.find((x) => x.key === file.key);
    if (entry) entry.exists = true;
    toast(`${file.label} tersimpan. Berlaku mulai pesan berikutnya.`, 'ok');
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    mem.saving = false;
    render();
  }
}

export function initMemory() {
  $('#memory-tabs').addEventListener('click', (e) => {
    const key = e.target.closest('[data-mem]')?.dataset.mem;
    if (!key || key === mem.file?.key) return;
    if (dirty() && !window.confirm('Perubahan belum disimpan. Pindah file dan buang perubahan?')) return;
    load(key);
  });
  $('#memory-save').addEventListener('click', save);
  $('#memory-reload').addEventListener('click', () => {
    if (dirty() && !window.confirm('Buang perubahan dan muat ulang dari disk?')) return;
    load(mem.file?.key);
  });
  $('#memory-text').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
}
