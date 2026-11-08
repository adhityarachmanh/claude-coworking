// Global concurrency governor: how many projects may run a turn at the same time on this laptop.
// Turns are expensive (one Claude Code/OpenCode process each), so the app can hold the extra ones back while the
// user sees which projects are already working. `0` means no limit. Client-side CLI turns (status.cliBusy) do not
// count: the server does not start or stop them, so they must never block a web turn forever.
//
// The setting lives in state.json as `persisted.maxConcurrent`; `checkTurn()` is the single authority for whether a
// new turn may start (direct prompts, /compact, handoff, the queue). A message sent while the same project is busy
// always passes: it joins the turn already running instead of starting another one.

export const MAX_CONCURRENT_CAP = 8;
export const DEFAULT_MAX_CONCURRENT = 3;

/**
 * A stored limit: an integer 0…8, else the default (3). 0 = no limit; anything malformed or missing (an older
 * state.json) is the default, never "unlimited" by accident.
 */
export function cleanMaxConcurrent(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw <= MAX_CONCURRENT_CAP ? raw : DEFAULT_MAX_CONCURRENT;
}

/** The limit this hub runs with. */
export function maxConcurrentOf(hub) {
  return cleanMaxConcurrent(hub?.persisted?.maxConcurrent);
}

/** Project ids with a server-run turn in progress (`status.busy`; CLI-only turns are left out). */
export function activeProjects(hub) {
  const ids = [];
  for (const [id, rt] of hub?.runtime ?? []) if (rt?.status?.busy === true) ids.push(id);
  return ids;
}

export function activeCount(hub) {
  return activeProjects(hub).length;
}

/** True when starting one more turn would pass the limit (a limit of 0 is never over capacity). */
export function overCapacity(hub) {
  const limit = maxConcurrentOf(hub);
  return limit > 0 && activeCount(hub) >= limit;
}

/** The busy projects as the browser sees them in the refusal (`{id, name}`), for the message. */
function activeList(hub) {
  return activeProjects(hub).map((id) => ({ id, name: hub?.projects?.get?.(id)?.name ?? id }));
}

/**
 * Whether a new turn may start in `projectId` right now.
 * @returns {null | { status: 429, body: { error: string, code: 'concurrency', limit: number,
 *   active: Array<{ id: string, name: string }> } }}  null = allowed
 */
export function checkTurn(hub, projectId, session) {
  // A follow-up to the turn already running in this project is not a new turn: it always goes through.
  if (session?.busy || session?.turnActive?.()) return null;
  const limit = maxConcurrentOf(hub);
  if (limit <= 0) return null;
  const running = activeList(hub);
  if (running.length < limit) return null;
  const shown = running.slice(0, 3).map((p) => p.name).join(', ');
  const more = running.length > 3 ? ', …' : '';
  return {
    status: 429,
    body: {
      error: `⏸ Batas ${limit} giliran bersamaan tercapai (sedang berjalan: ${shown}${more}). Tunggu salah satu selesai, atau ubah batas di ⚙ Pengaturan → Umum.`,
      code: 'concurrency',
      limit,
      active: running,
    },
  };
}
