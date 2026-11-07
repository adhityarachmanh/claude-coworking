// ★ Pesan tersimpan: the messages starred in this project (core/bookmarks.js keeps them in this browser).
// Opened from Ctrl+P. "Buka" jumps to the row in the chat (loading older pages when the lazy window hid it).
import { toast } from '../core/api.js';
import { bookmarksOf, removeBookmark } from '../core/bookmarks.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { ago } from '../core/format.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { setMobileView } from '../ui/layout.js';
import { closeModal, openModal } from '../ui/modals.js';
import { replaceChat, revealChatMessage } from './chat.js';

let wired = false;

function render() {
  const list = bookmarksOf(state.active);
  $('#bookmarks-note').textContent = `${list.length} pesan di ${projectName(state.active)} · tersimpan di browser ini`;
  const box = $('#bookmarks-list');
  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="empty-icon">☆</div><b>Belum ada pesan tersimpan</b><p>Klik <b>☆ Simpan</b> pada pesan (atau <b>☆</b> di jawaban Claude) untuk menandainya, lalu buka lagi lewat Ctrl+P.</p></div>';
    return;
  }
  box.innerHTML = list
    .map(
      (b) => `<div class="bm-item">
        <div class="bm-head"><span class="bm-role">${b.role === 'user' ? 'Kamu' : 'Claude'}</span><span class="bm-time">${escapeHtml(ago(b.ts))}</span></div>
        <p class="bm-text">${escapeHtml(b.text)}</p>
        <div class="bm-actions"><button type="button" class="primary" data-open="${escapeHtml(b.id)}">Buka di chat</button><button type="button" class="ghost" data-remove="${escapeHtml(b.id)}">Hapus</button></div>
      </div>`,
    )
    .join('');
}

/** Switches to the chat, makes sure the row exists (the lazy window may hide it) and flashes it. */
function showInChat(id) {
  closeModal('bookmarks-modal');
  if (narrow.matches) setMobileView('chat');
  else document.querySelector('.tabs button[data-tab="chat"]')?.click();
  const node = revealChatMessage(id);
  if (!node) return toast('Pesan itu sudah tidak ada di riwayat chat (mungkin terpotong).', 'warn');
  node.scrollIntoView({ block: 'center' });
  node.classList.add('bm-flash');
  setTimeout(() => node.classList.remove('bm-flash'), 1600);
}

function onListClick(e) {
  const open = e.target.closest('[data-open]');
  if (open) return showInChat(open.dataset.open);
  const remove = e.target.closest('[data-remove]');
  if (!remove) return;
  removeBookmark(state.active, remove.dataset.remove);
  const msg = (state.chats[state.active] ?? []).find((m) => m.id === remove.dataset.remove);
  if (msg) replaceChat(msg); // the star on the row follows, when that row is on screen
  render();
  toast('Simpanan dihapus.', 'ok');
}

export function openBookmarks() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu untuk melihat pesan tersimpan.');
  if (!wired) {
    $('#bookmarks-list').addEventListener('click', onListClick);
    wired = true;
  }
  render();
  openModal('bookmarks-modal');
}
