// 🗂 Semua project: the pure part of the dashboard (no DOM, no app state) — one summary per project from what the
// event stream already holds (status, chat, approvals, stuck verdicts), the card order, the group counts.
// Used by features/dashboard.js; unit-tested in test/dashboard-rules.test.mjs.

/** Card groups, in display order. */
export const GROUP = Object.freeze({ NEEDS: 0, WORKING: 1, QUEUE: 2, IDLE: 3 });

const SNIPPET_MAX = 160;
const TASK_MAX = 90;

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** "baru saja", "2 mnt lalu", "3 jam lalu", "2 hari lalu", else a short date; "" without a time. */
export function relTime(ts, now = Date.now()) {
  if (!num(ts)) return '';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} hari lalu`;
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

/** The newest prompt or Claude reply with text: { who: 'user' | 'claude', text } or null. */
export function snippetOf(chat = []) {
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if ((m?.kind !== 'user' && m?.kind !== 'assistant') || m.rewound || m.sub) continue;
    const text = clip(m.text, SNIPPET_MAX);
    if (text) return { who: m.kind === 'user' ? 'user' : 'claude', text };
  }
  return null;
}

/** What the team is doing right now: the newest running tool / delegation row (its label), or null. */
export function currentTask(chat = []) {
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m?.status === 'running' && (m.kind === 'tool' || m.kind === 'delegate')) return clip(m.text, TASK_MAX) || null;
    if (m?.kind === 'result' || m?.kind === 'divider') return null; // an older turn's leftovers never count
  }
  return null;
}

/** Context used in % (as /context counts it), or null while the window is unknown. */
export function contextPct(st = {}) {
  const used = num(st.context?.used);
  const win = num(st.context?.window);
  return used && win ? Math.min(100, Math.round((used / win) * 100)) : null;
}

/** Roles at work in the web session and the terminal session (Lead first when the turn itself is running). */
export function activeRoles(st = {}) {
  const roles = new Set();
  if (st.busy || st.cliBusy) roles.add('claude');
  for (const map of [st.working, st.cliWorking]) {
    for (const [role, w] of Object.entries(map ?? {})) if (num(w?.tools) + num(w?.agents) > 0) roles.add(role);
  }
  return [...roles];
}

/** Waiting + running items of the 📋 Antrian, and whether it is paused. */
export function queueOf(st = {}) {
  const q = st.taskQueue;
  if (!q) return { open: 0, paused: false };
  return { open: num(q.waiting) + num(q.running), paused: Boolean(q.paused) };
}

/**
 * One project's card data.
 * @param {object} project  { id, name, favorite, lastActivity }
 * @param {object} st       its status from the stream (may be missing: never opened since the server started)
 * @param {object} ctx      { chat, events, approvals (this project's, any status), stuck (count of verdicts), demo }
 */
export function summarize(project, st = {}, { chat = [], events = [], approvals = [], stuck = 0, demo = false } = {}) {
  const waiting = approvals.filter((a) => a?.status === 'pending').sort((a, b) => num(a.ts) - num(b.ts));
  const pending = Math.max(num(st.pending), waiting.length);
  const busy = Boolean(st.busy || st.cliBusy);
  const queue = queueOf(st);
  const interrupted = Boolean(st.interrupted);
  const stuckNow = busy && stuck > 0 && !pending;

  let group = GROUP.IDLE;
  let pill = { kind: 'idle', text: '💤 Idle' };
  let rank = 0; // order inside the "needs you" group
  if (pending) [group, pill, rank] = [GROUP.NEEDS, { kind: 'ask', text: `✋ Butuh izin (${pending})` }, 0];
  else if (interrupted && !busy) [group, pill, rank] = [GROUP.NEEDS, { kind: 'cut', text: '⚠ Terputus' }, 1];
  else if (stuckNow) [group, pill, rank] = [GROUP.NEEDS, { kind: 'stuck', text: '⚠ mungkin macet' }, 2];
  else if (busy) [group, pill] = [GROUP.WORKING, { kind: 'busy', text: '⏳ Bekerja' }];
  else if (queue.open) [group, pill] = [GROUP.QUEUE, { kind: 'queue', text: `📋 Antrian ${queue.open}${queue.paused ? ' ⏸' : ''}` }];

  const lastChat = chat.at(-1);
  const lastEvent = events.at(-1);
  const lastActivity = Math.max(num(project.lastActivity), num(lastChat?.ts), num(lastEvent?.ts), ...waiting.map((a) => num(a.ts)));

  return {
    id: project.id,
    name: String(project.name ?? project.id ?? 'project'),
    favorite: Boolean(project.favorite),
    demo: Boolean(demo),
    group,
    rank,
    pill,
    pending,
    busy,
    cli: Boolean(st.cliBusy && !st.busy),
    queue,
    roles: busy ? activeRoles(st) : [],
    task: busy ? currentTask(chat) : null,
    waitingLabel: waiting[0] ? clip(waiting[0].label, TASK_MAX) : null,
    approvalChatId: waiting[0]?.chatId ?? null,
    snippet: snippetOf(chat),
    model: st.activeModel || st.model || null,
    engine: st.engine ?? null,
    contextPct: contextPct(st),
    lastActivity,
  };
}

/** Needs you → working → queue → idle; idle favourites first; then most recent activity; the demo last. */
export function compareSummaries(a, b) {
  return (
    a.group - b.group ||
    a.rank - b.rank ||
    Number(a.demo) - Number(b.demo) ||
    (a.group === GROUP.IDLE ? Number(b.favorite) - Number(a.favorite) : 0) ||
    b.lastActivity - a.lastActivity ||
    a.name.localeCompare(b.name)
  );
}

export const sortSummaries = (list) => [...list].sort(compareSummaries);

/** How many cards per group (the header line and the phone's Kantor bar). */
export function countGroups(list) {
  const out = { needs: 0, working: 0, queue: 0, idle: 0 };
  for (const s of list) out[['needs', 'working', 'queue', 'idle'][s.group]]++;
  return out;
}

/** "2 butuh kamu · 1 bekerja · 1 antrian" (idle only when nothing else is going on). */
export function countsText(c) {
  const parts = [];
  if (c.needs) parts.push(`${c.needs} butuh kamu`);
  if (c.working) parts.push(`${c.working} bekerja`);
  if (c.queue) parts.push(`${c.queue} antrian`);
  if (!parts.length) parts.push(c.idle ? 'semua idle' : 'belum ada project');
  return parts.join(' · ');
}

/** Cards whose name matches `q` (case-insensitive, any part of the name). */
export function matchesQuery(summary, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  return !needle || summary.name.toLowerCase().includes(needle);
}

/** Status changes worth announcing (aria-live): a card that newly needs you, or work that just ended. */
export function announcement(prev, next) {
  if (!prev || prev.pill.kind === next.pill.kind) return null;
  if (['ask', 'cut', 'stuck'].includes(next.pill.kind)) return `${next.name}: ${next.pill.text}`;
  if (next.pill.kind === 'idle' && ['busy', 'ask', 'stuck'].includes(prev.pill.kind)) return `${next.name}: selesai`;
  return null;
}
