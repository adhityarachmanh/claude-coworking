// Who is on the team (👥 Kelola tim): the active roles and the built-in role catalog, as the server sends them
// in its config (`config.team`, see src/role-catalog.js). The office, team strip and dialogs read it from here.
import { CAST, ROLE_ORDER } from './cast.js';

export const LEAD = 'claude';
/** The team before the catalog existed (12 roles; regression reference). */
export const CLASSIC_TEAM = Object.freeze(['pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'qa', 'security', 'devops', 'writer', 'freelancer']);
/**
 * Default team until the server says otherwise: every catalog role (17) except opt-in ones marked `defaultOff`
 * (none today). Mirrors DEFAULT_ENABLED in src/role-catalog.js.
 */
export const DEFAULT_TEAM = Object.freeze([...CLASSIC_TEAM, 'mobile', 'data', 'support', 'reviewer', 'compliance']);
const GENERALIST = 'freelancer';
// Look of a catalog role whose character is not drawn yet (cast.js has no entry for it): the generalist's.
const PLACEHOLDER_COLOR = '#8b98a9';

export const roster = { enabled: [...DEFAULT_TEAM], catalog: [], max: 17 };

export const isOnTeam = (id) => id === LEAD || roster.enabled.includes(id);

/** "↺ Tim bawaan": from the server's catalog (roles not marked defaultOff, locked ones always), else DEFAULT_TEAM. */
export function defaultTeam() {
  if (!roster.catalog.length) return [...DEFAULT_TEAM];
  return roster.catalog.filter((r) => r.locked || !r.defaultOff).map((r) => r.id);
}

/** The Lead first, then the active roles in the office's usual order (team strip, rename dialog, confetti…). */
export const teamOrder = () => [...ROLE_ORDER.filter(isOnTeam), ...roster.enabled.filter((id) => !ROLE_ORDER.includes(id))];

/**
 * Who does a role's work in this team (an old event can name a role that is now off): the role itself, else the
 * first active role along its catalog fallback chain, else the generalist, else the Lead. Mirrors resolveRole
 * in src/role-catalog.js.
 */
export function resolveRole(role) {
  if (!role || isOnTeam(role)) return role;
  const byId = new Map(roster.catalog.map((r) => [r.id, r]));
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return null;
    seen.add(id);
    for (const next of byId.get(id)?.fallback ?? []) {
      if (isOnTeam(next)) return next;
      const deeper = walk(next);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(role) ?? (isOnTeam(GENERALIST) ? GENERALIST : LEAD);
}

/** Every catalog role has a CAST entry, so nothing that prints a name or draws a person can crash. */
function ensureCast(catalog) {
  for (const role of catalog) {
    if (CAST[role.id]) continue;
    CAST[role.id] = { name: role.name, title: role.title, color: PLACEHOLDER_COLOR, look: { ...CAST[GENERALIST].look } };
  }
}

/** Applies `config.team` from the server. Returns true when the set of active roles changed. */
export function setRoster(team) {
  if (!team || !Array.isArray(team.enabled)) return false;
  if (Array.isArray(team.catalog)) {
    roster.catalog = team.catalog;
    ensureCast(team.catalog);
  }
  if (Number.isFinite(team.max)) roster.max = team.max;
  const known = team.enabled.filter((id) => typeof id === 'string' && id !== LEAD && CAST[id]);
  if (known.join() === roster.enabled.join()) return false;
  roster.enabled = known;
  return true;
}
