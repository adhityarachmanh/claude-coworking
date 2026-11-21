// bridge/netlify/functions/bridge.mjs — satu situs Netlify (Netlify Functions v2).
// Portal & chat di root ('/', '/chat/*'); jembatan daya dipasang di '/bridge' (basePath '/bridge'):
// handler inti src/bridge.mjs tidak tahu-menahu soal mount — ia menerima basePath dan memangkas prefiks
// itu sendiri dari pathname, jadi rute jembatan tetap '/', '/api/*', '/s/*', '/manage'.
// Hanya lapis perekat: mengikat Netlify Blobs + env ke handler inti.
import { getStore } from '@netlify/blobs';
import { handleApi } from '../../src/bridge.mjs';
import { handleSite } from '../../src/site.mjs';
import { handleChatApi } from '../../src/chat-api.mjs';
import { createNeonDb } from '../../src/db.mjs';
import { makeSqlRepo } from '../../src/repo.mjs';

export const config = { path: ['/*'] };

const BRIDGE_BASE = '/bridge';
const inBridge = (pathname) => pathname === BRIDGE_BASE || pathname.startsWith(`${BRIDGE_BASE}/`);

export default async (request) => {
  const url = new URL(request.url);
  if (inBridge(url.pathname)) {
    const store = getStore({ name: 'adhitron-bridge', consistency: 'strong' });
    return handleApi(request, {
      store,
      encryptionKey: process.env.ENCRYPTION_KEY,
      basePath: BRIDGE_BASE,
    });
  }
  // Chat API: butuh DATABASE_URL (Neon). Repo dibuat per-request (driver HTTP: satu request per query).
  if (url.pathname.startsWith('/chat/api/')) {
    if (!process.env.DATABASE_URL) {
      return new Response(JSON.stringify({ error: 'DATABASE_URL belum diset di server' }), {
        status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    const store = getStore({ name: 'adhitron-web', consistency: 'strong' });
    const repo = makeSqlRepo(await createNeonDb(process.env.DATABASE_URL));
    const env = {
      repo, store, encryptionKey: process.env.ENCRYPTION_KEY,
      // Browsing: mesin pencari opsional (DuckDuckGo dipakai bila keduanya kosong).
      searchEngineEnv: { TAVILY_API_KEY: process.env.TAVILY_API_KEY, BRAVE_API_KEY: process.env.BRAVE_API_KEY },
    };
    const res = await handleChatApi(request, env, url.pathname);
    if (res) return res;
  }
  const site = handleSite(request, url);
  if (site) return site;
  return new Response('Tidak ditemukan', { status: 404 });
};