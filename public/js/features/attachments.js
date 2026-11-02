// 📎 Attachments for a prompt (paste, drop, 📎): images, PDF and text files (logs, source, md/json/csv/…).
// The rules (kinds, limits, refusals) live in core/attachment-rules.js and are applied again by the server.
import { toast } from '../core/api.js';
import { chipSignature, createAttachmentMemory } from '../core/attachment-memory.js';
import { ATTACH_ACCEPT, ATTACH_ICONS, ATTACH_LIMITS, checkAttachmentSet, formatSize, inspectAttachment, precheckAttachment, safeName } from '../core/attachment-rules.js';
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';

/** [{ kind, name, size, mediaType, data(base64), url? }] waiting to go out with the next prompt (active project). */
export const attachments = [];

// Chips of the projects not on screen (draft.js parks them on a project switch). Memory only, like `attachments`:
// never localStorage (size, and screenshots/logs can be private), so a reload empties it.
const parked = new Map(); // project -> attachment list
// Which project `attachments` belongs to (files still being read land in their own project's list).
let owner = null;

// The files sent with the last few web prompts per project, for ↻ Ulangi / Edit (core/attachment-memory.js).
const sent = createAttachmentMemory();
// Image chips carry a data: URL for the thumbnail; memory keeps only the base64 once and rebuilds the URL.
const withUrl = (a) => ({ ...a, url: a.kind === 'image' ? `data:${a.mediaType};base64,${a.data}` : undefined });

/** One chip: icon (a thumbnail for images in the composer), name, size, optional × button. */
export function attachmentChip({ kind, name, size, url }, removeIndex = null) {
  const icon = kind === 'image' && url ? `<img src="${escapeHtml(url)}" alt="">` : `<span class="att-icon" aria-hidden="true">${ATTACH_ICONS[kind] ?? '📄'}</span>`;
  const label = escapeHtml(safeName(name));
  const remove = removeIndex === null ? '' : `<button type="button" data-i="${removeIndex}" title="Hapus" aria-label="Hapus lampiran ${label}">×</button>`;
  return `<span class="att-chip" data-kind="${escapeHtml(kind)}" title="${label}"><span class="att-thumb">${icon}</span><span class="att-name">${label}</span><span class="att-size">${formatSize(size)}</span>${remove}</span>`;
}

function renderAttachments() {
  const box = $('#attachments');
  box.hidden = !attachments.length;
  box.innerHTML = attachments.map((a, i) => attachmentChip(a, i)).join('');
}

export function clearAttachments() {
  attachments.length = 0;
  renderAttachments();
}

/** Puts attachments back (a prompt the server refused), ahead of anything added meanwhile, in their own project. */
export function restoreAttachments(list, project = state.active) {
  const box = (owner ?? state.active) === project;
  const into = box ? attachments : (parked.get(project) ?? []);
  into.unshift(...list.slice(0, Math.max(0, ATTACH_LIMITS.maxFiles - into.length)));
  if (box) renderAttachments();
  else parked.set(project, into);
}

/**
 * Edit on a sent prompt: its files come back as chips. Chips already in the box stay (nothing the user added is
 * dropped) and a file already there is not added twice; the server still checks the totals on send.
 */
export function putBackAttachments(list) {
  const have = new Set(attachments.map((a) => chipSignature([a])));
  const fresh = list.filter((a) => !have.has(chipSignature([a])));
  attachments.push(...fresh.slice(0, Math.max(0, ATTACH_LIMITS.maxFiles - attachments.length)).map(withUrl));
  renderAttachments();
}

/**
 * Project switch (draft.js): the chips in the box stay with the project they were added for, in memory, and the
 * chosen project's parked chips come back. Same project again (a reconnect) = untouched.
 */
export function parkAttachments(to) {
  if (owner === to) return;
  if (owner && attachments.length) parked.set(owner, attachments.slice());
  else if (owner) parked.delete(owner);
  attachments.length = 0;
  attachments.push(...(parked.get(to) ?? []));
  parked.delete(to);
  owner = to;
  renderAttachments();
}

/** What the prompt API takes: { name, mediaType, data } (the server checks it all again). */
export const attachmentPayload = (list = attachments) => list.map(({ name, mediaType, data }) => ({ name, mediaType, data }));

/** The server accepted a prompt with these files: keep them (memory only) for ↻ Ulangi / Edit. */
export const rememberSent = (project, list) => sent.remember(project, list.map(({ url: _url, ...a }) => a));

/** The files of a sent prompt whose bubble shows `chips` (with thumbnails again), or null after a reload. */
export function recallSent(project, chips) {
  const items = sent.recall(project, chips);
  return items ? items.map(withUrl) : null;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Files are read one after another so the totals (count, text, size) are checked in order.
let reading = Promise.resolve();

export function addFiles(files) {
  if (state.readOnly || !files.length) return reading;
  const project = state.active;
  // The list the files go to: the box, or (after a project switch while reading) that project's parked chips.
  const target = () => {
    if ((owner ?? state.active) === project) return attachments;
    if (!parked.has(project)) parked.set(project, []);
    return parked.get(project);
  };
  reading = reading.then(async () => {
    for (const file of files) {
      const name = safeName(file.name);
      // Refuse early (before reading) what can never pass: unknown type, empty, too big, too many.
      const early = precheckAttachment(name, file.type, file.size);
      if (early) {
        toast(early);
        continue;
      }
      if (target().length >= ATTACH_LIMITS.maxFiles) {
        toast(checkAttachmentSet([...target(), { kind: 'text', size: 0 }]));
        break;
      }
      let bytes;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        toast(`${name} tidak bisa dibaca.`);
        continue;
      }
      const checked = inspectAttachment({ name, mediaType: file.type, bytes });
      if (!checked.ok) {
        toast(checked.error);
        continue;
      }
      const setError = checkAttachmentSet([...target(), checked.item]);
      if (setError) {
        toast(setError);
        continue;
      }
      const { kind: k, size, mediaType } = checked.item;
      const data = toBase64(bytes);
      const list = target();
      list.push(withUrl({ kind: k, name: checked.item.name, size, mediaType, data }));
      if (list === attachments) renderAttachments();
    }
  });
  return reading;
}

/** Waits until dropped/picked files are read (so a quick Enter doesn't send without them). */
export const attachmentsReady = () => reading;

export function initAttachments() {
  $('#file-input').accept = ATTACH_ACCEPT;
  $('#attachments').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    attachments.splice(Number(btn.dataset.i), 1);
    renderAttachments();
  });
  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('#prompt').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    // Text on the clipboard stays a normal paste (a long log too; apps like Excel add an image copy of it).
    if (!files.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    addFiles(files);
  });
  const inputBox = document.querySelector('.input');
  inputBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputBox.classList.add('drop');
  });
  inputBox.addEventListener('dragleave', () => inputBox.classList.remove('drop'));
  inputBox.addEventListener('drop', (e) => {
    e.preventDefault();
    inputBox.classList.remove('drop');
    addFiles([...e.dataTransfer.files]);
  });
}
