// 💻 Mode Terminal: the team as a wall of hacker terminals, one per role. Nothing is invented — every line is a real
// row of the project's chat (core/terminal-feed.js): the prompt on the Lead's screen, the PM's briefs and task board,
// commands with their live output, edits as a diff, test counts, approvals as ACCESS REQUEST. Delegations travel as
// data packets between panels, failures glitch the panel red. Drawn instead of the pixel office while it is on.
import { fetchTaskOutput } from '../core/task-output.js';
import { terminalFeed } from '../core/terminal-feed.js';
import { projectName, state } from '../core/state.js';
import { liveOutput } from '../features/live-output.js';
import { CAST, roleColor } from './cast.js';
import { roster, teamOrder } from './roster.js';

const FONT = 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace';
const TONE = { cmd: '#8dffbf', out: '#76a888', add: '#5dff8a', del: '#ff6b6b', info: '#7fd7ff', warn: '#ffc24a', err: '#ff5a6a', muted: '#4f6b5a' };
const BADGE = { idle: ['IDLE', '#4f6b5a'], busy: ['BUSY', '#5dff8a'], ask: ['ASK', '#ffc24a'], error: ['ERR', '#ff5a6a'] };
const BOARD_MARK = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
const TYPE_CPS = 140; // characters per second of the typing effect on fresh lines
const RAIN = 'アイウエオカキクケコ0123456789ABCDEF{}<>/$#';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** "#RRGGBB" → "rgba(r,g,b,a)". */
function rgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  const n = m ? parseInt(m[1], 16) : 0x66ff99;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Terminal {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'terminal-canvas';
    this.canvas.setAttribute('aria-label', 'Mode Terminal: layar kerja tiap role');
    this.g = this.canvas.getContext('2d');
    host.append(this.canvas);
    this.on = false;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.seen = new Map(); // line id -> when it first appeared (typing effect)
    this.seededFor = null; // the project whose history was marked as already typed
    this.glitch = new Map(); // role -> until
    this.packets = []; // { from, to, t0, dur, color }
    this.rects = new Map(); // role -> panel rect of the last frame (click, packets)
    this.polls = new Map(); // task id -> last own read of a running shell
    this.drops = [];
    this.canvas.addEventListener('click', (e) => {
      const role = this.hit(e);
      // same handler as a neuron in Mode Otak (features/view-mode.js): approval card, tasks, or Aktivitas
      if (role) host.dispatchEvent(new CustomEvent('brain-neuron', { bubbles: true, detail: { role } }));
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  setOn(on) {
    this.on = on;
    this.host.classList.toggle('terminal-mode', on);
    if (on) this.resize();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    const cols = Math.ceil(this.w / 14);
    this.drops = Array.from({ length: cols }, () => ({ y: Math.random() * this.h, v: 20 + Math.random() * 60 }));
  }

  /** A live office event of the active project: packets between panels, glitches on failure. */
  event(evt) {
    const now = performance.now();
    if (evt.kind === 'delegate') this.packets.push({ from: evt.from ?? 'claude', to: evt.role, t0: now, dur: 1100, color: roleColor(evt.role) });
    else if (evt.kind === 'agent_stop') this.packets.push({ from: evt.role, to: evt.from ?? coordinator(), t0: now, dur: 1000, color: evt.failed ? '#ff5a6a' : '#5dff8a' });
    else if (evt.kind === 'huddle') for (const to of (evt.roles ?? []).slice(1)) this.packets.push({ from: evt.roles[0], to, t0: now, dur: 1000, color: roleColor(to) });
    else if (evt.kind === 'tool_fail' || evt.kind === 'error' || (evt.kind === 'tests' && evt.failed)) this.glitch.set(evt.role ?? 'claude', now + 650);
  }

  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    for (const [role, p] of this.rects) if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return role;
    return null;
  }

  /** Running shells' output for panels: the chat's own live cache, else one read per shell every 2 s (max 3). */
  liveText(msg, now) {
    const cached = liveOutput.outputs.get(msg.taskId);
    if (cached?.text) return cached.text;
    const id = msg.taskId;
    if (!id || !state.active || state.readOnly) return '';
    const last = this.polls.get(id);
    if (!last || now - last.at > 2000) {
      if (this.polls.size > 12) this.polls.clear();
      const entry = { at: now, text: last?.text ?? '' };
      this.polls.set(id, entry);
      const busy = [...this.polls.values()].filter((p) => p.pending).length;
      if (busy < 3) {
        entry.pending = true;
        fetchTaskOutput(state.active, id)
          .then((out) => (entry.text = out.text))
          .catch(() => {})
          .finally(() => (entry.pending = false));
      }
    }
    return last?.text ?? '';
  }

  frame(t, scene) {
    if (!this.on || this.w < 60 || this.h < 80) return;
    const g = this.g;
    const now = performance.now();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(g, now);

    const project = state.active;
    const chat = state.chats[project] ?? [];
    const feed = terminalFeed(chat, { coordinator: coordinator(), live: (m) => this.liveText(m, now), events: state.events[project] ?? [], nameOf: (r) => CAST[r]?.short ?? r });
    // history that was already there when the mode opened is shown at once; only new lines are typed out
    if (this.seededFor !== project) {
      this.seededFor = project;
      this.seen.clear();
      this.packets = [];
      for (const p of feed.values()) for (const l of p.lines) this.seen.set(l.id, 0);
    }

    // the scene knows who is busy right now (tool calls in flight): it wins over the chat's own guess
    const people = scene?.people ?? {};
    const live = (role, fallback) => {
      const p = people[role];
      if (p?.asking) return 'ask';
      if (p?.isBusy?.(now)) return 'busy';
      return fallback;
    };

    const header = 22;
    const footer = 20;
    const panels = [...feed.values()];
    const area = { x: 8, y: header + 6, w: this.w - 16, h: this.h - header - footer - 12 };
    const minH = 92;
    let cols = clamp(Math.round(Math.sqrt((panels.length * area.w) / area.h / 1.7)), 1, 4);
    let rows = Math.ceil(panels.length / cols);
    const maxRows = Math.max(1, Math.floor(area.h / minH));
    if (rows > maxRows) {
      rows = maxRows;
      cols = clamp(Math.ceil(panels.length / rows), 1, 5);
    }
    const shown = panels.slice(0, cols * rows);
    const hidden = panels.slice(shown.length).map((p) => p.role);
    const pw = (area.w - (cols - 1) * 8) / cols;
    const ph = (area.h - (rows - 1) * 8) / rows;
    this.rects.clear();
    // the last row shares the full width (3 panels on a 2×2 grid: no empty quarter)
    const lastRow = rows - 1;
    const inLast = shown.length - lastRow * cols;
    const lw = (area.w - (inLast - 1) * 8) / Math.max(1, inLast);
    shown.forEach((p, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const w = row === lastRow ? lw : pw;
      const rect = { x: area.x + col * (w + 8), y: area.y + row * (ph + 8), w, h: ph };
      this.rects.set(p.role, rect);
      this.drawPanel(g, p, rect, live(p.role, p.state), now);
    });
    this.drawPackets(g, now);
    this.drawTopBar(g, project, panels, live, now);
    // the rest of the team: idle (no work this session) or no room on screen
    const idle = teamOrder().filter((r) => r !== 'claude' && !feed.has(r));
    this.drawFooter(g, [...hidden, ...idle], hidden.length);
    this.drawScanlines(g, now);
  }

  drawBackground(g, now) {
    g.fillStyle = '#020806';
    g.fillRect(0, 0, this.w, this.h);
    // a faint code rain behind the panels (decoration only: it never stands for data)
    g.font = `11px ${FONT}`;
    g.fillStyle = 'rgba(60,255,140,0.07)';
    const dt = Math.min(0.05, (now - (this.lastRain ?? now)) / 1000);
    this.lastRain = now;
    this.drops.forEach((d, i) => {
      d.y += d.v * dt;
      if (d.y > this.h + 20) d.y = -20;
      g.fillText(RAIN[(i * 7 + Math.floor(d.y / 14)) % RAIN.length], i * 14, d.y);
    });
  }

  drawTopBar(g, project, panels, live, now) {
    const busy = panels.filter((p) => live(p.role, p.state) === 'busy').length;
    const st = state.statuses[project] ?? {};
    const clock = new Date().toLocaleTimeString('id-ID', { hour12: false });
    g.fillStyle = 'rgba(10,40,24,0.85)';
    g.fillRect(0, 0, this.w, 22);
    g.font = `bold 12px ${FONT}`;
    g.fillStyle = '#5dff8a';
    g.textBaseline = 'middle';
    const name = project ? projectName(project) : '-';
    const left = `adhitron@kantor:~/${name}$  ${busy} agen aktif${st.mode ? ` · mode ${st.mode}` : ''}${st.busy ? ' · BERPIKIR' : ''}`;
    g.fillText(left.length > this.w / 7.4 ? `${left.slice(0, Math.floor(this.w / 7.4) - 1)}…` : left, 10, 11);
    g.textAlign = 'right';
    g.fillStyle = Math.floor(now / 500) % 2 ? '#5dff8a' : '#2f7a4a';
    g.fillText(`● ${clock}`, this.w - 10, 11);
    g.textAlign = 'left';
  }

  drawFooter(g, roles, hiddenCount) {
    g.font = `11px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(10,40,24,0.7)';
    g.fillRect(0, this.h - 20, this.w, 20);
    g.fillStyle = '#4f8a64';
    const names = roles.map((r) => (CAST[r]?.short ?? r).toLowerCase());
    const text = names.length ? `${hiddenCount ? `+${hiddenCount} layar lain · ` : ''}standby: ${names.join(' · ')}` : 'semua role sedang bekerja';
    g.fillText(text.length > this.w / 6.6 ? `${text.slice(0, Math.floor(this.w / 6.6) - 1)}…` : text, 10, this.h - 10);
  }

  drawPanel(g, p, r, st, now) {
    const color = p.role === 'claude' ? '#e8ecff' : roleColor(p.role);
    const glitching = (this.glitch.get(p.role) ?? 0) > now;
    const dx = glitching ? (Math.random() - 0.5) * 6 : 0;
    const x = r.x + dx;
    const dim = st === 'idle' ? 0.6 : 1;
    g.save();
    g.globalAlpha = dim;
    g.fillStyle = 'rgba(2,14,8,0.92)';
    g.fillRect(x, r.y, r.w, r.h);
    const pulse = 0.55 + 0.45 * Math.sin(now / 220);
    const border = glitching || st === 'error' ? '#ff5a6a' : st === 'ask' ? rgba('#ffc24a', 0.5 + 0.5 * pulse) : rgba(color, st === 'busy' ? 0.85 : 0.35);
    g.strokeStyle = border;
    g.lineWidth = st === 'busy' || st === 'ask' ? 1.6 : 1;
    if (st === 'busy') {
      g.shadowColor = color;
      g.shadowBlur = 10;
    }
    g.strokeRect(x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    g.shadowBlur = 0;

    // header: name, state badge, test counts
    g.fillStyle = rgba(color, 0.14);
    g.fillRect(x + 1, r.y + 1, r.w - 2, 17);
    g.font = `bold 11px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillStyle = color;
    const name = (CAST[p.role]?.name ?? p.role).replace(/^.*? - /, '').toUpperCase();
    g.fillText(`● ${name}`, x + 6, r.y + 10);
    const [badge, badgeColor] = BADGE[st] ?? BADGE.idle;
    g.textAlign = 'right';
    let right = x + r.w - 6;
    g.fillStyle = badgeColor;
    g.fillText(`[${badge}]`, right, r.y + 10);
    right -= g.measureText(`[${badge}] `).width;
    if (p.tests) {
      g.fillStyle = p.tests.failed ? '#ff5a6a' : '#5dff8a';
      g.fillText(`✔${p.tests.passed} ✖${p.tests.failed}`, right, r.y + 10);
    }
    g.textAlign = 'left';

    // body: the task board (PM / Lead) then the newest lines that fit
    const size = clamp(Math.floor(r.h / 11), 10, 12);
    const lh = size + 3;
    g.font = `${size}px ${FONT}`;
    const maxChars = Math.max(8, Math.floor((r.w - 14) / (size * 0.62)));
    let y = r.y + 22 + lh / 2;
    const bottom = r.y + r.h - 5;
    if (p.board?.length) {
      for (const item of p.board.slice(0, Math.min(4, Math.floor((r.h - 40) / lh / 2)))) {
        g.fillStyle = item.status === 'completed' ? '#4f8a64' : item.status === 'in_progress' ? '#ffc24a' : '#7fd7ff';
        g.fillText(fit(`${BOARD_MARK[item.status] ?? '[ ]'} ${item.text}`, maxChars), x + 7, y);
        y += lh;
      }
      g.fillStyle = 'rgba(93,255,138,0.15)';
      g.fillRect(x + 6, y - lh / 2 + 1, r.w - 12, 1);
      y += 3;
    }
    const room = Math.max(0, Math.floor((bottom - y + lh / 2) / lh));
    const lines = p.lines.slice(-room);
    lines.forEach((l, i) => {
      if (!this.seen.has(l.id)) this.seen.set(l.id, now);
      const t0 = this.seen.get(l.id);
      const chars = t0 ? Math.floor(((now - t0) / 1000) * TYPE_CPS) : Infinity;
      const text = fit(l.text, maxChars);
      const shownText = chars >= text.length ? text : text.slice(0, chars);
      g.fillStyle = TONE[l.tone] ?? TONE.out;
      g.fillText(shownText, x + 7, y);
      // the cursor sits after the newest line of a busy panel (and blinks on an idle one)
      if (i === lines.length - 1) {
        const blink = Math.floor(now / 530) % 2 === 0;
        if (st !== 'idle' || blink) {
          g.fillStyle = st === 'idle' ? '#2f5a40' : (TONE[l.tone] ?? '#8dffbf');
          g.fillRect(x + 7 + g.measureText(shownText).width + 2, y - size / 2, size * 0.55, size);
        }
      }
      y += lh;
    });
    if (!lines.length) {
      g.fillStyle = '#2f5a40';
      g.fillText(Math.floor(now / 530) % 2 ? '_' : '', x + 7, y);
    }
    g.restore();
  }

  drawPackets(g, now) {
    this.packets = this.packets.filter((k) => now < k.t0 + k.dur);
    g.font = `bold 10px ${FONT}`;
    for (const k of this.packets) {
      const a = this.rects.get(k.from) ?? this.rects.get('claude');
      const b = this.rects.get(k.to);
      if (!a || !b || a === b) continue;
      const q = clamp((now - k.t0) / k.dur, 0, 1);
      const ax = a.x + a.w / 2;
      const ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      g.strokeStyle = rgba(k.color, 0.18 * (1 - q));
      g.setLineDash([4, 6]);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
      g.setLineDash([]);
      // a packet of bits with a short trail
      for (let i = 0; i < 6; i++) {
        const qq = clamp(q - i * 0.03, 0, 1);
        g.fillStyle = rgba(k.color, 1 - i / 6);
        g.fillText(((Math.floor(now / 60) + i) % 2).toString(), ax + (bx - ax) * qq - 3, ay + (by - ay) * qq);
      }
    }
  }

  drawScanlines(g, now) {
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < this.h; y += 3) g.fillRect(0, y, this.w, 1);
    // a slow bright band rolling down, like an old CRT
    const band = ((now / 22) % (this.h + 120)) - 60;
    const grad = g.createLinearGradient(0, band - 40, 0, band + 40);
    grad.addColorStop(0, 'rgba(93,255,138,0)');
    grad.addColorStop(0.5, 'rgba(93,255,138,0.035)');
    grad.addColorStop(1, 'rgba(93,255,138,0)');
    g.fillStyle = grad;
    g.fillRect(0, band - 40, this.w, 80);
  }
}

/** Who speaks for the team (as in src/translator.js coordinator()): the PM while the team has one. */
const coordinator = () => (roster.enabled.includes('pm') ? 'pm' : 'claude');
const fit = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
