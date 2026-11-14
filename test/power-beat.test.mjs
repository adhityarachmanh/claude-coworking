// ⚡ Heartbeat remote power (src/power-beat.js): the first beat goes out at once, then every interval; a
// scheduled power-off halts it for 12 minutes; no bridge or a failing bridge never crashes the server.
// The clock and fetch are injected; short cadences use the constructor's beatMs with real timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BEAT_MS, DEFAULT_HALT_MS, RemotePowerBeat, beatInterval } from '../src/power-beat.js';

const CONFIGURED = { bridgeUrl: 'https://jembatan.workers.dev', token: 'rahasia-jembatan' };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('start(): the first beat goes out at once, then one per beatMs', async (t) => {
  const calls = [];
  const clock = { now: 5_000 };
  const beat = new RemotePowerBeat({
    getConfig: () => CONFIGURED,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
    beatMs: 20,
    now: () => clock.now,
    appVersion: '1.0.31',
  });
  t.after(() => beat.stop());
  beat.start();
  assert.equal(calls.length, 1, 'no waiting for the first interval');
  const [first] = calls;
  assert.equal(first.url, 'https://jembatan.workers.dev/api/heartbeat');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.headers['X-Bridge-Token'], 'rahasia-jembatan', 'the token travels in the header');
  assert.equal(first.init.headers['Content-Type'], 'text/plain');
  assert.deepEqual(JSON.parse(first.init.body), { ts: 5_000, version: '1.0.31' });

  await wait(100);
  assert.ok(calls.length >= 2, `follow-up beats follow the interval (got ${calls.length})`);
});

test('halt(): no beat while a power-off is scheduled, resumes by itself once haltMs passed', async () => {
  const calls = [];
  let now = 1_000;
  const beat = new RemotePowerBeat({
    getConfig: () => CONFIGURED,
    fetchImpl: async () => {
      calls.push(1);
      return { ok: true };
    },
    now: () => now,
    haltMs: 10 * 60_000,
  });
  beat.halt();
  now = 1_000 + 9 * 60_000;
  assert.equal(await beat.beat(), false, 'still inside the halt window');
  assert.equal(calls.length, 0, 'nothing is sent');
  now = 1_000 + 10 * 60_000;
  assert.equal(await beat.beat(), true, 'the halt ends on its own (never one-way)');
  assert.equal(calls.length, 1);
});

test('no bridge configured: nothing is sent', async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return { ok: true };
  };
  for (const config of [{ bridgeUrl: '', token: 'tok' }, { bridgeUrl: 'https://jembatan.workers.dev', token: '' }, undefined]) {
    const beat = new RemotePowerBeat({ getConfig: () => config, fetchImpl });
    assert.equal(await beat.beat(), false);
  }
  assert.equal(calls.length, 0);
});

test('a failed beat is reported once per tick and never crashes', async (t) => {
  const errors = [];
  const beat = new RemotePowerBeat({
    getConfig: () => CONFIGURED,
    fetchImpl: async () => {
      throw new Error('jembatan mati');
    },
    beatMs: 10,
    onError: (err) => errors.push(err.message),
  });
  t.after(() => beat.stop());
  assert.equal(await beat.beat(), false, 'the rejection is swallowed into a false result');
  assert.deepEqual(errors, ['jembatan mati']);
  beat.start(); // the timer path is just as safe
  await wait(80);
  assert.ok(errors.length >= 2, 'each tick tries again once, no tight loop');
});

test('stop(): the timer is gone until start() is called again', async () => {
  const calls = [];
  const beat = new RemotePowerBeat({
    getConfig: () => CONFIGURED,
    fetchImpl: async () => {
      calls.push(1);
      return { ok: true };
    },
    beatMs: 10,
  });
  beat.start();
  await wait(80);
  assert.ok(calls.length >= 2, `beats were running (got ${calls.length})`);
  beat.stop();
  const stopped = calls.length;
  await wait(80);
  assert.equal(calls.length, stopped, 'no beat after stop()');
  beat.start(); // a later start() resumes
  assert.ok(calls.length > stopped, 'start() beats at once again');
  beat.stop();
});

test('OFFICE_POWER_BEAT_MS: a positive integer ms overrides the 2-minute default', (t) => {
  const before = process.env.OFFICE_POWER_BEAT_MS;
  t.after(() => {
    if (before === undefined) delete process.env.OFFICE_POWER_BEAT_MS;
    else process.env.OFFICE_POWER_BEAT_MS = before;
  });
  assert.equal(DEFAULT_BEAT_MS, 2 * 60_000);
  assert.equal(DEFAULT_HALT_MS, 12 * 60_000);
  assert.equal(beatInterval({}), DEFAULT_BEAT_MS);
  // Below the 60 s floor a stray env value is ignored, never turned into a heartbeat flood.
  assert.equal(beatInterval({ OFFICE_POWER_BEAT_MS: '1500' }), DEFAULT_BEAT_MS, 'below the floor');
  assert.equal(beatInterval({ OFFICE_POWER_BEAT_MS: '90000' }), 90_000, 'at or above the floor');
  for (const bad of ['0', '-1', '1.5', 'abc', '']) assert.equal(beatInterval({ OFFICE_POWER_BEAT_MS: bad }), DEFAULT_BEAT_MS, bad);
  process.env.OFFICE_POWER_BEAT_MS = '180000';
  assert.equal(new RemotePowerBeat({ getConfig: () => CONFIGURED }).beatMs, 180_000, 'the constructor reads the env');
});
