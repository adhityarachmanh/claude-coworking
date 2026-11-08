// 🕵️ Data saya: sizes of what the app keeps, plus two safe cleanups (notification log, session trash).
import { api, canCall, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { saveBlob } from '../core/util.js';
import { openModal } from '../ui/modals.js';

const fmt = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
};

function render(data) {
  const rows = [
    ['Pengaturan & status aplikasi', `state.json · ${fmt(data.state.bytes)}`],
    ['Riwayat chat (Claude + OpenCode)', `${data.chats.files} file · ${fmt(data.chats.bytes)}`],
    ['Laporan pemakaian token', `usage.jsonl · ${fmt(data.usage.bytes)}`],
    ['Riwayat notifikasi', `${data.pushHistory.entries} entri · ${fmt(data.pushHistory.bytes)}`],
    ['Trash sesi', `${data.trash.files} file · ${fmt(data.trash.bytes)} · otomatis dibersihkan setelah ${data.trash.retentionDays} hari`],
    ['Backup otomatis', `${data.backups.files} file · ${fmt(data.backups.bytes)}`],
  ];
  $('#data-list').innerHTML = rows.map(([label, value]) => `<li class="data-row"><span>${escapeHtml(label)}</span><small class="muted">${escapeHtml(value)}</small></li>`).join('');
  const actions = { 'backup-export': 'Ekspor backup', 'backup-import': 'Impor backup', 'backup-verify': 'Verifikasi backup', 'backup-rekey': 'Ganti sandi backup', 'data-purge': 'Hapus data' };
  const audit = Array.isArray(data.audit) ? data.audit : [];
  $('#data-audit').innerHTML = audit.length
    ? audit
        .map((entry) => `<li class="data-row"><span>${escapeHtml(actions[entry.action] ?? entry.action)}</span><small class="muted">${escapeHtml(new Date(entry.at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${entry.detail ? ` · ${escapeHtml(entry.detail)}` : ''}</small></li>`)
        .join('')
    : '<li class="muted small">Belum ada aktivitas.</li>';
  $('#data-note').textContent = 'Semua data ini ada di folder data aplikasi di laptop. Tidak ada yang dikirim ke luar.';
}

export async function openDataPanel() {
  if (!canCall('/api/data')) return toast(READ_ONLY_HINT);
  const select = $('#data-project');
  if (select) {
    const projects = (state.projects ?? []).filter((p) => p.id !== DEMO_ID);
    select.innerHTML = projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('') || '<option value="">Belum ada project</option>';
  }
  $('#data-list').innerHTML = '<li class="muted small">Menghitung ukuran…</li>';
  $('#data-note').textContent = '';
  openModal('data-modal');
  await load();
}

async function load(auditAction = $('#data-audit-filter')?.value ?? '') {
  try {
    const answer = await api('/api/data', auditAction ? { auditAction } : {});
    render(answer.data ?? {});
  } catch (err) {
    $('#data-list').innerHTML = `<li class="state-error">Gagal membaca data: ${escapeHtml(err.message)}</li>`;
  }
}

/** 🧹 Hapus data satu project: chat + ledger + pengaturan, tanpa menghapus projectnya. */
async function purgeProject() {
  const id = $('#data-project')?.value;
  if (!id) return toast('Pilih project dulu.', 'warn');
  const name = projectName(id);
  if (!window.confirm(`Hapus data project "${name}"?\n\nChat kedua mesin, laporan pemakaian, pengaturan, sesi, antrian, dan runbook project ini dihapus. Folder project dan transkrip Claude di disk tidak disentuh. Tindakan ini tidak bisa dibatalkan; cadangkan dulu bila perlu.`)) return;
  try {
    await api('/api/data/project', { projectId: id, confirm: 'HAPUS' });
    toast(`Data project "${name}" dihapus. Halaman dimuat ulang.`, 'ok');
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    toast(err.message);
  }
}

async function purge(target, label) {
  if (!window.confirm(`${label}?\n\nTindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await api('/api/data/purge', { target });
    toast(`${label} selesai.`, 'ok');
    await load();
  } catch (err) {
    toast(err.message);
  }
}

export function initData() {
  $('#btn-data-panel')?.addEventListener('click', openDataPanel);
  $('#data-purge-push')?.addEventListener('click', () => purge('push-history', 'Hapus seluruh riwayat notifikasi'));
  $('#data-purge-trash')?.addEventListener('click', () => purge('trash', 'Kosongkan semua sesi di trash'));
  $('#data-purge-project')?.addEventListener('click', purgeProject);
  $('#data-audit-filter')?.addEventListener('change', (e) => load(e.target.value));
  $('#data-audit-export')?.addEventListener('click', async () => {
    try {
      const blob = await api('/api/data/audit-export', {}, { raw: true });
      saveBlob(`adhit-office-audit-${new Date().toLocaleDateString('sv-SE')}.csv`, blob);
      toast('Audit diunduh.', 'ok');
    } catch (err) {
      toast(err.message);
    }
  });
}
