// 🌐 Tailscale Serve: `https://host.ts.net` without a port — the origin office networks allow while they block odd
// ports. `serve` keeps the office tailnet-only (ACLs still apply); `funnel` (public internet) is deliberately absent.
// The daemon is the source of truth: the status JSON is parsed defensively because its shape differs between releases.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServeStatus, readServe, setServe, serveArgs, serveOffArgs, SERVE_TARGET } from '../src/tailscale-serve.js';

const WEB_JSON = JSON.stringify({
  TCP: { 443: { HTTPS: true } },
  Web: { 'shellinfotek321.taild0f8a1.ts.net:443': { Handlers: { '/': { Proxy: SERVE_TARGET } } } },
});

test('parseServeStatus: Serve di port 443 terbaca sebagai aktif dengan URL tanpa port', () => {
  const s = parseServeStatus(WEB_JSON);
  assert.equal(s.active, true);
  assert.equal(s.url, 'https://shellinfotek321.taild0f8a1.ts.net');
  assert.equal(s.port, 443);
});

test('parseServeStatus: port selain 443 muncul di URL; HTTPS mati di 443 = tidak aktif', () => {
  const other = JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { 'host.ts.net:8443': { Handlers: { '/': {} } } } });
  assert.equal(parseServeStatus(other).url, 'https://host.ts.net:8443');

  const noTls = JSON.stringify({ TCP: { 443: { HTTPS: false } }, Web: { 'host.ts.net:443': { Handlers: { '/': {} } } } });
  assert.equal(parseServeStatus(noTls).active, false, 'tanpa HTTPS bukan origin yang kita tawarkan');
});

test('parseServeStatus: jawaban aneh/kosong/dari versi lain tidak pernah melempar dan tidak mengaku aktif', () => {
  for (const raw of ['', 'bukan json', 'null', '[]', '{}', JSON.stringify({ Services: { 'svc:x': {} } })]) {
    const s = parseServeStatus(raw);
    assert.equal(s.active, false, `"${raw}" bukan Serve aktif`);
  }
  assert.equal(parseServeStatus(undefined).active, false);
});

test('parseServeStatus: entri tanpa handler di "/" atau host aneh diabaikan', () => {
  const noRoot = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'host.ts.net:443': { Handlers: {} } } });
  assert.equal(parseServeStatus(noRoot).active, false);
  const weird = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { ':443': { Handlers: { '/': {} } } } });
  assert.equal(parseServeStatus(weird).active, false);
});

test('perintah serve: target selalu loopback dan flag `off` sama persis dengan yang dipakai menyalakan', () => {
  assert.deepEqual(serveArgs(), ['serve', '--bg', '--https=443', SERVE_TARGET]);
  assert.ok(SERVE_TARGET.startsWith('http://127.0.0.1:'), 'hanya loopback: tidak pernah mem-proxy host lain');
  assert.deepEqual(serveOffArgs(), ['serve', '--https=443', SERVE_TARGET, 'off']);
});

test('setServe: menyalakan lalu membaca ulang status dari daemon (bukan mengaku berhasil sendiri)', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'serve' && args[1] === '--bg') return '';
    return WEB_JSON; // status
  };
  const result = await setServe({ run }, { on: true });
  assert.deepEqual(calls[0], serveArgs());
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://shellinfotek321.taild0f8a1.ts.net');

  // Daemon did not adopt it: reported as a failure, with a reason — never a false success.
  const stubborn = async (args) => (args[0] === 'serve' && args[1] === '--bg' ? '' : '{}');
  const refused = await setServe({ run: stubborn }, { on: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.active, false);
  assert.ok(refused.error);
});

test('setServe: galat CLI diteruskan sebagai satu baris (tanpa stack), dan tanpa Tailscale tetap aman', async () => {
  const failing = async () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'serve: not allowed by tailnet policy\nmore text' });
  };
  const result = await setServe({ run: failing }, { on: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /not allowed by tailnet policy/);
  assert.doesNotMatch(result.error, /more text/);

  const none = await setServe(null, { on: true });
  assert.equal(none.ok, false);
  assert.match(none.error, /tidak terpasang/);
});

test('readServe: status tak terbaca = tidak aktif + alasan singkat', async () => {
  const ok = await readServe({ run: async () => WEB_JSON });
  assert.equal(ok.active, true);
  assert.equal(ok.error, null);

  const broken = await readServe({ run: async () => { throw new Error('Tailscale belum berjalan atau belum login.'); } });
  assert.equal(broken.active, false);
  assert.match(broken.error, /belum berjalan/);
});
