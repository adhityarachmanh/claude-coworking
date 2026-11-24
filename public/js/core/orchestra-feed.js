// 🎼 Mode Orkestra: the music rules and the score. Pure: no DOM, no audio; office/orchestra.js draws and plays.
// The music is made to stay pleasant whatever the team does:
//   - every note is a tone of the chord playing at that moment (a slow I–vi–IV–V progression in C; the relative minor
//     progression while something failed), so two notes never clash
//   - notes wait for the next beat (BPM) and at most a few sound per beat; a burst of steps is not a burst of sound
//   - while an approval waits the music holds (a fermata); a failure is a mood change (minor), never a dissonance

export const BPM = 84;
const BEAT_MS = 60000 / BPM;
const BARS_PER_CHORD = 2;
const C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11;

// pitch classes of each chord (root first)
const PROGRESSIONS = {
  major: [
    { name: 'C', tones: [C, E, G] },
    { name: 'Am', tones: [A, C, E] },
    { name: 'F', tones: [F, A, C] },
    { name: 'G', tones: [G, B, D] },
  ],
  minor: [
    { name: 'Am', tones: [A, C, E] },
    { name: 'F', tones: [F, A, C] },
    { name: 'Dm', tones: [D, F, A] },
    { name: 'E', tones: [E, 8, B] }, // E major (G#): the dominant that leads back home
  ],
  bright: [
    { name: 'C', tones: [C, E, G] },
    { name: 'F', tones: [F, A, C] },
    { name: 'G', tones: [G, B, D] },
    { name: 'C', tones: [C, E, G] },
  ],
};

/** The chord playing at `ms` (time since the music started) in a mood: 'major' | 'minor' | 'bright'. */
export function chordAt(ms, mood = 'major') {
  const list = PROGRESSIONS[mood] ?? PROGRESSIONS.major;
  const index = Math.floor(Math.max(0, ms) / (BEAT_MS * 4 * BARS_PER_CHORD)) % list.length;
  return list[index];
}

// Each role's instrument: its register (octave of MIDI notes), timbre and an emoji for the stage.
export const VOICES = {
  claude: { emoji: '🪄', octave: 5, timbre: 'bell', name: 'konduktor' },
  pm: { emoji: '🎼', octave: 6, timbre: 'bell', name: 'concertmaster' },
  ba: { emoji: '🎷', octave: 5, timbre: 'pad', name: 'saksofon' },
  architect: { emoji: '🎹', octave: 4, timbre: 'pluck', name: 'piano' },
  'ui-ux': { emoji: '🎻', octave: 5, timbre: 'pluck', name: 'biola' },
  frontend: { emoji: '🎻', octave: 5, timbre: 'pluck', name: 'biola' },
  backend: { emoji: '🎺', octave: 3, timbre: 'pad', name: 'cello' },
  dba: { emoji: '🪕', octave: 4, timbre: 'pluck', name: 'harpa' },
  qa: { emoji: '🥁', octave: 4, timbre: 'perc', name: 'timpani' },
  security: { emoji: '🥁', octave: 3, timbre: 'perc', name: 'gong' },
  devops: { emoji: '🥁', octave: 3, timbre: 'perc', name: 'drum' },
  writer: { emoji: '🎷', octave: 5, timbre: 'pad', name: 'flute' },
  freelancer: { emoji: '🎸', octave: 4, timbre: 'pluck', name: 'gitar' },
  default: { emoji: '🎵', octave: 4, timbre: 'pluck', name: 'instrumen' },
};
export const voiceOf = (role) => VOICES[role] ?? VOICES.default;

/**
 * The MIDI note of one event: a tone of `chord` in the role's register. `kind`: 'step' (a tool call), 'cue' (a
 * hand-out), 'done' (a report). `seq` varies the chord tone so a busy role plays a little melody, not one note.
 */
export function noteFor({ role, kind = 'step', seq = 0 }, chord) {
  const v = voiceOf(role);
  const tones = chord.tones;
  const pick = kind === 'done' ? tones[0] : kind === 'cue' ? tones[(seq % 2) + 1] : tones[Math.abs(seq) % tones.length];
  const octave = Math.max(3, Math.min(6, v.octave + (kind === 'cue' ? 1 : 0)));
  return 12 * (octave + 1) + pick; // MIDI: C4 = 60
}

/** Holds events until the next beat; plays at most `maxPerBeat` per beat; drops the rest; nothing while `hold`. */
export class NoteScheduler {
  constructor({ maxPerBeat = 3, beatMs = BEAT_MS } = {}) {
    this.maxPerBeat = maxPerBeat;
    this.beatMs = beatMs;
    this.queue = [];
    this.hold = false;
    this.lastBeat = -1;
  }

  /** An event at time `ms` (one note per role per beat at most: the queue keeps the first). */
  push(evt, ms) {
    if (this.queue.length >= this.maxPerBeat * 2) return;
    if (this.queue.some((q) => q.role === evt.role && q.kind === evt.kind)) return;
    this.queue.push({ ...evt, ms });
  }

  /** The notes to play now: on a new beat, up to `maxPerBeat` queued events (stamped with the beat time). */
  tick(ms) {
    const beat = Math.floor(ms / this.beatMs);
    if (beat <= this.lastBeat || beat < 1) return [];
    this.lastBeat = beat;
    if (this.hold) {
      this.queue = [];
      return [];
    }
    const at = beat * this.beatMs;
    const due = this.queue.filter((q) => q.ms < at).slice(0, this.maxPerBeat);
    this.queue = []; // a burst's surplus is dropped: the next beat starts fresh
    return due.map((q) => ({ ...q, at }));
  }
}

/**
 * The score under the stage: one note per real step of the current mission (since the latest prompt), on the
 * staff of the role that did it (the Lead's own steps on the coordinator's, as in the office). `fail` = a failed step.
 * @returns {{ start: number, lanes: { role: string, notes: { t: number, fail: boolean }[] }[] }}
 */
export function scoreNotes(chat, { coordinator = 'claude', now = Date.now() } = {}) {
  const all = Array.isArray(chat) ? chat.filter((m) => m && typeof m === 'object') : [];
  const last = all.findLastIndex((m) => m.kind === 'user');
  const rows = last >= 0 ? all.slice(last) : all;
  const start = rows.length && Number.isFinite(rows[0].ts) ? rows[0].ts : now;
  const lanes = new Map();
  for (const m of rows) {
    if (m.kind !== 'tool' && m.kind !== 'delegate' && m.kind !== 'approval') continue;
    const role = m.kind === 'delegate' ? m.role : !m.role || m.role === 'claude' ? coordinator : m.role;
    if (!role) continue;
    if (!lanes.has(role)) lanes.set(role, []);
    lanes.get(role).push({ t: Number.isFinite(m.ts) ? m.ts : now, fail: m.status === 'fail' });
  }
  return { start, lanes: [...lanes.entries()].map(([role, notes]) => ({ role, notes })).sort((a, b) => a.notes[0].t - b.notes[0].t) };
}
