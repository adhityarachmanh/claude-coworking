// ---------- the project list: folders to scan, added folders, per-project settings ----------
// /api/projects and /api/config point Claude Code (and git, file search) at any path: laptop only (LOCAL_ONLY in
// server.js). Opening VS Code / Explorer (`open`) is laptop only too (LOCAL_ONLY_ACTION).
import { modelsOffered, openCodeModelEfforts, openCodeModels } from '../opencode-bin.js';
import path from 'node:path';
import { ENGINES } from '../hub.js';
import { readModelPrices } from '../model-prices.js';
import { isDirectory, isMissing, isNetworkPath } from '../projects.js';
import { openInApp } from '../open.js';
import { observedPrices } from '../usage.js';import { json } from './http.js';
import { withProject, withSession } from './project.js';

// The turn settings picker's cost per model: list prices for OpenCode Go, a blended effective price from the
// usage ledger for everything else. Not on the plain-WiFi read allowlist (src/remote.js): laptop + Tailscale only.
const PRICE_DAYS = 90;
// One model list per project for a moment: the picker is opened on every device/settings render, and each render
// used to spawn `opencode models` again. Short (30 s) so a provider login shows up almost at once.
const MODEL_CACHE_MS = 30_000;
const openCodeListCache = new Map(); // project id -> { at, data: { models, needsStart } }

const asBody = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

/** Claude Code's models from the app's catalog (`initialize`), in the picker's shape ({ value, name, efforts }). */
function claudeModelOptions(hub) {
  const stored = hub.persisted?.catalog?.models;
  const list = Array.isArray(stored) && stored.length ? stored : (hub.config?.models ?? []);
  return (Array.isArray(list) ? list : [])
    .filter((m) => typeof m?.value === 'string' && m.value)
    .map((m) => ({ value: m.value, name: typeof m.displayName === 'string' && m.displayName ? m.displayName : (typeof m.name === 'string' && m.name ? m.name : m.value), efforts: Array.isArray(m.efforts) ? m.efforts : null }));
}

/** OpenCode's models (with each one's own effort levels), cached per project for at most MODEL_CACHE_MS. */
async function openCodeModelOptions({ opencode, sessions }, id) {
  const now = Date.now();
  for (const [key, entry] of openCodeListCache) if (now - entry.at > MODEL_CACHE_MS * 4) openCodeListCache.delete(key);
  const hit = openCodeListCache.get(id);
  if (hit && now - hit.at < MODEL_CACHE_MS) return hit.data;
  let values = await openCodeModels(opencode);
  // `opencode models` empty (its service just started, catalog still loading): the models a running ACP session of
  // any project offers (configOptions "model") are the same list, so the picker isn't left empty meanwhile.
  if (!values.length) values = modelsOffered(sessions.sessions.values());
  // each model's own effort levels (null = unknown: the picker offers the generic list and the nearest is used)
  const efforts = values.length ? await openCodeModelEfforts(opencode) : new Map();
  const models = values.map((value) => ({ value, name: `${value.slice(value.indexOf('/') + 1)}${/free/i.test(value) ? ' (gratis)' : ''}`, efforts: efforts.has(value) ? efforts.get(value) : null }));
  // An empty list (OpenCode still starting, or `opencode models` failed) is cached just the same: the picker asks
  // again after a moment, and one request never spawns the CLI twice.
  const data = { models, needsStart: !models.length };
  openCodeListCache.set(id, { at: now, data });
  return data;
}

/** Why this project may not move to `engine` right now (a 409 body), or null when it is safe. */
function engineSwitchRefusal({ hub, sessions, opencode, taskQueue }, project, engine) {
  const id = project.id;
  const name = project.name ?? id;
  if (engine === 'opencode' && !opencode) return { error: 'OpenCode belum terpasang di laptop ini.' };
  if (hub.legacyChats) return { error: 'Riwayat chat lama belum selesai dipindahkan (lihat log server). Restart aplikasi dulu, lalu coba lagi.' };
  // An open card first: its reason is the one the user can act on (a turn may run behind it anyway).
  if ([...hub.approvals.values()].some(({ approval }) => approval.project === id)) {
    return { error: 'Masih ada permintaan izin/rencana yang menunggu jawaban. Jawab dulu, lalu pilih model mesin lain.' };
  }
  const session = sessions.sessions.get(id);
  if (session && (session.turnActive() || session.busy || session.inflight?.size || session.rewinding)) {
    return { error: `Masih ada yang bekerja: ${name}. Tunggu giliran ini selesai, lalu pilih model mesin lain.`, busy: [name] };
  }
  if (hub.persisted.turns?.[id] || hub.persisted.interrupted?.[id]) {
    return { error: 'Ada giliran terputus ("Lanjutkan") di project ini. Lanjutkan atau abaikan dulu, lalu pilih model mesin lain.' };
  }
  const queue = taskQueue?.queues?.[id];
  if (queue?.items?.some((i) => i.status === 'waiting' || i.status === 'running')) {
    return { error: `📋 Antrian tugas masih berisi item: ${name}. Selesaikan atau hapus dulu, lalu pilih model mesin lain.`, busy: [name] };
  }
  return null;
}

export function register(router) {
  router.post('/api/models/prices', async ({ dataDir, ledger }, req, res, params, body) => {
    const to = Date.now();
    const from = body.from == null ? to - PRICE_DAYS * 86_400_000 : Number(body.from);
    if (!Number.isFinite(from) || from < 0 || from > to) return json(res, 400, { error: 'from harus waktu (epoch ms) yang tidak di masa depan.' });
    const catalog = await readModelPrices({ dataDir });
    // The picker's ids are the engine's model ids: OpenCode Go models are `opencode-go/<id>`.
    const prices = Object.entries(catalog.models)
      .map(([id, m]) => ({ model: `opencode-go/${id}`, name: m.name, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, peakFactor: m.peakFactor }))
      .sort((a, b) => a.model.localeCompare(b.model));
    // Aggregated only: no account identity is part of an observed price.
    const observed = observedPrices(ledger ? ledger.query({ accountId: 'all', from, to }) : []);
    return json(res, 200, { fetchedAt: catalog.fetchedAt, source: catalog.source || 'opencode.ai', stale: Boolean(catalog.stale), prices, observed });
  });
  router.post('/api/projects', ({ hub }, req, res, params, body) => {
    const dir = String(body.path ?? '').trim();
    if (isNetworkPath(dir)) return json(res, 400, { error: 'Folder jaringan (\\server\share) tidak didukung. Pakai folder di laptop ini.' });
    if (!path.isAbsolute(dir) || !isDirectory(dir)) return json(res, 400, { error: 'Folder tidak ditemukan' });
    return json(res, 200, hub.addCustomProject(dir));
  });
  router.post('/api/config', ({ hub, refreshProjects }, req, res, params, body) => {
    const roots = [...new Set((Array.isArray(body.roots) ? body.roots : []).map((r) => String(r).trim()).filter(Boolean))];
    const invalid = roots.filter((r) => !path.isAbsolute(r) || !isDirectory(r));
    if (invalid.length) return json(res, 400, { error: `Folder tidak ditemukan: ${invalid.join(', ')}` });
    hub.persisted.roots = roots.map((r) => path.resolve(r));
    hub.save();
    refreshProjects();
    return json(res, 200, hub.config);
  });
  router.post('/api/projects/refresh', ({ refreshProjects }, req, res) => {
    refreshProjects();
    return json(res, 200, { ok: true });
  });
}

/** Per-project actions; registered with the other /api/projects/:id routes (see index.js). */
export function registerProjectActions(router) {
  // Turn settings, including the engine: picking a model of the other engine makes that engine run the project
  // (there is no separate "switch" action any more). Refused (409) while this project is working, waits in
  // 📋 Antrian, has an open approval/plan card, or a cut-short turn to continue: two workspaces must not mix.
  router.post('/api/projects/:id/settings', withProject((ctx, req, res, { project }, body) => {
    const { hub, sessions } = ctx;
    const patch = asBody(body);
    const engine = patch.engine === undefined ? undefined : String(patch.engine);
    if (engine !== undefined && !ENGINES.includes(engine)) return json(res, 400, { error: 'Mesin tidak dikenal.' });
    if (engine !== undefined && engine !== hub.engineOf(project.id)) {
      const refusal = engineSwitchRefusal(ctx, project, engine);
      if (refusal) return json(res, 409, refusal);
    }
    const before = hub.settingsFor(project.id);
    hub.updateSettings(project.id, patch);
    // Picking a model (or Default) answers the "provider logged out" warning (routes/account.js modelStale):
    // the same field clears it, so the next prompt is let through even when the model is unchanged.
    if (patch.model !== undefined || patch.modelAuto !== undefined) hub.setStatus(project.id, { modelStale: false });
    let session;
    try {
      // Creates the target engine's session (and carries the old engine's chat over once) before the next prompt.
      session = sessions.get(project);
    } catch (err) {
      // Nothing may stay half-switched: put the settings (and the runtime chat) back where they were.
      if (engine !== undefined && hub.engineOf(project.id) !== before.engine) {
        hub.updateSettings(project.id, { ...before, engine: before.engine });
        hub.takeEngineFrom(project.id);
      }
      return json(res, err.status ?? 409, { error: err.message });
    }
    session.syncSettings(); // switches the running Claude Code live (mid-turn too, like Shift+Tab)
    return json(res, 200, { ok: true, engine: hub.engineOf(project.id) });
  }));
  // The model picker: both engines' models in one answer. The old fields (engine/models/current/needsStart) still
  // describe the RUNNING engine, so an older page keeps working; `engines` adds each engine's own list.
  router.post('/api/projects/:id/models', withSession(async ({ hub, opencode, sessions }, req, res, { project }) => {
    const s = hub.settingsFor(project.id);
    const claudeModels = claudeModelOptions(hub);
    const oc = await openCodeModelOptions({ hub, opencode, sessions }, project.id);
    const active = s.engine === 'opencode' ? { models: oc.models, needsStart: oc.needsStart } : { models: [], needsStart: false };
    return json(res, 200, {
      engine: s.engine,
      models: active.models,
      current: s.model,
      needsStart: active.needsStart,
      engines: {
        // Claude Code's models come with the app (its `initialize` catalog): nothing to ask the CLI here.
        claude: { models: claudeModels, current: s.engine === 'claude' ? s.model : hub.engineSettingsFor(project.id, 'claude').model, needsStart: !claudeModels.length },
        opencode: { models: oc.models, current: s.engine === 'opencode' ? s.model : hub.engineSettingsFor(project.id, 'opencode').model, needsStart: oc.needsStart },
      },
    });
  }));
  router.post('/api/projects/:id/favorite', withSession(({ hub }, req, res, { project }, body) => {
    hub.setFavorite(project.id, Boolean(body.on));
    return json(res, 200, { ok: true, favorite: Boolean(body.on) });
  }));
  // 🗂 Archive hides a project from the picker without touching its data or folder.
  router.post('/api/projects/:id/archive', withSession(({ hub }, req, res, { project }, body) => {
    const archived = hub.setProjectArchived(project.id, body.archived === true);
    return json(res, 200, { ok: true, archived });
  }));
  router.post('/api/projects/:id/forget', withSession(({ hub, sessions, taskQueue }, req, res, { project, session }) => {
    taskQueue.forget(project.id);
    session.reset();
    session.kill();
    sessions.sessions.delete(project.id);
    return json(res, hub.forgetProject(project.id) ? 200 : 400, { ok: true });
  }));
  // Removes a project that should never have been listed (e.g. a temp folder an old CLI session created): settings,
  // sessions, chat and its usage rows. Needs the exact id as confirmation; works even when the folder is already gone.
  router.post('/api/projects/:id/purge', ({ hub, ledger, sessions, taskQueue }, req, res, params, body) => {
    const id = String(params.id ?? '');
    if (!/^[0-9a-f]{8,32}$/.test(id)) return json(res, 400, { error: 'Project tidak valid.' });
    if (body?.confirm !== id) return json(res, 400, { error: 'Kirim confirm berisi project id untuk menghapus project ini.' });
    // Safety beyond the picker: only an orphan (folder gone, or no row at all) may be purged. Purging a project whose
    // folder still exists would throw away its settings/chat for no reason; the UI never offers it.
    const known = hub.projects.get(id);
    if (known && (!known.path || !isMissing(known.path))) {
      return json(res, 409, { error: 'Project ini masih punya folder. Purge hanya untuk project yang foldernya sudah tidak ditemukan.' });
    }
    const session = sessions.sessions.get(id);
    try {
      taskQueue.forget(id);
      session?.reset?.();
      session?.kill?.();
      sessions.sessions.delete(id);
    } catch {
      // the process may already be gone; the data below is what matters
    }
    const usage = ledger?.removeProject?.(id) ?? 0;
    hub.purgeProject(id);
    return json(res, 200, { ok: true, usage });
  });
  router.post('/api/projects/:id/open', withSession((ctx, req, res, { project }, body) => {
    const app = body.app === 'folder' ? 'folder' : 'code';
    // A file must resolve inside the project: never open arbitrary paths sent by a client.
    const file = body.file ? path.resolve(project.path, String(body.file)) : null;
    if (file && !file.startsWith(path.resolve(project.path) + path.sep)) return json(res, 400, { error: 'File di luar project.' });
    const line = Number.isInteger(body.line) && body.line > 0 && body.line < 1e7 ? body.line : null;
    return json(res, 200, { ok: true, ...openInApp(app, project.path, { file, line }) });
  }));
}
