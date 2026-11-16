// The one-line "still working" text in the composer, as pure rules (public/js/core/composer-typing.js).
// The order of the checks is the priority: the first true state wins, so a busy turn never shows the CLI
// line and plan preparation never hides behind compaction.
import { SLOW_MS } from './agent-runs.js';

/** " · 2 mnt" once a turn has been running for a while: a long job must not look like a stuck one. */
const elapsedSuffix = (busyMs) => (busyMs >= SLOW_MS ? ` · ${Math.floor(busyMs / 60_000)} mnt` : '');

/**
 * Text for the typing row, or '' when nothing is running (the composer hides the row).
 *
 * The CLI label follows the project's engine: an OpenCode project must never read "Claude Code", or the
 * user thinks a CLI that is not even logged in is the one working.
 *
 * @param {object} s
 * @param {boolean} [s.classifying] Auto model/effort classifier is still deciding.
 * @param {'build'|'revisi'|string|null} [s.planPreparing] The plan step still being prepared.
 * @param {boolean} [s.compacting] The conversation is being compacted.
 * @param {boolean} [s.busy] A turn is running in the office.
 * @param {boolean} [s.cliBusy] A CLI process of the project's engine is running.
 * @param {string} [s.engine] Project engine ('claude' / 'opencode'); used only for the CLI label.
 * @param {number} [s.busyMs] How long the current turn has been running (0 = just started).
 * @param {(engine: string) => string} [engineLabel] Engine → display name.
 */
export function typingText({ classifying, planPreparing, compacting, busy, cliBusy, engine, busyMs = 0 } = {}, engineLabel = (e) => String(e ?? 'Claude Code')) {
  if (classifying) return 'Menentukan effort…';
  if (planPreparing === 'build') return 'Menentukan model & effort…';
  if (planPreparing === 'revisi') return 'Menyiapkan revisi…';
  if (compacting) return '⏳ Memadatkan konteks percakapan…';
  if (busy) return `Tim sedang bekerja…${elapsedSuffix(busyMs)}`;
  if (cliBusy) return `${engineLabel(engine)} (terminal) sedang bekerja…${elapsedSuffix(busyMs)}`;
  return '';
}
