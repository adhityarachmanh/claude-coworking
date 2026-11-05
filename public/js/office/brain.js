// 🧠 Mode Otak: the office as a neural network. The Lead is the core in the middle, every role on the team a neuron
// around it; a delegation is a signal travelling down the synapse (and the report travelling back), a tool call a
// pulse, a pending approval an amber halo, an error a red flash. Same data as the pixel office: the active Scene's
// people (who is busy / asking / stuck) and the live office events (stream.js → brain.event), nothing server-side.
import { activeModelOf, drawModelLogo, logoIndex } from '../core/model-logo.js';
import { CAST, roleColor, roleName } from './cast.js';
import { teamOrder } from './roster.js';

const TAU = Math.PI * 2;
// The core's hue follows the permission mode: how freely the brain may act (r, g, b)
const MODE_HUE = { plan: [110, 170, 255], manual: [170, 140, 255], acceptEdits: [90, 220, 200], auto: [255, 150, 70], dontAsk: [255, 90, 110] };
const MODE_NAME = { plan: 'rencana', manual: 'tanya dulu', acceptEdits: 'auto-edit', auto: 'auto', dontAsk: 'jangan tanya' };
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
    this.logo = { model: '', label: '', file: null }; // the active model's logo, recomputed only when it changes
    this.logoKey = '';
    this.thoughts = []; // tool labels drifting from the core to the worker: { role, text, t0, dur }
    this.bursts = []; // result explosions: { role, color, t0, n }
    this.shakes = new Map(); // role -> until (a red shake on failure)
    this.lastPos = null; // neuron positions of the last frame (hover / click)
    this.hover = null;
    this.lastContext = null; // context % of the previous frame: a big drop = compacted
    this.compactAt = 0;
    this.tip = document.createElement('div');
    this.tip.className = 'brain-tip';
    this.tip.hidden = true;
    host.append(this.tip);
    this.canvas.addEventListener('pointermove', (e) => this.onPointer(e));
    this.canvas.addEventListener('pointerleave', () => this.setHover(null));
    this.canvas.addEventListener('click', (e) => {
      const role = this.hit(e);
      if (role) host.dispatchEvent(new CustomEvent('brain-neuron', { bubbles: true, detail: { role } }));
    });
    this.dust = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + 0.3, v: Math.random() * 0.02 + 0.005, p: Math.random() * TAU }));
    // 🌌 deep space: three star layers (far ones small and slow), drifting nebulae, orbits with moons, meteors
    this.stars = [0, 1, 2].flatMap((layer) =>
      Array.from({ length: [160, 70, 25][layer] }, () => ({ x: Math.random(), y: Math.random(), layer, r: [0.5, 0.9, 1.5][layer] * (0.6 + Math.random() * 0.8), p: Math.random() * TAU, tw: 600 + Math.random() * 2400, hue: Math.random() < 0.18 ? (Math.random() < 0.5 ? '255,210,170' : '170,200,255') : '235,240,255' })),
    );
    this.moons = Array.from({ length: 5 }, (_, i) => ({ orbit: i, a: Math.random() * TAU, speed: (0.00006 + Math.random() * 0.00008) * (i % 2 ? -1 : 1), r: 1.6 + Math.random() * 2.2, color: ['#9fd8ff', '#ffb38a', '#c8a8ff', '#8affd8', '#ffe08a'][i] }));
    this.meteors = [];
    this.nextMeteor = performance.now() + 4000;
    this.nebula = null; // offscreen canvas, rebuilt on resize
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
    this.nebula = null; // the nebula layer is painted again at the new size
  }

  /** The static part of space (deep gradient + coloured nebula clouds), painted once per size, a bit larger than the
   *  stage so it can drift. */
  paintNebula() {
    const pad = 80;
    const c = document.createElement('canvas');
    c.width = Math.round(this.w + pad * 2);
    c.height = Math.round(this.h + pad * 2);
    const g = c.getContext('2d');
    const deep = g.createRadialGradient(c.width / 2, c.height / 2, 10, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.75);
    deep.addColorStop(0, '#0d1230');
    deep.addColorStop(0.6, '#060819');
    deep.addColorStop(1, '#020309');
    g.fillStyle = deep;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'lighter';
    const clouds = [
      [0.18, 0.25, 0.45, '120,60,200', 0.22],
      [0.82, 0.3, 0.4, '30,150,170', 0.18],
      [0.7, 0.85, 0.5, '200,50,140', 0.14],
      [0.25, 0.8, 0.35, '60,90,220', 0.16],
      [0.5, 0.5, 0.3, '140,90,255', 0.1],
    ];
    for (const [x, y, r, rgb, a] of clouds) {
      // a cloud = several soft blobs, so it is irregular rather than a perfect disc
      for (let i = 0; i < 6; i++) {
        const cx = (x + (Math.random() - 0.5) * 0.12) * c.width;
        const cy = (y + (Math.random() - 0.5) * 0.12) * c.height;
        const rr = r * Math.max(c.width, c.height) * (0.35 + Math.random() * 0.35);
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
        // kept soft: the network on top must stay readable
        grad.addColorStop(0, `rgba(${rgb},${a * 0.68})`);
        grad.addColorStop(0.5, `rgba(${rgb},${a * 0.24})`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, c.width, c.height);
      }
    }
    // a faint galaxy band across the sky
    g.save();
    g.translate(c.width / 2, c.height / 2);
    g.rotate(-0.35);
    const band = g.createLinearGradient(0, -c.height * 0.12, 0, c.height * 0.12);
    band.addColorStop(0, 'rgba(180,170,255,0)');
    band.addColorStop(0.5, 'rgba(180,170,255,0.06)');
    band.addColorStop(1, 'rgba(180,170,255,0)');
    g.fillStyle = band;
    g.fillRect(-c.width, -c.height * 0.12, c.width * 2, c.height * 0.24);
    g.restore();
    this.nebula = { canvas: c, pad };
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
      // The Lead (the brain at the centre) briefs the PM: energy flows from the core to the PM's orb
      case 'huddle': {
        const [lead, ...others] = evt.roles ?? ['claude', role];
        for (const to of others) for (let i = 0; i < 4; i++) this.packets.push({ from: lead, to, color: roleColor(to), t0: now + i * 120, dur: 1000, size: 3.6 });
        if (evt.label) this.thoughts.push({ role, text: short(String(evt.label), 30), t0: now, dur: 2600 });
        break;
      }
      // The PM speaking for the team: its words float up from its orb, like a thought
      case 'say':
        if (evt.text) this.thoughts.push({ role, text: short(String(evt.text), 34), t0: now, dur: 3200 });
        if (this.thoughts.length > 8) this.thoughts.shift();
        this.pulses.push({ role, color, t0: now, dur: 700 });
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
        if (evt.label) this.thoughts.push({ role, text: short(String(evt.label), 30), t0: now, dur: 2200 });
        if (this.thoughts.length > 8) this.thoughts.shift();
        if (/git commit/i.test(evt.label ?? '')) this.bursts.push({ role, color: '#ffd56a', t0: now + 400, n: 26 }); // a commit: gold
        break;
      case 'tests':
        this.bursts.push({ role, color: evt.failed ? '#ff5a6a' : '#5dffa8', t0: now, n: evt.failed ? 14 : 34 });
        if (evt.failed) this.shakes.set(role, now + 700);
        break;
      case 'tool_fail':
      case 'error':
        this.flashes.set(role, { color: '#ff5a6a', until: now + 1400 });
        this.shakes.set(role, now + 600);
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
    // A hidden office pane (a phone on another view) leaves the canvas 1x1: the layout would get negative radii and
    // throw, which kills the whole animation loop. Nothing is visible there anyway; resize() redraws once it shows.
    if (!this.on || this.w < 60 || this.h < 100) return;
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
    for (const [role, until] of this.shakes) {
      if (until < now) this.shakes.delete(role);
      else if (pos[role]) pos[role] = { ...pos[role], x: pos[role].x + Math.sin(now / 18) * 3 * ((until - now) / 700) };
    }
    this.lastPos = pos;
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
    // thinking core, tinted by the permission mode, wrapped in its memory (context) ring; the active model's logo
    // sits on it (the core keeps pulsing around the logo: its glow, its beat and its orbit of thoughts stay visible)
    const hue = MODE_HUE[status.mode] ?? MODE_HUE.manual;
    this.drawCore(g, pos.claude, Boolean(status.busy || status.cliBusy), t, hue, this.activeLogo(status));
    this.drawMemory(g, pos.claude, status, now, t);
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
    this.drawThoughts(g, pos, now);
    this.drawBursts(g, pos, now);
    // neurons on top
    for (const role of roles) if (role !== 'claude') this.drawNeuron(g, role, pos[role], state(role), people[role], t, this.hover === role);
    this.drawLabel(g, pos.claude, roleName('claude'), status.busy ? `berpikir · ${MODE_NAME[status.mode] ?? 'tanya dulu'}` : MODE_NAME[status.mode] ?? '', '#e8ecff', true);
    this.drawGoal(g, scene);
    if (this.hover) this.updateTip(this.hover, people[this.hover], state(this.hover), status);
  }

  drawBackground(g, t) {
    if (!this.nebula) this.paintNebula();
    const { canvas: neb, pad } = this.nebula;
    // the nebula drifts in a slow circle (≈ 3 minutes per turn)
    g.drawImage(neb, -pad + Math.sin(t / 30000) * pad * 0.6, -pad + Math.cos(t / 34000) * pad * 0.6);
    // stars: far layers barely move, near ones drift more (parallax) and twinkle
    for (const s of this.stars) {
      const drift = [0.000004, 0.00001, 0.00002][s.layer] * t;
      const x = ((s.x + drift) % 1) * this.w;
      const y = s.y * this.h;
      const a = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t / s.tw + s.p));
      g.fillStyle = `rgba(${s.hue},${a * [0.5, 0.75, 1][s.layer]})`;
      g.beginPath();
      g.arc(x, y, s.r, 0, TAU);
      g.fill();
      if (s.layer === 2 && a > 0.9) {
        // the brightest twinkle with a small cross flare
        g.strokeStyle = `rgba(${s.hue},${(a - 0.9) * 4})`;
        g.lineWidth = 0.6;
        g.beginPath();
        g.moveTo(x - 5, y);
        g.lineTo(x + 5, y);
        g.moveTo(x, y - 5);
        g.lineTo(x, y + 5);
        g.stroke();
      }
    }
    this.drawOrbits(g, t);
    this.drawMeteors(g);
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

  /** Orbit rings around the core (tilted ellipses, slowly turning) with small moons travelling on them. */
  drawOrbits(g, t) {
    const cx = this.w / 2;
    const cy = this.h / 2 + 10;
    const base = Math.min(this.w * 0.4, (this.h - 90) * 0.42);
    const radii = [0.32, 0.55, 0.78, 1.08, 1.3];
    g.save();
    for (let i = 0; i < radii.length; i++) {
      const rx = base * radii[i] * (this.w > this.h ? 1.35 : 1);
      const ry = base * radii[i] * 0.42;
      const tilt = -0.18 + i * 0.05 + Math.sin(t / 40000 + i) * 0.02;
      g.strokeStyle = `rgba(150,170,255,${0.07 + (i % 2) * 0.03})`;
      g.lineWidth = 1;
      g.setLineDash(i % 2 ? [2, 6] : []);
      g.lineDashOffset = -t / (60 + i * 30);
      g.beginPath();
      g.ellipse(cx, cy, rx, ry, tilt, 0, TAU);
      g.stroke();
      const m = this.moons[i];
      if (m) {
        const a = m.a + t * m.speed;
        // the point on the tilted ellipse
        const px = Math.cos(a) * rx;
        const py = Math.sin(a) * ry;
        const x = cx + px * Math.cos(tilt) - py * Math.sin(tilt);
        const y = cy + px * Math.sin(tilt) + py * Math.cos(tilt);
        const behind = Math.sin(a) < 0; // on the far side of the orbit: dimmer
        g.setLineDash([]);
        const glow = g.createRadialGradient(x, y, 0, x, y, m.r * 5);
        glow.addColorStop(0, rgba(m.color, behind ? 0.25 : 0.55));
        glow.addColorStop(1, rgba(m.color, 0));
        g.fillStyle = glow;
        g.beginPath();
        g.arc(x, y, m.r * 5, 0, TAU);
        g.fill();
        g.fillStyle = rgba(m.color, behind ? 0.5 : 1);
        g.beginPath();
        g.arc(x, y, m.r, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  }

  /** Now and then a shooting star crosses the sky. */
  drawMeteors(g) {
    const now = performance.now();
    if (now > this.nextMeteor) {
      const fromLeft = Math.random() < 0.5;
      this.meteors.push({ x: fromLeft ? Math.random() * this.w * 0.5 : this.w * (0.5 + Math.random() * 0.5), y: Math.random() * this.h * 0.35, dx: (fromLeft ? 1 : -1) * (0.5 + Math.random() * 0.3), dy: 0.28 + Math.random() * 0.15, t0: now, dur: 900 + Math.random() * 500 });
      this.nextMeteor = now + 5000 + Math.random() * 9000;
    }
    this.meteors = this.meteors.filter((m) => now < m.t0 + m.dur);
    g.save();
    g.lineCap = 'round';
    for (const m of this.meteors) {
      const q = (now - m.t0) / m.dur;
      const len = 260 * q;
      const x = m.x + m.dx * len * 2;
      const y = m.y + m.dy * len * 2;
      const tail = g.createLinearGradient(x, y, x - m.dx * 90, y - m.dy * 90);
      tail.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - q)})`);
      tail.addColorStop(1, 'rgba(160,190,255,0)');
      g.strokeStyle = tail;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - m.dx * 90, y - m.dy * 90);
      g.stroke();
    }
    g.restore();
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

  /** The active model (logo file + short label), cached until the status or the logo index changes. */
  activeLogo(status) {
    const key = `${status?.activeModel ?? ''}|${status?.model ?? ''}|${status?.engine ?? ''}|${logoIndex().length}`;
    if (key !== this.logoKey) {
      this.logoKey = key;
      this.logo = activeModelOf(status, status?.engine);
    }
    return this.logo;
  }

  drawCore(g, at, thinking, t, [cr, cg, cb] = MODE_HUE.manual, logo = null) {
    const beat = 1 + (thinking ? 0.12 : 0.04) * Math.sin(t / (thinking ? 160 : 700));
    const r = at.r * beat;
    g.save();
    const grad = g.createRadialGradient(at.x, at.y, 2, at.x, at.y, r * 2.2);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${thinking ? 0.95 : 0.7})`);
    grad.addColorStop(0.45, `rgba(${cr},${cg},${cb},${thinking ? 0.45 : 0.22})`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(at.x, at.y, r * 2.2, 0, TAU);
    g.fill();
    g.fillStyle = '#e9e4ff';
    g.beginPath();
    g.arc(at.x, at.y, r * 0.55, 0, TAU);
    g.fill();
    // The model that is thinking: its logo on the core, in the core's own hue (a monogram until the index/logos load).
    drawModelLogo(g, logo?.file ?? null, at.x, at.y, r * 1.5, {
      alpha: 0.85,
      ring: [cr, cg, cb],
      font: `bold ${Math.max(8, Math.round(at.r * 0.62))}px ui-monospace, monospace`,
      label: logo?.label ?? '',
    });
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

  drawNeuron(g, role, at, st, person, t, hovered = false) {
    const color = st === 'ask' ? '#ffc24a' : st === 'error' ? '#ff5a6a' : roleColor(role);
    const active = st !== 'idle';
    g.save();
    if (hovered) {
      g.strokeStyle = rgba('#ffffff', 0.7);
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(at.x, at.y, at.r + 9, 0, TAU);
      g.stroke();
    }
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

  /**
   * The memory ring: the conversation's context use around the core (green → amber → red near auto-compact).
   * A compaction (status.compacting, or a big drop) squeezes it with a bright flash.
   */
  drawMemory(g, at, status, now, t) {
    const c = status.context;
    if (!c?.used || !c?.window) return;
    const limit = c.autoCompactAt || c.window;
    const pct = clamp(c.used / limit, 0, 1);
    if (this.lastContext != null && this.lastContext - pct > 0.2) this.compactAt = now;
    this.lastContext = pct;
    const R = at.r * 2.55;
    const squeeze = status.compacting || now - this.compactAt < 1200;
    const color = pct > 0.9 ? '#ff5a6a' : pct > 0.7 ? '#ffc24a' : '#5dffa8';
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(140,160,255,0.14)';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(at.x, at.y, R, 0, TAU);
    g.stroke();
    g.strokeStyle = squeeze ? `rgba(255,255,255,${0.6 + 0.4 * Math.sin(t / 60)})` : color;
    g.shadowColor = color;
    g.shadowBlur = 10;
    g.lineWidth = squeeze ? 6 : 4;
    g.beginPath();
    g.arc(at.x, at.y, squeeze ? R * (0.9 + 0.05 * Math.sin(t / 80)) : R, -Math.PI / 2, -Math.PI / 2 + pct * TAU);
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(200,210,255,0.8)';
    g.font = '600 10px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(squeeze ? 'memori dipadatkan…' : `memori ${Math.round(pct * 100)}%`, at.x, at.y - R - 8);
    g.restore();
  }

  /** What is being sent: the tool's short label rides from the core toward the worker and fades. */
  drawThoughts(g, pos, now) {
    this.thoughts = this.thoughts.filter((k) => now < k.t0 + k.dur);
    g.save();
    g.font = '600 10px ui-monospace, monospace';
    g.textAlign = 'center';
    for (const k of this.thoughts) {
      const b = pos[k.role];
      const a = k.role === 'claude' ? { x: pos.claude.x, y: pos.claude.y - 60 } : pos.claude;
      if (!b) continue;
      const q = (now - k.t0) / k.dur;
      const p = k.role === 'claude' ? { x: b.x, y: b.y - 30 - q * 40 } : this.curvePoint(a, b, 0.78 * ease(Math.min(1, q * 1.4))); // stops short of the neuron: its label stays readable
      const alpha = q < 0.15 ? q / 0.15 : 1 - Math.max(0, (q - 0.6) / 0.4);
      const w = g.measureText(k.text).width + 10;
      g.fillStyle = `rgba(10,14,40,${0.75 * alpha})`;
      g.fillRect(p.x - w / 2, p.y - 18, w, 15);
      g.fillStyle = rgba(roleColor(k.role), alpha);
      g.fillText(k.text, p.x, p.y - 7);
    }
    g.restore();
  }

  /** Results: green burst for passing tests, gold for a commit, a small red one for failures. */
  drawBursts(g, pos, now) {
    this.bursts = this.bursts.filter((b) => now < b.t0 + 1300);
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const b of this.bursts) {
      if (now < b.t0) continue;
      const at = pos[b.role] ?? pos.claude;
      const q = (now - b.t0) / 1300;
      for (let i = 0; i < b.n; i++) {
        const a = (i / b.n) * TAU + i * 0.37;
        const d = ease(q) * (40 + (i % 5) * 9);
        g.fillStyle = rgba(b.color, 1 - q);
        g.beginPath();
        g.arc(at.x + Math.cos(a) * d, at.y + Math.sin(a) * d, 2.2 * (1 - q) + 0.6, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  }

  // ---------- hover / click ----------

  hit(e) {
    if (!this.lastPos) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    for (const [role, p] of Object.entries(this.lastPos)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= p.r + 10 && (!best || d < best.d)) best = { role, d };
    }
    return best?.role ?? null;
  }

  onPointer(e) {
    this.setHover(this.hit(e));
    if (this.hover) {
      const r = this.host.getBoundingClientRect();
      this.tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 230)}px`;
      this.tip.style.top = `${Math.max(e.clientY - r.top - 10, 8)}px`;
    }
  }

  setHover(role) {
    this.hover = role;
    this.canvas.style.cursor = role ? 'pointer' : '';
    this.tip.hidden = !role;
  }

  updateTip(role, person, st, status) {
    const name = roleName(role);
    const what = st === 'ask' ? '🔑 Menunggu izinmu: klik untuk membuka kartunya' : st === 'error' ? '⚠ Ada error' : st === 'busy' ? `⚙ ${person?.task || 'Bekerja'}` : 'Siaga';
    const extra = role === 'claude' && status.context?.used ? `\nMemori ${Math.round((status.context.used / (status.context.autoCompactAt || status.context.window)) * 100)}% · mode ${MODE_NAME[status.mode] ?? '-'}` : person?.agentCount > 1 ? `\n${person.agentCount} subagent paralel` : '';
    const text = `${name}\n${what}${extra}`;
    if (this.tip.textContent !== text) this.tip.textContent = text;
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
