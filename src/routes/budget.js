// 💰 Batas pemakaian global: POST /api/budget (the limits + what was spent today / this week / this month) and
// POST /api/budget/save (set or clear a limit, stored in state.json and broadcast to open pages).
//
// Laptop + Tailscale only: there is deliberately no entry for these paths in the plain-HTTP WiFi read allowlist
// (src/remote.js wifiAllows), so server.js refuses a read-only phone with 403 before a handler runs. The numbers
// say what the account spends, and a sniffable device must not be able to change a limit (default deny).
import { budgetView, cleanBudgetPatch } from '../budget.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/budget', state, { maxBody: 1024 });
  router.post('/api/budget/save', save, { maxBody: 1024 });
}

/** The view now: the limits, the spending of every local window and the note about the ledger's coverage. */
function state({ hub, ledger }, req, res) {
  return json(res, 200, { budget: budgetView(hub, ledger) });
}

/**
 * Saves the limits named in the body (any of dailyUsd / weeklyUsd / monthlyUsd; an absent key keeps its stored
 * value, null / '' / 0 turns one off) and answers with the fresh view.
 */
function save({ hub, ledger, device }, req, res, params, body) {
  let patch;
  try {
    patch = cleanBudgetPatch(body);
  } catch (err) {
    return json(res, err.status ?? 400, { error: err.message });
  }
  hub.setBudget(patch);
  if (device) console.log(`Batas pemakaian diubah dari HP "${device.name}"`);
  return json(res, 200, { budget: budgetView(hub, ledger) });
}
