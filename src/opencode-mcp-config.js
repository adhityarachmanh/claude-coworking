// 🔌 Advanced MCP server options (OpenCode 2.4.1): `disabled`, `codemode`, `pool`, `protocol`, `cwd` and the
// per-server `timeout` object live only in `opencode.json` — `opencode mcp add` has no flags for them. This module
// reads and writes those keys on ONE existing server, leaves every other key untouched, and keeps the file's
// scope (the project config where it was found, or the global one). Validation is pure so it can be tested alone.
export class OpenCodeMcpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const MCP_NAME = /^[A-Za-z0-9][\w.-]{0,59}$/; // same rule as `opencode mcp add`
export const PROTOCOLS = Object.freeze(['legacy', 'auto', '2026-07-28']);
const TRI = Object.freeze(['inherit', 'on', 'off']);
const TIMEOUTS = Object.freeze([
  ['timeoutStartup', 'startup', 'Startup'],
  ['timeoutCatalog', 'catalog', 'Katalog'],
  ['timeoutExecution', 'execution', 'Eksekusi'],
]);
const MAX_MS = 86_400_000; // 24 hours, far beyond every documented default
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const tri = (value) => (value === true ? 'on' : value === false ? 'off' : 'inherit');

/** The form payload for one server object; an absent key reads as "inherit" so opening the form changes nothing. */
export function mcpAdvancedFields(server = {}) {
  const timeout = isObject(server.timeout) ? server.timeout : {};
  const fields = {
    disabled: tri(server.disabled),
    codemode: tri(server.codemode),
    pool: tri(server.pool),
    protocol: PROTOCOLS.includes(server.protocol) ? server.protocol : 'inherit',
    cwd: typeof server.cwd === 'string' ? server.cwd : '',
  };
  for (const [field, key] of TIMEOUTS) fields[field] = Number.isInteger(timeout[key]) && timeout[key] > 0 ? timeout[key] : '';
  return fields;
}

const cleanMs = (value, label) => {
  if (value === '' || value == null) return null;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > MAX_MS) throw new OpenCodeMcpError(400, `${label} harus angka bulat 1–${MAX_MS} ms.`);
  return n;
};

const cleanCwd = (value) => {
  const text = String(value ?? '').trim();
  if (text.length > 500) throw new OpenCodeMcpError(400, 'Folder kerja maksimal 500 karakter.');
  return text || null;
};

/**
 * Applies the form fields to one server object in place and returns it. Only the named keys change; "inherit"
 * deletes a key instead of writing a default, so a newer OpenCode default still applies.
 */
export function applyMcpAdvanced(server, fields = {}) {
  if (!isObject(server)) throw new OpenCodeMcpError(400, 'Server ini bukan objek di config.');
  for (const key of ['disabled', 'codemode', 'pool']) {
    if (!(key in fields)) continue; // a patch: an absent key keeps what the file has
    const value = fields[key] ?? 'inherit';
    if (!TRI.includes(value)) throw new OpenCodeMcpError(400, `Nilai ${key} tidak dikenal.`);
    if (value === 'inherit') delete server[key];
    else server[key] = value === 'on';
  }
  if ('protocol' in fields) {
    const protocol = fields.protocol ?? 'inherit';
    if (protocol === 'inherit') delete server.protocol;
    else if (PROTOCOLS.includes(protocol)) server.protocol = protocol;
    else throw new OpenCodeMcpError(400, 'Versi protokol harus inherit, legacy, auto, atau 2026-07-28.');
  }

  if ('cwd' in fields) {
    const cwd = cleanCwd(fields.cwd);
    if (cwd && server.type === 'remote') throw new OpenCodeMcpError(400, 'Folder kerja hanya untuk server lokal.');
    if (cwd) server.cwd = cwd;
    else delete server.cwd;
  }

  const timeout = isObject(server.timeout) ? { ...server.timeout } : {};
  let touched = false;
  for (const [field, key, label] of TIMEOUTS) {
    if (!(field in fields)) continue;
    touched = true;
    const value = cleanMs(fields[field], `Batas waktu ${label.toLowerCase()}`);
    if (value == null) delete timeout[key];
    else timeout[key] = value;
  }
  if (touched) {
    if (Object.keys(timeout).length) server.timeout = timeout;
    else delete server.timeout;
  }
  return server;
}

/** The server map OpenCode reads for this config, in either shape (v2 `mcp.servers`, v1 `mcp` as the map). */
function serverMap(config, name, { create = false } = {}) {
  if (!isObject(config.mcp)) {
    if (config.mcp !== undefined) throw new OpenCodeMcpError(400, 'Bagian "mcp" di config bukan objek. Perbaiki lewat tab JSON dulu.');
    if (!create) return null;
    config.mcp = { servers: {} };
  }
  if (isObject(config.mcp.servers)) return config.mcp.servers;
  // v1: server names sit directly under `mcp`; only `timeout` is a sibling there in v2 without `servers`.
  const keys = Object.keys(config.mcp).filter((key) => key !== 'timeout');
  const looksV1 = keys.length > 0;
  if (looksV1) return config.mcp;
  if (!create) return null;
  config.mcp = { servers: {} };
  return config.mcp.servers;
}

/** The server with this name in one parsed config (or null); both config shapes are understood. */
export function findMcpServer(config, name) {
  const map = serverMap(config, name);
  return map && isObject(map[name]) ? map[name] : null;
}

/** Ensures the server exists in the config and returns it (a v2 `mcp.servers` entry). */
export function ensureMcpServer(config, name) {
  const map = serverMap(config, name, { create: true });
  const server = map[name];
  if (!isObject(server)) throw new OpenCodeMcpError(404, `Server "${name}" tidak ada di config ini. Tambahkan dulu lewat ＋ Tambah server.`);
  return server;
}
