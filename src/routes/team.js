// ---------- the active team (👥 Kelola tim) and the team's display names ----------
import { MAX_ACTIVE_ROLES, TeamConfigError, activeAgents, normalizeEnabled, publicCatalog, teamPrompt } from '../role-catalog.js';
import { ROLE_IDS, activeRoles, setActiveRoles } from '../roles.js';
import { appliedOf, json } from './http.js';

export function register(router) {
  router.post('/api/team', saveNames);
  // 👥 Kelola tim: reading the team is allowed over WiFi (src/remote.js); saving it is an action.
  router.post('/api/team/roster', (ctx, req, res) => json(res, 200, teamConfig()));
  router.post('/api/team/roster/save', (ctx, req, res, params, body) => {
    try {
      return json(res, 200, saveTeam(ctx, normalizeEnabled(body.enabled)));
    } catch (err) {
      if (err instanceof TeamConfigError) return json(res, err.status, { error: err.message });
      throw err;
    }
  });
}

function saveNames({ hub }, req, res, params, body) {
  const names = cleanTeamNames(body.names);
  hub.persisted.teamNames = names;
  hub.scheduleSave();
  hub.config = { ...hub.config, teamNames: names };
  hub.broadcast('config', hub.config);
  return json(res, 200, { names });
}

/** What the browser gets: the active role ids (catalog order, Lead excluded) and the built-in catalog. */
export function teamConfig() {
  return { enabled: activeRoles(), catalog: publicCatalog(), max: MAX_ACTIVE_ROLES, lead: 'claude' };
}

/**
 * Switches the team: role mapping, the subagents sent with --agents and the Lead's prompt. Claude Code reads
 * those when it starts, so idle team-mode sessions restart now and busy ones after their turn (reloadSettings).
 */
function saveTeam({ hub, sessions, allAgents }, enabled) {
  const same = enabled.join() === activeRoles().join();
  hub.persisted.team = { enabled };
  hub.scheduleSave();
  if (same) return { ...teamConfig(), applied: 'none' };
  setActiveRoles(enabled);
  sessions.agents = activeAgents(allAgents, enabled);
  sessions.teamPrompt = teamPrompt(enabled, Object.keys(allAgents));
  const applied = [...sessions.sessions.values()].filter((s) => hub.settingsFor(s.id).team).map((s) => s.reloadSettings());
  hub.config = { ...hub.config, team: teamConfig() };
  hub.broadcast('config', hub.config);
  console.log(`Tim diubah: ${enabled.length} role aktif (${enabled.join(', ')})`);
  return { ...teamConfig(), applied: appliedOf(applied) };
}

/** Custom display names per role ("claude" = the lead), validated. Empty → back to the default name. */
export function cleanTeamNames(input) {
  const names = {};
  for (const [role, value] of Object.entries(input && typeof input === 'object' ? input : {})) {
    if (role !== 'claude' && !ROLE_IDS.includes(role)) continue;
    const name = String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
    if (name) names[role] = name;
  }
  return names;
}
