// ✅ Checklist project: which habits/files a project still misses (src/routes/checklist.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

export async function openChecklist() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu untuk melihat checklist.');
  wire();
  $('#checklist-project').textContent = `· ${projectName(state.active)}`;
  $('#checklist-sum').textContent = 'Memeriksa…';
  $('#checklist-list').innerHTML = '';
  openModal('checklist-modal');
  try {
    const data = await api(`/api/projects/${state.active}/checklist`);
    const checks = Array.isArray(data?.checks) ? data.checks : [];
    const done = checks.filter((c) => c.ok).length;
    $('#checklist-sum').textContent = `${done}/${checks.length} siap · mesin ${data?.engine === 'opencode' ? 'OpenCode' : 'Claude Code'}${data?.model ? ` · model ${data.model}` : ''}`;
    $('#checklist-list').innerHTML = checks
      .map(
        (c) =>
          `<li class="checklist-item ${c.ok ? 'ok' : 'todo'}"><span class="cl-mark" aria-hidden="true">${c.ok ? '✅' : '⭕'}</span><span class="cl-main"><b>${escapeHtml(c.label)}</b>${c.ok ? '' : `<small class="muted">${escapeHtml(c.hint ?? '')}</small>`}</span></li>`,
      )
      .join('');
  } catch (err) {
    $('#checklist-sum').textContent = '';
    $('#checklist-list').innerHTML = `<li class="state-error">Gagal memeriksa project: ${escapeHtml(err.message)}</li>`;
  }
}

let wired = false;

/** 🛠 One click for the missing skeletons; never overwrites an existing file. */
function wire() {
  const btn = $('#checklist-scaffold');
  if (!btn) return;
  btn.disabled = state.readOnly;
  btn.title = state.readOnly ? READ_ONLY_HINT : 'Buat README/AGENTS.md/.env.example/docs yang belum ada; file yang sudah ada tidak ditimpa';
  if (wired) return;
  wired = true;
  btn.addEventListener('click', async () => {
    if (state.readOnly) return toast(`${READ_ONLY_HINT}.`);
    if (!window.confirm('Buat kerangka file yang belum ada (README.md, AGENTS.md, .env.example, docs/)?\n\nFile yang sudah ada tidak akan ditimpa.')) return;
    btn.disabled = true;
    try {
      const result = await api(`/api/projects/${state.active}/checklist-scaffold`, {});
      const created = Array.isArray(result?.created) ? result.created : [];
      toast(created.length ? `Kerangka dibuat: ${created.join(', ')}.` : 'Tidak ada file baru yang perlu dibuat.', created.length ? 'ok' : 'ok');
      await openChecklist();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = state.readOnly;
    }
  });
}
