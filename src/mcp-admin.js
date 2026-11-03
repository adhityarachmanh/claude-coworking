// 🔌 MCP servers without the terminal: add one (`claude mcp add` / `opencode mcp add`, the CLIs write their own config)
// and, for OpenCode, list the configured ones (its live status is only known inside its process).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from './opencode-bin.js';

export class McpAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME = /^[\w.-]{1,60}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,60}=.{0,2000}$/;

/** A command line → argv (spaces split, "double" / 'single' quotes group); no shell is ever involved. */
export function splitArgs(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const c of String(line ?? '')) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") (quote = c), (has = true);
    else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Validated request → { name, url } for a remote server or { name, argv } for a local one. */
function cleanRequest({ name, kind, command, url, env = [], scope }) {
  if (!NAME.test(String(name ?? ''))) throw new McpAdminError(400, 'Nama server: huruf, angka, titik, minus atau garis bawah (maks 60).');
  const envs = (Array.isArray(env) ? env : []).map((e) => String(e).trim()).filter(Boolean);
  if (envs.some((e) => !ENV.test(e))) throw new McpAdminError(400, 'Variabel lingkungan harus berbentuk NAMA=nilai.');
  const sc = ['local', 'project', 'user'].includes(scope) ? scope : 'local';
  if (kind === 'remote') {
    let u;
    try {
      u = new URL(String(url ?? ''));
    } catch {
      throw new McpAdminError(400, 'URL server tidak valid.');
    }
    if (!['https:', 'http:'].includes(u.protocol)) throw new McpAdminError(400, 'URL server harus http(s).');
    return { name, url: u.href, envs, scope: sc };
  }
  const argv = splitArgs(command);
  if (!argv.length || argv.length > 50) throw new McpAdminError(400, 'Perintah server kosong.');
  return { name, argv, envs, scope: sc };
}

/**
 * Adds a server to the engine's config through its own CLI. Claude Code: `claude mcp add` (scope local / project /
 * user). OpenCode: `opencode mcp add` (project config, or the global one for scope "user").
 */
export function addMcpServer({ engine, bin, projectPath, request }) {
  if (!bin) return Promise.reject(new McpAdminError(404, 'CLI mesin ini tidak ditemukan.'));
  const r = cleanRequest(request ?? {});
  const args = [...bin.args, 'mcp', 'add'];
  if (engine === 'opencode') {
    if (r.scope === 'user') args.push('--global');
    for (const e of r.envs) args.push('--env', e);
    args.push(r.name);
    if (r.url) args.push('--url', r.url);
    else args.push('--', ...r.argv);
  } else {
    args.push('-s', r.scope);
    for (const e of r.envs) args.push('-e', e);
    if (r.url) args.push('--transport', 'http', r.name, r.url);
    else args.push(r.name, '--', ...r.argv);
  }
  return new Promise((resolve, reject) => {
    execFile(bin.command, args, { cwd: projectPath, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, CI: '1', NO_COLOR: '1' } }, (err, out, errOut) => {
      const text = `${out ?? ''}\n${errOut ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      if (err) return reject(new McpAdminError(502, text.split('\n').find((l) => l.trim() && !/^\s+at /.test(l))?.slice(0, 300) || 'Menambah server MCP gagal.'));
      resolve({ ok: true, output: text.slice(0, 2000) });
    });
  });
}

/**
 * OpenCode's configured MCP servers (global ~/.config/opencode and the project's opencode.json / .opencode/), as
 * the /mcp dialog lists them: status "configured" (connected or not is only known inside OpenCode).
 */
export function listOpenCodeMcp(projectPath, home = os.homedir()) {
  const byName = new Map();
  const layers = [
    ['user', path.join(home, '.config', 'opencode')],
    ['project', projectPath],
    ['project', projectPath && path.join(projectPath, '.opencode')],
  ];
  for (const [scope, dir] of layers) {
    if (!dir) continue;
    for (const file of ['opencode.json', 'opencode.jsonc', 'config.json']) {
      let cfg;
      try {
        cfg = parseJsonc(readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      const mcp = cfg?.mcp?.servers ?? cfg?.mcp; // v2: mcp.servers; v1: mcp is the map itself
      if (!mcp || typeof mcp !== 'object') continue;
      for (const [name, s] of Object.entries(mcp)) {
        if (!s || typeof s !== 'object' || name === 'servers' || name === 'timeout') continue;
        const remote = s.type === 'remote' || typeof s.url === 'string';
        byName.set(name, {
          name,
          scope,
          status: s.enabled === false ? 'disabled' : 'configured',
          type: remote ? 'remote' : 'local',
          detail: remote ? String(s.url ?? '') : (Array.isArray(s.command) ? s.command.join(' ') : String(s.command ?? '')).slice(0, 200),
        });
      }
    }
  }
  return [...byName.values()];
}
