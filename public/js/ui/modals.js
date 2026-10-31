// Dialogs: open/close, focus in and back out, Tab trap, and keyboard for role="button" elements.
import { $ } from '../core/dom.js';

export function openModal(id) {
  $(`#${id}`).hidden = false;
}

export function closeModal(id) {
  $(`#${id}`).hidden = true;
}

// Focus follows the dialogs: into a dialog when it opens, back to where it was when the last one closes.
// Dialogs open and close from many places (openModal, Esc, backdrop, ✕, direct `hidden` writes),
// so this watches the `hidden` attribute instead of hooking each of them.
const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
const openModals = () => [...document.querySelectorAll('.modal')].filter((m) => !m.hidden);
export const focusablesIn = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
let focusBeforeModal = null;

// The origin may have been re-rendered while the dialog was open (team cards every 500ms): find its replacement.
function focusOrigin() {
  const el = focusBeforeModal;
  if (!el || el.isConnected) return el;
  if (el.dataset?.role) return document.querySelector(`#team .member[data-role="${CSS.escape(el.dataset.role)}"]`);
  if (el.dataset?.path) return [...document.querySelectorAll('#ch-files li[data-path]')].find((li) => li.dataset.path === el.dataset.path) ?? null;
  return null;
}
const modalObserver = new MutationObserver((records) => {
  const changed = new Map(); // modal -> was it hidden before this batch
  for (const r of records) if (!changed.has(r.target)) changed.set(r.target, r.oldValue !== null);
  for (const [modal, wasHidden] of changed) {
    if (wasHidden === modal.hidden) continue; // re-setting the same value (e.g. closing a closed dialog)
    const active = document.activeElement;
    if (!modal.hidden) {
      // A caller that already placed focus (project search, a team member's name field) wins.
      if (!modal.contains(active)) focusablesIn(modal)[0]?.focus({ preventScroll: true });
    } else if (!openModals().length && (!active || active === document.body || modal.contains(active))) {
      const origin = focusOrigin();
      if (origin?.getClientRects().length) origin.focus({ preventScroll: true });
    }
  }
});

/** Registered first: the Tab trap must run before the composer's Shift+Tab handler (it checks defaultPrevented). */
export function initModals() {
  // ✕ buttons and clicks on the dimmed backdrop close the dialog.
  document.querySelectorAll('.modal').forEach((modal) =>
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close]')) modal.hidden = true;
    }),
  );

  document.addEventListener('focusin', (e) => {
    if (!e.target.closest?.('.modal')) focusBeforeModal = e.target;
  });
  // Focus leaving to nowhere (iOS keyboard dismissed, Safari taps that don't focus buttons) forgets the origin,
  // so closing a dialog never re-focuses a stale #prompt and pops the phone keyboard unasked.
  document.addEventListener('focusout', (e) => {
    if (!e.relatedTarget && !e.target.closest?.('.modal')) focusBeforeModal = null;
  });

  document.querySelectorAll('.modal').forEach((modal) => modalObserver.observe(modal, { attributeFilter: ['hidden'], attributeOldValue: true }));

  // Tab stays inside the topmost open dialog.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const modal = openModals().at(-1);
    if (!modal) return;
    const items = focusablesIn(modal);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    const active = document.activeElement;
    if (!modal.contains(active) || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  });

  // Clickable non-buttons (file rows, tool rows, team cards, the session title) carry role="button":
  // Enter/Space runs the same click handler a mouse would, through one delegated listener.
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target;
    if (!(el instanceof HTMLElement) || el.tagName === 'BUTTON' || el.getAttribute('role') !== 'button') return;
    e.preventDefault(); // Space would scroll the list
    el.click();
  });
}
