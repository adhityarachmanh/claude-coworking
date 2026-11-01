// Live output of a running Bash/PowerShell row in the chat. Claude Code reports a foreground command as a task
// (the row carries its `taskId`), so its output can be read while it runs (get_task_output, the same call as the
// ⧗ task monitor). Polled only for rows on screen in the active project with the tab visible; it stops as soon as
// the command ends, when the row's final output (tool_result) takes over.
import { escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { TRUNCATED_NOTE, fetchTaskOutput, nearBottom, tailHtml } from '../core/task-output.js';

const POLL_MS = 1500; // a bit livelier than the task monitor: the row is what the user is watching

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_ERRORS = 3; // consecutive failed reads (Claude Code restarted, task gone): stop trying for that row

export const liveOutput = {
  outputs: new Map(), // task id -> { text, truncated, error, errors }
  stick: new Map(), // task id -> follow the newest line (false once the user scrolls up inside the block)
  visible: new Set(), // chat message ids of live rows currently on screen
  timer: null,
  inflight: new Set(), // task ids with a read on its way
  observer: null,
};

/** A shell row whose command is still running and whose task id is known. */
export const isLiveShell = (msg) => msg?.kind === 'tool' && SHELL_TOOLS.has(msg.tool) && msg.status === 'running' && Boolean(msg.taskId);

const msgById = (id) => (state.chats[state.active] ?? []).findLast((m) => m.id === id);
const rowOf = (id) => [...document.querySelectorAll(`#chat > [data-id="${CSS.escape(id)}"]`)].at(-1) ?? null;

// ---------- markup (drawn by chat.js inside the row) ----------

/** Compact "last lines" preview under a collapsed running row (empty until there is output). */
export function liveTail(msg) {
  const out = liveOutput.outputs.get(msg.taskId);
  const tail = out?.text ? tailHtml(out.text, 8) : '';
  return `<pre class="live-tail" data-live-tail aria-hidden="true"${tail ? '' : ' hidden'}>${tail}</pre>`;
}

/** The full live block in an expanded row (replaces "Sedang berjalan…"). */
export function liveBlock(msg) {
  const out = liveOutput.outputs.get(msg.taskId);
  return `<div class="label">Output langsung <span class="spinner" aria-hidden="true"></span></div>
    <p class="muted small out-note" data-live-note${out?.truncated ? '' : ' hidden'}>${TRUNCATED_NOTE}</p>
    <p class="state-error small" data-live-err${out?.error ? '' : ' hidden'}>${escapeHtml(out?.error ? `Gagal membaca output: ${out.error}` : '')}</p>
    <pre class="out live-out" data-live-out tabindex="0" aria-label="Output perintah yang sedang berjalan">${escapeHtml(out ? out.text || '(belum ada output)' : 'Memuat output…')}</pre>`;
}

// ---------- in-place updates (no row re-render: scroll position and focus stay) ----------

function paint(row, taskId) {
  const out = liveOutput.outputs.get(taskId);
  if (!row || !out) return;
  const tail = row.querySelector('[data-live-tail]');
  if (tail) {
    tail.innerHTML = tailHtml(out.text, 8);
    tail.hidden = !out.text.trim();
  }
  const pre = row.querySelector('[data-live-out]');
  if (pre) {
    const text = out.text || '(belum ada output)';
    if (pre.textContent !== text) pre.textContent = text;
    if (liveOutput.stick.get(taskId) !== false) pre.scrollTop = pre.scrollHeight;
  }
  const note = row.querySelector('[data-live-note]');
  if (note) note.hidden = !out.truncated;
  const err = row.querySelector('[data-live-err]');
  if (err) {
    err.hidden = !out.error;
    err.textContent = out.error ? `Gagal membaca output: ${out.error}` : '';
  }
}

/** Before chat.js rebuilds a row: the live block's scroll position, to put back afterwards. */
export function saveLiveScroll(node) {
  const pre = node.querySelector('[data-live-out]');
  return pre ? pre.scrollTop : null;
}

/** After a rebuild: follow the newest line, or stay where the user was reading. Then (un)track the row. */
export function afterRowRender(node, msg, savedTop) {
  const pre = node.querySelector('[data-live-out]');
  if (pre) pre.scrollTop = liveOutput.stick.get(msg.taskId) === false && savedTop != null ? savedTop : pre.scrollHeight;
  track(node, msg);
}

// ---------- which rows to poll ----------

function track(node, msg) {
  const obs = liveOutput.observer;
  if (!obs) return;
  if (isLiveShell(msg) && state.active !== DEMO_ID && !liveOutput.outputs.get(msg.taskId)?.dead) {
    obs.observe(node);
  } else {
    obs.unobserve(node);
    liveOutput.visible.delete(msg.id);
    if (msg.taskId && !isLiveShell(msg)) forget(msg.taskId);
  }
}

/** The command ended: its final output comes with the row itself now. */
function forget(taskId) {
  liveOutput.outputs.delete(taskId);
  liveOutput.stick.delete(taskId);
}

function schedule(delay = POLL_MS) {
  clearTimeout(liveOutput.timer);
  liveOutput.timer = null;
  if (!liveOutput.visible.size || document.hidden) return;
  liveOutput.timer = setTimeout(pollVisible, delay);
}

async function pollVisible() {
  liveOutput.timer = null;
  const project = state.active;
  const reads = [];
  for (const id of [...liveOutput.visible]) {
    const msg = msgById(id);
    if (!isLiveShell(msg) || !rowOf(id)) {
      liveOutput.visible.delete(id);
      continue;
    }
    if (liveOutput.inflight.has(msg.taskId)) continue;
    reads.push(readOne(project, msg));
  }
  await Promise.all(reads);
  schedule();
}

async function readOne(project, msg) {
  const taskId = msg.taskId;
  liveOutput.inflight.add(taskId);
  const prev = liveOutput.outputs.get(taskId);
  try {
    const out = await fetchTaskOutput(project, taskId);
    liveOutput.outputs.set(taskId, { ...out, error: null, errors: 0 });
  } catch (err) {
    const errors = (prev?.errors ?? 0) + 1;
    liveOutput.outputs.set(taskId, { text: prev?.text ?? '', truncated: prev?.truncated ?? false, error: err.message, errors, dead: errors >= MAX_ERRORS });
  } finally {
    liveOutput.inflight.delete(taskId);
  }
  // The project was switched or the command ended while the read was out: nothing to draw.
  const now = msgById(msg.id);
  if (project !== state.active || !isLiveShell(now)) return;
  if (liveOutput.outputs.get(taskId)?.dead) liveOutput.visible.delete(msg.id);
  paint(rowOf(msg.id), taskId);
}

// ---------- wiring ----------

export function initLiveOutput() {
  const chat = document.querySelector('#chat');
  liveOutput.observer = new IntersectionObserver(
    (entries) => {
      let added = false;
      for (const e of entries) {
        const id = e.target.dataset.id;
        if (e.isIntersecting && e.target.isConnected) {
          if (!liveOutput.visible.has(id)) added = true;
          liveOutput.visible.add(id);
        } else liveOutput.visible.delete(id);
      }
      // A row that just came into view is read right away; otherwise the running timer carries on.
      if (added) schedule(0);
      else if (!liveOutput.visible.size) schedule();
    },
    { root: chat },
  );

  // Scrolling up inside a live block stops following the newest line; back at the bottom, it follows again.
  chat.addEventListener(
    'scroll',
    (e) => {
      const pre = e.target;
      if (!(pre instanceof HTMLElement) || !pre.matches('[data-live-out]')) return;
      const msg = msgById(pre.closest('[data-id]')?.dataset.id);
      if (msg?.taskId) liveOutput.stick.set(msg.taskId, nearBottom(pre, 16));
    },
    true, // scroll doesn't bubble: listen in the capture phase
  );

  // A hidden tab doesn't poll; coming back reads right away.
  document.addEventListener('visibilitychange', () => (document.hidden ? clearTimeout(liveOutput.timer) : schedule(0)));
}

/** Another project opened: its rows are drawn from scratch, nothing of the old one is polled. */
export function resetLiveOutput() {
  liveOutput.visible.clear();
  liveOutput.observer?.disconnect();
  clearTimeout(liveOutput.timer);
  liveOutput.timer = null;
}
