// ♪ Spotify (docs/design-spotify.md §6): the now-playing pill in the top bar, the ♪ Musik dialog (controls, volume,
// devices, playlists), the 🗂 dashboard row, the ⚙ Spotify section (laptop), the office radio's button and the
// Ctrl+P entries. The server drives a Spotify Connect device and pushes `publicState()` (snapshot + SSE `spotify`);
// this page only shows it and POSTs /api/spotify/*. Over plain WiFi the page may look but not act (api.js canCall,
// from the server's own allowlist). Titles and artists are untrusted: they reach the page through textContent and
// attributes only. Album art comes from /api/spotify/art as bytes → blob: URL (the CSP stays as it is).
import { api, canCall, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { stage } from '../core/scenes.js';
import { READ_ONLY_HINT, state } from '../core/state.js';
import { CLIENT_ID_RE, DUCK_MODES, LAUNCHING_TEXT, SETTINGS_HINT, canStart, clockTime, cleanState, controlBlock, deviceIcon, fmtTime, hasTrack, isConnected, progressAt, radioLabel, statusText, trackLine } from '../core/spotify-rules.js';
import { radio } from '../office/radio.js';
import { closeModal, openModal } from '../ui/modals.js';

const P = {
  state: '/api/spotify/state',
  art: '/api/spotify/art',
  devices: '/api/spotify/devices',
  playlists: '/api/spotify/playlists',
  items: '/api/spotify/playlist-items', // a playlist's tracks (laptop + Tailscale)
  control: '/api/spotify/control',
  config: '/api/spotify/config', // laptop only: Client ID, office toggle, duck, autoLaunch
  settings: '/api/spotify/settings', // duck + autoLaunch: laptop and Tailscale phones
  login: '/api/spotify/login',
  logout: '/api/spotify/logout',
};
const DEVICE_ID = /^[\w-]{1,128}$/;
const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const ART_ID = /^[0-9a-f]{16}$/;
const TRACK_ID = /^[A-Za-z0-9]{22}$/;
const VOLUME_DEBOUNCE_MS = 250;
const PLAYLIST_CACHE_MS = 5 * 60_000;

export const music = {
  available: false, // the server has Spotify support (its snapshot carries `spotify`)
  s: null, // the cleaned publicState()
  tick: null, // 1 s progress timer, only while playing
  busy: false, // a control request in flight: buttons wait (a doubled "next" is worse than a failed one)
  trackArt: { id: null, url: null }, // the current song's art (pill, dialog, dashboard share it)
  plArt: new Map(), // playlist artId -> blob: URL, only while the dialog is open
  artLoads: new Map(), // artId -> Promise<string|null> (no double downloads)
  devices: [],
  thisLaptop: null, // { preferred } : "💻 Laptop ini" (its Spotify is closed; the server can start it), or null
  playlists: [],
  plNext: null,
  plAt: 0,
  plBusy: false,
  plObserver: null,
  tr: null, // the playlist drilled into: { playlist, items, next, total, busy }
  volTimer: null,
  volTouched: 0,
  volLast: { value: null, at: 0 },
  config: null,
  duckAllowed: false, // phone over Tailscale: the server accepted reading the duck setting
};

const dialogOpen = () => !$('#spotify-modal').hidden;
const settingsOpen = () => !$('#settings-modal').hidden;
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Why this page can't control the player right now (null = it can). */
function controlReason() {
  if (!music.available) return 'Spotify tidak tersedia di server ini';
  if (!canCall(P.control)) return READ_ONLY_HINT;
  return controlBlock(music.s);
}

// ---------- state in ----------

/**
 * New state from the server (snapshot, SSE `spotify`, or a control/state answer). `snapshot`: a snapshot without
 * the field means the server has no Spotify support at all: everything stays hidden and nothing is requested.
 */
export function applySpotify(raw, { snapshot = false, answer = false } = {}) {
  if (snapshot) music.available = raw !== undefined;
  else if (raw !== undefined) music.available = true;
  const prev = music.s;
  const next = music.available ? cleanState(raw) : null;
  // A request's answer may land after a newer pushed event: never let it roll the state back.
  if (answer && prev && next && next.updatedAt && next.updatedAt < prev.updatedAt) return;
  music.s = next;
  state.spotify = music.s;
  renderAll();
  // Connected or disconnected meanwhile (login finished in the other tab): ⚙ shows the new status.
  if (settingsOpen() && isConnected(prev) !== isConnected(music.s)) loadConfig();
}

function renderAll() {
  renderRadio();
  renderPill();
  renderDashRow();
  if (dialogOpen()) renderDialog();
  if (dialogOpen() && music.tr) markNowPlaying(); // ♪ follows the song
  loadTrackArt();
  syncTick();
}

// ---------- album art (blob: URLs) ----------

/** Fetches one picture as a blob: URL (null when it can't be had). Shared by every caller asking for the same id. */
function fetchArt(id) {
  if (!ART_ID.test(id ?? '') || !canCall(P.art)) return Promise.resolve(null);
  let load = music.artLoads.get(id);
  if (!load) {
    load = api(P.art, { id }, { raw: true })
      .then((blob) => (blob instanceof Blob && /^image\/(jpeg|png|webp)$/.test(blob.type) ? URL.createObjectURL(blob) : null))
      .catch(() => null) // no picture: the ♪ placeholder stays
      .finally(() => music.artLoads.delete(id));
    music.artLoads.set(id, load);
  }
  return load;
}

const artSlots = () => document.querySelectorAll('#spotify-pill .sp-art, #dash-music .sp-art, #spotify-modal .sp-now .sp-art');

function showArt(slot, url) {
  const img = slot.querySelector('img');
  const note = slot.querySelector('.sp-note');
  if (url) {
    if (img.getAttribute('src') !== url) img.src = url;
  } else img.removeAttribute('src');
  img.hidden = !url;
  note.hidden = Boolean(url);
}

const inPlaylists = (url) => [...music.plArt.values()].includes(url);

/** Keeps the current song's art in the pill, dialog and dashboard; the previous song's blob: URL is revoked. */
function loadTrackArt() {
  const s = music.s;
  const id = hasTrack(s) ? s.track.artId : null;
  const art = music.trackArt;
  if (id !== art.id) {
    if (art.url && !inPlaylists(art.url)) URL.revokeObjectURL(art.url);
    art.id = id;
    art.url = id ? (music.plArt.get(id) ?? null) : null;
    if (id && !art.url) {
      fetchArt(id).then((url) => {
        if (art.id === id && url) {
          art.url = url;
          for (const slot of artSlots()) showArt(slot, url);
        } else if (url && !inPlaylists(url)) URL.revokeObjectURL(url); // the song changed meanwhile
      });
    }
  }
  for (const slot of artSlots()) showArt(slot, art.url);
}

// ---------- office radio ----------

function renderRadio() {
  const s = music.s;
  const on = Boolean(s) && s.office;
  radio.mode = !on || s.status === 'unconfigured' ? 'none' : s.status === 'disconnected' ? 'off' : s.status;
  radio.track = on ? trackLine(s) : '';
  radio.button = on;
  const btn = stage.radioBtn;
  const label = radioLabel(s);
  btn.setAttribute('aria-label', label);
  btn.title = label.replace(/\. Buka .*$/, '');
}

function onRadioClick() {
  const s = music.s;
  if (!s || s.status === 'unconfigured') {
    if (state.local) openSpotifySettings();
    else toast('Spotify diatur dari laptop (⚙ Pengaturan).', 'warn');
    return;
  }
  openPlayer();
}

// ---------- top bar pill ----------

function renderPill() {
  const s = music.s;
  const box = $('#spotify-box');
  if (!s || s.status === 'unconfigured' || (s.status === 'disconnected' && !state.local)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const pill = $('#spotify-pill');
  const warnText = !s.launching && ['rate-limited', 'network', 'no-app', 'launch-timeout'].includes(s.error?.code) ? statusText(s) : '';
  let text;
  let label;
  if (s.launching) {
    // The server is starting the desktop app (bounded wait; it always ends with a state or an error).
    text = LAUNCHING_TEXT;
    label = `Musik: ${LAUNCHING_TEXT} Buka pemutar musik`;
  } else if (s.status === 'disconnected') {
    text = 'Hubungkan';
    label = 'Spotify belum terhubung. Buka pengaturan Spotify';
  } else if (hasTrack(s)) {
    text = trackLine(s);
    label = `Musik: ${text}${s.status === 'paused' ? ' (dijeda)' : ''}. Buka pemutar musik`;
  } else {
    text = 'Tidak ada yang diputar';
    label = 'Musik: tidak ada yang diputar. Buka pemutar musik';
  }
  $('#spotify-pill-text').textContent = text;
  $('#spotify-pill-warn').hidden = !warnText;
  pill.classList.toggle('disconnected', s.status === 'disconnected');
  pill.classList.toggle('playing', s.status === 'playing');
  pill.classList.toggle('launching', s.launching);
  pill.setAttribute('aria-label', warnText ? `${label}. ${warnText}` : label);
  pill.title = warnText ? `${text}\n${warnText}` : text;
  const toggle = $('#spotify-toggle');
  // Read-only WiFi: no ⏯ at all (the dialog still opens, with its controls off). Nothing active: ▶ still starts music.
  toggle.hidden = state.readOnly || !(hasTrack(s) || canStart(s)) || Boolean(controlReason());
  setPlayButton(toggle, s);
  toggle.disabled = music.busy || s.launching;
  updateProgress();
}

function setPlayButton(btn, s) {
  const playing = s?.status === 'playing';
  btn.textContent = playing ? '⏸' : '▶';
  btn.setAttribute('aria-label', playing ? 'Jeda musik' : 'Putar musik');
}

// ---------- progress (interpolated between events) ----------

function updateProgress() {
  const s = music.s;
  const dur = s?.track?.durationMs ?? 0;
  const at = progressAt(s);
  const pct = dur ? Math.min(100, (at / dur) * 100) : 0;
  $('#spotify-pill .sp-pill-bar > span').style.width = `${hasTrack(s) ? pct.toFixed(1) : 0}%`;
  if (!dialogOpen()) return;
  const bar = $('#sp-progress');
  bar.firstElementChild.style.width = `${pct.toFixed(1)}%`;
  bar.setAttribute('aria-valuemax', String(Math.round(dur / 1000)));
  bar.setAttribute('aria-valuenow', String(Math.round(at / 1000)));
  bar.setAttribute('aria-valuetext', `${fmtTime(at)} dari ${fmtTime(dur)}`);
  $('#sp-time').textContent = `${fmtTime(at)} / ${fmtTime(dur)}`;
}

function syncTick() {
  const playing = music.s?.status === 'playing' && hasTrack(music.s);
  if (playing && !music.tick) music.tick = setInterval(updateProgress, 1000);
  else if (!playing && music.tick) {
    clearInterval(music.tick);
    music.tick = null;
  }
}

// ---------- controls ----------

/** 503 rate-limited: `{ until }` (ms) or `retryAfter` (s) → "coba lagi 14:32". */
function rateLimitText(err) {
  const until = Number(err?.data?.until);
  const secs = Number(err?.data?.retryAfter);
  const at = Number.isFinite(until) && until > Date.now() ? until : Number.isFinite(secs) && secs > 0 ? Date.now() + secs * 1000 : 0;
  return at ? `Dibatasi Spotify, coba lagi ${clockTime(at)}.` : err.message;
}

/** One control request (`body` per the contract, §2.2); the answer is the new state. Errors: a toast (own action). */
async function control(body, { quiet = false } = {}) {
  const reason = controlReason();
  if (reason) {
    toast(reason, 'warn');
    return false;
  }
  if (!quiet) {
    if (music.busy) return false;
    music.busy = true;
    renderBusy();
  }
  try {
    const res = await api(P.control, body);
    if (res && typeof res === 'object' && typeof res.status === 'string') applySpotify(res, { answer: true });
    return true;
  } catch (err) {
    toast(err?.data?.code === 'rate-limited' || err?.status === 503 ? rateLimitText(err) : err.message);
    // The launch ended in an error: never leave "Membuka Spotify…" up (the pushed state says so too; this is a backstop).
    if (music.s?.launching) applySpotify({ ...music.s, launching: false });
    return false;
  } finally {
    if (!quiet) {
      music.busy = false;
      renderBusy();
    }
  }
}

function renderBusy() {
  $('#spotify-toggle').disabled = music.busy;
  $('#dash-music-toggle').disabled = music.busy;
  if (dialogOpen()) renderControls();
  if (dialogOpen() && music.tr) {
    const reason = controlReason();
    for (const b of document.querySelectorAll('#sp-tr-list .sp-tr')) b.disabled = music.busy || Boolean(reason) || !music.tr.items.some((t) => t.id === b.dataset.track && t.playable);
    $('#sp-tr-playall').disabled = music.busy || Boolean(reason);
  }
}

export function togglePlay() {
  return control({ action: music.s?.status === 'playing' ? 'pause' : 'play' });
}

export const nextTrack = () => control({ action: 'next' });

function sendVolume(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value))));
  if (!Number.isFinite(v)) return;
  const last = music.volLast;
  if (last.value === v && Date.now() - last.at < 1000) return; // the debounced input already sent it
  music.volLast = { value: v, at: Date.now() };
  control({ action: 'volume', volume: v }, { quiet: true });
}

// ---------- ♪ dialog ----------

export function openPlayer() {
  if (!music.available) return;
  openModal('spotify-modal');
  renderDialog();
  loadTrackArt();
  const play = $('#sp-play');
  if (play.getClientRects().length && !play.disabled) play.focus({ preventScroll: true });
  if (!isConnected(music.s)) return;
  api(P.state)
    .then((res) => res && typeof res.status === 'string' && applySpotify(res, { answer: true }))
    .catch(() => {}); // the pushed state stays
  if (canCall(P.devices)) loadDevices();
  if (!state.local && !state.readOnly) loadDuckForPhone();
}

function renderControls() {
  const s = music.s;
  const reason = controlReason();
  const off = Boolean(reason) || music.busy || Boolean(s?.launching);
  for (const id of ['#sp-prev', '#sp-play', '#sp-next']) {
    const btn = $(id);
    // ▶ without an active device: the server picks one (or opens Spotify on the laptop in the background).
    const startable = id === '#sp-play' && canStart(s);
    btn.disabled = off || (!s?.device && !startable);
    btn.title = reason ?? (s?.launching ? LAUNCHING_TEXT : s?.device ? '' : startable ? 'Putar di perangkat utama (★), atau buka Spotify di laptop' : 'Tidak ada perangkat aktif');
  }
  setPlayButton($('#sp-play'), s);
  const vol = $('#sp-volume');
  const canVolume = !reason && Boolean(s?.device?.supportsVolume);
  vol.disabled = !canVolume;
  vol.title = reason ?? (s?.device && !s.device.supportsVolume ? 'Perangkat ini tidak bisa diatur volumenya' : '');
  // Don't yank the slider from under a finger: the server's value wins only once the user let go.
  if (typeof s?.device?.volume === 'number' && Date.now() - music.volTouched > 1500) vol.value = String(s.device.volume);
}

function renderDialog() {
  const s = music.s;
  const connected = isConnected(s);
  const track = hasTrack(s) ? s.track : null;
  $('#sp-title').textContent = track ? (track.kind === 'ad' ? 'Iklan' : track.title || 'Sesi pribadi') : connected ? 'Tidak ada yang diputar' : 'Spotify belum terhubung';
  $('#sp-artist').textContent = track?.artists ?? '';
  $('#sp-album').textContent = track?.album ?? '';
  // device.name is absent on a read-only (plain WiFi) phone: the server leaves it out there (privacy).
  $('#sp-device').textContent = connected && s.device ? `${[deviceIcon(s.device.type), s.device.name].filter(Boolean).join(' ')}${typeof s.device.volume === 'number' ? ` · ${s.device.volume}%` : ''}` : '';
  $('#sp-progress-row').hidden = !track;
  $('#sp-controls').hidden = !connected;
  renderControls();
  $('#sp-status').textContent = statusText(s);
  $('#sp-status').classList.toggle('warn', (Boolean(s?.error) && !s.launching) || !connected);
  $('#sp-status').classList.toggle('launching', Boolean(s?.launching));
  const ro = $('#sp-ro');
  ro.hidden = !state.readOnly;
  ro.textContent = state.readOnly ? `👁 ${READ_ONLY_HINT}.` : '';
  // Devices and playlist names are private: never over plain WiFi (the server refuses them too).
  const lists = connected && canCall(P.devices);
  $('#sp-devices-box').hidden = !lists;
  $('#sp-devices-box').classList.toggle('attention', s?.error?.code === 'no-device' || s?.status === 'idle');
  $('#sp-playlists-box').hidden = !(connected && canCall(P.playlists));
  $('#sp-settings').hidden = !state.local;
  $('#sp-duck-row').hidden = !(music.duckAllowed && !state.local && !state.readOnly && connected);
  updateProgress();
}

// ---------- devices ----------

function cleanDevices(res) {
  const list = Array.isArray(res?.devices) ? res.devices : [];
  return list
    .filter((d) => d && typeof d === 'object' && typeof d.id === 'string' && DEVICE_ID.test(d.id))
    .slice(0, 30)
    .map((d) => ({ id: d.id, name: str(d.name) || 'Perangkat', type: str(d.type, 40), active: d.active === true, restricted: d.restricted === true, preferred: d.preferred === true }));
}

async function loadDevices() {
  const note = $('#sp-devices-note');
  note.textContent = 'Memuat perangkat…';
  try {
    const res = await api(P.devices);
    music.devices = cleanDevices(res);
    music.thisLaptop = res?.thisLaptop && typeof res.thisLaptop === 'object' ? { preferred: res.thisLaptop.preferred === true } : null;
    note.textContent = music.devices.length || music.thisLaptop ? '' : 'Tidak ada perangkat. Buka Spotify di HP/PC dulu, lalu ↻.';
  } catch (err) {
    music.devices = [];
    music.thisLaptop = null;
    note.textContent = `Daftar perangkat gagal dimuat: ${err.message}`;
  }
  renderDevices();
}

function renderDevices() {
  const box = $('#sp-devices');
  const reason = controlReason();
  box.replaceChildren(
    ...music.devices.map((d) => {
      const row = document.createElement('div');
      row.className = 'sp-dev-row';
      const label = document.createElement('label');
      label.className = `sp-dev${d.active ? ' active' : ''}${d.preferred ? ' preferred' : ''}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'sp-device';
      input.value = d.id;
      input.checked = d.active;
      input.disabled = d.restricted || Boolean(reason);
      const name = document.createElement('span');
      name.className = 'sp-dev-name';
      name.textContent = `${deviceIcon(d.type)} ${d.name}`;
      label.append(input, name);
      const tags = [d.preferred ? '★ utama' : '', d.restricted ? 'tidak bisa dikendalikan' : d.active ? 'aktif' : ''].filter(Boolean);
      if (tags.length) {
        const tag = document.createElement('small');
        tag.className = 'muted';
        tag.textContent = tags.join(' · ');
        if (d.preferred) tag.title = 'Perangkat utama: ▶ memutar di sini saat tidak ada yang aktif';
        label.append(tag);
      }
      row.append(label);
      // "Selalu putar di sini": makes it the ★ device (only remembered; nothing plays yet).
      if (!d.preferred && !d.restricted) {
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'ghost sp-small sp-dev-star';
        star.dataset.prefer = d.id;
        star.textContent = '☆';
        star.title = 'Selalu putar di sini';
        star.setAttribute('aria-label', `Selalu putar di ${d.name}`);
        star.disabled = Boolean(reason) || music.busy;
        row.append(star);
      }
      return row;
    }),
    ...(music.thisLaptop ? [laptopRow(music.thisLaptop, reason)] : []),
  );
}

/**
 * "💻 Laptop ini": this laptop while its Spotify is closed (a closed app is no Connect device, so Spotify doesn't
 * list it). "Buka & putar di sini" starts it in the background and plays there; ☆ makes it the ★ device.
 */
function laptopRow(laptop, reason) {
  const row = document.createElement('div');
  row.className = 'sp-dev-row sp-dev-virtual';
  const box = document.createElement('div');
  box.className = `sp-dev${laptop.preferred ? ' preferred' : ''}`;
  const name = document.createElement('span');
  name.className = 'sp-dev-name';
  name.textContent = '💻 Laptop ini';
  const tag = document.createElement('small');
  tag.className = 'muted';
  tag.textContent = [laptop.preferred ? '★ utama' : '', 'Spotify belum terbuka'].filter(Boolean).join(' · ');
  box.append(name, tag);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ghost sp-small';
  open.dataset.launch = '1';
  open.textContent = '▶ Buka & putar di sini';
  open.title = 'Buka Spotify di laptop ini (latar belakang), lalu putar di sini';
  open.disabled = Boolean(reason) || music.busy || Boolean(music.s?.launching);
  row.append(box, open);
  if (!laptop.preferred) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'ghost sp-small sp-dev-star';
    star.dataset.preferLaptop = '1';
    star.textContent = '☆';
    star.title = 'Selalu putar di sini';
    star.setAttribute('aria-label', 'Selalu putar di laptop ini');
    star.disabled = Boolean(reason) || music.busy;
    row.append(star);
  }
  return row;
}

async function onDevicePick(e) {
  const input = e.target.closest('input[name="sp-device"]');
  if (!input || !music.devices.some((d) => d.id === input.value)) return;
  const ok = await control({ action: 'transfer', deviceId: input.value, play: music.s?.status === 'playing' });
  if (dialogOpen()) (ok ? loadDevices() : renderDevices());
}

async function onPreferClick(e) {
  if (e.target.closest('[data-launch]')) {
    if (await control({ action: 'launch' })) toast('Spotify dibuka di laptop ini.', 'ok');
    if (dialogOpen()) loadDevices();
    return;
  }
  if (e.target.closest('[data-prefer-laptop]')) {
    if (await control({ action: 'prefer', laptop: true })) {
      toast('▶ akan memutar di laptop ini saat tidak ada perangkat aktif.', 'ok');
      if (dialogOpen()) loadDevices();
    }
    return;
  }
  const btn = e.target.closest('[data-prefer]');
  const device = btn && music.devices.find((d) => d.id === btn.dataset.prefer);
  if (!device) return;
  if (await control({ action: 'prefer', deviceId: device.id })) {
    toast(`▶ akan memutar di ${device.name} saat tidak ada perangkat aktif.`, 'ok');
    if (dialogOpen()) loadDevices();
  }
}

const pickedDevice = () => $('#sp-devices input[name="sp-device"]:checked')?.value ?? null;

// ---------- playlists ----------

function cleanPlaylists(res) {
  const items = Array.isArray(res?.items) ? res.items : [];
  return {
    items: items
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && PLAYLIST_ID.test(p.id))
      .slice(0, 50)
      .map((p) => ({ id: p.id, name: str(p.name) || 'Tanpa nama', tracks: Number.isFinite(p.tracks) ? Math.max(0, Math.round(p.tracks)) : null, artId: typeof p.artId === 'string' && ART_ID.test(p.artId) ? p.artId : null })),
    next: Number.isInteger(res?.next) && res.next > 0 ? res.next : res?.next ? true : null,
  };
}

async function loadPlaylists({ more = false } = {}) {
  if (music.plBusy) return;
  music.plBusy = true;
  const note = $('#sp-pl-note');
  note.textContent = 'Memuat playlist…';
  $('#sp-pl-more').disabled = true;
  try {
    const offset = more ? (Number.isInteger(music.plNext) ? music.plNext : music.playlists.length) : 0;
    const { items, next } = cleanPlaylists(await api(P.playlists, more ? { offset } : {}));
    const seen = new Set(more ? music.playlists.map((p) => p.id) : []);
    music.playlists = [...(more ? music.playlists : []), ...items.filter((p) => !seen.has(p.id))];
    music.plNext = next;
    music.plAt = Date.now();
    note.textContent = '';
  } catch (err) {
    note.textContent = `Playlist gagal dimuat: ${err.message}`;
  } finally {
    music.plBusy = false;
    $('#sp-pl-more').disabled = false;
  }
  renderPlaylists();
}

function playlistRow(p, reason) {
  const li = document.createElement('li');
  li.className = 'sp-pl';
  li.dataset.name = p.name.toLowerCase();
  const art = document.createElement('span');
  art.className = 'sp-art sp-art-32';
  art.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.alt = '';
  img.hidden = true;
  const ph = document.createElement('span');
  ph.className = 'sp-note';
  ph.textContent = '♪';
  art.append(img, ph);
  if (p.artId) art.dataset.art = p.artId;
  const text = document.createElement('span');
  text.className = 'sp-pl-text';
  const name = document.createElement('b');
  name.textContent = p.name;
  const meta = document.createElement('small');
  meta.className = 'muted';
  meta.textContent = p.tracks === null ? '' : `${p.tracks} lagu`;
  text.append(name, meta);
  // Tap the name: see its tracks (and play from one). ▶ still plays the whole playlist.
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'sp-pl-open';
  open.dataset.open = p.id;
  open.setAttribute('aria-label', `Lihat isi playlist ${p.name}`);
  open.append(art, text);
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'sp-btn sp-pl-play';
  play.dataset.playlist = p.id;
  play.textContent = '▶';
  play.setAttribute('aria-label', `Putar playlist ${p.name}`);
  play.disabled = Boolean(reason) || music.busy;
  if (reason) play.title = reason;
  li.append(open, play);
  return li;
}

function renderPlaylists() {
  const ul = $('#sp-pl-list');
  const reason = controlReason();
  music.plObserver?.disconnect();
  ul.replaceChildren(...music.playlists.map((p) => playlistRow(p, reason)));
  filterPlaylists();
  $('#sp-pl-more').hidden = !music.plNext;
  if (!music.playlists.length && !music.plBusy && !$('#sp-pl-note').textContent) $('#sp-pl-note').textContent = 'Belum ada playlist.';
  observeArt(ul);
}

/** Pictures only for rows scrolled into view (up to 50 rows: no 50 downloads at once). Playlists and tracks share it. */
function observeArt(ul) {
  music.plObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        music.plObserver.unobserve(entry.target);
        loadPlaylistArt(entry.target);
      }
    },
    { root: $('#spotify-modal .modal-card'), rootMargin: '80px' },
  );
  for (const slot of ul.querySelectorAll('.sp-art[data-art]')) music.plObserver.observe(slot);
}

// ---------- a playlist's tracks (drill-in view inside "Playlist") ----------

function cleanTracks(res) {
  const items = Array.isArray(res?.items) ? res.items : [];
  return {
    items: items
      .filter((t) => t && typeof t === 'object')
      .slice(0, 50)
      .map((t) => ({
        id: typeof t.id === 'string' && TRACK_ID.test(t.id) ? t.id : null,
        title: str(t.title) || 'Tanpa judul',
        artist: str(t.artist),
        album: str(t.album),
        durationMs: Number.isFinite(t.durationMs) ? Math.max(0, t.durationMs) : 0,
        artId: typeof t.artId === 'string' && ART_ID.test(t.artId) ? t.artId : null,
        explicit: t.explicit === true,
        playable: t.playable === true && typeof t.id === 'string' && TRACK_ID.test(t.id),
        isLocal: t.isLocal === true,
        isEpisode: t.isEpisode === true,
      })),
    next: Number.isInteger(res?.next) && res.next > 0 ? res.next : null,
    total: Number.isInteger(res?.total) && res.total >= 0 ? res.total : null,
  };
}

const tracksOpen = () => !$('#sp-tr-view').hidden;

/** The song playing now, matched by title + artists (the public state carries no track id, on purpose). */
const isNowPlaying = (t) => hasTrack(music.s) && music.s.track.title === t.title && music.s.track.artists === t.artist;

/** Drill into a playlist: its tracks replace the playlist list; ← goes back. */
function openTracks(playlistId) {
  const pl = music.playlists.find((p) => p.id === playlistId);
  if (!pl) return;
  music.tr = { playlist: pl, items: [], next: null, total: null, busy: false };
  $('#sp-pl-browse').hidden = true;
  $('#sp-tr-view').hidden = false;
  $('#sp-tr-title').textContent = pl.name;
  $('#sp-tr-filter').value = '';
  $('#sp-tr-list').replaceChildren();
  $('#sp-tr-more').hidden = true;
  $('#sp-tr-playall').setAttribute('aria-label', `Putar playlist ${pl.name} dari awal`);
  $('#sp-tr-title').focus({ preventScroll: true });
  loadTracks();
}

function closeTracks({ focus = true } = {}) {
  if (!tracksOpen()) return;
  const id = music.tr?.playlist.id;
  $('#sp-tr-view').hidden = true;
  $('#sp-pl-browse').hidden = false;
  $('#sp-tr-list').replaceChildren();
  music.tr = null;
  renderPlaylists();
  if (focus) ([...document.querySelectorAll('#sp-pl-list [data-open]')].find((b) => b.dataset.open === id) ?? $('#sp-pl-toggle')).focus({ preventScroll: true });
}

async function loadTracks({ more = false } = {}) {
  const tr = music.tr;
  if (!tr || tr.busy) return;
  tr.busy = true;
  const note = $('#sp-tr-note');
  note.textContent = 'Memuat lagu…';
  $('#sp-tr-more').disabled = true;
  try {
    const res = cleanTracks(await api(P.items, { playlistId: tr.playlist.id, offset: more ? (tr.next ?? 0) : 0 }));
    if (music.tr !== tr) return; // went back meanwhile
    tr.items = more ? [...tr.items, ...res.items] : res.items;
    tr.next = res.next;
    tr.total = res.total;
    note.textContent = tr.items.length ? '' : 'Playlist ini kosong.';
  } catch (err) {
    if (music.tr !== tr) return;
    // 403 playlist-locked (Dev-mode: not the user's playlist): the server's message says to just play it.
    note.textContent = err?.data?.code === 'playlist-locked' ? err.message : `Isi playlist gagal dimuat: ${err.message}`;
  } finally {
    tr.busy = false;
    $('#sp-tr-more').disabled = false;
  }
  if (music.tr === tr) renderTracks();
}

function trackRow(t, reason) {
  const li = document.createElement('li');
  li.className = 'sp-tr-row';
  li.dataset.name = `${t.title} ${t.artist}`.toLowerCase();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sp-tr';
  if (t.id) btn.dataset.track = t.id;
  const art = document.createElement('span');
  art.className = 'sp-art sp-art-32';
  art.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.alt = '';
  img.hidden = true;
  const ph = document.createElement('span');
  ph.className = 'sp-note';
  ph.textContent = t.isEpisode ? '🎙' : '♪';
  art.append(img, ph);
  if (t.artId) art.dataset.art = t.artId;
  const text = document.createElement('span');
  text.className = 'sp-pl-text';
  const title = document.createElement('b');
  const now = document.createElement('span');
  now.className = 'sp-tr-now';
  now.textContent = '♪ ';
  now.setAttribute('aria-hidden', 'true');
  title.append(now, t.title);
  const meta = document.createElement('small');
  meta.className = 'muted';
  const why = t.isLocal ? 'File lokal' : !t.playable ? 'Tidak tersedia' : '';
  meta.textContent = [t.explicit ? '🅴' : '', t.isEpisode ? 'Episode' : '', t.artist, t.album, why].filter(Boolean).join(' · ');
  text.append(title, meta);
  const dur = document.createElement('span');
  dur.className = 'sp-tr-dur muted small';
  dur.textContent = t.durationMs ? fmtTime(t.durationMs) : '';
  btn.append(art, text, dur);
  btn.disabled = !t.playable || Boolean(reason) || music.busy;
  btn.title = reason ?? (why ? `${why}: tidak bisa diputar` : '');
  btn.dataset.label = `${t.title}${t.artist ? ` – ${t.artist}` : ''}${t.durationMs ? `, ${fmtTime(t.durationMs)}` : ''}`;
  li.append(btn);
  return li;
}

function renderTracks() {
  const tr = music.tr;
  if (!tr) return;
  const reason = controlReason();
  const ul = $('#sp-tr-list');
  ul.replaceChildren(...tr.items.map((t) => trackRow(t, reason)));
  $('#sp-tr-more').hidden = !tr.next;
  $('#sp-tr-playall').disabled = Boolean(reason) || music.busy;
  markNowPlaying();
  filterTracks();
  observeArt(ul);
}

/** ♪ in front of the song playing now (and the accessible names say so). */
function markNowPlaying() {
  if (!music.tr) return;
  const rows = $('#sp-tr-list').children;
  music.tr.items.forEach((t, i) => {
    const btn = rows[i]?.querySelector('.sp-tr');
    if (!btn) return;
    const now = isNowPlaying(t);
    btn.classList.toggle('now', now);
    if (now) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
    const why = t.isLocal ? ' (file lokal, tidak bisa diputar)' : !t.playable ? ' (tidak tersedia)' : '';
    btn.setAttribute('aria-label', `${t.playable ? 'Putar ' : ''}${btn.dataset.label}${now ? ', sedang diputar' : ''}${why}`);
  });
}

function filterTracks() {
  const q = $('#sp-tr-filter').value.trim().toLowerCase();
  let shown = 0;
  for (const li of $('#sp-tr-list').children) {
    li.hidden = Boolean(q) && !li.dataset.name.includes(q);
    if (!li.hidden) shown++;
  }
  const note = $('#sp-tr-note');
  if (q && !shown && music.tr?.items.length) note.textContent = 'Tidak ada lagu yang cocok.';
  else if (note.textContent === 'Tidak ada lagu yang cocok.') note.textContent = '';
}

function onTrackClick(e) {
  const btn = e.target.closest('button[data-track]');
  const tr = music.tr;
  if (!btn || btn.disabled || !tr || !tr.items.some((t) => t.id === btn.dataset.track && t.playable)) return;
  playFromPlaylist(tr.playlist.id, { trackId: btn.dataset.track });
}

/** control {playlist}: from a track (trackId), or from the start; no active device → the one picked above. */
function playFromPlaylist(playlistId, from = {}) {
  const deviceId = !music.s?.device ? pickedDevice() : null;
  return control({ action: 'playlist', playlistId, ...from, ...(deviceId ? { deviceId } : {}) });
}

async function loadPlaylistArt(slot) {
  const id = slot.dataset.art;
  let url = music.plArt.get(id) ?? (music.trackArt.id === id ? music.trackArt.url : null);
  if (!url) {
    url = await fetchArt(id);
    if (!url) return;
    if (!dialogOpen()) {
      if (url !== music.trackArt.url) URL.revokeObjectURL(url);
      return;
    }
    music.plArt.set(id, url);
  }
  if (slot.isConnected) showArt(slot, url);
}

function filterPlaylists() {
  const q = $('#sp-pl-filter').value.trim().toLowerCase();
  let shown = 0;
  for (const li of $('#sp-pl-list').children) {
    li.hidden = Boolean(q) && !li.dataset.name.includes(q);
    if (!li.hidden) shown++;
  }
  const note = $('#sp-pl-note');
  if (q && !shown && music.playlists.length) note.textContent = 'Tidak ada playlist yang cocok.';
  else if (note.textContent === 'Tidak ada playlist yang cocok.') note.textContent = '';
}

function togglePlaylists() {
  const btn = $('#sp-pl-toggle');
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = `${open ? '▾' : '▸'} Playlist`;
  $('#sp-pl-panel').hidden = !open;
  if (!open) return;
  if (!music.playlists.length || Date.now() - music.plAt > PLAYLIST_CACHE_MS) loadPlaylists();
  else renderPlaylists();
}

function onPlaylistClick(e) {
  const open = e.target.closest('[data-open]');
  if (open) return openTracks(open.dataset.open);
  const btn = e.target.closest('[data-playlist]');
  if (!btn) return;
  const playlistId = btn.dataset.playlist;
  if (!music.playlists.some((p) => p.id === playlistId)) return;
  // No active device: start it on the one picked in the list above (the server checks the id against its cache).
  playFromPlaylist(playlistId);
}

/** Dialog closed: playlist pictures are let go (the current song's stays for the pill). */
function onDialogClosed() {
  clearTimeout(music.volTimer);
  music.plObserver?.disconnect();
  for (const url of music.plArt.values()) if (url !== music.trackArt.url) URL.revokeObjectURL(url);
  music.plArt.clear();
  for (const slot of document.querySelectorAll('#sp-pl-list .sp-art')) showArt(slot, null);
  closeTracks({ focus: false });
}

// ---------- duck setting from a phone over Tailscale ----------

function cleanSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    office: s.office !== false,
    duck: DUCK_MODES.includes(s.duck) ? s.duck : 'off',
    duckVolume: Number.isFinite(s.duckVolume) ? Math.max(0, Math.min(50, Math.round(s.duckVolume))) : 20,
    autoLaunch: s.autoLaunch !== false,
  };
}

function setDuckSelect(select, settings) {
  select.value = settings.duck;
  select.querySelector('option[value="duck"]').textContent = `Kecilkan (ke ${settings.duckVolume}%)`;
}

/** POST /settings with no change reads them; a server that refuses it leaves the row hidden. */
async function loadDuckForPhone() {
  try {
    const cfg = await api(P.settings, { settings: {} });
    const settings = cleanSettings(cfg?.settings);
    setDuckSelect($('#sp-duck'), settings);
    $('#sp-duck').dataset.prev = settings.duck;
    music.duckAllowed = true;
  } catch {
    music.duckAllowed = false;
  }
  if (dialogOpen()) renderDialog();
}

/** Laptop: the whole ⚙ config; a phone over Tailscale: the duck setting only (POST /settings). */
async function saveSetting(patch, revert) {
  try {
    const cfg = await api(state.local ? P.config : P.settings, { settings: patch });
    if (cfg && typeof cfg === 'object' && settingsOpen()) renderConfig(cleanConfig(cfg));
    toast('Pengaturan musik disimpan.', 'ok');
  } catch (err) {
    revert();
    toast(err.message);
  }
}

// ---------- ⚙ Pengaturan → ♪ Spotify (laptop) ----------

function cleanConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    clientIdSet: c.clientIdSet === true,
    clientIdHint: str(c.clientIdHint, 12).replace(/[^0-9a-f]/gi, '').slice(-4),
    clientIdSource: c.clientIdSource === 'env' ? 'env' : c.clientIdSource === 'file' ? 'file' : '',
    redirectUri: str(c.redirectUri, 120) || str(state.config?.spotify?.redirectUri, 120), // snapshot.config as fallback
    connected: c.connected === true,
    displayName: str(c.displayName, 80),
    settings: cleanSettings(c.settings),
  };
}

function renderConfig(cfg) {
  music.config = cfg;
  $('#sps-redirect').textContent = cfg.redirectUri || '(belum tersedia)';
  const input = $('#sps-client');
  const env = cfg.clientIdSource === 'env';
  input.readOnly = env;
  if (env) input.value = '';
  input.placeholder = cfg.clientIdSet ? `••••${cfg.clientIdHint}` : '32 karakter dari Spotify Dashboard';
  $('#sps-save').hidden = env;
  $('#sps-client-hint').textContent = env ? `dari SPOTIFY_CLIENT_ID (••••${cfg.clientIdHint})` : cfg.clientIdSet ? `Tersimpan: ••••${cfg.clientIdHint}. Isi lagi untuk mengganti.` : 'Belum diisi.';
  $('#sps-status').textContent = cfg.connected ? (cfg.displayName ? `✓ Terhubung sebagai ${cfg.displayName}` : '✓ Terhubung') : cfg.clientIdSet ? 'Belum terhubung.' : 'Isi Client ID dulu, lalu Hubungkan.';
  $('#sps-connect').hidden = cfg.connected;
  $('#sps-connect').disabled = !cfg.clientIdSet;
  $('#sps-switch').hidden = !cfg.connected;
  $('#sps-logout').hidden = !cfg.connected;
  $('#sps-office').checked = cfg.settings.office;
  $('#sps-autolaunch').checked = cfg.settings.autoLaunch;
  setDuckSelect($('#sps-duck'), cfg.settings);
}

async function loadConfig() {
  try {
    renderConfig(cleanConfig(await api(P.config)));
  } catch (err) {
    $('#sps-status').textContent = `Pengaturan Spotify gagal dimuat: ${err.message}`;
  }
}

function onSettingsOpened() {
  const show = music.available && state.local;
  $('#sps').hidden = !show;
  $('#sps-rule').hidden = !show;
  if (!show) return;
  $('#sps-error').textContent = '';
  $('#sps-client').setAttribute('aria-invalid', 'false');
  $('#sps-revoke').hidden = true;
  const uri = str(state.config?.spotify?.redirectUri, 120);
  if (uri) $('#sps-redirect').textContent = uri; // known from the snapshot before /config answers
  loadConfig();
}

/** Opens ⚙ at the ♪ Spotify section (from the radio, the pill's "Hubungkan", the dialog). */
export function openSpotifySettings() {
  if (!state.local) {
    toast('Spotify diatur dari laptop (⚙ Pengaturan).', 'warn');
    return;
  }
  closeModal('spotify-modal');
  $('#btn-settings').click();
  requestAnimationFrame(() => {
    $('#sps').scrollIntoView({ block: 'start' });
    const target = music.config?.clientIdSet ? $('#sps-connect:not([hidden])') ?? $('#sps-office') : $('#sps-client');
    target?.focus({ preventScroll: true });
  });
}

async function saveClientId() {
  const input = $('#sps-client');
  const value = input.value.trim();
  const error = !value ? 'Tempel Client ID dulu.' : CLIENT_ID_RE.test(value) ? null : 'Client ID harus 32 karakter heksadesimal (0-9, a-f).';
  $('#sps-error').textContent = error ?? '';
  input.setAttribute('aria-invalid', String(Boolean(error)));
  if (error) return;
  try {
    renderConfig(cleanConfig(await api(P.config, { clientId: value })));
    input.value = '';
    toast('Client ID Spotify disimpan.', 'ok');
  } catch (err) {
    $('#sps-error').textContent = err.message;
  }
}

/** Only an https Spotify page (or the loopback test origin) is ever opened. */
function safeLoginUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')) return url.href;
  } catch {
    // not a URL
  }
  return null;
}

async function connect(switchAccount = false) {
  const status = $('#sps-status');
  try {
    const res = await api(P.login, switchAccount ? { switchAccount: true } : {});
    const url = safeLoginUrl(res?.url);
    if (!url) throw new Error('Alamat login dari server tidak valid.');
    window.open(url, '_blank', 'noopener');
    // A popup blocker leaves no trace with noopener: a plain link as the fallback.
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'buka di sini';
    status.replaceChildren('Login Spotify dibuka di tab baru. Setelah setuju, kembali ke sini (tab tidak terbuka? ', link, ').');
  } catch (err) {
    status.textContent = err.status === 409 ? 'Isi Client ID dulu, lalu Hubungkan.' : `Gagal memulai login: ${err.message}`;
  }
}

async function disconnect() {
  if (!window.confirm('Putuskan Spotify dari kantor ini? Client ID tetap tersimpan.')) return;
  try {
    await api(P.logout);
    $('#sps-revoke').hidden = false;
    await loadConfig();
    $('#sps-status').textContent = 'Spotify diputuskan.';
  } catch (err) {
    toast(err.message);
  }
}

async function copyRedirect() {
  const uri = music.config?.redirectUri;
  if (!uri) return;
  try {
    await navigator.clipboard.writeText(uri);
    toast('Redirect URI disalin.', 'ok');
  } catch {
    // No clipboard (plain http, permissions): select it so Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents($('#sps-redirect'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    toast('Tekan Ctrl+C untuk menyalin.', 'warn');
  }
}

// ---------- 🗂 dashboard row ----------

function renderDashRow() {
  const s = music.s;
  const row = $('#dash-music');
  if (!s || s.status === 'unconfigured') {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const track = hasTrack(s);
  $('#dash-music-title').textContent = track ? `♪ ${trackLine(s)}` : isConnected(s) ? '♪ Tidak ada yang diputar' : '♪ Spotify belum terhubung';
  const sub = track ? [s.status === 'paused' ? 'dijeda' : 'diputar', s.device?.name].filter(Boolean).join(' · ') : isConnected(s) ? statusText(s) : SETTINGS_HINT;
  $('#dash-music-sub').textContent = sub;
  const toggle = $('#dash-music-toggle');
  toggle.hidden = !(track || canStart(s)) || Boolean(controlReason());
  setPlayButton(toggle, s);
  toggle.disabled = music.busy || s.launching;
}

// ---------- Ctrl+P ----------

/** The palette's music entries (features/palette.js adds them to its list). */
export function musicPaletteItems() {
  const s = music.s;
  const reason = !music.available ? 'Spotify tidak tersedia' : controlReason() ?? (hasTrack(s) || s?.device ? null : 'Tidak ada yang diputar');
  const playReason = reason && canStart(s) && !controlReason() ? null : reason; // ▶ with nothing active still starts music
  const keywords = 'musik music spotify lagu song';
  return [
    { id: 'music:toggle', group: 'music', icon: '⏯', label: 'Musik: putar/jeda', hint: hasTrack(s) ? trackLine(s) : '', disabled: playReason, keywords: `${keywords} play pause putar jeda`, run: () => togglePlay() },
    { id: 'music:next', group: 'music', icon: '⏭', label: 'Musik: berikutnya', disabled: reason, keywords: `${keywords} next skip lewati`, run: () => nextTrack() },
    { id: 'music:open', group: 'music', icon: '♪', label: 'Buka pemutar musik', disabled: music.available ? null : 'Spotify tidak tersedia', keywords: `${keywords} player pemutar radio playlist perangkat volume`, run: () => openPlayer() },
  ];
}

// ---------- wiring ----------

export function initSpotify() {
  stage.radioBtn.addEventListener('click', onRadioClick);
  $('#spotify-pill').addEventListener('click', () => (music.s?.status === 'disconnected' && state.local ? openSpotifySettings() : openPlayer()));
  $('#spotify-toggle').addEventListener('click', togglePlay);
  $('#dash-music-toggle').addEventListener('click', togglePlay);
  $('#dash-music-more').addEventListener('click', openPlayer);

  $('#sp-play').addEventListener('click', togglePlay);
  $('#sp-prev').addEventListener('click', () => control({ action: 'previous' }));
  $('#sp-next').addEventListener('click', nextTrack);
  const vol = $('#sp-volume');
  vol.addEventListener('input', () => {
    music.volTouched = Date.now();
    clearTimeout(music.volTimer);
    music.volTimer = setTimeout(() => sendVolume(vol.value), VOLUME_DEBOUNCE_MS);
  });
  vol.addEventListener('change', () => {
    music.volTouched = Date.now();
    clearTimeout(music.volTimer);
    sendVolume(vol.value);
  });
  $('#sp-devices').addEventListener('change', onDevicePick);
  $('#sp-devices').addEventListener('click', onPreferClick);
  $('#sp-devices-refresh').addEventListener('click', loadDevices);
  $('#sp-pl-toggle').addEventListener('click', togglePlaylists);
  $('#sp-pl-filter').addEventListener('input', filterPlaylists);
  $('#sp-pl-more').addEventListener('click', () => loadPlaylists({ more: true }));
  $('#sp-pl-list').addEventListener('click', onPlaylistClick);
  $('#sp-tr-list').addEventListener('click', onTrackClick);
  $('#sp-tr-back').addEventListener('click', () => closeTracks());
  $('#sp-tr-filter').addEventListener('input', filterTracks);
  $('#sp-tr-more').addEventListener('click', () => loadTracks({ more: true }));
  $('#sp-tr-playall').addEventListener('click', () => music.tr && playFromPlaylist(music.tr.playlist.id));
  // Esc in the track view goes back to the playlists first. Window capture: it must run before ui/shortcuts.js
  // (document capture), which would close the whole dialog.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !dialogOpen() || !tracksOpen() || !$('#spotify-modal').contains(document.activeElement)) return;
      if ([...document.querySelectorAll('.modal')].filter((m) => !m.hidden).at(-1)?.id !== 'spotify-modal') return; // another dialog on top
      e.preventDefault();
      e.stopImmediatePropagation();
      closeTracks();
    },
    true,
  );
  $('#sp-settings').addEventListener('click', openSpotifySettings);
  $('#sp-duck').addEventListener('change', (e) => {
    const prev = e.target.dataset.prev ?? 'off';
    saveSetting({ duck: e.target.value }, () => (e.target.value = prev));
    e.target.dataset.prev = e.target.value;
  });
  new MutationObserver(() => !dialogOpen() && onDialogClosed()).observe($('#spotify-modal'), { attributeFilter: ['hidden'] });

  // ⚙ (after initSettings: its own #btn-settings listener opens the dialog first)
  $('#btn-settings').addEventListener('click', onSettingsOpened);
  $('#sps-save').addEventListener('click', saveClientId);
  $('#sps-client').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // the field sits in the roots form: Enter must not rescan the project folders
    saveClientId();
  });
  $('#sps-connect').addEventListener('click', () => connect(false));
  $('#sps-switch').addEventListener('click', () => connect(true));
  $('#sps-logout').addEventListener('click', disconnect);
  $('#sps-copy').addEventListener('click', copyRedirect);
  $('#sps-office').addEventListener('change', (e) => saveSetting({ office: e.target.checked }, () => (e.target.checked = !e.target.checked)));
  $('#sps-autolaunch').addEventListener('change', (e) => saveSetting({ autoLaunch: e.target.checked }, () => (e.target.checked = !e.target.checked)));
  $('#sps-duck').addEventListener('change', (e) => {
    const prev = music.config?.settings.duck ?? 'off';
    saveSetting({ duck: e.target.value }, () => (e.target.value = prev));
  });

  // Bobbing and notes only on a visible page (office/radio.js reads it each frame); the progress catches up.
  document.addEventListener('visibilitychange', updateProgress);
  renderAll();
}
