// 🔑 `office pair`: the local CLI reads the pairing snapshot with the narrow CLI token. Route-level unit tests:
// disabled / paused / the payload, and that reading never rotates the one-time code.
import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { register } from '../src/routes/remote.js';

const v4 = (address) => ({ family: 'IPv4', address, internal: false });

function harness({ enabled = true, pausedUntil = 0 } = {}) {
  const handlers = new Map();
  register({ post: (pattern, handler, opts) => handlers.set(pattern, { handler, opts }) });
  let calls = 0;
  const remote = {
    enabled,
    pausedUntil,
    currentPairing() {
      calls++;
      return { code: '654321', key: 'k-key', expires: Date.now() + 120_000, tries: 0 };
    },
  };
  const ctx = { remote, port: 4317, httpsInfo: () => ({ url: 'https://laptop.tailnet.ts.net:4318' }) };
  const call = (body = {}) => {
    let out = null;
    const res = {
      writeHead(status) { out = { status }; },
      end(text) { out.body = text ? JSON.parse(text) : null; },
    };
    const result = handlers.get('/api/pairing/cli').handler(ctx, {}, res, {}, body);
    return Promise.resolve(result).then(() => out);
  };
  return { ctx, call, handlers, reads: () => calls };
}

test('office pair: the route carries the narrow CLI token, never the office token', () => {
  const { handlers } = harness();
  assert.equal(handlers.get('/api/pairing/cli').opts.token, 'cli');
});

test('office pair: refused while phone access is off', async () => {
  const { call } = harness({ enabled: false });
  const out = await call();
  assert.equal(out.status, 400);
  assert.match(out.body.error, /Nyalakan akses dari HP/);
});

test('office pair: paused pairing answers 423 with the remaining time', async () => {
  const { call } = harness({ pausedUntil: Date.now() + 30_000 });
  const out = await call();
  assert.equal(out.status, 423);
  assert.match(out.body.error, /dijeda/);
  assert.ok(out.body.until > Date.now());
});

test('office pair: the snapshot mirrors the laptop screen and never rotates the code', async (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({ 'Wi-Fi': [v4('192.168.1.14')], Tailscale: [v4('100.101.5.9')] }));
  const { call, reads } = harness();
  const out = await call();
  assert.equal(out.status, 200);
  assert.equal(out.body.code, '654321');
  assert.ok(out.body.expires > Date.now());
  assert.equal(out.body.url, 'http://192.168.1.14:4317');
  assert.equal(out.body.qrUrl, 'http://192.168.1.14:4317/pair?k=k-key');
  assert.equal(out.body.https.url, 'https://laptop.tailnet.ts.net:4318');
  assert.equal(out.body.https.qrUrl, 'https://laptop.tailnet.ts.net:4318/pair?k=k-key');
  assert.deepEqual(out.body.addresses.map((a) => a.kind), ['lan', 'tailscale']);
  assert.equal(reads(), 1, 'one read');
  const again = await call();
  assert.equal(again.body.code, '654321', 'a second read keeps the same code (no rotation)');
  assert.equal(reads(), 2);
});
