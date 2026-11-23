// OpenCode maintenance the CLI normally does in a terminal: update, restart the background service, and import a
// session JSON. Everything runs through the same `opencode` binary the app already uses, never edits its config.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearSessionCache } from './opencode-bin.js';
import { childEnv } from './child-env.js';
import { openCodeApi } from './opencode-auth.js';
import { execFileTree } from './proc.js';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const PLUGIN_SPEC = /^[A-Za-z0-9@][^\s\u0000-\u001f]{0,299}$/;

const cleanPluginSpec = (value) => {
  const spec = String(value ?? '').trim();
  if (!PLUGIN_SPEC.test(spec)) throw new OpenCodeAdminError(400, 'Nama paket plugin tidak valid (tanpa spasi/opsi).');
  return spec;
};

export class OpenCodeAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
const firstLine = (r) => clean(`${r.output ?? ''}`).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('at ')) ?? 'Gagal.';

/** Runs one `opencode` CLI command without a shell; resolves { ok, timedOut, output } (never rejects). */
export function runOpenCode(bin, args, { cwd, timeout = 120_000 } = {}) {
  if (!bin) return Promise.reject(new OpenCodeAdminError(404, 'OpenCode tidak ditemukan.'));
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: childEnv({ CI: '1', NO_COLOR: '1' }) }, (error, out, err) => {
      resolve({ ok: !error, timedOut: Boolean(error?.killed), output: clean(`${out ?? ''}${err ? `\n${err}` : ''}`).slice(0, 20_000) });
    });
  });
}

/** `opencode upgrade` (the CLI's own updater). */
export function updateOpenCode(bin, { timeout = 300_000 } = {}) {
  return runOpenCode(bin, ['upgrade'], { timeout });
}

/** `opencode service restart`: the background service the ACP sessions and terminal share. */
export function restartOpenCodeService(bin, { timeout = 60_000 } = {}) {
  return runOpenCode(bin, ['service', 'restart'], { timeout });
}

/** The service actions the CLI offers (`opencode service …`). `status` is read-only; the rest change what runs. */
const SERVICE_ACTIONS = new Set(['start', 'restart', 'stop', 'status']);

/** `opencode service start|restart|stop|status`. Throws on failure; `status` output is plain text for the UI. */
export async function openCodeService(bin, action) {
  const act = String(action ?? '');
  if (!SERVICE_ACTIONS.has(act)) throw new OpenCodeAdminError(400, 'Aksi layanan tidak dikenal.');
  const r = await runOpenCode(bin, ['service', act], { timeout: act === 'status' ? 20_000 : 60_000 });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Layanan OpenCode (${act}) gagal: ${firstLine(r)}`);
  return { ok: true, action: act, output: r.output };
}

/** `opencode reload`: re-read the config without restarting the whole service. */
export async function reloadOpenCode(bin, { timeout = 60_000 } = {}) {
  const r = await runOpenCode(bin, ['reload'], { timeout });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Muat ulang config OpenCode gagal: ${firstLine(r)}`);
  return { ok: true, output: r.output };
}

/** `opencode debug paths` is a two-column text table ("data   C:\\…"): [{ label, path }]. */
export function parseDebugPaths(output) {
  const rows = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-z][\w-]{0,30})\s{2,}(.+)$/i);
    if (match) rows.push({ label: match[1].slice(0, 30), path: match[2].trim().slice(0, 400) });
  }
  return rows;
}

/** `opencode debug agents` prints a JSON array: keep the fields the UI shows (never the permissions body). */
export function parseDebugAgents(output) {
  let list;
  try {
    list = JSON.parse(String(output ?? ''));
  } catch {
    return [];
  }
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a.id === 'string' && /^[\w.-]{1,60}$/.test(a.id))
    .slice(0, 100)
    .map((a) => ({
      id: a.id,
      name: typeof a.name === 'string' ? a.name.slice(0, 80) : a.id,
      mode: a.mode === 'primary' || a.mode === 'subagent' ? a.mode : '',
      description: typeof a.description === 'string' ? a.description.slice(0, 200) : '',
      hidden: a.hidden === true,
    }));
}

/** `opencode stats` (shareable usage report): 0 = today, else the last N days, or lifetime with `all`. */
const STATS_DAYS = new Set([0, 1, 7, 30, 90]);
export async function openCodeStats(bin, { days = 7, all = false, models = false, cost = false, tools = false } = {}) {
  if (!bin) throw new OpenCodeAdminError(404, 'OpenCode tidak ditemukan.');
  const args = ['stats'];
  if (all) args.push('--all');
  else args.push('--days', String(STATS_DAYS.has(days) ? days : 7));
  if (models) args.push('--models');
  if (cost) args.push('--cost');
  if (tools) args.push('--tools');
  const r = await runOpenCode(bin, args, { timeout: 60_000 });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Statistik OpenCode gagal: ${firstLine(r)}`);
  return { ok: true, text: r.output.slice(0, 20_000) };
}

/** 🔍 Info OpenCode (what `opencode debug …` shows in a terminal): paths, agents and the service status. */export async function openCodeInfo(bin) {
  if (!bin) throw new OpenCodeAdminError(404, 'OpenCode tidak ditemukan.');
  const [paths, agents, service] = await Promise.all([
    runOpenCode(bin, ['debug', 'paths'], { timeout: 20_000 }).catch(() => ({ ok: false, output: '' })),
    runOpenCode(bin, ['debug', 'agents'], { timeout: 30_000 }).catch(() => ({ ok: false, output: '' })),
    runOpenCode(bin, ['service', 'status'], { timeout: 20_000 }).catch(() => ({ ok: false, output: '' })),
  ]);
  return {
    paths: parseDebugPaths(paths.output),
    agents: parseDebugAgents(agents.output),
    service: clean(service.output).slice(0, 4000),
  };
}

/** `opencode plugin list` is a small text table; parse its ID / VERSION / SOURCE columns. */
export function parsePluginList(output) {
  const rows = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || /^ID\s+VERSION\s+SOURCE$/i.test(text)) continue;
    const match = text.match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({ id: match[1].slice(0, 200), version: match[2].slice(0, 100), source: match[3].trim().slice(0, 300) });
  }
  return rows;
}

/** The configured plugins (`opencode plugin list`), laptop-only. */
export async function listOpenCodePlugins(bin) {
  const r = await runOpenCode(bin, ['plugin', 'list'], { timeout: 60_000 });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Daftar plugin OpenCode gagal: ${firstLine(r)}`);
  return parsePluginList(r.output);
}

export async function addOpenCodePlugin(bin, spec) {
  const clean = cleanPluginSpec(spec);
  const r = await runOpenCode(bin, ['plugin', 'add', clean], { timeout: 300_000 });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Pasang plugin gagal: ${firstLine(r)}`);
  return { ok: true, spec: clean, output: r.output };
}

export async function removeOpenCodePlugin(bin, spec) {
  const clean = cleanPluginSpec(spec);
  const r = await runOpenCode(bin, ['plugin', 'remove', clean], { timeout: 120_000 });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Hapus plugin gagal: ${firstLine(r)}`);
  return { ok: true, spec: clean, output: r.output };
}

export async function updateOpenCodePlugins(bin, spec = '') {
  const clean = spec ? cleanPluginSpec(spec) : '';
  const args = ['plugin', 'update', ...(clean ? [clean] : [])];
  const r = await runOpenCode(bin, args, { timeout: 300_000 });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Update plugin gagal: ${firstLine(r)}`);
  return { ok: true, spec: clean || null, output: r.output };
}

export async function checkOpenCodePlugins(bin) {
  const r = await runOpenCode(bin, ['plugin', 'check'], { timeout: 120_000 });
  if (!r.ok) throw new OpenCodeAdminError(r.timedOut ? 504 : 502, `Cek plugin gagal: ${firstLine(r)}`);
  return { ok: true, output: r.output };
}

/**
 * Imports OpenCode's own session JSON (`opencode session export`) through `opencode session import`. The JSON is
 * written to a throwaway file: the CLI takes a path, never stdin. Returns the new id when the CLI prints one.
 */
export async function importOpenCodeSession({ opencode, projectPath, data, timeout = 120_000 }) {
  if (!opencode) throw new OpenCodeAdminError(404, 'OpenCode belum terpasang.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new OpenCodeAdminError(400, 'File import harus berisi objek JSON sesi OpenCode.');
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_IMPORT_BYTES) throw new OpenCodeAdminError(413, 'File sesi terlalu besar (maks 20 MB).');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-opencode-import-'));
  const file = path.join(dir, 'session.json');
  let result;
  try {
    writeFileSync(file, json, 'utf8');
    result = await runOpenCode(opencode, ['session', 'import', file, '--directory', projectPath], { cwd: projectPath, timeout });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may still hold the file for a moment; a later import uses a fresh temp folder anyway.
    }
  }
  if (!result.ok) throw new OpenCodeAdminError(result.timedOut ? 504 : 502, `Import sesi OpenCode gagal: ${firstLine(result)}`);
  clearSessionCache(projectPath);
  const sessionId = result.output.match(/\bses_[\w-]{1,100}\b/)?.[0] ?? null;
  return { ok: true, sessionId, message: firstLine(result) };
}

// ---------- izin tersimpan ("Allow always") ----------

const SAVED_PERMISSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * `permission.saved.list` (OpenAPI): the durable "Allow always" entries. They are not per session, so the app shows
 * them all for this machine (an OpenCode project id is opaque to the app). Read-only.
 */
export async function listSavedPermissions(bin) {
  if (!bin) throw new OpenCodeAdminError(404, 'OpenCode tidak ditemukan.');
  const out = await openCodeApi(bin, 'permission.saved.list', { timeout: 60_000 });
  const rows = Array.isArray(out) ? out : Array.isArray(out?.data) ? out.data : [];
  return rows
    .filter((p) => p && typeof p.id === 'string' && typeof p.action === 'string' && typeof p.resource === 'string')
    .map((p) => ({
      id: p.id,
      projectID: String(p.projectID ?? ''),
      action: p.action.slice(0, 200),
      resource: p.resource.slice(0, 500),
      created: Number.isFinite(p.time?.created) ? p.time.created : null,
      updated: Number.isFinite(p.time?.updated) ? p.time.updated : null,
    }));
}

/** `permission.saved.remove`: forget one durable allow so the next matching call asks again. */
export async function removeSavedPermission(bin, id) {
  if (!bin) throw new OpenCodeAdminError(404, 'OpenCode tidak ditemukan.');
  const value = String(id ?? '');
  if (!SAVED_PERMISSION_ID.test(value)) throw new OpenCodeAdminError(400, 'ID izin tidak valid.');
  await openCodeApi(bin, 'permission.saved.remove', { params: { id: value }, timeout: 30_000 });
  return { removed: true };
}
