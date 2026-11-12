// ---------- account (👤 Akun) and the usage report (📊 Laporan token) ----------
// Reading the account, its limits and the report is allowed over WiFi (src/remote.js). Login/logout switch the
// account of every Claude Code on the laptop: server.js lets a phone call them only over Tailscale (ACCOUNT_AUTH).
// `ctx.device` is the paired phone making the request (null on the laptop).
import { randomBytes } from 'node:crypto';
import { accountPrivacyView, billingStatus } from '../account.js';
import { recordAuth, recentAuth } from '../auth-audit.js';
import { ENGINES } from '../hub.js';
import { readModelPrices } from '../model-prices.js';
import { OPENCODE_ACCOUNT } from '../opencode-account.js';
import { openCodeConnectKey, openCodeLogout, openCodeOAuthCancel, openCodeOAuthComplete, openCodeOAuthStart, openCodeOAuthStatus, openCodeProviders } from '../opencode-auth.js';
import { addCustomProvider, CUSTOM_PROVIDER_PACKAGE, readOpenCodeConfig, removeCustomProvider } from '../opencode-config.js';
import { GO_PLANS, goAllowance } from '../opencode-go.js';
import { clearConsoleTokenCache, consoleForPeriod, consoleRequestLogs, consoleRequestTotals, consoleRequestTotalsCached, goConsoleSnapshot } from '../opencode-console.js';
import { renderPdf, reportHtml } from '../report.js';
import { roleUsage } from '../role-usage.js';
import { openCodeRoleSessions } from '../opencode-role-usage.js';
import { daySummary, engineOf, PERIOD_UNITS, summarize, totals } from '../usage.js';
import { json } from './http.js';

const LOGOUT_CONFIRM = 'LOGOUT';
const DAY_MS = 86_400_000;

/** Local OpenCode usage: the ledger rows from web turns and the terminal mirror. Provider quota is not known. */
function openCodeUsage(ledger) {
  if (!ledger) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const at = (from) => totals(ledger.query({ accountId: OPENCODE_ACCOUNT.id, from }));
  return { today: at(today.getTime()), week: at(Date.now() - 7 * DAY_MS) };
}

/** The Go plan has no cost in the session messages, so its allowance is estimated from the ledger and the catalog. */
const GO_PRICES_DAYS = 30;

/**
 * The estimated Go allowance for 👤 Akun: ledger rows of the OpenCode engine (every account, last 30 days) priced with
 * the catalog's Go list prices, compared to the published monthly limits. Without a catalog (no cache, fetch failed)
 * the answer says so instead of pretending the plan is untouched. Never throws: readModelPrices never does either.
 */
async function goView({ hub, ledger, dataDir, opencode }, now = Date.now()) {
  const manualPlan = hub?.goPlan?.() ?? 'go';
  const [catalog, consoleView] = await Promise.all([
    readModelPrices({ dataDir: hub?.dataDir ?? dataDir }),
    opencode ? goConsoleSnapshot(opencode, { now: () => now }) : Promise.resolve(null),
  ]);
  const plan = consoleView?.available ? consoleView.plan ?? manualPlan : manualPlan;
  const estimate =
    catalog && Object.keys(catalog.models ?? {}).length
      ? { available: true, ...goAllowance({ rows: ledger ? ledger.query({ accountId: 'all', from: now - GO_PRICES_DAYS * DAY_MS }) : [], prices: catalog.models, now, plan }) }
      : null;
  const source = consoleView?.available ? 'console' : 'estimate';
  return {
    plan,
    source,
    available: Boolean(consoleView?.available || estimate?.available),
    console: consoleView ?? null,
    estimate,
    models: estimate?.models ?? [],
    note:
      source === 'console'
        ? 'Kuota resmi dari OpenCode Console. Angka per model di bawah adalah perkiraan lokal dari ledger.'
        : estimate?.note ?? 'Harga model belum tersedia.',
  };
}

/** One headless browser at a time renders report PDFs (each is a full Chrome/Edge process for up to 60 s). */
let pdfRendering = false;

// A ctx without the server's view (a test, a future caller) still never shows who the account is to a read-only client.
const FALLBACK_VIEW = accountPrivacyView(randomBytes(32));
/**
 * The read-only (plain-HTTP WiFi) account view for this request (no email, names, org or real ids), or null when the
 * full one may be sent (laptop, Tailscale). Fail closed: a ctx that can't tell gets the reduced view.
 */
const wifiView = (ctx, req) => (ctx.isReadOnly?.(req) === false ? null : (ctx.accountPrivacy ?? FALLBACK_VIEW));

/**
 * The real account id a report asks for: none = the current one; `'all'` = every account (the combined report,
 * for both the laptop and a WiFi viewer — it carries no identity); from a WiFi viewer, its opaque id (null = unknown).
 */
function requestedAccount({ account, ledger }, view, requested) {
  const current = account.current?.id ?? '';
  if (requested === 'all') return 'all'; // never mapped through the opaque WiFi ids
  if (requested === undefined || requested === null || requested === '') return current;
  if (!view) return String(requested);
  return [current, ...ledger.accounts().map((a) => a.id)].find((id) => id && view.id(id) === String(requested)) ?? null;
}

export function register(router) {
  router.post('/api/account', accountState);
  router.post('/api/account/limits', async ({ account, allowForce }, req, res, params, body) => json(res, 200, (await account.refreshLimits(allowForce(req, body))) ?? {}));
  router.post('/api/account/login', loginStart);
  router.post('/api/account/login/code', loginCode);
  router.post('/api/account/login/cancel', loginCancel);
  router.post('/api/account/logout', logout);
  // 📜 Riwayat perubahan akun: the last auth actions, newest first (laptop + Tailscale, never plain WiFi).
  router.post('/api/account/audit', ({ dataDir }, req, res, params, body) => {
    const raw = Number(body?.limit);
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.trunc(raw))) : 50;
    return json(res, 200, { entries: recentAuth(limit, { dataDir }) });
  });
  // ---------- engine (the DEFAULT for new projects) and OpenCode's provider logins ----------
  // This only decides which engine a project seen for the first time starts on. Every project follows the model
  // picked for it (POST /api/projects/:id/settings { engine, model }).
  router.post('/api/engine', ({ hub, device }, req, res, params, body) => {
    const engine = String(body.engine ?? '');
    if (!ENGINES.includes(engine)) return json(res, 400, { error: 'Mesin tidak dikenal.' });
    if (engine === 'opencode' && !hub.config?.engines?.opencode?.available) return json(res, 409, { error: 'OpenCode belum terpasang di laptop ini.' });
    hub.setDefaultEngine(engine);
    if (hub.config) {
      hub.config.engine = hub.engine;
      hub.broadcast('config', hub.config);
    }
    if (device) console.log(`Mesin default diganti dari HP "${device.name}"`);
    return json(res, 200, { ok: true, engine: hub.engine });
  });
  // The user's Go plan: OpenCode does not report it, so the estimate needs it spelled out. Go Teams limits are per
  // member. A plain-WiFi phone is read-only (this route is not on its allowlist), like the other settings.
  router.post('/api/account/go-plan', ({ hub, device }, req, res, params, body) => {
    const plan = String(body?.plan ?? '');
    if (!Object.hasOwn(GO_PLANS, plan)) return json(res, 400, { error: 'Paket OpenCode Go tidak dikenal.' });
    hub.setGoPlan(plan);
    if (device) console.log(`Paket OpenCode Go diganti ke ${plan} dari HP "${device.name}"`);
    return json(res, 200, { ok: true, plan });
  });
  // ⭐ Pin/unpin one model id for the picker's favorite group (app-level; every client gets the config broadcast).
  router.post('/api/model-favorites', ({ hub }, req, res, params, body) => {
    const favorites = hub.toggleFavoriteModel(body?.value, body?.on === true);
    if (favorites === null) return json(res, 400, { error: 'ID model tidak valid.' });
    return json(res, 200, { favorites });
  });
  // Providers plus the estimated Go allowance (the catalog fetch and the provider list run side by side).
  router.post('/api/opencode/providers', openCode(async (bin, body, ctx) => {
    const [view, go] = await Promise.all([openCodeProviders(bin), goView(ctx)]);
    return { ...withCustomEdit(view), usage: openCodeUsage(ctx.ledger), go };
  }));
  // 📡 Recent OpenCode requests (optionally one session/model): normalized server-side, no prompts or personal ids.
  router.post('/api/opencode/requests', openCode(async (bin, body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (sessionId && !/^ses_[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw Object.assign(new Error('Session ID tidak valid.'), { status: 400 });
    const model = typeof body?.model === 'string' ? body.model : '';
    if (model && !/^[\w.:@/+-]{1,120}$/.test(model)) throw Object.assign(new Error('Model tidak valid.'), { status: 400 });
    const cursor = typeof body?.cursor === 'string' ? body.cursor : '';
    if (cursor.length > 500) throw Object.assign(new Error('Cursor tidak valid.'), { status: 400 });
    return consoleRequestLogs(bin, {
      sessionId,
      model,
      cursor,
      since: consoleSince(body?.since),
      limit: body?.limit,
    });
  }));
  // 📡 Total provider usage for one OpenCode session (paginated, bounded); used next to the ledger's session total.
  router.post('/api/opencode/request-totals', openCode(async (bin, body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!/^ses_[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw Object.assign(new Error('Session ID tidak valid.'), { status: 400 });
    return consoleRequestTotals(bin, { sessionId, since: consoleSince(body?.since) });
  }));
  router.post('/api/opencode/login/key', audited('login-key', (body) => body.provider, (bin, body, ctx) => openCodeConnectKey(bin, body.provider, body).then(loggedIn(ctx)).then(phoneAlert(ctx, 'login', body.provider))));
  router.post('/api/opencode/login/oauth', audited('oauth-start', (body) => body.provider, (bin, body, ctx) => openCodeOAuthStart(bin, body.provider, body).then(phoneAlert(ctx, 'login', body.provider))));
  router.post('/api/opencode/login/status', openCode(oAuthStatus));
  router.post('/api/opencode/login/code', audited('oauth-complete', (body) => body.provider, (bin, body, ctx) => openCodeOAuthComplete(bin, body.provider, body.attemptID, body.code).then(loggedIn(ctx))));
  router.post('/api/opencode/login/cancel', audited('cancel', (body) => body.provider, (bin, body) => openCodeOAuthCancel(bin, body.provider, body.attemptID)));
  router.post('/api/opencode/logout', openCode(openCodeLogoutRoute));
  // Provider kustom OpenAI-compatible: cek endpoint /models, lalu blok config + API key + efek login standar,
  // dan Hapus: kredensial + blok config sekaligus (blok yang tertinggal membuat model mati tetap tampil).
  router.post('/api/opencode/custom/check', openCode(customCheck));
  router.post('/api/opencode/custom/test', openCode(customTest));
  router.post('/api/opencode/custom/add', audited('custom-add', (body) => body.id, customAdd));
  router.post('/api/opencode/custom/remove', audited('custom-remove', (body) => body.id, customRemove));
  // ---------- usage report ----------
  router.post('/api/summary/today', ({ ledger }, req, res) => json(res, 200, { today: daySummary(ledger) }));
  router.post('/api/report/accounts', reportAccounts);
  router.post('/api/report/summary', (ctx, req, res, params, body) => report(ctx, req, res, body, { pdf: false }));
  router.post('/api/report/pdf', (ctx, req, res, params, body) => report(ctx, req, res, body, { pdf: true }));
}

/** An OpenCode route: the binary from ctx, errors as JSON (400 for bad input, 502 when OpenCode itself fails). */
const openCode = (fn) => async (ctx, req, res, params, body) => {
  if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
  try {
    return json(res, 200, (await fn(ctx.opencode, body ?? {}, ctx)) ?? { ok: true });
  } catch (err) {
    return json(res, err.status ?? 502, { error: err.message });
  }
};

/** Who did it, for the audit: the paired phone's name, or the laptop itself. */
const actorOf = (device) => (device?.name ? String(device.name) : 'laptop');
/** The provider an audit line names: only a real provider id (the request body is untrusted). */
const auditProvider = (value) => (PROVIDER_ID.test(String(value ?? '')) ? String(value) : null);
/** One audit line (data/auth-audit.jsonl); a bad entry only logs, it never changes the answer to the client. */
const audit = (ctx, entry) => recordAuth(entry, { dataDir: ctx.dataDir });

/**
 * An OpenCode route that records the attempt (ok or not) and then answers exactly as before. The provider in the
 * entry is the one the body names, so a failed login still says which provider it was for.
 */
const audited = (action, providerOf, fn) => openCode(async (bin, body, ctx) => {
  const actor = actorOf(ctx.device);
  const provider = auditProvider(providerOf(body));
  try {
    const result = await fn(bin, body, ctx);
    audit(ctx, { action, engine: 'opencode', provider, actor, ok: true, detail: null });
    return result;
  } catch (err) {
    audit(ctx, { action, engine: 'opencode', provider, actor, ok: false, detail: err.message });
    throw err; // openCode() turns it into the same JSON status as before
  }
});

// ---------- provider kustom OpenAI-compatible (👤 Akun → OpenCode) ----------
// The user points the app at an OpenAI-compatible endpoint: /api/opencode/custom/check asks the endpoint for its
// model list, /api/opencode/custom/add writes a `providers.<id>` block into the global OpenCode config and stores
// the API key through OpenCode's credential store. The key never lands in the config, a log line or the audit.

const MAX_SECRET = 4096; // the same bound as src/opencode-auth.js
const CUSTOM_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const CUSTOM_MODEL_ID = /^[\w.:@/+-]{1,120}$/; // the model id shape the rest of the app already accepts
const CUSTOM_URL_MAX = 300;
const CUSTOM_MODELS_MAX = 200; // what check may hand back
const CUSTOM_MODELS_ADD_MAX = 100; // how many models one provider may carry
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_BODY_MAX_BYTES = 2 * 1024 * 1024; // a model list is KBs: more than that is an attack or a proxy gone wrong
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Reads a response body up to CHECK_BODY_MAX_BYTES, then gives up (the stream is cancelled, never buffered): a
 * hostile or runaway endpoint must not push hundreds of MB into the server's memory. Null when it is too large.
 */
async function readBoundedText(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CHECK_BODY_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // already over the limit: the outcome is the same
      }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** Ids OpenCode (and its catalog) ships itself: a custom provider may never shadow one of these. */
const CUSTOM_DENY = new Set(['openai', 'anthropic', 'google', 'google-vertex', 'azure', 'amazon-bedrock', 'openrouter', 'xai', 'ollama', 'lmstudio', 'vllm', 'github-copilot', 'opencode', 'opencode-go', 'opencode-zen']);

/** A custom provider's base URL: https anywhere, plain http only on loopback (a phone may type a LAN box). */
function customBaseURL(value) {
  const url = String(value ?? '').trim();
  if (!url) throw Object.assign(new Error('Base URL masih kosong.'), { status: 400 });
  if (url.length > CUSTOM_URL_MAX) throw Object.assign(new Error(`Base URL maksimal ${CUSTOM_URL_MAX} karakter.`), { status: 400 });
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('bukan https / loopback');
  } catch {
    throw Object.assign(new Error('Base URL harus https:// (atau http:// hanya untuk localhost).'), { status: 400 });
  }
  return url;
}

/** The model ids an OpenAI-compatible /models answer carries, deduped and bounded; anything else is a 502. */
async function customCheck(bin, body) {
  const baseURL = customBaseURL(body?.baseURL);
  const key = String(body?.key ?? '').trim();
  if (key.length > MAX_SECRET) throw Object.assign(new Error(`API key maksimal ${MAX_SECRET} karakter.`), { status: 400 });
  let res;
  try {
    res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {}, // some endpoints list models without any auth
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    throw Object.assign(new Error('Endpoint /models tidak bisa dihubungi. Cek base URL dan koneksi.'), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error(`Endpoint /models menolak (HTTP ${res.status}).`), { status: 502 }); // body never logged: it may echo the request
  const text = await readBoundedText(res);
  if (text === null) throw Object.assign(new Error('Jawaban endpoint /models terlalu besar.'), { status: 502 });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Jawaban endpoint /models bukan JSON yang valid.'), { status: 502 });
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : null;
  if (!list) throw Object.assign(new Error('Format jawaban /models tidak dikenal (harus { data: [...] }).'), { status: 502 });
  const seen = new Set();
  const models = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item && typeof item === 'object' ? item.id : null;
    if (typeof id !== 'string' || !CUSTOM_MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id });
    if (models.length >= CUSTOM_MODELS_MAX) break;
  }
  return { models };
}

/** The raw model list of a parsed /models answer: an array, or the { data } / { models } shapes. */
function modelListFrom(parsed) {
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : null;
}

/**
 * POST /api/opencode/custom/test: a quick ⚡ reachability ping of a STORED custom block's /models — the client
 * sends only the id (the base URL never comes from the wire). Any HTTP answer means the endpoint is reachable:
 * 200 + a parseable list also reports the model count; a dead endpoint reports a safe inline error. Always a
 * 200 body with { ok }, so the UI can phrase the result inline.
 */
async function customTest(bin, body) {
  const id = String(body?.id ?? '');
  if (!CUSTOM_ID.test(id)) throw Object.assign(new Error('ID provider tidak valid.'), { status: 400 });
  const existing = readOpenCodeConfig({ scope: 'global' });
  if (existing.parseError) throw Object.assign(new Error('Config OpenCode global tidak valid. Perbaiki lewat ⚙ → Config OpenCode dulu.'), { status: 400 });
  const blocks = isObject(existing.config?.providers) ? existing.config.providers : {};
  const block = blocks[id];
  if (!isObject(block) || (typeof block.package === 'string' && block.package !== CUSTOM_PROVIDER_PACKAGE)) {
    throw Object.assign(new Error('Provider kustom tidak ditemukan (atau bukan blok yang ditulis aplikasi).'), { status: 404 });
  }
  const baseURL = customBaseURL(isObject(block.settings) ? block.settings.baseURL : undefined);
  let status = null;
  let models = null;
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    status = res.status;
    if (res.ok) {
      const text = await readBoundedText(res);
      if (text !== null) {
        try {
          const list = modelListFrom(JSON.parse(text));
          if (list) {
            const seen = new Set();
            let count = 0;
            for (const item of list) {
              const id = typeof item === 'string' ? item : item && typeof item === 'object' ? item.id : null;
              if (typeof id !== 'string' || !CUSTOM_MODEL_ID.test(id) || seen.has(id)) continue;
              seen.add(id);
              count++;
            }
            models = count;
          }
        } catch {
          // not JSON: reachable, but not an OpenAI-compatible /models — status still tells the story
        }
      }
    } else {
      try {
        await res.body?.cancel?.();
      } catch {
        // the body is dropped either way
      }
    }
  } catch {
    return { ok: false, error: 'Endpoint /models tidak bisa dihubungi. Cek base URL dan koneksi.' };
  }
  if (models !== null) return { ok: true, status, models };
  return { ok: true, reachable: true, status };
}

/** The models array of an add request: 1..100 valid ids, deduped, order kept. */
function customModels(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error('Daftar model tidak valid.'), { status: 400 });
  if (value.length < 1) throw Object.assign(new Error('Minimal satu model.'), { status: 400 });
  if (value.length > CUSTOM_MODELS_ADD_MAX) throw Object.assign(new Error(`Maksimal ${CUSTOM_MODELS_ADD_MAX} model.`), { status: 400 });
  const seen = new Set();
  const models = [];
  for (const item of value) {
    if (typeof item !== 'string' || !CUSTOM_MODEL_ID.test(item)) {
      throw Object.assign(new Error(`ID model tidak valid: ${String(item).slice(0, 40)}`), { status: 400 });
    }
    if (!seen.has(item)) (seen.add(item), models.push(item));
  }
  return models;
}

/**
 * The ✏️ Edit form's prefill: a provider whose config block this app wrote carries the block's baseURL and model
 * ids (`edit`), plus the `custom` flag the catalog may not set. Blocks of another package are none of our business.
 */
function withCustomEdit(view) {
  const existing = readOpenCodeConfig({ scope: 'global' });
  if (existing.parseError) return view;
  const blocks = isObject(existing.config?.providers) ? existing.config.providers : {};
  const attach = (provider) => {
    if (!isObject(provider)) return provider;
    const block = blocks[provider.id];
    if (!isObject(block) || (typeof block.package === 'string' && block.package !== CUSTOM_PROVIDER_PACKAGE)) return provider;
    return {
      ...provider,
      custom: true,
      edit: {
        baseURL: isObject(block.settings) ? block.settings.baseURL : undefined,
        models: Object.keys(isObject(block.models) ? block.models : {}),
      },
    };
  };
  return {
    ...view,
    connected: (Array.isArray(view.connected) ? view.connected : []).map(attach),
    available: (Array.isArray(view.available) ? view.available : []).map(attach),
  };
}

/**
 * POST /api/opencode/custom/add: a new OpenAI-compatible provider. Refuses builtin ids (deny list, or one the
 * OpenCode catalog already knows), and overwriting a config block that belongs to the user (a different package).
 * The config block is written first, the key second; if the key fails the block stays (the user can log the key in
 * through the usual login-key flow), and the 502 says so.
 */
async function customAdd(bin, body, ctx) {
  const id = String(body?.id ?? '');
  if (!CUSTOM_ID.test(id)) throw Object.assign(new Error('ID provider tidak valid (huruf/angka pertama, lalu huruf/angka, _, ., -; maks 64).'), { status: 400 });
  if (CUSTOM_DENY.has(id)) throw Object.assign(new Error(`ID "${id}" dipakai provider bawaan OpenCode. Pilih ID lain.`), { status: 400 });
  const name = String(body?.name ?? '').trim();
  if (!name || name.length > 100) throw Object.assign(new Error('Nama provider wajib diisi (maks 100 karakter).'), { status: 400 });
  const baseURL = customBaseURL(body?.baseURL);
  const key = String(body?.key ?? '').trim();
  if (key.length > MAX_SECRET) throw Object.assign(new Error('API key maksimal 4096 karakter.'), { status: 400 });
  const models = customModels(body?.models);
  // (0) a base URL another custom block already uses is refused: two blocks over one endpoint showed every model
  // twice in the model list (the production duplicate). Blocks of another package are none of our business here.
  const existing = readOpenCodeConfig({ scope: 'global' });
  if (existing.parseError) throw Object.assign(new Error('Config OpenCode global tidak valid. Perbaiki lewat ⚙ → Config OpenCode dulu.'), { status: 400 });
  const blocks = isObject(existing.config?.providers) ? existing.config.providers : {};
  for (const [otherId, block] of Object.entries(blocks)) {
    if (otherId === id || !isObject(block)) continue;
    const pkg = block.package;
    if (typeof pkg === 'string' && pkg !== CUSTOM_PROVIDER_PACKAGE) continue; // not a block this feature wrote
    const url = isObject(block.settings) ? block.settings.baseURL : undefined;
    if (typeof url === 'string' && url.trim() === baseURL) {
      throw Object.assign(new Error(`ID baru ditolak: base URL ini sudah dipakai provider kustom "${otherId}". Pakai provider itu, atau hapus dulu lewat tombol Hapus.`), { status: 409 });
    }
  }
  // (a) an id the OpenCode catalog knows is refused even off the deny list — except one this app itself defined:
  // our own custom block makes OpenCode list the same id as an integration, so re-adding it is an overwrite (b).
  const ownCustom = new Set(Object.entries(blocks).filter(([, block]) => isObject(block) && (typeof block.package !== 'string' || block.package === CUSTOM_PROVIDER_PACKAGE)).map(([key]) => key));
  const known = await openCodeProviders(bin);
  if ([...known.connected, ...known.available].some((p) => p.id === id && !ownCustom.has(p.id))) {
    throw Object.assign(new Error(`ID "${id}" sudah dipakai provider bawaan. Pilih ID lain.`), { status: 409 });
  }
  // (b) overwrite only a block this feature wrote (its own package, or one without a package field).
  const global = readOpenCodeConfig({ scope: 'global' });
  const providers = global.config.providers;
  const old = providers && typeof providers === 'object' && !Array.isArray(providers) ? providers[id] : undefined;
  if (old && typeof old === 'object') {
    const pkg = old.package;
    if (typeof pkg === 'string' && pkg !== CUSTOM_PROVIDER_PACKAGE) {
      throw Object.assign(new Error(`ID "${id}" sudah dipakai di config OpenCode global (package ${pkg}). Pilih ID lain.`), { status: 409 });
    }
  }
  // An empty key is an EDIT: allowed only while the provider still holds credentials (the stored key is kept);
  // without credentials an empty key could only produce a provider that fails on first use.
  const connected = known.connected.some((p) => p.id === id);
  if (!key && !connected) throw Object.assign(new Error('API key wajib diisi (maks 4096 karakter).'), { status: 400 });
  const saved = addCustomProvider({ id, name, baseURL, models, dataDir: ctx.hub?.dataDir ?? ctx.dataDir });
  if (key) {
    try {
      await openCodeConnectKey(bin, id, { key });
    } catch (err) {
      throw Object.assign(new Error(`Blok provider sudah ditulis ke config OpenCode, tetapi API key gagal disimpan (${err.message}). Login key untuk provider ini lewat alur yang ada, lalu coba lagi.`), { status: 502 });
    }
  }
  return phoneAlert(ctx, 'login', id)(loggedIn(ctx)({ ok: true, provider: id, models, path: saved.path, backup: saved.backup }));
}

const CUSTOM_REMOVE_CONFIRM = 'HAPUS';

/**
 * POST /api/opencode/custom/remove: drops one custom provider for good. The stored credential(s) go first — a
 * credential that refuses to be removed is reported in the answer, never fatal (the dead block must not stay
 * because of it) — then the config block itself (removeCustomProvider refuses a block another feature wrote).
 * Every project running one of the provider's models goes stale, exactly like a logout, and the page is told the
 * model may be gone: `opencode models` reads the config, so a left-over block would keep the models listed.
 */
async function customRemove(bin, body, ctx) {
  if (body?.confirm !== CUSTOM_REMOVE_CONFIRM) {
    throw Object.assign(new Error(`Ketik ${CUSTOM_REMOVE_CONFIRM} untuk konfirmasi hapus provider kustom.`), { status: 400 });
  }
  const id = String(body?.id ?? '');
  if (!CUSTOM_ID.test(id)) throw Object.assign(new Error('ID provider tidak valid (huruf/angka pertama, lalu huruf/angka, _, ., -; maks 64).'), { status: 400 });
  const credentialErrors = [];
  let credentialsRemoved = 0;
  try {
    const { connected } = await openCodeProviders(bin);
    for (const c of connected.find((p) => p.id === id)?.connections ?? []) {
      if (c.type !== 'credential') continue;
      try {
        await openCodeLogout(bin, c.id);
        credentialsRemoved++;
      } catch (err) {
        credentialErrors.push(err.message);
      }
    }
  } catch (err) {
    credentialErrors.push(`Daftar provider tidak bisa dibaca: ${err.message}`); // the block removal still proceeds
  }
  const removed = removeCustomProvider({ id, dataDir: ctx.hub?.dataDir ?? ctx.dataDir });
  markModelStale(ctx.hub, id);
  return phoneAlert(ctx, 'logout', id)(loggedIn(ctx)({ ok: true, provider: id, credentialsRemoved, credentialErrors, path: removed.path, backup: removed.backup }));
}

/** The OAuth attempt's state; only the moment it completes is an auth action worth an audit line. */
async function oAuthStatus(bin, body, ctx) {
  const st = await openCodeOAuthStatus(bin, body.provider, body.attemptID);
  if (st.status !== 'complete') return st;
  audit(ctx, { action: 'oauth-complete', engine: 'opencode', provider: auditProvider(body.provider), actor: actorOf(ctx.device), ok: true, detail: null });
  return loggedIn(ctx)(st);
}

const OPENCODE_LOGOUT_CONFIRM = 'LOGOUT';
const CREDENTIAL_ID = /^[\w.-]{1,100}$/;
const CONSOLE_LOOKBACK_MS = 90 * 86_400_000;

/** A client-supplied `since`: never in the future, never older than 90 days (bounded provider scans). */
function consoleSince(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  const now = Date.now();
  return Math.min(now, Math.max(now - CONSOLE_LOOKBACK_MS, at));
}

/** The provider a stored credential belongs to, from the providers list; null when unknown or already gone. */
async function providerOfCredential(bin, credentialID) {
  if (!CREDENTIAL_ID.test(credentialID)) return null;
  try {
    const { connected } = await openCodeProviders(bin);
    return connected.find((p) => p.connections.some((c) => c.type === 'credential' && c.id === credentialID))?.id ?? null;
  } catch {
    return null; // the logout itself reports what is wrong
  }
}

const MODEL_STALE_TEXT = (model, provider) => `⚠ Model aktif (${model}) berasal dari provider ${provider} yang baru logout. Pilih model lain atau Default.`;

/**
 * A provider was logged out: every OpenCode project with one of its models active is marked stale (and told in its
 * chat). The model is deliberately left as it is: the next prompt is refused (routes/session.js) until the user
 * picks another model or Default, so a dead provider is never replaced silently.
 */
function markModelStale(hub, provider) {
  if (!provider) return;
  for (const project of hub.projects.values()) {
    if (project.virtual) continue;
    if (hub.settingsFor(project.id).engine !== 'opencode') continue;
    // Only a project whose session is (or was) running has an active model; reading it never opens a runtime.
    const model = String(hub.runtime.get(project.id)?.status?.activeModel ?? '');
    if (!model.startsWith(`${provider}/`)) continue;
    hub.setStatus(project.id, { modelStale: true });
    hub.chat(project.id, { kind: 'info', level: 'warning', modelStale: true, text: MODEL_STALE_TEXT(model, provider) });
  }
}

/**
 * POST /api/opencode/logout: drops one stored provider credential. `confirm: "LOGOUT"` is required from every
 * client (the laptop too): a single tap must never leave the projects without a provider.
 */
async function openCodeLogoutRoute(bin, body, ctx) {
  const actor = actorOf(ctx.device);
  if (body.confirm !== OPENCODE_LOGOUT_CONFIRM) {
    audit(ctx, { action: 'logout', engine: 'opencode', provider: null, actor, ok: false, detail: `butuh konfirmasi ${OPENCODE_LOGOUT_CONFIRM}` });
    throw Object.assign(new Error(`Ketik ${OPENCODE_LOGOUT_CONFIRM} untuk konfirmasi logout provider dari HP.`), { status: 400 });
  }
  const credentialID = String(body.credentialID ?? '');
  // Which provider it was: only known before the logout (afterwards the credential is gone from the list).
  const provider = await providerOfCredential(bin, credentialID);
  try {
    await openCodeLogout(bin, credentialID);
  } catch (err) {
    audit(ctx, { action: 'logout', engine: 'opencode', provider, actor, ok: false, detail: err.message });
    throw err;
  }
  audit(ctx, { action: 'logout', engine: 'opencode', provider, actor, ok: true, detail: null });
  markModelStale(ctx.hub, provider);
  return phoneAlert(ctx, 'logout')(loggedIn(ctx)({ ok: true }));
}

/** Credentials changed: idle OpenCode processes restart with them on the next prompt (busy ones after their turn). */
const loggedIn = (ctx) => (result) => {
  clearConsoleTokenCache(); // logout/login/cabut kredensial: never reuse a console token from before
  ctx.sessions.openCodeAccountChanged?.(); // only OpenCode sessions: an ACP process is unchanged by a Claude login
  // A provider came or went: every queue pauses until the user has checked the model (never a silent replacement).
  ctx.taskQueue?.pauseAll('account');
  return result;
};

/**
 * Tells the laptop that a phone started a login or logged out (shown as a toast + notification). `engine`
 * "opencode": an OpenCode provider (`provider` its id, null when unknown, e.g. a logout); else the Claude account.
 */
function accountAlert(hub, action, device, email = null, { engine = 'claude', provider = null } = {}) {
  const what = engine === 'opencode' ? `OpenCode${provider ? ` (${provider})` : ''} ` : '';
  console.log(`Akun: ${action} ${what}dari HP "${device.name}"${email ? ` (${email})` : ''}`);
  hub.broadcast('account-alert', { action, device: device.name, email, engine, provider, ts: Date.now() });
}

/** After a successful OpenCode provider login (started) or logout from a phone: the same alert as for Claude Code. */
const PROVIDER_ID = /^[\w.-]{1,100}$/;
const phoneAlert = (ctx, action, provider = null) => (result) => {
  if (ctx.device) accountAlert(ctx.hub, action, ctx.device, null, { engine: 'opencode', provider: PROVIDER_ID.test(String(provider ?? '')) ? String(provider) : null });
  return result;
};

/**
 * `account-alert` for a read-only client on plain-HTTP WiFi (sniffable): the alert stays, without the paired
 * device's name (often a person's) or the account email. Registered in server.js (hub.redactors).
 */
export const wifiAccountAlert = ({ action, engine, ts }) => ({ action, device: 'Perangkat lain', email: null, ...(engine ? { engine } : {}), ts });

async function accountState(ctx, req, res, params, body) {
  const { account, ledger, allowForce } = ctx;
  await account.refreshProfile(allowForce(req, body));
  const view = wifiView(ctx, req);
  const id = account.current?.id;
  const since = (ms) => totals(id ? ledger.query({ accountId: id, from: Date.now() - ms }) : []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const state = view ? view.state(account.publicState()) : account.publicState();
  return json(res, 200, { ...state, usage: { today: totals(id ? ledger.query({ accountId: id, from: today.getTime() }) : []), week: since(7 * 86_400_000) } });
}

/** POST /api/account/login: the login flow starts; a phone is announced on the laptop; every queue pauses. */
function loginStart({ hub, account, device, taskQueue, dataDir }, req, res, params, body) {
  const actor = actorOf(device);
  let flow;
  try {
    flow = account.startLogin({ console: Boolean(body.console) });
    recordAuth({ action: 'login-start', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
  } catch (err) {
    recordAuth({ action: 'login-start', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err; // the same 500 as before
  }
  taskQueue?.pauseAll('account'); // the account (and so the model) is about to change: nothing runs meanwhile
  if (device) accountAlert(hub, 'login', device);
  return json(res, 200, flow);
}

/** POST /api/account/login/code: the pasted code goes to the running login; the code itself is never audited. */
function loginCode({ account, device, dataDir }, req, res, params, body) {
  const actor = actorOf(device);
  const code = String(body.code ?? '').trim();
  if (!code) {
    recordAuth({ action: 'login-code', engine: 'claude', provider: null, actor, ok: false, detail: 'Kode kosong.' }, { dataDir });
    return json(res, 400, { error: 'Kode kosong.' });
  }
  try {
    account.submitCode(code);
    recordAuth({ action: 'login-code', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
    return json(res, 200, { ok: true });
  } catch (err) {
    recordAuth({ action: 'login-code', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err;
  }
}

/** POST /api/account/login/cancel: the login the user started is dropped (nothing is signed in). */
function loginCancel({ account, device, dataDir }, req, res) {
  const actor = actorOf(device);
  try {
    account.cancelLogin();
    recordAuth({ action: 'login-cancel', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
    return json(res, 200, { ok: true });
  } catch (err) {
    recordAuth({ action: 'login-cancel', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err;
  }
}

async function logout({ hub, account, device, taskQueue, dataDir }, req, res, params, body) {
  const actor = actorOf(device);
  // Second step for phones: the user must type LOGOUT, so a stray tap can't sign the laptop out.
  if (device && body.confirm !== LOGOUT_CONFIRM) {
    recordAuth({ action: 'logout', engine: 'claude', provider: null, actor, ok: false, detail: `butuh konfirmasi ${LOGOUT_CONFIRM}` }, { dataDir });
    return json(res, 400, { error: `Ketik ${LOGOUT_CONFIRM} untuk konfirmasi logout dari HP.` });
  }
  const email = account.current?.email ?? null;
  let profile;
  try {
    profile = await account.logout();
    recordAuth({ action: 'logout', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
  } catch (err) {
    recordAuth({ action: 'logout', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err;
  }
  taskQueue?.pauseAll('account'); // every queue stops: the account that ran them just left
  if (device) accountAlert(hub, 'logout', device, email);
  return json(res, 200, { profile });
}

function reportAccounts(ctx, req, res) {
  const { account, ledger } = ctx;
  const known = ledger.accounts();
  const current = account.current;
  if (current && !known.some((a) => a.id === current.id)) known.unshift({ ...current, tokens: 0 });
  const view = wifiView(ctx, req);
  if (view) return json(res, 200, { accounts: view.accounts(known), current: view.id(current?.id) });
  return json(res, 200, { accounts: known, current: current?.id ?? null });
}

/** POST /api/report/summary (JSON) and /api/report/pdf (a PDF download, or the HTML to print when no browser renders it). */
async function report(ctx, req, res, body, { pdf: wantPdf }) {
  const { account, ledger } = ctx;
  const view = wifiView(ctx, req);
  const accountId = requestedAccount(ctx, view, body.accountId);
  if (accountId === null) return json(res, 404, { error: 'Akun tidak dikenal.' });
  const all = accountId === 'all';
  // A report period is client-provided: clamp it to finite values, never beyond tomorrow, and to 10 years.
  const now = Date.now();
  const askedTo = Number(body.to);
  const askedFrom = Number(body.from);
  const to = Number.isFinite(askedTo) && askedTo > 0 ? Math.min(askedTo, now + 86_400_000) : now;
  let from = Number.isFinite(askedFrom) && askedFrom > 0 ? askedFrom : 0;
  if (from > to) from = 0;
  if (from && to - from > 3_650 * 86_400_000) from = to - 3_650 * 86_400_000;
  const rows = ledger.query({ accountId, from, to });
  const groupBy = PERIOD_UNITS.includes(body.groupBy) ? body.groupBy : 'day';
  const summary = summarize(rows, { from: from || (rows[0]?.ts ?? to), to, groupBy });
  // 🧩 Per-role estimate: Claude from the subagent transcripts; OpenCode from its own session list (agent per
  // session). Never fails the report: a missing transcript/session is an explicit "no detail" row.
  try {
    const opencodeSessions = ctx.opencode && rows.some((row) => engineOf(row) === 'opencode') ? await openCodeRoleSessions(ctx.opencode) : null;
    summary.byRole = roleUsage(rows, { hub: ctx.hub, from, to, opencodeSessions });
  } catch (err) {
    console.error(`Per-role usage tidak bisa dihitung: ${err?.message ?? err}`);
  }
  // OpenCode Go provider data is account-wide (no project/role dimension): only for the OpenCode or combined report.
  // A read-only WiFi viewer gets no provider calls at all: reports are cheap to repeat and must not fan out to console.
  let opencodeGo = null;
  if (ctx.opencode && !view && (all || accountId === OPENCODE_ACCOUNT.id)) {
    try {
      // Server time for the cache TTL; the requested period only filters the daily rows below. A client-supplied
      // future `to` must never bypass the 60-second console cache.
      const snapshot = await goConsoleSnapshot(ctx.opencode);
      opencodeGo = consoleForPeriod(snapshot, from, to);
      // Exact provider cost for the OpenCode sessions that made it into the report's top ten (bounded, in parallel).
      if (opencodeGo && Array.isArray(summary.topSessions)) {
        const opencodeSessions = new Set(rows.filter((row) => engineOf(row) === 'opencode' && row.sessionId).map((row) => row.sessionId));
        const targets = summary.topSessions
          .map((s) => ({ s, sessionId: String(s.key ?? '').split('|').at(-1) }))
          .filter(({ sessionId }) => opencodeSessions.has(sessionId))
          .slice(0, 5);
        const providerSessions = await Promise.all(
          targets.map(async ({ s, sessionId }) => {
            const t = await consoleRequestTotalsCached(ctx.opencode, { sessionId, since: from > 0 ? from : undefined, maxMs: 2500, maxPages: 5 }).catch(() => null);
            if (!t?.available) return null;
            return {
              project: String(s.key ?? '').split('|')[0],
              sessionId: sessionId.slice(0, 8), // the report only shows a short label; the full id stays out of the JSON
              requests: t.totals.requests,
              tokens: t.totals.tokens,
              costUsd: t.totals.costUsd,
              truncated: t.truncated,
              pages: t.pages,
            };
          }),
        );
        opencodeGo.sessions = providerSessions.filter(Boolean);
      }
    } catch {
      opencodeGo = null; // best effort: the report still works without the console
    }
  }
  // The same-length window right before this one, for the "vs previous period" line (only with a real start).
  const span = to - from;
  const previous = from > 0 && span > 0 ? totals(ledger.query({ accountId, from: from - span, to: from - 1 })) : null;
  // The summary is aggregated only (engine/model/project/source/period/sessions): no email, org or account id.
  if (!wantPdf) return json(res, 200, { ...summary, ...(previous ? { previous, previousRange: { from: from - span, to: from - 1 } } : {}), ...(opencodeGo ? { opencodeGo } : {}) });
  // Combined report: a fixed label without personal data, and no per-account profile, limits or billing.
  const found = all
    ? { email: 'Semua akun', org: null }
    : (ledger.accounts().find((a) => a.id === accountId) ?? (account.current?.id === accountId ? account.current : null));
  if (!found) return json(res, 404, { error: 'Akun tidak dikenal.' });
  const isCurrent = !all && account.current?.id === accountId;
  // WiFi: the PDF (and its file name) says "Akun Claude", never the email, name or organisation.
  const who = all || !view ? found : { ...found, email: 'Akun Claude', org: null };
  const profile = isCurrent ? (view ? view.state({ profile: account.profile }).profile : account.profile) : null;
  // billing (usage-based seats): only a limit status and a reset date, nothing personal, so WiFi gets it too
  const billing = isCurrent ? billingStatus(account.profile, account.rateLimit) : null;
  const html = reportHtml({ account: who, profile, limits: isCurrent ? account.limits : null, billing, summary, opencodeGo });
  if (pdfRendering) return json(res, 429, { error: 'Laporan PDF lain sedang dibuat. Coba lagi sebentar.' });
  pdfRendering = true;
  try {
    const pdf = await renderPdf(html);
    // Local date (sv-SE = YYYY-MM-DD): toISOString is UTC, a day behind in the Jakarta morning.
    const name = `laporan-token-${who.email.replace(/[^\w.-]+/g, '_')}-${new Date().toLocaleDateString('sv-SE')}.pdf`;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return res.end(pdf);
  } catch (err) {
    // No headless browser available: hand back the HTML so the page can print it to PDF.
    return json(res, 501, { error: err.message, html });
  } finally {
    pdfRendering = false;
  }
}
