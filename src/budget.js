// 💰 Batas pemakaian global: one spend ceiling per local calendar window (day / week (Monday) / month), measured
// from the token ledger (data/usage.jsonl).
//
// The limits live in state.json (`hub.persisted.budget`, see Hub.cleanBudget/setBudget); the spending is never
// stored: it is summed from the ledger on demand, so every window follows the calendar by itself and a backup
// carries the limits only. Rows without a numeric `costUsd` cannot be priced (OpenCode Go records $0), so each
// window also reports its coverage (`rows` / `known`) instead of pretending the sum is the whole bill.
import { periodStart } from './usage.js';

/** The window a limit can be set for, and the state.json key that holds it. */
export const WINDOW_LIMITS = Object.freeze({ day: 'dailyUsd', week: 'weeklyUsd', month: 'monthlyUsd' });
export const WINDOW_UNITS = Object.freeze(Object.keys(WINDOW_LIMITS));
export const BUDGET_KEYS = Object.freeze(Object.values(WINDOW_LIMITS));
/** A limit in USD, inclusive; 0 / null / '' means off. */
export const BUDGET_MAX_USD = 10000;
/** At or above this share of a limit the window warns; at 100 % it is over. */
export const WARN_RATIO = 0.8;

/** "harian" / "mingguan" / "bulanan", for the validation messages. */
const LIMIT_LABEL = Object.freeze({ dailyUsd: 'harian', weeklyUsd: 'mingguan', monthlyUsd: 'bulanan' });
const WINDOW_LABEL = Object.freeze({ day: 'harian', week: 'mingguan', month: 'bulanan' });
const USD = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdText = (v) => `$${USD.format(v)}`;

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
/** Rounded to cents (the stored precision of every limit). */
export const cents = (v) => Math.round(v * 100) / 100;

/** A budget error whose message is meant for the user (400), like QueueError. */
export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
    this.status = 400;
  }
}

/**
 * A stored budget that still looks right: only a real dollar amount 0.01…10000 survives (rounded to cents),
 * anything else (an older state.json without it, a hand-edited value) is "off". Never throws.
 * @param {unknown} raw
 * @returns {{ dailyUsd: number|null, weeklyUsd: number|null, monthlyUsd: number|null }}
 */
export function cleanLimits(raw) {
  const out = {};
  for (const key of BUDGET_KEYS) {
    const value = raw?.[key];
    out[key] = isNumber(value) && value > 0 && value <= BUDGET_MAX_USD ? cents(value) : null;
  }
  return out;
}

/** True when at least one limit is set (null and 0 both mean off). */
export const hasBudget = (budget) => BUDGET_KEYS.some((key) => isNumber(budget?.[key]) && budget[key] > 0);

/**
 * Validates the body of POST /api/budget/save: only the three keys, each a dollar amount 0…10000 (rounded to
 * cents) or null / '' / 0 to turn that limit off. A key that is absent keeps its stored value (Hub.cleanBudget).
 * @param {unknown} input the request body
 * @returns {{ dailyUsd?: number|null, weeklyUsd?: number|null, monthlyUsd?: number|null }}
 * @throws {BudgetError} 400 with an Indonesian message for anything that is not a valid limit
 */
export function cleanBudgetPatch(input) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) throw new BudgetError('Data batas pemakaian tidak valid.');
  const body = input ?? {};
  const patch = {};
  for (const key of BUDGET_KEYS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null || raw === '') {
      patch[key] = null;
      continue;
    }
    // A form sends a string; a JSON client a number. Anything else (true, {}, 'abc') is refused, never stored.
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim().replace(',', '.')) : NaN;
    if (!Number.isFinite(value)) throw new BudgetError(`Batas ${LIMIT_LABEL[key]} harus berupa angka dolar, atau kosong untuk mematikan.`);
    if (value < 0 || value > BUDGET_MAX_USD) throw new BudgetError(`Batas ${LIMIT_LABEL[key]} harus antara $0 dan $10.000 (0 atau kosong = mati).`);
    const rounded = cents(value);
    patch[key] = rounded > 0 ? rounded : null; // anything below a cent rounds to "off", like 0
  }
  return patch;
}

/**
 * What was spent in each window that contains `now`, from every account's ledger rows (`accountId: 'all'`).
 * `usd` sums the rows that carry a numeric costUsd (`known` of `rows`), so the caller can tell how complete
 * the number is. A missing ledger (a test ctx, a read-only caller) spends 0, never a crash.
 * @param {{ query: (opts: object) => object[] }|null} ledger the UsageLedger
 * @param {number} [now] epoch ms (the windows are local calendar periods, see periodStart)
 * @returns {Record<'day'|'week'|'month', { usd: number, rows: number, known: number }>}
 */
export function spend(ledger, now = Date.now(), projectId = null) {
  const at = isNumber(now) ? now : Date.now();
  const out = {};
  for (const unit of WINDOW_UNITS) {
    const rows = typeof ledger?.query === 'function' ? ledger.query({ accountId: 'all', projectId, from: periodStart(at, unit), to: at }) : [];
    let usd = 0;
    let known = 0;
    for (const row of rows) {
      if (!isNumber(row?.costUsd)) continue;
      usd += row.costUsd;
      known++;
    }
    out[unit] = { usd: Math.round(usd * 1e6) / 1e6, rows: rows.length, known }; // 1e-6: no float dust in the view
  }
  return out;
}

/** The limits currently stored in state.json (invalid values read as off). Per project when `projectId` is given. */
export function limitsOf(hub, projectId = null) {
  return cleanLimits(projectId ? hub?.persisted?.projectBudgets?.[projectId] : hub?.persisted?.budget);
}

/** The per-project budget map from a stored/hand-edited value: valid ids and at least one real limit survive. */
export function cleanProjectBudgets(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw).slice(0, 200)) {
    if (!/^[\w-]{1,80}$/.test(id)) continue;
    const limits = cleanLimits(value);
    if (hasBudget(limits)) out[id] = limits;
  }
  return out;
}

/** The note shown with the numbers: the coverage, and why OpenCode Go is usually missing from it. */
export function budgetNote(spent, projectId = null) {
  const { rows, known } = spent?.month ?? { rows: 0, known: 0 };
  const coverage = rows ? `${known} dari ${rows} catatan punya biaya` : 'belum ada catatan biaya';
  return `Dihitung dari biaya ${projectId ? 'project ini ' : ''}yang tercatat di ledger (${coverage}); OpenCode Go umumnya tercatat $0, jadi angkanya bisa lebih rendah dari tagihan sebenarnya.`;
}

/**
 * Everything the 💰 budget screen and 🩺 health need: the limits, the spending they are measured against, and one
 * window per limit with its share and state.
 * @param {object} hub
 * @param {object|null} ledger
 * @param {number} [now] epoch ms
 * @returns {{ budget: ReturnType<typeof cleanLimits>,
 *   spend: ReturnType<typeof spend>,
 *   windows: Record<'day'|'week'|'month', { limit: number|null, usd: number, percent: number, state: 'off'|'ok'|'warn'|'over' }>,
 *   note: string }}
 *   `percent` is usd / limit (0 when off), so it can pass 1; `state` is computed from the exact ratio.
 */
export function budgetView(hub, ledger, now = Date.now(), projectId = null) {
  const budget = limitsOf(hub, projectId);
  const spent = spend(ledger, now, projectId);
  const windows = {};
  for (const unit of WINDOW_UNITS) {
    const limit = budget[WINDOW_LIMITS[unit]];
    const { usd } = spent[unit];
    const ratio = limit ? usd / limit : 0;
    windows[unit] = {
      limit,
      usd,
      percent: limit ? Math.round(ratio * 1e4) / 1e4 : 0,
      state: !limit ? 'off' : ratio >= 1 ? 'over' : ratio >= WARN_RATIO ? 'warn' : 'ok',
    };
  }
  return { budget, spend: spent, windows, note: budgetNote(spent, projectId) };
}

/**
 * The hard stop: null while every configured window is under its limit, else the windows that are at/over it and one
 * message for the user. A running turn is never cut; the next prompt, plan build, or queue item is refused.
 * @returns {{ windows: string[], label: string, message: string }|null}
 */
export function budgetStop(hub, ledger, now = Date.now(), projectId = null) {
  const scopes = [{ project: false, view: budgetView(hub, ledger, now) }];
  if (projectId) scopes.push({ project: true, view: budgetView(hub, ledger, now, projectId) });
  const over = [];
  for (const { project, view } of scopes) {
    for (const unit of WINDOW_UNITS) {
      if (view.windows[unit].state !== 'over') continue;
      over.push({ project, unit, label: `${project ? 'project ' : ''}${WINDOW_LABEL[unit]} ${usdText(view.windows[unit].usd)} / ${usdText(view.windows[unit].limit)}` });
    }
  }
  if (!over.length) return null;
  const label = over.map((item) => item.label).join(' · ');
  return {
    windows: over.filter((item) => !item.project).map((item) => item.unit),
    projectWindows: over.filter((item) => item.project).map((item) => item.unit),
    label,
    message: `⛔ Budget ${label} sudah tercapai. Pengiriman prompt dihentikan sampai batas dinaikkan atau dikosongkan di ⚙ Pengaturan → Umum → Budget pemakaian.`,
  };
}

/** A one-shot override after the user explicitly allows one turn despite the budget. */
export function budgetOverridden(hub, now = Date.now()) {
  return Number.isFinite(hub?.budgetOverrideUntil) && hub.budgetOverrideUntil > now;
}

/** Consumes the one-shot override; false when there was none (the caller then refuses the turn). */
export function consumeBudgetOverride(hub, now = Date.now()) {
  if (!budgetOverridden(hub, now)) return false;
  hub.budgetOverrideUntil = 0;
  return true;
}

export function grantBudgetOverride(hub, ms = 5 * 60 * 1000, now = Date.now()) {
  hub.budgetOverrideUntil = now + ms;
  return hub.budgetOverrideUntil;
}
