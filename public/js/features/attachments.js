// Image attachments for a prompt: paste, drop, 📎.
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';

// ---------- image attachments (paste, drop, 📎) ----------

export const attachments = [];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function renderAttachments() {
  const box = $('#attachments');
  box.hidden = !attachments.length;
  box.innerHTML = attachments
    .map((a, i) => `<div class="thumb"><img src="${a.url}" alt=""><button data-i="${i}" title="Hapus" aria-label="Hapus gambar ${i + 1}">×</button></div>`)
    .join('');
}

export function clearAttachments() {
  attachments.length = 0;
  renderAttachments();
}

function addImageFiles(files) {
  if (state.readOnly) return;
  for (const file of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      toast('Hanya gambar PNG, JPEG, GIF, atau WebP.');
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast(`${file.name || 'Gambar'} lebih dari 5 MB.`);
      continue;
    }
    if (attachments.length >= 5) {
      toast('Maksimal 5 gambar per pesan.');
      break;
    }
    const reader = new FileReader();
    reader.onload = () => {
      attachments.push({ mediaType: file.type, data: String(reader.result).split(',')[1], url: reader.result });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

export function initAttachments() {
  $('#attachments').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    attachments.splice(Number(btn.dataset.i), 1);
    renderAttachments();
  });
  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    addImageFiles([...e.target.files]);
    e.target.value = '';
  });
  $('#prompt').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
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
    addImageFiles([...e.dataTransfer.files]);
  });
}
