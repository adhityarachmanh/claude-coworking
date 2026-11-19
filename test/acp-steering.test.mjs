// ↪ Steering a running turn (OpenCode 2.3.0, `_session/steering`): the extra instruction reaches the turn that is
// already running instead of waiting in the queue. The session class is exercised on its own prototype — no process,
// no server, no real OpenCode — with a hand-made `rpc`, so the frames are exactly what the app would send.
//
// The shape below is a PROBE of the installed build (opencode 2.3.0, 2026-11-19, `opencode acp` over stdio):
//   initialize → result._meta.steering.supported === true
//   `_session/steering` with { sessionId, prompt: [{ type: 'text', text }] } → { outcome: 'injected' }
//   while idle the same request answers { outcome: 'promptRequired', reason: 'noRunningTurn' }
//   a plain string prompt is refused (-32602 "Expected array at ["prompt"]")
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acpSessionClass } from '../src/acp-session.js';

const Acp = acpSessionClass(class ClaudeSession {}, { previewInput: null });

/** The steering-relevant fields of a live session; `reply` is what the fake OpenCode answers the next request. */
function fakeSession({ busy = true, supported = true, child = { pid: 4242 }, sessionId = 'ses_uji1', reply = { outcome: 'injected' } } = {}) {
  const calls = [];
  const session = Object.assign(Object.create(Acp.prototype), {
    busy,
    steeringSupported: supported,
    child,
    acpSessionId: sessionId,
    rpc(method, params) {
      calls.push({ method, params });
      return typeof reply === 'function' ? reply(method, params) : Promise.resolve(reply);
    },
  });
  return { session, calls };
}

test('steer: tanpa giliran berjalan tidak ada request yang dikirim (tidak menabrak server)', async () => {
  const { session, calls } = fakeSession({ busy: false });
  assert.deepEqual(await session.steer('fokus ke test yang gagal'), { ok: false, reason: 'no-turn' });
  assert.deepEqual(calls, [], 'no doomed request');
});

test('steer: build yang tidak mengiklankan dukungan ditolak jujur (bukan error)', async () => {
  const { session, calls } = fakeSession({ supported: false });
  assert.deepEqual(await session.steer('fokus ke test'), { ok: false, reason: 'unsupported' });
  assert.deepEqual(calls, []);
});

test('steer: frame yang dikirim persis `_session/steering` dengan prompt sebagai array blok', async () => {
  const { session, calls } = fakeSession();
  assert.deepEqual(await session.steer('  fokus ke test checkout  '), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, '_session/steering');
  assert.deepEqual(calls[0].params, { sessionId: 'ses_uji1', prompt: [{ type: 'text', text: 'fokus ke test checkout' }] });
});

test('steer: `promptRequired`/`noRunningTurn` dari OpenCode dibaca sebagai "tidak ada giliran", bukan sukses', async () => {
  const { session } = fakeSession({ reply: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
  assert.deepEqual(await session.steer('arahkan'), { ok: false, reason: 'no-turn' });
});

test('steer: kegagalan RPC tidak dilempar ke route; teks kosong tidak dikirim', async () => {
  const failing = fakeSession({ reply: () => Promise.reject(new Error('OpenCode tidak menjawab (_session/steering).')) });
  const result = await failing.session.steer('arahkan');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /tidak menjawab/);
  assert.equal(failing.calls.length, 1);

  const empty = fakeSession();
  assert.deepEqual(await empty.session.steer('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(empty.calls, []);
});

test('steer: teks panjang dipotong 2000 karakter, proses yang sudah mati dianggap tanpa giliran', async () => {
  const long = fakeSession();
  await long.session.steer('x'.repeat(2500));
  assert.equal(long.calls[0].params.prompt[0].text.length, 2000);

  const dead = fakeSession({ child: null });
  assert.deepEqual(await dead.session.steer('arahkan'), { ok: false, reason: 'no-turn' });
  assert.deepEqual(dead.calls, []);
});

test('route steer: validasi body + pemetaan jawaban sesi ke status HTTP', async () => {
  const { steerDecision, steerOutcome } = await import('../src/routes/session.js');
  const capable = { steer: async () => ({ ok: true }) };

  assert.deepEqual(steerDecision({ text: '  ' }, capable), { status: 400, error: 'Teks arahan kosong.' });
  assert.equal(steerDecision({ text: 'x'.repeat(2001) }, capable).status, 400, 'batas 2000 karakter');
  assert.deepEqual(steerDecision({ text: '  halo  ' }, capable), { status: 200, text: 'halo' });
  assert.equal(steerDecision({ text: 'halo' }, {}).status, 409, 'mesin tanpa steer → 409, bukan 500');

  assert.deepEqual(steerOutcome({ ok: true }), { status: 200 });
  assert.equal(steerOutcome({ ok: false, reason: 'no-turn' }).status, 409);
  assert.equal(steerOutcome({ ok: false, reason: 'no-turn' }).code, 'no-turn');
  assert.equal(steerOutcome({ ok: false, reason: 'unsupported' }).status, 409);
  assert.equal(steerOutcome({ ok: false, reason: 'empty' }).status, 400);
  assert.equal(steerOutcome({ ok: false, reason: 'ECONNRESET' }).status, 502, 'galat lain = 502, bukan sukses palsu');
});
