// 🕵️ Data saya: sizes of what the app keeps, plus safe cleanups (notification log, session trash, old chats/ledger).
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

// ⏳ Retention choices offered by the two <select>s (the server accepts 0…3650 days; 0 = keep forever).
const RETENTION_HINT = 'Pilih batas lalu klik Pratinjau untuk melihat berapa data yang akan dihapus.';

// The panel is drawn again after every action; `filled` keeps a half-edited choice from being overwritten by a
// redraw, and `preview` feeds the confirmation the "Bersihkan sekarang" button shows.
const retention = { filled: false, preview: null };

const count = (value) => Math.max(0, Math.trunc(Number(value) || 0));
const isDays = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 3650;

/**
 * Writes one saved limit into its select. A value the UI does not offer (set through the API, e.g. 45 days) gets its
 * own option instead of being shown as "keep forever" — saving the panel must never turn a real limit into 0.
 */
function fillRetentionSelect(selector, days) {
  const el = $(selector);
  if (!el) return;
  const value = isDays(days) ? String(Number(days)) : '0';
  if (![...el.options].some((option) => option.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value} hari`;
    el.append(option);
  }
  el.value = value;
}

/** The saved retention into both selects. */
function fillRetention(value) {
  fillRetentionSelect('#data-ret-chats', value?.chatsDays);
  fillRetentionSelect('#data-ret-usage', value?.usageDays);
}

/** The two selects as the server's body, or null when something else ended up in them. */
function readRetention() {
  const chatsDays = Number($('#data-ret-chats')?.value);
  const usageDays = Number($('#data-ret-usage')?.value);
  if (!isDays(chatsDays) || !isDays(usageDays)) return null;
  return { chatsDays, usageDays };
}

/** Locks the whole retention block while an operation runs, so the numbers on screen cannot change under it. */
function retentionBusy(busy) {
  const box = $('#data-modal .data-retention');
  box?.setAttribute('aria-busy', busy ? 'true' : 'false');
  for (const sel of ['#data-ret-chats', '#data-ret-usage']) {
    const el = $(sel);
    if (el) el.disabled = busy;
  }
  for (const sel of ['#data-ret-preview-btn', '#data-ret-save', '#data-ret-run']) {
    const el = $(sel);
    if (el) el.disabled = busy;
  }
}

function showRetentionPreview(message) {
  const box = $('#data-ret-preview');
  if (box && box.textContent !== message) box.textContent = message;
}

function retentionSentence(data) {
  const messages = count(data?.chats?.messages);
  const projects = count(data?.chats?.projects);
  const rows = count(data?.usage?.rows);
  const files = count(data?.usage?.files);
  if (!messages && !rows) return 'Tidak ada data yang lebih lama dari batas ini.';
  return `Akan dihapus: ${messages} pesan chat di ${projects} project dan ${rows} baris laporan di ${files} file.`;
}

/** Asks the server what the chosen limits would remove (nothing is deleted). */
async function previewRetention() {
  const body = readRetention();
  if (!body) return toast('Pilih batas retensi yang tersedia.', 'warn');
  const btn = $('#data-ret-preview-btn');
  retentionBusy(true);
  if (btn) {
    btn.textContent = '⏳ Menghitung…';
  }
  try {
    const res = await api('/api/data/retention/preview', body);
    retention.preview = {
      messages: count(res?.chats?.messages),
      projects: count(res?.chats?.projects),
      rows: count(res?.usage?.rows),
      files: count(res?.usage?.files),
    };
    showRetentionPreview(retentionSentence(res));
  } catch (err) {
    retention.preview = null;
    toast(err.message);
  } finally {
    retentionBusy(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Pratinjau';
    }
  }
}

async function saveRetention() {
  const body = readRetention();
  if (!body) return toast('Pilih batas retensi yang tersedia.', 'warn');
  const btn = $('#data-ret-save');
  retentionBusy(true);
  if (btn) {
    btn.textContent = '⏳ Menyimpan…';
  }
  try {
    await api('/api/data/retention/save', body);
    toast('Batas retensi disimpan.', 'ok');
    retention.filled = false; // the reload shows what the server actually kept
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    retentionBusy(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Simpan';
    }
  }
}

/** Saves the chosen limits, then deletes what is past them right now (the daily sweep does the same on its own). */
async function runRetention() {
  const body = readRetention();
  if (!body) return toast('Pilih batas retensi yang tersedia.', 'warn');
  const p = retention.preview;
  const previewLine = p ? `\n\nPratinjau terakhir: ${p.messages} pesan chat di ${p.projects} project dan ${p.rows} baris laporan di ${p.files} file.` : '';
  if (!window.confirm(`Bersihkan sekarang data yang lebih lama dari batas retensi?${previewLine}\n\nTranskrip sesi dan backup tidak disentuh. Tindakan ini tidak bisa dibatalkan.`)) return;
  const btn = $('#data-ret-run');
  retentionBusy(true);
  if (btn) {
    btn.textContent = '⏳ Membersihkan…';
  }
  try {
    // A choice that was not saved yet still applies to this click, so what runs is what is on screen.
    await api('/api/data/retention/save', body);
    const res = await api('/api/data/retention/run', { target: 'all' });
    toast(`Retensi dijalankan: ${count(res?.chats?.removed)} pesan chat dan ${count(res?.usage?.removed)} baris laporan dihapus.`, 'ok');
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    retentionBusy(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Bersihkan sekarang';
    }
  }
}

function render(data) {
  const rows = [
    ['Pengaturan & status aplikasi', `state.json · ${fmt(data.state.bytes)}`],
    ['Riwayat chat (Claude + OpenCode)', `${data.chats.files} file · ${fmt(data.chats.bytes)}`],
    ['Laporan pemakaian token', `usage.jsonl · ${fmt(data.usage.bytes)}`],
    ['Arsip laporan pemakaian', `${data.usageArchive.files} file · ${fmt(data.usageArchive.bytes)}`],
    ['Lampiran antrian', `${data.queueFiles.files} file · ${fmt(data.queueFiles.bytes)}`],
    ['Bundel redo (kembalikan perubahan)', `${data.redo.files} file · ${fmt(data.redo.bytes)}`],
    ['Backup config OpenCode', `${data.configBackups.files} file · ${fmt(data.configBackups.bytes)}`],
    ['Riwayat kesehatan server', `metrics.json · ${fmt(data.metrics.bytes)}`],
    ['Log server', `server.log · ${fmt(data.logs.bytes)}`],
    ['Audit aksi data', `audit.log · ${fmt(data.audit.bytes)} · maks 500 baris`],
    ['Audit login akun', `auth-audit.jsonl · ${fmt(data.authAudit.bytes)} · ${data.authAudit.retentionDays} hari`],
    ['Salinan state lama', `${data.stateBackups.files} file · ${fmt(data.stateBackups.bytes)} · otomatis maks 5 file/30 hari`],
    ['Cache harga model', `model-prices.json · ${fmt(data.modelPrices.bytes)}`],
    ['Status kompatibilitas', `claude-check.json · ${fmt(data.claudeCheck.bytes)}`],
    ['Riwayat notifikasi', `${data.pushHistory.entries} entri · ${fmt(data.pushHistory.bytes)}`],
    ['Trash sesi', `${data.trash.files} file · ${fmt(data.trash.bytes)} · otomatis dibersihkan setelah ${data.trash.retentionDays} hari`],
    ['Backup otomatis', `${data.backups.files} file · ${fmt(data.backups.bytes)} · tidak bisa dihapus per project`],
  ];
  $('#data-list').innerHTML = rows.map(([label, value]) => `<li class="data-row"><span>${escapeHtml(label)}</span><small class="muted">${escapeHtml(value)}</small></li>`).join('');
  const actions = { 'backup-export': 'Ekspor backup', 'backup-import': 'Impor backup', 'backup-verify': 'Verifikasi backup', 'backup-rekey': 'Ganti sandi backup', 'data-purge': 'Hapus data', 'retention-run': 'Retensi data' };
  const audit = Array.isArray(data.audit) ? data.audit : [];
  $('#data-audit').innerHTML = audit.length
    ? audit
        .map((entry) => `<li class="data-row"><span>${escapeHtml(actions[entry.action] ?? entry.action)}</span><small class="muted">${escapeHtml(new Date(entry.at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${entry.detail ? ` · ${escapeHtml(entry.detail)}` : ''}</small></li>`)
        .join('')
    : '<li class="muted small">Belum ada aktivitas.</li>';
  $('#data-note').textContent = 'Semua data ini ada di folder data aplikasi di laptop. Tidak ada yang dikirim ke luar. Backup otomatis yang sudah dibuat tidak bisa dihapus per project.';
  // The saved limits are written once per open (and after a save); a redraw never overwrites a choice being changed.
  if (!retention.filled) {
    fillRetention(data.retention);
    retention.filled = true;
  }
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
  retention.filled = false; // a fresh open always shows the saved limits
  retention.preview = null;
  showRetentionPreview(RETENTION_HINT);
  openModal('data-modal');
  await load();
}

async function load(auditAction = $('#data-audit-filter')?.value ?? '') {
  try {
    const answer = await api('/api/data', auditAction ? { auditAction } : {});
    retention.preview = null;
    // The audit trail and the retention setting travel next to `data` in the response; render() expects one object.
    render({ ...(answer.data ?? {}), audit: answer.audit ?? [], retention: answer.retention ?? { chatsDays: 0, usageDays: 0 } });
    showRetentionPreview(RETENTION_HINT);
  } catch (err) {
    $('#data-list').innerHTML = `<li class="state-error">Gagal membaca data: ${escapeHtml(err.message)}</li>`;
  }
}

/** 🧹 Hapus data satu project: chat + ledger + pengaturan + redo + antrian, tanpa menghapus projectnya. */
async function purgeProject() {
  const id = $('#data-project')?.value;
  if (!id) return toast('Pilih project dulu.', 'warn');
  const name = projectName(id);
  if (!window.confirm(`Hapus data project "${name}"?\n\nChat kedua mesin, laporan pemakaian, pengaturan, sesi, antrian, bundel redo, dan lampiran antrian project ini dihapus. Folder project dan transkrip Claude di disk tidak disentuh. Backup otomatis yang sudah dibuat tetap utuh dan tidak bisa dihapus per project. Tindakan ini tidak bisa dibatalkan; cadangkan dulu bila perlu.`)) return;
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
  $('#data-purge-redo')?.addEventListener('click', () => purge('redo', 'Hapus semua bundel redo'));
  $('#data-purge-config-backups')?.addEventListener('click', () => purge('config-backups', 'Hapus semua backup config OpenCode'));
  $('#data-purge-metrics')?.addEventListener('click', () => purge('metrics', 'Hapus riwayat kesehatan server'));
  $('#data-purge-logs')?.addEventListener('click', () => purge('logs', 'Kosongkan log server'));
  $('#data-purge-state-backups')?.addEventListener('click', () => purge('state-backups', 'Hapus semua salinan state lama'));
  $('#data-purge-project')?.addEventListener('click', purgeProject);
  $('#data-ret-preview-btn')?.addEventListener('click', previewRetention);
  $('#data-ret-save')?.addEventListener('click', saveRetention);
  $('#data-ret-run')?.addEventListener('click', runRetention);
  // A changed choice makes an earlier preview stale: never confirm with numbers that no longer match.
  for (const sel of ['#data-ret-chats', '#data-ret-usage']) {
    $(sel)?.addEventListener('change', () => {
      retention.preview = null;
      showRetentionPreview(RETENTION_HINT);
    });
  }
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
