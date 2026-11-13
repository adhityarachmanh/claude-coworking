// The engine (Claude Code / OpenCode, docs/design-opencode.md): the engine follows the model picked in
// "Pengaturan giliran", so one request lists both engines' models. Rules live in core/engine-caps.js.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { capReason, capsFor, cleanModelList, DEFAULT_ENGINE, engineLabel, engineOf, favoriteModelList, groupModels, modelsPerProject, openCodeProviderGroups } from '../core/engine-caps.js';
import { mpApplyRow, mpHighlight, mpRows } from './model-picker.js';
import { auth, DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { priceDetail, priceSuffix } from './model-prices.js';

/** The engine of a project (default: the active one). */
export const projectEngine = (id = state.active) => engineOf(state.statuses[id], state.config);

/** The caps of a project's engine. */
export const projectCaps = (id = state.active) => capsFor(state.config, projectEngine(id));

/** Why `cap` is off for the project, or null when it is supported. */
export function capBlocked(cap, id = state.active) {
  if (!id || id === DEMO_ID) return null;
  return projectCaps(id)[cap] === false ? capReason(cap, projectEngine(id)) : null;
}

/** For the openers (/rewind, /mcp, /tasks, export…): toasts the reason and returns true when the engine lacks `cap`. */
export function guardCap(cap, id = state.active) {
  const why = capBlocked(cap, id);
  if (why) toast(`${why}.`, 'warn');
  return Boolean(why);
}

/** Elements marked `data-cap="<cap>"` (menu items, sheet rows) are hidden while the engine lacks it. */
export function applyCapsToDom(id = state.active) {
  for (const el of document.querySelectorAll('[data-cap]')) {
    const why = capBlocked(el.dataset.cap, id);
    el.hidden = Boolean(why);
    el.classList.toggle('cap-off', Boolean(why));
  }
}

// ---------- per-project models (both engines, from POST /api/projects/:id/models) ----------

/** project id → { at, loading, error, tries, engine, claude: {models,current}, opencode: {models,current,needsStart} } */
const modelCache = new Map();
const RETRY_EMPTY_MS = 4000; // the list appears once OpenCode has started a session
const EMPTY_TRIES = 6; // empty answers asked again without a prompt (about 25 s of OpenCode starting up)
const RETRY_ERROR_MS = 30_000;
const EMPTY_LIST = Object.freeze({ models: [], current: '', needsStart: false });

/** The server's routes are POST (src/routes/router.js); a plain GET is the fallback for the contract's spelling. */
async function fetchModels(id) {
  const path = `/api/projects/${id}/models`;
  try {
    return await api(path);
  } catch (err) {
    if (err.status !== 404 && err.status !== 405) throw err;
    const res = await fetch(path, { headers: { 'X-Office-Token': auth.token } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  }
}

/** One engine's part of the answer, validated; each model keeps its own `efforts` for the effort picker. */
function cleanEngineList(raw) {
  const { models, current, needsStart } = cleanModelList(raw);
  const efforts = new Map();
  for (const m of Array.isArray(raw?.models) ? raw.models : []) {
    if (typeof m?.value !== 'string') continue;
    if (Array.isArray(m.efforts)) efforts.set(m.value, m.efforts.map((e) => String(e).trim()).filter(Boolean).slice(0, 16));
    else if (m.efforts === null) efforts.set(m.value, null);
  }
  return {
    models: models.map((m) => ({ ...m, efforts: efforts.has(m.value) ? efforts.get(m.value) : null })),
    current,
    needsStart,
  };
}

/** `{ engines: { claude, opencode } }`; an older server's single-engine answer is put under its own engine. */
function cleanCatalog(data) {
  const engines = data && typeof data === 'object' && data.engines && typeof data.engines === 'object' ? data.engines : null;
  const legacy = engines ? null : data;
  return {
    claude: cleanEngineList(engines?.claude ?? (legacy?.engine === 'claude' ? legacy : null)),
    opencode: cleanEngineList(engines?.opencode ?? (legacy?.engine !== 'claude' ? legacy : null)),
  };
}

/**
 * Both engines' model lists for the project (fetches when missing or stale). The answer carries Claude Code's
 * catalog and OpenCode's per-project list; the caller picks what to show. A read-only page gets the cached/empty
 * lists only: `/models` is not on the plain-WiFi allowlist.
 */
/** project ids whose model list was explicitly asked for (turn-settings opened): a background render never fetches. */
const wantedModels = new Set();
export const wantModels = (id = state.active) => id && wantedModels.add(id);

// ---------- provider display names + credential state (the picker labels groups and gates the login-less ones) ----------

/** { at, load, names, known, connected } — names/known/connected fill in when the fetch resolves. */
let providerNamesCache = { at: 0, load: null, names: {}, known: [], connected: [] };

/** The names fetched so far, synchronously (a pending fetch replaces them when it resolves). */
export const currentProviderNames = () => providerNamesCache.names;

/** What the account view last said: { known, connected } id lists (a pending fetch keeps the previous one). */
export const currentProviderAuth = () => ({ known: providerNamesCache.known, connected: providerNamesCache.connected });

/** id → display name plus which providers hold credentials, from the account endpoint (the Akun tab's call), cached a minute. */
export function providerNames({ maxAgeMs = 60_000 } = {}) {
  const now = Date.now();
  if (providerNamesCache.load && now - providerNamesCache.at < maxAgeMs) return providerNamesCache.load;
  const load = api('/api/opencode/providers')
    .then((view) => {
      const names = {};
      const known = [];
      const connected = [];
      for (const p of [...(view?.connected ?? []), ...(view?.available ?? [])]) {
        if (!p?.id) continue;
        if (typeof p.name === 'string' && p.name.trim()) names[p.id] = p.name.trim().slice(0, 60);
        known.push(p.id);
      }
      for (const p of view?.connected ?? []) if (p?.id) connected.push(p.id);
      Object.assign(providerNamesCache, { names, known, connected });
      return names;
    })
    .catch(() => ({})); // nothing available: the picker labels groups with ids and gates nothing
  providerNamesCache = { at: now, load, names: providerNamesCache.names, known: providerNamesCache.known, connected: providerNamesCache.connected };
  return load;
}

export function projectModelCatalog(id = state.active, st = state.statuses[id] ?? {}, onLoaded = () => {}) {
  const engine = engineOf(st, state.config);
  if (!id || id === DEMO_ID) return { claude: EMPTY_LIST, opencode: EMPTY_LIST, loading: false, error: null };
  // A project the server no longer lists (forgotten/purged elsewhere) must not be asked for models: that is a 404.
  if (!state.projects.some((p) => p.id === id)) return { claude: EMPTY_LIST, opencode: EMPTY_LIST, loading: false, error: null };
  const now = Date.now();
  let entry = modelCache.get(id);
  // The list is only fetched after the turn-settings (or ladder) dialog was opened: a background render must not
  // ask the server for a project another tab may have just forgotten (a 404 in the console for nothing).
  const visible = wantedModels.has(id);
  // An empty OpenCode list is asked again shortly (its service may still be starting); picking a model of the other
  // engine also refreshes, so its list is there before the user looks for it.
  const retryEmpty = Boolean(entry && !entry.loading && !entry.error && entry.opencode?.needsStart && now - entry.at > RETRY_EMPTY_MS && ((entry.tries ?? 0) < EMPTY_TRIES || st.sessionId || st.alive));
  // A different engine re-reads the lists (the other engine's catalog may be stale or from another project state).
  const engineChanged = Boolean(entry && entry.engine !== engine);
  const stale = visible && (!entry || (!entry.loading && ((entry.error && now - entry.at > RETRY_ERROR_MS) || retryEmpty || engineChanged)));
  if (stale && !state.readOnly) {
    entry = {
      ...(entry ?? {}),
      engine,
      claude: entry?.claude ?? EMPTY_LIST,
      opencode: entry?.opencode ?? EMPTY_LIST,
      at: now,
      loading: true,
      error: null,
      tries: (entry?.tries ?? 0) + 1,
    };
    modelCache.set(id, entry);
    const mine = entry;
    // The group labels want the provider display names too (same cadence, cached a minute): one more render
    // when they arrive.
    providerNames().then(() => modelCache.get(id) === mine && onLoaded());
    fetchModels(id)
      .then((data) => Object.assign(mine, cleanCatalog(data), { error: null }))
      .catch((err) => Object.assign(mine, { error: err.message }))
      .finally(() => {
        Object.assign(mine, { loading: false, at: Date.now() });
        if (modelCache.get(id) !== mine) return;
        onLoaded();
        // still empty: render again after the retry delay, which asks once more (up to EMPTY_TRIES)
        if (!mine.error && mine.opencode?.needsStart && mine.tries < EMPTY_TRIES) setTimeout(() => modelCache.get(id) === mine && onLoaded(), RETRY_EMPTY_MS + 200);
      });
  }
  return entry ?? { claude: EMPTY_LIST, opencode: EMPTY_LIST, loading: false, error: state.readOnly ? READ_ONLY_HINT : null };
}

/** The cached list for the project's engine (null = Claude Code: its catalog comes with the app config). */
export function projectModels(id, st = state.statuses[id] ?? {}, onLoaded = () => {}) {
  const engine = engineOf(st, state.config);
  if (!modelsPerProject(engine) || !id || id === DEMO_ID) return null;
  const catalog = projectModelCatalog(id, st, onLoaded);
  const list = catalog[engine] ?? EMPTY_LIST;
  return { engine, models: list.models, current: list.current, needsStart: list.needsStart, loading: Boolean(catalog.loading), error: catalog.error ?? null };
}

// "Model Auto": the classifier picks the tier per prompt (server side). The picker value is a sentinel, not a model.
export const AUTO_MODEL = 'auto';
export const AUTO_MODEL_LABEL = 'Auto — sesuaikan task';
const AUTO_MODEL_TITLE = 'Model dipilih otomatis sesuai tingkat kesulitan tiap prompt: Hemat / Seimbang / Kuat / Maks.';

/** The "Auto" entry every engine's model select starts with (same label and value on both engines). */
export const autoModelOption = (engine = DEFAULT_ENGINE) =>
  `<option value="${AUTO_MODEL}" data-engine="${escapeHtml(engine)}" title="${escapeHtml(AUTO_MODEL_TITLE)}">${AUTO_MODEL_LABEL}</option>`;

/** "Tunggu giliran ini selesai": why a model of the OTHER engine is disabled while the project works. */
export const OTHER_ENGINE_LOCK_HINT = 'Tunggu giliran ini selesai';

/** Why a provider's models are disabled: its group has no stored credentials yet (👤 Akun → OpenCode). */
export const LOGIN_HINT = 'Provider belum login — simpan API key di 👤 Akun → OpenCode, lalu coba lagi.';

/** The project's turn is holding the other engine back (same rule as the server's 409). */
export const engineSwitchLocked = (st) => Boolean(st && (st.busy || st.pending || st.queue || st.interrupted || st.rewinding));

/**
 * Options for the #model select from a per-project list: "Auto — sesuaikan task", "Default (dari config <Engine>)",
 * one <optgroup> per provider, the search filter applied; the current model always stays (selected, even when filtered out).
 */
export function projectModelOptions(entry, current, query) {
  const label = engineLabel(entry.engine);
  const opts = [autoModelOption(entry.engine), `<option value="" data-engine="${escapeHtml(entry.engine)}">Default (dari config ${escapeHtml(label)})</option>`];
  if (entry.loading && !entry.models.length) opts.push('<option value="" disabled data-info>Memuat daftar model…</option>');
  else if (entry.error && !entry.models.length) opts.push(`<option value="" disabled data-info>Daftar model gagal dimuat: ${escapeHtml(entry.error)}</option>`);
  else if (!entry.models.length) opts.push('<option value="" disabled data-info>Daftar model muncul setelah pesan pertama</option>');
  const groups = groupModels(entry.models, query);
  let shown = false;
  // Price hints come from features/model-prices.js (already fetched by the composer; absent data = no suffix).
  const option = (m) => {
    const detail = priceDetail(m.value); // starts with the model id, then the numbers, source, peak and records
    const title = detail || m.value;
    return `<option value="${escapeHtml(m.value)}" data-engine="${escapeHtml(entry.engine)}" title="${escapeHtml(title)}">${escapeHtml(`${m.name}${priceSuffix(m.value)}`)}</option>`;
  };
  for (const g of groups) {
    opts.push(`<optgroup label="${escapeHtml(g.provider)}">${g.models.map(option).join('')}</optgroup>`);
    shown ||= g.models.some((m) => m.value === current);
  }
  if (query && entry.models.length && !groups.length) opts.push('<option value="" disabled data-info>Tidak ada model yang cocok</option>');
  if (current && !shown) {
    const name = entry.models.find((m) => m.value === current)?.name ?? current;
    opts.push(option({ value: current, name }));
  }
  return opts.join('');
}

/** Number of models matching the search box (for its live count). */
export const matchCount = (entry, query) => groupModels(entry.models, query).reduce((n, g) => n + g.models.length, 0);

/** Claude Code's catalog: the server's answer, else the app config (the older, still-valid source). */
function claudeCatalogModels(catalog) {
  // "Default" is its own option before the groups: never list the catalog's default entry twice.
  const usable = (m) => m && typeof m.value === 'string' && m.value && m.value !== 'default';
  const fromServer = (catalog?.claude?.models ?? []).filter(usable);
  if (fromServer.length) return fromServer;
  return (state.config?.models ?? [])
    .filter(usable)
    .map((m) => ({ value: m.value, name: m.displayName || m.name || m.value, description: m.description ?? '', efforts: Array.isArray(m.efforts) ? m.efforts : null }));
}

/**
 * The ONE model list: Auto, Default, then every Claude Code model and every OpenCode model. Each option carries
 * `data-engine`, so picking a model of the other engine sends `{ engine, model }` in a single request. While the
 * project works (busy/pending/queue/interrupted/rewinding) the other engine's models are disabled with the reason.
 */
export function modelCatalogOptions(catalog, current, query, { engine = DEFAULT_ENGINE, locked = false, loading = false, error = null, providerNames = null, providerAuth = null, favorites = null } = {}) {
  const claude = claudeCatalogModels(catalog);
  const opencode = catalog?.opencode?.models ?? [];
  const config = new Map((state.config?.models ?? []).filter((m) => m?.value).map((m) => [m.value, m]));
  const def = config.get('default');
  const option = (m, at, hint = null) => {
    const detail = priceDetail(m.value);
    const desc = config.get(m.value)?.description || m.description || '';
    const title = hint ?? (locked && at !== engine ? OTHER_ENGINE_LOCK_HINT : [desc, detail].filter(Boolean).join(' · ') || m.value);
    const disabled = (locked && at !== engine) || hint ? ' disabled' : '';
    return `<option value="${escapeHtml(m.value)}" data-engine="${escapeHtml(at)}" title="${escapeHtml(title)}"${disabled}>${escapeHtml(`${m.name}${priceSuffix(m.value)}`)}</option>`;
  };
  const defText = engine === DEFAULT_ENGINE && def?.description ? `Default (${escapeHtml(def.description.split('·')[0].trim())})` : `Default (dari config ${escapeHtml(engineLabel(engine))})`;
  const opts = [autoModelOption(engine), `<option value="" data-engine="${escapeHtml(engine)}" title="${escapeHtml(def?.description ?? '')}">${defText}</option>`];
  // ⭐ Favorit: the app-level pinned ids that exist in either list (each keeps its own engine + lock rules).
  const favs = favoriteModelList(favorites, claude, opencode);
  if (favs.length) opts.push(`<optgroup label="⭐ Favorit">${favs.map((m) => option(m, m.engine)).join('')}</optgroup>`);
  // Claude Code: one group with its own catalog (the search filter applies to it too).
  const claudeGroups = groupModels(claude, query);
  if (claudeGroups.length) opts.push(`<optgroup label="Claude Code">${claudeGroups.flatMap((g) => g.models.map((m) => option(m, DEFAULT_ENGINE))).join('')}</optgroup>`);
  else opts.push(`<optgroup label="Claude Code">${infoOption(claude.length ? 'Tidak ada model yang cocok' : 'Katalog Claude Code belum tersedia')}</optgroup>`);
  // OpenCode: one group PER provider (river, opencode-go, …), each labelled by the provider's display name when
  // known; an <optgroup> cannot nest another, so the "OpenCode" wrapper only remains for the info lines. A group
  // whose provider has no stored credentials renders its models disabled with the login hint — the model that is
  // the project's current one stays selectable (changing away from it must still be possible).
  const groups = openCodeProviderGroups(opencode, query, providerNames, providerAuth);
  let open = '';
  if (loading && !opencode.length) open = infoOption('⏳ Memuat daftar model…');
  else if (error && !opencode.length) open = infoOption(`⚠ Daftar model gagal dimuat: ${error}`, 'Coba lagi dengan ↻ Cek ulang di dialog ini, atau pastikan OpenCode terpasang dan berjalan.');
  else if (!opencode.length) open = infoOption('📭 Muncul setelah pesan pertama', 'Kirim satu prompt untuk memulai sesi OpenCode — daftar modelnya langsung terisi di sini.');
  else if (!groups.length) open = infoOption(query ? 'Tidak ada model yang cocok' : 'Daftar model muncul setelah pesan pertama', query ? 'Coba kata kunci lain, atau kosongkan kotak pencarian.' : 'Kirim satu prompt untuk memulai sesi OpenCode.');
  else {
    open = groups.map((g) => {
      // Connected groups carry their model count; a login-less group keeps its hint instead (one message, one line).
      const label = g.connected ? `${g.label} (${g.models.length})` : `${g.label} (belum login)`;
      const gate = (m) => (g.connected || m.value === current ? option(m, 'opencode') : option({ ...m, name: `${m.name} ⚠` }, 'opencode', LOGIN_HINT));
      return `<optgroup label="${escapeHtml(label)}">${g.models.map(gate).join('')}</optgroup>`;
    }).join('');
  }
  if (open && !groups.length) opts.push(`<optgroup label="OpenCode">${open}</optgroup>`);
  else if (open) opts.push(open);
  // A model set with /model that neither list holds (e.g. opus[1m]) stays selectable on the project's engine.
  const known = claude.some((m) => m.value === current) || opencode.some((m) => m.value === current);
  if (current && !known) opts.push(option({ value: current, name: current }, engine));
  return opts.join('');
}

/** A disabled line that explains an empty/still-loading group (never selectable): short text, the full guidance in
 *  its tooltip — an <option> truncates, so the actionable part must fit one line. */
const infoOption = (text, hint = '') => `<option value="" disabled data-info${hint ? ` title="${escapeHtml(hint)}"` : ''}>${escapeHtml(text)}</option>`;

/** Number of models (both engines) matching the search box. */
export const catalogMatchCount = (catalog, query) =>
  groupModels(claudeCatalogModels(catalog), query).reduce((n, g) => n + g.models.length, 0) +
  groupModels(catalog?.opencode?.models ?? [], query).reduce((n, g) => n + g.models.length, 0);

/** The model (either engine's list) a select value points to; used for its own effort levels. */
export function modelEntry(catalog, value) {
  if (!value) return null;
  return [...claudeCatalogModels(catalog), ...(catalog?.opencode?.models ?? [])].find((m) => m.value === value) ?? null;
}

// ---------- Model Auto ladder (per-project tiers, edited in #model-tiers-modal) ----------

/** From cheapest to strongest, in the order the dialog lists them (mirrors src/model-auto.js). */
export const MODEL_TIERS = ['hemat', 'seimbang', 'kuat', 'maks'];
export const MODEL_TIER_LABELS = { hemat: 'Hemat', seimbang: 'Seimbang', kuat: 'Kuat', maks: 'Maks' };

/**
 * What each tier runs until the project sets its own ladder (the same defaults as src/model-auto.js). The server
 * ignores a model the project's engine cannot run, so the note never promises something the turn won't do.
 */
export const DEFAULT_MODEL_TIERS = Object.freeze({
  claude: Object.freeze({ hemat: 'haiku', seimbang: 'sonnet', kuat: 'opus', maks: 'fable' }),
  opencode: Object.freeze({
    hemat: 'opencode-go/deepseek-v4.1-flash',
    seimbang: 'opencode-go/glm-5.3-flash',
    kuat: 'opencode-go/deepseek-v4-pro',
    maks: 'opencode-go/glm-5.3',
  }),
});

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanValue = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

/** A model id the dialog may send: '' clears the slot, anything else has no spaces/controls and fits an id. */
export const isModelValue = (v) => v === '' || (typeof v === 'string' && v.length <= 200 && /^[\w][\w.:@/+-]*$/.test(v));

/** The defaults of an engine; an unknown engine falls back to Claude's (never to an id the engine cannot run). */
export const defaultModelTiers = (engine) => ({ ...(DEFAULT_MODEL_TIERS[engine] ?? DEFAULT_MODEL_TIERS.claude) });

/**
 * A project's ladder, validated: `status.modelTiers[engine]` merged over the defaults. Only string values are kept
 * (never trust the server blindly), and an empty/unknown slot shows the default — which is exactly what the server
 * applies, so the row and the note always agree with the model a turn will really use.
 */
export function modelTiersFor(st, engine) {
  const stored = isMap(st?.modelTiers) && isMap(st.modelTiers[engine]) ? st.modelTiers[engine] : {};
  const tiers = defaultModelTiers(engine);
  for (const key of MODEL_TIERS) {
    const value = cleanValue(stored[key]);
    if (value) tiers[key] = value;
  }
  return tiers;
}

/** "opencode-go/glm-5.3" → "glm-5.3": the provider prefix says nothing in the one-line Auto note (src/model-auto.js). */
export function shortModelName(model) {
  const raw = cleanValue(model);
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

/** The ladder in one compact line: "Hemat haiku · Seimbang sonnet · Kuat opus · Maks fable". */
export const tierLadder = (tiers) => MODEL_TIERS.map((key) => `${MODEL_TIER_LABELS[key]} ${shortModelName(tiers?.[key])}`).join(' · ');

/** The muted line under the Model control while Auto is on: the ladder, then the model the classifier last picked. */
export const autoModelNote = (tiers, model) =>
  [`Model dipilih otomatis: ${tierLadder(tiers)}.`, model ? `Sekarang: ${shortModelName(model)}.` : ''].filter(Boolean).join(' ');

/**
 * The <option>s of one tier row: "Bawaan (<default>)" (value '') first, then the models the engine offers — grouped
 * per provider for a per-project list (OpenCode) — and the row's own model when the list doesn't hold it.
 */
export function tierOptionsHtml(tier, engine, models, current, { grouped = false } = {}) {
  const list = Array.isArray(models) ? models : [];
  const fallback = (DEFAULT_MODEL_TIERS[engine] ?? DEFAULT_MODEL_TIERS.claude)[tier] ?? '';
  const option = (m) => `<option value="${escapeHtml(m.value)}" title="${escapeHtml(m.value)}">${escapeHtml(m.name || shortModelName(m.value))}</option>`;
  const opts = [`<option value="">Bawaan${fallback ? ` (${escapeHtml(shortModelName(fallback))})` : ''}</option>`];
  if (grouped) for (const g of groupModels(list)) opts.push(`<optgroup label="${escapeHtml(g.provider)}">${g.models.map(option).join('')}</optgroup>`);
  else for (const m of list) opts.push(option(m));
  if (current && !list.some((m) => m.value === current)) opts.push(option({ value: current, name: current }));
  return opts.join('');
}

export function initEngine({ onModelPicked, rerender }) {
  const search = $('#model-search');
  search.addEventListener('input', rerender);
  // The panel's combobox: arrows highlight rows, Enter applies the highlighted one, Esc clears the filter.
  search.addEventListener('keydown', (e) => {
    const groupsEl = $('#model-groups');
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation(); // Esc clears the filter, not the running turn
      search.value = '';
      rerender();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!groupsEl) return;
      const rows = mpRows(groupsEl);
      if (!rows.length) return;
      const at = Number(groupsEl.dataset.mpIndex ?? -1);
      const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : rows.length - 1;
      mpHighlight(groupsEl, next);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const row = mpRows(groupsEl)[Number(groupsEl?.dataset.mpIndex ?? -1)] ?? mpRows(groupsEl)[0];
    if (!row) return toast('Tidak ada model yang cocok.', 'warn');
    if (mpApplyRow(row)) {
      search.value = '';
      rerender();
    } else {
      toast('Tidak ada model yang cocok.', 'warn');
    }
  });
}
