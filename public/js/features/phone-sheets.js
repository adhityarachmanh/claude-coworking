// Phone views (≤ 760 px or a phone sideways, docs/design-mobile-chat.md): the ＋ sheet, the turn-settings sheet and the
// header ⋯ sheet (view-aware: Chat → session/conversation rows, Perubahan → git rows, every view → Lainnya).
// Every row/tile forwards a click to a control that already exists (data-proxy), so shortcuts, tests and the
// read-only rules keep working on the original controls; this module only opens sheets and fills labels.
import { $, narrow } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { openRewind } from './rewind.js';

const SHEETS = ['plus-modal', 'turn-settings-modal', 'head-more-modal'];
const RO_REASON = 'Hanya dari laptop/Tailscale';

/** The chip's place on a phone: in the input toolbar, right after ＋ (on a laptop it sits above the input). */
let chipHome = null;

/**
 * The composer's own selects (Izin, Model, Effort, Mode tim) always live in the "Pengaturan giliran" dialog (same
 * nodes, same listeners), opened by the summary chip: a long model list (OpenCode: dozens) fits a dialog, not a row.
 * Phone: the chip sits in the input toolbar; laptop: on its own line above the input.
 */
export function placeControls() {
  const controls = document.querySelector('.controls');
  const body = $('#turn-settings-modal .sheet-body');
  if (controls && controls.parentElement !== body) body.append(controls);
  const chip = $('#settings-chip');
  if (narrow.matches) {
    if (chipHome && chip.parentElement !== chipHome.parent) chipHome.parent.insertBefore(chip, chipHome.next);
  } else {
    if (chip.parentElement !== $('#composer')) $('#composer').insertBefore(chip, $('#suggest'));
    for (const id of SHEETS) if (id !== 'turn-settings-modal' && !$(`#${id}`).hidden) closeModal(id); // a rotated phone
  }
}

/** The phone view on screen: 'office', or the panel tab ('chat' | 'changes' | 'activity'). */
const currentView = () => (document.body.dataset.view === 'office' ? 'office' : state.tab || 'chat');

/** The ⋯ sheet's rows: label text, hidden rows (control absent here), disabled rows with a visible reason. */
function renderHeadMore() {
  const st = state.statuses[state.active] ?? {};
  const project = state.projects?.find((p) => p.id === state.active);
  $('#hm-project').textContent = project?.name ?? 'Adhitron';
  $('#hm-title').textContent = $('#sb-title').textContent;
  $('#hm-meta').textContent = $('#sb-meta').textContent;
  const quota = $('#quota-pill');
  const account = $('#account-label').textContent.trim() || 'Akun';
  $('#hm-account').textContent = quota.hidden ? account : `${account} · kuota ${quota.textContent.trim()}`;
  $('#hm-quota-dot').hidden = quota.hidden;
  $('#hm-quota-dot').className = `hm-dot ${quota.classList.contains('crit') ? 'crit' : 'warn'}`;
  $('#hm-music').textContent = $('#spotify-pill-text').textContent.trim() ? `Musik · ${$('#spotify-pill-text').textContent.trim()}` : 'Musik';

  // View-aware: a [data-view] block shows only in its phone view (Chat rows in Chat, git rows in Perubahan).
  const view = currentView();
  for (const block of document.querySelectorAll('#head-more-modal [data-view]')) {
    const showIf = block.dataset.showIf ? $(block.dataset.showIf) : null;
    block.hidden = block.dataset.view !== view || Boolean(showIf?.hidden);
  }
  for (const row of document.querySelectorAll('#head-more-modal .sheet-row')) {
    if (row.closest('[data-view][hidden]')) continue;
    const target = row.dataset.proxy ? document.querySelector(row.dataset.proxy) : null;
    const showIf = row.dataset.showIf ? $(row.dataset.showIf) : null;
    row.hidden = Boolean(
      (row.dataset.proxy && !target) ||
        (target && !('always' in row.dataset) && target.hidden) ||
        (showIf && showIf.hidden) ||
        ('needsSession' in row.dataset && !st.sessionId) ||
        (state.active === DEMO_ID && Boolean(row.closest('[data-needs-project]'))), // demo: no session to act on
    );
    // WiFi view-only: a row that would change something is disabled and says why, in text (no tooltips on a phone).
    // [data-reason] rows (git) are also off while their control is (no remote, no upstream…): the row's own reason, else the control's title.
    const readOnly = state.readOnly && ('mutates' in row.dataset || Boolean(target?.disabled));
    const blocked = readOnly || ('reason' in row.dataset && Boolean(target?.disabled));
    row.disabled = blocked;
    let note = row.querySelector('.sheet-row-note');
    if (blocked && !note) {
      note = document.createElement('small');
      note.className = 'sheet-row-note';
      row.append(note);
    }
    if (blocked) note.textContent = readOnly ? RO_REASON : row.dataset.reason || target.title || 'Belum bisa sekarang';
    else note?.remove();
  }
}

/** The ＋ sheet: 🎤 only where voice works, the 📋 label follows the box, / only into an empty box. */
function renderPlus() {
  const text = $('#prompt').value.trim();
  $('#plus-queue-label').textContent = text ? 'Tambah ke antrian' : 'Buka antrian';
  $('#plus-modal [data-proxy="#btn-voice"]').hidden = $('#btn-voice').hidden;
  const slash = $('#plus-modal [data-insert="/"]');
  slash.disabled = Boolean(text);
  $('#plus-slash-note').hidden = !text;
}

/** ! at the start, @ at the cursor, / into an empty box; then the box gets focus and the suggestions run. */
function insertToken(token) {
  const input = $('#prompt');
  if (token === '!') {
    if (!input.value.startsWith('!')) input.value = `!${input.value}`;
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (token === '/') {
    if (input.value.trim()) return;
    input.value = '/';
    input.setSelectionRange(1, 1);
  } else {
    const start = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, start);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    input.setRangeText(`${lead}@`, start, input.selectionEnd ?? start, 'end');
  }
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true })); // autosize, bash mode, draft, / @ suggestions
}

function onSheetClick(e) {
  const item = e.target.closest('[data-proxy], [data-insert], [data-action]');
  if (!item || item.disabled) return;
  const sheet = item.closest('.modal');
  // Close first, then forward in the same click handler: a file picker (📎) needs the user's gesture,
  // and a dialog opened by the target takes focus after the sheet is gone.
  sheet.hidden = true;
  if (item.dataset.insert) insertToken(item.dataset.insert);
  else if (item.dataset.action === 'rewind') openRewind();
  else document.querySelector(item.dataset.proxy)?.click();
}

export function initPhoneSheets() {
  chipHome = { parent: $('#settings-chip').parentElement, next: $('#settings-chip').nextElementSibling };
  placeControls();
  narrow.addEventListener('change', placeControls);

  $('#btn-plus').addEventListener('click', () => {
    renderPlus();
    openModal('plus-modal');
  });
  $('#settings-chip').addEventListener('click', () => openModal('turn-settings-modal'));
  $('#btn-head-more').addEventListener('click', () => {
    renderHeadMore();
    openModal('head-more-modal');
  });
  $('#typing-stop').addEventListener('click', () => $('#btn-stop').click());
  for (const id of SHEETS) $(`#${id}`).addEventListener('click', onSheetClick);
}
