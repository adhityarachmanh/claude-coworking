// Bridge calls (src/power-bridge.js): schedule the plug cut and create a phone pairing code. The network is a fake
// fetch: the URL/header/body shape is the contract in docs/remote-power-bridge.md, and tests assert it exactly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeEndpoint, pairBridge, scheduleBridgeCut } from '../src/power-bridge.js';

const fakeFetch = (reply, seen = []) => async (url, init = {}) => {
  seen.push({ url: String(url), headers: init.headers ?? {}, method: init.method });
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

test('scheduleBridgeCut: POST /api/off?delay&hold=1 with the bridge token, relative handoff kept', async () => {
  const seen = [];
  const r = await scheduleBridgeCut({ bridgeUrl: 'https://jembatan.netlify.app', token: 'tok', delay: 120, fetchImpl: fakeFetch({ ok: true, offAt: 99, handoffUrl: '/s/a?t=t' }, seen) });
  assert.deepEqual(r, { ok: true, offAt: 99, handoffUrl: '/s/a?t=t' });
  assert.equal(seen[0].url, 'https://jembatan.netlify.app/api/off?delay=120&hold=1');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers['X-Bridge-Token'], 'tok');
  // protocol-relative handoff is never trusted
  const bad = await scheduleBridgeCut({ bridgeUrl: 'https://j.netlify.app', token: 'tok', delay: 120, fetchImpl: fakeFetch({ ok: true, handoffUrl: '//evil/x' }) });
  assert.equal(bad.handoffUrl, null);
});

test('scheduleBridgeCut: invalid delay or a refused/failed bridge is an error, never a fake success', async () => {
  assert.equal((await scheduleBridgeCut({ bridgeUrl: 'https://j.netlify.app', token: 't', delay: 89 })).ok, false);
  assert.equal((await scheduleBridgeCut({ bridgeUrl: 'http://j.netlify.app', token: 't', delay: 120, fetchImpl: fakeFetch({}) })).ok, false, 'https only');
  const refused = await scheduleBridgeCut({
    bridgeUrl: 'https://j.netlify.app',
    token: 't',
    delay: 120,
    fetchImpl: async () => new Response('{"error":"no"}', { status: 409 }),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /409/);
  const down = await scheduleBridgeCut({ bridgeUrl: 'https://j.netlify.app', token: 't', delay: 120, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(down.ok, false);
  assert.match(down.error, /offline/);
});

test('pairBridge: an 8-character bridge code is accepted; anything else is not trusted', async () => {
  const seen = [];
  const ok = await pairBridge({ bridgeUrl: 'https://j.netlify.app', token: 'tok', fetchImpl: fakeFetch({ ok: true, code: 'k7m2qx9b', expiresAt: 42 }, seen) });
  assert.deepEqual(ok, { ok: true, code: 'K7M2QX9B', expiresAt: 42 });
  assert.equal(seen[0].url, 'https://j.netlify.app/api/pair');
  assert.equal(seen[0].headers['X-Bridge-Token'], 'tok');
  for (const code of ['', 'ABC', 'K7M2QX9I', 'K7M2QX9B0', 'K7M2-QX9']) {
    const bad = await pairBridge({ bridgeUrl: 'https://j.netlify.app', token: 'tok', fetchImpl: fakeFetch({ ok: true, code }) });
    assert.equal(bad.ok, false, code);
  }
  const refused = await pairBridge({ bridgeUrl: 'https://j.netlify.app', token: 'tok', fetchImpl: async () => new Response('{}', { status: 401 }) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /401/);
});

test('bridgeEndpoint: absolute https only, query merged on the bridge root', () => {
  assert.equal(bridgeEndpoint('https://x.netlify.app', '/api/pair', {}), 'https://x.netlify.app/api/pair');
  assert.equal(bridgeEndpoint('https://x.netlify.app/base', '/api/off', { delay: 90, hold: 1 }), 'https://x.netlify.app/api/off?delay=90&hold=1');
  assert.equal(bridgeEndpoint('http://x', '/api/pair'), null);
  assert.equal(bridgeEndpoint('', '/api/pair'), null);
});
