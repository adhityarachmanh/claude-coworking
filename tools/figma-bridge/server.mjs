// 🌉 Adhitron ⇄ Figma bridge.
//
// One local process with two sides:
//   - MCP over stdio (newline-delimited JSON-RPC), so an AI agent can call the figma_* tools;
//   - a tiny HTTP server on 127.0.0.1:3939 that the companion Figma plugin polls for commands.
// Commands only come from MCP or the token-guarded local CLI (/exec); every plugin endpoint needs the same token,
// so a random web page cannot read commands or forge results. Nothing leaves this laptop.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3939);
const HOST = '127.0.0.1';
const COMMAND_TIMEOUT_MS = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS || 30_000);
const PLUGIN_FRESH_MS = 6_000;
const MAX_URL = 2048;

// One token per run: set FIGMA_BRIDGE_TOKEN to keep it, otherwise a strong one is generated and written to
// %TEMP%/figma-bridge-token.txt for tools/figma-bridge/cli.mjs. The plugin UI stores it (figma.clientStorage).
const TOKEN = String(process.env.FIGMA_BRIDGE_TOKEN || randomBytes(24).toString('hex'));
if (TOKEN.length < 16) {
  console.error('Figma bridge: FIGMA_BRIDGE_TOKEN minimal 16 karakter.');
  process.exit(2);
}
const TOKEN_FILE = path.join(os.tmpdir(), 'figma-bridge-token.txt');

// A page that is allowed to talk to the plugin: Figma's own UI (opaque or figma.com). Everything else gets no CORS.
const ORIGINS = new Set(['null', 'https://www.figma.com', 'https://figma.com']);
const authFails = new Map(); // ip -> { count, resetAt }
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILS = 20;

const queue = []; // commands waiting for the plugin's next poll
const inflight = new Map(); // id -> { resolve, reject, timer, cmd }
const bridge = { pluginAt: 0, info: null };

function enqueue(cmd, args = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      reject(new Error(`Plugin Figma tidak merespons dalam ${Math.round(COMMAND_TIMEOUT_MS / 1000)} detik. Buka plugin Adhitron Bridge di Figma.`));
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    queue.push({ id, cmd, args });
    inflight.set(id, { resolve, reject, timer, cmd });
  });
}

const pluginFresh = () => Date.now() - bridge.pluginAt < PLUGIN_FRESH_MS;

// ---------- HTTP side (the plugin polls this) ----------

function cors(req, res) {
  const origin = String(req.headers.origin ?? '');
  if (!ORIGINS.has(origin)) return; // any other web page gets no CORS: the browser cannot read the response
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome PNA, only for the Figma plugin's origin
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

function tokenOk(req) {
  const given = Buffer.from(String(req.headers['x-bridge-token'] ?? ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Every plugin/CLI endpoint needs the token; repeated failures from one IP are throttled. */
function authorize(req, res) {
  // The valid token always wins, even after failures from another local page: 192-bit tokens cannot be guessed, and
  // throttling the real plugin/CLI out of a shared loopback bucket would be a denial of service.
  if (tokenOk(req)) {
    authFails.delete(req.socket.remoteAddress ?? '?');
    return true;
  }
  const ip = req.socket.remoteAddress ?? '?';
  const now = Date.now();
  const entry = authFails.get(ip);
  if (entry && entry.resetAt > now && entry.count >= AUTH_MAX_FAILS) {
    json(res, 429, { error: 'terlalu banyak percobaan token' });
    return false;
  }
  if (!entry || entry.resetAt <= now) authFails.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  else entry.count += 1;
  json(res, 403, { error: 'token bridge tidak valid' });
  return false;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        return reject(new Error('body terlalu besar'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if ((req.url ?? '').length > MAX_URL) return json(res, 414, { error: 'URL terlalu panjang' });
  let url;
  try {
    url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  } catch {
    return json(res, 400, { error: 'URL tidak valid' }); // a malformed request-target must never kill the bridge
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, plugin: pluginFresh(), port: PORT });
    }
    if (req.method === 'GET' && url.pathname === '/poll') {
      if (!authorize(req, res)) return;
      bridge.pluginAt = Date.now();
      bridge.info = {
        file: typeof url.searchParams.get('file') === 'string' ? url.searchParams.get('file').slice(0, 200) : null,
        page: typeof url.searchParams.get('page') === 'string' ? url.searchParams.get('page').slice(0, 200) : null,
      };
      const commands = queue.splice(0);
      return json(res, 200, { commands: commands.map(({ id, cmd, args }) => ({ id, cmd, args })) });
    }
    if (req.method === 'POST' && url.pathname === '/result') {
      if (!authorize(req, res)) return;
      bridge.pluginAt = Date.now();
      const body = await readBody(req);
      const pending = inflight.get(String(body.id ?? ''));
      if (!pending) return json(res, 404, { error: 'perintah tidak dikenal atau sudah kedaluwarsa' });
      inflight.delete(String(body.id));
      clearTimeout(pending.timer);
      if (body.ok) pending.resolve(body.data ?? null);
      else pending.reject(new Error(String(body.error ?? 'plugin gagal')));
      return json(res, 200, { ok: true });
    }
    // Local CLI (tools/figma-bridge/cli.mjs): same token as the plugin. Destructive commands (delete/batch) are
    // not exposed over HTTP at all; they stay inside the plugin (agent tools do not include them either).
    if (req.method === 'POST' && url.pathname === '/exec') {
      if (!authorize(req, res)) return;
      const body = await readBody(req);
      if (!pluginFresh()) return json(res, 409, { error: 'Plugin Figma belum terhubung.' });
      const known = new Set(['status', 'selection', 'page', 'node', 'export', 'create_frame', 'create_rect', 'create_text', 'set_fill', 'move', 'resize']);
      if (!known.has(body.cmd)) return json(res, 400, { error: 'perintah tidak dikenal' });
      try {
        const data = await enqueue(String(body.cmd), body.args && typeof body.args === 'object' ? body.args : {});
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 502, { error: String(err?.message ?? err) });
      }
    }
    return json(res, 404, { error: 'tidak ditemukan' });
  } catch (err) {
    return json(res, 400, { error: err?.message ?? String(err) });
  }
});

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') console.error(`Figma bridge: port ${PORT} sudah dipakai bridge lain. Pakai token dari terminal bridge yang sedang berjalan.`);
  else console.error(`Figma bridge gagal: ${err?.message ?? err}`);
  process.exit(1); // never overwrite the running instance's token file
});

server.listen(PORT, HOST, () => {
  try {
    writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
  } catch {
    // the CLI can still use FIGMA_BRIDGE_TOKEN
  }
  console.error(`Figma bridge: http://${HOST}:${PORT} (MCP di stdio)`);
  // When this runs as an MCP server, stderr belongs to the client's log: point at the file instead of the token.
  if (process.stderr.isTTY) {
    console.error(`Token bridge: ${TOKEN}`);
    console.error('Tempel token itu di plugin Adhitron Bridge (disimpan di Figma). CLI memakai token yang sama.');
  } else {
    console.error(`Token bridge tersedia di ${TOKEN_FILE}`);
  }
});

// ---------- MCP side (stdio) ----------

const TOOLS = [
  {
    name: 'figma_status',
    description: 'Status of the Adhitron Figma bridge: is the plugin connected, which file/page is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'figma_selection',
    description: 'The nodes currently selected in Figma (id, name, type, size, position).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'figma_page',
    description: 'The current Figma page as a tree (depth 3, at most 500 nodes).',
    inputSchema: { type: 'object', properties: { depth: { type: 'integer', minimum: 1, maximum: 6 } }, additionalProperties: false },
  },
  {
    name: 'figma_node',
    description: 'Details of one node by id (children, layout, fills, text).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'figma_export',
    description: 'Export a node as SVG text (format=svg) or a PNG data URL (format=png).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, format: { type: 'string', enum: ['svg', 'png'] }, scale: { type: 'number', minimum: 0.1, maximum: 4 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'figma_create_frame',
    description: 'Create a frame (optionally inside parentId); returns its id.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, fill: { type: 'string' }, parentId: { type: 'string' } },
      required: ['width', 'height'],
      additionalProperties: false,
    },
  },
  {
    name: 'figma_create_rect',
    description: 'Create a rectangle with a fill and corner radius; returns its id.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, fill: { type: 'string' }, radius: { type: 'number' }, parentId: { type: 'string' } },
      required: ['width', 'height'],
      additionalProperties: false,
    },
  },
  {
    name: 'figma_create_text',
    description: 'Create a text node (Inter by default); returns its id.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, color: { type: 'string' }, parentId: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'figma_set_fill',
    description: 'Set the solid fill of a node (hex color, e.g. "#B85A3C").',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, color: { type: 'string' } }, required: ['id', 'color'], additionalProperties: false },
  },
  {
    name: 'figma_move',
    description: 'Move a node to x/y.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['id', 'x', 'y'], additionalProperties: false },
  },
];

function reply(id, result, error = null) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = { code: -32000, message: String(error.message ?? error) };
  else msg.result = result;
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function callTool(name, args) {
  if (name === 'figma_status') {
    return { ok: true, plugin: pluginFresh(), bridge: `http://${HOST}:${PORT}`, file: bridge.info?.file ?? null, page: bridge.info?.page ?? null };
  }
  if (!pluginFresh()) throw new Error('Plugin Figma belum terhubung. Buka file di Figma desktop lalu jalankan plugin "Adhitron Bridge" (Plugins → Development).');
  const map = {
    figma_selection: 'selection',
    figma_page: 'page',
    figma_node: 'node',
    figma_export: 'export',
    figma_create_frame: 'create_frame',
    figma_create_rect: 'create_rect',
    figma_create_text: 'create_text',
    figma_set_fill: 'set_fill',
    figma_move: 'move',
  };
  const cmd = map[name];
  if (!cmd) throw new Error(`Tool tidak dikenal: ${name}`);
  return enqueue(cmd, args ?? {});
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notifications (initialized, cancelled)
  try {
    if (msg.method === 'initialize') {
      return reply(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'adhitron-figma-bridge', version: '1.0.0' },
      });
    }
    if (msg.method === 'ping') return reply(msg.id, {});
    if (msg.method === 'tools/list') return reply(msg.id, { tools: TOOLS });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const result = await callTool(name, msg.params?.arguments ?? {});
      return reply(msg.id, textResult(result));
    }
    return reply(msg.id, null, new Error(`Metode tidak dikenal: ${msg.method}`));
  } catch (err) {
    return reply(msg.id, { ...textResult(`Error: ${err.message}`), isError: true });
  }
});

function shutdown() {
  try {
    if (readFileSync(TOKEN_FILE, 'utf8').trim() === TOKEN) rmSync(TOKEN_FILE, { force: true });
  } catch {
    // already gone
  }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
