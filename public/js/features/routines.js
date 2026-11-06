// ⏰ Tugas terjadwal (⚙ → Jadwal): a prompt the server puts into the queue at a local time, once / daily / weekly.
// The schedule only decides WHEN; the queue still runs it when the project is idle and pauses on budget/errors.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';

const LIST = '/api/routines';
const SAVE = '/api/routines/save';
const DELETE = '/api/routines/delete';
const TOGGLE = '/api/routines/toggle';

const view = { list: [], loading: false, error: null, promise: null };

const whenText = (r) => `Berikutnya ${new Date(r.nextRun).toLocaleString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
const disabledText = (r) => (r.enabled ? whenText(r) : 'Dijeda');

function projectOptions() {
  const select = $('#routine-project');
  if (!select) return;
  const keep = select.value;
  const projects = (state.projects ?? []).filter((p) => p && p.id !== 'demo');
  select.innerHTML = projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  select.value = projects.some((p) => p.id === keep) ? keep : (projects[0]?.id ?? '');
  if (!projects.length) select.innerHTML = '<option value="">Belum ada project</option>';
}

function renderList() {
  const box = $('#routine-list');
  if (!box) return;
  if (view.loading) {
    box.innerHTML = '<p class="muted small">Memuat jadwal…</p>';
    return;
  }
  if (view.error) {
    box.innerHTML = `<p class="field-error" role="alert">${escapeHtml(view.error)}</p>`;
    return;
  }
  if (!view.list.length) {
    box.innerHTML = '<p class="muted small">Belum ada jadwal. Prompt yang kamu tambahkan akan masuk antrian otomatis.</p>';
    return;
  }
  box.innerHTML = `<ul class="routine-items">${view.list
    .map(
      (r) => `<li class="routine-item${r.enabled ? '' : ' off'}" data-routine="${escapeHtml(r.id)}">
        <div class="routine-main">
          <b>${escapeHtml(r.when ?? '')}</b>
          <span class="routine-prompt" title="${escapeHtml(r.prompt)}">${escapeHtml(r.prompt)}</span>
          <small class="muted">${escapeHtml(disabledText(r))}${r.error ? ` · ${escapeHtml(r.error)}` : ''}</small>
        </div>
        <button type="button" class="ghost routine-toggle" data-routine-toggle aria-pressed="${r.enabled}">${r.enabled ? 'Jeda' : 'Lanjutkan'}</button>
        <button type="button" class="ghost routine-delete" data-routine-delete aria-label="Hapus jadwal">🗑</button>
      </li>`,
    )
    .join('')}</ul>`;
}

function setError(message = '') {
  const box = $('#routine-error');
  if (box) box.textContent = message;
}

function readForm() {
  const projectId = $('#routine-project')?.value ?? '';
  const prompt = String($('#routine-prompt')?.value ?? '').trim();
  const frequency = $('#routine-frequency')?.value ?? 'daily';
  const time = $('#routine-time')?.value ?? '';
  if (!projectId) throw new Error('Pilih project dulu.');
  if (!prompt) throw new Error('Prompt jadwal masih kosong.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Jam jadwal belum valid.');
  const body = { projectId, prompt, frequency, time };
  if (frequency === 'weekly') body.weekday = Number($('#routine-weekday')?.value ?? 1);
  if (frequency === 'once') {
    const date = $('#routine-date')?.value ?? '';
    if (!date) throw new Error('Pilih tanggal untuk jadwal sekali.');
    body.date = date;
  }
  return body;
}

async function loadRoutines({ force = false } = {}) {
  if (view.promise) return view.promise;
  if (!force && (view.list.length || view.error)) {
    renderList();
    return Promise.resolve();
  }
  view.loading = true;
  view.error = null;
  renderList();
  const task = api(LIST)
    .then((data) => {
      view.list = Array.isArray(data?.routines) ? data.routines : [];
    })
    .catch((err) => {
      view.error = `Gagal memuat jadwal: ${err?.message ?? 'tidak diketahui'}`;
    })
    .finally(() => {
      view.loading = false;
      view.promise = null;
      renderList();
    });
  view.promise = task;
  return task;
}

async function saveRoutine() {
  let body;
  try {
    body = readForm();
  } catch (err) {
    setError(err.message);
    return;
  }
  setError('');
  const button = $('#routine-add');
  if (button) button.disabled = true;
  try {
    const data = await api(SAVE, body);
    view.list = Array.isArray(data?.routines) ? data.routines : [];
    view.error = null;
    $('#routine-prompt').value = '';
    renderList();
    toast('⏰ Jadwal ditambahkan.', 'ok');
  } catch (err) {
    setError(err?.status === 400 || err?.status === 404 ? err.message : `Gagal menyimpan jadwal: ${err?.message ?? 'tidak diketahui'}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function change(id, action) {
  try {
    const data = await api(action === 'delete' ? DELETE : TOGGLE, action === 'delete' ? { id } : { id, enabled: action === 'enable' });
    view.list = Array.isArray(data?.routines) ? data.routines : [];
    view.error = null;
    renderList();
  } catch (err) {
    setError(err?.message ?? 'Jadwal tidak bisa diubah.');
  }
}

/** The Ulangi switch: weekday for weekly, date for once, neither for daily. */
function syncFields() {
  const frequency = $('#routine-frequency')?.value ?? 'daily';
  const weekday = $('#routine-weekday-wrap');
  const date = $('#routine-date-wrap');
  if (weekday) weekday.hidden = frequency !== 'weekly';
  if (date) date.hidden = frequency !== 'once';
  if (date && !date.hidden && !$('#routine-date').value) {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    $('#routine-date').value = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  }
}

export function initRoutines() {
  const add = $('#routine-add');
  if (!add) return;
  projectOptions();
  syncFields();
  add.addEventListener('click', saveRoutine);
  $('#routine-frequency').addEventListener('change', syncFields);
  $('#routine-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-routine]');
    if (!item) return;
    if (e.target.closest('[data-routine-delete]')) change(item.dataset.routine, 'delete');
    else if (e.target.closest('[data-routine-toggle]')) change(item.dataset.routine, item.classList.contains('off') ? 'enable' : 'disable');
  });
}

/** Called when ⚙ → Jadwal is opened: refresh the project list and the stored schedules. */
export function openRoutines() {
  projectOptions();
  syncFields();
  renderList();
  loadRoutines();
}

export { loadRoutines };
