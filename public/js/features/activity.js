// Activity tab: the office event log of the active project, grouped into one row per agent (a "run") instead of
// one row per tool call. A single ticker keeps the duration and the "waiting / slow" label honest without
// redrawing the list every second.
import { $, escapeHtml } from '../core/dom.js';
import { time } from '../core/format.js';
import { state } from '../core/state.js';
import { RECENT_DONE_MS, fmtRun, groupRuns, runMarkup } from '../core/agent-runs.js';
import { roleColor, roleName } from '../office/cast.js';

// ---------- activity ----------

const KIND_ICON = {
  prompt: '💬',
  delegate: '➜',
  agent_stop: '✓',
  tool_start: '•',
  tool_fail: '✗',
  ask: '✋',
  ask_done: '👍',
  stop: '🎉',
  error: '⚠',
  say: '💭',
  tests: '🧪',
  huddle: '🗣',
};

const MAX_RUNS = 40;
const view = {
  expanded: new Map(), // run key -> the user's explicit open/closed choice
  folded: new Set(), // finished runs older than RECENT_DONE_MS that were already re-rendered once
};

/** The turn is still producing events: the newest run is live (not "done"). */
function busyNow() {
  const st = state.statuses[state.active] ?? {};
  const working = Object.keys(st.working ?? {}).length > 0;
  const background = (st.tasks ?? []).some((t) => t?.status === 'running' || t?.status === 'pending');
  return Boolean(st.busy || st.cliBusy || working || background);
}

/** The roles that still hold an open tool call or agent: the authoritative liveness for a background run. */
function workingNow() {
  return new Set(Object.keys(state.statuses[state.active]?.working ?? {}));
}

function runsNow(now = Date.now()) {
  // Only the kinds the flat list used to show: think/board/tool_end updates are not steps of their own.
  const events = (state.events[state.active] ?? []).filter((evt) => KIND_ICON[evt.kind]);
  return groupRuns(events, { now, busy: busyNow(), working: workingNow() }).slice(0, MAX_RUNS);
}

/** Coalesces a burst of events into one render: the list is rebuilt, not patched step by step. */
let scheduled = null;
function scheduleActivity() {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    renderActivity();
  }, 50);
}

export function appendActivity(evt) {
  if (!KIND_ICON[evt.kind]) return;
  scheduleActivity();
}

export function renderActivity() {
  const list = $('#activity');
  if (!list) return;
  const runs = runsNow();
  if (!runs.length) {
    list.innerHTML = '<li class="activity-empty">Belum ada aktivitas di project ini.</li>';
    return;
  }
  // Keep only live keys: an old project's expanded/folded choices must not grow forever.
  const keys = new Set(runs.map((run) => run.key));
  for (const key of view.expanded.keys()) if (!keys.has(key)) view.expanded.delete(key);
  for (const key of view.folded) if (!keys.has(key)) view.folded.delete(key);
  // A burst of events must not steal the keyboard from a header the user is tabbing through.
  const active = document.activeElement;
  const focusedKey = active?.closest?.('#activity [data-run]')?.dataset.run ?? null;
  const focusedToggle = Boolean(active?.closest?.('#activity [data-run-toggle]'));
  const scroll = list.scrollTop;
  list.innerHTML = runMarkup(runs, {
    now: Date.now(),
    expanded: view.expanded,
    recentMs: RECENT_DONE_MS,
    roleName,
    roleColor,
    time,
    escapeHtml,
    iconFor: (kind) => KIND_ICON[kind] ?? '',
  });
  list.scrollTop = scroll;
  if (focusedKey && focusedToggle) list.querySelector(`[data-run="${focusedKey}"] [data-run-toggle]`)?.focus({ preventScroll: true });
}

/**
 * Updates the live clocks and status labels in place. A finished run is re-rendered exactly once when its grace
 * window ends, so it folds without a second render on every tick.
 */
export function paintActivityClocks() {
  const list = $('#activity');
  if (!list || list.hidden) return;
  const now = Date.now();
  const runs = new Map(runsNow(now).map((run) => [run.key, run]));
  let refold = false;
  for (const item of list.querySelectorAll('[data-run]')) {
    const run = runs.get(item.dataset.run);
    if (!run) {
      refold = true;
      continue;
    }
    if (item.dataset.status !== run.status) item.dataset.status = run.status;
    const clock = item.querySelector('[data-clock]');
    const nextClock = fmtRun(run.elapsedMs);
    if (clock && clock.textContent !== nextClock) clock.textContent = nextClock;
    const stateEl = item.querySelector('[data-state]');
    if (stateEl && stateEl.textContent !== run.stateText) stateEl.textContent = run.stateText;
    if (run.status === 'done' && !view.folded.has(run.key) && now - run.lastAt >= RECENT_DONE_MS) {
      view.folded.add(run.key);
      refold = true;
    }
  }
  if (refold) renderActivity();
}

// One ticker for the whole tab: text and dataset writes only, never a full redraw (except the fold above).
setInterval(paintActivityClocks, 1000);

// One delegated listener for every run header (the list is rebuilt often, so the listener must not live on a row).
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('#activity [data-run-toggle]');
  if (!button) return;
  const key = button.closest('[data-run]')?.dataset.run;
  if (!key) return;
  const open = button.getAttribute('aria-expanded') === 'true';
  view.expanded.set(key, !open);
  renderActivity();
  document.querySelector(`#activity [data-run="${key}"] [data-run-toggle]`)?.focus();
});
