// The two ways a project can work, for Claude Code and OpenCode alike: Plan (read-only, propose first) and Build
// (change files; shell/network still ask). One vocabulary in the UI and in state.json, while each engine keeps its
// own mechanism underneath. Legacy values are migrated once and never interpreted again (see migrateMode).
export const MODES = Object.freeze(['build', 'plan']);
export const DEFAULT_MODE = 'build';

export const MODE_CHOICE_MESSAGE = 'Mode izin lama (Jangan tanya) tidak lagi tersedia. Pilih Plan atau Build dulu sebelum melanjutkan.';

/** A value the app may store as-is. Anything else is refused, never coerced on the write path. */
export const isMode = (value) => value === 'build' || value === 'plan';

/** Display/back-compat normalization: legacy and unknown values read as Build (never as a weaker permission). */
export function normalizeMode(value) {
  return value === 'plan' ? 'plan' : 'build';
}

/**
 * One-way migration of a stored mode.
 *   plan                          -> plan
 *   manual / acceptEdits / auto   -> build (behavior preserved as auto-edit) + legacyMode for the record
 *   dontAsk                       -> plan + pending choice: it must never become looser on its own
 *   build / plan / missing/other  -> null (nothing to do; unknown values are never touched here)
 * @returns {null | { mode: 'build'|'plan', legacyMode?: string, pending?: true }}
 */
export function migrateMode(value) {
  if (value === 'plan' || value === 'build') return null; // already canonical
  if (value === 'manual' || value === 'acceptEdits' || value === 'auto') return { mode: 'build', legacyMode: value };
  if (value === 'dontAsk') return { mode: 'plan', legacyMode: 'dontAsk', pending: true };
  return null;
}

/** What Claude Code's `--permission-mode` / `set_permission_mode` get: Plan, or auto-edit for Build. */
export function claudePermissionMode(mode) {
  return mode === 'plan' ? 'plan' : 'acceptEdits';
}

/** Claude Code reports its CLI name (`default`, `acceptEdits`...) - the app's vocabulary is only build/plan. */
export function appModeFromCli(mode) {
  if (mode === 'plan') return 'plan';
  // A CLI started outside the app (default/auto/dontAsk) is shown as Build; settings are not rewritten from it.
  return 'build';
}

/** The OpenCode agent for a mode; Build may use the agent picked in turn settings. */
export const agentForMode = (mode, agent = '') => (mode === 'plan' ? 'plan' : agent || 'build');
