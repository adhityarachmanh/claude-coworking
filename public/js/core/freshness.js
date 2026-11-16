// Freshness of the live connection, as pure rules: the server pings every 15 s, so "no event for 45 s" means the
// socket is probably half-open (a phone that slept, a tailnet that changed network) even though EventSource still
// reports OPEN. The status line shows the age and offers a tap to resync instead of silently serving stale data.

/** Missed three server pings: treat the stream as stale. */
export const STALE_MS = 45_000;

/**
 * The chip text for a given age, or '' when the connection is fresh (or was never seen).
 * @param {number|null} ageSec seconds since the last event
 * @returns {string}
 */
export function freshnessText(ageSec) {
  if (!Number.isFinite(ageSec) || ageSec < 0) return '';
  if (ageSec < STALE_MS / 1000) return '';
  if (ageSec < 90) return `${Math.round(ageSec)} dtk tanpa kabar`;
  return `${Math.floor(ageSec / 60)} mnt tanpa kabar`;
}
