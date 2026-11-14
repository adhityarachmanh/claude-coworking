// ⚡ Remote power (⚙ → Sistem): setelan jembatan (URL + token + jeda), heartbeat, dan hook shutdown PC.
// Hub-level: pembersihan & validasi setelan. Route-level: get/save/test + shutdown dengan pc:true
// (OS shutdown rapat dulu → listrik diputus jembatan belakangan — TDD di bagian yang bisa dites).
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
  const dir = mkdtempSync(path.join(tmpdir(), 'office-rp-'));
  DIRS.push(dir);
  const hub = new Hub({ dataDir: dir });
  hub.projects.set('p1', { id: 'p1', name: 'web', path: 'C:\\x\\web', sources: ['custom'] });
  return hub;
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
async function call(p, body = {}, ctx) {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

test('hub: setelan remote power dibersihkan (https saja, token terbatas, jeda 0..600)', () => {
  const hub = makeHub();
  hub.setRemotePower({ bridgeUrl: 'https://jembatan.workers.dev', token: 'tok', offDelaySec: 120 });
  assert.deepEqual(hub.remotePower(), { bridgeUrl: 'https://jembatan.workers.dev', token: 'tok', offDelaySec: 120 });
  assert.equal(hub.setRemotePower({ bridgeUrl: 'http://jembatan.workers.dev', token: 'tok' }), null, 'jembatan harus https');
  assert.equal(hub.setRemotePower({ bridgeUrl: 'https://jembatan.workers.dev', token: '' }), null, 'token wajib');
  assert.equal(hub.setRemotePower({ bridgeUrl: 'https://jembatan.workers.dev', token: 'x'.repeat(201) }), null, 'token maks 200');
  assert.equal(hub.setRemotePower({ bridgeUrl: 'https://jembatan.workers.dev', token: 'tok', offDelaySec: 9999 }), null, 'jeda maks 600');
  assert.deepEqual(new Hub({ dataDir: hub.dataDir }).remotePower(), { bridgeUrl: 'https://jembatan.workers.dev', token: 'tok', offDelaySec: 120 }, 'tersimpan');
});

test('hub: setelan kosong / url kosong menghapus konfigurasi (fitur opsional)', () => {
  const hub = makeHub();
  hub.setRemotePower({ bridgeUrl: 'https://j.workers.dev', token: 't' });
  hub.setRemotePower({ bridgeUrl: '', token: '' });
  assert.deepEqual(hub.remotePower(), { bridgeUrl: '', token: '', offDelaySec: 120 }, 'setelan kosong = fitur mati, jeda kembali ke default');
});

test('route remote power: get → save → get; test memanggil jembatan (status + heartbeat)', async () => {
  const hub = makeHub();
  hub.config = { engine: 'claude' };
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' });
    if (String(url).includes('/api/status')) return { ok: true, json: async () => ({ plug: 'off', lastHeartbeat: 123, version: '1.0.26' }) };
    return { ok: true, json: async () => ({ ok: true }), text: async () => 'ok' };
  };
  try {
    const ctx = { hub, device: null };
    const saved = await call('/api/remote-power/settings', { bridgeUrl: 'https://j.workers.dev', token: 'tok', offDelaySec: 90 }, ctx);
    assert.equal(saved.status, 200, saved.body);
    assert.deepEqual(saved.json().remotePower, { bridgeUrl: 'https://j.workers.dev', token: 'tok', offDelaySec: 90 });

    const got = await call('/api/remote-power/get', {}, ctx);
    assert.deepEqual(got.json().remotePower, { bridgeUrl: 'https://j.workers.dev', token: 'tok', offDelaySec: 90 });

    const bad = await call('/api/remote-power/settings', { bridgeUrl: 'http://j.workers.dev', token: 't' }, ctx);
    assert.equal(bad.status, 400, 'url tidak https ditolak');

    const tested = await call('/api/remote-power/test', {}, ctx);
    assert.equal(tested.status, 200, tested.body);
    assert.deepEqual(tested.json(), { ok: true, plug: 'off', lastHeartbeat: 123 });
    const beat = fetched.find((f) => f.url.includes('/api/heartbeat'));
    assert.ok(beat, 'uji koneksi sekaligus mengirim heartbeat');
    assert.equal(beat.headers['X-Bridge-Token'], 'tok', 'token lewat header');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('route shutdown dengan pc:true: OS shutdown + jembatan memutus listrik dengan delay', async () => {
  const hub = makeHub();
  hub.setRemotePower({ bridgeUrl: 'https://j.workers.dev', token: 'tok', offDelaySec: 120 });
  const calls = [];
  const ctx = {
    hub,
    shutdown: () => calls.push('shutdown'),
    pcShutdown: () => calls.push('pc-shutdown'), // injected: the test must not run a real OS shutdown
    sessions: { shutdown: async () => {} },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), token: init?.headers?.['X-Bridge-Token'] });
    // Bridge replies with the handoff URL of its countdown page (multi-tenant bridge contract).
    return new Response(JSON.stringify({ ok: true, offAt: 12345, handoffUrl: '/s/abc?t=tiket1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const res = await call('/api/shutdown', { pc: true }, ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { ok: true, pc: true, handoffUrl: '/s/abc?t=tiket1' }, 'respons membawa handoffUrl halaman jembatan');
    await new Promise((r) => setTimeout(r, 450)); // the route defers shutdown() by 300 ms
    assert.ok(calls.includes('shutdown'), 'server dimatikan seperti biasa');
    assert.ok(calls.includes('pc-shutdown'), 'OS shutdown (PC) dijalankan lewat injeksi, bukan spawn nyata');
    const beat = calls.find((c) => typeof c === 'object' && String(c.url).includes('/api/off'));
    assert.ok(beat, 'jembatan dipanggil untuk memutus listrik');
    assert.equal(beat.token, 'tok');
    assert.match(String(beat.url), /delay=120/, 'listrik diputus lewat jadwal (setelah OS shutdown)');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('route shutdown dengan pc:true tapi jembatan gagal: tetap 200 tanpa handoffUrl, server tetap dimatikan', async () => {
  const hub = makeHub();
  hub.setRemotePower({ bridgeUrl: 'https://j.workers.dev', token: 'tok', offDelaySec: 120 });
  const calls = [];
  const ctx = {
    hub,
    shutdown: () => calls.push('shutdown'),
    pcShutdown: () => calls.push('pc-shutdown'),
    sessions: { shutdown: async () => {} },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('jembatan mati');
  };
  try {
    const res = await call('/api/shutdown', { pc: true }, ctx);
    assert.equal(res.status, 200, 'kegagalan jembatan tidak boleh menggagalkan shutdown');
    assert.deepEqual(res.json(), { ok: true, pc: true }, 'tanpa handoffUrl saat jembatan tak terjangkau');
    await new Promise((r) => setTimeout(r, 450));
    assert.ok(calls.includes('shutdown'), 'server tetap dimatikan');
    assert.ok(calls.includes('pc-shutdown'), 'OS shutdown tetap dijalankan');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('route shutdown: handoffUrl protocol-relative "//evil.com" ditolak (guard open redirect), shutdown tetap jalan', async () => {
  const hub = makeHub();
  hub.setRemotePower({ bridgeUrl: 'https://j.workers.dev', token: 'tok', offDelaySec: 120 });
  const calls = [];
  const ctx = {
    hub,
    shutdown: () => calls.push('shutdown'),
    pcShutdown: () => calls.push('pc-shutdown'),
    sessions: { shutdown: async () => {} },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, offAt: 1, handoffUrl: '//evil.com/x' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    const res = await call('/api/shutdown', { pc: true }, ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { ok: true, pc: true }, 'respons TANPA handoffUrl — //evil.com tidak lolos guard');
    await new Promise((r) => setTimeout(r, 450));
    assert.ok(calls.includes('shutdown'), 'shutdown server tetap dijalankan');
    assert.ok(calls.includes('pc-shutdown'), 'OS shutdown tetap dijalankan meski handoffUrl ditolak');
  } finally {
    globalThis.fetch = realFetch;
  }
});
