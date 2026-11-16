// When the phone should keep its screen awake, as pure rules (public/js/core/wake-lock-rules.js).
//
// Watching a long turn from a phone is the remote use case this exists for: without it the screen sleeps after a
// minute and the user misses the end of the turn (and the approval that comes with it). The lock is held only while
// something is actually running AND the page is visible — never in a pocket, never while idle (battery first).

/**
 * @param {{ busy?: boolean, cliBusy?: boolean, planPreparing?: boolean|string|null, compacting?: boolean }} st
 * @param {{ hidden?: boolean }} [view]
 * @returns {boolean}
 */
export function shouldHoldWake(st = {}, { hidden = false } = {}) {
  if (hidden) return false;
  return Boolean(st?.busy || st?.cliBusy || st?.planPreparing || st?.compacting);
}
