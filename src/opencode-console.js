// 📊 OpenCode Go console data: the official quota meters and activity from opencode.ai.
//
// The app stores the OpenCode Console OAuth credential; `opencode auth export opencode` exposes its access token.
// That token is only used here, on the server: it never goes to the browser, a log, a report, or a backup. The
// console API is internal/undocumented, so every call is best-effort: a missing token, an expired session, a
// timeout or a changed shape returns `{ available: false }` and the caller keeps the local estimate.
import { execFileTree } from './proc.js';

export const CONSOLE_ORIGIN = 'https://opencode.ai';
const STATUS_PATH = '/console/api/go/status';
const ACTIVITY_PATH = '/console/api/activity/go';
const USAGE_PATH = '/console/api/usage/summary';
const USAGE_MODELS_PATH = '/console/api/usage/models';
const TIMEOUT_MS = 8_000;
const SNAPSHOT_MS = 60_000;
const FAILURE_MS = 15_000;
const TOKEN_MS = 5 * 60_000;
const MICRO_CENTS = 100_000_000; // 1 USD = 100 cents = 100,000,000 micro-cents

const PLAN_BY_PRODUCT = Object.freeze({ go: 'go', 'go-plus': 'plus', 'go-teams': 'teams', teams: 'teams' });
const METERS = Object.freeze([
  { key: 'fiveHour', label: '5 jam' },
  { key: 'week', label: '7 hari' },
  { key: 'month', label: '30 hari' },
]);

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
};
const iso = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};
const usd = (v) => {
  const n = num(v);
  return n == null ? null : Math.round((n / MICRO_CENTS) * 1e6) / 1e6;
};
const pct = (used, limit) => (used != null && limit != null && limit > 0 ? Math.round((used / limit) * 1e4) / 1e4 : null);
const keyOf = (bin) => (bin ? `${bin.command ?? ''}|${JSON.stringify(bin.args ?? [])}` : '');
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The Go plan name from the console's product id; an unknown product is not guessed. */
export function planOf(product) {
  return typeof product === 'string' ? PLAN_BY_PRODUCT[product] ?? null : null;
}

/**
 * `go/status` → only what the app shows. Personal/payment ids, email and the team upgrade price are dropped here.
 * @returns {{plan:string|null, product:string|null, activeUntil:string|null, renewalProduct:string|null,
 *   cancelAtPeriodEnd:boolean, meters:object[]}|null}
 */
export function normalizeConsoleStatus(raw) {
  if (!isObject(raw)) return null;
  const access = isObject(raw.access) ? raw.access : {};
  const metersRaw = isObject(access.meters) ? access.meters : null;
  if (!metersRaw) return null;
  const meters = METERS.map(({ key, label }) => {
    const m = isObject(metersRaw[key]) ? metersRaw[key] : {};
    const usedUsd = usd(m.usedMicroCents);
    const limitUsd = usd(m.limitMicroCents);
    return {
      key,
      label,
      usedUsd,
      limitUsd,
      percent: pct(usedUsd, limitUsd),
      startsAt: iso(m.startsAt),
      resetsAt: iso(m.resetsAt),
    };
  });
  return {
    plan: planOf(raw.product ?? raw.renewalProduct),
    product: typeof raw.product === 'string' ? raw.product : null,
    renewalProduct: typeof raw.renewalProduct === 'string' ? raw.renewalProduct : null,
    activeUntil: iso(access.endsAt),
    cancelAtPeriodEnd: access.cancelAtPeriodEnd === true,
    meters,
  };
}

/**
 * `activity/go` → daily rows and per-model request counts. The provider only gives requests per model, not cost or
 * tokens, so nothing is invented there.
 * @returns {{startsAt:string|null, daily:object[], models:object[], totals:{costUsd:number,tokens:number,requests:number}}|null}
 */
export function normalizeConsoleActivity(raw) {
  if (!isObject(raw)) return null;
  const daily = (Array.isArray(raw.daily) ? raw.daily : [])
    .slice(0, 400)
    .map((d) => {
      if (!isObject(d) || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return null;
      return {
        date: d.date,
        costUsd: usd(d.totalCostMicroCents) ?? 0,
        tokens: num(d.totalTokens) ?? 0,
        requests: num(d.totalRequests) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .slice(0, 500)
    .map((m) => {
      if (!isObject(m) || typeof m.model !== 'string' || !m.model.trim()) return null;
      return {
        provider: typeof m.provider === 'string' ? m.provider.slice(0, 60) : '',
        model: m.model.trim().slice(0, 120),
        requests: num(m.totalRequests) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  const totals = daily.reduce(
    (sum, d) => ({ costUsd: sum.costUsd + d.costUsd, tokens: sum.tokens + d.tokens, requests: sum.requests + d.requests }),
    { costUsd: 0, tokens: 0, requests: 0 },
  );
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return { startsAt: iso(raw.startsAt), daily, models, totals };
}

/**
 * `usage/summary` → the exact cards for one range. Cost is micro-cents; tokens are the sum of input, output, cache
 * read and both cache writes. `services` is provider-internal and not needed here.
 */
export function normalizeUsageSummary(raw) {
  if (!isObject(raw)) return null;
  const inputTokens = num(raw.totalInputTokens) ?? 0;
  const outputTokens = num(raw.totalOutputTokens) ?? 0;
  const cacheReadTokens = num(raw.totalCacheReadTokens) ?? 0;
  const cacheWrite5mTokens = num(raw.totalCacheWrite5mTokens) ?? 0;
  const cacheWrite1hTokens = num(raw.totalCacheWrite1hTokens) ?? 0;
  return {
    requests: num(raw.totalRequests) ?? 0,
    costUsd: usd(raw.totalCostMicroCents) ?? 0,
    tokens: inputTokens + outputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: cacheWrite5mTokens + cacheWrite1hTokens,
  };
}

/** The URL for one console usage range; userId stays server-side and is never sent to the browser. */
function usageUrl(userId, range, { since = null } = {}) {
  const url = new URL(USAGE_PATH, CONSOLE_ORIGIN);
  url.searchParams.set('range', range);
  if (since) url.searchParams.set('since', since);
  url.searchParams.set('userId', userId);
  url.searchParams.set('includeLegacyKeys', 'true');
  return url.toString();
}

/** The per-model breakdown for one range (the console's "Usage by Model"); the token already identifies the account. */
function usageModelsUrl(range, { since = null } = {}) {
  const url = new URL(USAGE_MODELS_PATH, CONSOLE_ORIGIN);
  url.searchParams.set('range', range);
  if (since) url.searchParams.set('since', since);
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('costOrder', 'desc');
  return url.toString();
}

/**
 * `usage/models` → one row per model with requests, tokens and cost. Unknown items are skipped; the server already
 * orders by cost. Page 1 is enough for this account's model count; a truncated page is still just a partial table,
 * never a wrong total (the summary cards remain the source of the totals).
 */
export function normalizeUsageModels(raw) {
  if (!isObject(raw) || !Array.isArray(raw.items)) return null;
  const models = raw.items
    .slice(0, 100)
    .map((m) => {
      if (!isObject(m) || typeof m.model !== 'string' || !m.model.trim()) return null;
      const inputTokens = num(m.totalInputTokens) ?? 0;
      const outputTokens = num(m.totalOutputTokens) ?? 0;
      const cacheReadTokens = num(m.totalCacheReadTokens) ?? 0;
      const cacheWrite5mTokens = num(m.totalCacheWrite5mTokens) ?? 0;
      const cacheWrite1hTokens = num(m.totalCacheWrite1hTokens) ?? 0;
      return {
        model: m.model.trim().slice(0, 120),
        provider: typeof m.provider === 'string' ? m.provider.slice(0, 60) : '',
        requests: num(m.totalRequests) ?? 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: cacheWrite5mTokens + cacheWrite1hTokens,
        tokens: inputTokens + outputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens,
        costUsd: usd(m.totalCostMicroCents) ?? 0,
      };
    })
    .filter(Boolean);
  return { models, total: num(raw.pageInfo?.total) ?? models.length };
}

/** One JSON request; a non-2xx is a status, never a thrown error with a body that could carry a secret. */
async function getJson(fetchImpl, url, token) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal,
  });
  if (!response.ok) return { status: response.status };
  const data = await response.json().catch(() => null);
  return { data };
}

/** The OAuth access token stored by OpenCode; only this field is read, and it is never logged. */
export async function consoleAccessToken(bin, { fresh = false, cache = defaultTokenCache } = {}) {
  const key = keyOf(bin);
  if (!key) return null;
  const at = Date.now();
  const hit = cache.get(key);
  if (!fresh && hit && at - hit.at < TOKEN_MS) return hit.token;
  const token = await new Promise((resolve) => {
    try {
      execFileTree(
        bin.command,
        [...(bin.args ?? []), 'auth', 'export', 'opencode'],
        { encoding: 'utf8', timeout: 8_000, windowsHide: true, maxBuffer: 256 * 1024 },
        (err, out) => {
          if (err) return resolve(null); // never include stdout/stderr (it contains a secret)
          try {
            const list = JSON.parse(String(out ?? ''));
            const entry = (Array.isArray(list) ? list : []).find((c) => c?.integrationID === 'opencode' && c?.active !== false);
            const access = entry?.value?.access;
            resolve(typeof access === 'string' && access.length >= 16 && access.length <= 512 ? access : null);
          } catch {
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
  if (!token) return null;
  cache.set(key, { at, token });
  return token;
}

const defaultTokenCache = new Map();
const defaultSnapshotCache = new Map();

/**
 * The exact Go snapshot for one OpenCode install. Never throws: an unavailable console is a value, not an error.
 * @param {{command:string,args:string[]}|null} bin
 * @param {{ now?: () => number, fetch?: Function, readToken?: Function, cache?: Map }} [options]
 *   readToken/fetch are injectable for tests; cache holds successful/failed snapshots for a minute.
 * @returns {Promise<object>} `{ available:true, ...status, activity }` or `{ available:false, state }`
 */
export async function goConsoleSnapshot(bin, { now = Date.now, fetch: fetchImpl = globalThis.fetch, readToken = consoleAccessToken, cache = defaultSnapshotCache } = {}) {
  if (!bin || typeof fetchImpl !== 'function') return { available: false, state: 'no-opencode' };
  const key = keyOf(bin);
  const at = now();
  const hit = cache.get(key);
  if (hit && at - hit.at < (hit.snapshot.available ? SNAPSHOT_MS : FAILURE_MS)) return hit.snapshot;
  let token = await readToken(bin).catch(() => null);
  if (!token) return cacheSnapshot(cache, key, at, { available: false, state: 'no-token' });
  let status = await getJson(fetchImpl, `${CONSOLE_ORIGIN}${STATUS_PATH}`, token).catch(() => ({ status: 'network' }));
  let expired = status.status === 401 || status.status === 403;
  if (expired) {
    const fresh = await readToken(bin, { fresh: true }).catch(() => null);
    if (fresh && fresh !== token) {
      token = fresh;
      status = await getJson(fetchImpl, `${CONSOLE_ORIGIN}${STATUS_PATH}`, fresh).catch(() => ({ status: 'network' }));
      expired = status.status === 401 || status.status === 403;
    }
  }
  if (expired) return cacheSnapshot(cache, key, at, { available: false, state: 'expired' });
  const normalized = normalizeConsoleStatus(status.data);
  if (!normalized) return cacheSnapshot(cache, key, at, { available: false, state: 'shape' });
  let activity = null;
  let usage = null;
  const userId = typeof status.data?.subscriberUserId === 'string' && /^acc_[A-Za-z0-9_-]{1,100}$/.test(status.data.subscriberUserId) ? status.data.subscriberUserId : null;
  const dayStart = new Date(at);
  dayStart.setHours(0, 0, 0, 0);
  const [aResult, todayResult, weekResult, todayModelsResult, weekModelsResult] = await Promise.all([
    getJson(fetchImpl, `${CONSOLE_ORIGIN}${ACTIVITY_PATH}`, token).catch(() => ({ status: 'network' })),
    userId ? getJson(fetchImpl, usageUrl(userId, '24h', { since: dayStart.toISOString() }), token).catch(() => ({ status: 'network' })) : null,
    userId ? getJson(fetchImpl, usageUrl(userId, '7d'), token).catch(() => ({ status: 'network' })) : null,
    getJson(fetchImpl, usageModelsUrl('24h', { since: dayStart.toISOString() }), token).catch(() => ({ status: 'network' })),
    getJson(fetchImpl, usageModelsUrl('7d'), token).catch(() => ({ status: 'network' })),
  ]);
  if (aResult && !aResult.status) activity = normalizeConsoleActivity(aResult.data);
  const today = todayResult && !todayResult.status ? normalizeUsageSummary(todayResult.data) : null;
  const week = weekResult && !weekResult.status ? normalizeUsageSummary(weekResult.data) : null;
  if (today) today.models = todayModelsResult && !todayModelsResult.status ? normalizeUsageModels(todayModelsResult.data)?.models ?? [] : [];
  if (week) week.models = weekModelsResult && !weekModelsResult.status ? normalizeUsageModels(weekModelsResult.data)?.models ?? [] : [];
  if (today || week) usage = { today, week };
  return cacheSnapshot(cache, key, at, { available: true, ...normalized, activity, usage, fetchedAt: at });
}

function cacheSnapshot(cache, key, at, snapshot) {
  cache.set(key, { at, snapshot });
  return snapshot;
}

/** The provider part of a report for one period: daily rows are filtered by their UTC date. */
export function consoleForPeriod(snapshot, from = 0, to = Date.now()) {
  if (!snapshot?.available) return null;
  const fromDay = new Date(Number(from) || 0).toISOString().slice(0, 10);
  const toDay = new Date(Number(to) || Date.now()).toISOString().slice(0, 10);
  const daily = (snapshot.activity?.daily ?? []).filter((d) => d.date >= fromDay && d.date <= toDay);
  const totals = daily.reduce(
    (sum, d) => ({ costUsd: sum.costUsd + d.costUsd, tokens: sum.tokens + d.tokens, requests: sum.requests + d.requests }),
    { costUsd: 0, tokens: 0, requests: 0 },
  );
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return {
    plan: snapshot.plan,
    product: snapshot.product,
    activeUntil: snapshot.activeUntil,
    meters: snapshot.meters,
    daily,
    models: snapshot.activity?.models ?? [],
    totals,
    startsAt: snapshot.activity?.startsAt ?? null,
    fetchedAt: snapshot.fetchedAt ?? null,
  };
}
