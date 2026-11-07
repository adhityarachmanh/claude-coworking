// ⚙ → Cadangkan riwayat → ⏰ Backup otomatis: the schedule (daily/weekly at a time), the target folder, how many
// to keep, the last result and "Jalankan sekarang" (server: src/backup-schedule.js, laptop only).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { shortDate } from '../core/format.js';
import { state } from '../core/state.js';

const MB = 1024 * 1024;
const POLL_MS = 1500;
const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const auto = { view: null, timer: null, history: [] };

const fmtSize = (bytes) => (bytes >= MB ? `${(bytes / MB).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const setError = (text) => ($('#ba-error').textContent = text);

/** The form from the server's settings (not while the user is typing in it). */
function fill(view) {
  const s = view.schedule;
  $('#ba-enabled').checked = s.enabled;
  $('#ba-frequency').value = s.frequency;
  $('#ba-weekday').value = String(s.weekday);
  $('#ba-time').value = s.time;
  $('#ba-keep').value = String(s.keep);
  $('#ba-keep').max = String(view.keepMax ?? 100);
  $('#ba-folder').value = s.folder;
  syncFields();
}

function syncFields() {
  const weekly = $('#ba-frequency').value === 'weekly';
  $('#ba-weekday-row').hidden = !weekly;
  $('#ba-weekday-label').hidden = !weekly;
}

/** Last result, next run, running. Server text only goes through textContent. */
function renderStatus() {
  const v = auto.view;
  if (!v) return;
  const parts = [];
  if (v.running) parts.push('⏳ Backup sedang ditulis…');
  else if (v.schedule.enabled && v.nextAt) parts.push(`Berikutnya: ${shortDate(v.nextAt)}.`);
  else parts.push('Backup otomatis nonaktif.');
  const last = v.last;
  if (last) {
    const when = shortDate(last.at);
    const how = last.trigger === 'manual' ? 'manual' : 'terjadwal';
    parts.push(last.ok ? `Terakhir (${how}): ✓ ${when} — ${last.name}, ${fmtSize(last.bytes)}${last.removed ? `, ${last.removed} backup lama dihapus` : ''}.` : `Terakhir (${how}): ✕ ${when} — gagal: ${last.error}`);
  }
  $('#ba-status').textContent = parts.join(' ');
  $('#ba-status').classList.toggle('warn', Boolean(last && !last.ok));
  const laptop = state.local !== false;
  $('#ba-run').disabled = v.running || !laptop || !v.schedule.folder;
  $('#ba-run').title = v.schedule.folder ? '' : 'Simpan folder tujuan dulu';
  $('#ba-save').disabled = !laptop;
}

function poll() {
  clearTimeout(auto.timer);
  if (!auto.view?.running || $('#settings-modal').hidden) return;
  auto.timer = setTimeout(async () => {
    const wasRunning = auto.view.running;
    await load({ keepForm: true });
    if (wasRunning && !auto.view.running && auto.view.last) toast(auto.view.last.ok ? `Backup tersimpan: ${auto.view.last.name}` : `Backup gagal: ${auto.view.last.error}`, auto.view.last.ok ? 'ok' : 'error');
    poll();
  }, POLL_MS);
}

/** The scheduled backups already in the folder, newest first; "Pulihkan" reuses the import merge. */
async function loadHistory() {
  if (state.local === false) return;
  try {
    const data = await api('/api/backup/schedule/history');
    auto.history = Array.isArray(data?.backups) ? data.backups : [];
  } catch {
    auto.history = [];
  }
  renderHistory();
}

function renderHistory() {
  const box = $('#ba-history');
  if (!box) return;
  const items = auto.history ?? [];
  box.hidden = !items.length;
  $('#ba-history-list').innerHTML = items
    .map(
      (b) => `<li class="ba-history-row"><span class="ba-h-name">${escapeHtml(b.name)}</span><span class="ba-h-meta">${escapeHtml(shortDate(b.at))} · ${fmtSize(b.bytes)}</span><button type="button" class="ghost" data-ba-restore="${escapeHtml(b.name)}">↩ Pulihkan</button></li>`,
    )
    .join('');
}

async function restoreHistory(btn) {
  const name = btn.dataset.baRestore;
  if (!window.confirm(`Pulihkan backup "${name}"?\n\nRiwayat digabung dengan yang ada sekarang; tidak ada yang dihapus.`)) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Memulihkan…';
  $('#ba-restore-status').textContent = '';
  try {
    const summary = await api('/api/backup/schedule/restore', { name });
    $('#ba-restore-status').textContent = `Dipulihkan: ${summary.projects} project, ${summary.sessions?.added ?? 0} sesi ditambahkan, ${summary.sessions?.updated ?? 0} diperbarui.`;
    toast(`Backup dipulihkan (${summary.projects} project).`, 'ok');
    loadHistory();
  } catch (err) {
    $('#ba-restore-status').textContent = `Gagal memulihkan: ${err.message}`;
    toast(`Gagal memulihkan backup: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function load({ keepForm = false } = {}) {
  if (state.local === false) return;
  try {
    auto.view = await api('/api/backup/schedule');
    if (!keepForm) fill(auto.view);
    renderStatus();
    loadHistory();
    poll();
  } catch (err) {
    $('#ba-status').textContent = `Gagal memuat jadwal backup: ${err.message}`;
  }
}

async function save() {
  setError('');
  const keep = Number($('#ba-keep').value);
  const body = {
    enabled: $('#ba-enabled').checked,
    frequency: $('#ba-frequency').value,
    weekday: Number($('#ba-weekday').value),
    time: $('#ba-time').value,
    keep: Number.isInteger(keep) ? keep : -1,
    folder: $('#ba-folder').value.trim(),
  };
  $('#ba-save').disabled = true;
  try {
    auto.view = await api('/api/backup/schedule/save', body);
    fill(auto.view);
    renderStatus();
    toast(body.enabled ? 'Jadwal backup disimpan.' : 'Pengaturan backup disimpan (backup otomatis nonaktif).', 'ok');
  } catch (err) {
    setError(err.message);
  } finally {
    $('#ba-save').disabled = false;
  }
}

async function runNow() {
  setError('');
  try {
    auto.view = await api('/api/backup/schedule/run');
    renderStatus();
    poll();
  } catch (err) {
    setError(err.message);
  }
}

export function initBackupAuto() {
  $('#ba-weekday').innerHTML = DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('');
  $('#btn-settings').addEventListener('click', () => {
    setError('');
    load();
  });
  $('#ba-frequency').addEventListener('change', syncFields);
  $('#ba-save').addEventListener('click', save);
  $('#ba-run').addEventListener('click', runNow);
  $('#ba-history-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ba-restore]');
    if (btn) restoreHistory(btn);
  });
  // The settings dialog is one <form> (roots): Enter in these fields saves the schedule, never that form.
  for (const sel of ['#ba-folder', '#ba-time', '#ba-keep']) {
    $(sel).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      save();
    });
  }
}
