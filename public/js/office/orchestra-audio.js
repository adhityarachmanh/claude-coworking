// 🎼 Mode Orkestra's sound (WebAudio, no audio files). Off by default; three levels (off / pelan / sedang), remembered
// per browser. Soft by construction: slow attacks, long fades, a quiet chord pad under everything, one master gain
// and a compressor as a limiter. Which notes to play is decided by core/orchestra-feed.js (always chord tones).

const KEY = 'office.orchestraSound';
const LEVEL_GAIN = [0, 0.14, 0.28];
export const LEVEL_LABEL = ['🔇 suara mati', '🔉 suara pelan', '🔊 suara sedang'];
const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);

export class OrchestraAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.pad = []; // the chord pad's oscillators { osc, gain }
    this.padChord = '';
    try {
      this.level = Math.max(0, Math.min(2, Number(localStorage.getItem(KEY)) || 0));
    } catch {
      this.level = 0;
    }
  }

  get on() {
    return this.level > 0;
  }

  /** Next level (called from a click: the browser lets audio start only after a user gesture). */
  cycle() {
    this.setLevel((this.level + 1) % LEVEL_GAIN.length);
  }

  setLevel(level) {
    this.level = level;
    try {
      localStorage.setItem(KEY, String(level));
    } catch {}
    if (!level) return this.stop();
    if (!this.ensure()) return;
    this.ctx.resume?.();
    this.master.gain.setTargetAtTime(LEVEL_GAIN[level], this.ctx.currentTime, 0.2);
  }

  ensure() {
    if (this.ctx) return true;
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctx) return false;
    this.ctx = new Ctx();
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.ratio.value = 8;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(limiter);
    limiter.connect(this.ctx.destination);
    return true;
  }

  /** Mode left or sound off: fade out, stop the pad, let the context sleep. */
  stop() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0, t, 0.15);
    for (const v of this.pad) v.osc.stop(t + 0.8);
    this.pad = [];
    this.padChord = '';
    setTimeout(() => this.level === 0 && this.ctx?.suspend?.(), 900);
  }

  /** The quiet chord pad under the melody: crossfades when the chord changes. */
  setChord(chord) {
    if (!this.on || !this.ctx || chord.name === this.padChord) return;
    this.padChord = chord.name;
    const t = this.ctx.currentTime;
    for (const v of this.pad) {
      v.gain.gain.setTargetAtTime(0, t, 0.6);
      v.osc.stop(t + 3);
    }
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(this.master);
    this.pad = chord.tones.map((pc, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = i ? 'sine' : 'triangle';
      osc.frequency.value = freq(48 + pc + (i ? 12 : 0)); // C3 region: low and warm
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(0.05, t, 0.9);
      osc.connect(gain);
      gain.connect(lp);
      osc.start(t);
      return { osc, gain };
    });
  }

  /** One note, soft: `timbre` 'pad' | 'pluck' | 'bell' | 'perc'. */
  play(midi, timbre) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime + 0.01;
    const f = freq(midi);
    const out = this.ctx.createGain();
    out.connect(this.master);
    const env = (g, attack, peak, release) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    };
    const osc = (type, hz, gain, attack, release) => {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      const g = this.ctx.createGain();
      env(g, attack, gain, release);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      o.connect(g);
      g.connect(lp);
      lp.connect(out);
      o.start(t);
      o.stop(t + attack + release + 0.05);
    };
    if (timbre === 'pad') {
      osc('triangle', f, 0.18, 0.09, 1.6);
      osc('sine', f * 1.003, 0.1, 0.12, 1.6);
    } else if (timbre === 'bell') {
      osc('sine', f, 0.16, 0.01, 1.5);
      osc('sine', f * 2, 0.05, 0.01, 0.9);
    } else if (timbre === 'perc') {
      osc('sine', f / 2, 0.22, 0.005, 0.35); // a soft timpani-like thump on a chord tone
    } else {
      osc('triangle', f, 0.17, 0.006, 0.9);
    }
  }
}
