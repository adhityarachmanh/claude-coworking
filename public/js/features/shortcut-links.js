// 🔗 PWA shortcuts (manifest.webmanifest): "/?open=dashboard" / "/?open=sessions" launched from the app icon's
// long-press menu. The parameter is removed from the URL right away, then the dialog opens once the first snapshot
// (projects) has arrived — opening it earlier would show an empty dialog.
import { state } from '../core/state.js';
import { openDashboard } from './dashboard.js';
import { openSessions } from './sessions.js';

const OPEN = { dashboard: openDashboard, sessions: openSessions };

export function initShortcutLinks() {
  let params;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return;
  }
  const which = params.get('open');
  const run = OPEN[which];
  if (!run) return;
  try {
    params.delete('open');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch {
    // history unavailable: the parameter stays, which only means the dialog opens again on a reload
  }
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (!state.projects.length && tries < 50) return; // the first snapshot has not arrived yet (5 s at most)
    clearInterval(timer);
    run();
  }, 100);
}
