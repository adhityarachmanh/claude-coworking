// bridge/netlify/functions/bridge.mjs — jembatan Netlify Functions v2 (pengganti bridge/worker.js).
// Hanya lapis perekat: mengikat Netlify Blobs + env ke handler inti di src/bridge.mjs (yang di-test langsung).
// config.path membuat fungsi melayani seluruh situs — bridge/ di-deploy sebagai root situs Netlify.
import { getStore } from '@netlify/blobs';
import { handleApi } from '../../src/bridge.mjs';

export const config = { path: ['/', '/api/*', '/s/*', '/manage'] };

export default async (request) => {
  const store = getStore({ name: 'adhitron-bridge', consistency: 'strong' });
  return handleApi(request, { store, encryptionKey: process.env.ENCRYPTION_KEY });
};
