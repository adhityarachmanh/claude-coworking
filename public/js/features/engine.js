// The engine (Claude Code / OpenCode, docs/design-opencode.md; chosen app-wide in 👤 Akun, features/opencode-account.js):
// the per-project model list of a non-Claude engine (searchable, grouped by provider), and the cap guards that
// every feature asks before opening something the engine can't do. Rules live in core/engine-caps.js.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { capReason, capsFor, cleanModelList, engineLabel, engineOf, groupModels, modelsPerProject } from '../core/engine-caps.js';
import { auth, DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';

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

// ---------- per-project models (OpenCode: ~144, from GET /api/projects/:id/models) ----------

/** project id → { engine, models, current, needsStart, at, loading, error } */
const modelCache = new Map();
const RETRY_EMPTY_MS = 4000; // the list appears once the engine has started a session
const EMPTY_TRIES = 6; // empty answers asked again without a prompt (about 25 s of OpenCode starting up)
const RETRY_ERROR_MS = 30_000;

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

/** The cached list for the project's engine (null = not loaded yet); fetches when missing or stale. */
export function projectModels(id, st = state.statuses[id] ?? {}, onLoaded = () => {}) {
  const engine = engineOf(st, state.config);
  if (!modelsPerProject(engine) || !id || id === DEMO_ID) return null;
  let entry = modelCache.get(id);
  if (entry && entry.engine !== engine) entry = null;
  const now = Date.now();
  // An empty list is asked again shortly (OpenCode may still be starting), a few times before waiting for a prompt.
  const retryEmpty = entry && !entry.error && entry.needsStart && now - entry.at > RETRY_EMPTY_MS && ((entry.tries ?? 0) < EMPTY_TRIES || st.sessionId || st.alive);
  const stale = !entry || (!entry.loading && ((entry.error && now - entry.at > RETRY_ERROR_MS) || retryEmpty));
  if (stale && !state.readOnly) {
    entry = { engine, models: entry?.models ?? [], current: entry?.current ?? '', needsStart: entry?.needsStart ?? true, at: now, loading: true, error: null, tries: (entry?.tries ?? 0) + 1 };
    modelCache.set(id, entry);
    const mine = entry;
    fetchModels(id)
      .then((data) => Object.assign(mine, cleanModelList(data), { error: null }))
      .catch((err) => Object.assign(mine, { error: err.message }))
      .finally(() => {
        Object.assign(mine, { loading: false, at: Date.now() });
        if (modelCache.get(id) !== mine) return;
        onLoaded();
        // still empty: render again after the retry delay, which asks once more (up to EMPTY_TRIES)
        if (!mine.error && mine.needsStart && mine.tries < EMPTY_TRIES) setTimeout(() => modelCache.get(id) === mine && onLoaded(), RETRY_EMPTY_MS + 200);
      });
  }
  return entry ?? { engine, models: [], current: '', needsStart: true, loading: false, error: state.readOnly ? READ_ONLY_HINT : null };
}

/**
 * Options for the #model select from a per-project list: "Default (dari config <Engine>)", one <optgroup> per
 * provider, the search filter applied; the current model always stays (selected, even when filtered out).
 */
export function projectModelOptions(entry, current, query) {
  const label = engineLabel(entry.engine);
  const opts = [`<option value="">Default (dari config ${escapeHtml(label)})</option>`];
  if (entry.loading && !entry.models.length) opts.push('<option value="" disabled data-info>Memuat daftar model…</option>');
  else if (entry.error && !entry.models.length) opts.push(`<option value="" disabled data-info>Daftar model gagal dimuat: ${escapeHtml(entry.error)}</option>`);
  else if (!entry.models.length) opts.push('<option value="" disabled data-info>Daftar model muncul setelah pesan pertama</option>');
  const groups = groupModels(entry.models, query);
  let shown = false;
  for (const g of groups) {
    opts.push(`<optgroup label="${escapeHtml(g.provider)}">${g.models.map((m) => `<option value="${escapeHtml(m.value)}" title="${escapeHtml(m.value)}">${escapeHtml(m.name)}</option>`).join('')}</optgroup>`);
    shown ||= g.models.some((m) => m.value === current);
  }
  if (query && entry.models.length && !groups.length) opts.push('<option value="" disabled data-info>Tidak ada model yang cocok</option>');
  if (current && !shown) opts.push(`<option value="${escapeHtml(current)}">${escapeHtml(entry.models.find((m) => m.value === current)?.name ?? current)}</option>`);
  return opts.join('');
}

/** Number of models matching the search box (for its live count). */
export const matchCount = (entry, query) => groupModels(entry.models, query).reduce((n, g) => n + g.models.length, 0);

export function initEngine({ onModelPicked, rerender }) {
  const search = $('#model-search');
  search.addEventListener('input', rerender);
  // Enter picks the first match (the search is a filter for the select next to it).
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation(); // Esc clears the filter, not the running turn
      search.value = '';
      rerender();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = [...$('#model').options].find((o) => o.value && !o.disabled && o.parentElement.tagName === 'OPTGROUP');
    if (!first) return toast('Tidak ada model yang cocok.', 'warn');
    $('#model').value = first.value;
    search.value = '';
    onModelPicked();
  });
}
