// 🧠 Mode Otak: the office as a neural network. The Lead is the core in the middle, every role on the team a neuron
// around it; a delegation is a signal travelling down the synapse (and the report travelling back), a tool call a
// pulse, a pending approval an amber halo, an error a red flash. Same data as the pixel office: the active Scene's
// people (who is busy / asking / stuck) and the live office events (stream.js → brain.event), nothing server-side.
import { CAST, roleColor, roleName } from './cast.js';
import { teamOrder } from './roster.js';

const TAU = Math.PI * 2;
const ease = (t) => 1 - (1 - t) ** 3;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "#RRGGBB" → "rgba(r,g,b,a)". */
function rgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  const n = m ? parseInt(m[1], 16) : 0x8899ff;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Brain {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'brain-canvas';
    this.canvas.setAttribute('aria-label', 'Mode Otak: jaringan agen');
    this.g = this.canvas.getContext('2d');
    host.append(this.canvas);
    this.on = false;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.packets = []; // { from, to, color, t0, dur, size }
    this.pulses = []; // { role, color, t0, dur }
    this.ripples = []; // { t0, color }
    this.flashes = new Map(); // role -> { color, until }
    this.links = new Map(); // role -> the role that delegated to it (while it works)
    this.streams = []; // energy flowing core → working neuron: { from, to, t0, dur, size, hue }
    this.lastEmit = new Map(); // role -> when its stream last emitted a particle
    this.lastScene = null;
    this.dust = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + 0.3, v: Math.random() * 0.02 + 0.005, p: Math.random() * TAU }));
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  setOn(on) {
    this.on = on;
    this.host.classList.toggle('brain-mode', on);
    if (on) this.resize();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Where each neuron sits: the Lead in the middle, the others on one ring (two rings for a big team). */
  layout(roles) {
    const cx = this.w / 2;
    const cy = this.h / 2 + 10;
    // one ellipse that uses the stage's width: room for every label, no second ring stacking names on each other
    const rx = this.w * 0.4;
    const ry = (this.h - 90) * 0.42;
    const R = Math.min(rx, ry);
    const others = roles.filter((r) => r !== 'claude');
    const pos = { claude: { x: cx, y: cy, r: clamp(R * 0.17, 18, 34) } };
    others.forEach((role, i) => {
      const a = -Math.PI / 2 + (i / others.length) * TAU;
      pos[role] = { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, r: clamp(R * 0.08, 9, 16), a };
    });
    return pos;
  }

  /** A live office event (the active project's). */
  event(evt) {
    const now = performance.now();
    const role = evt.role ?? 'claude';
    const color = roleColor(role);
    switch (evt.kind) {
      case 'prompt':
        this.ripples.push({ t0: now, color: '#9fb4ff' });
        this.packets.push({ from: '@user', to: 'claude', color: '#c9d4ff', t0: now, dur: 900, size: 4 });
        break;
      case 'delegate': {
        const from = evt.from ?? 'claude';
        this.links.set(role, from);
        for (let i = 0; i < 3; i++) this.packets.push({ from, to: role, color, t0: now + i * 140, dur: 1100, size: 3.2 });
        break;
      }
      case 'agent_stop': {
        const to = this.links.get(role) ?? evt.from ?? 'claude';
        this.links.delete(role);
        this.packets.push({ from: role, to, color: evt.failed ? '#ff5a6a' : '#5dffa8', t0: now, dur: 1000, size: 4 });
        break;
      }
      case 'tool_start':
        this.pulses.push({ role, color, t0: now, dur: 900 });
        break;
      case 'tool_fail':
      case 'error':
        this.flashes.set(role, { color: '#ff5a6a', until: now + 1400 });
        break;
      case 'ask':
        this.pulses.push({ role, color: '#ffc24a', t0: now, dur: 1400 });
        break;
      case 'stop':
        this.ripples.push({ t0: now, color: '#5dffa8' });
        break;
      default:
    }
  }

  frame(t, scene) {
    if (!this.on) return;
    const g = this.g;
    const now = performance.now();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(g, t);
    const roles = teamOrder().filter((r) => CAST[r] || r === 'claude');
    const pos = this.layout(roles);
    if (scene !== this.lastScene) {
      // another project: its own signals only
      this.lastScene = scene;
      this.links.clear();
      this.streams = [];
      this.packets = [];
    }
    const people = scene?.people ?? {};
    const status = scene?.status ?? {};
    const state = (role) => {
      const p = people[role];
      if (!p) return 'idle';
      if (p.asking) return 'ask';
      if (this.flashes.get(role)?.until > now) return 'error';
      if (p.isBusy(now)) return 'busy';
      return 'idle';
    };

    const ring = roles.filter((r) => r !== 'claude');
    // the mesh: each neuron wired to its neighbours on the ring; it lights up around active ones
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const hot = state(a) !== 'idle' || state(b) !== 'idle';
      const flick = hot ? 0.18 + 0.12 * Math.sin(t / 120 + i) : 0.06;
      g.strokeStyle = `rgba(140,160,255,${flick})`;
      g.lineWidth = hot ? 1.4 : 0.8;
      g.beginPath();
      g.moveTo(pos[a].x, pos[a].y);
      g.lineTo(pos[b].x, pos[b].y);
      g.stroke();
    }
    // synapses: Lead ↔ every neuron (faint); a working neuron gets a beam and a continuous stream of energy
    for (const role of ring) {
      const from = this.links.get(role) ?? 'claude';
      const working = state(role) === 'busy' || state(role) === 'ask' || this.links.has(role);
      const src = pos[working ? from : 'claude'] ?? pos.claude;
      this.synapse(g, src, pos[role], roleColor(role), working, t);
      if (working) {
        this.beam(g, src, pos[role], roleColor(role), t);
        // a particle every ~80 ms while it works: the core "transfers" its energy to the worker
        if (now - (this.lastEmit.get(role) ?? 0) > 80) {
          this.lastEmit.set(role, now);
          this.streams.push({ from: working ? from : 'claude', to: role, t0: now, dur: 850 + Math.random() * 350, size: 1.6 + Math.random() * 2, wobble: (Math.random() - 0.5) * 10 });
        }
      }
    }
    this.drawStreams(g, pos, now);
    // thinking core
    this.drawCore(g, pos.claude, Boolean(status.busy || status.cliBusy), t);
    // signals, pulses, ripples
    this.packets = this.packets.filter((k) => now < k.t0 + k.dur);
    for (const k of this.packets) {
      if (now < k.t0) continue;
      const a = k.from === '@user' ? { x: this.w / 2, y: -10 } : pos[k.from];
      const b = pos[k.to];
      if (!a || !b) continue;
      const q = ease((now - k.t0) / k.dur);
      const { x, y } = this.curvePoint(a, b, q);
      g.save();
      g.shadowColor = k.color;
      g.shadowBlur = 16;
      g.fillStyle = k.color;
      g.beginPath();
      g.arc(x, y, k.size, 0, TAU);
      g.fill();
      g.restore();
    }
    this.ripples = this.ripples.filter((r) => now < r.t0 + 1600);
    for (const r of this.ripples) {
      const q = (now - r.t0) / 1600;
      g.strokeStyle = rgba(r.color, 0.5 * (1 - q));
      g.lineWidth = 2;
      g.beginPath();
      g.arc(pos.claude.x, pos.claude.y, pos.claude.r + q * Math.max(this.w, this.h) * 0.5, 0, TAU);
      g.stroke();
    }
    this.pulses = this.pulses.filter((p) => now < p.t0 + p.dur);
    for (const p of this.pulses) {
      const at = pos[p.role] ?? pos.claude;
      const q = (now - p.t0) / p.dur;
      g.strokeStyle = rgba(p.color, 0.8 * (1 - q));
      g.lineWidth = 2;
      g.beginPath();
      g.arc(at.x, at.y, at.r + 4 + q * 22, 0, TAU);
      g.stroke();
    }
    // neurons on top
    for (const role of roles) if (role !== 'claude') this.drawNeuron(g, role, pos[role], state(role), people[role], t);
    this.drawLabel(g, pos.claude, roleName('claude'), status.busy ? 'berpikir…' : '', '#e8ecff', true);
    this.drawGoal(g, scene);
  }

  drawBackground(g, t) {
    const grad = g.createRadialGradient(this.w / 2, this.h / 2, 10, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
    grad.addColorStop(0, '#141a3a');
    grad.addColorStop(0.55, '#0a0d22');
    grad.addColorStop(1, '#04050d');
    g.fillStyle = grad;
    g.fillRect(0, 0, this.w, this.h);
    // drifting dust: the "thought field"
    for (const d of this.dust) {
      const y = (d.y + (t / 1000) * d.v) % 1;
      const tw = 0.35 + 0.35 * Math.sin(t / 900 + d.p);
      g.fillStyle = `rgba(150,170,255,${tw * 0.5})`;
      g.beginPath();
      g.arc(d.x * this.w, y * this.h, d.r, 0, TAU);
      g.fill();
    }
  }

  /** A gentle curve between two neurons (bent toward the centre side), so synapses don't all overlap. */
  control(a, b) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return { x: mx - dy * 0.12, y: my + dx * 0.12 };
  }

  curvePoint(a, b, q) {
    const c = this.control(a, b);
    const u = 1 - q;
    return { x: u * u * a.x + 2 * u * q * c.x + q * q * b.x, y: u * u * a.y + 2 * u * q * c.y + q * q * b.y };
  }

  /** A soft, wide beam from the source to a working neuron (core violet → the role's colour), breathing. */
  beam(g, a, b, color, t) {
    const c = this.control(a, b);
    const grad = g.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, 'rgba(180,160,255,0.35)');
    grad.addColorStop(1, rgba(color, 0.45));
    g.save();
    g.strokeStyle = grad;
    g.lineCap = 'round';
    g.lineWidth = 7 + 3 * Math.sin(t / 220);
    g.globalAlpha = 0.55;
    g.shadowColor = color;
    g.shadowBlur = 22;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.quadraticCurveTo(c.x, c.y, b.x, b.y);
    g.stroke();
    g.restore();
  }

  /** The energy particles: a glowing head with a fading tail; arriving ones make the neuron "absorb" (a ripple). */
  drawStreams(g, pos, now) {
    const alive = [];
    for (const s of this.streams) {
      const a = pos[s.from];
      const b = pos[s.to];
      if (!a || !b) continue;
      const q = (now - s.t0) / s.dur;
      if (q >= 1) {
        if (Math.random() < 0.25) this.pulses.push({ role: s.to, color: roleColor(s.to), t0: now, dur: 500 });
        continue;
      }
      alive.push(s);
      const color = roleColor(s.to);
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let k = 6; k >= 0; k--) {
        const qq = Math.max(0, q - k * 0.025);
        const p = this.curvePoint(a, b, ease(qq));
        const fade = 1 - k / 7;
        // the head starts core-white and takes the worker's colour on the way
        g.fillStyle = k === 0 ? (q < 0.4 ? 'rgba(235,228,255,0.95)' : rgba(color, 0.95)) : rgba(color, 0.28 * fade);
        g.beginPath();
        g.arc(p.x + Math.sin(q * 9) * s.wobble * (1 - q) * 0.3, p.y, s.size * (k === 0 ? 1.2 : fade), 0, TAU);
        g.fill();
      }
      g.restore();
    }
    this.streams = alive.slice(-400);
  }

  synapse(g, a, b, color, live, t) {
    const c = this.control(a, b);
    g.save();
    g.strokeStyle = live ? rgba(color, 0.75) : 'rgba(120,140,220,0.12)';
    g.lineWidth = live ? 2.2 : 1;
    if (live) {
      g.shadowColor = color;
      g.shadowBlur = 10;
      g.setLineDash([6, 8]);
      g.lineDashOffset = -t / 30; // the dashes flow toward the worker
    }
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.quadraticCurveTo(c.x, c.y, b.x, b.y);
    g.stroke();
    g.restore();
  }

  drawCore(g, at, thinking, t) {
    const beat = 1 + (thinking ? 0.12 : 0.04) * Math.sin(t / (thinking ? 160 : 700));
    const r = at.r * beat;
    g.save();
    const grad = g.createRadialGradient(at.x, at.y, 2, at.x, at.y, r * 2.2);
    grad.addColorStop(0, thinking ? 'rgba(190,170,255,0.95)' : 'rgba(150,160,255,0.7)');
    grad.addColorStop(0.45, thinking ? 'rgba(120,90,255,0.45)' : 'rgba(90,100,230,0.25)');
    grad.addColorStop(1, 'rgba(60,40,200,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(at.x, at.y, r * 2.2, 0, TAU);
    g.fill();
    g.fillStyle = '#e9e4ff';
    g.beginPath();
    g.arc(at.x, at.y, r * 0.55, 0, TAU);
    g.fill();
    // orbiting thoughts while it thinks
    const n = thinking ? 6 : 2;
    for (let i = 0; i < n; i++) {
      const a = t / (thinking ? 420 : 1600) + (i / n) * TAU;
      g.fillStyle = 'rgba(220,210,255,0.9)';
      g.beginPath();
      g.arc(at.x + Math.cos(a) * r * 1.35, at.y + Math.sin(a) * r * 1.35 * 0.55, 2, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  drawNeuron(g, role, at, st, person, t) {
    const color = st === 'ask' ? '#ffc24a' : st === 'error' ? '#ff5a6a' : roleColor(role);
    const active = st !== 'idle';
    g.save();
    if (active) {
      const glow = g.createRadialGradient(at.x, at.y, 1, at.x, at.y, at.r * 3);
      glow.addColorStop(0, rgba(color, st === 'ask' ? 0.35 + 0.25 * Math.sin(t / 180) : 0.45));
      glow.addColorStop(1, rgba(color, 0));
      g.fillStyle = glow;
      g.beginPath();
      g.arc(at.x, at.y, at.r * 3, 0, TAU);
      g.fill();
    }
    g.fillStyle = active ? rgba(color, 0.95) : rgba(color, 0.35);
    g.strokeStyle = rgba(color, active ? 1 : 0.6);
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(at.x, at.y, at.r, 0, TAU);
    g.fill();
    g.stroke();
    if (st === 'busy') {
      // spinning arc: working on something
      g.strokeStyle = rgba('#ffffff', 0.85);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(at.x, at.y, at.r + 5, t / 260, t / 260 + Math.PI * 0.7);
      g.stroke();
    }
    if (person?.stuck) {
      g.fillStyle = '#ffc24a';
      g.font = '700 12px system-ui, sans-serif';
      g.fillText('?', at.x + at.r + 3, at.y - at.r);
    }
    g.restore();
    const sub = st === 'ask' ? 'menunggu izin' : st === 'busy' ? short(person?.task || 'bekerja', 26) : '';
    this.drawLabel(g, at, roleName(role).replace(/^Adhit - /, ''), sub, active ? '#f4f6ff' : 'rgba(200,210,255,0.6)');
  }

  drawLabel(g, at, name, sub, color, big = false) {
    g.save();
    g.textAlign = 'center';
    g.fillStyle = color;
    g.font = `${big ? 700 : 600} ${big ? 13 : 11}px system-ui, sans-serif`;
    g.fillText(name, at.x, at.y + at.r + (big ? 18 : 14));
    if (sub) {
      g.fillStyle = 'rgba(190,200,255,0.75)';
      g.font = '10px ui-monospace, monospace';
      g.fillText(sub, at.x, at.y + at.r + (big ? 31 : 26));
    }
    g.restore();
  }

  /** The current goal (the last prompt) and the to-do progress, as a HUD line at the top. */
  drawGoal(g, scene) {
    const board = scene?.board;
    if (!board?.goal) return;
    const done = board.items.filter((i) => i.status === 'completed').length;
    const text = `◉ ${short(board.goal, 80)}${board.items.length ? `   ·   ${done}/${board.items.length} selesai` : ''}`;
    g.save();
    g.font = '600 12px system-ui, sans-serif';
    g.fillStyle = 'rgba(200,210,255,0.85)';
    g.fillText(text, 14, 22);
    g.restore();
  }
}
