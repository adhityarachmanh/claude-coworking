// 💰 Batas pemakaian global: POST /api/budget (the limits + what was spent today / this week / this month) and
// POST /api/budget/save (set or clear a limit, stored in state.json and broadcast to open pages).
//
// Laptop + Tailscale only: there is deliberately no entry for these paths in the plain-HTTP WiFi read allowlist
// (src/remote.js wifiAllows), so server.js refuses a read-only phone with 403 before a handler runs. The numbers
// say what the account spends, and a sniffable device must not be able to change a limit (default deny).
import { recordBudget } from '../budget-audit.js';
import { budgetView, cleanBudgetPatch, grantBudgetOverride } from '../budget.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/budget', state, { maxBody: 1024 });
  router.post('/api/budget/save', save, { maxBody: 1024 });
  router.post('/api/budget/override', override, { maxBody: 1024 });
}

/** A project id from the body, or null for the global budget; refused for an unknown/demo project. */
function projectOf(hub, body) {
  const id = typeof body?.projectId === 'string' ? body.projectId : '';
  if (!id) return null;
  const project = hub.projects.get(id);
  if (!project || project.virtual) throw Object.assign(new Error('Project tidak ditemukan.'), { status: 404 });
  return id;
}

/** The view now: the limits, the spending of every local window and the note about the ledger's coverage. */
function state({ hub, ledger }, req, res, params, body) {
  try {
    const projectId = projectOf(hub, body);
    return json(res, 200, { budget: { ...budgetView(hub, ledger, Date.now(), projectId), projectId } });
  } catch (err) {
    return json(res, err.status ?? 400, { error: err.message });
  }
}

/**
 * Saves the limits named in the body (any of dailyUsd / weeklyUsd / monthlyUsd; an absent key keeps its stored
 * value, null / '' / 0 turns one off) and answers with the fresh view.
 */
function save({ hub, ledger, device, dataDir }, req, res, params, body) {
  let patch;
  let projectId = null;
  try {
    projectId = projectOf(hub, body);
    patch = cleanBudgetPatch(body);
  } catch (err) {
    return json(res, err.status ?? 400, { error: err.message });
  }
  if (projectId) hub.setProjectBudget(projectId, patch);
  else hub.setBudget(patch);
  if (device) console.log(`Batas pemakaian diubah dari HP "${device.name}"`);
  recordBudget(
    { action: 'save', scope: projectId ? 'project' : 'global', projectId, actor: device?.name ?? 'laptop', detail: Object.entries(patch).map(([key, value]) => `${key}=${value ?? 'off'}`).join(' · ') },
    { dataDir: dataDir ?? hub.dataDir },
  );
  return json(res, 200, { budget: { ...budgetView(hub, ledger, Date.now(), projectId), projectId } });
}

/** Allows exactly one turn despite the hard stop; expires on its own after 5 minutes. */
function override({ hub, device, dataDir }, req, res) {
  const until = grantBudgetOverride(hub);
  recordBudget({ action: 'override', scope: 'global', actor: device?.name ?? 'laptop', detail: 'satu giliran' }, { dataDir: dataDir ?? hub.dataDir });
  return json(res, 200, { ok: true, until });
}
