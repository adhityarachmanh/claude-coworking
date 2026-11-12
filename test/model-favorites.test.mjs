// ⭐ Model favorit (Pengaturan giliran): app-level pinned model ids. Hub keeps, validates and broadcasts them;
// POST /api/model-favorites toggles one. Against a throwaway data dir, no server.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildRouter } from '../src/routes/index.js';
import { Hub } from '../src/hub.js';

const DIRS = [];
after(() => DIRS.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

const makeHub = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-fav-'));
  DIRS.push(dir);
  return new Hub({ dataDir: dir });
};

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    Object.assign(res.headers, headers);
  };
  res.end = (b) => (res.body = String(b ?? ''));
  res.json = () => JSON.parse(res.body);
  return res;
}

const router = buildRouter();
async function call(body, ctx) {
  const m = router.match('POST', '/api/model-favorites');
  assert.ok(m, 'route terdaftar');
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

test('toggleFavoriteModel: pin menambah (urutan, dedupe), unpin menghapus, tersimpan dan disiarkan', () => {
  const hub = makeHub();
  const events = [];
  hub.observers.add((type, data) => events.push({ type, data }));
  hub.config = { engine: 'opencode' }; // server.js assigns the real one; tests need something to broadcast

  hub.toggleFavoriteModel('river/GLM-5.3', true);
  hub.toggleFavoriteModel('sonnet', true);
  hub.toggleFavoriteModel('river/GLM-5.3', true); // pin twice: one entry
  assert.deepEqual(hub.favoriteModels(), ['river/GLM-5.3', 'sonnet']);

  hub.toggleFavoriteModel('river/GLM-5.3', false);
  assert.deepEqual(hub.favoriteModels(), ['sonnet']);

  // Persisted: a fresh Hub reads the same list from state.json.
  assert.deepEqual(new Hub({ dataDir: hub.dataDir }).favoriteModels(), ['sonnet']);
  // Broadcast: every change re-sent the config with favoriteModels.
  const configs = events.filter((e) => e.type === 'config').map((e) => e.data.favoriteModels);
  assert.deepEqual(configs, [['river/GLM-5.3'], ['river/GLM-5.3', 'sonnet'], ['sonnet']]);
});

test('toggleFavoriteModel: daftar dibatasi (maks 12, id ≤200, string saja) dan nilai aneh ditolak', () => {
  const hub = makeHub();
  for (let i = 0; i < 20; i++) hub.toggleFavoriteModel(`river/m-${i}`, true);
  assert.equal(hub.favoriteModels().length, 12, 'maks 12 favorit');
  assert.equal(hub.toggleFavoriteModel('id dengan spasi', true), null, 'id tak valid ditolak');
  assert.equal(hub.toggleFavoriteModel('', true), null);
  assert.equal(hub.toggleFavoriteModel('x'.repeat(201), true), null);
  assert.ok(!hub.favoriteModels().includes('id dengan spasi'));
});

test('POST /api/model-favorites: toggle valid 200, nilai aneh 400; tanpa perubahan tetap 200', async () => {
  const hub = makeHub();
  hub.config = { engine: 'claude' };
  const ctx = { hub, device: 'uji' };
  const ok = await call({ value: 'river/GLM-5.3', on: true }, ctx);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { favorites: ['river/GLM-5.3'] });

  const again = await call({ value: 'river/GLM-5.3', on: true }, ctx); // idempotent: no dup, still 200
  assert.equal(again.status, 200);
  assert.deepEqual(again.json(), { favorites: ['river/GLM-5.3'] });

  const off = await call({ value: 'river/GLM-5.3', on: false }, ctx);
  assert.deepEqual(off.json(), { favorites: [] });

  const bad = await call({ value: 'id dengan spasi', on: true }, ctx);
  assert.equal(bad.status, 400);
  const bad2 = await call({ on: true }, ctx);
  assert.equal(bad2.status, 400);
  assert.equal(hub.favoriteModels().length, 0, 'tolakan tidak mengubah daftar');
});
