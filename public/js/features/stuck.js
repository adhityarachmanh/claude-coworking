// ⚠ Stuck detector: a running tool row whose output hasn't changed for a while (or that has been running very long),
// or a delegation with no new activity, gets a warning chip in the chat with actions (■ Hentikan giliran,
// ⧗ Pindah ke latar, Lihat detail), the person in the office a subtle "…?" and, once per episode, an 'error'
// notification (per-device settings and quiet hours apply). Nothing is ever stopped automatically.
//
// Signals, cheapest first: the chat itself (subagent tool rows appearing/finishing), the status' task counters
// (tokens / tool uses), the live output live-output.js already reads for rows on screen. Only when those are
// quiet does it read more: task-output for an off-screen shell row (every 30 s, after 2 min, at most 3 reads per
// tick over all projects) and task-detail for
// a delegation (every 30 s, after 1 min quiet, active project, visible page). Rules and thresholds: core/stuck-rules.js.
import { api, toast } from '../core/api.js';
import { escapeHtml } from '../core/dom.js';
import { scenes } from '../core/scenes.js';
import { DEMO_ID, READ_ONLY_HINT, projectName, state } from '../core/state.js';
import {
  STUCK,
  clockSkew,
  delegateChipText,
  delegateStuck,
  detailSig,
  latest,
  shouldPollDetail,
  shouldPollOutput,
  sleepGap,
  stuckEpisodes,
  toLocal,
  toolChipText,
  toolStuck,
  trackOutput,
} from '../core/stuck-rules.js';
import { fetchTaskOutput } from '../core/task-output.js';
import { roleName } from '../office/cast.js';
import { liveOutput } from './live-output.js';
import { notify } from './notify.js';
import { backgroundRunning, openTasks } from './tasks.js';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_SKEW_SAMPLES = 20;

/** The detector's clock; tests move it forward instead of waiting minutes. */
export const stuckClock = { now: () => Date.now() };

export const stuck = {
  verdicts: new Map(), // `${project}|${msgId}` -> verdict (see evaluate); only stuck rows are here
  seen: new Map(), // row key -> browser time it was first seen running
  outputs: new Map(), // shell task id -> trackOutput state
  outputPolls: new Map(), // shell task id -> last own task-output read
  activity: new Map(), // delegation key -> { subSig, taskSig, detail: { sig, polledAt }, at }
  inflight: new Set(), // task ids with a read on its way
  floor: new Map(), // row key -> nothing before this counts (the user was being asked; reset when the wait ends)
  shift: new Map(), // row key -> ms not counted from its start (laptop asleep / tab frozen, see sleepGap)
  episodes: new Map(), // `${project}|${role}` -> last time stuck (one notification per episode, core stuckEpisodes)
  skew: [], // browser - server clock samples (core/stuck-rules.js clockSkew)
  online: true, // false from a lost event stream until its fresh snapshot: the chat may be stale meanwhile
  lastTick: null,
  pollsLeft: 0, // own task-output reads still allowed in this tick (STUCK.OUTPUT_POLLS_PER_TICK)
  timer: null,
};

/** The event stream dropped (false) / its fresh snapshot arrived (true). Stale data is never judged. */
export function setStuckOnline(on) {
  stuck.online = on;
}

const keyOf = (project, id) => `${project}|${id}`;
const isRunningTask = (t) => t?.status === 'running' || t?.status === 'pending';

/** A chat message that just arrived live: one sample of the browser/server clock difference. */
export function noteLiveMessage(msg) {
  if (typeof msg?.ts !== 'number') return;
  stuck.skew.push(Date.now() - msg.ts);
  if (stuck.skew.length > MAX_SKEW_SAMPLES) stuck.skew.shift();
}

// ---------- evaluation ----------

/** Something is still going on in the project: a turn (web or terminal) or a running task. */
function projectAlive(project) {
  const st = state.statuses[project] ?? {};
  return Boolean(st.busy || st.cliBusy || (st.tasks ?? []).some(isRunningTask));
}

/** The project is waiting for the user (a permission card or a question): its quiet rows are not stuck. */
function projectWaiting(project) {
  if (state.statuses[project]?.pending) return true;
  for (const a of state.approvals?.values?.() ?? []) if (a.project === project && a.status === 'pending') return true;
  return false;
}

/** When a row started, minus time that doesn't count (asleep; before the last wait for the user). */
function countedStart(key, startedAt) {
  return Math.max(startedAt + (stuck.shift.get(key) ?? 0), stuck.floor.get(key) ?? -Infinity);
}

/** The running agent task behind a delegation row: same role, started closest to the row. */
function agentTaskFor(project, msg) {
  const tasks = (state.statuses[project]?.tasks ?? []).filter((t) => t.kind === 'agent' && isRunningTask(t) && t.role === msg.role);
  return tasks.sort((a, b) => Math.abs((a.startedAt ?? 0) - msg.ts) - Math.abs((b.startedAt ?? 0) - msg.ts))[0] ?? null;
}

const shellTaskFor = (project, msg) => (msg.taskId ? ((state.statuses[project]?.tasks ?? []).find((t) => t.id === msg.taskId) ?? null) : null);

function evaluateTool(project, msg, key, now, skew) {
  const startedAt = countedStart(key, toLocal(msg.ts, skew, now) ?? stuck.seen.get(key));
  // Claude Code's own "running for" is a floor, but only while nothing has been discounted from this row.
  const elapsedMs = stuck.floor.has(key) || stuck.shift.has(key) ? 0 : (msg.elapsed ?? 0) * 1000;
  const shell = SHELL_TOOLS.has(msg.tool);
  let output = null;
  if (shell && msg.taskId) {
    const onScreen = project === state.active && !document.hidden && liveOutput.visible.has(msg.id);
    const live = liveOutput.outputs.get(msg.taskId);
    // On screen, live-output reads it every 1.5 s: its latest text counts as a read made now.
    if (onScreen && live && !live.error) stuck.outputs.set(msg.taskId, trackOutput(stuck.outputs.get(msg.taskId), live.text, now, startedAt));
    else if (stuck.pollsLeft > 0 && shouldPollOutput({ runningMs: Math.max(now - startedAt, elapsedMs), lastPollAt: stuck.outputPolls.get(msg.taskId), now, onScreen })) {
      stuck.pollsLeft--; // a cap per tick over all projects: many running shells never mean a burst of reads
      pollOutput(project, msg.taskId, startedAt);
    }
    const out = stuck.outputs.get(msg.taskId);
    output = out ? { ...out, changedAt: Math.max(out.changedAt, startedAt) } : null; // a wait / sleep is not "quiet"
  }
  const v = toolStuck({ startedAt, elapsedMs, output, now });
  if (!v) return null;
  const task = shellTaskFor(project, msg);
  return { kind: 'tool', project, msgId: msg.id, role: msg.role, text: toolChipText(v), label: msg.text, shell, background: Boolean(task?.background) };
}

function evaluateDelegate(project, msg, key, chat, index, now, skew) {
  const startedAt = countedStart(key, toLocal(msg.ts, skew, now) ?? stuck.seen.get(key));
  // Its subagent's own tool rows (after the delegation, same role): one appearing or finishing is activity.
  const subs = chat.slice(index + 1).filter((m) => m.sub && m.role === msg.role);
  const subSig = `${subs.length}|${subs.filter((m) => m.status !== 'running').length}|${subs.at(-1)?.id ?? ''}`;
  const task = agentTaskFor(project, msg);
  const taskSig = task ? `${task.id}|${task.tokens ?? ''}|${task.toolUses ?? ''}|${task.summary ?? ''}` : '';
  let a = stuck.activity.get(key);
  if (!a) {
    // First look (also after a reload): the newest known moment, not "now" — a long-quiet one shows up right away.
    a = { subSig, taskSig, detail: null, at: latest(startedAt, ...subs.map((m) => toLocal(m.ts, skew, now))) };
    stuck.activity.set(key, a);
  }
  if (a.subSig !== subSig || (a.taskSig !== taskSig && a.taskSig && taskSig)) a.at = now;
  a.at = Math.max(a.at, stuck.floor.get(key) ?? -Infinity); // waiting for the user counts as activity
  a.subSig = subSig;
  a.taskSig = taskSig || a.taskSig;
  if (task && shouldPollDetail({ quietMs: now - a.at, lastPollAt: a.detail?.polledAt, now, visible: project === state.active && !document.hidden })) pollDetail(project, task.id, key);
  const v = delegateStuck({ lastActivityAt: a.at, now });
  if (!v) return null;
  return {
    kind: 'delegate',
    project,
    msgId: msg.id,
    role: msg.role,
    text: delegateChipText(roleName(msg.role), v),
    label: msg.text,
    taskId: task?.id ?? null,
    background: Boolean(task?.background),
  };
}

/** Re-evaluates every running row of every project; chips, office and notifications follow. */
export function checkStuck() {
  if (!stuck.online) return; // the chat may be stale until the fresh snapshot: judge nothing
  const now = stuckClock.now();
  // Asleep / frozen since the last tick: that time is not "no output", so every clock moves forward by the gap.
  const gap = sleepGap(stuck.lastTick, now);
  stuck.lastTick = now;
  if (gap) {
    for (const k of stuck.seen.keys()) stuck.shift.set(k, (stuck.shift.get(k) ?? 0) + gap);
    for (const a of stuck.activity.values()) a.at += gap;
    for (const o of stuck.outputs.values()) o.changedAt += gap;
  }
  stuck.pollsLeft = STUCK.OUTPUT_POLLS_PER_TICK;
  const skew = clockSkew(stuck.skew);
  const verdicts = new Map();
  const live = new Set();
  for (const [project, chat] of Object.entries(state.chats ?? {})) {
    if (project === DEMO_ID || !projectAlive(project)) continue;
    const waiting = projectWaiting(project);
    chat.forEach((msg, i) => {
      if (msg.status !== 'running' || msg.history || (msg.kind !== 'tool' && msg.kind !== 'delegate')) return;
      const key = keyOf(project, msg.id);
      live.add(key);
      if (!stuck.seen.has(key)) stuck.seen.set(key, now);
      // Waiting for the user: no verdict, and the quiet / idle clocks start again when the wait ends.
      if (waiting) {
        stuck.floor.set(key, now);
        return;
      }
      const v = msg.kind === 'tool' ? evaluateTool(project, msg, key, now, skew) : evaluateDelegate(project, msg, key, chat, i, now, skew);
      if (v) verdicts.set(key, v);
    });
  }
  // Rows that ended (or projects that went idle) leave no state behind.
  for (const map of [stuck.seen, stuck.activity, stuck.floor, stuck.shift]) for (const k of map.keys()) if (!live.has(k)) map.delete(k);
  const shellTasks = new Set(Object.values(state.chats ?? {}).flat().filter((m) => m.status === 'running' && m.taskId).map((m) => m.taskId));
  for (const map of [stuck.outputs, stuck.outputPolls]) for (const k of map.keys()) if (!shellTasks.has(k)) map.delete(k);

  const before = stuck.verdicts;
  stuck.verdicts = verdicts;
  paintChips(before);
  paintOffice();
  notifyEpisodes(now, Boolean(gap));
}

// ---------- reads (only when the cheap signals are quiet) ----------

async function pollOutput(project, taskId, startedAt) {
  if (stuck.inflight.has(taskId)) return;
  stuck.inflight.add(taskId);
  stuck.outputPolls.set(taskId, stuckClock.now());
  try {
    const out = await fetchTaskOutput(project, taskId);
    stuck.outputs.set(taskId, trackOutput(stuck.outputs.get(taskId), out.text, stuckClock.now(), startedAt));
  } catch {
    // Unreadable (task gone, Claude Code restarted): only the "running very long" rule applies to it.
  } finally {
    stuck.inflight.delete(taskId);
  }
}

async function pollDetail(project, taskId, key) {
  const a = stuck.activity.get(key);
  if (!a || stuck.inflight.has(taskId)) return;
  stuck.inflight.add(taskId);
  const polledAt = stuckClock.now();
  a.detail = { sig: a.detail?.sig ?? null, polledAt };
  try {
    const d = await api(`/api/projects/${project}/task-detail`, { taskId });
    const sig = detailSig(d);
    const now = stuckClock.now();
    if (a.detail.sig === null) a.at = latest(a.at, toLocal(d.updatedAt, clockSkew(stuck.skew), now)); // first read: when the transcript was last written
    else if (sig !== a.detail.sig) a.at = now;
    a.detail = { sig, polledAt };
  } catch {
    // Not readable right now (read-only allowlist, task cleaned up): the other signals still count.
  } finally {
    stuck.inflight.delete(taskId);
  }
}

// ---------- chips in the chat ----------

/** Which buttons a stuck row offers (drawn disabled on a read-only phone). */
function actionsOf(v) {
  const st = state.statuses[v.project] ?? {};
  const acts = [];
  if (v.kind === 'delegate') acts.push('detail');
  if (st.busy) acts.push('stop');
  else if (v.kind === 'delegate' && v.background && v.taskId) acts.push('task-stop'); // a background agent outlives the turn
  if (v.kind === 'tool' && v.shell && st.busy && !v.background) acts.push('background'); // what Ctrl+B does
  return acts;
}

// `ro`: the attributes of an action that changes something, on a read-only phone (off, with the usual explanation).
const BUTTONS = {
  detail: (v) => `<button type="button" class="ghost" data-stuck-act="detail" aria-label="Lihat detail ${escapeHtml(roleName(v.role))}">Lihat detail</button>`,
  stop: (v, ro) => `<button type="button" class="danger" data-stuck-act="stop" ${ro || 'title="Hentikan giliran yang sedang berjalan (Esc)"'}>■ Hentikan giliran</button>`,
  'task-stop': (v, ro) => `<button type="button" class="danger" data-stuck-act="task-stop" aria-label="Hentikan tugas latar ${escapeHtml(roleName(v.role))}" ${ro}>■ Hentikan tugas</button>`,
  background: (v, ro) => `<button type="button" data-stuck-act="background" ${ro || 'title="Biarkan perintah jalan di latar belakang (Ctrl+B)"'}>⧗ Pindah ke latar</button>`,
};

/** The chip under a running row (chat.js draws it with the row; '' when the row isn't stuck). */
export function stuckChip(msg) {
  if (msg?.status !== 'running') return ''; // ended since the last tick: never a stale chip (or its Stop)
  const v = stuck.verdicts.get(keyOf(msg.project ?? state.active, msg.id));
  if (!v) return '';
  const acts = actionsOf(v);
  const ro = state.readOnly ? `disabled title="${escapeHtml(READ_ONLY_HINT)}"` : ''; // "Lihat detail" only reads: always on
  const buttons = acts.map((a) => BUTTONS[a](v, ro)).join('');
  return `<div class="stuck-chip" data-stuck="${acts.join(',')}|${Boolean(state.readOnly)}"><span class="stuck-text">${escapeHtml(v.text)}</span>${buttons ? `<span class="stuck-acts">${buttons}</span>` : ''}</div>`;
}

const rowNode = (id) => [...document.querySelectorAll(`#chat > [data-id="${CSS.escape(id)}"]`)].at(-1) ?? null;

/** Updates the chips of rows whose verdict changed, in place (a focused button keeps focus while the minutes tick). */
function paintChips(before) {
  const keys = new Set([...before.keys(), ...stuck.verdicts.keys()]);
  for (const key of keys) {
    const v = stuck.verdicts.get(key) ?? before.get(key);
    if (v.project !== state.active) continue;
    const node = rowNode(v.msgId);
    const msg = node && (state.chats[v.project] ?? []).findLast((m) => m.id === v.msgId);
    if (!msg) continue;
    const html = stuckChip(msg);
    const old = node.querySelector(':scope > .stuck-chip');
    if (!html) {
      old?.remove();
      continue;
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const chip = tmp.firstElementChild;
    if (old && old.dataset.stuck === chip.dataset.stuck) old.querySelector('.stuck-text').textContent = chip.querySelector('.stuck-text').textContent;
    else if (old) old.replaceWith(chip);
    else node.querySelector(':scope > .row')?.after(chip);
  }
}

// ---------- the office and notifications ----------

function paintOffice() {
  const byProject = new Map();
  for (const v of stuck.verdicts.values()) {
    if (!byProject.has(v.project)) byProject.set(v.project, new Set());
    byProject.get(v.project).add(v.role);
  }
  for (const [project, scene] of scenes) scene.setStuck?.(byProject.get(project) ?? new Set());
}

function notifyEpisodes(now, muted) {
  const byEpisode = new Map();
  for (const v of stuck.verdicts.values()) if (!byEpisode.has(`${v.project}|${v.role}`)) byEpisode.set(`${v.project}|${v.role}`, v);
  const { fire, next } = stuckEpisodes(stuck.episodes, byEpisode.keys(), now);
  stuck.episodes = next;
  if (muted) return; // just woke up: whatever looks stuck now is shown, not announced in a burst
  for (const key of fire) {
    const v = byEpisode.get(key);
    const what = v.text.replace(/^⚠\s*/, '');
    notify('error', `⚠ Mungkin macet — ${projectName(v.project)}`, v.kind === 'tool' ? `${roleName(v.role)}: ${v.label} — ${what}` : what, v.project);
  }
}

// ---------- wiring ----------

async function act(btn) {
  const node = btn.closest('[data-id]');
  const v = node && stuck.verdicts.get(keyOf(state.active, node.dataset.id));
  if (!v) return;
  const what = btn.dataset.stuckAct;
  if (what === 'detail') {
    if (v.taskId) openTasks({ taskId: v.taskId });
    else if (!node.classList.contains('open')) node.querySelector(':scope > .row')?.click(); // instruction & report
    return;
  }
  if (state.readOnly) return toast(`${READ_ONLY_HINT}.`);
  // A chip drawn a moment ago must never stop a newer turn: the row is still running and the turn still on.
  const msg = (state.chats[v.project] ?? []).findLast((m) => m.id === v.msgId);
  const st = state.statuses[v.project] ?? {};
  if (msg?.status !== 'running' || (what !== 'task-stop' && !st.busy)) {
    btn.closest('.stuck-chip')?.remove();
    return toast('Sudah selesai, tidak ada yang dihentikan.', 'ok');
  }
  if (what === 'background') return backgroundRunning();
  btn.disabled = true;
  try {
    if (what === 'stop') await api(`/api/projects/${v.project}/stop`);
    else if (what === 'task-stop') await api(`/api/projects/${v.project}/task-stop`, { taskId: v.taskId });
    toast(what === 'stop' ? 'Giliran dihentikan.' : 'Tugas dihentikan.', 'ok');
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

export function initStuck() {
  document.querySelector('#chat').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stuck-act]');
    if (btn) act(btn);
  });
  stuck.timer = setInterval(checkStuck, STUCK.TICK_MS);
  // Back on the tab: judge right away (reads skipped while hidden are made now).
  document.addEventListener('visibilitychange', () => document.hidden || checkStuck());
}
