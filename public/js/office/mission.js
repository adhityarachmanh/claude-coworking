// 🛰 Mission Control: the current mission (since the latest prompt) as a NASA-style dashboard — stations per role
// (GO / HOLD / FAIL / DONE / STBY with an activity sparkline), telemetry, a team radar with the Lead at the centre,
// the context gauge, a CAPCOM log of hand-offs and reports, Git/CI, and a timeline of who worked when. Every number
// comes from the project's real chat rows, office events and status (core/mission-feed.js). Drawn instead of the
// pixel office while it is on.
import { missionFeed } from '../core/mission-feed.js';
import { projectName, state } from '../core/state.js';
import { CAST, roleColor } from './cast.js';
import { roster, teamOrder } from './roster.js';

const FONT = '"Segoe UI", system-ui, sans-serif';
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
const C = { bg: '#05080f', card: '#081324', line: '#1c3b66', sub: '#173257', head: '#6f9ad6', text: '#cfe3ff', dim: '#7d93b5', ok: '#5dff9e', bad: '#ff6b7a', warn: '#ffc24a', gold: '#ffd36a' };
const STATE = { go: ['GO', C.ok], hold: ['HOLD', C.warn], fail: ['✖', C.bad], done: ['✔ selesai', C.dim], stby: ['STBY', C.dim] };
const PHASE = { idle: ['● SIAGA', C.dim], go: ['● GO', C.ok], hold: ['● HOLD', C.warn], done: ['● MISI SELESAI', '#7fd7ff'] };
const TONE = { info: C.text, ok: C.ok, bad: C.bad, warn: C.warn };
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const coordinator = () => (roster.enabled.includes('pm') ? 'pm' : 'claude');
const short = (r) => (r === 'claude' ? 'Lead' : (CAST[r]?.short ?? r));
const color = (r) => (r === 'claude' ? '#d97757' : roleColor(r));

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `T+ ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export class Mission {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mission-canvas';
    this.canvas.setAttribute('aria-label', 'Mission Control: dasbor misi tim');
    this.g = this.canvas.getContext('2d');
    host.append(this.canvas);
    this.on = false;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.hits = []; // [{ x, y, w, h, role }] of the last frame
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const hit = this.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
      // same handler as a neuron in Mode Otak (features/view-mode.js): approval card, tasks, or Aktivitas
      if (hit) host.dispatchEvent(new CustomEvent('brain-neuron', { bubbles: true, detail: { role: hit.role } }));
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  setOn(on) {
    this.on = on;
    this.host.classList.toggle('mission-mode', on);
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

  event() {} // everything is read from the chat each frame; kept for the same interface as Brain / Terminal

  frame(t, scene) {
    if (!this.on || this.w < 120 || this.h < 120) return;
    const g = this.g;
    const now = Date.now();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.w, this.h);
    this.hits = [];
    const project = state.active;
    const st = state.statuses[project] ?? {};
    const m = missionFeed(state.chats[project] ?? [], { now, coordinator: coordinator(), team: teamOrder(), events: state.events[project] ?? [] });
    // the scene knows who is busy right now: a station without a running row but with a tool call in flight is GO
    const people = scene?.people ?? {};
    for (const s of m.stations) {
      const p = people[s.role];
      if (p?.asking) s.state = 'hold';
      else if (s.state !== 'hold' && p?.isBusy?.(performance.now())) s.state = 'go';
    }

    const pad = 8;
    const narrow = this.w < 760;
    this.drawTop(g, pad, pad, this.w - pad * 2, 34, m, st, project);
    const top = pad + 34 + pad;
    const tlH = narrow ? 0 : clamp(Math.round(this.h * 0.2), 70, 150);
    const bodyH = this.h - top - pad - (tlH ? tlH + pad : 0);
    if (narrow) {
      // a phone: stations, then telemetry + radar side by side, then the log
      const h1 = Math.round(bodyH * 0.42);
      this.drawStations(g, pad, top, this.w - pad * 2, h1, m.stations);
      const h2 = Math.round(bodyH * 0.3);
      this.drawTelemetry(g, pad, top + h1 + pad, (this.w - pad * 3) / 2, h2, m, st);
      this.drawRadar(g, pad * 2 + (this.w - pad * 3) / 2, top + h1 + pad, (this.w - pad * 3) / 2, h2, m, t);
      this.drawLog(g, pad, top + h1 + h2 + pad * 2, this.w - pad * 2, bodyH - h1 - h2 - pad * 2, m);
      return;
    }
    const colW = (this.w - pad * 4) / 3.15;
    const midW = this.w - pad * 4 - colW * 2;
    this.drawStations(g, pad, top, colW, bodyH, m.stations);
    const midX = pad * 2 + colW;
    const telH = 92;
    this.drawTelemetry(g, midX, top, midW, telH, m, st);
    this.drawRadar(g, midX, top + telH + pad, midW, bodyH - telH - pad, m, t, st);
    const rightX = midX + midW + pad;
    const gcH = 78;
    this.drawLog(g, rightX, top, colW, bodyH - gcH - pad, m);
    this.drawGround(g, rightX, top + bodyH - gcH, colW, gcH, st);
    this.drawTimeline(g, pad, this.h - pad - tlH, this.w - pad * 2, tlH, m, now);
  }

  card(g, x, y, w, h, title) {
    g.fillStyle = C.card;
    g.strokeStyle = C.line;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 7);
    g.fill();
    g.stroke();
    if (title) {
      g.font = `600 10px ${FONT}`;
      g.fillStyle = C.head;
      g.textBaseline = 'middle';
      g.fillText(title, x + 10, y + 12);
    }
  }

  text(g, s, x, y, maxW, font, fill) {
    g.font = font;
    g.fillStyle = fill;
    let out = String(s);
    while (out.length > 1 && g.measureText(out).width > maxW) out = `${out.slice(0, -2)}…`;
    g.fillText(out, x, y);
  }

  drawTop(g, x, y, w, h, m, st, project) {
    const grad = g.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#071a33');
    grad.addColorStop(1, '#0a1426');
    g.fillStyle = grad;
    g.strokeStyle = C.line;
    g.beginPath();
    g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 7);
    g.fill();
    g.stroke();
    g.textBaseline = 'middle';
    const cy = y + h / 2;
    g.font = `700 13px ${FONT}`;
    g.fillStyle = '#e8f2ff';
    g.fillText('🛰 MISSION CONTROL', x + 12, cy);
    let px = x + 12 + g.measureText('🛰 MISSION CONTROL').width + 14;
    const [phase, phaseColor] = PHASE[m.phase] ?? PHASE.idle;
    const pills = [
      [`MISI: ${project ? projectName(project) : '-'}`, C.text],
      [phase, phaseColor],
      ...(m.prompt ? [[`“${m.prompt}”`, C.text]] : []),
      ...(st.activeModel || st.model ? [[`🤖 ${st.activeModel || st.model}${st.effort ? ` · ${st.effort}` : ''}`, C.text]] : []),
    ];
    const clockW = 130;
    for (const [label, fill] of pills) {
      g.font = `11px ${FONT}`;
      const room = x + w - clockW - px;
      if (room < 60) break;
      const tw = Math.min(g.measureText(label).width + 18, Math.min(room, 360));
      g.strokeStyle = fill === C.text ? '#2a5a99' : fill;
      g.beginPath();
      g.roundRect(px, cy - 10, tw, 20, 10);
      g.stroke();
      this.text(g, label, px + 9, cy + 1, tw - 18, `11px ${FONT}`, fill);
      px += tw + 6;
    }
    g.textAlign = 'right';
    g.font = `600 16px ${MONO}`;
    g.fillStyle = C.gold;
    g.fillText(clock(m.elapsedMs), x + w - 12, cy + 1);
    g.textAlign = 'left';
  }

  drawStations(g, x, y, w, h, stations) {
    const active = stations.filter((s) => s.state !== 'stby').length;
    this.card(g, x, y, w, h, `STASIUN · ${active} AKTIF / ${stations.length}`);
    const cols = w > 300 ? 2 : 1;
    const gap = 6;
    const cw = (w - 20 - gap * (cols - 1)) / cols;
    const ch = 54;
    const rows = Math.max(1, Math.floor((h - 30) / (ch + gap)));
    const shown = stations.slice(0, rows * cols);
    shown.forEach((s, i) => {
      const sx = x + 10 + (i % cols) * (cw + gap);
      const sy = y + 24 + Math.floor(i / cols) * (ch + gap);
      const col = color(s.role);
      const [label, labelColor] = STATE[s.state] ?? STATE.stby;
      g.save();
      g.globalAlpha = s.state === 'stby' || s.state === 'done' ? 0.55 : 1;
      g.fillStyle = '#0a1830';
      g.strokeStyle = s.state === 'go' ? '#2bd67b' : s.state === 'hold' ? C.warn : s.state === 'fail' ? C.bad : C.sub;
      g.beginPath();
      g.roundRect(sx + 0.5, sy + 0.5, cw - 1, ch - 1, 6);
      g.fill();
      g.stroke();
      g.textBaseline = 'middle';
      g.fillStyle = col;
      g.beginPath();
      g.arc(sx + 10, sy + 11, 3.5, 0, TAU);
      g.fill();
      this.text(g, short(s.role), sx + 18, sy + 11, cw * 0.55, `600 12px ${FONT}`, col);
      g.textAlign = 'right';
      const badge = s.tests && s.state === 'fail' ? `✖ ${s.tests.failed}` : label;
      g.font = `600 10px ${MONO}`;
      g.fillStyle = labelColor;
      g.fillText(badge, sx + cw - 7, sy + 11);
      g.textAlign = 'left';
      this.text(g, s.what || (s.state === 'stby' ? 'siaga · belum ada tugas' : ''), sx + 8, sy + 27, cw - 16, `10px ${FONT}`, C.dim);
      // sparkline: this role's activity over the mission
      const max = Math.max(1, ...s.spark);
      const bw = (cw - 16) / s.spark.length;
      g.fillStyle = col;
      s.spark.forEach((n, k) => {
        const bh = Math.max(1, (n / max) * 12);
        g.fillRect(sx + 8 + k * bw, sy + ch - 6 - bh, bw - 2, bh);
      });
      g.restore();
      this.hits.push({ x: sx, y: sy, w: cw, h: ch, role: s.role });
    });
    if (stations.length > shown.length) this.text(g, `+${stations.length - shown.length} stasiun lain`, x + 10, y + h - 9, w - 20, `10px ${FONT}`, C.dim);
  }

  drawTelemetry(g, x, y, w, h, m, st) {
    this.card(g, x, y, w, h, 'TELEMETRI MISI');
    const ctx = st.context?.used ? fmtTokens(st.context.used) : '—';
    const tiles = [
      ['KONTEKS', ctx, st.context?.window ? `dari ${fmtTokens(st.context.window)}` : 'token di konteks'],
      ['BIAYA', m.telemetry.costUsd === null ? '—' : `$${m.telemetry.costUsd.toFixed(2)}`, `${fmtTokens(m.telemetry.tokensOut)} token keluar`],
      ['LANGKAH', String(m.telemetry.steps), `${m.telemetry.delegations} delegasi`],
    ];
    const tw = (w - 20 - 12) / 3;
    tiles.forEach(([k, v, sub], i) => {
      const tx = x + 10 + i * (tw + 6);
      const ty = y + 24;
      const th = h - 32;
      g.fillStyle = '#0a1830';
      g.strokeStyle = C.sub;
      g.beginPath();
      g.roundRect(tx + 0.5, ty + 0.5, tw - 1, th - 1, 6);
      g.fill();
      g.stroke();
      g.textBaseline = 'middle';
      this.text(g, k, tx + 8, ty + 10, tw - 16, `600 9px ${FONT}`, C.head);
      this.text(g, v, tx + 8, ty + th / 2 + 2, tw - 16, `700 ${clamp(Math.round(th / 2.6), 14, 24)}px ${MONO}`, '#e8f2ff');
      this.text(g, sub, tx + 8, ty + th - 9, tw - 16, `9px ${FONT}`, C.dim);
    });
  }

  drawRadar(g, x, y, w, h, m, t, st = {}) {
    this.card(g, x, y, w, h, 'RADAR TIM · LEAD DI PUSAT');
    const footer = st.context ? 58 : 18;
    const holdH = m.holds.length ? 30 : 0;
    const cx = x + w / 2;
    const cy = y + 22 + (h - 22 - footer - holdH) / 2;
    const R = Math.max(20, Math.min(w / 2 - 30, (h - 22 - footer - holdH) / 2 - 14));
    g.strokeStyle = C.sub;
    g.lineWidth = 1;
    for (const k of [1, 0.66, 0.33]) {
      g.beginPath();
      g.arc(cx, cy, R * k, 0, TAU);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - R - 8, cy);
    g.lineTo(cx + R + 8, cy);
    g.moveTo(cx, cy - R - 8);
    g.lineTo(cx, cy + R + 8);
    g.stroke();
    // the sweep
    const a = (t / 2200) % TAU;
    g.fillStyle = 'rgba(43,214,123,0.13)';
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, R, a - 0.7, a);
    g.closePath();
    g.fill();
    // active roles around the centre: working ones on the inner ring, the rest outside
    const active = m.stations.filter((s) => s.state === 'go' || s.state === 'hold' || s.state === 'fail');
    active.forEach((s, i) => {
      const ang = -Math.PI / 2 + (i / Math.max(1, active.length)) * TAU + 0.4;
      const px = cx + Math.cos(ang) * R * 0.78;
      const py = cy + Math.sin(ang) * R * 0.78;
      const col = color(s.role);
      g.strokeStyle = col;
      g.setLineDash([3, 4]);
      g.lineDashOffset = -t / 60;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(px, py);
      g.stroke();
      g.setLineDash([]);
      if (s.state === 'hold') {
        g.strokeStyle = C.warn;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(px, py, 9 + Math.sin(t / 200) * 1.5, 0, TAU);
        g.stroke();
        g.lineWidth = 1;
      }
      g.fillStyle = s.state === 'fail' ? C.bad : col;
      g.beginPath();
      g.arc(px, py, 6, 0, TAU);
      g.fill();
      g.textAlign = 'center';
      this.text(g, `${short(s.role)}${s.state === 'hold' ? ' ⚠' : ''}`, px, py - 13, 90, `10px ${FONT}`, C.text);
      g.textAlign = 'left';
      this.hits.push({ x: px - 14, y: py - 14, w: 28, h: 28, role: s.role });
    });
    g.fillStyle = '#d97757';
    g.beginPath();
    g.arc(cx, cy, 13, 0, TAU);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 9px ${FONT}`;
    g.fillStyle = '#fff';
    g.fillText('LEAD', cx, cy + 1);
    g.textAlign = 'left';
    let fy = y + h - footer - holdH;
    if (st.context) {
      const pct = st.context.window ? clamp(st.context.used / st.context.window, 0, 1) : 0;
      this.text(g, `KONTEKS (MEMORI) · ${Math.round(pct * 100)}%`, x + 10, fy + 12, w - 20, `600 10px ${FONT}`, C.head);
      g.fillStyle = '#132744';
      g.beginPath();
      g.roundRect(x + 10, fy + 22, w - 20, 9, 5);
      g.fill();
      const grad = g.createLinearGradient(x + 10, 0, x + w - 10, 0);
      grad.addColorStop(0, '#2bd67b');
      grad.addColorStop(1, pct > 0.8 ? C.bad : C.gold);
      g.fillStyle = grad;
      g.beginPath();
      g.roundRect(x + 10, fy + 22, Math.max(4, (w - 20) * pct), 9, 5);
      g.fill();
      fy += footer;
    }
    if (m.holds.length) {
      const hold = m.holds.at(-1);
      g.fillStyle = '#2a1a05';
      g.strokeStyle = C.warn;
      g.beginPath();
      g.roundRect(x + 10, fy - holdH + 26, w - 20, 24, 6);
      g.fill();
      g.stroke();
      this.text(g, `⚠ HOLD · ${short(hold.role)} minta izin: ${hold.text} — klik untuk menjawab`, x + 18, fy - holdH + 38, w - 36, `11px ${FONT}`, '#ffd38a');
      this.hits.push({ x: x + 10, y: fy - holdH + 26, w: w - 20, h: 24, role: hold.role });
    }
  }

  drawLog(g, x, y, w, h, m) {
    this.card(g, x, y, w, h, 'CAPCOM · LOG KOMUNIKASI');
    const lh = 17;
    const room = Math.max(0, Math.floor((h - 30) / lh));
    const lines = m.log.slice(-room);
    if (!lines.length) this.text(g, 'Belum ada misi. Kirim prompt untuk memulai.', x + 10, y + 34, w - 20, `11px ${FONT}`, C.dim);
    lines.forEach((l, i) => {
      const ly = y + 32 + i * lh;
      const ts = clock(l.t).replace('T+ ', 'T+').replace(/^T\+00:/, 'T+');
      this.text(g, ts, x + 10, ly, 60, `10px ${MONO}`, '#5f7aa3');
      this.text(g, l.text, x + 70, ly, w - 80, `11px ${MONO}`, TONE[l.tone] ?? C.text);
    });
  }

  drawGround(g, x, y, w, h, st) {
    this.card(g, x, y, w, h, 'GROUND CONTROL · GIT & CI');
    const ci = st.ci;
    const ciText = !ci ? 'CI: belum ada push di sesi ini' : { pending: 'CI: ⏳ menunggu GitHub…', running: 'CI: ⏳ berjalan', success: 'CI: ✅ lulus', failure: 'CI: ❌ gagal', login: 'CI: 🔑 login GitHub dulu', none: 'CI: repo tanpa workflow', error: 'CI: ⚠ tidak terbaca' }[ci.state] ?? `CI: ${ci.state}`;
    const ciColor = ci?.state === 'success' ? C.ok : ci?.state === 'failure' ? C.bad : ci ? C.warn : C.dim;
    this.text(g, ciText, x + 10, y + 32, w - 20, `11px ${MONO}`, ciColor);
    const wt = st.worktree?.branch ? `⎇ ${st.worktree.branch} (worktree)` : '';
    const mode = st.mode ? `mode izin: ${st.mode}` : '';
    this.text(g, [wt, mode].filter(Boolean).join(' · ') || '—', x + 10, y + 52, w - 20, `11px ${MONO}`, C.dim);
  }

  drawTimeline(g, x, y, w, h, m, now) {
    this.card(g, x, y, w, h, 'TIMELINE MISI · SIAPA BEKERJA KAPAN');
    const lanes = m.timeline;
    const labelW = 80;
    const tx = x + 10 + labelW;
    const tw = w - 20 - labelW;
    const span = Math.max(1, now - m.start);
    const lh = clamp(Math.floor((h - 28) / Math.max(1, lanes.length)), 8, 20);
    const room = Math.max(1, Math.floor((h - 28) / lh));
    if (!lanes.length) this.text(g, 'Belum ada aktivitas di misi ini.', x + 10, y + 34, w - 20, `11px ${FONT}`, C.dim);
    lanes.slice(0, room).forEach((lane, i) => {
      const ly = y + 24 + i * lh;
      g.textBaseline = 'middle';
      this.text(g, short(lane.role), x + 10, ly + lh / 2, labelW - 6, `11px ${FONT}`, '#8fb0dd');
      g.fillStyle = '#0b1a31';
      g.fillRect(tx, ly + 2, tw, lh - 4);
      g.fillStyle = color(lane.role);
      for (const [a, b] of lane.segs) {
        const sx = tx + ((a - m.start) / span) * tw;
        const ex = tx + ((b - m.start) / span) * tw;
        g.beginPath();
        g.roundRect(sx, ly + 2, Math.max(3, ex - sx), lh - 4, 3);
        g.fill();
      }
    });
    // "now" marker
    g.fillStyle = C.gold;
    g.fillRect(tx + tw - 1, y + 20, 2, h - 26);
  }
}
