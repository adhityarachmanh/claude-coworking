// ⚠ Stuck detector, the pure part (no DOM, no imports: unit-tested in Node). Decides when a running tool row or
// delegation looks stuck (quiet output / no activity / running very long), what its chip says, which episodes
// still need a notification and when to read more data. All times are milliseconds on the browser's clock;
// `now` is always passed in, so tests never wait.
//
// A chip is only a hint: nothing here ever stops anything (quiet builds are legitimate).

export const STUCK = Object.freeze({
  TOOL_QUIET_MS: 3 * 60_000, // a running tool whose output hasn't changed this long
  TOOL_LONG_MS: 10 * 60_000, // any tool running this long (also those whose output can't be read)
  DELEGATE_QUIET_MS: 5 * 60_000, // a delegation with no new transcript entries / tool calls this long
  TICK_MS: 15_000, // how often the browser re-evaluates (chips count in whole minutes)
  OUTPUT_POLL_MS: 30_000, // task-output for a running shell row that isn't on screen (live-output reads visible ones)
  OUTPUT_POLL_FROM_MS: 2 * 60_000, // ...only once it has run this long (it can't be quiet for 3 min before that)
  OUTPUT_FRESH_MS: 90_000, // an output read older than this says nothing about "quiet now"
  DETAIL_POLL_MS: 30_000, // task-detail for a running delegation (never more often; visible page only)
  DETAIL_POLL_FROM_MS: 60_000, // ...only once it has been quiet this long by the cheaper signals
  OUTPUT_POLLS_PER_TICK: 3, // own task-output reads per tick, all projects together (a cap, not a schedule)
  SLEEP_GAP_MS: 5 * 60_000, // a tick this late means the laptop slept / the tab was frozen: that time doesn't count
  EPISODE_GRACE_MS: 60_000, // a stuck episode only ends after this long unstuck (no re-notify on flapping)
});

const MIN = 60_000;
const minutes = (ms) => Math.max(1, Math.floor(ms / MIN));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- clocks ----------

/**
 * Browser clock minus server clock, from (browserNow - msg.ts) samples of messages that arrived live. Network delay
 * only ever adds, so the smallest sample is the best estimate. No samples → 0 (same machine / synced clocks).
 */
export function clockSkew(samples) {
  const xs = (samples ?? []).filter((x) => num(x) !== null);
  return xs.length ? Math.min(...xs) : 0;
}

/** A server timestamp on the browser's clock; never in the future. null stays null. */
export function toLocal(serverTs, skew, now) {
  const ts = num(serverTs);
  return ts === null ? null : Math.min(now, ts + (num(skew) ?? 0));
}

// ---------- tool rows ----------

/**
 * Output tracking of one shell row. `prev`: { sig, changedAt, readAt } | null. `text`: the output just read.
 * First read: empty output means "quiet since the start"; any output means "changed just now" (unknown when).
 */
export function trackOutput(prev, text, now, startedAt) {
  const t = String(text ?? '');
  const sig = `${t.length}:${t.slice(-200)}`;
  if (!prev) return { sig, changedAt: t.trim() ? now : (num(startedAt) ?? now), readAt: now };
  return { sig, changedAt: sig === prev.sig ? prev.changedAt : now, readAt: now };
}

/**
 * Is a running tool row stuck? `startedAt`: when it began (browser clock). `elapsedMs`: Claude Code's own
 * "running for" (a floor, immune to clock skew). `output`: trackOutput's result, or null when it can't be read.
 * → null | { reason: 'quiet' | 'long', minutes }
 */
export function toolStuck({ startedAt, elapsedMs = 0, output = null, now }) {
  const start = num(startedAt);
  const running = Math.max(start === null ? 0 : now - start, num(elapsedMs) ?? 0);
  const fresh = output && num(output.readAt) !== null && now - output.readAt <= STUCK.OUTPUT_FRESH_MS;
  const quiet = fresh && num(output.changedAt) !== null ? now - output.changedAt : 0;
  if (quiet >= STUCK.TOOL_QUIET_MS) return { reason: 'quiet', minutes: minutes(Math.min(quiet, running || quiet)) };
  if (running >= STUCK.TOOL_LONG_MS) return { reason: 'long', minutes: minutes(running) };
  return null;
}

/** Should a shell row's output be read now by the detector itself (not on screen → live-output doesn't read it)? */
export function shouldPollOutput({ runningMs, lastPollAt, now, onScreen }) {
  if (onScreen || runningMs < STUCK.OUTPUT_POLL_FROM_MS) return false;
  return num(lastPollAt) === null || now - lastPollAt >= STUCK.OUTPUT_POLL_MS;
}

export function toolChipText(v) {
  return v.reason === 'quiet' ? `⚠ Tidak ada output ${v.minutes} mnt — mungkin macet` : `⚠ Berjalan ${v.minutes} mnt — mungkin macet`;
}

// ---------- delegations ----------

/** The newest activity: the latest of the known moments (nulls ignored). */
export const latest = (...ts) => ts.map(num).filter((x) => x !== null).reduce((a, b) => Math.max(a, b), -Infinity);

/** → null | { reason: 'idle', minutes } once nothing happened for DELEGATE_QUIET_MS. */
export function delegateStuck({ lastActivityAt, now }) {
  const last = num(lastActivityAt);
  if (last === null) return null;
  const quiet = now - last;
  return quiet >= STUCK.DELEGATE_QUIET_MS ? { reason: 'idle', minutes: minutes(quiet) } : null;
}

/** Should task-detail be read for a running delegation now? At most every DETAIL_POLL_MS, page visible only. */
export function shouldPollDetail({ quietMs, lastPollAt, now, visible }) {
  if (!visible || quietMs < STUCK.DETAIL_POLL_FROM_MS) return false;
  return num(lastPollAt) === null || now - lastPollAt >= STUCK.DETAIL_POLL_MS;
}

/** What in a task-detail answer counts as "something happened" (new steps, transcript written). */
export const detailSig = (d) => (d ? `${d.updatedAt ?? ''}|${d.steps?.length ?? 0}|${d.steps?.at(-1)?.ts ?? ''}|${d.steps?.at(-1)?.status ?? ''}` : '');

export function delegateChipText(roleName, v) {
  return `⚠ ${roleName} tidak ada aktivitas ${v.minutes} mnt`;
}

// ---------- notifications ----------

/**
 * One notification per stuck episode. Keys are `project|role` (two stuck rows of one person = one episode).
 * `episodes`: Map key -> last time it was seen stuck. `stuckKeys`: keys stuck right now. An episode ends only after
 * EPISODE_GRACE_MS without being stuck, so a verdict that flickers off and on does not notify twice.
 * → { fire: keys to notify now, next: the new Map }.
 */
export function stuckEpisodes(episodes, stuckKeys, now) {
  const next = new Map();
  for (const [k, at] of episodes) if (now - at < STUCK.EPISODE_GRACE_MS) next.set(k, at);
  const fire = [];
  for (const k of new Set(stuckKeys)) {
    if (!next.has(k)) fire.push(k);
    next.set(k, now);
  }
  return { fire, next };
}

/** Milliseconds the detector should ignore since the previous tick (laptop asleep, tab frozen), else 0. */
export function sleepGap(lastTickAt, now) {
  const last = num(lastTickAt);
  return last !== null && now - last > STUCK.SLEEP_GAP_MS ? now - last - STUCK.TICK_MS : 0;
}
