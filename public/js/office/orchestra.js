// 🎼 Mode Orkestra: the team as an orchestra on a concert stage. The Lead conducts from the podium (baton up while a
// turn runs), the PM is the concertmaster with the score (task board) cueing the sections, every role plays its
// instrument: a real step = a note rising from its player (and, with sound on, a soft note on the beat). A failure
// turns the music minor and tints the player red, a waiting approval holds the music (fermata, raised hand), the end of
// a turn resolves home. The score under the stage is the mission timeline: one note per real step, on its role's staff.
import { missionFeed } from '../core/mission-feed.js';
import { BPM, chordAt, NoteScheduler, noteFor, scoreNotes, voiceOf } from '../core/orchestra-feed.js';
import { projectName, state } from '../core/state.js';
import { LEVEL_LABEL, OrchestraAudio } from './orchestra-audio.js';
import { CAST, roleColor } from './cast.js';
import { roster, teamOrder } from './roster.js';

const TAU = Math.PI * 2;
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
const SERIF = 'Georgia, "Times New Roman", serif';
const BEAT_MS = 60000 / BPM;
const NOTE_CHARS = ['♩', '♪', '♫', '♬'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const coordinator = () => (roster.enabled.includes('pm') ? 'pm' : 'claude');
const color = (r) => (r === 'claude' ? '#ffb347' : roleColor(r));
const short = (r) => (r === 'claude' ? 'Lead' : (CAST[r]?.short ?? r));
const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `T+${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export class Orchestra {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'orchestra-canvas';
    this.canvas.setAttribute('aria-label', 'Mode Orkestra: tim sebagai orkestra');
    this.g = this.canvas.getContext('2d');
    host.append(this.canvas);
    this.on = false;
    this.w = this.h = 0;
    this.dpr = 1;
    this.audio = new OrchestraAudio();
    this.scheduler = new NoteScheduler({ maxPerBeat: 3 });
    this.musicStart = performance.now();
    this.mood = 'major';
    this.moodUntil = 0;
    this.seq = 0;
    this.floating = []; // { role, char, t0, dx }
    this.reds = new Map(); // role -> until
    this.pos = {}; // role -> { x, y } of the last frame
    this.soundBtn = null;
    this.batonUp = false;
    this.lastChord = '';
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const b = this.soundBtn;
      if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.audio.cycle(); // inside the click: the browser allows audio to start
        if (this.audio.on) this.audio.setChord(chordAt(performance.now() - this.musicStart, this.mood));
        return;
      }
      const hit = Object.entries(this.pos).find(([, p]) => Math.hypot(p.x - x, p.y - y) < 26);
      // same handler as a neuron in Mode Otak (features/view-mode.js): approval card, tasks, or Aktivitas
      if (hit) host.dispatchEvent(new CustomEvent('brain-neuron', { bubbles: true, detail: { role: hit[0] } }));
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  setOn(on) {
    this.on = on;
    this.host.classList.toggle('orchestra-mode', on);
    if (on) {
      this.resize();
      if (this.audio.on) this.audio.setLevel(this.audio.level); // resumes after a reload only once clicked (browser rule)
    } else this.audio.stop();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Live office events of the active project become notes (on the next beat) and mood changes. */
  event(evt) {
    if (!this.on) return;
    const ms = performance.now() - this.musicStart;
    const role = evt.role ?? 'claude';
    switch (evt.kind) {
      case 'prompt':
        this.batonUp = true;
        this.mood = 'major';
        break;
      case 'tool_start':
        this.scheduler.push({ role, kind: 'step', seq: this.seq++ }, ms);
        break;
      case 'delegate':
        this.scheduler.push({ role: evt.from ?? coordinator(), kind: 'cue', seq: this.seq++ }, ms);
        break;
      case 'agent_stop':
        this.scheduler.push({ role, kind: 'done' }, ms);
        break;
      case 'tests':
        if (evt.failed) this.setMood('minor', 16, role);
        else this.setMood('bright', 8);
        break;
      case 'tool_fail':
      case 'error':
        this.setMood('minor', 16, role);
        break;
      case 'stop':
        this.batonUp = false;
        this.setMood('bright', 8);
        this.scheduler.push({ role: 'claude', kind: 'done' }, ms); // the cadence home
        break;
      default:
    }
  }

  setMood(mood, beats, redRole) {
    this.mood = mood;
    this.moodUntil = performance.now() + beats * BEAT_MS;
    if (redRole) this.reds.set(redRole, performance.now() + 2500);
  }

  frame(t, scene) {
    if (!this.on || this.w < 120 || this.h < 120) return;
    const g = this.g;
    const now = performance.now();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const project = state.active;
    const st = state.statuses[project] ?? {};
    const m = missionFeed(state.chats[project] ?? [], { now: Date.now(), coordinator: coordinator(), team: teamOrder(), events: state.events[project] ?? [] });
    const people = scene?.people ?? {};
    for (const s of m.stations) {
      const p = people[s.role];
      if (p?.asking) s.state = 'hold';
      else if (s.state !== 'hold' && p?.isBusy?.(now)) s.state = 'go';
    }

    // the music: mood back to major when its time is up; a waiting approval holds everything (fermata)
    if (this.mood !== 'major' && now > this.moodUntil) this.mood = 'major';
    const ms = now - this.musicStart;
    const chord = chordAt(ms, this.mood);
    const holding = m.holds.length > 0 || Object.values(people).some((p) => p.asking);
    this.scheduler.hold = holding;
    if (chord.name !== this.lastChord) {
      this.lastChord = chord.name;
      this.audio.setChord(chord);
    }
    for (const n of this.scheduler.tick(ms)) {
      this.audio.play(noteFor(n, chord), voiceOf(n.role).timbre);
      this.floating.push({ role: n.role, char: NOTE_CHARS[(n.seq ?? 0) % NOTE_CHARS.length], t0: now, dx: (Math.random() - 0.5) * 18 });
    }
    if (this.floating.length > 60) this.floating.splice(0, this.floating.length - 60);

    const scoreH = this.h > 420 ? clamp(Math.round(this.h * 0.26), 90, 190) : 0;
    const stageH = this.h - scoreH;
    this.drawHall(g, stageH, now);
    this.drawPlayers(g, m, stageH, now, holding);
    this.drawFloating(g, now);
    this.drawHud(g, m, st, project, chord, holding);
    if (scoreH) this.drawScore(g, stageH, scoreH, m);
  }

  drawHall(g, stageH, now) {
    const bg = g.createLinearGradient(0, 0, 0, this.h);
    bg.addColorStop(0, '#14070b');
    bg.addColorStop(0.6, '#1d0c10');
    bg.addColorStop(1, '#0b0608');
    g.fillStyle = bg;
    g.fillRect(0, 0, this.w, this.h);
    // curtains
    const top = 30;
    const curtainH = stageH * 0.26;
    for (let x = 0; x < this.w; x += 26) {
      const c = g.createLinearGradient(x, 0, x + 26, 0);
      c.addColorStop(0, '#3a0d16');
      c.addColorStop(0.5, '#5a1422');
      c.addColorStop(1, '#3a0d16');
      g.fillStyle = c;
      g.globalAlpha = 0.5;
      g.fillRect(x, top, 26, curtainH);
    }
    g.globalAlpha = 1;
    g.fillStyle = '#2a0a10';
    g.beginPath();
    g.moveTo(0, top + curtainH);
    for (let x = 0; x <= this.w; x += 52) g.quadraticCurveTo(x + 26, top + curtainH + 18, x + 52, top + curtainH);
    g.lineTo(this.w, top);
    g.lineTo(0, top);
    g.fill();
    // stage floor
    const cx = this.w / 2;
    const fy = stageH * 0.68;
    const fl = g.createRadialGradient(cx, fy, 30, cx, fy, this.w * 0.55);
    fl.addColorStop(0, '#5a3a1e');
    fl.addColorStop(0.6, '#2e1c10');
    fl.addColorStop(1, '#140b06');
    g.fillStyle = fl;
    g.beginPath();
    g.ellipse(cx, fy, this.w * 0.47, stageH * 0.3, 0, Math.PI, 0);
    g.ellipse(cx, fy, this.w * 0.47, stageH * 0.1, 0, 0, Math.PI);
    g.fill();
    // a slow warm breath of light on the podium, with the tempo
    const pulse = 0.28 + 0.06 * Math.sin((now / BEAT_MS) * Math.PI);
    this.spot(g, cx, stageH * 0.74, '255,210,140', pulse, 120);
  }

  spot(g, x, y, rgb, a, r = 90) {
    const s = g.createRadialGradient(x, y, 0, x, y, r);
    s.addColorStop(0, `rgba(${rgb},${a})`);
    s.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = s;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.42, 0, 0, TAU);
    g.fill();
  }

  /** Sections on two arcs behind the podium; the concertmaster (PM) beside the conductor (Lead). */
  drawPlayers(g, m, stageH, now, holding) {
    const cx = this.w / 2;
    const coord = coordinator();
    const by = Object.fromEntries(m.stations.map((s) => [s.role, s]));
    const order = teamOrder().filter((r) => r !== 'claude' && r !== coord && by[r]);
    const rows = [order.slice(0, Math.ceil(order.length * 0.55)), order.slice(Math.ceil(order.length * 0.55))];
    this.pos = {};
    const scale = clamp(Math.min(this.w / 1200, stageH / 560), 0.55, 1.15);
    rows.forEach((row, ri) => {
      const ry = stageH * (ri ? 0.6 : 0.43);
      const span = this.w * (ri ? 0.32 : 0.4);
      row.forEach((role, i) => {
        const a = row.length === 1 ? 0 : (i / (row.length - 1)) * 2 - 1;
        this.pos[role] = { x: cx + a * span, y: ry - (1 - a * a) * stageH * 0.05 };
      });
    });
    this.pos.claude = { x: cx, y: stageH * 0.74 };
    if (coord !== 'claude') this.pos[coord] = { x: cx + 150 * scale, y: stageH * 0.7 };
    for (const role of order) this.drawPlayer(g, role, by[role], this.pos[role], scale, now);
    if (coord !== 'claude') this.drawPlayer(g, coord, by[coord] ?? { state: 'stby' }, this.pos[coord], scale, now, true);
    this.drawConductor(g, this.pos.claude, scale, now, holding);
    if (holding) {
      g.font = `bold ${Math.round(30 * scale)}px ${SERIF}`;
      g.fillStyle = '#ffc24a';
      g.textAlign = 'center';
      g.fillText('𝄐', cx, stageH * 0.2 + 30);
      g.font = `11px ${MONO}`;
      g.fillText('⏸ fermata — menunggu izinmu', cx, stageH * 0.2 + 48);
      g.textAlign = 'left';
    }
  }

  drawPlayer(g, role, s, p, scale, now, concertmaster = false) {
    const c = color(role);
    const red = (this.reds.get(role) ?? 0) > now || s.state === 'fail';
    const playing = s.state === 'go';
    if (playing) this.spot(g, p.x, p.y + 24 * scale, '255,220,150', 0.22, 80 * scale);
    if (red) this.spot(g, p.x, p.y + 24 * scale, '255,80,90', 0.22, 80 * scale);
    g.save();
    g.globalAlpha = s.state === 'stby' ? 0.42 : 1;
    // a small bob on the beat while playing
    const bob = playing ? Math.sin((now / BEAT_MS) * Math.PI * 2) * 1.5 : 0;
    const y = p.y + bob;
    g.fillStyle = '#120a0a';
    g.beginPath();
    g.ellipse(p.x, y + 36 * scale, 32 * scale, 9 * scale, 0, 0, TAU);
    g.fill();
    g.fillStyle = c;
    g.beginPath();
    g.arc(p.x, y, 12 * scale, 0, TAU);
    g.fill();
    g.fillRect(p.x - 13 * scale, y + 11 * scale, 26 * scale, 24 * scale);
    if (s.state === 'hold') g.fillRect(p.x - 19 * scale, y - 30 * scale, 5 * scale, 22 * scale); // a raised hand
    g.font = `${Math.round(24 * scale)}px serif`;
    g.fillText(concertmaster ? '🎼' : voiceOf(role).emoji, p.x + 11 * scale, y + 32 * scale);
    g.font = `bold ${Math.round(11 * Math.max(scale, 0.85))}px ${MONO}`;
    g.textAlign = 'center';
    g.fillStyle = red ? '#ff6b7a' : s.state === 'hold' ? '#ffc24a' : c;
    const tag = s.state === 'done' ? ' ✔' : s.state === 'stby' ? ' · standby' : s.state === 'fail' ? ' ✖' : s.state === 'hold' ? ' ⏸' : '';
    g.fillText(`${short(role)}${concertmaster ? ' · concertmaster' : ''}${tag}`, p.x, y + 52 * scale);
    if (concertmaster && s.what) {
      g.font = `10px ${MONO}`;
      g.fillStyle = '#ff9bd0';
      g.fillText(s.what.length > 34 ? `${s.what.slice(0, 33)}…` : s.what, p.x, y + 66 * scale);
    }
    g.textAlign = 'left';
    g.restore();
  }

  drawConductor(g, p, scale, now, holding) {
    g.fillStyle = '#3a2414';
    g.strokeStyle = '#ffb347';
    g.fillRect(p.x - 40 * scale, p.y + 34 * scale, 80 * scale, 22 * scale);
    g.strokeRect(p.x - 40 * scale, p.y + 34 * scale, 80 * scale, 22 * scale);
    g.fillStyle = '#ffb347';
    g.beginPath();
    g.arc(p.x, p.y - 4 * scale, 14 * scale, 0, TAU);
    g.fill();
    g.fillRect(p.x - 15 * scale, p.y + 10 * scale, 30 * scale, 26 * scale);
    // the baton: beats time while the team works, rests when the turn is over, freezes up on a fermata
    const swing = this.batonUp && !holding ? Math.sin((now / BEAT_MS) * Math.PI) * 0.5 : 0;
    const ang = holding ? -1.2 : this.batonUp ? -0.8 + swing : 0.5;
    const bx = p.x + 14 * scale;
    const byy = p.y + 12 * scale;
    g.strokeStyle = '#fff3c0';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(bx, byy);
    g.lineTo(bx + Math.cos(ang) * 50 * scale, byy + Math.sin(ang) * 50 * scale);
    g.stroke();
    g.lineWidth = 1;
    g.font = `bold 12px ${MONO}`;
    g.fillStyle = '#ffd27a';
    g.textAlign = 'center';
    g.fillText('LEAD · konduktor', p.x, p.y + 72 * scale);
    g.textAlign = 'left';
  }

  drawFloating(g, now) {
    const life = 2600;
    this.floating = this.floating.filter((n) => now - n.t0 < life);
    for (const n of this.floating) {
      const p = this.pos[n.role] ?? this.pos[coordinator()] ?? this.pos.claude;
      if (!p) continue;
      const q = (now - n.t0) / life;
      const red = (this.reds.get(n.role) ?? 0) > n.t0;
      const c = red ? '#ff6b7a' : color(n.role);
      g.globalAlpha = 1 - q;
      g.fillStyle = c;
      g.shadowColor = c;
      g.shadowBlur = 10;
      g.font = `22px ${SERIF}`;
      g.fillText(red ? '♭' : n.char, p.x + n.dx + Math.sin(q * 6) * 6, p.y - 20 - q * 120);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
  }

  drawHud(g, m, st, project, chord, holding) {
    g.fillStyle = 'rgba(10,4,6,0.85)';
    g.fillRect(0, 0, this.w, 28);
    g.textBaseline = 'middle';
    g.font = `bold 13px ${MONO}`;
    g.fillStyle = '#ffd27a';
    const title = `🎼 ORKESTRA // ${project ? projectName(project) : '-'}`;
    g.fillText(title, 12, 14);
    const minutes = Math.max(1 / 60, m.elapsedMs / 60000);
    const tempo = m.telemetry.steps ? Math.round(m.telemetry.steps / minutes) : 0;
    const mood = holding ? 'fermata' : this.mood === 'minor' ? 'minor (ada yang gagal)' : this.mood === 'bright' ? 'cerah' : 'mayor';
    const info = `${m.prompt ? `"${m.prompt}" · ` : ''}tempo ${tempo} langkah/mnt · akor ${chord.name} · ${mood} · ${clock(m.elapsedMs)}`;
    const label = LEVEL_LABEL[this.audio.level];
    g.font = `12px ${MONO}`;
    const bw = g.measureText(label).width + 18;
    const room = this.w - bw - 24 - g.measureText(title).width - 30;
    let text = info;
    while (text.length > 4 && g.measureText(text).width > room) text = `${text.slice(0, -2)}…`;
    g.fillStyle = '#e8d8c0';
    g.fillText(text, 30 + g.measureText(title).width + 10, 14);
    this.soundBtn = { x: this.w - bw - 8, y: 4, w: bw, h: 20 };
    g.strokeStyle = this.audio.on ? '#9fd8ff' : '#6b5a50';
    g.beginPath();
    g.roundRect(this.soundBtn.x, this.soundBtn.y, bw, 20, 10);
    g.stroke();
    g.fillStyle = this.audio.on ? '#9fd8ff' : '#b8a898';
    g.fillText(label, this.soundBtn.x + 9, 14);
  }

  drawScore(g, top, h, m) {
    const s = scoreNotes(state.chats[state.active] ?? [], { coordinator: coordinator(), now: Date.now() });
    const x0 = 12;
    const w = this.w - 24;
    g.fillStyle = 'rgba(245,232,208,0.06)';
    g.fillRect(x0, top + 4, w, h - 10);
    g.font = `bold 11px ${MONO}`;
    g.fillStyle = '#c8b89a';
    g.textBaseline = 'middle';
    g.fillText('PARTITUR MISI · not = langkah nyata, ✖ = langkah gagal', x0 + 8, top + 16);
    const labelW = 86;
    const sx = x0 + labelW;
    const sw = w - labelW - 14;
    const span = Math.max(1, Date.now() - s.start);
    const laneH = clamp(Math.floor((h - 34) / Math.max(1, s.lanes.length)), 14, 30);
    const room = Math.max(1, Math.floor((h - 34) / laneH));
    if (!s.lanes.length) {
      g.font = `11px ${MONO}`;
      g.fillStyle = '#8a7a68';
      g.fillText('Belum ada not: kirim prompt, orkestra mulai bermain.', x0 + 8, top + 40);
    }
    s.lanes.slice(0, room).forEach((lane, i) => {
      const y = top + 30 + i * laneH;
      const gap = Math.max(2, (laneH - 6) / 5);
      g.strokeStyle = 'rgba(200,184,154,0.22)';
      for (let k = 0; k < 5; k++) {
        g.beginPath();
        g.moveTo(sx, y + k * gap);
        g.lineTo(sx + sw, y + k * gap);
        g.stroke();
      }
      g.font = `bold 11px ${MONO}`;
      g.fillStyle = color(lane.role);
      g.fillText(short(lane.role), x0 + 8, y + gap * 2);
      lane.notes.forEach((n, j) => {
        const nx = sx + ((n.t - s.start) / span) * sw;
        const ny = y + (j % 4) * gap;
        g.fillStyle = n.fail ? '#ff4a5a' : color(lane.role);
        g.beginPath();
        g.ellipse(nx, ny, 3.8, 2.8, -0.4, 0, TAU);
        g.fill();
        g.fillRect(nx + 3, ny - gap * 3, 1.3, gap * 3);
        if (n.fail) g.fillText('✖', nx + 6, ny - 2);
      });
    });
    g.fillStyle = '#ffd36a';
    g.fillRect(sx + sw - 1, top + 24, 2, h - 34);
  }
}
