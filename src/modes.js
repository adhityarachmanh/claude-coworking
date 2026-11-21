// The three ways a project can work, for Claude Code and OpenCode alike: Plan (read-only, propose first), Build
// (change files; shell/network still ask) and Auto (shell/network run without a permission card; explicit deny rules
// and secret files still win). One vocabulary in the UI and in state.json, while each engine keeps its own mechanism
// underneath. Auto's stored value is 'autopilot' so the legacy 'auto' (meaning auto-edit) can never become it.
export const MODES = Object.freeze(['build', 'plan', 'autopilot']);
export const DEFAULT_MODE = 'build';

export const MODE_CHOICE_MESSAGE = 'Mode izin lama (Jangan tanya) tidak lagi tersedia. Pilih Plan atau Build dulu sebelum melanjutkan.';

/** A value the app may store as-is. Anything else is refused, never coerced on the write path. */
export const isMode = (value) => value === 'build' || value === 'plan' || value === 'autopilot';

/** Display/back-compat normalization: legacy and unknown values read as Build (never as a weaker permission). */
export function normalizeMode(value) {
  return value === 'plan' ? 'plan' : value === 'autopilot' ? 'autopilot' : 'build';
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

/** What Claude Code's `--permission-mode` / `set_permission_mode` get: Plan, auto-edit for Build, or the classifier. */
export function claudePermissionMode(mode) {
  return mode === 'plan' ? 'plan' : mode === 'autopilot' ? 'auto' : 'acceptEdits';
}

/** Claude Code reports its CLI name (`default`, `acceptEdits`, `auto`...) - the app maps it back to its own vocabulary. */
export function appModeFromCli(mode) {
  if (mode === 'plan' || mode === 'dontAsk') return 'plan';
  // `auto` is only ever sent by us (`--permission-mode auto`): read it back as our Auto, or the mode would flip to Build.
  if (mode === 'auto') return 'autopilot';
  // A CLI started outside the app (default/acceptEdits) is shown as Build; settings are not rewritten from it.
  return 'build';
}

/**
 * What a CLI permission report means for a project whose process applied `applied`. Auto is only recognised as Auto
 * when the process we launched actually ran with it: a CLI that reports `auto` on its own (a user's
 * `permissions.defaultMode`, or a future CLI default) must never raise a Build/Plan project to the looser Auto.
 */
export function appModeForReported(applied, mode) {
  const next = appModeFromCli(mode);
  return next === 'autopilot' && applied !== 'autopilot' ? 'build' : next;
}

/** The OpenCode agent for a mode; Build may use the agent picked in turn settings. */
export const agentForMode = (mode, agent = '') => (mode === 'plan' ? 'plan' : agent || 'build');
