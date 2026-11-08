// ⚙ → Cadangkan riwayat: export the Claude Code history + office data as one .zip, and import it on another
// laptop (server: POST /api/backup/export and /api/backup/import, laptop only — see src/backup.js).
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { auth, state } from '../core/state.js';
import { saveBlob } from '../core/util.js';

const MB = 1024 * 1024;
const MAX_WARNINGS_SHOWN = 20;
const backup = { busy: false };

let pendingImport = null; // the file whose preview is on screen, waiting for "Pulihkan semua"
let previewProjects = []; // folder keys of the projects in the preview
/** base64url of a short ASCII JSON payload (project folder keys) for the X-Backup-Only header. */
const b64url = (text) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

/** The password typed for an encrypted backup (never sent when empty). */
function backupPasswordHeader() {
  const password = $('#backup-password')?.value ?? '';
  return password ? { 'X-Backup-Password': password } : {};
}

/** 🎲 A 20-character recovery key in groups (unambiguous alphabet), plus a simple strength line. */
function generateRecoveryKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const key = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  const grouped = key.match(/.{1,4}/g).join('-');
  $('#backup-password').value = grouped;
  updatePasswordStrength();
  setStatus('Kata sandi acak dibuat. Simpan sekarang — tidak ada pemulihan bila hilang.');
  return grouped;
}

function updatePasswordStrength() {
  const value = $('#backup-password')?.value ?? '';
  const el = $('#backup-strength');
  if (!el) return;
  if (!value) {
    el.textContent = 'Kosong: export menghasilkan .zip tanpa enkripsi.';
    return;
  }
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length;
  const level = value.length >= 20 && classes >= 3 ? 'sangat kuat' : value.length >= 12 && classes >= 2 ? 'kuat' : value.length >= 8 ? 'cukup' : 'terlalu pendek (min. 8)';
  el.textContent = `Kekuatan kata sandi: ${level}. Simpan di tempat aman; tidak ada pemulihan.`;
}

/** 🔎 Check a backup file (and its password) without restoring anything. */
async function verifyBackupFile(file) {
  setBusy(true);
  setStatus(`Memeriksa ${file.name} (${fmtSize(file.size)})…`);
  try {
    const res = await fetch('/api/backup/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-Office-Token': auth.token, ...backupPasswordHeader() },
      body: file,
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const info = await res.json();
    setStatus(`Backup valid${info.encrypted ? ' (terenkripsi)' : ''}: ${info.projects} project, ${info.sessions} sesi${info.createdAt ? ` · dibuat ${new Date(info.createdAt).toLocaleDateString('id-ID')}` : ''}.`);
    toast('File backup valid.', 'ok');
  } catch (err) {
    setStatus(`Verifikasi gagal: ${err.message}`);
    toast(`Backup tidak valid: ${err.message}`);
  } finally {
    setBusy(false);
    $('#backup-verify-file').value = '';
  }
}

/** 🔑 Re-encrypt a .aob with a new password and download the new file. */
async function rekeyBackupFile(file) {
  const oldPassword = $('#backup-password').value;
  if (!oldPassword) return setStatus('Isi kata sandi lama di kolom Kata sandi backup dulu.');
  const next = window.prompt('Kata sandi baru untuk backup ini (min. 8 karakter):', '') ?? '';
  if (!next) return;
  if (next.length < 8) return setStatus('Kata sandi baru minimal 8 karakter.');
  setBusy(true);
  setStatus(`Mengenkripsi ulang ${file.name}…`);
  try {
    const res = await fetch('/api/backup/rekey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-Office-Token': auth.token, 'X-Backup-Password': oldPassword, 'X-Backup-New-Password': next },
      body: file,
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'adhit-office-backup.aob';
    saveBlob(name, await res.blob());
    setStatus(`Backup dienkripsi ulang: ${name}. Kata sandi baru berlaku untuk file ini.`);
    toast('Kata sandi backup diganti.', 'ok');
  } catch (err) {
    setStatus(`Ganti sandi gagal: ${err.message}`);
  } finally {
    setBusy(false);
    $('#backup-rekey-file').value = '';
  }
}

async function exportHistory() {
  setBusy(true);
  const password = $('#backup-password')?.value ?? '';
  if (password && password.length < 8) {
    setBusy(false);
    setStatus('Kata sandi backup minimal 8 karakter (atau kosongkan untuk .zip biasa).');
    return;
  }
  setStatus(password ? 'Menyiapkan backup terenkripsi…' : 'Menyiapkan backup…');
  try {
    const res = await fetch('/api/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
      body: JSON.stringify(password ? { password } : {}),
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? (password ? 'adhit-office-backup.aob' : 'adhit-office-backup.zip');
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
    saveBlob(name, new Blob(chunks, { type: password ? 'application/octet-stream' : 'application/zip' }));
    setStatus(`Backup tersimpan: ${name} (${fmtSize(received)}).${password ? ' Terenkripsi dengan kata sandimu.' : ''} Simpan di tempat aman: isinya seluruh riwayat percakapanmu.`);
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

/** Keeps "Semua project" and the restore button in sync with the checkboxes. */
function syncPick() {
  const boxes = [...document.querySelectorAll('#backup-result .backup-pick-box')];
  const picked = boxes.filter((b) => b.checked).length;
  const all = $('#backup-pick-all');
  if (all) {
    all.checked = boxes.length > 0 && picked === boxes.length;
    all.indeterminate = picked > 0 && picked < boxes.length;
  }
  const btn = $('#backup-restore');
  if (btn) {
    btn.disabled = boxes.length > 0 && !picked;
    btn.textContent = boxes.length === 0 || picked === boxes.length ? 'Pulihkan semua' : `Pulihkan ${picked} project`;
  }
}

/** Shows what the archive holds, so the restore below is a decision, not a blind upload. */
function renderPreview(p, file) {
  const box = $('#backup-result');
  previewProjects = Array.isArray(p.projects) ? p.projects : [];
  box.replaceChildren(el('b', `Isi ${file.name}`));
  box.append(el('p', `${p.projects.length} project · ${p.sessions} sesi Claude · ${p.chatSessions} riwayat chat · ${fmtSize(p.unpackedBytes)}`, 'muted'));
  if (previewProjects.length) {
    const pick = el('fieldset', null, 'backup-pick');
    pick.append(el('legend', 'Project yang dipulihkan'));
    const allLabel = document.createElement('label');
    const allBox = document.createElement('input');
    allBox.type = 'checkbox';
    allBox.id = 'backup-pick-all';
    allBox.checked = true;
    allLabel.append(allBox, document.createTextNode(' Semua project'));
    pick.append(allLabel);
    allBox.addEventListener('change', () => {
      for (const b of document.querySelectorAll('#backup-result .backup-pick-box')) b.checked = allBox.checked;
      syncPick();
    });
    for (const proj of previewProjects) {
      const row = document.createElement('label');
      const pickBox = document.createElement('input');
      pickBox.type = 'checkbox';
      pickBox.className = 'backup-pick-box';
      pickBox.dataset.folder = proj.folder;
      pickBox.checked = true;
      pickBox.addEventListener('change', syncPick);
      row.append(pickBox, document.createTextNode(` ${proj.cwd ?? proj.folder} — ${proj.sessions} sesi`));
      pick.append(row);
    }
    box.append(pick);
  } else {
    box.append(el('p', 'Backup ini tidak berisi transkrip project (hanya data kantor).', 'muted'));
  }
  const partsBox = el('fieldset', null, 'backup-pick backup-parts');
  partsBox.append(el('legend', 'Data kantor yang ikut'));
  for (const [key, label] of [
    ['state', 'Pengaturan & folder project'],
    ['usage', 'Laporan token'],
    ['history', 'Riwayat prompt (↑)'],
  ]) {
    const row = document.createElement('label');
    const partBox = document.createElement('input');
    partBox.type = 'checkbox';
    partBox.className = 'backup-part-box';
    partBox.dataset.part = key;
    partBox.checked = true;
    row.append(partBox, document.createTextNode(` ${label}`));
    partsBox.append(row);
  }
  box.append(partsBox);
  const extra = [
    p.includes.state && 'pengaturan & folder',
    p.includes.usage && 'pemakaian token',
    p.includes.history && 'riwayat prompt',
    p.includes.fileHistory && `${p.includes.fileHistory} checkpoint`,
    p.includes.plans && `${p.includes.plans} rencana`,
    p.chats.opencode && 'chat OpenCode',
  ].filter(Boolean);
  if (extra.length) box.append(el('p', `Ikut: ${extra.join(', ')}.`, 'muted'));
  if (p.createdAt) box.append(el('p', `Dibuat ${new Date(p.createdAt).toLocaleString('id-ID')}${p.source?.appVersion ? ` · versi ${p.source.appVersion}` : ''}.`, 'muted'));
  const actions = el('div', null, 'backup-actions');
  const restore = el('button', 'Pulihkan semua', 'primary');
  restore.type = 'button';
  restore.id = 'backup-restore';
  restore.addEventListener('click', () => restorePending());
  const cancel = el('button', 'Batal', 'ghost');
  cancel.type = 'button';
  cancel.id = 'backup-cancel';
  cancel.addEventListener('click', () => {
    pendingImport = null;
    box.hidden = true;
    setStatus('');
  });
  actions.append(restore, cancel);
  box.append(actions);
  box.append(el('p', 'Riwayat digabung dengan yang sudah ada: sesi dan file yang belum ada ditambahkan, tidak ada yang dihapus. Hanya import file backup milikmu sendiri.', 'muted'));
  box.hidden = false;
  syncPick();
}

/** Step 1: read the .zip (server writes nothing) and show it. */
async function previewHistory(file) {
  if (!/\.(zip|aob)$/i.test(file.name)) {
    toast('Pilih file .zip atau .aob hasil Export riwayat.');
    return;
  }
  pendingImport = null;
  $('#backup-result').hidden = true;
  setBusy(true);
  setStatus(`Membaca isi ${file.name} (${fmtSize(file.size)})…`);
  try {
    const res = await fetch('/api/backup/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-Office-Token': auth.token, ...backupPasswordHeader() },
      body: file,
    });
    if (!res.ok) throw new Error(await errorOf(res));
    pendingImport = file;
    renderPreview(await res.json(), file);
    setStatus(`Pratinjau ${file.name}: periksa isinya, lalu pilih Pulihkan semua.`);
  } catch (err) {
    setStatus(`Tidak bisa membaca backup: ${err.message}`);
    toast(`Backup tidak bisa dibaca: ${err.message}`);
  } finally {
    setBusy(false);
    $('#backup-file').value = ''; // the same file can be picked again after cancel
  }
}

/** Step 2: the button in the preview; the unchecked projects stay behind. */
async function restorePending() {
  const file = pendingImport;
  if (!file || backup.busy) return;
  const boxes = [...document.querySelectorAll('#backup-result .backup-pick-box')];
  const picked = boxes.filter((b) => b.checked).map((b) => b.dataset.folder);
  if (boxes.length && !picked.length) return; // nothing chosen: the button is disabled anyway
  const partBoxes = [...document.querySelectorAll('#backup-result .backup-part-box')];
  const parts = Object.fromEntries(partBoxes.map((b) => [b.dataset.part, b.checked]));
  pendingImport = null;
  await importHistory(file, boxes.length && picked.length < boxes.length ? picked : null, partBoxes.some((b) => !b.checked) ? parts : null);
}

async function importHistory(file, only = null, parts = null) {
  setBusy(true);
  $('#backup-result').hidden = true;
  setStatus(`Mengunggah dan memulihkan ${fmtSize(file.size)}… (bisa beberapa menit, jangan tutup halaman ini)`);
  try {
    const headers = { 'Content-Type': 'application/zip', 'X-Office-Token': auth.token, ...backupPasswordHeader() };
    if (only?.length) headers['X-Backup-Only'] = b64url(JSON.stringify(only));
    if (parts) headers['X-Backup-Parts'] = b64url(JSON.stringify(parts));
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      headers,
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
    $('#backup-file').value = '';
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
    if (file) previewHistory(file);
  });
  $('#btn-backup-verify').addEventListener('click', () => {
    if (!backup.busy) $('#backup-verify-file').click();
  });
  $('#backup-verify-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) verifyBackupFile(file);
  });
  $('#btn-backup-rekey').addEventListener('click', () => {
    if (!backup.busy) $('#backup-rekey-file').click();
  });
  $('#backup-rekey-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) rekeyBackupFile(file);
  });
  $('#backup-generate').addEventListener('click', generateRecoveryKey);
  $('#backup-copy-password').addEventListener('click', async () => {
    const value = $('#backup-password').value;
    if (!value) return setStatus('Isi atau buat kata sandi dulu.');
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Kata sandi disalin. Simpan di tempat aman.');
    } catch {
      setStatus('Gagal menyalin; salin manual dari kolom kata sandi.');
    }
  });
  $('#backup-password').addEventListener('input', updatePasswordStrength);
  updatePasswordStrength();
}
