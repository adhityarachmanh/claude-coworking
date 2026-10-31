// Global keys in the capture phase: Ctrl+K picker, ? help, Esc closes the topmost menu/dialog first.
import { $, isTyping } from '../core/dom.js';
import { toggleMoreMenu } from '../features/more-menu.js';
import { openProjects } from '../features/picker.js';
import { openModal } from './modals.js';

export function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openProjects();
    } else if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
      e.preventDefault();
      openModal('help-modal');
    } else if (e.key === 'Escape') {
      // Esc closes the topmost menu/dialog first; only with nothing open does it stop a running turn.
      if (!$('#more-menu').hidden) {
        toggleMoreMenu(false);
        e.stopImmediatePropagation();
        return;
      }
      const open = [...document.querySelectorAll('.modal')].filter((m) => !m.hidden).at(-1);
      if (open) {
        open.hidden = true;
        e.stopImmediatePropagation();
      }
    }
  }, true);
}
