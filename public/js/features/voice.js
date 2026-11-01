// 🎤 Input suara: the browser's Web Speech API types into the prompt box. Interim words show live under the
// controls; final text goes in at the cursor (what was typed stays). Click 🎤 again, Esc or Alt+M stops.
// Only offered where it can work: the API exists, the page is a secure context (HTTPS / localhost; a phone on
// plain http:// LAN/Tailscale is not one) and the page may act (not WiFi view-only).
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';

export const VOICE_LANG_KEY = 'office.voiceLang';
const LANGS = ['id-ID', 'en-US'];

// Error codes of SpeechRecognitionErrorEvent → a short message (null = say nothing).
const ERRORS = {
  'not-allowed': 'Akses mikrofon ditolak — izinkan mikrofon untuk situs ini di pengaturan browser.',
  'service-not-allowed': 'Input suara tidak diizinkan di browser ini.',
  'no-speech': 'Tidak terdengar suara — coba lagi dan bicara lebih dekat ke mikrofon.',
  'audio-capture': 'Mikrofon tidak ditemukan.',
  network: 'Input suara butuh internet (pengenalan suara dikerjakan layanan browser).',
  'language-not-supported': 'Bahasa ini belum didukung input suara browser.',
  aborted: null,
};

const voice = { rec: null, project: null };

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition;

/** The button is offered at all (feature detection + secure context + allowed to act). */
export const voiceAvailable = () => Boolean(Recognition()) && window.isSecureContext && !state.readOnly && state.active !== DEMO_ID;

export const voiceRecording = () => Boolean(voice.rec);

function readLang() {
  try {
    const saved = localStorage.getItem(VOICE_LANG_KEY);
    return LANGS.includes(saved) ? saved : LANGS[0];
  } catch {
    return LANGS[0];
  }
}

/** Shows/hides 🎤 (called from renderComposer: project switch, read-only, demo). Stops when it no longer applies. */
export function renderVoice() {
  const available = voiceAvailable();
  $('#btn-voice').hidden = !available;
  $('#voice-lang-ctl').hidden = !available;
  if (voice.rec && (!available || voice.project !== state.active)) stopVoice();
}

function renderButton() {
  const on = voiceRecording();
  const btn = $('#btn-voice');
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Hentikan input suara' : 'Mulai input suara');
  btn.title = on ? 'Mendengarkan… klik, Esc atau Alt+M untuk berhenti' : 'Input suara (Alt+M)';
}

function setLive(interim) {
  const live = $('#voice-live');
  if (!voice.rec) {
    live.textContent = '';
    return;
  }
  live.innerHTML = '';
  const label = document.createElement('i');
  label.textContent = '🎤 Mendengarkan… ';
  live.append(label, document.createTextNode(interim)); // text node: recognised words are never parsed as HTML
}

/** Inserts `text` at the prompt's cursor (replacing a selection), with a space where words would touch. */
export function insertAtCursor(text) {
  const input = $('#prompt');
  const words = text.trim();
  if (!words) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  input.setRangeText(`${lead}${words}${trail}`, start, end, 'end');
  if (trail) input.setSelectionRange(input.selectionEnd - 1, input.selectionEnd - 1); // cursor before the added space
  // The app's own input handlers run as for typing: autosize, draft, bash mode, autocomplete.
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function onResult(e) {
  let interim = '';
  let final = '';
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const result = e.results[i];
    const transcript = result[0]?.transcript ?? '';
    if (result.isFinal) final += transcript;
    else interim += transcript;
  }
  if (final) insertAtCursor(final);
  setLive(interim.trim());
}

function finish() {
  voice.rec = null;
  voice.project = null;
  setLive('');
  renderButton();
}

export function startVoice() {
  if (voice.rec || !voiceAvailable()) return;
  const Rec = Recognition();
  let rec;
  try {
    rec = new Rec();
  } catch {
    toast('Input suara tidak tersedia di browser ini.');
    return;
  }
  rec.lang = $('#voice-lang').value || readLang();
  rec.interimResults = true;
  rec.continuous = true; // keeps listening through pauses until stopped (or the browser ends it)
  rec.maxAlternatives = 1;
  const project = state.active;
  rec.onresult = (e) => {
    if (state.active === project) onResult(e); // late words after a project switch don't land in another box
  };
  rec.onerror = (e) => {
    const text = e.error in ERRORS ? ERRORS[e.error] : `Input suara gagal (${e.error}).`;
    if (text) toast(text);
  };
  rec.onend = () => {
    if (voice.rec === rec) finish();
  };
  voice.rec = rec;
  voice.project = project;
  try {
    rec.start();
  } catch {
    finish();
    toast('Input suara gagal dimulai — coba lagi.');
    return;
  }
  renderButton();
  setLive('');
  $('#prompt').focus({ preventScroll: true }); // the cursor shows where the words will land
}

/** Stops listening; words still being processed arrive as a last final result before `end`. */
export function stopVoice() {
  const rec = voice.rec;
  if (!rec) return;
  try {
    rec.stop();
  } catch {
    // already stopped
  }
  // Some engines never fire `end` after an error: the UI must not stay "recording".
  setTimeout(() => {
    if (voice.rec === rec) finish();
  }, 1500);
}

export const toggleVoice = () => (voice.rec ? stopVoice() : startVoice());

export function initVoice() {
  $('#voice-lang').value = readLang();
  $('#voice-lang').addEventListener('change', (e) => {
    try {
      localStorage.setItem(VOICE_LANG_KEY, e.target.value);
    } catch {
      // not remembered
    }
    if (voice.rec) {
      stopVoice(); // a new language applies from the next start
      toast('Bahasa input suara diganti — klik 🎤 lagi untuk mulai.', 'ok');
    }
  });
  // mousedown would move focus away from the prompt (and its cursor) on some browsers: keep it there.
  $('#btn-voice').addEventListener('mousedown', (e) => e.preventDefault());
  $('#btn-voice').addEventListener('click', toggleVoice);
  // Capture phase, after ui/shortcuts.js (which closes dialogs first): Esc while recording only stops recording,
  // it does not also stop the running turn. Alt+M toggles from anywhere (by key position: Alt+M types µ on a Mac).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && voice.rec && !document.querySelector('.modal:not([hidden])')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        stopVoice();
      } else if (e.code === 'KeyM' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && voiceAvailable()) {
        if (e.repeat || document.querySelector('.modal:not([hidden])')) return; // held key / a dialog open: not for the composer
        e.preventDefault();
        toggleVoice();
      }
    },
    true,
  );
  renderVoice();
  renderButton();
}
