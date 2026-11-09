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
  router.post('/api/projects/:id/settings', withSession(({ hub }, req, res, { project, session }, body) => {
    // The engine has its own guarded route (POST /api/projects/:id/engine, below): switching starts another
    // engine's process and shows its history, which a settings patch must never do silently.
    const { engine: _engine, ...patch } = body ?? {};
    hub.updateSettings(project.id, patch);
    // Picking a model (or Default) answers the "provider logged out" warning (routes/account.js modelStale):
    // the same field clears it, so the next prompt is let through even when the model is unchanged.
    if (patch.model !== undefined || patch.modelAuto !== undefined) hub.setStatus(project.id, { modelStale: false });
    session.syncSettings(); // switches the running Claude Code live (mid-turn too, like Shift+Tab)
    return json(res, 200, { ok: true });
  }));
  // 🔀 Stage 1: this project changes engine. Both engines' histories stay; only the shown one changes. Refused
  // (409) while the project works, waits in 📋 Antrian, has an open approval, or a cut-short turn to continue.
  // Laptop/Tailscale only: it starts another agent process on this machine.
  router.post('/api/projects/:id/engine', withProject((ctx, req, res, { project }, body) => {
    if (!ctx.canManageAccount?.(req)) return json(res, 403, { error: 'Ganti mesin hanya dari laptop atau lewat Tailscale.' });
    const engine = String(body?.engine ?? '');
    if (!ENGINES.includes(engine)) return json(res, 400, { error: 'Mesin tidak dikenal.' });
    const result = body?.afterTurn === true
      ? ctx.sessions.queueEngineSwitch(project, engine)
      : ctx.sessions.setProjectEngine(project, engine);
    if (!result.ok) return json(res, result.status ?? 409, { error: result.error, ...(result.busy && { busy: result.busy }) });
    return json(res, 200, { ok: true, engine: result.engine, ...(result.queued && { queued: true, enginePending: result.enginePending }) });
  }));
  // The model picker of a non-Claude engine (OpenCode: `opencode models` for the providers set up on this laptop).
  router.post('/api/projects/:id/models', withSession(async ({ hub, opencode, sessions }, req, res, { project }) => {
    const s = hub.settingsFor(project.id);
    if (s.engine !== 'opencode') return json(res, 200, { engine: s.engine, models: [], current: s.model, needsStart: false });
    let values = await openCodeModels(opencode);
    // `opencode models` empty (its service just started, catalog still loading): the models a running ACP session of
    // any project offers (configOptions "model") are the same list, so the picker isn't left empty meanwhile.
    if (!values.length) values = modelsOffered(sessions.sessions.values());
    // each model's own effort levels (null = unknown: the picker offers the generic list and the nearest is used)
    const efforts = await openCodeModelEfforts(opencode);
    const models = values.map((value) => ({ value, name: `${value.slice(value.indexOf('/') + 1)}${/free/i.test(value) ? ' (gratis)' : ''}`, efforts: efforts.has(value) ? efforts.get(value) : null }));
    // An empty list (OpenCode still starting, or `opencode models` failed): the picker asks again shortly.
    return json(res, 200, { engine: 'opencode', models, current: s.model, needsStart: !models.length });
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
