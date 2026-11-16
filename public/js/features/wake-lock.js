// Keep the phone's screen awake while a turn is running and the page is visible. Watching a long turn from away is
// the remote use case: without this the screen sleeps after a minute and the end of the turn (or the approval that
// follows) is missed. Battery first: the lock is released the moment nothing is running or the page is hidden, and
// the whole module is a no-op where the Wake Lock API is unavailable (iOS before 16.4, desktops).
import { shouldHoldWake } from '../core/wake-lock-rules.js';
import { state } from '../core/state.js';

let sentinel = null; // the active WakeLockSentinel, or null
let wanted = false; // the page *should* hold the lock right now
let requesting = false; // one request in flight at a time

const currentStatus = () => state.statuses[state.active] ?? {};

function release() {
  wanted = false;
  const lock = sentinel;
  sentinel = null;
  try {
    lock?.release?.();
  } catch {
    // already released by the system
  }
}

/**
 * Reconciles the wake lock with the current status + visibility. Safe to call on every render: it only acts when
 * the wanted state changed, and it never throws.
 * @param {{ busy?: boolean, cliBusy?: boolean, planPreparing?: unknown, compacting?: boolean }} [st]
 */
export async function syncWakeLock(st = currentStatus()) {
  wanted = shouldHoldWake(st, { hidden: document.hidden });
  if (!wanted) return release();
  if (sentinel || requesting || typeof navigator === 'undefined' || !navigator.wakeLock?.request) return;
  requesting = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    sentinel = lock;
    lock.addEventListener?.('release', () => {
      sentinel = null;
      // The system can release it at any time (screen off, another app, low battery). Take it back only while a
      // turn still runs and the page is visible; otherwise stay released.
      if (wanted && !document.hidden) setTimeout(() => void syncWakeLock(), 0);
    });
  } catch {
    sentinel = null; // not supported / denied: the app behaves exactly as before
  } finally {
    requesting = false;
  }
}

/** Wires the two events that change the answer (visibility, page teardown). Call once at start-up. */
export function initWakeLock() {
  document.addEventListener('visibilitychange', () => void syncWakeLock());
  window.addEventListener('pagehide', release);
}
