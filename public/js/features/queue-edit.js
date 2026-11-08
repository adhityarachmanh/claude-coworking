// ✎ Ubah prompt yang masih menunggu di 📋 Antrian (POST /api/projects/:id/queue-update): the server rewrites the
// item and patches the SAME chat bubble. Only waiting items are editable — the server refuses the rest (409).
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { READ_ONLY_HINT, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';

/** Same limit as the server (src/queue.js QUEUE_LIMITS.text) and the textarea's maxlength. */
const MAX_TEXT = 20000;
const view = { project: null, itemId: null, saving: false };

/** Opens the editor for one waiting item: the project it belongs to, its id and the text to start from. */
export function openQueueEdit(project, itemId, text) {
  if (typeof project !== 'string' || !project || typeof itemId !== 'string' || !itemId) {
    return toast('Item antrian tidak dikenal — buka 📋 Antrian lalu coba lagi.', 'warn');
  }
  view.project = project;
  view.itemId = itemId;
  view.saving = false;
  const input = $('#queue-edit-text');
  input.value = String(text ?? '').slice(0, MAX_TEXT);
  showError('');
  const save = $('#queue-edit-save');
  save.disabled = state.readOnly; // a WiFi phone may look, not act (the server refuses the POST too)
  save.title = state.readOnly ? READ_ONLY_HINT : 'Simpan prompt (Ctrl+Enter)';
  openModal('queue-edit-modal');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function showError(message) {
  const box = $('#queue-edit-error');
  box.textContent = message;
  box.hidden = !message;
  $('#queue-edit-text').setAttribute('aria-invalid', String(Boolean(message)));
}

async function save() {
  if (view.saving || !view.project || !view.itemId) return;
  const input = $('#queue-edit-text');
  const text = input.value;
  if (!text.trim()) {
    showError('Prompt belum diisi.');
    input.focus();
    return;
  }
  if (text.length > MAX_TEXT) {
    showError(`Prompt terlalu panjang (maks ${MAX_TEXT.toLocaleString('id-ID')} karakter).`);
    input.focus();
    return;
  }
  if (state.readOnly) return showError(`${READ_ONLY_HINT}.`);
  showError('');
  view.saving = true;
  const button = $('#queue-edit-save');
  button.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(view.project)}/queue-update`, { itemId: view.itemId, text });
    closeModal('queue-edit-modal');
    toast('Prompt antrian diperbarui.', 'ok');
  } catch (err) {
    showError(err.message);
    toast(`Gagal mengubah prompt: ${err.message}`);
  } finally {
    view.saving = false;
    button.disabled = false;
  }
}

export function initQueueEdit() {
  $('#queue-edit-cancel').addEventListener('click', () => closeModal('queue-edit-modal'));
  $('#queue-edit-save').addEventListener('click', save);
  $('#queue-edit-text').addEventListener('input', () => showError(''));
  $('#queue-edit-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  });
}
