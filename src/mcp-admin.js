// 🔌 MCP servers without the terminal: add one (`claude mcp add` / `opencode mcp add`, the CLIs write their own config)
// and, for OpenCode, list the configured ones (its live status is only known inside its process).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openCodeConfigRoot } from './opencode-config.js';
import { parseJsonc } from './opencode-bin.js';
import { childEnv } from './child-env.js';
import { execFileTree } from './proc.js';

export class McpAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME = /^[A-Za-z0-9][\w.-]{0,59}$/; // never starts with "-": the name is a CLI argument
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,60}=.{0,2000}$/;
// `Name: value` (HTTP header): a token name, a colon, then anything but a line break (OpenCode `--header`).
const HEADER = /^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}):[ \t]*(.{0,2000})$/;
const HEADER_MAX = 20;

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

/** Validated request → { name, url, headers, transport } for a remote server or { name, argv } for a local one. */
function cleanRequest({ name, kind, command, url, env = [], headers = [], scope, transport }) {
  if (!NAME.test(String(name ?? ''))) throw new McpAdminError(400, 'Nama server: huruf, angka, titik, minus atau garis bawah (maks 60).');
  const envs = (Array.isArray(env) ? env : []).map((e) => String(e).trim()).filter(Boolean);
  if (envs.some((e) => !ENV.test(e))) throw new McpAdminError(400, 'Variabel lingkungan harus berbentuk NAMA=nilai.');
  const sc = ['local', 'project', 'user'].includes(scope) ? scope : 'local';
  const heads = (Array.isArray(headers) ? headers : []).map((h) => String(h ?? '').trim()).filter(Boolean);
  if (heads.length > HEADER_MAX) throw new McpAdminError(400, `Header HTTP maksimal ${HEADER_MAX}.`);
  if (heads.length && kind !== 'remote') throw new McpAdminError(400, 'Header HTTP hanya untuk server remote.');
  const clean = heads.map((h) => {
    const m = HEADER.exec(h);
    if (!m) throw new McpAdminError(400, 'Header HTTP harus berbentuk NAMA: nilai.');
    return `${m[1]}: ${m[2].trim()}`;
  });
  if (kind === 'remote') {
    let u;
    try {
      u = new URL(String(url ?? ''));
    } catch {
      throw new McpAdminError(400, 'URL server tidak valid.');
    }
    if (!['https:', 'http:'].includes(u.protocol)) throw new McpAdminError(400, 'URL server harus http(s).');
    return { name, url: u.href, envs, headers: clean, transport: transport === 'sse' ? 'sse' : 'http', scope: sc };
  }
  const argv = splitArgs(command);
  if (!argv.length || argv.length > 50) throw new McpAdminError(400, 'Perintah server kosong.');
  return { name, argv, envs, headers: [], transport: 'stdio', scope: sc };
}

/**
 * Adds a server to the engine's config through its own CLI. Claude Code: `claude mcp add` (scope local / project /
 * user). OpenCode: `opencode mcp add` (project config, or the global one for scope "user").
 *
 * 🔐 Secrets stay off the command line. `claude mcp add … -e KEY=VALUE` puts every value in argv, where another
 * process (Task Manager, `ps`) can read it. Claude Code 2.1.327+ accepts `mcp add-json <name> -`: the server JSON is
 * read from stdin, so tokens never appear as an argument. A request that carries an environment or a header therefore
 * goes that way; a request without one keeps the older argv form (works on every version and has nothing to hide).
 */
export async function addMcpServer({ engine, bin, projectPath, request }) {
  if (!bin) throw new McpAdminError(404, 'CLI di komputer ini tidak ditemukan.');
  const r = cleanRequest(request ?? {});
  // Claude + env/header → JSON over stdin (2.1.327+), so tokens stay out of argv. OpenCode has no stdin form: its
  // `--env`/`--header` stay on argv, and the UI says so.
  const viaJson = engine !== 'opencode' && (r.envs.length > 0 || r.headers.length > 0);
  const args = [...bin.args, 'mcp', ...(viaJson ? ['add-json', r.name, '-'] : ['add'])];
  if (!viaJson) {
    if (engine === 'opencode') {
      if (r.scope === 'user') args.push('--global');
      for (const e of r.envs) args.push('--env', e);
      for (const h of r.headers) args.push('--header', h);
      args.push(r.name);
      if (r.url) args.push('--url', r.url);
      else args.push('--', ...r.argv);
    } else {
      args.push('-s', r.scope);
      for (const e of r.envs) args.push('-e', e);
      for (const h of r.headers) args.push('-H', h);
      if (r.url) args.push('--transport', r.transport === 'sse' ? 'sse' : 'http', r.name, r.url);
      else args.push(r.name, '--', ...r.argv);
    }
  }
  const input = viaJson ? `${mcpServerJson(r)}\n` : null;
  return new Promise((resolve, reject) => {
    execFileTree(bin.command, args, { cwd: projectPath, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: childEnv({ CI: '1', NO_COLOR: '1' }), input }, (err, out, errOut) => {
      const text = `${out ?? ''}\n${errOut ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      if (err) return reject(new McpAdminError(502, text.split('\n').find((l) => l.trim() && !/^\s+at /.test(l))?.slice(0, 300) || 'Menambah server MCP gagal.'));
      resolve({ ok: true, output: text.slice(0, 2000), viaStdin: viaJson });
    });
  });
}

/**
 * The `mcpServers` JSON Claude Code reads from stdin: one server, this app's scope mapped to its own vocabulary
 * (`local` = this project only, `project` = shared .mcp.json, `user` = everywhere). Kept pure and exported: the shape
 * is the contract, so a test can prove the token is in the JSON and not in argv.
 */
export function mcpServerJson(r) {
  const server = r.url ? { type: r.transport === 'sse' ? 'sse' : 'http', url: r.url } : { type: 'stdio', command: r.argv[0], args: r.argv.slice(1) };
  // Values only: the NAME= is the CLI's argv syntax; JSON wants a map.
  server.env = Object.fromEntries(r.envs.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  if (r.headers?.length) server.headers = Object.fromEntries(r.headers.map((h) => [h.slice(0, h.indexOf(':')), h.slice(h.indexOf(':') + 1).trim()]));
  return JSON.stringify({ mcpServers: { [r.name]: server } });
}

/**
 * 🚪 Clears the OAuth credentials stored for one MCP server (`claude mcp logout` / `opencode mcp logout`).
 * Both engines use the same argument shape; the name is validated because it becomes an argv entry.
 */
export async function mcpLogout({ engine, bin, projectPath, name }) {
  if (!bin) throw new McpAdminError(404, 'CLI di komputer ini tidak ditemukan.');
  if (!NAME.test(String(name ?? ''))) throw new McpAdminError(400, 'Nama server tidak valid.');
  return new Promise((resolve, reject) => {
    execFileTree(bin.command, [...bin.args, 'mcp', 'logout', name], { cwd: projectPath, encoding: 'utf8', timeout: 30_000, windowsHide: true, env: childEnv({ CI: '1', NO_COLOR: '1' }) }, (err, out, errOut) => {
      const text = `${out ?? ''}\n${errOut ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      if (err) return reject(new McpAdminError(502, text.split('\n').find((l) => l.trim() && !/^\s+at /.test(l))?.slice(0, 300) || 'Logout server MCP gagal.'));
      resolve({ ok: true, output: text.slice(0, 2000) });
    });
  });
}

/**
 * OpenCode's configured MCP servers (the global opencode config folder and the project's opencode.json /
 * .opencode/), as the /mcp dialog lists them: status "configured" (connected or not is only known inside
 * OpenCode). The global folder honours OFFICE_OPENCODE_CONFIG_HOME/XDG_CONFIG_HOME (openCodeConfigRoot), so a
 * test or a portable install never reads the machine's own ~/.config/opencode.
 */
export function listOpenCodeMcp(projectPath, home = null) {
  const byName = new Map();
  const layers = [
    ['user', home ? path.join(home, '.config', 'opencode') : openCodeConfigRoot()],
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
          status: s.enabled === false || s.disabled === true ? 'disabled' : 'configured',
          type: remote ? 'remote' : 'local',
          detail: remote ? String(s.url ?? '') : (Array.isArray(s.command) ? s.command.join(' ') : String(s.command ?? '')).slice(0, 200),
        });
      }
    }
  }
  return [...byName.values()];
}
