// Pure grouping of office events into "agent runs": one row per agent that worked, instead of one row per tool
// call. No DOM and no I/O, so the activity panel and its tests share exactly one implementation.
//
// A run belongs to a TURN (a `prompt` event starts one) and to a ROLE: two agents working in parallel keep their
// own row, and a run from an earlier turn is never brought back to life by the next turn. Status is derived from
// the age of the newest step plus the turn state and the roles that still hold open work: "stuck" is never
// assumed, because an agent waiting on a slow command looks exactly like an agent thinking.

export const STALL_MS = 45_000; // no new step for this long: say "waiting", not spinner-only
export const SLOW_MS = 120_000; // ... and after this: "slow, still running" if the role still holds work
export const RECENT_DONE_MS = 5_000; // a finished run stays open this long before folding

/** `m:ss` — the same clock the task monitor uses. Negative values (a client clock that moved back) read as 0:00. */
export function fmtRun(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Groups office events (oldest first, as the hub stores them) into runs — one per role per turn, newest activity
 * first.
 * @param {Array<{ id?: number|string, ts?: number, role?: string, kind?: string }>} events
 * @param {{ now?: number, busy?: boolean, working?: Set<string> }} [options]
 *   busy: something is still running somewhere in this project (including background agents);
 *   working: the roles that still hold open tool calls / agents (status.working) — authoritative liveness.
 * @returns {Array<{ key: string, role: string, events: object[], steps: number, startedAt: number, lastAt: number,
 *   status: 'running'|'waiting'|'slow'|'done', elapsedMs: number, stateText: string }>}
 */
export function groupRuns(events = [], { now = Date.now(), busy = false, working = new Set() } = {}) {
  // 1. Split into turns (a `prompt` event opens one) and, inside a turn, into one run per role.
  const turns = [];
  let turn = null;
  for (const evt of events) {
    if (!evt?.role) continue;
    if (!turn || evt.kind === 'prompt') {
      turn = { index: turns.length, runs: new Map() };
      turns.push(turn);
    }
    const ts = Number(evt.ts) || 0;
    let run = turn.runs.get(evt.role);
    if (!run) {
      run = { key: `${turn.index}:${evt.role}`, role: evt.role, events: [], startedAt: ts, lastAt: ts };
      turn.runs.set(evt.role, run);
    }
    run.events.push(evt);
    run.lastAt = ts;
  }
  const lastTurn = turns.length - 1;
  const out = [];
  for (const current of turns) {
    for (const run of current.runs.values()) {
      const stopped = run.events.some((evt) => evt.kind === 'agent_stop');
      const holdsWork = working.has(run.role);
      const age = Math.max(0, now - run.lastAt);
      // Live only for the current turn while the project is busy, or while the role still holds work of its own
      // (a background agent outliving its turn). Everything else is finished — never resurrected by a new turn.
      const live = !stopped && ((current.index === lastTurn && busy && (age < SLOW_MS || holdsWork)) || holdsWork);
      const elapsedMs = Math.max(0, (live ? now : run.lastAt) - run.startedAt);
      let status;
      let stateText;
      if (!live) {
        status = 'done';
        stateText = `selesai · ${fmtRun(elapsedMs)}`;
      } else if (age < STALL_MS) {
        status = 'running';
        stateText = `berjalan ${fmtRun(elapsedMs)}`;
      } else if (age < SLOW_MS) {
        status = 'waiting';
        stateText = `menunggu ${Math.floor(age / 1000)} dtk`;
      } else {
        status = 'slow';
        stateText = `lama, masih jalan · ${Math.floor(elapsedMs / 60_000)} mnt`;
      }
      out.push({ ...run, steps: run.events.length, status, elapsedMs, stateText });
    }
  }
  // Newest activity first: a long run that is still working stays above a short run that just finished.
  return out.sort((a, b) => b.lastAt - a.lastAt || b.startedAt - a.startedAt);
}

/**
 * The finished tasks the ⧗ monitor shows: at most `max` of them unless the user asked for all.
 * @template T
 * @param {T[]} tasks finished tasks, newest first (as the caller already sorts them)
 * @param {{ showAll?: boolean, max?: number }} [options]
 * @returns {{ rows: T[], hiddenCount: number }}
 */
export function donePreview(tasks = [], { showAll = false, max = 3 } = {}) {
  const all = Array.isArray(tasks) ? tasks : [];
  if (showAll) return { rows: all.slice(), hiddenCount: 0 };
  const rows = all.slice(0, Math.max(0, max));
  return { rows, hiddenCount: Math.max(0, all.length - rows.length) };
}

/** One step row: the same markup the flat list used before grouping (time, dot, role, icon, text). */
function stepMarkup(evt, { roleName, roleColor, time, escapeHtml, iconFor }) {
  const text =
    evt.kind === 'delegate'
      ? `${evt.from && evt.from !== 'claude' ? `dari ${roleName(evt.from)} ` : ''}→ ${evt.agentType ?? ''}: ${evt.label ?? ''}`
      : evt.kind === 'say'
        ? (evt.text ?? '')
        : (evt.label ?? '');
  return `<li><time>${escapeHtml(time(evt.ts))}</time><span class="dot" style="background:${escapeHtml(roleColor(evt.role))}"></span><span><b>${escapeHtml(roleName(evt.role))}</b> ${escapeHtml(iconFor(evt.kind))} ${escapeHtml(text)}</span></li>`;
}

/**
 * HTML for the grouped activity list, newest run first. Collapsed by default when a run is finished; the newest
 * live run stays open, and a finished run stays open for `recentMs` so its last step is readable.
 * @param {ReturnType<typeof groupRuns>} runs
 * @param {{ now?: number, expanded?: Map<string, boolean>, recentMs?: number, roleName: Function, roleColor: Function,
 *   time: Function, escapeHtml: Function, iconFor: Function }} options
 * @returns {string}
 */
export function runMarkup(
  runs = [],
  {
    now = Date.now(),
    expanded = new Map(),
    recentMs = RECENT_DONE_MS,
    roleName = (role) => String(role ?? ''),
    roleColor = () => 'transparent',
    time = () => '',
    escapeHtml = (value) => String(value),
    iconFor = () => '',
  } = {},
) {
  return runs
    .map((run, index) => {
      const open = expanded.has(run.key)
        ? Boolean(expanded.get(run.key))
        : run.status !== 'done'
          ? index === 0
          : now - run.lastAt < recentMs;
      const key = escapeHtml(run.key);
      // Closed runs render no steps at all: the DOM stays small even with hundreds of tool calls of history.
      const newestFirst = [...run.events].reverse();
      const steps = open ? newestFirst.slice(0, 60).map((evt) => stepMarkup(evt, { roleName, roleColor, time, escapeHtml, iconFor })) : [];
      if (open && newestFirst.length > 60) steps.push(`<li class="run-more muted">… ${newestFirst.length - 60} langkah lama tidak ditampilkan</li>`);
      return `<li class="run" data-run="${key}" data-role="${escapeHtml(run.role)}" data-status="${run.status}">
  <button class="run-head" type="button" data-run-toggle aria-expanded="${open}" aria-controls="run-${key}">
    <span class="dot" style="background:${escapeHtml(roleColor(run.role))}"></span>
    <b>${escapeHtml(roleName(run.role))}</b>
    <span class="run-meta">${run.steps} langkah · <span data-clock="${key}">${fmtRun(run.elapsedMs)}</span></span>
    <span class="run-state" data-state="${key}">${escapeHtml(run.stateText)}</span>
    <span class="chev" aria-hidden="true">▾</span>
  </button>
  <ol id="run-${key}" class="run-steps"${open ? '' : ' hidden'}>
    ${steps.join('')}
  </ol>
</li>`;
    })
    .join('');
}
