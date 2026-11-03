// OpenCode providers and their login (Akun when the engine is OpenCode). OpenCode has no single account: each
// model provider (OpenCode Zen/Go, Anthropic, OpenAI, GitHub Copilot, …) is an "integration" with its own
// credentials. Everything goes through `opencode api <operation>` (its background service, the same store
// `opencode auth login|logout|list` use), never by editing OpenCode's files.
//   integration.list                      → every provider, its login methods (key | oauth | env) and connections
//   integration.connect.key               → stores an API key           { key, answer?, label? }
//   integration.oauth.connect             → starts an OAuth attempt     { methodID, answer? } → { attemptID, url, instructions, mode }
//   integration.oauth.status / complete / cancel                       (mode "code": the user pastes a code back)
//   credential.remove                     → logout of one stored credential
// Secrets (API keys, OAuth codes) are never logged; error messages are cut to their first line.
import { execFile } from 'node:child_process';
import { clearModelCache } from './opencode-bin.js';

const TIMEOUT_MS = 60_000;
const ID = /^[\w.-]{1,100}$/; // integration, method, attempt and credential ids
const MAX_SECRET = 4096;

/** Runs `opencode api <operation>`; resolves the parsed JSON body (`data` unwrapped), rejects with a short message. */
export function openCodeApi(bin, operation, { params = {}, body } = {}) {
  if (!bin) return Promise.reject(new Error('OpenCode belum terpasang di laptop ini.'));
  const args = [...bin.args, 'api', operation];
  for (const [k, v] of Object.entries(params)) args.push('--param', `${k}=${v}`);
  if (body !== undefined) args.push('--data', JSON.stringify(body));
  return new Promise((resolve, reject) => {
    execFile(bin.command, args, { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      // Never err.message: Node's "Command failed: <bin> … --data {"key":…}" would carry the API key back.
      if (err) return reject(new Error(errOut || out ? shortError(errOut || out) : err.killed ? 'OpenCode tidak menjawab (timeout).' : `OpenCode gagal (kode ${err.code ?? '?'}).`));
      const text = String(out).trim();
      if (!text) return resolve(null);
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed);
      } catch {
        reject(new Error('Jawaban OpenCode tidak terbaca.'));
      }
    });
  });
}

/** The first meaningful line of an OpenCode error ("Error: …", "[cause]: Error: …"), without stack frames. */
function shortError(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('at '));
  const cause = lines.find((l) => /^\[cause\]/.test(l));
  const line = (cause ?? lines[0] ?? 'OpenCode gagal.').replace(/^\[cause\]:\s*/, '').replace(/^(Unknown)?Error:\s*/, '');
  return line.slice(0, 300);
}

/** A login method as the page may show it (no secrets exist here, only labels and form fields). */
function publicMethod(m) {
  // Hidden fields (a fixed server URL…) are not asked: the page sends their default.
  const form = Array.isArray(m.form) ? m.form.filter((f) => ID.test(String(f?.key ?? ''))).map((f) => ({ key: f.key, hidden: Boolean(f.hidden), title: f.title ?? f.key, required: Boolean(f.required), placeholder: f.placeholder ?? '', default: f.default ?? '', options: Array.isArray(f.options) ? f.options.map((o) => ({ value: o.value, label: o.label ?? o.value })) : null, when: Array.isArray(f.when) ? f.when : null })) : [];
  return { type: m.type, id: m.id ?? m.type, label: m.label ?? (m.type === 'key' ? 'API key' : 'Login'), form };
}

/** One connection: a stored credential (can be logged out here) or an environment variable (set outside the app). */
function publicConnection(c) {
  if (c.type === 'credential') return { type: 'credential', id: c.id, label: c.label ?? 'Default', method: c.method ?? '' };
  return { type: c.type ?? 'env', label: c.name ?? '', method: 'env' };
}

/**
 * Providers for Akun: `connected` (logged in or set by an environment variable) and `available` (can be logged
 * in from the app: API key or OAuth).
 */
export async function openCodeProviders(bin) {
  const list = (await openCodeApi(bin, 'integration.list')) ?? [];
  const providers = (Array.isArray(list) ? list : []).filter((i) => i && ID.test(String(i.id))).map((i) => ({
    id: i.id,
    name: i.name ?? i.id,
    methods: (i.methods ?? []).filter((m) => m.type === 'key' || m.type === 'oauth').map(publicMethod),
    env: (i.methods ?? []).filter((m) => m.type === 'env').flatMap((m) => m.names ?? []),
    connections: (i.connections ?? []).map(publicConnection),
  }));
  return {
    connected: providers.filter((p) => p.connections.length),
    available: providers.filter((p) => p.methods.length).map(({ id, name, methods }) => ({ id, name, methods })),
  };
}

/** Only https (or http on loopback) login pages are handed to the page: never javascript:/data:/file:. */
function safeUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return u.href;
  } catch {
    // not a URL
  }
  return '';
}

const cleanAnswer = (answer) => {
  const out = {};
  if (!answer || typeof answer !== 'object') return undefined;
  for (const [k, v] of Object.entries(answer)) if (ID.test(k) && typeof v === 'string' && v.length <= 500) out[k] = v;
  return Object.keys(out).length ? out : undefined;
};
const checkId = (id, what) => {
  if (!ID.test(String(id ?? ''))) throw Object.assign(new Error(`${what} tidak valid.`), { status: 400 });
  return String(id);
};

/** Stores an API key for a provider. */
export async function openCodeConnectKey(bin, integrationID, { key, answer } = {}) {
  const secret = String(key ?? '').trim();
  if (!secret || secret.length > MAX_SECRET) throw Object.assign(new Error('API key kosong.'), { status: 400 });
  await openCodeApi(bin, 'integration.connect.key', { params: { integrationID: checkId(integrationID, 'Provider') }, body: { key: secret, answer: cleanAnswer(answer) } });
  clearModelCache();
  return { ok: true };
}

/** Starts an OAuth login: the page opens `url` (mode "auto": OpenCode notices the login; "code": paste the code). */
export async function openCodeOAuthStart(bin, integrationID, { methodID, answer } = {}) {
  const attempt = await openCodeApi(bin, 'integration.oauth.connect', { params: { integrationID: checkId(integrationID, 'Provider') }, body: { methodID: checkId(methodID, 'Metode'), answer: cleanAnswer(answer) } });
  return { attemptID: attempt?.attemptID, url: safeUrl(attempt?.url), instructions: attempt?.instructions ?? '', mode: attempt?.mode === 'code' ? 'code' : 'auto' };
}

/** pending | complete | failed (with a message) | expired */
export async function openCodeOAuthStatus(bin, integrationID, attemptID) {
  const st = await openCodeApi(bin, 'integration.oauth.status', { params: { integrationID: checkId(integrationID, 'Provider'), attemptID: checkId(attemptID, 'Percobaan') } });
  if (st?.status === 'complete') clearModelCache();
  return { status: st?.status ?? 'pending', message: st?.message ?? '' };
}

export async function openCodeOAuthComplete(bin, integrationID, attemptID, code) {
  const value = String(code ?? '').trim();
  if (!value || value.length > MAX_SECRET) throw Object.assign(new Error('Kode kosong.'), { status: 400 });
  await openCodeApi(bin, 'integration.oauth.complete', { params: { integrationID: checkId(integrationID, 'Provider'), attemptID: checkId(attemptID, 'Percobaan') }, body: { code: value } });
  clearModelCache();
  return { ok: true };
}

export async function openCodeOAuthCancel(bin, integrationID, attemptID) {
  await openCodeApi(bin, 'integration.oauth.cancel', { params: { integrationID: checkId(integrationID, 'Provider'), attemptID: checkId(attemptID, 'Percobaan') } }).catch(() => {});
  return { ok: true };
}

/** Logout of one stored credential (an environment variable can only be removed where it is set). */
export async function openCodeLogout(bin, credentialID) {
  await openCodeApi(bin, 'credential.remove', { params: { credentialID: checkId(credentialID, 'Kredensial') } });
  clearModelCache();
  return { ok: true };
}
