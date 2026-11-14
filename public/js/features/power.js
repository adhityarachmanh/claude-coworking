// ⚡ Daya: matikan PC atau server saja dari perangkat mana pun yang boleh mengubah (laptop, atau HP lewat Tailscale
// HTTPS). Panelnya sengaja ada di header + satu baris di sheet ⋯ HP: dialog ⚙ Pengaturan disembunyikan untuk perangkat
// jauh (body.remote-client) dan justru HP-lah yang dipakai mematikan PC dari jauh.
// Satu request /api/power/status per buka dialog (tanpa polling); jawaban server divalidasi sebelum ditampilkan, dan
// setiap nilai yang masuk ke DOM lewat textContent/atribut yang sudah dicek.
import { api, canCall, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';

const STATUS_PATH = '/api/power/status';
const SHUTDOWN_PATH = '/api/shutdown';
const MAX_DELAY = 600; // server: jeda sebelum listrik diputus (detik, 0…600)
const DEFAULT_DELAY = 120;
// Before the first snapshot the address is the best guess (core/stream.js sets state.local from the request's socket).
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Last /api/power/status answer, the request in flight, and the line the dialog shows while it works. */
const power = {
  loaded: false,
  loading: false,
  error: '',
  configured: false, // the server has a bridge URL + token (remote power on)
  bridgeUrl: '', // https only: it becomes an href
  delaySec: null,
  phase: 'idle', // 'idle' | 'busy' | 'done' (busy/done pin `note` in #power-status and keep the buttons off)
  note: '',
};

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isHttps = (v) => /^https:\/\/[^\s]+$/i.test(v);

/** Only the fields the dialog shows, in the shape it expects (the server's answer is not trusted as-is). */
export function normalizePowerStatus(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  // The route may answer { remotePower: {...} } (like /api/remote-power/get) or the fields at the top level.
  const rp = d.remotePower && typeof d.remotePower === 'object'
    ? d.remotePower
    : d.power && typeof d.power === 'object' ? d.power : d;
  const bridgeUrl = str(rp.bridgeUrl, 300);
  const delay = Number(rp.offDelaySec);
  const delaySec = Number.isInteger(delay) && delay >= 0 && delay <= MAX_DELAY ? delay : null;
  return {
    configured: rp.configured === true || d.configured === true || isHttps(bridgeUrl),
    bridgeUrl: isHttps(bridgeUrl) ? bridgeUrl : '',
    delaySec,
  };
}

/** The laptop itself, or a phone on the HTTPS (Tailscale) origin. A plain-WiFi phone may only look (state.readOnly). */
export function canPower() {
  if (state.local === undefined) return LOOPBACK.includes(location.hostname);
  return Boolean(state.local) || (state.secure === true && state.readOnly !== true);
}

function statusText() {
  if (power.phase !== 'idle') return power.note;
  if (power.error) return `⚠ ${power.error}`;
  if (power.loading) return 'Memeriksa remote power…';
  if (!power.loaded) return 'Remote power belum diperiksa.';
  if (!power.configured) {
    return 'Remote power belum diset — PC tetap dimatikan, tapi listrik tidak diputus otomatis (setel dari laptop: ⚙ → Sistem).';
  }
  return `Remote power siap (jeda ${power.delaySec ?? DEFAULT_DELAY} dtk).`;
}

function renderPower() {
  const modal = $('#power-modal');
  if (!modal) return;
  const status = $('#power-status');
  if (status) status.textContent = statusText();
  const bridge = $('#power-bridge');
  if (bridge) {
    const show = power.phase === 'idle' && Boolean(power.bridgeUrl);
    bridge.hidden = !show;
    if (show) bridge.href = power.bridgeUrl;
    else bridge.removeAttribute('href');
  }
  const usable = canPower() && power.phase !== 'done';
  const busy = power.phase === 'busy';
  for (const id of ['#power-pc', '#power-server']) {
    const btn = $(id);
    if (btn) btn.disabled = !usable || busy;
  }
}

/** The header button follows this device: laptop, or a phone over Tailscale HTTPS. Never a plain-WiFi phone. */
export function syncPowerButton() {
  const btn = $('#btn-power');
  if (!btn) return;
  const can = canPower();
  btn.hidden = !can;
  btn.disabled = !can;
  if (!can && !$('#power-modal')?.hidden) {
    power.phase = 'idle';
    closeModal('power-modal'); // the right to act went away (this page became a read-only client)
  }
}

/** One status request per open (a reopen during a slow one is ignored, so two never run at once). */
async function loadStatus() {
  if (power.loading || power.phase !== 'idle') return;
  if (!canCall(STATUS_PATH)) return; // the opener is hidden on such a device; the server refuses it too
  power.loading = true;
  power.error = '';
  renderPower();
  try {
    const data = await api(STATUS_PATH);
    Object.assign(power, normalizePowerStatus(data), { loaded: true });
  } catch (err) {
    power.error = `Gagal memeriksa remote power: ${err?.message ?? 'tidak diketahui'}`;
  } finally {
    power.loading = false;
    if (!$('#power-modal')?.hidden) renderPower();
  }
}

/**
 * Where the bridge's countdown page lives. The server forwards the bridge's relative path (`/s/…?t=…`), which belongs
 * to the bridge origin — not to this page. Only https (absolute) or a single-slash path is accepted, and the path is
 * resolved against the bridge URL: `javascript:`/`//host` never reaches location.href.
 */
export function handoffTarget(path, bridgeUrl = power.bridgeUrl) {
  const raw = str(path, 500);
  if (!raw || raw.startsWith('//')) return '';
  if (isHttps(raw)) return raw;
  if (!raw.startsWith('/')) return '';
  if (!isHttps(bridgeUrl)) return raw; // an older server without a status answer: its own path
  try {
    const url = new URL(raw, bridgeUrl);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

async function onShutdown(pc) {
  if (power.phase !== 'idle' || !canPower()) return;
  const delay = power.delaySec ?? DEFAULT_DELAY;
  const asked = pc
    ? window.confirm(power.configured
      ? `Matikan PC? Sesi Claude dihentikan, lalu listrik diputus jembatan ${delay} detik setelahnya.`
      : 'Matikan PC? Sesi Claude dihentikan, lalu listrik diputus jembatan. Remote power belum diset, jadi listrik tidak diputus otomatis.')
    : window.confirm('Matikan server saja? Sesi Claude dihentikan dan Adhitron tidak bisa dibuka sampai servernya dinyalakan lagi; PC tetap menyala.');
  if (!asked) return;
  power.phase = 'busy';
  power.note = pc ? '⏳ Mematikan PC…' : '⏳ Mematikan server…';
  renderPower();
  try {
    const out = await api(SHUTDOWN_PATH, { pc: Boolean(pc) });
    if (pc) {
      const target = handoffTarget(out?.handoffUrl);
      if (target) {
        power.note = '⏳ Membuka halaman jembatan…';
        renderPower();
        location.href = target; // the same tab: the bridge's countdown page (open in a new tab on a phone leaves it be)
        return;
      }
    }
    power.phase = 'done';
    power.note = pc
      ? '⏳ PC dimatikan — jembatan memutus listrik sebentar lagi.'
      : '⏳ Server dimatikan — halaman ini kehilangan sambungan sampai dinyalakan lagi.';
    renderPower();
  } catch (err) {
    power.phase = 'idle';
    power.note = '';
    toast(`Gagal mematikan: ${err?.message ?? 'tidak diketahui'}`, 'error');
    renderPower();
  }
}

export function initPower() {
  syncPowerButton();
  // The snapshot sets state.local/secure/readOnly and, for every device that is not the laptop, also flips the body
  // classes (remote-client / read-only): that is the moment this button appears or goes away. The laptop itself is
  // right from the first paint (loopback), so no polling is needed to wait for the snapshot.
  new MutationObserver(() => syncPowerButton()).observe(document.body, { attributeFilter: ['class'] });

  $('#btn-power')?.addEventListener('click', () => {
    if (!canPower()) return; // the server refuses it too
    power.phase = 'idle';
    power.note = '';
    openModal('power-modal');
    renderPower(); // the last answer (or "memeriksa…") shows at once; loadStatus refreshes it
    loadStatus();
  });
  $('#power-pc')?.addEventListener('click', () => onShutdown(true));
  $('#power-server')?.addEventListener('click', () => onShutdown(false));
}
