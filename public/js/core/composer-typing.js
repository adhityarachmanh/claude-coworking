// The one-line "still working" text in the composer, as pure rules (public/js/core/composer-typing.js).
// The order of the checks is the priority: the first true state wins, so a busy turn never shows the CLI
// line and plan preparation never hides behind compaction.
import { SLOW_MS } from './agent-runs.js';

/** " · 2 mnt" once a turn has been running for a while: a long job must not look like a stuck one. */
const elapsedSuffix = (busyMs) => (busyMs >= SLOW_MS ? ` · ${Math.floor(busyMs / 60_000)} mnt` : '');

/**
 * Text for the typing row, or '' when nothing is running (the composer hides the row).
 *
 * Adhitron reads as ONE app, so the row never names an engine: a terminal process is simply "AI (terminal)".
 *
 * @param {object} s
 * @param {boolean} [s.classifying] Auto model/effort classifier is still deciding.
 * @param {'build'|'revisi'|string|null} [s.planPreparing] The plan step still being prepared.
 * @param {boolean} [s.compacting] The conversation is being compacted.
 * @param {boolean} [s.busy] A turn is running in the office.
 * @param {boolean} [s.cliBusy] A CLI process is running in the project's terminal.
 * @param {number} [s.busyMs] How long the current turn has been running (0 = just started).
 */
export function typingText({ classifying, planPreparing, compacting, busy, cliBusy, busyMs = 0 } = {}) {
  if (classifying) return 'Menentukan effort…';
  if (planPreparing === 'build') return 'Menentukan model & effort…';
  if (planPreparing === 'revisi') return 'Menyiapkan revisi…';
  if (compacting) return '⏳ Memadatkan konteks percakapan…';
  if (busy) return `Tim sedang bekerja…${elapsedSuffix(busyMs)}`;
  if (cliBusy) return `AI (terminal) sedang bekerja…${elapsedSuffix(busyMs)}`;
  return '';
}
