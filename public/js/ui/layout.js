// Page chrome: title badge, phone bottom navigation, panel tabs, resizable chat panel.
import { $, isTyping, narrow } from '../core/dom.js';
import { APP_NAME, state } from '../core/state.js';
import { loadChanges } from '../features/changes.js';
import { keepChatPinned, scrollChat } from '../features/chat.js';

export function updateTitle() {
  const pending = [...state.approvals.values()].filter((a) => a.status === 'pending').length;
  document.title = pending ? `(${pending}) Menunggu izin — ${APP_NAME}` : APP_NAME;
  const badge = $('#nav-badge-chat');
  badge.hidden = !pending;
  badge.textContent = pending;
}

// ---------- phone layout: bottom navigation between full-screen views ----------

export function setMobileView(view) {
  document.body.dataset.view = view === 'office' ? 'office' : 'panel';
  if (view !== 'office') document.querySelector(`.tabs button[data-tab="${view}"]`)?.click();
  document.querySelectorAll('#mobile-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

// ---------- phone: swipe left/right between the full-screen views ----------

const SWIPE_ORDER = ['office', 'chat', 'changes', 'activity'];
const SWIPE_X = 60; // horizontal travel that counts as a swipe (not a tap or a small wobble)
const SWIPE_Y = 50; // …and the finger must stay this close vertically (a diagonal drag is a scroll)
const SWIPE_EDGE = 24; // the screen edges belong to the browser (back gesture, system bars)

/**
 * Swipe sideways on a phone to move between Kantor → Chat → Perubahan → Aktivitas (and back). A gesture that
 * starts in a field, a dialog, or a horizontally scrolling pane (diff, table, code) keeps its own meaning.
 */
export function initSwipeViews() {
  let start = null;
  const blocked = (target) => {
    if (!target || !(target instanceof Element)) return true;
    if (target.closest('dialog, .modal, input, textarea, select, [contenteditable="true"]')) return true;
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      const style = getComputedStyle(el);
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) return true;
    }
    return false;
  };
  document.addEventListener(
    'touchstart',
    (e) => {
      start = null;
      if (!narrow.matches || e.touches.length !== 1 || blocked(e.target)) return;
      const t = e.touches[0];
      if (t.clientX < SWIPE_EDGE || t.clientX > window.innerWidth - SWIPE_EDGE) return;
      start = { x: t.clientX, y: t.clientY, view: document.body.dataset.view === 'office' ? 'office' : (state.tab ?? 'chat') };
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      // Once the drag is clearly sideways it is ours: stop the browser's own back/forward swipe.
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener(
    'touchend',
    (e) => {
      const from = start;
      start = null;
      if (!from || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;
      if (Math.abs(dx) < SWIPE_X || Math.abs(dy) > SWIPE_Y || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const at = SWIPE_ORDER.indexOf(from.view);
      const next = at < 0 ? -1 : at + (dx < 0 ? 1 : -1); // swipe left: the view that lives on the right
      if (next < 0 || next >= SWIPE_ORDER.length) return;
      setMobileView(SWIPE_ORDER[next]);
    },
    { passive: true },
  );
}

export function initMobileNav() {
  $('#mobile-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) setMobileView(btn.dataset.view);
  });
}

export function initTabs() {
  // Only the tab buttons themselves: the bar also holds a tab-action (🔍 search) that must not switch tabs.
  document.querySelectorAll('.tabs button[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      document.body.dataset.tab = state.tab; // phone layout shows the composer only on the chat tab
      // A tab switched from code (🔍 Minta review → Chat) moves the phone's bottom-nav highlight along.
      if (document.body.dataset.view !== 'office') document.querySelectorAll('#mobile-nav button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.tab));
      $('.chat-wrap').hidden = state.tab !== 'chat';
      $('#changes').hidden = state.tab !== 'changes';
      if (state.tab === 'chat') scrollChat(true);
      if (state.tab === 'changes') loadChanges();
      $('#activity').hidden = state.tab !== 'activity';
    }),
  );
}

// ---------- phone keyboard: composer above it, bottom nav out of the way ----------

const KEYBOARD_MIN = 120; // px of height lost to count as an on-screen keyboard (not a URL bar collapsing)

/**
 * The visual viewport shrinks when the on-screen keyboard opens (iOS; Android with resizes-content shrinks the
 * layout viewport too, so the comparison is against the tallest height seen at this width, not innerHeight).
 * Event-driven only: visualViewport `resize` plus focus changes, no polling.
 */
export function initKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  let width = window.innerWidth;
  let tallest = Math.max(window.innerHeight, vv.height);
  const update = () => {
    if (window.innerWidth !== width) {
      width = window.innerWidth; // rotated / resized: start over
      tallest = 0;
    }
    tallest = Math.max(tallest, window.innerHeight, vv.height);
    const open = narrow.matches && tallest - vv.height > KEYBOARD_MIN && isTyping(document.activeElement);
    const body = document.body;
    if (open) body.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
    else body.style.removeProperty('--vv-h');
    if (open !== body.classList.contains('kb-open')) body.classList.toggle('kb-open', open);
    if (open && document.scrollingElement.scrollTop) document.scrollingElement.scrollTop = 0; // iOS pans the page up
    if (narrow.matches) keepChatPinned(); // the chat got shorter or taller: the newest message stays in view
  };
  vv.addEventListener('resize', update);
  document.addEventListener('focusout', () => requestAnimationFrame(update)); // keyboard closing without a resize yet
}

// ---------- resizable chat panel (desktop) ----------

const PANEL_MIN = 340; // narrower and the composer controls wrap badly
const PANEL_MAX = 960;
const OFFICE_MIN = 480; // the office keeps at least this much room
const panelBounds = () => [PANEL_MIN, Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - OFFICE_MIN))];

function setPanelWidth(px, persist = true) {
  const layout = $('.layout');
  if (px == null) {
    layout.style.removeProperty('--panel-w'); // back to the CSS default (410px / 380px)
    if (persist) try { localStorage.removeItem('office.panelWidth'); } catch {}
    return;
  }
  const [min, max] = panelBounds();
  const width = Math.round(Math.min(max, Math.max(min, px)));
  layout.style.setProperty('--panel-w', `${width}px`);
  if (persist) try { localStorage.setItem('office.panelWidth', String(width)); } catch {}
}

export function initPanelResizer() {
  const resizer = $('#panel-resizer');
  const saved = (() => { try { return Number(localStorage.getItem('office.panelWidth')); } catch { return 0; } })();
  if (saved) setPanelWidth(saved, false);

  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    // The panel sits on the right, so its width is the distance from the pointer to the window's right edge.
    const onMove = (ev) => setPanelWidth(window.innerWidth - ev.clientX, false);
    const onUp = () => {
      resizer.removeEventListener('pointermove', onMove);
      document.body.classList.remove('resizing');
      setPanelWidth($('.panel').getBoundingClientRect().width);
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp, { once: true });
    resizer.addEventListener('pointercancel', onUp, { once: true });
  });
  resizer.addEventListener('dblclick', () => setPanelWidth(null));
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 20;
    const width = $('.panel').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setPanelWidth(width + step);
    else if (e.key === 'ArrowRight') setPanelWidth(width - step);
    else return;
    e.preventDefault();
  });
  // Re-clamp a saved width when the window shrinks, without overwriting the preference.
  window.addEventListener('resize', () => {
    const want = (() => { try { return Number(localStorage.getItem('office.panelWidth')); } catch { return 0; } })();
    if (want) setPanelWidth(want, false);
  });
}
