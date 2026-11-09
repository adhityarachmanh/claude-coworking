// 🔊 Bacakan balasan asisten (Web Speech API). Per device, no dependency, no text sent to the server.
// Markdown is cleaned into speakable text; code blocks are skipped instead of read character by character.
const KEY = 'office.tts';
const MAX_CHARS = 4000;

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Saved on this device only (false when storage is blocked). */
export function ttsOn() {
  try {
    return storage()?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Turn it on/off, stopping a sentence that is already being read when turned off. */
export function setTtsOn(on) {
  const value = Boolean(on);
  try {
    storage()?.setItem(KEY, value ? '1' : '0');
  } catch {
    // storage blocked: works for this page only
  }
  if (!value) stopSpeaking();
}

/** Web Speech API present (Chrome/Edge/Safari; some headless browsers do not offer it). */
export const canSpeak = () =>
  Boolean(globalThis.window && 'speechSynthesis' in globalThis.window && typeof globalThis.window.SpeechSynthesisUtterance === 'function');

/**
 * Markdown → plain text for the voice. Code fences are dropped (they are unreadable), inline code keeps its words,
 * links keep their label, headings/emphasis/HTML are stripped. Very long answers stop at a word boundary.
 */
export function speechText(markdown) {
  let text = String(markdown ?? '');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/[*_~>#]+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS).replace(/\s+\S*$/, '')}…`;
  return text;
}

/** The first voice that speaks Indonesian, else the browser default. */
function pickVoice(voices) {
  if (!Array.isArray(voices)) return null;
  return voices.find((v) => /^id(-|_)?/i.test(String(v?.lang ?? ''))) ?? null;
}

/**
 * The assistant answer that belongs to `result`: the last non-empty assistant message after the previous result.
 * An empty turn therefore returns null instead of re-reading the answer before it.
 */
export function answerForResult(messages, result) {
  const list = Array.isArray(messages) ? messages : [];
  const at = list.lastIndexOf(result);
  if (at <= 0) return null;
  const previousResult = list.slice(0, at).findLastIndex((m) => m?.kind === 'result');
  return list.slice(previousResult + 1, at).findLast((m) => m?.kind === 'assistant' && String(m.text ?? '').trim()) ?? null;
}

/** Cancel whatever is being read (Stop/Esc, or a new answer). */
export function stopSpeaking() {
  if (!canSpeak()) return;
  try {
    globalThis.window.speechSynthesis.cancel();
  } catch {
    // no speech engine: nothing to stop
  }
}

/**
 * Read one finished assistant answer. Returns false when TTS is off, the browser cannot speak, or the text is empty.
 * A long answer is cut at a word boundary (the full text stays on screen).
 */
export function speakAnswer(markdown) {
  if (!ttsOn() || !canSpeak()) return false;
  const text = speechText(markdown);
  if (!text) return false;
  const synth = globalThis.window.speechSynthesis;
  const Utterance = globalThis.window.SpeechSynthesisUtterance;
  try {
    const utterance = new Utterance(text);
    utterance.lang = 'id-ID';
    utterance.rate = 1;
    utterance.pitch = 1;
    const voice = pickVoice(synth.getVoices?.());
    if (voice) utterance.voice = voice;
    synth.cancel(); // never overlap two answers
    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/** Stop on ■ Stop / Esc, so a cancelled turn does not keep talking. */
export function initTts() {
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('#btn-stop')) stopSpeaking();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') stopSpeaking();
  });
}
