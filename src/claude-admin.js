// 🧩 Ekstensi Claude Code without the terminal: plugins (`claude plugin …`), your own subagents (.claude/agents/*.md)
// and a view of the hooks in the settings files. Plugins go through Claude Code's own CLI (it owns their config);
// agents are plain Markdown files with front matter, written only at the two fixed agent folders.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileTree } from './proc.js';

export class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Runs the claude CLI without a terminal; resolves { ok, out, err } (never rejects on a non-zero exit). */
export function runClaude(bin, args, { cwd, timeout = 120_000 } = {}) {
  if (!bin) return Promise.reject(new AdminError(404, 'Claude Code tidak ditemukan.'));
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1' } }, (error, out, err) => {
      const strip = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      resolve({ ok: !error, timedOut: Boolean(error?.killed), out: strip(out), err: strip(err) });
    });
  });
}

const firstLine = (r) => `${r.err}\n${r.out}`.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('at ')) ?? 'Gagal.';

// ---------- plugins ----------

// First character a letter or digit: the id is a CLI argument and must never read as an option ("--x").
const PLUGIN_ID = /^[A-Za-z0-9][\w.@/-]{0,199}$/;
let pluginCache = null; // { at, data } — the marketplace list is large (thousands) and changes rarely

/** Installed plugins + the marketplace catalog (cached 5 min; any change clears it). */
export async function listPlugins(bin, { force = false } = {}) {
  if (!force && pluginCache && Date.now() - pluginCache.at < 5 * 60_000) return pluginCache.data;
  const r = await runClaude(bin, ['plugin', 'list', '--json', '--available'], { timeout: 120_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    throw new AdminError(502, 'Daftar plugin tidak terbaca.');
  }
  const installed = (parsed.installed ?? []).map((p) => ({ id: p.id, version: p.version ?? '', scope: p.scope ?? '', enabled: p.enabled !== false }));
  const have = new Set(installed.map((p) => p.id));
  const available = (parsed.available ?? [])
    .filter((p) => p?.pluginId && !have.has(p.pluginId))
    .map((p) => ({ id: p.pluginId, name: p.name ?? p.pluginId, description: String(p.description ?? '').slice(0, 300), installs: p.installCount ?? p.installs ?? null }));
  pluginCache = { at: Date.now(), data: { installed, available } };
  return pluginCache.data;
}

/**
 * install | uninstall | enable | disable. An install whose marketplace declares a command to run is not accepted
 * blindly: the command comes back (needsConfirm) and only runs after the user saw it (acceptCommand = its sha256).
 */
export async function pluginAction(bin, { action, id, scope = 'user', acceptCommand = null, cwd }) {
  if (!['install', 'uninstall', 'enable', 'disable'].includes(action)) throw new AdminError(400, 'Aksi plugin tidak dikenal.');
  if (!PLUGIN_ID.test(String(id ?? ''))) throw new AdminError(400, 'Id plugin tidak valid.');
  const args = ['plugin', action, id, '--json'];
  if (action === 'install') {
    args.push('-s', ['user', 'project', 'local'].includes(scope) ? scope : 'user');
    if (acceptCommand) {
      if (!/^[0-9a-f]{64}$/i.test(acceptCommand)) throw new AdminError(400, 'Konfirmasi perintah tidak valid.');
      args.push('--accept-command', acceptCommand);
    }
  }
  const r = await runClaude(bin, args, { cwd, timeout: 300_000 });
  pluginCache = null;
  let result = null;
  try {
    result = JSON.parse(r.out.trim().split('\n').at(-1));
  } catch {
    // older CLI: plain text
  }
  const shown = result?.shownCommand;
  if (!r.ok && shown?.sha256) return { ok: false, needsConfirm: true, command: String(shown.command ?? shown.display ?? '').slice(0, 2000), sha256: shown.sha256 };
  if (!r.ok) throw new AdminError(502, result?.error ?? result?.message ?? firstLine(r));
  return { ok: true, message: result?.message ?? firstLine({ out: r.out, err: '' }) };
}

// ---------- your own subagents (.claude/agents/*.md) ----------

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,49}$/;

const agentDir = (scope, projectPath, home = os.homedir()) => (scope === 'user' ? path.join(home, '.claude', 'agents') : path.join(projectPath, '.claude', 'agents'));

/** "---\nname: x\ndescription: y\n---\nprompt" → { meta, prompt } (simple key: value front matter). */
export function parseAgent(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return { meta: {}, prompt: String(text) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, prompt: m[2] };
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/** The agents of a project (scope project) and the user's (scope user). */
export function listAgents(projectPath, home) {
  const out = [];
  for (const scope of ['project', 'user']) {
    const dir = agentDir(scope, projectPath, home);
    let names = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of names) {
      try {
        const file = path.join(dir, f);
        if (statSync(file).size > 256 * 1024) continue;
        const { meta, prompt } = parseAgent(readFileSync(file, 'utf8'));
        out.push({ scope, file: f, name: meta.name || f.slice(0, -3), description: meta.description ?? '', tools: meta.tools ?? '', model: meta.model ?? '', prompt });
      } catch {
        // unreadable: skipped
      }
    }
  }
  return out;
}

/** Creates or replaces <dir>/<name>.md. Renaming removes the old file (same scope). */
export function saveAgent(projectPath, { scope, name, previous, description, tools = '', model = '', prompt }, home) {
  const sc = scope === 'user' ? 'user' : 'project';
  if (!AGENT_NAME.test(String(name ?? ''))) throw new AdminError(400, 'Nama agent: huruf kecil, angka dan minus (maks 50), mis. code-reviewer.');
  if (!oneLine(description)) throw new AdminError(400, 'Deskripsi wajib: Claude memakainya untuk memilih kapan agent ini dipanggil.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new AdminError(400, 'Instruksi (system prompt) agent kosong.');
  if (Buffer.byteLength(prompt) > 200 * 1024) throw new AdminError(413, 'Instruksi terlalu panjang.');
  if (tools && !/^[\w*(),.: -]{1,500}$/.test(tools)) throw new AdminError(400, 'Daftar tools: nama dipisah koma, mis. Read, Grep, Glob.');
  if (model && !/^[\w.[\]-]{1,60}$/.test(model)) throw new AdminError(400, 'Model tidak valid.');
  const dir = agentDir(sc, projectPath, home);
  mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: ${oneLine(description)}`, ...(tools ? [`tools: ${oneLine(tools)}`] : []), ...(model ? [`model: ${model}`] : []), '---', '', prompt.trim(), ''];
  const file = path.join(dir, `${name}.md`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join('\n'), 'utf8');
  renameSync(tmp, file);
  if (previous && previous !== name && AGENT_NAME.test(previous)) rmSync(path.join(dir, `${previous}.md`), { force: true });
  return { scope: sc, name };
}

export function deleteAgent(projectPath, { scope, name }, home) {
  if (!AGENT_NAME.test(String(name ?? ''))) throw new AdminError(400, 'Nama agent tidak valid.');
  rmSync(path.join(agentDir(scope === 'user' ? 'user' : 'project', projectPath, home), `${name}.md`), { force: true });
  return { ok: true };
}

// ---------- hooks (read-only view) ----------

/** The hooks configured in each settings file (user, project, local): [{ source, event, matcher, commands }]. */
export function listHooks(projectPath, home = os.homedir()) {
  const files = [
    ['Semua project (~/.claude/settings.json)', path.join(home, '.claude', 'settings.json')],
    ['Project (.claude/settings.json)', path.join(projectPath, '.claude', 'settings.json')],
    ['Project, pribadi (.claude/settings.local.json)', path.join(projectPath, '.claude', 'settings.local.json')],
  ];
  const out = [];
  for (const [source, file] of files) {
    let hooks;
    try {
      hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
    } catch {
      continue;
    }
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        const commands = (g?.hooks ?? []).map((h) => (h?.type === 'command' ? String(h.command ?? '') : `${h?.type ?? '?'}${h?.url ? ` ${h.url}` : ''}`)).filter(Boolean);
        out.push({ source, file, event, matcher: String(g?.matcher ?? '') || '(semua)', commands: commands.map((c) => c.slice(0, 500)) });
      }
    }
  }
  return out;
}
