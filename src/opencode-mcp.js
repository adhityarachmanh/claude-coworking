// /mcp for OpenCode: the servers configured in opencode.json (global + project, src/mcp-admin.js) with their live state
// from OpenCode's background service (`mcp.list`: connected / pending / disabled / failed / needs_auth), and the same
// actions Claude Code has: ↻ reconnect, ▶ / ⏸ (connect / disconnect for this run of the service; the config is not
// edited) and 🔑 login — a server that needs auth carries an integration id, logged in through OpenCode's integration
// OAuth (the flow 👤 Akun uses for providers, src/opencode-auth.js).
import { listOpenCodeMcp } from './mcp-admin.js';
import { openCodeApi, openCodeOAuthComplete, openCodeOAuthStart } from './opencode-auth.js';

const NAME = /^[\w.@-]{1,100}$/;
const STATUS = { connected: 'connected', pending: 'pending', disabled: 'disabled', failed: 'failed', needs_auth: 'needs-auth' };
const loc = (dir) => ({ 'location[directory]': dir });
const logins = new Map(); // `${dir}|${server}` -> { integrationID, attemptID, mode }

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The live servers of this folder, or null when the service can't say (older OpenCode, not running). */
async function liveServers(bin, dir) {
  try {
    const list = await openCodeApi(bin, 'mcp.list', { params: loc(dir), timeout: 20_000 });
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Configured servers + live state; a server only the service knows (a plugin's, an integration's) is listed too. */
export async function openCodeMcpStatus(bin, dir) {
  const configured = listOpenCodeMcp(dir);
  const live = await liveServers(bin, dir);
  if (!live) return configured;
  const byName = new Map(configured.map((s) => [s.name, { ...s }]));
  for (const l of live) {
    if (!l || !NAME.test(String(l.name))) continue;
    const s = byName.get(l.name) ?? { name: l.name, scope: 'OpenCode' };
    s.status = STATUS[l.status?.status] ?? s.status ?? 'configured';
    s.error = l.status?.error ? String(l.status.error).split('\n')[0].slice(0, 200) : null;
    s.canLogin = Boolean(l.integrationID);
    byName.set(l.name, s);
  }
  return [...byName.values()];
}

/** reconnect · enable · disable · login (→ { authUrl, callbackExpected }) · callback (the pasted code or redirect URL). */
export async function openCodeMcpAction(bin, dir, name, action, callbackUrl = '') {
  if (!NAME.test(String(name ?? ''))) throw fail(400, 'Nama server tidak valid.');
  const server = { server: name, ...loc(dir) };
  switch (action) {
    case 'reconnect':
      await openCodeApi(bin, 'experimental.mcp.disconnect', { params: server, timeout: 30_000 }).catch(() => {});
      await openCodeApi(bin, 'experimental.mcp.connect', { params: server, timeout: 60_000 });
      return { ok: true };
    case 'enable':
      await openCodeApi(bin, 'experimental.mcp.connect', { params: server, timeout: 60_000 });
      return { ok: true };
    case 'disable':
      await openCodeApi(bin, 'experimental.mcp.disconnect', { params: server, timeout: 30_000 });
      return { ok: true };
    case 'login': {
      const live = (await liveServers(bin, dir)) ?? [];
      const entry = live.find((s) => s.name === name);
      if (!entry) throw fail(404, 'Server ini tidak ditemukan di OpenCode. Klik ↻ Muat ulang.');
      if (entry.status?.status === 'connected') return { authUrl: null };
      if (!entry.integrationID) throw fail(409, 'Server ini tidak memakai login OAuth. Periksa konfigurasinya (headers / API key).');
      const integ = await openCodeApi(bin, 'integration.get', { params: { integrationID: entry.integrationID }, timeout: 20_000 });
      const method = (integ?.methods ?? []).find((m) => m.type === 'oauth');
      if (!method?.id) throw fail(409, 'OpenCode tidak menawarkan login OAuth untuk server ini.');
      const attempt = await openCodeOAuthStart(bin, entry.integrationID, { methodID: method.id });
      if (!attempt.url) throw fail(502, 'OpenCode tidak memberi alamat login.');
      logins.set(`${dir}|${name}`, { integrationID: entry.integrationID, attemptID: attempt.attemptID, mode: attempt.mode });
      // "code": the provider shows a code (or redirects somewhere the service can't hear) that is pasted back here
      return { authUrl: attempt.url, callbackExpected: attempt.mode === 'code', instructions: attempt.instructions };
    }
    case 'callback': {
      const login = logins.get(`${dir}|${name}`);
      if (!login) throw fail(409, 'Mulai login dulu (🔑 Login).');
      let code = String(callbackUrl ?? '').trim();
      try {
        code = new URL(code).searchParams.get('code') ?? code;
      } catch {
        // a bare code, not a URL
      }
      if (!code) throw fail(400, 'Tempel kode atau URL dari halaman login.');
      await openCodeOAuthComplete(bin, login.integrationID, login.attemptID, code);
      logins.delete(`${dir}|${name}`);
      await openCodeApi(bin, 'experimental.mcp.connect', { params: server, timeout: 60_000 }).catch(() => {});
      return { ok: true };
    }
    default:
      throw fail(400, 'Aksi MCP tidak dikenal.');
  }
}
