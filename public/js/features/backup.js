// ⚙ → Cadangkan riwayat: export the Claude Code history + office data as one .zip, and import it on another
// laptop (server: POST /api/backup/export and /api/backup/import, laptop only — see src/backup.js).
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { auth, state } from '../core/state.js';
import { saveBlob } from '../core/util.js';

const MB = 1024 * 1024;
const MAX_WARNINGS_SHOWN = 20;
const backup = { busy: false };

/** "12,3 MB" / "840 KB" */
const fmtSize = (bytes) => (bytes >= MB ? `${(bytes / MB).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const setStatus = (text) => ($('#backup-status').textContent = text);

/** Buttons follow the device (laptop only) and whether an export/import is running. */
function renderAccess() {
  const laptop = state.local !== false;
  $('#backup-remote').hidden = laptop;
  $('#btn-backup-export').disabled = backup.busy || !laptop;
  $('#btn-backup-import').disabled = backup.busy || !laptop;
}

function setBusy(on) {
  backup.busy = on;
  renderAccess();
}

async function errorOf(res) {
  const data = await res.json().catch(() => ({}));
  return data.error ?? `HTTP ${res.status}`;
}

async function exportHistory() {
  setBusy(true);
  setStatus('Menyiapkan backup…');
  try {
    const res = await fetch('/api/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
      body: '{}',
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'adhit-office-backup.zip';
    // Read it ourselves (instead of res.blob()) to show how much has arrived.
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    let shown = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received - shown >= MB) {
        shown = received;
        setStatus(`Mengunduh backup… ${fmtSize(received)}`);
      }
    }
    saveBlob(name, new Blob(chunks, { type: 'application/zip' }));
    setStatus(`Backup tersimpan: ${name} (${fmtSize(received)}). Simpan di tempat aman: isinya seluruh riwayat percakapanmu.`);
  } catch (err) {
    setStatus(`Export gagal: ${err.message}`);
    toast(`Export riwayat gagal: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

/** A <li> (or any tag) with plain text: server strings never go through innerHTML. */
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderResult(r) {
  const box = $('#backup-result');
  box.replaceChildren(el('b', 'Hasil import'));
  const list = el('ul');
  const s = r.sessions;
  const f = r.files;
  list.append(
    el('li', `${r.projects} folder project · sesi: ${s.added} ditambah, ${s.updated} dilanjutkan dari backup, ${s.skipped} dilewati`),
    el('li', `File lain (subagent, memori, checkpoint, rencana): ${f.added} ditambah, ${f.skipped} dilewati${f.copies ? `, ${f.copies} disimpan sebagai .from-backup (tidak menimpa)` : ''}`),
    el('li', `Riwayat prompt: +${r.history.added} baris · laporan token: +${r.usage.added} catatan`),
  );
  const st = r.state ?? {};
  const stateParts = [st.roots && `${st.roots} folder induk`, st.custom && `${st.custom} folder`, st.favorites && `${st.favorites} favorit`, st.settings && `${st.settings} pengaturan project (tanpa mode izin)`, st.engines && `${st.engines} mesin project`, st.engineSettings && `${st.engineSettings} pengaturan per mesin`, st.sessions && `${st.sessions} percakapan per mesin`, st.teamNames && `${st.teamNames} nama tim`].filter(Boolean);
  if (stateParts.length) list.append(el('li', `Data kantor digabung: ${stateParts.join(', ')}`));
  if (r.projectsAdded?.length) list.append(el('li', `Project ditambahkan: ${r.projectsAdded.join(', ')}`));
  box.append(list);

  if (r.remapped?.length) {
    const details = el('details');
    details.append(el('summary', `Folder dipindah ke home laptop ini: ${r.remapped.length} project`));
    const ul = el('ul');
    for (const m of r.remapped) ul.append(el('li', m.newCwd ? `${m.cwd} → ${m.newCwd}` : `${m.from} → ${m.to}`));
    details.append(ul);
    box.append(details);
  }
  if (r.warnings?.length) {
    const details = el('details');
    details.open = true;
    details.append(el('summary', `⚠ ${r.warnings.length} peringatan`, 'warn'));
    const ul = el('ul');
    for (const w of r.warnings.slice(0, MAX_WARNINGS_SHOWN)) ul.append(el('li', w));
    if (r.warnings.length > MAX_WARNINGS_SHOWN) ul.append(el('li', `…dan ${r.warnings.length - MAX_WARNINGS_SHOWN} lainnya`));
    details.append(ul);
    box.append(details);
  }
  // The project's engine and its Claude conversation may come back with the backup; OpenCode session ids never do
  // (their store is not archived). Mode izin tetap tidak ikut.
  box.append(el('p', 'Buka Riwayat sesi di project-nya untuk melanjutkan percakapan (atau jalankan claude --resume di folder project). Mode izin tidak ikut dipulihkan: tetap Manual. Mesin project ikut dipulihkan bila OpenCode terpasang; bila tidak, project dari backup memakai Claude Code.', 'muted'));
  box.hidden = false;
}

async function importHistory(file) {
  if (!/\.zip$/i.test(file.name)) {
    toast('Pilih file .zip hasil Export riwayat.');
    return;
  }
  const ok = window.confirm(
    `Import riwayat dari "${file.name}" (${fmtSize(file.size)})?\n\n` +
      'Riwayat digabung dengan yang sudah ada di laptop ini: sesi dan file yang belum ada ditambahkan, file yang sudah ada tidak ditimpa (kecuali lanjutan sesi yang sama), dan tidak ada yang dihapus. Hanya import file backup milikmu sendiri.',
  );
  if (!ok) return;
  setBusy(true);
  $('#backup-result').hidden = true;
  setStatus(`Mengunggah dan memulihkan ${fmtSize(file.size)}… (bisa beberapa menit, jangan tutup halaman ini)`);
  try {
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-Office-Token': auth.token },
      body: file,
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const summary = await res.json();
    renderResult(summary);
    setStatus(`Import selesai: ${summary.sessions.added} sesi ditambahkan, ${summary.sessions.updated} diperbarui.`);
    toast('Riwayat dipulihkan.', 'ok');
    // The server already rescanned the projects and broadcast the list; the session list loads fresh when opened.
  } catch (err) {
    setStatus(`Import gagal: ${err.message}`);
    toast(`Import riwayat gagal: ${err.message}`);
  } finally {
    setBusy(false);
    $('#backup-file').value = ''; // the same file can be picked again
  }
}

export function initBackup() {
  renderAccess();
  // The device is known from the snapshot; the dialog only opens after it arrived.
  $('#btn-settings').addEventListener('click', renderAccess);
  $('#btn-backup-export').addEventListener('click', () => {
    if (!backup.busy) exportHistory();
  });
  $('#btn-backup-import').addEventListener('click', () => {
    if (!backup.busy) $('#backup-file').click();
  });
  $('#backup-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importHistory(file);
  });
}
