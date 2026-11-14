// ⚡ Aksi daya dari HP (src/power.js + src/routes/misc.js): aturan akses murni, status jembatan tanpa token,
// dan handler /api/power/status & /api/shutdown lewat router dengan ctx palsu (pola test/firewall-check.test.mjs).
// Tanpa server, tanpa OS shutdown nyata (shutdown/pcShutdown/fetch diinjeksi).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { POWER_SECURE_ERROR, powerAllowed, powerStatus } from '../src/power.js';
import { wifiAllows } from '../src/remote.js';
import { buildRouter } from '../src/routes/index.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(path.join(APP, 'server.js'), 'utf8');

// ---------- aturan akses (fungsi murni) ----------

test('powerAllowed: laptop selalu boleh, HP hanya lewat https yang tidak read-only', () => {
  // Empat kombinasi yang penting untuk aturan ini:
  assert.equal(powerAllowed({ local: true, secure: false, readOnly: false }), true, 'laptop (http 127.0.0.1) tetap seperti sekarang');
  assert.equal(powerAllowed({ local: false, secure: true, readOnly: false }), true, 'HP pairing lewat https Tailscale boleh');
  assert.equal(powerAllowed({ local: false, secure: false, readOnly: true }), false, 'HP WiFi HTTP (read-only) TETAP DILARANG');
  assert.equal(powerAllowed({ local: false, secure: true, readOnly: true }), false, 'https non-Tailscale (read-only) juga ditolak');
  // Sisanya: laptop tidak pernah read-only, dan tanpa penanda apa pun hasilnya fail-closed.
  assert.equal(powerAllowed({ local: true, secure: false, readOnly: true }), true, 'laptop tidak pernah dihitung read-only');
  assert.equal(powerAllowed({ local: true, secure: true, readOnly: false }), true);
  assert.equal(powerAllowed({}), false, 'tanpa penanda transport = ditolak');
});

test('powerStatus: configured + bridgeUrl + offDelaySec, TIDAK pernah membawa token', () => {
  const status = powerStatus({ remotePower: () => ({ bridgeUrl: 'https://jembatan.workers.dev', token: 'rahasia-jembatan', offDelaySec: 90 }) });
  assert.deepEqual(status, { configured: true, bridgeUrl: 'https://jembatan.workers.dev', offDelaySec: 90 });
  assert.equal(JSON.stringify(status).includes('rahasia-jembatan'), false, 'token jembatan tidak ikut ke browser');
  assert.equal('token' in status, false);
  // Belum diset: fitur mati, jeda default (hub.remotePower() mengembalikan bentuk yang sama).
  assert.deepEqual(powerStatus({ remotePower: () => ({ bridgeUrl: '', token: '', offDelaySec: 120 }) }), { configured: false, bridgeUrl: null, offDelaySec: 120 });
  assert.deepEqual(powerStatus({}), { configured: false, bridgeUrl: null, offDelaySec: 120 }, 'hub tanpa setelan tetap menjawab aman');
});

test('powerStatus: bridgeUrl disanitasi — https absolut saja, tanpa kredensial/query/hash', () => {
  const withUrl = (bridgeUrl, token = 'tok') => powerStatus({ remotePower: () => ({ bridgeUrl, token, offDelaySec: 120 }) });
  // URL yang ditempel lengkap dari panel jembatan: query/hash/kredensial tidak boleh sampai ke browser.
  assert.equal(withUrl('https://jembatan.workers.dev/?token=rahasia#abc').bridgeUrl, 'https://jembatan.workers.dev', 'query + hash + garis miring akhir dibuang');
  assert.equal(withUrl('https://user:pass@jembatan.workers.dev/s/1?t=x').bridgeUrl, 'https://jembatan.workers.dev/s/1', 'kredensial di URL dibuang, path dipertahankan');
  assert.equal(withUrl('https://jembatan.workers.dev/sub/').bridgeUrl, 'https://jembatan.workers.dev/sub/', 'path sah tetap utuh');
  // Bukan https / tidak valid → null (tidak pernah jadi tautan yang bisa diklik dari HP).
  for (const bad of ['http://jembatan.workers.dev', 'javascript:alert(1)', 'https://', 'bukan-url', '//jembatan.workers.dev', 'ftp://jembatan.workers.dev']) {
    assert.equal(withUrl(bad).bridgeUrl, null, bad);
  }
  assert.equal(withUrl('   ').bridgeUrl, null, 'kosong');
  assert.equal(withUrl('  https://jembatan.workers.dev  ').bridgeUrl, 'https://jembatan.workers.dev', 'spasi di tepi dibuang');
  // configured tetap mengikuti setelan hub (bridgeUrl + token ada), walau URL-nya tidak bisa dipakai sebagai tautan.
  assert.deepEqual(withUrl('http://jembatan.workers.dev'), { configured: true, bridgeUrl: null, offDelaySec: 120 });
  assert.equal(withUrl('https://jembatan.workers.dev', '').configured, false, 'tanpa token = belum dikonfigurasi');
});

// ---------- handler route (ctx palsu, pola firewall-check.test.mjs) ----------

const router = buildRouter();
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
async function call(p, body, ctx) {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

const hubWith = (rp) => ({ remotePower: () => rp });
const CONFIGURED = { bridgeUrl: 'https://jembatan.workers.dev', token: 'rahasia-jembatan', offDelaySec: 120 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('route /api/power/status: 200 dengan status jembatan, tanpa token', async () => {
  const res = await call('/api/power/status', {}, { hub: hubWith(CONFIGURED) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { configured: true, bridgeUrl: 'https://jembatan.workers.dev', offDelaySec: 120 });
  assert.equal(res.body.includes('rahasia-jembatan'), false, 'respons tidak membocorkan token');
});

test('route /api/shutdown: HP WiFi (bukan local, bukan https) ditolak 403 dan tidak mematikan apa pun', async () => {
  const calls = [];
  const ctx = {
    hub: hubWith(CONFIGURED),
    shutdown: () => calls.push('shutdown'),
    pcShutdown: () => calls.push('pc-shutdown'),
    isLocal: () => false,
    isSecure: () => false,
    isReadOnly: () => true,
  };
  for (const body of [{ pc: false }, { pc: true }]) {
    const res = await call('/api/shutdown', body, ctx);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.deepEqual(res.json(), { error: POWER_SECURE_ERROR });
  }
  await wait(350); // route menjadwalkan shutdown() 300 ms setelah respons
  assert.deepEqual(calls, [], 'server tidak berhenti, OS tidak dimatikan');
});

test('route /api/shutdown: https tetapi read-only (bukan Tailscale) tetap ditolak 403', async () => {
  const calls = [];
  const ctx = {
    hub: hubWith(CONFIGURED),
    shutdown: () => calls.push('shutdown'),
    pcShutdown: () => calls.push('pc-shutdown'),
    isLocal: () => false,
    isSecure: () => true,
    isReadOnly: () => true,
  };
  const res = await call('/api/shutdown', { pc: false }, ctx);
  assert.equal(res.status, 403);
  await wait(350);
  assert.deepEqual(calls, []);
});

test('route /api/shutdown: HP https Tailscale (bukan read-only) boleh — sama seperti laptop', async () => {
  const calls = [];
  const ctx = {
    hub: hubWith({ bridgeUrl: '', token: '', offDelaySec: 120 }),
    shutdown: () => calls.push('shutdown'),
    pcShutdown: () => calls.push('pc-shutdown'),
    isLocal: () => false,
    isSecure: () => true,
    isReadOnly: () => false,
  };
  const res = await call('/api/shutdown', { pc: false }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, pc: false });
  await wait(450);
  assert.deepEqual(calls, ['shutdown'], 'server berhenti rapi; pc:false tidak menyentuh OS');
});

test('route /api/shutdown: pc:true dari HP https → halt heartbeat, bridge /api/off, handoffUrl dikembalikan', async () => {
  const calls = [];
  const ctx = {
    hub: hubWith(CONFIGURED),
    shutdown: () => calls.push('shutdown'),
    pcShutdown: () => calls.push('pc-shutdown'),
    remotePowerHalt: () => calls.push('halt'),
    isLocal: () => false,
    isSecure: () => true,
    isReadOnly: () => false,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), token: init?.headers?.['X-Bridge-Token'] });
    return new Response(JSON.stringify({ ok: true, offAt: 1, handoffUrl: '/s/abc?t=tiket1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = await call('/api/shutdown', { pc: true }, ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { ok: true, pc: true, handoffUrl: '/s/abc?t=tiket1' }, 'halaman hitung mundur jembatan ikut dikembalikan');
    const off = calls.find((c) => typeof c === 'object');
    assert.match(String(off.url), /\/api\/off\?delay=120/, 'listrik diputus lewat jadwal jembatan');
    assert.equal(off.token, 'rahasia-jembatan');
    await wait(450);
    assert.ok(calls.includes('halt'), 'heartbeat dihentikan supaya jadwal tidak membatalkan diri');
    assert.ok(calls.includes('pc-shutdown'), 'OS shutdown dijalankan (injeksi, bukan spawn nyata)');
    assert.ok(calls.includes('shutdown'), 'server berhenti rapi');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- gate di server.js (tanpa menyalakan server: dibaca sebagai teks, pola review-guards) ----------

test('server.js: /api/shutdown bukan lagi LOCAL_ONLY, dan SECURE_ONLY memuat shutdown + power/status', () => {
  const localOnly = SERVER.match(/const LOCAL_ONLY = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
  assert.equal(localOnly.includes("'/api/shutdown'"), false, 'HP https harus bisa mematikan PC: bukan laptop-only lagi');
  const secureOnly = SERVER.match(/const SECURE_ONLY = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
  for (const p of ['/api/shutdown', '/api/power/status']) assert.ok(secureOnly.includes(`'${p}'`), `${p} di SECURE_ONLY`);
  assert.match(SERVER, /SECURE_ONLY\.has\(pathname\) && !isSecure\(req\)/, 'gate menolak transport non-https');
  assert.match(SERVER, /error: POWER_SECURE_ERROR/, 'pesan 403 sama dengan route (satu sumber: src/power.js)');
});

test('server.js: gate SECURE_ONLY dicek SEBELUM gate read-only WiFi, dan allowlist read-only tidak berubah', () => {
  const secureGate = SERVER.indexOf('SECURE_ONLY.has(pathname)');
  const readOnlyGate = SERVER.indexOf('isReadOnly(req) && !wifiAllows(pathname)');
  assert.ok(secureGate > 0, 'gate SECURE_ONLY ada di blok non-local');
  assert.ok(readOnlyGate > 0, 'gate read-only lama tetap ada');
  assert.ok(secureGate < readOnlyGate, 'urutan: transport dulu, lalu gate read-only (pesan 403 yang tepat)');
  assert.match(SERVER, /if \(!local\) \{/, 'keduanya hanya berlaku untuk request non-local (laptop tidak tersentuh)');
  // HP WiFi HTTP tetap read-only: aksi daya tidak pernah masuk allowlist WiFi.
  for (const p of ['/api/shutdown', '/api/power/status']) assert.equal(wifiAllows(p), false, `${p} ditolak gate read-only`);
});
