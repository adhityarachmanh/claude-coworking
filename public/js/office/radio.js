// ♪ The lounge radio (docs/design-spotify.md §6.1–6.2): what the office knows about the music, the sprite on the
// coffee table, the floating notes, and the idle people bobbing along. Set by features/spotify.js; drawn by
// world.js (the set itself), stage.js (LED glow, notes, the overlay button) and scene.js (the bob offset).

// Retro radio, 14×9 px, standing on the lounge coffee table (580, 212, 40×10).
export const RADIO = { x: 603, y: 204, w: 14, h: 9 };
// Fixed tempo: Spotify no longer gives new apps a song's BPM (audio-features), so everyone grooves at ~112.
export const BPM = 112;
export const BEAT_MS = 60000 / BPM;
const NOTE_EVERY_MS = 900;
const NOTE_LIFE_MS = 1200;

/** `mode`: 'none' (no Spotify backend / office off: plain decor) | 'off' (not connected: grey) | 'idle' | 'paused' | 'playing'. */
export const radio = { mode: 'none', track: '', button: false };

// Created on first use, not at load: the office modules are also imported by Node tests (no matchMedia there).
let reducedMotion = null;
const prefersLessMotion = () => (reducedMotion ??= globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null)?.matches === true;

/** Notes and bobbing only for a visible page and someone who hasn't asked for less motion (the LED stays). */
export const motionAllowed = () => !prefersLessMotion() && globalThis.document?.visibilityState === 'visible';
export const grooving = () => radio.mode === 'playing' && motionAllowed();

/** Cheap stable hash: the same people groove for the whole song, a new song picks again. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * How many px (0 or 1) a person is lifted on this beat. Only idle people groove: never one walking, working or
 * asking for permission. Whoever sits on the sofa next to the radio always does; about half of the rest, per song.
 */
export function bobOffset(person, now) {
  if (!grooving() || person.walking || person.asking || person.isBusy(now)) return 0;
  if (!person.onSofa && hash(`${radio.track}|${person.id}`) % 2) return 0;
  person.bobPhase ??= Math.random() * BEAT_MS; // everyone a little off the beat, like real people
  return (now + person.bobPhase) % BEAT_MS < BEAT_MS / 2 ? 1 : 0;
}

/** The radio itself (static layer, sorted with the furniture). `r` = the theme-aware rect painter. */
export function drawRadio(r) {
  const grey = radio.mode === 'off';
  const { x, y } = RADIO;
  const body = grey ? '#8a8d93' : '#b5523b';
  const top = grey ? '#a3a6ab' : '#d0694f';
  const dark = grey ? '#5d6066' : '#7a3424';
  r(x + 10, y - 4, 1, 4, '#3a3d44'); // antenna
  r(x + 10, y - 5, 1, 1, '#c9ccd2');
  r(x, y, 14, 9, body);
  r(x, y, 14, 1, top);
  r(x, y + 8, 14, 1, dark);
  r(x + 1, y + 2, 6, 5, '#2b2d33'); // speaker grille
  for (let i = 0; i < 3; i += 2) r(x + 2, y + 3 + i, 4, 1, '#4b4e57');
  r(x + 8, y + 2, 5, 2, grey ? '#c8cacd' : '#f1dfb0'); // tuning dial
  r(x + 9 + (hash(radio.track) % 3), y + 2, 1, 2, '#7a3424');
  r(x + 9, y + 5, 2, 2, '#3a3d44'); // knob
  r(x + 2, y + 9, 2, 1, '#3a2a1a'); // feet
  r(x + 10, y + 9, 2, 1, '#3a2a1a');
  // LED: green while playing, dim while paused/idle, off when not connected
  r(x + 12, y + 5, 1, 1, radio.mode === 'playing' ? '#6bff7a' : radio.mode === 'paused' || radio.mode === 'idle' ? '#2f6b36' : '#3a3d44');
}

/** Live layer: a soft LED glow and ♪ notes drifting up, one every ~900 ms, fading out in 1.2 s. */
export function drawRadioLive(g, now) {
  if (radio.mode !== 'playing') return;
  const { x, y } = RADIO;
  g.fillStyle = 'rgba(107,255,122,.25)';
  g.fillRect(x + 11, y + 4, 3, 3);
  if (!motionAllowed()) return;
  const newest = Math.floor(now / NOTE_EVERY_MS);
  for (let k = newest; k > newest - 2; k--) {
    const age = now - k * NOTE_EVERY_MS;
    if (age < 0 || age > NOTE_LIFE_MS) continue;
    const p = age / NOTE_LIFE_MS;
    const nx = x + 4 + (k % 3) * 3 + Math.round(Math.sin(p * Math.PI * 2) * 1.5);
    const ny = Math.round(y - 4 - p * 14);
    g.globalAlpha = 1 - p;
    g.fillStyle = k % 2 ? '#f2c14e' : '#ffffff';
    // an eighth note: head, stem, flag
    g.fillRect(nx, ny + 3, 2, 2);
    g.fillRect(nx + 1, ny, 1, 4);
    g.fillRect(nx + 2, ny, 1, 1);
    g.globalAlpha = 1;
  }
}
