// bridge/netlify/functions/bridge.mjs — satu situs Netlify (Netlify Functions v2).
// Portal & chat di root ('/', '/chat/*'); jembatan daya dipasang di '/bridge' (basePath '/bridge'):
// handler inti src/bridge.mjs tidak tahu-menahu soal mount — ia menerima basePath dan memangkas prefiks
// itu sendiri dari pathname, jadi rute jembatan tetap '/', '/api/*', '/s/*', '/manage'.
// Hanya lapis perekat: mengikat Netlify Blobs + env ke handler inti.
import { getStore } from '@netlify/blobs';
import { handleApi } from '../../src/bridge.mjs';
import { handleSite } from '../../src/site.mjs';

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
  const site = handleSite(request, url);
  if (site) return site;
  return new Response('Tidak ditemukan', { status: 404 });
};