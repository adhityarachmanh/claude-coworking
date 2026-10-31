// Connection to the laptop: a banner while the event stream is down, and what to do about it.
// The stream (core/stream.js) reports open/lost here; the composer reads `connection.online` before sending.
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { auth, state } from '../core/state.js';
import { renderSendState } from './composer.js';

// Thresholds (ms). A plain object so the UI test can shorten the wait for the "lama" message.
export const CONN_TIMING = {
  showAfterMs: 2000, // a quick reconnect (the browser retries every few seconds) never flashes the banner
  longAfterMs: 30000, // down this long: probably not a blip, say what to check
};

export const connection = {
  online: false, // false until the first `open`, so nothing is sent before the snapshot arrived
  lostAt: 0, // when the current outage started (0 = connected)
  shown: false, // banner visible (only then does reconnecting show "Tersambung lagi")
  timers: [],
  retries: 0, // consecutive refused streams, for the reconnect backoff
};

// Opened from the laptop itself or from a phone. The snapshot says so (client.local); before the first snapshot
// the address is the best guess (a phone always uses the laptop's Tailscale/LAN address, never localhost).
const isLaptop = () => state.local ?? ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

const MESSAGES = {
  short: 'Terputus dari laptop — menyambung lagi…',
  laptop: 'Server Adhit Office tidak berjalan — jalankan start-office.cmd',
  phone: 'Laptop tidak terjangkau — pastikan laptop menyala dan Tailscale/WiFi aktif',
};

/** Fills (or empties) the always-present live region, so screen readers announce each change. */
function renderBanner(kind) {
  const region = $('#conn-banner');
  if (!kind) {
    region.replaceChildren();
    return;
  }
  const box = document.createElement('div');
  box.className = `conn-banner${kind === 'short' ? '' : ' long'}`;
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'conn-text';
  text.textContent = kind === 'short' ? MESSAGES.short : `${MESSAGES[kind]} · menyambung lagi…`;
  box.append(spinner, text);
  region.replaceChildren(box);
}

function setPill(ok) {
  const conn = $('#conn');
  conn.textContent = ok ? 'terhubung' : 'terputus';
  conn.className = ok ? 'pill ok' : 'pill bad';
  conn.title = ok ? 'Tersambung ke laptop' : 'Terputus dari laptop — menyambung lagi';
}

function clearTimers() {
  connection.timers.forEach(clearTimeout);
  connection.timers = [];
}

/** The event stream dropped (or could not open). Repeated calls during one outage change nothing. */
export function streamLost() {
  setPill(false);
  if (connection.lostAt) return;
  connection.online = false;
  connection.lostAt = Date.now();
  renderSendState();
  clearTimers();
  connection.timers.push(
    setTimeout(() => {
      connection.shown = true;
      renderBanner('short');
    }, CONN_TIMING.showAfterMs),
    setTimeout(() => {
      connection.shown = true;
      renderBanner(isLaptop() ? 'laptop' : 'phone');
    }, CONN_TIMING.longAfterMs),
  );
}

/**
 * A restarted server has a new API token, so this page's would be refused ("forbidden") from now on.
 * Fetches the page again and takes the token from it (same origin, same as a reload, but the app keeps its state).
 */
async function refreshToken() {
  try {
    const res = await fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' });
    const token = /<meta name="office-token" content="([0-9a-f]+)"/.exec(await res.text())?.[1];
    if (res.ok && token) auth.token = token;
  } catch {
    // still flaky: the next reconnect tries again
  }
}

/** The event stream is (back) up. */
export async function streamOpened() {
  connection.retries = 0;
  if (connection.lostAt) {
    clearTimers();
    connection.lostAt = 0;
    await refreshToken(); // before sending is allowed again
    if (connection.lostAt) return; // dropped again meanwhile: that outage's banner timers are already running
  }
  const wasShown = connection.shown;
  connection.online = true;
  connection.shown = false;
  setPill(true);
  renderBanner(null);
  renderSendState();
  if (wasShown) toast('Tersambung lagi.', 'ok');
}

/** Delay before opening a new stream after the server refused one (the browser gives up on those by itself). */
export function retryDelay() {
  connection.retries += 1;
  return Math.min(30000, 2000 * 2 ** (connection.retries - 1));
}
