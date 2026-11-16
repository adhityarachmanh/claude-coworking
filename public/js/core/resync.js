// Ask the live stream for a fresh snapshot, without importing the stream itself (that would make a feature →
// stream → feature cycle). The stream registers its resync here once at connect.
let request = null;

/** Register the stream's resync function (called once, from core/stream.js). */
export function onResync(fn) {
  request = typeof fn === 'function' ? fn : null;
}

/** Refresh the snapshot now: the user tapped the "no news" chip, or the page came back from a long sleep. */
export function requestResync() {
  request?.();
}
